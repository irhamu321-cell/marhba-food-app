/*
 * Backup and restore.
 *
 * Runs on its own temporary database, so it never touches the real one:
 *   DB_PATH=<temp>/live.db
 *
 * It fills EVERY table, takes a backup, restores into a clean file, and checks
 * the result row by row. Then it feeds the restorer damaged backups and
 * requires each to be refused.
 *
 *   node test/backup.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workdir = mkdtempSync(join(tmpdir(), 'marhba-backup-'));
process.env.DB_PATH = join(workdir, 'live.db');
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'error';

const { connectStore, store, nowIso } = await import('../server/src/store.js');
const { createSchema } = await import('../server/src/schema.js');
const { runBackup, backupStatus, BACKUP_FORMAT } = await import('../server/src/backup.js');
const { restoreBackup, verifyRestore, readManifest, checkManifest, RestoreError } =
  await import('../server/src/restore.js');
const { hashPassword } = await import('../server/src/auth.js');

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
};
const section = (name) => console.log(`\n== ${name} ==`);

/** Expects the call to be refused, with that exact code. */
async function refuses(label, code, fn) {
  try {
    await fn();
    check(label, false, 'accepte alors qu elle aurait du etre refusee');
  } catch (error) {
    check(label, error instanceof RestoreError && error.code === code,
      `code=${error.code || error.message}`);
  }
}

