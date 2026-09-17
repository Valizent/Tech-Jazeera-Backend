# Technical Architecture Report

**Repository:** Company ERP (manpower supply & trading, Saudi Arabia) + NFC digital business-card platform
**Date:** 2026-08-07 · **Branch:** `master` · **Head:** `48e1744`
**Status of this document:** every fact below was read from the codebase or measured against the live Atlas cluster. Estimates are labelled as estimates and show their arithmetic.

---

## 1. Project Overview

### Purpose

Two products in one monorepo, sharing an auth system, a design system, and a database:

1. **Internal ERP** — replaces Excel sheets, WhatsApp coordination and paper tracking as the daily operating system for a manpower-supply and trading company in Saudi Arabia. Manages the workforce (employees, their identity documents and expiries), customers, worker deployments to client sites, attendance, quotations with KSA VAT, and a management dashboard.
2. **NFC digital business-card platform** — a *separate commercial product* sold to other businesses. Physical NFC cards are written with a URL; tapping one opens a server-rendered mobile business card. Includes card inventory with a full assignment lifecycle, and (as of this milestone) tap analytics.

These are architecturally distinct: the NFC module shares nothing with the ERP domain except `User` (for admin auth) and `AuditLog`. It has its own `NfcCompany`/`NfcEmployee` collections rather than reusing `Client`/`Employee`, because NFC customers are unrelated to manpower clients.

### Primary features

**ERP (Phase 1, M1–M10 — complete):**
- Employee register with passport/visa/iqama/medical/driving-licence sub-documents and expiry tracking
- Client register with embedded sites, VAT/CR numbers
- Deployments (worker → client site), with transfer and end-of-deployment flows and a partial-unique index enforcing one active deployment per worker
- Attendance marking (bulk), summary, and Excel/PDF export
- Document management: upload, versioning, preview, expiry
- Quotations: line items, server-computed totals, 15% KSA VAT, atomic invoice-number counter, PDF generation
- Management dashboard (8 parallel aggregations)
- Audit logging of auth + all CRUD

**Phase 2 (P2-M1 complete):**
- `Worker` role, `User.employee` one-to-one link, admin-provisioned worker logins with a one-time temp password, `requireStaff` gate locking Workers out of every admin module. The web ESS portal (P2-M2) is **not built**.

**Standalone tools:**
- **Timesheet Processor** (Admin-only): ingests a monthly door-access-device Excel export (including legacy `.xls`), applies a holiday calendar, produces a salary-ready timesheet with a formatted `.xlsx` export.

**NFC platform (Phase A + B complete):**
- Card inventory: batch generation, assign/unassign/reassign/lost/return/disable/rotate-token, full assignment history
- Public server-rendered tap page per active card, brand-colour driven, with vCard "Save Contact"
- QR PNG per card, CSV of batch URLs for chip-writing
- Logo/photo upload pipeline
- **Tap analytics**: views, contact saves, per-link clicks, daily trends, country, device, platform, referrer host

### User roles

Defined in `server/src/modules/auth/user.model.js:23`:

| Role | Scope |
|---|---|
| `Admin` | Everything, including the Timesheet Processor and the entire NFC platform (both are `Admin`-only) |
| `Manager` | Employees (write), clients (write/delete), deployments (write), attendance, documents, quotations (write/delete) |
| `HR` | Employees (write/delete), attendance, documents, worker-login provisioning |
| `Accounts` | Quotations (write) |
| `Coordinator` (P2-M2) | Staff, but scoped to only the Employees assigned to them (`Employee.coordinator`) — their own team's records, leave decisions, and alerts. Cannot write company-wide data. |
| `Worker` | Self-service only. Explicitly excluded from every admin module by `requireStaff`. Lands on the ESS portal (`/me`) — My Profile, My Documents, My Leave (P2-M2). |

`Operations` and `Viewer` were removed after P2-M2 — never had a real account and aren't part of the role set going forward.

`STAFF_ROLES` is derived as `ROLES.filter(r => r !== 'Worker')` (`middleware/rbac.js`), so a future staff role is included automatically rather than by editing a list.

---

## 2. Tech Stack

| Layer | Choice | Version | Notes |
|---|---|---|---|
| **Frontend framework** | React | 18.3.1 | SPA, no SSR, no Next.js |
| Build tool | Vite | 8.1.5 | Output measured at **577 KB** (`client/dist`), single 559 KB JS chunk (163 KB gzipped) — **no code splitting** |
| Styling | TailwindCSS | 3.4.17 | Token-based colours via CSS variables; dark-mode-ready class strategy. No component library. |
| Routing | react-router-dom | 6.30.1 | `createBrowserRouter` |
| Server state | TanStack Query | 5.80.0 | 30 s `staleTime`, 1 retry, no refetch-on-focus |
| Forms | react-hook-form + @hookform/resolvers | 7.58 / 5.1 | |
| Validation (client) | Zod | 4.4.3 | UX feedback only — server re-validates everything |
| HTTP | Axios | 1.10.0 | One instance; in-memory token; 401→refresh→retry interceptor with single-flight |
| **Backend framework** | Express | 4.21.2 | **Express 4, not 5** — relevant because `req.query` is writable, which the validation middleware relies on |
| Runtime | Node.js | ≥20.6 required, running 22.18 | ESM (`"type": "module"`), top-level await used in `server.js` |
| **Database** | MongoDB Atlas | server 8.0.29 | Database name `company-erp`. 3-node replica set. **Shared tier (M0/M2/M5)** — confirmed by `hostInfo` returning `AtlasError` (blocked on shared tiers). |
| ODM | Mongoose | 8.16.0 | |
| **Authentication** | jsonwebtoken 9.0.3 + bcryptjs 3.0.3 | | JWT access (15 min, memory) + rotating refresh (7 d, httpOnly cookie) |
| **File storage** | **Local disk** via Multer 2.2.0 | | `UPLOAD_DIR` (default `server/uploads`). **No object storage. No CDN.** See §9 and §16. |
| **Caching** | **None** | | No Redis, no in-process cache, no HTTP cache headers except on `/nfc-media` (24 h) |
| **Background jobs** | **None** | | No queue, no worker process, no scheduler |
| **Scheduled jobs / cron** | **None** | | Only MongoDB TTL indexes (see §7) act on a schedule |
| **Webhooks** | **None** | | Neither inbound nor outbound |
| **External APIs/services** | **None** | | No payment provider, no email/SMS, no analytics SaaS, no error tracker, no geolocation API. Country comes from a CDN request header (zero-dependency). |
| **Deployment platform** | **None — nothing is deployed** | | See §11 |
| **CI/CD** | **None** | | No `.github/`, no pipeline config anywhere in the repo |
| Logging | Winston 3.17 | | Console in dev; JSON + `logs/error.log` + `logs/combined.log` in production |
| Security middleware | helmet 8.1, cors 2.8.5, express-rate-limit 7.5 | | |
| Documents/exports | exceljs 4.4, pdfkit 0.19, xlsx (SheetJS 0.20.3 from vendor CDN) | | SheetJS pinned to the patched vendor tarball, **not** the vulnerable npm 0.18.5 |
| QR | qrcode 1.5.4 | | |

**Total production dependencies: 16 server, 8 client.** `node_modules` measures 91 MB (server) and 83 MB (client).

---

## 3. System Architecture — request flow for an NFC tap

### 3.1 The tap-page flow (public, unauthenticated)

