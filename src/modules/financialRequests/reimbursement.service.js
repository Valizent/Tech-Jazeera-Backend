/**
 * Reimbursement claim service — submit (with a receipt), decide, mark paid,
 * and resolve the receipt file for download.
 */
import Employee from '../employees/employee.model.js';
import ReimbursementClaim from './reimbursement.model.js';
import ApiError from '../../utils/ApiError.js';
import { signedDownloadUrl, destroyDocumentFile } from '../../middleware/upload.js';
import { logAudit } from '../audit/audit.service.js';
import { notifyEmployeeUser } from '../notifications/notification.service.js';
import { resolveApprovalWorkflow } from '../approvals/approvals.service.js';
import { decideApprovalStep, annotateCanDecide, notifySubmission } from '../approvals/approvalEngine.service.js';
import { canAccessSection } from '../sectionAccess/sectionAccess.service.js';

/** The ORIGINAL decide-route role gate for a ReimbursementClaim — preserved
 *  exactly as the authorization used whenever no ApprovalWorkflow governs a
 *  request (see approvalEngine.service.js's legacy path). */
const LEGACY_DECIDE_ROLES = ['Admin', 'Manager', 'HR'];

/** Shared by submitReimbursement (notifySubmission) and decideReimbursement
 *  (buildStepNotification) so the text can't drift between them. */
function buildReimbursementStepNotification() {
  return {
    type: 'RequestStatus',
    title: 'A reimbursement claim needs your approval',
    url: '/financial-requests',
  };
}

