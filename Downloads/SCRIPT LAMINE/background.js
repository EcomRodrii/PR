
const DEFAULT_SEARCH_URL = 'https://www.vinted.es/catalog?order=newest_first&brand_ids%5B%5D=242&page=1';
const DEFAULT_OAKLEY_URL = 'https://www.vinted.es/catalog?search_text=oakley&order=newest_first&page=1&catalog%5B%5D=98';
const CONFIG_KEY = 'raybanMonitorConfig';
const STORAGE_KEY = 'raybanMonitorState';
const ANALYSES_KEY = 'raybanMonitorAnalyses';
const RUNTIME_KEY = 'raybanMonitorRuntime';
const DETECT_ALARM = 'rayban-detect';
const TRACK_ALARM = 'rayban-track';
const CYCLE_ALARM = 'rayban-cycle';
const DETECT_PERIOD_MIN = 5;
const EXPIRY_HOURS = 24;
const MAX_SNAPSHOTS = 400;
const DETECT_PARALLEL_TABS = 4;
const TRACK_PARALLEL_TABS = 5;
const TRACK_MAX_ITEMS_PER_CYCLE = 50;
const TRACK_ITEM_RECHECK_MINUTES = 10;
const SELLER_CHECK_INTERVAL_HOURS = 6;
const SELLER_CHECK_MAX_PER_TRACK = 8;
const STARTUP_GAP_ALERT_MINUTES = 8;

const VINTED_SESSION_CHECK_URL = 'https://www.vinted.es/settings/shipping';
const VINTED_SESSION_MEMBER_FALLBACK_URL = 'https://www.vinted.es/';
const VINTED_SESSION_REFRESH_MINUTES = 12;
const VINTED_SESSION_REFRESH_PATH = '/session-refresh';
const VINTED_SESSION_REFRESH_EXTRA_TIMEOUT_MS = 25000;
const VINTED_SESSION_BOOTSTRAP_WAIT_MS = 10000;
const VINTED_SESSION_POLL_TIMEOUT_MS = 26000;
const VINTED_SESSION_POLL_INTERVAL_MS = 1200;

const ACTIONS_PAGE = 'actions.html';
const MARKETPLACE_PAGE = 'marketplace.html';
const CUENTA_VINTED_PAGE = 'cuenta-vinted.html';
const MARKETPLACE_ANALYSIS_KEY = 'mktCurrentAnalysis';
const MKT_ALARM_PREFIX = 'mkt-scan-';
const MKT_SCAN_PERIOD_MINUTES = 20;   // scan interval during 12h analysis
const MKT_ANALYSIS_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours
const EXT_MONITOR_KEY = 'extMonitorData';

// ── Sistema de licencias ───────────────────────────────────────────────────────
// Cambia AUTH_API_URL a tu servidor cuando lo tengas desplegado.
// Mientras sea el placeholder, el sistema funciona sin bloqueos (modo desarrollo).
const AUTH_API_URL        = 'http://localhost:3000';
const LICENSE_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 min caché normal
const ACTION_CACHE_TTL_MS  = 30 * 1000;        // 30 s caché por acción crítica
const AUTH_STORAGE_TOKEN   = 'lamine_auth_token';
const AUTH_STORAGE_DEVICE  = 'lamine_device_id';
const LICENSE_ALARM_NAME   = 'lamine-license-verify';
const LICENSE_ALARM_MIN    = 10;

// LICENSE_ACTIVE controla si el sistema de licencias está activo.
// Ponlo en `true` cuando tengas el servidor desplegado y quieras activar la verificación.
const LICENSE_ACTIVE = false;

// Acciones que nunca necesitan licencia
const LICENSE_EXEMPT_ACTIONS = new Set([
  'rb:auth-login',
  'rb:auth-login-success',
  'rb:auth-logout',
  'rb:auth-status',
  'rb:get-state',
  'rb:list-analyses',
  'rb:vacation-status',
  'rb:vacation-apply',
  'rb:vacation-schedule',
  'rb:seller-bot-get',
  'rb:seller-bot-set',
  'rb:seller-bot-run',
  'rb:seller-bot-reset-state',
]);

// Acciones críticas que piden validación explícita al servidor
const CRITICAL_ACTIONS = new Set([
  'rb:start-monitoring',
  'rb:run-detect',
  'rb:run-track',
  'rb:mkt-start-analysis',
  'rb:ext-monitor-run-worker',
  'rb:ext-monitor-create-requests',
]);

let _licCache   = null;         // { result, cachedAt }
const _actCache = new Map();    // action → { allowed, reason, cachedAt }

// ── Device ID ─────────────────────────────────────────────────────────────────
async function getOrCreateDeviceId() {
  try {
    const stored = await chrome.storage.local.get(AUTH_STORAGE_DEVICE);
    if (stored?.[AUTH_STORAGE_DEVICE]) return stored[AUTH_STORAGE_DEVICE];
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    arr[6] = (arr[6] & 0x0f) | 0x40;
    arr[8] = (arr[8] & 0x3f) | 0x80;
    const h = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    const uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    await chrome.storage.local.set({ [AUTH_STORAGE_DEVICE]: uuid });
    return uuid;
  } catch (_) { return 'unknown'; }
}

// ── Token ─────────────────────────────────────────────────────────────────────
async function getLicenseToken() {
  try {
    const s = await chrome.storage.local.get(AUTH_STORAGE_TOKEN);
    return s?.[AUTH_STORAGE_TOKEN] || null;
  } catch (_) { return null; }
}

// ── Wrapper fetch con headers de autenticación ────────────────────────────────
async function _apiRequest(path, options = {}) {
  const token    = await getLicenseToken();
  const deviceId = await getOrCreateDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${AUTH_API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type':        'application/json',
        'X-Extension-Version': EXTENSION_VERSION,
        'X-Device-Id':         deviceId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Verificación de licencia ──────────────────────────────────────────────────
async function checkLicense({ force = false } = {}) {
  // Modo desarrollo: sin servidor configurado → siempre permitido
  if (!LICENSE_ACTIVE) return { allowed: true, status: 'dev_mode', message: '' };

  // Caché válida
  if (!force && _licCache && (Date.now() - _licCache.cachedAt) < LICENSE_CACHE_TTL_MS) {
    return _licCache.result;
  }

  const token = await getLicenseToken();
  if (!token) {
    return { allowed: false, status: 'no_token', message: 'Inicia sesión para usar la extensión.' };
  }

  try {
    const data   = await _apiRequest('/license/verify');
    const result = {
      allowed: data.allowed === true,
      status:  String(data.status  || 'inactive'),
      message: String(data.message || ''),
    };
    _licCache = { result, cachedAt: Date.now() };
    return result;
  } catch (_) {
    // Error de red: si hay caché (aunque expirada) úsala; si no, permitir
    // (no bloquear por problemas de red — solo bloquear si el servidor dice "no")
    if (_licCache) return { ..._licCache.result, _stale: true };
    return { allowed: true, status: 'network_error', message: '' };
  }
}

// ── Validación de acción crítica (el backend decide) ──────────────────────────
async function validateCriticalAction(action) {
  // Modo desarrollo → siempre permitido
  if (!LICENSE_ACTIVE) return { allowed: true, reason: 'dev_mode', cachedAt: Date.now() };

  const cached = _actCache.get(action);
  if (cached && (Date.now() - cached.cachedAt) < ACTION_CACHE_TTL_MS) return cached;

  try {
    const data   = await _apiRequest('/action/validate', { method: 'POST', body: JSON.stringify({ action }) });
    const result = { allowed: data.allowed === true, reason: String(data.reason || data.error || ''), cachedAt: Date.now() };
    _actCache.set(action, result);
    return result;
  } catch (_) {
    // Error de red → permitir (igual que checkLicense)
    return { allowed: true, reason: 'network_fallback', cachedAt: Date.now() };
  }
}

function invalidateLicenseCache() {
  _licCache = null;
  _actCache.clear();
}

// ── Alarma periódica de re-verificación ──────────────────────────────────────
async function ensureLicenseAlarm() {
  if (!LICENSE_ACTIVE) return;   // sin servidor no hace falta alarma
  const existing = await chrome.alarms.get(LICENSE_ALARM_NAME).catch(() => null);
  if (!existing) {
    chrome.alarms.create(LICENSE_ALARM_NAME, { periodInMinutes: LICENSE_ALARM_MIN });
  }
}

const EXTENSION_VERSION = chrome.runtime.getManifest().version || '0.0.0';
const MODEL_KEYWORDS = [
  'meta wayfarer',
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
  'handball spezial',
  'spezial',
  'gazelle',
  'samba',
  'campus',
  'superstar',
  'forum',
  'air max',
  'dunk',
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
const MODEL_BRAND_TERMS = [
  'ray ban',
  'rayban',
  'oakley',
  'adidas',
  'nike',
  'new balance',
  'newbalance',
  'reebok',
  'puma',
  'asics',
  'salomon',
  'jordan',
  'air jordan',
  'airjordan',
  'converse',
  'vans',
  'mizuno',
  'hoka',
];
const MODEL_GENERIC_PREFIX_TOKENS = new Set([
  'gafas',
  'de',
  'sol',
  'zapatillas',
  'zapatilla',
  'zapatos',
  'zapato',
  'baskets',
  'basket',
  'sneakers',
  'sneaker',
  'glasses',
  'sunglasses',
  'lunettes',
  'occhiali',
  'bag',
  'bolso',
  'mochila',
  'backpack',
  'sandalias',
  'sandalia',
  'botas',
  'bota',
  'tenis',
]);
const MODEL_BREAK_TOKENS = new Set([
  'nuevo',
  'nueva',
  'nuevos',
  'nuevas',
  'new',
  'neuf',
  'neuve',
  'sin',
  'con',
  'para',
  'muy',
  'estado',
  'condition',
  'excellent',
  'excelente',
  'good',
  'perfecto',
  'perfecta',
  'usado',
  'usada',
  'usados',
  'usadas',
  'talla',
  'size',
  'eu',
  'uk',
  'us',
  'cm',
  'hombre',
  'mujer',
  'men',
  'man',
  'women',
  'woman',
  'kids',
  'kid',
  'nino',
  'nina',
  'color',
  'colore',
  'couleur',
  'negro',
  'negra',
  'black',
  'white',
  'blanco',
  'blanca',
  'gris',
  'grey',
  'gray',
  'azul',
  'blue',
  'verde',
  'green',
  'rojo',
  'red',
  'rosa',
  'pink',
  'brown',
  'marron',
  'beige',
  'yellow',
  'amarillo',
  'gold',
  'dorado',
  'silver',
  'plateado',
  'navy',
  'sky',
  'referrer',
  'catalog',
  'catalogo',
  'prizm',
  'polarized',
  'polarizado',
]);
const MODEL_LABEL_PATTERNS = [
  /\bmodelo\b\s+([a-z0-9][a-z0-9\s]{1,80})/,
  /\bmodel\b\s+([a-z0-9][a-z0-9\s]{1,80})/,
  /\bmodello\b\s+([a-z0-9][a-z0-9\s]{1,80})/,
];
const MODEL_SORTED_TERMS = [...new Set([...FOCUS_MODEL_TERMS, ...MODEL_KEYWORDS])].sort(
  (a, b) => b.length - a.length
);
const MODEL_SORTED_BRANDS = [...new Set(MODEL_BRAND_TERMS)].sort((a, b) => b.length - a.length);
const MODEL_BRAND_PREFIXES = [...new Set(MODEL_BRAND_TERMS.map((term) => term.replace(/\s+/g, '')))].sort(
  (a, b) => b.length - a.length
);
const MODEL_CANDIDATE_SOURCE_SCORES = Object.freeze({
  explicitField: 160,
  explicitReference: 146,
  titleKnown: 130,
  titleBrand: 122,
  titleCandidate: 110,
  hintLabel: 98,
  hintKnown: 90,
  hintBrand: 84,
  hintCandidate: 72,
  descriptionLabel: 66,
  descriptionKnown: 60,
  descriptionBrand: 56,
  descriptionCandidate: 44,
});
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

function isRunCancelled(localRunId) {
  return localRunId !== monitorRunId;
}

function nowIso() {
  return new Date().toISOString();
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


function normalizeClientIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-fA-F0-9:.]/g, '').slice(0, 90);
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

function normalizeVintedAddressForLog(session) {
  const raw =
    String(session?.shippingAddressText || '').trim() ||
    [session?.shippingAddressLine1, session?.shippingAddressLine2]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(' ');
  if (!raw) return '-';
  const compact = raw.replace(/\s+/g, ' ').trim();
  const lowered = compact.toLowerCase();
  if (
    lowered.includes('tratamos los datos') ||
    lowered.includes('consentimiento') ||
    lowered.includes('cookies') ||
    lowered.includes('politica')
  ) {
    return 'no_detectada';
  }
  return compact;
}

function getCampaignLabelFromSummary(entry) {
  const name = String(entry?.name || '').trim();
  if (name) return name;
  const product = String(entry?.productName || '').trim();
  return product || '';
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

function formatEuroValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(2)}€`;
}

function computeModelSalesStats(items) {
  const list = Array.isArray(items) ? items : [];
  const map = new Map();
  for (const item of list) {
    if (item?.status !== 'sold') continue;
    const modelName =
      String(item?.modelName || '').trim() ||
      inferModelName({
        title: item?.title || '',
        description: item?.description || '',
        modelFieldText: item?.latest?.modelFieldText || '',
        modelReferenceText: item?.latest?.modelReferenceText || '',
        hint: `${item?.url || ''} ${item?.sourceSearchUrl || ''}`,
      });
    const key = normalizePlainText(modelName) || 'desconocido';
    const current = map.get(key) || {
      key,
      modelName: modelName || 'desconocido',
      soldCount: 0,
      sumPrice: 0,
      pricedCount: 0,
      sumMinutes: 0,
      timedCount: 0,
    };
    current.soldCount += 1;
    const soldPrice = Number(item?.soldPriceValue);
    if (Number.isFinite(soldPrice)) {
      current.sumPrice += soldPrice;
      current.pricedCount += 1;
    }
    const timeToSellMinutes = Number(item?.timeToSellMinutes);
    if (Number.isFinite(timeToSellMinutes) && timeToSellMinutes >= 0) {
      current.sumMinutes += timeToSellMinutes;
      current.timedCount += 1;
    }
    map.set(key, current);
  }
  return Array.from(map.values());
}

function normalizeModelExploitAlertsMap(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [rawKey, rawEntry] of Object.entries(source)) {
    const key = normalizePlainText(rawKey);
    if (!key) continue;
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
    const lastCount = Math.max(0, Number(entry.lastCount) || 0);
    const lastMilestone = Math.max(0, Number(entry.lastMilestone) || 0);
    const lastSentAt = String(entry.lastSentAt || '').trim() || null;
    out[key] = {
      lastCount,
      lastMilestone,
      lastSentAt,
    };
  }
  return out;
}

function computeExploitableMilestone(soldCount) {
  const count = Math.max(0, Math.floor(Number(soldCount) || 0));
  if (count < MODEL_EXPLOITABLE_MIN_SOLD) return 0;
  if (count < 20) return MODEL_EXPLOITABLE_MIN_SOLD;
  return Math.floor(count / 10) * 10;
}

async function processExploitableModelAlerts(state, _config) {
  const sent  = { count: 0 };
  const errors = { count: 0 };

  try {
    if (!state?.items?.length) return { sent: 0, errors: 0, changed: false };

    // Track which items we've already notified
    if (!state.metrics.notifiedHotItems || typeof state.metrics.notifiedHotItems !== 'object') {
      state.metrics.notifiedHotItems = {};
    }
    const notified = state.metrics.notifiedHotItems;
    const nowMs = Date.now();
    const HOT_LIKES_THRESHOLD  = 8;
    const HOT_NOTIFY_WINDOW_MS = 30 * 60 * 1000; // notify only if detected in last 30min
    const HOT_NOTIFY_COOLDOWN  = 60 * 60 * 1000; // max 1 notif per item per hour

    // Clean old entries
    for (const id of Object.keys(notified)) {
      if (nowMs - Number(notified[id] || 0) > 24 * 60 * 60 * 1000) delete notified[id];
    }

    const hotCandidates = state.items.filter(item => {
      if (item.status === 'sold') return false;
      const likes = item.latest?.likesCount || 0;
      if (likes < HOT_LIKES_THRESHOLD && !item.isHot) return false;
      const detectedMs = new Date(item.detectedAt || 0).getTime();
      if (nowMs - detectedMs > HOT_NOTIFY_WINDOW_MS) return false; // too old
      const lastNotif = Number(notified[item.itemId] || 0);
      if (nowMs - lastNotif < HOT_NOTIFY_COOLDOWN) return false; // already notified recently
      return true;
    });

    for (const item of hotCandidates.slice(0, 3)) { // max 3 notifs per cycle
      const likes   = item.latest?.likesCount || 0;
      const price   = item.latest?.priceText  || '-';
      const model   = item.modelName && item.modelName !== 'desconocido' ? item.modelName : '';
      const tier    = item.opportunityTier || '🔥';
      const title   = item.title || `Item ${item.itemId}`;
      const display = model ? `${model} — ${title}` : title;

      try {
        await chrome.notifications.create(`hot-${item.itemId}-${nowMs}`, {
          type:    'basic',
          iconUrl: 'icons/icon-pro-128.png',
          title:   `${tier} Producto caliente detectado`,
          message: `${display}\n❤️ ${likes} likes · ${price}`,
          priority: 2,
        });
        notified[item.itemId] = nowMs;
        sent.count += 1;
      } catch (e) {
        errors.count += 1;
      }
    }

    state.metrics.notifiedHotItems = notified;
  } catch (e) {
    errors.count += 1;
  }

  return { sent: sent.count, errors: errors.count, changed: sent.count > 0 };
}

function formatModelLabel(value) {
  const normalized = normalizePlainText(value);
  if (!normalized) return 'desconocido';
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (/^rb\d{4,5}$/i.test(token)) return token.toUpperCase();
      if (/^\d+$/.test(token)) return token;
      if (/^\d+[a-z]+$/.test(token)) return token;
      if (/^[a-z]+\d+[a-z0-9]*$/.test(token)) return token.toUpperCase();
      if (token.length <= 2) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function matchKnownModelTerm(rawValue) {
  const text = normalizePlainText(rawValue);
  if (!text) return '';
  for (const term of MODEL_SORTED_TERMS) {
    if (text.includes(term)) return term;
  }
  const rbRef = text.match(/\brb\s?(\d{4,5})\b/);
  if (rbRef) return `rb${rbRef[1]}`;
  return '';
}

function stripModelBrandPrefix(token) {
  const value = String(token || '').trim();
  if (!value) return '';
  for (const brand of MODEL_BRAND_PREFIXES) {
    if (value.startsWith(brand) && value.length > brand.length) {
      return value.slice(brand.length);
    }
  }
  return value;
}

function stripLeadingModelBrandPhrase(rawValue) {
  const normalized = normalizePlainText(rawValue);
  if (!normalized) return '';
  for (const brand of MODEL_SORTED_BRANDS) {
    if (normalized === brand) return '';
    if (normalized.startsWith(`${brand} `)) {
      return normalized.slice(brand.length + 1).trim();
    }
  }
  return normalized;
}

function buildModelCandidateFromTokens(rawValue) {
  const normalized = stripLeadingModelBrandPhrase(rawValue);
  if (!normalized) return '';

  let tokens = normalized
    .split(/\s+/)
    .map(stripModelBrandPrefix)
    .map((token) => String(token || '').trim())
    .filter(Boolean);

  if (!tokens.length) return '';

  while (tokens.length) {
    const token = tokens[0];
    if (MODEL_GENERIC_PREFIX_TOKENS.has(token) || MODEL_BREAK_TOKENS.has(token)) {
      tokens.shift();
      continue;
    }
    break;
  }

  const candidate = [];
  for (const token of tokens) {
    if (!token) continue;
    if (!candidate.length && (MODEL_GENERIC_PREFIX_TOKENS.has(token) || MODEL_BREAK_TOKENS.has(token))) {
      continue;
    }
    if (candidate.length && MODEL_BREAK_TOKENS.has(token)) {
      break;
    }
    if (!candidate.length && /^\d+$/.test(token) && token.length <= 2) {
      continue;
    }
    candidate.push(token);
    if (candidate.length >= 4) break;
  }

  const compact = candidate.join(' ').trim();
  if (!compact) return '';
  const letters = compact.replace(/[^a-z]/g, '');
  if (!letters && !/\d{3,4}/.test(compact)) return '';
  return compact;
}

function extractModelFromBrandMatch(rawValue) {
  const text = normalizePlainText(rawValue);
  if (!text) return '';
  for (const brand of MODEL_SORTED_BRANDS) {
    const pattern = new RegExp(`(?:^|\\b)${brand.replace(/\s+/g, '\\s+')}\\b\\s+([a-z0-9\\s]{2,80})`);
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = buildModelCandidateFromTokens(match[1]);
    if (candidate) return candidate;
  }
  return '';
}

function extractModelFromLabeledText(rawValue) {
  const text = normalizePlainText(rawValue);
  if (!text) return '';
  for (const pattern of MODEL_LABEL_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = buildModelCandidateFromTokens(match[1]);
    if (candidate) return candidate;
  }
  return '';
}

function isMeaningfulModelCandidate(rawValue) {
  const normalized = normalizePlainText(rawValue);
  if (!normalized) return false;
  if (MODEL_SORTED_BRANDS.includes(normalized)) return false;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.every((token) => MODEL_GENERIC_PREFIX_TOKENS.has(token) || MODEL_BREAK_TOKENS.has(token))) {
    return false;
  }
  if (tokens.length === 1) {
    const token = tokens[0];
    if (MODEL_GENERIC_PREFIX_TOKENS.has(token) || MODEL_BREAK_TOKENS.has(token)) return false;
    if (token.length <= 2 && !/^\d{3,5}$/.test(token)) return false;
  }
  return true;
}

function hasStrongModelCode(rawValue) {
  const normalized = normalizePlainText(rawValue);
  if (!normalized) return false;
  return /\brb\s?\d{4,5}\b/i.test(rawValue) || /\b[a-z]{1,5}\d{3,5}[a-z0-9-]{0,6}\b/i.test(normalized);
}

function hasKnownModelBrand(rawValue) {
  const text = normalizePlainText(rawValue);
  if (!text) return false;
  return MODEL_SORTED_BRANDS.some((brand) => text.includes(brand));
}

function collectModelCandidate(targetMap, rawCandidate, meta = {}) {
  const candidate = formatModelLabel(rawCandidate);
  const normalized = normalizePlainText(candidate);
  if (!normalized || !isMeaningfulModelCandidate(normalized)) return;

  let score = Number(MODEL_CANDIDATE_SOURCE_SCORES[meta.source] || 0);
  if (!score) return;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const knownTerm = matchKnownModelTerm(normalized);
  if (knownTerm) score += 24;
  if (hasStrongModelCode(normalized)) score += 18;
  if (tokens.length >= 2 && tokens.length <= 3) score += 10;
  else if (tokens.length === 1 && tokens[0].length >= 5) score += 6;
  else if (tokens.length >= 4) score -= 6;
  if (normalized.length > 34) score -= 8;
  if (meta.rawText && normalizePlainText(meta.rawText).includes(normalized)) score += 5;

  const previous = targetMap.get(normalized);
  if (!previous || score > previous.score) {
    targetMap.set(normalized, {
      normalized,
      label: candidate,
      score,
      source: meta.source,
    });
  }
}

function inferModelName(input) {
  const payload =
    input && typeof input === 'object'
      ? input
      : {
          hint: input,
        };
  const title = String(payload?.title || '').trim();
  const description = String(payload?.description || '').trim();
  const hint = String(payload?.hint || payload?.modelHint || payload?.rawText || '').trim();
  const modelFieldText = String(payload?.modelFieldText || payload?.field || payload?.modelField || '').trim();
  const modelReferenceText = String(
    payload?.modelReferenceText || payload?.referenceFieldText || payload?.referenceField || ''
  ).trim();
  const candidates = new Map();

  collectModelCandidate(
    candidates,
    extractModelFromLabeledText(modelFieldText) || matchKnownModelTerm(modelFieldText) || buildModelCandidateFromTokens(modelFieldText),
    { source: 'explicitField', rawText: modelFieldText }
  );
  collectModelCandidate(
    candidates,
    matchKnownModelTerm(modelReferenceText) || buildModelCandidateFromTokens(modelReferenceText),
    { source: 'explicitReference', rawText: modelReferenceText }
  );
  collectModelCandidate(candidates, matchKnownModelTerm(title), { source: 'titleKnown', rawText: title });
  collectModelCandidate(candidates, extractModelFromBrandMatch(title), { source: 'titleBrand', rawText: title });
  collectModelCandidate(candidates, buildModelCandidateFromTokens(title), { source: 'titleCandidate', rawText: title });
  collectModelCandidate(candidates, extractModelFromLabeledText(hint), { source: 'hintLabel', rawText: hint });
  collectModelCandidate(candidates, matchKnownModelTerm(hint), { source: 'hintKnown', rawText: hint });
  collectModelCandidate(candidates, extractModelFromBrandMatch(hint), { source: 'hintBrand', rawText: hint });
  collectModelCandidate(candidates, buildModelCandidateFromTokens(hint), { source: 'hintCandidate', rawText: hint });
  collectModelCandidate(candidates, extractModelFromLabeledText(description), { source: 'descriptionLabel', rawText: description });
  collectModelCandidate(candidates, matchKnownModelTerm(description), { source: 'descriptionKnown', rawText: description });
  collectModelCandidate(candidates, extractModelFromBrandMatch(description), { source: 'descriptionBrand', rawText: description });
  collectModelCandidate(candidates, buildModelCandidateFromTokens(description), { source: 'descriptionCandidate', rawText: description });

  const best = Array.from(candidates.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
    return a.label.localeCompare(b.label);
  })[0];
  if (best?.label) return best.label;

  const hasBrand =
    hasKnownModelBrand(title) ||
    hasKnownModelBrand(modelFieldText) ||
    hasKnownModelBrand(modelReferenceText) ||
    hasKnownModelBrand(hint) ||
    hasKnownModelBrand(description);
  return hasBrand ? 'desconocido' : 'generico';
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

function defaultVintedSession() {
  return {
    status: 'unknown',
    loggedIn: null,
    username: null,
    displayName: null,
    fullName: null,
    firstName: null,
    lastName: null,
    shippingAddressLine1: null,
    shippingAddressLine2: null,
    shippingAddressText: null,
    profileUrl: null,
    memberId: null,
    language: null,
    locale: null,
    pageUrl: null,
    reason: 'sin_comprobacion',
    lastCheckedAt: null,
  };
}

function normalizeVintedSession(raw) {
  const base = defaultVintedSession();
  const input = raw && typeof raw === 'object' ? raw : {};
  const statusRaw = String(input.status || '').trim().toLowerCase();
  const status = ['logged_in', 'no_account', 'unknown'].includes(statusRaw) ? statusRaw : 'unknown';
  const loggedInRaw = input.loggedIn;
  const loggedIn =
    loggedInRaw === true ? true : loggedInRaw === false ? false : status === 'logged_in' ? true : status === 'no_account' ? false : null;
  const profileUrl = (() => {
    const value = String(input.profileUrl || '').trim();
    if (!value) return null;
    if (value.startsWith('https://www.vinted.es/')) return value;
    if (value.startsWith('/')) return `https://www.vinted.es${value}`;
    return null;
  })();
  const memberId = String(input.memberId || '').trim() || null;
  return {
    status,
    loggedIn,
    username: String(input.username || '').trim() || null,
    displayName: String(input.displayName || '').trim() || null,
    fullName: String(input.fullName || '').trim() || null,
    firstName: String(input.firstName || '').trim() || null,
    lastName: String(input.lastName || '').trim() || null,
    shippingAddressLine1: String(input.shippingAddressLine1 || '').trim() || null,
    shippingAddressLine2: String(input.shippingAddressLine2 || '').trim() || null,
    shippingAddressText: String(input.shippingAddressText || '').trim() || null,
    profileUrl,
    memberId,
    language: String(input.language || '').trim() || null,
    locale: String(input.locale || '').trim() || null,
    pageUrl: String(input.pageUrl || '').trim() || null,
    reason: String(input.reason || '').trim() || base.reason,
    lastCheckedAt: String(input.lastCheckedAt || '').trim() || null,
  };
}

