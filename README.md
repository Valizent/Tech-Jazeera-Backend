# Tech-Jazeera Backend

Express/MongoDB API for the Valizent CRM — an internal ERP for a manpower
supply & trading company: employees, clients, deployments/mobilisations,
attendance, documents, quotations/invoices, payroll, leave, financial
requests, and a management dashboard, with a separate self-service (ESS)
portal for workers.

This is one of **two separate repos**, not a monorepo:
- **This repo** (`Tech-Jazeera-Backend`) — the API, deployed via GitHub
  Actions to a company-owned Oracle VM.
- [`Tech-Jazeera-Frontend`](https://github.com/The-Saudi-Project/Tech-Jazeera-Frontend) —
  the React client, deployed via Cloudflare Pages' own git integration.

**Read [`CLAUDE.md`](CLAUDE.md) first** — it's the project's source of truth
(architecture decisions, hard rules, security requirements, and a full
feature-by-feature status log). Then `docs/` for the how-and-why behind each
module (`docs/M<N>-notes.md` for Phase 1, `docs/P2-*`/`docs/P3-*` and
feature-named files after that).

## Stack

Node.js, Express, MongoDB Atlas via Mongoose. JWT access token (client
memory) + rotating httpOnly refresh cookie. Helmet, express-rate-limit,
Winston logging, Zod validation on every input. Uploaded documents go
through Cloudinary (not local disk). PDFs (pdfkit) and Excel exports
(exceljs) generated server-side. See `CLAUDE.md`'s "Locked stack" section
for the full, justified list.

## Setup

```bash
npm install
cp .env.example .env    # Windows: copy .env.example .env
```

Open `.env` and fill in every variable — the server validates them at boot
and refuses to start otherwise (a MongoDB Atlas URI, two JWT secrets, and a
few optional ones documented inline in `.env.example`).

```bash
npm run dev     # auto-restarts on file changes (node --watch)
```

Check it's alive: `GET http://localhost:5000/api/health` → `{ "success":
true, "message": "OK", "data": { "status": "up" } }` — deliberately minimal
(no DB/environment detail in the response — that's free reconnaissance for
anyone on the internet, not something an uptime monitor needs).

## First login

```bash
npm run seed:admin -- you@company.com YourStrongPassword "Your Name"
```

Creates (or resets) the one Admin account. Every other login is provisioned
from inside the app once you're signed in (Users module, or per-employee
account linking).

## Roles

`Admin, Manager, HR, Accounts, Coordinator, Executive, Office Secretary,
Staff, Worker` — see `user.model.js`'s own doc comment for what each one is
scoped to, and `CLAUDE.md`'s "Security requirements" section for how access
is actually enforced (Section Access grants + RBAC, re-checked server-side
on every route, never trusting the client).

## Testing & linting

```bash
npm test     # vitest — covers the highest-risk business logic and auth paths
npm run lint # eslint
```

Both run in CI on every push (`.github/workflows/ci.yml`).

## Scripts

One-off/maintenance scripts live in `src/scripts/` and are exposed as npm
scripts (`npm run <name>`) — migrations (`migrate:*`), permission grants
(`grant:*`), and `generate:vapid` for Web Push keys. Each one's own doc
comment explains what it does and when it's safe to (re-)run; migrations are
idempotent unless stated otherwise.
