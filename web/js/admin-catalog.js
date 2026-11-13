import { api, toast, uploadImage, UPLOAD_ACCEPT } from './api.js';
import { el, kpi, panel, emptyState, on, money, esc,
         t, localName, toCents, fromCents } from './admin-ui.js';

const view = { restaurant_id: '' };

export async function renderCatalog(ctx) {
  try {
    const { restaurants } = await api('/admin/restaurants');
    if (!view.restaurant_id && restaurants.length) view.restaurant_id = String(restaurants[0].id);
    if (!restaurants.length) return void (el().innerHTML = emptyState('🍴', t('rs.none')));

    const data = await api(`/admin/catalog?restaurant_id=${view.restaurant_id}`);
    const canEdit = ctx.can('catalog.manage');
    const byCategory = data.categories.concat([{ id: null, name: t('m.none'), name_ar: t('m.none') }]);

    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.catalog')}</h2>
      <div class="panel">
        <div class="filters">
          <div style="min-width:220px"><label>${t('a.restaurant')}</label>
            <select id="catResto" style="width:100%">
              ${restaurants.map((r) => `<option value="${r.id}" ${String(view.restaurant_id) === String(r.id) ? 'selected' : ''}>${localName(r)}</option>`).join('')}
            </select></div>
        </div>
      </div>

      <div class="kpi mt">
        ${kpi(t('cat.products'), data.products.length)}
        ${kpi(t('cat.categories'), data.categories.length)}
        ${kpi(t('cat.hidden'), data.products.filter((p) => !p.is_active).length)}
      </div>

      ${canEdit ? `<div class="panel mt">
        <h3>${t('cat.addProduct')}</h3>
        <div class="grid two">
          <div><label>${t('m.name')}</label><input id="npName"></div>
          <div><label>${t('m.nameAr')}</label><input id="npNameAr" dir="rtl"></div>
        </div>
        <div class="grid two">
          <div><label>${t('m.price')}</label><input id="npPrice" type="number" step="0.5" min="0"></div>
          <div><label>${t('m.category')}</label><select id="npCat">
            <option value="">${t('m.none')}</option>
            ${data.categories.map((c) => `<option value="${c.id}">${localName(c)}</option>`).join('')}
          </select></div>
        </div>
        <div class="row mt" style="gap:8px">
          <button class="primary" id="npAdd">${t('m.addToMenu')}</button>
          <input id="ncName" placeholder="${t('cat.newCategory')}" style="max-width:240px">
          <button id="ncAdd">${t('cat.addCategory')}</button>
        </div>
      </div>` : ''}

      ${byCategory.map((c) => {
        const list = data.products.filter((p) => (p.category_id ?? null) === c.id);
        if (!list.length && c.id === null) return '';
        return panel(localName(c), list.length ? list.map((p) => `
          <div class="listrow" style="flex-wrap:wrap">
            ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" class="dish-thumb">` : ''}
            <div class="grow">
              <b>${localName(p)}</b> ${p.is_active ? '' : `<span class="badge red">${t('rs.unavailable')}</span>`}
              <div class="small muted">${esc(p.description || '')}</div>
              ${(p.option_groups || []).map((g) => `
                <div class="small muted" style="margin-top:3px">
                  ↳ <b>${localName(g)}</b> (${g.min_select}–${g.max_select})
                  ${(g.options || []).map((o) => `${o.is_removal ? '\u2715 ' : ''}${localName(o)}${
                    o.is_removal ? ` <span class="badge small">${t('m.removal')}</span>`
                      : o.price_delta_cents > 0 ? ` +${money(o.price_delta_cents)}` : ''}
                    ${canEdit ? `<button class="ghost small" data-delopt="${o.id}">\u2715</button>` : ''}`).join(' \u00b7 ') || '\u2014'}
                  ${canEdit ? `<button class="ghost small" data-addopt="${g.id}">+ ${t('m.addOption')}</button>
                  <button class="ghost small" data-addremoval="${g.id}">+ ${t('m.addRemoval')}</button>
                               <button class="ghost small" data-delgroup="${g.id}">${t('m.deleteGroup')}</button>` : ''}
                </div>`).join('')}
              ${canEdit ? `<button class="ghost small" data-addgroup="${p.id}" style="margin-top:4px">+ ${t('m.addGroup')}</button>` : ''}
            </div>
            <div class="price">${money(p.price_cents)}</div>
            ${canEdit ? `<div class="row" style="gap:6px">
              <button class="small" data-price="${p.id}" data-current="${fromCents(p.price_cents)}">${t('m.editPrice')}</button>
              <button class="small" data-avail="${p.id}" data-to="${p.is_active ? 0 : 1}">${p.is_active ? t('rs.markUnavailable') : t('rs.markAvailable')}</button>
              <label class="ghost small btn-like" for="catPhoto${p.id}">\ud83d\udcf7 ${t('up.photo')}</label>
              <input type="file" id="catPhoto${p.id}" data-catphoto="${p.id}"
                     accept="${UPLOAD_ACCEPT}" class="hidden-file">
            </div>` : ''}
          </div>`).join('') : `<div class="small muted">${t('m.noDishes')}</div>`);
      }).join('')}

      ${panel(t('cat.bestSellers'), data.best_sellers.length ? `<table>
        <thead><tr><th>${t('cat.product')}</th><th>${t('cat.units')}</th><th>${t('cat.revenue')}</th></tr></thead>
        <tbody>${data.best_sellers.map((b) => `<tr>
          <td class="small">${esc(b.name)}</td><td class="small"><b>${b.units}</b></td>
          <td class="price">${money(b.revenue_cents)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="small muted">${t('cat.noSales')}</div>`)}
    `;

    document.getElementById('catResto').onchange = (e) => { view.restaurant_id = e.target.value; renderCatalog(ctx); };

    const guard = async (fn) => { try { await fn(); renderCatalog(ctx); } catch (e) { toast(e.message, true); } };

    if (canEdit) {
      document.getElementById('npAdd').onclick = () => {
        const name = document.getElementById('npName').value.trim();
        const price = toCents(document.getElementById('npPrice').value);
        if (!name) return toast(t('m.needName'), true);
        if (!Number.isFinite(price) || price < 0) return toast(t('m.invalidPrice'), true);
        guard(() => api('/admin/products', { method: 'POST', body: {
          restaurant_id: Number(view.restaurant_id), name,
          name_ar: document.getElementById('npNameAr').value.trim(),
          price_cents: price,
          category_id: document.getElementById('npCat').value ? Number(document.getElementById('npCat').value) : null } }));
      };
      document.getElementById('ncAdd').onclick = () => {
        const name = document.getElementById('ncName').value.trim();
        if (!name) return toast(t('m.needName'), true);
        guard(() => api('/admin/categories', { method: 'POST', body: {
          restaurant_id: Number(view.restaurant_id), name } }));
      };
    }

    on('avail', (id, node) => guard(() => api(`/admin/products/${id}`, {
      method: 'PUT', body: { is_active: node.dataset.to === '1' } })));

    on('price', (id, node) => {
      const value = prompt(t('m.newPrice'), node.dataset.current);
      if (value === null) return;
      const cents = toCents(value);
      if (!Number.isFinite(cents) || cents < 0) return toast(t('m.invalidPrice'), true);
      guard(() => api(`/admin/products/${id}`, { method: 'PUT', body: { price_cents: cents } }));
    });

    on('addgroup', (id) => {
      const name = prompt(t('m.groupName'));
      if (!name) return;
      const min = Number(prompt(t('m.minChoice'), '0') || 0);
      const max = Number(prompt(t('m.maxChoice'), '1') || 1);
      guard(() => api('/admin/option-groups', { method: 'POST', body: {
        product_id: Number(id), name, min_select: min, max_select: max } }));
    });
    on('delgroup', (id) => { if (confirm(t('m.confirmDeleteGroup'))) guard(() => api(`/admin/option-groups/${id}`, { method: 'DELETE' })); });
    on('addopt', (id) => {
      const name = prompt(t('m.optionName'));
      if (!name) return;
      const extra = toCents(prompt(t('m.extraPrice'), '0') || 0);
      if (!Number.isFinite(extra) || extra < 0) return toast(t('m.invalidPrice'), true);
      guard(() => api('/admin/options', { method: 'POST', body: {
        option_group_id: Number(id), name, price_delta_cents: extra } }));
    });
    // A dish photo: uploaded first, pointed at only once it is stored.
    document.querySelectorAll('[data-catphoto]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        input.disabled = true;
        try {
          const url = await uploadImage(file);
          await api(`/admin/products/${input.dataset.catphoto}`, {
            method: 'PUT', body: { image_url: url },
          });
          toast(t('up.done'));
          renderCatalog(ctx);
        } catch (error) {
          toast(error.message, true);
        } finally {
          input.disabled = false;
          input.value = '';
        }
      };
    });

    on('addremoval', (id) => {
      const name = prompt(t('m.removalName'));
      if (!name) return;
      guard(() => api('/admin/options', { method: 'POST', body: {
        option_group_id: Number(id), name, price_delta_cents: 0, is_removal: true } }));
    });
    on('delopt', (id) => guard(() => api(`/admin/options/${id}`, { method: 'DELETE' })));
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}
