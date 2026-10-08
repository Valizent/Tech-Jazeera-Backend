# Native mobile app (React Native + Expo) — milestone notes

The Capacitor wrap (`P-MOBILE-notes.md`) is being replaced by a real native
app. Decided 2026-10-06 by the user, after being shown the trade-off (the
original reason React Native was rejected still holds: **every feature now has
to be built twice, web and mobile**):

- **Full parity** — every screen, delivered in 8 milestones (below).
- **Expo** (SDK 57, Expo Router). EAS cloud builds give an iPhone build
  without a Mac.
- **Its own repo** — `Mobile application/` at the root, GitHub
  `Valizent/Valizent-WMS-App`, `development`/`main` like the other two. The
  root `.gitignore` excludes the folder so the old root repo never picks it up.

Plan: M1 foundation + login + Worker/Staff self-service · M2 phone push +
staff tab shell + Dashboard · M3 requests & approvals · M4 coordinator workflow
· M5 deployments & financial · M6 workforce records · M7 admin tools · M8 store
release (same app id `com.aljazeera.crm` + the existing release keystore, so
phones running the Capacitor app upgrade in place).

## M1 — COMPLETE (2026-10-06)

### Server change: mobile token transport

`auth.controller.js`: a request with `X-Client: mobile` gets the refresh token
in the login/refresh JSON body (`data.refreshToken`) instead of the httpOnly
cookie, and sends it back in the body to `/auth/refresh` and `/auth/logout`
(`refreshTokenBodySchema`, whole object optional so the web's body-less POST
still validates). Mobile reads ONLY the body, web ONLY the cookie — a body
token is never attached by a browser, so the cookie's CSRF reasoning is
untouched. Rotation, the 30s reuse grace, theft detection and `tokenVersion`
are the unchanged service code. Covered by `auth.controller.test.js` (6 tests).

### App structure

```
src/app/            Expo Router routes — same URL paths as the web (/me/leave…),
                    so a notification's `url` opens the matching screen
  _layout.jsx       providers + the signed-in/out gate (Stack.Protected)
  login.jsx
  (app)/_layout.jsx role routing: forced password change → Worker/Staff ESS
                    tabs (or No portal access) → everyone else the staff side
  (app)/(ess)/…     the 6 self-service screens (4 tabs + More)
src/features/<name>/  *.api.js / *.schema.js — ported from the web, same names
src/components/ui/    Text, Button, Badge, Card, Input, Select (bottom sheet),
                      DateInput (native picker), Sheet, Toast, Screen, ...
src/components/shared/ BrandLogo, ExpiryBadge, NotificationBell, AttachmentField,
                      confirm/confirmCancelRequest (native alerts), Offline*
src/lib/            api.js (axios + refresh), files.js (download/open, pick),
                    storage.js (SecureStore), queryClient.js, utils.js, constants.js
src/i18n/           the web's en/ar dictionaries + a `mobile.*` namespace
src/theme/          tokens.js (the web's light/dark palettes) + ThemeProvider
```

`@/` imports resolve to `src/` (jsconfig.json; Metro and ESLint both read it).

### Decisions and gotchas worth knowing (most found on the emulator)

- **Sessions survive offline.** A refresh that fails for network reasons never
  logs anyone out — only a real 401 (or no stored token) ends a session. A
  cold start with no connection shows a "Can't reach the server" screen that
  retries by itself when the connection comes back, not the login form.
- **NativeWind resolves conflicting classes by stylesheet order, not by
  `className` order.** `text-text` beat `text-danger` (every error rendered in
  plain text color) and `p-4` beat `p-0`. `Text`, `Card` and `SectionTitle`
  therefore add their defaults only when the caller didn't pass that kind of
  class. Any future component with default classes must do the same.
- **Dark mode is resolved by ThemeProvider itself**, not NativeWind's
  `colorScheme` (its manual override never applied on the emulator). The app
  uses no `dark:` variants; colors are CSS variables set with `vars()`.
- **Arabic RTL needs an app reload** (`I18nManager`). The app reloads itself
  once; if the direction still hasn't applied, it asks the user to close and
  reopen the app instead of reloading forever. *(Corrected in M2: the
  Arabic → English problem seen here was really Expo Go reporting
  `I18nManager.isRTL` as false all the time — see M2's gotchas.)*
- **Phone numbers inside Arabic text** need `ltr()` (Unicode isolates), or
  "+966…" renders as "966…+".
- **The Riyal sign (U+20C1) isn't in phone fonts yet** — it renders as an
  empty box. Money shows "SAR 1,234.50"; the copied dictionaries swap the
  glyph for "SAR"/"ر.س".
- **File picking uses expo-document-picker**, not expo-file-system's own
  picker, which names an Android pick "document:1000000079".
- **Request-cancel confirmations** use "Keep request" / "Cancel request" —
  the generic dialog showed two buttons both labelled "Cancel".
- Downloads open in the phone's own viewer (Android "open with" intent, iOS
  share sheet/Quick Look), after an authenticated native download.
- **No inactivity sign-out on phones** (the user's decision, 6 October): the
  web's 12-minute rule exists for shared office PCs. A phone stays signed in
  until the 7-day refresh token runs out, the user logs out, or an admin
  revokes the session.
- Error tracking (Sentry/GlitchTip) is deferred to M8 — it only matters in
  real release builds.

### Verified

- Server: 19/19 real-HTTP checks against the running dev server (both
  transports, the web's body-less refresh unchanged, rotation, logout,
  oversized token → 400, wrong password → 401, forced-password user blocked
  with `PASSWORD_CHANGE_REQUIRED`, Coordinator on `/api/me` → 403); full suite
  40/40; lint clean.
- App: `expo-doctor` 21/21, ESLint clean, Android bundle builds.
- On an Android 15 emulator (Expo Go) with throwaway accounts, all cleaned up
  afterwards (DB rows, Cloudinary files, emulator files): login; session
  restored after force-stopping the app; GPS sign-in/out verified by the
  server's geofence (and a correct rejection when far away); the early
  sign-out warning; leave with native date pickers, inline + toast
  validation, a PDF attachment upload, opening it in the phone's PDF viewer,
  and cancelling; a salary advance; a certificate request; notification tap →
  marks read in the DB and opens My Leave; profile photo from the gallery
  (crop + upload) and removal; dark mode; Arabic RTL; logout; the forced
  password change end to end (new password works, old one refused, flag
  cleared); a Coordinator landing on the staff home.

### Not yet verified / open

- **USER ACTION — first installable build.** Needs an Expo account: run
  `npx eas-cli@latest login`, then `npx eas-cli@latest init` in
  `Mobile application/`, then a `preview` build. Set
  `EXPO_PUBLIC_API_URL` for that build in EAS (environment variables) — it is
  not committed.
- On a real build (not Expo Go): the native stack header's RTL flip (Expo
  Go's own toolbar stayed left-to-right; the app's manifest already sets
  `supportsRtl`), native dialogs following the dark theme, and whether the
  RTL switch applies on the first automatic reload.
