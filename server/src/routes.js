import crypto from 'node:crypto';
import { store, nowIso } from './store.js';
import { hashPassword, verifyPassword, createToken } from './auth.js';
import {
  Router, str, int, bool, oneOf, email,
  badRequest, unauthorized, forbidden, notFound, conflict, HttpError,
  readRawBody, isMultipart,
} from './http.js';
import {
  MAX_UPLOAD_BYTES, ALLOWED_TYPES, readBoundary, parseMultipart, saveUpload,
  deleteUpload, UploadError,
} from './uploads.js';
import { issueTicket, redeemTicket, openStream, publish, streamStats } from './stream.js';
import { notifyNewOrder } from './notify.js';
import { can, permissionsFor, adminRoleOf, ADMIN_ROLES } from './permissions.js';
import { loadSettings, getSetting, setSettings, isOn, DEFAULTS } from './settings.js';
import { refreshCodDays, codSummary, COD_STATUSES } from './cod.js';
import { summaryReport, byRestaurantReport, byProductReport, customersReport, codReport, toCsv, REPORT_HEADERS } from './reports.js';
import { issueCode, consumeCode, CODE_ERRORS, pendingCodes, consoleEnabled } from './codes.js';
import { log } from './logger.js';
import { isProduction } from './env.js';
import { publicHealth, adminHealth } from './health.js';
import { businessForClient } from '../config/business.js';
import { runBackup } from './backup.js';
import { recentEvents } from './logger.js';
import {
  normalizeAddress, AddressError, ADDRESS_LABELS, hasValidPin,
  oneLine, addressBlock, mapLink, coarsePin, labelText,
  snapshotColumns, snapshotFromOrder,
} from './addresses.js';
import {
  SERVICE_TYPES, CUISINES, CUISINE_KEYS, PREP_PRESETS, ServiceConfigError,
  parseCuisines, serializeCuisines, parseSlots, parseDays,
  preorderWindow, validateSchedule, normalizeServiceConfig, ratingOf,
} from './service.js';

export const router = new Router();

/**
 * Adds the derived fields the interfaces need, so every screen shows the same
 * badge, rating and cuisine list without repeating the parsing.
 */
/** Readable reason for each rejected pre-order setting. */
const SERVICE_CONFIG_ERRORS = {
  min_prep_hours: 'Indique un delai de preparation entre 1 et 720 heures.',
  delivery_slots: 'Ajoute au moins un creneau de livraison, au format 11:00-13:00.',
  order_cutoff: 'Heure limite invalide. Utilise le format 18:00.',
};

/** Runs the pre-order checks and turns a rejection into a 400. */
function readServiceConfig(body) {
  try {
    return normalizeServiceConfig(body);
  } catch (error) {
    if (error instanceof ServiceConfigError) {
      throw badRequest(SERVICE_CONFIG_ERRORS[error.field] || 'Configuration de precommande invalide.',
        { field: error.field });
    }
    throw error;
  }
}

function decorateRestaurant(row) {
  if (!row) return row;
  return {
    ...row,
    chef_bio: row.chef_bio || '',
    chef_bio_ar: row.chef_bio_ar || '',
    pickup_instructions: row.pickup_instructions || '',
    pickup_instructions_ar: row.pickup_instructions_ar || '',
    service_type: row.service_type || 'immediate',
    min_prep_hours: Number(row.min_prep_hours || 0),
    cuisine_keys: parseCuisines(row.cuisines),
    delivery_day_numbers: parseDays(row.delivery_days),
    delivery_slot_list: parseSlots(row.delivery_slots),
    rating: ratingOf(row),
    reviews_count: Number(row.reviews_count || 0),
  };
}

/* ------------------------------------------------------------------ *
 * Access control
 * ------------------------------------------------------------------ */
async function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  const row = await store.get(
    `SELECT id, name, email, phone, role, status, token_version, locale, admin_role, last_login_at
     FROM users WHERE id = $1`, [ctx.user.sub]);
  if (!row) throw unauthorized();
  if (row.status !== 'active') throw forbidden('Ce compte est suspendu.');
  if (row.role === 'restaurant') {
    const own = await store.get('SELECT status FROM restaurants WHERE owner_user_id = $1', [row.id]);
    if (own && own.status === 'suspended') throw forbidden('Ton restaurant est suspendu. Contacte l administrateur.');
    if (own && own.status === 'rejected') throw forbidden('Ta demande a ete refusee. Contacte l administrateur.');
  }
  // A password change or "log out everywhere" bumps token_version, killing old tokens.
  if (Number(row.token_version) !== Number(ctx.user.tv ?? 0)) {
    throw unauthorized('Session expiree, reconnecte-toi.');
  }
  return row;
}

async function requireRole(ctx, ...roles) {
  const user = await requireUser(ctx);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/** Admin-only, and only if this admin's role carries the permission. */
async function requirePermission(ctx, permission) {
  const user = await requireUser(ctx);
  if (user.role !== 'admin') {
    log.warn('permission.denied', {
      user_id: user.id, role: user.role, permission, path: ctx.req?.url, ip: ctx.ip,
    });
    throw forbidden();
  }
  if (!can(user, permission)) {
    log.warn('permission.denied', {
      user_id: user.id, role: adminRoleOf(user), permission, path: ctx.req?.url, ip: ctx.ip,
    });
    throw forbidden(`Ton role (${adminRoleOf(user)}) ne permet pas cette action.`);
  }
  return user;
}

async function myRestaurant(ctx) {
  const user = await requireRole(ctx, 'restaurant');
  const resto = await store.get('SELECT * FROM restaurants WHERE owner_user_id = $1', [user.id]);
  if (!resto) throw notFound('Aucun restaurant lie a ce compte.');
  return { user, resto };
}

async function ownedProduct(restoId, productId) {
  const product = await store.get('SELECT * FROM products WHERE id = $1 AND restaurant_id = $2', [productId, restoId]);
  if (!product) throw notFound('Produit introuvable.');
  return product;
}

async function ownedCategory(restoId, categoryId) {
  const cat = await store.get('SELECT * FROM categories WHERE id = $1 AND restaurant_id = $2', [categoryId, restoId]);
  if (!cat) throw notFound('Categorie introuvable.');
  return cat;
}

async function ownedGroup(restoId, groupId) {
  const group = await store.get(
    `SELECT g.* FROM option_groups g JOIN products p ON p.id = g.product_id
     WHERE g.id = $1 AND p.restaurant_id = $2`, [groupId, restoId]);
  if (!group) throw notFound('Groupe d options introuvable.');
  return group;
}

/** Records who did what. Never breaks the request it is logging. */
async function audit(ctx, actor, action, resourceType, resourceId, details = {}, states = {}) {
  try {
    const shrink = (value) => (value === undefined || value === null ? '' : JSON.stringify(value).slice(0, 2000));
    await store.run(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, resource_type, resource_id, details, ip,
        user_agent, before_state, after_state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [actor?.id ?? null, actor?.admin_role || actor?.role || '', action, resourceType, resourceId ?? null,
       shrink(details), ctx.ip || '', String(ctx.userAgent || '').slice(0, 300),
       shrink(states.before), shrink(states.after), nowIso()]
    );
  } catch { /* logging must never break the action */ }
}

/*
 * Financial actions carry an idempotency key: the same key replays the first
 * answer instead of taking the money twice.
 */
async function idempotent(ctx, endpoint, run) {
  const key = String(ctx.body.idempotency_key || ctx.req.headers['idempotency-key'] || '').trim();
  if (!key) return run();
  if (key.length > 200) throw badRequest('Cle d idempotence trop longue.');

  const seen = await store.get('SELECT response FROM idempotency_keys WHERE key = $1', [key]);
  if (seen) {
    try { return { ...JSON.parse(seen.response), replayed: true }; }
    catch { throw conflict('Cette action a deja ete enregistree.'); }
  }
  const result = await run();
  try {
    await store.run('INSERT INTO idempotency_keys (key, endpoint, response, created_at) VALUES ($1,$2,$3,$4)',
      [key, endpoint, JSON.stringify(result).slice(0, 100000), nowIso()]);
  } catch { /* a concurrent call stored it first; the action itself is done */ }
  return result;
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, locale: u.locale });

