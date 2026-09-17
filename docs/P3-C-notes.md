# P3-C — Financial requests: salary advances & expense reimbursements

Third milestone of the HR PRD build-out (see `docs/PHASE3-PLAN.md`). PRD
Module 4's two worker-initiated request types: a salary advance/loan with
manual repayment tracking, and an expense reimbursement claim with a
receipt upload. Both are single-level Submit → Approve/Reject, the same
judgment call `docs/PHASE3-PLAN.md` already made for P2-M3b's (not yet
built) timesheet signing flow.

## What was built

**New module — `server/src/modules/financialRequests/`**
```
advance.model.js         # SalaryAdvance — amount, repaymentMonths, an
                          #   append-only repayments ledger (embedded,
                          #   value objects, never edited individually)
advance.validation.js
advance.service.js       # submit (blocks a 2nd request while one is
                          #   Pending/Approved), decide, addRepayment
                          #   (rejects over-balance, auto-closes at 0)
advance.controller.js
reimbursement.model.js   # ReimbursementClaim — category, amount, a single
                          #   embedded receipt file record (its own minimal
                          #   shape, NOT the Documents module — see below)
reimbursement.validation.js
reimbursement.service.js # submit (requires a file), decide, markPaid
                          #   (separate from decide — Accounts pays days
                          #   later), receipt resolution for download
reimbursement.controller.js
financialRequests.routes.js   # the staff-facing half, mounted at
                                #   /api/financial-requests

server/src/modules/me/    # worker-facing half — extended, not new:
  me.routes.js             # + /advances, /reimbursements (incl. multipart
                            #   upload + its own orphaned-file cleanup
                            #   handler, mirroring document.routes.js)
  me.controller.js, me.service.js   # thin delegation, same shape as
                                      #   submitMyLeave/listMyLeave

server/src/app.js         # + financialRequestsRoutes

client/src/features/financialRequests/
  advances.api.js, reimbursements.api.js
  financialRequests.schema.js
  pages/FinancialRequestsPage.jsx        # staff: both review queues, one page
  components/AdvanceReviewPanel.jsx      # approve/reject + record repayment
  components/ReimbursementReviewPanel.jsx  # approve/reject + receipt + mark paid
client/src/features/ess/
  ess.api.js               # + advance/reimbursement calls
  pages/MyRequestsPage.jsx  # worker: both request forms + own history, one page
client/src/app/router.jsx, DashboardLayout.jsx, EssLayout.jsx
  # + /financial-requests, /me/requests, and their nav items
client/src/lib/constants.js
  # + ADVANCE_STATUSES, REIMBURSEMENT_CATEGORIES/STATUSES, role lists
```

## API

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST/GET | `/api/me/advances` | Worker | submit / list own advance requests |
| PATCH | `/api/me/advances/:id/cancel` | Worker (own) | cancel own Pending request |
| POST/GET | `/api/me/reimbursements` | Worker | submit (multipart, incl. receipt) / list own claims |
| GET | `/api/me/reimbursements/:id/receipt` | Worker (own) | download own receipt |
| PATCH | `/api/me/reimbursements/:id/cancel` | Worker (own) | cancel own Pending claim |
| GET | `/api/financial-requests/advances` | Admin, Manager, HR, Accounts | review queue |
| PATCH | `/api/financial-requests/advances/:id/decide` | Admin, Manager, HR | approve/reject |
| POST | `/api/financial-requests/advances/:id/repayments` | Admin, Manager, HR, Accounts | record a repayment |
| GET | `/api/financial-requests/reimbursements` | Admin, Manager, HR, Accounts | review queue |
| GET | `/api/financial-requests/reimbursements/:id/receipt` | Admin, Manager, HR, Accounts | download a receipt |
| PATCH | `/api/financial-requests/reimbursements/:id/decide` | Admin, Manager, HR | approve/reject |
| PATCH | `/api/financial-requests/reimbursements/:id/pay` | Admin, Manager, HR, Accounts | mark paid |

## Key decisions & why