```
Physical NFC card (NTAG213/215)
  │  NDEF record: a URL written to the chip, e.g. https://cards.example.com/c/F0jbxEg0WIRu
  │  Token = 12 random base62 chars (~71 bits entropy), never derived from a name
  ↓
Phone NFC radio → OS handler
  │  iOS ≥14: background tag reading shows a notification banner; Android: intent
  │  NO APP REQUIRED — the OS opens the default browser
  ↓
Browser issues GET https://<PUBLIC_BASE_URL>/c/F0jbxEg0WIRu
  ↓
DNS resolution  →  (currently: none — PUBLIC_BASE_URL is unset, defaults to http://localhost:5000)
  │  Intended production: A/AAAA (or CNAME) → CDN edge
  ↓
CDN / reverse proxy  (intended: Cloudflare — see §16)
  │  · terminates TLS
  │  · adds CF-IPCountry: SA   ← the ONLY source of the analytics country field
  │  · adds X-Forwarded-For    ← req.ip depends on `app.set('trust proxy', 1)`,
  │                              which is only enabled when NODE_ENV=production
  ↓
Node.js / Express  (server/src/app.js — single process, no cluster mode)
  │  1. helmet()                 app-wide security headers
  │  2. cors()                   exact origin CLIENT_URL, credentials: true
  │  3. express.json({1mb})
  │  4. cookieParser()
  │  5. apiLimiter               mounted on /api ONLY — /c/* bypasses it
  │  ↓  routing: app.use('/c', nfcPublicRoutes)   ← NOT under /api, NOT the SPA
  ↓
/c router (nfc.public.routes.js)
  │  a. per-response CSP nonce  (crypto.randomBytes(16))
  │  b. route-scoped helmet CSP — REPLACES the app-wide policy:
  │       script-src 'self' 'nonce-…'      (app default 'self' silently blocked
  │                                          the page's inline script)
  │       no upgrade-insecure-requests     (app default rewrote the page's own
  │                                          http image URLs to https, breaking
  │                                          every logo/photo on a LAN trial)
  │  c. publicCardLimiter        120 req / 15 min PER IP
  │  d. TOKEN_RE pre-check       /^[A-Za-z0-9]{6,24}$/ — rejects before any DB hit
  ↓
nfc.service.getPublicCardByToken(token)
  ↓
MongoDB Atlas — ONE query, index-backed
  │  NfcCard.findOne({ token, status: 'active', employee: { $ne: null } })
  │    .populate('employee').populate('company')
  │  → unique index on `token` = O(log n), then 2 _id lookups for the populates
  │  → returns whitelisted public fields ONLY (no ids, no idNumber, no notes)
  │     plus a server-only `ref` bag of ObjectIds used for analytics attribution
  ↓
  ├─ null?  →  404 with an IDENTICAL information-free page for unknown /
  │             inactive / lost / unassigned / rotated-away tokens.
  │             A scanner cannot distinguish these cases.
  ↓
nfc.publicPage.renderProfilePage()
  │  String-concatenated HTML. Every interpolated value HTML-escaped.
  │  Inline <style> + inline <script nonce="…">. No external assets, no framework.
  ↓
HTTP 200 text/html  →  response sent to the browser
  ↓
recordTapEvent({ type: 'view' })   ← FIRED AFTER res.send(), NOT awaited
  │  · isBot() drops crawlers/unfurlers (WhatsApp fetches the page to build a
  │    link preview — would otherwise inflate every number)
  │  · 30-min dedupe per visitor hash so a reload isn't a second visitor
  │  · visitor = sha256(dailySalt : ip : ua : cardId).slice(0,32)
  │    the IP is hash input only — never stored
  │  · insert into nfctapevents; failure is logged and swallowed
  ↓
Browser renders
  │  · loader → card rise → staggered action rows (CSS animations)
  │  · GET /nfc-media/<uuid>.png  ×2 (company logo + person photo)
  │      served from local disk, Cache-Control: public, max-age=86400,
  │      Cross-Origin-Resource-Policy: cross-origin (so og:image can render)
  ↓
User interaction
  ├─ "Save Contact"  → GET /c/:token/vcard → vCard 3.0, CRLF, escaped
  │                    → recordTapEvent({ type: 'save' })
  └─ Call / WhatsApp / Email / Website / LinkedIn / Location
                       → the <a href> fires natively (tel:, mailto:, https:)
                       → navigator.sendBeacon('/c/:token/e', {target})
                         RELATIVE url — survives the page being reached on a
                         LAN IP or tunnel host that differs from PUBLIC_BASE_URL
                       → server answers 204 BEFORE doing any work, and answers
                         204 even for unknown tokens so it can't probe them
                       → recordTapEvent({ type: 'click', target })
```

### 3.2 The admin-app flow (authenticated SPA)

```
Browser → GET https://<client-host>/  → static index.html + JS bundle (Vite build)
  ↓
React boots → AuthContext runs ONE POST /api/auth/refresh (httpOnly cookie)
  ├─ 200 → access token into a module-level JS variable (NEVER localStorage)
  └─ 401 → redirect to /login
  ↓
Every API call: axios → Authorization: Bearer <access token>, withCredentials: true
  ↓
Express /api/* → apiLimiter (600/15min/IP)
  ↓
requireAuth (verify JWT) → requireStaff/requireRoles (RBAC) → validate (Zod)
  ↓  → controller (HTTP translation only) → service (business logic) → Mongoose model
  ↓
MongoDB Atlas
  ↓
{ success, message, data }  ← single JSON envelope, every endpoint
  ↓
TanStack Query cache (30 s staleTime) → React renders
```

**Access token expiry (every 15 min):** any 401 triggers the axios interceptor → single-flight `POST /api/auth/refresh` → rotate → replay the original request. Screens never observe it.

---

## 4. Folder Structure

```
Al Jazeera CRM/
├── CLAUDE.md                       # project source of truth (auto-loaded by the agent)
├── README.md
├── .gitignore
├── client/
│   ├── index.html
│   ├── vite.config.js              # deliberately minimal — no dev proxy, so dev
│   │                               #   exercises the real cross-origin + cookie path
│   ├── tailwind.config.js          # design tokens → CSS variables
│   ├── postcss.config.js
│   ├── vercel.json                 # ⚠ UNTRACKED, unused — SPA rewrite only
│   ├── dist/                       # build output (gitignored), 577 KB
│   └── src/
│       ├── main.jsx
│       ├── index.css
│       ├── app/
│       │   ├── AppProviders.jsx
│       │   ├── router.jsx          # all routes + RequireAuth guard
│       │   └── layouts/
│       │       ├── AuthLayout.jsx
│       │       └── DashboardLayout.jsx   # sidebar, role-filtered nav
│       ├── components/
│       │   ├── ui/                 # 12 primitives: Badge Button Card EmptyState
│       │   │                       #   Input Modal Select Skeleton Spinner Table
│       │   │                       #   Textarea Toast
│       │   └── shared/             # ConfirmDialog ExpiryBadge PageHeader
│       ├── lib/
│       │   ├── axios.js            # the single API instance + token + interceptor
│       │   ├── constants.js        # API_URL + per-module write/delete role hints
│       │   ├── queryClient.js
│       │   └── utils.js            # cn, apiMessage, formatDate, formatMoney, timeAgo…
│       └── features/               # feature-based; each owns pages/components/api/schema
│           ├── auth/               # AuthContext, auth.api, auth.schema, LoginPage
│           ├── dashboard/
│           ├── employees/          # + WorkerLoginPanel (P2-M1)
│           ├── clients/
│           ├── deployments/
│           ├── attendance/
│           ├── documents/
│           ├── quotations/
│           ├── timesheetProcessor/
│           └── nfc/
│               ├── nfc.api.js  nfc.schema.js  nfc.constants.js
│               ├── components/     # AssignCardModal BatchGenerateModal
│               │                   #   NfcCompanyFormModal NfcEmployeeFormModal
│               │                   #   CardAnalyticsPanel NfcAnalyticsBits
│               └── pages/          # NfcCompanyListPage NfcCompanyProfilePage
│                                   #   NfcCardListPage NfcCardDetailPage
│                                   #   NfcAnalyticsPage
├── server/
│   ├── package.json
│   ├── .env.example                # every var documented; .env is gitignored
│   ├── uploads/                    # ⚠ LOCAL DISK storage (gitignored)
│   │   ├── <uuid>.pdf|png          #   ERP documents (7 files, ~690 KB today)
│   │   └── nfc/<uuid>.png          #   NFC logos & photos (2 files, ~60 KB today)
│   └── src/
│       ├── server.js               # boot: env → DB → listen; SIGINT/SIGTERM graceful shutdown
│       ├── app.js                  # middleware order + route mounting
│       ├── config/
│       │   ├── env.js              # the ONLY place touching process.env; validates at boot, exits on error
│       │   ├── db.js               # mongoose.connect + connection event listeners
│       │   └── logger.js           # Winston
│       ├── middleware/
│       │   ├── auth.js             # requireAuth (JWT verify)
│       │   ├── rbac.js             # requireRoles, requireStaff, STAFF_ROLES
│       │   ├── validate.js         # Zod on params/query/body; replaces req[part] with parsed output
│       │   ├── upload.js           # Multer for ERP documents (10 MB cap)
│       │   ├── rateLimiter.js      # apiLimiter, loginLimiter, publicCardLimiter, publicEventLimiter
│       │   └── errorHandler.js     # notFoundHandler + the single error → HTTP translator
│       ├── utils/
│       │   ├── ApiError.js  ApiResponse.js  asyncHandler.js
│       ├── scripts/
│       │   └── seed-admin.js       # npm run seed:admin -- <email> <password> "<name>"
│       └── modules/                # layered: routes → validation → controller → service → model
│           ├── auth/               # auth.{routes,controller,service,validation}.js
│           │                       #   user.model.js  refreshToken.model.js
│           ├── audit/
│           ├── employees/
│           ├── clients/
│           ├── deployments/
│           ├── attendance/         # + attendance.export.js (Excel/PDF)
│           ├── documents/
│           ├── quotations/         # + quotation.pdf.js, counter.model.js
│           ├── dashboard/          # service only, no model
│           ├── timesheetProcessor/ # constants parser processor time export
│           │                       #   service controller routes validation
│           └── nfc/
│               ├── nfc.routes.js           # admin API (Admin-only)
│               ├── nfc.public.routes.js    # /c/* — unauthenticated, own CSP + limiters
│               ├── nfc.controller.js  nfc.service.js  nfc.validation.js
│               ├── nfc.publicPage.js       # server-rendered tap page HTML
│               ├── nfc.vcard.js            # vCard 3.0 builder
│               ├── nfc.token.js            # 12-char base62 token generation
│               ├── nfc.upload.js           # Multer + /nfc-media serving
│               ├── nfc.visitor.js          # request → privacy-safe analytics context
│               ├── nfc.analytics.service.js# recordTapEvent + $facet aggregations
│               └── nfc{Company,Employee,Card,Batch,Assignment,TapEvent}.model.js
└── docs/
    ├── M1..M10-notes.md            # per-milestone developer notes (Phase 1)
    ├── P2-M1-notes.md
    ├── PHASE2-PLAN.md
    ├── timesheet-processor-notes.md
    ├── nfc-customers-notes.md
    ├── nfc-card-writing-guide.md
    └── ARCHITECTURE.md             # this file
```

---

## 5. Backend

### Routes (route files)

