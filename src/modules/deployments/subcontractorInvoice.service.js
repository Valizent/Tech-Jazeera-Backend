import Deployment from './deployment.model.js';
import Subcontractor from '../subcontractors/subcontractor.model.js';
import ApiError from '../../utils/ApiError.js';
import { logAudit } from '../audit/audit.service.js';
import { canAccessSection, getSectionAccess } from '../sectionAccess/sectionAccess.service.js';
import { notifyUser } from '../notifications/notification.service.js';
import { membersOfRoles } from '../approvals/approvalEngine.service.js';
import { computeMonthlyRevenueAndExpenses } from './deployment.service.js';
import { allocateSubcontractorPayments } from './subcontractorPayment.service.js';

function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function paymentTrackingAudience(mobilisation) {
  const mmSettings = await getSectionAccess('mobilisationsViewer');
  const coordinatorIds = (mobilisation?.coordinators ?? []).map((c) => c.user.toString());
  const mmIds = await membersOfRoles(mmSettings.writeApprovalRoles);
  return [...new Set([...coordinatorIds, ...mmIds.map((id) => id.toString())])];
}

function invoiceFileFromUpload(file) {
  if (!file) return undefined;
  return {
    fileName: file.filename,
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

export async function recordSubInvoice(deploymentId, entryId, data, file, actor) {
  const allowed = await canAccessSection('deploymentsInvoicing', actor);
  if (!allowed) throw new ApiError(403, 'You do not have permission to record a subcontractor invoice.');

  const deployment = await Deployment.findById(deploymentId).populate('subcontractor');
  if (!deployment) throw new ApiError(404, 'Deployment not found.');
  if (deployment.workerType !== 'SupplierEmployee') throw new ApiError(400, 'Not a subcontractor deployment.');

  const entry = deployment.monthlyHours.id(entryId);
  if (!entry) throw new ApiError(404, 'Monthly hours entry not found.');
  if (entry.status !== 'Approved') throw new ApiError(400, 'Only hours already approved can be invoiced.');
  if (entry.subcontractorInvoiceReceivedAt) throw new ApiError(400, 'This month has already been invoiced by the subcontractor.');

  if (data.invoiceNumber) {
    const existing = await Deployment.exists({
      archived: { $ne: true },
      'monthlyHours.subcontractorInvoiceNumber': data.invoiceNumber,
    });
    if (existing) {
      throw new ApiError(400, `Invoice number ${data.invoiceNumber} has already been used.`);
    }
  }

  const now = new Date();
  const subcontractorDoc = await Subcontractor.findById(deployment.subcontractor).lean();
  const dueDays = subcontractorDoc?.creditLimitDays ?? 30;
  const dueAt = new Date(now.getTime() + dueDays * 86_400_000);

  const updated = await Deployment.findOneAndUpdate(
    { _id: deploymentId, monthlyHours: { $elemMatch: { _id: entryId, status: 'Approved', subcontractorInvoiceReceivedAt: null } } },
    {
      $set: {
        'monthlyHours.$.subcontractorInvoiceReceivedAt': now,
        'monthlyHours.$.subcontractorInvoiceReceivedBy': actor.userId,
        'monthlyHours.$.subcontractorInvoiceDueAt': dueAt,
        'monthlyHours.$.subcontractorInvoiceNumber': data.invoiceNumber,
        'monthlyHours.$.subcontractorInvoiceDate': data.invoiceDate,
        'monthlyHours.$.subcontractorInvoiceFile': invoiceFileFromUpload(file),
      },
    },
    { new: true }
  ).populate('mobilisation');

  if (!updated) throw new ApiError(400, 'This month has already been invoiced.');

  const updatedEntry = updated.monthlyHours.id(entryId);

  await logAudit({
    user: actor.userId,
    action: 'deployment.monthlyHours.subcontractorInvoiceRecorded',
    targetType: 'Deployment',
    targetId: updated._id,
    meta: { month: updatedEntry.month, invoiceNumber: data.invoiceNumber },
    ip: actor.ip,
  });

  const audience = await paymentTrackingAudience(updated.mobilisation);
  await Promise.all(
    audience.map((userId) =>
      notifyUser(userId, {
        type: 'RequestStatus',
        title: `Subcontractor Invoice ${data.invoiceNumber} received for ${updated.workerName} (${updatedEntry.month})`,
        body: `Payment due by ${updatedEntry.subcontractorInvoiceDueAt.toDateString()}.`,
        url: '/financial/sub-payments-due',
      })
    )
  );

  return updated.toObject();
}

async function gatherSubcontractorInvoicedItems(subcontractorId) {
  const deployments = await Deployment.find({ subcontractor: subcontractorId, archived: { $ne: true } })
    .select('workerName subcontractorName monthlyHours mobilisation workerType worker')
    .populate('mobilisation')
    .populate('worker', 'salary')
    .lean();

  const items = [];
  for (const dep of deployments) {
    if (!dep.mobilisation) continue;
    for (const entry of dep.monthlyHours) {
      if (!entry.subcontractorInvoiceReceivedAt) continue;
      const result = computeMonthlyRevenueAndExpenses(entry, dep.mobilisation, dep.monthlyHours, dep.worker);
      if (!result) continue;
      
      // The invoice amount from the subcontractor should be their rate + their OT.
      // computeMonthlyRevenueAndExpenses exposes subContractorInvoiceAmount and otCalculations.
      const revenue = result.breakdown.subContractorInvoiceAmount + (result.breakdown.otCalculations ?? 0);

      items.push({
        deploymentId: dep._id,
        entryId: entry._id,
        workerName: dep.workerName,
        workerType: dep.workerType,
        subcontractorName: dep.subcontractorName,
        month: entry.month,
        invoiceNumber: entry.subcontractorInvoiceNumber,
        invoiceDate: entry.subcontractorInvoiceDate,
        invoiceFile: entry.subcontractorInvoiceFile,
        invoiceSentAt: entry.subcontractorInvoiceReceivedAt,
        invoiceDueAt: entry.subcontractorInvoiceDueAt,
        revenue, // Treating the subcontractor cost as "revenue" for the sake of the generic allocateSubcontractorPayments ledger function
        clientRevenue: result.revenue,
        expenses: result.expenses,
        profit: result.profit,
        breakdown: result.breakdown,
        // Rate fields
        clientRate: dep.mobilisation?.clientRate ?? null,
        clientCommission: dep.mobilisation?.clientCommission ?? null,
        subcontractorRate: dep.mobilisation?.subcontractorRate ?? null,
        subcontractorCommission: dep.mobilisation?.subcontractorCommission ?? null,
        fta: dep.mobilisation?.fta ?? null,
        allowance: dep.mobilisation?.allowance ?? null,
        mobilisationCost: dep.mobilisation?.mobilisationCost ?? null,
        contractHours: entry.contractHours,
        actualHours: entry.actualHours,
        supplierHours: entry.supplierHours,
        otHours: entry.otHours,
        deductionAmount: entry.deductionAmount ?? 0,
        supplierDeductionNote: entry.supplierDeductionNote ?? null,
      });
    }
  }
  return items;
}

export async function getSubcontractorAllocation(subcontractorId) {
  const items = await gatherSubcontractorInvoicedItems(subcontractorId);
  return allocateSubcontractorPayments(subcontractorId, items);
}

export async function getSubcontractorsPaymentSummary(actor) {
  const canViewAll = await canAccessSection('mobilisationsViewer', actor, 'read');

  const deployments = await Deployment.find({
    archived: { $ne: true },
    workerType: 'SupplierEmployee',
    monthlyHours: { $elemMatch: { subcontractorInvoiceReceivedAt: { $ne: null } } },
  })
    .select('subcontractor subcontractorName mobilisation')
    .populate('mobilisation', 'coordinators')
    .lean();

  const bySub = new Map();
  for (const dep of deployments) {
    if (!dep.mobilisation || !dep.subcontractor) continue;
    const isMine = dep.mobilisation.coordinators?.some((c) => c.user.toString() === actor.userId.toString());
    if (!canViewAll && !isMine) continue;
    const key = dep.subcontractor.toString();
    if (!bySub.has(key)) bySub.set(key, { subcontractorId: dep.subcontractor, subcontractorName: dep.subcontractorName });
  }

  const rows = (
    await Promise.all(
      [...bySub.values()].map(async (info) => {
        const { perEntry } = await getSubcontractorAllocation(info.subcontractorId);
        const outstanding = perEntry.filter((e) => e.balanceDue > 0);
        if (outstanding.length === 0) return null;
        const oldestDueAt = outstanding.reduce(
          (min, e) => (!min || new Date(e.invoiceDueAt) < new Date(min) ? e.invoiceDueAt : min),
          null
        );
        return {
          subcontractorId: info.subcontractorId,
          subcontractorName: info.subcontractorName,
          totalOutstanding: money(outstanding.reduce((sum, e) => sum + e.balanceDue, 0)),
          outstandingCount: outstanding.length,
          oldestDueAt,
          daysRemaining: oldestDueAt ? Math.ceil((new Date(oldestDueAt).getTime() - Date.now()) / 86_400_000) : null,
        };
      })
    )
  ).filter(Boolean);
  return rows.sort((a, b) => (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity));
}

export async function getPaidSubInvoices(actor) {
  const canViewAll = await canAccessSection('mobilisationsViewer', actor, 'read');

  const deployments = await Deployment.find({
    archived: { $ne: true },
    workerType: 'SupplierEmployee',
    monthlyHours: { $elemMatch: { subcontractorInvoiceReceivedAt: { $ne: null } } },
  })
    .select('subcontractor subcontractorName mobilisation workerName')
    .populate('mobilisation', 'coordinators')
    .lean();

  const bySub = new Map();
  for (const dep of deployments) {
    if (!dep.mobilisation || !dep.subcontractor) continue;
    const isMine = dep.mobilisation.coordinators?.some((c) => c.user.toString() === actor.userId.toString());
    if (!canViewAll && !isMine) continue;
    const key = dep.subcontractor.toString();
    if (!bySub.has(key)) bySub.set(key, { subcontractorId: dep.subcontractor, subcontractorName: dep.subcontractorName });
  }

  const paidInvoices = (
    await Promise.all(
      [...bySub.values()].map(async (info) => {
        const { perEntry } = await getSubcontractorAllocation(info.subcontractorId);
        const paid = perEntry.filter((e) => e.amountAllocated > 0);
        const rows = [];
        for (const p of paid) {
          const { payments, ...invoiceFields } = p;
          for (const payment of payments) {
            rows.push({
              subcontractorName: info.subcontractorName,
              ...invoiceFields,
              rowId: `${p.entryId}-${payment.paymentId}`,
              amountAllocated: payment.amount,
              balanceDue: payment.runningBalance,
              fullyPaid: payment.runningBalance <= 0,
              paymentId: payment.paymentId,
              paymentDate: payment.paymentDate,
              paymentReference: payment.paymentReference,
            });
          }
        }
        return rows;
      })
    )
  ).flat();

  return paidInvoices.sort((a, b) => {
    const dateA = a.paymentDate ? new Date(a.paymentDate).getTime() : 0;
    const dateB = b.paymentDate ? new Date(b.paymentDate).getTime() : 0;
    if (dateA !== dateB) return dateB - dateA;
    return a.subcontractorName.localeCompare(b.subcontractorName);
  });
}

export async function getSubcontractorPaymentDetail(subcontractorId, actor) {
  const canViewAll = await canAccessSection('mobilisationsViewer', actor, 'read');
  if (!canViewAll) {
    // Without global read, only someone coordinating at least one of this
    // subcontractor's deployments — the same rule as getClientPaymentDetail.
    // (Fixed 2026-10-08: this used Deployment.exists(...).populate(...), and
    // exists() ignores populate's match, so ANY deployment at the
    // subcontractor let any staff login see its whole ledger.)
    const deployments = await Deployment.find({ subcontractor: subcontractorId, archived: { $ne: true } })
      .select('mobilisation')
      .populate('mobilisation', 'coordinators')
      .lean();
    const isMine = deployments.some((dep) => dep.mobilisation?.coordinators?.some((c) => c.user.toString() === actor.userId.toString()));
    if (!isMine) throw new ApiError(403, 'You do not have permission to view this subcontractor.');
  }

  const subcontractor = await Subcontractor.findById(subcontractorId).select('name').lean();
  if (!subcontractor) throw new ApiError(404, 'Subcontractor not found.');

  const allocation = await getSubcontractorAllocation(subcontractorId);
  const { getSubcontractorPaymentHistory } = await import('./subcontractorPayment.service.js');
  const history = await getSubcontractorPaymentHistory(subcontractorId);

  return {
    subcontractorId: subcontractor._id,
    subcontractorName: subcontractor.name,
    invoices: allocation.perEntry,
    creditBalance: allocation.creditBalance,
    payments: history,
  };
}

export async function getReadyForSubInvoice(actor) {
  const allowed =
    (await canAccessSection('deploymentsInvoicing', actor, 'read')) ||
    (await canAccessSection('mobilisationsViewer', actor, 'read'));
  if (!allowed) return [];

  const deployments = await Deployment.find({
    archived: { $ne: true },
    workerType: 'SupplierEmployee',
    monthlyHours: { $elemMatch: { status: 'Approved', subcontractorInvoiceReceivedAt: null } },
  })
    .select('workerName clientName subcontractorName mobilisation monthlyHours workerType worker')
    .populate('mobilisation')
    .populate('worker', 'salary')
    .lean();

  const rows = [];
  for (const dep of deployments) {
    for (const entry of dep.monthlyHours) {
      if (entry.status !== 'Approved' || entry.subcontractorInvoiceReceivedAt) continue;
      
      const revExp = computeMonthlyRevenueAndExpenses(entry, dep.mobilisation, dep.monthlyHours, dep.worker);
      const invoiceAmount = revExp ? revExp.breakdown.subContractorInvoiceAmount + (revExp.breakdown.otCalculations ?? 0) : null;
      
      rows.push({
        deploymentId: dep._id,
        entryId: entry._id,
        mobilisationSerial: dep.mobilisation?.serialNumber,
        workerName: dep.workerName,
        workerType: dep.workerType,
        subcontractorName: dep.subcontractorName,
        clientName: dep.clientName,
        month: entry.month,
        actualHours: entry.actualHours,
        supplierHours: entry.supplierHours,
        otHours: entry.otHours,
        hoursApprovedAt: entry.decidedAt,
        invoiceAmount,
        clientRevenue: revExp ? revExp.revenue : null,
        expenses: revExp ? revExp.expenses : null,
        profit: revExp ? revExp.profit : null,
        breakdown: revExp ? revExp.breakdown : null,
        // Rate fields
        clientRate: dep.mobilisation?.clientRate ?? null,
        clientCommission: dep.mobilisation?.clientCommission ?? null,
        subcontractorRate: dep.mobilisation?.subcontractorRate ?? null,
        subcontractorCommission: dep.mobilisation?.subcontractorCommission ?? null,
        fta: dep.mobilisation?.fta ?? null,
        allowance: dep.mobilisation?.allowance ?? null,
        mobilisationCost: dep.mobilisation?.mobilisationCost ?? null,
        deductionAmount: entry.deductionAmount ?? 0,
        supplierDeductionNote: entry.supplierDeductionNote ?? null,
      });
    }
  }

  return rows.sort((a, b) => new Date(a.hoursApprovedAt) - new Date(b.hoursApprovedAt));
}
