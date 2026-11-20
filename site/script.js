/* Nuskha website: settings, shared header and footer, menus, search, demo form, WhatsApp button.
   Fill the [placeholders] in SITE below. Anything left empty is hidden on the page. */
const SITE = {
  tagline: 'Pharmacy software for Pakistan',
  phone: '+92 331 6368566',
  whatsapp: '923316368566',           // digits only, with country code
  email: 'ahashir541@gmail.com',
  address: '',                         // [address]
  demo_url: '',                        // [demo_url] a live demo link, if you have one
  cloud_login: 'https://app-nuskha.vercel.app',
  client_count: '',                    // [client_count] e.g. '120' — only a verified number
  roman_urdu_support: false,           // the app is in Urdu (Nastaliq) and English, not Roman Urdu
  regulators: [],                      // [list_confirmed_regulators] e.g. ['DRAP']
  fbr_integration: false,              // not built
  measured_expiry_reduction: '',       // [measured_expiry_reduction] e.g. '38% less expired stock in 6 months'
  measured_hours_saved: '',            // [measured_hours_saved]
  certifications: [],                  // [certification_logos] e.g. [{ name: 'ISO 27001', img: '/img/iso.webp' }]
  socials: { x: '', facebook: '', linkedin: '', instagram: '' },
  founder: {                           // About page → Team
    photo: '/img/team/syed-hashir-ali-founder-nuskha.webp',
    role: 'Founder, Nuskha',
    links: { linkedin: 'https://www.linkedin.com/in/syedhashiraly', x: '', facebook: '', instagram: '', github: '', website: '' },  // [founder_links] full https:// links
  },
  supabase: { url: 'https://sxdvifionzpvybugnvbk.supabase.co', anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4ZHZpZmlvbnpwdnlidWdudmJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUwOTUzNDQsImV4cCI6MjExMDY3MTM0NH0.VB9NYvY_-yM8ltrCZ0gXVETjvVPD1GaHofe6UBZm3gQ' },  // leads table (insert only)
};

const POSTS = [
  { href: '/blog/reduce-expired-medicine-losses.html', title: 'How to cut expired-medicine losses in your pharmacy', cats: ['Pharmacy operations'], excerpt: 'Five habits, and the reports that make them easy, to stop money expiring on your shelves.', img: '/img/products-xs.webp', eyebrow: 'Five habits to', l1: 'Stop', l2: 'Expiry', box: 'Losses' },
  { href: '/blog/udhaar-khata-under-control.html', title: 'Keeping udhaar under control without losing customers', cats: ['Healthcare in Pakistan', 'Money'], excerpt: 'Credit is part of how Pakistani pharmacies keep loyal customers. Here is how to give it safely.', img: '/img/dashboard-xs.webp', eyebrow: 'Keep customers, keep', l1: 'Udhaar', l2: 'Under control', box: 'Safely' },
  { href: '/blog/local-or-cloud-pharmacy-software.html', title: 'Local or cloud: which pharmacy software is right for you?', cats: ['Technology'], excerpt: 'Load-shedding, internet, branches and privacy: how to choose where your records should live.', img: '/img/pos-xs.webp', eyebrow: 'Which one is right for you', l1: 'Local', l2: 'or Cloud?', box: 'Simple breakdown' },
];

const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  wa: '<svg width="34" height="34" viewBox="0 0 32 32" fill="#fff" aria-hidden="true"><path d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.6a10.6 10.6 0 0 1-5.4-1.5l-.4-.2-3.9 1 1-3.8-.3-.4A10.6 10.6 0 1 1 16 26.6zm5.8-7.9c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7 0a8.7 8.7 0 0 1-4.3-3.8c-.3-.6.3-.5.9-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 0 0-.9.4 3.7 3.7 0 0 0-1.1 2.7 6.4 6.4 0 0 0 1.3 3.4 14.7 14.7 0 0 0 5.6 5c2.1.9 2.9 1 4 .8a3.4 3.4 0 0 0 2.2-1.6 2.8 2.8 0 0 0 .2-1.6c0-.2-.3-.3-.6-.4z"/></svg>',
};

