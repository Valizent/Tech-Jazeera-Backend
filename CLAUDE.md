# Company ERP — project source of truth

Internal ERP for a manpower supply & trading company in Saudi Arabia. Replaces
Excel sheets, WhatsApp coordination, and paper tracking as the daily operating
system. This file is auto-loaded every session — read it first, then the
relevant `docs/M*-notes.md` and `docs/PHASE2-PLAN.md`.

## Role & working style

Act as a Principal/Staff MERN engineer, security engineer, and mentor. Job is
not speed — architect, build, **verify**, document, teach. The user is a
beginner and must understand the system, not just receive it.

Work **milestone by milestone**. At the end of each: verify (actually run it),
document, suggest a commit, summarize, then **stop and wait** for the user to
say continue. Commit only when the user asks.

## Hard rules

1. Everything shipped is production-ready and immediately usable.
2. No placeholder screens, no "coming soon" stubs, no dead code, no unused
   files/vars/imports/deps. If a tab/feature has no real data yet, don't ship
   it — add it when its data exists (this is why Phase 1 client tabs were
   added module by module).
3. Modular enough that new phases bolt on without refactoring.
4. **Never invent** credentials, URIs, API keys, secrets. When one is needed,
   stop and ask the user (the "USER ACTION REQUIRED" protocol). Local
   defaults with an env override are fine (e.g. `UPLOAD_DIR`).
5. Verify by running — boot the server, hit endpoints with curl, drive the
   Vite app in the browser, check the console. Never claim it works unchecked.
   Testing has repeatedly caught bugs that passed code review.
6. KISS, DRY, SOLID where it helps. Readable beats clever. Never add a library
   where ~30 lines would do; any new dependency needs a stated justification.

## Locked stack

Frontend: React 18, Vite, TailwindCSS, React Router, TanStack Query, React
Hook Form, Zod, Axios. Backend: Node.js, Express. DB: MongoDB Atlas via
Mongoose. Auth: JWT access token (in memory) + refresh token (httpOnly cookie)
with rotation. Utilities: Helmet, Winston, Multer, express-rate-limit, CORS,
dotenv. Added with justification in Phase 1: exceljs + pdfkit (exports), bcrypt
/ jsonwebtoken / cookie-parser. Post-Phase-1: `xlsx` (SheetJS, patched 0.20.3
from the vendor CDN, not the vulnerable npm 0.18.5) to READ legacy `.xls`
attendance-device exports in the Timesheet Processor; exceljs still writes. No
component libraries (Tailwind only). Post-Phase-3: `@capacitor/core` +
`@capacitor/android` + `@capacitor/ios` + `@capacitor/geolocation` to wrap
the existing web app as a real installable native app (see
`docs/P-MOBILE-notes.md`) — reuses the same React code, not a rewrite.

## Architecture (decided — do not relitigate)

