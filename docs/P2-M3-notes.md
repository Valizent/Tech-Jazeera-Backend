# P2-M3 — Installable PWA + geofenced self-attendance

Two independent, unblocked pieces from a larger request (geofenced attendance
→ signed multi-level timesheet approval → installable app). The signature/
timesheet half waits on a template example the user will provide; this
milestone is everything that didn't need it.

## What was built

**PWA installability**
```
client/public/manifest.webmanifest   # NEW — name, icons, standalone display
client/public/sw.js                  # NEW — minimal service worker (install
                                      #   criteria only, deliberately no caching)
client/public/icon-192.png, icon-512.png, apple-touch-icon.png, favicon-32.png
                                      # NEW — generated from an SVG matching
                                      #   the existing sidebar "AJ" mark
client/index.html                    # + manifest/icon links, theme-color
client/src/main.jsx                  # + service worker registration
```

**Geofenced self-attendance**
```
server/src/utils/geo.js              # NEW — haversine distance()
server/src/modules/attendance/officeLocation.model.js  # NEW — singleton geofence config
attendance.model.js                  # + source/verifiedBy/selfMarkLocation,
                                      #   + checkInTime/checkOutTime/hoursWorked
attendance.service.js                # + getOfficeLocation/setOfficeLocation/selfPunch;
                                      #   markBulk now explicitly asserts source:'staff'
                                      #   and clears any in-progress check-in/out
attendance.validation.js, .controller.js, .routes.js
                                      # + office-location CRUD (Admin), self-punch schema
modules/me/*                         # + POST /me/attendance/punch, GET /me/attendance
client/.../attendance/components/OfficeLocationSettings.jsx  # NEW — Admin geofence config
client/.../attendance/components/RecordsGrid.jsx     # + self-marked indicator dot;
                                      #   completed shifts show hours worked instead of "P"
client/.../ess/pages/MyAttendancePage.jsx            # NEW — Worker's Sign in/Sign out buttons + history
client/.../app/layouts/EssLayout.jsx, router.jsx     # + My Attendance nav/route
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET/PATCH | `/api/attendance/office-location` | Admin | view/set the geofence (lat, lng, radius, allowed IPs) |
| POST | `/api/me/attendance/punch` | Worker | Sign in/Sign out buttons — first punch of the day checks in, every one after pushes `checkOutTime` forward and recomputes `hoursWorked` — 403 if outside geofence and off the allow-listed IPs |
| GET | `/api/me/attendance` | Worker | own history, last 30 days by default |

## Key decisions & why

- **"Connect to company WiFi" isn't buildable as literally stated.** Browsers
  (Chrome, Safari, on every platform) deliberately don't expose which WiFi
  network a device is on. The real mechanism is GPS geofencing (Haversine
  distance to a configured office point), with an office-IP allow-list as a
  secondary check — closer to "your traffic is coming from the office
  network" than "connected to office WiFi," but the closest honest
  equivalent. Confirmed with the user before building.
- **Server decides, client only collects.** The browser's Geolocation API
  hands over raw lat/lng; the server computes the distance and makes the
  call. The client never claims "I'm in range" — consistent with the
  project's "never trust the client" rule for anything that gates a written
  record (same discipline as quotation totals, leave eligibility).
- **Staff always wins.** If HR has already set today's status, a Worker's
  punch is rejected (409) rather than silently overwritten — matches the
  "self-punch is primary, staff marking is backup/override" decision.
  Caught a real bug here: `markBulk` (the pre-existing M7 function) never set
  `source`, so re-marking a previously self-marked day silently left
  `source: 'self'` in place and the protection never triggered. Fixed by
  having `markBulk` explicitly assert `source: 'staff'` on every write — and
  now also clear `checkInTime`/`checkOutTime`/`hoursWorked`, so a staff
  override can't leave a stale open shift behind either.
- **`checkInTime` is fixed at the first punch of the day; `checkOutTime`/
  `hoursWorked` are recomputed on every punch after that — deliberately not a
  strict open/closed shift.** A worker can press Sign in, then Sign out, then
  Sign in again, any number of times in a day, and none of it errors; only
  the first and last punch end up mattering for `hoursWorked`. (An earlier
  version modeled a single open/closed shift that couldn't be reopened once
  closed — replaced because "sign out then sign in again the same day"
  needed to just work, not 409. **Known, accepted limitation**: because only
  first/last count, an unaccounted gap between punches is invisible —
  `hoursWorked` will include it.) The manager Records grid shows the computed
  number (1dp) instead of the plain "P" once at least two punches exist for
  the day; it still shows the plain letter for staff marks, non-Present
  statuses, and a day with only one punch so far.
- **Every punch is gated by the same geofence/office-IP check**, not just the
  first. Both ends of a shift need to be verified — otherwise a worker could
  sign in at the office and sign out from anywhere, hours and all.
- **IP allow-list is exact-match, not CIDR.** Covers the common case (one
  business ISP connection with a stable public IP) without the complexity of
  real subnet parsing. Documented as a known limitation, not a silent gap.
- **Office location is a singleton**, not a per-site list — no multi-office
  need was stated. Extending to multiple sites later is additive, not a
  redesign.
- **Service worker does no caching.** Chrome's install prompt only requires
  a *registered* service worker with a fetch handler — it doesn't need to
  cache anything. Adding a caching strategy for an app that ships new
  milestones this often would risk serving stale JS/API responses, a worse
  bug than "no offline support." If offline use is wanted later, that's a
  deliberate follow-up, not a side effect of installability.

## Deferred (waiting on the user's timesheet example)

- Multi-level signed approval workflow (Employee verifies → signature →
  BDM/Manager approves → signature → next-level Manager approves → signature)
- The `BDM` role itself — confirmed as a genuinely new role, but where it
  sits relative to Manager (above/below/parallel) wasn't needed for this
  milestone and is still open
- Per-user stored signature image (upload + storage)
- The timesheet document itself — format not yet provided

## Verified (2026-08-25)

**curl**: office-location CRUD (Admin-only, 403 for Worker) · self check-in
rejected 403 with distance shown when outside geofence and IP doesn't match ·
self check-in succeeds via GPS when inside the radius (`verifiedBy:
'geofence'`) · self check-in succeeds via IP match even with GPS far away
(`verifiedBy: 'officeIp'`) · staff-set record blocks a self check-in attempt
(409) — bug found and fixed here (`markBulk` wasn't asserting `source`) ·
own attendance history returns correctly scoped records.

**Browser**: PWA manifest fetches 200, service worker registers with correct
scope, all four icon sizes serve 200 · Admin's Office Location tab loads and
saves the geofence, "Use my current location" fills coordinates · staff
Records grid shows a distinguishing dot on self-marked cells with an updated
tooltip and legend entry · Worker's My Attendance page: no-record state shows
the Mark button, clicking it (GPS unavailable in the test environment, fell
through to the office-IP path) succeeds and shows "Verified by office
network," today's status card and history both update correctly.

**Cleanup**: throwaway Admin/Worker accounts, the test employee, its
attendance record, and the test office-location config (placeholder Riyadh
coordinates, not the real office) were all deleted — the real office location
still needs to be entered by an Admin via the new settings tab.

## Verified again (2026-08-25) — check-in/check-out + computed hours

The self-mark flow above was replaced with sign-in/sign-out + `hoursWorked`,
per the user's follow-up request ("one more button... calculate the hour he
worked... mark that hour in the attendance record of manager, instead of just
P"). By this point the real office location had been configured by the user
(`Al Jazeera Service Contracting co.`, radius 100m) — verification below used
those real coordinates to pass the geofence check, but never wrote to or
altered the office-location config itself.

**curl** (throwaway Worker + Employee, deleted after): check-in at the real
office coordinates succeeds, `checkInTime` set, `checkOutTime`/`hoursWorked`
null · check-in while already signed in → 409 · check-out from ~392km away →
403 with distance shown (same gate as check-in) · check-out at the office →
200, `hoursWorked` computed correctly from the elapsed time · check-out again
with nothing open → 400 · check-in again after completing today's shift → 409
· check-in with no auth token → 401 · check-in as Admin (wrong role) → 403 ·
staff bulk-marking the same day correctly clears `checkInTime`/`checkOutTime`/
`hoursWorked` back to null and flips `source` to `'staff'` — confirmed via
the same `GET /api/attendance` the Records grid uses.

**Browser** (same throwaway Worker, mocked `navigator.geolocation` to the
office coordinates): My Attendance page's three states all render correctly
— no-record ("Sign in" button) → checked-in ("Signed in at HH:MM" + "Sign
out" button) → completed ("Today: Present · X hrs", check-in/out times,
verification method); history list shows hours per day. Logged in as Admin,
Records grid's cell for the completed day showed the computed hours (e.g.
"0.0") instead of "P", correctly colour-coded and still carrying the
self-marked dot and an updated tooltip (`Present · 0.0 hrs · self-marked`).

**A stale `node src/server.js` process (no `--watch`) was already holding
port 5000** from an earlier session when this work started — it couldn't
have picked up the route changes. Killed and restarted with `npm run dev`
per the CLAUDE.md environment note; this may have interrupted another
concurrent session pointed at the same port.

**Cleanup**: the throwaway Worker/Employee/Admin, their attendance record,
refresh tokens, and audit-log rows were all deleted; the temporary Mongo
cleanup script was removed afterward. The real office-location config was
read but never modified.


## Physical NFC tap points — built, then reverted (2026-08-25 to 2026-08-26)

A follow-up request explored letting a Worker tap a physical NFC tag per
room to sign in/out, instead of only the in-app buttons — including a
"first tap/last tap of the day" model to support moving freely between
multiple rooms during a shift. It went through three real design iterations
(a toggle on open-shift state, then a fixed direction per tap point, then a
first-punch/last-punch model with no errors ever) before the user decided
the added complexity — a dedicated `TapPoint` model, Admin CRUD, physical
chip provisioning, a public `/tap/:token` route with its own login-redirect
handling — wasn't worth it for what the in-app Sign in/Sign out buttons
already covered. Reverted in full: the `TapPoint` model, its two production
records (`Discussion Room In`/`Discussion Room Out`), the tap-point CRUD
endpoints, the `/me/attendance/tap` endpoint, the `/tap/:token` client route
and its `TapPage`, the Admin `TapPointsSettings` UI tab, and the
login-redirect (`?next=`) plumbing that only existed to support it.

**What was kept**: the `selfPunch()` model itself — first punch of the day
checks in, every punch after that pushes `checkOutTime` forward and
recomputes `hoursWorked`, no errors for punching multiple times — survives
in the in-app Sign in/Sign out buttons (`POST /api/me/attendance/punch`). It
turned out to be the right design for the buttons regardless of whether
physical tags were ever in the picture: it's what makes "sign out for lunch,
sign back in" just work.

If a tap-based flow is ever wanted again, the design history above (three
iterations, why each one failed) is worth reading before rebuilding it from
scratch — check git log for this file and the commit(s) around this revert.
