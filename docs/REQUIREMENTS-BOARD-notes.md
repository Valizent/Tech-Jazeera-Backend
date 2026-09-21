# Requirements board: the pre-mobilisation pipeline (milestones 2 and 3)

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

- **Candidate workers and the "Start mobilisation" handoff** — milestone 3, now built;
  see the "Milestone 3" section below.
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

---

# Milestone 3: candidates and the mobilisation handoff

The last piece of "clarity on what is happening" before a worker is mobilised: WHO
is being lined up for each requirement, how far their paperwork is, and a clean
path from "documents ready" to a real Mobilisation — with the card following the
mobilisation's approval on its own. Built on the design decisions above (one card
per client requirement, candidates inside it).

## What was built

```
server/src/modules/requirements/
  requirement.model.js        # + embedded `candidates[]` (candidateSchema)
  requirement.validation.js   # + create/update/param schemas for candidates
  requirement.service.js      # + addCandidate / updateCandidate / removeCandidate
                              # + assertCanStartFromRequirement / attachMobilisation / onMobilisationApproved
  requirement.controller.js / requirement.routes.js   # + /:id/candidates[/:candidateId]
  requirementStage.model.js / .validation.js / .service.js   # + isMobilisedStage (exclusive)
server/src/modules/mobilisations/
  mobilisation.model.js       # + requirement, requirementCandidate (create-only)
  mobilisation.validation.js  # + the pair, create-only, both-or-neither
  mobilisation.service.js     # create: verify BEFORE, link AFTER; approve: hook AFTER the Deployment
                              # POPULATE: + requirement (serial/client/job title)

client/src/features/requirements/
  components/CandidatesSection.jsx    # the list, in-place status, Start mobilisation / Edit / Delete
  components/CandidateFormModal.jsx   # add / edit a candidate
  (RequirementDetailModal, RequirementCard, BoardColumn, StageManagerModal extended)
client/src/features/mobilisations/
  pages/MobilisationNewPage.jsx       # "Start mobilisation" pre-fill + banner + "already started" guard
  pages/MobilisationDetailPage.jsx    # "From requirement" row (linked when the viewer can open the board)
  mobilisations.schema.js             # create-only requirement/requirementCandidate fields
client/…  auditActions.js, i18n en/ar (128 `staffRequirements.*` keys; identical sets)
```

## Candidates

- **Embedded on the card** (they live and die with it and are only read with it).
  Each has a worker type — **Subcontractor's worker** (needs a subcontractor) or
  **Freelancer** — name, optional Iqama (exactly 10 digits) / nationality / phone, a
  documents note ("passport received, medical pending"), a status, and — once
  started — the mobilisation made for them.
- **Status** is a small fixed list on purpose (a person, not a placement; the board's
  STAGES are the admin-editable part): Identified → Documents in progress → Documents
  ready, plus Dropped. **"Mobilised" is set only by the system**, when the linked
  mobilisation is approved — it can't be picked, and once set it can't be walked back or
  the row removed.
- **Own employees are not candidates.** Their picker needs Employees access a
  coordinator usually lacks (the same gap fixed on the Mobilisation form on 2026-09-16),
  and the Standby list already has a "Mobilise" button for them. Candidates are the
  subcontractor/freelancer flow the user described.
- **Permission = the card's edit right** (team-write, or own-write on a card you're a
  coordinator of); there is no separate candidate key. A candidate with a mobilisation
  can't be removed (mark it Dropped instead) — the row is part of a real placement record.
