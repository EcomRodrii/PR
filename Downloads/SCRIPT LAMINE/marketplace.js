/* ================================================================
   marketplace.js — 12h Deep Analysis Engine
   ================================================================ */

'use strict';

// ── Element refs ──────────────────────────────────────────────────────────────

const els = {
  // Sidebar search
  query:            document.getElementById('mkt-query'),
  startBtn:         document.getElementById('mkt-start-btn'),
  stopBtn:          document.getElementById('mkt-stop-btn'),
  statusChip:       document.getElementById('mkt-status-chip'),

  // Sidebar analysis status
  analysisPanel:    document.getElementById('analysis-status-panel'),
  analysisLabel:    document.getElementById('analysis-query-label'),
  analysisBadge:    document.getElementById('analysis-badge'),
  progressFill:     document.getElementById('analysis-progress-fill'),
  elapsed:          document.getElementById('analysis-elapsed'),
  remaining:        document.getElementById('analysis-remaining'),
  scanCount:        document.getElementById('scan-count'),
  statTracked:      document.getElementById('stat-tracked'),
  statSold:         document.getElementById('stat-sold'),
  statActive:       document.getElementById('stat-active'),
  lastScanNote:     document.getElementById('last-scan-note'),
  scanNowBtn:       document.getElementById('mkt-scan-now-btn'),

  // Main states
  title:            document.getElementById('mkt-title'),
  empty:            document.getElementById('mkt-empty'),
  loading:          document.getElementById('mkt-loading'),
  results:          document.getElementById('mkt-results'),

  // KPIs
  kpiTracked:       document.getElementById('kpi-tracked'),
  kpiSold:          document.getElementById('kpi-sold'),
  kpiActive:        document.getElementById('kpi-active'),
  kpiAvgSold:       document.getElementById('kpi-avg-sold'),
  kpiAvgActive:     document.getElementById('kpi-avg-active'),
  kpiSpeed:         document.getElementById('kpi-speed'),

  // Sections
  sizeRanking:      document.getElementById('size-ranking'),
  sizeEmpty:        document.getElementById('size-empty'),
  speedBuckets:     document.getElementById('speed-buckets'),
  speedEmpty:       document.getElementById('speed-empty'),
  priceDist:        document.getElementById('price-distribution'),
  priceEmpty:       document.getElementById('price-empty'),
  sellersTable:     document.getElementById('sellers-table'),
  sellersEmpty:     document.getElementById('sellers-empty'),
  sellersCountBadge:document.getElementById('sellers-count-badge'),

  soldList:         document.getElementById('sold-list'),
  soldCountBadge:   document.getElementById('sold-count-badge'),
  activeList:       document.getElementById('active-list'),
  activeCountBadge: document.getElementById('active-count-badge'),
};

// ── State ─────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS    = 20_000; // refresh UI every 20s while running
const MKT_DURATION_MS     = 12 * 60 * 60 * 1000;

let pollTimer = null;
let currentAnalysis = null;

// ── Messaging ─────────────────────────────────────────────────────────────────

function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtPrice(val) {
  if (val == null) return '—';
  return `${Number(val).toFixed(2)} €`;
}

function fmtHours(h) {
  if (h == null) return '—';
  if (h < 1)    return `${Math.round(h * 60)} min`;
  if (h < 24)   return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} días`;
}

function fmtTimeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60_000);
  if (min < 1)  return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h}h`;
}