/** Moroccan numbers get typed many ways; store one shape so logins always match. */
export function normalisePhone(raw) {
  let digits = String(raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+212')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('212')) digits = `0${digits.slice(3)}`;
  digits = digits.replace(/\+/g, '');
  return digits;
}

function validPhone(raw) {
  const phone = normalisePhone(raw);
  if (!/^0\d{8,13}$/.test(phone)) {
    throw badRequest('Numero de telephone invalide. Exemple: 0612345678.');
  }
  return phone;
}
const tokenFor = (user) => createToken({ sub: user.id, role: user.role, tv: Number(user.token_version || 0) });

/** Phone verification is on unless explicitly disabled for a local demo. */
const otpRequired = () => String(process.env.OTP_REQUIRED || 'true').toLowerCase() !== 'false';

/**
 * Step one of signing up: prove the phone number.
 * Always answers the same way, whether or not the number already has an
 * account, so this endpoint cannot be used to discover who is registered.
 */
router.post('/api/auth/request-code', async (ctx) => {
  const phone = validPhone(str(ctx.body, 'phone', { max: 30 }));
  const existing = await store.get('SELECT id FROM users WHERE phone = $1', [phone]);

  if (existing) {
    log.info('code.requested_existing', { phone, ip: ctx.ip, purpose: 'register' });
    return { sent: true, expires_in_minutes: 5 };
  }
  try {
    const result = await issueCode({ purpose: 'register', channel: 'phone', destination: phone, ip: ctx.ip });
    return { sent: true, expires_in_minutes: result.expires_in_minutes };
  } catch (err) {
    if (err.status === 429) throw new HttpError(429, err.message);
    throw err;
  }
});

/**
 * Step one of a password reset. Same shape of answer whether or not the
 * account exists, for the same reason.
 */
router.post('/api/auth/forgot-password', async (ctx) => {
  const raw = str(ctx.body, 'identifier', { max: 200 });
  const looksLikeEmail = raw.includes('@');
  const destination = looksLikeEmail ? raw.trim().toLowerCase() : normalisePhone(raw);
  const channel = looksLikeEmail ? 'email' : 'phone';

  const user = looksLikeEmail
    ? await store.get('SELECT id, status FROM users WHERE email = $1', [destination])
    : await store.get('SELECT id, status FROM users WHERE phone = $1', [destination]);

  if (!user || user.status !== 'active') {
    log.info('reset.requested_unknown', { destination, channel, ip: ctx.ip });
    return { sent: true, expires_in_minutes: 15 };
  }
  try {
    const result = await issueCode({
      purpose: 'reset', channel, destination, userId: user.id, ip: ctx.ip });
    return { sent: true, expires_in_minutes: result.expires_in_minutes };
  } catch (err) {
    if (err.status === 429) throw new HttpError(429, err.message);
    throw err;
  }
});

/**
 * Step two of a password reset: the code plus the new password.
 * On success every existing session for that account is invalidated.
 */
router.post('/api/auth/reset-password', async (ctx) => {
  const raw = str(ctx.body, 'identifier', { max: 200 });
  const code = str(ctx.body, 'code', { max: 10 });
  const password = str(ctx.body, 'new_password', { max: 200, min: 8 });
  const looksLikeEmail = raw.includes('@');
  const destination = looksLikeEmail ? raw.trim().toLowerCase() : normalisePhone(raw);

  const result = await consumeCode({ purpose: 'reset', destination, code, ip: ctx.ip });
  if (!result.ok) {
    log.warn('reset.code_refused', { destination, ip: ctx.ip, reason: result.reason });
    throw badRequest(CODE_ERRORS[result.reason] || CODE_ERRORS.wrong, { reason: result.reason });
  }

  const user = await store.get('SELECT * FROM users WHERE id = $1', [result.row.user_id]);
  if (!user) throw badRequest(CODE_ERRORS.not_found);

  const pwdHash = await hashPassword(password);
  await store.run(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [pwdHash, user.id]);
  await audit(ctx, user, 'password_reset', 'user', user.id, { channel: looksLikeEmail ? 'email' : 'phone' });
  log.info('reset.completed', { user_id: user.id, ip: ctx.ip });

  const fresh = await store.get('SELECT * FROM users WHERE id = $1', [user.id]);
  return { token: tokenFor(fresh), user: publicUser(fresh) };
});

router.post('/api/auth/register', async (ctx) => {
  const name = str(ctx.body, 'name', { max: 120, min: 2 });
  const phone = validPhone(str(ctx.body, 'phone', { max: 30 }));
  // Email is optional now: the phone number is the login.
  const mail = (ctx.body.email === undefined || String(ctx.body.email).trim() === '') ? '' : email(ctx.body);
  const password = str(ctx.body, 'password', { max: 200, min: 8 });
  const role = oneOf(ctx.body, 'role', ['customer', 'restaurant'], { required: false, fallback: 'customer' });
  const locale = oneOf(ctx.body, 'locale', ['fr', 'ar'], { required: false, fallback: 'fr' });

  if (await store.get('SELECT id FROM users WHERE phone = $1', [phone])) {
    throw conflict('Ce numero de telephone a deja un compte.');
  }
  if (mail && await store.get('SELECT id FROM users WHERE email = $1', [mail])) {
    throw conflict('Cette adresse email est deja utilisee.');
  }

  // The phone number must be proven before an account exists.
  // OTP_REQUIRED=false turns this off for a local demo; it is on by default.
  if (otpRequired()) {
    const code = str(ctx.body, 'code', { required: false, max: 10 });
    if (!code) {
      throw badRequest('Demande d abord un code de verification pour ce numero.', { need: 'code' });
    }
    const result = await consumeCode({ purpose: 'register', destination: phone, code, ip: ctx.ip });
    if (!result.ok) {
      log.warn('register.code_refused', { phone, ip: ctx.ip, reason: result.reason });
      throw badRequest(CODE_ERRORS[result.reason] || CODE_ERRORS.wrong, { reason: result.reason });
    }
  }

  const at = nowIso();
  const pwdHash = await hashPassword(password);
  const userId = await store.insert(
    'INSERT INTO users (name, email, phone, password_hash, role, locale, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [name, mail, phone, pwdHash, role, locale, at]
  );

  if (role === 'restaurant') {
    const restoName = str(ctx.body, 'restaurant_name', { required: false, max: 120 }) || name;
    const city = str(ctx.body, 'city', { required: false, max: 80 });
    const settings = await loadSettings();
    const defaultBp = Math.max(0, Math.min(10000, Number(settings.default_commission_bp) || 1500));
    await store.run(
      `INSERT INTO restaurants (owner_user_id, name, city, phone, status, commission_rate_bp, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
      [userId, restoName, city, phone, defaultBp, at]
    );
  }

  const user = await store.get('SELECT * FROM users WHERE id = $1', [userId]);
  await audit(ctx, user, 'register', 'user', userId, { role });
  return { token: tokenFor(user), user: publicUser(user) };
});

const loginAttempts = new Map();

/*
 * Failed logins per IP address before the app answers 429 for a while.
 * The default protects a real deployment; a test run sets it higher because
 * every request arrives from the same address.
 */
const LOGIN_MAX_ATTEMPTS = Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS) || 10);
const LOGIN_WINDOW_MINUTES = Math.max(1, Number(process.env.LOGIN_WINDOW_MINUTES) || 15);

router.post('/api/auth/login', async (ctx) => {
  const now = Date.now();
  const entry = loginAttempts.get(ctx.ip);
  if (entry && entry.resetAt > now && entry.count >= LOGIN_MAX_ATTEMPTS) {
    log.warn('login.rate_limited', { ip: ctx.ip, attempts: entry.count });
    throw new HttpError(429, `Trop de tentatives. Reessaie dans ${LOGIN_WINDOW_MINUTES} minutes.`);
  }

  // Accepts a phone number or an email address.
  const raw = str(ctx.body, ctx.body.identifier !== undefined ? 'identifier' : (ctx.body.phone !== undefined ? 'phone' : 'email'), { max: 200 });
  const password = str(ctx.body, 'password', { max: 200 });
  const looksLikeEmail = raw.includes('@');
  const user = looksLikeEmail
    ? await store.get('SELECT * FROM users WHERE email = $1', [raw.toLowerCase()])
    : await store.get('SELECT * FROM users WHERE phone = $1', [normalisePhone(raw)]);

  const passwordMatches = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !passwordMatches) {
    log.warn('login.failed', {
      identifier: raw, channel: looksLikeEmail ? 'email' : 'phone', ip: ctx.ip,
      reason: user ? 'bad_password' : 'unknown_account',
    });
    loginAttempts.set(ctx.ip, entry && entry.resetAt > now
      ? { count: entry.count + 1, resetAt: entry.resetAt }
      : { count: 1, resetAt: now + LOGIN_WINDOW_MINUTES * 60 * 1000 });
    throw unauthorized('Telephone/email ou mot de passe incorrect.');
  }
  if (user.status !== 'active') throw forbidden('Ce compte est suspendu.');
  if (user.role === 'restaurant') {
    const own = await store.get('SELECT status FROM restaurants WHERE owner_user_id = $1', [user.id]);
    if (own && own.status === 'suspended') throw forbidden('Ton restaurant est suspendu. Contacte l administrateur.');
    if (own && own.status === 'rejected') throw forbidden('Ta demande a ete refusee. Contacte l administrateur.');
  }

  loginAttempts.delete(ctx.ip);
  await store.run('UPDATE users SET last_login_at = $1 WHERE id = $2', [nowIso(), user.id]);
  return { token: tokenFor(user), user: publicUser(user) };
});

router.get('/api/me', async (ctx) => {
  const user = await requireUser(ctx);
  const payload = { user: publicUser(user) };
  if (user.role === 'restaurant') {
    payload.restaurant = await store.get('SELECT * FROM restaurants WHERE owner_user_id = $1', [user.id]) || null;
  }
  if (user.role === 'admin') {
    payload.admin_role = adminRoleOf(user);
    payload.permissions = permissionsFor(user);
  }
  return payload;
});

/** Public: what the customer app needs to know about the platform. */
/**
 * The business identity the legal pages are built from. Public, because the
 * terms and the privacy policy are public documents. Missing values are sent
 * as empty strings so the interface can mark the gap instead of hiding it.
 */
router.get('/api/legal', async () => businessForClient());

router.get('/api/settings/public', async () => {
  const settings = await loadSettings();
  return {
    platform_name: settings.platform_name,
    currency: settings.currency,
    default_language: settings.default_language,
    maintenance_mode: isOn(settings.maintenance_mode) ? 1 : 0,
    promotions_enabled: isOn(settings.promotions_enabled) ? 1 : 0,
    support_phone: settings.support_phone,
    support_email: settings.support_email,
  };
});

router.put('/api/me', async (ctx) => {
  const user = await requireUser(ctx);
  const name = str(ctx.body, 'name', { required: false, max: 120, min: 2 }) || user.name;
  const phone = ctx.body.phone === undefined ? user.phone : validPhone(ctx.body.phone);
  const mail = (ctx.body.email === undefined) ? user.email
    : (String(ctx.body.email).trim() === '' ? '' : email(ctx.body));

  if (phone !== user.phone) {
    const taken = await store.get('SELECT id FROM users WHERE phone = $1 AND id <> $2', [phone, user.id]);
    if (taken) throw conflict('Ce numero de telephone a deja un compte.');
  }
  if (mail && mail !== user.email) {
    const taken = await store.get('SELECT id FROM users WHERE email = $1 AND id <> $2', [mail, user.id]);
    if (taken) throw conflict('Cette adresse email est deja utilisee.');
  }
  await store.run('UPDATE users SET name = $1, phone = $2, email = $3 WHERE id = $4', [name, phone, mail, user.id]);
  return { user: publicUser(await store.get('SELECT * FROM users WHERE id = $1', [user.id])) };
});

router.put('/api/me/locale', async (ctx) => {
  const user = await requireUser(ctx);
  const locale = oneOf(ctx.body, 'locale', ['fr', 'ar']);
  await store.run('UPDATE users SET locale = $1 WHERE id = $2', [locale, user.id]);
  return { locale };
});

router.post('/api/auth/password', async (ctx) => {
  const user = await requireUser(ctx);
  const current = str(ctx.body, 'current_password', { max: 200 });
  const next = str(ctx.body, 'new_password', { max: 200, min: 8 });
  const full = await store.get('SELECT * FROM users WHERE id = $1', [user.id]);
  const currentMatches = await verifyPassword(current, full.password_hash);
  if (!currentMatches) throw unauthorized('Mot de passe actuel incorrect.');

  const nextHash = await hashPassword(next);
  await store.run('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [nextHash, user.id]);
  await audit(ctx, user, 'password_change', 'user', user.id);
  const updated = await store.get('SELECT * FROM users WHERE id = $1', [user.id]);
  return { token: tokenFor(updated), user: publicUser(updated) };
});

router.post('/api/auth/logout-all', async (ctx) => {
  const user = await requireUser(ctx);
  await store.run('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [user.id]);
  await audit(ctx, user, 'logout_all', 'user', user.id);
  return { ok: true };
});

/* ------------------------------------------------------------------ *
 * Delivery addresses
 *
 * Every route here is scoped to the signed-in customer by customer_id in the
 * WHERE clause, not by trusting the id in the URL. Asking for someone else's
 * address returns the same "introuvable" as an id that does not exist, so a
 * stranger's address book cannot even be counted.
 * ------------------------------------------------------------------ */

const ADDRESS_COLUMNS = `id, customer_id, label, label_custom, recipient_name, recipient_phone,
  city, street, building, floor, landmark, instructions, lat, lng, is_default, created_at, updated_at`;

/** Adds the display fields every screen needs, so none of them re-derive them. */
const decorateAddress = (row) => row && ({
  ...row,
  is_default: Number(row.is_default) === 1,
  has_pin: hasValidPin(row),
  one_line: oneLine(row),
  block: addressBlock(row),
  map_link: mapLink(row),
  label_text: labelText(row, 'fr'),
  label_text_ar: labelText(row, 'ar'),
});

const listAddresses = async (customerId) => {
  const rows = await store.all(
    `SELECT ${ADDRESS_COLUMNS} FROM customer_addresses WHERE customer_id = $1
     ORDER BY is_default DESC, id DESC`, [customerId]);
  return rows.map(decorateAddress);
};

/** Turns an AddressError into a 400 with its own message. */
function readAddress(body, options) {
  try {
    return normalizeAddress(body, options);
  } catch (e) {
    if (e instanceof AddressError) throw badRequest(e.message);
    throw e;
  }
}

/** Exactly one address per customer carries the default flag. */
async function makeDefault(t, customerId, addressId) {
  await t.run('UPDATE customer_addresses SET is_default = 0 WHERE customer_id = $1', [customerId]);
  await t.run('UPDATE customer_addresses SET is_default = 1 WHERE id = $1 AND customer_id = $2',
    [addressId, customerId]);
}

const MAX_ADDRESSES = 20;

router.get('/api/me/addresses', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  return { addresses: await listAddresses(user.id) };
});

router.post('/api/me/addresses', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const count = await store.get(
    'SELECT COUNT(*) AS c FROM customer_addresses WHERE customer_id = $1', [user.id]);
  if (Number(count.c) >= MAX_ADDRESSES) {
    throw conflict(`Tu as atteint la limite de ${MAX_ADDRESSES} adresses. Supprime-en une d'abord.`);
  }

  // A pin is required to save: the map step is where the customer confirms it.
  const addr = readAddress(ctx.body, { requirePin: true });
  const at = nowIso();
  const first = Number(count.c) === 0;
  const wantDefault = bool(ctx.body, 'is_default', false) || first;

  const id = await store.tx(async (t) => {
    const newId = await t.insert(
      `INSERT INTO customer_addresses (customer_id, label, label_custom, recipient_name, recipient_phone,
        city, street, building, floor, landmark, instructions, lat, lng, is_default, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15)`,
      [user.id, addr.label, addr.label_custom, addr.recipient_name, addr.recipient_phone,
       addr.city, addr.street, addr.building, addr.floor, addr.landmark, addr.instructions,
       addr.lat, addr.lng, at, at]);
    if (wantDefault) await makeDefault(t, user.id, newId);
    return newId;
  });

  // The neighbourhood, not the door: see coarsePin in addresses.js.
  log.info('address.created', { customer_id: user.id, address_id: id, area: coarsePin(addr) });
  return { addresses: await listAddresses(user.id), address_id: id };
});

router.put('/api/me/addresses/:id', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const id = Number(ctx.params.id);
  const existing = await store.get(
    'SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, user.id]);
  if (!existing) throw notFound('Adresse introuvable.');

  const addr = readAddress(ctx.body, { requirePin: true });
  const at = nowIso();
  await store.tx(async (t) => {
    await t.run(
      `UPDATE customer_addresses SET label = $1, label_custom = $2, recipient_name = $3,
        recipient_phone = $4, city = $5, street = $6, building = $7, floor = $8, landmark = $9,
        instructions = $10, lat = $11, lng = $12, updated_at = $13
       WHERE id = $14 AND customer_id = $15`,
      [addr.label, addr.label_custom, addr.recipient_name, addr.recipient_phone, addr.city,
       addr.street, addr.building, addr.floor, addr.landmark, addr.instructions,
       addr.lat, addr.lng, at, id, user.id]);
    if (bool(ctx.body, 'is_default', false)) await makeDefault(t, user.id, id);
  });
  return { addresses: await listAddresses(user.id) };
});

router.post('/api/me/addresses/:id/default', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const id = Number(ctx.params.id);
  const existing = await store.get(
    'SELECT id FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, user.id]);
  if (!existing) throw notFound('Adresse introuvable.');
  await store.tx(async (t) => { await makeDefault(t, user.id, id); });
  return { addresses: await listAddresses(user.id) };
});

router.delete('/api/me/addresses/:id', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const id = Number(ctx.params.id);
  const existing = await store.get(
    'SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, user.id]);
  if (!existing) throw notFound('Adresse introuvable.');

  // Past orders keep their own frozen copy, so deleting this row cannot
  // change where an earlier order says it went.
  await store.tx(async (t) => {
    await t.run('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [id, user.id]);
    if (Number(existing.is_default) === 1) {
      const next = await t.get(
        'SELECT id FROM customer_addresses WHERE customer_id = $1 ORDER BY id DESC LIMIT 1', [user.id]);
      if (next) await makeDefault(t, user.id, next.id);
    }
  });
  log.info('address.deleted', { customer_id: user.id, address_id: id });
  return { addresses: await listAddresses(user.id) };
});

/* ------------------------------------------------------------------ *
 * Public catalog
 * ------------------------------------------------------------------ */
/** The cuisine tags and service types the interfaces offer, with their labels. */
router.get('/api/cuisines', async () => ({
  cuisines: CUISINES,
  service_types: SERVICE_TYPES,
  prep_presets: PREP_PRESETS,
}));

router.get('/api/restaurants', async (ctx) => {
  const city = (ctx.query.get('city') || '').trim();
  const search = (ctx.query.get('q') || '').trim();
  const service = (ctx.query.get('service') || '').trim();
  const cuisine = (ctx.query.get('cuisine') || '').trim().toLowerCase();

  let sql = `SELECT id, name, name_ar, city, address, description, description_ar, image_url, is_open,
                    prep_minutes, supports_pickup, supports_delivery, delivery_fee_cents, min_order_cents,
                    service_type, min_prep_hours, delivery_days, delivery_slots, order_cutoff,
                    cuisines, rating_bp, reviews_count,
                    chef_bio, chef_bio_ar, pickup_instructions, pickup_instructions_ar
             FROM restaurants WHERE status = 'approved'`;
  const args = [];
  if (city) { args.push(city); sql += ` AND lower(city) = lower($${args.length})`; }
  if (SERVICE_TYPES.includes(service)) {
    args.push(service);
    sql += ` AND service_type = $${args.length}`;
  }
  if (search) {
    args.push(`%${search}%`);
    sql += ` AND (name LIKE $${args.length} OR name_ar LIKE $${args.length} OR description LIKE $${args.length})`;
  }
  sql += ' ORDER BY is_open DESC, name';

  let rows = await store.all(sql, args);
  // Cuisines are a short comma list, so filtering in JS keeps the SQL portable.
  if (CUISINE_KEYS.includes(cuisine)) {
    rows = rows.filter((r) => parseCuisines(r.cuisines).includes(cuisine));
  }
  return { restaurants: rows.map(decorateRestaurant) };
});

router.get('/api/restaurants/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const resto = await store.get(
    `SELECT id, name, name_ar, city, address, phone, description, description_ar, image_url, is_open,
            prep_minutes, supports_pickup, supports_delivery, delivery_fee_cents, min_order_cents,
            service_type, min_prep_hours, delivery_days, delivery_slots, order_cutoff,
            cuisines, rating_bp, reviews_count,
            chef_bio, chef_bio_ar, pickup_instructions, pickup_instructions_ar
     FROM restaurants WHERE id = $1 AND status = 'approved'`, [id]);
  if (!resto) throw notFound('Restaurant introuvable.');

  const categories = await store.all(
    'SELECT id, name, name_ar, sort_order FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, id', [id]);
  const products = await store.all(
    `SELECT id, category_id, name, name_ar, description, description_ar, price_cents, image_url, daily_stock
     FROM products WHERE restaurant_id = $1 AND is_active = 1 ORDER BY sort_order, id`, [id]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const orderedRows = await store.all(
    `SELECT oi.product_id, COALESCE(SUM(oi.quantity), 0) AS ordered_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1
       AND o.status NOT IN ('cancelled', 'rejected')
       AND (
         (o.service_type = 'preorder' AND o.scheduled_for = $2)
         OR (o.service_type != 'preorder' AND SUBSTR(o.placed_at, 1, 10) = $2)
       )
     GROUP BY oi.product_id`, [id, todayStr]);
  const orderedMap = new Map(orderedRows.map((r) => [Number(r.product_id), Number(r.ordered_count)]));

  const groups = await store.all(
    `SELECT g.id, g.product_id, g.name, g.name_ar, g.min_select, g.max_select, g.sort_order
     FROM option_groups g JOIN products p ON p.id = g.product_id
     WHERE p.restaurant_id = $1 AND p.is_active = 1 ORDER BY g.sort_order, g.id`, [id]);
  const options = await store.all(
    `SELECT o.id, o.option_group_id, o.name, o.name_ar, o.price_delta_cents, o.is_removal
     FROM product_options o
     JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id
     WHERE p.restaurant_id = $1 AND o.is_available = 1 ORDER BY o.sort_order, o.id`, [id]);

  for (const group of groups) group.options = options.filter((o) => o.option_group_id === group.id);
  for (const product of products) {
    product.option_groups = groups.filter((g) => g.product_id === product.id);
    const stock = Number(product.daily_stock || 0);
    const ordered = orderedMap.get(Number(product.id)) || 0;
    product.daily_stock = stock;
    product.ordered_today = ordered;
    product.remaining_stock = stock > 0 ? Math.max(0, stock - ordered) : null;
    product.is_sold_out = stock > 0 && ordered >= stock;
  }

  return {
    restaurant: decorateRestaurant(resto),
    preorder: preorderWindow(resto),
    menu: categories.map((c) => ({ ...c, products: products.filter((p) => p.category_id === c.id) })),
    uncategorized: products.filter((p) => !p.category_id),
  };
});


/* ------------------------------------------------------------------ *
 * Pricing and promotions — all of it server-side
 * ------------------------------------------------------------------ */
async function resolveLines(restaurantId, items, { label = 'Ligne', targetDate = null } = {}) {
  const resolved = [];
  for (const [index, raw] of items.entries()) {
    const productId = int(raw, 'product_id', { min: 1 });
    const quantity = int(raw, 'quantity', { min: 1, max: 50 });
    const product = await store.get(
      'SELECT * FROM products WHERE id = $1 AND restaurant_id = $2 AND is_active = 1', [productId, restaurantId]);
    if (!product) throw badRequest(`${label} ${index + 1}: produit indisponible.`);

    const stock = Number(product.daily_stock || 0);
    if (stock > 0) {
      const dayToCheck = targetDate || new Date().toISOString().slice(0, 10);
      const orderedRow = await store.get(
        `SELECT COALESCE(SUM(oi.quantity), 0) AS ordered_count
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.product_id = $1
           AND o.status NOT IN ('cancelled', 'rejected')
           AND (
             (o.service_type = 'preorder' AND o.scheduled_for = $2)
             OR (o.service_type != 'preorder' AND SUBSTR(o.placed_at, 1, 10) = $2)
           )`, [productId, dayToCheck]);
      const orderedCount = Number(orderedRow?.ordered_count || 0);
      const remaining = Math.max(0, stock - orderedCount);
      if (quantity > remaining) {
        throw conflict(remaining === 0
          ? `"${product.name}" est épuisé pour cette date (${stock} portions max par jour).`
          : `"${product.name}": seulement ${remaining} portion(s) restante(s) pour cette date.`);
      }
    }

    const wanted = Array.isArray(raw.option_ids) ? raw.option_ids.map(Number) : [];
    if (wanted.length > 20) throw badRequest(`${label} ${index + 1}: trop d options.`);

    const groups = await store.all('SELECT * FROM option_groups WHERE product_id = $1 ORDER BY sort_order, id', [productId]);
    const chosen = [];
    for (const group of groups) {
      const available = await store.all(
        'SELECT * FROM product_options WHERE option_group_id = $1 AND is_available = 1 ORDER BY sort_order, id', [group.id]);
      const picked = available.filter((o) => wanted.includes(Number(o.id)));
      /*
       * min_select and max_select govern the paid choices only.
       *
       * A removal is a different kind of thing: "choose exactly one size" and
       * "take out as many ingredients as you like" live on separate axes, and
       * a group holding five removable ingredients would otherwise need
       * max_select raised to five before a customer could ask for a plain
       * burger. Removals are still bounded, by the per-line cap on how many
       * options one request may carry at all.
       */
      const choices = picked.filter((o) => !o.is_removal);
      if (choices.length < group.min_select) {
        throw badRequest(`${label} ${index + 1}: choisis au moins ${group.min_select} option(s) dans "${group.name}".`);
      }
      if (choices.length > group.max_select) {
        throw badRequest(`${label} ${index + 1}: au maximum ${group.max_select} option(s) dans "${group.name}".`);
      }
      for (const option of picked) chosen.push({ group, option });
    }
    const known = new Set(chosen.map((c) => Number(c.option.id)));
    for (const optionId of wanted) {
      if (!known.has(optionId)) throw badRequest(`${label} ${index + 1}: option invalide ou indisponible.`);
    }

    const extra = chosen.reduce((sum, c) => sum + Number(c.option.price_delta_cents), 0);
    const unitPrice = Number(product.price_cents) + extra;
    resolved.push({
      product, quantity, chosen, unitPrice,
      note: str(raw, 'note', { required: false, max: 200 }),
      lineTotal: unitPrice * quantity,
    });
  }
  return resolved;
}

async function loadValidPromo(code, { restaurantId, customerId, subtotal, fulfillment }) {
  const settings = await loadSettings();
  if (!isOn(settings.promotions_enabled)) throw conflict('Les codes promo sont desactives pour le moment.');
  const promo = await store.get('SELECT * FROM promotions WHERE lower(code) = lower($1)', [String(code).trim()]);
  if (!promo) throw badRequest('Code promo inconnu.');
  if (!promo.is_active) throw conflict('Ce code promo n est plus actif.');
  const now = nowIso();
  if (promo.starts_at && now < promo.starts_at) throw conflict('Ce code promo n est pas encore valable.');
  if (promo.ends_at && now > promo.ends_at) throw conflict('Ce code promo a expire.');
  if (promo.restaurant_id && Number(promo.restaurant_id) !== Number(restaurantId)) {
    throw conflict('Ce code promo ne s applique pas a ce restaurant.');
  }
  if (subtotal < Number(promo.min_order_cents)) {
    throw conflict(`Ce code demande un minimum de ${(Number(promo.min_order_cents) / 100).toFixed(2)} MAD.`);
  }
  if (promo.discount_type === 'free_delivery' && fulfillment !== 'delivery') {
    throw conflict('Ce code ne s applique qu aux commandes en livraison.');
  }
  if (Number(promo.usage_limit) > 0) {
    const used = await store.get('SELECT COUNT(*) AS c FROM promotion_uses WHERE promotion_id = $1', [promo.id]);
    if (Number(used.c) >= Number(promo.usage_limit)) throw conflict('Ce code promo a atteint sa limite.');
  }
  if (Number(promo.per_customer_limit) > 0 && customerId) {
    const mine = await store.get(
      'SELECT COUNT(*) AS c FROM promotion_uses WHERE promotion_id = $1 AND customer_id = $2', [promo.id, customerId]);
    if (Number(mine.c) >= Number(promo.per_customer_limit)) throw conflict('Tu as deja utilise ce code.');
  }
  return promo;
}

function discountFor(promo, subtotal, deliveryFee) {
  let discount = 0;
  if (promo.discount_type === 'percent') {
    discount = Math.round((subtotal * Number(promo.discount_value)) / 100);
    if (Number(promo.max_discount_cents) > 0) discount = Math.min(discount, Number(promo.max_discount_cents));
  } else if (promo.discount_type === 'fixed') {
    discount = Math.min(Number(promo.discount_value), subtotal);
  } else if (promo.discount_type === 'free_delivery') {
    discount = deliveryFee;
  }
  return Math.max(0, Math.min(discount, subtotal + deliveryFee));
}

/*
 * Who absorbs a discount decides the commission:
 *  - platform-funded: the restaurant is paid as if there were no discount,
 *    and the discount comes out of the platform's commission.
 *  - restaurant-funded: the discount reduces the food total, so commission
 *    is charged on what is left.
 */
function priceOrder({ subtotal, deliveryFee, rate, promo }) {
  const discount = promo ? discountFor(promo, subtotal, deliveryFee) : 0;
  const fundedBy = promo ? promo.funded_by : '';
  const foodDiscount = Math.min(discount, subtotal);
  const feeDiscount = discount - foodDiscount;
  const commissionBase = fundedBy === 'restaurant' ? subtotal - foodDiscount : subtotal;
  const commission = Math.round((commissionBase * rate) / 10000);
  const restaurantNet = fundedBy === 'restaurant'
    ? (subtotal - foodDiscount) - commission + (deliveryFee - feeDiscount)
    : subtotal - commission + deliveryFee;
  return {
    discount, fundedBy, commission, restaurantNet,
    total: subtotal + deliveryFee - discount,
  };
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */
/*
 * Was this option sent as a removal?
 *
 * A removal takes an ingredient out ("Sans oignons") and is always free, so
 * both menu editors route through here and then force the price to zero. The
 * price column stays non-negative, which keeps every total honest no matter
 * what a crafted request sends.
 */
const isRemoval = (body) => bool(body, 'is_removal', false);

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

/*
 * One endpoint for every picture in the app: a restaurant logo, a cover, a
 * dish photo.
 *
 * Restaurant owners and admins with catalog or restaurant rights may upload.
 * A customer may not: there is nothing in the app for a customer to
 * illustrate, and an open upload endpoint is a free file host for whoever
 * finds it.
 */
router.post('/api/upload', async (ctx) => {
  const user = await requireUser(ctx);
  const allowed = user.role === 'restaurant'
    || (user.role === 'admin'
      && (can(user, 'catalog.manage') || can(user, 'restaurants.manage')));
  if (!allowed) throw forbidden('Tu n as pas le droit d envoyer des images.');

  if (!isMultipart(ctx.req)) {
    throw badRequest('Envoie le fichier en multipart/form-data.');
  }
  const boundary = readBoundary(ctx.req.headers['content-type']);
  if (!boundary) throw badRequest('Requete multipart sans delimiteur.');

  const raw = await readRawBody(ctx.req, { maxBytes: MAX_UPLOAD_BYTES });
  let parsed;
  try {
    parsed = parseMultipart(raw, boundary);
  } catch (error) {
    if (error instanceof UploadError) throw badRequest(error.message);
    throw error;
  }

  const file = parsed.files.find((f) => f.field === 'file') || parsed.files[0];
  if (!file) throw badRequest('Aucun fichier recu.');

  let saved;
  try {
    saved = saveUpload(file);
  } catch (error) {
    if (error instanceof UploadError) throw badRequest(error.message);
    throw error;
  }

  log.info('upload.saved', {
    user_id: user.id, role: user.role, bytes: saved.bytes, mime: saved.mime, url: saved.url,
  });
  return { url: saved.url, bytes: saved.bytes, mime: saved.mime };
});

/** What the file inputs are allowed to offer, so the browser and server agree. */
router.get('/api/upload/limits', async () => ({
  max_bytes: MAX_UPLOAD_BYTES,
  types: ALLOWED_TYPES,
}));

/*
 * Removing a picture.
 *
 * Only an admin who manages the catalog may delete a stored file: a
 * restaurant replacing its own logo simply points at a new URL, and letting
 * it delete by URL would let one restaurant delete another's picture.
 */
router.delete('/api/admin/upload', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const url = str(ctx.query.get('url') ? { url: ctx.query.get('url') } : ctx.body, 'url', { max: 200 });
  const removed = deleteUpload(url);
  if (removed) await audit(ctx, admin, 'upload_delete', 'upload', 0, { url });
  return { deleted: removed };
});

const ORDER_SELECT = `SELECT o.*, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar,
  r.phone AS restaurant_phone, r.address AS restaurant_address, r.city AS restaurant_city
  FROM orders o JOIN restaurants r ON r.id = o.restaurant_id`;

async function loadOrder(id) {
  const order = await store.get(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
  if (!order) throw notFound('Commande introuvable.');
  order.items = await store.all(
    `SELECT id, name, name_ar, base_price_cents, unit_price_cents, quantity, line_total_cents, note
     FROM order_items WHERE order_id = $1 ORDER BY id`, [id]);
  const itemIds = order.items.map((i) => i.id);
  if (itemIds.length) {
    const opts = await store.all(
      `SELECT order_item_id, group_name, group_name_ar, name, name_ar, price_delta_cents, is_removal
       FROM order_item_options WHERE order_item_id IN (${itemIds.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY id`,
      itemIds);
    for (const item of order.items) item.options = opts.filter((o) => o.order_item_id === item.id);
  }
  order.history = await store.all(
    'SELECT from_status, to_status, note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY id', [id]);
  order.refunds = await store.all(
    'SELECT amount_cents, reason, created_at FROM refunds WHERE order_id = $1 ORDER BY id', [id]);
  return withDelivery(order);
}

/*
 * Attaches the frozen delivery address to an order, already formatted.
 *
 * The restaurant card, the admin detail and the customer's own order list all
 * show the same thing, so it is built once here instead of three times in
 * three front-ends. Orders placed before addresses existed, and every pickup
 * order, simply get delivery: null.
 */
function withDelivery(order) {
  if (!order) return order;
  const snap = snapshotFromOrder(order);
  order.delivery = snap ? {
    label: snap.label,
    recipient_name: snap.recipient_name,
    recipient_phone: snap.recipient_phone,
    city: snap.city,
    one_line: oneLine(snap),
    block: addressBlock(snap),
    lat: snap.lat,
    lng: snap.lng,
    has_pin: hasValidPin(snap),
    map_link: mapLink(snap),
  } : null;
  return order;
}

/** Customer-facing wording for each schedule rejection. */
const SCHEDULE_ERRORS = {
  not_preorder: 'Ce restaurant livre immediatement: pas de date a choisir.',
  schedule_required: 'Choisis une date et un creneau de livraison.',
  bad_date: 'Date de livraison invalide.',
  date_unavailable: 'Ce restaurant ne livre pas ce jour-la.',
  slot_unavailable: 'Ce creneau n est pas disponible.',
};

const newOrderNumber = () =>
  `CMD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

router.post('/api/orders', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const restaurantId = int(ctx.body, 'restaurant_id', { min: 1 });
  const fulfillment = oneOf(ctx.body, 'fulfillment_type', ['pickup', 'delivery']);
  const note = str(ctx.body, 'note', { required: false, max: 500 });
  // Allergies and anything else the cook must read; shown with a badge.
  const specialInstructions = str(ctx.body, 'special_instructions', { required: false, max: 500 });
  const contactName = str(ctx.body, 'customer_name', { required: false, max: 120 }) || user.name;
  const contactPhone = str(ctx.body, 'customer_phone', { required: false, max: 30 }) || user.phone || '';
  if (!contactPhone) throw badRequest('Un numero de telephone est obligatoire.');

  const items = Array.isArray(ctx.body.items) ? ctx.body.items : null;
  if (!items || items.length === 0) throw badRequest('Le panier est vide.');
  if (items.length > 50) throw badRequest('Trop de lignes dans le panier.');

  const settings = await loadSettings();
  if (isOn(settings.maintenance_mode) && user.role !== 'admin') {
    throw conflict('La plateforme est en maintenance. Reessaie dans quelques minutes.');
  }

  const resto = await store.get("SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'", [restaurantId]);
  if (!resto) throw notFound('Restaurant introuvable.');
  if (!resto.is_open) throw conflict('Ce restaurant est ferme pour le moment.');
  if (fulfillment === 'delivery' && !resto.supports_delivery) throw conflict('Ce restaurant ne fait pas de livraison.');
  if (fulfillment === 'pickup' && !resto.supports_pickup) throw conflict('Ce restaurant ne fait pas de retrait sur place.');

  /*
   * Delivery needs a saved address, chosen by the customer, with a map pin.
   * What goes on the order is a copy of that row, not a link to it, so that
   * editing or deleting the address later cannot rewrite a past order.
   *
   * delivery_address is still accepted for a pickup-era client and for the
   * admin placing an order by hand, but a plain line of text with no pin is
   * not enough for a delivery: a courier would have nothing to navigate to.
   */
  let addressSnapshot = null;
  let addressId = null;
  let address = '';

  if (fulfillment === 'delivery') {
    addressId = int(ctx.body, 'address_id', { required: false, min: 1, fallback: 0 }) || null;
    if (!addressId) {
      throw badRequest('Choisis une adresse de livraison enregistree.');
    }
    const saved = await store.get(
      'SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2', [addressId, user.id]);
    if (!saved) throw notFound('Adresse de livraison introuvable.');
    if (!hasValidPin(saved)) {
      throw badRequest('Cette adresse n a pas de point sur la carte. Modifie-la avant de commander.');
    }
    addressSnapshot = snapshotColumns(saved);
    address = oneLine(saved);
  }

  // Pre-order restaurants need a delivery day and slot; immediate ones must not have one.
  const scheduledFor = str(ctx.body, 'scheduled_for', { required: false, max: 10 });
  const scheduledSlot = str(ctx.body, 'scheduled_slot', { required: false, max: 20 });
  const schedule = validateSchedule(resto, scheduledFor, scheduledSlot);
  if (!schedule.ok) throw badRequest(SCHEDULE_ERRORS[schedule.reason] || 'Date de livraison invalide.');
  const serviceType = resto.service_type === 'preorder' ? 'preorder' : 'immediate';

  // Prices, options and discounts are all resolved from the database.
  const targetDate = resto.service_type === 'preorder' ? scheduledFor : new Date().toISOString().slice(0, 10);
  const resolved = await resolveLines(restaurantId, items, { targetDate });

  const subtotal = resolved.reduce((sum, line) => sum + line.lineTotal, 0);
  if (subtotal < resto.min_order_cents) {
    throw conflict(`Minimum de commande: ${(resto.min_order_cents / 100).toFixed(2)} MAD.`);
  }
  const deliveryFee = fulfillment === 'delivery' ? Number(resto.delivery_fee_cents) : 0;
  const rate = Number(resto.commission_rate_bp);

  const code = str(ctx.body, 'promo_code', { required: false, max: 40 });
  const promo = code
    ? await loadValidPromo(code, { restaurantId, customerId: user.id, subtotal, fulfillment })
    : null;
  const priced = priceOrder({ subtotal, deliveryFee, rate, promo });
  const { discount, fundedBy, commission, restaurantNet, total } = priced;
  const at = nowIso();

  const orderId = await store.tx(async (t) => {
    const snap = addressSnapshot || {
      addr_label: '', addr_recipient_name: '', addr_recipient_phone: '', addr_city: '',
      addr_street: '', addr_building: '', addr_floor: '', addr_landmark: '',
      addr_instructions: '', addr_lat: '', addr_lng: '',
    };
    const id = await t.insert(
      `INSERT INTO orders (order_number, customer_id, restaurant_id, fulfillment_type, status, customer_name,
        customer_phone, delivery_address, note, items_subtotal_cents, delivery_fee_cents, total_cents,
        commission_rate_bp, commission_cents, restaurant_net_cents, discount_cents, discount_funded_by,
        promotion_id, promo_code, service_type, scheduled_for, scheduled_slot,
        address_id, addr_label, addr_recipient_name, addr_recipient_phone, addr_city, addr_street,
        addr_building, addr_floor, addr_landmark, addr_instructions, addr_lat, addr_lng,
        special_instructions, placed_at, updated_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
      [newOrderNumber(), user.id, restaurantId, fulfillment, contactName, contactPhone, address, note,
       subtotal, deliveryFee, total, rate, commission, restaurantNet, discount, fundedBy,
       promo ? promo.id : null, promo ? promo.code : '',
       serviceType, serviceType === 'preorder' ? scheduledFor : '', serviceType === 'preorder' ? scheduledSlot : '',
       addressId,
       snap.addr_label, snap.addr_recipient_name, snap.addr_recipient_phone, snap.addr_city,
       snap.addr_street, snap.addr_building, snap.addr_floor, snap.addr_landmark,
       snap.addr_instructions, snap.addr_lat, snap.addr_lng,
       specialInstructions, at, at]);

    for (const line of resolved) {
      const itemId = await t.insert(
        `INSERT INTO order_items (order_id, product_id, name, name_ar, base_price_cents, unit_price_cents,
          quantity, line_total_cents, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, line.product.id, line.product.name, line.product.name_ar, line.product.price_cents,
         line.unitPrice, line.quantity, line.lineTotal, line.note]);
      for (const { group, option } of line.chosen) {
        await t.run(
          `INSERT INTO order_item_options (order_item_id, group_name, group_name_ar, name, name_ar,
            price_delta_cents, is_removal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [itemId, group.name, group.name_ar, option.name, option.name_ar,
           option.price_delta_cents, option.is_removal ? 1 : 0]);
      }
    }
    if (promo) {
      await t.run(
        'INSERT INTO promotion_uses (promotion_id, order_id, customer_id, discount_cents, created_at) VALUES ($1,$2,$3,$4,$5)',
        [promo.id, id, user.id, discount, at]);
    }
    await t.run(
      'INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, null, 'pending', user.id, 'Commande passee', at]);
    return id;
  });

  const created = await loadOrder(orderId);

  /*
   * The kitchen hears about it now, not at the next poll.
   *
   * Both of these are deliberately outside the transaction and deliberately
   * not awaited: the order is already saved, and a webhook that times out or
   * a dashboard that has gone away must not turn a successful order into an
   * error for the customer who placed it.
   */
  publish(restaurantId, 'order.created', {
    id: created.id,
    order_number: created.order_number,
    total_cents: created.total_cents,
    fulfillment_type: created.fulfillment_type,
    service_type: created.service_type,
    has_allergy_note: Boolean(created.special_instructions),
    placed_at: created.placed_at,
  });

  const owner = await store.get(
    `SELECT r.id, r.name, r.phone, u.phone AS owner_phone
     FROM restaurants r LEFT JOIN users u ON u.id = r.owner_user_id WHERE r.id = $1`,
    [restaurantId]);
  notifyNewOrder({ ...created, items_count: resolved.length }, owner)
    .catch((error) => log.warn('notify.failed', { error: String(error && error.message).slice(0, 160) }));

  return { order: created };
});

