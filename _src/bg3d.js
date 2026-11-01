/* MasterScope: a faint 3D wave terrain behind every page. Drawn on one fixed canvas,
   about 30 frames a second, paused when the tab is hidden, still for reduced motion. */
(function () {
  'use strict';
  if (window.__msBg3d) return; window.__msBg3d = 1;
  const cv = document.createElement('canvas');
  cv.id = 'bg3d'; cv.setAttribute('aria-hidden', 'true');
  document.body.prepend(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ROWS = 34, COLS = 73, DEPTH = 34, SPAN = 40;
  let W = 0, H = 0, dpr = 1, last = 0, t0 = performance.now(), raf = 0;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  // gentle rolling hills, like a slow spectrum
  function height(x, z, t) {
    return 1.25 * Math.sin(x * 0.22 + t * 0.35 + z * 0.08) * Math.cos(z * 0.17 - t * 0.22)
         + 0.7 * Math.sin(x * 0.51 - z * 0.31 + t * 0.5)
         + 0.35 * Math.sin(x * 1.07 + z * 0.73 - t * 0.8);
  }
  function frame(now) {
    raf = 0;
    if (!still) schedule();
    if (now - last < 33 && !still) return;
    last = now;
    const t = (now - t0) / 1000;
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const rgb = light ? '70,60,120' : '150,140,255';
    const peak = light ? 0.18 : 0.26;
    ctx.clearRect(0, 0, W, H);
    const horizon = H * 0.46, camY = 1.5, f = Math.min(W, 1400) * 0.75;
    const scroll = (t * 1.2) % 1;              // the terrain flows towards you
    const pts = [];
    for (let r = 0; r < ROWS; r++) {
      const z = 2 + (r + 1 - scroll) * (DEPTH / ROWS);
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const x = (c / (COLS - 1) - 0.5) * SPAN;
        const y = height(x, z + t * 1.2, t);
        row.push([W / 2 + (x * f) / z, horizon + ((camY - y * 0.55) * f) / z / 1.0]);
      }
      pts.push([z, row]);
    }
    ctx.lineWidth = 1;
    // rows, far to near
    for (let r = ROWS - 1; r >= 0; r--) {
      const [z, row] = pts[r];
      const near = 1 - z / (DEPTH + 2);
      ctx.strokeStyle = `rgba(${rgb},${(peak * near * near).toFixed(3)})`;
      ctx.beginPath();
      row.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    // points where the columns cross, so it reads as a 3D mesh
    for (let r = ROWS - 1; r >= 0; r--) {
      const [z, row] = pts[r];
      const near = 1 - z / (DEPTH + 2), s = 0.6 + 1.6 * near;
      ctx.fillStyle = `rgba(${rgb},${(peak * 1.6 * near * near).toFixed(3)})`;
      for (let c = 0; c < COLS; c += 3) { const [x, y] = row[c]; ctx.fillRect(x - s / 2, y - s / 2, s, s); }
    }
  }
  function schedule() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }
  size();
  addEventListener('resize', () => { size(); if (still) frame(performance.now()); });
  document.addEventListener('visibilitychange', schedule);
  new MutationObserver(() => { if (still) frame(performance.now()); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (still) frame(performance.now()); else schedule();
})();
