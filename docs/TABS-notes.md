# Tabbed layout for the 5 stacked-panel pages

Prompted by the user reviewing a screenshot of the Leave page: several
independent concerns (an Upcoming Holidays info card, a "Submit your own
request" form, the main review queue, and for HR/Admin a Leave Types config
panel) were all stacked vertically on one screen, requiring a lot of
scrolling to reach the part actually being used. They asked for tabs
instead, applied everywhere this same stacking pattern occurred, and
specifically flagged mobile/tablet as the place this matters most.

## What was built

**`client/src/components/ui/Tabs.jsx`** (new shared primitive) — fully
controlled (`value`/`onChange`, like `Select`), knows nothing about routing:

```
tabs={[{ key, label, content }, ...]}  value={activeKey}  onChange={setActiveKey}
```

- **Responsive strategy: a horizontally-scrollable tab bar at every
  width** (`overflow-x-auto whitespace-nowrap`) — the same idiom
  `Table.jsx` already uses for its own overflow problem — rather than
  collapsing to a `<Select>` on narrow screens. A `<select>` is a form-field
  primitive (see its own doc comment) and would hide every non-active tab
  behind a closed dropdown, actively hurting discovery of a brand-new nav
  pattern. One interaction model at every width, no breakpoint logic.
- **Content mounting: lazy-mount on first visit, then keep mounted
  (CSS `hidden`) for the rest of the page visit** — not full unmount on
  switch (which would lose in-progress form input the moment you glance at
  another tab) and not mounting everything up front (which would fire
  every tab's queries on page load, working against the reason this exists).
- Accessibility: `role="tablist"/"tab"/"tabpanel"`, `aria-selected`,
  `aria-controls` via `useId()` (same id pattern `Select.jsx` uses).
  Left/Right arrow keys move focus and activate immediately; Home/End jump
  to first/last.
- Exposes the active key via a small context (`useActiveTab()`) that no
  page uses yet — a deliberate, cheap escape hatch: if a queue's polling
  ever needs to pause while its tab is hidden (not done in this pass, see
  below), that's a one-line addition per panel, not a `Tabs.jsx` change.

**`useTabParam(tabs, defaultKey)`** (exported from the same file) — the
URL-backed value every page actually uses, via `?tab=` and
`useSearchParams` (the same hook `DeploymentNewPage.jsx` already reads a
preselected value with). Validates the requested key against the
currently-visible tab list and falls back to `defaultKey` for a missing,
stale, or role-inappropriate value — a Manager with an old `?tab=types`
link (from back when they could see that tab, or a copy-pasted URL) lands
on the default tab instead of a blank page. Writes back with
`setSearchParams(..., { replace: true })` so switching tabs doesn't spam
browser history.

**Why URL-backed, not local state**: every `RequestStatus` notification for
Leave/Timesheet/Salary-Advance/Reimbursement carries a plain page URL
(e.g. `leave.service.js`'s `url: (role) => (role === 'Worker' ? '/me/leave' : '/leave')`).
Since the review queue is also each page's new default tab, existing
notification links needed zero server change — they already land on the
right tab. The query-param plumbing is what makes a *future* notification
able to target a non-default tab a one-line service change instead of an
architecture revisit.

## The 5 pages

```
leave/pages/LeavePage.jsx                    Requests · Submit Request · Holidays · Leave Types (Admin/HR)
exitDocuments/pages/ExitDocumentsPage.jsx     Exit Re-Entry · Certificates
approvals/pages/ApprovalsPage.jsx             Roles · Workflows                    (Admin-only page)
financialRequests/pages/FinancialRequestsPage.jsx
                                               Advances · Submit Advance · Reimbursements · Submit Reimbursement
timesheets/pages/TimesheetsPage.jsx           Requests · Submit Timesheet · Monthly Report
```

Leave/ExitDocuments/Approvals needed no internal component changes — each
panel was already its own isolated component or same-file function;
the refactor was purely the outer page shell (a `<Tabs>` call instead of a
`<div className="space-y-6">` stack). **Leave's queue became the default
(first) tab**, reordering the page (Holidays used to lead) — it's the
primary, most-acted-on content and the sensible landing spot for a
"needs your approval" notification.

Two pages needed real surgery:

- **Financial Requests**: `AdvanceReviewPanel.jsx` and
  `ReimbursementReviewPanel.jsx` each wrapped their own `Submit*Panel` +
  review-queue `Card` in one fragment. Exported the previously-private
  `Submit*Panel` functions and dropped the wrapping fragment so each
  file's default export is just the queue — the two pieces became two
  peer tabs instead of one stacked unit. No logic changes inside either.
- **Timesheets**: the review queue (status filter, table, single-decide,
  bulk-select) was inline in the page's default export, and its
  "Approve N selected" trigger lived in `PageHeader`'s always-visible
  `actions` slot. Extracted the queue into its own `ReviewQueue` component
  (matching Leave's naming) and moved the bulk-approve button into that
  component's own card header next to its status filter — leaving it in
  `PageHeader` would have shown a button referencing checkboxes inside a
  now-possibly-hidden tab.

## A real bug caught during verification

`ApprovalsPage.jsx`'s conversion initially called `useTabParam` (a hook)
*after* the page's existing `if (!APPROVALS_MANAGE_ROLES.includes(user.role))
return <Navigate to="/" replace />;` early return — a Rules-of-Hooks
violation (a hook called conditionally, only on the render path where the
early return doesn't fire). Caught by reading the code during the plan's
design pass and fixed before the first browser check by moving the
`useTabParam` call above the early return. Separately, `ApprovalsPage.jsx`
was rewritten via `Edit` calls that forgot to add the `Tabs`/`useTabParam`
import at all — this one wasn't caught by `npm run build` (Vite/Rollup
doesn't do unbound-identifier analysis; a bare undefined reference only
throws at runtime, not bundle time), only by the browser check, which
showed a clean `ReferenceError: useTabParam is not defined` crash. Both
fixed; re-verified clean afterward. This is exactly why `npm run build`
succeeding is necessary but not sufficient — the browser click-through
this session already treats as mandatory is what actually caught this one.

## Verified (2026-09-05)

**Build**: `npm run build` clean after every page's conversion.

**Browser, per page** (throwaway Admin + throwaway Manager, deleted after):
correct tab set per role (Admin: no Submit tabs anywhere, no Leave Types
gating issue; Manager: Submit tabs present, Leave Types absent); tab
content switches correctly on click (checked via `aria-selected` toggling
and the rendered panel content changing); direct-URL landing on a specific
tab via `?tab=holidays` works on a fresh page load; an invalid `?tab=bogus`
falls back to the default tab rather than rendering blank; **form state
survives a tab round-trip** — typed a value into Leave's Submit Request
textarea, switched to Requests, switched back, value was still there,
confirming the lazy-mount-then-keep-alive design actually works; mobile
width (375px) showed no page-level horizontal scroll, tab bar sized
correctly; the Approve/Reject `ConfirmDialog` (added earlier this session)
still renders correctly inside the new Requests tab structure on a real
throwaway PendingReview leave request.

**Cleanup**: every throwaway admin/manager/employee/login and the one
throwaway leave request created for the ConfirmDialog regression check
were removed after verification; no scratch scripts remain.

## Not done / deliberately out of scope

- **No explicit "pause polling while hidden" wiring** into the review
  queues' `useQuery` calls — lazy-mount already means an unopened tab's
  queue never starts polling in the first place (the actual saving);
  stopping a *previously-opened* tab from polling once it's hidden would
  mean touching 6 different panels' internals for a marginal gain on an
  internal tool with a handful of concurrent staff. `useActiveTab()` is
  the one-line-per-panel door left open for this, if it ever matters.
- **No route changes** — `?tab=` query params, not nested routes per tab.
  Nested routes would mean ~20 new `router.jsx` entries (vs. 5 today) and
  would make every tab switch a new back-button stop, which isn't what
  "one page, several views of the same concern" should feel like.
