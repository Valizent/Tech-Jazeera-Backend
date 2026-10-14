/**
 * Plain-language descriptions of audit entries (2026-10-14, the user's own ask: the
 * Security Log's Details column showed raw `key: value` pairs, with no explanation of
 * what was deleted). Computed when the log is read, never stored, so older entries get
 * the same wording and nothing about the audit data changes.
 *
 * Each entry gets `description`: a list of short sentences. The first one is the
 * summary; the rest are the supporting facts the log page folds behind "View more".
 * Known actions have their own wording; anything else falls back to labelled facts
 * ("Serial number: MOB-0082"), with technical ids left out.
 */
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import User from '../auth/user.model.js';
import { SECTION_LABELS } from '../sectionAccess/sectionAccess.service.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** camelCase / snake_case key -> "serial number". */
const words = (key) =>
  String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
const cap = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const statusText = (value) => cap(words(value ?? ''));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (n) => `SAR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A meta value as readable text, or null when it is empty or only a technical id. */
function valueText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const items = value.map(valueText).filter(Boolean);
    return items.length ? items.join(', ') : null;
  }
  if (typeof value === 'object') {
    if ('from' in value || 'to' in value) return `${valueText(value.from) ?? 'empty'} → ${valueText(value.to) ?? 'empty'}`;
    const parts = Object.entries(value)
      .map(([key, inner]) => (valueText(inner) ? `${words(key)} ${valueText(inner)}` : null))
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  const text = String(value);
  if (OBJECT_ID.test(text)) return null;
  const date = ISO_DATE.exec(text);
  if (date) return `${Number(date[3])} ${MONTHS[Number(date[2]) - 1]} ${date[1]}`;
  return text;
}

/** "Designation: Fitter → Foreman" lines out of an update's `changes`. */
function changeLines(changes) {
  return Object.entries(changes ?? {})
    .map(([field, change]) => {
      const text = valueText(change);
      return text ? `${cap(words(field))}: ${text}` : null;
    })
    .filter(Boolean);
}

const DELETED_THINGS = {
  'client.delete': ['client', 'companyName'],
  'asset.delete': ['asset', 'assetTag'],
  'holiday.delete': ['holiday', 'name'],
  'jobTitle.delete': ['job title', 'name'],
  'location.delete': ['location', 'name'],
  'ramadanPeriod.delete': ['Ramadan period', 'label'],
  'subcontractor.delete': ['subcontractor', 'name'],
  'nfc.employee.delete': ['NFC contact', 'name'],
  'nfc.company.delete': ['NFC company', 'companyName'],
};

/** `target` is where the entry points ("mobilisation MOB-0082 (Hassan)"), `names` resolves ids to people. */
const SPECIFIC = {
  'auth.login.failed': (m) => [`Someone tried to sign in${m.email ? ` as ${m.email}` : ''} and was refused.`],

  'mobilisation.create': (m) => [`Created a mobilisation for ${m.workerName ?? 'a worker'}${m.clientName ? ` at ${m.clientName}` : ''}.`],
  'mobilisation.update': (m, { target }) => [
    `Edited ${target ?? 'a mobilisation'}.`,
    ...(m.fields?.length ? [`Fields changed: ${m.fields.map(words).join(', ')}.`] : []),
  ],
  'mobilisation.delete': (m) => [
    `Deleted mobilisation ${m.serialNumber ?? ''}${m.workerName ? ` for ${m.workerName}` : ''}.`.replace(/\s+\./, '.'),
    ['Approved', 'Completed'].includes(m.status)
      ? `It was marked ${statusText(m.status)} but never got a deployment, so it was a broken leftover.`
      : `It had not been approved yet (it was ${statusText(m.status) || 'unconfirmed'}).`,
  ],
  'mobilisation.documents.add': (m, { target }) => [
    `Added ${plural(m.count ?? 1, 'document')}${m.category ? ` (${m.category})` : ''} to ${target ?? 'a mobilisation'}.`,
  ],
  'mobilisation.documents.remove': (m, { target }) => [
    `Removed ${m.documentName ? `the document “${m.documentName}”` : 'a document'}${m.category ? ` (${m.category})` : ''} from ${target ?? 'a mobilisation'}.`,
    ...(m.documentName ? [] : ['The document name was not recorded for this older entry.']),
  ],
  'mobilisation.coordinator.remove': (m, { target, names }) => [
    `Removed ${names.get(m.removedUser) ?? 'a coordinator'} from ${target ?? 'a mobilisation'}.`,
  ],
  'mobilisation.rejected': (m, { target }) => [
    `Rejected ${target ?? 'a mobilisation'}.`,
    ...(m.decisionNote ? [`Reason given: ${m.decisionNote}`] : []),
    ...(m.viaAdminOverride ? ['Rejected by an Admin on behalf of the reviewers.'] : []),
  ],

  'employee.create': (m) => [
    `Added employee ${m.fullName ?? ''}${m.employeeId ? ` (${m.employeeId})` : ''}${m.designation ? `, ${m.designation}` : ''}.`.replace(/\s+\./, '.'),
  ],
  'employee.update': (m) => {
    const changes = changeLines(m.changes);
    return [
      `Updated employee ${m.fullName ?? ''}${m.employeeId ? ` (${m.employeeId})` : ''}.`.replace(/\s+\./, '.'),
      ...(changes.length ? changes : m.fields?.length ? [`Fields changed: ${m.fields.map(words).join(', ')}.`] : []),
    ];
  },
  'employee.delete': (m) => [
    `Deleted employee ${m.fullName ?? ''}${m.employeeId ? ` (${m.employeeId})` : ''}${m.designation ? `, ${m.designation}` : ''}.`.replace(/\s+\./, '.'),
    ...(m.loginRemoved ? ['Their sign-in login was removed with them.'] : []),
  ],
  'user.role.update': (m) => [`Changed the login role of ${m.email ?? 'a login'} from ${m.from ?? 'unknown'} to ${m.to ?? 'unknown'}.`],
  'user.delete.staff': (m) => [`Deleted the staff login ${m.email ?? ''}${m.role ? ` (${m.role})` : ''}.`.replace(/\s+\./, '.')],

  'document.delete': (m) => [
    `Deleted the document “${m.title ?? 'untitled'}”${m.versions ? ` (${plural(m.versions, 'version')})` : ''}.`,
    ...(m.filesNotDeleted?.length ? ['Some stored files could not be removed from storage.'] : []),
  ],
  'expense.delete': (m) => [
    `Deleted an expense of ${m.amount != null ? money(m.amount) : 'an unknown amount'}${m.category ? ` (${m.category}${m.vendor ? `, ${m.vendor}` : ''})` : ''}.`,
  ],
  'eosb.settlement.delete': (m) => [`Deleted the end-of-service settlement for employee ${m.employeeCode ?? 'unknown'}.`],
  'nfc.card.delete': () => ['Deleted an NFC card.'],
  'worker.archive': (m) => [
    `Archived the data of ${m.workerName ?? 'a worker'}${m.iqamaNumber ? ` (Iqama ${m.iqamaNumber})` : ''}.`,
    ...(m.mobilisationCount != null ? [`${plural(m.mobilisationCount, 'mobilisation')} hidden from the lists.`] : []),
  ],
  'worker.unarchive': (m) => [
    `Restored the data of ${m.workerName ?? 'a worker'}${m.iqamaNumber ? ` (Iqama ${m.iqamaNumber})` : ''}.`,
    ...(m.mobilisationCount != null ? [`${plural(m.mobilisationCount, 'mobilisation')} back in the lists.`] : []),
  ],

  'sectionAccess.update': (m) => {
    const name = SECTION_LABELS[m.sectionKey] ?? cap(words(m.sectionKey ?? 'a section'));
    return [
      `Changed who can use “${name}”.`,
      `Roles that can see it: ${m.readApprovalRoleCount ?? 0}. Roles that can change it: ${m.writeApprovalRoleCount ?? 0}.`,
      `All office staff: ${m.writeAllStaff ? 'can change it' : m.readAllStaff ? 'can see it' : 'no access through this switch'}.`,
      ...(m.exceptRoleCount ? [`Roles left out of All office staff: ${m.exceptRoleCount}.`] : []),
    ];
  },
};

/** Entry-level handlers that read the entry's own action, for the whole `X.delete` family. */
function deleteFamily(action, m) {
  const thing = DELETED_THINGS[action];
  if (!thing) return null;
  const [noun, field] = thing;
  const lines = [`Deleted the ${noun}${m[field] ? ` “${m[field]}”` : ''}.`];
  if (action === 'nfc.company.delete') {
    if (m.removedEmployees) lines.push(`${plural(m.removedEmployees, 'contact')} under it were removed.`);
    if (m.freedCards) lines.push(`${plural(m.freedCards, 'card')} were freed up.`);
  }
  return lines;
}

/** Keys that are only technical ids or secrets and are never shown in the fallback. */
const HIDDEN_KEYS = new Set(['token', 'fileId', 'coordinatorId', 'removedUser', 'createdOnBehalfOf', 'requirement']);

function genericLines(meta) {
  return Object.entries(meta ?? {})
    .filter(([key]) => !HIDDEN_KEYS.has(key) && !/Id$/.test(key))
    .map(([key, value]) => {
      const text = valueText(value);
      return text ? `${cap(words(key))}: ${text}` : null;
    })
    .filter(Boolean);
}

const TARGET_MODELS = {
  Mobilisation: { Model: Mobilisation, select: 'serialNumber workerName', label: (d) => `mobilisation ${d.serialNumber}${d.workerName ? ` (${d.workerName})` : ''}` },
  Employee: { Model: Employee, select: 'employeeId fullName', label: (d) => `employee ${d.fullName} (${d.employeeId})` },
  Client: { Model: Client, select: 'companyName', label: (d) => `client “${d.companyName}”` },
  Subcontractor: { Model: Subcontractor, select: 'name', label: (d) => `subcontractor “${d.name}”` },
  User: { Model: User, select: 'name email', label: (d) => `${d.name ?? d.email}'s login` },
};
const USER_ID_KEYS = ['removedUser', 'createdOnBehalfOf'];

