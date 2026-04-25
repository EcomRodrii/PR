// ── KEYWORD LIST ──────────────────────────────────────────────────────────────
const KEYWORD_RACE = [
  'wayfarer','aviator','clubmaster','erika','justin','caravan','jack','round',
  'hexagonal','balorama','radar','holbrook','jawbreaker','sutro','frogskins',
  'flak','gascan','encoder','m frame','oakley',
];

// ── UTILITIES ─────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('es', { hour12: false });
}
function parseSearchUrlsInput(raw) {
  return [...new Set(
    String(raw || '').split('\n').map(v => v.trim()).filter(v => v.startsWith('https://www.vinted.es/'))
  )];
}
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function csvEscape(value) {
  const str = String(value == null ? '' : value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g,'""')}"` : str;
}
function exportRowsToCsv(items) {
  const headers = ['item_id','status','title','model','url','rank','detected_at',
    'last_check_at','sold_at','time_to_sell_min','price_current','price_sold',
    'likes','offers','views','snapshots'];
  const lines = [headers.join(',')];
  for (const item of items) {
    const l = item.latest || {};
    lines.push([item.itemId,item.status,item.title,item.modelName,item.url,
      item.firstSeenRank,item.detectedAt,l.checkedAt,item.soldAt,
      item.timeToSellMinutes,l.priceText,item.soldPriceText,
      l.likesCount,l.offersCount,l.viewsCount,
      Array.isArray(item.snapshots) ? item.snapshots.length : 0,
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `exofertas_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ── MESSAGE BUS ───────────────────────────────────────────────────────────────
async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

// ── DOM REFS ──────────────────────────────────────────────────────────────────
// Dashboard
const kpiTotal   = document.getElementById('kpi-total');
const kpiActive  = document.getElementById('kpi-active');
const kpiSold    = document.getElementById('kpi-sold');
const kpiExpired = document.getElementById('kpi-expired');
const maturityTimer = document.getElementById('maturity-timer');
const maturitySub   = document.getElementById('maturity-sub');
const monitorBadge  = document.getElementById('monitor-badge');
const dMonitor   = document.getElementById('d-monitor');
const dDetect    = document.getElementById('d-detect');
const dTrack     = document.getElementById('d-track');
const dErrRow    = document.getElementById('d-err-row');
const dError     = document.getElementById('d-error');
// Sidebar
const sdot       = document.getElementById('sdot');
const sdotLabel  = document.getElementById('sdot-label');
const snavBadge  = document.getElementById('snav-badge');
// Op fields
const productNameInput = document.getElementById('product-name');
const searchUrlsInput  = document.getElementById('search-urls');
const opItems    = document.getElementById('op-items');
const opCount    = document.getElementById('op-count');
// Analytics
const chartKeyword   = document.getElementById('chart-keyword-race');
const chartTopModels = document.getElementById('chart-top-models');
const chartRentable  = document.getElementById('chart-rentable-models');
const lastSalesEl    = document.getElementById('last-sales');
// System
const sysMonitor  = document.getElementById('sys-monitor');
const sysDetect   = document.getElementById('sys-detecting');
const sysTrack    = document.getElementById('sys-tracking');
const sysSession  = document.getElementById('sys-session');
const sysSessionAt= document.getElementById('sys-session-at');
const sysTotal    = document.getElementById('sys-total');
const sysSoldCount= document.getElementById('sys-sold-count');
const sysLastErr  = document.getElementById('sys-last-error');
// Report
const reportMsg = document.getElementById('report-msg');
// Templates
const itemTpl = document.getElementById('item-tpl');

// ── SECTION NAVIGATION ────────────────────────────────────────────────────────
const SECTIONS = ['dashboard','operaciones','analitica','sistema','reporte','cuenta'];
function showSection(id) {
  SECTIONS.forEach(s => {
    const sec = document.getElementById(`sec-${s}`);
    const btn = document.querySelector(`[data-sec="${s}"]`);
    if (sec) sec.classList.toggle('hidden', s !== id);
    if (btn) btn.classList.toggle('active', s === id);
  });
  // Cargar estado de vacaciones al entrar en la sección de cuenta
  if (id === 'cuenta') loadVacationStatus(true);
}
document.querySelectorAll('[data-sec]').forEach(btn => {
  btn.addEventListener('click', () => showSection(btn.dataset.sec));
});

// ── TERMINAL ──────────────────────────────────────────────────────────────────
const TERM = (() => {
  let _lines  = [];
  let _visible = false;
  let _mini    = false;
  let _prevItemCount  = 0;
  let _prevDetect     = null;
  let _prevTrack      = null;
  let _prevMonitor    = false;

  const el = () => document.getElementById('terminal');
  const body = () => document.getElementById('term-body');

  function _flush() {
    const b = body(); if (!b) return;
    const show = _lines.slice(-80);
    b.innerHTML = show.map(l =>
      `<div class="tl tl-${l.t}">[${l.hms}] >> ${escHtml(l.msg)}</div>`
    ).join('');
    b.scrollTop = b.scrollHeight;
  }

  function log(msg, t = 'normal') {
    const hms = new Date().toTimeString().slice(0,8);
    _lines.push({ hms, msg, t });
    if (_lines.length > 200) _lines.shift();
    if (_visible && !_mini) _flush();
  }

  function show() {
    _visible = true; _mini = false;
    const t = el(); if (!t) return;
    t.classList.remove('term-hidden','term-mini');
    t.classList.add('term-visible');
    _flush();
  }
  function hide() {
    _visible = false;
    const t = el(); if (!t) return;
    t.classList.remove('term-visible','term-mini');
    t.classList.add('term-hidden');
  }
  function mini() {
    _mini = true; _visible = true;
    const t = el(); if (!t) return;
    t.classList.remove('term-hidden');
    t.classList.add('term-visible','term-mini');
  }
  function toggle() { _visible ? hide() : show(); }

  function onStateUpdate(state, config, metrics) {
    const count   = Array.isArray(state?.items) ? state.items.length : 0;
    const detect  = metrics?.lastDetectRun || null;
    const track   = metrics?.lastTrackRun  || null;
    const running = config?.monitorEnabled === true;

    if (running && !_prevMonitor) {
      log(`Monitor iniciado — campaña: "${config?.productName || 'sin nombre'}"`, 'success');
      log(`URLs configuradas: ${Array.isArray(config?.searchUrls) ? config.searchUrls.length : 0}`, 'info');
      log(`Próximo ciclo en ~5 min. Esperando…`, 'info');
    } else if (!running && _prevMonitor) {
      log('Monitor detenido por el usuario.', 'warn');
    }

    if (detect && detect !== _prevDetect) {
      _prevDetect = detect;
      const diff = count - _prevItemCount;
      if (diff > 0) {
        log(`Ciclo de detección — ${diff} artículo(s) nuevo(s) añadidos`, 'success');
      } else {
        log('Ciclo de detección completado — sin artículos nuevos', 'normal');
      }
    }
    if (track && track !== _prevTrack) {
      _prevTrack = track;
      const sold = Array.isArray(state?.items) ? state.items.filter(i => i.status === 'sold').length : 0;
      log(`Ciclo de análisis completado — ${sold} vendidos acumulados`, 'info');
    }

    _prevItemCount = count;
    _prevMonitor   = running;
  }

  return { log, show, hide, mini, toggle, onStateUpdate };
})();

// Terminal controls
document.getElementById('term-toggle')?.addEventListener('click', () => TERM.toggle());
document.getElementById('exo-term-btn')?.addEventListener('click', () => TERM.show());
document.getElementById('term-close')?.addEventListener('click', () => TERM.hide());
document.getElementById('term-min')?.addEventListener('click',   () => TERM.mini());

// ── MATURITY COUNTDOWN ────────────────────────────────────────────────────────
let _matInterval = null;
let _matTarget   = null;
let _matTitle    = '';

function startMaturity(items) {
  const active = (items || []).filter(i => i.status === 'active' || i.status === 'reserved');
  if (!active.length) {
    if (_matInterval) { clearInterval(_matInterval); _matInterval = null; }
    if (maturityTimer) maturityTimer.textContent = '--:--:--';
    if (maturitySub)   maturitySub.textContent   = 'Sin artículos activos';
    return;
  }
  // Oldest active item = first to expire (detectedAt + 24h)
  const oldest = active.reduce((a, b) =>
    new Date(a.detectedAt || 0) < new Date(b.detectedAt || 0) ? a : b
  );
  const expireAt = new Date(oldest.detectedAt).getTime() + 24 * 60 * 60 * 1000;
  _matTarget = expireAt;
  _matTitle  = oldest.title || `Item ${oldest.itemId}`;

  if (_matInterval) clearInterval(_matInterval);
  function tick() {
    const rem = _matTarget - Date.now();
    if (rem <= 0) {
      if (maturityTimer) maturityTimer.textContent = '00:00:00';
      if (maturitySub)   maturitySub.textContent   = 'Expirado';
      clearInterval(_matInterval); _matInterval = null;
      return;
    }
    const h = Math.floor(rem / 3600000).toString().padStart(2, '0');
    const m = Math.floor((rem % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((rem % 60000) / 1000).toString().padStart(2, '0');
    if (maturityTimer) maturityTimer.textContent = `${h}:${m}:${s}`;
    if (maturitySub)   maturitySub.textContent   = `Próximo: ${_matTitle.slice(0, 32)}${_matTitle.length > 32 ? '…' : ''}`;
  }
  tick();
  _matInterval = setInterval(tick, 1000);
}

// ── MONITOR UI STATE ──────────────────────────────────────────────────────────
function setMonitorUi(config) {
  const on = config?.monitorEnabled === true;
  // Dashboard buttons
  const dStart = document.getElementById('dash-start');
  const dStop  = document.getElementById('dash-stop');
  if (dStart) { dStart.disabled = on; }
  if (dStop)  { dStop.disabled  = !on; }
  // Ops buttons
  const oStart = document.getElementById('start-monitor');
  const oStop  = document.getElementById('stop-monitor');
  if (oStart) { oStart.disabled = on; oStart.classList.toggle('is-running', on); }
  if (oStop)  { oStop.disabled  = !on; }
  // Badge + sidebar dot
  if (monitorBadge) {
    monitorBadge.textContent = on ? 'ACTIVO' : 'IDLE';
    monitorBadge.className   = `badge ${on ? 'badge-active' : 'badge-idle'}`;
  }
  if (sdot) {
    sdot.className = `sdot ${on ? 'sdot-active' : 'sdot-idle'}`;
  }
  if (sdotLabel) {
    sdotLabel.textContent = on ? `Activo — ${config?.productName || 'campaña'}` : 'Sistema inactivo';
  }
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render(state, config) {
  const items   = Array.isArray(state?.items) ? state.items : [];
  const metrics = state?.metrics || {};

  setMonitorUi(config || {});

  // Sync input fields (only if different)
  if (typeof config?.productName === 'string' && productNameInput.value !== config.productName)
    productNameInput.value = config.productName;
  const cfgUrls = Array.isArray(config?.searchUrls) ? config.searchUrls : (config?.searchUrl ? [config.searchUrl] : []);
  if (searchUrlsInput.value.trim() !== cfgUrls.join('\n').trim())
    searchUrlsInput.value = cfgUrls.join('\n');

  // KPIs
  const activeItems  = items.filter(i => i.status === 'active' || i.status === 'reserved');
  const soldItems    = items.filter(i => i.status === 'sold');
  kpiTotal.textContent   = String(metrics.totalDetected || 0);
  kpiActive.textContent  = String(activeItems.length);
  kpiSold.textContent    = String(soldItems.length);
  kpiExpired.textContent = String(metrics.totalExpired || 0);

  // Maturity
  startMaturity(items);

  // Dashboard info
  const on = config?.monitorEnabled;
  dMonitor.textContent = on ? `Activo — "${config?.productName || 'sin nombre'}"` : 'Detenido';
  dDetect.textContent  = metrics.lastDetectRun ? fmtDate(metrics.lastDetectRun) : '—';
  dTrack.textContent   = metrics.lastTrackRun  ? fmtDate(metrics.lastTrackRun)  : '—';
  if (metrics.lastError) {
    dErrRow.style.display = '';
    dError.textContent = String(metrics.lastError).slice(0, 80);
    // card border on error
    sdot.className = 'sdot sdot-error';
  } else {
    dErrRow.style.display = 'none';
  }

  // Op items badge
  if (snavBadge) {
    snavBadge.textContent = String(activeItems.length);
    snavBadge.style.display = activeItems.length > 0 ? '' : 'none';
  }
  if (opCount) opCount.textContent = String(items.length);

  // ExOfertas items list
  renderItemList(opItems, items.slice(0, 120));

  // Analytics
  renderAnalytics(items, metrics);

  // System
  sysMonitor.textContent  = on ? '● Activo' : '○ Detenido';
  sysMonitor.style.color  = on ? 'var(--green)' : 'var(--muted)';
  sysDetect.textContent   = metrics.detectRunning  ? '● En curso' : '○ Inactivo';
  sysTrack.textContent    = metrics.trackRunning   ? '● En curso' : '○ Inactivo';
  sysSession.textContent  = metrics.sessionStatus  || '—';
  sysSessionAt.textContent= metrics.sessionRefreshedAt ? fmtDate(metrics.sessionRefreshedAt) : '—';
  sysTotal.textContent    = String(metrics.totalDetected || 0);
  sysSoldCount.textContent= String(soldItems.length);
  sysLastErr.textContent  = metrics.lastError || 'Ninguno';

  // Terminal state sync
  TERM.onStateUpdate(state, config, metrics);
}

// ── ITEMS ─────────────────────────────────────────────────────────────────────
function renderItemList(container, items) {
  if (!container) return;
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No hay artículos todavía.</div>';
    return;
  }
  const sorted = [...items].sort((a, b) => {
    const order = { active: 0, reserved: 1, sold: 2, expired: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });
  for (const item of sorted) {
    const node = itemTpl.content.firstElementChild.cloneNode(true);
    const link = node.querySelector('.item-link');
    const meta = node.querySelector('.item-meta');
    link.href = item.url;
    link.textContent = item.title || `Item ${item.itemId}`;
    if (item.status === 'sold')    node.classList.add('item-sold');
    if (item.status === 'expired') node.style.opacity = '0.55';
    const l = item.latest || {};
    const lines = [
      `Estado: ${item.status}  |  Modelo: ${item.modelName || '—'}`,
      `Precio: ${l.priceText ?? '—'}  |  Likes: ${l.likesCount ?? '—'}  |  Visitas: ${l.viewsCount ?? '—'}`,
      `Detectado: ${fmtDate(item.detectedAt)}`,
      item.status === 'sold' ? `Vendido: ${fmtDate(item.soldAt)}  |  En: ${item.timeToSellMinutes ?? '—'} min` : '',
    ].filter(Boolean);
    meta.textContent = lines.join('\n');
    container.appendChild(node);
  }
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
function renderBarChart(container, data, fmt) {
  if (!container) return;
  if (!data.length) { container.innerHTML = '<div class="empty-state">Sin datos.</div>'; return; }
  const max = Math.max(...data.map(d => Number(d.value) || 0), 1);
  container.innerHTML = data.map(row => {
    const v   = Number(row.value) || 0;
    const pct = Math.max(3, Math.round((v / max) * 100));
    return `<div class="bar-row">
      <span class="bar-name">${escHtml(row.model)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-value">${escHtml(fmt(v))}</span>
    </div>`;
  }).join('');
}

function buildKeywordRace(items, metrics) {
  if (metrics?.keywordHits && typeof metrics.keywordHits === 'object') {
    const d = Object.entries(metrics.keywordHits)
      .map(([model, value]) => ({ model, value: Number(value) || 0 }))
      .filter(r => r.value > 0)
      .sort((a, b) => b.value - a.value);
    if (d.length) return d;
  }
  const m = new Map(KEYWORD_RACE.map(kw => [kw, 0]));
  for (const item of items) {
    const text = `${item?.title || ''} ${item?.description || ''}`.toLowerCase();
    const tags = Array.isArray(item?.keywordTags) ? item.keywordTags : [];
    const matched = new Set(tags.filter(kw => m.has(kw)));
    for (const kw of KEYWORD_RACE) if (text.includes(kw)) matched.add(kw);
    for (const kw of matched) m.set(kw, (m.get(kw) || 0) + 1);
  }
  return Array.from(m.entries()).map(([model, value]) => ({ model, value }))
    .filter(r => r.value > 0).sort((a, b) => b.value - a.value);
}

function renderAnalytics(items, metrics) {
  const sold = items.filter(i => i.status === 'sold' && Number.isFinite(i.timeToSellMinutes))
    .sort((a, b) => new Date(b.soldAt || 0) - new Date(a.soldAt || 0));

  renderBarChart(chartKeyword, buildKeywordRace(items, metrics).slice(0, 12), v => `${v}`);

  if (!sold.length) {
    [chartTopModels, chartRentable, lastSalesEl].forEach(c => {
      if (c) c.innerHTML = '<div class="empty-state">Aún no hay ventas.</div>';
    });
    return;
  }
  const byModel = new Map();
  for (const item of sold) {
    const k = item.modelName || 'desconocido';
    const p = byModel.get(k) || { soldCount: 0, sumMin: 0, sumPrice: 0, priceCount: 0 };
    p.soldCount++; p.sumMin += Number(item.timeToSellMinutes || 0);
    if (Number.isFinite(item.soldPriceValue)) { p.sumPrice += item.soldPriceValue; p.priceCount++; }
    byModel.set(k, p);
  }
  renderBarChart(chartTopModels,
    Array.from(byModel.entries()).map(([model, v]) => ({ model, value: v.soldCount }))
      .sort((a, b) => b.value - a.value).slice(0, 8),
    v => `${v}`
  );
  renderBarChart(chartRentable,
    Array.from(byModel.entries()).map(([model, v]) => {
      const avgMin = v.soldCount ? v.sumMin / v.soldCount : null;
      const avgP   = v.priceCount ? v.sumPrice / v.priceCount : null;
      const score  = (avgMin && avgMin > 0 && avgP) ? (avgP / (avgMin / 60)) : 0;
      return { model, value: score };
    }).sort((a, b) => b.value - a.value).slice(0, 8),
    v => `${v.toFixed(2)}€`
  );

  if (lastSalesEl) {
    lastSalesEl.innerHTML = '';
    for (const sale of sold.slice(0, 10)) {
      const node = itemTpl.content.firstElementChild.cloneNode(true);
      const link = node.querySelector('.item-link');
      const meta = node.querySelector('.item-meta');
      link.href = sale.url; link.textContent = sale.title || `Item ${sale.itemId}`;
      node.classList.add('item-sold');
      meta.textContent = [
        `Modelo: ${sale.modelName || '—'}`,
        `Precio venta: ${Number.isFinite(sale.soldPriceValue) ? `${sale.soldPriceValue}€` : (sale.soldPriceText || '—')}`,
        `Tiempo de venta: ${sale.timeToSellMinutes ?? '—'} min`,
        `Vendido: ${fmtDate(sale.soldAt)}`,
      ].join('\n');
      lastSalesEl.appendChild(node);
    }
  }
}

// ── ACTION RUNNER ─────────────────────────────────────────────────────────────
async function runAction(btn, action, payload = {}, feedbackEl = null) {
  const orig = btn.innerHTML; btn.disabled = true; btn.textContent = '…';
  TERM.log(`Ejecutando: ${action}`, 'info');
  try {
    const res = await send(action, payload);
    if (res?.licenseBlocked) {
      const msg = res.error || 'Licencia inactiva';
      TERM.log(`Bloqueado por licencia: ${msg}`, 'error');
      if (feedbackEl) feedbackEl.textContent = msg;
      return;
    }
    const result = res?.result || {};
    let feedback = '';
    if (action === 'rb:run-detect') {
      if (result.disabled)      feedback = 'Monitor detenido';
      else if (result.aborted)  feedback = 'Detección cancelada';
      else if (result.skipped)  feedback = 'Detección ya en curso';
      else if (!result.updated) feedback = `Sin novedades (ok: ${result.urlsOk ?? 0}, err: ${result.urlsError ?? 0})`;
      else                      feedback = `Nuevos: ${result.newCount ?? 0} (detectados: ${result.detected ?? 0})`;
      TERM.log(`Detección — ${feedback}`, result.newCount > 0 ? 'success' : 'normal');
    } else if (action === 'rb:run-track') {
      if (result.disabled)      feedback = 'Monitor detenido';
      else if (result.aborted)  feedback = 'Análisis cancelado';
      else if (result.skipped)  feedback = 'Análisis ya en curso';
      else feedback = `Analizados: ${result.checked ?? 0}/${result.attempted ?? 0} | err: ${result.errors ?? 0} | exp: ${result.expired ?? 0}`;
      TERM.log(`Análisis — ${feedback}`, 'info');
    } else if (action === 'rb:stop-monitoring') {
      TERM.log('Monitor detenido', 'warn');
    } else if (action === 'rb:clear-sold') {
      feedback = `Vendidos eliminados: ${res?.removed ?? 0}`;
      TERM.log(feedback, 'info');
      if (feedbackEl) feedbackEl.textContent = feedback;
    } else if (action === 'rb:reset-all') {
      feedback = `Reset: ${res?.removedItems ?? 0} productos eliminados`;
      TERM.log(feedback, 'warn');
      if (feedbackEl) feedbackEl.textContent = feedback;
    }
    await loadState();
  } catch (err) {
    const msg = err?.message || 'Error desconocido';
    TERM.log(`Error en ${action}: ${msg}`, 'error');
    if (feedbackEl) feedbackEl.textContent = `Error: ${msg}`;
  } finally {
    btn.disabled = false; btn.innerHTML = orig;
  }
}

// ── STATE POLLING ─────────────────────────────────────────────────────────────
let _pollTimer = null;
async function loadState() {
  const res = await send('rb:get-state').catch(() => null);
  if (res?.success) render(res.state, res.config);
}
function startPolling() {
  if (_pollTimer) return;
  void loadState();
  _pollTimer = setInterval(() => void loadState(), 30000);
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
// Dashboard quick actions
document.getElementById('dash-start')?.addEventListener('click', async () => {
  const name = productNameInput.value.trim();
  const urls = parseSearchUrlsInput(searchUrlsInput.value);
  if (!name) { TERM.log('Error: falta el nombre de campaña', 'error'); showSection('operaciones'); return; }
  if (!urls.length) { TERM.log('Error: no hay URLs de búsqueda válidas', 'error'); showSection('operaciones'); return; }
  const btn = document.getElementById('dash-start');
  btn.disabled = true; btn.textContent = '…';
  TERM.log(`Iniciando campaña "${name}"…`, 'info'); TERM.show();
  try {
    const res = await send('rb:start-monitoring', { productName: name, searchUrls: urls });
    if (!res?.success || !res?.result?.ok) {
      TERM.log(`Error al iniciar: ${res?.error || 'desconocido'}`, 'error');
    } else {
      TERM.log(`Monitor activo — ${name} (${urls.length} URL${urls.length > 1 ? 's' : ''})`, 'success');
    }
    await loadState();
  } finally { btn.disabled = false; btn.textContent = '▶ Iniciar'; }
});
document.getElementById('dash-stop')?.addEventListener('click', btn =>
  runAction(document.getElementById('dash-stop'), 'rb:stop-monitoring'));
document.getElementById('dash-detect')?.addEventListener('click', btn =>
  runAction(document.getElementById('dash-detect'), 'rb:run-detect'));
document.getElementById('dash-track')?.addEventListener('click', btn =>
  runAction(document.getElementById('dash-track'), 'rb:run-track'));

// ExOfertas start
document.getElementById('start-monitor')?.addEventListener('click', async () => {
  const name = productNameInput.value.trim();
  const urls = parseSearchUrlsInput(searchUrlsInput.value);
  if (!name) { TERM.log('Error: escribe el nombre de la campaña', 'error'); return; }
  if (!urls.length) { TERM.log('Error: pega al menos una URL válida de vinted.es', 'error'); return; }
  const btn = document.getElementById('start-monitor');
  btn.disabled = true; const orig = btn.innerHTML; btn.textContent = 'Iniciando…';
  TERM.log(`Iniciando ExOfertas — campaña "${name}"…`, 'info'); TERM.show();
  try {
    const res = await send('rb:start-monitoring', { productName: name, searchUrls: urls });
    if (!res?.success || !res?.result?.ok) {
      TERM.log(`Error al iniciar: ${res?.error || 'desconocido'}`, 'error');
    } else {
      TERM.log(`Monitor activo — ${name} (${urls.length} URL${urls.length > 1 ? 's' : ''})`, 'success');
      TERM.log('Primer escaneo en ~5 minutos. Puedes cerrar el popup.', 'info');
    }
    await loadState();
  } finally { btn.disabled = false; btn.innerHTML = orig; }
});
document.getElementById('stop-monitor')?.addEventListener('click', () =>
  runAction(document.getElementById('stop-monitor'), 'rb:stop-monitoring'));

// Save URLs
document.getElementById('save-url')?.addEventListener('click', async () => {
  const urls = parseSearchUrlsInput(searchUrlsInput.value);
  if (!urls.length) { TERM.log('No hay URLs válidas de vinted.es', 'error'); return; }
  const btn = document.getElementById('save-url');
  btn.disabled = true; const orig = btn.innerHTML; btn.textContent = 'Guardando…';
  try {
    const res = await send('rb:set-search-urls', { searchUrls: urls });
    TERM.log(res?.success ? `URLs guardadas: ${urls.length}` : `Error: ${res?.error || 'desconocido'}`, res?.success ? 'success' : 'error');
    await loadState();
  } finally { btn.disabled = false; btn.innerHTML = orig; }
});

// Report
document.getElementById('export-csv')?.addEventListener('click', async () => {
  const res = await send('rb:get-state').catch(() => null);
  const rows = Array.isArray(res?.state?.items) ? res.state.items : [];
  if (!rows.length) { if (reportMsg) reportMsg.textContent = 'No hay datos para exportar.'; return; }
  exportRowsToCsv(rows);
  if (reportMsg) reportMsg.textContent = `Exportado: ${rows.length} artículos.`;
  TERM.log(`CSV exportado — ${rows.length} filas`, 'success');
});
document.getElementById('clear-sold')?.addEventListener('click', () =>
  runAction(document.getElementById('clear-sold'), 'rb:clear-sold', {}, reportMsg));
document.getElementById('reset-all')?.addEventListener('click', () => {
  if (!confirm('¿Seguro? Esto eliminará TODOS los artículos y métricas.')) return;
  runAction(document.getElementById('reset-all'), 'rb:reset-all', {}, reportMsg);
});

// Open full dashboard
document.getElementById('open-dashboard')?.addEventListener('click', () =>
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

// ── VACATION MODE ─────────────────────────────────────────────────────────────
const vacDot       = document.getElementById('vac-dot');
const vacLabel     = document.getElementById('vac-label');
const vacCheckTime = document.getElementById('vac-check-time');
const vacMsg       = document.getElementById('vac-msg');
const vacOnBtn     = document.getElementById('vac-on');
const vacOffBtn    = document.getElementById('vac-off');
const vacSchedule  = document.getElementById('vac-schedule');
const vacRefresh   = document.getElementById('vac-refresh');

function vacSetState(isOn, lastCheck) {
  if (!vacDot) return;
  vacDot.className   = `vac-dot ${isOn ? 'vac-on' : 'vac-off'}`;
  vacLabel.textContent = isOn ? '🌙 Modo vacaciones ACTIVO' : '🟢 Vendiendo — modo normal';
  vacCheckTime.textContent = lastCheck ? `Última comprobación: ${fmtDate(lastCheck)}` : '—';
}

function vacSetUnknown() {
  if (!vacDot) return;
  vacDot.className     = 'vac-dot vac-unknown';
  vacLabel.textContent = 'Estado desconocido';
  vacCheckTime.textContent = '—';
}

function vacSetMsg(msg, type = '') {
  if (!vacMsg) return;
  vacMsg.textContent = msg;
  vacMsg.className   = `vac-msg ${type}`;
}

function vacSetLoading(busy) {
  if (vacOnBtn)  vacOnBtn.disabled  = busy;
  if (vacOffBtn) vacOffBtn.disabled = busy;
  if (vacRefresh) {
    vacRefresh.classList.toggle('spinning', busy);
    vacRefresh.disabled = busy;
  }
}

async function loadVacationStatus(showSpinner = true) {
  if (showSpinner) vacSetLoading(true);
  vacSetMsg('Comprobando estado en Vinted…');
  try {
    const res = await send('rb:vacation-status');
    if (!res?.ok || !res?.found) {
      vacSetUnknown();
      vacSetMsg(
        res?.error === 'not_scriptable'
          ? 'Abre Vinted en Chrome para poder leer el estado.'
          : `Error: ${res?.error || 'no se pudo leer el estado'}`,
        'err'
      );
      return;
    }
    vacSetState(res.isOn, res.lastCheck || null);
    // Sincronizar toggle de horario
    if (vacSchedule) vacSchedule.checked = res.scheduleEnabled === true;
    if (res.lastApplied) {
      vacSetMsg(
        `Último cambio: ${res.lastApplied.state ? 'activado' : 'desactivado'} — ${fmtDate(res.lastApplied.at)}`,
        'ok'
      );
    } else {
      vacSetMsg('');
    }
  } catch (err) {
    vacSetUnknown();
    vacSetMsg(`Error: ${err?.message || 'desconocido'}`, 'err');
  } finally {
    vacSetLoading(false);
  }
}

async function applyVacation(enable) {
  vacSetLoading(true);
  vacSetMsg(`${enable ? 'Activando' : 'Desactivando'} modo vacaciones… (puede tardar ~15 s)`);
  try {
    const res = await send('rb:vacation-apply', { enable });
    if (res?.ok) {
      vacSetState(enable, new Date().toISOString());
      vacSetMsg(
        enable ? '🌙 Modo vacaciones activado' : '🟢 Modo vacaciones desactivado',
        'ok'
      );
      TERM.log(`Modo vacaciones Vinted: ${enable ? 'ACTIVADO' : 'DESACTIVADO'}`, enable ? 'warn' : 'success');
    } else {
      vacSetMsg(`Error: ${res?.error || 'no se pudo cambiar el estado'}`, 'err');
      TERM.log(`Error al cambiar modo vacaciones: ${res?.error}`, 'error');
    }
  } catch (err) {
    vacSetMsg(`Error: ${err?.message || 'desconocido'}`, 'err');
  } finally {
    vacSetLoading(false);
  }
}

// Botón Activar
vacOnBtn?.addEventListener('click', () => applyVacation(true));

// Botón Desactivar
vacOffBtn?.addEventListener('click', () => applyVacation(false));

// Botón Comprobar (refresh)
vacRefresh?.addEventListener('click', () => loadVacationStatus(true));

// Toggle horario automático
vacSchedule?.addEventListener('change', async () => {
  const enabled = vacSchedule.checked;
  vacSetMsg(enabled ? 'Activando horario 23:00–07:00…' : 'Desactivando horario…');
  try {
    await send('rb:vacation-schedule', { enabled });
    vacSetMsg(
      enabled
        ? '⏰ Horario activo — se activará automáticamente a las 23:00'
        : 'Horario desactivado',
      enabled ? 'ok' : ''
    );
    TERM.log(`Horario vacaciones: ${enabled ? 'activado (23:00-07:00)' : 'desactivado'}`, 'info');
  } catch (err) {
    vacSchedule.checked = !enabled; // revertir
    vacSetMsg(`Error: ${err?.message}`, 'err');
  }
});

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────────
async function bootstrapPopup() {
  const overlay  = document.getElementById('auth-overlay');
  const appShell = document.getElementById('app-shell');
  const authMsg  = document.getElementById('auth-msg');
  const loginBtn = document.getElementById('auth-login-btn');

  function showApp()   {
    if (overlay) overlay.style.display = 'none';
    if (appShell) appShell.style.display = 'flex';
    startPolling();
    // Cargar estado de vacaciones en segundo plano (no bloquea)
    setTimeout(() => loadVacationStatus(false), 1200);
  }
  function showLogin(msg) {
    if (appShell) appShell.style.display = 'none';
    if (overlay)  overlay.style.display  = 'flex';
    if (authMsg && msg) authMsg.textContent = msg;
  }

  loginBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('login.html') });
    window.close();
  });

  try {
    const res = await send('rb:auth-status');
    const lic = res?.license || {};
    if (lic.status === 'dev_mode' || lic.allowed === true || lic.status === 'network_error') {
      showApp(); return;
    }
    if (!res?.loggedIn || lic.status === 'no_token') {
      showLogin('Inicia sesión para acceder.'); return;
    }
    const msgs = {
      inactive: 'Tu licencia no está activa. Contacta con el administrador.',
      expired:  'Tu licencia ha expirado. Renuévala para continuar.',
      revoked:  'Tu licencia ha sido revocada.',
    };
    showLogin(msgs[lic.status] || lic.message || 'Licencia inactiva.');
  } catch (_) {
    showApp(); // Network error → show app anyway
  }
}

void bootstrapPopup();
