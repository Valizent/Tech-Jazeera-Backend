# Configurable Approval Hierarchy

A post-Phase-3 addition, requested after Phase 3 was already complete. The
company has a real, multi-tier org chart (GM → COO → {Marketing Manager, HR,
Finance Manager}; MM → BDM → Coordinators/Admins/Office Staff; FM →
Accountants/Clerks) and wanted Leave/Salary-Advance/Reimbursement/Timesheet
requests to route through it — HR first, then either BDM or straight to the
top tier depending on which branch the requester sits in, ending with any
ONE of {MM, COO, FM} able to give final sign-off. Two scope decisions were
made with the user before building:

1. **Not a full dynamic-RBAC rewrite.** Existing module permissions (who can
   see Payroll, edit Employees, etc.) are untouched. This is a separate,
   self-contained approval-routing system layered on top — the new
   `ApprovalRole` concept is admin-created data, fully decoupled from the
   fixed `User.role` enum, not an expansion of it.
2. **Staff self-submission was a genuine, real gap this work also filled.**
   Submitting Leave/Advance/Reimbursement/Timesheet requests previously only
   existed through the Worker-only ESS portal (`/api/me/*`) — a Coordinator,
   HR, Manager, or Accounts user had no way to submit a request of their
   own. Confirmed necessary by the user directly ("Coordinators themselves
   need to submit their own requests too").

## What was built

**New module — `server/src/modules/approvals/`**
```
approvalRole.model.js        # ApprovalRole — an admin-named role (GM, COO,
                              #   HR, BDM, any name) with a list of staff
                              #   Users as members. Decoupled from User.role.
approvalWorkflow.model.js    # ApprovalWorkflow — an ordered list of steps;
                              #   each step is a POOL of roles ("any ONE
                              #   member of any ONE of these roles" decides
                              #   it) — a fan-in final tier and a strict
                              #   single-approver step are the same shape,
                              #   a pool of many vs. a pool of one.
                              #   `appliesTo` (Leave/SalaryAdvance/
                              #   Reimbursement/Timesheet) marks it as the
                              #   COMPANY-WIDE DEFAULT for those types — a
                              #   partial-unique index (on the array field
                              #   itself, a multikey index) guarantees at
                              #   most one active workflow can default to
                              #   a given type.
approvals.service.js         # role/workflow CRUD, resolveApprovalWorkflow()
                              #   (employee override, else company default,
                              #   else null = legacy flow), the Approval
                              #   Log's cross-type merge query,
                              #   isApprovalRoleMember()
approvalEngine.service.js    # decideApprovalStep() — the ONE decide
                              #   implementation shared by all 4 request
                              #   types (see below); annotateCanDecide() —
                              #   batches ApprovalRole membership into one
                              #   query per list page to compute a real
                              #   canDecideCurrentStep hint per row
approvals.validation.js, .controller.js, .routes.js
                              #   mounted at /api/approvals — role/workflow
                              #   CRUD is Admin-only to WRITE, but any staff
                              #   member can READ (EmployeeForm's override
                              #   picker, and every decide screen's trail
                              #   display, need role/workflow names — see
                              #   Key decisions)
```

**Extended — `Employee`, and all 4 request models/services/routes**
```
employees/employee.model.js       # + approvalWorkflow (ObjectId ref
                                    #   ApprovalWorkflow, default null) —
                                    #   the per-employee override; this
                                    #   ONE field is the entire mechanism
                                    #   behind "the Finance branch" — no
                                    #   hardcoded department concept
                                    #   anywhere in the code
employees/employee.service.js     # assertValidApprovalWorkflow(), wired
                                    #   into create/update, mirroring
                                    #   assertValidCoordinator/Manager

leave/leaveRequest.model.js               # + workflow/workflowName/steps/
financialRequests/advance.model.js        #   currentStep/approvalTrail —
financialRequests/reimbursement.model.js  #   identical shape on all 4
timesheets/timesheet.model.js             #   models. decidedBy/At/Note
                                            #   now mean "the FINAL decision
                                            #   only"; approvalTrail is the
                                            #   new granular, append-only
                                            #   per-step record.

*.service.js   # submit*: resolves & freezes a workflow snapshot at
                #   submission time (a later edit to the live workflow
                #   never retroactively changes an in-flight request).
                # decide*: now a thin wrapper around the shared
                #   decideApprovalStep() engine instead of 4 (soon 4)
                #   independent reimplementations.
                # list*: populates trail fields, calls annotateCanDecide().

*.routes.js    # each request type's own STAFF SELF-SUBMISSION route
                #   (POST /leave, /financial-requests/advances,
                #   /financial-requests/reimbursements, /timesheets),
                #   reusing the EXISTING submit service functions verbatim
                #   — only the route + a 400 for Admin (no Employee record)
                #   are new. Each type's decide route widened from a fixed
                #   role list to requireStaff — the engine is the real
                #   gate now (see Key decisions).

timesheets/timesheet.service.js   # bulkApproveTimesheets() redesigned:
                                    #   was a single updateMany; now a
                                    #   per-id loop over decideApprovalStep,
                                    #   skipping any timesheet whose
                                    #   workflow isn't on its FINAL step
                                    #   (a bulk "approve" shouldn't silently
                                    #   partial-advance a mid-chain item),
                                    #   returns {requested, approved, skipped}
```

**Extended — notifications, for a requester who might not be a Worker**
```
notifications/notification.service.js  # notifyEmployeeUser()'s `url` may
                                         #   now be a (role) => url function,
                                         #   not just a string — a request's
                                         #   own submitter can be a Worker
                                         #   (ESS, /me/...) OR a staff
                                         #   self-submitter (admin shell,
                                         #   e.g. /leave) since P2-M4+; a
                                         #   static url pointed a staff
                                         #   self-submitter at a route they
                                         #   can't reach. Fixed on all 4
                                         #   request types' final-decision
                                         #   notification.
```

**Client — new feature module `client/src/features/approvals/`**
```
approvals.api.js, approvals.schema.js
pages/ApprovalsPage.jsx     # Admin-only (route /approvals): Approval
                              #   Roles panel (name/description/staff
                              #   member checklist) + Approval Workflows
                              #   panel (ordered useFieldArray steps, each
                              #   a role checkbox pool, + an "applies to"
                              #   checklist)
pages/ApprovalLogPage.jsx   # route /approvals/log: merged, filterable,
                              #   ordered trail across request types.
                              #   Visible to Admin or any REAL ApprovalRole
                              #   member — a dynamic, DB-checked gate, not
                              #   a static role list; nav shows the link to
                              #   any staff user, the page/API render the
                              #   real result (data, or a clear "not part
                              #   of any approval role" error state)
```

**Client — extended**
```
components/shared/ApprovalTrailView.jsx   # NEW shared component: step X
                                            #   of N + the ordered decision
                                            #   trail (role, approver,
                                            #   decision, note, timestamp,
                                            #   an "Admin override" tag).
                                            #   Renders nothing for a
                                            #   request with no workflow.
                                            #   Reused across all 4 request
                                            #   types' review screens.
employees/components/EmployeeForm.jsx     # + "Approval workflow override"
                                            #   select, same re-apply-
                                            #   default-once-async-resolves
                                            #   pattern as coordinator/manager
leave/pages/LeavePage.jsx                          # + SubmitLeavePanel,
financialRequests/components/AdvanceReviewPanel.jsx        #   SubmitAdvancePanel,
financialRequests/components/ReimbursementReviewPanel.jsx  #   SubmitReimbursementPanel,
timesheets/pages/TimesheetsPage.jsx                #   SubmitTimesheetPanel
  # — a staff self-submit form on each review screen (hidden for Admin, who
  #   has no Employee record), reusing the exact ESS form schema/fields.
  #   Each review row's Approve/Reject now gates on a real server-computed
  #   `canDecideCurrentStep` instead of a blanket role check.
app/navConfig.js, app/router.jsx   # nav entries + routes for /approvals
                                     #   and /approvals/log
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/approvals/roles` | any staff | list approval roles |
| POST / PATCH | `/api/approvals/roles(/:id)` | Admin | create/edit a role |
| GET | `/api/approvals/workflows` | any staff | list workflows |
| POST / PATCH | `/api/approvals/workflows(/:id)` | Admin | create/edit a workflow |
| GET | `/api/approvals/log` | any staff (Admin or a real ApprovalRole member, checked dynamically) | cross-type ordered trail |
| POST | `/api/leave` | any staff | self-submit own leave request |
| POST | `/api/financial-requests/advances` | any staff | self-submit own advance |
| POST | `/api/financial-requests/reimbursements` | any staff | self-submit own claim |
| POST | `/api/timesheets` | any staff | self-submit own timesheet |
| PATCH | `.../decide` (all 4 types) | any staff (the engine is the real gate) | decide the current step |
| POST | `/api/timesheets/bulk-approve` | any staff | bulk-approve final-step-eligible timesheets |

## Key decisions & why

- **`Employee.approvalWorkflow` is the entire "Finance branch" mechanism.**
  There is no `department` field, no hardcoded "is this an Accountant"
  check anywhere. An Admin sets one field on an Employee record to route
  their requests through a different workflow than the company default —
  proven end-to-end with the user's own real example (see Verified below).
- **`null` workflow = the ORIGINAL single-level flow, byte-for-byte
  unchanged.** This is the safe-rollout mechanism: the feature activates
  per-employee as an Admin configures it, never breaking submission
  company-wide the moment this code ships. Every `decide*` function's
  legacy branch still enforces the exact original role list
  (`Admin/Manager/HR[/Coordinator for Leave]`) itself.
- **Decide routes widened from a fixed role list to `requireStaff`.** Once
  ApprovalRole membership is decoupled from `User.role`, an Admin can
  legitimately put an Accounts-role user into a workflow step an
  Accounts-role login was previously blocked from even attempting (e.g. the
  Finance branch's final-tier pool). The shared engine is now the real
  authorization; the route just confirms "some staff member is asking."
- **Admin is a hardcoded, always-on override at every step**, consistent
  with Admin's superuser status elsewhere in this app (already bypasses
  Coordinator-team scoping, sits in every `requireRoles` list) — but
  transparently flagged (`viaAdminOverride: true` on the trail entry) so
  the Approval Log can tell a real role-holder's decision from an override.
- **Financial Requests' Coordinator visibility is SELF-only, not
  team-scoped like Leave.** The original design deliberately excluded
  Coordinator from the whole review circle (money matters, a narrower
  circle than Leave) — self-submission reopens exactly enough of that door
  for a Coordinator to submit and then see their OWN request, never the
  company-wide queue the original 4 reviewer roles get.
- **The reimbursement receipt-download route was deliberately NOT widened**
  to `requireStaff` alongside the list route — `getReceiptFile()` has no
  per-claim ownership check (any id fetches any receipt), so opening it to
  every staff role would leak every OTHER employee's receipts to a
  Coordinator. It stays at the original Admin/Manager/HR/Accounts gate; the
  client hides the "Receipt" button for anyone who'd just get a 403 anyway.
- **`bulkApproveTimesheets` treats a mid-chain item as "skip," never
  "partial-advance."** A bulk "approve these 20" action is a full-approval
  action; silently turning one bulk click into 20 different partial step
  advances for 20 different downstream approvers would be confusing, not
  helpful. A per-id `decideApprovalStep` loop also means one row's 403
  (wrong step, or a race with another approver) is caught and counted as
  skipped rather than failing the entire batch.
- **The Approval Log shows only workflow-governed requests
  (`workflow != null`)**, not every legacy single-decision request too —
  it's specifically about the configurable hierarchy the user asked to be
  able to see ("so the COO/MM/FM/GM can see all this data"), not a general
  audit log (that's the existing Security Log).
- **A real bug found during Milestone 4 testing, fixed immediately**: a
  Coordinator who submitted their own Leave request couldn't see it
  afterward — `listLeaveRequests`'s Coordinator scoping only included
  employees they coordinate, not themselves. Fixed by including the
  actor's own employee id in that scope (their own request stays invisible
  to *decide*, still correctly blocked by `assertEmployeeScope` — a
  self-approval conflict-of-interest guard staying exactly as strict as
  before).

## Verified (2026-09-01)

Every milestone was verified by actually running it — curl scripts against
a throwaway admin plus real employees/logins (never the user's own
credentials), and a real browser click-through — with all test data deleted
after each pass.

- **Backend foundation**: create/list roles and workflows; a second
  workflow re-claiming an already-defaulted request type → 409; a bogus or
  inactive role id inside a step → 400; no-auth → 401.
- **The engine, proven on Leave**: a full HR→BDM 2-step chain to Approved
  with an accurate trail and `decidedBy` set to the final approver; an
  immediate rejection at step 0 (BDM never notified); a no-workflow request
  still deciding in exactly one legacy step; the next-step approver
  receiving a real in-app notification.
- **Client UI**: created roles/workflow through the actual browser UI using
  the user's own real names (GM, COO, HR), assigned the workflow to a test
  employee via `EmployeeForm`, confirmed it survived a hard reload from the
  server.
- **Decide-UI, staff self-submit, Approval Log**: a Coordinator submitted
  their own request through the new "Submit your own request" panel; HR
  and then BDM each saw Approve/Reject appear ONLY while it was genuinely
  their step and disappear once it moved on; the Approval Log showed the
  full trail to a real role member and a clear "You are not part of any
  approval role" error to a non-member.
- **Financial Requests**: the same engine proof repeated for both
  SalaryAdvance and ReimbursementClaim (including a real multipart receipt
  upload), plus confirming Coordinator's list view is genuinely self-only
  (never another employee's request), plus a full browser click-through of
  both new submit panels (advance and reimbursement) actually creating
  real, visible requests.
- **Timesheets**: the same engine proof, plus the bulk-approve redesign
  specifically: a batch of 3 mixed timesheets (one legacy-pending, one
  workflow-governed at its final step, one workflow-governed mid-chain)
  correctly returned `{requested: 3, approved: 2, skipped: 1}`, and the
  skipped mid-chain timesheet was independently re-fetched afterward and
  confirmed completely untouched (still step 0, still Submitted) — not
  silently advanced. Verified in the browser too: submitted a real
  timesheet through the new panel and saw it appear in the queue.
- **The full real-world scenario, both branches, end-to-end**: built the
  user's actual org chart (HR, BDM, MM, COO, FM approval roles, matching
  real staff logins), a "Standard Chain" (HR → BDM → any one of
  {MM,COO,FM}) set as the company default for Leave, and a "Finance Chain"
  (HR → any one of {MM,COO,FM}, BDM skipped) assigned ONLY via an
  Accountant employee's `approvalWorkflow` override. A Coordinator's leave
  request walked HR → BDM → COO to Approved (3-entry trail); an
  Accountant's leave request walked HR → MM to Approved (2-entry trail,
  BDM correctly 403'd if attempted); the final-tier pool was proven to mean
  "any ONE member," not "all three," by resolving it with a **different**
  person each time. Confirmed visually in the browser: COO's Approval Log
  view showed both full trails, correctly separated and labeled.
- **Regression**: the pre-existing legacy single-decision requests
  (`workflow` absent entirely, not just `null` — real documents predating
  this feature) rendered correctly in every review screen throughout
  testing, `ApprovalTrailView` correctly renders nothing for them, and
  `annotateCanDecide` correctly falls back to the original role check.

**Cleanup**: every throwaway admin, employee, login, role, workflow,
request, and notification created across all of this testing was deleted
afterward — nothing test-related remains in the database.

## What's next (not built, by design)

- SalaryAdvance/Reimbursement/Timesheet approval-hierarchy support is now
  complete alongside Leave — all 4 request types share one engine.
- A per-request-type override on `Employee` (currently one
  `approvalWorkflow` field applies to all 4 types uniformly) was flagged as
  a possible future enhancement in planning, not built now — no user
  scenario has needed it yet.

## Follow-up (2026-09-05): drag-and-drop step builder + pill multi-selects

The Workflows editor's step list and "applies to" picker were plain
checkboxes with an "Add step" button appending to the end — reordering a
step meant removing and re-adding it. The user asked for something more
visual: draggable, connected step cards, plus a nicer-looking multi-select
for both "applies to" and each step's role pool.

**New dependency, justified**: `@dnd-kit/core` + `@dnd-kit/sortable` +
`@dnd-kit/utilities` — the one real exception to this project's
Tailwind-only-no-library default in this session. Reasoning: touch-friendly,
accessible drag-and-drop has enough real edge cases (pointer vs. touch vs.
keyboard activation, collision detection, ARIA live regions for screen
readers) that hand-rolling it would be a much larger, riskier undertaking
than the ~30-line threshold this project otherwise holds new dependencies
to. Native HTML5 drag-and-drop was ruled out specifically because it does
not work on touch devices at all, which conflicts with this app's own
"touch-friendly" requirement. `npm audit` after installing showed zero new
vulnerabilities attributable to these three packages — the 9 pre-existing
findings are all transitive from `react-router-dom` and the Capacitor
toolchain, unrelated and untouched.

**Why reorderable cards, not a free-form node/graph canvas**: an
`ApprovalWorkflow`'s `steps` is a plain ordered array — strictly linear, no
branching, no parallel paths anywhere in `decideApprovalStep`. A full
graph-editing canvas (arbitrary boxes, arbitrary connections) would visually
promise flexibility the engine can't actually honor. Draggable cards with a
connector arrow rendered between consecutive ones give the same "connected
flow" feel while staying honest about the linear reality — and needed only
a sortable-list library, not a canvas/graph one.

**What changed** (`client/src/features/approvals/pages/ApprovalsPage.jsx`):
- `SortableStepCard` — each step is a `useSortable` item; only a dedicated
  grip-handle button carries the drag listeners (`{...attributes}
  {...listeners}`), so clicking a role pill or the label input never
  fights with starting a drag.
- `StepConnector` — a purely decorative down-arrow rendered between
  consecutive cards (not a drop target itself).
- `TogglePill` — one shared toggle-chip component now used for both
  "applies to" and each step's role selection, so the same multi-select
  interaction reads consistently in both places instead of pills in one
  spot and checkboxes in another.
- Reordering calls `useFieldArray`'s own `move(from, to)` on drag end
  (`handleStepDragEnd`) — not a hand-rolled splice — so step objects
  (label + roles together) move as one atomic unit and RHF's internal
  keys stay correct.
- `PointerSensor` (4px activation distance, so a click on a pill never
  reads as a drag) + `KeyboardSensor` (`sortableKeyboardCoordinates`) —
  reordering works by mouse/touch drag or by focusing the grip handle and
  using Space + Arrow keys + Space.

**Unchanged, on purpose**: this page's Admin-only gate — both the
client-side `if (!APPROVALS_MANAGE_ROLES.includes(user.role)) return
<Navigate to="/" replace />;` and the server's `requireRoles('Admin')` on
every role/workflow write route — was already exactly what the user asked
for ("only Admin can set this, nobody else") before this change, and
nothing here touched either gate.

**Verified (2026-09-05)**: `npm run build` clean. Browser, throwaway Admin:
pill toggles work (`aria-pressed` flips, fill color updates); a 3-step test
workflow rendered 3 grip handles and exactly 2 connectors (n-1, as
designed); a real pointer drag (`left_click_drag` on the grip handle)
correctly reordered step 1 and 2, with the step-number badges updating to
match — confirming the move touched the actual field-array data, not just
a visual swap; saved and re-fetched from the server showing the exact
reordered sequence (`Beta → Alpha → Gamma`).

**Keyboard reordering — root-caused, not just re-attempted.** A follow-up
pass traced the earlier inconclusive result to its actual cause, not the
`document.hidden` guess first suspected: attached a raw `keydown` listener
to the focused grip handle and confirmed the event *does* reach it (focus
and event routing are correct), but the synthesized key press's
`event.code` and `event.key` both arrive as **empty strings**, regardless
of casing (`"space"` vs `"Space"`) or which physical page state the pane
was in. `@dnd-kit`'s `KeyboardSensor` decides whether to start a drag by
checking `event.code` against `['Space', 'Enter']` — with an empty `code`,
it correctly (from its own logic's perspective) never activates. This is a
limitation of this specific browser-automation tool's synthetic key-event
dispatch (it doesn't populate the modern `code`/`key` properties real
hardware key presses always carry), not a bug in this app: the
`PointerSensor` + `KeyboardSensor` setup here is exactly `@dnd-kit`'s own
documented pattern, and a real keyboard press in an actual browser session
populates `event.code` correctly, which is all the sensor needs. Confirmed
via `npm ls` that nothing about the installed `@dnd-kit` versions is
unusual. **Net effect**: pointer-drag reordering is fully, conclusively
verified; keyboard reordering is implemented correctly per the library's
own documented API and *should* work, but couldn't be mechanically proven
inside this tool — a real person pressing Space/Arrow/Space on their own
keyboard is the only way to close that last gap, and is worth doing once
before leaning on it for accessibility compliance. All test data (this
pass created no saved workflow — the test was cancelled before submit —
plus 1 throwaway admin login) removed afterward.

## Follow-up (2026-09-05): the same pill treatment, everywhere it was missing

The Mobilisation Settings page's two role pickers (viewer roles,
self-mobilise roles) still looked like the *old* Approval Hierarchy —
checkboxes in a bordered scroll box — because they were a separate,
independently-written `RoleChecklist` copy, not the same component. Once
asked to fix it, checked for every other copy of this exact pattern rather
than just the one screen shown: found it duplicated verbatim a third time
in `CompanySettingsPage.jsx`'s "who else can manage this page" picker, and
the same visual shape (just a different item type — staff users, not
roles) in `ApprovalsPage.jsx`'s own "Members" list, which had been left as
checkboxes even after the step-role and applies-to pickers on that same
page became pills.

**Extracted a real shared component instead of fixing each copy in
place**: `client/src/components/ui/TogglePill.jsx` exports `TogglePill`
(the individual toggle button) and `PillChecklist` (items + selected +
onToggle → a `flex-wrap` of pills, with a configurable `getId`/`getLabel`
so it works equally for role objects, user objects, or a plain array of
type-string constants). `ApprovalsPage.jsx`'s own local `TogglePill` was
deleted in favor of the shared one, and its "applies to" and step-role
pickers were rewritten to go through `PillChecklist` too, so all four
pickers across three files now render from the exact same code rather than
four hand-copies that could each independently drift.

**Verified (2026-09-05)**, live, against real data: Mobilisation Settings
showed pills matching the true saved state (server confirmed empty —
the earlier screenshot's checked "GM" had apparently never actually been
saved); toggled GM on, saved, confirmed via the API it persisted
(`viewerRoles: [{name: "GM"}]`), then reverted it back to empty via a
direct API call so real settings weren't left altered by the test. Company
Settings' "who else can manage this page" pills render correctly with zero
checkboxes left on the page. Approval Hierarchy's "Members" picker (a real
16-user staff list) renders as pills labeled `Name (Role)`; the one
remaining checkbox on that page is the workflow's own "Active" toggle — a
single boolean, correctly left as a checkbox rather than forced into the
multi-select pill pattern. The real, currently-configured "Leave Workflow"
and a "Mobilisation workflows" chain (set up by the user between sessions,
confirming the earlier `APPROVAL_REQUEST_TYPES` fix is in active real use)
both opened and rendered their steps/role-pools/applies-to pills correctly
with no regression. All test data (1 throwaway admin) removed afterward.

