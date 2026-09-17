# Live Security Test Plan — Al Jazeera ERP

**A complete, executable task list for an AI agent to security-test and QA the live deployment.**

- **Target frontend:** Vercel (`https://<YOUR-APP>.vercel.app`) — set `FRONTEND_URL`
- **Target backend:** Render (`https://<YOUR-API>.onrender.com`) — set `API_BASE`
- **Database:** MongoDB Atlas
- **Storage:** Cloudinary
- **Stack:** React 18 SPA + Node/Express + Mongoose; JWT access token (in-memory) + rotating refresh token (httpOnly cookie)
- **Phase:** pre-production (no custom domain connected yet)
- **Owner authorization:** The owner of this application has authorized this testing of their own systems. This document is the scope of work.

---

## 0. READ THIS FIRST — authorization, scope, and hard safety rules

You are an AI agent executing an **authorized** security assessment of the application owner's
own systems. Everything below is in scope **except** where a rule explicitly forbids or gates it.

### 0.1 What you may test freely

The **application** — its API, its web frontend, its auth, its business logic, its data handling.
This is the owner's software and the owner has authorized it.

### 0.2 Provider AUP — the hard line you must not cross

The frontend runs on **Vercel** and the backend on **Render**. These are shared platforms. Their
Acceptable Use Policies **prohibit**, without prior written arrangement with the provider:

- **Load / stress / volumetric / DoS / DDoS testing** of any kind
- **High-rate automated scanning** (mass fuzzing, aggressive crawlers, `sqlmap --level 5`, etc.)
- Anything that degrades service **for other tenants** on the shared platform

**Therefore:** every task in this plan is tagged with a safety class (§0.4). You must respect the
tag. When a task needs volume to be meaningful (e.g. "is rate limiting effective"), you **verify by
reading rate-limit response headers and testing the boundary with a small, bounded number of
requests** — never by flooding. If a task genuinely cannot be done safely on shared hosting, it is
tagged `STAGING-ONLY` and you must skip it on live and report it as deferred.

### 0.3 Mandatory pre-flight safeguards (do these before ANY test)

1. **Back up the database.** Take a fresh Atlas snapshot / `mongodump`. Record the snapshot ID in
   your report. Do not proceed until confirmed.
2. **Create isolated test identities**, never touch real records:
   - one throwaway `Admin`, one of **each** role (`Manager`, `HR`, `Operations`, `Accounts`,
     `Viewer`, `Worker`), all with an obvious prefix like `sectest+admin@…`.
   - The multi-role set is required for the access-control matrix (§4).
3. **Tag every artifact you create** (employees, clients, documents, NFC records) with a fixed
   marker such as `ZZ-SECTEST-` in a name/id field, so cleanup (§20) can find them all.
4. **Never upload a real person's document.** Use synthetic files clearly labelled as test data.
5. **Confirm you are hitting the right host.** Print `API_BASE` and `FRONTEND_URL` and confirm they
   are the intended pre-production instances, not a customer's.
6. **Test window:** run destructive-ish or higher-volume tasks in a low-traffic window since this is
   pre-production; note the time in the report.
7. **Stop conditions:** if the app starts returning sustained `5xx`, if Render/Vercel shows the
   instance as unhealthy, or if you trip a platform abuse alert — **stop immediately**, record
   state, and report. Do not "push through."

### 0.4 Safety-class legend (every task carries one)

| Tag | Meaning |
|---|---|
| `PASSIVE` | Observation only. No mutation, no attack traffic. Always safe. |
| `SAFE-LIVE` | Active but benign: a handful of crafted requests, no volume, no data destruction. Safe on live. |
| `THROTTLE` | Needs a few repeated requests (e.g. boundary of a rate limit). Cap at the documented number, add delays, stop at the first clear signal. |
| `MUTATING` | Creates/edits/deletes data. Only ever against your **own test artifacts**, never real records. |
| `NOTIFY-PROVIDER` | Would breach the platform AUP unless you first arrange it with Vercel/Render. Skip on live unless the owner confirms arrangement is in place. |
| `STAGING-ONLY` | Cannot be done safely on shared hosting. Defer to a local/staging run and report as deferred. |

### 0.5 Severity legend (for findings)

`CRITICAL` — remote compromise, mass data exposure, auth bypass ·
`HIGH` — single-account data exposure, privilege escalation, stored XSS ·
`MEDIUM` — meaningful weakness needing a precondition ·
`LOW` — hardening / info leak ·
`INFO` — note for awareness.

### 0.6 How to report each task

For every task record: **ID · result (PASS / FAIL / N/A-deferred) · method actually used · evidence
(request + response, status codes, headers) · severity if FAIL · suggested fix + file:line.**
Re-testing an original attack is the only proof that counts. Do not assert "looks fine" — show it.

---

## 1. Reconnaissance & transport (PASSIVE / SAFE-LIVE)

