# Deployments redesign: Mobilisation-driven placement, monthly hours & OT, Release

Prompted by the user's own framing: Deployments (a Phase-1 module that
predated Mobilisation and had zero real data — "No deployments yet") should
instead be the automatic *outcome* of an Approved Mobilisation — "once he
approves it should come to deployments so the deployments happens." While a
worker is deployed, the Office Secretary enters the client's actual monthly
timesheet hours against the coordinator's contracted hours, with overtime
hours auto-calculated and an OT amount entered manually. A new "Release"
action ends the deployment, completes the source Mobilisation, and frees the
worker back to standby for a brand new Mobilisation.

## Decisions made with the user before building

1. **Worker scope**: Deployment now covers all three Mobilisation worker
   types (Employee/SupplierEmployee/Freelancer), not just Employee-linked
   workers — the subcontractor OT case the user described is exactly the
   SupplierEmployee path. Deployment references its source `Mobilisation`
   instead of duplicating every identity field; `Employee.currentClient/
   currentSite` only sync for a real Employee.
2. **OT amount**: manually entered by whoever enters the month's hours (no
   formula), same posture as Payroll's GOSI and Mobilisation's own original
   `profit` field — OT *hours* are still auto-computed
   (`max(0, actualHours - contractHours)`).
3. **Release**: a "full release" — ends the Deployment AND completes the
   source Mobilisation in one transaction (frees `Employee.coordinator` +
   `currentClient`/`currentSite`), not a separate manual step.
4. **Access**: Section-Access-gated, two new keys — `deploymentsHours`
   (default: nobody but Admin and a hardcoded Office Secretary bypass, same
   pattern as `createMobilisation`) and `deploymentsRelease` (default
   `['Coordinator', 'Manager']`).

## What was built

```
server/src/modules/deployments/
  deployment.model.js       # REWRITTEN — mobilisation ref (unique), workerType,
                               worker (optional), workerName/client/site/
                               subcontractor snapshots, requiredTimesheetHours
                               snapshot, embedded monthlyHours[] (month,
                               contractHours, actualHours, otHours computed,
                               otAmount manual, notes, enteredBy/At)
  deployment.service.js     # REWRITTEN — createDeploymentFromMobilisation
                               (internal, called from mobilisation.service.js),
                               addMonthlyHours/updateMonthlyHours (month-
                               eligibility rules), releaseDeployment (the full
                               release+complete-mobilisation transaction — see
                               "Avoiding a circular import" below)
  deployment.controller.js  # REWRITTEN — assign/transfer/end handlers removed;
                               monthly-hours add/update + release added
  deployment.routes.js      # REWRITTEN — no create/edit route at all; router-
                               level requireStaffOrOfficeSecretary (not plain
                               requireStaff) so Office Secretary can reach
                               monthly-hours; release gated by
                               requireSectionAccess('deploymentsRelease')
  deployment.validation.js  # REWRITTEN — monthly-hours + release schemas

server/src/modules/mobilisations/
  mobilisation.model.js     # + `site` (optional, free-typed, snapshotted onto
                               the auto-created Deployment)
  mobilisation.validation.js  # + `site`, + 'site' to the suggestions enum
  mobilisation.service.js   # `approveMobilisation` now calls
                               createDeploymentFromMobilisation when the
                               decide-engine returns status 'Approved';
                               completeMobilisation REMOVED (superseded by
                               Release — see below); getMobilisation attaches
                               a `deployment: {_id, status}` lookup once
                               Approved/Completed for the client's
                               "View deployment" link
  mobilisation.controller.js / .routes.js
                             # PATCH /:id/complete removed entirely

server/src/modules/sectionAccess/
  sectionAccess.model.js    # SECTION_KEYS: deploymentsManage → deploymentsHours
                               + deploymentsRelease
  sectionAccess.service.js  # defaults/labels/descriptions for both new keys

server/src/modules/employees/
  employee.validation.js / employee.service.js
                             # `unassigned` list filter removed (dead — its
                               only caller was the retired assign form)

client/src/features/deployments/
  deployments.api.js         # REWRITTEN — no create/edit calls; addMonthlyHours,
                                updateMonthlyHours, releaseDeployment
  deployments.schema.js      # REWRITTEN — monthly-hours + release form schemas
  pages/DeploymentListPage.jsx    # simplified register, no "Assign worker" button,
                                    row-click → /deployments/:id
  pages/DeploymentDetailPage.jsx  # NEW — the workhorse: placement info, monthly-
                                    hours table + add/edit forms, Release modal
  pages/DeploymentNewPage.jsx     # DELETED — no manual create anymore
  components/DeploymentForm.jsx   # DELETED — no manual create/transfer form
  components/WorkerDeploymentPanel.jsx
                                 # REWRITTEN — read-only summary + "View deployment"
                                   link on the Employee profile; history rows link
                                   to their own detail pages too

client/src/features/mobilisations/
  mobilisations.schema.js / components/MobilisationForm.jsx
                             # + `site` field (free-typed, autocomplete via
                               getFieldSuggestions, same pattern as workerName)
  pages/MobilisationDetailPage.jsx
                             # "Mark complete" button/flow removed; a
                               "View deployment" button appears once Approved
                               and a Deployment exists; `site` added to the
                               Worker & Placement table
  mobilisations.api.js       # completeMobilisation() call removed

client/src/app/router.jsx           # /deployments/new → /deployments/:id
client/src/features/dashboard/components/QuickActions.jsx
                                     # "Assign worker" quick action → "New mobilisation"
client/src/features/sectionAccess/pages/SectionAccessPage.jsx
                                     # category map updated for the two new keys
client/src/lib/constants.js         # DEPLOYMENT_SHIFTS removed (no shift field anymore)
client/src/i18n/locales/{en,ar}.json  # staffDeployments rewritten; dead
                                       staffMobilisations completion keys removed
```

## Avoiding a circular import

`mobilisation.service.js` needs to create a Deployment on approval;
`deployment.service.js` needs to complete the source Mobilisation on release.
Rather than have the two service modules import each other (a real circular
dependency), `deployment.service.js` imports the `Mobilisation` **model**
directly (never `mobilisation.service.js`) and does the full release
transaction itself — end the Deployment, clear `Employee.coordinator`/
`currentClient`/`currentSite`, and mark the Mobilisation `Completed` — all in
one place. The dependency graph stays one-directional:
`mobilisation.service.js → deployment.service.js → {Deployment, Employee,
Mobilisation models}`. This is also why the old `completeMobilisation`
function in `mobilisation.service.js` was deleted outright rather than kept
as a dead, unreachable export — its logic now lives in
`deployment.service.js`'s `releaseDeployment`, the single place a placement
ever ends.

## Month-eligibility rule

