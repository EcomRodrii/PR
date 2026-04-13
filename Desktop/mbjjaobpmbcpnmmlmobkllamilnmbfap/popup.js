// ═══════════════════════════════════════════════════════════
//  LAMINE RESELL — popup.js  v6  — Dark Premium + Live Progress
// ═══════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const send = (action, p = {}) => chrome.runtime.sendMessage({ action, ...p });

let _state = null, _config = null;
let _cycleTimer = null, _pollTimer = null;
let _progressAnimTimer = null;

// ── Utils ──────────────────────────────────────────────────
function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0)       return 'ahora';
  if (ms < 60e3)    return `${Math.round(ms/1e3)}s`;
  if (ms < 3600e3)  return `${Math.round(ms/60e3)}m`;
  if (ms < 86400e3) return `${Math.round(ms/3600e3)}h`;
  return `${Math.round(ms/86400e3)}d`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}`;
}
function fmtPrice(text, value) {
  if (value != null && Number.isFinite(+value)) return `${(+value).toFixed(2)}€`;
  if (text) return String(text);
  return '—';
}
function parseUrls(raw) {
  return [...new Set(String(raw||'').split('\n').map(v=>v.trim())
    .filter(v=>v.startsWith('https://www.vinted.es/')))];
}
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

// Priority P0–P3
function prio(item) {
  const checked = new Date(item.latest?.checkedAt||0).getTime();
  const det     = new Date(item.detectedAt||0).getTime();
  const age     = Date.now() - det;
  const likes   = item.latest?.likesCount ?? 0;
  if (!checked || age < 600000 || item.status === 'reserved') return 0;
  if (age < 7200000 || likes >= 3)  return 1;
  if (age < 28800000)               return 2;
  return 3;
}
const PRIO_DOT = ['pd0','pd1','pd2','pd3'];
const PRIO_TIP = ['🔥 Alta prioridad','↑ Activo reciente','→ Normal','↓ Frío'];

// ── Tab Navigation ────────────────────────────────────────
const PAGES = ['overview','items','sales','config'];
function initNav() {
  document.querySelectorAll('.tab[data-page]').forEach(btn =>
    btn.addEventListener('click', () => goPage(btn.dataset.page))
  );
}
function goPage(id) {
  PAGES.forEach(p => {
    document.querySelector(`.tab[data-page="${p}"]`)?.classList.toggle('active', p === id);
    $(`page-${p}`)?.classList.toggle('active', p === id);
  });
  if (id === 'items')  renderItems();
  if (id === 'sales')  renderSales();
  if (id === 'config') renderConfig();
}

// ── Countdown ──────────────────────────────────────────────
function startCountdown(config) {
  clearInterval(_cycleTimer);
  const el = $('cycle-countdown');
  if (!el) return;
  if (!config?.monitorEnabled || !config?.lastCycleAt) { el.textContent = '—'; return; }
  const period = (config.detectPeriodMinutes || 3) * 60000;
  const next   = new Date(config.lastCycleAt).getTime() + period;
  _cycleTimer  = setInterval(() => {
    const rem = next - Date.now();
    el.textContent = rem > 0 ? fmtMs(rem) : 'pronto';
  }, 1000);
}

// ── Live Progress Bar ─────────────────────────────────────
function applyProgress(prog) {
  const bar     = $('scanner-bar');
  const dot     = document.querySelector('.phase-dot');
  const label   = $('phase-label');
  const meta    = $('scanner-meta');
  const statL   = $('scanner-stat-left');
  if (!bar || !label) return;

  clearTimeout(_progressAnimTimer);

  if (!prog || prog.status === 'idle') {
    bar.style.width = '0%';
    bar.className = 'scanner-bar';
    if (dot) dot.className = 'phase-dot idle';
    label.textContent = 'Monitor listo';
    if (meta) meta.textContent = '—';
    if (statL) statL.textContent = '—';
    return;
  }

  const pct = Math.max(0, Math.min(100, prog.progress || 0));
  bar.style.width = pct + '%';

  if (prog.status === 'running') {
    bar.className = 'scanner-bar';
    if (prog.phase === 'detect') {
      if (dot) dot.className = 'phase-dot detect';
      label.textContent = 'Detectando productos…';
      if (meta) meta.textContent = `${prog.found || 0} encontrados`;
      if (statL) statL.textContent = `Escaneando pág. ${Math.ceil((pct/100) * (prog.total||1))} / ${prog.total||'?'}`;
    } else {
      if (dot) dot.className = 'phase-dot track';
      label.textContent = 'Analizando items…';
      if (meta) meta.textContent = `${prog.checked || 0} / ${prog.total || '?'} analizados`;
      if (statL) statL.textContent = `Revisando precios y estado`;
    }
  } else if (prog.status === 'done') {
    bar.className = 'scanner-bar done';
    if (dot) dot.className = 'phase-dot done';
    if (prog.phase === 'detect') {
      label.textContent = `Detección completa`;
      if (meta) meta.textContent = `+${prog.found || 0} nuevos detectados`;
    } else {
      label.textContent = `Análisis completo`;
      if (meta) meta.textContent = `${prog.checked || 0} items revisados`;
    }
    // Auto-reset after 4s
    _progressAnimTimer = setTimeout(() => applyProgress(null), 4000);
  } else if (prog.status === 'error') {
    bar.className = 'scanner-bar error';
    if (dot) dot.className = 'phase-dot error';
    label.textContent = 'Error en el ciclo';
    if (meta) meta.textContent = 'Reintentando pronto…';
    _progressAnimTimer = setTimeout(() => applyProgress(null), 5000);
  }
}

// ── Render Overview ───────────────────────────────────────
function renderOverview(state, config) {
  const items   = Array.isArray(state?.items) ? state.items : [];
  const metrics = state?.metrics || {};
  const enabled = config?.monitorEnabled === true;

  // Status pill
  const pill  = $('status-pill');
  const dot   = $('status-dot');
  const lbl   = $('status-label');
  if (pill)  pill.className  = `status-pill${enabled ? ' live' : ''}`;
  if (dot)   dot.className   = `status-dot${enabled ? ' live' : ''}`;
  if (lbl)   lbl.textContent = enabled ? 'LIVE' : 'PARADO';

  // Campaign
  const cn = $('campaign-name');
  if (cn) cn.textContent = config?.productName || 'sin campaña';

  // Buttons
  $('start-monitor').disabled = enabled;
  $('stop-monitor').disabled  = !enabled;
  $('detect-now').disabled    = !enabled;
  $('track-now').disabled     = !enabled;
  $('scan-all').disabled      = !enabled;

  // KPIs
  const active = items.filter(i => i.status === 'active' || i.status === 'reserved').length;
  const sold   = items.filter(i => i.status === 'sold').length;
  const total  = metrics.totalDetected || items.length;
  const conv   = total > 0 ? `${((sold/total)*100).toFixed(1)}%` : '0%';
  let rev = 0, ttsT = 0, ttsC = 0;
  for (const item of items.filter(i => i.status === 'sold')) {
    const pv = +item.soldPriceValue;
    if (pv > 0) rev += pv;
    if (item.timeToSellMinutes != null) { ttsT += item.timeToSellMinutes; ttsC++; }
  }
  const avgTts = ttsC > 0
    ? (ttsT/ttsC < 60 ? `${Math.round(ttsT/ttsC)}m` : `${(ttsT/ttsC/60).toFixed(1)}h`)
    : '—';

  $('kpi-total').textContent   = total;
  $('kpi-active').textContent  = active;
  $('kpi-sold').textContent    = sold;
  $('kpi-revenue').textContent = rev > 0 ? `€${rev.toFixed(0)}` : '€0';
  $('kpi-conv').textContent    = conv;
  $('kpi-tts').textContent     = avgTts;

  // Tab badges
  $('tab-badge-items').textContent = active;
  $('tab-badge-sales').textContent = sold;

  startCountdown(config);

  // Activity feed
  const now = Date.now();
  const evs = [];
  for (const item of items) {
    if (item.status === 'sold') {
      const t = new Date(item.soldAt||0).getTime();
      if (!t) continue;
      evs.push({ type: 'sold', t, item });
    } else {
      const t = new Date(item.detectedAt||0).getTime();
      if (!t || now - t > 6*3600000) continue;
      evs.push({ type: item.status === 'reserved' ? 'reserved' : 'new', t, item });
    }
  }
  evs.sort((a,b) => b.t - a.t);

  const feed = $('activity-feed');
  feed.innerHTML = '';
  $('feed-count').textContent = evs.length;

  if (!evs.length) {
    feed.innerHTML = '<div class="feed-empty">Inicia el monitor para detectar productos</div>';
    return;
  }

  const BADGE = {
    new:      '<span class="badge badge-new">NUEVO</span>',
    reserved: '<span class="badge badge-reserved">RESERVADO</span>',
    sold:     '<span class="badge badge-sold">VENDIDO</span>',
  };

  for (const { type, t, item } of evs.slice(0, 50)) {
    const p   = prio(item);
    const l   = item.latest || {};
    const price = type === 'sold'
      ? fmtPrice(item.soldPriceText, item.soldPriceValue)
      : fmtPrice(l.priceText, l.priceValue);
    const sub = item.modelName && item.modelName !== 'desconocido' ? item.modelName : (l.likesCount > 0 ? `♥ ${l.likesCount}` : '');

    const row = document.createElement('div');
    row.className = 'feed-row';
    row.innerHTML = `
      <span class="prio-dot ${PRIO_DOT[p]}" title="${PRIO_TIP[p]}"></span>
      <div class="feed-main">
        <a class="feed-title" href="${item.url}" target="_blank" rel="noreferrer">${item.title||'#'+item.itemId}</a>
        ${sub ? `<div class="feed-sub">${sub}</div>` : ''}
      </div>
      ${BADGE[type]}
      <div class="feed-price${type==='sold'?' sold':''}">${price}</div>
      <div class="feed-time">${ago(new Date(t))}</div>`;
    feed.appendChild(row);
  }
}

// ── Render Items ──────────────────────────────────────────
function renderItems() {
  if (!_state) return;
  const q    = ($('items-search')?.value || '').toLowerCase().trim();
  const sort = $('items-sort')?.value || 'newest';
  let list   = (_state.items || []).filter(i => i.status !== 'sold');
  if (q) list = list.filter(i =>
    (i.title||'').toLowerCase().includes(q) ||
    (i.modelName||'').toLowerCase().includes(q));

  if (sort === 'newest')     list.sort((a,b) => new Date(b.detectedAt||0) - new Date(a.detectedAt||0));
  if (sort === 'priority')   list.sort((a,b) => prio(a) - prio(b));
  if (sort === 'likes')      list.sort((a,b) => (b.latest?.likesCount||0) - (a.latest?.likesCount||0));
  if (sort === 'price-asc')  list.sort((a,b) => (a.latest?.priceValue||0) - (b.latest?.priceValue||0));
  if (sort === 'price-desc') list.sort((a,b) => (b.latest?.priceValue||0) - (a.latest?.priceValue||0));

  const el = $('items-list');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = `<div class="feed-empty">${q ? 'Sin resultados para "'+q+'"' : 'Sin productos activos'}</div>`;
    return;
  }

  for (const item of list.slice(0, 120)) {
    const p = prio(item);
    const l = item.latest || {};
    const badge = item.status === 'reserved'
      ? '<span class="badge badge-reserved">RESERVADO</span>'
      : '<span class="badge badge-active">ACTIVO</span>';
    const likes = l.likesCount > 0 ? `<span class="heart">♥</span>${l.likesCount}` : '—';

    const row = document.createElement('div');
    row.className = 'trow';
    row.innerHTML = `
      <span class="prio-dot ${PRIO_DOT[p]}" title="${PRIO_TIP[p]}"></span>
      <div class="trow-main">
        <a class="trow-title" href="${item.url}" target="_blank" rel="noreferrer">${item.title||'#'+item.itemId}${l.likesCount>=5?' ⚠':''}</a>
        <div class="trow-sub">${item.modelName&&item.modelName!=='desconocido'?item.modelName:''}  ${ago(item.detectedAt)}</div>
      </div>
      <div class="trow-status">${badge}</div>
      <div class="trow-likes">${likes}</div>
      <div class="trow-price">${fmtPrice(l.priceText, l.priceValue)}</div>`;
    el.appendChild(row);
  }
}

// ── Render Sales ──────────────────────────────────────────
function renderSales() {
  if (!_state) return;
  const sold = (_state.items || []).filter(i => i.status === 'sold')
    .sort((a,b) => new Date(b.soldAt||0) - new Date(a.soldAt||0));

  let rev = 0, rc = 0, tts = 0, tc = 0;
  for (const item of sold) {
    const pv = +item.soldPriceValue;
    if (pv > 0) { rev += pv; rc++; }
    if (item.timeToSellMinutes != null) { tts += item.timeToSellMinutes; tc++; }
  }
  $('an-revenue').textContent = rev > 0 ? `€${rev.toFixed(2)}` : '—';
  $('an-avg').textContent     = rc > 0  ? `€${(rev/rc).toFixed(2)}` : '—';
  $('an-tts').textContent     = tc > 0
    ? (tts/tc < 60 ? `${Math.round(tts/tc)}m` : `${(tts/tc/60).toFixed(1)}h`)
    : '—';

  const byModel = new Map();
  for (const item of sold) {
    const k = item.modelName || 'Otros';
    byModel.set(k, (byModel.get(k)||0) + 1);
  }
  const top = [...byModel.entries()].sort((a,b) => b[1]-a[1]).slice(0,6);
  const mc = $('models-chart');
  mc.innerHTML = '';
  if (!top.length) { mc.innerHTML = '<div class="feed-empty" style="padding:8px">Sin datos</div>'; }
  else {
    const max = top[0][1];
    for (const [name, cnt] of top) {
      const pct = Math.max(3, Math.round((cnt/max)*100));
      const r = document.createElement('div');
      r.className = 'mrow';
      r.innerHTML = `<span class="mrow-name" title="${name}">${name}</span>
        <span class="mrow-bar"><span class="mrow-fill" style="width:${pct}%"></span></span>
        <span class="mrow-cnt">${cnt}</span>`;
      mc.appendChild(r);
    }
  }

  const sl = $('sales-list');
  sl.innerHTML = '';
  if (!sold.length) { sl.innerHTML = '<div class="feed-empty">Sin ventas todavía</div>'; return; }
  for (const item of sold.slice(0, 60)) {
    const ttsFmt = item.timeToSellMinutes != null
      ? (item.timeToSellMinutes < 60 ? `${Math.round(item.timeToSellMinutes)}m` : `${(item.timeToSellMinutes/60).toFixed(1)}h`)
      : '—';
    const r = document.createElement('div');
    r.className = 'trow';
    r.innerHTML = `
      <div class="trow-main">
        <a class="trow-title" href="${item.url}" target="_blank" rel="noreferrer">${item.title||'#'+item.itemId}</a>
        <div class="trow-sub">${item.modelName||''}</div>
      </div>
      <div class="trow-price sold">${fmtPrice(item.soldPriceText, item.soldPriceValue)}</div>
      <div class="trow-tts">${ttsFmt}</div>
      <div class="trow-time">${ago(item.soldAt)}</div>`;
    sl.appendChild(r);
  }
}

// ── Render Config ─────────────────────────────────────────
function renderConfig() {
  if (!_config) return;
  const pInp = $('product-name'), uInp = $('search-urls');
  if (document.activeElement !== pInp && _config.productName != null) pInp.value = _config.productName;
  if (document.activeElement !== uInp) {
    uInp.value = Array.isArray(_config.searchUrls) ? _config.searchUrls.join('\n') : '';
  }
  const sp = $('scan-pages');
  if (sp && _config.scanPages) sp.value = String(_config.scanPages);
  const pmInp = $('price-min'), pxInp = $('price-max');
  if (pmInp && document.activeElement !== pmInp) pmInp.value = _config.priceMin ?? '';
  if (pxInp && document.activeElement !== pxInp) pxInp.value = _config.priceMax ?? '';
}

// ── Render main ───────────────────────────────────────────
function render(state, config) {
  _state = state; _config = config;
  renderOverview(state, config);
  if ($('page-items')?.classList.contains('active'))  renderItems();
  if ($('page-sales')?.classList.contains('active'))  renderSales();
  if ($('page-config')?.classList.contains('active')) renderConfig();
}

async function loadState() {
  try {
    const res = await send('rb:get-state');
    if (res?.success) render(res.state, res.config);
  } catch(_) {}
}

// ── CSV Export ────────────────────────────────────────────
function doExport(items) {
  const H = ['id','estado','titulo','modelo','url','precio','likes','visitas','detectado','vendido','min_venta'];
  const rows = items.map(item => {
    const l = item.latest || {};
    return [item.itemId,item.status,item.title,item.modelName,item.url,
      l.priceText,l.likesCount,l.viewsCount,
      item.detectedAt,item.soldAt,item.timeToSellMinutes].map(csvEscape).join(',');
  });
  const blob = new Blob([[H.join(','),...rows].join('\n')], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'),
    { href:url, download:`vinted_${new Date().toISOString().slice(0,10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

async function runBtn(btn, action, payload = {}) {
  const orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '…';
  try { await send(action, payload); await loadState(); } catch(_) {}
  finally { btn.disabled = false; btn.innerHTML = orig; }
}

// ── Events ────────────────────────────────────────────────
$('start-monitor').addEventListener('click', async () => {
  let pn   = $('product-name').value.trim() || 'rayban';
  let urls = parseUrls($('search-urls').value);
  if (!urls.length) urls = [`https://www.vinted.es/catalog?search_text=${encodeURIComponent(pn)}&order=newest_first&page=1&status_ids[]=6&status_ids[]=1`];
  await runBtn($('start-monitor'), 'rb:start-monitoring', { productName: pn, searchUrls: urls });
});
$('stop-monitor').addEventListener('click', () => runBtn($('stop-monitor'), 'rb:stop-monitoring'));
$('detect-now').addEventListener('click',   () => runBtn($('detect-now'),   'rb:run-detect'));
$('track-now').addEventListener('click',    () => runBtn($('track-now'),    'rb:run-track'));
$('scan-all').addEventListener('click', async () => {
  const btn = $('scan-all'); const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '…';
  try { await send('rb:run-detect'); await send('rb:run-track'); await loadState(); } catch(_) {}
  finally { btn.disabled = false; btn.innerHTML = orig; }
});

$('save-config').addEventListener('click', async () => {
  const urls = parseUrls($('search-urls').value);
  if (!urls.length) return;
  const scanPages = parseInt($('scan-pages')?.value || '2', 10) || 2;
  const priceMin  = parseFloat($('price-min')?.value || '') || null;
  const priceMax  = parseFloat($('price-max')?.value || '') || null;
  await runBtn($('save-config'), 'rb:set-search-urls', { searchUrls: urls, scanPages, priceMin, priceMax });
});

$('clear-sold').addEventListener('click', () => runBtn($('clear-sold'), 'rb:clear-sold'));
$('reset-all').addEventListener('click',  () => runBtn($('reset-all'),  'rb:reset-all'));
$('export-csv').addEventListener('click', async () => {
  const res = await send('rb:get-state');
  if (res?.success) doExport(Array.isArray(res.state?.items) ? res.state.items : []);
});

$('items-search').addEventListener('input',  renderItems);
$('items-sort').addEventListener('change',   renderItems);

// ── Live progress via storage listener ───────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['raybanMonitorProgress']) {
    applyProgress(changes['raybanMonitorProgress'].newValue);
  }
  if (changes['raybanMonitorConfig'] || changes['raybanMonitorState']) {
    void loadState();
  }
});

// ── Bootstrap ─────────────────────────────────────────────
async function bootstrap() {
  initNav();
  const res = await send('rb:get-state');
  const first = !res?.config?.monitorEnabled && !res?.config?.productName
    && (!Array.isArray(res?.state?.items) || !res.state.items.length);
  if (first) {
    const pn  = 'rayban';
    const url = `https://www.vinted.es/catalog?search_text=${encodeURIComponent(pn)}&order=newest_first&page=1&status_ids[]=6&status_ids[]=1`;
    try { await send('rb:start-monitoring', { productName: pn, searchUrls: [url] }); } catch(_) {}
  }
  if (res?.success) render(res.state, res.config);
  // Load initial progress
  try {
    const pr = await send('rb:get-progress');
    if (pr?.success && pr.progress) applyProgress(pr.progress);
  } catch(_) {}
  await loadState();
  _pollTimer = setInterval(loadState, 12000);
}

void bootstrap();
