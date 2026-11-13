import { api, toast } from './api.js';
import { el, kpi, panel, emptyState, on, money, esc, fmtDate,
         t, localName, toCents, fromCents, exportCsv, csvButton } from './admin-ui.js';

const codView = { restaurant_id: '', status: '', from: '', to: '' };
const setView = { restaurant_id: '' };

const COD_CSS = { open: '', declared: 'amber', received: 'blue', reconciled: 'green', disputed: 'red' };
const codChip = (s) => `<span class="badge ${COD_CSS[s] || ''}">${t(`cod.${s}`)}</span>`;

export async function renderCod(ctx) {
  try {
    const params = new URLSearchParams(Object.entries(codView).filter(([, v]) => v));
    const [{ days, totals, summary }, { restaurants }] = await Promise.all([
      api(`/admin/cod?${params}`), api('/admin/restaurants'),
    ]);

    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.cod')}</h2>
      <p class="sub">${t('cod.intro')}</p>

      <div class="kpi">
        ${kpi(t('cod.expectedTotal'), money(totals.expected_cents), t('cod.expectedHint'))}
        ${kpi(t('cod.declaredTotal'), money(totals.declared_cents))}
        ${kpi(t('cod.receivedTotal'), money(totals.received_cents))}
        ${kpi(t('cod.grossTotal'), money(totals.gross_cents), t('cod.grossHint'))}
        ${kpi(t('cod.disputed'), summary.disputed)}
      </div>

      <div class="panel mt">
        <div class="filters">
          <div><label>${t('a.restaurant')}</label><select id="cResto">
            <option value="">${t('a.allRestaurants')}</option>
            ${restaurants.map((r) => `<option value="${r.id}" ${String(codView.restaurant_id) === String(r.id) ? 'selected' : ''}>${localName(r)}</option>`).join('')}
          </select></div>
          <div><label>${t('r.status')}</label><select id="cStatus">
            <option value="">${t('o.allStatuses')}</option>
            ${['open', 'declared', 'received', 'reconciled', 'disputed'].map((s) =>
              `<option value="${s}" ${codView.status === s ? 'selected' : ''}>${t(`cod.${s}`)}</option>`).join('')}
          </select></div>
          <div><label>${t('o.from')}</label><input id="cFrom" type="date" value="${esc(codView.from)}"></div>
          <div><label>${t('o.to')}</label><input id="cTo" type="date" value="${esc(codView.to)}"></div>
          <div><label>&nbsp;</label><button class="primary" id="cApply">${t('a.search')}</button></div>
          <div><label>&nbsp;</label>${csvButton('codCsv')}</div>
        </div>
      </div>

      <div class="panel mt">
        ${days.length ? `<table>
          <thead><tr><th>${t('cod.day')}</th><th>${t('a.restaurant')}</th><th>${t('cod.orders')}</th>
            <th>${t('cod.gross')}</th><th>${t('cod.expected')}</th><th>${t('cod.declared')}</th>
            <th>${t('cod.received')}</th><th>${t('cod.difference')}</th><th>${t('r.status')}</th><th></th></tr></thead>
          <tbody>${days.map((d) => {
            const diff = Number(d.difference_cents);
            return `<tr>
            <td class="small"><b>${esc(d.day)}</b></td>
            <td class="small">${localName(d, 'restaurant_name')}</td>
            <td class="small">${d.orders_count}</td>
            <td class="small muted">${money(d.gross_cents)}</td>
            <td class="price">${money(d.expected_cents)}</td>
            <td class="small">${Number(d.declared_cents) ? money(d.declared_cents) : '—'}</td>
            <td class="small">${Number(d.received_cents) ? money(d.received_cents) : '—'}</td>
            <td class="small" style="color:${diff < 0 ? '#a3231a' : diff > 0 ? 'var(--green)' : 'inherit'}">${money(diff)}</td>
            <td>${codChip(d.status)}${d.note ? `<div class="small muted">${esc(d.note)}</div>` : ''}</td>
            <td class="right">
              ${d.status !== 'reconciled' ? `<button class="small" data-codreceive="${d.id}" data-expected="${fromCents(d.expected_cents)}">${t('cod.recordCash')}</button>` : ''}
              ${d.status === 'received' || d.status === 'disputed' ? `<button class="primary small" data-codreconcile="${d.id}">${t('cod.reconcile')}</button>` : ''}
              ${d.status !== 'disputed' && d.status !== 'reconciled' ? `<button class="danger small" data-coddispute="${d.id}">${t('cod.dispute')}</button>` : ''}
            </td></tr>`;
          }).join('')}</tbody></table>` : emptyState('💰', t('cod.none'))}
      </div>`;

    document.getElementById('cApply').onclick = () => {
      codView.restaurant_id = document.getElementById('cResto').value;
      codView.status = document.getElementById('cStatus').value;
      codView.from = document.getElementById('cFrom').value;
      codView.to = document.getElementById('cTo').value;
      renderCod(ctx);
    };

    document.getElementById('codCsv').onclick = () => exportCsv('/admin/cod', codView, 'caisse');

    on('codreceive', async (id, node) => {
      const value = prompt(t('cod.howMuchReceived'), node.dataset.expected);
      if (value === null) return;
      const cents = toCents(value);
      if (!Number.isInteger(cents) || cents < 0) return toast(t('a.invalidValue'), true);
      const note = prompt(t('cod.noteOptional')) || '';
      try {
        await api(`/admin/cod/${id}/received`, { method: 'POST', body: {
          amount_cents: cents, note, idempotency_key: `cod-recv-${id}-${Date.now()}` } });
        toast(t('cod.saved'));
        renderCod(ctx);
      } catch (e) { toast(e.message, true); }
    });

    on('codreconcile', async (id) => {
      try {
        await api(`/admin/cod/${id}/reconcile`, { method: 'POST', body: {} });
        toast(t('cod.reconciled'));
        renderCod(ctx);
      } catch (e) { toast(e.message, true); }
    });

    on('coddispute', async (id) => {
      const note = prompt(t('cod.disputeReason'));
      if (!note) return;
      try {
        await api(`/admin/cod/${id}/dispute`, { method: 'POST', body: { note } });
        renderCod(ctx);
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

export async function renderSettlements(ctx) {
  try {
    const params = new URLSearchParams(Object.entries(setView).filter(([, v]) => v));
    const [{ settlements, totals }, { restaurants }] = await Promise.all([
      api(`/admin/settlements?${params}`), api('/admin/restaurants'),
    ]);
    const month = new Date().toISOString().slice(0, 7);

    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.settlements')}</h2>
      <p class="sub">${t('set.intro')}</p>

      <div class="kpi">
        ${kpi(t('set.openTotal'), money(totals.open_cents))}
        ${kpi(t('set.paidTotal'), money(totals.paid_cents))}
        ${kpi(t('set.count'), settlements.length)}
      </div>

      <div class="panel mt">
        <h3>${t('set.create')}</h3>
        <div class="filters">
          <div><label>${t('a.restaurant')}</label><select id="sResto">
            ${restaurants.map((r) => `<option value="${r.id}">${localName(r)}</option>`).join('')}
          </select></div>
          <div><label>${t('o.from')}</label><input id="sFrom" type="date" value="${month}-01"></div>
          <div><label>${t('o.to')}</label><input id="sTo" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div><label>${t('set.adjustments')}</label><input id="sAdj" type="number" step="0.5" value="0"></div>
          <div><label>&nbsp;</label><button id="sPreview">${t('set.preview')}</button></div>
          <div><label>&nbsp;</label><button class="primary" id="sCreate">${t('set.generate')}</button></div>
          <div><label>&nbsp;</label>${csvButton('setCsv')}</div>
        </div>
        <div id="previewBox" class="small muted mt"></div>
      </div>

      <div class="panel mt">
        ${settlements.length ? `<table>
          <thead><tr><th>${t('set.period')}</th><th>${t('a.restaurant')}</th><th>${t('set.orders')}</th>
            <th>${t('set.gross')}</th><th>${t('a.commission')}</th><th>${t('d.refunds')}</th>
            <th>${t('set.adjustments')}</th><th>${t('set.netPayable')}</th><th>${t('r.status')}</th><th></th></tr></thead>
          <tbody>${settlements.map((s) => `<tr>
            <td class="small"><b>${esc(s.period_start)}</b><div class="muted">→ ${esc(s.period_end)}</div></td>
            <td class="small">${localName(s, 'restaurant_name')}</td>
            <td class="small">${s.orders_count}</td>
            <td class="small muted">${money(s.gross_cents)}</td>
            <td class="small">${money(s.commission_cents)}</td>
            <td class="small muted">${money(s.refunds_cents)}</td>
            <td class="small muted">${money(s.adjustments_cents)}</td>
            <td class="price">${money(s.net_payable_cents)}</td>
            <td><span class="badge ${s.status === 'paid' ? 'green' : s.status === 'approved' ? 'blue' : s.status === 'cancelled' ? 'red' : 'amber'}">${t(`set.${s.status}`)}</span>
              ${s.paid_at ? `<div class="small muted">${fmtDate(s.paid_at)}</div>` : ''}</td>
            <td class="right">
              ${s.status === 'draft' ? `<button class="small" data-setstatus="${s.id}" data-to="approved">${t('set.approve')}</button>` : ''}
              ${s.status !== 'paid' && s.status !== 'cancelled' ? `<button class="primary small" data-setstatus="${s.id}" data-to="paid">${t('set.markPaid')}</button>` : ''}
            </td></tr>`).join('')}</tbody></table>` : emptyState('🧮', t('set.none'))}
      </div>`;

    const readForm = () => ({
      restaurant_id: Number(document.getElementById('sResto').value),
      from: document.getElementById('sFrom').value,
      to: document.getElementById('sTo').value,
      adjustments_cents: toCents(document.getElementById('sAdj').value),
    });

    document.getElementById('sPreview').onclick = async () => {
      const f = readForm();
      try {
        const p = await api(`/admin/settlements/preview?restaurant_id=${f.restaurant_id}&from=${f.from}&to=${f.to}`);
        document.getElementById('previewBox').innerHTML =
          `${t('set.orders')}: <b>${p.orders_count}</b> · ${t('set.gross')}: <b>${money(p.gross_cents)}</b> · ` +
          `${t('a.commission')}: <b>${money(p.commission_cents)}</b> · ${t('d.refunds')}: <b>${money(p.refunds_cents)}</b> · ` +
          `${t('set.netPayable')}: <b>${money(p.net_payable_cents - f.adjustments_cents)}</b>`;
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('sCreate').onclick = async () => {
      const f = readForm();
      try {
        await api('/admin/settlements', { method: 'POST', body: {
          restaurant_id: f.restaurant_id, period_start: f.from, period_end: f.to,
          adjustments_cents: f.adjustments_cents,
          idempotency_key: `set-${f.restaurant_id}-${f.from}-${f.to}-${Date.now()}` } });
        toast(t('set.created'));
        renderSettlements(ctx);
      } catch (e) { toast(e.message, true); }
    };

    document.getElementById('setCsv').onclick = () => exportCsv('/admin/settlements', setView, 'reglements');

    on('setstatus', async (id, node) => {
      if (node.dataset.to === 'paid' && !confirm(t('set.confirmPaid'))) return;
      try {
        await api(`/admin/settlements/${id}/status`, { method: 'POST', body: {
          status: node.dataset.to, idempotency_key: `set-st-${id}-${node.dataset.to}-${Date.now()}` } });
        renderSettlements(ctx);
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