Now that it's live over real HTTPS, transport can finally be tested (it couldn't be on localhost).

| ID | Task | How | Expected (secure) | Class |
|---|---|---|---|---|
| 1.1 | Enumerate the real attack surface | Crawl only your own app; list every API route, the public `/c/:token` pages, `/nfc-media/*`, `/api/health` | Complete route inventory | PASSIVE |
| 1.2 | TLS configuration (backend) | Test `API_BASE` with an SSL analyzer (e.g. `testssl.sh --fast`, or an online SSL check). Grade the cert, protocols, ciphers | TLS 1.2+ only, no TLS 1.0/1.1, strong ciphers, valid chain | SAFE-LIVE |
| 1.3 | TLS configuration (frontend) | Same against `FRONTEND_URL` | A/A+; Vercel-managed, verify anyway | SAFE-LIVE |
| 1.4 | HTTP→HTTPS redirect | `curl -sI http://<host>` for both | 301/308 to https; no plaintext service | SAFE-LIVE |
| 1.5 | HSTS present and sane | Read `Strict-Transport-Security` | `max-age>=15552000`; consider `includeSubDomains` once domain is set | PASSIVE |
| 1.6 | Certificate details | Inspect issuer, expiry, SAN | Valid, not expiring soon, matches host | PASSIVE |
| 1.7 | No debug/preview endpoints exposed | Probe for `/.git`, `/.env`, source maps, `/api` index, Render default pages | All 404/blocked | SAFE-LIVE |

---

## 2. HTTP security headers (PASSIVE / SAFE-LIVE)

Test on **both** the API responses and the Vercel-served HTML, since they're configured separately.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 2.1 | Content-Security-Policy (app pages) | Read CSP on the SPA HTML and on `/c/:token` | Nonce-based on `/c`; SPA has a real policy, not missing | PASSIVE |
| 2.2 | CSP bypass attempt | Look for `unsafe-inline`/`unsafe-eval` in `script-src`; try to load an inline script on `/c/:token` without the nonce | Blocked | SAFE-LIVE |
| 2.3 | `X-Content-Type-Options: nosniff` | Read header | Present on all responses | PASSIVE |
| 2.4 | `X-Frame-Options` / `frame-ancestors` | Read header; attempt to iframe the app from a scratch page | Framing denied (clickjacking guard) | SAFE-LIVE |
| 2.5 | `Referrer-Policy` | Read header | `no-referrer` or `strict-origin-when-cross-origin` | PASSIVE |
| 2.6 | `Permissions-Policy` | Read header | Present, locks down camera/mic/geo | PASSIVE |
| 2.7 | Cache headers on authenticated API responses | Read `Cache-Control` on `/api/employees` etc. | `no-store` / `private` on sensitive data | PASSIVE |
| 2.8 | Server/tech fingerprint leakage | Read `Server`, `X-Powered-By` | `X-Powered-By` suppressed; minimal fingerprint | PASSIVE |
| 2.9 | CORS on the live origin | Preflight with a hostile `Origin`, then with the real Vercel origin | Only the exact Vercel origin allowed; credentials true; never `*` | SAFE-LIVE |
| 2.10 | COOP/CORP/COEP | Read cross-origin isolation headers | Sensible values, no accidental data leak to embedders | PASSIVE |

---

## 3. Authentication (SAFE-LIVE / THROTTLE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 3.1 | Login happy path | Log in as each seeded test role | 200 + access token + refresh cookie | SAFE-LIVE |
| 3.2 | Username enumeration (timing + message) | Wrong-email vs wrong-password vs disabled account: compare messages **and** response timing across ~10 samples each | Identical message; no timing oracle (dummy bcrypt compare) | THROTTLE |
| 3.3 | Login rate limiting — boundary | Send exactly up to the documented limit (30/15min) **and one over**, reading `RateLimit` headers each time. **Do not exceed by more than 1–2.** | 429 after the cap; headers accurate | THROTTLE |
| 3.4 | Credential policy on provisioning | Provision a worker login; inspect the temp password strength; try to set a weak password | Strong temp password; weak ones rejected where settable | MUTATING |
| 3.5 | JWT `alg:none` forgery | Forge `{"alg":"none"}` + admin payload, empty signature | 401 | SAFE-LIVE |
| 3.6 | JWT signature tamper | Flip bytes in a valid signature | 401 | SAFE-LIVE |
| 3.7 | JWT algorithm confusion (RS/HS) | If any asymmetric keys exist, attempt HS/RS confusion; else confirm secret-based HS256 only | Rejected | SAFE-LIVE |
| 3.8 | Expired access token | Wait out / craft an expired token | 401, forces refresh | SAFE-LIVE |
| 3.9 | Token in URL / logs | Confirm tokens never appear in query strings, redirects, or server logs | Never in URL | PASSIVE |
| 3.10 | Account lockout / disabled account | Disable a test user server-side; confirm their live access dies immediately (DB-checked per request) | Immediate 401 | MUTATING |
| 3.11 | Password reset / seed path abuse | Review whether `seed:admin` or any reset path is reachable remotely; confirm it is not an HTTP route | Not remotely reachable | PASSIVE |
| 3.12 | 2FA / MFA posture | Note whether admin accounts have any second factor | INFO — flag for prod (NCA ECC expects MFA for privileged access) | PASSIVE |

