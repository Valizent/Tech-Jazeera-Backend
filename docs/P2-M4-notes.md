# P2-M4 — Password change & reset, and branding

Two unrelated fixes landed together: a real gap (no way to change or recover
a password anywhere in the app) and a branding update (the placeholder "AJ"
mark replaced with the real logo).

## What was built

**Password change & reset**
```
server/src/modules/auth/auth.validation.js  # + changePasswordSchema
auth.service.js                              # + changePassword() — verifies
                                              #   current password, revokes
                                              #   every session on success
auth.controller.js, auth.routes.js           # + PATCH /api/auth/password
                                              #   (Bearer-authed, any role)
modules/users/user.service.js                # + resetStaffPassword()
                                              #   (Admin resets a staff login)
modules/employees/employee.service.js        # + resetEmployeeLoginPassword()
                                              #   (Admin/HR resets a Worker login)
+ matching controller/route additions in both modules

client/.../auth/components/ChangePasswordModal.jsx  # NEW — self-service, in
                                              #   both DashboardLayout and
                                              #   EssLayout headers (every role)
client/.../users/pages/UserListPage.jsx      # + "Reset password" per row
client/.../employees/components/WorkerLoginPanel.jsx  # + "Reset password"
```

**Branding**
```
client/public/logo.png                       # NEW — the real logo, supplied
                                              #   by the user
client/public/icon-*.png, apple-touch-icon.png, favicon-32.png
                                              # regenerated FROM logo.png
                                              #   (previously a generated
                                              #   placeholder "AJ" mark)
client/public/manifest.webmanifest, index.html
                                              # theme_color updated to the
                                              #   logo's actual teal (#178386)
app/layouts/{DashboardLayout,EssLayout,AuthLayout}.jsx
                                              # sidebar/login "AJ" gradient
                                              #   square → <img src="/logo.png">
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| PATCH | `/api/auth/password` | any authenticated role | change own password (needs current password) |
| POST | `/api/users/:id/reset-password` | Admin | reset a staff login's password |
| POST | `/api/employees/:id/user/reset-password` | Admin, HR | reset a Worker login's password |

## Key decisions & why

- **No self-service "forgot password" email flow.** That needs an email
  provider (SMTP or an API like SendGrid/Resend), which is a new external
  dependency this project doesn't have — not something to silently add
  without asking, per the project's rule against inventing infrastructure or
  credentials. What's built instead is the admin-initiated reset, which
  covers the actual gap (no recovery path existed at all) without a new
  dependency. If a true self-service "email me a reset link" flow is wanted
  later, that's a deliberate follow-up requiring a provider decision.
- **Changing your password revokes every session, including the one that
  changed it.** Matches the existing refresh-token reuse-detection posture
  ("assume compromise, start clean") rather than leaving other devices
  logged in on a credential that might be why you're changing it. The client
  treats a successful change exactly like a forced logout.
- **Reset requires proving the current password; admin-reset doesn't** (it
  can't — the whole point is the user lost it). Both still revoke all
  sessions and log an audit entry, so a reset is never silent.
- **The reveal modals are reused, not duplicated.** Both `UserListPage` and
  `WorkerLoginPanel` already had a one-time-credential-reveal modal from
  provisioning (P2-M1/P2-M2). Reset re-shapes its `{tempPassword}` response
  to match that same modal's expected shape (`{user, tempPassword}`) instead
  of building a second modal — one less place a subtle UI difference could
  creep in.
- **Logo icons are regenerated from the source file, not hand-approximated.**
  The user's logo has detailed Arabic calligraphy; freehand-recreating it in
  SVG would have risked getting it visibly wrong. Asked the user to save the
  actual file, then used it directly (via `sharp`, already a server
  dependency) for every icon size instead of guessing at the design.
- **Only the logo/icon assets changed, not the app's color theme.** The rest
  of the UI (buttons, links, active-nav highlighting) is still the original
  indigo scheme — recoloring the whole app to the brand teal is a separate,
  larger visual decision the user didn't ask for here, flagged as available
  if wanted.

## Verified (2026-08-25)

**curl**: wrong current password → 401 · new password under 8 chars → 400 ·
correct change → 200, old password then 401s on login, new password 200s ·
Admin resets a staff user → old temp password 401s, new one 200s · Admin/HR
resets a Worker login → same · reset before any login exists → 404 · Manager
(non-Admin) blocked from both staff and Worker reset → 403.

**Browser**: self-service change via the header icon on a staff account →
form submits → redirected to `/login` → old password rejected, new password
works · Team page's "Reset password" per row → correct reveal modal
("Password reset" title, correct wording) · Employee profile's
`WorkerLoginPanel` reset button → same · confirmed the same "Change
password" entry point exists and opens correctly in the ESS (Worker) header
too, not just the admin shell.

**Branding**: manifest and all four icon files verified as 200 OK and
regenerated from the real logo; theme-color meta and manifest both read
`#178386`; the logo `<img>` renders (200, correct natural size) on the login
screen, the admin sidebar, and the ESS sidebar.

**Cleanup**: all throwaway accounts and the test employee created during
verification were deleted; the real accounts (`Shamal Khalid`, `Shameer N
P`) and the current admin session were untouched throughout.
