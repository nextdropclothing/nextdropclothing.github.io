// NEXTDROP client script — small, dependency-free.
window.NDinit = () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- Toast ---------- */
  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('is-visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-visible'), 3200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }

  /* ---------- Drawer ---------- */
  const drawer = $('#drawer');
  if (drawer && !drawer.dataset.bound) {
    drawer.dataset.bound = '1';
    const open = () => { drawer.classList.add('is-open'); drawer.setAttribute('aria-hidden', 'false'); document.body.classList.add('no-scroll'); $('.menu-toggle')?.setAttribute('aria-expanded', 'true'); $('.drawer__close', drawer)?.focus(); };
    const close = () => { drawer.classList.remove('is-open'); drawer.setAttribute('aria-hidden', 'true'); document.body.classList.remove('no-scroll'); $('.menu-toggle')?.setAttribute('aria-expanded', 'false'); };
    $$('.menu-toggle').forEach(b => b.addEventListener('click', open));
    $$('[data-close-drawer]', drawer).forEach(b => b.addEventListener('click', close));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('is-open')) close(); });
  }

  /* ---------- Catalogue: search + sort ---------- */
  const cat = $('[data-catalogue]');
  if (cat) {
    const grid = $('.grid', cat);
    const cards = $$('.card', grid);
    const input = $('#q', cat);
    const sortSel = $('#sort', cat);
    const count = $('.result-count', cat);
    const empty = $('[data-no-results]', cat);
    const searchWrap = $('.search', cat);
    const params = new URLSearchParams(location.search);
    if (params.get('q')) input.value = params.get('q');
    if (params.get('sort') && [...sortSel.options].some(o => o.value === params.get('sort'))) sortSel.value = params.get('sort');

    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    function apply() {
      const q = norm(input.value.trim());
      const terms = q.split(/\s+/).filter(Boolean);
      let shown = 0;
      cards.forEach(c => {
        const hay = c.dataset.search;
        const ok = terms.every(t => hay.includes(t));
        c.hidden = !ok; if (ok) shown++;
      });
      const s = sortSel.value;
      const sorted = [...cards].sort((a, b) => {
        if (s === 'price-asc') return (+a.dataset.price - +b.dataset.price) || (+a.dataset.idx - +b.dataset.idx);
        if (s === 'price-desc') return (+b.dataset.price - +a.dataset.price) || (+a.dataset.idx - +b.dataset.idx);
        return +a.dataset.idx - +b.dataset.idx; // newest (server order)
      });
      sorted.forEach(c => grid.appendChild(c));
      count.textContent = `${shown} ${shown === 1 ? 'product' : 'products'}` + (q ? ` for “${input.value.trim()}”` : '');
      empty.hidden = shown !== 0;
      grid.hidden = shown === 0;
      searchWrap.classList.toggle('has-value', !!input.value);
      const p = new URLSearchParams(location.search);
      input.value ? p.set('q', input.value) : p.delete('q');
      sortSel.value !== 'newest' ? p.set('sort', sortSel.value) : p.delete('sort');
      const qs = p.toString();
      if (!window.ND_PREVIEW) history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
    if (cards.length) {
      input.addEventListener('input', apply);
      sortSel.addEventListener('change', apply);
      $('.clear', cat)?.addEventListener('click', () => { input.value = ''; apply(); input.focus(); });
      $$('[data-clear-search]', cat).forEach(b => b.addEventListener('click', () => { input.value = ''; apply(); input.focus(); }));
      apply();
      if (location.hash === '#search') setTimeout(() => input.focus(), 50);
    }
    // keep search query when switching category chips
    $$('.chip', cat).forEach(a => a.addEventListener('click', () => {
      if (input.value) { const u = new URL(a.href); u.searchParams.set('q', input.value); a.href = u.toString(); }
    }));
  }

  /* ---------- Product page ---------- */
  const dataEl = $('#product-data');
  if (dataEl) {
    const P = JSON.parse(dataEl.textContent);
    const form = $('#options');
    const pre = $('#order-message');
    const sel = { size: '', colour: '', qty: 1 };

    function message() {
      if (P.soldOut) {
        return `Hi NEXTDROP, I'm interested in the ${P.name}, which is showing as sold out.\n${P.url}` +
          (sel.size ? `\n\nSize: ${sel.size}` : '') + (sel.colour ? `${sel.size ? '\n' : '\n\n'}Colour: ${sel.colour}` : '') +
          `\n\nPlease let me know if it will be available again.`;
      }
      const lines = [`Hi NEXTDROP, I'd like to order the ${P.name} (${P.price}).`, P.url, ''];
      if (P.hasSizes) lines.push(`Size: ${sel.size}`);
      if (P.hasColours) lines.push(`Colour: ${sel.colour}`);
      lines.push(`Quantity: ${sel.qty}`, 'Full Name:', 'Delivery Address:', '', 'Please confirm availability, total price and delivery.');
      return lines.join('\n');
    }
    function waHref(msg) { return `https://wa.me/${P.wa}?text=${encodeURIComponent(msg)}`; }
    function update() {
      const msg = message();
      $$('[data-wa]').forEach(a => a.href = waHref(msg));
      if (pre) pre.textContent = msg;
      const sizeOut = $('#size-out'), colOut = $('#colour-out');
      if (sizeOut) sizeOut.textContent = sel.size || 'Select a size';
      if (colOut) colOut.textContent = sel.colour || 'Select a colour';
      const hint = $('#select-hint');
      if (hint) {
        const missing = [];
        if (P.hasSizes && !sel.size) missing.push('size');
        if (P.hasColours && !sel.colour) missing.push('colour');
        hint.hidden = !missing.length || P.soldOut;
        hint.textContent = missing.length ? `Tip: choose your ${missing.join(' and ')} above, or add it in the chat.` : '';
      }
    }
    document.querySelectorAll('[data-qty]').forEach(b => b.addEventListener('click', () => {
      sel.qty = Math.min(P.maxQty || 10, Math.max(1, sel.qty + Number(b.dataset.qty)));
      const o = document.getElementById('qty-out'); if (o) o.textContent = sel.qty;
      update();
    }));
    form?.addEventListener('change', e => {
      if (e.target.name === 'size') sel.size = e.target.value;
      if (e.target.name === 'colour') sel.colour = e.target.value;
      update();
    });
    // pre-select single options
    $$('input[type=radio]', form || document).forEach(r => { if (r.checked) sel[r.name] = r.value; });
    update();

    $$('[data-tg]').forEach(a => a.addEventListener('click', () => {
      copyText(message()).then(ok => toast(ok ? 'Order details copied — paste them into the Telegram chat.' : 'Open Telegram and send us the order details shown on this page.'));
    }));
    $('#copy-order')?.addEventListener('click', async () => {
      toast(await copyText(message()) ? 'Order details copied.' : 'Could not copy — please select the text and copy it.');
    });

    // Gallery dots
    const track = $('.gallery__track');
    const dots = $$('.dots button');
    if (track && dots.length) {
      dots.forEach((d, i) => d.addEventListener('click', () => track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' })));
      track.addEventListener('scroll', () => {
        const i = Math.round(track.scrollLeft / track.clientWidth);
        dots.forEach((d, j) => d.setAttribute('aria-current', i === j ? 'true' : 'false'));
      }, { passive: true });
    }

    // Sticky order bar (mobile) appears once the main buttons scroll out of view
    const bar = $('.sticky-order'), main = $('.order-box');
    if (bar && main && 'IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => bar.classList.toggle('is-visible', !e.isIntersecting))
        .observe(main);
    }
  }

  /* ---------- Generic copy buttons ---------- */
  $$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    toast(await copyText(b.dataset.copy) ? 'Copied.' : 'Could not copy.');
  }));
};
window.NDinit();
