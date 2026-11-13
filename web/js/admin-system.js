import { api, toast } from './api.js';
import { $, el, kpi, panel, emptyState, table, on, money, esc, fmtDate, statusBadge,
         t, lang, pick, localName, toCents, fromCents, exportCsv, csvButton } from './admin-ui.js';

const auditView = { actor_user_id: '', action: '', resource_type: '', from: '', to: '' };

export async function renderPromos(ctx) {
  try {
    const [{ promotions }, { restaurants }] = await Promise.all([
      api('/admin/promotions'), api('/admin/restaurants'),
    ]);
    el().innerHTML = `
      <div class="card">
        <h3>${t('a.createCode')}</h3>
        <div class="grid two">
          <div><label>${t('a.code')}</label><input id="pcCode" style="text-transform:uppercase" placeholder="RAMADAN20"></div>
          <div><label>${t('a.discountType')}</label><select id="pcType">
            <option value="percent">${t('a.percent')}</option>
            <option value="fixed">${t('a.fixedAmount')}</option>
            <option value="free_delivery">${t('a.freeDelivery')}</option>
          </select></div>
        </div>
        <div class="grid two">
          <div><label>${t('a.value')}</label><input id="pcValue" type="number" min="0" step="1">
            <div class="small muted" id="pcValueHint">${t('a.valueHintPercent')}</div></div>
          <div><label>${t('a.maxDiscount')}</label><input id="pcMax" type="number" min="0" step="1" value="0"></div>
        </div>
        <div class="grid two">
          <div><label>${t('a.minOrder')}</label><input id="pcMin" type="number" min="0" step="1" value="0"></div>
          <div><label>${t('a.fundedBy')}</label><select id="pcFunded">
            <option value="platform">${t('a.fundedPlatform')}</option>
            <option value="restaurant">${t('a.fundedRestaurant')}</option>
          </select></div>
        </div>
        <div class="grid two">
          <div><label>${t('a.scope')}</label><select id="pcResto">
            <option value="">${t('a.allRestaurants')}</option>
            ${restaurants.map((r) => `<option value="${r.id}">${esc(pick(r))}</option>`).join('')}
          </select></div>
          <div><label>${t('a.endsAt')}</label><input id="pcEnds" type="date"></div>
        </div>
        <div class="grid two">
          <div><label>${t('a.usageLimit')}</label><input id="pcLimit" type="number" min="0" step="1" value="0"></div>
          <div><label>${t('a.perCustomer')}</label><input id="pcPer" type="number" min="0" step="1" value="1"></div>
        </div>
        <div class="grid two">
          <div><label>${t('a.descriptionFr')}</label><input id="pcDesc"></div>
          <div><label>${t('a.descriptionAr')}</label><input id="pcDescAr" dir="rtl"></div>
        </div>
        <button class="primary mt" id="pcCreate">${t('a.create')}</button>
      </div>

      ${promotions.length ? `<div class="card mt"><table>
        <thead><tr><th>${t('a.code')}</th><th>${t('a.discountType')}</th><th>${t('a.fundedBy')}</th>
          <th>${t('a.scope')}</th><th>${t('a.used')}</th><th>${t('a.given')}</th><th>${t('a.status')}</th><th></th></tr></thead>
        <tbody>${promotions.map((p) => `<tr>
          <td><b>${esc(p.code)}</b><div class="small muted">${esc(pick(p, 'description'))}</div></td>
          <td class="small">${p.discount_type === 'percent' ? `${p.discount_value} %`
            : p.discount_type === 'fixed' ? money(p.discount_value) : t('a.freeDelivery')}
            ${Number(p.min_order_cents) ? `<div class="muted">${t('a.minOrder')}: ${money(p.min_order_cents)}</div>` : ''}</td>
          <td class="small">${p.funded_by === 'platform' ? t('a.fundedPlatform') : t('a.fundedRestaurant')}</td>
          <td class="small">${p.restaurant_name ? esc(p.restaurant_name) : t('a.allRestaurants')}</td>
          <td class="small">${p.times_used}${Number(p.usage_limit) ? ` / ${p.usage_limit}` : ''}</td>
          <td class="small muted">${money(p.total_given_cents)}</td>
          <td><span class="badge ${p.is_active ? 'green' : 'red'}">${p.is_active ? t('a.activeLabel') : t('a.inactive')}</span></td>
          <td class="right">
            <button class="small" data-toggle="${p.id}">${p.is_active ? t('a.deactivate') : t('a.activate')}</button>
            <button class="danger small" data-delcode="${p.id}">${t('a.deleteCode')}</button>
          </td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><div>🎟️</div><div>${t('a.noCodes')}</div></div>`}`;

    const hint = () => {
      const type = $('pcType').value;
      $('pcValueHint').textContent = type === 'percent' ? t('a.valueHintPercent')
        : type === 'fixed' ? t('a.valueHintFixed') : '—';
      $('pcValue').disabled = type === 'free_delivery';
    };
    $('pcType').onchange = hint;
    hint();

    $('pcCreate').onclick = async () => {
      const type = $('pcType').value;
      const toCents = (v) => Math.round(Number(String(v || 0).replace(',', '.')) * 100);
      try {
        await api('/admin/promotions', { method: 'POST', body: {
          code: $('pcCode').value.trim().toUpperCase(),
          discount_type: type,
          discount_value: type === 'fixed' ? toCents($('pcValue').value) : Number($('pcValue').value || 0),
          max_discount_cents: toCents($('pcMax').value),
          min_order_cents: toCents($('pcMin').value),
          funded_by: $('pcFunded').value,
          restaurant_id: $('pcResto').value ? Number($('pcResto').value) : null,
          ends_at: $('pcEnds').value ? `${$('pcEnds').value}T23:59:59.999Z` : '',
          usage_limit: Number($('pcLimit').value || 0),
          per_customer_limit: Number($('pcPer').value || 0),
          description: $('pcDesc').value.trim(),
          description_ar: $('pcDescAr').value.trim(),
        } });
        toast(t('a.codeCreated'));
        ctx.refresh();
      } catch (e) { toast(e.message, true); }
    };

    document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
      try { await api(`/admin/promotions/${b.dataset.toggle}/toggle`, { method: 'POST', body: {} }); ctx.refresh(); }
      catch (e) { toast(e.message, true); }
    });
    document.querySelectorAll('[data-delcode]').forEach((b) => b.onclick = async () => {
      if (!confirm(t('a.confirmDeleteCode'))) return;
      try { await api(`/admin/promotions/${b.dataset.delcode}`, { method: 'DELETE' }); ctx.refresh(); }
      catch (e) { toast(e.message, true); }
    });
  } catch (e) { el().innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

export async function renderAudit(ctx) {
  try {
    const params = new URLSearchParams(Object.entries(auditView).filter(([, v]) => v));
    const { logs, filters } = await api(`/admin/audit?${params}`);
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.audit')}</h2>
      <p class="sub">${t('au.intro')}</p>
      <div class="panel">
        <div class="filters">
          <div><label>${t('au.actor')}</label><select id="auActor">
            <option value="">${t('au.allActors')}</option>
            ${filters.actors.map((a) => `<option value="${a.id}" ${String(auditView.actor_user_id) === String(a.id) ? 'selected' : ''}>${esc(a.name || a.email)}</option>`).join('')}
          </select></div>
          <div><label>${t('a.action')}</label><select id="auAction">
            <option value="">${t('au.allActions')}</option>
            ${filters.actions.map((a) => `<option value="${a}" ${auditView.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select></div>
          <div><label>${t('au.resource')}</label><select id="auResource">
            <option value="">${t('au.allResources')}</option>
            ${filters.resource_types.map((r) => `<option value="${r}" ${auditView.resource_type === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select></div>
          <div><label>${t('o.from')}</label><input id="auFrom" type="date" value="${esc(auditView.from)}"></div>
          <div><label>${t('o.to')}</label><input id="auTo" type="date" value="${esc(auditView.to)}"></div>
          <div><label>&nbsp;</label><button class="primary" id="auApply">${t('a.search')}</button></div>
          <div><label>&nbsp;</label><button id="auClear">${t('o.clear')}</button></div>
          <div><label>&nbsp;</label>${csvButton('auditCsv')}</div>
        </div>
      </div>

      <div class="panel mt">
        ${logs.length ? `<table>
          <thead><tr><th>${t('a.when')}</th><th>${t('a.who')}</th><th>${t('a.action')}</th>
            <th>${t('a.target')}</th><th>${t('au.changes')}</th><th>${t('au.origin')}</th></tr></thead>
          <tbody>${logs.map((l) => `<tr>
            <td class="small muted">${fmtDate(l.created_at)}</td>
            <td class="small">${esc(l.actor_name || l.actor_email || '—')}<div class="muted">${esc(l.actor_role || '')}</div></td>
            <td class="small"><b>${esc(l.action)}</b>${l.details && l.details !== '{}' ? `<div class="muted">${esc(l.details).slice(0, 120)}</div>` : ''}</td>
            <td class="small muted">${esc(l.resource_type)} ${l.resource_id ?? ''}</td>
            <td class="small muted">${l.before_state || l.after_state
              ? `<details><summary>${t('au.see')}</summary>
                 <div><b>${t('au.before')}</b>: ${esc(String(l.before_state || '—')).slice(0, 400)}</div>
                 <div><b>${t('au.after')}</b>: ${esc(String(l.after_state || '—')).slice(0, 400)}</div></details>`
              : '—'}</td>
            <td class="small muted">${esc(l.ip || '')}<div>${esc(String(l.user_agent || '').slice(0, 40))}</div></td>
          </tr>`).join('')}</tbody></table>` : emptyState('📜', t('a.noLogs'))}
      </div>`;

    const read = () => ({
      actor_user_id: document.getElementById('auActor').value,
      action: document.getElementById('auAction').value,
      resource_type: document.getElementById('auResource').value,
      from: document.getElementById('auFrom').value,
      to: document.getElementById('auTo').value,
    });
    document.getElementById('auditCsv').onclick = () => exportCsv('/admin/audit', auditView, 'journal');
    document.getElementById('auApply').onclick = () => { Object.assign(auditView, read()); renderAudit(ctx); };
    document.getElementById('auClear').onclick = () => {
      Object.assign(auditView, { actor_user_id: '', action: '', resource_type: '', from: '', to: '' });
      renderAudit(ctx);
    };
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

export async function renderCommissions(ctx) {
  const list = (await api('/admin/stats')).commission_by_restaurant || [];
  el().innerHTML = `
    <div class="card">
      <h3>${t('a.owedTitle')}</h3>
      <div class="small muted">${t('a.owedSub')}</div>
      <table class="mt"><thead><tr><th>${t('a.restaurant')}</th><th>${t('a.orders')}</th><th class="right">${t('a.commission')}</th></tr></thead>
      <tbody>${list.map((r) => `<tr><td>${esc(pick(r))}</td><td>${r.orders}</td>
        <td class="right price">${money(r.commission_cents)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>${t('a.total')}</th><th></th>
        <th class="right price">${money(list.reduce((sum, r) => sum + r.commission_cents, 0))}</th></tr></tfoot>
      </table>
    </div>`;
}

export async function renderSettings(ctx) {
  try {
    const { settings } = await api('/admin/settings');
    el().innerHTML = `
      <h2 style="margin-top:0">${t('nav.settings')}</h2>
      <p class="sub">${t('se.intro')}</p>

      ${Number(settings.maintenance_mode) ? `<div class="banner bad">${t('d.maintenanceOn')}</div>` : ''}

      <div class="panel mt" style="max-width:620px">
        <h3>${t('se.identity')}</h3>
        <label>${t('se.platformName')}</label><input id="sePlatform" value="${esc(settings.platform_name)}">
        <div class="grid two">
          <div><label>${t('se.supportPhone')}</label><input id="sePhone" value="${esc(settings.support_phone)}" placeholder="0600000000"></div>
          <div><label>${t('se.supportEmail')}</label><input id="seEmail" type="email" value="${esc(settings.support_email)}"></div>
        </div>
        <div class="grid two">
          <div><label>${t('se.currency')}</label><input id="seCurrency" value="${esc(settings.currency)}" maxlength="8"></div>
          <div><label>${t('se.language')}</label><select id="seLang">
            <option value="fr" ${settings.default_language === 'fr' ? 'selected' : ''}>Francais</option>
            <option value="ar" ${settings.default_language === 'ar' ? 'selected' : ''}>العربية</option>
          </select></div>
        </div>

        <h3 class="mt">${t('se.money')}</h3>
        <label>${t('se.defaultCommission')}</label>
        <input id="seCommission" type="number" step="0.5" min="0" max="100" value="${(Number(settings.default_commission_bp) / 100).toFixed(2)}">
        <div class="small muted">${t('se.commissionHint')}</div>

        <h3 class="mt">${t('se.switches')}</h3>
        <label class="row" style="gap:8px"><input type="checkbox" id="seMaintenance" ${Number(settings.maintenance_mode) ? 'checked' : ''} style="width:auto"> ${t('se.maintenance')}</label>
        <div class="small muted">${t('se.maintenanceHint')}</div>
        <label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" id="sePromos" ${Number(settings.promotions_enabled) ? 'checked' : ''} style="width:auto"> ${t('se.promotions')}</label>
        <div class="small muted">${t('se.promotionsHint')}</div>

        <button class="primary mt" id="seSave">${t('s.save')}</button>
      </div>

      <div id="systemPanels"></div>`;

    renderSystemPanels(ctx);

    document.getElementById('seSave').onclick = async () => {
      try {
        await api('/admin/settings', { method: 'PUT', body: {
          platform_name: document.getElementById('sePlatform').value.trim(),
          support_phone: document.getElementById('sePhone').value.trim(),
          support_email: document.getElementById('seEmail').value.trim(),
          currency: document.getElementById('seCurrency').value.trim(),
          default_language: document.getElementById('seLang').value,
          default_commission_bp: Math.round(Number(String(document.getElementById('seCommission').value).replace(',', '.')) * 100),
          maintenance_mode: document.getElementById('seMaintenance').checked,
          promotions_enabled: document.getElementById('sePromos').checked,
        } });
        toast(t('se.saved'));
        renderSettings(ctx);
      } catch (e) { toast(e.message, true); }
    };
  } catch (e) { el().innerHTML = emptyState('⚠️', esc(e.message)); }
}

/* ------------------------------------------------------------------ *
 * System: health, backups, legal details, recent events, live codes
 * ------------------------------------------------------------------ */

const dateTime = (value) => (value ? fmtDate(value) : '—');

/*
 * Are the backups actually leaving the machine?
 *
 * A backup on the same disk as the database is not a backup, so the daily run
 * can go on reporting success for months while nothing has left the building.
 * This is the one screen where that is visible, which is why it states the
 * plain case - "not configured" - as loudly as a failure.
 *
 * media_pending is counted separately on purpose: the database copies and the
 * photos can fail independently, and a growing pile of unsent photos is easy
 * to miss behind a green database backup.
 */
function offsiteBlock(offsite, backup) {
  const pending = Number(backup.media_pending || 0);

  if (!offsite.enabled) {
    return `<div class="alert warn"><span class="ic">\u26a0\ufe0f</span>
      <div>${esc(t('sys.offsiteOff'))}</div></div>
      <div class="small muted mt">${esc(t('sys.offsiteHint'))}</div>`;
  }

  const failing = offsite.last_failure_at && (!offsite.last_success_at
    || new Date(offsite.last_failure_at) > new Date(offsite.last_success_at));

  return `
    ${failing
      ? `<div class="alert bad"><span class="ic">\u26d4</span><div>${esc(t('sys.offsiteFailing'))}
         ${offsite.last_error ? `<div class="tiny">${esc(offsite.last_error)}</div>` : ''}</div></div>`
      : `<div class="alert good"><span class="ic">\u2705</span><div>${esc(t('sys.offsiteOk'))}</div></div>`}
    <div class="row wrap mt" style="gap:14px">
      <div><div class="tiny muted">${esc(t('sys.lastSuccess'))}</div>
        <b>${esc(dateTime(offsite.last_success_at))}</b></div>
      <div><div class="tiny muted">${esc(t('sys.lastFailure'))}</div>
        <b>${esc(dateTime(offsite.last_failure_at))}</b></div>
      <div><div class="tiny muted">${esc(t('sys.offsiteSent'))}</div>
        <b>${Number(offsite.uploads || 0)}</b></div>
      <div><div class="tiny muted">${esc(t('sys.offsiteFailures'))}</div>
        <b>${Number(offsite.failures || 0)}</b></div>
      <div><div class="tiny muted">${esc(t('sys.mediaPending'))}</div>
        <b>${pending}</b></div>
    </div>
    ${pending ? `<div class="alert warn mt"><span class="ic">\ud83d\uddbc\ufe0f</span>
      <div>${esc(t('sys.mediaPendingNote', { count: pending }))}</div></div>` : ''}
    <div class="small muted mt">${esc(t('sys.offsiteKeyNote'))}</div>`;
}

/** Draws the operational panels under the settings form. */
async function renderSystemPanels(ctx) {
  const host = document.getElementById('systemPanels');
  if (!host) return;
  host.innerHTML = `<div class="loadwrap"><span class="spinner dark"></span>${esc(t('common.loading'))}</div>`;

  const [health, legal, events, codes] = await Promise.all([
    api('/admin/health').catch(() => null),
    api('/legal').catch(() => null),
    ctx.can('audit.view') ? api('/admin/events').catch(() => ({ events: [] })) : Promise.resolve({ events: [] }),
    ctx.can('customers.manage') ? api('/admin/auth-codes').catch(() => null) : Promise.resolve(null),
  ]);

  if (!health) { host.innerHTML = ''; return; }
  const backup = health.backup || {};

  host.innerHTML = `
    <h2>${esc(t('sys.title'))}</h2>

    <div class="kpi mb">
      ${kpi(t('sys.state'), esc(t(`sys.status.${health.status}`)), '',
        { icon: health.status === 'ok' ? '✅' : health.status === 'warning' ? '⚠️' : '⛔', small: true })}
      ${kpi(t('sys.uptime'), `${Math.round((health.uptime_seconds || 0) / 3600)} h`, '', { icon: '⏱', small: true })}
      ${kpi(t('sys.disk'), `${health.disk?.free_mb ?? '—'} Mo`,
        esc(t('sys.diskFree', { percent: health.disk?.free_percent ?? '—' })), { icon: '💾', small: true })}
      ${kpi(t('sys.lastBackup'), backup.stale ? esc(t('sys.stale')) : esc(t('sys.fresh')),
        esc(dateTime(backup.last_success_at)), { icon: '🗄', small: true })}
    </div>

    ${panel(esc(t('sys.backups')), `
      <div class="row wrap" style="gap:14px">
        <div><div class="tiny muted">${esc(t('sys.tables'))}</div><b>${backup.tables ?? '—'}</b></div>
        <div><div class="tiny muted">${esc(t('sys.rows'))}</div><b>${backup.rows ?? '—'}</b></div>
        <div><div class="tiny muted">${esc(t('sys.lastSuccess'))}</div><b>${esc(dateTime(backup.last_success_at))}</b></div>
        <div><div class="tiny muted">${esc(t('sys.lastFailure'))}</div><b>${esc(dateTime(backup.last_failure_at))}</b></div>
      </div>
      ${backup.last_error ? `<div class="alert bad mt"><span class="ic">⛔</span><div>${esc(backup.last_error)}</div></div>` : ''}
      ${(backup.files || []).length ? `<div class="mt">${(backup.files || []).map((file) =>
        `<div class="listrow"><div class="grow"><code class="small">${esc(file.name)}</code></div>
         <div class="small muted">${Math.round(file.bytes / 1024)} Ko</div></div>`).join('')}</div>` : ''}
      <div class="small muted mt">${esc(t('sys.restoreHint'))}</div>`,
      ctx.can('settings.manage') ? `<button class="primary small" id="runBackup">${esc(t('sys.runBackup'))}</button>` : '')}

    ${panel(esc(t('sys.offsite')), offsiteBlock(health.offsite || {}, backup))}

    ${legal ? panel(esc(t('sys.legal')), legal.complete
      ? `<div class="alert good"><span class="ic">✅</span><div>${esc(t('sys.legalOk'))}</div></div>`
      : `<div class="alert warn"><span class="ic">⚠️</span><div>${esc(t('sys.legalMissing'))}</div></div>
         <div class="mt">${legal.missing.map((key) => {
           const field = legal.fields.find((f) => f.key === key);
           return `<div class="listrow"><div class="grow">
             <b>${esc(lang === 'ar' ? field?.labelAr : field?.label || key)}</b>
             <div class="tiny muted">${esc(field?.help || '')}</div></div>
             <code class="tiny">${esc(key)}</code></div>`;
         }).join('')}</div>
         <div class="small muted mt">${esc(t('sys.legalWhere'))}</div>`) : ''}

    ${codes && codes.console_enabled ? panel(esc(t('sys.codes')),
      (codes.codes || []).length
        ? (codes.codes || []).map((entry) => `
            <div class="listrow">
              <div class="grow"><b>${esc(entry.destination)}</b>
                <div class="tiny muted">${esc(t(`sys.purpose.${entry.purpose}`))} · ${esc(dateTime(entry.created_at))}</div></div>
              <code style="font-size:17px;letter-spacing:2px">${esc(entry.code)}</code>
            </div>`).join('')
        : `<div class="small muted">${esc(t('sys.noCodes'))}</div>`,
      `<span class="badge amber">${esc(t('sys.pilot'))}</span>`) : ''}

    ${(events.events || []).length ? panel(esc(t('sys.events')),
      `<div class="tablewrap"><div class="scroller"><table>
        <thead><tr><th>${esc(t('sys.when'))}</th><th>${esc(t('sys.event'))}</th><th>${esc(t('sys.detail'))}</th></tr></thead>
        <tbody>${(events.events || []).slice(0, 40).map((entry) => {
          const { t: when, level, event, ...rest } = entry;
          return `<tr>
            <td class="small muted nowrap">${esc(dateTime(when))}</td>
            <td><span class="badge ${level === 'error' ? 'red' : level === 'warn' ? 'amber' : ''}">${esc(event)}</span></td>
            <td class="small muted">${esc(Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' · '))}</td>
          </tr>`;
        }).join('')}</tbody></table></div></div>`) : ''}`;

  const button = document.getElementById('runBackup');
  if (button) {
    button.onclick = async () => {
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>`;
      try {
        const done = await api('/admin/backup', { method: 'POST', body: {} });
        toast(t('sys.backupDone', { tables: done.tables, rows: done.rows }));
        renderSystemPanels(ctx);
      } catch (e) {
        toast(e.message, true);
        button.disabled = false;
        button.textContent = t('sys.runBackup');
      }
    };
  }
}
