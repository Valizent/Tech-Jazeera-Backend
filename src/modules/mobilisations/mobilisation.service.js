/**
 * Mobilisation service.
 *
 * M1: create/list/get/update a Draft record.
 * M2: joint-coordinator invite/confirm + submit (Draft/Rejected → PendingReview).
 * M3: Marketing Manager commercial-details (Section 2) + decide.
 * M4: admin-configurable viewer-role visibility circle, self-mobilise roles,
 *     commercial-field stripping for a plain Coordinator once Approved.
 * M5: multi-file documents.
 */
import Mobilisation from './mobilisation.model.js';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { resolveApprovalWorkflow, isMemberOfAnyRole } from '../approvals/approvals.service.js';
import {
  decideApprovalStep,
  resolveStepAuthority,
  membersOfRoles,
  annotateCanDecide,
} from '../approvals/approvalEngine.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { signedDownloadUrl, destroyDocumentFile } from '../../middleware/upload.js';
import { nextSequence } from '../quotations/counter.model.js';

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Server-only profit computation — never trust a stored or client-submitted
 * value, always recompute from the current rate/commission/hours fields.
 * Formula given directly by the business owner (not inferred):
 *   profitPerHour = SupplierEmployee: (clientRate - clientCommission) - (subcontractorRate + subcontractorCommission)
 *                   Employee/Freelancer: clientRate - clientCommission
 *   otProfitPerHour = the same split, using the ot*-prefixed fields
 *   otHours = max(0, clientTimesheetHours - requiredTimesheetHours) — never a
 *             manually-typed value (see docs/MOBILISATION-notes.md's own
 *             "never trust a client-submitted financial value" convention);
 *             0 until clientTimesheetHours is actually filled in
 *   profitPerMonth = (profitPerHour * requiredTimesheetHours) - fta - allowance + otProfitTotal
 *             — the base rate only ever applies to the required hours; hours
 *             beyond that are otHours, priced at the OT rate instead
 *             (otProfitTotal), never both.
 * `profitPerMonth` stays null until clientTimesheetHours is actually filled
 * in (usually by the current-step reviewer, once the client's real
 * timesheet arrives) — there's nothing meaningful to compute before then.
 */
function computeProfitFields(m) {
  const isSupplier = m.workerType === 'SupplierEmployee';
  const clientSide = (m.clientRate ?? 0) - (m.clientCommission ?? 0);
  const subSide = isSupplier ? (m.subcontractorRate ?? 0) + (m.subcontractorCommission ?? 0) : 0;
  const profitPerHour = money(clientSide - subSide);

  const otHours =
    m.clientTimesheetHours == null ? 0 : Math.max(0, m.clientTimesheetHours - (m.requiredTimesheetHours ?? 0));

  const otClientSide = (m.otClientRate ?? 0) - (m.otClientCommission ?? 0);
  const otSubSide = isSupplier ? (m.otSubcontractorRate ?? 0) + (m.otSubcontractorCommission ?? 0) : 0;
  const otProfitPerHour = money(otClientSide - otSubSide);
  const otProfitTotal = money(otProfitPerHour * otHours);

  const profitPerMonth =
    m.clientTimesheetHours == null
      ? null
      : money(profitPerHour * (m.requiredTimesheetHours ?? 0) - (m.fta ?? 0) - (m.allowance ?? 0) + otProfitTotal);

  return { profitPerHour, otHours, otProfitPerHour, otProfitTotal, profitPerMonth };
}

/** Applied right before every `.save()` (create/update/commercial-details)
 *  and mapped over every `.lean()` read result — so a stale stored value is
 *  never trusted, matching this app's "recompute financials server-side,
 *  always" rule. `target` can be a Mongoose document or a plain lean object. */
function applyProfitFields(target) {
  Object.assign(target, computeProfitFields(target));
  return target;
}

const POPULATE = [
  { path: 'coordinators.user', select: 'name email role' },
  { path: 'steps.roles', select: 'name' },
  { path: 'approvalTrail.approvalRole', select: 'name' },
  { path: 'approvalTrail.approvedBy', select: 'name role' },
  { path: 'decidedBy', select: 'name' },
  { path: 'createdBy', select: 'name' },
  { path: 'documents.uploadedBy', select: 'name' },
];

// Section 1 — the rate/commission/profit fields the Coordinator types in
// themselves at creation. Stripped from their own view only once the record
// is Approved: they see everything they typed while it's still Draft/
// PendingReview/Rejected, but the finalized commercial picture is
// management-only from that point on. Admin and any 'mobilisationsViewer'
// Section Access member always see everything.
const COMMERCIAL_FIELDS = [
  'clientRate',
  'clientCommission',
  'fta',
  'allowance',
  'requiredTimesheetHours',
  'subcontractorRate',
  'subcontractorCommission',
  'profitPerHour',
  'profitPerMonth',
  'otHours',
  'otProfitPerHour',
  'otProfitTotal',
];

