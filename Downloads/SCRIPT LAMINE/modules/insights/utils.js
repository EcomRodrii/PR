export const DAY_LABELS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
export const DAY_SHORT_LABELS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

export function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

export function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

export function unique(values) {
  return [...new Set(Array.isArray(values) ? values.filter(Boolean) : [])];
}

export function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parsePriceValue(priceText) {
  if (!priceText) return null;
  const match = String(priceText).replace(/\s+/g, '').match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function parseItemPriceValue(item) {
  const latest = item?.latest || {};
  return (
    toFiniteNumber(latest.priceValue) ||
    parsePriceValue(latest.priceText || null) ||
    toFiniteNumber(item?.soldPriceValue) ||
    parsePriceValue(item?.soldPriceText || null)
  );
}

export function extractItemText(item) {
  return normalizeText(`${item?.title || ''} ${item?.description || ''} ${item?.modelName || ''}`);
}

export function extractSearchContext(config) {
  const urls = Array.isArray(config?.searchUrls)
    ? config.searchUrls
    : (config?.searchUrl ? [config.searchUrl] : []);

  const searchTokens = [];
  const brandHints = [];
  const categoryHints = [];

  for (const value of urls) {
    try {
      const parsed = new URL(String(value || ''));
      const searchText = parsed.searchParams.get('search_text');
      if (searchText) {
        searchTokens.push(...tokenize(searchText));
      }

      const brands = parsed.searchParams.getAll('brand_ids[]');
      for (const b of brands) {
        const normalized = normalizeText(b);
        if (normalized) brandHints.push(normalized);
      }

      const catalogs = parsed.searchParams.getAll('catalog[]');
      for (const c of catalogs) {
        const normalized = normalizeText(c);
        if (normalized) categoryHints.push(normalized);
      }
    } catch (_) {
      // Ignore invalid URLs from user input.
    }
  }

  return {
    tokens: unique(searchTokens),
    brandHints: unique(brandHints),
    categoryHints: unique(categoryHints),
  };
}

export function dateToTimestamp(value) {
  const ts = new Date(value || 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

export function buildHourBuckets(values) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, value: 0 }));
  for (const value of values) {
    const ts = dateToTimestamp(value);
    if (ts === null) continue;
    const hour = new Date(ts).getHours();
    buckets[hour].value += 1;
  }
  return buckets;
}

export function buildDayBuckets(values) {
  const buckets = Array.from({ length: 7 }, (_, day) => ({ day, value: 0 }));
  for (const value of values) {
    const ts = dateToTimestamp(value);
    if (ts === null) continue;
    const day = new Date(ts).getDay();
    buckets[day].value += 1;
  }
  return buckets;
}

export function topBucketByValue(buckets, keyName) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  return buckets.reduce((best, current) => {
    if (!best) return current;
    if ((current?.value || 0) > (best?.value || 0)) return current;
    return best;
  }, null);
}

export function formatHourLabel(hour) {
  const safeHour = Math.max(0, Math.min(23, Number(hour) || 0));
  const value = String(safeHour).padStart(2, '0');
  return `${value}:00`;
}

export function formatHourRange(startHour, length) {
  const start = Number(startHour) || 0;
  const end = (start + Math.max(1, Number(length) || 1)) % 24;
  return `${formatHourLabel(start)}-${formatHourLabel(end)}`;
}

export function rollingHourWindowPeak(hourBuckets, windowSize = 4) {
  if (!Array.isArray(hourBuckets) || hourBuckets.length !== 24) {
    return { startHour: 0, total: 0, windowSize };
  }
  let best = { startHour: 0, total: -1, windowSize };
  for (let start = 0; start < 24; start += 1) {
    let total = 0;
    for (let offset = 0; offset < windowSize; offset += 1) {
      const hour = (start + offset) % 24;
      total += Number(hourBuckets[hour]?.value || 0);
    }
    if (total > best.total) {
      best = { startHour: start, total, windowSize };
    }
  }
  return best;
}

