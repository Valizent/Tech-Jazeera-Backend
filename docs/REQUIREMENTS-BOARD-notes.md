# Requirements board: the pre-mobilisation pipeline

Milestone 2 of the Coordinator Workflow (see `DAILY-UPDATES-notes.md` for the
roadmap and milestone 1). The user's ask: requirements sometimes arrive before
anyone is mobilised — the coordinator has the requirement, is sourcing workers
from a subcontractor, documents are being prepared — and there was no clarity on
what was happening. A Mobilisation can't represent that (it needs a named
worker, client rate, job title and start date, and its statuses track approval,
not sourcing), so this is a Kanban-style board that sits BEFORE Mobilisation.

Decisions the user locked in before any code was written:

- **One card per client requirement** (headcount + candidate workers inside),
  not one card per individual worker. (The candidate list itself is milestone 3.)
- **Stages are admin-editable**, not a fixed list.
- Coordinators update their day-to-day work — the card timeline reuses Daily Updates.

## What was built

```
server/src/modules/requirements/
  requirementStage.model.js      # NEW — a board column: name, order, staleAfterDays, isTerminal, notifyOnEnter
  requirement.model.js           # NEW — a card (+ embedded stageHistory)
  requirement.validation.js      # NEW
  requirementStage.service.js    # NEW — stage CRUD, reorder, delete-guard, suggested defaults
  requirement.service.js         # NEW — board/detail/create/edit/move/delete + ALL authorization
  requirement.controller.js      # NEW — HTTP translation only
  requirement.routes.js          # NEW — mounted at /api/requirements
server/src/modules/dailyUpdates/…          # + optional `requirement` ref on a Log entry
server/src/modules/sectionAccess/…         # + 3 keys, labels, descriptions, resolveOwnTeamAccess()
server/src/modules/notifications/…         # + type 'Requirement', + notifyUserSafely()

client/src/features/requirements/
  requirements.api.js / requirements.schema.js
  pages/RequirementsBoardPage.jsx           # the board, filters, optimistic move, deep link
  components/BoardColumn.jsx                # a stage + drop target
  components/RequirementCard.jsx            # draggable card (+ "Move to…" select on phones)
  components/RequirementDetailModal.jsx     # details, stage control, timeline, "add an update"
  components/RequirementFormModal.jsx       # add / edit
  components/StageManagerModal.jsx          # add / rename / reorder / delete stages
client/src/features/dailyUpdates/components/RequirementTag.jsx   # the "REQ-0007 · ACME" chip on a log entry
client/…  router.jsx (/requirements), navConfig.js, sectionAccessModules.js, auditActions.js,
          i18n en/ar (90 keys `staffRequirements.*`, identical sets)
```

## The data model

- **RequirementStage** — one column. `staleAfterDays` (per stage, because
  "waiting on documents" legitimately takes longer than "new, nobody has started";
  null = never flagged), `notifyOnEnter` (moving a card INTO it notifies the team
  circle — meant for "Ready to mobilise"), `isTerminal` (work finished: never
  stale, and its cards leave the default board a month after arriving).
  "On hold" is deliberately NOT terminal — a paused requirement must stay visible.
  Names are unique case-insensitively (a collation index + a service check → 409).
- **Requirement** — `serialNumber` (`REQ-0001`, via the same atomic counter
  Invoices/Quotations/Mobilisations use), `clientName` + optional `client` link,
  `jobTitle`, `headcount`, `neededBy`, `site`, `notes`, `coordinators[]` (≥1, always
  real active `Coordinator` logins), `stage`, `stageEnteredAt`, embedded append-only
  `stageHistory` (with a stage-name snapshot, so history survives a rename/delete),
  `createdBy`. **No commercial fields at all** — rates are entered at Mobilisation
  time and stripped from coordinators there; keeping them off this record means a
  coordinator can safely see all of every card they're on.