## Follow-up (2026-09-06): Exit Re-Entry & Certificate join the engine

Prompted directly: *"BDM would also have to apply for... exit re entry and
certificates etc[,] but those things the workflow add that in the admin
panel so that admin can configure that workflow."* Two gaps closed at once:

1. **Self-submit** — a staff login (Manager/HR/Accounts/Coordinator/
   Executive) previously had no way to submit their OWN exit re-entry visa
   or certificate request; only the Worker ESS portal (`/api/me`) could.
   New `POST /api/exit-documents/exit-reentry` and
   `POST /api/exit-documents/certificates`, reusing the exact same
   `submitExitReentry`/`submitCertificate` service functions `/api/me`
   calls — same pattern as Leave/Timesheet/SalaryAdvance/Reimbursement's own
   staff self-submit routes. New client tabs "Submit Re-Entry"/"Submit
   Certificate" on the Exit & Documents page, hidden for Admin (no Employee
   record — same exclusion as Leave's `SubmitLeavePanel`).
2. **Admin-configurable workflow** — `ExitReentryRequest` and
   `CertificateRequest` gained the exact same `workflow`/`workflowName`/
   `steps`/`currentStep`/`approvalTrail` fields as `LeaveRequest`; their
   `submit`/`decide` functions now run through `resolveApprovalWorkflow`/
   `decideApprovalStep`/`annotateCanDecide`/`notifySubmission` — a `null`
   workflow still runs the exact original single-level flow
   (`LEGACY_DECIDE_ROLES = ['Admin','Manager','HR']`, unchanged). Both
   types added to `APPROVAL_REQUEST_TYPES` (server + client), so an Admin
   can now build an `ApprovalWorkflow` targeting either from the Approval
   Hierarchy page, same as any other request type.

