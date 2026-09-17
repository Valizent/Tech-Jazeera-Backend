# 13 September 2026 QA/security audit — full remediation

A professionally-formatted QA/security audit report (dated 13 September
2026, distinct from the earlier [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md)
from 9 August) covered Security (S1–S4), Auth/Permission Gaps (A1–A6),
Functional Bugs (F1–F10), and Dead Code/Drift (D1–D3), each with file:line
citations, repro steps, and suggested fixes. Before fixing anything, 8 of
the highest-severity claims were independently re-verified against the
actual source (not taken on trust) — all 8 held up exactly as described,
including F10, a bug in this app's own prior-session work. The user then
said "fix everything." All 22 findings are now fixed; the six highest-risk
ones (three concurrency races, a compensating-transaction rollback, and two
authorization gaps) were additionally verified with real script-based
tests against the dev database, not just read-through.

## Security (S1–S4)

- **S1 — commercial OT amount leaked to non-deciders.** `deployment.service.js`'s
  `addMonthlyHours`/`updateMonthlyHours` now strip `otAmount` from the
  response for anyone without `deploymentsHoursDecide` access, via a new
  `stripCommercialMonthlyHours` helper — the same treatment `profit` already
  had.
- **S2 — a password reset only revoked refresh sessions, not the still-valid
  access token already issued.** `User.passwordChangedAt` (new field) is
  set on every password change/reset path (self-service, Admin-initiated
  staff/Worker reset, `seed-admin.js`); `requireAuth` now rejects any access
  token whose `iat` predates it. **Verified live**: logged in, changed
  password, confirmed the old token 401s immediately and the old password
  no longer authenticates — see [Verification](#verification).
- **S3 — regex injection via unescaped user input in Job Titles search.**
  Added the same `escapeRegex` helper already used everywhere else in this
  codebase.
- **S4 — a nested Mongoose `CastError` inside a `ValidationError`'s details
  array leaked an unsanitized internal message.** `errorHandler.js` now
  sanitizes it the same way the top-level error already was.

## Auth/Permission gaps (A1–A6)

- **A1 — a deactivated Approval Role kept deciding.** Six membership-check
  call sites (`approvals.service.js`, `approvalEngine.service.js`,
  `mobilisation.service.js`) were missing `isActive: true` on their
  `ApprovalRole` query. **Verified live**: created a role, confirmed it
  authorized a decision, deactivated it, confirmed the exact same check
  (`resolveStepAuthority`, `isMemberOfAnyRole`, `isApprovalRoleMember`,
  `membersOfRoles`) now refuses/excludes it — see
  [Verification](#verification).
- **A2 — Coordinator team-scoping missing on Attendance bulk-mark/adjust and
  the Timesheets monthly report.** New shared `assertEmployeesInCoordinatorTeam`
  (`attendance.service.js`), wired into both.
- **A3 — the same gap across Documents/Assets/EOSB/Deployment single-record
  reads.** New shared `assertEmployeeVisibleToActor` (`employee.service.js`),
  wired into `listDocuments`/`getDocument`/`resolveFile`,
  `assignAsset`/`getAsset`/`listEmployeeAssignments`,
  `listSettlements`/`getSettlement`, `getDeployment`. **A2 and A3 verified
  live together**: a real Employee owned by one Coordinator vs. another —
  confirmed the owning Coordinator passes and the other is refused, on both
  the single-record and batch helper, and that a non-Coordinator actor is
  correctly never scoped — see [Verification](#verification).
- **A4 — `GET /roles` and `/workflows` under-restricted to `requireStaff`
  (including Worker/Staff logins).** Moved to `requireStaffOrExecutive`.
- **A5 — six client pages hardcoded `isAdmin` instead of reading the real
  Section Access grant** (NFC's 5 pages, Audit Log, Timesheet Processor).
  Converted to real `canRead`/`canWrite` derived from
  `sectionAccess`/`sectionAccessWrite`.
- **A6 — Financial Requests' list/decide didn't actually gate on
  `financialRequests` write access**, only on the workflow engine's own
  per-step check. Both now AND the engine result with a real
  `canAccessSection('financialRequests', actor, 'write')` check.

## Functional bugs (F1–F10)

- **F1 — two concurrent payments/repayments could both pass a stale
  in-memory balance check and overpay.** `invoice.service.js`'s
  `recordPayment` and `advance.service.js`'s `addRepayment` rewritten as
  atomic `findOneAndUpdate` (aggregation-pipeline update; the SalaryAdvance
  side uses `$expr` to re-sum the live `repayments` array at match time,
  since its balance isn't separately persisted). **Verified live**: fired
  two concurrent 700-against-1000 payments/repayments at each — exactly one
  won, the loser got a real 409/400, and the final balance was correct, not
  overpaid — see [Verification](#verification).
- **F2 — two concurrent monthly-hours submissions for the same month could
  both pass a stale `.some()` check and create a duplicate entry.**
  `deployment.service.js`'s `addMonthlyHours` rewritten as an atomic
  `findOneAndUpdate({ 'monthlyHours.month': { $ne: month } }, { $push })`.
  **Verified live**: fired two concurrent submissions for the same month —
  exactly one won, exactly one entry exists for that month.
- **F3 — a deployment-creation failure after a Mobilisation was already
  marked `Approved` left it permanently stuck** (no Deployment, no normal
  retry path). `approveMobilisation` now wraps deployment creation in
  try/catch with a compensating rollback (status back to `PendingReview`,
  trail entry popped, decision fields cleared) instead of a true
  cross-collection transaction — a deliberate choice over refactoring the
  shared `decideApprovalStep` engine (7 consumers) just for this one
  caller's guarantee. **Verified live**: forced a real deployment-creation
  failure (a decoy Deployment pre-occupying the unique `mobilisation` index
  slot, triggering the actual E11000 path) — confirmed the mobilisation
  reverted to `PendingReview` with no duplicate/orphan Deployment — see
  [Verification](#verification).
- **F4 — the cross-mobilisation date-overlap check was mathematically
  incomplete** for an open-ended new placement. `assertNoDateOverlap`
  simplified to `end === null || proposed < end`.
- **F5 — an Ended deployment could never have its own final, partial
  month's hours entered** if that month hadn't been entered before the
  deployment ended. The status gate now allows a month within the
  deployment's actual active range through `endDate`'s own month.
- **F6 — Attendance validation accepted an impossible calendar date and an
  unbounded adjustment duration.** `dateOnly` gained a real-calendar-date
  refine; `adjustAttendanceSchema` gained a 24-hour max-duration refine.
- **F7 — several money/rate fields had no upper bound**, letting an
  overflow value produce non-finite downstream figures. Capped
  `deductionAmount`, advance/reimbursement amounts, and payroll deduction
  lines.
- **F8 — `.partial()` on an update schema doesn't strip a field's
  `.default()`**, so omitting a field on a PATCH could silently reset it to
  a create-time default. Fixed on Clients/Subcontractors/Quotations'
  update schemas with the same `.partial().extend({...})` pattern already
  established for Employee.
- **F9 — `findByIdAndUpdate(..., { runValidators: true })` doesn't reliably
  expose the full merged document to a conditional `required` validator.**
  `updateEmployee` rewritten as fetch + `Object.assign` + `.save()`.
- **F10 — this app's own prior-session bug**: the Timesheets Monthly Report
  picked its data source off `Employee.type === 'Own'` instead of the
  linked login's actual role, so a `Staff`-type login with an `'Own'`
  employee type read the wrong attendance collection. Now branches on the
  linked User's role directly.

## Dead code/drift (D1–D3)

- **D1** — Timesheet/SalaryAdvance/Reimbursement have supported real
  ApprovalWorkflows for a while but were never added to the Approval Log's
  `LOG_SOURCES` map. Added (Mobilisation deliberately still excluded — its
  `coordinators` are Users directly, not an `employee` ref, so the shared
  query shape doesn't apply without its own pass; a pre-existing, documented
  deferral, not a new gap).
- **D2** — 7 confirmed-unused exports removed, each re-verified via a fresh
  whole-codebase grep before deletion (not taken on the audit's word alone):
  `listAssignmentsSchema` (asset.validation.js), `DEPLOYMENT_SHIFTS`
  (deployment.model.js), `ACCEPTED_EXTENSIONS` (timesheet.constants.js),
  `useActiveTab` (Tabs.jsx — its now-unused `useContext` import was also
  removed), `emptyCommercialDetailsForm` (mobilisations.schema.js),
  `listNfcBatches` (nfc.api.js), `COORDINATOR_ROLE` (constants.js).
- **D3** — 6 stale code comments corrected to match current behavior:
  - `timesheet.service.js` — "no Payroll consumer yet" was stale; Payroll's
    P3-E overtime figure has read Approved Timesheets for a while, so a
    post-approval Attendance edit can now silently drift from what was
    already paid (the underlying lock-gap limitation is still real and
    still documented, just the "nobody reads this" framing was wrong).
  - `mobilisation.validation.js` (×2) — the "every `ot*` field is absent
    from this schema" doc comment was stale since the 2026-09-13 move of
    `otClientRate`/`otClientCommission`/`otSubcontractorRate`/
    `otSubcontractorCommission` into Section 1; and the "`client` stays
    required even on an edit" comment was simply wrong — `.partial()`
    makes every field optional on `updateMobilisationSchema`, `client`
    included.
  - `deployment.service.js` — "Office Secretary isn't a grantable Section
    Access role at all" was stale since the 2026-09-13 "full staff floor"
    change; she can now be granted `deploymentsHours` like anyone else, the
    hardcoded bypass is a standing convenience on top of that, not the only
    path in.
  - `AuditLogPage.jsx` — already accurate (fixed as part of this same pass's
    A5 edit to this file).
  - `timesheet.routes.js` — the comment described a code-level default role
    list (`['Manager','HR','Accounts','Coordinator','Executive']`) that no
    longer exists since Section Access grants moved to ApprovalRole-only;
    corrected to point at the real source of truth (the Section Access
    admin page/DB) instead of a stale hardcoded list.

## Verification

Beyond `node --check` on every touched server file and a clean `npm run
build` on the client, the six highest-technical-risk fixes (the ones
rewriting MongoDB update syntax or a multi-step rollback, where a subtle
bug would only show up under real concurrency or a real failure) were
exercised with a throwaway script against the real dev database — not just
read-through:

```
PASS — F1a Invoice.recordPayment race         :: winners=1 losers=1, balance correct
PASS — F1b SalaryAdvance.addRepayment race     :: winners=1 losers=1, balance correct
PASS — F2  Deployment.addMonthlyHours race     :: winners=1 losers=1, one entry for the month
PASS — F3  Mobilisation compensating rollback  :: reverted to PendingReview, no orphan Deployment
PASS — A1  deactivated ApprovalRole            :: authority revoked on all 4 call sites
PASS — A2/A3 Coordinator team-scoping          :: in-team passes, out-of-team blocked, non-Coordinator unscoped
```

S2 (old access token rejected after a password reset) was verified as a
real end-to-end HTTP flow: logged in, hit an authenticated route (200),
changed password, retried the SAME old token (401, "Session expired or
invalid"), confirmed the old password no longer authenticates, confirmed
the new password + new token both work.

Every throwaway fixture (a QA admin login, invoices, advances, deployments,
mobilisations, clients, employees, approval roles) created for this
verification pass was deleted immediately afterward — none of it is in the
real database.

## Accepted limitations, unchanged by this pass

- Mobilisation stays out of the Approval Log (D1) — a real, pre-existing,
  documented deferral, not something this pass was asked to close.
- F3's compensating-rollback approach (not a true cross-collection
  transaction) means a losing reviewer sees a generic 500 and must retry
  the approval — accepted as the lower-risk fix given `decideApprovalStep`
  is shared by 7 request types.
- Timesheet's post-approval Attendance-edit lock gap (flagged more
  accurately by the D3 comment fix above) is unchanged — still deferred
  until Payroll's overtime consumption makes it a real financial
  correctness issue, per `docs/P2-M3b-notes.md`'s original reasoning.
