# M8 — Document Center

File uploads (Multer) attached to employees and clients, with categories,
expiry dates, version history, in-browser preview, download, and search.

## New dependency

- **`multer`** — the standard Express middleware for `multipart/form-data`
  uploads. No hand-rolling multipart parsing.

## Configuration (new env var)

`UPLOAD_DIR` — where files are stored on disk. Relative paths resolve against
the `server/` folder; the default `./uploads` keeps files in
`server/uploads/` (gitignored). `env.js` resolves it to an absolute path and
creates the directory at boot. Point it at another disk/share in production.

## What was built

**Backend** (`server/src/modules/documents/` + `middleware/upload.js`)
```
middleware/upload.js       # Multer: type allowlist, size cap, safe UUID names
document.model.js          # dynamic-ref owner (Employee|Client); embedded versions
document.validation.js     # Zod: create / list / id / file-version
document.service.js        # create, addVersion, list/search, resolveFile, delete
document.controller.js     # HTTP; /file streams bytes
document.routes.js         # RBAC + orphan-file cleanup error handler
```

**Frontend** (`client/src/features/documents/`)
```
documents.api.js            # incl. authenticated blob fetch/download
documents.schema.js         # upload form schema + currentVersion() helper
components/DocumentUploadModal.jsx   # fixed-owner or owner-picker upload
components/DocumentPreviewModal.jsx  # inline PDF/image preview from a blob
components/DocumentActionsCell.jsx   # preview/download/new-version/delete per row
components/documentColumns.jsx       # shared Table columns
components/DocumentsPanel.jsx        # per-owner section (used on both profiles)
pages/DocumentListPage.jsx           # global center + filters
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/documents` | any authed | list/search (ownerType, owner, category, search, expiring) |
| GET | `/api/documents/:id` | any authed | one document + versions |
| GET | `/api/documents/:id/file?version=N` | any authed | stream bytes (preview/download) |
| POST | `/api/documents` | Admin/Manager/HR/Operations | upload (multipart) |
| POST | `/api/documents/:id/versions` | " | add a version |
| DELETE | `/api/documents/:id` | Admin/Manager/HR | delete (removes files from disk) |

## Key decisions & why

- **Filenames on disk are random UUIDs**, extension derived from the trusted
  MIME allowlist — never from the user's original name. So `../../x`, `x.php`,
  or a spoofed extension can't influence the path or type on disk. The
  original name is DB metadata only. This is the core upload-security control.
- **Type is an allowlist** (PDF, JPG, PNG, WEBP, Word, Excel), checked before
  the file is written; size is capped at 10 MB by Multer. Both surface as
  friendly 400s.
- **Versions are embedded, append-only.** A version is a stored file + its
  metadata, meaningless outside its document → embed rule. The current version
  is simply `versions.at(-1)`; there's no "isCurrent" flag to keep in sync.
- **Owner is a dynamic reference** (`refPath: 'ownerType'`) so one collection
  serves both employee and client documents and populates the right model.
- **Orphan-file cleanup.** Body validation runs AFTER Multer has written the
  file, so a rejected upload would leave a file behind. A router-level error
  handler unlinks `req.file` on any failure — verified: a missing-title upload
  left the on-disk file count unchanged.
- **File serving is authenticated** and streamed. Preview/download fetch the
  bytes via axios (so the in-memory token is sent) into a Blob, then render
  from an object URL — a plain `<img>`/`<a>` couldn't authenticate. Object
  URLs are revoked on modal close.
- **Delete removes files from disk** (best-effort per version) before deleting
  the DB record — verified the on-disk count drops.

## Integration

- Employee profile now separates **Identity documents** (the M4 number+expiry
  metadata) from **Documents** (uploaded files) — two distinct sections.
- Client profile gains its **Documents tab** — the tab deferred in M5, now
  backed by a real query.

## Common beginner mistakes

- **Trusting `file.originalname` for the path or extension.** Always generate
  a safe server-side name; treat the original only as a display label.
- **Serving uploads as static files without auth.** Passport scans are
  sensitive; the file route requires a valid token and streams through the app.
- **Previewing with `<img src="/api/.../file">`.** That request carries no
  Authorization header (token is in memory) → 401. Fetch a Blob instead.
- **Forgetting orphan cleanup** when validation runs after the write. Files
  accumulate silently. The router error handler prevents it.
- **Committing uploaded files.** `server/uploads/` is gitignored; keep it that
  way — it's company data, not source.

## Debugging tips

- Upload 400 "Unsupported file type" → the MIME isn't in the allowlist (see
  `middleware/upload.js`). "File is too large" → over 10 MB.
- Preview shows "can't be previewed" → it's a Word/Excel file; download to
  open. Only PDF and images render inline.
- 410 on `/file` → the DB row exists but the file is missing on disk (e.g.
  `UPLOAD_DIR` changed). Re-upload a version.

## Verified (2026-07-23)

**curl:** upload (201, UUID filename, originalName preserved) · add version
(v2) · list by owner · **download v1 byte-for-byte equals the original** ·
orphan cleanup (missing title → 400, on-disk count unchanged) · unsupported
`.txt` → 400 · Viewer upload 403 / read 200 · delete → 200 and file removed
from disk (count drops).

**Browser:** Documents center (filters, table) · **preview a PNG inline from a
blob URL** (Version 2 label, download button) · upload a new Client document
via the modal with the owner picker → appears in the list · client profile
Documents tab shows the client's file · employee profile shows distinct
Identity-documents and Documents sections · mobile 375px: cards, no horizontal
scroll · no console errors.
