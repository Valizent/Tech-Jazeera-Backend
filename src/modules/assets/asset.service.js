/**
 * Asset service — CRUD, plus the assign/return workflow. Every operation
 * touching both Asset and AssetAssignment runs in a transaction, exactly
 * like Deployment does for Employee.currentClient — the two must never
 * drift apart.
 */
import mongoose from 'mongoose';
import Asset from './asset.model.js';
import AssetAssignment from './assetAssignment.model.js';
import Employee from '../employees/employee.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { assertEmployeeVisibleToActor } from '../employees/employee.service.js';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function createAsset(data, actor) {
  const existing = await Asset.findOne({ assetTag: data.assetTag.toUpperCase() }).lean();
  if (existing) throw new ApiError(409, 'An asset with this tag already exists.');

  const asset = await Asset.create(data);
  await logAudit({
    user: actor.userId,
    action: 'asset.create',
    targetType: 'Asset',
    targetId: asset._id,
    meta: { assetTag: asset.assetTag, name: asset.name },
    ip: actor.ip,
  });
  return asset.toObject();
}

export async function updateAsset(id, data, actor) {
  const asset = await Asset.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
  if (!asset) throw new ApiError(404, 'Asset not found.');
  await logAudit({
    user: actor.userId,
    action: 'asset.update',
    targetType: 'Asset',
    targetId: asset._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return asset;
}

/** Available <-> Maintenance/Retired — only while nobody currently holds it. */
export async function setAssetStatus(id, status, actor) {
  const asset = await Asset.findById(id);
  if (!asset) throw new ApiError(404, 'Asset not found.');
  if (asset.status === 'Assigned') {
    throw new ApiError(400, 'This asset is currently assigned — return it first.');
  }
  asset.status = status;
  await asset.save();
  await logAudit({
    user: actor.userId,
    action: 'asset.status',
    targetType: 'Asset',
    targetId: asset._id,
    meta: { status },
    ip: actor.ip,
  });
  return asset.toObject();
}

export async function deleteAsset(id, actor) {
  const hasHistory = await AssetAssignment.exists({ asset: id });
  if (hasHistory) {
    throw new ApiError(400, 'This asset has assignment history — retire it instead of deleting.');
  }
  const asset = await Asset.findByIdAndDelete(id).lean();
  if (!asset) throw new ApiError(404, 'Asset not found.');
  await logAudit({
    user: actor.userId,
    action: 'asset.delete',
    targetType: 'Asset',
    targetId: asset._id,
    meta: { assetTag: asset.assetTag },
    ip: actor.ip,
  });
}

/**
 * Assign an available asset to an employee.
 * Errors: 404 asset/employee · 400 not-available/exited employee ·
 *         409 already assigned (double-assignment race backstop).
 */
export async function assignAsset(assetId, data, actor) {
  const asset = await Asset.findById(assetId).lean();
  if (!asset) throw new ApiError(404, 'Asset not found.');
  if (asset.status !== 'Available') {
    throw new ApiError(400, `This asset is ${asset.status.toLowerCase()}, not available to assign.`);
  }
  const employee = await Employee.findById(data.employee).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');
  if (employee.status === 'Exited') {
    throw new ApiError(400, 'This employee has exited the company and cannot be assigned an asset.');
  }
  await assertEmployeeVisibleToActor(employee._id, actor);

  const session = await mongoose.startSession();
  try {
    let assignment;
    await session.withTransaction(async () => {
      const [created] = await AssetAssignment.create(
        [
          {
            asset: asset._id,
            assetTag: asset.assetTag,
            assetName: asset.name,
            employee: employee._id,
            employeeName: employee.fullName,
            assignedAt: data.assignedAt ?? new Date(),
            notes: data.notes,
            status: 'Active',
          },
        ],
        { session }
      );
      await Asset.updateOne({ _id: asset._id }, { status: 'Assigned', currentEmployee: employee._id }, { session });
      assignment = created;
    });
    await logAudit({
      user: actor.userId,
      action: 'asset.assign',
      targetType: 'AssetAssignment',
      targetId: assignment._id,
      meta: { assetTag: asset.assetTag, employee: employee.employeeId },
      ip: actor.ip,
    });
    return assignment.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      throw new ApiError(409, 'This asset was just assigned to someone else — refresh and try again.');
    }
    throw err;
  } finally {
    session.endSession();
  }
}

/** End the active assignment and free the asset. */
export async function returnAsset(assetId, data, actor) {
  const asset = await Asset.findById(assetId).lean();
  if (!asset) throw new ApiError(404, 'Asset not found.');
  const active = await AssetAssignment.findOne({ asset: assetId, status: 'Active' });
  if (!active) throw new ApiError(400, 'This asset is not currently assigned.');
  // Fixed 2026-09-15, a real QA-audit-found gap — A1: same missing
  // team-ownership check as assignAsset above (which already had it) —
  // returning had none at all, unassigning a foreign employee's asset.
  await assertEmployeeVisibleToActor(active.employee, actor);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await AssetAssignment.updateOne(
        { _id: active._id },
        { status: 'Ended', returnedAt: new Date(), conditionNote: data.conditionNote, notes: data.notes ?? active.notes },
        { session }
      );
      await Asset.updateOne({ _id: assetId }, { status: 'Available', currentEmployee: null }, { session });
    });
    await logAudit({
      user: actor.userId,
      action: 'asset.return',
      targetType: 'AssetAssignment',
      targetId: active._id,
      meta: { assetTag: asset.assetTag, employee: active.employeeName },
      ip: actor.ip,
    });
  } finally {
    session.endSession();
  }
}

