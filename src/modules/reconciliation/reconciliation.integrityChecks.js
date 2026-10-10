/**
 * Reconciliation detectors added 2026-10-10 (QA audit V2 follow-up: "add the
 * asset, stage and subcontractor-money inconsistencies to the standing
 * report"). Same rules as reconciliation.service.js: read-only, every finding
 * links to the real record, nothing here ever writes.
 *
 * Kept in their own file so the original service stays a short list of
 * ledger checks; reconciliation.service.js runs every detector exported here
 * alongside its own.
 */
import Deployment from '../deployments/deployment.model.js';
import Asset from '../assets/asset.model.js';
import AssetAssignment from '../assets/assetAssignment.model.js';
import RequirementStage from '../requirements/requirementStage.model.js';
import Requirement from '../requirements/requirement.model.js';
import ClientPayment from '../deployments/clientPayment.model.js';
import SubcontractorPayment from '../deployments/subcontractorPayment.model.js';
import Client from '../clients/client.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';

const MAX_PAYMENT = 10_000_000;
const isWholeHalala = (n) => Number.isFinite(n) && Math.abs(Math.round(n * 100) / 100 - n) < 1e-9;

/**
 * An asset's own status/holder must agree with its Active assignment row. The
 * assign/return transactions write both; a stale return used to be able to
 * free a re-assigned asset (V2-F05, fixed 2026-10-10) — this is the standing
 * check that the two records still tell the same story.
 */
export async function assetHolderInconsistencies() {
  const [assets, active] = await Promise.all([
    Asset.find({}).select('assetTag name status currentEmployee').lean(),
    AssetAssignment.find({ status: 'Active' }).select('asset employee employeeName').lean(),
  ]);
  const activeByAsset = new Map();
  for (const a of active) {
    const key = String(a.asset);
    if (!activeByAsset.has(key)) activeByAsset.set(key, []);
    activeByAsset.get(key).push(a);
  }
  const findings = [];
  for (const asset of assets) {
    const holders = activeByAsset.get(String(asset._id)) ?? [];
    const label = `${asset.assetTag} (${asset.name})`;
    if (holders.length > 1) {
      findings.push({
        category: 'assetMultipleHolders',
        severity: 'high',
        summary: `${label} has ${holders.length} Active assignments: ${holders.map((h) => h.employeeName).join(', ')}.`,
        targetType: 'Asset',
        targetId: asset._id,
        url: '/assets',
      });
    } else if (holders.length === 1) {
      const [holder] = holders;
      if (asset.status !== 'Assigned' || String(asset.currentEmployee) !== String(holder.employee)) {
        findings.push({
          category: 'assetHolderMismatch',
          severity: 'high',
          summary: `${label} is held by ${holder.employeeName} in the assignment history, but the asset itself says "${asset.status}"${asset.currentEmployee ? ' with a different holder' : ' with no holder'}.`,
          targetType: 'Asset',
          targetId: asset._id,
          url: '/assets',
        });
      }
    } else if (asset.status === 'Assigned') {
      findings.push({
        category: 'assetAssignedWithoutHolder',
        severity: 'medium',
        summary: `${label} is marked Assigned but has no Active assignment.`,
        targetType: 'Asset',
        targetId: asset._id,
        url: '/assets',
      });
    }
  }
  return findings;
}

/**
 * At most one requirement stage is "where a fully-mobilised card goes"
 * (partial unique index + service, V2-F08), and every card must sit in a stage
 * that still exists (deleting a stage refuses while cards are in it; a direct
 * database edit could still strand one).
 */