function fmtDuration(ms) {
  const h   = Math.floor(ms / 3_600_000);
  const m   = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// ── Status chip helper ────────────────────────────────────────────────────────

function setStatus(msg, cls = '') {
  if (!els.statusChip) return;
  els.statusChip.textContent = msg;
  els.statusChip.className   = `status-chip${cls ? ` ${cls}` : ''}`;
}

// ── Show / hide main views ────────────────────────────────────────────────────

function showView(view) {
  els.empty.style.display   = view === 'empty'   ? 'flex' : 'none';
  els.loading.style.display = view === 'loading' ? 'flex' : 'none';
  els.results.style.display = view === 'results' ? 'block': 'none';
}

// ── Sidebar status panel ──────────────────────────────────────────────────────

function updateSidebarStatus(analysis) {
  if (!analysis) {
    if (els.analysisPanel) els.analysisPanel.style.display = 'none';
    return;
  }

  if (els.analysisPanel) els.analysisPanel.style.display = 'block';

  const { query, startedAt, endsAt, status, scanCount, lastScanAt, results } = analysis;

  // Label + badge
  if (els.analysisLabel) els.analysisLabel.textContent = query || '—';
  if (els.analysisBadge) els.analysisBadge.className = `status-dot-badge ${status || ''}`;

  // Progress
  const now     = Date.now();
  const elapsed = Math.min(now - startedAt, MKT_DURATION_MS);
  const pct     = Math.min((elapsed / MKT_DURATION_MS) * 100, 100).toFixed(1);
  if (els.progressFill) els.progressFill.style.width = `${pct}%`;
  if (els.elapsed)      els.elapsed.textContent      = fmtDuration(elapsed);
  if (els.remaining) {
    const rem = Math.max(endsAt - now, 0);
    els.remaining.textContent = status === 'running'
      ? `${fmtDuration(rem)} restante`
      : status === 'completed' ? 'Completado' : 'Detenido';
  }

  // Mini stats
  if (els.scanCount)  els.scanCount.textContent  = scanCount  ?? 0;
  if (els.statTracked)els.statTracked.textContent = results?.totalTracked ?? 0;
  if (els.statSold)   els.statSold.textContent    = results?.totalSold    ?? 0;
  if (els.statActive) els.statActive.textContent  = results?.totalActive  ?? 0;
  if (els.lastScanNote) {
    els.lastScanNote.textContent = lastScanAt
      ? `Último escaneo: ${fmtTimeAgo(lastScanAt)}`
      : 'Primer escaneo en ~1 min…';
  }

  // Buttons
  const running = status === 'running';
  if (els.stopBtn)    els.stopBtn.style.display    = running ? 'flex'  : 'none';
  if (els.startBtn)   els.startBtn.style.display   = running ? 'none'  : 'flex';
  if (els.scanNowBtn) els.scanNowBtn.disabled       = !running;
}

// ── KPIs ──────────────────────────────────────────────────────────────────────

function renderKpis(r) {
  els.kpiTracked.textContent  = r.totalTracked  ?? '—';
  els.kpiSold.textContent     = r.totalSold     ?? '—';
  els.kpiActive.textContent   = r.totalActive   ?? '—';
  els.kpiAvgSold.textContent  = fmtPrice(r.avgSoldPrice);
  els.kpiAvgActive.textContent= fmtPrice(r.avgActivePrice);
  els.kpiSpeed.textContent    = fmtHours(r.avgTimeToSellHours);
}

// ── Size ranking ──────────────────────────────────────────────────────────────

function renderSizeRanking(sizeRanking) {
  if (!sizeRanking || sizeRanking.length === 0) {
    els.sizeRanking.innerHTML = '';
    els.sizeEmpty.style.display = 'block';
    return;
  }
  els.sizeEmpty.style.display = 'none';
  const max = sizeRanking[0].count;
  els.sizeRanking.innerHTML = sizeRanking.slice(0, 10).map(({ size, count }) => {
    const pct = max > 0 ? ((count / max) * 100).toFixed(1) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(size)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-count">${count}</span>
      </div>`;
  }).join('');
}

// ── Speed buckets ─────────────────────────────────────────────────────────────

function renderSpeedBuckets(timeBuckets, trackedTimesCount) {
  const buckets = [
    { key: 'lt1',   label: '< 1 hora',   cls: 'speed-lt1',   count: timeBuckets?.lt1h   ?? 0 },
    { key: '1_6',   label: '1 – 6 h',    cls: 'speed-1_6',   count: timeBuckets?.['1_6h']   ?? 0 },
    { key: '6_24',  label: '6 – 24 h',   cls: 'speed-6_24',  count: timeBuckets?.['6_24h']  ?? 0 },
    { key: '24_72', label: '1 – 3 días', cls: 'speed-24_72', count: timeBuckets?.['24_72h'] ?? 0 },
    { key: 'gt72',  label: '> 3 días',   cls: 'speed-gt72',  count: timeBuckets?.gt72h  ?? 0 },
  ];

  const total = buckets.reduce((s, b) => s + b.count, 0);

  if (total === 0) {
    els.speedBuckets.innerHTML = '';
    els.speedEmpty.style.display = 'block';
    return;
  }
  els.speedEmpty.style.display = 'none';

  els.speedBuckets.innerHTML = buckets.map(({ label, cls, count }) => {
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(label)}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
        <span class="bar-count">${count}</span>
      </div>`;
  }).join('');
}

// ── Price distribution ────────────────────────────────────────────────────────

function renderPriceDist(priceDistribution) {
  if (!priceDistribution || priceDistribution.length === 0) {
    els.priceDist.innerHTML = '';
    els.priceEmpty.style.display = 'block';
    return;
  }
  els.priceEmpty.style.display = 'none';

  const max = Math.max(...priceDistribution.map((b) => b.count));

  els.priceDist.innerHTML = priceDistribution.map(({ label, count }) => {
    const heightPct = max > 0 ? ((count / max) * 68).toFixed(0) : 2; // max height 68px
    return `
      <div class="price-bar-col" title="${esc(label)}: ${count} art.">
        <div class="price-bar-inner" style="height:${heightPct}px"></div>
        <span class="price-bar-label">${esc(label)}</span>
      </div>`;
  }).join('');
}

// ── Top sellers ───────────────────────────────────────────────────────────────

function renderTopSellers(topSellers) {
  if (!topSellers || topSellers.length === 0) {
    els.sellersTable.innerHTML = '';
    els.sellersEmpty.style.display = 'block';
    els.sellersCountBadge.textContent = 0;
    return;
  }
  els.sellersEmpty.style.display = 'none';
  els.sellersCountBadge.textContent = topSellers.length;

  const header = `
    <div class="sellers-header">
      <span>#</span>
      <span>Vendedor</span>
      <span>Ventas</span>
      <span>Precio avg</span>
    </div>`;

  const rows = topSellers.map((s, i) => {
    const rank      = i + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : '';
    const profileUrl = s.sellerId
      ? `https://www.vinted.es/member/${esc(s.sellerId)}-${esc(s.seller)}`
      : `https://www.vinted.es/catalog?search_text=${encodeURIComponent(s.seller || '')}`;
    return `
      <div class="seller-row">
        <span class="seller-rank ${rankClass}">${rank}</span>
        <a class="seller-name" href="${profileUrl}" target="_blank" rel="noopener">${esc(s.seller || 'Desconocido')}</a>
        <span class="seller-sales">${s.count}</span>
        <span class="seller-price">${fmtPrice(s.avgPrice)}</span>
      </div>`;
  }).join('');

  els.sellersTable.innerHTML = header + rows;
}

// ── Item lists (sold + active) ────────────────────────────────────────────────

function renderItemList(items, listEl, badgeEl) {
  if (!badgeEl && !listEl) return;
  const count = Array.isArray(items) ? items.length : 0;
  if (badgeEl) badgeEl.textContent = count;

  if (!listEl) return;
  if (count === 0) {
    listEl.innerHTML = '<p class="empty-note">Sin artículos aún</p>';
    return;
  }

  listEl.innerHTML = items.map((item) => {
    const tags = [];
    if (item.size)   tags.push(`<span class="item-tag">${esc(item.size)}</span>`);
    if (item.seller) tags.push(`<span class="item-tag seller">@${esc(item.seller)}</span>`);
    if (item.timeToSellHours != null) {
      tags.push(`<span class="item-tag speed">⚡ ${fmtHours(item.timeToSellHours)}</span>`);
    }
    const metaHtml = tags.length ? `<div class="item-meta">${tags.join('')}</div>` : '';
    return `
      <a class="item-row" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">
        <div class="item-left">
          <span class="item-title">${esc(item.title)}</span>
          ${metaHtml}
        </div>
        <div class="item-right">
          <span class="item-price">${esc(item.priceText || (item.price != null ? `${Number(item.price).toFixed(2)}€` : '—'))}</span>
        </div>
      </a>`;
  }).join('');
}

// ── Full results render ───────────────────────────────────────────────────────

function renderResults(analysis) {
  const { query, results } = analysis;
  if (!results) return;

  if (els.title) els.title.textContent = `Análisis: ${query}`;

  renderKpis(results);
  renderSizeRanking(results.sizeRanking);
  renderSpeedBuckets(results.timeBuckets, results.trackedTimesCount);
  renderPriceDist(results.priceDistribution);
  renderTopSellers(results.topSellers);
  renderItemList(results.recentSold,    els.soldList,   els.soldCountBadge);
  renderItemList(results.currentActive, els.activeList, els.activeCountBadge);
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function refreshAnalysis() {
  try {
    const resp = await send('rb:marketplace-get-analysis');
    if (!resp?.success) return;
    currentAnalysis = resp.analysis;
  } catch (_) {}

  if (!currentAnalysis) {
    showView('empty');
    updateSidebarStatus(null);
    stopPolling();
    return;
  }

  updateSidebarStatus(currentAnalysis);

  const { status, scanCount, results } = currentAnalysis;

  if (status === 'running' && scanCount === 0) {
    // Analysis started but no scan yet
    showView('loading');
  } else if (results) {
    showView('results');
    renderResults(currentAnalysis);
  } else {
    showView('empty');
  }

  // Keep polling only while running
  if (status !== 'running') stopPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshAnalysis, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function handleStart() {
  const query = String(els.query?.value || '').trim();
  if (!query) {
    setStatus('Escribe un modelo para analizar', 'warn');
    els.query?.focus();
    return;
  }

  if (els.startBtn) els.startBtn.disabled = true;
  setStatus('Iniciando análisis…', 'info');

  try {
    const resp = await send('rb:marketplace-start-analysis', { query });
    if (!resp?.success) throw new Error(resp?.error || 'Error desconocido');
    currentAnalysis = resp.analysis;
    setStatus('Análisis iniciado ✓', 'ok');
    updateSidebarStatus(currentAnalysis);
    showView('loading');
    startPolling();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    if (els.startBtn) els.startBtn.disabled = false;
  }
}

async function handleStop() {
  if (els.stopBtn) els.stopBtn.disabled = true;
  setStatus('Deteniendo…', '');
  try {
    await send('rb:marketplace-stop-analysis');
    setStatus('Análisis detenido', 'warn');
    stopPolling();
    await refreshAnalysis();
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    if (els.stopBtn) els.stopBtn.disabled = false;
  }
}

async function handleScanNow() {
  if (els.scanNowBtn) els.scanNowBtn.disabled = true;
  setStatus('Iniciando escaneo manual…', 'info');
  try {
    const resp = await send('rb:marketplace-scan-now');
    setStatus(resp?.success ? 'Escaneo en progreso…' : (resp?.error || 'Error'), resp?.success ? 'ok' : 'error');
    // Give it a few seconds then refresh
    setTimeout(refreshAnalysis, 5000);
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    setTimeout(() => { if (els.scanNowBtn) els.scanNowBtn.disabled = false; }, 4000);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

if (els.startBtn)   els.startBtn.addEventListener('click', handleStart);
if (els.stopBtn)    els.stopBtn.addEventListener('click', handleStop);
if (els.scanNowBtn) els.scanNowBtn.addEventListener('click', handleScanNow);
if (els.query) {
  els.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleStart(); });
}

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('load', async () => {
  if (els.query) els.query.focus();

  // Load any existing analysis on page open
  await refreshAnalysis();

  // Auto-start polling if analysis is running
  if (currentAnalysis?.status === 'running') startPolling();
});