A month can only be entered once it has fully ended: `data.month <
currentMonthStr()`, and no earlier than the deployment's own start month —
"if I mobilise for September... the next month October 1st the starting of
the first day of the first month that option should be there," the user's own
words. `DeploymentDetailPage`'s add-hours form computes a sensible default
(`nextEligibleMonth`: the earliest eligible calendar month not yet entered)
and constrains the native `<input type="month">`'s `min`/`max` to match —
verified live: entering the current month or a month before the deployment
started both correctly 400, a duplicate month 409s ("edit that entry
instead"), and a valid past month computes `otHours` correctly.

## `site` on Mobilisation

The old Deployment required a `site` (validated against the client's
registered sites list) — but Mobilisation, which now drives Deployment
creation automatically, had no site field at all. Added `site` as an
**optional, free-typed** field on Mobilisation (not validated against
`Client.sites`, not required) — deliberately looser than the original
Deployment field, since forcing a new required field onto an already-shipped,
heavily-used creation form risks blocking a Draft on data (a client's
registered site list) that may not be well maintained. Reuses the existing
`getFieldSuggestions` autocomplete plumbing (already generic over any field)
rather than a new mechanism.

## Not done / deliberately out of scope

- **No Invoicing hookup.** The monthly hours/OT ledger is Deployment-only
  tracking for this milestone — it does not feed `Invoice` line items.
  Matches this app's own "add a module when its data exists, wire it up
  later" convention; can be revisited once real invoicing-from-timesheet
  needs are confirmed.
- **No proration for a partial first/last month.** If a deployment starts
  mid-month, the full `requiredTimesheetHours` is still used as that month's
  contract-hours comparison — the office secretary/coordinator is expected to
  use judgment for a partial month, same posture as this app's other
  manually-entered imperfect-real-world-data fields.
- **No retroactive backfill.** Any Mobilisation that was already `Approved`
  before this change shipped has no Deployment record and no way to get one
  automatically — it can still be marked `Completed` was previously reachable
  only via the now-removed `/complete` route, which no longer exists. A
  one-time backfill script (`Deployment.create` from every currently-Approved
  Mobilisation) was considered but not written, since writing to the live
  Atlas database unprompted isn't this app's convention — flag this to the
  user if any such records exist before this ships to production.

## Verified (2026-09-08)

**Build**: `npm run build` clean (client); server boots clean (`node
--watch src/server.js`, MongoDB connected, no errors).

**curl**, full lifecycle against the real Atlas dev database with a throwaway
Admin (Employee-type worker "Sharuk Khan" / Client "UNITED ARK CONTRACTING"):
create Mobilisation with `site` → submit → approve step 1 → approve step 2
(final) → **Deployment auto-created** (`workerType: Employee`, `worker` set,
`site`/`requiredTimesheetHours` snapshotted, `Employee.currentClient/
currentSite` synced) → `getMobilisation` returns `deployment: {_id, status}`.
Monthly hours: current month → 400; month before deployment start → 400;
valid month (July, 370h vs 260h contract) → `otHours: 110` correct, `otAmount`
stored as entered; duplicate month → 409; a second month (August) added
cleanly; `PATCH .../monthly-hours/:entryId` correction recomputed `otHours`
correctly. Release: ends the Deployment, source Mobilisation flips to
`Completed`, `Employee.currentClient/currentSite/coordinator` all cleared,
hours can no longer be added (400), and the same worker could immediately
start a brand new Mobilisation (previously blocked by
`assertNoActivePlacement`).

**Browser** (throwaway Admin, full click-through): created a mobilisation
with a typed `site`, submitted through both real workflow steps ("Secretary
verification" → "MM Approval"), watched status flip to Approved with a "View
deployment" button appearing; opened the Deployment detail page (placement
card, "View mobilisation" link, monthly-hours table); the add-hours form's
month field defaulted correctly to the deployment's start month; submitted
370→380 actual hours with a manual OT amount and saw `otHours: 120` computed
live in the table; clicked Release, confirmed the modal copy and date picker,
and watched the page flip to "Ended" with hours entry disabled; confirmed the
Mobilisation detail page now shows "Completed" with no editable "Mark
complete" button. Separately verified the SupplierEmployee (no-Employee-link)
path end-to-end via curl, then its Deployment detail page in the browser —
worker renders as plain text (not a broken employee link), Subcontractor row
shows correctly, no console errors. The Section Access admin page correctly
lists both new keys under "Sales & Clients" with the intended default-role
checklists and the Office-Secretary-bypass noted in the description text.

**Cleanup**: every test Mobilisation/Deployment created during verification
was deleted via the API; both throwaway Admin users (and their refresh
tokens/audit-log entries) deleted directly from the database; no scratch
scripts remain in either repo; a final DB query confirmed zero leftover
Deployment documents and zero MOB-0024..0027 records.

## Follow-up (2026-09-10): monthly-hours Approve/Reject COMPLETE

User-reported gap: the monthly client-hours/OT ledger above had no review
step at all — whoever entered a month's hours (typically Office Secretary)
had it save immediately, with no notification, no pending state, and no way
for anyone (Marketing Manager, in the user's own framing) to review it
before it counted as final.

Added a real single-level Approve/Reject to each `monthlyHours` entry —
`status` (`Pending`/`Approved`/`Rejected`, defaults `Pending`), `decidedBy`/
`decidedAt`/`decisionNote`. Deliberately NOT the full Configurable Approval
Hierarchy engine (workflow/steps/currentStep/approvalTrail) — that shape
assumes a top-level document, and this is one entry in an embedded array on
Deployment; a single-level decide is the same judgment call Financial
Requests already made for the same reason. Authorization is a brand-new
Section Access key, `deploymentsHoursDecide` — deliberately separate from
the existing `deploymentsHours` (entry) key, so whoever enters hours is
never automatically who approves them; defaults to Admin-only until granted
(typically to a "Marketing Manager" `ApprovalRole`), same posture as every
newly-introduced Section Access key. `updateMonthlyHours` now refuses to
edit an `Approved` entry (400) and, editing a `Rejected` one is an implicit
resubmit — resets straight back to `Pending`, decision fields cleared,
rather than needing a separate "resubmit" action. `decideMonthlyHours`
refuses to re-decide anything but a `Pending` entry (an `Approved` entry is
locked; a `Rejected` one must go through the edit-to-resubmit path first —
re-deciding it directly would skip the enterer ever seeing/fixing what was
wrong). Notifications both ways: the configured decider(s) are notified on
every new entry and every resubmit (resolved via Section Access's own
literal-roles + ApprovalRole-members shape, reusing `membersOfRoles` — the
same mechanism `canAccessSection` itself checks, just resolved to actual
user ids for notifying rather than a single yes/no); the original enterer is
notified the moment their entry is decided either way.

**Verified**: a direct-service script exercised the full state machine
against a throwaway Deployment (Admin actor, bypasses Section Access) —
new entry defaults to `Pending`; editing a `Pending` entry keeps it
`Pending`; deciding it `Approved` sets `decidedBy`/`decisionNote`; editing
an `Approved` entry correctly 400s; re-deciding an `Approved` entry
correctly 400s; a second entry decided `Rejected` then edited correctly
resets to `Pending` with decision fields cleared; deciding that resubmitted
entry works normally; and — confirming the notification-resolution logic
itself, not just that *a* notification fires — zero "please review"
notifications went out because `deploymentsHoursDecide` had no grantees
configured yet (the expected, correct behavior for an unconfigured key),
while the 3 decide-outcome notifications to the enterer fired regardless of
configuration. Browser click-through (throwaway Admin, real login, real
UI): a seeded Pending/Approved/Rejected trio rendered the right status
badge and the right button set per row (Edit+Approve+Reject on Pending,
nothing on Approved, Edit-only + visible decision note on Rejected);
clicking Approve opened the confirm modal with the optional-note textarea,
and the row flipped to "Approved" with its buttons gone immediately after,
no reload needed. All throwaway data (deployment, notifications, admin
users, and the scratch scripts themselves) deleted afterward.

## Follow-up (2026-09-12): daily timesheet grid + real profit + post-approval correction

Three more user asks landed on the same feature, plus one severe unrelated
bug found along the way.

**Daily timesheet grid, replacing the single "actual hours" number.**
Each `monthlyHours` entry now stores `dailyHours` (one number per calendar
day of that month, 0-24 each); `actualHours` is never submitted by the
client at all anymore — it's always the server-computed sum, same "never
trust a client-submitted total when the real breakdown is right there"
rule every other derived figure in this app follows. The exact day count
(28-31) is validated against the real calendar for that month, both
client-side (the grid literally renders that many inputs, resizing live if
the user changes the month) and server-side (the definitive check, so a
tampered request can't submit the wrong count). A legacy entry from before
this existed has an empty `dailyHours` — editing one shows a plain warning
banner ("previously entered as an N-hour total") instead of silently
discarding that history into a blank grid.

**Real per-month profit**, reusing Mobilisation's own established formula
(`mobilisation.service.js`'s `computeProfitFields`) rather than inventing a
new one — `profitPerHour * contractHours - fta - allowance +
otProfitTotal`, with the rate/commission fields read from the linked
Mobilisation (Deployment has none of its own — see the model's doc
comment) and `contractHours`/`otHours` from the entry itself. Computed
fresh on every read, never stored. Deliberately gated to whoever can
*decide* this section (`deploymentsHoursDecide`, e.g. Marketing Manager) —
same sensitivity class as Mobilisation's own COMMERCIAL_FIELDS — and
**stripped server-side** for anyone else, not just hidden in the UI (a
Coordinator or Office Secretary's response simply never contains `profit`/
`totalProfit` at all).

**The manager can correct an Approved entry directly, no lock, fully
logged** — the user's own explicit ask: forcing reject→re-enter→re-approve
just to fix a mistake the approver themselves noticed was friction with no
real integrity benefit. `updateMonthlyHours` now allows whoever holds
`deploymentsHoursDecide` to edit even an Approved entry; status stays
Approved (they're correcting themselves, not handing it back for a fresh
review) — but every such edit writes an audit entry
(`deployment.monthlyHours.correctApproved`) with the full before/after
values, and proactively notifies the original enterer that their approved
figure was changed. The plain enterer (Office Secretary /
`deploymentsHours`) is still locked out of an Approved entry exactly as
before — only the decider gets this new right.

**Also fixed, error surfacing** — a client-side Zod validation failure
used to fail completely silently (react-hook-form never calls `onSubmit`,
so a mutation's own `onError` toast never fires either). `MobilisationForm`
now uses `handleSubmit(onSubmit, onInvalid)`, surfacing every field's own
(already human-readable) Zod message as a toast and logging the full
errors object to the console — this is now a standing rule for every form
in the app, not just this one (see the session's own memory note on it).

**A severe, unrelated bug found while verifying the above**: the
`uniq_active_worker` partial index (deployment.model.js) was meant to
allow multiple simultaneous Active SupplierEmployee/Freelancer deployments
(all with `worker: null`) while still blocking a real Employee from being
double-assigned. Its `partialFilterExpression` used `worker: { $ne: null
}` — but MongoDB's partial-index filters do not support `$ne` at all (only
`$eq`/`$gt`/`$gte`/`$lt`/`$lte`/`$exists`/`$type`, and `$and` of those); it
was silently dropped at index-creation time, leaving the REAL index in the
database as just `{ status: 'Active' }` with no worker condition at all —
meaning **only one Active Freelancer/SupplierEmployee deployment could
exist system-wide, ever**, since this feature shipped. Found via a live
E11000 collision while creating an unrelated verification fixture, not
user-reported — a real "Ram Dev" deployment was already occupying that
slot. Fixed the same way `NfcCard.model.js`'s own `chipUid` partial index
already does it: `worker: { $type: 'objectId' }` (a value can only have
BSON type objectId if it's actually present and non-null — exactly "a real
Employee", the same set `$ne: null` was trying and failing to express).
Dropped and recreated the live index directly against the real database
with the corrected filter, confirmed via `db.collection.indexes()`, and
confirmed the real "Ram Dev" deployment no longer blocks a second
Freelancer deployment from being created.

**Verified**: a full script run against a real Mobilisation (real
clientRate/clientCommission/fta/allowance/otClientRate/otClientCommission)
covered: a wrong-length `dailyHours` array rejected with a clear day-count
message; a correct 31-day array producing the exact right
actualHours/otHours; the computed profit matching a hand-calculated
expected value exactly; profit/totalProfit genuinely absent (not just
falsy) from a non-decider's response; a decider correcting an Approved
entry in place (status stays Approved, not reset); that correction's audit
entry carrying the exact before/after actualHours; and a plain enterer
still correctly blocked from touching an Approved entry. Browser
click-through confirmed the grid renders the right day count for the
selected month, resizes live, sums correctly as you type, and pre-fills
correctly when editing an existing entry. All throwaway data and scripts
deleted afterward.

## Follow-up (2026-09-12): real Demobilise lifecycle (Standby vs. Exit) + EOSB hookup

Release only ever did one thing: pick a date, type a note, free the worker
back to informal "standby." There was no way to record *why* a placement
ended, and no distinction between "the client no longer needs them, still
our employee" and "no longer part of the company at all" (terminated,
resigned, or sponsorship-transferred/"Tanazel" to another employer — a real,
common Saudi manpower concept). The second case was invisible to the system:
`Employee.status` only ever changed via a manual HR form edit, completely
decoupled from Deployment — so an employee who actually left could keep
showing up as payroll-eligible, monitored for document-expiry, and counted
as active headcount until someone remembered to flip their status by hand.
Separately, `Employee.status='Exited'` and the EOSB settlement module were
two independent, unlinked actions — nothing connected "this person is gone"
to "calculate what we owe them."

**Renamed Release → Demobilise** (`POST /:id/demobilise`,
`demobiliseDeployment` in deployment.service.js — the Section Access key
itself, `deploymentsRelease`, is intentionally unchanged; only the verb is).
Status/action labels are a display-only change — the underlying `status`
enum stays `'Active'/'Ended'`, translated to "Mobilised"/"Demobilised" via a
new Deployment-scoped i18n key (`staffDeployments.status.*`) rather than the
shared `common.status.*` namespace, which 31 other files also key off of.

**New reason taxonomy** (`DEMOBILISATION_REASONS` on deployment.model.js,
replacing the single `'Released'`):
- `ClientAssignmentEnded` (outcome: **Standby**) — the direct rename of the
  old default; the client/project no longer needs this worker, who remains
  employed and immediately eligible for a new Mobilisation. Available for
  every worker type.
- `TerminatedByCompany` / `Resigned` / `TransferredToAnotherCompany`
  (outcome: **Exit**) — Employee-only (rejected with a 400 for a
  SupplierEmployee/Freelancer, who have no employment relationship with the
  company to end); `TransferredToAnotherCompany` is the sponsorship/"Tanazel"
  transfer case.
- `Other` — any worker type; outcome is NOT inferred from the reason here.
  The demobilise form shows an explicit checkbox ("mark as Exited") only for
  this reason, defaulting unchecked — a safety valve for a genuinely novel
  reason without forcing every other case through a redundant yes/no.

The resolved outcome (`Standby`/`Exit`) is persisted on the Deployment
(`demobilisationOutcome`) rather than only derived from the reason, so
`'Other'` stays reportable too and a later change to the lookup table can
never silently reinterpret history.

**What Exit actually does**, inside the same transaction Demobilise already
ran (ending the Deployment, completing the source Mobilisation): also sets
`Employee.status = 'Exited'` — the one new piece of state this feature adds.
Every filter that already excludes Exited employees (Payroll, the
dashboard's active headcount, expiry alerts) picks this up for free; no
other module needed to change. Closed the loop on the other side too:
`mobilisation.service.js`'s `createMobilisation` now refuses to mobilise an
Employee whose `status` is already `'Exited'` — without this, "no longer
part of the company" would have been cosmetic, since nothing stopped
re-mobilising them five minutes later. Reversing a mistaken Exit needs no
new UI — status is already a plain editable field on the Employee form.

**EOSB hookup** — the actual "connect to the financial pipeline" ask.
`settlement.model.js`'s `EXIT_REASONS` gained a 4th value,
`SponsorshipTransfer`, confirmed safe to add with zero formula changes:
`computeEosb`'s reduction tiers only special-case `'Resignation'`, so this
new reason automatically gets the same full, unreduced award as
`EndOfContract`/`TerminationByEmployer`. (A real Tanazel's legal EOSB
treatment should ultimately be confirmed with the company's own HR/legal
advisor — the reason stays fully editable on the settlement form regardless.)
On a successful Exit-outcome demobilise, the client shows a non-blocking
follow-up prompt deep-linking to `/eosb/new?employee=&exitDate=&exitReason=`
(`SettlementNewPage.jsx` already accepted `?employee=` from the Employee
profile's own "Calculate EOSB" button; the two new params are purely
additive). Also proactively notifies whoever holds `eosb` Section Access
write (Manager/HR/Accounts by default) via the exact `decidersOf*`/
`notifyUser` pattern this module already used for monthly-hours decisions —
so the connection isn't missed even if the in-page prompt gets dismissed.
Explicitly **not** built: automatic Invoice generation from Deployment's
monthly-hours/profit data, or reconciling it with Mobilisation's
`profitPerMonth` — both remain the same deliberately-deferred gap noted
above ("No Invoicing hookup"), untouched by this feature.

**A second real gap found and closed along the way**: the Employee-only
`assertNoActivePlacement` guard in mobilisation.service.js had no
SupplierEmployee/Freelancer equivalent at all — these worker types have no
`worker` ref (only a snapshotted Iqama number), so nothing stopped
mobilising the same real person to two clients at once. Added
`assertNoActiveNonEmployeePlacement`, the same guard keyed on `iqamaNumber`
instead of a ref. Same bug class as the `uniq_active_worker` partial-index
fix above — found purely as a side effect of designing this feature, not
reported.

**A pre-existing bug found and fixed in a directly-related file**:
`SettlementNewPage.jsx`'s `?employee=` preset (used by both the Employee
profile's "Calculate EOSB" button and this feature's new follow-up prompt)
silently failed to select anything whenever the employee list hadn't
finished loading yet at mount — react-hook-form sets a native `<select>`'s
value via an uncontrolled ref, a no-op if the matching `<option>` isn't in
the DOM yet, and nothing re-applied it once the list arrived. Same bug
class, same fix, as `MobilisationForm.jsx`'s job-title auto-select: a
`useEffect` that calls `setValue` once the matching employee actually
appears in the loaded list.

**Follow-up, same day**: the `updateMobilisation` gap flagged above (no
re-check when a Draft/Rejected/PendingReview mobilisation's worker is
edited) was fixed on request. It now runs the same guards
`createMobilisation` does — double-placement AND the Exited-employee check —
but only when the worker identity is actually changing to someone else; the
currently-persisted document still holds the old identity at that point, so
a routine resend of the same worker can never falsely collide with itself.
Verified: resending the same worker is a no-op (no false collision);
retargeting onto an already-placed Employee or an Exited one is rejected and
leaves the mobilisation's worker unchanged; retargeting onto a genuinely
free Employee still succeeds.

**Verified**: a full script run covering — ClientAssignmentEnded leaves
Employee.status untouched and immediately re-mobilisable; each Exit reason
sets Employee.status='Exited' and a follow-up createMobilisation for that
employee correctly 400s; an Exit-only reason 400s for a SupplierEmployee
deployment while ClientAssignmentEnded still succeeds for one; the new
iqama-based guard 409s a concurrent duplicate Freelancer mobilisation and
allows it once the first is Completed; a SponsorshipTransfer settlement
computes with a full, unreduced award; the EOSB decider notification fires.
Browser click-through against a throwaway Employee deployment confirmed the
"Mobilised"/"Demobilised" labels, the reason dropdown (correctly restricted
per worker type), the Exit warning copy, the post-demobilise EOSB prompt,
and — after the fix above — the deep-linked settlement form correctly
pre-selecting the employee, exit date, and reason, computing a real
SAR 14,400 settlement end to end. All throwaway data and scripts deleted
afterward; the throwaway browser-login Admin was also removed.

## Follow-up (2026-09-13): daily grid gets weekdays, Off/Sick/Absent marks, and keyboard-driven entry

Three real gaps in the daily-hours grid (2026-09-12 follow-up, above),
raised directly by the user with a screenshot: no way to tell which weekday
a column was, no way to mark a non-working day at all (so a reviewer had to
type something into every single cell even for an obvious day off), and no
fast keyboard path through a 28-31 column row (mouse-only, no way to jump
to the next day after typing one). Two design questions were asked before
touching any code, since the answer changes the data model, not just the
UI: **where does Off/Sick/Absent come from** (real Attendance records vs.
marked manually in the grid) and **does it block hours entry or just
default it**. Answered: **marked manually, and blocking** — deliberately
NOT auto-pulled from the Attendance module (a client timesheet can
legitimately differ from internal attendance, and SupplierEmployee/
Freelancer workers have no Attendance record to pull from at all).

**Data model** (`deployment.model.js`): each day of `dailyHours` widened
from a plain `Number` to `{status, hours}` — `DAILY_ENTRY_STATUSES =
['Worked', 'Off', 'Sick', 'Absent']`, `hours` meaningful (and required)
only when `status === 'Worked'`, enforced by a Zod `superRefine` on both
`addMonthlyHoursSchema` and `updateMonthlyHoursSchema` (a `Worked` day
without hours, or a non-`Worked` day WITH hours, both 400). Confirmed
before changing anything that this was safe: the only real `monthlyHours`
entry in the live database (Sharuk Khan, August 2026) predates the daily
grid entirely and has an empty `dailyHours` array — zero real per-day data
existed anywhere to migrate. `actualHours` is now `sumWorkedHours` — only
`Worked` days contribute; an Off/Sick/Absent day is correctly 0 toward both
the monthly total and OT.

**One input, not two** — the client never renders a separate "hours" field
next to a status dropdown. Each day is a single text cell: type a number
(0-24, decimals allowed) for hours worked, or type `F`/`S`/`A`
(case-insensitive) to mark Off/Sick/Absent directly — `deployments.
schema.js`'s `parseDailyEntry`/`dailyEntryToString` convert between that one
typed string and the server's `{status, hours}` shape in both directions.
This is what "blocking" means in practice: a day can never carry both a
status mark and an hours number, because there's only ever one place to
type either. Off/Sick/Absent cells are tinted (grey/primary/danger,
matching the Attendance grid's own `ATTENDANCE_STATUS_META` colors) so a
reviewer can scan a full month at a glance.

**Weekdays**: each column header gained a small locale-aware weekday label
above the day number (`Intl.toLocaleDateString(..., {weekday})`). English
uses `'short'` ("Mon") since ICU has a real compact form; Arabic uses
`'narrow'` instead (a single unambiguous letter) because ICU's Arabic
`'short'` form turned out to be the FULL word ("الاثنين"), which would have
blown out the grid's narrow columns — confirmed with a real Node check
before deciding, not assumed. (English `'narrow'` was ruled out the same
way: it collides — Tue/Thu both render "T", Sat/Sun both render "S".)

**Keyboard-driven entry**: pressing Enter in a day's cell moves focus to
the next day and scrolls it into view (`scrollIntoView({inline:'center'})`)
so a full month can be typed end-to-end without touching the mouse — the
last day intentionally does nothing further, so an accidental extra Enter
can't submit the form. Verified this exact behavior via direct DOM
KeyboardEvent dispatch + `document.activeElement` checks (the browser
automation tool's own synthetic Enter key turned out not to reproduce real
focus-follows-Enter behavior reliably for this test, a tooling quirk, not a
product bug — confirmed by dispatching real trusted-shaped events instead
and watching focus/values move exactly as intended).

**Verified**: a script run confirmed the Zod-level Worked/non-Worked
`superRefine` rejects both invalid shapes and accepts a valid mix;
`addMonthlyHours` on a real throwaway deployment with 28 Worked days (8h
each) + one Off + one Sick + one Absent day computed `actualHours: 224`
(NOT 231) and the right `otHours`; correcting a Worked day to Sick via
`updateMonthlyHours` dropped `actualHours` by exactly that day's hours and
recomputed `otHours`. Browser click-through (English and Arabic) against a
throwaway Active deployment confirmed: weekday labels correct for January
2024 (1st is a real Monday), typing `8`/`f`/`s`/`a` across four cells
produced the right colors and left the total at exactly `8h`, a full
31-day submit round-tripped through the real server (`ACTUAL: 170` for
8 + 27×6, correctly excluding the 3 non-worked days), and re-opening that
same entry for edit pre-filled `8/F/S/A/6/6...` exactly as saved. All
throwaway data, logins, and scripts deleted afterward.

### Follow-up (2026-09-13): OT amount auto-computed and made commercial-only, plus a quick hours summary

The user's own report, verbatim (with a screenshot of the "Add this month's
hours" form): OT amount should auto-fill from the OT rate/hour quoted to the
client × overtime hours, and be visible only to whoever can approve this
section; and after the daily hours are entered, a quick summary — client
agreement hours, total hours worked, and the difference as OT hours —
should appear both here and on the manager's decide view.

**OT amount**: `otAmount` on a `monthlyHours` entry was, until now, a plain
number typed in by whoever entered the hours (usually Office Secretary) —
"no verified OT-commission formula trusted yet," the same posture as GOSI.
That posture no longer applies: the OT rate quoted to the client
(`Mobilisation.otClientRate`, added the same session as the client-rate-
mandatory/date-overlap fix) already exists and is exactly the number the
user asked for. `otAmount` is now always `otHours × otClientRate`, computed
server-side in a new `computeOtAmount` helper and called from both
`addMonthlyHours` and `updateMonthlyHours` (deployment.service.js) — never
client-submitted at all anymore, the field is gone from
`addMonthlyHoursSchema`/`updateMonthlyHoursSchema` entirely (same
"recompute financials server-side, always" rule as every other derived
figure here).

**Made commercial, closing a real pre-existing exposure gap found along the
way**: `otAmount` now gets the exact same treatment as `profit` — stripped
from `getDeployment`'s response for anyone without `deploymentsHoursDecide`
access (renamed the local `canSeeProfit` flag to `canSeeCommercial` since it
now gates two things), and from `listDeployments` too (that list isn't
currently rendered anywhere on the client, but the same "never even send
it" rule applies regardless). While making this change, found that
`deployment.mobilisation` was being populated with EVERY commercial rate
field (`clientRate`, `clientCommission`, `otClientRate`, etc.) for literally
every viewer, unconditionally — only the derived `profit` was ever gated,
the raw rates it's built from were not. A non-decider (Office Secretary)
could already read `deployment.mobilisation.otClientRate` straight off the
API response and back-compute the OT amount herself even before this
change, defeating the entire point of gating the derived figure. Fixed by
stripping `mobilisation` down to `_id`/`serialNumber` (the only two fields
the client actually renders, for the "View mobilisation" link) for anyone
who isn't a decider.

**Quick summary**: `MonthlyHoursForm` (the same component used for both
adding and correcting an entry) gained a small summary panel right after
the daily-hours grid — Client agreement hours (the deployment's
`requiredTimesheetHours` when adding, or the entry's own snapshotted
`contractHours` when correcting one already entered), Total hours worked,
and Overtime hours, all live as the grid is typed. A fourth line, OT
amount, appears only when `canDecideHours` is true (the exact same
Section-Access-derived boolean this file already uses to gate the
Approve/Reject buttons and the post-approval-correction right) — reusing
`deployment.mobilisation?.otClientRate`, which is simply absent from the
API response for anyone else, so there's nothing to leak even if the
client-side check were bypassed. The same four-line summary was added to
the Approve/Reject confirmation modal (previously showed no numbers at all
before a decision — a real usability gap on its own), pulling straight from
the entry being decided; that modal is only ever reachable by a decider in
the first place, so no extra guard was needed there. The historical entries
table's own OT Amount column is now gated by `canDecideHours` too, replacing
an implicit reliance on `otAmount` simply being present.

**Verified**: a script against a real throwaway Freelancer deployment
(`otClientRate: 25`, contract hours 200) confirmed `addMonthlyHours` with
220 worked hours computed `otHours: 20` and `otAmount: 500` exactly;
`getDeployment` as the REAL Office Secretary login stripped `otAmount` from
the entry entirely while leaving `contractHours`/`actualHours`/`otHours`
visible, and stripped `mobilisation` down to `serialNumber` only (no
`otClientRate`); the same call as Admin returned the full `otAmount`,
`profit`, and rate fields; `updateMonthlyHours` recomputed `otAmount`
correctly after changing the hours (250 worked → `otHours: 50`,
`otAmount: 1250`); `listDeployments` stripped/kept `otAmount` the same way.
16/16 checks passed. Browser, logged in as a throwaway Admin against a real
Active deployment (Babu Ram / UNITED ARK CONTRACTING, real
`requiredTimesheetHours: 260`, real `otClientRate: 15` on its source
Mobilisation MOB-0050): confirmed the OT amount input is gone from the
form entirely; typed a full 31-day month at 12h/day and watched the summary
update live to Total hours worked 372 / Overtime hours 112 / OT amount
"SAR 1,680.00" — exactly `112 × 15`; navigated away without saving, confirmed
via a direct DB read that the real deployment's `monthlyHours` was
untouched (still empty). Also attempted a throwaway Office-Secretary-role
browser login to visually confirm the client-side hiding, which surfaced an
unrelated pre-existing gap: Office Secretary's client-side route guard
(`RequireSectionRead` on `/deployments/:id`, keyed off `user.sectionAccess`)
doesn't know about the server's own hardcoded Office-Secretary bypass on
this module, so she couldn't browse into a deployment page directly by URL
at all — flagged as out of scope in this same reply, then the user asked for
it to be fixed too; see the next follow-up below, same day. All throwaway
logins and scripts removed afterward; no real data was modified.

### Follow-up (2026-09-13, same day): Office Secretary's direct navigation into Deployments fixed

The gap flagged above turned out to have two independent causes, only one
of which was actually `RequireSectionRead`:

1. **The real cause**: `RoleRouter` (client/src/app/router.jsx) had a hard
   redirect — any URL for Office Secretary that didn't start with
   `/mobilisations` bounced straight back there, unconditionally. This
   predates Deployment's own hardcoded Office-Secretary exception
   (`deployment.routes.js`'s `canReadDeployments`); the redirect was never
   updated when that second legitimate destination was added, so a direct
   link to a deployment (e.g. the "View Deployment" link already present on
   a Mobilisation's own detail page, which she can already open) always
   bounced her away before the page ever got a chance to render. Fixed by
   also allow-listing `/deployments*`.
2. **The second, smaller piece**: `RequireSectionRead` itself only knew
   about the generic Section Access array, which Office Secretary can never
   appear in (canAccessSection's own floor excludes her role outright,
   regardless of any grant) — so even past the redirect, this guard would
   still have blocked her. Gained an `officeSecretaryBypass` prop, set only
   on the two `/deployments` routes, mirroring the server's own hardcoded
   exception exactly — it grants nothing beyond what the server already
   permits, it just stops the client from pre-emptively hiding a page the
   server would happily serve.

**A real bug found while making this fix, unrelated to the navigation logic
itself**: the earlier edit that added the `officeSecretaryBypass` doc
comment to `RequireSectionRead.jsx` had accidentally deleted its five
top-of-file import statements (`useAuth`, `useTranslation`, `Link`,
`EmptyState`, `Button`) while restructuring the comment block around them.
`npm run build` passed clean regardless — esbuild doesn't validate that a
referenced identifier was ever imported, only a real render does — so this
shipped invisibly until the component actually rendered, throwing
`ReferenceError: useAuth is not defined` and tripping the app's error
boundary. A long detour chasing this as a Vite dev-server cache problem
(restarted the dev server, cleared `node_modules/.vite`, unregistered the
PWA service worker, tried fresh browser tabs — none of it helped, because
none of it was the actual cause) ended once the served module's compiled
output was inspected directly and it was genuinely, deterministically
missing those five imports: a real source bug, not a caching ghost. Fixed
by restoring the import statements.

**Verified**: a fresh throwaway Office-Secretary login navigated directly
to the real Babu Ram deployment by URL and landed on the real page (no
bounce to Mobilisations, no "Something went wrong" crash) — correctly
showing no Demobilise button and a summary panel with Client agreement
hours / Total hours worked / Overtime hours but no OT amount line at all,
confirming both this fix and the OT-amount visibility fix above work
together correctly for the real persona they're both about. Throwaway
login removed afterward; no real data was modified.

### Follow-up (2026-09-13, same day): a day's hours could exceed 24, with no feedback at all

The user's own report, verbatim, with a screenshot of a day cell holding
"25": "What if somebody wrote 25? is it getting approved? How can somebody
work for 25 hours in a day?" The server was never actually at risk —
`deployment.validation.js`'s `dailyEntry` schema already does a real
numeric `.max(24)` check, not a pattern match, so a 25-hour day was always
going to 400 at submit time. The real gap was entirely on the client: the
form's regex (`/^((2[0-4]|1\d|\d)(\.\d+)?|[fFsSaA])$/`) matched "25" not at
all by digit-count coincidence but genuinely rejected it correctly — the
actual problem was that NOTHING in the UI reflected that rejection. The
live total simply summed whatever was typed, invalid or not, so a day of
"25" sat in a plain, unremarkable input, folded into a perfectly
plausible-looking "Total: 83h" summary line, with zero visual signal
anything was wrong until (and unless) Save was clicked — and even then,
this form's `handleSubmit(onSubmit)` had no `onInvalid` handler at all, so
a validation failure failed completely silently, the exact "standing rule
for every form in the app" (established when `MobilisationForm` gained
this) that this one form had never been updated to follow.

Fixed on both counts:
- **Live per-cell highlighting**: `deployments.schema.js`'s regex-based
  check was replaced with a real numeric range function
  (`isValidDailyEntry`) — shared by the Zod schema's `.refine()` and the
  grid's own live render, so a day showing red is provably the same rule
  the server will enforce, not a separate, looser client-side guess. Also
  fixes an adjacent latent bug the old regex had: `24.5` (or `24.9`, etc.)
  matched the digit-count pattern despite exceeding 24 hours — a real
  numeric comparison doesn't have that gap. An invalid cell gets a distinct
  danger-ringed style and a `title` tooltip explaining what's expected,
  live as it's typed, not just at submit time.
- **`onInvalid` toast added**: mirrors `MobilisationForm.jsx`'s own
  established pattern exactly (collect every field's error message, toast
  them joined, `console.error` the raw error object, generic fallback text
  if somehow empty). Found a real bug while wiring this in: a naive
  `Object.values(formErrors).map((err) => err?.message)` — the same shape
  `MobilisationForm` uses successfully — came back EMPTY here and silently
  fell through to the generic fallback text instead of the real message,
  because react-hook-form nests an array-FIELD-level `.refine()` error
  (`dailyHours`'s own) under `dailyHours.root.message`, not
  `dailyHours.message` directly — a shape `MobilisationForm` never hits
  since none of its own fields are arrays with a refine on the whole array.
  Fixed with a small recursive collector that finds a `.message` at any
  depth instead of assuming one fixed shape.

**Verified**: a script confirmed the server's own numeric `.max(24)` check
was never actually the gap (unchanged, already correct). Browser, against a
throwaway deployment (contract hours 200, `otClientRate: 20`): typed "25"
into day 1 and confirmed, live, a distinct red ring + tooltip appeared on
that one cell while the rest stayed normal, and the summary panel still
showed a plausible-looking total (265h, by design — a live preview, not a
validated one) alongside the now-visibly-flagged cell; clicked Save with
day 1 still "25" and confirmed via `console.error` output and the toast
region's actual rendered text that the SPECIFIC message ("Enter each day's
hours (0-24), or F/S/A for Off/Sick/Absent.") appeared — not the generic
fallback, confirming the recursive-collector fix — and via network
inspection that no request was ever sent to the server. Corrected day 1 to
a valid "9" and re-submitted: a real `201 Created` landed, and a direct DB
read confirmed the saved entry held `9`, not `25`. All throwaway data and
the verification script removed afterward.

### Follow-up (2026-09-13, same day): client-timesheet deductions, wired into real Payroll

The user's own ask, verbatim: "have an option to enter deductions, if a
worker is absent the client may deduct amount for that, so that will be in
the client's timesheet which the office secretary will enter here. which
has to be subtracted from the worker's salary and also the total profit."
Two real design forks here — how far the Payroll connection should go, and
whether the figure should be commercial-only like `otAmount` — were put to
the user directly before writing anything (this exact ask could mean
anything from "just show it here" to "build a real cross-module
integration"): they chose the harder, more complete path both times — a
real PayrollRun integration (not just an informational figure), and full
visibility to whoever enters it (unlike `otAmount`, since she's the one
who transcribed the number off a document in front of her — hiding it from
her afterward would hide nothing she doesn't already know).

**Deployment side**: a new `deductionAmount` on `monthlyHoursSchema` — a
plain, manually-entered number (there's no in-app formula for what a
client chooses to deduct, same posture as GOSI), accepted in
`addMonthlyHoursSchema`/`updateMonthlyHoursSchema`, subtracted directly in
`computeMonthlyProfit`. Not commercial: unlike `otAmount`, it's never
stripped from `getDeployment`/`listDeployments`, per the user's own call.
Surfaced everywhere `otAmount` is — the entry form (a plain input, not a
computed preview), the live summary panel, the historical entries table
(a permanent column, not gated by `canDecideHours`), and the Approve/Reject
modal.

**Payroll side — the real integration**: found, while researching how to
wire this in at all, that `PayrollRun.lines[].otherDeductions` already
existed as a generic ad-hoc deduction mechanism, and its own doc comment
already named "an absence" as an example use case — this feature slots
into an existing seam rather than inventing a new one. A new
`deployment.service.js` export, `deductionsForEmployeeMonth(employeeId,
monthStr)`, finds every Deployment that real Employee has with an
**Approved** (never Pending/Rejected — an unapproved, possibly disputed
figure must never reach a real paycheck) monthly-hours entry carrying a
deduction for that exact calendar month, and returns one `{label, amount}`
pair per match. `payroll.service.js`'s `createPayrollRun` calls it for
every eligible employee and seeds the result straight into that line's
`otherDeductions` — a genuine new one-directional dependency between two
modules that had never spoken to each other before (Payroll importing from
Deployment's service, mirroring the exact same "depend on the other
module's exported function, no circularity risk" shape this file's own
`mobilisation.service.js → deployment.service.js` call already uses).

**The one real limitation, made deliberate rather than accidental**: this
is snapshot-at-creation, exactly like every OTHER auto-computed Payroll
figure already is (`approvedHours`, `overtimeHours`, `sickLeaveDeduction` —
none of them re-read their source data after a run exists either). A
deduction entered or approved AFTER that month's PayrollRun already exists
is NOT retroactively pulled in. HR/Accounts can still add it by hand via
the run's own pre-existing `otherDeductions` editing (`updatePayrollLine`
already accepted arbitrary entries there, unchanged) — but only while the
run is still Draft, same fallback GOSI already relies on. **Real
operational consequence worth knowing**: for the deduction to be picked up
automatically, that month's Deployment hours must be entered AND approved
*before* that month's PayrollRun is created — not after.

**Only ever reaches Payroll for who this company actually pays**: a
Deployment's `worker` ref only exists when `workerType === 'Employee'`, and
`createPayrollRun`'s own eligible-employee query already only ever includes
`Employee.type === 'Outsourced'` (this company's own paid workforce — see
`payrollRun.model.js`'s doc comment). A SupplierEmployee/Freelancer
Deployment, or an Employee-type one whose underlying Employee is `'Own'` or
`'Subcontracted'`, still gets its profit reduced by the deduction (that
half of the ask applies universally) but has no PayrollRun line to ever
deduct from — `deductionsForEmployeeMonth` simply finds nothing for them,
by construction, not by a special case.

**Verified**: a script built a real throwaway Outsourced Employee +
Mobilisation + Deployment, entered a month with `deductionAmount: 250` —
confirmed it saved correctly and reduced the entry's own `profit` by
exactly 250; created a PayrollRun for that month WHILE the entry was still
Pending and confirmed `otherDeductions` came back empty (the "unapproved
never reaches a paycheck" rule, proven, not assumed); approved the entry,
created a fresh PayrollRun for the same month, and confirmed
`otherDeductions` held exactly one entry (amount 250, label naming the real
client), `totalDeductions` included it, and `netPay` was reduced by exactly
250 (3000 → 2750). 9/9 checks passed. Browser, against a throwaway
deployment: the "Client deduction" input appeared as a plain field (not a
computed preview) with its own hint text; typing 150 alongside a
270-hour month with one Absent day live-updated the summary panel to show
"Client deduction: SAR 150.00" next to OT amount, and the historical
entries table's Profit column correctly reflected `1400 (OT profit) − 150
(deduction) = 1250` after saving; the Approve/Reject modal's summary
included the same deduction line. All throwaway data, logins, and scripts
removed afterward.

## Follow-up (2026-09-14): Standby List — who's currently free to mobilise

A real user ask, arrived as two exploratory questions first ("what happens
to a subcontractor supplied worker when demobilised?" then "where can I see
the standby list?") — there was no such view. Rather than guess which
population "standby" meant, the two real candidate populations were
researched directly against the model code and live data (an Own+Worker-
login Employee's availability is a live `currentClient` field; a
SupplierEmployee/Freelancer worker has no such field at all — no Employee
record exists for them, so "standby" for them can only be *derived* from
their own placement history) and the genuine scope fork was put to the
user: own employees only, subcontractor/freelancer only, or both. Chose
**both, as one combined view** — two separate tables, not one merged list,
since the two populations have genuinely different shapes and data
sources.

New `GET /api/deployments/standby` (`getStandbyWorkforce`,
`deployment.service.js`, gated by the existing `deploymentsRelease` Section
Access read, same circle as the rest of this module): own employees are a
direct query (`type:'Own'`, has a Worker-role login, not Exited,
`currentClient: null`); subcontracted/freelance workers are derived via an
aggregation — group every non-Employee Mobilisation by Iqama number, take
each worker's most recent one, and treat a most-recent status of
`Completed` as available. Documented, deliberate v1 simplification: a
worker whose newest record is still Draft/PendingReview/Rejected won't
appear even though they're arguably free — no persisted "current
availability" field exists for this population to check instead, and a
fallback cascade wasn't worth building for a first version. New
`StandbyListPage.jsx` at `/deployments/standby`, reached via a "Standby
list" button on the Deployments list page; own-employee rows link through
to their profile, each table has its own empty state, and a header action
links straight to New Mobilisation.

**Verified**: `npm run build` passed clean, both locale files validated as
correct JSON. Called the endpoint directly via curl with a throwaway admin
against real data (one real Own employee free of a current client, two
real subcontracted workers each correctly inferred as available from their
actual Mobilisation history, with the right `lastClientName`/`lastEndDate`/
`lastEndReason` pulled from their real ended Deployment records) — then the
same in the live browser: navigating to `/deployments/standby` directly,
clicking the new button from the Deployments list, and clicking through an
own-employee row to their profile, all confirmed correct with clean network
responses. Throwaway admin deleted afterward.

## 2026-09-16 follow-up: an Ended deployment's own final month was unreachable

Real user-reported gap, found from a screenshot of the "Monthly Client
Hours & Overtime" card: once a deployment ended, the client UI showed a
flat "This deployment has ended — hours can no longer be entered" note
with no way to add hours at all — even for the deployment's own real,
never-entered FINAL month. `deployment.service.js`'s `addMonthlyHours` has
allowed exactly this since the 2026-09-14 QA-audit fix (F5: "an Ended
deployment can still get its own FINAL month entered, as long as that
month is one it was actually active for") — the server was already
correct; the client's `DeploymentDetailPage.jsx` simply never gave a path
to reach it, gating the whole add-hours form behind `deployment.status ===
'Active'` with no exception. Fixed by mirroring the server's exact rule
client-side: a new shared `maxEligibleMonthFor(deployment)` caps eligibility
at `min(previousMonthStr(), endMonth)` when the deployment has ended (a
month can never be entered before the real calendar month itself has
elapsed, ended deployment or not — the server's own separate, unconditional
`data.month >= currentMonthStr()` check, confirmed by first reproducing the
WRONG fixture: a deployment that both started and ended within the still-
in-progress current month correctly shows no eligible month yet, matching
the server). `nextEligibleMonth` and the add-hours form's own native
`<input type="month">` min/max both now use this same helper (DRY — was
previously duplicated as two separate `previousMonthStr()` calls). The
render gate itself reordered: a real eligible month (Active OR Ended) now
takes priority over both the "ended" and "nothing eligible yet" fallback
messages, which only ever show once there's genuinely nothing left.
`endedNote`'s own text was inaccurate ("hours can no longer be entered" —
not true, that's exactly the case this fix opens back up) and corrected to
describe what's actually true once that message is showing: every month
the deployment actually covers has already been entered.

**Verified** with a real fixture (mirroring the exact reported scenario):
an Employee deployment started and demobilised entirely within August 2026
(a month that has since fully elapsed) with zero monthlyHours entered.
Before checking, first confirmed the fix does NOT over-fire: an otherwise-
identical deployment that started/ended within the CURRENT still-open
month correctly still shows no eligible month (matching the server's
"hasn't calendar-elapsed yet" rule). Then, for the real past-month case:
the add-hours form appeared with the day grid correctly sized to August
(31 days) and the month input's own min/max both pinned to `2026-08` (the
only real eligible month); submitting 160 real hours across the deployment's
actual 1–20 August placement window (with 21–31 marked Off, confirming
`assertWorkedDaysWithinPlacement` still correctly rejects a Worked claim
outside the real placement — caught this exact server 400 on a first,
overly-broad test fill and correctly diagnosed it as the validation working
as intended, not a bug) returned a real 201 Created; the page then
correctly showed the new August entry (Contract 208 / Actual 160 / Profit
SAR 6,240.00 / Pending) and the note switched to the corrected
"already been entered" message. Full server test suite (38/38) and both
apps' lint stayed clean throughout; all throwaway fixtures deleted
afterward.

## 2026-09-16, same-day follow-up: no more waiting once Ended + day-by-day grid reverted to typed totals

Two real, user-driven changes, delivered together since the second builds
directly on the first's eligibility rule.

**1. An Ended deployment no longer waits for the calendar month to elapse
at all.** The follow-up above only widened eligibility to the deployment's
own FINAL month once that month had itself calendar-elapsed (the
14 September original fix's own limit). The user's own correction, given a
concrete example (mobilised 1 April, demobilised 16 April): "waiting for
month completion is for people who are still mobilised in that month and
not demobilised." Once Ended, the whole placement is already history —
nothing to wait for — so every month from start through the real end date
is now immediately enterable, including the still-in-progress CURRENT
calendar month. `deployment.service.js`'s `addMonthlyHours` now branches
cleanly: `Active` → same "must have already calendar-ended" rule as always;
anything else (`Ended`) → only bounded by the deployment's own real
placement dates, no month-elapsed check at all. `maxEligibleMonthFor`
(client) mirrors this exactly.

**2. The day-by-day grid (2026-09-12) is reverted back to two typed
totals** — "Client timesheet hours" and "Days worked" — the shape this app
used even earlier, before the grid existed (see
docs/MOBILISATION-notes.md's 2026-09-12 follow-up: `otHours = max(0,
clientTimesheetHours - requiredTimesheetHours)`, the SAME formula the grid
era already used under the name `actualHours`/`contractHours` — so this
reversion only changes how `actualHours` is entered, not the OT/profit math
downstream of it, which is untouched). Explicitly a full replacement, not
an added option (the user's own choice from 3 clarifying questions asked
before starting): Off/Sick/Absent per-day tracking, the weekday grid, and
keyboard day-to-day navigation are gone from the entry form. Two things
were deliberately preserved rather than discarded:
  - **Existing entries keep their real daily breakdown, view-only.** A
    pre-2026-09-16 entry's `dailyHours` array stays in the model and
    renders in a new collapsed `LegacyDailyBreakdown` (a "View daily
    breakdown" expander) on the summary table — nothing is destroyed or
    hidden. It's cleared to `[]` only if that SPECIFIC entry is later
    corrected — at that point its real data becomes the new typed totals,
    so displaying a now-stale daily array next to them would be
    misleading. No entry is ever bulk-migrated; only touched-on-edit.
  - **A lighter sanity check replaces the old per-day placement guard.**
    The grid era's `assertWorkedDaysWithinPlacement` (rejecting a 'Worked'
    day outside the deployment's real start/end) is replaced by
    `assertDaysWorkedWithinPlacement`: `daysWorked` can't exceed
    `realPlacementDaysInMonth` — the same real day-count the old check
    computed per-day, just compared against one typed number instead of
    31. The user's own explicit choice from the clarifying questions
    (recommended and chosen): keep SOME check rather than trust the two
    numbers blindly.
  `daysWorked` itself is new on the model (default 0 — never invented for
  a genuinely pre-2026-09-16 record), purely informational/cross-check,
  not part of the OT formula. `otAmount`/`profit` stay the only commercial
  fields stripped for a non-decider (unchanged); `actualHours`/`daysWorked`
  are visible to anyone who can see the section at all, same treatment
  `actualHours` already had.

**Visibility for Managers (the user's third ask)** — already fully
satisfied by the existing `deploymentsHoursDecide` Section Access key: it's
admin-configurable via real `ApprovalRole`s (not a hardcoded login role),
and already gates every commercial figure here (`otAmount`, `profit`) at
both the read tier (see this file's 14 September follow-up) and write
tier. Nothing new needed — an Admin grants it to whichever real role
(Marketing Manager, COO, etc.) should see these figures, exactly the
pattern this whole app already uses everywhere else.

**Verified**, both parts together, live against a real fixture: an
Employee deployment demobilised THIS calendar month (still in progress,
confirming part 1 doesn't wait), with one pre-existing "legacy" August
entry seeded with real `dailyHours`. The add-hours form appeared
immediately for September (previously impossible — a deployment ending
mid-current-month used to show nothing eligible at all until next month).
The month input's own min/max correctly pinned to `[2026-08, 2026-09]`.
Submitted `daysWorked: 15` against a real 10-real-placement-day September
window (ended the 10th) — correctly rejected with the exact new error
message; corrected to `8` — real `201 Created`, table showed
`80 / 8 / 0 OT / SAR 6,240 profit / Pending`. The legacy August row's "View
daily breakdown" expanded to the real weekday-labeled 31-day grid with
every value intact. Full server test suite (38/38) and both apps' lint
stayed clean throughout. All throwaway fixtures deleted afterward.

## Follow-up (2026-09-16): Standby List gets a real "Mobilise" action

The Standby List (above) was deliberately read-only at first — "mobilising
someone starts on the regular New Mobilisation form." The user asked to
close that gap: a real "Mobilise" button per row that deep-links straight
into New Mobilisation with that worker already filled in, rather than
someone re-typing or re-searching for a worker they just looked at.

Scoping question put to the user first (`AskUserQuestion` skipped here —
this was answered directly in the prior turn's design discussion): prefill
via URL query params, read once into `MobilisationForm`'s `defaultValues`,
rather than pushing values in after mount via router state. Query params
survive a refresh/back-button and match this app's existing patterns; no
new permission needed — the deep-link is just a shortcut into the same
`/mobilisations/new` route, gated by the same `mobilisationsSelfMobilise`/
Office-Secretary rules as always, and the double-placement/date-overlap
guards on submit are the real enforcement point regardless of how someone
arrived at the form.

- **Own Employee row**: `?workerType=Employee&worker=<id>` only — their
  live Employee record is already the trustworthy source for name/
  nationality/phone, no need to snapshot it into the URL.
- **SupplierEmployee/Freelancer row**: `?workerType=...&workerName=...
  &iqamaNumber=...&nationality=...&phone=...` (+`subcontractor=<id>` for
  SupplierEmployee) — the same fields `MobilisationForm`'s own Iqama-
  autofill/`PreviousWorkerPicker` (see `docs/MOBILISATION-notes.md`'s
  second 2026-09-16 follow-up) already know how to fill in; this is just a
  second way to arrive at that same filled-in state. `getStandbyWorkforce`
  gained one new field on the subcontracted-workers side, `subcontractor`
  (the real id — it already returned `subcontractorName`, a display-only
  snapshot with nothing to select a picker by).
- `MobilisationNewPage` reads these via `useSearchParams()` into a small
  `prefillFromSearchParams` helper, merged over `emptyMobilisationForm` —
  an unrecognized/garbled `workerType` just falls back to a blank form,
  same as arriving with no query string.
- `StandbyListPage`'s "Mobilise" button needed no `stopPropagation()`
  wiring on the still-row-clickable Own Employees table — `Table.jsx`'s own
  row-click handler already ignores clicks landing on a `<button>`/`<a>`.
- Fixed one real latent rough edge surfaced while building this:
  `useIqamaAutofill`'s "already applied" tracking ref used to always start
  at `null`, so a form that arrived ALREADY holding a full 10-digit Iqama
  (this new deep-link, but also — pre-existing — every ordinary
  `MobilisationEditPage` open on a SupplierEmployee/Freelancer record)
  re-ran the lookup and re-showed "Found X from a previous mobilisation…"
  immediately on load, for a value that was never actually new. Fixed by
  seeding that ref from the form's own starting Iqama instead of `null` —
  a form that starts already filled in has nothing new to announce.

**Verified live** against real fixtures (an Own Employee with no current
client, a SupplierEmployee whose most recent Mobilisation is Completed
with a real ended Deployment): both rows show a "Mobilise" button; clicking
the Own Employee's row navigates to New Mobilisation (not the Employee
profile — confirming row-click suppression works) with `workerType=Employee`
and the correct worker pre-selected in the dropdown; clicking the
SupplierEmployee's button lands on New Mobilisation with workerType,
worker name, Iqama, nationality, phone, and subcontractor all correctly
pre-filled, subcontractor correctly pre-selected in its own dropdown, and
— confirming the `useIqamaAutofill` fix — no redundant toast fired on load.
Server test suite 38/38, both apps' build/lint clean (same 16 pre-existing
baseline warnings). All fixtures deleted afterward.

## Follow-up (2026-09-16, fourth same-day): a real, narrow Deployment Edit —
## new 'deploymentsEdit' Section Access key, MM granted now

Deployments have never had an edit route — the model's own doc comment is
explicit that they're "never created or edited by hand." The user asked for
a real one: "have an option in deployment to edit details about that
deployment... but only with people with that access... add that to section
access and give MM the write and read access now." They also wanted it
reachable from the Deployment detail view itself ("from there the MM for
now can edit, but if admin give access others can also access").

**Scope, a deliberate judgment call** (not everything the user said was
literally spelled out field-by-field, so this was reasoned from the model
and flagged rather than asked): editable is `site`, `workerName`,
`requiredTimesheetHours`, and a new `notes` field the model already had but
nothing ever read or wrote — all four are free-typed SNAPSHOT fields with no
cascading side effects elsewhere. Deliberately NOT editable through this
endpoint: `client`/`subcontractor` (re-pointing either would strand
`Employee.currentClient`, the active-placement uniqueness guard, and every
already-entered month's OT-rate lookup, which all still resolve through the
ORIGINAL client/subcontractor — a real "transfer" flow would need its own
side-effect handling, out of scope here), `worker`/`workerType`/
`mobilisation` (identity is decided once, at Deployment-creation time, by
which Mobilisation produced it), and every lifecycle field —
`startDate`/`endDate`/`status`/`endReason`/`demobilisationOutcome`/
`releaseNote` — since Demobilise already owns that whole side of the record.
Works regardless of `status` (Active or Ended) — correcting a typo on an
already-ended placement is exactly as legitimate as on a live one.

New `PATCH /api/deployments/:id` (`deployment.service.js`'s
`updateDeployment`), gated by a new Section Access key, `'deploymentsEdit'`,
at the `write` tier — Admin-only until granted, no Office Secretary bypass
(unlike hours entry, this was never one of her hardcoded business-rule
exceptions). Same Coordinator team-scoping check
(`assertEmployeeVisibleToActor`) every other deployment mutation already
has, and a real before/after audit log entry, same shape as the monthly-
hours correction's own. Per the user's explicit instruction, granted the
company's real "MM" ApprovalRole write access immediately via a new,
permanent, idempotent script — `npm run grant:deployments-edit`
(`src/scripts/grant-deployments-edit.js`), mirroring
`grant-profit-visibility.js`'s exact pattern (a real Admin actor for the
audit log, additive/merges into whatever's already granted, safe to re-run)
— write already implies read (see `canAccessSection`), so no separate read
grant was needed, same convention every other write-only grant in this app
already follows.

Client: a new "Edit" button on `DeploymentDetailPage` (next to the status
badge, visible whenever `user.sectionAccessWrite` includes
`'deploymentsEdit'` — same pattern `canDemobilise`/`canEnterHours`/
`canDecideHours` already use) opens a small in-page `Modal` form — no new
route/page, matching this file's own stated design ("this is the ONLY place
a deployment is managed"). The Placement card also gained a `notes` display
row (using the field for the first time). `deploymentsEdit` was added to
`sectionAccessModules.js` alongside the other 3 Deployments keys so it shows
up on the admin Section Access page.

**Verified**: server-side via direct `curl` calls against a real, existing
production-data Deployment (an Ended SupplierEmployee placement,
"Ram Dev" / UNITED ARK CONTRACTING) — a throwaway Coordinator with no grant
got a clean `403` at the route gate; a throwaway user added to the REAL
"MM" ApprovalRole got a real `200`, the edit persisting correctly on an
Ended deployment (proving the "works regardless of status" design). Client-
side in the browser as that same MM-role user: the Edit button appears, the
modal opens pre-filled with the record's actual current values, submitting
a real change (site + notes) saves and immediately reflects in the
Placement card including the new Notes row; as the unauthorized Coordinator,
the whole page correctly 403s before the button question even arises
(no `deploymentsRelease` read grant at all — a coarser but correct block).
The real Deployment record was restored to its exact original values
afterward (the PATCH endpoint can't clear a field back to empty by this
app's own PATCH convention — "omit means leave as-is" — so `notes` was
cleared directly via a one-off script, same as every other value was
verified byte-for-byte restored). All throwaway users deleted, the real
"MM" role's membership restored to exactly its original single member — the
actual `deploymentsEdit` grant to MM itself is the one permanent, intended
change. `npm run build`/`npm run lint` clean on both apps (same 16
pre-existing baseline warnings), server test suite still 38/38.

## Follow-up (2026-09-16, fifth same-day): register defaults to Mobilised,
## a searchable client filter, Excel export, and a spreadsheet-style Overview

The user's own four-part ask, from a screenshot of the register:

1. **Status filter defaults to 'Active' ("Mobilised")** on page load, not
   "All statuses" — this page is checked far more often for "who's out
   right now" than for full history. A real click on "All statuses" still
   shows everything; only the FIRST thing you see changed.
2. **The client filter is now a real search box**, not a long plain
   `<select>` — new `components/ui/SearchableSelect.jsx`, a themed
   type-to-filter combobox resolving to a real option's `value` (an id),
   not free text (unlike the existing `SuggestInput`, which conflates
   the typed text with the stored value — fine for a free-typed field, not
   for "pick one real client"). Drops into any `{value,label}[]` picker as
   a straight `<Select>` swap; the register's own "All clients" option is
   just the first entry in the list, same convention every plain `<Select>`
   already uses for its own blank option.
3. **A real "Export to Excel"** — new `deployment.export.js` (mirrors
   `mobilisation.export.js`'s exact pattern: one worksheet, one row per
   deployment, bold header row), a new `GET /api/deployments/export`
   (same filters and same `canReadDeployments` gate as the register itself,
   no pagination, capped at `DEPLOYMENT_EXPORT_MAX_ROWS = 5000` — same
   sanity-bound reasoning as Mobilisation's own `EXPORT_MAX_ROWS`). The
   list/export filter-building logic was factored into one shared
   `findDeployments` helper so the two callers (`listDeployments`,
   `exportDeployments`) can never drift apart on what counts as a visible
   row — same "one real query builder" convention `mobilisation.service.js`'s
   own `findVisibleMobilisations` already established.
4. **A new "Overview" button** opens a full-width Modal
   (`DeploymentOverviewModal.jsx`) showing EVERY deployment — deliberately
   unfiltered by the register's own status/client pickers, a "see
   everything" escape hatch, same framing as the Standby List's own
   separate unfiltered view — in one spreadsheet-style table: every column
   the Excel export itself has, each with its own Excel-style column
   filter (a free-text substring filter for a free-typed column; a
   picklist built from the DISTINCT values actually present in the loaded
   data — not a static enum list — for worker type/status/end reason, a
   real AutoFilter feel). All filtering is client-side against one bulk
   fetch (`listDeployments` with a raised `limit`, see below) — instant on
   a few hundred already-loaded rows, no round-trip per keystroke. A row
   click closes the modal and opens that deployment's own detail page,
   matching the register's own row-click convention.

No new endpoint was needed for the Overview's own data — it reuses the
EXISTING `listDeployments`/`GET /deployments`, whose `limit` schema cap
was simply raised from 100 to 5000 (the register's own paginated UI still
only ever requests 20 at a time; the Overview modal is the one real caller
that asks for "everything").

**Verified live** in the browser: the register loaded with "Mobilised"
pre-selected (3 of 7 real deployments, matching the exact screenshot's
count); typing "united" into the new client search box correctly narrowed
the dropdown to just "UNITED ARK CONTRACTING", and selecting it correctly
narrowed the register to 2 rows; opening Overview showed "7 of 7" (proving
it ignores the register's own current filters) with all 11 columns and
correctly-populated enum picklists; setting Status=Demobilised narrowed
7→4, adding a Site="Jizan" text filter on top correctly narrowed further
to the exact 3 real rows matching both; "Clear filters" correctly reset to
7; clicking a row correctly closed the modal and navigated to that
deployment's own detail page. The Excel export was confirmed via a direct
authenticated request — a real `200`, correct `.xlsx` content type, and
the downloaded bytes independently confirmed as a genuine "Microsoft Excel
2007+" file. `npm run build`/`npm run lint` clean on both apps (one new
`react-hooks/exhaustive-deps` warning surfaced and fixed during this same
pass — `rows` needed its own `useMemo` for a stable reference, or it
recomputed the two dependent `useMemo`s on every render; back to the same
16 pre-existing baseline afterward), server test suite still 38/38.
Throwaway admin deleted afterward.

**Same-day addendum: "is all the entered data actually there?"** — the
user asked directly, and the honest answer was no: `monthlyHours` (the
real, ongoing client-timesheet-hours/OT ledger — the biggest piece of data
this whole module accumulates over time) wasn't in the Overview at all.
Put the design choice to the user directly (it's a one-to-MANY field — one
deployment, many months — so it can never be a flat column the way Site/
Status are): expandable row detail, their own pick from real options
(summary columns only; a separate per-month tab; leave it out entirely).
Each row gained a chevron toggle (stays independent of the row's own
click-to-detail-page behavior — `stopPropagation` on the toggle) that
reveals that deployment's full month-by-month breakdown inline: Month,
Contract hours, Actual hours, Days worked, OT hours, OT amount, Deduction,
Status, Notes — the exact same column set `DeploymentDetailPage`'s own
monthly-hours table already uses, reusing its existing i18n keys rather
than inventing new ones. `OT amount` is commercial (see the model's own
doc comment) and is already stripped server-side for anyone without
`deploymentsHoursDecide` — the column only renders here at all if the
already-loaded data actually has it on at least one entry (never a
client-side permission re-check). Multiple rows can be expanded at once.

**Verified live** against real production data (not fixtures): a Sharuk
Khan deployment with no months entered correctly showed the "No monthly
hours entered yet" empty state; a SECOND Sharuk Khan deployment with a
real 2026-08 entry correctly expanded to show every one of the 9 columns
via direct DOM inspection — Month `2026-08`, Contract `260`, Actual `300`,
Days worked `—` (a legacy entry predating that field), OT hours `40`
(correctly server-computed as `max(0, 300-260)`), OT amount `SAR 8.00`
(the real stored commercial figure, correctly visible to this Admin
viewer), Deduction `—`, Status `Approved`, Notes `—`. `npm run build`/
`npm run lint` clean on both apps (same 16 baseline warnings). Throwaway
admin deleted afterward.

**Second same-day addendum (2026-09-17): "fill more screen" + "need every
single data entered in mobilisation," with a real scroll-wheel-friendly
Excel feel** — from a screenshot of the Overview modal itself. Three
changes, one genuine design fork put to the user directly first (this
app's own consistent posture toward commercial data — see e.g. otAmount/
profit's own gating above): should the 9 Mobilisation rate/commission/
profit columns appear here at all, and if so, gated how? The user chose
"include, gated like otAmount" — the same `deploymentsHoursDecide` read
check this module already uses for otAmount/profit, applied to the whole
commercial column group at once.

1. **Modal sizing** — a new `size="screen"` on the shared `Modal.jsx`
   (near-edge-to-edge width, `max-h-[97vh]`, tighter outer padding),
   distinct from the existing `size="full"` so
   `MobilisationDocumentPreviewModal`'s own unrelated use of `full` is
   untouched. The inner table's own scroll container grew to match
   (`max-h-[calc(97vh-170px)]`, was a fixed `65vh`).
2. **Horizontal scroll "like Excel"** — already native (the table's own
   wrapper already had `overflow-auto`); no custom wheel-hijacking added —
   the browser's own shift+wheel/trackpad-swipe/scrollbar-drag already
   behaves exactly like a real spreadsheet's horizontal scroll once the
   table is genuinely wider than the viewport, which it now is with ~30
   columns.
3. **Every Mobilisation field this app already treats as export-worthy**
   (mirroring mobilisation.export.js's own `WORKER_COLUMNS`+
   `RATE_COLUMNS` field list/order exactly — the set that module already
   calls "the exportable mobilisation data," not a broader new
   definition) is appended to both the Overview modal and the Excel
   export: `serialNumber`, `jobTitle`, `iqamaNumber`, `nationality`,
   `phone`, `checkoutDate`, `fta`/`ftaType`, `allowance`/
   `allowanceRemark` (always shown), then `clientRate`,
   `clientCommission`, `subcontractorRate`, `subcontractorCommission`,
   `otClientRate`, `otEmployeeRate`, `profitPerHour`, `profitPerMonth`,
   `otProfitPerHour` (commercial, gated — see above). Deliberately
   EXCLUDED, matching mobilisation.export.js's own established scope:
   `coordinators`, `documents`, the quotation/PO reference fields, and
   Mobilisation's own free-typed `remark` — none of those are in that
   module's own export either. Also excluded as pure duplicates of a
   field Deployment already snapshots: `workerName`/`workerType`/
   `clientName`/`subcontractorName`/`site`/`requiredTimesheetHours`, and
   `mobilisationDate` (byte-for-byte `Deployment.startDate` — see the
   model's own doc comment).

   Server-side: `deployment.service.js`'s `findDeployments` now populates
   the full `MOBILISATION_OVERVIEW_FIELDS` set onto `mobilisation`
   (previously just `serialNumber`) and strips the 9 commercial keys via a
   new `stripMobilisationCommercial()` for anyone without
   `deploymentsHoursDecide` read — same function/gate reused by
   `listDeployments` AND `exportDeployments` (one query builder, per this
   file's own established convention), so the modal and the downloaded
   `.xlsx` can never drift on what a given viewer is allowed to see.
   Client-side: the commercial columns only render at all if the loaded
   data actually has at least one (`hasCommercialMobilisation`, same
   pattern as `hasOtAmount`) — never a static assumption re-checked
   client-side.

   **Verified**: a direct script-based check against the real dev
   database (`exportDeployments(filters, actor)` called once with
   `actor: null` and once with a full-access Admin actor) confirmed a
   non-decider's response has `jobTitle`/`serialNumber` present but
   `clientRate`/`profitPerMonth` and `monthlyHours[].otAmount` genuinely
   absent (not just blanked), while the Admin actor's response has all
   three — proving the strip is real, not just hidden in the UI. Live
   browser click-through as a throwaway Admin: the modal now fills nearly
   the whole viewport; scrolling right through all ~30 columns showed
   every new field with real data (`MOB-0053`, job titles, real SAR rate/
   commission/profit figures reading correctly against the deployment's
   own already-verified numbers); the existing expand-row monthly-hours
   toggle still works unaffected, stacked to the right of the new
   columns. `npm run lint` clean on the client (same 16 baseline
   warnings); both edited server files pass `node --check`. Throwaway
   admin deleted afterward.

**Third same-day addendum (2026-09-17): fill the full viewport height, a
Month filter, a sticky totals row, a real month-specific profit figure,
and green/red profit coloring** — from another screenshot of the same
modal, all client-side (no server change).

1. **Fills the full viewport height**, not just width — `Modal.jsx`'s
   `size="screen"` was previously a shrink-to-fit `max-h-[97vh]`
   (correct width, but a short table left it centered with dead space
   above/below). Reworked to a FIXED `h-[calc(100vh-1.5rem)]` and top
   alignment instead of vertical centering, with the content area now a
   flex child (`min-h-0 flex-1`) that fills the remainder — so the
   modal's own table region gets that space directly, regardless of row
   count.
2. **Month filter** (toolbar, not a per-column filter — it doesn't
   correspond to one flat field): narrows rows to deployments with a
   `monthlyHours` entry for the selected month, options built from
   whatever months are actually present (same "real AutoFilter" pattern
   as every enum column filter). Only shown when there's commercial data
   to filter for at all.
3. **`otProfitPerHour`/`profitPerMonth (estimate)` swapped display
   order** (the user's own ask).
4. **A new `Total profit per month` column** — `profitPerMonth` (the
   pre-deployment estimate, no OT) plus that month's REAL OT contribution
   (`otProfitPerHour × otHours`, off the matching `monthlyHours` entry —
   always present, since a row only appears once it's passed the month
   filter). Only rendered once a month is actually selected — in the
   normal, all-months view it's hidden entirely (an "estimate + 0 OT"
   number for no month in particular would just be a confusing duplicate
   of `profitPerMonth`).
5. **A sticky totals row** (`<tfoot>`, `sticky bottom-0`, mirrors the
   header's own `sticky top-0`) sums every commercial rate/commission/
   profit column — plus the new Total-profit-per-month column when
   showing — across whatever rows are currently visible. This is the
   actual point of the whole follow-up: filtering to one month makes that
   row read as "this month's total profit" across the matching
   placements.
6. **Profit coloring** — `profitPerHour`/`otProfitPerHour`/
   `profitPerMonth`/the new total column render green for a positive
   figure, red for negative, in both the per-row cells and the totals
   row — reusing `MobilisationDetailPage.jsx`'s own established
   `profitClass` convention (`text-success`/`text-danger`) verbatim
   rather than inventing a new color scheme. Only these four
   profit-labeled columns get colored; the plain rate/commission columns
   (and their totals) stay the default text color even when their sum is
   zero.

**Verified live** as a throwaway Admin against real production data:
selecting `2026-08` correctly narrowed 8 deployments to the 2 with an
actual August entry, the totals row summed correctly (e.g. Client rate
`SAR 45.00 + SAR 13.00 = SAR 58.00`), `OT profit per hour`/
`Profit per month (estimate)` appeared in the swapped order, `Total
profit per month` showed `SAR 2,647.00` in green for the row with real
profit and `SAR 0.00` in the default (neither-color) for a row whose
figures were zero, and clicking "Clear filters" reset the month filter
back to all 8 rows with `Total profit per month` correctly disappearing
entirely. `npm run lint`/`npm run build` both clean (same 16 baseline
warnings). Throwaway admin deleted afterward.

**Fourth same-day addendum (2026-09-17): the expand-row dropdown is gone,
replaced by month-specific flat columns; the totals row now also covers
FTA/Allowance** — from a third screenshot of the same modal, the user's
own explicit ask ("instead of this dropdown"). One financial formula was
put to the user directly before building (regular-only vs. regular+OT
combined for "total amount we got" that month) — they chose regular+OT
combined.

- The expandable-row/chevron mechanism (2026-09-16's own "Same-day
  follow-up," above) is removed outright — its whole purpose is now
  covered by the Month filter (from the prior addendum): once a month is
  picked, three new flat columns appear where the dropdown used to be
  needed: **Hours worked this month** (that month's real `actualHours` —
  not commercial, shown regardless of `hasCommercialMobilisation`, same
  visibility `actualHours` always had in the old dropdown), **OT amount
  this month** (gated by `hasOtAmount`, same signal as before), and
  **Total amount this month** — `entry.contractHours × clientRate +
  otAmount` (the "regular + OT combined" billing for that month, the
  user's own choice between two options put to them directly, using
  `entry.contractHours`, the historical snapshot taken at that month's own
  entry time, not the deployment's current `requiredTimesheetHours`).
- The sticky totals row was reworked from "sum every column after a fixed
  colSpan" (which assumed every summable column sat contiguously at the
  END of `columns` — no longer true once `mobFta`/`mobAllowance`, positioned
  EARLIER in the column order, also needed a total) to "map the full
  `columns` array, sum whichever ones have a `getNumber`, blank otherwise" —
  this is what actually fixes the user's own catch ("we missed FTA and
  Allowance"): both existing columns just needed a `getNumber` added, no
  longer needing to sit next to the other summed columns.
- The Month filter dropdown itself is no longer gated behind
  `hasCommercialMobilisation` — "Hours worked this month" is useful to
  every viewer regardless of commercial access, so the filter needs to
  exist for everyone, not just a decider.

**Verified live** as a throwaway Admin: the chevron/dropdown column is
gone entirely (a plain flat table); the totals row's FTA total (`SAR
2,000.00`) and Allowance total (`SAR 1,300.00`) matched a hand sum across
all 8 rows; selecting `2026-08` correctly narrowed to 2 rows and every
new column matched the formula exactly — e.g. row 1 (`260` contract
hours × `SAR 45` client rate + `SAR 135` OT amount = `SAR 11,835`,
row 2 = `SAR 3,388`, totals row = `SAR 15,223`, matching `11,835 + 3,388`
by hand); clicking "Clear filters" correctly returned to all 8 rows with
all three month-specific columns gone and `Profit per month (estimate)`
back as the last column. `npm run lint`/`npm run build` both clean.
Throwaway admin deleted afterward.

**Fifth same-day addendum (2026-09-17): a real Year+Month picker, plus a
grant script for the "View mobilisation" access gap reported the same
day** — two unrelated asks from the same message.

1. The single Month `<select>` (built from `uniqueSorted` of whatever
   months actually have data — so a month with NO data was simply never
   selectable at all) is now two independent selects, Year and Month —
   the user's own explicit ask, so a genuinely empty month can be picked
   on purpose and answered with a real "no data" message rather than not
   being choosable in the first place. `yearOptions` is a CONTIGUOUS
   range (every year touched by any deployment's own dates or
   `monthlyHours` entries, plus the current year) — not just years that
   have data, same reasoning as the month picker itself. `MONTHS` is a
   fixed 12-entry list (value `'01'`-`'12'`, English month names, matching
   `lib/utils.js`'s own `formatDate`'s English-only convention). The two
   selects combine into the same internal `monthFilter` ('YYYY-MM')
   string every other part of this file already reads — filtering only
   takes effect once BOTH are chosen.
2. When the Month filter narrows to zero rows, the empty-state message
   now reads "No deployments for {{month}}" (e.g. "No deployments for
   March 2026", via a new `monthLabel()` formatter) instead of the
   generic "try clearing filters" text — the user's own requested wording.
   A real bug was found and fixed live during this same verification
   pass: that empty-state `<td>` has `colSpan={columns.length}` (now
   ~30, spanning the full width of every Mobilisation column added
   earlier today) with CENTERED text — centering text in a cell that wide
   renders it far past the right edge of the visible, left-scrolled
   viewport, invisible without scrolling deep into the table. Fixed by
   left-aligning it instead, so it appears immediately at the table's own
   left edge, exactly where the viewer is already looking.
3. Separately: the "View mobilisation" 403 the user hit (reported via a
   screenshot the same day) was investigated and confirmed NOT a code bug
   — `deploymentsRelease` (which Manager gets by default) and
   `mobilisationsViewer` (which has NO default grant) are genuinely
   independent Section Access keys, so seeing a Deployment never implied
   seeing its source Mobilisation. Per the user's own instruction ("grant
   mobilisationsViewer to Shameer's role, MM"), added a new permanent,
   idempotent setup script, `npm run grant:mobilisations-viewer` (mirrors
   `grant-deployments-edit.js`'s exact shape, just the READ tier —
   `mobilisationsViewer` is pure-read by design, no write tier exists to
   also grant). Run once against the local dev database to verify it
   merges additively (6 roles afterward, none removed) — this still needs
   to be run against whichever database the user's actual staging/
   production environment uses (this session has no credentials for that
   Render-hosted database), the same one-time step every other
   `grant:*`/`migrate:*` script in this repo already requires per
   environment.

**Verified live**: Year select correctly offered only `2026` (the one
year present in this dev database's real data); Month select offered all
12 full names; picking Year 2026 + Month March (no data) showed "No
deployments for March 2026" immediately visible without scrolling;
switching Month to August correctly narrowed back to the same 2 rows
verified in the prior addendum. `npm run lint`/`npm run build` both
clean. Throwaway admin deleted afterward.

**Sixth same-day addendum (2026-09-17): drag-and-drop column reordering**
— "can I rearrange each column... like drag and drop needed column
space," the user's own ask. Native HTML5 drag events on each column
header (row 1 only — the filter row's inputs/selects underneath stay
non-draggable so clicking them still works). `columnOrder` is a plain
array of column KEYS, not a second copy of the column definitions;
`orderedColumns` re-sorts the real `columns` array against it every
render, so a column that appears or disappears (the whole commercial
group, the month-specific ones, depending on the Month filter or the
viewer's own access) never desyncs — a stored key with no matching
column is dropped silently, and any column not yet in the stored order
appends at the end in its normal position. Persisted to `localStorage`
(a personal display preference, not worth a server round trip — same
convention `DashboardPage.jsx`'s own expiry-threshold setting already
uses), so an arrangement survives closing and reopening the modal. A
"Reset columns" button (next to "Clear filters", only shown once a
custom order exists) clears it back to the built-in order.

**Verified**: the in-app browser's own simulated drag (mouse-down-move-up)
does NOT trigger native HTML5 drag events — a known automation
limitation, not a real-user issue — so this was verified by dispatching
real `DragEvent`s (`dragstart`/`dragenter`/`dragover`/`drop`/`dragend`)
via a script against the live page, WITH real delays between each event
(matching the natural timing of an actual mouse drag). A same-script test
with NO delays between events initially showed no reorder — a stale-
closure artifact of dispatching all events synchronously in one
JS tick, not a bug: React only re-renders (and refreshes the closures
event handlers read from) between separate event dispatches, which a
real drag gesture always has (mouse movement takes real time) but a
same-tick synthetic dispatch does not. With realistic delays, dragging
"Worker" onto "Client" correctly reordered the header to `Worker type,
Client, Worker, Site, ...`, the row data reordered to match, and
`localStorage` held the new key order. Closing and reopening the modal
kept the custom order; "Reset columns" correctly restored the built-in
order and the button itself disappeared. `npm run lint`/`npm run build`
both clean. Throwaway admin deleted afterward.

**Seventh same-day addendum (2026-09-17): dragging no longer auto-saves —
an explicit "Set as default" action does, alongside "Reset columns"
under one "Columns" menu button** — the user's own ask, given directly
after the drag-and-drop feature above shipped. Previously every drop
immediately overwrote `localStorage`; now a drag only updates
`columnOrder` for the rest of that session, and two SEPARATE, explicit
menu actions (opened from one "Columns" button, same outside-click-closes
popover pattern as `SearchableSelect.jsx`) decide what happens to it:
"Set as default layout" writes the current session order to
`localStorage`; "Reset columns" clears both the session order and the
saved default back to the built-in order. Both are disabled whenever
`columnOrder` is `null` (nothing dragged this session and nothing saved
from before) — there's nothing for either action to do yet.

**Verified live**: opening the menu before any drag showed both items
correctly grayed out; dragging Worker onto Client reordered the table
but left `localStorage` at `null` (confirming the auto-save removal);
reopening the menu afterward showed both items now enabled; clicking
"Set as default layout" wrote the reordered key array to `localStorage`
and closed the menu; closing and reopening the modal loaded that saved
order; clicking "Reset columns" restored the built-in order, closed the
menu, and cleared `localStorage` back to `null`. `npm run lint`/
`npm run build` both clean. Throwaway admin deleted afterward.