function shouldRefreshVintedSession(session) {
  const lastMs = new Date(session?.lastCheckedAt || 0).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return Date.now() - lastMs >= VINTED_SESSION_REFRESH_MINUTES * 60 * 1000;
}

function hasVintedSessionChanged(previousSession, nextSession) {
  const prev = normalizeVintedSession(previousSession);
  const next = normalizeVintedSession(nextSession);
  const keys = [
    'status',
    'loggedIn',
    'username',
    'displayName',
    'fullName',
    'firstName',
    'lastName',
    'shippingAddressLine1',
    'shippingAddressLine2',
    'shippingAddressText',
    'profileUrl',
    'memberId',
    'language',
    'locale',
    'pageUrl',
    'reason',
  ];
  return keys.some((key) => {
    const a = String(prev?.[key] ?? '');
    const b = String(next?.[key] ?? '');
    return a !== b;
  });
}

function buildVintedSessionLogDetails(session, probeMeta = null, extracted = null, force = false) {
  const s = normalizeVintedSession(session);
  const accountLabel =
    String(s.username || s.displayName || '').trim() ||
    (s.loggedIn === true ? 'logueada_sin_alias' : 'sin_cuenta');
  const addressLabel = normalizeVintedAddressForLog(s) || 'sin_direccion_detectada';
  const details = {
    force: force ? 'si' : 'no',
    estado: s.status || 'unknown',
    logueada: s.loggedIn === true ? 'si' : s.loggedIn === false ? 'no' : 'unknown',
    usuario: accountLabel,
    member_id: s.memberId || '-',
    nombre: s.fullName || '-',
    direccion: addressLabel,
    motivo: s.reason || '-',
  };
  if (probeMeta && typeof probeMeta === 'object') {
    details.intentos = Number.isFinite(probeMeta.attempts) ? probeMeta.attempts : '-';
    details.espera_ms = Number.isFinite(probeMeta.waitedMs) ? probeMeta.waitedMs : '-';
    details.lista = probeMeta.ready === true ? 'si' : 'no';
  }
  if (extracted && typeof extracted === 'object') {
    details.load_state = String(extracted.loadState || '').trim() || '-';
    details.loading_signals = extracted.loadingSignals === true ? 'si' : 'no';
  }
  return details;
}

function defaultRuntimeState() {
  return {
    monitorRunning: false,
    lastStartAt: null,
    lastHeartbeatAt: null,
    lastCleanStopAt: null,
    lastStopReason: null,
    extMonitorWorker: {
      running: false,
      lastTrigger: null,
      lastAttemptAt: null,
      lastCompletedAt: null,
      lastOutcome: null,
      lastReason: null,
      lastError: null,
      memberId: null,
      sessionLoggedIn: null,
      sessionMemberId: null,
      sessionReason: null,
      registerOk: null,
      registerError: null,
      lastTaskId: null,
      lastTaskOutcome: null,
    },
  };
}

function defaultConfig() {
  return {
    monitorEnabled: false,
    productName: '',
    unitCost: null,
    searchUrls: [],
    vintedSession: defaultVintedSession(),
    detectPeriodMinutes: DETECT_PERIOD_MIN,
    nextCyclePhase: PHASE_DETECT,
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
  const vintedSession = normalizeVintedSession(loaded.vintedSession);

  return {
    monitorEnabled,
    productName,
    unitCost,
    searchUrls,
    searchUrl: searchUrls[0] || '',
    vintedSession,
    detectPeriodMinutes,
    nextCyclePhase,
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
    vintedSession: Object.prototype.hasOwnProperty.call(configPatch || {}, 'vintedSession')
      ? normalizeVintedSession(configPatch?.vintedSession)
      : normalizeVintedSession(current.vintedSession),
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
    extMonitorWorker: {
      ...base.extMonitorWorker,
      ...(loaded.extMonitorWorker && typeof loaded.extMonitorWorker === 'object' ? loaded.extMonitorWorker : {}),
    },
  };
}

async function setRuntimeState(patch) {
  const current = await getRuntimeState();
  const next = {
    ...current,
    ...(patch || {}),
  };
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'extMonitorWorker')) {
    next.extMonitorWorker = {
      ...current.extMonitorWorker,
      ...(patch.extMonitorWorker && typeof patch.extMonitorWorker === 'object' ? patch.extMonitorWorker : {}),
    };
  }
  await chrome.storage.local.set({ [RUNTIME_KEY]: next });
  return next;
}

async function setExtMonitorWorkerRuntime(patch = {}) {
  const runtime = await getRuntimeState();
  const nextWorker = {
    ...(runtime.extMonitorWorker || defaultRuntimeState().extMonitorWorker),
    ...(patch && typeof patch === 'object' ? patch : {}),
  };
  await setRuntimeState({
    extMonitorWorker: nextWorker,
  });
  return nextWorker;
}

async function getExtensionMonitorWorkerStatus() {
  const [config, runtime] = await Promise.all([getConfig(), getRuntimeState()]);
  return {
    ok: true,
    vintedSession: normalizeVintedSession(config.vintedSession),
    worker: {
      ...defaultRuntimeState().extMonitorWorker,
      ...(runtime.extMonitorWorker || {}),
    },
  };
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

function startupGapThresholdMs(config) {
  const detectPeriod = Math.max(5, Number(config?.detectPeriodMinutes) || 5);
  const gapMinutes = Math.max(STARTUP_GAP_ALERT_MINUTES, detectPeriod + 2);
  return gapMinutes * 60 * 1000;
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

  const nowMs = Date.now();
  const lastHeartbeatMs = new Date(runtime.lastHeartbeatAt || 0).getTime();
  const hasLastHeartbeat = Number.isFinite(lastHeartbeatMs);
  const downMs = hasLastHeartbeat ? nowMs - lastHeartbeatMs : null;
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

async function openHiddenTab(url) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    throw new Error(`openHiddenTab: tabs.create failed — ${err?.message || err}`);
  }
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('openHiddenTab: tabs.create returned invalid tab');
  }
  return tab.id;
}

function waitForTabLoad(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    let resolved = false;
    let extendedTimeout = false;
    let timer = null;

    function isVintedSessionRefreshUrl(rawUrl) {
      const url = String(rawUrl || '').toLowerCase();
      if (!url) return false;
      return url.includes('://www.vinted.es/session-refresh') || url.includes(VINTED_SESSION_REFRESH_PATH);
    }

    function restartTimer(ms) {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    }

    function maybeExtendTimeout() {
      if (extendedTimeout) return;
      extendedTimeout = true;
      restartTimer(timeout + VINTED_SESSION_REFRESH_EXTRA_TIMEOUT_MS);
    }

    const done = () => {
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (id, changeInfo, tab) => {
      if (id !== tabId) return;
      const currentUrl = String(changeInfo?.url || tab?.url || tab?.pendingUrl || '');
      if (isVintedSessionRefreshUrl(currentUrl)) {
        maybeExtendTimeout();
        return;
      }
      if (changeInfo.status === 'complete') {
        done();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    restartTimer(timeout);

    chrome.tabs.get(tabId)
      .then((tab) => {
        const currentUrl = String(tab?.url || tab?.pendingUrl || '');
        if (isVintedSessionRefreshUrl(currentUrl)) {
          maybeExtendTimeout();
          return;
        }
        if (tab.status === 'complete') done();
      })
      .catch(done);
  });
}

async function closeTabQuiet(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    // no-op
  }
}

async function runInTab(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result?.[0]?.result;
}

/**
 * isTabScriptable — returns true only when it is safe to call
 * chrome.scripting.executeScript on this tab.
 *
 * Chrome throws "Frame with ID 0 is showing error page" (and similar errors)
 * when the tab has landed on a network error page, about:blank, or any
 * non-http(s) URL that doesn't allow script injection.
 */
