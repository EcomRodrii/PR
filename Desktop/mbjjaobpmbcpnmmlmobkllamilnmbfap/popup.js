// ════════════════════════════════════════════════════════════
//  LAMINE RESELL — popup.js  v4
//  Terminal UI: bottom-nav, inline stats, monospace
// ════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const send = (action, p = {}) => chrome.runtime.sendMessage({ action, ...p });

let _state = null, _config = null;
let _cycleTimer = null, _pollTimer = null;

// ── Utils ─────────────────────────────────────────────────────
function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0)       return 'ahora';
  if (ms < 60e3)    return `${Math.round(ms/1e3)}s`;
  if (ms < 3600e3)  return `${Math.round(ms/60e3)}m`;
  if (ms < 86400e3) return `${Math.round(ms/3600e3)}h`;
  return `${Math.round(ms/86400e3)}d`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms)||ms<=0) return '—';
  return `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}`;
}
function fmtPrice(text, value) {
  if (value!=null && Number.isFinite(+value)) return `${(+value).toFixed(2)}€`;
  if (text) return String(text);
  return '—';
}
function parseUrls(raw) {
  return [...new Set(String(raw||'').split('\n').map(v=>v.trim())
    .filter(v=>v.startsWith('https://www.vinted.es/')))];
}
function csvEscape(v) {
  const s=String(v==null?'':v);
  return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;
}

// Prioridad P0-P3 (igual que background.js)
function prio(item) {
  const checked = new Date(item.latest?.checkedAt||0).getTime();
  const det     = new Date(item.detectedAt||0).getTime();
  const age     = Date.now()-det;
  const likes   = item.latest?.likesCount??0;
  if (!checked||age<600000||item.status==='reserved') return 0;
  if (age<7200000||likes>=3)  return 1;
  if (age<28800000)           return 2;
  return 3;
}
const P_ICON  = ['🔥','↑','→','↓'];
const P_CLASS = ['p0','p1','p2','p3'];

// ── Navegación bottom ─────────────────────────────────────────
const PAGES = ['overview','items','sales','config'];
function initNav() {
  document.querySelectorAll('.bnav[data-page]').forEach(btn =>
    btn.addEventListener('click', () => goPage(btn.dataset.page))
  );
}
function goPage(id) {
  PAGES.forEach(p => {
    document.querySelector(`.bnav[data-page="${p}"]`)?.classList.toggle('active', p===id);
    $(`page-${p}`)?.classList.toggle('active', p===id);
  });
  if (id==='items')  renderItems();
  if (id==='sales')  renderSales();
  if (id==='config') renderConfig();
}

// ── Countdown ─────────────────────────────────────────────────
function startCountdown(config) {
  clearInterval(_cycleTimer);
  const el = $('sl-cycle');
  if (!config?.monitorEnabled||!config?.lastCycleAt) { el.textContent='—'; return; }
  const period = (config.detectPeriodMinutes||5)*60000;
  const next   = new Date(config.lastCycleAt).getTime()+period;
  _cycleTimer  = setInterval(()=>{
    const rem = next-Date.now();
    el.textContent = rem>0 ? fmtMs(rem) : 'pronto';
  }, 1000);
}

// ════════════════════════════════════════════════════════════
//  RENDER TOP BAR + STATUS LINE
// ════════════════════════════════════════════════════════════
function renderShell(state, config) {
  const items   = Array.isArray(state?.items) ? state.items : [];
  const metrics = state?.metrics || {};
  const enabled = config?.monitorEnabled === true;

  // Top bar KPIs
  const active  = items.filter(i=>i.status==='active'||i.status==='reserved').length;
  const sold    = items.filter(i=>i.status==='sold').length;
  const total   = metrics.totalDetected||items.length;
  const conv    = total>0 ? `${((sold/total)*100).toFixed(1)}%` : '0%';
  $('k-total').textContent  = total;
  $('k-active').textContent = active;
  $('k-sold').textContent   = sold;
  $('k-conv').textContent   = conv;

  // Tab badges
  $('bn-items').textContent = active;
  $('bn-sales').textContent = sold;

  // Live dot
  const dot = $('live-dot');
  dot.className = `live-dot ${enabled?'on':'off'}`;

  // Status line
  const sl = $('sl-status');
  sl.textContent = enabled ? 'LIVE' : 'PAUSADO';
  sl.className   = `sl-status${enabled?' on':''}`;
  $('sl-campaign').textContent = config?.productName || 'sin campaña';
  $('sl-scan').textContent     = metrics.lastDetectRun ? ago(metrics.lastDetectRun) : '—';

  // Revenue en status line
  let rev=0;
  for (const item of items.filter(i=>i.status==='sold')) {
    const pv=+item.soldPriceValue; if (pv>0) rev+=pv;
  }
  $('sl-rev').textContent = rev>0 ? `${rev.toFixed(2)}€` : '';

  // Buttons
  $('start-monitor').disabled = enabled;
  $('stop-monitor').disabled  = !enabled;
  $('detect-now').disabled    = !enabled;
  $('track-now').disabled     = !enabled;
  $('scan-all').disabled      = !enabled;

  startCountdown(config);
}

