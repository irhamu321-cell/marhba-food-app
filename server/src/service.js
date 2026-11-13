/*
 * Service types and cuisines.
 *
 * A restaurant is either:
 *   immediate — the customer orders now and the food arrives within hours;
 *   preorder  — the customer picks a delivery day and time slot, at least
 *               `min_prep_hours` ahead, on a day the restaurant works.
 *
 * Everything here is pure: the same inputs always give the same answer, so the
 * browser and the server can agree on which slots exist without extra round trips.
 */

export const SERVICE_TYPES = ['immediate', 'preorder'];

/**
 * Thrown when a pre-order setup does not make sense. `field` names the input at
 * fault so the caller can turn it into a message in the right language.
 */
export class ServiceConfigError extends Error {
  constructor(field) {
    super(`service_config:${field}`);
    this.field = field;
  }
}

/** Cuisine tags. `key` is stored; the labels are shown. */
export const CUISINES = [
  { key: 'italienne', fr: 'Italienne',  ar: 'إيطالي' },
  { key: 'marocaine', fr: 'Marocaine',  ar: 'مغربي' },
  { key: 'fastfood',  fr: 'Fast food',  ar: 'وجبات سريعة' },
  { key: 'grillades', fr: 'Grillades',  ar: 'مشويات' },
  { key: 'asiatique', fr: 'Asiatique',  ar: 'آسيوي' },
  { key: 'healthy',   fr: 'Healthy',    ar: 'صحي' },
  { key: 'desserts',  fr: 'Desserts',   ar: 'حلويات' },
];

export const CUISINE_KEYS = CUISINES.map((c) => c.key);

/** Preparation times a restaurant can pick, in hours. 0 means "not a pre-order". */
export const PREP_PRESETS = [24, 48, 72];

const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------- parsing ---- */

/** "1,2,5" -> [1,2,5]; empty means every day. 0 = Sunday … 6 = Saturday. */
export function parseDays(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

export function serializeDays(list) {
  const clean = [...new Set((list || [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
  return clean.join(',');
}

const SLOT_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/** "11:00-13:00,18:00-20:00" -> ['11:00-13:00','18:00-20:00'] */
export function parseSlots(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => SLOT_RE.test(part));
}

export function serializeSlots(list) {
  const clean = (list || [])
    .map((s) => String(s).trim())
    .filter((s) => SLOT_RE.test(s));
  return [...new Set(clean)].sort().join(',');
}

export const isValidSlot = (slot) => SLOT_RE.test(String(slot || '').trim());

/** "HH:MM" or empty. */
export const isValidCutoff = (value) =>
  value === '' || /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || '').trim());

export function parseCuisines(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => CUISINE_KEYS.includes(part));
}

export function serializeCuisines(list) {
  const clean = (list || [])
    .map((c) => String(c).trim().toLowerCase())
    .filter((c) => CUISINE_KEYS.includes(c));
  return [...new Set(clean)].join(',');
}

/* ------------------------------------------------------------ calendar ---- */

const dayKey = (date) => date.toISOString().slice(0, 10);

/** Adds whole days to a date, in UTC, without touching the original. */
function addDays(date, count) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + count);
  return next;
}

/**
 * The delivery days a customer may pick, oldest first.
 *
 * `restaurant` needs min_prep_hours, delivery_days and order_cutoff.
 * `now` is injectable so tests do not depend on the wall clock.
 */
