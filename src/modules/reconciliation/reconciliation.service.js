/**
 * Reconciliation — a standing, read-only integrity report (the QA audit's
 * own suggestion #6: "add reconciliation checks for ledger totals,
 * finalized payroll, and deployments missing from approved mobilisations").
 * Every check here re-derives a figure from its own real components and
 * compares it against what's actually stored — the same "never trust a
 * cached total, recompute it" discipline this app already applies live on
 * every read for Invoice/Advance/Mobilisation/Deployment profit; this
 * report is the STANDING, ON-DEMAND version of that discipline, catching
 * drift that a live recompute wouldn't (a cached field that was never
 * recomputed because nothing ever read it, or a one-off write that bypassed
 * the normal service layer entirely, e.g. a direct DB edit).
 *
 * Deliberately narrow: this checks that stored AGGREGATES match their own
 * DECLARED COMPONENTS (e.g. Invoice.amountPaid vs. sum(payments[].amount)),
 * not that the underlying business FORMULA is correct — re-deriving every
 * module's entire computation here would duplicate (and risk silently
 * diverging from) each service's own already-tested formula. Every finding
 * links back to the real record so a human decides what to do about it —
 * this report never writes anything.
 */
import Mobilisation from '../mobilisations/mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import Invoice from '../invoices/invoice.model.js';
import SalaryAdvance from '../financialRequests/advance.model.js';
import PayrollRun from '../payroll/payrollRun.model.js';

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (arr, pick) => money(arr.reduce((total, item) => total + (pick(item) ?? 0), 0));

/** An Approved or Completed mobilisation must have exactly one Deployment
 *  (createDeploymentFromMobilisation fires exactly once, at approval — see
 *  mobilisation.service.js). A missing one means the compensating rollback
 *  either never ran or itself failed — should be rare-to-never given the
 *  2026-09-14 fix, which is exactly why this is worth a standing check
 *  rather than trusting that fix silently forever. */
async function orphanedMobilisations() {
  const approved = await Mobilisation.find({ status: { $in: ['Approved', 'Completed'] } })
    .select('serialNumber workerName clientName status')
    .lean();
  if (!approved.length) return [];
  const withDeployment = await Deployment.find({ mobilisation: { $in: approved.map((m) => m._id) } })
    .distinct('mobilisation');
  const withDeploymentIds = new Set(withDeployment.map(String));
  return approved
    .filter((m) => !withDeploymentIds.has(String(m._id)))
    .map((m) => ({
      category: 'orphanedMobilisation',
      severity: 'high',
      summary: `${m.serialNumber} (${m.workerName} — ${m.clientName}) is ${m.status} but has no Deployment.`,
      targetType: 'Mobilisation',
      targetId: m._id,
      url: `/mobilisations/${m._id}`,
    }));
}

/** More than one Active deployment for the same real Employee, or the same
 *  SupplierEmployee/Freelancer Iqama, is physically impossible (a worker
 *  can't be placed two places at once) — the exact bug class the
 *  `uniq_active_worker` partial-index fix (2026-09-12) closed for Employee
 *  and the iqama-based guard closed for the other two worker types. This is
 *  the standing check that those guards are still actually holding. */
async function doubleBookedWorkers() {
  const active = await Deployment.find({ status: 'Active' })
    .select('workerType worker workerName clientName')
    .populate({ path: 'mobilisation', select: 'iqamaNumber' })
    .lean();
  const byIdentity = new Map();
  for (const d of active) {
    const identity = d.workerType === 'Employee' ? `Employee:${d.worker}` : `Iqama:${d.mobilisation?.iqamaNumber}`;
    if (identity.endsWith('undefined')) continue;
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push(d);
  }
  const findings = [];
  for (const deployments of byIdentity.values()) {
    if (deployments.length < 2) continue;
    findings.push({
      category: 'doubleBookedWorker',
      severity: 'high',
      summary: `${deployments[0].workerName} has ${deployments.length} simultaneously Active deployments: ${deployments.map((d) => d.clientName).join(', ')}.`,
      targetType: 'Deployment',
      targetId: deployments[0]._id,
      url: `/deployments/${deployments[0]._id}`,
    });
  }
  return findings;
}

/** Invoice.amountPaid/balanceDue are cached, updated atomically on every
 *  payment (see invoice.service.js's recordPayment) — this re-sums the real
 *  payments[] ledger independently and compares. */
