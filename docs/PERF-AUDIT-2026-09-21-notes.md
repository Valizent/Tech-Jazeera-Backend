# Performance and cleanup audit — 21 September 2026

An external audit (`.qa-audit/performance-2026-09-21/REPORT.md` + its own
`reproduce.mjs`, audited against server commit `b5e9b1a` / client commit
`a77d62f`) covering 10 prioritized performance findings (P1–P10), a
dead-code/duplication/dependency/docs section, and one existing-test-
instability finding (F1). Instruction: *"check and see if you refute
anything. Else fix everything mentioned."*

**Nothing was refuted.** Every falsifiable claim was independently
spot-checked against real source, and — wherever possible — re-verified by
rerunning the audit's own unmodified `reproduce.mjs` script (its stubs are
filter-agnostic, so its before/after numbers are directly comparable and
independently reproducible). All 8 findings the audit itself prioritized as
High or having a clear, well-scoped fix (P1–P5, P7, P9, P10) plus F1 (the
flaky test) are **COMPLETE**, each with real execution-based verification —
not just a read-through. P6 (bundle size) is also **COMPLETE**, going beyond
its own suggested minimum. See "What's left" at the bottom for the
remaining items and why they weren't built in this pass.

## P1 — per-IP-only rate limiting let one heavy user starve others

**Fix:** added `userLimiter` (`middleware/rateLimiter.js`), keyed on
`req.user.id`, applied after `req.user` is set in `requireAuth`
(`middleware/auth.js`). The existing IP-floor `apiLimiter` is unchanged —
two independent limiters, not a replacement.

**Verification:** a real regression this caused was caught and fixed —
`auth.test.js`'s fake `res` object (`{}`) didn't have `setHeader`, which
`userLimiter` (via `express-rate-limit`) calls; added a proper `fakeRes()`
helper, 4/4 pass. A dedicated script hit the real endpoint past the new
600/900s-window user limit and confirmed a clean 429 with the draft-7
combined `RateLimit` header. Full suite 38/38.

## P2 — a bare-`/api`-mounted router silently intercepted requests

`leave.routes.js` mounted at `/api` with its own blanket `requireAuth`,
meaning any `/api/*` request that fell through to it before a later-mounted
module could be silently intercepted — the exact landmine the White-labeled-
shell work (`docs/CLAUDE.md`'s own Status history) had already hit once.

**Fix:** split into `leaveType.routes.js` (mounted at `/api/leave-types`)
and `leaveRequest.routes.js` (mounted at `/api/leave`), each at its own real
prefix — no more `/api`-wide mount.

**Verification:** full suite 38/38; curled every leave-type and
leave-request endpoint directly to confirm both new prefixes work
identically to the old combined one.

## P3 — the dashboard ran ~30+ unbatched queries per load

`getProfitOverview`'s `computeMonthProfit` ran 3 queries PER trend month (18
for a 6-month trend); `canAccessSection` was called once per section key (13
separate `SectionAccess` reads); `getMyPendingActions` re-queried
`ApprovalRole` once per module.

**Fix:** `getProfitOverview` now runs 3 batched aggregate queries total
(Invoice/Expense grouped by month, one `PayrollRun.find($or)`), building the
trend from `Map`s. The 13-key `canAccessSection` Promise.all became one
`getMySectionAccess` call + in-memory checks. `getMyPendingActions` now
takes the already-fetched `mySectionAccess`, fetches all 5 modules via
`Promise.all`, then makes exactly ONE `ApprovalRole.find` for every module
combined (`roleIdsNeededAcross`, extracted from `approvalEngine.service.js`).

