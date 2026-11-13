import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { store, pk, nowIso, ROOT } from './store.js';
import { hashPassword } from './auth.js';
import { runMigrations } from './migrations.js';
import { DEMO_RESTAURANTS } from './seed-demo.js';

/**
 * Bumped whenever the shape of the database changes in a way that an older
 * backup could not be restored into. A backup records this number; a restore
 * refuses a backup whose number it does not understand.
 */
export const SCHEMA_VERSION = 4;

/** The tables a usable database must contain. A restore checks for all of them. */
export const REQUIRED_TABLES = [
  'users', 'restaurants', 'categories', 'products', 'option_groups', 'product_options',
  'orders', 'order_items', 'order_item_options', 'order_status_history', 'order_notes',
  'refunds', 'promotions', 'promotion_uses', 'cod_days', 'settlements',
  'support_messages', 'audit_logs', 'idempotency_keys', 'settings', 'auth_codes',
  'customer_addresses',
];

export async function createSchema() {
  const id = pk();
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id ${id},
      name TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','restaurant','admin')),
      token_version INTEGER NOT NULL DEFAULT 0,
      locale TEXT NOT NULL DEFAULT 'fr' CHECK (locale IN ('fr','ar')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      admin_role TEXT NOT NULL DEFAULT '',
      last_login_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS restaurants (
      id ${id},
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      description_ar TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','suspended','rejected')),
      rejection_reason TEXT NOT NULL DEFAULT '',
      commission_rate_bp INTEGER NOT NULL DEFAULT 1500 CHECK (commission_rate_bp BETWEEN 0 AND 10000),
      supports_pickup SMALLINT NOT NULL DEFAULT 1,
      supports_delivery SMALLINT NOT NULL DEFAULT 1,
      delivery_fee_cents BIGINT NOT NULL DEFAULT 1000 CHECK (delivery_fee_cents >= 0),
      min_order_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
      prep_minutes INTEGER NOT NULL DEFAULT 20,
      is_open SMALLINT NOT NULL DEFAULT 1,
      service_type TEXT NOT NULL DEFAULT 'immediate' CHECK (service_type IN ('immediate','preorder')),
      min_prep_hours INTEGER NOT NULL DEFAULT 0 CHECK (min_prep_hours >= 0),
      delivery_days TEXT NOT NULL DEFAULT '',
      delivery_slots TEXT NOT NULL DEFAULT '',
      order_cutoff TEXT NOT NULL DEFAULT '',
      cuisines TEXT NOT NULL DEFAULT '',
      rating_bp INTEGER NOT NULL DEFAULT 0 CHECK (rating_bp BETWEEN 0 AND 50000),
      /*
       * Kept alongside the average so a page of restaurant cards does not
       * need a count query per card. Both are recomputed from the reviews
       * table whenever a review is written, so neither can drift.
       */
      reviews_count INTEGER NOT NULL DEFAULT 0 CHECK (reviews_count >= 0),
      chef_bio TEXT NOT NULL DEFAULT '',
      chef_bio_ar TEXT NOT NULL DEFAULT '',
      pickup_instructions TEXT NOT NULL DEFAULT '',
      pickup_instructions_ar TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants(status, city)`,
    `CREATE INDEX IF NOT EXISTS idx_restaurants_owner ON restaurants(owner_user_id)`,

    `CREATE TABLE IF NOT EXISTS categories (
      id ${id},
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_categories_restaurant ON categories(restaurant_id, sort_order)`,

    `CREATE TABLE IF NOT EXISTS products (
      id ${id},
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      description_ar TEXT NOT NULL DEFAULT '',
      price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
      image_url TEXT NOT NULL DEFAULT '',
      is_active SMALLINT NOT NULL DEFAULT 1,
      daily_stock INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_products_restaurant ON products(restaurant_id, is_active)`,

    `CREATE TABLE IF NOT EXISTS option_groups (
      id ${id},
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
      max_select INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_option_groups_product ON option_groups(product_id, sort_order)`,

    `CREATE TABLE IF NOT EXISTS product_options (
      id ${id},
      option_group_id BIGINT NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      price_delta_cents BIGINT NOT NULL DEFAULT 0 CHECK (price_delta_cents >= 0),
      is_available SMALLINT NOT NULL DEFAULT 1,
      /*
       * A removal takes something out of the dish: "Sans oignons".
       *
       * It is a flag rather than a negative price on purpose. Money stays
       * non-negative everywhere, so no crafted request can shrink a total by
       * sending a pile of option ids, and the kitchen ticket can still shout
       * SANS next to the thing that must be left out.
       */
      is_removal SMALLINT NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_product_options_group ON product_options(option_group_id, sort_order)`,

    `CREATE TABLE IF NOT EXISTS orders (
      id ${id},
      order_number TEXT NOT NULL UNIQUE,
      customer_id BIGINT NOT NULL REFERENCES users(id),
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id),
      fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('pickup','delivery')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','preparing','ready','completed','rejected','cancelled')),
      payment_method TEXT NOT NULL DEFAULT 'cod',
      cash_collected SMALLINT NOT NULL DEFAULT 0,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      items_subtotal_cents BIGINT NOT NULL CHECK (items_subtotal_cents >= 0),
      delivery_fee_cents BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
      total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
      commission_rate_bp INTEGER NOT NULL DEFAULT 1500,
      commission_cents BIGINT NOT NULL DEFAULT 0 CHECK (commission_cents >= 0),
      restaurant_net_cents BIGINT NOT NULL DEFAULT 0,
      refunded_cents BIGINT NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
      discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
      discount_funded_by TEXT NOT NULL DEFAULT '',
      promotion_id BIGINT,
      promo_code TEXT NOT NULL DEFAULT '',
      cancellation_reason TEXT NOT NULL DEFAULT '',
      /*
       * Allergies and anything else the kitchen has to read before cooking.
       *
       * Separate from the ordinary note column, which is the customer's own request
       * ("extra napkins"). This one is shown with a warning badge on every
       * screen that a cook or an operator looks at, because getting it wrong
       * can put someone in hospital.
       */
      special_instructions TEXT NOT NULL DEFAULT '',
      service_type TEXT NOT NULL DEFAULT 'immediate',
      scheduled_for TEXT NOT NULL DEFAULT '',
      scheduled_slot TEXT NOT NULL DEFAULT '',
      /*
       * Frozen copy of the delivery address as the customer confirmed it.
       *
       * address_id records which saved address was chosen, for reference only:
       * it is deliberately not a foreign key. A customer who later edits or
       * deletes that address must not change what a past order said, because
       * the order is the record of where the food actually went.
       */
      address_id BIGINT,
      addr_label TEXT NOT NULL DEFAULT '',
      addr_recipient_name TEXT NOT NULL DEFAULT '',
      addr_recipient_phone TEXT NOT NULL DEFAULT '',
      addr_city TEXT NOT NULL DEFAULT '',
      addr_street TEXT NOT NULL DEFAULT '',
      addr_building TEXT NOT NULL DEFAULT '',
      addr_floor TEXT NOT NULL DEFAULT '',
      addr_landmark TEXT NOT NULL DEFAULT '',
      addr_instructions TEXT NOT NULL DEFAULT '',
      addr_lat TEXT NOT NULL DEFAULT '',
      addr_lng TEXT NOT NULL DEFAULT '',
      placed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,

    `CREATE TABLE IF NOT EXISTS order_items (
      id ${id},
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT REFERENCES products(id),
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      base_price_cents BIGINT NOT NULL DEFAULT 0,
      unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      line_total_cents BIGINT NOT NULL CHECK (line_total_cents >= 0),
      note TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,

    `CREATE TABLE IF NOT EXISTS order_item_options (
      id ${id},
      order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL DEFAULT '',
      group_name_ar TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      name_ar TEXT NOT NULL DEFAULT '',
      price_delta_cents BIGINT NOT NULL DEFAULT 0,
      -- frozen with the line, so a menu edit never rewrites an old ticket
      is_removal SMALLINT NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_order_item_options_item ON order_item_options(order_item_id)`,

    `CREATE TABLE IF NOT EXISTS order_status_history (
      id ${id},
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_user_id BIGINT REFERENCES users(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_history_order ON order_status_history(order_id, id)`,

    `CREATE TABLE IF NOT EXISTS refunds (
      id ${id},
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      reason TEXT NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id),
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id)`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id ${id},
      actor_user_id BIGINT REFERENCES users(id),
      actor_role TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT '',
      resource_id BIGINT,
      details TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      before_state TEXT NOT NULL DEFAULT '',
      after_state TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, id DESC)`,

    `CREATE TABLE IF NOT EXISTS promotions (
      id ${id},
      code TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      description_ar TEXT NOT NULL DEFAULT '',
      restaurant_id BIGINT REFERENCES restaurants(id) ON DELETE CASCADE,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed','free_delivery')),
      discount_value BIGINT NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
      max_discount_cents BIGINT NOT NULL DEFAULT 0 CHECK (max_discount_cents >= 0),
      min_order_cents BIGINT NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
      funded_by TEXT NOT NULL DEFAULT 'platform' CHECK (funded_by IN ('platform','restaurant')),
      starts_at TEXT NOT NULL DEFAULT '',
      ends_at TEXT NOT NULL DEFAULT '',
      usage_limit INTEGER NOT NULL DEFAULT 0 CHECK (usage_limit >= 0),
      per_customer_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_customer_limit >= 0),
      is_active SMALLINT NOT NULL DEFAULT 1,
      created_by BIGINT REFERENCES users(id),
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_promotions_code ON promotions(code)`,

    `CREATE TABLE IF NOT EXISTS promotion_uses (
      id ${id},
      promotion_id BIGINT NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      customer_id BIGINT NOT NULL REFERENCES users(id),
      discount_cents BIGINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_promo_uses ON promotion_uses(promotion_id, customer_id)`,

    `CREATE TABLE IF NOT EXISTS support_messages (
      id ${id},
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      order_number TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
      handled_by BIGINT REFERENCES users(id),
      handled_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_support_status ON support_messages(status, id DESC)`,

    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      updated_by BIGINT
    )`,

    `CREATE TABLE IF NOT EXISTS order_notes (
      id ${id},
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      author_user_id BIGINT REFERENCES users(id),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_order_notes ON order_notes(order_id, id)`,

    `CREATE TABLE IF NOT EXISTS cod_days (
      id ${id},
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      gross_cents BIGINT NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      expected_cents BIGINT NOT NULL DEFAULT 0,
      declared_cents BIGINT NOT NULL DEFAULT 0,
      received_cents BIGINT NOT NULL DEFAULT 0,
      difference_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','declared','received','reconciled','disputed')),
      note TEXT NOT NULL DEFAULT '',
      declared_at TEXT,
      received_at TEXT,
      reconciled_by BIGINT REFERENCES users(id),
      reconciled_at TEXT,
      updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_cod_day ON cod_days(restaurant_id, day)`,
    `CREATE INDEX IF NOT EXISTS idx_cod_status ON cod_days(status, day DESC)`,

    `CREATE TABLE IF NOT EXISTS settlements (
      id ${id},
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      gross_cents BIGINT NOT NULL DEFAULT 0,
      commission_cents BIGINT NOT NULL DEFAULT 0,
      refunds_cents BIGINT NOT NULL DEFAULT 0,
      adjustments_cents BIGINT NOT NULL DEFAULT 0,
      net_payable_cents BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','cancelled')),
      note TEXT NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id),
      created_at TEXT NOT NULL,
      paid_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_settlements ON settlements(restaurant_id, id DESC)`,

    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id ${id},
      key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency ON idempotency_keys(key)`,

    /*
     * One-time codes: registration OTP and password reset.
     * Only the hash is stored, never the code itself, so a stolen database
     * does not hand over working codes.
     */
    `CREATE TABLE IF NOT EXISTS auth_codes (
      id ${id},
      purpose TEXT NOT NULL CHECK (purpose IN ('register','reset')),
      channel TEXT NOT NULL CHECK (channel IN ('phone','email')),
      destination TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at TEXT,
      expires_at TEXT NOT NULL,
      created_ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_auth_codes_lookup ON auth_codes(purpose, destination, expires_at)`,

    /*
     * Delivery addresses saved by a customer.
     *
     * The written details and the map pin are kept side by side on purpose:
     * a pin alone is not enough to find a door in a Moroccan neighbourhood,
     * and a written address alone is not enough for a courier who does not
     * know the street. Both are required for a delivery address.
     *
     * Coordinates are stored as text, not as floats, so that the exact value
     * the customer confirmed is what a courier later reads back. Both engines
     * then return the same string, with no rounding surprises.
     */
    `CREATE TABLE IF NOT EXISTS customer_addresses (
      id ${id},
      customer_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'home' CHECK (label IN ('home','work','other')),
      label_custom TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL,
      recipient_phone TEXT NOT NULL,
      city TEXT NOT NULL,
      street TEXT NOT NULL,
      building TEXT NOT NULL DEFAULT '',
      floor TEXT NOT NULL DEFAULT '',
      landmark TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      lat TEXT NOT NULL DEFAULT '',
      lng TEXT NOT NULL DEFAULT '',
      is_default SMALLINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_addresses_customer ON customer_addresses(customer_id, id DESC)`,

    /*
     * What customers thought.
     *
     * One review per order, which is what stops a restaurant being rated
     * fifty times by one enthusiastic friend: you get a voice for each meal
     * you actually paid for. The route enforces that the order is yours and
     * that it was completed.
     *
     * order_id is nullable so the demonstration data can carry reviews that
     * belong to no real order. A review written by a real customer always has
     * one, because the only way to create a review is through an order.
     */
    `CREATE TABLE IF NOT EXISTS reviews (
      id ${id},
      order_id BIGINT UNIQUE,
      customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      restaurant_id BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_restaurant ON reviews(restaurant_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_reviews_customer ON reviews(customer_id, id DESC)`,
  ];

  for (const sql of statements) await store.run(sql);
  await runMigrations();
}

/* ------------------------------------------------------------------ */
/**
 * Creates the first administrator on an empty database.
 *
 * The password comes from ADMIN_PASSWORD when it is set. Outside production,
 * if it is not set, a strong one is generated, printed once and written to
 * data/FIRST-ADMIN-LOGIN.txt so the first sign-in is possible; that file
 * should be deleted afterwards. In production a missing ADMIN_PASSWORD is a
 * refusal, handled by the startup checks in env.js — never a default password.
 */
export async function seedFirstAdmin() {
  const existing = await store.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");
  if (Number(existing.c) > 0) return null;

  const phone = normalisePhoneLike(process.env.ADMIN_PHONE || '0600000000');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const name = process.env.ADMIN_NAME || 'Administrateur';

  const supplied = process.env.ADMIN_PASSWORD || '';
  const generated = supplied ? null : crypto.randomBytes(12).toString('base64url');
  const password = supplied || generated;

  const at = nowIso();
  const pwdHash = await hashPassword(password);
  const id = await store.insert(
    `INSERT INTO users (name, email, phone, password_hash, role, admin_role, created_at)
     VALUES ($1,$2,$3,$4,'admin','super_admin',$5)`,
    [name, email, phone, pwdHash, at]);

  if (generated) {
    const file = join(ROOT, 'data', 'FIRST-ADMIN-LOGIN.txt');
    const body = [
      'Premier compte administrateur de Marhba',
      '',
      `  telephone : ${phone}`,
      `  mot de passe : ${generated}`,
      '',
      'Connecte-toi sur /admin.html, change ce mot de passe, puis SUPPRIME ce fichier.',
      `Cree le ${at}`,
      '',
    ].join('\n');
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body, { mode: 0o600 }); }
    catch { /* printing below is enough */ }

    console.log('');
    console.log('  ==========================================================');
    console.log('   PREMIER COMPTE ADMINISTRATEUR CREE');
    console.log(`     telephone    : ${phone}`);
    console.log(`     mot de passe : ${generated}`);
    console.log('   Change-le des la premiere connexion, puis supprime');
    console.log('   data/FIRST-ADMIN-LOGIN.txt');
    console.log('  ==========================================================');
    console.log('');
  }

  return { id, phone, generated: Boolean(generated) };
}

/** Same normalisation the login route uses, kept here to avoid importing routes. */
const normalisePhoneLike = (value) => String(value || '').replace(/[^\d+]/g, '');

/**
 * Demo restaurants, demo customers and a demo promo code.
 *
 * This runs ONLY when asked for: `SEED_DEMO_DATA=true` in the environment, or
 * `{ demo: true }` from a test. A plain start creates no demo account and no
 * demo password, so nothing shipped carries a known login.
 */
export async function seedIfEmpty(options = {}) {
  const wanted = options.demo === undefined
    ? String(process.env.SEED_DEMO_DATA || '').toLowerCase() === 'true'
    : Boolean(options.demo);
  if (!wanted) return false;

  const row = await store.get('SELECT COUNT(*) AS c FROM users');
  if (Number(row.c) > 0) return false;
  const at = nowIso();

  const user = async (name, email, phone, password, role) => store.insert(
    'INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [name, email, phone, await hashPassword(password), role, at]
  );

  const adminId = await user('Admin', 'admin@demo.ma', '0600000000', 'admin1234', 'admin');
  await store.run("UPDATE users SET admin_role = 'super_admin' WHERE id = $1", [adminId]);
  const owner1 = await user('Youssef Tazi', 'resto1@demo.ma', '0611111111', 'resto1234', 'restaurant');
  const owner2 = await user('Salma Idrissi', 'resto2@demo.ma', '0622222222', 'resto1234', 'restaurant');
  await user('Client Demo', 'client@demo.ma', '0633333333', 'client1234', 'customer');

  const resto = (ownerId, name, nameAr, desc, descAr, bp, fee, min, prep, cuisines, ratingBp) => store.insert(
    `INSERT INTO restaurants (owner_user_id, name, name_ar, city, address, phone, description, description_ar,
      status, commission_rate_bp, delivery_fee_cents, min_order_cents, prep_minutes,
      cuisines, rating_bp, created_at)
     VALUES ($1,$2,$3,'Casablanca',$4,$5,$6,$7,'approved',$8,$9,$10,$11,$12,$13,$14)`,
    [ownerId, name, nameAr, '12 Rue Hassan II', '0611111111', desc, descAr, bp, fee, min, prep,
     cuisines, ratingBp, at]
  );

  const r1 = await resto(owner1, 'Snack Atlas', 'سناك أطلس',
    'Tacos, sandwichs et grillades.', 'طاكوس، سندويتشات ومشاوي.', 1500, 1000, 3000, 20, 'fastfood,grillades', 41000);
  const r2 = await resto(owner2, 'Pizzeria Bella', 'بيتزيريا بيلا',
    'Pizzas au four et pates fraiches.', 'بيتزا بالفرن ومعكرونة طازجة.', 1200, 1500, 5000, 25, 'italienne', 44000);

  const category = (restoId, name, nameAr, sort) => store.insert(
    'INSERT INTO categories (restaurant_id, name, name_ar, sort_order) VALUES ($1,$2,$3,$4)',
    [restoId, name, nameAr, sort]
  );
  const product = (restoId, catId, name, nameAr, desc, descAr, price, sort) => store.insert(
    `INSERT INTO products (restaurant_id, category_id, name, name_ar, description, description_ar,
      price_cents, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [restoId, catId, name, nameAr, desc, descAr, price, sort, at]
  );
  const group = (productId, name, nameAr, min, max, sort) => store.insert(
    'INSERT INTO option_groups (product_id, name, name_ar, min_select, max_select, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
    [productId, name, nameAr, min, max, sort]
  );
  const option = (groupId, name, nameAr, delta, sort) => store.insert(
    'INSERT INTO product_options (option_group_id, name, name_ar, price_delta_cents, sort_order) VALUES ($1,$2,$3,$4,$5)',
    [groupId, name, nameAr, delta, sort]
  );

  // --- Snack Atlas ---
  const cTacos = await category(r1, 'Tacos', 'طاكوس', 1);
  const cDrinks = await category(r1, 'Boissons', 'مشروبات', 2);

  const tacosPoulet = await product(r1, cTacos, 'Tacos poulet', 'طاكوس دجاج',
    'Poulet, frites, sauce fromagere', 'دجاج، بطاطس، صلصة الجبن', 3500, 1);
  const gSize = await group(tacosPoulet, 'Taille', 'الحجم', 1, 1, 1);
  await option(gSize, 'M', 'متوسط', 0, 1);
  await option(gSize, 'L', 'كبير', 1000, 2);
  await option(gSize, 'XXL', 'كبير جدا', 2000, 3);
  const gSauce = await group(tacosPoulet, 'Sauces (3 max)', 'الصلصات (3 كحد أقصى)', 0, 3, 2);
  await option(gSauce, 'Algerienne', 'جزائرية', 0, 1);
  await option(gSauce, 'Samourai', 'ساموراي', 0, 2);
  await option(gSauce, 'Harissa', 'هريسة', 0, 3);
  await option(gSauce, 'Blanche', 'بيضاء', 0, 4);
  const gExtra = await group(tacosPoulet, 'Supplements', 'إضافات', 0, 4, 3);
  await option(gExtra, 'Fromage', 'جبن', 500, 1);
  await option(gExtra, 'Oeuf', 'بيضة', 400, 2);
  await option(gExtra, 'Double viande', 'لحم مضاعف', 1500, 3);

  const tacosViande = await product(r1, cTacos, 'Tacos viande hachee', 'طاكوس كفتة',
    'Viande hachee, cheddar, frites', 'كفتة، شيدر، بطاطس', 4000, 2);
  const gSize2 = await group(tacosViande, 'Taille', 'الحجم', 1, 1, 1);
  await option(gSize2, 'M', 'متوسط', 0, 1);
  await option(gSize2, 'L', 'كبير', 1000, 2);

  await product(r1, cTacos, 'Tacos mixte XXL', 'طاكوس مكس XXL',
    'Poulet et viande hachee', 'دجاج وكفتة', 5500, 3);
  await product(r1, cDrinks, 'Coca 33cl', 'كوكا 33 سل', '', '', 1000, 1);
  await product(r1, cDrinks, 'Jus d orange frais', 'عصير برتقال طازج', '', '', 1500, 2);

  // --- Pizzeria Bella ---
  const cPizza = await category(r2, 'Pizzas', 'بيتزا', 1);
  const cPasta = await category(r2, 'Pates', 'معكرونة', 2);

  const margherita = await product(r2, cPizza, 'Pizza Margherita', 'بيتزا مارغريتا',
    'Tomate, mozzarella, basilic', 'طماطم، موزاريلا، ريحان', 5000, 1);
  const gPizzaSize = await group(margherita, 'Taille', 'الحجم', 1, 1, 1);
  await option(gPizzaSize, 'Petite', 'صغيرة', 0, 1);
  await option(gPizzaSize, 'Moyenne', 'متوسطة', 1500, 2);
  await option(gPizzaSize, 'Grande', 'كبيرة', 3000, 3);

  await product(r2, cPizza, 'Pizza Reine', 'بيتزا رين', 'Dinde fumee, champignons', 'ديك رومي مدخن، فطر', 6500, 2);
  await product(r2, cPizza, 'Pizza Fruits de mer', 'بيتزا فواكه البحر', 'Crevettes, calamars', 'روبيان، كاليماري', 8000, 3);
  await product(r2, cPasta, 'Penne arrabiata', 'بيني أرابياتا', 'Sauce tomate piquante', 'صلصة طماطم حارة', 4500, 1);

  /*
   * The two starter restaurants carry a hard-coded star rating like the demo
   * ten, so they get the same treatment: real rows behind the number.
   */
  await seedDemoReviews(r1, { rating_bp: 41000 }, at);
  await seedDemoReviews(r2, { rating_bp: 44000 }, at);

  await seedDemoRestaurants(at);

  // One example code so the promotions screen is not empty on day one.
  await store.run(
    `INSERT INTO promotions (code, description, description_ar, discount_type, discount_value,
      max_discount_cents, min_order_cents, funded_by, per_customer_limit, created_at)
     VALUES ('BIENVENUE10','10% sur la premiere commande','10% على الطلب الأول','percent',10,2000,3000,'platform',1,$1)`,
    [at]);

  return true;
}


/**
 * Inserts the ten demo restaurants with their owners, menus and dish options.
 * Called once, from seedIfEmpty, on a brand new database.
 */
async function seedDemoRestaurants(at) {
  for (const demo of DEMO_RESTAURANTS) {
    const ownerPwdHash = await hashPassword('resto1234');
    const ownerId = await store.insert(
      'INSERT INTO users (name, email, phone, password_hash, role, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [demo.owner.name, demo.owner.email, demo.owner.phone, ownerPwdHash, 'restaurant', at]);

    const restaurantId = await store.insert(
      `INSERT INTO restaurants (owner_user_id, name, name_ar, city, address, phone, description, description_ar,
        image_url, status, commission_rate_bp, delivery_fee_cents, min_order_cents, prep_minutes,
        service_type, min_prep_hours, delivery_days, delivery_slots, order_cutoff, cuisines, rating_bp, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [ownerId, demo.name, demo.name_ar, demo.city, demo.address, demo.phone,
       demo.description, demo.description_ar, demo.emoji || '',
       demo.commission_bp, demo.delivery_fee, demo.min_order, demo.prep,
       demo.service_type, demo.min_prep_hours || 0, demo.delivery_days || '',
       demo.delivery_slots || '', demo.order_cutoff || '', demo.cuisines, demo.rating_bp || 0, at]);

    let categorySort = 0;
    for (const cat of demo.categories) {
      categorySort += 1;
      const categoryId = await store.insert(
        'INSERT INTO categories (restaurant_id, name, name_ar, sort_order) VALUES ($1,$2,$3,$4)',
        [restaurantId, cat.name, cat.name_ar, categorySort]);

      let productSort = 0;
      for (const prod of cat.products) {
        productSort += 1;
        const productId = await store.insert(
          `INSERT INTO products (restaurant_id, category_id, name, name_ar, description, description_ar,
            price_cents, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [restaurantId, categoryId, prod.name, prod.name_ar,
           prod.description || '', prod.description_ar || '', prod.price, productSort, at]);

        let groupSort = 0;
        for (const grp of prod.groups || []) {
          groupSort += 1;
          const groupId = await store.insert(
            `INSERT INTO option_groups (product_id, name, name_ar, min_select, max_select, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [productId, grp.name, grp.name_ar, grp.min, grp.max, groupSort]);

          let optionSort = 0;
          for (const [name, nameAr, delta] of grp.options) {
            optionSort += 1;
            await store.insert(
              `INSERT INTO product_options (option_group_id, name, name_ar, price_delta_cents, sort_order)
               VALUES ($1,$2,$3,$4,$5)`,
              [groupId, name, nameAr, delta, optionSort]);
          }
        }
      }
    }

    await seedDemoReviews(restaurantId, demo, at);
  }
}

/*
 * A handful of reviews per demonstration restaurant.
 *
 * Without these, a demo card would show "4.6 stars" next to "0 reviews",
 * which is a number that means nothing — and a star rating nobody wrote is a
 * lie to whoever is looking at the demo. So the seeded average is made real:
 * rows are written, and the restaurant's rating and count are recomputed from
 * them like any other review.
 *
 * They carry no order_id, which is how they are told apart from a review a
 * customer actually left: those always have one.
 */
const DEMO_COMMENTS = [
  ['Commande arrivée chaude et en avance, rien à dire.', 'Fatima Z.'],
  ['Très bon, portions généreuses. Je recommande.', 'Youssef A.'],
  ['Bon rapport qualité-prix, livreur aimable.', 'Khadija M.'],
  ['Correct, mais un peu long un vendredi soir.', 'Omar B.'],
  ['Mes enfants adorent. On recommande chaque semaine.', 'Nadia E.'],
  ['Emballage soigné, tout était à la bonne température.', 'Rachid T.'],
  ['Savoureux. Le dessert valait le détour.', 'Salma K.'],
];

async function seedDemoReviews(restaurantId, demo, at) {
  const target = Number(demo.rating_bp || 0) / 10000;
  if (!target) return;

  /*
   * Ratings chosen so their average lands on the number the demo data asked
   * for: mostly that value rounded, with one neighbour either side so the
   * breakdown bars are not a single block.
   */
  const base = Math.max(1, Math.min(5, Math.round(target)));
  const ratings = [base, base, base, Math.max(1, base - 1), Math.min(5, base + 1), base];

  for (const [index, rating] of ratings.entries()) {
    const [comment, author] = DEMO_COMMENTS[(restaurantId + index) % DEMO_COMMENTS.length];
    await store.insert(
      `INSERT INTO reviews (order_id, customer_id, restaurant_id, rating, comment, customer_name, created_at)
       VALUES (NULL, NULL, $1, $2, $3, $4, $5)`,
      [restaurantId, rating, comment, author, at]);
  }

  const row = await store.get(
    'SELECT COUNT(*) AS c, COALESCE(SUM(rating), 0) AS total FROM reviews WHERE restaurant_id = $1',
    [restaurantId]);
  const count = Number(row.c || 0);
  await store.run('UPDATE restaurants SET rating_bp = $1, reviews_count = $2 WHERE id = $3',
    [count ? Math.round((Number(row.total) / count) * 10000) : 0, count, restaurantId]);
}