/* ------------------------------------------------------------------ *
 * Reviews
 * ------------------------------------------------------------------ */

/*
 * Recomputes a restaurant's average and count from the reviews themselves.
 *
 * Derived rather than incremented: an average kept by adding to a running
 * total drifts the first time a review is deleted or edited, and a wrong star
 * rating is the kind of error nobody notices for months. Reading the table is
 * cheap and always right.
 */
async function recalculateRating(t, restaurantId) {
  const row = await t.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(rating), 0) AS total FROM reviews WHERE restaurant_id = $1',
    [restaurantId]);
  const count = Number(row.c || 0);
  const total = Number(row.total || 0);
  // rating_bp holds the average times 10000, so 4.5 stars is 45000.
  const bp = count ? Math.round((total / count) * 10000) : 0;
  await t.run('UPDATE restaurants SET rating_bp = $1, reviews_count = $2 WHERE id = $3',
    [bp, count, restaurantId]);
  return { count, average: count ? total / count : 0, rating_bp: bp };
}

const publicReview = (row) => ({
  id: row.id,
  rating: Number(row.rating),
  comment: row.comment || '',
  // A first name and an initial: enough to read as a person, not enough to
  // identify a customer to anyone browsing the restaurant's page.
  author: shortName(row.customer_name),
  created_at: row.created_at,
});

