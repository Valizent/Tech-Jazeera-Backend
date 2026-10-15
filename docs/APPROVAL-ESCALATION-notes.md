# Approval escalation matrix (2026-10-15)

## What it does
- A workflow step carries up to **3 escalation levels**: `{ afterDays (1-90), notify: 'approver' | 'role', role }`, increasing days.
  Edited in the workflow editor under the step's roles (web and phone); listed under each workflow.
- A daily job (`notifications/approvalEscalation.job.js`, scheduled in `server.js`) walks every request still waiting
  on a hierarchy (`listApprovalLog` for every type incl. monthly hours entries, plus mobilisations) and, for each level
  whose day is reached, notifies the step's approver (`recipientsOfStep`) or the role's members (`membersOfRoles`).
- **Inform only**: it never changes who can decide.
- **Once per visit**: dedupeKey = type, id, step index, the moment the step was entered, level, user.
  Moving to the next step (or a resubmission) restarts the clock.
- **Calendar days** counted from `currentStepEnteredAt`, else the last trail entry, else when it was filed.
- **Requests already waiting** (frozen steps without levels) use the live workflow's step at the same position, only
  while that workflow is active and has the same number of steps.

## Data
- `escalation` on the workflow step (`approvalWorkflow.model.js`) and in every request's frozen step
  (`approvalFields.js` `escalationLevelsField`, and the models that declare their own steps).
- `currentStepEnteredAt` on every request (set when filed, and on each step advance in `decideApprovalStep`).

## Removed
- Mobilisation Settings (page, route, nav, phone screen, server module) and `mobilisationStale.job.js`: the only
  setting was the stale threshold. The `mobilisationsettings` collection is now unused (safe to drop).

## Known limits
- Days are calendar days (weekly off and holidays are not skipped).
- Only the approver and one role per level can be told; a level cannot take the decision away from the approver.
