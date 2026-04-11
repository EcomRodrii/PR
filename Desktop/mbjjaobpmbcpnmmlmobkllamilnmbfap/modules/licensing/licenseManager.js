export function defaultLicenseState() {
  return {
    key: 'free',
    status: 'active',
    planName: 'free',
    expiresAt: null,
    message: '',
    lastCheckedAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    source: 'local',
  };
}

export function normalizeLicenseState() {
  return defaultLicenseState();
}

export function shouldRefreshLicense() {
  return false;
}

export function evaluateLicenseState() {
  return {
    allowed: true,
    reason: 'active',
    status: 'active',
    graceActive: false,
    keyPresent: true,
    planName: 'free',
    expiresAt: null,
    message: '',
    checkedAt: new Date().toISOString(),
  };
}

export function normalizeRemotePayload() {
  return { status: 'active', expiresAt: null, planName: 'free', message: '', raw: {} };
}

export async function verifyLicenseRemote() {
  return { status: 'active', expiresAt: null, planName: 'free', message: '', raw: {} };
}

export function buildLicenseFromRemote() {
  return defaultLicenseState();
}

export function buildLicenseFromError() {
  return defaultLicenseState();
}
