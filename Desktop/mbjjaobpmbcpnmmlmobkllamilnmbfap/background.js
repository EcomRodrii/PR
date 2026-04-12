const DEFAULT_SEARCH_URL = 'https://www.vinted.es/catalog?order=newest_first&brand_ids%5B%5D=242&page=1';
const DEFAULT_OAKLEY_URL = 'https://www.vinted.es/catalog?search_text=oakley&order=newest_first&page=1&catalog%5B%5D=98';
const CONFIG_KEY = 'raybanMonitorConfig';
const STORAGE_KEY = 'raybanMonitorState';
const ANALYSES_KEY = 'raybanMonitorAnalyses';
const RUNTIME_KEY = 'raybanMonitorRuntime';
const DETECT_ALARM = 'rayban-detect';
const TRACK_ALARM = 'rayban-track';
const CYCLE_ALARM = 'rayban-cycle';
const DETECT_PERIOD_MIN = 5;           // detectar nuevos listings cada 5 min
const EXPIRY_HOURS = 24;
const MAX_SNAPSHOTS = 400;
const DETECT_PARALLEL_TABS = 3;        // 3 búsquedas de catálogo en paralelo
const TRACK_PARALLEL_TABS = 4;         // 4 análisis de item en paralelo
const SELLER_CHECK_INTERVAL_HOURS = 12;
const SELLER_CHECK_MAX_PER_TRACK = 5;  // hasta 5 seller checks por ciclo
// ── Prioridades de re-análisis por item ────────────────────────────────────
// P0 (siempre): nuevos (<10min), reservados, nunca analizados
// P1 (5 min):   <2h de edad, o tiene ≥3 likes, o precio bajó recientemente
// P2 (20 min):  activos entre 2h y 8h con actividad normal
// P3 (60 min):  activos >8h sin engagement — casi nunca se venden
const RECHECK_P1_MIN = 5;
const RECHECK_P2_MIN = 20;
const RECHECK_P3_MIN = 60;
const LIKES_THRESHOLD_P1 = 3;         // ≥3 likes → tratar como P1
const ITEM_AGE_P1_MS   = 2  * 60 * 60 * 1000;  // <2h → P1
const ITEM_AGE_P2_MS   = 8  * 60 * 60 * 1000;  // 2-8h → P2
// ── Rate limit / anti-bloqueo ──────────────────────────────────────────────
const RATE_LIMIT_RPM = 28;             // máx 28 req/min — usuario activo real
const RATE_LIMIT_BURST = 6;            // ráfaga inicial de 6 tokens
const API_JITTER_MIN_MS = 350;         // delay mínimo entre requests
const API_JITTER_MAX_MS = 1400;        // delay máximo entre requests
const API_RETRY_429_MAX = 3;           // reintentos al recibir 429
const API_RETRY_429_BASE_MS = 12000;   // espera base ante 429 (12s × backoff)
const EXTENSION_VERSION = chrome.runtime.getManifest().version || '0.0.0';
const MODEL_KEYWORDS = [
  'wayfarer',
  'new wayfarer',
  'aviator',
  'clubmaster',
  'erika',
  'justin',
  'caravan',
  'jack',
  'round',
  'hexagonal',
  'balorama',
  'state street',
  'rb2140',
  'rb3025',
  'rb3016',
  'rb3447',
  'radar ev',
  'radar',
  'holbrook',
  'jawbreaker',
  'sutro',
  'frogskins',
  'flak',
  'gascan',
  'encoder',
  'm frame',
  'mainlink',
  'latch',
];
const KEYWORD_COMPETITION = [
  'wayfarer',
  'aviator',
  'clubmaster',
  'erika',
  'justin',
  'caravan',
  'jack',
  'round',
  'hexagonal',
  'balorama',
  'radar',
  'holbrook',
  'jawbreaker',
  'sutro',
  'frogskins',
  'flak',
  'gascan',
  'encoder',
  'm frame',
  'oakley',
];
const FOCUS_MODEL_TERMS = ['wayfarer', 'aviator', 'radar', 'holbrook'];
const SEARCH_TOKEN_STOPWORDS = new Set([
  'para',
  'with',
  'from',
  'con',
  'sin',
  'por',
  'las',
  'los',
  'the',
  'and',
]);
const BRAND_ID_MATCH_TERMS = {
  242: ['rayban', 'ray ban', 'ray-ban'],
};
const PHASE_DETECT = 'detect';
const PHASE_TRACK = 'track';
const ANALYSES_STORE_VERSION = 1;
const EXPORT_MIN_ANALYSIS_MS = 60 * 60 * 1000;
const MODEL_EXPLOITABLE_MIN_SOLD = 6;
const MODEL_EXPLOITABLE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

let detectRunning = false;
let trackRunning = false;
let monitorRunId = 0;
let vintedSessionRefreshPromise = null;

// ── RATE LIMITER (token bucket) ─────────────────────────────
// Garantiza que no se superen RATE_LIMIT_RPM requests/minuto
// con una ráfaga inicial de RATE_LIMIT_BURST tokens.
const _rl = {
  tokens: RATE_LIMIT_BURST,
  lastRefill: Date.now(),
  queue: [],
  running: false,
};

function _rlRefill() {
  const now = Date.now();
  const elapsed = now - _rl.lastRefill;
  const add = (elapsed / 60000) * RATE_LIMIT_RPM;
  _rl.tokens = Math.min(RATE_LIMIT_BURST + RATE_LIMIT_RPM, _rl.tokens + add);
  _rl.lastRefill = now;
}

