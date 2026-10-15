/**
 * companyCosts — the money the company spends that is recorded somewhere other than the Expenses ledger,
 * read live so the ledger shows every company cost in one place without keeping a second copy:
 *  - Mobilisation: the one-time cost on an Approved/Completed mobilisation (flight, agent, visa fees), dated
 *    by the mobilisation date;
 *  - Subcontractor Payment: a payment to a subcontractor once its approval is Approved, dated by its payment date;
 *  - End of Service: the total of a settlement for an employee who has left (a "current employee" what-if
 *    settlement was never paid, so it is left out).
 * Paid reimbursements are already copied into the ledger as Expense rows ('Staff Reimbursement'), so they are
 * not repeated here. These rows are read-only and never written to the Expense collection: the dashboard's
 * profit already deducts each of these where it belongs, and storing them again would count them twice.
 * A source is only included for a viewer who also holds that source's own Section Access Read.
 */
import Mobilisation from '../mobilisations/mobilisation.model.js';
import SubcontractorPayment from '../deployments/subcontractorPayment.model.js';
import Settlement from '../eosb/settlement.model.js';

export const DERIVED_EXPENSE_CATEGORIES = ['Mobilisation', 'Subcontractor Payment', 'End of Service'];

/** category -> the Section Access key whose Read the viewer needs to see these rows. */
const SOURCE_SECTION = {
  Mobilisation: 'mobilisationsViewer',
  'Subcontractor Payment': 'subcontractorsManage',
  'End of Service': 'eosb',
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dateFilter(from, to) {
  if (!from && !to) return undefined;
  return { ...(from && { $gte: from }), ...(to && { $lte: to }) };
}

async function mobilisationCosts({ client, from, to, search }) {
  const rx = search ? { $regex: escapeRegex(search), $options: 'i' } : null;
  const date = dateFilter(from, to);
  const rows = await Mobilisation.find({
    status: { $in: ['Approved', 'Completed'] },
    mobilisationCost: { $gt: 0 },
    ...(client && { client }),
    ...(date && { mobilisationDate: date }),
    ...(rx && { $or: [{ workerName: rx }, { serialNumber: rx }, { clientName: rx }] }),
  })
    .select('serialNumber workerName client clientName mobilisationCost mobilisationDate')
    .lean();
  return rows.map((m) => ({
    _id: `mobilisation-${m._id}`,
    date: m.mobilisationDate,
    category: 'Mobilisation',
    vendor: m.workerName,
    amount: m.mobilisationCost,
    client: m.client,
    clientName: m.clientName,
    notes: m.serialNumber,
    receipt: null,
    derived: true,
    link: `/mobilisations/${m._id}`,
  }));
}

async function subcontractorPayments({ from, to, search }) {
  const date = dateFilter(from, to);
  const rows = await SubcontractorPayment.find({
    decisionStatus: 'Approved',
    ...(date && { paymentDate: date }),
  })
    .populate('subcontractor', 'name')
    .select('subcontractor amount paymentReference paymentDate')
    .lean();
  const needle = search?.toLowerCase();
  return rows
    .filter((p) => !needle || `${p.subcontractor?.name ?? ''} ${p.paymentReference ?? ''}`.toLowerCase().includes(needle))
    .map((p) => ({
      _id: `subcontractor-payment-${p._id}`,
      date: p.paymentDate,
      category: 'Subcontractor Payment',
      vendor: p.subcontractor?.name ?? '',
      amount: p.amount,
      client: null,
      clientName: null,
      notes: p.paymentReference ?? null,
      receipt: null,
      derived: true,
      link: p.subcontractor?._id ? `/subcontractors/${p.subcontractor._id}` : '/subcontractors',
    }));
}

async function settlements({ from, to, search }) {
  const rx = search ? { $regex: escapeRegex(search), $options: 'i' } : null;
  const date = dateFilter(from, to);
  const rows = await Settlement.find({
    exitReason: { $ne: 'CurrentEmployee' },
    ...(date && { exitDate: date }),
    ...(rx && { $or: [{ employeeName: rx }, { employeeCode: rx }] }),
  })
    .select('employeeName employeeCode totalSettlement exitDate')
    .lean();
  return rows.map((s) => ({
    _id: `settlement-${s._id}`,
    date: s.exitDate,
    category: 'End of Service',
    vendor: s.employeeName,
    amount: s.totalSettlement,
    client: null,
    clientName: null,
    notes: s.employeeCode,
    receipt: null,
    derived: true,
    link: `/eosb/${s._id}`,
  }));
}

const SOURCES = {
  Mobilisation: mobilisationCosts,
  'Subcontractor Payment': subcontractorPayments,
  'End of Service': settlements,
};

/**
 * Every derived cost row matching the filters, for the categories the viewer may see. `readKeys` is the viewer's
 * Section Access Read list. A client filter keeps only mobilisation rows (the others have no client).
 */
export async function listDerivedCosts({ category, client, from, to, search }, readKeys) {
  const wanted = DERIVED_EXPENSE_CATEGORIES.filter(
    (c) => (!category || category === c) && readKeys.includes(SOURCE_SECTION[c]) && (!client || c === 'Mobilisation')
  );
  const lists = await Promise.all(wanted.map((c) => SOURCES[c]({ client, from, to, search })));
  return lists.flat();
}