- **`clientName` is always stored; `client` is set only when the typed name matches
  an approved, active Client** (exact, case-insensitive, and the name is then
  normalised to the real client's casing). A requirement can therefore arrive from a
  company that isn't a client yet, and links itself the moment the name matches one.
  The M3 handoff needs the link; the pipeline itself doesn't.
- **`DailyUpdate.requirement`** — an optional ref on a Log entry. That's the whole
  link between the two modules: the same entry shows on the card's timeline AND in
  the coordinator's own daily log, with a chip linking back to the card.

## Permission model — three Section Access keys

Approval-Role grants only, editable from the Section Access page (Sales & Clients →
Requirements). Same own/team split as Daily Updates, which is why the shared helper
`resolveOwnTeamAccess` was extracted (Daily Updates now uses it too — one place that
knows how the four booleans are read).

| Key | Read | Write |
|---|---|---|
| `requirementsOwn` | see the requirements I'm a coordinator on | add a requirement as myself; edit / move / delete my own; write updates on my cards |
| `requirementsTeam` | see every requirement | also assign any coordinators; edit / move / delete anyone's. Members are also who's notified on a "notify" stage |
| `requirementStages` | — | add / rename / reorder / delete stages. **Admin only until granted** ("admin editable") |

Consequences worth knowing:

- Every card carries a server-computed `permissions { edit, move, manageOwners,
  remove, addUpdate }`; the UI renders from it and never re-derives who may do what.
- **`addUpdate` needs a `Coordinator` login who is on the card** (updates are Daily
  Updates log entries, and only coordinators write those). So MM can move, edit and
  delete a card but not write updates on it.
- A coordinator **cannot add a colleague** to a card or remove owners — only
  team-write can (`manageOwners`). A coordinator can delete only a card they created.
- An own-only coordinator's board is forced to their own cards **server-side**;
  `?coordinator=<someone else>` can't widen it. A card you can't see returns the
  same 404 as one that doesn't exist, so ids can't be probed.
- Stage routes are gated at the route (`requirementStages` Write — one key, one
  question). Card routes have **no** route-level section gate, because which key
  applies depends on the card (same as Daily Updates).
- Reading the stages needs no key of its own — they arrive with the board.

## Behaviours

- **Stages start empty and are set up by an explicit click.** On an empty board an
  admin sees "Use suggested stages" (New requirement → Sourcing → Worker identified →
  Documentation in progress → Ready to mobilise → On hold → Mobilised → Lost) or
  "Set up stages". Never seeded silently. **The day counts on the suggested set
  (3/5/5/7/3) are first guesses**, all editable. The endpoint refuses (409) unless
  the board is empty.
- **Deleting a stage that still holds cards → 409**; deleting an empty one works.
  Reordering requires every stage exactly once (a partial list would leave ambiguous
  order). A terminal stage's `staleAfterDays` is forced to null.
- **Stale** = days in stage ≥ the stage's `staleAfterDays` (never for a terminal
  stage). Shown as a red border, a "Stale" badge, red "Nd in stage", a red count on the
  column header and a "N stale" total above the board.
- **Board contents:** one call returns the stages plus every visible card, longest-
  waiting first within a column (so what needs attention sits on top), capped at 1000
  (a `truncated` flag shows a notice). Cards in a terminal stage older than 30 days are
  hidden unless "Show closed cards older than 30 days" is ticked.