async function invoiceLedgerMismatches() {
  const invoices = await Invoice.find({ 'payments.0': { $exists: true } })
    .select('invoiceNumber total amountPaid balanceDue payments status')
    .lean();
  const findings = [];
  for (const inv of invoices) {
    const realPaid = sum(inv.payments, (p) => p.amount);
    const realBalance = money(inv.total - realPaid);
    if (realPaid !== money(inv.amountPaid) || realBalance !== money(inv.balanceDue)) {
      findings.push({
        category: 'invoiceLedgerMismatch',
        severity: 'high',
        summary: `Invoice ${inv.invoiceNumber}: stored amountPaid ${inv.amountPaid}/balanceDue ${inv.balanceDue}, but payments[] sums to ${realPaid} paid / ${realBalance} due.`,
        targetType: 'Invoice',
        targetId: inv._id,
        url: `/invoices/${inv._id}`,
      });
    }
  }
  return findings;
}

/** A SalaryAdvance's status should be 'Closed' iff repayments[] sums to
 *  exactly the original amount — and never MORE than it (the atomic $expr
 *  guard in addRepayment should make over-repayment impossible; this is
 *  the standing check that it's actually holding). */
async function salaryAdvanceLedgerMismatches() {
  // Unlike Invoice/Deployment/Settlement, SalaryAdvance snapshots no
  // employee identity fields of its own — only a live `employee` ref —
  // so this is the one detector that needs a populate for a readable
  // summary line.
  const advances = await SalaryAdvance.find({ status: { $in: ['Approved', 'Closed'] } })
    .select('employee amount repayments status')
    .populate('employee', 'fullName employeeId')
    .lean();
  const findings = [];
  for (const adv of advances) {
    const who = `${adv.employee?.fullName ?? 'Unknown employee'} (${adv.employee?.employeeId ?? adv.employee?._id})`;
    const repaid = sum(adv.repayments, (r) => r.amount);
    const shouldBeClosed = repaid === money(adv.amount);
    if (repaid > money(adv.amount)) {
      findings.push({
        category: 'advanceOverRepaid',
        severity: 'high',
        summary: `${who}: repaid ${repaid} against an advance of only ${adv.amount}.`,
        targetType: 'SalaryAdvance',
        targetId: adv._id,
        url: `/financial-requests`,
      });
    } else if (shouldBeClosed !== (adv.status === 'Closed')) {
      findings.push({
        category: 'advanceStatusMismatch',
        severity: 'medium',
        summary: `${who}: repayments sum to ${repaid} of ${adv.amount} but status is "${adv.status}", not "${shouldBeClosed ? 'Closed' : 'Approved'}".`,
        targetType: 'SalaryAdvance',
        targetId: adv._id,
        url: `/financial-requests`,
      });
    }
  }
  return findings;
}

/** A finalized PayrollRun's run-level totals (totalGross/totalDeductions/
 *  totalNet) should equal the sum of its own lines — same "cached aggregate
 *  vs. its declared components" check as the Invoice one above. Only
 *  Finalized runs are checked: a Draft run is still being edited, so a
 *  momentary mismatch there is normal, not a finding. */
async function payrollRunMismatches() {
  const runs = await PayrollRun.find({ status: 'Finalized' })
    .select('periodYear periodMonth totalGross totalDeductions totalNet lines')
    .lean();
  const findings = [];
  for (const run of runs) {
    const realGross = sum(run.lines, (l) => l.grossPay);
    const realDeductions = sum(run.lines, (l) => l.totalDeductions);
    const realNet = sum(run.lines, (l) => l.netPay);
    if (realGross !== money(run.totalGross) || realDeductions !== money(run.totalDeductions) || realNet !== money(run.totalNet)) {
      findings.push({
        category: 'payrollRunMismatch',
        severity: 'high',
        summary: `Payroll ${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}: stored totals (gross ${run.totalGross}, deductions ${run.totalDeductions}, net ${run.totalNet}) don't match the sum of its own ${run.lines.length} line(s) (gross ${realGross}, deductions ${realDeductions}, net ${realNet}).`,
        targetType: 'PayrollRun',
        targetId: run._id,
        url: `/payroll/${run._id}`,
      });
    }
  }
  return findings;
}

/** Runs every check in parallel and returns one flat, severity-sorted list.
 *  Nothing here writes to the database — every finding is a link to the
 *  real record for a human to look at and decide what to do about. */
export async function runReconciliation() {
  const results = await Promise.all([
    orphanedMobilisations(),
    doubleBookedWorkers(),
    invoiceLedgerMismatches(),
    salaryAdvanceLedgerMismatches(),
    payrollRunMismatches(),
  ]);
  const findings = results.flat();
  const severityRank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return {
    checkedAt: new Date(),
    total: findings.length,
    byCategory: Object.fromEntries(
      Object.entries(
        findings.reduce((acc, f) => {
          acc[f.category] = (acc[f.category] ?? 0) + 1;
          return acc;
        }, {})
      )
    ),
    findings,
  };
}