| File | Mount | Guard applied at router level |
|---|---|---|
| `auth/auth.routes.js` | `/api/auth` | none (public + cookie) |
| `audit/audit.routes.js` | `/api/audit` | per-route `requireAuth` + `requireRoles('Admin')` |
| `employees/employee.routes.js` | `/api/employees` | `requireAuth`, `requireStaff` |
| `clients/client.routes.js` | `/api/clients` | `requireAuth`, `requireStaff` |
| `deployments/deployment.routes.js` | `/api/deployments` | `requireAuth`, `requireStaff` |
| `attendance/attendance.routes.js` | `/api/attendance` | `requireAuth`, `requireStaff` |
| `documents/document.routes.js` | `/api/documents` | `requireAuth`, `requireStaff` + a module-local Multer error handler |
| `quotations/quotation.routes.js` | `/api/quotations` | `requireAuth`, `requireStaff` |
| `dashboard/dashboard.routes.js` | `/api/dashboard` | `requireAuth`, `requireStaff` |
| `timesheetProcessor/timesheet.routes.js` | `/api/timesheet-processor` | `requireAuth`, `requireRoles('Admin')` |
| `nfc/nfc.routes.js` | `/api/nfc` | `requireAuth`, `requireRoles('Admin')` |
| `nfc/nfc.public.routes.js` | `/c` | **none** — public, own CSP + rate limiters |

Plus two non-router handlers in `app.js`: `GET /api/health` and `GET /nfc-media/:filename`.

### Controllers

`auth`, `audit`, `employee`, `client`, `deployment`, `attendance`, `document`, `quotation`, `dashboard`, `timesheet`, `nfc`. Controllers only translate HTTP — they read `req`, call a service, and shape the response. Business logic never lives here (an architectural rule stated in `CLAUDE.md` and observed consistently in the code).

Documented exceptions to the `{ success, message, data }` envelope, all binary:
- `GET /api/quotations/:id/pdf` → `application/pdf`
- `GET /api/attendance/export` → xlsx / pdf
- `GET /api/documents/:id/file` → streamed original file
- `GET /api/nfc/cards/:id/qr.png` → `image/png`
- `GET /api/nfc/batches/:id/cards.csv` → `text/csv`
- `POST /api/timesheet-processor/export` → xlsx
- `/c/*` → `text/html`, `text/vcard`, and `204`

### Services

`auth.service`, `audit.service`, `employee.service`, `client.service`, `deployment.service`, `attendance.service`, `document.service`, `quotation.service`, `dashboard.service`, `timesheet.service`, `nfc.service`, `nfc.analytics.service`.