/** "Ilham Benali" -> "Ilham B." Leaves a single name alone. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Client';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

router.post('/api/orders/:id/review', async (ctx) => {
  const user = await requireRole(ctx, 'customer');
  const id = Number(ctx.params.id);
  const order = await store.get(
    'SELECT id, customer_id, restaurant_id, status FROM orders WHERE id = $1', [id]);

  /*
   * Someone else's order answers the same "introuvable" as an order that does
   * not exist, so a stranger cannot discover which order numbers are real by
   * trying to review them.
   */
  if (!order || Number(order.customer_id) !== Number(user.id)) throw notFound('Commande introuvable.');
  if (order.status !== 'completed') {
    throw conflict('Tu pourras noter cette commande une fois qu elle sera terminee.');
  }

  const rating = int(ctx.body, 'rating', { min: 1, max: 5 });
  const comment = str(ctx.body, 'comment', { required: false, max: 1000 });

  const existing = await store.get('SELECT id FROM reviews WHERE order_id = $1', [id]);
  if (existing) throw conflict('Cette commande a deja ete notee.');

  const at = nowIso();
  const result = await store.tx(async (t) => {
    const reviewId = await t.insert(
      `INSERT INTO reviews (order_id, customer_id, restaurant_id, rating, comment, customer_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, user.id, order.restaurant_id, rating, comment, user.name, at]);
    const totals = await recalculateRating(t, order.restaurant_id);
    return { reviewId, totals };
  });

  log.info('review.created', {
    order_id: id, restaurant_id: Number(order.restaurant_id), rating,
    reviews_count: result.totals.count,
  });

  return {
    review: { id: result.reviewId, rating, comment, created_at: at },
    restaurant: {
      id: Number(order.restaurant_id),
      rating: result.totals.average,
      reviews_count: result.totals.count,
    },
  };
});

/** Everyone can read a restaurant's reviews; nobody needs an account to. */
router.get('/api/restaurants/:id/reviews', async (ctx) => {
  const id = Number(ctx.params.id);
  const resto = await store.get(
    "SELECT id, rating_bp, reviews_count FROM restaurants WHERE id = $1 AND status = 'approved'", [id]);
  if (!resto) throw notFound('Restaurant introuvable.');

  const limit = int(ctx.query.get('limit') ? { limit: ctx.query.get('limit') } : {}, 'limit',
    { required: false, fallback: 20, min: 1, max: 100 });
  const rows = await store.all(
    `SELECT id, rating, comment, customer_name, created_at FROM reviews
     WHERE restaurant_id = $1 ORDER BY id DESC LIMIT ${Number(limit)}`, [id]);

  // How many gave each number of stars, for the little bar chart.
  const spread = await store.all(
    'SELECT rating, COUNT(*) AS c FROM reviews WHERE restaurant_id = $1 GROUP BY rating', [id]);
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of spread) breakdown[Number(row.rating)] = Number(row.c);

  return {
    restaurant_id: id,
    rating: Number(resto.rating_bp || 0) / 10000,
    reviews_count: Number(resto.reviews_count || 0),
    breakdown,
    reviews: rows.map(publicReview),
  };
});

/** Which of my completed orders I have not rated yet. */
router.get('/api/me/reviewable', async (ctx) => {
  const user = await requireRole(ctx, 'customer');
  const rows = await store.all(
    `SELECT o.id, o.order_number, o.restaurant_id, r.name AS restaurant_name, o.updated_at
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN reviews v ON v.order_id = o.id
     WHERE o.customer_id = $1 AND o.status = 'completed' AND v.id IS NULL
     ORDER BY o.id DESC LIMIT 20`, [user.id]);
  return { orders: rows };
});

/*
 * An admin can remove a review.
 *
 * Not to tidy up bad scores — to remove abuse, a phone number posted in a
 * comment, or a test left behind. Every removal is audited with the text that
 * was removed, so a pattern of convenient deletions is visible afterwards.
 */
router.delete('/api/admin/reviews/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'restaurants.manage');
  const id = Number(ctx.params.id);
  const review = await store.get('SELECT * FROM reviews WHERE id = $1', [id]);
  if (!review) throw notFound('Avis introuvable.');

  await store.tx(async (t) => {
    await t.run('DELETE FROM reviews WHERE id = $1', [id]);
    await recalculateRating(t, review.restaurant_id);
  });
  await audit(ctx, admin, 'review_delete', 'review', id,
    { restaurant_id: Number(review.restaurant_id) }, { before: review, after: null });
  return { deleted: true };
});

/* ------------------------------------------------------------------ *
 * The restaurant's live order stream
 * ------------------------------------------------------------------ */

/*
 * A one-minute, one-use ticket.
 *
 * EventSource cannot carry an Authorization header, so the dashboard asks for
 * this over the normal authenticated API and spends it on the stream below.
 * A session token in a URL would sit in proxy logs and browser history; a
 * ticket that dies in sixty seconds and works once does not.
 */
router.post('/api/restaurant/stream-ticket', async (ctx) => {
  const { user, resto } = await myRestaurant(ctx);
  return issueTicket({ restaurantId: resto.id, userId: user.id });
});

router.get('/api/restaurant/stream', async (ctx) => {
  const ticket = redeemTicket(ctx.query.get('ticket'));
  if (!ticket) throw unauthorized('Ticket de flux invalide ou expire.');
  openStream(ctx.req, ctx.res, { restaurantId: ticket.restaurantId });
  // The response now belongs to stream.js; index.js sees the sent headers and
  // leaves it alone.
});

/** Cart preview: checks a promo code and returns the exact totals, without ordering. */
router.post('/api/orders/quote', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const restaurantId = int(ctx.body, 'restaurant_id', { min: 1 });
  const fulfillment = oneOf(ctx.body, 'fulfillment_type', ['pickup', 'delivery']);
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  if (!items.length) throw badRequest('Le panier est vide.');

  const resto = await store.get("SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'", [restaurantId]);
  if (!resto) throw notFound('Restaurant introuvable.');

  const targetDate = resto.service_type === 'preorder'
    ? str(ctx.body, 'scheduled_for', { required: false, max: 10 })
    : new Date().toISOString().slice(0, 10);
  const resolved = await resolveLines(restaurantId, items, { targetDate });
  const subtotal = resolved.reduce((sum, line) => sum + line.lineTotal, 0);
  const deliveryFee = fulfillment === 'delivery' ? Number(resto.delivery_fee_cents) : 0;
  const code = str(ctx.body, 'promo_code', { required: false, max: 40 });
  const promo = code
    ? await loadValidPromo(code, { restaurantId, customerId: user.id, subtotal, fulfillment })
    : null;
  const priced = priceOrder({ subtotal, deliveryFee, rate: Number(resto.commission_rate_bp), promo });

  return {
    items_subtotal_cents: subtotal,
    delivery_fee_cents: deliveryFee,
    discount_cents: priced.discount,
    total_cents: priced.total,
    promo: promo ? { code: promo.code, description: promo.description, description_ar: promo.description_ar } : null,
    min_order_cents: Number(resto.min_order_cents),
    below_minimum: subtotal < Number(resto.min_order_cents),
  };
});

router.get('/api/orders', async (ctx) => {
  const user = await requireUser(ctx);
  if (user.role === 'customer') {
    const mine = await store.all(
      `${ORDER_SELECT} WHERE o.customer_id = $1 ORDER BY o.id DESC LIMIT 100`, [user.id]);

    /*
     * Which of these the customer has already rated.
     *
     * Fetched in one query rather than one per order, and attached here so
     * the interface can show "Noter la commande" or the stars already given
     * without asking again.
     */
    const ids = mine.map((o) => Number(o.id));
    const reviews = ids.length
      ? await store.all(
        `SELECT order_id, rating, comment FROM reviews
         WHERE order_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids)
      : [];
    const byOrder = new Map(reviews.map((r) => [Number(r.order_id), r]));

    return {
      orders: mine.map((o) => {
        const review = byOrder.get(Number(o.id));
        return {
          ...withDelivery(o),
          my_review: review
            ? { rating: Number(review.rating), comment: review.comment || '' }
            : null,
        };
      }),
    };
  }
  if (user.role === 'admin') {
    return { orders: await store.all(`${ORDER_SELECT} ORDER BY o.id DESC LIMIT 200`) };
  }
  throw forbidden();
});

router.get('/api/orders/:id', async (ctx) => {
  const user = await requireUser(ctx);
  const order = await loadOrder(Number(ctx.params.id));
  if (user.role === 'admin') return { order };
  if (user.role === 'customer' && Number(order.customer_id) === Number(user.id)) return { order };
  if (user.role === 'restaurant') {
    const resto = await store.get('SELECT id FROM restaurants WHERE owner_user_id = $1', [user.id]);
    if (resto && Number(resto.id) === Number(order.restaurant_id)) return { order };
  }
  throw forbidden();
});

router.post('/api/orders/:id/cancel', async (ctx) => {
  const user = await requireRole(ctx, 'customer', 'admin');
  const order = await loadOrder(Number(ctx.params.id));
  if (user.role === 'customer' && Number(order.customer_id) !== Number(user.id)) throw forbidden();
  if (order.status !== 'pending') throw conflict('La commande ne peut plus etre annulee: le restaurant l a deja acceptee.');
  const reason = str(ctx.body, 'reason', { required: false, max: 200 }) || 'Annulee par le client';
  await setStatus(order, 'cancelled', user.id, reason);
  return { order: await loadOrder(order.id) };
});

/* ------------------------------------------------------------------ *
 * Status machine
 * ------------------------------------------------------------------ */
const TRANSITIONS = {
  pending: ['accepted', 'rejected', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [], rejected: [], cancelled: [],
};

async function setStatus(order, next, actorId, note = '') {
  const allowed = TRANSITIONS[order.status] || [];
  if (!allowed.includes(next)) throw conflict(`Impossible de passer de "${order.status}" a "${next}".`);
  const at = nowIso();
  const cashCollected = next === 'completed' ? 1 : order.cash_collected;
  const reason = (next === 'cancelled' || next === 'rejected') ? note : order.cancellation_reason;

  await store.tx(async (t) => {
    await t.run(
      'UPDATE orders SET status = $1, cash_collected = $2, cancellation_reason = $3, updated_at = $4 WHERE id = $5',
      [next, cashCollected, reason, at, order.id]);
    await t.run(
      'INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [order.id, order.status, next, actorId, note, at]);
  });
}

/* ------------------------------------------------------------------ *
 * Restaurant dashboard
 * ------------------------------------------------------------------ */
router.get('/api/restaurant/me', async (ctx) => ({
  restaurant: decorateRestaurant((await myRestaurant(ctx)).resto),
}));

router.put('/api/restaurant/me', async (ctx) => {
  const { user, resto } = await myRestaurant(ctx);
  const next = {
    name: str(ctx.body, 'name', { required: false, max: 120 }) || resto.name,
    name_ar: ctx.body.name_ar === undefined ? resto.name_ar : str(ctx.body, 'name_ar', { required: false, max: 120 }),
    city: str(ctx.body, 'city', { required: false, max: 80 }),
    address: str(ctx.body, 'address', { required: false, max: 200 }),
    phone: str(ctx.body, 'phone', { required: false, max: 30 }),
    description: str(ctx.body, 'description', { required: false, max: 600 }),
    description_ar: ctx.body.description_ar === undefined ? resto.description_ar : str(ctx.body, 'description_ar', { required: false, max: 600 }),
    image_url: str(ctx.body, 'image_url', { required: false, max: 400 }),
    supports_pickup: bool(ctx.body, 'supports_pickup', !!resto.supports_pickup) ? 1 : 0,
    supports_delivery: bool(ctx.body, 'supports_delivery', !!resto.supports_delivery) ? 1 : 0,
    delivery_fee_cents: int(ctx.body, 'delivery_fee_cents', { required: false, fallback: resto.delivery_fee_cents, max: 100000 }),
    min_order_cents: int(ctx.body, 'min_order_cents', { required: false, fallback: resto.min_order_cents, max: 1000000 }),
    prep_minutes: int(ctx.body, 'prep_minutes', { required: false, fallback: resto.prep_minutes, min: 1, max: 240 }),
    is_open: bool(ctx.body, 'is_open', !!resto.is_open) ? 1 : 0,
    chef_bio: ctx.body.chef_bio === undefined ? (resto.chef_bio || '') : str(ctx.body, 'chef_bio', { required: false, max: 1000 }),
    chef_bio_ar: ctx.body.chef_bio_ar === undefined ? (resto.chef_bio_ar || '') : str(ctx.body, 'chef_bio_ar', { required: false, max: 1000 }),
    pickup_instructions: ctx.body.pickup_instructions === undefined ? (resto.pickup_instructions || '') : str(ctx.body, 'pickup_instructions', { required: false, max: 500 }),
    pickup_instructions_ar: ctx.body.pickup_instructions_ar === undefined ? (resto.pickup_instructions_ar || '') : str(ctx.body, 'pickup_instructions_ar', { required: false, max: 500 }),
  };

  // The restaurant chooses immediate or pre-order, and configures the pre-order rules.
  const service = ctx.body.service_type === undefined
    ? {
        service_type: resto.service_type || 'immediate',
        min_prep_hours: Number(resto.min_prep_hours || 0),
        delivery_days: resto.delivery_days || '',
        delivery_slots: resto.delivery_slots || '',
        order_cutoff: resto.order_cutoff || '',
      }
    : readServiceConfig(ctx.body);

  await store.run(
    `UPDATE restaurants SET name=$1, name_ar=$2, city=$3, address=$4, phone=$5, description=$6, description_ar=$7,
      image_url=$8, supports_pickup=$9, supports_delivery=$10, delivery_fee_cents=$11, min_order_cents=$12,
      prep_minutes=$13, is_open=$14, service_type=$15, min_prep_hours=$16, delivery_days=$17,
      delivery_slots=$18, order_cutoff=$19, chef_bio=$20, chef_bio_ar=$21, pickup_instructions=$22, pickup_instructions_ar=$23
      WHERE id=$24`,
    [next.name, next.name_ar, next.city, next.address, next.phone, next.description, next.description_ar,
     next.image_url, next.supports_pickup, next.supports_delivery, next.delivery_fee_cents,
     next.min_order_cents, next.prep_minutes, next.is_open,
     service.service_type, service.min_prep_hours, service.delivery_days,
     service.delivery_slots, service.order_cutoff,
     next.chef_bio, next.chef_bio_ar, next.pickup_instructions, next.pickup_instructions_ar, resto.id]);
  await audit(ctx, user, 'restaurant_update', 'restaurant', resto.id);
  return { restaurant: decorateRestaurant(await store.get('SELECT * FROM restaurants WHERE id = $1', [resto.id])) };
});

router.get('/api/restaurant/orders', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const status = ctx.query.get('status');
  let sql = `${ORDER_SELECT} WHERE o.restaurant_id = $1`;
  const args = [resto.id];
  if (status === 'active') sql += " AND o.status IN ('pending','accepted','preparing','ready')";
  else if (status) { args.push(status); sql += ` AND o.status = $${args.length}`; }
  sql += ' ORDER BY o.id DESC LIMIT 200';

  const orders = (await store.all(sql, args)).map(withDelivery);
  for (const order of orders) {
    order.items = await store.all(
      'SELECT id, name, name_ar, quantity, unit_price_cents, line_total_cents, note FROM order_items WHERE order_id = $1 ORDER BY id',
      [order.id]);
    for (const item of order.items) {
      item.options = await store.all(
        `SELECT group_name, group_name_ar, name, name_ar, price_delta_cents, is_removal
         FROM order_item_options WHERE order_item_id = $1 ORDER BY id`,
        [item.id]);
    }
  }
  return { orders };
});

router.post('/api/restaurant/orders/:id/status', async (ctx) => {
  const { user, resto } = await myRestaurant(ctx);
  const order = await loadOrder(Number(ctx.params.id));
  if (Number(order.restaurant_id) !== Number(resto.id)) throw forbidden();
  const next = oneOf(ctx.body, 'status', ['accepted', 'rejected', 'preparing', 'ready', 'completed']);
  const note = str(ctx.body, 'note', { required: false, max: 200 });
  await setStatus(order, next, user.id, note);
  if (next === 'completed') await audit(ctx, user, 'cash_collected', 'order', order.id, { total_cents: order.total_cents });
  return { order: await loadOrder(order.id) };
});

router.get('/api/restaurant/stats', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const dayStart = new Date().toISOString().slice(0, 10);
  const today = await store.get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue_cents,
            COALESCE(SUM(commission_cents),0) AS commission_cents
     FROM orders WHERE restaurant_id = $1 AND status = 'completed' AND placed_at >= $2`,
    [resto.id, `${dayStart}T00:00:00.000Z`]);
  const allTime = await store.get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenue_cents,
            COALESCE(SUM(commission_cents),0) AS commission_cents,
            COALESCE(SUM(restaurant_net_cents),0) AS net_cents,
            COALESCE(SUM(refunded_cents),0) AS refunded_cents
     FROM orders WHERE restaurant_id = $1 AND status = 'completed'`, [resto.id]);
  const pending = await store.get(
    "SELECT COUNT(*) AS c FROM orders WHERE restaurant_id = $1 AND status = 'pending'", [resto.id]);
  return {
    today: numbers(today),
    all_time: numbers(allTime),
    pending_orders: Number(pending.c),
    commission_rate_bp: Number(resto.commission_rate_bp),
  };
});

const numbers = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));

/* ------------------------------------------------------------------ *
 * Menu management
 * ------------------------------------------------------------------ */
router.get('/api/restaurant/menu', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const categories = await store.all('SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, id', [resto.id]);
  const products = await store.all('SELECT * FROM products WHERE restaurant_id = $1 ORDER BY sort_order, id', [resto.id]);
  const groups = await store.all(
    `SELECT g.* FROM option_groups g JOIN products p ON p.id = g.product_id
     WHERE p.restaurant_id = $1 ORDER BY g.sort_order, g.id`, [resto.id]);
  const options = await store.all(
    `SELECT o.* FROM product_options o JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id WHERE p.restaurant_id = $1 ORDER BY o.sort_order, o.id`, [resto.id]);
  for (const group of groups) group.options = options.filter((o) => Number(o.option_group_id) === Number(group.id));
  for (const product of products) product.option_groups = groups.filter((g) => Number(g.product_id) === Number(product.id));
  return { categories, products };
});

router.post('/api/restaurant/categories', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const id = await store.insert(
    'INSERT INTO categories (restaurant_id, name, name_ar, sort_order) VALUES ($1,$2,$3,$4)',
    [resto.id, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  return { category: await store.get('SELECT * FROM categories WHERE id = $1', [id]) };
});

router.put('/api/restaurant/categories/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const cat = await ownedCategory(resto.id, Number(ctx.params.id));
  await store.run('UPDATE categories SET name = $1, name_ar = $2, sort_order = $3 WHERE id = $4',
    [str(ctx.body, 'name', { required: false, max: 80 }) || cat.name,
     ctx.body.name_ar === undefined ? cat.name_ar : str(ctx.body, 'name_ar', { required: false, max: 80 }),
     int(ctx.body, 'sort_order', { required: false, fallback: cat.sort_order, max: 9999 }), cat.id]);
  return { category: await store.get('SELECT * FROM categories WHERE id = $1', [cat.id]) };
});

router.delete('/api/restaurant/categories/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const cat = await ownedCategory(resto.id, Number(ctx.params.id));
  await store.run('UPDATE products SET category_id = NULL WHERE category_id = $1', [cat.id]);
  await store.run('DELETE FROM categories WHERE id = $1', [cat.id]);
  return { deleted: true };
});

