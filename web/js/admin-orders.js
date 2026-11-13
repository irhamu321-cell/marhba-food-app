import { api, toast } from './api.js';
import { el, kpi, panel, pageHead, emptyState, on, money, esc, fmtDate, statusBadge,
         t, lang, localName, exportCsv, csvButton, tableCard, serviceBadge } from './admin-ui.js';

const EMPTY_FILTERS = { q: '', status: '', fulfillment: '', service: '', restaurant_id: '', from: '', to: '' };
const view = { id: null, filters: { ...EMPTY_FILTERS } };

const STATUSES = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled'];

export async function renderOrders(ctx) {
  const handed = ctx.takeSearch?.();
  if (handed) { view.filters = { ...EMPTY_FILTERS, q: handed }; view.id = null; }
  else if (ctx.takeFresh?.()) view.id = null;

  if (view.id) return renderOrderDetail(ctx);
  try {
    const f = view.filters;
    const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const [{ orders, totals }, { restaurants }] = await Promise.all([
      api(`/admin/orders?${params}`), api('/admin/restaurants'),
    ]);

    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.orders')}</h2>
      <div class="panel">
        <div class="filters">
          <div style="flex:1;min-width:200px">
            <label>${t('o.search')}</label>
            <input id="fq" value="${esc(f.q)}" placeholder="${t('o.searchHint')}" style="width:100%">
          </div>
          <div><label>${t('r.status')}</label><select id="fstatus">
            <option value="">${t('o.allStatuses')}</option>
            ${STATUSES.map((s) => `<option value="${s}" ${f.status === s ? 'selected' : ''}>${t(`status.${s}`)}</option>`).join('')}
            <option value="refunded" ${f.status === 'refunded' ? 'selected' : ''}>${t('o.refundedOnly')}</option>
          </select></div>
          <div><label>${t('a.mode')}</label><select id="ffulfil">
            <option value="">${t('o.allModes')}</option>
            <option value="pickup" ${f.fulfillment === 'pickup' ? 'selected' : ''}>${t('orders.pickup')}</option>
            <option value="delivery" ${f.fulfillment === 'delivery' ? 'selected' : ''}>${t('orders.delivery')}</option>
          </select></div>
          <div><label>${t('svc.type')}</label><select id="fservice">
            <option value="">${t('filter.allServices')}</option>
            <option value="immediate" ${f.service === 'immediate' ? 'selected' : ''}>${t('svc.immediate')}</option>
            <option value="preorder" ${f.service === 'preorder' ? 'selected' : ''}>${t('svc.preorder')}</option>
          </select></div>
          <div><label>${t('a.restaurant')}</label><select id="fresto">
            <option value="">${t('a.allRestaurants')}</option>
            ${restaurants.map((r) => `<option value="${r.id}" ${String(f.restaurant_id) === String(r.id) ? 'selected' : ''}>${localName(r)}</option>`).join('')}
          </select></div>
          <div><label>${t('o.from')}</label><input id="ffrom" type="date" value="${esc(f.from)}"></div>
          <div><label>${t('o.to')}</label><input id="fto" type="date" value="${esc(f.to)}"></div>
          <div><label>&nbsp;</label><button class="primary" id="applyFilters">${t('a.search')}</button></div>
          <div><label>&nbsp;</label><button id="clearFilters">${t('o.clear')}</button></div>
          <div><label>&nbsp;</label>${csvButton('ordersCsv')}</div>
        </div>
      </div>

      <div class="kpi mt">
        ${kpi(t('o.found'), totals.count)}
        ${kpi(t('r.total'), money(totals.total_cents))}
        ${kpi(t('a.commission'), money(totals.commission_cents))}
        ${kpi(t('d.refunds'), money(totals.refunded_cents))}
      </div>

      <div class="panel mt">
        ${orders.length ? `<table>
          <thead><tr><th>${t('r.order')}</th><th>${t('a.restaurant')}</th><th>${t('a.client')}</th>
            <th>${t('svc.type')}</th><th>${t('a.mode')}</th><th>${t('r.total')}</th>
            <th>${t('a.refundCol')}</th><th>${t('r.status')}</th><th></th></tr></thead>
          <tbody>${orders.map((o) => `<tr>
            <td class="small"><b>${esc(o.order_number)}</b>${o.special_instructions
              ? ` <span class="badge amber" title="${esc(o.special_instructions)}">\u26a0\ufe0f</span>` : ''}
              <div class="muted">${fmtDate(o.placed_at)}</div></td>
            <td class="small">${localName(o, 'restaurant_name')}</td>
            <td class="small">${esc(o.customer_name)}<div class="muted">${esc(o.customer_phone)}</div></td>
            <td class="small">${serviceBadge(o)}${o.scheduled_for
              ? `<div class="tiny muted">${esc(o.scheduled_for)}${o.scheduled_slot ? ` · ${esc(o.scheduled_slot)}` : ''}</div>` : ''}</td>
            <td class="small">${o.fulfillment_type === 'delivery' ? t('orders.delivery') : t('orders.pickup')}
              ${o.delivery ? `<div class="tiny muted truncate" style="max-width:170px">${esc(o.delivery.city)}</div>` : ''}</td>
            <td class="price">${money(o.total_cents)}</td>
            <td class="small">${Number(o.refunded_cents) ? money(o.refunded_cents) : '—'}</td>
            <td>${statusBadge(o.status)}</td>
            <td class="right"><button class="small" data-order="${o.id}">${t('o.open')}</button></td>
          </tr>`).join('')}</tbody></table>` : emptyState('🧾', t('orders.empty'), t('common.noneSub'))}
      </div>`;

    const read = () => ({
      q: document.getElementById('fq').value.trim(),
      status: document.getElementById('fstatus').value,
      fulfillment: document.getElementById('ffulfil').value,
      service: document.getElementById('fservice').value,
      restaurant_id: document.getElementById('fresto').value,
      from: document.getElementById('ffrom').value,
      to: document.getElementById('fto').value,
    });
    document.getElementById('applyFilters').onclick = () => { view.filters = read(); renderOrders(ctx); };
    document.getElementById('clearFilters').onclick = () => {
      view.filters = { ...EMPTY_FILTERS };
      renderOrders(ctx);
    };
    document.getElementById('fq').onkeydown = (e) => { if (e.key === 'Enter') { view.filters = read(); renderOrders(ctx); } };
    document.getElementById('ordersCsv').onclick = () => exportCsv('/admin/orders', view.filters, 'commandes');
    on('order', (id) => { view.id = Number(id); renderOrderDetail(ctx); });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

/*
 * The delivery address exactly as the order froze it.
 *
 * This is the record of where the food went, not a view of the customer's
 * current address book: a customer who moves house, or deletes the address,
 * does not change what this panel says. Coordinates are shown in full here
 * because this is the screen someone uses to settle a delivery dispute.
 */
function deliveryPanel(o) {
  const d = o.delivery;
  if (!d) {
    return panel(t('o.deliveryAddress'),
      `<div class="small muted">${esc(o.delivery_address || t('o.noAddress'))}</div>
       <div class="small muted">${esc(t('o.legacyOrder'))}</div>`);
  }
  return panel(t('o.deliveryAddress'), `
    <div class="row between" style="gap:10px;align-items:flex-start">
      <div class="grow">
        <div class="small"><b>${esc(d.recipient_name)}</b> · ${esc(d.recipient_phone)}</div>
        ${d.block.map((line) => `<div class="small muted">${esc(line)}</div>`).join('')}
        ${d.has_pin ? `<div class="small muted">${esc(t('o.pin'))}: ${esc(d.lat)}, ${esc(d.lng)}</div>` : ''}
      </div>
      ${d.map_link ? `<a class="ghost small btn-like" href="${esc(d.map_link)}"
        target="_blank" rel="noopener noreferrer">🗺️ ${esc(t('r.openMap'))}</a>` : ''}
    </div>`);
}

async function renderOrderDetail(ctx) {
  try {
    const { order: o, customer, notes } = await api(`/admin/orders/${view.id}`);
    const refundable = o.status === 'completed' && Number(o.refunded_cents) < Number(o.total_cents);
    const cancellable = !['completed', 'cancelled', 'rejected'].includes(o.status);

    el().innerHTML = `
      <button class="ghost small" id="backOrders">${t('o.backToList')}</button>
      <div class="row between" style="margin-top:8px">
        <h2 style="margin:0">${esc(o.order_number)} ${statusBadge(o.status)}</h2>
        <div class="price" style="font-size:20px">${money(o.total_cents)}</div>
      </div>
      <p class="sub">${fmtDate(o.placed_at)} · ${o.fulfillment_type === 'delivery' ? t('orders.delivery') : t('orders.pickup')}</p>

      ${o.special_instructions ? `<div class="alert warn">
        <span class="ic">\u26a0\ufe0f</span>
        <div><strong>${t('o.allergy')}</strong><br>${esc(o.special_instructions)}</div></div>` : ''}

      ${o.fulfillment_type === 'delivery' ? deliveryPanel(o) : ''}

      <div class="grid two">
        ${panel(t('a.client'), `
          <div class="small"><b>${esc(o.customer_name)}</b></div>
          <div class="small muted">${esc(o.customer_phone)}</div>
          ${o.note ? `<div class="small muted">📝 ${esc(o.note)}</div>` : ''}
          <div class="small muted mt">${t('o.customerSince')} ${fmtDate(customer?.created_at)} · ${t('o.ordersTotal')}: ${customer?.orders_count ?? 0}</div>`)}
        ${panel(t('a.restaurant'), `
          <div class="small"><b>${localName(o, 'restaurant_name')}</b></div>
          <div class="small muted">${esc(o.restaurant_phone || '')}</div>
          <div class="small muted">${esc(o.restaurant_address || '')} ${esc(o.restaurant_city || '')}</div>`)}
      </div>

      ${panel(t('o.items'), `
        ${o.items.map((i) => `
          <div class="listrow">
            <div class="grow">
              <b>${i.quantity} × ${localName(i)}</b>
              ${(i.options || []).filter((x) => !x.is_removal).length
                ? `<div class="small muted">\u21b3 ${(i.options || []).filter((x) => !x.is_removal).map((x) => localName(x)).join(' \u00b7 ')}</div>` : ''}
              ${(i.options || []).filter((x) => x.is_removal).length
                ? `<div class="small" style="color:var(--red);font-weight:600">\u2715 ${t('o.removed')}: ${(i.options || []).filter((x) => x.is_removal).map((x) => localName(x)).join(' \u00b7 ')}</div>` : ''}
              ${i.note ? `<div class="small muted">📝 ${esc(i.note)}</div>` : ''}
            </div>
            <div class="price">${money(i.line_total_cents)}</div>
          </div>`).join('')}
        <div class="totals">
          <div class="row"><span class="muted">${t('cart.subtotal')}</span><span class="price">${money(o.items_subtotal_cents)}</span></div>
          <div class="row"><span class="muted">${t('cart.deliveryFee')}</span><span class="price">${money(o.delivery_fee_cents)}</span></div>
          ${Number(o.discount_cents) ? `<div class="row"><span class="muted">${t('cart.discount')} ${o.promo_code ? `(${esc(o.promo_code)}, ${o.discount_funded_by === 'platform' ? t('a.fundedPlatform') : t('a.fundedRestaurant')})` : ''}</span><span class="price">−${money(o.discount_cents)}</span></div>` : ''}
          <div class="row grand"><span>${t('r.total')}</span><span class="price">${money(o.total_cents)}</span></div>
          <div class="row"><span class="muted">${t('a.commission')} (${(o.commission_rate_bp / 100).toFixed(2)}%)</span><span class="price">${money(o.commission_cents)}</span></div>
          <div class="row"><span class="muted">${t('rs.net')}</span><span class="price">${money(o.restaurant_net_cents)}</span></div>
          ${Number(o.refunded_cents) ? `<div class="row"><span style="color:var(--green)">${t('d.refunds')}</span><span class="price" style="color:var(--green)">${money(o.refunded_cents)}</span></div>` : ''}
        </div>`)}

      <div class="row wrap mt" style="gap:8px">
        ${refundable && ctx.can('refunds.create')
          ? `<button class="primary small" data-dorefund="${o.id}" data-max="${(Number(o.total_cents) - Number(o.refunded_cents)) / 100}">${t('a.refund')}</button>` : ''}
        ${cancellable && ctx.can('orders.cancel')
          ? `<button class="danger small" data-docancel="${o.id}">${t('o.cancelOrder')}</button>` : ''}
      </div>

      ${panel(t('o.history'), o.history.map((h) => `
        <div class="listrow"><div class="grow">
          ${h.from_status ? `${t(`status.${h.from_status}`)} → ` : ''}<b>${t(`status.${h.to_status}`)}</b>
          ${h.note ? `<div class="small muted">${esc(h.note)}</div>` : ''}
        </div><div class="small muted">${fmtDate(h.created_at)}</div></div>`).join(''))}

      ${panel(t('o.refundHistory'), o.refunds.length ? o.refunds.map((f) => `
        <div class="listrow"><div class="grow">${money(f.amount_cents)}
          <div class="small muted">${esc(f.reason || '—')}</div></div>
          <div class="small muted">${fmtDate(f.created_at)}</div></div>`).join('')
        : `<div class="small muted">${t('a.noRefunds')}</div>`)}

      ${panel(t('o.internalNotes'), `
        ${notes.length ? notes.map((n) => `
          <div class="listrow"><div class="grow">${esc(n.note)}
            <div class="small muted">${esc(n.author_name || n.author_email || '—')} · ${fmtDate(n.created_at)}</div></div></div>`).join('')
          : `<div class="small muted">${t('o.noNotes')}</div>`}
        ${ctx.can('orders.note') ? `
          <div class="row mt" style="gap:8px">
            <input id="noteText" placeholder="${t('o.notePlaceholder')}" style="flex:1">
            <button class="primary" id="addNote">${t('o.addNote')}</button>
          </div>` : ''}`)}
    `;

    document.getElementById('backOrders').onclick = () => { view.id = null; renderOrders(ctx); };

    on('dorefund', async (id, node) => {
      const value = prompt(t('a.refundPrompt', { max: node.dataset.max }), node.dataset.max);
      if (value === null) return;
      const cents = Math.round(Number(String(value).replace(',', '.')) * 100);
      if (!Number.isInteger(cents) || cents <= 0) return toast(t('a.invalidValue'), true);
      const reason = prompt(t('a.refundReason')) || '';
      try {
        await api(`/admin/orders/${id}/refund`, { method: 'POST', body: {
          amount_cents: cents, reason, idempotency_key: `ui-${id}-${Date.now()}` } });
        toast(t('a.refundDone'));
        renderOrderDetail(ctx);
      } catch (e) { toast(e.message, true); }
    });

    on('docancel', async (id) => {
      const reason = prompt(t('o.cancelReason'));
      if (!reason) return;
      try {
        await api(`/admin/orders/${id}/cancel`, { method: 'POST', body: { reason } });
        toast(t('o.cancelled'));
        renderOrderDetail(ctx);
      } catch (e) { toast(e.message, true); }
    });

    if (ctx.can('orders.note')) {
      document.getElementById('addNote').onclick = async () => {
        const note = document.getElementById('noteText').value.trim();
        if (note.length < 2) return;
        try {
          await api(`/admin/orders/${o.id}/notes`, { method: 'POST', body: { note } });
          renderOrderDetail(ctx);
        } catch (e) { toast(e.message, true); }
      };
    }
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

export async function renderRefunds(ctx) {
  try {
    const { refunds, total_cents: total } = await api('/admin/refunds');
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.refunds')}</h2>
      <div class="kpi">
        ${kpi(t('a.refundsTotal'), money(total))}
        ${kpi(t('o.refundCount'), refunds.length)}
      </div>
      <div class="panel mt">
        ${refunds.length ? `<table>
          <thead><tr><th>${t('a.refundWhen')}</th><th>${t('a.refundOrder')}</th><th>${t('a.restaurant')}</th>
            <th>${t('a.client')}</th><th>${t('a.refundAmount')}</th><th>${t('a.refundBy')}</th><th>${t('a.refundReason')}</th></tr></thead>
          <tbody>${refunds.map((r) => `<tr>
            <td class="small muted">${fmtDate(r.created_at)}</td>
            <td class="small">${esc(r.order_number)}<div class="muted">${money(r.total_cents)}</div></td>
            <td class="small">${localName(r, 'restaurant_name')}</td>
            <td class="small">${esc(r.customer_name)}<div class="muted">${esc(r.customer_phone)}</div></td>
            <td class="price">${money(r.amount_cents)}</td>
            <td class="small muted">${esc(r.by_name || r.by_email || '—')}</td>
            <td class="small muted">${esc(r.reason || '—')}</td>
          </tr>`).join('')}</tbody></table>` : emptyState('💸', t('a.noRefunds'))}
      </div>`;
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