- Not exercised on the emulator yet: the offline screen, the camera (the
  emulator has no real camera).
- Found during M1 and cleaned up: two test leave types and a test employee
  ("Verify F04/F06…") left in the dev DB by the 6 October audit verification.

## M2 — COMPLETE (2026-10-06): phone push + staff shell + Dashboard

### Server change: native push (Expo)

- `DevicePushToken` (`notifications/devicePushToken.model.js`): one row per
  app install — `{ user, token (unique), platform, deviceName }`. Keyed on the
  token, so a shared phone that signs in as someone else MOVES its token to
  the new user instead of showing the previous person's notifications.
- `POST /api/notifications/devices` (register, after every sign-in) and
  `DELETE /api/notifications/devices` (just before sign-out — only the
  caller's own token). Zod checks the Expo token format and platform.
- `expoPush.service.js`: plain `fetch` to Expo's push endpoint (Node 22 has
  it; no SDK dependency). Runs inside the EXISTING bounded push queue next to
  Web Push (`Promise.allSettled`, so one channel failing never blocks the
  other) — every one of the app's `notifyUser` callers pushes to phones with
  no change of their own. `data` carries the notification's web `url` and its
  id. A `DeviceNotRegistered` ticket deletes that token (the phone twin of a
  dead Web Push subscription).
- `auth.service.js` `revokeAllSessions(userId)` replaced 7 bare
  `RefreshToken.deleteMany` calls (password change, admin password reset for
  staff and employee logins, role change, refresh-token theft, user/employee
  deletion). It also deletes that user's device tokens: a phone signed out by
  a password reset must stop showing their notifications on its lock screen.
  It registers again on the next sign-in.
- Not built (deliberate): Expo's delayed push *receipts*. A token that dies
  later is still dropped by the next send's ticket, on sign-out, or by the
  next sign-in's re-registration.
- Tests: `expoPush.service.test.js` (7). Suite 47/47.

### App

- **Push** (`src/lib/push.js`): registers after every sign-in/app start
  (permission asked once; Android channel `default` created first, which
  Android 13+ needs before it shows the prompt), unregisters on sign-out,
  shows a banner while the app is open, and a tap opens the notification's
  `url` (same paths as the web) and marks it read — also when the tap
  launched the app from closed. A push arriving while open refreshes the bell.
- **Staff tab shell** (`app/(app)/(staff)/`): Dashboard + More tabs, bell in
  the header. More: My details (not Admin — no employee record, same as the
  web), Notifications, Account. **The plan's 4 hub tabs are deferred to M3**:
  no staff module screen exists yet, so a hub would be an empty tab (hard
  rule 2). Each hub tab appears with its first real module.
- **Dashboard** (`app/(app)/(staff)/(tabs)/index.jsx`,
  `features/dashboard/components/`): every web widget, same order, one column
  — Waiting on you, client-approval banner, active revenue + touch sparkline,
  Actual performance, Directory stats, the Coordinator's target ring (+ the
  hit-confetti, RN `Animated`) and monthly window, HR compliance, My
  requirements, pipeline breakdown, daily attendance, standby analysis,
  coordinator leaderboard (sort chips; a row opens the drill-down sheet),
  expiring documents (alert window kept on the phone), API health + recent
  activity. Visibility comes only from what `/dashboard` returns, exactly
  like the web. Pull to refresh refetches every `['dashboard', ...]` query.
  **Not ported, on purpose**: Quick actions and Manage targets (both open
  screens that arrive in M4/M6).
- **My details** (`app/(app)/(staff)/my-details.jsx`): the web's
  MyDetailsModal as a screen, through `/api/profile`.
- **Screens not built yet**: a notification or Dashboard link to a staff page
  the app doesn't have lands on "Not in the app yet", which offers **Open on
  the web** with the same path and query when `EXPO_PUBLIC_WEB_URL` is set
  (optional; `.env.example`).

### Decisions and gotchas (found on the emulator)

- **Importing `expo-notifications` throws inside Expo Go on Android** (SDK
  53+ removed remote push there). `src/lib/push.js` loads it only outside
  Expo Go; in Expo Go push is simply off and everything else works.
- **In Expo Go, `I18nManager.isRTL` always reports false**, even while the
  layout is right-to-left (measured: `getConstants()` → `isRTL:false`,
  `localeIdentifier:en_US`). That made M1's startup self-check show "Reopen
  the app" on every Arabic launch, and was the real reason Arabic → English
  didn't reload in M1. Fix: a language change reloads when the two
  languages' directions differ (not based on `isRTL`), and the startup
  self-check runs only in real builds. Both directions now switch in one
  reload in Expo Go.
- **Signed percentages inside Arabic text** need `ltr()` too ("-19%" rendered
  "19%-").
- Changing the expiring-documents window used to blank the whole Dashboard
  to skeletons and jump to the top (new query key) — `keepPreviousData`.
- `mobile` package.json had been replaced after M1 by an unrelated
  "safe commit test" commit (expo 44 / RN 0.72 / NativeWind 2 / Tailwind 4 —
  the app no longer bundled). Restored to the M1 versions (SDK 57) before M2.

### Verified

- Server: 47/47 tests, lint clean; 16/16 real-HTTP checks (device register
  happy path + idempotent, no auth → 401, bad token/platform → 400, another
  user's unregister has no effect, Coordinator dashboard/target/profile,
  Admin `/profile` → 403, leaderboard, health); a real notification through
  the queue to **Expo's live push service** with a fake token → Expo answered
  `DeviceNotRegistered` → the token was deleted; a password change deleted
  the user's device tokens and ended the old session.
- App on the Android 15 emulator (Expo Go) with a throwaway Admin and a
  Coordinator (linked employee + a target), all cleaned up afterwards: the
  Coordinator's Dashboard (target ring, monthly window, own pipeline, team
  expiring documents, alert window change + kept position), My details
  (invalid phone refused inline + toast; valid save confirmed in the DB),
  sign-out; the Admin's Dashboard over real dev data (revenue + sparkline
  touch, Actual performance, attendance, directory, leaderboard sort both
  ways + drill-down, global pipeline, health, recent activity), More without
  My details, "Not in the app yet" → Open on the web with the exact path and
  query; dark mode; Arabic RTL both ways; lint clean; Android bundle builds.

### Not yet verified / USER ACTION