async function _rlDrain() {
  if (_rl.running) return;
  _rl.running = true;
  while (_rl.queue.length > 0) {
    _rlRefill();
    if (_rl.tokens >= 1) {
      _rl.tokens -= 1;
      const resolve = _rl.queue.shift();
      resolve();
    } else {
      const waitMs = Math.ceil((1 - _rl.tokens) / RATE_LIMIT_RPM * 60000) + 50;
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  _rl.running = false;
}

function rateLimitToken() {
  return new Promise(resolve => {
    _rl.queue.push(resolve);
    void _rlDrain();
  });
}

// Jitter aleatorio para parecer tráfico humano
function jitter(minMs = API_JITTER_MIN_MS, maxMs = API_JITTER_MAX_MS) {
  const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
  return new Promise(r => setTimeout(r, ms));
}

// Headers que simulan un navegador real
function vintedApiHeaders(extra = {}) {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://www.vinted.es/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  };
}

// Fetch con rate limit + jitter + backoff en 429
async function vintedFetch(url, opts = {}, attempt = 0) {
  await rateLimitToken();
  if (attempt > 0) await jitter(API_JITTER_MIN_MS, API_JITTER_MAX_MS);

  const res = await fetch(url, {
    credentials: 'include',
    ...opts,
    headers: { ...vintedApiHeaders(), ...(opts.headers || {}) },
  });

  if (res.status === 429 && attempt < API_RETRY_429_MAX) {
    const retryAfter = Number(res.headers.get('Retry-After') || 0) * 1000;
    const waitMs = retryAfter || API_RETRY_429_BASE_MS * Math.pow(2, attempt);
    await new Promise(r => setTimeout(r, waitMs + Math.random() * 3000));
    return vintedFetch(url, opts, attempt + 1);
  }

  return res;
}

function isRunCancelled(localRunId) {
  return localRunId !== monitorRunId;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeApiEndpoint(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return String(fallback || '').trim();
  if (!/^https?:\/\//i.test(raw)) return String(fallback || '').trim();
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return String(fallback || '').trim();
  }
}


function parsePriceValue(priceText) {
  if (!priceText) return null;
  const m = String(priceText).replace(/\s+/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function normalizeUnitCost(value) {
  if (value == null || value === '') return null;
  let n = null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const normalized = text.replace(/\s+/g, '').replace(',', '.');
    n = Number(normalized);
    if (!Number.isFinite(n)) {
      const fallbackMatch = text.match(/-?\d+(?:[.,]\d+)?/);
      if (!fallbackMatch) return null;
      n = Number(String(fallbackMatch[0]).replace(',', '.'));
    }
  } else {
    n = Number(value);
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function parseRelativeUploadAgeMinutes(rawValue) {
  function unitFactorMinutes(unitValue) {
    const unitRaw = String(unitValue || '').trim();
    if (/^(segundo|segundos|second|seconds)$/.test(unitRaw)) return 0;
    if (/^(minuto|minutos|min|minute|minutes|minuti)$/.test(unitRaw)) return 1;
    if (/^(hora|horas|hour|hours|ora|ore)$/.test(unitRaw)) return 60;
    if (/^(dia|dias|day|days|giorno|giorni)$/.test(unitRaw)) return 60 * 24;
    if (/^(semana|semanas|week|weeks|settimana|settimane)$/.test(unitRaw)) return 60 * 24 * 7;
    if (/^(mes|meses|month|months|mese|mesi)$/.test(unitRaw)) return 60 * 24 * 30;
    if (/^(ano|anos|year|years|anno|anni)$/.test(unitRaw)) return 60 * 24 * 365;
    return null;
  }

  const text = String(rawValue || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  if (/\b(ahora|justo ahora|today|oggi)\b/.test(text)) {
    return 0;
  }
  if (/\b(ayer|yesterday|ieri)\b/.test(text)) {
    return 24 * 60;
  }
  if (/\b(hace un momento|hace unos instantes|moments ago|just now)\b/.test(text)) {
    return 0;
  }
  if (/\b(segundo|segundos|second|seconds)\b/.test(text)) {
    return 0;
  }

  const approximate = text.match(
    /\b(?:hace|ago|fa)\s+unos?\s+(segundos?|seconds?|minutos?|minutes?|horas?|hours?|dias?|days?|semanas?|weeks?|meses?|months?|anos?|years?|minuti|ore|giorni|settimane|mesi|anni)\b/
  );
  if (approximate) {
    const factor = unitFactorMinutes(approximate[1]);
    if (Number.isFinite(factor)) {
      return 2 * factor;
    }
  }

  const match =
    text.match(
      /\b(?:hace|ago|fa)\s+(?:unos?\s+|about\s+|circa\s+)?(\d+|un|una|uno|an|a|one)\s+(segundo|segundos|second|seconds|minuto|minutos|min|minute|minutes|minuti|ora|ore|hora|horas|hour|hours|dia|dias|day|days|giorno|giorni|semana|semanas|week|weeks|settimana|settimane|mes|meses|month|months|mese|mesi|ano|anos|year|years|anno|anni)\b/
    ) ||
    text.match(
      /\b(\d+|un|una|uno|an|a|one)\s+(segundo|segundos|second|seconds|minuto|minutos|min|minute|minutes|minuti|ora|ore|hora|horas|hour|hours|dia|dias|day|days|giorno|giorni|semana|semanas|week|weeks|settimana|settimane|mes|meses|month|months|mese|mesi|ano|anos|year|years|anno|anni)\s+(?:ago|fa)\b/
    );

  if (!match) return null;

  const amountRaw = String(match[1] || '').trim();
  const unitRaw = String(match[2] || '').trim();
  const amount = /^\d+$/.test(amountRaw) ? Number(amountRaw) : 1;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const factorMinutes = unitFactorMinutes(unitRaw);
  if (!Number.isFinite(factorMinutes)) return null;
  return amount * factorMinutes;
}

function estimatePublishedAtIso(uploadedText, referenceIso = null) {
  const minutes = parseRelativeUploadAgeMinutes(uploadedText);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const refMs = new Date(referenceIso || nowIso()).getTime();
  if (!Number.isFinite(refMs)) return null;
  const ts = refMs - minutes * 60 * 1000;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts).toISOString();
}

function formatDurationFromMs(msInput) {
  const ms = Math.max(0, Number(msInput) || 0);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}


function normalizeCyclePhase(value) {
  return value === PHASE_TRACK ? PHASE_TRACK : PHASE_DETECT;
}

function fmtMinutesLabel(minutes) {
  if (!Number.isFinite(Number(minutes))) return '-';
  const n = Number(minutes);
  if (n < 60) return `${n.toFixed(0)} min`;
  return `${(n / 60).toFixed(2)} h`;
}




function inferModelName(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return 'desconocido';
  // Prioridad total a los 4 modelos clave que quieres comparar.
  for (const kw of FOCUS_MODEL_TERMS) {
    if (text.includes(kw)) return kw;
  }
  for (const kw of MODEL_KEYWORDS) {
    if (text.includes(kw)) return kw;
  }
  return 'desconocido';
}

function extractKeywordHitsFromText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return [];
  const matches = [];
  for (const kw of KEYWORD_COMPETITION) {
    if (text.includes(kw)) {
      matches.push(kw);
    }
  }
  return [...new Set(matches)];
}

function defaultState() {
  return {
    items: [],
    metrics: {
      totalDetected: 0,
      totalSold: 0,
      totalExpired: 0,
      keywordHits: {},
      modelExploitAlerts: {},
      lastDetectSummary: null,
      lastTrackSummary: null,
      lastDetectRun: null,
      lastTrackRun: null,
      firstMonitorStartAt: null,
      lastMonitorStartAt: null,
      lastError: null,
    },
  };
}

function defaultRuntimeState() {
  return {
    monitorRunning: false,
    lastStartAt: null,
    lastHeartbeatAt: null,
    lastCleanStopAt: null,
    lastStopReason: null,
  };
}

function defaultConfig() {
  return {
    monitorEnabled: false,
    productName: '',
    unitCost: null,
    searchUrls: [],
    detectPeriodMinutes: DETECT_PERIOD_MIN,
    nextCyclePhase: PHASE_DETECT,
    scanPages: 2,       // páginas a escanear por URL (1-5)
    priceMin: null,     // filtrar items por debajo de este precio (€)
    priceMax: null,     // filtrar items por encima de este precio (€)
  };
}

function normalizeAnalysisName(value, fallback = 'Analisis') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return String(fallback || 'Analisis').trim();
  return raw.slice(0, 60);
}

function createAnalysisId() {
  if (typeof crypto?.randomUUID === 'function') {
    return `analysis-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `analysis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSearchUrls(input) {
  const rawList = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split('\n')
      : [];
  const urls = rawList
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .filter((v) => v.startsWith('https://www.vinted.es/'));
  return [...new Set(urls)];
}

function normalizePlainText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenizeSearchText(rawValue) {
  const normalized = normalizePlainText(rawValue);
  if (!normalized) return [];
  const parts = normalized
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => v.length >= 4)
    .filter((v) => !SEARCH_TOKEN_STOPWORDS.has(v));
  return [...new Set(parts)];
}

function parseSearchConstraints(searchUrl) {
  const constraints = {
    searchTokens: [],
    brandTokens: [],
  };
  try {
    const parsed = new URL(searchUrl);
    constraints.searchTokens = tokenizeSearchText(parsed.searchParams.get('search_text') || '');

    const brandIds = parsed.searchParams
      .getAll('brand_ids[]')
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    const brandTokenSet = new Set();
    for (const brandId of brandIds) {
      const terms = BRAND_ID_MATCH_TERMS[brandId] || [];
      for (const term of terms) {
        const normalizedTerm = normalizePlainText(term);
        if (normalizedTerm) {
          brandTokenSet.add(normalizedTerm);
        }
      }
    }
    constraints.brandTokens = Array.from(brandTokenSet);
  } catch (_) {
    // ignore malformed URL and skip constraints
  }
  return constraints;
}

function matchesAnyConstraintToken(textBlob, tokens) {
  return tokens.some((token) => textBlob.includes(token));
}

function filterDetectedBySearchUrl(searchUrl, detectedItems) {
  const constraints = parseSearchConstraints(searchUrl);
  const hasSearchTokens = constraints.searchTokens.length > 0;
  const hasBrandTokens = constraints.brandTokens.length > 0;
  if (!hasSearchTokens && !hasBrandTokens) {
    return {
      items: detectedItems,
      dropped: 0,
    };
  }

  const filtered = [];
  let dropped = 0;
  for (const entry of detectedItems) {
    const blob = normalizePlainText(
      `${entry?.title || ''} ${entry?.catalogText || ''} ${entry?.url || ''}`
    );
    if (!blob) {
      dropped += 1;
      continue;
    }
    if (hasSearchTokens && !matchesAnyConstraintToken(blob, constraints.searchTokens)) {
      dropped += 1;
      continue;
    }
    if (hasBrandTokens && !matchesAnyConstraintToken(blob, constraints.brandTokens)) {
      dropped += 1;
      continue;
    }
    filtered.push(entry);
  }

  return {
    items: filtered,
    dropped,
  };
}

function normalizeConfigSnapshot(rawConfig) {
  const loaded = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const base = defaultConfig();
  const monitorEnabled = loaded.monitorEnabled === true;
  const productName = typeof loaded.productName === 'string' ? loaded.productName.trim() : '';
  const unitCost = normalizeUnitCost(loaded.unitCost);
  let searchUrls = normalizeSearchUrls(loaded.searchUrls);
  if (!searchUrls.length) {
    const legacyUrl =
      typeof loaded.searchUrl === 'string' && loaded.searchUrl.startsWith('https://www.vinted.es/')
        ? loaded.searchUrl
        : '';
    searchUrls = normalizeSearchUrls(legacyUrl || base.searchUrls || []);
  }

  const detectPeriodMinutes =
    Number.isFinite(Number(loaded.detectPeriodMinutes)) && Number(loaded.detectPeriodMinutes) >= 5
      ? Number(loaded.detectPeriodMinutes)
      : DETECT_PERIOD_MIN;
  const nextCyclePhase = normalizeCyclePhase(loaded.nextCyclePhase || base.nextCyclePhase);

  const scanPages = Number.isFinite(Number(loaded.scanPages))
    && Number(loaded.scanPages) >= 1 && Number(loaded.scanPages) <= 5
    ? Math.round(Number(loaded.scanPages)) : 2;
  const priceMin = Number.isFinite(Number(loaded.priceMin)) && Number(loaded.priceMin) > 0
    ? Number(loaded.priceMin) : null;
  const priceMax = Number.isFinite(Number(loaded.priceMax)) && Number(loaded.priceMax) > 0
    ? Number(loaded.priceMax) : null;

  return {
    monitorEnabled,
    productName,
    unitCost,
    searchUrls,
    searchUrl: searchUrls[0] || '',
    detectPeriodMinutes,
    nextCyclePhase,
    scanPages,
    priceMin,
    priceMax,
  };
}

function normalizeStateSnapshot(rawState) {
  const base = defaultState();
  const loaded = rawState && typeof rawState === 'object' ? rawState : {};
  return {
    ...base,
    ...loaded,
    metrics: {
      ...base.metrics,
      ...(loaded.metrics || {}),
    },
    items: Array.isArray(loaded.items) ? loaded.items : [],
  };
}

function normalizeAnalysisEntry(rawEntry, { idFallback = '', nameFallback = 'Analisis' } = {}) {
  const source = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const entryId = String(source.id || idFallback || '').trim() || createAnalysisId();
  const config = normalizeConfigSnapshot(source.config || source);
  const state = normalizeStateSnapshot(source.state);
  const createdAt = String(source.createdAt || '').trim() || nowIso();
  const updatedAt = String(source.updatedAt || '').trim() || createdAt;
  const nameSeed = source.name || config.productName || nameFallback;
  return {
    id: entryId,
    name: normalizeAnalysisName(nameSeed, nameFallback),
    createdAt,
    updatedAt,
    config,
    state,
  };
}

function defaultAnalysesStore() {
  const createdAt = nowIso();
  const id = createAnalysisId();
  const entry = normalizeAnalysisEntry(
    {
      id,
      name: 'Analisis 1',
      createdAt,
      updatedAt: createdAt,
      config: defaultConfig(),
      state: defaultState(),
    },
    { idFallback: id, nameFallback: 'Analisis 1' }
  );
  return {
    version: ANALYSES_STORE_VERSION,
    activeId: entry.id,
    analyses: {
      [entry.id]: entry,
    },
  };
}

function normalizeAnalysesStore(rawStore) {
  const source = rawStore && typeof rawStore === 'object' ? rawStore : {};
  const rawAnalyses =
    source.analyses && typeof source.analyses === 'object' ? source.analyses : {};
  const analyses = {};
  let index = 1;
  for (const [idKey, rawEntry] of Object.entries(rawAnalyses)) {
    const fallbackName = `Analisis ${index}`;
    const entry = normalizeAnalysisEntry(rawEntry, {
      idFallback: idKey,
      nameFallback: fallbackName,
    });
    analyses[entry.id] = entry;
    index += 1;
  }

  if (Object.keys(analyses).length === 0) {
    return defaultAnalysesStore();
  }

  const requestedActiveId = String(source.activeId || '').trim();
  const activeId = analyses[requestedActiveId]
    ? requestedActiveId
    : Object.keys(analyses)[0];

  return {
    version: ANALYSES_STORE_VERSION,
    activeId,
    analyses,
  };
}

function getAnalysisStartMsFromState(state) {
  const safeState = state && typeof state === 'object' ? state : {};
  const metrics = safeState.metrics && typeof safeState.metrics === 'object' ? safeState.metrics : {};
  const metricStartMs = new Date(metrics.firstMonitorStartAt || metrics.lastMonitorStartAt || 0).getTime();
  if (Number.isFinite(metricStartMs) && metricStartMs > 0) {
    return metricStartMs;
  }
  const items = Array.isArray(safeState.items) ? safeState.items : [];
  const timestamps = items
    .map((item) => new Date(item?.detectedAt || 0).getTime())
    .filter((ts) => Number.isFinite(ts) && ts > 0);
  if (!timestamps.length) return 0;
  return Math.min(...timestamps);
}

function buildAnalysisSummary(entry, activeId = '') {
  const normalized = normalizeAnalysisEntry(entry, {
    idFallback: entry?.id || createAnalysisId(),
    nameFallback: 'Analisis',
  });
  const state = normalized.state;
  const metrics = state?.metrics || {};
  const items = Array.isArray(state?.items) ? state.items : [];
  const startMs = getAnalysisStartMsFromState(state);
  const analysisAgeMs = startMs > 0 ? Math.max(0, Date.now() - startMs) : 0;
  const analysisStartAt = startMs > 0 ? new Date(startMs).toISOString() : null;
  const sold = items.filter((item) => item?.status === 'sold').length;
  const active = items.filter((item) => item?.status === 'active').length;
  const reserved = items.filter((item) => item?.status === 'reserved').length;
  const totalDetected = Number(metrics.totalDetected || items.length || 0);
  return {
    id: normalized.id,
    name: normalized.name,
    productName: normalized.config?.productName || '',
    unitCost: normalizeUnitCost(normalized.config?.unitCost),
    monitorEnabled: normalized.config?.monitorEnabled === true,
    linksCount: Array.isArray(normalized.config?.searchUrls)
      ? normalized.config.searchUrls.length
      : 0,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    isActive: normalized.id === String(activeId || '').trim(),
    metrics: {
      totalDetected,
      sold,
      active,
      reserved,
      lastDetectRun: metrics.lastDetectRun || null,
      lastTrackRun: metrics.lastTrackRun || null,
      firstMonitorStartAt: metrics.firstMonitorStartAt || null,
      lastMonitorStartAt: metrics.lastMonitorStartAt || null,
      analysisStartAt,
      analysisAgeMs,
      exportReady: analysisAgeMs >= EXPORT_MIN_ANALYSIS_MS,
    },
  };
}

async function setAnalysesStore(store, { syncActive = true } = {}) {
  const normalized = normalizeAnalysesStore(store);
  const payload = { [ANALYSES_KEY]: normalized };
  if (syncActive) {
    const activeEntry = normalized.analyses?.[normalized.activeId];
    if (activeEntry) {
      payload[CONFIG_KEY] = activeEntry.config;
      payload[STORAGE_KEY] = activeEntry.state;
    }
  }
  await chrome.storage.local.set(payload);
  return normalized;
}

async function getAnalysesStore() {
  const raw = await chrome.storage.local.get([ANALYSES_KEY, CONFIG_KEY, STORAGE_KEY]);
  const storeRaw = raw?.[ANALYSES_KEY];

  if (storeRaw && typeof storeRaw === 'object') {
    const normalized = normalizeAnalysesStore(storeRaw);
    const activeEntry = normalized.analyses?.[normalized.activeId] || null;
    const sourceActiveId = String(storeRaw.activeId || '').trim();
    const hasConfig = !!raw?.[CONFIG_KEY];
    const hasState = !!raw?.[STORAGE_KEY];
    const needsBasicSync =
      !hasConfig ||
      !hasState ||
      sourceActiveId !== normalized.activeId ||
      !storeRaw?.analyses?.[normalized.activeId];

    if (needsBasicSync && activeEntry) {
      const payload = { [ANALYSES_KEY]: normalized };
      payload[CONFIG_KEY] = activeEntry.config;
      payload[STORAGE_KEY] = activeEntry.state;
      await chrome.storage.local.set(payload);
    }
    return normalized;
  }

  const migratedConfig = normalizeConfigSnapshot(raw?.[CONFIG_KEY] || {});
  const migratedState = normalizeStateSnapshot(raw?.[STORAGE_KEY] || {});
  const createdAt = nowIso();
  const id = createAnalysisId();
  const entry = normalizeAnalysisEntry(
    {
      id,
      name: normalizeAnalysisName(migratedConfig.productName || 'Analisis 1', 'Analisis 1'),
      createdAt,
      updatedAt: createdAt,
      config: migratedConfig,
      state: migratedState,
    },
    { idFallback: id, nameFallback: 'Analisis 1' }
  );
  const store = {
    version: ANALYSES_STORE_VERSION,
    activeId: entry.id,
    analyses: {
      [entry.id]: entry,
    },
  };
  await chrome.storage.local.set({
    [ANALYSES_KEY]: store,
    [CONFIG_KEY]: entry.config,
    [STORAGE_KEY]: entry.state,
  });
  return store;
}

async function listAnalyses() {
  const store = await getAnalysesStore();
  const analyses = Object.values(store.analyses || {})
    .map((entry) => buildAnalysisSummary(entry, store.activeId))
    .sort((a, b) => {
      const left = new Date(a.updatedAt || 0).getTime();
      const right = new Date(b.updatedAt || 0).getTime();
      return right - left;
    });
  return {
    activeId: store.activeId,
    analyses,
  };
}

async function syncActiveAnalysisSnapshot({ config = null, state = null } = {}) {
  if (!config && !state) return;
  const store = await getAnalysesStore();
  const activeId = String(store.activeId || '').trim();
  const activeEntry = store.analyses?.[activeId];
  if (!activeEntry) return;

  const nextEntry = {
    ...activeEntry,
    config: config ? normalizeConfigSnapshot(config) : activeEntry.config,
    state: state ? normalizeStateSnapshot(state) : activeEntry.state,
    updatedAt: nowIso(),
  };
  const nextStore = {
    ...store,
    analyses: {
      ...store.analyses,
      [activeId]: nextEntry,
    },
  };
  await chrome.storage.local.set({ [ANALYSES_KEY]: nextStore });
}

async function createAnalysis({
  name = '',
  productName = '',
  searchUrls = [],
  unitCost = null,
  startMonitoring = true,
} = {}) {
  const currentConfig = await getConfig();
  const currentState = await getState();
  const currentStore = await getAnalysesStore();
  const now = nowIso();

  const activeId = String(currentStore.activeId || '').trim();
  const activeEntry = currentStore.analyses?.[activeId] || null;
  const analysesSeed = { ...(currentStore.analyses || {}) };
  if (activeEntry) {
    analysesSeed[activeId] = {
      ...activeEntry,
      config: normalizeConfigSnapshot({
        ...currentConfig,
        monitorEnabled: false,
      }),
      state: normalizeStateSnapshot(currentState),
      updatedAt: now,
    };
  }

  const nextProductName = String(productName || '').trim();
  const nextSearchUrls = normalizeSearchUrls(searchUrls);
  if (!nextProductName) throw new Error('product_name_invalido');
  if (!nextSearchUrls.length) throw new Error('search_urls_invalidas');

  const analysisId = createAnalysisId();
  const nextConfig = normalizeConfigSnapshot({
    ...currentConfig,
    monitorEnabled: false,
    productName: nextProductName,
    unitCost: normalizeUnitCost(unitCost),
    searchUrls: nextSearchUrls,
    searchUrl: nextSearchUrls[0] || '',
    detectPeriodMinutes: DETECT_PERIOD_MIN,
    nextCyclePhase: PHASE_DETECT,
  });
  const nextEntry = normalizeAnalysisEntry(
    {
      id: analysisId,
      name: normalizeAnalysisName(name || nextProductName, `Analisis ${Object.keys(analysesSeed).length + 1}`),
      createdAt: now,
      updatedAt: now,
      config: nextConfig,
      state: defaultState(),
    },
    { idFallback: analysisId, nameFallback: `Analisis ${Object.keys(analysesSeed).length + 1}` }
  );

  const nextStore = normalizeAnalysesStore({
    version: ANALYSES_STORE_VERSION,
    activeId: analysisId,
    analyses: {
      ...analysesSeed,
      [analysisId]: nextEntry,
    },
  });

  monitorRunId += 1;
  await clearAlarms();
  await markMonitorStoppedRuntime('analysis_switch_create');
  await setAnalysesStore(nextStore, { syncActive: true });

  let start = { ok: true, skipped: true };
  if (startMonitoring !== false) {
    start = await startMonitoringSession({
      productName: nextProductName,
      searchUrls: nextSearchUrls,
      runStartupCycles: false,
    });
  }
  const listing = await listAnalyses();
  return {
    ok: true,
    activeId: analysisId,
    analysis: buildAnalysisSummary(nextEntry, analysisId),
    analyses: listing.analyses,
    start,
  };
}

async function activateAnalysis({ analysisId = '', startMonitoring = true } = {}) {
  const targetId = String(analysisId || '').trim();
  if (!targetId) throw new Error('analysis_id_missing');

  const currentConfig = await getConfig();
  const currentState = await getState();
  const currentStore = await getAnalysesStore();
  const now = nowIso();
  const targetEntryRaw = currentStore.analyses?.[targetId];
  if (!targetEntryRaw) throw new Error('analysis_not_found');

  const activeId = String(currentStore.activeId || '').trim();
  const activeEntry = currentStore.analyses?.[activeId] || null;
  const analysesSeed = { ...(currentStore.analyses || {}) };
  if (activeEntry) {
    analysesSeed[activeId] = {
      ...activeEntry,
      config: normalizeConfigSnapshot({
        ...currentConfig,
        monitorEnabled: false,
      }),
      state: normalizeStateSnapshot(currentState),
      updatedAt: now,
    };
  }

  const targetEntry = normalizeAnalysisEntry(targetEntryRaw, {
    idFallback: targetId,
    nameFallback: 'Analisis',
  });
  analysesSeed[targetId] = {
    ...targetEntry,
    updatedAt: now,
  };

  const nextStore = normalizeAnalysesStore({
    version: ANALYSES_STORE_VERSION,
    activeId: targetId,
    analyses: analysesSeed,
  });

  monitorRunId += 1;
  await clearAlarms();
  await markMonitorStoppedRuntime('analysis_switch');
  await setAnalysesStore(nextStore, { syncActive: true });

  let start = { ok: true, skipped: true };
  if (startMonitoring !== false) {
    const targetConfig = nextStore.analyses?.[targetId]?.config || {};
    const nextProductName = String(targetConfig.productName || '').trim();
    const nextSearchUrls = normalizeSearchUrls(targetConfig.searchUrls || targetConfig.searchUrl || []);
    if (!nextProductName) throw new Error('analysis_product_missing');
    if (!nextSearchUrls.length) throw new Error('analysis_search_urls_missing');
    start = await startMonitoringSession({
      productName: nextProductName,
      searchUrls: nextSearchUrls,
      runStartupCycles: false,
    });
  }
  const listing = await listAnalyses();
  return {
    ok: true,
    activeId: targetId,
    analysis: buildAnalysisSummary(nextStore.analyses?.[targetId], targetId),
    analyses: listing.analyses,
    start,
  };
}

async function updateAnalysis({ analysisId = '', name = '' } = {}) {
  const targetId = String(analysisId || '').trim();
  if (!targetId) throw new Error('analysis_id_missing');
  const store = await getAnalysesStore();
  const targetEntry = store.analyses?.[targetId];
  if (!targetEntry) throw new Error('analysis_not_found');

  const normalizedTarget = normalizeAnalysisEntry(targetEntry, {
    idFallback: targetId,
    nameFallback: 'Analisis',
  });
  const currentName = String(normalizedTarget.name || '').trim() || 'Analisis';
  const proposedName = normalizeAnalysisName(name, currentName);
  if (!proposedName) throw new Error('analysis_name_invalid');

  const nextStore = normalizeAnalysesStore({
    ...store,
    analyses: {
      ...store.analyses,
      [targetId]: {
        ...normalizedTarget,
        name: proposedName,
        updatedAt: nowIso(),
      },
    },
  });
  await setAnalysesStore(nextStore, { syncActive: false });
  const listing = await listAnalyses();
  return {
    ok: true,
    activeId: listing.activeId,
    analysis: listing.analyses.find((entry) => String(entry?.id || '') === targetId) || null,
    analyses: listing.analyses,
  };
}

async function updateAnalysisConfig({ analysisId = '', configPatch = {} } = {}) {
  const targetId = String(analysisId || '').trim();
  if (!targetId) throw new Error('analysis_id_missing');
  const store = await getAnalysesStore();
  const targetEntry = store.analyses?.[targetId];
  if (!targetEntry) throw new Error('analysis_not_found');

  const normalizedTarget = normalizeAnalysisEntry(targetEntry, {
    idFallback: targetId,
    nameFallback: 'Analisis',
  });
  const patch = configPatch && typeof configPatch === 'object' ? configPatch : {};
  const hasProductPatch = Object.prototype.hasOwnProperty.call(patch, 'productName');
  const hasSearchPatch =
    Object.prototype.hasOwnProperty.call(patch, 'searchUrls') ||
    Object.prototype.hasOwnProperty.call(patch, 'searchUrl');
  const hasUnitCostPatch = Object.prototype.hasOwnProperty.call(patch, 'unitCost');

  const nextProductName = hasProductPatch
    ? String(patch?.productName || '').trim()
    : String(normalizedTarget?.config?.productName || '').trim();
  const nextSearchUrls = hasSearchPatch
    ? normalizeSearchUrls(patch?.searchUrls || patch?.searchUrl || [])
    : normalizeSearchUrls(normalizedTarget?.config?.searchUrls || normalizedTarget?.config?.searchUrl || []);
  const nextUnitCost = hasUnitCostPatch
    ? normalizeUnitCost(patch?.unitCost)
    : normalizeUnitCost(normalizedTarget?.config?.unitCost);

  const nextConfig = normalizeConfigSnapshot({
    ...normalizedTarget.config,
    ...(hasProductPatch ? { productName: nextProductName } : {}),
    ...(hasSearchPatch
      ? {
          searchUrls: nextSearchUrls,
          searchUrl: nextSearchUrls[0] || '',
        }
      : {}),
    ...(hasUnitCostPatch ? { unitCost: nextUnitCost } : {}),
  });
  if (nextConfig.monitorEnabled && !nextConfig.productName) {
    throw new Error('product_name_invalido');
  }
  if (nextConfig.monitorEnabled && (!Array.isArray(nextConfig.searchUrls) || nextConfig.searchUrls.length === 0)) {
    throw new Error('search_urls_invalidas');
  }

  const nextStore = normalizeAnalysesStore({
    ...store,
    analyses: {
      ...store.analyses,
      [targetId]: {
        ...normalizedTarget,
        config: nextConfig,
        updatedAt: nowIso(),
      },
    },
  });
  await setAnalysesStore(nextStore, { syncActive: true });
  const listing = await listAnalyses();
  return {
    ok: true,
    activeId: listing.activeId,
    analysis: listing.analyses.find((entry) => String(entry?.id || '') === targetId) || null,
    analyses: listing.analyses,
  };
}

async function deleteAnalysis({ analysisId = '' } = {}) {
  const targetId = String(analysisId || '').trim();
  if (!targetId) throw new Error('analysis_id_missing');
  const currentConfig = await getConfig();
  const currentState = await getState();
  const store = await getAnalysesStore();
  if (!store.analyses?.[targetId]) throw new Error('analysis_not_found');

  const now = nowIso();
  const activeId = String(store.activeId || '').trim();
  const analysesSeed = { ...(store.analyses || {}) };
  if (activeId && activeId !== targetId && analysesSeed[activeId]) {
    analysesSeed[activeId] = {
      ...normalizeAnalysisEntry(analysesSeed[activeId], {
        idFallback: activeId,
        nameFallback: 'Analisis',
      }),
      config: normalizeConfigSnapshot(currentConfig),
      state: normalizeStateSnapshot(currentState),
      updatedAt: now,
    };
  }

  delete analysesSeed[targetId];

  if (Object.keys(analysesSeed).length === 0) {
    const fallbackId = createAnalysisId();
    analysesSeed[fallbackId] = normalizeAnalysisEntry(
      {
        id: fallbackId,
        name: 'Analisis 1',
        createdAt: now,
        updatedAt: now,
        config: normalizeConfigSnapshot({
          ...currentConfig,
          monitorEnabled: false,
          productName: '',
          searchUrls: [],
          searchUrl: '',
          detectPeriodMinutes: DETECT_PERIOD_MIN,
          nextCyclePhase: PHASE_DETECT,
        }),
        state: defaultState(),
      },
      { idFallback: fallbackId, nameFallback: 'Analisis 1' }
    );
  }

  const nextActiveId =
    activeId === targetId
      ? Object.keys(analysesSeed)[0]
      : analysesSeed[activeId]
        ? activeId
        : Object.keys(analysesSeed)[0];

  const nextStore = normalizeAnalysesStore({
    version: ANALYSES_STORE_VERSION,
    activeId: nextActiveId,
    analyses: analysesSeed,
  });

  if (activeId === targetId) {
    monitorRunId += 1;
    await clearAlarms();
    await markMonitorStoppedRuntime('analysis_delete');
  }
  await setAnalysesStore(nextStore, { syncActive: true });
  const listing = await listAnalyses();
  return {
    ok: true,
    activeId: listing.activeId,
    analyses: listing.analyses,
  };
}

async function getAnalysisSnapshot({ analysisId = '' } = {}) {
  const targetId = String(analysisId || '').trim();
  if (!targetId) throw new Error('analysis_id_missing');
  const store = await getAnalysesStore();
  const targetEntryRaw = store.analyses?.[targetId];
  if (!targetEntryRaw) throw new Error('analysis_not_found');
  const targetEntry = normalizeAnalysisEntry(targetEntryRaw, {
    idFallback: targetId,
    nameFallback: 'Analisis',
  });
  return {
    ok: true,
    analysis: buildAnalysisSummary(targetEntry, store.activeId),
    config: targetEntry.config,
    state: targetEntry.state,
  };
}

async function getConfig() {
  const raw = await chrome.storage.local.get(CONFIG_KEY);
  const loaded = raw?.[CONFIG_KEY] || {};
  const config = normalizeConfigSnapshot(loaded);
  if (JSON.stringify(loaded) !== JSON.stringify(config)) {
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
  }
  return config;
}

async function setConfig(configPatch) {
  const current = await getConfig();
  const hasSearchPatch =
    Object.prototype.hasOwnProperty.call(configPatch || {}, 'searchUrls') ||
    Object.prototype.hasOwnProperty.call(configPatch || {}, 'searchUrl');
  const incomingSearchUrls = normalizeSearchUrls(
    configPatch?.searchUrls || configPatch?.searchUrl || []
  );
  const nextSearchUrls = hasSearchPatch ? incomingSearchUrls : current.searchUrls;
  const hasUnitCostPatch = Object.prototype.hasOwnProperty.call(configPatch || {}, 'unitCost');
  const nextUnitCost = hasUnitCostPatch
    ? normalizeUnitCost(configPatch?.unitCost)
    : normalizeUnitCost(current?.unitCost);
  const nextRaw = {
    ...current,
    ...configPatch,
    productName:
      typeof configPatch?.productName === 'string'
        ? configPatch.productName.trim()
        : current.productName,
    unitCost: nextUnitCost,
    searchUrls: nextSearchUrls,
  };
  const next = normalizeConfigSnapshot(nextRaw);
  if (next.monitorEnabled && (!Array.isArray(next.searchUrls) || next.searchUrls.length === 0)) {
    throw new Error('search_urls_invalidas');
  }
  if (next.monitorEnabled && !next.productName) {
    throw new Error('product_name_invalido');
  }
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  await syncActiveAnalysisSnapshot({ config: next });
  return next;
}

async function getState() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const loaded = raw?.[STORAGE_KEY] || {};
  const state = normalizeStateSnapshot(loaded);
  if (JSON.stringify(loaded) !== JSON.stringify(state)) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }
  return state;
}

async function setState(state) {
  const normalized = normalizeStateSnapshot(state);
  await chrome.storage.local.set({ [STORAGE_KEY]: normalized });
  await syncActiveAnalysisSnapshot({ state: normalized });
}

async function getRuntimeState() {
  const raw = await chrome.storage.local.get(RUNTIME_KEY);
  const base = defaultRuntimeState();
  const loaded = raw[RUNTIME_KEY] || {};
  return {
    ...base,
    ...loaded,
  };
}

async function setRuntimeState(patch) {
  const current = await getRuntimeState();
  const next = {
    ...current,
    ...(patch || {}),
  };
  await chrome.storage.local.set({ [RUNTIME_KEY]: next });
  return next;
}

async function markMonitorStartedRuntime() {
  const now = nowIso();
  await setRuntimeState({
    monitorRunning: true,
    lastStartAt: now,
    lastHeartbeatAt: now,
    lastStopReason: null,
  });
}

async function markMonitorHeartbeatRuntime() {
  await setRuntimeState({
    monitorRunning: true,
    lastHeartbeatAt: nowIso(),
  });
}

async function markMonitorStoppedRuntime(reason = 'detenido') {
  await setRuntimeState({
    monitorRunning: false,
    lastCleanStopAt: nowIso(),
    lastStopReason: String(reason || 'detenido'),
  });
}

async function handleMonitorStartupRecovery(configInput = null) {
  const config = configInput || await getConfig();
  const runtime = await getRuntimeState();

  if (!config.monitorEnabled) {
    if (runtime.monitorRunning) {
      await markMonitorStoppedRuntime('monitor_disabled');
    }
    return;
  }

  await markMonitorHeartbeatRuntime();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const limit = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) break;

      try {
        const value = await worker(items[idx], idx);
        results[idx] = { ok: true, value };
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  }

  const workers = Array.from({ length: limit }, () => runner());
  await Promise.all(workers);
  return results;
}


function normalizeItemFromCatalog(raw) {
  const itemId = String(raw.itemId || '').trim();
  if (!/^\d+$/.test(itemId)) return null;
  const catalogBlob = `${raw.title || ''} ${raw.catalogText || ''} ${raw.url || ''}`.trim();
  const sourceSearchUrl =
    typeof raw.sourceSearchUrl === 'string' && raw.sourceSearchUrl.startsWith('https://www.vinted.es/')
      ? raw.sourceSearchUrl
      : null;
  const sourceSearchUrls = sourceSearchUrl ? [sourceSearchUrl] : [];

  return {
    itemId,
    url: raw.url,
    sourceSearchUrl,
    sourceSearchUrls,
    title: raw.title || `Item ${itemId}`,
    description: null,
    modelName: inferModelName(catalogBlob),
    keywordTags: extractKeywordHitsFromText(catalogBlob),
    firstSeenRank: Number.isFinite(raw.rank) ? raw.rank : null,
    detectedAt: nowIso(),
    publishedAt: null,
    publishedAtText: null,
    lastSeenAt: nowIso(),
    status: 'active',
    soldAt: null,
    timeToSellMinutes: null,
    soldPriceText: null,
    soldPriceValue: null,
    sellerName: null,
    sellerProfileUrl: null,
    sellerAccountStatus: 'unknown',
    sellerAccountReason: null,
    sellerLastCheckedAt: null,
    latest: {
      checkedAt: null,
      status: 'active',
      priceText: raw.priceText || null,
      priceValue: parsePriceValue(raw.priceText || null),
      likesCount: null,
      viewsCount: null,
      offersCount: null,
      uploadedText: null,
      publishedAt: null,
      isPopular: null,
      description: null,
    },
    snapshots: [],
  };
}

function mergeDetectedItems(state, detectedItems) {
  const map = new Map(state.items.map((item) => [item.itemId, item]));
  let newCount = 0;
  if (!state.metrics.keywordHits || typeof state.metrics.keywordHits !== 'object') {
    state.metrics.keywordHits = {};
  }

  for (const raw of detectedItems) {
    const normalized = normalizeItemFromCatalog(raw);
    if (!normalized) continue;

    const existing = map.get(normalized.itemId);
    if (!existing) {
      map.set(normalized.itemId, normalized);
      state.metrics.totalDetected += 1;
      const keywords = Array.isArray(normalized.keywordTags) ? normalized.keywordTags : [];
      for (const kw of keywords) {
        const current = Number(state.metrics.keywordHits[kw] || 0);
        state.metrics.keywordHits[kw] = current + 1;
      }
      newCount += 1;
      continue;
    }
    if (!Array.isArray(existing.sourceSearchUrls)) {
      existing.sourceSearchUrls = [];
    }
    const incomingSource = normalized.sourceSearchUrl;
    if (incomingSource && !existing.sourceSearchUrls.includes(incomingSource)) {
      existing.sourceSearchUrls.push(incomingSource);
    }
    if (!existing.sourceSearchUrl && existing.sourceSearchUrls.length > 0) {
      existing.sourceSearchUrl = existing.sourceSearchUrls[0];
    }
  }

  state.items = Array.from(map.values()).sort(
    (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  );

  return newCount;
}

function shouldExpireItem(item, nowMs) {
  if (item.status === 'sold') return false;
  const detectedMs = new Date(item.detectedAt).getTime();
  if (!Number.isFinite(detectedMs)) return false;
  return nowMs - detectedMs > EXPIRY_HOURS * 60 * 60 * 1000;
}

function shouldCheckSellerAccount(item, nowMs) {
  if (!item || item.status !== 'sold') return false;
  if (!item.sellerProfileUrl) return false;
  const lastMs = new Date(item.sellerLastCheckedAt || 0).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= SELLER_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
}

function applyMetricsToItem(state, item, metrics) {
  const checkedAt = nowIso();
  if (!state.metrics.keywordHits || typeof state.metrics.keywordHits !== 'object') {
    state.metrics.keywordHits = {};
  }
  const uploadedText = metrics.uploadedText ?? item.latest?.uploadedText ?? item.publishedAtText ?? null;
  const estimatedPublishedAt = estimatePublishedAtIso(uploadedText, checkedAt);

  item.latest = {
    checkedAt,
    status: metrics.status || item.latest?.status || 'active',
    priceText: metrics.priceText ?? item.latest?.priceText ?? null,
    priceValue: parsePriceValue(metrics.priceText ?? item.latest?.priceText ?? null),
    likesCount: metrics.likesCount ?? null,
    viewsCount: metrics.viewsCount ?? null,
    offersCount: metrics.offersCount ?? null,
    uploadedText,
    publishedAt: item.latest?.publishedAt ?? item.publishedAt ?? null,
    isPopular: typeof metrics.isPopular === 'boolean' ? metrics.isPopular : item.latest?.isPopular ?? null,
    description: metrics.description ?? item.latest?.description ?? null,
  };
  if (uploadedText) {
    item.publishedAtText = String(uploadedText).trim();
  }
  if (estimatedPublishedAt) {
    const currentTs = new Date(item.publishedAt || 0).getTime();
    const nextTs = new Date(estimatedPublishedAt).getTime();
    if (!Number.isFinite(currentTs)) {
      item.publishedAt = estimatedPublishedAt;
    } else if (Math.abs(nextTs - currentTs) > 6 * 60 * 60 * 1000) {
      item.publishedAt = estimatedPublishedAt;
    }
  }
  item.latest.publishedAt = item.publishedAt || item.latest.publishedAt || null;

  if (metrics.title && metrics.title.trim()) {
    item.title = metrics.title.trim();
  }
  if (metrics.description && metrics.description.trim()) {
    item.description = metrics.description.trim();
  }
  if (metrics.sellerName && String(metrics.sellerName).trim()) {
    item.sellerName = String(metrics.sellerName).trim();
  }
  if (metrics.sellerProfileUrl && String(metrics.sellerProfileUrl).trim()) {
    item.sellerProfileUrl = String(metrics.sellerProfileUrl).trim();
  }
  if (metrics.sellerAccountStatus && ['active', 'blocked', 'unknown'].includes(metrics.sellerAccountStatus)) {
    item.sellerAccountStatus = metrics.sellerAccountStatus;
  }
  if (metrics.sellerAccountReason && String(metrics.sellerAccountReason).trim()) {
    item.sellerAccountReason = String(metrics.sellerAccountReason).trim();
  }
  if (metrics.sellerLastCheckedAt) {
    item.sellerLastCheckedAt = metrics.sellerLastCheckedAt;
  }

  const oldTags = new Set(Array.isArray(item.keywordTags) ? item.keywordTags : []);
  const modelText = `${item.title || ''} ${item.description || ''} ${metrics.modelHint || ''} ${item.url || ''}`;
  item.modelName = inferModelName(modelText);
  const nextTags = extractKeywordHitsFromText(modelText);
  item.keywordTags = nextTags;
  for (const kw of nextTags) {
    if (!oldTags.has(kw)) {
      const current = Number(state.metrics.keywordHits[kw] || 0);
      state.metrics.keywordHits[kw] = current + 1;
    }
  }

  if (metrics.status === 'sold' && item.status !== 'sold') {
    item.status = 'sold';
    item.soldAt = checkedAt;
    item.soldPriceText = item.latest.priceText ?? null;
    item.soldPriceValue = item.latest.priceValue ?? null;
    const detectedMs = new Date(item.detectedAt).getTime();
    const soldMs = new Date(item.soldAt).getTime();
    if (Number.isFinite(detectedMs) && Number.isFinite(soldMs) && soldMs >= detectedMs) {
      item.timeToSellMinutes = Math.round(((soldMs - detectedMs) / 60000) * 100) / 100;
    }
    state.metrics.totalSold += 1;
  } else if (item.status !== 'sold') {
    item.status = metrics.status === 'reserved' ? 'reserved' : 'active';
  }

  item.snapshots = Array.isArray(item.snapshots) ? item.snapshots : [];
  item.snapshots.push({
    checkedAt,
    status: item.status,
    priceText: item.latest.priceText,
    priceValue: item.latest.priceValue,
    likesCount: item.latest.likesCount,
    viewsCount: item.latest.viewsCount,
    offersCount: item.latest.offersCount,
    uploadedText: item.latest.uploadedText,
    publishedAt: item.latest.publishedAt || null,
    isPopular: item.latest.isPopular,
    description: item.latest.description,
  });
  if (item.snapshots.length > MAX_SNAPSHOTS) {
    item.snapshots = item.snapshots.slice(-MAX_SNAPSHOTS);
  }
}

function parseVintedItemApiToMetrics(item) {
  if (!item) return null;
  let status = 'active';
  if (item.is_sold === true || item.status === 'sold') status = 'sold';
  else if (item.is_reserved === true || item.status === 'reserved') status = 'reserved';
  const priceRaw = item.price_numeric ?? null;
  const priceText = priceRaw != null
    ? `${Number(priceRaw).toFixed(2)}€`
    : (item.price ? `${item.price}€` : null);
  let uploadedText = null;
  const createdTs = item.created_at_ts ?? null;
  if (createdTs) {
    const ageMin = Math.round((Date.now() - Number(createdTs) * 1000) / 60000);
    if (ageMin < 60) uploadedText = `Subido hace ${ageMin} minutos`;
    else if (ageMin < 1440) uploadedText = `Subido hace ${Math.round(ageMin / 60)} horas`;
    else uploadedText = `Subido hace ${Math.round(ageMin / 1440)} dias`;
  }
  const sellerUser = item.user || item.seller || null;
  const favCount = item.favourite_count ?? item.favourites_count ?? null;
  return {
    status,
    priceText,
    title: item.title || null,
    description: item.description || null,
    likesCount: favCount != null ? Number(favCount) : null,
    viewsCount: item.view_count != null ? Number(item.view_count) : null,
    offersCount: item.offer_count != null ? Number(item.offer_count) : null,
    uploadedText,
    isPopular: favCount != null ? favCount > 5 : null,
    sellerName: sellerUser?.login || null,
    sellerProfileUrl: sellerUser?.profile_url || null,
  };
}

async function fetchVintedCatalogItems(searchUrl) {
  const pageUrl = new URL(searchUrl);
  const apiUrl = new URL('https://www.vinted.es/api/v2/catalog/items');
  const allowedKeys = new Set(['search_text', 'order', 'page', 'per_page', 'price_from', 'price_to', 'currency', 'search_id']);
  for (const [key, val] of pageUrl.searchParams.entries()) {
    if (allowedKeys.has(key) || key.endsWith('[]')) {
      apiUrl.searchParams.append(key, val);
    }
  }
  apiUrl.searchParams.set('per_page', '96');
  await jitter(API_JITTER_MIN_MS, API_JITTER_MAX_MS);
  const res = await vintedFetch(apiUrl.toString());
  if (!res.ok) throw new Error(`catalog_api_${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item, idx) => ({
    itemId: String(item.id),
    url: item.url || `https://www.vinted.es/items/${item.id}`,
    title: item.title || `Item ${item.id}`,
    priceText: item.price ? `${item.price}€` : null,
    priceValue: item.price != null ? Number(item.price) : null,
    rank: idx + 1,
    catalogText: `${item.title || ''} ${item.url || ''}`,
  }));
}

async function inspectItemUrl(url) {
  const idMatch = String(url || '').match(/\/items\/(\d+)/);
  if (!idMatch) return null;
  const itemId = idMatch[1];
  const res = await vintedFetch(`https://www.vinted.es/api/v2/items/${itemId}`);
  if (!res.ok) throw new Error(`item_api_${res.status}`);
  const data = await res.json();
  return parseVintedItemApiToMetrics(data.item || data) || null;
}

async function inspectSellerProfileUrl(url) {
  const idMatch = String(url || '').match(/\/(?:member|users?)\/(\d+)/);
  if (!idMatch) return { accountStatus: 'unknown', reason: 'no_id', checkedAt: nowIso() };
  const userId = idMatch[1];
  const res = await vintedFetch(`https://www.vinted.es/api/v2/users/${userId}`);
  if (res.status === 404) return { accountStatus: 'blocked', reason: 'not_found', checkedAt: nowIso() };
  if (!res.ok) return { accountStatus: 'unknown', reason: `api_${res.status}`, checkedAt: nowIso() };
  const data = await res.json();
  const user = data.user || data.member || null;
  return {
    accountStatus: user ? 'active' : 'unknown',
    reason: user ? 'perfil visible' : 'sin datos',
    displayName: user?.login || null,
    checkedAt: nowIso(),
  };
}

async function refreshVintedSessionInfo({ force = false } = {}) {
  if (vintedSessionRefreshPromise) return vintedSessionRefreshPromise;

  vintedSessionRefreshPromise = (async () => {
    const config = await getConfig();
    let loggedIn = null;
    try {
      const res = await vintedFetch('https://www.vinted.es/api/v2/users/current_user');
      if (res.status === 401 || res.status === 403) {
        loggedIn = false;
      } else if (res.ok) {
        loggedIn = true;
      }
    } catch (_) {
      // no-op: session check failed
    }
    return { ok: true, config, loggedIn };
  })();

  try {
    return await vintedSessionRefreshPromise;
  } finally {
    vintedSessionRefreshPromise = null;
  }
}

async function runDetectCycle(trigger = 'scheduler') {
  if (trackRunning) return { ok: true, skipped: true, reason: 'track_running' };
  if (detectRunning) return { ok: true, skipped: true };
  detectRunning = true;
  const localRunId = monitorRunId;

  const state = await getState();
  let config = await getConfig();
  try {
    if (!config.monitorEnabled) {
      return { ok: true, disabled: true, message: 'monitor detenido' };
    }
    try {
      await markMonitorHeartbeatRuntime();
    } catch (_) {
      // no-op
    }
    const searchUrls = normalizeSearchUrls(config.searchUrls);
    if (searchUrls.length === 0) {
      throw new Error('No hay links de busqueda configurados');
    }

    // ── Expandir cada URL a múltiples páginas para mayor cobertura ──────────
    const scanPages = Math.max(1, Math.min(5, config.scanPages || 2));
    const expandedJobs = [];
    for (const searchUrl of searchUrls) {
      for (let page = 1; page <= scanPages; page++) {
        try {
          const u = new URL(searchUrl);
          u.searchParams.set('page', String(page));
          expandedJobs.push({ pageUrl: u.toString(), sourceUrl: searchUrl, page });
        } catch (_) {
          if (page === 1) expandedJobs.push({ pageUrl: searchUrl, sourceUrl: searchUrl, page });
        }
      }
    }

    let detectedTotal = 0;
    let newCountTotal = 0;
    let scannedOk = 0;
    let filteredOutTotal = 0;
    const detectedBatches = [];
    const urlErrors = [];

    const detectResults = await mapWithConcurrency(
      expandedJobs,
      DETECT_PARALLEL_TABS,
      async (job) => {
        if (isRunCancelled(localRunId)) {
          throw new Error('aborted');
        }
        const detected = await fetchVintedCatalogItems(job.pageUrl);
        return { job, detected: detected || [] };
      }
    );

    for (let i = 0; i < detectResults.length; i += 1) {
      const result = detectResults[i];
      const job    = expandedJobs[i];
      if (!result?.ok) {
        // Solo contar como error la página 1; páginas 2+ fallan silenciosamente
        if (job.page === 1) urlErrors.push({ searchUrl: job.sourceUrl, error: result?.error?.message || 'error' });
        continue;
      }
      scannedOk += 1;
      const detected = Array.isArray(result?.value?.detected) ? result.value.detected : [];
      const filteredResult = filterDetectedBySearchUrl(job.sourceUrl, detected);
      filteredOutTotal += filteredResult.dropped;
      let detectedWithSource = filteredResult.items.map((entry) => ({
        ...entry,
        sourceSearchUrl: job.sourceUrl,
      }));

      // ── Filtro de precio ───────────────────────────────────────────────────
      const priceMin = config.priceMin;
      const priceMax = config.priceMax;
      if (priceMin != null || priceMax != null) {
        const before = detectedWithSource.length;
        detectedWithSource = detectedWithSource.filter(entry => {
          const price = entry.priceValue;
          if (price == null) return true;           // precio desconocido → no filtrar
          if (priceMin != null && price < priceMin) return false;
          if (priceMax != null && price > priceMax) return false;
          return true;
        });
        filteredOutTotal += before - detectedWithSource.length;
      }

      detectedTotal += detectedWithSource.length;
      detectedBatches.push(detectedWithSource);
    }

    if (isRunCancelled(localRunId)) {
      return { ok: true, aborted: true, message: 'detenido durante deteccion' };
    }
    for (const detected of detectedBatches) {
      newCountTotal += mergeDetectedItems(state, detected);
    }

    state.metrics.lastDetectRun = nowIso();
    state.metrics.lastDetectSummary = {
      urlsTotal: searchUrls.length,
      urlsOk: scannedOk,
      urlsError: urlErrors.length,
      detected: detectedTotal,
      filteredOut: filteredOutTotal,
      newCount: newCountTotal,
    };
    state.metrics.lastError =
      urlErrors.length > 0
        ? `detect_partial: ${urlErrors.length} link(s) con error`
        : null;
    await setState(state);

    if (scannedOk === 0 && urlErrors.length > 0) {
      return {
        ok: false,
        error: `No se pudo abrir ningun link (${urlErrors.length} errores)`,
        urlErrors,
      };
    }

    return {
      ok: true,
      detected: detectedTotal,
      filteredOut: filteredOutTotal,
      newCount: newCountTotal,
      updated: newCountTotal > 0,
      urlsOk: scannedOk,
      urlsError: urlErrors.length,
      urlErrors,
    };
  } catch (err) {
    state.metrics.lastDetectRun = nowIso();
    state.metrics.lastDetectSummary = {
      urlsTotal: Array.isArray(config.searchUrls) ? config.searchUrls.length : 0,
      urlsOk: 0,
      urlsError: 1,
      detected: 0,
      filteredOut: 0,
      newCount: 0,
    };
    state.metrics.lastError = `detect: ${err.message}`;
    await setState(state);
    return { ok: false, error: err.message };
  } finally {
    detectRunning = false;
  }
}

async function runTrackCycle(trigger = 'scheduler') {
  if (detectRunning) return { ok: true, skipped: true, reason: 'detect_running' };
  if (trackRunning) return { ok: true, skipped: true };
  trackRunning = true;
  const localRunId = monitorRunId;

  const state = await getState();
  let config = await getConfig();
  const nowMs = Date.now();
  let attempted = 0;
  let checked = 0;
  let errors = 0;
  let expired = 0;
  let soldThisRun = 0;
  let sellerChecked = 0;
  let sellerErrors = 0;

  try {
    if (!config.monitorEnabled) {
      return { ok: true, disabled: true, message: 'monitor detenido' };
    }
    try {
      await markMonitorHeartbeatRuntime();
    } catch (_) {
      // no-op
    }
    const kept = [];
    let aborted = false;

    for (const item of state.items) {
      if (isRunCancelled(localRunId)) {
        aborted = true;
        break;
      }
      if (shouldExpireItem(item, nowMs)) {
        expired += 1;
        continue; // delete unsold >24h
      }

      if (item.status === 'sold') {
        if (
          sellerChecked < SELLER_CHECK_MAX_PER_TRACK &&
          shouldCheckSellerAccount(item, nowMs)
        ) {
          try {
            const sellerMetrics = await inspectSellerProfileUrl(item.sellerProfileUrl);
            item.sellerAccountStatus =
              sellerMetrics?.accountStatus && ['active', 'blocked', 'unknown'].includes(sellerMetrics.accountStatus)
                ? sellerMetrics.accountStatus
                : 'unknown';
            item.sellerAccountReason = sellerMetrics?.reason || null;
            item.sellerLastCheckedAt = sellerMetrics?.checkedAt || nowIso();
            if (sellerMetrics?.displayName && !item.sellerName) {
              item.sellerName = String(sellerMetrics.displayName);
            }
            sellerChecked += 1;
          } catch (_) {
            item.sellerLastCheckedAt = nowIso();
            if (!item.sellerAccountStatus) {
              item.sellerAccountStatus = 'unknown';
            }
            sellerErrors += 1;
          }
        }
        kept.push(item);
        continue;
      }

      // ── Sistema de prioridades de re-análisis ────────────────────────────
      // P0 — siempre analizar (nunca saltar):
      //   • nunca comprobado (sin checkedAt)
      //   • item nuevo: detectado hace <10 min
      //   • estado 'reserved' (puede venderse en minutos)
      // P1 — reintentar cada RECHECK_P1_MIN (5 min):
      //   • item <2h de vida
      //   • tiene ≥ LIKES_THRESHOLD_P1 likes
      // P2 — reintentar cada RECHECK_P2_MIN (20 min):
      //   • item entre 2h y 8h
      // P3 — reintentar cada RECHECK_P3_MIN (60 min):
      //   • item >8h sin engagement relevante
      const lastCheckedMs  = new Date(item.latest?.checkedAt || 0).getTime();
      const detectedMs     = new Date(item.detectedAt || 0).getTime();
      const msSinceCheck   = nowMs - lastCheckedMs;
      const itemAgeMs      = nowMs - detectedMs;
      const currentLikes   = item.latest?.likesCount ?? 0;
      const neverChecked   = lastCheckedMs === 0;
      const isNew          = itemAgeMs < 10 * 60 * 1000;
      const isReserved     = item.status === 'reserved';

      // P0 — nunca saltar
      if (neverChecked || isNew || isReserved) {
        // caer al análisis sin skip
      } else {
        // Determinar límite de re-chequeo según prioridad
        let recheckLimitMs;
        if (itemAgeMs < ITEM_AGE_P1_MS || currentLikes >= LIKES_THRESHOLD_P1) {
          recheckLimitMs = RECHECK_P1_MIN * 60 * 1000;       // P1: 5 min
        } else if (itemAgeMs < ITEM_AGE_P2_MS) {
          recheckLimitMs = RECHECK_P2_MIN * 60 * 1000;       // P2: 20 min
        } else {
          recheckLimitMs = RECHECK_P3_MIN * 60 * 1000;       // P3: 60 min
        }
        if (msSinceCheck < recheckLimitMs) {
          kept.push(item);
          continue; // todavía no toca
        }
      }

      attempted += 1;
      const prevStatus = item.status;
      try {
        if (isRunCancelled(localRunId)) {
          aborted = true;
          break;
        }
        const metrics = await inspectItemUrl(item.url);
        if (metrics) {
          applyMetricsToItem(state, item, metrics);
        }
        checked += 1;
      } catch (err) {
        errors += 1;
      }
      if (prevStatus !== 'sold' && item.status === 'sold') {
        soldThisRun += 1;
      }

      kept.push(item);
    }

    if (expired > 0) {
      state.metrics.totalExpired += expired;
    }

    if (aborted || isRunCancelled(localRunId)) {
      return {
        ok: true,
        aborted: true,
        attempted,
        checked,
        errors,
        expired,
        soldThisRun,
        sellerChecked,
        sellerErrors,
      };
    }

    state.items = kept.sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
    );
    state.metrics.lastTrackRun = nowIso();
    const exploitableResult = { sent: 0, errors: 0, changed: false };
    state.metrics.lastTrackSummary = {
      attempted,
      checked,
      errors,
      expired,
      soldThisRun,
      sellerChecked,
      sellerErrors,
    };
    state.metrics.lastError =
      errors > 0 || sellerErrors > 0
        ? `track_partial: ${errors} item(s) con error${sellerErrors > 0 ? ` | seller: ${sellerErrors}` : ''}`
        : null;

    await setState(state);
    return {
      ok: true,
      attempted,
      checked,
      errors,
      expired,
      soldThisRun,
      sellerChecked,
      sellerErrors,
    };
  } catch (err) {
    state.metrics.lastTrackRun = nowIso();
    state.metrics.lastTrackSummary = {
      attempted,
      checked,
      errors,
      expired,
      soldThisRun,
      sellerChecked,
      sellerErrors,
    };
    state.metrics.lastError = `track: ${err.message}`;
    await setState(state);
    return { ok: false, error: err.message };
  } finally {
    trackRunning = false;
  }
}