export function availableDates(restaurant, now = new Date(), horizonDays = 21) {
  const prepHours = Math.max(0, Number(restaurant.min_prep_hours) || 0);
  const allowedDays = parseDays(restaurant.delivery_days);
  const cutoff = String(restaurant.order_cutoff || '').trim();

  // Earliest moment the food can be ready.
  let earliest = new Date(now.getTime() + prepHours * 3600 * 1000);

  // Past today's cutoff, the clock effectively starts tomorrow.
  if (cutoff) {
    const [h, m] = cutoff.split(':').map(Number);
    const cutoffToday = new Date(now.getTime());
    cutoffToday.setUTCHours(h, m, 0, 0);
    if (now.getTime() > cutoffToday.getTime()) {
      earliest = new Date(earliest.getTime() + 24 * 3600 * 1000);
    }
  }

  const firstDay = new Date(Date.UTC(
    earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate()));

  const out = [];
  for (let i = 0; i < horizonDays; i += 1) {
    const day = addDays(firstDay, i);
    if (allowedDays.length && !allowedDays.includes(day.getUTCDay())) continue;
    out.push(dayKey(day));
  }
  return out;
}

/**
 * Describes a restaurant's pre-order setup for the browser:
 * which days can be chosen and which slots exist on them.
 */
export function preorderWindow(restaurant, now = new Date()) {
  return {
    service_type: restaurant.service_type || 'immediate',
    min_prep_hours: Math.max(0, Number(restaurant.min_prep_hours) || 0),
    order_cutoff: String(restaurant.order_cutoff || ''),
    days: parseDays(restaurant.delivery_days),
    slots: parseSlots(restaurant.delivery_slots),
    dates: restaurant.service_type === 'preorder' ? availableDates(restaurant, now) : [],
  };
}

/**
 * Checks a requested delivery date and slot against the restaurant's rules.
 * Returns { ok: true } or { ok: false, reason: '<code>' } — never throws, so
 * the caller decides which error the customer sees.
 */
export function validateSchedule(restaurant, scheduledFor, scheduledSlot, now = new Date()) {
  if ((restaurant.service_type || 'immediate') !== 'preorder') {
    // Immediate restaurants must not carry a schedule.
    if (scheduledFor || scheduledSlot) return { ok: false, reason: 'not_preorder' };
    return { ok: true };
  }

  const date = String(scheduledFor || '').trim();
  const slot = String(scheduledSlot || '').trim();
  if (!date || !slot) return { ok: false, reason: 'schedule_required' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'bad_date' };

  const dates = availableDates(restaurant, now);
  if (!dates.includes(date)) return { ok: false, reason: 'date_unavailable' };

  const slots = parseSlots(restaurant.delivery_slots);
  if (slots.length && !slots.includes(slot)) return { ok: false, reason: 'slot_unavailable' };
  if (!slots.length && !isValidSlot(slot)) return { ok: false, reason: 'slot_unavailable' };

  return { ok: true };
}

/** Normalises what an admin or a restaurant owner submits. Throws on bad input. */
export function normalizeServiceConfig(input = {}) {
  const type = SERVICE_TYPES.includes(input.service_type) ? input.service_type : 'immediate';

  if (type === 'immediate') {
    return {
      service_type: 'immediate',
      min_prep_hours: 0,
      delivery_days: '',
      delivery_slots: '',
      order_cutoff: '',
    };
  }

  const hours = Number(input.min_prep_hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new ServiceConfigError('min_prep_hours');

  const days = Array.isArray(input.delivery_days)
    ? serializeDays(input.delivery_days)
    : serializeDays(parseDays(input.delivery_days));

  const slotsInput = Array.isArray(input.delivery_slots)
    ? input.delivery_slots
    : parseSlots(input.delivery_slots);
  const slots = serializeSlots(slotsInput);
  if (!slots) throw new ServiceConfigError('delivery_slots');

  const cutoff = String(input.order_cutoff || '').trim();
  if (!isValidCutoff(cutoff)) throw new ServiceConfigError('order_cutoff');

  return {
    service_type: 'preorder',
    min_prep_hours: hours,
    delivery_days: days,
    delivery_slots: slots,
    order_cutoff: cutoff,
  };
}

/** Rating stored in basis points (45000 = 4.5). */
export const ratingOf = (restaurant) => Number(restaurant?.rating_bp || 0) / 10000;
