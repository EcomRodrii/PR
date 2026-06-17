'use strict';

const els = {
  statusDot:       document.getElementById('cv-status-dot'),
  statusLabel:     document.getElementById('cv-status-label'),
  statusSub:       document.getElementById('cv-status-sub'),
  refreshBtn:      document.getElementById('cv-refresh-btn'),
  onBtn:           document.getElementById('cv-on-btn'),
  offBtn:          document.getElementById('cv-off-btn'),
  statePill:       document.getElementById('cv-state-pill'),
  statePillText:   document.getElementById('cv-state-pill-text'),
  msg:             document.getElementById('cv-msg'),
  scheduleToggle:  document.getElementById('cv-schedule-toggle'),
  scheduleMsg:     document.getElementById('cv-schedule-msg'),
  scheduleBadge:   document.getElementById('cv-schedule-badge'),
  scheduleBadgeLbl: document.getElementById('cv-schedule-badge-label'),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

function setDot(state) {
  // state: 'on' | 'off' | 'unknown' | 'loading'
  if (!els.statusDot) return;
  els.statusDot.className = `cv-dot cv-dot--${state}`;
}

function setPill(state) {
  // state: 'on' | 'off' | ''
  if (!els.statePill) return;
  els.statePill.className = 'cv-state-pill' + (state ? ` pill--${state}` : '');
  if (els.statePillText) {
    if (state === 'on')  els.statePillText.textContent = 'Vacaciones activas';
    else if (state === 'off') els.statePillText.textContent = 'Vacaciones inactivas';
    else els.statePillText.textContent = '—';
  }
}

function setMsg(text, type = '') {
  if (!els.msg) return;
  els.msg.textContent = text;
  els.msg.className = 'cv-msg' + (type ? ` ${type}` : '');
}

function setScheduleMsg(text, type = '') {
  if (!els.scheduleMsg) return;
  els.scheduleMsg.textContent = text;
  els.scheduleMsg.className = 'cv-msg' + (type ? ` ${type}` : '');
}

function setBusy(busy) {
  if (els.onBtn)      els.onBtn.disabled      = busy;
  if (els.offBtn)     els.offBtn.disabled     = busy;
  if (els.refreshBtn) els.refreshBtn.disabled = busy;
}

function updateScheduleBadge(enabled) {
  if (!els.scheduleBadge || !els.scheduleBadgeLbl) return;
  if (enabled) {
    els.scheduleBadge.classList.add('active');
    els.scheduleBadgeLbl.textContent = 'Activo (23:00 → 07:00)';
  } else {
    els.scheduleBadge.classList.remove('active');
    els.scheduleBadgeLbl.textContent = 'Inactivo';
  }
}

// ── Vacation status ───────────────────────────────────────────────────────────

async function loadVacationStatus(showLoading = true) {
  if (showLoading) {
    setDot('loading');
    if (els.statusLabel) els.statusLabel.textContent = 'Comprobando estado…';
    if (els.statusSub)   els.statusSub.textContent = 'Accediendo a Vinted…';
    setBusy(true);
    setMsg('');
  }
  try {
    const resp = await send('rb:vacation-status');
    const on = resp?.vacationEnabled === true;
    setDot(on ? 'on' : 'off');
    setPill(on ? 'on' : 'off');
    if (els.statusLabel) {
      els.statusLabel.textContent = on ? 'Vacaciones activadas' : 'Vacaciones desactivadas';
    }
    if (els.statusSub) {
      const now = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      els.statusSub.textContent = `Actualizado: ${now}`;
    }
  } catch (err) {
    setDot('unknown');
    setPill('');
    if (els.statusLabel) els.statusLabel.textContent = 'No se pudo obtener el estado';
    if (els.statusSub)   els.statusSub.textContent   = err?.message || 'Error desconocido';
    setMsg('Error al comprobar el estado. ¿Tienes sesión iniciada en Vinted?', 'err');
  } finally {
    setBusy(false);
  }
}

// ── Apply vacation ────────────────────────────────────────────────────────────

async function applyVacation(enable) {
  setBusy(true);
  setDot('loading');
  setPill('');
  if (els.statusLabel) els.statusLabel.textContent = enable ? 'Activando vacaciones…' : 'Desactivando vacaciones…';
  if (els.statusSub)   els.statusSub.textContent = 'Un momento…';
  setMsg('');
  try {
    await send('rb:vacation-apply', { enable });
    await loadVacationStatus(false);
    setMsg(
      enable ? '✓ Vacaciones activadas correctamente.' : '✓ Vacaciones desactivadas correctamente.',
      'ok'
    );
  } catch (err) {
    setDot('unknown');
    setPill('');
    if (els.statusLabel) els.statusLabel.textContent = 'Error al aplicar cambios';
    if (els.statusSub)   els.statusSub.textContent   = err?.message || '';
    setMsg('Error: ' + (err?.message || 'desconocido'), 'err');
    setBusy(false);
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

async function loadSchedule() {
  try {
    const stored = await new Promise((res) =>
      chrome.storage.local.get('vacationModeState', (r) => res(r.vacationModeState || {}))
    );
    const enabled = stored?.autoSchedule === true;
    if (els.scheduleToggle) els.scheduleToggle.checked = enabled;
    updateScheduleBadge(enabled);
  } catch (_) {
    // ignore
  }
}

async function onScheduleToggle() {
  const enabled = els.scheduleToggle?.checked ?? false;
  updateScheduleBadge(enabled);
  setScheduleMsg('');
  try {
    await send('rb:vacation-schedule', { enabled });
    setScheduleMsg(
      enabled ? '✓ Programación activada — vacaciones 23:00 → 07:00.' : '✓ Programación desactivada.',
      enabled ? 'info' : 'ok'
    );
  } catch (err) {
    setScheduleMsg('Error al guardar: ' + (err?.message || 'desconocido'), 'err');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function bindEvents() {
  if (els.refreshBtn)     els.refreshBtn.addEventListener('click', () => loadVacationStatus(true));
  if (els.onBtn)          els.onBtn.addEventListener('click', () => applyVacation(true));
  if (els.offBtn)         els.offBtn.addEventListener('click', () => applyVacation(false));
  if (els.scheduleToggle) els.scheduleToggle.addEventListener('change', onScheduleToggle);
}

async function init() {
  bindEvents();
  await Promise.all([
    loadVacationStatus(true),
    loadSchedule(),
  ]);
}

void init();