---

## 4. Session & token management — **cross-site is the big one here** (SAFE-LIVE)

Vercel and Render are **different sites**. This section is the highest-value part of the live test
because it can only be exercised in the real cross-origin deployment.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 4.1 | **Does the refresh flow even work cross-site?** | From the live SPA, let the access token expire and watch the automatic `POST /api/auth/refresh`. Confirm the refresh **cookie is actually sent** cross-site | Refresh succeeds; session restored | SAFE-LIVE |
| 4.2 | **`SameSite` correctness** | Inspect the `Set-Cookie` on login. If `SameSite=Lax` with a cross-site frontend, refresh will fail in real browsers → **FINDING**. Correct config is `SameSite=None; Secure` | `None; Secure; HttpOnly`, path-scoped | SAFE-LIVE |
| 4.3 | **If `SameSite=None` → CSRF re-test** | `SameSite=None` removes the CSRF protection Lax gave. Attempt a cross-site forged `POST /api/auth/refresh` and any state-changing request from a scratch origin | Refresh rotation limits damage; state-changing routes require the Bearer header (not just the cookie) → CSRF-safe. Confirm, don't assume | SAFE-LIVE |
| 4.4 | Refresh token rotation | Use a refresh token, then try the **same** token again | Old token rejected after grace window | MUTATING |
| 4.5 | Refresh reuse / theft detection | Replay a rotated token past the 30s grace | All sessions for that user revoked | MUTATING |
| 4.6 | Multi-tab race | Two near-simultaneous refreshes (within grace) | Both succeed, no false theft trip | SAFE-LIVE |
| 4.7 | Logout invalidates server-side | Logout, then reuse the old refresh cookie | Rejected; session row deleted | MUTATING |
| 4.8 | Cookie flags complete | Confirm `HttpOnly`, `Secure`, `SameSite`, `Path`, sensible `Max-Age` | All present and correct | PASSIVE |
| 4.9 | Token not in web storage | In the live SPA, inspect `localStorage`/`sessionStorage`/`document.cookie` for the access token | Access token in memory only; nothing in storage | PASSIVE |
| 4.10 | Session fixation | Confirm a new session/token is issued at login, not reused from pre-auth | New token each login | SAFE-LIVE |

---

## 5. Authorization / access control (OWASP API #1/#5) — the classic real-world killer (SAFE-LIVE / MUTATING)

This is where most real breaches happen. Run the **full role matrix**, then hunt IDOR/BOLA.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 5.1 | **Role × endpoint matrix** | For each of the 7 roles, call every module's read/write/delete route. Build the full grid | Each role gets exactly its documented rights; everything else 403 | MUTATING |
| 5.2 | Worker isolation | As `Worker`, hit all staff modules (employees, clients, deployments, attendance, documents, quotations, dashboard, audit, nfc, timesheet-processor) | 403 on every one | SAFE-LIVE |
| 5.3 | Vertical escalation via body | Send `role:"Admin"` (and `isActive`, `_id`) in profile/create/update bodies | Stripped; no escalation | MUTATING |
| 5.4 | **IDOR / BOLA** on every `:id` route | As a low-priv but authenticated user, request other users' objects by guessing/enumerating IDs across employees, clients, documents, quotations, deployments, NFC cards | 403/404; no cross-object read | MUTATING |
| 5.5 | **BFLA** (function-level) | As `Viewer`/`Accounts`, attempt write/delete verbs on each module | 403 | MUTATING |
| 5.6 | Force-browsing admin functions | As non-admin, hit `/api/audit`, `/api/nfc/*`, `/api/timesheet-processor` | 403 | SAFE-LIVE |
| 5.7 | Mass assignment on nested fields | Inject unexpected keys into line items, versions, emergency contacts | Ignored by schema | MUTATING |
| 5.8 | Document ownership | Confirm a document's `owner` can't be reassigned to leak it, and preview/download re-checks auth | Enforced server-side | MUTATING |
| 5.9 | Client-side-only gating check | Confirm every UI-hidden action is **also** enforced server-side (the UI hint is not the control) | Server is the truth | SAFE-LIVE |
| 5.10 | Insecure direct object ref in exports | Try to pull another owner's data via export/report parameters | Scoped correctly | MUTATING |

---