async function clearSoldItems() {
  const state = await getState();
  const before = state.items.length;
  state.items = state.items.filter((item) => item.status !== 'sold');
  await setState(state);
  return { ok: true, removed: before - state.items.length };
}

async function clearAlarms() {
  await chrome.alarms.clear(DETECT_ALARM);
  await chrome.alarms.clear(TRACK_ALARM);
  await chrome.alarms.clear(CYCLE_ALARM);
}

async function resetAllData() {
  const current = await getState();
  const removedItems = Array.isArray(current.items) ? current.items.length : 0;
  const next = defaultState();
  await setState(next);
  return { ok: true, removedItems };
}

async function ensureAlarms() {
  const config = await getConfig();
  if (!config.monitorEnabled) {
    await clearAlarms();
    return;
  }
  await chrome.alarms.clear(DETECT_ALARM);
  await chrome.alarms.clear(TRACK_ALARM);

  const existingCycle = await chrome.alarms.get(CYCLE_ALARM);
  const detectPeriod = Math.max(5, Number(config.detectPeriodMinutes) || 5);
  if (!existingCycle || existingCycle.periodInMinutes !== detectPeriod) {
    await chrome.alarms.create(CYCLE_ALARM, { periodInMinutes: detectPeriod });
  }
}

async function startMonitoringSession(params = {}) {
  const {
    productName,
    searchUrl,
    searchUrls,
    unitCost,
    runStartupCycles = false,
  } = params;
  const hasUnitCostPatch = Object.prototype.hasOwnProperty.call(params || {}, 'unitCost');
  monitorRunId += 1;
  const urls = normalizeSearchUrls(searchUrls || [searchUrl]);
  const nextProductName = String(productName || '').trim();
  if (!nextProductName) {
    throw new Error('product_name_invalido');
  }
  if (!urls.length) {
    throw new Error('search_urls_invalidas');
  }
  await setConfig({
    monitorEnabled: false,
    productName: nextProductName,
    ...(hasUnitCostPatch ? { unitCost: normalizeUnitCost(unitCost) } : {}),
    searchUrls: urls,
    detectPeriodMinutes: 5,
    nextCyclePhase: PHASE_DETECT,
  });
  const next = await setConfig({
    monitorEnabled: true,
    productName: nextProductName,
    ...(hasUnitCostPatch ? { unitCost: normalizeUnitCost(unitCost) } : {}),
    searchUrls: urls,
    detectPeriodMinutes: 5,
    nextCyclePhase: PHASE_DETECT,
  });
  const now = nowIso();
  const state = await getState();
  state.metrics = state.metrics && typeof state.metrics === 'object' ? state.metrics : {};
  if (!state.metrics.firstMonitorStartAt) {
    state.metrics.firstMonitorStartAt = now;
  }
  state.metrics.lastMonitorStartAt = now;
  await setState(state);
  await markMonitorStartedRuntime();
  await ensureAlarms();
  const startNotification = {
    sent: false,
    skipped: true,
    reason: 'event_log_only',
  };
  let detect = null;
  let track = null;
  let startupQueued = false;
  if (runStartupCycles === true) {
    detect = await runDetectCycle('startup');
    if (!detect?.skipped && !detect?.disabled && !detect?.aborted && detect?.ok !== false) {
      track = await runTrackCycle('startup_after_detect');
    }
  } else {
    startupQueued = true;
    const queuedRunId = monitorRunId;
    void (async () => {
      try {
        await delay(120);
        const currentConfig = await getConfig();
        if (!currentConfig.monitorEnabled || isRunCancelled(queuedRunId)) return;
        const detectResult = await runDetectCycle('startup_async');
        if (
          !detectResult?.skipped &&
          !detectResult?.disabled &&
          !detectResult?.aborted &&
          detectResult?.ok !== false
        ) {
          await runTrackCycle('startup_after_detect_async');
        }
        await setConfig({ nextCyclePhase: PHASE_DETECT });
      } catch (_) {
        // no-op: la ejecucion inicial no debe bloquear al cliente
      }
    })();
  }
  const configOut = await setConfig({ nextCyclePhase: PHASE_DETECT });
  return { ok: true, config: configOut, detect, track, startupQueued, startNotification };
}

