# Mobilisation module

A new commercial+staffing record for placing a worker with a client
(optionally routed through a subcontractor) — the sheet coordinators
currently keep in Excel. Distinct from the existing `Deployment` record,
which only tracks worker↔client↔site with no billing data.

Full design in `docs/APPROVAL-HIERARCHY-notes.md`'s sibling plan (not yet
promoted to a notes file of its own name at planning time) — see the
in-session plan for the complete field list, workflow, and 5-milestone
breakdown. This file tracks what's actually been built, milestone by
milestone.

## M1 COMPLETE — Subcontractor CRUD + Mobilisation skeleton (Draft only)

- New module `server/src/modules/subcontractors/`: a `Subcontractor` entity
  (name/contactPerson/phone/email/status/notes) — mirrors `Client` but
  drastically simplified (no sites, no approval workflow, no VAT/CR
  numbers). Referenced by ObjectId from Mobilisation, never embedded.
  Delete is guarded by a referential-integrity count against
  `Mobilisation.subcontractor` (same pattern as `Client`'s guard against
  assigned Employees).
- New module `server/src/modules/mobilisations/`: the full `Mobilisation`
  schema is in place already (Section 1 fields, Section 2 quotation/PO
  fields, the Configurable-Approval-Hierarchy workflow fields identical in
  shape to `ReimbursementClaim`, the `coordinators[]` joint-coordinator
  array, `documents[]`) — but M1 only wires up `POST/GET/GET:id/PATCH:id`,
  every record staying `Draft`. Submit-to-review, Marketing Manager
  decide, visibility circle, self-mobilise, and documents land in M2–M5.
- Snapshot fields (`workerName`/`iqamaNumber`/`nationality`/`trade`/`phone`
  from `Employee`, `clientName` from `Client`, `subcontractorName` from
  `Subcontractor`) are captured at creation/edit time — same durable-history
  convention as `Deployment.clientName` — not live-joined on read.
