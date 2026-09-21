# Daily Updates: a coordinator's day-to-day tasks and work log

Milestone 1 of the Coordinator Workflow. The user's ask (2026-09-20): coordinators
need a place to record their day-to-day work, and there is no clarity today on
requirements that have arrived but aren't mobilised yet (worker sourced from a
subcontractor, documents being prepared, etc.). Two things came out of that:

1. **Daily updates** (this milestone): a to-do list and a work log per coordinator.
2. **A requirement pipeline** shown as a Kanban board (milestones 2-4, below).

Decisions the user locked in before any code was written:

- **Board granularity (for M2):** one card per client requirement, with the
  candidate workers listed inside it (not one card per individual worker).
- **Board stages (for M2):** admin-editable, not a fixed list.
- **Daily updates:** BOTH kinds — coordinators write their own to-dos and log
  entries, AND MM (or anyone with write access) can assign a task to a
  coordinator. All of it readable by MM for now.

## Roadmap (one milestone at a time)

| # | Milestone | Status |
|---|---|---|
| M1 | Daily updates: to-do list + work log, assign tasks, MM oversight | **COMPLETE** (this file) |
| M2 | Requirement board: cards, admin-editable stages, drag/move, stale flags, notifications; updates can attach to a card | **COMPLETE** (see `REQUIREMENTS-BOARD-notes.md`) |
| M3 | Candidates on a card (name, subcontractor, document readiness) + "Start mobilisation" pre-fill + auto-advance when the linked mobilisation is Approved | **COMPLETE** (see `REQUIREMENTS-BOARD-notes.md`, "Milestone 3") |
| M4 | Manager extras: filters, Excel export, dashboard widget for stale requirements | not started |

## What was built

```
server/src/modules/dailyUpdates/
  dailyUpdate.model.js       # NEW — one collection, kind: 'Log' | 'Task'
  dailyUpdate.validation.js  # NEW — create/update/status/list/id schemas
  dailyUpdate.service.js     # NEW — ALL business logic AND all authorization
  dailyUpdate.controller.js  # NEW — HTTP translation only
  dailyUpdate.routes.js      # NEW — requireAuth + requireStaff, no per-route section gate (see below)
server/src/app.js                                   # mounted at /api/daily-updates
server/src/modules/sectionAccess/sectionAccess.model.js    # + 'dailyUpdatesOwn', 'dailyUpdatesTeam'
server/src/modules/sectionAccess/sectionAccess.service.js  # + labels and descriptions for both
server/src/modules/notifications/notification.model.js     # + notification type 'Task'
server/src/scripts/grant-daily-updates.js           # NEW — one-time grants (see "User action")
server/package.json                                 # + "grant:daily-updates"

client/src/features/dailyUpdates/
  dailyUpdates.api.js
  dailyUpdates.schema.js
  pages/DailyUpdatesPage.jsx          # Tasks / Daily log tabs, ?tab= URL-backed
  components/TasksPanel.jsx           # the to-do list, filters, row actions
  components/TaskFormModal.jsx        # add / assign / edit a task
  components/LogPanel.jsx             # the log, grouped by day, filters
  components/LogEntryForm.jsx         # one form for both "add" (inline) and "edit" (modal)
  components/PagerBar.jsx
client/src/app/router.jsx             # /daily-updates, lazy, guarded by EITHER key
client/src/app/navConfig.js           # "Daily Updates" under Sales & Clients
client/src/features/sectionAccess/sectionAccessModules.js   # shows both keys on the Section Access page
client/src/lib/auditActions.js        # Security Log labels for the 7 new audit actions
client/src/i18n/locales/{en,ar}.json  # staffDailyUpdates.* (60 keys, identical sets) + nav entry
```

## The data model

One collection, two `kind`s, because both belong to exactly one coordinator, are
listed per coordinator, and are read together by whoever oversees them.

- **Log** — "what I did today". `date` (the calendar day it's about, stored at UTC
  midnight), `text`. Several per day is normal.
- **Task** — a to-do. `text`, optional `dueDate`, `status` (`Open`/`Done`),
  `completedAt`/`completedBy`.
- Both: `coordinator` (who it BELONGS to — a log's author, a task's assignee) and
  `createdBy` (who actually typed it). `createdBy !== coordinator` is exactly what
  makes a task "assigned by a manager".

