# 2026-10-14: Employees approval hierarchy (per employee, per module)

- `Employee.approvalOverrides: [{ requestType, workflow }]` replaces the single `Employee.approvalWorkflow`. A module with no entry uses the company default (and its department route). `resolveApprovalWorkflow(employee, type)` reads the entry for that type; an inactive workflow falls through to the default.
- Employee-filed modules (`EMPLOYEE_APPROVAL_TYPES`): Leave, SalaryAdvance, Reimbursement, Timesheet, ExitReentry, Certificate, AnnualVacation. Mobilisation and the deployment/client approvals are not tied to one employee.
- `GET /api/approvals/employees?search&page&limit` (Read on approvalHierarchy) and `PUT /api/approvals/employees/:id/override { requestType, workflow|null }` (Write). Audited as `employee.approvalOverride`.
- `migrateLegacyEmployeeOverrides()` runs at boot, idempotent: an employee with the old single override gets one entry per module (the old override applied to every module they filed), then the old field is removed.
- Web: Approval Hierarchy > Employees (table + a dialog with one select per module). Phone: the same, as a tab with a bottom sheet. The employee form no longer has an override select.

## 2026-10-14: stages everywhere (done)
- Own-request lists (leave, advances, reimbursements, exit re-entry, certificates, timesheets, annual vacation) populate `steps.roles`, `approvalTrail.approvalRole` and `approvalTrail.approvedBy` through `withApprovalTrail()` (approvalEngine.service.js).
- `ApprovalTrailView` (web + phone) shows one muted line for a request with no workflow ("Single review step") instead of nothing, and the role names for an unlabelled step. Added to the ESS lists; the review panels/queues already used it.
- Timesheets: the approval flow exists on the server, but the web has no timesheet submit/review list to attach it to (the processor replaced it), so nothing to show there.
## 2026-10-14: five more decisions on the engine (done)
- New `APPROVAL_REQUEST_TYPES`: `ClientApproval`, `ClientPayment`, `SubcontractorPayment`, `MonthlyHours`, `SubcontractorTransfer`. None is tied to one employee, so none has a per-employee override (`EMPLOYEE_APPROVAL_TYPES` is unchanged).
- Engine (`decideApprovalStep` / `annotateCanDecide`): new `statusField` (a client keeps its status in `approvalStatus`, a payment in `decisionStatus`), `subdocument { path, id }` (one monthly-hours entry on a deployment), `authorizeLegacy` (the original rule is a Section Access grant, not a role list) and `legacyCanDecide`. Existing callers are unchanged.
- Each model carries `approvalFields()` (approvals/approvalFields.js): workflow, workflowName, steps, currentStep, approvalTrail. A request starts on the hierarchy in force when it is raised (`startApproval(type)`); a resubmission (a coordinator re-saving a rejected client, a rejected month edited, a transfer re-pointed) restarts from step one.
- Rules with no hierarchy: Client = Admin or the coordinator's manager; payments = 'deploymentsPaymentDecide'; hours = 'deploymentsHoursDecide'; transfer = the Mobilisation final-step roles. Everything stays decided atomically (a lost race answers 409; the payments and hours used to answer 400 for "already decided").
- Audit actions are now the engine's (`client.approved`, `clientPayment.approved`, `deployment.monthlyHours.step_approved`...), not the old `.decide` / `.approve` names.
- "Waiting on you": payments, client approvals and hours count only requests on a hierarchy (nothing changes before one exists); transfers count per current step.
- Approval Log: every item carries `subject` / `subjectRef` (employee name + ID, or client / worker / payment amount) and a normalised `status`.
