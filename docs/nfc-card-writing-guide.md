# NFC card trial — step-by-step guide (your 10 blank cards)

This walks you from 10 blank cards to working taps. Do it once and the rest is
routine.

## 0. Make the tap page reachable by a phone (one-time)

The card URL is served by the **API server** (port 5000). A phone tapping a card
can't reach `localhost`, so point the cards at a host the phone can open. Pick
one:

- **Same Wi-Fi (quickest for a trial):** find your PC's LAN IP (Windows:
  `ipconfig` → IPv4, e.g. `192.168.1.20`). In `server/.env` set
  `PUBLIC_BASE_URL=http://192.168.1.20:5000`, restart the server, and keep the
  phone on the same Wi-Fi.
- **Public HTTPS (works anywhere, needed for WhatsApp link previews):** run a
  tunnel, e.g. `cloudflared tunnel --url http://localhost:5000`, and set
  `PUBLIC_BASE_URL` to the `https://…trycloudflare.com` URL it prints.
- **Production:** a real domain + HTTPS pointing at the server; set
  `PUBLIC_BASE_URL` to it.

Generate the batch *after* setting this, so the URLs/QR use the right host. (If
you change it later, use **Rotate token** to reissue URLs, then rewrite chips.)

## 1. Generate the batch

NFC Customers → **Cards** → **Generate batch** → count **10**, label e.g.
"Trial 10" → Generate → **Download CSV**. The CSV has each card's **Token** and
**URL**.

## 2. Write the 10 chips

Use a phone NFC-writing app, e.g. **NFC Tools** (free, Android and iPhone):

1. Open NFC Tools → **Write** → **Add a record** → **URL/URI**.
2. Paste the **URL** from row 1 of the CSV → OK → **Write** → hold the card to
   the phone until it says done.
3. Repeat for each card, matching CSV rows to physical cards. Tip: pencil the
   last 3 token characters on each card so you know which is which.
4. (Optional) NFC Tools → **Other** → **Lock tag** makes a card read-only.
   **This is permanent** — only do it once you've confirmed the URL works.

A tapped card that isn't assigned to anyone yet shows a neutral "not available"
page. That's expected until step 4.

## 3. Add the company and people

NFC Customers → **Add company** (name, website, address, **brand colour** — this
tints their tap pages). Open the company → **Add person** (name, job title,
phone, WhatsApp, email, LinkedIn, short bio).

## 4. Assign a card to each person

On the company page, next to a person → **Assign card** → pick one of your blank
cards (match the token to the chip you wrote) → Assign. The card is now
**active**.

## 5. Test the tap

Tap the card with a phone → the person's page opens with your brand colour →
**Save Contact** adds them to the phone. Try the Call/WhatsApp/Email/Maps rows.

## Day-to-day

- **QR instead of a tap:** each card's detail page has a QR (Download PNG) you can
  print or paste.
- **Someone leaves / card returned:** open the card → **Unassign** (frees it) or
  **Return to inventory**; reuse it for the next person.
- **Card lost/stolen:** open the card → **Mark lost** — the URL stops working
  instantly.
- **Rewriting a chip / changing the host:** **Rotate token** issues a new URL and
  kills the old one, then write the new URL to the chip.
- **Reassign:** just **Change card** on a person, or assign the same card to
  someone else — history is kept on the card.