/**
 * Adds `description` (string[]) to each entry. Looks up the names of the records the
 * entries point at in one query per record type; a record that no longer exists simply
 * has no name, and the sentence falls back to what the entry itself recorded.
 */
export async function describeEntries(entries) {
  const idsByType = new Map();
  const userIds = new Set();
  for (const entry of entries) {
    if (entry.targetType in TARGET_MODELS && entry.targetId) {
      if (!idsByType.has(entry.targetType)) idsByType.set(entry.targetType, new Set());
      idsByType.get(entry.targetType).add(String(entry.targetId));
    }
    for (const key of USER_ID_KEYS) if (OBJECT_ID.test(String(entry.meta?.[key] ?? ''))) userIds.add(String(entry.meta[key]));
  }

  const labels = new Map();
  await Promise.all([
    ...[...idsByType].map(async ([type, ids]) => {
      const { Model, select, label } = TARGET_MODELS[type];
      const docs = await Model.find({ _id: { $in: [...ids] } }).select(select).lean();
      for (const doc of docs) labels.set(`${type}:${doc._id}`, label(doc));
    }),
    (async () => {
      if (userIds.size === 0) return;
      const users = await User.find({ _id: { $in: [...userIds] } }).select('name email').lean();
      for (const user of users) labels.set(`user:${user._id}`, user.name ?? user.email);
    })(),
  ]);
  const names = new Map([...labels].filter(([k]) => k.startsWith('user:')).map(([k, v]) => [k.slice(5), v]));

  return entries.map((entry) => {
    const meta = entry.meta ?? {};
    const target = labels.get(`${entry.targetType}:${entry.targetId}`) ?? null;
    const specific = SPECIFIC[entry.action];
    const lines = specific
      ? specific(meta, { target, names })
      : (deleteFamily(entry.action, meta) ?? genericLines(meta));
    return { ...entry, description: lines.filter(Boolean) };
  });
}