// Section 2 — the CURRENT-STEP REVIEWER's own work (quotation/PO, the
// client's actual timesheet hours, overtime, their remark). A plain
// Coordinator never entered any of this themselves — unlike Section 1
// above, it is stripped from their view UNCONDITIONALLY, at every status,
// not just once Approved. Visible only to Admin, a 'mobilisationsViewer'
// Section Access member, or whoever is actually authorized for the current
// step right now. See
// saveCommercialDetails below, which writes exactly this field list.
const REVIEW_FIELDS = [
  'clientTimesheetHours',
  'otClientRate',
  'otClientCommission',
  'otSubcontractorRate',
  'otSubcontractorCommission',
  'clientQuotation',
  'clientQuotationDate',
  'clientPO',
  'clientPODate',
  'subQuotation',
  'subQuotationDate',
  'subPO',
  'subPODate',
  'remark',
];

function stripFields(mobilisation, fields) {
  const copy = { ...mobilisation };
  for (const field of fields) delete copy[field];
  return copy;
}

/** Snapshot fields captured from the referenced Employee at creation/edit —
 *  independently editable afterward, never live-joined on read (same
 *  durable-history convention as Deployment.clientName). */
function snapshotFromEmployee(employee) {
  return {
    workerName: employee.fullName,
    iqamaNumber: employee.iqama?.number ?? null,
    nationality: employee.nationality ?? null,
    phone: employee.mobile ?? null,
  };
}

/**
 * Resolves the worker-identity fields by `workerType`. 'Employee' keeps the
 * original behavior in full (real Employee doc, snapshot, `worker` ref
 * populated). 'SupplierEmployee'/'Freelancer' never touch the Employee
 * collection at all — no HR record exists for them — so the Coordinator's
 * own typed `workerName`/`iqamaNumber`/`nationality`/`phone` pass straight
 * through and `worker` stays null.
 */
async function resolveWorkerSnapshot(workerType, data) {
  if (workerType === 'Employee') {
    const employee = await Employee.findById(data.worker).lean();
    if (!employee) throw new ApiError(404, 'Employee not found.');
    return { employee, snapshot: { worker: data.worker, ...snapshotFromEmployee(employee) } };
  }
  return {
    employee: null,
    snapshot: {
      worker: null,
      workerName: data.workerName,
      iqamaNumber: data.iqamaNumber ?? null,
      nationality: data.nationality ?? null,
      phone: data.phone ?? null,
    },
  };
}

/** Subcontractor snapshot — only ever resolved for a SupplierEmployee
 *  mobilisation; Employee/Freelancer types always clear it. */
async function resolveSubcontractorSnapshot(workerType, subcontractorId) {
  if (workerType !== 'SupplierEmployee') {
    return { hasSubcontractor: false, subcontractor: null, subcontractorName: null };
  }
  if (!subcontractorId) throw new ApiError(400, 'Select a subcontractor.');
  const subcontractorDoc = await Subcontractor.findById(subcontractorId).lean();
  if (!subcontractorDoc) throw new ApiError(404, 'Subcontractor not found.');
  return { hasSubcontractor: true, subcontractor: subcontractorId, subcontractorName: subcontractorDoc.name };
}

/** Sequential 'MOB-0001' display number — same atomic-counter mechanism
 *  Invoices ('INV-') and Quotations ('QT-') already use, reused unchanged. */
async function newMobilisationSerial() {
  const seq = await nextSequence('mobilisation');
  return `MOB-${String(seq).padStart(4, '0')}`;
}

/** Every ApprovalRole id `userId` belongs to — computed once per request and
 *  reused for both the viewer-circle check and the "am I the current step's
 *  reviewer" check, rather than querying ApprovalRole membership per document. */
async function myRoleIds(userId) {
  const roles = await ApprovalRole.find({ members: userId }).select('_id').lean();
  return roles.map((r) => r._id);
}

/** The 'mobilisationsViewer' Section Access circle — a literal login-role
 *  match, or membership in one of its granted ApprovalRoles. Shared by
 *  listMobilisations' visibility filter and getMobilisation's single-record
 *  access check. `precomputedRoleIds` lets a caller that already ran
 *  myRoleIds() for its own purposes (listMobilisations, for the PendingReview
 *  step-reviewer check) reuse it instead of a second, less targeted query;
 *  getMobilisation has no such list lying around, so it falls through to
 *  isMemberOfAnyRole's single indexed lookup instead. */