Notable logic:
- `auth.service` — token issuance, rotation, reuse detection, 30 s grace window, bcrypt cost 12, timing-safe login (compares against a dummy hash when the user doesn't exist)
- `quotation.service` — server-recomputed totals; the client's numbers are never trusted
- `deployment.service` — transfer/end flows; partial-unique index guards one active deployment per worker
- `nfc.service` — card lifecycle; `assignCard` closes the prior open assignment first so reassign is one step
- `nfc.analytics.service` — `recordTapEvent` (never throws, never awaited) + three `$facet` aggregations

### Middleware

| Middleware | Purpose |
|---|---|
| `helmet()` | app-wide security headers |
| `cors()` | exact origin (`env.clientUrl`), `credentials: true` |
| `express.json({ limit: '1mb' })` | body parsing with a DoS cap |
| `cookieParser()` | reads the httpOnly refresh cookie |
| `apiLimiter` | 600 req / 15 min / IP on `/api` |
| `loginLimiter` | 30 req / 15 min / IP on `POST /api/auth/login` only |
| `publicCardLimiter` | 120 req / 15 min / IP on `/c/*` |
| `publicEventLimiter` | 400 req / 15 min / IP on `POST /c/:token/e` |
| `requireAuth` | verifies the access JWT, populates `req.user` |
| `requireRoles(...)` | RBAC; validates role names at boot, not request time |
| `requireStaff` | every role except `Worker` |
| `validate({params,query,body})` | Zod; **replaces** `req[part]` with parsed output (strips unknown keys, applies transforms) |
| `uploadDocument` / `uploadNfcImage` | Multer, disk storage, UUID filenames from a trusted MIME map |
| route-scoped `helmet.contentSecurityPolicy` | `/c/*` only — nonce-based script-src |
| `notFoundHandler` | 404 for unmatched routes |
| `errorHandler` | the single error→HTTP translator; now guards `res.headersSent` |

### Models

16 collections — see §7.

### Utilities

- `utils/ApiError.js` — operational errors with `statusCode`, `details`, `isOperational`
- `utils/ApiResponse.js` — the `{ success, message, data }` envelope
- `utils/asyncHandler.js` — wraps async route handlers so rejections reach `errorHandler`
- `config/env.js` — the only file reading `process.env`; validates and freezes at boot
- `nfc/nfc.token.js`, `nfc/nfc.vcard.js`, `nfc/nfc.visitor.js`
- `timesheetProcessor/timesheet.{parser,processor,time,export}.js`
- `quotations/quotation.pdf.js`, `attendance/attendance.export.js`

### Scheduled jobs

**None.** The only time-based behaviour in the entire system is MongoDB's TTL monitor, which runs every 60 s inside Atlas and expires:
- `refreshtokens` when `expiresAt` passes
- `nfctapevents` 400 days after `at`

There is no application-level scheduler. Notably, **document expiry does not notify anyone** — expiries are surfaced only when someone loads the dashboard.

### Webhooks

**None**, inbound or outbound.

### Background workers

**None.** Every operation is synchronous within the request. This matters for three heavy paths that currently block the single event loop:
- Timesheet processing (SheetJS parses an entire `.xls` into memory)
- Excel export (`exceljs` builds the whole workbook in memory)
- PDF generation (`pdfkit`)

---

## 6. Frontend

### Pages

| Route | Component | Access |
|---|---|---|
| `/login` | `LoginPage` | guest |
| `/` | `DashboardPage` | staff |
| `/employees` `/employees/new` `/employees/:id` `/employees/:id/edit` | Employee pages | staff |
| `/clients` `/clients/new` `/clients/:id` `/clients/:id/edit` | Client pages | staff |
| `/deployments` `/deployments/new` | Deployment pages | staff |
| `/attendance` | `AttendancePage` (Mark / Records / Summary tabs) | staff |
| `/documents` | `DocumentListPage` | staff |
| `/quotations` `/quotations/new` `/quotations/:id` `/quotations/:id/edit` | Quotation pages | staff |
| `/timesheet-processor` | `TimesheetProcessorPage` | Admin |
| `/nfc` | `NfcCompanyListPage` | Admin |
| `/nfc/:id` | `NfcCompanyProfilePage` | Admin |
| `/nfc/cards` | `NfcCardListPage` | Admin |
| `/nfc/cards/:id` | `NfcCardDetailPage` | Admin |
| `/nfc/analytics` | `NfcAnalyticsPage` | Admin |
| `*` | redirect to `/` | — |

Route order note: `/nfc/analytics` is registered **before** `/nfc/:id`, otherwise "analytics" would be parsed as a company id.

### Components

- **UI primitives (12):** `Badge` `Button` `Card` `EmptyState` `Input` `Modal` `Select` `Skeleton` `Spinner` `Table` `Textarea` `Toast`. `Table` is responsive by construction — it renders a real table on desktop and label/value cards on mobile, with `hideOnMobile` per column, plus built-in loading skeletons and empty states.
- **Shared composites (3):** `ConfirmDialog` `ExpiryBadge` `PageHeader`
- **Feature components:** forms and panels per feature; NFC adds `AssignCardModal`, `BatchGenerateModal`, `NfcCompanyFormModal`, `NfcEmployeeFormModal`, `CardAnalyticsPanel`, `NfcAnalyticsBits` (stat tiles, CSS-bar trend, breakdown lists, range picker).

### Routing

`createBrowserRouter` with a nested guard:
```
AuthLayout        → /login
RequireAuth       → shows a full-screen spinner while status === 'loading'
  └ DashboardLayout → all authenticated routes
```
`RequireAuth` deliberately shows a spinner rather than redirecting during session restore — redirecting a logged-in user to `/login` for half a second on every reload is the classic bug this avoids.

Client-side role checks (`if (!isAdmin) return <Navigate to="/" replace />`) are **UI hints only**; the server enforces the same rules independently.

### State management

- **Server state:** TanStack Query. Query keys are namespaced per feature (`['nfc-card', id]`, `['nfc-analytics', days]`). Mutations invalidate related keys explicitly.
- **Auth state:** one React context (`AuthContext`) holding `{ user, status }`.
- **Local UI state:** `useState` within components.
- **No Redux/Zustand/Jotai.** For an app whose state is almost entirely server-owned, this is the right call.

### API communication

Single Axios instance (`lib/axios.js`) with:
- `baseURL` from `lib/constants.js` (`API_URL`)
- `withCredentials: true` (required for the refresh cookie; works only because CORS names an exact origin)
- Request interceptor attaching `Authorization: Bearer <token>` from a module-level variable
- Response interceptor: on 401 (non-`/auth/*`, not already retried) → single-flight refresh → replay. On refresh failure → clear token, notify subscribers → login screen.

Binary downloads (`PDF`, `xlsx`, `CSV`, `QR PNG`) are fetched as authenticated Blobs and turned into object URLs — a plain `<a href>` or `<img src>` cannot send an in-memory bearer token.

### Authentication flow

```
Login form (Zod-validated)
  → POST /api/auth/login {email, password}
  → 200 { user, accessToken } + Set-Cookie: refreshToken (httpOnly, 7 d, path=/api/auth)
  → accessToken into memory; user into AuthContext

Page reload (token lost — by design)
  → AuthContext boot: POST /api/auth/refresh (cookie only)
  → 200 { user, accessToken } — session restored in one call
  → 401 → guest → /login

Access token expiry (every 15 min)
  → any 401 → interceptor → refresh → rotate → replay original request

Logout
  → POST /api/auth/logout → deletes this device's refresh row, clears cookie
  → other devices stay logged in
```

---

## 7. Database

Database `company-erp` on MongoDB Atlas (shared tier, MongoDB 8.0.29). **16 collections.**

**Measured live totals (2026-08-07):** `dataSize` 38,811 B · `storageSize` 598,016 B · `indexSize` 1,941,504 B · 189 documents.
Index size dwarfs data size only because each empty index still allocates ~36 KB of pages — not representative of behaviour at scale.

| # | Collection | Purpose | Main fields | Relationships | Indexes | Measured avgObjSize |
|---|---|---|---|---|---|---|
| 1 | `users` | Login accounts | `name`, `email` (unique, lowercase), `passwordHash` (`select:false`), `role` (enum, 7 values), `isActive`, `employee` | `employee → Employee` (optional 1-1) | `_id`; `email` unique; **partial unique** on `employee` where `$type: objectId` | 235 B |
| 2 | `refreshtokens` | Active sessions | `tokenHash` (SHA-256, unique), `user`, `expiresAt`, `rotatedAt` | `user → User` | `_id`; `tokenHash` unique; `user`; **TTL** `expiresAt` (`expireAfterSeconds: 0`) | 197 B |
| 3 | `employees` | Workforce register | `employeeId` (unique, uppercase), `fullName`, `nationality`, `mobile`, `email`, `passport`/`visa`/`iqama`/`medical`/`drivingLicense` (embedded `{number, expiry}`), `joiningDate`, `designation`, `department`, `salary`, `accommodation`, `currentClient`, `currentSite`, `status`, `emergencyContact`, `notes` | `currentClient → Client` | `_id`; `employeeId` unique; `fullName`; `createdAt:-1` | 642 B |
| 4 | `clients` | Customer register | `companyName`, `contactPerson`, `phone`, `email`, `address`, `vatNumber`, `crNumber`, `industry`, `sites[]` (embedded), `status`, `notes` | — | `_id`; `companyName`; `createdAt:-1` | 576 B |
| 5 | `deployments` | Worker → client site | `worker`, `client`, `clientName` (snapshot), `site` (snapshot), `vehicle`, `driver`, `shift`, `startDate`, `endDate`, `status`, `endReason`, `notes` | `worker → Employee`, `client → Client` | `_id`; **partial unique** `uniq_active_worker` on `worker` where `status:'Active'`; `worker+startDate:-1`; `client+status`; `startDate:-1` | 292 B |
| 6 | `attendances` | Daily status | `employee`, `date` (UTC midnight), `status` (enum), `note` | `employee → Employee` | `_id`; **unique** `{employee, date}`; `date` | 135 B |
| 7 | `documents` | Files + versions | `title`, `category`, `ownerType`, `owner` (`refPath`), `expiryDate`, `versions[]` (`version`, `fileName` UUID, `originalName`, `mimeType`, `size`, `uploadedBy`, `uploadedAt`) | polymorphic `owner → Employee|Client` via `refPath: ownerType` | `_id`; `{ownerType, owner}`; `expiryDate` | 679 B |
| 8 | `quotations` | Sales quotes | `quotationNumber` (unique), `client`, `clientName` (snapshot), `date`, `validUntil`, `status`, `lineItems[]` (`type`,`description`,`quantity`,`unitPrice`,`discount`,`taxRate`), `subtotal`, `discountTotal`, `taxTotal`, `grandTotal`, `notes` | `client → Client` | `_id`; `quotationNumber` unique; `client`; `status`; `createdAt:-1` | 471 B |
| 9 | `counters` | Atomic sequence for quote numbers | `_id` (name), `seq` | — | `_id` | 42 B |
| 10 | `auditlogs` | Auth + CRUD trail | `user`, `action`, `targetType`, `targetId`, `meta` (free-form object), `ip`, `createdAt` | `user → User` (nullable — failed logins have no user) | `_id`; `createdAt:-1` | 185 B |
| 11 | `nfccompanies` | NFC customer businesses | `companyName`, `contactPerson`, `phone`, `email`, `website`, `address`, `mapLink`, `city`, `brandColour` (hex), `logo` (filename), `notes` | — | `_id`; `companyName` | 497 B |
| 12 | `nfcemployees` | People on NFC cards | `company`, `name`, `jobTitle`, `phone`, `whatsapp`, `email`, `linkedin`, `bio`, `photo` (filename), `idNumber` (internal), `notes` (internal) | `company → NfcCompany` | `_id`; `company`; `name` | 285 B |
| 13 | `nfccards` | Physical card inventory | `token` (unique), `chipUid`, `batch`, `status` (enum: unassigned/active/lost/returned/disabled), `employee`, `company`, `assignedAt`, `issuedAt` | `employee → NfcEmployee`, `company → NfcCompany`, `batch → NfcBatch` | `_id`; `token` unique; `batch`; `status`; `company`; **partial unique** `chipUid` where `$type: string` | 198 B |
| 14 | `nfcbatches` | A run of blank cards | `label`, `note`, `count`, `createdBy` | `createdBy → User` | `_id`; `createdAt:-1` | 122 B |
| 15 | `nfcassignments` | Card↔person history | `card`, `employee`, `company`, `assignedAt`, `unassignedAt` (null = current), `assignedBy` | `card → NfcCard`, `employee → NfcEmployee`, `company → NfcCompany` | `_id`; `card`; `{card, assignedAt:-1}` | 193 B |
| 16 | `nfctapevents` | Tap analytics | `card`, `employee`, `company`, `type` (view/save/image/click), `target`, `at`, `country`, `device`, `platform`, `referrerHost`, `visitor` (daily-salted hash) | `card → NfcCard`, `employee → NfcEmployee`, `company → NfcCompany` | `_id`; **TTL** `{at:1}` 400 d; `{card, type, at:-1}`; `{company, at:-1}` | 238 B |

**Relationship style:** references, never embedding, for entities with independent lifecycles. Embedding is used only for data that lives and dies with its parent (`sites`, `lineItems`, `versions`, `emergencyContact`, identity sub-documents). Denormalised snapshots (`clientName` on deployments and quotations) preserve durable history when the parent is later renamed.

**Referential integrity is application-level.** MongoDB has no foreign keys; deletes are handled explicitly in services (deleting an NFC company frees its cards back to `unassigned` and closes open assignment rows). There is no orphan-detection job.

---

## 8. API

**73 endpoints.** "Auth" column: `—` = public, `Cookie` = refresh cookie only, otherwise a valid access token plus the listed roles.

### Health
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/api/health` | Liveness + uptime + Mongoose connection state | — |

### Auth — `/api/auth`
| Method | URL | Purpose | Auth |
|---|---|---|---|
| POST | `/login` | Email+password → user + access token, sets refresh cookie | — (rate-limited 30/15min) |
| POST | `/refresh` | Rotate refresh token → new access token + user | Cookie |
| POST | `/logout` | Delete this device's session | Cookie |

### Audit — `/api/audit`
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | Paginated audit trail (`?page&limit`) | Admin |

### Employees — `/api/employees` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | List (paginated, search, status, sort) | any staff |
| GET | `/:id` | One employee | any staff |
| POST | `/` | Create | Admin, Manager, HR |
| PATCH | `/:id` | Update | Admin, Manager, HR |
| DELETE | `/:id` | Delete | Admin, HR |
| POST | `/:id/user` | Provision a Worker login (temp password returned once) | Admin, HR |

### Clients — `/api/clients` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | List (paginated, search, status, industry) | any staff |
| GET | `/:id` | One client | any staff |
| POST | `/` | Create | Admin, Manager |
| PATCH | `/:id` | Update | Admin, Manager |
| DELETE | `/:id` | Delete | Admin, Manager |

### Deployments — `/api/deployments` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | List (paginated, worker/client/status filters) | any staff |
| GET | `/:id` | One deployment | any staff |
| POST | `/` | Assign a worker to a site | Admin, Manager |
| POST | `/:id/transfer` | Move to a different client/site | Admin, Manager |
| POST | `/:id/end` | End with a reason | Admin, Manager |

### Attendance — `/api/attendance` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| POST | `/bulk` | Mark many employees for a date | Admin, Manager, HR |
| GET | `/` | Records for a date range (hard cap 10,000) | any staff |
| GET | `/summary` | Aggregated per-employee summary | any staff |
| GET | `/export` | Excel or PDF export | any staff |

### Documents — `/api/documents` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | List (paginated, owner/category/search/expiring) | any staff |
| GET | `/:id` | One document + versions | any staff |
| GET | `/:id/file` | Stream the latest (or a specific) version | any staff |
| POST | `/` | Upload a new document (10 MB) | Admin, Manager, HR |
| POST | `/:id/versions` | Upload a new version | Admin, Manager, HR |
| DELETE | `/:id` | Delete document + files | Admin, Manager, HR |

### Quotations — `/api/quotations` (all: staff only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | List (paginated, client/status/search) | any staff |
| GET | `/:id` | One quotation | any staff |
| GET | `/:id/pdf` | Generated PDF | any staff |
| POST | `/` | Create (totals recomputed server-side) | Admin, Manager, Accounts |
| POST | `/:id/duplicate` | Clone into a new draft | Admin, Manager, Accounts |
| PATCH | `/:id` | Update | Admin, Manager, Accounts |
| DELETE | `/:id` | Delete | Admin, Manager |

### Dashboard — `/api/dashboard`
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/` | 8 parallel aggregations (counts, status breakdowns, expiring docs, recent activity) | any staff |

### Timesheet Processor — `/api/timesheet-processor` (Admin only)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| POST | `/preview` | Upload device Excel → parsed preview | Admin |
| POST | `/export` | Upload + holiday calendar → formatted `.xlsx` | Admin |

### NFC admin — `/api/nfc` (**Admin only, every route**)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/analytics` | Platform-wide analytics (`?days=1..365`, default 30) | Admin |
| GET | `/cards/:id/analytics` | One card's analytics | Admin |
| GET | `/companies/:id/analytics` | One company's analytics + per-person breakdown | Admin |
| GET | `/companies` | List companies (`?search`) — **not paginated** | Admin |
| POST | `/companies` | Create company | Admin |
| GET | `/companies/:id` | Company + its people + their active cards | Admin |
| PATCH | `/companies/:id` | Update company | Admin |
| DELETE | `/companies/:id` | Delete company; frees its cards | Admin |
| POST | `/companies/:id/logo` | Upload logo (2 MB, PNG/JPG/WEBP) | Admin |
| DELETE | `/companies/:id/logo` | Remove logo | Admin |
| POST | `/employees` | Add a person | Admin |
| PATCH | `/employees/:id` | Update person | Admin |
| DELETE | `/employees/:id` | Remove person; frees their card | Admin |
| POST | `/employees/:id/photo` | Upload photo (2 MB) | Admin |
| DELETE | `/employees/:id/photo` | Remove photo | Admin |
| POST | `/batches` | Generate N blank cards (1–100) | Admin |
| GET | `/batches` | List batches — **not paginated** | Admin |
| GET | `/batches/:id/cards.csv` | CSV of tokens + URLs for chip writing | Admin |
| GET | `/cards` | Card inventory (`?search&status&company&batch`) — **not paginated** | Admin |
| GET | `/cards/:id` | Card + assignment history | Admin |
| GET | `/cards/:id/qr.png` | QR of the card's public URL | Admin |
| PATCH | `/cards/:id` | Set chip UID | Admin |
| POST | `/cards/:id/assign` | Assign to a person | Admin |
| POST | `/cards/:id/unassign` | Free the card | Admin |
| POST | `/cards/:id/lost` | Mark lost — kills the URL instantly | Admin |
| POST | `/cards/:id/return` | Return to inventory | Admin |
| POST | `/cards/:id/disable` | Disable | Admin |
| POST | `/cards/:id/rotate` | New token; old URL dies immediately | Admin |

### Public (unauthenticated)
| Method | URL | Purpose | Auth |
|---|---|---|---|
| GET | `/c/:token` | The tap page (HTML) | — (120/15min/IP) |
| GET | `/c/:token/vcard` | vCard 3.0 download | — (120/15min/IP) |
| POST | `/c/:token/e` | Click beacon; always 204 | — (400/15min/IP) |
| GET | `/nfc-media/:filename` | Logos & photos | — |

---

## 9. File Storage

### Where images are stored

**On the server's local filesystem.** There is no object storage and no CDN.

- Root: `UPLOAD_DIR` (env, resolved to an absolute path at boot; default `server/uploads`). `config/env.js` `mkdir -p`s it at startup.
- **ERP documents:** `UPLOAD_DIR/<uuid>.<ext>` — passports, visas, contracts. Served **authenticated** through `GET /api/documents/:id/file`, streamed after an RBAC check.
- **NFC logos & photos:** `UPLOAD_DIR/nfc/<uuid>.<ext>` — served **publicly and unauthenticated** at `GET /nfc-media/<filename>`.

Filenames are always `crypto.randomUUID()` plus an extension taken from a **trusted MIME map**, never from the user's filename. This defeats both path traversal and extension-spoofing at the point of naming. `serveNfcMedia` additionally applies `path.basename()` and a `/^[\w.-]+$/` guard.

Current footprint: 7 files, ~690 KB (ERP) + 2 files, ~60 KB (NFC).

### Upload limits

| Path | Max size | Allowed types |
|---|---|---|
| ERP documents (`middleware/upload.js`) | **10 MB** | per `ALLOWED_TYPES` MIME map (PDF + images) |
| NFC logo/photo (`nfc/nfc.upload.js`) | **2 MB** | `image/png`, `image/jpeg`, `image/webp` |
| JSON request bodies | **1 MB** | — |

### CDN usage

**None.** `/nfc-media` sets `Cache-Control: public, max-age=86400` and `Cross-Origin-Resource-Policy: cross-origin`, so it is *ready* to sit behind a CDN, but nothing is in front of it today.

### Critical gaps

1. **No image processing whatsoever.** A 2 MB photo straight off a phone is stored as-is and delivered as-is on every first tap. There is no resize, no re-encode, no thumbnail, no WebP/AVIF conversion. This is the single largest bandwidth and mobile-performance cost in the product (§12, §14).
2. **Local disk is incompatible with most PaaS and with horizontal scaling.** See §16 — this is the #1 change to make before deploying.
3. **No virus scanning** on uploaded documents.
4. **No orphan cleanup job.** Deletes are handled inline (`deleteNfcMedia` on replace/remove/delete), but a crash between the DB write and the unlink leaves a stranded file forever.

---

## 10. Security

### Authentication
- **Access token:** JWT HS256, `{ sub, role }`, **15 min** TTL, held in a module-level JavaScript variable — never `localStorage`/`sessionStorage`, so XSS cannot read it.
- **Refresh token:** JWT HS256, `{ sub, jti: randomUUID }`, **7 day** TTL, delivered in an httpOnly cookie. The `jti` exists because two tokens minted for the same user in the same second would otherwise be byte-identical and collide on the `tokenHash` unique index.
- **Storage:** only the SHA-256 **hash** of the refresh token is persisted, so a database leak does not yield usable session tokens.
- **Rotation:** every refresh consumes the old token and issues a new one — single use.
- **Reuse detection:** a validly-signed refresh token presented after rotation, outside a **30 s grace window**, revokes *every* session for that user and forces re-login. The grace window exists because all browser tabs share one cookie and race to refresh when the access token dies; without it, normal multi-tab use would trigger false theft alarms.
- **Timing-safe login:** when the email doesn't exist, bcrypt still runs against a dummy hash, so "unknown email" and "wrong password" take the same time and cannot be used to enumerate accounts. All three failure modes (no user / bad password / deactivated) return the identical 401 message.

### Authorization
- `requireAuth` → `requireRoles(...)` / `requireStaff`, always in that order.
- `requireStaff` is mounted at the **router** level (`router.use`) on every admin module, not per-route. This deliberately covers the read routes that would otherwise ask only for `requireAuth` — precisely where a `Worker` would otherwise leak into company-wide data.
- `requireRoles` validates role spellings **at boot**, so `requireRoles('Adm1n')` crashes the server on startup rather than silently denying everyone at runtime.
- Client-side role checks exist in `lib/constants.js` and page guards, and are explicitly documented as UI hints — the server is the sole authority.

### Password hashing
- **bcrypt (bcryptjs), cost factor 12** (~100 ms/hash). `passwordHash` is `select: false`, so it is excluded from every query unless explicitly opted in.
- Provisioned worker passwords: 14 chars from a 56-char look-alike-free alphabet (~81 bits), generated with `crypto.randomBytes`, surfaced to the admin **once**, never logged or stored in plaintext.

### JWT / session configuration
```js
// auth.controller.js
{ httpOnly: true,
  secure: env.isProduction,   // HTTPS-only in production
  sameSite: 'lax',
  path: '/api/auth',          // the cookie is sent to the refresh endpoint only
  maxAge: 7 days }
```
Two **different** secrets (access vs refresh), each required to be ≥32 chars by `config/env.js` — the server refuses to boot otherwise.

⚠ **`sameSite: 'lax'` constrains deployment topology.** A `lax` cookie is sent on same-*site* requests. `app.example.com → api.example.com` is same-site and works. `myapp.vercel.app → myapi.onrender.com` is **cross-site**, the cookie will not be sent, and authentication will silently break on every page reload. See §16.

### Rate limiting
| Limiter | Scope | Budget |
|---|---|---|
| `apiLimiter` | `/api/*` | 600 / 15 min / IP |
| `loginLimiter` | `POST /api/auth/login` | 30 / 15 min / IP |
| `publicCardLimiter` | `/c/*` | 120 / 15 min / IP |
| `publicEventLimiter` | `POST /c/:token/e` | 400 / 15 min / IP |

⚠ All use express-rate-limit's default **in-memory** store. With more than one instance each keeps its own counter, so the effective limit becomes N × configured. A shared store (Redis) is required before horizontal scaling.

### CORS
`origin: env.clientUrl` — an **exact** origin, never `*`, with `credentials: true`. A wildcard origin is incompatible with credentialed requests, so this is load-bearing, not cosmetic.

### Helmet / security headers
`helmet()` app-wide (verified live): CSP, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Origin-Agent-Cluster`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-Permitted-Cross-Domain-Policies: none`, `X-DNS-Prefetch-Control: off`.

`/c/*` **replaces** that CSP with a route-scoped policy: `script-src 'self' 'nonce-<random>'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`, and **no** `upgrade-insecure-requests`. Both deviations are deliberate and documented in the route file.

### Input validation
Zod on **every** `params`, `query`, and `body` across every route, via `middleware/validate.js`, which replaces `req[part]` with the parsed output — unknown keys stripped, transforms applied. Money totals, roles, and ownership are always recomputed or re-checked server-side; the client's numbers are never trusted.

### XSS protection
- **Admin SPA:** React escapes by default. There is **no** `dangerouslySetInnerHTML` anywhere in the client.
- **Public tap page:** hand-rolled HTML, so every interpolated value passes through `h()` (escapes `& < > " '`). Only whitelisted public fields reach the renderer. The CSP nonce means an injected `<script>` cannot execute even if escaping were bypassed.
- Access token in memory (not `localStorage`) limits the blast radius of any XSS that did land.

### CSRF protection
Defence is **structural rather than token-based**, and it holds:
1. The access token travels in an `Authorization` header, which a cross-site form or image cannot set — so every `/api/*` route except the three auth routes is inherently immune.
2. The refresh cookie is scoped `path=/api/auth` and `sameSite=lax`, so it is not sent on cross-site POSTs.
3. CORS names one exact origin.

⚠ Residual risk: if the cookie is ever loosened to `SameSite=None` for a split-domain deployment, `POST /api/auth/refresh` becomes CSRF-reachable and would need a proper anti-CSRF token or a double-submit pattern. **No CSRF token library is present today.**

### MongoDB injection prevention
- No `$where`, no `eval`, no `mapReduce`, no string-built queries anywhere (verified by grep).
- **The real defence is Zod.** Express 4's `qs` parser turns `?search[$ne]=x` into an object; `z.string()` rejects it with a 400 before it ever reaches a query. `express-mongo-sanitize` is not installed and is not needed given universal Zod coverage.
- **ReDoS/regex-injection:** every user string used in a `$regex` is escaped first. Confirmed in `client.service.js`, `document.service.js`, `employee.service.js`, `nfc.service.js` (both call sites), and `quotation.service.js` (inline). **Coverage is complete.**
- ObjectId params validated by `/^[a-f0-9]{24}$/i` before reaching Mongoose.

### Audit logging
`auditlogs` records `auth.login.success`, `auth.login.failed`, `auth.logout`, `auth.refresh.reuse_detected`, and every CRUD action across modules, with actor, target, IP and a `meta` object. Winston never logs passwords, tokens, or secrets.

### Analytics privacy (PDPL-relevant)
Tap-page visitors are members of the public. The system stores **no IP address, no full user agent, no full referrer**. `visitor` is `sha256(dailySalt : ip : ua : cardId)` truncated to 32 hex chars, where `dailySalt = sha256("nfc-analytics:" + JWT_ACCESS_SECRET + ":" + UTC-date)` — derived from an existing secret with domain separation rather than inventing a new one, and rotated daily so cross-day tracking is not computable even by the database owner. Only the referrer's **host** is kept. Rows self-delete after 400 days.

---

## 11. Current Hosting

> **Nothing is deployed. There is no production environment.**

This is a local development project. Verified configuration on this machine:

| Item | Actual state |
|---|---|
| **Frontend** | Not deployed. Vite dev server on `http://localhost:5173`. `client/dist` builds to 577 KB but is not published anywhere. |
| **Backend** | Not deployed. `node --watch src/server.js` on `http://localhost:5000`. `NODE_ENV=development`. |
| **Database** | **MongoDB Atlas** — the only real cloud service in use. Database `company-erp`, 3-node replica set, MongoDB 8.0.29. **Shared tier (M0/M2/M5)** — `hostInfo` returns `AtlasError`, which Atlas only does on shared tiers. On M0 specifically there are **no automated backups**. |
| **Domain** | None registered/configured. |
| **DNS** | None. |
| **SSL/TLS** | None. `secure: env.isProduction` means the refresh cookie is currently sent without the `Secure` flag, which is correct for local http and wrong the moment this is exposed. |
| **CDN** | None. |
| **Environment variables** | `NODE_ENV=development`, `PORT=5000`, `CLIENT_URL=http://localhost:5173`, `UPLOAD_DIR=./uploads`, `MONGODB_URI` (Atlas), `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PUBLIC_BASE_URL` **unset → defaults to `http://localhost:5000`**. All validated at boot by `config/env.js`; the process exits with a specific message if any is missing or malformed. |
| **Render services** | None. |
| **Cron jobs** | None. Only Atlas's internal TTL monitor. |
| **Storage** | Local disk (`server/uploads`). No S3/Spaces/R2/GCS. |
| **CI/CD** | None. No `.github/workflows`, no pipeline config of any kind. |
| **Monitoring / error tracking / uptime** | None. |
| `client/vercel.json` | Present but **untracked in git and unused** — a bare SPA rewrite rule. It is the only artefact hinting at an intended deployment target. |

**One live-traffic observation.** The `nfctapevents` collection currently holds **10 real events** against the production `Al Jazeera Support Contracting Co` card, timestamped today 13:56–13:57, from Windows/desktop and iOS/mobile, with `country: "SA"` resolved. Country can only be populated from a CDN/proxy request header, so at least some of that traffic reached the server through a proxy — consistent with an ad-hoc `cloudflared tunnel` as described in `docs/nfc-card-writing-guide.md`. That is a temporary tunnel, not a deployment: `PUBLIC_BASE_URL` is still unset and `NODE_ENV` is still `development`.

---

## 12. Performance

### Current bottlenecks, ranked by real impact

1. **Unoptimised images on the tap page.** A 2 MB photo is stored and served raw. At ~695 KB per fresh tap (§14), images are ~97% of tap-page bytes. On a Saudi mobile connection this is the difference between a card that opens in under a second and one that visibly loads — for a product whose entire value is the first impression.
2. **No response compression.** The `compression` middleware is **not installed**. Every JSON response and every tap page goes out uncompressed. The tap page is ~12–15 KB of highly repetitive HTML/CSS that would gzip to roughly 3–4 KB.
3. **No pagination on the NFC list endpoints.** `listCards`, `listCompanies` and `listBatches` return **every** matching row. Phase 1 modules all paginate (`?page&limit`, capped at 100); the NFC module — the one intended to scale to thousands of cards — does not. At 10,000 cards, `GET /api/nfc/cards` returns roughly a 3–5 MB JSON payload plus three `populate` round trips, and `NfcCardListPage` renders every row.
4. **Client bundle is one 559 KB chunk** (163 KB gzipped), with no route-based code splitting. Vite warns about it on every build. An admin who only uses the NFC module still downloads pdfkit-adjacent screens, the timesheet processor, and every other feature.
5. **Dashboard runs 8 aggregations per load**, uncached, including two `Employee.aggregate` `$group` passes and a `Document.find` on `expiryDate`. Fine today; it is the first thing to feel slow as `employees` and `documents` grow, because `staleTime` is only 30 s.
6. **Synchronous heavy work on the single event loop.** Timesheet parsing (whole `.xls` in memory via SheetJS), Excel export (exceljs), and PDF generation (pdfkit) all block. One admin exporting a large attendance report stalls every concurrent request, including public tap pages.
7. **`auditlogs` has no TTL and no cap** — see §15.
8. **`attendance.listAttendance` has a hard `.limit(10_000)`** with no pagination — a silent truncation rather than an error.

### Database queries

Generally well-indexed. Specifically good:
- The public tap lookup is a single unique-index hit on `token` plus two `_id` populates — the hottest path in the product is also the cheapest.
- Analytics use one `$facet` aggregation per screen: many pipelines over one pass of the matched documents, so a panel's six numbers cost one round trip rather than six.
- Every list filter is backed by an index; `$regex` searches are anchored to indexed fields.

Weaknesses:
- `$regex` search without `^` anchoring cannot use an index prefix and degenerates to a collection scan on `employees`/`clients`/`nfcemployees` as they grow. A text index or Atlas Search is the eventual answer.
- `listCards` issues a separate `NfcEmployee.find` to resolve the search term, then the main query with three `populate` calls — 5 round trips per search.
- `getOverviewAnalytics` runs `NfcTapEvent.distinct('card', ...)` over the whole window; `distinct` does not use an index efficiently on high-cardinality fields and will become the slowest part of that endpoint.

### Pagination

| Module | Paginated? | Default / max |
|---|---|---|
| Employees, Clients | ✅ | 10 / 100 |
| Deployments, Documents, Quotations, Audit | ✅ | 20 / 100 |
| Attendance | ⚠ hard cap only | 10,000, no paging |
| **NFC companies / cards / batches** | ❌ **none** | returns everything |
| NFC analytics | n/a | `days` capped at 365 |

### Caching

**None at any layer.** No Redis, no in-process memoisation, no `ETag`/`Last-Modified` on API responses, no `stale-while-revalidate`. The only cache headers in the system are `Cache-Control: public, max-age=86400` on `/nfc-media`. Client-side, TanStack Query's 30 s `staleTime` is the entire caching story.

### Compression

**None.** No `compression` middleware, no Brotli. (A CDN in front would add this for free — another argument for putting Cloudflare in the path.)

### Static asset optimisation

- Vite handles minification, tree-shaking, and content-hashed filenames.
- ❌ No code splitting / lazy routes
- ❌ No image optimisation pipeline
- ❌ No font subsetting (the tap page relies on system fonts, which is actually optimal)
- ❌ No `client/dist` deployment target, so no immutable-asset caching configured anywhere

---

## 13. Scale Expectations

Definitions used throughout: a **customer** is one `NfcCompany` (a business buying NFC cards); a **cardholder** is one `NfcEmployee` with an active card. Assumed **10 cardholders per customer**.

### Architectural ceilings (what breaks first, not what's desirable)

| Dimension | Practical ceiling on the current architecture | What breaks |
|---|---|---|
| **Businesses (`NfcCompany`)** | ~5,000 before the admin UI degrades | `GET /api/nfc/companies` returns all rows unpaginated |
| **NFC cards** | ~5,000–10,000 | `GET /api/nfc/cards` unpaginated; ~3–5 MB JSON and a full client-side render |
| **Cards (DB capability alone, if paginated)** | Tens of millions | `token` unique index is O(log n); this is not the constraint |
| **Daily taps** | ~500,000/day on one 2-vCPU instance | Not CPU — the tap page is string concatenation. The binding limits are outbound bandwidth (images) and Atlas write throughput on `nfctapevents` |
| **Peak concurrent users (admin)** | ~50–100 | Single Node process; bcrypt at cost 12 (~100 ms) serialises logins; heavy exports block the loop |
| **API requests/minute** | ~3,000–6,000 sustained on one instance | Express + Mongoose overhead; the `apiLimiter` caps a single IP at 600/15 min = 40/min |
| **Per-IP tap ceiling** | **120 per 15 minutes** | ⚠ `publicCardLimiter`. A trade-show stand where every visitor is behind one mobile-carrier NAT, or one office behind one WAN IP, will hit this and start serving 429s to real customers. **This is the most likely production incident in the whole system.** |

### Realistic trajectory

| Stage | Customers | Cardholders | Taps/day | Peak concurrent admins | API req/min (peak) |
|---|---|---|---|---|---|
| MVP | 1–10 | ~100 | 30–100 | 1–2 | <60 |
| Early | 100 | ~1,000 | ~1,000 | 3–5 | ~200 |
| Growth | 1,000 | ~10,000 | ~10,000 | 10–20 | ~800 |
| Scale | 10,000 | ~100,000 | ~100,000 | 50–100 | ~4,000 |

Tap distribution is assumed to be business-hours weighted (~70% within 8 hours), so 100,000 taps/day ≈ **1.2 req/s average, ~30–50 req/s peak**. Compute is genuinely not the problem at any of these stages.

### Database growth after 1 year

Event volume dominates everything else. Measured `nfctapevents` `avgObjSize` = **238 B**; 4 indexes.

**Per-event storage planning figure:** 238 B data + ~165 B of index keys ≈ 400 B raw. WiredTiger's snappy compression on data (~2.5:1) and index prefix compression (~1.5:1) bring this to roughly 205 B. **Using 250 B/event for planning.**

**Events per tap** (measured ratio during verification: 72 views : 37 saves : 72 clicks) = **2.5 events/tap**.

At 30 taps/cardholder/month → 75 events/month → 900/year. The 400-day TTL caps steady state at ~1.1 years ≈ **1,000 events/cardholder ≈ 250 KB/cardholder**.

| After 1 year | Cardholders | Tap events | Event storage | Core NFC + ERP data | **DB total** |
|---|---|---|---|---|---|
| 100 customers | 1,000 | ~0.9 M | ~250 MB | ~1 MB | **~260 MB** |
| 1,000 customers | 10,000 | ~9 M | ~2.5 GB | ~10 MB | **~2.6 GB** |
| 10,000 customers | 100,000 | ~90 M | ~25 GB | ~100 MB | **~26 GB** |

---

## 14. Resource Usage

### RAM

- Node + Express + Mongoose + 16 models + the loaded module set: **~90–130 MB RSS** at idle.
- **Spikes are the sizing constraint, not the baseline.** SheetJS reads an entire `.xls` into memory; exceljs builds whole workbooks in memory; pdfkit buffers. A 5,000-row attendance export or a large timesheet file can transiently add **200–400 MB**.
- **Recommendation: 1 GB minimum per instance.** A 512 MB instance will survive normal traffic and then OOM the first time someone exports a big report — an intermittent failure that is miserable to diagnose.

### CPU

- Tap page render: string concatenation, **<1 ms**.
- QR generation: ~5–15 ms.
- **bcrypt cost 12: ~100 ms of pure CPU per login** — the single hottest CPU operation in the system, and it serialises.
- Aggregations execute on Atlas, not on the app server.
- PDF/Excel generation: 100 ms–seconds, blocking.
- **1 vCPU suffices to ~10,000 taps/day; 2 vCPU to ~100,000.**

### Storage

**Uploaded images** — the dominant figure, and entirely a consequence of having no resize pipeline. Assuming 600 KB average photo (straight from a phone, capped at the 2 MB limit) and 80 KB average logo:

| Cardholders | Photos | Logos | **Current (raw)** | **With a 512 px WebP pipeline (~40 KB/12 KB)** |
|---|---|---|---|---|
| 1,000 | 600 MB | 8 MB | **~610 MB** | **~41 MB** |
| 10,000 | 6.0 GB | 80 MB | **~6.1 GB** | **~410 MB** |
| 100,000 | 60 GB | 800 MB | **~61 GB** | **~4.1 GB** |

**~15× reduction** from one image pipeline. Server logs add ~1–5 GB/year unrotated (Winston writes `error.log` and `combined.log` with **no rotation configured** — an unbounded disk-fill risk).

### Bandwidth

Per **fresh** tap (cold cache), current state:

| Component | Bytes |
|---|---|
| HTML (uncompressed) | ~14 KB |
| Person photo | ~600 KB |
| Company logo | ~80 KB |
| vCard (if saved) | ~0.3 KB |
| Click beacon | ~0.2 KB |
| **Total** | **~695 KB** |

With gzip + an image pipeline: ~4 KB + 40 KB + 12 KB ≈ **56 KB — a 12× reduction.**

| Stage | Taps/day | **Current** | **Optimised** |
|---|---|---|---|
| 100 customers | 1,000 | 695 MB/day → **~21 GB/mo** | ~56 MB/day → **~1.7 GB/mo** |
| 1,000 customers | 10,000 | 6.95 GB/day → **~209 GB/mo** | 560 MB/day → **~17 GB/mo** |
| 10,000 customers | 100,000 | 69.5 GB/day → **~2.1 TB/mo** | 5.6 GB/day → **~168 GB/mo** |

(`max-age=86400` on media means repeat visitors within a day cost only the HTML, so real-world figures land somewhat below these — but tap pages are overwhelmingly seen by *first-time* visitors, which is the whole point of a business card.)

### Database size

Combining §13 with index overhead, and noting Atlas sizes clusters by both storage **and** working-set RAM:

| Stage | DB size after 1 yr | Working set | Suitable Atlas tier |
|---|---|---|---|
| MVP | <100 MB | tiny | M0 free (⚠ no backups) |
| 100 customers | ~260 MB | ~150 MB | **M10** (2 GB RAM, 10 GB) |
| 1,000 customers | ~2.6 GB | ~800 MB | **M10**, headroom to M20 |
| 10,000 customers | ~26 GB | ~4–6 GB | **M30** (8 GB RAM, 40 GB) |

---

## 15. Production Readiness

### Missing production features (blocking)

1. **No deployment of any kind** — no host, domain, DNS, or TLS.
2. **No CI/CD** — no automated build, test, or deploy.
3. **File storage on local disk** — incompatible with PaaS ephemeral filesystems and with running more than one instance.
4. **No automated database backups** (Atlas M0 provides none).
5. **`PUBLIC_BASE_URL` undecided** — and it is physically written into NFC chips. See §16.
6. **No pagination on NFC list endpoints.**
7. **No compression, no image optimisation.**
8. **In-memory rate-limit store** blocks horizontal scaling.
9. **No automated tests of any kind** — no unit, integration, or E2E suite. Verification to date has been manual plus purpose-written scripts.
10. **P2-M2 (ESS portal) unbuilt**, so the `Worker` role can log in but has no destination.

### Security improvements

| Priority | Item |
|---|---|
| High | Resolve the `SameSite` question **before** choosing a deployment topology (§16, item 7) |
| High | Move secrets into a managed secret store; rotate `JWT_*` secrets before go-live since they have existed only in a local `.env` |
| High | Add a CSRF token if the refresh cookie ever becomes `SameSite=None` |
| Medium | Virus-scan uploaded documents (ClamAV or an API) |
| Medium | Add account lockout after N failed logins (rate limiting alone is per-IP, so it doesn't stop slow distributed guessing at one account) |
| Medium | Enforce a password policy on `seed-admin` and worker provisioning |
| Medium | Restrict Atlas network access to the app's egress IPs (currently must allow the developer's IP) |
| Medium | Re-examine `publicCardLimiter` — 120/15 min/IP will 429 real users behind carrier NAT |
| Low | Add 2FA for `Admin` |
| Low | Add `Permissions-Policy` and consider CSP reporting |

### Monitoring

**Nothing exists.** Minimum viable set:
- Uptime checks against `GET /api/health` (which already reports Mongoose connection state) — UptimeRobot/BetterStack, free tier
- Error tracking — Sentry (free tier covers this volume)
- Atlas built-in metrics + alerts on connections, disk, slow queries
- A tap-success-rate alert: a spike in 404s from `/c/*` means cards are failing in the field, which is a business emergency

### Logging

Winston is well-configured (levels, timestamps, JSON in production, no secrets). Gaps:
- **No log rotation** — `combined.log` grows without bound and will eventually fill the disk
- **No centralised aggregation** — logs die with an ephemeral container
- No request-id / correlation-id, so a single request cannot be traced across log lines

### Backups

- **Atlas M0 has no backups.** This is the most serious operational gap. M10+ includes continuous backup with point-in-time restore.
- **Uploaded files have no backup at all.** On local disk with no snapshot or replication, a disk loss destroys every passport scan, contract, logo and photo.
- No tested restore procedure.

### Disaster recovery

No DR plan, no documented RTO/RPO, no runbook. With Atlas M0 and local-disk uploads, **a server loss today is unrecoverable for files and possibly for data.**

### High availability

None. Single Node process, single instance, no load balancer, no health-check-driven restart, no multi-AZ. Atlas provides a 3-node replica set, so the database layer is the only HA component in the system. `server.js` does implement graceful shutdown on `SIGINT`/`SIGTERM`, which means it is *ready* for rolling deploys.

### Health checks

`GET /api/health` exists and returns uptime, environment, and Mongoose connection state — genuinely useful, correctly reports a dead DB without reading logs. It is not wired to any monitor or orchestrator today.

---

## 16. Infrastructure Recommendation

### The finding that should drive the decision

**Compute is never the cost driver for this application. MongoDB Atlas is.**

The workload is one small Node process (a tap page is string concatenation), a static SPA, and image delivery. At every stage past MVP, Atlas is **60–70% of the bill**. Choosing Hetzner over Render saves $50–150/month; right-sizing the Atlas tier and controlling tap-event retention saves more. Any hosting debate that focuses on the app server is optimising the wrong line item.

### Recommendation: **Render** for MVP → ~1,000 customers, then reassess against **Hetzner**

Not because Render is cheapest — it is not — but because it matches this project's actual constraints:

- **No CI/CD exists.** Render deploys from a Git push with zero pipeline configuration. That closes the single largest operational gap for free.
- **Managed TLS, health checks, graceful restarts.** `server.js` already handles `SIGTERM`, so rolling deploys work correctly on day one.
- **The operator is a beginner.** Hetzner's price advantage is real and large, but it is paid for in OS patching, TLS renewal, firewall rules, log rotation, backup scripting and monitoring — all currently missing, all of which Render provides or makes trivial.
- **Static SPA hosting is free** on Render, with correct immutable-asset caching.

**Deploy Cloudflare in front from day one (free tier).** This is the highest-leverage infrastructure decision available and it is independent of the origin choice:
1. It supplies the `CF-IPCountry` header the analytics module **already reads** — the country feature only works behind a CDN.
2. It adds the gzip/Brotli compression the app lacks.
3. It caches `/nfc-media`, which is 97% of tap bandwidth.
4. **It decouples the card URL from the origin.** Because NFC chips are physically written with a URL, the domain must never change. With Cloudflare in front, migrating Render → Hetzner → AWS is a DNS change that no customer's card ever notices. Without it, the origin hostname is baked into physical plastic.

**Use Cloudflare R2 for images** (S3-compatible, **zero egress fees** — decisive for an image-heavy public product; the same traffic on S3 or DO Spaces is billed per GB).

### On regional hosting for a Saudi business

AWS (Bahrain `me-south-1`, UAE `me-central-1`) and Google Cloud (Dammam `me-central2`) offer in-region hosting, which is genuinely relevant if data residency becomes a PDPL requirement or a customer contract term. **Do not choose them for latency**: with Cloudflare in front (PoPs in Jeddah and Riyadh), the tap page is served from inside Saudi Arabia regardless of where the origin sits. Revisit only if data residency becomes a hard requirement — and note that **Atlas can be pinned to `me-south-1` independently of where the app runs**, which satisfies most residency concerns without moving the app.

### Cost projections

Assumes Cloudflare Free, R2 for images, and 10 cardholders per customer.

**MVP (≤10 customers, ~100 cards, ~100 taps/day)**
| Item | Cost |
|---|---|
| Render Web Service (Starter, 512 MB) | $7 |
| Render Static Site (client) | $0 |
| Atlas M0 | $0 ⚠ no backups |
| Cloudflare Free + R2 (<10 GB free tier) | $0 |
| Domain (~$14/yr) | ~$1 |
| **Total** | **~$8/mo** |
| *With backups (Atlas M10) — strongly advised before real customer data* | **~$65/mo** |

**100 customers (~1,000 cards, ~1,000 taps/day, ~610 MB images, ~260 MB DB)**
| Item | Cost |
|---|---|
| Render Standard (2 GB) | $25 |
| Atlas M10 (2 GB RAM, 10 GB, PITR backups) | ~$57 |
| R2 (0.6 GB, egress free) | ~$0 |
| Cloudflare Free | $0 |
| **Total** | **~$83/mo** |

**1,000 customers (~10,000 cards, ~10,000 taps/day, ~6 GB images, ~2.6 GB DB)**
| Item | Cost |
|---|---|
| Render Standard × 2 (HA) | $50 |
| Redis (shared rate-limit store — now mandatory) | ~$10 |
| Atlas M10 → M20 as aggregations grow | $57–147 |
| R2 (6 GB) | ~$0.10 |
| Cloudflare Pro (optional) | $0–20 |
| **Total** | **~$120–230/mo** |

**10,000 customers (~100,000 cards, ~100,000 taps/day, ~61 GB images, ~26 GB DB)**
| Item | Render | Hetzner |
|---|---|---|
| Compute | Pro × 2 — $170 | 2 × CCX23 (4 dedicated vCPU/16 GB) + LB — ~€55 (~$60) |
| Redis | $30 | included on-box |
| Atlas M30 (8 GB RAM, 40 GB) | $390 | $390 |
| R2 (61 GB) | ~$1 | ~$1 |
| Cloudflare Pro | $20 | $20 |
| **Total** | **~$610/mo** | **~$470/mo** |

The crossover where Hetzner's savings justify the operational burden is around **1,000–10,000 customers** — and even there it is ~$140/month, while Atlas is $390. **Migrate the database tier thoughtfully before migrating the app host.**

---

### Architectural decisions to change **now** to avoid expensive migrations later

Ordered by cost-of-delay.

**1. Decide the permanent card domain before writing any production chip. — IRREVERSIBLE**
`PUBLIC_BASE_URL` is written into physical NFC hardware. Once a customer's card carries `https://cards.yourdomain.com/c/TOKEN`, that hostname must resolve forever or the card is dead plastic. Changing it later means physically re-writing every chip in the field (`rotate` issues a new token but cannot reach into someone's wallet). Register the domain, point it at Cloudflare, and set `PUBLIC_BASE_URL` **before** the 10-card trial becomes a 1,000-card order. *This is the only genuinely irreversible decision in the entire system.*

