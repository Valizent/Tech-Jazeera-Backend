# Native Android app via Capacitor

A post-Phase-3 addition, not part of any phase-numbered plan. `docs/PHASE3-PLAN.md`
explicitly decided to stay on the installable PWA rather than build a native
app ("one codebase, ships immediately, reuses everything Phase 1/2 built"),
flagging two accepted limitations at the time: WebAuthn-not-real-biometrics,
and best-effort (browser-API) geofenced GPS for Worker self-attendance. The
user later asked for a real installable app. React Native was considered and
rejected after a cost comparison (full rewrite of 15+ already-built feature
modules' UI, permanent double-maintenance of two UIs forever after) —
**Capacitor** wraps the existing React/Tailwind web app in a native shell
with near-zero UI rework, directly reusing everything already built, and
closes the exact geofence-GPS gap the original PWA decision flagged.

## What was built

**New — `client/android/`** (Capacitor-generated Android Studio project,
committed): debug-only cleartext network config and Mixed-Content override
for local dev, a hand-edited `MainActivity.java` (cookie/CapacitorHttp
config below), generated launcher icons/splash (light + dark, all
densities) from the existing `public/icon-512.png`, a release signing
config wired to a gitignored `keystore.properties`.

**New — `client/ios/`** (Capacitor-generated Xcode project, committed,
**scaffold only** — `AppDelegate.swift`, `App.xcodeproj`, `Info.plist`, a
`CapApp-SPM` Swift package for plugins). No Mac was available in this
environment, so it has never been built or run — picked up as a separate
effort whenever Mac access exists.

**New — `client/src/lib/useDeviceLocation.js`**: one shared hook wrapping
`@capacitor/geolocation`, replacing 3 near-duplicated
`navigator.geolocation.getCurrentPosition()` call sites (Worker ESS
self-punch, Staff Sign In/Out self-punch, Admin's office-geofence setup
"use my current location" button). Falls back to the browser API
automatically on plain web, so the same code path runs on native and web.

**Changed — backend, for the Capacitor origin**: `server/src/config/env.js`,
`app.js`, `middleware/originGuard.js` (CORS + the CSRF trusted-origin guard,
both now check membership in a list instead of exact-matching one string),
`modules/auth/auth.controller.js` (refresh-token cookie now has `maxAge`).

**Changed — `client/capacitor.config.json`, `client/.env`,
`client/android/app/src/main/AndroidManifest.xml`** — see below.

No changes to any other server module, and no changes to the web app's own
behavior beyond the CORS/cookie fixes (which also apply to it, see below).

## Key decisions & why

- **Everything lives inside `client/`**, not a separate top-level folder.
  Capacitor's own model is "add native shells to an existing web project" —
  a sibling folder would just add indirection (`webDir: '../client/dist'`,
  a second `package.json`) for no benefit, since this is one web app
  getting one native shell.
- **`capacitor.config.json`, not `.json`'s usual `.ts` sibling.** Capacitor's
  CLI can read either, but a `.ts` config requires TypeScript installed in
  the project to parse it — this is a deliberately pure-JS codebase, so
  adding TypeScript for one config file wasn't justified. Discovered via a
  real build failure (`Could not find installation of TypeScript`), not
  planned in advance.
- **Android app ID: `com.aljazeera.crm`**, confirmed with the user before
  scaffolding — permanent once real installs/signing exist, so not
  something to guess.
- **`CapacitorHttp: { enabled: true }` in `capacitor.config.json` is
  required, not optional.** This was the single hardest thing in this
  whole effort to pin down. A Capacitor Android WebView's default
  networking (plain Chromium fetch/XHR) does **not** reliably deliver a
  cross-origin `Set-Cookie` response into `android.webkit.CookieManager` on
  this Android/WebView combination — confirmed by direct Java-level
  diagnostics (`CookieManager.getCookie()` returned `null` immediately
  after a successful login, in the same live process, with `acceptCookie`
  and `acceptThirdPartyCookies` both already `true`). Re-enabling
  `CapacitorHttp` (Capacitor's native OkHttp-based request path, paired
  with its `CapacitorCookies` companion plugin, which explicitly bridges
  cookies between native responses and the WebView's cookie jar) fixed it
  immediately and reproducibly. The original plan had this flagged only as
  a "wider blast radius" fallback to try if the simpler fix didn't work —
  testing showed the simpler fix alone never works for this specific
  scenario, so this is the real, required configuration, not a fallback.
- **The refresh-token cookie now has `maxAge`** (`auth.controller.js`,
  matching `REFRESH_TOKEN_TTL_DAYS`). Without it, the cookie is a *session*
  cookie — fine in a normal desktop browser tab (a "session" rarely
  meaningfully ends there), but a Capacitor app's process **is** its
  session boundary, so even a graceful app close discarded it. This was a
  real, independent bug found via testing (not the `CapacitorHttp` issue) —
  the cookie store was completely empty even mid-process, before that fix,
  regardless of persistence timing. Fixing it also quietly improves the
  *web* app: staff no longer get logged out just from fully closing their
  browser.
- **Mixed Content is force-allowed, debug builds only.** The WebView's own
  origin is HTTPS (`server.androidScheme: "https"` — kept HTTPS rather than
  HTTP because several web APIs assume a secure context) but a local dev
  backend has no HTTPS certificate set up. Chromium blocks an HTTPS page
  calling a plain-HTTP endpoint by default, independent of the cleartext
  network-security config (which only controls whether plaintext is
  permitted at all, not whether a secure page may call it). Guarded by a
  runtime `ApplicationInfo.FLAG_DEBUGGABLE` check (not Gradle's
  `BuildConfig.DEBUG`, which needed a `buildFeatures.buildConfig` opt-in
  this project doesn't otherwise need) so it can never affect a release
  build, which always points at a real HTTPS backend.
- **`@capacitor/geolocation`'s Android permissions needed a manual
  `AndroidManifest.xml` edit.** The plugin's own manifest ships empty —
  permissions are requested via a Kotlin `@CapacitorPlugin(permissions=...)`
  annotation, which handles the *runtime* prompt but does not add the
  required `<uses-permission>` declarations a manifest still needs for that
  prompt to be requestable at all. This contradicted the original plan's
  assumption that they'd merge in automatically; found by testing, not
  read in advance from the (correct, but incomplete) plugin docs until
  after the gap showed up.
- **CORS/CSRF changed from one exact origin to a list.** `CLIENT_URL` is
  now comma-separated (`requiredList()` in `env.js`); `app.js`'s `cors()`
  gets the array directly (the `cors` package reflects back only the
  matched origin, never `*`, so credentialed cookies keep working);
  `originGuard.js`'s CSRF check does membership instead of equality. Also
  corrected a comment in `originGuard.js` that claimed "a mobile app has no
  ambient cookie jar" — a Capacitor WebView demonstrably does have one and
  does send a real `Origin` header, so it correctly goes through the
  trusted-origin check now, not the no-`Origin` bypass meant for genuine
  non-browser clients like curl.
- **Release signing via a gitignored `keystore.properties`**, with a
  committed `keystore.properties.example` documenting the exact format.
  The user generated the keystore themselves (`keytool`, this app never
  invents credentials) and filled in the real file directly rather than
  telling me the password, keeping it out of this conversation as much as
  practically possible.
- **Geolocation swap included in this same effort, not deferred** — it's
  the concrete thing named as an improvable PWA limitation when native was
  first considered, it was low-risk (the server-side geofence check in
  `attendance.service.js`'s `verifyOfficeLocation()` only ever consumed
  `{lat, lng}` numbers, agnostic to source — zero server changes needed),
  and the 3 call sites were simple, near-identical wrappers around the
  browser API being replaced.
- **iOS gets a scaffold, not a build.** Genuinely can't be built or run
  without a Mac — committing the structure now means it's ready the moment
  Mac access exists, without pretending it's been verified.

## Production deployment (discovered mid-Milestone-7)

Partway through signing/release work, it turned out the user had already
stood up real infrastructure independently: an Oracle Cloud Ubuntu VM
(Saudi Arabia region) running the backend under PM2, fronted by Caddy for
automatic HTTPS via Let's Encrypt on a DuckDNS domain
(`techjazeera.duckdns.org`), MongoDB Atlas as the database, GitHub Actions
auto-deploying on push, and the web client on Cloudflare. This meant the
release APK's verification could — and did — target the real production
backend rather than only the local dev sandbox:

- `client/.env`'s `VITE_API_URL` was pointed at
  `https://techjazeera.duckdns.org/api` for the release build (this is
  baked in at `npm run build` time, same as any Capacitor build target
  change — rebuilding for local dev again means switching it back).
- The backend fixes above (multi-origin CORS, cookie `maxAge`) had to
  actually be deployed — the user committed and pushed them themselves
  (this session did not push to the production-deploying repo without that
  explicit decision), and separately added `https://localhost` to the
  production `CLIENT_URL` env var and restarted PM2.
- Both changes were verified live via curl before testing through the app:
  server uptime reset to ~4.5 minutes (confirming a fresh deploy) and the
  CORS preflight response correctly reflected `Access-Control-Allow-Origin:
  https://localhost`.

## Verified (2026-08-31)

**Milestone-by-milestone, each with a real device/emulator check:**

- **Scaffold**: first debug APK built, installed on a genuinely booted
  Android emulator, launched to the real login screen (same Tailwind UI,
  logo, dark-mode toggle, language switcher) with working client-side Zod
  validation — confirming JS execution, not just static rendering.
- **Icons/splash**: real teal adaptive launcher icon (no default
  placeholder, no cropping), real splash screen matching the manifest's
  theme colors, light + dark variants, generated for every density.
- **Backend CORS/cookie fix** (the hardest milestone): curl-verified the
  origin guard accepts `https://localhost`, still accepts the existing web
  origin, still rejects `https://evil.com` — with real
  `Access-Control-Allow-Origin` headers confirming each case, not just
  status codes. After the `CapacitorHttp` fix, confirmed via a pulled
  `Cookies` SQLite file that `refreshToken` was present with
  `is_persistent: 1`. Full round trip: login → `am force-stop` → relaunch
  → authenticated dashboard with zero re-login, reproduced on a clean
  uninstall/reinstall.
- **Geolocation**: real native Android permission dialog appeared
  ("Allow Al Jazeera ERP to access this device's location?" with
  Precise/Approximate and While-using/Only-this-time/Don't-allow options);
  granted it; set a mock GPS location via `adb emu geo fix`; the office
  geofence settings form populated with the exact mock coordinates,
  proving the full chain (permission → native GPS → hook → UI) works.
  Confirmed the real company office-location record was **not** overwritten
  (the test coordinates were never saved; verified via a direct API call
  afterward that the original value was untouched).
- **iOS scaffold**: file listing confirmed sane (`AppDelegate.swift`,
  `App.xcodeproj`, `Info.plist`, `CapApp-SPM`) — no build possible, by
  design.
- **Signed release build**: `apksigner verify --print-certs` confirmed the
  APK is signed with the real release certificate (DN matches exactly what
  was entered during `keytool` generation). Installed clean, logged in
  against real production over genuine HTTPS, and — the definitive test —
  survived `am force-stop` + relaunch with the session intact, against the
  live server, not a local sandbox.

**Known gaps, accepted rather than chased:**
- A real file upload (native Android file picker) and a real PDF Blob
  download were not regression-tested under the new `CapacitorHttp`
  networking path — automating Android's system file picker wasn't
  justified for this, and creating a throwaway payroll/invoice record to
  force a downloadable PDF would have meant writing fake records into the
  real production database. `CapacitorHttp`'s FormData/Blob support is a
  core, heavily-used feature of the plugin, unlike the cookie edge case
  that needed real chasing — accepted as lower-confidence rather than
  forced.
- Testing on a second physical device (beyond the one emulator available
  in this environment) was not done.
- The real "Annual Leave" LeaveType shows `isPaid: false` in the UI —
  noticed while verifying the app, unrelated to this work, pre-existing
  production data. Flagged for the user to check, not changed.

**Client build**: `npm run build` — clean throughout, including after every
change in this effort.

**Cleanup**: every screenshot, UI-hierarchy dump, and scratch file created
during verification was deleted from the repo after use (never committed).
The throwaway `capacitor-test-admin@example.com` login used for testing
was **not** deleted at the end of this effort — it's still in the shared
database, since production testing may still need it. Delete it (and its
refresh tokens/audit-log rows) via the same temporary-script pattern used
elsewhere in this project once it's no longer needed.

## Rebuilding / re-signing (for future reference)

```bash
# Debug build, local dev backend
cd client
# .env: VITE_API_URL=http://10.0.2.2:5000/api  (Android emulator) or a LAN IP for a physical device
npm run build && npx cap sync android
cd android && ./gradlew.bat assembleDebug
# output: android/app/build/outputs/apk/debug/app-debug.apk

# Release build, real backend
cd client
# .env: VITE_API_URL=https://techjazeera.duckdns.org/api
npm run build && npx cap sync android
cd android && ./gradlew.bat assembleRelease
# output: android/app/build/outputs/apk/release/app-release.apk
# requires client/android/keystore.properties to exist (gitignored, see
# keystore.properties.example) — confirmed by testing that Gradle fails
# loudly and clearly if it's missing ("SigningConfig 'release' is missing
# required property 'storeFile'"), not a silent unsigned-APK fallback.
```