- The board and the create/edit/move replies carry only `candidateCount` and
  `mobilisedCount` (a Dropped candidate isn't counted); the full list comes with the
  single-card detail. The card shows "Candidates: 3 · Mobilised 1/4".

## The handoff — "Start mobilisation"

1. **The button** (on a candidate that has no mobilisation and isn't Dropped/Mobilised)
   goes to `/mobilisations/new?requirement=<id>&candidate=<id>`. **Only those two ids are
   in the URL** — no worker name, Iqama or phone ever sits in the address bar.
2. **The New Mobilisation page fetches the card itself** and pre-fills the ordinary form:
   worker type, name, Iqama, nationality, phone, subcontractor, client, job title, site.
   Each value is used only if it matches a real option in the pickers the page loaded (a
   client the viewer can see, a title on the list) — an unlisted value would leave a
   `<select>` looking empty while secretly holding a string nobody chose. The client rate,
   dates and everything commercial stay for the coordinator to enter. A banner says where
   it came from.
3. **If the card can't be opened** (deleted / not theirs) the link is dropped, not half-
   applied: the form still works as an ordinary mobilisation and says so.
4. **If the candidate already has a mobilisation** the page shows a message with links to
   it and back to the card — not a form the server would refuse.
5. **Server side, in this order:** `assertCanStartFromRequirement` runs BEFORE anything is
   created (the caller may edit the card; the candidate exists, isn't Dropped, has no
   mobilisation yet, and the worker type matches) — so a refused start leaves no orphan
   Draft; the mobilisation is then created carrying `requirement` +
   `requirementCandidate` (create-only, both-or-neither, never editable afterwards);
   `attachMobilisation` then points the candidate at it (best-effort; guarded so two
   simultaneous starts can't both win).
6. **A Rejected mobilisation stays the candidate's.** A rejected mobilisation isn't dead —
   the coordinator fixes and resubmits the same record — so the link is not cleared.
   Mobilisations can't be deleted, so it can never dangle.
7. **Who can start:** the button needs `mobilisationsSelfMobilise` Write (the same right
   the Mobilisations page uses) AND the card's edit right; the server checks both. So MM
   can maintain a card's candidates but is not offered "Start mobilisation".

## Auto-advance on final approval

- New stage flag **`isMobilisedStage`** ("Where a fully-mobilised requirement goes") — at
  most one stage holds it; flagging one moves the flag rather than erroring. It is separate
  from `isTerminal` on purpose: "closed" also covers Lost, so it can't say which stage means
  "mobilised". The suggested stage set flags "Mobilised".
- In `approveMobilisation`, **after** the Deployment exists and **best-effort** (try/catch,
  logged): `onMobilisationApproved` marks the candidate Mobilised, and once as many
  candidates are mobilised as the card asked for (`headcount`) it moves the card to the
  flagged stage — an atomic update with a history entry attributed to the approver. With no
  stage flagged the candidate is still marked and the progress updates; the card just stays
  put. It must never fail or undo an approval (same discipline as the 2026-09-15 rule for
  notifications in that engine), and a deleted card is simply skipped.
- **Notifications** (`Requirement`, deep-linking to the card): the card's coordinators are
  told "X approved for mobilisation — 1 of 2 mobilised", or "All workers mobilised — moved
  to Mobilised" when it advanced; the team circle only if the destination is also a "notify"
  stage. Never the approver.

## Verification (all real, against the dev DB, disposable data)

**API — 76 assertions, all passing** (real HTTP): the mobilised-stage flag (suggested set,
create-as, move, exclusive, other edits leave it alone); candidate CRUD and every
validation rule (subcontractor required/forbidden by type, Iqama format, "Mobilised" not
creatable, unknown subcontractor, blank name); permissions (another coordinator, read-only
viewer, no-grant user refused; MM allowed); counts and the board shape; status changes,
clearing fields, Dropped, remove; **the handoff guards** (pair required, worker-type
mismatch, another coordinator, unknown card, unknown candidate — and that every refusal left
NO orphan mobilisation), the link on both sides, the "From requirement" detail, a second
start → 409 naming the first, remove-blocked / Dropped-allowed / Dropped-can't-restart; and
**the real approval flow end to end** through a disposable one-approver workflow: submit →
approve → candidate Mobilised with the card **not** advanced at 1 of 2; second approval →
card moved itself to the flagged stage, history attributed to the approver, days-in-stage
reset, correct notifications (and none to the approver / team circle); no flagged stage →
candidate Mobilised but the card stays; **approving a mobilisation whose card was deleted
still succeeds** and creates its Deployment; a normal mobilisation with no link still
creates and approves exactly as before. Daily Updates (78) and the Requirements board (128)
suites re-run green; existing server suite 38/38; server lint clean; client lint 0 errors;
client build clean; i18n key sets identical (and no key used-but-missing or unused).

**Browser — real click-through** as Admin, Coordinator and MM: moving the mobilised-stage flag
between stages in the stage manager; the empty Candidates section; the candidate form's
visible errors (missing subcontractor/name, bad Iqama); adding a subcontractor's worker and
a freelancer (the subcontractor field hides for a freelancer); changing a status in place;
"Start mobilisation" → a form pre-filled from the card (worker, Iqama, nationality, phone,
subcontractor, client, job title matched to the real list, site) with a banner; saving the
Draft; the "From requirement" row and its link back; the candidate row now showing
"MOB-0069 · Draft" with Start/Delete gone; the direct-URL "already has a mobilisation" guard;
the approval hook → Mobilised badge, "1 of 2 mobilised", card stays; the second → the card
moves itself to Mobilised, the timeline shows the approver, "Candidates: 2 · Mobilised 2/2",
two correct notifications; MM can add/edit candidates but is not offered "Start
mobilisation"; no horizontal overflow at 375px (card detail and the candidate form);
Arabic/RTL including translated statuses.

**The incident worth remembering.** The first API run crashed mid-way when the dev server
restarted for longer than the script's retry window, and my script's *cleanup* then hit a
unique index (`ApprovalWorkflow` allows one ACTIVE workflow per type) because it
reactivated the real Mobilisation workflow BEFORE deleting the disposable one — leaving the
real "Mobilisation workflows" workflow **inactive** in the dev database. It was found by
inspecting the DB (its `updatedAt` matched the run's start to the second), restored, and
every Section Access grant and both serial counters were verified back to their real
values. The script was rewritten so this can't recur: recovery state is written to disk
before anything real is touched, the disposable workflow is deleted first, every cleanup
step is independent (one failure can't skip another), and the retry window covers a slow
restart. Nothing was ever left inactive after that, confirmed by an independent read-only
check. **Lesson for any future test that swaps a real workflow:** delete-then-restore, each
step in its own try/catch, state saved first.

## User action required

- **Nothing new in Section Access** — candidates ride the existing card edit right, and
  "Start mobilisation" the existing `mobilisationsSelfMobilise` right.
- **Tick the new stage flag once per board.** If you used "Use suggested stages" it's
  already on "Mobilised". If you built your own stages (or already had some before this
  milestone), open Manage stages → Edit the stage a finished requirement should land in →
  tick "Where a fully-mobilised requirement goes". Until one is ticked, cards don't move by
  themselves (candidate progress still updates).
- Iqama and phone are optional on a candidate, but a mobilisation can't be **submitted** for
  review without them — worth filling in as they arrive.

## Deliberately not done

- **Candidate changes aren't on the card timeline** (only stage moves and written updates
  are). Each candidate's current status is the "what's happening"; every change is audited.
- **Lowering a card's headcount doesn't re-check auto-advance** — it's evaluated on each
  approval, not on edit.
- **Own employees as candidates** — see above; use the Standby list.
- **Demobilising or completing a mobilisation doesn't touch the card.** Once mobilised the
  requirement's job is done.
- Milestone 4 (filters by client/subcontractor, Excel export, dashboard widget) is next.