async function isTabScriptable(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.status !== 'complete') return false;
    const url = String(tab.url || '');
    // Only http / https pages can receive injected scripts
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return true;
  } catch (_) {
    return false;
  }
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
    modelName: inferModelName({
      title: raw.title || '',
      hint: `${catalogBlob} ${sourceSearchUrl || ''}`,
    }),
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
    imageUrl: raw.imageUrl || null,
    hotScore: Number.isFinite(raw.likesCount) ? raw.likesCount : 0,
    isHot: Number.isFinite(raw.likesCount) && raw.likesCount >= 8,
    opportunityScore: Number.isFinite(raw.likesCount) ? Math.min(Math.round((raw.likesCount / 20) * 40), 40) : 0,
    opportunityTier: '',
    latest: {
      checkedAt: null,
      status: 'active',
      priceText: raw.priceText || null,
      priceValue: parsePriceValue(raw.priceText || null),
      likesCount: Number.isFinite(raw.likesCount) ? raw.likesCount : null,
      viewsCount: null,
      offersCount: null,
      uploadedText: null,
      publishedAt: null,
      isPopular: null,
      description: null,
      modelFieldText: null,
      modelReferenceText: null,
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

    // ── Actualizar likes desde catálogo en cada ciclo detect ──────────────────
    const freshLikes = normalized.latest?.likesCount;
    if (Number.isFinite(freshLikes) && freshLikes >= 0) {
      if (!existing.latest) existing.latest = {};
      existing.latest.likesCount = freshLikes;
      // Recalcular hot score con datos frescos del catálogo
      const detectedMs = new Date(existing.detectedAt || 0).getTime();
      const ageMin = detectedMs > 0 ? (Date.now() - detectedMs) / 60000 : 999;
      const lph = ageMin > 5 ? (freshLikes / ageMin) * 60 : 0;
      existing.hotScore = Math.round(freshLikes + lph * 2);
      existing.isHot = freshLikes >= 8 || lph >= 3;
      existing.opportunityScore = Math.min(
        Math.round((freshLikes / 20) * 40) + (existing.opportunityScore || 0) % 60,
        100
      );
      existing.opportunityTier = '';
    }
    // Actualizar precio si cambió
    if (normalized.latest?.priceText && !existing.latest?.priceText) {
      existing.latest.priceText = normalized.latest.priceText;
      existing.latest.priceValue = normalized.latest.priceValue;
    }
    // Actualizar imagen si el catálogo la detectó y no teníamos una
    if (normalized.imageUrl && !existing.imageUrl) {
      existing.imageUrl = normalized.imageUrl;
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

  // Persistir imagen (og:image capturado en el track cycle)
  if (metrics.imageUrl && !item.imageUrl) {
    item.imageUrl = metrics.imageUrl;
  }

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
    modelFieldText: metrics.modelFieldText ?? item.latest?.modelFieldText ?? null,
    modelReferenceText: metrics.modelReferenceText ?? item.latest?.modelReferenceText ?? null,
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

  // ── Hot product scoring ───────────────────────────────────────────────────
  const likes = item.latest.likesCount || 0;
  const detectedMs = new Date(item.detectedAt || 0).getTime();
  const ageMinutes = detectedMs > 0 ? (Date.now() - detectedMs) / 60000 : 999;
  const likesPerHour = ageMinutes > 5 ? (likes / ageMinutes) * 60 : 0;
  item.hotScore = Math.round(likes + likesPerHour * 2);
  item.isHot = likes >= 8 || likesPerHour >= 3;

  // ── Opportunity Score (0-100) ─────────────────────────────────────────────
  const uploadedRaw = String(item.latest?.uploadedText || item.publishedAtText || '').toLowerCase();
  const recencyPts =
    /hace \d+ (minuto|hora)|hoy|today|just now/i.test(uploadedRaw) ? 30 :
    /hace 1 d[íi]a|ayer|yesterday/i.test(uploadedRaw) ? 18 :
    /hace 2 d[íi]as/i.test(uploadedRaw) ? 8 : 2;
  const likesPts   = Math.min(likes / 20, 1) * 40;
  const velocityPts = Math.min(likesPerHour / 5, 1) * 15;
  const sellerPts  = item.sellerAccountStatus === 'active' ? 10 : 0;
  const offerPts   = metrics.canOffer === true ? 5 : 0;
  item.opportunityScore = Math.round(likesPts + recencyPts + velocityPts + sellerPts + offerPts);
  item.opportunityTier = '';

  const oldTags = new Set(Array.isArray(item.keywordTags) ? item.keywordTags : []);
  item.modelName = inferModelName({
    title: item.title || metrics.title || '',
    description: item.description || metrics.description || '',
    modelFieldText: metrics.modelFieldText || item.latest?.modelFieldText || '',
    modelReferenceText: metrics.modelReferenceText || item.latest?.modelReferenceText || '',
    hint: `${metrics.modelHint || ''} ${item.url || ''}`,
  });
  const modelText = `${item.title || ''} ${item.description || ''} ${metrics.modelFieldText || ''} ${metrics.modelReferenceText || ''} ${
    metrics.modelHint || ''
  } ${item.url || ''}`;
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

async function inspectItemUrl(url) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(url);
    await waitForTabLoad(tabId, 30000);
    await delay(3000);
    if (!await isTabScriptable(tabId)) {
      console.warn('[Monitor] inspectItemUrl: tab not scriptable', url);
      return null;
    }
    const metrics = await runInTab(tabId, extractItemMetricsFromPage).catch(() => null);
    return metrics || null;
  } catch (err) {
    console.warn('[Monitor] inspectItemUrl error (returning null):', err?.message || err);
    return null;
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

async function inspectSellerProfileUrl(url) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(url);
    await waitForTabLoad(tabId, 30000);
    await delay(2200);
    if (!await isTabScriptable(tabId)) {
      console.warn('[Monitor] inspectSellerProfileUrl: tab not scriptable', url);
      return null;
    }
    const metrics = await runInTab(tabId, extractSellerProfileStatusFromPage).catch(() => null);
    return metrics || null;
  } catch (err) {
    console.warn('[Monitor] inspectSellerProfileUrl error (returning null):', err?.message || err);
    return null;
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

async function refreshVintedSessionInfo({ force = false } = {}) {
  if (vintedSessionRefreshPromise) return vintedSessionRefreshPromise;

  vintedSessionRefreshPromise = (async () => {
    const config = await getConfig();
    const currentSession = normalizeVintedSession(config.vintedSession);
    if (!force && !shouldRefreshVintedSession(currentSession)) {
      return { ok: true, skipped: true, config, session: currentSession };
    }

    let nextSession = currentSession;
    let probeMeta = null;
    let extracted = null;
    const runProbeAt = async (url) => {
      const tabId = await openHiddenTab(url);
      try {
        await waitForTabLoad(tabId, 30000);
        const probe = await probeVintedSessionUntilReady(tabId);
        return {
          probe,
          snapshot: probe?.snapshot || null,
        };
      } finally {
        await closeTabQuiet(tabId);
      }
    };
    try {
      const primary = await runProbeAt(VINTED_SESSION_CHECK_URL);
      probeMeta = primary.probe;
      extracted = primary.snapshot;
      nextSession = normalizeVintedSession({
        ...currentSession,
        ...(extracted && typeof extracted === 'object' ? extracted : {}),
        reason:
          !primary.probe?.ready && extracted?.reason
            ? `${String(extracted.reason).slice(0, 100)}_timeout`
            : extracted?.reason || currentSession.reason,
        lastCheckedAt: nowIso(),
      });

      if (nextSession.loggedIn === true && !String(nextSession.memberId || '').trim()) {
        try {
          const fallback = await runProbeAt(VINTED_SESSION_MEMBER_FALLBACK_URL);
          const fallbackSnapshot = fallback?.snapshot || null;
          const hasFallbackIdentity = Boolean(
            fallbackSnapshot?.memberId || fallbackSnapshot?.profileUrl || fallbackSnapshot?.username
          );
          if (hasFallbackIdentity) {
            probeMeta = fallback.probe;
            extracted = {
              ...(extracted && typeof extracted === 'object' ? extracted : {}),
              ...fallbackSnapshot,
            };
            nextSession = normalizeVintedSession({
              ...nextSession,
              ...fallbackSnapshot,
              reason: fallbackSnapshot?.reason || nextSession.reason,
              lastCheckedAt: nowIso(),
            });
          }
        } catch (_) {
          // keep primary session snapshot when fallback probe fails
        }
      }
    } catch (err) {
      nextSession = normalizeVintedSession({
        ...currentSession,
        status: currentSession.status || 'unknown',
        reason: `check_error: ${String(err?.message || 'unknown').slice(0, 120)}`,
        lastCheckedAt: nowIso(),
      });
    }

    const nextConfig = await setConfig({ vintedSession: nextSession });
    const changed = hasVintedSessionChanged(currentSession, nextSession);
    const mustLog =
      force ||
      changed ||
      String(nextSession?.reason || '')
        .toLowerCase()
        .includes('check_error') ||
      String(nextSession?.reason || '')
        .toLowerCase()
        .includes('timeout');
    return { ok: true, config: nextConfig, session: nextSession };
  })();

  try {
    return await vintedSessionRefreshPromise;
  } finally {
    vintedSessionRefreshPromise = null;
  }
}

async function probeVintedSessionUntilReady(tabId) {
  const startedAt = Date.now();
  let snapshot = null;
  let attempts = 0;

  await delay(VINTED_SESSION_BOOTSTRAP_WAIT_MS);

  while (Date.now() - startedAt <= VINTED_SESSION_POLL_TIMEOUT_MS) {
    attempts += 1;
    let current = null;
    try {
      current = await runInTab(tabId, extractCurrentVintedAccountFromPage);
    } catch (_) {
      current = null;
    }
    if (current && typeof current === 'object') {
      snapshot = current;
      const hasUsefulIdentity = Boolean(
        current.profileUrl || current.memberId || current.username || current.displayName || current.fullName
      );
      const hasUsefulAddress = Boolean(
        current.shippingAddressText || current.shippingAddressLine1 || current.shippingAddressLine2
      );
      const isReady =
        current.ready === true ||
        current.loadState === 'ready' ||
        current.status === 'no_account' ||
        (current.status === 'logged_in' && (hasUsefulIdentity || hasUsefulAddress));
      if (isReady) {
        return {
          ready: true,
          snapshot: current,
          attempts,
          waitedMs: Date.now() - startedAt,
        };
      }
    }
    await delay(VINTED_SESSION_POLL_INTERVAL_MS);
  }

  return {
    ready: false,
    snapshot,
    attempts,
    waitedMs: Date.now() - startedAt,
  };
}

async function runDetectCycle(trigger = 'scheduler') {
  if (trackRunning) return { ok: true, skipped: true, reason: 'track_running' };
  if (detectRunning) return { ok: true, skipped: true };
  // ── LamineResell — verificación interna de licencia ───────────────────────
  if (LICENSE_ACTIVE) {
    const _lic = await checkLicense().catch(() => ({ allowed: false }));
    if (!_lic.allowed) return { ok: false, disabled: true, reason: 'license_invalid' };
  }
  detectRunning = true;
  const localRunId = monitorRunId;

  const state = await getState();
  let config = await getConfig();
  void refreshVintedSessionInfo({ force: false }).catch(() => {});
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
    let detectedTotal = 0;
    let newCountTotal = 0;
    let scannedOk = 0;
    let filteredOutTotal = 0;
    const detectedBatches = [];
    const urlErrors = [];

    const detectResults = await mapWithConcurrency(
      searchUrls,
      DETECT_PARALLEL_TABS,
      async (searchUrl) => {
        if (isRunCancelled(localRunId)) {
          throw new Error('aborted');
        }
        let tabId = null;
        try {
          tabId = await openHiddenTab(searchUrl);
          await waitForTabLoad(tabId, 30000);
          if (isRunCancelled(localRunId)) {
            throw new Error('aborted');
          }
          // Espera mínima para que la sesión de Vinted esté disponible en el tab
          await delay(2500);
          if (!await isTabScriptable(tabId)) {
            console.warn('[Detect] Tab not scriptable after load:', searchUrl);
            return { searchUrl, detected: [] };
          }
          // extractCatalogItemsFromPage usa la API REST de Vinted (no DOM),
          // funciona en tabs ocultos sin depender de renderizado JS del cliente.
          const detected = (await runInTab(tabId, extractCatalogItemsFromPage).catch((e) => {
            console.warn('[Detect] executeScript error:', e?.message);
            return null;
          })) || [];
          console.log(`[Detect] ${searchUrl} → ${Array.isArray(detected) ? detected.length : 'ERR'} items`);
          return { searchUrl, detected: Array.isArray(detected) ? detected : [] };
        } catch (err) {
          console.warn('[Detect] Tab error for', searchUrl, '—', err?.message || err);
          throw err;
        } finally {
          if (tabId !== null) await closeTabQuiet(tabId);
        }
      }
    );

    for (let i = 0; i < detectResults.length; i += 1) {
      const result = detectResults[i];
      const searchUrl = searchUrls[i];
      if (!result?.ok) {
        urlErrors.push({ searchUrl, error: result?.error?.message || 'error' });
        continue;
      }
      scannedOk += 1;
      const detected = Array.isArray(result?.value?.detected) ? result.value.detected : [];
      const filteredResult = filterDetectedBySearchUrl(searchUrl, detected);
      filteredOutTotal += filteredResult.dropped;
      const detectedWithSource = filteredResult.items.map((entry) => ({
        ...entry,
        sourceSearchUrl: searchUrl,
      }));
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
  // ── LamineResell — verificación interna de licencia ───────────────────────
  if (LICENSE_ACTIVE) {
    const _lic = await checkLicense().catch(() => ({ allowed: false }));
    if (!_lic.allowed) return { ok: false, disabled: true, reason: 'license_invalid' };
  }
  trackRunning = true;
  const localRunId = monitorRunId;

  const state = await getState();
  let config = await getConfig();
  void refreshVintedSessionInfo({ force: false }).catch(() => {});
  const nowMs = Date.now();
  let attempted = 0;
  let checked = 0;
  let errors = 0;
  let expired = 0;
  let soldThisRun = 0;
  let notified = 0;
  let notifyErrors = 0;
  let exploitableAlerts = 0;
  let exploitableAlertErrors = 0;
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
            // ── Perfil enriquecido ──
            item.sellerProfile = {
              itemsCount:   sellerMetrics?.itemsCount   ?? null,
              rating:       sellerMetrics?.rating       ?? null,
              reviewCount:  sellerMetrics?.reviewCount  ?? null,
              memberSince:  sellerMetrics?.memberSince  ?? null,
              responseTime: sellerMetrics?.responseTime ?? null,
              lastLogin:    sellerMetrics?.lastLogin    ?? null,
              trustScore:   sellerMetrics?.trustScore   ?? 0,
              trustTier:    sellerMetrics?.trustTier    ?? '⚠️ DESCONOCIDO',
            };
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

      kept.push(item); // active items collected below for parallel processing
    }

    // ── Parallel track of active items ────────────────────────────────────────
    const activeItems = kept.filter(i => i.status !== 'sold');

    // Priority sort: unvisited first (snapshots=0), then oldest checked
    const prioritized = [...activeItems].sort((a, b) => {
      const aSnaps = Array.isArray(a.snapshots) ? a.snapshots.length : 0;
      const bSnaps = Array.isArray(b.snapshots) ? b.snapshots.length : 0;
      if (aSnaps === 0 && bSnaps > 0) return -1;
      if (bSnaps === 0 && aSnaps > 0) return 1;
      const aMs = new Date(a.latest?.checkedAt || 0).getTime();
      const bMs = new Date(b.latest?.checkedAt || 0).getTime();
      return aMs - bMs; // oldest check first
    });

    // Skip items checked very recently (except those with 0 snapshots)
    const toTrack = prioritized.filter(item => {
      const snaps = Array.isArray(item.snapshots) ? item.snapshots.length : 0;
      if (snaps === 0) return true; // always visit untracked items
      const lastMs = new Date(item.latest?.checkedAt || 0).getTime();
      return nowMs - lastMs >= TRACK_ITEM_RECHECK_MINUTES * 60 * 1000;
    }).slice(0, TRACK_MAX_ITEMS_PER_CYCLE);

    attempted = toTrack.length;

    // Process in parallel batches
    for (let i = 0; i < toTrack.length; i += TRACK_PARALLEL_TABS) {
      if (isRunCancelled(localRunId)) { aborted = true; break; }
      const batch = toTrack.slice(i, i + TRACK_PARALLEL_TABS);
      const results = await Promise.allSettled(
        batch.map(item => inspectItemUrl(item.url))
      );
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const result = results[j];
        const prevStatus = item.status;
        if (result.status === 'fulfilled' && result.value) {
          try {
            applyMetricsToItem(state, item, result.value);
            checked += 1;
          } catch (_) { errors += 1; }
        } else {
          errors += 1;
        }
        if (prevStatus !== 'sold' && item.status === 'sold') soldThisRun += 1;
      }
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
        notified,
        notifyErrors,
        exploitableAlerts,
        exploitableAlertErrors,
        sellerChecked,
        sellerErrors,
      };
    }

    state.items = kept.sort(
      (a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
    );
    state.metrics.lastTrackRun = nowIso();
    const exploitableResult = await processExploitableModelAlerts(state, config);
    exploitableAlerts = Number(exploitableResult?.sent || 0);
    exploitableAlertErrors = Number(exploitableResult?.errors || 0);
    state.metrics.lastTrackSummary = {
      attempted,
      checked,
      errors,
      expired,
      soldThisRun,
      notified,
      notifyErrors,
      exploitableAlerts,
      exploitableAlertErrors,
      sellerChecked,
      sellerErrors,
    };
    state.metrics.lastError =
      errors > 0 || notifyErrors > 0 || exploitableAlertErrors > 0 || sellerErrors > 0
        ? `track_partial: ${errors} item(s) con error${exploitableAlertErrors > 0 ? ` | alertas_modelo: ${exploitableAlertErrors}` : ''}${sellerErrors > 0 ? ` | seller: ${sellerErrors}` : ''}`
        : null;

    await setState(state);
    return {
      ok: true,
      attempted,
      checked,
      errors,
      expired,
      soldThisRun,
      notified,
      notifyErrors,
      exploitableAlerts,
      exploitableAlertErrors,
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
      notified,
      notifyErrors,
      exploitableAlerts,
      exploitableAlertErrors,
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
  const current = await getConfig();
  const next = await setConfig({ monitorEnabled: false });
  await clearAlarms();
  await markMonitorStoppedRuntime('manual_stop');
  const stopNotification = {
    sent: false,
    skipped: true,
    reason: 'event_log_only',
  };
  return { ok: true, config: next, stopNotification };
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

async function openActionsTab() {
  const actionsUrl = chrome.runtime.getURL(ACTIONS_PAGE);
  const tabs = await chrome.tabs.query({ url: actionsUrl });
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
  await chrome.tabs.create({ url: actionsUrl });
}


async function openMarketplaceTab() {
  const mktUrl = chrome.runtime.getURL(MARKETPLACE_PAGE);
  const tabs = await chrome.tabs.query({ url: mktUrl });
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
  await chrome.tabs.create({ url: mktUrl });
}

async function openCuentaVintedTab() {
  const cvUrl = chrome.runtime.getURL(CUENTA_VINTED_PAGE);
  const tabs = await chrome.tabs.query({ url: cvUrl });
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
  await chrome.tabs.create({ url: cvUrl });
}


// ── Marketplace scraper (enhanced: extracts size + seller) ───────────────────

async function scrapeVintedCatalogPage(url) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(url);
    await waitForTabLoad(tabId, 30000);
    await delay(2500);
    if (!await isTabScriptable(tabId)) {
      console.warn('[Marketplace] scrapeVintedCatalogPage: tab not scriptable', url);
      return [];
    }
    const items = (await runInTab(tabId, extractMarketplaceItemsFromPage).catch(() => null)) || [];
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.warn('[Marketplace] scrapeVintedCatalogPage error (returning []):', err?.message || err);
    return [];
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}


async function runMarketplaceAnalytics(query) {
  const encoded = encodeURIComponent(String(query || '').trim());
  const activeUrl = `https://www.vinted.es/catalog?search_text=${encoded}&order=newest_first`;
  const soldUrl   = `https://www.vinted.es/catalog?search_text=${encoded}&status%5B%5D=sold_out&order=newest_first`;

  const [activeItems, soldItems] = await Promise.all([
    scrapeVintedCatalogPage(activeUrl),
    scrapeVintedCatalogPage(soldUrl),
  ]);

  return { activeItems, soldItems, query };
}


// ── 12-hour deep analysis engine ──────────────────────────────────────────────

async function getMktAnalysis() {
  const raw = await chrome.storage.local.get(MARKETPLACE_ANALYSIS_KEY);
  const stored = raw?.[MARKETPLACE_ANALYSIS_KEY];
  if (!stored || typeof stored !== 'object') return null;
  // Normalize fields that may be missing in analyses created by older code.
  if (!stored.trackedItems || typeof stored.trackedItems !== 'object' || Array.isArray(stored.trackedItems)) {
    stored.trackedItems = {};
  }
  if (!Array.isArray(stored.soldItems))      stored.soldItems  = [];
  if (typeof stored.scanCount !== 'number')  stored.scanCount  = 0;
  if (!stored.results)                       stored.results    = null;
  return stored;
}

async function saveMktAnalysis(analysis) {
  await chrome.storage.local.set({ [MARKETPLACE_ANALYSIS_KEY]: analysis });
}

async function startMarketplaceAnalysis(query) {
  // Stop any existing analysis first
  const existing = await getMktAnalysis();
  if (existing?.id) {
    try { await chrome.alarms.clear(`${MKT_ALARM_PREFIX}${existing.id}`); } catch (_) {}
  }

  const id = `mkt-${Date.now().toString(36)}`;
  const now = Date.now();
  const analysis = {
    id,
    query,
    startedAt: now,
    endsAt: now + MKT_ANALYSIS_DURATION_MS,
    status: 'running',
    scanCount: 0,
    lastScanAt: null,
    trackedItems: {},   // itemId → item object
    soldItems: [],      // confirmed sold items (with all data)
    results: null,
  };

  await saveMktAnalysis(analysis);

  // Schedule periodic scans; first fires after 1 minute
  await chrome.alarms.create(`${MKT_ALARM_PREFIX}${id}`, {
    delayInMinutes: 1,
    periodInMinutes: MKT_SCAN_PERIOD_MINUTES,
  });

  return analysis;
}

async function runMarketplaceScanCycle(analysisId) {
  const analysis = await getMktAnalysis();
  if (!analysis || analysis.id !== analysisId) return;
  if (analysis.status !== 'running') return;

  // Defensive normalization — guard against analyses stored by older code
  // versions that might be missing fields added later.
  if (!analysis.trackedItems || typeof analysis.trackedItems !== 'object' || Array.isArray(analysis.trackedItems)) {
    analysis.trackedItems = {};
  }
  if (!Array.isArray(analysis.soldItems)) {
    analysis.soldItems = [];
  }
  if (typeof analysis.scanCount !== 'number') {
    analysis.scanCount = 0;
  }

  const now = Date.now();

  // Auto-complete after 12 hours
  if (now > analysis.endsAt) {
    analysis.status = 'completed';
    analysis.results = computeMarketplaceResults(analysis);
    await saveMktAnalysis(analysis);
    try { await chrome.alarms.clear(`${MKT_ALARM_PREFIX}${analysisId}`); } catch (_) {}
    return;
  }

  try {
    const encoded   = encodeURIComponent(analysis.query);
    const activeUrl = `https://www.vinted.es/catalog?search_text=${encoded}&order=newest_first`;
    const soldUrl   = `https://www.vinted.es/catalog?search_text=${encoded}&status%5B%5D=sold_out&order=newest_first`;

    // ── 1. Scrape active catalog + collect sold item URLs in parallel ─────────
    // Active catalog: full scrape (price, size from grid cards)
    // Sold catalog:   lightweight — we only need item URLs; real data comes
    //                 from individual product pages (seller is not in the grid)
    // allSettled ensures one failed scrape never aborts the other.
    const [activeSettled, soldSettled] = await Promise.allSettled([
      scrapeVintedCatalogPage(activeUrl),
      scrapeVintedCatalogUrls(soldUrl),
    ]);
    const activeItems = activeSettled.status === 'fulfilled' ? (activeSettled.value || []) : [];
    const soldRefs    = soldSettled.status   === 'fulfilled' ? (soldSettled.value   || []) : [];

    // ── 2. Update active items list (no "disappeared = sold" logic) ───────────
    for (const item of activeItems) {
      const existing = analysis.trackedItems[item.itemId];
      if (!existing) {
        analysis.trackedItems[item.itemId] = { ...item, status: 'active', firstSeenAt: now, lastSeenAt: now };
      } else if (existing.status === 'active') {
        // Refresh price/size but keep firstSeenAt
        analysis.trackedItems[item.itemId] = {
          ...existing, ...item,
          status: 'active',
          firstSeenAt: existing.firstSeenAt,
          lastSeenAt: now,
        };
      }
    }

    // ── 3. Find sold items we have NOT yet investigated ───────────────────────
    const alreadyKnown = new Set(Object.keys(analysis.trackedItems));
    const toInvestigate = soldRefs
      .filter((r) => !alreadyKnown.has(r.itemId))
      .slice(0, 12); // max 12 new items per cycle to avoid tab overload

    // ── 4. Open each sold product page and extract real data ──────────────────
    // Concurrency=3: 3 tabs open at once, sequential batches
    const investigated = await mapWithConcurrency(toInvestigate, 3, async ({ itemId, url }) => {
      return inspectSoldItemPage(url);
    });

    for (let i = 0; i < toInvestigate.length; i++) {
      const { itemId, url } = toInvestigate[i];
      const result = investigated[i];
      if (!result?.ok || !result.value) continue;

      // Reject pages not confirmed sold — catches redirects, relisted items,
      // or any case where the sold catalog URL returned a non-sold page.
      if (!result.value.isSold) {
        console.log(`[Marketplace] Skipping item ${itemId} — page does not confirm sold status`);
        continue;
      }

      const d = result.value; // { isSold, sellerName, sellerId, price, priceText, size, title, condition, brand }

      const soldEntry = {
        itemId,
        url,
        status:          'sold',
        title:           (typeof d.title      === 'string' && d.title)      || `Item ${itemId}`,
        seller:          (typeof d.sellerName === 'string' && d.sellerName) || null,
        sellerId:        (typeof d.sellerId   === 'string' && d.sellerId)   || null,
        price:           (typeof d.price      === 'number' && !isNaN(d.price) && d.price > 0) ? d.price : null,
        priceText:       (typeof d.priceText  === 'string' && d.priceText)  || null,
        size:            (typeof d.size       === 'string' && d.size)       || null,
        condition:       (typeof d.condition  === 'string' && d.condition)  || null,
        brand:           (typeof d.brand      === 'string' && d.brand)      || null,
        soldAt:          now,
        firstSeenAt:     now,
        timeToSellMs:    null,
        timeToSellHours: null,
      };

      analysis.trackedItems[itemId] = soldEntry;
      if (!analysis.soldItems.find((s) => s.itemId === itemId)) {
        analysis.soldItems.push(soldEntry);
      }
    }

    analysis.scanCount  += 1;
    analysis.lastScanAt  = now;
    analysis.results     = computeMarketplaceResults(analysis);

    await saveMktAnalysis(analysis);
  } catch (err) {
    console.error('[Marketplace] Scan cycle error:', err);
  }
}


// Open the sold catalog page and return just { itemId, url } pairs.
// Individual product pages are opened separately to get real seller/size data.
async function scrapeVintedCatalogUrls(url) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(url);
    await waitForTabLoad(tabId, 30000);
    await delay(2000);
    if (!await isTabScriptable(tabId)) {
      console.warn('[Marketplace] scrapeVintedCatalogUrls: tab not scriptable', url);
      return [];
    }
    const refs = (await runInTab(tabId, extractCatalogUrlsFromPage).catch(() => null)) || [];
    return Array.isArray(refs) ? refs : [];
  } catch (err) {
    console.warn('[Marketplace] scrapeVintedCatalogUrls error (returning []):', err?.message || err);
    return [];
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}


// Open a single product page and extract seller, price, size and more.
async function inspectSoldItemPage(url) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(url);
    await waitForTabLoad(tabId, 30000);
    await delay(2000);
    if (!await isTabScriptable(tabId)) {
      console.warn('[Marketplace] inspectSoldItemPage: tab not scriptable', url);
      return null;
    }
    const detail = await runInTab(tabId, extractSoldItemDetail).catch(() => null);
    return detail || null;
  } catch (err) {
    console.warn('[Marketplace] inspectSoldItemPage error (returning null):', err?.message || err);
    return null;
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

function computeMarketplaceResults(analysis) {
  const allTracked = Object.values(analysis.trackedItems);
  const sold = analysis.soldItems;
  const active = allTracked.filter((i) => i.status === 'active');

  // ── Size ranking (from all sold items) ───────────────────────────────────
  const sizeCounts = {};
  for (const item of sold) {
    const s = item.size ? item.size.toUpperCase() : 'Sin talla';
    sizeCounts[s] = (sizeCounts[s] || 0) + 1;
  }
  const sizeRanking = Object.entries(sizeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([size, count]) => ({ size, count }));

  // ── Top sellers ───────────────────────────────────────────────────────────
  const sellerMap = {};
  for (const item of sold) {
    const key = item.seller || item.sellerId || 'Desconocido';
    if (!sellerMap[key]) {
      sellerMap[key] = { seller: item.seller || key, sellerId: item.sellerId || null, count: 0, prices: [] };
    }
    sellerMap[key].count += 1;
    if (item.price != null && item.price > 0) sellerMap[key].prices.push(item.price);
  }
  const topSellers = Object.values(sellerMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((s) => ({
      seller:   s.seller,
      sellerId: s.sellerId,
      count:    s.count,
      avgPrice: s.prices.length ? +(s.prices.reduce((a, b) => a + b, 0) / s.prices.length).toFixed(2) : null,
    }));

  // ── Price stats ───────────────────────────────────────────────────────────
  const soldPrices   = sold.map((i) => i.price).filter((p) => p != null && p > 0);
  const activePrices = active.map((i) => i.price).filter((p) => p != null && p > 0);

  const avgOf = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const avgSoldPrice   = avgOf(soldPrices);
  const avgActivePrice = avgOf(activePrices);
  const minSoldPrice   = soldPrices.length   ? Math.min(...soldPrices)   : null;
  const maxSoldPrice   = soldPrices.length   ? Math.max(...soldPrices)   : null;

  // ── Time to sell (only tracked items, not sold_direct) ────────────────────
  const trackedTimes = sold
    .filter((i) => i.timeToSellHours != null)
    .map((i) => i.timeToSellHours);

  const avgTimeToSellHours = trackedTimes.length ? avgOf(trackedTimes) : null;

  const timeBuckets = { lt1h: 0, '1_6h': 0, '6_24h': 0, '24_72h': 0, gt72h: 0 };
  for (const h of trackedTimes) {
    if      (h <  1) timeBuckets.lt1h++;
    else if (h <  6) timeBuckets['1_6h']++;
    else if (h < 24) timeBuckets['6_24h']++;
    else if (h < 72) timeBuckets['24_72h']++;
    else             timeBuckets.gt72h++;
  }

  // ── Price distribution (5€ buckets) ──────────────────────────────────────
  const allPrices = [...soldPrices, ...activePrices];
  const priceDistribution = buildPriceDistribution(allPrices);

  return {
    totalTracked:      allTracked.length,
    totalSold:         sold.length,
    totalActive:       active.length,
    avgSoldPrice,
    avgActivePrice,
    minSoldPrice,
    maxSoldPrice,
    avgTimeToSellHours,
    timeBuckets,
    trackedTimesCount: trackedTimes.length,
    sizeRanking,
    topSellers,
    priceDistribution,
    recentSold:    [...sold].reverse().slice(0, 30),
    currentActive: active.slice(0, 30),
  };
}

function buildPriceDistribution(prices) {
  if (!prices.length) return [];
  const step = 5;
  const lo0 = Math.floor(Math.min(...prices) / step) * step;
  const hi0 = Math.ceil(Math.max(...prices)  / step) * step;
  const buckets = [];
  for (let lo = lo0; lo < hi0; lo += step) {
    const hi = lo + step;
    const count = prices.filter((p) => p >= lo && p < hi).length;
    buckets.push({ label: `${lo}–${hi}€`, lo, hi, count });
  }
  return buckets.filter((b) => b.count > 0);
}


async function waitForNewVintedInboxTab(existingTabIds = new Set(), timeoutMs = 18000) {
  const startedAt = Date.now();
  const knownIds = existingTabIds instanceof Set ? existingTabIds : new Set(existingTabIds || []);

  while (Date.now() - startedAt <= Math.max(2000, Number(timeoutMs) || 18000)) {
    const inboxTabs = await chrome.tabs.query({ url: 'https://www.vinted.es/inbox/*' }).catch(() => []);
    for (const tab of inboxTabs) {
      if (typeof tab?.id !== 'number') continue;
      if (!knownIds.has(tab.id)) {
        return tab;
      }
    }
    await delay(700);
  }

  return null;
}

function shouldRetryTaskInActiveTab(reason) {
  const retryable = [
    '',
    'favorite_button_not_found',
    'offer_button_not_found',
    'offer_dialog_not_opened',
  ];
  return retryable.includes(String(reason || '').trim());
}

async function executeClaimedExtensionMonitorTask(task) {
  const productUrl = String(task?.product?.url || '').trim();
  const itemId = String(task?.itemId || '').trim();
  if (!productUrl || !itemId) {
    return { outcome: 'failed', reason: 'invalid_task_payload' };
  }

  const tabsBefore = await chrome.tabs.query({ url: 'https://www.vinted.es/*' }).catch(() => []);
  const knownTabIds = new Set(
    (Array.isArray(tabsBefore) ? tabsBefore : [])
      .map((tab) => (typeof tab?.id === 'number' ? tab.id : null))
      .filter((value) => Number.isFinite(value))
  );
  const previousActiveTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const previousActiveTab = Array.isArray(previousActiveTabs) && previousActiveTabs.length ? previousActiveTabs[0] : null;

  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: productUrl, active: false });
    if (!tab || typeof tab.id !== 'number') throw new Error('tabs.create returned invalid tab');
  } catch (err) {
    console.warn('[ExtMonitor] Failed to create tab for', productUrl, '—', err?.message || err);
    return { outcome: 'failed', reason: 'tab_create_failed' };
  }

  let activatedOnce = false;
  let keepProductTabOpen = false;
  let productTabClosed = false;
  let finalResult = null;

  try {
    await waitForTabLoad(tab.id, 35000);
    await delay(2200);

    let response = await runInTab(tab.id, executeVintedLikeOfferTaskInPage, []).catch(() => null);
    const retryReason = String(response?.reason || '').trim();
    if ((!response || response.ok !== true) && shouldRetryTaskInActiveTab(retryReason)) {
      activatedOnce = true;
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      await delay(1500);
      response = await runInTab(tab.id, executeVintedLikeOfferTaskInPage, []).catch(() => null);
    }

    if (!response || response.ok !== true) {
      finalResult = {
        outcome: 'failed',
        reason: String(response?.reason || 'task_execution_failed').trim() || 'task_execution_failed',
      };
      return finalResult;
    }

    const reason = String(response.reason || 'completed').trim() || 'completed';
    const outcome =
      reason === 'own_product_skip' || reason === 'item_sold' || reason === 'already_liked_skip'
        ? 'skipped'
        : 'success';
    let chatTabClosed = false;

    if (
      reason === 'offer_submitted' ||
      reason === 'offer_submitted_already_liked'
    ) {
      const inboxTab = await waitForNewVintedInboxTab(knownTabIds, 18000);
      if (inboxTab?.id) {
        await delay(2500);
        await closeTabQuiet(inboxTab.id);
        chatTabClosed = true;
      } else if (String(response?.signal || '').trim() !== 'same_tab_inbox') {
        keepProductTabOpen = true;
        finalResult = {
          outcome: 'failed',
          reason: 'offer_inbox_not_detected',
          activatedOnce,
          chatTabClosed: false,
          productTabClosed: false,
        };
        return finalResult;
      }
    }

    if (
      reason === 'offer_submitted' ||
      reason === 'offer_submitted_already_liked'
    ) {
      await delay(chatTabClosed ? 500 : 2500);
    } else {
      await delay(1200);
    }

    finalResult = {
      outcome,
      reason,
      activatedOnce,
      chatTabClosed,
      productTabClosed: false,
    };
    return finalResult;
  } finally {
    if (!keepProductTabOpen && tab !== null) {
      await closeTabQuiet(tab.id);
      productTabClosed = true;
    }
    if (finalResult && typeof finalResult === 'object') {
      finalResult.productTabClosed = productTabClosed;
    }
    if (activatedOnce && previousActiveTab?.id) {
      await chrome.tabs.update(previousActiveTab.id, { active: true }).catch(() => {});
      if (typeof previousActiveTab.windowId === 'number') {
        await chrome.windows.update(previousActiveTab.windowId, { focused: true }).catch(() => {});
      }
    }
  }
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
  await ensureLicenseAlarm();
  void refreshVintedSessionInfo({ force: true }).catch(() => {});
  void openDashboardOnExtensionStart();
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  await handleMonitorStartupRecovery(config);
  await ensureAlarms();
  await ensureLicenseAlarm();
  void refreshVintedSessionInfo({ force: true }).catch(() => {});
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