async function stopMonitoringSession() {
  monitorRunId += 1;
  const next = await setConfig({ monitorEnabled: false });
  await clearAlarms();
  await markMonitorStoppedRuntime('manual_stop');
  return { ok: true, config: next };
}

async function openDashboardTab() {
  const dashboardUrl = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url: dashboardUrl });
  if (Array.isArray(tabs) && tabs.length > 0) {
    const tab = tabs[0];
    if (typeof tab.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: dashboardUrl });
}

async function openDashboardOnExtensionStart() {
  // Espera corta para evitar carreras al iniciar Chrome/Service Worker.
  await delay(900);
  try {
    await openDashboardTab();
  } catch (_) {
    // no-op
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await handleMonitorStartupRecovery(config);
  await ensureAlarms();
  void openDashboardOnExtensionStart();
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  await handleMonitorStartupRecovery(config);
  await ensureAlarms();
  void openDashboardOnExtensionStart();
});

async function runScheduledAlternatingCycle() {
  const config = await getConfig();
  if (!config.monitorEnabled) return;
  const detectResult = await runDetectCycle('scheduler');
  const configAfterDetect = await getConfig();
  if (!configAfterDetect.monitorEnabled) {
    await setConfig({ nextCyclePhase: PHASE_DETECT });
    return;
  }

  const detectCompleted =
    detectResult &&
    detectResult.ok !== false &&
    !detectResult.skipped &&
    !detectResult.disabled &&
    !detectResult.aborted;

  if (detectCompleted) {
    await runTrackCycle('scheduler_after_detect');
  }

  await setConfig({ nextCyclePhase: PHASE_DETECT });
}