async function isMobilisationViewer(actor, precomputedRoleIds) {
  const settings = await getSectionAccess('mobilisationsViewer');
  if (settings.allowedRoles.includes(actor.role)) return true;
  if (!settings.allowedApprovalRoles.length) return false;
  if (precomputedRoleIds) {
    return precomputedRoleIds.some((r) => settings.allowedApprovalRoles.some((v) => v.toString() === r.toString()));
  }
  return isMemberOfAnyRole(actor.userId, settings.allowedApprovalRoles);
}

/**
 * Minimal, purpose-scoped lookup for the "invite a joint coordinator"
 * picker. `/api/users` (the general staff directory) is Admin/Manager/HR
 * only, so a plain Coordinator — the one who actually needs this — can't
 * call it; this narrower endpoint returns just enough (name only, no
 * email) for any staff member to pick a fellow Coordinator by name.
 */
export async function listCoordinatorCandidates() {
  return User.find({ role: 'Coordinator' }).select('name').sort({ name: 1 }).lean();
}

/**
 * Live autocomplete source for the free-typed worker-identity fields
 * (SupplierEmployee/Freelancer workers never get an Employee record — see
 * mobilisation.model.js). Deliberately lighter than the JobTitle picklist:
 * no managed collection, no permission gate on write (there's no write path
 * at all), just "what's been typed before" — a suggestion aid, not a
 * validated enum, same spirit as EmployeeForm's static Nationality
 * `<datalist>` but sourced live instead of from a hardcoded list.
 */
export async function getFieldSuggestions(field) {
  const values = await Mobilisation.distinct(field, { [field]: { $nin: [null, ''] } });
  return values.sort((a, b) => a.localeCompare(b)).slice(0, 100);
}

/** A worker may have at most one ACTIVE placement at a time — Draft/
 *  PendingReview/Approved all count; Rejected/Completed don't (a rejected
 *  one is dead until resubmitted, a completed one has already released the
 *  worker back to standby). Names the existing coordinator/status in the
 *  error so whoever hits this knows who to talk to. */
async function assertNoActivePlacement(workerId) {
  const existing = await Mobilisation.findOne({
    worker: workerId,
    status: { $in: ['Draft', 'PendingReview', 'Approved'] },
  })
    .populate('coordinators.user', 'name')
    .lean();
  if (!existing) return;
  const primary = existing.coordinators.find((c) => c.isPrimary);
  throw new ApiError(
    409,
    `This worker already has an active mobilisation (${existing.status}${primary ? `, coordinated by ${primary.user.name}` : ''}).`
  );
}

