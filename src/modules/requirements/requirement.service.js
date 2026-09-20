/**
 * Requirement service — the pre-mobilisation board. All business logic and all
 * authorization live here (see requirement.model.js for what a requirement is).
 *
 * Three Section Access keys, same own/team shape as Daily Updates:
 *
 *   requirementsOwn   — the requirements I'm a coordinator on.
 *       Read: see them.  Write: add a requirement as myself, edit / move / delete
 *       my own, and write updates on my cards.
 *   requirementsTeam  — every requirement.
 *       Read: see them all.  Write: also assign any coordinators to a card, and
 *       edit / move / delete anyone's.  Members are also who is notified when a
 *       card enters a stage flagged `notifyOnEnter`.
 *   requirementStages — who edits the board's columns (requirementStage.service.js).
 *
 * Every card in a response carries a server-computed `permissions` object, so
 * the client renders buttons from it and never re-derives who may do what.
 */
import Requirement from './requirement.model.js';
import RequirementStage from './requirementStage.model.js';
import DailyUpdate from '../dailyUpdates/dailyUpdate.model.js';
import Client from '../clients/client.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { nextSequence } from '../quotations/counter.model.js';
import { getSectionAccess, resolveOwnTeamAccess } from '../sectionAccess/sectionAccess.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUserSafely } from '../notifications/notification.service.js';
import { logAudit } from '../audit/audit.service.js';

const OWN_KEY = 'requirementsOwn';
const TEAM_KEY = 'requirementsTeam';
const FORBIDDEN = 'You do not have permission to perform this action.';
const DAY_MS = 86_400_000;
const CLOSED_VISIBLE_DAYS = 30; // a card in a terminal stage leaves the default board after this
const BOARD_LIMIT = 1000;

const idOf = (ref) => String(ref?._id ?? ref);
const resolveAccess = (actor) => resolveOwnTeamAccess(actor, OWN_KEY, TEAM_KEY);
const boardUrl = (requirement) => `/requirements?open=${requirement._id}`;

const isCoordinatorOf = (requirement, userId) => requirement.coordinators.some((c) => idOf(c) === userId);

function permissionsFor(requirement, actor, access) {
  const mine = isCoordinatorOf(requirement, actor.userId);
  const canEdit = access.teamWrite || (access.ownWrite && mine);
  return {
    edit: canEdit,
    move: canEdit,
    manageOwners: access.teamWrite,
    remove: access.teamWrite || (access.ownWrite && idOf(requirement.createdBy) === actor.userId),
    // A log entry is a coordinator's own, so a manager with team-write who isn't
    // one of the card's coordinators can move/edit it but not write updates on it.
    addUpdate: access.ownWrite && mine && actor.role === 'Coordinator',
  };
}

const canView = (requirement, actor, access) => access.teamRead || (access.ownRead && isCoordinatorOf(requirement, actor.userId));

const POPULATE = [
  { path: 'coordinators', select: 'name' },
  { path: 'createdBy', select: 'name' },
];

/** Latest update time and update count per card, in ONE query — the board
 *  shows "last update 2d ago" on every card, so this can't be per-card. */
