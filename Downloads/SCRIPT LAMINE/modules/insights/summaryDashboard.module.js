import {
  createBlockTitle,
  formatDayLabel,
  formatHourLabel,
  renderStatList,
} from './utils.js';

function mergeDayActivity(publicationDays, salesDays) {
  const totals = Array.from({ length: 7 }, (_, day) => ({ day, value: 0 }));

  for (const row of publicationDays || []) {
    totals[row.day].value += Number(row.value || 0);
  }
  for (const row of salesDays || []) {
    totals[row.day].value += Number(row.value || 0);
  }

  return totals;
}

function bestBuyHour(publicationHours, salesHours) {
  const values = Array.from({ length: 24 }, (_, hour) => {
    const pub = Number(publicationHours?.[hour]?.value || 0);
    const sold = Number(salesHours?.[hour]?.value || 0);
    return {
      hour,
      score: pub - sold,
    };
  });

  return values.reduce((best, current) => {
    if (!best) return current;
    if (current.score > best.score) return current;
    return best;
  }, null);
}

function topByValue(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.reduce((best, current) => {
    if (!best) return current;
    if ((current?.value || 0) > (best?.value || 0)) return current;
    return best;
  }, null);
}

function computeOpportunityLevel(saturation, salesMetrics, buyHour) {
  const sat = String(saturation || 'media').toLowerCase();
  const avgDays = Number(salesMetrics?.avgTimeDays || 0);
  const buyScore = Number(buyHour?.score || 0);

  if (sat === 'baja' && avgDays > 0 && avgDays <= 2.5 && buyScore >= 1) return 'buena';
  if (sat === 'alta' && (avgDays === 0 || avgDays >= 4)) return 'mala';
  if (sat === 'alta' && buyScore <= 0) return 'mala';
  return 'normal';
}

export const summaryDashboardModule = {
  id: 'summary-dashboard',

  capture(ctx) {
    return {
      saturationMetrics: ctx?.moduleResults?.saturation?.metrics || null,
      publicationMetrics: ctx?.moduleResults?.publications?.metrics || null,
      salesMetrics: ctx?.moduleResults?.sales?.metrics || null,
    };
  },

  process(captured) {
    const publicationHours = captured.publicationMetrics?.hourBuckets || [];
    const salesHours = captured.salesMetrics?.hourBuckets || [];
    const publicationDays = captured.publicationMetrics?.dayBuckets || [];
    const salesDays = captured.salesMetrics?.dayBuckets || [];

    return {
      ...captured,
      combinedDayActivity: mergeDayActivity(publicationDays, salesDays),
      buyHourCandidate: bestBuyHour(publicationHours, salesHours),
    };
  },

  metrics(processed) {
    const topCombinedDay = topByValue(processed.combinedDayActivity);
    const bestBuy = processed.buyHourCandidate;

    const bestPublishHour = processed.publicationMetrics?.topHour
      ? formatHourLabel(processed.publicationMetrics.topHour.hour)
      : '-';
    const bestSellHour = processed.salesMetrics?.topHour
      ? formatHourLabel(processed.salesMetrics.topHour.hour)
      : '-';

    const opportunityLevel = computeOpportunityLevel(
      processed.saturationMetrics?.saturation,
      processed.salesMetrics,
      bestBuy
    );

    return {
      saturationLevel: processed.saturationMetrics?.saturation || '-',
      bestBuyHour: bestBuy ? formatHourLabel(bestBuy.hour) : '-',
      bestPublishHour,
      bestSellHour,
      mostActiveDay: topCombinedDay ? formatDayLabel(topCombinedDay.day) : '-',
      opportunityLevel,
    };
  },

  render(metrics, container) {
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(createBlockTitle('Resumen estrategico'));

    renderStatList(container, [
      { label: 'Saturacion', value: metrics.saturationLevel },
      { label: 'Mejor hora para comprar', value: metrics.bestBuyHour },
      { label: 'Mejor hora para publicar', value: metrics.bestPublishHour },
      { label: 'Hora con mas ventas', value: metrics.bestSellHour },
      { label: 'Dia con mas actividad', value: metrics.mostActiveDay },
      { label: 'Nivel de oportunidad', value: metrics.opportunityLevel },
    ]);
  },
};