// ══════════════════════════════════════════════════════════════════════════════
// SELLER BOT — Auto-oferta a compradores interesados
// ══════════════════════════════════════════════════════════════════════════════

const SELLER_BOT_KEY        = 'sellerBotConfig';
const SELLER_BOT_STATE_KEY  = 'sellerBotState';
const SELLER_BOT_ALARM      = 'seller-bot-cycle';
const SELLER_BOT_CYCLE_MIN  = 5; // ciclo cada 5 minutos

const DEFAULT_SELLER_BOT_CONFIG = {
  enabled:          false,
  productUrl:       '',
  itemId:           '',
  discountPct:      10,      // % de descuento a ofrecer
  messageTemplate:  '¡Hola! He visto que te ha interesado mi artículo. Te puedo hacer una oferta especial, ¿te apetece?',
  minAcceptPrice:   0,       // precio mínimo para auto-aceptar (€)
  autoAccept:       false,   // aceptar automáticamente ofertas entrantes >= minAcceptPrice
  autoMessage:      true,    // enviar mensaje/oferta a nuevos likes
  triggerLikes:     1,       // mínimo de likes para activar el envío
  maxOffersPerCycle: 10,     // máx ofertas por ciclo de 1 hora
};

const DEFAULT_SELLER_BOT_STATE = {
  knownLikerIds:     [],  // userIds ya contactados o programados
  scheduledMessages: [],  // [{userId, scheduledAt, sent, sentAt, attempts}]
  lastCheckAt:       null,
  lastLikeCount:     null,
  stats: { sent: 0, accepted: 0, errors: 0 },
};

async function getSellerBotConfig() {
  try {
    const s = await chrome.storage.local.get(SELLER_BOT_KEY);
    return { ...DEFAULT_SELLER_BOT_CONFIG, ...(s?.[SELLER_BOT_KEY] || {}) };
  } catch (_) { return { ...DEFAULT_SELLER_BOT_CONFIG }; }
}

async function setSellerBotConfig(patch) {
  const cur = await getSellerBotConfig();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SELLER_BOT_KEY]: next });
  return next;
}

async function getSellerBotState() {
  try {
    const s = await chrome.storage.local.get(SELLER_BOT_STATE_KEY);
    return { ...DEFAULT_SELLER_BOT_STATE, ...(s?.[SELLER_BOT_STATE_KEY] || {}) };
  } catch (_) { return { ...DEFAULT_SELLER_BOT_STATE }; }
}

async function patchSellerBotState(patch) {
  const cur = await getSellerBotState();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SELLER_BOT_STATE_KEY]: next });
  return next;
}

async function ensureSellerBotAlarm(enabled) {
  if (enabled) {
    const ex = await chrome.alarms.get(SELLER_BOT_ALARM).catch(() => null);
    if (!ex) chrome.alarms.create(SELLER_BOT_ALARM, { periodInMinutes: SELLER_BOT_CYCLE_MIN });
  } else {
    await chrome.alarms.clear(SELLER_BOT_ALARM).catch(() => {});
  }
}

// ── Obtiene info del item vía Vinted API + fallback DOM (para items propios) ───
async function sellerBotFetchItemInfo(itemId) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(`https://www.vinted.es/items/${itemId}`);
    await waitForTabLoad(tabId, 22000);
    await delay(2500);
    if (!await isTabScriptable(tabId)) return { ok: false, error: 'not_scriptable' };

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (iid) => {
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

        // ── Intento 1: API pública ──────────────────────────────────────────
        // Vinted devuelve 404 para items propios del vendedor en /api/v2/items/{id}
        // pero funciona para items ajenos. Lo intentamos igualmente.
        try {
          const r = await fetch(`/api/v2/items/${iid}?localize=false`, {
            credentials: 'include', headers,
          });
          if (r.ok) {
            const d = await r.json();
            const item = d?.item || d;
            const members = Array.isArray(item?.favourite_members)
              ? item.favourite_members.map(u => ({ id: String(u?.id || ''), login: u?.login || '' }))
              : null;
            return {
              ok: true, source: 'api',
              itemId:   String(item?.id || iid),
              title:    item?.title || '',
              price:    item?.price_numeric ?? (item?.price ? Number(item.price) : null),
              currency: item?.currency || 'EUR',
              likeCount: item?.favourite_count ?? item?.likes_count ?? null,
              sellerId:  String(item?.user?.id || item?.seller?.id || ''),
              favouriteMembers: members,
            };
          }
        } catch (_) {}

        // ── Intento 2: API del catálogo (endpoint alternativo) ──────────────
        // /api/v2/catalogue/items/{id} a veces está disponible
        try {
          const r2 = await fetch(`/api/v2/catalogue/items/${iid}`, {
            credentials: 'include', headers,
          });
          if (r2.ok) {
            const d2 = await r2.json();
            const item2 = d2?.item || d2;
            return {
              ok: true, source: 'catalogue_api',
              itemId:   String(item2?.id || iid),
              title:    item2?.title || '',
              price:    item2?.price_numeric ?? (item2?.price ? Number(item2.price) : null),
              currency: item2?.currency || 'EUR',
              likeCount: item2?.favourite_count ?? item2?.likes_count ?? null,
              sellerId:  String(item2?.user?.id || item2?.seller?.id || ''),
              favouriteMembers: null,
            };
          }
        } catch (_) {}

        // ── Intento 3: Scraping DOM (fallback para items propios) ────────────
        // Confirmado en escaneo en vivo (Abril 2026):
        //   Like count: [data-testid^="favourite-"]:not([data-testid*="--"]) → innerText
        //   Precio: [data-testid="item-price"] o [class*="ItemPage_price"]
        //   Título: h1 o [data-testid*="item-title"]
        try {
          // Esperar un poco más para hidratación de Next.js RSC
          await new Promise(r => setTimeout(r, 1500));

          // Like count
          const favEl = document.querySelector(
            '[data-testid^="favourite-"]:not([data-testid*="--"])'
          );
          const likesRaw = favEl ? parseInt(favEl.innerText.replace(/\D/g, '') || '0', 10) : 0;
          const likeCount = Number.isFinite(likesRaw) && likesRaw > 0 ? likesRaw : 0;

          // Precio — buscar en múltiples posibles selectores
          let price = null;
          const priceSelectors = [
            '[data-testid="item-price"]',
            '[data-testid*="price"]:not([data-testid*="shipping"])',
            '[class*="ItemPage_price"]',
            '[class*="item-price"]',
            'h1 + * [class*="price"]',
          ];
          for (const sel of priceSelectors) {
            const el = document.querySelector(sel);
            if (el) {
              const txt = el.innerText || el.textContent || '';
              const num = parseFloat(txt.replace(/[^\d,.]/g, '').replace(',', '.'));
              if (Number.isFinite(num) && num > 0) { price = num; break; }
            }
          }

          // Título
          const titleEl = document.querySelector(
            '[data-testid="item-title"], [data-testid*="item-title"], h1[class*="title"], h1'
          );
          const title = titleEl?.innerText?.trim() || '';

          return {
            ok: true, source: 'dom',
            itemId:   iid,
            title,
            price,
            currency: 'EUR',
            likeCount,
            sellerId:  '',
            favouriteMembers: null,
          };
        } catch (e) {
          return { ok: false, error: `dom_fallback_failed: ${e?.message || e}` };
        }
      },
      args: [itemId],
    });
    return res?.result || { ok: false, error: 'no_result' };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown' };
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

// ── Envía oferta / mensaje a un comprador potencial ───────────────────────────
async function sellerBotSendOffer({ itemId, buyerId, offerPrice, message }) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(`https://www.vinted.es/items/${itemId}`);
    await waitForTabLoad(tabId, 22000);
    await delay(2500);
    if (!await isTabScriptable(tabId)) return { ok: false, error: 'not_scriptable' };

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (params) => {
        const headers = {
          'Content-Type':     'application/json',
          Accept:             'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        };

        // 1. Intentar API de oferta de vendedor (Seller Initiated Offer)
        try {
          const sio = await fetch(`/api/v2/items/${params.itemId}/sell_offers`, {
            method: 'POST', credentials: 'include', headers,
            body: JSON.stringify({
              offer: { buyer_id: params.buyerId, price: params.offerPrice, message: params.message }
            }),
          });
          if (sio.ok) {
            const d = await sio.json();
            return { ok: true, method: 'sell_offer', conversationId: d?.conversation?.id };
          }
        } catch (_) {}

        // 2. Fallback: crear conversación con mensaje
        try {
          const conv = await fetch('/api/v2/conversations', {
            method: 'POST', credentials: 'include', headers,
            body: JSON.stringify({
              conversation: {
                to_user_id: params.buyerId,
                item_id:    params.itemId,
                body:       params.offerPrice
                  ? `${params.message}\n\n💰 Oferta especial: ${params.offerPrice}€`
                  : params.message,
              }
            }),
          });
          if (conv.ok) {
            const d = await conv.json();
            return { ok: true, method: 'conversation', conversationId: d?.conversation?.id };
          }
          const errBody = await conv.text().catch(() => '');
          return { ok: false, method: 'conversation', status: conv.status, body: errBody };
        } catch (e) { return { ok: false, method: 'conversation', error: String(e?.message || e) }; }
      },
      args: [{ itemId, buyerId, offerPrice, message }],
    });
    return res?.result || { ok: false, error: 'no_result' };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown' };
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

// ── Auto-acepta ofertas entrantes del comprador si >= minPrice ────────────────
async function sellerBotCheckAutoAccept(minPrice) {
  let tabId = null;
  try {
    tabId = await openHiddenTab('https://www.vinted.es/inbox');
    await waitForTabLoad(tabId, 25000);
    await delay(3000);
    if (!await isTabScriptable(tabId)) return { ok: false, error: 'not_scriptable' };

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (minPx) => {
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        try {
          // Confirmed working endpoint from live scan (April 2026):
          // /api/v2/my_orders returns { my_orders: [{conversation_id, transaction_id,
          //   price:{amount,currency_code}, status, transaction_user_status}] }
          // /api/v2/transactions → 404 in vinted.es
          const ordersResp = await fetch('/api/v2/my_orders?per_page=50', {
            credentials: 'include', headers
          });
          if (!ordersResp.ok) return { ok: false, error: `my_orders_${ordersResp.status}` };
          const ordersData = await ordersResp.json();
          const orders = ordersData?.my_orders || [];

          // Filter orders that are pending seller action (not yet completed/cancelled)
          const pending = orders.filter(o => {
            const s = String(o?.transaction_user_status || '').toLowerCase();
            return s !== 'completed' && s !== 'cancelled' && s !== 'refunded';
          });

          const accepted = [];
          for (const order of pending) {
            const offered = Number(order?.price?.amount ?? 0);
            const txId    = order?.transaction_id;
            if (!txId || offered < minPx) continue;

            // Try to accept via transaction endpoint
            const acceptResp = await fetch(`/api/v2/transactions/${txId}/accept_offer`, {
              method: 'POST', credentials: 'include',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            });
            if (acceptResp.ok) {
              accepted.push({ txId, price: offered });
            } else {
              // Fallback: try via conversation
              const convId = order?.conversation_id;
              if (convId) {
                const convResp = await fetch(`/api/v2/conversations/${convId}/accept_offer`, {
                  method: 'POST', credentials: 'include',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                });
                if (convResp.ok) accepted.push({ txId, convId, price: offered });
              }
            }
          }
          return { ok: true, accepted, checked: orders.length, pending: pending.length };
        } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      },
      args: [minPrice],
    });
    return res?.result || { ok: false, error: 'no_result' };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown' };
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

// ── Programa mensajes para los nuevos likers, intercalados en 1 hora ──────────
async function sellerBotScheduleOffers(config, state, newLikerIds) {
  const now       = Date.now();
  const HOUR_MS   = 60 * 60 * 1000;
  const maxOffers = config.maxOffersPerCycle || 10;
  const knownIds  = new Set(state.knownLikerIds || []);
  const scheduled = [...(state.scheduledMessages || [])];
  let added = 0;

  for (const userId of newLikerIds) {
    if (!userId || knownIds.has(userId)) continue;
    if (added >= maxOffers) break;

    // Intercalar: mínimo 3 min entre mensajes, distribuido aleatoriamente en 1h
    const slotStart = added * 3 * 60 * 1000;
    const slotEnd   = Math.max(slotStart + 60000, HOUR_MS);
    const jitter    = Math.floor(Math.random() * (slotEnd - slotStart));
    const sendAt    = new Date(now + slotStart + jitter).toISOString();

    scheduled.push({ userId, scheduledAt: sendAt, sent: false, sentAt: null, attempts: 0 });
    knownIds.add(userId);
    added++;
  }

  if (added > 0) {
    await patchSellerBotState({
      knownLikerIds:     Array.from(knownIds),
      scheduledMessages: scheduled,
    });
    console.log(`[SellerBot] ${added} mensajes programados intercalados en los próximos 60 min.`);
  }
}

