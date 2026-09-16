/**
 * Server-rendered HTML for the public NFC tap pages — a premium "foil-and-stock"
 * digital business card. Rendered by Express (not the SPA) so Open Graph and
 * `noindex` work for crawlers. Every interpolated value is HTML-escaped; only
 * whitelisted, public fields are passed in.
 *
 * ADAPTS PER BRAND: the treatment (dark or light stock) is chosen from the
 * company's brand colour so that colour always reads well — a light brand glows
 * on dark stock, a dark brand reads as ink on ivory stock.
 *
 * The unknown/lost/unassigned case renders an identical, information-free 404.
 *
 * EN/AR TOGGLE (Milestone A): this page has no i18next access at all — it's
 * outside the React bundle entirely — so the toggle is a small self-contained
 * mechanism: every translatable element carries `data-en`/`data-ar`
 * attributes (Arabic value already resolved server-side via nfc.i18n.js's
 * pickLang, so it's never blank), and one inline-script loop swaps
 * textContent + flips `dir` on click. Manually-entered `*Ar` fields only —
 * never auto-translated.
 */
import { UI_STRINGS, pickLang } from './nfc.i18n.js';

/** HTML-escape text content. */
function h(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
/** Only HTML-escape for hrefs (URLs are already valid + safe-schemed). */
const attr = h;

const digits = (v) => String(v ?? '').replace(/[^\d]/g, '');
const ensureHttp = (url) => (!url ? '' : /^https?:\/\//i.test(url) ? url : `https://${url}`);
const safeHex = (c) => (/^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#1f9e78');

const ICON = {
  phone: 'M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z',
  whatsapp: 'M12 2.25c-5.385 0-9.75 4.365-9.75 9.75 0 1.72.446 3.336 1.228 4.74L2.25 21.75l5.13-1.2A9.7 9.7 0 0012 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25z',
  email: 'M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0-8.57 5.27a2.25 2.25 0 01-2.36 0L2.25 6.75',
  // A briefcase, not an envelope — the "company mail" distinction from the
  // primary Email row is deliberately a different shape, not just a
  // different colour, so it still reads correctly at a glance/in a screenshot.
  altEmail: 'M9 6.75V5.25A2.25 2.25 0 0111.25 3H12.75A2.25 2.25 0 0115 5.25V6.75M5.25 6.75H18.75A2.25 2.25 0 0121 9V16.5A2.25 2.25 0 0118.75 18.75H5.25A2.25 2.25 0 013 16.5V9A2.25 2.25 0 015.25 6.75ZM3 12.75H21',
  web: 'M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.5 0 4-4 4-9s-1.5-9-4-9-4 4-4 9 1.5 9 4 9zM3 12h18',
  linkedin: 'M6.5 8.25A1.75 1.75 0 106.5 4.75a1.75 1.75 0 000 3.5zM5 10.5h3v9H5v-9zm5 0h2.9v1.23h.04c.4-.76 1.38-1.56 2.85-1.56 3.05 0 3.61 2 3.61 4.61v4.72h-3v-4.18c0-1 0-2.28-1.39-2.28s-1.6 1.09-1.6 2.21v4.25h-3v-9z',
  location: 'M15 10.5a3 3 0 11-6 0 3 3 0 016 0zM19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z',
  save: 'M16.5 3.75V16.5L12 14.25 7.5 16.5V3.75m9 0H18A2.25 2.25 0 0120.25 6v12A2.25 2.25 0 0118 20.25H6A2.25 2.25 0 013.75 18V6A2.25 2.25 0 016 3.75h1.5m9 0h-9',
  download: 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M7.5 12l4.5 4.5m0 0l4.5-4.5m-4.5 4.5V3',
};
const iconSvg = (path, filled = false) =>
  `<svg viewBox="0 0 24 24" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.7"'} aria-hidden="true">${filled ? `<path d="${path}"/>` : `<path stroke-linecap="round" stroke-linejoin="round" d="${path}"/>`}</svg>`;

/**
 * One tappable row. `track` is the analytics key (see NFC_CLICK_TARGETS); the
 * page script reads it from data-t and beacons it on click. The href stays a
 * real link, so tapping works exactly the same if the beacon never fires.
 * `label`/`labelAr` are the toggle's fixed UI strings (nfc.i18n.js) — the
 * href itself never changes with language, only the visible text.
 */
function action({ icon, label, labelAr, href, track, filled = false, blank = false }) {
  if (!href) return '';
  const t = blank ? ' target="_blank" rel="noopener"' : '';
  return `<a class="act" href="${attr(href)}" data-t="${attr(track)}"${t}><span class="ic">${iconSvg(icon, filled)}</span><span data-en="${attr(label)}" data-ar="${attr(labelAr)}">${h(label)}</span></a>`;
}

/** Palette tokens for the ultra-premium dark aesthetic. */
function palette(brand) {
  return {
    '--brand': brand,
    '--accent': `color-mix(in oklab, ${brand} 85%, #fff 15%)`,
    '--bg': '#09090b',
    '--card-bg': 'rgba(15, 15, 20, 0.45)',
    '--card-border': 'rgba(255, 255, 255, 0.12)',
    '--text': '#f4f4f5',
    '--muted': '#a1a1aa',
    '--save-fg': '#ffffff',
    '--hair': 'rgba(255, 255, 255, 0.1)',
    '--btn-bg': 'rgba(25, 25, 30, 0.5)',
    '--icon-bg': `color-mix(in oklab, ${brand} 15%, transparent)`,
    '--glow': `color-mix(in oklab, ${brand} 60%, transparent)`,
  };
}

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
:root{--ease:cubic-bezier(.25,1,.3,1)}
html,body{height:100%}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--text);background:var(--bg);min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;position:relative;overflow-x:hidden}

.saudi-art{position:fixed;inset:0;pointer-events:none;z-index:0;opacity:0.25;
 background-image:url("data:image/svg+xml,%3Csvg width='120' height='120' viewBox='0 0 120 120' xmlns='http://www.w3.org/2000/svg'%3E%3Cg stroke='%23ffffff' stroke-width='0.5' fill='none' stroke-opacity='0.6'%3E%3Cpath d='M60 0 L120 60 L60 120 L0 60 Z'/%3E%3Cpath d='M30 30 L90 90 M30 90 L90 30'/%3E%3Ccircle cx='60' cy='60' r='42'/%3E%3Ccircle cx='60' cy='60' r='18'/%3E%3C/g%3E%3C/svg%3E");
 background-size:120px 120px;
 -webkit-mask-image:radial-gradient(circle at 50% 30%, black 10%, transparent 85%);mask-image:radial-gradient(circle at 50% 30%, black 10%, transparent 85%);}
 
.glow{position:fixed;inset:-50%;background:radial-gradient(circle at 50% 30%, var(--glow) 0%, transparent 60%);z-index:0;opacity:0.6;animation:pulse 8s infinite alternate ease-in-out;}
@keyframes pulse{0%{opacity:0.4;transform:scale(0.95);}100%{opacity:0.7;transform:scale(1.05);}}

.noise{position:fixed;inset:0;pointer-events:none;z-index:1;opacity:0.04;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");}

.load{position:fixed;inset:0;z-index:30;display:grid;place-items:center;background:var(--bg);animation:loadout 0.8s var(--ease) 0.6s forwards}
.load .ring{width:60px;height:60px;border-radius:50%;border:3px solid var(--hair);border-top-color:var(--brand);animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes loadout{to{opacity:0;visibility:hidden;transform:scale(1.05)}}

.card{position:relative;z-index:10;width:min(440px,100%);min-height:min(88svh, 820px);border-radius:36px;padding:40px 24px 32px;
 display:flex;flex-direction:column;
 background:var(--card-bg);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);
 border:1px solid var(--card-border);
 box-shadow:0 30px 60px -15px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.15);
 overflow:hidden;animation:rise 1s var(--ease) 0.8s both;transform-style:preserve-3d;will-change:transform;
 --x: 0px; --y: 0px;}
@keyframes rise{0%{opacity:0;transform:translateY(30px) scale(0.95)}100%{opacity:1;transform:translateY(0) scale(1)}}

/* Holographic sheen driven by mouse */
.card::after{content:"";position:absolute;inset:0;pointer-events:none;
 background:radial-gradient(800px circle at var(--x) var(--y), rgba(255,255,255,0.06), transparent 40%);
 mix-blend-mode:overlay;transition:opacity 0.2s;}

.card-content { flex-grow: 1; display: flex; flex-direction: column; justify-content: flex-start; gap: 16px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
.card-content::-webkit-scrollbar { display: none; }
.profile-header { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; margin-top: auto; }
.actions-section { width: 100%; flex-shrink: 0; margin-bottom: auto; padding-bottom: 8px; }

.logo{display:block;max-height:60px;max-width:70%;margin:0 auto 16px;object-fit:contain;animation:pop 0.6s var(--ease) 1.2s both;filter:drop-shadow(0 4px 16px rgba(0,0,0,0.4)) drop-shadow(0 0 20px rgba(255,255,255,0.15));}
.logo-hero{max-height:140px;max-width:85%;margin:16px auto 32px;filter:drop-shadow(0 8px 24px rgba(0,0,0,0.5)) drop-shadow(0 0 30px rgba(255,255,255,0.2));animation:pop 0.8s var(--ease) 1s both;}

.ava{width:104px;height:104px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;overflow:hidden;
 font-family:ui-serif,Georgia,serif;font-size:36px;font-weight:600;color:#fff;
 background:var(--brand);
 box-shadow:0 0 30px -10px var(--brand), inset 0 2px 4px rgba(255,255,255,0.4);animation:floaty 6s ease-in-out 2s infinite, pop 0.6s var(--ease) 1.3s both;position:relative;z-index:2;border:3px solid rgba(255,255,255,0.15);}
.ava img{width:100%;height:100%;object-fit:cover}
@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}

.name{font-weight:700;font-size:28px;line-height:1.1;text-align:center;letter-spacing:-0.02em;text-wrap:balance;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,0.3);animation:pop 0.6s var(--ease) 1.4s both;}
.role{text-align:center;color:var(--muted);font-size:14px;margin-top:6px;font-weight:500;animation:pop 0.6s var(--ease) 1.45s both;}
.org{text-align:center;color:var(--brand);font-size:13px;letter-spacing:0.08em;text-transform:uppercase;margin-top:8px;font-weight:700;filter:brightness(1.4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px;animation:pop 0.6s var(--ease) 1.5s both;}
.rule{height:1px;margin:16px 0;background:linear-gradient(90deg,transparent,var(--hair),transparent);animation:pop 0.6s var(--ease) 1.6s both;}

/* EN/AR toggle pill — fixed to the physical top-right corner regardless of
   the card's own dir, so the control itself never relocates when clicked. */
.lang-switch{position:absolute;top:18px;right:18px;z-index:5;display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--btn-bg);border:1px solid var(--hair);animation:pop 0.6s var(--ease) 1.1s both;}
.lang-switch button{border:0;background:transparent;color:var(--muted);font-size:11px;font-weight:700;padding:6px 10px;border-radius:999px;cursor:pointer;transition:all .25s var(--ease);font-family:inherit;}
.lang-switch[data-active="en"] button[data-lang="en"],.lang-switch[data-active="ar"] button[data-lang="ar"]{background:var(--icon-bg);color:var(--text);}

