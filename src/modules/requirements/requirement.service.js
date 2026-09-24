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
 *
 * Candidates (milestone 3) have no key of their own — they follow the card's edit
 * right. The three "handoff" functions at the bottom (assertCanStartFromRequirement,
 * attachMobilisation, onMobilisationApproved) are the only part of this module
 * mobilisation.service.js calls into.
 *
 * Manager extras (milestone 4) add no permission of their own either: the client /
 * subcontractor filters, the Excel export and the dashboard's stale count all see
 * exactly the cards the board shows that viewer (see buildScope, countStaleRequirements).
 */
import mongoose from 'mongoose';
import Requirement from './requirement.model.js';
import RequirementStage from './requirementStage.model.js';
import DailyUpdate from '../dailyUpdates/dailyUpdate.model.js';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
// The model only (never mobilisation.service.js, which imports THIS file) — so the
// handoff below can look a mobilisation up without an import cycle.
import Mobilisation from '../mobilisations/mobilisation.model.js';
import User from '../auth/user.model.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { nextSequence } from '../quotations/counter.model.js';
import { getSectionAccess, resolveOwnTeamAccess } from '../sectionAccess/sectionAccess.service.js';
import { listActiveCoordinators } from '../../utils/listActiveCoordinators.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { notifyUserSafely } from '../notifications/notification.service.js';
import { logAudit } from '../audit/audit.service.js';
import logger from '../../config/logger.js';

const OWN_KEY = 'requirementsOwn';
const TEAM_KEY = 'requirementsTeam';
const FORBIDDEN = 'You do not have permission to perform this action.';
const DAY_MS = 86_400_000;
const CLOSED_VISIBLE_DAYS = 30; // a card in a terminal stage leaves the default board after this
const BOARD_LIMIT = 1000;
const EXPORT_LIMIT = 5000; // same cap as the deployments export

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

/**
 * `withCandidates` is true only for the single-card detail — the board (up to
 * 1000 cards) and the create/edit/move replies carry just the two counts, so
 * they never haul every card's candidate list around.
 */