// Fixed 2026-09-15, a real QA-audit-found gap — A1: this had no actor-based
// scoping at all, unlike getAsset below — a Coordinator could list every
// asset including who's currently holding each one, even though opening a
// foreign employee's own assigned asset correctly 403s. Same pattern as
// listDocuments/listEmployeeAssignments: an unassigned asset (nobody's) is
// always visible; one assigned to a foreign employee is not.
export async function listAssets({ page, limit, category, status, search }, actor) {
  const conditions = [];
  if (category) conditions.push({ category });
  if (status) conditions.push({ status });
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({ $or: [{ assetTag: rx }, { name: rx }] });
  }
  if (actor?.role === 'Coordinator') {
    const teamIds = await Employee.find({ coordinator: actor.userId }).distinct('_id');
    conditions.push({ $or: [{ currentEmployee: null }, { currentEmployee: { $in: teamIds } }] });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [items, total] = await Promise.all([
    Asset.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('currentEmployee', 'fullName employeeId')
      .lean(),
    Asset.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getAsset(id, actor) {
  const asset = await Asset.findById(id).populate('currentEmployee', 'fullName employeeId').lean();
  if (!asset) throw new ApiError(404, 'Asset not found.');
  if (asset.currentEmployee) {
    await assertEmployeeVisibleToActor(asset.currentEmployee._id, actor);
  }
  const history = await AssetAssignment.find({ asset: id }).sort({ assignedAt: -1 }).lean();
  return { ...asset, history };
}

/** An employee's currently-assigned assets + their assignment history — used
 *  by both the Employee profile panel and /api/me/assets (the latter passes
 *  no `actor` — a Worker/Staff viewing their OWN assets needs no Coordinator
 *  scoping, since assertEmployeeVisibleToActor is a no-op for any non-
 *  Coordinator actor, undefined included). Coordinator scoping added
 *  2026-09-14, a real QA-audit-found gap: this had none at all before. */
export async function listEmployeeAssignments(employeeId, actor) {
  await assertEmployeeVisibleToActor(employeeId, actor);
  return AssetAssignment.find({ employee: employeeId }).sort({ assignedAt: -1 }).lean();
}