function header() {
  return `
  <header class="site-header" id="site-header">
    <div class="wrap">
      <a class="logo" href="/" aria-label="Nuskha home"><img src="/img/icon-192.png" alt="" width="42" height="42"><b>Nuskha</b></a>
      <nav class="mainnav" aria-label="Main">
        <div class="dd"><button type="button" aria-expanded="false">Products</button>
          <div class="dd-menu">
            <a href="/features.html"><b>All features</b><span>Every screen, explained</span></a>
            <a href="/features.html#stock"><b>Inventory &amp; Purchases</b><span>Stock, batches, expiry, suppliers</span></a>
            <a href="/features.html#pos"><b>Billing &amp; POS</b><span>Fast counter billing</span></a>
            <a href="/features.html#udhaar"><b>Udhaar Ledger</b><span>Customer and supplier credit</span></a>
            <a href="/features.html#reports"><b>Reports</b><span>Sales, profit, cash</span></a>
            <a href="/#two-ways"><b>Nuskha Local</b><span>Installed on your shop PC, works offline</span></a>
            <a href="/#two-ways"><b>Nuskha Cloud</b><span>In your browser, open it from anywhere</span></a>
          </div></div>
        <div class="dd"><button type="button" aria-expanded="false">Services</button>
          <div class="dd-menu">
            <a href="/guide.html"><b>Install guide</b><span>Install, set up, backups, step by step</span></a>
            <a href="/download.html"><b>Download</b><span>NuskhaSetup.exe for Windows</span></a>
            <a href="/#request-demo" data-demo><b>Data import</b><span>Bring your medicine list from Excel</span></a>
            <a href="/#request-demo" data-demo><b>Staff training</b><span>Get your team selling on day one</span></a>
          </div></div>
        <div class="dd"><button type="button" aria-expanded="false">Company</button>
          <div class="dd-menu">
            <a href="/about.html"><b>About</b><span>Who we are</span></a>
            <a href="/about.html#vision"><b>Vision &amp; Mission</b><span>What we are building</span></a>
            <a href="/about.html#team"><b>Our Team</b><span>Meet the founder</span></a>
            <a href="/release-notes.html"><b>Release Notes</b><span>What's new in Nuskha</span></a>
          </div></div>
        <a href="/features.html">Features</a>
        <a href="/blog/">Blog</a>
        <a href="/download.html">Download</a>
        <a href="/#contact">Contact</a>
        <div class="mobile-only">
          <a class="login-btn js-login" href="/login.html">Pharmacy Login</a>
          <a class="btn btn-navy" href="#request-demo" data-demo>Request a Demo</a>
        </div>
      </nav>
      <div class="head-actions">
        <button class="icon-btn" type="button" id="search-toggle" aria-label="Search the blog" aria-expanded="false">${ICON.search}</button>
        <a class="login-btn js-login" href="/login.html" title="Login to your pharmacy">Pharmacy Login</a>
        <a class="btn btn-navy" href="#request-demo" data-demo>Request a Demo</a>
        <button class="icon-btn burger" type="button" id="burger" aria-label="Menu" aria-expanded="false">${ICON.menu}</button>
      </div>
    </div>
    <div class="searchbar" id="searchbar" hidden>
      <div class="wrap"><label for="site-search" class="tag">Search the blog</label>
        <input id="site-search" type="search" placeholder="e.g. expiry, udhaar, cloud" autocomplete="off">
        <div class="search-results" id="search-results"></div></div>
    </div>
  </header>`;
}

