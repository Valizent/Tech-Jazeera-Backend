# M3 — Frontend foundation

## What was built

```
client/src/
├── app/
│   ├── AppProviders.jsx      # Query → Toast → Auth → Router (dependency order)
│   ├── router.jsx            # route table + RequireAuth guard
│   └── layouts/
│       ├── AuthLayout.jsx    # centered card for guest screens
│       └── DashboardLayout.jsx # sidebar/topbar shell; drawer on mobile
├── components/ui/            # Button, Input, Card, Spinner, Toast
├── features/
│   ├── auth/                 # auth.api.js, auth.schema.js, AuthContext.jsx,
│   │   └── pages/LoginPage.jsx
│   └── dashboard/pages/DashboardPage.jsx  # welcome + live system status
└── lib/
    ├── axios.js              # THE api instance; token memory; 401→refresh→retry
    ├── queryClient.js        # TanStack Query defaults
    ├── constants.js          # API_URL (override via VITE_API_URL)
    └── utils.js              # cn(), apiMessage()
```

## The two ideas that carry the whole client

**1. The access token lives in a JavaScript variable, nowhere else**
(`lib/axios.js`). Not localStorage, not a readable cookie — XSS can't steal
what isn't reachable. A page reload therefore wipes it, and that's fine:
`AuthContext` makes one silent `/auth/refresh` on mount; the httpOnly cookie
(which survives reloads, and which page JS can never read) restores the
session. While that's in flight, `status === 'loading'` and route guards show
a spinner — never a flash of the login page.

**2. Screens never handle auth failures** — the axios response interceptor
does. Any 401: refresh once (single-flight, so a burst of parallel 401s
triggers ONE refresh), replay the original request, and the calling screen
never knows. If the refresh itself fails, the session is really over:
AuthContext gets notified, shows the "session expired" toast, and routing
falls to /login.

## Two real bugs this milestone caught (worth understanding)

- **Rotation vs. browser reality.** All tabs share ONE refresh cookie. React
  StrictMode's double-mounted effect (and equally: two real tabs refreshing
  at the same moment) presented the same refresh token twice — and M2's
  theft detection nuked every session. Fix (server): a rotated token stays
  exchangeable for a 30s grace window (`REFRESH_REUSE_GRACE_MS`); reuse
  after that still revokes everything. Fix (client): `refreshRequest()` is
  single-flight. Lesson: security mechanisms must be designed against how
  browsers actually behave.
- **Same-second JWT collision.** Two refresh tokens minted for one user in
  the same second had identical claims → identical string → unique-index
  crash (409). Fix: a random `jti` claim makes every token unique by
  construction. Lesson: JWTs with the same payload and second-resolution
  timestamps are the same string.

## How to add a feature screen (the M4+ recipe)

1. `features/<name>/<name>.api.js` — functions calling `api` from lib/axios.
2. `features/<name>/<name>.schema.js` — Zod schemas (mirror the server's).
3. `features/<name>/pages/...` — pages composing `components/ui` primitives.
4. Route: add under the DashboardLayout children in `app/router.jsx`.
5. Sidebar: add one entry to `NAV_ITEMS` in `DashboardLayout.jsx`.

## Design tokens (how styling works here)

Components use semantic names only — `bg-surface`, `text-muted`,
`border-border`, `bg-primary` — defined in `tailwind.config.js` and backed by
CSS variables in `index.css`. The `.dark` block already contains the full
dark palette; dark mode ships whenever we decide by toggling one class on
`<html>`. Never hardcode a Tailwind palette color (`bg-slate-100`) in a
component — it would silently break theming.

## Common beginner mistakes

- **Calling axios directly in a component.** Always go through the feature's
  `.api.js` layer — it's the only place URLs live.
- **Storing tokens in localStorage** "so login survives reload". The refresh
  cookie already solves that, without handing tokens to XSS.
- **Forgetting `withCredentials`.** Cookies don't travel cross-origin
  without it (client) and without `credentials: true` + exact origin (server
  CORS). Both are configured; don't "simplify" them away.
- **Testing responsiveness by resizing the desktop window only.** Use
  devtools device mode; check no horizontal scroll at 375px.
- **Treating StrictMode double-effects as a nuisance to disable.** It found
  a production-class bug this very milestone. Keep it on.

## Debugging tips

- Redirected to login after reload? Watch Network → the `/auth/refresh` call
  on page load. 401 = cookie missing/expired/revoked; check its `Set-Cookie`
  history and the server's audit log for `auth.refresh.reuse_detected`.
- Random logouts with multiple tabs open would point at the grace window
  (server clock, or window too short).
- CORS errors in console = the server's `CLIENT_URL` doesn't exactly match
  the browser's origin (scheme + host + port).

## Verified (2026-07-22, in-browser)

Guest → redirected to /login · empty submit → inline Zod errors · wrong
password → "Invalid email or password." · login → dashboard shell (sidebar,
topbar, user chip, live status card via TanStack Query) · reload ×2 → session
survives silently · 375px viewport → no horizontal scroll, drawer opens/
closes via hamburger + backdrop · logout → login, reload stays guest ·
corrupted access token mid-session → transparent refresh+retry (200) · dead
session → "session expired" toast + drop to login · zero console errors.
