# P3-G — Multi-language

Completes the Phase 3 build-out (see `docs/PHASE3-PLAN.md`) — the last
planned milestone. Given the scope choice between translating the entire
app or just the Worker portal, the user chose **the Worker self-service
(ESS) portal only**: the manpower workforce is who actually needs Hindi/
Nepali/Bengali/Arabic; Admin/Manager/HR/Accounts/Coordinator already
operate the staff panel in English day to day.

## What was built

**New dependencies**: `i18next`, `react-i18next` (client only). Justification:
proper i18n (interpolation, pluralization, a React binding that re-renders
on language change) is far past "~30 lines" — this is the standard pairing
for React, and introduces no new vulnerabilities (`npm audit` — the
pre-existing advisories all trace to tailwindcss/vite's own postcss/nanoid
chain, unrelated to this addition).

```
client/src/i18n/
  index.js                # i18next setup — resources, RTL/lang application,
                            #   NO detector plugin (a manpower worker's
                            #   phone locale may not match the language they
                            #   actually read; an explicit choice beats a
                            #   guess), localStorage persistence
  locales/en.json          # 274 keys — the master/source language
  locales/ar.json          # Arabic (RTL)
  locales/hi.json          # Hindi
  locales/ne.json          # Nepali
  locales/bn.json          # Bengali

client/src/components/shared/LanguageSwitcher.jsx
  # mounted ONLY on AuthLayout (login) and EssLayout — never on
  #   DashboardLayout, since no staff screen calls t()

client/index.html           # + a second pre-paint inline script (mirrors
                              #   the existing theme one) setting dir/lang
                              #   from localStorage before React mounts —
                              #   no LTR flash for a returning Arabic reader
client/src/main.jsx          # + import './i18n/index.js' (side effect)
client/public/sw.js          # untouched by this milestone
```

**Converted to `useTranslation()`** — every screen a Worker can reach, plus
the shared login:
```
LoginPage.jsx, AuthLayout.jsx
EssLayout.jsx (nav labels, header actions, footer)
ChangePasswordModal.jsx, AvatarUploadModal.jsx   # shared with staff, but
                                                    #  staff never change
                                                    #  language so these
                                                    #  always render English
                                                    #  for them regardless
NotificationBell.jsx        # the shell UI only — see limitations below
ExpiryBadge.jsx              # small shared component, 4 strings
MyProfilePage.jsx, MyDocumentsPage.jsx, MyDocumentPreviewModal.jsx
MyAttendancePage.jsx (+ its embedded weekly-timesheet section)
MyLeavePage.jsx, UpcomingHolidays.jsx
MyRequestsPage.jsx (advances + reimbursements)
MyExitDocumentsPage.jsx (exit re-entry visas + certificates + assets)
MyPayslipsPage.jsx
```

## Key decisions & why

- **Scope is the ESS portal, not the whole app** — the user's explicit
  choice between two offered options. A thin, half-translated coat over
  ~40+ admin screens would have violated "no half-finished implementations"
  worse than a smaller, fully-real deliverable.
- **No language-detector plugin.** i18next-browser-languagedetector would
  guess from `Accept-Language`/browser locale, which for this specific
  workforce (foreign nationals whose phone OS locale is often still their
  home country's default, or English, regardless of which language they
  actually read comfortably) would frequently guess wrong. An explicit
  choice, persisted once made, is more honest than a silent guess — same
  "never invent, always ask/let the user say" instinct as everywhere else
  in this app.
- **RTL relies on native `dir="rtl"` cascading, not a wholesale Tailwind
  physical→logical utility rewrite.** Modern CSS/Flexbox mirrors block flow,
  text alignment, and `flex-direction: row` automatically under `dir: rtl`
  — verified directly in the browser (screenshot below) that the ENTIRE
  Worker portal — sidebar, header, cards, forms — flips correctly with zero
  manual per-component RTL classes. Preemptively converting every `pl-`/`ml-`/
  `text-left` to its logical equivalent across ~10 files on the chance
  something might look wrong would have been "designing for a hypothetical"
  the browser test proved unnecessary.
