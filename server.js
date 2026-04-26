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
    registered_hwid TEXT,
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

log('INFO', 'Base de datos lista', { path: DB_PATH });

// ── Helpers ────────────────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
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

app.get('/health', (_req, res) => ok(res, { ts: nowIso(), version: '2.0.0' }));

// POST /auth/register
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    if (!email || !isValidEmail(email))   return fail(res, 'email_invalid', 'El email no es válido.');
    if (!password || password.length < 8) return fail(res, 'password_too_short', 'Mínimo 8 caracteres.');
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email))
      return fail(res, 'email_already_registered', 'Email ya registrado.', 409);

    const hash   = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = txn(() => {
      const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
      db.prepare('INSERT INTO licenses (user_id) VALUES (?)').run(r.lastInsertRowid);
      return r.lastInsertRowid;
    });

    const token = signToken({ userId, email, role: 'user' });
    log('INFO', `register: ${email}`);
    return ok(res, { token, user: { userId, email, role: 'user' }, license: { status: 'inactive' }, message: 'Cuenta creada. El admin activará tu licencia.' }, 201);
  } catch (err) { log('ERROR', 'register', { err: err.message }); return fail(res, 'server_error', '', 500); }
});

// POST /auth/login
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    if (!email || !password) return fail(res, 'missing_fields');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const hash = user?.password_hash || '$2a$12$invalidhashfortimingsafety00000000000000000000';
    const match = await bcrypt.compare(password, hash);
    if (!user || !match) return fail(res, 'invalid_credentials', 'Email o contraseña incorrectos.', 401);

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    const token   = signToken({ userId: user.id, email: user.email, role: user.role });
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
      return ok(res, { allowed: true, status: 'active', plan: 'admin', email, message: 'Administrador.' });
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
    const norm    = normalizeLicense(license);

    if (norm.status !== 'active') {
      logAction(userId, deviceId, 'verify', ip, `denied_${norm.status}`);
      return res.status(403).json({
        ok: false, allowed: false, ...norm, email,
        message: norm.status === 'inactive' ? 'Licencia no activa. Contacta al administrador.'
                : norm.status === 'expired'  ? 'Licencia expirada.'
                : 'Licencia revocada.',
      });
    }

    const check = trackDevice(userId, deviceId, ip);
    if (check.flagged) log('WARN', `suspicious: ${email}`, { reason: check.reason });
    logAction(userId, deviceId, 'verify', ip, 'allowed');
    return ok(res, { allowed: true, ...norm, email, suspicious: check.flagged, message: 'Licencia activa.' });
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

app.post('/admin/users/set-admin', adminLimiter, requireAdmin, (req, res) => {
  const email = sanitize(req.body?.email, 254).toLowerCase();
  if (!email) return fail(res, 'email_required');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) return fail(res, 'user_not_found', '', 404);
  db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(user.id);
  return ok(res, { message: `${email} ahora es administrador.` });
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
      const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
      const status      = activate ? 'active' : 'inactive';
      const activatedAt = activate ? nowIso() : null;
      db.prepare('INSERT INTO licenses (user_id, status, plan, expires_at, activated_at) VALUES (?,?,?,?,?)')
        .run(r.lastInsertRowid, status, plan, expiresAt, activatedAt);
      return r.lastInsertRowid;
    });

    log('INFO', `admin_create_user: ${email}`);
    return ok(res, { message: `Usuario ${email} creado.`, userId }, 201);
  } catch (err) { log('ERROR', 'create_user', { err: err.message }); return fail(res, 'server_error', '', 500); }
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
