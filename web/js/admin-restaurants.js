import { api, toast, uploadImage, wireImagePicker, imagePickerHtml } from './api.js';
import { el, kpi, panel, pageHead, emptyState, on, money, esc, fmtDate, statusBadge,
         t, lang, pick, localName, toCents, fromCents, tableCard,
         serviceBadge, serviceLabel, cuisineChips, cuisineLabels, stars,
         formatDays, formatSlots, $ } from './admin-ui.js';

const view = { id: null };
const filters = { status: '', service: '', cuisine: '', q: '' };

/** The cuisine tags, fetched once and reused by the filter and the edit form. */
let cuisineOptions = [];
async function loadCuisines() {
  if (cuisineOptions.length) return cuisineOptions;
  try { cuisineOptions = (await api('/cuisines')).cuisines; } catch { cuisineOptions = []; }
  return cuisineOptions;
}

const STATUS_CSS = { approved: 'green', pending: 'amber', suspended: 'red', rejected: 'red' };
const ADMIN_SERVICE_ERRORS = {
  min_prep_hours: 'svc.errPrep',
  delivery_slots: 'svc.errSlots',
  order_cutoff: 'svc.errCutoff',
};
const statusChip = (status) => `<span class="badge ${STATUS_CSS[status] || ''}">${t(`rs.${status}`)}</span>`;

