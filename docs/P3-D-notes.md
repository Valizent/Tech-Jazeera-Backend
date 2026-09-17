# P3-D — Exit re-entry visas, certificate requests & asset tracking

Fourth milestone of the HR PRD build-out (see `docs/PHASE3-PLAN.md`). PRD
Module 6's three sub-features, landing as two new server modules: exit
re-entry visa requests and certificate requests (`exitDocuments/`, since
both are worker-submitted HR-approval workflows), and company asset
tracking (`assets/`, a staff-managed registry, not a request/approval flow
at all).

## What was built

**New module — `server/src/modules/exitDocuments/`**
```
exitReentry.model.js       # ExitReentryRequest — visaType, dates, optional
                            #   link to the employee's own LeaveRequest
exitReentry.validation.js, .service.js, .controller.js
certificate.model.js       # CertificateRequest — Salary/Service/Chamber-
                            #   of-Commerce types; only the first two
                            #   generate a PDF (see decisions below)
certificate.validation.js, .service.js, .controller.js
certificate.pdf.js         # pdfkit — deliberately minimal letterhead
exitDocuments.routes.js    # staff-facing half, mounted at /api/exit-documents

server/src/modules/me/     # extended — worker submit/list/cancel for both,
                            #   + certificate PDF download (own, approved only)

client/src/features/exitDocuments/
  exitReentry.api.js, certificates.api.js, exitDocuments.schema.js
  pages/ExitDocumentsPage.jsx           # staff: both review queues, one page
  components/ExitReentryReviewPanel.jsx
  components/CertificateReviewPanel.jsx
client/src/features/ess/pages/MyExitDocumentsPage.jsx
  # worker: both request forms + history, plus a read-only "My Assets" section
```

**New module — `server/src/modules/assets/`**
```
asset.model.js              # Asset — tag, category, status, denormalized
                             #   currentEmployee (fast read)
assetAssignment.model.js    # AssetAssignment — a SEPARATE collection, not
                             #   an embedded array; same relationship
                             #   Deployment has to Employee.currentClient,
                             #   including the partial-unique "at most one
                             #   Active assignment per asset" index
asset.validation.js, .service.js, .controller.js, .routes.js
  # mounted at /api/assets; assign/return run inside a transaction so
  # Asset.status/currentEmployee can never drift from the assignment record

client/src/features/assets/
  assets.api.js, assets.schema.js
  pages/AssetListPage.jsx     # staff: full register, assign/return/retire/
                                #   delete, a history modal per asset
client/.../employees/pages/EmployeeProfilePage.jsx
  # + a compact "Assigned assets" read-only panel
```

**Routing/nav**: `/exit-documents`, `/assets` (staff, Admin/Manager/HR —
Assets is read-open to all staff, Exit & Documents is not, since it's an
HR/compliance-only concern); `/me/exit-documents` (worker, includes the
read-only asset view). `server/src/app.js` mounts both new routers.

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST/GET | `/api/me/exit-reentry` | Worker | submit / list own visa requests |
| PATCH | `/api/me/exit-reentry/:id/cancel` | Worker (own) | cancel own Pending |
| POST/GET | `/api/me/certificates` | Worker | submit / list own certificate requests |
| GET | `/api/me/certificates/:id/pdf` | Worker (own) | download own approved/issued certificate |
| PATCH | `/api/me/certificates/:id/cancel` | Worker (own) | cancel own Pending |
| GET | `/api/me/assets` | Worker | read-only: own current + past assignments |
| GET | `/api/exit-documents/exit-reentry` \| `/certificates` | Admin, Manager, HR | review queues |
| PATCH | `.../exit-reentry/:id/decide` \| `/issue` | Admin, Manager, HR | approve/reject, mark issued (visa reference) |
| PATCH | `.../certificates/:id/decide` \| `/issue` | Admin, Manager, HR | approve/reject, mark issued |
| GET | `.../certificates/:id/pdf` | Admin, Manager, HR | download any employee's certificate |
| GET/POST | `/api/assets` | staff view / Admin,Manager,HR write | register CRUD |
| POST | `/api/assets/:id/assign` \| `/return` | Admin, Manager, HR | the assignment workflow |
| PATCH | `/api/assets/:id/status` | Admin, Manager, HR | Available ↔ Maintenance/Retired |
| GET | `/api/assets/by-employee/:employeeId` | staff | one employee's assignment history |

