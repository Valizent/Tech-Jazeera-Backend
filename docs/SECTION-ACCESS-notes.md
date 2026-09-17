# Section Access

## What it is

A generic, admin-configurable "who else can open this section" mechanism —
prompted directly by the user asking: *"can we make admin make any tab or
section accessible to specific roles? Like admin can make payroll open to
accounts and FM but keep... no access... for other roles like MM or COO?"*

This is the same indirection Company Settings' `manageRoles` and
Mobilisation Settings' `viewerRoles`/`selfMobiliseRoles` each built
independently for their own one module, extracted into a reusable mechanism
so a third (and any future) module doesn't grow its own bespoke copy again.

## Design

- `SectionAccess` (`server/src/modules/sectionAccess/sectionAccess.model.js`)
  — one document per `sectionKey` (`payroll`, `expenses` today). Two
  independent grants per section:
  - `allowedRoles` — literal `User.role` values (e.g. `Accounts`).
  - `allowedApprovalRoles` — `ApprovalRole` ids (e.g. an admin-named
    "Financial Manager" or "COO" role) — a grant tied to a real person
    regardless of their login role, reusing the exact membership check
    (`isMemberOfAnyRole`) the Configurable Approval Hierarchy already uses.
- **Floor, not a bypass**: `requireSectionAccess(sectionKey)`
  (`sectionAccess.middleware.js`) first rejects Worker/Staff outright — same
  floor `requireStaff`/`requireStaffOrExecutive` enforce everywhere else —
  then checks `canAccessSection`. Admin always passes, unconditionally, so
  an Admin can never configure themselves out of a section they built.
- **A section nobody has configured yet** falls back to a hardcoded
  `DEFAULT_ALLOWED_ROLES` in `sectionAccess.service.js` (`Accounts` for both
  Payroll and Expenses) — preserves each section's real pre-existing
  operational owner rather than an empty "nobody but Admin" surprise the
  moment this shipped.
- **Changing access itself is Admin-only**, full stop — no broader circle
  (unlike Company Settings, where the broader `manageRoles` editor set can
  still edit company details, just not decide who else can). Deciding who
  gets into Payroll is not itself delegable to whoever that grant creates.

## What changed in Payroll/Expenses

Both modules previously had three role tiers (`requireRoles` for read,
write, and finalize/delete separately — e.g. Payroll's read circle was
`Admin/Manager/HR/Accounts`, write was `Admin/Manager/Accounts`, finalize
was `Admin/Manager` only). Per the user's explicit framing — *"only the
financial manager COO should have this access to do whatever they want...
add those roles to the accountant's access also"* — this collapsed to
**one unified circle per section**: whoever `requireSectionAccess` lets in
gets full read/write/finalize/delete, no sub-tiers. Manager and HR lost
their previous default access entirely (an Admin can re-grant either
explicitly from the new Section Access page); Accounts kept full access,
now including finalize/delete which it previously lacked.

Client-side, `PAYROLL_VIEW_ROLES`/`PAYROLL_WRITE_ROLES`/
`PAYROLL_FINALIZE_ROLES` and their Expense equivalents are gone — the
Payroll/Expenses nav items and pages no longer branch on `user.role` at
all; a 403 renders the page's own "You don't have access" `EmptyState`
(same dynamic-eligibility pattern Company Settings/Approval Log already
use), and a successful load implies full action access.

## Nav

`Payroll`/`Expenses` lost their static `roles` gate in `navConfig.js` (now
visible to any staff-tier role that reaches the Financial hub, same as
Company Settings) and were added to `EXECUTIVE_NAV_ITEMS` — without that,
an Executive-role login (the real-world seat for a COO/Financial Manager)
granted access via an ApprovalRole would have no way to click through to a
page their own hardcoded flat nav never included.

## New admin page

`Admin & Tools → Section Access` (Admin-only, same client-side redirect
pattern as the Approval Hierarchy page) — one card per governed section,
each with two `PillChecklist` pickers (login roles; approval roles) and its
own Save. Verified live: the real org-chart `ApprovalRole`s already in this
company (GM/COO/MM/FM/BDM/HR/Accountant/Coordinator) show up directly in
the approval-role picker — an Admin can grant "FM" or "COO" access to
Payroll right now, no further setup needed.

## Bug found and fixed during verification

`requireSectionAccess` is async (it queries the DB) but was not wrapped in
`asyncHandler` — a thrown `ApiError` inside it became an unhandled promise
rejection and **crashed the entire Node process** instead of returning a
clean 403 (the exact failure mode `asyncHandler`'s own doc comment warns
about, applied to every controller in this codebase already — I just missed
applying it to my own new middleware). Fixed by wrapping the returned
function in `asyncHandler`, matching `requireAuth`'s own pattern. Confirmed
via a full curl-based test suite: no-auth → 401, wrong role → 403 (crashed
the server before the fix), grant → 200, non-admin managing access → 403,
invalid section key → 400, ungrantable role (`Worker`) → 400.

## Verification

Full curl suite (11 checks: happy path, auth failure, wrong-role failure
before AND after a live grant, validation failures) — see git history for
the throwaway script (not committed). Browser-verified with three throwaway
logins (Admin, Manager, Accounts): Manager correctly blocked from Payroll
by default and shown a clear "you don't have access" page with no dangling
"Run payroll" button; Accounts gets full read/write access including the
"Run payroll" action; the Section Access page itself renders both sections
with real approval-role options and persists a save correctly (spot-checked
by granting FM access to Payroll, confirming via API, then reverting).
All throwaway accounts/employees/section-access overrides cleaned up
afterward — the two sections are back to their out-of-the-box default
(`Accounts` only, no approval-role grants).

## Follow-up: a third section — `employeeCreate`

Reused for a second, unrelated ask: *"only office secretary... assigned by
admin... until then only admin can add employees."* Added `employeeCreate`
to `SECTION_KEYS` (default `[]` — nobody but Admin), wired
`POST /api/employees` to `requireSectionAccess('employeeCreate')` in place
of its old static `requireRoles('Admin','Manager','HR','Coordinator')`. An
Admin designates the "office secretary" (any role — the whole point) by
putting them in a named `ApprovalRole` and granting it from the Section
Access page. Coordinator's old self-team-creation override in
`employee.service.js` still exists and still works when re-granted; it's
just no longer a blanket default.

**New endpoint**: `GET /api/section-access/:sectionKey/mine` — any
authenticated user (not Admin-only), returns `{ allowed }` for the caller
only. Added so `EmployeeListPage.jsx` can decide whether to even show the
"Add employee" button without a wasted full-form-fill ending in a 403; moved
the Worker/Staff role floor from the route middleware into `canAccessSection`
itself so both this endpoint and `requireSectionAccess` share one copy of it.

