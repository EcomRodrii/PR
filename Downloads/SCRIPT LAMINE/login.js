// ── Constante de API (cámbiala a tu URL de producción) ────────────────────────
const AUTH_API_URL = 'http://localhost:3000';    // <-- cambia esto

// ── DOM ────────────────────────────────────────────────────────────────────────
const alertEl      = document.getElementById('alert');
const panelLogin   = document.getElementById('panel-login');
const panelReg     = document.getElementById('panel-register');
const panelPending = document.getElementById('panel-pending');

const loginEmail    = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginBtn      = document.getElementById('login-btn');
const goRegister    = document.getElementById('go-register');

const regEmail      = document.getElementById('reg-email');
const regPassword   = document.getElementById('reg-password');
const regPassword2  = document.getElementById('reg-password2');
const registerBtn   = document.getElementById('register-btn');
const goLogin       = document.getElementById('go-login');

const pendingLogout = document.getElementById('pending-logout');

// ── Helpers ────────────────────────────────────────────────────────────────────
function showAlert(msg, type = 'error') {
  alertEl.className = `alert ${type}`;
  alertEl.textContent = msg;
}

function clearAlert() {
  alertEl.className = 'alert';
  alertEl.textContent = '';
}

function showPanel(name) {
  panelLogin.classList.add('hidden');
  panelReg.classList.add('hidden');
  panelPending.classList.add('hidden');
  if (name === 'login')   panelLogin.classList.remove('hidden');
  if (name === 'register') panelReg.classList.remove('hidden');
  if (name === 'pending')  panelPending.classList.remove('hidden');
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  const orig = btn.dataset.origText || btn.textContent;
  if (!btn.dataset.origText) btn.dataset.origText = orig;
  btn.innerHTML = loading
    ? '<span class="spinner"></span>'
    : orig;
}

async function apiPost(path, body) {
  const res = await fetch(`${AUTH_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

// ── Lógica de autenticación ────────────────────────────────────────────────────
async function handleLogin() {
  clearAlert();
  const email    = loginEmail.value.trim();
  const password = loginPassword.value.trim();
  if (!email || !password) { showAlert('Rellena email y contraseña.'); return; }

  setLoading(loginBtn, true);
  try {
    const data = await apiPost('/auth/login', { email, password });

    if (!data.ok) {
      const msgs = {
        invalid_credentials: 'Email o contraseña incorrectos.',
        email_and_password_required: 'Rellena todos los campos.',
      };
      showAlert(msgs[data.error] || `Error: ${data.error || 'desconocido'}`);
      return;
    }

    // Guardar token
    await storageSet({
      lamine_auth_token: data.token,
      lamine_auth_email: data.user?.email || email,
      lamine_auth_role:  data.user?.role  || 'user',
    });

    // Comprobar si la licencia está activa
    const license = data.license || {};
    if (license.status === 'active') {
      // Redirigir al popup/dashboard y cerrar esta pestaña
      chrome.runtime.sendMessage({ action: 'rb:auth-login-success' });
      window.close();
    } else {
      showPanel('pending');
    }
  } catch (err) {
    showAlert(`No se pudo conectar al servidor: ${err?.message || 'error de red'}`);
  } finally {
    setLoading(loginBtn, false);
  }
}

async function handleRegister() {
  clearAlert();
  const email    = regEmail.value.trim();
  const password = regPassword.value.trim();
  const pass2    = regPassword2.value.trim();

  if (!email || !password || !pass2) { showAlert('Rellena todos los campos.'); return; }
  if (password !== pass2) { showAlert('Las contraseñas no coinciden.'); return; }
  if (password.length < 8) { showAlert('La contraseña debe tener al menos 8 caracteres.'); return; }

  setLoading(registerBtn, true);
  try {
    const data = await apiPost('/auth/register', { email, password });

    if (!data.ok) {
      const msgs = {
        email_already_registered: 'Este email ya está registrado. Inicia sesión.',
        email_invalid: 'El email no es válido.',
        password_too_short: 'La contraseña debe tener al menos 8 caracteres.',
      };
      showAlert(msgs[data.error] || `Error: ${data.error || 'desconocido'}`);
      return;
    }

    // Guardar token
    await storageSet({
      lamine_auth_token: data.token,
      lamine_auth_email: data.user?.email || email,
      lamine_auth_role:  data.user?.role  || 'user',
    });

    // La licencia siempre estará inactiva al registrar
    showPanel('pending');
    showAlert('Cuenta creada. Espera que el administrador active tu licencia.', 'success');
  } catch (err) {
    showAlert(`No se pudo conectar al servidor: ${err?.message || 'error de red'}`);
  } finally {
    setLoading(registerBtn, false);
  }
}

async function handleLogout() {
  await storageRemove(['lamine_auth_token', 'lamine_auth_email', 'lamine_auth_role']);
  chrome.runtime.sendMessage({ action: 'rb:auth-logout' }).catch(() => {});
  showPanel('login');
  clearAlert();
}

// ── Eventos ────────────────────────────────────────────────────────────────────
loginBtn.addEventListener('click', handleLogin);
registerBtn.addEventListener('click', handleRegister);
goRegister.addEventListener('click', () => { clearAlert(); showPanel('register'); });
goLogin.addEventListener('click',    () => { clearAlert(); showPanel('login'); });
pendingLogout.addEventListener('click', handleLogout);

loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
regPassword2.addEventListener('keydown',  (e) => { if (e.key === 'Enter') handleRegister(); });

// ── Init: si ya hay sesión, verificar estado de licencia ─────────────────────
async function init() {
  const stored = await storageGet(['lamine_auth_token', 'lamine_auth_email']);
  const token  = stored?.lamine_auth_token;

  if (!token) {
    showPanel('login');
    return;
  }

  // Token presente: verificar con el servidor
  try {
    const res = await fetch(`${AUTH_API_URL}/license/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();

    if (data.ok && data.allowed) {
      // Licencia válida — cerrar y activar extensión
      chrome.runtime.sendMessage({ action: 'rb:auth-login-success' });
      window.close();
    } else if (data.status === 'inactive' || data.status === 'expired') {
      showPanel('pending');
    } else {
      // Token inválido o revocado — mostrar login
      await storageRemove(['lamine_auth_token', 'lamine_auth_email', 'lamine_auth_role']);
      showPanel('login');
      showAlert(data.message || 'Sesión expirada. Vuelve a iniciar sesión.', 'warn');
    }
  } catch (_) {
    // No hay red: mostrar login de todas formas
    showPanel('login');
    showAlert('No se pudo conectar al servidor de licencias.', 'warn');
  }
}

void init();