// ════════════════════════════════════════════════════════════
//  RENDER OVERVIEW (activity feed)
// ════════════════════════════════════════════════════════════
function renderOverview(state) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const now   = Date.now();
  const evs   = [];

  for (const item of items) {
    if (item.status==='sold') {
      const t = new Date(item.soldAt||0).getTime();
      if (!t) continue;
      const tts = item.timeToSellMinutes!=null
        ? (item.timeToSellMinutes<60
            ? `en ${Math.round(item.timeToSellMinutes)}m`
            : `en ${(item.timeToSellMinutes/60).toFixed(1)}h`)
        : '';
      evs.push({ type:'sold', t, title:item.title||`#${item.itemId}`, url:item.url,
        price:fmtPrice(item.soldPriceText,item.soldPriceValue), sub:tts });
    } else {
      const t = new Date(item.detectedAt||0).getTime();
      if (!t||now-t>4*3600000) continue;
      const type = item.status==='reserved'?'res':'new';
      const likes = item.latest?.likesCount;
      evs.push({ type, t, title:item.title||`#${item.itemId}`, url:item.url,
        price:fmtPrice(item.latest?.priceText,item.latest?.priceValue),
        sub: likes>0 ? `♥ ${likes}` : '' });
    }
  }
  evs.sort((a,b)=>b.t-a.t);

  const el  = $('activity-feed');
  el.innerHTML = '';
  $('feed-cnt').textContent = evs.length ? `${evs.length} eventos` : '';

  if (!evs.length) {
    el.innerHTML='<div class="row-empty">Sin actividad — inicia el monitor</div>';
    return;
  }
  const LABEL = { new:'NEW', sold:'SOLD', res:'RES' };
  for (const ev of evs.slice(0,35)) {
    const row=document.createElement('div');
    row.className='feed-row';
    row.innerHTML=`
      <span class="feed-tag ${ev.type}">${LABEL[ev.type]}</span>
      <div class="feed-body">
        <a class="feed-link" href="${ev.url}" target="_blank" rel="noreferrer">${ev.title}</a>
        ${ev.sub?`<div class="feed-sub">${ev.sub}</div>`:''}
      </div>
      <div class="feed-right">
        <div class="feed-price ${ev.type}">${ev.price}</div>
        <div class="feed-ago">${ago(new Date(ev.t))}</div>
      </div>`;
    el.appendChild(row);
  }
}

// ════════════════════════════════════════════════════════════
//  RENDER ITEMS
// ════════════════════════════════════════════════════════════
function renderItems() {
  if (!_state) return;
  const q    = ($('items-search')?.value||'').toLowerCase().trim();
  const sort = $('items-sort')?.value||'newest';
  let list   = (_state.items||[]).filter(i=>i.status!=='sold');
  if (q) list=list.filter(i=>(i.title||'').toLowerCase().includes(q)||(i.modelName||'').toLowerCase().includes(q));
  if (sort==='newest')     list.sort((a,b)=>new Date(b.detectedAt||0)-new Date(a.detectedAt||0));
  if (sort==='priority')   list.sort((a,b)=>prio(a)-prio(b));
  if (sort==='likes')      list.sort((a,b)=>(b.latest?.likesCount||0)-(a.latest?.likesCount||0));
  if (sort==='price-asc')  list.sort((a,b)=>(a.latest?.priceValue||0)-(b.latest?.priceValue||0));
  if (sort==='price-desc') list.sort((a,b)=>(b.latest?.priceValue||0)-(a.latest?.priceValue||0));

  const el=$('items-list');
  el.innerHTML='';
  if (!list.length) { el.innerHTML=`<div class="row-empty">${q?'Sin resultados':'Sin items activos'}</div>`; return; }
  for (const item of list.slice(0,120)) {
    const p=prio(item), l=item.latest||{};
    const tag = item.status==='reserved'
      ? '<span class="tag-r">[RES]</span>'
      : '<span class="tag-a">[ACT]</span>';
    const likes = l.likesCount>0 ? `<span class="like">♥${l.likesCount}</span>` : '';
    const views = l.viewsCount>0 ? `<span>${l.viewsCount}v</span>` : '';
    const row=document.createElement('div');
    row.className='irow';
    row.innerHTML=`
      <span class="prio-lbl ${P_CLASS[p]}" title="P${p}">${P_ICON[p]}</span>
      <div class="irow-info">
        <a class="irow-name" href="${item.url}" target="_blank" rel="noreferrer">${item.title||'#'+item.itemId}</a>
        <div class="irow-meta">
          ${tag}${item.modelName?`<span>${item.modelName}</span>`:''}
          ${likes}${views}<span>${ago(item.detectedAt)}</span>
        </div>
      </div>
      <div class="irow-price">${fmtPrice(l.priceText,l.priceValue)}</div>`;
    el.appendChild(row);
  }
}