- **Server-generated text stays English, by design, not oversight.**
  Notification titles/bodies (P3-F), leave-eligibility explanations
  ("Requires 24 months of continuous service…"), and API validation
  messages are all produced by backend code with no i18n awareness —
  translating them would mean adding a full i18n layer to the Express API
  (Accept-Language handling, translating every `ApiError` message across
  every module), which is backend-wide work touching the staff panel too,
  not something scoped to "the ESS portal's own screens." Verified this
  is exactly what happens (see below) rather than assuming it.
- **Client-side Zod validation messages (react-hook-form's inline field
  errors) are also NOT translated in this pass** — they live in each
  feature's own `*.schema.js` file (`leave.schema.js`,
  `exitDocuments.schema.js`, `financialRequests.schema.js`, etc.), a
  different, larger set of files than the page components this milestone
  touched. Documented here as a known gap rather than silently left
  unmentioned — a natural next slice if this ever gets picked back up.
- **Dates and numbers are NOT locale-formatted.** `formatDate()`/
  `formatMoney()` in `lib/utils.js` are hardcoded to `en-GB`/`en-US`
  formatting regardless of the selected language (confirmed directly: a
  Nepali-language screen still shows "9 Sept 2026", not a Nepali date
  format). Localizing these would mean threading the current language into
  every call site across the ESS pages — a real, defensible extension, but
  a distinct scope from "translate the copy," and left as a documented
  limitation rather than attempted partially.
- **Status words get their own translation dictionary
  (`common.status.*`), not the existing English-only label constants**
  (`LEAVE_REQUEST_STATUS_LABELS`, etc., in `lib/constants.js`). Those
  constants are shared with staff screens and out of this milestone's
  scope to touch; every ESS page instead calls
  `t('common.status.'+code, code)` — the second argument is i18next's
  default-value fallback, so a status value with no translation entry
  degrades to showing the raw code instead of breaking.
- **`ChangePasswordModal`, `AvatarUploadModal`, and `ExpiryBadge` are
  shared with the staff panel but were translated anyway** — since staff
  never see a language switcher (only mounted on `AuthLayout`/`EssLayout`),
  `i18n.language` stays `'en'` for every staff session regardless, so these
  always render their original English text for staff. Verified this holds
  even in the pathological shared-browser case (a worker changes language,
  then somehow the same browser is later used for a staff login) is an
  accepted, narrow edge case — the exact same caveat `ThemeContext`'s own
  localStorage-based preference already carries, not a new category of risk.

## Verified (2026-08-30)

**Locale file integrity** (scripted, not eyeballed): all 5 JSON files parse
as valid JSON; a key-flattening comparison confirms all 5 have **exactly**
the same 274 keys — zero missing, zero extra, in any language.

**Browser** (throwaway admin + Worker login, real leave-type/request data,
deleted after):

