// Reset to demo data:  node src/seed.js --reset
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectStore, store, ROOT } from './store.js';
import { loadEnv } from './env.js';
import { createSchema, seedIfEmpty } from './schema.js';

loadEnv(ROOT);
const reset = process.argv.includes('--reset');
const connection = await connectStore();

if (reset) {
  if (connection.driver === 'sqlite') {
    await store.close();
    for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
      const p = join(ROOT, 'data', f);
      if (existsSync(p)) rmSync(p);
    }
    console.log('Base SQLite supprimee.');
    await connectStore();
  } else {
    for (const table of ['audit_logs', 'refunds', 'order_item_options', 'order_items', 'order_status_history',
      'orders', 'product_options', 'option_groups', 'products', 'categories', 'restaurants', 'users']) {
      await store.run(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    console.log('Tables PostgreSQL supprimees.');
  }
}

await createSchema();
console.log(await seedIfEmpty() ? 'Donnees de demonstration creees.' : 'La base contient deja des donnees.');
await store.close();
