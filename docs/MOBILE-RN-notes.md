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
