import { renderInsightsModules, runInsightsModules } from './modules/insights/index.js';

const els = {
  statusLine: document.getElementById('status-line'),
  startMonitor: document.getElementById('start-monitor'),
  stopMonitor: document.getElementById('stop-monitor'),
  detectNow: document.getElementById('detect-now'),
  trackNow: document.getElementById('track-now'),
  clearSold: document.getElementById('clear-sold'),
  resetAll: document.getElementById('reset-all'),
  saveUrl: document.getElementById('save-url'),
  refreshNow: document.getElementById('refresh-now'),
  exportCsv: document.getElementById('export-csv'),
  productName: document.getElementById('product-name'),
  searchUrls: document.getElementById('search-urls'),
  autoRefresh: document.getElementById('auto-refresh'),
  analysisMenuButton: document.getElementById('analysis-menu-btn'),
  openActionsModule: document.getElementById('open-actions-module'),
  openMarketplaceBtn: document.getElementById('open-marketplace-btn'),
  openMarketplaceSidebarBtn: document.getElementById('open-marketplace-sidebar-btn'),
  openCuentaVintedBtn: document.getElementById('open-cuenta-vinted-btn'),
  analysisMenuOverlay: document.getElementById('analysis-menu-overlay'),
  analysisMenuClose: document.getElementById('analysis-menu-close'),
  analysisMenuCancel: document.getElementById('analysis-menu-cancel'),
  analysisMenuCreate: document.getElementById('analysis-menu-create'),
  analysisMenuList: document.getElementById('analysis-menu-list'),
  analysisMenuSubtitle: document.getElementById('analysis-menu-subtitle'),
  analysisMenuProgress: document.getElementById('analysis-menu-progress'),
  analysisMenuProgressFill: document.getElementById('analysis-menu-progress-fill'),
  analysisMenuProgressLabel: document.getElementById('analysis-menu-progress-label'),
  pauseRequiredOverlay: document.getElementById('pause-required-overlay'),
  pauseRequiredClose: document.getElementById('pause-required-close'),
  pauseRequiredOk: document.getElementById('pause-required-ok'),
  pauseRequiredText: document.getElementById('pause-required-text'),
  analysisMaturityNote: document.getElementById('analysis-maturity-note'),
  analysisMaturityFill: document.getElementById('analysis-maturity-fill'),
  deterministicTimerPanel: document.getElementById('deterministic-timer-panel'),
  deterministicCountdown: document.getElementById('deterministic-countdown'),
  deterministicCountdownNote: document.getElementById('deterministic-countdown-note'),
  deterministicProgressFill: document.getElementById('deterministic-progress-fill'),
  monitorPanel: document.getElementById('monitor-panel'),
  soldPanel: document.getElementById('sold-panel'),

  kpiTotal: document.getElementById('kpi-total'),
  kpiActive: document.getElementById('kpi-active'),
  kpiReserved: document.getElementById('kpi-reserved'),
  kpiSold: document.getElementById('kpi-sold'),
  kpiExpired: document.getElementById('kpi-expired'),
  kpiBlockedAccounts: document.getElementById('kpi-blocked-accounts'),
  kpiAvgTime: document.getElementById('kpi-avg-time'),
  kpiAvgPrice: document.getElementById('kpi-avg-price'),
  profitTodayValue: document.getElementById('profit-today-value'),
  profitTodayNote: document.getElementById('profit-today-note'),
  profitTodayUnits: document.getElementById('profit-today-units'),
  profitTodayCost: document.getElementById('profit-today-cost'),

  chartTopModels: document.getElementById('chart-top-models'),
  chartRentableLinks: document.getElementById('chart-rentable-links'),
  chartSpeed: document.getElementById('chart-speed'),
  keywordFixedLegend: document.getElementById('keyword-fixed-legend'),
  keywordWindow: document.getElementById('keyword-window'),
  keywordTrendChart: document.getElementById('keyword-trend-chart'),
  keywordAvgBars: document.getElementById('keyword-avg-bars'),
  esfuerzoChart: document.getElementById('esfuerzo-chart'),
  esfuerzoPeak: document.getElementById('esfuerzo-peak'),
  insightSaturation: document.getElementById('insight-saturation'),
  insightPublications: document.getElementById('insight-publications'),
  insightSales: document.getElementById('insight-sales'),
  insightSummary: document.getElementById('insight-summary'),

  filterStatus: document.getElementById('filter-status'),
  filterModel: document.getElementById('filter-model'),
  filterPopular: document.getElementById('filter-popular'),
  filterMinLikes: document.getElementById('filter-min-likes'),
  filterMinViews: document.getElementById('filter-min-views'),
  resetFilters: document.getElementById('reset-filters'),

  soldCount: document.getElementById('sold-count'),
  soldBody: document.getElementById('sold-body'),
  blockedAccountsCount: document.getElementById('blocked-accounts-count'),
  blockedAccountsBody: document.getElementById('blocked-accounts-body'),
  tableCount: document.getElementById('table-count'),
  itemsBody: document.getElementById('items-body'),

  setupScreen: document.getElementById('setup-screen'),
  setupProductName: document.getElementById('setup-product-name'),
  setupUnitCost: document.getElementById('setup-unit-cost'),
  setupCategory: document.getElementById('setup-category'),
  setupPriceFrom: document.getElementById('setup-price-from'),
  setupPriceTo: document.getElementById('setup-price-to'),
  setupPriceChips: document.querySelectorAll('.setup-price-chip[data-from]'),
  setupPriceClear: document.getElementById('setup-price-clear'),
  setupStartMonitor: document.getElementById('setup-start-monitor'),
  setupMsg: document.getElementById('setup-msg'),
  setupLoadingOverlay: document.getElementById('setup-loading-overlay'),
  setupLoadingText: document.getElementById('setup-loading-text'),

  timelineMetric: document.getElementById('timeline-metric'),
  detailEmpty: document.getElementById('detail-empty'),
  detailContent: document.getElementById('detail-content'),
  detailLink: document.getElementById('detail-link'),
  detailMeta: document.getElementById('detail-meta'),
  timelineStats: document.getElementById('timeline-stats'),
  timelineChart: document.getElementById('timeline-chart'),
};
const MODEL_COMPARE_COLORS = [
  '#60a5fa',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
  '#38bdf8',
  '#c084fc',
  '#4ade80',
];
const MAX_COMPARE_MODELS = 8;
const EXTENSION_VERSION = chrome.runtime.getManifest()?.version || '0.0.0';
const EXPORT_MIN_ANALYSIS_MS = 12 * 60 * 60 * 1000;
const ANALYSIS_DETERMINISTIC_MS = 24 * 60 * 60 * 1000;
const SETUP_LOADING_MIN_MS = 5000;

const app = {
  state: null,
  config: null,
  scheduler: null,
  items: [],
  filteredItems: [],
  tableSort: {
    monitored: { key: 'detectedAt', direction: 'desc' },
    sold: { key: 'soldAt', direction: 'desc' },
  },
  selectedItemId: null,
  autoRefreshTimer: null,
  loading: false,
  keywordSelection: {
    window: '30d',
  },
  filters: {
    status: 'all',
    model: '',
    popular: 'all',
    minLikes: 0,
    minViews: 0,
  },
  statusMessage: '',
  statusTicker: null,
  lastForcedRefreshAt: 0,
  lastAutoSearchUrl: '',
  analyses: [],
  activeAnalysisId: null,
  analysisMenuContext: null,
  analysisMenuBusy: false,
  analysisMenuProgressPct: 0,
  analysisMenuProgressTimer: null,
  analysisMenuProgressStartAt: 0,
  analysisMenuProgressLabel: '',
};

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (value) => resolve(value || {}));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve());
  });
}

function waitMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, n);
  });
}