function footer() {
  const s = SITE.socials || {};
  const social = Object.entries(s).filter(([, v]) => v).map(([k, v]) => `<a href="${v}" target="_blank" rel="noopener">${({ x: 'X', facebook: 'Facebook', linkedin: 'LinkedIn', instagram: 'Instagram' })[k]}</a>`).join(' · ');
  return `
  <footer class="site-footer" id="contact">
    <div class="wrap">
      <div class="cols">
        <div style="display:grid;gap:14px;align-content:start">
          <a class="logo" href="/"><img src="/img/icon-192.png" alt="" width="42" height="42"><b>Nuskha</b></a>
          <p>Pharmacy management software for Pakistan. Billing, stock, expiry and udhaar — with or without internet.</p>
          <ul>
            <li data-needs="phone">Phone: <a href="tel:${SITE.phone.replace(/\s/g, '')}">${SITE.phone}</a></li>
            <li data-needs="email">Email: <a href="mailto:${SITE.email}">${SITE.email}</a></li>
            <li data-needs="address">${SITE.address}</li>
          </ul>
        </div>
        <div><h4>Products</h4><ul>
          <li><a href="/features.html">All features</a></li><li><a href="/features.html#stock">Inventory &amp; Purchases</a></li>
          <li><a href="/features.html#pos">Billing &amp; POS</a></li><li><a href="/features.html#udhaar">Udhaar Ledger</a></li><li><a href="/features.html#reports">Reports</a></li><li><a href="/#two-ways">Nuskha Local &amp; Cloud</a></li></ul></div>
        <div><h4>Services</h4><ul>
          <li><a href="/download.html">Download</a></li><li><a href="/guide.html">Install guide</a></li><li><a href="#request-demo" data-demo>Data import</a></li>
          <li><a href="#request-demo" data-demo>Staff training</a></li><li><a href="/login.html">Login to your pharmacy</a></li></ul></div>
        <div><h4>Company</h4><ul>
          <li><a href="/about.html">About</a></li><li><a href="/about.html#team">Our Team</a></li><li><a href="/release-notes.html">Release Notes</a></li><li><a href="/blog/">Blog</a></li></ul>
          <p data-needs-social style="margin-top:14px">${social}</p></div>
      </div>
      <div class="bottom"><span>© ${new Date().getFullYear()} Nuskha. All rights reserved.</span><span>Made for pharmacies in Pakistan</span></div>
    </div>
  </footer>
  <a class="wa-float" id="wa-float" href="#" target="_blank" rel="noopener" aria-label="Chat with Nuskha on WhatsApp">${ICON.wa}</a>
  <div class="modal" id="demo-modal" hidden role="dialog" aria-modal="true" aria-labelledby="demo-title">
    <div class="modal-card">
      <header><div><h3 id="demo-title">Request a demo</h3><p class="lead" style="font-size:16px">Tell us about your pharmacy and we'll set up a demo for you.</p></div>
        <button class="icon-btn" type="button" data-close aria-label="Close">✕</button></header>
      <form class="form" id="demo-form" novalidate>
        <label>Your name *<input name="name" required minlength="2" maxlength="80" autocomplete="name"></label>
        <label>Pharmacy name *<input name="pharmacy" required minlength="2" maxlength="120" autocomplete="organization"></label>
        <label>City *<input name="city" required minlength="2" maxlength="60" autocomplete="address-level2"></label>
        <label>Phone *<input name="phone" required inputmode="tel" maxlength="20" autocomplete="tel" placeholder="03xx xxxxxxx"></label>
        <label>Email<input name="email" type="email" maxlength="120" autocomplete="email"></label>
        <label>Number of branches<input name="branches" type="number" min="1" max="500" value="1"></label>
        <label class="full">Software you use now (optional)<input name="current_software" maxlength="80"></label>
        <label class="full">Message<textarea name="message" rows="3" maxlength="1000"></textarea></label>
        <p class="err full" id="demo-err" hidden></p>
        <div class="full"><button class="btn btn-navy" type="submit" id="demo-send">Send request</button></div>
      </form>
      <div class="thanks" id="demo-thanks" hidden><h3>Thank you!</h3><p class="lead" style="font-size:16px">We've received your request and will contact you soon.</p>
        <button class="btn btn-outline" type="button" data-close>Close</button></div>
    </div>
  </div>`;
}

