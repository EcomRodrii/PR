/**
 * Server updates para agregar protección HWID
 * Reemplaza los endpoints de auth y license verify
 */

// Agregar esta columna a la tabla de usuarios al migrar:
// ALTER TABLE users ADD COLUMN registered_hwid TEXT DEFAULT NULL;

// Agregar este función helper al servidor:
function getHwidFromDb(userId) {
  try {
    const user = db.prepare('SELECT registered_hwid FROM users WHERE id = ?').get(userId);
    return user?.registered_hwid || null;
  } catch (_) {
    return null;
  }
}

function setHwidInDb(userId, hwid) {
  try {
    db.prepare('UPDATE users SET registered_hwid = ? WHERE id = ?').run(hwid, userId);
    return true;
  } catch (_) {
    return false;
  }
}

// ============================================================================
// ENDPOINTS ACTUALIZADOS CON HWID
// ============================================================================

/**
 * POST /auth/login - Con validación HWID
 */
/*
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    const hwid     = sanitize(req.body?.hwid, 512); // Hardware ID del cliente
    
    if (!email || !password || !hwid) return fail(res, 'missing_fields');

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const hash = user?.password_hash || '$2a$12$invalidhashfortimingsafety00000000000000000000';
    const match = await bcrypt.compare(password, hash);
    if (!user || !match) return fail(res, 'invalid_credentials', 'Email o contraseña incorrectos.', 401);

    // Validar HWID
    const registeredHwid = getHwidFromDb(user.id);
    if (registeredHwid && registeredHwid !== hwid) {
      logAction(user.id, hwid, 'login_hwid_mismatch', getClientIp(req), 'denied');
      log('WARN', `HWID mismatch para usuario ${email}`, { 
        expected: registeredHwid?.slice(0, 8) + '...', 
        received: hwid?.slice(0, 8) + '...' 
      });
      return fail(res, 'hwid_mismatch', '⚠️ Esta cuenta está vinculada a otro dispositivo.', 403);
    }

    // Primer login: guardar HWID
    if (!registeredHwid) {
      setHwidInDb(user.id, hwid);
      log('INFO', `HWID registrado para ${email}`);
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(user.id);
    const token   = signToken({ userId: user.id, email: user.email, role: user.role });
    
    logAction(user.id, hwid, 'login', getClientIp(req), 'allowed');
    log('INFO', `login: ${email}`);
    return ok(res, { token, user: { userId: user.id, email: user.email, role: user.role }, license: normalizeLicense(license) });
  } catch (err) { 
    log('ERROR', 'login', { err: err.message }); 
    return fail(res, 'server_error', '', 500); 
  }
});
*/

/**
 * POST /auth/register - Con registro de HWID
 */
/*
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const email    = sanitize(req.body?.email, 254).toLowerCase();
    const password = sanitize(req.body?.password, 128);
    const hwid     = sanitize(req.body?.hwid, 512);
    
    if (!email || !password || !hwid) return fail(res, 'email_and_password_required');
    if (password.length < 8) return fail(res, 'password_too_short', 'La contraseña debe tener al menos 8 caracteres.');
    if (!email.includes('@')) return fail(res, 'email_invalid');

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return fail(res, 'email_already_registered');

    const hash  = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const stmt  = db.prepare('INSERT INTO users (email, password_hash, registered_hwid) VALUES (?, ?, ?)');
    const res2  = stmt.run(email, hash, hwid);
    const userId = res2.lastInsertRowid;

    const token = signToken({ userId, email, role: 'user' });
    logAction(userId, hwid, 'register', getClientIp(req), 'allowed');
    log('INFO', `register: ${email}`);
    return ok(res, { token, user: { userId, email, role: 'user' } });
  } catch (err) { 
    log('ERROR', 'register', { err: err.message }); 
    return fail(res, 'server_error', '', 500); 
  }
});
*/

/**
 * POST /license/verify - Con validación HWID
 */
/*
app.post('/license/verify', requireAuth, (req, res) => {
  try {
    const { userId, email, role } = req.user;
    const hwid   = sanitize(req.body?.hwid, 512);
    const ip     = getClientIp(req);

    // Validar HWID
    if (hwid) {
      const registeredHwid = getHwidFromDb(userId);
      if (registeredHwid && registeredHwid !== hwid) {
        logAction(userId, hwid, 'verify_hwid_mismatch', ip, 'denied');
        log('WARN', `HWID mismatch en verify para usuario ${email}`, { 
          expected: registeredHwid?.slice(0, 8) + '...', 
          received: hwid?.slice(0, 8) + '...' 
        });
        return res.status(403).json({
          ok: false, 
          allowed: false,
          error: 'hwid_mismatch',
          message: '⚠️ Este usuario está vinculado a otro dispositivo.',
        });
      }
    }

    if (role === 'admin') {
      trackDevice(userId, hwid || 'admin', ip);
      return ok(res, { allowed: true, status: 'active', plan: 'admin', email, message: 'Administrador.' });
    }

    const license = db.prepare('SELECT * FROM licenses WHERE user_id = ?').get(userId);
    const norm    = normalizeLicense(license);

    if (norm.status !== 'active') {
      logAction(userId, hwid || 'unknown', 'verify', ip, `denied_${norm.status}`);
      return res.status(403).json({
        ok: false, allowed: false, ...norm, email,
        message: norm.status === 'inactive' ? 'Licencia no activa. Contacta al administrador.'
                : norm.status === 'expired'  ? 'Licencia expirada.'
                : 'Licencia revocada.',
      });
    }

    const check = trackDevice(userId, hwid || 'unknown', ip);
    if (check.flagged) log('WARN', `suspicious: ${email}`, { reason: check.reason });
    logAction(userId, hwid || 'unknown', 'verify', ip, 'allowed');
    return ok(res, { allowed: true, ...norm, email, suspicious: check.flagged, message: 'Licencia activa.' });
  } catch (err) { 
    log('ERROR', 'verify', { err: err.message }); 
    return fail(res, 'server_error', '', 500); 
  }
});
*/

// ============================================================================
// MIGRACIÓN DE BD
// ============================================================================
// Al desplegar, ejecutar en la BD:
// sqlite3 licenses.db
// > ALTER TABLE users ADD COLUMN registered_hwid TEXT DEFAULT NULL;
// > CREATE INDEX idx_users_hwid ON users(registered_hwid);
// > .quit
