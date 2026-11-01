/* MasterScope: shared script for the Learn, Liminal, Advertise and Privacy pages. */
(function () {
  'use strict';
  const SITE = window.MS_SITE || {};
  const $ = id => document.getElementById(id);
  // Theme (same choice as the analyser)
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  const setIcon = t => { if ($('themeIcon')) $('themeIcon').innerHTML = t === 'dark' ? SUN : MOON; };
  let t = null;
  try { t = localStorage.getItem('masterscope_theme'); } catch (e) {}
  if (!t) t = 'dark';
  document.documentElement.setAttribute('data-theme', t); setIcon(t);
  if ($('themeToggle')) $('themeToggle').addEventListener('click', () => {
    const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', n); setIcon(n);
    try { localStorage.setItem('masterscope_theme', n); } catch (e) {}
  });
  // Visit counts (only if switched on in config.js)
  if (SITE.analytics && SITE.analytics.provider === 'plausible') {
    const sc = document.createElement('script'); sc.defer = true; sc.dataset.domain = SITE.analytics.domain;
    sc.src = 'https://plausible.io/js/script.js'; document.head.appendChild(sc);
    if ($('privAnalytics')) $('privAnalytics').textContent = 'We count visits with Plausible, which uses no cookies and stores no personal data. We see totals only (pages visited, countries, which features are used), never who you are.';
  } else if (SITE.analytics && SITE.analytics.provider === 'cloudflare' && SITE.analytics.token) {
    const sc = document.createElement('script'); sc.defer = true; sc.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    sc.setAttribute('data-cf-beacon', JSON.stringify({ token: SITE.analytics.token })); document.head.appendChild(sc);
    if ($('privAnalytics')) $('privAnalytics').textContent = 'We count visits with Cloudflare Web Analytics, which uses no cookies and doesn\'t track you across sites. We see totals only (pages visited, countries, browsers), never who you are.';
  }
  if (SITE.contactEmail) ['advContact', 'privContact'].forEach(id => { if ($(id)) $(id).innerHTML = `Email <a href="mailto:${SITE.contactEmail}">${SITE.contactEmail}</a>.`; });
  // A sponsor on this Learn chapter, if one is set
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ch = document.body.dataset.chapter, sp = ch && SITE.sponsors && SITE.sponsors.learn && SITE.sponsors.learn[ch];
  if (sp && sp.name && sp.url && document.querySelector('.chapter'))
    document.querySelector('.chapter').insertAdjacentHTML('beforeend', `<a class="sponsor" href="${esc(sp.url)}" target="_blank" rel="sponsored noopener"><span class="sp-tag">Sponsor</span><b>${esc(sp.name)}</b><span>${esc(sp.text || '')}</span>${sp.cta ? `<span class="sp-cta">${esc(sp.cta)} →</span>` : ''}</a>`);
  // On wide screens, screenshots sit beside the text they illustrate
  (function sideFigures() {
    const mq = window.matchMedia('(min-width: 1360px)');
    const figs = [...document.querySelectorAll('.doc-body .chapter > .shot, .doc-body .chapter > .fig-row, .doc-body ol.wf-steps > li > .shot, .doc-body ol.wf-steps > li > .fig-row')];
    if (!figs.length) return;
    const marks = figs.map(f => { const m = document.createComment('fig'); f.before(m); return m; });
    const apply = () => figs.forEach((f, i) => {
      if (mq.matches) {
        const host = f.parentElement, head = host.tagName === 'LI' ? host.firstChild : (host.querySelector(':scope > h1, :scope > h2') || host.firstChild).nextSibling;
        const prev = figs[i - 1];
        if (prev && prev.parentElement === host) prev.after(f); else host.insertBefore(f, head);
      } else marks[i].after(f);
    });
    apply(); mq.addEventListener('change', apply);
  })();
})();