export async function requirementStageProblems() {
  const [stages, cardStageIds] = await Promise.all([
    RequirementStage.find({}).select('name isMobilisedStage').lean(),
    Requirement.distinct('stage'),
  ]);
  const findings = [];
  const flagged = stages.filter((st) => st.isMobilisedStage);
  if (flagged.length > 1) {
    findings.push({
      category: 'multipleMobilisedStages',
      severity: 'high',
      summary: `${flagged.length} stages are flagged as the fully-mobilised destination (${flagged.map((st) => st.name).join(', ')}), so a finished requirement has no single place to go.`,
      targetType: 'RequirementStage',
      targetId: flagged[0]._id,
      url: '/requirements',
    });
  }
  const known = new Set(stages.map((st) => String(st._id)));
  const missing = cardStageIds.filter((id) => !known.has(String(id)));
  if (missing.length) {
    const cards = await Requirement.find({ stage: { $in: missing } }).select('clientName jobTitle').lean();
    for (const card of cards) {
      findings.push({
        category: 'requirementMissingStage',
        severity: 'high',
        summary: `Requirement ${card.jobTitle ?? ''} for ${card.clientName ?? 'a client'} sits in a stage that no longer exists.`,
        targetType: 'Requirement',
        targetId: card._id,
        url: '/requirements',
      });
    }
  }
  return findings;
}

/**
 * Recorded client and subcontractor payments must be sane money: finite, whole
 * halalas, within the cap, and pointing at a party that still exists. The
 * validation added 2026-10-10 (V2-F04) keeps new bad ones out; this finds any
 * stored before it. Allocation is derived live and never stored, so the stored
 * payments are the only part of this ledger that can be wrong.
 */
export async function paymentLedgerProblems() {
  const [clientPayments, subPayments, clientIds, subIds] = await Promise.all([
    ClientPayment.find({}).select('client amount decisionStatus').lean(),
    SubcontractorPayment.find({}).select('subcontractor amount decisionStatus').lean(),
    Client.find({}).distinct('_id'),
    Subcontractor.find({}).distinct('_id'),
  ]);
  const clientsKnown = new Set(clientIds.map(String));
  const subsKnown = new Set(subIds.map(String));
  const findings = [];

  const check = (payment, partyKnown, kind) => {
    const problems = [];
    if (!Number.isFinite(payment.amount)) {
      problems.push('is not a valid number');
    } else {
      if (!isWholeHalala(payment.amount)) problems.push('has a fraction of a halala');
      if (payment.amount > MAX_PAYMENT) problems.push('is above the maximum allowed');
    }
    if (!partyKnown) problems.push(`belongs to a ${kind} that no longer exists`);
    if (!problems.length) return;
    const isClient = kind === 'client';
    findings.push({
      category: isClient ? 'clientPaymentInvalid' : 'subcontractorPaymentInvalid',
      severity: problems.length > 1 || !Number.isFinite(payment.amount) ? 'high' : 'medium',
      summary: `A ${kind} payment of ${payment.amount} (${payment.decisionStatus}) ${problems.join(' and ')}.`,
      targetType: isClient ? 'ClientPayment' : 'SubcontractorPayment',
      targetId: payment._id,
      url: isClient ? '/financial/payments-due' : '/financial/sub-payments-due',
    });
  };

  for (const p of clientPayments) check(p, clientsKnown.has(String(p.client)), 'client');
  for (const p of subPayments) check(p, subsKnown.has(String(p.subcontractor)), 'subcontractor');
  return findings;
}

/**
 * A month marked "invoiced by the subcontractor" must carry the invoice number
 * and date. Before 2026-10-10 the web form could mark one invoiced while
 * dropping both (V2-F01), and such an entry cannot be resubmitted — these are
 * the ones to correct by hand.
 */
export async function subcontractorInvoicesMissingDetails() {
  const deployments = await Deployment.find({ monthlyHours: { $elemMatch: { subcontractorInvoiceReceivedAt: { $ne: null } } } })
    .select('workerName subcontractorName monthlyHours')
    .lean();
  const findings = [];
  for (const d of deployments) {
    for (const entry of d.monthlyHours ?? []) {
      if (!entry.subcontractorInvoiceReceivedAt) continue;
      if (entry.subcontractorInvoiceNumber && entry.subcontractorInvoiceDate) continue;
      findings.push({
        category: 'subcontractorInvoiceIncomplete',
        severity: 'medium',
        summary: `${d.workerName} (${d.subcontractorName ?? 'subcontractor'}), ${entry.month}: marked invoiced but the invoice ${entry.subcontractorInvoiceNumber ? 'date' : 'number'} was never recorded.`,
        targetType: 'Deployment',
        targetId: d._id,
        url: `/deployments/${d._id}`,
      });
    }
  }
  return findings;
}