async function getSchedulerStatus(configInput = null) {
  const config = configInput || await getConfig();
  const monitorEnabled = config.monitorEnabled === true;
  const nextPhase = normalizeCyclePhase(config.nextCyclePhase);
  const nowMs = Date.now();

  let nextScheduledAt = null;
  let nextInMs = null;
  if (monitorEnabled) {
    const cycleAlarm = await chrome.alarms.get(CYCLE_ALARM);
    if (cycleAlarm && Number.isFinite(cycleAlarm.scheduledTime)) {
      nextScheduledAt = cycleAlarm.scheduledTime;
      nextInMs = Math.max(0, cycleAlarm.scheduledTime - nowMs);
    }
  }

  const detectRunningNow = detectRunning === true;
  const trackRunningNow = trackRunning === true;
  const detectActiveNext = monitorEnabled && !detectRunningNow && !trackRunningNow && nextPhase === PHASE_DETECT;
  const trackActiveNext = monitorEnabled && !detectRunningNow && !trackRunningNow && nextPhase === PHASE_TRACK;

  return {
    monitorEnabled,
    nextPhase,
    nowMs,
    nextScheduledAt,
    nextInMs,
    detect: {
      running: detectRunningNow,
      active: detectActiveNext,
      paused: !detectRunningNow && !detectActiveNext,
      nextInMs,
    },
    track: {
      running: trackRunningNow,
      active: trackActiveNext,
      paused: !trackRunningNow && !trackActiveNext,
      nextInMs,
    },
  };
}