// ── Envía los mensajes cuyo scheduledAt ya ha pasado ─────────────────────────
async function sellerBotProcessScheduled(config) {
  const state   = await getSellerBotState();
  const nowIso2 = new Date().toISOString();
  const due     = (state.scheduledMessages || []).filter(
    m => !m.sent && m.scheduledAt <= nowIso2 && (m.attempts || 0) < 3
  );
  if (due.length === 0) return;

  // Calcular precio de oferta si hay descuento configurado
  const baseInfo = config.discountPct > 0
    ? await sellerBotFetchItemInfo(config.itemId).catch(() => null)
    : null;
  const basePrice  = baseInfo?.price ?? null;
  const offerPrice = (basePrice && config.discountPct > 0)
    ? Math.round(basePrice * (1 - config.discountPct / 100) * 100) / 100
    : null;

  const updatedMessages = [...(state.scheduledMessages || [])];

  for (const msg of due) {
    const idx = updatedMessages.findIndex(m => m.userId === msg.userId && m.scheduledAt === msg.scheduledAt);
    if (idx === -1) continue;

    try {
      const result = await sellerBotSendOffer({
        itemId:     config.itemId,
        buyerId:    msg.userId,
        offerPrice: offerPrice,
        message:    config.messageTemplate,
      });

      updatedMessages[idx].attempts = (updatedMessages[idx].attempts || 0) + 1;
      if (result?.ok) {
        updatedMessages[idx].sent   = true;
        updatedMessages[idx].sentAt = new Date().toISOString();
        console.log(`[SellerBot] Oferta enviada a usuario ${msg.userId} (${result.method})`);
        const s = await getSellerBotState();
        await patchSellerBotState({ stats: { ...s.stats, sent: (s.stats?.sent || 0) + 1 } });
      } else {
        updatedMessages[idx].attempts = (updatedMessages[idx].attempts || 0) + 1;
        console.warn(`[SellerBot] Fallo al enviar a ${msg.userId}:`, result?.error || result?.status);
        const s = await getSellerBotState();
        await patchSellerBotState({ stats: { ...s.stats, errors: (s.stats?.errors || 0) + 1 } });
      }
    } catch (err) {
      updatedMessages[idx].attempts = (updatedMessages[idx].attempts || 0) + 1;
      console.error('[SellerBot] Error enviando:', err?.message);
    }

    // Pequeña pausa entre envíos consecutivos
    await delay(1500 + Math.floor(Math.random() * 2000));
  }

  await patchSellerBotState({ scheduledMessages: updatedMessages });
}