Also removed genuinely dead code found in the same pass: a client-side
`SECTION_ACCESS_SECTIONS` constant (labels/descriptions) that was defined
but never imported anywhere — `SectionAccessPage.jsx` only ever used the
server's `label` field. Moved `description` into the server's
`SECTION_LABELS`-adjacent map instead of resurrecting the unused client
constant, so section metadata has one source of truth.

**Real pre-existing bug found and fixed during verification** — unrelated
to Section Access itself: a Coordinator's create form let them pick
"Own — internal staff" as the type, which the server always overrides to
'Client' (a Coordinator can never create an internal-staff record — see
`employee.service.js`). Because that override runs in the service, AFTER
Zod validation, a Coordinator submitting `type: 'Own'` with no
nationality/mobile/joiningDate (all optional for 'Own' per Zod, exactly as
the form's own help text says) would pass validation, get flipped to
'Client' server-side, and then fail Mongoose's schema-level required fields
for a document whose fields were never marked required for what the user
actually selected — a confusing 400 for a real Coordinator following the
form's own guidance. Fixed at the root: `EmployeeForm.jsx` no longer offers
'Own' as a choice when the actor is a Coordinator, so the type they submit
always matches the type they end up with. Verified end-to-end via the API:
a Coordinator granted `employeeCreate` access, submitting the fields the
now-correct form would actually collect for 'Client', successfully creates
an employee force-assigned to themselves as coordinator.

## Reconciliation M1: Company Settings, and a real bug fix

Two older modules (Company Settings, Mobilisation Settings) had each built
their own one-off version of "who else can open this" before Section Access
existed. Plan: fold both into the generic mechanism instead of maintaining
three copies of the same idea.

**Bug found while touching this code**: `GRANTABLE_ROLES` (server model) and
the Zod enum both included `'Office Secretary'`, and the client's own
`SECTION_ACCESS_GRANTABLE_ROLES` happened to already exclude it — masking a
silent no-op by accident, not fixing it. `canAccessSection`'s hard floor
(`STAFF_ROLES.includes(actor.role)`) excludes Office Secretary unconditionally
(see its own doc comment: it reaches things only via `ApprovalRole`
membership on a workflow step, never a blanket per-section grant), so an
Admin picking it in the UI saved fine and granted nothing. Fixed by removing
`'Office Secretary'` from `GRANTABLE_ROLES` (`sectionAccess.model.js`) instead
of widening the floor to admit it.

**Company Settings → `companySettings`**: `manageRoles` was already a pure
boolean gate (`canManageCompanySettings`, checked once per controller
action), so this was a low-risk swap. Added `companySettings` to
`SECTION_KEYS`, default `allowedRoles: ['Manager']` — matches the old
hardcoded `actor.role === 'Manager'` branch exactly. `canManageCompanySettings`
is gone; every controller action now calls `canAccessSection('companySettings',
actor)` directly. `PATCH /company-settings/manage-roles` (the old dedicated
endpoint), `updateManageRoles`, and `CompanySettingsPage`'s own manage-roles
UI block are all removed — an Admin configures this from the Section Access
page now. The real production `CompanySettings` singleton had no
`manageRoles` set yet, so there was nothing to migrate — the new
`companySettings` `SectionAccess` doc was created directly with the default.

Verified: curl'd `GET/PATCH /api/company-settings` as Manager (200, matching
the default) and as HR (403), then via the Section Access page granted HR
access and confirmed the 403 flipped to 200; reverted the grant afterward.
Browser-confirmed the Section Access page renders the new `companySettings`
card and `CompanySettingsPage` no longer shows its old manage-roles block.

## Reconciliation M2: Mobilisation Settings — two new keys

The harder of the two reconciliations flagged in the plan: `viewerRoles`/
`selfMobiliseRoles` were never simple route gates — `viewerRoles` was woven
into `listMobilisations`' MongoDB `$or` visibility filter and
`getMobilisation`'s status-conditioned `REVIEW_FIELDS`/`COMMERCIAL_FIELDS`
stripping; `selfMobiliseRoles` backed a 3-way hardcoded
`Admin || Coordinator || isMemberOfAnyRole(...)` check in `createMobilisation`.

Added two keys to `SECTION_KEYS`:
- **`mobilisationsSelfMobilise`** (default `allowedRoles: ['Coordinator']`,
  folding in the old hardcoded Coordinator bypass) — a simple boolean gate,
  ported directly: `createMobilisation`'s 3-way check collapsed to one
  `canAccessSection('mobilisationsSelfMobilise', actor)` call. **Real
  behavior change, flagged in the plan up front**: Coordinator's
  create-permission moves from hardcoded/unchangeable to
  default-on-but-admin-editable — verified live (see below) that an Admin
  really can now revoke it.
- **`mobilisationsViewer`** (default `allowedRoles: []`, migrated
  `allowedApprovalRoles`) — not a route gate, so the swap is a new shared
  helper, `isMobilisationViewer(actor, precomputedRoleIds)` in
  `mobilisation.service.js`, used by both `listMobilisations`' visibility
  filter and `getMobilisation`'s access check. Checks `allowedRoles` first (a
  literal login-role match — the "bonus consistency win" the plan called out,
  since the old `viewerRoles` field never supported this), then
  `allowedApprovalRoles` membership. `listMobilisations` passes its
  already-fetched `roleIds` (computed once per request for the
  PendingReview step-reviewer check too) to skip a second `ApprovalRole`
  query; `getMobilisation` has no such list lying around, so it falls
  through to `isMemberOfAnyRole`'s single indexed lookup instead — same
  query shape the pre-reconciliation code used. The surrounding filter/strip
  logic in both functions is untouched, per the plan's own design principle.

**Data migration** (one-off, not committed — same throwaway-script posture as
every other real-data migration in this app): read the real
`MobilisationSettings` singleton's `viewerRoles`/`selfMobiliseRoles`
(`['BDM']` and `['MM']` respectively, the company's actual configured
roles), wrote them into the two new `SectionAccess` docs'
`allowedApprovalRoles` (folding `Coordinator` into
`mobilisationsSelfMobilise.allowedRoles` per the default above), then
`$unset` the two fields from the `MobilisationSettings` document (the schema
no longer declares them). Idempotent (upsert + unset), safe to re-run.

`MobilisationSettings` shrinks to just `officeSecretaryStaleDays` — the one
field in that singleton that isn't an access grant. `MobilisationSettingsPage`
shrinks to match (just the stale-days input, plus a pointer link to the
Section Access page); the two `PillChecklist` role editors and the
`listApprovalRoles` query they needed are gone from that page.

**Verified live** (throwaway test admin, a test Coordinator login, and a
test HR login, all `@example.com`, cleaned up after):
- Coordinator creating a mobilisation → 201 (default grant); HR → 403 (not
  granted by default).
- Admin removed `Coordinator` from `mobilisationsSelfMobilise.allowedRoles`
  → the same Coordinator login immediately got 403 on create — confirms the
  flagged behavior change is real, not just theoretical. Restored afterward.