function founderCard() {
  const box = document.querySelector('[data-founder-links]');
  if (!box) return;
  const f = SITE.founder || {};
  const img = document.querySelector('[data-founder-photo]');
  if (img && f.photo && !img.getAttribute('src')) { img.src = f.photo; img.hidden = false; }
  const role = document.querySelector('[data-founder-role]');
  if (role && f.role) role.textContent = f.role;
  const L = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram', github: 'GitHub', website: 'Website' };
  const safe = (u) => /^https:\/\//.test(u || '');
  const links = Object.entries(f.links || {}).filter(([, u]) => safe(u)).map(([k, u]) => [L[k] || k, u]);
  if (SITE.whatsapp) links.push(['WhatsApp', `https://wa.me/${SITE.whatsapp}`]);
  if (SITE.email) links.push(['Email', `mailto:${SITE.email}`]);
  links.forEach(([label, href]) => {
    const a = document.createElement('a');
    a.className = `chip-link${label === 'LinkedIn' ? ' li' : ''}`; a.href = href; a.textContent = label;
    if (href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener'; }
    box.appendChild(a);
  });
}

function featureTour() {
  const tabs = [...document.querySelectorAll('.ftab')];
  if (!tabs.length) return;
  const show = (k, focus) => {
    tabs.forEach((t) => { const on = t.dataset.tab === k; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); });
    document.querySelectorAll('.fpanel').forEach((p) => { const on = p.id === `p-${k}`; p.hidden = !on; p.classList.toggle('on', on); });
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { show(t.dataset.tab); history.replaceState(null, '', `#${t.dataset.tab}`); });
    t.addEventListener('keydown', (e) => {
      const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (n) { e.preventDefault(); const x = tabs[(i + n + tabs.length) % tabs.length]; show(x.dataset.tab, true); }
    });
  });
  const fromHash = () => { const k = location.hash.slice(1); if (tabs.some((t) => t.dataset.tab === k)) show(k); };
  fromHash(); window.addEventListener('hashchange', fromHash);
  const box = document.getElementById('lightbox');
  const img = box.querySelector('img');
  const close = () => { box.hidden = true; document.body.style.overflow = ''; };
  document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    img.src = b.dataset.zoom; img.alt = b.querySelector('img').alt; box.hidden = false; document.body.style.overflow = 'hidden'; box.querySelector('.lb-close').focus();
  }));
  box.addEventListener('click', (e) => { if (e.target !== img) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });
}

function hideEmpty() {
  document.querySelectorAll('[data-site]').forEach((el) => { const v = SITE[el.dataset.site]; if (v) el.textContent = v; else el.hidden = true; });
  document.querySelectorAll('[data-needs]').forEach((el) => { const v = SITE[el.dataset.needs]; if (!v || (Array.isArray(v) && !v.length)) el.hidden = true; });
  document.querySelectorAll('[data-needs-social]').forEach((el) => { if (!el.textContent.trim()) el.hidden = true; });
  document.querySelectorAll('[data-fill]').forEach((el) => { const v = SITE[el.dataset.fill]; if (v) el.textContent = el.dataset.prefix ? el.dataset.prefix + v : v; else (el.closest('[data-block]') || el).hidden = true; });
  document.querySelectorAll('[data-flag]').forEach((el) => { if (!SITE[el.dataset.flag]) el.hidden = true; });
  const reg = document.getElementById('regulators');
  if (reg) { if (SITE.regulators.length) reg.textContent = ` It supports the record-keeping expected by ${SITE.regulators.join(', ')}.`; else reg.hidden = true; }
  const certs = document.getElementById('certs');
  if (certs) { if (SITE.certifications.length) certs.innerHTML = SITE.certifications.map((c) => `<img src="${c.img}" alt="${c.name}" height="56" loading="lazy">`).join(''); else certs.hidden = true; }
  document.querySelectorAll('.js-cloud-login').forEach((a) => { if (SITE.cloud_login) a.href = SITE.cloud_login; else a.hidden = true; });
  const demoLink = document.querySelectorAll('.js-demo-url');
  demoLink.forEach((a) => { if (SITE.demo_url) a.href = SITE.demo_url; else a.hidden = true; });
}

