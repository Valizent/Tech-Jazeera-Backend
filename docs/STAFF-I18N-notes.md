# Staff panel Arabic — first increment (shell + Dashboard)

## Why this exists

P3-G deliberately scoped translation to the Worker self-service (ESS)
portal only — "the workforce actually needs Hindi/Nepali/Bengali/Arabic;
staff already operate in English day to day" (`docs/P3-G-notes.md`).
Explicitly asked for directly: *"add a language switch button to switch
the entire language settings to Arabic"* — for the staff panel this time,
not the ESS portal. Scoped to **English/Arabic only** — Hindi/Nepali/
Bengali were for the blue-collar workforce specifically and don't fit the
office-staff persona (Admin/Manager/HR/Accounts/Coordinator/Executive).

*Superseded 2026-09-06:* the user later removed Hindi/Nepali/Bengali from
the ESS portal too, so every surface (ESS, login, staff panel) now offers
the same English/Arabic list — see `docs/P3-G-notes.md`'s follow-up note.

## The RTL rollout decision

The staff panel is ~50 page files (vs. the ESS portal's ~15) — this was
never going to ship as one pass. That raised a real question before writing
any code: while pages are translated module by module over the coming
sessions, should the layout mirror to RTL immediately (even on pages still
showing English text), or should each page only flip RTL once it's
actually translated?

**Put to the user directly, since it shapes every future increment's UX,
not just this one.** Decision: **flip RTL immediately, app-wide**, the
moment Arabic is picked — consistent single direction from day one; a
not-yet-translated page shows English text in a mirrored layout until its
own turn comes, rather than the app running two different layout
directions at once during the whole rollout. Verified this actually looks
coherent, not broken: the Employees page (untranslated) correctly shows
its English content — "Add employee", column headers, employee names — in
a fully mirrored layout (sidebar right, table columns reversed, action
buttons on the left).

## What shipped this increment

Reused the ESS portal's exact i18next/RTL machinery (`i18n/index.js`) — one
shared instance and `changeLanguage()`/`applyDocumentDirection()`
mechanism for both surfaces. Only two things are new:

- `STAFF_SUPPORTED_LANGUAGES` (English/Arabic) — `LanguageSwitcher.jsx`
  gained an optional `languages` prop (defaults to the ESS's own 5-language
  `SUPPORTED_LANGUAGES`, so its existing mount points are unaffected);
  `DashboardLayout.jsx` passes the restricted list.
- Two new top-level locale namespaces, `staffNav` and `staffDashboard`
  (kept separate from the ESS's own `nav`/`header` to avoid collision;
  generic chrome strings — `header.changePassword`/`logOut`/
  `notifications`/`updateProfilePhoto` — are reused as-is, not duplicated).

**Translated this increment**: the full navigation shell (`navConfig.js`'s
every group/item label+description, all 4 hub pages via
`SectionHubPage.jsx`, `EXECUTIVE_NAV_ITEMS`, `DASHBOARD_ITEM`), the
`DashboardLayout` header chrome (logo text, menu/photo/password/logout
tooltips), and the entire Dashboard page + its 6 sub-components
(`StatusBreakdown`, `ExpiringDocuments`, `RecentActivity`, `QuickActions`,
`ProfitCard`, `MyPendingActions`) — every visible string, not a partial
pass.

**Key-with-fallback pattern, not a hard cutover**: `navConfig.js` keeps its
existing literal `label`/`description` strings untouched and adds parallel
`labelKey`/`descriptionKey` fields; every consumer calls
`t(item.labelKey, item.label)`. A future item added without a key (or a
key that's momentarily missing from one locale file) renders its English
literal instead of crashing or showing a raw key — the exact mechanism
that made "shell + Dashboard now, everything else later" safe to ship as a
real increment rather than an all-or-nothing switch.

## Deliberately NOT translated this increment (documented boundaries, not oversights)

- Every other staff page's own content (~49 files) — the actual module-by-
  module backlog for future sessions.
- `describeAction()` (`lib/auditActions.js`) — Recent Activity's per-entry
  text ("signed in", "added an employee", etc.) — a large, separately-used
  mapping (also feeds the Security Log page), left for its own pass.
- Date/number formatting (`ProfitCard`'s month abbreviations, `formatMoney`/
  `formatDate` generally) — same documented boundary P3-G already drew for
  the ESS portal.
- Role names (Admin/Manager/HR/Accounts/Coordinator/Executive) — shown
  as-is in the header's role line, matching P3-G's own precedent of leaving
  `lib/constants.js`'s shared label constants untouched.

## Verification

`npm run build` clean throughout. Browser-verified end to end with a
throwaway Admin: English unaffected (regression check); switching to
Arabic flips `document.documentElement.dir`/`lang` correctly and mirrors
the entire shell (sidebar to the right, header icons reversed); Dashboard's
full text inventory checked via `get_page_text` against the exact source
strings — headline stats, "Waiting on you", Pipeline, Profit (all 4 tiles +
trend chart label), both status breakdowns, Expiring Documents, Recent
Activity (shell text only, entries themselves correctly still English —
documented boundary), Quick Actions; the Workforce hub page's full
card grid (title, description, all 7 items) confirmed translated too; the
Employees page (untranslated) confirmed rendering correctly in a mirrored
RTL layout with its English content intact. Test account removed after.