export function formatCurrency(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '-';
  return `${number.toFixed(2)}€`;
}

export function formatDayLabel(dayIndex) {
  const idx = Number(dayIndex);
  if (!Number.isFinite(idx) || idx < 0 || idx > 6) return '-';
  return DAY_LABELS[idx] || '-';
}

export function createBlockTitle(text) {
  const h = document.createElement('h3');
  h.className = 'insight-block-title';
  h.textContent = text;
  return h;
}

export function renderStatList(container, rows) {
  const list = document.createElement('div');
  list.className = 'insight-stat-list';
  for (const row of rows) {
    const line = document.createElement('p');
    line.className = 'insight-stat-item';
    const label = document.createElement('span');
    label.textContent = row?.label == null ? '' : String(row.label);
    const value = document.createElement('strong');
    value.textContent = row?.value == null ? '' : String(row.value);
    line.appendChild(label);
    line.appendChild(value);
    list.appendChild(line);
  }
  container.appendChild(list);
}

export function renderBarRows(container, rows, maxRows = 8) {
  const cleanRows = Array.isArray(rows)
    ? rows
      .map((row) => ({ label: row.label, value: Number(row.value) || 0 }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, maxRows)
    : [];

  if (!cleanRows.length) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Sin datos suficientes.';
    container.appendChild(p);
    return;
  }

  const max = Math.max(...cleanRows.map((row) => row.value), 1);
  for (const row of cleanRows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'bar-row';

    const name = document.createElement('span');
    name.className = 'bar-name';
    name.textContent = row.label;

    const track = document.createElement('span');
    track.className = 'bar-track';

    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(3, Math.round((row.value / max) * 100))}%`;
    track.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = String(row.value);

    wrapper.appendChild(name);
    wrapper.appendChild(track);
    wrapper.appendChild(value);
    container.appendChild(wrapper);
  }
}

export function renderDistributionChart(container, rows, options = {}) {
  const inputRows = Array.isArray(rows) ? rows : [];
  const maxRows = Math.max(1, Number(options.maxRows) || inputRows.length || 1);
  const showLabelEvery = Math.max(1, Number(options.showLabelEvery) || 1);
  const variant = String(options.variant || '').trim();
  const cleanRows = inputRows
    .map((row) => ({
      label: row?.label == null ? '' : String(row.label),
      value: Number(row?.value) || 0,
    }))
    .slice(0, maxRows);

  if (!cleanRows.length || !cleanRows.some((row) => row.value > 0)) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Sin datos suficientes.';
    container.appendChild(p);
    return;
  }

  const chart = document.createElement('div');
  chart.className = `insight-dist-chart${variant ? ` insight-dist-chart--${variant}` : ''}`;
  const max = Math.max(...cleanRows.map((row) => row.value), 1);

  cleanRows.forEach((row, idx) => {
    const col = document.createElement('div');
    col.className = 'insight-dist-col';
    col.title = `${row.label}: ${row.value}`;

    const value = document.createElement('span');
    value.className = 'insight-dist-value';
    value.textContent = String(row.value);

    const track = document.createElement('span');
    track.className = 'insight-dist-track';

    const fill = document.createElement('span');
    fill.className = 'insight-dist-fill';
    if (row.value <= 0) {
      fill.style.height = '2px';
      fill.style.opacity = '0.25';
    } else {
      fill.style.height = `${Math.max(5, Math.round((row.value / max) * 100))}%`;
    }
    track.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'insight-dist-label';
    label.textContent = row.label;
    if (showLabelEvery > 1 && idx % showLabelEvery !== 0) {
      label.classList.add('is-muted');
      label.textContent = '·';
    }

    col.appendChild(value);
    col.appendChild(track);
    col.appendChild(label);
    chart.appendChild(col);
  });

  container.appendChild(chart);
}

export function buildWeekSlotHeatmap(values, options = {}) {
  const slotHoursRaw = Number(options.slotHours) || 3;
  const slotHours = Math.max(1, Math.min(12, slotHoursRaw));
  const slotCount = Math.max(1, Math.ceil(24 / slotHours));
  const weekStartsMonday = options.weekStartsMonday !== false;
  const dayOrder = weekStartsMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];

  const matrix = Array.from({ length: 7 }, () => Array.from({ length: slotCount }, () => 0));
  for (const value of Array.isArray(values) ? values : []) {
    const ts = dateToTimestamp(value);
    if (ts === null) continue;
    const date = new Date(ts);
    const day = date.getDay();
    const hour = date.getHours();
    const slot = Math.min(slotCount - 1, Math.max(0, Math.floor(hour / slotHours)));
    matrix[day][slot] += 1;
  }

  const slotLabels = Array.from({ length: slotCount }, (_, idx) => {
    const start = idx * slotHours;
    const end = Math.min(24, (idx + 1) * slotHours);
    return `${start}-${end}h`;
  });

  const dayRows = dayOrder.map((day) => {
    const slots = matrix[day];
    const total = slots.reduce((acc, value) => acc + value, 0);
    return {
      day,
      label: DAY_SHORT_LABELS[day] || '-',
      fullLabel: DAY_LABELS[day] || '-',
      slots,
      total,
    };
  });

  const allValues = dayRows.flatMap((row) => row.slots);
  const maxValue = allValues.length ? Math.max(...allValues) : 0;
  const totalEvents = allValues.reduce((acc, value) => acc + value, 0);

  return {
    slotHours,
    slotCount,
    slotLabels,
    dayRows,
    maxValue,
    totalEvents,
  };
}

export function renderWeekSlotHeatmap(container, heatmap, options = {}) {
  const data = heatmap && typeof heatmap === 'object' ? heatmap : null;
  if (!container) return;

  if (!data || !Array.isArray(data.dayRows) || !data.dayRows.length || Number(data.totalEvents || 0) <= 0) {
    const p = document.createElement('p');
    p.className = 'chart-fallback';
    p.textContent = 'Sin datos suficientes.';
    container.appendChild(p);
    return;
  }

  const variant = String(options.variant || '').trim();
  const wrapper = document.createElement('div');
  wrapper.className = `insight-heatmap${variant ? ` insight-heatmap--${variant}` : ''}`;

  const header = document.createElement('div');
  header.className = 'insight-heatmap-row insight-heatmap-row--header';

  const corner = document.createElement('span');
  corner.className = 'insight-heatmap-corner';
  corner.textContent = 'dia';
  header.appendChild(corner);

  for (const slotLabel of data.slotLabels) {
    const col = document.createElement('span');
    col.className = 'insight-heatmap-col-label';
    col.textContent = slotLabel;
    header.appendChild(col);
  }
  wrapper.appendChild(header);

  const maxValue = Math.max(1, Number(data.maxValue) || 1);
  for (const row of data.dayRows) {
    const line = document.createElement('div');
    line.className = 'insight-heatmap-row';

    const dayLabel = document.createElement('span');
    dayLabel.className = 'insight-heatmap-day-label';
    dayLabel.textContent = row.label;
    dayLabel.title = row.fullLabel;
    line.appendChild(dayLabel);

    for (const valueRaw of row.slots) {
      const value = Math.max(0, Number(valueRaw) || 0);
      const cell = document.createElement('span');
      const intensity = Math.max(0, Math.min(1, value / maxValue));
      cell.className = 'insight-heatmap-cell';
      cell.style.setProperty('--heat', intensity.toFixed(4));
      cell.textContent = String(value);
      cell.title = `${row.fullLabel} - ${value}`;
      if (value <= 0) {
        cell.classList.add('is-zero');
      }
      line.appendChild(cell);
    }

    wrapper.appendChild(line);
  }

  container.appendChild(wrapper);
}
