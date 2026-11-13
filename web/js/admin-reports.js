import { api, getToken, toast } from './api.js';
import { el, kpi, panel, emptyState, money, esc, t, localName } from './admin-ui.js';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;
const range = { from: monthStart(), to: today() };

/** CSV needs the token, so it is fetched then handed to the browser as a download. */
async function downloadCsv(report) {
  const url = `/api/admin/reports?report=${report}&from=${range.from}&to=${range.to}&format=csv`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${report}-${range.from}_${range.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } catch (e) { toast(e.message, true); }
}

export async function renderReports(ctx) {
  try {
    const d = await api(`/admin/reports?from=${range.from}&to=${range.to}`);
    const s = d.summary;

    const csvButton = (report) => `<button class="small" data-csv="${report}">${t('rep.csv')}</button>`;

    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.reports')}</h2>
      <div class="panel">
        <div class="filters">
          <div><label>${t('o.from')}</label><input id="rFrom" type="date" value="${esc(range.from)}"></div>
          <div><label>${t('o.to')}</label><input id="rTo" type="date" value="${esc(range.to)}"></div>
          <div><label>&nbsp;</label><button class="primary" id="rApply">${t('rep.apply')}</button></div>
          <div><label>&nbsp;</label><button id="rMonth">${t('rep.thisMonth')}</button></div>
          <div><label>&nbsp;</label><button id="rToday">${t('rep.today')}</button></div>
        </div>
      </div>

      <div class="kpi mt">
        ${kpi(t('rep.orders'), s.orders, `${s.completed} ${t('rep.completed')}`)}
        ${kpi(t('rep.revenue'), money(s.revenue_cents))}
        ${kpi(t('rep.commission'), money(s.commission_cents))}
        ${kpi(t('rep.netRevenue'), money(s.net_revenue_cents), t('a.afterDiscounts'))}
        ${kpi(t('rep.refunds'), money(s.refunds_cents))}
        ${kpi(t('rep.average'), money(s.average_order_cents))}
      </div>
      <div class="kpi mt">
        ${kpi(t('rep.cancelled'), s.cancelled)}
        ${kpi(t('rep.rejected'), s.rejected)}
        ${kpi(t('orders.delivery'), s.delivery_orders)}
        ${kpi(t('orders.pickup'), s.pickup_orders)}
        ${kpi(t('rep.discounts'), money(s.discounts_cents))}
      </div>
      <div class="row mt">${csvButton('summary')}</div>

      ${panel(t('rep.byRestaurant'), d.by_restaurant.length ? `<table>
        <thead><tr><th>${t('a.restaurant')}</th><th>${t('a.city')}</th><th>${t('rep.orders')}</th>
          <th>${t('rep.revenue')}</th><th>${t('a.commission')}</th><th>${t('d.refunds')}</th></tr></thead>
        <tbody>${d.by_restaurant.map((r) => `<tr>
          <td class="small"><b>${esc(r.name)}</b></td>
          <td class="small muted">${esc(r.city || '—')}</td>
          <td class="small">${r.orders}</td>
          <td class="price">${money(r.revenue_cents)}</td>
          <td class="small">${money(r.commission_cents)}</td>
          <td class="small muted">${money(r.refunds_cents)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('rep.noData')}</div>`, csvButton('restaurants'))}

      ${panel(t('rep.byProduct'), d.by_product.length ? `<table>
        <thead><tr><th>${t('cat.product')}</th><th>${t('a.restaurant')}</th><th>${t('cat.units')}</th><th>${t('rep.revenue')}</th></tr></thead>
        <tbody>${d.by_product.map((p) => `<tr>
          <td class="small">${esc(p.name)}</td>
          <td class="small muted">${esc(p.restaurant_name)}</td>
          <td class="small"><b>${p.units}</b></td>
          <td class="price">${money(p.revenue_cents)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('rep.noData')}</div>`, csvButton('products'))}

      ${panel(t('rep.customers'), `
        <div class="kpi">
          ${kpi(t('rep.newCustomers'), d.customers.new_customers)}
          ${kpi(t('rep.returning'), d.customers.returning_customers)}
          ${kpi(t('rep.active'), d.customers.active_customers)}
          ${kpi(t('rep.perCustomer'), money(d.customers.revenue_per_customer_cents))}
        </div>`, csvButton('customers'))}

      ${panel(t('rep.codSummary'), d.cod.length ? `<table>
        <thead><tr><th>${t('r.status')}</th><th>${t('rep.days')}</th><th>${t('cod.expected')}</th>
          <th>${t('cod.received2')}</th><th>${t('cod.difference')}</th></tr></thead>
        <tbody>${d.cod.map((c) => `<tr>
          <td class="small">${t(`cod.${c.status}`)}</td>
          <td class="small">${c.days}</td>
          <td class="price">${money(c.expected_cents)}</td>
          <td class="small">${money(c.received_cents)}</td>
          <td class="small">${money(c.difference_cents)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('rep.noData')}</div>`, csvButton('cod'))}
    `;

    const apply = () => {
      range.from = document.getElementById('rFrom').value || range.from;
      range.to = document.getElementById('rTo').value || range.to;
      renderReports(ctx);
    };
    document.getElementById('rApply').onclick = apply;
    document.getElementById('rMonth').onclick = () => { range.from = monthStart(); range.to = today(); renderReports(ctx); };
    document.getElementById('rToday').onclick = () => { range.from = today(); range.to = today(); renderReports(ctx); };
    document.querySelectorAll('[data-csv]').forEach((b) => { b.onclick = () => downloadCsv(b.dataset.csv); });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