## 6. Injection (SAFE-LIVE / MUTATING)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 6.1 | NoSQL auth bypass | `{"email":{"$ne":null},"password":{"$ne":null}}` and `$gt`/`$regex` variants on login | 400 (Zod rejects non-string) | SAFE-LIVE |
| 6.2 | NoSQL operator injection in queries | `?search[$ne]=x`, `?owner[$gt]=`, nested operators on every list endpoint | 400 / treated as literal | SAFE-LIVE |
| 6.3 | NoSQL via JSON body on filters | Operator objects where strings expected across all search/filter params | Rejected | MUTATING |
| 6.4 | Regex injection / ReDoS | Send pathological regex payloads (`(a+)+$`, long inputs) into every `$regex`-backed search | Escaped; no CPU spike (watch response time, bounded attempts) | THROTTLE |
| 6.5 | Command / SSTI | Probe any field that could reach a shell or template (PDF/vCard/report generators) with `${7*7}`, `{{7*7}}`, `$(id)` | Rendered literally | MUTATING |
| 6.6 | HTTP header / CRLF injection | Inject `\r\n` into values reflected in headers (filenames in Content-Disposition, redirects) | Sanitized | SAFE-LIVE |
| 6.7 | vCard/`.vcf` injection | Newlines + forged `TEL:`/`EMAIL:` in NFC bio/name; fetch the vCard | Escaped per RFC | MUTATING |
| 6.8 | **CSV / Excel formula injection** | Put `=1+1`, `=cmd|'/c calc'!A1`, `@SUM`, `+`, `-`, `\t` leading values into fields that flow into exports (employee name, NFC fields, attendance). Download the export and inspect cells | Leading `= + - @ \t` neutralized (prefixed `'` or blocked). **Currently no guard found → expect FAIL** | MUTATING |
| 6.9 | XML/spreadsheet upload parsing | Upload crafted `.xls`/`.xlsx` to the timesheet processor (formula bombs, external refs, zip bombs within size limit) | Parsed safely, no external fetch, no crash | MUTATING |

---

## 7. Cross-site scripting (SAFE-LIVE / MUTATING)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 7.1 | Stored XSS — NFC public card | Store the 8-payload set (script tags, `"><img onerror>`, `javascript:` URLs, `"><svg onload>`) via the authenticated API into every field that renders on `/c/:token`; fetch and **parse the DOM** (count real tags, don't grep strings) | 0 injected tags; all escaped | MUTATING |
| 7.2 | `javascript:`/`data:` URL schemes | In website/linkedin/map fields | Neutralized (forced to https/ safe scheme) | MUTATING |
| 7.3 | Stored XSS — admin SPA | Load payload-laden records in every admin list/detail view; inspect DOM | React escapes; literal text | MUTATING |
| 7.4 | Reflected XSS | Reflect payloads via query params in error messages, search echoes, 404 pages | Escaped | SAFE-LIVE |
| 7.5 | DOM XSS | Review client for `dangerouslySetInnerHTML`, `innerHTML`, `eval`, unsanitized `href` | None exploitable | PASSIVE |
| 7.6 | SVG/file-preview XSS | Upload an SVG with embedded script as a document; open the preview | Not rendered as active content | MUTATING |
| 7.7 | CSP as XSS backstop | Confirm even if a payload slips in, CSP blocks execution on `/c` | Nonce CSP holds | SAFE-LIVE |
| 7.8 | Filename XSS in Content-Disposition | Upload a file named `"><script>.pdf`; download it | Filename sanitized | MUTATING |

---

## 8. CSRF (SAFE-LIVE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 8.1 | State-changing requests need the Bearer token | From a scratch cross-origin page, attempt POST/PATCH/DELETE with cookies only (no Authorization header) | Rejected (401) — Bearer requirement is the CSRF defense for the API | SAFE-LIVE |
| 8.2 | Refresh endpoint CSRF | Cross-site forged `POST /api/auth/refresh` (cookie auto-sent if `SameSite=None`) | Rotation + reuse detection limit impact; ideally an anti-CSRF measure | SAFE-LIVE |
| 8.3 | Logout CSRF | Forge cross-site logout | Low impact; note if trivially forgeable | SAFE-LIVE |
| 8.4 | JSON content-type enforcement | Try `text/plain`/form-encoded to dodge preflight | JSON required; preflight enforced | SAFE-LIVE |

---

## 9. File upload & storage — **verify the fixes hold on live** (MUTATING)

