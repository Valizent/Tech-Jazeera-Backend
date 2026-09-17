# P3-F — Notifications

Continues the Phase 3 build-out (see `docs/PHASE3-PLAN.md`). The plan called
for "a push channel for expiry alerts + request status changes"; asked which
of two builds to do (an in-app-only notification center, or real browser
Web Push), the user chose the latter — the more PRD-literal, materially
bigger build. Both halves shipped: a real in-app notification center (the
reliable channel) plus genuine Web Push on top of it (arrives even with the
app closed, like a native app would).

## What was built

**New dependency**: `web-push` (server). Justification: implementing the Web
Push protocol by hand (VAPID JWT signing, RFC 8291 payload encryption) is far
past the "~30 lines" bar — this is the standard, actively-maintained library
for it, same category as the existing pdfkit/exceljs additions. Introduces
no new vulnerabilities (verified via `npm audit` — the only advisories in
the tree are pre-existing, from exceljs's own dependency chain).

**New — the app's own VAPID identity, not a third-party secret**
```
server/src/scripts/generate-vapid-keys.js  # npm run generate:vapid — prints
                                             #   a fresh key pair to paste
                                             #   into .env, mirrors seed-admin.js's
                                             #   operator-tool style
server/src/config/webPush.js                # configures web-push from env;
                                             #   pushEnabled=false (not a boot
                                             #   failure) if unset
server/.env / .env.example                  # + VAPID_PUBLIC_KEY,
                                             #   VAPID_PRIVATE_KEY, VAPID_SUBJECT
                                             #   (all optional — see below)
```

**New module — `server/src/modules/notifications/`**
```
notification.model.js       # Notification — the in-app list, the source
                              #   of truth; push is best-effort on top of it
pushSubscription.model.js    # PushSubscription — one browser/device's Web
                              #   Push endpoint per user
notification.validation.js, .service.js, .controller.js, .routes.js
                              #   mounted at /api/notifications,
                              #   requireAuth only (every role, Worker
                              #   included — see below)
expiryAlert.job.js            # the "expiry alerts" half of the plan — a
                              #   daily background scan, wired into
                              #   server.js via setTimeout+setInterval
                              #   (no new scheduler dependency)
```

**Extended — 7 existing decide functions, one line each**
```
server/src/modules/leave/leave.service.js                  # decideLeaveRequest
server/src/modules/timesheets/timesheet.service.js         # decideTimesheet
server/src/modules/financialRequests/advance.service.js    # decideAdvance
server/src/modules/financialRequests/reimbursement.service.js
  # decideReimbursement + markReimbursementPaid
server/src/modules/exitDocuments/exitReentry.service.js    # decideExitReentry
server/src/modules/exitDocuments/certificate.service.js    # decideCertificate
server/src/modules/clients/client.service.js                # decideClient
                                                              #   (notifies
                                                              #   the Coordinator
                                                              #   directly, not
                                                              #   through an
                                                              #   Employee link)
server/src/modules/dashboard/dashboard.service.js            # + exported
                                                              #   IDENTITY_DOCS
                                                              #   (one source
                                                              #   of truth with
                                                              #   the expiry job)
```

**Client**
```
client/src/features/notifications/
  notifications.api.js         # list/read/read-all/vapid-key/subscribe/unsubscribe
  push.js                       # browser-side subscribe/unsubscribe,
                                 #   urlBase64ToUint8Array boilerplate
client/src/components/shared/NotificationBell.jsx
  # mounted in BOTH DashboardLayout and EssLayout headers — every role gets
  #   it, staff and Worker alike
client/public/sw.js
  # + 'push' and 'notificationclick' handlers — the service worker's first
  #   real job beyond satisfying PWA installability
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/api/notifications` | any authenticated user | own list, paginated, `unreadCount` included |
| GET | `/api/notifications/vapid-public-key` | any authenticated user | the key the browser needs to subscribe |
| PATCH | `/api/notifications/:id/read` | any authenticated user (own only) | mark one read |
| POST | `/api/notifications/read-all` | any authenticated user | mark all own read |
| POST | `/api/notifications/subscribe` | any authenticated user | register this browser's push subscription |
| POST | `/api/notifications/unsubscribe` | any authenticated user | remove it |

## Key decisions & why

- **The in-app list is the source of truth; push is additive, never the
  only copy.** A push can be missed for reasons entirely outside this app's
  control (permission never granted, device offline, browser force-closed)
  — every notification is always created in the database first, and a push
  send is attempted only after that succeeds, wrapped so a failed send can
  never roll back or block the underlying decide action.
- **VAPID keys are optional, not required, config.** Making them required
  would mean every existing deployment fails to boot the moment this code
  ships, over a feature that can degrade gracefully instead — `pushEnabled`
  is simply `false` until `npm run generate:vapid`'s output is added to
  `.env`, logged once as a warning, and every push attempt silently no-ops.
  The in-app list keeps working regardless.
- **A CRITICAL bug found and fixed during verification**: the Notification
  schema originally gave `dedupeKey` a `default: null`, and the service
  explicitly wrote `dedupeKey: null` for ordinary (non-expiry) notifications.
  A sparse unique index does NOT skip "present with value null" — only
  "field absent entirely" — so the **first** ever plain notification worked,
  and the **second** one, for anyone, would throw a duplicate-key error that
  propagated all the way up through the decide endpoint as a 500, even
  though the underlying status change had already saved successfully. This
  was caught by testing two decide flows back-to-back with real data
  (leave, then a second advance) via a direct service-level test, not
  assumed safe from the code. Fixed by never setting the field at all when
  no `dedupeKey` is given — see the doc comments on `notification.model.js`
  and `notifyUser()` for the exact mechanism, so it doesn't regress.
- **Seven decide functions, not a partial set.** Every "someone submits a
  request, a decision changes its status" flow in the app got wired —
  Leave, Timesheet, Salary Advance, Reimbursement (both decide and mark-paid),
  Exit Re-entry Visa, Certificate, and a Coordinator's Client submission.
  That's the complete, enumerable set (`grep -rn "^export async function decide"`
  across every service module) — not a sampling, so nothing that fits the
  plan's "request status changes" wording was left silently uncovered.
