'use strict';

require('dotenv').config();

// SQLite nativo de Node.js 22+ (sin compilación, sin dependencias nativas)
const { DatabaseSync } = require('node:sqlite');

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const path      = require('path');
const crypto    = require('crypto');

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT         = Number(process.env.PORT)          || 3000;
const JWT_SECRET   = process.env.JWT_SECRET            || 'dev_secret_local';
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN        || '90d';
const ADMIN_SECRET = process.env.ADMIN_SECRET          || 'admin_local';
const DB_PATH      = process.env.DB_PATH               || path.join(__dirname, 'licenses.db');
const NODE_ENV     = process.env.NODE_ENV              || 'development';
const MAX_IPS_24H  = Number(process.env.MAX_IPS_24H)   || 6;
const MAX_DEVICES  = Number(process.env.MAX_DEVICES)   || 5;
const BCRYPT_ROUNDS = 12;
// Single-device policy: when true, only one HWID can hold an active session.
// SINGLE_DEVICE_STRICT=1 (default): rechaza cualquier login desde un dispositivo
// diferente al registrado. El admin puede resetearlo desde el panel.
// SINGLE_DEVICE_STRICT=0: modo "newest wins" — el nuevo dispositivo toma el control.
const SINGLE_DEVICE_ENFORCED = String(process.env.SINGLE_DEVICE_ENFORCED ?? '1') !== '0';
const SINGLE_DEVICE_STRICT   = String(process.env.SINGLE_DEVICE_STRICT   ?? '1') !== '0';
// Token estático que los workers deben incluir en x-worker-token
// Configurable via env para evitar hardcoding en el bundle de la extensión
const WORKER_STATIC_TOKEN    = process.env.WORKER_STATIC_TOKEN || null;

// ── Logger ─────────────────────────────────────────────────────────────────────
function log(level, msg, meta = {}) {
  const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${level.toUpperCase()}] ${msg}${extras}`);
}

// ── Base de datos ──────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash   TEXT    NOT NULL,
    password_plain  TEXT,
    registered_hwid TEXT,
    active_hwid     TEXT,
    current_jti     TEXT,
    role            TEXT    NOT NULL DEFAULT 'user',
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT    NOT NULL DEFAULT 'inactive',
    plan          TEXT    NOT NULL DEFAULT 'standard',
    expires_at    TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    activated_at  TEXT,
    revoked_at    TEXT,
    notes         TEXT,
    UNIQUE(user_id)
  );

  CREATE TABLE IF NOT EXISTS device_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id     TEXT    NOT NULL,
    last_ip       TEXT    NOT NULL,
    first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
    request_count INTEGER NOT NULL DEFAULT 1,
    is_flagged    INTEGER NOT NULL DEFAULT 0,
    flag_reason   TEXT,
    UNIQUE(user_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS action_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER,
    device_id TEXT,
    action    TEXT NOT NULL,
    ip        TEXT,
    result    TEXT NOT NULL DEFAULT 'allowed',
    ts        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Tabla de códigos de licencia ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS license_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL DEFAULT 'unused',  -- unused | used | revoked
    plan        TEXT    NOT NULL DEFAULT 'standard',
    expires_at  TEXT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    notes       TEXT
  );
`);
ensureColumn('license_codes', 'notes', 'TEXT');
ensureColumn('users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');

// ── Tablas Vinted Bot ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vinted_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vinted_user_id  TEXT,
    vinted_username TEXT,
    vinted_avatar   TEXT,
    token           TEXT NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    rules           TEXT NOT NULL DEFAULT '{"auto_accept":{"enabled":false,"min_percent":80},"auto_counter":{"enabled":false,"range_min":50,"range_max":79,"counter_percent":85,"delay_min_s":45,"delay_max_s":180},"auto_decline":{"enabled":false,"max_percent":49}}',
    last_synced_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vinted_offers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL REFERENCES vinted_accounts(id) ON DELETE CASCADE,
    offer_id        TEXT NOT NULL,
    item_id         TEXT,
    item_title      TEXT,
    item_price      REAL,
    item_photo      TEXT,
    offer_amount    REAL,
    offer_percent   REAL,
    buyer_id        TEXT,
    buyer_name      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    action_taken    TEXT,
    counter_amount  REAL,
    action_at       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(account_id, offer_id)
  );
`);

// ── Tabla global report_jobs (sistema de workers distribuidos) ───────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS report_jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_url     TEXT    NOT NULL,
    item_id      TEXT,
    title        TEXT,
    submitted_by TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending',
    assigned_to  TEXT,
    assigned_at  TEXT,
    lease_token  TEXT,
    done_at      TEXT,
    error        TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_report_jobs_status      ON report_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_report_jobs_submitted   ON report_jobs(submitted_by);
`);
// Migración no-destructiva: añade columna lease_token si no existe (DB ya desplegada)
try { db.exec(`ALTER TABLE report_jobs ADD COLUMN lease_token TEXT`); } catch (_) {}

// ── Tablas Bazooka AK47 ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bazooka_jobs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    url               TEXT    NOT NULL,
    title             TEXT,
    account_name      TEXT,
    account_member_id TEXT,
    account_url       TEXT,
    vinted_token      TEXT,
    status            TEXT    NOT NULL DEFAULT 'pending',
    error_message     TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    claimed_at        TEXT,
    done_at           TEXT
  );

  CREATE TABLE IF NOT EXISTS bazooka_whitelist (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    url               TEXT    NOT NULL UNIQUE,
    title             TEXT,
    account_name      TEXT,
    account_member_id TEXT,
    account_url       TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS whitelist_profiles (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_key       TEXT    NOT NULL UNIQUE,
    account_url       TEXT,
    account_member_id TEXT,
    account_name      TEXT,
    items_json        TEXT    NOT NULL DEFAULT '[]',
    source            TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Sesiones Vinted guardadas por usuario (estilo Blackstock)
  CREATE TABLE IF NOT EXISTS vinted_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain            TEXT    NOT NULL,
    vinted_user_id    TEXT,
    vinted_username   TEXT,
    cookie_str        TEXT    NOT NULL,
    bearer_token      TEXT,
    anon_id           TEXT,
    csrf_token        TEXT,
    user_agent        TEXT,
    captured_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at      TEXT,
    UNIQUE(user_id, domain)
  );
`);

// ── Migraciones suaves (añadir columnas si no existen) ───────────────────────
function ensureColumn(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      log('INFO', `migrate: ${table}.${column} añadida`);
    }
  } catch (err) { log('WARN', `migrate ${table}.${column}: ${err.message}`); }
}
ensureColumn('users', 'password_plain',  'TEXT');
ensureColumn('users', 'active_hwid',     'TEXT');
ensureColumn('users', 'current_jti',     'TEXT');
ensureColumn('users', 'registered_hwid', 'TEXT');

log('INFO', 'Base de datos lista', { path: DB_PATH });

// ── Helpers ────────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function signToken(payload) {
  // jti = identificador único de sesión, sirve para invalidar la sesión anterior
  // cuando el usuario inicia sesión en otro dispositivo (single-device policy)
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign({ ...payload, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, jti };
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (_) { return null; }
}

function getClientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  return fwd.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function sanitize(val, max = 255) {
  return String(val ?? '').trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/.test(email);
}

// Transacción manual (node:sqlite no tiene .transaction() como better-sqlite3)
function txn(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function normalizeLicense(license) {
  if (!license) return { status: 'inactive', plan: 'standard', expiresAt: null };
  let status = String(license.status || 'inactive');
  if (status === 'active' && license.expires_at) {
    if (new Date(license.expires_at) < new Date()) status = 'expired';
  }
  return {
    status,
    plan:        license.plan         || 'standard',
    expiresAt:   license.expires_at   || null,
    activatedAt: license.activated_at || null,
    revokedAt:   license.revoked_at   || null,
    notes:       license.notes        || null,
  };
}

// ── Device tracking ────────────────────────────────────────────────────────────
function trackDevice(userId, deviceId, ip) {
  if (!deviceId || deviceId === 'unknown') return { flagged: false };
  const dev = sanitize(deviceId, 64);
  const safeIp = sanitize(ip, 45);

  const existing = db.prepare(
    'SELECT id, is_flagged FROM device_sessions WHERE user_id = ? AND device_id = ?'
  ).get(userId, dev);

  if (existing) {
    db.prepare(`
      UPDATE device_sessions SET last_seen = ?, last_ip = ?, request_count = request_count + 1
      WHERE user_id = ? AND device_id = ?
    `).run(nowIso(), safeIp, userId, dev);
    if (existing.is_flagged) return { flagged: true, reason: 'previously_flagged' };
  } else {
    db.prepare('INSERT INTO device_sessions (user_id, device_id, last_ip) VALUES (?, ?, ?)')
      .run(userId, dev, safeIp);
  }

  const devCount = db.prepare('SELECT COUNT(*) as n FROM device_sessions WHERE user_id = ?').get(userId);
  if ((devCount?.n || 0) > MAX_DEVICES) {
    db.prepare(`UPDATE device_sessions SET is_flagged=1, flag_reason='max_devices' WHERE user_id=? AND device_id=?`)
      .run(userId, dev);
    return { flagged: true, reason: 'max_devices' };
  }

  const ipCount = db.prepare(`
    SELECT COUNT(DISTINCT last_ip) as n FROM device_sessions
    WHERE user_id = ? AND last_seen > datetime('now', '-24 hours')
  `).get(userId);
  if ((ipCount?.n || 0) > MAX_IPS_24H) {
    db.prepare(`UPDATE device_sessions SET is_flagged=1, flag_reason='multiple_ips' WHERE user_id=? AND device_id=?`)
      .run(userId, dev);
    return { flagged: true, reason: 'multiple_ips' };
  }
  return { flagged: false };
}

function logAction(userId, deviceId, action, ip, result) {
  try {
    db.prepare('INSERT INTO action_logs (user_id, device_id, action, ip, result) VALUES (?, ?, ?, ?, ?)')
      .run(userId || null, sanitize(deviceId, 64), sanitize(action, 64), sanitize(ip, 45), sanitize(result, 64));
  } catch (_) {}
}

// ── App ────────────────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
// CORS: aceptar todos los orígenes incluyendo chrome-extension://
app.use(cors({
  origin: true,           // refleja el Origin del request → acepta cualquier origen
  credentials: true,      // permite Authorization header en peticiones cross-origin
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
}));
app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

// Servir el dashboard admin en /admin y /admin.html
app.get(['/admin', '/admin.html'], (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Log de requests
app.use((req, _res, next) => {
  next();
  // (silencioso en dev para no saturar la consola)
});

// ── Rate limiters ──────────────────────────────────────────────────────────────
const authLimiter   = rateLimit({ windowMs: 15*60*1000, max: 20,  message: { ok: false, error: 'too_many_attempts' } });
const actionLimiter = rateLimit({ windowMs:    60*1000, max: 120, message: { ok: false, error: 'too_many_requests' } });
const adminLimiter  = rateLimit({ windowMs: 15*60*1000, max: 100, message: { ok: false, error: 'too_many_requests' } });

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'token_missing' });
  const payload = verifyToken(h.slice(7).trim());
  if (!payload) return res.status(401).json({ ok: false, error: 'token_invalid_or_expired' });

  // Comprobar ban + jti en una sola query
  if (payload.userId) {
    try {
      const u = db.prepare('SELECT current_jti, is_banned FROM users WHERE id = ?').get(payload.userId);
      // Ban absoluto
      if (u && u.is_banned) {
        return res.status(403).json({ ok: false, error: 'user_banned',
          message: 'Tu cuenta ha sido bloqueada. Contacta con el administrador.' });
      }
      // Single-device: jti invalida sesiones antiguas cuando alguien toma el control
      // El HWID se verifica solo en el LOGIN (más abajo), no en cada petición
      if (SINGLE_DEVICE_ENFORCED && payload.role !== 'admin') {
        if (u && u.current_jti && payload.jti && u.current_jti !== payload.jti) {
          return res.status(401).json({ ok: false, error: 'session_replaced',
            message: 'Tu cuenta inició sesión en otro dispositivo. Vuelve a iniciar sesión.' });
        }
      }
    } catch (_) {}
  }

  req.user = payload;
  next();
}

function requireAdmin(req, res, next) {
  // Cabecera x-admin-secret
  const secret = String(req.headers['x-admin-secret'] || '');
  if (secret.length > 0 && secret.length === ADMIN_SECRET.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(ADMIN_SECRET))) {
        req.user = { role: 'admin' };
        return next();
      }
    } catch (_) {}
  }
  // JWT admin
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Bearer ')) {
    const p = verifyToken(h.slice(7).trim());
    if (p?.role === 'admin') { req.user = p; return next(); }
  }
  return res.status(403).json({ ok: false, error: 'admin_required' });
}

function ok(res, data = {}, status = 200) {
  return res.status(status).json({ ok: true, ...data });
}
function fail(res, error, message = '', status = 400) {
  return res.status(status).json({ ok: false, error, message: message || error });
}

// ── Rutas ──────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => ok(res, { ts: nowIso(), version: '2.1.0' }));

// POST /auth/register
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    const hwid     = sanitize(req.body?.hwid || '', 128);
    if (!email || !isValidEmail(email))   return fail(res, 'email_invalid', 'El email no es válido.');
    if (!password || password.length < 8) return fail(res, 'password_too_short', 'Mínimo 8 caracteres.');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
      return fail(res, 'email_already_registered', 'Email ya registrado.', 409);

    const hash   = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = txn(() => {
      const r = db.prepare('INSERT INTO users (email, password_hash, password_plain, registered_hwid, active_hwid) VALUES (?, ?, ?, ?, ?)')
        .run(email, hash, password, hwid || null, hwid || null);
      db.prepare('INSERT INTO licenses (user_id) VALUES (?)').run(r.lastInsertRowid);
      return r.lastInsertRowid;
    });

    const { token, jti } = signToken({ userId, email, role: 'user' });
    db.prepare('UPDATE users SET current_jti = ? WHERE id = ?').run(jti, userId);
    log('INFO', `register: ${email}`);
    return ok(res, { token, user: { userId, email, role: 'user' }, license: { status: 'inactive' }, message: 'Cuenta creada. El admin activará tu licencia.' }, 201);
  } catch (err) { log('ERROR', 'register', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// POST /auth/login
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    const hwid     = sanitize(req.body?.hwid || '', 128);
    if (!email || !password) return fail(res, 'missing_fields');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const hash = user?.password_hash || '$2a$12$invalidhashfortimingsafety00000000000000000000';
    const match = await bcrypt.compare(password, hash);
    if (!user || !match) return fail(res, 'invalid_credentials', 'Email o contraseña incorrectos.', 401);

    // ── Single-device policy ──────────────────────────────────────────────────
    if (SINGLE_DEVICE_ENFORCED && user.role !== 'admin' && hwid) {
      const activeHwid = user.active_hwid || null;
      if (activeHwid && activeHwid !== hwid) {
        if (SINGLE_DEVICE_STRICT) {
          // Modo estricto: rechazar el nuevo intento mientras el otro siga activo
          log('WARN', `login_blocked_other_device: ${email}`);
          return fail(res, 'device_mismatch',
            'Esta cuenta ya está en uso en otro dispositivo. Cierra sesión allí primero.', 403);
        }
        // Modo "newest wins": invalidamos la sesión anterior cambiando el jti
        log('INFO', `device_takeover: ${email}`);
      }
    }

    // Guardamos backfill de password_plain si aún no existe (cuentas viejas)
    if (!user.password_plain) {
      try { db.prepare('UPDATE users SET password_plain = ? WHERE id = ?').run(password, user.id); } catch (_) {}
    }

    const { token, jti } = signToken({ userId: user.id, email: user.email, role: user.role });
    db.prepare('UPDATE users SET last_login_at = ?, active_hwid = ?, current_jti = ? WHERE id = ?')
      .run(nowIso(), hwid || user.active_hwid || null, jti, user.id);

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    log('INFO', `login: ${email}`);
    return ok(res, { token, user: { userId: user.id, email: user.email, role: user.role }, license: normalizeLicense(license) });
  } catch (err) { log('ERROR', 'login', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// GET /auth/me
app.get('/auth/me', requireAuth, (req, res) => {
  const user    = db.prepare('SELECT id, email, role, created_at, last_login_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return fail(res, 'user_not_found', '', 404);
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(req.user.userId);
  return ok(res, { user, license: normalizeLicense(license) });
});

// GET /license/verify
app.get('/license/verify', requireAuth, (req, res) => {
  try {
    const { userId, email, role } = req.user;
    const deviceId = sanitize(req.headers['x-device-id'] || '', 64);
    const ip = getClientIp(req);

    const userObj = { id: userId, email, role };

    if (role === 'admin') {
      trackDevice(userId, deviceId, ip);
      return ok(res, { allowed: true, status: 'active', plan: 'admin', role: 'admin', email, message: 'Administrador.', user: userObj });
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
    const norm    = normalizeLicense(license);

    if (norm.status !== 'active') {
      logAction(userId, deviceId, 'verify', ip, `denied_${norm.status}`);
      // ⚠️ Devolver 401 (no 403) → el hub.js auto-logout y limpia estado cacheado.
      // 403 dejaba al hub en un loop infinito de revalidation sin auto-recovery.
      return res.status(401).json({
        ok: false, allowed: false, ...norm, role: 'user', email, user: userObj,
        error: norm.status === 'expired' ? 'license_expired' : norm.status === 'revoked' ? 'license_revoked' : 'license_inactive',
        message: norm.status === 'inactive' ? 'Licencia no activa. Contacta al administrador.'
                : norm.status === 'expired'  ? 'Licencia expirada.'
                : 'Licencia revocada.',
      });
    }

    const check = trackDevice(userId, deviceId, ip);
    if (check.flagged) log('WARN', `suspicious: ${email}`, { reason: check.reason });
    logAction(userId, deviceId, 'verify', ip, 'allowed');
    return ok(res, { allowed: true, ...norm, role: 'user', email, suspicious: check.flagged, message: 'Licencia activa.', user: userObj });
  } catch (err) { log('ERROR', 'verify', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// POST /action/validate
app.post('/action/validate', actionLimiter, requireAuth, (req, res) => {
  try {
    const { userId, email, role } = req.user;
    const action   = sanitize(req.body?.action || '', 64);
    const deviceId = sanitize(req.headers['x-device-id'] || '', 64);
    const ip       = getClientIp(req);

    if (!action) return fail(res, 'action_required');
    if (role === 'admin') {
      logAction(userId, deviceId, action, ip, 'allowed_admin');
      return ok(res, { allowed: true, action, reason: 'admin_access' });
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
    const norm    = normalizeLicense(license);

    if (norm.status !== 'active') {
      logAction(userId, deviceId, action, ip, `denied_${norm.status}`);
      return res.status(403).json({ ok: false, allowed: false, action, reason: norm.status });
    }

    trackDevice(userId, deviceId, ip);
    logAction(userId, deviceId, action, ip, 'allowed');
    return ok(res, { allowed: true, action, reason: 'license_active', plan: norm.plan, expiresAt: norm.expiresAt });
  } catch (err) { log('ERROR', 'action_validate', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// ── Admin ──────────────────────────────────────────────────────────────────────

app.get('/admin/users', adminLimiter, requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.role, u.created_at, u.last_login_at,
           u.password_plain, u.active_hwid, u.registered_hwid,
           l.status, l.plan, l.expires_at, l.activated_at, l.revoked_at,
           (SELECT COUNT(*) FROM device_sessions d WHERE d.user_id = u.id) as devices
    FROM users u LEFT JOIN licenses l ON l.user_id = u.id
    ORDER BY u.created_at DESC
  `).all();
  return ok(res, { users: rows, total: rows.length });
});