async function withTimeout(promise, timeoutMs = 20000, timeoutCode = 'request_timeout') {
  const ms = Math.max(1000, Number(timeoutMs) || 20000);
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutCode)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nowStamp() {
  return new Date().toLocaleTimeString();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePriceValue(priceText) {
  if (!priceText) return null;
  const m = String(priceText).replace(/\s+/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseUnitCostInput(rawValue) {
  if (rawValue == null) return null;
  const text = String(rawValue).trim();
  if (!text) return null;
  const normalized = text.replace(/\s+/g, '').replace(',', '.');
  let value = Number(normalized);
  if (!Number.isFinite(value)) {
    const fallbackMatch = text.match(/-?\d+(?:[.,]\d+)?/);
    if (!fallbackMatch) return null;
    value = Number(String(fallbackMatch[0]).replace(',', '.'));
  }
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

function formatUnitCostForInput(value) {
  const n = toNumber(value);
  if (n === null || n < 0) return '';
  return n.toFixed(2);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

function getValidTimeMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function formatRelativeTime(isoDate) {
  const targetMs = getValidTimeMs(isoDate);
  if (!targetMs) return null;
  const diffMs = Date.now() - targetMs;
  if (diffMs < 0) return null;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return 'hace unos segundos';
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.floor(seconds / 60));
    return `hace ${minutes} min`;
  }
  if (seconds < 86400) {
    const hours = Math.max(1, Math.floor(seconds / 3600));
    return `hace ${hours} h`;
  }
  const days = Math.max(1, Math.floor(seconds / 86400));
  return `hace ${days} d`;
}

function formatDateWithRelative(isoDate, fallback = '-') {
  const absolute = fmtDate(isoDate);
  if (absolute === '-') return fallback;
  const relative = formatRelativeTime(isoDate);
  return relative ? `${absolute} (${relative})` : absolute;
}

function fmtPrice(value) {
  const n = toNumber(value);
  if (n === null) return '-';
  return `${n.toFixed(2)}€`;
}

function fmtMinutesAsHours(minutes) {
  const n = toNumber(minutes);
  if (n === null) return '-';
  if (n < 60) return `${n.toFixed(0)} min`;
  return `${(n / 60).toFixed(2)} h`;
}

function fmtCount(value) {
  const n = toNumber(value);
  return n === null ? '-' : String(n);
}

function formatDurationCompact(ms) {
  const raw = Math.max(0, Number(ms) || 0);
  const minutesTotal = Math.floor(raw / 60000);
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}

function formatDurationHms(ms) {
  const raw = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.floor(raw / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getAnalysisStartMsFromSnapshot(state, items) {
  const metrics = state?.metrics || {};
  const startedAt = metrics.firstMonitorStartAt || metrics.lastMonitorStartAt || null;
  const startMs = new Date(startedAt || 0).getTime();
  if (Number.isFinite(startMs) && startMs > 0) {
    return startMs;
  }

  const safeItems = Array.isArray(items) ? items : [];
  const timestamps = safeItems
    .map((item) => new Date(item?.detectedAt || 0).getTime())
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  if (!timestamps.length) return null;
  return Math.min(...timestamps);
}

function getAnalysisAgeMsFromSnapshot(state, items) {
  const startMs = getAnalysisStartMsFromSnapshot(state, items);
  if (!Number.isFinite(startMs) || startMs <= 0) return 0;
  return Math.max(0, Date.now() - startMs);
}

function getAnalysisStartMs() {
  return getAnalysisStartMsFromSnapshot(app.state, app.items);
}

function getAnalysisAgeMs() {
  return getAnalysisAgeMsFromSnapshot(app.state, app.items);
}

function getExportGateInfoFromAge(ageMsInput) {
  const ageMs = Math.max(0, Number(ageMsInput) || 0);
  const remainingMs = Math.max(0, EXPORT_MIN_ANALYSIS_MS - ageMs);
  const ready = remainingMs === 0;
  const progress = Math.max(0, Math.min(1, ageMs / EXPORT_MIN_ANALYSIS_MS));
  return {
    ageMs,
    remainingMs,
    ready,
    progress,
  };
}

function getExportGateInfoFromSnapshot(state, items) {
  return getExportGateInfoFromAge(getAnalysisAgeMsFromSnapshot(state, items));
}

function getExportGateInfo() {
  return getExportGateInfoFromSnapshot(app.state, app.items);
}

function getExportGateInfoForAnalysisSummary(analysis) {
  const metrics = analysis?.metrics || {};
  let ageMs = Number(metrics.analysisAgeMs);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    const startRaw = metrics.analysisStartAt || metrics.firstMonitorStartAt || metrics.lastMonitorStartAt || null;
    const startMs = new Date(startRaw || 0).getTime();
    ageMs = Number.isFinite(startMs) && startMs > 0 ? Math.max(0, Date.now() - startMs) : 0;
  }
  return getExportGateInfoFromAge(ageMs);
}

function renderAnalysisMaturity() {
  const gate = getExportGateInfo();
  if (els.analysisMaturityFill) {
    els.analysisMaturityFill.style.width = `${Math.round(gate.progress * 100)}%`;
  }
  if (!els.analysisMaturityNote) return;

  const elapsed = formatDurationCompact(gate.ageMs);
  if (gate.ready) {
    els.analysisMaturityNote.textContent =
      `Muestra estable (${elapsed}). El informe CSV ya tiene base suficiente para modelos, tiempos y precios.`;
    els.analysisMaturityNote.style.color = '#86efac';
    return;
  }

  const remaining = formatDurationCompact(gate.remainingMs);
  const progressPct = Math.round(gate.progress * 100);
  let phase = 'Fase inicial';
  if (gate.progress >= 0.66) {
    phase = 'Fase avanzada';
  } else if (gate.progress >= 0.33) {
    phase = 'Fase de aprendizaje';
  }
  els.analysisMaturityNote.textContent =
    `${phase}: ${progressPct}% completado (${elapsed} acumulado). Para un informe fiable, espera ${remaining} mas.`;
  els.analysisMaturityNote.style.color = '#fcd34d';
}

function updateExportButtonState() {
  if (!els.exportCsv) return;
  const gate = getExportGateInfo();
  els.exportCsv.disabled = !gate.ready;
  if (gate.ready) {
    els.exportCsv.title = 'Exportar informe CSV profesional';
  } else {
    els.exportCsv.title = `Disponible en ${formatDurationCompact(gate.remainingMs)}`;
  }
}

function getDeterministicGateInfo() {
  const startMs = getAnalysisStartMs();
  const ageMs = startMs ? Math.max(0, Date.now() - startMs) : 0;
  const remainingMs = Math.max(0, ANALYSIS_DETERMINISTIC_MS - ageMs);
  const ready = remainingMs === 0;
  const progress = Math.max(0, Math.min(1, ageMs / ANALYSIS_DETERMINISTIC_MS));
  const targetMs = startMs ? startMs + ANALYSIS_DETERMINISTIC_MS : null;
  return {
    startMs,
    ageMs,
    remainingMs,
    ready,
    progress,
    targetMs,
  };
}

function renderDeterministicCountdown() {
  if (!els.deterministicTimerPanel || !els.deterministicCountdown || !els.deterministicCountdownNote) return;
  const info = getDeterministicGateInfo();
  const panel = els.deterministicTimerPanel;
  panel.classList.toggle('is-ready', info.ready);

  if (!info.startMs) {
    els.deterministicCountdown.textContent = '24:00:00';
    els.deterministicCountdownNote.textContent =
      'Inicia el monitor para arrancar el temporizador de 24h.';
    if (els.deterministicProgressFill) {
      els.deterministicProgressFill.style.width = '0%';
    }
    return;
  }

  if (info.ready) {
    els.deterministicCountdown.textContent = '00:00:00';
    els.deterministicCountdownNote.textContent = `Datos deterministas listos desde ${fmtDate(info.targetMs)}.`;
    if (els.deterministicProgressFill) {
      els.deterministicProgressFill.style.width = '100%';
    }
    return;
  }

  els.deterministicCountdown.textContent = formatDurationHms(info.remainingMs);
  els.deterministicCountdownNote.textContent =
    `Objetivo estimado: ${fmtDate(info.targetMs)} | Tiempo acumulado: ${formatDurationCompact(info.ageMs)}.`;
  if (els.deterministicProgressFill) {
    els.deterministicProgressFill.style.width = `${Math.round(info.progress * 100)}%`;
  }
}

function positionSoldPanelByCount() {
  const panel = els.soldPanel;
  const monitorPanel = els.monitorPanel;
  if (!panel || !monitorPanel) return;
  if (panel.nextElementSibling !== monitorPanel) {
    monitorPanel.parentElement?.insertBefore(panel, monitorPanel);
  }
}

function parseSearchUrlsInput(raw) {
  const urls = String(raw || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => v.startsWith('https://www.vinted.es/'));
  return [...new Set(urls)];
}

function buildAutoSearchUrl(productName, { category = '', priceFrom = '', priceTo = '' } = {}) {
  const term = String(productName || '').trim();
  const encoded = encodeURIComponent(term);
  let url = `https://www.vinted.es/catalog?search_text=${encoded}&order=newest_first&page=1&status_ids[]=6&status_ids[]=1`;

  // Category filters
  if (category === 'shoes') {
    url += '&catalog[]=16&catalog[]=1231';
  } else if (category === 'clothing') {
    url += '&catalog[]=4';
  }

  // Price range filters
  const from = parseFloat(String(priceFrom).trim());
  const to   = parseFloat(String(priceTo).trim());
  if (!isNaN(from) && from >= 0) url += `&price_from=${from}`;
  if (!isNaN(to)   && to   >= 0) url += `&price_to=${to}`;

  return url;
}

function syncDashboardAutoUrlFromProduct({ forceTextarea = false } = {}) {
  if (!els.productName) return;
  const rawName = String(els.productName.value || '').trim();
  const fallbackName = rawName || 'rayban';
  const generated = buildAutoSearchUrl(fallbackName);

  if (!els.searchUrls) {
    app.lastAutoSearchUrl = generated;
    return;
  }

  const current = String(els.searchUrls.value || '').trim();
  const previousAuto = String(app.lastAutoSearchUrl || '').trim();
  if (forceTextarea || !current || current === previousAuto) {
    els.searchUrls.value = generated;
  }
  app.lastAutoSearchUrl = generated;
}


function setMonitorUi(config) {
  const enabled = config?.monitorEnabled === true;
  if (els.startMonitor) {
    els.startMonitor.disabled = enabled;
  }
  if (els.stopMonitor) {
    els.stopMonitor.disabled = !enabled;
  }
  if (els.detectNow) {
    els.detectNow.disabled = !enabled;
  }
  if (els.trackNow) {
    els.trackNow.disabled = !enabled;
  }
  if (els.clearSold) {
    els.clearSold.disabled = !enabled;
  }
  if (els.analysisMenuButton) {
    els.analysisMenuButton.disabled = false;
    els.analysisMenuButton.title = enabled
      ? 'Primero debes pausar el analisis para volver al menu.'
      : 'Abrir menu de analisis';
  }
}

async function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

function getStatusBadgeClass(status) {
  if (status === 'sold') return 'status-sold';
  if (status === 'reserved') return 'status-reserved';
  return 'status-active';
}

function getModelLabel(item) {
  return item.modelName || 'desconocido';
}

function getSellerStatusLabel(item) {
  const map = {
    active: 'activa',
    blocked: 'bloqueada',
    unknown: 'desconocida',
  };
  return map[item?.sellerAccountStatus] || 'desconocida';
}

function extractSellerMemberId(profileUrl) {
  const value = String(profileUrl || '').trim();
  const match = value.match(/\/member\/(\d+)/i);
  return match?.[1] || '';
}

function sellerBlockedSortScore(item) {
  const checkedTs = new Date(item?.sellerLastCheckedAt || 0).getTime();
  if (Number.isFinite(checkedTs)) return checkedTs;
  const soldTs = new Date(item?.soldAt || 0).getTime();
  if (Number.isFinite(soldTs)) return soldTs;
  const detectedTs = new Date(item?.detectedAt || 0).getTime();
  return Number.isFinite(detectedTs) ? detectedTs : 0;
}

function buildBlockedSellerRows(items) {
  const grouped = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (String(item?.sellerAccountStatus || '') !== 'blocked') continue;

    const sellerProfileUrl = String(item?.sellerProfileUrl || '').trim();
    const sellerName = String(item?.sellerName || '').trim();
    const sellerMemberId = extractSellerMemberId(sellerProfileUrl);
    const key =
      sellerMemberId ||
      sellerProfileUrl.toLowerCase() ||
      (sellerName ? `name:${sellerName.toLowerCase()}` : '') ||
      `item:${String(item?.itemId || '').trim()}`;
    const score = sellerBlockedSortScore(item);
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, {
        key,
        sellerMemberId: sellerMemberId || null,
        sellerName: sellerName || null,
        sellerProfileUrl: sellerProfileUrl || null,
        reason: String(item?.sellerAccountReason || '').trim() || 'Perfil marcado como bloqueado',
        checkedAt: item?.sellerLastCheckedAt || null,
        item,
        score,
        relatedProductsCount: 1,
      });
      continue;
    }

    existing.relatedProductsCount += 1;
    if (!existing.sellerName && sellerName) existing.sellerName = sellerName;
    if (!existing.sellerProfileUrl && sellerProfileUrl) existing.sellerProfileUrl = sellerProfileUrl;
    if (!existing.sellerMemberId && sellerMemberId) existing.sellerMemberId = sellerMemberId;

    if (score > existing.score) {
      existing.item = item;
      existing.score = score;
      existing.reason = String(item?.sellerAccountReason || '').trim() || existing.reason;
      existing.checkedAt = item?.sellerLastCheckedAt || existing.checkedAt || null;
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .map((entry) => ({
      ...entry,
      checkedAt: entry.checkedAt || entry.item?.sellerLastCheckedAt || null,
      reason: entry.reason || String(entry.item?.sellerAccountReason || '').trim() || 'Perfil marcado como bloqueado',
    }));
}

function normalizeSortText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getSortTimestamp(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function getSellerAccountSortRank(item) {
  const status = String(item?.sellerAccountStatus || 'unknown').trim().toLowerCase();
  const ranks = {
    blocked: 0,
    active: 1,
    unknown: 2,
  };
  return ranks[status] ?? 2;
}

function getDefaultSortDirection(table, key) {
  const defaults = {
    monitored: {
      itemId: 'desc',
      title: 'asc',
      status: 'asc',
      model: 'asc',
      price: 'desc',
      rank: 'asc',
      detectedAt: 'desc',
      timeToSellMinutes: 'asc',
    },
    sold: {
      itemId: 'desc',
      title: 'asc',
      sellerName: 'asc',
      sellerAccountStatus: 'asc',
      model: 'asc',
      soldPriceValue: 'desc',
      soldAt: 'desc',
      timeToSellMinutes: 'asc',
    },
  };
  return defaults?.[table]?.[key] === 'asc' ? 'asc' : 'desc';
}

function getMonitoredSortValue(item, key) {
  const latest = item?.latest || {};
  switch (key) {
    case 'itemId':
      return toNumber(item?.itemId);
    case 'title':
      return normalizeSortText(item?.title);
    case 'status':
      return normalizeSortText(item?.status);
    case 'model':
      return normalizeSortText(getModelLabel(item));
    case 'price':
      return toNumber(latest?.priceValue) ?? parsePriceValue(latest?.priceText || item?.soldPriceText || '');
    case 'rank':
      return toNumber(item?.firstSeenRank);
    case 'detectedAt':
      return getSortTimestamp(item?.detectedAt);
    case 'timeToSellMinutes':
      return toNumber(item?.timeToSellMinutes);
    default:
      return getSortTimestamp(item?.detectedAt);
  }
}

function getSoldSortValue(item, key) {
  switch (key) {
    case 'itemId':
      return toNumber(item?.itemId);
    case 'title':
      return normalizeSortText(item?.title);
    case 'sellerName':
      return normalizeSortText(item?.sellerName);
    case 'sellerAccountStatus':
      return getSellerAccountSortRank(item);
    case 'model':
      return normalizeSortText(getModelLabel(item));
    case 'soldPriceValue':
      return toNumber(item?.soldPriceValue) ?? parsePriceValue(item?.soldPriceText || item?.latest?.priceText || '');
    case 'soldAt':
      return getSortTimestamp(item?.soldAt);
    case 'timeToSellMinutes':
      return toNumber(item?.timeToSellMinutes);
    default:
      return getSortTimestamp(item?.soldAt);
  }
}

function compareSortValues(a, b, direction = 'asc') {
  const leftMissing = a == null || a === '';
  const rightMissing = b == null || b === '';

  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  let result = 0;
  if (typeof a === 'number' && typeof b === 'number') {
    result = a - b;
  } else {
    result = String(a).localeCompare(String(b), 'es', {
      sensitivity: 'base',
      numeric: true,
    });
  }

  if (result === 0) return 0;
  return direction === 'desc' ? -result : result;
}

function sortItemsByTable(items, table) {
  const list = Array.isArray(items) ? [...items] : [];
  const currentSort = app.tableSort?.[table] || {
    key: table === 'sold' ? 'soldAt' : 'detectedAt',
    direction: 'desc',
  };
  const getValue = table === 'sold' ? getSoldSortValue : getMonitoredSortValue;

  list.sort((a, b) => {
    const primary = compareSortValues(
      getValue(a, currentSort.key),
      getValue(b, currentSort.key),
      currentSort.direction
    );
    if (primary !== 0) return primary;

    const secondaryKey = table === 'sold' ? 'soldAt' : 'detectedAt';
    const secondary = compareSortValues(
      getValue(a, secondaryKey),
      getValue(b, secondaryKey),
      'desc'
    );
    if (secondary !== 0) return secondary;

    return compareSortValues(toNumber(a?.itemId), toNumber(b?.itemId), 'desc');
  });

  return list;
}

function toggleTableSort(table, key) {
  if (!table || !key) return;
  const current = app.tableSort?.[table] || null;
  const nextDirection =
    current?.key === key
      ? current.direction === 'asc'
        ? 'desc'
        : 'asc'
      : getDefaultSortDirection(table, key);

  app.tableSort = {
    ...(app.tableSort || {}),
    [table]: { key, direction: nextDirection },
  };
}

function renderSortHeaders() {
  const buttons = document.querySelectorAll('.sort-btn');
  buttons.forEach((button) => {
    const table = String(button.dataset.sortTable || '');
    const key = String(button.dataset.sortKey || '');
    const current = app.tableSort?.[table] || null;
    const active = current?.key === key;
    const direction = active ? current.direction : 'none';
    button.dataset.active = active ? 'true' : 'false';
    button.dataset.direction = direction;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.title = active
      ? `Orden actual: ${direction === 'asc' ? 'ascendente' : 'descendente'}`
      : 'Ordenar';
  });
}

function formatVintedSessionShort(session) {
  const s = session || {};
  if (s.loggedIn === true) {
    const handle = String(s.username || s.displayName || '').trim();
    if (handle) return `@${handle}`;
    if (s.memberId) return `id:${s.memberId}`;
    return 'logeada';
  }
  if (s.loggedIn === false || s.status === 'no_account') {
    return 'sin cuenta';
  }
  return 'desconocida';
}

function formatBrowserId(config) {
  const id = String(config?.browserId || '').trim();
  return id || 'NAV-SIN-ID';
}

function hasAnalysisStarted(state) {
  const metrics = state?.metrics || {};
  if (metrics?.firstMonitorStartAt || metrics?.lastMonitorStartAt) return true;
  if (Array.isArray(state?.items) && state.items.length > 0) return true;
  return false;
}


function clearAnalysisMenuProgressTimer() {
  if (!app.analysisMenuProgressTimer) return;
  clearInterval(app.analysisMenuProgressTimer);
  app.analysisMenuProgressTimer = null;
}

function renderAnalysisMenuProgress() {
  if (!els.analysisMenuProgress || !els.analysisMenuProgressFill) return;
  const visible = app.analysisMenuBusy === true;
  els.analysisMenuProgress.hidden = !visible;
  if (!visible) {
    els.analysisMenuProgressFill.style.width = '0%';
    if (els.analysisMenuProgressLabel) {
      els.analysisMenuProgressLabel.textContent = 'Procesando...';
    }
    return;
  }
  const pct = Math.max(0, Math.min(100, Number(app.analysisMenuProgressPct || 0)));
  els.analysisMenuProgressFill.style.width = `${pct.toFixed(0)}%`;
  if (els.analysisMenuProgressLabel) {
    els.analysisMenuProgressLabel.textContent = String(app.analysisMenuProgressLabel || 'Procesando...');
  }
}

function setAnalysisMenuBusy(visible, { label = 'Procesando...' } = {}) {
  const next = visible === true;
  app.analysisMenuBusy = next;
  if (!next) {
    clearAnalysisMenuProgressTimer();
    app.analysisMenuProgressPct = 0;
    app.analysisMenuProgressStartAt = 0;
    app.analysisMenuProgressLabel = '';
    renderAnalysisMenuProgress();
    return;
  }
  app.analysisMenuProgressLabel = String(label || 'Procesando...');
  app.analysisMenuProgressStartAt = Date.now();
  app.analysisMenuProgressPct = 12;
  renderAnalysisMenuProgress();
  clearAnalysisMenuProgressTimer();
  app.analysisMenuProgressTimer = setInterval(() => {
    const elapsed = Math.max(0, Date.now() - app.analysisMenuProgressStartAt);
    const target = 12 + Math.min(82, (elapsed / 12000) * 82);
    app.analysisMenuProgressPct = target;
    renderAnalysisMenuProgress();
  }, 180);
}

function getActiveAnalysisSummary() {
  if (!Array.isArray(app.analyses) || app.analyses.length === 0) return null;
  const target = String(app.activeAnalysisId || '').trim();
  if (!target) return null;
  return app.analyses.find((entry) => String(entry?.id || '') === target) || null;
}

function formatAnalysisUpdatedAt(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function setAnalysisMenuVisible(visible) {
  const isVisible = visible === true;
  if (els.analysisMenuOverlay) {
    els.analysisMenuOverlay.hidden = !isVisible;
  }
  document.body.classList.toggle('analysis-menu-open', isVisible);
}

function setPauseRequiredVisible(visible, message = 'Primero debes pausar el analisis para volver al menu.') {
  const isVisible = visible === true;
  if (els.pauseRequiredText) {
    els.pauseRequiredText.textContent = String(message || 'Primero debes pausar el analisis para volver al menu.');
  }
  if (els.pauseRequiredOverlay) {
    els.pauseRequiredOverlay.hidden = !isVisible;
  }
  document.body.classList.toggle('pause-required-open', isVisible);
}

function closeAnalysisMenu() {
  app.analysisMenuContext = null;
  setAnalysisMenuBusy(false);
  setAnalysisMenuVisible(false);
}

function renderAnalysisMenu() {
  if (!els.analysisMenuList) return;
  const context = app.analysisMenuContext || { source: 'dashboard', pendingStart: null };
  const source = context.source === 'setup' ? 'setup' : 'dashboard';
  const pending = context.pendingStart || null;
  const pendingName = String(pending?.productName || '').trim();

  if (els.analysisMenuClose) {
    els.analysisMenuClose.disabled = app.analysisMenuBusy;
  }
  if (els.analysisMenuCancel) {
    els.analysisMenuCancel.disabled = app.analysisMenuBusy;
    els.analysisMenuCancel.textContent = source === 'setup' ? 'Volver' : 'Cancelar';
  }
  if (els.analysisMenuCreate) {
    if (source === 'setup') {
      els.analysisMenuCreate.textContent = pendingName
        ? `Crear nuevo: ${pendingName}`
        : 'Crear nuevo analisis';
    } else {
      els.analysisMenuCreate.textContent = 'Nuevo analisis';
    }
    els.analysisMenuCreate.disabled = app.analysisMenuBusy;
  }
  if (els.analysisMenuSubtitle) {
    if (source === 'setup') {
      els.analysisMenuSubtitle.textContent = pendingName
        ? `Producto preparado: ${pendingName}. Elige crear uno nuevo o entrar a un analisis existente.`
        : 'Elige crear un analisis nuevo o entrar a uno existente.';
    } else {
      els.analysisMenuSubtitle.textContent = 'Selecciona un analisis para entrar y activarlo.';
    }
  }
  renderAnalysisMenuProgress();

  const analyses = Array.isArray(app.analyses) ? app.analyses : [];
  els.analysisMenuList.innerHTML = '';
  if (!analyses.length) {
    const empty = document.createElement('div');
    empty.className = 'analysis-menu-empty';
    empty.textContent = 'No hay analisis creados todavia.';
    els.analysisMenuList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of analyses) {
    const wrapper = document.createElement('article');
    wrapper.className = 'analysis-menu-item';
    if (String(entry?.id || '') === String(app.activeAnalysisId || '')) {
      wrapper.classList.add('is-active');
    }

    const body = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = String(entry?.name || entry?.productName || 'Analisis');
    const subtitle = document.createElement('p');
    const stats = entry?.metrics || {};
    subtitle.textContent = `Producto: ${entry?.productName || '-'} | detectados: ${stats.totalDetected || 0} | activos: ${stats.active || 0} | vendidos: ${stats.sold || 0}`;

    const chips = document.createElement('div');
    chips.className = 'analysis-menu-meta';

    const chipUpdated = document.createElement('span');
    chipUpdated.className = 'analysis-menu-chip';
    chipUpdated.textContent = `Actualizado: ${formatAnalysisUpdatedAt(entry?.updatedAt)}`;
    chips.appendChild(chipUpdated);

    const chipLinks = document.createElement('span');
    chipLinks.className = 'analysis-menu-chip';
    chipLinks.textContent = `Links: ${Number(entry?.linksCount || 0)}`;
    chips.appendChild(chipLinks);

    if (entry?.isActive) {
      const chipActive = document.createElement('span');
      chipActive.className = 'analysis-menu-chip is-active';
      chipActive.textContent = 'Activo';
      chips.appendChild(chipActive);
    }

    body.appendChild(title);
    body.appendChild(subtitle);
    body.appendChild(chips);

    const actions = document.createElement('div');
    actions.className = 'analysis-actions';

    const openButton = document.createElement('button');
    openButton.className = 'analysis-open';
    openButton.textContent = 'Entrar';
    openButton.disabled = app.analysisMenuBusy;
    openButton.addEventListener('click', () => {
      void activateAnalysisFromMenu(String(entry?.id || ''));
    });
    actions.appendChild(openButton);

    const exportGate = getExportGateInfoForAnalysisSummary(entry);
    const exportButton = document.createElement('button');
    exportButton.className = 'ghost analysis-export';
    exportButton.textContent = exportGate.ready
      ? 'Exportar CSV'
      : `CSV ${formatDurationCompact(exportGate.remainingMs)}`;
    exportButton.disabled = app.analysisMenuBusy || !exportGate.ready;
    exportButton.title = exportGate.ready
      ? 'Exportar informe CSV de este analisis'
      : `Disponible tras 1h de analisis (${formatDurationCompact(exportGate.remainingMs)} restantes)`;
    exportButton.addEventListener('click', () => {
      void exportAnalysisFromMenu(String(entry?.id || ''));
    });
    actions.appendChild(exportButton);

    const editButton = document.createElement('button');
    editButton.className = 'ghost analysis-edit';
    editButton.textContent = 'Editar';
    editButton.disabled = app.analysisMenuBusy;
    editButton.addEventListener('click', () => {
      void editAnalysisFromMenu(String(entry?.id || ''));
    });
    actions.appendChild(editButton);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'ghost analysis-delete';
    deleteButton.textContent = 'Borrar';
    deleteButton.disabled = app.analysisMenuBusy;
    deleteButton.addEventListener('click', () => {
      void deleteAnalysisFromMenu(String(entry?.id || ''));
    });
    actions.appendChild(deleteButton);

    wrapper.appendChild(body);
    wrapper.appendChild(actions);
    fragment.appendChild(wrapper);
  }
  els.analysisMenuList.appendChild(fragment);
}

function setSetupMode(enabled) {
  if (els.setupScreen) {
    els.setupScreen.hidden = !enabled;
  }
  const shell = document.querySelector('.dashboard-shell');
  if (shell) {
    shell.hidden = enabled;
  }
}

function setSetupMessage(msg, _tone) {
  if (els.setupMsg) {
    els.setupMsg.textContent = msg || '';
  }
}

function setSetupLoading(enabled, text) {
  if (els.setupLoadingOverlay) {
    els.setupLoadingOverlay.hidden = !enabled;
  }
  if (els.setupLoadingText && text) {
    els.setupLoadingText.textContent = text;
  }
}

function setSetupAnalysisLocked(locked) {
  if (els.setupStartMonitor) els.setupStartMonitor.disabled = locked;
  if (els.setupProductName)  els.setupProductName.disabled  = locked;
  if (els.setupUnitCost)     els.setupUnitCost.disabled     = locked;
  if (els.setupCategory)     els.setupCategory.disabled     = locked;
  if (els.setupPriceFrom)    els.setupPriceFrom.disabled    = locked;
  if (els.setupPriceTo)      els.setupPriceTo.disabled      = locked;
  els.setupPriceChips?.forEach((c) => { c.disabled = locked; });
}

async function transitionSetupToDashboard() {
  setSetupMode(false);
  setSetupLoading(false);
}

function openAnalysisMenu({ source = 'dashboard', pendingStart = null } = {}) {
  app.analysisMenuContext = {
    source: source === 'setup' ? 'setup' : 'dashboard',
    pendingStart: pendingStart
      ? {
          productName: String(pendingStart.productName || '').trim(),
          searchUrls: Array.isArray(pendingStart.searchUrls) ? pendingStart.searchUrls : [],
          unitCost: parseUnitCostInput(pendingStart.unitCost),
        }
      : null,
  };
  setAnalysisMenuBusy(false);
  renderAnalysisMenu();
  setAnalysisMenuVisible(true);
}

async function refreshAnalyses() {
  const res = await send('rb:list-analyses');
  if (!res?.success) return;
  app.analyses = Array.isArray(res.analyses) ? res.analyses : [];
  app.activeAnalysisId = res.activeId || null;
}

async function createAnalysisFromMenu() {
  const context = app.analysisMenuContext || { source: 'dashboard', pendingStart: null };
  const source = context.source === 'setup' ? 'setup' : 'dashboard';
  const pending = context.pendingStart || null;

  if (source !== 'setup') {
    closeAnalysisMenu();
    try {
      await send('rb:stop-monitoring');
    } catch (_) {
      // no-op
    }
    await loadState();
    setSetupMode(true);
    setSetupMessage('Define el producto y pulsa iniciar para crear un analisis nuevo.', 'muted');
    if (els.setupProductName) {
      els.setupProductName.focus();
    }
    return;
  }

  const productName = String(pending?.productName || '').trim();
  const searchUrls = Array.isArray(pending?.searchUrls) ? pending.searchUrls : [];
  const unitCost = parseUnitCostInput(pending?.unitCost);
  if (!productName || !searchUrls.length) {
    const msg = 'No se pudo preparar el analisis nuevo. Vuelve a iniciar desde el paso 2.';
    setSetupMessage(msg, 'error');
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    return;
  }

  setAnalysisMenuBusy(true, { label: 'Creando analisis nuevo...' });
  renderAnalysisMenu();
  const startedAt = Date.now();
  setSetupLoading(true, 'Creando analisis...');
  try {
    const response = await withTimeout(
      send('rb:create-analysis', {
        name: productName,
        productName,
        searchUrls,
        unitCost,
        startMonitoring: true,
      }),
      22000,
      'create_analysis_timeout'
    );
    if (!response?.success || !response?.result?.ok) {
      throw new Error(response?.error || response?.result?.error || 'create_analysis_failed');
    }
    await loadState();
    await waitMs(Math.max(0, SETUP_LOADING_MIN_MS - (Date.now() - startedAt)));
    closeAnalysisMenu();
    await transitionSetupToDashboard();
    setSetupMessage('Analisis creado y arrancado correctamente.', 'ok');
  } catch (err) {
    const code = String(err?.message || 'error');
    const msg = code === 'create_analysis_timeout'
      ? 'La operacion tardo demasiado. Se desbloqueo el menu, vuelve a intentarlo.'
      : `No se pudo crear el analisis: ${code}`;
    setSetupMessage(msg, 'error');
    if (els.analysisMenuSubtitle) {
      els.analysisMenuSubtitle.textContent = msg;
    }
  } finally {
    setSetupLoading(false);
    setAnalysisMenuBusy(false);
    renderAnalysisMenu();
  }
}

async function activateAnalysisFromMenu(analysisId) {
  const id = String(analysisId || '').trim();
  if (!id) return;
  const context = app.analysisMenuContext || { source: 'dashboard', pendingStart: null };
  const source = context.source === 'setup' ? 'setup' : 'dashboard';
  const pendingStart = context.pendingStart || null;
  setAnalysisMenuBusy(true, { label: source === 'setup' ? 'Abriendo analisis...' : 'Activando analisis...' });
  renderAnalysisMenu();
  const startedAt = Date.now();
  if (source === 'setup') {
    setSetupLoading(true, 'Abriendo analisis...');
  }
  try {
    const pendingUnitCost = parseUnitCostInput(pendingStart?.unitCost);
    if (source === 'setup' && pendingUnitCost !== null) {
      const updateConfigResponse = await withTimeout(
        send('rb:update-analysis-config', {
          analysisId: id,
          configPatch: {
            unitCost: pendingUnitCost,
          },
        }),
        18000,
        'update_analysis_config_timeout'
      );
      if (!updateConfigResponse?.success || !updateConfigResponse?.result?.ok) {
        throw new Error(
          updateConfigResponse?.error ||
          updateConfigResponse?.result?.error ||
          'update_analysis_config_failed'
        );
      }
    }
    const response = await withTimeout(
      send('rb:activate-analysis', {
        analysisId: id,
        startMonitoring: true,
      }),
      22000,
      'activate_analysis_timeout'
    );
    if (!response?.success || !response?.result?.ok) {
      throw new Error(response?.error || response?.result?.error || 'activate_analysis_failed');
    }
    await loadState();
    if (source === 'setup') {
      await waitMs(Math.max(0, SETUP_LOADING_MIN_MS - (Date.now() - startedAt)));
      closeAnalysisMenu();
      await transitionSetupToDashboard();
      setSetupMessage('Analisis cargado correctamente.', 'ok');
    } else {
      closeAnalysisMenu();
      const active = getActiveAnalysisSummary();
      updateStatusLine(
        app.state?.metrics || {},
        `Analisis activo: ${active?.name || active?.productName || 'seleccionado'}`
      );
    }
  } catch (err) {
    const code = String(err?.message || 'error');
    const msg = code === 'activate_analysis_timeout'
      ? 'La operacion tardo demasiado. El menu se desbloqueo, vuelve a intentarlo.'
      : code === 'update_analysis_config_timeout'
        ? 'No se pudo guardar el coste de unidad a tiempo. Vuelve a intentarlo.'
        : `No se pudo abrir el analisis: ${code}`;
    if (source === 'setup') {
      setSetupMessage(msg, 'error');
    } else {
      updateStatusLine(app.state?.metrics || {}, msg);
    }
    if (els.analysisMenuSubtitle) {
      els.analysisMenuSubtitle.textContent = msg;
    }
  } finally {
    if (source === 'setup') {
      setSetupLoading(false);
    }
    setAnalysisMenuBusy(false);
    renderAnalysisMenu();
  }
}

async function editAnalysisFromMenu(analysisId) {
  const id = String(analysisId || '').trim();
  if (!id || app.analysisMenuBusy) return;
  const current = (Array.isArray(app.analyses) ? app.analyses : []).find((entry) => String(entry?.id || '') === id);
  if (!current) return;
  const currentName = String(current?.name || current?.productName || 'Analisis').trim() || 'Analisis';
  const nextRaw = window.prompt('Nuevo nombre del analisis:', currentName);
  if (nextRaw == null) return;
  const nextName = String(nextRaw || '').trim();
  if (!nextName) {
    const msg = 'Nombre invalido. Escribe al menos 1 caracter.';
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    return;
  }
  if (nextName === currentName) return;

  setAnalysisMenuBusy(true, { label: 'Guardando cambios del analisis...' });
  renderAnalysisMenu();
  try {
    const response = await withTimeout(
      send('rb:update-analysis', {
        analysisId: id,
        name: nextName,
      }),
      18000,
      'update_analysis_timeout'
    );
    if (!response?.success || !response?.result?.ok) {
      throw new Error(response?.error || response?.result?.error || 'update_analysis_failed');
    }
    await loadState();
    const msg = `Analisis renombrado a "${nextName}".`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
  } catch (err) {
    const code = String(err?.message || 'error');
    const msg = code === 'update_analysis_timeout'
      ? 'La actualizacion tardo demasiado. Vuelve a intentarlo.'
      : `No se pudo editar el analisis: ${code}`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
  } finally {
    setAnalysisMenuBusy(false);
    renderAnalysisMenu();
  }
}

async function deleteAnalysisFromMenu(analysisId) {
  const id = String(analysisId || '').trim();
  if (!id || app.analysisMenuBusy) return;
  const current = (Array.isArray(app.analyses) ? app.analyses : []).find((entry) => String(entry?.id || '') === id);
  if (!current) return;
  const label = String(current?.name || current?.productName || 'Analisis').trim() || 'Analisis';
  const confirmed = window.confirm(
    `Vas a borrar "${label}". Esta accion no se puede deshacer.`
  );
  if (!confirmed) return;

  setAnalysisMenuBusy(true, { label: 'Borrando analisis...' });
  renderAnalysisMenu();
  try {
    const response = await withTimeout(
      send('rb:delete-analysis', {
        analysisId: id,
      }),
      18000,
      'delete_analysis_timeout'
    );
    if (!response?.success || !response?.result?.ok) {
      throw new Error(response?.error || response?.result?.error || 'delete_analysis_failed');
    }
    await loadState();
    const msg = `Analisis eliminado: ${label}.`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
  } catch (err) {
    const code = String(err?.message || 'error');
    const msg = code === 'delete_analysis_timeout'
      ? 'La eliminacion tardo demasiado. Vuelve a intentarlo.'
      : `No se pudo borrar el analisis: ${code}`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
  } finally {
    setAnalysisMenuBusy(false);
    renderAnalysisMenu();
  }
}

async function exportAnalysisFromMenu(analysisId) {
  const id = String(analysisId || '').trim();
  if (!id || app.analysisMenuBusy) return;
  const current = (Array.isArray(app.analyses) ? app.analyses : []).find((entry) => String(entry?.id || '') === id);
  if (!current) return;
  const gate = getExportGateInfoForAnalysisSummary(current);
  if (!gate.ready) {
    const waitText = formatDurationCompact(gate.remainingMs);
    const msg = `CSV bloqueado para este analisis. Espera ${waitText} de monitor real.`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
    return;
  }

  const label = String(current?.name || current?.productName || 'Analisis').trim() || 'Analisis';
  setAnalysisMenuBusy(true, { label: `Preparando CSV: ${label}...` });
  renderAnalysisMenu();
  try {
    const response = await withTimeout(
      send('rb:get-analysis-snapshot', {
        analysisId: id,
      }),
      22000,
      'analysis_snapshot_timeout'
    );
    const snapshot = response?.result || {};
    if (!response?.success || !snapshot?.ok) {
      throw new Error(response?.error || snapshot?.error || 'analysis_snapshot_failed');
    }
    const state = snapshot?.state || { items: [], metrics: {} };
    const items = Array.isArray(state?.items) ? state.items : [];
    const config = snapshot?.config || {};
    const analysis = snapshot?.analysis || current;
    const snapshotGate = getExportGateInfoFromSnapshot(state, items);
    if (!snapshotGate.ready) {
      const msg = `CSV bloqueado: este analisis aun no llega a 1h (${formatDurationCompact(snapshotGate.remainingMs)} restantes).`;
      if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
      updateStatusLine(app.state?.metrics || {}, msg);
      return;
    }

    const fileName = exportAnalysisReportCsv({
      items,
      state,
      config,
      activeAnalysis: analysis,
      gateInfo: snapshotGate,
    });
    const okMsg = `Informe exportado (${label}): ${fileName}`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = okMsg;
    updateStatusLine(app.state?.metrics || {}, okMsg);
  } catch (err) {
    const code = String(err?.message || 'error');
    const msg = code === 'analysis_snapshot_timeout'
      ? 'La exportacion tardo demasiado. Vuelve a intentarlo.'
      : `No se pudo exportar el CSV: ${code}`;
    if (els.analysisMenuSubtitle) els.analysisMenuSubtitle.textContent = msg;
    updateStatusLine(app.state?.metrics || {}, msg);
  } finally {
    setAnalysisMenuBusy(false);
    renderAnalysisMenu();
  }
}


function updateStatusLine(metrics, message = null) {
  if (message !== null) {
    app.statusMessage = String(message || '');
  }
  const detectAt = metrics?.lastDetectRun ? `Deteccion: ${fmtDate(metrics.lastDetectRun)}` : 'Deteccion: -';
  const trackAt = metrics?.lastTrackRun ? `Analisis: ${fmtDate(metrics.lastTrackRun)}` : 'Analisis: -';
  const err = metrics?.lastError ? ` | Error: ${metrics.lastError}` : '';
  const extra = app.statusMessage ? ` | ${app.statusMessage}` : '';
  els.statusLine.textContent = `${detectAt} | ${trackAt}${extra}${err}`;
}

function startStatusTicker() {
  if (app.statusTicker) return;
  app.statusTicker = setInterval(() => {
    if (!app.state) return;
    updateStatusLine(app.state.metrics || {}, null);
    renderAnalysisMaturity();
    renderDeterministicCountdown();
    updateExportButtonState();
    if (els.analysisMenuOverlay && !els.analysisMenuOverlay.hidden && !app.analysisMenuBusy) {
      renderAnalysisMenu();
    }
    const scheduler = app.scheduler || null;
    if (!scheduler?.monitorEnabled || app.loading) return;
    const now = Date.now();
    if (now - app.lastForcedRefreshAt < 5000) return;
    app.lastForcedRefreshAt = now;
    void loadState();
  }, 1000);
}

function aggregateModelStats(soldItems) {
  const map = new Map();

  for (const item of soldItems) {
    const model = getModelLabel(item);
    const prev = map.get(model) || {
      soldCount: 0,
      sumMinutes: 0,
      sumPrice: 0,
      pricedCount: 0,
    };
    prev.soldCount += 1;
    if (toNumber(item.timeToSellMinutes) !== null) {
      prev.sumMinutes += Number(item.timeToSellMinutes);
    }
    if (toNumber(item.soldPriceValue) !== null) {
      prev.sumPrice += Number(item.soldPriceValue);
      prev.pricedCount += 1;
    }
    map.set(model, prev);
  }

  return map;
}

function getItemSourceUrl(item) {
  if (typeof item?.sourceSearchUrl === 'string' && item.sourceSearchUrl) {
    return item.sourceSearchUrl;
  }
  if (Array.isArray(item?.sourceSearchUrls) && item.sourceSearchUrls.length > 0) {
    return String(item.sourceSearchUrls[0] || '');
  }
  return '';
}

function sourceUrlLabel(url) {
  const value = String(url || '').trim();
  if (!value) return 'sin_origen';
  try {
    const parsed = new URL(value);
    const searchText = parsed.searchParams.get('search_text');
    if (searchText) {
      return `search:${searchText}`;
    }
    const brands = parsed.searchParams.getAll('brand_ids[]');
    if (brands.length > 0) {
      return `brand:${brands.join('+')}`;
    }
    const catalogs = parsed.searchParams.getAll('catalog[]');
    if (catalogs.length > 0) {
      return `catalog:${catalogs.join('+')}`;
    }
    return `${parsed.pathname}${parsed.search}`.slice(0, 64);
  } catch (_) {
    return value.slice(0, 64);
  }
}

function aggregateLinkStats(soldItems) {
  const map = new Map();
  for (const item of soldItems) {
    const source = getItemSourceUrl(item) || 'sin_origen';
    const prev = map.get(source) || {
      soldCount: 0,
      sumMinutes: 0,
      timedCount: 0,
      sumPrice: 0,
      pricedCount: 0,
    };
    prev.soldCount += 1;
    const mins = toNumber(item.timeToSellMinutes);
    if (mins !== null) {
      prev.sumMinutes += Number(mins);
      prev.timedCount += 1;
    }
    const price = toNumber(item.soldPriceValue);
    if (price !== null) {
      prev.sumPrice += Number(price);
      prev.pricedCount += 1;
    }
    map.set(source, prev);
  }
  return map;
}

function makeSpeedBuckets(soldItems) {
  const bucketDefs = [
    { label: '<1h', min: 0, max: 60 },
    { label: '1-3h', min: 60, max: 180 },
    { label: '3-6h', min: 180, max: 360 },
    { label: '6-12h', min: 360, max: 720 },
    { label: '12-24h', min: 720, max: 1440 },
    { label: '>24h', min: 1440, max: Number.POSITIVE_INFINITY },
  ];

  const out = bucketDefs.map((b) => ({ ...b, value: 0 }));
  for (const item of soldItems) {
    const mins = toNumber(item.timeToSellMinutes);
    if (mins === null) continue;
    const hit = out.find((b) => mins >= b.min && mins < b.max);
    if (hit) hit.value += 1;
  }
  return out.map((b) => ({ label: b.label, value: b.value }));
}

function renderBars(container, rows, valueFormatter = (v) => String(v)) {
  container.innerHTML = '';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Sin datos todavia.';
    container.appendChild(p);
    return;
  }

  const max = Math.max(...rows.map((r) => Number(r.value) || 0), 1);

  for (const row of rows) {
    const value = Number(row.value) || 0;
    const pct = Math.max(3, Math.round((value / max) * 100));

    const wrapper = document.createElement('div');
    wrapper.className = 'bar-row';

    const name = document.createElement('span');
    name.className = 'bar-name';
    name.textContent = row.label;

    const track = document.createElement('span');
    track.className = 'bar-track';

    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    const valueEl = document.createElement('span');
    valueEl.className = 'bar-value';
    valueEl.textContent = valueFormatter(value);

    wrapper.appendChild(name);
    wrapper.appendChild(track);
    wrapper.appendChild(valueEl);
    container.appendChild(wrapper);
  }
}

function renderKpis(items, metrics, blockedSellerRows = []) {
  const totalDetected = Number(metrics?.totalDetected || items.length || 0);
  const expired = Number(metrics?.totalExpired || 0);
  const active = items.filter((i) => i.status === 'active').length;
  const reserved = items.filter((i) => i.status === 'reserved').length;
  const sold = items.filter((i) => i.status === 'sold').length;
  const blockedAccounts = Array.isArray(blockedSellerRows) ? blockedSellerRows.length : 0;

  const soldWithTime = items.filter((i) => i.status === 'sold' && toNumber(i.timeToSellMinutes) !== null);
  const avgTimeMins =
    soldWithTime.length > 0
      ? soldWithTime.reduce((acc, i) => acc + Number(i.timeToSellMinutes), 0) / soldWithTime.length
      : null;

  const soldWithPrice = items.filter((i) => i.status === 'sold' && toNumber(i.soldPriceValue) !== null);
  const avgPrice =
    soldWithPrice.length > 0
      ? soldWithPrice.reduce((acc, i) => acc + Number(i.soldPriceValue), 0) / soldWithPrice.length
      : null;

  els.kpiTotal.textContent = String(totalDetected);
  els.kpiActive.textContent = String(active);
  els.kpiReserved.textContent = String(reserved);
  els.kpiSold.textContent = String(sold);
  els.kpiExpired.textContent = String(expired);
  els.kpiBlockedAccounts.textContent = String(blockedAccounts);
  els.kpiAvgTime.textContent = fmtMinutesAsHours(avgTimeMins);
  els.kpiAvgPrice.textContent = fmtPrice(avgPrice);
}

function soldTodayItems(items) {
  const list = Array.isArray(items) ? items : [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return list.filter((item) => {
    if (item?.status !== 'sold') return false;
    const soldMs = new Date(item?.soldAt || 0).getTime();
    return Number.isFinite(soldMs) && soldMs >= startMs && soldMs < endMs;
  });
}

function renderProfitToday(items, config) {
  if (!els.profitTodayValue || !els.profitTodayNote || !els.profitTodayUnits || !els.profitTodayCost) return;

  const unitCost = parseUnitCostInput(config?.unitCost);
  const soldToday = soldTodayItems(items);
  els.profitTodayUnits.textContent = `Ventas hoy: ${soldToday.length}`;

  if (unitCost === null) {
    els.profitTodayValue.textContent = '--';
    els.profitTodayValue.dataset.tone = 'muted';
    els.profitTodayCost.textContent = 'Coste por unidad: no configurado';
    els.profitTodayNote.textContent = 'Anade tu coste por unidad para ver el profit estimado.';
    return;
  }

  let profitToday = 0;
  let pricedSales = 0;
  for (const item of soldToday) {
    const unitSellPrice = toNumber(item?.soldPriceValue) ?? parsePriceValue(item?.soldPriceText || '');
    if (unitSellPrice === null) continue;
    profitToday += unitSellPrice - unitCost;
    pricedSales += 1;
  }

  els.profitTodayValue.textContent = fmtPrice(profitToday);
  els.profitTodayValue.dataset.tone = profitToday >= 0 ? 'ok' : 'error';
  els.profitTodayCost.textContent = `Coste por unidad: ${fmtPrice(unitCost)}`;
  if (!soldToday.length) {
    els.profitTodayNote.textContent = 'Sin ventas hoy todavia. El profit se actualizara automaticamente.';
  } else if (!pricedSales) {
    els.profitTodayNote.textContent = 'Hay ventas hoy, pero faltan precios de venta para calcular profit real.';
  } else if (pricedSales < soldToday.length) {
    els.profitTodayNote.textContent = `Profit parcial con ${pricedSales}/${soldToday.length} ventas con precio detectado.`;
  } else {
    els.profitTodayNote.textContent = 'Profit calculado con ventas reales detectadas hoy.';
  }
}

function normalizeKeyword(value) {
  return String(value || '').trim().toLowerCase();
}

function isUnknownModelLabel(value) {
  const model = normalizeKeyword(value);
  return !model || model === 'desconocido' || model === 'unknown' || model === '-' || model === 'n/a';
}

function buildCompareRows(items) {
  const modelCounts = new Map();

  for (const item of items) {
    const model = normalizeKeyword(getModelLabel(item));
    if (isUnknownModelLabel(model)) continue;
    modelCounts.set(model, Number(modelCounts.get(model) || 0) + 1);
  }

  const sorted = Array.from(modelCounts.entries())
    .sort((a, b) => {
      const diff = Number(b[1] || 0) - Number(a[1] || 0);
      if (diff !== 0) return diff;
      return String(a[0]).localeCompare(String(b[0]), 'es');
    });

  return sorted
    .slice(0, MAX_COMPARE_MODELS)
    .map(([keyword], idx) => ({
      keyword,
      color: MODEL_COMPARE_COLORS[idx % MODEL_COMPARE_COLORS.length],
    }));
}

function timeWindowStartMs(windowKey, minMs, maxMs) {
  const now = maxMs || Date.now();
  if (windowKey === '24h') return now - 24 * 60 * 60 * 1000;
  if (windowKey === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (windowKey === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return Number.isFinite(minMs) ? minMs : now - 30 * 24 * 60 * 60 * 1000;
}

function renderKeywordLegend(compareRows) {
  els.keywordFixedLegend.innerHTML = '';
  for (const row of compareRows) {
    const chip = document.createElement('span');
    chip.className = 'keyword-chip';
    const dot = document.createElement('span');
    dot.className = 'keyword-dot';
    dot.style.background = row.color;
    const label = document.createElement('span');
    label.textContent = row.keyword;
    chip.appendChild(dot);
    chip.appendChild(label);
    els.keywordFixedLegend.appendChild(chip);
  }
}

function buildKeywordTrendSeries(items, compareRows, windowKey) {
  const bucketSizeMs = windowKey === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const timestamps = items
    .map((item) => new Date(item.detectedAt || 0).getTime())
    .filter((ts) => Number.isFinite(ts));

  const minMs = timestamps.length ? Math.min(...timestamps) : Date.now();
  const maxMs = timestamps.length ? Math.max(...timestamps) : Date.now();
  const startMs = timeWindowStartMs(windowKey, minMs, maxMs);
  const endMs = maxMs + bucketSizeMs;

  const bucketCount = Math.max(2, Math.ceil((endMs - startMs) / bucketSizeMs));
  const seriesRaw = compareRows.map((row) => ({
    keyword: row.keyword,
    color: row.color,
    values: new Array(bucketCount).fill(0),
  }));
  const seriesIndexByModel = new Map(seriesRaw.map((row, idx) => [row.keyword, idx]));

  for (const item of items) {
    const ts = new Date(item.detectedAt || 0).getTime();
    if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue;
    const bucketIdx = Math.floor((ts - startMs) / bucketSizeMs);
    if (bucketIdx < 0 || bucketIdx >= bucketCount) continue;

    const model = normalizeKeyword(getModelLabel(item));
    const seriesIdx = seriesIndexByModel.get(model);
    if (seriesIdx == null) continue;
    seriesRaw[seriesIdx].values[bucketIdx] += 1;
  }

  const labels = [];
  const tooltipLabels = [];
  const bucketMs = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const t = startMs + i * bucketSizeMs;
    const d = new Date(t);
    bucketMs.push(t);
    if (windowKey === '24h') {
      labels.push(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      tooltipLabels.push(
        d.toLocaleString([], {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    } else {
      labels.push(d.toLocaleDateString());
      tooltipLabels.push(
        d.toLocaleString([], {
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    }
  }

  const peak = Math.max(
    1,
    ...seriesRaw.flatMap((row) => row.values.map((v) => Number(v) || 0))
  );
  const series = seriesRaw.map((row) => {
    const rawValues = row.values.map((v) => Number(v) || 0);
    const normalized = rawValues.map((v) => Math.round((v / peak) * 100));
    const avg = Math.round(normalized.reduce((acc, v) => acc + v, 0) / normalized.length);
    return {
      keyword: row.keyword,
      color: row.color,
      values: normalized,
      rawValues,
      avg,
    };
  });

  return {
    labels,
    tooltipLabels,
    bucketMs,
    series,
    peak,
  };
}

function renderKeywordTrendSvg(data) {
  const { labels, series, tooltipLabels = [] } = data;
  els.keywordTrendChart.innerHTML = '';

  if (!labels.length || labels.length < 2 || !series.length) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Necesitas mas detecciones para ver tendencia temporal.';
    els.keywordTrendChart.appendChild(p);
    return;
  }

  const width = 1080;
  const height = 300;
  const pad = { l: 46, r: 16, t: 18, b: 28 };
  const chartW = width - pad.l - pad.r;
  const chartH = height - pad.t - pad.b;

  const toPoint = (values) =>
    values.map((v, i) => {
      const x = pad.l + (i / (values.length - 1)) * chartW;
      const y = pad.t + chartH - (v / 100) * chartH;
      return { x, y, v };
    });

  const seriesWithPoints = series.map((row) => ({
    ...row,
    points: toPoint(row.values),
  }));

  const polylines = seriesWithPoints
    .map((row) => {
      const poly = row.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
      return `<polyline points="${poly}" fill="none" stroke="${row.color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
    })
    .join('');

  const yGrid = [0, 20, 40, 60, 80, 100]
    .map((v) => {
      const y = (pad.t + chartH - (v / 100) * chartH).toFixed(2);
      return `<line x1="${pad.l}" y1="${y}" x2="${width - pad.r}" y2="${y}" stroke="#2a3445" stroke-width="1"></line>
        <text x="${pad.l - 8}" y="${Number(y) + 4}" text-anchor="end" fill="#8b9ab0" font-size="11">${v}</text>`;
    })
    .join('');

  const xLabels = [0, Math.floor((labels.length - 1) / 2), labels.length - 1]
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .map((idx) => {
      const x = (pad.l + (idx / Math.max(1, labels.length - 1)) * chartW).toFixed(2);
      return `<text x="${x}" y="${height - 8}" text-anchor="middle" fill="#8b9ab0" font-size="11">${labels[idx]}</text>`;
    })
    .join('');

  els.keywordTrendChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Comparativa temporal de modelos">
      ${yGrid}
      <line class="keyword-trend-hover-line" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + chartH}" />
      ${polylines}
      <g class="keyword-trend-hover-points"></g>
      ${xLabels}
    </svg>
  `;

  const svg = els.keywordTrendChart.querySelector('svg');
  if (!svg) return;

  const hoverLine = svg.querySelector('.keyword-trend-hover-line');
  const hoverPoints = svg.querySelector('.keyword-trend-hover-points');

  const tooltip = document.createElement('div');
  tooltip.className = 'keyword-trend-tooltip';
  tooltip.hidden = true;
  els.keywordTrendChart.appendChild(tooltip);

  const hideHover = () => {
    tooltip.hidden = true;
    if (hoverLine) {
      hoverLine.style.opacity = '0';
    }
    if (hoverPoints) {
      hoverPoints.innerHTML = '';
    }
  };

  const getBucketIndexFromEvent = (evt) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height || labels.length < 2) return null;
    const xPx = evt.clientX - rect.left;
    if (xPx < 0 || xPx > rect.width) return null;
    const x = (xPx / rect.width) * width;
    const rawIdx = Math.round(((x - pad.l) / chartW) * (labels.length - 1));
    const idx = Math.max(0, Math.min(labels.length - 1, rawIdx));
    return Number.isFinite(idx) ? idx : null;
  };

  const updateHover = (evt) => {
    const idx = getBucketIndexFromEvent(evt);
    if (idx == null) {
      hideHover();
      return;
    }

    const x = pad.l + (idx / Math.max(1, labels.length - 1)) * chartW;
    if (hoverLine) {
      hoverLine.setAttribute('x1', String(x.toFixed(2)));
      hoverLine.setAttribute('x2', String(x.toFixed(2)));
      hoverLine.style.opacity = '1';
    }

    const rows = seriesWithPoints
      .map((row) => ({
        keyword: row.keyword,
        color: row.color,
        detected: Number(row.rawValues?.[idx] || 0),
        point: row.points[idx],
      }))
      .sort((a, b) => {
        const diff = b.detected - a.detected;
        if (diff !== 0) return diff;
        return String(a.keyword).localeCompare(String(b.keyword), 'es');
      });

    const nonZeroRows = rows.filter((row) => row.detected > 0);
    const rowsToShow = nonZeroRows.length ? nonZeroRows : rows.slice(0, 1);

    if (hoverPoints) {
      hoverPoints.innerHTML = rowsToShow
        .filter((row) => row.point)
        .map(
          (row) =>
            `<circle cx="${row.point.x.toFixed(2)}" cy="${row.point.y.toFixed(2)}" r="5.2" fill="${row.color}" stroke="#e6edf8" stroke-width="2.2"></circle>`
        )
        .join('');
    }

    tooltip.innerHTML = '';
    const date = document.createElement('div');
    date.className = 'keyword-trend-tooltip-date';
    date.textContent = tooltipLabels[idx] || labels[idx] || '-';
    tooltip.appendChild(date);

    if (!nonZeroRows.length) {
      const empty = document.createElement('div');
      empty.className = 'keyword-trend-tooltip-empty';
      empty.textContent = 'Sin detectados en este tramo';
      tooltip.appendChild(empty);
    } else {
      for (const row of rowsToShow) {
        const line = document.createElement('div');
        line.className = 'keyword-trend-tooltip-row';

        const model = document.createElement('div');
        model.className = 'keyword-trend-tooltip-model';

        const dot = document.createElement('span');
        dot.className = 'keyword-trend-tooltip-dot';
        dot.style.background = row.color;

        const modelName = document.createElement('span');
        modelName.textContent = row.keyword;

        model.appendChild(dot);
        model.appendChild(modelName);

        const qty = document.createElement('strong');
        qty.className = 'keyword-trend-tooltip-value';
        qty.textContent = `${row.detected}`;

        line.appendChild(model);
        line.appendChild(qty);
        tooltip.appendChild(line);
      }
    }

    const chartRect = els.keywordTrendChart.getBoundingClientRect();
    const localX = evt.clientX - chartRect.left;
    const localY = evt.clientY - chartRect.top;

    tooltip.hidden = false;

    let left = localX + 14;
    let top = localY - tooltip.offsetHeight - 12;

    const maxLeft = chartRect.width - tooltip.offsetWidth - 8;
    if (left > maxLeft) left = maxLeft;
    if (left < 8) left = 8;

    if (top < 8) {
      top = localY + 14;
      const maxTop = chartRect.height - tooltip.offsetHeight - 8;
      if (top > maxTop) top = Math.max(8, maxTop);
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  svg.addEventListener('mousemove', updateHover);
  svg.addEventListener('mouseleave', hideHover);
}

function renderKeywordAvgBars(data) {
  els.keywordAvgBars.innerHTML = '';

  const rows = (data?.series || []).map((row) => ({
    keyword: row.keyword,
    value: Number(row.avg || 0),
    color: row.color,
  }));
  const maxValue = Math.max(...rows.map((row) => Number(row.value) || 0), 1);

  const title = document.createElement('div');
  title.className = 'keyword-avg-title';
  title.textContent = `Interes medio (top ${MAX_COMPARE_MODELS})`;
  els.keywordAvgBars.appendChild(title);

  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'keyword-avg-row';

    const name = document.createElement('div');
    name.className = 'keyword-avg-name';
    name.textContent = row.keyword;

    const track = document.createElement('div');
    track.className = 'keyword-avg-track';

    const fill = document.createElement('div');
    fill.className = 'keyword-avg-fill';
    const pct = Math.max(3, Math.round((row.value / maxValue) * 100));
    fill.style.width = `${pct}%`;
    fill.style.background = row.color;
    track.appendChild(fill);

    const value = document.createElement('div');
    value.className = 'keyword-avg-value';
    value.textContent = String(row.value);

    wrapper.appendChild(name);
    wrapper.appendChild(track);
    wrapper.appendChild(value);
    els.keywordAvgBars.appendChild(wrapper);
  }
}

function renderKeywordTrendComparison(items) {
  const windowKey = String(els.keywordWindow.value || '30d');
  app.keywordSelection.window = windowKey;
  const compareRows = buildCompareRows(items);
  renderKeywordLegend(compareRows);
  const trendData = buildKeywordTrendSeries(items, compareRows, windowKey);
  renderKeywordTrendSvg(trendData);
  renderKeywordAvgBars(trendData);
}

function drawEsfuerzoChart(items) {
  const container = els.esfuerzoChart;
  if (!container) return;
  container.innerHTML = '';

  // Group items into 2-hour slots by detectedAt
  const SLOT_H = 2;
  const buckets = new Map();
  for (const item of items) {
    const ts = new Date(item?.detectedAt || 0).getTime();
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const d = new Date(ts);
    const slot = Math.floor(d.getHours() / SLOT_H) * SLOT_H;
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const key = `${day}T${String(slot).padStart(2, '0')}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  if (buckets.size < 2) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Necesitas mas detecciones para ver la actividad del mercado.';
    container.appendChild(p);
    if (els.esfuerzoPeak) els.esfuerzoPeak.textContent = '—';
    return;
  }

  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const values = sorted.map(([, v]) => v);
  const labels = sorted.map(([k]) => {
    const h = parseInt(k.split('T')[1], 10);
    return `${String(h).padStart(2, '0')}:00`;
  });

  const maxVal = Math.max(...values, 1);
  const peakIdx = values.indexOf(maxVal);

  if (els.esfuerzoPeak) {
    const peakEnd = (parseInt(labels[peakIdx], 10) + SLOT_H) % 24;
    els.esfuerzoPeak.textContent = `Franja mas activa: ${labels[peakIdx]}–${String(peakEnd).padStart(2, '0')}:00 · ${maxVal} nuevos`;
  }

  // SVG layout
  const W = 1080;
  const H = 160;
  const pad = { l: 34, r: 16, t: 14, b: 26 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;
  const base = pad.t + cH;

  const pts = values.map((v, i) => ({
    x: pad.l + (values.length > 1 ? (i / (values.length - 1)) : 0.5) * cW,
    y: pad.t + cH - (v / maxVal) * cH,
  }));

  // Catmull-Rom to cubic Bezier
  function smoothPath(points, tension) {
    const t = tension == null ? 0.38 : tension;
    if (points.length < 2) return '';
    let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const cp1x = (p1.x + (p2.x - p0.x) * t).toFixed(2);
      const cp1y = (p1.y + (p2.y - p0.y) * t).toFixed(2);
      const cp2x = (p2.x - (p3.x - p1.x) * t).toFixed(2);
      const cp2y = (p2.y - (p3.y - p1.y) * t).toFixed(2);
      d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }
    return d;
  }

  const linePath = smoothPath(pts);
  const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(2)},${base} L ${pts[0].x.toFixed(2)},${base} Z`;

  // X labels (max 12)
  const step = Math.max(1, Math.ceil(pts.length / 12));
  const xLabels = pts
    .map((p, i) =>
      i % step === 0
        ? `<text x="${p.x.toFixed(2)}" y="${H - 4}" text-anchor="middle" fill="rgba(157,191,173,0.55)" font-size="10">${labels[i]}</text>`
        : ''
    )
    .join('');

  // Horizontal grid
  const gridLines = [0.25, 0.5, 0.75, 1]
    .map((pct) => {
      const y = (pad.t + cH - pct * cH).toFixed(2);
      const val = Math.round(pct * maxVal);
      return [
        `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="rgba(0,180,120,0.07)" stroke-width="1"/>`,
        `<text x="${pad.l - 4}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="rgba(157,191,173,0.45)" font-size="9">${val}</text>`,
      ].join('');
    })
    .join('');

  // Glow dots at peak
  const peakPt = pts[peakIdx];
  const peakDot = peakPt
    ? [
        `<circle cx="${peakPt.x.toFixed(2)}" cy="${peakPt.y.toFixed(2)}" r="6" fill="rgba(0,198,136,0.18)"/>`,
        `<circle cx="${peakPt.x.toFixed(2)}" cy="${peakPt.y.toFixed(2)}" r="3.5" fill="#00c688"/>`,
      ].join('')
    : '';

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Actividad del mercado por franja horaria">
      <defs>
        <linearGradient id="esfuerzo-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#00b478" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#00b478" stop-opacity="0.01"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path d="${areaPath}" fill="url(#esfuerzo-fill)"/>
      <path d="${linePath}" fill="none" stroke="#00c688" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      ${peakDot}
      ${xLabels}
    </svg>
  `;
}

function renderCharts(items) {
  renderKeywordTrendComparison(items);
  drawEsfuerzoChart(items);

  const soldItems = items.filter((i) => i.status === 'sold');
  const modelStats = aggregateModelStats(soldItems);

  const topSold = Array.from(modelStats.entries())
    .map(([model, data]) => ({ label: model, value: data.soldCount }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  renderBars(els.chartTopModels, topSold, (v) => `${v}`);

  const linkStats = aggregateLinkStats(soldItems);
  const rentableLinks = Array.from(linkStats.entries())
    .map(([sourceUrl, data]) => {
      const avgHours = data.timedCount > 0 ? data.sumMinutes / data.timedCount / 60 : null;
      const avgPrice = data.pricedCount > 0 ? data.sumPrice / data.pricedCount : null;
      const score = avgHours && avgHours > 0 && avgPrice ? avgPrice / avgHours : 0;
      return {
        label: `${sourceUrlLabel(sourceUrl)} (${data.soldCount})`,
        value: score,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  renderBars(els.chartRentableLinks, rentableLinks, (v) => v.toFixed(2));

  const speed = makeSpeedBuckets(soldItems);
  renderBars(els.chartSpeed, speed, (v) => `${v}`);
}

function renderModularInsights(items) {
  const deterministic = getDeterministicGateInfo();
  const context = {
    items,
    config: app.config || {},
    filters: app.filters || {},
    analysis: {
      ageMs: deterministic.ageMs,
      ready24h: deterministic.ready,
      remainingMs: deterministic.remainingMs,
      startMs: deterministic.startMs,
    },
  };

  const results = runInsightsModules(context);
  renderInsightsModules(results, {
    saturation: els.insightSaturation,
    publications: els.insightPublications,
    sales: els.insightSales,
    summary: els.insightSummary,
  });
}

function currentFilters() {
  const statusRaw = String(els.filterStatus?.value || 'all');
  const status = ['all', 'active', 'reserved'].includes(statusRaw) ? statusRaw : 'all';
  const model = String(els.filterModel?.value || '').trim().toLowerCase();
  const popularRaw = String(els.filterPopular?.value || 'all');
  const popular = ['all', 'yes', 'no'].includes(popularRaw) ? popularRaw : 'all';
  const minLikes = Math.max(0, Number(els.filterMinLikes?.value || 0) || 0);
  const minViews = Math.max(0, Number(els.filterMinViews?.value || 0) || 0);
  return {
    status,
    model,
    popular,
    minLikes,
    minViews,
  };
}

function applyFilters(items, filters) {
  return items.filter((item) => {
    const latest = item.latest || {};
    if (item.status === 'sold') return false;
    const status = ['all', 'active', 'reserved'].includes(filters.status) ? filters.status : 'all';

    if (status === 'active' && item.status !== 'active') return false;
    if (status === 'reserved' && item.status !== 'reserved') return false;

    if (filters.model) {
      const haystack = `${item.title || ''} ${item.description || ''} ${item.modelName || ''}`.toLowerCase();
      if (!haystack.includes(filters.model)) return false;
    }

    if (filters.popular === 'yes' && latest.isPopular !== true) return false;
    if (filters.popular === 'no' && latest.isPopular === true) return false;

    const likes = toNumber(latest.likesCount) || 0;
    const views = toNumber(latest.viewsCount) || 0;
    if (likes < filters.minLikes) return false;
    if (views < filters.minViews) return false;

    return true;
  });
}

function renderSoldTable(soldItems) {
  els.soldBody.innerHTML = '';
  els.soldCount.textContent = `${soldItems.length} vendidos`;
  positionSoldPanelByCount();

  if (!soldItems.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'Aun no hay productos vendidos.';
    tr.appendChild(td);
    els.soldBody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of soldItems) {
    const latest = item.latest || {};
    const tr = document.createElement('tr');

    const idTd = document.createElement('td');
    idTd.textContent = String(item.itemId);

    const titleTd = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'inline-detail-title';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.href = item.url;
    link.textContent = item.title || `Item ${item.itemId}`;
    titleTd.appendChild(link);

    const sellerTd = document.createElement('td');
    if (item.sellerProfileUrl) {
      const sellerLink = document.createElement('a');
      sellerLink.className = 'inline-detail-title';
      sellerLink.target = '_blank';
      sellerLink.rel = 'noreferrer';
      sellerLink.href = item.sellerProfileUrl;
      sellerLink.textContent = item.sellerName || 'ver perfil';
      sellerTd.appendChild(sellerLink);
    } else {
      sellerTd.textContent = item.sellerName || '-';
    }

    const sellerAccountTd = document.createElement('td');
    const sellerState = getSellerStatusLabel(item);
    const checkedAt = item.sellerLastCheckedAt ? fmtDate(item.sellerLastCheckedAt) : null;
    sellerAccountTd.textContent = checkedAt ? `${sellerState} (${checkedAt})` : sellerState;

    const modelTd = document.createElement('td');
    modelTd.textContent = getModelLabel(item);

    const soldPriceTd = document.createElement('td');
    soldPriceTd.textContent = item.soldPriceText || latest.priceText || '-';

    const soldAtTd = document.createElement('td');
    soldAtTd.textContent = fmtDate(item.soldAt);

    const timeTd = document.createElement('td');
    timeTd.textContent = fmtMinutesAsHours(item.timeToSellMinutes);

    tr.appendChild(idTd);
    tr.appendChild(titleTd);
    tr.appendChild(sellerTd);
    tr.appendChild(sellerAccountTd);
    tr.appendChild(modelTd);
    tr.appendChild(soldPriceTd);
    tr.appendChild(soldAtTd);
    tr.appendChild(timeTd);
    frag.appendChild(tr);
  }

  els.soldBody.appendChild(frag);
}

function renderBlockedAccountsTable(blockedSellerRows) {
  if (!els.blockedAccountsBody || !els.blockedAccountsCount) return;

  const rows = Array.isArray(blockedSellerRows) ? blockedSellerRows : [];
  els.blockedAccountsBody.innerHTML = '';
  els.blockedAccountsCount.textContent = `${rows.length} cuenta${rows.length === 1 ? '' : 's'} bloqueada${rows.length === 1 ? '' : 's'}`;

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'Aun no hay cuentas bloqueadas detectadas.';
    tr.appendChild(td);
    els.blockedAccountsBody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const item = row.item || {};
    const tr = document.createElement('tr');

    const sellerTd = document.createElement('td');
    if (row.sellerProfileUrl) {
      const sellerLink = document.createElement('a');
      sellerLink.className = 'inline-detail-title';
      sellerLink.target = '_blank';
      sellerLink.rel = 'noreferrer';
      sellerLink.href = row.sellerProfileUrl;
      sellerLink.textContent = row.sellerName || (row.sellerMemberId ? `member ${row.sellerMemberId}` : 'ver perfil');
      sellerTd.appendChild(sellerLink);
    } else {
      sellerTd.textContent = row.sellerName || (row.sellerMemberId ? `member ${row.sellerMemberId}` : '-');
    }
    const sellerMeta = document.createElement('div');
    sellerMeta.className = 'table-subnote';
    sellerMeta.textContent =
      row.relatedProductsCount > 1
        ? `${row.relatedProductsCount} productos asociados`
        : row.sellerMemberId
          ? `member ${row.sellerMemberId}`
          : '1 producto asociado';
    sellerTd.appendChild(sellerMeta);

    const statusTd = document.createElement('td');
    const status = document.createElement('span');
    status.className = 'status-pill status-seller-blocked';
    status.textContent = 'bloqueada';
    statusTd.appendChild(status);

    const productTd = document.createElement('td');
    const productLink = document.createElement('a');
    productLink.className = 'inline-detail-title';
    productLink.target = '_blank';
    productLink.rel = 'noreferrer';
    productLink.href = item.url || row.sellerProfileUrl || '#';
    productLink.textContent = item.title || `Item ${item.itemId || '-'}`;
    productTd.appendChild(productLink);
    const productMeta = document.createElement('div');
    productMeta.className = 'table-subnote';
    productMeta.textContent = item.itemId ? `ID ${item.itemId}` : 'Sin ID';
    productTd.appendChild(productMeta);

    const modelTd = document.createElement('td');
    modelTd.textContent = getModelLabel(item);

    const checkedTd = document.createElement('td');
    checkedTd.textContent = fmtDate(row.checkedAt);

    const reasonTd = document.createElement('td');
    reasonTd.textContent = row.reason || '-';

    tr.appendChild(sellerTd);
    tr.appendChild(statusTd);
    tr.appendChild(productTd);
    tr.appendChild(modelTd);
    tr.appendChild(checkedTd);
    tr.appendChild(reasonTd);
    frag.appendChild(tr);
  }

  els.blockedAccountsBody.appendChild(frag);
}

function createInlineDetailElement(item) {
  const latest = item.latest || {};
  const wrap = document.createElement('div');
  wrap.className = 'inline-detail';

  const head = document.createElement('div');
  head.className = 'inline-detail-head';

  const title = document.createElement('a');
  title.className = 'inline-detail-title';
  title.target = '_blank';
  title.rel = 'noreferrer';
  title.href = item.url;
  title.textContent = `${item.title || `Item ${item.itemId}`} (ID ${item.itemId})`;

  const sub = document.createElement('div');
  sub.className = 'inline-detail-sub';
  sub.textContent =
    `Detectado: ${fmtDate(item.detectedAt)} | Ultimo check: ${fmtDate(latest.checkedAt)} | ` +
    `Snapshots: ${Array.isArray(item.snapshots) ? item.snapshots.length : 0}`;

  head.appendChild(title);
  head.appendChild(sub);

  const grid = document.createElement('div');
  grid.className = 'inline-detail-grid';

  const cards = [
    ['Modelo', getModelLabel(item)],
    ['Vendedor', item.sellerName || '-'],
    ['Cuenta seller', getSellerStatusLabel(item)],
    ['Ultimo check seller', fmtDate(item.sellerLastCheckedAt)],
    ['Link origen', sourceUrlLabel(getItemSourceUrl(item))],
    ['Estado', item.status || '-'],
    ['Precio', latest.priceText || item.soldPriceText || '-'],
    ['Likes', fmtCount(latest.likesCount)],
    ['Ofertas', fmtCount(latest.offersCount)],
    ['Visitas', fmtCount(latest.viewsCount)],
    ['Popular', latest.isPopular === null ? '-' : (latest.isPopular ? 'si' : 'no')],
    ['Subido', latest.uploadedText || '-'],
    ['Publicado estimado', fmtDate(item.publishedAt || latest.publishedAt)],
    ['Rank catalogo', item.firstSeenRank == null ? '-' : String(item.firstSeenRank)],
    ['Tiempo venta', item.status === 'sold' ? fmtMinutesAsHours(item.timeToSellMinutes) : '-'],
    ['Precio vendido', item.soldPriceText || '-'],
    ['Vendido', fmtDate(item.soldAt)],
  ];

  for (const [labelText, valueText] of cards) {
    const card = document.createElement('div');
    card.className = 'inline-detail-card';
    const label = document.createElement('span');
    label.textContent = labelText;
    const value = document.createElement('strong');
    value.textContent = String(valueText || '-');
    card.appendChild(label);
    card.appendChild(value);
    grid.appendChild(card);
  }

  const description = document.createElement('div');
  description.className = 'inline-detail-desc';
  description.textContent = item.description || latest.description || 'Sin descripcion detectada.';

  wrap.appendChild(head);
  wrap.appendChild(grid);
  wrap.appendChild(description);
  return wrap;
}

function renderTable(items) {
  els.itemsBody.innerHTML = '';

  if (!items.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'No hay resultados con estos filtros.';
    tr.appendChild(td);
    els.itemsBody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const item of items) {
    const tr = document.createElement('tr');
    tr.dataset.itemId = String(item.itemId);
    if (app.selectedItemId && String(app.selectedItemId) === String(item.itemId)) {
      tr.classList.add('selected');
    }

    const latest = item.latest || {};

    const idTd = document.createElement('td');
    idTd.textContent = String(item.itemId);

    const titleTd = document.createElement('td');
    const likes = item.latest?.likesCount;
    const tier  = item.opportunityTier ? `${item.opportunityTier} ` : '';
    const hotBadge = item.isHot
      ? `🔥 `
      : (Number.isFinite(likes) && likes > 0 ? `❤️ ${likes} · ` : '');
    titleTd.textContent = tier + hotBadge + (item.title || `Item ${item.itemId}`);
    if (item.isHot || (item.opportunityScore || 0) >= 60) {
      tr.classList.add('row-hot');
    }

    const statusTd = document.createElement('td');
    const status = document.createElement('span');
    status.className = `status-pill ${getStatusBadgeClass(item.status)}`;
    status.textContent = item.status || '-';
    statusTd.appendChild(status);

    const modelTd = document.createElement('td');
    modelTd.textContent = getModelLabel(item);

    const priceTd = document.createElement('td');
    priceTd.textContent = latest.priceText || item.soldPriceText || '-';

    const rankTd = document.createElement('td');
    rankTd.textContent = item.firstSeenRank == null ? '-' : String(item.firstSeenRank);

    const detectedTd = document.createElement('td');
    detectedTd.textContent = fmtDate(item.detectedAt);

    const saleTd = document.createElement('td');
    saleTd.textContent = item.status === 'sold' ? fmtMinutesAsHours(item.timeToSellMinutes) : '-';

    tr.appendChild(idTd);
    tr.appendChild(titleTd);
    tr.appendChild(statusTd);
    tr.appendChild(modelTd);
    tr.appendChild(priceTd);
    tr.appendChild(rankTd);
    tr.appendChild(detectedTd);
    tr.appendChild(saleTd);

    tr.addEventListener('click', () => {
      const same = String(app.selectedItemId || '') === String(item.itemId);
      app.selectedItemId = same ? null : item.itemId;
      renderSelection();
    });

    frag.appendChild(tr);

    if (app.selectedItemId && String(app.selectedItemId) === String(item.itemId)) {
      const expandTr = document.createElement('tr');
      expandTr.className = 'expand-row';
      const expandTd = document.createElement('td');
      expandTd.colSpan = 8;
      expandTd.appendChild(createInlineDetailElement(item));
      expandTr.appendChild(expandTd);
      frag.appendChild(expandTr);
    }
  }

  els.itemsBody.appendChild(frag);
}

function getSelectedItem() {
  if (!app.items.length) return null;

  if (app.selectedItemId != null) {
    const found = app.items.find((i) => String(i.itemId) === String(app.selectedItemId));
    if (found) return found;
  }

  return null;
}

function buildSeries(item, metricKey) {
  const snapshots = Array.isArray(item.snapshots) ? [...item.snapshots] : [];
  snapshots.sort((a, b) => new Date(a.checkedAt || 0).getTime() - new Date(b.checkedAt || 0).getTime());

  const points = [];
  for (const snap of snapshots) {
    let value = toNumber(snap?.[metricKey]);
    if (metricKey === 'priceValue' && value === null) {
      value = parsePriceValue(snap?.priceText || null);
    }
    if (value === null) continue;

    const ts = new Date(snap.checkedAt || 0).getTime();
    if (!Number.isFinite(ts)) continue;

    points.push({
      ts,
      iso: snap.checkedAt,
      value,
    });
  }

  return points;
}

function renderTimelineStats(points) {
  els.timelineStats.innerHTML = '';

  if (!points.length) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Sin snapshots validos para esta metrica.';
    els.timelineStats.appendChild(p);
    return;
  }

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const latest = values[values.length - 1];

  const cards = [
    { label: 'Muestras', value: String(points.length) },
    { label: 'Min', value: String(min.toFixed(2)) },
    { label: 'Max', value: String(max.toFixed(2)) },
    { label: 'Actual', value: String(latest.toFixed(2)) },
    { label: 'Media', value: String(avg.toFixed(2)) },
    { label: 'Inicio', value: fmtDate(points[0].iso) },
    { label: 'Fin', value: fmtDate(points[points.length - 1].iso) },
  ];

  for (const card of cards) {
    const div = document.createElement('div');
    div.className = 'timeline-stat';

    const label = document.createElement('span');
    label.textContent = card.label;

    const value = document.createElement('strong');
    value.textContent = card.value;

    div.appendChild(label);
    div.appendChild(value);
    els.timelineStats.appendChild(div);
  }
}

function renderLineChart(points) {
  els.timelineChart.innerHTML = '';

  if (points.length < 2) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Necesitas al menos 2 snapshots para dibujar evolucion.';
    els.timelineChart.appendChild(p);
    return;
  }

  const width = 1000;
  const height = 220;
  const padX = 36;
  const padY = 18;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const chartWidth = width - padX * 2;
  const chartHeight = height - padY * 2;

  const coords = points.map((point, idx) => {
    const x = padX + (idx / (points.length - 1)) * chartWidth;
    const normalized = (point.value - min) / span;
    const y = height - padY - normalized * chartHeight;
    return { ...point, x, y };
  });

  const poly = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
  const circles = coords
    .map(
      (c) =>
        `<circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="3.2" fill="#60a5fa" stroke="#0f1828" stroke-width="2"></circle>`
    )
    .join('');

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = (padY + ratio * chartHeight).toFixed(2);
      return `<line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="#2a3445" stroke-width="1"></line>`;
    })
    .join('');

  const firstLabel = new Date(coords[0].ts).toLocaleTimeString();
  const lastLabel = new Date(coords[coords.length - 1].ts).toLocaleTimeString();

  els.timelineChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolucion temporal">
      ${gridLines}
      <polyline points="${poly}" fill="none" stroke="#60a5fa" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${circles}
      <text x="${padX}" y="${height - 2}" fill="#8b9ab0" font-size="12">${firstLabel}</text>
      <text x="${width - padX}" y="${height - 2}" text-anchor="end" fill="#8b9ab0" font-size="12">${lastLabel}</text>
      <text x="${padX}" y="12" fill="#8b9ab0" font-size="12">max ${max.toFixed(2)}</text>
      <text x="${padX}" y="${height - 24}" fill="#8b9ab0" font-size="12">min ${min.toFixed(2)}</text>
    </svg>
  `;
}

function renderDetail() {
  const item = getSelectedItem();

  if (!item) {
    els.detailEmpty.hidden = false;
    els.detailContent.hidden = true;
    return;
  }

  els.detailEmpty.hidden = true;
  els.detailContent.hidden = false;

  els.detailLink.href = item.url;
  els.detailLink.textContent = `${item.title || `Item ${item.itemId}`} (ID ${item.itemId})`;

  const latest = item.latest || {};
  const details = [
    `Estado: ${item.status}`,
    `Modelo: ${getModelLabel(item)}`,
    `Link origen: ${sourceUrlLabel(getItemSourceUrl(item))}`,
    `Descripcion: ${item.description || '-'}`,
    `Precio actual: ${latest.priceText || '-'}`,
    `Likes: ${fmtCount(latest.likesCount)} | Ofertas: ${fmtCount(latest.offersCount)} | Visitas: ${fmtCount(latest.viewsCount)}`,
    `Subido: ${latest.uploadedText || '-'}`,
    `Publicado estimado: ${fmtDate(item.publishedAt || latest.publishedAt)}`,
    `Popular: ${latest.isPopular === null ? '-' : latest.isPopular ? 'si' : 'no'}`,
    `Detectado: ${fmtDate(item.detectedAt)} | Ultimo check: ${fmtDate(latest.checkedAt)}`,
    item.status === 'sold'
      ? `Vendido: ${fmtDate(item.soldAt)} | Tiempo venta: ${fmtMinutesAsHours(item.timeToSellMinutes)} | Precio venta: ${item.soldPriceText || '-'}`
      : 'No vendido todavia',
    `Snapshots: ${Array.isArray(item.snapshots) ? item.snapshots.length : 0}`,
  ];
  els.detailMeta.textContent = details.join('\n');

  const metric = els.timelineMetric.value;
  const points = buildSeries(item, metric);
  renderTimelineStats(points);
  renderLineChart(points);
}

function renderSelection() {
  renderTable(app.filteredItems);
  renderDetail();
}

function renderAll() {
  if (!app.state) return;
  const items = Array.isArray(app.state.items) ? [...app.state.items] : [];
  items.sort((a, b) => new Date(b.detectedAt || 0).getTime() - new Date(a.detectedAt || 0).getTime());

  app.items = items;
  setMonitorUi(app.config || {});

  const cfgUrls = Array.isArray(app.config?.searchUrls)
    ? app.config.searchUrls
    : (app.config?.searchUrl ? [app.config.searchUrl] : []);
  const cfgUrlText = cfgUrls.join('\n');
  if (els.searchUrls.value.trim() !== cfgUrlText.trim()) {
    els.searchUrls.value = cfgUrlText;
  }
  const cfgName = typeof app.config?.productName === 'string' ? app.config.productName : '';
  if (els.productName.value !== cfgName) {
    els.productName.value = cfgName;
  }
  syncDashboardAutoUrlFromProduct({ forceTextarea: !cfgUrlText.trim() });
  renderAnalysisMaturity();
  renderDeterministicCountdown();
  updateExportButtonState();
  if (els.analysisMenuButton) {
    const activeAnalysis = getActiveAnalysisSummary();
    const activeLabel = activeAnalysis?.name || activeAnalysis?.productName || '';
    els.analysisMenuButton.textContent = activeLabel
      ? `Volver al menu (${activeLabel})`
      : 'Volver al menu';
  }
  const accountShort = formatVintedSessionShort(app.config?.vintedSession || null);
  const monitorEnabled = app.config?.monitorEnabled === true;
  const activeAnalysis = getActiveAnalysisSummary();
  const analysisLabel = activeAnalysis?.name || activeAnalysis?.productName || cfgName || 'sin analisis';
  const monitorStatus = app.config?.monitorEnabled
    ? `Monitor activo (${cfgName || 'sin nombre'}) | analisis: ${analysisLabel} | links: ${cfgUrls.length} | cuenta: ${accountShort}`
    : hasAnalysisStarted(app.state)
      ? `Analisis en pausa | analisis: ${analysisLabel} | cuenta: ${accountShort}`
      : `Monitor detenido | analisis: ${analysisLabel} | cuenta: ${accountShort}`;
  updateStatusLine(app.state.metrics || {}, monitorStatus);
  app.filters = currentFilters();
  const blockedSellerRows = buildBlockedSellerRows(items);
  renderKpis(items, app.state.metrics || {}, blockedSellerRows);
  renderProfitToday(items, app.config || {});
  renderCharts(items);
  renderModularInsights(items);
  const soldItems = sortItemsByTable(
    items.filter((i) => i.status === 'sold'),
    'sold'
  );
  renderSoldTable(soldItems);
  renderBlockedAccountsTable(blockedSellerRows);
  const monitoringItems = items.filter((i) => i.status !== 'sold');
  app.filteredItems = sortItemsByTable(applyFilters(monitoringItems, app.filters), 'monitored');
  els.tableCount.textContent = `${app.filteredItems.length} resultados / ${monitoringItems.length} monitorizados`;

  if (
    app.selectedItemId != null &&
    !app.filteredItems.some((i) => String(i.itemId) === String(app.selectedItemId))
  ) {
    app.selectedItemId = app.filteredItems.length ? app.filteredItems[0].itemId : null;
  }

  renderSortHeaders();
  renderSelection();
}

async function loadState() {
  if (app.loading) return;
  app.loading = true;
  try {
    const res = await send('rb:get-state');
    if (!res?.success) {
      updateStatusLine(app.state?.metrics || {}, 'No se pudo leer estado');
      return;
    }

    app.state = res.state || { items: [], metrics: {} };
    app.config = res.config || {};
    app.scheduler = res.scheduler || null;
    app.analyses = Array.isArray(res.analyses) ? res.analyses : [];
    app.activeAnalysisId = String(res.activeAnalysisId || '').trim() || null;
    if (els.analysisMenuOverlay && !els.analysisMenuOverlay.hidden) {
      renderAnalysisMenu();
    }
    renderAll();
  } catch (err) {
    const msg = err?.message || 'error cargando estado';
    updateStatusLine(app.state?.metrics || {}, msg);
  } finally {
    app.loading = false;
  }
}

function setAutoRefreshTimer() {
  if (app.autoRefreshTimer) {
    clearInterval(app.autoRefreshTimer);
    app.autoRefreshTimer = null;
  }

  const seconds = Number(els.autoRefresh?.value || app.config?.autoRefreshSeconds || 30);
  if (seconds <= 0) {
    updateStatusLine(app.state?.metrics || {}, 'Auto refresh pausado');
    return;
  }

  app.autoRefreshTimer = setInterval(() => {
    void loadState();
  }, seconds * 1000);

  updateStatusLine(app.state?.metrics || {}, `Auto refresh cada ${seconds}s (actualizado ${nowStamp()})`);
}

async function startMonitorFlow({ productName, searchUrls, unitCost = null, button, source = 'dashboard' }) {
  const isSetupSource = source === 'setup';
  if (!productName) {
    const msg = 'Error: escribe un nombre de producto/campana';
    updateStatusLine(app.state?.metrics || {}, msg);
    if (isSetupSource) setSetupMessage(msg, 'error');
    return { ok: false, error: 'missing_product_name' };
  }
  if (!Array.isArray(searchUrls) || !searchUrls.length) {
    const msg = 'Error: no se pudo generar el link de busqueda desde el producto.';
    updateStatusLine(app.state?.metrics || {}, msg);
    if (isSetupSource) setSetupMessage(msg, 'error');
    return { ok: false, error: 'missing_search_urls' };
  }

  const targetButton = button || els.startMonitor;
  const original = targetButton?.textContent || 'Iniciar';

  if (isSetupSource) {
    const startedAt = Date.now();
    if (targetButton) {
      targetButton.disabled = true;
      targetButton.textContent = 'Preparando...';
    }
    setSetupLoading(true, 'Espera a que configuremos todo.');
    setSetupMessage('Preparando menu de analisis...', 'muted');
    try {
      await refreshAnalyses();
      await waitMs(Math.max(0, SETUP_LOADING_MIN_MS - (Date.now() - startedAt)));
      setSetupLoading(false);
      openAnalysisMenu({
        source: 'setup',
        pendingStart: {
          productName,
          searchUrls,
          unitCost: parseUnitCostInput(unitCost),
        },
      });
      return { ok: true, pendingChoice: true };
    } catch (err) {
      const msg = `No se pudo preparar el menu: ${err?.message || 'error'}`;
      setSetupMessage(msg, 'error');
      updateStatusLine(app.state?.metrics || {}, msg);
      setSetupLoading(false);
      return { ok: false, error: 'analysis_menu_prepare_failed' };
    } finally {
      if (targetButton) {
        targetButton.disabled = false;
        targetButton.textContent = original;
      }
    }
  }

  let ok = false;
  if (targetButton) {
    targetButton.disabled = true;
    targetButton.textContent = 'Iniciando...';
  }

  try {
    const response = await send('rb:start-monitoring', {
      productName,
      searchUrls,
      unitCost: parseUnitCostInput(unitCost),
    });
    if (!response?.success || !response?.result?.ok) {
      const msg = `Error iniciando: ${response?.error || response?.result?.error || 'desconocido'}`;
      updateStatusLine(app.state?.metrics || {}, msg);
      if (isSetupSource) setSetupMessage(msg, 'error');
    } else {
      const msg = `Monitor iniciado: ${productName} (${searchUrls.length} links)`;
      updateStatusLine(app.state?.metrics || {}, msg);
      ok = true;
    }
    await loadState();
    return { ok };
  } finally {
    if (targetButton) {
      targetButton.disabled = false;
      targetButton.textContent = original;
    }
  }
}


async function runAction(button, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Ejecutando...';

  try {
    const response = await send(action);
    await loadState();
    const result = response?.result || {};

    if (action === 'rb:run-detect') {
      if (result?.disabled) {
        updateStatusLine(app.state?.metrics || {}, 'Analisis en pausa: pulsa Iniciar para reanudar');
      } else if (result?.aborted) {
        updateStatusLine(app.state?.metrics || {}, 'Deteccion detenida por usuario');
      } else if (result?.skipped) {
        updateStatusLine(app.state?.metrics || {}, 'Deteccion ya en curso');
      } else if (result?.updated === false) {
        updateStatusLine(
          app.state?.metrics || {},
          `Sin nuevos (links OK: ${result.urlsOk ?? 0}, error: ${result.urlsError ?? 0})`
        );
      } else {
        updateStatusLine(
          app.state?.metrics || {},
          `Nuevos: ${result.newCount ?? 0} | Detectados: ${result.detected ?? 0}`
        );
      }
    }
    if (action === 'rb:run-track') {
      if (result?.disabled) {
        updateStatusLine(app.state?.metrics || {}, 'Analisis en pausa: pulsa Iniciar para reanudar');
      } else if (result?.aborted) {
        updateStatusLine(app.state?.metrics || {}, 'Analisis detenido por usuario');
      } else if (result?.skipped) {
        updateStatusLine(app.state?.metrics || {}, 'Analisis ya en curso');
      } else {
        const sellerChecked = Number(result?.sellerChecked || 0);
        const sellerErrors = Number(result?.sellerErrors || 0);
        updateStatusLine(
          app.state?.metrics || {},
          `Analizados: ${result.checked ?? 0}/${result.attempted ?? 0} | errores: ${result.errors ?? 0} | expirados: ${result.expired ?? 0} | seller: ${sellerChecked}${sellerErrors > 0 ? ` (fallos: ${sellerErrors})` : ''}`
        );
      }
    }
    if (action === 'rb:clear-sold') {
      updateStatusLine(app.state?.metrics || {}, `Vendidos eliminados: ${response?.removed ?? 0}`);
    }
    if (action === 'rb:reset-all') {
      app.selectedItemId = null;
      updateStatusLine(
        app.state?.metrics || {},
        `Reset total: ${response?.removedItems ?? 0} productos eliminados`
      );
    }
      if (action === 'rb:stop-monitoring') {
        updateStatusLine(app.state?.metrics || {}, 'Analisis en pausa');
      }
  } catch (err) {
    updateStatusLine(app.state?.metrics || {}, err?.message || 'Error ejecutando accion');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values) {
  return values.map(csvEscape).join(',');
}

function sanitizeFileSlug(value, fallback = 'analisis') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function computeExportKpis(items, metrics) {
  const totalDetected = Number(metrics?.totalDetected || items.length || 0);
  const active = items.filter((item) => item.status === 'active').length;
  const reserved = items.filter((item) => item.status === 'reserved').length;
  const sold = items.filter((item) => item.status === 'sold').length;
  const expired = Number(metrics?.totalExpired || 0);
  const blockedAccounts = buildBlockedSellerRows(items).length;

  const soldWithTime = items.filter((item) => item.status === 'sold' && toNumber(item.timeToSellMinutes) !== null);
  const soldWithPrice = items.filter((item) => item.status === 'sold' && toNumber(item.soldPriceValue) !== null);
  const avgTimeMinutes =
    soldWithTime.length > 0
      ? soldWithTime.reduce((acc, item) => acc + Number(item.timeToSellMinutes || 0), 0) / soldWithTime.length
      : null;
  const avgSoldPrice =
    soldWithPrice.length > 0
      ? soldWithPrice.reduce((acc, item) => acc + Number(item.soldPriceValue || 0), 0) / soldWithPrice.length
      : null;

  return {
    totalDetected,
    active,
    reserved,
    sold,
    expired,
    blockedAccounts,
    avgTimeMinutes,
    avgSoldPrice,
  };
}

function buildModelPerformanceRows(items) {
  const map = new Map();
  for (const item of items) {
    const model = getModelLabel(item);
    const current = map.get(model) || {
      detected: 0,
      sold: 0,
      timeSum: 0,
      timeCount: 0,
      priceSum: 0,
      priceCount: 0,
    };
    current.detected += 1;
    if (item.status === 'sold') {
      current.sold += 1;
      const time = toNumber(item.timeToSellMinutes);
      if (time !== null) {
        current.timeSum += Number(time);
        current.timeCount += 1;
      }
      const price = toNumber(item.soldPriceValue);
      if (price !== null) {
        current.priceSum += Number(price);
        current.priceCount += 1;
      }
    }
    map.set(model, current);
  }
  return Array.from(map.entries())
    .map(([model, data]) => {
      const conversionPct = data.detected > 0 ? (data.sold / data.detected) * 100 : 0;
      const avgPrice = data.priceCount > 0 ? data.priceSum / data.priceCount : null;
      const avgTime = data.timeCount > 0 ? data.timeSum / data.timeCount : null;
      return {
        model,
        detected: data.detected,
        sold: data.sold,
        conversionPct,
        avgPrice,
        avgTime,
      };
    })
    .sort((a, b) => {
      const soldDiff = Number(b.sold || 0) - Number(a.sold || 0);
      if (soldDiff !== 0) return soldDiff;
      return Number(b.detected || 0) - Number(a.detected || 0);
    });
}

function buildSourcePerformanceRows(items) {
  const soldItems = items.filter((item) => item.status === 'sold');
  const linkStats = aggregateLinkStats(soldItems);
  return Array.from(linkStats.entries())
    .map(([sourceUrl, data]) => {
      const avgTime = data.timedCount > 0 ? data.sumMinutes / data.timedCount : null;
      const avgPrice = data.pricedCount > 0 ? data.sumPrice / data.pricedCount : null;
      const score =
        avgTime && avgTime > 0 && avgPrice !== null ? Number(avgPrice) / (Number(avgTime) / 60) : 0;
      return {
        sourceUrl,
        sourceLabel: sourceUrlLabel(sourceUrl),
        sold: Number(data.soldCount || 0),
        avgTime,
        avgPrice,
        score,
      };
    })
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function exportAnalysisReportCsv({ items, state, config, activeAnalysis, gateInfo = null }) {
  const list = Array.isArray(items) ? [...items] : [];
  list.sort((a, b) => new Date(b.detectedAt || 0).getTime() - new Date(a.detectedAt || 0).getTime());

  const metrics = state?.metrics || {};
  const kpis = computeExportKpis(list, metrics);
  const gate = gateInfo && typeof gateInfo === 'object'
    ? gateInfo
    : getExportGateInfoFromSnapshot(state, list);
  const modelRows = buildModelPerformanceRows(list);
  const sourceRows = buildSourcePerformanceRows(list);
  const speedRows = makeSpeedBuckets(list.filter((item) => item.status === 'sold'));
  const blockedSellerRows = buildBlockedSellerRows(list);
  const analysisName =
    activeAnalysis?.name || activeAnalysis?.productName || config?.productName || 'analisis';
  const analysisId = activeAnalysis?.id || app.activeAnalysisId || '-';

  const lines = [];

  lines.push(csvRow(['SECCION', 'CAMPO', 'VALOR']));
  lines.push(csvRow(['resumen', 'informe', 'LamineResell Report CSV']));
  lines.push(csvRow(['resumen', 'generado_en', new Date().toLocaleString()]));
  lines.push(csvRow(['resumen', 'analisis', analysisName]));
  lines.push(csvRow(['resumen', 'analisis_id', analysisId]));
  lines.push(csvRow(['resumen', 'producto_objetivo', String(config?.productName || '')]));
  lines.push(csvRow(['resumen', 'cuenta', String(config?.productName || '-')]));
  lines.push(csvRow(['resumen', 'nav_id', formatBrowserId(config || {})]));
  lines.push(csvRow(['resumen', 'tiempo_analisis', formatDurationCompact(gate.ageMs)]));
  lines.push(csvRow(['resumen', 'madurez_exportacion', gate.ready ? 'muestra_estable' : 'muestra_en_construccion']));
  lines.push(csvRow(['resumen', 'recomendacion', gate.ready ? 'Datos listos para decisiones' : 'Esperar mas tiempo para una muestra mas fiable']));

  lines.push('');
  lines.push(csvRow(['KPIS', 'detallado']));
  lines.push(csvRow(['kpi', 'total_detectados', kpis.totalDetected]));
  lines.push(csvRow(['kpi', 'activos', kpis.active]));
  lines.push(csvRow(['kpi', 'reservados', kpis.reserved]));
  lines.push(csvRow(['kpi', 'vendidos', kpis.sold]));
  lines.push(csvRow(['kpi', 'expirados_24h', kpis.expired]));
  lines.push(csvRow(['kpi', 'cuentas_bloqueadas', kpis.blockedAccounts]));
  lines.push(csvRow(['kpi', 'tiempo_medio_venta_min', kpis.avgTimeMinutes == null ? '' : kpis.avgTimeMinutes.toFixed(2)]));
  lines.push(csvRow(['kpi', 'precio_medio_venta_eur', kpis.avgSoldPrice == null ? '' : kpis.avgSoldPrice.toFixed(2)]));
  lines.push(csvRow(['kpi', 'ultima_deteccion', metrics?.lastDetectRun || '']));
  lines.push(csvRow(['kpi', 'ultimo_analisis', metrics?.lastTrackRun || '']));

  lines.push('');
  lines.push(
    csvRow([
      'TOP_MODELOS',
      'modelo',
      'detectados',
      'vendidos',
      'conversion_pct',
      'precio_medio_venta_eur',
      'tiempo_medio_venta_min',
    ])
  );
  for (const row of modelRows) {
    lines.push(
      csvRow([
        'top_modelos',
        row.model,
        row.detected,
        row.sold,
        row.conversionPct.toFixed(2),
        row.avgPrice == null ? '' : row.avgPrice.toFixed(2),
        row.avgTime == null ? '' : row.avgTime.toFixed(2),
      ])
    );
  }

  lines.push('');
  lines.push(csvRow(['TOP_LINKS', 'origen', 'vendidos', 'precio_medio_eur', 'tiempo_medio_min', 'score_rentabilidad']));
  for (const row of sourceRows) {
    lines.push(
      csvRow([
        'top_links',
        `${row.sourceLabel} | ${row.sourceUrl}`,
        row.sold,
        row.avgPrice == null ? '' : row.avgPrice.toFixed(2),
        row.avgTime == null ? '' : row.avgTime.toFixed(2),
        Number(row.score || 0).toFixed(2),
      ])
    );
  }

  lines.push('');
  lines.push(csvRow(['VELOCIDAD_VENTA', 'tramo', 'ventas']));
  for (const row of speedRows) {
    lines.push(csvRow(['velocidad_venta', row.label, row.value]));
  }

  lines.push('');
  lines.push(
    csvRow([
      'CUENTAS_BLOQUEADAS',
      'seller',
      'seller_perfil',
      'producto_asociado',
      'item_id',
      'modelo',
      'detectado_bloqueo',
      'motivo',
      'productos_asociados',
    ])
  );
  for (const row of blockedSellerRows) {
    lines.push(
      csvRow([
        'cuentas_bloqueadas',
        row.sellerName || '',
        row.sellerProfileUrl || '',
        row.item?.title || '',
        row.item?.itemId || '',
        getModelLabel(row.item || {}),
        row.checkedAt || '',
        row.reason || '',
        row.relatedProductsCount || 1,
      ])
    );
  }

  lines.push('');
  lines.push(
    csvRow([
      'DETALLE_PRODUCTOS',
      'estado',
      'id',
      'titulo',
      'modelo',
      'precio_actual',
      'precio_vendido',
      'likes',
      'ofertas',
      'visitas',
      'subido_texto',
      'publicado_estimado',
      'detectado',
      'vendido',
      'tiempo_venta_min',
      'url',
      'origen',
      'vendedor',
      'cuenta_seller',
    ])
  );
  for (const item of list) {
    const latest = item.latest || {};
    lines.push(
      csvRow([
        'detalle',
        item.status || '',
        item.itemId || '',
        item.title || '',
        getModelLabel(item),
        latest.priceText || '',
        item.soldPriceText || '',
        latest.likesCount ?? '',
        latest.offersCount ?? '',
        latest.viewsCount ?? '',
        latest.uploadedText || item.publishedAtText || '',
        item.publishedAt || latest.publishedAt || '',
        item.detectedAt || '',
        item.soldAt || '',
        item.timeToSellMinutes ?? '',
        item.url || '',
        getItemSourceUrl(item) || '',
        item.sellerName || '',
        getSellerStatusLabel(item),
      ])
    );
  }

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const datePart = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const slug = sanitizeFileSlug(analysisName, 'analisis');
  a.download = `informe_${slug}_${datePart}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return a.download;
}

function bindEvents() {
  if (els.analysisMenuButton) {
    els.analysisMenuButton.addEventListener('click', async () => {
      if (app.config?.monitorEnabled === true) {
        const message = 'Primero debes pausar el analisis para volver al menu.';
        updateStatusLine(app.state?.metrics || {}, message);
        setPauseRequiredVisible(true, message);
        return;
      }
      try {
        await refreshAnalyses();
      } catch (_) {
        // no-op
      }
      openAnalysisMenu({ source: 'dashboard' });
    });
  }
  if (els.openActionsModule) {
    els.openActionsModule.addEventListener('click', async () => {
      try {
        await send('rb:open-actions-module');
      } catch (err) {
        updateStatusLine(
          app.state?.metrics || {},
          `No se pudo abrir el modulo de acciones: ${err?.message || 'desconocido'}`
        );
      }
    });
  }

  const openMarketplace = async () => {
    try {
      await send('rb:open-marketplace-module');
    } catch (err) {
      updateStatusLine(
        app.state?.metrics || {},
        `No se pudo abrir el modulo de marketplace: ${err?.message || 'desconocido'}`
      );
    }
  };
  if (els.openMarketplaceBtn) {
    els.openMarketplaceBtn.addEventListener('click', openMarketplace);
  }
  if (els.openMarketplaceSidebarBtn) {
    els.openMarketplaceSidebarBtn.addEventListener('click', openMarketplace);
  }
  if (els.analysisMenuClose) {
    els.analysisMenuClose.addEventListener('click', () => {
      if (app.analysisMenuBusy) return;
      closeAnalysisMenu();
    });
  }
  if (els.analysisMenuCancel) {
    els.analysisMenuCancel.addEventListener('click', () => {
      if (app.analysisMenuBusy) return;
      closeAnalysisMenu();
    });
  }
  if (els.analysisMenuCreate) {
    els.analysisMenuCreate.addEventListener('click', () => {
      if (app.analysisMenuBusy) return;
      void createAnalysisFromMenu();
    });
  }
  if (els.analysisMenuOverlay) {
    els.analysisMenuOverlay.addEventListener('click', (event) => {
      if (app.analysisMenuBusy) return;
      if (event.target === els.analysisMenuOverlay) {
        closeAnalysisMenu();
      }
    });
  }
  if (els.pauseRequiredOverlay) {
    els.pauseRequiredOverlay.addEventListener('click', (event) => {
      if (event.target === els.pauseRequiredOverlay) {
        setPauseRequiredVisible(false);
      }
    });
  }
  if (els.pauseRequiredClose) {
    els.pauseRequiredClose.addEventListener('click', () => {
      setPauseRequiredVisible(false);
    });
  }
  if (els.pauseRequiredOk) {
    els.pauseRequiredOk.addEventListener('click', () => {
      setPauseRequiredVisible(false);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.pauseRequiredOverlay?.hidden) {
      setPauseRequiredVisible(false);
      return;
    }
    if (!app.analysisMenuBusy && !els.analysisMenuOverlay?.hidden) {
      closeAnalysisMenu();
      return;
    }
  });
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('.sort-btn') : null;
    if (!button) return;
    const table = String(button.dataset.sortTable || '');
    const key = String(button.dataset.sortKey || '');
    if (!table || !key) return;
    toggleTableSort(table, key);
    renderAll();
  });

  if (els.startMonitor) {
    els.startMonitor.addEventListener('click', async () => {
      const productName = String(els.productName?.value || '').trim();
      const searchUrls = parseSearchUrlsInput(els.searchUrls?.value || '');
      await startMonitorFlow({
        productName,
        searchUrls,
        unitCost: app.config?.unitCost,
        button: els.startMonitor,
        source: 'dashboard',
      });
    });
  }

  if (els.setupStartMonitor) {
    els.setupStartMonitor.addEventListener('click', async () => {
      const productName = String(els.setupProductName?.value || '').trim();
      const category    = String(els.setupCategory?.value  || '').trim();
      const priceFrom   = String(els.setupPriceFrom?.value || '').trim();
      const priceTo     = String(els.setupPriceTo?.value   || '').trim();
      const searchUrls  = productName
        ? [buildAutoSearchUrl(productName, { category, priceFrom, priceTo })]
        : [];
      const unitCost = parseUnitCostInput(els.setupUnitCost?.value);
      if (els.productName) els.productName.value = productName;
      if (els.searchUrls)  els.searchUrls.value  = searchUrls.join('\n');
      await startMonitorFlow({
        productName,
        searchUrls,
        unitCost,
        button: els.setupStartMonitor,
        source: 'setup',
      });
    });
  }

  if (els.setupProductName) {
    const syncSetupSearchUrl = () => {
      const name      = String(els.setupProductName.value || '').trim() || 'rayban';
      const category  = String(els.setupCategory?.value  || '');
      const priceFrom = String(els.setupPriceFrom?.value || '');
      const priceTo   = String(els.setupPriceTo?.value   || '');
      const generated = buildAutoSearchUrl(name, { category, priceFrom, priceTo });
      if (els.searchUrls && document.activeElement !== els.searchUrls) {
        els.searchUrls.value = generated;
      }
      app.lastAutoSearchUrl = generated;
    };
    els.setupProductName.addEventListener('input', syncSetupSearchUrl);
    if (els.setupCategory)  els.setupCategory.addEventListener('change', syncSetupSearchUrl);
    if (els.setupPriceFrom) els.setupPriceFrom.addEventListener('input', syncSetupSearchUrl);
    if (els.setupPriceTo)   els.setupPriceTo.addEventListener('input',   syncSetupSearchUrl);
    syncSetupSearchUrl();
  }

  // ── Price chips ──────────────────────────────────────────────────────────
  if (els.setupPriceChips?.length) {
    els.setupPriceChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        // Toggle: click same chip again → deselect
        const isActive = chip.classList.contains('active');
        els.setupPriceChips.forEach((c) => c.classList.remove('active'));
        if (!isActive) {
          chip.classList.add('active');
          if (els.setupPriceFrom) els.setupPriceFrom.value = chip.dataset.from;
          if (els.setupPriceTo)   els.setupPriceTo.value   = chip.dataset.to;
        } else {
          if (els.setupPriceFrom) els.setupPriceFrom.value = '';
          if (els.setupPriceTo)   els.setupPriceTo.value   = '';
        }
        // Sync the hidden search URL
        if (els.setupProductName) els.setupProductName.dispatchEvent(new Event('input'));
      });
    });
  }
  if (els.setupPriceClear) {
    els.setupPriceClear.addEventListener('click', () => {
      els.setupPriceChips?.forEach((c) => c.classList.remove('active'));
      if (els.setupPriceFrom) els.setupPriceFrom.value = '';
      if (els.setupPriceTo)   els.setupPriceTo.value   = '';
      if (els.setupProductName) els.setupProductName.dispatchEvent(new Event('input'));
    });
  }
  if (els.productName) {
    els.productName.addEventListener('input', () => {
      syncDashboardAutoUrlFromProduct();
    });
  }

  if (els.stopMonitor) {
    els.stopMonitor.addEventListener('click', () => runAction(els.stopMonitor, 'rb:stop-monitoring'));
  }
  if (els.detectNow) {
    els.detectNow.addEventListener('click', () => runAction(els.detectNow, 'rb:run-detect'));
  }
  if (els.trackNow) {
    els.trackNow.addEventListener('click', () => runAction(els.trackNow, 'rb:run-track'));
  }
  if (els.clearSold) {
    els.clearSold.addEventListener('click', () => runAction(els.clearSold, 'rb:clear-sold'));
  }
  if (els.resetAll) {
    els.resetAll.addEventListener('click', () => runAction(els.resetAll, 'rb:reset-all'));
  }

  if (els.saveUrl) {
    els.saveUrl.addEventListener('click', async () => {
      const searchUrls = parseSearchUrlsInput(els.searchUrls?.value || '');
      if (!searchUrls.length) {
        updateStatusLine(app.state?.metrics || {}, 'Error: pega al menos un link valido de vinted.es');
        return;
      }

      const original = els.saveUrl.textContent;
      els.saveUrl.disabled = true;
      els.saveUrl.textContent = 'Guardando...';

      try {
        const response = await send('rb:set-search-urls', { searchUrls });
        if (!response?.success) {
          updateStatusLine(app.state?.metrics || {}, `Error guardando links: ${response?.error || 'desconocido'}`);
        } else {
          updateStatusLine(
            app.state?.metrics || {},
            `Links guardados: ${searchUrls.length}`
          );
        }
        await loadState();
      } finally {
        els.saveUrl.disabled = false;
        els.saveUrl.textContent = original;
      }
    });
  }

  if (els.refreshNow) {
    els.refreshNow.addEventListener('click', async () => {
      try {
        await send('rb:refresh-vinted-session');
      } catch (_) {
        // no-op
      }
      await loadState();
    });
  }

  if (els.exportCsv) {
    els.exportCsv.addEventListener('click', () => {
      const gate = getExportGateInfo();
      if (!gate.ready) {
        updateStatusLine(
          app.state?.metrics || {},
          `Exportacion bloqueada: espera ${formatDurationCompact(gate.remainingMs)} para tener un informe fiable.`
        );
        updateExportButtonState();
        renderAnalysisMaturity();
        return;
      }
      const fileName = exportAnalysisReportCsv({
        items: app.items,
        state: app.state || {},
        config: app.config || {},
        activeAnalysis: getActiveAnalysisSummary(),
      });
      updateStatusLine(app.state?.metrics || {}, `Informe exportado: ${fileName}`);
    });
  }

  for (const input of [
    els.filterStatus,
    els.filterModel,
    els.filterPopular,
    els.filterMinLikes,
    els.filterMinViews,
  ]) {
    if (!input) continue;
    input.addEventListener('input', renderAll);
    input.addEventListener('change', renderAll);
  }

  if (els.resetFilters) {
    els.resetFilters.addEventListener('click', () => {
      if (els.filterStatus) els.filterStatus.value = 'all';
      if (els.filterModel) els.filterModel.value = '';
      if (els.filterPopular) els.filterPopular.value = 'all';
      if (els.filterMinLikes) els.filterMinLikes.value = '0';
      if (els.filterMinViews) els.filterMinViews.value = '0';
      renderAll();
    });
  }

  els.timelineMetric.addEventListener('change', renderDetail);
  if (els.autoRefresh) {
    els.autoRefresh.addEventListener('change', setAutoRefreshTimer);
  }
  els.keywordWindow.addEventListener('change', () => {
    app.keywordSelection.window = String(els.keywordWindow.value || '30d');
    renderCharts(app.items);
  });

  // ── Cuenta Vinted ─────────────────────────────────────────────────────────
  if (els.openCuentaVintedBtn) {
    els.openCuentaVintedBtn.addEventListener('click', async () => {
      try {
        await send('rb:open-cuenta-vinted-module');
      } catch (err) {
        console.warn('[CuentaVinted] No se pudo abrir:', err?.message);
      }
    });
  }
}

async function initDashboard() {
  startStatusTicker();
  bindEvents();
  await loadState();
  try {
    await send('rb:refresh-vinted-session');
    await loadState();
  } catch (_) {
    // no-op
  }
  setAutoRefreshTimer();
}

void initDashboard();
