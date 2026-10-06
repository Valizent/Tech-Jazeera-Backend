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
  once; if the direction still hasn't applied (happened in Expo Go switching
  Arabic → English), it asks the user to close and reopen the app instead of
  reloading forever.
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