You already fixed C-1/C-2 locally. Prove they hold in the real Cloudinary + Render environment.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 9.1 | **Document not publicly readable** | Upload a synthetic doc via live API; take the stored `public_id`; try the guessable public CDN URLs (`/raw/upload/…`, `/image/upload/…`, `/raw/authenticated/…`) with no auth | 404 / 401 — not publicly served | MUTATING |
| 9.2 | **Download requires auth** | `GET /api/documents/:id/file` with and without a token | 200 streamed for authorized; 401 without; **no 302 Location leaking a CDN URL** | MUTATING |
| 9.3 | **Delete really deletes** | Upload → delete via API → list the Cloudinary account for that object | 0 objects; CDN 404 | MUTATING |
| 9.4 | Raw file types (PDF/DOCX/XLSX) delete | Repeat 9.3 with a PDF-class file (the type that silently survived before) | Purged | MUTATING |
| 9.5 | Orphan cleanup on failed upload | Upload a file that fails validation after storage | 0 orphan left in Cloudinary | MUTATING |
| 9.6 | **MIME/extension spoofing (H-1, still open)** | Upload HTML/JS/EXE bytes with a spoofed allowed MIME | Currently accepted → **expect FAIL**; confirm and rate | MUTATING |
| 9.7 | Magic-byte vs declared type | Upload content whose bytes contradict the declared type | Real signature validated (currently not) | MUTATING |
| 9.8 | Oversize & zip-bomb | Files at and over the 10MB limit; a compressed bomb within the limit | Rejected cleanly (400, not 500) | MUTATING |
| 9.9 | Malformed file → clean error | Corrupt PDF | 400, not unhandled 500 (M-1) | MUTATING |
| 9.10 | Path traversal on `/nfc-media/` | `../`, encoded, double-encoded, backslash variants | 404 all | SAFE-LIVE |
| 9.11 | Signed-URL expiry (if implemented) | If download uses signed URLs, confirm they expire and can't be replayed indefinitely | Bounded lifetime | MUTATING |
| 9.12 | Cloudinary account hardening | Confirm delivery of `crm-documents` requires signed/authenticated access at the account level, not just per-upload | Account-level protection | PASSIVE |

---

## 10. Business logic abuse (MUTATING)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 10.1 | Quotation total tampering | Send bogus `subtotal`/`grandTotal`/negative discounts/`>100%` in the body | Recomputed server-side; client values ignored | MUTATING |
| 10.2 | Negative / overflow numbers | Negative salary, quantity, huge numbers, `NaN`, scientific notation | Validated/bounded | MUTATING |
| 10.3 | Workflow state jumps | Force invalid status transitions (e.g. quotation Draft→Approved by non-authorized role; deployment states) | Enforced | MUTATING |
| 10.4 | Duplicate / race conditions | Parallel create of unique-keyed records (employeeId, quotation number, NFC token) | Unique index holds; no dup | MUTATING |
| 10.5 | Attendance integrity | Backdate/duplicate attendance; mark for non-existent or unauthorized employees | Rejected | MUTATING |
| 10.6 | NFC card lifecycle abuse | Assign a lost/disabled card; reassign across companies improperly | Blocked per rules | MUTATING |
| 10.7 | Counter/sequence abuse | Hammer quotation-number generation for gaps/collisions (bounded) | Monotonic, no collision | THROTTLE |
| 10.8 | Mass export / scraping | As an authenticated low-priv user, page through everything to gauge excessive data exposure | Pagination limits; only permitted fields | MUTATING |

---

## 11. Rate limiting & anti-automation (THROTTLE — respect provider AUP)

**Do not flood.** Verify by headers and small boundary tests only.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 11.1 | Global API limiter | Read `RateLimit-Policy`/`RateLimit` headers | 600/15min present | PASSIVE |
| 11.2 | Login limiter boundary | §3.3 (bounded) | 30/15min enforced | THROTTLE |
| 11.3 | Public card limiter | Read headers on `/c/:token`; a **small** burst to confirm 429 boundary | 120/15min | THROTTLE |
| 11.4 | Beacon limiter | Headers on `/c/:token/e` | 400/15min | PASSIVE |
| 11.5 | Trust-proxy correctness | Confirm Render's proxy is trusted so `req.ip` is the real client (limits/audit aren't keyed to the proxy IP) | Real client IP used | SAFE-LIVE |
| 11.6 | Per-account vs per-IP | Note whether limits are IP-only (office-shared IP could self-DoS or mask an attacker) | INFO / recommendation | PASSIVE |
| 11.7 | Resource-exhaustion via expensive endpoints | Identify heavy endpoints (exports, analytics, PDF gen); confirm they're auth-gated and not trivially loopable | Guarded | SAFE-LIVE |
| — | Full load/DoS test | — | **DEFERRED** | NOTIFY-PROVIDER |

---

## 12. Information disclosure & error handling (SAFE-LIVE / PASSIVE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 12.1 | **Production error masking** | Trigger 400/401/403/404/500 on live; inspect bodies | **No stack traces**, no file paths, generic 500 (confirm `NODE_ENV=production` on Render) | SAFE-LIVE |
| 12.2 | `/api/health` disclosure | GET unauthenticated | Minimal; ideally not leaking env/DB internals to the public | PASSIVE |
| 12.3 | Verbose validation leakage | Check that field-level errors don't reveal schema internals excessively | Reasonable | SAFE-LIVE |
| 12.4 | User enumeration via side channels | Password reset, provisioning, duplicate-email responses | No oracle | SAFE-LIVE |
| 12.5 | Source maps in production | Fetch `*.js.map` from the Vercel build | Not served in prod (or accept risk knowingly) | PASSIVE |
| 12.6 | Comments/secrets in client bundle | Grep the deployed JS for keys, internal URLs, TODOs, credentials | Nothing sensitive | PASSIVE |
| 12.7 | Directory listing / backup files | Probe common paths (`/backup`, `/.env`, `/config`) | 404 | SAFE-LIVE |
| 12.8 | Metadata leakage in files | Check exported PDFs/Excel and uploaded-then-served files for author/system metadata | Clean | PASSIVE |

