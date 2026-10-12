# Dashboard insights and the portal "Today" card (2026-10-11)

From the pre-production checklist: each login should open on what it needs to act on, not
only headline numbers. Built for the web and the phone app, English and Arabic.

## Where it comes from

- `GET /api/dashboard/insights` (`dashboard/dashboardInsights.service.js`): a second call
  beside `/api/dashboard`, so a slow figure never delays the headline numbers. Every block is
  `null` unless the viewer holds the Section Access Read of the module it summarises (resolved
  once, through `getMySectionAccess`). A Coordinator's HR / attendance blocks are narrowed to
  their own team. Nothing here writes.
- `GET /api/me/overview` (`me/meOverview.service.js`): the portal home for a Worker/Staff
  login, resolved against the caller's own employee record only.

## Blocks

| Block | Who sees it (Read needed) | What it is |
|---|---|---|
| `systemHealth` | `auditLog` (failed logins 24h, access changes 7d), `team` (logins never used), `reconciliation` (finding count) | Each figure gated by its own key |
| `stuckApprovals` | the module's own Read; never a Coordinator | Requests waiting more than 3 days, per module, with the role holding them. Age = last decided step, else filed (Mobilisation: last update) |
| `expiringByType` | `employeeCreate` | Identity documents by type: expired / 30 / 31-60 / 61-90 days |
| `contractsEnding` | `employeeCreate` | Contracts ending in 30 days (people who become eligible for annual vacation) |
| `leavePicture` | `leaveRequests` | On approved leave today; back within 7 days |
| `signedInToday` | `attendanceRecords` | Who has signed in today |
| `billing` | `mobilisationsViewer` or `deploymentsInvoicing` (parts: `expenses`) | Owed by clients aged 0-30 / 31-60 / 60+ days (days since the invoice was sent), due in 7 days, overdue, ready to invoice, owed to subcontractors, expenses this month vs last |
| `myWork` | the viewer's own work (needs the Requirements / Daily Updates / Deployments access it already has) | Stale requirement cards, missing timesheets, my mobilisations in review and which role holds each, open tasks soonest-due first |
| `decidedThisWeek` | none (own activity) | Requests the viewer decided in the last 7 days |

The leaderboard gained a "% of target" line under each coordinator's target.

The `/me/overview` card: signed in or not today, leave balance per Annual/Sick/Contract-cycle
type, next holiday, requests by pending/approved/rejected, identity documents due within 60
days, contract end date and whether annual vacation is open (with the reason when it is not).

## Notes

- The "Waiting on you" labels gained Arabic for Annual vacation, Ready to invoice and Missing
  timesheets.
- The refactor of `countDeploymentsMissingTimesheets` / `countStaleRequirements` into list +
  count shares one rule between the number and the names, so they cannot disagree.
- Not built as a single button: the portal card links to My Attendance for the GPS sign-in
  (that screen owns the location permission and geofence messages).

## Verified

Server: 13 tests in `dashboardInsights.service.test.js`. Browser and API against an isolated
in-memory database with ten test logins (one per role, two coordinators): figures matched hand
calculations (invoice SAR 6,400 = 160 h x 30 + 40 OT h x 40; owed SAR 4,600; subcontractor
SAR 3,240 less a half payment = 1,620). A real bug was found and fixed in this work: the
portal leave balance read a projection without the policy fields and showed "of days left".

## Findings from the pre-production pass

Full report: `Pre-Production-Test-Results.pdf` (256 checks: 250 passed, 3 failed as findings, 3 not run).

1. **EOSB cap**: service of 2+ years pays 2 x monthly wage (code comment "User requested logic"); Art. 84 would pay more (6 years at SAR 6,000: 12,000 vs 21,000). Leave encashment is a fixed 45 / 21 days, not the real balance. Decide with HR / legal. (`settlement.service.js`)
2. **Mobilisation without "required timesheet hours"** bills SAR 0: every hour becomes overtime with no rate. Make the field required or block approval.
3. **Recording a received payment** needs only `deploymentsHours` write, with no per-client limit (stays Pending until approved).
4. **Login limiter** counts successful sign-ins (30 per 15 minutes per address): a shared office address can lock itself out. Count failures only.
5. **No `Cache-Control: no-store`** on authenticated API responses.

## Decisions on the findings (11 October 2026, applied)

1. **EOSB and leave pay follow Saudi Labor Law.** `computeEosb` is Art. 84 (half a month per year for 5 years, a full month after, pro-rated by whole months) with the Art. 85 resignation tiers; leave pay is the real unused annual-leave balance at the daily wage (override fields remain). Settlements saved before this change keep their old figures: delete and recompute.
2. **Blank required timesheet hours warns, it still saves.** Inline warning on the mobilisation form, red value on the mobilisation and deployment details (web and phone, en/ar).
3. **Recording a received payment stays as is** (needs `deploymentsHours` write; Pending until Accounts approves). Accepted.
4. **Login throttle is per address and account and counts failures only** (8 per account per address, 60 per address, 40 per account across addresses, each per 15 minutes) in `rateLimiter.js` (`loginLimiters`).
5. **Fixed 12 October 2026:** every `/api` response carries `Cache-Control: no-store` (`middleware/noStore.js`, before the rate limiter; the public NFC media stays cacheable).