- `profit` is a plain editable `Number`, never a formula-only computed
  field — the exact commission arithmetic needs a verification pass with a
  real example before any auto-calculation is trusted (same posture as
  Payroll's manually-entered GOSI).
- Access for M1: only `Coordinator` or `Admin` may create a mobilisation;
  everyone else gets a clear 403. Listing/viewing is scoped to "my own, as
  coordinator" for everyone except Admin (who sees all) — this scope only
  ever grows in M4, never needs unbuilding.
- Client: `client/src/features/subcontractors/` (list+modal, mirrors
  `ExpenseListPage`) and `client/src/features/mobilisations/` (list page,
  a shared `MobilisationForm` used by New/Edit pages — Edit also serves as
  the "view" for now, since every M1 record is a Draft). Wired into the
  Sales & Clients nav group and `router.jsx`.
- Two real bugs found and fixed during verification:
  1. The New/Edit pages' worker/client/subcontractor picker queries
     requested `limit: 200`, but every list endpoint's Zod schema caps
     `limit` at 100 — every picker 400'd. Fixed to `limit: 100`.
  2. `MobilisationForm`'s local `Checkbox` wrapper was a plain function
     component; react-hook-form's `register()` spreads a `ref` onto it,
     which React silently drops on a non-forwardRef component. Fixed with
     `React.forwardRef`.
- Verified: curl create/validate/list/get/update/wrong-role/auth-failure as
  Admin, HR (wrong role), and a real Coordinator (own-record scoping,
  including a cross-coordinator 403); full browser click-through of both
  modules as Admin (create with a subcontractor, edit, delete-blocked-by-409
  on a referenced subcontractor) and as a Coordinator (nav visibility, own
  mobilisation list). All test data (2 Employees, 1 Client, 1 Subcontractor,
  3 Mobilisations, 3 Users, refresh tokens, audit logs) deleted afterward.

## M2 COMPLETE — joint coordinators + submit

- `Mobilisation` schema's `coordinators[]` gains real endpoints: invite
  (`POST /:id/coordinators`, primary/Admin, Draft/Rejected only, target must
  be a real `Coordinator` login), remove (same gate, but only while the
  invitee is still unconfirmed — a confirmed co-coordinator has already
  vouched for the record, so undoing that is an Admin edit, not a routine
  removal), and self-confirm (`PATCH /:id/coordinators/:userId/confirm`,
  only that user, for themselves).
- `POST /:id/submit` — Draft/Rejected → PendingReview, 400 unless every
  coordinator has confirmed. Resolves the `Mobilisation` `ApprovalWorkflow`
  via `resolveApprovalWorkflow` reused completely unchanged (always falls
  through to the company-wide default — a mobilisation's `worker` is the
  subject of the placement, not the requester, so there's no per-employee
  override concept here, unlike Leave/Reimbursement). Added `'Mobilisation'`
  to `APPROVAL_REQUEST_TYPES`. A prior rejection's `approvalTrail` history is
  kept; only the terminal decision fields reset.
- New minimal endpoint `GET /api/mobilisations/coordinators` — a real access
  gap found while building the invite UI: `GET /api/users` (the general
  staff directory) is Admin/Manager/HR only, so the Coordinator who actually
  needs to invite a peer couldn't call it. Returns name-only (no email) for
  every Coordinator login, to any staff member.

## M3 COMPLETE — Marketing Manager review

- `PATCH /:id/commercial-details` — Section 2 fields (quotation/PO), gated
  by exporting and reusing the approval engine's own `resolveStepAuthority`
  (current-step-role-or-Admin), PendingReview only, does not touch status.
- `PATCH /:id/decide` — reuses `decideApprovalStep` completely unchanged
  except for one new, backward-compatible extension point:
  `decideApprovalStep` gained an optional `notifyFinal` override (default:
  `notifyEmployeeUser(doc.employee, ...)`, unchanged for every existing
  caller). Mobilisation had to supply its own — the default assumes the
  request's subject is an Employee with a login, but `Mobilisation` has no
  `employee` field at all (its `coordinators[]` are Users directly) — this
  was caught and fixed during implementation, before it ever shipped as a
  silent no-op. `legacyAllowedRoles: ['Admin']` is the same safety net every
  other request type has for before a real workflow is configured.
- Verified the full lifecycle: submit → commercial-details → approve; a
  separate reject-without-note (400) → reject-with-note (200) →
  coordinator-edits → resubmit cycle, confirming `approvalTrail` history
  survives resubmission; the Admin-safety-net decide path before any
  `Mobilisation` workflow existed.

## M4 COMPLETE — visibility circle + self-mobilise + field stripping

- New module `server/src/modules/mobilisationSettings/`: a `MobilisationSettings`
  singleton (same found-or-created pattern as `CompanySettings`) holding
  `viewerRoles` and `selfMobiliseRoles` — both `ApprovalRole` reference
  arrays, admin-configurable via a new `MobilisationSettingsPage` (Admin
  only), reusing the existing Approval Hierarchy's roles rather than
  inventing a new role concept.
- `viewerRoles` deliberately does NOT reuse the generic "any ApprovalRole
  member" check (`isApprovalRoleMember`, used by the Approval Log) — the
  org's real hierarchy has roles (e.g. HR) that sit elsewhere in the
  Approval Hierarchy but were explicitly excluded from mobilisation
  visibility. Added `isMemberOfAnyRole(userId, roleIds)` to
  `approvals.service.js` instead — a subset check, reused for both
  `viewerRoles` and `selfMobiliseRoles`.
- Visibility: a viewer-role member sees a mobilisation once it's past Draft
  (BDM's immediate "read on version" on submit) with full fields; the
  current step's reviewer (e.g. Marketing Manager) also sees it in full
  while PendingReview even before being added to `viewerRoles`. A plain
  Coordinator only ever sees their own (any status); the response has its
  12 commercial fields (rates, commission, profit, quotation/PO) stripped
  entirely once `status === 'Approved'` — verified as an actual absent key,
  not a null/zeroed value, in both the API response and the browser (the
  "Marketing Manager Review" card simply doesn't render for a Coordinator
  viewing their own Approved record).
- `createMobilisation`'s gate extended: Admin or Coordinator (unchanged from
  M1) or a `selfMobiliseRoles` member — verified a BDM-role test user
  self-mobilising directly.
- `annotateCanDecide` (already built for Leave/Reimbursement/etc.) reused
  for both `listMobilisations` and `getMobilisation`, giving the client a
  real `canDecideCurrentStep` flag instead of duplicating the engine's
  authorization logic in the UI.

## M5 COMPLETE — documents

- `server/src/middleware/upload.js` gained `uploadMultiple` (up to 10 files,
  field name `files`) alongside the existing `uploadSingle` — the first
  `.array()` upload in this codebase, reusing every piece of the existing
  private/authenticated Cloudinary pipeline (`verifyContent` content-
  signature checking, `uploadBuffer`, `ALLOWED_TYPES`) unchanged.
- `POST /:id/documents` (multipart, `files` + `category`), `DELETE
  /:id/documents/:fileId`, `GET /:id/documents/:fileId/file` (streams
  bytes, same signed-URL-fetched-server-side-only pattern as reimbursement
  receipts). Upload/delete blocked once `Approved` — a document needed
  after that point is an Admin edit, not a routine attachment.
- Verified: multi-file upload, a signature-mismatch file correctly rejected
  (bytes don't match the declared PDF type), byte-exact download, delete
  (Cloudinary file actually destroyed, not just unlinked from the array),
  and the Approved-blocks-upload rule.

## Client-side (all milestones)

- `client/src/features/mobilisations/pages/MobilisationDetailPage.jsx` —
  the workhorse: Section 1 read-only display (commercial fields are simply
  absent from what the API returned for a stripped Coordinator — no
  client-side hiding logic needed), the coordinator confirm/invite/remove/
  submit flow, the reused `ApprovalTrailView`, the Marketing Manager's
  Section 2 form + Approve/Reject (a `Modal`, not `ConfirmDialog` — the
  latter hardcodes a red "Delete" button and renders its message inside a
  `<p>`, wrong for a non-destructive Approve action and invalid for nesting
  a Textarea), and document upload/list/download. A real bug caught during
  build (not just review): the Section-2 form's `useForm` was originally
  called before the page's loading guard, so `defaultValues` would have
  frozen at `undefined` from the first (loading) render and never
  repopulated — fixed by extracting `CommercialDetailsCard` as its own
  component, mounted only once real data exists, matching every other
  form in this codebase (`MobilisationForm`, `DeploymentForm`, etc.).
- `client/src/features/mobilisationSettings/` — the settings page, two
  `ApprovalRole` checklists mirroring `ApprovalsPage`'s existing
  member-checkbox pattern.
- List page's row-click/View now goes to the detail page; Edit page is
  Section-1-only, reachable from the detail page, Draft/Rejected only.

Verified end-to-end in the browser as five real roles simultaneously
(Admin, two Coordinators, a BDM-role user, a Marketing-Manager-role user):
create → invite co-coordinator → confirm → submit → commercial-details →
approve → coordinator's stripped view → BDM's full read-only view → self-
mobilise. All test data (5 Employees, 1 Client, 1 Subcontractor, 6
Mobilisations, 5 Users, 2 ApprovalRoles, 1 ApprovalWorkflow, 1
MobilisationSettings doc, refresh tokens, audit logs, notifications)
deleted afterward.

## Follow-up (2026-09-05): a submitted mobilisation had nowhere to go

A user asked, about a real mobilisation they'd just submitted for review,
"where does this go?" Traced it and found the answer was "nowhere useful":
`mobilisation.service.js`'s `submitMobilisation()` correctly calls
`resolveApprovalWorkflow(..., 'Mobilisation')` to find a configured
workflow and, if one exists, notifies its first step's role members — this
part was always correct. But `server/src/modules/approvals/
approvalWorkflow.model.js`'s `APPROVAL_REQUEST_TYPES` already included
`'Mobilisation'` (added when this module shipped) while its client-side
mirror, `client/src/lib/constants.js`'s `APPROVAL_REQUEST_TYPES`, did not.
The Approval Hierarchy page's "which request types does this workflow
apply to" checklist is built from that client constant — so an Admin could
never actually select Mobilisation there, no matter how they configured
things. With no workflow ever assignable, every mobilisation silently fell
back to `decideApprovalStep`'s legacy path with `legacyAllowedRoles:
['Admin']` — meaning only Admin could approve/reject it, and, since the
notify step only runs `if (workflow)`, **nobody was ever notified that a
mobilisation needed review at all**.

Fixed by adding `'Mobilisation'` to the client's `APPROVAL_REQUEST_TYPES`
and `APPROVAL_REQUEST_TYPE_LABELS` — no server change needed, since the
server-side enum, the workflow-resolution logic, and the notification call
were already correct and had been since the module shipped. Verified live
against the real database: the "Add workflow" modal's request-type
checklist now offers Mobilisation alongside Leave/Salary Advance/
Reimbursement/Timesheet. Whether to actually configure a workflow for
Mobilisation (and which role(s) — Marketing Manager was the module's
original design intent) is the user's own call, not made here.

## Follow-up (2026-09-05): multi-document upload was already built

Separately reported as missing via a screenshot showing one file selected
next to a "Choose files" button. Traced the full pipeline — client
`<input type="file" multiple>`, `onChange={(e) => setFiles([...e.target.
files])}`, `uploadMobilisationDocuments()` appending every file under the
same `files` FormData key, the server route's `uploadMultiple` middleware,
`addDocuments` controller — and confirmed it was already fully built and
working; the screenshot just showed a single file because only one had
been selected (holding Ctrl/Cmd or Shift in the OS file picker selects
several at once, same as any native multi-select file input). Verified
live: attached two real files to a real mobilisation's document list in
one request, confirmed the server stored both in one response, then
removed the test files.

## Follow-up (2026-09-08): Iqama-based worker recognition COMPLETE

A SupplierEmployee/Freelancer has no Employee record, so re-mobilising the
same real person (released back to standby, then placed with a new client)
previously meant re-typing their entire identity from scratch. Now: once a
10-digit Iqama is fully typed, `GET /mobilisations/lookup-by-iqama` finds
that worker's most recent past mobilisation (any coordinator, any status)
and the form auto-fills name/nationality/phone/workerType/subcontractor
from it — deliberately reusing Mobilisation's own history as the source of
truth rather than a new "known workers" collection to keep in sync
separately. Also fixed two real gaps flagged directly by the user: Iqama
number is now validated as exactly 10 digits (client + server), and the
free-typed Worker Name/Iqama fields no longer show a `<datalist>`
suggestion dropdown (the user found it confusing) — `site` keeps the old
suggestion pattern, unrelated to worker identity. Phone now defaults to
`+966` pre-filled instead of empty. See
[[mobilisation-worker-identity-rules]] (session memory) for the standing
rule going forward.

Verified live with a throwaway Admin: rejected a 3-digit Iqama with the
exact validation message; created a real SupplierEmployee mobilisation
with a valid 10-digit Iqama for one client; started a second mobilisation
for a *different* client, initially picked "Freelancer," then typed only
the same Iqama — watched worker type auto-switch back to "Supplier
employee," name/phone/subcontractor all fill in correctly, and the
resulting mobilisation saved with the exact same identity data. Both test
records and the test admin were deleted afterward.

## Follow-up (2026-09-08): list/detail visibility bug + Office Secretary
## standing Section-1 edit right, both COMPLETE

Reported directly by the user via a screenshot: a real Office Secretary
(Riyaj Ansari) saw MOB-0028 in her Mobilisations list but got
"Mobilisation not found" opening it. Root cause: `findVisibleMobilisations`
(the list query) matched membership in **any** step's role pool, while
`getMobilisation` (the single-record fetch) correctly checked only the
**current** step's pool — so once a record moved past a reviewer's own
step, it kept phantom-appearing in their list right up until they clicked
in. Fixed the list query with a precise `$expr`/`$arrayElemAt`/
`$setIntersection` condition that mirrors `getMobilisation`'s own
current-step check exactly, instead of the old blanket `'steps.roles':
{ $in: roleIds }`.

Landing in the same investigation, the user then asked for a real feature:
"Once submitted the Office secretary should be still able to edit it if
needed before it is approved" — i.e. whoever holds **step 0** of a
mobilisation's workflow (Office Secretary, by today's configuration) should
be able to go back and fix Section 1 (whatever the coordinator typed)
for as long as the record is still `PendingReview`, not just while it's
still literally sitting on step 0. Server-side, three places needed the
same "step 0 role member, not just current-step" check:

- `updateMobilisation`'s access gate — previously required
  `currentStep === 0` in addition to step-0 membership; now checks step 0's
  role pool regardless of which step the record is currently on, as long as
  status is still `PendingReview`.
- `getMobilisation` — gained a new `canEditSection1` flag (Admin, or a step-0
  role member while `PendingReview`) returned on every fetch, so the client
  can show/hide the Edit button correctly without duplicating the server's
  authorization logic.
- **The view gate itself** (a real gap found only during live verification,
  not initially caught): `getMobilisation` computed `canEditSection1` but
  the surrounding 403 check (`isCoordinator || isViewerAllowed ||
  isStepReviewer`) never consulted it — so a step-0 reviewer would still get
  bounced with a 403 just opening the record once it moved past their step,
  before ever seeing the new Edit button. Fixed by adding `canEditSection1`
  to that OR.
- `findVisibleMobilisations` needed the matching list-side half of the same
  right: without it, the visibility bug fix above would have made MOB-0028
  disappear from Riyaj's list entirely the moment it left step 0 — correct
  for a stale non-step-0 reviewer, but wrong for step 0, since she'd have no
  way to navigate to a record she still has a standing right to edit. Added
  a second `$or` arm (`steps[0].roles` intersected with the actor's roles,
  `PendingReview` only) alongside the current-step one.

Both client pages consume the new flag: `MobilisationDetailPage.jsx`'s Edit
button visibility (`canManage || Boolean(m.canEditSection1)`, previously
`canManage || canEditDetails` — the wrong flag, since `canEditDetails` gates
Section 2, not Section 1) and `MobilisationEditPage.jsx`'s own independent
access gate (previously its own stale `currentStep === 0 &&
canDecideCurrentStep` check, now `mobilisation.canEditSection1`). Section 2
(the current-step reviewer's quotation/PO/timesheet data) stays correctly
hidden from a step-0 reviewer once their own step has passed — same
`REVIEW_FIELDS`/`COMMERCIAL_FIELDS` stripping as a plain coordinator, no
change needed there.

Verified live and read-only against the real MOB-0028 record and Riyaj
Ansari's actual `ApprovalRole` membership (no write made to the live
record, to avoid polluting its audit trail with a test actor): confirmed
she is a member of step 0's role ("Office Secretary") but not step 1's
(the record's current step, "MM"); confirmed `listMobilisations` now
correctly includes MOB-0028 for her; confirmed `getMobilisation` no longer
throws and returns `canEditSection1: true` with Section 1 fields intact and
Section 2 fields stripped; confirmed `resolveStepAuthority` (the same
function `updateMobilisation` calls) authorizes her and rejects an
unrelated Coordinator against the same step-0 role pool.

## Follow-up (2026-09-11): "Own Employee" worker picker offered office staff

User-reported via screenshot: the New Mobilisation form's worker dropdown
(Worker type = Own Employee) listed the company's own admins/managers/
coordinators/HR/accounts staff — including the logged-in Admin's own
Employee record — instead of real field workers. Root cause: the picker
only ever filtered by `Employee.type === 'Own'`, which every staff member's
Employee record also satisfies (an "Own" employee just means "directly
employed," not "a laborer") — nothing distinguished an office role from an
actual mobilisable worker. Checked the real data: of 15 `Own` employees,
14 were office staff (COO/Marketing Manager/Financial Manager/General
Manager/Coordinator ×2/HR ×2/IT Engineer/Accountant/Clerk/Office Admin/
Driver) and exactly 1 (Sharuk Khan, designation "Labour") had a `Worker`
login.

Fixed by adding a `loginRole` filter to `GET /employees` (looks up Users
by role, then filters Employees by the reverse `employee` reference —
same query shape `createdByRole` already used) and passing
`loginRole: 'Worker'` from the New Mobilisation page. Also had every
`listEmployees` row carry the same `.login` shape `getEmployee` already
attaches (batched, one query for the whole page rather than one per row) —
the Edit page needs this too, since it deliberately fetches the
*unfiltered* list (an old mobilisation may already reference an employee
who wouldn't qualify under this new rule) and filters client-side while
keeping the currently-assigned worker selectable regardless.

Verified against the real data: `GET /employees?type=Own` returns all 15;
adding `&loginRole=Worker` narrows to exactly Sharuk Khan (AJ-015); browser
click-through on the New Mobilisation page confirmed the dropdown now
offers only that one name. Throwaway Admin used for both checks, deleted
afterward.

## Follow-up (2026-09-12): removed the "client timesheet hours" field — that lives on Deployment now

The Section-2 "Overtime & timesheet" form (filled by the current-step
reviewer, e.g. Marketing Manager) had a manually-typed "Client timesheet
hours" number, from which `otHours` (= max(0, clientTimesheetHours -
requiredTimesheetHours)) and an OT-inclusive `profitPerMonth` were derived.
This predates Deployment's own day-by-day monthly timesheet grid (see
`docs/DEPLOYMENT-notes.md`'s 2026-09-12 follow-up) — once that shipped, a
Mobilisation only ever has ONE manually-typed "current" hours figure while
its resulting Deployment tracks the REAL hours for every month actually
worked, so the two could never stay in sync and the Mobilisation-level
number was stale the moment a second month was worked. The user's own
framing: this data belongs to Deployment, where the real timesheet is
entered, not Mobilisation.

Removed entirely from `Mobilisation`: `clientTimesheetHours`, `otHours`,
`otProfitTotal` (model field, `computeProfitFields`, the `commercialDetailsSchema`/
`commercialDetailsFormSchema`, the Section-2 form UI, the read-only Rates &
Financials table, and the Excel export columns). Kept: `otClientRate`/
`otClientCommission`/`otSubcontractorRate`/`otSubcontractorCommission` —
these are commercial RATE terms Deployment's own `computeMonthlyProfit`
already reads straight off the populated Mobilisation, so they still belong
here; only the *hours* half of the old formula moved. `otProfitPerHour`
also stays — it's a pure rate-derived margin preview (otClientRate -
otClientCommission, minus the subcontractor side for a SupplierEmployee)
that needs no hours figure at all, so it's still meaningful pre-deployment.

`profitPerMonth` is now a simpler pre-deployment ESTIMATE:
`profitPerHour * requiredTimesheetHours - fta - allowance` (no OT term,
since there's no real OT hours figure to price until a Deployment exists) —
null only until `requiredTimesheetHours` itself is set, rather than
staying null until a reviewer manually types in a "current" hours number
that immediately goes stale. The Section-2 form's title changed to
"Overtime rates" with an explicit hint pointing to Deployment for actual
hours. Confirmed safe for Deployment's own profit computation: it never
read `mobilisation.otHours`/`otProfitTotal` in the first place — it always
computed its own `otProfitTotal` locally from `entry.otHours` (the real
per-month figure) and the OT rate fields, so nothing there needed to change.

Verified: a real create + commercial-details-save script run confirmed
`profitPerHour`/`profitPerMonth`/`otProfitPerHour` compute correctly (and
match hand-calculated values), a `clientTimesheetHours` value sent by a
client is silently dropped everywhere (create, and commercial-details
save), `profitPerMonth` stays null with no `requiredTimesheetHours` set,
and the Mongoose schema itself no longer has `clientTimesheetHours`/
`otHours`/`otProfitTotal` paths while still carrying the OT rate fields
Deployment depends on. Browser click-through against a throwaway
PendingReview mobilisation confirmed the Rates & Financials table shows no
timesheet-hours row, the Overtime rates section shows the new hint and no
timesheet inputs, and saving OT rates (20/2) live-updates OT profit per
hour to the correct SAR 18.00. All throwaway data and scripts deleted
afterward.

## Follow-up (2026-09-13): client rate mandatory, OT rates move to Section 1, and a real cross-mobilisation date-overlap bug fixed

Three related changes made together after a live screenshot review of the
New Mobilisation form.

**Client rate is now required.** `clientRate` moves from an optional
number to `requiredNonNegNumber('Client rate is required.')` in
`mobilisationFields` (server) and a required string in the client's own
`mobilisationFormSchema` — every other Section 1 commercial field (client
commission, FTA, allowance) stays optional, since only the client rate is
genuinely never-legitimately-blank. `.partial()` on `updateMobilisationSchema`
still makes it optional for an edit payload, unchanged.

**OT rate fields moved from Section 2 to Section 1.** `otClientRate`/
`otClientCommission`/`otSubcontractorRate`/`otSubcontractorCommission` used
to be Section 2 fields — filled by the current-step reviewer (Office
Secretary, then Marketing Manager) during their review pass. The user's own
ask: move that responsibility to Section 1, set up front by whoever creates
the mobilisation, same as every other rate on the form. Moved in
`mobilisation.validation.js` (`mobilisationFields`/`DIRECT_FIELDS`, out of
`commercialDetailsSchema`), `mobilisation.service.js` (`COMMERCIAL_FIELDS`/
`REVIEW_FIELDS` swapped accordingly — these are now visible to the
Coordinator who entered them until Approved, then stripped, exactly like
`clientRate` already was, instead of being unconditionally hidden from them
at every status), and on the client (`MobilisationForm.jsx` — required
timesheet hours + OT client rate/commission briefly sat in "Worker & Job",
moved same day to "Client & Billing" per the user's own follow-up
correction; OT subcontractor rate/commission sit in "Subcontractor"
alongside their non-OT counterparts; `MobilisationDetailPage.jsx`'s Section 2 form lost its whole
"Overtime rates" sub-section, now just the client/sub quotation-PO paper
trail). `computeProfitFields`/`computeMonthlyProfit` needed no changes —
they only ever read these fields off the document, never cared which
"section" or workflow step set them.

**The real bug**: the user found that demobilising a worker and then
creating a brand-new mobilisation for them let the new mobilisation's date
be backdated into the middle of the just-ended (or any earlier) placement —
physically impossible, since a worker can only be in one place at a time.
Root cause: `assertNoActivePlacement`/`assertNoActiveNonEmployeePlacement`
(2026-09-12) only ever checked the worker's CURRENT mobilisation *status*
(Draft/PendingReview/Approved) — once a deployment is demobilised, its
Mobilisation flips to Completed and those checks find nothing, no matter
what date is proposed. Confirmed with the user before fixing: same-day
handoffs are allowed (demobilised from Client A on day X, mobilised to
Client B also day X) and the fix should cover SupplierEmployee/Freelancer
too, not just real Employees.

Added `assertNoDateOverlap` (`mobilisation.service.js`) — walks the
worker's full deployment HISTORY (every Deployment ever produced for their
Employee id, or for a SupplierEmployee/Freelancer, every Deployment behind
any Mobilisation that ever carried their Iqama number, since Deployment
itself doesn't snapshot Iqama) and rejects a proposed date that falls
`>= period.start && (period.end == null || date < period.end)` — inclusive
of a period's own start (can't start two placements the same day), exclusive
of its end (CAN start exactly when the old one ended). Wired into three
places: `createMobilisation` (early feedback), `updateMobilisation` (only
when the worker identity or the date actually changed from what's already
stored — mirrors `workerActuallyChanged`'s own no-self-collision reasoning
exactly, widened to cover the date too), and `approveMobilisation` (the
real, load-bearing gate — checked fresh right before
`createDeploymentFromMobilisation` runs, since time can pass between a
mobilisation's creation and its final approval, during which a conflicting
one could be created and approved first).

**Verified**: a script run reproduced the exact reported scenario —
mobilised 1 Jan, demobilised 1 Feb, a backdated mobilisation to 15 Jan (or
exactly 1 Jan, the old start date) is now rejected, a mobilisation dated
exactly 1 Feb (the handoff day) and one dated well after both succeed; the
same battery repeated for a Freelancer identified by Iqama; editing a
Draft's date into the old period is rejected while resending the same date
is a safe no-op; and a record inserted directly (bypassing create-time
validation, to simulate a race) was still caught and blocked at
approval-time, with no Deployment created. Also verified `clientRate`'s
new required-ness (schema-level and a live "Client rate is required" toast
on submit) and that the OT rate fields persist correctly from Section 1
now, with `otProfitPerHour` computing correctly at creation time rather
than waiting for a Section 2 pass. All throwaway data and scripts deleted
afterward.

## Follow-up (2026-09-13): Rates & Financials hidden from the step-0 reviewer specifically

The user asked, from a screenshot of the detail page: hide Rates &
Financials from Office Secretary, only the Manager needs to see it — and
asked whether this was already something Admin controls could handle.

**It wasn't, fully.** `COMMERCIAL_FIELDS` (Rates & Financials) visibility
already had one real admin lever — the `mobilisationsViewer` Section
Access key ("Mobilisations — full visibility") — but it only ever ADDED
access on top of a hardcoded rule that granted the CURRENT-step reviewer
everything, completely unstripped, with no distinction between step 0 (an
administrative first pass) and a later step (the actual commercial
decision). In this company's real, already-configured `mobilisationsViewer`
grant, `Manager` already has full visibility (confirmed against the live
setting) — which is exactly why Marketing Manager already sees rates
correctly today, and needed no change. Office Secretary is not, and can't
be, part of that grant (she's a hardcoded non-grantable role everywhere
else in this app), so the ONLY reason she saw Rates & Financials was the
unconditional "current reviewer sees everything" rule.

Fixed in both `getMobilisation` (single record) and `findVisibleMobilisations`
(list/export): `COMMERCIAL_FIELDS` is now hidden from whoever holds STEP 0
specifically, even while they're otherwise treated as "the current
reviewer" (`isStepReviewer`) and even before Approval — reusing
`canEditSection1`'s own "is this actor step 0's reviewer right now"
computation in `getMobilisation` rather than a second identical lookup, and
adding the equivalent per-item check to the list path. A later-step
reviewer (the real decider), a `mobilisationsViewer` member, or the
coordinator who typed the rates themselves (only before Approved, per the
existing rule) are unaffected. Deliberately step-0-based rather than a
hardcoded "Office Secretary" role check — consistent with this app's
existing principle that a workflow step's role is admin-configurable, not a
fixed org title; if this company ever reassigns step 0 to a different role,
that role inherits the same exclusion automatically.

Answering the user's actual question: yes, this remains admin-controllable
— `mobilisationsViewer` is still there as the deliberate override for
granting broader visibility (including to Office Secretary's role, if ever
wanted) via the existing Section Access page; the fix here only changes
the DEFAULT, automatic case.

**Verified**: a script run with a real 2-step workflow (throwaway
ApprovalRoles at step 0 and step 1, throwaway Office-Secretary-role and
HR-role users as their members, a throwaway Coordinator) confirmed —
step 0's reviewer never sees `clientRate`/`profitPerHour` etc., whether
it's currently their turn or the record has since moved to step 1; the
step-1 reviewer correctly has no access at all before their turn (a
pre-existing, unrelated rule) and correctly sees full commercial data once
it's their turn; the coordinator still sees it pre-Approval, unchanged. All
confirmed via both the single-record and list/export code paths. All
throwaway data and scripts deleted afterward.

## Follow-up (2026-09-14): OT rate fields simplified — no client-commission/subcontractor split for OT

The user's own correction, from a screenshot of the Mobilisation form:
`otClientCommission`, `otSubcontractorRate`, and `otSubcontractorCommission`
"do not exist" — real OT billing/pay only ever has two numbers, what the
client is charged per OT hour and what is actually paid out per OT hour to
whoever worked it, no matter their worker type. The regular-hours rate
split (`clientCommission` + `subcontractorRate`/`subcontractorCommission`,
SupplierEmployee-only) is untouched — this correction is scoped to the OT
fields alone.

Removed those three fields everywhere (model, Zod validation client+server,
the New/Edit form, the detail page, the Excel export, Deployment's own
`computeMonthlyProfit`/`PROFIT_RATE_FIELDS`) and replaced them with one new
field, `otEmployeeRate`, added to the CLIENT & BILLING section of the form
(not Subcontractor — it applies to every worker type alike). New formula,
both on Mobilisation (`computeProfitFields`) and on Deployment's per-month
figure (`computeMonthlyProfit`, which reads the same rate fields off the
source Mobilisation):

```
otProfitPerHour = otClientRate - otEmployeeRate
```

`otAmount` on a Deployment's monthly-hours entry (`otHours × otClientRate`,
billed-to-client) is unchanged — it was never coupled to the removed
fields. `otEmployeeRate` gets the exact same visibility treatment the
removed fields had: a `COMMERCIAL_FIELDS`/`DIRECT_FIELDS` member, stripped
from a plain Coordinator's view once Approved, same as every other Section 1
rate.

**Verified**: `node --check` on every touched server file, a clean
`npm run build`, both locale files validated as syntactically correct JSON.
A throwaway script exercised the real `getMobilisation` /
`createDeploymentFromMobilisation` / `addMonthlyHours` / `getDeployment`
service functions end-to-end against the dev database (otClientRate 20,
otEmployeeRate 12 → otProfitPerHour 8; a full month at 20 OT hours →
otAmount 400 unchanged, monthly profit 10160 correctly folding in the new
otProfitPerHour) — confirmed the removed fields are genuinely absent from
the API response, not just hidden client-side. Also clicked through the
real New Mobilisation form in the browser (Own Employee, Supplier employee,
and Freelancer worker types) and the resulting detail page: CLIENT &
BILLING now shows "OT client rate" then "OT employee rate"; the
SUBCONTRACTOR section (Supplier employee only) shows just Subcontractor
rate/commission, no OT fields at all; the detail page's Rates & financials
table shows OT CLIENT RATE / OT EMPLOYEE RATE / OT PROFIT PER HOUR with the
correct computed value. Found this session's two dev processes were stuck
in the documented orphaned-`server.js` state (one each on ports 5000 and
5001, the client's already-running Vite process still pointing at the
stale 5001) — restarted both clean per the Windows dev notes above. All
throwaway users/mobilisations/scripts deleted afterward.

Same-day follow-up: OT client rate now auto-fills from Client rate as it's
typed (the user's own ask — OT usually bills at the same rate as regular
hours) — `useOtClientRateAutofill` in `MobilisationForm.jsx`, same
"never fight a manual edit" discipline as the existing Iqama autofill: it
only ever fills OT client rate while that field is still empty, and a
`mountedRef` guard skips the very first render so opening Edit on an
existing record with its own already-different OT rate is never silently
overwritten. Verified live in the browser: typing 45 into Client rate
mirrored 45 into OT client rate; manually changing OT client rate to 60 and
then changing Client rate again to 70 left OT client rate at the
coordinator's own 60, untouched; opening Edit on a throwaway record with
clientRate 50 / otClientRate 99 loaded with OT client rate correctly still
showing 99, not overwritten with 50. Throwaway fixtures deleted afterward.

Follow-up (2026-09-16): FTA/Allowance fields gained real structure — the
user's own ask from a screenshot of the Client & Billing section. `fta`
(previously a bare number) is now paired with a new `ftaType` enum ("Food
Only"/"Travel Only"/"FTA" — FTA meaning all three combined, since the
field itself has always meant Food/Travel/Accommodation together), a
dropdown the client form requires picking before the amount input even
unlocks (both client Zod and server Zod reject a real `fta` amount with no
`ftaType`, mirroring each other exactly). `allowance` gained a free-typed
`allowanceRemark` (200 chars) describing what it's for — no type enum,
just text, per the user's own simpler ask for that one. Both new fields
follow the existing COMMERCIAL_FIELDS/DIRECT_FIELDS stripping/pass-through
lists exactly like `fta`/`allowance` themselves, included in the Excel
export, and translated in both locales. Verified with a real save/detail
round-trip in the browser (Food Only + amount, Allowance + a real remark
string, both rendering correctly on the detail page) — throwaway data
deleted afterward.

Same-day follow-up: a real, user-reported bug in the date-overlap guard
(`assertNoDateOverlap`) surfaced while entering backlog (historical) data —
a mobilisation dated well in the past was rejected as conflicting with a
LATER real placement, even though the two periods didn't actually overlap.
Root cause: the guard only ever looked at the new mobilisation's START
date, always treating it as open-ended (`[start, ∞)`) — correct for a
brand-new, still-ongoing placement (the original 2026-09-13 design intent),
but wrong for backlog entry, where the real end date is already known.
Fixed to be checkout-date-aware: when a checkout date is given, the new
mobilisation's interval is a real, CLOSED span (`[start, checkout)`),
correctly overlap-tested against every real Deployment period on record
(standard half-open-interval overlap: `a1 < b2 && b1 < a2`); omitted
(the user's own explicit ask — "keep it optional"), the guard behaves
exactly as before. `updateMobilisation`'s re-check now also fires on a
checkout-date-only change (previously only worker-identity/mobilisation-
date changes re-ran it), and `MobilisationForm.jsx` gained a "Clear — still
ongoing" link next to Checkout date (shown only once a date is picked) plus
a hint under the field when it's empty, explaining what leaving it blank
means — the user's own ask for a way to deliberately revert to "still
ongoing" after having selected a date. All three `assertNoDateOverlap` call
sites (create, update, approve) updated to pass the checkout date through.
New regression suite `mobilisation.dateOverlap.test.js` (6 tests) reproduces
the user's exact report, confirms the fix resolves it, confirms a genuine
overlap is still caught, confirms the same-day-handoff boundary rule still
holds with a real end date, and confirms clearing a checkout date back to
"still ongoing" correctly re-triggers a real conflict. Found and fixed a
second, unrelated real bug while verifying this live in the browser: the
FTA-type client refine (`if (data.fta && !data.ftaType)`) treated the
STRING `"0"` as truthy (client numeric fields stay strings until the
server coerces them — see this schema file's own header note), wrongly
demanding an FTA type on every existing Draft whose FTA was never set
(defaults to 0) the moment ANY other field on that record was edited and
saved — invisible when creating a fresh record (the New page's own empty
default is `''`, genuinely falsy) and only surfaced on Edit. Fixed with
`Number(data.fta) > 0`; confirmed the equivalent server-side check was
already safe, since server-side `fta` is coerced to a real number before
the refine ever runs. All throwaway fixtures (users, employees, dummy
mobilisations/deployments) deleted afterward.

Same-day follow-up: two more real, user-reported gaps, both found and
fixed together.

1. **OT client rate autofill genuinely didn't work for real typing.** The
   2026-09-13 autofill (`useOtClientRateAutofill`) only checked
   `!getValues('otClientRate')` to decide whether to mirror Client rate —
   which distinguishes "empty" from "non-empty" but not "non-empty because
   I autofilled it a moment ago" from "non-empty because the coordinator
   typed their own value." A human typing a Client rate character by
   character fires the effect once per keystroke: the first digit
   correctly autofilled OT client rate (e.g. "3"), but the SECOND digit's
   own check then saw a non-empty OT field (its own prior output) and
   refused to update it further, leaving OT client rate stuck on a leading
   digit while Client rate kept changing — indistinguishable from "the
   autofill doesn't work at all," which is exactly how the user reported
   it (gave up and typed a value in by hand). My own first verification
   pass of this feature missed it entirely because it set the field's
   FINAL value in one synthetic event rather than simulating real
   keystroke-by-keystroke input. Fixed with a second ref
   (`lastAutoValueRef`) tracking the exact value the hook itself last
   wrote — a keystroke is treated as "still following the autofill" only
   when the field is empty OR still equals that tracked value, so every
   subsequent digit keeps mirroring, while a REAL manual edit (the field no
   longer matches what the hook last wrote) still correctly stops it.
   Verified in the browser: typing "3" then "35" now correctly shows "35"
   in OT client rate at each step (previously stuck at "3"); manually
   overriding OT client rate afterward and then changing Client rate again
   still correctly leaves the manual value untouched — the original,
   already-verified "never fight a manual edit" behavior is unchanged.
2. **No warning when submitting a mobilisation with zero documents.** The
   existing "Submit for review" flow already warned about a different,
   narrower case (files chosen in the picker but never clicked "Upload" —
   a 2026-09-14 fix) but said nothing when there were no documents at all,
   neither uploaded nor even selected. Added a second `ConfirmDialog`
   ("No documents attached... Submit for review anyway?"), checked only
   when the unuploaded-files case doesn't already apply and
   `m.documents` is empty — a reviewer often needs a real attachment
   (contract, ID copy) to actually decide the record, so this is now a
   deliberate choice rather than a silent gap discovered only once it's
   already in someone's review queue. Verified end-to-end in the browser:
   a documentless Draft's Submit button now shows the warning; Cancel
   correctly leaves it in Draft; "Submit anyway" correctly submits (a real
   `POST .../submit` → 200, status moved to Pending review). Throwaway
   fixtures deleted afterward.

## Follow-up (2026-09-16, second same-day): double-mobilisation confirmed
## already guarded, a 4th FTA type, and a "pick a previous worker" fast path
## for SupplierEmployee/Freelancer

The user asked what happens if someone tries to re-mobilise a
SupplierEmployee/Freelancer worker who's already deployed somewhere — this
was already correctly guarded, nothing to fix: `assertNoActiveNonEmployeePlacement`
(any Draft/PendingReview/Approved mobilisation for that Iqama blocks a new
one outright) and `assertNoDateOverlap` (checked again against the worker's
real Deployment HISTORY, not just current status, right before approval too
— see the 2026-09-13 follow-up above) together mean a second mobilisation
either gets rejected immediately with a named conflict, or — if backdated
into a genuinely free window — succeeds exactly as it should. Explained this
to the user rather than changing anything.

Two real feature requests, both built:

1. **A 4th FTA type, `AccommodationOnly`.** Same additive-enum change as the
   original 3 (`docs/MOBILISATION-notes.md`'s first 2026-09-16 follow-up) —
   `FTA_TYPES` in both `mobilisation.model.js` and the client's
   `mobilisations.schema.js`, plus an i18n label in `en.json`/`ar.json`. No
   other code touches this list by name (the detail page and Excel export
   both render/print the raw value generically), so nothing else needed
   changing.
2. **A "pick a previous worker" fast path, reordering the form.** The
   user's own ask: worker type first, then — for SupplierEmployee — the
   Subcontractor block BEFORE the identity fields (moved up from its old
   spot below Client & Billing), immediately followed by a picker of
   "who has this subcontractor supplied us before" that auto-fills name/
   Iqama/nationality/phone on click; for Freelancer, the "adjacent idea" —
   the same picker but company-wide, since a Freelancer has no subcontractor
   at all. The existing Iqama-typed autofill (`useIqamaAutofill`) stays
   exactly as it was, for a worker not on the picker's list yet.
   - New `GET /mobilisations/previous-workers?workerType=&subcontractor=`
     (`mobilisation.service.js`'s `listPreviousWorkers`) — the LIST version
     of the existing `lookupWorkerByIqama`: same "most recent mobilisation
     snapshot is the current known details" reasoning, one entry per
     distinct Iqama, SupplierEmployee scoped to the given subcontractor
     (required), Freelancer company-wide (no scoping field exists for
     them) — same "any coordinator, not scoped to my own" posture as the
     Iqama lookup. Plain `find()` + in-memory dedupe-by-Iqama, not an
     aggregation pipeline — this app's own KISS bias, and it sidesteps
     aggregation's lack of automatic ObjectId casting entirely.
   - Client: `PreviousWorkerPicker`, a plain themed `<Select>` (same as
     every other picker on this form) rendered only once there's something
     to pick from (a brand-new subcontractor/freelancer shows nothing, not
     an empty picker) — not a bound form field, a one-shot action that
     calls `setValue` on the same 4 fields the Iqama lookup fills, then
     resets to its own placeholder. `useIqamaAutofill` now returns
     `markApplied(iqama)` so the picker can pre-mark the Iqama it just
     wrote as "already handled" — otherwise that same value reaching 10
     digits a moment later (via the picker's own `setValue`) would
     immediately re-trigger the Iqama-lookup effect and show a second,
     redundant "found from a previous mobilisation" toast for a worker the
     user just explicitly picked by name.

   Verified live in the browser against real fixtures matching the exact
   shape described (a subcontractor with 2 known SupplierEmployee workers,
   1 known Freelancer): confirmed the new field order (Subcontractor block
   now sits above the identity fields, not below Client & Billing);
   confirmed the picker stays hidden until a subcontractor is chosen, then
   lists exactly that subcontractor's 2 workers; confirmed clicking one
   fills all 4 identity fields correctly with no duplicate toast; confirmed
   the Freelancer picker is company-wide with no subcontractor fields
   alongside it; confirmed the ORIGINAL manual Iqama-typed path still works
   completely unchanged, including its own subcontractor auto-select.
   Fixtures (throwaway admin, Subcontractor, 3 Mobilisation records) deleted
   afterward. `npm run build`/`npm run lint` clean on both apps (same 16
   pre-existing baseline warnings), server test suite still 38/38.

## Follow-up (2026-09-16, third same-day): the Employees picker only loads
## when "Own Employee" is actually selected

A real user-reported gap, from a screenshot: opening New Mobilisation showed
"Couldn't load workers — you may be missing read access to it" across the
top of the form. Root cause: both `MobilisationNewPage` and
`MobilisationEditPage` always fetched the full Employees list up front
(`GET /employees`, gated by the `employeeCreate` Section Access READ tier —
Admin-only by default, see `docs/SECTION-ACCESS-notes.md`), purely to
populate the "Own Employee" worker-type dropdown — even for someone who only
ever mobilises SupplierEmployee/Freelancer workers and would never touch
that dropdown at all. Anyone who can self-mobilise but was never separately
granted Employees read (the out-of-the-box state for every non-Admin role)
hit this on every single visit.

Fix, per the user's own direction ("only loads when Employee is selected"):
moved the Employees fetch OUT of both pages and INTO `MobilisationForm`
itself, in a new `useEmployeeWorkers` hook gated on the form's own LIVE
`workerType` (via the same `useWatch` the rest of the form already uses),
not just its initial value — switching to SupplierEmployee/Freelancer now
means the request is never even made, and switching back to Employee
re-fires it (from cache if already fetched). The two pages' own
`workersLoading`/`workersError` gates and `PickerLoadWarning` entries are
gone entirely; `PickerLoadWarning` now renders locally, right next to the
Worker select itself, only when that branch is actually on screen. New/Edit
still differ in one way — Edit needs an already-referenced employee to stay
selectable even if they wouldn't qualify under today's rules (wrong type, or
an office-staff login rather than a real Worker one), the exact same
reasoning the original unfiltered-Edit-query always had — so `MobilisationForm`
gained one new optional prop, `existingWorkerId` (Edit page only), and
`useEmployeeWorkers` branches its query/filter on whether it's set, matching
each page's ORIGINAL filtering behavior exactly, just relocated.

Also fixed one real latent bug found while building this: `useIqamaAutofill`'s
own "already applied" ref always started at `null`, so a form that arrived
with a full Iqama already typed in (every ordinary Edit-page open on a
SupplierEmployee/Freelancer record) re-ran the Iqama lookup and re-showed
"Found X from a previous mobilisation…" on every single load. Fixed by
seeding that ref from the form's own starting Iqama value.

**Verified**: server-side confirmed via direct repeated `curl` calls (5/5
consistent `403`) against a real throwaway Coordinator added to the
company's real "Coordinator" `ApprovalRole` (which this company's actual
Section Access config grants `mobilisationsSelfMobilise` write but not
`employeeCreate` read/write — genuinely reproducing the reported gap without
inventing new grants). Client-side confirmed in the browser: switching
Worker type away from "Employee" renders the Subcontractor/identity fields
immediately with zero trace of the Employees warning and fires no new
`/employees` request; switching to Freelancer likewise; a full SupplierEmployee
mobilisation was created end-to-end as this restricted user (real `201`,
landed on its detail page) — proving the rest of the form stays fully usable
despite the Employees gap. (Note: the in-app test browser's own known
flaky localhost connectivity — see this repo's Environment notes — made the
default Employee-selected case's error banner slow to settle visually during
testing; server behavior was independently confirmed stable via `curl`, and
the conditional-fetch behavior itself, the actual fix, does not depend on
that retry path at all.) `npm run build`/`npm run lint` clean on both apps
(same 16 pre-existing baseline warnings), server test suite still 38/38.
Fixtures (throwaway Coordinator user, one test Mobilisation) deleted
afterward; the real "Coordinator" ApprovalRole's membership was restored to
its exact original state.

## Follow-up (2026-09-16, fourth same-day): step-advance notification was
## never wired up — Office Secretary always saw it, the next reviewer never did

Real user-reported inconsistency, from a screenshot: Office Secretary
correctly got a "needs your review" notification when MOB-0061 was
submitted; the Manager, whose role holds this company's real second
workflow step, never got one at all once Office Secretary approved step 0.

Root cause: `decideApprovalStep` (the shared engine every request type in
this app reuses) only notifies the NEXT step's reviewers on a step-approve
if the caller passes an OPTIONAL `buildStepNotification` callback — every
other request type that goes through it (Leave/Timesheet/SalaryAdvance/
Reimbursement/ExitReentry/Certificate) supplies one; `mobilisation.service.js`'s
`approveMobilisation` never did. `submitMobilisation`'s own step-0
notification worked because it was a completely separate, hand-rolled block
— which is exactly why Office Secretary's case looked fine while the real
step-advance path was silently missing a wire-up, not a permissions issue.

Fix: extracted `buildMobilisationStepNotification(doc)` (same title text the
hand-rolled version already used) and reused it in BOTH places, matching
every sibling module's own stated convention ("one builder, reused
everywhere, so the text can never drift") — `approveMobilisation` now passes
it as `buildStepNotification`, and `submitMobilisation` was switched from
its hand-rolled block to the shared `notifySubmission` helper (same
behavior for the real-workflow case; a genuine improvement for the
no-workflow-configured case, which previously notified nobody at all —
now falls back to Admin, matching `approveMobilisation`'s own existing
legacy fallback). Confirmed via the real company data: a genuine 2-step
"Mobilisation workflows" ApprovalWorkflow exists, so this gap was live and
impactful, not theoretical. `npm run lint`/test suite (38/38) clean.

## Follow-up (2026-09-17): worker-data archive — "how do I delete a
freelancer's/subcontractor employee's data", COMPLETE

A Freelancer/SupplierEmployee worker has no Employee HR record of their own
to exit or deactivate — their only footprint in this app is every
Mobilisation (and any Deployment it produced) sharing their Iqama number.
There WAS already an Admin-only hard-delete on single Mobilisation/
Deployment records, but it's explicitly TEMPORARY dev-cleanup tooling (see
this file's own earlier note and `deployment.service.js`'s matching one) —
not status-aware (deletes an Approved/Completed record with real financial
history exactly as easily as a Draft), not cascading (deleting either half
orphans the other), and one-record-at-a-time only (no way to remove
everything for one person in a single action).

Two real design forks were put to the user directly before building
anything: (1) single-record cleanup vs. a genuine per-worker purge — they
chose per-worker; (2) permanent delete vs. a reversible archive that keeps
real financial history intact — they chose archive. Built:

- **Model**: `archived`/`archivedAt`/`archivedBy` added to BOTH
  `Mobilisation` and `Deployment` — always set together, never on one
  record in isolation.
- **Read-side**: every shared list/lookup/autofill query now excludes
  `archived: true` by default — `findVisibleMobilisations`,
  `listPreviousWorkers`, `lookupWorkerByIqama` (mobilisation.service.js),
  plus `findDeployments` and `getStandbyWorkforce`'s subcontracted-worker
  aggregation (deployment.service.js). A single-record GET by id is
  deliberately unaffected — archived data stays directly reachable, just
  hidden from lists, matching the user's own "still counted in historical
  reports" framing.
- **New service functions**: `getWorkerHistory(iqamaNumber)` (every
  Mobilisation for that Iqama — SupplierEmployee/Freelancer only, an
  Employee-type record sharing the same Iqama as a display snapshot is
  deliberately out of scope, that worker has its own separate Employee
  lifecycle — plus each one's resulting Deployment, `hasActiveEngagement`,
  `allArchived`); `archiveWorkerData`/`unarchiveWorkerData` (atomic
  transaction across both collections, audit-logged as `worker.archive`/
  `worker.unarchive`). Archiving is blocked (409) while ANY of the
  worker's mobilisations is Draft/PendingReview/Approved or any deployment
  is Active — a worker still genuinely placed shouldn't disappear from
  every list.
- **New routes**, Admin-only (`requireRoles('Admin')`, matching the
  existing temporary delete's own posture — broader/cross-collection, so
  at least as narrow): `GET /mobilisations/worker-history`,
  `POST /mobilisations/worker-history/archive`, `.../unarchive`.
- **New page**, `WorkerHistoryPage.jsx` at `/mobilisations/worker-history`
  (no sidebar nav entry, same "reachable but not a top-level destination"
  treatment as `/deployments/standby` itself) — Iqama search, the
  worker's identity + every record with its own status/deployment/archived
  columns, and one contextual action button (Archive, Restore, or a
  "currently active" badge with no action when blocked). Reached via a new
  "Worker data" button on both the Standby List and Mobilisations list
  headers, Admin-only.

**Verified two ways.** (1) A script-based test against the real dev
database: created a fully-inactive throwaway worker (Completed
mobilisation + Ended deployment) and a still-active one (Approved
mobilisation + Active deployment); confirmed the active one's archive
attempt correctly threw 409; confirmed the inactive one's archive
correctly flipped both records' `archived` flag, then disappeared from
`lookupWorkerByIqama`, the mobilisation list, the deployment list, AND the
standby list simultaneously; confirmed `unarchiveWorkerData` restored
visibility everywhere. (2) A live browser click-through as a throwaway
Admin: searched a real throwaway worker's Iqama, saw the correct record
and an enabled "Archive worker data" button, confirmed via the dialog
(exact worker name + record count interpolated), saw the button flip to
"Restore worker data" and an "Archived" badge appear — then separately
confirmed on the real Mobilisations list page that searching that same
worker's name now returned "No mobilisations match" — then restored it
and confirmed the button/badge reverted. `npm run lint` clean on both
apps (server: 0 warnings; client: same 16 pre-existing baseline), client
build clean. Throwaway admin and test records deleted afterward.
