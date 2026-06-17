import {
  buildWeekSlotHeatmap,
  buildDayBuckets,
  buildHourBuckets,
  createBlockTitle,
  dateToTimestamp,
  formatDayLabel,
  formatHourLabel,
  formatHourRange,
  renderWeekSlotHeatmap,
  renderStatList,
  rollingHourWindowPeak,
  toFiniteNumber,
  topBucketByValue,
} from './utils.js';

function estimateSoldTimestamp(item) {
  const soldAtTs = dateToTimestamp(item?.soldAt);
  if (soldAtTs !== null) return soldAtTs;

  const detectedTs = dateToTimestamp(item?.detectedAt);
  const timeToSellMinutes = toFiniteNumber(item?.timeToSellMinutes);
  if (detectedTs !== null && timeToSellMinutes !== null) {
    return detectedTs + timeToSellMinutes * 60 * 1000;
  }

  return null;
}

function estimateTimeToSellMinutes(item) {
  const direct = toFiniteNumber(item?.timeToSellMinutes);
  if (direct !== null) return direct;

  const soldTs = dateToTimestamp(item?.soldAt);
  const detectedTs = dateToTimestamp(item?.detectedAt);
  if (soldTs !== null && detectedTs !== null && soldTs >= detectedTs) {
    return (soldTs - detectedTs) / (60 * 1000);
  }

  return null;
}

export const salesTimingModule = {
  id: 'sales-timing',

  capture(ctx) {
    const items = Array.isArray(ctx?.items) ? ctx.items : [];
    const soldItems = items.filter((item) => item?.status === 'sold');

    return {
      soldItems,
    };
  },

  process(captured) {
    const soldTimestamps = [];
    const timeToSellMinutes = [];

    for (const item of captured.soldItems) {
      const soldTs = estimateSoldTimestamp(item);
      if (soldTs !== null) {
        soldTimestamps.push(new Date(soldTs).toISOString());
      }

      const minutes = estimateTimeToSellMinutes(item);
      if (minutes !== null) {
        timeToSellMinutes.push(minutes);
      }
    }

    const hourBuckets = buildHourBuckets(soldTimestamps);
    const dayBuckets = buildDayBuckets(soldTimestamps);
    const heatmap = buildWeekSlotHeatmap(soldTimestamps, {
      slotHours: 3,
      weekStartsMonday: true,
    });

    return {
      soldCount: captured.soldItems.length,
      hourBuckets,
      dayBuckets,
      heatmap,
      windowPeak: rollingHourWindowPeak(hourBuckets, 3),
      timeToSellMinutes,
    };
  },

  metrics(processed) {
    const topHour = topBucketByValue(processed.hourBuckets, 'hour');
    const topDay = topBucketByValue(processed.dayBuckets, 'day');

    const avgTimeMinutes = processed.timeToSellMinutes.length
      ? processed.timeToSellMinutes.reduce((acc, value) => acc + value, 0) / processed.timeToSellMinutes.length
      : null;

    return {
      soldCount: processed.soldCount,
      topHour,
      topDay,
      windowPeak: processed.windowPeak,
      avgTimeMinutes,
      avgTimeDays: avgTimeMinutes == null ? null : avgTimeMinutes / (60 * 24),
      heatmap: processed.heatmap,
      hourBuckets: processed.hourBuckets,
      dayBuckets: processed.dayBuckets,
    };
  },

  render(metrics, container) {
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(createBlockTitle('Horas y dias con mas ventas'));

    if (!metrics.soldCount) {
      const p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent = 'Aun no hay ventas detectadas para estimar franjas de venta.';
      container.appendChild(p);
      return;
    }

    renderStatList(container, [
      {
        label: 'Franja horaria con mas ventas',
        value: formatHourRange(metrics.windowPeak.startHour, metrics.windowPeak.windowSize),
      },
      {
        label: 'Hora pico de ventas',
        value: metrics.topHour ? formatHourLabel(metrics.topHour.hour) : '-',
      },
      {
        label: 'Dia con mas ventas',
        value: metrics.topDay ? formatDayLabel(metrics.topDay.day) : '-',
      },
      {
        label: 'Tiempo medio de venta',
        value: metrics.avgTimeDays == null ? '-' : `${metrics.avgTimeDays.toFixed(2)} dias`,
      },
    ]);

    const heatTitle = document.createElement('p');
    heatTitle.className = 'insight-subtitle';
    heatTitle.textContent = 'Mapa de calor semanal (ventas)';
    container.appendChild(heatTitle);

    renderWeekSlotHeatmap(container, metrics.heatmap, {
      variant: 'sales',
    });
  },
};
