/*
 * Reports. Every figure is recomputed from the orders table on request —
 * nothing is cached, so a refund or a new order shows up immediately.
 */
import { store } from './store.js';

const bounds = (from, to) => [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`];
const num = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v) || 0]));

export async function summaryReport(from, to) {
  const [start, end] = bounds(from, to);
  const totals = await store.get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),0) AS completed,
            COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
            COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END),0) AS rejected,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN total_cents ELSE 0 END),0) AS revenue_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN commission_cents ELSE 0 END),0) AS commission_cents,
            COALESCE(SUM(refunded_cents),0) AS refunds_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN discount_cents ELSE 0 END),0) AS discounts_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' AND discount_funded_by = 'platform' THEN discount_cents ELSE 0 END),0) AS platform_discounts_cents,
            COALESCE(SUM(CASE WHEN status = 'completed' AND fulfillment_type = 'delivery' THEN 1 ELSE 0 END),0) AS delivery_orders,
            COALESCE(SUM(CASE WHEN status = 'completed' AND fulfillment_type = 'pickup' THEN 1 ELSE 0 END),0) AS pickup_orders
     FROM orders WHERE placed_at >= $1 AND placed_at <= $2`, [start, end]);
  const figures = num(totals);
  figures.average_order_cents = figures.completed ? Math.round(figures.revenue_cents / figures.completed) : 0;
  figures.net_revenue_cents = figures.commission_cents - figures.platform_discounts_cents;
  return figures;
}

export async function byRestaurantReport(from, to) {
  const [start, end] = bounds(from, to);
  const rows = await store.all(
    `SELECT r.id, r.name, r.city,
            COUNT(o.id) AS orders,
            COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.total_cents ELSE 0 END),0) AS revenue_cents,
            COALESCE(SUM(CASE WHEN o.status = 'completed' THEN o.commission_cents ELSE 0 END),0) AS commission_cents,
            COALESCE(SUM(o.refunded_cents),0) AS refunds_cents
     FROM restaurants r
     LEFT JOIN orders o ON o.restaurant_id = r.id AND o.placed_at >= $1 AND o.placed_at <= $2
     GROUP BY r.id, r.name, r.city ORDER BY revenue_cents DESC`, [start, end]);
  return rows.map((r) => ({ ...num(r), name: r.name, city: r.city }));
}

export async function byProductReport(from, to) {
  const [start, end] = bounds(from, to);
  const rows = await store.all(
    `SELECT i.name, r.name AS restaurant_name,
            COALESCE(SUM(i.quantity),0) AS units,
            COALESCE(SUM(i.line_total_cents),0) AS revenue_cents
     FROM order_items i
     JOIN orders o ON o.id = i.order_id
     JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.status = 'completed' AND o.placed_at >= $1 AND o.placed_at <= $2
     GROUP BY i.name, r.name ORDER BY units DESC LIMIT 100`, [start, end]);
  return rows.map((r) => ({ name: r.name, restaurant_name: r.restaurant_name, ...num({ units: r.units, revenue_cents: r.revenue_cents }) }));
}

/** A customer counts as new when their first ever order falls inside the range. */
export async function customersReport(from, to) {
  const [start, end] = bounds(from, to);
  const rows = await store.all(
    `SELECT customer_id, MIN(placed_at) AS first_order FROM orders GROUP BY customer_id`);
  const inRange = await store.all(
    `SELECT DISTINCT customer_id FROM orders WHERE placed_at >= $1 AND placed_at <= $2`, [start, end]);
  const firstById = new Map(rows.map((r) => [String(r.customer_id), r.first_order]));
  let fresh = 0;
  let returning = 0;
  for (const row of inRange) {
    const first = firstById.get(String(row.customer_id));
    if (first && first >= start && first <= end) fresh++;
    else returning++;
  }
  const spend = await store.get(
    `SELECT COALESCE(SUM(total_cents),0) AS revenue_cents, COUNT(DISTINCT customer_id) AS buyers
     FROM orders WHERE status = 'completed' AND placed_at >= $1 AND placed_at <= $2`, [start, end]);
  const figures = num(spend);
  return {
    new_customers: fresh,
    returning_customers: returning,
    active_customers: inRange.length,
    buyers: figures.buyers,
    revenue_per_customer_cents: figures.buyers ? Math.round(figures.revenue_cents / figures.buyers) : 0,
  };
}

export async function codReport(from, to) {
  const rows = await store.all(
    `SELECT c.status, COUNT(*) AS days,
            COALESCE(SUM(c.expected_cents),0) AS expected_cents,
            COALESCE(SUM(c.received_cents),0) AS received_cents,
            COALESCE(SUM(c.difference_cents),0) AS difference_cents
     FROM cod_days c WHERE c.day >= $1 AND c.day <= $2 GROUP BY c.status`, [from, to]);
  return rows.map((r) => ({ status: r.status, ...num({ days: r.days, expected_cents: r.expected_cents,
    received_cents: r.received_cents, difference_cents: r.difference_cents }) }));
}

/* Column names per report, so an empty period still exports a usable file. */
export const REPORT_HEADERS = {
  summary: ['orders', 'completed', 'cancelled', 'rejected', 'revenue_cents', 'commission_cents',
    'refunds_cents', 'discounts_cents', 'platform_discounts_cents', 'delivery_orders', 'pickup_orders',
    'average_order_cents', 'net_revenue_cents'],
  restaurants: ['id', 'name', 'city', 'orders', 'revenue_cents', 'commission_cents', 'refunds_cents'],
  products: ['name', 'restaurant_name', 'units', 'revenue_cents'],
  customers: ['new_customers', 'returning_customers', 'active_customers', 'buyers', 'revenue_per_customer_cents'],
  cod: ['status', 'days', 'expected_cents', 'received_cents', 'difference_cents'],
};

/** Turns any of the above into a CSV file. */
export function toCsv(rows, fallbackHeaders = []) {
  if (!Array.isArray(rows)) rows = [rows];
  if (!rows.length) return fallbackHeaders.join(',');
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n');
}