export async function renderRestaurants(ctx) {
  // A search handed over from the top bar pre-fills this screen's search box.
  const handed = ctx.takeSearch?.();
  if (handed) { filters.q = handed; view.id = null; }
  // Clicking the sidebar entry returns to the list even if a record was open.
  else if (ctx.takeFresh?.()) view.id = null;

  if (view.id) return renderDetail(ctx);

  try {
    const cuisines = await loadCuisines();
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.service) params.set('service', filters.service);
    if (filters.cuisine) params.set('cuisine', filters.cuisine);
    if (filters.q) params.set('q', filters.q);
    const { restaurants } = await api(`/admin/restaurants${params.toString() ? `?${params}` : ''}`);

    el().innerHTML = `
      ${pageHead(esc(t('nav.restaurants')), t('rs.countSub', { n: restaurants.length }))}

      <div class="filterbar">
        <div class="filters">
          <div style="flex:1;min-width:200px">
            <label>${esc(t('common.search'))}</label>
            <input id="fQ" value="${esc(filters.q)}" placeholder="${esc(t('rs.searchHint'))}" style="width:100%">
          </div>
          <div><label>${esc(t('a.status'))}</label>
            <select id="fStatus">
              <option value="">${esc(t('o.allStatuses'))}</option>
              ${['pending', 'approved', 'suspended', 'rejected'].map((st) =>
                `<option value="${st}" ${filters.status === st ? 'selected' : ''}>${esc(t(`rs.${st}`))}</option>`).join('')}
            </select></div>
          <div><label>${esc(t('filter.service'))}</label>
            <select id="fService">
              <option value="">${esc(t('filter.allServices'))}</option>
              <option value="immediate" ${filters.service === 'immediate' ? 'selected' : ''}>${esc(t('svc.immediate'))}</option>
              <option value="preorder" ${filters.service === 'preorder' ? 'selected' : ''}>${esc(t('svc.preorder'))}</option>
            </select></div>
          <div><label>${esc(t('filter.cuisine'))}</label>
            <select id="fCuisine">
              <option value="">${esc(t('cuisine.all'))}</option>
              ${cuisines.map((c) => `<option value="${c.key}" ${filters.cuisine === c.key ? 'selected' : ''}>${
                esc(lang === 'ar' ? c.ar : c.fr)}</option>`).join('')}
            </select></div>
          <div><label>&nbsp;</label><button id="fReset">${esc(t('common.reset'))}</button></div>
        </div>
      </div>

      ${restaurants.length
        ? tableCard(
            [t('a.restaurant'), t('svc.type'), t('cuisine.label'), t('a.city'), t('a.commission'), t('a.status'), ''],
            restaurants.map((r) => `<tr>
              <td><b>${localName(r)}</b>
                <div class="small muted">${esc(r.owner_name)} · ${esc(r.phone || '')}</div></td>
              <td>${serviceBadge(r)}
                ${r.service_type === 'preorder' ? `<div class="tiny muted">${esc(formatDays(r))}</div>` : ''}</td>
              <td class="small">${cuisineLabels(r).length ? esc(cuisineLabels(r).join(', ')) : '<span class="muted">—</span>'}</td>
              <td class="small">${esc(r.city || '—')} ${r.is_open ? '🟢' : '⚪'}</td>
              <td class="small num">${(r.commission_rate_bp / 100).toFixed(2)} %</td>
              <td>${statusChip(r.status)}</td>
              <td><div class="actions"><button class="small" data-open="${r.id}">${esc(t('rs.manage'))}</button></div></td>
            </tr>`))
        : emptyState('🍴', t('rs.none'), t('common.noneSub'))}`;

    const reload = () => renderRestaurants(ctx);
    $('fStatus').onchange = () => { filters.status = $('fStatus').value; reload(); };
    $('fService').onchange = () => { filters.service = $('fService').value; reload(); };
    $('fCuisine').onchange = () => { filters.cuisine = $('fCuisine').value; reload(); };
    $('fReset').onclick = () => {
      filters.status = ''; filters.service = ''; filters.cuisine = ''; filters.q = '';
      reload();
    };
    let typing = null;
    $('fQ').oninput = () => {
      clearTimeout(typing);
      typing = setTimeout(() => { filters.q = $('fQ').value.trim(); reload(); }, 350);
    };
    $('fQ').onkeydown = (e) => {
      if (e.key === 'Enter') { clearTimeout(typing); filters.q = $('fQ').value.trim(); reload(); }
    };

    on('open', (id) => { view.id = Number(id); renderDetail(ctx); });
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

async function renderDetail(ctx) {
  try {
    const d = await api(`/admin/restaurants/${view.id}`);
    const r = d.restaurant;
    const canManage = ctx.can('restaurants.manage');
    const canCommission = ctx.can('restaurants.commission');
    const canCatalog = ctx.can('catalog.manage');
    const outstanding = d.balance.commission_cents - d.balance.settled_cents;
    await loadCuisines();
    const aImmediate = r.service_type !== 'preorder';
    const aDays = Array.isArray(r.delivery_day_numbers) ? r.delivery_day_numbers
      : String(r.delivery_days || '').split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));
    const aSlots = Array.isArray(r.delivery_slot_list) ? r.delivery_slot_list
      : String(r.delivery_slots || '').split(',').map((x) => x.trim()).filter(Boolean);
    const aCuisines = Array.isArray(r.cuisine_keys) ? r.cuisine_keys
      : String(r.cuisines || '').split(',').map((x) => x.trim()).filter(Boolean);

    el().innerHTML = `
      <button class="ghost small" id="backList">${t('rs.backToList')}</button>
      <div class="row between" style="margin-top:8px">
        <h2 style="margin:0">${localName(r)} ${statusChip(r.status)}</h2>
        ${canManage ? `<button class="small" data-toggleopen="${r.id}">${r.is_open ? t('rs.closeTemp') : t('rs.openNow')}</button>` : ''}
      </div>
      <p class="sub">${esc(r.city || '')} · ${esc(r.phone || '')} · ${esc(t('rs.since'))} ${esc(fmtDate(r.created_at))}</p>
      <div class="row wrap mb" style="gap:7px">
        ${serviceBadge(r)}
        ${cuisineChips(r)}
        ${stars(r.rating)}
      </div>
      ${r.service_type === 'preorder' ? `<div class="alert info mb"><span class="ic">📅</span><div class="small">
        <b>${esc(t('svc.prepTime'))}:</b> ${esc(t('svc.prepHours', { h: Number(r.min_prep_hours) }))}
        · <b>${esc(t('svc.days'))}:</b> ${esc(formatDays(r))}
        · <b>${esc(t('svc.slots'))}:</b> ${esc(formatSlots(r))}
        ${r.order_cutoff ? ` · <b>${esc(t('svc.cutoff'))}:</b> ${esc(r.order_cutoff)}` : ''}
      </div></div>` : ''}
      ${r.rejection_reason ? `<div class="banner bad mb">${esc(r.rejection_reason)}</div>` : ''}

      <div class="kpi">
        ${kpi(t('rs.completedOrders'), d.balance.completed_orders)}
        ${kpi(t('rs.gross'), money(d.balance.gross_cents))}
        ${kpi(t('rs.commissionOwed'), money(d.balance.commission_cents))}
        ${kpi(t('rs.settled'), money(d.balance.settled_cents))}
        ${kpi(t('rs.outstanding'), money(outstanding), t('rs.outstandingHint'))}
        ${kpi(t('d.refunds'), money(d.balance.refunded_cents))}
      </div>

      ${canManage ? `<div class="panel mt">
        <h3>${t('rs.status')}</h3>
        <div class="row wrap" style="gap:8px">
          ${r.status !== 'approved' ? `<button class="primary small" data-status="approved">${t('a.approve')}</button>` : ''}
          ${r.status === 'pending' ? `<button class="danger small" data-status="rejected">${t('rs.reject')}</button>` : ''}
          ${r.status === 'approved' ? `<button class="danger small" data-status="suspended">${t('a.suspend')}</button>` : ''}
          ${r.status === 'suspended' || r.status === 'rejected' ? `<button class="small" data-status="approved">${t('a.reactivate')}</button>` : ''}
        </div>
        <div class="small muted mt">${t('rs.suspendNote')}</div>
      </div>` : ''}

      ${panel(t('rs.owner'), `
        <div class="listrow"><div class="grow">
          <b>${esc(d.owner?.name || '—')}</b>
          <div class="small muted">${esc(d.owner?.phone || '')} ${d.owner?.email ? `· ${esc(d.owner.email)}` : ''}</div>
          <div class="small muted">${t('rs.lastLogin')}: ${d.owner?.last_login_at ? fmtDate(d.owner.last_login_at) : '—'}</div>
        </div>
        ${ctx.can('customers.manage') ? `<button class="ghost small" data-resetowner="${d.owner?.id}">${t('a.resetPassword')}</button>` : ''}
        </div>`)}

      ${canManage ? `<div class="panel">
        <h3>${t('rs.details')}</h3>
        <div class="grid two">
          <div><label>${t('r.restoName')}</label><input id="eName" value="${esc(r.name)}"></div>
          <div><label>${t('m.nameAr')}</label><input id="eNameAr" dir="rtl" value="${esc(r.name_ar)}"></div>
        </div>
        <div class="grid two">
          <div><label>${t('s.description')}</label><textarea id="eDesc" rows="2">${esc(r.description)}</textarea></div>
          <div><label>${t('m.descAr')}</label><textarea id="eDescAr" dir="rtl" rows="2">${esc(r.description_ar)}</textarea></div>
        </div>
        <div class="grid two">
          <div><label>${t('r.city')}</label><input id="eCity" value="${esc(r.city)}"></div>
          <div><label>${t('s.phone')}</label><input id="ePhone" value="${esc(r.phone)}"></div>
        </div>
        <label>${t('s.address')}</label><input id="eAddress" value="${esc(r.address)}">
        <label>${t('s.image')}</label>
        ${imagePickerHtml({ fileId: 'eImageFile', urlId: 'eImage', previewId: 'eImagePrev', value: r.image_url })}
        <div class="grid three mt">
          <div><label>${t('s.fee')}</label><input id="eFee" type="number" step="0.5" min="0" value="${fromCents(r.delivery_fee_cents)}"></div>
          <div><label>${t('s.minOrder')}</label><input id="eMin" type="number" step="0.5" min="0" value="${fromCents(r.min_order_cents)}"></div>
          <div><label>${t('s.prep')}</label><input id="ePrep" type="number" min="1" max="240" value="${r.prep_minutes}"></div>
        </div>
        <label class="inline-check" style="margin-top:12px"><input type="checkbox" id="ePickup" ${r.supports_pickup ? 'checked' : ''}> ${esc(t('s.pickup'))}</label>
        <label class="inline-check"><input type="checkbox" id="eDelivery" ${r.supports_delivery ? 'checked' : ''}> ${esc(t('s.delivery'))}</label>
        <div class="formactions"><button class="primary" id="saveResto">${esc(t('s.save'))}</button></div>
      </div>

      <div class="panel">
        <h3>${esc(t('svc.type'))} · ${esc(t('cuisine.label'))}</h3>

        <div class="segmented mb" id="aSvcSwitch">
          <button data-asvc="immediate" class="${aImmediate ? 'active' : ''}">⚡ ${esc(t('svc.immediate'))}</button>
          <button data-asvc="preorder" class="${aImmediate ? '' : 'active'}">📅 ${esc(t('svc.preorder'))}</button>
        </div>

        <div id="aSvcConfig" class="${aImmediate ? 'hidden' : ''}">
          <div class="formgrid">
            <div class="field">
              <label>${esc(t('svc.prepTime'))}</label>
              <select id="aPrepHours">
                ${[24, 48, 72].map((h) => `<option value="${h}" ${Number(r.min_prep_hours) === h ? 'selected' : ''}>${
                  esc(t('svc.prepHours', { h }))}</option>`).join('')}
                <option value="custom" ${![24, 48, 72].includes(Number(r.min_prep_hours)) && Number(r.min_prep_hours) ? 'selected' : ''}>${
                  esc(t('svc.prepCustom'))}</option>
              </select>
            </div>
            <div class="field">
              <label>${esc(t('svc.cutoff'))}</label>
              <input id="aCutoff" placeholder="18:00" value="${esc(r.order_cutoff || '')}">
            </div>
          </div>
          <div class="field ${[24, 48, 72].includes(Number(r.min_prep_hours)) || !Number(r.min_prep_hours) ? 'hidden' : ''}" id="aCustomHours">
            <label>${esc(t('svc.prepCustom'))}</label>
            <input id="aPrepCustom" type="number" min="1" max="720" value="${Number(r.min_prep_hours) || 24}">
          </div>
          <div class="field">
            <label>${esc(t('svc.days'))}</label>
            <div class="chips">
              ${[1, 2, 3, 4, 5, 6, 0].map((n) => `
                <label class="chip ${aDays.includes(n) ? 'active' : ''}" data-adaychip="${n}" style="cursor:pointer">
                  <input type="checkbox" class="hidden" id="aDay${n}" ${aDays.includes(n) ? 'checked' : ''}>
                  ${esc(t(`dowShort.${n}`))}</label>`).join('')}
            </div>
            <div class="help">${esc(t('svc.daysHelp'))}</div>
          </div>
          <div class="field">
            <label>${esc(t('svc.slots'))}</label>
            <textarea id="aSlots" rows="3" placeholder="11:00-13:00&#10;18:00-20:00">${esc(aSlots.join('\n'))}</textarea>
            <div class="help">${esc(t('svc.slotsHelp'))}</div>
          </div>
        </div>

        <div class="field">
          <label>${esc(t('cuisine.label'))}</label>
          <div class="chips">
            ${cuisineOptions.map((c) => `
              <label class="chip ${aCuisines.includes(c.key) ? 'active' : ''}" data-acuisine="${c.key}" style="cursor:pointer">
                <input type="checkbox" class="hidden" id="aCui_${c.key}" ${aCuisines.includes(c.key) ? 'checked' : ''}>
                ${esc(lang === 'ar' ? c.ar : c.fr)}</label>`).join('')}
          </div>
        </div>

        <div class="field" style="max-width:180px">
          <label>${esc(t('rs.rating'))}</label>
          <input id="aRating" type="number" step="0.1" min="0" max="5" value="${(Number(r.rating_bp || 0) / 10000).toFixed(1)}">
          <div class="help">${esc(t('rs.ratingHelp'))}</div>
        </div>

        <div class="formactions"><button class="primary" id="saveService">${esc(t('s.save'))}</button></div>
      </div>` : ''}

      ${canCommission ? `<div class="panel">
        <h3>${t('a.commission')}</h3>
        <div class="row" style="gap:8px">
          <input id="eComm" type="number" step="0.5" min="0" max="100" value="${(r.commission_rate_bp / 100).toFixed(2)}" style="max-width:140px">
          <span class="muted">%</span>
          <button class="primary" id="saveComm">${t('s.save')}</button>
        </div>
        <div class="small muted mt">${t('rs.commissionNote')}</div>
      </div>` : ''}

      ${panel(`${t('rs.menu')} (${d.products.length})`, d.products.length ? d.products.map((p) => `
        <div class="listrow">
          <div class="grow">
            <b>${localName(p)}</b> ${p.is_active ? '' : `<span class="badge red">${t('rs.unavailable')}</span>`}
            <div class="small muted">${esc(pick(p, 'description') || '')}</div>
            ${(p.option_groups || []).map((g) => `<div class="small muted">↳ ${localName(g)}: ${
              (g.options || []).map((o) => `${localName(o)}${o.price_delta_cents > 0 ? ` (+${money(o.price_delta_cents)})` : ''}`).join(', ') || '—'
            }</div>`).join('')}
          </div>
          <div class="price">${money(p.price_cents)}</div>
          ${canCatalog ? `<button class="small" data-avail="${p.id}" data-to="${p.is_active ? 0 : 1}">
            ${p.is_active ? t('rs.markUnavailable') : t('rs.markAvailable')}</button>` : ''}
        </div>`).join('') : `<div class="small muted">${t('rs.emptyMenu')}</div>`)}

      ${panel(`${t('rs.recentOrders')} (${d.orders.length})`, d.orders.length ? `<table>
        <thead><tr><th>${t('r.order')}</th><th>${t('r.date')}</th><th>${t('r.total')}</th>
          <th>${t('a.commission')}</th><th>${t('rs.net')}</th><th>${t('r.status')}</th></tr></thead>
        <tbody>${d.orders.map((o) => `<tr>
          <td class="small">${esc(o.order_number)}</td>
          <td class="small muted">${fmtDate(o.placed_at)}</td>
          <td class="price">${money(o.total_cents)}</td>
          <td class="small muted">${money(o.commission_cents)}</td>
          <td class="small">${money(o.restaurant_net_cents)}</td>
          <td>${statusBadge(o.status)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('rs.noOrders')}</div>`)}

      ${panel(`${t('nav.refunds')} (${d.refunds.length})`, d.refunds.length ? d.refunds.map((f) => `
        <div class="listrow"><div class="grow">${esc(f.order_number)}
          <div class="small muted">${esc(f.reason || '—')} · ${fmtDate(f.created_at)}</div></div>
          <div class="price">${money(f.amount_cents)}</div></div>`).join('')
        : `<div class="small muted">${t('a.noRefunds')}</div>`)}
    `;

    document.getElementById('backList').onclick = () => { view.id = null; renderRestaurants(ctx); };

    on('toggleopen', async (id) => {
      try { await api(`/admin/restaurants/${id}/open`, { method: 'POST', body: {} }); renderDetail(ctx); }
      catch (e) { toast(e.message, true); }
    });

    on('status', async (status) => {
      let reason = '';
      if (status === 'rejected' || status === 'suspended') {
        reason = prompt(status === 'rejected' ? t('rs.rejectReason') : t('rs.suspendReason')) || '';
        if (status === 'rejected' && !reason) return;
      }
      try {
        await api(`/admin/restaurants/${r.id}/status`, { method: 'POST', body: { status, reason } });
        toast(t('a.statusUpdated'));
        ctx.refresh();
      } catch (e) { toast(e.message, true); }
    });

    on('resetowner', async (id) => {
      if (!confirm(t('a.confirmReset'))) return;
      try {
        const res = await api(`/admin/users/${id}/reset-password`, { method: 'POST', body: {} });
        alert(t('a.tempPassword', { pw: res.temporary_password }));
      } catch (e) { toast(e.message, true); }
    });

    on('avail', async (id, node) => {
      try {
        await api(`/admin/products/${id}`, { method: 'PUT', body: { is_active: node.dataset.to === '1' } });
        toast(t('rs.productUpdated'));
        renderDetail(ctx);
      } catch (e) { toast(e.message, true); }
    });

    if (canManage) {
      wireImagePicker({ fileId: 'eImageFile', urlId: 'eImage', previewId: 'eImagePrev' });

      document.getElementById('saveResto').onclick = async () => {
        try {
          await api(`/admin/restaurants/${r.id}`, { method: 'PUT', body: {
            name: document.getElementById('eName').value.trim(),
            name_ar: document.getElementById('eNameAr').value.trim(),
            description: document.getElementById('eDesc').value.trim(),
            description_ar: document.getElementById('eDescAr').value.trim(),
            city: document.getElementById('eCity').value.trim(),
            phone: document.getElementById('ePhone').value.trim(),
            address: document.getElementById('eAddress').value.trim(),
            image_url: document.getElementById('eImage').value.trim(),
            delivery_fee_cents: toCents(document.getElementById('eFee').value),
            min_order_cents: toCents(document.getElementById('eMin').value),
            prep_minutes: Number(document.getElementById('ePrep').value || 20),
            supports_pickup: document.getElementById('ePickup').checked,
            supports_delivery: document.getElementById('eDelivery').checked,
          } });
          toast(t('s.saved'));
          renderDetail(ctx);
        } catch (e) { toast(e.message, true); }
      };

      // --- service type, cuisines, rating ---
      let chosenType = r.service_type === 'preorder' ? 'preorder' : 'immediate';
      document.querySelectorAll('[data-asvc]').forEach((button) => {
        button.onclick = () => {
          chosenType = button.dataset.asvc;
          document.querySelectorAll('[data-asvc]').forEach((b) =>
            b.classList.toggle('active', b.dataset.asvc === chosenType));
          $('aSvcConfig').classList.toggle('hidden', chosenType === 'immediate');
        };
      });
      document.querySelectorAll('[data-adaychip]').forEach((chip) => {
        chip.onclick = (event) => {
          event.preventDefault();
          const box = $(`aDay${chip.dataset.adaychip}`);
          box.checked = !box.checked;
          chip.classList.toggle('active', box.checked);
        };
      });
      document.querySelectorAll('[data-acuisine]').forEach((chip) => {
        chip.onclick = (event) => {
          event.preventDefault();
          const box = $(`aCui_${chip.dataset.acuisine}`);
          box.checked = !box.checked;
          chip.classList.toggle('active', box.checked);
        };
      });
      $('aPrepHours').onchange = () => {
        $('aCustomHours').classList.toggle('hidden', $('aPrepHours').value !== 'custom');
      };

      $('saveService').onclick = async () => {
        const body = {
          service_type: chosenType,
          cuisines: cuisineOptions.map((c) => c.key).filter((key) => $(`aCui_${key}`).checked),
          rating_bp: Math.round(Number(String($('aRating').value || 0).replace(',', '.')) * 10000),
        };
        if (body.rating_bp < 0 || body.rating_bp > 50000) return toast(t('a.invalidValue'), true);
        if (chosenType === 'preorder') {
          const picked = $('aPrepHours').value;
          body.min_prep_hours = picked === 'custom' ? Number($('aPrepCustom').value || 0) : Number(picked);
          body.delivery_days = [1, 2, 3, 4, 5, 6, 0].filter((n) => $(`aDay${n}`).checked);
          body.delivery_slots = $('aSlots').value.split('\n').map((x) => x.trim()).filter(Boolean);
          body.order_cutoff = $('aCutoff').value.trim();
          if (!body.min_prep_hours) return toast(t('svc.errPrep'), true);
          if (!body.delivery_slots.length) return toast(t('svc.errSlots'), true);
        }
        try {
          await api(`/admin/restaurants/${r.id}`, { method: 'PUT', body });
          toast(t('s.saved'));
          renderDetail(ctx);
        } catch (e) { toast(ADMIN_SERVICE_ERRORS[e.message] ? t(ADMIN_SERVICE_ERRORS[e.message]) : e.message, true); }
      };
    }

    if (canCommission) {
      document.getElementById('saveComm').onclick = async () => {
        const bp = Math.round(Number(String(document.getElementById('eComm').value).replace(',', '.')) * 100);
        if (!Number.isInteger(bp) || bp < 0 || bp > 10000) return toast(t('a.invalidValue'), true);
        try {
          await api(`/admin/restaurants/${r.id}/commission`, { method: 'POST', body: { commission_rate_bp: bp } });
          toast(t('a.commissionUpdated'));
          renderDetail(ctx);
        } catch (e) { toast(e.message, true); }
      };
    }
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