- **Push on a real phone** — impossible in Expo Go. Needs, once:
  1. the Expo account + `npx eas-cli@latest init` (M1's open item) — then
     paste the project id it prints into `app.config.js` as
     `extra.eas.projectId`;
  2. a Firebase project (free) with an Android app for `com.aljazeera.crm`:
     upload its `google-services.json` to EAS as a **file** environment
     variable named `GOOGLE_SERVICES_JSON`, and its FCM V1 service-account
     key under `eas credentials` → Android → Push notifications;
  3. a `preview` build. iPhone push needs the Apple Developer account (M8).
- On that build: push received with the app closed, the tap opening the
  right screen, sign-out stopping push; and the RTL startup self-check (a
  real build is expected to report `isRTL` correctly).
- Set `EXPO_PUBLIC_WEB_URL` (the web app's address) in EAS env to enable
  "Open on the web".

## M3 — COMPLETE (2026-10-07): requests, approvals, attendance

No server change — every screen uses the web's existing endpoints.

### Navigation

- **Hub tabs arrive** (deferred from M2): Dashboard · Workforce · Financial ·
  More, with Admin & Tools reached from More. `src/lib/navConfig.js` is the
  web's navConfig cut down to built screens only (same paths, labels and
  `sectionKey`/`roles` rules); a hub with nothing this user can open is
  hidden, so no empty tab ships. Each hub tab carries a badge from the
  Dashboard's own `myPendingActions` (`useNavCounts`, sharing the Dashboard's
  cached `/dashboard` query).
- **Executive (GM/COO)** gets one Requests tab instead of the hubs (the web's
  `EXECUTIVE_NAV_ITEMS`). Unlike the web, Leave/Timesheets/Exit Documents
  keep their section key there — the web's unkeyed entries send an Executive
  without the grant straight to "no access".
- Every module screen guards itself (`RequireSectionRead`, same key as its
  web route), so a notification or deep link can't open a screen this user
  can't read. Both stacks set `initialRouteName: '(tabs)'`: a screen opened
  cold from a link still has a back button to the tabs.

### Screens (all under `app/(app)/(staff)/`)

