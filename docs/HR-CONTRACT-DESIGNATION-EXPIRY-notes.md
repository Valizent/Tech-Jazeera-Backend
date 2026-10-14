# 2026-10-14: contract-end alerts, Designation <-> approval roles, document-expiry ladder

## Contract end
- `dashboardInsights.contractsEnded`: every non-exited employee whose `contractEndDate` has passed (count + the 5 oldest, `daysOverdue`). Leaves the list when the date is renewed. Shown on the HR watch card (web + phone).
- `notifications/contractEnd.job.js` (daily, +45s after boot): HR users get one notification 30 days before, and one when it has ended (only for contracts that ended within the last 7 days, so a backlog never floods; older ones live on the dashboard list). Dedupe key = employee + end date + stage + person, so a renewal starts a fresh cycle.

## Departments / allowances
- `Coordination` removed from `EMPLOYEE_DEPARTMENTS` (server list, web + phone constants and locales). Existing records keep the text and read as "no department yet" through `normalizeDepartment`.
- `Employee.foodAllowance` (financial field: hidden and write-protected like the other pay figures). Housing, transport and food default to 0 on a new employee; records saved earlier keep null.

## Designation <-> approval role (`employees/designationSync.service.js`)
- `Employee.designation` stays a string: a role NAME or a free-text trade. `GET /api/employees/designations` lists active, non-reserved role names for the pick-list (employee read access).
- Employee saved with a new designation -> their login joins that role and leaves the previous designation's role. Worker/Staff logins and employees with no login are left alone.
- Role members changed (Approval Hierarchy) -> an added person's designation becomes that role unless it already names another role they hold; a removed person whose designation was this role falls back to another role they still hold, otherwise it is left unchanged (a designation is required; a trade is never invented).
- Role renamed -> designations carrying the old name follow.
- One main role per person. Extra roles are still managed in Approval Hierarchy.

## Document-expiry ladder (`notifications/expiryAlert.job.js`)
- Starts: passport and driving licence 6 months, iqama / medical / visa 3 months (visa was not specified; it takes the iqama's 3 months). Edit `START_MONTHS`.
- Repeats: monthly (more than 30 days), weekly (8 to 30), daily (0 to 7), daily once expired until a new date is saved. One notification per document + expiry date + step + person.
- Told: the employee's login + all active HR users from the first reminder; coordinator and manager from 30 days; GM and COO approval roles (found by name) and Admin from 14 days.
- Company/client documents (Documents module) keep the old rule (30 days, Admin/Manager/HR).
- First run after deploy: every document already inside its window produces one notification per recipient, so HR gets a one-off batch.
