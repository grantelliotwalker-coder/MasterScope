(function () {
  'use strict';

  // ===================================================================
  // State
  // ===================================================================
  const S = {
    buffer: null, fileName: '', fileInfo: null,
    mono: null, loud: null, tp: null, levels: null, tone: null, sf: null, corr: 1, vs: null, spec: null, trans: null,
    metrics: null, findings: [], specBars: null,
    ref: null,          // { buffer, name, sum, bars }
    selection: null,    // { start, end } in samples
    quietRegions: [],   // [{ start, end, gainDb, startSec, endSec, belowBy, fallback }]
    adjusted: null,     // AudioBuffer after region gain
    activeTab: 'overview',
  };
  let audioCtx = null, chain = null, sourceNode = null;
  let isPlaying = false, playStartTime = 0, playOffset = 0, raf = 0;
  let abMode = 'original', monoOn = false;
  let previewSource = null, previewWhich = null, previewStart = 0, previewOffset = 0;
  let liveTop = -Infinity;
  let exportDpr = 0; // set to 2 while rendering charts for the PDF report

  // ===================================================================
  // Site settings: fill these in to switch features on
  // ===================================================================
  const SITE = window.MS_SITE || { version: '1.0', contactEmail: '', analytics: null, sponsors: { result: null, release: null, card: null, learn: {} } };
  if (SITE.analytics && SITE.analytics.provider === 'plausible') {
    const sc = document.createElement('script'); sc.defer = true; sc.dataset.domain = SITE.analytics.domain;
    sc.src = 'https://plausible.io/js/script.js'; document.head.appendChild(sc);
  } else if (SITE.analytics && SITE.analytics.provider === 'cloudflare' && SITE.analytics.token) {
    const sc = document.createElement('script'); sc.defer = true; sc.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    sc.setAttribute('data-cf-beacon', JSON.stringify({ token: SITE.analytics.token })); document.head.appendChild(sc);
  }
  const track = (name, props) => { try { if (window.plausible) window.plausible(name, props ? { props } : undefined); } catch (e) {} };
  function sponsorHtml(sp) {
    if (!sp || !sp.name || !sp.url) return '';
    const e = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<a class="sponsor" href="${e(sp.url)}" target="_blank" rel="sponsored noopener"><span class="sp-tag">Sponsor</span><b>${e(sp.name)}</b><span>${e(sp.text || '')}</span>${sp.cta ? `<span class="sp-cta">${e(sp.cta)} →</span>` : ''}</a>`;
  }

  const $ = id => document.getElementById(id);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const MINUS = '−';
  const fmt = (v, d = 1) => (v === null || v === undefined || !isFinite(v)) ? '—' : (v < 0 && +Math.abs(v).toFixed(d) !== 0 ? MINUS : '') + Math.abs(v).toFixed(d);
  const fmtSigned = (v, d = 1) => (!isFinite(v)) ? '—' : (v > 0 ? '+' : '') + fmt(v, d);
  const fmtTime = t => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`; };
  const fmtHz = f => f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 1 : 0).replace('.0', '') + 'k' : String(Math.round(f));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, ms = 3200) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ===================================================================
  // Theme
  // ===================================================================
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeIcon').innerHTML = t === 'dark' ? SUN : MOON;
    try { localStorage.setItem('masterscope_theme', t); } catch (e) {}
    invalidateCaches();
    if (S.buffer) redrawActive();
  }
  (function initTheme() {
    let t = null;
    try { t = localStorage.getItem('masterscope_theme'); } catch (e) {}
    if (!t) t = 'dark';   // the site is dark unless the visitor picks light, so landing and results match
    document.documentElement.setAttribute('data-theme', t);
    $('themeIcon').innerHTML = t === 'dark' ? SUN : MOON;
  })();
  $('themeToggle').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  // ===================================================================
  // Help text (what / how to read / what good looks like)
  // ===================================================================
  const HELP = {
    readiness: ['How close this track is to a competitive master at −14 LUFS with a −1 dBTP true-peak ceiling, and the steps to get there.',
      'The bar shows the peak-to-loudness ratio (PLR). At −14 LUFS with peaks at −1 dBTP the most it can be is 13 dB, so anything right of the dashed line can\u2019t reach −14. Competitive releases usually sit around 8–12 dB.',
      'A green verdict with your marker in the competitive zone. The steps are ordered: fix what stops the track reaching −14 first, then work on density and tone.'],
    peaksDensity: ['What decides how loud this track can be at −14: how far its peaks stand above its body (PLR), and what is making those peaks.',
      'Each of the loudest peaks is classified by whether it lands on a detected drum hit and whether it is mostly low-frequency energy. "Audio affected" is how much of the track sits in the top few dB that would need to come off.',
      'Competitive density (PLR 8–12) with peaks coming mostly from drum hits, which are the easiest to control cleanly.'],
    louder: ['At −14 every track plays at the same loudness, so what makes one sound bigger is how much loudness it gets out of its peaks. This shows which parts of the spectrum cost peak room, which give loudness, and which mix moves would make the limiter work less.',
      'Amber bars are each range’s share of the height of the loudest peaks; blue bars are its share of the loudness LUFS counts. A range with a long amber bar and a short blue one spends headroom without adding much loudness. "What to control" takes 4 dB off the loudest 2% of moments in one range and measures how much less limiting the track then needs; green means less, red means more. Tone moves do the same for simple EQ changes, and Try in EQ lets you hear them.',
      'Peaks coming mostly from the ranges that also carry the loudness, and no range that makes far more peak than loudness. Measured on a mix before the master limiter, this points straight at the bus or instrument to control.'],
    summary: ['The headline numbers for this file, each with a short verdict.',
      'Green is within a typical range, amber is worth a listen, red is likely a problem. Grey is informational.',
      'For streaming: about −14 LUFS integrated, true peak at or below −1 dBTP, and positive phase correlation.'],
    actions: ['The most important issues found across every tab, most serious first.',
      'Each item names the tab with the detail. Open "Checks that passed" to see everything that looked fine.',
      'An empty list means nothing stood out to the measurements. It never replaces listening on several systems.'],
    overviewWave: ['The whole track as one waveform (both channels mixed).',
      'Click anywhere to start playback from that point. The line shows the playhead.',
      'Peaks that stay below the top edge, and quiet and loud sections where you intended them.'],
    fileinfo: ['Basic properties of the file you opened.',
      'Sample rate and bit depth come from the file header when the format provides them.',
      'Lossless files (WAV, AIFF, FLAC) at the sample rate you mixed at give the most reliable readings.'],
    meters: ['Integrated loudness of the whole track (ITU-R BS.1770-4) and the highest true peak, measured with 4× oversampling to catch peaks between samples.',
      'The accent tick on each meter marks the usual streaming target: −14 LUFS and −1 dBTP. Short-term uses a 3 s window, momentary 0.4 s. PLR is true peak minus integrated loudness.',
      'Around −14 LUFS suits streaming (louder genres often master to −9 to −11). True peak at or below −1 dBTP. PLR of roughly 8–12 dB is typical of modern releases.'],
    timeline: ['How loudness changes across the track, measured every 100 ms.',
      'Green is momentary loudness (0.4 s), blue is short-term (3 s), and the dashed line is the integrated loudness of the whole track.',
      'Sections sitting where you intend. Ticks along the top mark the loudest peaks, coloured by what made them, and brackets mark where they cluster. Shaded spans are energy dips more than 3 LU below the average: fine for breakdowns, but parts that should drive will feel smaller at −14. Click a chip below the chart to play from there.'],
    platforms: ['How much each service’s loudness normalisation would turn this file up or down, and where its true peak would land afterwards.',
      'A down arrow means the service turns you down. Red peak text means the result would go above −1 dBTP.',
      'Small changes. Being turned down costs nothing; being turned up can push peaks into the service’s limiter.'],
    tonal: ['The average level of each octave across the whole track, compared with pink noise, which would draw as a flat line at 0 dB.',
      'Bars above 0 are louder than pink noise in that octave, bars below are quieter. Tilt is the overall slope from 63 Hz to 8 kHz. Load a reference on the Compare tab to overlay its curve.',
      'Most releases fall gently from bass to treble, with a tilt of roughly 0 to −3 dB per octave. Genre matters a lot, so a reference in your style is the best guide.'],
    spectrum: ['Frequency content in fine detail. When stopped it shows the whole-track average; during playback it shows the live signal, including your EQ and listening mode.',
      'Drawn so that pink noise is flat, which is close to how we hear balance. Narrow peaks are resonances or prominent notes; wide humps are broad tonal emphasis.',
      'A smooth curve without narrow spikes or deep holes, and a shape similar to a good reference.'],
    spectrogram: ['Frequency (bottom to top, 20 Hz to 20 kHz) over time (left to right). Brighter colours are louder.',
      'Horizontal lines are sustained notes or resonances. Vertical stripes are hits. Hover to read values, click to play from that point.',
      'Energy where you expect it, with no constant bright lines you didn’t intend.'],
    vectorscope: ['The relationship between left and right channels. Mono content draws as a vertical line.',
      'A tall, thin shape is narrow; a wide ellipse is wide; horizontal spread means out-of-phase content. Correlation of +1 is mono, 0 is unrelated channels, below 0 cancels when summed.',
      'A shape leaning towards vertical and correlation above about +0.25. Use Mono in the player to check by ear.'],
    stereofield: ['How much of each frequency’s energy is in the sides (stereo) rather than the centre (mono), across the whole track.',
      'Taller bars are wider. Faint bars carry little energy and matter less.',
      'Low end below roughly 120–200 Hz close to 0%, with mids and highs wider.'],
    dynamics: ['How much the level moves, both peak to body and section to section.',
      'PLR (peak-to-loudness ratio) shows how far the peaks stand above the body of the track. LRA (loudness range) shows how much loudness varies between sections. Crest factor is sample peak minus RMS.',
      'PLR around 8–12 dB and LRA around 4–10 LU are typical for pop and electronic music. Acoustic and cinematic material runs wider.'],
    transients: ['Finds the strongest repeated hits (usually kick and snare) and measures how they sit in the mix.',
      'Rise is how far each hit jumps above what was already playing in that band. Settle time is how long the band takes to return to its level from before the hit. When the rise is small, something sustains underneath (often bass), and the hit can’t be measured on its own.',
      'Hits that rise clearly above the mix, with low end settling before the next hit.'],
    eq: ['A 6-band EQ in the playback path. It changes what you hear and the live spectrum, and Master to −14 can include it. It never changes your file.',
      'Drag a point to set its frequency and gain. Scroll over a point on desktop to make it narrower or wider. "Load suggested curve" sets moves based on this track\u2019s findings.',
      'Use it to audition fixes before making them in your DAW.'],
    master: ['A finished master of your track at −14 LUFS: optional EQ and glue compression, a soft clipper, then a true-peak limiter, re-measured until it lands on exactly −14.0 LUFS under your chosen ceiling.',
      'Compare "Mastered" with "−14 LUFS" in the player: both play at the same loudness, so any difference is density and tone, not volume. The notes show how hard the clipper and limiter had to work.',
      'If the master sounds clearly fuller and the limiter only works lightly, your mix is in good shape. If the limiter works hard, fix the peaks in the mix first; it will sound better than any limiter can make it.'],
    region: ['Preview a level change on part of the track, the way you’d automate it in a DAW.',
      'Drag across the waveform to select a section, set the gain, then measure the change. "Find quiet sections" looks for passages noticeably quieter than the rest, ignoring the intro and outro.',
      'If boosting quiet sections and trimming back to the original loudness raises PLR, the limiter has less work to do.'],
    zoom: ['The individual samples in your selection.',
      'Zoom in until sample points appear, then hover to read each value.',
      'Smooth shapes. Flat tops at full scale mean clipping.'],
    reference: ['Compares your track with a released track or an earlier version. Both play matched to −14 LUFS.',
      'The table shows both sets of numbers side by side. The reference’s tonal curve also appears on the Tone tab.',
      'Choose a well-mastered reference in the same genre, so you’re comparing like with like.'],
    release: ['A pass, check or fix for each place your track will play, with the reason.',
      'Streaming services turn loud tracks down and quiet ones up only if there is peak room. Lossy encoders (Spotify, Apple Music, YouTube, SoundCloud) push peaks up, so the encoded peak matters more than the file\u2019s. Club play has no normalisation, so loudness and mono matter there.',
      'Passes everywhere you release. A "check" is worth a listen; a "fix" will audibly hurt the track on that platform.'],
    history: ['Every file you analyse is logged in this browser. Only the numbers are stored, never the audio.',
      'Select two versions to see what changed between them.',
      'Export the history to keep a backup or move it to another browser.'],
  };

  function injectHelp() {
    document.querySelectorAll('.panel[data-help]').forEach((panel, i) => {
      const h = HELP[panel.dataset.help]; if (!h) return;
      const head = panel.querySelector('.panel-head');
      const btn = document.createElement('button');
      btn.className = 'help-btn'; btn.type = 'button'; btn.textContent = '?';
      btn.setAttribute('aria-label', 'What is this?'); btn.title = 'What is this?';
      btn.setAttribute('aria-expanded', 'false');
      const id = 'help-' + i; btn.setAttribute('aria-controls', id);
      if (!head.querySelector('.actions')) btn.style.marginLeft = 'auto';
      head.appendChild(btn);
      const box = document.createElement('div');
      box.className = 'help'; box.id = id; box.hidden = true;
      box.innerHTML = `<div><h3>What it shows</h3><p>${esc(h[0])}</p></div><div><h3>How to read it</h3><p>${esc(h[1])}</p></div><div><h3>What good looks like</h3><p>${esc(h[2])}</p></div>`;
      head.after(box);
      btn.addEventListener('click', () => {
        const open = box.hidden; box.hidden = !open; btn.setAttribute('aria-expanded', String(open));
      });
    });
  }
  injectHelp();

  // ===================================================================
  // Landing feature cards (static, no demo)
  // ===================================================================
  const ICONS = {
    loud: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    tone: '<path d="M3 20V12M7 20V8M11 20V4M15 20V9M19 20V14"/>',
    stereo: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
    dyn: '<path d="M3 12h3l3-8 4 16 3-8h5"/>',
    tools: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    compare: '<path d="M8 3v18M16 3v18M3 8h5M16 16h5"/>',
  };
  const FEATURES = [
    ['loud', '−14 readiness', 'Exactly how far your track is from a competitive −14 LUFS master, what is causing the peaks that hold it back, and the steps to fix it.', ['Integrated LUFS', 'True peak', 'PLR budget', 'LRA', 'Peak sources', 'Louder at −14', 'Platform preview']],
    ['tone', 'Tone', 'See where your mix sits from sub to air, compared with pink noise and with a reference track if you load one.', ['Tonal balance', 'Spectrum', 'Spectrogram']],
    ['stereo', 'Stereo', 'Check width and mono compatibility before phones, Bluetooth speakers and club systems do it for you.', ['Vectorscope', 'Correlation', 'Width by frequency']],
    ['dyn', 'Dynamics', 'How much your peaks stand out, how much sections vary, and whether the low end clears between hits.', ['PLR', 'Crest factor', 'Kick & bass separation']],
    ['tools', 'Master to −14', 'Hear your mix finished at −14 LUFS with a soft clipper and true-peak limiter, and compare it at matched loudness before touching your session.', ['One-click master', 'Live EQ', 'Matched A/B', 'Region gain']],
    ['compare', 'Compare', 'Level-matched comparison with a reference track, plus a history of every version you analyse.', ['Reference', 'Version history', 'PDF export']],
  ];
  // Plain-English explanations shown when hovering, focusing or tapping a pill
  const TIPS = {
    'Integrated LUFS': 'The average perceived loudness of the whole track. Streaming services turn every song to about −14 LUFS, so this tells you how far yours will be turned up or down.',
    'True peak': 'The highest level the waveform reaches, including peaks that fall between samples. Keeping it at or below −1 dBTP stops lossy streaming formats from distorting.',
    'PLR budget': 'At −14 LUFS with peaks at −1 dBTP, peaks can stand at most 13 dB above the average loudness. MasterScope shows how much of that budget your track uses.',
    'LRA': 'Loudness range: how much the loudness changes between the quiet and loud parts of the song, in LU. Low values mean a consistent track; high values mean big contrasts between sections.',
    'Louder at −14': 'Shows which parts of the spectrum use up peak room and which give loudness, then tests mix moves on your actual track (controlling one range, or a simple EQ change) to show which would make the limiter work least.',
    'Peak sources': 'Works out what is making your loudest peaks (drum hits, kick and bass overlapping, bass notes or other parts), so you know where to fix them.',
    'Platform preview': 'Shows how much Spotify, Apple Music, YouTube and others will turn your track up or down, and where its peaks land afterwards.',
    'Tonal balance': 'Your average level in each octave from sub to air, compared with pink noise and with a reference track if you load one.',
    'Spectrum': 'A detailed frequency graph of the whole track, or live while it plays, so you can spot resonances, build-ups and gaps.',
    'Spectrogram': 'Frequency over time as a heat map. Shows exactly when and where mud, harshness or ringing bass happens in the song.',
    'Vectorscope': 'Plots the left channel against the right. A tall, narrow shape is close to mono, a wide shape is wide stereo, and sideways spread warns of phase problems.',
    'Correlation': 'Phase correlation: +1 means both channels are identical (mono), 0 means unrelated, and below 0 means parts of the mix cancel out on mono speakers.',
    'Width by frequency': 'How much of each frequency range sits in the stereo sides. Bass usually belongs near the centre; highs can be wide.',
    'PLR': 'Peak-to-loudness ratio: how far the loudest peaks stand above the average loudness. Lower means denser and more limited; competitive releases usually sit around 8–12 dB.',
    'Crest factor': 'The gap between the highest sample and the average (RMS) level. Like PLR, a rough measure of how punchy or squashed the track is.',
    'Kick & bass separation': 'Checks whether each kick stands clear or lands on a bass note that is still ringing. Overlap blurs the low end and uses up headroom.',
    'One-click master': 'Renders your track through a soft clipper and true-peak limiter, landing on exactly −14 LUFS and −1 dBTP, so you can hear it finished.',
    'Live EQ': 'A 6-band EQ in the playback path. Try fixes and hear them instantly without changing your file.',
    'Matched A/B': 'Compare your mix and the master at exactly the same loudness, so louder never fools your ears.',
    'Region gain': 'Select part of the track and preview turning it up or down, the way you would automate it in your DAW.',
    'Reference': 'Load a released track to compare against. Both play at the same loudness, and MasterScope lists where yours differs most.',
    'Version history': 'Every file you analyse is saved in this browser (numbers only), so you can compare mixes and see what changed.',
    'PDF export': 'A designed, multi-page report with every measurement and graph, to keep or share with collaborators.',
  };
  if ($('features')) $('features').innerHTML = FEATURES.map(([ic, title, desc, tags]) => `
    <div class="feature">
      <div class="f-head"><div class="f-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[ic]}</svg></div><h3>${title}</h3></div>
      <p>${desc}</p><ul>${tags.map(t => `<li${TIPS[t] ? ` class="has-tip" tabindex="0" data-tip="${esc(TIPS[t])}"` : ''}>${t}</li>`).join('')}</ul>
    </div>`).join('');

  // One shared tooltip, positioned above (or below) the pill and kept on screen
  (function tooltips() {
    const tip = document.createElement('div');
    tip.className = 'tip'; tip.id = 'tip'; tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    let current = null;
    function show(el) {
      current = el;
      tip.textContent = el.dataset.tip;
      el.setAttribute('aria-describedby', 'tip');
      tip.classList.add('show');
      const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, m = 8;
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(m, Math.min(window.innerWidth - tw - m, left));
      const below = r.top - th - 10 < m;
      const top = below ? r.bottom + 10 : r.top - th - 10;
      tip.style.left = left + window.scrollX + 'px';
      tip.style.top = top + window.scrollY + 'px';
      tip.classList.toggle('below', below);
      tip.style.setProperty('--ax', (r.left + r.width / 2 - left) + 'px');
    }
    function hide() {
      if (current) current.removeAttribute('aria-describedby');
      current = null; tip.classList.remove('show');
    }
    const pill = e => e.target.closest && e.target.closest('.has-tip');
    let lastTouch = 0; // browsers fire emulated mouse events after a tap; ignore them
    const recentTouch = () => Date.now() - lastTouch < 1000;
    document.addEventListener('mouseover', e => { if (recentTouch()) return; const el = pill(e); if (el && el !== current) show(el); });
    document.addEventListener('mouseout', e => { if (recentTouch()) return; const el = pill(e); if (el && !el.contains(e.relatedTarget)) hide(); });
    document.addEventListener('focusin', e => { if (recentTouch()) return; const el = pill(e); if (el) show(el); });
    document.addEventListener('focusout', e => { if (pill(e) && !recentTouch()) hide(); });
    // touch: tap a pill to toggle, tap anywhere else to close
    // (focus and emulated mouse events also fire on a tap, so remember the state at touch-down)
    let wasOpen = false;
    document.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { lastTouch = Date.now(); const el = pill(e); wasOpen = !!el && el === current; } });
    document.addEventListener('pointerup', e => {
      if (e.pointerType !== 'touch') return;
      lastTouch = Date.now();
      const el = pill(e);
      if (el) { if (wasOpen) { hide(); el.blur(); } else show(el); } else hide();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', () => { if (current) show(current); }, { passive: true });
    window.addEventListener('resize', hide);
  })();

  // ===================================================================
  // Opening files
  // ===================================================================
  const fileInput = $('fileInput');
  $('dropzone').addEventListener('click', () => fileInput.click());
  if ($('lpFinalDrop')) $('lpFinalDrop').addEventListener('click', () => fileInput.click());
  $('openAnotherBtn').addEventListener('click', () => fileInput.click());
  // Side menu for phones with a track open
  (() => {
    const dr = $('navDrawer'), tg = $('navToggle');
    if (!dr || !tg) return;
    const set = open => {
      dr.classList.toggle('open', open); dr.setAttribute('aria-hidden', String(!open));
      tg.setAttribute('aria-expanded', String(open));
      document.documentElement.classList.toggle('drawer-open', open);
      if (open) dr.querySelector('.nav-drawer-head button').focus(); else tg.focus({ preventScroll: true });
    };
    tg.addEventListener('click', () => set(!dr.classList.contains('open')));
    dr.querySelectorAll('[data-close], .drawer-nav a').forEach(el => el.addEventListener('click', () => set(false)));
    $('drawerOpenBtn').addEventListener('click', () => { set(false); fileInput.click(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && dr.classList.contains('open')) set(false); });
    matchMedia('(min-width: 641px)').addEventListener('change', e => { if (e.matches && dr.classList.contains('open')) set(false); });
  })();
  if ($('openAnotherTabBtn')) $('openAnotherTabBtn').addEventListener('click', () => fileInput.click());
  // tapping the landing wave (or its note) opens the file picker too, handy on phones
  ['lpRidges', 'lpRidgeNote'].forEach(id => { if ($(id)) $(id).addEventListener('click', () => fileInput.click()); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ''; });
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  // Read sample rate / bit depth from the header so we can decode without resampling
  function sniffFormat(ab) {
    const v = new DataView(ab), str = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(o + i)); return s; };
    try {
      const id = str(0, 4);
      if ((id === 'RIFF' || id === 'RF64') && str(8, 4) === 'WAVE') {
        let o = 12;
        while (o + 8 <= v.byteLength) {
          const cid = str(o, 4), size = v.getUint32(o + 4, true);
          if (cid === 'fmt ') return { format: 'WAV', sampleRate: v.getUint32(o + 12, true), bitDepth: v.getUint16(o + 22, true), float: v.getUint16(o + 8, true) === 3 };
          o += 8 + size + (size & 1);
        }
        return { format: 'WAV' };
      }
      if (id === 'FORM' && (str(8, 4) === 'AIFF' || str(8, 4) === 'AIFC')) {
        let o = 12;
        while (o + 8 <= v.byteLength) {
          const cid = str(o, 4), size = v.getUint32(o + 4, false);
          if (cid === 'COMM') {
            const bits = v.getUint16(o + 14, false);
            const exp = v.getUint16(o + 16, false) & 0x7fff, hi = v.getUint32(o + 18, false);
            const rate = Math.round(hi * Math.pow(2, exp - 16383 - 31));
            return { format: 'AIFF', sampleRate: rate, bitDepth: bits };
          }
          o += 8 + size + (size & 1);
        }
        return { format: 'AIFF' };
      }
      if (id === 'fLaC') {
        const b = o => v.getUint8(8 + o);
        const rate = (b(10) << 12) | (b(11) << 4) | (b(12) >> 4);
        const bits = (((b(12) & 1) << 4) | (b(13) >> 4)) + 1;
        return { format: 'FLAC', sampleRate: rate, bitDepth: bits };
      }
      if (str(0, 3) === 'ID3' || (v.getUint8(0) === 0xff && (v.getUint8(1) & 0xe0) === 0xe0)) return { format: 'MP3', lossy: true };
      if (str(4, 4) === 'ftyp') return { format: 'M4A/AAC', lossy: true };
      if (id === 'OggS') return { format: 'Ogg', lossy: true };
    } catch (e) {}
    return { format: 'Audio' };
  }

  async function ensureContext(rate) {
    if (audioCtx && (!rate || audioCtx.sampleRate === rate)) return audioCtx;
    stopEverything();
    let ctx = null;
    if (rate) { try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate }); } catch (e) { ctx = null; } }
    if (!ctx && audioCtx) return audioCtx;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    audioCtx = ctx; chain = null;
    return audioCtx;
  }

  async function openFile(file) {
    if (/\.json$/i.test(file.name)) return openSession(file);
    stopEverything();
    const onLanding = currentView === 'landing' && window.LP;
    if (onLanding) LP.startProgress(file.name); else showView('progress');
    $('progressFile').textContent = file.name;
    setProgress(0.02, 'Reading file…');
    await tick();
    let ab;
    try { ab = await file.arrayBuffer(); } catch (e) { return failOpen('Couldn’t read that file.'); }
    const info = sniffFormat(ab);
    info.size = file.size;
    await ensureContext(info.sampleRate);
    setProgress(0.06, 'Decoding audio…');
    await tick();
    let decoded;
    try { decoded = await audioCtx.decodeAudioData(ab.slice(0)); }
    catch (e) { return failOpen('This file couldn’t be decoded. Try WAV, AIFF, FLAC or MP3.'); }
    if (decoded.duration < 3) return failOpen('That file is shorter than 3 seconds, too short to analyse.');
    if (onLanding) await LP.morphTo(decoded);
    await analyse(decoded, file.name, info);
  }
  function failOpen(msg) {
    if (window.LP) LP.endProgress();
    if (S.buffer && !chain) setupChain();
    showView(S.buffer ? 'app' : 'landing');
    toast(msg, 5000);
  }

  function setProgress(frac, label) {
    $('progressBar').style.width = Math.round(frac * 100) + '%';
    $('progressStep').textContent = label;
    if ($('lpProgressBar')) { $('lpProgressBar').style.width = Math.round(frac * 100) + '%'; $('lpProgressStep').textContent = label; }
  }

  function showView(which) {
    currentView = which;
    document.body.classList.toggle('landing-page', which === 'landing');
    if (which === 'landing' && window.LP) LP.onShow();
    document.querySelectorAll('.site-nav a').forEach(a => a.classList.toggle('active',
      a.dataset.route === which || (a.dataset.route === 'analyse' && ['landing', 'app', 'progress', 'session'].includes(which))));
    $('landing').classList.toggle('hidden', which !== 'landing');
    $('progress').classList.toggle('hidden', which !== 'progress');
    $('app').classList.toggle('hidden', which !== 'app');
    $('session').classList.toggle('hidden', which !== 'session');
    const inApp = which === 'app';
    $('tabbar').classList.toggle('hidden', !inApp);
    $('transport').classList.toggle('hidden', !inApp);
    $('fileChip').classList.toggle('hidden', !inApp);
    $('openAnotherBtn').classList.toggle('hidden', !inApp && which !== 'session');
    document.body.classList.toggle('has-transport', inApp);
  }

  // ===================================================================
  // Navigation within the analyser (Learn, Liminal etc. are separate pages)
  // ===================================================================
  let currentView = 'landing';
  document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); if (isPlaying) pause(); showView('landing'); window.scrollTo(0, 0); });
  // "Analyse" shows the results if a track is open, otherwise the landing page (no reload)
  document.querySelectorAll('a[data-route="analyse"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showView(S.buffer ? 'app' : 'landing'); window.scrollTo(0, 0); }));

  // ===================================================================
  // Analysis pipeline
  // ===================================================================
  async function analyse(buffer, name, info) {
    setMeterSongMode(null);
    const fs = buffer.sampleRate;
    const steps = [
      ['Measuring loudness', () => { S.loud = DSP.loudness(buffer); }],
      ['Checking true peak', () => { S.tp = DSP.truePeak(buffer); S.codec = DSP.codecPeak(buffer); }],
      ['Measuring levels', () => { S.mono = DSP.mixToMono(buffer); S.levels = DSP.levels(buffer, S.mono); }],
      ['Analysing tonal balance', () => { S.tone = DSP.tonal(S.mono, fs); S.specBars = DSP.logBars(S.tone.psd, S.tone.binHz, 20, Math.min(20000, fs / 2), 140); }],
      ['Analysing the stereo image', () => { S.sf = DSP.stereoField(buffer); S.corr = DSP.correlation(buffer); S.vs = DSP.vectorscopePoints(buffer, 30000); }],
      ['Building the spectrogram', () => { S.spec = DSP.spectrogram(S.mono, fs, buffer.duration, 640, 4096); S.specImage = null; }],
      ['Detecting hits and transients', () => { S.trans = DSP.transients(S.mono, fs); }],
      ['Tracing the loudest peaks', () => { const plr = S.tp.truePeakDb - S.loud.integrated; S.peaks = DSP.peakSources(buffer, S.mono, S.trans ? S.trans.hitTimesSec : null, Math.max(0, plr - DSP.PLR_BUDGET)); }],
      ['Finding what the limiter has to fight', () => { S.louder = DSP.louder(buffer, S.tone, S.peaks ? S.peaks.list : null, louderBase()); }],
      ['Testing tone moves', () => { S.eqMoves = DSP.mixMoves(buffer, louderBase()); }],
    ];
    function louderBase() { return { plr: S.tp.truePeakDb - S.loud.integrated, lufs: S.loud.integrated, truePeak: S.tp.truePeakDb }; }
    for (let i = 0; i < steps.length; i++) {
      setProgress(0.1 + 0.85 * i / steps.length, steps[i][0] + '…');
      await tick();
      steps[i][1]();
    }
    setProgress(1, 'Done');

    S.buffer = buffer; S.fileName = name; S.fileInfo = info;
    S.selection = null; S.quietRegions = []; S.adjusted = null;
    playOffset = 0; S.mastered = null; if (abMode === 'mastered') abMode = 'normalized';
    if (S.ref) S.ref.bars = refBarsFor(S.ref);

    const L = S.loud, T = S.tone, lv = S.levels, sf = S.sf;
    S.metrics = {
      lufs: L.integrated, lra: L.lra, maxShortTerm: L.maxShortTerm, maxMomentary: L.maxMomentary,
      truePeak: S.tp.truePeakDb, codecPeak: S.codec, samplePeak: lv.samplePeakDb, rms: lv.rmsDb, crest: lv.crest,
      plr: S.tp.truePeakDb - L.integrated,
      tilt: T.tilt, lowMidPresenceGap: T.lowMidPresenceGap, subBassGap: T.subBassGap, lowMidBump: T.lowMidBump, airGap: T.airGap,
      corr: S.corr, width: sf ? sf.overallWidth : NaN, bassWidth: sf ? sf.bassWidth : NaN,
      lowWidth: sf ? sf.lowWidth : NaN, lowPeakWidth: sf ? sf.lowPeakWidth : NaN, lowPeakFreq: sf ? sf.lowPeakFreq : 0,
      clippedSamples: lv.clippedSamples, clipPct: lv.clipPct, dcOffset: lv.dcOffset,
      transient: S.trans, peaks: S.peaks,
      louder: S.louder, eqMoves: S.eqMoves,
      limited: DSP.looksLimited(S.tp.truePeakDb - L.integrated, S.peaks),
      dips: DSP.energyDips(L, buffer.duration),
      hotspots: DSP.peakHotspots(S.peaks ? S.peaks.list : null, buffer.duration),
    };
    S.findings = DSP.findings(S.metrics);
    if (S.fileInfo && S.fileInfo.lossy) S.findings.push({ cat: 'loudness', status: 'info', title: 'Lossy source file',
      body: `This is a ${S.fileInfo.format} file. Encoding changes true peak and removes some high-frequency detail, so analyse the lossless master where you can.` });

    setupChain();
    resetEq();
    renderAll();
    showView('app');
    setTab(S.activeTab || 'overview');
    saveHistory();
  }

  // ===================================================================
  // Rendering: text panels
  // ===================================================================
  const STATUS_ICON = {
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M12 5v9M12 19v.5"/></svg>',
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><path d="M12 11v8M12 5v.5"/></svg>',
  };
  const CAT_TAB = { loudness: 'Loudness', tone: 'Tone', stereo: 'Stereo', dynamics: 'Dynamics' };
  const SEV = { danger: 0, warn: 1, info: 2, ok: 3 };

  function findingHtml(f, withLink) {
    return `<div class="finding ${f.status}"><div class="ic">${STATUS_ICON[f.status]}</div>
      <div><div class="ft">${esc(f.title)}</div><div class="fb">${esc(f.body)}</div></div>
      ${withLink ? `<button class="btn sm ghost go" data-goto="${f.cat}">${CAT_TAB[f.cat]} →</button>` : '<span></span>'}</div>`;
  }

  function renderFindings() {
    const sorted = S.findings.slice().sort((a, b) => SEV[a.status] - SEV[b.status]);
    const issues = sorted.filter(f => f.status === 'warn' || f.status === 'danger');
    const passed = sorted.filter(f => f.status === 'ok' || f.status === 'info');
    $('topActions').innerHTML = issues.length ? issues.map(f => findingHtml(f, true)).join('')
      : '<div class="empty">Nothing stood out. Every check is within a typical range, so trust your ears and compare against a reference.</div>';
    $('passedSummary').textContent = `Checks that passed (${passed.length})`;
    $('passedList').innerHTML = passed.map(f => findingHtml(f, true)).join('');
    $('passedWrap').classList.toggle('hidden', !passed.length);
    document.querySelectorAll('[data-findings]').forEach(el => {
      const list = sorted.filter(f => f.cat === el.dataset.findings);
      el.innerHTML = list.length ? list.map(f => findingHtml(f, false)).join('') : '<div class="empty">No findings in this area.</div>';
    });
    document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { setTab(b.dataset.goto); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
    // tab badges
    document.querySelectorAll('.tab').forEach(tab => {
      const old = tab.querySelector('.badge'); if (old) old.remove();
      const cat = tab.dataset.tab;
      const list = S.findings.filter(f => f.cat === cat && (f.status === 'warn' || f.status === 'danger'));
      if (list.length) {
        const b = document.createElement('span');
        b.className = 'badge' + (list.some(f => f.status === 'danger') ? ' danger' : '');
        b.textContent = list.length; b.title = `${list.length} issue${list.length > 1 ? 's' : ''}`;
        tab.appendChild(b);
      }
    });
  }

  function tile(label, value, unit, status, verdict) {
    return `<div class="tile"><div class="label" title="${esc(label)}">${status ? `<span class="dot ${status}"></span>` : ''}<span class="lt">${label}</span></div>
      <div class="value">${value}${unit ? `<small>${unit}</small>` : ''}</div>${verdict ? `<div class="verdict">${verdict}</div>` : ''}</div>`;
  }

  function tiltStatus(t) { return t < -4.5 || t > 1.5 ? 'danger' : (t < -3 || t > 0.5 ? 'warn' : 'ok'); }
  function corrStatus(c) { return c < -0.1 ? 'danger' : c < 0.25 ? 'warn' : 'ok'; }

  function lowWidthStatus(m) { return (m.lowWidth > 12 || m.lowPeakWidth > 25) ? 'warn' : 'ok'; }
  function widthBelow60() {
    const sf = S.sf; if (!sf) return NaN;
    if (!sf.freqBins) return isFinite(sf.sub60) ? sf.sub60 : NaN;   // measured by the Meter
    let s = 0, t = 0;
    for (let k = 1; k < sf.freqBins.length && sf.freqBins[k] < 60; k++) { const e = Math.pow(10, sf.energyDb[k] / 10); s += sf.widthPct[k] * e; t += e; }
    return t > 0 ? s / t : 0;
  }
  // Headline numbers shared by the Overview tab and the PDF report
  function summaryItems() {
    const m = S.metrics;
    const R = DSP.readiness(m);
    const lufsSt = R.atTarget || R.louderByChoice ? 'ok' : 'warn';
    const codecHot = isFinite(m.codecPeak) && m.codecPeak > -0.9;
    const tpSt0 = m.truePeak > -0.1 ? 'danger' : m.truePeak > -1 + 0.05 ? 'warn' : 'ok';
    const tpSt = tpSt0 === 'ok' && codecHot ? (m.codecPeak > 0.5 ? 'danger' : 'warn') : tpSt0;
    const plrSt = { squashed: 'warn', competitive: 'ok', open: 'info', 'too-dynamic': 'warn' }[R.density];
    const tSt = tiltStatus(m.tilt);
    const cSt = corrStatus(m.corr);
    const mono = !isFinite(m.width);
    return [
      { label: 'Integrated loudness', short: 'Loudness', value: fmt(m.lufs), unit: 'LUFS', status: lufsSt, verdict: R.atTarget ? 'On target for −14' : R.louderByChoice ? `Louder by choice, PLR ${fmt(m.plr)}` : m.lufs < -14 ? `${(-14 - m.lufs).toFixed(1)} dB below −14` : `${(m.lufs + 14).toFixed(1)} dB above −14` },
      { label: 'True peak', value: fmt(m.truePeak), unit: 'dBTP', status: tpSt, verdict: tpSt0 !== 'ok' ? (tpSt0 === 'warn' ? 'Above −1 dBTP' : 'No headroom') : codecHot ? `Encodes to ${fmtSigned(m.codecPeak)} dBTP` : 'Safe headroom' },
      { label: 'Peak-to-loudness', value: fmt(m.plr), unit: 'dB', status: plrSt, verdict: { squashed: 'Heavily limited', competitive: 'Competitive density', open: 'Open (12–13 dB)', 'too-dynamic': `Over the ${DSP.PLR_BUDGET} dB budget` }[R.density] },
      { label: 'Loudness range', value: fmt(m.lra), unit: 'LU', status: m.lra > 12 ? 'info' : 'ok', verdict: m.lra > 12 ? 'Large section changes' : 'Consistent sections' },
      { label: 'Tonal tilt', value: fmtSigned(m.tilt), unit: 'dB/oct', status: tSt, verdict: m.tilt < -4.5 ? 'Very dark' : m.tilt < -3 ? 'Dark-leaning' : m.tilt > 1.5 ? 'Very bright' : m.tilt > 0.5 ? 'Bright-leaning' : 'Typical balance' },
      { label: 'Phase correlation', short: 'Correlation', value: fmtSigned(m.corr, 2), unit: '', status: cSt, verdict: cSt === 'ok' ? 'Mono-safe' : cSt === 'warn' ? 'Very wide' : 'Cancels in mono' },
      { label: 'Stereo width', value: mono ? '—' : m.width.toFixed(0), unit: mono ? '' : '%', status: 'info', verdict: mono ? 'Mono file' : 'Energy in the sides' },
      { label: 'Bass width 60–200 Hz', short: 'Bass width', value: mono ? '—' : m.lowWidth.toFixed(0), unit: mono ? '' : '%', status: mono ? 'info' : lowWidthStatus(m), verdict: mono ? 'Mono file' : lowWidthStatus(m) === 'ok' ? 'Centred low end' : `Wide around ${m.lowPeakFreq} Hz` },
    ];
  }
  function renderSummary() {
    $('summaryTiles').innerHTML = summaryItems().map(t => tile(t.label, t.value, t.unit, t.status, t.verdict)).join('');
  }

  function renderFileInfo() {
    const b = S.buffer, i = S.fileInfo || {};
    $('fileName').textContent = S.fileName;
    $('fileName').title = S.fileName;
    const bits = i.bitDepth ? `${i.bitDepth}-bit${i.float ? ' float' : ''}` : '';
    $('fileMeta').textContent = [fmtTime(b.duration), `${(b.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz`, bits].filter(Boolean).join(' · ');
    const ch = b.numberOfChannels === 1 ? 'mono' : b.numberOfChannels === 2 ? 'stereo' : b.numberOfChannels + ' channels';
    const fmtName = i.format && !/demo/i.test(i.format) ? i.format : '';
    $('fileMeta').textContent = [fmtTime(b.duration), `${(b.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz`, bits, ch, fmtName].filter(Boolean).join(' · ');
    $('fileMeta').title = [S.fileName, i.format, i.size ? (i.size / 1048576).toFixed(1) + ' MB' : '',
      i.sampleRate && i.sampleRate !== b.sampleRate ? `resampled from ${i.sampleRate} Hz by the browser` : ''].filter(Boolean).join(' · ');
  }

  function renderLoudnessTiles() {
    const m = S.metrics;
    $('loudTiles').innerHTML =
      tile('Integrated', fmt(m.lufs), 'LUFS') + tile('Max short-term', fmt(m.maxShortTerm), 'LUFS') +
      tile('Max momentary', fmt(m.maxMomentary), 'LUFS') + tile('True peak', fmt(m.truePeak), 'dBTP') +
      tile('Sample peak', fmt(m.samplePeak), 'dBFS') + tile('Codec peak (est.)', isFinite(m.codecPeak) ? fmtSigned(m.codecPeak) : '—', 'dBTP', !isFinite(m.codecPeak) ? null : m.codecPeak > 0.05 ? 'danger' : m.codecPeak > -0.9 ? 'warn' : 'ok') +
      tile('Loudness range', fmt(m.lra), 'LU') + tile('PLR', fmt(m.plr), 'dB') + tile('RMS', fmt(m.rms), 'dBFS');
  }

  const PLATFORMS = [
    ['Spotify', -14, 'Normal setting'], ['Apple Music', -16, 'Sound Check'], ['YouTube', -14, 'Reduces only'],
    ['Tidal', -14, 'Default'], ['Amazon Music', -14, 'Default'], ['Deezer', -15, 'Default'],
  ];
  function renderPlatforms() {
    const m = S.metrics;
    if (!isFinite(m.lufs)) { $('platforms').innerHTML = '<div class="empty">Not enough signal to estimate.</div>'; return; }
    $('platforms').innerHTML = PLATFORMS.map(([n, target, note]) => {
      let adj = target - m.lufs, capped = false;
      if (n === 'YouTube' && adj > 0) adj = 0;
      if (adj > 0 && m.truePeak + adj > -1) { adj = Math.max(0, -1 - m.truePeak); capped = true; }
      const peak = m.truePeak + adj;
      const cls = adj < -0.15 ? 'down' : adj > 0.15 ? 'up' : 'same';
      const arrow = cls === 'down' ? '▼' : cls === 'up' ? '▲' : '•';
      return `<div class="platform"><div class="pn">${n}</div><div class="pt">${fmt(target, 0)} LUFS · ${note}</div>
        <div class="pa ${cls}">${arrow} ${fmtSigned(adj)} dB</div>
        <div class="pr ${peak > -1 ? 'danger' : ''}">${capped ? 'Held back by peak headroom' : `Peak after: ${fmt(peak)} dBTP`}</div></div>`;
    }).join('');
  }

  function renderToneTiles() {
    const m = S.metrics;
    $('toneTiles').innerHTML =
      tile('Tilt 63 Hz–8 kHz', fmtSigned(m.tilt), 'dB/oct', tiltStatus(m.tilt)) +
      tile('Low-mid bump', fmtSigned(m.lowMidBump), 'dB', m.lowMidBump > 3 ? 'warn' : 'ok') +
      tile('Presence vs low mids', fmtSigned(m.lowMidPresenceGap), 'dB', null) +
      tile('Sub vs bass', fmtSigned(m.subBassGap), 'dB', m.subBassGap > 4 ? 'warn' : 'ok') +
      tile('Air vs mids', fmtSigned(m.airGap), 'dB', null);
    const leg = [`<span><i style="background:var(--accent)"></i>This track</span>`, `<span><i style="background:var(--text-faint)"></i>Pink noise (0 dB)</span>`];
    if (S.ref) leg.push(`<span><i style="background:var(--ref)"></i>Reference: ${esc(S.ref.name)}</span>`);
    $('tonalLegend').innerHTML = leg.join('');
  }

  function renderStereoTiles() {
    const m = S.metrics;
    $('stereoTiles').innerHTML = isFinite(m.width)
      ? tile('Overall width', m.width.toFixed(0), '%') + tile('Width 60–200 Hz', m.lowWidth.toFixed(0), '%', lowWidthStatus(m), isFinite(m.lowPeakWidth) && m.lowPeakFreq ? `Widest around ${m.lowPeakFreq} Hz (${m.lowPeakWidth.toFixed(0)}%)` : '') + tile('Width below 60 Hz', isFinite(widthBelow60()) ? widthBelow60().toFixed(0) : '—', '%')
      : '<div class="empty">Mono file: there is no stereo image to measure.</div>';
  }

  function renderDynamics() {
    const m = S.metrics, t = S.trans;
    $('dynTiles').innerHTML =
      tile('Peak-to-loudness', fmt(m.plr), 'dB', m.plr < 7 ? 'warn' : m.plr > 16 ? 'info' : 'ok') +
      tile('Loudness range', fmt(m.lra), 'LU', m.lra > 12 ? 'info' : 'ok') +
      tile('Crest factor', fmt(m.crest), 'dB') +
      tile('Loudest 3 s vs average', fmtSigned(m.maxShortTerm - m.lufs), 'LU');
    if (!t) { $('transTiles').innerHTML = '<div class="empty">No clear repeated hits were found, so this track may not be drum-driven.</div>'; return; }
    const na = v => v === null || v === undefined;
    const kickSep = !na(t.kickRiseDb) && t.kickRiseDb >= 6;
    $('transTiles').innerHTML =
      tile('Hits detected', t.hitCount, '') +
      tile('Hit level vs mix', fmtSigned(t.hitVsRmsDb), 'dB', t.hitVsRmsDb > 13 || t.hitVsRmsDb < 3 ? 'warn' : 'ok') +
      tile('Kick rise 50–90 Hz', fmt(t.kickRiseDb), 'dB', na(t.kickRiseDb) ? null : (kickSep ? 'ok' : 'warn'), kickSep ? 'Hits stand clear' : 'Low end sustains under hits') +
      tile('Kick settle time', kickSep && !na(t.kickDecay) ? t.kickDecay : '—', kickSep && !na(t.kickDecay) ? 'ms' : '', null, kickSep ? '' : 'Can’t isolate the kick') +
      tile('Bass settle 60–250 Hz', na(t.bassDecay) ? '—' : t.bassDecay, na(t.bassDecay) ? '' : 'ms', null, na(t.bassDecay) ? 'Doesn’t settle between hits' : '') +
      tile('Attack settle 1–3 kHz', na(t.clickDecay) ? '—' : t.clickDecay, na(t.clickDecay) ? '' : 'ms') +
      tile('Low vs mids at hits', fmtSigned(t.lowVsMidDb), 'dB', t.lowVsMidDb > 24 ? 'warn' : null);
  }

  // ===================================================================
  // −14 readiness, peaks & density
  // ===================================================================
  const SRC_META = {
    hits: ['Drum hits & transients', 'var(--accent)'],
    kickbass: ['Kick & low-end hits', 'var(--warn)'],
    low: ['Sustained bass', 'var(--danger)'],
    other: ['Sustained parts', 'var(--info)'],
  };
  const SRC_ADVICE = {
    hits: 'Most come from drum hits and other transients, so gentle clipping or fast limiting on the drum bus (or the soft clipper in Master to −14) takes them off cleanly.',
    kickbass: 'Most are kick or other low-end hits. Clip or fast-limit the kick a little, and sidechain the bass to it where they overlap.',
    low: 'Most come from sustained bass or sub notes, so compress or saturate the bass, or tame the deepest sub.',
    other: 'Most come from sustained parts rather than hits (often vocals, leads or pads), so compress or clip-gain the loudest part before the master limiter.',
  };
  const fmtPct = v => !isFinite(v) ? '—' : v < 0.01 ? '<0.01%' : v.toFixed(v < 0.1 ? 3 : v < 1 ? 2 : 1) + '%';

  function budgetHtml(plr, refPlr) {
    const lo = 4, hi = 18, pos = v => (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * 100;
    const z = (a, b, cls) => `<div class="b-zone ${cls}" style="width:${pos(b) - pos(a)}%"></div>`;
    return `<div class="budget${isFinite(refPlr) ? ' has-ref' : ''}">
      <div class="b-label"><span>Peak-to-loudness ratio (PLR)</span><span>−14 LUFS at −1 dBTP leaves room for ${DSP.PLR_BUDGET} dB</span></div>
      <div class="b-track">${z(lo, 8, 'z-sq')}${z(8, 12, 'z-comp')}${z(12, 13, 'z-open')}${z(13, hi, 'z-over')}
        <div class="b-limit" style="left:${pos(13)}%"></div>
        ${isFinite(refPlr) ? `<div class="b-mark ref" style="left:${pos(refPlr)}%"><span>Reference ${fmt(refPlr)}</span></div>` : ''}
        <div class="b-mark" style="left:${pos(plr)}%"><span>${fmt(plr)} dB</span></div>
      </div>
      <div class="b-ticks">${[4, 6, 8, 10, 12, 14, 16, 18].map(v => `<span style="left:${pos(v)}%">${v}</span>`).join('')}</div>
      <div class="b-zones-legend"><span><i class="z-sq"></i>Squashed (under 8)</span><span><i class="z-comp"></i>Competitive (8–12)</span><span><i class="z-open"></i>Open (12–13)</span><span><i class="z-over"></i>Can't reach −14 (over 13)</span></div>
    </div>`;
  }

  function readinessSteps(R, m) {
    const steps = [], p = S.peaks;
    if (R.peakCut > 0.05 && p && p.pctAbove < 0.1 && m.truePeak > -1.3) {
      steps.push(`<b>Raise your master limiter's input by ${(-14 - m.lufs).toFixed(1)} dB, keeping the ceiling at −1.0 dBTP.</b> <span>That takes the ${R.peakCut.toFixed(1)} dB off the peaks and lands on −14 in one move. Only ${fmtPct(p.pctAbove)} of the audio sits in the top ${p.cutDb.toFixed(1)} dB, so the extra limiting should be inaudible.</span>`);
    } else if (R.peakCut > 0.05) {
      steps.push(`<b>Take about ${R.peakCut.toFixed(1)} dB off the peaks.</b> <span>${p ? SRC_ADVICE[p.dominant] + ` Only ${fmtPct(p.pctAbove)} of the audio sits in the top ${p.cutDb.toFixed(1)} dB, so it is a small change.` : ''}</span>`);
      steps.push(`<b>Then raise the level into your limiter until it reads −14.0 LUFS at −1.0 dBTP.</b> <span>About ${fmtSigned(-14 - m.lufs)} dB from where it is now.</span>`);
    } else if (R.trimOnly) {
      const d = m.lufs + 14;
      steps.push(`<b>Turn the master down ${d.toFixed(1)} dB after the limiter</b> <span>(for example a Utility at the very end of the chain). That lands on −14.0 LUFS with peaks at about ${fmt(m.truePeak - d)} dBTP, and keeps all the density you've built. Turning the limiter input down instead would undo some of it.</span>`);
    } else if (!R.tpOk) {
      steps.push(`<b>Set the limiter ceiling to −1.0 dBTP.</b> <span>True peak is ${fmt(m.truePeak)} dBTP now. Re-check the loudness afterwards.</span>`);
    } else if (!R.atTarget) {
      steps.push(m.lufs < -14
        ? `<b>Raise the limiter input by ${(-14 - m.lufs).toFixed(1)} dB.</b> <span>Your peaks have room, so it will reach −14 LUFS without going over −1 dBTP.</span>`
        : R.louderByChoice && R.codecHot
          ? `<b>Lower the limiter ceiling to about ${fmt(R.safeCeiling)} dBTP, then Learn again at a target of ${fmt(R.safeCeiling - m.plr)} LUFS.</b> <span>${isFinite(m.codecPeak) ? `Encoding raises the peaks to an estimated ${fmtSigned(m.codecPeak)} dBTP` : `Peaks are at ${fmt(m.truePeak)} dBTP`}, which can distort wherever the track plays at full level. That keeps your PLR of ${fmt(m.plr)} dB and costs ${(m.truePeak - R.safeCeiling).toFixed(1)} dB of level, which streaming services take off anyway.</span>`
          : R.louderByChoice
          ? `<b>Louder master at ${fmt(m.lufs)} LUFS, with safe peaks.</b> <span>Streaming services turn it down ${(m.lufs + 14).toFixed(1)} dB, where it plays like any −14 track at a PLR of ${fmt(m.plr)} dB; where nothing normalises (Bandcamp, downloads, DJ sets) it plays louder. Master to −14 instead only if you want a more open sound.</span>`
          : `<b>Master to −14 instead of ${fmt(m.lufs)} LUFS.</b> <span>Services turn it down ${(m.lufs + 14).toFixed(1)} dB anyway, so easing the limiter keeps more punch at no cost.</span>`);
    } else {
      steps.push(`<b>Level and peaks are on target.</b> <span>${fmt(m.lufs)} LUFS at ${fmt(m.truePeak)} dBTP.</span>`);
    }
    const after = Math.min(m.plr, DSP.PLR_BUDGET);
    if (after > 12) steps.push(`<b>For a denser, more competitive sound, aim for a PLR of 10–12 dB.</b> <span>That is another ${(after - 12).toFixed(1)}–${(after - 10).toFixed(1)} dB of peak control. Listen as you go: it trades some transient snap for fullness.</span>`);
    else if (m.plr < 8) steps.push(`<b>Ease the limiting.</b> <span>At a PLR of ${fmt(m.plr)} dB the master is denser than it needs to be at −14; backing off 1–2 dB brings back punch at no loudness cost.</span>`);
    const LM = S.louder && S.louder.moves, top = LM && LM.moves[0];
    if (top && top.pct >= 15 && LM.base.avg >= 0.02) steps.push(`<b>Biggest mix win: control the ${esc(top.name.toLowerCase())} peaks.</b> <span>Taking ${top.cutDb} dB off the loudest moments in the ${esc(top.range)} range cuts the limiting by about ${pctTxt(top.pct)}. ${esc(bandTool(top))}. See Louder at −14 on the Loudness tab.</span>`);
    if (S.ref && S.refDiffs && S.refDiffs.length) steps.push(`<b>Close the gap to your reference.</b> <span>${esc(S.refDiffs[0].text)}</span>`);
    else if (!S.ref && S.meterRef && isFinite(S.meterRef.plr) && isFinite(S.metrics.plr) && Math.abs(S.metrics.plr - S.meterRef.plr) > 1.5)
      steps.push(`<b>Match your reference's density.</b> <span>${esc(S.meterRef.name)} has a PLR of ${fmt(S.meterRef.plr)}; yours is ${fmt(S.metrics.plr)}. See the Compare tab.</span>`);
    else if (!S.ref && !S.meterRef) steps.push(`<b>Compare with a reference.</b> <span>Load a released track in your genre on the Compare tab to see where your mix differs at equal loudness.</span>`);
    return steps;
  }

  function readinessSub(R, m) {
    if (R.trimOnly) return `Peaks are ${fmt(m.truePeak)} dBTP and the level is ${fmt(m.lufs)} LUFS. A ${(m.lufs + 14).toFixed(1)} dB trim at the very end of the chain fixes both and keeps your density.`;
    if (R.peakCut > 0.05 || (!R.atTarget && m.lufs < -14)) return R.shortfall > 0.05 ? `Right now it plays ${R.shortfall.toFixed(1)} dB quieter than tracks mastered to −14 on services that won't push peaks past −1 dBTP, such as Spotify.` : 'Peaks have room; only the level needs to come up.';
    if (R.louderByChoice && R.codecHot) return `Its density is fine, but its peaks would go over after lossy encoding${isFinite(m.codecPeak) ? ` (estimated ${fmtSigned(m.codecPeak)} dBTP)` : ''}. A lower ceiling fixes it.`;
    if (R.louderByChoice) return `Streaming services turn it down ${(m.lufs + 14).toFixed(1)} dB and it keeps its density; it plays louder wherever nothing normalises.`;
    if (m.lufs > -13.5) return `Services will turn it down ${(m.lufs + 14).toFixed(1)} dB, so the extra loudness is lost and only the limiting remains.`;
    return R.density === 'open' ? 'It fits −14, but it is more open than most competitive releases.' : R.density === 'squashed' ? 'Peaks are heavily limited for a −14 master.' : 'It will play at full level next to other releases.';
  }

  // Release ready: one verdict per destination
  function releaseChecks(m) {
    const clip = (m.clippedSamples || 0) > 0 || m.samplePeak >= -0.01;
    const cp = isFinite(m.codecPeak) ? m.codecPeak : m.truePeak + 0.5, tp = m.truePeak, L = m.lufs, plr = m.plr;
    const peakCheck = (margin, name) => cp + margin <= -1 && tp <= -1 ? null
      : cp + margin <= 0 ? { key: 'codec-warn', amt: cp + margin, codec: name, st: 'warn', why: `Peaks reach about ${fmtSigned(cp + margin)} dB after ${name} encoding. Usually fine; a −1.5 dB ceiling makes sure.`, learn: 'peaks' }
      : { key: 'codec-over', amt: cp + margin, codec: name, st: 'danger', why: `Peaks go over full scale after ${name} encoding (about ${fmtSigned(cp + margin)} dB), which distorts. Lower the ceiling, or use Liminal's Streaming ceiling mode.`, learn: 'peaks' };
    const dense = plr < 7 ? { key: 'dense', st: 'warn', why: `Very dense (PLR ${fmt(plr)}): at the same loudness as other songs it can sound flatter. Ease the limiting by a dB or two.`, learn: 'density' } : null;
    const normalised = (target, name, upOnly) => {
      if (!isFinite(L)) return null;
      const up = target - L;
      if (up > 1 && (upOnly || tp + up > -1)) return { key: 'quiet', amt: upOnly ? up : Math.max(0, up - Math.max(0, tp + up + 1)), upOnly, st: 'warn', why: `Plays about ${fmt(upOnly ? up : Math.max(0, up - Math.max(0, tp + up + 1)))} dB quieter than other songs on ${name}${upOnly ? ', which never turns tracks up' : ', because there isn\u2019t peak room to turn it up'}. Master a little denser.`, learn: 'streaming' };
      return null;
    };
    const rows = [
      ['Spotify', 'Ogg Vorbis', [peakCheck(0, 'Vorbis'), normalised(-14, 'Spotify', false), dense]],
      ['Apple Music', 'AAC', [peakCheck(0.3, 'AAC'), normalised(-16, 'Apple Music', false), dense]],
      ['YouTube', 'Opus', [peakCheck(0, 'Opus'), normalised(-14, 'YouTube', true), dense]],
      ['SoundCloud', 'MP3 or AAC, about −14 LUFS', [peakCheck(1, 'MP3'),
        isFinite(L) && L > -14 && tp > -2 ? { key: 'sc-peak', st: 'warn', why: `SoundCloud turns masters louder than −14 down and recommends keeping their true peak under −2 dB, because its transcoding adds distortion. This one peaks at ${fmt(tp)} dBTP.`, learn: 'peaks' } : null,
        isFinite(L) && L < -15 ? { key: 'quiet', amt: -14 - L, st: 'warn', why: `SoundCloud normalises to about −14 LUFS; at ${fmt(L)} LUFS this may play quieter than other uploads. Master a little denser.`, learn: 'streaming' } : null, dense]],
      ['Club and DJ', 'WAV, no normalisation', [tp > -0.3 ? { key: 'club-peak', st: 'warn', why: 'Peaks at full scale: leave a little room (−0.3 to −1 dBTP) for DJ software.', learn: 'peaks' } : null,
        isFinite(L) && L < -11 ? { key: 'club-quiet', st: 'warn', why: `At ${fmt(L)} LUFS it will sound quieter than club masters (−9 to −7). Make a louder club version.`, learn: 'delivery' } : null,
        isFinite(m.corr) && m.corr < 0.2 ? { key: 'club-mono', st: 'warn', why: 'Low mono compatibility: parts can cancel on mono club systems. Keep the low end centred.', learn: 'stereo' } : null]],
    ];
    return rows.map(([name, fmtName, cs]) => {
      let list = cs.filter(Boolean);
      if (clip) list = [{ key: 'clip', st: 'danger', why: 'The file clips (samples at full scale). Re-export with a limiter ceiling below 0 dB.', learn: 'peaks' }, ...list];
      const st = list.some(c => c.st === 'danger') ? 'danger' : list.length ? 'warn' : 'ok';
      return { name, fmtName, st, list };
    });
  }
  // Group the same cause across platforms into one issue
  const ISSUE_TITLES = { 'sc-peak': 'Peaks too high for SoundCloud', 'club-peak': 'No headroom for DJ software',
    'club-quiet': 'Quieter than club masters', 'club-mono': 'Low mono compatibility', clip: 'The file clips', dense: 'Very dense' };
  function issueText(g) {
    const one = g.items.length === 1;
    if (g.key === 'quiet') {
      const amts = g.items.map(i => i.c.amt).filter(isFinite), lo = Math.min(...amts), hi = Math.max(...amts);
      const byAmt = new Map(); g.items.forEach(i => { const k = fmt(i.c.amt); byAmt.set(k, [...(byAmt.get(k) || []), i.plat]); });
      const parts = [...byAmt].map(([k, ps]) => `${k} dB on ${joinNames(ps)}`);
      const never = g.items.filter(i => i.c.upOnly).map(i => i.plat);
      return { title: `Plays ${fmt(lo) === fmt(hi) ? 'about ' + fmt(lo) : fmt(lo) + '–' + fmt(hi)} dB quieter than other songs`,
        why: one ? g.items[0].c.why : `About ${joinNames(parts)}. ${never.length ? `${joinNames(never)} never turn${never.length > 1 ? '' : 's'} quiet tracks up, and the others only as far as the peaks allow.` : 'Services only turn quiet tracks up as far as the peaks allow.'} Master a little denser so it plays at full level.` };
    }
    if (g.key === 'codec-over' || g.key === 'codec-warn') {
      const over = g.key === 'codec-over';
      return { title: over ? 'Peaks go over full scale after encoding' : 'Peaks come close to full scale after encoding',
        why: one ? g.items[0].c.why : `About ${joinNames(g.items.map(i => `${fmtSigned(i.c.amt)} dB after ${i.c.codec} (${i.plat})`))}. ${over ? 'Listeners hear that as distortion that isn\u2019t in your file. Lower the ceiling, or use Liminal\u2019s Streaming ceiling mode.' : 'Usually fine; a −1.5 dB ceiling makes sure.'}` };
    }
    return { title: ISSUE_TITLES[g.key] || 'Check', why: g.items[0].c.why };
  }
  function groupIssues(rows) {
    const by = new Map();
    rows.forEach(r => r.list.forEach(c => {
      const g = by.get(c.key) || { key: c.key, st: c.st, learn: c.learn, items: [] };
      if (c.st === 'danger') g.st = 'danger';
      g.items.push({ plat: r.name, c }); by.set(c.key, g);
    }));
    return [...by.values()].map(g => Object.assign(g, issueText(g)))
      .sort((a, b) => (b.st === 'danger') - (a.st === 'danger') || b.items.length - a.items.length);
  }

  function renderReleaseReady() {
    const m = S.metrics; if (!m) return;
    const rows = releaseChecks(m), issues = groupIssues(rows);
    const label = { ok: 'Pass', warn: 'Check', danger: 'Fix' };
    $('releaseReady').innerHTML = `
      <div class="rel-strip" role="group" aria-label="Platforms: tap one to see only its issues">${rows.map(r => `<button type="button" class="rel-chip ${r.st}" data-plat="${esc(r.name)}" aria-pressed="false" title="${esc(r.fmtName)}"><span class="rel-ic">${STATUS_ICON[r.st]}</span><b>${esc(r.name)}</b><span class="rel-v">${label[r.st]}</span></button>`).join('')}</div>
      <div class="rel-issues">${issues.length ? issues.map(g => `<div class="rel-issue ${g.st}" data-plats="${esc(g.items.map(i => i.plat).join('|'))}">
        <span class="rel-ic">${STATUS_ICON[g.st]}</span>
        <div><b>${esc(g.title)}</b><div class="rel-tags">${g.items.map(i => `<span>${esc(i.plat)}</span>`).join('')}</div>
        <p>${esc(g.why)} <a href="/learn/${g.learn}/" target="_blank" rel="noopener">Why?</a></p></div></div>`).join('')
        : '<p class="rel-allgood">Ready everywhere: nothing to fix.</p>'}
        <p class="rel-only hidden"></p></div>`;
    const chips = [...document.querySelectorAll('.rel-chip')];
    chips.forEach(ch => ch.addEventListener('click', () => {
      const on = ch.getAttribute('aria-pressed') !== 'true';
      chips.forEach(c => c.setAttribute('aria-pressed', String(on && c === ch)));
      let shown = 0;
      document.querySelectorAll('.rel-issue').forEach(el => { const vis = !on || el.dataset.plats.split('|').includes(ch.dataset.plat); el.classList.toggle('hidden', !vis); shown += vis; });
      const only = document.querySelector('.rel-only');
      only.textContent = on && !shown ? `Ready on ${ch.dataset.plat}: nothing to fix there.` : '';
      only.classList.toggle('hidden', !(on && !shown));
    }));
    renderVerdict(rows, issues);
    $('releaseSponsor').innerHTML = sponsorHtml(SITE.sponsors.release);
    $('resultSponsor').innerHTML = sponsorHtml(SITE.sponsors.result);
    track('Analysed', { ready: rows.every(r => r.st === 'ok') ? 'all' : rows.filter(r => r.st === 'ok').length + '/5' });
  }

  // The headline: one verdict, the three numbers that matter, one next step
  function renderVerdict(rows, issues) {
    const m = S.metrics, R = DSP.readiness(m);
    const pass = rows.filter(r => r.st === 'ok').length;
    const club = rows.find(r => r.name === 'Club and DJ'), streams = rows.filter(r => r !== club);
    const streamReady = streams.every(r => r.st === 'ok') && club && club.st !== 'danger';
    const st = rows.some(r => r.st === 'danger') ? 'danger' : pass === rows.length || streamReady ? 'ok' : 'warn';
    const title = pass === rows.length ? 'Release ready' : streamReady ? 'Ready for streaming' : st === 'danger' ? 'Needs a fix before release' : pass >= 3 ? 'Almost ready' : 'Not ready yet';
    const sub = pass === rows.length ? 'Passes Spotify, Apple Music, YouTube, SoundCloud and the club.'
      : streamReady ? `Passes Spotify, Apple Music, YouTube and SoundCloud. For club and DJ sets, ${club.list.some(c => c.key === 'club-quiet') ? 'make a louder version' : 'see the note below'}.`
      : `${issues[0] ? issues[0].title : R.headline}. Ready on ${pass} of ${rows.length} platforms.`;
    const cp = isFinite(m.codecPeak) ? m.codecPeak : m.truePeak;
    const cpSt = cp > 0.05 ? 'danger' : cp > -0.95 ? 'warn' : 'ok';
    const lSt = m.lufs < -15.5 ? 'warn' : m.lufs > -7 ? 'warn' : 'ok';
    const dSt = R.density === 'competitive' ? 'ok' : R.density === 'open' ? 'info' : 'warn';
    const num = (k, v, u, s2, note) => `<div class="vd-num ${s2}"><span class="vd-k">${k}</span><span class="vd-v num">${v}<small>${u}</small></span><span class="vd-n">${note}</span></div>`;
    const needsWork = st !== 'ok' && (R.peakCut > 0.05 || !R.atTarget);
    $('verdictCard').className = `panel verdict-card ${st}`;
    $('verdictCard').innerHTML = `
      <div class="vd-file" title="${esc($('fileMeta').title || '')}"><b>${esc(S.fileName)}</b><span>${esc($('fileMeta').textContent)}</span></div>
      <div class="vd-head"><div class="vd-ic">${STATUS_ICON[st]}</div><div><h2 class="vd-title">${title}</h2><p class="vd-sub">${esc(sub)}</p></div></div>
      <div class="vd-nums">
        ${num('Loudness', fmt(m.lufs), 'LUFS', lSt, m.lufs < -15.5 ? 'Quiet for streaming' : m.lufs > -7 ? 'Very loud' : 'In range for streaming')}
        ${num('Peak after encoding', fmtSigned(cp), 'dBTP', cpSt, cpSt === 'ok' ? 'Safe after streaming' : cpSt === 'warn' ? 'Close to full scale' : 'Distorts after encoding')}
        ${num('Density', fmt(m.plr), 'dB PLR', dSt, { squashed: 'Squashed', competitive: 'Competitive', open: 'Open', 'too-dynamic': 'Too open for −14' }[R.density])}
      </div>
      ${S.meterRef ? `<div class="vd-ref"><span>Against <b>${esc(S.meterRef.name)}</b> (${fmt(S.meterRef.lufs)} LUFS, PLR ${fmt(S.meterRef.plr)}): ${esc(meterRefLine(m, S.meterRef))}</span><button class="btn sm ghost" id="vdRef">Compare →</button></div>` : ''}
      <div class="vd-actions">
        ${needsWork ? '<button class="btn primary" id="vdMaster">Hear it mastered to −14 →</button>' : '<button class="btn primary" id="vdShare">Share your result</button>'}
        <a class="btn" href="/liminal/">Fix it with Liminal</a>
        <button class="btn ghost" id="vdDetails">See the details ↓</button>
      </div>`;
    if ($('vdMaster')) $('vdMaster').addEventListener('click', () => { setTab('tools'); setTimeout(() => $('masterPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); });
    if ($('vdShare')) $('vdShare').addEventListener('click', () => $('shareCardBtn').click());
    if ($('vdRef')) $('vdRef').addEventListener('click', () => { setTab('compare'); window.scrollTo(0, 0); });
    $('vdDetails').addEventListener('click', () => document.querySelector('[data-help="release"]').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function renderReadiness() {
    const m = S.metrics, R = DSP.readiness(m);
    S.readiness = R;
    $('readiness').innerHTML = `
      <div class="ready-head ${R.status}"><div class="ri">${STATUS_ICON[R.status]}</div><div><div class="rh1">${esc(R.headline)}</div><div class="rh2">${esc(readinessSub(R, m))}</div></div></div>
      ${budgetHtml(m.plr, refPlr())}
      <ol class="steps-list">${readinessSteps(R, m).map(s => `<li><div>${s}</div></li>`).join('')}</ol>
      <div class="controls" style="margin-top:16px"><button class="btn primary sm" id="goMasterBtn">Hear it mastered to −14 →</button></div>`;
    $('goMasterBtn').addEventListener('click', () => { setTab('tools'); setTimeout(() => $('masterPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); });
  }

  function srcBarHtml(p) {
    const keys = Object.keys(SRC_META);
    return `<div class="src-bar">${keys.map(k => p.shares[k] > 0 ? `<div style="width:${p.shares[k] * 100}%;background:${SRC_META[k][1]}" title="${SRC_META[k][0]} ${Math.round(p.shares[k] * 100)}%"></div>` : '').join('')}</div>
      <div class="src-legend">${keys.map(k => `<span><i style="background:${SRC_META[k][1]}"></i>${SRC_META[k][0]}<b>${Math.round(p.shares[k] * 100)}%</b></span>`).join('')}</div>`;
  }

  function renderPeaksDensity() {
    const m = S.metrics, R = S.readiness, p = S.peaks;
    $('peaksDensity').innerHTML = `
      ${budgetHtml(m.plr, refPlr())}
      <div class="pd-grid" style="margin-top:22px">
        <div><h3>Where the loudest peaks come from</h3>${p ? srcBarHtml(p) + `<p class="pd-text">${p.events.toLocaleString()} peaks within 3 dB of the maximum, about ${Math.round(p.eventsPerMin)} a minute. ${SRC_ADVICE[p.dominant]}</p>` : (S.meterSong ? '<p class="pd-text">Tracing where the peaks come from needs the audio file.</p>' : '<p class="pd-text">No peaks found.</p>')}</div>
        <div><h3>What reaching −14 takes</h3><div class="tiles cols-2">
          ${tile('Peak control needed', R.peakCut > 0.05 ? R.peakCut.toFixed(1) : '0.0', 'dB', R.peakCut > 0.05 ? 'warn' : 'ok', 'to fit under −1 dBTP')}
          ${tile('Audio affected', p ? fmtPct(p.pctAbove) : '—', '', null, p ? `in the top ${p.cutDb.toFixed(1)} dB` : '')}
          ${tile('Plays at now', fmt(R.playbackLufs), 'LUFS', R.shortfall > 0.2 ? 'warn' : 'ok', 'on peak-limited services')}
          ${tile('Density', fmt(m.plr), 'dB PLR', R.density === 'competitive' ? 'ok' : R.density === 'open' ? 'info' : 'warn', { squashed: 'Squashed', competitive: 'Competitive', open: 'Open', 'too-dynamic': 'Over budget' }[R.density])}
        </div></div>
      </div>`;
  }

  // ===================================================================
  // Louder at −14: loudness budget, peak-control moves, tone moves
  // ===================================================================
  const bandTool = mv => DSP.bandAdvice(mv.key, mv.hitShare, false);
  const pctTxt = v => `${Math.round(Math.abs(v))}%`;
  const joinNames = arr => arr.length < 2 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  function budgetLead(B) {
    const sum = (list, k) => Math.round(list.reduce((a, b) => a + b[k], 0) * 100);
    const parts = [];
    if (B.costly.length) parts.push(`<b>${esc(joinNames(B.costly.map(b => b.name.toLowerCase())))}</b> make${B.costly.length > 1 ? '' : 's'} ${sum(B.costly, 'peakShare')}% of your peak height but only ${sum(B.costly, 'loudShare')}% of your loudness.`);
    if (B.efficient.length) parts.push(`<b>${esc(joinNames(B.efficient.map(b => b.name.toLowerCase())))}</b> give${B.efficient.length > 1 ? '' : 's'} ${sum(B.efficient, 'loudShare')}% of the loudness for ${sum(B.efficient, 'peakShare')}% of the peaks.`);
    if (!parts.length) parts.push('Each range costs roughly as much peak room as it gives in loudness, so no single range is holding the level back.');
    return parts.map(t => t.replace(/^<b>(.)/, (x, c) => '<b>' + c.toUpperCase())).join(' ');
  }
  function movesLead(M) {
    const top = M.moves[0];
    if (!top || M.base.avg < 0.02) return 'The limiter barely has to work at this density, so there is little to gain here.';
    if (top.pct < 10) return `No single range stands out: controlling any one of them changes the limiting by less than 10%.`;
    return `Controlling the <b>${esc(top.name.toLowerCase())}</b> cuts the limiting most, by about ${pctTxt(top.pct)}.`;
  }
  function moveBar(pct) {
    const w = Math.min(50, Math.abs(pct) / 50 * 50); // ±50% fills half the track
    return `<div class="mv-axis">${Math.abs(pct) >= 1 ? `<div class="mv-fill ${pct > 0 ? 'good' : 'bad'}" style="width:${w}%"></div>` : ''}</div>`;
  }
  const moveCls = pct => pct >= 3 ? 'good' : pct <= -3 ? 'bad' : 'flat';
  const moveVal = pct => Math.abs(pct) < 3 ? 'no change' : `${pct > 0 ? '−' : '+'}${pctTxt(pct)} limiting`;
  function louderHtml(forReport, extraRight) {
    const m = S.metrics, L = S.louder, E = S.eqMoves;
    if (!L || !L.budget) return '<div class="empty">Not enough peaks to analyse.</div>';
    const B = L.budget, M = L.moves, maxShare = Math.max(...B.bands.map(b => Math.max(b.peakShare, b.loudShare)), 0.01);
    const notice = m.limited ? `<div class="lb-notice"><b>This file has already been limited.</b> These numbers show what the limiter is fighting now. For the clearest picture of the mix, bounce it with the master limiter off and open that file.</div>` : '';
    const budget = `<div class="lb-sec"><h3 class="mini-h">Where your loudness comes from</h3>
      <p class="lb-lead">${budgetLead(B)}</p>
      <div class="lb-rows">${B.bands.map(b => {
        const cost = B.costly.includes(b), eff = B.efficient.includes(b);
        return `<div class="lb-row"><div class="lb-name">${esc(b.name)}<small>${esc(b.range)}</small></div>
          <div class="lb-bars">
            <div class="lb-bar" title="Share of the height of the loudest peaks"><div class="lb-track"><div class="lb-fill peak" style="width:${b.peakShare / maxShare * 100}%"></div></div><span class="lb-val">${Math.round(b.peakShare * 100)}%</span></div>
            <div class="lb-bar" title="Share of the loudness (LUFS) of the track"><div class="lb-track"><div class="lb-fill loud" style="width:${b.loudShare / maxShare * 100}%"></div></div><span class="lb-val">${Math.round(b.loudShare * 100)}%</span></div>
          </div>
          <div class="lb-tag ${cost ? 'cost' : eff ? 'eff' : ''}">${cost ? 'Costs peak room' : eff ? 'Efficient' : ''}</div></div>`;
      }).join('')}</div>
      <div class="lb-legend"><span><i style="background:var(--warn)"></i>Peak height</span><span><i style="background:var(--accent)"></i>Loudness</span></div></div>`;
    const moves = M ? `<div><h3 class="mini-h">What to control</h3>
      <p class="lb-lead">${movesLead(M)} Each row takes ${M.moves[0].cutDb} dB off the loudest 2% of moments in one range, then measures how much less a limiter has to do to reach a PLR of ${M.target} dB.</p>
      <div>${M.moves.map((mv, i) => `<div class="mv-row${i === 0 && mv.pct >= 10 ? ' top' : ''}"><div class="lb-name">${esc(mv.name)}<small>${esc(mv.range)}</small></div>${moveBar(mv.pct)}<div class="mv-val ${moveCls(mv.pct)}">${moveVal(mv.pct)}</div>${mv.pct >= 10 ? `<div class="mv-how">${esc(bandTool(mv))}</div>` : ''}</div>`).join('')}</div></div>` : '';
    const allFlat = E && E.moves.every(mv => Math.abs(mv.pct) < 5);
    const eq = E ? `<div><h3 class="mini-h">Tone moves</h3>
      <p class="lb-lead">${allFlat ? 'None of these EQ moves changes the limiting much on this track, so choose tone by ear and against a reference.' : 'How each EQ move changes the limiting at the same density.'} More presence makes a mix feel louder at the same LUFS, even when it costs a little limiting.</p>
      <div>${E.moves.map(mv => `<div class="mv-row eq"><div class="lb-name">${esc(mv.label)}<small>${esc(mv.detail)}</small></div>${moveBar(mv.pct)}<div class="mv-val ${moveCls(mv.pct)}">${moveVal(mv.pct)}</div>${forReport ? '' : `<button class="btn sm ghost" data-trymove="${mv.key}" title="Load this move into the EQ on the Tools tab so you can hear it">Try in EQ</button>`}</div>`).join('')}</div>${extraRight || ''}</div>` : '';
    return notice + budget + `<div class="lb-sec lb-cols">${moves}${eq}</div>`;
  }
  function renderLouder() {
    $('louder').innerHTML = louderHtml(false);
    document.querySelectorAll('[data-trymove]').forEach(b => b.addEventListener('click', () => tryMove(b.dataset.trymove)));
  }
  function tryMove(key) {
    const mv = DSP.MIX_MOVES.find(x => x.key === key); if (!mv || !eqBands.length) return;
    resetEq();
    const band = eqBands[mv.eqBand];
    band.node.frequency.value = mv.f; band.node.gain.value = mv.g; if (mv.type === 'peaking') band.node.Q.value = mv.q;
    setTab('tools'); drawEq();
    $('eqReadout').textContent = `Loaded: ${mv.label} (${mv.detail}). You are hearing it now. Use Master to −14 below to hear it at matched loudness.`;
    eqChanged();
    setTimeout(() => $('eqCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }

  // Timeline notes: where the peaks cluster and where the energy drops
  function renderTimelineNotes() {
    const m = S.metrics, chips = [];
    (m.hotspots || []).forEach(h => chips.push(`<button class="tl-chip" data-seek="${h.start}" title="Play from here"><b>${fmtTime(h.start)}–${fmtTime(h.end)}</b>Peak cluster, mostly ${esc(SRC_META[h.dominant][0].toLowerCase())}</button>`));
    (m.dips || []).forEach(d => chips.push(`<button class="tl-chip dip" data-seek="${d.start}" title="Play from here"><b>${fmtTime(d.start)}–${fmtTime(d.end)}</b>Energy dip, ${fmt(d.depth)} LU below average</button>`));
    $('timelineNotes').innerHTML = chips.join('');
    document.querySelectorAll('[data-seek]').forEach(b => b.addEventListener('click', () => seekTo(+b.dataset.seek, true)));
  }

  function computeRefDiffs() {
    if (!S.ref || !S.metrics) { S.refDiffs = null; S.refVerdict = null; return; }
    const m = S.metrics, r = S.ref.sum;
    S.refVerdict = DSP.loudnessVerdict(
      { plr: m.plr, lowMidPresenceGap: m.lowMidPresenceGap, subBassGap: m.subBassGap, lra: m.lra, budget: S.louder && S.louder.budget },
      { plr: r.plr, lowMidPresenceGap: r.lowMidPresenceGap, subBassGap: r.subBassGap, lra: r.lra, budget: S.ref.budget });
    S.refDiffs = DSP.referenceDiffs(
      { plr: m.plr, tilt: m.tilt, lra: m.lra, width: m.width, lowWidth: m.lowWidth, octaveRel: S.tone.octaveRel },
      { plr: r.plr, tilt: r.tilt, lra: r.lra, width: r.width, lowWidth: r.lowWidth, octaveRel: r.tone.octaveRel });
  }

  // ===================================================================
  // Master to −14: EQ + optional glue → soft clipper → true-peak limiter,
  // re-measured until it lands on −14.0 LUFS
  // ===================================================================
  let masterJob = 0;
  const GLUE = {
    gentle: { threshold: -20, ratio: 1.5, attack: 0.03, release: 0.2, knee: 8 },
    medium: { threshold: -22, ratio: 2, attack: 0.02, release: 0.15, knee: 6 },
  };
  const masterSettings = () => ({ eq: $('mEq').value === 'on', glue: $('mGlue').value, clip: $('mClip').value, ceiling: +$('mCeil').value });
  const eqSignature = () => eqBands.map(b => [Math.round(b.node.frequency.value), b.node.gain.value.toFixed(1), b.node.Q.value.toFixed(2)].join('/')).join(';');
  const eqIsActive = () => eqBands.some(b => Math.abs(b.node.gain.value) > 0.05);

  async function masterPreStage(st) {
    const b = S.buffer, useEq = st.eq && eqIsActive(), ch = [];
    if (!useEq && st.glue === 'off') { for (let c = 0; c < b.numberOfChannels; c++) ch.push(b.getChannelData(c)); return ch; }
    const off = new OfflineAudioContext(b.numberOfChannels, b.length, b.sampleRate);
    const src = off.createBufferSource(); src.buffer = b;
    const norm = off.createGain(); norm.gain.value = normLinear();
    src.connect(norm); let n = norm;
    if (useEq) eqBands.forEach(x => {
      const f = off.createBiquadFilter(); f.type = x.type; f.frequency.value = x.node.frequency.value; f.Q.value = x.node.Q.value; f.gain.value = x.node.gain.value;
      n.connect(f); n = f;
    });
    if (st.glue !== 'off') {
      const g = GLUE[st.glue], c = off.createDynamicsCompressor();
      c.threshold.value = g.threshold; c.ratio.value = g.ratio; c.attack.value = g.attack; c.release.value = g.release; c.knee.value = g.knee;
      n.connect(c); n = c;
    }
    n.connect(off.destination); src.start(0);
    const out = await off.startRendering();
    for (let c = 0; c < out.numberOfChannels; c++) ch.push(out.getChannelData(c));
    return ch;
  }

  async function renderMaster() {
    if (!S.buffer) return;
    const job = ++masterJob, st = masterSettings(), fs = S.buffer.sampleRate, T = DSP.TARGET_LUFS;
    const btn = $('masterBtn'), status = t => { $('masterStatus').textContent = t; };
    btn.disabled = true;
    if (isPlaying && abMode === 'mastered') pause();
    try {
      status('Applying EQ and compression…'); await tick();
      const pre = await masterPreStage(st);
      status('Measuring…'); await tick();
      const preL = DSP.loudness(DSP.asBuffer(pre, fs)).integrated;
      if (!isFinite(preL)) throw new Error('not enough signal to measure');
      let G = T - preL, res = null, L = NaN;
      for (let it = 0; it < 6; it++) {
        status(`Limiting to −14 LUFS (pass ${it + 1})…`); await tick();
        if (job !== masterJob) return;
        res = DSP.processMaster(pre, fs, G, st.ceiling, st.clip);
        const ob = DSP.asBuffer(res.chans, fs);
        const tp = DSP.truePeak(ob).truePeakDb;
        if (tp > st.ceiling + 0.01) {
          const k = Math.pow(10, (st.ceiling - 0.01 - tp) / 20);
          res.chans.forEach(x => { for (let i = 0; i < x.length; i++) x[i] *= k; });
        }
        L = DSP.loudness(ob).integrated;
        if (Math.abs(L - T) <= 0.05) break;
        G += T - L;
      }
      if (job !== masterJob) return;
      status('Checking the result…'); await tick();
      const ob = DSP.asBuffer(res.chans, fs), loud = DSP.loudness(ob), tpr = DSP.truePeak(ob).truePeakDb;
      const ab = new AudioBuffer({ length: S.buffer.length, numberOfChannels: S.buffer.numberOfChannels, sampleRate: fs });
      res.chans.forEach((x, c) => ab.copyToChannel(x, c));
      S.mastered = {
        buffer: ab, settings: st, eqSig: eqSignature(), eqUsed: st.eq && eqIsActive(),
        stats: { lufs: loud.integrated, truePeak: tpr, plr: tpr - loud.integrated, lra: loud.lra, maxShortTerm: loud.maxShortTerm },
        clip: res.clip, lim: res.lim,
      };
      status('');
      renderMasterResult(); updateMasteredButton();
      toast('Master ready. Choose “Mastered” in the player to hear it.');
    } catch (e) { status('Render failed: ' + e.message); }
    btn.disabled = false;
  }
  $('masterBtn').addEventListener('click', renderMaster);

  function masterProcessText(M) {
    const parts = [];
    if (M.settings.clip !== 'off') parts.push(M.clip.touchedPct > 0.0005 ? `The soft clipper shaved up to ${M.clip.maxRedDb.toFixed(1)} dB from ${fmtPct(M.clip.touchedPct)} of samples.` : 'The soft clipper barely touched the audio.');
    parts.push(M.lim.limitedPct > 0.01 ? `The limiter was working ${fmtPct(M.lim.limitedPct)} of the time, averaging ${M.lim.avgGrDb.toFixed(1)} dB of reduction (peak ${M.lim.maxGrDb.toFixed(1)} dB).` : 'The limiter was barely needed.');
    const chain = [M.eqUsed ? 'your EQ curve' : null, M.settings.glue !== 'off' ? `${M.settings.glue} glue compression` : null, M.settings.clip !== 'off' ? `${M.settings.clip === 'medium' ? 'firm' : 'gentle'} soft clipping` : null, `a true-peak limiter at ${fmt(M.settings.ceiling)} dBTP`].filter(Boolean);
    return `Chain: ${chain.join(', ')}. ` + parts.join(' ');
  }

  function renderMasterResult() {
    const M = S.mastered, el = $('masterResult');
    if (!M) {
      el.innerHTML = '<p class="note">Renders your track through the options above, a soft clipper and a true-peak limiter, adjusting the drive until it lands on exactly −14.0 LUFS. Your file is never changed. Then compare it in the player against your mix turned to −14.</p>';
      return;
    }
    const m = S.metrics, s = M.stats;
    const rows = [['Integrated loudness', m.lufs, s.lufs, 'LUFS'], ['True peak', m.truePeak, s.truePeak, 'dBTP'], ['Peak-to-loudness', m.plr, s.plr, 'dB'],
      ['Loudness range', m.lra, s.lra, 'LU'], ['Max short-term', m.maxShortTerm, s.maxShortTerm, 'LUFS']];
    const heavy = M.lim.maxGrDb > 4 || M.lim.avgGrDb > 2.5 || M.clip.maxRedDb > 3;
    const stale = M.eqUsed !== (M.settings.eq && eqIsActive()) || (M.eqUsed && M.eqSig !== eqSignature());
    el.innerHTML = `<div class="table-wrap"><table class="data" style="margin-top:16px"><thead><tr><th>Measurement</th><th>Your file</th><th>Mastered</th><th>Change</th></tr></thead><tbody>
      ${rows.map(([n, a, b, u]) => `<tr><td>${n}</td><td>${fmt(a)} ${u}</td><td>${fmt(b)} ${u}</td><td class="delta neutral">${fmtSigned(b - a)}</td></tr>`).join('')}</tbody></table></div>
      <p class="master-stats">${esc(masterProcessText(M))}</p>
      ${heavy ? '<p class="stale">The clipper or limiter is working hard. The cleaner fix is to tame the peaks in your mix first; see Peaks &amp; density on the Loudness tab.</p>' : ''}
      ${stale ? '<p class="stale">The EQ has changed since this render. Render again to hear the new curve.</p>' : ''}
      <div class="controls" style="margin-top:12px">
        <button class="btn sm" id="masterListenBtn">▶ Mastered</button>
        <button class="btn sm" id="masterCompareBtn">▶ Your mix at −14</button>
        <button class="btn sm" id="masterDlBtn">Download 24-bit WAV</button>
      </div>`;
    $('masterListenBtn').onclick = () => { applyMode('mastered'); if (!isPlaying) play(); };
    $('masterCompareBtn').onclick = () => { applyMode('normalized'); if (!isPlaying) play(); };
    $('masterDlBtn').onclick = () => download(audioBufferToWav(M.buffer, 24), `${baseName()}_master_-14LUFS.wav`);
  }
  function updateMasteredButton() {
    const b = document.querySelector('#abSeg [data-mode="mastered"]');
    b.classList.toggle('dim', !S.mastered);
    b.title = S.mastered ? 'Your render from Master to −14' : 'Render a master in Tools → Master to −14 first';
  }

  function renderAll() {
    renderFileInfo(); renderSummary(); renderFindings(); renderLoudnessTiles(); renderPlatforms();
    renderToneTiles(); renderStereoTiles(); renderDynamics(); renderRegionInfo(); renderQuietList();
    $('regionTable').innerHTML = ''; $('zoomPanel').classList.add('hidden');
    computeRefDiffs(); renderRefContent(); renderMeterRef(); renderHistory(); renderReleaseReady(); renderReadiness(); renderPeaksDensity(); renderLouder(); renderTimelineNotes(); renderMasterResult(); updateMasteredButton(); updateTransport(0);
    invalidateCaches();
  }

  // ===================================================================
  // Tabs
  // ===================================================================
  const TABS = ['overview', 'loudness', 'tone', 'stereo', 'dynamics', 'tools', 'compare'];
  function setTab(name) {
    S.activeTab = name;
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
    const at = document.querySelector(`.tab[data-tab="${name}"]`);
    if (at && at.scrollIntoView) at.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    redrawActive();
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  // On narrow screens the tabs scroll sideways: fade whichever edge has more tabs behind it
  (function tabFades() {
    const el = document.querySelector('.tabs'); if (!el) return;
    const upd = () => { el.classList.toggle('fade-l', el.scrollLeft > 4); el.classList.toggle('fade-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 4); };
    el.addEventListener('scroll', upd, { passive: true }); window.addEventListener('resize', upd);
    new ResizeObserver(upd).observe(el); upd();
  })();

  const DRAWERS = {
    overview: () => drawWave('wfOverview'),
    loudness: () => { drawGauges(); drawTimeline(); },
    tone: () => { drawTonal(); if (!isPlaying) drawStaticSpectrum(); drawSpectrogram(); },
    stereo: () => { if (!isPlaying) drawStaticScope(); drawStereoField(); },
    dynamics: () => {},
    tools: () => { drawEq(); drawWave('wfEditor'); drawZoom(); },
    compare: () => {},
  };
  function redrawActive() {
    if (!S.buffer) return;
    if (S.meterSong && S.activeTab === 'tools') return;
    DRAWERS[S.activeTab]();
  }
  function redrawAllForExport() {
    if (S.meterSong) { drawGauges(); drawTimeline(); drawTonal(); drawStaticSpectrum(); if (S.meterSong.detail) { drawWave('wfOverview'); drawSpectrogram(); drawStaticScope(); drawStereoField(); } return; }
    drawWave('wfOverview'); drawGauges(); drawTimeline(); drawTonal(); drawStaticSpectrum(); drawSpectrogram();
    drawStaticScope(); drawStereoField(); drawEq();
  }
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { invalidateCaches(); redrawActive(); }, 80); });

  // ===================================================================
  // Canvas helpers
  // ===================================================================
  function prep(canvas) {
    if (typeof canvas === 'string') canvas = $(canvas);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    const dpr = exportDpr || window.devicePixelRatio || 1, W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr, canvas };
  }
  const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const xOfFreq = (f, x0, w, fMin = 20, fMax = 20000) => x0 + Math.log(f / fMin) / Math.log(fMax / fMin) * w;
  function label(ctx, text, x, y, align = 'left', color) {
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = color || css('--text-faint'); ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
  }
  function vline(ctx, x, y0, y1, color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0); ctx.lineTo(Math.round(x) + 0.5, y1); ctx.stroke(); }
  function hline(ctx, y, x0, x1, color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(x1, Math.round(y) + 0.5); ctx.stroke(); }
  function freqAxis(ctx, x0, w, yTop, yBottom, fMax = 20000) {
    const grid = css('--grid');
    let lastX = -1e9;
    FREQ_TICKS.forEach(f => {
      if (f > fMax) return;
      const x = xOfFreq(f, x0, w, 20, fMax);
      vline(ctx, x, yTop, yBottom, grid);
      const lx = Math.min(x + 3, x0 + w - 22);
      if (lx - lastX >= 28) { label(ctx, fmtHz(f), lx, yBottom + 12); lastX = lx; }
    });
  }
  function timeTicks(duration) {
    const steps = [5, 10, 15, 30, 60, 120, 300];
    const step = steps.find(s => duration / s <= 10) || 600;
    const out = []; for (let t = 0; t <= duration + 0.001; t += step) out.push(t);
    return out;
  }
  function timeAxis(ctx, x0, w, yTop, yBottom, duration, labelY) {
    const grid = css('--grid');
    timeTicks(duration).forEach(t => {
      const x = x0 + t / duration * w;
      vline(ctx, x, yTop, yBottom, grid);
      label(ctx, fmtTime(t), Math.min(x + 3, x0 + w - 26), labelY);
    });
  }
  let caches = {};
  function invalidateCaches() { caches = {}; S.specImage = null; }

  // ===================================================================
  // Waveforms (overview + editor)
  // ===================================================================
  // Quiet (deep violet) to loud (warm gold): the landing page's palette
  const WAVE_STOPS = [[83, 76, 214], [128, 70, 190], [186, 72, 128], [236, 106, 58], [246, 168, 52]];
  function WAVE_HEAT(t) {
    t = Math.max(0, Math.min(1, t)) * (WAVE_STOPS.length - 1);
    const i = Math.min(WAVE_STOPS.length - 2, Math.floor(t)), f = t - i;
    const c = WAVE_STOPS[i].map((v, k) => Math.round(v + (WAVE_STOPS[i + 1][k] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  function drawWave(id) {
    const c = prep(id); if (!c || !S.mono) return;
    const { ctx, w, h, dpr } = c;
    const padB = 16, H = h - padB, key = id + w + 'x' + h + document.documentElement.dataset.theme;
    if (!caches[key]) {
      const off = document.createElement('canvas'); off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
      const o = off.getContext('2d'); o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.fillStyle = css('--surface-2'); o.fillRect(0, 0, w, h);
      timeAxis(o, 0, w, 0, H, S.buffer.duration, h - 4);
      hline(o, H / 2, 0, w, css('--grid'));
      const data = S.mono, step = data.length / w, mid = H / 2;
      // The overview is coloured by how loud each moment is against the song's average
      // (short-term loudness), with energy dips shaded and the loudest peaks ticked.
      const heatOn = id === 'wfOverview' && S.loud && S.loud.shortTerm && isFinite(S.loud.integrated);
      const st = heatOn ? S.loud.shortTerm : null, hop = (S.loud && S.loud.hopSec) || 0.1, dur = S.buffer.duration;
      if (heatOn && S.metrics) (S.metrics.dips || []).forEach(d => { o.fillStyle = css('--warn'); o.globalAlpha = 0.10; o.fillRect(d.start / dur * w, 0, Math.max(1, (d.end - d.start) / dur * w), H); o.globalAlpha = 1; });
      o.fillStyle = css('--accent');
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1;
        const s = Math.floor(x * step), e = Math.min(data.length, Math.floor((x + 1) * step));
        for (let j = s; j < e; j++) { const v = data[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mx < mn) continue;
        if (heatOn) {
          const k = Math.max(0, Math.min(st.length - 1, Math.round(((x + 0.5) / w * dur - 1.5) / hop)));
          const rel = isFinite(st[k]) ? st[k] - S.loud.integrated : -20;
          o.fillStyle = WAVE_HEAT((rel + 9) / 12);
        }
        const y0 = mid - mx * mid * 0.95, y1 = mid - mn * mid * 0.95;
        o.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
      if (heatOn && S.peaks && S.peaks.list) {
        o.strokeStyle = css('--text-dim'); o.globalAlpha = 0.55; o.lineWidth = 1;
        S.peaks.list.forEach(ev => { const px = Math.round(ev.t / dur * w) + 0.5; o.beginPath(); o.moveTo(px, 0); o.lineTo(px, 5); o.stroke(); });
        o.globalAlpha = 1;
      }
      caches[key] = off;
    }
    ctx.drawImage(caches[key], 0, 0, w, h);
    const len = S.buffer.length;
    if (id === 'wfEditor') {
      S.quietRegions.forEach((r, i) => {
        const x1 = r.start / len * w, x2 = r.end / len * w;
        ctx.fillStyle = 'rgba(242,169,59,0.16)'; ctx.fillRect(x1, 0, x2 - x1, H);
        ctx.strokeStyle = css('--warn'); ctx.lineWidth = 1; ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, H - 1);
        label(ctx, `#${i + 1}`, x1 + 4, 12, 'left', css('--warn'));
      });
      if (S.selection) {
        const x1 = S.selection.start / len * w, x2 = S.selection.end / len * w;
        ctx.fillStyle = css('--accent-soft'); ctx.fillRect(x1, 0, x2 - x1, H);
        ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.strokeRect(x1, 0.75, x2 - x1, H - 1.5);
      }
    }
    const pos = currentPos();
    const px = Math.max(0, Math.min(1, pos / S.buffer.duration)) * w;
    vline(ctx, px, 0, H, css('--text'));
  }

  // ===================================================================
  // Gauges
  // ===================================================================
  function drawGauge(id, value, min, max, target, unit, zones) {
    const c = prep(id); if (!c) return;
    const { ctx, w, h } = c;
    const cx = w / 2, cy = h - 22, r = Math.min(w / 2 - 22, h - 40);
    const a0 = Math.PI, a1 = 2 * Math.PI, ang = v => a0 + (Math.max(min, Math.min(max, v)) - min) / (max - min) * (a1 - a0);
    ctx.lineCap = 'round';
    ctx.lineWidth = 10; ctx.strokeStyle = css('--surface-3');
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    if (isFinite(value)) {
      ctx.strokeStyle = css(zones(value));
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, ang(value)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // ticks + labels
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const v = min + (max - min) * i / ticks, a = ang(v);
      ctx.strokeStyle = css('--border-strong'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r + 9), cy + Math.sin(a) * (r + 9)); ctx.lineTo(cx + Math.cos(a) * (r + 14), cy + Math.sin(a) * (r + 14)); ctx.stroke();
    }
    label(ctx, fmt(min, 0), cx - r, cy + 16, 'center');
    label(ctx, fmt(max, 0), cx + r, cy + 16, 'center');
    // target
    const ta = ang(target);
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(ta) * (r - 9), cy + Math.sin(ta) * (r - 9)); ctx.lineTo(cx + Math.cos(ta) * (r + 9), cy + Math.sin(ta) * (r + 9)); ctx.stroke();
    // readout
    ctx.textAlign = 'center'; ctx.fillStyle = css('--text');
    ctx.font = '600 24px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(fmt(value), cx, cy - 8);
    label(ctx, unit, cx, cy + 8, 'center', css('--text-dim'));
  }
  function drawGauges() {
    const m = S.metrics;
    drawGauge('lufsGauge', m.lufs, -30, 0, -14, 'LUFS', v => Math.abs(v + 14) <= 5 ? '--ok' : '--warn');
    drawGauge('tpGauge', m.truePeak, -12, 1, -1, 'dBTP', v => v > -0.1 ? '--danger' : v > -1 ? '--warn' : '--ok');
  }

  // ===================================================================
  // Loudness timeline
  // ===================================================================
  function drawTimeline() {
    const c = prep('timelineCanvas'); if (!c || !S.loud) return;
    const { ctx, w, h } = c;
    const padL = 34, padB = 18, padT = 8, W = w - padL - 6, H = h - padB - padT;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    const lo = -40, hi = 0, y = v => padT + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
    const dur = S.buffer.duration;
    timeAxis(ctx, padL, W, padT, padT + H, dur, h - 5);
    [-40, -30, -23, -14, -9, 0].forEach(v => { hline(ctx, y(v), padL, padL + W, css('--grid')); label(ctx, fmt(v, 0), padL - 4, y(v) + 3, 'right'); });
    const xt = t => padL + t / dur * W, m = S.metrics;
    // energy dips: shaded spans
    (m.dips || []).forEach(d => { ctx.fillStyle = css('--warn'); ctx.globalAlpha = 0.12; ctx.fillRect(xt(d.start), padT, Math.max(1, xt(d.end) - xt(d.start)), H); ctx.globalAlpha = 1; });
    // loudest peaks: ticks along the top, coloured by what made them; clusters get a bracket
    if (S.peaks && S.peaks.list) {
      const varColor = v => css(v.replace(/^var\((--[^)]+)\)$/, '$1'));
      const cols = {}; Object.keys(SRC_META).forEach(k => cols[k] = varColor(SRC_META[k][1]));
      ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
      S.peaks.list.forEach(e => { ctx.strokeStyle = cols[e.cat] || css('--text-dim'); const x = Math.round(xt(e.t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + 6); ctx.stroke(); });
      ctx.globalAlpha = 1;
      (m.hotspots || []).forEach(hs => { ctx.strokeStyle = css('--text-dim'); ctx.lineWidth = 1.5; const a = xt(hs.start), b = xt(hs.end), yb = padT + 9; ctx.beginPath(); ctx.moveTo(a, yb - 2); ctx.lineTo(a, yb); ctx.lineTo(b, yb); ctx.lineTo(b, yb - 2); ctx.stroke(); });
    }
    const plot = (arr, offsetSec, color, lw) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        const t = offsetSec + i * 0.1, x = padL + t / dur * W, v = arr[i];
        if (!isFinite(v)) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
      }
      ctx.stroke();
    };
    ctx.globalAlpha = 0.55; plot(S.loud.momentary, 0.2, css('--live'), 1); ctx.globalAlpha = 1;
    plot(S.loud.shortTerm, 1.5, css('--accent'), 2);
    if (isFinite(S.metrics.lufs)) {
      ctx.setLineDash([5, 4]); hline(ctx, y(S.metrics.lufs), padL, padL + W, css('--warn')); ctx.setLineDash([]);
    }
  }

  // ===================================================================
  // Tonal balance (octave bars)
  // ===================================================================
  function drawTonal() {
    const c = prep('tonalCanvas'); if (!c || !S.tone) return;
    const { ctx, w, h } = c;
    const padL = 34, padB = 22, padT = 14, W = w - padL - 8, H = h - padB - padT;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    const vals = S.tone.octaveRel, refVals = S.ref ? S.ref.sum.tone.octaveRel : null;
    let lo = -24, hi = 12;
    [...vals, ...(refVals || [])].forEach(v => { if (isFinite(v)) { lo = Math.min(lo, Math.floor((v - 3) / 6) * 6); hi = Math.max(hi, Math.ceil((v + 3) / 6) * 6); } });
    const y = v => padT + (1 - (v - lo) / (hi - lo)) * H;
    for (let v = lo; v <= hi; v += 6) { hline(ctx, y(v), padL, padL + W, v === 0 ? css('--text-faint') : css('--grid')); label(ctx, v === 0 ? '0' : fmtSigned(v, 0), padL - 4, y(v) + 3, 'right'); }
    const n = vals.length, slot = W / n, bw = Math.min(46, slot * 0.56);
    vals.forEach((v, i) => {
      const cx = padL + slot * (i + 0.5);
      label(ctx, ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'][i] + (i < 5 ? ' Hz' : ''), cx, h - 6, 'center', css('--text-dim'));
      if (!isFinite(v)) return;
      const y0 = y(0), y1 = y(v);
      ctx.fillStyle = css('--accent');
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cx - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)), 3); else ctx.rect(cx - bw / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)));
      ctx.fill(); ctx.globalAlpha = 1;
      label(ctx, fmtSigned(v, 1), cx, v >= 0 ? y1 - 4 : y1 + 12, 'center', css('--text-dim'));
      if (refVals && isFinite(refVals[i])) {
        ctx.strokeStyle = css('--ref'); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx - bw / 2 - 5, y(refVals[i])); ctx.lineTo(cx + bw / 2 + 5, y(refVals[i])); ctx.stroke();
      }
    });
  }

  // ===================================================================
  // Spectrum (whole-track static + live)
  // ===================================================================
  function refBarsFor(ref) {
    const fs = S.buffer ? S.buffer.sampleRate : ref.buffer ? ref.buffer.sampleRate : 48000;
    if (ref.meterTone) return ref.meterTone.bars(20, Math.min(20000, fs / 2), 140);
    return DSP.logBars(ref.sum.tone.psd, ref.sum.tone.binHz, 20, Math.min(20000, fs / 2), 140);
  }
  // align a curve so its mean over 100 Hz–5 kHz sits at 0
  function alignBars(bars, fMax) {
    const n = bars.length; let s = 0, k = 0;
    for (let i = 0; i < n; i++) { const f = 20 * Math.pow(fMax / 20, (i + 0.5) / n); if (f >= 100 && f <= 5000 && isFinite(bars[i])) { s += bars[i]; k++; } }
    const m = k ? s / k : 0;
    return Array.from(bars, v => v - m);
  }
  function spectrumFrame(c, fMax) {
    const { ctx, w, h } = c;
    const padL = 34, padB = 18, padT = 8, W = w - padL - 6, H = h - padB - padT;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    freqAxis(ctx, padL, W, padT, padT + H, fMax);
    return { padL, padT, W, H };
  }
  function drawCurve(ctx, arr, fr, y, color, fill, lw, dash) {
    const n = arr.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = fr.padL + (i + 0.5) / n * fr.W, yy = y(arr[i]);
      if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
    }
    if (fill) {
      ctx.save(); ctx.lineTo(fr.padL + fr.W, fr.padT + fr.H); ctx.lineTo(fr.padL, fr.padT + fr.H); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill(); ctx.restore();
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = fr.padL + (i + 0.5) / n * fr.W, yy = y(arr[i]); if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy); }
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.stroke(); ctx.setLineDash([]);
  }
  function dbAxis(ctx, fr, top, range) {
    const y = v => fr.padT + (top - v) / range * fr.H;
    for (let d = 0; d <= range; d += 12) { hline(ctx, y(top - d), fr.padL, fr.padL + fr.W, css('--grid')); label(ctx, d === 0 ? '0' : MINUS + d, fr.padL - 4, y(top - d) + 3, 'right'); }
    return v => fr.padT + Math.max(0, Math.min(1, (top - v) / range)) * fr.H;
  }
  function drawStaticSpectrum() {
    const c = prep('spectrumCanvas'); if (!c || !S.specBars) return;
    const fMax = Math.min(20000, S.buffer.sampleRate / 2), fr = spectrumFrame(c, fMax);
    const mine = alignBars(S.specBars, fMax), ref = S.ref && S.ref.bars ? alignBars(S.ref.bars, fMax) : null;
    let top = Math.max(...mine.filter(isFinite)); if (ref) top = Math.max(top, ...ref.filter(isFinite));
    top = Math.ceil((top + 2) / 6) * 6;
    const y = dbAxis(c.ctx, fr, top, 48);
    drawCurve(c.ctx, mine, fr, y, css('--accent'), css('--accent-soft'), 1.8);
    if (ref) drawCurve(c.ctx, ref, fr, y, css('--ref'), null, 1.6, [6, 4]);
    $('spectrumMode').textContent = 'Whole-track average';
    const leg = [`<span><i style="background:var(--accent)"></i>This track (whole-track average)</span>`];
    if (ref) leg.push(`<span style="color:var(--ref)"><i class="dash"></i><span style="color:var(--text-dim)">Reference</span></span>`);
    $('spectrumLegend').innerHTML = leg.join('');
  }
  let liveBuf = null;
  function drawLiveSpectrum() {
    const c = prep('spectrumCanvas'); if (!c || !chain) return;
    const an = chain.analyser, n = an.frequencyBinCount;
    if (!liveBuf || liveBuf.length !== n) liveBuf = new Float32Array(n);
    an.getFloatFrequencyData(liveBuf);
    const psd = new Float64Array(n);
    for (let k = 0; k < n; k++) psd[k] = isFinite(liveBuf[k]) ? Math.pow(10, liveBuf[k] / 10) : 0;
    const fs = audioCtx.sampleRate, fMax = Math.min(20000, fs / 2);
    const live = alignBars(DSP.logBars(psd, fs / an.fftSize, 20, fMax, 140), fMax);
    const stat = alignBars(S.specBars, fMax);
    const fr = spectrumFrame(c, fMax);
    let peak = -Infinity; live.forEach(v => { if (isFinite(v) && v > peak) peak = v; });
    if (isFinite(peak)) liveTop = isFinite(liveTop) ? Math.max(peak + 3, liveTop - 0.15) : peak + 3;
    const y = dbAxis(c.ctx, fr, Math.ceil((isFinite(liveTop) ? liveTop : 12) / 6) * 6, 60);
    c.ctx.globalAlpha = 0.6;
    drawCurve(c.ctx, stat, fr, y, css('--text-faint'), null, 1.2, [4, 4]);
    c.ctx.globalAlpha = 1;
    drawCurve(c.ctx, live, fr, y, css('--live'), 'rgba(62,207,142,0.14)', 1.8);
    $('spectrumMode').textContent = 'Live';
    $('spectrumLegend').innerHTML = '<span><i style="background:var(--live)"></i>Live signal</span><span style="color:var(--text-faint)"><i class="dash"></i><span style="color:var(--text-dim)">Whole-track average</span></span>';
  }

  // ===================================================================
  // Spectrogram
  // ===================================================================
  const HEAT = (() => {
    const stops = [[11, 14, 38], [36, 45, 120], [21, 121, 170], [30, 180, 130], [230, 190, 40], [245, 110, 40], [230, 60, 70], [255, 245, 235]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const s = i / 255 * (stops.length - 1), j = Math.min(stops.length - 2, Math.floor(s)), f = s - j;
      for (let k = 0; k < 3; k++) lut[i * 3 + k] = stops[j][k] + (stops[j + 1][k] - stops[j][k]) * f;
    }
    return lut;
  })();
  $('heatGrad').style.background = 'linear-gradient(90deg,' + [0, 36, 73, 109, 146, 182, 219, 255].map(i => `rgb(${HEAT[i * 3]},${HEAT[i * 3 + 1]},${HEAT[i * 3 + 2]})`).join(',') + ')';

  function buildSpecImage() {
    const sp = S.spec, cols = sp.columns.length, rows = 300;
    const off = document.createElement('canvas'); off.width = cols; off.height = rows;
    const o = off.getContext('2d'), img = o.createImageData(cols, rows);
    const fMax = Math.min(20000, sp.fs / 2), binHz = sp.fs / sp.fftSize, nb = sp.columns[0].length;
    const minDb = sp.maxDb - 72;
    const binOfRow = new Float32Array(rows);
    for (let r = 0; r < rows; r++) binOfRow[r] = 20 * Math.pow(fMax / 20, 1 - (r + 0.5) / rows) / binHz;
    for (let c = 0; c < cols; c++) {
      const col = sp.columns[c];
      for (let r = 0; r < rows; r++) {
        const b = binOfRow[r], b0 = Math.min(nb - 2, Math.max(0, Math.floor(b))), f = Math.min(1, Math.max(0, b - b0));
        const db = col[b0] * (1 - f) + col[b0 + 1] * f;
        const t = Math.max(0, Math.min(255, Math.round((db - minDb) / 72 * 255)));
        const p = (r * cols + c) * 4;
        img.data[p] = HEAT[t * 3]; img.data[p + 1] = HEAT[t * 3 + 1]; img.data[p + 2] = HEAT[t * 3 + 2]; img.data[p + 3] = 255;
      }
    }
    o.putImageData(img, 0, 0);
    S.specImage = off;
  }
  const SPEC_PAD = { l: 34, b: 18, t: 4, r: 6 };
  function drawSpectrogram() {
    const c = prep('spectrogramCanvas'); if (!c || !S.spec || !S.spec.columns.length) return;
    if (!S.specImage) buildSpecImage();
    const { ctx, w, h } = c, P = SPEC_PAD, W = w - P.l - P.r, H = h - P.t - P.b;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(S.specImage, P.l, P.t, W, H);
    const fMax = Math.min(20000, S.spec.fs / 2);
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
      const yy = P.t + (1 - Math.log(f / 20) / Math.log(fMax / 20)) * H;
      hline(ctx, yy, P.l, P.l + W, 'rgba(255,255,255,0.10)');
      label(ctx, fmtHz(f), P.l - 4, yy + 3, 'right');
    });
    timeTicks(S.buffer.duration).forEach(t => label(ctx, fmtTime(t), Math.min(P.l + t / S.buffer.duration * W + 3, P.l + W - 26), h - 5));
    const pos = currentPos();
    if (pos > 0) vline(ctx, P.l + pos / S.buffer.duration * W, P.t, P.t + H, 'rgba(255,255,255,0.8)');
  }
  function specCoords(e) {
    const cv = $('spectrogramCanvas'), r = cv.getBoundingClientRect(), P = SPEC_PAD;
    const W = r.width - P.l - P.r, H = r.height - P.t - P.b;
    const fx = (e.clientX - r.left - P.l) / W, fy = (e.clientY - r.top - P.t) / H;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    const fMax = Math.min(20000, S.spec.fs / 2);
    return { t: fx * S.buffer.duration, f: 20 * Math.pow(fMax / 20, 1 - fy), fx };
  }
  $('spectrogramCanvas').addEventListener('mousemove', e => {
    if (!S.spec) return;
    const p = specCoords(e); if (!p) return;
    const sp = S.spec, ci = Math.min(sp.columns.length - 1, Math.floor(p.fx * sp.columns.length));
    const bin = Math.min(sp.columns[0].length - 1, Math.round(p.f / (sp.fs / sp.fftSize)));
    const db = sp.columns[ci][bin] - sp.maxDb;
    $('spectrogramReadout').textContent = `${fmtTime(p.t)} · ${p.f < 1000 ? Math.round(p.f) + ' Hz' : (p.f / 1000).toFixed(2) + ' kHz'} · ${fmt(db)} dB below the loudest point`;
  });
  $('spectrogramCanvas').addEventListener('click', e => { if (!S.spec) return; const p = specCoords(e); if (p) seekTo(p.t, true); });

  // ===================================================================
  // Vectorscope
  // ===================================================================
  function scopeFrame(c) {
    const { ctx, w, h } = c;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 16, g = css('--grid');
    ctx.strokeStyle = g; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    const d = R / Math.SQRT2;
    ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d); ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d); ctx.stroke();
    label(ctx, 'M', cx, cy - R - 4, 'center', css('--text-dim'));
    label(ctx, 'L', cx - d - 6, cy - d - 2, 'center', css('--text-dim'));
    label(ctx, 'R', cx + d + 6, cy - d - 2, 'center', css('--text-dim'));
    label(ctx, '−S', cx - R - 8, cy + 3, 'center');
    label(ctx, '+S', cx + R + 8, cy + 3, 'center');
    return { cx, cy, scale: R };
  }
  function setCorr(v) {
    v = Math.max(-1, Math.min(1, v));
    $('corrValue').textContent = fmtSigned(v, 2);
    $('corrMarker').style.left = ((v + 1) / 2 * 100) + '%';
  }
  function drawStaticScope() {
    const c = prep('vectorscopeCanvas'); if (!c || !S.vs) return;
    const fr = scopeFrame(c), { xs, ys } = S.vs, ctx = c.ctx;
    ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.22;
    for (let j = 0; j < xs.length; j++) ctx.fillRect(fr.cx - xs[j] * fr.scale, fr.cy - ys[j] * fr.scale, 1.3, 1.3);
    ctx.globalAlpha = 1;
    setCorr(S.corr);
    $('scopeMode').textContent = 'Showing the whole track. Press play to see the live signal.';
  }
  let scopeL = null, scopeR = null;
  function drawLiveScope() {
    const c = prep('vectorscopeCanvas'); if (!c || !chain) return;
    const N = chain.analyserL.fftSize;
    if (!scopeL || scopeL.length !== N) { scopeL = new Float32Array(N); scopeR = new Float32Array(N); }
    chain.analyserL.getFloatTimeDomainData(scopeL); chain.analyserR.getFloatTimeDomainData(scopeR);
    const fr = scopeFrame(c), ctx = c.ctx;
    // keep the scale comparable whatever the playback gain
    const g = modeGain();
    ctx.fillStyle = css('--live');
    let lr = 0, ll = 0, rr = 0;
    for (let i = 0; i < N; i++) {
      const l = scopeL[i] / g, r = scopeR[i] / g;
      lr += l * r; ll += l * l; rr += r * r;
      ctx.fillRect(fr.cx + (r - l) / Math.SQRT2 * fr.scale, fr.cy - (l + r) / Math.SQRT2 * fr.scale, 1.4, 1.4);
    }
    setCorr(lr / (Math.sqrt(ll * rr) + 1e-12));
    $('scopeMode').textContent = 'Live signal (after EQ and listening mode).';
  }

  // ===================================================================
  // Stereo width map
  // ===================================================================
  const SF_PAD = { l: 34, b: 18, t: 8, r: 6 };
  function drawStereoField() {
    const c = prep('stereoFieldCanvas'); if (!c) return;
    const { ctx, w, h } = c, P = SF_PAD, W = w - P.l - P.r, H = h - P.t - P.b;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    const sf = S.sf;
    if (!sf) { label(ctx, 'Mono file: no stereo information', w / 2, h / 2, 'center', css('--text-dim')); return; }
    const fMax = Math.min(20000, sf.fs / 2), top = 60;
    freqAxis(ctx, P.l, W, P.t, P.t + H, fMax);
    const y = v => P.t + (1 - Math.min(top, v) / top) * H;
    [0, 10, 20, 30, 40, 50, 60].forEach(v => { hline(ctx, y(v), P.l, P.l + W, css('--grid')); label(ctx, v + '%', P.l - 4, y(v) + 3, 'right'); });
    // aggregate bins into 120 log bands, energy-weighted
    const nb = 120, sums = new Float64Array(nb), wsum = new Float64Array(nb);
    for (let k = 1; k < sf.freqBins.length; k++) {
      const f = sf.freqBins[k]; if (f < 20 || f > fMax) continue;
      const i = Math.min(nb - 1, Math.floor(Math.log(f / 20) / Math.log(fMax / 20) * nb));
      const e = Math.pow(10, sf.energyDb[k] / 10);
      sums[i] += sf.widthPct[k] * e; wsum[i] += e;
    }
    // fill gaps (low end has fewer bins than bands)
    const width = new Float64Array(nb), en = new Float64Array(nb);
    for (let i = 0; i < nb; i++) { if (wsum[i] > 0) { width[i] = sums[i] / wsum[i]; en[i] = wsum[i]; } else { width[i] = NaN; } }
    for (let i = 0; i < nb; i++) if (isNaN(width[i])) { let j = i; while (j < nb && isNaN(width[j])) j++; const src = j < nb ? j : i - 1; width[i] = src >= 0 ? width[src] : 0; en[i] = src >= 0 ? en[src] : 0; }
    const maxE = Math.max(...en), bw = W / nb;
    const accent = css('--accent'), warn = css('--warn');
    for (let i = 0; i < nb; i++) {
      const enDb = 10 * Math.log10((en[i] || 1e-20) / maxE);
      const alpha = Math.max(0.12, Math.min(1, 1 + enDb / 50));
      ctx.globalAlpha = alpha;
      const f = 20 * Math.pow(fMax / 20, (i + 0.5) / nb);
      ctx.fillStyle = (f >= 50 && f < 200 && width[i] > 12) ? warn : accent;
      const yy = y(width[i]);
      ctx.fillRect(P.l + i * bw + 0.5, yy, Math.max(1, bw - 1), P.t + H - yy);
    }
    ctx.globalAlpha = 1;
    S.sfBands = { width, nb, fMax };
  }
  $('stereoFieldCanvas').addEventListener('mousemove', e => {
    if (!S.sfBands) return;
    const r = e.currentTarget.getBoundingClientRect(), P = SF_PAD, W = r.width - P.l - P.r;
    const fx = (e.clientX - r.left - P.l) / W; if (fx < 0 || fx > 1) return;
    const i = Math.min(S.sfBands.nb - 1, Math.floor(fx * S.sfBands.nb)), f = 20 * Math.pow(S.sfBands.fMax / 20, fx);
    $('stereoFieldReadout').textContent = `${f < 1000 ? Math.round(f) + ' Hz' : (f / 1000).toFixed(2) + ' kHz'} · ${S.sfBands.width[i].toFixed(0)}% of energy in the sides`;
  });

  // ===================================================================
  // Playback chain
  // ===================================================================
  const EQ_DEFS = [
    { freq: 80, q: 0.8, type: 'lowshelf' }, { freq: 350, q: 1.1, type: 'peaking' }, { freq: 1000, q: 1.0, type: 'peaking' },
    { freq: 3200, q: 0.9, type: 'peaking' }, { freq: 6500, q: 1.0, type: 'peaking' }, { freq: 12000, q: 0.8, type: 'highshelf' },
  ];
  let eqBands = [];
  function setupChain() {
    const ctx = audioCtx;
    const normGain = ctx.createGain();
    const prevEq = eqBands.map(b => ({ f: b.node.frequency.value, g: b.node.gain.value, q: b.node.Q.value }));
    eqBands = EQ_DEFS.map((d, i) => {
      const node = ctx.createBiquadFilter(); node.type = d.type;
      node.frequency.value = prevEq[i] ? prevEq[i].f : d.freq; node.Q.value = prevEq[i] ? prevEq[i].q : d.q; node.gain.value = prevEq[i] ? prevEq[i].g : 0;
      return { ...d, node };
    });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = 0; comp.ratio.value = 1; comp.knee.value = 6; comp.attack.value = 0.003; comp.release.value = 0.15;
    const makeup = ctx.createGain();
    const dry = ctx.createGain(), wet = ctx.createGain(); dry.gain.value = monoOn ? 0 : 1; wet.gain.value = monoOn ? 1 : 0;
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const half = ctx.createGain(); half.gain.value = 0.5;
    const post = ctx.createGain();
    const analyser = ctx.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0.75;
    const scopeSplit = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser(), analyserR = ctx.createAnalyser(); analyserL.fftSize = 2048; analyserR.fftSize = 2048;
    // static wiring (source connects to normGain per play)
    let n = normGain; eqBands.forEach(b => { n.connect(b.node); n = b.node; }); n.connect(comp); comp.connect(makeup);
    makeup.connect(dry); dry.connect(post);
    makeup.connect(split); split.connect(half, 0); split.connect(half, 1); half.connect(merge, 0, 0); half.connect(merge, 0, 1);
    merge.connect(wet); wet.connect(post);
    post.connect(analyser); analyser.connect(ctx.destination);
    post.connect(scopeSplit); scopeSplit.connect(analyserL, 0); scopeSplit.connect(analyserR, 1);
    chain = { normGain, comp, makeup, dry, wet, analyser, analyserL, analyserR };
    applyMode(abMode, true);
  }
  function normLinear() { const l = S.metrics && S.metrics.lufs; return isFinite(l) ? Math.pow(10, (-14 - l) / 20) : 1; }
  function modeGain() { return abMode === 'original' ? 1 : normLinear(); }
  function applyMode(mode, instant) {
    if (mode === 'mastered' && !S.mastered) {
      toast('Render a master first: Tools → Master to −14.');
      setTab('tools'); setTimeout(() => $('masterPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      return;
    }
    const swapSource = isPlaying && ((abMode === 'mastered') !== (mode === 'mastered'));
    abMode = mode;
    document.querySelectorAll('#abSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    if (!chain) return;
    const t = audioCtx.currentTime, tc = instant ? 0.001 : 0.04;
    chain.normGain.gain.cancelScheduledValues(t);
    chain.normGain.gain.setTargetAtTime(mode === 'original' ? 1 : normLinear(), t, tc);
    if (swapSource) seekTo(currentPos(), true);
  }
  document.querySelectorAll('#abSeg button').forEach(b => b.addEventListener('click', () => applyMode(b.dataset.mode)));
  function setMono(on) {
    monoOn = on; $('monoBtn').setAttribute('aria-pressed', String(on));
    if (!chain) return;
    const t = audioCtx.currentTime;
    chain.wet.gain.setTargetAtTime(on ? 1 : 0, t, 0.01); chain.dry.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
  }
  $('monoBtn').addEventListener('click', () => setMono(!monoOn));

  function currentPos() { return isPlaying ? Math.min(S.buffer.duration, audioCtx.currentTime - playStartTime) : playOffset; }

  async function play() {
    if (!S.buffer || S.meterSong) return;
    stopPreview();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (playOffset >= S.buffer.duration - 0.05) playOffset = 0;
    sourceNode = audioCtx.createBufferSource();
    const useMaster = abMode === 'mastered' && S.mastered;
    sourceNode.buffer = useMaster ? S.mastered.buffer : S.buffer;
    // the master already has its own EQ and level, so it skips the playback EQ
    sourceNode.connect(useMaster ? chain.makeup : chain.normGain);
    sourceNode.start(0, playOffset);
    playStartTime = audioCtx.currentTime - playOffset;
    isPlaying = true; liveTop = -Infinity;
    sourceNode.onended = () => { isPlaying = false; playOffset = 0; afterStop(); };
    setPlayIcon(true);
    loop();
  }
  function pause() {
    if (!isPlaying) return;
    playOffset = currentPos();
    sourceNode.onended = null; try { sourceNode.stop(); } catch (e) {}
    isPlaying = false; afterStop();
  }
  function afterStop() {
    cancelAnimationFrame(raf); setPlayIcon(false); updateTransport(playOffset);
    if (S.activeTab === 'tone') drawStaticSpectrum();
    if (S.activeTab === 'stereo') drawStaticScope();
    redrawPlayheads();
  }
  function togglePlay() { isPlaying ? pause() : play(); }
  function seekTo(t, startPlaying) {
    if (!S.buffer || S.meterSong) return;
    const was = isPlaying || startPlaying;
    if (isPlaying) { sourceNode.onended = null; try { sourceNode.stop(); } catch (e) {} isPlaying = false; cancelAnimationFrame(raf); }
    playOffset = Math.max(0, Math.min(S.buffer.duration - 0.01, t));
    updateTransport(playOffset); redrawPlayheads();
    if (was) play(); else setPlayIcon(false);
  }
  function stopEverything() {
    if (isPlaying && sourceNode) { sourceNode.onended = null; try { sourceNode.stop(); } catch (e) {} }
    isPlaying = false; cancelAnimationFrame(raf); setPlayIcon(false);
    stopPreview();
  }
  function setPlayIcon(p) {
    $('playIcon').innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', p ? 'Pause' : 'Play');
  }
  function loop() {
    if (!isPlaying) return;
    const pos = currentPos();
    updateTransport(pos);
    redrawPlayheads();
    if (S.activeTab === 'tone') drawLiveSpectrum();
    if (S.activeTab === 'stereo') drawLiveScope();
    raf = requestAnimationFrame(loop);
  }
  function redrawPlayheads() {
    if (S.activeTab === 'overview') drawWave('wfOverview');
    if (S.activeTab === 'tools') drawWave('wfEditor');
    if (S.activeTab === 'tone') drawSpectrogram();
  }
  function updateTransport(pos) {
    if (!S.buffer) return;
    const d = S.buffer.duration, f = Math.max(0, Math.min(1, pos / d));
    $('tTime').textContent = `${fmtTime(pos)} / ${fmtTime(d)}`;
    $('scrubFill').style.width = (f * 100) + '%';
    $('scrubKnob').style.left = (f * 100) + '%';
    $('scrub').setAttribute('aria-valuetext', fmtTime(pos));
  }
  $('playBtn').addEventListener('click', togglePlay);
  (function scrubber() {
    const el = $('scrub'); let dragging = false, wasPlaying = false;
    const posFrom = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.buffer.duration; };
    el.addEventListener('pointerdown', e => { if (!S.buffer) return; dragging = true; wasPlaying = isPlaying; el.setPointerCapture(e.pointerId); if (isPlaying) pause(); playOffset = posFrom(e); updateTransport(playOffset); });
    el.addEventListener('pointermove', e => { if (!dragging) return; playOffset = posFrom(e); updateTransport(playOffset); redrawPlayheads(); });
    el.addEventListener('pointerup', e => { if (!dragging) return; dragging = false; seekTo(posFrom(e), wasPlaying); });
    el.addEventListener('keydown', e => {
      if (!S.buffer) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekTo(currentPos() + 5); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekTo(currentPos() - 5); }
    });
  })();
  $('wfOverview').addEventListener('click', e => {
    if (!S.buffer) return;
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width * S.buffer.duration, true);
  });

  document.addEventListener('keydown', e => {
    if (!S.buffer || e.metaKey || e.ctrlKey || e.altKey || $('app').classList.contains('hidden')) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight' && tag !== 'BUTTON') { e.preventDefault(); seekTo(currentPos() + 5); }
    else if (e.key === 'ArrowLeft' && tag !== 'BUTTON') { e.preventDefault(); seekTo(currentPos() - 5); }
    else if (e.key === 'm' || e.key === 'M') setMono(!monoOn);
    else if (/^[1-7]$/.test(e.key)) setTab(TABS[+e.key - 1]);
  });

  function audioBufferToWav(buffer, bits = 24) {
    const nCh = buffer.numberOfChannels, sr = buffer.sampleRate, n = buffer.length, bps = bits / 8, block = nCh * bps;
    const ab = new ArrayBuffer(44 + n * block), v = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * block, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * block, true); v.setUint16(32, block, true); v.setUint16(34, bits, true); ws(36, 'data'); v.setUint32(40, n * block, true);
    const chans = []; for (let c = 0; c < nCh; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    const max = Math.pow(2, bits - 1) - 1;
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      const q = Math.round(s * max);
      if (bits === 16) { v.setInt16(o, q, true); o += 2; }
      else { v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3; }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const baseName = () => (S.fileName || 'master').replace(/\.[^.]+$/, '');
  // ===================================================================
  // EQ editor
  // ===================================================================
  const EQ_MIN = 20, EQ_MAX = 20000, EQ_G = 12, EQ_PAD = { l: 34, b: 18, t: 10, r: 8 };
  function eqGeom(w, h) { return { x0: EQ_PAD.l, W: w - EQ_PAD.l - EQ_PAD.r, y0: EQ_PAD.t, H: h - EQ_PAD.t - EQ_PAD.b }; }
  const eqX = (f, g) => g.x0 + Math.log(f / EQ_MIN) / Math.log(EQ_MAX / EQ_MIN) * g.W;
  const eqF = (x, g) => EQ_MIN * Math.pow(EQ_MAX / EQ_MIN, Math.max(0, Math.min(1, (x - g.x0) / g.W)));
  const eqY = (db, g) => g.y0 + (1 - (db + EQ_G) / (2 * EQ_G)) * g.H;
  const eqDb = (y, g) => Math.max(-EQ_G, Math.min(EQ_G, (1 - (y - g.y0) / g.H) * 2 * EQ_G - EQ_G));
  function biquadDb(type, f0, gain, q, fs, f) {
    const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    else {
      const t = 2 * Math.sqrt(A) * al, s = type === 'lowshelf' ? 1 : -1;
      b0 = A * ((A + 1) - s * (A - 1) * cw + t); b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cw); b2 = A * ((A + 1) - s * (A - 1) * cw - t);
      a0 = (A + 1) + s * (A - 1) * cw + t; a1 = -s * 2 * ((A - 1) + s * (A + 1) * cw); a2 = (A + 1) + s * (A - 1) * cw - t;
    }
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2, ni = -b1 * s1 - b2 * s2, dr = a0 + a1 * c1 + a2 * c2, di = -a1 * s1 - a2 * s2;
    return 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
  }
  function drawEq() {
    const c = prep('eqCanvas'); if (!c) return;
    const { ctx, w, h } = c, g = eqGeom(w, h);
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    freqAxis(ctx, g.x0, g.W, g.y0, g.y0 + g.H);
    [-12, -6, 0, 6, 12].forEach(d => { hline(ctx, eqY(d, g), g.x0, g.x0 + g.W, d === 0 ? css('--text-faint') : css('--grid')); label(ctx, d === 0 ? '0' : fmtSigned(d, 0), g.x0 - 4, eqY(d, g) + 3, 'right'); });
    if (!eqBands.length) return;
    const fs = audioCtx ? audioCtx.sampleRate : 48000;
    ctx.beginPath();
    for (let x = g.x0; x <= g.x0 + g.W; x += 2) {
      const f = eqF(x, g); let db = 0;
      eqBands.forEach(b => { db += biquadDb(b.type, b.node.frequency.value, b.node.gain.value, b.node.Q.value, fs, f); });
      const y = eqY(Math.max(-EQ_G, Math.min(EQ_G, db)), g);
      x === g.x0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.2; ctx.stroke();
    eqBands.forEach((b, i) => {
      const x = eqX(b.node.frequency.value, g), y = eqY(b.node.gain.value, g);
      ctx.beginPath(); ctx.arc(x, y, i === eqDrag ? 9 : 7.5, 0, Math.PI * 2);
      ctx.fillStyle = css('--surface'); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css('--accent'); ctx.stroke();
      ctx.fillStyle = css('--text'); ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 3.5);
    });
  }
  let eqDrag = -1;
  function eqHit(e) {
    const r = $('eqCanvas').getBoundingClientRect(), g = eqGeom(r.width, r.height), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bd = 24;
    eqBands.forEach((b, i) => { const d = Math.hypot(mx - eqX(b.node.frequency.value, g), my - eqY(b.node.gain.value, g)); if (d < bd) { bd = d; best = i; } });
    return { best, g, mx, my };
  }
  function eqReadout(i) {
    const b = eqBands[i];
    $('eqReadout').textContent = `Band ${i + 1} (${b.type === 'peaking' ? 'bell' : b.type === 'lowshelf' ? 'low shelf' : 'high shelf'}): ${fmtHz(Math.round(b.node.frequency.value))}Hz, ${fmtSigned(b.node.gain.value)} dB, Q ${b.node.Q.value.toFixed(2)}`;
  }
  $('eqCanvas').addEventListener('pointerdown', e => {
    if (!eqBands.length) return;
    const { best } = eqHit(e); if (best < 0) return;
    eqDrag = best; e.currentTarget.setPointerCapture(e.pointerId); drawEq();
  });
  $('eqCanvas').addEventListener('pointermove', e => {
    if (eqDrag < 0) return;
    const r = e.currentTarget.getBoundingClientRect(), g = eqGeom(r.width, r.height);
    const b = eqBands[eqDrag];
    b.node.frequency.value = Math.round(eqF(e.clientX - r.left, g));
    b.node.gain.value = Math.round(eqDb(e.clientY - r.top, g) * 2) / 2;
    eqReadout(eqDrag); drawEq();
  });
  const eqEnd = () => { if (eqDrag >= 0) { eqDrag = -1; drawEq(); eqChanged(); } };
  $('eqCanvas').addEventListener('pointerup', eqEnd);
  $('eqCanvas').addEventListener('pointercancel', eqEnd);
  $('eqCanvas').addEventListener('wheel', e => {
    const { best } = eqHit(e); if (best < 0) return;
    e.preventDefault();
    const b = eqBands[best];
    b.node.Q.value = Math.max(0.3, Math.min(8, b.node.Q.value * (e.deltaY < 0 ? 1.1 : 0.9)));
    eqReadout(best); drawEq(); clearTimeout(eqWheelT); eqWheelT = setTimeout(eqChanged, 400);
  }, { passive: false });
  let eqWheelT = 0;
  function eqChanged() { if (S.mastered) renderMasterResult(); }
  function resetEq() {
    eqBands.forEach((b, i) => { b.node.frequency.value = EQ_DEFS[i].freq; b.node.Q.value = EQ_DEFS[i].q; b.node.gain.value = 0; });
  }
  $('eqFlatBtn').addEventListener('click', () => { resetEq(); drawEq(); $('eqReadout').textContent = 'EQ reset to flat.'; eqChanged(); });

  // Suggested curve based on this track's findings
  function suggestedCurve() {
    const m = S.metrics, g = [0, 0, 0, 0, 0, 0], why = [];
    if (m.subBassGap > 4) { g[0] = -Math.min(3, (m.subBassGap - 2) / 2); why.push(`low shelf ${fmtSigned(g[0])} dB to tame the sub`); }
    if (m.lowMidBump > 1.5) { g[1] = -Math.min(4, m.lowMidBump); why.push(`${fmtSigned(g[1])} dB at 350 Hz for the low-mid bump`); }
    if (m.tilt < -2.5) {
      const amt = Math.min(3, (-m.tilt - 1.5));
      g[3] = Math.round(amt * 2) / 2; g[5] = Math.round(amt * 0.75 * 2) / 2;
      why.push(`${fmtSigned(g[3])} dB at 3.2 kHz and ${fmtSigned(g[5])} dB high shelf to open up a dark balance`);
    } else if (m.tilt > 0.5) {
      g[4] = -Math.min(3, (m.tilt + 0.5) * 1.5); why.push(`${fmtSigned(g[4])} dB at 6.5 kHz to soften a bright balance`);
    }
    if (!why.length) { g[1] = -1.5; g[3] = 1.5; why.push('a gentle −1.5 dB at 350 Hz and +1.5 dB at 3.2 kHz, since nothing stood out'); }
    return { g: g.map(v => Math.round(v * 2) / 2), why };
  }
  $('eqSuggestBtn').addEventListener('click', () => {
    if (!eqBands.length) return;
    resetEq();
    const s = suggestedCurve();
    eqBands.forEach((b, i) => { b.node.gain.value = s.g[i]; });
    drawEq(); $('eqReadout').textContent = 'Suggested: ' + s.why.join('; ') + '. You are hearing it now; Master to −14 below can include it.';
    eqChanged();
  });

  // ===================================================================
  // Region editor, quiet sections, sample zoom
  // ===================================================================
  (function editorPointer() {
    const cv = $('wfEditor'); let start = null, moved = false;
    const sampleAt = e => { const r = cv.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (S.buffer.length - 1)); };
    cv.addEventListener('pointerdown', e => { if (!S.buffer) return; start = sampleAt(e); moved = false; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      if (start === null) return;
      const cur = sampleAt(e);
      if (Math.abs(cur - start) > S.buffer.sampleRate * 0.02) moved = true;
      if (moved) { S.selection = { start: Math.min(start, cur), end: Math.max(start, cur) }; drawWave('wfEditor'); }
    });
    cv.addEventListener('pointerup', e => {
      if (start === null) return;
      if (!moved) seekTo(sampleAt(e) / S.buffer.sampleRate, isPlaying);
      else { selectionChanged(); }
      start = null;
    });
  })();
  function selectionChanged() {
    document.querySelectorAll('#quietList .row-item').forEach(x => x.classList.remove('selected'));
    renderRegionInfo(); drawWave('wfEditor'); zoomState = null;
    $('zoomPanel').classList.toggle('hidden', !S.selection);
    drawZoom();
  }
  function renderRegionInfo() {
    const el = $('regionInfo');
    if (!S.selection || !S.buffer) { el.textContent = 'Drag across the waveform to select a section. Click to move the playhead.'; return; }
    const fs = S.buffer.sampleRate, a = S.selection.start / fs, b = S.selection.end / fs;
    el.textContent = `Selected ${fmtTime(a)}–${fmtTime(b)} (${(b - a).toFixed(1)} s)`;
  }
  $('regionGain').addEventListener('input', () => { $('regionGainVal').textContent = `${fmtSigned(+$('regionGain').value)} dB`; });

  function applyRegionGain(buffer, start, end, gainDb) {
    const out = new AudioBuffer({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    const g = Math.pow(10, gainDb / 20), fade = Math.min(Math.round(0.02 * buffer.sampleRate), Math.floor((end - start) / 4));
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c), dst = out.getChannelData(c); dst.set(src);
      for (let i = start; i < end && i < dst.length; i++) {
        let k = g;
        if (fade > 0) { if (i - start < fade) k = 1 + (g - 1) * (i - start) / fade; else if (end - i < fade) k = 1 + (g - 1) * (end - i) / fade; }
        dst[i] = src[i] * k;
      }
    }
    return out;
  }
  function quickStats(buffer) {
    const l = DSP.loudness(buffer).integrated, tp = DSP.truePeak(buffer).truePeakDb;
    return { lufs: l, truePeak: tp, plr: tp - l };
  }
  function regionTable(after, label, loudnessMatched) {
    const m = S.metrics;
    const rows = [['Integrated loudness', m.lufs, after.lufs, 'LUFS'], ['True peak', m.truePeak, after.truePeak, 'dBTP'], ['PLR', m.plr, after.plr, 'dB']];
    $('regionTable').innerHTML = `<table class="data" style="margin-top:14px"><thead><tr><th>Metric</th><th>Original</th><th>${label}</th><th>Change</th></tr></thead><tbody>` +
      rows.map(([n, a, b, u]) => {
        const d = b - a;
        let cls = 'neutral';
        if (n === 'PLR') cls = d > 0.1 ? 'good' : d < -0.1 ? 'bad' : 'neutral';
        if (n === 'True peak') cls = d < -0.1 ? 'good' : d > 0.1 ? 'bad' : 'neutral';
        return `<tr><td>${n}</td><td>${fmt(a)} ${u}</td><td>${fmt(b)} ${u}</td><td class="delta ${cls}">${fmtSigned(d, 2)}</td></tr>`;
      }).join('') + '</tbody></table>' +
      (loudnessMatched ? '<p class="note">A higher PLR at the same loudness means the limiter would have less to do, so the loud sections keep more punch.</p>' : '<p class="note">Loudness changes here because only part of the track moved. In your DAW you would trim the master afterwards; "Boost all quiet sections" does this for you.</p>');
  }
  $('regionPreviewBtn').addEventListener('click', async () => {
    if (!S.selection) return toast('Drag across the waveform first to select a section.');
    const gain = +$('regionGain').value;
    $('regionTable').innerHTML = '<p class="note">Measuring…</p>'; await tick();
    S.adjusted = applyRegionGain(S.buffer, S.selection.start, S.selection.end, gain);
    regionTable(quickStats(S.adjusted), `Selection ${fmtSigned(gain)} dB`, false);
  });
  $('applyAllQuietBtn').addEventListener('click', async () => {
    if (!S.quietRegions.length) return;
    $('regionTable').innerHTML = '<p class="note">Applying and measuring…</p>'; await tick();
    let work = S.buffer;
    S.quietRegions.forEach(r => { work = applyRegionGain(work, r.start, r.end, r.gainDb); });
    const trim = S.metrics.lufs - DSP.loudness(work).integrated, k = Math.pow(10, trim / 20);
    const out = new AudioBuffer({ length: work.length, numberOfChannels: work.numberOfChannels, sampleRate: work.sampleRate });
    for (let c = 0; c < work.numberOfChannels; c++) { const s = work.getChannelData(c), d = out.getChannelData(c); for (let i = 0; i < s.length; i++) d[i] = s[i] * k; }
    S.adjusted = out;
    regionTable(quickStats(out), `Boosted, trimmed ${fmtSigned(trim, 2)} dB`, true);
  });
  $('regionPlayBtn').addEventListener('click', () => {
    if (!S.adjusted) return toast('Measure a change first.');
    if (previewWhich === 'adjusted') return stopPreview();
    const from = S.selection ? S.selection.start / S.buffer.sampleRate : currentPos();
    startPreview('adjusted', S.adjusted, 1, Math.max(0, from - 1));
  });
  $('regionDownloadBtn').addEventListener('click', () => {
    if (!S.adjusted) return toast('Measure a change first.');
    download(audioBufferToWav(S.adjusted, 24), `${baseName()}_region-gain.wav`);
  });
  $('regionResetBtn').addEventListener('click', () => {
    stopPreview(); S.adjusted = null; S.selection = null; S.quietRegions = [];
    $('regionGain').value = 0; $('regionGainVal').textContent = '0.0 dB';
    $('regionTable').innerHTML = ''; renderQuietList(); selectionChanged();
  });

  $('detectQuietBtn').addEventListener('click', () => {
    const st = S.loud.shortTerm, hop = 0.1, n = st.length;
    const valid = Array.from(st).filter(v => v > -60).sort((a, b) => a - b);
    if (!valid.length) return toast('Not enough signal to analyse.');
    const med = valid[Math.floor(valid.length / 2)], thr = med - 3.5, minLen = 20;
    const excl = Math.round(Math.min(5, S.buffer.duration * 0.04) / hop);
    let regs = [], s0 = null;
    for (let i = excl; i < n - excl; i++) {
      const dip = st[i] < thr && st[i] > -60;
      if (dip && s0 === null) s0 = i;
      if (!dip && s0 !== null) { if (i - s0 >= minLen) regs.push({ s: s0, e: i }); s0 = null; }
    }
    if (s0 !== null && n - excl - s0 >= minLen) regs.push({ s: s0, e: n - excl });
    const merged = [];
    regs.forEach(r => { if (merged.length && (r.s - merged[merged.length - 1].e) * hop < 1.5) merged[merged.length - 1].e = r.e; else merged.push({ ...r }); });
    const avg = r => { let s = 0; for (let i = r.s; i < r.e; i++) s += st[i]; return s / (r.e - r.s); };
    let list = merged.map(r => ({ ...r, below: med - avg(r) })).sort((a, b) => b.below * (b.e - b.s) - a.below * (a.e - a.s)).slice(0, 4);
    let fallback = false;
    if (!list.length) {
      const win = 20; let best = -1, bestAvg = Infinity;
      for (let i = excl; i + win <= n - excl; i++) { const a = avg({ s: i, e: i + win }); if (a < bestAvg) { bestAvg = a; best = i; } }
      if (best >= 0 && med - bestAvg > 1.2) { list = [{ s: best, e: best + win, below: med - bestAvg }]; fallback = true; }
    }
    const fs = S.buffer.sampleRate;
    // short-term value i covers [i*hop, i*hop + 3 s]; use the window centre
    S.quietRegions = list.map(r => {
      const a = Math.max(0, r.s * hop + 1.5 - hop / 2), b = Math.min(S.buffer.duration, r.e * hop + 1.5);
      return { start: Math.round(a * fs), end: Math.round(b * fs), startSec: a, endSec: b, belowBy: r.below, gainDb: Math.round(Math.min(8, Math.max(1, r.below * 0.8)) * 2) / 2, fallback };
    }).sort((a, b) => a.startSec - b.startSec);
    renderQuietList(); drawWave('wfEditor');
    if (!S.quietRegions.length) toast('Levels are consistent throughout: no quiet sections worth automating.');
  });
  function renderQuietList() {
    $('applyAllQuietBtn').disabled = !S.quietRegions.length;
    $('quietList').innerHTML = S.quietRegions.map((r, i) => `
      <div class="row-item" data-i="${i}"><span class="ri-name">#${i + 1} · ${fmtTime(r.startSec)}–${fmtTime(r.endSec)}</span>
      <span class="ri-meta">${fmt(r.belowBy)} dB below typical${r.fallback ? ' (quietest stretch)' : ''} · suggest ${fmtSigned(r.gainDb)} dB</span></div>`).join('');
    $('quietList').style.marginTop = S.quietRegions.length ? '12px' : '0';
    document.querySelectorAll('#quietList .row-item').forEach(el => el.addEventListener('click', () => {
      const r = S.quietRegions[+el.dataset.i];
      S.selection = { start: r.start, end: r.end };
      $('regionGain').value = r.gainDb; $('regionGainVal').textContent = `${fmtSigned(r.gainDb)} dB`;
      selectionChanged(); el.classList.add('selected');
    }));
  }

  let zoomState = null;
  function drawZoom() {
    if (!S.selection || $('zoomPanel').classList.contains('hidden')) return;
    if (!zoomState) zoomState = { ...S.selection };
    const c = prep('zoomCanvas'); if (!c) return;
    const { ctx, w, h } = c, data = S.buffer.getChannelData(0);
    const s = Math.max(0, zoomState.start), e = Math.min(data.length, zoomState.end), n = e - s, mid = h / 2;
    ctx.fillStyle = css('--surface-2'); ctx.fillRect(0, 0, w, h);
    hline(ctx, mid, 0, w, css('--grid'));
    [1, -1].forEach(v => hline(ctx, mid - v * mid * 0.9, 0, w, css('--grid')));
    label(ctx, '0 dBFS', 4, mid - mid * 0.9 - 3);
    $('zoomLabel').textContent = `${n.toLocaleString()} samples · ${(n / S.buffer.sampleRate * 1000).toFixed(1)} ms · left channel`;
    ctx.strokeStyle = css('--accent'); ctx.fillStyle = css('--accent'); ctx.lineWidth = 1.4;
    if (n <= w) {
      const xs = w / n; ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = i * xs, y = mid - data[s + i] * mid * 0.9; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      if (xs > 4) for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(i * xs, mid - data[s + i] * mid * 0.9, 2.3, 0, Math.PI * 2); ctx.fill(); }
    } else {
      const st = n / w;
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1; const a = s + Math.floor(x * st), b = s + Math.floor((x + 1) * st);
        for (let j = a; j < b; j++) { const v = data[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
        ctx.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
      }
    }
  }
  $('zoomCanvas').addEventListener('mousemove', e => {
    if (!zoomState) return;
    const r = e.currentTarget.getBoundingClientRect(), n = zoomState.end - zoomState.start;
    const i = zoomState.start + Math.floor((e.clientX - r.left) / r.width * n), v = S.buffer.getChannelData(0)[i];
    if (v === undefined) return;
    $('zoomReadout').textContent = `Sample ${i.toLocaleString()} · ${(i / S.buffer.sampleRate).toFixed(5)} s · ${v.toFixed(5)} (${fmt(20 * Math.log10(Math.abs(v) || 1e-10))} dBFS)`;
  });
  $('zoomInBtn').addEventListener('click', () => { if (!zoomState) return; const m = (zoomState.start + zoomState.end) / 2, hw = Math.max(20, (zoomState.end - zoomState.start) / 4); zoomState = { start: Math.floor(m - hw), end: Math.floor(m + hw) }; drawZoom(); });
  $('zoomOutBtn').addEventListener('click', () => { if (!zoomState) return; const m = (zoomState.start + zoomState.end) / 2, hw = zoomState.end - zoomState.start; zoomState = { start: Math.max(0, Math.floor(m - hw)), end: Math.min(S.buffer.length, Math.floor(m + hw)) }; drawZoom(); });

  // Simple player for previews (adjusted audio, reference compare)
  function startPreview(which, buffer, gain, offset) {
    if (isPlaying) pause();
    stopPreview();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const src = audioCtx.createBufferSource(); src.buffer = buffer;
    const g = audioCtx.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(audioCtx.destination);
    offset = Math.max(0, Math.min(buffer.duration - 0.05, offset));
    src.start(0, offset);
    previewSource = src; previewWhich = which; previewStart = audioCtx.currentTime; previewOffset = offset;
    src.onended = () => { if (previewSource === src) stopPreview(); };
    updatePreviewButtons();
  }
  function previewPos() { return previewSource ? previewOffset + (audioCtx.currentTime - previewStart) : 0; }
  function stopPreview() {
    if (previewSource) { const s = previewSource; previewSource = null; s.onended = null; try { s.stop(); } catch (e) {} }
    previewWhich = null; updatePreviewButtons();
  }
  function updatePreviewButtons() {
    $('regionPlayBtn').textContent = previewWhich === 'adjusted' ? 'Stop' : 'Play adjusted';
    $('refPlayMine').setAttribute('aria-pressed', String(previewWhich === 'mine'));
    $('refPlayRef').setAttribute('aria-pressed', String(previewWhich === 'ref'));
  }

  // ===================================================================
  // Reference
  // ===================================================================
  $('refLoadBtn').addEventListener('click', () => $('refInput').click());
  $('refInput').addEventListener('change', async () => {
    const f = $('refInput').files[0]; $('refInput').value = ''; if (!f) return;
    if (/\.json$/i.test(f.name)) {
      let obj = null; try { obj = JSON.parse(await f.text()); } catch (e) {}
      if (isMeterExport(obj)) return loadMeterExport(obj, f.name);
      return toast('That .json file isn’t a MasterScope Meter export.');
    }
    if (!audioCtx) await ensureContext();
    $('refEmpty').textContent = `Analysing ${f.name}…`; $('refEmpty').classList.remove('hidden'); $('refContent').classList.add('hidden');
    await tick();
    try {
      const buf = await audioCtx.decodeAudioData(await f.arrayBuffer());
      await tick();
      const sum = DSP.summary(buf);
      S.ref = { buffer: buf, name: f.name, sum };
      try { S.ref.budget = DSP.loudnessBudget(buf, sum.tone, null); } catch (e) { S.ref.budget = null; }
      S.ref.bars = refBarsFor(S.ref);
      computeRefDiffs(); renderRefContent(); renderToneTiles(); renderReadiness(); renderPeaksDensity();
      toast('Reference loaded. Its tonal curve is now on the Tone tab.');
    } catch (e) {
      $('refEmpty').textContent = 'That file couldn’t be decoded. Try WAV, AIFF, FLAC or MP3.';
    }
  });
  $('refClearBtn').addEventListener('click', () => { if (previewWhich === 'ref' || previewWhich === 'mine') stopPreview(); const wasMeter = S.ref && S.ref.meter; S.ref = null; if (wasMeter) setMeterRef(null); computeRefDiffs(); renderRefContent(); renderToneTiles(); renderReadiness(); renderPeaksDensity(); renderMeterRef(); });
  function comparePos() { return (previewWhich === 'mine' || previewWhich === 'ref') ? previewPos() : currentPos(); }
  $('refPlayMine').addEventListener('click', () => { if (!S.ref || !S.ref.buffer) return; startPreview('mine', S.buffer, normLinear(), comparePos()); });
  $('refPlayRef').addEventListener('click', () => {
    if (!S.ref || !S.ref.buffer) return;
    const l = S.ref.sum.lufs, g = isFinite(l) ? Math.pow(10, (-14 - l) / 20) : 1;
    startPreview('ref', S.ref.buffer, g, comparePos() % S.ref.buffer.duration);
  });
  $('refStop').addEventListener('click', stopPreview);
  function verdictHtml(V) {
    if (!V) return '';
    const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
    return `<div class="verdict-box"><div class="vh">${esc(V.headline)}</div>
      ${V.reasons.length ? `<div class="lb-lead" style="margin:0">Why the reference may sound bigger at −14:</div><ul>${V.reasons.map(r => `<li>${esc(cap(r))}.</li>`).join('')}</ul>` : ''}
      ${V.notes.length ? `<div class="vn">Other differences: ${esc(V.notes.join('; '))}.</div>` : ''}</div>`;
  }
  function renderRefContent() {
    const has = !!S.ref;
    $('refEmpty').classList.toggle('hidden', has);
    if (!has) $('refEmpty').textContent = 'Load a released track in a similar style, or a MasterScope Meter export of a song you measured. Its tonal curve will also appear on the Tone tab.';
    $('refContent').classList.toggle('hidden', !has);
    $('refClearBtn').classList.toggle('hidden', !has);
    if (!has || !S.metrics) return;
    $('refName').textContent = S.ref.meter ? `${S.ref.name}: measured by MasterScope Meter (numbers only, so it can't be played here)` : S.ref.name;
    $('refPlayMine').closest('.controls').classList.toggle('hidden', !!S.ref.meter);
    $('refVerdict').innerHTML = verdictHtml(S.refVerdict);
    $('refDiffs').innerHTML = S.refDiffs && S.refDiffs.length
      ? S.refDiffs.slice(0, 6).map((d, i) => `<div class="diff"><div class="dn">${i + 1}</div><div><b>${esc(d.label)}</b><span>${esc(d.text)}</span></div></div>`).join('')
      : '<div class="empty">Your track is close to the reference on every measure.</div>';
    const m = S.metrics, r = S.ref.sum;
    const rows = [
      ['Integrated loudness', m.lufs, r.lufs, 'LUFS', 1], ['True peak', m.truePeak, r.truePeak, 'dBTP', 1],
      ['Peak-to-loudness (PLR)', m.plr, r.plr, 'dB', 1], ['Loudness range', m.lra, r.lra, 'LU', 1], ['Crest factor', m.crest, r.crest, 'dB', 1],
      ['Tonal tilt', m.tilt, r.tilt, 'dB/oct', 1], ['Presence vs low mids', m.lowMidPresenceGap, r.lowMidPresenceGap, 'dB', 1],
      ['Sub vs bass', m.subBassGap, r.subBassGap, 'dB', 1], ['Phase correlation', m.corr, r.corr, '', 2],
      ['Stereo width', m.width, r.width, '%', 0], ['Bass width 60–200 Hz', m.lowWidth, r.lowWidth, '%', 0],
    ];
    $('refTable').innerHTML = `<table class="data"><thead><tr><th>Metric</th><th>Yours</th><th>Reference</th><th>Difference</th></tr></thead><tbody>` +
      rows.map(([n, a, b, u, d]) => `<tr><td>${n}</td><td>${fmt(a, d)} ${u}</td><td>${fmt(b, d)} ${u}</td><td class="delta neutral">${isFinite(a) && isFinite(b) ? fmtSigned(a - b, d) : '—'}</td></tr>`).join('') +
      '</tbody></table>';
  }

  // ===================================================================
  // Version history
  // ===================================================================
  const HKEY = 'masterscope_version_history', HMAX = 50;
  let histSel = [];
  const loadHist = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; } };
  const saveHist = l => { try { localStorage.setItem(HKEY, JSON.stringify(l)); } catch (e) {} };
  function saveHistory() {
    const m = S.metrics, t = S.trans;
    const entry = {
      v: 2, id: 'v' + Date.now() + Math.random().toString(36).slice(2, 6), name: S.fileName, date: Date.now(),
      lufs: m.lufs, truePeak: m.truePeak, plr: m.plr, lra: m.lra, crest: m.crest,
      tilt: m.tilt, lowMidPresenceGap: m.lowMidPresenceGap, subBassGap: m.subBassGap, lowMidBump: m.lowMidBump,
      corr: m.corr, width: m.width, bassWidth: m.bassWidth, lowWidth: m.lowWidth,
      hitVsRms: t ? t.hitVsRmsDb : null, kickRise: t ? t.kickRiseDb : null,
    };
    const list = loadHist(); list.push(entry); while (list.length > HMAX) list.shift(); saveHist(list);
    renderHistory();
  }
  const HMETRICS = [
    ['Integrated loudness', 'lufs', 'LUFS', 1, (a, b) => Math.abs(b + 14) < Math.abs(a + 14) - 0.1 ? 'good' : Math.abs(b + 14) > Math.abs(a + 14) + 0.1 ? 'bad' : 'neutral'],
    ['True peak', 'truePeak', 'dBTP', 1, (a, b) => b < a - 0.1 ? 'good' : b > a + 0.1 && b > -1 ? 'bad' : 'neutral'],
    ['Peak-to-loudness', 'plr', 'dB', 1, () => 'neutral'],
    ['Loudness range', 'lra', 'LU', 1, () => 'neutral'],
    ['Tonal tilt', 'tilt', 'dB/oct', 1, (a, b) => Math.abs(b + 1.5) < Math.abs(a + 1.5) - 0.2 ? 'good' : Math.abs(b + 1.5) > Math.abs(a + 1.5) + 0.2 ? 'bad' : 'neutral'],
    ['Low-mid bump', 'lowMidBump', 'dB', 1, (a, b) => b < a - 0.3 && a > 1 ? 'good' : b > a + 0.3 && b > 1 ? 'bad' : 'neutral'],
    ['Sub vs bass', 'subBassGap', 'dB', 1, () => 'neutral'],
    ['Phase correlation', 'corr', '', 2, (a, b) => { const ok = v => v >= 0.25; return ok(b) && !ok(a) ? 'good' : !ok(b) && ok(a) ? 'bad' : 'neutral'; }],
    ['Stereo width', 'width', '%', 0, () => 'neutral'],
    ['Bass width 60–200 Hz', 'lowWidth', '%', 0, (a, b) => b < a - 2 && a > 10 ? 'good' : b > a + 2 && b > 10 ? 'bad' : 'neutral'],
    ['Hit level above mix', 'hitVsRms', 'dB', 1, () => 'neutral'],
    ['Kick-band rise', 'kickRise', 'dB', 1, (a, b) => b > a + 1 && a < 6 ? 'good' : b < a - 1 && b < 6 ? 'bad' : 'neutral'],
  ];
  function renderHistory() {
    const list = loadHist().slice().reverse();
    histSel = histSel.filter(id => list.some(e => e.id === id));
    $('histCount').textContent = list.length ? `${list.length} version${list.length > 1 ? 's' : ''} saved in this browser. Select two to compare.` : 'No versions yet. Every file you analyse is added here automatically.';
    $('histList').innerHTML = list.map(e => `
      <div class="row-item ${histSel.includes(e.id) ? 'selected' : ''}" data-id="${e.id}">
        <input type="checkbox" tabindex="-1" ${histSel.includes(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.name || 'version')}">
        <span class="ri-name">${esc(e.name || 'Untitled')}</span>
        <span class="ri-meta">${fmt(e.lufs)} LUFS · ${fmt(e.truePeak)} dBTP · ${new Date(e.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="ri-del" data-del="${e.id}" aria-label="Delete">✕</button>
      </div>`).join('');
    $('histList').querySelectorAll('.row-item').forEach(el => el.addEventListener('click', ev => {
      const del = ev.target.closest('[data-del]');
      if (del) { saveHist(loadHist().filter(x => x.id !== del.dataset.del)); renderHistory(); return; }
      const id = el.dataset.id;
      if (histSel.includes(id)) histSel = histSel.filter(x => x !== id); else { histSel.push(id); if (histSel.length > 2) histSel.shift(); }
      renderHistory();
    }));
    if (histSel.length === 2) {
      let [a, b] = histSel.map(id => list.find(e => e.id === id));
      if (a.date > b.date) [a, b] = [b, a];
      const sameVer = a.v === 2 && b.v === 2;
      const metrics = sameVer ? HMETRICS : HMETRICS.slice(0, 2);
      $('histCompare').innerHTML = `<table class="data"><thead><tr><th>Metric</th><th>${esc(a.name || 'Before')}</th><th>${esc(b.name || 'After')}</th><th>Change</th></tr></thead><tbody>` +
        metrics.map(([n, k, u, d, judge]) => {
          const x = a[k], y = b[k];
          if (x === null || y === null || x === undefined || y === undefined || !isFinite(x) || !isFinite(y)) return '';
          return `<tr><td>${n}</td><td>${fmt(x, d)} ${u}</td><td>${fmt(y, d)} ${u}</td><td class="delta ${judge(x, y)}">${fmtSigned(y - x, d)}</td></tr>`;
        }).join('') + '</tbody></table>' +
        (sameVer ? '' : '<p class="note">One of these was measured by an earlier version of MasterScope, so only loudness and true peak are compared.</p>');
    } else $('histCompare').innerHTML = '';
  }
  $('histExportBtn').addEventListener('click', () => {
    const l = loadHist(); if (!l.length) return toast('No history to export yet.');
    download(new Blob([JSON.stringify(l, null, 2)], { type: 'application/json' }), 'masterscope_history.json');
  });
  $('histImportBtn').addEventListener('click', () => $('histInput').click());
  $('histInput').addEventListener('change', () => {
    const f = $('histInput').files[0]; $('histInput').value = ''; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const imp = JSON.parse(rd.result); if (!Array.isArray(imp)) throw new Error('not a history file');
        const ex = loadHist(), ids = new Set(ex.map(e => e.id));
        const merged = ex.concat(imp.filter(e => e && e.id && !ids.has(e.id))).sort((a, b) => a.date - b.date).slice(-HMAX);
        saveHist(merged); renderHistory(); toast(`Imported ${imp.length} version${imp.length === 1 ? '' : 's'}.`);
      } catch (e) { toast('That file isn’t a MasterScope history export.'); }
    };
    rd.readAsText(f);
  });
  $('histClearBtn').addEventListener('click', () => {
    if (!loadHist().length) return;
    if (confirm('Delete all saved versions from this browser? This can’t be undone.')) { saveHist([]); histSel = []; renderHistory(); }
  });


  // ===================================================================
  // Liminal sessions: the plugin's Record button saves a .json session that
  // opens here with its numbers, verdicts, a timeline and the settings used.
  // ===================================================================
  let sessionReturn = 'landing', lastSession = null, lastSessionFindings = [];
  async function openSession(file) {
    let obj = null;
    try { obj = JSON.parse(await file.text()); } catch (e) { /* not JSON */ }
    if (isMeterExport(obj)) return openMeterSong(obj, file.name);
    if (!obj || obj.format !== 'liminal-session') return toast('That .json file isn’t a Liminal session or a MasterScope Meter export.');
    const appVisible = !$('app').classList.contains('hidden');
    sessionReturn = appVisible ? 'app' : 'landing';
    if (appVisible) stopEverything();
    lastSession = obj;
    renderSession(obj, file.name);
    showView('session');
    window.scrollTo(0, 0);
  }
  $('sessBack').addEventListener('click', () => showView(sessionReturn === 'app' && S && S.sf ? 'app' : 'landing'));
  window.addEventListener('resize', () => { if (lastSession && !$('session').classList.contains('hidden')) drawSessionChart(lastSession); });

  let lastSessionName = '';
  function renderSession(s, name) {
    lastSessionName = name.replace(/\.json$/i, '');
    const sum = Object.fromEntries(Object.entries(s.summary || {}).map(([k, v]) => [k, v === null ? NaN : v])), set = s.settings || {}, tl = s.timeline || {};   // null = not measured
    const target = isFinite(set.target) ? set.target : -14;
    const ceil = isFinite(set.ceiling) ? set.ceiling : -1;
    const plrMode = set.targetMode === 1, plrTarget = isFinite(set.targetPLR) ? set.targetPLR : 10;
    const ceilMode = isFinite(set.ceilingMode) ? set.ceilingMode : 0;
    const created = s.created ? new Date(s.created) : null;
    $('sessTitle').textContent = name.replace(/\.json$/i, '');
    $('sessMeta').textContent = [s.plugin || 'Liminal', created && !isNaN(created) ? created.toLocaleString() : '', isFinite(s.durationSec) ? fmtTime(s.durationSec) + (s.source === 'learn' ? ' rendered by Learn' : s.source === 'release' ? ' rendered for the release pack' : ' recorded') : '', s.sampleRate ? (s.sampleRate / 1000) + ' kHz' : ''].filter(Boolean).join(' · ');
    $('sessSub').textContent = (plrMode ? `Target density PLR ${fmt(plrTarget)}` : `Target ${fmt(target)} LUFS`) + ` · ceiling ${fmt(ceil)} dB` + (ceilMode === 1 ? ' after Opus and Vorbis' : ceilMode === 2 ? ' after every codec' : ' true peak')
      + (s.source === 'learn' ? ' · from Learn: what it heard, rendered at the threshold it set' : s.source === 'release' ? ' · release pack master' : '');
    document.querySelector('#session .eyebrow').textContent = s.source === 'learn' ? 'Liminal Learn report' : s.source === 'release' ? 'Liminal release pack master' + ((s.summary || {}).releaseTarget ? ' · ' + s.summary.releaseTarget : '') : 'Liminal session';

    const I = sum.integrated, tp = sum.truePeakOut, plr = sum.plr;
    // In density mode the loudness "target" is where this song's peak sits minus the PLR
    const effTarget = plrMode && isFinite(tp) ? tp - plrTarget : target, d = I - effTarget;
    const iStatus = !isFinite(I) ? '' : Math.abs(d) <= 1 ? 'ok' : 'warn';
    const tpStatus = !isFinite(tp) ? '' : tp > ceil + 0.05 ? 'danger' : 'ok';
    const cpi = sessionCodec(s), cp = cpi.value;
    const cpStatus = !isFinite(cp) ? '' : cp > ceil + 0.05 ? (cp > 0 ? 'danger' : 'warn') : cp > -0.5 ? 'warn' : 'ok';
    const plrStatus = !isFinite(plr) ? '' : plr < 8 ? 'warn' : 'ok';
    const pu = (s.summary || {}).punch || null;
    const gra = sum.grAvg, graStatus = !isFinite(gra) ? '' : gra > 4 ? 'warn' : 'ok';
    const pct = sum.grPercent, pctStatus = !isFinite(pct) ? '' : pct > 50 ? 'warn' : 'ok';
    $('sessTiles').innerHTML = [
      tile('Integrated', fmt(I), 'LUFS', plrMode ? '' : iStatus, isFinite(I) ? (plrMode ? 'Density target: PLR ' + fmt(plrTarget) : Math.abs(d) < 0.25 ? 'On target' : `${fmt(Math.abs(d))} LU ${d < 0 ? 'under' : 'over'} target`) : ''),
      tile('Max short-term', fmt(sum.maxShortTerm), 'LUFS', '', 'Loudest 3 s'),
      tile('True peak', fmt(tp), 'dBTP', tpStatus, tpStatus === 'danger' ? 'Over the ceiling' : 'Under the ceiling'),
      tile(cpi.label, fmt(cp), 'dB', cpStatus, cpi.note),
      tile('PLR', fmt(plr), 'dB', plrMode ? (isFinite(plr) && Math.abs(plr - plrTarget) <= 0.5 ? 'ok' : 'warn') : plrStatus, !isFinite(plr) ? '' : plrMode ? (Math.abs(plr - plrTarget) <= 0.5 ? 'On the density target' : `Target ${fmt(plrTarget)}`) : plr < 8 ? 'Squashed' : plr <= 13 ? 'Competitive' : 'Very dynamic'),
      pu ? tile('Punch', fmt(pu.out), 'dB', pu.loss > 5 ? 'danger' : pu.loss > 3 ? 'warn' : 'ok', `Limiter takes ${fmt(Math.max(0, pu.loss))} dB off the hits`)
         : tile('LRA', fmt(sum.lra), 'LU', '', 'Loudness range'),
      tile('Gain reduction', fmt(gra), 'dB avg', graStatus, isFinite(sum.grPeak) ? `Peak ${fmt(sum.grPeak)} dB` : ''),
      tile('Time limiting', isFinite(pct) ? Math.round(pct) : '—', '%', pctStatus, 'More than 0.5 dB'),
    ].join('');

    const F = [];
    if (isFinite(I)) {
      if (Math.abs(d) <= 1) F.push({ status: 'ok', title: `Loudness is on target (${fmt(I)} LUFS)`, body: I > -13.5 ? `Streaming services turn it down ${(I + 14).toFixed(1)} dB to about −14 and it keeps its density; it plays at this level wherever nothing normalises (Bandcamp, downloads, DJ sets).` : 'Streaming services will play it at about the level you mastered it.' });
      else if (d < -1) F.push({ status: 'warn', title: `${fmt(-d)} LU quieter than the target`, body: `Services only turn quiet tracks up if there is headroom, so it may play quieter than the competition. Lower Threshold, or press Learn in Liminal to land on ${fmt(target)} LUFS.` });
      else F.push({ status: d > 2 ? 'warn' : 'info', title: `${fmt(d)} LU louder than the target`, body: `Services will turn it down by about ${fmt(d)} dB, so the extra limiting buys no loudness, only less punch. Consider raising Threshold, or use Learn.` });
    }
    if (isFinite(tp)) F.push(tp > ceil + 0.05 ? { status: 'danger', title: `True peak ${fmt(tp)} dBTP is over the ${fmt(ceil)} dBTP ceiling`, body: 'Something after Liminal is adding level, or the ceiling was changed during the recording.' }
                                             : { status: 'ok', title: `True peak held at ${fmt(tp)} dBTP`, body: 'Safe for streaming delivery.' });
    if (isFinite(cp) && (cp > ceil + 0.05 || cp > -0.5)) F.push({ status: cpStatus, title: `${cpi.real ? 'Decoded peak' : 'Codec peak estimate'} ${fmt(cp)} dB`, body: ceilMode === 0
        ? 'Lossy encoders cut the top octave, which makes loud peaks overshoot. Set Liminal\'s ceiling mode to Streaming (or All codecs) and Learn again: it measures this song through real Opus and Vorbis encoders and keeps the decoded peaks under the ceiling.'
        : 'The decoded peaks are above the ceiling. Press Learn again so Liminal can re-measure this song through the real encoders.' });
    else if (cpi.real && isFinite(cp)) F.push({ status: 'ok', title: `Decoded peaks held at ${fmt(cp)} dB`, body: `Measured through real Opus (${fmt(cpi.opus)} dB) and Vorbis (${fmt(cpi.vorbis)} dB) encoders${ceilMode === 2 ? ', plus a 1 dB margin for MP3 and AAC' : ''}. Safe after streaming encoding.` });
    if (pu) F.push(pu.loss > 4 ? { status: 'warn', title: `The limiter takes ${fmt(pu.loss)} dB of punch`, body: 'The drums lose their snap. Try Optimise in Liminal (it ranks setups by punch at the same loudness), Punch Guard mode, a slower attack, or fix the loudest hits in the mix (Mix Doctor shows which).' }
                 : { status: 'ok', title: `Punch ${fmt(pu.out)} dB (${fmt(Math.max(0, pu.loss))} dB taken by the limiter)`, body: 'The hits still stand out from the music around them.' });
    if (isFinite(plr)) F.push(plr < 8 ? { status: 'warn', title: `PLR ${fmt(plr)} dB: heavily limited`, body: 'At -14 LUFS this costs punch with no loudness benefit. Back off the limiting, or let Bass first take the kick peaks.' }
                                      : plr <= 13 ? { status: 'ok', title: `PLR ${fmt(plr)} dB: competitive`, body: 'Punchy and dense, in the range of commercial masters at -14 LUFS.' }
                                                  : { status: 'info', title: `PLR ${fmt(plr)} dB: lots of dynamics`, body: 'Fine for acoustic or cinematic music; pop and electronic masters usually sit at 8-12 dB.' });
    if (isFinite(gra) && gra > 4) F.push({ status: 'warn', title: `Average gain reduction ${fmt(gra)} dB`, body: 'Constant heavy limiting tends to sound flat and can pump. Fix the loudest elements in the mix, or try Bass first.' });
    if (isFinite(sum.correlation) && sum.correlation < 0.3) F.push({ status: sum.correlation < 0 ? 'danger' : 'warn', title: `Phase correlation ${fmt(sum.correlation, 2)}`, body: 'Parts of the mix may cancel on mono speakers. Check wide effects and keep the low end mono.' });
    lastSessionFindings = F;
    $('sessFindings').innerHTML = F.map(f => `<div class="finding ${f.status}"><div class="ic">${STATUS_ICON[f.status]}</div><div><div class="ft">${esc(f.title)}</div><div class="fb">${esc(f.body)}</div></div></div>`).join('') || '<p class="note">No loudness data in this session yet.</p>';

    const MODES = ['Brickwall', 'Soft Clip', 'Lookahead', 'Multiband', 'Punch Guard'];
    const onOff = v => v ? 'On' : 'Off';
    const items = [
      ['Mode', MODES[set.mode] || set.mode], ['Threshold', fmt(set.threshold) + ' dB'], ['Ceiling', fmt(set.ceiling) + ' dBTP'],
      ['Input', fmtSigned(set.inputGain) + ' dB'], ['Attack', fmt(set.attack) + ' ms'], ['Release', fmt(set.release, 0) + ' ms' + (set.adaptiveRelease === false ? ', fixed' : set.adaptiveRelease ? ', adaptive' : '')],
      ['Lookahead', fmt(set.lookahead) + ' ms'], ['Auto makeup', onOff(set.makeup)], ['Output', fmtSigned(set.outputGain) + ' dB'],
      ['Bass first', set.bassFirst ? `On, ${fmt(set.bassRange)} dB below ${fmt(set.bassFreq, 0)} Hz` : 'Off'], ['Stereo link', fmt(set.linkAmount, 0) + '%'],
      ['M/S', onOff(set.msMode)], ['Oversampling', ['Off', '2x', '4x'][set.osMode] || '—'], ['4x on export', onOff(set.exportOS)],
      ['Drive', fmt(set.drive) + ' dB'], ['Crossover', fmt(set.xoverFreq, 0) + ' Hz'], ['Dither', ['Off', '24-bit', '16-bit'][set.dither] || '—'],
      ['Target', plrMode ? 'PLR ' + fmt(plrTarget) : fmt(target) + ' LUFS'],
      ['Ceiling mode', ['True peak', 'Streaming (Opus, Vorbis)', 'All codecs'][ceilMode] || '—'],
    ];
    if (isFinite(set.codecTrim)) items.push(['Codec trim', fmt(set.codecTrim, 2) + ' dB']);
    if (set.mode === 4 && isFinite(set.punchClip)) items.push(['Clip', fmt(set.punchClip) + ' dB']);
    $('sessSettings').innerHTML = items.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');
    requestAnimationFrame(() => drawSessionChart(s));
    renderCompare();
    renderSuggestions(s);
  }

  // ---- Suggested Liminal settings, and a preset to load them ----
  const MODE_NAMES = ['Brickwall', 'Soft Clip', 'Lookahead', 'Multiband', 'Punch Guard'];
  function suggestLiminal(s) {
    const set = Object.assign({}, s.settings || {}), sum = s.summary || {}, out = [];
    const n = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    const ceil = isFinite(set.ceiling) ? set.ceiling : -1, cm = isFinite(set.ceilingMode) ? set.ceilingMode : 0;
    const cpi = sessionCodec(s), loss = sum.punch ? n(sum.punch.loss) : NaN, gra = n(sum.grAvg), pct = n(sum.grPercent), plr = n(sum.plr);
    const change = (id, to, label, fromText, toText, why) => { if (set[id] === to) return; out.push({ id, to, label, from: fromText, toText, why }); set[id] = to; };
    if (isFinite(cpi.value) && cpi.value > ceil + 0.05 && cm === 0)
      change('ceilingMode', 1, 'Ceiling mode', 'True peak', 'Streaming', `Peaks reach ${fmt(cpi.value)} dB after encoding, over your ${fmt(ceil)} dB ceiling. Streaming mode keeps them under it, measured with real encoders when you Learn.`);
    const punchy = (isFinite(loss) && loss > 2.5) || (isFinite(gra) && gra > 4);
    if (punchy) {
      const why = isFinite(loss) && loss > 2.5 ? `The limiter takes ${fmt(loss)} dB off the hits, so the drums lose their snap.` : `The limiter is turning the mix down ${fmt(gra)} dB on average${isFinite(pct) ? `, ${Math.round(pct)}% of the time` : ''}, which flattens the hits.`;
      if (set.mode === 2 && n(set.attack) < 5) {
        change('attack', 10, 'Attack', `${fmt(set.attack)} ms`, '10 ms', why + ' A slower attack lets the start of each hit through.');
        if (!(n(set.lookahead) >= 10)) change('lookahead', 10, 'Lookahead', `${fmt(set.lookahead)} ms`, '10 ms', 'Gives the slower attack room to work.');
      } else if (set.mode !== 4) {
        change('mode', 4, 'Mode', MODE_NAMES[set.mode] || '—', 'Punch Guard', why + ' Punch Guard leaves the tips of the hits to a clipper instead of turning the whole mix down.');
        change('punchClip', 2, 'Clip', '—', '2 dB', 'A clean starting point for Punch Guard.');
      } else if (n(set.punchClip) < 3) {
        change('punchClip', Math.min(3, (n(set.punchClip) || 2) + 1), 'Clip', `${fmt(set.punchClip)} dB`, `${fmt(Math.min(3, (n(set.punchClip) || 2) + 1))} dB`, why + ' More clip lets more of each hit through the limiter.');
      }
    }
    if ([0, 1, 4].includes(set.mode) && (set.osMode || 0) === 0)
      change('osMode', 1, 'Oversampling', 'Off', '2x', `${MODE_NAMES[set.mode]} clips the waveform; oversampling keeps that clean.`);
    if (n(set.release) < 40 && isFinite(gra) && gra > 2.5)
      change('release', 60, 'Release', `${fmt(set.release, 0)} ms`, '60 ms', 'A very short release on a busy master can distort the bass.');
    if (isFinite(pct) && pct > 80 && set.adaptiveRelease === false)
      change('adaptiveRelease', true, 'Adaptive release', 'Off', 'On', `The limiter works ${Math.round(pct)}% of the time; adaptive release stops it pumping on dense passages.`);
    if (isFinite(plr) && plr < 7.5)
      { change('targetMode', 1, 'Target', set.targetMode === 1 ? `PLR ${fmt(set.targetPLR)}` : `${fmt(set.target)} LUFS`, 'PLR 9', `PLR ${fmt(plr)} is very dense. Aiming for a density of 9 keeps it competitive with more punch.`); set.targetPLR = 9; }
    return { changes: out, settings: set };
  }
  function presetXml(set) {
    const MAP = { target: 'autoTarget', makeup: 'makeupMode' }, SKIP = new Set(['codecTrim']);
    const rows = [];
    for (const [k, v] of Object.entries(set)) {
      if (SKIP.has(k) || v === null || v === undefined) continue;
      const val = typeof v === 'boolean' ? (v ? 1 : 0) : +v;
      if (!isFinite(val)) continue;
      rows.push(`  <PARAM id="${MAP[k] || k}" value="${val}"/>`);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Parameters LiminalVersion="4">\n${rows.join('\n')}\n</Parameters>\n`;
  }
  let lastSuggestion = null;
  function renderSuggestions(s) {
    const box = $('sessSuggest'); if (!box) return;
    if (!s.settings) { $('sessSuggestPanel').classList.add('hidden'); return; }
    $('sessSuggestPanel').classList.remove('hidden');
    const sg = lastSuggestion = suggestLiminal(s);
    if (!sg.changes.length) {
      box.innerHTML = '<p class="note">These settings look right for this track. If you want more density or punch, try Optimise in Liminal: it ranks setups at the same loudness.</p>';
      return;
    }
    box.innerHTML = `<div class="sugg-list">${sg.changes.map(c => `<div class="sugg"><div class="sugg-set"><b>${esc(c.label)}</b><span>${esc(c.from)} <i>→</i> <em>${esc(c.toText)}</em></span></div><p>${esc(c.why)}</p></div>`).join('')}</div>
      <div class="controls" style="margin-top:14px"><button class="btn primary sm" id="presetBtn">Download preset for Liminal</button>
      <span class="note">In Liminal: open the preset menu, choose <b>Import preset…</b>, pick this file, then press <b>Learn</b> again.</span></div>`;
    $('presetBtn').addEventListener('click', () => {
      download(new Blob([presetXml(sg.settings)], { type: 'application/xml' }), `${(lastSessionName || 'Liminal').replace(/[\\/:*?"<>|]/g, '')} - MasterScope suggestion.mlpreset`);
      track('Preset downloaded');
    });
  }

  // Codec peak for a session: the real decoded peaks when Learn measured them,
  // else the plugin's calibrated prediction, else the 16 kHz estimate.
  function sessionCodec(s) {
    const sum = s.summary || {}, set = s.settings || {}, cm = isFinite(set.ceilingMode) ? set.ceilingMode : 0;
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    const r = sum.codecReal;
    if (r && isFinite(num(r.opus)) && isFinite(num(r.vorbis))) {
      const worst = Math.max(r.opus, r.vorbis) + (cm === 2 ? (num(r.mp3Margin) || 1) : 0);
      return { value: worst, real: true, opus: r.opus, vorbis: r.vorbis, label: cm === 2 ? 'Codec peak (+MP3)' : 'Decoded peak', note: cm === 2 ? 'Opus, Vorbis + MP3 margin' : 'Real Opus and Vorbis' };
    }
    if (isFinite(num(sum.codecPeakPredicted))) return { value: sum.codecPeakPredicted + (cm === 2 ? 1 : 0), real: false, label: 'Codec peak', note: 'Calibrated estimate' };
    const v = num(sum.codecPeak);
    return { value: v, real: false, label: 'Codec peak (est.)', note: !isFinite(v) ? '' : v > -0.9 ? 'May clip after encoding' : 'Safe for AAC / MP3' };
  }

  // ---- Compare two reports ----
  let compareSession = null, compareName = '';
  $('sessCompare').addEventListener('click', () => $('sessCompareFile').click());
  $('sessCompareFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    let obj = null; try { obj = JSON.parse(await f.text()); } catch (err) {}
    if (!obj || obj.format !== 'liminal-session') return toast('That .json file isn’t a Liminal session.');
    compareSession = obj; compareName = f.name.replace(/\.json$/i, '');
    renderCompare(); drawSessionChart(lastSession);
    $('sessComparePanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('sessCompareClear').addEventListener('click', () => { compareSession = null; renderCompare(); drawSessionChart(lastSession); });
  function renderCompare() {
    const panel = $('sessComparePanel');
    if (!compareSession || !lastSession) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('sessCompareName').textContent = compareName;
    const A = lastSession, B = compareSession, sa = A.summary || {}, sb = B.summary || {}, xa = A.settings || {}, xb = B.settings || {};
    const n = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    const MODES = ['Brickwall', 'Soft Clip', 'Lookahead', 'Multiband', 'Punch Guard'];
    const rows = [
      ['Integrated', n(sa.integrated), n(sb.integrated), 'LUFS', 0],
      ['True peak', n(sa.truePeakOut), n(sb.truePeakOut), 'dBTP', -1],
      ['Codec peak', sessionCodec(A).value, sessionCodec(B).value, 'dB', -1],
      ['PLR', n(sa.plr), n(sb.plr), 'dB', 1],
      ['Punch', n((sa.punch || {}).out), n((sb.punch || {}).out), 'dB', 1],
      ['Avg gain reduction', n(sa.grAvg), n(sb.grAvg), 'dB', -1],
      ['Peak gain reduction', n(sa.grPeak), n(sb.grPeak), 'dB', -1],
      ['LRA', n(sa.lra), n(sb.lra), 'LU', 0],
      ['Correlation', n(sa.correlation), n(sb.correlation), '', 1],
    ];
    const better = (dlt, dir) => !isFinite(dlt) || Math.abs(dlt) < 0.05 || dir === 0 ? '' : (dlt * dir > 0 ? 'ok' : 'warn');
    const setRow = (k, a, b) => `<tr><td>${esc(k)}</td><td class="n">${esc(a)}</td><td class="n">${esc(b)}</td><td class="n">${a === b ? '' : 'changed'}</td></tr>`;
    let html = '<table><thead><tr><th></th><th class="n">This report</th><th class="n">' + esc(compareName) + '</th><th class="n">This minus that</th></tr></thead><tbody>';
    for (const [k, a, b, u, dir] of rows) {
      if (!isFinite(a) && !isFinite(b)) continue;
      const dl = a - b;
      html += `<tr><td>${esc(k)}</td><td class="n">${fmt(a, k === 'Correlation' ? 2 : 1)} ${u}</td><td class="n">${fmt(b, k === 'Correlation' ? 2 : 1)} ${u}</td><td class="n ${better(dl, dir)}">${isFinite(dl) ? fmtSigned(dl, k === 'Correlation' ? 2 : 1) : '—'}</td></tr>`;
    }
    html += setRow('Mode', MODES[xa.mode] || '—', MODES[xb.mode] || '—');
    html += setRow('Threshold', fmt(xa.threshold) + ' dB', fmt(xb.threshold) + ' dB');
    html += setRow('Attack / release', `${fmt(xa.attack)} / ${fmt(xa.release, 0)} ms`, `${fmt(xb.attack)} / ${fmt(xb.release, 0)} ms`);
    html += setRow('Ceiling', `${fmt(xa.ceiling)} dB, ${['true peak', 'streaming', 'all codecs'][xa.ceilingMode || 0]}`, `${fmt(xb.ceiling)} dB, ${['true peak', 'streaming', 'all codecs'][xb.ceilingMode || 0]}`);
    html += '</tbody></table><p class="note">Green is the better direction for a streaming master (more density headroom, more punch, less limiting, lower peaks). The other report\'s loudness is drawn faintly in the chart below.</p>';
    $('sessCompareTable').innerHTML = html;
  }

  // ---- Master card: a shareable image of the result ----
  function drawCard({ kicker, title, stats, line, foot }) {
    const W = 1200, H = 630, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#07080f'; g.fillRect(0, 0, W, H);
    // warm ridges along the bottom, like the landing page
    const STOPS = [[27, 31, 94], [90, 42, 138], [176, 58, 110], [236, 106, 58], [251, 179, 60]];
    const heat = t => { t = Math.max(0, Math.min(1, t)) * 4; const i = Math.min(3, Math.floor(t)), f = t - i; return STOPS[i].map((v, k) => Math.round(v + (STOPS[i + 1][k] - v) * f)); };
    for (let k = 9; k >= 0; k--) {
      const d = k / 9, y0 = H - 8 - d * 150, h = 70 - d * 25;
      g.beginPath(); g.moveTo(0, y0);
      for (let i = 0; i <= 100; i++) { const f = i / 100, v = 0.35 + 0.4 * (1 - f * 0.7) * (0.5 + 0.5 * Math.sin(f * 19 + k) * Math.sin(f * 5 - k * 0.4)); g.lineTo(f * W, y0 - v * h); }
      g.lineTo(W, y0); g.closePath(); g.fillStyle = '#07080f'; g.fill();
      const c = heat(0.95 - d * 0.8); g.strokeStyle = `rgba(${c},${1 - d * 0.6})`; g.lineWidth = 2 - d; g.stroke();
    }
    if (line && line.length > 2) {
      g.beginPath(); line.forEach((v, i) => { const x = 60 + i / (line.length - 1) * (W - 120), y = 440 - (Math.max(-30, Math.min(-3, v)) + 30) / 27 * 70; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.strokeStyle = 'rgba(244,237,228,0.35)'; g.lineWidth = 2.5; g.stroke();
    }
    const P = (px, py) => [60 + px / 64 * 52, 54 + py / 64 * 52];
    const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
    g.lineJoin = g.lineCap = 'round';
    {                                   // the MasterScope mark (Liminal uses it too): a scope lens over the waveform
      g.fillStyle = '#6f86ff'; rr(60, 54, 52, 52, 12); g.fill();
      const [cx, cy] = P(32, 32), rad = 24 / 64 * 52;
      g.fillStyle = '#3d5afe'; g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 2.4; g.stroke();
      g.beginPath(); [[32, 2, 32, 12], [32, 52, 32, 62], [2, 32, 12, 32], [52, 32, 62, 32]].forEach(([a1, b1, a2, b2]) => { const [x1, y1] = P(a1, b1), [x2, y2] = P(a2, b2); g.moveTo(x1, y1); g.lineTo(x2, y2); }); g.stroke();
      g.lineWidth = 3.2; g.beginPath();
      [[13,34],[19,34],[23,23],[28,43],[33,17],[38,47],[42,27],[45,34],[51,34]].forEach(([px, py], i) => { const [x, y] = P(px, py); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    }
    g.fillStyle = '#f4ede4'; g.font = '600 25px Inter, sans-serif'; g.fillText(kicker, 128, 80);
    g.fillStyle = '#b9b0c4'; g.font = '500 18px Inter, sans-serif'; g.fillText(kicker.includes('Liminal') ? 'by MasterScope' : 'Is it ready to release?', 128, 104);
    g.fillStyle = '#f4ede4'; g.font = '800 56px Inter, sans-serif'; g.fillText(title.slice(0, 34), 60, 196);
    const cw = (W - 120) / stats.length;
    stats.forEach(([k, v, u], i) => {
      const x = 60 + i * cw;
      g.fillStyle = '#b9b0c4'; g.font = '500 20px Inter, sans-serif'; g.fillText(k, x, 266);
      g.fillStyle = '#f4ede4'; g.font = '600 52px Inter, sans-serif'; g.fillText(v, x, 326);
      const vw = g.measureText(v).width; g.fillStyle = '#b9b0c4'; g.font = '500 20px Inter, sans-serif'; g.fillText(u, x + vw + 8, 326);
    });
    if (foot) { g.fillStyle = '#c7bfb4'; g.font = '500 19px Inter, sans-serif'; g.fillText(foot, 60, 378); }
    const sp = SITE.sponsors.card;
    g.fillStyle = '#f4ede4'; g.font = '600 18px Inter, sans-serif'; g.textAlign = 'right';
    g.fillText('masterscope.gwstudio.com.au' + (sp && sp.name ? `  ·  presented by ${sp.name}` : ''), W - 40, H - 26); g.textAlign = 'left';
    return cv;
  }
  async function shareCard(cv, name) {
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const file = new File([blob], name, { type: 'image/png' });
    track('Card shared');
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'My master', text: 'Checked with MasterScope' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    download(blob, name);
  }
  $('sessCard').addEventListener('click', () => {
    const s = lastSession; if (!s) return;
    const sum = s.summary || {}, set = s.settings || {};
    const n = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    const cpi = sessionCodec(s);
    const stats = [['Loudness', fmt(n(sum.integrated)), 'LUFS'], ['Density (PLR)', fmt(n(sum.plr)), 'dB'], ['True peak', fmt(n(sum.truePeakOut)), 'dBTP'],
                   [cpi.real ? 'Decoded peak' : 'Codec peak', fmt(cpi.value), 'dB']];
    if (sum.punch) stats.push(['Punch', fmt(n(sum.punch.out)), 'dB']);
    const cv = drawCard({ kicker: 'Mastered with Liminal', title: lastSessionName || 'My master', stats,
      line: ((s.timeline || {}).shortTerm || []).filter(v => typeof v === 'number' && v > -69),
      foot: `${MODE_NAMES[set.mode] || 'Liminal'} · ceiling ${fmt(set.ceiling)} dB ${['true peak', 'streaming-safe', 'safe on every codec'][set.ceilingMode || 0]}` });
    shareCard(cv, `${lastSessionName || 'liminal'} - master card.png`);
  });
  $('shareCardBtn').addEventListener('click', () => {
    const m = S.metrics; if (!m) return;
    const rows = releaseChecks(m), passed = rows.filter(r => r.st === 'ok').length;
    const title = (S.fileName || 'My track').replace(/\.[a-z0-9]+$/i, '');
    const cv = drawCard({ kicker: 'Checked with MasterScope', title,
      stats: [['Loudness', fmt(m.lufs), 'LUFS'], ['Density (PLR)', fmt(m.plr), 'dB'], ['True peak', fmt(m.truePeak), 'dBTP'], ['Codec peak', fmtSigned(m.codecPeak), 'dB']],
      foot: passed === rows.length ? 'Release ready on Spotify, Apple Music, YouTube, SoundCloud and the club' : `Release ready on ${passed} of ${rows.length} platforms` });
    shareCard(cv, `${title} - MasterScope card.png`);
  });

  function drawSessionChart(s) {
    const cv = $('sessChart'), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const css = getComputedStyle(document.documentElement), col = n => css.getPropertyValue(n).trim();
    paintSessionChart(cv.getContext('2d'), s, W, H, dpr,
      { faint: col('--text-faint'), grid: col('--grid'), ok: col('--ok'), danger: col('--danger'), accent: col('--accent'), font: col('--font'), compare: compareSession });
  }
  // Shared by the page and the PDF report (which uses fixed light colours)
  function paintSessionChart(g, s, W, H, scale, P) {
    const tl = s.timeline || {}, st = tl.shortTerm || [], gr = tl.gr || [];
    g.setTransform(scale, 0, 0, scale, 0, 0); g.clearRect(0, 0, W, H);
    const sst = s.settings || {}, ssum = s.summary || {};
    const target = sst.targetMode === 1 && isFinite(ssum.truePeakOut) && isFinite(sst.targetPLR) ? ssum.truePeakOut - sst.targetPLR
                 : isFinite(sst.target) ? sst.target : -14;
    const fs = P.fontSize || 11, L = fs * 3.6, R = fs * 3.6, T = 8, B = fs * 2, pw = W - L - R, ph = H - T - B;
    const lo = -30, hi = -3, y = v => T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ph;
    const n = Math.max(st.length, gr.length, 2), x = i => L + i / (n - 1) * pw;
    g.font = fs + 'px ' + P.font; g.fillStyle = P.faint; g.strokeStyle = P.grid; g.lineWidth = 1;
    for (const v of [-6, -10, -14, -18, -24]) { g.beginPath(); g.moveTo(L, y(v) + .5); g.lineTo(W - R, y(v) + .5); g.stroke(); g.fillText(String(v).replace('-', MINUS), 6, y(v) + fs * 0.35); }
    for (const dg of [3, 6, 9]) g.fillText(MINUS + dg, W - R + 8, T + dg / 12 * ph * 0.5 + fs * 0.35);
    const dur = Math.max(st.length, gr.length) > 1 ? (Math.max(st.length, gr.length) - 1) * (tl.intervalSec || 1) : (s.durationSec || 0);
    for (let k = 0; k <= 4; k++) { const t = dur * k / 4; g.fillText(fmtTime(t), L + k / 4 * pw - (k === 4 ? fs * 2.2 : k ? fs * 1.1 : 0), H - fs * 0.5); }
    g.setLineDash([5, 4]); g.strokeStyle = P.ok; g.beginPath(); g.moveTo(L, y(target)); g.lineTo(W - R, y(target)); g.stroke(); g.setLineDash([]);
    if (gr.length) {   // gain reduction from the top, 0-12 dB over the upper half
      const gy = v => T + Math.min(1, Math.abs(v) / 12) * ph * 0.5;
      g.beginPath(); g.moveTo(x(0), T);
      gr.forEach((v, i) => g.lineTo(x(i), gy(+v || 0)));
      g.lineTo(x(gr.length - 1), T); g.closePath();
      g.fillStyle = P.danger + '33'; g.fill();
      g.beginPath(); gr.forEach((v, i) => (i ? g.lineTo : g.moveTo).call(g, x(i), gy(+v || 0)));
      g.strokeStyle = P.danger; g.lineWidth = 1.5; g.stroke();
    }
    if (P.compare && P.compare.timeline && Array.isArray(P.compare.timeline.shortTerm)) {
      const cs = P.compare.timeline.shortTerm, cx = i => L + i / Math.max(1, cs.length - 1) * pw;
      const cp = cs.map((v, i) => [cx(i), v]).filter(p => typeof p[1] === 'number' && isFinite(p[1]) && p[1] > -69);
      if (cp.length > 1) { g.beginPath(); cp.forEach(([px, v], i) => (i ? g.lineTo : g.moveTo).call(g, px, y(v))); g.strokeStyle = P.faint; g.lineWidth = 1.5; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]); }
    }
    const pts = st.map((v, i) => [x(i), v]).filter(p => typeof p[1] === 'number' && isFinite(p[1]) && p[1] > -69);   // null = no reading yet
    if (pts.length > 1) {
      g.beginPath(); pts.forEach(([px, v], i) => (i ? g.lineTo : g.moveTo).call(g, px, y(v)));
      g.strokeStyle = P.accent; g.lineWidth = 2; g.stroke();
    }
  }



  // ---- Session exports ----
  // CSV: the plugin's own per-second table when the file has it (identical to
  // saving .csv from Liminal); older session files fall back to the timeline.
  $('sessCsv').addEventListener('click', () => {
    const s = lastSession; if (!s) return;
    const q = v => (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) ? '' : String(v);
    let lines;
    if (s.table && Array.isArray(s.table.columns) && Array.isArray(s.table.rows) && s.table.rows.length) {
      lines = [s.table.columns.join(',')].concat(s.table.rows.map(r => r.map(q).join(',')));
    } else {
      const tl = s.timeline || {}, n = Math.max(...['shortTerm', 'momentary', 'gr', 'correlation'].map(k => (tl[k] || []).length));
      lines = ['time_s,shortterm_LUFS,momentary_LUFS,GR_max_last_second_dB,correlation'];
      for (let i = 0; i < n; i++) lines.push([i * (tl.intervalSec || 1), q((tl.shortTerm || [])[i]), q((tl.momentary || [])[i]), q((tl.gr || [])[i]), q((tl.correlation || [])[i])].join(','));
    }
    download(new Blob([lines.join('\n')], { type: 'text/csv' }), `${lastSessionName || 'liminal_session'}.csv`);
  });

  $('sessPdf').addEventListener('click', async () => {
    const s = lastSession; if (!s) return;
    const win = window.open('', '_blank');
    if (!win) return toast('Your browser blocked the report window. Allow pop-ups for this page and try again.', 5000);
    let html;
    try { html = buildSessionReportHtml(s); } catch (e) { win.close(); toast('Couldn’t build the report: ' + e.message, 5000); return; }
    win.document.open(); win.document.write(html); win.document.close();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await Promise.race([Promise.all([...win.document.images].map(i => i.decode ? i.decode().catch(() => {}) : null).concat(win.document.fonts ? [win.document.fonts.ready] : [])), wait(3000)]);
    try { win.paginate(); } catch (e) {}
    win.focus(); win.print();
  });

  function buildSessionReportHtml(s) {
    const set = s.settings || {};
    const target = isFinite(set.target) ? set.target : -14, ceil = isFinite(set.ceiling) ? set.ceiling : -1;
    const created = s.created ? new Date(s.created) : new Date();
    const dateStr = (isNaN(created) ? new Date() : created).toLocaleString(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const name = lastSessionName || 'Liminal session';
    const metaLine = [s.plugin || 'Liminal', isFinite(s.durationSec) ? fmtTime(s.durationSec) + (s.source === 'learn' ? ' rendered by Learn' : ' recorded') : '', s.sampleRate ? (s.sampleRate / 1000) + ' kHz' : ''].filter(Boolean).join(' · ');

    // Headline verdict
    const F = lastSessionFindings || [];
    const issues = F.filter(f => f.status === 'warn' || f.status === 'danger');
    const nD = issues.filter(f => f.status === 'danger').length, nW = issues.length - nD;
    const vStatus = nD ? 'danger' : nW ? 'warn' : 'ok';
    const vHead = nD ? `${nD} issue${nD > 1 ? 's' : ''} to fix${nW ? `, ${nW} to review` : ''}` : nW ? `${nW} thing${nW > 1 ? 's' : ''} to review` : 'Ready for release at ' + fmt(target) + ' LUFS';
    const vSub = issues.length ? `Most important: ${issues[0].title.charAt(0).toLowerCase() + issues[0].title.slice(1)}.` : 'Loudness, true peak and density are all where they should be for streaming.';

    const tiles = $('sessTiles').innerHTML ? [...$('sessTiles').querySelectorAll('.tile')].map(t => {
      const dot = t.querySelector('.dot'), st = dot ? [...dot.classList].find(c => c !== 'dot') : '';
      return `<div class="tile"><div class="tl">${st ? `<span class="dot ${st}"></span>` : ''}${esc(t.querySelector('.lt').textContent)}</div><div class="tv">${t.querySelector('.value').innerHTML}</div><div class="td">${t.querySelector('.verdict') ? esc(t.querySelector('.verdict').textContent) : ''}</div></div>`;
    }).join('') : '';
    const findingHtml = f => `<div class="f ${f.status}"><div class="fi">${STATUS_ICON[f.status]}</div><div><div class="ft">${esc(f.title)}</div><div class="fb">${esc(f.body)}</div></div></div>`;

    // Chart in report colours
    const cw = 1200, ch = 400, cv = document.createElement('canvas'); cv.width = cw * 2; cv.height = ch * 2;
    paintSessionChart(cv.getContext('2d'), s, cw, ch, 2, { faint: '#6b7385', grid: '#e6e8ee', ok: '#12a26a', danger: '#d43c4a', accent: '#3d5afe', font: 'Inter, sans-serif', fontSize: 20 });
    const chartImg = cv.toDataURL('image/png');

    // Section table: loudness and limiting per 15 s
    const tl = s.timeline || {}, stt = tl.shortTerm || [], grr = tl.gr || [], step = 15;
    let secRows = '';
    for (let i = 0; i < Math.max(stt.length, grr.length); i += step) {
      const isNum = v => typeof v === 'number' && isFinite(v);
      const sv = stt.slice(i, i + step).filter(v => isNum(v) && v > -69), gv = grr.slice(i, i + step).filter(isNum);
      if (!sv.length && !gv.length) continue;
      const lu = sv.length ? -0.691 + 10 * Math.log10(sv.reduce((a2, v) => a2 + Math.pow(10, (v + 0.691) / 10), 0) / sv.length) : NaN;
      const gmax = gv.length ? Math.max(...gv) : NaN, gavg = gv.length ? gv.reduce((a2, v) => a2 + v, 0) / gv.length : NaN;
      secRows += `<tr><td>${fmtTime(i)}–${fmtTime(Math.min(i + step, Math.max(stt.length, grr.length) - 1))}</td><td class="n">${fmt(lu)} LUFS</td><td class="n">${fmt(gavg)} dB</td><td class="n${gmax > 9 ? ' bad' : ''}">${fmt(gmax)} dB</td></tr>`;
    }

    const items = [...$('sessSettings').querySelectorAll('div')].map(d => `<tr><td>${esc(d.querySelector('span').textContent)}</td><td class="n">${esc(d.querySelector('b').textContent)}</td></tr>`);
    const half = Math.ceil(items.length / 2);

    const pages = [];
    pages.push({ section: 'Session', html: `
      <div class="title"><div class="kicker">Liminal session report · ${esc(fmt(target))} LUFS</div><h1>${esc(name)}</h1>
      <div class="meta">${esc(metaLine)} · Recorded ${esc(dateStr)}</div></div>
      <div class="verdict ${vStatus}"><div class="vi">${STATUS_ICON[vStatus]}</div><div><div class="vh">${esc(vHead)}</div><div class="vs">${esc(vSub)}</div></div></div>
      <h3>Result</h3><div class="tiles">${tiles}</div>
      <h3>What it means</h3>${F.map(findingHtml).join('') || '<p class="muted">No loudness data in this session.</p>'}
    ` });
    pages.push({ section: 'Over time', html: `
      <h2>Over time</h2>
      <p class="lead">Short-term loudness (blue) against the ${esc(fmt(target))} LUFS target (green, dashed). Gain reduction hangs from the top (red, 0 to 12 dB).</p>
      <figure><img src="${chartImg}" alt=""><figcaption>One point per second of the recording.</figcaption></figure>
      <h3>By section (15 s)</h3>
      <table><thead><tr><th>Time</th><th class="n">Loudness</th><th class="n">Avg GR</th><th class="n">Max GR</th></tr></thead><tbody>${secRows}</tbody></table>
      <p class="note">Max GR above 9 dB on a section means single hits are being turned down hard: listen with Delta and consider controlling that sound in the mix.</p>
    ` });
    pages.push({ section: 'Settings', html: `
      <h2>Settings used</h2>
      <p class="lead">Liminal's settings when the recording stopped. Load them again to reproduce this master.</p>
      <div class="cols"><table><tbody>${items.slice(0, half).join('')}</tbody></table><table><tbody>${items.slice(half).join('')}</tbody></table></div>
      <h3>How these are measured</h3>
      <p class="small">Loudness and true peak follow ITU-R BS.1770-4; loudness range follows EBU Tech 3342. The codec peak estimate is the output's true peak after a 16 kHz low-pass like the one AAC, MP3 and Opus encoders apply; real encoders also add noise, so treat it as the least overshoot to expect. PLR is true peak minus integrated loudness. Gain reduction includes Liminal's true-peak ceiling stage.</p>
    ` });

    const N = pages.length;
    const logo = '<svg width="18" height="18" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6f86ff"/><circle cx="32" cy="32" r="24" fill="#3d5afe"/><circle cx="32" cy="32" r="24" fill="none" stroke="#fff" stroke-width="3"/><path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M13 34 L19 34 L23 23 L28 43 L33 17 L38 47 L42 27 L45 34 L51 34" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const pageHtml = pages.map((p, i) => `
      <section class="page${i === 0 ? ' first' : ''}">
        <header class="rh"><div class="brand">${logo}<span>Master<b>Scope</b> · Liminal</span></div><div class="rs">${esc(p.section)}</div></header>
        <div class="body">${p.html}</div>
        <footer class="rf"><span>${esc(name)} · ${esc(dateStr)}</span><span class="pn">Page ${i + 1} of ${N}</span></footer>
      </section>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} – Liminal session report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><div><b>${esc(name)} – Liminal session report</b><span>In the print dialog, choose <b>Save as PDF</b> as the destination. For best results turn off “Headers and footers”.</span></div><button onclick="window.print()">Save as PDF</button></div>
${pageHtml}
<script>${PAGINATE_JS}<\/script>
</body></html>`;
  }

  // ===================================================================
  // Reports
  // ===================================================================
  function reportText() {
    const m = S.metrics, t = S.trans, b = S.buffer, i = S.fileInfo || {}, L = [];
    const line = (k, v) => L.push(`${(k + ':').padEnd(30)} ${v}`);
    L.push('MASTERSCOPE REPORT', '='.repeat(50));
    line('File', S.fileName); line('Generated', new Date().toLocaleString());
    line('Format', `${i.format || '—'} · ${b.sampleRate} Hz${i.bitDepth ? ' · ' + i.bitDepth + '-bit' : ''} · ${b.numberOfChannels} ch · ${fmtTime(b.duration)}`);
    L.push('', 'LOUDNESS', '-'.repeat(50));
    line('Integrated loudness', `${fmt(m.lufs)} LUFS`); line('Max short-term', `${fmt(m.maxShortTerm)} LUFS`); line('Max momentary', `${fmt(m.maxMomentary)} LUFS`);
    line('True peak (4x oversampled)', `${fmt(m.truePeak)} dBTP`); if (isFinite(m.codecPeak)) line('Codec peak (estimate)', `${fmtSigned(m.codecPeak)} dBTP`); line('Sample peak', `${fmt(m.samplePeak)} dBFS`);
    line('Loudness range (EBU)', `${fmt(m.lra)} LU`); line('Peak-to-loudness ratio', `${fmt(m.plr)} dB`); line('Crest factor', `${fmt(m.crest)} dB`); line('RMS', `${fmt(m.rms)} dBFS`);
    L.push('', 'TONE (per octave, relative to pink noise)', '-'.repeat(50));
    line('Tilt 63 Hz–8 kHz', `${fmtSigned(m.tilt)} dB/oct`); line('Low-mid bump 250–500 Hz', `${fmtSigned(m.lowMidBump)} dB`);
    line('Presence vs low mids', `${fmtSigned(m.lowMidPresenceGap)} dB`); line('Sub vs bass', `${fmtSigned(m.subBassGap)} dB`); line('Air vs mids', `${fmtSigned(m.airGap)} dB`);
    line('Octave bands (Hz: dB)', DSP.OCTAVE_CENTRES.map((c, k) => `${c}: ${fmtSigned(S.tone.octaveRel[k])}`).join(', '));
    L.push('', 'STEREO', '-'.repeat(50));
    line('Phase correlation', fmtSigned(m.corr, 2)); line('Stereo width', isFinite(m.width) ? m.width.toFixed(0) + '%' : '—'); line('Bass width 60–200 Hz', isFinite(m.lowWidth) ? `${m.lowWidth.toFixed(0)}%` + (isFinite(m.lowPeakWidth) && m.lowPeakFreq ? ` (widest ${m.lowPeakWidth.toFixed(0)}% at ${m.lowPeakFreq} Hz)` : '') : '—');
    if (t) {
      L.push('', 'HITS & TRANSIENTS', '-'.repeat(50));
      line('Hits detected', t.hitCount); line('Hit level above mix', `${fmtSigned(t.hitVsRmsDb)} dB`);
      line('Kick-band rise 50–90 Hz', `${fmt(t.kickRiseDb)} dB`); line('Kick-band settle', t.kickDecay !== null && t.kickRiseDb >= 6 ? t.kickDecay + ' ms' : 'not separable');
      line('Bass-band settle 60–250 Hz', t.bassDecay !== null ? t.bassDecay + ' ms' : 'does not settle'); line('Low end vs mids at hits', `${fmtSigned(t.lowVsMidDb)} dB`);
    }
    if (S.louder && S.louder.budget) {
      L.push('', 'LOUDER AT -14', '-'.repeat(50));
      if (m.limited) L.push('(This file is already limited; analyse the mix before the master limiter for the clearest picture.)');
      L.push('Share of peak height / share of loudness:');
      S.louder.budget.bands.forEach(b => line(`  ${b.name} (${b.range})`, `${Math.round(b.peakShare * 100)}% / ${Math.round(b.loudShare * 100)}%${S.louder.budget.costly.includes(b) ? '  costs peak room' : S.louder.budget.efficient.includes(b) ? '  efficient' : ''}`));
      const M = S.louder.moves;
      if (M) { L.push(`Peak control (${M.moves[0].cutDb} dB off the loudest 2% of moments in one range), limiting to reach PLR ${M.target}:`); M.moves.forEach(mv => line(`  ${mv.name}`, moveVal(mv.pct))); }
      if (S.eqMoves) { L.push('Tone moves:'); S.eqMoves.moves.forEach(mv => line(`  ${mv.label} (${mv.detail})`, moveVal(mv.pct))); }
      (m.hotspots || []).forEach(h => line(`Peak cluster ${fmtTime(h.start)}-${fmtTime(h.end)}`, `mostly ${SRC_META[h.dominant][0].toLowerCase()}`));
      (m.dips || []).forEach(d => line(`Energy dip ${fmtTime(d.start)}-${fmtTime(d.end)}`, `${fmt(d.depth)} LU below average`));
    }
    L.push('', 'STREAMING PLATFORMS', '-'.repeat(50));
    PLATFORMS.forEach(([n, target]) => { let a = target - m.lufs; if (n === 'YouTube' && a > 0) a = 0; let cap = ''; if (a > 0 && m.truePeak + a > -1) { a = Math.max(0, -1 - m.truePeak); cap = ' (held back by peak headroom)'; } line(n, `${fmtSigned(a)} dB → peak ${fmt(m.truePeak + a)} dBTP${cap}`); });
    L.push('', 'FINDINGS', '-'.repeat(50));
    S.findings.slice().sort((a, b) => SEV[a.status] - SEV[b.status]).forEach(f => {
      L.push(`[${f.status.toUpperCase()}] ${CAT_TAB[f.cat]}: ${f.title}`, `    ${f.body}`, '');
    });
    if (S.meterRef) {
      const r = S.meterRef;
      L.push('REFERENCE NUMBERS: ' + r.name + (r.source === 'browser' ? ' (measured in the browser)' : ' (from MasterScope Meter)'), '-'.repeat(50));
      line('Integrated loudness', `${fmt(m.lufs)} LUFS (reference ${fmt(r.lufs)})`); line('True peak', `${fmt(m.truePeak)} dBTP (reference ${fmt(r.tp)})`);
      line('PLR', `${fmt(m.plr)} dB (reference ${fmt(r.plr)})`); line('Loudness range', `${fmt(m.lra)} LU (reference ${fmt(r.lra)})`);
      line('Loudest moment', `${fmt(m.maxShortTerm)} LUFS (reference ${fmt(r.maxShort)})`);
      L.push('', meterRefLine(m, r), '');
    }
    if (S.ref) {
      const r = S.ref.sum;
      L.push('REFERENCE: ' + S.ref.name, '-'.repeat(50));
      line('Integrated loudness', `${fmt(r.lufs)} LUFS`); line('True peak', `${fmt(r.truePeak)} dBTP`); line('PLR', `${fmt(r.plr)} dB`);
      line('Tilt', `${fmtSigned(r.tilt)} dB/oct`); line('Correlation', fmtSigned(r.corr, 2)); line('Width', r.width.toFixed(0) + '%');
      line('Octave bands (Hz: dB)', DSP.OCTAVE_CENTRES.map((c, k) => `${c}: ${fmtSigned(r.tone.octaveRel[k])}`).join(', '));
      if (S.refVerdict) { L.push('', S.refVerdict.headline); S.refVerdict.reasons.forEach(x => L.push('  - ' + x)); }
    }
    return L.join('\n');
  }
  $('exportTxtBtn').addEventListener('click', () => { if (S.buffer) download(new Blob([reportText()], { type: 'text/plain' }), `${baseName()}_report.txt`); });

  // ===================================================================
  // PDF report: fixed A4 pages, light-theme charts at 2x resolution
  // ===================================================================
  function captureCanvas(id, bg) {
    const cv = $(id); if (!cv || !cv.width || !cv.height) return null;
    const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
    const o = out.getContext('2d');
    o.fillStyle = bg || css('--surface-2'); o.fillRect(0, 0, out.width, out.height); o.drawImage(cv, 0, 0);
    return out.toDataURL('image/png');
  }

  function captureChartsForReport() {
    const root = document.documentElement;
    const prevTheme = root.getAttribute('data-theme'), scrollY = window.scrollY;
    root.setAttribute('data-theme', 'light');
    root.classList.add('exporting');
    exportDpr = 2;
    invalidateCaches();
    redrawAllForExport();
    const ids = S.meterSong && !S.meterSong.detail ? ['lufsGauge', 'tpGauge', 'timelineCanvas', 'tonalCanvas', 'spectrumCanvas']   // an older export: the rest weren't measured
      : ['lufsGauge', 'tpGauge', 'timelineCanvas', 'tonalCanvas', 'spectrumCanvas', 'spectrogramCanvas', 'vectorscopeCanvas', 'stereoFieldCanvas', 'wfOverview'];
    const img = {};
    ids.forEach(id => { img[id] = captureCanvas(id, id.endsWith('Gauge') ? '#ffffff' : null); });
    exportDpr = 0;
    root.classList.remove('exporting');
    root.setAttribute('data-theme', prevTheme);
    invalidateCaches();
    redrawActive();
    window.scrollTo(0, scrollY);
    return img;
  }

  const GLOSSARY = [
    ['Integrated loudness (LUFS)', 'The perceived loudness of the whole track, measured to ITU-R BS.1770-4 with gating so silence doesn’t pull it down. Streaming services normalise to roughly −14 to −16 LUFS.'],
    ['True peak (dBTP)', 'The highest level including peaks that fall between samples, found by 4× oversampling. Lossy encoding can raise peaks, so −1 dBTP is the usual ceiling for streaming delivery.'],
    ['Peak-to-loudness ratio (PLR)', 'True peak minus integrated loudness. It shows how far the peaks stand above the body of the track: lower values mean heavier limiting.'],
    ['Loudness range (LRA, LU)', 'How much loudness varies between sections, from the 10th to the 95th percentile of 3-second loudness (EBU Tech 3342).'],
    ['Short-term / momentary loudness', 'Loudness over a sliding 3-second or 0.4-second window. Their maximums show how loud the loudest passages and moments get.'],
    ['Crest factor', 'Sample peak minus RMS level across both channels. A rough companion to PLR.'],
    ['Tonal balance and tilt', 'Average level per octave compared with pink noise, which reads as flat. Tilt is the overall slope from 63 Hz to 8 kHz in dB per octave. Most releases sit around 0 to −3, but genre matters, so a reference is the best guide.'],
    ['Phase correlation', 'How alike the left and right channels are: +1 is mono, 0 is unrelated, and below 0 means content cancels when summed to mono.'],
    ['Stereo width', 'The share of energy in the side (left-minus-right) signal. 0% is mono. Bass is usually kept close to 0%.'],
    ['Kick rise and settle time', 'Rise is how far each detected hit jumps above what was already playing in the 50–90 Hz range. Settle time is how long that band takes to return to its pre-hit level. A small rise means something sustains under the kick.'],
  ];

  const STATUS_LABEL = { ok: 'Good', warn: 'Review', danger: 'Fix', info: 'Note' };

  function buildReportHtml(img) {
    const m = S.metrics, t = S.trans, b = S.buffer, info = S.fileInfo || {};
    const sorted = S.findings.slice().sort((x, y) => SEV[x.status] - SEV[y.status]);
    const issues = sorted.filter(f => f.status === 'warn' || f.status === 'danger');
    const nDanger = issues.filter(f => f.status === 'danger').length, nWarn = issues.length - nDanger;
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const bits = info.bitDepth ? `${info.bitDepth}-bit${info.float ? ' float' : ''}` : '';
    const metaLine = [info.format, `${(b.sampleRate / 1000).toFixed(1).replace('.0', '')} kHz`, bits, b.numberOfChannels === 2 ? 'Stereo' : b.numberOfChannels === 1 ? 'Mono' : b.numberOfChannels + ' ch', fmtTime(b.duration)].filter(Boolean).join(' · ');

    let headline, headStatus, headSub;
    if (nDanger) { headline = `${nDanger} issue${nDanger > 1 ? 's' : ''} to fix${nWarn ? `, ${nWarn} to review` : ''}`; headStatus = 'danger'; }
    else if (nWarn) { headline = `${nWarn} thing${nWarn > 1 ? 's' : ''} to review`; headStatus = 'warn'; }
    else { headline = 'No issues found'; headStatus = 'ok'; }
    headSub = issues.length ? `Most important: ${issues[0].title.toLowerCase()}.` : 'Every measurement is within a typical range. Confirm by listening on several systems and against a reference.';

    const fig = (src, cap, cls) => src ? `<figure class="${cls || ''}"><img src="${src}" alt=""><figcaption>${cap}</figcaption></figure>` : '';
    const row = (k, v, s) => `<tr><td>${k}</td><td class="n">${v}</td>${s !== undefined ? `<td class="st">${s ? `<span class="pill ${s}">${STATUS_LABEL[s]}</span>` : ''}</td>` : ''}</tr>`;
    const findingHtmlR = f => `<div class="f ${f.status}"><div class="fi">${STATUS_ICON[f.status]}</div><div><div class="ft">${esc(f.title)} <span class="cat">${CAT_TAB[f.cat]}</span></div><div class="fb">${esc(f.body)}</div></div></div>`;

    // ---- Pages ----
    const pages = [];

    // 1. Summary: −14 readiness first
    const R = DSP.readiness(m), refPlr = S.ref ? S.ref.sum.plr : NaN;
    pages.push({ section: 'Summary', html: `
      <div class="title">
        <div class="kicker">${S.meterSong ? 'Song report from MasterScope Meter · numbers only' : 'Mix &amp; master report'} · −14 LUFS</div>
        <h1>${esc(baseName())}</h1>
        <div class="meta">${esc(metaLine)} · Analysed ${esc(dateStr)}</div>
      </div>
      <div class="verdict ${R.status}">
        <div class="vi">${STATUS_ICON[R.status]}</div>
        <div><div class="vh">${esc(R.headline)}</div><div class="vs">${esc(readinessSub(R, m))}</div></div>
      </div>
      ${budgetHtml(m.plr, refPlr)}
      <h3>Steps to a competitive −14 master</h3>
      <ol class="rsteps">${readinessSteps(R, m).map(s => `<li>${s}</li>`).join('')}</ol>
      <h3>Scorecard</h3>
      <div class="tiles">${summaryItems().map(x => `<div class="tile"><div class="tl"><span class="dot ${x.status}"></span>${esc(x.label)}</div><div class="tv">${x.value}<small>${x.unit}</small></div><div class="td">${esc(x.verdict)}</div></div>`).join('')}</div>
    ` });

    // 2. Priorities: issues + what is making the peaks
    const p = S.peaks;
    pages.push({ section: 'Priorities', html: `
      <h2>What to work on</h2>
      <p class="lead">${issues.length ? `${nDanger ? `${nDanger} to fix and ` : ''}${nWarn} to review, most important first.` : 'Nothing stood out. Every check is within a typical range.'}</p>
      ${issues.map(findingHtmlR).join('')}
      <h2 style="margin-top:9mm">Peaks &amp; density</h2>
      <p class="lead">How loud a track can sound at −14 depends on how far its peaks stand above its body, and what is making those peaks.</p>
      <div class="cols">
        <div><h3 style="margin-top:0">Where the loudest peaks come from</h3>${p ? srcBarHtml(p) + `<p class="small" style="margin-top:3mm">${p.events.toLocaleString()} peaks within 3 dB of the maximum (about ${Math.round(p.eventsPerMin)} a minute). ${esc(SRC_ADVICE[p.dominant])}</p>` : (S.meterSong ? '<p class="muted">Tracing where the peaks come from needs the audio file.</p>' : '<p class="muted">No peaks found.</p>')}</div>
        <div><h3 style="margin-top:0">What reaching −14 takes</h3><table>
          ${row('Peak control needed', `${R.peakCut > 0.05 ? R.peakCut.toFixed(1) : '0.0'} dB`, R.peakCut > 0.05 ? 'warn' : 'ok')}
          ${row(`Audio in the top ${p ? p.cutDb.toFixed(1) : '—'} dB`, p ? fmtPct(p.pctAbove) : '—', '')}
          ${row('Plays at now (peak-limited services)', `${fmt(R.playbackLufs)} LUFS`, R.shortfall > 0.2 ? 'warn' : 'ok')}
          ${row('Density (PLR)', `${fmt(m.plr)} dB`, R.density === 'competitive' ? 'ok' : R.density === 'open' ? 'info' : 'warn')}
          ${isFinite(refPlr) ? row('Reference density (PLR)', `${fmt(refPlr)} dB`, '') : ''}
        </table></div>
      </div>
    ` });

    // 2b. Louder at −14
    if (S.louder && S.louder.budget) {
      const spots = (m.hotspots || []).map(h => `<div class="lb-spot"><b>${fmtTime(h.start)}–${fmtTime(h.end)}</b>Peak cluster, mostly ${esc(SRC_META[h.dominant][0].toLowerCase())}</div>`).join('') +
        (m.dips || []).map(d => `<div class="lb-spot dip"><b>${fmtTime(d.start)}–${fmtTime(d.end)}</b>Energy dip, ${fmt(d.depth)} LU below average</div>`).join('');
      pages.push({ section: 'Louder at −14', html: `
        <h2>Louder at −14</h2>
        <p class="lead">At −14 every track plays at the same loudness, so what makes one sound bigger is how much loudness it gets out of its peaks. These are measured on this track.</p>
        ${louderHtml(true, spots ? `<h3 class="mini-h" style="margin-top:6mm">Where to look</h3>${spots}` : '')}
      ` });
    }

    // 2. Loudness & dynamics
    const plat = PLATFORMS.map(([n, target, note]) => {
      let a = target - m.lufs, capped = false;
      if (n === 'YouTube' && a > 0) a = 0;
      if (a > 0 && m.truePeak + a > -1) { a = Math.max(0, -1 - m.truePeak); capped = true; }
      const pk = m.truePeak + a;
      return `<tr><td>${n}</td><td class="n">${fmt(target, 0)}</td><td class="n">${fmtSigned(a)} dB</td><td class="n ${pk > -1 ? 'bad' : ''}">${fmt(pk)}</td><td class="muted">${capped ? 'Raised only as far as peaks allow' : esc(note)}</td></tr>`;
    }).join('');
    const tpS = m.truePeak > -0.1 ? 'danger' : m.truePeak > -1 + 0.05 ? 'warn' : 'ok';
    const kickSep = t && t.kickRiseDb !== null && t.kickRiseDb >= 6;
    pages.push({ section: 'Loudness & dynamics', html: `
      <h2>Loudness &amp; dynamics</h2>
      ${fig(img.timelineCanvas, `Loudness over time, 0:00–${fmtTime(b.duration)}. Green: momentary (0.4 s). Blue: short-term (3 s). Dashed: integrated (${fmt(m.lufs)} LUFS).`)}
      <div class="cols">
        <div><h3>Measurements</h3><table>
          ${row('Integrated loudness', `${fmt(m.lufs)} LUFS`, R.atTarget || R.louderByChoice ? 'ok' : 'warn')}
          ${row('Max short-term (3 s)', `${fmt(m.maxShortTerm)} LUFS`, '')}
          ${row('Max momentary (0.4 s)', `${fmt(m.maxMomentary)} LUFS`, '')}
          ${row('True peak', `${fmt(m.truePeak)} dBTP`, tpS)}
          ${isFinite(m.codecPeak) ? row('Codec peak (estimate)', `${fmtSigned(m.codecPeak)} dBTP`, m.codecPeak > 0.05 ? 'danger' : m.codecPeak > -0.9 ? 'warn' : 'ok') : ''}
          ${row('Sample peak', `${fmt(m.samplePeak)} dBFS`, '')}
          ${row('Loudness range', `${fmt(m.lra)} LU`, m.lra > 12 ? 'info' : 'ok')}
          ${row('RMS level', `${fmt(m.rms)} dBFS`, '')}
          ${row('Peak-to-loudness ratio', `${fmt(m.plr)} dB`, { squashed: 'warn', competitive: 'ok', open: 'info', 'too-dynamic': 'warn' }[R.density])}
          ${row('Crest factor', `${fmt(m.crest)} dB`, '')}
          ${row('Loudest 3 s vs average', `${fmtSigned(m.maxShortTerm - m.lufs)} LU`, '')}
        </table></div>
        <div><h3>Hits &amp; transients</h3>${t ? `<table>
          ${row('Hits detected', t.hitCount, '')}
          ${row('Hit level vs mix', `${fmtSigned(t.hitVsRmsDb)} dB`, t.hitVsRmsDb > 13 || t.hitVsRmsDb < 3 ? 'warn' : 'ok')}
          ${row('Kick rise 50–90 Hz', `${fmt(t.kickRiseDb)} dB`, t.kickRiseDb === null ? '' : kickSep ? 'ok' : 'warn')}
          ${row('Kick settle time', kickSep && t.kickDecay !== null ? `${t.kickDecay} ms` : 'not separable', '')}
          ${row('Bass settle 60–250 Hz', t.bassDecay !== null ? `${t.bassDecay} ms` : 'does not settle', '')}
          ${row('Attack settle 1–3 kHz', t.clickDecay !== null ? `${t.clickDecay} ms` : '—', '')}
          ${row('Low end vs mids at hits', `${fmtSigned(t.lowVsMidDb)} dB`, t.lowVsMidDb > 24 ? 'warn' : '')}
        </table>` : '<p class="muted">No clear repeated hits were found.</p>'}</div>
      </div>
      <h3>Streaming normalisation</h3>
      <table class="plat">
        <tr><th>Service</th><th class="n">Target</th><th class="n">Level change</th><th class="n">Peak after</th><th>Notes</th></tr>${plat}
      </table>
      <p class="note">Assumes each service\u2019s default setting, and that quiet tracks are only raised as far as a −1 dBTP peak allows. Listeners can change or switch off normalisation.</p>
    ` });

    // 3. Tone
    const refOct = S.ref ? S.ref.sum.tone.octaveRel : null;
    const octLabels = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
    pages.push({ section: 'Tone', html: `
      <h2>Tonal balance</h2>
      ${fig(img.tonalCanvas, `Average level per octave relative to pink noise (0 dB), normalised to the 125 Hz–4 kHz average.${S.ref ? ` Amber markers: reference (${esc(S.ref.name)}).` : ''}`)}
      <table class="oct"><tr><th>Octave (Hz)</th>${octLabels.map(l => `<th class="n">${l}</th>`).join('')}</tr>
        <tr><td>This track (dB)</td>${S.tone.octaveRel.map(v => `<td class="n">${fmtSigned(v)}</td>`).join('')}</tr>
        ${refOct ? `<tr><td>Reference (dB)</td>${refOct.map(v => `<td class="n">${fmtSigned(v)}</td>`).join('')}</tr>` : ''}
      </table>
      <div class="kpis">
        <div><span>Tilt 63 Hz–8 kHz</span><b>${fmtSigned(m.tilt)} dB/oct</b></div>
        <div><span>Low-mid bump</span><b>${fmtSigned(m.lowMidBump)} dB</b></div>
        <div><span>Presence vs low mids</span><b>${fmtSigned(m.lowMidPresenceGap)} dB</b></div>
        <div><span>Sub vs bass</span><b>${fmtSigned(m.subBassGap)} dB</b></div>
        <div><span>Air vs mids</span><b>${fmtSigned(m.airGap)} dB</b></div>
      </div>
      ${fig(img.spectrumCanvas, `Whole-track average spectrum, drawn so pink noise is flat. 20 Hz–20 kHz, log scale.${S.ref ? ' Dashed amber: reference, aligned on 100 Hz–5 kHz.' : ''}`)}
      ${fig(img.spectrogramCanvas, `Spectrogram, 0:00–${fmtTime(b.duration)}, 20 Hz–20 kHz (log). Colour shows level over a 72 dB range, from dark blue (quiet) to white (loud).`)}
    ` });

    // 4. Stereo
    pages.push({ section: 'Stereo', html: `
      <h2>Stereo image</h2>
      <div class="cols scope">
        <div>${fig(img.vectorscopeCanvas, 'Vectorscope, ~30,000 points across the whole track. Vertical = mono, diagonals = left or right only, horizontal = out of phase.', 'sq')}</div>
        <div><h3 style="margin-top:0">Measurements</h3><table>
          ${row('Phase correlation', fmtSigned(m.corr, 2), corrStatus(m.corr))}
          ${row('Stereo width', isFinite(m.width) ? m.width.toFixed(0) + '%' : '—', '')}
          ${row('Bass width 60–200 Hz', isFinite(m.lowWidth) ? m.lowWidth.toFixed(0) + '%' : '—', isFinite(m.lowWidth) ? lowWidthStatus(m) : '')}
          ${row('Widest bass band', isFinite(m.lowPeakWidth) && m.lowPeakFreq ? `${m.lowPeakWidth.toFixed(0)}% at ${m.lowPeakFreq} Hz` : '—', '')}
          ${row('Width below 60 Hz', isFinite(widthBelow60()) ? widthBelow60().toFixed(0) + '%' : '—', '')}
        </table>
        <div class="findings-mini">${sorted.filter(f => f.cat === 'stereo').map(findingHtmlR).join('')}</div></div>
      </div>
      ${fig(img.stereoFieldCanvas, 'Stereo width by frequency: share of energy in the side signal (0% = mono). Faint bars carry little energy. Amber: wide content between 50 and 200 Hz.')}
      ${fig(img.wfOverview, `Waveform (both channels mixed), 0:00–${fmtTime(b.duration)}.`)}
    ` });

    // 5. Reference (optional)
    if (S.ref) {
      const r = S.ref.sum, verdictBlock = verdictHtml(S.refVerdict);
      const rr = [
        ['Integrated loudness', m.lufs, r.lufs, 'LUFS', 1], ['True peak', m.truePeak, r.truePeak, 'dBTP', 1], ['Peak-to-loudness', m.plr, r.plr, 'dB', 1],
        ['Loudness range', m.lra, r.lra, 'LU', 1], ['Crest factor', m.crest, r.crest, 'dB', 1], ['Tonal tilt', m.tilt, r.tilt, 'dB/oct', 1],
        ['Presence vs low mids', m.lowMidPresenceGap, r.lowMidPresenceGap, 'dB', 1], ['Sub vs bass', m.subBassGap, r.subBassGap, 'dB', 1],
        ['Phase correlation', m.corr, r.corr, '', 2], ['Stereo width', m.width, r.width, '%', 0], ['Bass width 60–200 Hz', m.lowWidth, r.lowWidth, '%', 0],
      ];
      pages.push({ section: 'Reference', html: `
        <h2>Reference comparison</h2>
        <p class="lead">Compared with <b>${esc(S.ref.name)}</b>, both judged at equal loudness. Its tonal curve is overlaid on the Tone page.</p>
        ${verdictBlock}
        <h3>Where you differ most</h3>
        ${S.refDiffs && S.refDiffs.length ? `<div class="rdiffs">${S.refDiffs.slice(0, 6).map((d, i) => `<div class="rdiff"><div class="dn">${i + 1}</div><div><b>${esc(d.label)}</b><div class="fb">${esc(d.text)}</div></div></div>`).join('')}</div>` : '<p class="muted">Your track is close to the reference on every measure.</p>'}
        <h3>All measurements</h3>
        <table class="ref"><tr><th>Measurement</th><th class="n">This track</th><th class="n">Reference</th><th class="n">Difference</th></tr>
        ${rr.map(([n, a, c, u, d]) => `<tr><td>${n}</td><td class="n">${fmt(a, d)} ${u}</td><td class="n">${fmt(c, d)} ${u}</td><td class="n">${isFinite(a) && isFinite(c) ? fmtSigned(a - c, d) : '—'}</td></tr>`).join('')}</table>
      ` });
    }

    // 5a. Reference numbers from MasterScope Meter or a browser measurement (optional)
    if (S.meterRef) {
      const r = S.meterRef;
      const rr = [['Integrated loudness', m.lufs, r.lufs, 'LUFS'], ['True peak', m.truePeak, r.tp, 'dBTP'], ['Peak-to-loudness ratio', m.plr, r.plr, 'dB'],
                  ['Loudness range', m.lra, r.lra, 'LU'], ['Loudest moment (short-term)', m.maxShortTerm, r.maxShort, 'LUFS']];
      pages.push({ section: 'Reference numbers', html: `
        <h2>Against ${esc(r.name)}</h2>
        <p class="lead">${r.source === 'browser' ? 'Measured in the browser' : 'Measured with MasterScope Meter'} while it played. Streaming services turn loud songs down to about −14 LUFS, so the difference listeners hear is density. ${esc(meterRefLine(m, r))}</p>
        <table class="ref"><tr><th>Measurement</th><th class="n">This track</th><th class="n">${esc(r.name)}</th><th class="n">Difference</th></tr>
        ${rr.map(([n, a, c, u]) => `<tr><td>${n}</td><td class="n">${fmt(a)} ${u}</td><td class="n">${fmt(c)} ${u}</td><td class="n">${isFinite(a) && isFinite(c) ? fmtSigned(a - c) : '—'}</td></tr>`).join('')}</table>
      ` });
    }

    // 5b. Master render (optional)
    if (S.mastered) {
      const M = S.mastered, s = M.stats;
      const mr = [['Integrated loudness', m.lufs, s.lufs, 'LUFS'], ['True peak', m.truePeak, s.truePeak, 'dBTP'], ['Peak-to-loudness ratio', m.plr, s.plr, 'dB'],
        ['Loudness range', m.lra, s.lra, 'LU'], ['Max short-term', m.maxShortTerm, s.maxShortTerm, 'LUFS']];
      pages.push({ section: 'Master to −14', html: `
        <h2>Master to −14 preview</h2>
        <p class="lead">A preview master rendered by MasterScope, calibrated to −14.0 LUFS under a ${fmt(M.settings.ceiling)} dBTP ceiling. Compare it at equal loudness with the mix to judge density and tone, not volume.</p>
        <table class="ref"><tr><th>Measurement</th><th class="n">Your file</th><th class="n">Preview master</th><th class="n">Change</th></tr>
        ${mr.map(([n, x, y, u]) => `<tr><td>${n}</td><td class="n">${fmt(x)} ${u}</td><td class="n">${fmt(y)} ${u}</td><td class="n">${fmtSigned(y - x)}</td></tr>`).join('')}</table>
        <h3>Processing</h3>
        <p class="small">${esc(masterProcessText(M))}</p>
        ${(M.lim.maxGrDb > 4 || M.lim.avgGrDb > 2.5 || M.clip.maxRedDb > 3) ? '<p class="small"><b>The clipper or limiter worked hard.</b> Taming the peaks in the mix itself will sound cleaner than this preview.</p>' : ''}
      ` });
    }

    // 6. All findings
    const cats = ['loudness', 'dynamics', 'tone', 'stereo'];
    pages.push({ section: 'Findings', html: `
      <div class="allf"></div><h2>All findings</h2>
      <p class="lead">Every check MasterScope ran, grouped by area. Thresholds are rules of thumb that vary by genre; use them to decide what to listen for.</p>
      ${cats.map(c => { const l = sorted.filter(f => f.cat === c); return l.length ? `<h3>${CAT_TAB[c]}</h3>${l.map(findingHtmlR).join('')}` : ''; }).join('')}
    ` });

    // 7. Glossary & method
    const eqActive = eqBands.some(x => Math.abs(x.node.gain.value) > 0.05);
    pages.push({ section: 'Method', html: `
      <h2>How to read this report</h2>
      <dl class="gloss">${GLOSSARY.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <h3>Method</h3>
      <p class="small">Loudness and true peak follow ITU-R BS.1770-4; loudness range follows EBU Tech 3342. Tonal and stereo measurements average the whole track. All analysis ran locally in the browser on the file as supplied (${esc(metaLine)}${info.size ? `, ${(info.size / 1048576).toFixed(1)} MB` : ''}).${info.lossy ? ' This was a lossy file, so true peak and high-frequency readings may differ from the lossless master.' : ''}</p>
      ${eqActive ? `<p class="small">Playback EQ at the time of export (does not affect the measurements): ${eqBands.map((x, i) => `band ${i + 1} ${fmtHz(Math.round(x.node.frequency.value))}Hz ${fmtSigned(x.node.gain.value)} dB`).join(', ')}.</p>` : ''}
    ` });

    const N = pages.length;
    const logo = '<svg width="18" height="18" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6f86ff"/><circle cx="32" cy="32" r="24" fill="#3d5afe"/><circle cx="32" cy="32" r="24" fill="none" stroke="#fff" stroke-width="3"/><path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M13 34 L19 34 L23 23 L28 43 L33 17 L38 47 L42 27 L45 34 L51 34" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const pageHtml = pages.map((p, i) => `
      <section class="page${i === 0 ? ' first' : ''}">
        <header class="rh"><div class="brand">${logo}<span>Master<b>Scope</b></span></div><div class="rs">${esc(p.section)}</div></header>
        <div class="body">${p.html}</div>
        <footer class="rf"><span>${esc(S.fileName)} · ${esc(dateStr)}</span><span class="pn">Page ${i + 1} of ${N}</span></footer>
      </section>`).join('');

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(baseName())} – MasterScope report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>${REPORT_CSS}</style></head><body>
<div class="toolbar"><div><b>${esc(baseName())} – MasterScope report</b><span>In the print dialog, choose <b>Save as PDF</b> as the destination. For best results turn off “Headers and footers”.</span></div><button onclick="window.print()">Save as PDF</button></div>
${pageHtml}
<script>${PAGINATE_JS}<\/script>
</body></html>`;
  }

  // Runs inside the report window: moves blocks that would run into the footer onto a continuation page
  const PAGINATE_JS = `
window.paginate = function () {
  var pages = document.querySelectorAll('.page');
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i], body = p.querySelector('.body'), limit = p.querySelector('.rf').getBoundingClientRect().top - 8;
    var moved = [];
    while (body.children.length > 1 && body.lastElementChild.getBoundingClientRect().bottom > limit) moved.unshift(body.removeChild(body.lastElementChild));
    while (body.children.length > 1 && /^H[23]$/.test(body.lastElementChild.tagName)) moved.unshift(body.removeChild(body.lastElementChild));
    if (moved.length) {
      var np = p.cloneNode(true), nb = np.querySelector('.body');
      nb.innerHTML = '';
      moved.forEach(function (el) { nb.appendChild(el); });
      p.parentNode.insertBefore(np, p.nextSibling);
      pages = document.querySelectorAll('.page');
    }
  }
  var pn = document.querySelectorAll('.pn');
  for (var j = 0; j < pn.length; j++) pn[j].textContent = 'Page ' + (j + 1) + ' of ' + pn.length;
};`;

  const REPORT_CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; }
body { background: #e7e9ee; color: #161a22; font: 9.4pt/1.5 Inter, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.toolbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px; background: #161a22; color: #e8eaf0; font-size: 13px; }
.toolbar span { display: block; color: #9aa1b2; font-size: 12px; margin-top: 2px; }
.toolbar button { background: #3d5afe; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font: 600 13px Inter, sans-serif; cursor: pointer; white-space: nowrap; }
.page { width: 210mm; height: 297mm; margin: 8mm auto; background: #fff; position: relative; overflow: hidden; padding: 13mm 16mm 18mm; box-shadow: 0 2px 12px rgba(0,0,0,.12); break-after: page; page-break-after: always; }
.page:last-of-type { break-after: auto; page-break-after: auto; }
@media print { body { background: #fff; } .toolbar { display: none; } .page { margin: 0; box-shadow: none; } }
.rh { display: flex; justify-content: space-between; align-items: center; padding-bottom: 3.5mm; margin-bottom: 7mm; border-bottom: 0.3mm solid #e3e6ec; }
.brand { display: flex; align-items: center; gap: 2mm; font-weight: 600; font-size: 9.5pt; letter-spacing: -0.01em; }
.brand b { color: #3d5afe; font-weight: 600; }
.rs { font-size: 7.5pt; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #8a91a1; }
.rf { position: absolute; left: 16mm; right: 16mm; bottom: 9mm; display: flex; justify-content: space-between; font-size: 7.4pt; color: #8a91a1; border-top: 0.3mm solid #eceef2; padding-top: 2.5mm; }
.title .kicker { font-size: 8pt; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #3d5afe; }
h1 { font-size: 24pt; line-height: 1.12; letter-spacing: -0.025em; margin: 1.5mm 0 1.5mm; font-weight: 700; overflow-wrap: anywhere; }
.meta { color: #5b6272; font-size: 9pt; }
h2 { font-size: 15pt; letter-spacing: -0.015em; margin: 0 0 4mm; font-weight: 700; }
h3 { font-size: 7.8pt; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: #5b6272; margin: 6mm 0 2.5mm; }
.lead { color: #3e4554; margin: -1mm 0 5mm; }
.muted { color: #6b7385; } .small { font-size: 8.2pt; color: #3e4554; } .note { font-size: 7.4pt; color: #8a91a1; margin: 2mm 0 0; }
.verdict { display: flex; gap: 4mm; align-items: center; margin: 7mm 0 6mm; padding: 4.5mm 5mm; border-radius: 3mm; border: 0.3mm solid; }
.verdict.ok { background: #effaf4; border-color: #bfe8d3; } .verdict.warn { background: #fff7ea; border-color: #f2d7a6; } .verdict.danger { background: #fdf0f1; border-color: #f2c2c7; }
.verdict .vi { width: 9mm; height: 9mm; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: #fff; }
.verdict.ok .vi { background: #12a26a; } .verdict.warn .vi { background: #c47a0a; } .verdict.danger .vi { background: #d43c4a; }
.verdict .vi svg { width: 4.5mm; height: 4.5mm; }
.verdict .vh { font-size: 13pt; font-weight: 700; letter-spacing: -0.01em; }
.verdict .vs { color: #3e4554; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2.6mm; }
.tile { border: 0.3mm solid #e3e6ec; border-radius: 2.2mm; padding: 3mm 3.5mm; }
.tl { font-size: 7.4pt; color: #5b6272; font-weight: 500; display: flex; align-items: center; gap: 1.5mm; white-space: nowrap; }
.tv { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 15pt; font-weight: 600; letter-spacing: -0.02em; margin-top: 0.8mm; }
.tv small { font-size: 7.2pt; color: #6b7385; font-weight: 500; margin-left: 1mm; letter-spacing: 0; }
.td { font-size: 7.4pt; color: #5b6272; }
.dot { width: 1.8mm; height: 1.8mm; border-radius: 50%; display: inline-block; flex-shrink: 0; background: #9aa1b2; }
.dot.ok { background: #12a26a; } .dot.warn { background: #c47a0a; } .dot.danger { background: #d43c4a; }
.gauges { display: flex; gap: 6mm; justify-content: center; margin: 5mm 0 0; }
.gauges figure.g { width: 58mm; margin: 0; text-align: center; } .gauges figure.g img { border: 0; }
figure { margin: 0 0 4.5mm; break-inside: avoid; }
figure img { width: 100%; display: block; border-radius: 1.6mm; border: 0.3mm solid #e6e8ee; }
figcaption { font-size: 7.4pt; color: #6b7385; margin-top: 1.4mm; line-height: 1.4; }
figure.sq img { width: 100%; }
.f { display: grid; grid-template-columns: 6mm 1fr; gap: 2.5mm; padding: 2.6mm 0; border-bottom: 0.3mm solid #eef0f4; break-inside: avoid; }
.f:last-child { border-bottom: 0; }
.fi { width: 5mm; height: 5mm; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-top: 0.4mm; }
.fi svg { width: 2.8mm; height: 2.8mm; }
.f.ok .fi { background: #e3f6ec; color: #12a26a; } .f.warn .fi { background: #fdf1dc; color: #c47a0a; } .f.danger .fi { background: #fbe3e5; color: #d43c4a; } .f.info .fi { background: #eceef2; color: #6b7385; }
.ft { font-weight: 600; font-size: 9.2pt; }
.ft .cat { font-size: 6.8pt; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #8a91a1; margin-left: 1.5mm; }
.fb { color: #3e4554; font-size: 8.6pt; margin-top: 0.3mm; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; align-items: start; }
.cols.scope { grid-template-columns: 74mm 1fr; margin-bottom: 2mm; }
table { width: 100%; border-collapse: collapse; font-size: 8.4pt; }
th { text-align: left; font-size: 7pt; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: #8a91a1; padding: 1.4mm 1.6mm; border-bottom: 0.3mm solid #d9dde5; }
td { padding: 1.55mm 1.6mm; border-bottom: 0.3mm solid #eef0f4; vertical-align: middle; }
td:first-child { color: #3e4554; }
.n { text-align: right; font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 8.1pt; white-space: nowrap; }
td.bad { color: #d43c4a; }
td.st { width: 15mm; text-align: right; }
.pill { display: inline-block; font-size: 6.6pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 0.5mm 1.8mm; border-radius: 10mm; }
.pill.ok { background: #e3f6ec; color: #0d8a59; } .pill.warn { background: #fdf1dc; color: #a86707; } .pill.danger { background: #fbe3e5; color: #c0303e; } .pill.info { background: #eceef2; color: #5b6272; }
table.plat td, table.plat th { padding-left: 1.2mm; padding-right: 1.2mm; }
table.oct { margin: 1mm 0 4mm; } table.oct th, table.oct td { padding: 1.3mm 1mm; } table.oct td:first-child, table.oct th:first-child { white-space: nowrap; }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 2.5mm; margin-bottom: 5mm; }
.kpis div { border: 0.3mm solid #e3e6ec; border-radius: 2mm; padding: 2.2mm 2.8mm; }
.kpis span { display: block; font-size: 7pt; color: #5b6272; white-space: nowrap; }
.kpis b { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 10pt; font-weight: 600; }
.findings-mini { margin-top: 4mm; }
table.ref td, table.ref th { padding: 2.2mm 2mm; }
.allf + h2 ~ .f .cat { display: none; }
.allf + h2 ~ .f { padding: 2mm 0; }
dl.gloss { margin: 0; }
:root { --accent: #3d5afe; --warn: #c47a0a; --danger: #d43c4a; --ok: #12a26a; --info: #8b93a7; --ref: #c47a0a; --text: #161a22; }
.budget { margin: 6mm 0 2mm; }
.budget.has-ref .b-label { margin-bottom: 11mm; }
.b-label { display: flex; justify-content: space-between; font-size: 7.6pt; color: #5b6272; margin-bottom: 7mm; }
.b-track { position: relative; height: 3mm; display: flex; }
.b-zone { height: 100%; } .b-zone:first-child { border-radius: 1.5mm 0 0 1.5mm; } .b-zone:last-child { border-radius: 0 1.5mm 1.5mm 0; }
.z-sq { background: #f3dcae; } .z-comp { background: #bfe8d3; } .z-open { background: #dfe2e8; } .z-over { background: #f4c7cc; }
.b-mark { position: absolute; top: -1.6mm; width: 0.8mm; height: 6.2mm; border-radius: 0.4mm; background: #161a22; transform: translateX(-0.4mm); }
.b-mark.ref { background: #c47a0a; }
.b-mark span { position: absolute; top: -4.6mm; left: 50%; transform: translateX(-50%); font: 600 7.4pt 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap; }
.b-mark.ref span { top: -8.4mm; color: #c47a0a; }
.b-limit { position: absolute; top: -1mm; bottom: -1mm; border-left: 0.5mm dashed #d43c4a; }
.b-ticks { position: relative; height: 4mm; margin-top: 1.2mm; font: 6.8pt 'JetBrains Mono', ui-monospace, monospace; color: #8a91a1; }
.b-ticks span { position: absolute; transform: translateX(-50%); }
.b-zones-legend { display: flex; flex-wrap: wrap; gap: 1mm 5mm; font-size: 7.2pt; color: #5b6272; margin-top: 1mm; }
.b-zones-legend i { display: inline-block; width: 2.4mm; height: 2.4mm; border-radius: 0.6mm; margin-right: 1.4mm; vertical-align: -0.3mm; }
ol.rsteps { margin: 0; padding: 0; list-style: none; counter-reset: s; }
ol.rsteps li { counter-increment: s; position: relative; padding: 1.6mm 0 1.6mm 8mm; font-size: 8.8pt; border-bottom: 0.3mm solid #eef0f4; }
ol.rsteps li:last-child { border-bottom: 0; }
ol.rsteps li::before { content: counter(s); position: absolute; left: 0; top: 1.6mm; width: 5mm; height: 5mm; border-radius: 50%; background: #e8ecff; color: #3d5afe; font-weight: 700; font-size: 7.5pt; display: flex; align-items: center; justify-content: center; }
ol.rsteps li b { font-weight: 600; } ol.rsteps li span { color: #3e4554; }
.src-bar { display: flex; height: 3.2mm; border-radius: 1.6mm; overflow: hidden; background: #eceef2; margin: 1mm 0 2.5mm; }
.src-bar div { height: 100%; }
.src-legend { display: flex; flex-wrap: wrap; gap: 1.2mm 4mm; font-size: 7.6pt; color: #5b6272; }
.src-legend i { display: inline-block; width: 2.4mm; height: 2.4mm; border-radius: 0.6mm; margin-right: 1.2mm; vertical-align: -0.3mm; }
.src-legend b { color: #161a22; font-family: 'JetBrains Mono', ui-monospace, monospace; margin-left: 1mm; }
.rdiff { display: grid; grid-template-columns: 7mm 1fr; gap: 2mm; padding: 2.4mm 0; border-bottom: 0.3mm solid #eef0f4; break-inside: avoid; }
.rdiff .dn { width: 5mm; height: 5mm; border-radius: 50%; background: #fdf1dc; color: #a86707; font-weight: 700; font-size: 7.5pt; display: flex; align-items: center; justify-content: center; }
.rdiff b { font-size: 9pt; }
dl.gloss dt { font-weight: 650; font-size: 9pt; margin-top: 3mm; }
dl.gloss dd { margin: 0.5mm 0 0; color: #3e4554; font-size: 8.5pt; }
.lb-notice { font-size: 8.4pt; color: #3e4554; border: 0.3mm solid #e3e6ec; border-left: 0.9mm solid #c47a0a; border-radius: 1.6mm; padding: 2.2mm 3mm; margin: 0 0 4mm; }
.lb-sec + .lb-sec { margin-top: 5mm; }
.mini-h { font-size: 7.4pt; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: #5b6272; margin: 0 0 1.6mm; }
.lb-lead { font-size: 8.4pt; color: #3e4554; margin: 0 0 2mm; line-height: 1.45; }
.lb-row { display: grid; grid-template-columns: 34mm 1fr 26mm; gap: 3mm; align-items: center; padding: 1.3mm 0; border-bottom: 0.3mm solid #eef0f4; break-inside: avoid; }
.lb-name { font-size: 8.4pt; font-weight: 600; line-height: 1.2; }
.lb-name small { display: block; font-weight: 400; color: #8a91a1; font-size: 7pt; font-family: 'JetBrains Mono', ui-monospace, monospace; }
.lb-bars { display: flex; flex-direction: column; gap: 0.9mm; }
.lb-bar { display: grid; grid-template-columns: 1fr 9mm; gap: 2mm; align-items: center; }
.lb-track { height: 1.9mm; border-radius: 1mm; background: #eceef2; overflow: hidden; }
.lb-fill { height: 100%; border-radius: 1mm; } .lb-fill.peak { background: #c47a0a; } .lb-fill.loud { background: #3d5afe; }
.lb-val { font: 7pt 'JetBrains Mono', ui-monospace, monospace; color: #5b6272; text-align: right; }
.lb-tag { font-size: 7.4pt; color: #8a91a1; text-align: right; } .lb-tag.cost { color: #a86707; font-weight: 600; } .lb-tag.eff { color: #0d8a59; font-weight: 600; }
.lb-legend { display: flex; gap: 5mm; font-size: 7.2pt; color: #5b6272; margin-top: 1.6mm; }
.lb-legend i { display: inline-block; width: 2.4mm; height: 2.4mm; border-radius: 0.6mm; margin-right: 1.2mm; vertical-align: -0.3mm; }
.lb-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; }
.mv-row { display: grid; grid-template-columns: 30mm 1fr 21mm; gap: 2.5mm; align-items: center; padding: 1.4mm 0; border-bottom: 0.3mm solid #eef0f4; break-inside: avoid; }
.mv-row.top .lb-name { color: #0d8a59; }
.mv-axis { position: relative; height: 2.2mm; border-radius: 1.1mm; background: #eceef2; }
.mv-axis::after { content: ''; position: absolute; left: 50%; top: -0.6mm; bottom: -0.6mm; width: 0.3mm; background: #c9ced8; }
.mv-fill { position: absolute; top: 0; bottom: 0; border-radius: 1.1mm; } .mv-fill.good { left: 50%; background: #12a26a; } .mv-fill.bad { right: 50%; background: #d43c4a; }
.mv-val { font: 7.6pt 'JetBrains Mono', ui-monospace, monospace; text-align: right; } .mv-val.good { color: #0d8a59; } .mv-val.bad { color: #c0303e; } .mv-val.flat { color: #8a91a1; }
.mv-how { display: none; }
.lb-spot { font-size: 7.8pt; color: #3e4554; padding: 1.1mm 0; border-bottom: 0.3mm solid #eef0f4; } .lb-spot b { font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 600; color: #161a22; margin-right: 2mm; } .lb-spot.dip b { color: #a86707; }
.mv-row.top .mv-how { display: block; grid-column: 1 / -1; font-size: 7.2pt; color: #5b6272; margin-top: -0.4mm; }
.verdict-box { border: 0.3mm solid #e3e6ec; border-radius: 2mm; padding: 2.6mm 3.2mm; margin: 0 0 4mm; }
.verdict-box .vh { font-weight: 650; font-size: 9.4pt; margin-bottom: 1mm; }
.verdict-box ul { margin: 1mm 0 0; padding-left: 4.5mm; font-size: 8.4pt; color: #3e4554; }
.verdict-box .vn { font-size: 7.6pt; color: #8a91a1; margin-top: 1.4mm; }
`;

  $('exportPdfBtn').addEventListener('click', async () => {
    if (!S.buffer) return;
    const win = window.open('', '_blank');
    if (!win) return toast('Your browser blocked the report window. Allow pop-ups for this page and try again.', 5000);
    win.document.write('<p style="font:14px -apple-system,sans-serif;padding:24px;color:#555">Preparing report…</p>');
    if (isPlaying) pause();
    stopPreview();
    await tick();
    let html;
    try { html = buildReportHtml(captureChartsForReport()); }
    catch (e) { win.close(); toast('Couldn’t build the report: ' + e.message, 5000); return; }
    win.document.open(); win.document.write(html); win.document.close();
    const wait = ms => new Promise(r => setTimeout(r, ms));
    await Promise.race([
      Promise.all([...win.document.images].map(i => i.decode ? i.decode().catch(() => {}) : null).concat(win.document.fonts ? [win.document.fonts.ready] : [])),
      wait(3000),
    ]);
    try { win.paginate(); } catch (e) {}
    win.focus(); win.print();
  });

  // ===================================================================
  // Landing page: live ridges that become your song, demo song, density
  // strip, count-ups and the MasterScope + Liminal loop
  // ===================================================================
  const LP = window.LP = (() => {
    const cv = $('lpRidges');
    if (!cv) return null;
    const g = cv.getContext('2d');
    const M = 24, P = 128, reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frames = null, morphStart = 0, raf = 0, last = 0, onScreen = true, phase = 0;
    const STOPS = [[27, 31, 94], [90, 42, 138], [176, 58, 110], [236, 106, 58], [251, 179, 60], [252, 245, 196]];
    function heat(t, a) {
      t = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
      const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i;
      const c = STOPS[i].map((v, k) => Math.round(v + (STOPS[i + 1][k] - v) * f));
      return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    }
    // The idle landscape: smooth bumps that drift slowly
    function idle(k, f, ph) {
      const tilt = 1 - f * 0.75;
      const b = 0.5 + 0.5 * Math.sin(f * 21 + k * 0.7 + ph) * Math.sin(f * 5.3 - k * 0.3 - ph * 0.6);
      const n = 0.09 * Math.sin(f * 63 + k * 2.1 + ph * 1.7) + 0.06 * Math.sin(f * 117 - k * 1.3);
      return Math.max(0, 0.38 + 0.45 * tilt * b + n);
    }
    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [w, h];
    }
    function draw(now) {
      const [W, H] = size();
      // the ridges follow the theme: lines on the page's own background
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      const bgc = light ? '#f6f2ec' : '#07080f';
      g.fillStyle = bgc; g.fillRect(0, 0, W, H);
      const mix = frames ? Math.min(1, (now - morphStart) / 1400) : 0, ease = mix * mix * (3 - 2 * mix);
      // after the morph the song plays through: one new slice every 0.18 s
      const off = frames ? Math.floor(Math.max(0, now - morphStart - 1400) / 180) : 0;
      for (let k = M - 1; k >= 0; k--) {
        const depth = k / (M - 1);
        const y0 = H * (0.985 - depth * 0.73), h = H * (0.30 - depth * 0.11);
        const x0 = W * 0.0 + depth * W * 0.04, w = W - depth * W * 0.08;
        const fr = frames ? frames[(frames.length - 1 - ((M - 1 - k) + off) % frames.length + frames.length) % frames.length] : null;
        g.beginPath(); g.moveTo(x0, y0);
        for (let i = 0; i < P; i++) {
          const f = i / (P - 1);
          let v = idle(k, f, phase);
          if (fr) v = v * (1 - ease) + fr[i] * ease;
          g.lineTo(x0 + f * w, y0 - v * h);
        }
        g.lineTo(x0 + w, y0); g.closePath();
        g.fillStyle = bgc; g.fill();
        g.lineWidth = 1.9 - depth; g.strokeStyle = light ? heat(0.72 - depth * 0.62, 1 - depth * 0.5) : heat(0.95 - depth * 0.85, 1 - depth * 0.55); g.stroke();
      }
    }
    function loop(now) {
      raf = 0;
      if (!onScreen || document.hidden || currentView !== 'landing') return;
      if (now - last > 33) { phase += reduce ? 0 : 0.012; draw(now); last = now; }
      if (!reduce || frames) raf = requestAnimationFrame(loop);
    }
    // Draw one still frame straight away; start moving only once the page has
    // finished loading, so the animation never competes with the first paint.
    let started = false;
    function kick() {
      if (!started) { if (onScreen && currentView === 'landing') requestAnimationFrame(t => draw(t)); return; }
      if (!raf) raf = requestAnimationFrame(loop);
    }
    const begin = () => setTimeout(() => { started = true; kick(); }, 1500);
    if (document.readyState === 'complete') begin(); else window.addEventListener('load', begin, { once: true });
    new IntersectionObserver(es => { onScreen = es[0].isIntersecting; if (onScreen) kick(); }).observe(cv);
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('resize', () => { last = 0; kick(); });
    new MutationObserver(() => { last = 0; if (onScreen && currentView === 'landing') requestAnimationFrame(t => draw(t)); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Your song's spectrum: 64 moments through the track, 1/6-octave-ish bands, pink-tilted
    function spectraOf(buffer) {
      const N = 8192, ch = buffer.numberOfChannels, len = buffer.length, fs = buffer.sampleRate;
      const L = buffer.getChannelData(0), R = ch > 1 ? buffer.getChannelData(1) : L;
      const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
      const re = new Float64Array(N), im = new Float64Array(N), out = [], F = 64;
      const edges = []; for (let i = 0; i <= P; i++) edges.push(Math.max(1, Math.round(30 * Math.pow(600, i / P) / fs * N)));
      let max = -200;
      for (let fi = 0; fi < F; fi++) {
        const s0 = Math.floor((len - N) * fi / (F - 1));
        for (let i = 0; i < N; i++) { re[i] = 0.5 * (L[s0 + i] + R[s0 + i]) * win[i]; im[i] = 0; }
        DSP.fft(re, im);
        const row = new Float64Array(P);
        for (let b = 0; b < P; b++) {
          let p = 0, c = 0;
          for (let k = edges[b]; k <= Math.max(edges[b], edges[b + 1] - 1) && k < N / 2; k++) { p += re[k] * re[k] + im[k] * im[k]; c++; }
          const fc = 30 * Math.pow(600, (b + 0.5) / P);
          row[b] = 10 * Math.log10(p / Math.max(1, c) + 1e-20) + 10 * Math.log10(fc / 1000);
          max = Math.max(max, row[b]);
        }
        const sm = new Float64Array(P);   // light smoothing across bands
        for (let b = 0; b < P; b++) sm[b] = (row[Math.max(0, b - 1)] + 2 * row[b] + row[Math.min(P - 1, b + 1)]) / 4;
        out.push(sm);
      }
      return out.map(row => Array.from(row, v => Math.max(0, Math.min(1.05, (v - (max - 54)) / 54))));
    }
    async function morphTo(buffer) {
      try { frames = spectraOf(buffer); } catch (e) { frames = null; return; }
      morphStart = performance.now();
      $('lpRidgeNote').textContent = 'This is your song';
      started = true; kick();
      await new Promise(r => setTimeout(r, 1100));
    }
    function startProgress(name) {
      $('lpCtas').classList.add('hidden');
      $('lpProgress').classList.remove('hidden');
      $('lpProgressFile').textContent = name;
      $('lpProgressBar').style.width = '2%';
      $('lpProgressStep').textContent = 'Reading your track…';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function endProgress() {
      $('lpCtas').classList.remove('hidden');
      $('lpProgress').classList.add('hidden');
    }

    // Typical density by style, and where your last track landed
    const BANDS = [['Club and EDM', 5, 8, '#962c5b', '#fff'], ['Pop, hip-hop, dance, rock', 8, 12, '#ec6a3a', '#1a0d06'],
                   ['Acoustic, jazz', 12, 14, '#fbb33c', '#1a1208'], ['Unmastered mixes', 14, 19, '#2e2a40', '#e9e3f0']];
    const lo = 5, hi = 19, pct = v => (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * 100;
    $('lpStrip').insertAdjacentHTML('afterbegin', BANDS.map(([n, a, b, bg, fg]) =>
      `<div class="lp-band" style="left:${pct(a)}%;width:calc(${pct(b) - pct(a)}% - 4px);background:${bg};color:${fg}"><b>${n}</b><span>PLR ${a}–${b}</span></div>`).join('') +
      [6, 8, 10, 12, 14, 16, 18].map(v => `<span class="lp-tick" style="left:${pct(v)}%">${v}</span>`).join(''));
    function updateMarker() {
      let e = null; try { const l = loadHist(); e = l[l.length - 1]; } catch (err) {}
      const mk = $('lpMarker');
      if (!e || !isFinite(e.plr)) { mk.classList.add('hidden'); return; }
      const band = BANDS.find(b => e.plr >= b[1] && e.plr < b[2]) || (e.plr < lo ? BANDS[0] : BANDS[BANDS.length - 1]);
      $('lpMarkerLabel').textContent = `${(e.name || 'Your track').replace(/\.[a-z0-9]+$/i, '').slice(0, 28)}: PLR ${fmt(e.plr)}`;
      mk.style.left = pct(e.plr) + '%';
      mk.classList.toggle('flip', pct(e.plr) > 70);
      mk.classList.remove('hidden');
      $('lpStripNote').textContent = `Your last track sits with ${band[0].toLowerCase()}. Typical ranges for released masters; density is a choice, so judge it by ear.`;
    }

    // Numbers count up, and the loop lights 1 → 2 → 3 → 4, when scrolled into view
    const counted = new WeakSet();
    new IntersectionObserver(es => es.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.querySelectorAll('[data-count-to]').forEach(el => {
        if (counted.has(el)) return; counted.add(el);
        const a = +el.dataset.countFrom, b = +el.dataset.countTo, t0 = performance.now(), D = reduce ? 0 : 1400;
        const step = now => { const x = D ? Math.min(1, (now - t0) / D) : 1, e2 = 1 - Math.pow(1 - x, 3); el.textContent = fmt(a + (b - a) * e2); if (x < 1) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      });
    }), { threshold: 0.4 }).observe($('lpResults'));
    let loopTimer = 0;
    const items = [...document.querySelectorAll('.lp-loop li')];
    new IntersectionObserver(es => {
      clearInterval(loopTimer);
      if (!es[0].isIntersecting || reduce) { items.forEach(li => li.classList.remove('lit')); return; }
      let i = 0;
      const lightNext = () => { items.forEach((li, j) => li.classList.toggle('lit', j === i % items.length)); i++; };
      lightNext(); loopTimer = setInterval(lightNext, 1300);
    }, { threshold: 0.35 }).observe($('lpLoop'));

    // A demo song, synthesised in the browser: an unmastered 124 bpm mix
    async function renderDemo() {
      const fs = 44100, dur = 30, Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const ctx = new Off(2, fs * dur, fs), out = ctx.createGain(); out.gain.value = 0.5; out.connect(ctx.destination);
      const beat = 60 / 124, noise = ctx.createBuffer(1, fs, fs), nd = noise.getChannelData(0);
      let sd = 7; for (let i = 0; i < fs; i++) { sd = (sd * 16807) % 2147483647; nd[i] = sd / 1073741823.5 - 1; }
      const pan = (node, p) => { const pn = ctx.createStereoPanner(); pn.pan.value = p; node.connect(pn); return pn; };
      const roots = [55, 43.65, 65.41, 49], chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
      const nBeats = Math.floor(dur / beat);
      for (let b = 0; b < nBeats; b++) {
        const t = b * beat, bar = Math.floor(b / 4), ci = bar % 4, intro = bar < 2;
        if (!intro) {   // kick
          const o = ctx.createOscillator(), e = ctx.createGain();
          o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
          e.gain.setValueAtTime(1.0, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
          o.connect(e); e.connect(out); o.start(t); o.stop(t + 0.4);
        }
        if (!intro && b % 2 === 1) {   // snare
          const s = ctx.createBufferSource(); s.buffer = noise;
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 0.7;
          const e = ctx.createGain(); e.gain.setValueAtTime(0.75, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
          s.connect(bp); bp.connect(e); e.connect(out); s.start(t, Math.random() * 0.5); s.stop(t + 0.25);
          const o = ctx.createOscillator(), e2 = ctx.createGain(); o.frequency.value = 190;
          e2.gain.setValueAtTime(0.35, t); e2.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
          o.connect(e2); e2.connect(out); o.start(t); o.stop(t + 0.1);
        }
        for (let h = 0; h < 2; h++) {   // hats
          const th = t + h * beat / 2, s = ctx.createBufferSource(); s.buffer = noise;
          const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
          const e = ctx.createGain(); e.gain.setValueAtTime(h ? 0.32 : 0.18, th); e.gain.exponentialRampToValueAtTime(0.001, th + 0.05);
          s.connect(hp); hp.connect(e); pan(e, 0.25).connect(out); s.start(th, 0.3); s.stop(th + 0.06);
        }
        for (let q = 0; q < 2 && !intro; q++) {   // bass, eighth notes ducking under the kick
          const tb = t + q * beat / 2, o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = roots[ci];
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
          const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, tb); e.gain.linearRampToValueAtTime(q ? 0.42 : 0.22, tb + 0.03); e.gain.exponentialRampToValueAtTime(0.01, tb + beat / 2);
          o.connect(lp); lp.connect(e); e.connect(out); o.start(tb); o.stop(tb + beat / 2 + 0.02);
        }
        if (b % 4 === 0) {   // pad chord per bar, wide
          chords[ci].forEach((f, j) => [-1, 1].forEach(side => {
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * (1 + side * 0.004);
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
            const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(0.045, t + 0.4); e.gain.linearRampToValueAtTime(0.0001, t + beat * 4);
            o.connect(lp); lp.connect(e); pan(e, side * 0.6).connect(out); o.start(t); o.stop(t + beat * 4 + 0.05);
          }));
        }
      }
      const buf = await ctx.startRendering();
      let pk = 0; for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i])); }
      const gn = Math.pow(10, -6 / 20) / Math.max(1e-6, pk);   // leave it unmastered: peaks at −6 dBFS
      for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= gn; }
      return buf;
    }
    $('demoBtn').addEventListener('click', async () => {
      const name = 'Demo song (unmastered mix)';
      stopEverything();
      startProgress(name);
      setProgress(0.04, 'Making the demo song…');
      await tick();
      let buf;
      try { await ensureContext(44100); buf = await renderDemo(); } catch (e) { endProgress(); return toast('Your browser couldn’t make the demo song.', 4000); }
      await morphTo(buf);
      await analyse(buf, name, { format: 'Demo (made in your browser)', sampleRate: 44100, bitDepth: 24, size: 0 });
    });

    return {
      startProgress, endProgress, morphTo,
      onShow() { endProgress(); updateMarker(); last = 0; kick(); },
    };
  })();
  showView('landing');

  // ===================================================================
  // Reference numbers: a song measured by MasterScope Meter (sent here with
  // ?ref=...) or measured in this browser. Numbers only, never audio.
  // ===================================================================
  const REF_KEY = 'ms-meter-ref';
  const REF_PLATFORMS = [['Spotify', -14, 1], ['YouTube', -14, 0], ['Apple Music', -16, 2], ['Tidal', -14, 0], ['Amazon Music', -14, 0], ['Deezer', -15, 2]];
  function platformText(target, up, I, tp) {
    const g = target - I;
    if (g < -0.05) return { down: true, text: `turned down ${fmt(-g)} dB` };
    if (g < 0.05) return { down: false, text: 'plays as it is' };
    if (up === 1) {
      const u = Math.max(0, Math.min(g, -1 - tp));
      return { down: false, text: u < 0.05 ? `not turned up (peaks too high): ${fmt(g)} dB quieter` : u < g - 0.05 ? `turned up ${fmt(u)} dB, still ${fmt(g - u)} dB quieter` : `turned up ${fmt(u)} dB` };
    }
    return { down: false, text: up === 0 ? `not turned up: plays ${fmt(g)} dB quieter` : `may be turned up ${fmt(g)} dB` };
  }
  function densityVerdict(plr) {
    return plr < 7 ? 'Limited very hard: dense and loud, typical of club and modern EDM masters.'
      : plr < 9 ? 'Limited firmly: loud and punchy, typical of current pop and rock.'
      : plr < 12 ? 'Limited moderately: competitive, with room for the hits to breathe.'
      : 'Limited gently: dynamic, typical of acoustic, jazz and older masters.';
  }
  function cleanRef(r) {
    if (!r) return null;
    const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi) ? v : NaN;
    const out = { name: String(r.name || 'Reference song').slice(0, 120), lufs: num(r.lufs, -70, 5), tp: num(r.tp, -60, 12), plr: num(r.plr, 0, 40),
                  lra: num(r.lra, 0, 60), maxShort: num(r.maxShort, -70, 5), source: r.source === 'browser' ? 'browser' : 'meter' };
    if (!isFinite(out.plr) && isFinite(out.tp) && isFinite(out.lufs)) out.plr = out.tp - out.lufs;
    return isFinite(out.lufs) ? out : null;
  }
  // A MasterScope Meter export as a full reference: loudness, peaks, density,
  // crest, stereo and tone, measured from the song as it played. Numbers only.
  function isMeterExport(o) { return !!o && (o.format === 'masterscope-meter' || o.app === 'MasterScope Meter') && o.result && Array.isArray(o.toneDbPinkFlat); }
  function meterTone(hz, dbPF, ranges) {
    // band power from the pink-flat 1/6-octave bands; each band spans 1/6 octave around its centre
    const P = dbPF.map((v, b) => Math.pow(10, (v - 10 * Math.log10(hz[b] / 1000)) / 10));
    const l0 = Math.log2(hz[0]);
    const power = (f0, f1) => {
      const a = Math.log2(f0), z = Math.log2(f1); let sum = 0;
      for (let b = 0; b < P.length; b++) {
        const b0 = l0 + (b - 0.5) / 6, b1 = l0 + (b + 0.5) / 6, ov = Math.min(b1, z) - Math.max(b0, a);
        if (ov > 0) sum += P[b] * ov * 6;
      }
      return sum;
    };
    const db10 = v => 10 * Math.log10(v || 1e-20);
    // the Meter measures MasterScope's own ranges exactly; the 1/6-octave bands fill in the rest
    const exact = (Array.isArray(ranges) ? ranges : []).filter(x => Array.isArray(x) && x.length === 3 && x.every(v => typeof v === 'number' && isFinite(v)));
    const po = (f0, f1) => {
      const hit = exact.find(([a, b]) => Math.abs(a - f0) <= f0 * 0.01 && Math.abs(b - f1) <= f1 * 0.01);
      return hit ? hit[2] : db10(power(f0, f1) / Math.log2(f1 / f0));
    };
    const C = DSP.OCTAVE_CENTRES;
    const octaveDb = C.map(c => { const f0 = c / Math.SQRT2, f1 = Math.min(c * Math.SQRT2, 18000); return f1 > f0 ? po(f0, f1) : -Infinity; });
    const ref = [2, 3, 4, 5, 6, 7].reduce((a, i) => a + octaveDb[i], 0) / 6;
    const octaveRel = octaveDb.map(v => v - ref);
    const xs = [], ys = [];
    for (let i = 1; i <= 8; i++) if (isFinite(octaveRel[i])) { xs.push(Math.log2(C[i])); ys.push(octaveRel[i]); }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) * (x - mx); });
    const lowMid = po(250, 500), presence = po(2000, 5000);
    return {
      octaveCentres: C, octaveRel, tilt: den > 0 ? num / den : 0,
      lowMidPresenceGap: presence - lowMid, subBassGap: po(20, 60) - po(60, 250),
      lowMidBump: lowMid - (po(125, 250) + po(500, 1000)) / 2, airGap: po(8000, 16000) - po(1000, 4000),
      bars(fMin, fMax, n) { const out = new Float32Array(n), q = fMax / fMin; for (let i = 0; i < n; i++) { const f0 = fMin * Math.pow(q, i / n), f1 = fMin * Math.pow(q, (i + 1) / n); out[i] = po(f0, f1); } return out; },
    };
  }
  function loadMeterExport(o, fileName) {
    const r = o.result, st = o.stereo || {}, n = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    let tone;
    try { tone = meterTone(o.toneDbPinkFlat.map((_, b) => 20 * Math.pow(2, b / 6)), o.toneDbPinkFlat, o.toneRanges); }
    catch (e) { return toast('That Meter export couldn’t be read.'); }
    const name = String(o.song || '').trim() || fileName.replace(/\.json$/i, '').replace(/\s*-?\s*MasterScope Meter$/i, '').replace(/Measurement$/i, '').trim() || 'Measured song';
    const sum = {
      lufs: n(r.integratedLufs), truePeak: n(r.truePeakDbtp), plr: n(r.plr), lra: n(r.lraLu), crest: n(r.crestDb),
      tilt: tone.tilt, lowMidPresenceGap: tone.lowMidPresenceGap, subBassGap: tone.subBassGap,
      corr: n(st.correlation), width: n(st.widthPct), lowWidth: n(st.lowWidthPct), bassWidth: n(st.bassWidthPct), tone,
    };
    if (!isFinite(sum.plr) && isFinite(sum.truePeak) && isFinite(sum.lufs)) sum.plr = sum.truePeak - sum.lufs;
    if (!isFinite(sum.lufs)) return toast('That Meter export has no loudness reading.');
    if (previewWhich === 'ref' || previewWhich === 'mine') stopPreview();
    S.ref = { buffer: null, name: name.slice(0, 120), sum, budget: null, meter: true, meterTone: tone };
    S.ref.bars = refBarsFor(S.ref);
    // the numbers also drive the landing banner and the density notes until a track is in
    setMeterRef({ name: S.ref.name, lufs: sum.lufs, tp: sum.truePeak, plr: sum.plr, lra: sum.lra, maxShort: n(r.maxShortTermLufs), source: 'meter' });
    if (S.metrics) {
      computeRefDiffs(); renderRefContent(); renderToneTiles(); renderReadiness(); renderPeaksDensity();
      if (currentView !== 'app') showView('app');
      setTab('compare');
      toast(`Comparing with ${S.ref.name}. Its tonal curve is on the Tone tab too.`, 4500);
    } else toast(`Reference loaded: ${S.ref.name}. Drop your track to compare.`, 4500);
  }
  // ---- A Meter export as its own report: everything MasterScope can work out
  // from the measurements, the same tabs as for a file. The parts that need the
  // audio itself (waveform, spectrogram, vectorscope, transients, Tools, playback) are hidden.
  function setMeterSongMode(o) {
    S.meterSong = o || null;
    document.body.classList.toggle('meter-song', !!o);
    document.body.classList.toggle('meter-lite', !!o && !o.wave);   // an older export without the detail
    const ban = $('meterSongBanner'); if (!ban) return;
    ban.classList.toggle('hidden', !o);
    if (!o) { ban.innerHTML = ''; return; }
    const cap = o.capture || {}, src = cap.app ? (typeof cap.app === 'string' ? cap.app.replace(/\.exe$/i, '') : '') : '';
    const srcName = { spotify: 'Spotify', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', vlc: 'VLC' }[src.toLowerCase()] || src;
    ban.innerHTML = `<div><b>Measured by MasterScope Meter</b>${srcName ? ` from ${esc(srcName)}` : ''}${/app/.test(cap.source || '') ? ', straight from the app' : cap.source ? ', after this computer\'s sound effects' : ''}. `
      + (o.wave ? `Only numbers were kept: everything here was measured as it played. Playback and Tools need the audio file.` : `This export is from an earlier Meter, so the waveform, spectrogram, vectorscope, transients and peak sources aren't in it: measure the song again with the latest Meter to see them. Playback and Tools need the audio file.`) + `${/^(spotify|chrome|msedge|firefox|brave|opera)$/i.test(src) ? ' Its true peak is the peak as it streamed, after encoding.' : ''}</div>`
      + `<div class="msb-actions"><button class="btn sm primary" id="msbCompare" type="button">Compare my track with it</button></div>`;
    $('msbCompare').addEventListener('click', () => {
      const o2 = S.meterSong, name = S.fileName;
      setMeterSongMode(null);
      S.metrics = null;
      loadMeterExport(o2, name + '.json');
      fileInput.click();
    });
  }
  // The Meter's detail (format 3): waveform outline, tone over time, width by
  // frequency, vectorscope density, drum hits and peak sources, rebuilt into the
  // shapes MasterScope's own panels draw from.
  function meterDetail(o, dur, sf) {
    if (!o.wave || !o.spectrogram || !o.vectorscope) return null;
    const out = {};
    const mm = Array.isArray(o.wave.minMax) ? o.wave.minMax : [];
    out.mono = Float32Array.from(mm, v => +v || 0);           // min, max pairs: the waveform drawer reads min and max per pixel
    // tone over time: per-bin levels from the 1/6-octave bands, interpolated across frequency
    const fs = 48000, fftSize = 4096, half = fftSize / 2, binHz = fs / fftSize, cols = Array.isArray(o.spectrogram.bandDb) ? o.spectrogram.bandDb : [];
    const bpo = o.spectrogram.bandsPerOctave || 6, NS = cols.length ? cols[0].length : 61;
    const bw = b => 20 * Math.pow(2, b / bpo) * (Math.pow(2, 1 / (2 * bpo)) - Math.pow(2, -1 / (2 * bpo)));
    const binPos = new Float32Array(half);
    for (let k = 0; k < half; k++) binPos[k] = (Math.log2(Math.max(1, k) * binHz) - Math.log2(20)) * bpo;
    const NB = 61;
    let maxDb = -Infinity;
    const columns = cols.map(c => {
      const dens = c.map((v, b) => v + 10 * Math.log10(binHz / bw(b)));   // dB per bin
      const col = new Float32Array(half);
      for (let k = 0; k < half; k++) {
        const x = Math.max(0, Math.min(NS - 1, binPos[k])), b0 = Math.min(NS - 2, Math.floor(x)), f = x - b0;
        const v = dens[b0] * (1 - f) + dens[b0 + 1] * f; col[k] = v; if (v > maxDb) maxDb = v;
      }
      return col;
    });
    out.spec = { columns, fs, fftSize, maxDb, duration: dur };
    out.specImage = null;
    // vectorscope: points scattered through each cell of the density map, ~30,000 in all
    const size = o.vectorscope.size || 128, cells = Array.isArray(o.vectorscope.cells) ? o.vectorscope.cells : [];
    const total = cells.reduce((a, c) => a + c[1], 0) || 1, xs = [], ys = [];
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    cells.forEach(([i, c]) => {
      const cx = i % size, cy = Math.floor(i / size), k = Math.round(c / total * 30000);
      for (let j = 0; j < k; j++) { xs.push((cx + rnd()) / size * 2 - 1); ys.push((cy + rnd()) / size * 2 - 1); }
    });
    out.vs = { xs: Float32Array.from(xs), ys: Float32Array.from(ys) };
    // stereo width by frequency, one point per 1/6-octave band
    if (o.stereoBands && Array.isArray(o.stereoBands.midDb)) {
      const md = o.stereoBands.midDb, sd = o.stereoBands.sideDb, freqBins = new Float32Array(NB), widthPct = new Float32Array(NB), energyDb = new Float32Array(NB);
      let maxE = -Infinity;
      for (let b = 0; b < NB; b++) {
        const m = Math.pow(10, md[b] / 10), sd2 = Math.pow(10, sd[b] / 10), t = m + sd2;
        freqBins[b] = 20 * Math.pow(2, b / 6); widthPct[b] = t > 0 ? sd2 / t * 100 : 0; energyDb[b] = 10 * Math.log10(t || 1e-20); maxE = Math.max(maxE, energyDb[b]);
      }
      Object.assign(sf, { freqBins, widthPct, energyDb, maxEnergyDb: maxE, fs });
    }
    if (o.transients && Array.isArray(o.transients.hitTimesSec)) {
      const t = o.transients, num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
      out.trans = { hitCount: t.hitCount, hitVsRmsDb: num(t.hitVsRmsDb), kickDecay: num(t.kickDecay), kickRiseDb: num(t.kickRiseDb), kickSeparable: num(t.kickSeparable) || 0,
                    bassDecay: num(t.bassDecay), bassRiseDb: num(t.bassRiseDb), clickDecay: num(t.clickDecay), lowVsMidDb: num(t.lowVsMidDb), hitTimesSec: t.hitTimesSec.slice() };
    }
    if (o.peaks && Array.isArray(o.peaks.list)) {
      const p = o.peaks, CAT = ['hits', 'kickbass', 'low', 'other'];
      out.peaks = { counts: p.counts, shares: p.shares, dominant: p.dominant, events: p.events, cutDb: p.cutDb, pctAbove: p.pctAbove, eventsPerMin: p.eventsPerMin,
                    list: p.list.map(([t, c]) => ({ t, cat: CAT[c] || 'other', idx: Math.round(t * fs), ch: 0 })) };
    }
    if (o.louder) {
      const Lo = o.louder;
      if (Lo.budget && Array.isArray(Lo.budget.bands)) {
        const bands = Lo.budget.bands.map(b => ({ ...b, ratio: b.peakShare / Math.max(0.005, b.loudShare) }));
        out.louder = { budget: { bands, peaksUsed: Lo.budget.peaksUsed,
          costly: bands.filter(b => b.peakShare >= 0.1 && b.ratio >= 1.8).sort((a, b) => (b.peakShare - b.loudShare) - (a.peakShare - a.loudShare)),
          efficient: bands.filter(b => b.loudShare >= 0.1 && b.ratio <= 0.6).sort((a, b) => (b.loudShare - b.peakShare) - (a.loudShare - a.peakShare)) },
          moves: Lo.moves ? { target: Lo.moves.target, base: Lo.moves.base, moves: Lo.moves.moves.map(m => ({ ...m, hitShare: (bands.find(b => b.key === m.key) || {}).hitShare ?? null })) } : null };
      }
      if (Lo.eqMoves && Array.isArray(Lo.eqMoves.moves))
        out.eqMoves = { target: Lo.eqMoves.target, base: Lo.eqMoves.base, moves: Lo.eqMoves.moves.map(m => ({ ...(DSP.MIX_MOVES.find(x => x.key === m.key) || {}), ...m })) };
    }
    return out;
  }
  function openMeterSong(o, fileName) {
    const r = o.result || {}, st = o.stereo || {}, n = v => (typeof v === 'number' && isFinite(v)) ? v : NaN;
    let tone;
    try { tone = meterTone(o.toneDbPinkFlat.map((_, b) => 20 * Math.pow(2, b / 6)), o.toneDbPinkFlat, o.toneRanges); }
    catch (e) { return toast('That Meter export couldn’t be read.'); }
    const I = n(r.integratedLufs), tp = n(r.truePeakDbtp);
    if (!isFinite(I)) return toast('That Meter export has no loudness reading.');
    stopEverything();
    if (currentView === 'session') showView('landing');
    // short-term every 100 ms, as MasterScope keeps it (each value placed at the start of its 3 s window)
    const raw = Array.isArray(o.shortTermEvery100ms) ? o.shortTermEvery100ms : [];
    const shortTerm = Float32Array.from(raw.slice(29), v => (typeof v === 'number' && v > -69.9) ? v : NaN);
    const dur = isFinite(n(r.secondsMeasured)) ? n(r.secondsMeasured) : raw.length / 10;
    const name = String(o.song || '').trim() || fileName.replace(/\.json$/i, '').replace(/\s*-?\s*MasterScope Meter$/i, '').replace(/Measurement$/i, '').trim() || 'Measured song';
    S.buffer = { duration: dur, sampleRate: n((o.capture || {}).sampleRate) || 48000, numberOfChannels: 2, length: Math.round(dur * 48000), getChannelData: () => new Float32Array(0), meter: true };
    S.fileName = name; S.fileInfo = { format: 'MasterScope Meter' };
    S.selection = null; S.quietRegions = []; S.adjusted = null; S.mastered = null;
    S.loud = { integrated: I, lra: n(r.lraLu), maxShortTerm: n(r.maxShortTermLufs), maxMomentary: n(r.maxMomentaryLufs), shortTerm, momentary: new Float32Array(0), hopSec: 0.1 };
    S.tp = { truePeakDb: tp }; S.codec = n(o.codecPeakDbtp);
    S.levels = { samplePeakDb: n(r.samplePeakDbfs), rmsDb: n(r.samplePeakDbfs) - n(r.crestDb), crest: n(r.crestDb), clippedSamples: 0, clipPct: 0, dcOffset: 0 };
    S.tone = tone; S.specBars = tone.bars(20, 20000, 140);
    S.sf = { overallWidth: n(st.widthPct), bassWidth: n(st.bassWidthPct), lowWidth: n(st.lowWidthPct), lowPeakWidth: n(st.lowPeakWidthPct), lowPeakFreq: n(st.lowPeakHz) || 0, sub60: n(st.sub60WidthPct) };
    S.corr = n(st.correlation); S.vs = null; S.spec = null; S.specImage = null; S.trans = null; S.peaks = null; S.louder = null; S.eqMoves = null; S.mono = null;
    const detail = meterDetail(o, dur, S.sf);
    if (detail) Object.assign(S, detail);
    if (S.ref && !S.ref.buffer) { S.ref.bars = refBarsFor(S.ref); }
    const L = S.loud, T = S.tone, lv = S.levels, sf = S.sf;
    S.metrics = {
      lufs: L.integrated, lra: L.lra, maxShortTerm: L.maxShortTerm, maxMomentary: L.maxMomentary,
      truePeak: tp, codecPeak: S.codec, samplePeak: lv.samplePeakDb, rms: lv.rmsDb, crest: lv.crest,
      plr: isFinite(n(r.plr)) ? n(r.plr) : tp - I,
      tilt: T.tilt, lowMidPresenceGap: T.lowMidPresenceGap, subBassGap: T.subBassGap, lowMidBump: T.lowMidBump, airGap: T.airGap,
      corr: S.corr, width: sf.overallWidth, bassWidth: sf.bassWidth, lowWidth: sf.lowWidth, lowPeakWidth: sf.lowPeakWidth, lowPeakFreq: sf.lowPeakFreq,
      clippedSamples: 0, clipPct: 0, dcOffset: 0, transient: S.trans, peaks: S.peaks, louder: S.louder, eqMoves: S.eqMoves,
      limited: DSP.looksLimited(tp - I, S.peaks), dips: DSP.energyDips(L, dur), hotspots: DSP.peakHotspots(S.peaks ? S.peaks.list : null, dur),
    };
    S.findings = DSP.findings(S.metrics);
    setMeterSongMode(Object.assign(o, { detail: !!detail }));
    if (isFinite(S.corr)) setCorr(S.corr);
    renderAll();
    showView('app');
    setTab(['tools'].includes(S.activeTab) || !S.activeTab ? 'overview' : S.activeTab);
    window.scrollTo(0, 0);
  }
  function refFromUrl() {
    const p = new URLSearchParams(location.search).get('ref');
    if (!p) return null;
    try {
      let b = p.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
      const bytes = Uint8Array.from(atob(b), c => c.charCodeAt(0));
      const o = JSON.parse(new TextDecoder().decode(bytes));
      return cleanRef({ name: o.n, lufs: o.i, tp: o.tp, plr: o.plr, lra: o.lra, maxShort: o.ms, source: 'meter' });
    } catch (e) { return null; }
  }
  function setMeterRef(r, announce) {
    S.meterRef = cleanRef(r);
    try { if (S.meterRef) localStorage.setItem(REF_KEY, JSON.stringify(S.meterRef)); else localStorage.removeItem(REF_KEY); } catch (e) {}
    renderRefBanner(); renderMeterRef();
    if (S.metrics) { renderPeaksDensity(); renderReadiness(); renderReleaseReady(); }
    if (announce && S.meterRef) toast(S.metrics ? `Comparing with ${S.meterRef.name}: see the Compare tab.` : `Reference loaded: ${S.meterRef.name}. Drop your track to compare.`, 4500);
  }
  // One line comparing this track with the reference numbers (Overview, report, PDF)
  function meterRefLine(m, r) {
    if (!m || !r || !isFinite(m.plr) || !isFinite(r.plr)) return '';
    const dp = m.plr - r.plr;
    return Math.abs(dp) <= 1.5 ? `Your density is close to it (PLR ${fmt(m.plr)} against ${fmt(r.plr)}): they'll sit well together.`
      : dp > 0 ? `Yours is ${fmt(dp)} dB more dynamic (PLR ${fmt(m.plr)} against ${fmt(r.plr)}), so it will sound smaller next to it at the same loudness.`
      : `Yours is ${fmt(-dp)} dB denser (PLR ${fmt(m.plr)} against ${fmt(r.plr)}), so it may sound flatter next to it at the same loudness.`;
  }
  function refPlr() { return S.ref ? S.ref.sum.plr : (S.meterRef ? S.meterRef.plr : NaN); }
  function renderRefBanner() {
    const el = $('lpRefBanner'); if (!el) return;
    const r = S.meterRef;
    el.classList.toggle('hidden', !r);
    if (!r) { el.innerHTML = ''; return; }
    el.innerHTML = `Comparing with <b>${esc(r.name)}</b> (${fmt(r.lufs)} LUFS, PLR ${fmt(r.plr)}) from ${r.source === 'browser' ? 'your measurement' : 'MasterScope Meter'}. Drop your track to see how yours compares.<button type="button" id="lpRefClear">Remove</button>`;
    $('lpRefClear').addEventListener('click', () => setMeterRef(null));
  }
  function renderMeterRef() {
    const el = $('meterRefPanel'); if (!el) return;
    const r = S.ref && S.ref.meter ? null : S.meterRef;
    el.classList.toggle('hidden', !r);
    if (!r) { el.innerHTML = ''; return; }
    const m = S.metrics;
    const row = (label, mine, ref, unit, d = 1) => `<tr><td>${label}</td><td>${m ? fmt(mine, d) + ' ' + unit : '—'}</td><td>${fmt(ref, d)} ${unit}</td><td class="refdiff">${m && isFinite(mine) && isFinite(ref) ? fmtSigned(mine - ref, d) : ''}</td></tr>`;
    let verdict = '';
    if (m && isFinite(m.plr) && isFinite(r.plr)) {
      const dp = m.plr - r.plr;
      verdict = `<p>Streaming services turn loud songs down to about −14 LUFS, so loudness isn't the difference listeners hear: density is. `;
      verdict += Math.abs(dp) <= 1.5 ? `Your density is close to <b>${esc(r.name)}</b> (PLR ${fmt(m.plr)} against ${fmt(r.plr)}), so they'll sit well together.`
        : dp > 0 ? `Yours is <b>${fmt(dp)} dB more dynamic</b> (PLR ${fmt(m.plr)} against ${fmt(r.plr)}), so it will sound smaller next to it. To match it, limit a little harder: in Liminal, Learn by density at PLR ${fmt(Math.max(5, r.plr))}.`
        : `Yours is <b>${fmt(-dp)} dB denser</b> (PLR ${fmt(m.plr)} against ${fmt(r.plr)}), so it may sound flatter and more tiring next to it. Easing off the limiting would bring back some punch.`;
      if (isFinite(m.lufs) && m.lufs < -15.5) verdict += ` At ${fmt(m.lufs)} LUFS yours is also quiet enough to play quieter than it on most services, which only turn quiet songs up a little or not at all.`;
      verdict += '</p>';
    }
    el.innerHTML = `<div class="panel-head"><h2>Reference numbers</h2><div class="actions"><button class="btn sm ghost" id="meterRefClear">Remove</button></div></div>
      <p class="status-line">${r.source === 'browser' ? 'Measured in this browser' : 'From MasterScope Meter'}: <b>${esc(r.name)}</b>${m ? '' : '. Drop your track to compare.'}</p>
      ${verdict}
      <div class="table-wrap"><table class="data meterref-table"><thead><tr><th></th><th>Yours</th><th>${esc(r.name)}</th><th>Difference</th></tr></thead><tbody>
      ${row('Loudness', m && m.lufs, r.lufs, 'LUFS')}${row('True peak', m && m.truePeak, r.tp, 'dBTP')}${row('PLR (density)', m && m.plr, r.plr, 'dB')}
      ${row('Loudness range', m && m.lra, r.lra, 'LU')}${row('Loudest moment', m && m.maxShortTerm, r.maxShort, 'LUFS')}</tbody></table></div>`;
    $('meterRefClear').addEventListener('click', () => setMeterRef(null));
  }
  {
    const fromUrl = refFromUrl();
    if (fromUrl) { history.replaceState(null, '', location.pathname + location.hash); setMeterRef(fromUrl, true); }
    else { try { S.meterRef = cleanRef(JSON.parse(localStorage.getItem(REF_KEY) || 'null')); } catch (e) { S.meterRef = null; } renderRefBanner(); }
  }

  // ===================================================================
  // Measure a song playing on this computer: Chrome and Edge on Windows can
  // share the computer's sound with the page. It's measured in memory and
  // dropped: nothing is saved or uploaded, and it can't be played back.
  // ===================================================================
  const Live = { stream: null, ctx: null, proc: null, L: [], R: [], fs: 48000, frames: 0, timer: 0 };
  function liveCard(html) { $('liveCard').innerHTML = html; $('liveModal').classList.remove('hidden'); }
  function closeLive() { stopLiveCapture(); Live.L = []; Live.R = []; $('liveModal').classList.add('hidden'); }
  function stopLiveCapture() {
    clearInterval(Live.timer);
    if (Live.proc) { try { Live.proc.disconnect(); } catch (e) {} Live.proc.onaudioprocess = null; }
    if (Live.stream) Live.stream.getTracks().forEach(t => t.stop());
    if (Live.ctx) { try { Live.ctx.close(); } catch (e) {} }
    Live.proc = Live.stream = Live.ctx = null;
  }
  function liveHelp(reason) {
    liveCard(`<h2 id="liveTitle">Measure a song playing on this computer</h2>
      <p>${reason}</p>
      <ol><li><b>Most accurate:</b> open the song in the <b>Spotify web player</b> (<a href="https://open.spotify.com" target="_blank" rel="noopener">open.spotify.com</a>) or on YouTube, in another tab of Chrome or Edge.</li>
      <li>Press <b>Start</b>, pick that tab under <b>Chrome tab</b>, and keep <b>Also share tab audio</b> on. The tab's sound comes straight from the browser, before any laptop sound effects.</li>
      <li>Set the player's own volume to 100% and play the song from the start. The Spotify web player never normalises, so there's nothing to switch off; in the Spotify app, turn off <i>Normalise volume</i>.</li></ol>
      <p class="small muted">Using the Spotify app instead? Choose <b>Entire screen</b> and tick <b>Also share system audio</b> (Windows only). That's measured after your computer's sound effects (Waves, Dolby, Realtek), which can change the reading.</p>
      <p>Or get <a href="/meter/">MasterScope Meter</a>, the free Windows app that measures without any of this.</p>
      <div class="live-actions"><button class="btn primary" id="liveStart">Start</button><button class="btn ghost" id="liveClose">Close</button></div>`);
    $('liveStart').addEventListener('click', startLive);
    $('liveClose').addEventListener('click', closeLive);
  }
  function liveShortTerm() {
    const need = Math.round(3 * Live.fs);
    const take = (arr) => { const out = new Float32Array(Math.min(need, Live.frames)); let pos = out.length; for (let i = arr.length - 1; i >= 0 && pos > 0; i--) { const c = arr[i]; const n = Math.min(c.length, pos); out.set(c.subarray(c.length - n), pos - n); pos -= n; } return out; };
    const l = take(Live.L), r = take(Live.R);
    if (l.length < Live.fs * 0.4) return -Infinity;
    let sum = 0; const kl = DSP.kWeightChannel(l, Live.fs), kr = DSP.kWeightChannel(r, Live.fs);
    for (let i = 0; i < kl.length; i++) sum += kl[i] * kl[i] + kr[i] * kr[i];
    const ms = sum / kl.length;
    return ms > 1e-10 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
  }
  async function startLive() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return liveHelp('This browser can\'t share the computer\'s sound.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false });
    } catch (e) { return; }
    const audio = stream.getAudioTracks();
    const vt = stream.getVideoTracks()[0];
    Live.surface = vt && vt.getSettings ? (vt.getSettings().displaySurface || '') : '';
    stream.getVideoTracks().forEach(t => t.stop());
    if (!audio.length) { stream.getTracks().forEach(t => t.stop()); return liveHelp('No sound was shared. Pick the tab playing the song and keep <b>Also share tab audio</b> on (or <b>Entire screen</b> with <b>Also share system audio</b>).'); }
    stopEverything();
    Live.stream = stream; Live.L = []; Live.R = []; Live.frames = 0;
    Live.ctx = new (window.AudioContext || window.webkitAudioContext)();
    Live.fs = Live.ctx.sampleRate;
    const src = Live.ctx.createMediaStreamSource(new MediaStream(audio));
    Live.proc = Live.ctx.createScriptProcessor(4096, 2, 2);
    Live.proc.onaudioprocess = e => {
      const b = e.inputBuffer, l = b.getChannelData(0);
      Live.L.push(new Float32Array(l)); Live.R.push(new Float32Array(b.numberOfChannels > 1 ? b.getChannelData(1) : l));
      Live.frames += l.length;
      if (Live.frames > Live.fs * 900) stopLive();          // 15 minutes is plenty for a song
    };
    const mute = Live.ctx.createGain(); mute.gain.value = 0;
    src.connect(Live.proc); Live.proc.connect(mute); mute.connect(Live.ctx.destination);
    audio[0].addEventListener('ended', () => { if (Live.proc) stopLive(); });
    liveCard(`<h2 id="liveTitle">Measuring what's playing</h2>
      <p>Play the song from the start, then press <b>Stop</b> at the end. Only numbers are kept, never the audio.</p>
      <div class="live-big"><span class="v" id="liveVal">—</span><span class="u">LUFS short-term</span></div>
      <p class="status-line" id="liveTime">0:00</p>
      <div class="live-actions"><button class="btn primary" id="liveStop">Stop</button><button class="btn ghost" id="liveCancel">Cancel</button></div>`);
    $('liveStop').addEventListener('click', stopLive);
    $('liveCancel').addEventListener('click', closeLive);
    Live.timer = setInterval(() => {
      const st = liveShortTerm();
      $('liveVal').textContent = isFinite(st) ? fmt(st) : '—';
      $('liveTime').textContent = fmtTime(Live.frames / Live.fs) + (isFinite(st) ? '' : '  ·  waiting for sound');
    }, 500);
  }
  function stopLive() {
    const fs = Live.fs, frames = Live.frames, L = Live.L, R = Live.R;
    stopLiveCapture();
    Live.L = []; Live.R = [];
    if (frames < fs * 5) return liveHelp('That was too short to measure: play at least a few seconds.');
    const ctx = new OfflineAudioContext(2, frames, fs);
    const buf = ctx.createBuffer(2, frames, fs);
    let pos = 0;
    for (let i = 0; i < L.length; i++) { buf.getChannelData(0).set(L[i], pos); buf.getChannelData(1).set(R[i], pos); pos += L[i].length; }
    const loud = DSP.loudness(buf), tp = DSP.truePeak(buf).truePeakDb;
    if (!isFinite(loud.integrated)) return liveHelp('No sound was measured. Check the song was playing and its sound was shared. Chrome may hold back protected audio from some players: if the Spotify web player measured nothing, try the song on YouTube, or Entire screen with system audio.');
    const res = { name: 'Song measured ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), lufs: loud.integrated, tp, plr: tp - loud.integrated,
                  lra: loud.lra, maxShort: loud.maxShortTerm, source: 'browser' };
    const plat = REF_PLATFORMS.map(([n, t, up]) => { const a = platformText(t, up, res.lufs, res.tp); return `<tr><td>${n}</td><td class="${a.down ? 'down' : ''}">${a.text}</td></tr>`; }).join('');
    liveCard(`<h2 id="liveTitle">The song you measured</h2>
      <div class="live-big"><span class="v">${fmt(res.lufs)}</span><span class="u">LUFS integrated · ${fmtTime(frames / fs)}</span></div>
      <p>${densityVerdict(res.plr)}</p>
      <div class="live-tiles"><div><span>True peak</span><b>${fmt(res.tp)} dBTP</b></div><div><span>PLR (density)</span><b>${fmt(res.plr)} dB</b></div>
        <div><span>Loudness range</span><b>${fmt(res.lra)} LU</b></div><div><span>Loudest moment</span><b>${fmt(res.maxShort)} LUFS</b></div></div>
      <h3 class="mini-h">What streaming does to it</h3><table class="live-plat"><tbody>${plat}</tbody></table>
      <p class="small muted">${Live.surface === 'browser' ? 'Measured straight from the browser tab, before any sound effects.' : 'Measured from the whole computer, after its sound effects: laptop processing (Waves, Dolby, Realtek) can change the reading. For an exact one, play the song in a browser tab and share that tab.'} Spotify's <i>Normalise volume</i> also changes it, so keep it off.</p>
      <div class="live-actions"><button class="btn primary" id="liveUse">Use as my reference</button><button class="btn" id="liveAgain">Measure another</button><button class="btn ghost" id="liveClose2">Close</button></div>`);
    $('liveUse').addEventListener('click', () => { setMeterRef(res, true); $('liveModal').classList.add('hidden'); });
    $('liveAgain').addEventListener('click', startLive);
    $('liveClose2').addEventListener('click', closeLive);
  }
  $('liveMeasureBtn').addEventListener('click', () => liveHelp('Measure the loudness, peaks and density of any song you play on Spotify, YouTube or anywhere on this computer.'));
  // iPhone, iPad and Android browsers can't share the device's sound, so don't offer it there
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { const l = $('liveMeasureBtn').closest('.lp-live'); if (l) l.classList.add('hidden'); }
  $('liveModal').addEventListener('click', e => { if (e.target === $('liveModal') && !Live.proc) closeLive(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('liveModal').classList.contains('hidden') && !Live.proc) closeLive(); });

  // expose a small hook for automated checks
  window.__masterscope = { S, setTab, openFile, DSP };
})();