router.post('/api/restaurant/products', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  let categoryId = ctx.body.category_id ? int(ctx.body, 'category_id', { min: 1 }) : null;
  if (categoryId) categoryId = (await ownedCategory(resto.id, categoryId)).id;
  const dailyStock = int(ctx.body, 'daily_stock', { required: false, fallback: 0, min: 0, max: 9999 });
  const id = await store.insert(
    `INSERT INTO products (restaurant_id, category_id, name, name_ar, description, description_ar,
      price_cents, image_url, sort_order, daily_stock, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [resto.id, categoryId, str(ctx.body, 'name', { max: 120 }),
     str(ctx.body, 'name_ar', { required: false, max: 120 }),
     str(ctx.body, 'description', { required: false, max: 500 }),
     str(ctx.body, 'description_ar', { required: false, max: 500 }),
     int(ctx.body, 'price_cents', { min: 0, max: 10000000 }),
     str(ctx.body, 'image_url', { required: false, max: 400 }),
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 }),
     dailyStock, nowIso()]);
  return { product: await store.get('SELECT * FROM products WHERE id = $1', [id]) };
});

router.put('/api/restaurant/products/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const product = await ownedProduct(resto.id, Number(ctx.params.id));
  let categoryId = product.category_id;
  if (ctx.body.category_id !== undefined) {
    categoryId = ctx.body.category_id ? (await ownedCategory(resto.id, int(ctx.body, 'category_id', { min: 1 }))).id : null;
  }
  const dailyStock = ctx.body.daily_stock === undefined
    ? Number(product.daily_stock || 0)
    : int(ctx.body, 'daily_stock', { required: false, fallback: 0, min: 0, max: 9999 });
  await store.run(
    `UPDATE products SET category_id=$1, name=$2, name_ar=$3, description=$4, description_ar=$5,
      price_cents=$6, image_url=$7, is_active=$8, sort_order=$9, daily_stock=$10 WHERE id=$11`,
    [categoryId,
     str(ctx.body, 'name', { required: false, max: 120 }) || product.name,
     ctx.body.name_ar === undefined ? product.name_ar : str(ctx.body, 'name_ar', { required: false, max: 120 }),
     ctx.body.description === undefined ? product.description : str(ctx.body, 'description', { required: false, max: 500 }),
     ctx.body.description_ar === undefined ? product.description_ar : str(ctx.body, 'description_ar', { required: false, max: 500 }),
     int(ctx.body, 'price_cents', { required: false, fallback: product.price_cents, max: 10000000 }),
     ctx.body.image_url === undefined ? product.image_url : str(ctx.body, 'image_url', { required: false, max: 400 }),
     bool(ctx.body, 'is_active', !!product.is_active) ? 1 : 0,
     int(ctx.body, 'sort_order', { required: false, fallback: product.sort_order, max: 9999 }),
     dailyStock, product.id]);
  return { product: await store.get('SELECT * FROM products WHERE id = $1', [product.id]) };
});

router.delete('/api/restaurant/products/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const product = await ownedProduct(resto.id, Number(ctx.params.id));
  const used = await store.get('SELECT COUNT(*) AS c FROM order_items WHERE product_id = $1', [product.id]);
  if (Number(used.c) > 0) {
    await store.run('UPDATE products SET is_active = 0 WHERE id = $1', [product.id]);
    return { deleted: false, deactivated: true };
  }
  await store.run('DELETE FROM products WHERE id = $1', [product.id]);
  return { deleted: true };
});

/* ---- option groups & options ---- */
router.post('/api/restaurant/option-groups', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const product = await ownedProduct(resto.id, int(ctx.body, 'product_id', { min: 1 }));
  const min = int(ctx.body, 'min_select', { required: false, fallback: 0, max: 20 });
  const max = int(ctx.body, 'max_select', { required: false, fallback: 1, min: 1, max: 20 });
  if (min > max) throw badRequest('Le minimum ne peut pas depasser le maximum.');
  const id = await store.insert(
    'INSERT INTO option_groups (product_id, name, name_ar, min_select, max_select, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
    [product.id, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     min, max, int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  return { group: await store.get('SELECT * FROM option_groups WHERE id = $1', [id]) };
});

router.put('/api/restaurant/option-groups/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const group = await ownedGroup(resto.id, Number(ctx.params.id));
  const min = int(ctx.body, 'min_select', { required: false, fallback: group.min_select, max: 20 });
  const max = int(ctx.body, 'max_select', { required: false, fallback: group.max_select, min: 1, max: 20 });
  if (min > max) throw badRequest('Le minimum ne peut pas depasser le maximum.');
  await store.run('UPDATE option_groups SET name=$1, name_ar=$2, min_select=$3, max_select=$4 WHERE id=$5',
    [str(ctx.body, 'name', { required: false, max: 80 }) || group.name,
     ctx.body.name_ar === undefined ? group.name_ar : str(ctx.body, 'name_ar', { required: false, max: 80 }),
     min, max, group.id]);
  return { group: await store.get('SELECT * FROM option_groups WHERE id = $1', [group.id]) };
});

router.delete('/api/restaurant/option-groups/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const group = await ownedGroup(resto.id, Number(ctx.params.id));
  await store.run('DELETE FROM option_groups WHERE id = $1', [group.id]);
  return { deleted: true };
});

router.post('/api/restaurant/options', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const group = await ownedGroup(resto.id, int(ctx.body, 'option_group_id', { min: 1 }));
  const id = await store.insert(
    `INSERT INTO product_options (option_group_id, name, name_ar, price_delta_cents, is_removal, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [group.id, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     isRemoval(ctx.body) ? 0 : int(ctx.body, 'price_delta_cents', { required: false, fallback: 0, max: 1000000 }),
     isRemoval(ctx.body) ? 1 : 0,
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  return { option: await store.get('SELECT * FROM product_options WHERE id = $1', [id]) };
});

router.put('/api/restaurant/options/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const option = await store.get(
    `SELECT o.* FROM product_options o JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id WHERE o.id = $1 AND p.restaurant_id = $2`,
    [Number(ctx.params.id), resto.id]);
  if (!option) throw notFound('Option introuvable.');
  const removal = ctx.body.is_removal === undefined
    ? !!option.is_removal
    : isRemoval(ctx.body);
  await store.run(
    `UPDATE product_options SET name=$1, name_ar=$2, price_delta_cents=$3, is_available=$4, is_removal=$5
     WHERE id=$6`,
    [str(ctx.body, 'name', { required: false, max: 80 }) || option.name,
     ctx.body.name_ar === undefined ? option.name_ar : str(ctx.body, 'name_ar', { required: false, max: 80 }),
     removal ? 0 : int(ctx.body, 'price_delta_cents', { required: false, fallback: option.price_delta_cents, max: 1000000 }),
     bool(ctx.body, 'is_available', !!option.is_available) ? 1 : 0,
     removal ? 1 : 0, option.id]);
  return { option: await store.get('SELECT * FROM product_options WHERE id = $1', [option.id]) };
});

router.delete('/api/restaurant/options/:id', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  const option = await store.get(
    `SELECT o.id FROM product_options o JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id WHERE o.id = $1 AND p.restaurant_id = $2`,
    [Number(ctx.params.id), resto.id]);
  if (!option) throw notFound('Option introuvable.');
  await store.run('DELETE FROM product_options WHERE id = $1', [option.id]);
  return { deleted: true };
});

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */
router.get('/api/admin/restaurants', async (ctx) => {
  await requirePermission(ctx, 'restaurants.view');
  const status = ctx.query.get('status');
  const service = (ctx.query.get('service') || '').trim();
  const cuisine = (ctx.query.get('cuisine') || '').trim().toLowerCase();
  const q = (ctx.query.get('q') || '').trim();

  let sql = `SELECT r.*, u.name AS owner_name, u.email AS owner_email FROM restaurants r
             JOIN users u ON u.id = r.owner_user_id`;
  const where = [];
  const args = [];
  if (status) { args.push(status); where.push(`r.status = $${args.length}`); }
  if (SERVICE_TYPES.includes(service)) { args.push(service); where.push(`r.service_type = $${args.length}`); }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(r.name LIKE $${args.length} OR r.name_ar LIKE $${args.length} OR r.city LIKE $${args.length})`);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += " ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC";

  let rows = await store.all(sql, args);
  if (CUISINE_KEYS.includes(cuisine)) {
    rows = rows.filter((r) => parseCuisines(r.cuisines).includes(cuisine));
  }
  return { restaurants: rows.map(decorateRestaurant) };
});

router.post('/api/admin/restaurants/:id/status', async (ctx) => {
  const admin = await requirePermission(ctx, 'restaurants.manage');
  const id = Number(ctx.params.id);
  const resto = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!resto) throw notFound('Restaurant introuvable.');
  const status = oneOf(ctx.body, 'status', ['pending', 'approved', 'suspended', 'rejected']);
  const reason = str(ctx.body, 'reason', { required: false, max: 300 });
  if (status === 'rejected' && !reason) throw badRequest('Donne la raison du refus.');
  await store.run('UPDATE restaurants SET status = $1, rejection_reason = $2 WHERE id = $3',
    [status, status === 'rejected' || status === 'suspended' ? reason : '', id]);
  await audit(ctx, admin, 'restaurant_status', 'restaurant', id, { to: status, reason },
    { before: { status: resto.status }, after: { status } });
  return { restaurant: await store.get('SELECT * FROM restaurants WHERE id = $1', [id]) };
});

router.get('/api/admin/restaurants/:id', async (ctx) => {
  await requirePermission(ctx, 'restaurants.view');
  const id = Number(ctx.params.id);
  const restaurant = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!restaurant) throw notFound('Restaurant introuvable.');

  const owner = await store.get(
    'SELECT id, name, email, phone, status, last_login_at, created_at FROM users WHERE id = $1',
    [restaurant.owner_user_id]);

  const categories = await store.all('SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, id', [id]);
  const products = await store.all('SELECT * FROM products WHERE restaurant_id = $1 ORDER BY sort_order, id', [id]);
  const groups = await store.all(
    `SELECT g.* FROM option_groups g JOIN products p ON p.id = g.product_id
     WHERE p.restaurant_id = $1 ORDER BY g.sort_order, g.id`, [id]);
  const options = await store.all(
    `SELECT o.* FROM product_options o JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id WHERE p.restaurant_id = $1 ORDER BY o.sort_order, o.id`, [id]);
  for (const group of groups) group.options = options.filter((o) => Number(o.option_group_id) === Number(group.id));
  for (const product of products) product.option_groups = groups.filter((g) => Number(g.product_id) === Number(product.id));

  const orders = await store.all(
    `SELECT id, order_number, status, fulfillment_type, total_cents, commission_cents, restaurant_net_cents,
            refunded_cents, customer_name, placed_at
     FROM orders WHERE restaurant_id = $1 ORDER BY id DESC LIMIT 40`, [id]);

  const refunds = await store.all(
    `SELECT f.*, o.order_number FROM refunds f JOIN orders o ON o.id = f.order_id
     WHERE o.restaurant_id = $1 ORDER BY f.id DESC LIMIT 40`, [id]);

  const balance = await store.get(
    `SELECT COUNT(*) AS completed_orders,
            COALESCE(SUM(total_cents),0) AS gross_cents,
            COALESCE(SUM(commission_cents),0) AS commission_cents,
            COALESCE(SUM(restaurant_net_cents),0) AS net_cents,
            COALESCE(SUM(refunded_cents),0) AS refunded_cents
     FROM orders WHERE restaurant_id = $1 AND status = 'completed'`, [id]);
  const paid = await store.get(
    `SELECT COALESCE(SUM(net_payable_cents),0) AS paid_cents FROM settlements
     WHERE restaurant_id = $1 AND status = 'paid'`, [id]);

  return {
    restaurant: decorateRestaurant(restaurant),
    preorder: preorderWindow(restaurant),
    owner, categories, products, orders, refunds,
    balance: { ...numbers(balance), settled_cents: Number(paid.paid_cents) },
  };
});

router.put('/api/admin/restaurants/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'restaurants.manage');
  const id = Number(ctx.params.id);
  const resto = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!resto) throw notFound('Restaurant introuvable.');

  const next = {
    name: str(ctx.body, 'name', { required: false, max: 120 }) || resto.name,
    name_ar: ctx.body.name_ar === undefined ? resto.name_ar : str(ctx.body, 'name_ar', { required: false, max: 120 }),
    description: ctx.body.description === undefined ? resto.description : str(ctx.body, 'description', { required: false, max: 600 }),
    description_ar: ctx.body.description_ar === undefined ? resto.description_ar : str(ctx.body, 'description_ar', { required: false, max: 600 }),
    city: ctx.body.city === undefined ? resto.city : str(ctx.body, 'city', { required: false, max: 80 }),
    address: ctx.body.address === undefined ? resto.address : str(ctx.body, 'address', { required: false, max: 200 }),
    phone: ctx.body.phone === undefined ? resto.phone : str(ctx.body, 'phone', { required: false, max: 30 }),
    image_url: ctx.body.image_url === undefined ? resto.image_url : str(ctx.body, 'image_url', { required: false, max: 400 }),
    delivery_fee_cents: int(ctx.body, 'delivery_fee_cents', { required: false, fallback: resto.delivery_fee_cents, max: 100000 }),
    min_order_cents: int(ctx.body, 'min_order_cents', { required: false, fallback: resto.min_order_cents, max: 1000000 }),
    prep_minutes: int(ctx.body, 'prep_minutes', { required: false, fallback: resto.prep_minutes, min: 1, max: 240 }),
    supports_pickup: bool(ctx.body, 'supports_pickup', !!resto.supports_pickup) ? 1 : 0,
    supports_delivery: bool(ctx.body, 'supports_delivery', !!resto.supports_delivery) ? 1 : 0,
    is_open: bool(ctx.body, 'is_open', !!resto.is_open) ? 1 : 0,
  };

  const service = ctx.body.service_type === undefined
    ? {
        service_type: resto.service_type || 'immediate',
        min_prep_hours: Number(resto.min_prep_hours || 0),
        delivery_days: resto.delivery_days || '',
        delivery_slots: resto.delivery_slots || '',
        order_cutoff: resto.order_cutoff || '',
      }
    : readServiceConfig(ctx.body);

  const cuisines = ctx.body.cuisines === undefined
    ? (resto.cuisines || '')
    : serializeCuisines(Array.isArray(ctx.body.cuisines) ? ctx.body.cuisines : parseCuisines(ctx.body.cuisines));

  const ratingBp = ctx.body.rating_bp === undefined
    ? Number(resto.rating_bp || 0)
    : int(ctx.body, 'rating_bp', { required: false, fallback: 0, min: 0, max: 50000 });

  await store.run(
    `UPDATE restaurants SET name=$1, name_ar=$2, description=$3, description_ar=$4, city=$5, address=$6,
      phone=$7, image_url=$8, delivery_fee_cents=$9, min_order_cents=$10, prep_minutes=$11,
      supports_pickup=$12, supports_delivery=$13, is_open=$14, service_type=$15, min_prep_hours=$16,
      delivery_days=$17, delivery_slots=$18, order_cutoff=$19, cuisines=$20, rating_bp=$21 WHERE id=$22`,
    [next.name, next.name_ar, next.description, next.description_ar, next.city, next.address, next.phone,
     next.image_url, next.delivery_fee_cents, next.min_order_cents, next.prep_minutes,
     next.supports_pickup, next.supports_delivery, next.is_open,
     service.service_type, service.min_prep_hours, service.delivery_days, service.delivery_slots,
     service.order_cutoff, cuisines, ratingBp, id]);

  const after = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  await audit(ctx, admin, 'restaurant_edit', 'restaurant', id, {}, { before: resto, after });
  return { restaurant: decorateRestaurant(after) };
});

router.post('/api/admin/restaurants/:id/open', async (ctx) => {
  const admin = await requirePermission(ctx, 'restaurants.manage');
  const id = Number(ctx.params.id);
  const resto = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!resto) throw notFound('Restaurant introuvable.');
  const open = bool(ctx.body, 'is_open', !resto.is_open) ? 1 : 0;
  await store.run('UPDATE restaurants SET is_open = $1 WHERE id = $2', [open, id]);
  await audit(ctx, admin, 'restaurant_open', 'restaurant', id, { is_open: open },
    { before: { is_open: resto.is_open }, after: { is_open: open } });
  return { restaurant: await store.get('SELECT * FROM restaurants WHERE id = $1', [id]) };
});

/* ---- catalog oversight: the admin works on any restaurant's menu ---- */
router.get('/api/admin/catalog', async (ctx) => {
  await requirePermission(ctx, 'restaurants.view');
  const restaurantId = Number(ctx.query.get('restaurant_id') || 0);
  if (!restaurantId) throw badRequest('Choisis un restaurant.');
  const resto = await store.get('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
  if (!resto) throw notFound('Restaurant introuvable.');

  const categories = await store.all(
    'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, id', [restaurantId]);
  const products = await store.all(
    'SELECT * FROM products WHERE restaurant_id = $1 ORDER BY sort_order, id', [restaurantId]);
  const groups = await store.all(
    `SELECT g.* FROM option_groups g JOIN products p ON p.id = g.product_id
     WHERE p.restaurant_id = $1 ORDER BY g.sort_order, g.id`, [restaurantId]);
  const options = await store.all(
    `SELECT o.* FROM product_options o JOIN option_groups g ON g.id = o.option_group_id
     JOIN products p ON p.id = g.product_id WHERE p.restaurant_id = $1 ORDER BY o.sort_order, o.id`, [restaurantId]);
  for (const group of groups) group.options = options.filter((o) => Number(o.option_group_id) === Number(group.id));
  for (const product of products) product.option_groups = groups.filter((g) => Number(g.product_id) === Number(product.id));

  const bestSellers = await store.all(
    `SELECT i.product_id, i.name, COALESCE(SUM(i.quantity),0) AS units,
            COALESCE(SUM(i.line_total_cents),0) AS revenue_cents
     FROM order_items i JOIN orders o ON o.id = i.order_id
     WHERE o.restaurant_id = $1 AND o.status = 'completed'
     GROUP BY i.product_id, i.name ORDER BY units DESC LIMIT 15`, [restaurantId]);

  return {
    restaurant: resto, categories, products,
    best_sellers: bestSellers.map((b) => ({ ...b, units: Number(b.units), revenue_cents: Number(b.revenue_cents) })),
  };
});

async function productOfRestaurant(productId) {
  const product = await store.get('SELECT * FROM products WHERE id = $1', [productId]);
  if (!product) throw notFound('Produit introuvable.');
  return product;
}

router.post('/api/admin/categories', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const restaurantId = int(ctx.body, 'restaurant_id', { min: 1 });
  if (!(await store.get('SELECT id FROM restaurants WHERE id = $1', [restaurantId]))) {
    throw notFound('Restaurant introuvable.');
  }
  const id = await store.insert(
    'INSERT INTO categories (restaurant_id, name, name_ar, sort_order) VALUES ($1,$2,$3,$4)',
    [restaurantId, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  await audit(ctx, admin, 'category_create', 'category', id, { restaurant_id: restaurantId });
  return { category: await store.get('SELECT * FROM categories WHERE id = $1', [id]) };
});

router.post('/api/admin/products', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const restaurantId = int(ctx.body, 'restaurant_id', { min: 1 });
  if (!(await store.get('SELECT id FROM restaurants WHERE id = $1', [restaurantId]))) {
    throw notFound('Restaurant introuvable.');
  }
  let categoryId = null;
  if (ctx.body.category_id) {
    const cat = await store.get('SELECT id FROM categories WHERE id = $1 AND restaurant_id = $2',
      [int(ctx.body, 'category_id', { min: 1 }), restaurantId]);
    if (!cat) throw badRequest('Cette categorie n appartient pas a ce restaurant.');
    categoryId = cat.id;
  }
  const id = await store.insert(
    `INSERT INTO products (restaurant_id, category_id, name, name_ar, description, description_ar,
      price_cents, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [restaurantId, categoryId, str(ctx.body, 'name', { max: 120 }),
     str(ctx.body, 'name_ar', { required: false, max: 120 }),
     str(ctx.body, 'description', { required: false, max: 500 }),
     str(ctx.body, 'description_ar', { required: false, max: 500 }),
     int(ctx.body, 'price_cents', { min: 0, max: 10000000 }),
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 }), nowIso()]);
  await audit(ctx, admin, 'product_create', 'product', id, { restaurant_id: restaurantId });
  return { product: await store.get('SELECT * FROM products WHERE id = $1', [id]) };
});

