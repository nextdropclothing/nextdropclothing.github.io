// NEXTDROP static site builder.
// Reads /content (edited through /admin), optimises images and writes the website to /dist.
// Run: npm run build
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { marked } from 'marked';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'dist');
const warnings = [];
const warn = m => { warnings.push(m); };

/* ------------------------------------------------------------------ */
/* Load content                                                        */
/* ------------------------------------------------------------------ */
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const S = readJSON(path.join(ROOT, 'content/settings.json'));

export const CATEGORIES = [
  { slug: 'mens-clothing', name: "Men’s Clothing", short: 'Men', blurb: 'Hoodies, tees, trousers and everyday menswear.' },
  { slug: 'trainers-footwear', name: 'Trainers & Footwear', short: 'Footwear', blurb: 'Trainers and footwear for every day.' },
  { slug: 'womens-clothing', name: "Women’s Clothing", short: 'Women', blurb: 'Dresses, tops, outerwear and everyday womenswear.' },
  { slug: 'watches-jewellery', name: 'Watches & Jewellery', short: 'Watches & Jewellery', blurb: 'Watches, chains and finishing pieces.' },
  { slug: 'matching-sets', name: 'Matching Sets & Outfits', short: 'Sets', blurb: 'Co-ords, tracksuits and complete outfits.' },
  { slug: 'accessories', name: 'Accessories', short: 'Accessories', blurb: 'Bags, hats and the details that finish a look.' },
  { slug: 'offers', name: 'Offers & Special Deals', short: 'Offers', blurb: 'Current offers on selected pieces.', rule: p => p.offer },
  { slug: 'new-drops', name: 'New Drops', short: 'New Drops', blurb: 'The latest pieces to land at NEXTDROP.', rule: p => p.new_arrival },
];
const catBySlug = Object.fromEntries(CATEGORIES.map(c => [c.slug, c]));

const AVAIL = {
  confirm: { label: 'Availability confirmed when you order', cls: 'confirm' },
  available: { label: 'Available to order', cls: 'available' },
  limited: { label: 'Limited availability', cls: 'confirm' },
  sold_out: { label: 'Sold out', cls: 'sold_out' },
};

const productsDir = path.join(ROOT, 'content/products');
const allProducts = fs.readdirSync(productsDir)
  .filter(f => f.endsWith('.json') && !f.startsWith('_')).map(f => {
  try { return { ...readJSON(path.join(productsDir, f)), _file: f }; }
  catch (e) { warn(`Could not read content/products/${f}: ${e.message}`); return null; }
}).filter(Boolean);

const seen = new Set();
const products = allProducts.filter(p => {
  if (p.hidden) return false;
  if (!p.ref || !p.name) { warn(`${p._file}: missing product reference or name — skipped.`); return false; }
  p.ref = String(p.ref).trim().toUpperCase();
  p.slug = p.ref.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (seen.has(p.slug)) { warn(`${p._file}: duplicate product reference ${p.ref} — skipped.`); return false; }
  seen.add(p.slug);
  p.price = Number(p.price);
  if (!Number.isFinite(p.price) || p.price < 0) { warn(`${p.ref}: price missing or invalid — skipped.`); return false; }
  p.was_price = p.was_price ? Number(p.was_price) : null;
  if (p.was_price && p.was_price <= p.price) p.was_price = null;
  p.images = (p.images || []).map(i => typeof i === 'string' ? i : i?.image).filter(Boolean);
  p.categories = (p.categories || []).filter(c => catBySlug[c] && !catBySlug[c].rule);
  p.sizes = (Array.isArray(p.sizes) ? p.sizes : String(p.sizes || '').split(',')).flatMap(s => String(s).split(',')).map(s => s.trim()).filter(Boolean);
  p.colours = (p.colours || []).map(c => typeof c === 'string' ? { name: c } : c).filter(c => c?.name);
  p.details = (p.details || []).filter(Boolean);
  p.availability = AVAIL[p.availability] ? p.availability : 'confirm';
  p.time = Date.parse(p.date) || 0;
  return true;
}).sort((a, b) => b.time - a.time || a.ref.localeCompare(b.ref));