**What deliberately did NOT change**: marking a request actually issued
(`PATCH .../issue`) stays a separate, static `Admin/Manager/HR`-only check
— a downstream HR/compliance recording step (Jawazat/Muqeem processing,
handing over a printed letter), not part of the approval chain itself, so
it was never folded into the engine.

**Route-gate broadened to match Leave's own pattern**: `list`/`submit`/
`decide` moved from a flat `requireRoles('Admin','Manager','HR')` to
`requireStaffOrExecutive` — once ApprovalRole membership is decoupled from
`User.role`, the route-level gate only needs to confirm "some staff member
(or Executive) is asking"; the engine is the real authority. Verified this
is genuinely enforced, not just decorative: a Manager (a legacy-eligible
role) was correctly **blocked** from deciding a request the moment a real
workflow governed it, while an Accounts-role ApprovalRole member (not in
`LEGACY_DECIDE_ROLES` at all) could decide it — proving the engine, not the
route gate, is what actually authorizes a decision.

**Two latent bugs found and fixed while integrating, in code this session
didn't originally touch:**
- `approvals.service.js`'s `LOG_SOURCES` map (backing the Approval Log
  page) had only ever contained `Leave` — SalaryAdvance/Reimbursement/
  Timesheet/Mobilisation all support workflows but were never added, so the
  Approval Log has silently never shown their trails. Added `ExitReentry`/
  `Certificate` now (required for this feature); the other four are a
  spun-off follow-up (task queued) since Mobilisation's different shape
  (`coordinators` are Users, not an Employee) needs its own verification
  before reusing this exact query shape.