---

## 13. Secrets & configuration — Render / Vercel / Atlas (PASSIVE — owner-assisted)

Some of these need the owner to read their dashboard; the agent should request confirmation.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 13.1 | `NODE_ENV=production` on Render | Owner confirms env var | Set to production | PASSIVE |
| 13.2 | Secrets only in env, never in code/git | Re-scan repo + git history for keys, URIs, Cloudinary secret, JWT secrets | Clean (already verified locally — re-confirm) | PASSIVE |
| 13.3 | JWT secret strength & uniqueness | Confirm access/refresh secrets are long, random, **different from each other**, and not shared with any other env | Strong, distinct | PASSIVE |
| 13.4 | `CLIENT_URL` / CORS origin exact | Confirm CORS is pinned to the exact Vercel origin, updated when domain is connected | Exact origin | PASSIVE |
| 13.5 | `PUBLIC_BASE_URL` correctness | **Confirm it resolves to where `/c/:token` is actually served (Render), not Vercel.** Test: `curl <PUBLIC_BASE_URL>/c/<token>` returns card HTML, not the SPA | Correct host | SAFE-LIVE |
| 13.6 | **Atlas network access** | Owner confirms IP allowlist is **not** `0.0.0.0/0`; restricted to Render egress / peered | Restricted | PASSIVE |
| 13.7 | Atlas DB user least-privilege | App user scoped to its DB only, no admin/cluster rights | Least-priv | PASSIVE |
| 13.8 | Cloudinary key exposure | Confirm the API secret is server-side only, never in the client bundle | Server-only | PASSIVE |
| 13.9 | Render service hardening | Auto-deploy from trusted branch only; no debug shell exposed; health checks set | Hardened | PASSIVE |
| 13.10 | Secret rotation plan | Confirm a rotation path exists for JWT secrets & DB creds | Documented | PASSIVE |

---

## 14. Dependency & supply chain (PASSIVE / SAFE-LIVE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 14.1 | `npm audit` both apps | Run on client and server; triage by exploitability | Known highs fixed (`brace-expansion`) | PASSIVE |
| 14.2 | Outdated critical deps | `npm outdated`; focus on express, mongoose, jsonwebtoken, multer, helmet | Patched | PASSIVE |
| 14.3 | Lockfile integrity | Confirm `package-lock.json` committed and used in CI/build | Reproducible builds | PASSIVE |
| 14.4 | Pinned CDN dependency (`xlsx`) | Confirm the patched vendor `xlsx` (not vulnerable npm 0.18.5) is what's deployed | Correct version | PASSIVE |
| 14.5 | Unused deps / dead files | Flag `server/check-api.js`, `check-db.js` and any other dead code that connects to Atlas | Removed before prod | PASSIVE |
| 14.6 | License/typosquat sanity | Spot-check for suspicious/typosquatted packages | Clean | PASSIVE |

---

## 15. Client-side / SPA security (PASSIVE / SAFE-LIVE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 15.1 | No secrets in bundle | §12.6 | Clean | PASSIVE |
| 15.2 | Token storage | §4.9 — memory only | Confirmed | PASSIVE |
| 15.3 | Dependency confusion in build | Confirm Vercel builds from your lockfile, not arbitrary latest | Deterministic | PASSIVE |
| 15.4 | Clickjacking on the SPA | §2.4 framing test on the live app | Denied | SAFE-LIVE |
| 15.5 | `postMessage`/window messaging | Review for unvalidated origins | Origin-checked | PASSIVE |
| 15.6 | Open redirect | Test any redirect params (login return-to, etc.) | No open redirect | SAFE-LIVE |
| 15.7 | Subresource integrity | If any external scripts, SRI present (ideally none external) | None external / SRI set | PASSIVE |
| 15.8 | Third-party calls from the browser | Network-inspect the live app for unexpected outbound calls | Only your API | PASSIVE |

---

## 16. Logging, monitoring & audit trail (PASSIVE / MUTATING)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 16.1 | Auth events audited | Log in/out, failed login, provisioning as test users; confirm audit rows | Recorded | MUTATING |
| 16.2 | CRUD auditing | Create/update/delete test records; confirm audit trail with actor + IP | Recorded | MUTATING |
| 16.3 | Secrets never logged | Confirm passwords/tokens/cookies never in logs | Clean | PASSIVE |
| 16.4 | Audit tamper-resistance | Confirm audit rows aren't user-deletable via the API | Immutable to users | SAFE-LIVE |
| 16.5 | Log retention & access | Owner confirms Render log retention and who can read them | Defined (compliance) | PASSIVE |
| 16.6 | Alerting | Any alert on repeated auth failures / reuse detection? | Recommend if absent | PASSIVE |
| 16.7 | Timestamp integrity | Confirm consistent UTC timestamps for forensic use | Consistent | PASSIVE |

