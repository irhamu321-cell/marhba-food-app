/*
 * Upgrades a database made by an earlier version of this app, without losing data.
 * Every step is safe to run again: they check first, or fail harmlessly.
 */
import { store } from './store.js';

/* Columns added after the first release. */
const ADDED_COLUMNS = [
  ['users', 'token_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'locale', "TEXT NOT NULL DEFAULT 'fr'"],
  ['users', 'status', "TEXT NOT NULL DEFAULT 'active'"],
  ['restaurants', 'name_ar', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'description_ar', "TEXT NOT NULL DEFAULT ''"],
  ['categories', 'name_ar', "TEXT NOT NULL DEFAULT ''"],
  ['products', 'name_ar', "TEXT NOT NULL DEFAULT ''"],
  ['products', 'description_ar', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'commission_rate_bp', 'INTEGER NOT NULL DEFAULT 1500'],
  ['orders', 'refunded_cents', 'BIGINT NOT NULL DEFAULT 0'],
  ['orders', 'discount_cents', 'BIGINT NOT NULL DEFAULT 0'],
  ['orders', 'discount_funded_by', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'promotion_id', 'BIGINT'],
  ['orders', 'promo_code', "TEXT NOT NULL DEFAULT ''"],
  ['order_items', 'name_ar', "TEXT NOT NULL DEFAULT ''"],
  ['order_items', 'base_price_cents', 'BIGINT NOT NULL DEFAULT 0'],
  ['users', 'admin_role', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'last_login_at', 'TEXT'],
  ['audit_logs', 'user_agent', "TEXT NOT NULL DEFAULT ''"],
  ['audit_logs', 'before_state', "TEXT NOT NULL DEFAULT ''"],
  ['audit_logs', 'after_state', "TEXT NOT NULL DEFAULT ''"],
  ['cod_days', 'gross_cents', 'BIGINT NOT NULL DEFAULT 0'],
  ['cod_days', 'orders_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['restaurants', 'rejection_reason', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'service_type', "TEXT NOT NULL DEFAULT 'immediate'"],
  ['restaurants', 'min_prep_hours', 'INTEGER NOT NULL DEFAULT 0'],
  ['restaurants', 'delivery_days', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'delivery_slots', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'order_cutoff', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'cuisines', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'rating_bp', 'INTEGER NOT NULL DEFAULT 0'],
  ['orders', 'service_type', "TEXT NOT NULL DEFAULT 'immediate'"],
  ['orders', 'scheduled_for', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'scheduled_slot', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'address_id', 'BIGINT'],
  ['orders', 'addr_label', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_recipient_name', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_recipient_phone', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_city', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_street', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_building', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_floor', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_landmark', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_instructions', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_lat', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'addr_lng', "TEXT NOT NULL DEFAULT ''"],
  ['orders', 'special_instructions', "TEXT NOT NULL DEFAULT ''"],
  ['product_options', 'is_removal', 'SMALLINT NOT NULL DEFAULT 0'],
  ['order_item_options', 'is_removal', 'SMALLINT NOT NULL DEFAULT 0'],
  ['restaurants', 'reviews_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'daily_stock', 'INTEGER NOT NULL DEFAULT 0'],
  ['restaurants', 'chef_bio', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'chef_bio_ar', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'pickup_instructions', "TEXT NOT NULL DEFAULT ''"],
  ['restaurants', 'pickup_instructions_ar', "TEXT NOT NULL DEFAULT ''"],
];

async function addMissingColumns() {
  let added = 0;
  for (const [table, column, definition] of ADDED_COLUMNS) {
    try {
      await store.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      added++;
    } catch { /* the column already exists */ }
  }
  return added;
}

/*
 * The first release made email a required, unique login. Phone is the login now,
 * and email is optional, so that constraint has to go.
 */
async function relaxEmail() {
  if (store.driver === 'postgres') {
    let changed = false;
    for (const sql of [
      'ALTER TABLE users ALTER COLUMN email DROP NOT NULL',
      'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key',
    ]) {
      try { await store.run(sql); changed = true; } catch { /* already done */ }
    }
    await store.run("UPDATE users SET email = '' WHERE email IS NULL");
    return changed;
  }

  const sql = await store.sqliteTableSql('users');
  if (!sql || !/email\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql)) return false;

  // SQLite cannot drop a constraint, so the table is rebuilt and the rows copied.
  await store.sqliteExec('PRAGMA foreign_keys = OFF');
  await store.sqliteExec(`
    BEGIN;
    CREATE TABLE users_rebuilt (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL DEFAULT '',
      phone         TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','restaurant','admin')),
      token_version INTEGER NOT NULL DEFAULT 0,
      locale        TEXT NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr','ar')),
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at    TEXT NOT NULL
    );
    INSERT INTO users_rebuilt (id, name, email, phone, password_hash, role, token_version, locale, status, created_at)
      SELECT id, name, COALESCE(email,''), COALESCE(phone,''), password_hash, role,
             COALESCE(token_version,0), COALESCE(locale,'fr'), COALESCE(status,'active'), created_at
      FROM users;
    DROP TABLE users;
    ALTER TABLE users_rebuilt RENAME TO users;
    COMMIT;
  `);
  await store.sqliteExec('PRAGMA foreign_keys = ON');
  return true;
}

/*
 * Restaurants gained a 'rejected' status. The old CHECK constraint refuses it,
 * and neither engine can edit a constraint in place, so it is replaced.
 */
async function allowRejectedStatus() {
  if (store.driver === 'postgres') {
    try {
      await store.run('ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_status_check');
      await store.run(`ALTER TABLE restaurants ADD CONSTRAINT restaurants_status_check
        CHECK (status IN ('pending','approved','suspended','rejected'))`);
      return true;
    } catch { return false; }
  }

  const sql = await store.sqliteTableSql('restaurants');
  if (!sql || sql.includes("'rejected'")) return false;

  const columns = await store.all("SELECT name FROM pragma_table_info('restaurants')");
  const names = columns.map((c) => c.name).filter((n) => n !== 'rejection_reason');
  const copied = names.join(', ');

  await store.sqliteExec('PRAGMA foreign_keys = OFF');
  await store.sqliteExec(`
    BEGIN;
    CREATE TABLE restaurants_rebuilt (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      name_ar            TEXT NOT NULL DEFAULT '',
      city               TEXT NOT NULL DEFAULT '',
      address            TEXT NOT NULL DEFAULT '',
      phone              TEXT NOT NULL DEFAULT '',
      description        TEXT NOT NULL DEFAULT '',
      description_ar     TEXT NOT NULL DEFAULT '',
      image_url          TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','suspended','rejected')),
      rejection_reason   TEXT NOT NULL DEFAULT '',
      commission_rate_bp INTEGER NOT NULL DEFAULT 1500 CHECK (commission_rate_bp BETWEEN 0 AND 10000),
      supports_pickup    SMALLINT NOT NULL DEFAULT 1,
      supports_delivery  SMALLINT NOT NULL DEFAULT 1,
      delivery_fee_cents BIGINT NOT NULL DEFAULT 1000 CHECK (delivery_fee_cents >= 0),
      min_order_cents    BIGINT NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
      prep_minutes       INTEGER NOT NULL DEFAULT 20,
      is_open            SMALLINT NOT NULL DEFAULT 1,
      service_type       TEXT NOT NULL DEFAULT 'immediate'
                           CHECK (service_type IN ('immediate','preorder')),
      min_prep_hours     INTEGER NOT NULL DEFAULT 0 CHECK (min_prep_hours >= 0),
      delivery_days      TEXT NOT NULL DEFAULT '',
      delivery_slots     TEXT NOT NULL DEFAULT '',
      order_cutoff       TEXT NOT NULL DEFAULT '',
      cuisines           TEXT NOT NULL DEFAULT '',
      rating_bp          INTEGER NOT NULL DEFAULT 0 CHECK (rating_bp BETWEEN 0 AND 50000),
      created_at         TEXT NOT NULL
    );
    INSERT INTO restaurants_rebuilt (${copied}) SELECT ${copied} FROM restaurants;
    DROP TABLE restaurants;
    ALTER TABLE restaurants_rebuilt RENAME TO restaurants;
    CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status, city);
    CREATE INDEX IF NOT EXISTS idx_restaurants_owner ON restaurants(owner_user_id);
    COMMIT;
  `);
  await store.sqliteExec('PRAGMA foreign_keys = ON');
  return true;
}

/* Phone is the login, so it must be unique — but only when it is filled in. */
async function addLoginIndexes() {
  for (const sql of [
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone ON users(phone) WHERE phone <> ''",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email) WHERE email <> ''",
  ]) {
    try { await store.run(sql); }
    catch {
      // Old data can hold the same number twice. Name them instead of failing to start:
      // new signups are still blocked from reusing a number, this only affects existing rows.
      const column = sql.includes('phone') ? 'phone' : 'email';
      try {
        const duplicates = await store.all(
          `SELECT ${column} AS value, COUNT(*) AS c FROM users
           WHERE ${column} <> '' GROUP BY ${column} HAVING COUNT(*) > 1`);
        if (duplicates.length) {
          console.warn(`\n  A regler: ${duplicates.length} ${column}(s) en double dans les comptes existants:`);
          for (const row of duplicates.slice(0, 10)) console.warn(`    ${row.value} (${row.c} comptes)`);
          console.warn('  Les nouveaux comptes ne peuvent pas les reutiliser.\n');
        }
      } catch { /* reporting is best effort */ }
    }
  }
}

export async function runMigrations() {
  const added = await addMissingColumns();
  const relaxed = await relaxEmail();
  const rejectable = await allowRejectedStatus();
  await addLoginIndexes();
  if (rejectable) console.log('Base de donnees mise a jour: statut "rejete" disponible pour les restaurants.');
  if (added || relaxed) {
    console.log(`Base de donnees mise a jour (${added} colonne(s)${relaxed ? ', connexion par telephone' : ''}).`);
  }
}