router.post('/api/admin/option-groups', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const product = await productOfRestaurant(int(ctx.body, 'product_id', { min: 1 }));
  const min = int(ctx.body, 'min_select', { required: false, fallback: 0, max: 20 });
  const max = int(ctx.body, 'max_select', { required: false, fallback: 1, min: 1, max: 20 });
  if (min > max) throw badRequest('Le minimum ne peut pas depasser le maximum.');
  const id = await store.insert(
    'INSERT INTO option_groups (product_id, name, name_ar, min_select, max_select, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
    [product.id, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     min, max, int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  await audit(ctx, admin, 'option_group_create', 'option_group', id, { product_id: product.id });
  return { group: await store.get('SELECT * FROM option_groups WHERE id = $1', [id]) };
});

router.delete('/api/admin/option-groups/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const group = await store.get('SELECT * FROM option_groups WHERE id = $1', [Number(ctx.params.id)]);
  if (!group) throw notFound('Groupe introuvable.');
  await store.run('DELETE FROM option_groups WHERE id = $1', [group.id]);
  await audit(ctx, admin, 'option_group_delete', 'option_group', group.id, {}, { before: group });
  return { deleted: true };
});

router.post('/api/admin/options', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const groupId = int(ctx.body, 'option_group_id', { min: 1 });
  const group = await store.get('SELECT * FROM option_groups WHERE id = $1', [groupId]);
  if (!group) throw notFound('Groupe introuvable.');
  const id = await store.insert(
    `INSERT INTO product_options (option_group_id, name, name_ar, price_delta_cents, is_removal, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [groupId, str(ctx.body, 'name', { max: 80 }), str(ctx.body, 'name_ar', { required: false, max: 80 }),
     isRemoval(ctx.body) ? 0 : int(ctx.body, 'price_delta_cents', { required: false, fallback: 0, max: 1000000 }),
     isRemoval(ctx.body) ? 1 : 0,
     int(ctx.body, 'sort_order', { required: false, fallback: 0, max: 9999 })]);
  await audit(ctx, admin, 'option_create', 'product_option', id, { option_group_id: groupId });
  return { option: await store.get('SELECT * FROM product_options WHERE id = $1', [id]) };
});

router.put('/api/admin/options/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const option = await store.get('SELECT * FROM product_options WHERE id = $1', [Number(ctx.params.id)]);
  if (!option) throw notFound('Option introuvable.');
  const removal = ctx.body.is_removal === undefined
    ? !!option.is_removal
    : isRemoval(ctx.body);
  await store.run(
    `UPDATE product_options SET name=$1, name_ar=$2, price_delta_cents=$3, is_available=$4, is_removal=$5
     WHERE id=$6`,
    [str(ctx.body, 'name', { required: false, max: 80 }) || option.name,
     ctx.body.name_ar === undefined ? option.name_ar : str(ctx.body, 'name_ar', { required: false, max: 80 }),
     removal ? 0 : int(ctx.body, 'price_delta_cents', { required: false, fallback: option.price_delta_cents, max: 1000000 }),
     bool(ctx.body, 'is_available', !!option.is_available) ? 1 : 0,
     removal ? 1 : 0, option.id]);
  const after = await store.get('SELECT * FROM product_options WHERE id = $1', [option.id]);
  await audit(ctx, admin, 'option_edit', 'product_option', option.id, {}, { before: option, after });
  return { option: after };
});

router.delete('/api/admin/options/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const option = await store.get('SELECT * FROM product_options WHERE id = $1', [Number(ctx.params.id)]);
  if (!option) throw notFound('Option introuvable.');
  await store.run('DELETE FROM product_options WHERE id = $1', [option.id]);
  await audit(ctx, admin, 'option_delete', 'product_option', option.id, {}, { before: option });
  return { deleted: true };
});

/** Admin can edit any product on any menu (availability, price, wording, order). */
router.put('/api/admin/products/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'catalog.manage');
  const id = Number(ctx.params.id);
  const product = await store.get('SELECT * FROM products WHERE id = $1', [id]);
  if (!product) throw notFound('Produit introuvable.');

  let categoryId = product.category_id;
  if (ctx.body.category_id !== undefined) {
    if (ctx.body.category_id) {
      const cat = await store.get('SELECT id FROM categories WHERE id = $1 AND restaurant_id = $2',
        [int(ctx.body, 'category_id', { min: 1 }), product.restaurant_id]);
      if (!cat) throw badRequest('Cette categorie n appartient pas a ce restaurant.');
      categoryId = cat.id;
    } else categoryId = null;
  }

  await store.run(
    `UPDATE products SET name=$1, name_ar=$2, description=$3, description_ar=$4, price_cents=$5,
      image_url=$6, is_active=$7, sort_order=$8, category_id=$9 WHERE id=$10`,
    [str(ctx.body, 'name', { required: false, max: 120 }) || product.name,
     ctx.body.name_ar === undefined ? product.name_ar : str(ctx.body, 'name_ar', { required: false, max: 120 }),
     ctx.body.description === undefined ? product.description : str(ctx.body, 'description', { required: false, max: 500 }),
     ctx.body.description_ar === undefined ? product.description_ar : str(ctx.body, 'description_ar', { required: false, max: 500 }),
     int(ctx.body, 'price_cents', { required: false, fallback: product.price_cents, max: 10000000 }),
     ctx.body.image_url === undefined ? product.image_url : str(ctx.body, 'image_url', { required: false, max: 400 }),
     bool(ctx.body, 'is_active', !!product.is_active) ? 1 : 0,
     int(ctx.body, 'sort_order', { required: false, fallback: product.sort_order, max: 9999 }),
     categoryId, id]);

  const after = await store.get('SELECT * FROM products WHERE id = $1', [id]);
  await audit(ctx, admin, 'product_edit', 'product', id, { restaurant_id: product.restaurant_id },
    { before: product, after });
  return { product: after };
});

router.post('/api/admin/restaurants/:id/commission', async (ctx) => {
  const admin = await requirePermission(ctx, 'restaurants.commission');
  const id = Number(ctx.params.id);
  const resto = await store.get('SELECT * FROM restaurants WHERE id = $1', [id]);
  if (!resto) throw notFound('Restaurant introuvable.');
  const bp = int(ctx.body, 'commission_rate_bp', { min: 0, max: 10000 });
  await store.run('UPDATE restaurants SET commission_rate_bp = $1 WHERE id = $2', [bp, id]);
  await audit(ctx, admin, 'commission_change', 'restaurant', id, { from_bp: resto.commission_rate_bp, to_bp: bp });
  return { restaurant: await store.get('SELECT * FROM restaurants WHERE id = $1', [id]) };
});

router.post('/api/admin/orders/:id/refund', async (ctx) => {
  const admin = await requirePermission(ctx, 'refunds.create');
  return idempotent(ctx, 'refund', async () => {
  const order = await loadOrder(Number(ctx.params.id));
  if (order.status !== 'completed') throw conflict('Seule une commande terminee peut etre remboursee.');
  const amount = int(ctx.body, 'amount_cents', { min: 1, max: 100000000 });
  const already = Number(order.refunded_cents);
  const maximum = Number(order.total_cents) - already;
  if (amount > maximum) throw conflict(`Remboursement maximum: ${(maximum / 100).toFixed(2)} MAD.`);
  const reason = str(ctx.body, 'reason', { required: false, max: 300 });

  // The refund eats into the food first, then into the delivery fee.
  const refundedTotal = already + amount;
  const subtotal = Number(order.items_subtotal_cents);
  const discount = Number(order.discount_cents || 0);
  // A restaurant-funded discount has already come off the restaurant's share.
  const ownDiscount = order.discount_funded_by === 'restaurant' ? discount : 0;
  const foodDiscount = Math.min(ownDiscount, subtotal);
  const feeDiscount = ownDiscount - foodDiscount;
  const foodRefunded = Math.min(refundedTotal, subtotal);
  const feeRefunded = refundedTotal - foodRefunded;
  const remainingFood = Math.max(0, subtotal - foodDiscount - foodRefunded);
  const remainingFee = Math.max(0, Number(order.delivery_fee_cents) - feeDiscount - feeRefunded);
  const commission = Math.round((remainingFood * Number(order.commission_rate_bp)) / 10000);
  const restaurantNet = remainingFood - commission + remainingFee;

  await store.tx(async (t) => {
    await t.run('INSERT INTO refunds (order_id, amount_cents, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5)',
      [order.id, amount, reason, admin.id, nowIso()]);
    await t.run(
      'UPDATE orders SET refunded_cents = $1, commission_cents = $2, restaurant_net_cents = $3, updated_at = $4 WHERE id = $5',
      [refundedTotal, commission, restaurantNet, nowIso(), order.id]);
  });
  log.info('refund.created', {
    order_id: order.id, order_number: order.order_number, amount_cents: amount,
    refunded_total_cents: refundedTotal, admin_id: admin.id, ip: ctx.ip,
  });
  await audit(ctx, admin, 'refund', 'order', order.id, { amount_cents: amount, reason },
    { before: { refunded_cents: already, commission_cents: order.commission_cents },
      after: { refunded_cents: refundedTotal, commission_cents: commission } });
  return { order: await loadOrder(order.id) };
  });
});

router.post('/api/admin/users/:id/reset-password', async (ctx) => {
  const admin = await requirePermission(ctx, 'customers.manage');
  const id = Number(ctx.params.id);
  const user = await store.get('SELECT id, email FROM users WHERE id = $1', [id]);
  if (!user) throw notFound('Utilisateur introuvable.');
  // A readable temporary password the admin passes on by phone; old sessions die immediately.
  const temporary = `${crypto.randomBytes(5).toString('hex')}A1`;
  const tempHash = await hashPassword(temporary);
  await store.run('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [tempHash, id]);
  await audit(ctx, admin, 'password_reset', 'user', id);
  return { temporary_password: temporary, email: user.email };
});

/* ---- promo codes ---- */
router.get('/api/admin/promotions', async (ctx) => {
  await requirePermission(ctx, 'promotions.manage');
  const promotions = await store.all(
    `SELECT p.*, r.name AS restaurant_name,
            (SELECT COUNT(*) FROM promotion_uses u WHERE u.promotion_id = p.id) AS times_used,
            (SELECT COALESCE(SUM(u.discount_cents),0) FROM promotion_uses u WHERE u.promotion_id = p.id) AS total_given_cents
     FROM promotions p LEFT JOIN restaurants r ON r.id = p.restaurant_id
     ORDER BY p.is_active DESC, p.id DESC`);
  return { promotions: promotions.map((p) => ({ ...p, times_used: Number(p.times_used), total_given_cents: Number(p.total_given_cents) })) };
});

router.post('/api/admin/promotions', async (ctx) => {
  const admin = await requirePermission(ctx, 'promotions.manage');
  const code = str(ctx.body, 'code', { max: 40 }).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw badRequest('Le code doit faire 3 a 40 caracteres (lettres, chiffres, - ou _).');
  if (await store.get('SELECT id FROM promotions WHERE lower(code) = lower($1)', [code])) {
    throw conflict('Ce code existe deja.');
  }
  const type = oneOf(ctx.body, 'discount_type', ['percent', 'fixed', 'free_delivery']);
  const value = int(ctx.body, 'discount_value', { required: type !== 'free_delivery', fallback: 0, max: 10000000 });
  if (type === 'percent' && (value < 1 || value > 100)) throw badRequest('Le pourcentage doit etre entre 1 et 100.');
  if (type === 'fixed' && value < 1) throw badRequest('Le montant doit etre superieur a zero.');

  let restaurantId = ctx.body.restaurant_id ? int(ctx.body, 'restaurant_id', { min: 1 }) : null;
  if (restaurantId && !(await store.get('SELECT id FROM restaurants WHERE id = $1', [restaurantId]))) {
    throw notFound('Restaurant introuvable.');
  }

  const id = await store.insert(
    `INSERT INTO promotions (code, description, description_ar, restaurant_id, discount_type, discount_value,
      max_discount_cents, min_order_cents, funded_by, starts_at, ends_at, usage_limit, per_customer_limit,
      created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [code,
     str(ctx.body, 'description', { required: false, max: 200 }),
     str(ctx.body, 'description_ar', { required: false, max: 200 }),
     restaurantId, type, value,
     int(ctx.body, 'max_discount_cents', { required: false, fallback: 0, max: 10000000 }),
     int(ctx.body, 'min_order_cents', { required: false, fallback: 0, max: 10000000 }),
     oneOf(ctx.body, 'funded_by', ['platform', 'restaurant'], { required: false, fallback: 'platform' }),
     str(ctx.body, 'starts_at', { required: false, max: 40 }),
     str(ctx.body, 'ends_at', { required: false, max: 40 }),
     int(ctx.body, 'usage_limit', { required: false, fallback: 0, max: 1000000 }),
     int(ctx.body, 'per_customer_limit', { required: false, fallback: 1, max: 1000 }),
     admin.id, nowIso()]);

  await audit(ctx, admin, 'promotion_create', 'promotion', id, { code, type, value });
  return { promotion: await store.get('SELECT * FROM promotions WHERE id = $1', [id]) };
});

router.post('/api/admin/promotions/:id/toggle', async (ctx) => {
  const admin = await requirePermission(ctx, 'promotions.manage');
  const promo = await store.get('SELECT * FROM promotions WHERE id = $1', [Number(ctx.params.id)]);
  if (!promo) throw notFound('Code promo introuvable.');
  const next = promo.is_active ? 0 : 1;
  await store.run('UPDATE promotions SET is_active = $1 WHERE id = $2', [next, promo.id]);
  await audit(ctx, admin, 'promotion_toggle', 'promotion', promo.id, { code: promo.code, active: next });
  return { promotion: await store.get('SELECT * FROM promotions WHERE id = $1', [promo.id]) };
});

router.delete('/api/admin/promotions/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'promotions.manage');
  const promo = await store.get('SELECT * FROM promotions WHERE id = $1', [Number(ctx.params.id)]);
  if (!promo) throw notFound('Code promo introuvable.');
  const used = await store.get('SELECT COUNT(*) AS c FROM promotion_uses WHERE promotion_id = $1', [promo.id]);
  if (Number(used.c) > 0) {
    // Keep it for the order history; switch it off instead.
    await store.run('UPDATE promotions SET is_active = 0 WHERE id = $1', [promo.id]);
    await audit(ctx, admin, 'promotion_disable', 'promotion', promo.id, { code: promo.code });
    return { deleted: false, deactivated: true };
  }
  await store.run('DELETE FROM promotions WHERE id = $1', [promo.id]);
  await audit(ctx, admin, 'promotion_delete', 'promotion', promo.id, { code: promo.code });
  return { deleted: true };
});

/* ---- support messages ---- */
router.post('/api/support', async (ctx) => {
  const user = ctx.user ? await requireUser(ctx) : null;
  const name = str(ctx.body, 'name', { required: !user, max: 120 }) || user?.name || '';
  const phone = validPhone(str(ctx.body, 'phone', { required: !user?.phone, max: 30 }) || user?.phone);
  const message = str(ctx.body, 'message', { max: 2000, min: 5 });
  const id = await store.insert(
    `INSERT INTO support_messages (user_id, name, phone, email, order_number, subject, message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [user?.id ?? null, name, phone,
     str(ctx.body, 'email', { required: false, max: 200 }) || user?.email || '',
     str(ctx.body, 'order_number', { required: false, max: 40 }),
     str(ctx.body, 'subject', { required: false, max: 120 }),
     message, nowIso()]);
  return { sent: true, id };
});

router.get('/api/admin/support', async (ctx) => {
  await requirePermission(ctx, 'support.manage');
  const status = ctx.query.get('status');
  let sql = 'SELECT * FROM support_messages';
  const args = [];
  if (status) { args.push(status); sql += ` WHERE status = $${args.length}`; }
  sql += " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC LIMIT 200";
  const messages = await store.all(sql, args);
  const open = await store.get("SELECT COUNT(*) AS c FROM support_messages WHERE status = 'open'");
  return { messages, open_count: Number(open.c) };
});

router.post('/api/admin/support/:id/handled', async (ctx) => {
  const admin = await requirePermission(ctx, 'support.manage');
  const row = await store.get('SELECT * FROM support_messages WHERE id = $1', [Number(ctx.params.id)]);
  if (!row) throw notFound('Message introuvable.');
  const next = row.status === 'open' ? 'handled' : 'open';
  await store.run('UPDATE support_messages SET status = $1, handled_by = $2, handled_at = $3 WHERE id = $4',
    [next, admin.id, next === 'handled' ? nowIso() : null, row.id]);
  return { message: await store.get('SELECT * FROM support_messages WHERE id = $1', [row.id]) };
});

/* ---- users ---- */
router.get('/api/admin/users', async (ctx) => {
  await requirePermission(ctx, 'customers.view');
  const search = (ctx.query.get('q') || '').trim();
  const role = ctx.query.get('role');
  let sql = `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.locale, u.created_at,
                    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id) AS orders_count,
                    (SELECT COALESCE(SUM(o.total_cents),0) FROM orders o
                       WHERE o.customer_id = u.id AND o.status = 'completed') AS spent_cents,
                    (SELECT r.name FROM restaurants r WHERE r.owner_user_id = u.id) AS restaurant_name
             FROM users u`;
  const args = [];
  const where = [];
  if (search) {
    args.push(`%${search}%`);
    where.push(`(u.name LIKE $${args.length} OR u.email LIKE $${args.length} OR u.phone LIKE $${args.length})`);
  }
  if (role) { args.push(role); where.push(`u.role = $${args.length}`); }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY u.id DESC LIMIT ${wantsCsv(ctx) ? 5000 : 300}`;

  const users = await store.all(sql, args);
  if (wantsCsv(ctx)) return sendCsv(ctx, 'comptes', pickColumns(users, USERS_CSV), USERS_CSV);
  const counts = await store.get(
    `SELECT (SELECT COUNT(*) FROM users WHERE role = 'customer')   AS customers,
            (SELECT COUNT(*) FROM users WHERE role = 'restaurant') AS restaurants,
            (SELECT COUNT(*) FROM users WHERE role = 'admin')      AS admins,
            (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS suspended`);
  return {
    users: users.map((u) => ({ ...u, orders_count: Number(u.orders_count), spent_cents: Number(u.spent_cents) })),
    counts: numbers(counts),
  };
});

router.get('/api/admin/customers/:id', async (ctx) => {
  await requirePermission(ctx, 'customers.view');
  const id = Number(ctx.params.id);
  const user = await store.get(
    `SELECT id, name, email, phone, role, status, locale, created_at, last_login_at
     FROM users WHERE id = $1`, [id]);
  if (!user) throw notFound('Utilisateur introuvable.');

  const stats = await store.get(
    `SELECT COUNT(*) AS orders_count,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN total_cents ELSE 0 END),0) AS spent_cents,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),0) AS cancelled_count,
            COALESCE(SUM(refunded_cents),0) AS refunded_cents,
            MAX(placed_at) AS last_order_at
     FROM orders WHERE customer_id = $1`, [id]);

  const orders = await store.all(
    `SELECT o.id, o.order_number, o.status, o.fulfillment_type, o.total_cents, o.refunded_cents,
            o.placed_at, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.customer_id = $1 ORDER BY o.id DESC LIMIT 50`, [id]);

  const refunds = await store.all(
    `SELECT f.*, o.order_number FROM refunds f JOIN orders o ON o.id = f.order_id
     WHERE o.customer_id = $1 ORDER BY f.id DESC LIMIT 50`, [id]);

  const messages = await store.all(
    'SELECT id, subject, message, status, created_at FROM support_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 20',
    [id]);

  return {
    user,
    stats: { ...numbers({ ...stats, last_order_at: 0 }), last_order_at: stats.last_order_at || null },
    orders, refunds, messages,
  };
});