---

## 17. API design robustness (OWASP API Top 10) (SAFE-LIVE / MUTATING)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 17.1 | Excessive data exposure | Inspect responses for fields the client shouldn't get (passwordHash, internal flags) | Minimal DTOs; `passwordHash` never serialized | SAFE-LIVE |
| 17.2 | Improper inventory | Confirm no undocumented/legacy API versions or debug routes live | None | SAFE-LIVE |
| 17.3 | Unrestricted resource consumption | Large `limit=` values, deep pagination, huge bodies (within 1MB cap) | Bounded | MUTATING |
| 17.4 | HTTP method tampering | `PUT`/`PATCH`/`OPTIONS`/`TRACE` where not expected; method-override headers | Only intended verbs | SAFE-LIVE |
| 17.5 | Content-type confusion | Send unexpected content types | Rejected | SAFE-LIVE |
| 17.6 | Parameter pollution | Duplicate params, array vs scalar | Handled deterministically | SAFE-LIVE |
| 17.7 | 404 vs 403 leakage | Confirm existence isn't leaked via differing status on protected objects | Consistent | SAFE-LIVE |

---

## 18. Infrastructure & DNS — before connecting the domain (PASSIVE / SAFE-LIVE)

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 18.1 | Subdomain/takeover check | Before pointing DNS, confirm no dangling CNAME to unclaimed Vercel/Render targets | No takeover risk | SAFE-LIVE |
| 18.2 | Email auth (SPF/DKIM/DMARC) | If the app sends email (or will), check DNS records for the domain | Configured (anti-spoofing) | PASSIVE |
| 18.3 | CAA records | Recommend CAA to restrict cert issuance | Set on domain | PASSIVE |
| 18.4 | DNSSEC | Recommend for the production domain | Considered | PASSIVE |
| 18.5 | Direct-to-origin exposure | Confirm the Render backend isn't independently reachable in a way that bypasses intended controls once a domain/CDN is in front | Controlled | SAFE-LIVE |
| 18.6 | Health/status pages | Confirm no infra dashboards (Render/Vercel) are publicly linked/exposed | Private | PASSIVE |
| 18.7 | Backup & recovery drill | Confirm the Atlas backup taken in §0.3 can actually restore | Verified | PASSIVE |

---

## 19. Saudi regulatory compliance — NCA ECC & PDPL (PASSIVE — owner-assisted)

This is a **compliance readiness review**, not a legal opinion. It maps your controls to the Saudi
frameworks so you know what a regulator/auditor would look for. Confirm each with the owner.

**Personal Data Protection Law (PDPL) — the app holds employee PII (passports, iqamas, salaries):**

| ID | Task | What to verify | Class |
|---|---|---|---|
| 19.1 | **Data residency / transfer** | PDPL restricts cross-border transfer of Saudi personal data. Confirm **where Atlas, Render, Cloudinary and Vercel actually store/process the data** (region). Saudi data ideally stays in-Kingdom or under an approved transfer basis. **This is the single most important compliance item for your hosting choices.** | PASSIVE |
| 19.2 | Lawful basis & consent | Employees' data processing has a basis; workers using the ESS portal are informed | PASSIVE |
| 19.3 | Data minimization | Only necessary PII collected/retained | PASSIVE |
| 19.4 | Retention & deletion | A retention policy exists; deletion actually purges (you fixed document deletion — extend the principle to all PII) | PASSIVE |
| 19.5 | Right to access/rectify/erase | The system can fulfill data-subject requests | PASSIVE |
| 19.6 | Encryption at rest & in transit | TLS (§1) + Atlas/Cloudinary at-rest encryption confirmed | PASSIVE |
| 19.7 | Breach-notification readiness | A documented process to detect and report a breach within PDPL timelines | PASSIVE |
| 19.8 | Processor agreements | DPAs/terms with Atlas, Render, Vercel, Cloudinary as data processors | PASSIVE |

**NCA Essential Cybersecurity Controls (ECC) — control-readiness signals:**

