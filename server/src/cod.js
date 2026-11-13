/*
 * Cash-on-delivery reconciliation.
 *
 * For one restaurant on one day:
 *   gross    = cash the restaurant took from customers (completed orders, minus refunds)
 *   expected = the platform's commission on that day — what the restaurant owes us
 *   declared = what the restaurant says it will hand over
 *   received = what we actually got
 *   difference = received − expected   (negative means short)
 */
import { store, nowIso } from './store.js';

export const COD_STATUSES = ['open', 'declared', 'received', 'reconciled', 'disputed'];

const dayBounds = (day) => [`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`];

/** Recompute the money figures for recent days and create any missing rows. */
export async function refreshCodDays(days = 14, restaurantId = null) {
  const today = new Date();
  const wanted = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today.getTime() - i * 86400000);
    wanted.push(date.toISOString().slice(0, 10));
  }

  for (const day of wanted) {
    const [from, to] = dayBounds(day);
    let sql = `SELECT restaurant_id,
                      COUNT(*) AS orders_count,
                      COALESCE(SUM(total_cents - refunded_cents),0) AS gross_cents,
                      COALESCE(SUM(commission_cents),0) AS expected_cents
               FROM orders
               WHERE status = 'completed' AND placed_at >= $1 AND placed_at <= $2`;
    const args = [from, to];
    if (restaurantId) { args.push(restaurantId); sql += ` AND restaurant_id = $${args.length}`; }
    sql += ' GROUP BY restaurant_id';

    for (const row of await store.all(sql, args)) {
      const existing = await store.get(
        'SELECT * FROM cod_days WHERE restaurant_id = $1 AND day = $2', [row.restaurant_id, day]);
      const gross = Number(row.gross_cents);
      const expected = Number(row.expected_cents);
      const count = Number(row.orders_count);

      if (!existing) {
        await store.run(
          `INSERT INTO cod_days (restaurant_id, day, gross_cents, orders_count, expected_cents, difference_cents, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [row.restaurant_id, day, gross, count, expected, -expected, nowIso()]);
      } else if (existing.status === 'open' || existing.status === 'declared') {
        // Figures still move while the day is not settled (a late refund, for instance).
        await store.run(
          `UPDATE cod_days SET gross_cents = $1, orders_count = $2, expected_cents = $3,
             difference_cents = received_cents - $3, updated_at = $4 WHERE id = $5`,
          [gross, count, expected, nowIso(), existing.id]);
      }
    }
  }
}

export async function codSummary() {
  const rows = await store.all('SELECT status, COUNT(*) AS c FROM cod_days GROUP BY status');
  const summary = Object.fromEntries(COD_STATUSES.map((s) => [s, 0]));
  for (const row of rows) summary[row.status] = Number(row.c);
  summary.pending = summary.open + summary.declared + summary.received;
  return summary;
}
