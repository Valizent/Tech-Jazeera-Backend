# Company profile: clients and subcontractors (2026-10-12)

Milestone 2 of the 12 October 2026 programme (dashboard tiles M1, this M2, then
missing-details reminders M3, mobilisation form M4, subcontractor transfer M5).

## What a client and a subcontractor now carry

One shared definition (`server/src/modules/companyProfile/`), spread into both models:

| Field | Notes |
|---|---|
| `arabicName` | Company name in Arabic |
| `crNumber` (existing) + `crExpiry` | CR number and its expiry date |
| `nationalAddress` | Saudi National Address: building number (4 digits), street, district, city, postal code (5), additional number (4), unit number (optional), short address (optional, 4 letters + 4 digits) |
| Contact person | The existing `contactPerson` / `phone` / `email` plus new `contactPosition` (no data migration) |
| `financePerson`, `owner` | name, position, phone, email each (owner = head of the company) |
| `coordinators[]` | People at the company we coordinate with: name, designation, phone, email. Each keeps its own `_id` so a mobilisation can point at one (M4). Not the same thing as `Mobilisation.coordinators`, which are OUR staff |

Documents ride the existing Documents module: owner type `Subcontractor` was added,
and the categories `National Address` and `Letterhead`. Agreement and Commercial
Registration already existed.

## Missing details

Computed on read, never stored (`companyProfile.service.js`), returned as
`missingDetails: [keys]` on list and get for both kinds of company. A company can be
saved with none of the new details; it is then flagged (banner on the profile, badge in
lists, "Missing" on each empty value).

Counts as missing: Arabic name, CR number, CR expiry, any required National Address part
(unit number and short address are optional), contact / finance / owner when any of
name, position, phone or email is blank, no coordinators, no Agreement document with an
expiry date, no Commercial Registration document with an expiry date, no National
Address document. The Letterhead is optional and never counts.

## Surfaces

- Web: shared `CompanyProfileFields` / `CompanyProfileSummary` / `MissingDetails` in
  `features/companyProfile/`; client form and profile extended; subcontractors moved
  from a modal to pages (`/subcontractors/new`, `/:id`, `/:id/edit`) with a profile and
  a Documents tab.
- Phone: the same components; subcontractors moved from a bottom sheet to screens
  (`/subcontractors/new`, `/:id`, `/:id/edit`).
- Subcontractor documents are uploaded from the subcontractor's own profile; the global
  upload dialog still picks employees and clients only.

## Reminders and escalation (milestone 3, 2026-10-12)

A daily job (`notifications/companyDetails.job.js`, started in `server.js` 35 seconds
after boot, then every 24 hours) walks every Active client (Approved) and Active
subcontractor:

| When (days since first seen incomplete) | Who is notified |
|---|---|
| 30 | Whoever created the record (once) |
| 40 | The BDM (once) |
| 45, then every 5 days | The Marketing Manager, until it is complete |

- **The clock** is `missingDetailsSince` on the record. A new client or subcontractor
  starts it at creation. A record that predates this feature gets it the first time the
  job sees it incomplete, so every existing record has 30 days from the release. It is
  cleared the moment the record is complete (and starts again if it becomes incomplete).
- **Each stage is recorded** (`missingDetailsReminders`), so a job that was down sends
  each stage once instead of a burst.
- **Who the BDM and the Marketing Manager are** is set by an Admin under Section Access,
  Sales & Clients, Clients: the cards "Missing company details: BDM reminder" and
  "Missing company details: Marketing Manager reminders". The members of the approval
  roles ticked under **Write** are the recipients (Read is not used). With nobody ticked
  a step waits and fires once someone is.
- A subcontractor that predates this feature has no recorded creator, so its day-30
  creator step is skipped.
- The notification opens the client or subcontractor profile and lists what is missing
  (type "Task", English text like the other server-generated notifications).
- Verified: `companyDetails.job.test.js` (the day-by-day timeline, the catch-up after a
  missed run, the 5-day repeat, completion clearing the clock, the held BDM step, inactive
  companies ignored) and the two cards on the web Section Access page.

## The mobilisation form (milestone 4, 2026-10-12)

- **Wording:** every visible "worker" is now "employee" ("Employee name", "Employee type",
  "OT payment to employee", the Employee data page, list columns, exports, validation and
  server messages), web and phone, English and Arabic. Kept as they were: the **Worker
  login** role name, "القوى العاملة" (workforce), the stored field names (`workerName`,
  `workerType`) and the API paths.
- **OT billed at the client rate:** the form no longer asks for an OT client rate. A new
  mobilisation gets `otClientRate = clientRate` on the server and keeps it equal on every
  edit (`otClientRateFollowsClient`). It still shows in the Rates and financials card, for
  whoever may see commercial data. Records created before this keep their own typed OT rate.