/* Arabic text needs a different font, no faux-uppercase (Arabic has no case),
   and near-zero letter-spacing (tracking breaks a connected script). */
[dir="rtl"] .org{text-transform:none;letter-spacing:0;font-size:14px;}
[dir="rtl"] .foot{letter-spacing:0.12em;}
[dir="rtl"] .name,[dir="rtl"] .role,[dir="rtl"] .org,[dir="rtl"] .bio,[dir="rtl"] .save span:last-child,[dir="rtl"] .act span:last-child,[dir="rtl"] .foot{font-family:'Noto Sans Arabic','Segoe UI',Tahoma,sans-serif;}

.save{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:16px;border-radius:24px;text-decoration:none;font-weight:600;font-size:16px;color:#fff;
 background:linear-gradient(135deg, var(--brand), var(--accent));
 box-shadow:0 12px 32px -8px var(--glow), inset 0 2px 0 rgba(255,255,255,0.3);animation:pop 0.6s var(--ease) 1.7s both;transition:all 0.3s var(--ease);position:relative;overflow:hidden;}
.save::after{content:"";position:absolute;inset:0;background:linear-gradient(to bottom, rgba(255,255,255,0.15), transparent);pointer-events:none;}
.save:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 20px 40px -10px var(--glow), inset 0 2px 0 rgba(255,255,255,0.4);}
.save:active{transform:scale(0.97)}
.save svg{width:22px;height:22px;animation:floaty 4s infinite;}

