/**
 * Expiry tracker (2026-10-15): ONE list of every document that has an expiry date, wherever it is kept -
 * employees' identity documents and "additional" documents, files in the Documents module (employee, client or
 * subcontractor), and outsourced workers' documents - with where each stands (valid / expiring / expired).
 * Document numbers are not returned: this is a watch list, the records hold the details.
 *
 * "Expiring" means inside that document's own reminder window: the 6- or 3-month ladder for an identity
 * document (the same one the daily reminders use), 3 months for an "additional" one, the lead time set on an
 * outsourced worker's document, 30 days for a stored file.
 */
import Employee from '../employees/employee.model.js';
import OutsourcedEmployee from '../employees/outsourcedEmployee.model.js';
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Document from './document.model.js';
import { IDENTITY_DOCS } from '../dashboard/dashboard.service.js';
import { START_MONTHS } from '../notifications/expiryAlert.job.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

const DAY = 86_400_000;
const STORED_FILE_WINDOW_DAYS = 30;

const utcDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

function entry(base, expiry, windowDays) {
  const daysLeft = Math.round((utcDay(expiry).getTime() - utcDay(new Date()).getTime()) / DAY);
  const status = daysLeft < 0 ? 'Expired' : daysLeft <= windowDays ? 'Expiring' : 'Valid';
  return { ...base, expiry, daysLeft, status, reminderDays: windowDays };
}

const monthsToDays = (months) => {
  const end = new Date();
  end.setUTCMonth(end.getUTCMonth() + months);
  return Math.round((utcDay(end).getTime() - utcDay(new Date()).getTime()) / DAY);
};

/**
 * @param {{status?: 'Expired'|'Expiring'|'Valid', ownerType?: string, search?: string, page?: number, limit?: number}} query
 * @param {{role: string, userId: string, employee?: string|null}} actor
 */
export async function listExpiryTracker({ status, ownerType, search, page = 1, limit = 25 }, actor) {
  const isCoordinator = actor?.role === 'Coordinator';
  const teamIds = isCoordinator ? await Employee.find({ coordinator: actor.userId }).distinct('_id') : null;
  const items = [];

  if (!ownerType || ownerType === 'Employee') {
    const filter = { status: { $ne: 'Exited' } };
    if (teamIds) filter._id = { $in: teamIds };
    const employees = await Employee.find(filter)
      .select('fullName employeeId passport visa iqama medical drivingLicense additionalDocuments')
      .lean();
    for (const e of employees) {
      const base = { ownerType: 'Employee', ownerId: e._id, ownerName: e.fullName, ownerRef: e.employeeId, link: `/employees/${e._id}` };
      for (const [key, label] of IDENTITY_DOCS) {
        const expiry = e[key]?.expiry;
        if (expiry) items.push(entry({ ...base, source: 'EmployeeIdentity', name: label }, expiry, monthsToDays(START_MONTHS[key])));
      }
      for (const doc of e.additionalDocuments ?? []) {
        if (doc.expiry) items.push(entry({ ...base, source: 'EmployeeExtra', name: doc.name }, doc.expiry, monthsToDays(3)));
      }
    }
  }

  // Files in the Documents module (the restricted ones only for their own employee and Admin).
  if (ownerType !== 'Outsourced') {
    const conditions = [{ expiryDate: { $ne: null } }];
    if (ownerType) conditions.push({ ownerType });
    if (isCoordinator) {
      conditions.push({
        $or: [
          { ownerType: { $in: ['Client', 'Subcontractor'] } },
          { ownerType: 'Employee', owner: { $in: teamIds } },
          ...(actor.employee ? [{ ownerType: 'Employee', owner: actor.employee }] : []),
        ],
      });
    }
    if (actor?.role !== 'Admin') {
      conditions.push({
        $or: [{ restricted: { $ne: true } }, ...(actor?.employee ? [{ ownerType: 'Employee', owner: actor.employee }] : [])],
      });
    }
    const documents = await Document.find({ $and: conditions })
      .populate('owner', 'fullName employeeId companyName name')
      .lean();
    const section = { Employee: '/employees', Client: '/clients', Subcontractor: '/subcontractors' };
    for (const d of documents) {
      const name = d.owner?.fullName ?? d.owner?.companyName ?? d.owner?.name ?? '-';
      items.push(
        entry(
          {
            source: 'Document',
            ownerType: d.ownerType,
            ownerId: d.owner?._id ?? d.owner,
            ownerName: name,
            ownerRef: d.owner?.employeeId ?? null,
            name: d.title,
            link: d.owner?._id ? `${section[d.ownerType]}/${d.owner._id}` : section[d.ownerType],
          },
          d.expiryDate,
          STORED_FILE_WINDOW_DAYS
        )
      );
    }
  }

  if (!ownerType || ownerType === 'Outsourced') {
    let workerFilter = { 'documents.expiryDate': { $ne: null } };
    if (isCoordinator) {
      // A Coordinator sees the outsourced workers on their own mobilisations.
      const iqamas = await Mobilisation.find({ 'coordinators.user': actor.userId, archived: { $ne: true } }).distinct('iqamaNumber');
      workerFilter = { ...workerFilter, iqamaNumber: { $in: iqamas.filter(Boolean) } };
    }
    const workers = await OutsourcedEmployee.find(workerFilter).select('name iqamaNumber documents').lean();
    for (const w of workers) {
      for (const doc of w.documents ?? []) {
        if (!doc.expiryDate) continue;
        items.push(
          entry(
            { source: 'Outsourced', ownerType: 'Outsourced', ownerId: w._id, ownerName: w.name, ownerRef: w.iqamaNumber, name: doc.title, link: '/outsourced-employees' },
            doc.expiryDate,
            doc.reminderDays ?? 30
          )
        );
      }
    }
  }

  const needle = search ? new RegExp(escapeRegex(search), 'i') : null;
  const matching = items.filter((i) => !needle || needle.test(i.ownerName) || needle.test(i.name) || needle.test(i.ownerRef ?? ''));
  const counts = { Expired: 0, Expiring: 0, Valid: 0 };
  for (const i of matching) counts[i.status] += 1;
  const filtered = matching.filter((i) => !status || i.status === status).sort((a, b) => new Date(a.expiry) - new Date(b.expiry));

  const start = (page - 1) * limit;
  return {
    items: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    pages: Math.max(1, Math.ceil(filtered.length / limit)),
    counts,
  };
}