**2. Move uploads from local disk to S3-compatible object storage (R2).**
Blocks: running more than one instance, zero-downtime deploys, and survival of a container restart on any PaaS. Both upload paths already funnel through narrow interfaces (`nfc.upload.js`, `middleware/upload.js`), so this is a storage adapter behind an existing seam today — and a data migration plus URL rewrite plus a period of broken images later.

**3. Add pagination to the NFC list endpoints.**
`GET /api/nfc/cards`, `/companies`, `/batches` return everything. The Phase 1 modules already implement exactly the pattern to copy (`?page&limit`, capped at 100, returning `{items,total,page,pages}`). Cheap now; a UI rewrite plus an API contract break once the admin screens depend on unpaginated arrays.

**4. Move the rate-limit store to Redis before running a second instance.**
With N instances the effective limit silently becomes N × configured — a security control that degrades invisibly rather than failing loudly.

**5. Put a TTL or cap on `auditlogs`.**
It is written on every auth event and every CRUD, has no expiry, and will become the second-largest collection. `nfctapevents` already models the fix (a TTL index). Decide the retention period as a business/compliance question now, while the collection is 138 documents.

**6. Add `compression` middleware and an image-resize pipeline.**
Roughly a 12× bandwidth reduction (§14) for maybe a day of work. Every month without it is money spent on serving 2 MB phone photos, and every tap is slower than it needs to be.

**7. Resolve the cookie/topology question before splitting the client and API across different sites.**
The untracked `client/vercel.json` points toward client-on-Vercel + API-elsewhere. With `sameSite: 'lax'`, that topology **silently breaks authentication** — the refresh cookie is never sent, and every page reload logs the user out. Two options: (a) keep them same-site (`app.yourdomain.com` + `api.yourdomain.com`) and change nothing, or (b) switch to `SameSite=None; Secure` **and add CSRF protection**, which the app does not currently have. Option (a) is strongly preferred and costs nothing — but it must be chosen before DNS is set up, not after.

**8. Move off Atlas M0 before storing real customer data.**
No backups. Everything else on this list is recoverable; data loss is not.

**9. Add route-based code splitting.**
One `React.lazy` per route group. Ten minutes of work, and it stops the bundle from growing into a problem that requires a build-system overhaul to unpick.
