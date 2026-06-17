// ── URL del servidor de licencias ─────────────────────────────────────────────
// IMPORTANTE: cámbiala a tu dominio de producción.
export const AUTH_API_URL = 'http://localhost:3000';

// ── Caché en memoria (5 minutos) ──────────────────────────────────────────────
const LICENSE_CACHE_TTL_MS = 5 * 60 * 1000;
let _licenseCache = null;   // { result, cachedAt }

// ── Estado por defecto ────────────────────────────────────────────────────────
export function defaultLicenseState() {
  return {
    status:        'inactive',
    plan:          'standard',
    expiresAt:     null,
    message:       '',
    lastCheckedAt: null,
    allowed:       false,
    source:        'local',
  };
}

// ── Normalizar payload remoto ─────────────────────────────────────────────────
export function normalizeRemotePayload(data) {
  if (!data || typeof data !== 'object') return defaultLicenseState();
  return {
    status:        String(data.status    || 'inactive'),
    plan:          String(data.plan      || 'standard'),
    expiresAt:     data.expiresAt        || null,
    message:       String(data.message   || ''),
    lastCheckedAt: new Date().toISOString(),
    allowed:       data.allowed === true,
    source:        'remote',
  };
}

// ── Leer token de chrome.storage.local ───────────────────────────────────────
export async function getAuthToken() {
  try {
    const stored = await chrome.storage.local.get('lamine_auth_token');
    return stored?.lamine_auth_token || null;
  } catch (_) {
    return null;
  }
}

// ── Guardar / limpiar token ───────────────────────────────────────────────────
export async function saveAuthToken(token, email, role) {
  await chrome.storage.local.set({
    lamine_auth_token: token,
    lamine_auth_email: email || '',
    lamine_auth_role:  role  || 'user',
  });
  _licenseCache = null;   // invalidar caché
}

export async function clearAuthToken() {
  await chrome.storage.local.remove(['lamine_auth_token', 'lamine_auth_email', 'lamine_auth_role']);
  _licenseCache = null;
}

// ── Verificar licencia con el servidor (con caché) ────────────────────────────
export async function verifyLicenseRemote({ force = false } = {}) {
  // Servir desde caché si es válida y no se fuerza refresco
  if (!force && _licenseCache && (Date.now() - _licenseCache.cachedAt) < LICENSE_CACHE_TTL_MS) {
    return _licenseCache.result;
  }

  const token = await getAuthToken();
  if (!token) {
    return { allowed: false, status: 'no_token', message: 'No has iniciado sesión.', source: 'local' };
  }

  try {
    const res = await fetch(`${AUTH_API_URL}/license/verify`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json();
    const result = normalizeRemotePayload(data);

    _licenseCache = { result, cachedAt: Date.now() };
    return result;
  } catch (err) {
    // Sin red: si había caché (aunque expirada), usarla con gracia
    if (_licenseCache) {
      return { ..._licenseCache.result, source: 'cache_stale', message: 'Sin conexión — usando caché.' };
    }
    return {
      allowed: false,
      status:  'network_error',
      message: `No se pudo conectar al servidor de licencias: ${err?.message || 'error de red'}`,
      source:  'local',
    };
  }
}

// ── Invalidar caché manualmente ───────────────────────────────────────────────
export function invalidateLicenseCache() {
  _licenseCache = null;
}

// ── Evaluación sincrónica (para compatibilidad) ───────────────────────────────
export function evaluateLicenseState(licenseState) {
  if (!licenseState) return { allowed: false, reason: 'no_state', status: 'inactive', message: 'Sin estado de licencia.' };
  return {
    allowed:      licenseState.allowed === true,
    status:       licenseState.status    || 'inactive',
    plan:         licenseState.plan      || 'standard',
    expiresAt:    licenseState.expiresAt || null,
    message:      licenseState.message   || '',
    checkedAt:    licenseState.lastCheckedAt || null,
    source:       licenseState.source    || 'local',
    reason:       licenseState.status    || 'inactive',
  };
}

export function normalizeLicenseState(raw) {
  if (!raw || typeof raw !== 'object') return defaultLicenseState();
  return { ...defaultLicenseState(), ...raw };
}

export function shouldRefreshLicense(licenseState) {
  if (!licenseState?.lastCheckedAt) return true;
  const age = Date.now() - new Date(licenseState.lastCheckedAt).getTime();
  return age > LICENSE_CACHE_TTL_MS;
}

export function buildLicenseFromRemote(_previousLicense, remoteData) {
  return normalizeRemotePayload(remoteData);
}

export function buildLicenseFromError(previousLicense) {
  return { ...(previousLicense || defaultLicenseState()), source: 'error' };
}