- **Moving** (drag-and-drop, the "Move to…" select on a card for phones/touch where
  native drag doesn't exist, or the Stage select in the card): **optimistic** — the card
  jumps immediately and **rolls back if the server refuses**. Moving to the same stage
  is idempotent (no new history).
- **Notifications** (new type `Requirement`, deep-linking to `/requirements?open=<id>`,
  best-effort — never fails the action): a new coordinator on a card is told;
  **entering a `notifyOnEnter` stage notifies the team circle** (members of every role
  granted team Read or Write); and **someone else moving your card notifies you**.
  Never the person who did it; a person in both circles gets one notification.
- **Timeline:** stage moves and written updates merged newest-first, with authors. The
  "Add an update" form can also move the card in the same step (two calls under the
  hood — the update is a Daily Updates entry, the move is a board action; if the move
  fails the update is already saved and the error says what failed).
- **Deleting a card** detaches its updates (`requirement → null`); they stay in their
  authors' daily logs.
- **The open card lives in the URL** (`?open=<id>`), so a notification's deep link, a
  refresh and Back all land on the same card.
- **Client / job title are free-typed with suggestions**, not strict pickers. If the
  client list can't be loaded (no Clients access) the field still works and the hint
  says so, instead of silently showing no suggestions.
- Every mutation is audited (`requirement.*`, `requirementStage.*`); Arabic is
  complete and RTL was checked (columns run right-to-left).

## Verification (all run for real, against the dev DB, with disposable data)

**API — 128 assertions, all passing** (real HTTP, disposable users, temporary roles
carrying every grant so no real person was notified; everything deleted afterwards and
the Section Access documents restored): stage management access matrix (no grant /
own-write / team-write / read-only viewer refused; a stage-grant holder and Admin
allowed); suggested defaults (8, ordered, flags correct, second call 409); stage
validation, duplicate name (case-insensitive) → 409, PATCH keeps other fields, terminal
forces null, reorder rejects partial/duplicate lists; creating before any stage exists
→ 409; card creation (serial, first stage, history, defaults, permissions), client-link
by name, coordinator rules (own-only can't assign, MM needs coordinators, inactive /
non-coordinator rejected); board scoping (own-only can't widen, MM sees all + filters,
viewer sees all with zero write permissions, picker lists active coordinators only);
card detail 404s; updates on a card (appear on the timeline, board count/last-update,
daily log tag, other people's cards / bogus ids / tasks refused); moves incl. history,
idempotence, and the full notification matrix; editing (clear fields, owners team-write
only, added coordinator notified, new coordinator can open/edit/update); stale flag,
threshold behaviour, terminal-card visibility (40 days hidden, `closed=all` shows,
5 days visible); deleting (creator-only rule, updates detached, stage guard); audit rows
for every action.

**Regression:** Daily Updates suite re-run after the shared-helper refactor and the
new `requirement` ref — 78/78. Existing server suite 38/38; server lint clean; client
lint 0 errors; client build clean; i18n key sets identical and no key used-but-missing
or defined-but-unused.

**Browser — real click-through** as Admin, Coordinator and MM: empty board prompt →
"Use suggested stages" → 8 columns with rule summaries; stage manager (edit with
prefill, reorder up/down persists, add, blank + duplicate names show visible errors,
delete with confirmation); add-requirement form (visible errors, coordinator picker for
Admin only, real coordinators listed); card detail; move via dropdown; **real drag-and-
drop** (card dims, column highlights, optimistic move, server confirms); **optimistic
rollback** (a stage deleted behind the UI's back → the drop is refused → the card
returns and the board refetches); coordinator view (own cards only, no Manage stages,
no coordinator filter, Delete hidden on a card they didn't create); update + stage
move in one step; the update appearing in the daily log with a working chip → deep link;
a coordinator creating a card whose typed client name links to the real client; the
notification bell and the notification matrix confirmed against the live actions;
no horizontal page scroll at 375px (the board scrolls inside its own container) with the
mobile "Move to…" select; Arabic/RTL; a stale card's appearance.

Things found and fixed during verification (worth knowing the shape of):

- **A network failure mid-save** (the dev server restarted): the dialog stayed open,
  the typed input was preserved, the failure was logged/toasted — and the resubmit
  worked. Not a bug, but the error path was confirmed by accident.
- **Silent client suggestions:** a coordinator without Clients access got a form with
  no suggestions and no explanation — the "silent picker failure" this app avoids.
  Fixed: the hint now says the list isn't available.
- **RTL:** the card's client name used a physical `text-left`, so it stayed left-
  aligned in Arabic. Changed to the logical `text-start`.
- **Test-only mistakes, not product bugs:** three assertions initially "failed"
  because my test data used one-character job titles (correctly rejected by
  validation before authorization was reached) — fixed so they test what they claim;
  and the log-entry assertions needed the Daily Updates key in the fixture.
- **Tooling quirk:** while testing in the hidden in-app browser pane, TanStack
  Query pauses retries (the page reports `hidden`), so a failing lookup looked stuck
  "loading" until the page was told it was visible. A test-environment artifact.
- **Dev-server quirk (already noted in CLAUDE.md):** running any script that imports
  server modules can restart `node --watch`; the first request after it can get a
  connection reset. The verification scripts retry.

## User action required

**Grant access once per database — through the Section Access page** (that is the
intended way; the earlier `grant:daily-updates` script is just a convenience). As
Admin: Section Access → Sales & Clients → **Requirements**:

- card "my own board" → **Write** → tick **Coordinator**
- card "every coordinator (oversight & assigning)" → **Write** → tick **MM**
  (or **Read** for view-only)
- card "board stages" → leave Admin-only, or tick whoever should manage the columns

Then, once, as Admin, open Requirements and click **Use suggested stages** (or build
your own). The grants above are already applied on the **dev** database; production
and staging need them. Until then a coordinator/MM there won't see Requirements.

## Deliberately not done (and what's next)

- **Candidate workers on a card, and "Start mobilisation" pre-fill / auto-advance when
  the linked mobilisation is Approved — milestone 3.** A card is currently the
  requirement only.
- **Tasks can't be tied to a card** — only log-entry updates can. Natural extension if
  wanted (a to-do "chase medicals" on REQ-0007).
- **A coordinator can't add a colleague to their own card** (`manageOwners` is
  team-write). Deliberate for now; MM does it.
- **Executive logins (GM/COO) don't reach this module** — `requireStaff`, same as Daily
  Updates. An explicit allow-list + nav entry if wanted.
- **No dashboard widget yet** (stale requirements / open tasks) — milestone 4, along
  with filters by client/subcontractor and an Excel export.
- **Coordinators picking a card from their daily-log form** ("Re: REQ-…") — updates are
  currently written from the card. Easy to add if coordinators ask.
- The board caps at 1000 cards with a visible notice; no pagination.
