# In-app chat (2026-10-24)

Decided with the user (holdoff.md section 7): office staff only; free chat, 1:1 and groups;
images and PDF only; nobody reads other people's conversations; true real-time over WebSocket;
this repo is Al Jazeera only (the multi-company product is the separate Valizent WMS build).

## Milestones
- M1 server REST (done): models, `/api/chat`, upload allowlist, push, retention job, tests.
- M2 server real-time (WebSocket).
- M3 web screens.
- M4 phone screens.
- M5 wrap-up and go-live notes.

## Who can do what
- Chat itself: every STAFF_ROLES login and Executive (`requireStaffOrExecutive`). Worker and Staff
  self-service logins get 403.
- People one can add to a chat are re-checked on the server: active, and one of those roles.
- `chatModeration` (Section Access, single tier, Write): list reported messages, view a reported
  attachment, dismiss or remove. It does NOT let anyone open a conversation.
- A non-member gets the same 404 as a conversation that does not exist.

## Data (`server/src/modules/chat/`)
- `Conversation`: type (direct|group), name, `directKey` (sorted member ids, unique, partial index:
  one 1:1 chat per pair), `members[] {user, role, unread, lastReadAt, lastPushAt}`, `lastMessage`
  preview, `lastMessageAt`, `revision`.
- `ChatMessage`: body (max 4000), attachment {fileName, resourceType, mimeType, originalName, size},
  `deletedAt` tombstone. Paged by `_id` (newest first, `before` cursor).
- `ChatReport`: one per (message, reporter); status open|dismissed|removed.
- `revision` is incremented in the SAME write as every change members could see (send, delete, read,
  membership). The real-time layer (M2) watches it.

## API
`GET /unread-count`, `GET /directory?q=`, `GET|POST /conversations`, `PATCH /conversations/:id`
(group admin: rename, add, remove), `DELETE /conversations/:id/members/me` (leave group),
`GET|POST /conversations/:id/messages` (POST is multipart: optional `body`, optional `file`),
`POST /conversations/:id/read`, `DELETE /messages/:id` (own), `GET /messages/:id/file` (streams, members
only), `POST /messages/:id/report`, `GET /reports`, `GET /reports/:id/file`, `PATCH /reports/:id`
(`{action: dismiss|remove}`).

## Behaviours worth knowing
- Attachments reuse `middleware/upload.js` (`uploadChatAttachment`): JPG, PNG, WEBP, PDF, 10 MB, magic
  bytes checked, stored private; bytes are streamed through the API, never a Cloudinary URL. When the
  OCI migration lands they move with everything else (only upload.js changes).
- Push: `pushOnly()` in notification.service.js (same queue/channels as notifications, no stored
  Notification row). Title = sender name, body = "New message", url = `/chat/<id>`. The 30 s per member per
  conversation throttle is a conditional update on `lastPushAt`, so it holds across PM2 processes.
- Retention: `chatRetention.job.js`, daily (65 s offset), `CHAT_RETENTION_DAYS` (default 365, min 30). It also
  clears a conversation's last-message preview once that message is purged.
- Audit: conversation create/update/leave, own-message delete, report, report decision. Message text is
  never written to the audit log, and ordinary sends are not logged.
- Deleting a message leaves a tombstone ("Message deleted") and removes the stored file.

## Tests
`chat.service.test.js`, `chatRetention.job.test.js`. Verified by hand against a running server with
throwaway users (auth, role gate, validation, dedupe, upload rejection, file streaming, report and
moderation flow); the test data was deleted afterwards.

## Still to do (later milestones)
Real-time socket and Nginx upgrade headers (M2), web (M3), phone (M4); `chatModeration` must be granted in
Section Access on staging and production.
