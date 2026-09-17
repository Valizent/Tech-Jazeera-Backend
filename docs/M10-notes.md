# M10 — Dashboard

The management overview that ties all eight modules together. It adds no data
of its own — it aggregates existing collections into one screen.

## What was built

**Backend** (`server/src/modules/dashboard/`)
```
dashboard.service.js     # one parallel aggregation across every module
dashboard.controller.js  # HTTP
dashboard.routes.js      # GET /api/dashboard (any authenticated user)
```

**Frontend** (`client/src/features/dashboard/`)
```
dashboard.api.js
components/StatCard.jsx          # a headline metric (optionally a link)
components/StatusBreakdown.jsx   # proportional bar chart (divs, no chart lib)
components/ExpiringDocuments.jsx # compliance alerts
components/RecentActivity.jsx    # audit-log feed with friendly labels
components/QuickActions.jsx      # role-aware create shortcuts
pages/DashboardPage.jsx          # composes it all (replaces the M3 placeholder)
```

## The single endpoint

`GET /api/dashboard` returns, in one round-trip:

- **stats** — deployed now (active deployments), active workers, on leave,
  total workers, active clients, pending quotations.
- **finance** — approved revenue (Σ grand total of Approved quotations),
  pipeline (Σ Draft), monthly payroll (Σ salaries of non-exited employees).
- **workforceByStatus** / **quotationsByStatus** — counts for the breakdowns.
- **expiringDocuments** — employee identity docs (passport/visa/iqama/medical/
  licence) and uploaded files expiring within 30 days, merged and sorted
  soonest-first.
- **recentActivity** — the latest 8 audit-log entries.

All the independent queries run under one `Promise.all`, so the whole
dashboard is a single fast request.

## Key decisions & why

- **No fabricated "profit".** The brief lists "estimated revenue/profit", but
  Phase 1 tracks no costs or expenses (purchasing/invoices are later phases).
  Rather than invent a number, the finance card shows only real figures —
  approved revenue, pipeline, and monthly payroll — with a visible note that
  profit needs cost data. Honest beats impressive.
- **One aggregation endpoint, not six.** The dashboard needs a coherent
  snapshot; a single endpoint avoids six round-trips and six loading states.
- **Charts without a charting library.** The stack is locked and a
  proportional bar breakdown is ~20 lines of divs — a dependency would buy
  nothing. (A richer chart can be added later if a real need appears.)
- **Expiring docs merge two sources.** Employee identity-document expiries
  (the compliance-critical visa/iqama/passport dates on the Employee model)
  and uploaded Document expiry dates, unified and sorted by urgency.
- **Quick actions are role-aware.** They mirror each module's write-role
  guard, so a Viewer sees none and an Accountant sees only what they can do —
  the API still enforces the real check.
- **Open to all authenticated users.** The dashboard is the landing page.
  (A production build might gate the finance figures to managers; noted, not
  done in Phase 1.)

## Common beginner mistakes

- **N+1 dashboard requests.** Fetching each stat separately is slow and
  flickery. Aggregate server-side, return one payload.
- **Counting in JavaScript after fetching everything.** Use MongoDB
  `countDocuments`/`aggregate` — never pull whole collections to `.length`
  them.
- **Inventing numbers to fill a card.** If the data can't support a metric
  (profit), say so; don't fabricate.

## Debugging tips

- A stat looks wrong? Each maps to a simple query in `dashboard.service.js` —
  check that query against the collection directly.
- Expiring list empty but you expect items? The window is 30 days and only
  documents with an `expiryDate`/identity expiry set qualify.

## Verified (2026-07-23)

**curl:** `/api/dashboard` returns correct rolled-up figures against known
data — deployed 1, active workers 2, active clients 1, pending quotations 1;
finance approved 11,500 / pipeline 1,610 / payroll 7,800 (= 2,800 + 5,000);
workforce Active 2; quotations Draft 1 / Approved 1; expiring docs sorted
soonest-first (incl. an already-expired medical); 8 recent-activity entries.

**Browser:** all sections render (stats, finance with the profit disclaimer,
two breakdown bar charts, expiring documents, recent activity, quick actions);
values match the API exactly; stat cards link to their modules; quick actions
reflect the Admin role (all five); mobile 375px has no horizontal scroll;
no console errors.