- HR (no viewer grant) `GET` on the Coordinator's Draft mobilisation → 403.
  Admin then granted HR literal-role access via `mobilisationsViewer.
  allowedRoles` → HR still got 403 on the same Draft record (Draft stays
  excluded for every viewer, granted or not) — but successfully `GET` a real,
  pre-existing `PendingReview` mobilisation with `clientRate` (a
  `COMMERCIAL_FIELDS` member) present and unstripped, confirming a granted
  viewer sees the full record once it's past Draft. Reverted the grant
  afterward.
- `GET /api/section-access` confirmed both new keys list with the migrated
  defaults (`BDM`→viewer, `Coordinator`+`MM`→self-mobilise) both immediately
  after migration and again independently after a full cleanup pass, via a
  second fresh throwaway admin.
- Browser: `SectionAccessPage` renders both new cards with the correct
  label/description and the right pills pre-selected (checked via each
  card's actual DOM state, not just the API response); `MobilisationSettingsPage`
  renders as just the stale-days field with a working link back to Section
  Access.

All test users, employees, the throwaway mobilisation record, and their
audit-log rows were deleted afterward (the mobilisation module has no
delete-a-record endpoint, so that one record was removed via a direct,
throwaway DB script alongside the rest of the cleanup) — production data is
back to exactly its post-migration state.

## M3: financial/sensitive whole-module batch

Six new keys, each governing its whole module rather than a write-only
slice: `invoices`, `eosb`, `financialRequests`, `auditLog`,
`timesheetProcessor`, `nfc`.

- **`invoices`** (default `['Manager','Accounts']`) — GET/POST/payments all
  behind one gate; delete stays hardcoded Admin/Manager (an extra safety
  rail, same posture as Quotations). **Real behavior change, flagged up
  front**: read narrows from "any staff" to this circle — deliberate, per
  the financial-document classification.
- **`eosb`** (default `['Manager','HR','Accounts']`) — the one section that
  folds delete INTO the unified gate rather than keeping it hardcoded
  separately, unlike Invoices: EOSB's delete was already the same tier as
  create (no stricter delete-only circle existed to preserve), so nothing
  is lost by collapsing it. **Real behavior change**: Accounts gains
  create/delete rights it didn't have before — the same "one unified
  circle" collapse Payroll/Expenses already went through.
- **`financialRequests`** — see its own subsection below; this one needed a
  real design correction mid-implementation.
- **`auditLog`/`timesheetProcessor`/`nfc`** (all default `[]`) — simple
  `requireRoles('Admin')` → `requireSectionAccess(key)` swaps, functionally
  identical to today until an Admin grants someone.

### A real design flaw found and fixed: `financialRequests`

First attempt: swapped ALL SIX `requireStaffOrExecutive` occurrences on
`/api/financial-requests` (list/submit/decide for both advances and
reimbursements) to `requireSectionAccess('financialRequests')`, default
`['Manager','HR','Accounts','Executive']`. This broke a real, working
feature: the router's own doc comment explains Coordinator was always able
to reach `POST /advances` (submit) and `GET /advances` (self-scoped list)
under the original `requireStaffOrExecutive` gate — Coordinator IS a
`STAFF_ROLE` — and the Approval Hierarchy's staff self-submission work
(P2-M4+) relies on exactly that: a Coordinator submitting their own advance/
reimbursement and seeing only their own in the list. My new default
excluded Coordinator, silently blocking both. **Caught before shipping**,
not after — verified live and found the regression myself. Fixed by
reverting LIST and SUBMIT (all four: advances + reimbursements) back to
`requireStaffOrExecutive`, unchanged, and moving ONLY the two DECIDE
endpoints onto `requireSectionAccess('financialRequests')`.

That fix surfaced a second, deeper issue: DECIDE for a workflow-governed
request isn't really authorized by a static role list at all — the shared
`approvalEngine`'s `resolveStepAuthority` grants it to ANY real ApprovalRole
member on the current step, which could legitimately be a Coordinator
(exactly like the company's real Mobilisation hierarchy already allows a
Coordinator-tier role to hold a step). A Section Access floor sitting IN
FRONT of that check, if narrower than the engine's own reach, would
silently block a workflow-authorized decider before the engine ever ran —
the router would 403 first. Fixed by widening `financialRequests`'s default
to `['Manager','HR','Accounts','Coordinator','Executive']` — the FULL
original `requireStaffOrExecutive` floor, not narrowed at all. This makes
the section, by default, a genuine no-op (matching zero-regression), while
still giving an Admin a real, working lever to narrow it later if they
choose — the actual point of Section Access. `canHandleMoney` (repayments,
receipt view, marking paid) was never touched — stays its own hardcoded
Admin/Manager/HR/Accounts circle throughout.

**Lesson applied to M7 below**: before gating ANY workflow-governed
request's floor, check whether the floor sits in front of the engine's own
per-step authority check — if so, the default must match the ORIGINAL
floor's full reach, not a "sensible-looking" subset.

## M4: workforce/operational write-only batch

Six new keys, each governing only the write actions on an otherwise
read-open module: `clientsManage`, `deploymentsManage`,
`subcontractorsManage`, `attendanceManage`, `documentsManage`,
`assetsManage`.

- **`clientsManage`** (default `['Manager','Coordinator']`) — folds
  create/update/decide into one gate. Decide's floor technically widens
  from Admin/Manager to also admit Coordinator by default, but
  `client.service.js`'s own "must be THIS coordinator's manager" check
  (unrelated to this migration, untouched) still gates the actual decision
  — a low-risk widening in practice, flagged here for visibility. Delete
  stays hardcoded Admin/Manager.
- **`deploymentsManage`** (default `['Manager']`) — assign/transfer/end,
  matches the old Admin/Manager circle exactly. No delete route exists.
- **`subcontractorsManage`** (default `['Manager']`) — folds delete in too
  (same reasoning as EOSB: no stricter pre-existing delete-only tier).
- **`attendanceManage`** (default `['Manager','HR']`) — governs only
  `POST /bulk` and `PATCH /adjust`. Office-location config stays hardcoded
  Admin-only, untouched.
- **`documentsManage`** (default `['Manager','HR']`) — folds
  create/version/delete into one gate (same reasoning as EOSB/
  Subcontractors: create and delete already shared one tier).
- **`assetsManage`** (default `['Manager','HR']`) — covers
  create/update/status/assign/return (the whole `canWrite` tier). Delete
  stays hardcoded Admin/HR — a genuinely stricter pre-existing circle
  (excludes Manager), kept as the extra safety rail.

## M5: remaining batch

Four new keys: `quotationsManage`, `ramadanManage`, `team`,
`approvalHierarchy`.

- **`quotationsManage`** (default `['Manager','Accounts']`) —
  create/update/duplicate; delete stays hardcoded Admin/Manager.
- **`ramadanManage`** (default `['Manager','HR']`) — folds delete in
  (same reasoning as EOSB/Subcontractors/Documents).
- **`team`** (default `['Manager','HR']`) — governs only
  `GET /api/users` (the staff-login list). Update/reset-password/delete
  stay hardcoded Admin-only — account security management is too sensitive
  to delegate broadly, a deliberate exclusion, not an oversight.
- **`approvalHierarchy`** (default `[]`) — governs only the four
  POST/PATCH endpoints for roles and workflows. `GET /roles`/`GET
  /workflows` stay `requireStaff` (open to any staff), unchanged — many
  other pages' role-pickers read this list. The Approval Log (`/log`) is
  untouched — already dynamically gated inside its own controller.

## M6: client-side wiring pass

- **Nav `sectionKey` wiring** (`navConfig.js`) — whole-module M3 sections
  (`invoices`, `eosb`, `auditLog`, `timesheetProcessor`, `nfc`) plus `team`
  each replaced a static `roles: [...]` gate (or, for Invoices, added a gate
  where none existed) with `sectionKey: '...'`, so the nav item — and the
  hub-page card, via the same `SectionHubPage.jsx`/`DashboardLayout.jsx`
  filter — hides entirely for a non-granted viewer, same mechanism Payroll/
  Expenses already used. `approvalHierarchy`'s nav item lost its
  `roles: ['Admin']` gate entirely instead (read is open to everyone now;
  see below).
- **`ApprovalsPage.jsx`** — removed a hard `if (!APPROVALS_MANAGE_ROLES...)
  return <Navigate>` that gated the ENTIRE page (both Roles and Workflows
  tabs) behind Admin, even though the server's own read endpoints were
  already open to any staff member. Now any staff member can view the page;
  each panel (`ApprovalRolesPanel`, `ApprovalWorkflowsPanel`) independently
  checks `user.sectionAccess?.includes('approvalHierarchy')` to show/hide
  its own "Add role"/"Add workflow" button and the modal's Save button
  (non-granted viewers get "Close" only — they can still open an existing
  role/workflow to read it, just not save changes).
- **Write-only button wiring** — every M4/M5 write-only page's
  `canWrite`/`canCreate`/`canDelete` check swapped from a static role-array
  `.includes(user.role)` to `user.sectionAccess?.includes('sectionKey')`
  (`ClientListPage`, `clients.permissions.js`, `DeploymentListPage`,
  `WorkerDeploymentPanel`, `SubcontractorListPage`, `RecordsGrid`'s
  `canEdit`, `DocumentListPage`, `DocumentsPanel`, `DocumentActionsCell`,
  `AssetListPage`, `QuotationListPage`, `QuotationsPanel`,
  `QuotationViewPage`). Delete-only checks that stayed hardcoded
  server-side (Invoices, Quotations, Assets) were left as literal role
  checks client-side too, matching the server exactly.
- **Whole-module pages simplified** — `InvoiceViewPage`/
  `SettlementListPage`/`SettlementViewPage` dropped their `canWrite`/
  `canCompute`/`canDelete`(-for-the-whole-module) checks entirely: reaching
  the page at all already implies full access for a whole-module section
  (successful load ⇒ full action access), same posture as Payroll/Expenses.
  `EmployeeProfilePage`'s "Compute EOSB" button switched to
  `user.sectionAccess?.includes('eosb')`.
- **`SectionAccessPage.jsx` grouping** — ~20 sections is too many flat
  cards to scan, so they're now grouped under the same
  Workforce/Sales & Clients/Financial/Admin & Tools categories the sidebar
  itself uses (`navConfig.js`'s `NAV_GROUPS`), each collapsible via native
  `<details>`/`<summary>` (no new dependency for a one-off grouping need).
  Browser-verified: all 22 cards render under the correct category header
  with the right counts (4/6/4/8), collapse/expand works, and each card's
  pre-selected pills still match the real server data.
- **`constants.js` cleanup** — every now-dead static role-list constant
  superseded by a Section Access key was removed (`CLIENT_WRITE_ROLES`,
  `CLIENT_CREATE_ROLES`, `CLIENT_DECIDE_ROLES` — the last one was already
  dead before this pass, found in the same sweep — `DEPLOYMENT_WRITE_ROLES`,
  `SUBCONTRACTOR_WRITE_ROLES`, `SUBCONTRACTOR_DELETE_ROLES`,
  `DOCUMENT_WRITE_ROLES`, `DOCUMENT_DELETE_ROLES`, `ASSET_WRITE_ROLES`,
  `QUOTATION_WRITE_ROLES`, `INVOICE_WRITE_ROLES`, `EOSB_WRITE_ROLES`,
  `EOSB_VIEW_ROLES`, `STAFF_USER_VIEW_ROLES`, `APPROVALS_MANAGE_ROLES`,
  `FINANCIAL_REQUEST_DECIDE_ROLES` — also already dead beforehand).
  `SECTION_ACCESS_GRANTABLE_ROLES` was already correct (M1 had already
  fixed it) — confirmed against the server's `GRANTABLE_ROLES`, no change
  needed.
- **Two more real pre-existing bugs found while migrating, both fixed**:
  - `QuickActions.jsx`'s "Add employee" dashboard shortcut checked
    `EMPLOYEE_WRITE_ROLES` (Admin/Manager/HR — the EDIT circle) instead of
    the real `employeeCreate` Section Access gate (Admin only by default) —
    a shortcut that could 403 for a role the button itself invited in.
  - `RamadanPeriodsSection.jsx` checked `HOLIDAY_MANAGE_ROLES`
    (`['Admin','HR']`, the Holiday calendar's own Admin/HR-only circle) for
    its own Add/Edit/Delete buttons, instead of anything Ramadan-specific —
    Manager could always manage Ramadan periods server-side
    (`requireRoles('Admin','Manager','HR')`, unchanged by this migration)
    but the button was silently hidden from them. Both now use the correct
    section grant.

Browser-verified end-to-end with two throwaway logins (Manager, Coordinator):
Coordinator's sidebar loses the entire Financial group (none of
`invoices`/`payroll`/`expenses`/`financialRequests`'s nav gates admit them)
and loses `Team`/`Timesheet Processor`/`NFC Customers`/`Security Log` from
Admin & Tools, while `Approval Hierarchy` stays visible and read-only (its
"Add role" button confirmed absent, and opening an existing role showed
"Close" with no "Save"); Manager's sidebar shows `Invoices`, `Financial
Requests`, and `Team` (all granted), matching their real defaults exactly.
Clients' "Add client" button confirmed present for Coordinator (default
grant) with real rows visible and editable.

## M7 (optional): Leave/Timesheets/Exit-Documents zero-regression floor

Flagged in the plan as optional, shipped since it's genuinely
zero-regression and the same admin-configurability now covers every
workflow-governed request type. Three new keys — `leaveRequests`,
`timesheetRequests`, `exitDocuments` — each replacing a router-wide
`requireStaffOrExecutive` with `requireSectionAccess(key)`, default
`['Manager','HR','Accounts','Coordinator','Executive']` — the FULL original
floor, not narrowed (applying the lesson from `financialRequests` above:
these three are workflow-engine-governed request types too, so the floor
must never be narrower than `requireStaffOrExecutive` was, or it risks
blocking a legitimate engine-authorized decider). Unlike
`financialRequests`, no per-route carve-out was needed here — each of these
three routers already applied ONE uniform floor to every action (list/
submit/decide, plus bulk-approve/monthly-report for Timesheets), so
migrating the whole router's floor in one move is safe: nothing is being
narrowed relative to what already existed. `LeaveType` config
(Admin/HR-only), `acknowledge` (its own narrower Admin/Manager/HR/
Coordinator circle), and both modules' `issue`/`markIssued` actions
(Admin/Manager/HR) all stay exactly as they were — untouched, deliberately
excluded per the plan's own design principles. No client changes needed:
none of the three modules' nav items had a role gate to begin with (already
open to every staff role who reaches the hub), so the new wide-open default
changes nothing to hide or show.

Verified live: all three new keys return the exact
`requireStaffOrExecutive`-matching default; a throwaway Coordinator login
confirmed full zero-regression access to all three (list/submit on Leave,
Timesheets, and Exit Documents, none blocked); a flip test on
`leaveRequests` (narrow → Coordinator blocked with 403 → revert → access
restored) confirmed the grant is genuinely enforced, not just returned by
the API.

## Full verification summary (M3–M7)

Every milestone above was verified with real curl-equivalent checks
(a throwaway Node script per pass, using `fetch` directly against the
running dev server) against real production MongoDB, using disposable
`@example.com` test accounts created via the real employee-provisioning
API and deleted afterward — never the user's own credentials or data.
Total: 69 checks (M3–M5 combined pass) + 5 (the `financialRequests` fix)
+ 39 (a second M3–M6 pass after the fix, including a fresh independent
re-read of all 22 section defaults) + 14 (M7) = 127 passing checks across
four separate verification runs, plus the browser-based nav/button/page
checks described above. All temporary employees, logins, audit-log rows,
and section-access overrides created for testing were removed after each
pass — production data was independently re-verified back to its expected
state (not just assumed) after the final pass. `npm run build` (client)
passed cleanly after every batch of edits, with zero unused imports or
broken references across the ~35 files touched.

## Read/Write split COMPLETE

Prompted by the user's own follow-up, looking at this exact page: every
section here was a single on/off grant. What they wanted instead — "so
basically whoever has read access should get section access with read only
access, whoever has read and write access should get read and write access"
— confirmed, after discussion, to apply to **every** section (not just the
already-bundled financial ones), with Read defaulting to mirror each
section's existing Write default **literally, no exceptions** — including
the handful of sections whose Write default was empty/Admin-only by design
(Adding Employees, Approval Hierarchy, Deployments), which the user was
shown would immediately hide those from most staff, and chose anyway.

### Mechanism

`SectionAccess` gained two full tiers instead of one grant:
`readRoles`/`readApprovalRoles` and `writeRoles`/`writeApprovalRoles` (the
old `allowedRoles`/`allowedApprovalRoles` were renamed to `writeRoles`/
`writeApprovalRoles`, since that's what they actually controlled for the
vast majority of sections). `canAccessSection(key, actor, level)` — Write
always implies Read; a Write grantee never needs listing in both places.
`getMySectionAccess` now returns `{ read: [...], write: [...] }`, threaded
through to the client as `user.sectionAccess` (read — every existing nav
visibility check keeps working unchanged) and a new `user.sectionAccessWrite`
(every existing write-gated button, ~16 spots across the client, repointed
to it).

A one-time migration (`server/src/scripts/migrate-section-access-tiers.js`,
`npm run migrate:section-access-tiers`) categorized the 17 already-configured
live sections: for the two whose single grant already meant "can view", not
"can write" (`mobilisationsViewer`, `team` — see the model's doc comment for
why neither has a real write action tied to its key at all), the existing
grant became the Read tier only, Write starting empty. Every other section's
existing grant was copied into **both** tiers, preserving today's real
access exactly on day one — the admin can since diverge them per section.

**A real bug found while wiring this in**: `mobilisation.service.js`'s
`isMobilisationViewer` read `settings.allowedRoles`/`.allowedApprovalRoles`
directly (bypassing `canAccessSection` entirely) — a field-name rename would
have silently broken it (`undefined.includes(...)` — a runtime crash on
every mobilisation list/read for anyone relying on that Section Access
grant). Fixed to read `readRoles`/`readApprovalRoles`, matching the same
"pure-read key" categorization as `team`. Also found: `team`'s own route was
calling `requireSectionAccess('team')` with the implicit `'write'` default —
since `team`'s write tier is now permanently empty, this would have 403'd
every Manager/HR login out of the staff list. Fixed to pass `'read'`
explicitly. Both were caught during implementation, before any live
verification — a reminder that a field-shape change needs a full-codebase
grep for every direct reader, not just the obvious call sites.

Real Read gates were added to every previously-ungated `GET` route across
~19 route files (Clients, Quotations, Subcontractors, Documents, Assets,
Attendance, Employees, Approval Hierarchy roles/workflows, Deployments,
Team, Ramadan Periods) and split into explicit Read/Write pairs on the
already-unified single-gate modules (Payroll, Expenses, Invoices, EOSB,
NFC, Company Settings, Audit Log, Leave/Timesheet/Exit-Documents requests).
Deliberately **untouched**: every hardcoded `requireRoles(...)` rail that
was already carved out of Section Access by prior design (Employee edit/
delete/login-management, Team edit/reset/delete, Client/Quotation/Asset
delete, Attendance office-location, Financial Requests' money-movement
endpoints, Exit Documents' issue endpoints) — none of these were folded in;
Financial Requests' list/submit stay on the broader `requireStaffOrExecutive`
floor, unchanged; Mobilisation routes gained no new gate at all, since
visibility there is computed per-record, not as a blanket section (see
`findVisibleMobilisations`/`getMobilisation`). `ramadanManage`'s new read
gate was confirmed safe first — grepped the whole client for any ESS/Worker
code calling that route directly (none does; the Ramadan-aware overtime
calculation reads the model server-side, never through the route).

Deployments needed one more real fix beyond the standard pattern: its GET
routes needed to admit Office Secretary (who is otherwise deny-by-default
for Section Access entirely, per `canAccessSection`'s own floor) — added a
small inline middleware wrapper in `deployment.routes.js`, mirroring the
existing write-side Office Secretary bypass already in
`deployment.service.js`'s `addMonthlyHours`.

### Client

- New `components/shared/RequireSectionRead.jsx` — a router-level guard
  wrapping ~20 routes in `router.jsx` via a small `guarded(sectionKey,
  element)` helper; renders a clear "you don't have access" `EmptyState`
  with a link home instead of a page attempting and failing every request.
- `navConfig.js` gained `sectionKey` on every nav item that didn't have one
  yet (Employees, Attendance, Clients, Deployments, Quotations,
  Subcontractors, Documents, Assets, Approval Hierarchy, Leave, Timesheets,
  Exit & Documents) — the existing `DashboardLayout.jsx` filter already
  checked `sectionKey`, so no filter-logic changes were needed, only data.
  Mobilisations' nav item deliberately stays ungated (same per-record
  reasoning as the route).
- `SectionAccessPage.jsx`'s `SectionCard` grew from 2 checklists (roles,
  approval roles) to 4 — a Read pair and a Write pair, each with its own
  short hint, reusing a new shared `TierChecklists` sub-component rather
  than duplicating the `PillChecklist` wiring twice.

### Verified (2026-09-08)

Migration run against the real dev Atlas DB; re-queried directly afterward
to confirm all 17 documents landed in the correct tier per the
categorization (spot-checked one from each group). `npm run build` (client)
clean; server boots clean. curl, three throwaway logins (Admin, Manager,
Office Secretary — deleted after, along with their refresh tokens/audit
rows): Manager's `read`/`write` arrays from `/auth/login` matched the
migrated defaults exactly (`team`/`mobilisationsViewer` present in `read`
only, confirming the bug-fixed categorization); `GET /employees` 403 (no
`employeeCreate` read), `GET /clients` 200 (has `clientsManage` read+write);
a live flip test — narrowed Manager to Read-only on `clientsManage` via the
real admin API, confirmed `GET /clients` still 200 while `POST /clients`
now 403s, then restored the original config — proved the split is actually
enforced, not just reported; `GET /team` 200, `GET /mobilisations` 200 with
real approval-trail data (confirming the `isMobilisationViewer` fix),
`GET /deployments` 200, `GET /approvals/roles` 403 (confirming the
Approval-Hierarchy-now-Admin-only consequence the user was shown and chose),
`GET /payroll` 403 (Accounts-only); Office Secretary confirmed `GET
/deployments` 200 (bypass intact) and `GET /clients` 403 (still excluded
elsewhere); `GET /ramadan-periods` and `GET /company-settings` both 200 for
Manager. Browser, logged in as the Manager test login: the Workforce hub
correctly hid "Employees"; Admin & Tools hid "Approval Hierarchy"; Financial
hid "Payroll"/"Expenses"; navigating directly to `/employees` by URL showed
the clean `RequireSectionRead` empty state, not a crash; Quick Actions
correctly omitted "Add employee". Logged in as Admin: `SectionAccessPage`
rendered all 4 checklists per card correctly; toggled Manager onto
`employeeCreate`'s Write tier, saved, confirmed via direct API read that
only `writeRoles` changed (not `readRoles`), then reverted. All three
throwaway logins and every Section Access override made during testing were
removed/restored afterward; a final direct DB read confirmed every section
matches its expected post-migration state exactly.

### Follow-up (2026-09-13): login-role grants removed — Approval Roles only

The user's own instruction, verbatim: "In section access i only need
approval roles, replace login roles to have only approval roles as the
roles." `readRoles`/`writeRoles` (the literal-`User.role` grant type) are
gone from the model, service, validation, and the `SectionAccessPage` UI —
`readApprovalRoles`/`writeApprovalRoles` are now the only way anything is
granted here, for both tiers, across all ~27 sections.

The real risk this change carried: ~15 of those 27 sections had access
*only* because of a login-role default (Accounts on Payroll/Expenses,
Coordinator on self-mobilise/Clients/Deployments-release, Executive on
Leave/Timesheet/Financial/Exit requests, Manager/HR on Company Settings/
Attendance/Documents/Assets/Ramadan/Team, etc.) — deleting that grant type
outright would have locked every one of those real staff logins out of
sections they use daily the moment this shipped. Put to the user directly
before writing any code (two `AskUserQuestion` prompts, per the "ask if you
have any doubts" instruction): they chose **auto-migrate to matching
Approval Roles** over resetting everything to Admin-only, and confirmed the
change is scoped to Section Access only (login/`User.role`/`requireRoles`
elsewhere in the app untouched).

**Migration**: `src/scripts/migrate-section-access-approval-roles.js`
(`npm run migrate:section-access-approval-roles`), same raw-collection
convention as `migrate-section-access-tiers.js` (the old field names no
longer exist in the current schema). For each of the 5 login roles that
ever appeared in a grant — Manager, HR, Accounts, Coordinator, Executive
(`'Admin'` is skipped everywhere: it already bypasses Section Access
entirely, so an `'Admin'` entry in an old list was always inert) — the
script finds-or-creates an ApprovalRole of that exact name and adds every
current login of that role as a member (additive only, never removes an
existing member added for an unrelated reason). Run against the real dev
DB: this company's real org chart already had ApprovalRoles literally named
"HR" and "Coordinator" whose membership already matched their login-role
counterparts exactly — those were reused as-is; "Manager"/"Accounts"/
"Executive" were newly created (Executive with 0 members — no login holds
that role yet, ready for when one does). Then, for every section, the
script converts its *effective* pre-migration grant (the document's own
`readRoles`/`writeRoles` if one existed — even empty, since an empty grant
could be a deliberate prior Admin-only narrowing that must not be
overridden — otherwise a frozen snapshot of the hardcoded JS defaults this
same change deleted from `sectionAccess.service.js`) into the matching
Approval Role ids, merges them into `readApprovalRoles`/
`writeApprovalRoles` via `$addToSet` (never overwrites anything already
configured), and unsets the old fields. Idempotent — a second run found 0
sections to change.

**Two real crash bugs found and fixed during verification**, both in code
written before this session that read `settings.readRoles`/
`settings.writeRoles` directly off a `getSectionAccess()`/`SectionAccess`
result: `mobilisation.service.js`'s `isMobilisationViewer` (`settings
.readRoles.includes(actor.role)`) and `deployment.service.js`'s
`decidersOfDeploymentsHours`/`decidersOfEosb` (`settings.writeRoles.length`)
would have thrown `TypeError: Cannot read properties of undefined` the
moment either ran, since those fields no longer exist on the object at all
— not a silent behavior change, an outright crash on the mobilisation list/
detail pages and on deployment monthly-hours/demobilise notifications.
Fixed by dropping the dead login-role branch from both (the Approval-Role
branch was already correct and is now the only one) — caught precisely
because this migration's `grep` sweep for the removed field names was run
across the *whole* server `src/`, not just the Section Access module.

**Verified**: migration run twice against the real dev DB (second run: 0
changes, confirming idempotency); a script exercising `canAccessSection`
directly for every real login role against every affected section — 24/24
checks passed, including that Office Secretary is still refused everywhere
(the floor check, not a grant, is unaffected) and that the two sections
already deliberately narrowed to Admin-only (`subcontractorsManage`,
`employeeCreate`) stayed that way; `npm run build` (client) clean; browser,
logged in as a throwaway Admin: `SectionAccessPage` renders exactly one
checklist per tier now (Approval Roles only, no "Login roles" sub-heading),
showing all 12 real ApprovalRoles including the 3 newly created; toggled
and saved a card, confirmed via the network response that the payload only
ever contains `readApprovalRoles`/`writeApprovalRoles`. Separately exercised
the two crash-fixed functions directly with real data (no crash,
correct decider ids returned) and `listMobilisations` end-to-end as a real
Manager login (6 items, no crash — proving the `isMobilisationViewer` fix
against the real DB, not just a unit-level check). Throwaway admin and all
scratch scripts removed afterward.

### Follow-up (2026-09-13, same day): the 3 auto-created roles removed — true decoupling

Shown the result live (a screenshot of `SectionAccessPage` with "Manager"/
"Accounts"/"HR"/"Coordinator"/"Executive"/"Office Secretary" pills sitting
right next to "Accountant"/"BDM"/"COO"/"FM"/"GM"/"MM"), the user's reaction:
"why did you merge it? i only want approval roles, no login roles." To be
precise about what did and didn't happen — the grant MECHANISM was never a
merge; `readRoles`/`writeRoles` are genuinely gone from the schema, verified
in code and in the live API response. What actually happened is the
migration above (the user's own earlier choice) created 3 real Approval
Role documents NAMED after login roles ("Manager", "Accounts", "Executive")
purely to preserve access — and having them sit in the same list as the
real org-chart roles, under names identical to login roles, read as if the
login-role system were still there wearing a different hat.

Put the concrete choice to the user directly rather than re-guessing: keep
the 3 roles as-is, keep them but rename away from the login-role-shaped
names, or delete them outright (dropping every section that depended ONLY
on one of them back to Admin-only, same posture as `employeeCreate` from
day one). They chose delete — true decoupling, no login-role-shaped stand-in
roles at all, even at the cost of some sections losing their default access
until deliberately re-granted via a real org-chart role.

Before deleting, confirmed via a direct query that none of the 3 roles were
referenced by any `ApprovalWorkflow` step (they were minutes old at this
point — never surfaced anywhere a workflow could have picked them up). A
script then `$pull`ed all 3 role ids out of every `SectionAccess` document's
`readApprovalRoles`/`writeApprovalRoles` (not just deleted the role docs —
an orphaned id left behind would have populated as `null` and crashed
`SectionAccessPage`'s `.map((r) => r._id)`), then hard-deleted the 3
`ApprovalRole` documents (matching the model's own "deactivate, never
delete" caution didn't apply here — nothing live referenced them). "HR" and
"Coordinator" — reused from the real org chart, not created by this
migration — were untouched throughout, exactly as told to the user
beforehand.

**Real-world effect**: `companySettings`, `invoices`, and `quotationsManage`
had ONLY ever gained access through one of the 3 deleted roles — they're
now genuinely Admin-only, same as `employeeCreate` always was, until an
Admin deliberately grants a real role. Every other affected section
(`payroll`, `expenses`, `mobilisationsViewer`, `financialRequests`,
`leaveRequests`/`timesheetRequests`/`exitDocuments`, `documentsManage`,
`assetsManage`, `team`, `clientsManage`, `eosb`, `deploymentsRelease`,
`attendanceManage`, `ramadanManage`) keeps whatever real role (HR,
Coordinator, or a pre-existing org-chart grant like "MM") it also had —
only the synthetic reference was removed, nothing else.

**Verified**: a direct DB query confirmed zero dangling/orphaned Approval
Role references remained after the cleanup (every `readApprovalRoles`/
`writeApprovalRoles` entry still resolves to a real document); re-ran
`listSectionAccess()` and inspected `companySettings` specifically, showing
`readApprovalRoles: []`/`writeApprovalRoles: []` as expected. Browser,
logged in as a throwaway Admin: `SectionAccessPage` renders cleanly with no
crash, and the pill list across every card is now exactly the 9 real
org-chart roles (Accountant, BDM, COO, Coordinator, FM, GM, HR, MM, Office
Secretary) — no "Manager"/"Accounts"/"Executive" anywhere. Throwaway admin
and the cleanup script removed afterward.

### Follow-up (2026-09-13): "Save all changes" — mass-saving across cards

The user's own ask, part of the same broader Section Access rework:
"have a save all changes option also to save all mass changes." Previously
each `SectionCard` owned its own local Read/Write selection state
independently, with no shared parent state — there was no way to know,
page-wide, which cards had unsaved edits without adding a real cross-card
mechanism.

Lifted all card state up into `SectionAccessPage` itself: one
`localValues` object keyed by `sectionKey`, lazily seeded from each
section's fresh server data the first time it's seen and never wholesale
-reset afterward — saving ONE card (individually, or as part of a Save
All) refetches the section-access query, which naturally makes that one
card's local value match the server again (no longer "dirty") without
touching any OTHER card's still-unsaved edits sitting in the same state
object. A card is "dirty" purely by comparing its local value to the
section's own current server value (as a set, order-independent) — the
single source of truth both an individual card's own Save button and the
page-level button share, so the two can never disagree about what's
actually unsaved.

A new "Save all changes (N)" button appears in the page header — appears
only when at least one card is dirty, N is the live dirty count — and
fires every dirty card's `updateSectionAccess` call via
`Promise.allSettled` (not `Promise.all`: one section's edit shouldn't be
able to block every other pending edit in the same batch from landing),
reporting a single aggregate toast ("N saved" or "N saved, M failed — 
<first failure's message>"). Individual per-card Save buttons stay exactly
as before — "also," not "instead," per the user's own wording — for anyone
who wants to commit one section immediately without touching the rest.
Each dirty card also gets a visible "Unsaved" badge and a highlighted ring,
so it's clear at a glance which cards Save All is about to touch.

**Verified**: browser, logged in as a throwaway Admin: toggled "BDM" onto
two different real sections' Read tier (Employees, EOSB) without saving
either individually — confirmed both cards showed the "Unsaved" badge and
the header showed "Save all changes (2)"; clicked it, confirmed via a
direct DB read that BOTH sections' real `readApprovalRoles` now included
BDM; toggled both back off and saved again the same way, confirmed via a
second DB read that both reverted cleanly to their original state, so no
test data was left behind in the real configuration. Throwaway admin
removed afterward.

## Follow-up (2026-09-13): drill-down redesign (Category → Module →
editor), Holidays governed, Attendance split into three

The flat "~20 cards under a few `<details>`" page had grown hard to scan.
The user asked for the same three-level structure the real sidebar already
uses: click a category (Workforce/Sales & Clients/Financial/Admin & Tools)
→ its modules appear as a grid of tiles, in the exact order/naming the real
hub pages already show (Employees, Attendance, Leave, ...) → click one to
see its Read/Write editor(s), not before. New file
`client/src/features/sectionAccess/sectionAccessModules.js` (`MODULE_GROUPS`)
reads every label/icon/description straight off `navConfig.js`'s
`NAV_GROUPS`, so this page can never drift from the sidebar's own wording.
Most modules own exactly one Section Access key; Deployments (3) and
Mobilisations (2) — previously separate top-level cards — now surface as
separate cards INSIDE that one module once you drill in. State (dirty
tracking, Save All) is unchanged and still global across the whole page —
a small warning badge on a category or module tile surfaces an unsaved
edit hiding inside it that isn't currently in view.

**Holidays is now governed too** (Write-only) — the user was shown the
Workforce hub's real 7-card list and asked why Holidays, one of those
cards, wasn't part of this. Its Read was — and stays — intentionally open
to everyone including Workers (the ESS Leave page depends on the exact
same unauthenticated-by-role `GET /holidays` route), so only Write
(create/edit/delete a holiday, previously hardcoded `requireRoles('Admin',
'HR')`) became a real key. Seeded with HR as the default write grant,
matching today's real access exactly (verified against the live "HR"
Approval Role's membership before seeding). `HOLIDAY_MANAGE_ROLES` (client)
removed — nothing else referenced it.

**Attendance split into three independently-governed keys** — the user,
looking at the Attendance card, pointed out the page itself has three
distinct tabs (Records, Sign In/Out, Office Location) and asked for each to
be separately grantable, "so somebody can give access to attendance but opt
out of a sub-module." `attendanceManage` is gone; in its place:

- `attendanceRecords` — the direct rename of the old key (the Records
  grid's view/export/correct-a-day). Migrated in place (same
  `readApprovalRoles`/`writeApprovalRoles`, sectionKey field renamed) — zero
  data loss.
- `attendanceSignInOut` — NEW. Write = eligible to self-mark (punch) your
  own attendance and see your own history; Read = the oversight view of
  everyone's punches (`GET /all`). Replaces two previously hardcoded,
  login-role-based circles at once: `STAFF_SELF_ATTENDANCE_ROLES`
  (Coordinator/HR/Accounts/Manager — the punch button) and
  `ATTENDANCE_WRITE_ROLES` (Admin/Manager/HR — who saw the oversight rows).
  Seeded by finding which real Approval Role every current
  Coordinator/HR/Accounts/Manager login actually belongs to (queried live,
  zero uncovered) and granting Write to all of them (Coordinator, HR,
  Accountant, MM, FM, BDM, GM, COO) — preserves every real login's access
  exactly. One deliberate, small widening flagged to the user: Write always
  implies Read here like every other key, so a Coordinator/Accounts login
  who previously could punch but NOT see the oversight rows now sees them
  too — the same "no exceptions" convention the whole mechanism already
  runs on, not something specific to this key.
- `attendanceOfficeLocation` — NEW, genuinely newly-delegable (previously
  hardcoded `requireRoles('Admin')` with no way to share it at all).
  Admin-only until granted. `OfficeLocationSettings.jsx` gained a real
  read-only mode (a `<fieldset disabled>` wrapping the form, Save/"use my
  location" hidden) since this page never had more than one audience
  before and so never needed one.

**A real, pre-existing bug this fix corrects**: the whole `/attendance`
route was gated by ONE key (`attendanceManage` read) — the real Coordinators
in this company (Saifar, Sarmad Shabir) have never been granted that, so
they could never even reach the page, despite `STAFF_SELF_ATTENDANCE_ROLES`
saying they should be able to self-mark. `RequireSectionRead` (and
`SectionHubPage`'s nav-visibility filter) now accept `sectionKey` as an
array — the route/nav-tile opens if the user can read ANY of the listed
keys, not all — so `/attendance` now needs only one of
Records/Sign-In-Out/Office-Location to be readable, and `AttendancePage.jsx`
shows only the tabs the viewer can actually read. Verified directly against
`canAccessSection` for the two real Coordinators: both now correctly reach
the page (via `attendanceSignInOut`) despite still correctly lacking
`attendanceRecords`.

**Known, accepted limitation** (documented, not silently shipped): the
Records grid's "Coordinators & Staff" row list still decides WHICH staff
members get a display row from `STAFF_SELF_ATTENDANCE_ROLES` (a login-role
list) rather than real `attendanceSignInOut` membership, since determining
the latter for OTHER users would need a new server-computed roster
endpoint. If an Admin ever grants self-mark to a role outside that
traditional list, that person can still punch and their punches are still
visible — they just won't get a "not signed in today" placeholder row
until they've actually punched once. Flagged in-code and to the user;
not built now to avoid a disproportionate new endpoint for a cosmetic gap.

**Same-day follow-up: card descriptions rewritten as "what this is for," not
"what Read/Write mechanically do."** The user pointed at "Deployments — View
& Release"'s card and asked for its text to describe the module's purpose
instead of the Read/Write mechanics — and, having confirmed the trade-off
first, chose to replace rather than supplement: every one of the ~30
`SECTION_DESCRIPTIONS` entries was rewritten as a single plain-English
purpose statement (e.g. "The deployments register — which worker is placed
where — and ending an active placement."). The generic "Can view this
section..."/"Can create/edit/decide/delete..." hint text under each
Read/Write checklist is untouched and still explains the mechanics — this
change only touched the one line above it. A real, accepted trade-off: a
handful of section-specific caveats that used to live in this exact spot
(e.g. "Office Secretary always has this regardless of this setting" on
`deploymentsHours`, "deleting stays Admin/Manager only regardless" on a
few others) are gone from here — still true, just no longer written down
at this spot; the underlying rule still lives in each route file's own doc
comment.

**Verified**: browser click-through of all three drill-down levels
(category → module → editor) confirming order/naming matches the real hub
pages exactly, including Deployments' and Mobilisations' multi-key modules
rendering as separate cards; a full dirty → per-tile badge → Save All →
persisted → reverted round trip; the new Holidays card showing HR
pre-selected under Write only; `node --check` on every touched server file;
a clean `npm run build`; a direct `canAccessSection` check against real
Coordinator/Accounts/Office-Secretary user ids confirming the Attendance
split behaves exactly as designed (including Office Secretary still denied
everywhere, unaffected). Two throwaway admins created and fully removed
afterward (login, refresh tokens, audit rows); the one real section-access
document touched mid-test (`deploymentsRelease`, from an unrelated stale
browser-ref click) was reverted to its original value.
