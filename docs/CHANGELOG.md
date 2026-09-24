# Company ERP — full status history / changelog

The complete, dated, milestone-by-milestone history of this project — every
phase, feature, fix, and follow-up, in the order it happened (oldest first,
newest at the bottom). Moved out of `CLAUDE.md` on 2026-09-22 (a real
QA-audit finding — the file that's auto-loaded every session had grown to
1500+ lines, almost entirely this history) so the file every session reads
first stays a short, fast current-state guide; nothing below was trimmed or
summarized, this is the original text unchanged. `CLAUDE.md`'s own `## Status`
section now holds just a brief current summary and points here.

If an entry below says "**User action still needed**", check whether it's
already been done since — this file is a historical log, not a live task
list, and a later entry sometimes resolves an earlier one's open item without
saying so explicitly (search for the same topic further down).

---

## Status

**Phase 1 COMPLETE (M1–M10)** — auth/RBAC, employees, clients, deployments,
attendance (+Excel/PDF export), documents (uploads/versioning/preview),
quotations (line items/totals/PDF), dashboard. Plus a view-access UI pass.
Each milestone documented in `docs/M<N>-notes.md`.

**Phase 2 backbone COMPLETE (`docs/PHASE2-PLAN.md`)** — worker accounts +
self-service portal, timesheets + approval, payroll + payslips, invoices +
payments, expenses, and a real profit dashboard, all now built end-to-end
(P2-M1 through P2-M8). Same stack, same rules, same discipline.

- **P2-M1 COMPLETE** — worker accounts & account linking: `Worker` role,
  `User.employee` link (partial unique index), `requireStaff` locking all admin
  modules against Workers, admin-only login provisioning (temp password surfaced
  once). See `docs/P2-M1-notes.md`.
- **P2-M2 COMPLETE** — ESS portal (My Profile/Documents/Leave, real web access
  now — the P2-M1 staff-only gate is gone), `Coordinator` role + hierarchy
  (`Employee.coordinator`, `User.managedBy`, scoped queries), a Users module
  for staff-login provisioning (Admin/Manager/HR/Accounts/Coordinator —
  previously only possible via the `seed:admin` CLI), a
  configurable Leave module (`LeaveType` policies + a server-side eligibility
  engine with Annual/ContractCycle/Manual auto-approval), and configurable
  expiry-alert thresholds with Coordinator team-scoping. See
  `docs/P2-M2-notes.md`.
- **P2-M3 PARTIAL** — installable PWA (manifest, service worker, icons) and
  geofenced Worker self-attendance (GPS geofence + office-IP allow-list,
  Admin-configurable, staff marking still overrides). The multi-level signed
  timesheet-approval half (new `BDM` role, per-user signature images, the
  timesheet document itself) is designed but waiting on a template example
  from the user before building. See `docs/P2-M3-notes.md`.
- **P2-M4 COMPLETE** — self-service password change (`PATCH /api/auth/password`,
  every role, revokes all sessions) and Admin-initiated password reset for
  both staff and Worker logins (the recovery path — no email provider is
  configured for a self-service "forgot password" flow). Also: real logo
  applied everywhere (PWA install icons, sidebar/login marks, theme color).
  See `docs/P2-M4-notes.md`.

**Phase 3 COMPLETE (`docs/PHASE3-PLAN.md`)** — folded an HR/ESS PRD's
remaining scope into the Phase 2 backbone: EOSB, statutory leave/holidays,
financial requests, exit & document requests, asset tracking, overtime/
Ramadan shift rules, notifications, and multi-language, all now built
end-to-end (P3-A through P3-G) — decided over native mobile (staying on the
PWA) and against inventing the deferred multi-level timesheet signing flow
(a sensible single-level default instead).

- **P3-B COMPLETE** — statutory leave caps (`LeaveType.maxDaysPerRequest`,
  `isPaid`) and a new company Holiday calendar module, integrated into the
  attendance records grid (inferred "Holiday" days, same precedence as the
  existing weekly-off inference) and both Leave pages. See
  `docs/P3-B-notes.md`.
- **P3-A COMPLETE** — End of Service (EOSB) calculator: Labor Law Article
  84/85 award (tiered gross + resignation reduction), vacation-pay
  encashment of unused annual leave (reuses the Leave module's own
  eligibility engine), a permanent `Settlement` record per exit, and a PDF.
  See `docs/P3-A-notes.md`.
- **P3-C COMPLETE** — financial requests: salary advance/loan workflow with
  a manual repayment ledger (auto-`Closed` at zero balance; no Payroll to
  auto-deduct yet) and expense reimbursement claims with a real receipt
  upload (own minimal file storage, not routed through the Documents
  module — different trust category). Single-level Approve/Reject, not the
  multi-level matrix the PRD describes — same judgment call as the
  Phase 3 planning decision to default P2-M3b's timesheet signing the same
  way. See `docs/P3-C-notes.md`.
- **P3-D COMPLETE** — exit re-entry visa requests (tracks the request only;
  Jawazat/Muqeem processing stays external), certificate requests with real
  generated PDFs for Salary/Service certificates (minimal letterhead — no
  company Settings record exists yet, so no CR number/signatory is
  invented; the Service Certificate correctly pulls a real exit date from
  an EOSB Settlement when one exists) and status-only tracking for Chamber
  of Commerce Attestation (an external stamping process, no document to
  generate), and a company asset register (`Asset` + a separate
  `AssetAssignment` history collection, mirroring Deployment's exact
  pattern). See `docs/P3-D-notes.md`.
- **P2-M3b COMPLETE** — timesheet approval, resuming the Phase 2 backbone:
  a weekly `Timesheet` that summarizes real Attendance data (self-punched
  hours, or `expectedDailyHours` as the fallback for a staff-marked
  Present day — never an invented default) and puts it through single-level
  Approve/Reject, plus bulk-approve. Does not re-enter hours (Attendance
  already does that) and does not yet lock approved weeks against later
  attendance edits (deferred until Payroll needs it). See
  `docs/P2-M3b-notes.md`.
- **P2-M5 COMPLETE** — payroll & payslips: a monthly `PayrollRun` computed
  from real employee salaries (an optional Basic/Housing/Transport
  breakdown on Employee, falling back to the whole salary as Basic when
  unset — never an invented split) and P2-M3b's approved hours (shown as
  informational; overtime-rate pay is P3-E's job, not yet built). GOSI is
  entered by HR/Accounts, never calculated — no verified current rate
  exists in this app. Draft → editable, Finalize → locked and payslips
  become visible in ESS, with a real generated PDF. See `docs/P2-M5-notes.md`.
- **P2-M6 COMPLETE** — invoices & payments: an `Invoice` created from an
  Approved quotation (line items/totals frozen at creation, never
  re-derived if the quotation later changes), one per quotation, with an
  append-only payment ledger (`amountPaid`/`balanceDue`/`status` always
  recomputed, same discipline as the salary-advance repayment ledger), an
  invoice PDF, and a real "Invoices" tab on the client profile. Deletable
  only before any payment is recorded. See `docs/P2-M6-notes.md`.
- **P2-M7 COMPLETE** — expenses: a company-level `Expense` ledger (date,
  category, vendor, amount, optional client/deployment attribution, an
  optional receipt reusing the reimbursement-claim upload pattern),
  list + filters + a monthly-totals summary, a narrower Admin/Manager/HR/
  Accounts view circle than Invoices (internal cost data, same circle as
  Payroll/EOSB). The other half of profit for P2-M8's Dashboard v2. See
  `docs/P2-M7-notes.md`.
- **P2-M8 COMPLETE — Phase 2 backbone finished.** Dashboard v2: real profit
  (Revenue from issued invoices − Payroll cost from a Finalized PayrollRun
  − recorded Expenses, all for the same selected calendar month), a month
  selector, and a 6-month diverging-bar trend — replacing the old "profit
  needs cost data" placeholder. Extends the existing `/api/dashboard`
  endpoint rather than adding a new one; the old approved-quotation/
  pipeline/payroll-run-rate estimates stay alongside it, relabeled
  "Pipeline". See `docs/P2-M8-notes.md`.
- **P3-E COMPLETE** — overtime & Ramadan shifts: a configurable
  `RamadanPeriod` calendar (date range + editable daily/weekly hour caps,
  default 6/36 per Labor Law Article 98), real overtime hours computed
  weekly on Timesheet submission (48-hour normal week, or the smallest
  overlapping Ramadan cap), and real overtime pay (Article 107's 1.5× on an
  hourly wage of basicSalary/240) folded into Payroll's gross pay and
  payslip PDF. See `docs/P3-E-notes.md`.
- **P3-G COMPLETE — Phase 3 fully finished.** Multi-language: the Worker
  self-service (ESS) portal (not the staff panel — the user's explicit
  scope choice) fully translated into English/Arabic/Hindi/Nepali/Bengali
  via i18next, with real RTL for Arabic (native `dir="rtl"` cascading,
  verified with a screenshot — no per-component RTL classes needed). A
  language switcher lives only on the login screen and the ESS shell.
  Server-generated text, client-side Zod messages, and date/number
  formatting stay English/unlocalized — documented scope boundaries, not
  oversights. See `docs/P3-G-notes.md`.
