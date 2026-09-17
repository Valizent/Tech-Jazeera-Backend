# Security Audit & QA Report

**Date:** 9 August 2026
**Scope:** Full application — `server/` (Express API, ~6k LOC) and `client/` (React SPA, ~9k LOC)
**Method:** Static code review → dependency/config audit → live penetration test against `localhost` → browser QA
**Severity basis:** Rated as *actively exploitable* (the app is deployed). Only `localhost` was tested; no remote host was touched.

**Status:** C-1, C-2 and M-2 were **fixed and re-verified** on 9 Aug 2026 (see
[Remediation](#remediation-9-august-2026)). All other findings remain open.

---

## Executive summary

The security *architecture* of this codebase is genuinely strong. Authentication, authorization,
injection defence, XSS escaping, and secrets hygiene were all attacked directly and all held.
Twelve separate attack classes were tested and failed to break through (see
[Verified secure](#verified-secure-tested-and-held)).

**The problem is not the ERP's own logic — it is the Cloudinary storage migration.**

That migration moved every uploaded document (passports, visas, iqamas, medical records,
contracts) from an authenticated, server-streamed local path onto a **public CDN with no
access control**, and it did so without changing the mental model the rest of the code is
written against. Three of the four highest findings all trace back to that one change.

| Severity | Count | Headline | Status |
|---|---|---|---|
| **Critical** | 2 | Documents publicly readable without auth; deletion does not delete | **FIXED** |
| **High** | 1 | File-type allowlist is bypassable — arbitrary content accepted | Open |
| **Medium** | 4 | 500 on bad upload, orphaned files, card URL host, legacy files unreachable | 1 fixed, 3 open |
| **Low** | 9 | Info disclosure, dependency CVEs, operational hardening | 1 resolved, 8 open |

---

## Remediation (9 August 2026)

C-1, C-2 and M-2 were fixed together — they are one lifecycle (store → read → delete) and
fixing any one alone would have left the others incoherent.

**The shape of the fix.** Documents are now uploaded with `type: 'authenticated'`, so the
plain CDN URL 404s. The database stores Cloudinary's `public_id` and `resource_type` verbatim
instead of a delivery URL, so nothing is ever parsed back out of a string. Reads mint a signed
URL **server-side**, fetch it in-process, and pipe the bytes to the already-authenticated
client — the browser never receives a Cloudinary URL at all. Deletes use the stored key and
check Cloudinary's verdict instead of assuming success.

| File | Change |
|---|---|
| [`middleware/upload.js`](../server/src/middleware/upload.js) | `type: 'authenticated'` + explicit `resource_type: 'raw'`; new `signedDownloadUrl()` and `destroyDocumentFile()` helpers (the latter passes `invalidate: true` and reports the result) |
| [`documents/document.model.js`](../server/src/modules/documents/document.model.js) | Version gains `storage` and `resourceType`; `fileName` now holds a storage **key**, never a URL |
| [`documents/document.service.js`](../server/src/modules/documents/document.service.js) | New `describeStorage()` classifier; `resolveFile` returns a disk path or a signed URL; `deleteDocument` counts and logs files that did not actually delete |
| [`documents/document.controller.js`](../server/src/modules/documents/document.controller.js) | Redirect replaced with a server-side stream; RFC 5987 `Content-Disposition` so non-ASCII filenames survive |
| [`documents/document.routes.js`](../server/src/modules/documents/document.routes.js) | Orphan cleanup calls Cloudinary instead of `fs.unlink` on a URL (M-2) |

**Verification — the same attacks, re-run after the fix:**

```
C-1  guess public URL   /raw/upload/<id>          -> 404
     guess public URL   /image/upload/<id>        -> 404
     unsigned auth URL  /raw/authenticated/<id>   -> 401
     GET /api/documents/:id/file  (authorized)    -> 200, bytes streamed, NO Location header
     GET /api/documents/:id/file  (no token)      -> 401
     API response contains a Cloudinary URL?      -> NO

C-2  upload -> DELETE -> list Cloudinary account  -> 0 objects (file really gone)
     multi-version doc, 2 files, DELETE           -> 0 objects (both purged)

M-2  upload that fails validation after Multer    -> 0 orphans left
```

**Regression checks:** legacy local-disk documents still stream (`200`, correct bytes and
`Content-Type`); version-specific download returns the right version; the browser preview
modal loads a `blob:` URL; and the browser made **zero** requests to `res.cloudinary.com`.

**Side effect on M-1.** Storing as `raw` means Cloudinary no longer runs documents through its
image pipeline, so the "Invalid PDF file" rejection that produced an unhandled 500 can no
longer occur on upload. The underlying gap — Cloudinary errors not being mapped to `ApiError` —
is unchanged, so M-1 stays open at lower likelihood.

**Not changed:** H-1 (MIME spoofing) is still open by design — it was outside the approved
scope. Arbitrary content can still be uploaded under a false MIME label. It is no longer
*publicly* reachable, which removes the phishing-hosting angle, but the allowlist is still
cosmetic.

---

## CRITICAL

### C-1 — Uploaded documents are publicly readable by anyone, with no authentication

> **FIXED — 9 Aug 2026.** See [Remediation](#remediation-9-august-2026). Retested: public URL
> forms return 404/404/401, and `/file` now streams instead of redirecting.

**Files:** [`server/src/middleware/upload.js:23`](../server/src/middleware/upload.js#L23),
[`server/src/modules/documents/document.controller.js:56`](../server/src/modules/documents/document.controller.js#L56)

`CloudinaryStorage` is configured without `type: 'authenticated'` (or `access_mode`), so
Cloudinary stores every upload as a **public delivery asset**. `GET /api/documents/:id/file`
then answers with a `302` redirect to that public URL.

```js
// upload.js — no access control specified, so Cloudinary defaults to PUBLIC
const storage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'crm-documents', resource_type: 'auto' },
});

// document.controller.js — hands the public URL straight to the browser
if (fileData.fileUrl) {
  return res.redirect(fileData.fileUrl);
}
```

**Proof (live, this machine).** A synthetic file was uploaded through the real API as a
`Passport` document, then fetched with no `Authorization` header, no cookie, and no session:

```
POST /api/documents                      -> HTTP 201
stored URL: https://res.cloudinary.com/<cloud>/image/upload/v.../crm-documents/k9y5cnc0mpsbvbjkqf52.png

curl <that URL>   (no auth whatsoever)   -> HTTP 200 | bytes=70 | type=image/png

GET /api/documents/<id>/file             -> HTTP 302
Location: https://res.cloudinary.com/<cloud>/image/upload/v.../crm-documents/k9y5cnc0mpsbvbjkqf52.png
```

**Why this matters more than it looks.** The entire guard chain —
`requireAuth` → `requireStaff` → `requireRoles` — protects *the redirect*, not *the bytes*.
Once the URL exists, it is a permanent, unauthenticated capability:

- it lands in browser history, corporate proxy logs, and any `Referer` header;
- a `Viewer`-role user, an intern, or a since-deactivated account can harvest URLs from
  `GET /api/documents` and retain access **after their account is disabled**;
- the URL survives password changes, role changes, and offboarding.

For passport, iqama, and medical scans this is sensitive personal data under Saudi PDPL and GDPR.

**Recommended fix**

1. Upload with `type: 'authenticated'` (or `access_mode: 'authenticated'`) so the raw URL 404s.
2. Replace the `res.redirect` with either a short-lived signed URL
   (`cloudinary.url(publicId, { sign_url: true, type: 'authenticated', expires_at })`) or a
   server-side stream so the bytes never leave an authenticated request.
3. Store the `public_id` and `resource_type` in the document model, not the full URL —
   see C-2 for why the URL-parsing approach is already failing.

> **Note on existing data:** all 5 real document versions currently in your database are
> *legacy local-disk* filenames, so they are **not** currently exposed this way. The
> vulnerability applies to every upload made since the migration and every future upload.
> See M-4 for the separate problem those legacy files have.

---

### C-2 — Deleting a document does not delete the file; PDFs and Word/Excel files stay public forever

> **FIXED — 9 Aug 2026.** See [Remediation](#remediation-9-august-2026). Retested: after a
> delete, the Cloudinary account lists **0** objects, including the multi-version case.

**File:** [`server/src/modules/documents/document.service.js:160`](../server/src/modules/documents/document.service.js#L160)

```js
const publicId = folderAndFile.split('.')[0];
await cloudinary.uploader.destroy(publicId);   // <-- no resource_type
```

Three compounding defects:

1. **`destroy()` defaults to `resource_type: 'image'`.** With `resource_type: 'auto'` on
   upload, PDFs, Word and Excel files are stored as **`raw`**. Destroying a `raw` asset with
   the image default silently does nothing.
2. **Cloudinary returns `{ result: 'not found' }` — it does not throw.** So the surrounding
   `try/catch` never fires, nothing is logged, and the API happily returns `200 Document deleted.`
3. **`split('.')[0]` strips the extension**, but `raw` public_ids can legitimately *include*
   the extension — so even a corrected `resource_type` can miss the target.

**Proof (live).** A `raw` document was uploaded, deleted through the API, then re-fetched:

```
1. public fetch BEFORE delete   -> HTTP 200  (content served)
2. DELETE /api/documents/<id>   -> HTTP 200  {"message":"Document deleted."}
3. GET /api/documents/<id>      -> HTTP 404  (gone from the ERP)
4. public CDN fetch AFTER delete-> HTTP 200  (STILL SERVING THE FILE)
```

Manual confirmation of the root cause:

```
destroy('crm-documents/b3vdetutnriiu6ziptzz', { resource_type: 'raw' })  -> {"result":"ok"}
destroy('crm-documents/b3vdetutnriiu6ziptzz')   // what the app does     -> {"result":"not found"}
```

Images *do* delete correctly (a PNG test purged cleanly), which is exactly why this is easy
to miss — the bug only affects PDF/DOC/DOCX/XLS/XLSX, which is most of what an HR department
uploads.

**A fourth issue found while cleaning up:** even a *correct* `destroy` leaves the file in the
Cloudinary **edge cache** — the CDN returned `200` after a successful deletion. Pass
`invalidate: true` to purge it.

**Impact.** "Delete" is not deletion. An admin who deletes a terminated worker's passport
scan believes it is destroyed; it remains publicly downloadable indefinitely. This is a
right-to-erasure failure, not just a storage leak.

**Recommended fix.** Persist `public_id` + `resource_type` at upload time and call
`destroy(public_id, { resource_type, invalidate: true })`. Check the returned `result` and
log/raise when it is not `'ok'` — a silent `'not found'` must never look like success.

---

## HIGH

### H-1 — The file-type allowlist is cosmetic; arbitrary content is accepted

**File:** [`server/src/middleware/upload.js:32`](../server/src/middleware/upload.js#L32)

`fileFilter` checks `file.mimetype`, which is simply the `Content-Type` the *client* wrote
into the multipart part. It is attacker-controlled and never verified against the bytes.

**Proof (live).** An HTML file containing a script tag, labelled as a Word document:

```
file content : <html><body><h1>ZZ PENTEST</h1><script>alert(1)</script></body></html>
declared MIME: application/vnd.openxmlformats-officedocument.wordprocessingml.document

POST /api/documents -> HTTP 201  (accepted and stored)
public fetch        -> HTTP 200, body served verbatim
```

Combined with C-1, this means the company's CDN account will host arbitrary attacker-chosen
content at a legitimate-looking corporate URL — useful for phishing and malware distribution.

Worth noting the contrast: **the NFC image upload is not vulnerable**, because it passes
`allowed_formats: ['jpg','png','webp']`, which makes Cloudinary validate the actual format
server-side. The document upload has no equivalent.

**Recommended fix.** Add `allowed_formats` to the document storage params, and validate the
real file signature (magic bytes) rather than the declared MIME type.

---

## MEDIUM

### M-1 — A corrupt or unusual file returns HTTP 500 instead of a clean 400

Cloudinary's rejection is never translated into an `ApiError`, so it escapes as an unhandled
error.

```
POST /api/documents  (valid MIME label, malformed PDF body)
-> HTTP 500 {"success":false,"message":"Something went wrong. Please try again."}
-> logged as: "POST /api/documents -> 500 unhandled error"
```

The response carried no `stack` field even in development, because the thrown value is a
Cloudinary error object rather than an `Error` instance — which also means
`errorHandler`'s logging path records nothing useful. A user with a slightly corrupt scan
gets a scary generic failure and you get no diagnostic. This breaks the project's own
single-envelope discipline.

**Fix:** catch the Cloudinary error in `uploadSingle` / the service and map it to
`ApiError(400, 'That file could not be processed…')`.

### M-2 — Rejected uploads leave permanent orphaned files

> **FIXED — 9 Aug 2026.** Fixed alongside C-2: the handler now calls Cloudinary with
> `req.file.filename` (the public_id). Retested with an upload that fails validation after
> Multer — 0 orphans left.

**File:** [`server/src/modules/documents/document.routes.js:73`](../server/src/modules/documents/document.routes.js#L73)

```js
router.use((err, req, res, next) => {
  if (req.file?.path) fs.unlink(req.file.path, () => {});   // path is now an https:// URL
  next(err);
});
```

Since the Cloudinary migration, `req.file.path` is a URL, not a filesystem path. `fs.unlink`
fails, the empty callback swallows the error, and the already-uploaded file stays on the CDN
forever. The comment above it still describes the old local-disk behaviour. Same class of bug
as C-2: the code was not updated to match the new storage model.

### M-3 — `PUBLIC_BASE_URL` is unset; NFC card URLs point at `localhost`

**File:** [`server/src/config/env.js:88`](../server/src/config/env.js#L88)

`publicBaseUrl` is `optional(...)` and falls back to `http://localhost:5000`. Confirmed live —
a freshly generated card returned:

```json
{ "token": "UNuXFVTPVLmr", "url": "http://localhost:5000/c/UNuXFVTPVLmr" }
```

Correct locally, but if the variable is not set on your deployed host, **every NFC card URL,
QR code image, and CSV export written for physical card production points at localhost** and
is permanently useless once printed onto plastic.

> **UPDATE — 9 Aug 2026.** Confirmed set in production, **but to the Vercel (frontend)
> address**, which looks wrong. Re-raised as **M-3b** below.

### M-3b — `PUBLIC_BASE_URL` points at Vercel, but the card pages are served by Render

`/c/:token` is mounted on the **Express app** (`app.use('/c', nfcPublicRoutes)` in
[`app.js`](../server/src/app.js)) — it runs on Render. It does not exist on Vercel. The React
SPA's router has no `/c` route and ends in a catch-all:

```js
{ path: '*', element: <Navigate to="/" replace /> }   // client/src/app/router.jsx:95
```

So unless you have a Vercel rewrite proxying `/c/*` through to Render, tapping a card at
`https://<your-app>.vercel.app/c/<token>` will serve the SPA, hit the catch-all, redirect to
`/`, and show the visitor **the internal ERP login page** instead of the business card. That is
both a broken product and a small information disclosure — a stranger tapping a card sees your
staff login screen.

**Please check one of these is true:**

1. A Vercel rewrite maps `/c/*` (and `/nfc-media/*`) to the Render origin — in which case this
   is fine as configured; or
2. `PUBLIC_BASE_URL` should instead be the **Render** origin (or a custom domain pointing at
   Render).

Quick test — this should return the card HTML, not the SPA shell:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-public-base-url>/c/<a-real-token>
```

Worth fixing before any cards are physically printed, since the URL is burned into the chip
and the QR code.

### M-4 — Existing documents are on ephemeral local disk and will disappear on redeploy

All 5 real document versions currently in the database are legacy local-disk filenames
(e.g. `ab3fddaf-…-…​.pdf`), not Cloudinary URLs. The code comments state the migration was
done "for persistent storage on Render" — Render's filesystem is ephemeral, so on the live
host these files are very likely **already gone**, and `resolveFile` will throw:

```
410 "The stored file is missing on the server."
```

This affects a real employee passport (4 versions) and a signed client agreement.

**Action:** check whether those files still resolve in production. If they are gone, restore
them from a local backup and re-upload; if they still exist, migrate them before the next deploy.

---

## LOW

| # | Finding | Detail |
|---|---|---|
| **L-1** | `/api/health` leaks environment info unauthenticated | Returns `environment` and DB connection state to anyone. Restrict to a plain `200 OK`, or require auth for the detail. |
| **L-2** | ~~Confirm `NODE_ENV=production` on the live host~~ — **RESOLVED** | Confirmed set to `production` on Render (9 Aug 2026), so stack traces are suppressed in production. The `development` behaviour seen during this audit was local-only and correct. |
| **L-3** | `seed-admin.js` silently promotes any existing user to Admin | The `upsert` overwrites `role: 'Admin'` and the password for a matching email with no warning. Running it against an existing Worker's email silently grants full admin. Add a confirmation prompt when the email already exists with a different role. |
| **L-4** | No `unhandledRejection` / `uncaughtException` handlers | `server.js` handles SIGINT/SIGTERM but not these. A stray rejection anywhere can take the process down with no log. |
| **L-5** | Unauthenticated analytics writes | `POST /c/:token/e` accepts unauthenticated inserts (verified: 3× `204`). Rate-limited to 400/15min/IP, but a client's tap analytics can still be inflated. Accepted trade-off — documented for awareness. |
| **L-6** | Dependency CVEs | `npm audit`: **1 high** (`brace-expansion` DoS), **2 moderate** (`uuid` via `exceljs`). Both transitive with low real exposure here. `npm audit fix` clears the high one without breaking changes; the `uuid` fix would downgrade `exceljs` — not worth it. |
| **L-7** | vCard `URL:` values are not normalized | The web page runs `company.website` through `ensureHttp`, the vCard builder does not. A stored `www.example.com` produces `URL:www.example.com`, an invalid vCard URI. Cosmetic inconsistency. |
| **L-8** | Server binds `0.0.0.0` | Confirmed listening on all interfaces. Combined with L-2's dev stack traces, the dev server is reachable from anyone on the same office Wi-Fi. Bind to `127.0.0.1` in development. |
| **L-9** | Untracked debug scripts committed to the working tree | `server/check-api.js` and `server/check-db.js` connect directly to Atlas and are dead code — a direct violation of CLAUDE.md hard rule 2. Delete them or move them under `src/scripts/`. |

---

## Verified secure (tested and held)

These were attacked directly and did not break. Listing them because knowing what is *proven
solid* is as useful as knowing what is broken.

| Attack | Result |
|---|---|
| JWT `alg:none` forgery | **401** — rejected |
| JWT tampered signature | **401** — rejected |
| Expired access token | **401** — rejected, 15-min TTL confirmed working |
| NoSQL injection in login (`{"$ne":null}`) | **400** — Zod rejects non-string |
| NoSQL operator in query (`search[$ne]`) | **400** — Zod rejects object |
| Mass assignment (`role`, `_id`, `isActive` in body) | Stripped — Zod `safeParse` output replaces `req.body` |
| Worker privilege escalation (P2-M1 boundary) | **403 on all 10 staff modules** — employees, clients, deployments, attendance, documents, quotations, dashboard, audit, nfc, timesheet-processor |
| CORS from hostile origin | `Access-Control-Allow-Origin` never reflects the attacker origin |
| Path traversal on `/nfc-media/` | **404** on all 6 payloads (`../`, URL-encoded, double-encoded, backslash) |
| Stored XSS on the public NFC card | All payloads escaped. Exactly 1 `<script>` tag, nonce-protected; 0 inline handlers; `javascript:` URLs neutralized by `ensureHttp` |
| vCard injection (newline → forged property) | Correctly escaped — `esc()` handles `\`, `\n`, `,`, `;` |
| NFC token enumeration | Byte-identical 404 for every invalid token |
| Login brute force | 30/15min limiter confirmed active via `RateLimit` headers |
| Token theft via XSS | **Nothing** in localStorage or sessionStorage; refresh cookie is httpOnly, `sameSite=lax`, path-scoped to `/api/auth` |
| Quotation total tampering | Recomputed server-side from line items, never trusted from the client |
| Secrets in git history | Clean — `.env` was never committed |
| Security headers | Full helmet set: HSTS, `nosniff`, `frame-ancestors`, `Referrer-Policy: no-referrer`, COOP/CORP, plus a per-response nonce CSP on public pages |

### Frontend QA

- **9 pages** walked at 375 px — **zero horizontal page overflow** on any of them.
- Console clean: only a React Router v7 future-flag warning and the expected pre-login `401`
  from the session-restore refresh call.
- React escapes stored XSS payloads correctly — a card company named
  `ZZ</title><script>alert(1)</script>` renders as literal visible text.

---

## Remaining work, in order

1. ~~**C-1**, **C-2**, **M-2**~~ — **done** (9 Aug 2026).
2. **M-3b** — confirm the NFC card URL host resolves to Render. Do this *before* printing cards.
3. **M-4** — find out whether the 5 legacy production files still exist on Render; recover them if not.
4. **H-1** — add `allowed_formats` + magic-byte validation.
5. **M-1** — map Cloudinary errors to `ApiError(400)`.
6. **L-1, L-3, L-4, L-8, L-9** — hardening and cleanup pass.
7. **L-6** — `npm audit fix` for the `brace-expansion` high.

### Deployment note

The fix changes how new uploads are stored, and **nothing migrates old rows automatically**.
Documents uploaded between the Cloudinary migration and this fix (none in the database as of
this audit — all 5 existing versions are local-disk) would still be public `type: 'upload'`
objects. `describeStorage()` reads and deletes them correctly, but they remain publicly
reachable until re-uploaded. If any exist on the production database, re-upload them.

---

## Test data

A throwaway `Admin` account, a `Worker` account, test employees, one NFC
company/employee/card/batch, and several uploaded test files were created across the audit and
the post-fix verification. **All have been deleted and verified removed** — `crm-documents`
lists 0 objects across every `type`/`resource_type` combination, and the database is back to
1 user, 2 employees, 2 documents.

This includes the Cloudinary orphan the application itself could not delete, which had to be
destroyed manually with `resource_type: 'raw'` — a direct demonstration of C-2.

Audit-log rows recording these actions were **deliberately left in place** — tampering with an
audit trail is worse than a few noisy entries. They are attributed to `QA Pentest Temp` and
dated 9 August 2026 if you wish to review or remove them yourself.
