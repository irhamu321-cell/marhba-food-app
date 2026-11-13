import { api, toast } from './api.js';
import { el, kpi, panel, emptyState, on, money, esc, fmtDate, statusBadge,
         t, localName, exportCsv, csvButton } from './admin-ui.js';

const customers = { query: '', role: '', id: null };

export async function renderCustomers(ctx) {
  const handed = ctx.takeSearch?.();
  if (handed) { customers.query = handed; customers.id = null; }
  else if (ctx.takeFresh?.()) customers.id = null;

  if (customers.id) return renderCustomerProfile(ctx);
  try {
    const { users, counts } = await api(
      `/admin/users?q=${encodeURIComponent(customers.query)}${customers.role ? `&role=${customers.role}` : ''}`);
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.customers')}</h2>
      <div class="panel">
        <div class="filters">
          <div style="flex:1;min-width:220px"><label>${t('a.search')}</label>
            <input id="uSearch" value="${esc(customers.query)}" placeholder="${t('a.searchUser')}" style="width:100%"></div>
          <div><label>${t('a.role')}</label><select id="uRole">
            <option value="">${t('a.allRoles')}</option>
            <option value="customer" ${customers.role === 'customer' ? 'selected' : ''}>${t('a.roleCustomer')} (${counts.customers})</option>
            <option value="restaurant" ${customers.role === 'restaurant' ? 'selected' : ''}>${t('a.roleRestaurant')} (${counts.restaurants})</option>
            <option value="admin" ${customers.role === 'admin' ? 'selected' : ''}>${t('a.roleAdmin')} (${counts.admins})</option>
          </select></div>
          <div><label>&nbsp;</label><button class="primary" id="uSearchBtn">${t('a.search')}</button></div>
          <div><label>&nbsp;</label>${csvButton('usersCsv')}</div>
        </div>
      </div>

      <div class="panel mt">
        ${users.length ? `<table>
          <thead><tr><th>${t('a.user')}</th><th>${t('a.role')}</th><th>${t('a.ordersCount')}</th>
            <th>${t('a.spent')}</th><th>${t('a.registered')}</th><th>${t('a.status')}</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td><b>${esc(u.name)}</b>
              <div class="small muted">${esc(u.phone || '—')}${u.email ? ` · ${esc(u.email)}` : ''}</div>
              ${u.restaurant_name ? `<div class="small muted">🍴 ${esc(u.restaurant_name)}</div>` : ''}</td>
            <td class="small">${u.role === 'customer' ? t('a.roleCustomer') : u.role === 'restaurant' ? t('a.roleRestaurant') : t('a.roleAdmin')}</td>
            <td class="small">${u.orders_count}</td>
            <td class="small price">${money(u.spent_cents)}</td>
            <td class="small muted">${fmtDate(u.created_at)}</td>
            <td><span class="badge ${u.status === 'active' ? 'green' : 'red'}">${u.status === 'active' ? t('a.activeUser') : t('a.suspended')}</span></td>
            <td class="right"><button class="small" data-profile="${u.id}">${t('cu.profile')}</button></td>
          </tr>`).join('')}</tbody></table>` : emptyState('👥', t('a.noUsers'))}
      </div>`;

    const search = () => {
      customers.query = document.getElementById('uSearch').value.trim();
      customers.role = document.getElementById('uRole').value;
      renderCustomers(ctx);
    };
    document.getElementById('uSearchBtn').onclick = search;
    document.getElementById('uSearch').onkeydown = (e) => { if (e.key === 'Enter') search(); };
    document.getElementById('uRole').onchange = search;
    document.getElementById('usersCsv').onclick = () =>
      exportCsv('/admin/users', { q: customers.query, role: customers.role }, 'comptes');
    on('profile', (id) => { customers.id = Number(id); renderCustomerProfile(ctx); });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

async function renderCustomerProfile(ctx) {
  try {
    const d = await api(`/admin/customers/${customers.id}`);
    const u = d.user;
    const canManage = ctx.can('customers.manage');

    el().innerHTML = `
      <button class="ghost small" id="backCustomers">${t('cu.backToList')}</button>
      <div class="row between" style="margin-top:8px">
        <h2 style="margin:0">${esc(u.name)}
          <span class="badge ${u.status === 'active' ? 'green' : 'red'}">${u.status === 'active' ? t('a.activeUser') : t('a.suspended')}</span></h2>
      </div>
      <p class="sub">${esc(u.phone || '—')}${u.email ? ` · ${esc(u.email)}` : ''} · ${t('cu.registered')} ${fmtDate(u.created_at)}</p>

      <div class="kpi">
        ${kpi(t('a.ordersCount'), d.stats.orders_count)}
        ${kpi(t('a.spent'), money(d.stats.spent_cents))}
        ${kpi(t('cu.cancelled'), d.stats.cancelled_count)}
        ${kpi(t('d.refunds'), money(d.stats.refunded_cents))}
        ${kpi(t('cu.lastOrder'), d.stats.last_order_at ? fmtDate(d.stats.last_order_at) : '—')}
        ${kpi(t('rs.lastLogin'), u.last_login_at ? fmtDate(u.last_login_at) : '—')}
      </div>

      ${canManage && u.role !== 'admin' ? `<div class="panel mt">
        <div class="row wrap" style="gap:8px">
          <button class="${u.status === 'active' ? 'danger' : 'primary'} small"
                  data-ustatus="${u.id}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">
            ${u.status === 'active' ? t('a.suspendUser') : t('a.reactivate')}</button>
          <button class="small" data-ureset="${u.id}">${t('a.resetPassword')}</button>
        </div>
        <div class="small muted mt">${t('cu.suspendNote')}</div>
      </div>` : ''}

      ${panel(`${t('cu.orderHistory')} (${d.orders.length})`, d.orders.length ? `<table>
        <thead><tr><th>${t('r.order')}</th><th>${t('a.restaurant')}</th><th>${t('r.date')}</th>
          <th>${t('r.total')}</th><th>${t('a.refundCol')}</th><th>${t('r.status')}</th></tr></thead>
        <tbody>${d.orders.map((o) => `<tr>
          <td class="small">${esc(o.order_number)}</td>
          <td class="small">${localName(o, 'restaurant_name')}</td>
          <td class="small muted">${fmtDate(o.placed_at)}</td>
          <td class="price">${money(o.total_cents)}</td>
          <td class="small">${Number(o.refunded_cents) ? money(o.refunded_cents) : '—'}</td>
          <td>${statusBadge(o.status)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('orders.empty')}</div>`)}

      ${panel(`${t('nav.refunds')} (${d.refunds.length})`, d.refunds.length ? d.refunds.map((f) => `
        <div class="listrow"><div class="grow">${esc(f.order_number)}
          <div class="small muted">${esc(f.reason || '—')} · ${fmtDate(f.created_at)}</div></div>
          <div class="price">${money(f.amount_cents)}</div></div>`).join('')
        : `<div class="small muted">${t('a.noRefunds')}</div>`)}

      ${panel(`${t('nav.messages')} (${d.messages.length})`, d.messages.length ? d.messages.map((m) => `
        <div class="listrow"><div class="grow"><b>${esc(m.subject || '—')}</b>
          <div class="small muted">${esc(m.message).slice(0, 160)}</div></div>
          <div class="small muted">${fmtDate(m.created_at)}</div></div>`).join('')
        : `<div class="small muted">${t('a.noMessages')}</div>`)}
    `;

    document.getElementById('backCustomers').onclick = () => { customers.id = null; renderCustomers(ctx); };

    on('ustatus', async (id, node) => {
      if (node.dataset.to === 'suspended' && !confirm(t('a.confirmSuspend'))) return;
      try {
        await api(`/admin/users/${id}/status`, { method: 'POST', body: { status: node.dataset.to } });
        toast(t('a.userUpdated'));
        renderCustomerProfile(ctx);
      } catch (e) { toast(e.message, true); }
    });
    on('ureset', async (id) => {
      if (!confirm(t('a.confirmReset'))) return;
      try {
        const res = await api(`/admin/users/${id}/reset-password`, { method: 'POST', body: {} });
        alert(t('a.tempPassword', { pw: res.temporary_password }));
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

export async function renderSupport(ctx) {
  try {
    const { messages } = await api('/admin/support');
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.messages')}</h2>
      ${messages.length ? messages.map((m) => `
      <div class="panel">
        <div class="row between">
          <div>
            <h3 style="margin:0">${esc(m.subject || t('help.message'))}
              <span class="badge ${m.status === 'open' ? 'amber' : 'green'}">${m.status === 'open' ? t('a.openLabel') : t('a.handledLabel')}</span>
            </h3>
            <div class="small muted">${esc(m.name)} · ${esc(m.phone)}${m.order_number ? ` · ${esc(m.order_number)}` : ''} · ${fmtDate(m.created_at)}</div>
          </div>
        </div>
        <p class="small" style="white-space:pre-wrap;margin:10px 0">${esc(m.message)}</p>
        <div class="row wrap" style="gap:8px">
          <a class="small" href="tel:${esc(m.phone)}">📞 ${t('a.callCustomer')}</a>
          <a class="small" href="https://wa.me/212${esc(String(m.phone).replace(/^0/, ''))}" target="_blank" rel="noopener">💬 ${t('a.whatsapp')}</a>
          <button class="small" data-handled="${m.id}" style="margin-inline-start:auto">
            ${m.status === 'open' ? t('a.markHandled') : t('a.reopen')}</button>
        </div>
      </div>`).join('') : emptyState('📬', t('a.noMessages'))}`;

    on('handled', async (id) => {
      try { await api(`/admin/support/${id}/handled`, { method: 'POST', body: {} }); renderSupport(ctx); }
      catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

const staffView = { actionsFor: null };

export async function renderStaff(ctx) {
  try {
    const { staff, roles } = await api('/admin/staff');
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.staff')}</h2>
      <p class="sub">${t('st2.intro')}</p>

      <div class="panel">
        <h3>${t('st2.add')}</h3>
        <div class="grid two">
          <div><label>${t('auth.name')}</label><input id="stName"></div>
          <div><label>${t('auth.phone')}</label><input id="stPhone" placeholder="0612345678"></div>
        </div>
        <div class="grid two">
          <div><label>${t('auth.emailOptional')}</label><input id="stEmail" type="email"></div>
          <div><label>${t('auth.passwordNew')}</label><input id="stPass" type="password"></div>
        </div>
        <label>${t('st2.role')}</label>
        <select id="stRole">${roles.map((r) => `<option value="${r}">${t(`role.${r}`)}</option>`).join('')}</select>
        <div class="small muted mt">${t('st2.roleHelp')}</div>
        <button class="primary mt" id="stAdd">${t('st2.create')}</button>
      </div>

      <div class="panel mt">
        <table>
          <thead><tr><th>${t('a.user')}</th><th>${t('st2.role')}</th><th>${t('rs.lastLogin')}</th>
            <th>${t('st2.actions')}</th><th>${t('a.status')}</th><th></th></tr></thead>
          <tbody>${staff.map((u) => `<tr>
            <td><b>${esc(u.name)}</b><div class="small muted">${esc(u.phone || '')}${u.email ? ` · ${esc(u.email)}` : ''}</div></td>
            <td><select data-role="${u.id}" style="width:auto">
              ${roles.map((r) => `<option value="${r}" ${u.admin_role === r ? 'selected' : ''}>${t(`role.${r}`)}</option>`).join('')}
            </select></td>
            <td class="small muted">${u.last_login_at ? fmtDate(u.last_login_at) : '—'}</td>
            <td class="small">${u.actions_count}
              <button class="ghost small" data-stactions="${u.id}">${t('st2.see')}</button></td>
            <td><span class="badge ${u.status === 'active' ? 'green' : 'red'}">${u.status === 'active' ? t('a.activeUser') : t('a.suspended')}</span></td>
            <td class="right">
              <button class="${u.status === 'active' ? 'danger' : 'primary'} small"
                data-ststatus="${u.id}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">
                ${u.status === 'active' ? t('st2.deactivate') : t('a.reactivate')}</button>
            </td></tr>`).join('')}</tbody></table>
      </div>

      <div id="staffActions"></div>`;

    document.getElementById('stAdd').onclick = async () => {
      try {
        await api('/admin/staff', { method: 'POST', body: {
          name: document.getElementById('stName').value.trim(),
          phone: document.getElementById('stPhone').value.trim(),
          email: document.getElementById('stEmail').value.trim(),
          password: document.getElementById('stPass').value,
          admin_role: document.getElementById('stRole').value } });
        toast(t('st2.created'));
        renderStaff(ctx);
      } catch (e) { toast(e.message, true); }
    };

    document.querySelectorAll('[data-role]').forEach((select) => {
      select.onchange = async () => {
        try {
          await api(`/admin/staff/${select.dataset.role}`, { method: 'PUT', body: { admin_role: select.value } });
          toast(t('st2.updated'));
          renderStaff(ctx);
        } catch (e) { toast(e.message, true); renderStaff(ctx); }
      };
    });

    on('ststatus', async (id, node) => {
      try {
        await api(`/admin/staff/${id}`, { method: 'PUT', body: { status: node.dataset.to } });
        toast(t('st2.updated'));
        renderStaff(ctx);
      } catch (e) { toast(e.message, true); }
    });

    on('stactions', async (id) => {
      try {
        const { actions } = await api(`/admin/staff/${id}/actions`);
        document.getElementById('staffActions').innerHTML = panel(t('st2.recentActions'),
          actions.length ? actions.map((a) => `
            <div class="listrow"><div class="grow"><b>${esc(a.action)}</b>
              <span class="muted">${esc(a.resource_type)} ${a.resource_id ?? ''}</span></div>
              <div class="small muted">${fmtDate(a.created_at)}</div></div>`).join('')
            : `<div class="small muted">${t('d.noActions')}</div>`);
        document.getElementById('staffActions').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
