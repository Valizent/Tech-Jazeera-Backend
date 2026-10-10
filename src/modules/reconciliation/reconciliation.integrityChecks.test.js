/**
 * reconciliation.integrityChecks.test.js — each detector finds the exact
 * inconsistency it exists for, and stays quiet on consistent data.
 */
import mongoose from 'mongoose';
import Asset from '../assets/asset.model.js';
import AssetAssignment from '../assets/assetAssignment.model.js';
import RequirementStage from '../requirements/requirementStage.model.js';
import ClientPayment from '../deployments/clientPayment.model.js';
import SubcontractorPayment from '../deployments/subcontractorPayment.model.js';
import Deployment from '../deployments/deployment.model.js';
import {
  assetHolderInconsistencies,
  requirementStageProblems,
  paymentLedgerProblems,
  subcontractorInvoicesMissingDetails,
} from './reconciliation.integrityChecks.js';

const oid = () => new mongoose.Types.ObjectId();
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const categories = (findings) => findings.map((f) => f.category).sort();

async function makeAsset(extra = {}) {
  return Asset.create({ assetTag: `T-${unique()}`, name: 'Laptop', category: 'Laptop', ...extra });
}

describe('assetHolderInconsistencies', () => {
  it('is quiet for a consistent asset and finds the three kinds of drift', async () => {
    const holder = oid();
    const consistent = await makeAsset({ status: 'Assigned', currentEmployee: holder });
    await AssetAssignment.create({ asset: consistent._id, assetTag: consistent.assetTag, assetName: 'Laptop', employee: holder, employeeName: 'A', assignedAt: new Date(), status: 'Active' });
    await makeAsset({ status: 'Available' });
    expect(await assetHolderInconsistencies()).toEqual([]);

    // Active assignment, but the asset says Available (the V2-F05 outcome).
    const freed = await makeAsset({ status: 'Available' });
    await AssetAssignment.create({ asset: freed._id, assetTag: freed.assetTag, assetName: 'Laptop', employee: oid(), employeeName: 'B', assignedAt: new Date(), status: 'Active' });
    // Marked Assigned with nobody holding it.
    await makeAsset({ status: 'Assigned', currentEmployee: oid() });

    expect(categories(await assetHolderInconsistencies())).toEqual(['assetAssignedWithoutHolder', 'assetHolderMismatch']);
  });
});

describe('requirementStageProblems', () => {
  it('finds two flagged mobilised stages', async () => {
    await RequirementStage.collection.dropIndexes();
    await RequirementStage.create({ name: `A ${unique()}`, order: 0, isMobilisedStage: true });
    await RequirementStage.create({ name: `B ${unique()}`, order: 1, isMobilisedStage: true });
    expect(categories(await requirementStageProblems())).toEqual(['multipleMobilisedStages']);
  });

  it('is quiet with a single flagged stage', async () => {
    await RequirementStage.create({ name: `Only ${unique()}`, order: 0, isMobilisedStage: true });
    expect(await requirementStageProblems()).toEqual([]);
  });
});

describe('paymentLedgerProblems', () => {
  it('flags a fractional-halala payment and a payment whose party is gone, not a clean one', async () => {
    const insert = (Model, doc) => Model.collection.insertOne({ recordedBy: oid(), recordedAt: new Date(), decisionStatus: 'Approved', ...doc });
    await insert(ClientPayment, { client: oid(), amount: 0.011 });
    await insert(SubcontractorPayment, { subcontractor: oid(), amount: 100 });

    const findings = await paymentLedgerProblems();
    expect(categories(findings)).toEqual(['clientPaymentInvalid', 'subcontractorPaymentInvalid']);
    // The client one has both problems (fraction + missing client) so it is high.
    expect(findings.find((f) => f.category === 'clientPaymentInvalid').severity).toBe('high');
  });
});

describe('subcontractorInvoicesMissingDetails', () => {
  it('finds a month marked invoiced with no number or date', async () => {
    await Deployment.collection.insertOne({
      workerName: 'Test Worker',
      subcontractorName: 'Sub Co',
      monthlyHours: [
        { month: '2026-08', subcontractorInvoiceReceivedAt: new Date(), subcontractorInvoiceNumber: null, subcontractorInvoiceDate: null },
        { month: '2026-09', subcontractorInvoiceReceivedAt: new Date(), subcontractorInvoiceNumber: 'S-1', subcontractorInvoiceDate: new Date() },
        { month: '2026-10', subcontractorInvoiceReceivedAt: null },
      ],
    });
    const findings = await subcontractorInvoicesMissingDetails();
    expect(findings).toHaveLength(1);
    expect(findings[0].summary).toContain('2026-08');
  });
});