- `ApprovalTrailView.jsx`'s "Step X of Y" in-progress badge was hardcoded
  to `request.status === 'PendingReview'` — Leave's own pending-status
  string, silently wrong for every other type reusing the same component
  (SalaryAdvance/Reimbursement/ExitReentry/Certificate use `'Pending'`,
  Timesheet uses `'Submitted'`). Fixed via a `pendingStatus` prop
  (default `'PendingReview'` for backward compatibility — existing callers
  unchanged, still carrying the old bug); the two new ExitReentry/
  Certificate call sites pass their real status explicitly. The four
  existing silently-affected callers are the same spun-off follow-up.

**Verified**: full curl suite covering both the legacy path (no-auth,
self-submit happy path + validation failure, Admin-has-no-employee 400,
wrong-role decide 403, correct-role decide 200, wrong-role issue 403,
correct-role issue 200) and the workflow path (create a real `ApprovalRole`
+ `ApprovalWorkflow` targeting `ExitReentry`, confirm a new submission
snapshots it, confirm a legacy-eligible-but-non-member role is now
blocked, confirm the real ApprovalRole member can decide it, confirm the
Approval Log lists it). Certificate spot-checked (submit/decide/PDF
generation still working). Browser-verified: a Manager sees all 4 tabs
(2 review + 2 submit) with the trail view rendering the workflow name,
step label, approver, decision, timestamp, and note correctly; Admin sees
only the 2 review tabs (no Submit — no Employee record) with "Mark issued"
correctly available. All throwaway employees/logins/requests/role/workflow
removed by exact id afterward (checked collection contents first — this is
the real production Atlas cluster).
