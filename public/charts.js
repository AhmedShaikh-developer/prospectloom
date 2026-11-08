// ProspectLoom charts — small, dependency-free SVG charts.
// Each chart is a placeholder <div class="chart" data-spec="…"> that hydrateCharts() draws at the
// container's real pixel width (crisp text at any size), with a hover layer and draw-in animation.
// Colors come from CSS custom properties (--s1…--s5, --brand, --ink…) so dark/light themes just work.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => Number(v || 0).toLocaleString();
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const shortDate = (k) => new Date(`${k}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

function niceMax(m) {
  if (m <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(m));
  const f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Monotone cubic path through points (no overshoot below zero). */
function smooth(pts) {
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
  const n = pts.length; const dx = []; const m = []; const t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${pts[i][0] + h},${pts[i][1] + h * t[i]} ${pts[i + 1][0] - h},${pts[i + 1][1] - h * t[i + 1]} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/** Placeholder markup; hydrateCharts() draws it. */
export function chart(spec, { height = 220, cls = '', label = '' } = {}) {
  return `<div class="chart ${cls}" style="height:${height}px" role="img" aria-label="${esc(label)}" data-spec="${esc(JSON.stringify(spec))}"></div>`;
}

// ---------------------------------------------------------------- drawing
function drawSeriesChart(el, spec) {
  const W = Math.max(240, el.clientWidth); const H = el.clientHeight || 220;
  const padL = spec.yAxis === false ? 8 : 38; const padR = 10; const padT = 14; const padB = spec.xAxis === false ? 6 : 26;
  const n = spec.labels.length;
  const series = spec.series;
  const stacked = spec.type === 'area' && spec.stacked !== false;
  const totals = spec.labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...series.map((s) => s.values[i] || 0))));
  const max = niceMax(Math.max(spec.min || 0, ...totals));
  const plotW = W - padL - padR; const plotH = H - padT - padB;
  const isBars = spec.type === 'bars';
  const band = plotW / n;
  const x = (i) => (isBars ? padL + band * i + band / 2 : padL + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1)));
  const y = (v) => padT + plotH * (1 - v / max);
  let svg = '';
  // recessive grid + y labels
  const ticks = [4, 5, 3].find((k) => Number.isInteger(max / k)) || 4; // whole-number gridlines
  for (let k = 0; k <= ticks; k++) {
    const v = (max / ticks) * k; const yy = y(v);
    svg += `<line class="gl" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
    if (spec.yAxis !== false) svg += `<text class="ax" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  // x labels (about 6)
  if (spec.xAxis !== false) {
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
    spec.labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) svg += `<text class="ax" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 && !isBars ? 'start' : i === n - 1 && !isBars ? 'end' : 'middle'}">${esc(spec.xFormat === 'date' ? shortDate(l) : l)}</text>`; });
  }
  if (isBars) {
    const k = series.length; const gap = 2;
    const bw = Math.max(2, Math.min(18, (band * 0.62 - gap * (k - 1)) / k));
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (!v) return;
        const bx = x(i) - (bw * k + gap * (k - 1)) / 2 + si * (bw + gap);
        const top = y(v); const base = y(0); const r = Math.min(4, bw / 2, base - top);
        svg += `<path class="bar-mark" style="--i:${i};fill:${s.color}" d="M${bx},${base}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${base}Z"/>`;
      });
    });
  } else {
    // stacked areas, bottom series first
    const base = spec.labels.map(() => 0);
    series.forEach((s) => {
      const lower = base.slice();
      const upper = s.values.map((v, i) => (stacked ? lower[i] + (v || 0) : v || 0));
      const top = upper.map((v, i) => [x(i), y(v)]);
      const bottom = lower.map((v, i) => [x(i), y(stacked ? v : 0)]).reverse();
      const topPath = spec.step ? stepPath(top) : smooth(top);
      const botPath = spec.step ? stepPath(bottom) : smooth(bottom);
      svg += `<path class="area-mark" style="fill:${s.color}" d="${topPath}L${bottom[0][0]},${bottom[0][1]}${botPath.replace(/^M[-\d.e]+,[-\d.e]+/, '')}Z"/>`;
      svg += `<path class="line-mark" style="stroke:${s.color}" d="${topPath}"/>`;
      if (stacked) upper.forEach((v, i) => { base[i] = v; });
    });
    if (spec.marker != null) {
      const mx = x(spec.marker);
      svg += `<line class="marker" x1="${mx}" x2="${mx}" y1="${padT}" y2="${padT + plotH}"/><text class="ax marker-t" x="${mx + 6}" y="${padT + 10}">${esc(spec.markerLabel || 'today')}</text>`;
    }
    for (const a of spec.annotations || []) {
      const ax = x(a.i); const ay = y(a.v);
      svg += `<circle class="dot" cx="${ax}" cy="${ay}" r="4" style="fill:${a.color || series[0].color}"/><text class="ax ann" x="${Math.min(ax + 8, W - padR - 4)}" y="${ay - 8}" text-anchor="${ax > W - 120 ? 'end' : 'start'}">${esc(a.text)}</text>`;
    }
  }
  svg += `<line class="xhair" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" opacity="0"/>`;
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg><div class="viz-tip" hidden></div>`
    + `<div class="sr-only"><table><thead><tr><th>${esc(spec.xTitle || 'Date')}</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr></thead><tbody>${spec.labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td>${s.values[i] || 0}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  animateMarks(el);
  // hover: nearest index → crosshair + tooltip (hit area is the whole plot, larger than any mark)
  const svgEl = el.querySelector('svg'); const tip = el.querySelector('.viz-tip'); const xh = el.querySelector('.xhair');
  const show = (ev) => {
    const r = svgEl.getBoundingClientRect(); const px = ev.clientX - r.left;
    const i = Math.max(0, Math.min(n - 1, isBars ? Math.floor((px - padL) / band) : Math.round(((px - padL) / plotW) * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('opacity', '1');
    const head = spec.xFormat === 'date' ? new Date(`${spec.labels[i]}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : spec.labels[i];
    const rows = series.map((s) => `<div class="tip-row"><span class="sw" style="background:${s.color}"></span><span>${esc(s.label)}</span><strong>${fmt(s.values[i])}${spec.unit || ''}</strong></div>`).join('');
    const total = series.length > 1 && stacked ? `<div class="tip-row tot"><span></span><span>Total</span><strong>${fmt(totals[i])}</strong></div>` : '';
    tip.innerHTML = `<div class="tip-h">${esc(head)}</div>${rows}${total}`;
    tip.hidden = false;
    const tx = x(i) + 14 + tip.offsetWidth > W ? x(i) - tip.offsetWidth - 14 : x(i) + 14;
    tip.style.transform = `translate(${tx}px, ${padT}px)`;
  };
  svgEl.addEventListener('mousemove', show);
  svgEl.addEventListener('mouseleave', () => { tip.hidden = true; xh.setAttribute('opacity', '0'); });
}

function stepPath(pts) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) d += `H${pts[i][0]}V${pts[i][1]}`;
  return d;
}

function drawSpark(el, spec) {
  const W = Math.max(60, el.clientWidth); const H = el.clientHeight || 36; const v = spec.values;
  const max = Math.max(1, ...v); const n = v.length;
  const pts = v.map((val, i) => [2 + (i * (W - 4)) / Math.max(1, n - 1), H - 3 - (val / max) * (H - 8)]);
  const line = smooth(pts);
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="spark-area" style="fill:${spec.color}" d="${line}L${pts[n - 1][0]},${H}L${pts[0][0]},${H}Z"/><path class="line-mark spark" style="stroke:${spec.color}" d="${line}"/><circle cx="${pts[n - 1][0]}" cy="${pts[n - 1][1]}" r="2.6" style="fill:${spec.color}"/></svg>`;
  animateMarks(el);
}

/** Semicircle gauge: value in [0, max] with status bands. */
function drawGauge(el, spec) {
  const W = Math.max(180, el.clientWidth); const H = el.clientHeight || 150;
  const r = Math.min(W / 2 - 12, H - 22); const cx = W / 2; const cy = H - 12;
  const frac = Math.max(0, Math.min(1, spec.value / spec.max));
  const arc = (f) => { const a = Math.PI * (1 - f); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const [sx, sy] = arc(0); const [ex, ey] = arc(1); const [vx, vy] = arc(frac);
  const track = `M${sx},${sy}A${r},${r} 0 0 1 ${ex},${ey}`;
  const val = frac > 0 ? `M${sx},${sy}A${r},${r} 0 0 1 ${vx},${vy}` : '';
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path class="gauge-track" d="${track}"/>${val ? `<path class="gauge-val line-mark" style="stroke:${spec.color}" d="${val}"/>` : ''}<circle class="gauge-knob" cx="${vx}" cy="${vy}" r="7" style="stroke:${spec.color}"/></svg>`;
  animateMarks(el);
}

// ---------------------------------------------------------------- animation helpers
function animateMarks(el) {
  if (reduced()) return;
  el.querySelectorAll('.line-mark').forEach((p) => {
    const len = p.getTotalLength?.() || 0;
    if (!len) return;
    p.style.setProperty('--len', len);
    p.classList.add('draw');
  });
  el.querySelectorAll('.area-mark, .spark-area').forEach((p) => p.classList.add('fade-in'));
  el.querySelectorAll('.bar-mark').forEach((p) => p.classList.add('grow'));
}

const DRAW = { area: drawSeriesChart, line: drawSeriesChart, bars: drawSeriesChart, spark: drawSpark, gauge: drawGauge };

export function hydrateCharts(root = document) {
  root.querySelectorAll('.chart[data-spec]').forEach((el) => {
    try { const spec = JSON.parse(el.dataset.spec); (DRAW[spec.type] || drawSeriesChart)(el, spec); el.dataset.w = el.clientWidth; } catch (e) { el.textContent = ''; }
  });
}

let resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    document.querySelectorAll('.chart[data-spec]').forEach((el) => {
      if (String(el.clientWidth) === el.dataset.w) return;
      const spec = JSON.parse(el.dataset.spec); (DRAW[spec.type] || drawSeriesChart)(el, spec); el.dataset.w = el.clientWidth;
    });
  }, 150);
});

/** Count numbers up from 0 (elements with data-count). The final text is exactly toLocaleString(). */
export function countUp(root = document) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count); const suffix = el.dataset.suffix || ''; const dec = Number(el.dataset.dec || 0);
    const final = `${dec ? to.toFixed(dec) : fmt(to)}${suffix}`;
    if (reduced() || !Number.isFinite(to) || to === 0) { el.textContent = final; return; }
    const t0 = performance.now(); const dur = 900;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur); const e = 1 - (1 - p) ** 3;
      el.textContent = p < 1 ? `${dec ? (to * e).toFixed(dec) : fmt(Math.round(to * e))}${suffix}` : final;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Stagger the entrance of cards on a page. */
export function revealCards(root = document) {
  if (reduced()) return;
  [...root.querySelectorAll('.reveal')].forEach((el, i) => { el.style.setProperty('--i', i); el.classList.add('in'); });
}