// ════════════════════════════════════════════════════════════
//  RENDER SALES
// ════════════════════════════════════════════════════════════
function renderSales() {
  if (!_state) return;
  const sold = (_state.items||[]).filter(i=>i.status==='sold')
    .sort((a,b)=>new Date(b.soldAt||0)-new Date(a.soldAt||0));

  let rev=0,rc=0,tts=0,tc=0;
  for (const i of sold) {
    const pv=+i.soldPriceValue; if(pv>0){rev+=pv;rc++;}
    if(i.timeToSellMinutes!=null){tts+=i.timeToSellMinutes;tc++;}
  }
  $('an-revenue').textContent = rev>0 ? rev.toFixed(2)+'€' : '—';
  $('an-avg').textContent     = rc>0  ? (rev/rc).toFixed(2)+'€' : '—';
  $('an-tts').textContent     = tc>0
    ? (tts/tc<60?`${Math.round(tts/tc)}m`:`${(tts/tc/60).toFixed(1)}h`) : '—';

  // Models
  const byModel=new Map();
  for (const i of sold) { const k=i.modelName||'Otros'; byModel.set(k,(byModel.get(k)||0)+1); }
  const top=[...byModel.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
  const mc=$('models-chart'); mc.innerHTML='';
  if (!top.length) { mc.innerHTML='<div class="row-empty">Sin datos</div>'; }
  else {
    const max=top[0][1];
    for (const [name,cnt] of top) {
      const pct=Math.max(2,Math.round((cnt/max)*100));
      const r=document.createElement('div'); r.className='mrow';
      r.innerHTML=`<span class="mrow-name" title="${name}">${name}</span>
        <span class="mrow-bar"><span class="mrow-fill" style="width:${pct}%"></span></span>
        <span class="mrow-cnt">${cnt}</span>`;
      mc.appendChild(r);
    }
  }

  // Sales list
  const sl=$('sales-list'); sl.innerHTML='';
  if (!sold.length) { sl.innerHTML='<div class="row-empty">Sin ventas todavía</div>'; return; }
  for (const item of sold.slice(0,60)) {
    const ttsFmt=item.timeToSellMinutes!=null
      ? (item.timeToSellMinutes<60?`${Math.round(item.timeToSellMinutes)}m`:`${(item.timeToSellMinutes/60).toFixed(1)}h`)
      : '';
    const r=document.createElement('div'); r.className='srow';
    r.innerHTML=`
      <div>
        <a class="srow-name" href="${item.url}" target="_blank" rel="noreferrer">${item.title||'#'+item.itemId}</a>
        <div class="srow-meta">
          ${item.modelName?`<span>${item.modelName}</span>`:''}
          <span>${ago(item.soldAt)}</span>
        </div>
      </div>
      <div class="srow-right">
        <div class="srow-price">${fmtPrice(item.soldPriceText,item.soldPriceValue)}</div>
        ${ttsFmt?`<div class="srow-tts">${ttsFmt} hasta venta</div>`:''}
      </div>`;
    sl.appendChild(r);
  }
}

// ════════════════════════════════════════════════════════════
//  RENDER CONFIG (rellena los inputs)
// ════════════════════════════════════════════════════════════
function renderConfig() {
  if (!_config) return;
  const pInp=$('product-name'), uInp=$('search-urls');
  if (document.activeElement!==pInp && _config.productName!=null) pInp.value=_config.productName;
  if (document.activeElement!==uInp) {
    const u=Array.isArray(_config.searchUrls)?_config.searchUrls:[];
    uInp.value=u.join('\n');
  }
  const spSel=$('scan-pages');
  if (spSel && _config.scanPages) spSel.value=String(_config.scanPages);
  const pmInp=$('price-min'), pxInp=$('price-max');
  if (pmInp && document.activeElement!==pmInp) pmInp.value=_config.priceMin!=null?_config.priceMin:'';
  if (pxInp && document.activeElement!==pxInp) pxInp.value=_config.priceMax!=null?_config.priceMax:'';
}

// ════════════════════════════════════════════════════════════
//  RENDER MAIN
// ════════════════════════════════════════════════════════════
function render(state, config) {
  _state=state; _config=config;
  renderShell(state, config);
  renderOverview(state);
  if ($('page-items')?.classList.contains('active')) renderItems();
  if ($('page-sales')?.classList.contains('active')) renderSales();
  if ($('page-config')?.classList.contains('active')) renderConfig();
}

async function loadState() {
  try {
    const res=await send('rb:get-state');
    if (res?.success) render(res.state,res.config);
  } catch(_){}
}

// ── CSV export ────────────────────────────────────────────────
function doExport(items) {
  const H=['id','estado','titulo','modelo','url','precio','likes','visitas','detectado','vendido','min_venta'];
  const rows=items.map(i=>{
    const l=i.latest||{};
    return [i.itemId,i.status,i.title,i.modelName,i.url,
      l.priceText,l.likesCount,l.viewsCount,
      i.detectedAt,i.soldAt,i.timeToSellMinutes].map(csvEscape).join(',');
  });
  const blob=new Blob([[H.join(','),...rows].join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=Object.assign(document.createElement('a'),
    {href:url,download:`vinted_${new Date().toISOString().slice(0,10)}.csv`});
  document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

async function runBtn(btn, action, payload={}) {
  const orig=btn.innerHTML; btn.disabled=true;
  btn.innerHTML='…';
  try { await send(action,payload); await loadState(); } catch(_){}
  finally { btn.disabled=false; btn.innerHTML=orig; }
}

// ════════════════════════════════════════════════════════════
//  EVENTOS
// ════════════════════════════════════════════════════════════
$('open-dashboard').addEventListener('click',()=>
  chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}));

$('start-monitor').addEventListener('click', async ()=>{
  let pn=$('product-name').value.trim()||'rayban';
  let urls=parseUrls($('search-urls').value);
  if (!urls.length) urls=[`https://www.vinted.es/catalog?search_text=${encodeURIComponent(pn)}&order=newest_first&page=1&status_ids[]=6&status_ids[]=1`];
  await runBtn($('start-monitor'),'rb:start-monitoring',{productName:pn,searchUrls:urls});
});
$('stop-monitor').addEventListener('click',()=>runBtn($('stop-monitor'),'rb:stop-monitoring'));
$('detect-now').addEventListener('click',  ()=>runBtn($('detect-now'),'rb:run-detect'));
$('track-now').addEventListener('click',   ()=>runBtn($('track-now'),'rb:run-track'));
$('scan-all').addEventListener('click', async ()=>{
  const btn=$('scan-all'); const orig=btn.innerHTML;
  btn.disabled=true; btn.innerHTML='…';
  try { await send('rb:run-detect'); await send('rb:run-track'); await loadState(); } catch(_){}
  finally { btn.disabled=false; btn.innerHTML=orig; }
});
$('clear-sold').addEventListener('click',()=>runBtn($('clear-sold'),'rb:clear-sold'));
$('reset-all').addEventListener('click', ()=>runBtn($('reset-all'),'rb:reset-all'));
$('export-csv').addEventListener('click', async ()=>{
  const res=await send('rb:get-state');
  if (res?.success) doExport(Array.isArray(res.state?.items)?res.state.items:[]);
});

// Guardar toda la config de una vez (URLs + filtros)
$('save-config').addEventListener('click', async ()=>{
  const urls=parseUrls($('search-urls').value);
  if (!urls.length) return;
  const scanPages=parseInt($('scan-pages')?.value||'2',10)||2;
  const priceMin=parseFloat($('price-min')?.value||'')||null;
  const priceMax=parseFloat($('price-max')?.value||'')||null;
  await runBtn($('save-config'),'rb:set-search-urls',{
    searchUrls:urls, scanPages, priceMin, priceMax
  });
});

$('items-search').addEventListener('input', renderItems);
$('items-sort').addEventListener('change', renderItems);

// ════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ════════════════════════════════════════════════════════════
async function bootstrap() {
  initNav();
  const res=await send('rb:get-state');
  const first=!res?.config?.monitorEnabled&&!res?.config?.productName
    &&(!Array.isArray(res?.state?.items)||!res.state.items.length);
  if (first) {
    const pn='rayban';
    const url=`https://www.vinted.es/catalog?search_text=${encodeURIComponent(pn)}&order=newest_first&page=1&status_ids[]=6&status_ids[]=1`;
    try { await send('rb:start-monitoring',{productName:pn,searchUrls:[url]}); } catch(_){}
  }
  if (res?.success) render(res.state,res.config);
  await loadState();
  _pollTimer=setInterval(loadState,15000);
}

void bootstrap();