function menus() {
  const head = document.getElementById('site-header');
  document.querySelectorAll('.dd > button').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = b.parentElement; const open = !dd.classList.contains('open');
    document.querySelectorAll('.dd.open').forEach((x) => { x.classList.remove('open'); x.firstElementChild.setAttribute('aria-expanded', 'false'); });
    if (open) { dd.classList.add('open'); b.setAttribute('aria-expanded', 'true'); }
  }));
  document.addEventListener('click', () => document.querySelectorAll('.dd.open').forEach((x) => x.classList.remove('open')));
  const burger = document.getElementById('burger');
  burger.addEventListener('click', () => { const o = head.classList.toggle('menu-open'); burger.setAttribute('aria-expanded', String(o)); });
  const st = document.getElementById('search-toggle'); const bar = document.getElementById('searchbar'); const q = document.getElementById('site-search'); const out = document.getElementById('search-results');
  st.addEventListener('click', () => { bar.hidden = !bar.hidden; st.setAttribute('aria-expanded', String(!bar.hidden)); if (!bar.hidden) q.focus(); });
  q.addEventListener('input', () => {
    const t = q.value.trim().toLowerCase();
    const hits = t ? POSTS.filter((p) => (p.title + ' ' + p.excerpt + ' ' + p.cats.join(' ')).toLowerCase().includes(t)) : [];
    out.innerHTML = t ? (hits.length ? hits.map((p) => `<a href="${p.href}"><b>${p.title}</b><br><span class="tag" style="font-size:11px">${p.cats.join(' · ')}</span></a>`).join('') : '<span class="lead" style="font-size:15px">No posts match yet.</span>') : '';
  });
}

function whatsapp() {
  const a = document.getElementById('wa-float');
  if (!SITE.whatsapp) { a.hidden = true; return; }
  a.href = `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent('Assalam o alaikum, I want to know more about Nuskha.')}`;
}