| ID | Task | What to verify | Class |
|---|---|---|---|
| 19.9 | Access control & least privilege | RBAC matrix (§5) matches documented roles; admin access is minimal | PASSIVE |
| 19.10 | MFA for privileged accounts | ECC expects MFA — currently absent (§3.12). Flag for prod | PASSIVE |
| 19.11 | Cryptography standards | Strong TLS, strong hashing (bcrypt cost 12), strong secrets | PASSIVE |
| 19.12 | Logging & monitoring | Audit trail (§16) + retention | PASSIVE |
| 19.13 | Backup & recovery | §18.7 | PASSIVE |
| 19.14 | Vulnerability management | This assessment + a repeatable schedule + patch process | PASSIVE |
| 19.15 | Secure configuration | Headers, TLS, error masking, hardened platform config | PASSIVE |
| 19.16 | Third-party / cloud security | Provider due diligence, data-location awareness | PASSIVE |
| 19.17 | Incident response plan | A documented IR plan exists | PASSIVE |

> **Note:** For an authoritative compliance position, have the final controls reviewed by a
> qualified Saudi cybersecurity/legal advisor. This checklist gets you audit-ready; it is not a
> certification.

---

## 20. QA — functional, UX, accessibility (SAFE-LIVE / PASSIVE)

Security aside, verify the product actually works on the live deployment.

| ID | Task | How | Expected | Class |
|---|---|---|---|---|
| 20.1 | Full auth flow on live | Login/refresh/logout end-to-end in a real browser cross-site | Works (ties to §4.1) | SAFE-LIVE |
| 20.2 | Every module renders | Walk all 9 modules with live data | No errors | SAFE-LIVE |
| 20.3 | CRUD round-trips | Create/read/update/delete a test record in each module | Works, with confirm dialogs on destructive actions | MUTATING |
| 20.4 | Loading/empty/error/success states | Force each state per view | All present | SAFE-LIVE |
| 20.5 | Responsive / no horizontal overflow | Sweep at 375/768/1280; measure `scrollWidth` | 0 overflow | SAFE-LIVE |
| 20.6 | Console & network health | Capture console + failed requests across the walk | No errors; no unexpected calls | PASSIVE |
| 20.7 | NFC public card end-to-end | Tap-flow on a real device/viewport; vCard download; beacon | Works | SAFE-LIVE |
| 20.8 | Exports open correctly | Download Excel/PDF/CSV and open them | Valid, correct data (and §6.8 safe) | MUTATING |
| 20.9 | Accessibility baseline | Run an a11y check (contrast, labels, keyboard nav, focus) on key pages | Reasonable WCAG posture | PASSIVE |
| 20.10 | Cold-start behaviour | Render free tier sleeps — confirm the SPA handles a slow first backend response gracefully | Graceful | SAFE-LIVE |
| 20.11 | Cross-browser sanity | Chrome + Safari/iOS (NFC users are on phones) | Consistent | SAFE-LIVE |

---

## 21. Cleanup & reporting (MUTATING)

| ID | Task | How | Class |
|---|---|---|---|
| 21.1 | Delete all test artifacts | Remove every `ZZ-SECTEST-` record: users (all 7 roles), employees, clients, documents, quotations, deployments, attendance, NFC company/employee/card/batch | MUTATING |
| 21.2 | Purge test files from Cloudinary | Confirm `crm-documents` and `nfc-media` hold **0** test objects across all `type`/`resource_type` combos | MUTATING |
| 21.3 | Remove orphan sessions | Delete refresh tokens tied to test users | MUTATING |
| 21.4 | Preserve audit rows | Do **not** delete audit-log entries — note them as test-attributed instead | PASSIVE |
| 21.5 | Verify DB back to baseline | Confirm record counts match the pre-test snapshot | PASSIVE |
| 21.6 | Final report | One doc: every task ID, PASS/FAIL/deferred, evidence, severity, fix + file:line, and a prioritized remediation order | PASSIVE |
| 21.7 | Re-test after fixes | Re-run only the FAILED tasks' original attacks to confirm remediation | varies |

---

## Known open items to expect as FAIL (from the prior local audit)

Seed these so the agent confirms them on live rather than rediscovering from scratch:

- **§9.6 / 9.7 — H-1 MIME spoofing:** file-type allowlist trusts the client MIME. Expect accept.
- **§6.8 — CSV/Excel formula injection:** no export sanitization found. Expect FAIL.
- **§4.2 — SameSite=Lax cross-site:** likely breaks refresh in real browsers, or is set to `None`
  without a compensating CSRF control. Verify and resolve — highest-value live finding.
- **§9.9 / M-1 — 500 on malformed upload:** Cloudinary errors not mapped to 400.
- **§14.5 — dead files:** `server/check-api.js`, `server/check-db.js`.
- **Already fixed locally (confirm they hold on live): C-1, C-2, M-2** (document exposure,
  deletion, orphan cleanup).

---

## Execution notes for the AI agent

- Work **top to bottom**; §0 safeguards are blocking prerequisites.
- Respect every safety tag. When in doubt, downgrade to the safest method that still proves the point.
- Prefer **reading headers and small boundary tests** over volume, always.
- Never touch a record without the `ZZ-SECTEST-` marker.
- If any test needs a credential, secret, or dashboard value you don't have, **stop and ask the
  owner** — never invent one.
- Produce evidence for every result. "Looks secure" is not a result.