function present(requirement, stageById, activity, actor, access, { withCandidates = false } = {}) {
  const stage = stageById.get(idOf(requirement.stage));
  const daysInStage = Math.max(0, Math.floor((Date.now() - new Date(requirement.stageEnteredAt).getTime()) / DAY_MS));
  const seen = activity.get(idOf(requirement._id));
  const candidates = requirement.candidates ?? [];
  const card = {
    ...requirement,
    daysInStage,
    // The rule countStaleRequirements() below restates as one query — change both together.
    stale: Boolean(stage && !stage.isTerminal && stage.staleAfterDays && daysInStage >= stage.staleAfterDays),
    lastUpdateAt: seen?.last ?? null,
    updateCount: seen?.count ?? 0,
    // "3 candidates · 1 of 4 mobilised" — a dropped candidate no longer counts as one.
    candidateCount: candidates.filter((c) => c.status !== 'Dropped').length,
    mobilisedCount: candidates.filter((c) => c.status === 'Mobilised').length,
    permissions: permissionsFor(requirement, actor, access),
  };
  if (!withCandidates) delete card.candidates;
  return card;
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

/** One stageHistory entry — the shape moveStage and the auto-advance both write. */
const moveEntry = (stage, moverId, at) => ({ stage: stage._id, stageName: stage.name, movedBy: moverId, movedAt: at });

// ---- reads -----------------------------------------------------------------------------

/**
 * Which cards a viewer's board is made of — ONE builder shared by the board and its
 * Excel export, so the two can never drift on what a person is allowed to see
 * (same idea as deployment.service.js's findDeployments).
 *
 * An own-only coordinator's filter is forced to their own cards here — a
 * hand-crafted `?coordinator=<someone else>` can't widen it. Cards in a terminal
 * stage that have sat there over a month are left out unless `closed=all`, so the
 * finished columns don't grow forever. `client` matches the company name the card
 * was typed with (case-insensitively); `subcontractor` matches a card that has a
 * candidate from that subcontractor who hasn't been dropped — the same "a dropped
 * candidate no longer counts" rule the card's own candidate count follows.
 */
async function buildScope({ coordinator, closed, client, subcontractor }, actor) {
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
  if (client) filter.clientName = { $regex: `^${escapeRegex(client)}$`, $options: 'i' };
  if (subcontractor) filter.candidates = { $elemMatch: { subcontractor, status: { $ne: 'Dropped' } } };
  const terminalIds = stages.filter((s) => s.isTerminal).map((s) => s._id);
  if (closed !== 'all' && terminalIds.length > 0) {
    filter.$or = [
      { stage: { $nin: terminalIds } },
      { stageEnteredAt: { $gte: new Date(Date.now() - CLOSED_VISIBLE_DAYS * DAY_MS) } },
    ];
  }
  return { access, stages, stageById, filter };
}

/**
 * The choices the board's client / subcontractor filters offer. Taken from the cards
 * the viewer can see rather than from the Clients / Subcontractors modules: a
 * coordinator usually has no access to those (asking would just break the filter),
 * and this way a value is only ever offered when something is behind it. Deliberately
 * independent of the other filters — picking a coordinator must not make the client
 * you already chose vanish from the list.
 */
async function filterOptionsFor(access, actor) {
  const scope = access.teamRead ? {} : { coordinators: new mongoose.Types.ObjectId(actor.userId) };
  const [clientNames, subcontractorRows] = await Promise.all([
    Requirement.distinct('clientName', scope),
    // $match doesn't cast inside an aggregation, hence the ObjectId above.
    Requirement.aggregate([
      { $match: scope },
      { $unwind: '$candidates' },
      { $match: { 'candidates.subcontractor': { $ne: null }, 'candidates.status': { $ne: 'Dropped' } } },
      { $group: { _id: '$candidates.subcontractor' } },
    ]),
  ]);

  // "ARAMCO" and "Aramco" are the same filter (the match is case-insensitive) — list it once.
  const clients = new Map();
  for (const name of [...clientNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    if (!clients.has(name.toLowerCase())) clients.set(name.toLowerCase(), name);
  }
  // Current names, not the snapshot on each candidate — a renamed subcontractor shows its new name.
  const subcontractors = subcontractorRows.length
    ? await Subcontractor.find({ _id: { $in: subcontractorRows.map((r) => r._id) } }).select('name').sort({ name: 1 }).lean()
    : [];
  return { clients: [...clients.values()], subcontractors };
}

/**
 * The whole board in one call: the stages, every card the caller may see (within the
 * filters), and the values the filters can offer.
 */
export async function getBoard(query, actor) {
  const { access, stages, stageById, filter } = await buildScope(query, actor);

  const [requirements, filterOptions] = await Promise.all([
    // Longest-waiting first within a column, so what needs attention sits on top.
    // Narrowed projection (2026-09-22, a real QA-audit finding — P8): the board
    // card only ever shows candidateCount/mobilisedCount (present() below
    // derives both from candidates[].status alone) and never stageHistory (only
    // the single-card detail view — getRequirement — populates and uses that).
    // Excluding the rest of each candidate (name/Iqama/nationality/phone/notes)
    // and all of stageHistory means the board no longer fetches real candidate
    // PII into the backend just to immediately discard it for every one of up
    // to 1000 cards. exportRequirements/getRequirement's own queries are
    // untouched — they genuinely need the full documents.
    Requirement.find(filter)
      .select(
        '-stageHistory -candidates.workerType -candidates.workerName -candidates.iqamaNumber -candidates.nationality' +
          ' -candidates.phone -candidates.subcontractor -candidates.subcontractorName -candidates.docsNote' +
          ' -candidates.mobilisation -candidates.addedBy -candidates.addedAt'
      )
      .sort({ stageEnteredAt: 1, _id: 1 })
      .limit(BOARD_LIMIT)
      .populate(POPULATE)
      .lean(),
    filterOptionsFor(access, actor),
  ]);
  const activity = await activityFor(requirements.map((r) => r._id));

  return {
    stages,
    requirements: requirements.map((r) => present(r, stageById, activity, actor, access)),
    truncated: requirements.length === BOARD_LIMIT,
    filterOptions,
  };
}

/**
 * Every card the board would show for the same filters, with its candidates, for the
 * Excel export — cards oldest first (the order they were raised), not by stage.
 * With a subcontractor filter the candidate rows narrow to that subcontractor's
 * workers too (a manager exporting "ABC Manpower" wants ABC's people, not the rest
 * of each card); the card-level counts still describe the whole card.
 */
export async function exportRequirements(query, actor) {
  const { access, stageById, filter } = await buildScope(query, actor);
  const requirements = await Requirement.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(EXPORT_LIMIT)
    .populate(POPULATE)
    .populate({ path: 'candidates.mobilisation', select: 'serialNumber' })
    .lean();

  return requirements.map((r) => {
    const card = present(r, stageById, new Map(), actor, access, { withCandidates: true });
    if (query.subcontractor) card.candidates = card.candidates.filter((c) => idOf(c.subcontractor) === query.subcontractor);
    return { ...card, stageName: stageById.get(idOf(r.stage))?.name ?? '' };
  });
}

/**
 * How many cards, among those this viewer can see, have sat in their stage past its
 * "stale after" limit — the figure the dashboard's "Waiting on you" shows. It is the
 * same rule as `present`'s `stale` flag written as one query: "days in stage >= N"
 * is exactly "entered the stage at or before N days ago". 0 without board access.
 */
export async function countStaleRequirements(actor) {
  const access = await resolveAccess(actor);
  if (!access.ownRead && !access.teamRead) return 0;

  const stages = await RequirementStage.find({ isTerminal: false, staleAfterDays: { $ne: null } }).select('staleAfterDays').lean();
  if (stages.length === 0) return 0;

  const now = Date.now();
  const filter = { $or: stages.map((s) => ({ stage: s._id, stageEnteredAt: { $lte: new Date(now - s.staleAfterDays * DAY_MS) } })) };
  if (!access.teamRead) filter.coordinators = actor.userId;
  return Requirement.countDocuments(filter);
}

/**
 * A coordinator's own open (non-terminal-stage) requirement cards, grouped by
 * stage — the dashboard's "My Requirements" widget (2026-09-24, a real user
 * ask: the board already tracks exactly this, but nothing on the dashboard
 * showed a coordinator their open pipeline, only the stale subset via
 * countStaleRequirements above). Deliberately always scoped to the caller's
 * own cards, regardless of teamRead — this is "MY requirements", not a
 * narrower view of the board.
 */
export async function getMyRequirementsSummary(actor) {
  const stages = await RequirementStage.find({ isTerminal: false }).select('name order').sort({ order: 1 }).lean();
  if (stages.length === 0) return { total: 0, byStage: [] };

  const rows = await Requirement.aggregate([
    { $match: { coordinators: new mongoose.Types.ObjectId(actor.userId), stage: { $in: stages.map((s) => s._id) } } },
    { $group: { _id: '$stage', count: { $sum: 1 } } },
  ]);
  const countByStage = new Map(rows.map((r) => [idOf(r._id), r.count]));
  const byStage = stages
    .map((s) => ({ stage: s.name, count: countByStage.get(idOf(s._id)) ?? 0 }))
    .filter((s) => s.count > 0);
  return { total: byStage.reduce((sum, s) => sum + s.count, 0), byStage };
}

/** One card with its full timeline: the stage history and every update
 *  written on it. Someone who can't see the card gets the same 404 as a card
 *  that doesn't exist, so ids can't be probed. */
export async function getRequirement(id, actor) {
  const access = await resolveAccess(actor);
  const requirement = await Requirement.findById(id)
    .populate(POPULATE)
    .populate({ path: 'stageHistory.movedBy', select: 'name' })
    // Each candidate's mobilisation, as just its number and status — enough to show
    // "MOB-0071 · Pending review" and link to it, nothing commercial.
    .populate({ path: 'candidates.mobilisation', select: 'serialNumber status' })
    .lean();
  if (!requirement || !canView(requirement, actor, access)) throw new ApiError(404, 'That requirement was not found.');

  const [stages, updates] = await Promise.all([
    RequirementStage.find({}).lean(),
    DailyUpdate.find({ kind: 'Log', requirement: id }).sort({ createdAt: -1 }).limit(200).populate({ path: 'coordinator', select: 'name' }).lean(),
  ]);
  const activity = new Map([[idOf(requirement._id), { last: updates[0]?.createdAt ?? null, count: updates.length }]]);
  return {
    ...present(requirement, new Map(stages.map((s) => [idOf(s), s])), activity, actor, access, { withCandidates: true }),
    updates,
  };
}

/** For the "assign coordinators" picker — team-read only. Shared body with
 *  dailyUpdate.service.js's identical picker (2026-09-22, a real QA-audit
 *  finding) — this module's own `resolveAccess` above is untouched. */
export async function listCoordinators(actor) {
  const access = await resolveAccess(actor);
  return listActiveCoordinators(access.teamRead);
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
  // Real bug fix (2026-09-24): a requirement's own edit form always resends its
  // current `neededBy` (even when the user only touched an unrelated field), so
  // this can't simply reject any past `neededBy` the way createRequirementSchema
  // does — an untouched, since-elapsed date must still save. Only a genuine
  // CHANGE to a new past date is rejected.
  if (data.neededBy !== undefined && data.neededBy !== null) {
    const changing = !requirement.neededBy || new Date(data.neededBy).getTime() !== new Date(requirement.neededBy).getTime();
    if (changing) {
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (new Date(data.neededBy) < todayUtc) throw new ApiError(400, "Needed-by date can't be in the past.");
    }
  }
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
  requirement.stageHistory.push(moveEntry(stage, actor.userId, now));
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

// ---- candidates (milestone 3) ------------------------------------------------------------
//
// The workers being lined up for a card. Anyone who may EDIT the card may keep its
// candidate list (`permissions.edit`: team-write, or own-write on a card they're a
// coordinator of) — there is no separate candidate permission to configure.

async function loadEditable(id, actor) {
  const access = await resolveAccess(actor);
  const requirement = await loadOr404(id);
  if (!permissionsFor(requirement, actor, access).edit) throw new ApiError(403, FORBIDDEN);
  return requirement;
}

function candidateOr404(requirement, candidateId) {
  const candidate = requirement.candidates.id(candidateId);
  if (!candidate) throw new ApiError(404, 'That candidate was not found on this requirement.');
  return candidate;
}

async function subcontractorSnapshot(subcontractorId) {
  const subcontractor = await Subcontractor.findById(subcontractorId).select('name').lean();
  if (!subcontractor) throw new ApiError(400, 'That subcontractor was not found.');
  return { subcontractor: subcontractor._id, subcontractorName: subcontractor.name };
}

export async function addCandidate(id, data, actor) {
  const requirement = await loadEditable(id, actor);
  const source = data.workerType === 'SupplierEmployee' ? await subcontractorSnapshot(data.subcontractor) : { subcontractor: null, subcontractorName: null };
  requirement.candidates.push({
    workerType: data.workerType,
    workerName: data.workerName,
    iqamaNumber: data.iqamaNumber ?? null,
    nationality: data.nationality ?? null,
    phone: data.phone ?? null,
    ...source,
    status: data.status,
    docsNote: data.docsNote ?? null,
    addedBy: actor.userId,
  });
  await requirement.save();
  const added = requirement.candidates[requirement.candidates.length - 1];
  await audit('requirement.candidate.add', requirement, actor, { workerName: added.workerName });
  return added.toObject();
}

export async function updateCandidate(id, candidateId, data, actor) {
  const requirement = await loadEditable(id, actor);
  const candidate = candidateOr404(requirement, candidateId);

  // 'Mobilised' is the system's word for "an approved placement exists" — once
  // it's true it can't be walked back by editing a status.
  if (data.status !== undefined && candidate.status === 'Mobilised') {
    throw new ApiError(409, `${candidate.workerName} is already mobilised — their status can't be changed.`);
  }
  if (data.subcontractor !== undefined) {
    if (candidate.workerType !== 'SupplierEmployee') throw new ApiError(400, "Only a subcontractor's worker has a subcontractor.");
    Object.assign(candidate, await subcontractorSnapshot(data.subcontractor));
  }
  for (const key of ['workerName', 'iqamaNumber', 'nationality', 'phone', 'status', 'docsNote']) {
    if (data[key] !== undefined) candidate[key] = data[key];
  }
  await requirement.save();
  await audit('requirement.candidate.update', requirement, actor, { workerName: candidate.workerName, fields: Object.keys(data) });
  return candidate.toObject();
}

export async function removeCandidate(id, candidateId, actor) {
  const requirement = await loadEditable(id, actor);
  const candidate = candidateOr404(requirement, candidateId);
  // A candidate who has a mobilisation is part of a real placement record —
  // removing the row would orphan it. "Dropped" is the honest way out.
  if (candidate.mobilisation) {
    throw new ApiError(409, `${candidate.workerName} has a mobilisation — mark them Dropped instead of removing them.`);
  }
  const workerName = candidate.workerName;
  requirement.candidates.pull(candidateId);
  await requirement.save();
  await audit('requirement.candidate.remove', requirement, actor, { workerName });
}

// ---- the handoff to Mobilisation (milestone 3) --------------------------------------------
//
// Called by mobilisation.service.js at three moments of a mobilisation's life, all
// keyed off the `requirement` + `requirementCandidate` pair stored on it.

/**
 * BEFORE a mobilisation is created from a candidate: may this caller do it, and
 * is the candidate actually free to be mobilised? Throws otherwise, so nothing is
 * created. Anyone who can edit the card may start from it; the candidate must not
 * already have a mobilisation (a REJECTED one still counts — that record is
 * resubmitted, not replaced), must not be dropped, and the worker type has to match
 * (a subcontractor's worker can't be turned into a freelancer's mobilisation here).
 */
export async function assertCanStartFromRequirement({ requirement: requirementId, requirementCandidate: candidateId, workerType }, actor) {
  const access = await resolveAccess(actor);
  const requirement = await Requirement.findById(requirementId);
  if (!requirement) throw new ApiError(400, 'The requirement this mobilisation is for was not found.');
  if (!permissionsFor(requirement, actor, access).edit) throw new ApiError(403, FORBIDDEN);

  const candidate = requirement.candidates.id(candidateId);
  if (!candidate) throw new ApiError(400, 'That candidate is not on this requirement.');
  if (candidate.status === 'Dropped') throw new ApiError(400, `${candidate.workerName} was dropped from this requirement.`);
  if (candidate.status === 'Mobilised' || candidate.mobilisation) {
    const existing = candidate.mobilisation ? await Mobilisation.findById(candidate.mobilisation).select('serialNumber').lean() : null;
    throw new ApiError(409, `${candidate.workerName} already has a mobilisation${existing ? ` (${existing.serialNumber})` : ''}.`);
  }
  if (candidate.workerType !== workerType) {
    throw new ApiError(400, "This mobilisation's worker type doesn't match the candidate it was started from.");
  }
}

/** Right AFTER the mobilisation exists: point the candidate at it. Guarded on the
 *  candidate still being unlinked, so two simultaneous starts can't both win. */
export async function attachMobilisation(requirementId, candidateId, mobilisation, actor) {
  const result = await Requirement.updateOne(
    { _id: requirementId, candidates: { $elemMatch: { _id: candidateId, mobilisation: null } } },
    { $set: { 'candidates.$.mobilisation': mobilisation._id } }
  );
  if (result.modifiedCount === 0) {
    // The mobilisation exists and carries its own link, which is what approval keys
    // off, so nothing is lost — but say so, since two people started the same candidate.
    logger.warn(`[requirements] mobilisation ${mobilisation.serialNumber} could not be attached to candidate ${candidateId} on requirement ${requirementId}`);
    return;
  }
  await logAudit({
    user: actor.userId,
    action: 'requirement.candidate.mobilisation',
    targetType: 'Requirement',
    targetId: requirementId,
    meta: { mobilisation: mobilisation.serialNumber },
    ip: actor.ip,
  });
}

/**
 * AFTER a linked mobilisation's final approval (the Deployment already exists):
 * the candidate is now Mobilised; and once as many candidates are mobilised as the
 * card asked for, the card moves itself to the stage an admin marked as the
 * "mobilised" destination (none marked = it stays put; the progress still updates).
 * Best-effort at the call site — a failure here must never undo an approval.
 */
export async function onMobilisationApproved(mobilisation) {
  if (!mobilisation.requirement || !mobilisation.requirementCandidate) return;

  const requirement = await Requirement.findOneAndUpdate(
    { _id: mobilisation.requirement, 'candidates._id': mobilisation.requirementCandidate },
    { $set: { 'candidates.$.status': 'Mobilised', 'candidates.$.mobilisation': mobilisation._id } },
    { new: true }
  );
  if (!requirement) return; // the card or candidate is gone — nothing to update

  const candidate = requirement.candidates.id(mobilisation.requirementCandidate);
  const mobilised = requirement.candidates.filter((c) => c.status === 'Mobilised').length;
  const moverId = idOf(mobilisation.decidedBy ?? mobilisation.createdBy);

  const target = await RequirementStage.findOne({ isMobilisedStage: true }).lean();
  let advancedTo = null;
  if (target && mobilised >= requirement.headcount) {
    const now = new Date();
    const moved = await Requirement.updateOne(
      { _id: requirement._id, stage: { $ne: target._id } },
      { $set: { stage: target._id, stageEnteredAt: now }, $push: { stageHistory: moveEntry(target, moverId, now) } }
    );
    if (moved.modifiedCount > 0) advancedTo = target;
  }

  await logAudit({
    user: moverId,
    action: 'requirement.candidate.mobilised',
    targetType: 'Requirement',
    targetId: requirement._id,
    meta: { serialNumber: requirement.serialNumber, workerName: candidate.workerName, mobilised, headcount: requirement.headcount, ...(advancedTo && { advancedTo: advancedTo.name }) },
    ip: null,
  });

  // The card's coordinators hear about it (never the approver), and — only when the
  // card actually landed in a stage flagged "notify" — the team circle too.
  const recipients = new Set(requirement.coordinators.map(idOf));
  if (advancedTo?.notifyOnEnter) {
    const team = await getSectionAccess(TEAM_KEY);
    for (const id of await membersOfRoles([...team.readApprovalRoles, ...team.writeApprovalRoles])) recipients.add(id);
  }
  recipients.delete(moverId);
  const title = advancedTo ? `All workers mobilised — moved to "${advancedTo.name}"` : `${candidate.workerName} approved for mobilisation`;
  for (const userId of recipients) {
    await notifyUserSafely(userId, {
      type: 'Requirement',
      title,
      body: `${summary(requirement)} — ${mobilised} of ${requirement.headcount} mobilised`.slice(0, 500),
      url: boardUrl(requirement),
    });
  }
}
