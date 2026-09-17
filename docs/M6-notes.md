# M6 — Worker Deployment

The milestone that finally populates `Employee.currentClient` / `currentSite`
(built in M4, referenced by M5). It introduces the Deployment entity and the
assign / transfer / unassign lifecycle, with a real double-assignment guard.

## What was built

**Backend** (`server/src/modules/deployments/`)
```
deployment.model.js       # schema + the partial-unique double-assignment index
deployment.validation.js  # Zod: assign / transfer / list / id schemas
deployment.service.js     # assign / transfer / end / list — with transactions
deployment.controller.js  # HTTP translation only
deployment.routes.js      # RBAC-guarded routes
```
Also extended employees: an `unassigned` list filter, and `getEmployee` now
populates `currentClient`'s name for the profile.

**Frontend** (`client/src/features/deployments/`)
```
deployments.api.js
deployments.schema.js              # assign + transfer form schemas
components/DeploymentForm.jsx      # client→site dependent dropdown; assign & transfer
components/WorkerDeploymentPanel.jsx  # the deployment section on an employee profile
pages/DeploymentListPage.jsx       # the register (all placements) + filters
pages/DeploymentNewPage.jsx        # assign a worker
```

## API

| Method | Path | Roles | Purpose |
|--------|------|-------|---------|
| GET | `/api/deployments` | any authed | register / history (filters: worker, client, status) |
| GET | `/api/deployments/:id` | any authed | one deployment |
| POST | `/api/deployments` | Admin/Manager/Operations | assign a worker |
| POST | `/api/deployments/:id/transfer` | " | end current + create new placement |
| POST | `/api/deployments/:id/end` | " | end (unassign) |

No DELETE — deployments are immutable history; "end" closes an active one.

## The lifecycle

```
assign   → new Active deployment; employee.currentClient/Site set
transfer → current Active → Ended (reason Transferred); new Active created
end      → current Active → Ended (reason Unassigned); employee current* cleared
```
Every one of these touches TWO documents (the Deployment and the Employee's
current* fields), so each runs inside a **MongoDB transaction** — the two can
never drift apart. Atlas is a replica set, so transactions are available.

## The double-assignment guard (two layers)

1. **Service check** — `assignWorker` looks for an existing Active deployment
   and returns a friendly 409 if found.
2. **Database index** — a *partial unique* index enforces "at most one Active
   deployment per worker" at the storage layer, immune to races:
   ```js
   { worker: 1 }, { unique: true, partialFilterExpression: { status: 'Active' } }
   ```

### The bug this milestone caught
The first version ALSO declared `index: true` on the `worker` field. That
created a plain `worker_1` index, and because the (then-unnamed) partial index
also wanted the name `worker_1`, MongoDB **silently skipped creating it** — so
the DB guard did not exist. A direct two-insert test exposed it (both Active
inserts succeeded). Fixes: (a) removed the field-level `index: true`; (b) gave
the guard an explicit name (`uniq_active_worker`); (c) ran `syncIndexes()` to
drop the stale index and build the correct one. Re-tested: the second Active
insert is now blocked with E11000, while Ended inserts (history) are allowed.
Lesson: never declare an index both ways, and always verify a guard by trying
to violate it — not just by reading the code.

## Key decisions & why

- **`clientName` and `site` are string snapshots** on the deployment, captured
  at assignment. History must stay readable even if the client is renamed, a
  site is removed, or the client is eventually deleted. The `client` ref is
  kept too, for linking while it still exists.
- **Site must be one of the client's registered sites.** `resolveClientSite`
  validates this, which also lets the UI present the site field as a dropdown
  populated from the chosen client. Deploying to an inactive client is blocked.
- **On Leave workers are deployable; Exited are not.** The server blocks only
  Exited; the assign form's worker picker was initially too strict (Active
  only) and hid On-Leave workers — fixed to "unassigned and not Exited" so the
  form matches the server rule.
- **Transfer/End live on the employee profile**, assign on its own page/the
  register. Managing one worker's placement is most natural from that worker.

## Frontend patterns worth reusing

- **Dependent dropdown** (`DeploymentForm`): `watch('client')` drives the site
  `<option>`s from that client's embedded sites; changing the client resets
  the site so a stale value can't be submitted.
- **Self-contained panel** (`WorkerDeploymentPanel`): owns its own queries and
  mutations (transfer modal, end confirm, history) so the host profile page
  stays thin. The transfer form is the same `DeploymentForm` in "no worker"
  mode, shown inside a `Modal`.

## Common beginner mistakes

- **Declaring an index twice** (`index: true` + `schema.index`) — silently
  breaks the intended index. Pick one; name partial/unique indexes explicitly.
- **Updating two documents without a transaction** — a mid-way failure leaves
  `currentClient` and the deployment inconsistent.
- **Forgetting to invalidate `['employee', id]` after a deployment change** —
  the profile would show a stale placement. The panel invalidates deployments,
  the employee, and the employees list.
- **Trusting the form to prevent double-assignment** — it helps (only shows
  unassigned workers), but the API 409 and DB index are the real guards.

## Debugging tips

- "already deployed" (409) on assign = the worker has an Active deployment.
  Transfer or end it first.
- `"<site>" is not a registered site` (400) = the site isn't in the client's
  sites list. Add it on the client, or pick another.
- Index guard not firing? `Deployment.syncIndexes()` and inspect
  `collection.indexes()` — confirm `uniq_active_worker` is UNIQUE + partial.

## Verified (2026-07-23)

**curl:** assign (201, currentClient/Site set) · double-assign (409) · bad
site (400) · transfer (200: old Ended/Transferred, new Active, current* moved)
· history (worker populated) · end (200: worker unassigned) · end-again (400)
· HR assign (403) / HR read (200) · **direct DB double-Active insert blocked
(E11000)** while Ended history insert allowed.

**Browser:** deployments register with filters · employee profile "not
deployed" + Assign · assign flow with worker preselect + client→site dependent
dropdown → success → active card (client/site/vehicle/driver) · transfer via
modal → active moves, history grows · end via confirm → unassigned · client
Workers tab shows the deployed worker · mobile 375px cards, no horizontal
scroll · no live console errors.