- **No multi-level approval matrix.** The PRD asks for one on salary
  advances specifically. Same reasoning as the deferred timesheet signing
  flow (P2-M3) and the choice made for P2-M3b: a real multi-level hierarchy
  needs a concrete spec (who approves at what threshold, how many levels) —
  inventing one would be guessing at an org chart. Single-level
  Submit → Approve/Reject ships today; upgrading later doesn't require
  reshaping this data.
- **Repayment is a manual ledger, not a Payroll deduction**, because there
  is no Payroll module yet (`docs/PHASE2-PLAN.md` P2-M5). A staff member
  (HR/Manager/Accounts) records repayments as they happen; the outstanding
  balance is always derived fresh from that ledger, never stored, so it
  can't drift. When Payroll exists, it becomes the natural caller of
  `addRepayment()` instead of a person — the shape doesn't need to change.
- **Only one active advance per employee at a time** (blocks a new
  submission while a Pending or Approved-with-any-status one exists) — a
  real lending-practice guard, not date-overlap logic like Leave. An
  advance becomes `Closed` (a separate status from `Approved`) automatically
  the moment its balance reaches zero, which is what actually unblocks the
  next request — verified directly (see below).
- **The reimbursement receipt is NOT stored through the Documents module.**
  Documents is a staff-managed compliance archive — Admin/Manager/HR-only
  writes (passports, iqamas, contracts). A worker-submitted receipt is a
  different trust category entirely; routing it through Documents would
  have meant punching a worker-upload hole into that module's RBAC. Instead
  this module owns a minimal embedded file record and reuses the same
  generic, already-hardened Cloudinary upload middleware
  (`middleware/upload.js` — content-signature verification, authenticated
  delivery, orphan cleanup on a failed request) that Documents also reuses.
  Two modules sharing infrastructure, not one module reaching into another's
  data.
- **Approve and Paid are separate states for a reimbursement claim.**
  Approval says the claim is legitimate; Paid says Accounts actually
  reimbursed it, which realistically happens on a different day. Collapsing
  them would either block Accounts' own workflow or make "Approved" a lie
  about whether money moved.
- **Cancelling a Pending reimbursement deletes the record and its Cloudinary
  file**, rather than soft-cancelling like Leave/Advance. Nothing else ever
  references a claim (no downstream approval history worth keeping for a
  claim that never happened), so there's no reason to keep an orphaned
  receipt in storage — verified the file is actually gone-from-access after
  cancel, not just marked cancelled.

## Verified (2026-08-29)

**curl** (throwaway admin + a Worker + an Accounts login, all deleted after),
covering:

*Advances* — submit → 201 Pending; a second submission while one is
in-flight → 409; amount ≤ 0 → 400; decide twice → 400 on the second;
repayment over the outstanding balance → 400; a partial repayment
(400 of 1000) → outstanding correctly 600; the final repayment (600) →
status auto-flips to `Closed`, outstanding 0; a repayment attempt on a
`Closed` advance → 400; a new submission after the old one closed → 201
(confirms `Closed` doesn't count as "active"); Worker blocked from the
entire staff router → 403; Accounts can list and record a repayment (200,
201) but not decide → 403.

*Reimbursements* — submit without a file → 400; submit with a real JPEG
(genuine multipart upload through to Cloudinary, not mocked) → 201 with the
receipt metadata recorded; the worker downloads their own receipt → 200
`image/jpeg`; staff download the same receipt → 200; marking paid before
approval → 400; approve → 200; mark paid → 200; cancelling a `Paid` claim →
400; submitting an invalid category → 400; cancelling a `Pending` claim →
200, and its receipt then 404s for everyone (record and file both gone).

**Client build**: `npm run build` — clean, no errors.

**Browser**: not reachable this session (same port/CORS constraint as the
rest of Phase 3 so far — see `docs/P3-B-notes.md`). Every code path,
including the real file upload/download round-trip against Cloudinary, was
exercised via curl; the client pages render that same verified data through
already-proven components (`Card`/`Modal`/`ConfirmDialog`, the
`AvatarUploadModal` file-input pattern reused for the receipt picker).

**Cleanup**: throwaway admin/Worker/Accounts logins, the two test
employees, all advances and reimbursement claims, their refresh tokens, the
audit-log rows, and the uploaded Cloudinary receipt file were all removed.
