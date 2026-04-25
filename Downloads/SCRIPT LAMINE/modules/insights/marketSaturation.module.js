import {
  createBlockTitle,
  extractItemText,
  extractSearchContext,
  formatCurrency,
  parseItemPriceValue,
  renderStatList,
  tokenize,
  toFiniteNumber,
  unique,
} from './utils.js';

const STOCK_MIN_MATURE_MS = 24 * 60 * 60 * 1000;

function buildReferenceTokens(ctx) {
  const configName = tokenize(ctx?.config?.productName || '');
  const modelFilter = tokenize(ctx?.filters?.model || '');
  const searchContext = extractSearchContext(ctx?.config || {});
  return {
    referenceTokens: unique([...configName, ...modelFilter, ...searchContext.tokens]),
    brandHints: searchContext.brandHints,
    categoryHints: searchContext.categoryHints,
  };
}

function similarityScore(item, referenceTokens) {
  if (!referenceTokens.length) return 0;
  const text = extractItemText(item);
  const model = String(item?.modelName || '').toLowerCase().trim();
  let score = 0;

  for (const token of referenceTokens) {
    if (!token) continue;
    if (model && model === token) {
      score += 3;
      continue;
    }
    if (text.includes(token)) {
      score += token.length >= 6 ? 1.5 : 1;
    }
  }

  return score;
}

function saturationLabel(count) {
  if (count >= 100) return 'alta';
  if (count >= 35) return 'media';
  return 'baja';
}

function competitionLabel({ saturation, avgLikes, avgOffers }) {
  if (saturation === 'alta' || avgOffers >= 2 || avgLikes >= 6) return 'fuerte';
  if (saturation === 'media' || avgOffers >= 1 || avgLikes >= 3) return 'media';
  return 'ligera';
}

function estimateSoldTimestampMs(item) {
  const soldAtMs = new Date(item?.soldAt || 0).getTime();
  if (Number.isFinite(soldAtMs) && soldAtMs > 0) return soldAtMs;
  const detectedMs = new Date(item?.detectedAt || 0).getTime();
  const timeToSellMinutes = toFiniteNumber(item?.timeToSellMinutes);
  if (!Number.isFinite(detectedMs) || detectedMs <= 0 || timeToSellMinutes == null) return null;
  return detectedMs + Number(timeToSellMinutes) * 60 * 1000;
}