- **Leave** — review queue (approval trail, attachment, "Mark as seen" for
  auto-approved), staff self-submit (not Admin, as on the web), the holiday
  list, and Leave Types for Admin/HR (sick-pay tiers pre-filled with Article
  117's 30/60/30 as a starting point, every number editable).
- **Financial Requests** — salary advances (approve/reject, record repayments
  until it closes itself at zero) and reimbursements (receipt opens in the
  phone's viewer, mark paid), plus both staff self-submit forms.
- **Exit Documents** — re-entry visas (approve/reject, mark issued with an
  optional visa reference) and certificates (approve/reject, the generated
  Salary/Service PDF, mark issued), plus both self-submit forms.
- **Timesheets** — the monthly report: staff list → one person's month (day
  rows, totals, Excel export).
- **Approval Log**, **Holidays & Ramadan** (calendar + reduced-hours periods,
  write gated by Section Access), and **Attendance**: Records (one day at a
  time: a row per worker, tap to correct status/times/note, "Mark all
  present"), Sign In/Out (own punch with GPS/office IP + the log), Office
  Location, and the summary with Excel/PDF export.
- Shared pieces: `ReviewItem` (Approve/Reject only when the server says this
  viewer decides the current step), `ApprovalTrailView`, `QueryState`,
  `TabStrip`, `SwitchRow`, `TimeInput`, `confirmDecision`, and
  `openAuthedPostFile` for exports generated by a POST.

### Decisions

- **The web's attendance grid becomes a per-day list** — a month × worker
  grid can't be used at phone width. Same data, same rules (inferred Holiday
  and weekly Off), same editor; one day at a time with ‹ › and a date picker.
- The attendance editor's times are UTC "HH:MM", the exact pair the web uses,
  so a time entered on either lands on the same stored instant.
- "Mark paid" / "Mark issued" are one tap with no confirm, exactly as on the
  web; only Approve/Reject (irreversible) ask first.
- `formatDate`/`formatDateTime` now return the date wrapped in LTR isolates
  (`ltr()`): an English date inside an Arabic sentence was being split
  ("طلب في 7 … Oct 2026"). Display only — never use the result as a file
  name or to compare dates.

### Found and fixed on the emulator

- Decision toast said "rejected" after approving step 1 of a multi-step
  workflow (it read the request's new status, still pending) — it now uses
  the decision itself, on all 5 review queues. **The web has the same bug.**
- The Excel export could spin forever after a dropped connection (fetch has
  no timeout) — 30s, like the API client.
- A cold deep link to a module had no back button (see Navigation).
- A request whose employee was deleted showed a blank name — now "Employee
  record removed".
- Approval Log showed "Salary advance ·  · 7 Oct" (no sub-type) — empty parts
  are skipped, and visa/certificate/category sub-types are translated.
- Sick-pay tier inputs lost their only labels (placeholders) once pre-filled
  — column headers added.
- A timesheet month opened by link had no name in its header — taken from
  the report itself.

### Web issues found (not fixed here — web code, for a separate change)

- The same decision-toast bug on the web's 5 review panels.
- The web attendance editor shows UTC times while every other screen shows
  local time.
- The web Leave page's Holidays tab is blank when there are no holidays (no
  empty state).
- The web Financial Requests, Exit Documents and Approval Log pages are
  hard-coded English (no Arabic).
- The web Approval Log shows "· ·" for advances/timesheets and "()" for a
  removed employee.
- The web's Executive nav links to Leave/Timesheets/Exit Documents even
  without the grant, landing on "no access".
- Role names ("Manager", "HR") are shown untranslated in Arabic on both —
  app-wide, no role translations exist yet.

### Verified

- Android 15 emulator (Expo Go) as a throwaway Admin, HR and Executive plus a
  test Worker/employees, on the dev database: leave approve through a 3-step
  workflow (confirm, toast, trail), attachment in the PDF viewer, Leave Types
  create/edit with the tier pre-fill; advance approve ×3 → partial repayment →
  final repayment closes it; reimbursement receipt, approve, mark paid;
  re-entry approve + mark issued with reference; certificate approve, its
  PDF (real letterhead), mark issued; timesheet month + Excel export; Approval
  Log; holiday add/edit/delete and Ramadan add/delete with validation;
  attendance correction (8.0 h computed), sign-in with location refused (clear
  message), Office Location view, summary + PDF; HR's Financial hub, self-
  submit validation, "no access" on ungranted screens; Executive's Requests
  list; dark mode; Arabic RTL. Lint clean, Android bundle builds, every
  static translation key present in en + ar.
- Not exercised on purpose: "Mark all present" and saving Office Location
  (both would change real data), and a real self-submit (it would start a
  real workflow and notify real approvers).
- **Cleanup**: every fixture removed (users, employees, requests, leave
  types, attendance, Cloudinary files, tokens, audit rows) — zero residue.
  **Incident**: approving test requests through the real workflows sent 46
  "needs your approval" notifications to 12 real staff accounts on the dev
  database (the fixture's teardown only covered the test users'). All 46
  deleted afterwards; any Web Push already delivered can't be recalled. One
  real account also rejected the test leave at its final step — its audit
  entries (login, the rejection, logout) were left as real history. Next
  time: a temporary workflow whose step pools contain only test users.

## M4 — COMPLETE (2026-10-07): coordinator workflow

No server change — every screen uses the web's existing endpoints.

### Navigation

- A new **Sales & Clients** tab: Mobilisations, Daily Updates, Requirements,
  Lost Leads (same paths, section keys and badges as the web's sidebar).
  Workforce gains **Targets**, Admin & Tools gains **Coordinator Activity**.
- The Dashboard gains **Manage targets** and Quick actions (New mobilisation,
  Attendance), each shown only with the matching write grant.
- Write screens guard themselves too (`RequireSectionWrite`, with the
  Office Secretary bypass the web's New Mobilisation route has).

### Screens

- **Daily Updates** — Tasks (assign/add with a due date, mark done, edit and
  delete exactly as the row's server `permissions` allow) and Log (entries
  with an optional link to a requirement card); team filter for whoever reads
  the team; `?coordinator=`/`?tab=` deep links.
- **Requirements** — the board as stage chips (one column at a time, counts on
  each chip), filters (coordinator, client, subcontractor, older closed
  cards), cards with stale flags; a card screen with its timeline, updates,
  candidates and **Start mobilisation**; Manage stages (Admin); Excel export.
  **Lost Leads** with search, coordinator filter and export.
- **Mobilisations** — list (search, status, sort, export); New/Edit with the
  full web form: Iqama autofill, the previous-worker picker, OT client-rate
  autofill, job-title/location "+ Add new", the Employees picker loaded only
  for "Own Employee"; detail with documents (pick files or take a photo, up to
  10 × 10 MB, view, delete), coordinators (invite, shares, remove), the step-0
  reviewer's Section 2, save-before-decide, the approval trail, "From
  requirement" link and per-record export. **Worker data** (Admin): look up
  by Iqama, archive/unarchive.
- **Targets** (6 months per coordinator) and the **Manage targets** sheet
  (monthly progress, semi-annual, set/edit/remove).
- **Coordinator Activity** — clients and employees coordinators added
  themselves, with the client approve/reject decision.
- New shared pieces: `OptionSheet` (the list behind Select/SuggestInput, a
  search box from 9 options), `SuggestInput`, `PillChecklist`, `Pager`,
  `DateInput` min/max/clear, `Input` `trailing`, `QuickCreateSheet`,
  `LabelWithAdd`, `DetailRows` ("⚠ Missing" for required gaps),
  `RequireSectionWrite`; `ProgressBar` moved to `components/ui`.

### Decisions

- **No drag-and-drop board**: a multi-column Kanban doesn't fit a phone.
  Cards move with a "Move to…" picker (the web's own touch fallback) —
  optimistic, and a refusal rolls back only the moved card.
- **Start mobilisation passes only the requirement and candidate ids**; the
  form loads the card itself and uses a value only when it matches a real
  picker option, same as the web.
- **After a decision the reviewer often loses access** (a reviewer only sees a
  record while it's at their step), so the screen goes back instead of
  landing on "Mobilisation not found" — only on a 403/404 refetch, so a
  reviewer who also holds the next step stays on the record.
- Suggestions open in a sheet behind a list button, not under the field: the
  keyboard hid an inline list.
- Android is edge-to-edge (SDK 54+), so the window no longer resizes for the
  keyboard: `Screen`, `Sheet` and login pad themselves (`KeyboardAvoidingView`
  "padding" with the header height as the offset).
- Directional icons mirror from the **language**, not `I18nManager.isRTL`
  (false in Expo Go even while the layout is right-to-left — chevrons pointed
  the wrong way there). The native stack header still doesn't mirror in Expo
  Go; a real build does.

### Found and fixed on the emulator

- The keyboard covered the field being typed in (edge-to-edge, above).
- Approving a non-final mobilisation step said "Mobilisation approved." — now
  "Sent on to the next review step."
- After the final decision the screen showed "Mobilisation not found" (above).
- The approve sheet's optional note said "Explain what needs fixing…".
- Hub chevrons pointed right in Arabic (above).
- Two titles had lost their separator (the edit screen's "worker · client",
  the attendance editor's "name · day") — joined on mobile.
- Smaller: an undefined `accessibilityLabel` hid an input's label; duplicate
  suggestions (two workers with one name) broke the list; the stale-card
  border didn't apply through a conflicting class.

### Web issues found (not fixed here — web code, for a separate change)

- Client commit 60f1f4e ("fixed dashes") deleted the em dash from **101
  English strings** without a replacement, so clauses now run together (e.g.
  "…an active mobilisation or deployment demobilise or complete it first…").
  The app shows the same text. Needs a pass putting a comma/colon/full stop
  where each dash was.
- The web's mobilisation step approval also says "approved" for a non-final
  step, lands on "not found" after the final decision, and shows "Explain
  what needs fixing…" as the approve note's placeholder.
- The web Targets and Coordinator Activity pages are hard-coded English.
- `staffNav` has no keys for Targets or Lost Leads (the web falls back to
  hard-coded labels); the app's locale files add them.

### Verified

- Android 15 emulator (Expo Go) as a throwaway Coordinator, a second
  Coordinator (reviewer) and an Admin, on the dev database, every approval
  step on a temporary workflow whose pool held only test users: Daily Updates
  (task add with due date, done, edit/delete, log add/delete, validation);
  Sales hub badges; the board (own scope, move with toast and counts, card
  timeline, `?open=` link); Start mobilisation pre-fill → Draft linked to the
  card; job-title quick-create; OT rate autofill; no-documents submit warning;
  document upload, PDF view, delete; joint coordinator invite, 60/40 shares,
  remove; edit with nationality search; reviewer: step-0 Section 2 save then
  approve ("Sent on…", stays on the record), final approve → Approved with an
  Active Deployment in the DB, final reject → Rejected and the screen goes
  back, empty-note reject refused; Admin: Quick actions, Manage targets (set
  and remove a test coordinator's target, real targets untouched), Targets,
  Coordinator Activity client approve (empty reject refused), Lost Leads +
  Excel export, Worker data (archive refused while active), Manage stages
  (view); dark mode; Arabic RTL. Lint clean, Android bundle builds, every
  static translation key present in en + ar.
- Not exercised on purpose: editing/reordering the real board stages, and a
  real archive (only the refused case).
- **Cleanup**: every fixture removed (users, roles, grants restored and
  compared with the saved copy, clients, subcontractor, job title,
  requirement, mobilisations, the deployment, daily updates, targets, the
  temporary workflow, notifications, tokens, audit rows, counters) — zero
  residue, no notification to anyone left since the start.
  **Incident**: one test mobilisation was submitted through the API, which
  picked the real "Mobilisation workflows" workflow and sent one in-app
  "needs your review" notification to one real staff account (the reviewer
  on its "Secretary verification" step). Deleted within minutes; that account
  had no push subscription and the app sends no email, so nothing left the
  database. The record was then moved onto the
  test steps directly. Rule kept for next time: never submit a test
  mobilisation — put it on test-only steps in the fixture.

## M5 — COMPLETE (2026-10-08): deployments and financial

No server change — every screen uses the web's existing endpoints.

### Navigation

- **Sales & Clients** gains Deployments and the Standby list
  ('deploymentsRelease', like the web; an Office Secretary can open a
  deployment by link — her server bypass — so `RequireSectionRead` gained the
  web's `officeSecretaryBypass`).
- **Financial** gains the six invoicing/payment queues (no section key, like
  the web — the server scopes each one's data) and Expenses ('expenses').
  **Workforce** gains End of Service ('eosb'). The Executive's short list gets
  Expenses, as on the web.
- Hours approval (`/deployments/hours-review`, 'deploymentsHoursDecide' write)
  and payments approval (`/financial/payments-review`,
  'deploymentsPaymentDecide' write) open from buttons with the number waiting.
- The Dashboard's revenue/performance tiles open the Overview screen directly.

### Screens

- **Deployments** — list (status — Mobilised by default — client, site, sort,
  export, a red count of months still missing hours); **detail** with the
  placement, its expenses (add/edit with the deployment fixed), the monthly
  ledger (add a month picked from the months still missing, correct one, the
  subcontractor's hours as their own follow-up, the invoice copy, billing
  progress, the old day-by-day breakdown on request), Edit (site, worker name,
  contract hours, notes) and Demobilise (exit reasons only for an own employee;
  an exit offers "Calculate EOSB now?").
- **Standby list** — own employees and subcontractor/freelancer workers, each
  searched and sorted on the phone; "Mobilise" opens a pre-filled new
  mobilisation (shown only to whoever can create one).
- **Hours approval queue** — the figures to decide each month, Approve/Reject
  (reason required), net profit line by line.
- **Overview** — every deployment and every export column, filtered on the
  phone (status and worker type up top, every other column in a Filters sheet,
  year + month), totals for whoever may see commercial figures, as cards (tap
  for all columns) or a sideways-scrolling table.
- **Financial** — Ready to Invoice / Sub invoices received (record the invoice
  number, date — not before the month ends — and a copy; tap a month for its
  breakdown), Payments Due / Sub Payments Due (per party: every invoice with
  its live allocation, the payment history, record a payment), Received
  invoices / Paid Sub Invoices (one card per payment, Paid/Partial filter),
  Payments approval queue. The client and subcontractor versions of each step
  share one screen (`features/deployments/financialSides.js`) — the web keeps
  near-identical copies.
- **Expenses** — Ledger (this month's totals by category, search, category and
  date filters, receipts, add/edit/duplicate/delete; a reimbursement's expense
  links to Financial Requests, which now opens on `?tab=`) and Deployment costs
  (a worker's computed monthly costs).
- **End of Service** — list, new (with the optional overrides; `?employee=&
  exitDate=&exitReason=` pre-fill it) and the settlement with its PDF and delete.
- New shared pieces: `BreakdownPanel` (+ `BreakdownRow`), `MonthlyHoursForm`,
  `MonthEntryCard`, `DemobiliseSheet`, `ExpenseFormSheet`,
  `deploymentMonths.js` (the month rules, each mirroring a server check).

### Decisions

- A month is **picked from the months still missing** (a list), not typed —
  the web's month input allows months the server then refuses.
- The Overview's **drag-to-reorder columns isn't ported**: it's a desktop
  layout preference; on a phone the cards show every column.
- **Subcontractor invoices**: the app sends the invoice number, date and copy
  correctly (the web sends none — see below). No sub invoice copy can be opened
  and no subcontractor payment can be approved, because the server has no
  route for either; the app doesn't show those buttons.
- Two links the server sends point to screens that don't exist
  (`/deployments/payments-due` from the Dashboard's "Payments due soon" row and
  the invoice-sent notification, `/financial/subcontractor-invoices` from the
  sub-invoice notification). The app redirects them to Payments Due / Sub
  Payments Due so they — and notifications already delivered — land right.
- Plurals: Arabic needs zero/one/two/few/many/other forms; the locale files had
  only one/other (and four English keys no `one`), so many counts showed the raw
  key. The app's copies now have every form; new count strings avoid plurals.

### Found and fixed on the emulator

- The "impossible hours" limit was a day short (288 h instead of 306 h for a
  15 July start): the placement days were counted in Riyadh time, the dates are
  UTC midnights. Now counted in UTC, like the server. The web has the same
  off-by-one.
- The deployment Edit sheet never opened. Its form used React Hook Form's
  `values` option with a new object on every render; it now takes
  `defaultValues` and resets when the sheet opens, which fixed it.
- The expense category filter was labelled "Category *" (the form's required
  label); it has its own label now.
- M4's teardown had left three "Zz M4" Outsourced-employee records, and an M3
  test expense survived its deleted reimbursement claim; both removed now.

### Web issues found (not fixed here — for a separate change)

- **EOSB: a settlement computed with the override boxes blank is saved as
  SAR 0.** The web form sends `overrideEosbGross: ''` etc., and the server's
  `z.coerce.number()` reads `''` as 0. Shown through the API: blank → total
  SAR 0.00; left out → SAR 10,500.00, same employee. The dev database's only
  settlement isn't affected; production should be checked. Fix in either place
  (the server should treat `''` as "not given").
- **Sub invoices received**: the page passes a `FormData` to
  `recordSubInvoice`, which expects a plain object, so the invoice number, date
  and file are never sent — every subcontractor invoice is saved blank.
- **Subcontractor payments can't be approved**: there's no pending-payments
  route or screen for them, so they never allocate; Sub Payments Due's "Review
  Pending Payments" opens the *client* queue.
- Sub Payments Due shares the client page's query key (shows the other list's
  cached rows for a moment); its invoice "download" calls the client invoice
  route; its wording says "received from this subcontractor".
- The server URLs above (`/deployments/payments-due`,
  `/financial/subcontractor-invoices`, and the sub-payment notifications
  pointing at the client Payments Due).
- Sending a client invoice toasts "Sub Invoice recorded."; "CurrentEmployee"
  has no exit-reason label or hint key (the hint shows the raw key); the
  Financial hub description still mentions Payroll; Expenses and parts of the
  invoice/breakdown pages are hard-coded English; the Arabic/English plural
  gaps above.

### Verified

- Android 15 emulator (Expo Go), dev database, as a test Coordinator (hours
  entry without money figures) and a test Admin: hours added (the impossible-
  hours guard, then a real month), corrected, the subcontractor's hours added
  later; rejected with a reason, resubmitted, approved; profit breakdown; an
  invoice recorded with a PDF copy, then opened in the phone's viewer; a sub
  invoice recorded (number and date stored); a client payment recorded,
  approved, shown as Partial with the right balance; a sub payment recorded;
  Overview filters, the July month columns and totals (checked by hand), table
  view; deployment edited and demobilised, then on the Standby list, Mobilise
  pre-filled; an expense with a receipt, validation, duplicate, delete with its
  confirmation; Deployment costs; an EOSB settlement computed with blank
  overrides (SAR 10,500.00), its PDF, delete; dark mode; Arabic. Lint clean,
  the Android bundle builds, all 477 translation keys present in en + ar.
- **Open, seen once**: after the emulator sat idle ~4 hours (during which the
  dev server restarted dozens of times), the app was signed out: the server
  logged "Refresh token reuse detected … all sessions revoked". Most likely Expo
  Go reloading the app while a refresh was in flight (the new copy then sent
  the already-rotated token) — a dev-only path, but worth re-checking on a real
  build in M8 (leave the app idle, reopen).
- Not exercised: an own-employee deployment (no real employee was put on a
  test placement, so no exit → EOSB prompt), and the subcontractor-side
  approval that doesn't exist.
- **Notifications**: every deployment/payment notification goes to a
  permission group's members, so for the test the six groups involved
  (hours entry, hours decision, invoicing, mobilisation viewers, payment
  decision, EOSB) pointed at test-only roles; their real roles were saved first
  and restored identically. Zero notifications reached anyone but the test
  users.
- **Cleanup**: users, roles, client, subcontractor, employee, mobilisations,
  deployments, payments, expenses, settlements, the two Cloudinary files,
  notifications, tokens, audit rows, the mobilisation counter — and the M3/M4
  leftovers. A scan of every collection finds no test document left.

### M5 follow-up (2026-10-08): the web issues above, fixed

Every item in "Web issues found" above is fixed (server + web), and the app
gained what the server now offers.

**Server**
- **EOSB blank override → SAR 0**: `settlement.validation.js` treats a blank
  override box as "not overridden" (`emptyToUndef` before `z.coerce.number`);
  a real 0 is still an override. New `settlement.validation.test.js` (fails
  without the fix). **Production settlements computed on the web with blank
  boxes before this fix need checking** — they were saved as SAR 0.
- **Subcontractor payment approval**: `GET /api/deployments/sub-pending-payments`
  (`deploymentsPaymentDecide` write, like the client queue). The decide route
  already existed; nothing ever listed what to decide.
- **Sub invoice copy**: `GET /api/deployments/:id/monthly-hours/:entryId/sub-invoice-file`
  (same gate as the client copy); `getInvoiceFile` takes which file to serve.
- **Access bug found while doing this**: `getSubcontractorPaymentDetail`'s
  "own deployments only" check used `Deployment.exists(...).populate(...)`;
  `exists()` ignores populate's match, so any staff login could open any
  subcontractor's whole ledger. Now the same check as the client side
  (verified: another coordinator gets 403).
- **Links**: the invoice-sent notification and the Dashboard's "Payments due
  soon" row → `/financial/payments-due`; the sub-invoice notification →
  `/financial/sub-payments-due`; sub-payment notifications → the sub queue /
  Sub Payments Due (they pointed at the client page). A recorded sub payment
  now reads "recorded as paid". The sub payment amount is capped at
  10,000,000 like the client one.

**Web**
- The three client/subcontractor page pairs (Ready to Invoice / Sub invoices
  received, Payments Due / Sub Payments Due, Received invoices / Paid Sub
  Invoices) are now one page each, configured by
  `features/deployments/financialSides.js` (the same design as the app). The
  copies had drifted into the bugs: shared query keys, the sub invoice sent
  without its number/date/file (a `FormData` passed where an object was
  expected, with the wrong field names), the client download route, the
  client review queue, and a sub invoice amount without the worker's OT.
  `PaymentsReviewPage` takes the side too; new route
  `/financial/sub-payments-review`. Ready for sub invoice now has the same
  read guard as Ready to Invoice (the server's own rule).
- The placement-day count is in UTC (the 288 h vs 306 h off-by-one).
- Hard-coded English translated: Expenses (list, form, deployment costs —
  the `staffExpenses` keys existed but were never used), the breakdown panel,
  the financial table headers and counts. Arabic added for every
  subcontractor-side string (they were English in `ar.json`), the keys the
  web referenced but never defined (CurrentEmployee label + hint, paid
  invoices, payments-due labels…), the plural forms, and descriptions that
  still mentioned Payroll. Toasts: "Invoice recorded." / "Subcontractor
  invoice recorded.".

**App**
- The subcontractor side gains the invoice-copy button (Sub Payments Due,
  Paid Sub Invoices) and its approval queue (`/financial/sub-payments-review`,
  shared `PaymentsReview` component); `financialSides.js` drops
  `canOpenInvoiceFile`/`hasReviewQueue`. Ready for sub invoice gets the read
  guard. The two redirect screens stay, for notifications already delivered.
- The same Arabic subcontractor strings as the web.

**Verified** (dev DB, throwaway "Zz FX" data, the notifying permission groups
pointed at test-only roles and restored identically, 0 notifications to anyone
else, 0 residue, the Cloudinary file deleted): API — the 307 h/306 h boundary,
the other coordinator's 403, the queue gate, blank EOSB overrides → SAR
10,500; web (browser) — a sub invoice recorded with number, date and PDF and
confirmed stored, its copy downloaded, a sub payment recorded, shown in the
new queue, approved, allocated (Paid Sub Invoices: Partial), a client invoice
recorded, the EOSB form with blank boxes → SAR 10,500, the 306 h warning
boundary in Riyadh time, Expenses in Arabic; app (emulator) — Sub Payments
Due with the review count, the invoice copy opened in the phone's viewer, the
sub queue, a rejection with a reason. Server lint + 51 tests, web lint +
build, app lint, every new key in en + ar.

**Still open (not changed — your call)**
- The Dashboard's Standby-analysis widget (web and app) is shown only to
  holders of the `payroll` Section Access key, which was deleted with Payroll
  — so nobody sees it. It needs a real key chosen.
- The Arabic files call a Deployment "عملية النشر" (the software sense of
  "deployment") throughout both apps; "التعيين" would be the staffing sense.
  A terminology change across ~40 strings.

## M6 — COMPLETE (2026-10-08): workforce records

No server change — every screen uses the web's existing endpoints.

### Navigation

- **Workforce** gains Employees and Outsourced (both 'employeeCreate' Read,
  like the web). **Sales & Clients** gains Clients ('clientsManage') and
  Subcontractors ('subcontractorsManage'). **Admin & Tools** gains Documents
  ('documentsManage') and Assets ('assetsManage'). The dashboard's Active
  clients/subcontractors tiles and Expiring documents rows open these screens.

### Screens

- **Employees** — list (search name/ID/mobile, status, type, sort, "Expiring
  documents", a Manager's "My team", pages; each card shows the worst
  identity-document state), new (always an internal 'Own' record), edit (the
  type picker stays for an existing Outsourced/Subcontracted record; a
  Coordinator is never offered 'Own'), and the **profile**: overview, the login
  card (Admin/HR, 'Own' only — create with a role, one-time temporary password
  in a sheet that can be shared, reset password, change role), placements,
  assigned assets, the five identity documents plus extra ones with expiry,
  uploaded documents, emergency contact, notes; Calculate EOSB, Edit, Delete.
- **Outsourced employees** — Freelancers and subcontractors' workers: list,
  new, record (form; read-only without Write) with its documents (upload with a
  title and optional expiry, open, delete). A full Iqama fills the worker in
  from past mobilisations and shows their last billed/paid rates.
- **Clients** — list (refreshes every 20 s; Review for a pending client the
  viewer may decide), new, edit, and a profile with tabs: Overview (approval
  banner with the reviewer's note, details, sites), Workers (active
  placements, by worker type) and Documents.
- **Subcontractors** — list with an add/edit sheet and delete.
- **Documents** — company-wide list (search, owner type, category, "Expiring
  soon", upload with the owner picked); tap one for its versions (each opens
  in the phone's own viewer), upload a new version, delete. The same document
  list sits on every employee and client profile with the owner fixed.
- **Assets** — list (search, category, status); tap one for its history and
  the actions its status allows (assign, return, maintenance, available, edit,
  retire, delete), each with its own sheet.
- New shared pieces: `InitialAvatar`, `DocumentItem`/`DocumentUploadSheet`/
  `DocumentsCard`, `ClientApprovalBanner`, `formatFileSize`, an `asset` icon.

### Decisions

- Documents open in the phone's viewer rather than an inline preview (as for
  every file since M3).
- The employee list's photo avatar isn't ported: the server never sends
  `photoUrl`, so the web's photo branch never shows (the initial letter does).
- The client form includes **credit limit days** (the web's form loses it —
  below). The employee profile shows an 'Own' employee's placements when they
  have any (the web hides the panel for every 'Own' employee, though an Own
  employee with a Worker login is mobilised like anyone else).
- Edit on a client needs Write on 'clientsManage' (the server's own gate); a
  Coordinator holding it edits only their own unapproved client.
- The profile cards (placements, assets, documents) show only to whoever may
  read them, instead of a permanent "Loading…" or an error.

### Found and fixed on the emulator

- The approval-workflow picker in the employee form crashed with "no queryFn":
  the app's approvals API had no `listApprovalWorkflows`. Added.
- A document with no expiry date read "No number · expires" with nothing after
  it; the expiry is now shown only when set.
- In Arabic, the Change role / Reset password buttons clipped their labels to
  one word in a half-width button; they are stacked full width now.

### Web issues found (not fixed here — for a separate change)

- **Client form drops "Credit Limit Days"**: `clientFormSchema` has no
  `creditLimitDays`, so Zod strips what's typed and a client's credit days can
  never be set from the web (the server accepts it).
- **Employee profile shows "Contract Start Date" twice** (a duplicated block
  in `EmployeeProfilePage.jsx`).
- **Edit button offered to a Coordinator without the grant**: `canEditClient`
  ignores the Section Access the server's PATCH route requires — the save then
  fails with a 403.
- **Placements panel hidden for every 'Own' employee** even when an Own
  employee with a Worker login has been mobilised.
- **Assigned-assets panel shows "Loading…" forever** to someone without Read on
  'assetsManage' (the request is refused and `data` stays undefined).
- **Assets page is entirely hard-coded English** (no `staffAssets` keys at all);
  the employee form's "Additional Documents" block, the Subcontractor modal's
  "Company / Legal & Address" headings and the login panel are too.
- Outsourced form: no client-side check of the Saudi phone format the server
  enforces (the error only comes back from the server).
- The employee list's `photoUrl` branch is dead (never sent).

### Verified

- Android 15 emulator (Expo Go), dev database, as a test Admin (and API checks
  as a test Coordinator holding only 'clientsManage'): an employee created with
  validation (a blank extra-document name stops it), a login created (one-time
  password sheet) and its role sheet opened; a client rejected with a note, its
  profile (banner, tabs), edited with a bad then good VAT number and a site; a
  document opened in the phone's PDF viewer, with its versions sheet;
  an asset assigned (employee picker with search), shown on the employee's
  profile, returned; an outsourced freelancer created, its documents card;
  subcontractor edit sheet pre-filled; the Workforce hub; Arabic/RTL on the
  profile, Assets and the return sheet. API: a Coordinator's client starts
  Pending; no grant → 403 on employees, assets, subcontractors; an invalid
  subcontractor phone → 400; a duplicate asset tag → 409; clearing a field
  really clears it. Lint clean, the Android bundle builds, all 1,788 keys used
  exist in en + ar.
- Not exercised: a Coordinator login on the phone (permissions checked through
  the API), picking a file through Android's picker for a document upload
  (the same attachment field and upload code as the M3/M5 receipts; the
  document itself was uploaded through the API), the Iqama autofill (the same
  lookup Mobilisation's form uses) and dark mode.
- **Cleanup**: the test users, role, employee and its login, clients,
  subcontractor, outsourced worker, asset and its assignment, the document and
  its Cloudinary file, notifications, tokens, audit rows; the section grant I
  added was removed (identical to the saved copy). No real person was
  notified (the only notification, the client decision, went to the test
  Coordinator).

## M6 web-fix pass (2026-10-08)

The web issues M6 flagged are fixed in `client/` (no server change):

- **Client form kept dropping "Credit Limit Days"** — `clientFormSchema` had no
  `creditLimitDays`, so Zod stripped it. The schema now keeps it (whole days,
  blank leaves the server's default). Verified: typing 45 and saving stores 45.
- `canEditClient` now needs Write on `clientsManage` (the route's own gate); a
  Coordinator holding it still edits only their own unapproved client.
- The duplicated "Contract Start Date" row on the employee profile is gone.
- The placements panel shows for an internal ("Own") employee once they have
  actually been placed (an Own employee with a Worker login is mobilised like
  anyone else); it also shows nothing — not a false "not deployed" — to a viewer
  the server refuses the list to.
- The assigned-assets panel no longer says "Loading…" forever to someone
  without Read on `assetsManage`.
- The Assets page, the login panel, the employee form's "Additional Documents"
  block and the Subcontractor modal's headings are translated (English and
  Arabic, `staffAssets.*`, `staffEmployees.login.*`, …). The contract dates on
  the profile are translated too.
- The outsourced-employee form checks the Saudi mobile format before the round
  trip (it reuses the Mobilisation form's `SAUDI_PHONE_REGEX`).
- The employee list's dead `photoUrl` branch is removed.

Verified in the browser as a throwaway Admin (credit days saved, one
"Contract start date", no placements card for an unplaced Own employee, Assets
page in Arabic, the Saudi-phone error). Lint and build clean.

## M7 — COMPLETE (2026-10-08): admin tools

No server change — every screen uses the web's existing endpoints.

### Navigation

Admin & Tools now lists everything the web's hub does, with the web's guards:
Company Settings (no guard — the server decides), Section Access / Mobilisation
Settings / Locations (Admin), Team (`team` Read), Approval Hierarchy
(`approvalHierarchy` Read), Timesheet Processor (`timesheetProcessor`), NFC
Customers (`nfc`), Security Log (`auditLog`), Data Reconciliation
(`reconciliation`).

### Screens

- **Company Settings** — logo (gallery or camera, 2 MB; replace/remove), legal
  identity, contact, bank, signatory; read-only without Write. The web's ZATCA /
  invoice / payslip wording is not carried over (those modules are gone).
- **Section Access** (Admin) — category → module → Read/Write cards, approval
  roles as pills, per-card Save and "Save all changes (N)"; the phone's back
  button steps up one level before leaving. Only edited cards hold local state,
  so every other card shows the server's copy.
- **Team** — every login with its role and status; search; Admin alone can
  reset a password (one-time sheet, shared `TempPasswordSheet`, also used by the
  employee login card), deactivate/reactivate or delete — never their own.
- **Approval Hierarchy** — Roles and Workflows tabs; role sheet (name,
  description, members, active) and workflow sheet (ordered steps, each a pool
  of roles, default request types, active). Steps move with up/down buttons
  instead of dragging. Read-only for anyone without Write.
- **Mobilisation Settings** (Admin) — the stale-warning days (1–3650).
- **Locations** (Admin) — the shared site list; delete.
- **Security Log** — search by action, date range, pages; a compact card per
  entry. **Data Reconciliation** — the standing integrity report; a finding
  opens its record.
- **Timesheet Processor** — employee, month/year, required hours, the
  attendance file from the phone's files (.xls/.xlsx), a tappable holiday
  calendar (Mark all Fridays), Process → summary + day cards, Export Excel
  opens the workbook through the phone's share sheet.
- **NFC** (5 screens) — companies (search, add), company page (details, people
  with their card and 30-day taps, add/edit/remove a person with photo, assign
  or change a card, export CSV), cards (search, status/company filters,
  generate a batch and share its CSV), card (both QR codes shown and shareable,
  public link share/open, chip UID, history, activity, lifecycle: unassign,
  lost, return, disable, rotate token, delete), and Activity (7/30/90/365 days).
- New shared pieces: `TempPasswordSheet`, `ImagePickerField`,
  `InitialAvatar` (optional photo), `actionVariant` in `auditActions.js`, a
  `mobile.admin.*` and `mobile.nfc.*` translation set (en + ar).

### Decisions

- The file POST download (`openAuthedPostFile`) now goes through the axios
  client, not `fetch`: Expo's fetch cannot send a FormData holding a picked file
  ("Unsupported FormDataPart implementation", found on the emulator), and axios
  also refreshes an expired token and times out on its own. The monthly report
  export (a JSON POST) was re-checked on the same path.
- The URL of an NFC card is shared with the phone's share sheet (it includes
  Copy) instead of adding a clipboard dependency.
- `Sheet` pads the bottom of its scroll area: the last ~25 px of a long form
  (its Save button) was cut off — this also fixes the M3–M6 sheets.
- The Locations/Company logo screens never alter a logo that exists on the dev
  database during tests (company logo is a real asset), so the logo upload
  itself was not exercised.

### Found and fixed on the emulator

- The Approval Hierarchy intro read "Description": a duplicate translation key
  (the form label overwrote the page text).
- The Timesheet file hint showed a raw `{{maxMb}}`.
- Timesheet export failed (the fetch/FormData issue above).
- Long sheets cut off their last buttons (above).
- A button labelled exactly "Add company" painted only "Add" on the emulator
  (the full text was in the accessibility tree) — a Text-measure quirk specific
  to that string; the label is "New company".

### Web issues found (not fixed here — for a separate change)

- **Company Settings page still promises features that no longer exist** — "ZATCA
  QR code is active on your invoice PDFs", bank details "shown as payment
  instructions on an unpaid invoice", a logo hint listing invoices, quotations
  and payslips. Only EOSB settlements and certificates (and the exported
  timesheet) use the letterhead now; nothing prints the bank details.
- Data Reconciliation's web label map still carries `payrollRunMismatch`
  although the server no longer emits it.
- Nav item "Approval Hierarchy" reads "التسلسل الاعتماد" in Arabic (the existing
  key is ungrammatical); the weekly-off select on the employee form is English
  only.
- The employee pickers (Timesheet Processor, Assets, EOSB) list only the first
  100 employees by name, so with more than 100 an employee near the end of the
  alphabet cannot be chosen.

### Verified

- Android 15 emulator (Expo Go), dev database, as a throwaway Admin and as a
  throwaway Coordinator holding only a few Read grants: every screen opened;
  Team reset password (one-time sheet) / deactivate / reactivate / delete on a
  throwaway login; a role and an inactive workflow created; a section grant
  added and saved (Ramadan Periods); a location deleted; the mobilisation
  threshold validated and saved; an NFC company, person and 2-card batch created,
  a card assigned, its two QR codes loaded, lost/rotate/unassign/delete run, the
  batch CSV opened in the share sheet; a real .xlsx processed (holidays, summary,
  day rows) and exported; Arabic/RTL on Approval Hierarchy, NFC activity and
  Company Settings. The Coordinator saw exactly the tiles it holds, no add/
  edit/manage buttons, a read-only Company Settings, and "no access" on the
  Admin-only, Security Log and Timesheet screens. Lint clean, imports resolve,
  every translation key exists in en + ar, the Android bundle builds.
- Not exercised: picking a photo for an NFC person/company or the company logo
  (same upload code as the avatar), a `.xls` (only `.xlsx`), dark mode.
- **Cleanup**: test logins, roles, workflow, location, NFC company/person/batch/
  cards, employee, notifications, tokens, audit rows; section grants identical to
  the saved copy; mobilisation and company settings restored to the saved
  documents; counters unchanged. No notification went to anyone (0).
