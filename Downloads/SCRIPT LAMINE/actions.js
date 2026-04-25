const els = {
  accountLine: document.getElementById('account-line'),
  refreshBtn: document.getElementById('refresh-btn'),
  joinWorkerBtn: document.getElementById('join-worker-btn'),
  checkVintedBtn: document.getElementById('check-vinted-btn'),
  workerMember: document.getElementById('worker-member'),
  workerState: document.getElementById('worker-state'),
  workerDetail: document.getElementById('worker-detail'),
  scopeSelect: document.getElementById('scope-select'),
  urlsInput: document.getElementById('urls-input'),
  submitBtn: document.getElementById('submit-btn'),
  formNote: document.getElementById('form-note'),
  summaryRequests: document.getElementById('summary-requests'),
  summaryOwnWorkers: document.getElementById('summary-own-workers'),
  summaryNetworkWorkers: document.getElementById('summary-network-workers'),
  summaryInProgress: document.getElementById('summary-in-progress'),
  incomingCount: document.getElementById('incoming-count'),
  incomingBody: document.getElementById('incoming-body'),
  requestsCount: document.getElementById('requests-count'),
  requestsBody: document.getElementById('requests-body'),
  workersCount: document.getElementById('workers-count'),
  workersBody: document.getElementById('workers-body'),
  statusLine: document.getElementById('status-line'),
  // Seller Bot
  sbotProductUrl:     document.getElementById('sbot-product-url'),
  sbotDiscount:       document.getElementById('sbot-discount'),
  sbotTriggerLikes:   document.getElementById('sbot-trigger-likes'),
  sbotMaxOffers:      document.getElementById('sbot-max-offers'),
  sbotMessage:        document.getElementById('sbot-message'),
  sbotAutoMessage:    document.getElementById('sbot-auto-message'),
  sbotAutoAccept:     document.getElementById('sbot-auto-accept'),
  sbotMinAcceptPrice: document.getElementById('sbot-min-accept-price'),
  sbotSaveBtn:        document.getElementById('sbot-save-btn'),
  sbotEnableBtn:      document.getElementById('sbot-enable-btn'),
  sbotDisableBtn:     document.getElementById('sbot-disable-btn'),
  sbotRunNowBtn:      document.getElementById('sbot-run-now-btn'),
  sbotResetBtn:       document.getElementById('sbot-reset-btn'),
  sbotStatusChip:     document.getElementById('seller-bot-status-chip'),
  sbotStatLikes:      document.getElementById('sbot-stat-likes'),
  sbotStatSent:       document.getElementById('sbot-stat-sent'),
  sbotStatAccepted:   document.getElementById('sbot-stat-accepted'),
  sbotStatScheduled:  document.getElementById('sbot-stat-scheduled'),
  sbotStatLast:       document.getElementById('sbot-stat-last'),
};

let refreshTimer = null;
let workerAutoKickDone = false;

function send(action, payload = {}) {
  return chrome.runtime.sendMessage({ action, ...payload });
}

function setStatus(message) {
  if (els.statusLine) {
    els.statusLine.textContent = String(message || '');
  }
}

function fmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('es-ES');
}

