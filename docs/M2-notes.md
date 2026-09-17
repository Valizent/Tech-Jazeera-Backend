# M2 — Authentication & RBAC

## What was built

```
server/src/
├── middleware/
│   ├── auth.js               # requireAuth — verifies Bearer token, loads req.user
│   ├── rbac.js               # requireRoles('Admin', ...) — 403s wrong roles
│   ├── validate.js           # Zod gate: validates + sanitizes body/params/query
│   └── rateLimiter.js        # + loginLimiter (30 attempts / 15 min / IP)
├── modules/
│   ├── auth/
│   │   ├── user.model.js     # staff accounts + exported ROLES list
│   │   ├── refreshToken.model.js  # one doc per live session; TTL auto-expiry
│   │   ├── auth.validation.js
│   │   ├── auth.service.js   # login / refresh (rotation + theft detection) / logout
│   │   ├── auth.controller.js# HTTP + cookie handling only
│   │   └── auth.routes.js
│   └── audit/
│       ├── audit.model.js    # append-only who-did-what log
│       ├── audit.service.js  # logAudit() helper + admin listing query
│       ├── audit.validation.js / audit.controller.js / audit.routes.js
└── scripts/seed-admin.js     # npm run seed:admin -- <email> <password> [name]
```

Roles: `Admin, Manager, HR, Operations, Accounts, Viewer`.

## How the token flow works (read this twice)

1. **Login** (`POST /api/auth/login`): password checked with bcrypt. Client
   receives a 15-minute **access token** (JSON body — kept in memory only)
   and a 7-day **refresh token** (httpOnly cookie — JS can never read it).
2. **Every API call** sends `Authorization: Bearer <access token>`.
   `requireAuth` verifies it and loads the user fresh from the DB, so
   deactivating someone locks them out within 15 minutes at most — usually
   instantly, since role/active checks happen per request.
3. **When the access token expires** the client calls `POST /api/auth/refresh`.
   The cookie's token is verified, its DB row is **atomically deleted**
   (`findOneAndDelete`), and a brand-new pair is issued. Each refresh token
   is single-use — that's *rotation*.
4. **Theft detection (with a grace window):** every browser tab shares ONE
   refresh cookie, so concurrent tabs race to refresh and the losers present
   an already-rotated token. A rotated token may therefore be re-exchanged
   for **30 seconds** (`REFRESH_REUSE_GRACE_MS`). Reuse AFTER that window
   means someone is replaying a stolen cookie long after its owner rotated
   it: delete ALL of that user's sessions, audit
   `auth.refresh.reuse_detected`, force re-login everywhere. (M3's page-load
   bootstrap under React StrictMode fires double refreshes — this window is
   what makes rotation coexist with real browsers.)
5. **Logout** deletes that one device's session row and clears the cookie;
   other devices stay logged in.

Why the DB stores only a SHA-256 *hash* of each refresh token: a database
leak must not hand out live sessions. (SHA-256 rather than bcrypt because the
token is already 512 random bits — nothing to brute-force — and lookups must
be deterministic.)

## The protected-route pattern (every future module copies this)

```js
router.get('/',
  requireAuth,                      // 401 — who are you?
  requireRoles('Admin', 'HR'),      // 403 — may you?
  validate({ query: someSchema }),  // 400 — is the input sane?
  asyncHandler(controller.list)     // finally, the work
);
```

Order matters: authenticate → authorize → validate → execute.

## How to modify it

- **Add a role:** edit `ROLES` in `user.model.js` — rbac, validation, and the
  enum all read from it.
- **Audit a new action:** `await logAudit({ user: req.user.id, action: 'employee.create', targetType: 'Employee', targetId: doc._id, ip: req.ip })`.
  Never put secrets or whole documents in `meta`.
- **Change token lifetimes:** constants at the top of `auth.service.js`.
- **Reset any password:** `npm run seed:admin -- email newpassword` (upserts).
  Note it always (re)assigns the Admin role — Phase 1 has no self-service reset.

## Common beginner mistakes

- **Storing the access token in localStorage.** Any XSS then steals it.
  Memory only (M3 does this correctly); the refresh cookie is httpOnly.
- **Putting `requireRoles` before `requireAuth`.** There's no `req.user` yet;
  our rbac fails loudly (500) so you notice in development.
- **Comparing passwords with `===`.** Always `bcrypt.compare` — hashes differ
  every time even for the same password (salted).
- **Different error messages for "no such email" vs "wrong password".**
  That's account enumeration. We return one identical 401 (and even burn a
  dummy bcrypt compare on unknown emails so timing doesn't leak it either).
- **Forgetting `credentials` on the client.** The refresh cookie only travels
  when Axios sends `withCredentials: true` AND CORS has `credentials: true`
  with an exact origin. Both are already configured.

## Debugging tips

- 401 everywhere? Your access token expired — refresh, or log in again.
- Refresh keeps 401ing? Check the cookie is being sent (browser devtools →
  Network → request → Cookies). Cookie path is `/api/auth` — it only travels
  to auth endpoints, by design.
- "Session invalidated" out of nowhere = reuse detection fired. Check the
  audit log for `auth.refresh.reuse_detected`.
- Locked out by the limiter in dev? Restart the server — the counter is
  in-memory.

## Security & performance considerations

- bcrypt cost 12 (~100 ms/hash) + 30-attempts/15-min limiter → online brute
  force is hopeless.
- Refresh cookie: `httpOnly` (XSS), `sameSite: lax` (CSRF), `secure` in
  production (HTTPS only), `path=/api/auth` (minimal exposure).
- `passwordHash` is `select: false` — it cannot leak through a forgotten
  `.select()` in some future endpoint.
- Failed logins are audited with IP; success/logout/reuse events too.
- Sessions self-clean via the Mongo TTL index — no cron job to maintain.

## Verified (all passed 2026-07-22)

login 200 + cookie · wrong password 401 (identical message) · bad email 400
with field details · audit without token 401 · audit as Admin 200 (shows
failed+success login events) · refresh 200 rotation · old-token replay 401 +
all sessions revoked · logout 200 then refresh 401 · Viewer hitting audit 403
· 30 bad logins → 429.
