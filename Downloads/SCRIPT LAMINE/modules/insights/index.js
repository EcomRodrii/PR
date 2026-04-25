import { marketSaturationModule } from './marketSaturation.module.js';
import { publicationTimingModule } from './publicationTiming.module.js';
import { salesTimingModule } from './salesTiming.module.js';
import { summaryDashboardModule } from './summaryDashboard.module.js';

function runModule(moduleDef, ctx) {
  try {
    const captured = moduleDef.capture(ctx);
    const processed = moduleDef.process(captured, ctx);
    const metrics = moduleDef.metrics(processed, ctx);
    return {
      ok: true,
      id: moduleDef.id,
      captured,
      processed,
      metrics,
    };
  } catch (error) {
    return {
      ok: false,
      id: moduleDef.id,
      error,
      captured: null,
      processed: null,
      metrics: null,
    };
  }
}

export function runInsightsModules(ctx) {
  const saturation = runModule(marketSaturationModule, ctx);
  const publications = runModule(publicationTimingModule, ctx);
  const sales = runModule(salesTimingModule, ctx);

  const summaryCtx = {
    ...ctx,
    moduleResults: {
      saturation,
      publications,
      sales,
    },
  };
  const summary = runModule(summaryDashboardModule, summaryCtx);

  return {
    saturation,
    publications,
    sales,
    summary,
  };
}

function renderOne(moduleDef, result, container) {
  if (!container) return;
  if (!result?.ok || !result?.metrics) {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = `Error en modulo ${moduleDef.id}`;
    container.appendChild(p);
    return;
  }
  moduleDef.render(result.metrics, container, result);
}

export function renderInsightsModules(results, containers) {
  renderOne(marketSaturationModule, results?.saturation, containers?.saturation);
  renderOne(publicationTimingModule, results?.publications, containers?.publications);
  renderOne(salesTimingModule, results?.sales, containers?.sales);
  renderOne(summaryDashboardModule, results?.summary, containers?.summary);
}