chrome.action.onClicked.addListener(async () => {
  await openDashboardTab();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const config = await getConfig();
  if (!config.monitorEnabled) return;
  if (
    alarm.name !== CYCLE_ALARM &&
    alarm.name !== DETECT_ALARM &&
    alarm.name !== TRACK_ALARM
  ) {
    return;
  }
  await runScheduledAlternatingCycle();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.action === 'rb:get-state') {
        const config = await getConfig();
        const analysesInfo = await listAnalyses();
        const scheduler = await getSchedulerStatus(config);
        sendResponse({
          success: true,
          state: await getState(),
          config,
          scheduler,
          analyses: analysesInfo.analyses,
          activeAnalysisId: analysesInfo.activeId,
        });
        return;
      }
      if (message?.action === 'rb:list-analyses') {
        const listing = await listAnalyses();
        sendResponse({
          success: true,
          analyses: listing.analyses,
          activeId: listing.activeId,
        });
        return;
      }
      if (message?.action === 'rb:create-analysis') {
        const result = await createAnalysis({
          name: String(message?.name || '').trim(),
          productName: String(message?.productName || '').trim(),
          searchUrls: Array.isArray(message?.searchUrls) ? message.searchUrls : [],
          unitCost: normalizeUnitCost(message?.unitCost),
          startMonitoring: message?.startMonitoring !== false,
        });
        sendResponse({
          success: true,
          result,
          analyses: result.analyses,
          activeId: result.activeId,
        });
        return;
      }
      if (message?.action === 'rb:activate-analysis') {
        const result = await activateAnalysis({
          analysisId: String(message?.analysisId || '').trim(),
          startMonitoring: message?.startMonitoring !== false,
        });
        sendResponse({
          success: true,
          result,
          analyses: result.analyses,
          activeId: result.activeId,
        });
        return;
      }
      if (message?.action === 'rb:update-analysis') {
        const result = await updateAnalysis({
          analysisId: String(message?.analysisId || '').trim(),
          name: String(message?.name || '').trim(),
        });
        sendResponse({
          success: true,
          result,
          analyses: result.analyses,
          activeId: result.activeId,
        });
        return;
      }
      if (message?.action === 'rb:update-analysis-config') {
        const result = await updateAnalysisConfig({
          analysisId: String(message?.analysisId || '').trim(),
          configPatch:
            message?.configPatch && typeof message.configPatch === 'object'
              ? message.configPatch
              : {},
        });
        sendResponse({
          success: true,
          result,
          analyses: result.analyses,
          activeId: result.activeId,
        });
        return;
      }
      if (message?.action === 'rb:delete-analysis') {
        const result = await deleteAnalysis({
          analysisId: String(message?.analysisId || '').trim(),
        });
        sendResponse({
          success: true,
          result,
          analyses: result.analyses,
          activeId: result.activeId,
        });
        return;
      }
      if (message?.action === 'rb:get-analysis-snapshot') {
        const result = await getAnalysisSnapshot({
          analysisId: String(message?.analysisId || '').trim(),
        });
        sendResponse({
          success: true,
          result,
        });
        return;
      }
      if (message?.action === 'rb:run-detect') {
        sendResponse({ success: true, result: await runDetectCycle('manual') });
        return;
      }
      if (message?.action === 'rb:run-track') {
        sendResponse({ success: true, result: await runTrackCycle('manual') });
        return;
      }
      if (message?.action === 'rb:start-monitoring') {
        const productName = String(message?.productName || '').trim();
        const searchUrl = String(message?.searchUrl || '').trim();
        const searchUrls = Array.isArray(message?.searchUrls) ? message.searchUrls : undefined;
        const hasUnitCostPatch = Object.prototype.hasOwnProperty.call(message || {}, 'unitCost');
        const runStartupCycles = message?.runStartupCycles === true;
        sendResponse({
          success: true,
          result: await startMonitoringSession({
            productName,
            searchUrl,
            searchUrls,
            ...(hasUnitCostPatch ? { unitCost: normalizeUnitCost(message?.unitCost) } : {}),
            runStartupCycles,
          }),
        });
        return;
      }
      if (message?.action === 'rb:stop-monitoring') {
        sendResponse({ success: true, result: await stopMonitoringSession() });
        return;
      }
      if (message?.action === 'rb:clear-sold') {
        sendResponse(await clearSoldItems());
        return;
      }
      if (message?.action === 'rb:reset-all') {
        sendResponse(await resetAllData());
        return;
      }
      if (message?.action === 'rb:set-search-url') {
        const searchUrl = String(message?.searchUrl || '').trim();
        const searchUrls = Array.isArray(message?.searchUrls) ? message.searchUrls : undefined;
        const next = await setConfig({
          searchUrl,
          searchUrls,
          detectPeriodMinutes: 5,
        });
        await ensureAlarms();
        sendResponse({ success: true, config: next });
        return;
      }
      if (message?.action === 'rb:set-search-urls') {
        const searchUrls = Array.isArray(message?.searchUrls) ? message.searchUrls : [];
        const patch = { searchUrls, detectPeriodMinutes: 5 };
        if (message?.scanPages != null) patch.scanPages = Math.max(1, Math.min(5, Number(message.scanPages)||2));
        if (message?.priceMin != null) patch.priceMin = Number(message.priceMin) > 0 ? Number(message.priceMin) : null;
        if (message?.priceMax != null) patch.priceMax = Number(message.priceMax) > 0 ? Number(message.priceMax) : null;
        const next = await setConfig(patch);
        await ensureAlarms();
        sendResponse({ success: true, config: next });
        return;
      }
      if (message?.action === 'rb:set-scan-config') {
        const patch = {};
        if (message?.scanPages != null) patch.scanPages = Math.max(1, Math.min(5, Number(message.scanPages)||2));
        if (Object.prototype.hasOwnProperty.call(message,'priceMin')) patch.priceMin = Number(message.priceMin)>0 ? Number(message.priceMin) : null;
        if (Object.prototype.hasOwnProperty.call(message,'priceMax')) patch.priceMax = Number(message.priceMax)>0 ? Number(message.priceMax) : null;
        const next = await setConfig(patch);
        sendResponse({ success: true, config: next });
        return;
      }
      sendResponse({ success: false, error: 'unknown_action' });
    } catch (err) {
      sendResponse({ success: false, error: err?.message || 'internal_error' });
    }
  })();

  return true;
});