function demoForm() {
  const modal = document.getElementById('demo-modal'); const form = document.getElementById('demo-form');
  const err = document.getElementById('demo-err'); const thanks = document.getElementById('demo-thanks'); const send = document.getElementById('demo-send');
  let last = null;
  const open = (e) => { e.preventDefault(); last = document.activeElement; modal.hidden = false; form.hidden = false; thanks.hidden = true; err.hidden = true; form.elements.name.focus(); document.body.style.overflow = 'hidden'; };
  const close = () => { modal.hidden = true; document.body.style.overflow = ''; last?.focus?.(); };
  document.addEventListener('click', (e) => { const t = e.target.closest('[data-demo]'); if (t) open(e); if (e.target.closest('[data-close]') || e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
  if (location.hash === '#request-demo') setTimeout(() => document.querySelector('[data-demo]')?.click(), 0);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    const f = Object.fromEntries(new FormData(form).entries());
    const problem = f.name.trim().length < 2 ? 'Please enter your name.' : f.pharmacy.trim().length < 2 ? 'Please enter your pharmacy name.'
      : f.city.trim().length < 2 ? 'Please enter your city.' : !/^[0-9+() -]{7,20}$/.test(f.phone.trim()) ? 'Please enter a phone number (digits only).'
      : f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim()) ? 'Please check the email address.' : '';
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const lead = { name: f.name.trim(), pharmacy: f.pharmacy.trim(), city: f.city.trim(), phone: f.phone.trim(), email: f.email.trim() || null,
      branches: f.branches ? Math.max(1, Math.min(500, Number(f.branches))) : null, current_software: f.current_software.trim() || null, message: f.message.trim() || null };
    send.disabled = true; send.textContent = 'Sending…';
    try {
      const r = await fetch(`${SITE.supabase.url}/rest/v1/leads`, { method: 'POST',
        headers: { apikey: SITE.supabase.anonKey, Authorization: `Bearer ${SITE.supabase.anonKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(lead) });
      if (!r.ok) throw new Error(String(r.status));
      form.reset(); form.hidden = true; thanks.hidden = false;
    } catch {
      err.textContent = SITE.whatsapp ? `We couldn't send that just now. Please try again, or message us on WhatsApp.` : `We couldn't send that just now. Please try again.`;
      err.hidden = false;
    } finally { send.disabled = false; send.textContent = 'Send request'; }
  });
}

function shots() {
  document.querySelectorAll('[data-tabs]').forEach((box) => {
    const tabs = box.querySelectorAll('[role=tab]');
    tabs.forEach((t) => t.addEventListener('click', () => {
      tabs.forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      box.querySelectorAll('[data-shot]').forEach((img) => { img.hidden = img.dataset.shot !== t.dataset.target; });
    }));
  });
}

function blogCards() {
  const el = document.getElementById('posts');
  if (!el) return;
  const limit = Number(el.dataset.limit || POSTS.length);
  el.innerHTML = POSTS.slice(0, limit).map((p) => `
    <a class="post" href="${p.href}"><div class="pcard"><img class="pbg" src="${p.img}" alt="" width="640" height="400" loading="lazy" decoding="async"><span class="ptag">${p.cats[0]}</span>
      <div class="ptitle" aria-hidden="true"><span class="pe">${p.eyebrow}</span><b class="l1">${p.l1}</b><b class="l2">${p.l2}</b><span class="pbox">${p.box}</span></div></div>
      <div class="body"><div class="cats">${p.cats.map((c) => `<span>${c}</span>`).join('')}</div><h3>${p.title}</h3><p>${p.excerpt}</p><span class="more">Learn more →</span></div></a>`).join('');
}


function motion() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Header: a little smaller with a shadow once the page is scrolled.
  const head = document.getElementById('site-header');
  const onScroll = () => head.classList.toggle('scrolled', window.scrollY > 12);
  onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
  if (reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js-motion');
  // Scroll reveal, staggered inside each row of cards.
  const groups = ['.sec-head', '.pain', '.feature', '.trust > div', '.post', '.pill', '.acc details', '.split > .copy', '.cloud-art', '.way', '.ways-note', '.fcard', '.comp > div', '.vm-card', '.values > div', '.founder',
    '.dl-card', '.article > *', '.login-cards > div', '.checks li', '.lead.center'];
  const items = new Set();
  groups.forEach((sel) => document.querySelectorAll(`main ${sel}`).forEach((el) => {
    if (el.closest('.hero')) return;
    const sibs = [...el.parentElement.children].filter((c) => c.matches(sel.split(' ').pop()));
    el.style.setProperty('--d', `${Math.min(sibs.indexOf(el), 4) * 40}ms`);
    el.classList.add('reveal'); items.add(el);
  }));
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.05, rootMargin: '0px 0px 120px 0px' });
  items.forEach((el) => io.observe(el));
  // Anything already on screen (or skipped by the observer) shows at once.
  // Whatever is already on screen shows straight away, without a fade.
  items.forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) { el.classList.add('now', 'in'); io.unobserve(el); } });
  // Hero devices lean gently toward the mouse (desktop only).
  const dev = document.querySelector('.devices'); const hero = document.querySelector('.hero');
  if (dev && hero && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    hero.addEventListener('mousemove', (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      dev.style.rotate = `${(-y).toFixed(3)} ${x.toFixed(3)} 0 ${(Math.hypot(x, y) * 9).toFixed(2)}deg`;
    });
    hero.addEventListener('mouseleave', () => { dev.style.rotate = ''; });
  }
}

document.getElementById('header-slot').outerHTML = header();
document.getElementById('footer-slot').outerHTML = footer();
hideEmpty(); menus(); whatsapp(); demoForm(); shots(); blogCards(); founderCard(); featureTour(); motion();
