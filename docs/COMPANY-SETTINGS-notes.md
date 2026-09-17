# Company Settings: a real company profile, wired into every PDF

Prompted directly by user feedback on the Mobilisation form: the Client
dropdown was correct, but there was no equivalent record of *our own*
company's details anywhere in the app — every generated PDF (invoices,
quotations, certificates, settlements, payslips) either had no letterhead at
all or a hardcoded "Al Jazeera" placeholder. Confirmed with the user which
categories to build (all four offered: Legal identity, Contact & address,
Bank details, Authorized signatory) and that it should be wired into PDFs
immediately rather than just stored.

## What was built

```
server/src/modules/companySettings/
  companySettings.model.js       # companyName/companyNameAr, crNumber,
                                   # vatNumber, address, phone, email, website,
                                   # bankName, bankIban, signatoryName,
                                   # signatoryTitle, logoUrl, manageRoles
                                   # (ApprovalRole ids)
  companySettings.validation.js  # NEW — update schema (all optional, "" → null)
                                   # + a separate manage-roles schema
  companySettings.service.js     # canManageCompanySettings(), getLetterheadData()
  companySettings.controller.js  # dynamic assertCanManage() 403 gate
  companySettings.routes.js      # visible to all staff; PATCH /manage-roles
                                   # additionally requires literal Admin
  letterhead.pdf.js              # NEW — shared drawLetterhead()/
                                   # drawSignatoryBlock(), LETTERHEAD_HEIGHT=95

server/src/modules/{invoices,quotations,eosb,exitDocuments,payroll}/*.pdf.js
                                   # each accepts (data, company, logo) now and
                                   # shifts its own absolute Y-coordinates by
                                   # `top = company ? LETTERHEAD_HEIGHT : 0`
server/src/modules/{invoices,quotations,eosb,exitDocuments,payroll}/*.controller.js
                                   # fetch getLetterheadData() before building the PDF

client/src/features/companySettings/
  companySettings.api.js
  companySettings.schema.js       # NEW
  pages/CompanySettingsPage.jsx   # NEW — Logo/Legal/Contact/Bank/Signatory
                                   # sections + an Admin-only "Manage access"
                                   # role checklist
  components/CompanyLogoCard.jsx  # moved here from Timesheet Processor

client/src/app/router.jsx         # /company-settings route
client/src/app/navConfig.js       # nav item, no `roles` filter (dynamic gate)
```

**Permission model**: Admin/Manager always; otherwise `manageRoles` (an
admin-configurable list of `ApprovalRole`s) via the same
`isMemberOfAnyRole()` helper Mobilisation Settings already uses. Changing
*who* is in `manageRoles` is Admin-only — a broader editor shouldn't be able
to grant that same access to someone else. This is a route-level dynamic
check (`assertCanManage` in the controller, mirroring Approval Log's
pattern), not a static `navConfig.js` role filter, since eligibility depends
on ApprovalRole membership the nav config can't express — the page itself
renders a "You don't have access to this page" EmptyState on a 403,
following the same visible-to-all-staff-but-gated-in-page convention.

**`getLetterheadData()`** is the one function every PDF controller calls:
returns `{ company: null, logo: null }` unless `companyName` or `logoUrl` is
actually set, so a PDF generated before the profile exists renders exactly
as it always did — no "Company name not set" placeholder on a real document.
Certificates and Payslips (which had a hardcoded minimal header before)
explicitly fall back to their old rendering when `company` is null, rather
than assuming a company profile always exists.

## Key decisions & why

- **`CompanySettings.manageRoles` and `MobilisationSettings.viewerRoles` are
  deliberately separate lists**, even though the real org chart's BDM/COO/GM
  will likely populate both. Coupling them would mean an unrelated
  mobilisation-visibility change could silently alter who can edit the
  company's legal/bank identity.
- **A single shared `LETTERHEAD_HEIGHT` constant (95px)**, reserved
  regardless of how many detail lines are actually filled in, rather than
  computing dynamic spacing per PDF. Every generator's existing absolute
  Y-coordinates just needed `+ top` added.
- **Invoice PDFs gained a new "Payment instructions" section** (bank
  name/IBAN) shown only when `balanceDue > 0 && company?.bankName &&
  company?.bankIban` — not shown on a fully-paid invoice or when bank
  details were never entered.
- **Settlement and Certificate PDFs gained a real signatory block**
  (`drawSignatoryBlock`) using the configured name/title, replacing
  Certificate's old generic "Authorized Signature / Human Resources"
  placeholder.

## Verified (2026-09-05)

**curl**: set full company details as a throwaway BDM-role (`ApprovalRole`
member) test user → 200; the same user attempting `PATCH /manage-roles` →
403 (Admin-only correctly enforced); a plain Accounts user with no
ApprovalRole membership → 403 on even reading the settings, confirmed via
the client rendering the "You don't have access to this page" EmptyState
rather than crashing.

**PDF rendering**: generated a real Invoice, Certificate, and Settlement PDF
with the test company details set, opened each with the `Read` tool's
PDF-rendering capability — letterhead (logo + name + CR/VAT + address/phone/
email + divider), spacing, and (Settlement/Certificate) the signatory block
all rendered correctly with no overlap or truncation.

**Cleanup**: all test users, employees, and generated PDFs deleted;
`CompanySettings` itself reset to empty (`deleteMany({})`) since every value
entered during verification was fake test data, not the user's real company
details — the real profile is the user's own to fill in via the new page.

## Not done / deliberately out of scope

- No company details were invented or pre-filled — the page ships empty,
  same discipline as every other "don't invent data" field in this app.
- Payroll payslips were not re-verified with a real generated PDF in this
  pass (Certificate/Settlement/Invoice were); the `getLetterheadData()`/
  fallback wiring is identical to Certificate's, so the same "renders
  unchanged when company is null" guarantee applies, but a live payslip PDF
  render with company details set wasn't independently opened.
