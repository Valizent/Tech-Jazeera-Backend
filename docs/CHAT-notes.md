# In-app chat (2026-10-24)

Decided with the user (holdoff.md section 7): office staff only; free chat, 1:1 and groups;
images and PDF only; nobody reads other people's conversations; true real-time over WebSocket;
this repo is Al Jazeera only (the multi-company product is the separate Valizent WMS build).

## Milestones
- M1 server REST (done): models, `/api/chat`, upload allowlist, push, retention job, tests.
- M2 server real-time (done): WebSocket at `/ws`, change-stream fan-out, tests.
- M3 web screens (done): `client/src/features/chat/`.
- M4 phone screens (done): `Mobile application/src/features/chat/` and the Chat tab.
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

## Real-time (M2): `chat.socket.js`
- Endpoint `wss://<api host>/ws` (same host as the API). Dependency added: `ws` (Node has no built-in
  WebSocket server; `ws` is tiny and has no dependencies of its own).
- It carries NO message content. The only server-to-client events are `ready` (auth accepted),
  `conversation.changed {conversationId}` and `resync` (the change stream dropped and came back, so
  re-fetch everything). The client answers either change event by re-fetching over REST. `ping` -> `pong`.
- Auth: the first message must be `{type:'auth', token:<access token>}` within 5 s (a token in the URL would be
  logged by proxies). Checked like `requireAuth` plus the chat role floor (so Worker/Staff logins, deactivated
  users and reset passwords are refused). Close code **4401** = "get a fresh token, then reconnect": sent on a
  bad token, an auth timeout, when the access token expires (every 15 min) and when the account stops being
  allowed (re-checked every 5 min). **4429** = too many messages (20 per 10 s).
- Origin (defence in depth only; the token is the real gate and is not a cookie): a connection with no Origin, an Origin in
  `CLIENT_URL`, or an Origin whose host is this server's own host is accepted. The last case matters: React Native on
  Android sends the API's own address as the Origin, and the first version of this check dropped the phone's socket
  (found on the emulator). 4 KB max message size.
- PM2 cluster: a socket lives in one process, so every process watches `Conversation` with a MongoDB change
  stream (needs a replica set, which Atlas is) filtered on `revision`, and delivers to its own sockets. Proved with
  two server processes: a message sent through one reached a socket on the other in under a second. If the
  stream is lost it retries every 5 s and sends `resync` to every connected socket.
- Known limit: someone REMOVED from a group is not signalled (the event only reaches current members); their
  list corrects itself the next time it refetches.
- If WebSockets are blocked on someone's network the apps must keep working: clients also refetch the unread
  count on a slow timer and on focus (M3/M4).

## Go-live: Nginx on the Oracle VM (USER ACTION)
The API's Nginx server block needs the WebSocket upgrade headers, otherwise `/ws` answers 400/502. Add inside
the `server { ... }` for the API host (match the `proxy_pass` port your existing `location` already uses):

```
location /ws {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
}
```
then `sudo nginx -t && sudo systemctl reload nginx`. The api subdomain is DNS-only in Cloudflare, so nothing
changes there. Render (staging) supports WebSockets as is. Also grant **Chat reported messages**
(`chatModeration`) under Section Access on staging and production.

## Web (M3): `client/src/features/chat/`
- Routes (staff shell only; Worker/Staff logins are sent to `/me`): `/chat`, `/chat/:id` (a push notification opens this
  address), `/chat/reports` (needs `chatModeration`). Sidebar item **Chat** sits under Dashboard for every office
  login and Executive, with the unread badge; "Chat Reports" is an Admin & Tools tile for holders of `chatModeration`
  and a card on the Section Access page.
- `useChatSocket` (mounted once in DashboardLayout) keeps one WebSocket to `wss://<api host>/ws` and answers
  `conversation.changed` by invalidating the `['chat', ...]` queries (list, unread, that thread), `resync` / `ready` by
  invalidating everything. It reconnects with a growing delay; on close code 4401 it makes one authenticated request
  (axios refreshes the token) and reconnects. Without a socket the badge still polls every 60 s and on focus.
