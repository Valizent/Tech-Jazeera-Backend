# NFC Customers — developer notes (Phase A)

An **Admin-only** NFC digital-business-card platform: companies and their people,
a physical **card inventory** (tokens, batches, assignment lifecycle, history),
and a **public server-rendered tap page** per active card. Separate from the
Client/Employee modules. Phase A ships the core + the trial workflow; analytics,
CSV import, wallet passes, i18n, and lead capture are later phases.

## Data model (`server/src/modules/nfc/`)
```
nfcCompany.model.js     # name, contact, phone, email, website, address, mapLink, city, brandColour
nfcEmployee.model.js    # company ref; name, jobTitle, phone, whatsapp, email, linkedin, bio, idNumber
nfcCard.model.js        # token (unique), chipUid (partial-unique), batch, status, employee/company, assignedAt
nfcBatch.model.js       # label, note, count, createdBy  (a run of blank cards)
nfcAssignment.model.js  # card, employee, company, assignedAt, unassignedAt  (full history; open row = current)
```
Statuses: `unassigned | active | lost | returned | disabled`.

## Public tap page (server-rendered, NOT the SPA)
- `GET /c/:token` → mobile HTML (Express, `nfc.publicPage.js`): brand-colour
  accent, tappable Call/WhatsApp/Email/Website/LinkedIn/Location rows, one-tap
  **Save Contact**, `noindex`, Open Graph tags. Server-rendered so crawlers get
  OG/`noindex` without running JS.
- `GET /c/:token/vcard` → vCard 3.0 (`nfc.vcard.js`), CRLF + escaped, iOS-safe.
- Mounted at `/c` (own rate limiter `publicCardLimiter`, no auth), before the 404.
- **Card URLs** use `env.publicBaseUrl` (`PUBLIC_BASE_URL`, default the local API
  origin) so QR/CSV/tap links point at the right host.

## Admin API (`/api/nfc`, Admin only)
Companies + people CRUD; `POST /batches` (generate N blank cards),
`GET /batches`, `GET /batches/:id/cards.csv`; `GET /cards` (search + status +
company filters), `GET /cards/:id`, `PATCH /cards/:id` (chipUid),
`GET /cards/:id/qr.png`, and lifecycle POSTs `assign` / `unassign` / `lost` /
`return` / `disable` / `rotate`.

## Security & privacy (built in)
- **Random 12-char base62 tokens** (`nfc.token.js`), never derived from a name.
- **Identical information-free 404** for unknown / inactive / lost / unassigned /
  rotated-away tokens — a scanner can't tell them apart.
- **Whitelisted fields only** in the public payload/vCard (no ids, no internal
  fields like idNumber/notes).
- **Rate limiting** on `/c/*`; token format pre-checked before any DB hit.
- Lifecycle is effectively atomic: assign closes the prior open assignment first
  (reassign is one step); lost/rotate kill the URL immediately.

## Key decisions
- **Cards are inventory, not a field on a person** — one card ↔ (at most) one
  person at a time, with full history, so lost/rotate/reassign are first-class.