**Verification:** `mongoose.set('debug', ...)`-based operation counting
against real dev data. Admin's own request short-circuits both
`canAccessSection` and `getMySectionAccess` (zero queries either way — a
real, expected non-improvement for that ONE role), so a stubbed `Manager`
actor (who doesn't short-circuit) was used to confirm the real batching:
`sectionAccessOps: 3` (down from the audit's own measured 9), and
`approvalroles.find` dropped from N-per-module to 1 for the batched call
(a separate, smaller, NOT-yet-fixed redundancy in `countStaleRequirements`/
`countOpenTasks`'s own `resolveOwnTeamAccess` calls was found and explicitly
left as a known residual, out of this pass's scope).

## P4 — Payroll ran 2–3 queries PER employee in its create loop

`sickLeaveDeductionForMonth` and `approvedHoursForMonth` each self-queried
per employee inside `createPayrollRun`'s loop.

**Fix:** both split into a pure computation function (unchanged math) plus a
new batched fetch (`sickLeaveRequestsForMonth`, `approvedTimesheetsForMonth`
— both `Model.find({employee: {$in: employeeIds}, ...})`, returning a `Map`
keyed by employee id), called once via `Promise.all` BEFORE the loop.
`deploymentsForEmployeeMonth` (from an earlier session's client-timesheet-
deduction work) got the same treatment
(`deductionsForEmployeesMonth`).

**Verification:** ran a real `createPayrollRun` against the dev database
(2 disposable Employee fixtures, since the DB had zero real payroll-eligible
employees at the time; a disposable `2099-12` period so the real 409 guard
couldn't collide with anything). Confirmed: one line per real eligible
employee, every line's `grossPay`/`totalDeductions`/`netPay` internally
consistent with its own components (proving the batched `Map` lookups
actually reached the math, not silently defaulting to zero), db operations
scaling with the BATCH not the employee count. Cleaned up both the
disposable run and the fixture employees afterward.

## P5 — push notification delivery blocked the save response

`notifyUser` used to `await pushToUser(...)` before returning — a slow or
unreachable push endpoint added real latency to every notified action's own
response (reproduced: 259ms for one recipient, 1055ms for four).

**Fix:** a small in-process bounded-concurrency queue (`PUSH_CONCURRENCY =
5`, `enqueuePush`/`runPushWorker` in `notification.service.js`) — a real
persistent queue drained by a small worker pool, deliberately NOT a bare
fire-and-forget promise per call (the audit's own explicit warning against
"detached, unreliable promises as the only delivery mechanism"). Also added
`PUSH_SEND_TIMEOUT_MS` (10s) wrapping each individual send, so one bad
endpoint can't tie up a worker slot indefinitely. Also added `GET
/notifications/unread-count` (one `countDocuments` call) so the bell's own
10s poll no longer runs the full 3-query `listNotifications` just to read
one field.

**Verification:** the audit's own unmodified `reproduce.mjs` push-delay
probe confirmed the real-world improvement (1 recipient 259ms→1ms, 4
recipients 1055ms→0ms). A dedicated script further confirmed: `notifyUser`
returns in ~1ms despite a stubbed 150ms send (proves non-blocking), the
queued send does complete shortly after (proves not silently dropped), all
12 sends in a size-12 burst eventually complete (proves nothing is lost),
and never more than 5 concurrent sends were observed in flight (proves the
bound is real) — 4/4 assertions passed (a 5th, asserting the exact
microtask-timing of when the send starts relative to `notifyUser`
returning, was removed as a flawed test design — see the script's own
comment for why that specific ordering isn't a real behavioral guarantee
either way, and isn't what actually matters here).

## P7 — spreadsheet parsing blocked the event loop, unbounded by row count

`timesheet.parser.js` calls synchronous `XLSX.read`/`sheet_to_json` on the
request thread; the 5MB compressed byte limit doesn't bound row count (a
repetitive sheet compresses hard — the audit's own reproduction fit a
50,000-row workbook under 1.75MB and blocked the event loop ~1.1s parsing
it).

**Fix:** `MAX_DATA_ROWS` (5,000) / `MAX_DATA_COLUMNS` (50) — generous for the
real shape (`MAX_FILE_BYTES`'s own comment: "a month of punches is tiny"),
checked against the sheet's `!ref` range immediately after `XLSX.read`,
BEFORE the expensive `sheet_to_json` call. This is a deliberately narrower
fix than "move parsing to a worker thread": this is an admin-only,
Section-Access-gated internal tool with a hard file-size ceiling already —
a full worker-thread pool would be disproportionate complexity for the real
risk surface here, which this dimension check already bounds tightly.

**Verification:** a real-shaped 60-punch file still parses correctly; a
5,500-row workbook is rejected with a clean 400 BEFORE `sheet_to_json` runs
(confirmed fast — the row-count guard, not the file's actual size, is what
determines rejection speed); an over-wide workbook is also rejected. 5/5
assertions passed. Full suite unaffected (38/38, lint clean).

## F1 — the "two concurrent decisions" test was genuinely non-deterministic

Not dismissed, not just retried until green: `approvalEngine.service.js`'s
`decideApprovalStep` had a redundant early check (`if (doc.status !==
pendingStatus) throw 400`) sitting BEFORE every branch's own atomic
conditional `findOneAndUpdate` (which already, consistently, returns 409 on
a lost race — confirmed true of all four atomic-update sites: the legacy
path, and the workflow path's Reject/Approve-not-last-step/Approve-last-step
branches). Depending on exact scheduling, the loser of a real race could
either lose at the early read (400) or at the atomic update (409) — the
same two racing actors, two different status codes, purely from timing.

**Decided contract:** 409, always, for "this request is not pending review
anymore" — whether that's a live race a millisecond old or a stale-open UI
tab three days old. The early check was removed entirely; the atomic
conditional update in each branch is now the SOLE source of truth (it
already was everywhere else in this function). Authorization checks
(`assertScope`/`legacyAllowedRoles`/step-role membership) still run
regardless of the document's status — a non-authorized actor gets 403,
never information about the request's current state.

**Verification:** the target test now passes 5/5 consecutive runs (was
flaky before). Full suite 38/38.

## P9 — two pickers duplicated an identical request under separate cache keys

`DocumentUploadModal`'s owner picker (`['ownerPicker','Employee']`) fetched
the exact same `listEmployees({limit:100,sortBy:'fullName',sortOrder:'asc'})`
every other picker already shares via `useEmployeePicker` — and separately,
`DocumentUploadModal`'s client branch and `ExpenseListPage`'s client picker
both called `listClients({limit:100,sortBy:'companyName',sortOrder:'asc'})`
— byte-identical params, two separate cache entries.
(`DeploymentListPage`'s own `listClients({limit:100})` — no explicit sort —
is a genuinely different shape and was correctly left alone.)

**Fix:** `DocumentUploadModal` now calls `useEmployeePicker` directly for
its Employee branch. A new shared `lib/useClientPicker.js` (mirroring
`useEmployeePicker.js`'s own precedent exactly) is now used by BOTH
`DocumentUploadModal`'s Client branch and `ExpenseListPage`.

**Verification:** live browser click-through as a real Admin — opened the
global Documents "Upload document" modal (fired one real `/api/employees`
request), switched owner type to Client (fired one real `/api/clients`
request), closed it, navigated to Expenses, opened "Add expense" — the
client dropdown populated fully (2 real clients) with **zero** new
`/api/clients` network request, confirming the shared cache entry actually
served it.

## P10 — two real query shapes lacked supporting indexes

The dashboard's monthly profit-trend aggregate range-matches
`Invoice.date` (no index existed at all — `client`/`status`/`createdAt`
were the only three). The Requirements board's whole-board fetch (every
stage at once, `Requirement.find(filter).sort({stageEnteredAt:1,_id:1})`)
doesn't match the existing `{stage:1, stageEnteredAt:1}` compound index
(that index's leading field is `stage`, and the whole-board query is never
filtered by a single stage).

**Fix:** added `invoiceSchema.index({date:1})`. Added
`requirementSchema.index({stageEnteredAt:1,_id:1})` — the ORIGINAL `{stage:1,
stageEnteredAt:1}` index stays, since `countStaleRequirements`'s own
per-stage staleness filter (stage equality + a stageEnteredAt range) is a
real, different query shape that index still correctly serves.

**Verification:** against the real dev database — confirmed both indexes
exist, confirmed the dashboard's exact profit-trend aggregate pipeline now
plans as `IXSCAN` on `date_1` (was `COLLSCAN`), confirmed the board's exact
sort now plans as `IXSCAN` on the new compound index with no `SORT` stage
(was `SORT` over `COLLSCAN`), and confirmed the staleness-detection query
shape still correctly uses the ORIGINAL `{stage, stageEnteredAt}` index (no
regression). 8/8 assertions passed, via `db.runCommand({explain:
{aggregate...}})` for the aggregate (Mongoose's own `Aggregate#explain()`
errors on this driver version — `"Option explain cannot be used ... with
writeConcern"` — worked around with the native command form) and
`.explain('queryPlanner')` for the find/sort.

## P6 — the client's initial bundle shipped work no session needed yet

Three real, independently-verified causes, not just "raise the chunk-size
warning threshold":

1. **Both locale dictionaries, always.** `i18n/index.js` eagerly imported
   BOTH `en.json` (106KB) and `ar.json` (137KB) unconditionally — every
   session downloaded both languages regardless of which one it used.
2. **Both post-login shells, always, even before login.** `router.jsx`
   eagerly imported `DashboardLayout` AND `EssLayout` — mutually exclusive
   per session (staff vs. Worker/Staff-ESS) — plus this happens before the
   user is even authenticated, since `router.jsx` is pulled in from
   `main.jsx` synchronously.
3. **The Sentry SDK (~130KB), on every load, error or not.** `ErrorBoundary`
   — mounted by every layout including the always-eager `AuthLayout` —
   statically imported `lib/sentry.js` for its one `captureError` call, the
   ONLY real call site anywhere in the app.

**Fix:**
- `i18n/index.js`: a minimal custom i18next backend (`type: 'backend'`, no
  new dependency — `i18next-http-backend` et al. are for fetching over
  HTTP, not what's needed for a same-bundle dynamic import) loads a
  language's JSON via real `import()` only when i18next asks for it — once
  for the current language at init, again only on an actual language
  switch. Exports `i18nReady`; `main.jsx` awaits it before the initial
  render so there's never a flash of untranslated keys.
- `router.jsx`: `DashboardLayout`/`EssLayout` are now `lazy()` (the exact
  same pattern the file's own 66 pages already used), each wrapped in its
  own `<Suspense fallback={<FullScreenFallback/>}>` at the route-tree point
  where it's referenced (a lazy component needs an ANCESTOR Suspense to
  catch its own chunk load — the Suspense each layout already provides
  around its own `<Outlet>` only covers its children, not itself).
  `AuthLayout` deliberately stays eager (41 lines, needed immediately for
  every guest, before any auth state is known).
- `ErrorBoundary.jsx`: `captureError` is now reached via
  `import('../../lib/sentry.js').then(...)` inside `componentDidCatch`,
  not a static top-level import. `Sentry.init()` (the module's own
  top-level side effect) still runs the moment that first import resolves
  — even the FIRST caught error is still correctly reported end-to-end.

**Verification:** built and measured before/after. Entry chunk:
**852,050 bytes → 35,480 bytes** (gzip: 260,550 → 9,630 bytes) — a ~96%
reduction. `en`/`ar` are now separate ~82KB/~113KB chunks, `DashboardLayout`/
`EssLayout` separate ~8KB/~7KB chunks, Sentry a separate ~85KB chunk — none
of them in the entry. Then a full real-browser click-through against the
PRODUCTION build (`vite preview`, not dev mode, since only the real build
reproduces actual chunking — required a temporary, fully-reverted CORS
allowlist addition for the preview's own port, restored exactly afterward):
logged in as a real (disposable) Admin — confirmed `ar-*.js` and
`sentry-*.js` were genuinely ABSENT from the network log on a normal login
(only `en-*.js` and `DashboardLayout-*.js` loaded, never `EssLayout-*.js`
for a staff login); switched language to Arabic live — confirmed exactly
one new request (`ar-*.js`) fired and the whole dashboard correctly
re-rendered in Arabic with RTL; confirmed the Sentry chunk, when explicitly
imported via `javascript_tool` (deliberately NOT via a real thrown error —
that would have sent a genuine test report to the company's real
production GlitchTip instance), resolves and exports a real `captureError`
function, proving the deferred-import wiring is mechanically correct
without polluting live monitoring data. Full client lint clean throughout
(18 pre-existing warnings across 10 OTHER files, 0 errors, 0 new — traced
and confirmed every one predates this pass).

## What's left (not built in this pass, with reasoning)

- **P8** (large overview/board responses, DOM rendering) — the audit's own
  words: "growth risk, not demonstrated causes of today's latency,"
  reproduced only from code/import analysis since the real database is too
  small to show a browser freeze. Not built.
- **Dead code / duplication** (33 exports that could go private, 8
  exact-duplicate-function-body findings) — the audit's own words: "unlikely
  to matter for runtime speed." Not built.
- **Docs reorganization** (archiving the retired root repo's stale
  docs/splitting this file's own long changelog) — explicitly framed by the
  audit as a handoff/reading-time improvement, not a speed fix. One
  specific item, `sectionAccess.controller.js`'s comment drift, was
  verified accurate to a real (already-known, separately-tracked) gap but
  not edited in this pass.
- **Monitoring/baseline** (real production p50/p95, query counts, 429
  frequency, browser nav timing, turning on `tracesSampleRate`) — framed by
  the audit as an ongoing-practice recommendation, not a concrete change.
  Not built.

None of these were disputed — they're genuinely lower priority by the
audit's own framing, and are natural candidates for a separate pass if
wanted.

## Follow-up (same day): P8, duplicate-code cleanup, docs reorganization

Continued into the three lower-priority items above per the user's own
"go ahead and continue into P8/dead-code/docs."

**P8 — fixed the one real over-fetch, confirmed the rest is deliberate
design.** `getBoard`'s (requirement.service.js) own query fetched every
candidate's full details (name/Iqama/nationality/phone/docs note) and the
entire `stageHistory` for up to 1000 cards, then discarded almost all of it
in JS — `present()` only ever needs `candidates[].status` (for
`candidateCount`/`mobilisedCount`) and the board never touches
`stageHistory` at all (confirmed against the client: only
`RequirementDetailModal` uses it). Fixed with a narrowed `.select()`
excluding everything except `status` from each candidate and all of
`stageHistory` — `getRequirement`/`exportRequirements`, which genuinely
need the full documents, are untouched. Verified with a disposable
`Requirement` fixture (3 real candidates, one of each status): board
response now has correct counts (2 non-Dropped, 1 Mobilised) and contains
**zero** candidate names/Iqamas/notes anywhere in the JSON, while
`getRequirement`/`exportRequirements` still return all 3 candidates in
full — 12/12 assertions passed, fixture cleaned up. The OTHER P8 location
(`DeploymentOverviewModal`'s up-to-5,000-row, ~40-column fetch) was
investigated and left alone: its comprehensive field set is deliberate,
recent, iterative design from multiple explicit user requests ("need every
single data entered in mobilisation" — see `docs/DEPLOYMENT-notes.md`'s
2026-09-16/17 follow-ups), not an oversight, and the audit's own words
already concede this is a "growth risk, not a demonstrated cause" with
virtualization "where a real large-data profile justifies it" — not yet.

**Duplicate-code cleanup, 6 of 8 findings.** Fixed: the copy-password
handler (`EmployeeLoginPanel.jsx`/`UserListPage.jsx` → a new
`lib/useCopyToClipboard.js`); the job-title quick-create
(`MobilisationForm.jsx`/`RequirementFormModal.jsx` → a new
`features/jobTitles/useJobTitleQuickCreate.js`, preserving each caller's
own hook-ordering constraint); the coordinator-list picker
(`dailyUpdate.service.js`/`requirement.service.js` → a new
`utils/listActiveCoordinators.js`, taking the already-resolved `teamRead`
boolean so each module's own `resolveAccess` stays untouched, exactly the
audit's own caution); the PDF line-item table + totals rows
(`invoice.pdf.js`/`quotation.pdf.js` → a new `utils/pdfLineItemTable.js`,
rewritten from closures-over-a-mutable-`y` into explicit-argument functions
that return the new `y`, so each document keeps full control of its own
page-break/before/after layout); and — beyond the audit's own two
"low-priority" findings — all FOUR near-identical icon renderers
(`DashboardLayout`/`EssLayout`'s own `NavIcon`, `SectionHubPage`'s
`ItemIcon`, `SectionAccessPage`'s `GridTileIcon`, differing only in size)
consolidated into one `components/ui/Icon.jsx`. Left alone, per the
audit's own explicit instruction: the client/server Mobilisation validation
refinement ("do not remove the server-side one... contract tests may be
better than coupling two repositories").

Verification: the coordinator-list extraction was checked against real dev
data (5/5 assertions — both modules return the identical, correctly-sorted
real coordinator list; both still 403 a no-access actor). The PDF
extraction was checked by generating a real multi-page Invoice and
Quotation PDF (30 and 25 line items, enough to force each document's own
page-break threshold) via the actual refactored code and reading the
rendered text back with `pdftotext -layout` — correct header-row repeat
after each page break, and every Subtotal/Discount/VAT/Grand
Total/Paid/Balance Due/Payments/Notes value matched exactly. The icon
consolidation was checked with a full browser click-through as a real
(disposable) Admin: sidebar nav, a Workforce hub page, the Section Access
category grid, and its module grid all render their icons correctly. Full
server suite 38/38 and full client build clean after every step.

**Docs reorganization.** `sectionAccess.controller.js`'s comment drift
(flagged but not fixed in the main pass) is now fixed — it claimed "every
route is Admin-only" with no mention of the explicit authenticated `/mine`
exception three lines below. The retired root repo's `CLAUDE.md` now
carries a clear banner at the very top stating it's archived/non-canonical
and pointing to the two real copies — a local, reversible clarity fix, not
the separate (still user-owned, still not done) decision of archiving the
GitHub repo itself. And the big one: `CLAUDE.md`'s 1,528-line `## Status`
section (essentially the entire file) was moved verbatim into a new
`docs/CHANGELOG.md` — verified byte-for-byte identical via `diff` before
either file was touched — leaving `CLAUDE.md` at 143 lines: the actual
current-state guide (role, hard rules, stack, architecture, security, UI,
verification, environment) plus a short Status summary pointing to the
changelog for full history. Two stale in-file cross-references ("see this
file's own Status entry") were updated to point at the changelog instead.
Both `server/` and `client/` copies of `CLAUDE.md` and the new
`docs/CHANGELOG.md` confirmed identical via `diff`.

**Deliberately not built**: the 33-export "could become private" list.
The audit's own words — "unlikely to materially improve production speed
because build optimization already removes unnecessary exported surface
where possible" — mean this has zero measured runtime benefit; grinding
through 33 separate single-file edits, each needing its own
whole-codebase reference check to avoid silently breaking an external
caller, is real risk for a change the audit itself says doesn't matter for
speed. Flagged, not silently skipped.

## Second follow-up (same day): P8's remaining item + the monitoring baseline

Continued per the user's own "continue into P8 remaining items and
monitoring recommendation."

**P8 — real data check before building anything.** Before touching
`DeploymentOverviewModal`, checked the real dev database: **9** real
Deployments, **0** real Requirements — nowhere close to either cap (5,000 /
1,000), and no virtualization library is installed. Put this directly to
the user with three real options (leave it, build virtualization now
anyway, or a lighter no-new-dependency safeguard) rather than guessing —
they chose the safeguard. Investigating found a REAL, confirmed gap:
`listDeployments` already computes and returns the true, unclipped `total`
(`Deployment.countDocuments` against the same filter) — but
`DeploymentOverviewModal.jsx` never once read it, only ever comparing its
own already-capped `rows.length` against itself for the existing "Showing
X of Y" text. If a real result set ever exceeded `OVERVIEW_ROW_LIMIT`
(5,000), the modal would silently show a partial register with zero
indication anything was cut off. Fixed with a `truncated = data.total >
rows.length` check and a warning banner, styled and worded to match the
Requirements board's own existing (and, on inspection, already-correct)
`truncated` notice exactly — including an honest caveat that "Export to
Excel" is NOT an escape hatch, since `exportDeployments` shares the exact
same 5,000-row cap. English + Arabic. Verified live: with real data (9 of
9), the banner correctly does NOT appear — no false positive on the
common path; the interpolated message text was verified correct via the
same `{{var}}` substitution mechanism already proven live for the
sibling `rowCount` text in this same file. Deliberately NOT built:
virtualization or pagination — confirmed not yet justified by real data,
matching the audit's own "growth risk, not a demonstrated cause" framing,
now with harder numbers behind it.

**Monitoring baseline.** Two real, separate additions, each reusing
existing infrastructure rather than adding a new dependency or service:

- *Client*: `lib/sentry.js` now sets `tracesSampleRate: 0.2` (a
  deliberately partial, "privacy-conscious" sample per the audit's own
  words — not every session) with `Sentry.browserTracingIntegration()`
  added, so real page-load/navigation/interaction timing is now captured,
  not just exceptions. This required reconciling a real tension with this
  same day's earlier P6 fix: `lib/sentry.js` had been made a REACTIVE
  dynamic import (only loaded once `ErrorBoundary` actually catches an
  error) specifically to keep its ~85KB out of the entry bundle — but
  tracing only captures anything meaningful if the SDK initializes near
  app start, not the first time something happens to throw, which almost
  never happens in a normal session. Resolved by keeping the dynamic
  import (still a separate chunk, the entry bundle is unaffected — still
  ~35KB) but kicking it off eagerly, fire-and-forget, at the very top of
  `main.jsx` — loads in the background without blocking the render below
  it. `ErrorBoundary`'s own dynamic import stays as the fallback for an
  error thrown before that one settles (a harmless cached re-import once
  it has). Verified live: `sentry.js` now loads immediately at app start
  (confirmed in the network log) rather than only on error, app renders
  correctly, no new console errors.
- *Server*: a new `middleware/requestMetrics.js`, mounted FIRST in
  `app.js` (before helmet/cors/parsers/rate-limiting, so `durationMs`
  reflects the whole request lifecycle), logs one structured line per
  response — method/route (the matched Express pattern, not the raw URL,
  to avoid cardinality blowup)/status/duration/payload size — via the
  Winston logger that already writes JSON to `logs/combined.log` in
  production (config/logger.js), so this needed no new log destination.
  Mounting it first also means it measures EVERY response including a 429
  from any of `rateLimiter.js`'s limiters, giving real 429-frequency data
  as a free byproduct rather than needing separate instrumentation. A new
  `config/monitoring.js` adds a once-a-minute sample of event-loop delay
  (Node's own built-in `perf_hooks.monitorEventLoopDelay` — no new
  dependency) and an aggregate (process-wide, not per-request — true
  per-request correlation would need AsyncLocalStorage, a bigger
  architectural change than "establish a baseline" calls for) Mongo
  operation count via `mongoose.set('debug', ...)`, counting only, never
  logging the query itself (which can contain real data). Wired into
  `server.js` the same way the existing `expiryAlertJob`/
  `mobilisationStaleJob` periodic jobs already are, including graceful
  shutdown cleanup. Verified live against the real dev server: curled
  several real endpoints (200/401/404) and confirmed a `request` log line
  for each; waited a real 60-second interval and confirmed `event-loop-
  delay`/`mongo-ops` fired on schedule; confirmed via an isolated Winston
  formatter test that the metadata fields are genuinely captured in the
  JSON format production uses (the dev console's own human-readable
  format doesn't print them, by that formatter's own pre-existing design
  — not a bug); confirmed via a disposable-fixture script that the Mongo
  op counter and the event-loop histogram both record real activity (not
  asserting an exact per-call operation count — confirmed 3 high-level
  Mongoose calls can genuinely produce more low-level operations than
  that, the same "one API call isn't one DB round trip" lesson this
  session already hit once with `canAccessSection`). Full server suite
  38/38 throughout.
