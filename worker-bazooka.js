'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  Bazooka AK47 Worker — compra automática en Vinted con Puppeteer
//
//  USO:
//    node server/worker-bazooka.js           → arranca el worker (modo headless)
//    node server/worker-bazooka.js --login   → abre navegador visible para hacer login
//
//  VARIABLES DE ENTORNO (en server/.env):
//    WORKER_SECRET   → clave compartida con el servidor (requerida)
//    AK47_SERVER_URL → URL del servidor (defecto: http://localhost:3000)
//    WORKER_POLL_MS  → intervalo entre checks de jobs (defecto: 3000 ms)
//    JOB_TIMEOUT_MS  → tiempo máximo por job (defecto: 60000 ms)
//    HEADLESS        → "false" para ver el navegador (útil para depurar)
// ══════════════════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const fs   = require('fs');

const SERVER_URL      = process.env.AK47_SERVER_URL  || 'http://localhost:3000';
const WORKER_SECRET   = process.env.WORKER_SECRET    || '';
const POLL_MS         = Number(process.env.WORKER_POLL_MS)  || 3_000;
const JOB_TIMEOUT_MS  = Number(process.env.JOB_TIMEOUT_MS)  || 60_000;
const HEADLESS        = process.env.HEADLESS !== 'false';
const VINTED_ORIGIN   = 'https://www.vinted.es';

// Usa el Google Chrome real del sistema (no el Chromium de Puppeteer)
const CHROME_PATH     = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Perfil dedicado al worker — separado del perfil personal de Chrome
const CHROME_PROFILE  = path.join(__dirname, '.chrome-worker-profile');