.download{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px;margin-top:10px;border-radius:20px;text-decoration:none;font-weight:600;font-size:14px;color:var(--text);
 background:var(--btn-bg);border:1px solid var(--hair);transition:all 0.25s var(--ease);animation:pop 0.6s var(--ease) 1.75s both;}
.download:hover{border-color:color-mix(in oklab, var(--brand) 40%, transparent);background:rgba(255,255,255,0.05);}
.download:active{transform:scale(0.98)}
.download svg{width:18px;height:18px}

.actions{display:grid;grid-template-rows:repeat(2,1fr);grid-auto-flow:column;grid-auto-columns:calc(33.333% - 8px);gap:12px;margin-top:16px;padding-bottom:12px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
.actions::-webkit-scrollbar{display:none;}
.act{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px 4px;border-radius:24px;text-decoration:none;color:var(--text);
 background:var(--btn-bg);border:1px solid var(--hair);box-shadow:0 8px 24px rgba(0,0,0,0.2);transition:all 0.25s var(--ease);animation:pop 0.5s var(--ease) both;}
.act:hover{transform:translateY(-5px) scale(1.05);background:rgba(255,255,255,0.05);border-color:color-mix(in oklab,var(--brand) 40%,transparent);box-shadow:0 12px 32px rgba(0,0,0,0.3), 0 0 20px var(--icon-bg);}
.act:active{transform:scale(0.95)}
.act .ic{width:44px;height:44px;border-radius:16px;display:grid;place-items:center;color:var(--accent);background:var(--icon-bg);transition:transform 0.3s var(--ease);box-shadow:inset 0 1px 0 rgba(255,255,255,0.1);}
.act:hover .ic{transform:rotate(5deg) scale(1.1);color:#fff;}
.act .ic svg{width:22px;height:22px}
.act span:last-child{font-size:12px;font-weight:500;}

.actions .act:nth-child(1){animation-delay:1.8s}.actions .act:nth-child(2){animation-delay:1.85s}.actions .act:nth-child(3){animation-delay:1.9s}
.actions .act:nth-child(4){animation-delay:1.95s}.actions .act:nth-child(5){animation-delay:2s}.actions .act:nth-child(6){animation-delay:2.05s}

@keyframes pop{0%{opacity:0;transform:translateY(16px) scale(0.92)}100%{opacity:1;transform:translateY(0) scale(1)}}

.bio{margin-top:16px;padding:16px;border-radius:20px;font-size:14px;line-height:1.6;color:var(--text);background:var(--btn-bg);border:1px solid var(--hair);animation:pop 0.6s var(--ease) 2.2s both;box-shadow:inset 0 2px 10px rgba(0,0,0,0.1);}
.foot{margin-top:auto;padding-top:20px;text-align:center;font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:var(--muted);font-weight:600;animation:pop 0.6s var(--ease) 2.3s both;}

@media (prefers-reduced-motion:reduce){*{animation:none !important}.load{display:none}.card::after{display:none}}

@media (max-width:480px){
  body{padding:24px 10px}
  .card{padding:32px 16px 24px;border-radius:28px}
  .lang-switch{top:14px;right:14px}
  .lang-switch button{padding:5px 8px;font-size:10px}
  .name{font-size:24px}
  .org{font-size:11px;letter-spacing:0.05em}
  .ava{width:88px;height:88px;font-size:30px;margin-bottom:12px}
  .logo{max-height:48px;margin-bottom:10px}
  .logo-hero{max-height:110px;margin-bottom:20px}
  .actions{gap:8px;margin-top:12px}
  .act{padding:12px 3px;border-radius:20px}
  .act .ic{width:40px;height:40px;border-radius:14px}
  .act .ic svg{width:20px;height:20px}
  .act span:last-child{font-size:11px}
  .save{padding:14px;font-size:15px;border-radius:20px}
  .rule{margin:12px 0}
  .foot{padding-top:16px}
}

@media (max-width:360px){
  body{padding:16px 8px}
  .card{padding:24px 12px 20px;border-radius:24px;min-height:80svh;}
  .name{font-size:22px}
  .org{font-size:10px;letter-spacing:0.03em}
  .ava{width:76px;height:76px;font-size:26px;margin-bottom:10px}
  .logo{max-height:40px;margin-bottom:8px}
  .logo-hero{max-height:80px;margin-bottom:12px}
  .actions{gap:6px;margin-top:8px}
  .act{padding:8px 2px;gap:6px;border-radius:16px}
  .act .ic{width:34px;height:34px}
  .act span:last-child{font-size:10px}
  .save{padding:12px;font-size:14px;border-radius:16px}
  .rule{margin:10px 0}
  .foot{padding-top:12px}
}
`;

/**
 * The full profile page.
 * data = { employee, company, cardUrl, vcardUrl, cardImageUrl, logoUrl, photoUrl, token, nonce }
 * `nonce` is the per-response CSP nonce (see nfc.public.routes.js) — without it
 * the browser refuses to run the page script at all. `cardImageUrl` is the
 * downloadable-card endpoint (Milestone B) — the toggle's own script keeps
 * its `?lang=` query in sync with whichever language is currently shown.
 */
export function renderProfilePage({ employee, company, cardUrl, vcardUrl, cardImageUrl, logoUrl, photoUrl, token, nonce }) {
  const brand = safeHex(company?.brandColour);
  const vars = palette(brand);
  const styleVars = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');

  const title = employee.name;
  const description = [employee.jobTitle, company?.companyName].filter(Boolean).join(' · ');
  const ogImage = photoUrl || logoUrl || '';

  const website = ensureHttp(company?.website);
  const linkedin = ensureHttp(employee.linkedin);
  const mapHref =
    ensureHttp(company?.mapLink) ||
    (company?.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(company.address)}` : '');
  const telHref = employee.phone ? `tel:${employee.phone.replace(/[^\d+]/g, '')}` : '';
  const waNumber = employee.whatsapp || employee.phone;

  // Manually-entered Arabic counterparts, falling back to the English source
  // when left blank (nfc.i18n.js's pickLang) — never a blank line when the
  // visitor toggles to Arabic.
  const nameAr = pickLang(employee.nameAr, employee.name);
  const jobTitleAr = pickLang(employee.jobTitleAr, employee.jobTitle);
  const orgAr = pickLang(company?.companyNameAr, company?.companyName);
  const bioAr = pickLang(employee.bioAr, employee.bio);

  const rows =
    action({ icon: ICON.phone, label: UI_STRINGS.en.call, labelAr: UI_STRINGS.ar.call, href: telHref, track: 'call' }) +
    action({ icon: ICON.whatsapp, label: UI_STRINGS.en.whatsapp, labelAr: UI_STRINGS.ar.whatsapp, href: waNumber ? `https://wa.me/${digits(waNumber)}` : '', track: 'whatsapp' }) +
    action({ icon: ICON.email, label: UI_STRINGS.en.email, labelAr: UI_STRINGS.ar.email, href: employee.email ? `mailto:${employee.email}` : '', track: 'email' }) +
    action({ icon: ICON.altEmail, label: UI_STRINGS.en.altEmail, labelAr: UI_STRINGS.ar.altEmail, href: employee.altEmail ? `mailto:${employee.altEmail}` : '', track: 'altEmail' }) +
    action({ icon: ICON.web, label: UI_STRINGS.en.website, labelAr: UI_STRINGS.ar.website, href: website, track: 'website', blank: true }) +
    action({ icon: ICON.linkedin, label: UI_STRINGS.en.linkedin, labelAr: UI_STRINGS.ar.linkedin, href: linkedin, track: 'linkedin', filled: true, blank: true }) +
    action({ icon: ICON.location, label: UI_STRINGS.en.location, labelAr: UI_STRINGS.ar.location, href: mapHref, track: 'location', blank: true });

  const avatar = photoUrl
    ? `<div class="ava"><img src="${attr(photoUrl)}" alt="${h(employee.name)}"></div>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${h(title)}</title>
<meta name="description" content="${h(description)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${h(title)}">
<meta property="og:description" content="${h(description)}">
${cardUrl ? `<meta property="og:url" content="${h(cardUrl)}">` : ''}
${ogImage ? `<meta property="og:image" content="${h(ogImage)}">` : ''}
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="${h(vars['--bg'])}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;600;700&display=swap" rel="stylesheet">
<style>${STYLE}</style></head>
<body style="${styleVars}">
<div class="glow"></div>
<div class="saudi-art"></div>
<div class="noise"></div>
<div class="load"><div class="ring"></div></div>
<h2 class="sr-only">Digital contact card for ${h(employee.name)}${company?.companyName ? `, ${h(company.companyName)}` : ''}.</h2>
<main class="card" id="card">
  <div class="lang-switch" id="langToggle" data-active="en">
    <button type="button" data-lang="en">EN</button>
    <button type="button" data-lang="ar">عربي</button>
  </div>
  <div class="card-content">
    <div class="profile-header">
      ${logoUrl ? `<img class="logo${!photoUrl ? ' logo-hero' : ''}" src="${attr(logoUrl)}" alt="${h(company?.companyName || 'Logo')}">` : ''}
      ${avatar}
      <h1 class="name" data-en="${attr(employee.name)}" data-ar="${attr(nameAr)}">${h(employee.name)}</h1>
      ${employee.jobTitle ? `<p class="role" data-en="${attr(employee.jobTitle)}" data-ar="${attr(jobTitleAr)}">${h(employee.jobTitle)}</p>` : ''}
      ${company?.companyName ? `<p class="org" data-en="${attr(company.companyName)}" data-ar="${attr(orgAr)}">${h(company.companyName)}</p>` : ''}
    </div>
    <div class="actions-section">
      <div class="rule"></div>
      <a class="save" href="${attr(vcardUrl)}">${iconSvg(ICON.save)} <span data-en="${attr(UI_STRINGS.en.save)}" data-ar="${attr(UI_STRINGS.ar.save)}">${h(UI_STRINGS.en.save)}</span></a>
      ${cardImageUrl ? `<a class="download" id="downloadCard" href="${attr(cardImageUrl)}?lang=en" download>${iconSvg(ICON.download)} <span data-en="${attr(UI_STRINGS.en.download)}" data-ar="${attr(UI_STRINGS.ar.download)}">${h(UI_STRINGS.en.download)}</span></a>` : ''}
      <div class="actions">${rows}</div>
      ${employee.bio ? `<p class="bio" data-en="${attr(employee.bio)}" data-ar="${attr(bioAr)}">${h(employee.bio)}</p>` : ''}
    </div>
  </div>
  <p class="foot" data-en="${attr(UI_STRINGS.en.footer)}" data-ar="${attr(UI_STRINGS.ar.footer)}">${h(UI_STRINGS.en.footer)}</p>
</main>
<script nonce="${attr(nonce)}">
(function(){
  var card=document.getElementById('card');
  var reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
  if(card&&!reduce&&matchMedia('(pointer:fine)').matches){
    document.body.addEventListener('pointermove',function(e){
      var r=card.getBoundingClientRect();var x=(e.clientX-r.left)/r.width-.5;var y=(e.clientY-r.top)/r.height-.5;
      card.style.transform='perspective(1200px) rotateY('+(x*6)+'deg) rotateX('+(-y*6)+'deg)';
      card.style.setProperty('--x', e.clientX - r.left + 'px');
      card.style.setProperty('--y', e.clientY - r.top + 'px');
    });
    document.body.addEventListener('pointerleave',function(){card.style.transform='';});
  }

  /* Click tracking. A RELATIVE url on purpose: the page may be reached on a LAN
     IP or a tunnel host that differs from the configured public base url, and a
     relative path always posts back to wherever the page actually came from.
     sendBeacon survives the page being unloaded by the outgoing tel:/https link;
     fetch(keepalive) is the fallback. Failure is silent — it must never get in
     the way of the tap. */
  var endpoint='/c/'+${JSON.stringify(String(token ?? ''))}+'/e';
  Array.prototype.forEach.call(document.querySelectorAll('[data-t]'),function(a){
    a.addEventListener('click',function(){
      var body=JSON.stringify({target:a.getAttribute('data-t')});
      try{
        if(navigator.sendBeacon){navigator.sendBeacon(endpoint,new Blob([body],{type:'application/json'}));}
        else{fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true});}
      }catch(e){}
    });
  });

  /* EN/AR toggle — every translatable element carries data-en/data-ar
     (Arabic already resolved server-side, never blank); this just swaps the
     visible text and flips the document's reading direction. Default stays
     English on every load, matching today's behaviour. */
  var langSwitch=document.getElementById('langToggle');
  var downloadLink=document.getElementById('downloadCard');
  var cardImageBase=${JSON.stringify(cardImageUrl || '')};
  function applyLang(lang){
    document.documentElement.lang=lang;
    document.documentElement.dir=lang==='ar'?'rtl':'ltr';
    Array.prototype.forEach.call(document.querySelectorAll('[data-en]'),function(el){
      el.textContent=lang==='ar'?(el.getAttribute('data-ar')||el.getAttribute('data-en')):el.getAttribute('data-en');
    });
    if(langSwitch)langSwitch.setAttribute('data-active',lang);
    // Keep the download link's language in sync with whatever is on screen —
    // downloading should always match what the visitor is currently looking at.
    if(downloadLink&&cardImageBase)downloadLink.href=cardImageBase+'?lang='+lang;
  }
  if(langSwitch){
    langSwitch.addEventListener('click',function(e){
      var btn=e.target.closest('[data-lang]');
      if(btn)applyLang(btn.getAttribute('data-lang'));
    });
  }
})();
</script>
</body></html>`;
}

/** Identical, information-free 404 for unknown / lost / disabled / unassigned. */
export function renderNotFoundPage() {
  const vars = palette('#1f9e78');
  const styleVars = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Not found</title>
<style>${STYLE}</style></head>
<body style="${styleVars}">
<div class="glow"></div>
<div class="saudi-art"></div>
<div class="noise"></div>
<main class="card" style="text-align:center;padding:56px 26px;animation:none">
  <div style="font-size:48px;margin-bottom:12px;filter:drop-shadow(0 0 10px rgba(255,255,255,0.2))">🔗</div>
  <h1 class="name" style="font-size:24px">This card isn't available</h1>
  <p class="role" style="color:var(--muted);margin-top:12px">The link may be inactive or no longer exists.</p>
</main></body></html>`;
}
