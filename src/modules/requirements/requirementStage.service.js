/**
 * RequirementStage service — the board's columns. Reading them needs no
 * function here: every board user gets the stages with the board itself
 * (requirement.service.js's getBoard). Writing them is Section Access key
 * 'requirementStages' (Admin only until granted), enforced at the route.
 */
import RequirementStage from './requirementStage.model.js';
import Requirement from './requirement.model.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';
import { logAudit } from '../audit/audit.service.js';

/**
 * A STARTING POINT, not a rule — offered by an explicit "Use suggested stages"
 * click on an empty board (never seeded silently), and every name, number and
 * flag is editable afterwards. The day counts are only sensible first guesses.
 * "On hold" is deliberately not terminal: a paused requirement must stay
 * visible until someone resumes it.
 */
const SUGGESTED_STAGES = [
  { name: 'New requirement', staleAfterDays: 3 },
  { name: 'Sourcing', staleAfterDays: 5 },
  { name: 'Worker identified', staleAfterDays: 5 },
  { name: 'Documentation in progress', staleAfterDays: 7 },
  { name: 'Ready to mobilise', staleAfterDays: 3, notifyOnEnter: true },
  { name: 'On hold' },
  { name: 'Mobilised', isTerminal: true, isMobilisedStage: true },
  { name: 'Lost', isTerminal: true },
];

const audit = (action, stage, actor, meta = {}) =>
  logAudit({
    user: actor.userId,
    action,
    targetType: 'RequirementStage',
    targetId: stage?._id ?? null,
    meta: { name: stage?.name, ...meta },
    ip: actor.ip,
  });

async function assertNameFree(name, exceptId = null) {
  const clash = await RequirementStage.findOne({
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    ...(exceptId && { _id: { $ne: exceptId } }),
  })
    .select('_id')
    .lean();
  if (clash) throw new ApiError(409, `There is already a stage called "${name}".`);
}

/** A terminal stage is never flagged stale — a finished card doesn't rot. */
const normalise = (data) => (data.isTerminal ? { ...data, staleAfterDays: null } : data);

/** At most one stage is "where a fully-mobilised card goes" — flagging one
 *  un-flags the rest, so an admin moves the flag rather than getting an error. */
async function clearMobilisedFlagElsewhere(exceptId) {
  await RequirementStage.updateMany({ ...(exceptId && { _id: { $ne: exceptId } }), isMobilisedStage: true }, { $set: { isMobilisedStage: false } });
}

export async function createStage(data, actor) {
  await assertNameFree(data.name);
  const last = await RequirementStage.findOne({}).sort({ order: -1 }).select('order').lean();
  if (data.isMobilisedStage) await clearMobilisedFlagElsewhere(null);
  const stage = await RequirementStage.create({ ...normalise(data), order: (last?.order ?? -1) + 1 });
  await audit('requirementStage.create', stage, actor);
  return stage.toObject();
}

export async function updateStage(id, data, actor) {
  const stage = await RequirementStage.findById(id);
  if (!stage) throw new ApiError(404, 'Stage not found.');
  if (data.name !== undefined && data.name.toLowerCase() !== stage.name.toLowerCase()) await assertNameFree(data.name, id);

  if (data.isMobilisedStage === true) await clearMobilisedFlagElsewhere(id);
  for (const key of ['name', 'staleAfterDays', 'isTerminal', 'notifyOnEnter', 'isMobilisedStage']) {
    if (data[key] !== undefined) stage[key] = data[key];
  }
  if (stage.isTerminal) stage.staleAfterDays = null;
  await stage.save();
  await audit('requirementStage.update', stage, actor, { fields: Object.keys(data) });
  return stage.toObject();
}

/** Referential integrity: refuse to strand cards in a column that's gone. */
export async function deleteStage(id, actor) {
  const inUse = await Requirement.countDocuments({ stage: id });
  if (inUse > 0) {
    throw new ApiError(409, `${inUse} requirement(s) are in this stage. Move them to another stage first.`);
  }
  const stage = await RequirementStage.findByIdAndDelete(id).lean();
  if (!stage) throw new ApiError(404, 'Stage not found.');
  await audit('requirementStage.delete', stage, actor);
}

/** `ids` must be every stage exactly once — a partial list would leave the
 *  unlisted ones with stale `order` values and an ambiguous board. */
export async function reorderStages(ids, actor) {
  const existing = await RequirementStage.find({}).select('_id').lean();
  const known = new Set(existing.map((s) => String(s._id)));
  if (ids.length !== known.size || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    throw new ApiError(400, 'The new order must list every stage exactly once.');
  }
  await RequirementStage.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { $set: { order } } } })));
  await audit('requirementStage.reorder', null, actor, { count: ids.length });
  return RequirementStage.find({}).sort({ order: 1 }).lean();
}

export async function createSuggestedStages(actor) {
  if ((await RequirementStage.estimatedDocumentCount()) > 0) {
    throw new ApiError(409, 'Stages already exist — the suggested set is only offered on an empty board.');
  }
  const stages = await RequirementStage.insertMany(SUGGESTED_STAGES.map((s, order) => ({ ...s, order })));
  await audit('requirementStage.defaults', null, actor, { count: stages.length });
  return stages.map((s) => s.toObject());
}
