# Outsourced documents and the expiry tracker (2026-10-15)

## What it does
- An outsourced worker's document has a **type** (Ajeer, Muqeem, Passport, Iqama, Medical, Visa, Driving License,
  Insurance, Contract, or Other, which asks for a name), an optional **number**, an optional **expiry date**, and
  **reminderDays** (1 to 365, default 30): how many days before the expiry the reminders start. The **file is
  optional** and can be attached or replaced later. Documents can be edited (`PATCH /outsourced-employees/:id/documents/:fileId`).
- The **agreed rate** (and its currency) was removed from outsourced workers. Mobilisations take the rate from the
  mobilisation itself (`subcontractorRate` is null when a worker is created from a listed worker).
- **Reminders** (`notifications/outsourcedDocuments.job.js`, daily): inside the document's lead time the worker's
  coordinators are told (found through the worker's latest mobilisation by Iqama number); the **MM** approval role
  is added in the last 7 days, after expiry, or when the worker has no coordinator. Steps: start, weekly (14 days or
  less), daily (3 days or less), expired. Each step is sent once (`dedupeKey` per worker, document, day-bucket, step, user).
- Employees' **additional documents** now raise the same reminders as identity documents (3 months ahead).
- **Expiry tracker** (`GET /documents/expiry-tracker`, same Section Access as Documents): every document with an expiry
  date from employees (identity and additional), stored files, and outsourced papers, with Expired / Expiring / Valid,
  counts, owner type filter and search. Document numbers are never returned. The Documents page opens on it; the file
  list is the second tab ("All files"). Web and phone.

## Where
- Server: `employees/outsourcedEmployee.{model,validation,service,controller,routes}.js`,
  `notifications/outsourcedDocuments.job.js`, `notifications/expiryAlert.job.js`, `documents/expiryTracker.service.js`,
  `server.js` (schedule), tests in `employees/outsourcedDocuments.test.js`.
- Web: `features/employees/components/OutsourcedEmployeeFormModal.jsx` (`DocumentsSection`),
  `features/documents/components/ExpiryTrackerPanel.jsx`, `features/documents/pages/DocumentListPage.jsx`.
- Phone: `features/employees/components/OutsourcedDocumentsCard.jsx`, `features/documents/components/ExpiryTrackerList.jsx`,
  `app/(app)/(staff)/documents.jsx`.

## Known limits
- A tracker row for an outsourced worker links to the outsourced list, not the worker.
- Reminder recipients depend on the worker having a mobilisation with a coordinator; otherwise only the MM role is told.
- The MM role is found by the name `MM`. If that role is renamed, the MM escalation stops.