- **P3-F COMPLETE** — notifications: a real in-app notification center
  (bell icon in both staff and Worker headers, every role) plus genuine Web
  Push (VAPID, the app's own self-generated key pair — see `.env.example`)
  on top of it. Wired into every one of the app's 7 decide-type actions
  (Leave, Timesheet, Salary Advance, Reimbursement ×2, Exit Re-entry Visa,
  Certificate, Client) plus a daily expiry-alert background job
  (setInterval, no new scheduler dependency) for Admin/Manager/HR. See
  `docs/P3-F-notes.md` — including a critical dedupe-index bug found and
  fixed during verification.

**Post-Phase-3 addition (not phase-numbered — Phase 3 was already complete
when requested):**

- **Tiered sick pay COMPLETE** — Labor Law Article 117: a new `Sick`
  LeaveType recurrence with fully configurable pay tiers (`sickPayTiers`,
  the client pre-fills the statutory 30d@100%/60d@75%/rest@0% as a starting
  point, but every number is company-editable, never hardcoded — the user's
  explicit instruction, same as leaving Bereavement/Hajj day-counts
  unseeded), a real eligibility engine that consumes tiers in leave-year
  order across all of a worker's sick requests, and a real payroll deduction
  (`sickLeaveDeduction`) computed by reconstructing which calendar days of
  an approved request fall in the target payroll month — correctly handling
  a request that spans a month boundary. See `docs/SICK-PAY-notes.md`.
- **Native Android app COMPLETE** — the PWA wrapped in a real installable
  Android app via Capacitor (React Native was considered and rejected: a
  full rewrite of 15+ existing modules vs. near-zero rework). Reuses every
  screen unchanged; the hard part was cross-origin cookie handling —
  `CapacitorHttp`'s native networking (not plain WebView fetch) turned out
  to be required, not optional, for the refresh-token cookie to survive an
  app restart, alongside a real bug fix (the cookie had no `maxAge`, which
  also quietly improves the *web* app's "stay logged in" behavior). CORS
  and the CSRF origin guard now support multiple trusted origins. The
  Worker/Staff/Admin geofence GPS calls were swapped to
  `@capacitor/geolocation` — the concrete PWA limitation flagged when the
  original "stay on PWA" decision was made. iOS is scaffolded but unbuilt
  (no Mac available). A signed release build was verified end-to-end
  against the real production deployment (Oracle VM + Caddy/DuckDNS HTTPS +
  MongoDB Atlas + GitHub Actions CI/CD) — login and session persistence
  both confirmed against the live server. See `docs/P-MOBILE-notes.md`.
- **Configurable Approval Hierarchy COMPLETE** — a self-service,
  admin-configurable multi-step approval workflow for Leave/Salary-Advance/
  Reimbursement/Timesheet, modeled on the company's real org chart (GM→COO→
  {MM,HR,FM}; MM→BDM→Coordinators; FM→Accountants/Clerks). New
  `ApprovalRole` (admin-named, any staff members) and `ApprovalWorkflow`
  (ordered steps, each a pool of roles — "any ONE member decides it," which
  covers both a strict single approver and a fan-in final tier with no
  special-casing) — fully decoupled from the fixed `User.role` enum, not an
  expansion of it. One `Employee.approvalWorkflow` override field is the
  entire mechanism behind a company having two different chains (e.g. a
  BDM-inclusive branch vs. a Finance branch that skips straight to the top
  tier) — no hardcoded department concept anywhere. A `null` workflow always
  means the original single-level flow, byte-for-byte unchanged — the safe
  per-employee rollout mechanism. Also closed a real, separately-confirmed
  gap: staff (Coordinator/HR/Manager/Accounts) previously had no way to
  submit a request of their own at all (only the Worker ESS portal could) —
  each request type now has a staff self-submit route reusing its existing
  submit function verbatim. A shared `ApprovalTrailView` and a cross-type
  Approval Log (visible to Admin or any real ApprovalRole member) give
  "who approved what" full visibility. See `docs/APPROVAL-HIERARCHY-notes.md`.
- **Mobilisation module COMPLETE** — a new commercial+staffing record for
  placing a worker with a client (optionally through a `Subcontractor`, a
  new simplified Client-like entity), replacing the coordinators' Excel
  sheet: full `Subcontractor` CRUD; `Mobilisation` CRUD with snapshot
  fields from Employee/Client/Subcontractor and a plain editable `profit`
  (not auto-calculated — the commission formula isn't verified yet, same
  posture as Payroll's manual GOSI); joint-coordinator invite/confirm and
  submit-to-review; Marketing Manager commercial-details + decide, reusing
  the Configurable Approval Hierarchy engine unchanged (one small
  backward-compatible extension: `decideApprovalStep` gained an optional
  `notifyFinal` override, since Mobilisation's coordinators are Users
  directly, not an Employee-linked login the engine's default assumes); an
  admin-configurable `MobilisationSettings` viewer-role circle (BDM/
  Marketing Manager/FM/COO/GM see everything once submitted) and
  self-mobilise roles, deliberately NOT reusing the Approval Log's generic
  "any ApprovalRole member" check since the real org chart has roles that
  should be excluded from mobilisation visibility; commercial-field
  stripping for a plain Coordinator once Approved; multi-file documents
  reusing the existing private Cloudinary pipeline. See
  `docs/MOBILISATION-notes.md`.
- **Workforce model: Subcontracted employee type + Staff login role
  COMPLETE** — a third `Employee.type` (`'Subcontracted'`) for a worker
  sourced from an outside `Subcontractor` (their real employer, not this
  company): full compliance/attendance tracking applies, but Payroll and the
  dashboard's payroll-cost figure stay `'Client'`-only by design, since this
  company never pays them. A new `Staff` login role reuses the existing
  Worker ESS portal (`/api/me`) verbatim for office employees who need a
  login but only for their own self-service, never the company-wide staff
  modules. Also fixed a real pre-existing bug found during verification: a
  PATCH to an employee that omitted `type`/`status` was silently resetting
  both to their schema defaults (Zod's `.partial()` doesn't suppress
  `.default()`) — the same class of bug this file's `weeklyOffDay` field had
  already been written to avoid, just not consistently applied. See
  `docs/WORKFORCE-MODEL-notes.md`.
- **Navigation consistency: Back button everywhere + login role correction
  COMPLETE** — a `PageHeader` `onBack` prop (icon arrow left of the title)
  rolled out to every page one level below a sidebar hub (29 pages), plus
  the previously-missing Employee/Client/Quotation/Mobilisation Edit pages;
  hub landing pages and Dashboard deliberately excluded (already one click
  from the sidebar). New: `PATCH /api/employees/:id/user/role` lets Admin/HR
  correct an existing login's role (e.g. Worker picked instead of Staff),
  revoking sessions so it takes effect immediately — the Team/Users admin
  page still deliberately excludes Worker/Staff logins from its own
  management surface, so this lives on the Employee profile instead. Also:
  `Input`/`Textarea` now default `autoComplete="off"` (Chrome was leaking
  autofill suggestions between every entity's `name` field app-wide, since
  they all shared one origin-wide autofill bucket) — **superseded 2026-09-05**,
  see below. See `docs/UI-NAVIGATION-notes.md`.
- **Follow-up (2026-09-05): autofill fix replaced + 6 missed back buttons
  COMPLETE** — the `autoComplete="off"` fix above didn't actually stop
  Chrome's "Addresses and more" contact-autofill, which ignores that
  attribute's value entirely for a field it heuristically recognizes as
  name/email/phone-shaped. Real fix: `Input`/`Textarea` now render `readOnly`
  until the field's first click/focus, so Chrome never gets an editable
  field to attach suggestions to in the first place — scoped to only the
  default case, so Login/Change-password's explicit `autoComplete` overrides
  are unaffected. Also found and fixed: the original back-button audit only
  covered pages one level below a nav hub, missing every hub's own "New"
  page — 6 pages (Mobilisation/Deployment/Settlement/Employee/Quotation/
  Client) gained `onBack`. See `docs/UI-NAVIGATION-notes.md`.
- **Company Settings COMPLETE** — a real company profile (legal identity,
  contact & address, bank details, authorized signatory, logo), admin-
  configurable `manageRoles` circle (Admin/Manager always; else any member
  of a chosen `ApprovalRole`, changing the circle itself is Admin-only), and
  wired into every PDF generator (Invoice, Quotation, Settlement,
  Certificate, Payslip) via one shared `getLetterheadData()` call and a
  common `LETTERHEAD_HEIGHT` constant — a PDF generated before the profile
  exists still renders exactly as it always did. Invoices also gained a
  Payment Instructions section (bank name/IBAN) shown only on a
  still-outstanding balance. See `docs/COMPANY-SETTINGS-notes.md`.
- **Job Titles COMPLETE** — replaced Mobilisation's free-text Job title
  field with an admin-managed picklist (`JobTitle` model), writable by
  Admin/Manager or any `ApprovalRole` member (a coarser, lower-stakes check
  than Company Settings' own `manageRoles`, matching the lower sensitivity
  of a label list), with an inline "+ Add new" quick-create modal on the
  Mobilisation form. `Mobilisation.jobTitle` stays a plain snapshot string,
  not a foreign key — same durable-history convention as `clientName`/
  `workerName`. A real bug was found and fixed during verification: the
  newly-created title wasn't auto-selecting because `setValue` ran before
  the invalidated list query's refetch had put the matching `<option>` in
  the DOM; fixed by deferring the selection to a `useEffect` that waits for
  the option to actually exist. See `docs/JOB-TITLES-notes.md`.
- **RBAC tightening COMPLETE** — prompted by the user noticing Manager could
  configure Leave Types (an Admin/HR job). Moved Leave Type + Holiday
  calendar config to Admin/HR only. Added a new `Executive` role (GM/COO)
  built deny-by-default — excluded from `STAFF_ROLES` so every CRUD module
  rejects it automatically, then explicitly allow-listed via a new
  `requireStaffOrExecutive` into only the Dashboard and the Leave/Timesheet/
  SalaryAdvance/Reimbursement list+submit+decide endpoints + the Approval
  Log; real per-item authorization still comes entirely from `ApprovalRole`
  membership via the shared engine, unchanged. The sidebar gives Executive
  its own short, explicitly-defined flat nav rather than another `roles`
  filter on the existing grouped one — an unguarded nav item is visible to
  anyone by default, which is exactly how Manager's clutter happened in the
  first place. Also added a precautionary "are you sure?" confirmation
  (reusing `ConfirmDialog`, previously delete-only) to every Approve/Reject
  action across Leave/Timesheet/Salary-Advance/Reimbursement — a real
  pre-existing gap for every role, not just Executive. Mobilisation and
  Client decide flows were deliberately left out of this pass (see
  `docs/RBAC-notes.md`). See `docs/RBAC-notes.md`.
- **Tabbed layout COMPLETE** — the 5 pages that stacked several independent
  panels vertically (Leave, Timesheets, Financial Requests, Exit Documents,
  Approval Hierarchy) now split them into tabs instead, prompted by the
  same UX review that led to the RBAC pass above. New shared
  `components/ui/Tabs.jsx` (fully controlled, horizontally-scrollable at
  every width rather than collapsing to a `<Select>` on mobile,
  lazy-mount-then-keep-alive so switching tabs never loses in-progress
  form input) plus a `useTabParam` hook backing the active tab with a
  `?tab=` URL param — chosen specifically so every existing
  "needs your approval" notification link (which points at the bare page,
  now also each page's default tab) keeps working with zero server change,
  while leaving room for a future notification to target a specific tab.
  Two pages needed real internal surgery (Financial Requests' submit
  panels were exported out of their review-panel files; Timesheets' inline
  queue was extracted into its own component so its bulk-approve button
  could move out of the always-visible `PageHeader` into the queue's own
  tab); the other three were pure page-shell swaps. See
  `docs/TABS-notes.md`.
- **BDM/Manager dashboard narrowing + attendance fixes COMPLETE** — the
  Manager-role dashboard (the generic login a BDM job title holds) no
  longer shows Pipeline/Profit/Recent Activity (Admin/Executive territory);
  "Pending quotations" is now personal (their own Drafts — required adding
  a real `Quotation.createdBy` field). A new "Waiting on you" widget (real
  per-viewer pending-decision counts, every role) replaced the old
  company-wide-only framing. Manager can now self-mark attendance
  (`STAFF_SELF_ATTENDANCE_ROLES`). Root-caused a recurring native-scrollbar
  UI glitch to a genuine CSS quirk (`overflow-x-auto` alone forces the
  other axis to `auto` too) rather than guessing from a screenshot, via
  `getComputedStyle` at the exact reported coordinates. Also fixed a real
  pre-existing bug found during verification: the query cache was never
  cleared on login/logout, so switching accounts in one tab could briefly
  leak the previous user's cached data. See `docs/BDM-DASHBOARD-notes.md`.
- **Section Access COMPLETE** — a generic, admin-configurable "who else can
  open this section" mechanism (extracted from the bespoke pattern Company
  Settings/Mobilisation Settings each built independently), covering
  Payroll and Expenses first. Each section grants access by literal login
  role and/or by a named `ApprovalRole` (e.g. "Financial Manager", "COO")
  — Admin always has full access; nobody else does until granted. Both
  modules collapsed from three role tiers (view/write/finalize) to one
  unified circle per section, matching the user's own framing ("do
  whatever they want") — Accounts kept default access (now including
  finalize/delete, which it previously lacked), Manager/HR lost their
  previous default access. New Admin-only Section Access settings page.
  See `docs/SECTION-ACCESS-notes.md`. Extended the same afternoon: a third
  section, `employeeCreate` (Admin only by default, until an admin
  designates a real "office secretary" via an `ApprovalRole` grant),
  replacing Employee's old static `requireRoles('Admin','Manager','HR',
  'Coordinator')` create guard — plus a new `GET /section-access/:key/mine`
  endpoint (any user, not Admin-only) so a page can hide a gated button
  before a wasted form-fill 403s. Found and fixed a real pre-existing bug
  in the same pass: a Coordinator's create form let them pick "Own —
  internal staff," which the server always overrides to 'Client', but that
  override runs after Zod validation — a Coordinator following the form's
  own "optional for Own" guidance would 400 on fields Mongoose required for
  the type they were silently flipped into. Fixed by never offering 'Own'
  to a Coordinator in the first place.
- **Exit Re-Entry & Certificate join the Approval Hierarchy engine
  COMPLETE** — the same self-submit gap the original Configurable Approval
  Hierarchy work closed for Leave/Timesheet/SalaryAdvance/Reimbursement,
  closed for these two: a staff login can now submit their own request
  (new "Submit Re-Entry"/"Submit Certificate" tabs), and an Admin can
  configure a multi-step `ApprovalWorkflow` for either from the Approval
  Hierarchy page — both types added to `APPROVAL_REQUEST_TYPES`, both
  models gained the standard `workflow`/`steps`/`currentStep`/
  `approvalTrail` fields, both `decide` functions now run through the
  shared engine. Marking a request actually issued stays a separate,
  narrower Admin/Manager/HR-only step (HR/compliance paperwork, not part
  of the approval chain). Found two more latent bugs while wiring this in:
  the Approval Log's source map only ever listed `Leave` (SalaryAdvance/
  Reimbursement/Timesheet/Mobilisation support workflows too but were
  never added — follow-up queued), and the shared `ApprovalTrailView`'s
  progress badge was hardcoded to Leave's own pending-status string
  (fixed via a prop for the two new types; four existing callers still
  carry the old bug — follow-up queued). See
  `docs/APPROVAL-HIERARCHY-notes.md`'s 2026-09-06 follow-up.
- **Staff panel Arabic, first increment (shell + Dashboard) COMPLETE** —
  P3-G's ESS-only i18n scope explicitly extended to the staff panel too,
  English/Arabic only (Hindi/Nepali/Bengali stay ESS-only — a different
  persona), rolled out module by module like everything else in this app.
  Before writing code, a real design tradeoff was put to the user: whether
  RTL should flip app-wide the moment Arabic is picked (even on the ~49
  staff pages not yet translated) or only per-page as each is translated —
  decided in favor of flipping immediately, everywhere, for one consistent
  direction throughout the rollout. Reuses the ESS portal's exact i18next/
  RTL machinery (one shared instance); `LanguageSwitcher` gained an
  optional `languages` prop so the staff shell can offer a restricted
  English/Arabic list without touching the ESS's own 5-language mount
  points. This increment: the full navigation shell (every sidebar/hub
  label+description), the staff header chrome, and the entire Dashboard
  page + its 6 sub-components — every visible string, not a partial pass.
  See `docs/STAFF-I18N-notes.md`.
- **Follow-up (2026-09-06): Hindi/Nepali/Bengali removed app-wide** — the
  user decided the ESS portal's workforce-language scope was no longer
  wanted; every surface (ESS, login, staff panel) is now English/Arabic
  only. Removed the three locale files, their i18n registrations, and the
  now-redundant `STAFF_SUPPORTED_LANGUAGES` split (`LanguageSwitcher` no
  longer needs a per-surface `languages` override). See
  `docs/P3-G-notes.md`'s superseded note.
- **Section Access expanded to every module COMPLETE** — the original
  Payroll/Expenses/`employeeCreate` mechanism now covers ~20 sections
  app-wide: the two older bespoke "who else can open this" patterns
  (Company Settings' `manageRoles`, Mobilisation Settings'
  `viewerRoles`/`selfMobiliseRoles`) folded into it; every other
  financial/sensitive whole-module screen (Invoices, EOSB, Financial
  Requests' decide action, the Security Log, Timesheet Processor, NFC
  Customers, Team's staff-login list) and every remaining write-only action
  (Clients, Deployments, Subcontractors, Attendance marking, Documents,
  Assets, Quotations, Ramadan Periods, the Approval Hierarchy's own
  role/workflow editing) now has a real, admin-configurable circle instead
  of a hardcoded role list — plus, as an optional but genuinely
  zero-regression finishing touch, Leave/Timesheet/Exit-Documents' router
  floors too. Every default preserves today's real access exactly (a
  rollout that silently changed nothing) except two explicitly-flagged
  cases: Accounts gains full EOSB rights (create/delete, not just view) and
  Coordinator's mobilisation create-permission (from the earlier Mobilisation
  Settings reconciliation) moves from hardcoded to admin-editable. A real
  design bug was caught and fixed mid-implementation: `financialRequests`
  first tried to gate the review queue itself, which broke Coordinator's
  existing self-submit right and, more importantly, revealed that a
  Section Access floor sitting in front of the shared Approval workflow
  engine's own per-step authority check must never be narrower than the
  floor it replaces — fixed by only gating the DECIDE action, with a
  default matching the original floor's full reach. The client's
  `SectionAccessPage` (now ~20 cards) groups them under the same
  Workforce/Sales/Financial/Admin categories the sidebar itself uses;
  `navConfig.js` hides a nav item entirely for an ungranted whole-module
  section (matching Payroll/Expenses) while a write-only section's nav item
  stays visible with its Create/Edit button gated internally (matching
  Employees' own `employeeCreate` precedent) — surfacing two more real
  pre-existing bugs along the way (a dashboard shortcut and a Ramadan-page
  button each checking the wrong, unrelated role list). See
  `docs/SECTION-ACCESS-notes.md`.
- **Deployments redesign COMPLETE** — Deployment (a Phase-1 module with zero
  real data) is now the automatic outcome of an Approved Mobilisation, not a
  standalone manual "Assign worker" flow (which was removed entirely, along
  with its `deploymentsManage` Section Access key). Covers all three
  Mobilisation worker types via a `mobilisation` reference rather than
  duplicating identity fields — `Employee.currentClient/currentSite` only
  sync for a real Employee. While Active, a new embedded monthly
  client-timesheet-hours/OT ledger (`deploymentsHours` Section Access, with a
  hardcoded Office Secretary bypass) auto-computes OT hours against the
  coordinator's contracted hours but takes a manually-entered OT amount — no
  verified commission formula, same posture as GOSI. A new "Release" action
  (`deploymentsRelease` Section Access) ends the Deployment AND completes the
  source Mobilisation in one transaction, freeing the worker back to standby
  for a brand new Mobilisation — replacing the old standalone `/complete`
  route entirely (superseded, not kept as a parallel path). Mobilisation
  gained an optional free-typed `site` field (Deployment's old required one,
  loosened since Mobilisation now drives Deployment creation automatically).
  See `docs/DEPLOYMENT-notes.md`.
- **Section Access: Read/Write split COMPLETE** — every one of the ~22
  governed sections now has two independent tiers instead of one grant:
  Read (can view) and Write (can create/edit/decide/delete — always
  includes Read). Read defaults to literally mirror each section's existing
  Write default, no exceptions — a deliberate, informed choice by the user
  that immediately tightens a handful of sections whose Write was already
  narrow by design (Adding Employees, Approval Hierarchy, Deployments now
  default to Admin-only Read too, until re-granted). Real Read gates were
  added to every previously wide-open `GET` route across ~19 modules; a
  router-level `RequireSectionRead` guard and `sectionKey` on every nav item
  now hide a whole section a viewer can't even read, not just its buttons.
  Found and fixed two real pre-existing-shape bugs while migrating the data:
  `mobilisation.service.js`'s `isMobilisationViewer` read the Section Access
  document's fields directly (bypassing the shared `canAccessSection`
  check) — a rename would have crashed it outright — and `team`'s own route
  was relying on the write-tier default that no longer applies to it. See
  `docs/SECTION-ACCESS-notes.md`'s "Read/Write split" section.
- **White-labeled app shell (BrandLogo/useBranding) COMPLETE** — every
  hardcoded "Al Jazeera"/`logo.png` reference (staff sidebar, ESS sidebar +
  footer, login screen, no-portal-access screen) replaced with the real
  company's own logo/name from Company Settings, falling back to a plain
  "V" mark + "Valizent CRM" until a company sets one — this app is meant to
  be redeployed per customer (see the SaaS-productization discussion this
  session: one deployment per customer, same codebase, not multi-tenant),
  so nothing in the shell may name a specific business. New public `GET
  /api/company-settings/branding` (no auth, no Section Access — has to
  reach the pre-login screen and ESS Workers). Found and fixed two real
  bugs during this work: a pre-existing routing landmine where `leaveRoutes`
  mounted at the bare `/api` prefix with its own blanket `requireAuth`
  silently intercepted any `/api/*` request that fell through to it before
  reaching a later-mounted module (invisible until this was the first
  genuinely public route added after that mount point) — fixed by moving
  company-settings' mount earlier; and saving Company Settings not
  refreshing the header immediately (a separate, uninvalidated query).
- **Deployment monthly-hours Approve/Reject COMPLETE** — the monthly
  client-hours/OT ledger (Deployment redesign, above) previously saved
  immediately with no review step. Added single-level Approve/Reject per
  entry (`status`/`decidedBy`/`decidedAt`/`decisionNote`) — deliberately
  not the full Configurable Approval Hierarchy engine, since an embedded
  array entry doesn't fit that engine's top-level-document shape; same
  judgment call Financial Requests already made. New Section Access key
  `deploymentsHoursDecide`, separate from the existing `deploymentsHours`
  (entry) key so whoever enters hours is never automatically who approves
  them — Admin-only until granted (typically to a "Marketing Manager"
  `ApprovalRole`). An Approved entry is locked; editing a Rejected one is
  an implicit resubmit back to Pending. Notifies the configured decider(s)
  on every submit/resubmit and the original enterer on every decision. See
  `docs/DEPLOYMENT-notes.md`'s 2026-09-10 follow-up.
- **Deployment: daily timesheet grid + real profit + post-approval
  correction COMPLETE** — monthly hours are now entered day-by-day (one
  input per calendar day, exact count validated both ends), with
  `actualHours` always the server-computed sum, never client-submitted. A
  real per-month profit (reusing Mobilisation's own established formula,
  rate fields read from the linked Mobilisation) is computed fresh on
  every read and stripped server-side for anyone without
  `deploymentsHoursDecide` — same sensitivity class as Mobilisation's
  COMMERCIAL_FIELDS. Whoever can decide this section may now also correct
  an already-Approved entry directly (status stays Approved, no
  reject/re-enter/re-approve round trip) — fully audited with before/after
  values and a proactive notification to the original enterer; the plain
  enterer stays locked out of an Approved entry exactly as before. Also:
  `MobilisationForm` now surfaces every client-side validation failure as
  a toast (previously silent — react-hook-form never fires a mutation's
  own `onError` for a failed client-side check), now a standing rule for
  every form in the app. Found and fixed a severe, unrelated pre-existing
  bug along the way: `Deployment`'s `uniq_active_worker` partial index
  used `$ne`, an operator MongoDB's partial-index filters don't support at
  all — it was silently dropped at index-creation time, meaning only ONE
  Active Freelancer/SupplierEmployee deployment could exist system-wide,
  ever, since the feature shipped. See `docs/DEPLOYMENT-notes.md`'s
  2026-09-12 follow-up.
- **Deployment: real Demobilise lifecycle (Standby vs. Exit) + EOSB hookup
  COMPLETE** — Release renamed to Demobilise (status/action labels are
  display-only; the `status` enum itself is unchanged) with a real reason
  taxonomy: `ClientAssignmentEnded` frees the worker back to standby exactly
  as before, while `TerminatedByCompany`/`Resigned`/
  `TransferredToAnotherCompany` (sponsorship/"Tanazel" transfer,
  Employee-only) also set `Employee.status='Exited'` — closing a real gap
  where an employee's actual departure was previously a manual,
  easy-to-forget HR form edit, decoupled from the Payroll/dashboard/
  expiry-alert exclusions that already key off that status.
  `mobilisation.service.js` now refuses to re-mobilise an Exited employee,
  so the exit is a real dead end, not cosmetic. Connects to the financial
  pipeline via a non-blocking post-demobilise prompt deep-linking to EOSB (a
  new `SponsorshipTransfer` exit reason added there, zero formula change)
  plus a proactive notification to whoever holds EOSB access — explicitly
  not wired to Invoice/Dashboard profit, the same deliberately-deferred gap
  as before. Also closed a second real gap found along the way:
  SupplierEmployee/Freelancer workers had no equivalent of Employee's
  double-placement guard at all (same bug class as the index fix above),
  and fixed a pre-existing `SettlementNewPage.jsx` bug where a preset
  employee silently failed to auto-select when the employee list hadn't
  loaded yet (same fix pattern as the Job Titles auto-select bug). See
  `docs/DEPLOYMENT-notes.md`'s 2026-09-12 follow-up.
- **Mobilisation: list/detail visibility bug + Office Secretary standing
  Section-1 edit right, both COMPLETE** — user-reported via screenshot: an
  Office Secretary saw a mobilisation in her list but got "Mobilisation not
  found" opening it once it moved past her review step. Root cause: the
  list query matched membership in *any* workflow step's role pool, while
  the single-record fetch correctly checked only the *current* step — fixed
  by making the list query match exactly what the detail fetch checks. The
  user also asked for whoever holds step 0 (Office Secretary today) to keep
  the right to fix Section 1 throughout the record's entire `PendingReview`
  life, not just while it's literally still on step 0 — added a
  `canEditSection1` flag plus a matching write-gate fix. Found two real
  gaps only during live verification: the view gate itself never consulted
  the new flag (so a step-0 reviewer would still 403 just opening the
  record), and the list needed its own standing-right OR-arm too, or the
  edit right would have been unreachable — nothing left in her list to
  click into. Verified read-only against the real record and the real
  Office Secretary's actual role membership, no test writes to live data.
  See `docs/MOBILISATION-notes.md`'s 2026-09-08 follow-up.
- **Mobilisation: "client timesheet hours" removed, moved to Deployment
  COMPLETE** — the Section-2 reviewer form's manually-typed "Client
  timesheet hours" (and the `otHours`/OT-inclusive `profitPerMonth` derived
  from it) is gone; that real, month-by-month timesheet already lives on
  the Deployment this mobilisation produces once Approved (see the
  Deployment daily-grid follow-up above), so the Mobilisation-level number
  could only ever be a single stale snapshot next to it. `profitPerMonth`
  is now a simpler pre-deployment estimate off `requiredTimesheetHours`
  only (no OT term); `otClientRate`/`otClientCommission`/
  `otSubcontractorRate`/`otSubcontractorCommission` and the new
  hours-independent `otProfitPerHour` stay, since Deployment's own
  `computeMonthlyProfit` already reads the rate fields straight off this
  document. See `docs/MOBILISATION-notes.md`'s 2026-09-12 follow-up.
- **Mobilisation: client rate mandatory, OT rates move to Section 1, and a
  real cross-mobilisation date-overlap bug fixed, all COMPLETE** — client
  rate is now required at creation (every other Section 1 rate stays
  optional); the OT rate fields (`otClientRate`/`otClientCommission`/
  `otSubcontractorRate`/`otSubcontractorCommission`) moved from Section 2
  (the current-step reviewer's later pass) to Section 1, set up front by
  whoever creates the mobilisation, per the user's own ask. Separately, a
  real bug the user found: demobilising a worker and then creating a new
  mobilisation let its date be backdated into the middle of the just-ended
  (or any earlier) placement — physically impossible, since the existing
  double-placement guards only ever checked current mobilisation *status*,
  never the worker's actual placement history. Fixed with a new
  `assertNoDateOverlap` walking the worker's full Deployment history
  (Employee id, or Iqama number for SupplierEmployee/Freelancer), checked
  at creation, at edit (only when identity/date actually changed), and
  again right before approval creates the real Deployment (the load-bearing
  gate, since time can pass between creation and final approval). Same-day
  handoffs between clients are explicitly allowed, confirmed with the user
  first. See `docs/MOBILISATION-notes.md`'s 2026-09-13 follow-up.
- **Mobilisation: Rates & Financials hidden from the step-0 reviewer
  specifically, COMPLETE** — the user asked to hide commercial data from
  Office Secretary, only the Manager needs it, and whether this was already
  an admin control. It wasn't fully: the `mobilisationsViewer` Section
  Access key already lets Admin grant broader visibility (and already grants
  it to `Manager` in this company's real config, confirmed against the live
  setting — why Marketing Manager already saw rates correctly), but a
  separate hardcoded rule always gave the CURRENT-step reviewer everything
  unstripped regardless of which step, with no way to turn that off. Fixed
  by excluding step 0 specifically (not a hardcoded "Office Secretary" role
  check — consistent with steps being admin-configurable) from commercial
  visibility, in both the single-record and list/export code paths; a
  later-step reviewer, a `mobilisationsViewer` member, or the coordinator
  pre-Approval are unaffected. See `docs/MOBILISATION-notes.md`'s second
  2026-09-13 follow-up.
- **Deployment: daily grid weekdays, Off/Sick/Absent, keyboard entry
  COMPLETE** — the daily timesheet grid now shows a locale-aware weekday
  under each day number (English "Mon"/Arabic single-letter, chosen per
  language after confirming Arabic's own compact ICU form is actually the
  full word), and a day is typed as either a plain number (hours worked) or
  a single letter — F/S/A for Off/Sick/Absent — in the SAME cell, fully
  replacing hours entry for that day rather than sitting next to it
  (confirmed with the user: manually marked in the grid, not auto-pulled
  from Attendance, since a client timesheet can legitimately differ from
  internal attendance and SupplierEmployee/Freelancer have no Attendance
  record at all). `Deployment.monthlyHours.dailyHours` widened from a plain
  number array to `{status, hours}`, `hours` required only when
  `status:'Worked'`, `actualHours` now only sums Worked days — safe to
  change with zero migration, since the only real `monthlyHours` entry in
  the live database predates the daily grid and has no per-day data at all.
  Pressing Enter in a cell moves focus to (and scrolls to) the next day, so
  a full month can be typed without the mouse. See `docs/DEPLOYMENT-notes.md`'s
  2026-09-13 follow-up.
- **Section Access: login-role grants removed, Approval Roles only
  COMPLETE** — per the user's own instruction, `readRoles`/`writeRoles`
  (the literal-`User.role` grant type) are gone entirely from the model,
  service, validation, and the Section Access page's UI; `readApprovalRoles`/
  `writeApprovalRoles` are now the only way anything is granted, for both
  tiers, across all ~27 sections. A migration
  (`npm run migrate:section-access-approval-roles`) converted every
  section's existing login-role grant into a matching, auto-created (or
  reused, where this company's real org chart already had one) Approval
  Role — the path the user chose after being shown the alternative
  (resetting everyone to Admin-only) — so no real login lost access it had
  yesterday; verified 24/24 against real data. Found and fixed two real
  crash bugs during verification: `mobilisation.service.js`'s
  `isMobilisationViewer` and `deployment.service.js`'s
  `decidersOfDeploymentsHours`/`decidersOfEosb` still read the now-removed
  fields directly and would have thrown on the mobilisation list/detail
  pages and deployment notifications the moment this shipped. Same-day
  follow-up: the 3 Approval Roles the migration auto-created ("Manager",
  "Accounts", "Executive") to preserve access were deleted outright after
  the user saw them sitting alongside the real org-chart roles and asked
  for true decoupling, no login-role-shaped stand-ins at all — every
  section that depended ONLY on one of them (`companySettings`, `invoices`,
  `quotationsManage`) is now genuinely Admin-only until deliberately
  re-granted; every other section keeps whatever real role (HR,
  Coordinator, or a pre-existing org-chart grant) it also had. See
  `docs/SECTION-ACCESS-notes.md`'s 2026-09-13 follow-ups.
- **Deployment: OT amount auto-computed and commercial-only, plus a quick
  hours summary COMPLETE** — the monthly-hours entry's `otAmount` is no
  longer typed in by whoever enters hours; it's always server-computed as
  `otHours × Mobilisation.otClientRate` (the OT rate already quoted to the
  client), and now gets the exact same commercial-only treatment as
  `profit` — stripped from the response for anyone without
  `deploymentsHoursDecide` access. Found and fixed a real pre-existing
  exposure gap while making this change: the raw commercial rate fields on
  the populated `mobilisation` sub-object were being sent to EVERY viewer
  unconditionally (only the derived `profit` was ever gated) — a
  non-decider could already read `otClientRate` straight off the API and
  back-compute the OT amount herself. Also added a small live-updating
  summary (client agreement hours / total worked / OT hours, plus OT
  amount for a decider only) to both the entry form and the Approve/Reject
  modal, which previously showed no numbers at all before a decision.
  Same-day follow-up: fixed Office Secretary's inability to open a
  deployment page by direct URL (a `RoleRouter` redirect predating
  Deployment's own hardcoded exception for her, plus `RequireSectionRead`
  not knowing about that exception either) — and, while making that fix,
  found and fixed a real reference-error bug in `RequireSectionRead.jsx`
  from an earlier edit in this same session (its imports had been
  accidentally deleted; invisible to `npm run build`, a guaranteed crash on
  render). Same-day follow-up: fixed a real user-reported gap where a
  day's hours could be typed as "25" (or "24.9") with zero feedback — the
  server always correctly rejected it (a real numeric `.max(24)` check,
  not pattern-based), but the client's regex-based check silently let the
  invalid value sit in the live total with no visual cue, and this form's
  `handleSubmit` had never been wired with the `onInvalid` toast that's
  the standing rule for every form in the app. Fixed with a shared numeric
  range check (`isValidDailyEntry`, used by both the Zod schema and live
  per-cell red highlighting) and the missing toast — which itself needed a
  recursive error-message collector, since react-hook-form nests an
  array-field-level refine error a level deeper than `MobilisationForm`'s
  own flat fields ever hit. See `docs/DEPLOYMENT-notes.md`'s 2026-09-13
  follow-ups.
- **Deployment: client-timesheet deductions, wired into real Payroll
  COMPLETE** — a new `deductionAmount` on the monthly-hours entry (a client
  penalty, most commonly for an Absent day — manually entered, no in-app
  formula, same posture as GOSI) is subtracted from that month's `profit`
  and, for a real Employee this company actually pays (`type:
  'Outsourced'`), automatically flows into that month's PayrollRun as an
  `otherDeductions` line the moment the entry is Approved — a genuine new
  one-directional dependency from Payroll onto Deployment, landing in a
  mechanism (`otherDeductions`) that already existed for exactly this
  purpose. Two real design forks (informational-only vs. a real Payroll
  integration; commercial-only like `otAmount` vs. staying visible to
  whoever enters it) were put to the user directly before building either
  — they chose the fuller path both times. Same snapshot-at-creation
  limitation every other auto-computed Payroll figure already has: a
  deduction entered/approved after that month's run already exists isn't
  retroactively pulled in. See `docs/DEPLOYMENT-notes.md`'s and
  `docs/P2-M5-notes.md`'s 2026-09-13 follow-ups.
- **Dashboard driven by real Section Access reads + Section Access "Save
  all changes" COMPLETE** — the dashboard no longer decides what to show
  via a hardcoded `isManager`/`isCoordinator` role list; every widget
  (Employees, Deployments, Clients, Quotations, Payroll, Audit Log,
  Attendance, Documents) now checks the SAME `canAccessSection(key, actor,
  'read')` grant its own module page is already gated by, and `profit`
  requires read on all three of Invoices/Payroll/Expenses at once (a
  partial figure would be a real number meaning something else entirely —
  the user's own explicit call, confirmed before building). Coordinator's
  existing team-scoping is untouched (a data-scoping rule, orthogonal to
  whether a widget is visible at all). Real, expected consequence: several
  roles' dashboards got sparser, since their actual current grants are
  narrower than the old hardcoded rule assumed — e.g. real Coordinators
  now lose the workforce/attendance widgets they always saw before, since
  neither is currently granted to them. This is the intended effect, not a
  regression — access is now fully controllable from the Section Access
  page, which itself gained the user's other ask: a page-level "Save all
  changes (N)" button, batch-saving every card with unsaved edits at once
  via `Promise.allSettled`, alongside (not replacing) each card's own
  individual Save. See `docs/BDM-DASHBOARD-notes.md`'s and
  `docs/SECTION-ACCESS-notes.md`'s 2026-09-13 follow-ups.
- **Section Access: drill-down redesign, Holidays governed, Attendance split
  into three COMPLETE** — the flat card list became a real Category → Module
  → editor drill-down mirroring the sidebar's own grouping/naming/order
  exactly (`sectionAccessModules.js`, reading straight off `navConfig.js`);
  Holidays joined as a Write-only key (Read stays open to everyone including
  Workers, unchanged); Attendance's single `attendanceManage` key split into
  `attendanceRecords`/`attendanceSignInOut`/`attendanceOfficeLocation` so a
  login can be granted, say, self-mark eligibility without the full records
  grid or vice versa — closing a real pre-existing bug where the whole
  `/attendance` route required the single old key, silently blocking both
  real Coordinators in this company from ever reaching their own punch
  button. `RequireSectionRead`/`SectionHubPage` now accept an array of
  section keys ("any one grants entry"), the mechanism this fix runs on.
  See `docs/SECTION-ACCESS-notes.md`'s 2026-09-13 follow-up.
- **Timesheets: weekly submit/review workflow killed, real Monthly Report
  list/view/export COMPLETE** — per the user's own instruction, the
  Requests/Submit Timesheet tabs are gone from the client; Monthly Report is
  now the whole page: every `'Own'`-type (internal staff) employee in a
  list, click one to see a real day-by-day month built from their actual
  attendance (weekly-off/holiday-aware, a forgotten-checkout day flagged as
  "Single Punch" in its own color), export as `.xlsx` in the same visual
  format the Timesheet Processor already uses. `monthlyReport.service.js`
  now branches its data source on employee type — `'Own'` staff self-punch
  through the separate `StaffAttendance` collection (keyed by their User
  login, not their Employee record), never through Employee-based
  `Attendance`, a real, non-obvious wrinkle this surfaced and fixed.
  Deliberately NOT touched: the underlying Timesheet model/service/routes,
  since Payroll's P3-E overtime figure is computed from an approved
  Timesheet record — only the client UI calling them was removed, which
  means Payroll's overtime component will stop getting new data going
  forward until a separate, not-yet-made decision about where it should
  source from instead. See `docs/TIMESHEETS-MONTHLY-REPORT-notes.md`.
- **Office Secretary moved into the full staff floor COMPLETE** — found via
  a real user report: granting the "Office Secretary" Approval Role Write on
  a section did nothing for the real Office Secretary login, because
  `canAccessSection`'s floor checked her LOGIN role first (deny-by-default,
  excluded from `STAFF_ROLES` since she was built single-purpose for the
  Mobilisation module's review step) and returned false before her Approval
  Role membership was ever checked — the grant and the login role share a
  name but are otherwise unrelated. Given the original narrow-by-design
  reasoning directly, the user chose to move her into the full staff floor
  like Coordinator/HR/Manager/Accounts rather than a narrower fix. One-line
  root change (`STAFF_ROLES` in `rbac.js` no longer excludes her) ripples
  correctly everywhere that constant is already used, including `GET
  /api/dashboard` (she'd never been allow-listed there before, which is why
  `/` used to 403 and redirect her to Mobilisations); removed the
  now-redundant `requireStaffOrOfficeSecretary` and her hardcoded flat nav,
  she now gets the normal grouped sidebar. Every hardcoded, per-feature
  Office-Secretary business rule already in Mobilisation/Deployment (self-
  mobilise-for-a-busy-Coordinator, the hours-entry bypass, etc.) was left
  untouched — real business rules, unrelated to this floor. See
  `docs/RBAC-notes.md`'s 2026-09-13 follow-up.
- **13 September 2026 QA/security audit: full remediation COMPLETE** — an
  external audit report (S1–S4 security, A1–A6 auth/permission gaps, F1–F10
  functional bugs, D1–D3 dead code/drift) was independently spot-checked
  against source before fixing (8/8 highest-severity claims confirmed real,
  including F10, a bug in this app's own prior-session work) then fixed in
  full per the user's "fix everything." Headline fixes: three read-then-
  write concurrency races on money/hours (Invoice payments, SalaryAdvance
  repayments, Deployment monthly hours) rewritten as atomic MongoDB
  updates; a stuck-Approved-with-no-Deployment gap closed with a
  compensating rollback rather than a full cross-collection transaction; a
  deactivated Approval Role now actually stops deciding (4 call sites were
  missing the check); Coordinator team-scoping closed on Attendance/
  Documents/Assets/EOSB/Deployment/Timesheets; a password reset now
  invalidates already-issued access tokens, not just refresh sessions
  (new `User.passwordChangedAt`). The three concurrency races, the
  compensating rollback, and both authorization-gap fixes were verified
  with real script-based tests against the dev database (not just
  read-through) — see `docs/QA-AUDIT-2026-09-14-notes.md` for the full
  finding-by-finding breakdown and verification evidence.
- **Standby List COMPLETE** — a real view of who's currently free to
  mobilise, covering both real populations as one combined view (the
  user's own choice, put to them directly after the two candidate
  populations turned out to need genuinely different data sources): an
  Own+Worker-login Employee's availability is a live `currentClient`
  field; a SupplierEmployee/Freelancer worker's is derived from their most
  recent Mobilisation (no Employee record, so no live field exists for
  them). New `GET /api/deployments/standby` and `/deployments/standby`
  page, reached via a "Standby list" button on the Deployments list. See
  `docs/DEPLOYMENT-notes.md`'s 2026-09-14 follow-up.
- **Mobilisation: OT rate fields simplified — no client-commission/
  subcontractor split for OT, COMPLETE** — the user's own correction from a
  screenshot of the form: `otClientCommission`/`otSubcontractorRate`/
  `otSubcontractorCommission` "do not exist" in real terms — OT only ever
  has a client bill rate and what's actually paid out per OT hour, the same
  for every worker type. Removed all three (model, validation, form,
  detail page, Excel export, Deployment's own monthly-profit computation)
  and replaced them with one new field, `otEmployeeRate`, in the CLIENT &
  BILLING section (not Subcontractor). New formula: `otProfitPerHour =
  otClientRate - otEmployeeRate`. The regular-hours rate split
  (`clientCommission` + `subcontractorRate`/`subcontractorCommission`) is
  untouched — scoped to OT only. See `docs/MOBILISATION-notes.md`'s
  2026-09-14 follow-up.
- **15 September 2026 QA/security retest: full remediation COMPLETE** — a
  follow-up independent audit (17 findings: 1 security, 3 auth/permission,
  9 functional, 4 dead-code/drift) was spot-checked against source before
  fixing (every finding confirmed real, two worse than described —
  `deploymentsRelease` write already defaults to Coordinator out of the
  box, and Exit Documents turned out to have NO Coordinator scoping
  anywhere, not just on the one route tested) then fixed in full.
  Headline fixes: a Mongo aggregation-expression injection in the invoice/
  advance payment ledgers (`$literal` + explicit ObjectId casting); the
  legacy (no-workflow) approval decide path finally got the same atomic-
  update race fix the workflow path already had, in the one shared engine
  six request types reuse; a notification failure could strand an Approved
  mobilisation with no Deployment — fixed by making every notification
  dispatch in that engine best-effort instead of building a full outbox;
  concurrent leave submissions could double-book a worker and exceed their
  entitlement — closed with a new per-employee advisory lock, the real
  serialization point a plain transaction alone can't provide for two
  inserts of different documents; Coordinator team-scoping extended to
  every list/mutation endpoint the 14 September pass only fixed for single-
  record reads; and a `tokenVersion` counter replacing a fundamentally
  unfixable clock-precision comparison for immediate-post-reset login. All
  of the above, plus the money-precision and date-bounding fixes, were
  verified with real script-based tests against the dev database — 47/47
  assertions passed. See `docs/QA-AUDIT-2026-09-15-notes.md` for the full
  finding-by-finding breakdown, what was disputed (nothing — see that
  file's Disputes section for two suggested fixes deliberately not built
  at this response's scale), and verification evidence.
- **15 September 2026 QA/security retest: 8 UI/UX suggestions, 8 of 8
  COMPLETE** — the same report's separate "product improvement" list,
  distinct from the 17 numbered findings above. Delivered: a new
  `dashboardProfit` Section Access key + a permanent `npm run
  grant:profit-visibility` script giving the real org-chart roles
  (Coordinator/HR/GM/COO/MM/FM/BDM) per-placement AND company-wide
  cost/profit visibility (also corrected an earlier wrong claim from a
  buggy diagnostic script — no real access was ever lost); `Section
  Access.getMySectionAccess` batched from ~45 queries/~140ms to exactly 2;
  a login-role-vs-Approval-Role consistency sweep across Leave/Timesheet/
  Certificate/ExitReentry (`canDecideCurrentStep` now correctly intersects
  Section Access, matching the sibling fix `advance.service.js` already
  had); a new admin-configurable Data Reconciliation module (5 real
  integrity detectors — orphaned Mobilisations, double-booked workers,
  Invoice/SalaryAdvance ledger drift, PayrollRun total drift); a shared
  `PickerLoadWarning` component rolled out to 18 real silent-failure
  pickers found by a dedicated research pass; and a real server test suite
  (vitest + mongodb-memory-server, 32 tests covering the two audits'
  highest-risk findings) plus ESLint for both apps (a real security fix —
  4 `target="_blank"` reverse-tabnabbing gaps — and real dead-code removal
  fell out of turning it on for the first time), both wired into
  `.github/workflows/ci.yml`. **Code splitting** (the client's single
  ~1.27MB bundle, the last of the 8) — planned properly first (route-level
  `React.lazy()`, not RRv7's native `lazy` route field, since it composes
  with the existing `guarded`/`guardedWrite` Section Access wrappers with
  zero changes to either), then implemented: all 66 routed pages in
  `router.jsx` are now lazy-loaded (one deliberate exception,
  `NoPortalAccessPage`, kept eager — it's rendered by a guard outside any
  layout's own `<Outlet>`/`<Suspense>`), each layout (`DashboardLayout`/
  `EssLayout`/`AuthLayout`) wraps its `<Outlet>` in a new
  `<ErrorBoundary><Suspense>` pair scoped to the content area only (sidebar/
  header stay mounted through both a loading state and a caught render
  error). Main entry chunk: 1,272,986 bytes → 670,680 bytes (117 total
  chunks, was 1). Verified via a full browser click-through (login,
  Dashboard, a Hub page, a list + a `:id` detail page, hard refresh on a
  deep URL, back/forward nav, a guarded 403 fallback, the ESS portal under
  its own separate layout, and — the one that actually matters for this
  change — a deliberately thrown render error confirming the new per-layout
  `ErrorBoundary` catches it without losing the sidebar). **User action
  still needed**: make the CI job a required GitHub branch-protection
  status check (Settings → Branches) — this repo has no admin API access
  to do it from here. See `docs/QA-AUDIT-2026-09-15-notes.md`'s "8 UI/UX
  suggestions" follow-up.
- **Mobilisation: FTA/Allowance structure + a real backlog-entry date-
  overlap fix, both COMPLETE** — from a screenshot of the form:
  `fta` now pairs with a required-if-used `ftaType` dropdown (Food Only/
  Travel Only/FTA); `allowance` gained a free-typed `allowanceRemark`.
  Separately, a real user-reported bug: `assertNoDateOverlap` always
  treated a new mobilisation as open-ended, which wrongly blocked
  backdated backlog entries against a LATER real placement even when the
  two periods didn't actually overlap. Now checkout-date-aware — a real
  end date narrows the check to a real closed interval — but stays
  optional (the user's own ask): omitted, behaves exactly as before.
  `MobilisationForm.jsx` gained a "Clear — still ongoing" link to
  deliberately revert a picked checkout date back to open-ended. Found and
  fixed a second, unrelated bug live in the browser: the new FTA-type
  client refine treated the string `"0"` as truthy, wrongly demanding a
  type on every existing zero-FTA Draft the moment it was edited. See
  `docs/MOBILISATION-notes.md`'s 2026-09-16 follow-ups.
- **Mobilisation: OT client rate autofill actually fixed + a no-documents
  submit warning, both COMPLETE** — the OT client rate autofill (shipped
  2026-09-13) turned out to only ever work for a value set in one shot;
  real character-by-character typing broke it after the first digit (the
  guard couldn't tell its own prior output apart from a real manual edit),
  which is exactly why the user reported it as "not autofilling" and typed
  a value in by hand. Fixed by tracking the exact value the hook itself
  last wrote. Also added the warning the user asked for directly: "Submit
  for review" now confirms before submitting a mobilisation with zero
  documents attached (a sibling of the existing unuploaded-files warning).
  See `docs/MOBILISATION-notes.md`'s second 2026-09-16 follow-up.
- **Deployment: an Ended deployment's own final month is reachable again,
  COMPLETE** — a real user-reported gap: the client UI hid the "add hours"
  form entirely once a deployment ended, even for its own real, never-
  entered final month — server-side, `addMonthlyHours` has allowed exactly
  this since the 14 September QA-audit fix (F5), the client just never
  gave a way to reach it. Fixed by mirroring the server's own eligibility
  rule client-side (a new shared `maxEligibleMonthFor`, reused for both the
  default month and the native month-input's min/max) and reordering the
  render gate so a real eligible month takes priority over the "ended"/
  "nothing eligible yet" fallback messages. Verified with a real fixture
  matching the report exactly (deployment ended mid-August, a fully-elapsed
  month, zero hours entered) — the form appeared, a real submission
  succeeded (201, correctly rejecting an out-of-placement day along the
  way), and the note correctly reverted once nothing was left. See
  `docs/DEPLOYMENT-notes.md`'s 2026-09-16 follow-up.
- **Deployment: Ended waits for nothing, and the daily grid is reverted to
  two typed totals, both COMPLETE** — the user's own correction, given a
  concrete example (mobilised 1 April, demobilised 16 April): "waiting for
  month completion is for people who are still mobilised... and not
  demobilised." The above fix only unblocked an Ended deployment's final
  month once IT had calendar-elapsed; this removes that wait entirely once
  Ended — every real placement month, including the current one, is
  immediately enterable. Separately (the user's own explicit choice, from
  3 clarifying questions asked first): the 2026-09-12 day-by-day grid is
  reverted, fully replacing it, back to "Client timesheet hours" + "Days
  worked" typed directly — the shape this app used even before the grid
  existed (docs/MOBILISATION-notes.md's 2026-09-12 follow-up), same
  `otHours = max(0, actualHours - contractHours)` formula, unchanged. A
  pre-existing entry's real daily breakdown stays visible (view-only,
  collapsed) until that specific entry is ever corrected; a lighter
  `daysWorked ≤ real placement days that month` check replaces the old
  per-day guard. Manager visibility (the user's third ask) needed no new
  code — already fully admin-configurable via the existing
  `deploymentsHoursDecide` Section Access key. Verified live: the add-hours
  form now appears immediately for a deployment demobilised mid-CURRENT-
  month (previously impossible), an out-of-range `daysWorked` is correctly
  rejected then a valid one accepted (real 201), and a seeded legacy
  entry's daily breakdown still expands correctly. See
  `docs/DEPLOYMENT-notes.md`'s second 2026-09-16 follow-up.
- **Mobilisation: 4th FTA type + a "pick a previous worker" fast path,
  both COMPLETE** — double-mobilisation was already correctly guarded
  (`assertNoActiveNonEmployeePlacement` + `assertNoDateOverlap`), confirmed
  and explained to the user, no code change needed. Added `AccommodationOnly`
  as a 4th `FTA_TYPES` value (same additive-enum shape as the original 3).
  Reordered `MobilisationForm`, the user's own ask: worker type first, then
  — for SupplierEmployee — the Subcontractor block moves ABOVE the identity
  fields (was below Client & Billing), immediately followed by a new
  `PreviousWorkerPicker` listing everyone that subcontractor has supplied
  before (click one, name/Iqama/nationality/phone auto-fill); Freelancer
  gets the same picker company-wide (no subcontractor to scope by). New
  `GET /mobilisations/previous-workers` — the list version of the existing
  `lookupWorkerByIqama` — one entry per distinct Iqama, most-recent-snapshot
  wins. The original Iqama-typed autofill stays untouched as the fallback
  for a worker not on the picker's list yet. Verified live against real
  fixtures (a subcontractor with 2 known workers, 1 known freelancer): new
  field order, picker hidden until a subcontractor is chosen then correctly
  scoped, click-to-autofill works with no duplicate toast, and the original
  manual Iqama path still works unchanged. See `docs/MOBILISATION-notes.md`'s
  second 2026-09-16 follow-up.
- **Standby List: a real "Mobilise" action, COMPLETE** — the Standby List
  (`docs/DEPLOYMENT-notes.md`'s 2026-09-14 follow-up) was deliberately
  read-only; each row now has a "Mobilise" button that deep-links to New
  Mobilisation with that worker already filled in, via URL query params
  read once into `defaultValues` (an Own Employee only needs `workerType`+
  `worker`; a SupplierEmployee/Freelancer needs its identity snapshotted
  into the URL the same way the picker above already fills those fields
  in). No new permission — same gate as creating any mobilisation, the
  double-placement/date-overlap guards on submit are the real enforcement
  regardless of entry point. Also fixed a real pre-existing rough edge
  found while building this: `useIqamaAutofill`'s "already applied" ref
  always started at `null`, so any form arriving with a full Iqama already
  filled in (this new deep-link, but also every ordinary Edit-page open on
  a SupplierEmployee/Freelancer record) re-showed the "Found X…" toast on
  every load — fixed by seeding that ref from the form's own starting
  value. Verified live against real fixtures: both row types navigate
  correctly with the right fields pre-filled/pre-selected, row-click-to-
  profile still works on the Own Employees table (unaffected by the new
  button), no redundant toast. See `docs/DEPLOYMENT-notes.md`'s third
  2026-09-16 follow-up.
- **Mobilisation: the Employees picker only loads when "Own Employee" is
  actually selected, COMPLETE** — a real user-reported gap, from a
  screenshot: New/Edit Mobilisation always fetched the full Employees list
  up front (`employeeCreate` Section Access, Admin-only by default) just to
  populate the "Own Employee" dropdown, breaking the whole form with a red
  banner for anyone who only ever mobilises SupplierEmployee/Freelancer
  workers and never touches that dropdown. Moved the fetch out of both
  pages and into `MobilisationForm` itself, gated on the form's own LIVE
  worker-type selection (not just its initial value) — switching away from
  "Own Employee" means the request is never made at all. Also fixed a real
  latent bug found while building this: the Iqama-autofill "already
  applied" tracker always started at `null`, so any Edit-page open on an
  existing SupplierEmployee/Freelancer record re-showed the "Found X…"
  toast on every load — fixed by seeding it from the form's own starting
  value. Verified server-side via repeated `curl` (5/5 consistent 403s)
  against a real Coordinator added to the company's actual "Coordinator"
  ApprovalRole (genuinely reproducing the gap, no invented grants), and
  client-side end-to-end: a full SupplierEmployee mobilisation created
  successfully as that restricted user with zero trace of the Employees
  warning. See `docs/MOBILISATION-notes.md`'s third 2026-09-16 follow-up.
- **Deployment: a real, narrow Edit action + new Section Access key,
  MM granted now, COMPLETE** — Deployments never had an edit route at all
  (auto-born from an Approved Mobilisation, "never created or edited by
  hand"). Added `PATCH /api/deployments/:id`, deliberately narrow: `site`,
  `workerName`, `requiredTimesheetHours`, and a `notes` field the model
  already had but nothing used — all free-typed snapshots with no
  cascading side effects. Deliberately excluded: `client`/`subcontractor`
  (re-pointing either would strand `Employee.currentClient`, the active-
  placement guard, and every already-entered month's OT-rate lookup) and
  every lifecycle field (`startDate`/`endDate`/`status`/`endReason`/etc. —
  Demobilise already owns those). New Section Access key,
  `deploymentsEdit`, Admin-only until granted; the company's real "MM"
  ApprovalRole was granted write immediately via a new permanent script,
  `npm run grant:deployments-edit`, mirroring `grant-profit-visibility.js`'s
  exact pattern. Client: a new "Edit" button on `DeploymentDetailPage`
  (same `user.sectionAccessWrite` pattern every other action button there
  already uses) opens a small in-page Modal — no new route, matching this
  module's own "one page manages everything" design. Verified against a
  real, existing production-data Deployment: a throwaway Coordinator with
  no grant got a clean `403`; a throwaway user added to the REAL "MM" role
  got a real `200`, editing succeeded on an Ended deployment, the change
  displayed correctly including the new Notes row, and the record was
  restored to its exact original values afterward. See
  `docs/DEPLOYMENT-notes.md`'s fourth 2026-09-16 follow-up.
- **Mobilisation: step-advance notification wired up, COMPLETE** — a real
  user-reported inconsistency (Office Secretary got notified, the next
  reviewer never did): `approveMobilisation` never passed the shared
  approval engine's optional `buildStepNotification` callback, unlike
  every sibling request type (Leave/Timesheet/SalaryAdvance/Reimbursement/
  ExitReentry/Certificate) — a missing wire-up, not a permissions gap.
  Fixed by extracting `buildMobilisationStepNotification` and reusing it in
  both `approveMobilisation` (now wired) and `submitMobilisation` (switched
  from a hand-rolled duplicate to the shared `notifySubmission` helper, the
  same "one builder, reused everywhere" convention every sibling module
  already follows) — also a genuine improvement for the no-workflow-
  configured case, which previously notified nobody at all. Confirmed a
  real 2-step "Mobilisation workflows" ApprovalWorkflow exists in this
  company's data, so the gap was live. See
  `docs/MOBILISATION-notes.md`'s fourth 2026-09-16 follow-up.
- **Deployment register: default filter, searchable client filter, Excel
  export, spreadsheet-style Overview, all COMPLETE** — the user's own
  four-part ask. Status filter now defaults to 'Active' ("Mobilised") on
  load; the client filter is a new reusable `SearchableSelect` combobox
  (type-to-filter, resolves to a real id — unlike the existing free-text
  `SuggestInput`); a real "Export to Excel" (`deployment.export.js` +
  `GET /api/deployments/export`, same filters/gate as the register, capped
  at 5000 rows); and a new "Overview" button opening a full-width modal
  showing EVERY deployment (deliberately unfiltered by the register's own
  pickers) as one spreadsheet-style table — every export column, each with
  its own Excel-style filter (free-text substring, or a picklist built from
  the values actually present for an enum column), all filtered client-side
  against one bulk fetch. `listDeployments`/`exportDeployments` share one
  `findDeployments` query builder so the two can never drift on what counts
  as a visible row. Verified live end-to-end: correct default/count,
  client search narrowing correctly, Overview showing all 7 regardless of
  the register's own filters, multi-column filtering narrowing to the
  exact right rows, row-click-to-detail, and a real downloaded `.xlsx`
  independently confirmed as a genuine Excel file. See
  `docs/DEPLOYMENT-notes.md`'s fifth 2026-09-16 follow-up. Same-day
  addendum: the user asked directly whether every entered value was
  actually there — it wasn't, `monthlyHours` (the real client-timesheet-
  hours/OT ledger) was missing entirely, a one-to-many field that can't be
  a flat column. Their own choice, from real options put to them: an
  expandable row toggle revealing that deployment's full month-by-month
  breakdown inline (Month/Contract/Actual/Days worked/OT hours/OT amount/
  Deduction/Status/Notes — reusing the detail page's own column set and
  i18n keys), OT amount rendered only when the loaded data actually has it
  (commercial, already server-stripped for non-deciders). Verified against
  real production data via direct DOM inspection, all 9 columns correct
  including a real server-computed OT hours value and stored OT amount.
  Second same-day addendum (2026-09-17) — "fill more screen" + "need every
  single data entered in mobilisation": a new `size="screen"` Modal variant
  (near-edge-to-edge, taller, own from `size="full"` so the unrelated
  document-preview modal is untouched) plus ~19 Mobilisation-sourced
  columns appended to both the Overview modal and the Excel export,
  mirroring mobilisation.export.js's own established export field list
  exactly. The 9 commercial ones (rates/commissions/profit) are gated
  exactly like otAmount — the user's own explicit choice from a direct
  question put to them first. Horizontal scroll was already native
  (`overflow-auto`); no custom wheel handling needed. Verified via a
  direct script-based check against real dev data (a non-decider actor's
  response genuinely lacks the commercial keys; an Admin actor's has all
  of them) plus a live browser click-through.
  Third same-day addendum (2026-09-17) — fills the full viewport height
  (fixed `h-[calc(100vh-1.5rem)]`, top-aligned, not shrink-to-fit), a new
  Month filter narrowing rows to deployments with a monthlyHours entry for
  that month, a sticky totals row summing every commercial column across
  visible rows, a real month-specific `Total profit per month` column
  (estimate + that month's actual OT profit, hidden until a month is
  picked), and green/red profit coloring reusing MobilisationDetailPage's
  own `profitClass` convention. All client-side, no server change.
  Verified live: filtering to a real month narrowed rows correctly, the
  totals row's sums matched by hand, and the new column appeared/
  disappeared exactly as designed.
  Fourth same-day addendum (2026-09-17) — the expand-row dropdown is
  removed entirely, replaced by three new month-specific flat columns
  (Hours worked/OT amount/Total amount this month, the last one "regular +
  OT combined" per the user's own choice between two formulas put to them
  directly); the sticky totals row now maps the full column list rather
  than assuming summable columns sit contiguously at the end, which is
  what actually fixes FTA/Allowance being left out of the total (the
  user's own catch). Verified live: dropdown gone, FTA/Allowance totals
  correct, all three new month columns matched the formula by hand.
  Fifth same-day addendum (2026-09-17) — the single Month dropdown (only
  ever showed months that already had data) is now two independent Year +
  Month selects, so a genuinely empty month can be picked on purpose and
  answered with "No deployments for {{month}}" (e.g. "No deployments for
  March 2026") instead of never being selectable at all; a real bug found
  live in this same pass — that empty-state message was center-aligned in
  a colSpan cell now ~30 columns wide, rendering it invisible off to the
  right — fixed by left-aligning it. Separately, added a new permanent
  `npm run grant:mobilisations-viewer` script (mirrors grant-deployments-
  edit.js, read tier only) for the "View mobilisation" 403 reported the
  same day, confirmed NOT a code bug — deploymentsRelease and
  mobilisationsViewer are independent Section Access keys with no shared
  default. Verified against local dev; still needs running against the
  user's actual staging/production database, which this session has no
  credentials for.
  Sixth same-day addendum (2026-09-17) — drag-and-drop column reordering
  on the Overview modal's headers (native HTML5 drag events, row 1 only),
  persisted to localStorage as a personal display preference (same
  convention DashboardPage.jsx's own expiry-threshold setting uses), with
  a "Reset columns" button. `orderedColumns` re-sorts the real column
  list against a stored key array every render, so a column that
  appears/disappears (commercial group, month-specific ones) never
  desyncs. Verified by dispatching real DragEvents with realistic delays
  between them (the in-app browser's simulated mouse drag doesn't trigger
  native HTML5 DnD — a same-tick synthetic dispatch with no delays also
  failed at first, a stale-closure artifact, not a bug, since React only
  re-renders between separate event dispatches); reorder, persistence
  across reopening, and Reset all confirmed working.
  Seventh same-day addendum (2026-09-17) — dragging no longer auto-saves
  to localStorage; it only updates the session order. A single "Columns"
  menu button now holds two explicit actions instead: "Set as default
  layout" (persists the current order) and "Reset columns" (clears
  session + saved order), both disabled until something's actually been
  dragged or previously saved. Verified live: pre-drag both grayed out,
  drag reorders without touching localStorage, post-drag both enabled,
  Set-as-default persists and survives reopening, Reset clears everything
  back to null.
- **Worker-data archive COMPLETE** — a real, permanent answer to "how do I
  delete a freelancer's/subcontractor employee's data" (a Freelancer/
  SupplierEmployee worker has no Employee record of their own to exit;
  their only footprint is every Mobilisation + resulting Deployment
  sharing their Iqama). Two design forks put to the user directly first:
  per-worker purge (not one record at a time) and archive, not permanent
  delete (reversible, keeps real financial history for audit). New
  `archived`/`archivedAt`/`archivedBy` on both Mobilisation and Deployment,
  excluded by default from every shared list/lookup/autofill query;
  `getWorkerHistory`/`archiveWorkerData`/`unarchiveWorkerData` (Admin-only,
  atomic transaction, blocked 409 while the worker has any active
  mobilisation/deployment); a new `/mobilisations/worker-history` page
  reached from the Standby List and Mobilisations list headers. Verified
  both via a script-based test against real dev data (active-worker
  archive correctly blocked; inactive-worker archive correctly hid it from
  every list simultaneously; unarchive correctly restored it) and a live
  browser click-through. See `docs/MOBILISATION-notes.md`'s 2026-09-17
  follow-up.
- **External handoff-readiness audit: 4 remaining Coordinator access-control
  gaps COMPLETE** — an independent external audit (git topology, duplicate
  code, secrets, docs, error tracking, access control) reproduced 4 real
  gaps of the exact same class the 13/15 September QA audits already fixed
  elsewhere, all in files those audits touched but didn't fully cover: the
  Deployments list/export (`findDeployments`) only checked team ownership
  when `?worker=` was explicitly passed, not on the normal unfiltered list;
  `decideMonthlyHours` was missing the same team check its two siblings
  already had; `updateAsset` had no ownership check at all, unlike `getAsset`
  right next to it; and `getAsset`'s assignment history stayed unfiltered
  once an asset was returned (ownership was only checked while currently
  assigned). All four only ever affect the Coordinator role and only when
  actually granted the relevant Section Access key. Verified with a real
  script-based test against the dev database, 15/15 assertions passed,
  including explicit no-regression checks that Admin still sees everything
  unrestricted. See `docs/QA-AUDIT-2026-09-15-notes.md`'s 2026-09-17
  follow-up.
- **Old root repo retired: `CLAUDE.md`/`docs/` relocated into both live repos
  COMPLETE** — the same external handoff audit above flagged that this file
  and `docs/` only ever existed in one place: an old, single `Tech-Jazeera`
  root repo, stale since 2026-09-08 (not connected to any deployment — the
  real backend/frontend split into `Tech-Jazeera-Backend`/
  `Tech-Jazeera-Frontend` happened after that repo was last touched, and it
  was never re-synced), meaning neither of the two actual live repos had
  this file, `docs/`, or a real README at all. Copied `CLAUDE.md` and
  `docs/` (52 of 53 files — `docs/CONTINUE-PROMPT.md` excluded, a personal
  session-continuation scratch note, never real project documentation)
  identically into both `server/` and `client/`; wrote a real, accurate
  `README.md` for each (the old one predated everything past Phase 1 — wrong
  role list, wrong document-storage description, a stale health-check
  example) rather than copying the stale one. Also deleted `.qa-audit/`
  (347MB of old QA-run artifacts — mongo dumps, upload fixtures — confirmed
  nothing else in the codebase referenced it; the findings themselves stay
  fully preserved in `docs/QA-AUDIT-2026-09-14-notes.md`/
  `-2026-09-15-notes.md`, which were copied). **User action still needed**:
  archive (not delete — keeps history, stops a stray bookmark 404ing) the
  old `Tech-Jazeera` GitHub repo, and decide on the two orphaned `claude/*`
  branches sitting in it (confirmed identical to each other and not unique
  unmerged work) — both are GitHub-visible/destructive-ish actions awaiting
  the user's explicit go-ahead, not done in this pass.
- **Duplicate-code cleanup, 12 of ~16 findings COMPLETE** — the same
  external audit's duplication table, worked through item by item (not one
  giant refactor), each extraction independently verified: `escapeRegex`
  (9 files), PDF money/date formatting, the `money2dp` Zod refinement,
  image-upload error/filter middleware, and — the financially significant
  one — `computeTotals`/`lineAmount` (Invoice/Quotation's authoritative
  money math), all consolidated into new `server/src/utils/` files. On the
  client: `fileSize`/`profitClass` formatters, a shared `ProfileField` UI
  component (3 profile pages), a shared `useEmployeePicker` query hook (4
  of 5 pickers — the 5th branches between two different entity types, not
  worth restructuring for one line of overlap), a shared list-sort-toggle
  helper, and a shared outside-click-detection hook (the avatar menu in
  both staff/ESS layouts). `computeTotals` had an explicit prior "kept
  local on purpose" comment reasoning that sharing it would create live
  coupling between an Invoice and its source Quotation — on inspection that
  doesn't actually hold (a shared pure function creates no such coupling;
  only the formula is shared, not any data), confirmed numerically before
  merging. 4 items deliberately left alone: `monthStrOf` (audited as
  "duplicated" but only appears once per side — nothing to actually
  de-duplicate), the PDF table-drawing closures (stateful, document-specific
  page-break logic — real complexity for little gain), and 2 cosmetic/
  audit-flagged-as-low-value items. Verified: server lint+tests (38/38)
  re-run after every group, a direct numeric check that summed per-line
  `lineAmount()` equals `computeTotals()`'s own grand total, client
  lint+build clean throughout, and a live browser click-through as a real
  Admin (outside-click-to-close, both list pages' sort toggle in both
  directions via network-request inspection, and a real Mobilisation's
  profit figures rendering in the correct color). See
  `docs/QA-AUDIT-2026-09-15-notes.md`'s second 2026-09-17 follow-up.
- **Daily Updates COMPLETE (Coordinator Workflow, milestone 1 of 4)** — a
  real home for a coordinator's day-to-day work, from a user ask that also
  wanted a Kanban-style pipeline for requirements that have arrived but
  aren't mobilised yet (worker sourced, documents being prepared) — that
  board is milestones 2-4, not started; locked decisions for it are in the
  notes file (one card per client requirement with candidate workers inside,
  admin-editable stages). This milestone: a to-do list AND a work log per
  coordinator — a coordinator writes their own to-dos and log entries, and MM
  (or anyone with write access) can assign a task to any coordinator, all of
  it readable by MM. One `DailyUpdate` collection (`kind: Log | Task`), two
  new Section Access keys because there are two real circles:
  `dailyUpdatesOwn` (a coordinator's own workspace) and `dailyUpdatesTeam`
  (oversight of everyone + assigning) — the same split-key precedent as
  Attendance's Sign In/Out. All authorization lives in the service, not a
  route gate (which key applies depends on the entry being touched), and every
  row carries a server-computed `permissions` object so the client never
  re-derives who may do what: a coordinator can tick off a task a manager
  assigned but not rewrite or delete it. Entries always belong to a real,
  active `Coordinator` login. Assignment/completion notifications (new
  notification type `Task`), a `backdated` flag so a manager can tell an
  after-the-fact log entry from a same-day one, Riyadh-day-aware overdue and
  no-future-dates rules, every mutation audited, English + Arabic. Real
  grants applied on dev via the new `npm run grant:daily-updates` ("Coordinator"
  role → own Write, "MM" role → team Write). **User action still needed**:
  run that script once against staging and production — the grants live in
  each database's own `SectionAccess` collection. Verified: 78 real-HTTP API
  assertions with disposable users (all cleaned up), a full browser
  click-through as Coordinator, MM and Admin (incl. 375px mobile and
  Arabic/RTL), server suite still 38/38. See `docs/DAILY-UPDATES-notes.md`.
- **Requirements board COMPLETE (Coordinator Workflow, milestone 2 of 4)** — the
  pre-mobilisation pipeline the user asked for: client requirements that have
  come in but aren't mobilised yet (worker sourced, documents being prepared),
  as a Kanban board that sits BEFORE Mobilisation (which can't represent a
  requirement with no worker yet). One card per client requirement, admin-
  editable stages (per-stage "stale after N days", "notify the team on
  arrival", "closed"), native drag-and-drop with an optimistic move that rolls
  back if the server refuses, plus a "Move to…" select for touch, a card
  timeline merging stage moves with the updates coordinators write, and stale/
  notification handling. Same own/team Section Access shape as Daily Updates —
  `requirementsOwn`, `requirementsTeam`, and a Write-only `requirementStages`
  (Admin until granted) — with all authorization in the service and per-card
  server-computed `permissions`; the shared `resolveOwnTeamAccess` helper was
  extracted and Daily Updates moved onto it. A Daily Updates log entry can now
  point at a card (`DailyUpdate.requirement`), so one update shows on the card
  AND in the coordinator's daily log with a link back. No commercial fields on
  a requirement by design. The typed client name links itself to a real Client
  when it matches, so a requirement can arrive from a company that isn't a
  client yet. Stages start empty and are created by an explicit "Use suggested
  stages" click (never seeded silently; the suggested day-counts are first
  guesses). **User action still needed**: tick the roles on the Section Access
  page (Sales & Clients → Requirements) in production/staging — already done on
  dev; the earlier `grant:daily-updates` script is only a convenience. Verified:
  128 real-HTTP API assertions (temporary roles, so no real person was
  notified, everything cleaned up), the Daily Updates suite re-run at 78/78, a
  full browser click-through as Admin/Coordinator/MM (real drag-and-drop,
  optimistic rollback, 375px mobile, Arabic/RTL, stale styling), server suite
  38/38. Milestones 3 (candidates + "Start mobilisation" handoff) and 4
  (manager extras) not started. See `docs/REQUIREMENTS-BOARD-notes.md`.
- **Requirements: candidates + the mobilisation handoff COMPLETE (Coordinator
  Workflow, milestone 3 of 4)** — the last piece of the pre-mobilisation pipeline: WHO
  is being lined up for each requirement, how far their paperwork is, and a clean path
  from "documents ready" to a real Mobilisation, with the card following the
  mobilisation's approval on its own. Candidates are embedded on the card (a
  subcontractor's worker or a freelancer; name, optional Iqama/nationality/phone, a
  documents note, a small fixed status — "Mobilised" set only by the system — and the
  mobilisation made for them), maintained under the card's existing edit right.
  "Start mobilisation" opens the normal New Mobilisation form pre-filled from the card
  and candidate — only two ids in the URL, values used only when they match a real
  picker option — and the mobilisation stores the link (`requirement` +
  `requirementCandidate`, create-only). The server verifies BEFORE creating anything (so
  a refused start leaves no orphan Draft) and links back after. On final approval — after
  the Deployment exists, best-effort so it can never fail or undo an approval — the
  candidate becomes Mobilised and, once as many are mobilised as the card's headcount,
  the card moves itself to the stage an admin flagged `isMobilisedStage` (exclusive,
  separate from `isTerminal`; the suggested set flags "Mobilised"). The mobilisation
  detail shows "From requirement" with a link back. Own employees aren't candidates (the
  Standby list already has a Mobilise button and their picker needs Employees access a
  coordinator lacks). **User action**: on a board built before this milestone, edit the
  destination stage and tick "Where a fully-mobilised requirement goes" once. Verified:
  76 real-HTTP assertions including the full approval flow through a disposable workflow
  (candidate Mobilised at 1 of 2 without advancing; card moves itself at 2 of 2;
  approving with the card deleted still succeeds; a normal unlinked mobilisation
  unchanged), the Daily Updates (78) and Requirements (128) suites re-run green, and a full
  browser click-through as Admin/Coordinator/MM incl. 375px and Arabic/RTL. **A real
  incident**: my first test run's cleanup crashed on a unique index and left the real
  "Mobilisation workflows" approval workflow INACTIVE in the dev DB — caught by inspecting
  the DB, restored, every grant and serial counter verified back, and the script rewritten
  (state saved first, delete-then-restore, independent steps). Milestone 4 (manager
  extras) not started. See `docs/REQUIREMENTS-BOARD-notes.md` ("Milestone 3") and
  `docs/MOBILISATION-notes.md`'s 2026-09-20 follow-up.
- **Requirements: manager extras — filters, export, dashboard widget COMPLETE
  (Coordinator Workflow, milestone 4 of 4 — the whole workflow is now built)** — client
  and subcontractor filters on the board (joining the existing coordinator/closed
  filters), a real `GET /api/requirements/export` (`.xlsx`, a Requirements sheet and a
  Candidates sheet) sharing the board's own query-building function so the two can never
  disagree on what a viewer sees, and two new "Waiting on you" dashboard rows (stale
  requirements, open tasks), each counted by its own module scoped exactly like the page
  it links to. No new permission — everything rides the existing `requirementsOwn`/
  `requirementsTeam` read. Fixed a real pre-existing crash found while building this: a
  job-title quick-create `useEffect` added after milestone 3 referenced `setValue` before
  `useForm` declared it, crashing the whole board the instant the Add/Edit requirement
  modal mounted. Verified: 95 real-HTTP assertions plus a full browser click-through. See
  `docs/REQUIREMENTS-BOARD-notes.md`'s "Milestone 4" section.
- **22 September 2026: audit of work built outside this session, one real crash fixed,
  several real gaps flagged for a decision** — between sessions the user built a good
  deal more directly (a new `mobilisationTargets` module — per-coordinator monthly
  mobilisation targets with live progress and an incentive percent; several new dashboard
  widgets — active revenue, a standby-workforce analysis, HR compliance, daily attendance,
  a coordinator drill-down, directory stats, a system-logs widget; and a scoping change to
  `Deployment`'s Coordinator team-check). Asked to check it all and bring the docs/memory
  up to date. Found and fixed one real, reproducible crash:
  `GET /dashboard/coordinator-drill-down/:id` 500'd on every call — it destructured
  `{ DailyUpdate }` and `{ Task }` off `dailyUpdate.model.js`, which has neither (one
  collection, a single default export, `kind: 'Log' | 'Task'` tells them apart) — fixed
  to the model's real shape, plus a stray unused import that was failing the CI lint job
  outright. Found and **flagged for the user's own decision, not changed**: 7 of the 9
  new dashboard widgets have no `t()` calls at all — hardcoded English, a real regression
  against the "Staff panel Arabic" milestone's explicit "the entire Dashboard page + its
  sub-components — every visible string, not a partial pass"; four of the new dashboard
  fields (`activeSubcontractors`, `attendanceSummary`, `pendingLeave`, `pendingExit`) gate
  on a hardcoded `actor.role === 'Manager' | 'Admin' | 'HR'` check, reintroducing the
  exact anti-pattern the "Dashboard driven by real Section Access reads" milestone was
  built specifically to remove; the new `finance.activeMobilisationRevenue` figure has NO
  Section Access gate at all, unlike every other financial figure this dashboard shows
  (`profit` needs `dashboardProfit`) — any staff login with dashboard access sees it
  unconditionally; `deployment.service.js`'s Coordinator team-scoping changed from
  `Employee.coordinator` to `Mobilisation.coordinators.user` and dropped the always-
  visible `worker: null` branch for SupplierEmployee/Freelancer deployments (a real,
  undocumented change to scoping logic the 15 September QA audit had specifically
  hardened) — its own code comment still describes the old, no-longer-true behavior. Also
  noted: a `test.js` ad hoc debug script sitting at the server root, checked into git
  (dead code by this file's own hard rule — left alone pending the user's own go-ahead to
  remove it, since it's their file). **Separately confirmed**: OpenAI's Codex CLI was
  running against this same working directory alongside this session — the user runs more
  than one AI coding tool on this repo concurrently, which is the honest explanation for
  the code-quality/convention gaps above and for commits landing that this session never
  made. Worth knowing going in, not a sign of drift or corruption. See
  `docs/DASHBOARD-EXTRAS-notes.md` for the full finding-by-finding list and what "fix" vs.
  "flagged" means for each.
- **21 September 2026 performance/cleanup audit: P1–P7, P9, P10, F1 all
  COMPLETE** — an independent audit (10 prioritized performance findings,
  a dead-code/duplication/dependency/docs section, one flaky-test finding)
  was spot-checked against source (nothing refuted) then fixed in full for
  every finding it itself framed as High/Medium priority with a clear fix.
  Headline fixes: a real per-user rate limiter alongside the existing
  per-IP one; a route-mounting landmine (`leaveRoutes` at the bare `/api`
  prefix) split into two properly-prefixed routers; the dashboard's ~30+
  unbatched queries collapsed to a handful of real batched aggregates/
  `Map` lookups; Payroll's per-employee query loop batched the same way;
  push notification delivery moved off the save-response critical path
  into a small bounded-concurrency queue (not a bare fire-and-forget
  promise); the Timesheet Processor's spreadsheet parser gained real
  row/column caps checked BEFORE the expensive parse, since the byte-size
  limit alone doesn't bound row count; the flaky "concurrent decisions"
  test was root-caused to a genuine code non-determinism (a redundant
  early status check racing the atomic update that was already the real
  guard) and fixed to a single deterministic 409 contract, not dismissed;
  two duplicate picker cache keys were consolidated into shared hooks; two
  real missing indexes (`Invoice.date`, `Requirement`'s whole-board sort)
  were added and confirmed via `explain()` to flip COLLSCAN/SORT into
  IXSCAN. **P6 (bundle size) also COMPLETE**, beyond the audit's own
  suggested minimum: i18n now loads only the current language via a real
  dynamic import (not both eagerly), `DashboardLayout`/`EssLayout` are now
  lazy like every routed page already was, and the Sentry SDK loads only
  when an error is actually caught — entry chunk 852KB → 35KB (gzip 260KB
  → 9.6KB), verified via a full production-build browser click-through
  (login, live language switch confirming on-demand `ar.json` loading,
  confirmed absence of the Sentry/Arabic chunks on a normal load). Left
  deliberately unbuilt, all explicitly lower-priority by the audit's OWN
  framing: P8 ("growth risk, not a demonstrated current cause"), dead-code/
  duplication cleanup ("unlikely to matter for runtime speed"), docs
  reorganization (a readability improvement, not a speed fix), and the
  monitoring/baseline recommendation (an ongoing practice, not a concrete
  change). See `docs/PERF-AUDIT-2026-09-21-notes.md` for the full
  finding-by-finding breakdown and verification evidence.
- **Same-day follow-up: P8, duplicate-code cleanup (6 of 8 findings, plus
  all 4 icon renderers beyond the audit's own two "low-priority" ones), and
  a real docs reorganization, COMPLETE** — the requirement board's own
  query was over-fetching full candidate PII (name/Iqama/nationality/
  phone/notes) and all of `stageHistory` for up to 1000 cards just to
  discard almost all of it in JS; narrowed with a `.select()` excluding
  everything the board doesn't use — verified with a disposable fixture
  (12/12 assertions: correct counts, zero PII in the response, the detail/
  export paths untouched). The Deployment Overview's own much larger fetch
  was investigated and left alone — confirmed deliberate, recent, iterative
  design ("need every single data entered"), not an oversight, matching
  the audit's own "growth risk, not demonstrated" framing. Shared code
  extracted for the copy-password handler, the job-title quick-create, the
  coordinator-list picker, the PDF line-item/totals table, and all four
  icon renderers — each verified independently (a real dev-data script, a
  generated multi-page PDF read back with `pdftotext`, or a live browser
  click-through). `sectionAccess.controller.js`'s comment drift fixed. This
  very file exists because of the last, biggest piece: `CLAUDE.md`'s
  1,528-line Status section (verified byte-identical via `diff` before the
  move) is now here, leaving `CLAUDE.md` at 143 lines — the actual
  current-state guide, not a running history. The retired root repo's
  `CLAUDE.md` also gained a clear "archived, not canonical" banner. The
  33-export "could become private" list was deliberately left alone — the
  audit's own words say it has zero measured runtime benefit, and 33
  single-file edits each needing a whole-codebase reference check is real
  risk for a change that doesn't matter for speed. See
  `docs/PERF-AUDIT-2026-09-21-notes.md`'s own "Follow-up" section for the
  full breakdown.
- **Second same-day follow-up: P8's remaining item + a real monitoring
  baseline, COMPLETE** — before touching anything, checked real dev data:
  9 Deployments, 0 Requirements, nowhere near either cap, no
  virtualization library installed. Put three real options to the user
  directly rather than guessing; they chose the lighter, no-new-dependency
  safeguard. Found and fixed a real gap while investigating:
  `listDeployments` already computed the true unclipped `total`, but
  `DeploymentOverviewModal.jsx` never read it — a real result set
  exceeding the 5,000-row cap would have silently shown a partial register
  with zero indication. Added a `truncated` warning banner matching the
  Requirements board's own existing one, English + Arabic, verified live
  with real data (correctly absent — no false positive) and via a
  substitution check on the interpolated text. Monitoring: client-side
  Sentry tracing turned on (`tracesSampleRate: 0.2`, deliberately partial)
  — which meant reconciling a real tension with this same day's earlier P6
  fix (Sentry had been made reactive-only, loading solely on a caught
  error, to keep it out of the entry bundle — but tracing needs the SDK
  running near app start to capture anything). Resolved by keeping it a
  separate chunk but firing the import eagerly, fire-and-forget, at
  startup instead of reactively. Server-side: a new `requestMetrics`
  middleware logging method/route/status/duration/payload-size per
  response (mounted first, so it also captures every 429 for free) plus a
  once-a-minute event-loop-delay and aggregate Mongo-op-count sampler —
  both reuse the existing Winston/JSON logging pipeline, zero new
  dependencies. Verified live against the real dev server (curled
  endpoints, confirmed log lines; waited a real 60s interval, confirmed
  the periodic samples fired) plus a disposable-fixture script proving the
  counters record real activity. Full server suite 38/38, client lint/
  build clean throughout. See `docs/PERF-AUDIT-2026-09-21-notes.md`'s own
  "Second follow-up" section for the full breakdown.
- **Follow-up (24 September 2026): re-verified the 22-September audit's
  remaining findings — 3 of 4 already fixed, one real i18n gap found and
  closed** — asked to pick up that audit's "7 of 9 dashboard widgets have
  no `t()` calls" item. Checked the actual current code first rather than
  assuming the finding still held: the unguarded `finance.
  activeMobilisationRevenue`, the 4 hardcoded-role dashboard fields
  (`activeSubcontractors`/`attendanceSummary`/`pendingLeave`/
  `pendingExit`), and the Coordinator scoping "regression" had all already
  been fixed or reviewed-and-confirmed-correct (dated 2026-09-22 in-code
  comments) by work that landed after that audit entry was written but
  before this session started — see `dashboard.service.js` lines 437-444/
  699-701 and `deployment.service.js` lines 783-797. All 7 flagged widgets
  turned out to already be fully wired to `useTranslation`/`t()` with real
  English+Arabic strings in both locale files, except one real leftover:
  the client's `StandbyAnalysisWidget` concatenated a raw `{count}d` with a
  hardcoded Latin "d" suffix for its "days on standby" badge, which would
  render untranslated even in Arabic. Added a proper
  `staffDashboard.widgets.standby.daysCount` key (en: `{{count}}d`, ar:
  `{{count}} يوم`, matching the existing `common.expiry.daysLeft`-style
  convention) and switched the widget to use it — client-only change, no
  server code touched. Verified: client lint clean (0 errors), production
  build clean, new key confirmed present and correct in both compiled
  locale bundles.