const inCategory = (p, c) => c.rule ? c.rule(p) : p.categories.includes(c.slug);
const pages = Object.fromEntries(fs.readdirSync(path.join(ROOT, 'content/pages')).filter(f => f.endsWith('.json'))
  .map(f => [f.replace('.json', ''), readJSON(path.join(ROOT, 'content/pages', f))]));

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
let WA = String(S.whatsapp_number || '').replace(/\D/g, '');
if (WA.startsWith('0')) WA = '44' + WA.slice(1);
if (!WA) warn('WhatsApp number is not set (Admin → Site settings).');
const TG = String(S.telegram_url || '').trim();
if (!TG) warn('Telegram link is not set, so Telegram buttons are hidden (Admin → Site settings).');
else if (!/^(https:\/\/t\.me\/|tg:\/\/)/.test(TG)) warn(`Telegram link "${TG}" does not start with https://t.me/ — check it.`);
const SITE = String(S.site_url || process.env.URL || '').replace(/\/$/, '');
if (!SITE) warn('Site address unknown — share previews need it. Set "Website address" in Admin → Site settings, or build on Netlify.');
const FEE = Number(S.delivery_fee ?? 5);
const feeText = `£${Number.isInteger(FEE) ? FEE : FEE.toFixed(2)}`;
const hasDemo = products.some(p => p.demo);
const PAGES = process.env.TARGET === 'pages'; // GitHub Pages hosting
const UNLISTED = S.unlisted !== false; // keep out of Google; shared by link only

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
const abs = u => (/^https?:/.test(u) ? u : SITE + u);
const md = src => {
  let n = 0;
  const html = marked.parse(String(src || '').replace(/\[\[TO COMPLETE:?\s*([^\]]*)\]\]/g, (_, t) => { n++; return `<mark class="todo">To complete: ${esc(t)}</mark>`; }));
  return { html, todos: n };
};
const hashOf = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
function writeFile(rel, content) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */
const imgCache = new Map();
const WIDTHS = [400, 700, 1100];
async function productImage(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const file = path.join(ROOT, 'static', decodeURIComponent(src.replace(/^\//, '')));
  if (!fs.existsSync(file)) { warn(`Image not found: ${src}`); imgCache.set(src, null); return null; }
  const buf = fs.readFileSync(file);
  const h = hashOf(buf);
  const out = { srcset: [], src: '', og: '' };
  try {
    for (const w of WIDTHS) {
      const rel = `/img/${h}-${w}.webp`;
      if (!fs.existsSync(path.join(OUT, rel))) {
        writeFile(rel, await sharp(buf).rotate().resize({ width: w, height: Math.round(w * 1.25), fit: 'cover', position: 'attention' }).webp({ quality: 78 }).toBuffer());
      }
      out.srcset.push(`${rel} ${w}w`);
    }
    out.src = `/img/${h}-700.webp`;
    out.og = `/img/${h}-og.jpg`;
    writeFile(out.og, await sharp(buf).rotate().resize({ width: 1200, height: 630, fit: 'contain', background: '#efeeeb' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
  } catch (e) { warn(`Could not process image ${src}: ${e.message}`); imgCache.set(src, null); return null; }
  imgCache.set(src, out);
  return out;
}
async function heroImage(src) {
  const file = path.join(ROOT, 'static', String(src || '').replace(/^\//, ''));
  if (!src || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file); const h = hashOf(buf); const set = [];
  for (const w of [800, 1400, 2200]) {
    const rel = `/img/hero-${h}-${w}.webp`;
    writeFile(rel, await sharp(buf).rotate().resize({ width: w, withoutEnlargement: false }).webp({ quality: 74 }).toBuffer());
    set.push(`${rel} ${w}w`);
  }
  return { srcset: set.join(', '), src: `/img/hero-${h}-1400.webp` };
}
const pic = (img, alt, { sizes = '(min-width:1180px) 25vw, (min-width:760px) 33vw, 50vw', cls = '', eager = false } = {}) =>
  img ? `<img ${cls ? `class="${cls}" ` : ''}src="${img.src}" srcset="${img.srcset.join(', ')}" sizes="${sizes}" alt="${esc(alt)}" width="700" height="875" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`
    : `<img ${cls ? `class="${cls}" ` : ''}src="/brand/monogram.png" alt="${esc(alt)}" width="400" height="400" loading="lazy">`;

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */
const I = {
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7h18M3 12h18M3 17h18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  wa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.5-.3z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.3l-3.2 15.1c-.2 1-.9 1.3-1.7.8l-4.8-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.6 13.2l-4.7-1.5c-1-.3-1-1 .2-1.5l18.4-7.1c.9-.3 1.6.2 1.4 1.2z"/></svg>',
  ig: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/* ------------------------------------------------------------------ */
/* Shared layout                                                       */
/* ------------------------------------------------------------------ */
let CSS_URL, JS_URL;
const waLink = msg => `https://wa.me/${WA}?text=${encodeURIComponent(msg)}`;
const GENERAL_MSG = `Hi NEXTDROP, I'd like to place an order.\n\nProduct reference:\nProduct name:\nSize:\nColour:\nFull Name:\nDelivery Address:\n\nPlease confirm availability, total price and delivery.`;
const ENQUIRY_MSG = `Hi NEXTDROP, I have a question.`;

const contactButtons = ({ msg = ENQUIRY_MSG, light = false, wa = 'MESSAGE ON WHATSAPP' } = {}) => `
  ${WA ? `<a class="btn btn--wa btn--block" href="${waLink(msg)}" target="_blank" rel="noopener">${I.wa}${wa}</a>` : ''}
  ${TG ? `<a class="btn ${light ? 'btn--ghost-light' : 'btn--ghost'} btn--block" href="${esc(TG)}" target="_blank" rel="noopener">${I.tg}MESSAGE ON TELEGRAM</a>` : ''}`;

function layout({ title, description, pathName, body, og = {}, jsonld = null, current = '' }) {
  const fullTitle = title ? `${title} | NEXTDROP` : `NEXTDROP — ${S.tagline || 'Your next favourite find.'}`;
  const url = SITE + pathName;
  const ogImg = og.image ? abs(og.image) : abs('/brand/og-default.jpg');
  const navLink = c => `<a href="/shop/${c.slug}/"${current === c.slug ? ' aria-current="page"' : ''}${c.slug === 'offers' ? ' class="is-offer"' : ''}>${esc(c.short)}</a>`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
${SITE ? `<link rel="canonical" href="${esc(url)}">` : ''}
<meta name="theme-color" content="#0a0a0a">
${UNLISTED ? '<meta name="robots" content="noindex, nofollow">' : ''}
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta property="og:site_name" content="NEXTDROP">
<meta property="og:type" content="${og.type || 'website'}">
<meta property="og:title" content="${esc(og.title || fullTitle)}">
<meta property="og:description" content="${esc(description)}">
${SITE ? `<meta property="og:url" content="${esc(url)}">` : ''}
<meta property="og:image" content="${esc(ogImg)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(og.title || 'NEXTDROP')}">
<meta property="og:locale" content="en_GB">
${og.price ? `<meta property="product:price:amount" content="${og.price}">\n<meta property="product:price:currency" content="GBP">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(og.title || fullTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImg)}">
<link rel="preload" href="/fonts/Poppins-Bold.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/fonts/Inter-Regular.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="${CSS_URL}">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${S.announcement ? `<div class="announce">${esc(S.announcement)}</div>` : ''}
${hasDemo && S.show_demo_banner !== false ? `<div class="demo-bar"><strong>Preview:</strong> items marked DEMO are sample products for layout only and are not for sale.</div>` : ''}
<header class="site-header">
  <div class="wrap header-row">
    <div class="header-left"><button class="icon-btn menu-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="drawer">${I.menu}</button></div>
    <a class="wordmark" href="/" aria-label="NEXTDROP home"><b>NEXT</b><span>DROP</span></a>
    <nav class="main-nav" aria-label="Categories">${CATEGORIES.map(navLink).join('')}</nav>
    <div class="header-right">
      <a class="icon-btn" href="/shop/#search" aria-label="Search products">${I.search}</a>
      ${WA ? `<a class="icon-btn" href="${waLink(ENQUIRY_MSG)}" target="_blank" rel="noopener" aria-label="Message NEXTDROP on WhatsApp">${I.wa}</a>` : ''}
    </div>
  </div>
</header>
<div class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer__scrim" data-close-drawer></div>
  <div class="drawer__panel" role="dialog" aria-modal="true" aria-label="Menu">
    <div class="drawer__head"><a class="wordmark" href="/"><b>NEXT</b><span>DROP</span></a><button class="icon-btn drawer__close" type="button" aria-label="Close menu" data-close-drawer>${I.close}</button></div>
    <nav aria-label="Menu">
      <a href="/shop/">Shop all <span>${products.length}</span></a>
      ${CATEGORIES.map(c => `<a href="/shop/${c.slug}/">${esc(c.name)} <span>${products.filter(p => inCategory(p, c)).length}</span></a>`).join('')}
      <a href="/how-to-order/">How to order</a>
      <a href="/delivery/">Delivery</a>
      <a href="/contact/">Contact</a>
    </nav>
    <div class="drawer__foot">${contactButtons({ light: true })}</div>
  </div>
</div>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <div class="footer-brand"><img src="/brand/nextdrop-logo.jpg" alt="NEXTDROP logo" width="72" height="72" loading="lazy"><div><a class="wordmark" href="/"><b>NEXT</b><span>DROP</span></a><p>${esc(S.tagline)}</p></div></div>
        <p style="margin:20px 0 0;max-width:36ch">Browse the catalogue, then message us on WhatsApp or Telegram to order. Delivery: ${feeText} per order.</p>
        <div class="footer-contact">${contactButtons({ light: true })}
          ${S.instagram_url ? `<a class="btn btn--ghost-light btn--block" href="${esc(S.instagram_url)}" target="_blank" rel="noopener">${I.ig}FOLLOW ON INSTAGRAM</a>` : ''}
        </div>
      </div>
      <div><h2>Shop</h2><ul><li><a href="/shop/">Shop all</a></li>${CATEGORIES.map(c => `<li><a href="/shop/${c.slug}/">${esc(c.name)}</a></li>`).join('')}</ul></div>
      <div><h2>Help</h2><ul><li><a href="/how-to-order/">How to order</a></li><li><a href="/delivery/">Delivery</a></li><li><a href="/returns/">Returns &amp; refunds</a></li><li><a href="/contact/">Contact</a></li></ul></div>
      <div><h2>Policies</h2><ul><li><a href="/terms/">Terms of sale</a></li><li><a href="/privacy/">Privacy policy</a></li></ul></div>
    </div>
    <div class="footer-base"><span>© ${new Date().getFullYear()} NEXTDROP. All prices in GBP.</span><span>Orders are confirmed by message. Clicking an order button does not reserve an item.</span></div>
  </div>
</footer>
<script src="${JS_URL}" defer></script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */
function sizeSummary(sizes) {
  if (!sizes.length) return '';
  return sizes.length > 5 ? `${sizes[0]} – ${sizes[sizes.length - 1]}` : sizes.join(', ');
}
function badges(p) {
  const b = [];
  if (p.demo) b.push('<span class="badge badge--demo">Demo</span>');
  if (p.availability === 'sold_out') b.push('<span class="badge badge--out">Sold out</span>');
  else {
    if (p.new_arrival) b.push('<span class="badge badge--dark">New</span>');
    if (p.offer) b.push('<span class="badge badge--silver">Offer</span>');
  }
  return b.length ? `<div class="badges">${b.join('')}</div>` : '';
}
function priceHTML(p) {
  return `<span class="price">${money(p.price)}</span>${p.offer && p.was_price ? `<span class="was"><span class="sr-only">was </span>${money(p.was_price)}</span>` : ''}`;
}
function card(p, idx = 0, opts = {}) {
  const [a, b] = p._img;
  const url = `/product/${p.slug}/`;
  const search = [p.ref, p.name, p.description, ...p.sizes, ...p.colours.map(c => c.name), ...p.categories.map(c => catBySlug[c].name), p.offer ? 'offer deal sale' : '', p.new_arrival ? 'new drop' : '']
    .join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return `<article class="card" data-idx="${idx}" data-price="${p.price}" data-search="${esc(search)}">
  <a class="card__media" href="${url}" tabindex="-1" aria-hidden="true">${badges(p)}${pic(a, p.name, opts)}${b ? pic(b, '', { ...opts, cls: 'alt' }) : ''}</a>
  <div class="card__body">
    <span class="ref">${esc(p.ref)}</span>
    <h3 class="card__name"><a href="${url}">${esc(p.name)}</a></h3>
    <div>${priceHTML(p)}</div>
    ${p.sizes.length ? `<div class="card__meta">Sizes: ${esc(sizeSummary(p.sizes))}</div>` : ''}
    ${p.colours.length ? `<div class="card__meta swatches">${p.colours.slice(0, 5).map(c => `<span class="swatch" style="background:${esc(c.hex || '#ccc')}" title="${esc(c.name)}"></span>`).join('')}<span>${p.colours.length === 1 ? esc(p.colours[0].name) : `${p.colours.length} colours`}</span></div>` : ''}
    <a class="btn btn--ghost btn--block" href="${url}">View product</a>
  </div>
</article>`;
}
const stepsHTML = `<ol class="steps">
  <li><strong>Browse</strong><span>Browse the catalogue and select your favourite product.</span></li>
  <li><strong>Choose</strong><span>Open the product page and choose your size and colour.</span></li>
  <li><strong>Message us</strong><span>Click WhatsApp or Telegram to contact NEXTDROP.</span></li>
  <li><strong>Send details</strong><span>Send your product reference and order details.</span></li>
  <li><strong>We confirm</strong><span>Wait for NEXTDROP to confirm the price, availability, delivery details and next steps.</span></li>
</ol>`;

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */
function catalogue({ cat = null }) {
  const list = cat ? products.filter(p => inCategory(p, cat)) : products;
  const title = cat ? cat.name : 'Shop all';
  const chips = [`<a class="chip" href="/shop/"${!cat ? ' aria-current="page"' : ''}>All</a>`, ...CATEGORIES.map(c => `<a class="chip" href="/shop/${c.slug}/"${cat?.slug === c.slug ? ' aria-current="page"' : ''}>${esc(c.name)}</a>`)].join('');
  const emptyCategory = `<div class="empty">
      <h2>${cat?.slug === 'offers' ? 'No offers right now' : 'Nothing here yet'}</h2>
      <p>${cat?.slug === 'offers' ? 'There are no current offers. Check back soon, or browse the full collection.' : `New pieces for ${esc(cat?.name || 'this category')} are on the way. Browse the full collection, or message us to ask what’s coming.`}</p>
      <div class="row"><a class="btn" href="/shop/">Browse collection</a>${WA ? `<a class="btn btn--ghost" href="${waLink(`Hi NEXTDROP, do you have anything coming in ${cat?.name || ''}?`)}" target="_blank" rel="noopener">Ask on WhatsApp</a>` : ''}</div>
    </div>`;
  const body = `
<section class="wrap" data-catalogue>
  <div class="page-head">
    <div class="crumbs"><a href="/">Home</a> / ${cat ? `<a href="/shop/">Shop</a> / ${esc(cat.name)}` : 'Shop'}</div>
    <h1 class="h-display">${esc(title)}</h1>
    <p>${esc(cat ? cat.blurb : 'Browse every piece in the NEXTDROP collection. Prices in GBP — order by WhatsApp or Telegram.')}</p>
    <nav class="chips" aria-label="Categories">${chips}</nav>
  </div>
  ${list.length ? `
  <div class="toolbar" id="search">
    <label class="search"><span class="sr-only">Search products</span>${I.search}<input id="q" type="search" placeholder="Search products or ref" autocomplete="off" enterkeyhint="search"><button class="clear" type="button" aria-label="Clear search">${I.close}</button></label>
    <label class="sort"><span class="sr-only">Sort products</span><select id="sort"><option value="newest">Newest</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></label>
  </div>
  <p class="result-count" aria-live="polite">${list.length} products</p>
  <div class="grid">${list.map((p, i) => card(p, i)).join('')}</div>
  <div class="empty" data-no-results hidden>
    <h2>No matches</h2><p>We couldn’t find a product matching your search${cat ? ` in ${esc(cat.name)}` : ''}. Try a different word or a product reference such as ND001.</p>
    <div class="row"><button class="btn" type="button" data-clear-search>Clear search</button>${cat ? '<a class="btn btn--ghost" href="/shop/">Search all products</a>' : ''}</div>
  </div>` : `<div style="padding:32px 0 72px">${emptyCategory}</div>`}
  <div style="height:72px"></div>
</section>`;
  return layout({
    title, pathName: cat ? `/shop/${cat.slug}/` : '/shop/', current: cat?.slug,
    description: cat ? `${cat.name} at NEXTDROP. ${cat.blurb} Order by WhatsApp or Telegram. Delivery ${feeText} per order.` : `Browse the NEXTDROP collection: clothing, trainers, watches, jewellery and accessories. Order by WhatsApp or Telegram.`,
    body, og: { image: list[0]?._img[0]?.og },
  });
}

async function home(hero) {
  const featured = (S.featured || []).map(f => products.find(p => p.ref === String(f.product || f).toUpperCase())).filter(Boolean);
  const newArrivals = products.filter(p => p.new_arrival).slice(0, 10);
  const offers = products.filter(p => p.offer).slice(0, 4);
  const tiles = CATEGORIES.map(c => {
    const list = products.filter(p => inCategory(p, c));
    const img = list[0]?._img[0];
    return `<a class="cat-tile${img ? '' : ' cat-tile--empty'}" href="/shop/${c.slug}/">${img ? pic(img, '', { sizes: '(min-width:760px) 25vw, 50vw' }) : '<img src="/brand/monogram.png" alt="" width="400" height="400" loading="lazy">'}
      <span class="cat-tile__label"><strong>${esc(c.name)}</strong><span>${list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : 'Coming soon'}</span></span></a>`;
  }).join('');
  const body = `
<section class="hero on-dark">
  ${hero ? `<img class="hero__bg" src="${hero.src}" srcset="${hero.srcset}" sizes="100vw" alt="" fetchpriority="high">` : ''}
  <img class="hero__mark" src="/brand/monogram.png" alt="" width="400" height="400">
  <div class="wrap hero__inner fade-in">
    <span class="eyebrow">NEXTDROP — ${esc(S.tagline)}</span>
    <h1 class="h-display">${esc(S.hero_headline || 'FIND YOUR NEXT FAVOURITE.')}</h1>
    <p>${esc(S.hero_text || '')}</p>
    <div class="hero__ctas"><a class="btn btn--light" href="/shop/">Browse collection ${I.arrow}</a><a class="btn btn--ghost-light" href="/shop/new-drops/">New drops</a></div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <div class="section__head"><div><span class="eyebrow">Shop by category</span><h2 class="h-section">Clothing, footwear &amp; more</h2></div><a class="link" href="/shop/">Shop all</a></div>
    <div class="cat-grid">${tiles}</div>
  </div>
</section>

${newArrivals.length ? `<section class="section section--tint">
  <div class="wrap">
    <div class="section__head"><div><span class="eyebrow">Just landed</span><h2 class="h-section">New arrivals</h2></div><a class="link" href="/shop/new-drops/">View all</a></div>
    <div class="rail">${newArrivals.map((p, i) => card(p, i, { sizes: '(min-width:1180px) 22vw, (min-width:760px) 30vw, 62vw' })).join('')}</div>
  </div>
</section>` : ''}

${featured.length ? `<section class="section">
  <div class="wrap">
    <div class="section__head"><div><span class="eyebrow">Selected by NEXTDROP</span><h2 class="h-section">Featured</h2></div><a class="link" href="/shop/">Shop all</a></div>
    <div class="grid">${featured.map((p, i) => card(p, i)).join('')}</div>
  </div>
</section>` : ''}

${offers.length ? `<section class="section" style="padding-top:0">
  <div class="wrap">
    <div class="offer-band">
      <div><span class="eyebrow" style="color:var(--silver)">Offers &amp; special deals</span><h2 class="h-section" style="margin:10px 0 14px">Current offers</h2><p style="color:#a7a8ac;margin:0 0 22px">Selected pieces with a reduced price, while they last. Final price is confirmed when you order.</p><a class="btn btn--light" href="/shop/offers/">Shop offers</a></div>
      <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">${offers.slice(0, 2).map((p, i) => card(p, i, { sizes: '(min-width:900px) 22vw, 50vw' }).replace('btn btn--ghost', 'btn btn--ghost-light').replace('class="card"', 'class="card" style="color:#fff"')).join('')}</div>
    </div>
  </div>
</section>` : ''}

<section class="section section--dark">
  <div class="wrap">
    <div class="section__head"><div><span class="eyebrow" style="color:var(--silver)">Simple ordering</span><h2 class="h-section">How to order</h2><p>No checkout, no account. Just message us.</p></div><a class="link" href="/how-to-order/" style="color:#fff">Full guide</a></div>
    ${stepsHTML}
    <p style="margin:24px 0 0;color:#a7a8ac;font-size:14px"><strong style="color:#fff">Delivery: ${feeText} per order.</strong> Your final total is confirmed by message before your order is accepted.</p>
  </div>
</section>`;
  return layout({
    pathName: '/', body,
    description: `${S.tagline} Discover the latest styles, standout pieces and everyday essentials from NEXTDROP. Browse the catalogue and order on WhatsApp or Telegram.`,
  });
}

function productPage(p) {
  const url = `/product/${p.slug}/`;
  const imgs = p._img.filter(Boolean);
  const soldOut = p.availability === 'sold_out';
  const av = AVAIL[p.availability];
  const desc = md(p.description);
  const firstColour = p.colours.length === 1 ? p.colours[0].name : '';
  const firstSize = p.sizes.length === 1 ? p.sizes[0] : '';
  const defaultMsg = soldOut
    ? `Hi NEXTDROP, I'm interested in ${p.ref} — ${p.name}, which is showing as sold out.\n\nPlease let me know if it will be available again.`
    : [`Hi NEXTDROP, I'd like to order ${p.ref} — ${p.name}.`, '', ...(p.sizes.length ? [`Size: ${firstSize}`] : []), ...(p.colours.length ? [`Colour: ${firstColour}`] : []), 'Full Name:', 'Delivery Address:', '', 'Please confirm availability, total price and delivery.'].join('\n');
  const related = products.filter(o => o !== p && o.categories.some(c => p.categories.includes(c))).slice(0, 4);
  const plain = String(p.description || '').replace(/[#*_>\[\]()`]/g, '').replace(/\s+/g, ' ').trim();
  const metaDesc = `${p.name} (${p.ref}) — ${money(p.price)}. ${plain}`.slice(0, 200);
  const waLabel = soldOut ? 'ASK ABOUT RESTOCK' : 'ORDER ON WHATSAPP';

  const body = `
<div class="wrap">
  <div class="crumbs" style="padding-top:18px"><a href="/">Home</a> / <a href="/shop/">Shop</a>${p.categories[0] ? ` / <a href="/shop/${p.categories[0]}/">${esc(catBySlug[p.categories[0]].name)}</a>` : ''}</div>
  <div class="pdp">
    <div class="gallery">
      <div class="gallery__track${imgs.length < 2 ? ' single' : ''}">
        ${(imgs.length ? imgs : [null]).map((im, i) => `<figure>${pic(im, `${p.name}${imgs.length > 1 ? ` — image ${i + 1} of ${imgs.length}` : ''}`, { sizes: '(min-width:960px) 55vw, 100vw', eager: i === 0 })}</figure>`).join('')}
      </div>
      ${imgs.length > 1 ? `<div class="dots">${imgs.map((_, i) => `<button type="button" aria-label="Show image ${i + 1}" aria-current="${i === 0}"></button>`).join('')}</div>` : ''}
    </div>
    <div class="info">
      <div>
        <span class="ref">REF ${esc(p.ref)}</span>
        <h1>${esc(p.name)}</h1>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="price-row">${priceHTML(p).replace('class="price"', 'class="price" style="font-size:22px"')}</div>
        <span class="status status--${av.cls}">${esc(av.label)}</span>
      </div>
      ${p.demo ? '<div class="demo-note"><strong>Demo product.</strong> This item is sample content for previewing the site and is not for sale.</div>' : ''}
      ${(p.sizes.length || p.colours.length) ? `<form id="options" onsubmit="return false">
        ${p.colours.length ? `<fieldset style="margin-bottom:20px"><legend>Colour <output id="colour-out">${firstColour ? esc(firstColour) : 'Select a colour'}</output></legend><div class="opts">
          ${p.colours.map(c => `<label class="opt"><input type="radio" name="colour" value="${esc(c.name)}"${firstColour ? ' checked' : ''}><span>${c.hex ? `<i class="swatch" style="background:${esc(c.hex)}"></i>` : ''}${esc(c.name)}</span></label>`).join('')}
        </div></fieldset>` : ''}
        ${p.sizes.length ? `<fieldset><legend>Size <output id="size-out">${firstSize ? esc(firstSize) : 'Select a size'}</output></legend><div class="opts">
          ${p.sizes.map(s => `<label class="opt"><input type="radio" name="size" value="${esc(s)}"${firstSize ? ' checked' : ''}><span>${esc(s)}</span></label>`).join('')}
        </div></fieldset>` : ''}
      </form>` : ''}
      <div class="order-box">
        ${WA ? `<a class="btn btn--wa btn--block" data-wa href="${waLink(defaultMsg)}" target="_blank" rel="noopener">${I.wa}${waLabel}</a>` : ''}
        ${TG ? `<a class="btn btn--block" data-tg href="${esc(TG)}" target="_blank" rel="noopener">${I.tg}MESSAGE ON TELEGRAM</a>` : ''}
        <p class="order-note" id="select-hint" hidden></p>
        <p class="order-note">Orders are confirmed manually by message. Clicking a button opens a chat — it does not confirm availability or reserve the item. <strong>Delivery: ${feeText} per order.</strong></p>
      </div>
      <div class="accordion">
        <details open><summary>Description</summary><div class="content">${desc.html}${p.details.length ? `<ul>${p.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div></details>
        <details><summary>Delivery</summary><div class="content"><p class="mt-0"><strong>Delivery: ${feeText} per order.</strong></p><p>Delivery charges and your final order total are confirmed by message before your order is accepted. Delivery times are confirmed for your specific order.</p><p><a href="/delivery/">Delivery policy</a> · <a href="/returns/">Returns &amp; refunds</a></p></div></details>
        <details><summary>Order details to send</summary><div class="content">
          <p class="mt-0">${TG ? 'If you order on Telegram, tapping the button copies this message for you — just paste it into the chat.' : 'Send these details when you message us.'}</p>
          <div class="copy-box"><pre id="order-message">${esc(defaultMsg)}</pre><button type="button" class="link" id="copy-order">Copy order details</button></div>
        </div></details>
      </div>
    </div>
  </div>
  ${related.length ? `<section class="section" style="padding-top:24px;border-top:1px solid var(--grey-200)">
    <div class="section__head"><h2 class="h-section">You may also like</h2><a class="link" href="/shop/${p.categories[0]}/">View all</a></div>
    <div class="grid">${related.map((r, i) => card(r, i)).join('')}</div>
  </section>` : '<div style="height:48px"></div>'}
</div>
${WA ? `<div class="sticky-order" aria-hidden="false"><div class="meta"><strong>${esc(p.name)}</strong>${priceHTML(p)}</div><a class="btn btn--wa" data-wa href="${waLink(defaultMsg)}" target="_blank" rel="noopener">${I.wa}${soldOut ? 'ASK' : 'ORDER'}</a></div>` : ''}
<script type="application/json" id="product-data">${JSON.stringify({ ref: p.ref, name: p.name, wa: WA, hasSizes: p.sizes.length > 0, hasColours: p.colours.length > 0, soldOut }).replace(/</g, '\\u003c')}</script>`;

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: p.ref, description: plain,
    image: imgs.map(i => abs(i.src)), url: SITE + url,
    offers: { '@type': 'Offer', priceCurrency: 'GBP', price: p.price.toFixed(2), url: SITE + url,
      ...(p.availability === 'available' ? { availability: 'https://schema.org/InStock' } : p.availability === 'sold_out' ? { availability: 'https://schema.org/OutOfStock' } : {}) },
  };
  return layout({ title: `${p.name} (${p.ref})`, description: metaDesc, pathName: url, body, og: { type: 'product', title: `${p.name} — ${money(p.price)} | NEXTDROP`, image: imgs[0]?.og, price: p.price.toFixed(2) }, jsonld });
}

function howToOrder() {
  const body = `
<div class="wrap">
  <div class="page-head" style="border:0"><div class="crumbs"><a href="/">Home</a> / How to order</div><h1 class="h-display">How to place an order</h1><p>No checkout or account needed. Choose your piece, then message us to order.</p></div>
</div>
<section class="section--light-steps"><div class="wrap">${stepsHTML}</div></section>
<div class="wrap prose" style="padding-top:40px">
  <h2>Order details to send</h2>
  <p>Please include all of the following in your message:</p>
  <ul class="req-list"><li>Product reference</li><li>Product name</li><li>Size</li><li>Colour</li><li>Full name</li><li>Delivery address</li></ul>
  <div class="callout"><strong class="deliv">Delivery: ${feeText} per order.</strong>Delivery charges and your final order total are confirmed by message before your order is accepted. There is no online checkout, so nothing is charged on this website.</div>
  <div class="callout"><strong>Orders are confirmed manually</strong>Clicking WhatsApp or Telegram opens a chat with us. It does not itself confirm availability or reserve an item. Your order is only confirmed when NEXTDROP replies to confirm the price, availability, delivery details and next steps.</div>
  <h2>Delivery times</h2>
  <p>Delivery times vary by product. We will tell you the expected delivery time for your specific order when we confirm it.</p>
  <h2>Ready to order?</h2>
  <p>The easiest way is to open a product and tap <strong>Order on WhatsApp</strong> — your product reference and name are filled in for you. Or message us directly:</p>
  <div style="display:grid;gap:10px;max-width:420px">${contactButtons({ msg: GENERAL_MSG, wa: 'ORDER ON WHATSAPP' })}</div>
  ${TG ? `<p style="margin-top:20px">On Telegram, copy and send this template:</p><div class="copy-box"><pre>${esc(GENERAL_MSG)}</pre><button class="link" type="button" data-copy="${esc(GENERAL_MSG)}">Copy template</button></div>` : ''}
  <p style="margin-top:32px"><a class="btn btn--ghost" href="/shop/">Browse the collection</a></p>
</div>`;
  return layout({ title: 'How to Order', pathName: '/how-to-order/', body, description: `How to order from NEXTDROP: browse the catalogue, then message us on WhatsApp or Telegram with your product reference. Delivery ${feeText} per order.` });
}

function policyPage(key) {
  const pg = pages[key];
  if (!pg) { warn(`Missing page content/pages/${key}.json`); return null; }
  const r = md(pg.body);
  if (r.todos) warn(`Page "${pg.title}" has ${r.todos} section(s) marked TO COMPLETE.`);
  const extra = key === 'contact' ? `<div style="display:grid;gap:10px;max-width:420px;margin-top:28px">${contactButtons()}${S.instagram_url ? `<a class="btn btn--ghost btn--block" href="${esc(S.instagram_url)}" target="_blank" rel="noopener">${I.ig}INSTAGRAM</a>` : ''}${S.contact_email ? `<a class="btn btn--ghost btn--block" href="mailto:${esc(S.contact_email)}">EMAIL ${esc(S.contact_email)}</a>` : ''}</div>` : '';
  const body = `<div class="wrap"><div class="page-head" style="border:0"><div class="crumbs"><a href="/">Home</a> / ${esc(pg.title)}</div><h1 class="h-display">${esc(pg.title)}</h1></div><div class="prose">${r.html}${extra}</div></div>`;
  const plain = pg.body.replace(/\[\[[^\]]*\]\]/g, '').replace(/[#*_>\[\]()`-]/g, '').replace(/\s+/g, ' ').trim();
  return layout({ title: pg.title, pathName: `/${key}/`, body, description: plain.slice(0, 160) });
}

function notFound() {
  const body = `<div class="wrap" style="padding:72px var(--pad) 96px;text-align:center;display:grid;gap:18px;justify-items:center">
  <span class="eyebrow">Error 404</span><h1 class="h-display" style="font-size:clamp(34px,6vw,64px)">Page not found</h1>
  <p style="color:var(--grey-500);max-width:46ch;margin:0">This link may be out of date, or the product is no longer listed. Search the catalogue or browse the latest pieces.</p>
  <form action="/shop/" method="get" class="search" style="width:min(100%,440px)"><label><span class="sr-only">Search products</span>${I.search}<input name="q" type="search" placeholder="Search products or ref"></label></form>
  <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center"><a class="btn" href="/shop/">Browse collection</a><a class="btn btn--ghost" href="/">Home</a></div>
</div>`;
  return layout({ title: 'Page not found', pathName: '/404', body, description: 'Page not found.' });
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(ROOT, 'static'), OUT);

const css = fs.readFileSync(path.join(ROOT, 'src/styles.css'));
const js = fs.readFileSync(path.join(ROOT, 'src/app.js'));
CSS_URL = `/assets/styles.${hashOf(css)}.css`; JS_URL = `/assets/app.${hashOf(js)}.js`;
writeFile(CSS_URL, css); writeFile(JS_URL, js);

for (const p of products) {
  p._img = [];
  for (const src of p.images) p._img.push(await productImage(src));
  p._img = p._img.filter(Boolean);
  if (!p._img.length) { warn(`${p.ref} has no photos.`); p._img = [null]; }
}
const hero = await heroImage(S.hero_image);

writeFile('index.html', await home(hero));
writeFile('shop/index.html', catalogue({}));
for (const c of CATEGORIES) writeFile(`shop/${c.slug}/index.html`, catalogue({ cat: c }));
for (const p of products) writeFile(`product/${p.slug}/index.html`, productPage(p));
writeFile('how-to-order/index.html', howToOrder());
for (const k of ['delivery', 'returns', 'privacy', 'terms', 'contact']) { const h = policyPage(k); if (h) writeFile(`${k}/index.html`, h); }
writeFile('404.html', notFound());

// Short links: /nd001 and /ND001 → product page. Old / uppercase product URLs too.
const redirects = [
  '/admin  /admin/  301',
  ...products.flatMap(p => [`/${p.slug}  /product/${p.slug}/  301`, `/${p.ref}  /product/${p.slug}/  301`, `/product/${p.ref}  /product/${p.slug}/  301`, `/product/${p.ref}/  /product/${p.slug}/  301`]),
];
if (PAGES) {
  // GitHub Pages has no redirect rules: write tiny redirect pages instead.
  fs.rmSync(path.join(OUT, 'admin'), { recursive: true, force: true });
  for (const line of redirects) {
    const [from, to] = line.split(/\s+/);
    if (from === '/admin') continue;
    const dir = from.replace(/^\/|\/$/g, '');
    if (fs.existsSync(path.join(OUT, dir, 'index.html'))) continue;
    writeFile(`${dir}/index.html`, `<!doctype html><meta charset="utf-8"><title>NEXTDROP</title><meta name="robots" content="noindex"><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0;url=${to}"><script>location.replace(${JSON.stringify(to)})</script><a href="${to}">Continue</a>`);
  }
  writeFile('.nojekyll', '');
  if (S.custom_domain) writeFile('CNAME', String(S.custom_domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '') + '\n');
} else writeFile('_redirects', redirects.join('\n') + '\n');
writeFile('robots.txt', UNLISTED ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nDisallow: /admin/\n${SITE ? `Sitemap: ${SITE}/sitemap.xml\n` : ''}`);
if (SITE) {
  const urls = ['/', '/shop/', ...CATEGORIES.map(c => `/shop/${c.slug}/`), ...products.map(p => `/product/${p.slug}/`), '/how-to-order/', '/delivery/', '/returns/', '/privacy/', '/terms/', '/contact/'];
  writeFile('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}\n</urlset>\n`);
}
writeFile('site.webmanifest', JSON.stringify({ name: 'NEXTDROP', short_name: 'NEXTDROP', description: S.tagline, start_url: '/', display: 'standalone', background_color: '#0a0a0a', theme_color: '#0a0a0a', icons: [{ src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' }] }, null, 2));

console.log(`\nNEXTDROP built: ${products.length} products (${allProducts.length - products.length} hidden/skipped), ${CATEGORIES.length} categories → dist/`);
if (hasDemo) console.log(`⚠ ${products.filter(p => p.demo).length} DEMO products are still live. Delete or hide them before launch.`);
if (warnings.length) { console.log('\nThings to check:'); warnings.forEach(w => console.log('  • ' + w)); }