router.post('/api/admin/users/:id/status', async (ctx) => {
  const admin = await requirePermission(ctx, 'customers.manage');
  const id = Number(ctx.params.id);
  const user = await store.get('SELECT * FROM users WHERE id = $1', [id]);
  if (!user) throw notFound('Utilisateur introuvable.');
  if (Number(user.id) === Number(admin.id)) throw conflict('Tu ne peux pas suspendre ton propre compte.');
  if (user.role === 'admin') throw forbidden('Un compte administrateur ne peut pas etre suspendu ici.');

  const status = oneOf(ctx.body, 'status', ['active', 'suspended']);
  // Suspending also kills any session the user already has open.
  await store.run('UPDATE users SET status = $1, token_version = token_version + 1 WHERE id = $2', [status, id]);
  await audit(ctx, admin, 'user_status', 'user', id, { from: user.status, to: status });
  return { user: publicUser(await store.get('SELECT * FROM users WHERE id = $1', [id])) };
});

/* ---- refunds ---- */
router.get('/api/admin/refunds', async (ctx) => {
  await requirePermission(ctx, 'refunds.view');
  const refunds = await store.all(
    `SELECT f.*, o.order_number, o.total_cents, o.customer_name, o.customer_phone,
            r.name AS restaurant_name, r.name_ar AS restaurant_name_ar, u.email AS by_email, u.name AS by_name
     FROM refunds f
     JOIN orders o ON o.id = f.order_id
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN users u ON u.id = f.created_by
     ORDER BY f.id DESC LIMIT 200`);
  const total = await store.get('SELECT COALESCE(SUM(amount_cents),0) AS total FROM refunds');
  return { refunds, total_cents: Number(total.total) };
});

/* ------------------------------------------------------------------ *
 * Cash reconciliation and settlements
 * ------------------------------------------------------------------ */
async function codDay(id) {
  const row = await store.get(
    `SELECT c.*, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar
     FROM cod_days c JOIN restaurants r ON r.id = c.restaurant_id WHERE c.id = $1`, [id]);
  if (!row) throw notFound('Journee introuvable.');
  return row;
}

router.get('/api/admin/cod', async (ctx) => {
  await requirePermission(ctx, 'cod.manage');
  await refreshCodDays(30);
  const restaurantId = ctx.query.get('restaurant_id') || '';
  const status = ctx.query.get('status') || '';
  const from = ctx.query.get('from') || '';
  const to = ctx.query.get('to') || '';

  const where = [];
  const args = [];
  if (restaurantId) { args.push(Number(restaurantId)); where.push(`c.restaurant_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`c.status = $${args.length}`); }
  if (from) { args.push(from); where.push(`c.day >= $${args.length}`); }
  if (to) { args.push(to); where.push(`c.day <= $${args.length}`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const days = await store.all(
    `SELECT c.*, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar
     FROM cod_days c JOIN restaurants r ON r.id = c.restaurant_id${clause}
     ORDER BY c.day DESC, r.name LIMIT ${wantsCsv(ctx) ? 5000 : 300}`, args);
  if (wantsCsv(ctx)) return sendCsv(ctx, 'caisse', pickColumns(days, COD_CSV), COD_CSV);
  const totals = await store.get(
    `SELECT COALESCE(SUM(c.expected_cents),0) AS expected_cents,
            COALESCE(SUM(c.declared_cents),0) AS declared_cents,
            COALESCE(SUM(c.received_cents),0) AS received_cents,
            COALESCE(SUM(c.gross_cents),0) AS gross_cents
     FROM cod_days c${clause}`, args);
  return { days, totals: numbers(totals), summary: await codSummary() };
});

router.post('/api/admin/cod/:id/received', async (ctx) => {
  const admin = await requirePermission(ctx, 'cod.manage');
  return idempotent(ctx, 'cod_received', async () => {
    const day = await codDay(Number(ctx.params.id));
    const amount = int(ctx.body, 'amount_cents', { min: 0, max: 1000000000 });
    const note = str(ctx.body, 'note', { required: false, max: 300 });
    const difference = amount - Number(day.expected_cents);
    await store.tx(async (tx) => {
      await tx.run(
        `UPDATE cod_days SET received_cents = $1, difference_cents = $2, status = 'received',
           note = $3, received_at = $4, updated_at = $4 WHERE id = $5`,
        [amount, difference, note || day.note, nowIso(), day.id]);
    });
    await audit(ctx, admin, 'cod_received', 'cod_day', day.id,
      { amount_cents: amount, difference_cents: difference },
      { before: { status: day.status, received_cents: day.received_cents },
        after: { status: 'received', received_cents: amount } });
    return { day: await codDay(day.id) };
  });
});

router.post('/api/admin/cod/:id/reconcile', async (ctx) => {
  const admin = await requirePermission(ctx, 'cod.manage');
  const day = await codDay(Number(ctx.params.id));
  if (day.status !== 'received' && day.status !== 'disputed') {
    throw conflict('Enregistre d abord l argent recu pour cette journee.');
  }
  const note = str(ctx.body, 'note', { required: false, max: 300 });
  await store.run(
    `UPDATE cod_days SET status = 'reconciled', note = $1, reconciled_by = $2, reconciled_at = $3, updated_at = $3
     WHERE id = $4`, [note || day.note, admin.id, nowIso(), day.id]);
  await audit(ctx, admin, 'cod_reconciled', 'cod_day', day.id, { note },
    { before: { status: day.status }, after: { status: 'reconciled' } });
  return { day: await codDay(day.id) };
});

router.post('/api/admin/cod/:id/dispute', async (ctx) => {
  const admin = await requirePermission(ctx, 'cod.manage');
  const day = await codDay(Number(ctx.params.id));
  const note = str(ctx.body, 'note', { max: 300, min: 3 });
  await store.run("UPDATE cod_days SET status = 'disputed', note = $1, updated_at = $2 WHERE id = $3",
    [note, nowIso(), day.id]);
  await audit(ctx, admin, 'cod_disputed', 'cod_day', day.id, { note },
    { before: { status: day.status }, after: { status: 'disputed' } });
  return { day: await codDay(day.id) };
});

/* ---- the restaurant declares what it collected ---- */
router.get('/api/restaurant/cod', async (ctx) => {
  const { resto } = await myRestaurant(ctx);
  await refreshCodDays(30, resto.id);
  const days = await store.all(
    'SELECT * FROM cod_days WHERE restaurant_id = $1 ORDER BY day DESC LIMIT 60', [resto.id]);
  const owed = await store.get(
    `SELECT COALESCE(SUM(expected_cents - received_cents),0) AS owed_cents FROM cod_days
     WHERE restaurant_id = $1 AND status <> 'reconciled'`, [resto.id]);
  return { days, owed_cents: Number(owed.owed_cents) };
});

router.post('/api/restaurant/cod/declare', async (ctx) => {
  const { user, resto } = await myRestaurant(ctx);
  const day = str(ctx.body, 'day', { max: 10, min: 10 });
  const amount = int(ctx.body, 'amount_cents', { min: 0, max: 1000000000 });
  await refreshCodDays(30, resto.id);
  const row = await store.get('SELECT * FROM cod_days WHERE restaurant_id = $1 AND day = $2', [resto.id, day]);
  if (!row) throw notFound('Aucune journee a declarer pour cette date.');
  if (row.status === 'reconciled') throw conflict('Cette journee est deja rapprochee.');
  await store.run(
    `UPDATE cod_days SET declared_cents = $1, status = CASE WHEN status = 'open' THEN 'declared' ELSE status END,
       declared_at = $2, updated_at = $2 WHERE id = $3`, [amount, nowIso(), row.id]);
  await audit(ctx, user, 'cod_declared', 'cod_day', row.id, { day, amount_cents: amount });
  return { day: await store.get('SELECT * FROM cod_days WHERE id = $1', [row.id]) };
});

/* ---- settlements ---- */
router.get('/api/admin/settlements', async (ctx) => {
  await requirePermission(ctx, 'settlements.manage');
  const restaurantId = ctx.query.get('restaurant_id') || '';
  const args = [];
  let clause = '';
  if (restaurantId) { args.push(Number(restaurantId)); clause = ` WHERE s.restaurant_id = $${args.length}`; }
  const settlements = await store.all(
    `SELECT s.*, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar, u.name AS created_by_name
     FROM settlements s JOIN restaurants r ON r.id = s.restaurant_id
     LEFT JOIN users u ON u.id = s.created_by${clause} ORDER BY s.id DESC LIMIT ${wantsCsv(ctx) ? 5000 : 200}`, args);
  if (wantsCsv(ctx)) return sendCsv(ctx, 'reglements', pickColumns(settlements, SETTLEMENT_CSV), SETTLEMENT_CSV);
  const totals = await store.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN net_payable_cents ELSE 0 END),0) AS paid_cents,
            COALESCE(SUM(CASE WHEN status <> 'paid' THEN net_payable_cents ELSE 0 END),0) AS open_cents
     FROM settlements s${clause}`, args);
  return { settlements, totals: numbers(totals) };
});

/** Builds the figures for a period without saving anything. */
async function settlementFigures(restaurantId, periodStart, periodEnd) {
  const from = `${periodStart}T00:00:00.000Z`;
  const to = `${periodEnd}T23:59:59.999Z`;
  const base = await store.get(
    `SELECT COUNT(*) AS orders_count,
            COALESCE(SUM(total_cents),0) AS gross_cents,
            COALESCE(SUM(commission_cents),0) AS commission_cents,
            COALESCE(SUM(refunded_cents),0) AS refunds_cents
     FROM orders WHERE restaurant_id = $1 AND status = 'completed'
       AND placed_at >= $2 AND placed_at <= $3`, [restaurantId, from, to]);
  return numbers(base);
}

router.get('/api/admin/settlements/preview', async (ctx) => {
  await requirePermission(ctx, 'settlements.manage');
  const restaurantId = int({ v: ctx.query.get('restaurant_id') }, 'v', { min: 1 });
  const periodStart = str({ v: ctx.query.get('from') }, 'v', { max: 10, min: 10 });
  const periodEnd = str({ v: ctx.query.get('to') }, 'v', { max: 10, min: 10 });
  const figures = await settlementFigures(restaurantId, periodStart, periodEnd);
  return { ...figures, net_payable_cents: figures.commission_cents };
});

router.post('/api/admin/settlements', async (ctx) => {
  const admin = await requirePermission(ctx, 'settlements.manage');
  return idempotent(ctx, 'settlement_create', async () => {
    const restaurantId = int(ctx.body, 'restaurant_id', { min: 1 });
    const periodStart = str(ctx.body, 'period_start', { max: 10, min: 10 });
    const periodEnd = str(ctx.body, 'period_end', { max: 10, min: 10 });
    if (periodEnd < periodStart) throw badRequest('La fin de periode precede le debut.');
    const resto = await store.get('SELECT id FROM restaurants WHERE id = $1', [restaurantId]);
    if (!resto) throw notFound('Restaurant introuvable.');

    const adjustments = int(ctx.body, 'adjustments_cents', { required: false, fallback: 0, min: -100000000, max: 100000000 });
    const figures = await settlementFigures(restaurantId, periodStart, periodEnd);
    // What the restaurant must hand over: our commission, less any adjustment in its favour.
    const netPayable = figures.commission_cents - adjustments;

    const id = await store.tx(async (tx) => tx.insert(
      `INSERT INTO settlements (restaurant_id, period_start, period_end, orders_count, gross_cents,
        commission_cents, refunds_cents, adjustments_cents, net_payable_cents, note, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [restaurantId, periodStart, periodEnd, figures.orders_count, figures.gross_cents,
       figures.commission_cents, figures.refunds_cents, adjustments, netPayable,
       str(ctx.body, 'note', { required: false, max: 300 }), admin.id, nowIso()]));

    await audit(ctx, admin, 'settlement_create', 'settlement', id,
      { restaurant_id: restaurantId, period_start: periodStart, period_end: periodEnd, net_payable_cents: netPayable });
    return { settlement: await store.get('SELECT * FROM settlements WHERE id = $1', [id]) };
  });
});

router.post('/api/admin/settlements/:id/status', async (ctx) => {
  const admin = await requirePermission(ctx, 'settlements.manage');
  return idempotent(ctx, 'settlement_status', async () => {
    const id = Number(ctx.params.id);
    const settlement = await store.get('SELECT * FROM settlements WHERE id = $1', [id]);
    if (!settlement) throw notFound('Reglement introuvable.');
    const status = oneOf(ctx.body, 'status', ['draft', 'approved', 'paid', 'cancelled']);
    if (settlement.status === 'paid' && status !== 'cancelled') {
      throw conflict('Ce reglement est deja marque paye.');
    }
    await store.tx(async (tx) => {
      await tx.run('UPDATE settlements SET status = $1, paid_at = $2, note = $3 WHERE id = $4',
        [status, status === 'paid' ? nowIso() : null,
         str(ctx.body, 'note', { required: false, max: 300 }) || settlement.note, id]);
    });
    await audit(ctx, admin, 'settlement_status', 'settlement', id, { to: status },
      { before: { status: settlement.status }, after: { status } });
    return { settlement: await store.get('SELECT * FROM settlements WHERE id = $1', [id]) };
  });
});

/* ---- staff and permissions ---- */
router.get('/api/admin/staff', async (ctx) => {
  await requirePermission(ctx, 'staff.manage');
  const staff = await store.all(
    `SELECT u.id, u.name, u.email, u.phone, u.status, u.admin_role, u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.actor_user_id = u.id) AS actions_count
     FROM users u WHERE u.role = 'admin' ORDER BY u.id`);
  return {
    staff: staff.map((u) => ({ ...u, admin_role: u.admin_role || 'super_admin', actions_count: Number(u.actions_count) })),
    roles: ADMIN_ROLES,
  };
});

router.get('/api/admin/staff/:id/actions', async (ctx) => {
  await requirePermission(ctx, 'staff.manage');
  const actions = await store.all(
    `SELECT id, action, resource_type, resource_id, created_at, details
     FROM audit_logs WHERE actor_user_id = $1 ORDER BY id DESC LIMIT 50`, [Number(ctx.params.id)]);
  return { actions };
});

router.post('/api/admin/staff', async (ctx) => {
  const admin = await requirePermission(ctx, 'staff.manage');
  const role = oneOf(ctx.body, 'admin_role', ADMIN_ROLES);
  // Only a super admin may mint another super admin.
  if (role === 'super_admin' && adminRoleOf(admin) !== 'super_admin') {
    throw forbidden('Seul un super admin peut creer un super admin.');
  }
  const name = str(ctx.body, 'name', { max: 120, min: 2 });
  const phone = validPhone(str(ctx.body, 'phone', { max: 30 }));
  const mail = (ctx.body.email === undefined || String(ctx.body.email).trim() === '') ? '' : email(ctx.body);
  const password = str(ctx.body, 'password', { max: 200, min: 8 });

  if (await store.get('SELECT id FROM users WHERE phone = $1', [phone])) {
    throw conflict('Ce numero de telephone a deja un compte.');
  }
  if (mail && await store.get('SELECT id FROM users WHERE email = $1', [mail])) {
    throw conflict('Cette adresse email est deja utilisee.');
  }

  const staffHash = await hashPassword(password);
  const id = await store.insert(
    `INSERT INTO users (name, email, phone, password_hash, role, admin_role, created_at)
     VALUES ($1,$2,$3,$4,'admin',$5,$6)`,
    [name, mail, phone, staffHash, role, nowIso()]);
  await audit(ctx, admin, 'staff_create', 'user', id, { admin_role: role });
  return { staff: await store.get(
    'SELECT id, name, email, phone, status, admin_role, created_at FROM users WHERE id = $1', [id]) };
});

router.put('/api/admin/staff/:id', async (ctx) => {
  const admin = await requirePermission(ctx, 'staff.manage');
  const id = Number(ctx.params.id);
  const target = await store.get('SELECT * FROM users WHERE id = $1', [id]);
  if (!target || target.role !== 'admin') throw notFound('Membre d equipe introuvable.');

  const actorRole = adminRoleOf(admin);
  const targetRole = target.admin_role || 'super_admin';
  if (targetRole === 'super_admin' && actorRole !== 'super_admin') {
    throw forbidden('Seul un super admin peut modifier un super admin.');
  }

  const nextRole = ctx.body.admin_role === undefined ? targetRole : oneOf(ctx.body, 'admin_role', ADMIN_ROLES);
  if (nextRole === 'super_admin' && actorRole !== 'super_admin') {
    throw forbidden('Seul un super admin peut nommer un super admin.');
  }
  const nextStatus = ctx.body.status === undefined ? target.status : oneOf(ctx.body, 'status', ['active', 'suspended']);
  if (Number(target.id) === Number(admin.id)) {
    if (nextStatus !== 'active') throw conflict('Tu ne peux pas desactiver ton propre compte.');
    if (nextRole !== actorRole) throw conflict('Tu ne peux pas changer ton propre role.');
  }
  // The last active super admin must stay standing.
  if (targetRole === 'super_admin' && (nextRole !== 'super_admin' || nextStatus !== 'active')) {
    const others = await store.get(
      `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'
         AND (admin_role = 'super_admin' OR admin_role = '') AND id <> $1`, [id]);
    if (Number(others.c) === 0) throw conflict('Il doit rester au moins un super admin actif.');
  }

  const bumpSessions = nextStatus !== target.status || nextRole !== targetRole;
  await store.run(
    `UPDATE users SET admin_role = $1, status = $2, token_version = token_version + $3 WHERE id = $4`,
    [nextRole, nextStatus, bumpSessions ? 1 : 0, id]);
  await audit(ctx, admin, 'staff_update', 'user', id, {},
    { before: { admin_role: targetRole, status: target.status }, after: { admin_role: nextRole, status: nextStatus } });
  return { staff: await store.get(
    'SELECT id, name, email, phone, status, admin_role, last_login_at FROM users WHERE id = $1', [id]) };
});

/* ------------------------------------------------------------------ *
 * CSV exports — same query parameters as the screen, same permissions
 * ------------------------------------------------------------------ */
const wantsCsv = (ctx) => ctx.query.get('format') === 'csv';

function sendCsv(ctx, name, rows, headers) {
  const csv = toCsv(rows, headers);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  });
  ctx.res.end(`\ufeff${csv}`);
}

const ORDER_CSV = ['order_number', 'placed_at', 'restaurant_name', 'customer_name', 'customer_phone',
  'fulfillment_type', 'status', 'items_subtotal_cents', 'delivery_fee_cents', 'discount_cents',
  'promo_code', 'total_cents', 'commission_cents', 'restaurant_net_cents', 'refunded_cents',
  // The frozen address, so a delivery sheet can be printed from the export.
  'addr_recipient_name', 'addr_recipient_phone', 'addr_street', 'addr_building', 'addr_floor',
  'addr_landmark', 'addr_city', 'addr_lat', 'addr_lng'];
const COD_CSV = ['day', 'restaurant_name', 'orders_count', 'gross_cents', 'expected_cents',
  'declared_cents', 'received_cents', 'difference_cents', 'status', 'note'];
const AUDIT_CSV = ['created_at', 'actor_name', 'actor_email', 'actor_role', 'action', 'resource_type',
  'resource_id', 'ip', 'user_agent', 'details', 'before_state', 'after_state'];
const USERS_CSV = ['id', 'name', 'phone', 'email', 'role', 'status', 'orders_count', 'spent_cents',
  'restaurant_name', 'created_at'];
const SETTLEMENT_CSV = ['id', 'restaurant_name', 'period_start', 'period_end', 'orders_count',
  'gross_cents', 'commission_cents', 'refunds_cents', 'adjustments_cents', 'net_payable_cents',
  'status', 'paid_at'];

const pickColumns = (rows, columns) =>
  rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? ''])));

/* ---- reports ---- */
const REPORTS = {
  summary: summaryReport,
  restaurants: byRestaurantReport,
  products: byProductReport,
  customers: customersReport,
  cod: codReport,
};

router.get('/api/admin/reports', async (ctx) => {
  await requirePermission(ctx, 'reports.view');
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = (ctx.query.get('from') || monthStart).slice(0, 10);
  const to = (ctx.query.get('to') || today).slice(0, 10);
  if (to < from) throw badRequest('La fin de periode precede le debut.');

  const which = ctx.query.get('report');
  if (which) {
    const build = REPORTS[which];
    if (!build) throw badRequest('Rapport inconnu.');
    const data = await build(from, to);
    if (ctx.query.get('format') === 'csv') {
      const csv = toCsv(data, REPORT_HEADERS[which] || []);
      ctx.res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${which}-${from}_${to}.csv"`,
      });
      ctx.res.end(`\ufeff${csv}`);
      return;
    }
    return { report: which, from, to, data };
  }

  return {
    from, to,
    summary: await summaryReport(from, to),
    by_restaurant: await byRestaurantReport(from, to),
    by_product: (await byProductReport(from, to)).slice(0, 20),
    customers: await customersReport(from, to),
    cod: await codReport(from, to),
  };
});