async function activityFor(requirementIds) {
  if (requirementIds.length === 0) return new Map();
  const rows = await DailyUpdate.aggregate([
    { $match: { kind: 'Log', requirement: { $in: requirementIds } } },
    { $group: { _id: '$requirement', last: { $max: '$createdAt' }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [idOf(r._id), r]));
}

function present(requirement, stageById, activity, actor, access) {
  const stage = stageById.get(idOf(requirement.stage));
  const daysInStage = Math.max(0, Math.floor((Date.now() - new Date(requirement.stageEnteredAt).getTime()) / DAY_MS));
  const seen = activity.get(idOf(requirement._id));
  return {
    ...requirement,
    daysInStage,
    stale: Boolean(stage && !stage.isTerminal && stage.staleAfterDays && daysInStage >= stage.staleAfterDays),
    lastUpdateAt: seen?.last ?? null,
    updateCount: seen?.count ?? 0,
    permissions: permissionsFor(requirement, actor, access),
  };
}

/** One card, populated and presented — what create/edit/move return. */
async function presentOne(id, actor, access) {
  const [requirement, stages] = await Promise.all([
    Requirement.findById(id).populate(POPULATE).lean(),
    RequirementStage.find({}).lean(),
  ]);
  const activity = await activityFor([requirement._id]);
  return present(requirement, new Map(stages.map((s) => [idOf(s), s])), activity, actor, access);
}

async function loadOr404(id) {
  const requirement = await Requirement.findById(id);
  if (!requirement) throw new ApiError(404, 'That requirement was not found.');
  return requirement;
}

async function assertActiveCoordinators(ids, message) {
  const count = await User.countDocuments({ _id: { $in: ids }, role: 'Coordinator', isActive: true });
  if (count !== ids.length) throw new ApiError(400, message);
}

/** Link the typed company name to a real, approved, active Client when one
 *  matches exactly (case-insensitive) — otherwise it stays a plain name, so a
 *  requirement can be tracked before its company is a client at all. */
async function resolveClient(name) {
  const trimmed = name.trim();
  const client = await Client.findOne({
    companyName: { $regex: `^${escapeRegex(trimmed)}$`, $options: 'i' },
    status: 'Active',
    approvalStatus: 'Approved',
  })
    .select('companyName')
    .lean();
  return client ? { client: client._id, clientName: client.companyName } : { client: null, clientName: trimmed };
}

const audit = (action, requirement, actor, meta = {}) =>
  logAudit({
    user: actor.userId,
    action,
    targetType: 'Requirement',
    targetId: requirement._id,
    meta: { serialNumber: requirement.serialNumber, ...meta },
    ip: actor.ip,
  });

const summary = (requirement) => `${requirement.serialNumber} · ${requirement.clientName} — ${requirement.jobTitle} ×${requirement.headcount}`;

// ---- reads -----------------------------------------------------------------------------

/**
 * The whole board in one call: the stages plus every card the caller may see.
 * An own-only coordinator's filter is forced to their own cards here — a
 * hand-crafted `?coordinator=<someone else>` can't widen it. Cards in a
 * terminal stage that have sat there over a month are left out unless
 * `closed=all`, so the finished columns don't grow forever.
 */
export async function getBoard({ coordinator, closed }, actor) {
  const access = await resolveAccess(actor);
  if (!access.ownRead && !access.teamRead) throw new ApiError(403, FORBIDDEN);

  const stages = await RequirementStage.find({}).sort({ order: 1 }).lean();
  const stageById = new Map(stages.map((s) => [idOf(s), s]));

  const filter = {};
  if (access.teamRead) {
    if (coordinator) filter.coordinators = coordinator;
  } else {
    filter.coordinators = actor.userId;
  }
  const terminalIds = stages.filter((s) => s.isTerminal).map((s) => s._id);
  if (closed !== 'all' && terminalIds.length > 0) {
    filter.$or = [
      { stage: { $nin: terminalIds } },
      { stageEnteredAt: { $gte: new Date(Date.now() - CLOSED_VISIBLE_DAYS * DAY_MS) } },
    ];
  }

  // Longest-waiting first within a column, so what needs attention sits on top.
  const requirements = await Requirement.find(filter).sort({ stageEnteredAt: 1, _id: 1 }).limit(BOARD_LIMIT).populate(POPULATE).lean();
  const activity = await activityFor(requirements.map((r) => r._id));

  return {
    stages,
    requirements: requirements.map((r) => present(r, stageById, activity, actor, access)),
    truncated: requirements.length === BOARD_LIMIT,
  };
}

/** One card with its full timeline: the stage history and every update
 *  written on it. Someone who can't see the card gets the same 404 as a card
 *  that doesn't exist, so ids can't be probed. */
export async function getRequirement(id, actor) {
  const access = await resolveAccess(actor);
  const requirement = await Requirement.findById(id)
    .populate(POPULATE)
    .populate({ path: 'stageHistory.movedBy', select: 'name' })
    .lean();
  if (!requirement || !canView(requirement, actor, access)) throw new ApiError(404, 'That requirement was not found.');

  const [stages, updates] = await Promise.all([
    RequirementStage.find({}).lean(),
    DailyUpdate.find({ kind: 'Log', requirement: id }).sort({ createdAt: -1 }).limit(200).populate({ path: 'coordinator', select: 'name' }).lean(),
  ]);
  const activity = new Map([[idOf(requirement._id), { last: updates[0]?.createdAt ?? null, count: updates.length }]]);
  return {
    ...present(requirement, new Map(stages.map((s) => [idOf(s), s])), activity, actor, access),
    updates,
  };
}

/** For the "assign coordinators" picker — team-read only. */
export async function listCoordinators(actor) {
  const access = await resolveAccess(actor);
  if (!access.teamRead) throw new ApiError(403, FORBIDDEN);
  return User.find({ role: 'Coordinator', isActive: true }).select('name').sort({ name: 1 }).lean();
}

// ---- writes ----------------------------------------------------------------------------

export async function createRequirement(data, actor) {
  const access = await resolveAccess(actor);

  const coordinatorIds = data.coordinators?.length ? [...new Set(data.coordinators)] : [actor.userId];
  const onlySelf = coordinatorIds.length === 1 && coordinatorIds[0] === actor.userId;
  if (onlySelf ? !(access.ownWrite || access.teamWrite) : !access.teamWrite) throw new ApiError(403, FORBIDDEN);
  await assertActiveCoordinators(
    coordinatorIds,
    onlySelf ? 'Only a coordinator can own a requirement — pick the coordinator(s) it is for.' : 'Every owner must be an active coordinator.'
  );

  const firstStage = await RequirementStage.findOne({}).sort({ order: 1 }).lean();
  if (!firstStage) throw new ApiError(409, 'No stages are set up yet. Ask an admin to set up the board stages first.');

  const { client, clientName } = await resolveClient(data.clientName);
  const seq = await nextSequence('requirement');
  const now = new Date();
  const requirement = await Requirement.create({
    serialNumber: `REQ-${String(seq).padStart(4, '0')}`,
    client,
    clientName,
    jobTitle: data.jobTitle,
    headcount: data.headcount,
    neededBy: data.neededBy ?? null,
    site: data.site ?? null,
    notes: data.notes ?? null,
    coordinators: coordinatorIds,
    stage: firstStage._id,
    stageEnteredAt: now,
    stageHistory: [{ stage: firstStage._id, stageName: firstStage.name, movedBy: actor.userId, movedAt: now }],
    createdBy: actor.userId,
  });
  await audit('requirement.create', requirement, actor, { stage: firstStage.name, coordinators: coordinatorIds.length });

  for (const coordinatorId of coordinatorIds.filter((c) => c !== actor.userId)) {
    await notifyUserSafely(coordinatorId, {
      type: 'Requirement',
      title: 'A requirement was assigned to you',
      body: summary(requirement),
      url: boardUrl(requirement),
    });
  }
  return presentOne(requirement._id, actor, access);
}

export async function updateRequirement(id, data, actor) {
  const access = await resolveAccess(actor);
  const requirement = await loadOr404(id);
  if (!permissionsFor(requirement, actor, access).edit) throw new ApiError(403, FORBIDDEN);

  let addedCoordinators = [];
  if (data.coordinators) {
    if (!access.teamWrite) throw new ApiError(403, FORBIDDEN);
    const next = [...new Set(data.coordinators)];
    await assertActiveCoordinators(next, 'Every owner must be an active coordinator.');
    addedCoordinators = next.filter((c) => !isCoordinatorOf(requirement, c));
    requirement.coordinators = next;
  }
  if (data.clientName !== undefined) Object.assign(requirement, await resolveClient(data.clientName));
  for (const key of ['jobTitle', 'headcount', 'neededBy', 'site', 'notes']) {
    if (data[key] !== undefined) requirement[key] = data[key];
  }
  await requirement.save();
  await audit('requirement.update', requirement, actor, { fields: Object.keys(data) });

  for (const coordinatorId of addedCoordinators.filter((c) => c !== actor.userId)) {
    await notifyUserSafely(coordinatorId, {
      type: 'Requirement',
      title: 'A requirement was assigned to you',
      body: summary(requirement),
      url: boardUrl(requirement),
    });
  }
  return presentOne(requirement._id, actor, access);
}

/** People to tell about a stage move. Two circles, deduplicated, never the
 *  person who made the move: whoever is in the team circle when the new stage is
 *  flagged `notifyOnEnter` (e.g. "Ready to mobilise"), and the card's own
 *  coordinators whenever SOMEONE ELSE moved their card. */
async function recipientsForMove(requirement, stage, actor) {
  const recipients = new Map(); // userId -> 'notifyStage' | 'movedByOther'
  if (stage.notifyOnEnter) {
    const team = await getSectionAccess(TEAM_KEY);
    for (const id of await membersOfRoles([...team.readApprovalRoles, ...team.writeApprovalRoles])) recipients.set(id, 'notifyStage');
  }
  if (!isCoordinatorOf(requirement, actor.userId)) {
    for (const c of requirement.coordinators) if (!recipients.has(idOf(c))) recipients.set(idOf(c), 'movedByOther');
  }
  recipients.delete(actor.userId);
  return recipients;
}

export async function moveStage(id, stageId, actor) {
  const access = await resolveAccess(actor);
  const requirement = await loadOr404(id);
  if (!permissionsFor(requirement, actor, access).move) throw new ApiError(403, FORBIDDEN);

  const stage = await RequirementStage.findById(stageId).lean();
  if (!stage) throw new ApiError(400, 'That stage does not exist.');
  if (idOf(requirement.stage) === idOf(stage)) return presentOne(requirement._id, actor, access); // already there — idempotent

  const from = await RequirementStage.findById(requirement.stage).select('name').lean();
  const now = new Date();
  requirement.stage = stage._id;
  requirement.stageEnteredAt = now;
  requirement.stageHistory.push({ stage: stage._id, stageName: stage.name, movedBy: actor.userId, movedAt: now });
  await requirement.save();
  await audit('requirement.stage.move', requirement, actor, { from: from?.name ?? null, to: stage.name });

  const mover = await User.findById(actor.userId).select('name').lean();
  for (const [userId, why] of await recipientsForMove(requirement, stage, actor)) {
    await notifyUserSafely(userId, {
      type: 'Requirement',
      title: why === 'notifyStage' ? `Requirement moved to "${stage.name}"` : `Your requirement was moved to "${stage.name}"`,
      body: `${summary(requirement)} — by ${mover?.name ?? 'someone'}`.slice(0, 500),
      url: boardUrl(requirement),
    });
  }
  return presentOne(requirement._id, actor, access);
}

export async function deleteRequirement(id, actor) {
  const access = await resolveAccess(actor);
  const requirement = await loadOr404(id);
  if (!permissionsFor(requirement, actor, access).remove) throw new ApiError(403, FORBIDDEN);

  // Updates written on the card stay in their authors' daily logs — they just
  // stop pointing at a card that no longer exists.
  await DailyUpdate.updateMany({ requirement: requirement._id }, { $set: { requirement: null } });
  await requirement.deleteOne();
  await audit('requirement.delete', requirement, actor, { clientName: requirement.clientName });
}
