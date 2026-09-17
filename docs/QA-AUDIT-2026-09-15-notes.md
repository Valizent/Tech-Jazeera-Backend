# 15 September 2026 QA/security retest — full remediation

A follow-up, independent QA/security retest (distinct from the 13
September pass — [`QA-AUDIT-2026-09-14-notes.md`](QA-AUDIT-2026-09-14-notes.md))
covering Security (S1), Auth/Permission Gaps (A1–A3), Functional Bugs
(F1–F9), and Dead Code/Drift (D1–D4), plus dependency advisories and
product-improvement suggestions the report itself distinguished from real
findings. Every finding was independently checked against actual source
before fixing anything — one (F1's) turned out to reveal a second, more
severe instance of the exact same bug the finding named (A1's
`deploymentsRelease` write defaults to `['Coordinator', 'Manager']`
out of the box, no extra grant needed, making the reported gap worse than
the repro implied); one (A2) turned out to be a symptom of a wider,
previously-unaudited gap (the entire Exit Documents module — Certificate
AND ExitReentry — had no Coordinator team-scoping anywhere, not just on
the one PDF download route the report tested), fixed in full rather than
just the narrow reported case. All 17 numbered findings plus all 4 dead-
code items are fixed. The highest-risk ones — the injection, both
concurrency races, the notification-failure fault, and the
Coordinator-scoping gaps — were verified with real script-based tests
against the dev database (not just read-through); see
[Verification](#verification).

## Disputes / things NOT fixed as described

None of the 17 numbered findings were disputed — all reproduced exactly as
described once checked against source, several worse than described (see
above). Two things from the report's own "what passed" / "improvements"
sections are worth flagging as deliberately not acted on:

- **F2's suggested fix** ("commit the decision and Deployment as one
  business transaction... queue notifications through an outbox/retry
  mechanism") is the textbook-correct long-term architecture, but a real
  persistent outbox + retry worker is a genuinely new subsystem, not a bug
  fix at this response's scale. Fixed instead by making every notification
  dispatch in the shared approval engine best-effort (logged on failure,
  never allowed to abort the caller) — this fully closes the specific
  failure mode demonstrated (a notification fault stranding a Deployment)
  without inventing new infrastructure. If notification delivery
  reliability itself ever becomes a product requirement, the outbox
  approach is still the right next step.
- **Improvement #2** (batch Section Access reads — the measured 45-query/
  140ms `getMySectionAccess` call) was read and is a legitimate
  optimization, but it's a performance suggestion with no reported
  incorrect behavior, out of scope for a QA remediation pass. Not
  actioned; flagged here so it isn't lost.

## Security (S1)

- **S1 — Mongo aggregation-expression injection in the payment/repayment
  ledgers.** `invoice.service.js`'s `recordPayment` and
  `advance.service.js`'s `addRepayment` both use a PIPELINE update
  (`findOneAndUpdate` with a `[...]` array, not a plain update document) to
  append one ledger entry atomically — every value inside a pipeline stage
  is evaluated as an aggregation expression, so a validated-as-a-string
  `reference`/`method`/`note` like `"$clientName"` or `"$$ROOT"` was
  silently resolved against the CURRENT document instead of stored as the
  literal text typed. Fixed by wrapping the appended entry in `$literal`
  (tells Mongo to store its argument verbatim, dollar signs included) and
  explicitly casting `recordedBy` to a real `mongoose.Types.ObjectId` — a
  pipeline update bypasses Mongoose's normal schema-driven casting
  entirely, so the bare `actor.userId` string was also being stored with
  the wrong BSON type for a `ref: 'User'` field. **Verified**: a real
  payment/repayment with `reference: '$clientName'`/`method: '$$ROOT'`/
  `note: '$reason'` now stores the literal strings — confirmed both via
  Mongoose's own read AND a raw BSON read straight off the driver,
  bypassing any read-side casting Mongoose might apply.

## Auth/Permission gaps (A1–A3)

- **A1 — Coordinator team-scoping incomplete across list/mutation
  endpoints.** The 13 September pass fixed this for every module's
  single-record READ (`getDeployment`/`getDocument`/`getAsset`/
  `getSettlement`), explicitly scoped to detail routes only — this report
  found the sibling list/mutation endpoints were never given the same
  treatment. Fixed by adding `assertEmployeeVisibleToActor` (or the
  equivalent list-scoping filter) to: `deployment.service.js`'s
  `listDeployments` (`?worker=` filter), `addMonthlyHours`,
  `updateMonthlyHours`, and `demobiliseDeployment`; `document.service.js`'s
  `createDocument`, `addVersion`, `deleteDocument`; `asset.service.js`'s
  `listAssets` (previously didn't even accept an `actor` parameter) and
  `returnAsset`; `settlement.service.js`'s `createSettlement` and
  `deleteSettlement` (which previously called `findByIdAndDelete` before
  any check ran at all — worse than the others, since it never even
  fetched the record first to compare against). Found along the way:
  `deploymentsRelease` write defaults to `['Coordinator', 'Manager']` out
  of the box (see `deployment.routes.js`), so `demobiliseDeployment`'s gap
  meant ANY Coordinator could demobilise — and, for an Exit-outcome reason,
  mark Exited — an employee on a completely different team, no extra grant
  required, a more severe default-exposed version of what the report's own
  table tested. **Verified**: a throwaway Coordinator actor now correctly
  403s on all 8 tested combinations across Deployment/Documents/Assets/
  EOSB, including confirming a foreign settlement was NOT actually deleted
  after the 403.
- **A2 — sensitive file endpoints bypass Coordinator ownership.** Two
  confirmed root causes, one narrower than initially thought:
  `leave.controller.js`'s `attachment` action never passed an `actor` to
  `leave.service.js`'s `getAttachmentFile` at all — fixed by adding the
  actor parameter and the same `assertEmployeeScope` check
  `decideLeaveRequest` already uses. `certificate.service.js`'s
  `resolveCertificateForPdf` only scoped via an optional
  `requesterEmployeeId` (the ESS self-ownership path) — the staff route
  passed neither that nor any Coordinator-team check, so ANY staff member
  with `exitDocuments` read could pull ANY employee's salary certificate
  PDF. Investigating this surfaced a WIDER, previously-unaudited gap the
  report didn't test: `certificate.service.js`'s `listCertificates`/
  `decideCertificate` and `exitReentry.service.js`'s `listExitReentry`/
  `decideExitReentry` had NO Coordinator team-scoping anywhere at all —
  the entire Exit Documents module was simply never included in the 13
  September pass's Coordinator-scoping sweep. Fixed all four the same way
  Leave/Settlement already do (a team-`$in` filter for an unscoped list, an
  explicit check for a `?employee=` filter, and `assertScope` wired into
  the shared `decideApprovalStep` engine — a first-class, already-designed-
  for option there, confirming this was an oversight, not a deliberate
  exception). **Verified**: a Coordinator actor now 403s on both the leave
  attachment and certificate PDF byte-stream endpoints, and no longer sees
  a request for an employee outside their team in `listCertificates`.
- **A3 — Timesheet Processor's employee picker fails silently on a
  permission mismatch.** `timesheetProcessor` write access doesn't imply
  `employeeCreate` (Employees) read access — a Manager holding only the
  former saw the whole tool render, but the employee dropdown came back
  silently empty with the query's 403 swallowed (`useQuery` had no error
  handling at all), indistinguishable from "this company has no
  employees." Fixed by surfacing `isError` from the query as an inline
  hint under the picker naming the real cause and pointing at Section
  Access — the minimal fix from the report's own two suggested options
  (a dedicated scoped lookup endpoint is the fuller alternative, not built
  here). Matches this app's own standing "never fail a form silently" rule.

## Functional bugs (F1–F9)

- **F1 — legacy (no-workflow) approval decisions raced.**
  `approvalEngine.service.js`'s `decideApprovalStep` legacy branch read the
  document, checked its status in plain JS, then `.save()`d — two
  concurrent decisions (even a contradictory Approved+Rejected pair) could
  both pass the check against the same stale read. The WORKFLOW path right
  below it already atomically guards this (`findOneAndUpdate({status,
  currentStep}, ...)`, fixed 13 September) — the legacy branch predates
  that fix and was never brought in line with it. Fixed with the identical
  atomic-update pattern; this is a SHARED function reused by Leave/
  SalaryAdvance/Reimbursement/Timesheet/Certificate/ExitReentry, so one fix
  covers the race for all six. **Verified**: two concurrent legacy
  decisions on a real Pending SalaryAdvance now resolve to exactly one
  winner and one clean 409, never both succeeding.
- **F2 — a notification failure could strand an Approved mobilisation with
  no Deployment.** Traced to the exact mechanism: `decideApprovalStep`'s
  terminal Approved branch persists the status, THEN `await`s
  `notifyFinal` inline with nothing catching a throw — Mobilisation's own
  `approveMobilisation` only creates the Deployment AFTER `decideApprovalStep`
  returns, so a `Notification.create` failure inside that awaited call
  aborted the whole chain before the Deployment-creation code was ever
  reached. The existing compensating rollback (13 September) only catches
  a failure FROM `createDeploymentFromMobilisation` itself — it can't catch
  one that happens before that call is even reached. Fixed with a
  `notifyBestEffort` wrapper (logs and swallows) around every notification
  dispatch point in `decideApprovalStep` AND `notifySubmission` (the
  sibling "notify on submit" path, same fragility, same fix) — see
  [Disputes](#disputes--things-not-fixed-as-described) for why a full
  outbox wasn't built instead. **Verified**: reproduced the report's exact
  fault-injection (`Notification.create` throwing once) against the real
  `decideMobilisation` code path — the mobilisation reaches Approved AND a
  real, correctly-populated Deployment now exists, with the fault logged
  rather than silently swallowed or left to break the transaction.
- **F3 — concurrent leave submissions bypassed overlap and entitlement
  checks.** Same TOCTOU class as F1, but harder: the overlap check and the
  entitlement evaluation both run as plain reads against LeaveRequest — a
  brand-new document being created has no existing row to run an atomic
  conditional update against, and wrapping the reads+insert in a
  transaction does NOT by itself prevent two transactions each inserting a
  DIFFERENT new document from both committing (no natural write conflict
  for MongoDB to detect) — confirmed exactly matching the report's own
  warning about this. Fixed with a real serialization point: a new
  `LeaveSubmissionLock` model (a unique index on `employee`, TTL 30s as a
  crash-safety net only) acquired via `create()` — only one concurrent
  insert for the same employee can succeed, the loser gets a clean 409 —
  around the whole check-then-create flow in `submitLeaveRequest`, released
  in `finally`. **Verified**: two concurrent overlapping submissions for
  the same employee now resolve to exactly one real LeaveRequest document
  and one 409; the lock is confirmed released afterward.
- **F4 — fractional-cent invoice payments desynced the ledger.**
  `recordPaymentSchema.amount` accepted `min(0.01)` with no decimal-places
  ceiling, so `0.015` passed through to the atomic `$round` updates, which
  independently round the stored line-item vs. the running `amountPaid`/
  `balanceDue` totals — two different numbers derived from the same
  unrounded input. Fixed with a `money2dp` refine
  (`Number(n.toFixed(2)) === n`, exact because both sides go through
  identical float rounding) rejecting anything finer than a cent — SAR has
  no sub-halala denomination to round a payment TO in the first place.
  Same fix applied to `addRepaymentSchema.amount` (the identical gap,
  confirmed present, on the sibling ledger) — NOT applied to
  `submitAdvanceSchema.amount` (the loan request amount), which never
  flows through the ledger-append pipeline this fixes and is a genuinely
  different, unrelated field. **Verified**: `0.015` now rejected, `1.10`
  still accepted, on both schemas.
- **F5 — floating-point comparison rejected a valid final repayment.**
  `addRepayment`'s atomic `$expr` guard compared an unrounded
  `$sum: '$repayments.amount'` against `$amount` — real IEEE-754 addition
  (1.10 + 0.10 = 1.2000000000000002 in BSON double math) can land a cent
  off zero, so an exact `$lte` rejected a legitimate repayment that pays
  the balance down to exactly zero. Fixed by rounding both sides of the
  comparison (and the `$eq` that decides whether to auto-Close) to 2dp
  inside the pipeline. **Verified**: approving 1.20, repaying 1.10 then
  0.10, now correctly closes the advance instead of 400ing on the last ten
  cents.
- **F6 — deployment dates/hours not constrained to the placement
  interval.** Two related gaps in `deployment.service.js`: (1)
  `demobiliseDeployment` never checked `releaseDate >= startDate` — a
  placement could "end" before it began; (2) `addMonthlyHours`/
  `updateMonthlyHours` only ever bounded the whole MONTH for an Ended
  deployment (`data.month <= endMonth`), never individual days within a
  partial start/end month, so a deployment demobilised mid-month could
  still bill every remaining day of that calendar month as Worked hours.
  Fixed (1) with a direct date-order check, and (2) with a new
  `assertWorkedDaysWithinPlacement` helper computing the real first/last
  enviable day-of-month for the target month and rejecting any `'Worked'`
  day outside it (Off/Sick/Absent are left unconstrained — they bill
  nothing and aren't a claim about a day the worker was actually placed
  there, matching the report's own "validate every WORKED day" framing).
  **Verified**: a pre-start release date now 400s; billing days 16–31 of a
  month a deployment was demobilised on day 15 of now 400s; the identical
  request restricted to the real placement days (1–15) still succeeds.
- **F7 — the JSON string `"false"` coerced to `true`.**
  `demobiliseDeploymentSchema.exitOutcome` used `z.coerce.boolean()`,
  which coerces via plain JS truthiness of the RAW input before any type
  check — any nonempty string is truthy, so the literal string `"false"`
  became `true`, silently exiting an employee who shouldn't have been.
  Fixed with a `strictOptionalBoolean` preprocessor: passes through a real
  boolean or `undefined` unchanged, converts only the exact strings
  `"true"`/`"false"`, and leaves anything else (e.g. `"yes"`) for the inner
  `z.boolean()` to correctly REJECT rather than silently coerce.
  **Verified**: `"false"` now parses to `false`, `"true"` to `true`, a real
  boolean `false` still works, and `"yes"` is now rejected outright.
- **F8 — immediate login after a password reset issued an unusable
  token.** The 14 September fix compared an access token's `iat` claim
  (jsonwebtoken always floors this to whole SECONDS — a JWT/JOSE spec
  requirement) against `passwordChangedAt` (millisecond precision) — a
  token issued a fraction of a second after a reset, in the SAME calendar
  second, read as "issued before" it and was wrongly rejected, including
  on the very login the reset had just enabled. Confirmed there is no safe
  rounding direction for this comparison (rounding the other way just
  reauthorizes a genuinely-old same-second token instead — the report's
  own warning, independently confirmed by working through both directions
  by hand). Fixed with a monotonic `User.tokenVersion` counter (default 0,
  so an already-logged-in session's pre-this-fix token — no claim at all —
  isn't force-invalidated when this ships): embedded in every newly-issued
  access token (`issueTokens`'s single call site, covering both login and
  refresh), incremented on every password change/reset (self-service,
  Admin-reset-for-Worker, Admin-reset-for-staff), compared exactly in
  `requireAuth`. **Verified**: an old token's `tokenVersion` no longer
  matches after a reset (correctly rejected); a token issued by logging in
  immediately after the reset carries the NEW version and is correctly
  accepted — including replaying `requireAuth`'s own comparison logic
  directly against both tokens.
- **F9 — the Approval Log's pending filter excluded newly-supported
  request types.** `approvalLogQuerySchema.status` hardcoded
  `'PendingReview'` — Leave's own literal pending status — as THE pending
  value for every source type; Timesheet's real pending status is
  `'Submitted'`, and Certificate/ExitReentry/SalaryAdvance/Reimbursement's
  is `'Pending'`. `status=PendingReview` silently returned zero results for
  those five; asking for a type's own real status (`status=Submitted`)
  400'd outright, since it wasn't in the enum. Fixed with a normalized
  `'Pending'` value the schema now accepts, translated per source type via
  a new `pendingStatus` field on each `LOG_SOURCES` entry in
  `approvals.service.js`; the client (`ApprovalLogPage.jsx`) updated to
  send the normalized value and to recognize any of the three real literal
  values as "pending" for its own badge/label. Also removed a stale
  comment block (D3) directly contradicted by the fix right below it.
  **Verified**: `status=Pending` now correctly matches a real Certificate
  (`'Pending'`), a real ExitReentry (`'Pending'`), AND a real Timesheet
  (`'Submitted'`) in the same query.

## Dead code / drift (D1–D4)

- **D1 — the dashboard claimed a Manager had approvals they couldn't
  perform.** `dashboard.service.js`'s `getMyPendingActions` only checked
  `annotateCanDecide` (role/workflow membership) — the REAL decide routes
  for Leave/Timesheet/SalaryAdvance/Reimbursement also require Section
  Access write on `leaveRequests`/`timesheetRequests`/`financialRequests`
  respectively (confirmed at the router/service level for all four,
  correcting an initial misread of the Timesheet route file's multi-line
  formatting that briefly looked ungated). Mobilisation is a deliberate
  exception — its `/decide` route has no Section Access gate at all, so
  `annotateCanDecide` alone is already its complete, accurate signal.
  Fixed with a `sectionKey` per module (`null` for Mobilisation) and the
  same combined check `listAdvances`/`listReimbursements` already use.
  **Verified**: a throwaway Manager with no `financialRequests` grant no
  longer sees a "Salary advances" entry for a real Pending advance.
- **D2 — unused imports/exports.** Removed after confirming zero real
  call sites for each: server — `notifyEmployeeUser` (unused in
  `advance.service.js`/`leave.service.js`/`timesheet.service.js`; still
  used correctly elsewhere via `decideApprovalStep`'s own default
  `notifyFinal`). Client — `formatDate` (`documentColumns.jsx`),
  `MONTH_NAMES` (`PayrollRunPage.jsx`), the API wrapper functions
  `getDocument`/`getExpense`/`getMySectionAccess`/`getSubcontractor`
  (zero importers each), and the constants `WORKFORCE_TYPES`/
  `STAFF_ASSIGNABLE_ROLES`/`TIMESHEET_STATUSES`/`PAYROLL_STATUSES`/
  `getSystemTheme` — the latter two arrays' own `_VARIANT` siblings are
  genuinely still used elsewhere and were kept.
- **D3 — comments describing removed/never-built capabilities.** Rewrote
  three: `advance.model.js` (said "no Payroll module yet" — Payroll has
  existed since P2-M5 — and "no multi-level approval matrix" — it runs
  through the same Configurable Approval Hierarchy engine as every sibling
  type); `approvals.service.js` (an older note claiming Timesheet/
  SalaryAdvance/Reimbursement were "never added" to the log, sitting
  directly above the 14 September fix that added them — removed as
  fully superseded); `ThemeContext.jsx` (claimed the theme "follows the OS
  setting, live" — never actually implemented; the inline script in
  index.html that sets the initial class doesn't check
  `prefers-color-scheme` either — rewritten to describe the real, simpler
  behavior, and the now-confirmed-dead `getSystemTheme` helper removed).
- **D4 — an untranslated `header.openUserMenu` i18n key.** Both locale
  files had a differently-named sibling key, `header.openMenu` — but that
  one is genuinely a DIFFERENT button (the mobile sidebar-drawer toggle,
  confirmed by reading both call sites), not a rename target. Added the
  missing `openUserMenu` key (the user-avatar dropdown trigger) to both
  `en.json` and `ar.json`.

## Dependency advisories

Reviewed, not actioned — no application code changes recommended by the
report for these, and the report itself frames them as npm's affected-
package counts, not independent confirmed application defects. Left for a
separate, deliberate dependency-upgrade pass per the report's own
"do not blindly force-fix" caution.

## Verification

`node --check` on every touched server file (a full sweep across
`server/src` afterward, zero errors) and a clean `npm run build` (client).
Real script-based tests against the dev database (throwaway fixtures,
deleted after each run, matching this project's established verification
convention) for every Security/Auth/Functional finding:

```
S1  — injected $-expressions stored as literal text (Mongoose read AND raw BSON read)      : 6/6 PASS
F4  — sub-cent amounts rejected (invoice + advance)                                        : 3/3 PASS
F5  — 1.10+0.10 float-drift final repayment correctly closes the advance                   : 2/2 PASS
F1  — two concurrent legacy decisions: exactly one winner, one clean 409                    : 2/2 PASS
F3  — two concurrent overlapping leave submissions: exactly one real document, one 409      : 4/4 PASS
F7  — strict boolean: "false"→false, "true"→true, real false stays false, "yes" rejected    : 4/4 PASS
F8  — tokenVersion: old token rejected, immediately-reissued token accepted                 : 8/8 PASS
F2  — real Notification.create fault injection: Approved + real Deployment still created    : 4/4 PASS
A1  — Coordinator 403s across Deployment/Documents/Assets/EOSB (8 endpoints)                : 8/8 PASS
A2  — Coordinator 403s on leave attachment + certificate PDF; listCertificates no longer leaks: 3/3 PASS
D1  — dashboard no longer claims a Manager without financialRequests write has one pending  : 1/1 PASS
F6  — pre-start release date, and post-demobilisation Worked days, both 400; valid days OK  : 3/3 PASS
F9  — status=Pending matches Certificate/ExitReentry/Timesheet's own real status literals   : 3/3 PASS
```

47/47 assertions passed. All throwaway users/employees/clients/
mobilisations/deployments/documents/assets/settlements/leave requests/
certificates/scripts created during verification were deleted afterward.

## Follow-up (2026-09-15, same day): the report's 8 UI/UX suggestions

The report's own findings (S1/A1–A3/F1–F9/D1–D4, above) are distinct from a
separate list of 8 "product-improvement suggestions" it flagged as
UX/architecture observations, not bugs. The user asked for all 8 to be acted
on. Each is addressed below; disputes and the one item still outstanding are
called out explicitly.

- **Cost/profit visibility for Coordinator/Manager/HR.** The report's own
  measurement showed only Admin could see any cost/profit figure anywhere —
  checked directly against the live database and found PARTLY wrong: an
  earlier diagnostic script in this same response queried
  `SectionAccess.find({ key: ... })` (wrong field name — the real one is
  `sectionKey`), so it reported "Admin-only default" for sections that
  actually already had real grants (`deploymentsHoursDecide` already gave
  Marketing Manager write access). No harm resulted — the real fix below
  used the correct `getSectionAccess()`/`updateSectionAccess()` path and
  additively preserved every existing grant — but the earlier claim itself
  was wrong and is corrected here. The user's own answer to "what shape
  should this take" was **both**: per-placement AND company-wide profit
  visibility. Delivered:
  - A new `dashboardProfit` Section Access key, decoupling the Dashboard's
    aggregate profit FIGURE from needing raw read access to Invoices/
    Payroll/Expenses individually (the same "derived figure gets its own
    narrower authorization" pattern already used for Mobilisation/
    Deployment's own `profit` fields). `dashboard.service.js`'s
    `canSeeProfit` now checks this key directly instead of requiring
    Invoices+Expenses read.
  - `deployment.service.js`'s 3 profit-visibility checks widened from an
    implicit write-only gate to `canAccessSection('deploymentsHoursDecide',
    actor, 'read')` — a Coordinator/HR/Manager with READ (not necessarily
    decide/write) can now see per-placement profit without also being able
    to approve hours entries.
  - `server/src/scripts/grant-profit-visibility.js` (new, permanent, added
    as `npm run grant:profit-visibility`) — additively grants the 7 real
    org-chart `ApprovalRole`s (Coordinator, HR, GM, COO, MM, FM, BDM) read
    access to `mobilisationsViewer`, `deploymentsHoursDecide`, and
    `dashboardProfit`. Already run against the live database: confirmed
    `mobilisationsViewer: 7 roles`, `deploymentsHoursDecide: 8 roles` (7 new
    + MM's pre-existing write grant, preserved), `dashboardProfit: 7 roles`.
  - New `SECTION_LABELS`/`SECTION_DESCRIPTIONS` entries and a client
    `sectionAccessModules.js` module entry so `dashboardProfit` is a real,
    visible, admin-editable card on the Section Access page — not a hidden
    key only reachable via the grant script.

- **Section Access performance** (`getMySectionAccess`, the hottest path in
  the app — called on every login and token refresh). The report measured
  ~45 queries / ~140ms from a naive per-section-key loop. Rewritten to
  exactly 2 queries regardless of how many section keys exist: one
  `SectionAccess.find({})` for every document at once, then one
  `ApprovalRole.find` for every role referenced anywhere across all of them
  that this actor is an active member of — everything else is an in-memory
  `Set` lookup. Verified by instrumenting `SectionAccess.find`/
  `ApprovalRole.find` directly (not `mongoose.set('debug', ...)`, which hung
  a background verification script) and confirming exactly 2 calls.

- **Code splitting COMPLETE** (planned separately, then implemented the
  same day — see the plan file this response worked from). The client
  shipped as one 1.27MB (339KB gzipped) bundle; Vite's own build output
  flagged this every build. The user explicitly asked for "a proper plan"
  and "make sure the whole webapp doesn't break" before implementing.
  **Design decision**: `React.lazy()` + one `<Suspense>` per layout's
  `<Outlet>`, not React Router v7's native per-route `lazy` field — RRv7's
  `lazy` replaces a route's `element` entirely and is resolved by the
  router itself, which would have meant moving the `guarded`/`guardedWrite`
  Section Access wrappers (~40 call sites in `router.jsx`, composed around
  an already-instantiated element) *inside* each of the 66 page modules
  instead. `React.lazy()` is a drop-in element swap, so `guarded`/
  `guardedWrite` needed **zero changes** — confirmed by reading `router.jsx`
  in full before choosing. All 66 routed pages converted; one deliberate
  exception, `NoPortalAccessPage`, kept eager — `WorkerRouter` renders it
  directly in place of `<EssLayout>` (not through `EssLayout`'s own
  `<Outlet>`), so there's no `<Suspense>` boundary above it to catch a lazy
  load. Each layout (`DashboardLayout`/`EssLayout`/`AuthLayout`) wraps its
  `<Outlet>` — not the whole layout — in a new
  `<ErrorBoundary><Suspense fallback={<RouteFallback />}>` pair, reusing
  the already-existing `ErrorBoundary` class component (previously only
  wrapped `<RouterProvider>` once, app-wide) so a failed chunk load or a
  route's render error only blanks the content area; sidebar/header/
  notification bell stay mounted and interactive throughout. New:
  `client/src/components/shared/RouteFallback.jsx` (a centered `Spinner`,
  reusing `RequireAuth`'s own existing loading pattern). `vite.config.js`
  needed no changes — confirmed empty of any conflicting `build`/
  `manualChunks` config beforehand; Rollup's default splitting on dynamic
  `import()` was sufficient. **Result**: main entry chunk 1,272,986 bytes →
  670,680 bytes (47% smaller), 1 JS file → 117. The remaining 670KB is
  genuinely shared code (React/Router/TanStack Query/i18next/react-hook-
  form/zod/every `components/ui`+`shared` primitive) needed on literally
  every route including Login — further reduction would need vendor-chunk
  pinning (`manualChunks`), deliberately left out of this pass to keep the
  change small and auditable, flagged as a future optional follow-up.
  **Verified**: `npm run build`/`npm run lint` (0 errors, same 16
  pre-existing advisory warnings as before); a full browser click-through
  as a throwaway Admin/Manager/Worker — Login, Dashboard, a Hub page, a
  list page and a `:id` detail page all with real data, a hard refresh on
  a deep URL, browser back/forward between two lazy routes, a guarded
  route's 403 fallback (`RequireSectionRead`'s `EmptyState`) rendering
  correctly under the new Suspense/ErrorBoundary pair (proves the guard
  composition wasn't broken), and the ESS portal under its own separate
  `EssLayout`. The one edge case that actually mattered — whether the new
  per-layout `ErrorBoundary` genuinely catches a failed route render rather
  than losing the whole app shell — was verified directly: a real error
  deliberately thrown from a page component's render (`HolidayListPage`,
  reverted immediately after) was caught with the sidebar/header fully
  intact and only the content area showing "Something went wrong on this
  screen." + Reload, then confirmed the page renders normally again after
  reverting. (A first attempt at this test tried breaking a lazy import's
  *path* instead, expecting a runtime chunk-fetch failure — that instead
  surfaced as Vite's own dev-time import-resolution overlay, a completely
  different, dev-only mechanism that would never occur in a real
  production build, since a broken import path fails `npm run build`
  outright rather than ever shipping. Corrected to a genuine render-time
  throw, which is what a real corrupted/incompatible chunk would actually
  look like to React.) Also found and fixed, unrelated to the migration
  itself but discovered while verifying it: both the client Vite dev
  server and the API dev server had accumulated stale/orphaned processes
  from earlier in this same long session (matching this file's own
  documented Windows dev-environment failure mode) — killed and restarted
  both cleanly partway through verification.

- **Login roles → Approval Roles consistency sweep.** The user asked
  whether replacing every login-role check with Approval Roles app-wide
  would help. Argued against a full replacement (regressive: it would
  either force every Admin/HR/Accounts/Coordinator/Office-Secretary login to
  also hold a matching ApprovalRole just to keep working today, or silently
  lock people out) and proposed a narrower, safe fix instead — the user
  agreed. The actual gap: `annotateCanDecide` (used by every list endpoint
  to compute a `canDecideCurrentStep` UI hint) only ever checked ApprovalRole/
  legacy-role membership, never real Section Access — so a login with the
  right role/role-membership but no Section Access grant could see a working
  Approve/Reject button that would 403 on click. `advance.service.js`'s
  `listAdvances` already had the correct fix (14 September pass); the same
  pattern was missing from 4 siblings, now fixed identically:
  `leave.service.js`'s `listLeaveRequests`, `timesheet.service.js`'s
  `listTimesheets`-equivalent, `certificate.service.js`'s
  `listCertificates`, `exitReentry.service.js`'s `listExitReentry` — each
  now intersects `annotateCanDecide`'s hint with a real
  `canAccessSection(key, actor, 'write')` check. `certificate.service.js`
  was additionally missing the `canAccessSection` import outright (a latent
  `ReferenceError`, never previously hit). Verified with a throwaway
  Manager (no ApprovalRole membership): all 4 correctly show
  `canDecideCurrentStep: false`; an Admin sanity check still shows `true`.
  New regression test: `leave.sectionAccessConsistency.test.js`.

- **Data Reconciliation module (new).** A real, admin-configurable
  (`reconciliation` Section Access key, Admin-only by default) integrity-
  check tool: `GET /api/reconciliation` runs 5 detectors in parallel —
  orphaned Mobilisations (Approved/Completed with no Deployment),
  double-booked workers (>1 Active Deployment for the same Employee/Iqama —
  the standing check that the `uniq_active_worker` index fix and the
  iqama-based guard, both from an earlier session, are still holding),
  Invoice/SalaryAdvance ledger mismatches (re-sums the real `payments[]`/
  `repayments[]` array and compares against the cached running totals), and
  Finalized PayrollRun mismatches (`totalGross`/`totalDeductions`/
  `totalNet` vs. the real sum of `lines[]`). New client page at
  `/reconciliation` (severity-badged, clickable findings linking to the
  real record; a positive "Everything reconciles" empty state). **Real
  finding on live data, left as-is per the app's read-only design**: 2
  orphaned Mobilisations — `MOB-0013` (Approved, no Deployment yet — a
  legitimate in-progress case) and `MOB-0042` (Completed, no Deployment — a
  leftover from the temporary Admin-only Deployment-delete testing
  affordance; see `docs/DEPLOYMENT-notes.md`'s "Temporary" note, still
  flagged for removal before production).

- **Silent-failure picker sweep, 18 files.** A background research agent
  (read-only, report-only) was asked to find every form-picker
  (Employee/Client/Subcontractor/JobTitle/Coordinator/etc. dropdown
  populated from its own `useQuery`) that renders as a silently-empty
  dropdown on a permission or network failure, indistinguishable from
  "there's genuinely nothing to pick from" — the exact class of bug the 15
  September report's own A3 finding demonstrated for the Timesheet
  Processor. It found 18 real instances beyond A3's own fix, ranked by
  real-world likelihood. New shared `components/shared/PickerLoadWarning.jsx`
  (`Couldn't load X — you may be missing read access to it. Ask an admin to
  check Section Access.`), rolled out to all 18: MobilisationNewPage/
  MobilisationEditPage/MobilisationDetailPage, EmployeeForm,
  SettlementNewPage, QuotationForm, DocumentUploadModal, AssetListPage,
  ExpenseListPage, DeploymentListPage, 4 NFC components/pages (one of which
  — `AssignCardModal` — also had a misleading "No blank cards available"
  message conflating a real error with a genuine empty state), MyLeavePage,
  LeavePage, CoordinatorActivityPage, and ApprovalsPage/SectionAccessPage
  (both needed the warning threaded through a nested component/prop chain
  rather than a flat call site). Verified end-to-end against a real,
  deliberate permission gap: a throwaway Coordinator granted only
  `mobilisationsSelfMobilise` write (no Employees/Clients/Subcontractors
  read) — confirmed the underlying `/api/employees`, `/api/clients`,
  `/api/subcontractors` calls each correctly 403 once, no retry storm, and
  the page correctly renders the warning instead of hanging. That
  verification itself hit a real environment-specific false alarm worth
  recording: the page appeared permanently stuck on its loading skeleton in
  the automated browser tool — root-caused to the tool's tab being
  backgrounded (`document.visibilityState: 'hidden'`), which TanStack
  Query's retryer deliberately pauses retries for (its own documented
  behavior — see `node_modules/@tanstack/query-core/src/retryer.ts`'s
  `canContinue()`). Confirmed by forcing `focusManager.setFocused(true)`:
  the query immediately settled to `error` and the warning rendered
  correctly. Not a product bug — a backgrounded-tab artifact of the
  headless test tool, verified and ruled out before moving on.

- **Automated tests, ESLint, CI gate.** `vitest` + `mongodb-memory-server`
  (a real `mongod` binary, not a mock — honoring this project's own
  standing "don't mock the database" rule) added as the server's test
  infrastructure (`server/vitest.config.js`, `server/test/setup.js`). 32
  real regression tests across 8 files targeting the two audits' own
  highest-risk, most regression-prone findings: S1 (injection — literal
  storage + ObjectId casting), F1 (both the invoice/advance money races and
  the shared approval engine's legacy-path decide race), F2 (a real
  `Notification.create` fault injected via `vi.spyOn`, confirming the
  decision still commits), F3 (the leave submission lock — including
  proving it releases cleanly), F4/F5 (sub-cent rejection + float-drift
  final-repayment closure), F7 (the strict-boolean coercion schema), F8
  (tokenVersion — old token rejected, immediately-reissued token accepted,
  a legacy no-claim token still works), A1 (`assertEmployeeVisibleToActor`
  directly), and this same follow-up's own Section-Access-consistency fix
  above. `npm test` (added script) runs the suite; `npm run lint` runs
  ESLint. New flat-config `eslint.config.js` for both `client/` and
  `server/` (neither had one) — running it surfaced and fixed real,
  pre-existing issues, not just configured a previously-passing baseline:
  4 genuine `target="_blank"` reverse-tabnabbing gaps (NFC card/company
  pages — auto-fixed with `rel="noopener noreferrer"`), 3 real dead-code
  items (`auth.service.js`'s unused `payload` after `jwt.verify`,
  `nfc.publicPage.js`'s entirely-unused `initials()` monogram helper,
  `reconciliation.service.js`'s own unused `identity` loop variable — this
  session's own code), an unused `Card` import, a bare unused `err` catch
  binding, and 6 stale `// eslint-disable-next-line` comments (5 error-
  middleware `err` params ESLint's own default `args: 'after-used'`
  behavior never actually flagged, one `no-await-in-loop` for a rule never
  enabled) — real drift, the same D3 class the 15 September report itself
  flagged elsewhere. Both are now genuinely zero-error (client: 16 residual
  warnings, all advisory `react-hooks/exhaustive-deps`/
  `react-refresh/only-export-components`, not correctness bugs; server:
  zero warnings). `.github/workflows/ci.yml` extended: client gains a lint
  step before its existing build step; server gains lint + `npm test`
  (with an explicit set of CI-only placeholder env vars — the suite never
  touches the real `MONGODB_URI`, `test/setup.js` connects its own
  mongodb-memory-server instance instead) — verified locally by physically
  renaming `server/.env` aside and re-running both with exactly the
  workflow's declared env vars, confirming zero hidden dependency on the
  real dev secrets. **User action required, not something a file edit can
  do**: making this CI job a required GitHub branch-protection status check
  (so a failing build/lint/test actually blocks merge into `main`) needs
  the repo's Settings → Branches page — CI running is not the same as CI
  gating.

### A flaky test found and fixed during this same pass

The F3 concurrency test (two concurrent leave submissions) failed once in
sporadic reruns — not the fix itself: `LeaveSubmissionLock`'s unique index
on `employee` is asynchronous to build against a freshly created
mongodb-memory-server, and the test's two concurrent inserts could race the
index build itself on a cold run, letting both `create()` calls briefly
succeed before the constraint was actually enforced. Fixed with an explicit
`beforeAll(() => LeaveSubmissionLock.init())` — Mongoose's own documented
way to await a model's indexes being ready — confirmed stable across 5
consecutive full-suite runs afterward. A test-infrastructure artifact, not
a regression in the real F3 fix.

## Follow-up (2026-09-17): external handoff-readiness audit — 4 remaining Coordinator access-control gaps, COMPLETE

A separate external AI agent ran a general "handoff readiness" audit of both
repos (git topology, duplicate code, secrets, docs, error tracking, access
control) and reproduced 4 real access-control gaps of the exact same class
this file's own A1/A2/A3 fixes already covered elsewhere — all 4 were spot-
checked against actual source (line-by-line) before touching anything, and
all 4 confirmed real:

- **`findDeployments`** (deployment.service.js, the shared query builder
  behind both `listDeployments` and `exportDeployments`) only ever checked
  team ownership when the caller explicitly passed `?worker=`. The normal,
  unfiltered "just open the Deployments list" path built no ownership
  condition at all, so a Coordinator saw every team's deployments — the
  list/export equivalent of the exact gap A1 already fixed for the
  single-record read. Fixed with the same `$or: [{worker:null},
  {worker:{$in:teamIds}}]` shape `listAssets` already uses, preserving the
  existing convention that a SupplierEmployee/Freelancer deployment (no
  linked Employee) stays unscoped.
- **`decideMonthlyHours`** (deployment.service.js) was simply missed when
  the A1 fix added the same `assertEmployeeVisibleToActor` check to its two
  siblings, `addMonthlyHours`/`updateMonthlyHours` — a Coordinator granted
  `deploymentsHoursDecide` could approve/reject a foreign team's entry.
  Fixed with the identical one-line check, same spot.
- **`updateAsset`** (asset.service.js) had no ownership check at all, while
  `getAsset` right below it already did — a Coordinator granted asset write
  could edit an asset currently assigned to a foreign team's employee.
  Fixed by reading the asset first and applying the same conditional
  `getAsset` uses (an unassigned asset stays editable by anyone with the
  grant, same convention).
- **`getAsset`'s assignment history** (asset.service.js) only checked
  ownership while the asset was *currently* assigned — once returned, the
  full history (every past holder, any team) was returned unfiltered rather
  than scoped. Fixed by filtering the `history` array itself for a
  Coordinator (same team lookup `listAssets` already does), rather than
  blocking the whole now-unassigned asset.

All four only ever affect the `Coordinator` role — `assertEmployeeVisibleToActor`
is a no-op for every other role — and only when that Coordinator has actually
been granted the relevant Section Access key (these are additive
defense-in-depth checks, not the primary gate).

### Verification

Real script-based test against the dev database (not just read-through):
two throwaway Coordinators, each with their own throwaway team member,
client, mobilisation, deployment (one with a Pending monthly-hours entry
each) and assets (one assigned to each Coordinator's team member, one
unassigned, one with mixed-team assignment history). 15/15 assertions
passed:

- Coordinator A's deployment list/export contains her own team's deployment
  and excludes the foreign team's; same in reverse for Coordinator B; Admin
  still sees both (no over-restriction regression).
- Coordinator A gets a real 403 deciding the foreign team's monthly-hours
  entry; still succeeds deciding her own team's.
- Coordinator A gets a real 403 editing an asset assigned to the foreign
  team; still succeeds editing her own team's asset and any unassigned
  asset.
- Coordinator A's view of a mixed-history asset includes her own team's
  past assignment and excludes the foreign team's; same in reverse for
  Coordinator B; Admin still sees both (no over-restriction regression).

All throwaway data (2 Users, 2 Employees, 2 Clients, 2 Mobilisations, 2
Deployments, 4 Assets, 2 AssetAssignments) and the temporary verification/
cleanup scripts were deleted afterward; confirmed zero remaining records
matching the test's naming pattern.

## Follow-up (2026-09-17): duplicate-code cleanup, 12 of ~16 findings COMPLETE

The same external handoff audit's duplication table (~16 pairs/groups) plus
its `escapeRegex`-in-9-files and 5-file employee-picker findings, worked
through item by item rather than as one giant refactor — each extraction
kept small and independently verified. Not everything the audit listed was
worth doing; see Scope below for what was deliberately skipped and why.

### What was extracted

- **`escapeRegex`** (9 server files, byte-identical) → `server/src/utils/escapeRegex.js`.
- **PDF money/date formatting** (`money`/`shortDate`, Invoice/Quotation/
  Settlement/Payroll PDFs) → `server/src/utils/pdfFormat.js`.
- **`money2dp`** (the sub-cent-rejecting Zod refinement, advance/invoice
  validation) → `server/src/utils/money2dp.js`.
- **Image-upload error wrapper + file-filter** (avatar/logo/NFC media
  uploads — the NFC one used a differently-shaped but functionally
  identical `EXT` lookup, unified into the same Set-based filter) →
  `server/src/utils/imageUpload.js`.
- **`computeTotals`/`lineAmount`** (the authoritative invoice/quotation
  money math) → `server/src/utils/moneyMath.js`, reused by both services
  and both PDF generators; `lineAmount` also extracted client-side (its own
  file, `client/src/lib/utils.js` — client/server can't share a file across
  repos) for the 2 view pages. This one had an explicit prior "kept local
  on purpose" comment in invoice.service.js, reasoning that sharing the
  function would recompute an invoice's totals from a quotation that might
  later change — on inspection that reasoning doesn't actually hold: a
  shared PURE function takes each caller's own already-frozen line items as
  input and creates no live coupling between an Invoice and its source
  Quotation; only the formula is shared, not any data. Verified numerically
  (a real line-item set, hand-checked totals, and confirmed the sum of
  per-line `lineAmount()` calls exactly matches `computeTotals()`'s own
  grand total) before trusting the merge.
- **`fileSize`/`profitClass`** (document-preview modals; Deployment
  Overview/Mobilisation detail profit coloring) → `client/src/lib/utils.js`.
- **The `Field` profile-row component** (Client/Employee/NFC-company
  profile pages, byte-identical) → `client/src/components/ui/ProfileField.jsx`,
  matching this app's existing shared-UI-primitive convention.
- **The 5-file employee-picker query** → `client/src/lib/useEmployeePicker.js`,
  one consistent query key so the identical request (first 100 employees,
  sorted by name) shares one cache entry across Attendance/Assets/EOSB/
  Timesheet-Processor instead of 4 independent fetches. `DocumentUploadModal.jsx`
  was deliberately left out — its query branches between employees/clients
  under one combined key depending on `ownerType`, and forcing that into
  the shared hook would need real restructuring for one line of overlap;
  not worth it.
- **List-header sort toggle** (Client/Employee list pages) →
  `createSortToggle(setParams)` in `client/src/lib/utils.js`.
- **Avatar-menu outside-click detection** (DashboardLayout/EssLayout,
  byte-identical) → `client/src/lib/useCloseOnOutsideClick.js`, a genuinely
  generic pattern, not app-specific.

### Scope — deliberately NOT touched

- **`monthStrOf`** (deployment.service.js / DeploymentDetailPage.jsx): the
  audit counted this as duplicated, but it only appears ONCE per side —
  there's no actual intra-repo duplication to remove by extracting it, just
  the same small helper independently written for two different runtimes
  (client and server are separate repos, can't share a file). Extracting it
  would add indirection with zero DRY benefit.
- **PDF table-drawing closures** (`drawRow`/`totalRow` in invoice.pdf.js/
  quotation.pdf.js): these close over mutable per-document state (`y`,
  `cols`) and have document-specific parameters baked in (different
  page-break thresholds, a different total-row set) — genuinely more
  layout boilerplate than shared logic, and forcing them into one factory
  would trade a small amount of duplication for real complexity in
  PDF-rendering code, where a subtle bug is hard to catch without
  eyeballing rendered output. Left as-is.
- The 4 hub pages' identical wrapper shape, password-copy handling, plain
  navigation-icon duplication, and Tile-icon rendering — all flagged by the
  audit itself as low-value/intentional, or too cosmetic to be worth the
  diff churn.

### Verification

- Server: `npm run lint` clean, `npm test` 38/38 passing (both re-run after
  every extraction group, not just once at the end).
- A direct numeric check of the extracted money math: real line items,
  hand-computed totals, confirmed `computeTotals()`'s grand total exactly
  equals the sum of per-line `lineAmount()` calls.
- Client: `npm run lint` clean (0 errors, same 16 pre-existing unrelated
  warnings throughout), `npm run build` clean.
- Live browser click-through as a real Admin: the avatar-menu outside-click
  still closes the menu on both the staff layout (confirmed) and shares the
  same hook as the ESS layout; the Clients and Employees list column-sort
  toggle confirmed both directions (network requests showed the correct
  `sortBy`/`sortOrder` params, UI reordered correctly); a real Mobilisation
  detail page's Profit per hour/month/OT figures rendered in the correct
  green (`profitClass`). Throwaway Admin account created for this
  click-through was deleted afterward.
