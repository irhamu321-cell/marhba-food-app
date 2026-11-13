/* Small helpers shared by every admin section. */
import { money, esc, fmtDate, statusBadge, getToken, toast } from './api.js';
import { t, lang, pick } from './i18n.js';

export const $ = (id) => document.getElementById(id);
export const el = () => document.getElementById('content');

export const localName = (row, field = 'name') =>
  esc(lang === 'ar' ? (row[`${field}_ar`] || row[field] || '') : (row[field] || ''));

/**
 * One number on a card. `opts` may carry an icon, a footnote, a trend
 * ({ dir: 'up'|'down'|'flat', text }), an accent flag and a target section.
 */
export const kpi = (label, value, hint = '', opts = {}) => {
  const { icon = '', trend = null, accent = false, go = '', small = false } = opts;
  return `
  <div class="stat${accent ? ' accent' : ''}${go ? ' clickable' : ''}"${go ? ` data-kpigo="${go}"` : ''}>
    <div class="label">${icon ? `<span class="ic">${icon}</span>` : ''}${label}</div>
    <div class="value${small ? ' sm' : ''}">${value}</div>
    ${trend ? `<div class="foot"><span class="trend ${trend.dir}">${
      trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '—'} ${esc(trend.text)}</span></div>` : ''}
    ${hint ? `<div class="foot">${hint}</div>` : ''}
  </div>`;
};

export const panel = (title, body, actions = '') => `
  <div class="panel">
    <div class="panel-head"><h3>${title}</h3><div class="grow"></div>${actions}</div>
    ${body}
  </div>`;

/** Page title, subtitle and the buttons that belong to the whole screen. */
export const pageHead = (title, sub = '', actions = '') => `
  <div class="pagehead">
    <div class="grow"><h1>${title}</h1>${sub ? `<p class="sub muted">${sub}</p>` : ''}</div>
    ${actions ? `<div class="btnrow">${actions}</div>` : ''}
  </div>`;

export const emptyState = (icon, text, sub = '', action = '') => `
  <div class="empty">
    <div class="ic">${icon}</div>
    <h3>${text}</h3>
    ${sub ? `<p>${sub}</p>` : ''}
    ${action}
  </div>`;

/** Vertical bars. `rows` is [{ label, value, top }]; the tallest fills the box. */
export const barChart = (rows, opts = {}) => {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  return `<div class="bars">${rows.map((r) => {
    const height = Math.round(((Number(r.value) || 0) / max) * 100);
    return `<div class="bar" title="${esc(String(r.top ?? r.value))}">
      <div class="top">${r.top ?? (Number(r.value) ? r.value : '')}</div>
      <div class="trackv"><div class="fill${opts.alt ? ' alt' : ''}" style="height:${
        Number(r.value) ? Math.max(height, 4) : 0}%"></div></div>
      <div class="cap">${esc(r.label)}</div>
    </div>`;
  }).join('')}</div>`;
};

/** Horizontal bars for a breakdown. `rows` is [{ label, value, tone }]. */
export const barList = (rows) => {
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  return `<div class="hbars">${rows.map((r) => `
    <div class="hbar">
      <div class="truncate">${esc(r.label)}</div>
      <div class="track"><i class="${r.tone || ''}" style="width:${Math.round(((Number(r.value) || 0) / max) * 100)}%"></i></div>
      <div class="n">${Number(r.value) || 0}</div>
    </div>`).join('')}</div>`;
};

/** A table inside a bordered card, with an optional footer row. */
export const tableCard = (headers, rows, footer = '') => `
  <div class="tablewrap">
    <div class="scroller">
      <table>
        <thead><tr>${headers.map((h) => `<th${h.num ? ' class="num"' : ''}>${h.label ?? h}</th>`).join('')}</tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
    ${footer}
  </div>`;

export const skeletonRows = (count = 3) =>
  Array.from({ length: count }, () => `<div class="sk-line skeleton w80"></div>`).join('');

export const table = (headers, rows) => rows.length
  ? `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : '';

/** Wire every element carrying a data attribute to a handler. */
export function on(attribute, handler) {
  document.querySelectorAll(`[data-${attribute}]`).forEach((node) => {
    node.onclick = (event) => handler(node.dataset[attribute], node, event);
  });
}

export const dateInput = (value = '') => esc(value);

/**
 * Downloads a CSV using exactly the filters on screen. The server re-checks the
 * caller's permission, so this is a convenience, not the gate.
 */
export async function exportCsv(path, params = {}, filename = 'export') {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  query.set('format', 'csv');
  try {
    const res = await fetch(`/api${path}?${query}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } catch (e) { toast(e.message, true); }
}

export const csvButton = (id) => `<button class="small" id="${id}">⬇ CSV</button>`;

export const toCents = (value) => Math.round(Number(String(value ?? 0).replace(',', '.')) * 100);
export const fromCents = (cents) => (Number(cents || 0) / 100).toFixed(2);

export { money, esc, fmtDate, statusBadge, t, lang, pick };

/* ---------- service types and cuisines ---------- */

/** Badge text for a restaurant: "Commande immediate" or "Precommande 24h". */
export function serviceBadge(row) {
  const type = row?.service_type === 'preorder' ? 'preorder' : 'immediate';
  if (type === 'immediate') {
    return `<span class="badge immediate">⚡ ${esc(t('svc.immediate'))}</span>`;
  }
  const hours = Number(row?.min_prep_hours || 0);
  const label = hours ? t('svc.preorderH', { h: hours }) : t('svc.preorder');
  return `<span class="badge preorder">📅 ${esc(label)}</span>`;
}

export const serviceLabel = (row) => (row?.service_type === 'preorder'
  ? (Number(row?.min_prep_hours) ? t('svc.preorderH', { h: Number(row.min_prep_hours) }) : t('svc.preorder'))
  : t('svc.immediate'));

/** Cuisine keys -> readable labels in the current language. */
export const cuisineLabels = (row) => {
  const keys = Array.isArray(row?.cuisine_keys) ? row.cuisine_keys
    : String(row?.cuisines || '').split(',').map((x) => x.trim()).filter(Boolean);
  return keys.map((k) => t(`cuisine.${k}`));
};

export const cuisineChips = (row) =>
  cuisineLabels(row).map((label) => `<span class="badge">${esc(label)}</span>`).join(' ');

export const stars = (rating) => {
  const value = Number(rating || 0);
  if (!value) return '';
  return `<span class="rating"><span class="star">★</span>${value.toFixed(1)}</span>`;
};

/** Weekday names, Sunday first, matching the stored 0-6 numbers. */
export const weekdayNames = () => [0, 1, 2, 3, 4, 5, 6].map((n) => t(`dow.${n}`));

export const formatDays = (row) => {
  const numbers = Array.isArray(row?.delivery_day_numbers) ? row.delivery_day_numbers
    : String(row?.delivery_days || '').split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));
  if (!numbers.length) return t('svc.everyDay');
  const names = weekdayNames();
  return numbers.map((n) => names[n]).join(', ');
};

export const formatSlots = (row) => {
  const slots = Array.isArray(row?.delivery_slot_list) ? row.delivery_slot_list
    : String(row?.delivery_slots || '').split(',').map((x) => x.trim()).filter(Boolean);
  return slots.length ? slots.join(' · ') : '—';
};
