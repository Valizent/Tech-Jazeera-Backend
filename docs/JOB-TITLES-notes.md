# Job Titles: an admin-managed picklist for Mobilisation

Prompted by user feedback on the Mobilisation form: "Job title" was a free-text
field, and it should instead be "a drop down list of Jobs that the admin or
bdm, managers, GM or COO can add."

## What was built

```
server/src/modules/jobTitles/
  jobTitle.model.js        # NEW — { name (unique, trimmed), isActive }
  jobTitle.validation.js   # NEW — create/update/list/id-param schemas
  jobTitle.service.js      # NEW — canManageJobTitles(), case-insensitive
                             # duplicate check (409), CRUD
  jobTitle.controller.js   # NEW — assertCanManage() dynamic 403 gate
  jobTitle.routes.js       # NEW — read open to any staff, write gated
server/src/app.js           # mounted at /api/job-titles

client/src/features/jobTitles/
  jobTitles.api.js          # NEW — listJobTitles(), createJobTitle() only
                             # (no update/delete client calls — not asked for)
client/src/features/mobilisations/components/MobilisationForm.jsx
                             # Job title Input → Select + inline "+ Add new"
client/src/features/mobilisations/pages/MobilisationNewPage.jsx
client/src/features/mobilisations/pages/MobilisationEditPage.jsx
                             # both fetch job titles and pass them down,
                             # same pattern as workers/clients/subcontractors
```

**Permission model**: Admin/Manager always; otherwise any `ApprovalRole`
member (`isApprovalRoleMember()`, the same simpler check Approval Log uses) —
deliberately *not* its own `manageRoles` list like Company Settings. A
low-stakes picklist of job labels doesn't carry the same risk as legal/bank
data, so it reuses the coarser "any approval-chain member" check rather than
adding a second admin-configurable role list to maintain.

**`Mobilisation.jobTitle` stays a plain string**, not a foreign key to
`JobTitle` — same "reference at pick-time, snapshot for durable history" rule
already used for `clientName`/`workerName` on this model. Renaming or
deactivating a `JobTitle` entry never rewrites a past mobilisation's own text.

**Inline quick-add**: a "+ Add new" text-button beside the Job title label
opens a `Modal` rendered as a sibling of the `<form>` (not nested inside it,
which would be invalid HTML) — its Save button calls
`addJobTitleMutation.mutate()` directly via `onClick`, not a nested form
submission. On success the new title is meant to be auto-selected in the
dropdown immediately.

## A real bug found and fixed during verification

The auto-select above didn't work on the first pass: `onSuccess` called
`queryClient.invalidateQueries(['job-titles'])` (which refetches
asynchronously) and then immediately `setValue('jobTitle', created.name,
...)` in the same tick. Since the new `<option>` didn't exist in the DOM yet
at that moment, the native `<select>`'s value assignment silently no-opped —
confirmed via browser: the toast correctly said `"Forklift Operator TEST"
added.`, but the dropdown reverted to "Select a job title…", and the DOM's
accessibility tree showed no option selected even though the new option
existed in the list moments later.

**Fix**: instead of selecting immediately, store the pending name
(`pendingJobTitle`) and apply `setValue` from a `useEffect` that only fires
once the `jobTitles` prop (refreshed by the invalidated query) actually
contains it:

```js
useEffect(() => {
  if (pendingJobTitle && jobTitles.some((jt) => jt.name === pendingJobTitle)) {
    setValue('jobTitle', pendingJobTitle, { shouldValidate: true, shouldDirty: true });
    setPendingJobTitle(null);
  }
}, [jobTitles, pendingJobTitle, setValue]);
```

This guarantees the `setValue` DOM write happens on a render pass where the
matching `<option>` already exists, regardless of how long the refetch takes.

## Verified (2026-09-05)

**Build**: `npm run build` clean, both before and after the auto-select fix.

**curl** (throwaway Admin + a second throwaway user flipped to plain
`Accounts` with no `ApprovalRole` membership):
- Admin: create "Site Driver" → 201; duplicate ("site driver", different
  case) → 409; list → both correctly reflected.
- Plain Accounts (non-member): list → 200 (read is open to all staff);
  create → 403 ("You do not have permission to manage job titles.").

**Browser** (throwaway Admin): `/mobilisations/new` renders Job title as a
dropdown with the seeded "Site Driver" option and a "+ Add new" link next to
the label. Clicking it opens the modal focused on the input; typing a name
and clicking Add closed the modal, showed a success toast, and — after the
fix above — correctly left the new title selected in the dropdown
immediately, with no manual re-selection needed.

**Cleanup**: all test job titles deleted via the API; both throwaway test
users (and their refresh tokens) deleted directly from the database; no
scratch scripts remain in the repo.

## Not done / deliberately out of scope

- No update/delete UI was built (deactivating or renaming an existing job
  title) — only create was requested; the server module supports both if a
  future request needs them.
- `MobilisationEditPage` was verified only for correct wiring (fetches and
  passes `jobTitles` identically to the New page) and a clean build — it
  wasn't independently click-through tested in the browser, since it reuses
  the exact same `MobilisationForm` component already verified above.
