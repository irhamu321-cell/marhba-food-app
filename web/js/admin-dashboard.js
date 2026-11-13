import { api, toast } from './api.js';
import {
  el, kpi, panel, pageHead, emptyState, money, esc, fmtDate, t, localName, on,
  barChart, barList, tableCard, statusBadge, serviceBadge,
} from './admin-ui.js';

/** Short day label for the 7-day chart: "lun 02". */
function dayLabel(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${t(`dowShort.${date.getUTCDay()}`)} ${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** The shortcuts the admin reaches for most often. */
const QUICK_ACTIONS = [
  { key: 'restaurants', ic: '🏪', perm: 'restaurants.view' },
  { key: 'orders',      ic: '🧾', perm: 'orders.view' },
  { key: 'catalog',     ic: '📖', perm: 'restaurants.view' },
  { key: 'customers',   ic: '👥', perm: 'customers.view' },
  { key: 'reports',     ic: '📑', perm: 'reports.view' },
  { key: 'staff',       ic: '🧑‍💼', perm: 'staff.manage' },
  { key: 'settings',    ic: '⚙️', perm: 'settings.manage' },
];

export async function renderDashboard(ctx) {
  try {
    const d = await api('/admin/dashboard');
    const today = d.today;
    const yesterday = d.last7?.[d.last7.length - 2];

    // Compare today with yesterday so the number has context.
    let trend = null;
    if (yesterday) {
      const diff = Number(today.orders) - Number(yesterday.orders);
      trend = {
        dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        text: diff === 0 ? t('d.sameAsYesterday') : t('d.vsYesterday', { n: Math.abs(diff) }),
      };
    }

    const statuses = d.orders_by_status || {};
    const statusRows = [
      { label: t('status.pending'),   value: statuses.pending || 0,   tone: 'a' },
      { label: t('d.inKitchen'),      value: (statuses.accepted || 0) + (statuses.preparing || 0), tone: 'b' },
      { label: t('status.ready'),     value: statuses.ready || 0,     tone: '' },
      { label: t('status.completed'), value: statuses.completed || 0, tone: 'g' },
      { label: t('status.cancelled'), value: (statuses.cancelled || 0) + (statuses.rejected || 0), tone: 'r' },
    ];
    const anyStatus = statusRows.some((r) => r.value > 0);

    const quick = QUICK_ACTIONS.filter((a) => ctx.can(a.perm))
      .map((a) => `<button data-quick="${a.key}">${a.ic} ${esc(t(`nav.${a.key}`))}</button>`).join('');

    el().innerHTML = `
      ${pageHead(esc(t('nav.dashboard')), `${esc(t('d.today'))} — ${esc(d.today.date)}`,
        quick ? `<div class="btnrow">${quick}</div>` : '')}

      ${d.maintenance_mode ? `<div class="alert bad mb"><span class="ic">🚧</span><div>${esc(t('d.maintenanceOn'))}</div></div>` : ''}

      <div class="kpi mb">
        ${kpi(t('d.orders'), today.orders, '', { icon: '🧾', trend, accent: true })}
        ${kpi(t('d.revenue'), money(today.revenue_cents), esc(t('d.completedOnly')), { icon: '💰' })}
        ${kpi(t('d.commission'), money(today.commission_cents), '', { icon: '📈' })}
        ${kpi(t('d.refunds'), money(today.refunded_cents), '', { icon: '↩️' })}
        ${kpi(t('d.codToReconcile'), d.cod.pending, esc(t('d.codDaysWaiting')), { icon: '💵', go: 'cod' })}
      </div>

      <div class="grid two mb">
        ${panel(esc(t('d.last7days')), barChart((d.last7 || []).map((row) => ({
          label: dayLabel(row.day), value: row.orders, top: row.orders || '',
        }))))}
        ${panel(esc(t('d.ordersByStatus')), anyStatus
          ? barList(statusRows)
          : `<div class="small muted">${esc(t('d.noOrdersToday'))}</div>`)}
      </div>

      <h2>${esc(t('d.restaurantsAndCash'))}</h2>
      <div class="kpi mb">
        ${kpi(t('d.totalRestaurants'), d.restaurants.total ?? '—', '', { icon: '🏪', go: 'restaurants' })}
        ${kpi(t('d.activeRestaurants'), d.restaurants.active, '', { icon: '✅', go: 'restaurants' })}
        ${kpi(t('d.pendingApprovals'), d.restaurants.pending, '', { icon: '⏳', go: 'restaurants' })}
        ${kpi(t('d.openMessages'), d.open_support, '', { icon: '💬', go: 'messages' })}
        ${kpi(t('d.codDisputed'), d.cod.disputed, '', { icon: '⚠️', go: 'cod' })}
      </div>

      <h2>${esc(t('d.recentOrders'))}</h2>
      ${(d.recent_orders || []).length
        ? tableCard(
            [t('r.order'), t('a.restaurant'), t('a.client'), t('svc.type'), t('r.status'), { label: t('r.total'), num: true }],
            d.recent_orders.map((o) => `
              <tr data-openorder="${o.id}" style="cursor:pointer">
                <td><b>${esc(o.order_number)}</b><div class="tiny muted">${esc(fmtDate(o.placed_at))}</div></td>
                <td class="truncate">${localName({ name: o.restaurant_name, name_ar: o.restaurant_name_ar })}</td>
                <td class="truncate">${esc(o.customer_name || '—')}</td>
                <td>${serviceBadge(o)}${o.scheduled_for ? `<div class="tiny muted">${esc(o.scheduled_for)}</div>` : ''}</td>
                <td>${statusBadge(o.status)}</td>
                <td class="num">${money(o.total_cents)}</td>
              </tr>`))
        : emptyState('🧾', t('d.noOrdersYet'), t('d.noOrdersYetSub'))}

      <h2>${esc(t('d.needsYou'))}</h2>
      <div class="grid two">
        ${panel(esc(t('d.pendingApprovals')),
          d.pending_restaurants.length
            ? d.pending_restaurants.map((r) => `
              <div class="listrow">
                <div class="grow"><b>${localName(r)}</b>
                  <div class="small muted">${esc(r.city || '—')} · ${esc(r.owner_name)} · ${esc(r.owner_phone || '')}</div></div>
                <button class="primary small" data-goresto="${r.id}">${esc(t('d.review'))}</button>
              </div>`).join('')
            : `<div class="small muted">${esc(t('d.nothingPending'))}</div>`)}

        ${panel(esc(t('d.disputedDays')),
          d.disputed_cod_days.length
            ? d.disputed_cod_days.map((c) => `
              <div class="listrow">
                <div class="grow"><b>${esc(c.restaurant_name)}</b>
                  <div class="small muted">${esc(c.day)} · ${esc(t('d.difference'))}: ${money(c.difference_cents)}</div></div>
                <button class="small" data-gocod="${c.restaurant_id}">${esc(t('d.open'))}</button>
              </div>`).join('')
            : `<div class="small muted">${esc(t('d.noDisputes'))}</div>`)}

        ${panel(esc(t('d.recentRefunds')),
          d.recent_refunds.length
            ? d.recent_refunds.map((r) => `
              <div class="listrow">
                <div class="grow"><b>${money(r.amount_cents)}</b> · ${esc(r.order_number)}
                  <div class="small muted">${esc(r.restaurant_name)} · ${esc(r.reason || '—')} · ${esc(fmtDate(r.created_at))}</div></div>
              </div>`).join('')
            : `<div class="small muted">${esc(t('d.noRefunds'))}</div>`,
          `<button class="small" data-gorefunds="1">${esc(t('d.seeAll'))}</button>`)}

        ${panel(esc(t('d.recentActions')),
          d.recent_actions.length
            ? d.recent_actions.slice(0, 8).map((a) => `
              <div class="listrow">
                <div class="grow"><b>${esc(a.action)}</b> <span class="muted">${esc(a.resource_type)} ${a.resource_id ?? ''}</span>
                  <div class="small muted">${esc(a.actor_name || a.actor_email || '—')} · ${esc(fmtDate(a.created_at))}</div></div>
              </div>`).join('')
            : `<div class="small muted">${esc(t('d.noActions'))}</div>`)}
      </div>
    `;

    on('quick', (key) => ctx.go(key));
    on('kpigo', (key) => ctx.go(key));
    on('goresto', () => ctx.go('restaurants'));
    on('gocod', () => ctx.go('cod'));
    on('gorefunds', () => ctx.go('refunds'));
    on('openorder', () => ctx.go('orders'));
  } catch (e) {
    el().innerHTML = emptyState('⚠️', esc(e.message));
    toast(e.message, true);
  }
}