- **OT payment to the employee** (`otEmployeeRate`, per hour) stays on the form for Own and
  subcontractor employees.
- **Freelancer:** a new required `employeeRate` (what the company pays the freelancer per
  hour). Their OT is paid at the same rate (`otEmployeeRate` is set to it, never typed).
  Profit per hour = client rate - client commission - employee rate. In the monthly figures
  their regular hours cost `employeeRate x regular hours` (new breakdown line "Freelancer
  pay"), their OT hours `otEmployeeRate x OT hours`. A freelancer saved before this has no
  employee rate and is computed exactly as before.
- **Client and subcontractor coordinators:** the form lists the picked company's own
  coordinators (several can be ticked) and has "Add new", which saves a new coordinator onto
  the company itself (`POST /api/mobilisations/company-coordinators`, same permission as
  creating a mobilisation). The mobilisation stores a snapshot of each (name, designation,
  phone, email), so a later change to the company's list never rewrites a submitted one.
  Subcontractor coordinators apply to subcontractor employees only; changing the company
  clears that side's picks.
- **Commission recipient:** when the client commission is 1 or more a recipient is required,
  one coordinator from the same client; the same for the subcontractor commission on a
  subcontractor employee. Below 1 the recipient is cleared. Editing an older record does not
  demand one unless the save touches a commission or a company. The recipient is commercial
  data, hidden from a coordinator once Approved like the commission itself.
- **Iqama autofill** fills the person's own data (name, nationality, phone) and no longer
  selects the subcontractor. The form shows "In our records this employee is with X" when
  that differs from the chosen subcontractor; the move-and-approve prompt is milestone 5.
- Verified: `mobilisation.companyPeople.test.js` (OT rule new vs older, freelancer rate and
  monthly pay, picked coordinators, a foreign company's coordinator refused, the commission
  rule, older-record edits, adding a coordinator) plus the real API, the web form (fields,
  coordinators listed, recipient appears at commission 2, inline add selects the new person)
  and the phone form in Arabic.

## Subcontractor transfer approval (milestone 5, 2026-10-12)

- **When it is asked:** a subcontractor employee is mobilised through a subcontractor other
  than the one our records hold him with. The record is the outsourced register (by Iqama),
  else his latest other mobilisation. The form asks "Move X to Y?" once per save with three
  answers: Cancel, "No, only for this mobilisation" and "Yes, request the move". The prompt
  is not repeated for a request already pending to that same subcontractor. The Iqama
  lookup now also finds a person who is only in the outsourced register (never mobilised),
  filling his name, nationality and phone.
- **What yes does:** one `SubcontractorTransfer` request (Pending) per mobilisation, shown
  on the mobilisation and in the Marketing Manager's "Waiting on you" on the dashboard.
  Changing the subcontractor or answering no later withdraws it (Cancelled).
- **Who decides:** the members of the roles on the final step of the active Mobilisation
  approval workflow (the Marketing Manager) and Admin. No new Section Access entry. They
  open it from the Outsourced page, option "Subcontractor transfer approvals" with a
  pending count, on the web and the phone. Anyone else sees the requests they raised,
  read-only.
- **Approve:** the person's register entry is moved to the new subcontractor (or created
  if he was only known from a mobilisation); the mobilisation's coordinators are notified.
- **Reject (a reason is required):** the mobilisation goes back to its coordinators with
  that reason (a submitted one becomes Rejected for the coordinators; a draft keeps the
  note); the register is untouched.
- **The mobilisation can still be saved and submitted**, but its final approval is refused
  (409, with the reason) until the transfer is approved.
- Verified: `subcontractorTransfer.test.js` (12 tests: raising, who decides, approve,
  reject, withdrawal, the final-approval gate, the register-only lookup) plus the real API
  (request, list as decider and as coordinator, 403 for a coordinator deciding, final
  approval blocked then allowed, reject returning the mobilisation), the web form prompt and
  banner, and the phone screens in Arabic. The phone form's prompt Sheet mirrors the web
  prompt but was not driven on the emulator.

## Verified

Server: `companyProfile.test.js` (11 tests: what counts as missing, National Address and
person validation for both companies, documents counted per owner). Isolated database,
web and emulator: a client saved incomplete (banner showed the five gaps, short address
upper-cased, edit kept the coordinator, filling the district dropped the count to four),
a subcontractor saved incomplete, a seeded Agreement document row dropped its count from
8 to 7, the upload dialog lists the new categories, the phone list, profile and form in
Arabic. A real file upload was not exercised (it would write to the live Cloudinary).