// ── Logger ────────────────────────────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const ts     = new Date().toISOString().replace('T', ' ').split('.')[0];
  const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] [WORKER] [${level.toUpperCase()}] ${msg}${extras}`);
}

// ── Server API calls ──────────────────────────────────────────────────────────

async function serverFetch(path, opts = {}) {
  const url     = `${SERVER_URL}${path}`;
  const method  = opts.method || 'GET';
  const headers = {
    'Content-Type':    'application/json',
    'x-worker-secret': WORKER_SECRET,
    ...(opts.headers || {}),
  };
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json().catch(() => ({}));
}

async function getNextJob() {
  const data = await serverFetch('/api/bazooka/worker/next-job');
  return data?.job || null;
}

async function updateJobStatus(id, status, errorMessage = null) {
  await serverFetch(`/api/bazooka/client/jobs/${id}`, {
    method: 'PATCH',
    body: { status, errorMessage },
  });
}

// ── Chrome helpers ────────────────────────────────────────────────────────────

function launchOptions(headless = true) {
  return {
    executablePath: CHROME_PATH,   // Google Chrome real, no Chromium
    userDataDir:    CHROME_PROFILE, // perfil persistente — la sesión sobrevive reinicios
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
      '--lang=es-ES,es',
    ],
    defaultViewport: { width: 1280, height: 900 },
  };
}

async function checkLoggedIn(page) {
  try {
    await page.goto(VINTED_ORIGIN + '/', { waitUntil: 'networkidle2', timeout: 20_000 });
    return await page.evaluate(() => !!(
      document.querySelector('[data-testid="header--user-avatar"]') ||
      document.querySelector('[data-testid="user-avatar"]')         ||
      document.querySelector('[class*="userAvatar"]')               ||
      document.querySelector('.u-avatar')                           ||
      // Busca el menú de usuario o el botón de mi perfil
      document.querySelector('a[href*="/profile"]')                 ||
      document.querySelector('a[href*="/member/"]')
    ));
  } catch {
    return false;
  }
}

// ── Purchase automation ───────────────────────────────────────────────────────

// Selectores del botón de compra en la página de producto
const BUY_SELECTORS = [
  '[data-testid="item-page-buy-btn"]',
  '[data-testid="buy-button"]',
  '[data-qa="buy-button"]',
  'button[data-qa="item-buy-btn"]',
  'a[data-qa="buy-button"]',
  '.buy-item-button',
  '#item-buy-button',
];

// Selectores del botón de confirmar/pagar en checkout
const CONFIRM_SELECTORS = [
  '[data-testid="checkout-confirm-btn"]',
  '[data-testid="order-confirm-btn"]',
  '[data-testid="submit-order-btn"]',
  'button[data-testid*="confirm"]',
  'button[data-testid*="submit"]',
  'button[data-testid*="pay"]',
  'button[data-testid*="buy"]',
];

async function findAndClick(page, cssSelectors, textKeywords, label) {
  // 1. Buscar por selector CSS
  for (const sel of cssSelectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const ok = await page.evaluate(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled && !e.getAttribute('aria-disabled');
      }, el);
      if (ok) {
        log('INFO', `${label}: clic en "${sel}"`);
        await el.click();
        return true;
      }
    } catch {}
  }

  // 2. Fallback por texto del botón
  try {
    const found = await page.evaluateHandle((keywords) => {
      const els = Array.from(document.querySelectorAll('button, a[role="button"], a.btn, [class*="btn"]'));
      for (const el of els) {
        const text = (el.textContent || el.innerText || '').trim().toLowerCase();
        if (keywords.some(k => text.includes(k))) return el;
      }
      return null;
    }, textKeywords);

    const el = found?.asElement?.();
    if (el) {
      const ok = await page.evaluate(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !e.disabled;
      }, el);
      if (ok) {
        log('INFO', `${label}: clic por texto (${textKeywords.join('/')})`);
        await el.click();
        return true;
      }
    }
  } catch {}

  log('WARN', `${label}: no encontrado`);
  return false;
}

async function executePurchase(browser, jobUrl) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(JOB_TIMEOUT_MS);
  page.setDefaultTimeout(15_000);

  // User-agent realista
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  try {
    log('INFO', 'Navegando al producto...', { url: jobUrl });
    await page.goto(jobUrl, { waitUntil: 'networkidle2' });

    // Verificar si el item está disponible
    const isSold = await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      return (
        body.includes('vendido')  ||
        body.includes('reservado') ||
        !!document.querySelector('[data-testid="item-status-sold"]') ||
        !!document.querySelector('[data-testid="item-sold-banner"]') ||
        !!document.querySelector('.item-closed-banner')
      );
    });

    if (isSold) throw new Error('item_already_sold');

    // Esperar a que aparezca el botón de compra
    await page.waitForSelector(BUY_SELECTORS[0], { timeout: 8_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // Clic en "Comprar"
    const clicked = await findAndClick(
      page, BUY_SELECTORS,
      ['comprar', 'buy now', 'buy', 'pagar'],
      'Botón comprar'
    );
    if (!clicked) throw new Error('buy_button_not_found');

    // Esperar navegación al checkout
    await page.waitForNavigation({ timeout: 15_000, waitUntil: 'networkidle2' }).catch(() => {});
    await new Promise(r => setTimeout(r, 1_500));

    const currentUrl = page.url();
    log('INFO', 'URL tras clic en comprar', { url: currentUrl });

    // Si hay página de checkout, confirmar pago
    const onCheckout = currentUrl.includes('checkout')    ||
                       currentUrl.includes('transaction') ||
                       currentUrl.includes('confirm')     ||
                       currentUrl.includes('buy');

    if (onCheckout) {
      await new Promise(r => setTimeout(r, 1_000));
      const confirmed = await findAndClick(
        page, CONFIRM_SELECTORS,
        ['confirmar', 'pagar', 'comprar ahora', 'finalizar', 'confirm', 'pay'],
        'Botón confirmar pago'
      );
      if (confirmed) {
        await page.waitForNavigation({ timeout: 20_000, waitUntil: 'networkidle2' }).catch(() => {});
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    // Comprobar éxito
    const finalUrl = page.url();
    const success  = await page.evaluate(() => {
      const url  = window.location.href;
      const body = (document.body?.innerText || '').toLowerCase();
      return (
        url.includes('order')        ||
        url.includes('confirmation') ||
        url.includes('success')      ||
        body.includes('¡gracias')    ||
        body.includes('compra exitosa') ||
        body.includes('pedido confirmado') ||
        !!document.querySelector('[data-testid="order-confirmation"]')
      );
    });

    log(success ? 'INFO' : 'WARN', success ? '✅ Compra confirmada' : '⚠️ No se pudo confirmar éxito', { url: finalUrl });

    return { ok: true };

  } finally {
    await page.close().catch(() => {});
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function startWorker() {
  if (!WORKER_SECRET) {
    log('ERROR', '❌ WORKER_SECRET no configurado en .env');
    process.exit(1);
  }

  const puppeteer = require('puppeteer');

  log('INFO', '🚀 Bazooka Worker arrancado');
  log('INFO', `Chrome: ${CHROME_PATH}`);
  log('INFO', `Perfil: ${CHROME_PROFILE}`);
  log('INFO', `Servidor: ${SERVER_URL}  |  Poll: ${POLL_MS}ms  |  Headless: ${HEADLESS}`);

  const browser = await puppeteer.launch(launchOptions(HEADLESS));

  // Verificar sesión
  const checkPage = await browser.newPage();
  const loggedIn  = await checkLoggedIn(checkPage);
  if (loggedIn) {
    log('INFO', '✅ Sesión de Vinted activa');
  } else {
    log('WARN', '⚠️  No hay sesión. Ejecuta primero: npm run login');
  }
  await checkPage.close();

  // Bucle principal
  while (true) {
    try {
      const job = await getNextJob();

      if (job) {
        log('INFO', `🎯 Job #${job.id} → ${job.title || job.url}`);
        try {
          await executePurchase(browser, job.url);
          await updateJobStatus(job.id, 'done');
          log('INFO', `✅ Job #${job.id} completado`);
        } catch (err) {
          await updateJobStatus(job.id, 'failed', err.message);
          log('ERROR', `❌ Job #${job.id} fallido: ${err.message}`);
        }
      }
    } catch (err) {
      log('ERROR', 'Error en el loop', { err: err.message });
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ── Login mode (navegador visible para iniciar sesión) ────────────────────────

async function loginMode() {
  const puppeteer = require('puppeteer');

  log('INFO', '🔑 Modo LOGIN — abre Google Chrome para iniciar sesión en Vinted');
  log('INFO', `Perfil worker: ${CHROME_PROFILE}`);

  // Siempre visible para que el usuario pueda interactuar
  const browser = await puppeteer.launch(launchOptions(false));

  const page = await browser.newPage();
  await page.goto(`${VINTED_ORIGIN}/login`, { waitUntil: 'networkidle2' });

  log('INFO', '👉 Inicia sesión en la ventana de Chrome que acaba de abrirse...');
  log('INFO', '   El proceso terminará automáticamente cuando detecte que estás logueado.');

  // Esperar hasta detectar login exitoso
  while (true) {
    await new Promise(r => setTimeout(r, 3_000));
    try {
      const loggedIn = await checkLoggedIn(page);
      if (loggedIn) {
        log('INFO', '✅ ¡Login detectado! La sesión quedará guardada en el perfil de Chrome.');
        log('INFO', 'Ahora arranca el worker con: npm run worker');
        await new Promise(r => setTimeout(r, 2_000));
        await browser.close();
        process.exit(0);
      }
    } catch {}
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv.includes('--login')) {
  loginMode().catch(err => { log('ERROR', err.message); process.exit(1); });
} else {
  startWorker().catch(err => { log('ERROR', err.message); process.exit(1); });
}