- Screens: conversation list (search, preview, unread badge), thread (oldest first, date separators, "Load earlier"
  that keeps your place, glued to the bottom unless you scrolled up, marks read when opened/visible), composer
  (Enter sends, Shift+Enter newline, one image/PDF up to 10 MB, text kept on a failed send), image bubbles (private
  file fetched as a Blob, click to enlarge, Download) and PDF bubbles (Open / Download), new-chat dialog (direct or
  group), group info (rename, add, remove, leave), report dialog, moderation page (only reported messages).
- On a phone-width screen only the list (`/chat`) or the thread (`/chat/:id`) shows.
- i18n: `chat.*` plus `staffNav.chat` and `staffNav.admin.chatReports` in `en.json` and `ar.json`; logical RTL classes.
- Verified in the browser with throwaway users: live delivery to an open thread and to the list/badge, text, image and
  PDF send and fetch, report -> moderator removes -> tombstone, group create/leave, direct picker, validation errors
  (inline + toast + console), Arabic RTL, phone width.
- Not verified: a real browser Web Push notification, and the Open button's new tab (the test browser pane does not
  open pop-ups; the file request itself succeeded).

## Phone (M4): `Mobile application/`
- **Chat** tab right after Dashboard (staff shell; Executive too; not for a granted Worker/Staff login) with the unread
  badge on the tab; thread at `/chat/:id` (the address a push notification opens, so tapping a chat push lands on the
  right conversation); `/chat/reports` for people with `chatModeration` (also an Admin & Tools tile and a Section Access
  card). Route files: `src/app/(app)/(staff)/(tabs)/chat.jsx`, `.../(staff)/chat/[id].jsx`, `.../chat/reports.jsx`.
- `useChatSocket` (mounted in the staff layout) is the web hook for the phone: a native `WebSocket` to
  `ws(s)://<api host>/ws` derived from `EXPO_PUBLIC_API_URL`, open only while the app is in the foreground (a phone drops
  background sockets and push covers the closed app); coming back to the foreground reconnects and refetches. On close
  code 4401 it calls `refreshSession()` once and reconnects. A push that arrives while the app is open also refreshes the
  chat queries (`lib/push.js`).
- Thread: an inverted list fed newest-first (older pages load as you scroll up), date separators, own messages on the
  end edge, Report / Delete under each bubble, keyboard-aware composer, attach menu (Take photo, Choose photo, Choose PDF
  or image file; 10 MB; JPG, PNG, WEBP, PDF). Images are downloaded natively with the Bearer header and cached
  (`fetchAuthedFileUri`); tapping an image or "Open" on a PDF hands it to the phone's viewer (`openAuthedFile`).
- Sheets: new chat (direct or group), group info (rename, add, remove, leave), report. Destructive actions use the
  native confirm alert. Strings: the web's `chat.*` keys (identical) plus `mobile.chat.choosePhoto/choosePdf`, en + ar.
- Verified on the Android emulator (Expo Go) against the local API with throwaway users: the new tab and its live badge,
  list preview and unread badge updating with no refresh, thread with text, image and PDF messages arriving live, a reply
  and a picked image sent from the phone (the server stored the multipart upload), the attach menu, the system file
  picker, the report sheet (a moderator saw the report). Lint is clean and the Android bundle compiles.
- Not verified on a device: Arabic/RTL on the phone (the layout uses start/end classes; RTL was checked on the web), a real
  push notification and tapping it (needs an EAS build + Firebase, see the go-live list), the moderation screen, group
  create/leave on the phone, and the PDF viewer after "Open" (the emulator has no PDF app).

## Still to do (later milestones)
Wrap-up (M5): go-live items below.