`coordinator` is always a real, active `Coordinator`-role login. That is a domain
rule enforced in the service, not merely implied by who holds a grant — so a stray
grant to a non-coordinator can't produce a log "belonging" to an office secretary.

## Permission model — two Section Access keys

Both are ordinary Approval-Role grants (see `SECTION-ACCESS-notes.md`), each with
Read and Write, editable by an Admin from the Section Access page.

| Key | Read | Write |
|---|---|---|
| `dailyUpdatesOwn` — "my own tasks & log" | see my own log and the tasks assigned to me | add my own log entries and to-dos; edit/delete what I wrote myself; tick off any task assigned to me |
| `dailyUpdatesTeam` — "every coordinator" | see every coordinator's log and tasks | assign a task to any coordinator; edit / delete / tick off anyone's |

Why two keys instead of one: there are two genuinely different circles (a
coordinator's own workspace vs. oversight of everyone), and the precedent is
Attendance, where `attendanceSignInOut` was split off precisely so a Coordinator
could reach their own punch button without being granted the whole records grid.

Real-data grants (from `npm run grant:daily-updates`, run against the dev DB on
2026-09-20): **"Coordinator" role → Write on `dailyUpdatesOwn`**, **"MM" role →
Write on `dailyUpdatesTeam`** (Write implies Read, so MM can read everything AND
assign). MM was given Write, not just Read, because the request said MM can assign
tasks; drop it to Read-only from Section Access if that isn't wanted.

A few consequences worth knowing:

- A coordinator **cannot edit or delete a task a manager assigned** — only tick it
  off (and reopen it). That's deliberate: the assigner's wording is theirs.
- A coordinator with own-only access **cannot widen the view**: the server forces
  `coordinator = me` on their list requests, so `?coordinator=<someone else>` is
  ignored, not merely hidden in the UI.
- Only a `Coordinator` login can author a **log entry** (403 without own-Write,
  400 for an Admin who isn't a coordinator). A manager-assigned task needs an
  active coordinator as assignee (400 otherwise).
- **No route-level `requireSectionAccess` gate** on `dailyUpdate.routes.js` — which
  key applies depends on the entry being touched (own to-do vs. manager-assigned
  task vs. another coordinator's log), and a route gate can only ask one question
  up front. The service resolves the caller's access once per request
  (`getMySectionAccess`, exactly 2 queries) and enforces it per action — the same
  "authorization lives in the service" shape `mobilisation.service.js` uses. The
  `requireStaff` floor still applies (Worker/Staff/Executive never reach it).
- **The client never re-derives permissions.** Every row carries a server-computed
  `permissions: { edit, remove, setStatus }`; buttons render from that alone, so
  the UI and the enforcing code can't drift apart.

## Behaviors

- **Notifications** (new type `'Task'`, deep-links to `/daily-updates`, best-effort
  — a failed notification never fails the action): assigning a task to someone
  else notifies the assignee; a coordinator completing a task **someone else
  assigned** notifies the assigner. Not sent: for your own to-dos, on reopen, on a
  repeat "Done" tick (idempotent), or to the assigner about their own assignment.
- **Ordering:** open tasks first, soonest due first (no due date last), then done
  tasks, most recently completed first — one aggregation sort key, so pagination
  stays stable. (Mongoose doesn't cast string ids inside an aggregation pipeline;
  the coordinator id is cast to an ObjectId explicitly there.)
- **Overdue** is computed server-side against Riyadh's calendar day (`overdue`
  flag), not by the browser's clock.
- **Log dates:** date-only, must not be in the future (Riyadh "today"). Back-dating
  is allowed, and the server flags it (`backdated`): the UI shows "Back-dated —
  added <when>" so a manager reading the log can tell an after-the-fact entry from
  a same-day one. This was added after seeing that a back-dated entry showed only
  its typed time under the wrong day.
- **Every mutation is audited:** `dailyUpdate.{log,task}.{create,update,delete}` and
  `dailyUpdate.task.status` (labels in the Security Log).
- **Error surfacing:** every form uses `handleSubmit(onSubmit, onInvalid)` — a
  validation failure shows an inline error AND a toast AND a `console.error`;
  every mutation has a real `onError` toast + `console.error` (the standing rule).
- Arabic: full `staffDailyUpdates` strings, verified RTL in the browser.
- List latency: the page of rows and the total run concurrently
  (`Promise.all`) — found via measurement: the server itself answers in ~3 ms, the
  time is Atlas round-trips, so removing a sequential wait was the real lever.

## Verification (all run for real, against the dev DB, with disposable users)

**API — 78 assertions, all passing** (script-based, real HTTP against the running
server, disposable users, every record deleted afterward): access floor (no grant
→ 403 for Manager and for a Coordinator, no token → 401); log create / trim /
default-today / back-date / future-date rejected / due-date-on-a-log rejected /
"log for someone else" rejected / blank text / impossible date (Feb 31) / Admin
and MM correctly refused as log authors; task self-write, MM assign (overdue +
assignedByOther flags, populated names), assign to non-coordinator / inactive
coordinator / malformed id all rejected, coordinator cannot assign, read-only
viewer cannot assign; scoping (own-only can't widen with `?coordinator=`, MM sees
all and can filter, viewer sees all with zero write permissions, coordinator
picker excludes inactive users and non-coordinators); ordering, pagination, date
range, `kind` required; edit/tick/delete matrix incl. idempotent re-tick, reopen
clears completion, no notification on reopen / own-task tick, delete twice → 404,
viewer denied every write; audit rows for every action.

**Browser — real click-through**, as a Coordinator, as MM, and as Admin:
Daily Updates appears on the Sales & Clients hub; empty state; an empty submit
shows inline error + toast + console error; add a task and a log entry; MM sees
the coordinator picker/"Add / assign task"/the Coordinator column, filters by
coordinator, assigns an overdue task (missing assignee → visible error); the
coordinator's bell shows the assignment and the notification deep-links to the
page, where the assigned task offers ONLY "Mark done" while their own task offers
Mark done/Edit/Delete; tick → moves out of Open, strikethrough + Reopen under
"All"; edit modal pre-fills and can clear a due date; delete confirm (cancel keeps,
confirm removes); day-grouped log with the back-dated note; no horizontal overflow
at 375px (Tasks, Log, and the modal); Arabic/RTL; Admin's Section Access page shows
both new cards under Sales & Clients → Daily Updates with the real grants
pre-selected (Coordinator → own Write, MM → team Write).

Also: server lint clean, existing 38-test server suite still 38/38, client lint 0
errors, client build clean. Zero leftover rows afterward (users, tokens, entries,
notifications, audit rows, the temp ApprovalRole); the two Section Access
documents and both real roles' memberships confirmed back at their real values.

One thing that looked like a failure and wasn't: the first regression re-run
showed 3 "failed" totals because the browser session's own test data was still in
the DB (5 vs 4 tasks, 7 vs 3 logs) — cleaned up and re-run: 78/78.

## User action required

**Grant access once per database — through the Section Access page** (the intended
way; `npm run grant:daily-updates` is just a convenience for the dev database). As
Admin: Section Access → Sales & Clients → **Daily Updates**:

- card "my own tasks & log" → **Write** → tick **Coordinator**
- card "every coordinator (oversight & assigning)" → **Write** → tick **MM**
  (or **Read** for view-only)

The grants live in each database's own `SectionAccess` collection, so the dev grant
does not carry over: staging and production need them. Until then a coordinator/MM
there won't see "Daily Updates" — expected, not a bug.

## Deliberately not done

- **A log entry can be tied to a Requirements card (added in milestone 2)** via an
  optional `requirement` ref — it then shows on the card's timeline and in the daily
  log with a chip linking to the card. A *task* can't be tied to a card yet.
- **No "Waiting on you" dashboard count for open tasks.** A natural fit for the
  existing dashboard widget; left for M4 alongside the stale-requirement widget.
- **Executive logins (GM/COO) don't reach this module** — it uses `requireStaff`,
  and Executive is deny-by-default. If GM/COO should see it, that's an explicit
  allow-list + nav entry (the Executive nav is a short hand-written list), not a
  Section Access grant.
- **Log entries are editable/deletable by their author at any time**, audited. If
  managers later want them immutable after a day, that's a one-line rule change.
- Server-generated messages and Zod validation messages stay English (the app's
  documented i18n scope boundary).
