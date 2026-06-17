import {
  buildWeekSlotHeatmap,
  buildDayBuckets,
  buildHourBuckets,
  createBlockTitle,
  formatDayLabel,
  formatHourLabel,
  formatHourRange,
  renderWeekSlotHeatmap,
  renderStatList,
  rollingHourWindowPeak,
  topBucketByValue,
} from './utils.js';

export const publicationTimingModule = {
  id: 'publication-timing',

  capture(ctx) {
    const items = Array.isArray(ctx?.items) ? ctx.items : [];
    const publicationTimes = [];
    let pendingItems = 0;
    let resolvedItems = 0;
    for (const item of items) {
      const value = item?.publishedAt || item?.latest?.publishedAt || null;
      if (value) {
        publicationTimes.push(value);
        resolvedItems += 1;
      } else {
        pendingItems += 1;
      }
    }

    return {
      publicationTimes,
      totalItems: items.length,
      pendingItems,
      resolvedItems,
    };
  },

  process(captured) {
    const hourBuckets = buildHourBuckets(captured.publicationTimes);
    const dayBuckets = buildDayBuckets(captured.publicationTimes);
    const windowPeak = rollingHourWindowPeak(hourBuckets, 4);
    const heatmap = buildWeekSlotHeatmap(captured.publicationTimes, {
      slotHours: 3,
      weekStartsMonday: true,
    });

    return {
      hourBuckets,
      dayBuckets,
      windowPeak,
      heatmap,
      totalItems: captured.totalItems,
      pendingItems: captured.pendingItems,
      resolvedItems: captured.resolvedItems,
    };
  },

  metrics(processed) {
    const hasPublicationData = Number(processed.resolvedItems || 0) > 0;
    const topHour = hasPublicationData ? topBucketByValue(processed.hourBuckets, 'hour') : null;
    const topDay = hasPublicationData ? topBucketByValue(processed.dayBuckets, 'day') : null;

    return {
      totalItems: processed.totalItems,
      pendingItems: processed.pendingItems,
      resolvedItems: processed.resolvedItems,
      topHour,
      topDay,
      windowPeak: processed.windowPeak,
      heatmap: processed.heatmap,
      hourBuckets: processed.hourBuckets,
      dayBuckets: processed.dayBuckets,
    };
  },

  render(metrics, container) {
    if (!container) return;
    container.innerHTML = '';

    container.appendChild(createBlockTitle('Horas y dias con mas publicaciones'));

    if (!metrics.totalItems) {
      const p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent = 'Aun no hay publicaciones detectadas para analizar.';
      container.appendChild(p);
      return;
    }
    if (!metrics.resolvedItems) {
      const p = document.createElement('p');
      p.className = 'chart-fallback';
      p.textContent = 'Aun no hay hora de publicacion real estimada. El sistema debe abrir fichas para capturar "Subido hace...".';
      container.appendChild(p);
      return;
    }

    renderStatList(container, [
      {
        label: 'Hora con mas publicaciones',
        value: metrics.topHour ? formatHourLabel(metrics.topHour.hour) : '-',
      },
      {
        label: 'Dia con mas publicaciones',
        value: metrics.topDay ? formatDayLabel(metrics.topDay.day) : '-',
      },
      {
        label: 'Franja pico',
        value: formatHourRange(metrics.windowPeak.startHour, metrics.windowPeak.windowSize),
      },
      {
        label: 'Publicaciones en franja pico',
        value: String(metrics.windowPeak.total || 0),
      },
      {
        label: 'Publicaciones con hora real',
        value: `${metrics.resolvedItems}/${metrics.totalItems}`,
      },
    ]);

    if (metrics.pendingItems > 0) {
      const pending = document.createElement('p');
      pending.className = 'insight-subtext';
      pending.textContent = `${metrics.pendingItems} anuncio(s) pendiente(s) de lectura de "Subido hace...".`;
      container.appendChild(pending);
    }

    const heatTitle = document.createElement('p');
    heatTitle.className = 'insight-subtitle';
    heatTitle.textContent = 'Mapa de calor semanal (publicaciones)';
    container.appendChild(heatTitle);

    renderWeekSlotHeatmap(container, metrics.heatmap, {
      variant: 'publications',
    });
  },
};