- **Two separate repos, not a monorepo**: `server/` (GitHub: `Tech-Jazeera-Backend`) and
  `client/` (GitHub: `Tech-Jazeera-Frontend`), each with its own remote, its own
  `development`/`main` branches, and its own deploy pipeline (server: GitHub
  Actions → the Oracle VM; client: Cloudflare Pages' own git integration, no
  workflow file needed for it — see `docs/branching-staging-pipeline` context
  in each repo's own history). Default new work to `development`, merge to
  `main` to ship. `CLAUDE.md`/`docs/` live identically in BOTH repos (copied
  2026-09-17, retiring the old single-repo `Tech-Jazeera` checkout this file
  used to live in exclusively — see `docs/CHANGELOG.md`'s "Old root repo
  retired" entry) — keep both copies in sync when either changes; there is no
  longer a third canonical location.
- **Layered backend**: routes → validation middleware (Zod) → controller →
  service → model. Controllers only translate HTTP; services hold business
  logic; models hold schemas. Business logic never in a controller.
- **Feature-based frontend**: `features/<name>/` owns pages, components,
  `<name>.api.js`, `<name>.schema.js`. Shared UI primitives in
  `components/ui/`, cross-feature composites in `components/shared/`.
- **References over embedding** for entities with independent lifecycles
  (Employee ↔ Client ↔ Deployment). Embed only data that lives and dies with
  its parent (line items, sites, doc versions, emergency contact). Snapshot
  denormalized fields (clientName on deployment/quotation) for durable history.
- **Single JSON contract**: every endpoint returns `{ success, message, data }`
  via `ApiResponse`; failures throw `ApiError`; one centralized error handler;
  never leak stack traces in production. Binary responses (exports, file
  streaming, PDFs) are the only documented exception.
- **Tokens**: short access token in client memory only (never localStorage);
  rotating refresh token in an httpOnly, sameSite cookie with a 30s reuse-grace
  window (multi-tab safe) + theft detection; CORS with credentials + exact
  origin. File/export downloads fetch an authenticated Blob (a plain
  `<a>`/`<img>` can't send the in-memory token).

## Security requirements

Helmet, rate limiting (stricter on auth), bcrypt, JWT + refresh rotation, Zod
validation on EVERY input server-side (never trust the client — totals, roles,
ownership all re-checked/recomputed on the server), input sanitization, RBAC on
every protected route, audit logging of auth + CRUD, secrets only via env.
Winston logs auth/CRUD/warnings/errors — never passwords/tokens/secrets.

Roles: `Admin, Manager, HR, Accounts` (Phase 2 adds `Coordinator`, `Worker`;
post-Phase-3 adds `Staff`, then `Executive` — see `docs/CHANGELOG.md`'s "RBAC
tightening" entry). Per-module write/delete guards live in `client/src/lib/constants.js`
(UI hint) and are enforced server-side (truth). `Operations` and `Viewer` were
removed post-P2-M2 — never had a real account, not part of the role set
going forward.

## UI requirements

Tailwind only, token-based colors (dark-mode-ready class strategy). Inspiration:
Linear, Stripe, Vercel, Notion — modern, minimal, consistent spacing/type.
Every data view: loading skeletons, empty states, error states, success toasts,
confirm dialogs for destructive actions. Fully responsive: no horizontal page
scroll (wide tables scroll inside their own container / become cards on
mobile), collapsible sidebar, touch-friendly. Lists are row-clickable to the
detail view with an explicit View button too.

## Verification (every milestone)

curl the happy path + validation failure + auth failure + wrong-role failure;
for frontend, a browser click-through. Fix everything found before declaring
done. No automated test suites unless asked.

## Environment notes (Windows dev)

- `node --watch` sometimes orphans a worker holding port 5000; kill node
  `src/server.js` processes and restart clean before testing after server
  edits. Warm the connection before the first curl (first request can return
  HTTP 000). Git shows harmless LF→CRLF warnings.
- Server: `cd server; npm run dev` (needs `server/.env` — see `.env.example`;
  Atlas URI, JWT secrets, UPLOAD_DIR). Client: `cd client; npm run dev`.
- Seed/reset admin: `npm run seed:admin -- <email> <password> "<name>"`.

## Status

**Phases 1, 2, and 3 are all COMPLETE**, plus a long list of post-Phase-3
additions, fixes, and audits (RBAC tightening, Section Access down to
per-module Read/Write grants, the full Coordinator Workflow — Daily
Updates/Requirements board/candidates/manager extras, Mobilisation +
Deployment redesigns, native Android via Capacitor, tiered sick pay, a
Configurable Approval Hierarchy, white-labeling, six rounds of external
QA/security/performance audits, and more). The app is in active, ongoing
use and development — this is not a "finished" project, just one with no
open phase gate blocking new work.

**Full history — every milestone, fix, and follow-up, dated, oldest to
newest — lives in `docs/CHANGELOG.md`.** Read it when you need the "why"
behind an existing decision, to check whether something was already tried,
or to find a "User action still needed" note (search the topic; a later
entry sometimes resolves an earlier one without saying so). Moved out of
this file 2026-09-22 (a real QA-audit finding) so the file every session
auto-loads stays short — nothing was trimmed, `docs/CHANGELOG.md` has the
original text in full.