// ===== Injected functions =====

function extractCatalogItemsFromPage() {
  function slugToTitle(slug) {
    return decodeURIComponent(slug)
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function pickPriceFromText(text) {
    const m = (text || '').match(/(\d+[\.,]?\d*)\s*€/);
    return m ? `${m[1].replace(',', '.')}€` : null;
  }

  const out = [];
  const seen = new Set();

  // Orden visual del grid: de izquierda a derecha, arriba a abajo.
  const cards = Array.from(
    document.querySelectorAll(
      '.feed-grid__item, [data-testid*="feed-grid-item"], [data-testid*="catalog-item"], [class*="feed-grid__item"], [class*="catalog-item"]'
    )
  );

  const orderedCards = cards
    .map((card) => ({ card, rect: card.getBoundingClientRect() }))
    .filter((x) => x.rect.width > 20 && x.rect.height > 20)
    .sort((a, b) => {
      const rowDiff = Math.abs(a.rect.top - b.rect.top);
      if (rowDiff > 10) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    })
    .map((x) => x.card);

  let rank = 0;
  for (const card of orderedCards) {
    const a = card.querySelector('a[href*="/items/"]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const idMatch = href.match(/\/items\/(\d+)/);
    if (!idMatch) continue;

    const itemId = idMatch[1];
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    rank += 1;

    const fullUrl = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
    const slugMatch = href.match(/\/items\/\d+-([^/?#]+)/);
    const cardText = card?.innerText || '';

    const titleFromDom =
      card?.querySelector('[data-testid*="description"], [data-testid*="title"], h2, h3')?.textContent?.trim() ||
      a.getAttribute('aria-label') ||
      '';
    const title = titleFromDom || (slugMatch ? slugToTitle(slugMatch[1]) : `Item ${itemId}`);
    const priceText =
      card?.querySelector('[data-testid*="price"], [class*="price"]')?.textContent?.trim() ||
      pickPriceFromText(cardText);

    const catalogText = `${title || ''} ${String(cardText || '').slice(0, 700)} ${fullUrl}`;
    out.push({ itemId, url: fullUrl, title, priceText, rank, catalogText });
  }

  // Fallback por si cambia el DOM del grid.
  if (out.length === 0) {
    const anchors = document.querySelectorAll('a[href*="/items/"]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const idMatch = href.match(/\/items\/(\d+)/);
      if (!idMatch) continue;
      const itemId = idMatch[1];
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      rank += 1;
      const fullUrl = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
      const slugMatch = href.match(/\/items\/\d+-([^/?#]+)/);
      const title = slugMatch ? slugToTitle(slugMatch[1]) : `Item ${itemId}`;
      const catalogText = `${title || ''} ${fullUrl}`;
      out.push({ itemId, url: fullUrl, title, priceText: null, rank, catalogText });
    }
  }

  return out.slice(0, 250);
}

function extractItemMetricsFromPage() {
  function parseCount(text, patterns) {
    for (const pattern of patterns) {
      const m = text.match(pattern);
      if (m) {
        for (let i = 1; i < m.length; i += 1) {
          const numeric = String(m[i] || '').replace(/[^\d]/g, '');
          if (!numeric) continue;
          const value = parseInt(numeric, 10);
          if (!Number.isNaN(value)) return value;
        }
      }
    }
    return null;
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const value = el?.textContent?.trim();
      if (value) return value;
    }
    return null;
  }

  function extractUploadedText(value) {
    const lines = String(value || '')
      .split('\n')
      .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    for (const line of lines) {
      if (/^(subido|uploaded|posted|caricato)\b/i.test(line) && /\b(hace|ago|fa)\b/i.test(line)) {
        return line.slice(0, 80);
      }
    }
    const patterns = [
      /(subido\s+hace\s+[^\.,;]{1,40})/i,
      /(subido\s+[^\.,;]{1,40})/i,
      /(uploaded\s+[^\.,;]{1,40})/i,
      /(posted\s+[^\.,;]{1,40}\s+ago)/i,
      /(caricato\s+[^\.,;]{1,40})/i,
      /(\bhace\s+\d+\s+(?:minutos?|horas?|dias?|semanas?|meses?|anos?)\b)/i,
      /(\bhace\s+una?\s+(?:hora|minuto|dia|semana|mes|ano)\b)/i,
    ];
    for (const p of patterns) {
      const m = value.match(p);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  }

  function extractDescriptionFromJsonLd() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      const raw = script?.textContent?.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const node = queue.shift();
          if (!node) continue;
          if (typeof node === 'string') continue;
          if (Array.isArray(node)) {
            queue.push(...node);
            continue;
          }
          if (typeof node === 'object') {
            const desc = typeof node.description === 'string' ? node.description.trim() : '';
            if (desc) return desc;
            for (const value of Object.values(node)) {
              if (value && typeof value === 'object') queue.push(value);
            }
          }
        }
      } catch (_) {
        // ignore JSON-LD parse failures
      }
    }
    return null;
  }

  function absoluteVintedUrl(href) {
    const value = String(href || '').trim();
    if (!value) return null;
    if (value.startsWith('https://www.vinted.es/')) return value;
    if (value.startsWith('/')) return `https://www.vinted.es${value}`;
    return null;
  }

  function extractSellerFromJsonLd() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      const raw = script?.textContent?.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const node = queue.shift();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node)) {
            queue.push(...node);
            continue;
          }
          const seller = node.seller;
          if (seller && typeof seller === 'object' && !Array.isArray(seller)) {
            const name = typeof seller.name === 'string' ? seller.name.trim() : '';
            const profileUrl =
              absoluteVintedUrl(seller.url) ||
              absoluteVintedUrl(seller['@id']) ||
              null;
            if (name || profileUrl) {
              return {
                sellerName: name || null,
                sellerProfileUrl: profileUrl,
              };
            }
          }
          for (const value of Object.values(node)) {
            if (value && typeof value === 'object') queue.push(value);
          }
        }
      } catch (_) {
        // ignore JSON-LD parse failures
      }
    }
    return null;
  }

  function extractSellerFromDom() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const sellerAnchor = anchors.find((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (!href) return false;
      if (/\/items\/\d+/i.test(href)) return false;
      return /\/member\/\d+/i.test(href) || /\/users?\//i.test(href) || /user_id=\d+/i.test(href);
    });
    if (!sellerAnchor) return null;
    const sellerName = sellerAnchor.textContent?.trim() || null;
    const sellerProfileUrl = absoluteVintedUrl(sellerAnchor.getAttribute('href'));
    if (!sellerName && !sellerProfileUrl) return null;
    return {
      sellerName,
      sellerProfileUrl,
    };
  }

  function inferSellerAccountStatus(rawValue, sellerProfileUrl) {
    if (!sellerProfileUrl) return 'unknown';
    if (
      /(usuario bloqueado|cuenta bloqueada|member blocked|account blocked|account suspended|usuario suspendido|compte bloqué|profilo bloccato)/i.test(rawValue)
    ) {
      return 'blocked';
    }
    return 'active';
  }

  const rawText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const text = rawText.toLowerCase();

  let status = 'active';
  if (/(vendido|sold|ya se ha vendido|agotado)/i.test(text)) {
    status = 'sold';
  } else if (/(reservado|reserved)/i.test(text)) {
    status = 'reserved';
  }

  const title = firstText(['h1', '[data-testid*="title"]']);
  const description =
    firstText([
      '[data-testid*="description"]',
      '[itemprop="description"]',
      '.item-description',
      '[class*="description"]',
    ]) ||
    document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
    extractDescriptionFromJsonLd();
  const priceText =
    firstText([
      '[data-testid*="item-price"]',
      '[data-testid*="price"]',
      '[class*="price"]',
    ]) ||
    (() => {
      const m = rawText.match(/(\d+[\.,]?\d*)\s*€/);
      return m ? `${m[1].replace(',', '.')}€` : null;
    })();

  const likesCount = parseCount(rawText, [
    /(\d[\d\s\.]*)\s*(me gusta|likes?|favoritos?)/i,
    /(me gusta|likes?|favoritos?)\s*[:\-]?\s*(\d[\d\s\.]*)/i,
  ]);

  const viewsCount = parseCount(rawText, [
    /(\d[\d\s\.]*)\s*(visitas|visualizaciones|views?)/i,
    /(visitas|visualizaciones|views?)\s*[:\-]?\s*(\d[\d\s\.]*)/i,
  ]);

  const offersCount = parseCount(rawText, [
    /(\d[\d\s\.]*)\s*(ofertas|offers?)/i,
    /(ofertas|offers?)\s*[:\-]?\s*(\d[\d\s\.]*)/i,
  ]);

  const uploadedText = extractUploadedText(rawText);
  const isPopular = /(popular|artículo popular|item popular)/i.test(rawText);
  const modelHint = `${title || ''} ${description || ''} ${rawText.slice(0, 1200)} ${window.location?.pathname || ''}`;
  const sellerFromJsonLd = extractSellerFromJsonLd();
  const sellerFromDom = extractSellerFromDom();
  const sellerName = sellerFromJsonLd?.sellerName || sellerFromDom?.sellerName || null;
  const sellerProfileUrl =
    sellerFromJsonLd?.sellerProfileUrl || sellerFromDom?.sellerProfileUrl || null;
  const sellerAccountStatus = inferSellerAccountStatus(rawText, sellerProfileUrl);

  return {
    status,
    title,
    priceText,
    likesCount,
    viewsCount,
    offersCount,
    uploadedText,
    isPopular,
    description,
    modelHint,
    sellerName,
    sellerProfileUrl,
    sellerAccountStatus,
    sellerLastCheckedAt: sellerProfileUrl ? new Date().toISOString() : null,
    sellerAccountReason: sellerAccountStatus === 'blocked' ? 'Detectado texto de bloqueo en ficha' : null,
  };
}

function extractSellerProfileStatusFromPage() {
  const rawText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const text = rawText.toLowerCase();
  const blockedPatterns = [
    /bloquead/i,
    /suspendid/i,
    /cuenta no disponible/i,
    /perfil no disponible/i,
    /usuario no existe/i,
    /member blocked/i,
    /account blocked/i,
    /account suspended/i,
    /user not found/i,
    /profile not found/i,
    /compte bloqu/i,
    /profilo bloccato/i,
  ];
  const isBlocked = blockedPatterns.some((p) => p.test(text));
  const hasItems = document.querySelectorAll('a[href*="/items/"]').length > 0;
  const displayName = document.querySelector('h1')?.textContent?.trim() || null;

  let accountStatus = 'unknown';
  let reason = 'sin suficientes datos';
  if (isBlocked) {
    accountStatus = 'blocked';
    reason = 'perfil con texto de bloqueo/suspension';
  } else if (hasItems || displayName) {
    accountStatus = 'active';
    reason = 'perfil visible con actividad';
  }

  return {
    accountStatus,
    reason,
    displayName,
    checkedAt: new Date().toISOString(),
  };
}