export async function createMobilisation(data, actor) {
  const allowed = await canAccessSection('mobilisationsSelfMobilise', actor);
  if (!allowed) {
    throw new ApiError(403, 'You do not have permission to create a mobilisation.');
  }

  const { snapshot: workerSnapshot } = await resolveWorkerSnapshot(data.workerType, data);
  if (data.workerType === 'Employee') await assertNoActivePlacement(data.worker);
  const clientDoc = await Client.findById(data.client).lean();
  if (!clientDoc) throw new ApiError(404, 'Client not found.');
  const subcontractorSnapshot = await resolveSubcontractorSnapshot(data.workerType, data.subcontractor);

  const mobilisation = await Mobilisation.create(
    applyProfitFields({
      ...data,
      ...workerSnapshot,
      serialNumber: await newMobilisationSerial(),
      clientName: clientDoc.companyName,
      ...subcontractorSnapshot,
      coordinators: [{ user: actor.userId, isPrimary: true, confirmed: true, confirmedAt: new Date() }],
      createdBy: actor.userId,
    })
  );

  // Milestone 5: a real Coordinator primary claims the worker immediately —
  // Employee.coordinator is now fully derived from Mobilisation state, not a
  // manually-picked field. Admin and a self-mobilising role member (BDM/MM/
  // etc, both legal creators per the `allowed` check above) are NOT real
  // coordinators, so they leave it untouched (null, standby) — only a
  // Coordinator-role primary ever claims one, and only for a real Employee
  // (SupplierEmployee/Freelancer workers have no Employee record to claim).
  if (actor.role === 'Coordinator' && data.workerType === 'Employee') {
    await Employee.findByIdAndUpdate(data.worker, { coordinator: actor.userId });
  }

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.create',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { workerName: mobilisation.workerName, clientName: mobilisation.clientName },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/** Approved → Completed — the terminal "placement has ended" state
 *  (Milestone 5). Releases the worker back to standby (Employee.coordinator
 *  → null) so any Coordinator can pick them up for a new Mobilisation.
 *  Unconditional clear is safe: assertNoActivePlacement above guarantees at
 *  most one Draft/PendingReview/Approved mobilisation exists per worker at a
 *  time, so this one's coordinator IS whatever Employee.coordinator
 *  currently holds (if anything — Admin/self-mobilised placements never set
 *  it in the first place, making this a harmless no-op for those). */
export async function completeMobilisation(id, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (mobilisation.status !== 'Approved') {
    throw new ApiError(400, 'Only an Approved mobilisation can be marked complete.');
  }
  assertPrimaryOrAdmin(mobilisation, actor);

  mobilisation.status = 'Completed';
  await mobilisation.save();
  await Employee.findByIdAndUpdate(mobilisation.worker, { coordinator: null });

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.complete',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { workerName: mobilisation.workerName },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/**
 * Visibility (M4): Admin sees everything. Everyone else sees a mobilisation
 * if ANY of —
 *  - they're a coordinator on it (any status),
 *  - they're a 'mobilisationsViewer' Section Access member and it's past Draft
 *    (BDM's immediate "read on version" once submitted; the full MM/BDM/FM/
 *    COO/GM circle after approval — one mechanism for both),
 *  - they hold a role in the CURRENT step's pool while it's PendingReview
 *    (so the Marketing Manager can find their review queue even before an
 *    Admin has also granted them 'mobilisationsViewer' Section Access).
 * REVIEW_FIELDS (Section 2 — the current-step reviewer's own quotation/PO/
 * OT/timesheet work) is stripped for a plain coordinator unconditionally;
 * COMMERCIAL_FIELDS (Section 1 — what the coordinator typed themselves) only
 * once Approved.
 */
export async function listMobilisations(query, actor) {
  const { page, limit, status, client, worker, search, sortBy, sortOrder } = query;
  const conditions = [];
  if (status) conditions.push({ status });
  if (client) conditions.push({ client });
  if (worker) conditions.push({ worker });
  if (search) {
    const rx = { $regex: escapeRegex(search), $options: 'i' };
    conditions.push({ $or: [{ workerName: rx }, { clientName: rx }, { jobTitle: rx }, { serialNumber: rx }] });
  }

  let isViewer = false;
  let roleIds = [];
  if (actor.role !== 'Admin') {
    roleIds = await myRoleIds(actor.userId);
    isViewer = await isMobilisationViewer(actor, roleIds);

    const visibility = [{ 'coordinators.user': actor.userId }];
    if (isViewer) visibility.push({ status: { $ne: 'Draft' } });
    if (roleIds.length) visibility.push({ status: 'PendingReview', 'steps.roles': { $in: roleIds } });
    conditions.push({ $or: visibility });
  }
  const filter = conditions.length > 0 ? { $and: conditions } : {};
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };

  const [foundItems, total] = await Promise.all([
    Mobilisation.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate(POPULATE).lean(),
    Mobilisation.countDocuments(filter),
  ]);
  // Recomputed on every read, never trusting whatever was last stored — see
  // computeProfitFields's own doc comment.
  const rawItems = foundItems.map(applyProfitFields);

  const strippedItems =
    actor.role === 'Admin' || isViewer
      ? rawItems
      : rawItems.map((m) => {
          const currentStepRoleIds = (m.steps?.[m.currentStep]?.roles ?? []).map((r) => (r._id ?? r).toString());
          const isStepReviewer = roleIds.some((r) => currentStepRoleIds.includes(r.toString()));
          let item = isStepReviewer ? m : stripFields(m, REVIEW_FIELDS);
          if (!isStepReviewer && m.status === 'Approved') item = stripFields(item, COMMERCIAL_FIELDS);
          return item;
        });
  const items = await annotateCanDecide(strippedItems, actor, {
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: ['Admin'],
  });

  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function getMobilisation(id, actor) {
  const found = await Mobilisation.findById(id).populate(POPULATE).lean();
  if (!found) throw new ApiError(404, 'Mobilisation not found.');
  const mobilisation = applyProfitFields(found);

  let visible = mobilisation;
  if (actor.role !== 'Admin') {
    const isCoordinator = mobilisation.coordinators.some((c) => c.user._id.toString() === actor.userId);
    const isViewer = await isMobilisationViewer(actor);
    const isViewerAllowed = isViewer && mobilisation.status !== 'Draft';

    let isStepReviewer = false;
    if (mobilisation.status === 'PendingReview') {
      const stepRoleIds = (mobilisation.steps?.[mobilisation.currentStep]?.roles ?? []).map((r) => r._id ?? r);
      isStepReviewer = await isMemberOfAnyRole(actor.userId, stepRoleIds);
    }

    if (!isCoordinator && !isViewerAllowed && !isStepReviewer) {
      throw new ApiError(403, 'You do not have access to this mobilisation.');
    }
    // Section 2 (the current-step reviewer's own work) is never a plain
    // coordinator's to see — stripped unconditionally, not just once
    // Approved (unlike Section 1, which the coordinator typed themselves).
    if (!isViewer && !isStepReviewer) {
      visible = stripFields(visible, REVIEW_FIELDS);
    }
    if (!isViewer && !isStepReviewer && mobilisation.status === 'Approved') {
      visible = stripFields(visible, COMMERCIAL_FIELDS);
    }
  }

  const [annotated] = await annotateCanDecide([visible], actor, {
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: ['Admin'],
  });
  return annotated;
}

const DIRECT_FIELDS = [
  'jobTitle',
  'clientRate',
  'clientCommission',
  'fta',
  'allowance',
  'requiredTimesheetHours',
  'subcontractorRate',
  'subcontractorCommission',
  'mobilisationDate',
  'checkoutDate',
  'remark',
];

function assertPrimaryOrAdmin(mobilisation, actor) {
  const isPrimary = mobilisation.coordinators.some(
    (c) => c.isPrimary && c.user.toString() === actor.userId
  );
  if (actor.role !== 'Admin' && !isPrimary) {
    throw new ApiError(403, 'Only the primary coordinator can do this.');
  }
}

/** Edit Section 1 — Draft/Rejected only, primary coordinator or Admin. Each
 *  reference (worker/client/subcontractor) is re-resolved and its snapshot
 *  refreshed only if the caller actually sent it. */
export async function updateMobilisation(id, data, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (!['Draft', 'Rejected'].includes(mobilisation.status)) {
    throw new ApiError(400, 'Only a Draft or Rejected mobilisation can be edited.');
  }
  assertPrimaryOrAdmin(mobilisation, actor);

  // workerType changing (or being resent) re-resolves worker identity in
  // full — same "only touch it if the caller sent it" discipline as
  // worker/client always had, just widened to cover the new field too.
  if ('workerType' in data || 'worker' in data || 'workerName' in data) {
    const workerType = data.workerType ?? mobilisation.workerType;
    const { snapshot } = await resolveWorkerSnapshot(workerType, {
      worker: 'worker' in data ? data.worker : mobilisation.worker,
      workerName: data.workerName ?? mobilisation.workerName,
      iqamaNumber: data.iqamaNumber ?? mobilisation.iqamaNumber,
      nationality: data.nationality ?? mobilisation.nationality,
      phone: data.phone ?? mobilisation.phone,
    });
    mobilisation.workerType = workerType;
    Object.assign(mobilisation, snapshot);
  }
  if ('client' in data) {
    const clientDoc = await Client.findById(data.client).lean();
    if (!clientDoc) throw new ApiError(404, 'Client not found.');
    mobilisation.client = data.client;
    mobilisation.clientName = clientDoc.companyName;
  }
  if ('workerType' in data || 'subcontractor' in data) {
    const workerType = data.workerType ?? mobilisation.workerType;
    const subcontractorId = 'subcontractor' in data ? data.subcontractor : mobilisation.subcontractor?.toString();
    const snapshot = await resolveSubcontractorSnapshot(workerType, subcontractorId);
    mobilisation.hasSubcontractor = snapshot.hasSubcontractor;
    mobilisation.subcontractor = snapshot.subcontractor;
    mobilisation.subcontractorName = snapshot.subcontractorName;
  }
  for (const field of DIRECT_FIELDS) {
    if (field in data) mobilisation[field] = data[field];
  }

  applyProfitFields(mobilisation);
  await mobilisation.save();
  await logAudit({
    user: actor.userId,
    action: 'mobilisation.update',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

// ---------------------------------------------------------------------------
// M2 — joint coordinators + submit
// ---------------------------------------------------------------------------

/** Invite a joint coordinator — Draft/Rejected only, primary/Admin only. The
 *  invitee must be a real 'Coordinator' login (the requirement's own framing:
 *  "add a combined coordinator... another coordinator"), not already on the
 *  record. They start unconfirmed and must explicitly confirm before submit
 *  is allowed. */
export async function addCoordinator(id, userId, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (!['Draft', 'Rejected'].includes(mobilisation.status)) {
    throw new ApiError(400, 'Coordinators can only be changed on a Draft or Rejected mobilisation.');
  }
  assertPrimaryOrAdmin(mobilisation, actor);

  if (mobilisation.coordinators.some((c) => c.user.toString() === userId)) {
    throw new ApiError(400, 'This user is already a coordinator on this mobilisation.');
  }
  const user = await User.findById(userId).select('role name').lean();
  if (!user) throw new ApiError(404, 'User not found.');
  if (user.role !== 'Coordinator') {
    throw new ApiError(400, 'Only a Coordinator login can be added as a joint coordinator.');
  }

  mobilisation.coordinators.push({ user: userId, isPrimary: false, confirmed: false, confirmedAt: null });
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.coordinator.add',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { addedUser: userId },
    ip: actor.ip,
  });
  await notifyUser(userId, {
    type: 'RequestStatus',
    title: `You've been added as a coordinator on a mobilisation for ${mobilisation.workerName}`,
    body: 'Confirm your involvement before it can be submitted for review.',
    url: `/mobilisations/${mobilisation._id}`,
  });
  return mobilisation.toObject();
}

/** Remove a joint coordinator — only while they haven't confirmed yet (a
 *  confirmed co-coordinator has already vouched for the record; correcting
 *  a mistake there is an Admin edit, not a routine removal), never the
 *  primary, Draft/Rejected only, primary/Admin only. */
export async function removeCoordinator(id, userId, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (!['Draft', 'Rejected'].includes(mobilisation.status)) {
    throw new ApiError(400, 'Coordinators can only be changed on a Draft or Rejected mobilisation.');
  }
  assertPrimaryOrAdmin(mobilisation, actor);

  const entry = mobilisation.coordinators.find((c) => c.user.toString() === userId);
  if (!entry) throw new ApiError(404, 'This user is not a coordinator on this mobilisation.');
  if (entry.isPrimary) throw new ApiError(400, 'The primary coordinator cannot be removed.');
  if (entry.confirmed) throw new ApiError(400, 'A confirmed coordinator cannot be removed.');

  mobilisation.coordinators = mobilisation.coordinators.filter((c) => c.user.toString() !== userId);
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.coordinator.remove',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { removedUser: userId },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/** A joint coordinator confirming their own involvement — only that user,
 *  for themselves, Draft/Rejected only (confirmation is meaningless once
 *  already submitted). */
export async function confirmCoordinator(id, userId, actor) {
  if (actor.userId !== userId) {
    throw new ApiError(403, 'You can only confirm your own coordinator invitation.');
  }
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (!['Draft', 'Rejected'].includes(mobilisation.status)) {
    throw new ApiError(400, 'This mobilisation is no longer awaiting confirmation.');
  }
  const entry = mobilisation.coordinators.find((c) => c.user.toString() === userId);
  if (!entry) throw new ApiError(404, 'You are not a coordinator on this mobilisation.');

  entry.confirmed = true;
  entry.confirmedAt = new Date();
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.coordinator.confirm',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/** Draft/Rejected → PendingReview. 400 unless every coordinator has
 *  confirmed. Resolves the company-wide 'Mobilisation' ApprovalWorkflow
 *  fresh each time (no per-employee override concept here — the `worker`
 *  on a mobilisation is the subject of the placement, not the requester, so
 *  using their Employee.approvalWorkflow would be semantically wrong;
 *  resolveApprovalWorkflow is reused unchanged, just always falling through
 *  to the company-wide default). A prior rejection's approvalTrail is kept
 *  as history; only the terminal decision fields reset. */
export async function submitMobilisation(id, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (!['Draft', 'Rejected'].includes(mobilisation.status)) {
    throw new ApiError(400, 'Only a Draft or Rejected mobilisation can be submitted.');
  }
  assertPrimaryOrAdmin(mobilisation, actor);

  const unconfirmed = mobilisation.coordinators.filter((c) => !c.confirmed);
  if (unconfirmed.length > 0) {
    throw new ApiError(400, 'Every coordinator on this mobilisation must confirm before it can be submitted.');
  }

  const workflow = await resolveApprovalWorkflow({ approvalWorkflow: null }, 'Mobilisation');
  mobilisation.status = 'PendingReview';
  mobilisation.decidedBy = null;
  mobilisation.decidedAt = null;
  mobilisation.decisionNote = null;
  if (workflow) {
    mobilisation.workflow = workflow._id;
    mobilisation.workflowName = workflow.name;
    mobilisation.steps = workflow.steps;
  } else {
    mobilisation.workflow = null;
    mobilisation.workflowName = null;
    mobilisation.steps = undefined;
  }
  mobilisation.currentStep = 0;
  mobilisation.currentStepEnteredAt = new Date();
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.submit',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    ip: actor.ip,
  });
  if (workflow) {
    const memberIds = await membersOfRoles(workflow.steps[0]?.roles);
    await Promise.all(
      memberIds.map((userId) =>
        notifyUser(userId, {
          type: 'RequestStatus',
          title: `A mobilisation for ${mobilisation.workerName} needs your review`,
          url: `/mobilisations/${mobilisation._id}`,
        })
      )
    );
  }
  return mobilisation.toObject();
}

// ---------------------------------------------------------------------------
// M3 — current-step reviewer's Section 2: quotation/PO, overtime, actual
// timesheet hours, remark (Office Secretary first, then Marketing Manager,
// once an Admin configures that multi-step workflow — see decideMobilisation
// below; the field list has never been Marketing-Manager-specific, only the
// name of this comment block was)
// ---------------------------------------------------------------------------

/** Section 2 — filled by whoever is authorized for the CURRENT step (Office
 *  Secretary, then Marketing Manager, or Admin), PendingReview only. Does
 *  not touch status — deciding is a separate call, since the shared decide
 *  engine only ever mutates status/decidedBy/approvalTrail (see
 *  approvalEngine.service.js). Every field is individually optional — a
 *  reviewer fills in what they have as it arrives (the client's quotation
 *  today, the actual timesheet hours once the client's timesheet itself
 *  arrives, overtime once that's known). Recomputes profitPerHour/
 *  profitPerMonth/otProfit* on save since clientTimesheetHours and every OT
 *  field feed directly into that formula. */
export async function saveCommercialDetails(id, data, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  if (mobilisation.status !== 'PendingReview') {
    throw new ApiError(400, 'Commercial details can only be added while a mobilisation is pending review.');
  }
  const stepRoleIds = mobilisation.steps?.[mobilisation.currentStep]?.roles ?? [];
  const { authorized } = await resolveStepAuthority(actor, stepRoleIds);
  if (!authorized) {
    throw new ApiError(403, 'You are not an approver for the current step of this mobilisation.');
  }

  for (const field of REVIEW_FIELDS) {
    if (field in data) mobilisation[field] = data[field];
  }
  applyProfitFields(mobilisation);
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.commercialDetails.save',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { fields: Object.keys(data) },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/**
 * Reuses the shared workflow-decision engine, overriding only how the final
 * decision is delivered: decideApprovalStep's default (`notifyEmployeeUser
 * (doc.employee, ...)`) assumes the request's "subject" is an Employee with
 * a login — Mobilisation's coordinators are Users directly, with no
 * `employee` field on the model at all, so the default would silently
 * resolve nobody (or worse, a query with an undefined filter value).
 * `legacyAllowedRoles: ['Admin']` is a safety net so an Admin can still
 * decide before the org has configured a real 'Mobilisation'
 * ApprovalWorkflow/Marketing-Manager role — mirrors every other request
 * type's legacy fallback.
 */
export async function decideMobilisation(id, { status, decisionNote }, actor) {
  const result = await decideApprovalStep({
    Model: Mobilisation,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'PendingReview',
    legacyAllowedRoles: ['Admin'],
    notFoundMessage: 'Mobilisation not found.',
    auditAction: 'mobilisation',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `Mobilisation for ${doc.workerName} ${doc.status.toLowerCase()}`,
      body: doc.decisionNote || undefined,
      url: `/mobilisations/${doc._id}`,
    }),
    notifyFinal: async (doc, notification) => {
      const memberIds = doc.coordinators.map((c) => (c.user._id ?? c.user).toString());
      await Promise.all(memberIds.map((userId) => notifyUser(userId, notification)));
    },
  });

  // Approving a non-last step leaves status PendingReview and advances
  // currentStep — record when the record entered whatever step it's now on,
  // for mobilisationStale.job.js. A small, self-correcting follow-up write
  // (guarded by the exact currentStep the engine just set) rather than
  // teaching the shared engine about a field only this caller needs — it's
  // reused by 6 other request types that have no use for it.
  if (result.status === 'PendingReview') {
    await Mobilisation.updateOne(
      { _id: id, currentStep: result.currentStep },
      { $set: { currentStepEnteredAt: new Date() } }
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// TEMPORARY — pre-production cleanup only. Remove this whole function, its
// route (mobilisation.routes.js), and its controller (mobilisation.
// controller.js's `remove`) before going live — the user asked for an
// Admin-only way to clear out dummy/test mobilisations while building, not
// a permanent feature (Mobilisation otherwise has no delete path on
// purpose: Completed is the real terminal state).
// ---------------------------------------------------------------------------

/** Hard-deletes a Mobilisation outright, bypassing the normal lifecycle.
 *  Releases a worker this record was actively holding (same cleanup
 *  completeMobilisation does) and best-effort destroys any uploaded
 *  document files so nothing is orphaned in Cloudinary. Router-gated to
 *  Admin only. */
export async function deleteMobilisation(id, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');

  if (
    mobilisation.workerType === 'Employee' &&
    mobilisation.worker &&
    ['Draft', 'PendingReview', 'Approved'].includes(mobilisation.status)
  ) {
    await Employee.findByIdAndUpdate(mobilisation.worker, { coordinator: null });
  }

  for (const doc of mobilisation.documents) {
    await destroyDocumentFile(doc.fileName, doc.resourceType).catch(() => {});
  }

  await mobilisation.deleteOne();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.delete',
    targetType: 'Mobilisation',
    targetId: id,
    meta: { serialNumber: mobilisation.serialNumber, workerName: mobilisation.workerName },
    ip: actor.ip,
  });
}

// ---------------------------------------------------------------------------
// M5 — documents
// ---------------------------------------------------------------------------

/** Upload is blocked once Approved or Completed — the record is finalized;
 *  a document needed after that point is an Admin edit, not a routine
 *  attachment. */
function assertDocumentsEditable(mobilisation) {
  if (['Approved', 'Completed'].includes(mobilisation.status)) {
    throw new ApiError(400, 'Documents cannot be changed on an Approved or Completed mobilisation.');
  }
}

function isCoordinatorOnRecord(mobilisation, actor) {
  return mobilisation.coordinators.some((c) => c.user.toString() === actor.userId);
}

/** Deleting a document stays Admin/coordinator only — a current-step
 *  reviewer (e.g. Office Secretary) who isn't a coordinator can attach a
 *  file but never remove one someone else uploaded (your own call: "they
 *  shouldn't be able to delete what was uploaded"). */
function assertCanDeleteDocuments(mobilisation, actor) {
  if (actor.role === 'Admin') return;
  if (!isCoordinatorOnRecord(mobilisation, actor)) {
    throw new ApiError(403, 'You do not have access to this mobilisation.');
  }
}

/** Adding a document is wider: Admin, any coordinator, OR whoever is
 *  authorized for the CURRENT approval step while PendingReview — so Office
 *  Secretary can attach the client's timesheet/PO themselves, the same
 *  "whoever's turn it is" mechanism saveCommercialDetails already uses. */
async function assertCanAddDocuments(mobilisation, actor) {
  if (actor.role === 'Admin' || isCoordinatorOnRecord(mobilisation, actor)) return;
  if (mobilisation.status === 'PendingReview') {
    const stepRoleIds = mobilisation.steps?.[mobilisation.currentStep]?.roles ?? [];
    const { authorized } = await resolveStepAuthority(actor, stepRoleIds);
    if (authorized) return;
  }
  throw new ApiError(403, 'You do not have access to this mobilisation.');
}

export async function addDocuments(id, files, category, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  await assertCanAddDocuments(mobilisation, actor);
  assertDocumentsEditable(mobilisation);
  if (!files?.length) throw new ApiError(400, 'Attach at least one file.');

  for (const file of files) {
    mobilisation.documents.push({
      fileName: file.filename,
      resourceType: 'raw',
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      category,
      uploadedBy: actor.userId,
      uploadedAt: new Date(),
    });
  }
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.documents.add',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { count: files.length, category },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

export async function removeDocument(id, fileId, actor) {
  const mobilisation = await Mobilisation.findById(id);
  if (!mobilisation) throw new ApiError(404, 'Mobilisation not found.');
  assertCanDeleteDocuments(mobilisation, actor);
  assertDocumentsEditable(mobilisation);

  const doc = mobilisation.documents.id(fileId);
  if (!doc) throw new ApiError(404, 'Document not found.');

  await destroyDocumentFile(doc.fileName, doc.resourceType).catch(() => {});
  mobilisation.documents = mobilisation.documents.filter((d) => d._id.toString() !== fileId);
  await mobilisation.save();

  await logAudit({
    user: actor.userId,
    action: 'mobilisation.documents.remove',
    targetType: 'Mobilisation',
    targetId: mobilisation._id,
    meta: { fileId },
    ip: actor.ip,
  });
  return mobilisation.toObject();
}

/** A document's file for whoever can already view the record (get()'s own
 *  access rules — the caller has already been through getMobilisation). */
export async function getDocumentFile(id, fileId, actor) {
  const mobilisation = await getMobilisation(id, actor);
  const doc = (mobilisation.documents ?? []).find((d) => d._id.toString() === fileId);
  if (!doc) throw new ApiError(404, 'Document not found.');
  return {
    url: signedDownloadUrl(doc.fileName, doc.resourceType),
    mimeType: doc.mimeType,
    originalName: doc.originalName,
  };
}