// ── Ciclo principal del seller bot ────────────────────────────────────────────
async function runSellerBotCycle() {
  const config = await getSellerBotConfig();
  if (!config.enabled || !config.itemId) return;

  console.log(`[SellerBot] Ciclo iniciado. Item: ${config.itemId}`);

  // 1. Obtener info del producto (like count + likers si disponible)
  //    Prioridad: API pública → API catálogo → DOM scraping (para items propios)
  const itemInfo = await sellerBotFetchItemInfo(config.itemId).catch(() => null);
  if (!itemInfo?.ok) {
    console.warn('[SellerBot] No se pudo obtener info del item:', itemInfo?.error);
    await patchSellerBotState({ lastCheckAt: new Date().toISOString() });
    // Auto-accept check aun si falla el fetch
    if (config.autoAccept && config.minAcceptPrice > 0) {
      await sellerBotCheckAutoAccept(config.minAcceptPrice).catch(() => {});
    }
    return;
  }

  console.log(`[SellerBot] Info obtenida via ${itemInfo.source || 'api'}. Likes: ${itemInfo.likeCount ?? '?'}`);

  const state            = await getSellerBotState();
  const likeCount        = itemInfo.likeCount ?? state.lastLikeCount ?? 0;
  const prevLikeCount    = state.lastLikeCount ?? 0;

  await patchSellerBotState({ lastCheckAt: new Date().toISOString(), lastLikeCount: likeCount });

  // 2. Si la API devuelve los likers individuales, programar mensajes a los nuevos
  if (config.autoMessage && Array.isArray(itemInfo.favouriteMembers) && itemInfo.favouriteMembers.length > 0) {
    const knownIds  = new Set(state.knownLikerIds || []);
    const newLikers = itemInfo.favouriteMembers
      .map(u => String(u?.id || u))
      .filter(id => id && !knownIds.has(id));

    if (newLikers.length > 0 && likeCount >= (config.triggerLikes || 1)) {
      console.log(`[SellerBot] ${newLikers.length} nuevos likers detectados. Programando mensajes...`);
      await sellerBotScheduleOffers(config, await getSellerBotState(), newLikers);
    }
  } else if (config.autoMessage && likeCount > prevLikeCount && likeCount >= (config.triggerLikes || 1)) {
    // Sin IDs individuales (DOM fallback o API sin favourite_members) — registramos incremento
    const delta = likeCount - prevLikeCount;
    console.log(`[SellerBot] +${delta} nuevo(s) like(s) detectado(s) (${prevLikeCount} → ${likeCount}). Fuente: ${itemInfo.source}. Sin IDs individuales.`);
  }

  // 3. Enviar mensajes programados cuya hora ya llegó
  if (config.autoMessage) {
    await sellerBotProcessScheduled(config).catch(e => console.warn('[SellerBot] Error procesando programados:', e?.message));
  }

  // 4. Auto-aceptar ofertas entrantes
  if (config.autoAccept && config.minAcceptPrice > 0) {
    const acceptResult = await sellerBotCheckAutoAccept(config.minAcceptPrice).catch(() => null);
    if (acceptResult?.ok && acceptResult.accepted?.length > 0) {
      console.log(`[SellerBot] Auto-aceptadas ${acceptResult.accepted.length} ofertas >=€${config.minAcceptPrice}.`);
      const s = await getSellerBotState();
      await patchSellerBotState({ stats: { ...s.stats, accepted: (s.stats?.accepted || 0) + acceptResult.accepted.length } });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// VACATION MODE — Modo Vacaciones Vinted
// ══════════════════════════════════════════════════════════════════════════════

// Confirmed via live DOM scan: vacation toggle lives at /settings/account
const VACATION_URL          = 'https://www.vinted.es/settings/account';
const VACATION_CHECK_ALARM  = 'vinted-vacation-check';
const VACATION_STORAGE_KEY  = 'vacationModeState';
const VACATION_CHECK_MIN    = 10;

function isVacationHour() {
  const h = new Date().getHours();
  return h >= 23 || h < 7;
}

async function _vacationStorage() {
  try {
    const s = await chrome.storage.local.get(VACATION_STORAGE_KEY);
    return s?.[VACATION_STORAGE_KEY] || { scheduleEnabled: false, currentState: null, lastCheck: null, lastApplied: null };
  } catch (_) { return { scheduleEnabled: false, currentState: null, lastCheck: null, lastApplied: null }; }
}

async function _saveVacation(patch) {
  const cur = await _vacationStorage();
  await chrome.storage.local.set({ [VACATION_STORAGE_KEY]: { ...cur, ...patch } });
}

// ── Vacation API helpers (injected into Vinted page with user session) ────────
//
// Confirmed via live scan (2026-04):
//   GET  /api/v2/users/current  →  { user: { id, is_on_holiday, holiday_end_date, … } }
//   PUT  /api/v2/users/{id}     →  { user: { is_on_holiday: bool } }
//   DOM fallback: h2#holiday-mode-toggle → parentElement×4
//                 → div.web_ui__Cell__cell.web_ui__Cell__wide → querySelector(button/input)

async function getVacationStatus() {
  let tabId = null;
  try {
    tabId = await openHiddenTab(VACATION_URL);
    await waitForTabLoad(tabId, 22000);
    await delay(2000);
    if (!await isTabScriptable(tabId)) return { ok: false, error: 'not_scriptable' };

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        try {
          const resp = await fetch('/api/v2/users/current', {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          });
          if (!resp.ok) return { ok: false, error: `api_${resp.status}` };
          const data  = await resp.json();
          const user  = data?.user || data;
          return {
            ok:             true,
            found:          true,
            isOn:           user?.is_on_holiday === true,
            userId:         user?.id ?? null,
            holidayEndDate: user?.holiday_end_date ?? null,
          };
        } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      },
    });
    const result = res?.result;
    if (result?.ok) {
      await _saveVacation({ currentState: result.isOn, lastCheck: new Date().toISOString() });
    }
    return result || { ok: false, error: 'no_result' };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown' };
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

async function applyVacationMode(enable) {
  let tabId = null;
  try {
    tabId = await openHiddenTab(VACATION_URL);
    await waitForTabLoad(tabId, 25000);
    await delay(2500);
    if (!await isTabScriptable(tabId)) return { ok: false, error: 'not_scriptable' };

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (shouldEnable) => {
        const headers = {
          Accept:             'application/json',
          'Content-Type':     'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        };

        try {
          // ── 1. Get current user id + holiday state ──────────────────────────
          const userResp = await fetch('/api/v2/users/current', {
            credentials: 'include', headers,
          });
          if (!userResp.ok) return { ok: false, error: `get_user_${userResp.status}` };
          const userData    = await userResp.json();
          const user        = userData?.user || userData;
          const userId      = user?.id;
          if (!userId) return { ok: false, error: 'no_user_id' };

          const currentState = user?.is_on_holiday === true;
          if (currentState === shouldEnable) {
            return { ok: true, changed: false, state: currentState };
          }

          // ── 2. PUT to update vacation mode ──────────────────────────────────
          const putResp = await fetch(`/api/v2/users/${userId}`, {
            method: 'PUT', credentials: 'include', headers,
            body: JSON.stringify({ user: { is_on_holiday: shouldEnable } }),
          });
          if (putResp.ok) {
            return { ok: true, changed: true, state: shouldEnable, method: 'PUT', status: putResp.status };
          }

          // ── 3. PATCH fallback ───────────────────────────────────────────────
          const patchResp = await fetch(`/api/v2/users/${userId}`, {
            method: 'PATCH', credentials: 'include', headers,
            body: JSON.stringify({ user: { is_on_holiday: shouldEnable } }),
          });
          if (patchResp.ok) {
            return { ok: true, changed: true, state: shouldEnable, method: 'PATCH', status: patchResp.status };
          }

          // ── 4. DOM fallback — confirmed structure from live scan ────────────
          // h2#holiday-mode-toggle → up 4 levels → div.web_ui__Cell__cell → button
          const h2 = document.querySelector('#holiday-mode-toggle');
          if (h2) {
            let node = h2;
            for (let i = 0; i < 4; i++) { node = node?.parentElement; }
            const btn = node?.querySelector('button, input, [role="switch"], [role="button"]');
            if (btn) {
              btn.click();
              await new Promise(r => setTimeout(r, 800));
              return { ok: true, changed: true, state: shouldEnable, method: 'dom_click' };
            }
          }

          return {
            ok: false,
            error: `put_${putResp.status}_patch_${patchResp.status}_dom_not_found`,
          };
        } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      },
      args: [enable],
    });

    const data = res?.result;
    if (data?.ok) {
      await delay(1500);
      await _saveVacation({
        currentState: enable,
        lastApplied:  { state: enable, at: new Date().toISOString() },
        lastCheck:    new Date().toISOString(),
      });
    }
    return data || { ok: false, error: 'no_result' };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown' };
  } finally {
    if (tabId !== null) await closeTabQuiet(tabId);
  }
}

async function ensureVacationAlarm(enabled) {
  if (enabled) {
    const ex = await chrome.alarms.get(VACATION_CHECK_ALARM).catch(() => null);
    if (!ex) chrome.alarms.create(VACATION_CHECK_ALARM, { periodInMinutes: VACATION_CHECK_MIN });
  } else {
    await chrome.alarms.clear(VACATION_CHECK_ALARM).catch(() => {});
  }
}

async function runVacationScheduleCheck() {
  const vs = await _vacationStorage();
  if (!vs.scheduleEnabled) return;
  const desired = isVacationHour();
  if (vs.currentState === desired) return;
  console.log(`[Vacation] Aplicando modo vacaciones: ${desired ? 'ON' : 'OFF'}`);
  await applyVacationMode(desired).catch(e => console.warn('[Vacation] Error:', e?.message));
}

// ══════════════════════════════════════════════════════════════════════════════

chrome.action.onClicked.addListener(async () => {
  await openDashboardTab();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // ── HYPE: siguiente tarea programada ─────────────────────────────────────
  if (alarm.name === EXT_MONITOR_TASK_ALARM) {
    extMonitorRunWorker().catch(() => {});
    return;
  }
  // ── Seller Bot ────────────────────────────────────────────────────────────
  if (alarm.name === SELLER_BOT_ALARM) {
    runSellerBotCycle().catch(e => console.error('[SellerBot] Error en ciclo:', e?.message));
    return;
  }
  // ── Modo Vacaciones ───────────────────────────────────────────────────────
  if (alarm.name === VACATION_CHECK_ALARM) {
    await runVacationScheduleCheck().catch(() => {});
    return;
  }
  // ── Revalidación periódica de licencia ────────────────────────────────────
  if (alarm.name === LICENSE_ALARM_NAME) {
    await checkLicense({ force: true }).catch(() => {});
    return;
  }

  // ── Marketplace 12h deep analysis ────────────────────────────────────────
  if (alarm.name.startsWith(MKT_ALARM_PREFIX)) {
    const analysisId = alarm.name.slice(MKT_ALARM_PREFIX.length);
    try {
      await runMarketplaceScanCycle(analysisId);
    } catch (err) {
      console.error('[Marketplace] Alarm scan error:', err);
    }
    return;
  }

  // ── Existing product monitor alarms ──────────────────────────────────────
  const config = await getConfig();
  if (!config.monitorEnabled) return;
  if (
    alarm.name !== CYCLE_ALARM &&
    alarm.name !== DETECT_ALARM &&
    alarm.name !== TRACK_ALARM
  ) {
    return;
  }
  // ── Verificación de licencia antes de ejecutar el worker ─────────────────
  if (LICENSE_ACTIVE) {
    const lic = await checkLicense().catch(() => ({ allowed: false }));
    if (!lic.allowed) {
      console.warn('[LamineResell] Worker bloqueado — licencia inválida o expirada.');
      return;
    }
  }
  await runScheduledAlternatingCycle();
});

// ===== Ext Monitor (HYPE) =====

function extractItemIdFromUrl(url) {
  const match = String(url || '').match(/\/items\/(\d+)/);
  return match?.[1] || '';
}

async function getExtMonitorData() {
  const raw = await chrome.storage.local.get(EXT_MONITOR_KEY);
  const loaded = raw?.[EXT_MONITOR_KEY] || {};
  return {
    requests: Array.isArray(loaded.requests) ? loaded.requests : [],
    tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
  };
}

async function setExtMonitorData(data) {
  await chrome.storage.local.set({ [EXT_MONITOR_KEY]: data });
}

function updateRequestTaskCounts(data, requestId) {
  const req = (data.requests || []).find((r) => r.id === requestId);
  if (!req) return;
  const reqTasks = (data.tasks || []).filter((t) => t.requestId === requestId);
  req.tasks = {
    pending: reqTasks.filter((t) => t.state === 'queued').length,
    inProgress: reqTasks.filter((t) => t.state === 'in_progress').length,
    completed: reqTasks.filter((t) => ['completed', 'skipped'].includes(t.state)).length,
    failed: reqTasks.filter((t) => t.state === 'failed').length,
  };
}

function makeExtMonitorId(prefix) {
  const rand = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

async function extMonitorGetOverview() {
  const [config, data, runtime] = await Promise.all([getConfig(), getExtMonitorData(), getRuntimeState()]);
  const session = normalizeVintedSession(config.vintedSession);
  const worker = { ...defaultRuntimeState().extMonitorWorker, ...(runtime.extMonitorWorker || {}) };
  const tasks = data.tasks || [];
  const inProgressCount = tasks.filter((t) => t.state === 'in_progress').length;
  const workerOnline = worker.running === true;
  const memberDisplay = session.username
    ? `@${session.username}`
    : session.memberId
      ? `ID: ${session.memberId}`
      : '';
  return {
    ok: true,
    account: { email: memberDisplay },
    license: { status: 'active', reason: 'local_worker', message: 'Modulo activo' },
    summary: {
      totalRequests: data.requests.length,
      ownWorkersOnline: workerOnline ? 1 : 0,
      networkWorkersOnline: workerOnline ? 1 : 0,
      inProgressTasks: inProgressCount,
    },
    incomingTasks: tasks.map((t) => ({
      ...t,
      claimedByThisInstall: t.claimedByInstallId === 'local',
    })),
    requests: data.requests,
    workers: [
      {
        browserId: 'local',
        memberId: worker.memberId || session.memberId || '',
        online: workerOnline,
        status: workerOnline ? 'online' : 'offline',
        lastSeenAt: worker.lastAttemptAt || null,
      },
    ],
  };
}

async function extMonitorCreateRequests(urls, scope = 'public') {
  const data = await getExtMonitorData();
  const existingItemIds = new Set((data.requests || []).map((r) => r.itemId));
  let created = 0;
  let duplicated = 0;
  let errors = 0;

  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim();
    if (!url) { errors += 1; continue; }
    if (!url.includes('vinted.es/items/')) { errors += 1; continue; }
    const itemId = extractItemIdFromUrl(url);
    if (!itemId) { errors += 1; continue; }
    if (existingItemIds.has(itemId)) { duplicated += 1; continue; }

    const requestId = makeExtMonitorId('req');
    const taskId = makeExtMonitorId('task');
    const now = nowIso();

    data.requests.push({
      id: requestId,
      itemId,
      productUrl: url,
      title: '',
      scope: String(scope || 'public'),
      createdAt: now,
      tasks: { pending: 1, inProgress: 0, completed: 0, failed: 0 },
    });
    data.tasks.push({
      id: taskId,
      requestId,
      itemId,
      productUrl: url,
      title: '',
      scope: String(scope || 'public'),
      state: 'queued',
      claimedByInstallId: null,
      claimedByThisInstall: false,
      sourceEmail: '',
      detectedAt: now,
      startedAt: null,
      updatedAt: now,
      outcome: null,
      reason: null,
    });

    existingItemIds.add(itemId);
    created += 1;
  }

  await setExtMonitorData(data);
  return { ok: true, requests: data.requests, created, duplicated, errors };
}

// Alarm name used to schedule the next HYPE task (replaces the in-process delay
// which was killing the MV3 service worker after 30 s).
const EXT_MONITOR_TASK_ALARM = 'ext-monitor-next-task';

// Random delay between consecutive tasks (ms).  Keeps Vinted from seeing
// bot-like bursts — randomised between 45 s and 90 s.
function extMonitorInterTaskDelay() {
  return 45000 + Math.floor(Math.random() * 45000);
}

async function extMonitorRunWorker() {
  // Guard: bail out if the worker is already marked as running (another
  // call is in-flight).  This prevents overlapping runs when the message
  // handler is called concurrently or the alarm fires while a run is active.
  const runtime = await getRuntimeState();
  if (runtime.extMonitorWorker?.running === true) {
    console.log('[ExtMonitor] Worker already running — skipping duplicate trigger');
    return { ok: true, reason: 'already_running' };
  }

  // MV3 FIX: process ONE task per call, then schedule the next via alarm.
  // The old while+delay loop was killing the service worker (30s idle timeout).
  const data = await getExtMonitorData();
  const pending = (data.tasks || []).find((t) => t.state === 'queued');

  if (!pending) {
    await setExtMonitorWorkerRuntime({
      running: false,
      lastOutcome: 'no_tasks',
      lastReason: 'no_pending_tasks',
      lastCompletedAt: nowIso(),
    });
    return { ok: true, reason: 'no_pending_tasks', processed: 0 };
  }

  // Claim the task
  const now = nowIso();
  pending.state              = 'in_progress';
  pending.claimedByInstallId = 'local';
  pending.claimedByThisInstall = true;
  pending.startedAt          = now;
  pending.updatedAt          = now;
  updateRequestTaskCounts(data, pending.requestId);
  await setExtMonitorData(data);

  await setExtMonitorWorkerRuntime({
    running:       true,
    lastTrigger:   now,
    lastAttemptAt: now,
  });

  try {
    const result = await executeClaimedExtensionMonitorTask({
      itemId:  pending.itemId,
      product: { url: pending.productUrl },
    });

    const outcome = result?.outcome || 'failed';
    const reason  = String(result?.reason || 'unknown').trim() || 'unknown';
    const meta    = result?.meta || {};          // { imageUrl, title, price } from og tags

    pending.state     = outcome === 'success' ? 'completed' : outcome === 'skipped' ? 'skipped' : 'failed';
    pending.outcome   = outcome;
    pending.reason    = reason;
    pending.updatedAt = nowIso();
    // Persist thumbnail + title scraped from the product page
    if (meta.imageUrl) pending.imageUrl = meta.imageUrl;
    if (meta.title)    pending.title    = meta.title;
    if (meta.price)    pending.price    = meta.price;
    // Mirror to the parent request for display in the requests table
    const parentReq = (data.requests || []).find(r => r.id === pending.requestId);
    if (parentReq) {
      if (meta.imageUrl && !parentReq.imageUrl) parentReq.imageUrl = meta.imageUrl;
      if (meta.title    && !parentReq.title)    parentReq.title    = meta.title;
      if (meta.price    && !parentReq.price)    parentReq.price    = meta.price;
    }
    updateRequestTaskCounts(data, pending.requestId);
    await setExtMonitorData(data);

    await setExtMonitorWorkerRuntime({
      running:         false,
      lastCompletedAt: nowIso(),
      lastOutcome:     outcome,
      lastReason:      reason,
      lastTaskId:      pending.id,
      lastTaskOutcome: outcome,
    });

    // Schedule the next task via alarm instead of a long await delay.
    // The alarm wakes the service worker fresh — no idle-timeout risk.
    const nextData = await getExtMonitorData();
    const hasMore  = (nextData.tasks || []).some((t) => t.state === 'queued');
    if (hasMore) {
      const delayMs  = extMonitorInterTaskDelay();
      const delayMin = delayMs / 60000;
      console.log(`[ExtMonitor] Tarea completada (${reason}). Próxima en ~${Math.round(delayMin * 60)}s via alarma.`);
      await chrome.alarms.clear(EXT_MONITOR_TASK_ALARM).catch(() => {});
      chrome.alarms.create(EXT_MONITOR_TASK_ALARM, { delayInMinutes: delayMin });
    }

    return { ok: true, reason, processed: 1 };

  } catch (err) {
    const errMsg = String(err?.message || 'execution_error');
    pending.state     = 'failed';
    pending.outcome   = 'failed';
    pending.reason    = errMsg;
    pending.updatedAt = nowIso();
    updateRequestTaskCounts(data, pending.requestId);
    await setExtMonitorData(data);

    await setExtMonitorWorkerRuntime({
      running:         false,
      lastCompletedAt: nowIso(),
      lastOutcome:     'failed',
      lastReason:      errMsg,
      lastError:       errMsg,
    });

    return { ok: false, reason: errMsg, processed: 1 };
  }
}

// ===== Message listener =====

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      const action = message?.action;

      // ── Modo Vacaciones ────────────────────────────────────────────────────
      if (action === 'rb:vacation-status') {
        const stored = await _vacationStorage();
        const live   = await getVacationStatus();
        sendResponse({ success: true, ...live, scheduleEnabled: stored.scheduleEnabled, lastApplied: stored.lastApplied });
        return;
      }
      if (action === 'rb:vacation-apply') {
        const result = await applyVacationMode(message.enable === true);
        sendResponse({ success: result.ok, ...result });
        return;
      }
      if (action === 'rb:vacation-schedule') {
        const enabled = message.enabled === true;
        await _saveVacation({ scheduleEnabled: enabled });
        await ensureVacationAlarm(enabled);
        if (enabled) await runVacationScheduleCheck().catch(() => {});
        sendResponse({ success: true, scheduleEnabled: enabled });
        return;
      }

      // ── Gestión de autenticación (sin licencia requerida) ──────────────────
      if (action === 'rb:auth-login') {
        // La UI ya guardó el token en chrome.storage.local; solo invalidamos caché.
        invalidateLicenseCache();
        const lic = await checkLicense({ force: true });
        sendResponse({ success: true, license: lic });
        return;
      }
      if (action === 'rb:auth-login-success') {
        invalidateLicenseCache();
        sendResponse({ success: true });
        return;
      }
      if (action === 'rb:auth-logout') {
        await chrome.storage.local.remove([AUTH_STORAGE_TOKEN, 'lamine_auth_email', 'lamine_auth_role']);
        invalidateLicenseCache();
        sendResponse({ success: true });
        return;
      }
      if (action === 'rb:auth-status') {
        // Si el sistema de licencias está desactivado, siempre devolver acceso completo
        if (!LICENSE_ACTIVE) {
          sendResponse({ success: true, loggedIn: true, license: { allowed: true, status: 'dev_mode', message: '' } });
          return;
        }
        const token = await getLicenseToken();
        if (!token) {
          sendResponse({ success: true, loggedIn: false, license: { allowed: false, status: 'no_token' } });
          return;
        }
        const lic = await checkLicense({ force: false });
        sendResponse({ success: true, loggedIn: true, license: lic });
        return;
      }

      // ── Verificación de licencia para todas las demás acciones ────────────
      if (!LICENSE_EXEMPT_ACTIONS.has(action)) {
        const lic = await checkLicense();
        if (!lic.allowed) {
          sendResponse({
            success: false,
            licenseBlocked: true,
            license: lic,
            error: lic.message || 'Licencia inválida o inactiva.',
          });
          return;
        }

        // Acciones críticas: el backend decide explícitamente
        if (CRITICAL_ACTIONS.has(action)) {
          const validation = await validateCriticalAction(action);
          if (!validation.allowed) {
            sendResponse({
              success: false,
              licenseBlocked: true,
              error: validation.reason || 'Acción no autorizada por el servidor.',
            });
            return;
          }
        }
      }

      // ── Acciones normales ──────────────────────────────────────────────────
      if (message?.action === 'rb:get-state') {
        void refreshVintedSessionInfo({ force: false }).catch(() => {});
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
      if (message?.action === 'rb:refresh-vinted-session') {
        const result = await refreshVintedSessionInfo({ force: true });
        sendResponse({ success: true, result, config: result?.config || (await getConfig()) });
        return;
      }
      if (message?.action === 'rb:open-actions-module') {
        await openActionsTab();
        sendResponse({ success: true });
        return;
      }
      if (message?.action === 'rb:open-marketplace-module') {
        await openMarketplaceTab();
        sendResponse({ success: true });
        return;
      }
      if (message?.action === 'rb:open-cuenta-vinted-module') {
        await openCuentaVintedTab();
        sendResponse({ success: true });
        return;
      }
      if (message?.action === 'rb:marketplace-analytics') {
        const query = String(message.query || '').trim();
        if (!query) {
          sendResponse({ success: false, error: 'Query vacío' });
          return;
        }
        try {
          const data = await runMarketplaceAnalytics(query);
          sendResponse({ success: true, data });
        } catch (err) {
          sendResponse({ success: false, error: err?.message || 'Error en análisis' });
        }
        return;
      }
      if (message?.action === 'rb:marketplace-start-analysis') {
        const query = String(message.query || '').trim();
        if (!query) {
          sendResponse({ success: false, error: 'Query vacío' });
          return;
        }
        try {
          const analysis = await startMarketplaceAnalysis(query);
          sendResponse({ success: true, analysis });
        } catch (err) {
          sendResponse({ success: false, error: err?.message || 'Error iniciando análisis' });
        }
        return;
      }
      if (message?.action === 'rb:marketplace-get-analysis') {
        try {
          const analysis = await getMktAnalysis();
          sendResponse({ success: true, analysis });
        } catch (err) {
          sendResponse({ success: false, error: err?.message || 'Error' });
        }
        return;
      }
      if (message?.action === 'rb:marketplace-stop-analysis') {
        try {
          const analysis = await getMktAnalysis();
          if (analysis?.id) {
            analysis.status = 'stopped';
            analysis.results = computeMarketplaceResults(analysis);
            await saveMktAnalysis(analysis);
            try { await chrome.alarms.clear(`${MKT_ALARM_PREFIX}${analysis.id}`); } catch (_) {}
          }
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err?.message || 'Error' });
        }
        return;
      }
      if (message?.action === 'rb:marketplace-scan-now') {
        // Trigger an immediate scan of the current running analysis
        try {
          const analysis = await getMktAnalysis();
          if (analysis?.id && analysis.status === 'running') {
            runMarketplaceScanCycle(analysis.id).catch((e) => console.error('[Marketplace] Manual scan error:', e));
            sendResponse({ success: true, message: 'Escaneo iniciado' });
          } else {
            sendResponse({ success: false, error: 'No hay análisis en curso' });
          }
        } catch (err) {
          sendResponse({ success: false, error: err?.message || 'Error' });
        }
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
        const next = await setConfig({
          searchUrls,
          detectPeriodMinutes: 5,
        });
        await ensureAlarms();
        sendResponse({ success: true, config: next });
        return;
      }
      if (message?.action === 'rb:ext-monitor-overview') {
        sendResponse({ success: true, result: await extMonitorGetOverview() });
        return;
      }
      if (message?.action === 'rb:ext-monitor-worker-status') {
        sendResponse({ success: true, result: await getExtensionMonitorWorkerStatus() });
        return;
      }
      if (message?.action === 'rb:ext-monitor-run-worker') {
        extMonitorRunWorker().catch(() => {});
        sendResponse({ success: true, result: { ok: true, reason: 'worker_triggered' } });
        return;
      }
      if (message?.action === 'rb:ext-monitor-create-requests') {
        const urls = Array.isArray(message?.urls) ? message.urls : [];
        const scope = String(message?.scope || 'public');
        sendResponse({ success: true, result: await extMonitorCreateRequests(urls, scope) });
        return;
      }

      // ── Seller Bot ─────────────────────────────────────────────────────────
      if (action === 'rb:seller-bot-get') {
        const [cfg, st] = await Promise.all([getSellerBotConfig(), getSellerBotState()]);
        sendResponse({ success: true, config: cfg, state: st });
        return;
      }
      if (action === 'rb:seller-bot-set') {
        const patch = message?.config && typeof message.config === 'object' ? message.config : {};
        const next = await setSellerBotConfig(patch);
        // Sync alarm state with enabled flag
        await ensureSellerBotAlarm(next.enabled);
        if (next.enabled) {
          runSellerBotCycle().catch(e => console.warn('[SellerBot]', e?.message));
        }
        sendResponse({ success: true, config: next });
        return;
      }
      if (action === 'rb:seller-bot-run') {
        runSellerBotCycle().catch(() => {});
        sendResponse({ success: true });
        return;
      }
      if (action === 'rb:seller-bot-reset-state') {
        await chrome.storage.local.set({ [SELLER_BOT_STATE_KEY]: { ...DEFAULT_SELLER_BOT_STATE } });
        sendResponse({ success: true });
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

/**
 * extractCatalogUrlsFromPage — lightweight catalog scraper.
 * Only returns { itemId, url } pairs — no price/size/seller.
 * Used for the sold catalog where real data must come from individual pages.
 */
function extractCatalogUrlsFromPage() {
  const seen = new Set();
  const out  = [];
  for (const a of Array.from(document.querySelectorAll('a[href*="/items/"]'))) {
    const href    = a.getAttribute('href') || '';
    const idMatch = href.match(/\/items\/(\d+)/);
    if (!idMatch) continue;
    const itemId = idMatch[1];
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({
      itemId,
      url: href.startsWith('http') ? href : `https://www.vinted.es${href}`,
    });
  }
  return out;
}


/**
 * extractSoldItemDetail — injected into individual Vinted product pages.
 *
 * Uses the same proven extraction patterns as extractItemMetricsFromPage:
 *  - JSON-LD structured data for seller (most reliable)
 *  - DOM <a href="/member/…"> + [data-testid="profile-username"] as fallback
 *  - Body text search for sold confirmation ("vendido / sold / agotado")
 *  - Line-by-line body text for size, brand, condition (robust to DOM changes)
 *
 * Returns null-safe fields + isSold boolean so caller can reject non-sold pages.
 */
function extractSoldItemDetail() {
  const rawText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();

  // ── 1. Sold status — MUST be confirmed before trusting this page ───────────
  const isSold = /(vendido|sold|ya\s+se\s+ha\s+vendido|agotado|item\s+sold)/i.test(rawText);

  // ── 2. Seller — JSON-LD first (structured, reliable) ─────────────────────
  let sellerName = null;
  let sellerId   = null;

  const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  outer: for (const script of ldScripts) {
    let parsed;
    try { parsed = JSON.parse(script.textContent || ''); } catch (_) { continue; }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const s = node.seller;
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        if (typeof s.name === 'string' && s.name.trim()) {
          sellerName = s.name.trim();
          // Extract seller ID from seller URL e.g. "https://www.vinted.es/member/73350976-..."
          const urlStr = String(s.url || s['@id'] || '');
          const idMatch = urlStr.match(/\/member\/(\d+)/);
          if (idMatch) sellerId = idMatch[1];
          break outer;
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') queue.push(v);
      }
    }
  }

  // ── 3. Seller — DOM fallback (mirrors extractSellerFromDom in dashboard) ──
  // Strategy: scan all anchors, skip item-page links, find a /member/ href.
  // Capture seller name from the span[data-testid="profile-username"] first
  // (when present) and fall back to the anchor's full textContent — the
  // same approach the dashboard uses successfully in production.
  if (!sellerName) {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const memberAnchor = anchors.find((a) => {
      const href = (a.getAttribute('href') || '').trim();
      if (!href) return false;
      if (/\/items\/\d+/i.test(href)) return false;              // skip product links
      return /\/member\/\d+/i.test(href) || /user_id=\d+/i.test(href);
    });
    if (memberAnchor) {
      const href = memberAnchor.getAttribute('href') || '';
      const m    = href.match(/\/member\/(\d+)/);
      if (m) sellerId = m[1];
      // Prefer the username span; fall back to anchor's full text content
      sellerName =
        memberAnchor.querySelector('[data-testid="profile-username"]')?.textContent?.trim() ||
        document.querySelector('[data-testid="profile-username"]')?.textContent?.trim()   ||
        memberAnchor.textContent?.trim() ||
        null;
      // Strip stale whitespace / embedded newlines from anchor text
      if (sellerName) sellerName = sellerName.replace(/\s+/g, ' ').trim();
    }
  }

  // ── 4. Price ──────────────────────────────────────────────────────────────
  const priceEl = (
    document.querySelector('[data-testid="item-price-title"]') ||
    document.querySelector('[itemprop="price"]') ||
    document.querySelector('[class*="ItemPrice"]') ||
    document.querySelector('[class*="item-price"]')
  );
  const priceText  = priceEl?.textContent?.trim() || null;
  const priceMatch = (priceText || rawText).match(/(\d+[\.,]\d{2})\s*€|(\d+)\s*€/);
  const _rawPrice  = priceMatch ? parseFloat((priceMatch[1] || priceMatch[2]).replace(',', '.')) : NaN;
  const price      = (Number.isFinite(_rawPrice) && _rawPrice > 0) ? _rawPrice : null;

  // ── 5. Title ──────────────────────────────────────────────────────────────
  const titleEl = (
    document.querySelector('[data-testid="item-title"]') ||
    document.querySelector('[itemprop="name"]') ||
    document.querySelector('h1')
  );
  const title = titleEl?.textContent?.trim() || document.title || null;

  // ── 6. Details via line-by-line body text (robust to DOM restructuring) ───
  // Vinted renders details as pairs of lines: label line then value line.
  // e.g. "Talla\nM\nEstado\nMuy buen estado\nMarca\nNike"
  const bodyLines = String(document.body?.innerText || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  function extractByLabel(labels) {
    for (let i = 0; i < bodyLines.length - 1; i++) {
      const norm = bodyLines[i].toLowerCase().replace(/[^a-z]/g, '');
      if (labels.some((lbl) => norm === lbl)) {
        const next = bodyLines[i + 1];
        if (next && next.length <= 60) return next;
      }
    }
    return null;
  }

  const size      = extractByLabel(['talla', 'size', 'taille', 'taglia']) || null;
  const brand     = extractByLabel(['marca', 'brand', 'marque', 'marchio']) || null;
  const condition = extractByLabel(['estado', 'condition', 'etat', 'stato']) || null;

  return { isSold, sellerName, sellerId, priceText, price, size, title, brand, condition };
}


/**
 * extractMarketplaceItemsFromPage — enhanced catalog scraper.
 * Returns: { itemId, url, title, priceText, price, size, seller, sellerId }
 * Injected into hidden Vinted tabs via chrome.scripting.executeScript.
 */
function extractMarketplaceItemsFromPage() {
  function slugToTitle(slug) {
    return decodeURIComponent(slug)
      .split('-').filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function parsePrice(text) {
    const m = (text || '').match(/(\d+[\.,]?\d*)/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }

  // Normalize size tokens (XS/S/M/L/XL/XXL and numeric EU sizes)
  function extractSize(domText, fallbackText) {
    const SIZE_RE = /\b(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b|(?<!\d)(3[0-9]|4[0-9]|5[0-9]|6[0-9])(?!\d)/i;
    for (const src of [domText, fallbackText]) {
      const m = (src || '').match(SIZE_RE);
      if (m) return m[0].toUpperCase();
    }
    // "one size / talla única"
    if (/one\s*size|talla\s*[úu]nica/i.test(domText + fallbackText)) return 'One Size';
    return null;
  }

  function extractSeller(card) {
    for (const a of Array.from(card.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') || '';
      // /member/12345-username  or  /profile/12345-username
      const m = href.match(/\/(?:member|profile)\/(\d+)-([^/?#\s]+)/);
      if (m) return { sellerId: m[1], seller: m[2] };
      // /u/username
      const m2 = href.match(/\/u\/([^/?#\s]+)/);
      if (m2) return { sellerId: null, seller: m2[1] };
    }
    return { sellerId: null, seller: null };
  }

  const out = [];
  const seen = new Set();

  const cards = Array.from(document.querySelectorAll(
    '.feed-grid__item, [data-testid*="feed-grid-item"], [data-testid*="catalog-item"], [class*="feed-grid__item"], [class*="catalog-item"]'
  ));

  for (const card of cards) {
    const a = card.querySelector('a[href*="/items/"]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const idMatch = href.match(/\/items\/(\d+)/);
    if (!idMatch) continue;

    const itemId = idMatch[1];
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const fullUrl = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
    const slugMatch = href.match(/\/items\/\d+-([^/?#]+)/);
    const cardText = (card.innerText || '').slice(0, 600);

    const titleEl = card.querySelector('[data-testid*="description"], [data-testid*="title"], h2, h3');
    const title = titleEl?.textContent?.trim()
      || a.getAttribute('aria-label')
      || (slugMatch ? slugToTitle(slugMatch[1]) : `Item ${itemId}`);

    const priceEl = card.querySelector('[data-testid*="price"], [class*="price"]');
    const priceText = priceEl?.textContent?.trim() || null;
    const price = parsePrice(priceText || cardText);

    const sizeEl = card.querySelector('[data-testid*="size"], [class*="size"], [class*="body_text"], [class*="details"]');
    const sizeText = sizeEl?.textContent?.trim() || '';
    const size = extractSize(sizeText, cardText);

    const { sellerId, seller } = extractSeller(card);

    out.push({ itemId, url: fullUrl, title, priceText, price, size, seller, sellerId });
  }

  // Fallback: anchor scan (catches pages that restructured the grid)
  if (out.length === 0) {
    for (const a of Array.from(document.querySelectorAll('a[href*="/items/"]'))) {
      const href = a.getAttribute('href') || '';
      const idMatch = href.match(/\/items\/(\d+)/);
      if (!idMatch) continue;
      const itemId = idMatch[1];
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      const fullUrl = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
      const slugMatch = href.match(/\/items\/\d+-([^/?#]+)/);
      const title = slugMatch ? slugToTitle(slugMatch[1]) : `Item ${itemId}`;
      out.push({ itemId, url: fullUrl, title, priceText: null, price: null, size: null, seller: null, sellerId: null });
    }
  }

  return out;
}


function extractCatalogItemsFromPage() {
  // ── Helpers ───────────────────────────────────────────────────────────────
  function slugToTitle(slug) {
    return decodeURIComponent(slug).split('-').filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  function pickPriceFromText(text) {
    const m = (text || '').match(/(\d+[\.,]?\d*)\s*€/);
    return m ? `${m[1].replace(',', '.')}€` : null;
  }

  // ── Estrategia principal: API REST de Vinted ──────────────────────────────
  // Funciona en tabs ocultos (no depende de renderizado DOM/JS del cliente).
  // Construimos los params de la API a partir de la URL actual de la página.
  return (async () => {
    try {
      const pageUrl = new URL(window.location.href);
      const api = new URLSearchParams();

      // Parámetros de búsqueda del catálogo → API
      const searchText = pageUrl.searchParams.get('search_text');
      if (searchText) api.set('search_text', searchText);

      for (const id of pageUrl.searchParams.getAll('brand_ids[]'))   api.append('brand_ids[]', id);
      for (const id of pageUrl.searchParams.getAll('catalog_ids[]')) api.append('catalog_ids[]', id);
      for (const id of pageUrl.searchParams.getAll('size_ids[]'))    api.append('size_ids[]', id);
      for (const id of pageUrl.searchParams.getAll('color_ids[]'))   api.append('color_ids[]', id);

      const priceFrom = pageUrl.searchParams.get('price_from');
      const priceTo   = pageUrl.searchParams.get('price_to');
      if (priceFrom) api.set('price_from', priceFrom);
      if (priceTo)   api.set('price_to',   priceTo);

      api.set('per_page', '96');
      api.set('order', pageUrl.searchParams.get('order') || 'newest_first');

      const resp = await fetch(`/api/v2/catalog/items?${api.toString()}`, {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });

      if (resp.ok) {
        const data  = await resp.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        if (items.length > 0) {
          return items.map((item, idx) => {
            const id    = String(item.id || '');
            // item.url de la API es la URL completa — usarla directamente si existe,
            // si no, construirla desde el slug o el título.
            const fullApiUrl = typeof item.url === 'string' && item.url.startsWith('http')
              ? item.url
              : null;
            const slug  = item.slug ||
                          String(item.title || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const url   = fullApiUrl || `https://www.vinted.es/items/${id}${slug ? `-${slug}` : ''}`;
            const title = item.title || slugToTitle(slug) || `Item ${id}`;
            const price = item.price_numeric
              ? `${item.price_numeric}€`
              : (item.price ? `${item.price}€` : null);
            const likes = Number.isFinite(item.favourite_count) && item.favourite_count > 0
              ? item.favourite_count : null;
            const photo = item.photo?.url || item.photos?.[0]?.url
              || item.photo?.thumbnails?.find(t => t.type === 'thumb310x430')?.url
              || null;
            return {
              itemId: id,
              url,
              title,
              priceText: price,
              rank: idx + 1,
              catalogText: `${title} ${item.brand_title || ''} ${item.size_title || ''} ${url}`,
              likesCount: likes,
              imageUrl: photo,
            };
          });
        }
        // API OK but 0 items — probablemente sin sesión o URL sin search_text
        // Continuamos con fallback DOM
      }
    } catch (_) { /* silencioso, pasamos a DOM */ }

    // ── Fallback DOM (tab activo o RSC ya hidratado) ───────────────────────
    const out  = [];
    const seen = new Set();
    let rank   = 0;

    // Selector confirmado en escaneo en vivo (Abril 2026)
    const gridCards = Array.from(document.querySelectorAll(
      '[class*="feed-grid__item"], [data-testid^="product-item-id-"]:not([data-testid*="--"])'
    ));

    for (const card of gridCards) {
      const a    = card.querySelector('a[href*="/items/"]');
      if (!a) continue;
      const href = a.getAttribute('href') || '';
      const idM  = href.match(/\/items\/(\d+)/);
      if (!idM) continue;
      const itemId = idM[1];
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      rank++;

      const fullUrl  = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
      const slugM    = href.match(/\/items\/\d+-([^/?#]+)/);
      const cardText = card.textContent || '';
      const title    =
        card.querySelector('[data-testid*="description"], [data-testid*="title"], h2, h3')?.textContent?.trim() ||
        a.getAttribute('aria-label') || a.textContent?.trim() ||
        (slugM ? slugToTitle(slugM[1]) : `Item ${itemId}`);
      const priceText =
        card.querySelector('[data-testid*="price"], [class*="price"]')?.textContent?.trim() ||
        pickPriceFromText(cardText);
      const favEl    = card.querySelector('[data-testid$="--favourite"]');
      const likesRaw = parseInt(((favEl?.innerText || favEl?.textContent) || '').trim(), 10);
      const imgEl    = card.querySelector('img');
      out.push({
        itemId, url: fullUrl, title, priceText, rank,
        catalogText: `${title} ${cardText.slice(0, 400)} ${fullUrl}`,
        likesCount:  Number.isFinite(likesRaw) && likesRaw > 0 ? likesRaw : null,
        imageUrl:    imgEl?.src || imgEl?.getAttribute('data-src') || null,
      });
    }

    // Fallback final: cualquier enlace a /items/ en la página
    if (out.length === 0) {
      for (const a of document.querySelectorAll('a[href*="/items/"]')) {
        const href = a.getAttribute('href') || '';
        const idM  = href.match(/\/items\/(\d+)/);
        if (!idM) continue;
        const itemId = idM[1];
        if (seen.has(itemId)) continue;
        const slugM  = href.match(/\/items\/\d+-([^/?#]+)/);
        const title  = a.getAttribute('aria-label')?.trim() || a.textContent?.trim() ||
                       (slugM ? slugToTitle(slugM[1]) : `Item ${itemId}`);
        if (!title || title.length < 3) continue;
        seen.add(itemId);
        rank++;
        const fullUrl = href.startsWith('http') ? href : `https://www.vinted.es${href}`;
        out.push({ itemId, url: fullUrl, title, priceText: null, rank,
                   catalogText: `${title} ${fullUrl}`, likesCount: null, imageUrl: null });
      }
    }

    return out.slice(0, 250);
  })();
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

  function normalizeLineText(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function extractDetailValueFromLines(labels) {
    const labelList = Array.isArray(labels) ? labels.map(normalizeLineText).filter(Boolean) : [];
    if (!labelList.length) return null;
    const ignoreNextValues = new Set([
      'marca',
      'brand',
      'estado',
      'condition',
      'color',
      'couleur',
      'colore',
      'talla',
      'size',
      'material',
      'envio',
      'shipping',
    ]);
    const lines = String(document.body?.innerText || '')
      .split('\n')
      .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 1200);
    if (!lines.length) return null;

    const looksLikeLabelOnly = (normalizedLine) => labelList.includes(normalizedLine);

    for (let index = 0; index < lines.length; index += 1) {
      const normalizedLine = normalizeLineText(lines[index]);
      if (!normalizedLine) continue;
      for (const label of labelList) {
        if (normalizedLine === label) {
          const nextLine = String(lines[index + 1] || '').replace(/\s+/g, ' ').trim();
          const nextNormalized = normalizeLineText(nextLine);
          if (
            nextLine &&
            nextNormalized &&
            !looksLikeLabelOnly(nextNormalized) &&
            !ignoreNextValues.has(nextNormalized) &&
            nextLine.length <= 100
          ) {
            return nextLine;
          }
          continue;
        }
        if (normalizedLine.startsWith(`${label} `)) {
          const value = normalizedLine.slice(label.length).trim();
          if (value && value.length <= 80) return value;
        }
      }
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

  // ── Sold / reserved detection (three independent signals) ────────────────
  // 1. DOM selectors — rendered by React before text is parsed by innerText
  const SOLD_DOM_SELECTORS = [
    '[data-testid="item-status--sold"]',
    '[data-testid*="sold-badge"]',
    '[data-testid*="item-sold"]',
    '[data-testid="closed-item-description"]',
    'div[class*="ItemStatus--sold"]',
    'div[class*="item-status--sold"]',
    'span[class*="sold"]',
    'div[class*="sold"]',
  ];
  const RESERVED_DOM_SELECTORS = [
    '[data-testid="item-status--reserved"]',
    '[data-testid*="reserved-badge"]',
    'div[class*="ItemStatus--reserved"]',
  ];

  const hasSoldDom      = SOLD_DOM_SELECTORS.some((sel) => !!document.querySelector(sel));
  const hasReservedDom  = RESERVED_DOM_SELECTORS.some((sel) => !!document.querySelector(sel));

  // 2. JSON-LD availability field (most structured signal)
  let availabilityFromLd = null;
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node)) { queue.push(...node); continue; }
        const avail = String(node.availability || node['schema:availability'] || '').toLowerCase();
        if (avail.includes('soldout') || avail.includes('sold_out') || avail.includes('unavailable') || avail.includes('discontinued')) {
          availabilityFromLd = 'sold'; break;
        }
        if (avail.includes('instock') || avail.includes('in_stock')) {
          availabilityFromLd = 'active'; break;
        }
        for (const v of Object.values(node)) { if (v && typeof v === 'object') queue.push(v); }
      }
      if (availabilityFromLd) break;
    } catch (_) {}
  }

  // 3. Body text regex (fallback — may miss if React hasn't hydrated yet)
  const hasSoldText     = /(vendido|sold|ya\s+se\s+ha\s+vendido|agotado|item\s+sold)/i.test(rawText);
  const hasReservedText = /(reservado|reserved)/i.test(rawText);

  // Combine signals — DOM selectors take priority, then LD, then text
  let status = 'active';
  if (hasSoldDom || availabilityFromLd === 'sold' || hasSoldText) {
    status = 'sold';
  } else if (hasReservedDom || hasReservedText) {
    status = 'reserved';
  }

  const title = firstText(['h1', '[data-testid*="title"]',
    '[data-testid="item-page-summary-plugin"]']);

  // ── Model: JSON-LD description is the cleanest source ────────────────────
  let modelFromJsonLd = null;
  try {
    for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      const parsed = JSON.parse(s.textContent || '');
      const desc = String(parsed?.description || parsed?.name || '');
      const m = desc.match(/[Mm]odelo[:\s]+([^\n|,\r]{3,50})/);
      if (m) {
        modelFromJsonLd = m[1].trim().replace(/\s+/g, ' ').split(/[·\|]/)[0].trim();
        break;
      }
    }
  } catch (_) {}

  const modelFieldText =
    modelFromJsonLd ||
    extractDetailValueFromLines(['modelo', 'model', 'modello', 'estilo', 'style', 'silueta', 'silhouette', 'serie', 'series']) ||
    null;
  const modelReferenceText =
    extractDetailValueFromLines([
      'referencia',
      'reference',
      'sku',
      'codigo producto',
      'codigo de producto',
      'product code',
      'code produit',
      'codice prodotto',
    ]) || null;
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

  // Likes — confirmed from live scan (April 2026):
  // Item-page favourite button has data-testid starting with "favourite-"
  // (exact suffix varies, e.g. "favourite-button" or "favourite-{id}").
  // aria-pressed="true/false" = whether current user liked it (irrelevant for count).
  // The count is the button's own innerText when > 0, empty string when 0.
  const favBtnEl = document.querySelector(
    '[data-testid="favourite-button"], [data-testid^="favourite-"]:not([data-testid*="--"])'
  );
  const likesFromBtn = favBtnEl ? parseInt((favBtnEl.innerText || '').trim(), 10) : NaN;
  const likesCount = Number.isFinite(likesFromBtn) && likesFromBtn > 0 ? likesFromBtn : null;

  // Views & offers: Vinted does not expose these counters publicly in the DOM
  const viewsCount = null;
  const offersCount = null;

  // Upload date: use the structured attribute if available
  const uploadDateEl = document.querySelector('[data-testid="item-attributes-upload_date"]');
  const uploadedText = uploadDateEl
    ? uploadDateEl.innerText.replace(/^Subido\s*/i, '').trim()
    : extractUploadedText(rawText);

  const isPopular = /(popular|artículo popular|item popular)/i.test(rawText);
  const modelHint = `${title || ''} ${modelFieldText || ''} ${modelReferenceText || ''} ${description || ''} ${rawText.slice(0, 1200)} ${
    window.location?.pathname || ''
  }`;
  const sellerFromJsonLd = extractSellerFromJsonLd();
  const sellerFromDom = extractSellerFromDom();
  const sellerName = sellerFromJsonLd?.sellerName || sellerFromDom?.sellerName || null;
  const sellerProfileUrl =
    sellerFromJsonLd?.sellerProfileUrl || sellerFromDom?.sellerProfileUrl || null;
  const sellerAccountStatus = inferSellerAccountStatus(rawText, sellerProfileUrl);

  // Capturar imagen og:image del producto para mostrar en el panel de detalle
  const ogImageEl = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
  const imageUrl  = ogImageEl?.content?.trim() || null;

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
    modelFieldText,
    modelReferenceText,
    modelHint,
    sellerName,
    sellerProfileUrl,
    sellerAccountStatus,
    sellerLastCheckedAt: sellerProfileUrl ? new Date().toISOString() : null,
    sellerAccountReason: sellerAccountStatus === 'blocked' ? 'Detectado texto de bloqueo en ficha' : null,
    imageUrl,
  };
}

function extractSellerProfileStatusFromPage() {
  const rawText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const text = rawText.toLowerCase();
  const $ = (s) => document.querySelector(s);
  const T = (s) => $(s)?.innerText?.trim() || null;

  const blockedPatterns = [
    /bloquead/i, /suspendid/i, /cuenta no disponible/i,
    /perfil no disponible/i, /usuario no existe/i,
    /member blocked/i, /account blocked/i, /account suspended/i,
    /user not found/i, /profile not found/i,
    /compte bloqu/i, /profilo bloccato/i,
  ];
  const isBlocked = blockedPatterns.some((p) => p.test(text));
  const hasItems  = document.querySelectorAll('a[href*="/items/"]').length > 0;
  const displayName = $('h1')?.textContent?.trim() || T('[data-testid="profile-username"]') || null;

  let accountStatus = 'unknown';
  let reason = 'sin suficientes datos';
  if (isBlocked) {
    accountStatus = 'blocked';
    reason = 'perfil con texto de bloqueo/suspension';
  } else if (hasItems || displayName) {
    accountStatus = 'active';
    reason = 'perfil visible con actividad';
  }

  // ── Datos extra del perfil del vendedor ─────────────────────
  const parseNum = (s) => {
    const m = String(s || '').replace(/\./g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  // Items en venta
  const itemsCountEl = $('[data-testid*="items-count"], [class*="items-count"]');
  const itemsCountRaw = itemsCountEl?.innerText?.trim() || null;
  const itemsCount = parseNum(itemsCountRaw);

  // Valoración / rating
  const ratingEl = $('[data-testid*="rating"], [class*="rating__value"], [class*="stars"]');
  const ratingRaw = ratingEl?.innerText?.trim() || null;
  const ratingMatch = String(ratingRaw || rawText).match(/([\d][.,][\d])\s*\/?\s*5/);
  const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : null;

  // Número de valoraciones
  const reviewsMatch = rawText.match(/(\d+)\s*(valoracion|reseña|review|avis|valutazion)/i);
  const reviewCount = reviewsMatch ? parseInt(reviewsMatch[1], 10) : null;

  // Miembro desde
  const memberSinceMatch = rawText.match(/miembro desde\s+([^\n|.]{3,30})/i)
    || rawText.match(/membre depuis\s+([^\n|.]{3,30})/i)
    || rawText.match(/member since\s+([^\n|.]{3,30})/i);
  const memberSince = memberSinceMatch ? memberSinceMatch[1].trim() : null;

  // Tiempo de respuesta
  const responseMatch = rawText.match(/responde en\s+([^\n|.]{3,30})/i)
    || rawText.match(/répond en\s+([^\n|.]{3,30})/i)
    || rawText.match(/responds? (in|within)\s+([^\n|.]{3,20})/i);
  const responseTime = responseMatch ? (responseMatch[1] || responseMatch[2])?.trim() : null;

  // Última conexión
  const lastLoginEl = $('[data-testid="seller-last-logged-in"]');
  const lastLogin = lastLoginEl?.innerText?.trim() || null;

  // Score de confianza del vendedor
  let trustScore = 0;
  if (accountStatus === 'active') trustScore += 30;
  if (rating !== null && rating >= 4.5) trustScore += 25;
  else if (rating !== null && rating >= 4.0) trustScore += 15;
  if (reviewCount !== null && reviewCount >= 20) trustScore += 20;
  else if (reviewCount !== null && reviewCount >= 5) trustScore += 10;
  if (itemsCount !== null && itemsCount >= 5) trustScore += 15;
  if (/hace \d+ (minuto|hora)/i.test(lastLogin || '')) trustScore += 10;
  else if (/hace 1 d[íi]a|ayer/i.test(lastLogin || '')) trustScore += 5;

  const trustTier =
    trustScore >= 80 ? '⭐⭐⭐ MUY FIABLE'  :
    trustScore >= 55 ? '⭐⭐ FIABLE'         :
    trustScore >= 30 ? '⭐ ACEPTABLE'        : '⚠️ DESCONOCIDO';

  return {
    accountStatus,
    reason,
    displayName,
    itemsCount,
    rating,
    reviewCount,
    memberSince,
    responseTime,
    lastLogin,
    trustScore,
    trustTier,
    checkedAt: new Date().toISOString(),
  };
}

function executeVintedLikeOfferTaskInPage() {
  const FAVORITE_SELECTORS = [
    'button[data-testid="favourite-button"]',
    'button[data-testid*="favourite"]',
    'button[data-testid="favorite-button"]',
    'button[data-testid*="favorite"]',
    'button[aria-label*="favorit"]',
    'button[aria-label*="favourit"]',
    '[role="button"][aria-label*="favorit"]',
    '[role="button"][aria-label*="favourit"]',
  ];

  const OFFER_BUTTON_SELECTORS = [
    'button[data-testid="item-buyer-offer-button"]',
    'button[data-testid="item-make-offer-button"]',
    'button[data-testid="item-offer-button"]',
    'button[data-testid*="buyer-offer"]',
    'button[data-testid*="offer-button"]',
    'button[data-testid*="offer"]',
  ];

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function waitForElement(selectors, timeoutMs = 10000, root = document) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        for (const selector of list) {
          const node = root.querySelector(selector);
          if (node) {
            clearInterval(timer);
            resolve(node);
            return;
          }
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 250);
    });
  }

  function findButtonByText(texts, root = document) {
    const values = Array.isArray(texts) ? texts : [texts];
    const controls = Array.from(root.querySelectorAll('button, [role="button"]'));
    for (const control of controls) {
      const label = String(control.textContent || '').trim().toLowerCase();
      if (!label) continue;
      if (values.some((value) => label.includes(String(value).toLowerCase()))) {
        return control;
      }
    }
    return null;
  }

  function reactClick(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const mouseOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
    };
    const pointerOpts = {
      ...mouseOpts,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    const sequence = [
      ['pointerover', PointerEvent, pointerOpts],
      ['pointerenter', PointerEvent, pointerOpts],
      ['mouseover', MouseEvent, mouseOpts],
      ['mouseenter', MouseEvent, mouseOpts],
      ['pointermove', PointerEvent, pointerOpts],
      ['mousemove', MouseEvent, mouseOpts],
      ['pointerdown', PointerEvent, pointerOpts],
      ['mousedown', MouseEvent, mouseOpts],
      ['pointerup', PointerEvent, pointerOpts],
      ['mouseup', MouseEvent, mouseOpts],
      ['click', MouseEvent, mouseOpts],
    ];
    for (const [type, EventCtor, opts] of sequence) {
      try {
        element.dispatchEvent(new EventCtor(type, opts));
      } catch (_) {
        // ignore dispatch failures
      }
    }
  }

  function isOwnListingPage(root = document) {
    const ownerTexts = [
      'editar anuncio',
      'eliminar',
      'marcar como vendido',
      'marcar como reservado',
      'edit listing',
      'delete',
      'mark as sold',
      'mark as reserved',
    ];
    if (findButtonByText(ownerTexts, root)) return true;
    return [
      '[data-testid*="item-edit"]',
      '[data-testid*="item-delete"]',
      '[data-testid*="mark-as-sold"]',
      '[data-testid*="seller-actions"]',
    ].some((selector) => !!root.querySelector(selector));
  }

  function isSoldPage(root = document) {
    const soldSelectors = [
      '[data-testid="item-status--sold"]',
      '[data-testid*="sold-badge"]',
      '[data-testid*="item-sold"]',
      '[class*="sold"]',
    ];
    if (soldSelectors.some((selector) => !!root.querySelector(selector))) {
      return true;
    }
    const text = String(root.body?.innerText || root.innerText || '').toLowerCase();
    return /\b(vendido|sold|agotado|item sold)\b/i.test(text);
  }

  function isDisabledButton(button) {
    if (!button) return true;
    return (
      button.disabled === true ||
      String(button.getAttribute('aria-disabled') || '').trim().toLowerCase() === 'true'
    );
  }

  function isFavoriteAlready(button) {
    if (!button) return false;
    const ariaPressed = String(button.getAttribute('aria-pressed') || '').trim().toLowerCase();
    if (ariaPressed === 'true') return true;
    const ariaLabel = String(button.getAttribute('aria-label') || '').trim().toLowerCase();
    if (
      ariaLabel.includes('quitar de favoritos') ||
      ariaLabel.includes('added to favourites') ||
      ariaLabel.includes('added to favorites') ||
      ariaLabel.includes('remove from favourites') ||
      ariaLabel.includes('remove from favorites')
    ) {
      return true;
    }
    const title = String(button.getAttribute('title') || '').trim().toLowerCase();
    if (
      title.includes('quitar de favoritos') ||
      title.includes('remove from favourites') ||
      title.includes('remove from favorites')
    ) {
      return true;
    }
    const className = String(button.className || '').toLowerCase();
    return (
      className.includes('active') ||
      className.includes('pressed') ||
      className.includes('selected') ||
      className.includes('favourite--active') ||
      className.includes('favorite--active')
    );
  }

  function getFavoriteButton(root = document) {
    return (
      Array.from(root.querySelectorAll(FAVORITE_SELECTORS.join(', '))).find((node) => node instanceof HTMLElement) ||
      null
    );
  }

  function hasActiveFavoriteSignal(root = document) {
    const button = getFavoriteButton(root);
    if (button && isFavoriteAlready(button)) return true;
    return Boolean(
      root.querySelector(
        [
          '[class*="favourite"][class*="active"]',
          '[class*="favorite"][class*="active"]',
          '[class*="heart"][class*="active"]',
          'svg [fill*="#e"]',
          'svg [fill*="rgb(234"]',
          'svg [fill*="rgb(255"]',
        ].join(', ')
      )
    );
  }

  function hasOfferEntryPoint(root = document) {
    if (root.querySelector(OFFER_BUTTON_SELECTORS.join(', '))) return true;
    return Boolean(
      findButtonByText(
        ['hacer una oferta', 'haz una oferta', 'hacer oferta', 'enviar oferta', 'make an offer', 'send offer', 'offer'],
        root
      )
    );
  }

  function hasRequiredPriceError(root = document) {
    const nodes = Array.from(root.querySelectorAll('div, span, p'));
    return nodes.some((node) => {
      const text = String(node.textContent || '').trim().toLowerCase();
      return (
        text.includes('precio es requerido') ||
        text.includes('precio requerido') ||
        text.includes('price is required')
      );
    });
  }

  function parseMoneyValue(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const cleaned = raw.replace(/\s/g, '').replace(/[^\d,.-]/g, '');
    if (!cleaned) return null;
    const normalized = cleaned.includes(',')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned;
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }

  function formatMoneyCandidates(amount) {
    const fixed = Number(amount).toFixed(2);
    const [euros, cents] = fixed.split('.');
    return [
      `${euros},${cents}`,
      `${euros}.${cents}`,
      euros,
      `${euros}${cents}`,
    ];
  }

  function extractOfferAmountFromOption(option) {
    if (!option) return null;
    const text = String(option.textContent || '').trim();
    const direct = parseMoneyValue(text);
    if (direct !== null) return direct;
    const childNodes = Array.from(option.querySelectorAll('div, span, strong, p'));
    for (const node of childNodes) {
      const parsed = parseMoneyValue(node.textContent || '');
      if (parsed !== null) return parsed;
    }
    return null;
  }

  function isElementHidden(node) {
    if (!(node instanceof Element)) return true;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') === 0 ||
      rect.width < 6 ||
      rect.height < 6
    );
  }

  async function waitForOfferSubmission(dialogRoot, timeoutMs = 7000) {
    const startedAt = Date.now();
    const originalPath = String(window.location?.pathname || '').toLowerCase();
    while (Date.now() - startedAt <= timeoutMs) {
      const currentPath = String(window.location?.pathname || '').toLowerCase();
      if (currentPath.includes('/inbox/')) {
        return { ok: true, signal: 'same_tab_inbox' };
      }
      const liveDialog =
        document.querySelector('[role="dialog"]') ||
        document.querySelector('[data-testid*="offer-modal"]') ||
        dialogRoot;
      if (!liveDialog || !liveDialog.isConnected || isElementHidden(liveDialog)) {
        return { ok: true, signal: currentPath !== originalPath ? 'path_changed' : 'dialog_closed' };
      }
      await wait(350);
    }
    return { ok: false, signal: 'timeout' };
  }

  function setInputValue(input, value) {
    if (!input) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    if (nativeSetter) {
      nativeSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      nativeSetter.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findPresetOfferOption(dialogRoot) {
    const options = Array.from(
      dialogRoot.querySelectorAll(
        '[data-testid="offer-price-option"], [data-testid*="offer-price-option"], [data-testid*="offer-option"]'
      )
    ).filter((node) => {
      const text = String(node.textContent || '').trim().toLowerCase();
      return text && !text.includes('personalizar') && !text.includes('custom');
    });
    if (options.length >= 2) return options[1];
    if (options.length >= 1) return options[0];
    return null;
  }

  async function stabilizePresetOption(dialogRoot) {
    if (!dialogRoot) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const option = findPresetOfferOption(dialogRoot);
      if (!option) break;
      try {
        option.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      } catch (_) {
        // ignore scroll failures
      }
      option.click();
      if (attempt < 2) {
        await wait(2000);
      }
    }
    await wait(900);
  }

  async function findSubmitButton(dialogRoot) {
    const selectors = [
      'button[data-testid="offer-submit-button"]',
      'button[data-testid*="offer-submit"]',
      'button[data-testid*="submit"]',
      'button[type="submit"]',
    ];
    const button = await waitForElement(selectors, 8000, dialogRoot);
    if (button) return button;
    return findButtonByText(
      ['ofrecer', 'enviar oferta', 'make offer', 'send offer', 'submit offer'],
      dialogRoot
    );
  }

  async function submitOffer(dialogRoot, timeoutMs = 7000) {
    const submitButton = await findSubmitButton(dialogRoot);
    if (!submitButton) {
      return { ok: false, reason: 'offer_submit_not_found' };
    }
    if (isDisabledButton(submitButton)) {
      return { ok: false, reason: 'offer_submit_not_ready' };
    }
    submitButton.click();
    const submission = await waitForOfferSubmission(dialogRoot, timeoutMs);
    if (!submission.ok) {
      return { ok: false, reason: 'offer_submit_not_applied' };
    }
    return { ok: true, signal: submission.signal };
  }

  async function forceCustomOfferValue(dialogRoot, targetAmount) {
    const customOption =
      dialogRoot.querySelector('[data-testid="custom-offer-price-option"]') ||
      findButtonByText(['personalizar', 'custom', 'customize'], dialogRoot);

    if (!customOption) {
      return { ok: false, reason: 'offer_custom_option_not_found' };
    }

    customOption.click();
    await wait(800);

    const input =
      (await waitForElement(
        [
          'input[data-testid="offer-price-field--input"]',
          'input[data-testid*="offer-price"]',
          'input[inputmode="decimal"]',
        ],
        6000,
        dialogRoot
      )) ||
      dialogRoot.querySelector('input[data-testid="offer-price-field--input"]') ||
      dialogRoot.querySelector('input[data-testid*="offer-price"]') ||
      dialogRoot.querySelector('input[inputmode="decimal"]');

    if (!input) {
      return { ok: false, reason: 'offer_custom_input_not_found' };
    }

    const amount =
      targetAmount !== null && targetAmount !== undefined
        ? Number(targetAmount)
        : parseMoneyValue(input.value || input.placeholder || '');
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: 'offer_custom_input_missing' };
    }

    let accepted = false;
    for (const candidate of formatMoneyCandidates(amount)) {
      setInputValue(input, candidate);
      await wait(700);
      const currentSubmit = await findSubmitButton(dialogRoot);
      if (currentSubmit && !isDisabledButton(currentSubmit) && !hasRequiredPriceError(dialogRoot)) {
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      return { ok: false, reason: 'offer_custom_price_rejected' };
    }

    const submitted = await submitOffer(dialogRoot, 8000);
    if (!submitted.ok) {
      return submitted;
    }
    return { ok: true, signal: submitted.signal, method: 'custom' };
  }

  async function addFavorite() {
    if (isOwnListingPage(document)) {
      return { ok: true, skip: true, reason: 'own_product_skip' };
    }
    const button = await waitForElement(FAVORITE_SELECTORS, 12000);
    let currentButton = button || getFavoriteButton(document);
    if (!currentButton && hasActiveFavoriteSignal(document)) {
      return { ok: true, alreadyBefore: true };
    }
    if (!currentButton) {
      if (isOwnListingPage(document)) {
        return { ok: true, skip: true, reason: 'own_product_skip' };
      }
      return { ok: false, reason: 'favorite_button_not_found' };
    }
    const alreadyBefore = isFavoriteAlready(currentButton) || hasActiveFavoriteSignal(document);
    if (alreadyBefore === true) {
      return { ok: true, alreadyBefore: true };
    }

    try {
      currentButton.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (_) {
      // ignore scroll failures
    }
    currentButton.click();
    await wait(1800);
    const refreshedButton = getFavoriteButton(document) || currentButton;
    if (isFavoriteAlready(refreshedButton) || hasActiveFavoriteSignal(document)) {
      return { ok: true, alreadyBefore: false };
    }

    return { ok: false, reason: 'favorite_click_not_applied' };
  }

  async function sendOffer() {
    if (isOwnListingPage(document)) {
      return { ok: true, own: true };
    }

    const selectors = OFFER_BUTTON_SELECTORS;
    const texts = [
      'hacer una oferta',
      'haz una oferta',
      'hacer oferta',
      'enviar oferta',
      'make an offer',
      'send offer',
      'offer',
    ];

    let makeOfferButton = await waitForElement(selectors, 9000);
    if (!makeOfferButton) {
      makeOfferButton = findButtonByText(texts);
    }
    if (!makeOfferButton) {
      if (isOwnListingPage(document)) return { ok: true, own: true };
      if (isSoldPage(document)) return { ok: true, sold: true };
      return { ok: false, reason: 'offer_button_not_found' };
    }

    makeOfferButton.click();

    const dialogSignal = await waitForElement(
      [
        '[data-testid="offer-price-option"]',
        '[data-testid="custom-offer-price-option"]',
        'input[data-testid="offer-price-field--input"]',
        'button[data-testid="offer-submit-button"]',
      ],
      10000
    );
    if (!dialogSignal) {
      return { ok: false, reason: 'offer_dialog_not_opened' };
    }

    await wait(1200);
    const dialogRoot =
      document.querySelector('[role="dialog"]') ||
      document.querySelector('[data-testid*="offer-modal"]') ||
      document;
    const presetOption = findPresetOfferOption(dialogRoot);
    if (presetOption) {
      await stabilizePresetOption(dialogRoot);
      const appliedSubmit = await findSubmitButton(dialogRoot);
      if (appliedSubmit && !isDisabledButton(appliedSubmit) && !hasRequiredPriceError(dialogRoot)) {
        const submitted = await submitOffer(dialogRoot, 8000);
        if (submitted.ok) {
          return { ok: true, submitted: true, signal: submitted.signal, method: 'preset' };
        }
      }
      const presetAmount = extractOfferAmountFromOption(presetOption);
      const customFallback = await forceCustomOfferValue(dialogRoot, presetAmount);
      if (!customFallback.ok) {
        return customFallback;
      }
      return { ok: true, submitted: true, signal: customFallback.signal, method: customFallback.method || 'custom' };
    } else {
      const input =
        dialogRoot.querySelector('input[data-testid="offer-price-field--input"]') ||
        dialogRoot.querySelector('input[data-testid*="offer-price"]') ||
        dialogRoot.querySelector('input[inputmode="decimal"]');
      if (!input) {
        return { ok: false, reason: 'offer_preset_option_not_found' };
      }
      const fallbackValue = String(input.value || input.placeholder || '').replace(/[^\d.,]/g, '').trim();
      if (!fallbackValue) {
        return { ok: false, reason: 'offer_custom_input_missing' };
      }
      setInputValue(input, fallbackValue);
      await wait(900);
    }
    const submitted = await submitOffer(dialogRoot, 8000);
    if (!submitted.ok) {
      return submitted;
    }
    return { ok: true, submitted: true, signal: submitted.signal };
  }

  // ── Captura metadatos de la página para persistirlos en el registro ──────────
  function getPageMeta() {
    try {
      const imageEl  = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
      const titleEl  = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
      const titleDom = document.querySelector('[data-testid="item-title"], h1[class*="title"], h1');
      const priceEl  = document.querySelector('[data-testid="item-price"]');
      const imageUrl = imageEl?.content?.trim() || null;
      const title    = (titleEl?.content || titleDom?.textContent || '').replace(/\s+/g, ' ').trim() || null;
      const priceRaw = priceEl ? parseFloat((priceEl.textContent || '').replace(/[^\d.,]/g, '').replace(',', '.')) : NaN;
      return {
        imageUrl,
        title,
        price: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
      };
    } catch (_) { return { imageUrl: null, title: null, price: null }; }
  }

  async function runTask() {
    await wait(1300);
    if (isOwnListingPage(document)) {
      return { ok: true, result: 'completed', reason: 'own_product_skip' };
    }

    const favorite = await addFavorite();
    if (!favorite.ok) {
      return { ok: false, result: 'failed', reason: favorite.reason };
    }
    if (favorite.skip) {
      return { ok: true, result: 'completed', reason: favorite.reason || 'own_product_skip' };
    }

    const offer = await sendOffer();
    if (!offer.ok) {
      return { ok: false, result: 'failed', reason: offer.reason };
    }
    if (offer.own) {
      return { ok: true, result: 'completed', reason: 'own_product_skip' };
    }
    if (offer.sold) {
      return { ok: true, result: 'completed', reason: 'item_sold' };
    }

    return {
      ok: true,
      result: 'completed',
      reason: favorite.alreadyBefore ? 'offer_submitted_already_liked' : 'offer_submitted',
    };
  }

  // Envuelve runTask para inyectar siempre los metadatos de página en el resultado.
  return (async () => {
    const meta = getPageMeta();
    const taskResult = await runTask().catch((error) => ({
      ok: false,
      result: 'failed',
      reason: error?.message || 'unknown_execution_error',
    }));
    return { ...taskResult, meta };
  })();
}

function extractCurrentVintedAccountFromPage() {
  function normalizeOneLine(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function splitCleanLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => normalizeOneLine(line))
      .filter(Boolean);
  }

  function parsePersonName(fullName) {
    const clean = normalizeOneLine(fullName);
    if (!clean) {
      return { fullName: null, firstName: null, lastName: null };
    }
    const parts = clean.split(' ').filter(Boolean);
    if (parts.length <= 1) {
      return { fullName: clean, firstName: clean, lastName: null };
    }
    return {
      fullName: clean,
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    };
  }

  function extractShippingAddressInfo() {
    const all = Array.from(document.querySelectorAll('div, section, article'));
    let best = null;

    for (const node of all) {
      const text = String(node?.innerText || '');
      if (!text) continue;
      const lines = splitCleanLines(text);
      if (lines.length < 2 || lines.length > 7) continue;
      const joined = lines.join(' ');
      const hasPostal = /\b\d{4,5}\b/.test(joined);
      const hasStreetLike = /(calle|kalea|avenida|av\.?|c\/|plaza|plz|rue|via|road|street|st\.?)/i.test(joined);
      const hasAddressHint = /(tu direcci[oó]n|direccion|shipping|env[ií]os|recoger|entregar)/i.test(joined);
      if (!hasPostal && !hasStreetLike && !hasAddressHint) continue;

      let score = 0;
      if (hasPostal) score += 4;
      if (hasStreetLike) score += 3;
      if (hasAddressHint) score += 3;
      if (lines[0] && /^[A-Za-zÀ-ÿ' -]{3,}$/.test(lines[0])) score += 2;
      if (lines.length >= 3) score += 1;
      if (score < 5) continue;

      if (!best || score > best.score) {
        best = { score, lines };
      }
    }

    if (!best?.lines?.length) {
      return {
        fullName: null,
        firstName: null,
        lastName: null,
        shippingAddressLine1: null,
        shippingAddressLine2: null,
        shippingAddressText: null,
      };
    }

    const lines = best.lines.slice(0, 4);
    const firstLineLooksName = /^[A-Za-zÀ-ÿ' -]{3,}$/.test(lines[0] || '');
    const nameLine = firstLineLooksName ? lines[0] : null;
    const addressLines = firstLineLooksName ? lines.slice(1) : lines;
    const addressLine1 = addressLines[0] || null;
    const addressLine2 = addressLines[1] || null;
    const addressText = addressLines.length ? addressLines.join(', ') : null;
    const parsedName = parsePersonName(nameLine);

    return {
      ...parsedName,
      shippingAddressLine1: addressLine1,
      shippingAddressLine2: addressLine2,
      shippingAddressText: addressText,
    };
  }

  function absoluteVintedUrl(href) {
    const value = String(href || '').trim();
    if (!value) return null;
    if (value.startsWith('https://www.vinted.es/')) return value;
    if (value.startsWith('/')) return `https://www.vinted.es${value}`;
    return null;
  }

  function parseMemberId(profileUrl) {
    const m = String(profileUrl || '').match(/\/member\/(\d+)/i);
    return m?.[1] ? m[1] : null;
  }

  function parseUsername(profileUrl) {
    const m = String(profileUrl || '').match(/\/member\/\d+(?:-([^/?#]+))?/i);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]).trim() || null;
    } catch (_) {
      return String(m[1]).trim() || null;
    }
  }

  function extractProfileHintsFromSource() {
    const html = String(document.documentElement?.innerHTML || '');
    const scriptsText = Array.from(document.scripts || [])
      .map((script) => String(script.textContent || ''))
      .filter(Boolean)
      .join('\n');
    const source = `${html}\n${scriptsText}`;
    if (!source) {
      return {
        profileUrl: null,
        memberId: null,
        username: null,
      };
    }

    const profileMatch =
      source.match(/https:\\\/\\\/www\.vinted\.es\\\/member\\\/(\d+)(?:-([^"'\\/<>\s?#]+))?/i) ||
      source.match(/https:\/\/www\.vinted\.es\/member\/(\d+)(?:-([^"'\/<>\s?#]+))?/i) ||
      source.match(/\/member\/(\d+)(?:-([^"'\/<>\s?#]+))?/i);

    const rawProfileUrl = profileMatch?.[0]
      ? String(profileMatch[0]).replaceAll('\\/', '/')
      : '';
    const profileUrl = absoluteVintedUrl(rawProfileUrl);

    const memberIdMatch =
      source.match(/"memberId"\s*:\s*"?(\\d+|\d+)"/i) ||
      source.match(/"userId"\s*:\s*"?(\\d+|\d+)"/i) ||
      source.match(/"user_id"\s*:\s*"?(\\d+|\d+)"/i) ||
      (profileUrl ? profileUrl.match(/\/member\/(\d+)/i) : null);
    const memberId = String(memberIdMatch?.[1] || '').replace(/[^\d]/g, '') || null;

    const username = profileMatch?.[2]
      ? (() => {
          try {
            return decodeURIComponent(String(profileMatch[2] || '').replaceAll('\\/', '/')).trim() || null;
          } catch (_) {
            return String(profileMatch[2] || '').trim() || null;
          }
        })()
      : null;

    return {
      profileUrl,
      memberId,
      username,
    };
  }

  function hasVisibleLoadingSignals() {
    const selectors = [
      '[aria-busy="true"]',
      '[data-testid*="loader"]',
      '[class*="loader"]',
      '[class*="spinner"]',
      '[class*="loading"]',
    ];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const hidden =
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') === 0 ||
          rect.width < 8 ||
          rect.height < 8;
        if (!hidden) {
          return true;
        }
      }
    }
    return false;
  }

  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const pageUrl = String(window.location?.href || '');
  const pagePath = String(window.location?.pathname || '').toLowerCase();
  const language = String(document.documentElement?.lang || '').trim() || null;
  const locale =
    String(document.querySelector('meta[property="og:locale"]')?.getAttribute('content') || '').trim() ||
    null;

  const hasLoginCta =
    /(inicia sesi[oó]n|iniciar sesi[oó]n|log in|sign in|se connecter|accedi|entra)/i.test(bodyText) ||
    !!document.querySelector('a[href*="login"], a[href*="sign-in"], button[data-testid*="login"]');
  const hasRegisterCta =
    /(reg[ií]strate|registrati|sign up|register|crear cuenta|se inscrire)/i.test(bodyText) ||
    !!document.querySelector('a[href*="register"], a[href*="signup"], a[href*="sign-up"]');

  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const candidates = anchors
    .map((a) => {
      const href = absoluteVintedUrl(a.getAttribute('href'));
      if (!href || !/\/member\/\d+/i.test(href)) return null;
      const text = String(a.textContent || '').replace(/\s+/g, ' ').trim();
      if (/\/member\/general\//i.test(href)) return null;
      let score = 0;
      if (a.closest('header, nav, [class*="header"], [class*="nav"], [data-testid*="header"]')) score += 8;
      if (text && text.length >= 2 && text.length <= 36) score += 4;
      if (href.includes('-')) score += 2;
      return { href, text: text || null, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  const sourceHints = extractProfileHintsFromSource();
  const profileUrl = best?.href || sourceHints.profileUrl || null;
  const memberId = parseMemberId(profileUrl) || sourceHints.memberId;
  const username = parseUsername(profileUrl) || sourceHints.username;
  const displayName = best?.text || username || null;
  const shipping = extractShippingAddressInfo();
  const fullName = shipping.fullName || displayName || null;
  const firstName = shipping.firstName || null;
  const lastName = shipping.lastName || null;
  const shippingAddressLine1 = shipping.shippingAddressLine1 || null;
  const shippingAddressLine2 = shipping.shippingAddressLine2 || null;
  const shippingAddressText = shipping.shippingAddressText || null;
  const hasAddressSignals = Boolean(shippingAddressText || shippingAddressLine1 || shippingAddressLine2);
  const hasSettingsAddressHeading = /(tu direcci[oó]n|your address|adresse|indirizzo|direcci[oó]n de env[ií]o)/i.test(bodyText);
  const isSettingsContext =
    pagePath.includes('/settings/shipping') ||
    pagePath.includes('/settings/') ||
    pagePath.includes('/shipping') ||
    pagePath.includes('/address');

  let status = 'unknown';
  let loggedIn = null;
  let reason = 'sin_suficientes_datos';

  if (profileUrl || memberId) {
    status = 'logged_in';
    loggedIn = true;
    reason = profileUrl ? 'perfil_member_detectado' : 'member_id_detectado';
  } else if (hasAddressSignals || hasSettingsAddressHeading || isSettingsContext) {
    status = 'logged_in';
    loggedIn = true;
    reason = hasAddressSignals ? 'direccion_detectada' : 'ajustes_envio_abiertos';
  } else if (pagePath.includes('/login') || (hasLoginCta && hasRegisterCta)) {
    status = 'no_account';
    loggedIn = false;
    reason = 'sin_sesion_activa';
  }

  const hasIdentitySignals = Boolean(profileUrl || memberId || username || displayName || fullName);
  const loadingSignals = hasVisibleLoadingSignals();
  const waitingForSettingsContent = isSettingsContext && status === 'logged_in' && !hasIdentitySignals && !hasAddressSignals;

  let ready = true;
  let loadState = 'ready';
  if (status === 'unknown' || waitingForSettingsContent || (loadingSignals && !hasIdentitySignals && !hasAddressSignals)) {
    ready = false;
    loadState = 'loading';
  }

  return {
    status,
    loggedIn,
    username,
    displayName,
    fullName,
    firstName,
    lastName,
    shippingAddressLine1,
    shippingAddressLine2,
    shippingAddressText,
    profileUrl,
    memberId,
    language,
    locale,
    pageUrl: pageUrl || null,
    reason,
    ready,
    loadState,
    loadingSignals,
    lastCheckedAt: new Date().toISOString(),
  };
}