function receiptFromFile(file) {
  return {
    fileName: file.filename, // Cloudinary public_id, set by uploadSingle
    resourceType: 'raw',
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

export async function submitReimbursement(employeeId, data, file, actor) {
  if (!file) throw new ApiError(400, 'A receipt file is required.');
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new ApiError(404, 'Employee not found.');

  // Unlike Leave, every reimbursement claim needs a real decision (no
  // auto-approval concept here) — the workflow, if any, is resolved
  // unconditionally at submission.
  let workflowFields = {};
  const workflow = await resolveApprovalWorkflow(employee, 'Reimbursement');
  if (workflow) {
    workflowFields = { workflow: workflow._id, workflowName: workflow.name, steps: workflow.steps, currentStep: 0 };
  }

  const claim = await ReimbursementClaim.create({
    employee: employeeId,
    ...data,
    receipt: receiptFromFile(file),
    ...workflowFields,
  });
  await logAudit({
    user: actor.userId,
    action: 'reimbursement.submit',
    targetType: 'ReimbursementClaim',
    targetId: claim._id,
    meta: { employeeId: employee.employeeId, category: data.category, amount: data.amount },
    ip: actor.ip,
  });
  const plain = claim.toObject();
  await notifySubmission(plain, buildReimbursementStepNotification, LEGACY_DECIDE_ROLES);
  return plain;
}

export async function listOwnReimbursements(employeeId, { page, limit, status }) {
  const filter = { employee: employeeId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    ReimbursementClaim.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ReimbursementClaim.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** A receipt file for its OWN claimant only — used by the /api/me route. */
export async function getMyReceiptFile(employeeId, id) {
  const claim = await ReimbursementClaim.findById(id).lean();
  if (!claim || claim.employee.toString() !== employeeId) {
    throw new ApiError(404, 'Reimbursement claim not found.');
  }
  return resolveReceipt(claim);
}

/** A receipt file for staff review — any claim. */
export async function getReceiptFile(id) {
  const claim = await ReimbursementClaim.findById(id).lean();
  if (!claim) throw new ApiError(404, 'Reimbursement claim not found.');
  return resolveReceipt(claim);
}

function resolveReceipt(claim) {
  return {
    url: signedDownloadUrl(claim.receipt.fileName, claim.receipt.resourceType),
    mimeType: claim.receipt.mimeType,
    originalName: claim.receipt.originalName,
  };
}

export async function cancelReimbursement(employeeId, id, actor) {
  const claim = await ReimbursementClaim.findById(id);
  if (!claim) throw new ApiError(404, 'Reimbursement claim not found.');
  if (claim.employee.toString() !== employeeId) {
    throw new ApiError(403, 'You can only cancel your own reimbursement claims.');
  }
  if (claim.status !== 'Pending') throw new ApiError(400, 'Only a pending claim can be cancelled.');

  await destroyDocumentFile(claim.receipt.fileName, claim.receipt.resourceType).catch(() => {});
  await claim.deleteOne();
  await logAudit({
    user: actor.userId,
    action: 'reimbursement.cancel',
    targetType: 'ReimbursementClaim',
    targetId: claim._id,
    ip: actor.ip,
  });
}

/**
 * Staff review queue. Coordinator is NOT part of the financial-requests
 * review circle (unlike Leave) — now that Coordinators can self-submit
 * (P2-M4+), they may see this list too, but scoped to ONLY their own
 * claims — never the company-wide view the original 4 reviewer roles get.
 */
export async function listReimbursements({ page, limit, status, employee }, actor) {
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;

  if (actor?.role === 'Coordinator') {
    if (employee && employee !== actor.employee) {
      throw new ApiError(403, 'You do not have access to this employee.');
    }
    filter.employee = actor.employee;
  }

  const [rawItems, total] = await Promise.all([
    ReimbursementClaim.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('employee', 'fullName employeeId')
      .populate('steps.roles', 'name')
      .populate('approvalTrail.approvalRole', 'name')
      .populate('approvalTrail.approvedBy', 'name role')
      .lean(),
    ReimbursementClaim.countDocuments(filter),
  ]);
  let items = rawItems;
  if (actor) {
    items = await annotateCanDecide(rawItems, actor, { pendingStatus: 'Pending', legacyAllowedRoles: LEGACY_DECIDE_ROLES });
    // Same real-gate intersection as advance.service.js's listAdvances —
    // see its own comment for why (2026-09-14, a real QA-audit-found gap).
    const hasSectionWrite = await canAccessSection('financialRequests', actor, 'write');
    items = items.map((item) => ({ ...item, canDecideCurrentStep: item.canDecideCurrentStep && hasSectionWrite }));
  }
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export async function decideReimbursement(id, { status, decisionNote }, actor) {
  return decideApprovalStep({
    Model: ReimbursementClaim,
    id,
    decision: status,
    note: decisionNote,
    actor,
    pendingStatus: 'Pending',
    legacyAllowedRoles: LEGACY_DECIDE_ROLES,
    notFoundMessage: 'Reimbursement claim not found.',
    auditAction: 'reimbursement',
    buildFinalNotification: (doc) => ({
      type: 'RequestStatus',
      title: `Reimbursement claim ${doc.status.toLowerCase()}`,
      body: doc.decisionNote || undefined,
      url: (role) => (role === 'Worker' ? '/me/requests' : '/financial-requests'),
    }),
    buildStepNotification: buildReimbursementStepNotification,
  });
}

export async function markReimbursementPaid(id, actor) {
  const claim = await ReimbursementClaim.findById(id);
  if (!claim) throw new ApiError(404, 'Reimbursement claim not found.');
  if (claim.status !== 'Approved') throw new ApiError(400, 'Only an approved claim can be marked paid.');

  claim.status = 'Paid';
  claim.paidAt = new Date();
  claim.paidBy = actor.userId;
  await claim.save();

  await logAudit({
    user: actor.userId,
    action: 'reimbursement.paid',
    targetType: 'ReimbursementClaim',
    targetId: claim._id,
    meta: { amount: claim.amount },
    ip: actor.ip,
  });
  await notifyEmployeeUser(claim.employee, {
    type: 'RequestStatus',
    title: 'Reimbursement claim paid',
    body: `SAR ${claim.amount} for ${claim.category.toLowerCase()}.`,
    url: '/me/requests',
  });
  return claim.toObject();
}