/* ---- order control ---- */
router.get('/api/admin/orders', async (ctx) => {
  await requirePermission(ctx, 'orders.view');
  const q = (ctx.query.get('q') || '').trim();
  const status = ctx.query.get('status') || '';
  const fulfillment = ctx.query.get('fulfillment') || '';
  const service = (ctx.query.get('service') || '').trim();
  const restaurantId = ctx.query.get('restaurant_id') || '';
  const from = ctx.query.get('from') || '';
  const to = ctx.query.get('to') || '';
  const limit = Math.min(Number(ctx.query.get('limit') || 100), 300);

  const where = [];
  const args = [];
  if (q) {
    args.push(`%${q}%`);
    where.push(`(o.order_number LIKE $${args.length} OR o.customer_name LIKE $${args.length} OR o.customer_phone LIKE $${args.length})`);
  }
  if (status === 'refunded') where.push('o.refunded_cents > 0');
  else if (status) { args.push(status); where.push(`o.status = $${args.length}`); }
  if (fulfillment) { args.push(fulfillment); where.push(`o.fulfillment_type = $${args.length}`); }
  if (SERVICE_TYPES.includes(service)) { args.push(service); where.push(`o.service_type = $${args.length}`); }
  if (restaurantId) { args.push(Number(restaurantId)); where.push(`o.restaurant_id = $${args.length}`); }
  if (from) { args.push(`${from}T00:00:00.000Z`); where.push(`o.placed_at >= $${args.length}`); }
  if (to) { args.push(`${to}T23:59:59.999Z`); where.push(`o.placed_at <= $${args.length}`); }

  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orders = (await store.all(
    `${ORDER_SELECT}${clause} ORDER BY o.id DESC LIMIT ${wantsCsv(ctx) ? 5000 : limit}`, args)).map(withDelivery);
  if (wantsCsv(ctx)) return sendCsv(ctx, 'commandes', pickColumns(orders, ORDER_CSV), ORDER_CSV);
  const totals = await store.get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(o.total_cents),0) AS total_cents,
            COALESCE(SUM(o.commission_cents),0) AS commission_cents,
            COALESCE(SUM(o.refunded_cents),0) AS refunded_cents
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id${clause}`, args);

  return { orders, totals: numbers(totals) };
});

router.get('/api/admin/orders/:id', async (ctx) => {
  await requirePermission(ctx, 'orders.view');
  const order = await loadOrder(Number(ctx.params.id));
  const customer = await store.get(
    'SELECT id, name, email, phone, status, created_at FROM users WHERE id = $1', [order.customer_id]);
  const notes = await store.all(
    `SELECT n.*, u.name AS author_name, u.email AS author_email
     FROM order_notes n LEFT JOIN users u ON u.id = n.author_user_id
     WHERE n.order_id = $1 ORDER BY n.id`, [order.id]);
  const customerOrders = await store.get(
    "SELECT COUNT(*) AS c FROM orders WHERE customer_id = $1", [order.customer_id]);
  return { order, customer: { ...customer, orders_count: Number(customerOrders.c) }, notes };
});

router.post('/api/admin/orders/:id/notes', async (ctx) => {
  const admin = await requirePermission(ctx, 'orders.note');
  const order = await loadOrder(Number(ctx.params.id));
  const note = str(ctx.body, 'note', { max: 1000, min: 2 });
  const id = await store.insert(
    'INSERT INTO order_notes (order_id, author_user_id, note, created_at) VALUES ($1,$2,$3,$4)',
    [order.id, admin.id, note, nowIso()]);
  await audit(ctx, admin, 'order_note', 'order', order.id, { note: note.slice(0, 200) });
  return { note: await store.get('SELECT * FROM order_notes WHERE id = $1', [id]) };
});

router.post('/api/admin/orders/:id/cancel', async (ctx) => {
  const admin = await requirePermission(ctx, 'orders.cancel');
  const order = await loadOrder(Number(ctx.params.id));
  const reason = str(ctx.body, 'reason', { max: 300, min: 3 });
  if (['completed', 'cancelled', 'rejected'].includes(order.status)) {
    throw conflict('Cette commande est deja terminee ou annulee.');
  }
  await setStatus(order, 'cancelled', admin.id, `[admin] ${reason}`);
  await audit(ctx, admin, 'order_cancel', 'order', order.id, { reason },
    { before: { status: order.status }, after: { status: 'cancelled' } });
  return { order: await loadOrder(order.id) };
});

/* ---- dashboard home ---- */
const dayRange = (day) => [`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`];

router.get('/api/admin/dashboard', async (ctx) => {
  const admin = await requirePermission(ctx, 'dashboard.view');
  const today = new Date().toISOString().slice(0, 10);
  const [from, to] = dayRange(today);
  await refreshCodDays(14);

  const todayOrders = await store.get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN total_cents ELSE 0 END),0) AS revenue_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN commission_cents ELSE 0 END),0) AS commission_cents,
            COALESCE(SUM(refunded_cents),0) AS refunded_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_cents ELSE 0 END),0) AS discount_cents
     FROM orders WHERE placed_at >= $1 AND placed_at <= $2`, [from, to]);

  const live = await store.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) AS pending,
            COALESCE(SUM(CASE WHEN status IN ('accepted','preparing') THEN 1 ELSE 0 END),0) AS preparing,
            COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END),0) AS ready
     FROM orders WHERE status IN ('pending','accepted','preparing','ready')`);

  const restaurants = await store.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END),0) AS active,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END),0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END),0) AS rejected,
            COALESCE(SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END),0) AS suspended
     FROM restaurants`);

  // Orders of the day grouped by status, for the dashboard breakdown.
  const statusRows = await store.all(
    `SELECT status, COUNT(*) AS n FROM orders
     WHERE placed_at >= $1 AND placed_at <= $2 GROUP BY status`, [from, to]);
  const ordersByStatus = {};
  for (const row of statusRows) ordersByStatus[row.status] = Number(row.n);

  // Last 7 days (oldest first) for the small activity chart.
  const last7 = [];
  for (let back = 6; back >= 0; back -= 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - back);
    const day = d.toISOString().slice(0, 10);
    const [dFrom, dTo] = dayRange(day);
    const row = await store.get(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN total_cents ELSE 0 END),0) AS revenue_cents,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN commission_cents ELSE 0 END),0) AS commission_cents
       FROM orders WHERE placed_at >= $1 AND placed_at <= $2`, [dFrom, dTo]);
    last7.push({ day, ...numbers(row) });
  }

  const recentOrders = await store.all(
    `SELECT o.id, o.order_number, o.status, o.total_cents, o.placed_at, o.service_type,
            o.scheduled_for, r.name AS restaurant_name, r.name_ar AS restaurant_name_ar,
            u.name AS customer_name
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN users u ON u.id = o.customer_id
     ORDER BY o.id DESC LIMIT 8`);

  const pendingRestaurants = await store.all(
    `SELECT r.id, r.name, r.name_ar, r.city, r.created_at, u.name AS owner_name, u.phone AS owner_phone
     FROM restaurants r JOIN users u ON u.id = r.owner_user_id
     WHERE r.status = 'pending' ORDER BY r.id DESC LIMIT 10`);

  const disputedDays = await store.all(
    `SELECT c.*, r.name AS restaurant_name FROM cod_days c JOIN restaurants r ON r.id = c.restaurant_id
     WHERE c.status = 'disputed' ORDER BY c.day DESC LIMIT 10`);

  const recentRefunds = await store.all(
    `SELECT f.id, f.amount_cents, f.reason, f.created_at, o.order_number, r.name AS restaurant_name
     FROM refunds f JOIN orders o ON o.id = f.order_id JOIN restaurants r ON r.id = o.restaurant_id
     ORDER BY f.id DESC LIMIT 8`);

  const recentActions = await store.all(
    `SELECT a.id, a.action, a.resource_type, a.resource_id, a.created_at, a.details,
            u.name AS actor_name, u.email AS actor_email, a.actor_role
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.id DESC LIMIT 12`);

  const openSupport = await store.get("SELECT COUNT(*) AS c FROM support_messages WHERE status = 'open'");
  const settings = await loadSettings();

  return {
    today: { date: today, ...numbers(todayOrders) },
    live: numbers(live),
    restaurants: numbers(restaurants),
    cod: await codSummary(),
    orders_by_status: ordersByStatus,
    last7,
    recent_orders: recentOrders,
    pending_restaurants: pendingRestaurants,
    disputed_cod_days: disputedDays,
    recent_refunds: recentRefunds,
    recent_actions: recentActions,
    open_support: Number(openSupport.c),
    maintenance_mode: isOn(settings.maintenance_mode) ? 1 : 0,
    promotions_enabled: isOn(settings.promotions_enabled) ? 1 : 0,
    admin_role: adminRoleOf(admin),
  };
});

router.get('/api/admin/stats', async (ctx) => {
  await requirePermission(ctx, 'dashboard.view');
  const totals = await store.get(
    `SELECT COUNT(*) AS completed_orders, COALESCE(SUM(total_cents),0) AS gross_cents,
            COALESCE(SUM(commission_cents),0) AS commission_cents,
            COALESCE(SUM(refunded_cents),0) AS refunded_cents,
            COALESCE(SUM(discount_cents),0) AS discount_cents,
            COALESCE(SUM(CASE WHEN discount_funded_by = 'platform' THEN discount_cents ELSE 0 END),0) AS platform_discount_cents
     FROM orders WHERE status = 'completed'`);
  const counts = await store.get(
    `SELECT (SELECT COUNT(*) FROM restaurants WHERE status = 'pending')  AS pending_restaurants,
            (SELECT COUNT(*) FROM restaurants WHERE status = 'approved') AS approved_restaurants,
            (SELECT COUNT(*) FROM users WHERE role = 'customer')         AS customers,
            (SELECT COUNT(*) FROM orders)                                AS all_orders`);
  const owed = await store.all(
    `SELECT r.id, r.name, r.name_ar, COALESCE(SUM(o.commission_cents),0) AS commission_cents,
            COUNT(o.id) AS orders FROM restaurants r
     LEFT JOIN orders o ON o.restaurant_id = r.id AND o.status = 'completed'
     GROUP BY r.id, r.name, r.name_ar ORDER BY commission_cents DESC`);
  const openSupport = await store.get("SELECT COUNT(*) AS c FROM support_messages WHERE status = 'open'");
  return {
    ...numbers(totals), ...numbers(counts),
    net_revenue_cents: Number(totals.commission_cents) - Number(totals.platform_discount_cents),
    open_support: Number(openSupport.c),
    commission_by_restaurant: owed.map((r) => ({ ...r, commission_cents: Number(r.commission_cents), orders: Number(r.orders) })),
  };
});

router.get('/api/admin/audit', async (ctx) => {
  await requirePermission(ctx, 'audit.view');
  const actor = ctx.query.get('actor_user_id') || '';
  const action = ctx.query.get('action') || '';
  const resource = ctx.query.get('resource_type') || '';
  const from = ctx.query.get('from') || '';
  const to = ctx.query.get('to') || '';

  const where = [];
  const args = [];
  if (actor) { args.push(Number(actor)); where.push(`a.actor_user_id = $${args.length}`); }
  if (action) { args.push(`%${action}%`); where.push(`a.action LIKE $${args.length}`); }
  if (resource) { args.push(resource); where.push(`a.resource_type = $${args.length}`); }
  if (from) { args.push(`${from}T00:00:00.000Z`); where.push(`a.created_at >= $${args.length}`); }
  if (to) { args.push(`${to}T23:59:59.999Z`); where.push(`a.created_at <= $${args.length}`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const logs = await store.all(
    `SELECT a.*, u.email AS actor_email, u.name AS actor_name FROM audit_logs a
     LEFT JOIN users u ON u.id = a.actor_user_id${clause} ORDER BY a.id DESC LIMIT ${wantsCsv(ctx) ? 5000 : 300}`, args);
  if (wantsCsv(ctx)) return sendCsv(ctx, 'journal', pickColumns(logs, AUDIT_CSV), AUDIT_CSV);
  const actions = await store.all('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  const resources = await store.all("SELECT DISTINCT resource_type FROM audit_logs WHERE resource_type <> '' ORDER BY resource_type");
  const actors = await store.all(
    `SELECT DISTINCT u.id, u.name, u.email FROM audit_logs a JOIN users u ON u.id = a.actor_user_id ORDER BY u.name`);
  return {
    logs,
    filters: {
      actions: actions.map((r) => r.action),
      resource_types: resources.map((r) => r.resource_type),
      actors,
    },
  };
});

/* ---- platform settings ---- */
router.get('/api/admin/settings', async (ctx) => {
  await requirePermission(ctx, 'settings.manage');
  return { settings: await loadSettings(true), defaults: DEFAULTS };
});

router.put('/api/admin/settings', async (ctx) => {
  const admin = await requirePermission(ctx, 'settings.manage');
  const before = await loadSettings();
  const next = {};

  if (ctx.body.platform_name !== undefined) next.platform_name = str(ctx.body, 'platform_name', { max: 80 });
  if (ctx.body.support_phone !== undefined) {
    const raw = String(ctx.body.support_phone).trim();
    next.support_phone = raw ? normalisePhone(raw) : '';
  }
  if (ctx.body.support_email !== undefined) {
    next.support_email = String(ctx.body.support_email).trim() ? email(ctx.body, 'support_email') : '';
  }
  if (ctx.body.currency !== undefined) next.currency = str(ctx.body, 'currency', { max: 8 });
  if (ctx.body.default_language !== undefined) {
    next.default_language = oneOf(ctx.body, 'default_language', ['fr', 'ar']);
  }
  if (ctx.body.default_commission_bp !== undefined) {
    next.default_commission_bp = String(int(ctx.body, 'default_commission_bp', { min: 0, max: 10000 }));
  }
  if (ctx.body.maintenance_mode !== undefined) next.maintenance_mode = bool(ctx.body, 'maintenance_mode') ? '1' : '0';
  if (ctx.body.promotions_enabled !== undefined) next.promotions_enabled = bool(ctx.body, 'promotions_enabled') ? '1' : '0';

  if (!Object.keys(next).length) throw badRequest('Rien a enregistrer.');
  const after = await setSettings(next, admin.id);
  await audit(ctx, admin, 'settings_update', 'settings', null, { keys: Object.keys(next) },
    { before: Object.fromEntries(Object.keys(next).map((k) => [k, before[k]])),
      after: Object.fromEntries(Object.keys(next).map((k) => [k, after[k]])) });
  return { settings: after };
});

/**
 * Public liveness check, for an uptime monitor. Answers 503 when the database
 * is unreachable so a monitor can alert without reading the body.
 */
router.get('/api/health', async (ctx) => {
  const health = await publicHealth();
  if (!health.ok) {
    ctx.res.statusCode = 503;
    ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
    ctx.res.end(JSON.stringify(health));
    return;
  }
  // Kept for the existing callers and tests.
  return { ...health, database: store.driver };
});

/** The full picture, for the admin panel: backups, disk, configuration. */
router.get('/api/admin/health', async (ctx) => {
  await requirePermission(ctx, 'dashboard.view');
  return adminHealth();
});

/** Takes a backup now. Super admin only, and recorded in the audit log. */
router.post('/api/admin/backup', async (ctx) => {
  const admin = await requirePermission(ctx, 'settings.manage');
  try {
    const result = await runBackup();
    await audit(ctx, admin, 'backup_run', 'system', null,
      { tables: result.manifest.tables.length, rows: result.manifest.total_rows });
    return {
      ok: true,
      tables: result.manifest.tables.length,
      rows: result.manifest.total_rows,
      created_at: result.manifest.created_at,
    };
  } catch (error) {
    throw new HttpError(500, `Sauvegarde impossible: ${error.message}`);
  }
});

/**
 * The one-time codes still live, for the pilot console.
 * Empty in production: there the code goes to the provider and nowhere else.
 */
router.get('/api/admin/auth-codes', async (ctx) => {
  await requirePermission(ctx, 'customers.manage');
  return { console_enabled: consoleEnabled(), codes: pendingCodes() };
});

/** The recent security and money events, for the admin panel. */
router.get('/api/admin/events', async (ctx) => {
  await requirePermission(ctx, 'audit.view');
  return { events: recentEvents(100) };
});