function formatRemainingDuration(msInput) {
  const ms = Math.max(0, Number(msInput) || 0);
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m`;
}

export const marketSaturationModule = {
  id: 'market-saturation',

  capture(ctx) {
    const items = Array.isArray(ctx?.items) ? ctx.items : [];
    const activeItems = items.filter((item) => item?.status === 'active' || item?.status === 'reserved');
    const soldItems = items.filter((item) => item?.status === 'sold');
    const refs = buildReferenceTokens(ctx || {});
    const analysisAgeMs = Math.max(0, Number(ctx?.analysis?.ageMs || 0));
    const isReady = ctx?.analysis?.ready24h === true || analysisAgeMs >= STOCK_MIN_MATURE_MS;
    const remainingMs = Math.max(0, STOCK_MIN_MATURE_MS - analysisAgeMs);

    return {
      activeItems,
      soldItems,
      ...refs,
      analysisAgeMs,
      isReady,
      remainingMs,
    };
  },

  process(captured) {
    const minScore = captured.referenceTokens.length >= 3 ? 2 : 1;
    const similarActiveItems = [];
    const similarSoldItems = [];

    for (const item of captured.activeItems) {
      const score = similarityScore(item, captured.referenceTokens);
      if (score >= minScore) {
        similarActiveItems.push({ item, score });
      }
    }
    for (const item of captured.soldItems) {
      const score = similarityScore(item, captured.referenceTokens);
      if (score >= minScore) {
        similarSoldItems.push({ item, score });
      }
    }

    similarActiveItems.sort((a, b) => b.score - a.score);
    similarSoldItems.sort((a, b) => b.score - a.score);
    return {
      similarActiveItems,
      similarSoldItems,
      referenceTokens: captured.referenceTokens,
      brandHints: captured.brandHints,
      categoryHints: captured.categoryHints,
      analysisAgeMs: captured.analysisAgeMs,
      isReady: captured.isReady,
      remainingMs: captured.remainingMs,
    };
  },

  metrics(processed) {
    const similarActiveItems = processed.similarActiveItems.map((entry) => entry.item);
    const similarSoldItems = processed.similarSoldItems.map((entry) => entry.item);
    const prices = similarActiveItems
      .map((item) => parseItemPriceValue(item))
      .filter((value) => toFiniteNumber(value) !== null)
      .map((value) => Number(value));

    const likes = similarActiveItems
      .map((item) => toFiniteNumber(item?.latest?.likesCount) || 0);
    const offers = similarActiveItems
      .map((item) => toFiniteNumber(item?.latest?.offersCount) || 0);

    const avgPrice = prices.length ? prices.reduce((acc, value) => acc + value, 0) / prices.length : null;
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const avgLikes = likes.length ? likes.reduce((acc, value) => acc + value, 0) / likes.length : 0;
    const avgOffers = offers.length ? offers.reduce((acc, value) => acc + value, 0) / offers.length : 0;

    const count = similarActiveItems.length;
    const saturation = saturationLabel(count);
    const competition = competitionLabel({ saturation, avgLikes, avgOffers });
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const soldLast24h = similarSoldItems.filter((item) => {
      const soldTs = estimateSoldTimestampMs(item);
      return Number.isFinite(soldTs) && soldTs >= sinceMs;
    }).length;
    const ageDays = Math.max(0, Number(processed.analysisAgeMs || 0) / (24 * 60 * 60 * 1000));
    const estimatedDailySales =
      soldLast24h > 0
        ? soldLast24h
        : ageDays > 0
          ? similarSoldItems.length / Math.max(1, ageDays)
          : 0;
    const stockRotationDays =
      estimatedDailySales > 0 ? count / estimatedDailySales : null;

    return {
      count,
      saturation,
      competition,
      avgPrice,
      minPrice,
      maxPrice,
      avgLikes,
      avgOffers,
      referenceTokens: processed.referenceTokens,
      sample: similarActiveItems.slice(0, 5),
      soldLast24h,
      estimatedDailySales,
      stockRotationDays,
      isReady: processed.isReady === true,
      remainingMs: Math.max(0, Number(processed.remainingMs) || 0),
    };
  },

  render(metrics, container) {
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(createBlockTitle('📦 Stock estimado del mercado'));

    if (!metrics.isReady) {
      const pending = document.createElement('p');
      pending.className = 'insight-subtext';
      pending.textContent = `Disponible tras 24h de analisis. Tiempo restante: ${formatRemainingDuration(metrics.remainingMs)}.`;
      container.appendChild(pending);
      return;
    }

    if (!metrics.referenceTokens.length) {
      const p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent = 'Define nombre de campana o links con terminos para calcular similitud.';
      container.appendChild(p);
      return;
    }

    renderStatList(container, [
      {
        label: 'Ventas diarias estimadas',
        value: Number(metrics.estimatedDailySales || 0).toFixed(1),
      },
      { label: 'Anuncios activos similares', value: String(metrics.count) },
      {
        label: 'Rotacion estimada de stock',
        value: metrics.stockRotationDays == null ? '-' : `${metrics.stockRotationDays.toFixed(1)} dias`,
      },
      {
        label: 'Rango de precios',
        value:
          metrics.minPrice == null || metrics.maxPrice == null
            ? '-'
            : `${formatCurrency(metrics.minPrice)} - ${formatCurrency(metrics.maxPrice)}`,
      },
      { label: 'Precio medio actual', value: formatCurrency(metrics.avgPrice) },
      { label: 'Nivel de saturacion', value: metrics.saturation },
      { label: 'Competencia estimada', value: metrics.competition },
      { label: 'Ventas detectadas (ultimas 24h)', value: String(metrics.soldLast24h || 0) },
    ]);

    const tokens = document.createElement('p');
    tokens.className = 'insight-subtext';
    tokens.textContent = `Base de similitud: ${metrics.referenceTokens.slice(0, 12).join(', ')}`;
    container.appendChild(tokens);

    if (metrics.sample.length) {
      const sampleTitle = document.createElement('p');
      sampleTitle.className = 'insight-subtitle';
      sampleTitle.textContent = 'Muestra de anuncios similares';
      container.appendChild(sampleTitle);

      const list = document.createElement('ul');
      list.className = 'insight-list';
      for (const item of metrics.sample) {
        const li = document.createElement('li');
        li.textContent = `${item.title || `Item ${item.itemId}`} | ${item.latest?.priceText || '-'}`;
        list.appendChild(li);
      }
      container.appendChild(list);
    }
  },
};