try {
  section('Preparation');
  await connectStore();
  await createSchema();
  check('schema cree', (await store.tableNames()).length >= 20);

  const at = nowIso();

  /* ---- fill every table, in dependency order ---- */
  const adminId = await store.insert(
    `INSERT INTO users (name, email, phone, password_hash, role, admin_role, created_at)
     VALUES ($1,$2,$3,$4,'admin','super_admin',$5)`,
    ['Admin Test', 'admin@test.local', '0600000001', await hashPassword('motdepasse1'), at]);
  const ownerId = await store.insert(
    `INSERT INTO users (name, email, phone, password_hash, role, created_at)
     VALUES ($1,$2,$3,$4,'restaurant',$5)`,
    ['Proprio', 'owner@test.local', '0600000002', await hashPassword('motdepasse1'), at]);
  const clientId = await store.insert(
    `INSERT INTO users (name, email, phone, password_hash, role, created_at)
     VALUES ($1,$2,$3,$4,'customer',$5)`,
    ['Client', 'client@test.local', '0600000003', await hashPassword('motdepasse1'), at]);

  const restoId = await store.insert(
    `INSERT INTO restaurants (owner_user_id, name, name_ar, city, address, phone, status,
      commission_rate_bp, delivery_fee_cents, min_order_cents, prep_minutes, cuisines, created_at)
     VALUES ($1,'Resto Sauvegarde','مطعم','Kenitra','1 rue','0537000001','approved',1500,1000,0,20,'italienne',$2)`,
    [ownerId, at]);

  const catId = await store.insert(
    'INSERT INTO categories (restaurant_id, name, name_ar, sort_order) VALUES ($1,$2,$3,1)',
    [restoId, 'Plats', 'أطباق']);
  const prodId = await store.insert(
    `INSERT INTO products (restaurant_id, category_id, name, name_ar, description, description_ar,
      price_cents, sort_order, created_at) VALUES ($1,$2,'Plat test','طبق','','',5000,1,$3)`,
    [restoId, catId, at]);
  const groupId = await store.insert(
    'INSERT INTO option_groups (product_id, name, name_ar, min_select, max_select, sort_order) VALUES ($1,$2,$3,1,1,1)',
    [prodId, 'Taille', 'الحجم']);
  await store.insert(
    'INSERT INTO product_options (option_group_id, name, name_ar, price_delta_cents, sort_order) VALUES ($1,$2,$3,0,1)',
    [groupId, 'M', 'متوسط']);

  const promoId = await store.insert(
    `INSERT INTO promotions (code, description, description_ar, discount_type, discount_value,
      max_discount_cents, min_order_cents, funded_by, per_customer_limit, created_by, created_at)
     VALUES ('SAUVE10','10%','10%','percent',10,2000,0,'platform',1,$1,$2)`,
    [adminId, at]);

  const orderId = await store.insert(
    `INSERT INTO orders (order_number, customer_id, restaurant_id, fulfillment_type, status,
      customer_name, customer_phone, items_subtotal_cents, delivery_fee_cents, total_cents,
      commission_rate_bp, commission_cents, restaurant_net_cents, placed_at, updated_at)
     VALUES ('CMD-SAUVE-1',$1,$2,'delivery','completed','Client','0600000003',5000,1000,6000,1500,750,5250,$3,$3)`,
    [clientId, restoId, at]);
  const itemId = await store.insert(
    `INSERT INTO order_items (order_id, product_id, name, name_ar, base_price_cents,
      unit_price_cents, quantity, line_total_cents, note) VALUES ($1,$2,'Plat test','طبق',5000,5000,1,5000,'')`,
    [orderId, prodId]);
  await store.run(
    `INSERT INTO order_item_options (order_item_id, group_name, group_name_ar, name, name_ar, price_delta_cents)
     VALUES ($1,'Taille','الحجم','M','متوسط',0)`, [itemId]);
  await store.run(
    `INSERT INTO order_status_history (order_id, from_status, to_status, actor_user_id, note, created_at)
     VALUES ($1,null,'pending',$2,'Commande passee',$3)`, [orderId, clientId, at]);
  await store.run(
    'INSERT INTO order_notes (order_id, author_user_id, note, created_at) VALUES ($1,$2,$3,$4)',
    [orderId, adminId, 'Note interne', at]);
  await store.run(
    'INSERT INTO refunds (order_id, amount_cents, reason, created_by, created_at) VALUES ($1,500,$2,$3,$4)',
    [orderId, 'Geste commercial', adminId, at]);
  await store.run(
    'INSERT INTO promotion_uses (promotion_id, order_id, customer_id, discount_cents, created_at) VALUES ($1,$2,$3,500,$4)',
    [promoId, orderId, clientId, at]);

  await store.run(
    `INSERT INTO cod_days (restaurant_id, day, gross_cents, orders_count, expected_cents,
      declared_cents, received_cents, difference_cents, status, note, updated_at)
     VALUES ($1,'2026-11-01',6000,1,750,750,750,0,'reconciled','',$2)`, [restoId, at]);
  await store.run(
    `INSERT INTO settlements (restaurant_id, period_start, period_end, orders_count, gross_cents,
      commission_cents, refunds_cents, adjustments_cents, net_payable_cents, status, note, created_by, created_at)
     VALUES ($1,'2026-11-01','2026-11-02',1,6000,750,500,0,4750,'paid','',$2,$3)`, [restoId, adminId, at]);
  await store.run(
    `INSERT INTO support_messages (user_id, name, phone, email, order_number, subject, message, status, created_at)
     VALUES ($1,'Client','0600000003','','CMD-SAUVE-1','Question','Bonjour','open',$2)`, [clientId, at]);
  await store.run(
    `INSERT INTO audit_logs (actor_user_id, actor_role, action, resource_type, resource_id,
      details, ip, user_agent, before_state, after_state, created_at)
     VALUES ($1,'super_admin','test','order',$2,'{}','127.0.0.1','test','','',$3)`, [adminId, orderId, at]);
  await store.run(
    'INSERT INTO idempotency_keys (key, endpoint, response, created_at) VALUES ($1,$2,$3,$4)',
    ['cle-test', 'refund', '{"ok":true}', at]);
  await store.run(
    'INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1,$2,$3,$4)',
    ['default_commission_bp', '1500', at, adminId]);
  await store.run(
    `INSERT INTO auth_codes (purpose, channel, destination, code_hash, user_id, attempts,
      expires_at, created_ip, created_at)
     VALUES ('reset','phone','0600000003','scrypt$x$y',$1,0,$2,'127.0.0.1',$3)`,
    [clientId, at, at]);
  await store.run(
    `INSERT INTO customer_addresses (customer_id, label, label_custom, recipient_name,
      recipient_phone, city, street, building, floor, landmark, instructions,
      lat, lng, is_default, created_at, updated_at)
     VALUES ($1,'home','','Client Test','0661234567','Rabat','Avenue Hassan II, n 12',
      'Res. Al Amal','3e etage','Face a la pharmacie','Sonner deux fois',
      '34.020882','-6.84165',1,$2,$3)`,
    [clientId, at, at]);

  await store.run(
    `INSERT INTO reviews (order_id, customer_id, restaurant_id, rating, comment,
      customer_name, created_at)
     VALUES ($1,$2,$3,5,'Tres bon, livraison rapide.','Client Test',$4)`,
    [orderId, clientId, restoId, at]);

  const tables = await store.tableNames();
  const counts = await store.rowCounts();
  const empty = tables.filter((name) => counts[name] === 0);
  check(`toutes les tables contiennent des donnees (${tables.length} tables)`, empty.length === 0,
    `vides: ${empty.join(', ')}`);

  /* ---- the backup ---- */
  section('Sauvegarde');
  const result = await runBackup('test');
  check('fichier .db ecrit', existsSync(result.db), result.db);
  check('fichier .json ecrit', existsSync(result.json), result.json);
  check('manifeste au format courant', result.manifest.format === BACKUP_FORMAT);
  check('manifeste couvre toutes les tables', result.manifest.tables.length === tables.length,
    `${result.manifest.tables.length} vs ${tables.length}`);
  check('manifeste porte le schema', (result.manifest.schema_sql || '').includes('CREATE TABLE'));
  check('totaux par table enregistres',
    tables.every((name) => result.manifest.row_counts[name] === counts[name]));

  const status = backupStatus();
  check('etat: derniere sauvegarde reussie', !!status.last_success_at);
  check('etat: pas d erreur', status.last_error === '');
  check('etat: non perimee', status.stale === false);
  check('etat: nombre de tables rapporte', status.last_tables === tables.length);

  /* ---- restore from the .db snapshot ---- */
  section('Restauration depuis l instantane .db');
  const targetDb = join(workdir, 'restored-db.db');
  const reportDb = restoreBackup(result.db, targetDb);
  check('restauration acceptee', existsSync(targetDb));
  check('toutes les tables restaurees', reportDb.tables === tables.length,
    `${reportDb.tables} vs ${tables.length}`);
  check('toutes les lignes restaurees', reportDb.rows === result.manifest.total_rows,
    `${reportDb.rows} vs ${result.manifest.total_rows}`);
  check('aucun ecart par table',
    tables.every((name) => reportDb.checked[name] === counts[name]));

  /* ---- key records survive, not just counts ---- */
  const { DatabaseSync } = await import('node:sqlite');
  const restored = new DatabaseSync(targetDb);
  const order = restored.prepare('SELECT * FROM orders WHERE order_number = ?').get('CMD-SAUVE-1');
  check('la commande cle est restauree', !!order);
  check('les montants sont intacts',
    order.total_cents === 6000 && order.commission_cents === 750 && order.restaurant_net_cents === 5250,
    `${order?.total_cents}/${order?.commission_cents}/${order?.restaurant_net_cents}`);
  const option = restored.prepare('SELECT * FROM order_item_options LIMIT 1').get();
  check('les options de ligne sont restaurees', option && option.name === 'M');
  const settlement = restored.prepare('SELECT * FROM settlements LIMIT 1').get();
  check('le reglement est restaure', settlement && settlement.net_payable_cents === 4750);
  const cod = restored.prepare('SELECT * FROM cod_days LIMIT 1').get();
  check('la journee de caisse est restauree', cod && cod.status === 'reconciled');
  const arabic = restored.prepare('SELECT name_ar FROM restaurants LIMIT 1').get();
  check('l arabe survit a la restauration', arabic && arabic.name_ar === 'مطعم', arabic?.name_ar);
  restored.close();

  /* ---- restore from the JSON dump ---- */
  section('Restauration depuis le dump .json');
  const targetJson = join(workdir, 'restored-json.db');
  const reportJson = restoreBackup(result.json, targetJson);
  check('restauration JSON acceptee', existsSync(targetJson));
  check('JSON: toutes les tables', reportJson.tables === tables.length);
  check('JSON: toutes les lignes', reportJson.rows === result.manifest.total_rows,
    `${reportJson.rows} vs ${result.manifest.total_rows}`);
  const fromJson = new DatabaseSync(targetJson);
  const jsonOrder = fromJson.prepare('SELECT * FROM orders WHERE order_number = ?').get('CMD-SAUVE-1');
  check('JSON: la commande cle est restauree', !!jsonOrder && jsonOrder.total_cents === 6000);
  fromJson.close();

  /* ---- refusals ---- */
  section('Sauvegardes refusees');
  await refuses('fichier absent -> refus', 'missing',
    () => restoreBackup(join(workdir, 'nexistepas.db'), join(workdir, 'x1.db')));

  const emptyFile = join(workdir, 'vide.json');
  writeFileSync(emptyFile, '');
  await refuses('fichier vide -> refus', 'empty',
    () => restoreBackup(emptyFile, join(workdir, 'x2.db')));

  const brokenJson = join(workdir, 'casse.json');
  writeFileSync(brokenJson, '{ ceci n est pas du json');
  await refuses('JSON corrompu -> refus', 'corrupt',
    () => restoreBackup(brokenJson, join(workdir, 'x3.db')));

  const noManifest = join(workdir, 'sans-manifeste.json');
  writeFileSync(noManifest, JSON.stringify({ tables: {} }));
  await refuses('sans manifeste -> refus', 'no_manifest',
    () => restoreBackup(noManifest, join(workdir, 'x4.db')));

  const oldVersion = join(workdir, 'ancienne.json');
  writeFileSync(oldVersion, JSON.stringify({
    manifest: { format: 1, tables: ['users'], row_counts: { users: 3 } }, tables: { users: [] } }));
  await refuses('mauvaise version -> refus', 'version',
    () => restoreBackup(oldVersion, join(workdir, 'x5.db')));

  const incomplete = join(workdir, 'incomplete.json');
  const partial = JSON.parse(readFileSync(result.json, 'utf8'));
  delete partial.manifest.row_counts.orders;
  writeFileSync(incomplete, JSON.stringify(partial));
  await refuses('totaux manquants -> refus', 'incomplete',
    () => restoreBackup(incomplete, join(workdir, 'x6.db')));

  const missingRows = join(workdir, 'lignes-absentes.json');
  const stripped = JSON.parse(readFileSync(result.json, 'utf8'));
  delete stripped.tables.orders;
  writeFileSync(missingRows, JSON.stringify(stripped));
  await refuses('table absente du dump -> refus', 'incomplete',
    () => restoreBackup(missingRows, join(workdir, 'x7.db')));

  const truncated = join(workdir, 'tronquee.db');
  const bytes = readFileSync(result.db);
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 3)));
  copyFileSync(result.db.replace(/\.db$/, '.manifest.json'), truncated.replace(/\.db$/, '.manifest.json'));
  await refuses('instantane tronque -> refus', 'corrupt',
    () => restoreBackup(truncated, join(workdir, 'x8.db')));

  await refuses('cible existante sans --force -> refus', 'exists',
    () => restoreBackup(result.db, targetDb));
  const forced = restoreBackup(result.db, targetDb, { force: true });
  check('--force autorise l ecrasement', forced.tables === tables.length);

  /* ---- a restore that silently lost rows must be caught ---- */
  section('Detection d une restauration incomplete');
  const shortened = join(workdir, 'ampute.db');
  copyFileSync(result.db, shortened);
  const victim = new DatabaseSync(shortened);
  victim.exec('DELETE FROM order_notes');
  victim.close();
  try {
    verifyRestore(shortened, result.manifest);
    check('lignes manquantes detectees', false, 'aucune erreur levee');
  } catch (error) {
    check('lignes manquantes detectees', error.code === 'row_mismatch', error.code);
  }

  const noTable = join(workdir, 'table-absente.db');
  copyFileSync(result.db, noTable);
  const victim2 = new DatabaseSync(noTable);
  victim2.exec('DROP TABLE order_notes');
  victim2.close();
  try {
    verifyRestore(noTable, result.manifest);
    check('table manquante detectee', false, 'aucune erreur levee');
  } catch (error) {
    check('table manquante detectee', error.code === 'missing_table', error.code);
  }

  /* ---- the manifest readers on their own ---- */
  section('Lecture du manifeste');
  check('manifeste lu depuis un .db', readManifest(result.db).format === BACKUP_FORMAT);
  check('manifeste lu depuis un .json', readManifest(result.json).format === BACKUP_FORMAT);
  try {
    checkManifest({ format: BACKUP_FORMAT, tables: [], row_counts: {} });
    check('manifeste sans table refuse', false);
  } catch (error) { check('manifeste sans table refuse', error.code === 'incomplete'); }

  await store.close();
} catch (error) {
  console.error('Erreur du test:', error);
  fail++;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(`\n${'-'.repeat(50)}`);
console.log(`  ${pass} tests reussis, ${fail} echecs`);
if (failures.length) console.log(`  Echecs: ${failures.join(' | ')}`);
console.log(`${'-'.repeat(50)}\n`);
process.exit(fail ? 1 : 0);
