/* Platform settings: stored in the database, cached in memory. */
import { store, nowIso } from './store.js';

export const DEFAULTS = {
  platform_name: 'Marhba',
  support_phone: '',
  support_email: '',
  currency: 'MAD',
  default_language: 'fr',
  default_commission_bp: '1500',
  maintenance_mode: '0',
  promotions_enabled: '1',
};

let cache = null;

export async function loadSettings(force = false) {
  if (cache && !force) return cache;
  const rows = await store.all('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export async function getSetting(key) {
  const all = await loadSettings();
  return all[key];
}

export const isOn = (value) => value === '1' || value === 1 || value === true || value === 'true';

export async function setSettings(values, userId) {
  const at = nowIso();
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULTS)) continue;
    const existing = await store.get('SELECT key FROM settings WHERE key = $1', [key]);
    if (existing) {
      await store.run('UPDATE settings SET value = $1, updated_at = $2, updated_by = $3 WHERE key = $4',
        [String(value), at, userId ?? null, key]);
    } else {
      await store.run('INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1,$2,$3,$4)',
        [key, String(value), at, userId ?? null]);
    }
  }
  return loadSettings(true);
}