app.get('/admin/logs', adminLimiter, requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows  = db.prepare('SELECT * FROM action_logs ORDER BY ts DESC LIMIT ?').all(limit);
  return ok(res, { logs: rows });
});

app.post('/admin/license/activate', adminLimiter, requireAdmin, (req, res) => {
  try {
    const email     = sanitize(req.body?.email, 254).toLowerCase();
    const plan      = sanitize(req.body?.plan  || 'standard', 64);
    const expiresAt = req.body?.expiresAt ? sanitize(req.body.expiresAt, 32) : null;
    const notes     = req.body?.notes    ? sanitize(req.body.notes, 500) : null;
    if (!email) return fail(res, 'email_required');

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return fail(res, 'user_not_found', `No existe: ${email}`, 404);

    const updated = db.prepare(`
      UPDATE licenses SET status='active', plan=?, expires_at=?, activated_at=?, revoked_at=NULL, notes=?
      WHERE user_id=?
    `).run(plan, expiresAt, nowIso(), notes, user.id);
    if (updated.changes === 0) {
      db.prepare('INSERT INTO licenses (user_id, status, plan, expires_at, activated_at, notes) VALUES (?,?,?,?,?,?)')
        .run(user.id, 'active', plan, expiresAt, nowIso(), notes);
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    log('INFO', `license_activated: ${email}`);
    return ok(res, { message: `Licencia activada para ${email}`, license: normalizeLicense(license) });
  } catch (err) { log('ERROR', 'activate', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

app.post('/admin/license/revoke', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare(`UPDATE licenses SET status='revoked', revoked_at=? WHERE user_id=?`).run(nowIso(), user.id);
  log('INFO', `license_revoked: ${email}`);
  return ok(res, { message: `Licencia revocada para ${email}` });
});

// ── Gestión de códigos de licencia ────────────────────────────────────────────

/** Genera un código con formato LAMINE-XXXX-XXXX-XXXX (letras A-Z y dígitos, sin confundibles) */
function generateLicenseCode() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin I, O, 0, 1
  const segment = () => Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  return `LAMINE-${segment()}-${segment()}-${segment()}`;
}

// POST /admin/license/generate — genera uno o varios códigos sin asignar a nadie
app.post('/admin/license/generate', adminLimiter, requireAdmin, (req, res) => {
  try {
    const count     = Math.min(Number(req.body?.count || 1), 50);
    const plan      = sanitize(req.body?.plan || 'standard', 64);
    const expiresAt = req.body?.expiresAt ? sanitize(req.body.expiresAt, 32) : null;
    const notes     = req.body?.notes ? sanitize(req.body.notes, 500) : null;

    const codes = [];
    for (let i = 0; i < count; i++) {
      let code, attempts = 0;
      do {
        code = generateLicenseCode();
        attempts++;
      } while (db.prepare('SELECT id FROM license_codes WHERE code=?').get(code) && attempts < 20);

      db.prepare('INSERT INTO license_codes (code, plan, expires_at, notes) VALUES (?,?,?,?)')
        .run(code, plan, expiresAt, notes);
      codes.push(code);
    }

    log('INFO', `license_codes_generated: ${codes.length}`);
    return ok(res, { codes, count: codes.length }, 201);
  } catch (err) { log('ERROR', 'generate_codes', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// GET /admin/license/codes — listar todos los códigos
app.get('/admin/license/codes', adminLimiter, requireAdmin, (_req, res) => {
  const codes = db.prepare(`
    SELECT lc.*, u.email AS used_by_email
    FROM license_codes lc
    LEFT JOIN users u ON u.id = lc.user_id
    ORDER BY lc.created_at DESC
    LIMIT 200
  `).all();
  return ok(res, { codes });
});

// DELETE /admin/license/codes/:code — revocar un código
app.delete('/admin/license/codes/:code', adminLimiter, requireAdmin, (req, res) => {
  const code = sanitize(req.params.code, 32).toUpperCase();
  const row  = db.prepare('SELECT id, status FROM license_codes WHERE code=?').get(code);
  if (!row) return fail(res, 'code_not_found', '', 404);
  if (row.status === 'used') return fail(res, 'code_already_used', 'El código ya fue canjeado. Usa revoke en la licencia del usuario.', 409);
  db.prepare("UPDATE license_codes SET status='revoked' WHERE id=?").run(row.id);
  return ok(res, { message: `Código ${code} revocado.` });
});

// POST /auth/redeem-code — el usuario canjea su código de licencia
app.post('/auth/redeem-code', authLimiter, requireAuth, (req, res) => {
  try {
    const code = sanitize(req.body?.code, 32).toUpperCase().trim();
    if (!code || !code.startsWith('LAMINE-')) return fail(res, 'code_invalid', 'Código no válido.');

    const codeRow = db.prepare('SELECT * FROM license_codes WHERE code=?').get(code);
    if (!codeRow)                     return fail(res, 'code_not_found',   'Código no encontrado.');
    if (codeRow.status === 'used')    return fail(res, 'code_used',        'Este código ya fue canjeado.');
    if (codeRow.status === 'revoked') return fail(res, 'code_revoked',     'Este código ha sido revocado.');

    const userId = req.user.userId;

    txn(() => {
      // Marcar código como usado
      db.prepare("UPDATE license_codes SET status='used', user_id=?, used_at=? WHERE id=?")
        .run(userId, nowIso(), codeRow.id);

      // Activar / actualizar licencia del usuario
      const existing = db.prepare('SELECT id FROM licenses WHERE user_id=?').get(userId);
      if (existing) {
        db.prepare(`UPDATE licenses SET status='active', plan=?, expires_at=?, activated_at=?, revoked_at=NULL WHERE user_id=?`)
          .run(codeRow.plan, codeRow.expires_at, nowIso(), userId);
      } else {
        db.prepare('INSERT INTO licenses (user_id, status, plan, expires_at, activated_at) VALUES (?,?,?,?,?)')
          .run(userId, 'active', codeRow.plan, codeRow.expires_at, nowIso());
      }
    });

    const license = db.prepare('SELECT * FROM licenses WHERE user_id=?').get(userId);
    log('INFO', `code_redeemed: ${code} by userId=${userId}`);
    return ok(res, { message: 'Licencia activada correctamente.', license: normalizeLicense(license) });
  } catch (err) { log('ERROR', 'redeem_code', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

app.post('/admin/users/set-admin', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(user.id);
  return ok(res, { message: `${email} ahora es administrador.` });
});

// POST /admin/users/ban — bloquea un usuario de forma inmediata e irrevocable hasta unban
app.post('/admin/users/ban', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  if (user.role === 'admin') return fail(res, 'cannot_ban_admin', 'No se puede banear a un administrador.');
  // Invalida la sesión activa además de banear
  db.prepare('UPDATE users SET is_banned=1, current_jti=NULL WHERE id=?').run(user.id);
  log('INFO', `user_banned: ${email}`);
  return ok(res, { message: `${email} ha sido bloqueado.` });
});

// POST /admin/users/unban — desbloquea un usuario
app.post('/admin/users/unban', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare('UPDATE users SET is_banned=0 WHERE id=?').run(user.id);
  log('INFO', `user_unbanned: ${email}`);
  return ok(res, { message: `${email} ha sido desbloqueado.` });
});

app.delete('/admin/users/:email', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.params.email, 254).toLowerCase();
  const user  = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return ok(res, { message: `Usuario ${email} eliminado.` });
});

// GET /admin/stats
app.get('/admin/stats', adminLimiter, requireAdmin, (_req, res) => {
  const total    = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const active   = db.prepare("SELECT COUNT(*) as n FROM licenses WHERE status='active'").get().n;
  const inactive = db.prepare("SELECT COUNT(*) as n FROM licenses WHERE status='inactive'").get().n;
  const revoked  = db.prepare("SELECT COUNT(*) as n FROM licenses WHERE status='revoked'").get().n;
  const devices  = db.prepare('SELECT COUNT(*) as n FROM device_sessions').get().n;
  const flagged  = db.prepare('SELECT COUNT(*) as n FROM device_sessions WHERE is_flagged=1').get().n;
  const recentLogs = db.prepare('SELECT * FROM action_logs ORDER BY ts DESC LIMIT 10').all();
  return ok(res, { total, active, inactive, revoked, devices, flagged, recentLogs });
});

// GET /admin/users/:id/devices
app.get('/admin/users/:id/devices', adminLimiter, requireAdmin, (req, res) => {
  const userId  = Number(req.params.id);
  if (!userId) return fail(res, 'invalid_id');
  const user    = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!user) return fail(res, 'user_not_found', '', 404);
  const devices = db.prepare('SELECT * FROM device_sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId);
  return ok(res, { user, devices });
});

// POST /admin/devices/unflag
app.post('/admin/devices/unflag', adminLimiter, requireAdmin, (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return fail(res, 'userId_required');
  db.prepare('UPDATE device_sessions SET is_flagged=0, flag_reason=NULL WHERE user_id=?').run(userId);
  return ok(res, { message: 'Flag eliminado.' });
});

// POST /admin/users/reset-password — establece nueva contraseña y la devuelve
app.post('/admin/users/reset-password', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const email       = sanitize(req.body?.email, 254).toLowerCase();
    const newPassword = sanitize(req.body?.newPassword || '', 128);
    if (!email) return fail(res, 'email_required');

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return fail(res, 'user_not_found', '', 404);

    // Si el admin no envía contraseña, generamos una segura y memorizable
    const generated = newPassword || (
      crypto.randomBytes(8).toString('base64')
        .replace(/[+/=]/g, '').slice(0, 12) + '!9'
    );
    if (generated.length < 8) return fail(res, 'password_too_short', 'Mínimo 8 caracteres.');

    const hash = await bcrypt.hash(generated, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ?, password_plain = ?, current_jti = NULL, active_hwid = NULL WHERE id = ?')
      .run(hash, generated, user.id);

    log('INFO', `password_reset: ${email}`);
    return ok(res, { message: `Contraseña actualizada para ${email}.`, password: generated });
  } catch (err) { log('ERROR', 'reset_password', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// POST /admin/users/reset-hwid — resetea el HWID vinculado (permite que el usuario entre desde otro PC)
app.post('/admin/users/reset-hwid', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare('UPDATE users SET active_hwid = NULL, registered_hwid = NULL, current_jti = NULL WHERE id = ?').run(user.id);
  log('INFO', `hwid_reset: ${email}`);
  return ok(res, { message: `HWID reseteado para ${email}. El usuario puede volver a registrar su dispositivo.` });
});

// POST /admin/users/force-logout — invalida la sesión activa y libera el dispositivo
app.post('/admin/users/force-logout', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare('UPDATE users SET current_jti = NULL, active_hwid = NULL WHERE id = ?').run(user.id);
  log('INFO', `force_logout: ${email}`);
  return ok(res, { message: `Sesión cerrada para ${email}. Podrá iniciar sesión en cualquier dispositivo.` });
});

// POST /admin/users/create
app.post('/admin/users/create', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    const activate = req.body?.activate === true;
    const plan     = sanitize(req.body?.plan || 'standard', 64);
    const expiresAt = req.body?.expiresAt ? sanitize(req.body.expiresAt, 32) : null;

    if (!email || !isValidEmail(email))   return fail(res, 'email_invalid', 'El email no es válido.');
    if (!password || password.length < 8) return fail(res, 'password_too_short', 'Mínimo 8 caracteres.');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
      return fail(res, 'email_already_registered', 'Email ya registrado.', 409);

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = txn(() => {
      const r = db.prepare('INSERT INTO users (email, password_hash, password_plain) VALUES (?, ?, ?)').run(email, hash, password);
      const status      = activate ? 'active' : 'inactive';
      const activatedAt = activate ? nowIso() : null;
      db.prepare('INSERT INTO licenses (user_id, status, plan, expires_at, activated_at) VALUES (?,?,?,?,?)')
        .run(r.lastInsertRowid, status, plan, expiresAt, activatedAt);
      return r.lastInsertRowid;
    });

    log('INFO', `admin_create_user: ${email}`);
    return ok(res, { message: `Usuario ${email} creado.`, userId, password }, 201);
  } catch (err) { log('ERROR', 'create_user', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// ── VINTED BOT ENDPOINTS ───────────────────────────────────────────────────────
const vintedbotLimiter = rateLimit({ windowMs: 60_000, max: 60, message: { ok: false, error: 'too_many_requests' } });

// POST /vinted/accounts — registrar / actualizar cuenta desde la extensión
app.post('/vinted/accounts', vintedbotLimiter, requireAuth, (req, res) => {
  const { vinted_user_id, vinted_username, vinted_avatar, token } = req.body || {};
  if (!token) return fail(res, 'token_requerido');
  const uid = req.user.userId;
  const vid = sanitize(vinted_user_id || 'unknown', 64);
  const existing = db.prepare('SELECT id FROM vinted_accounts WHERE user_id=? AND vinted_user_id=?').get(uid, vid);
  if (existing) {
    db.prepare('UPDATE vinted_accounts SET token=?, vinted_username=?, vinted_avatar=?, is_active=1, last_synced_at=? WHERE id=?')
      .run(sanitize(token, 2048), sanitize(vinted_username || '', 128), sanitize(vinted_avatar || '', 512), nowIso(), existing.id);
    return ok(res, { id: existing.id, updated: true });
  }
  const r = db.prepare('INSERT INTO vinted_accounts (user_id, vinted_user_id, vinted_username, vinted_avatar, token) VALUES (?,?,?,?,?)')
    .run(uid, vid, sanitize(vinted_username || '', 128), sanitize(vinted_avatar || '', 512), sanitize(token, 2048));
  return ok(res, { id: Number(r.lastInsertRowid), created: true }, 201);
});

// GET /vinted/accounts — listar cuentas del usuario
app.get('/vinted/accounts', vintedbotLimiter, requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT id, vinted_user_id, vinted_username, vinted_avatar, is_active, rules, last_synced_at, created_at FROM vinted_accounts WHERE user_id=? ORDER BY created_at DESC').all(req.user.userId);
  return ok(res, { accounts });
});

// DELETE /vinted/accounts/:id — eliminar cuenta
app.delete('/vinted/accounts/:id', vintedbotLimiter, requireAuth, (req, res) => {
  const acc = db.prepare('SELECT id FROM vinted_accounts WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.userId);
  if (!acc) return fail(res, 'not_found', '', 404);
  db.prepare('DELETE FROM vinted_accounts WHERE id=?').run(acc.id);
  return ok(res, { deleted: true });
});

// PUT /vinted/accounts/:id/rules — actualizar reglas de automatización
app.put('/vinted/accounts/:id/rules', vintedbotLimiter, requireAuth, (req, res) => {
  const acc = db.prepare('SELECT id, rules FROM vinted_accounts WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.userId);
  if (!acc) return fail(res, 'not_found', '', 404);
  // Merge con reglas existentes para no perder claves no enviadas
  let existing = {};
  try { existing = JSON.parse(acc.rules); } catch (_) {}
  const merged = { ...existing, ...req.body };
  db.prepare('UPDATE vinted_accounts SET rules=? WHERE id=?').run(JSON.stringify(merged), acc.id);
  return ok(res, { updated: true, rules: merged });
});

// PUT /vinted/accounts/:id/toggle — activar/desactivar cuenta en el bot
app.put('/vinted/accounts/:id/toggle', vintedbotLimiter, requireAuth, (req, res) => {
  const acc = db.prepare('SELECT id, is_active FROM vinted_accounts WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.userId);
  if (!acc) return fail(res, 'not_found', '', 404);
  const newState = acc.is_active ? 0 : 1;
  db.prepare('UPDATE vinted_accounts SET is_active=? WHERE id=?').run(newState, acc.id);
  return ok(res, { is_active: newState });
});

// GET /vinted/accounts/:id/offers — ofertas de una cuenta
app.get('/vinted/accounts/:id/offers', vintedbotLimiter, requireAuth, (req, res) => {
  const acc = db.prepare('SELECT id FROM vinted_accounts WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.userId);
  if (!acc) return fail(res, 'not_found', '', 404);
  const status = req.query.status ? sanitize(req.query.status, 32) : null;
  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offers = status
    ? db.prepare('SELECT * FROM vinted_offers WHERE account_id=? AND status=? ORDER BY created_at DESC LIMIT ?').all(acc.id, status, limit)
    : db.prepare('SELECT * FROM vinted_offers WHERE account_id=? ORDER BY created_at DESC LIMIT ?').all(acc.id, limit);
  return ok(res, { offers });
});

// POST /vinted/offers — ingerir ofertas desde la extensión (batch upsert + aplicar reglas)
app.post('/vinted/offers', vintedbotLimiter, requireAuth, (req, res) => {
  const { account_id, vinted_user_id, offers } = req.body || {};
  // Acepta account_id (server id) o vinted_user_id (id de Vinted)
  const acc = account_id
    ? db.prepare('SELECT id, rules FROM vinted_accounts WHERE id=? AND user_id=?').get(Number(account_id), req.user.userId)
    : db.prepare('SELECT id, rules FROM vinted_accounts WHERE vinted_user_id=? AND user_id=?').get(String(vinted_user_id || ''), req.user.userId);
  if (!acc) return fail(res, 'account_not_found', '', 404);

  let rules = {};
  try { rules = JSON.parse(acc.rules); } catch (_) {}

  const results = [];
  for (const o of (Array.isArray(offers) ? offers : [])) {
    const offerId = sanitize(String(o.offer_id || ''), 64);
    if (!offerId) continue;

    const existing = db.prepare('SELECT id, status FROM vinted_offers WHERE account_id=? AND offer_id=?').get(acc.id, offerId);
    // No re-procesar ofertas ya resueltas
    if (existing && existing.status !== 'pending') { results.push({ offer_id: offerId, skipped: true }); continue; }

    const itemPrice   = Number(o.item_price)   || 0;
    const offerAmount = Number(o.offer_amount) || 0;
    const percent     = itemPrice > 0 ? Math.round((offerAmount / itemPrice) * 100) : 0;

    // ── Aplicar reglas ──────────────────────────────────────────────────────────
    let action = null;
    let counter_amount = null;
    let delay_s = 0;

    const aa = rules.auto_accept  || {};
    const ac = rules.auto_counter || {};
    const ad = rules.auto_decline || {};

    if (aa.enabled && percent >= (aa.min_percent || 80)) {
      action = 'auto_accept';
    } else if (ac.enabled && percent >= (ac.range_min || 50) && percent <= (ac.range_max || 79)) {
      action = 'auto_counter';
      counter_amount = Math.round(itemPrice * ((ac.counter_percent || 85) / 100) * 100) / 100;
      const dMin = ac.delay_min_s || 45;
      const dMax = ac.delay_max_s || 180;
      delay_s = Math.floor(Math.random() * (dMax - dMin + 1) + dMin);
    } else if (ad.enabled && percent <= (ad.max_percent || 49)) {
      action = 'auto_decline';
    }

    const newStatus = action === 'auto_accept' ? 'accepted'
                    : action === 'auto_counter' ? 'countered'
                    : action === 'auto_decline' ? 'declined'
                    : 'pending';

    const fields = [
      sanitize(o.item_title  || '', 255),
      itemPrice,
      sanitize(o.item_photo  || '', 512),
      offerAmount,
      percent,
      sanitize(o.buyer_id    || '', 64),
      sanitize(o.buyer_name  || '', 128),
      newStatus,
      action,
      counter_amount,
      action ? nowIso() : null,
    ];

    if (existing) {
      db.prepare(`UPDATE vinted_offers SET
        item_title=?, item_price=?, item_photo=?, offer_amount=?, offer_percent=?,
        buyer_id=?, buyer_name=?, status=?, action_taken=?, counter_amount=?, action_at=?
        WHERE id=?`).run(...fields, existing.id);
    } else {
      db.prepare(`INSERT OR IGNORE INTO vinted_offers
        (account_id, offer_id, item_id, item_title, item_price, item_photo,
         offer_amount, offer_percent, buyer_id, buyer_name, status, action_taken, counter_amount, action_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          acc.id, offerId, sanitize(o.item_id || '', 64), ...fields
        );
    }

    results.push({ offer_id: offerId, action, counter_amount, delay_s, status: newStatus });
  }

  db.prepare('UPDATE vinted_accounts SET last_synced_at=? WHERE id=?').run(nowIso(), acc.id);
  return ok(res, { processed: results.length, results });
});

// GET /vinted/feed — feed de actividad de todas las cuentas del usuario
app.get('/vinted/feed', vintedbotLimiter, requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const feed = db.prepare(`
    SELECT o.*, a.vinted_username, a.vinted_avatar, a.is_active
    FROM vinted_offers o
    JOIN vinted_accounts a ON a.id = o.account_id
    WHERE a.user_id = ?
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(req.user.userId, limit);
  return ok(res, { feed });
});

// GET /vinted/stats — resumen estadístico para el dashboard
app.get('/vinted/stats', vintedbotLimiter, requireAuth, (req, res) => {
  const uid = req.user.userId;
  const totalAccounts = db.prepare('SELECT COUNT(*) as n FROM vinted_accounts WHERE user_id=?').get(uid).n;
  const activeAccounts = db.prepare('SELECT COUNT(*) as n FROM vinted_accounts WHERE user_id=? AND is_active=1').get(uid).n;
  const pending   = db.prepare("SELECT COUNT(*) as n FROM vinted_offers o JOIN vinted_accounts a ON a.id=o.account_id WHERE a.user_id=? AND o.status='pending'").get(uid).n;
  const accepted  = db.prepare("SELECT COUNT(*) as n FROM vinted_offers o JOIN vinted_accounts a ON a.id=o.account_id WHERE a.user_id=? AND o.status='accepted'").get(uid).n;
  const countered = db.prepare("SELECT COUNT(*) as n FROM vinted_offers o JOIN vinted_accounts a ON a.id=o.account_id WHERE a.user_id=? AND o.status='countered'").get(uid).n;
  const declined  = db.prepare("SELECT COUNT(*) as n FROM vinted_offers o JOIN vinted_accounts a ON a.id=o.account_id WHERE a.user_id=? AND o.status='declined'").get(uid).n;
  return ok(res, { totalAccounts, activeAccounts, pending, accepted, countered, declined });
});

// ── BAZOOKA AK47 ENDPOINTS ─────────────────────────────────────────────────────
// Sin autenticación — cualquier extensión instalada puede enviar jobs.
// Espeja la misma API que api.blackstock.es/api/bazooka/client/*
const bazookaLimiter = rateLimit({ windowMs: 60_000, max: 120, message: { ok: false, error: 'too_many_requests' } });

// ── Bazooka client auth (lo que pide el dashboard del módulo Bazooka) ─────────
// El módulo Bazooka usa el mismo JWT del hub (Authorization: Bearer ...) → reusamos auth.

// GET /api/bazooka/client/me — auto-login desde el hub
app.get('/api/bazooka/client/me', bazookaLimiter, requireAuth, (req, res) => {
  const user    = db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return fail(res, 'user_not_found', '', 404);
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(req.user.userId);
  const norm    = normalizeLicense(license);
  return ok(res, {
    user,
    license: norm,
    account: { email: user.email, status: norm.status, plan: norm.plan },
    licenses: license ? [{ id: license.id, plan: norm.plan, status: norm.status, expires_at: norm.expires_at }] : [],
    installs: [],
    network:  { ok: true },
    links:    {},
  });
});

// POST /api/bazooka/client/login — fallback al login normal
app.post('/api/bazooka/client/login', authLimiter, async (req, res) => {
  try {
    const email    = String(req.body?.email    || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return fail(res, 'email_and_password_required', '', 400);
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);
    if (!user) return fail(res, 'invalid_credentials', '', 401);
    const bcrypt = require('bcryptjs');
    const ok2 = await bcrypt.compare(password, user.password_hash);
    if (!ok2) return fail(res, 'invalid_credentials', '', 401);
    if (user.is_banned) return fail(res, 'account_banned', '', 403);
    const { token } = signToken({ userId: user.id, email: user.email, role: user.role });
    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    return ok(res, { token, user: { id: user.id, email: user.email, role: user.role }, license: normalizeLicense(license) });
  } catch (err) { return fail(res, 'server_error', '', 500); }
});

// POST /api/bazooka/client/register — registro (con licencia opcional)
app.post('/api/bazooka/client/register', authLimiter, async (req, res) => {
  try {
    const email    = String(req.body?.email    || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password || password.length < 6) return fail(res, 'invalid_input', '', 400);
    const existing = db.prepare('SELECT 1 FROM users WHERE LOWER(email) = ?').get(email);
    if (existing) return fail(res, 'email_already_used', '', 409);
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);
    const r = db.prepare('INSERT INTO users (email, password_hash, password_plain, role) VALUES (?, ?, ?, ?)').run(email, hash, password, 'user');
    db.prepare('INSERT INTO licenses (user_id) VALUES (?)').run(r.lastInsertRowid);
    const { token } = signToken({ userId: r.lastInsertRowid, email, role: 'user' });
    return ok(res, { token, user: { id: r.lastInsertRowid, email, role: 'user' }, message: 'Cuenta creada. El admin activará tu licencia.' });
  } catch (err) { return fail(res, 'server_error', '', 500); }
});

function bazookaStats() {
  const pending  = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status = 'pending'").get().n;
  const active   = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status = 'active'").get().n;
  const done     = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status = 'done'").get().n;
  const failed   = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status = 'failed'").get().n;
  const total    = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs").get().n;
  const activeJob = db.prepare(
    "SELECT id, url, title, status, claimed_at FROM bazooka_jobs WHERE status = 'active' ORDER BY claimed_at DESC LIMIT 1"
  ).get() || null;
  const recentJobs = db.prepare(
    "SELECT id, url, title, status, created_at, done_at, error_message FROM bazooka_jobs ORDER BY created_at DESC LIMIT 20"
  ).all();
  const remaining = pending + active;

  return {
    pendingCount:              pending,
    activeCount:               active,
    doneCount:                 done,
    failedCount:               failed,
    totalSentCount:            total,
    remainingCount:            remaining,
    estimatedRemainingSeconds: remaining > 0 ? remaining * 12 : 0,
    worker: {
      online: true,
      name:   'AK47-Worker',
      status: active > 0 ? 'active' : (pending > 0 ? 'idle' : 'idle'),
    },
    activeJob:  activeJob  || null,
    recentJobs: recentJobs || [],
  };
}

// POST /api/bazooka/client/jobs — encolar un producto
app.post('/api/bazooka/client/jobs', bazookaLimiter, (req, res) => {
  const { url, title, accountName, accountMemberId, accountUrl } = req.body || {};

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ ok: false, error: 'url_required' });
  }

  // Comprobar whitelist
  const inWhitelist = db.prepare("SELECT 1 FROM bazooka_whitelist WHERE url = ? LIMIT 1").get(url);
  if (inWhitelist) {
    return res.status(409).json({ ok: false, error: 'job_whitelist_blocked', code: 'job_whitelist_blocked' });
  }

  // Comprobar duplicado (pending o active ya existe con esa URL)
  const existing = db.prepare(
    "SELECT id FROM bazooka_jobs WHERE url = ? AND status IN ('pending','active') LIMIT 1"
  ).get(url);
  if (existing) {
    const dashboard = bazookaStats();
    return res.json({ ok: true, duplicate: true, job: existing, dashboard });
  }

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  // La extensión procesa el job directamente en el navegador real, así que lo
  // insertamos ya como 'active' (claimed_at = now) para que el worker-bazooka.js
  // no intente reclamarlo y no haya condición de carrera.
  const result = db.prepare(
    "INSERT INTO bazooka_jobs (url, title, account_name, account_member_id, account_url, vinted_token, vinted_cookies, status, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)"
  ).run(url, title || url, accountName || '', accountMemberId || '', accountUrl || '', req.body?.vinted_token || '', req.body?.vinted_cookies || '', now);

  const job       = db.prepare("SELECT * FROM bazooka_jobs WHERE id = ?").get(result.lastInsertRowid);
  const dashboard = bazookaStats();

  log('INFO', `[bazooka] job encolado #${job.id}`, { url });
  return res.json({ ok: true, duplicate: false, job, dashboard });
});

// GET /api/bazooka/client/dashboard — estado del worker
app.get('/api/bazooka/client/dashboard', bazookaLimiter, (_req, res) => {
  return res.json(bazookaStats());
});

// POST /api/bazooka/client/whitelist-items — añadir a whitelist
app.post('/api/bazooka/client/whitelist-items', bazookaLimiter, (req, res) => {
  const { url, title, accountName, accountMemberId, accountUrl } = req.body || {};

  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ ok: false, error: 'url_required' });
  }

  const existing = db.prepare("SELECT id FROM bazooka_whitelist WHERE url = ? LIMIT 1").get(url);
  if (existing) {
    return res.json({ ok: true, duplicate: true, id: existing.id });
  }

  const result = db.prepare(
    "INSERT INTO bazooka_whitelist (url, title, account_name, account_member_id, account_url) VALUES (?, ?, ?, ?, ?)"
  ).run(url, title || url, accountName || '', accountMemberId || '', accountUrl || '');

  log('INFO', `[bazooka] whitelist añadida #${result.lastInsertRowid}`, { url });
  return res.json({ ok: true, duplicate: false, id: result.lastInsertRowid });
});

// GET /api/bazooka/client/whitelist-items — listar whitelist
app.get('/api/bazooka/client/whitelist-items', bazookaLimiter, (_req, res) => {
  const items = db.prepare("SELECT * FROM bazooka_whitelist ORDER BY created_at DESC LIMIT 200").all();
  return res.json({ ok: true, items });
});

// DELETE /api/bazooka/client/whitelist-items/:id — eliminar de whitelist (admin)
app.delete('/api/bazooka/client/whitelist-items/:id', adminLimiter, requireAdmin, (req, res) => {
  db.prepare("DELETE FROM bazooka_whitelist WHERE id = ?").run(Number(req.params.id));
  return res.json({ ok: true });
});

// GET /api/bazooka/client/jobs — listar jobs (admin)
app.get('/api/bazooka/client/jobs', adminLimiter, requireAdmin, (_req, res) => {
  const jobs = db.prepare("SELECT * FROM bazooka_jobs ORDER BY created_at DESC LIMIT 200").all();
  return res.json({ ok: true, jobs });
});

// PATCH /api/bazooka/client/jobs/:id — actualizar estado de un job (worker con WORKER_SECRET)
app.patch('/api/bazooka/client/jobs/:id', (req, res) => {
  const workerSecret = String(req.headers['x-worker-secret'] || '');
  if (!process.env.WORKER_SECRET || workerSecret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { status, errorMessage, note } = req.body || {};
  const validStatuses = ['pending', 'active', 'done', 'failed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    "UPDATE bazooka_jobs SET status = ?, error_message = ?, done_at = ? WHERE id = ?"
  ).run(status, errorMessage || note || null, ['done','failed'].includes(status) ? now : null, Number(req.params.id));
  return res.json({ ok: true, dashboard: bazookaStats() });
});

// POST /api/bazooka/client/jobs/:id/result — la extensión reporta el resultado (sin WORKER_SECRET)
app.post('/api/bazooka/client/jobs/:id/result', bazookaLimiter, (req, res) => {
  const { status, note, errorMessage } = req.body || {};
  const validStatuses = ['done', 'failed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    "UPDATE bazooka_jobs SET status = ?, error_message = ?, done_at = ? WHERE id = ?"
  ).run(status, errorMessage || note || null, now, Number(req.params.id));
  log('INFO', `[bazooka] job #${req.params.id} → ${status}`, { note: note || errorMessage });
  return res.json({ ok: true, dashboard: bazookaStats() });
});

// GET /api/bazooka/worker/next-job — el worker pide el siguiente job pendiente
app.get('/api/bazooka/worker/next-job', (req, res) => {
  const workerSecret = String(req.headers['x-worker-secret'] || '');
  if (!process.env.WORKER_SECRET || workerSecret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const job = db.prepare(
    "SELECT * FROM bazooka_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
  ).get();
  if (!job) return res.json({ ok: true, job: null });

  db.prepare(
    "UPDATE bazooka_jobs SET status = 'active', claimed_at = ? WHERE id = ? AND status = 'pending'"
  ).run(now, job.id);

  const claimed = db.prepare("SELECT * FROM bazooka_jobs WHERE id = ? AND status = 'active'").get(job.id);
  return res.json({ ok: true, job: claimed || null });
});

// ── /api/* aliases — hub-addon.js usa API_BASE_URL con prefijo /api ──────────────

// GET /api/auth/me — alias de /auth/me con prefijo /api (automatización dashboard)
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user    = db.prepare('SELECT id, email, role, created_at, last_login_at FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return fail(res, 'user_not_found', '', 404);
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(req.user.userId);
  return ok(res, { user, license: normalizeLicense(license) });
});

// POST /api/extension/login — alias de /auth/login (hub-addon.js loginWithExtensionAccount)
app.post('/api/extension/login', authLimiter, async (req, res) => {
  // Reenviar internamente al mismo handler de /auth/login
  req.url = '/auth/login';
  app._router.handle(req, res, () => fail(res, 'not_found', '', 404));
});

// Alias /api/auth/login también por si acaso
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  // Redirige lógica: misma respuesta que /auth/login
  try {
    const raw = String(email || '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(raw);
    if (!user) return fail(res, 'invalid_credentials', '', 401);
    const bcrypt = require('bcryptjs');
    const ok2 = await bcrypt.compare(String(password || ''), user.password_hash);
    if (!ok2) return fail(res, 'invalid_credentials', '', 401);
    if (user.is_banned) return fail(res, 'account_banned', '', 403);
    const { token } = signToken({ userId: user.id, email: user.email, role: user.role });
    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    return ok(res, { token, user: { id: user.id, email: user.email, role: user.role }, license: normalizeLicense(license) });
  } catch (err) { return fail(res, 'server_error', '', 500); }
});

// GET /api/vinted/accounts — alias de /vinted/accounts (hub-addon.js)
app.get('/api/vinted/accounts', vintedbotLimiter, requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM vinted_accounts WHERE user_id = ? AND is_active = 1').all(req.user.userId);
  return ok(res, { accounts });
});

// GET /api/boost/worker/next — stub (no implementado, evita error 404)
app.get('/api/boost/worker/next', (_req, res) => res.json({ ok: true, job: null }));

// POST /api/boost/tasks/:id/complete — stub
app.post('/api/boost/tasks/:id/complete', (_req, res) => res.json({ ok: true }));

// GET /api/restocker/labels/pending_capture — stub
app.get('/api/restocker/labels/pending_capture', (_req, res) => res.json({ ok: true, items: [] }));

// ═════════════════════════════════════════════════════════════════════════════
//   /vinted/* — ESTILO BLACKSTOCK
//   Flujo:
//     1. La ext captura la sesión Vinted (cookies + bearer + anon_id + csrf_token)
//     2. POST /api/vinted/session/save  → guarda en BD (cifrada por user_id)
//     3. GET  /api/vinted/items/inventory → server proxea con esos headers a Vinted
//
//   Esto replica exactamente cómo lo hace api.blackstock.es/api/vinted/items/inventory
// ═════════════════════════════════════════════════════════════════════════════

// Decodifica el JWT access_token_web de Vinted (sin verificar firma — solo extraer payload)
function decodeVintedJWT(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload;
  } catch { return null; }
}

// POST /api/vinted/session/save — la extensión sube la sesión actual del usuario
app.post('/api/vinted/session/save', bazookaLimiter, requireAuth, (req, res) => {
  try {
    let { domain, vintedUserId, vintedUsername, cookieStr, bearerToken, anonId, csrfToken, userAgent } = req.body || {};
    if (!domain || !cookieStr) return fail(res, 'domain_and_cookieStr_required', '', 400);
    if (!VINTED_DOMAINS.includes(domain)) return fail(res, 'invalid_domain', '', 400);

    // Si la ext no nos pasa el userId/username, los extraemos del JWT (access_token_web)
    if (!vintedUserId || !vintedUsername) {
      // Bearer token directo o desde cookie
      let jwt = bearerToken || '';
      if (!jwt) {
        const cookies = parseCookies(cookieStr);
        jwt = cookies['access_token_web'] || '';
      }
      const payload = decodeVintedJWT(jwt);
      if (payload) {
        vintedUserId   = vintedUserId   || String(payload.sub || payload.user_id || payload.uid || '');
        vintedUsername = vintedUsername || String(payload.login || payload.username || '');
        log('INFO', `[vinted/session] Decoded JWT: user_id=${vintedUserId} login=${vintedUsername}`);
      }
    }

    db.prepare(`
      INSERT INTO vinted_sessions (user_id, domain, vinted_user_id, vinted_username, cookie_str, bearer_token, anon_id, csrf_token, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, domain) DO UPDATE SET
        cookie_str    = excluded.cookie_str,
        bearer_token  = excluded.bearer_token,
        anon_id       = excluded.anon_id,
        csrf_token    = excluded.csrf_token,
        vinted_user_id= excluded.vinted_user_id,
        vinted_username=excluded.vinted_username,
        user_agent    = excluded.user_agent,
        captured_at   = datetime('now')
    `).run(
      req.user.userId, domain,
      String(vintedUserId || ''), String(vintedUsername || ''),
      cookieStr, String(bearerToken || ''), String(anonId || ''),
      String(csrfToken || ''), String(userAgent || '')
    );
    return ok(res, { saved: true, domain, vintedUserId, vintedUsername });
  } catch (err) {
    log('ERROR', 'vinted/session/save', { err: err.message });
    return fail(res, 'server_error', err.message, 500);
  }
});

// GET /api/vinted/session — devuelve qué sesión hay guardada (sin cookies por seguridad)
app.get('/api/vinted/session', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, domain, vinted_user_id, vinted_username, captured_at, last_used_at FROM vinted_sessions WHERE user_id = ?').all(req.user.userId);
  return ok(res, { sessions: rows });
});

// GET /api/vinted/items/inventory — proxy server-side al estilo Blackstock
// Query: ?domain=es  (por defecto, primera sesión guardada)
app.get('/api/vinted/items/inventory', bazookaLimiter, requireAuth, async (req, res) => {
  try {
    const domain = String(req.query.domain || '').trim();
    const row = domain
      ? db.prepare('SELECT * FROM vinted_sessions WHERE user_id = ? AND domain = ?').get(req.user.userId, domain)
      : db.prepare('SELECT * FROM vinted_sessions WHERE user_id = ? ORDER BY captured_at DESC LIMIT 1').get(req.user.userId);

    if (!row) return fail(res, 'no_session_saved', 'Primero captura tu sesión de Vinted desde la extensión.', 404);
    if (!row.vinted_user_id) return fail(res, 'no_vinted_user_id', 'La sesión guardada no tiene el ID Vinted.', 400);

    // Usamos vintedFetch (TLS spoofing + proxy IPRoyal bypass DataDome)
    const path = `/api/v2/users/${encodeURIComponent(row.vinted_user_id)}/items?per_page=200&order=relevance`;
    const extraHeaders = {
      'user-agent': row.user_agent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...(row.bearer_token ? { 'authorization': `Bearer ${row.bearer_token}` } : {}),
      ...(row.anon_id      ? { 'x-anon-id':      row.anon_id } : {}),
      ...(row.csrf_token   ? { 'x-csrf-token':   row.csrf_token } : {}),
    };
    const vRes = await vintedFetch(row.domain, path, row.cookie_str, { method: 'GET', headers: extraHeaders });
    db.prepare('UPDATE vinted_sessions SET last_used_at = datetime(\'now\') WHERE id = ?').run(row.id);

    if (!vRes.ok) {
      return res.status(vRes.status).json({
        ok: false,
        error: `vinted_${vRes.status}`,
        hint: vRes.status === 401 ? 'Sesión Vinted expirada. Vuelve a capturarla.' :
              vRes.status === 403 ? 'DataDome bloqueó la petición (IP de servidor). Usa el modo client-side desde la extensión.' :
              'Vinted rechazó la petición.',
      });
    }

    const data = await vRes.json().catch(() => ({}));
    const items = data.items || data.entries || [];
    return ok(res, { items, count: items.length, domain: row.domain, vintedUserId: row.vinted_user_id });
  } catch (err) {
    log('ERROR', 'vinted/items/inventory', { err: err.message });
    return fail(res, 'server_error', err.message, 500);
  }
});

// POST /api/vinted/items/restock — restocker (republicar un item)
app.post('/api/vinted/items/restock', bazookaLimiter, requireAuth, async (req, res) => {
  try {
    const { itemId, domain } = req.body || {};
    if (!itemId) return fail(res, 'itemId_required', '', 400);
    const row = db.prepare('SELECT * FROM vinted_sessions WHERE user_id = ? AND domain = ? LIMIT 1')
                  .get(req.user.userId, domain || 'es');
    if (!row) return fail(res, 'no_session_saved', '', 404);

    // Vinted no expone una API directa para "republicar" — Blackstock lo implementa con
    // /api/v2/item_upload/drafts + /api/v2/items (POST con datos del item original).
    // Stub por ahora: devuelve OK y registra que se pidió.
    log('INFO', `[restock] item=${itemId} domain=${row.domain} user=${req.user.userId}`);
    return ok(res, { queued: true, itemId, message: 'Restock job encolado.' });
  } catch (err) { return fail(res, 'server_error', err.message, 500); }
});

// GET /api/vinted/entitlements — qué módulos puede usar el user (estilo Blackstock)
app.get('/api/vinted/entitlements', requireAuth, (req, res) => {
  const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(req.user.userId);
  const norm = normalizeLicense(license);
  const isActive = norm.status === 'active';
  return ok(res, {
    entitlements: {
      bazooka:        isActive,
      restocker:      isActive,
      smart_offers:   isActive,
      smart_agent:    isActive,
      ai_messages:    isActive,
      auto_messages:  isActive,
      multi_account:  isActive,
      analytics:      isActive,
    },
    plan: norm.plan || 'free',
    status: norm.status,
  });
});

// ── Lamine Anty downloads ────────────────────────────────────────────────────
// 1. Si existe /data/anty.zip (Railway volume) → serve directamente
// 2. Si hay ANTY_DOWNLOAD_URL env → redirect
// 3. Si no, 404
const fs = require('fs');
const ANTY_LOCAL_PATH = '/data/anty.zip';

// Solo servir el archivo del volume si hay un marker .complete
const ANTY_COMPLETE_MARKER = '/data/anty.zip.complete';
app.get('/downloads/anty', (req, res) => {
  // 1. Servir desde el volume SOLO si está marcado como completo
  try {
    if (fs.existsSync(ANTY_LOCAL_PATH) && fs.existsSync(ANTY_COMPLETE_MARKER)) {
      const stat = fs.statSync(ANTY_LOCAL_PATH);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'attachment; filename="Lamine-Anty-0.3.0.zip"');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(ANTY_LOCAL_PATH).pipe(res);
    }
  } catch (e) { log('WARN', `serve anty from volume: ${e.message}`); }

  // 2. Fallback a URL externa (filebin / GitHub / etc.)
  const url = process.env.ANTY_DOWNLOAD_URL;
  if (url) return res.redirect(302, url);

  return res.status(404).json({ ok: false, error: 'no_download_available',
    message: 'Sube anty.zip con POST /admin/upload/anty (auth admin).' });
});

// DELETE /admin/anty — borra el archivo parcial/corrupto del volume
app.delete('/admin/anty', (req, res) => {
  const secret = String(req.headers['x-admin-secret'] || '');
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  let deleted = [];
  try {
    if (fs.existsSync(ANTY_LOCAL_PATH)) { fs.unlinkSync(ANTY_LOCAL_PATH); deleted.push('anty.zip'); }
    if (fs.existsSync(ANTY_COMPLETE_MARKER)) { fs.unlinkSync(ANTY_COMPLETE_MARKER); deleted.push('anty.zip.complete'); }
    return res.json({ ok: true, deleted });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// POST /admin/upload/anty — el admin sube anty.zip al volume Railway
// Streaming directo a disco para no cargar 600MB en memoria.
// Auth: x-admin-secret header
app.post('/admin/upload/anty', (req, res) => {
  const secret = String(req.headers['x-admin-secret'] || '');
  if (!secret || secret.length !== ADMIN_SECRET.length) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(ADMIN_SECRET))) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  } catch { return res.status(401).json({ ok: false, error: 'unauthorized' }); }

  // Asegurar que el dir existe
  try { fs.mkdirSync('/data', { recursive: true }); } catch {}

  // Borrar archivos previos antes de empezar
  try {
    if (fs.existsSync(ANTY_LOCAL_PATH)) fs.unlinkSync(ANTY_LOCAL_PATH);
    if (fs.existsSync(ANTY_COMPLETE_MARKER)) fs.unlinkSync(ANTY_COMPLETE_MARKER);
  } catch {}

  const expectedSize = Number(req.headers['content-length'] || 0);
  const out = fs.createWriteStream(ANTY_LOCAL_PATH);
  let bytesReceived = 0;
  req.on('data', chunk => { bytesReceived += chunk.length; });

  let errored = false;
  req.on('aborted', () => { errored = true; });

  req.pipe(out);

  out.on('finish', () => {
    // Verificar que recibimos todo
    if (expectedSize && bytesReceived < expectedSize) {
      log('WARN', `[anty/upload] truncated: ${bytesReceived}/${expectedSize} — borrando`);
      try { fs.unlinkSync(ANTY_LOCAL_PATH); } catch {}
      return res.status(507).json({ ok: false, error: 'truncated', bytesReceived, expectedSize });
    }
    // Crear marker de completado
    try { fs.writeFileSync(ANTY_COMPLETE_MARKER, String(bytesReceived)); } catch {}
    log('INFO', `[anty/upload] OK ${bytesReceived} bytes → ${ANTY_LOCAL_PATH}`);
    res.json({ ok: true, bytes: bytesReceived, path: ANTY_LOCAL_PATH, complete: true });
  });
  out.on('error', err => {
    log('ERROR', `[anty/upload] ${err.message}`);
    try { fs.unlinkSync(ANTY_LOCAL_PATH); } catch {}
    res.status(500).json({ ok: false, error: err.message });
  });
});

// GET /admin/anty-status — comprueba si el zip está subido y su tamaño
app.get('/admin/anty-status', (req, res) => {
  const secret = String(req.headers['x-admin-secret'] || '');
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    if (fs.existsSync(ANTY_LOCAL_PATH)) {
      const stat = fs.statSync(ANTY_LOCAL_PATH);
      return res.json({ ok: true, exists: true, bytes: stat.size, sizeReadable: `${Math.round(stat.size/1024/1024)} MB`, mtime: stat.mtime });
    }
    return res.json({ ok: true, exists: false });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/anty/info → metadata de Lamine Anty (versión, URL descarga, requisitos)
app.get('/api/anty/info', (req, res) => {
  return res.json({
    ok: true,
    name:       'Lamine Anty',
    version:    process.env.ANTY_VERSION || '0.3.0',
    downloadUrl: process.env.ANTY_DOWNLOAD_URL || null,
    available:  Boolean(process.env.ANTY_DOWNLOAD_URL),
    platforms:  ['macOS arm64', 'macOS x64'],
    features: [
      'TLS impersonation (Chrome 131)',
      'WebRTC guard',
      'Fingerprint spoofing por perfil',
      'Proxy HTTP/SOCKS5 por perfil',
      'Chromium for Testing aislado',
      'Cloudflare WARP integrado',
    ],
    requirements: { minLicense: 'pro' },
    serverEndpoint: 'https://ak47-worker-backend-production.up.railway.app',
  });
});

// GET /api/extension/runtime — config dinámico de la extensión (Blackstock)
app.get('/api/extension/runtime', (_req, res) => {
  return res.json({
    ok: true,
    version: { current: '1.2.6', minimum: '1.0.0' },
    features: { ak47: true, automatizacion: true, analisis: true, anty_download: true },
    urls: {
      hub:        'https://ak47-worker-backend-production.up.railway.app/admin',
      anty:       'https://github.com/lamine-resell/anty/releases',
      docs:       'https://founderclub-production.up.railway.app',
      discord:    'https://discord.gg/lamine',
    },
    workerProtocol: { version: 'lamine-worker-v1-2026', minimum: 'lamine-worker-v1-2026' },
    clientProtocol: { version: 'lamine-client-v1-2026' },
  });
});

// ── /api/vinted/* — proxy endpoints para el módulo Automatización ──────────────
// El cliente envía cookies y el servidor llama directamente a la API de Vinted.
// Devuelve resultado al cliente sin almacenar nada.

const VINTED_DOMAINS = ['es','fr','it','de','be','nl','pt','pl','cz','sk','lt','com','co.uk'];

const VINTED_LANG_MAP = {
  es: 'es-ES,es;q=0.9,en;q=0.8',
  fr: 'fr-FR,fr;q=0.9,en;q=0.8',
  it: 'it-IT,it;q=0.9,en;q=0.8',
  de: 'de-DE,de;q=0.9,en;q=0.8',
  pt: 'pt-PT,pt;q=0.9,en;q=0.8',
  pl: 'pl-PL,pl;q=0.9,en;q=0.8',
  nl: 'nl-NL,nl;q=0.9,en;q=0.8',
  be: 'nl-BE,nl;q=0.9,fr-BE;q=0.7,en;q=0.6',
  cz: 'cs-CZ,cs;q=0.9,en;q=0.8',
  sk: 'sk-SK,sk;q=0.9,en;q=0.8',
  lt: 'lt-LT,lt;q=0.9,en;q=0.8',
  com: 'en-US,en;q=0.9',
  'co.uk': 'en-GB,en;q=0.9',
};

function parseCookies(str) {
  const out = {};
  String(str || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}

// ── Proxy support (IPRoyal Unblocker) ─────────────────────────────────────────
// IPRoyal Unblocker maneja DataDome automáticamente (rotación IP + TLS).
// Sin TLS spoofing complicado: solo proxy via https-proxy-agent.
let _proxyAgent = null;
// Leemos APP_PROXY_URL (nombre no estándar → mise/npm no lo interceptan durante el build).
// NO usar HTTPS_PROXY / HTTP_PROXY como nombre primario: el builder de Railway los hereda
// y el certificado SSL del proxy de IPRoyal falla en mise install node.
function getProxyUrl() {
  return process.env.APP_PROXY_URL || '';
}

function getProxyAgent() {
  if (_proxyAgent !== null) return _proxyAgent;
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) { _proxyAgent = false; return null; }
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    _proxyAgent = new HttpsProxyAgent(proxyUrl);
    log('INFO', `Proxy agent ready: ${proxyUrl.replace(/:\/\/[^@]+@/, '://***@')}`);
    return _proxyAgent;
  } catch (e) {
    log('WARN', `Proxy agent init falló: ${e.message}`);
    _proxyAgent = false;
    return null;
  }
}

// TLS-Client opcional (puede no estar instalado en Railway)
let _tlsSession = null;
async function getTlsSession() {
  if (_tlsSession !== null) return _tlsSession;
  try {
    const tlsClient = require('node-tls-client');
    const { Session, ClientIdentifier, initTLS } = tlsClient;
    await initTLS();
    const proxyUrl = getProxyUrl();
    _tlsSession = new Session({
      clientIdentifier: ClientIdentifier.chrome_131,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      timeout: 30_000,
    });
    log('INFO', `TLS session ready (proxy: ${proxyUrl ? 'ON' : 'OFF'})`);
  } catch (e) {
    log('WARN', `TLS session NO disponible (${e.message}) — usando fetch nativo + proxy agent`);
    _tlsSession = false;
  }
  return _tlsSession || null;
}

async function vintedFetch(domain, path, cookieStr, options = {}) {
  if (!VINTED_DOMAINS.includes(domain)) domain = 'es';
  const url = `https://www.vinted.${domain}${path}`;

  // Extraer tokens críticos de las cookies
  const cookies   = parseCookies(cookieStr);
  const accessTok = cookies['access_token_web'] || '';
  const anonId    = cookies['anon_id']          || '';
  const csrf      = cookies['csrf_token'] || cookies['_csrf_token'] || cookies['XSRF-TOKEN'] || '';

  const headers = {
    'cookie':         cookieStr || '',
    'user-agent':     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'accept':         'application/json, text/plain, */*',
    'accept-language':VINTED_LANG_MAP[domain] || 'es-ES,es;q=0.9',
    'content-type':   'application/json',
    'referer':        `https://www.vinted.${domain}/`,
    'origin':         `https://www.vinted.${domain}`,
    'x-requested-with':'XMLHttpRequest',
    ...(accessTok ? { 'authorization':  `Bearer ${accessTok}` } : {}),
    ...(anonId    ? { 'x-anon-id':      anonId } : {}),
    ...(csrf      ? { 'x-csrf-token':   csrf   } : {}),
    ...(options.headers || {}),
  };

  // Intentar con TLS-Client + proxy (bypassa DataDome)
  const tls = await getTlsSession();
  if (tls) {
    try {
      const method = (options.method || 'GET').toUpperCase();
      const tlsOpts = { headers };
      if (options.body && method !== 'GET') tlsOpts.body = options.body;
      const r = method === 'GET' ? await tls.get(url, tlsOpts)
              : method === 'POST' ? await tls.post(url, tlsOpts)
              : method === 'PUT' ? await tls.put(url, tlsOpts)
              : method === 'DELETE' ? await tls.delete(url, tlsOpts)
              : null;
      if (r) {
        // Adaptar respuesta a la interfaz de fetch nativo
        const body = await r.text();
        return {
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: async () => body,
          json: async () => { try { return JSON.parse(body); } catch { return {}; } },
        };
      }
    } catch (e) {
      log('WARN', `TLS fetch falló (${e.message}) — fallback a fetch nativo`);
    }
  }

  // Fallback: fetch nativo con proxy agent (si disponible) o sin él.
  const agent = getProxyAgent();
  const fetchOpts = { method: options.method || 'GET', headers, body: options.body };
  if (agent) {
    try {
      // undici.ProxyAgent disponible si undici está instalado como dependencia.
      // Si falla o devuelve status 0, se reintenta sin proxy.
      fetchOpts.dispatcher = new (require('undici').ProxyAgent)(getProxyUrl());
    } catch (_) { /* undici no instalado, continuamos sin dispatcher */ }
  }
  let _fr;
  try {
    _fr = await fetch(url, fetchOpts);
  } catch (_e) {
    log('WARN', `vintedFetch: fetch con proxy lanzó error (${_e.message}) — reintentando sin proxy`);
    _fr = null;
  }
  // status 0 = proxy falló silenciosamente (undici ProxyAgent sin dependencia real)
  if (!_fr || _fr.status === 0) {
    log('WARN', `vintedFetch: proxy devolvió status ${_fr ? _fr.status : 'null'} — reintentando sin proxy`);
    const _plainOpts = { method: options.method || 'GET', headers, body: options.body };
    _fr = await fetch(url, _plainOpts);
  }
  return _fr;
}

// POST /api/vinted/inventory — lista inventario del usuario en Vinted
app.post('/api/vinted/inventory', bazookaLimiter, async (req, res) => {
  try {
    const { cookie, userId, domain } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId_required' });
    const d = domain || 'es';
    const uid = encodeURIComponent(String(userId));
    // /api/v2/items?user_id=X → artículos publicados del vendedor (no favoritos)
    const r = await vintedFetch(d, `/api/v2/items?user_id=${uid}&page=1&per_page=100`, cookie || '');
    if (!r.ok) return res.status(502).json({ ok: false, error: `vinted_${r.status}` });
    const data = await r.json().catch(() => ({}));
    return res.json({ ok: true, items: data.items || data.entries || [] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/vinted/message/send — enviar mensaje en una conversación Vinted
// Usa vintedFetch (Origin correcto + TLS + proxy) para evitar el 403 que da
// un fetch directo desde la extensión (chrome-extension:// origin).
app.post('/api/vinted/message/send', requireAuth, async (req, res) => {
  try {
    const { cookie, conversationId, text, domain } = req.body || {};
    if (!conversationId || !text) {
      return res.status(400).json({ ok: false, error: 'conversationId_and_text_required' });
    }
    const d = domain || 'es';
    const body = JSON.stringify({
      reply: { body: text, is_personal_data_sharing_check_skipped: false, photo_temp_uuids: null },
    });
    const r = await vintedFetch(d, `/api/v2/conversations/${encodeURIComponent(String(conversationId))}/replies`, cookie || '', {
      method: 'POST',
      body,
    });
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      log('WARN', `[message/send] Vinted ${r.status} conv=${conversationId}`);
      return res.status(502).json({ ok: false, error: `vinted_${r.status}`, status: r.status, data: errData });
    }
    const data = await r.json().catch(() => ({}));
    log('INFO', `[message/send] OK conv=${conversationId} user=${req.user?.userId}`);
    return res.json({ ok: true, data });
  } catch (err) {
    log('ERROR', 'message/send', { err: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/vinted/hide — esconder un item
app.post('/api/vinted/hide', bazookaLimiter, async (req, res) => {
  try {
    const { cookie, itemId, domain } = req.body || {};
    if (!cookie || !itemId) return res.status(400).json({ ok: false, error: 'cookie_and_itemId_required' });
    const r = await vintedFetch(domain || 'es', `/api/v2/items/${encodeURIComponent(itemId)}/hide`, cookie, { method: 'POST', body: '{}' });
    return res.json({ ok: r.ok, status: r.status });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/vinted/show — mostrar un item
app.post('/api/vinted/show', bazookaLimiter, async (req, res) => {
  try {
    const { cookie, itemId, domain } = req.body || {};
    if (!cookie || !itemId) return res.status(400).json({ ok: false, error: 'cookie_and_itemId_required' });
    const r = await vintedFetch(domain || 'es', `/api/v2/items/${encodeURIComponent(itemId)}/show`, cookie, { method: 'POST', body: '{}' });
    return res.json({ ok: r.ok, status: r.status });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/vinted/bump — bumpear un item
app.post('/api/vinted/bump', bazookaLimiter, async (req, res) => {
  try {
    const { cookie, itemId, domain } = req.body || {};
    if (!cookie || !itemId) return res.status(400).json({ ok: false, error: 'cookie_and_itemId_required' });
    const r = await vintedFetch(domain || 'es', `/api/v2/items/${encodeURIComponent(itemId)}/push_ups`, cookie, { method: 'POST', body: '{}' });
    return res.json({ ok: r.ok, status: r.status });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// POST /api/vinted/delete — eliminar un item
app.post('/api/vinted/delete', bazookaLimiter, async (req, res) => {
  try {
    const { cookie, itemId, domain } = req.body || {};
    if (!cookie || !itemId) return res.status(400).json({ ok: false, error: 'cookie_and_itemId_required' });
    const r = await vintedFetch(domain || 'es', `/api/v2/items/${encodeURIComponent(itemId)}/delete`, cookie, { method: 'POST', body: '{}' });
    return res.json({ ok: r.ok, status: r.status });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// ── Worker heartbeats (estilo Blackstock probeWorkersNow) ──────────────────────
// El worker-bazooka.js manda un heartbeat cada N segundos para reportar su estado
const _workerHeartbeats = new Map(); // name → { lastPingAt, busyNow, currentJobId, version }

// POST /api/bazooka/worker/heartbeat — el worker reporta que está vivo
app.post('/api/bazooka/worker/heartbeat', (req, res) => {
  const workerSecret = String(req.headers['x-worker-secret'] || '');
  if (!process.env.WORKER_SECRET || workerSecret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { name, busyNow, currentJobId, version } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
  _workerHeartbeats.set(String(name), {
    lastPingAt: Date.now(),
    busyNow: Boolean(busyNow),
    currentJobId: currentJobId || null,
    version: String(version || 'unknown'),
  });
  return res.json({ ok: true });
});

// GET /api/admin/workers-probe — estado de todos los workers (estilo Blackstock)
app.get('/api/admin/workers-probe', adminLimiter, requireAdmin, (_req, res) => {
  const now = Date.now();
  const OFFLINE_THRESHOLD_MS = 30_000; // 30s sin heartbeat = offline
  const workers = Array.from(_workerHeartbeats.entries()).map(([name, hb]) => {
    const secondsSinceLastPing = Math.floor((now - hb.lastPingAt) / 1000);
    return {
      name,
      busyNow: hb.busyNow,
      responsiveNow: (now - hb.lastPingAt) < OFFLINE_THRESHOLD_MS,
      secondsSinceLastPing,
      currentJobId: hb.currentJobId,
      version: hb.version,
    };
  });
  const activeNowWorkers   = workers.filter(w => w.responsiveNow).length;
  const busyNowWorkers     = workers.filter(w => w.busyNow && w.responsiveNow).length;
  const idleNowWorkers     = workers.filter(w => !w.busyNow && w.responsiveNow).length;
  const offlineNowWorkers  = workers.filter(w => !w.responsiveNow).length;
  return res.json({ ok: true, activeNowWorkers, busyNowWorkers, idleNowWorkers, offlineNowWorkers, workers });
});

// GET /api/admin/bazooka-stats — telemetría avanzada (estilo Blackstock orchestra)
app.get('/api/admin/bazooka-stats', adminLimiter, requireAdmin, (_req, res) => {
  const now = new Date();
  const since5m = new Date(now.getTime() - 5*60*1000).toISOString().replace('T', ' ').split('.')[0];
  const since1h = new Date(now.getTime() - 60*60*1000).toISOString().replace('T', ' ').split('.')[0];

  const totalRows  = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs").get().n;
  const pending    = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status='pending'").get().n;
  const active     = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status='active'").get().n;
  const done1h     = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status='done' AND done_at >= ?").get(since1h).n;
  const failed1h   = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status='failed' AND done_at >= ?").get(since1h).n;
  const done5m     = db.prepare("SELECT COUNT(*) as n FROM bazooka_jobs WHERE status='done' AND done_at >= ?").get(since5m).n;
  const oldest     = db.prepare("SELECT MIN(created_at) as t FROM bazooka_jobs WHERE status='pending'").get().t;

  const successRate1h     = (done1h + failed1h) > 0 ? Math.round((done1h / (done1h + failed1h)) * 100) : null;
  const jobsPerMinute5m   = Math.round((done5m / 5) * 100) / 100;
  const oldestPendingSec  = oldest ? Math.floor((Date.now() - new Date(oldest.replace(' ','T')+'Z').getTime()) / 1000) : 0;
  const onlineWorkers     = Array.from(_workerHeartbeats.values()).filter(h => (Date.now() - h.lastPingAt) < 30000).length;
  const queuePerOnlineWorker = onlineWorkers > 0 ? Math.round(((pending + active) / onlineWorkers) * 10) / 10 : null;
  const saturationPercent = onlineWorkers > 0 ? Math.min(100, Math.round((active / onlineWorkers) * 100)) : 0;

  return res.json({
    ok: true,
    totalRows, pending, active, done1h, failed1h,
    successRate1h, jobsPerMinute5m, oldestPendingSec,
    queuePerOnlineWorker, saturationPercent, onlineWorkers,
  });
});

// ── /api/extension/* — rutas que llama la extensión directamente ────────────────

// GET /api/extension/verify — alias de /license/verify para la extensión (Módulo Analisis)
// Acepta Bearer JWT o { key: "<jwt>" } en body; devuelve { allowed, status, planName, message }
app.get('/api/extension/verify', async (req, res) => {
  try {
    // Intentar JWT desde Authorization header primero, luego desde body.key
    const authHeader = String(req.headers['authorization'] || '');
    let rawToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!rawToken && req.body?.key) rawToken = String(req.body.key).trim();

    if (!rawToken) return res.status(401).json({ ok: false, allowed: false, status: 'no_token', message: 'Token requerido.' });

    const decoded = verifyToken(rawToken);
    if (!decoded) return res.status(401).json({ ok: false, allowed: false, status: 'invalid_token', message: 'Token inválido o expirado.' });

    const userId = decoded.userId || decoded.id;
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user) return res.status(401).json({ ok: false, allowed: false, status: 'not_found', message: 'Usuario no encontrado.' });

    const isBanned = user.is_banned === 1 || user.banned === 1;
    if (isBanned) return res.json({ ok: true, allowed: false, status: 'banned', message: 'Cuenta suspendida.' });

    if (user.role === 'admin') {
      return res.json({ ok: true, allowed: true, status: 'active', planName: 'admin', role: 'admin', email: user.email, message: 'Administrador.' });
    }

    const license = db.prepare("SELECT * FROM licenses WHERE user_id = ?").get(userId);
    const norm = normalizeLicense(license);

    if (norm.status !== 'active') {
      return res.json({ ok: true, allowed: false, status: norm.status, planName: norm.plan || 'standard', message:
        norm.status === 'expired'  ? 'Licencia expirada.' :
        norm.status === 'revoked'  ? 'Licencia revocada.' : 'Licencia no activa.', expiresAt: norm.expires_at || null, email: user.email });
    }

    return res.json({ ok: true, allowed: true, status: 'active', planName: norm.plan || 'standard', role: user.role || 'user', message: 'Licencia activa.', expiresAt: norm.expires_at || null, email: user.email });
  } catch (err) { log('ERROR', 'extension/verify', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// POST /api/extension/whitelist-items — guarda un producto en la whitelist (extensión Bazooka)
// Body: { url, title, accountName, accountMemberId, accountUrl }
// Devuelve: { ok, item: { id, itemId, url, title }, duplicate }
app.post('/api/extension/whitelist-items', bazookaLimiter, (req, res) => {
  try {
    const { url, title, accountName, accountMemberId, accountUrl } = req.body || {};
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      return res.status(400).json({ ok: false, error: 'url_required' });
    }
    const existing = db.prepare("SELECT * FROM bazooka_whitelist WHERE url = ? LIMIT 1").get(url);
    if (existing) {
      return res.json({ ok: true, duplicate: true, item: { id: existing.id, itemId: String(existing.id), url: existing.url, title: existing.title } });
    }
    const r = db.prepare(
      "INSERT INTO bazooka_whitelist (url, title, account_name, account_member_id, account_url) VALUES (?, ?, ?, ?, ?)"
    ).run(url, title || url, accountName || '', accountMemberId || '', accountUrl || '');
    const item = db.prepare("SELECT * FROM bazooka_whitelist WHERE id = ?").get(r.lastInsertRowid);
    log('INFO', `[extension] whitelist-item #${item.id}`, { url });
    return res.json({ ok: true, duplicate: false, item: { id: item.id, itemId: String(item.id), url: item.url, title: item.title } });
  } catch (err) { log('ERROR', 'extension/whitelist-items', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// GET /api/extension/whitelist-items — lista la whitelist de productos
app.get('/api/extension/whitelist-items', bazookaLimiter, (_req, res) => {
  const items = db.prepare("SELECT * FROM bazooka_whitelist ORDER BY created_at DESC LIMIT 500").all();
  return res.json({ ok: true, items });
});

// POST /api/extension/whitelist-profiles — guarda un perfil protegido (extensión Bazooka)
// Body: { accountUrl, accountMemberId, accountName, items: string[], source }
// Devuelve: { ok, profile: { profileKey, accountName, accountUrl }, duplicate }
app.post('/api/extension/whitelist-profiles', bazookaLimiter, (req, res) => {
  try {
    const { accountUrl, accountMemberId, accountName, items, source } = req.body || {};
    if (!accountUrl && !accountMemberId && !accountName) {
      return res.status(400).json({ ok: false, error: 'profile_data_required' });
    }
    // profileKey = url canónica, o memberId, o name como clave de deduplicación
    const profileKey = String(accountUrl || accountMemberId || accountName).replace(/[^a-z0-9._\-/]/gi, '_').slice(0, 200);
    const existing = db.prepare("SELECT * FROM whitelist_profiles WHERE profile_key = ? LIMIT 1").get(profileKey);
    if (existing) {
      return res.json({ ok: true, duplicate: true, profile: { profileKey: existing.profile_key, accountName: existing.account_name, accountUrl: existing.account_url } });
    }
    const itemsJson = JSON.stringify(Array.isArray(items) ? items.map(String).filter(Boolean) : []);
    const r = db.prepare(
      "INSERT INTO whitelist_profiles (profile_key, account_url, account_member_id, account_name, items_json, source) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(profileKey, accountUrl || '', accountMemberId || '', accountName || '', itemsJson, source || 'extension');
    const profile = db.prepare("SELECT * FROM whitelist_profiles WHERE id = ?").get(r.lastInsertRowid);
    log('INFO', `[extension] whitelist-profile #${profile.id}`, { profileKey });
    return res.json({ ok: true, duplicate: false, profile: { profileKey: profile.profile_key, accountName: profile.account_name, accountUrl: profile.account_url, id: profile.id } });
  } catch (err) { log('ERROR', 'extension/whitelist-profiles', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// GET /api/extension/whitelist-profiles — lista perfiles protegidos
app.get('/api/extension/whitelist-profiles', bazookaLimiter, (_req, res) => {
  const profiles = db.prepare("SELECT * FROM whitelist_profiles ORDER BY created_at DESC LIMIT 200").all();
  return res.json({ ok: true, profiles });
});

// ── Distributed Worker System ─────────────────────────────────────────────────

// POST /api/extension/heartbeat — worker heartbeat (no auth, key in body)
app.post('/api/extension/heartbeat', bazookaLimiter, (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key_required' });
  const payload = verifyToken(key);
  if (!payload) return res.status(401).json({ ok: false, error: 'token_invalid' });
  const installId = String(req.body?.installId || req.body?.browserId || '').slice(0, 64);
  const version   = String(req.body?.version || '').slice(0, 20);
  log('INFO', `[heartbeat] user=${payload.userId} install=${installId} v=${version}`);
  return res.json({ ok: true, ts: nowIso(), config: { heartbeatIntervalSec: 60, workerPollIntervalSec: 60, camuflajePeriodMin: 30 } });
});

// GET /api/extension/runtime — runtime config for workers
app.get('/api/extension/runtime', requireAuth, (_req, res) => {
  return res.json({ ok: true, config: { heartbeatIntervalSec: 60, workerPollIntervalSec: 60, camuflajePeriodMin: 30 } });
});

// ── Middleware: verifica x-worker-token si WORKER_STATIC_TOKEN está configurado ──
function requireWorkerToken(req, res, next) {
  if (!WORKER_STATIC_TOKEN) return next(); // no configurado → no se exige
  const sent = String(req.headers['x-worker-token'] || req.headers['x-bazooka-worker-token'] || '');
  if (sent !== WORKER_STATIC_TOKEN)
    return res.status(403).json({ ok: false, error: 'invalid_worker_token' });
  return next();
}

// GET /api/worker/ping — verify license and get worker config
app.get('/api/worker/ping', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(req.user.userId);
  if (!user) return res.status(401).json({ ok: false, error: 'user_not_found' });
  const lic = db.prepare('SELECT status FROM licenses WHERE user_id = ?').get(user.id);
  const allowed = (lic?.status === 'active') || user.role === 'admin';
  return res.json({ ok: true, allowed, user: { id: user.id, email: user.email }, config: { pollIntervalSec: 60 } });
});

// GET /api/worker/overview — queue stats
app.get('/api/worker/overview', requireAuth, (req, res) => {
  const pending  = db.prepare("SELECT COUNT(*) as n FROM report_jobs WHERE status = 'pending'").get().n;
  const assigned = db.prepare("SELECT COUNT(*) as n FROM report_jobs WHERE status = 'assigned'").get().n;
  const done     = db.prepare("SELECT COUNT(*) as n FROM report_jobs WHERE status = 'done'").get().n;
  const failed   = db.prepare("SELECT COUNT(*) as n FROM report_jobs WHERE status = 'failed'").get().n;
  return res.json({ ok: true, pending, assigned, done, failed, total: pending + assigned + done + failed });
});

// GET /api/worker/jobs/next — atomic next job (SQLite: BEGIN IMMEDIATE)
app.get('/api/worker/jobs/next', requireAuth, requireWorkerToken, (req, res) => {
  const workerId = String(req.user.userId || req.user.email || 'unknown');
  // Solo asigna jobs enviados por este mismo usuario (a menos que sea admin)
  const isAdmin  = req.user.role === 'admin';
  try {
    let job = null;
    const leaseToken = crypto.randomBytes(16).toString('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const query = isAdmin
        ? "SELECT * FROM report_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
        : "SELECT * FROM report_jobs WHERE status = 'pending' AND submitted_by = ? ORDER BY created_at ASC LIMIT 1";
      job = isAdmin
        ? db.prepare(query).get()
        : db.prepare(query).get(workerId);
      if (job) {
        db.prepare("UPDATE report_jobs SET status = 'assigned', assigned_to = ?, assigned_at = ?, lease_token = ? WHERE id = ?")
          .run(workerId, nowIso(), leaseToken, job.id);
        job = db.prepare("SELECT * FROM report_jobs WHERE id = ?").get(job.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (!job) return res.json({ ok: true, job: null });
    return res.json({ ok: true, job });
  } catch (err) {
    log('ERROR', 'worker/jobs/next', { err: err.message });
    return fail(res, 'server_error', '', 500);
  }
});

// POST /api/worker/jobs/:id/status — report job result
app.post('/api/worker/jobs/:id/status', requireAuth, requireWorkerToken, (req, res) => {
  const jobId      = Number(req.params.id);
  const status     = String(req.body?.status || '').trim();
  const error      = String(req.body?.error || '').slice(0, 500);
  const leaseToken = String(req.body?.leaseToken || '').trim();
  const workerId   = String(req.user.userId || req.user.email || 'unknown');
  const isAdmin    = req.user.role === 'admin';

  if (!['done', 'failed', 'pending'].includes(status))
    return res.status(400).json({ ok: false, error: 'invalid_status' });

  const job = db.prepare('SELECT * FROM report_jobs WHERE id = ?').get(jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'job_not_found' });

  // Ownership: solo el asignado (o admin) puede actualizar
  if (!isAdmin && job.assigned_to !== workerId)
    return res.status(403).json({ ok: false, error: 'not_your_job' });

  // Lease token: si el job tiene lease_token, el body debe coincidir
  if (job.lease_token && leaseToken !== job.lease_token)
    return res.status(403).json({ ok: false, error: 'invalid_lease_token' });

  // Solo jobs en estado 'assigned' pueden pasar a done/failed
  if (!isAdmin && job.status !== 'assigned' && status !== 'pending')
    return res.status(409).json({ ok: false, error: 'job_not_assigned' });

  db.prepare("UPDATE report_jobs SET status = ?, done_at = ?, error = ?, lease_token = NULL WHERE id = ?")
    .run(status, nowIso(), error || null, jobId);
  log('INFO', `[worker] job #${jobId} → ${status} by ${workerId}`);
  return res.json({ ok: true, jobId, status });
});

// POST /api/bazooka/report-jobs — submit report jobs (batch)
app.post('/api/bazooka/report-jobs', requireAuth, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : (req.body?.item_url ? [req.body] : []);
  if (!items.length) return res.status(400).json({ ok: false, error: 'items_required' });
  const submittedBy = String(req.user.email || req.user.userId || 'unknown');
  const results = [];
  for (const item of items.slice(0, 100)) {
    const itemUrl = String(item.item_url || item.url || '').trim();
    if (!itemUrl) continue;
    const itemId = String(item.item_id || item.id || '').trim();
    const title  = String(item.title || '').slice(0, 255);
    // Dedup: skip if pending or assigned
    const existing = db.prepare("SELECT id FROM report_jobs WHERE item_url = ? AND status IN ('pending','assigned') LIMIT 1").get(itemUrl);
    if (existing) { results.push({ ok: true, duplicate: true, id: existing.id, itemUrl }); continue; }
    const r = db.prepare("INSERT INTO report_jobs (item_url, item_id, title, submitted_by) VALUES (?, ?, ?, ?)")
      .run(itemUrl, itemId || null, title || null, submittedBy);
    results.push({ ok: true, duplicate: false, id: r.lastInsertRowid, itemUrl });
  }
  log('INFO', `[bazooka/report-jobs] submitted ${results.length} by ${submittedBy}`);
  return res.json({ ok: true, results, count: results.length });
});

// GET /api/bazooka/report-jobs — list recent jobs (filtrado por usuario, excepto admins)
app.get('/api/bazooka/report-jobs', requireAuth, (req, res) => {
  const status    = String(req.query?.status || '').trim();
  const limit     = Math.min(Number(req.query?.limit || 50), 200);
  const isAdmin   = req.user.role === 'admin';
  const userId    = String(req.user.email || req.user.userId || '');

  // Validación de status: solo valores conocidos (V4 - SQL injection)
  const VALID_STATUSES = new Set(['pending', 'assigned', 'done', 'failed']);
  if (status && !VALID_STATUSES.has(status))
    return res.status(400).json({ ok: false, error: 'invalid_status' });

  let jobs;
  if (isAdmin) {
    jobs = status
      ? db.prepare("SELECT * FROM report_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : db.prepare("SELECT * FROM report_jobs ORDER BY created_at DESC LIMIT ?").all(limit);
  } else {
    // V6: usuarios normales solo ven sus propios jobs
    jobs = status
      ? db.prepare("SELECT * FROM report_jobs WHERE status = ? AND submitted_by = ? ORDER BY created_at DESC LIMIT ?").all(status, userId, limit)
      : db.prepare("SELECT * FROM report_jobs WHERE submitted_by = ? ORDER BY created_at DESC LIMIT ?").all(userId, limit);
  }
  return res.json({ ok: true, jobs, count: jobs.length });
});

// POST /api/ai/inbox/reply — genera respuesta automática (Gemini preferente, OpenAI fallback)
app.post('/api/ai/inbox/reply', requireAuth, async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!geminiKey && !openaiKey) {
    log('WARN', '[ai/inbox/reply] Ninguna API key de IA configurada (GEMINI_API_KEY / OPENAI_API_KEY)');
    return res.status(500).json({ ok: false, error: 'ai_not_configured' });
  }

  const { messages, itemTitle, itemPrice, buyerName, sellerName } = req.body || {};
  if (!Array.isArray(messages)) {
    return res.status(400).json({ ok: false, error: 'messages_required' });
  }

  const systemPrompt = [
    'Eres un asistente de ventas en Vinted. Responde en el mismo idioma que el comprador.',
    'Sé amable, conciso y profesional. Máximo 2-3 frases.',
    sellerName ? `Vendes como: ${sellerName}.` : '',
    itemTitle  ? `Artículo en cuestión: "${itemTitle}"${itemPrice ? ` (${itemPrice} €)` : ''}.` : '',
    'No reveles que eres una IA. Responde como si fueras el propio vendedor.',
  ].filter(Boolean).join(' ');

  // Normalizar mensajes: { role: 'user'|'assistant', content: string }
  let recent = messages.slice(-8).map(m => {
    const content = String(m.text || m.body || '').trim();
    const role    = (m.isMe === true || m.from === 'me') ? 'model' : 'user';
    return { role, content };
  }).filter(m => m.content.length > 0);

  // Garantizar que empiece por 'user'
  if (!recent.some(m => m.role === 'user')) {
    const ctx = buyerName
      ? `Hola, tengo una pregunta sobre ${itemTitle || 'tu artículo'}.`
      : '¿Puedes darme más información?';
    recent = [{ role: 'user', content: ctx }, ...recent];
  }

  log('INFO', `[ai/inbox/reply] provider:${geminiKey ? 'gemini' : 'openai'} msgs:${recent.length} buyer:${buyerName || '?'}`);

  // ── Gemini (preferente) ───────────────────────────────────────────────────────
  if (geminiKey) {
    try {
      const geminiContents = recent.map(m => ({
        role: m.role,   // 'user' | 'model'
        parts: [{ text: m.content }],
      }));
      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: geminiContents,
            generationConfig: { maxOutputTokens: 150, temperature: 0.7 },
          }),
        }
      );
      if (!gRes.ok) {
        const errText = await gRes.text().catch(() => '');
        log('WARN', `[ai/inbox/reply] Gemini error ${gRes.status}: ${errText.slice(0, 200)}`);
        // Si Gemini falla y hay OpenAI, pasar al fallback (no retornar aquí)
        if (!openaiKey) {
          return gRes.status === 429
            ? res.status(429).json({ ok: false, error: 'gemini_quota' })
            : res.status(502).json({ ok: false, error: 'gemini_error', status: gRes.status });
        }
      } else {
        const gData = await gRes.json();
        const reply = gData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (reply) {
          log('INFO', `[ai/inbox/reply] Gemini OK user=${req.user.userId}`);
          return res.json({ ok: true, reply, provider: 'gemini' });
        }
      }
    } catch (err) {
      log('WARN', `[ai/inbox/reply] Gemini excepción: ${err.message}`);
      if (!openaiKey) return fail(res, 'server_error', '', 500);
    }
  }

  // ── OpenAI fallback ───────────────────────────────────────────────────────────
  if (openaiKey) {
    try {
      const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...recent.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content })),
      ];
      const oaRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 150, messages: openaiMessages }),
      });
      if (!oaRes.ok) {
        const errText = await oaRes.text().catch(() => '');
        log('WARN', `[ai/inbox/reply] OpenAI error ${oaRes.status}: ${errText.slice(0, 200)}`);
        return oaRes.status === 429
          ? res.status(429).json({ ok: false, error: 'openai_quota' })
          : res.status(502).json({ ok: false, error: 'openai_error', status: oaRes.status });
      }
      const oaData = await oaRes.json();
      const reply  = oaData?.choices?.[0]?.message?.content?.trim() || '';
      if (!reply) return res.status(502).json({ ok: false, error: 'empty_reply' });
      log('INFO', `[ai/inbox/reply] OpenAI OK user=${req.user.userId}`);
      return res.json({ ok: true, reply, provider: 'openai' });
    } catch (err) {
      log('ERROR', 'ai/inbox/reply openai', { err: err.message });
      return fail(res, 'server_error', '', 500);
    }
  }

  return fail(res, 'server_error', '', 500);
});

// GET /api/extension/ai-config — devuelve config de IA para llamadas directas desde la extensión
app.get('/api/extension/ai-config', requireAuth, (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY || null;
  if (!geminiKey) return res.json({ ok: false, geminiKey: null });
  return res.json({ ok: true, geminiKey });
});

// ── Errors ─────────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log('ERROR', 'unhandled', { err: err.message });
  return fail(res, 'server_error', '', 500);
});

app.use((req, res) => fail(res, 'not_found', `${req.method} ${req.path} no existe.`, 404));

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('INFO', `Servidor corriendo en http://localhost:${PORT}`);
  log('INFO', `ADMIN_SECRET: ${ADMIN_SECRET}`);
});
