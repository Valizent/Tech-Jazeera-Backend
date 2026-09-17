# Phase 3 — Plan

Source: an HR & Employee Self-Service PRD (`HR App.docx`, provided 2026-08-29)
describing a Saudi Labor Law-compliant mobile HR app. Read against the actual
codebase, roughly a third of it already existed (worker logins, geofenced
attendance, the configurable Leave engine, document/expiry tracking). Phase 3
is the rest: statutory leave/holidays, payroll's WPS breakdown, EOSB, exit &
document requests, and asset tracking — folded in as a continuation of
`docs/PHASE2-PLAN.md`, not a restart.

Full module-by-module gap analysis was shared as a build-plan artifact in
chat; this file is the durable record of the two decisions made from it and
the resulting build order, so a future session doesn't have to re-derive them.

## Decisions made (2026-08-29)

1. **Mobile delivery: stay on the installable PWA**, not native Flutter/React
   Native apps. One codebase, ships immediately, reuses everything Phase 1/2
   built. Consequence: biometric login is WebAuthn (close to, not identical
   to, native Face ID/Fingerprint) and mock-location detection stays
   best-effort — both flagged as real, accepted limitations, not gaps to
   silently work around later.
2. **Timesheet approval uses a sensible default**, not the multi-level signed
   flow (Employee → BDM/Manager → next-level Manager, each with a stored
   signature) originally deferred in `docs/P2-M3-notes.md` pending a template
   from the user. Ship single-level Submit → Approve/Reject (the pattern
   already used for Leave) now; upgrade to multi-level signing later without
   breaking anything downstream, if/when the real template arrives.
3. **Start with P3-B** (statutory leave & holidays) rather than resuming
   Timesheets first — it's mostly extending the existing Leave module and
   unblocks nothing else, but was the fastest way to start shipping real PRD
   coverage. `P3-A` (EOSB) is the next fast standalone win — it only needs
   `joiningDate` + `salary`, both already on Employee.

## Build order

| Code | Milestone | Delivers | Depends on |
|---|---|---|---|
| **Phase 2 — resume as-is** |||
| **P2-M3b** ✅ | Timesheet approval | Weekly Attendance summary + single-level supervisor sign-off, bulk-approve | — (done, see `docs/P2-M3b-notes.md`; the approved-timesheet lock on Attendance edits is deferred until Payroll needs it) |
| **P2-M5** ✅ | Payroll & payslips | Monthly `PayrollRun` (optional Basic/Housing/Transport breakdown, informational approved hours) + payslip PDF | P2-M3b (done, see `docs/P2-M5-notes.md`; GOSI is entered not calculated, overtime pay is P3-E's connection point) |
| **P2-M6** ✅ | Invoices & payments | Quotation → invoice (frozen totals) → payment ledger → invoice PDF, client-profile Invoices tab | — (done, see `docs/P2-M6-notes.md`) |
| **P2-M7** ✅ | Expenses | Company-level expense ledger | — (done, see `docs/P2-M7-notes.md`) |
| **P2-M8** ✅ | Dashboard v2 | Real profit = revenue − payroll − expenses | P2-M5–M7 (done, see `docs/P2-M8-notes.md` — **Phase 2 backbone now fully complete**) |
| **Phase 3 — new, PRD-driven** |||
| **P3-B** ✅ | Statutory leave & holidays | `LeaveType.maxDaysPerRequest`/`isPaid`, `Holiday` calendar module, attendance-grid + Leave-page integration | — (done, see `docs/P3-B-notes.md`) |
| **P3-A** ✅ | EOSB & settlement | Labor Law Art. 84–85 calculator + vacation-pay encashment + settlement PDF | — (done, see `docs/P3-A-notes.md`) |
| **P3-C** ✅ | Financial requests | Salary advance/loan workflow (manual repayment ledger), reimbursement claims with receipt upload | — (done, see `docs/P3-C-notes.md`; repayment/expense-ledger auto-posting is the future connection point once P2-M5/P2-M7 exist) |
| **P3-D** ✅ | Exit & documents | Exit re-entry visa requests, Salary/Service certificate PDFs + Chamber of Commerce attestation tracking, company asset register | — (done, see `docs/P3-D-notes.md`; a full company letterhead — CR number, address, signatory — is the one open item once provided) |
| **P3-E** ✅ | Overtime & Ramadan shifts | Overtime auto-calc, configurable Ramadan hour caps | P2-M3b (done, see `docs/P3-E-notes.md`) |
| **P3-F** ✅ | Notifications | Push channel for expiry alerts + request status changes | — (done, see `docs/P3-F-notes.md`) |
| **P3-G** ✅ | Multi-language (Ar/En — superseded 2026-09-06, was Ar/En/Hi/Ne/Bn) | i18n framework, RTL for Arabic | P3-A–E screens built (done, see `docs/P3-G-notes.md` — scoped to the ESS portal, not the staff panel, per user decision; **Phase 3 now fully complete**) |

## Open items carried forward

- **Sick / Bereavement / Hajj leave** aren't seeded with a day cap yet — see
  `docs/P3-B-notes.md`'s "Key decisions" for why each needs a real number
  confirmed (sick leave's tiered pay % especially) rather than an invented
  one.
- **Certificate letterhead is minimal** (just "Al Jazeera", no CR number/
  address/named signatory) — see `docs/P3-D-notes.md`. Provide the real
  registered company name, CR number, address, and an authorized
  signatory's name/title to finish it properly.
- The Timesheet template blocker from P2-M3 is superseded by decision #2
  above, but if the user later provides the real signed-timesheet example,
  upgrading P2-M3b to the full multi-level flow is still the plan.