function esc(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseUrlsInput(raw) {
  const rows = String(raw || '')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  return [...new Set(rows)];
}

function extractResultError(result, fallback = 'request_failed') {
  if (!result || result.ok !== false) return '';
  if (result.license?.message) return String(result.license.message);
  if (result.message) return String(result.message);
  if (result.error) return String(result.error);
  return fallback;
}

function badgeState(value) {
  const safe = String(value || 'queued').trim().toLowerCase();
  return `<span class="state-badge ${esc(safe)}">${esc(safe.replaceAll('_', ' '))}</span>`;
}

function renderWorkers(workers = []) {
  const rows = Array.isArray(workers) ? workers : [];
  if (els.workersCount) {
    els.workersCount.textContent = String(rows.length);
  }
  if (!els.workersBody) return;
  if (!rows.length) {
    els.workersBody.innerHTML = '<tr class="empty-row"><td colspan="4">Todavia no hay workers registrados en esta cuenta.</td></tr>';
    return;
  }
  els.workersBody.innerHTML = rows
    .map((worker) => {
      return [
        '<tr>',
        `<td>${esc(worker.browserId || worker.installId || '-')}</td>`,
        `<td>${esc(worker.memberId || '-')}</td>`,
        `<td>${badgeState(worker.online ? 'online' : worker.status || 'offline')}</td>`,
        `<td>${esc(fmtDate(worker.lastSeenAt))}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');
}

function thumbCell(imageUrl, productUrl) {
  if (!imageUrl) {
    return '<td class="thumb-cell"><div class="thumb-placeholder"></div></td>';
  }
  return `<td class="thumb-cell"><a href="${esc(productUrl || '#')}" target="_blank" rel="noreferrer"><img class="product-thumb" src="${esc(imageUrl)}" alt="" loading="lazy" /></a></td>`;
}

function renderRequests(requests = []) {
  const rows = Array.isArray(requests) ? requests : [];
  if (els.requestsCount) {
    els.requestsCount.textContent = String(rows.length);
  }
  if (!els.requestsBody) return;
  if (!rows.length) {
    els.requestsBody.innerHTML = '<tr class="empty-row"><td colspan="6">Todavia no has enviado solicitudes manuales.</td></tr>';
    return;
  }
  els.requestsBody.innerHTML = rows
    .map((request) => {
      const tasks = request.tasks || {};
      const taskText = `P:${Number(tasks.pending || 0)} · IP:${Number(tasks.inProgress || 0)} · C:${Number(tasks.completed || 0)} · F:${Number(tasks.failed || 0)}`;
      const title = request.title ? esc(request.title) : esc(request.productUrl || '');
      return [
        '<tr>',
        thumbCell(request.imageUrl, request.productUrl),
        `<td>${esc(request.itemId || '-')}</td>`,
        `<td><a class="product-link" href="${esc(request.productUrl || '#')}" target="_blank" rel="noreferrer">${title}</a></td>`,
        `<td>${esc(request.scope || 'public')}</td>`,
        `<td>${esc(taskText)}</td>`,
        `<td>${esc(fmtDate(request.createdAt))}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');
}

function renderIncomingTasks(tasks = []) {
  const rows = Array.isArray(tasks) ? tasks : [];
  if (els.incomingCount) {
    els.incomingCount.textContent = String(rows.length);
  }
  if (!els.incomingBody) return;
  if (!rows.length) {
    els.incomingBody.innerHTML = '<tr class="empty-row"><td colspan="7">Todavia no han entrado tareas de la red en este navegador.</td></tr>';
    return;
  }
  els.incomingBody.innerHTML = rows
    .map((task) => {
      const title = task.title ? esc(task.title) : esc(task.productUrl || '');
      const claim = task.claimedByThisInstall
        ? 'este navegador'
        : task.claimedByInstallId
          ? `otro install (${esc(task.claimedByInstallId)})`
          : 'sin claim';
      return [
        '<tr>',
        `<td>${badgeState(task.state)}</td>`,
        thumbCell(task.imageUrl, task.productUrl),
        `<td>${esc(task.itemId || '-')}</td>`,
        `<td><a class="product-link" href="${esc(task.productUrl || '#')}" target="_blank" rel="noreferrer">${title}</a></td>`,
        `<td>${esc(task.sourceEmail || 'red publica')}</td>`,
        `<td>${claim}</td>`,
        `<td>${esc(fmtDate(task.updatedAt || task.startedAt || task.detectedAt))}</td>`,
        '</tr>',
      ].join('');
    })
    .join('');
}

function renderOverview(result = {}) {
  const accountEmail = String(result?.account?.email || '').trim();
  const licenseStatus = String(result?.license?.status || result?.license?.reason || '-').trim() || '-';
  if (els.accountLine) {
    els.accountLine.textContent = accountEmail
      ? `${accountEmail} · licencia ${licenseStatus}`
      : 'Sin cuenta vinculada';
  }

  const summary = result?.summary || {};
  if (els.summaryRequests) els.summaryRequests.textContent = String(summary.totalRequests ?? 0);
  if (els.summaryOwnWorkers) els.summaryOwnWorkers.textContent = String(summary.ownWorkersOnline ?? 0);
  if (els.summaryNetworkWorkers) els.summaryNetworkWorkers.textContent = String(summary.networkWorkersOnline ?? 0);
  if (els.summaryInProgress) els.summaryInProgress.textContent = String(summary.inProgressTasks ?? 0);

  renderIncomingTasks(result?.incomingTasks || []);
  renderRequests(result?.requests || []);
  renderWorkers(result?.workers || []);
}

function workerBadge(value) {
  return badgeState(value || 'offline');
}

function renderWorkerStatus(result = {}) {
  const worker = result?.worker || {};
  const session = result?.vintedSession || {};
  const memberId = String(worker.memberId || session.memberId || '').trim();
  if (els.workerMember) {
    els.workerMember.textContent = memberId
      ? `member ${memberId}`
      : 'Sin member detectado';
  }
  if (els.workerState) {
    const state =
      worker.running === true
        ? 'working'
        : String(worker.lastOutcome || '').trim() || (session.loggedIn === true ? 'ready' : 'offline');
    els.workerState.innerHTML = workerBadge(state);
  }
  if (els.workerDetail) {
    const detailParts = [];
    if (session.loggedIn === true) {
      detailParts.push(`Vinted conectada (${session.reason || 'ok'})`);
    } else if (session.loggedIn === false) {
      detailParts.push(`Vinted no conectada (${session.reason || 'sin_sesion'})`);
    } else {
      detailParts.push(`Sesion Vinted incierta (${session.reason || 'unknown'})`);
    }
    if (worker.lastReason) {
      detailParts.push(`worker: ${worker.lastReason}`);
    }
    if (worker.lastError) {
      detailParts.push(`error: ${worker.lastError}`);
    }
    els.workerDetail.textContent = detailParts.join(' | ');
  }
}

async function runWorker(forceSession = true, silent = false) {
  const button = els.joinWorkerBtn;
  const original = button?.textContent || 'Activar worker';
  if (button) {
    button.disabled = true;
    button.textContent = 'Activando...';
  }
  try {
    const response = await send('rb:ext-monitor-run-worker', { forceSession });
    if (!response?.success) {
      throw new Error(response?.error || 'worker_run_failed');
    }
    if (!silent) {
      setStatus(`Worker: ${response?.result?.reason || response?.result?.error || 'accion lanzada'}`);
    }
    await loadOverview();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function loadOverview() {
  setStatus('Sincronizando modulo...');
  const [overviewResponse, workerResponse] = await Promise.all([
    send('rb:ext-monitor-overview'),
    send('rb:ext-monitor-worker-status'),
  ]);
  if (!overviewResponse?.success) {
    throw new Error(overviewResponse?.error || 'overview_failed');
  }
  if (!workerResponse?.success) {
    throw new Error(workerResponse?.error || 'worker_status_failed');
  }
  if (overviewResponse?.result?.licenseBlocked) {
    throw new Error(overviewResponse?.result?.license?.message || 'license_blocked');
  }
  if (overviewResponse?.result?.ok === false) {
    throw new Error(extractResultError(overviewResponse.result, 'overview_failed'));
  }
  renderOverview(overviewResponse.result || {});
  renderWorkerStatus(workerResponse.result || {});
  setStatus(`Actualizado: ${new Date().toLocaleTimeString('es-ES')}`);

  const summary = overviewResponse?.result?.summary || {};
  if (!workerAutoKickDone && Number(summary.ownWorkersOnline || 0) === 0) {
    workerAutoKickDone = true;
    await runWorker(true, true).catch(() => {});
  }
}

async function submitRequests() {
  const urls = parseUrlsInput(els.urlsInput?.value || '');
  if (!urls.length) {
    if (els.formNote) {
      els.formNote.textContent = 'Pega al menos un link valido.';
    }
    return;
  }

  const original = els.submitBtn.textContent;
  els.submitBtn.disabled = true;
  els.submitBtn.textContent = 'Enviando...';
  try {
    const response = await send('rb:ext-monitor-create-requests', {
      urls,
      scope: String(els.scopeSelect?.value || 'public'),
    });
    if (!response?.success) {
      throw new Error(response?.error || 'request_create_failed');
    }
    const result = response.result || {};
    if (result?.ok === false) {
      throw new Error(extractResultError(result, 'request_create_failed'));
    }
    renderRequests(result.requests || []);
    if (els.formNote) {
      els.formNote.textContent = `Enviados: ${Number(result.created || 0)} | duplicados: ${Number(result.duplicated || 0)} | errores: ${Number(result.errors || 0)}`;
    }
    els.urlsInput.value = '';
    await loadOverview();
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = original;
  }
}

function bindEvents() {
  if (els.refreshBtn) {
    els.refreshBtn.addEventListener('click', () => {
      loadOverview().catch((error) => {
        setStatus(`Error: ${error.message}`);
      });
    });
  }
  if (els.joinWorkerBtn) {
    els.joinWorkerBtn.addEventListener('click', () => {
      runWorker(true).catch((error) => {
        setStatus(`Error activando worker: ${error.message}`);
      });
    });
  }
  if (els.checkVintedBtn) {
    els.checkVintedBtn.addEventListener('click', () => {
      send('rb:refresh-vinted-session')
        .then(() => loadOverview())
        .catch((error) => {
          setStatus(`Error revisando Vinted: ${error.message}`);
        });
    });
  }
  if (els.submitBtn) {
    els.submitBtn.addEventListener('click', () => {
      submitRequests().catch((error) => {
        if (els.formNote) {
          els.formNote.textContent = `Error: ${error.message}`;
        }
        setStatus(`Error enviando solicitudes: ${error.message}`);
      });
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadOverview().catch(() => {});
    }
  });
}

async function init() {
  bindEvents();
  await loadOverview();
  refreshTimer = setInterval(() => {
    loadOverview().catch(() => {});
  }, 30000);
}

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLER BOT UI
// ══════════════════════════════════════════════════════════════════════════════

function extractItemIdFromProductUrl(url) {
  const m = String(url || '').match(/\/items\/(\d+)/);
  return m ? m[1] : '';
}

function fmtRelative(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return 'próximamente';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}min`;
  const h = Math.floor(m / 60);
  return `hace ${h}h`;
}

async function sbotLoad() {
  try {
    const { config, state } = await send('rb:seller-bot-get');
    if (!config) return;

    // Populate form
    if (els.sbotProductUrl)     els.sbotProductUrl.value     = config.productUrl || '';
    if (els.sbotDiscount)       els.sbotDiscount.value       = config.discountPct ?? 10;
    if (els.sbotTriggerLikes)   els.sbotTriggerLikes.value   = config.triggerLikes ?? 1;
    if (els.sbotMaxOffers)      els.sbotMaxOffers.value      = config.maxOffersPerCycle ?? 10;
    if (els.sbotMessage)        els.sbotMessage.value        = config.messageTemplate || '';
    if (els.sbotAutoMessage)    els.sbotAutoMessage.checked  = config.autoMessage !== false;
    if (els.sbotAutoAccept)     els.sbotAutoAccept.checked   = config.autoAccept === true;
    if (els.sbotMinAcceptPrice) els.sbotMinAcceptPrice.value = config.minAcceptPrice ?? 0;

    // Enable/disable buttons
    if (config.enabled) {
      if (els.sbotEnableBtn)  els.sbotEnableBtn.style.display  = 'none';
      if (els.sbotDisableBtn) els.sbotDisableBtn.style.display = '';
      if (els.sbotStatusChip) {
        els.sbotStatusChip.textContent = '🟢 Activo';
        els.sbotStatusChip.style.color = '#00c688';
      }
    } else {
      if (els.sbotEnableBtn)  els.sbotEnableBtn.style.display  = '';
      if (els.sbotDisableBtn) els.sbotDisableBtn.style.display = 'none';
      if (els.sbotStatusChip) {
        els.sbotStatusChip.textContent = '⚪ Desactivado';
        els.sbotStatusChip.style.color = '';
      }
    }

    // Stats
    if (state) {
      if (els.sbotStatLikes)     els.sbotStatLikes.textContent     = state.lastLikeCount ?? '—';
      if (els.sbotStatSent)      els.sbotStatSent.textContent      = state.stats?.sent ?? 0;
      if (els.sbotStatAccepted)  els.sbotStatAccepted.textContent  = state.stats?.accepted ?? 0;
      const pending = (state.scheduledMessages || []).filter(m => !m.sent).length;
      if (els.sbotStatScheduled) els.sbotStatScheduled.textContent = pending;
      if (els.sbotStatLast)      els.sbotStatLast.textContent      = fmtRelative(state.lastCheckAt);
    }
  } catch (err) {
    console.warn('[SellerBot UI] Error cargando config:', err?.message);
  }
}

function sbotBuildConfig() {
  const url    = els.sbotProductUrl?.value?.trim() || '';
  const itemId = extractItemIdFromProductUrl(url);
  return {
    productUrl:       url,
    itemId:           itemId,
    discountPct:      Number(els.sbotDiscount?.value)       || 10,
    triggerLikes:     Number(els.sbotTriggerLikes?.value)   || 1,
    maxOffersPerCycle: Number(els.sbotMaxOffers?.value)     || 10,
    messageTemplate:  els.sbotMessage?.value?.trim()        || '',
    autoMessage:      els.sbotAutoMessage?.checked !== false,
    autoAccept:       els.sbotAutoAccept?.checked  === true,
    minAcceptPrice:   Number(els.sbotMinAcceptPrice?.value) || 0,
  };
}

async function sbotSave() {
  const cfg = sbotBuildConfig();
  if (!cfg.itemId) {
    alert('Introduce una URL de producto válida de Vinted (debe contener /items/ID).');
    return;
  }
  await send('rb:seller-bot-set', { config: cfg });
  await sbotLoad();
}

async function sbotEnable() {
  const cfg = { ...sbotBuildConfig(), enabled: true };
  if (!cfg.itemId) {
    alert('Introduce una URL de producto válida de Vinted antes de activar.');
    return;
  }
  await send('rb:seller-bot-set', { config: cfg });
  await sbotLoad();
}

async function sbotDisable() {
  await send('rb:seller-bot-set', { config: { enabled: false } });
  await sbotLoad();
}

async function sbotRunNow() {
  if (els.sbotStatusChip) els.sbotStatusChip.textContent = '⏳ Ejecutando...';
  await send('rb:seller-bot-run');
  setTimeout(() => sbotLoad(), 3000);
}

async function sbotReset() {
  if (!confirm('¿Resetear el estado del bot? Se borrarán los IDs ya contactados y mensajes programados.')) return;
  await send('rb:seller-bot-reset-state');
  await sbotLoad();
}

function bindSellerBotEvents() {
  els.sbotSaveBtn?.addEventListener('click',    () => sbotSave().catch(console.error));
  els.sbotEnableBtn?.addEventListener('click',  () => sbotEnable().catch(console.error));
  els.sbotDisableBtn?.addEventListener('click', () => sbotDisable().catch(console.error));
  els.sbotRunNowBtn?.addEventListener('click',  () => sbotRunNow().catch(console.error));
  els.sbotResetBtn?.addEventListener('click',   () => sbotReset().catch(console.error));
}

void init().catch((error) => {
  setStatus(`Error inicializando modulo: ${error.message}`);
});

void (async () => {
  bindSellerBotEvents();
  await sbotLoad();
  // Refresh seller bot stats every 30s alongside the main overview
  setInterval(() => sbotLoad().catch(() => {}), 30000);
})();