- **Deleting a company/person frees their cards** back to `unassigned` (physical
  cards aren't destroyed), and closes their assignment history rows.
- **QR** via the `qrcode` dependency (encoding QR by hand is infeasible; it's the
  standard).
- **Map** = an address (opens a Maps search) or an explicit `mapLink`.

## Tap-page design (premium "foil-and-stock")
`nfc.publicPage.js` renders a mobile-first business card on dark stock: a
loader, the card rising with a mouse-driven sheen, staggered actions,
pointer-tilt (desktop), a geometric pattern + grain. The brand colour drives
the accent, glow, icon tints and Save button via `color-mix`.
`prefers-reduced-motion` disables the motion.

**CSP**: `/c/*` replaces the app-wide helmet policy with its own
(`nfc.public.routes.js`). The default `script-src 'self'` silently blocked the
page's inline script, so each response now carries a nonce. The default also
included `upgrade-insecure-requests`, which rewrote the page's own image
requests to https and broke every logo/photo over a plain-http LAN trial.

**Images** (`nfc.upload.js`): company **logo** and person **photo** upload
(PNG/JPG/WEBP ≤ 2 MB, random-named on disk under `UPLOAD_DIR/nfc`), served
publicly at `/nfc-media/<file>` (basename-guarded, cached). URLs are returned as
`logoUrl`/`photoUrl`; the photo also becomes the page's `og:image` for rich link
previews. Replacing/removing/deleting cleans up the old file.

## Admin UI (`client/src/features/nfc/`)
Companies list (`/nfc`) → company profile (`/nfc/:id`, brand + people + assign) ·
card inventory (`/nfc/cards`, filters + generate batch) → card detail
(`/nfc/cards/:id`, URL + QR + status + history + lifecycle). Assignment is done
from a person's page; card detail manages an existing card.

## Analytics (Phase B)

Answers "is this working?" — taps, contacts saved, which links get used, from
where, on what.

```
nfcTapEvent.model.js       # card/employee/company + type/target/at + country/device/platform/referrerHost/visitor
nfc.visitor.js             # request → privacy-safe context (pure functions, no deps)
nfc.analytics.service.js   # recordTapEvent + card/company/overview aggregation
```

**Events**: `view` (page opened) and `save` (vCard fetched) are recorded
server-side, so they cannot be blocked. `click` (call/whatsapp/email/website/
linkedin/location) can't be — those links navigate away without touching the
server — so the page fires `navigator.sendBeacon` to `POST /c/:token/e`. The
alternative, redirecting every link through the server, breaks `tel:` on iOS and
kills long-press-to-copy; links stay real links and tracking is best-effort.
`image` is declared in the enum but not yet emitted (reserved for the
save-card-as-picture feature).

**Privacy is the design constraint.** Tappers are members of the public, so
**no IP, no full user agent, no full referrer** is stored. `visitor` is a
one-way hash salted per UTC day (salt derived from `JWT_ACCESS_SECRET` with
domain separation — no new secret invented), which makes unique-visitor counts
possible but cross-day tracking impossible. Only the referrer's *host* is kept.
Rows self-delete after `RETENTION_DAYS` (400) via a TTL index.

**Country** comes from the CDN/proxy header (`CF-IPCountry`,
`x-vercel-ip-country`, `x-appengine-country`, `x-geo-country`) — no GeoIP
database, no dependency, no IP processing. It reads `null` when the server is
not behind such a proxy, so a LAN trial shows no countries; put it behind the
`cloudflared` tunnel from the card-writing guide and they appear. Spoofable in
principle, which is fine for a chart and would not be for anything else.

**Bot filtering** matters more than it sounds: pasting a card URL into WhatsApp
makes Meta's servers fetch the page to build the link preview. Two rules —
a known-crawler pattern, plus "user agent does not start with `Mozilla/`",
which catches every HTTP library without needing to enumerate them. Errs toward
undercounting.

**Dedupe**: a repeat `view` from the same visitor inside 30 min is ignored (a
reload is not a second visitor); `save`/`image` 2 min; clicks never.

**Recording never breaks a page** — callers don't await it, and the function
cannot throw. `POST /c/:token/e` answers 204 before doing any work, and always
204 even for an unknown token so it can't be used to probe which tokens exist.

**Reads** use one `$facet` per screen (many pipelines, one pass, one round
trip). Days are bucketed at `+03:00` (Riyadh; KSA has no DST, so a fixed offset
is exact and the JS range boundary and Mongo's bucketing can never disagree —
unlike attendance, which stores date-only keys in UTC).

**API** (Admin): `GET /api/nfc/analytics`, `/cards/:id/analytics`,
`/companies/:id/analytics`, each `?days=1..365` (default 30).

**UI**: `/nfc/analytics` overview (totals, trend, most-tapped cards, countries,
devices), an Activity panel on card detail, and per-person tap counts on the
company profile. The trend is CSS bars — one metric over N days is a flexbox
and a percentage height, not a charting dependency.

## Verified (2026-08-07, Phase B)
38 automated end-to-end checks (`view`/`save`/`click` recording, nonce matches
the CSP header, 6 tracking hooks rendered, internal ids not leaked to the page,
reload dedupe, WhatsApp/facebookexternalhit/no-UA bots ignored, distinct
visitors, country from both CF and Vercel headers, device+platform split, valid
vCard, beacon 204 + invalid targets rejected + unknown token still 204, series
zero-filled to the full window, disabled card 404s and records nothing, company
per-person breakdown, overview top cards, `days` cap/non-numeric → 400, no token
→ 401, unknown card → 404, default 30). Browser: overview + card panel + company
counts at 1280px and 375px (no horizontal scroll), range picker switching
30→7 days, beacon firing from a real click and landing in the DB, and the
pointer-tilt script running for the first time (it was CSP-blocked before). All
test data wiped; only the real company and the owner's account remain.

## Verified (2026-08-06)
curl end-to-end: company (brand colour) → person (all fields) → **batch of 10** →
assign → **public page 200** (name/title/brand/`noindex`) → **vCard** (valid 3.0)
→ **QR PNG** → **CSV** → rotate (old URL 404, new 200) → mark lost (404) →
assign-to-lost **400** → unassign (404) → reassign (history grows, one active).
Identical 404 for unknown tokens; admin 401 without auth. Browser: cards
inventory, card detail (QR/actions/history), company profile. All test data wiped.

## Later phases (not built)
**Next up**: save-the-card-as-an-image button (canvas-drawn card + QR back to
the live page; Web Share API so it reaches the iPhone camera roll — a plain
download link does not). The `image` event type is already reserved for it.

C: CSV import, card-request workflow, expiry auto-disable, audit-log surfacing,
Arabic/English, Wallet passes (need Apple/Google certs), lead capture.