## Key decisions & why

- **This app tracks the REQUEST, not the government process.** Exit
  re-entry visas go through Jawazat/Muqeem; there is no public API to
  actually issue one. `markExitReentryIssued` records that HR did it
  externally (with an optional reference number for their own tracking) —
  the same "we track the request, a human does the paperwork" shape as the
  Chamber of Commerce Attestation certificate type.
- **Only Salary and Service certificates generate a PDF.** A Chamber of
  Commerce Attestation is a physical stamping process performed by an
  actual government-adjacent body on a document the company already has —
  not something this app authors. Asking for its PDF returns a clear 400
  rather than a fabricated document; its lifecycle is Pending → Approved →
  Issued exactly like the others, just without a document at the end.
- **The certificate letterhead is deliberately minimal**: just "Al Jazeera"
  (the app's own known trade name), no CR number, no named signatory, and a
  blank signature line (normal for this kind of letter — a human signs it,
  that's not a placeholder). This app has no verified source for a full
  legal letterhead — no Settings/company-profile record exists yet, and
  `docs/PHASE2-PLAN.md` already carries the standing rule against inventing
  CR/VAT/IBAN-type company details. Verified by actually reading the
  rendered PDF (see below) rather than assuming pdfkit did the right thing.
- **The Service Certificate pulls a real exit date from the EOSB module**
  when the employee has exited — it looks up their most recent `Settlement`
  (P3-A) rather than inventing or omitting one. Verified end-to-end: computed
  a real settlement, marked the employee Exited, and confirmed the
  certificate switched to past tense with the correct date range.
- **Assets use a separate assignment-history collection, not an embedded
  array** — deliberately copying Deployment's exact shape (a
  `currentEmployee` denormalized field on Asset for fast reads, a
  partial-unique index on the history collection as the real "no double
  assignment" guarantee, both writes inside one transaction). One proven
  pattern reused, not a second one invented for a structurally identical
  problem.
- **Deleting an asset is blocked once it has any assignment history** —
  `Retired` is the correct end state for a real, used asset; hard delete
  stays available only for a record created by mistake (same precedent as
  Employee).

## Verified (2026-08-29)

**curl** (throwaway admin + Worker, deleted after):

*Assets* — create → 201; duplicate tag, case-insensitive → 409; Worker
blocked → 403; assign → 201; assigning an already-assigned asset → 400;
deleting an asset with history → 400; return → 200; returning again → 400;
re-assigning after return → 201 (confirms the partial-unique index permits
a fresh Active row once the old one is Ended); full history via
`GET /:id` → 2 entries; status change while Assigned → 400 (must return
first); `/api/me/assets` and `/api/assets/by-employee/:id` both return the
same current+history shape.

*Exit re-entry* — submit → 201; return-before-departure → 400; a
non-owned/nonexistent linked leave request → 400; Worker blocked from the
staff router → 403; approve → 200; deciding twice → 400 on the second;
mark issued with a reference number → 200.

*Certificates* — submit → 201; downloading the PDF before approval → 400;
approve → 200; **the actual rendered PDF was read and visually confirmed**
for both Salary and Service Certificate types — correct name, designation,
joining date, salary, and purpose text; own and staff downloads both 200;
Chamber of Commerce Attestation approved then PDF-requested → 400 with the
right message; cancelling a Pending request → 200 (deleted); the
exited-employee/Settlement cross-check above confirmed the date-range and
tense switch render correctly.

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint as the
rest of Phase 3 — see `docs/P3-B-notes.md`). Every server code path was
exercised via curl, including reading the actual generated PDF bytes back
to confirm the letterhead and body text are correct — not just that a
200 came back.

**Cleanup**: throwaway admin/Worker logins, the test employee, the test
asset and its two assignment records, the exit re-entry request, all four
certificate requests, the EOSB settlement created for the cross-check, their
refresh tokens, and the audit-log rows were all deleted.