- **Expiry alerts stay company-wide (Admin/Manager/HR), not
  Coordinator-team-scoped**, even though the dashboard's own expiry view
  already has that scoping logic. Admin/Manager/HR already see every
  expiring item on the dashboard today; replicating the Coordinator
  team-scoping into a background job for comparatively little proactive
  value was a deliberate scope line, not an oversight.
- **No new scheduler dependency for the expiry job** — a single
  `setTimeout` (once, 10s after boot) plus `setInterval` (every 24h) in
  `server.js` is simpler and entirely sufficient for a once-daily check in
  a single-process app; pulling in a job-queue library for this would be
  the "don't add a library where ~30 lines would do" rule working in
  reverse.
- **`Notification` routes are `requireAuth` only, deliberately not
  `requireStaff`.** Every other Notifications design choice in this app
  gates staff modules against Workers — this one can't, because Workers are
  exactly who most of these notifications (their own leave/timesheet/request
  decisions) are addressed to.

## Verified (2026-08-30)

**curl** (throwaway admin + a Worker login, deleted after), against real
data:

- The critical dedupe bug above: reproduced with a direct two-call test
  against `notifyUser()` (a second plain notification colliding on the
  shared `null` dedupeKey), fixed, then re-verified — two plain
  notifications now create cleanly back-to-back.
- Advance decide → Approved: the worker's notification list showed the
  correct title ("Salary advance approved"), the decision note as the body,
  and `/me/requests` as the deep link — matched exactly, not just present.
- Leave decide → Approved (a fresh `Manual`-recurrence LeaveType, submitted
  as `PendingReview`): the notification carried the real leave type name
  ("P3F Test Leave request Approved"), the decision note, and `/me/leave`.
- Mark-read: unread count dropped from 1 to 0 correctly; mark-all-read on
  an already-all-read list correctly reported `{updated: 0}`; a **different**
  user (the admin) attempting to mark the worker's notification read got a
  404 — ownership isolation confirmed directly, not assumed from the query
  shape.
- Expiry-alert job: run against a real employee with a passport set to
  expire in 10 days — found the item, fanned out to every real Admin/
  Manager/HR user in the database (3, in this environment) with an
  accurate count. Re-running the SAME check immediately after correctly
  reported 0 *new* notifications (the dedupe key held) while the original 3
  remained untouched — not recreated, not duplicated. Changing the
  passport's expiry date to a genuinely different day correctly produced 3
  fresh notifications, confirming the dedupe key is scoped per exact
  expiry date, not just per document.
- Real Web Push delivery path: registered a syntactically real Chrome/FCM-
  shaped push subscription (fake subscription id, since a genuine one needs
  a real browser-registered device) and sent to it — the actual HTTPS call
  reached Google's real push infrastructure with our VAPID JWT, and our
  dead-subscription pruning correctly deleted it after the service's
  real error response. This exercises the true signing + delivery + cleanup
  path end-to-end; only the final "does an OS notification pop up on a
  physical device" step needs a real subscription to observe.

**Browser**: logged in as the Worker and confirmed the notification bell
renders the exact same data seen via curl (title, decision note, relative
time), and that mark-read/read-all work through the UI. The "Enable push
notifications" control could not be exercised in this session's sandboxed
browser pane specifically — `navigator.serviceWorker.register('/sw.js')`
fails there with a generic "unknown error fetching the script" even though
the file itself was independently confirmed to fetch correctly (200,
correct `text/javascript` content-type, correct content) via a raw
`fetch()` call from the same page; `Claude in Chrome` (the user's real
browser) was not connected this session as a fallback. This reads as an
environment-specific restriction on Service Worker registration in this
particular automation sandbox, not a defect in the app — the file serves
correctly, the subscribe/unsubscribe code is standard Web Push
boilerplate, and the harder, actually-novel half (the server's real
signing/delivery/pruning path) was independently verified above. **Trying
"Enable push notifications" in a real desktop or mobile browser and
confirming an OS notification actually appears is the one remaining
manual check worth doing once you have a spare minute.**

**Client build**: `npm run build` — clean, no errors.

**Cleanup**: the throwaway admin and Worker logins, the test employee, the
test LeaveType/LeaveRequest/SalaryAdvance, the fake push subscription, and
every notification this session generated — including the ones the
expiry-alert job's company-wide fan-out sent to the **real** Admin/Manager/
HR accounts in this database as a side effect of testing it — were all
removed and independently re-verified gone (a final sweep query for any
stray notification mentioning the test employee's name returned zero).
Re-attempting a login with the throwaway admin's credentials afterward
confirmed it, too, is gone.

## One thing the user should know

Real VAPID keys were generated (`npm run generate:vapid`) and added to
`server/.env` (gitignored, not committed) so this milestone's push-delivery
path could be verified end-to-end — this app's own identity for signing
push messages, not a third-party credential. `VAPID_SUBJECT` was left at
the placeholder `mailto:admin@example.com`; swap it for a real contact
address if you want push services to be able to reach you about this
server specifically (a low-stakes, easily-changed value — see
`.env.example`).
