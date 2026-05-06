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

// ── Tablas Bazooka AK47 ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bazooka_jobs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    url               TEXT    NOT NULL,
    title             TEXT,
    account_name      TEXT,
    account_member_id TEXT,
    account_url       TEXT,
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

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: true }));   // localhost: aceptar todos los orígenes
app.use(express.json({ limit: '10kb' }));
app.set('trust proxy', 1);

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

    if (role === 'admin') {
      trackDevice(userId, deviceId, ip);
      return ok(res, { allowed: true, status: 'active', plan: 'admin', role: 'admin', email, message: 'Administrador.' });
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
    const norm    = normalizeLicense(license);

    if (norm.status !== 'active') {
      logAction(userId, deviceId, 'verify', ip, `denied_${norm.status}`);
      return res.status(403).json({
        ok: false, allowed: false, ...norm, role: 'user', email,
        message: norm.status === 'inactive' ? 'Licencia no activa. Contacta al administrador.'
                : norm.status === 'expired'  ? 'Licencia expirada.'
                : 'Licencia revocada.',
      });
    }

    const check = trackDevice(userId, deviceId, ip);
    if (check.flagged) log('WARN', `suspicious: ${email}`, { reason: check.reason });
    logAction(userId, deviceId, 'verify', ip, 'allowed');
    return ok(res, { allowed: true, ...norm, role: 'user', email, suspicious: check.flagged, message: 'Licencia activa.' });
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

  const result = db.prepare(
    "INSERT INTO bazooka_jobs (url, title, account_name, account_member_id, account_url) VALUES (?, ?, ?, ?, ?)"
  ).run(url, title || url, accountName || '', accountMemberId || '', accountUrl || '');

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

// PATCH /api/bazooka/client/jobs/:id — actualizar estado de un job (usado por el worker)
app.patch('/api/bazooka/client/jobs/:id', (req, res) => {
  const workerSecret = String(req.headers['x-worker-secret'] || '');
  if (!process.env.WORKER_SECRET || workerSecret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { status, errorMessage } = req.body || {};
  const validStatuses = ['pending', 'active', 'done', 'failed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status' });
  }
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    "UPDATE bazooka_jobs SET status = ?, error_message = ?, done_at = ? WHERE id = ?"
  ).run(status, errorMessage || null, ['done','failed'].includes(status) ? now : null, Number(req.params.id));
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