- Login screen: language switcher present with all 5 options; switching to
  Arabic correctly re-rendered every string ("Al Jazeera ERP" → "الجزيرة -
  نظام إدارة الموارد", etc.) and set `document.documentElement.dir="rtl"`
  / `lang="ar"`, persisted to `localStorage`.
- A full-page **screenshot** of the Arabic ESS portal (My Documents) showed
  the sidebar on the right, header controls on the left, right-aligned
  text throughout, and correctly mirrored nav-icon/label ordering — the
  entire shell flipped correctly with the RTL-reliance approach above,
  confirmed visually, not assumed.
- Every one of the 7 ESS pages (Profile, Documents, Attendance — including
  the embedded weekly-timesheet section, Leave, Requests — both advances
  and reimbursements, Exit Documents — visas, certificates, and assets, and
  Payslips) was loaded in Arabic and read back via the page's actual text
  content, confirming real translated strings render, not just that the
  code compiles.
- Enum-backed dropdowns rendered correctly in Arabic: reimbursement
  categories (Travel/Fuel/Meals/Medical/Tools/Other → السفر/الوقود/
  الوجبات/طبي/أدوات/أخرى), visa types (Single/Multiple → مرة واحدة/متعدد),
  and certificate types (SalaryCertificate/ServiceCertificate/
  ChamberOfCommerceAttestation → شهادة راتب/شهادة خبرة/تصديق الغرفة
  التجارية) — this caught and fixed a real bug: the first draft of the
  translation keys guessed wrong enum values (`"Exit"`, `"Salary"`, etc.)
  that didn't match the actual `VISA_TYPES`/`CERTIFICATE_TYPES` constants,
  silently falling back to raw English codes. Found by cross-checking
  against `lib/constants.js` directly, not caught by the build (Zod/JS
  don't validate translation-key coverage) — fixed in all 5 locale files.
- Hindi, Bengali, and Nepali were each spot-checked on at least one real
  page (My Documents; My Leave for Nepali) and confirmed to render their
  own script correctly with `dir` correctly staying `"ltr"` for all three
  (only Arabic triggers RTL).
- **Pluralization + interpolation, verified against real data**: submitted
  a genuine 3-day leave request via the API, reloaded the Nepali-language
  page, and confirmed it rendered "Annual Leave · 3 दिन" (the `{{count}}`
  interpolation and the day/days plural key both resolved correctly) and
  the status badge showed "समीक्षा विचाराधीन" (the translated `PendingReview`
  status) — not just that the JSON key exists, but that i18next's actual
  interpolation/pluralization engine produces the right string from real
  count data.
- **Confirmed the documented scope boundary directly, not assumed**: the
  same leave request's `eligibility.ruleApplied` text
  ("Requires 24 months of continuous service (has 7).") rendered in
  English even while the rest of the page was in Nepali — proof the
  server-generated-text limitation is real and exactly as described, not
  a gap that silently went further than intended.

**Client build**: `npm run build` — clean, no errors, both before and after
every fix made during verification.

**Cleanup**: the throwaway admin and Worker logins, the test employee, the
test leave request, their refresh tokens, and the audit-log rows were
removed via a temporary `server/cleanup-tmp.mjs` (deleted after running).
Re-attempting a login with the throwaway admin's credentials afterward
confirmed it is gone.

## Open items carried forward

- Client-side Zod validation messages (inline field errors) are not
  translated — see "Key decisions" above.
- Date/number formatting is not locale-aware (`lib/utils.js`'s
  `formatDate`/`formatMoney` are hardcoded to `en-GB`/`en-US`).
- Server-generated text (notification content, leave-eligibility
  explanations, API error messages) stays English regardless of the
  client's selected language — would require a backend i18n layer, out of
  this milestone's ESS-portal scope.
- Translations for Arabic and Hindi were produced with reasonable
  confidence; Nepali and Bengali were produced with somewhat less native
  fluency — a native-speaker review pass on all four (standard practice for
  any first-generation i18n rollout, not specific to this app) is
  recommended before treating the wording as final, especially anywhere it
  could be read as a legal/HR commitment.

## Scope extended (2026-09-06): the staff panel, English/Arabic only

The "staff already operates in English" scope decision above was
explicitly revisited and changed by the user — not reversed by oversight.
The staff panel (Admin/Manager/HR/Accounts/Coordinator/Executive) now also
gets a language switcher, deliberately English/Arabic only (Hindi/Nepali/
Bengali stay ESS-only — they were always about the blue-collar workforce,
not this persona), rolled out module by module starting with the shell +
Dashboard. See `docs/STAFF-I18N-notes.md` for the full design (notably a
real RTL-rollout tradeoff put to the user before writing code) and what's
translated so far.

## Superseded (2026-09-06): Hindi/Nepali/Bengali removed

The user decided the workforce-language scope above was no longer wanted —
the ESS portal (and the shared login screen, which offers the same list)
is now **English/Arabic only**, matching the staff panel. Removed:
`client/src/i18n/locales/{hi,ne,bn}.json`, their imports/registrations in
`client/src/i18n/index.js`, and the now-redundant `STAFF_SUPPORTED_LANGUAGES`
constant (the ESS/login/staff switchers all show the same two languages
now, so `LanguageSwitcher.jsx` no longer takes a `languages` override).
Nothing server-side referenced these codes, so no backend change was
needed. If Hindi/Nepali/Bengali support is wanted again later, the removed
JSON files' shape can be regenerated from `en.json`'s current key set —
they were last in sync only through the P3-G scope (274 keys), not the
staff-panel keys added afterward.
