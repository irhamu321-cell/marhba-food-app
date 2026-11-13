// Shared helpers: API calls, token storage, formatting.
import { t, lang, money } from './i18n.js';

export const TOKEN_KEY = 'food_app_token';
export { money };

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function setToken(value) { value ? localStorage.setItem(TOKEN_KEY, value) : localStorage.removeItem(TOKEN_KEY); }
export function logout() { setToken(null); localStorage.removeItem('food_app_cart'); }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new Error(data.error || `Erreur ${res.status}`);
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Pictures
 * ------------------------------------------------------------------ */

export const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/webp';
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Sends one picture and resolves with its URL.
 *
 * FormData sets its own Content-Type, including the boundary, so this does
 * not go through api() above — a hand-set JSON header would break the body.
 */
export async function uploadImage(file) {
  if (!file) throw new Error(t('up.none'));
  if (file.size > UPLOAD_MAX_BYTES) throw new Error(t('up.tooBig'));

  const form = new FormData();
  form.append('file', file, file.name || 'image');

  const token = getToken();
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data.url;
}

/**
 * Wires a "choose a picture" button to the text field that holds the URL.
 *
 * The field stays editable: a restaurant that already hosts its photos
 * elsewhere can paste a link instead of uploading, and the preview follows
 * either way.
 */
export function wireImagePicker({ fileId, urlId, previewId, onDone } = {}) {
  const input = document.getElementById(fileId);
  const field = document.getElementById(urlId);
  if (!input || !field) return;

  const preview = previewId ? document.getElementById(previewId) : null;
  const paint = () => {
    if (!preview) return;
    const value = field.value.trim();
    preview.innerHTML = value
      ? `<img src="${esc(value)}" alt="" class="img-preview">`
      : `<div class="img-preview empty">${esc(t('up.noImage'))}</div>`;
  };

  field.oninput = paint;
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    input.disabled = true;
    try {
      const url = await uploadImage(file);
      field.value = url;
      paint();
      toast(t('up.done'));
      if (onDone) await onDone(url);
    } catch (error) {
      toast(error.message, true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  };
  paint();
}

/** The markup for that pair of controls, so three editors share one layout. */
export const imagePickerHtml = ({ fileId, urlId, previewId, value = '' }) => `
  <div class="img-picker">
    <div id="${previewId}"></div>
    <div class="grow">
      <input id="${urlId}" value="${esc(value)}" placeholder="https://… ${esc(t('up.orUpload'))}">
      <label class="ghost small btn-like" for="${fileId}">\ud83d\udcf7 ${esc(t('up.choose'))}</label>
      <input type="file" id="${fileId}" accept="${UPLOAD_ACCEPT}" class="hidden-file">
      <div class="tiny muted">${esc(t('up.hint'))}</div>
    </div>
  </div>`;

export const STATUS_CSS = {
  pending: 'amber', accepted: 'blue', preparing: 'blue', ready: 'green',
  completed: 'green', rejected: 'red', cancelled: 'red',
};

export const statusLabel = (status) => t(`status.${status}`);
export const statusBadge = (status) =>
  `<span class="badge ${STATUS_CSS[status] || ''}">${statusLabel(status)}</span>`;

export function toast(message, isError = false) {
  document.querySelectorAll('.toast').forEach((node) => node.remove());
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// Escape anything coming from the database before putting it in HTML.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmtDate = (iso) => {
  if (!iso) return '';
  const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return date.toLocaleString(lang === 'ar' ? 'ar-MA' : 'fr-FR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/* ------------------------------------------------------------------ *
 * The kitchen bell
 * ------------------------------------------------------------------ */

/*
 * A bell that keeps ringing until somebody deals with the order.
 *
 * A single beep is no use in a kitchen: the one person who could hear it is
 * usually at the fryer with a tap running. So this repeats until the order is
 * accepted or refused, which is the only event that means a human has seen
 * it.
 *
 * Browsers refuse to make noise until the page has been interacted with, and
 * they refuse silently. That is why unlockBell() exists and why the dashboard
 * shows a prominent button: a bell the owner believes is on and which is not
 * is worse than no bell at all.
 */
const bell = {
  ctx: null,
  timer: null,
  unlocked: false,
  ringing: false,
};

const audioContext = () => {
  if (bell.ctx) return bell.ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  bell.ctx = new Ctx();
  return bell.ctx;
};

/** True once the browser will actually let us make a sound. */
export const bellUnlocked = () => bell.unlocked;
export const bellRinging = () => bell.ringing;

/**
 * Called from a click. Resumes the audio context and plays one short tone, so
 * the owner hears for themselves that it works.
 */
export async function unlockBell() {
  const ctx = audioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    ring(ctx, 1);
    bell.unlocked = ctx.state === 'running';
    return bell.unlocked;
  } catch {
    return false;
  }
}

/** One burst of `times` chimes. */
function ring(ctx, times = 2) {
  for (let i = 0; i < times; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = i % 2 ? 1180 : 880;
    const start = ctx.currentTime + i * 0.3;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.26);
    osc.start(start); osc.stop(start + 0.28);
  }
}

/**
 * Starts the bell and keeps it going.
 *
 * Calling it again while it is already ringing changes nothing, so three
 * orders landing together do not produce three overlapping bells.
 */
export function startBell({ everyMs = 4000 } = {}) {
  const ctx = audioContext();
  if (!ctx) return false;
  if (bell.ringing) return true;
  bell.ringing = true;

  const once = () => {
    if (ctx.state !== 'running') return;
    ring(ctx, 2);
  };
  once();
  clearInterval(bell.timer);
  bell.timer = setInterval(once, everyMs);
  return true;
}

export function stopBell() {
  clearInterval(bell.timer);
  bell.timer = null;
  bell.ringing = false;
}

/** Short beep used when a new order lands on the restaurant board. */
export function beep(times = 2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      const start = ctx.currentTime + i * 0.35;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.start(start); osc.stop(start + 0.3);
    }
    setTimeout(() => ctx.close().catch(() => {}), 1500);
  } catch { /* audio blocked until the user interacts with the page */ }
}
