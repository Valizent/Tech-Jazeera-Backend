/**
 * DailyUpdate service — all business logic and all authorization.
 *
 * Two independent Section Access keys govern this module (Approval Roles
 * only — see sectionAccess.model.js), each with a Read and a Write tier:
 *
 *   dailyUpdatesOwn   — a coordinator's OWN workspace.
 *       Read: see their own log and the tasks assigned to them.
 *       Write: add their own log entries and to-dos, edit/delete what they
 *              wrote themselves, and tick off any task assigned to them.
 *   dailyUpdatesTeam  — oversight of EVERY coordinator.
 *       Read: see everyone's log and tasks.
 *       Write: assign a task to any coordinator, and edit/delete/tick anyone's.
 *
 * On top of that, an entry always BELONGS to a real, active `Coordinator`
 * login — a log entry is always written by its own coordinator, a task is
 * always assigned to one. That domain rule is checked here, not just implied
 * by who holds a grant, so a stray grant to a non-coordinator can't produce a
 * log "belonging" to an office secretary.
 *
 * Every list row carries a server-computed `permissions` object so the client
 * never re-derives who may do what — one source of truth, the same function
 * that the mutating endpoints below check.
 */
import mongoose from 'mongoose';
import DailyUpdate from './dailyUpdate.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../config/logger.js';
import { getMySectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { logAudit } from '../audit/audit.service.js';

const OWN_KEY = 'dailyUpdatesOwn';
const TEAM_KEY = 'dailyUpdatesTeam';
const FORBIDDEN = 'You do not have permission to perform this action.';
const PAGE_URL = '/daily-updates';

// Saudi Arabia has no daylight saving — Riyadh is permanently UTC+3 (same
// constant nfc.analytics.service.js and monthlyReport.service.js rely on).
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const FAR_FUTURE = new Date('9999-12-31T00:00:00.000Z');

/** Riyadh's calendar "today" as a Date at UTC midnight — the same shape every
 *  date this module stores or compares has. */
function todayInRiyadh() {
  const ymd = new Date(Date.now() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
  return new Date(`${ymd}T00:00:00.000Z`);
}

const idOf = (ref) => String(ref?._id ?? ref);

async function resolveAccess(actor) {
  const { read, write } = await getMySectionAccess({ userId: actor.userId, role: actor.role });
  return {
    ownRead: read.includes(OWN_KEY),
    ownWrite: write.includes(OWN_KEY),
    teamRead: read.includes(TEAM_KEY),
    teamWrite: write.includes(TEAM_KEY),
  };
}

/** A person may edit/delete an entry if they hold team-write, or if it is one
 *  they wrote for themselves — never a task someone else assigned to them. */
function canEdit(item, actor, access) {
  if (access.teamWrite) return true;
  return access.ownWrite && idOf(item.coordinator) === actor.userId && idOf(item.createdBy) === actor.userId;
}

/** Ticking a task off is the assignee's right even when a manager wrote it. */
function canSetStatus(item, actor, access) {
  if (item.kind !== 'Task') return false;
  if (access.teamWrite) return true;
  return access.ownWrite && idOf(item.coordinator) === actor.userId;
}

/** A Riyadh calendar day as `YYYY-MM-DD` for any instant. */
const riyadhDay = (value) => new Date(new Date(value).getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

function present(item, actor, access, today) {
  const isTask = item.kind === 'Task';
  return {
    ...item,
    assignedByOther: isTask && idOf(item.createdBy) !== idOf(item.coordinator),
    // A log entry dated a different day than the one it was actually typed on —
    // shown so a manager reading the log can tell an after-the-fact entry from a
    // same-day one.
    backdated: !isTask && riyadhDay(item.createdAt) !== new Date(item.date).toISOString().slice(0, 10),
    overdue: isTask && item.status === 'Open' && Boolean(item.dueDate) && new Date(item.dueDate) < today,
    permissions: {
      edit: canEdit(item, actor, access),
      remove: canEdit(item, actor, access),
      setStatus: canSetStatus(item, actor, access),
    },
  };
}

const POPULATE = [
  { path: 'coordinator', select: 'name' },
  { path: 'createdBy', select: 'name' },
];

/** Best-effort — a notification failing must never fail the action it
 *  describes (the same rule the approval engine follows). */
async function notifySafely(userId, payload) {
  try {
    await notifyUser(userId, payload);
  } catch (err) {
    logger.warn(`[dailyUpdates] notification to ${userId} failed: ${err.message}`);
  }
}

function assertNotFuture(date) {
  if (date > todayInRiyadh()) throw new ApiError(400, "A log entry can't be dated in the future.");
}

async function findActiveCoordinator(userId) {
  return User.findOne({ _id: userId, role: 'Coordinator', isActive: true }).select('name').lean();
}

async function loadOr404(id) {
  const item = await DailyUpdate.findById(id);
  if (!item) throw new ApiError(404, 'That entry was not found.');
  return item;
}

const audit = (action, item, actor, meta = {}) =>
  logAudit({
    user: actor.userId,
    action,
    targetType: 'DailyUpdate',
    targetId: item._id,
    meta: { kind: item.kind, coordinator: idOf(item.coordinator), ...meta },
    ip: actor.ip,
  });

/**
 * A coordinator with only Own-read sees just their own rows — the filter is
 * forced here, not merely offered by the UI, so a hand-crafted
 * `?coordinator=<someone else>` can't widen it.
 */
export async function listDailyUpdates({ kind, coordinator, status, from, to, page, limit }, actor) {
  const access = await resolveAccess(actor);
  if (!access.ownRead && !access.teamRead) throw new ApiError(403, FORBIDDEN);

  const filter = { kind };
  if (access.teamRead) {
    if (coordinator) filter.coordinator = coordinator;
  } else {
    filter.coordinator = actor.userId;
  }

  const today = todayInRiyadh();
  // The page of rows and the total are independent reads — started together
  // below so a list costs one database round-trip of waiting, not two.
  let itemsQuery;

  if (kind === 'Log') {
    if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    itemsQuery = DailyUpdate.find(filter)
      .sort({ date: -1, createdAt: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(POPULATE)
      .lean();
  } else {
    if (status) filter.status = status;
    // Open tasks first, soonest-due first (no due date last); finished tasks
    // after them, most recently completed first. One sort key covers both so
    // pagination stays stable across the whole list.
    // Mongoose casts string ids for find()/countDocuments() but NOT inside an
    // aggregation pipeline — the coordinator id has to be a real ObjectId here.
    const match = filter.coordinator
      ? { ...filter, coordinator: new mongoose.Types.ObjectId(String(filter.coordinator)) }
      : filter;
    itemsQuery = DailyUpdate.aggregate([
      { $match: match },
      { $addFields: { _open: { $eq: ['$status', 'Open'] } } },
      {
        $addFields: {
          _order: { $cond: ['$_open', 0, 1] },
          _key: {
            $cond: [
              '$_open',
              { $toLong: { $ifNull: ['$dueDate', FAR_FUTURE] } },
              { $multiply: [-1, { $toLong: { $ifNull: ['$completedAt', '$updatedAt'] } }] },
            ],
          },
        },
      },
      { $sort: { _order: 1, _key: 1, createdAt: -1, _id: 1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      { $project: { _open: 0, _order: 0, _key: 0 } },
    ]).then((rows) => DailyUpdate.populate(rows, POPULATE));
  }

  const [items, total] = await Promise.all([itemsQuery, DailyUpdate.countDocuments(filter)]);
  return {
    items: items.map((item) => present(item, actor, access, today)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/** The picker for "assign to" and the coordinator filter — team-read only,
 *  since an own-only coordinator never needs anyone else's name. */
export async function listCoordinators(actor) {
  const access = await resolveAccess(actor);
  if (!access.teamRead) throw new ApiError(403, FORBIDDEN);
  return User.find({ role: 'Coordinator', isActive: true }).select('name').sort({ name: 1 }).lean();
}

export async function createDailyUpdate(data, actor) {
  const access = await resolveAccess(actor);

  if (data.kind === 'Log') {
    if (!access.ownWrite) throw new ApiError(403, FORBIDDEN);
    if (actor.role !== 'Coordinator') throw new ApiError(400, 'Only coordinators can add a daily log entry.');
    const date = data.date ?? todayInRiyadh();
    assertNotFuture(date);
    const item = await DailyUpdate.create({
      kind: 'Log',
      coordinator: actor.userId,
      text: data.text,
      date,
      createdBy: actor.userId,
    });
    await audit('dailyUpdate.log.create', item, actor);
    return present((await DailyUpdate.findById(item._id).populate(POPULATE).lean()), actor, access, todayInRiyadh());
  }

  const assigneeId = data.coordinator ?? actor.userId;
  const isSelf = assigneeId === actor.userId;
  if (isSelf ? !(access.ownWrite || access.teamWrite) : !access.teamWrite) throw new ApiError(403, FORBIDDEN);

  const assignee = await findActiveCoordinator(assigneeId);
  if (!assignee) {
    throw new ApiError(400, isSelf ? 'Only coordinators can keep a to-do list.' : 'Pick an active coordinator to assign this task to.');
  }

  const item = await DailyUpdate.create({
    kind: 'Task',
    coordinator: assigneeId,
    text: data.text,
    dueDate: data.dueDate ?? null,
    status: 'Open',
    createdBy: actor.userId,
  });
  await audit('dailyUpdate.task.create', item, actor, { assigned: !isSelf });

  if (!isSelf) {
    await notifySafely(assigneeId, {
      type: 'Task',
      title: 'New task assigned to you',
      body: data.text.slice(0, 200),
      url: PAGE_URL,
    });
  }
  return present((await DailyUpdate.findById(item._id).populate(POPULATE).lean()), actor, access, todayInRiyadh());
}

export async function updateDailyUpdate(id, data, actor) {
  const access = await resolveAccess(actor);
  const item = await loadOr404(id);
  if (!canEdit(item, actor, access)) throw new ApiError(403, FORBIDDEN);

  if (item.kind === 'Log') {
    if (data.dueDate !== undefined) throw new ApiError(400, 'A log entry has no due date.');
    if (data.date) {
      assertNotFuture(data.date);
      item.date = data.date;
    }
  } else {
    if (data.date) throw new ApiError(400, 'A task has a due date, not a log date.');
    if (data.dueDate !== undefined) item.dueDate = data.dueDate; // null clears it
  }
  if (data.text !== undefined) item.text = data.text;

  await item.save();
  await audit(`dailyUpdate.${item.kind.toLowerCase()}.update`, item, actor, { fields: Object.keys(data) });
  return present((await DailyUpdate.findById(item._id).populate(POPULATE).lean()), actor, access, todayInRiyadh());
}

export async function setTaskStatus(id, status, actor) {
  const access = await resolveAccess(actor);
  const item = await loadOr404(id);
  if (item.kind !== 'Task') throw new ApiError(400, 'Only a task can be marked done or reopened.');
  if (!canSetStatus(item, actor, access)) throw new ApiError(403, FORBIDDEN);

  if (item.status !== status) {
    item.status = status;
    item.completedAt = status === 'Done' ? new Date() : null;
    item.completedBy = status === 'Done' ? actor.userId : null;
    await item.save();
    await audit('dailyUpdate.task.status', item, actor, { status });

    // Tell whoever handed the task over that it's done — but not when they
    // ticked it off themselves, and not on a reopen.
    if (status === 'Done' && idOf(item.createdBy) !== actor.userId) {
      const who = await User.findById(actor.userId).select('name').lean();
      await notifySafely(item.createdBy, {
        type: 'Task',
        title: 'A task you assigned is done',
        body: `${who?.name ?? 'A coordinator'}: ${item.text}`.slice(0, 200),
        url: PAGE_URL,
      });
    }
  }
  return present((await DailyUpdate.findById(item._id).populate(POPULATE).lean()), actor, access, todayInRiyadh());
}

export async function deleteDailyUpdate(id, actor) {
  const access = await resolveAccess(actor);
  const item = await loadOr404(id);
  if (!canEdit(item, actor, access)) throw new ApiError(403, FORBIDDEN);
  await item.deleteOne();
  await audit(`dailyUpdate.${item.kind.toLowerCase()}.delete`, item, actor);
}
