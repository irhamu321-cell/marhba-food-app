import { api, getToken, setToken, logout, money, statusBadge, toast, esc, fmtDate, beep,
  uploadImage, wireImagePicker, imagePickerHtml, UPLOAD_ACCEPT,
  startBell, stopBell, unlockBell, bellUnlocked } from './api.js';
import { t, lang, pick, toggleLang, applyDirection } from './i18n.js';

const app = document.getElementById('app');
const $ = (id) => document.getElementById(id);
const state = {
  user: null, resto: null, tab: 'orders', timer: null, knownOrders: new Set(),
  soundOn: true, firstLoad: true,
  // the live stream, and whether the browser has let us make a sound yet
  stream: null, streamState: 'off', audioReady: false,
};

const toCents = (value) => Math.round(Number(String(value).replace(',', '.')) * 100);
const fromCents = (cents) => (Number(cents || 0) / 100).toFixed(2);
const isPhotoUrl = (url) => {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) || s.startsWith('/uploads/') || s.startsWith('data:image/');
};

function paintChrome() {
  applyDirection();
  $('langBtn').textContent = t('lang.switch');
  $('logoutBtn').querySelector('.lbl').textContent = t('nav.logout');
  $('brandText').innerHTML = (lang === 'ar' ? esc(t('brand')) : 'Mar<span>hba</span>') +
    ` <span class="badge" style="font-weight:600">${lang === 'ar' ? 'مطعم' : 'Restaurant'}</span>`;
}

/* ---------------- auth ---------------- */
function renderAuth() {
  app.innerHTML = `
    <h1>${t('r.space')}</h1>
    <p class="sub">${t('r.spaceSub')}</p>
    <div class="tabs">
      <button class="active" id="tabLogin">${t('r.login')}</button>
      <button id="tabSignup">${t('r.signup')}</button>
    </div>
    <div class="card" style="max-width:460px" id="authCard"></div>`;

  // Phone is the login, like the customer app; an email still works.
  const login = `
    <div class="field"><label>${esc(t('auth.identifier'))}</label>
      <input id="liId" inputmode="tel" placeholder="0612345678"></div>
    <div class="field"><label>${esc(t('auth.password'))}</label>
      <input id="liPass" type="password"></div>
    <button class="primary block lg" id="liBtn">${esc(t('auth.login'))}</button>
    <div class="alert info small mt"><span class="ic">💡</span><div>${esc(t('r.testAccount'))}</div></div>`;

  const signup = `
    <div class="field"><label>${esc(t('r.restoName'))}</label><input id="suResto"></div>
    <div class="field"><label>${esc(t('r.yourName'))}</label><input id="suName"></div>
    <div class="field"><label>${esc(t('r.city'))}</label><input id="suCity" placeholder="Kénitra"></div>
    <div class="field"><label>${esc(t('auth.phone'))}</label>
      <input id="suPhone" inputmode="tel" placeholder="0612345678">
      <div class="help">${esc(t('auth.phoneHint'))}</div></div>
    <div class="field"><label>${esc(t('auth.emailOptional'))}</label><input id="suEmail" type="email"></div>
    <div class="field"><label>${esc(t('auth.passwordNew'))}</label><input id="suPass" type="password"></div>
    <button class="primary block lg" id="suBtn">${esc(t('auth.sendCode'))}</button>
    <div class="small muted mt">${esc(t('r.createNote'))}</div>`;

  /** Keeps what was typed while the phone code is entered. */
  let pendingSignup = null;

  const codeForm = (phone) => `
    <div class="alert info"><span class="ic">📩</span>
      <div>${esc(t('auth.codeSent', { phone }))}</div></div>
    <div class="field mt"><label>${esc(t('auth.code'))}</label>
      <input id="suCode" inputmode="numeric" maxlength="6" placeholder="123456"
             style="font-size:22px;letter-spacing:6px;text-align:center"></div>
    <button class="primary block lg" id="suConfirm">${esc(t('r.create'))}</button>
    <div class="row between mt">
      <button class="ghost small" id="suBack">${esc(t('auth.changeNumber'))}</button>
      <button class="ghost small" id="suResend">${esc(t('auth.resend'))}</button>
    </div>`;

  const mount = (html) => {
    $('authCard').innerHTML = html;
    if ($('liBtn')) {
      $('liBtn').onclick = () => auth('/auth/login', {
        identifier: $('liId').value.trim(), password: $('liPass').value });
      $('liId').onkeydown = (e) => { if (e.key === 'Enter') $('liPass').focus(); };
      $('liPass').onkeydown = (e) => { if (e.key === 'Enter') $('liBtn').click(); };
    }
    if ($('suBtn')) {
      $('suBtn').onclick = async () => {
        const details = {
          name: $('suName').value.trim(), email: $('suEmail').value.trim(),
          phone: $('suPhone').value.trim(), password: $('suPass').value,
          role: 'restaurant', locale: lang,
          restaurant_name: $('suResto').value.trim(), city: $('suCity').value.trim(),
        };
        if (details.name.length < 2) return toast(t('auth.needName'), true);
        if (!details.phone) return toast(t('auth.needPhone'), true);
        if (details.password.length < 8) return toast(t('auth.needPassword'), true);

        const button = $('suBtn');
        button.disabled = true;
        button.innerHTML = `<span class="spinner"></span>`;
        try {
          await api('/auth/request-code', { method: 'POST', body: { phone: details.phone } });
          pendingSignup = details;
          mount(codeForm(details.phone));
        } catch (e) {
          toast(e.message, true);
          button.disabled = false;
          button.textContent = t('r.create');
        }
      };
    }

    if ($('suConfirm')) {
      $('suConfirm').onclick = () => auth('/auth/register', {
        ...pendingSignup, code: $('suCode').value.trim() });
      $('suCode').onkeydown = (e) => { if (e.key === 'Enter') $('suConfirm').click(); };
      $('suCode').focus();
      $('suBack').onclick = () => mount(signup);
      $('suResend').onclick = async () => {
        try {
          await api('/auth/request-code', { method: 'POST', body: { phone: pendingSignup.phone } });
          toast(t('auth.codeResent'));
        } catch (e) { toast(e.message, true); }
      };
    }
  };
  mount(login);
  $('tabLogin').onclick = () => { $('tabLogin').classList.add('active'); $('tabSignup').classList.remove('active'); mount(login); };
  $('tabSignup').onclick = () => { $('tabSignup').classList.add('active'); $('tabLogin').classList.remove('active'); mount(signup); };
}

async function auth(path, body) {
  try {
    const data = await api(path, { method: 'POST', body });
    if (data.user.role !== 'restaurant') throw new Error(t('r.notRestaurant'));
    setToken(data.token);
    await boot();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- shell ---------------- */
function renderShell() {
  const r = state.resto;
  const preorder = r.service_type === 'preorder';
  app.innerHTML = `
    <div class="card" style="padding:16px 18px">
      <div class="row between wrap" style="gap:12px">
        <div class="grow" style="min-width:200px">
          <h1 style="margin:0 0 3px">${esc(pick(r))}</h1>
          <div class="small muted">${esc(r.city || '')}</div>
        </div>
        <div class="row wrap" style="gap:7px">
          <span class="badge ${r.is_open ? 'green' : 'red'}">${r.is_open ? esc(t('s.open')) : esc(t('resto.closed'))}</span>
          <span class="badge ${preorder ? 'preorder' : 'immediate'}">${preorder ? '📅' : '⚡'} ${
            esc(preorder
              ? (Number(r.min_prep_hours) ? t('svc.preorderH', { h: Number(r.min_prep_hours) }) : t('svc.preorder'))
              : t('svc.immediate'))}</span>
          ${r.status === 'approved' ? `<span class="badge blue">${esc(t('r.online'))}</span>` : ''}
        </div>
      </div>
    </div>
    ${r.status === 'pending' ? `<div class="alert warn mt"><span class="ic">⏳</span><div>${esc(t('r.pendingBanner'))}</div></div>` : ''}
    ${r.status === 'suspended' ? `<div class="alert bad mt"><span class="ic">⛔</span><div>${esc(t('r.suspendedBanner'))}</div></div>` : ''}
    <div class="tabs mt">
      <button data-tab="orders">🧾 ${esc(t('r.tabOrders'))}</button>
      <button data-tab="menu">📖 ${esc(t('r.tabMenu'))}</button>
      <button data-tab="settings">⚙️ ${esc(t('r.tabSettings'))}</button>
      <button data-tab="stats">📈 ${esc(t('r.tabStats'))}</button>
    </div>
    <div id="tabBody"></div>`;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.onclick = () => { state.tab = b.dataset.tab; renderShell(); };
  });
  clearInterval(state.timer);
  ({ orders: renderOrders, menu: renderMenu, settings: renderSettings, stats: renderStats })[state.tab]();
}

/* ---------------- orders ---------------- */
const NEXT_ACTIONS = {
  pending: [['accepted', 'r.accept', 'primary'], ['rejected', 'r.reject', 'danger']],
  accepted: [['preparing', 'r.prepare', 'primary']],
  preparing: [['ready', 'r.ready', 'primary']],
  ready: [['completed', 'r.complete', 'primary']],
};

/* ---------------- the live order stream ---------------- */

/*
 * Opens the push stream, and keeps it open.
 *
 * The 15-second poll below is deliberately left running. A stream can be
 * buffered by a proxy, dropped by a phone changing network, or refused
 * outright, and a kitchen that misses an order because the clever path failed
 * is worse off than one that never had it. So this is an accelerator, never
 * the only way an order arrives.
 */
async function openOrderStream() {
  if (state.stream) return;
  if (typeof EventSource === 'undefined') { state.streamState = 'unsupported'; return; }

  try {
    // A one-use ticket, because EventSource cannot send our session token.
    const { ticket } = await api('/restaurant/stream-ticket', { method: 'POST' });
    const source = new EventSource(`/api/restaurant/stream?ticket=${encodeURIComponent(ticket)}`);
    state.stream = source;

    source.addEventListener('ready', () => {
      state.streamState = 'live';
      paintStreamBadge();
    });

    source.addEventListener('order.created', (event) => {
      let data = {};
      try { data = JSON.parse(event.data); } catch { /* keep going regardless */ }
      // Redraw from the API rather than trusting the event to be complete:
      // the event says "something arrived", the list says what.
      if (state.tab === 'orders') renderOrders();
      else toast(t('r.newOrder'));
      if (data.has_allergy_note) toast(t('o.allergy'), true);
    });

    source.onerror = () => {
      /*
       * EventSource reconnects on its own, but our ticket was single-use, so
       * its retry would be refused. Close it and build a new one, with a
       * pause so a server that is down is not hammered.
       */
      state.streamState = 'retrying';
      paintStreamBadge();
      source.close();
      state.stream = null;
      setTimeout(() => { if (state.user) openOrderStream(); }, 10000);
    };
  } catch {
    state.streamState = 'off';
    setTimeout(() => { if (state.user) openOrderStream(); }, 20000);
  }
}

function closeOrderStream() {
  if (state.stream) { state.stream.close(); state.stream = null; }
  state.streamState = 'off';
}

/** A quiet indicator, so an owner can tell live from polling. */
function paintStreamBadge() {
  const node = $('streamBadge');
  if (!node) return;
  const live = state.streamState === 'live';
  node.className = `badge ${live ? 'green' : 'amber'}`;
  node.textContent = live ? t('r.live') : t('r.polling');
}

/*
 * The bell rings while at least one order is waiting to be accepted.
 *
 * Tied to the state of the board rather than to the arrival of an event: if
 * the owner reloads the page with three orders still pending, it should ring,
 * and once the last one is accepted or refused it should stop by itself
 * without anyone having to remember to stop it.
 */
function updateBell(pendingCount) {
  if (!state.soundOn || !pendingCount) { stopBell(); return; }
  if (!state.audioReady) return;
  startBell();
}

async function renderOrders() {
  const body = $('tabBody');
  try {
    const { orders } = await api('/restaurant/orders');
    const active = orders.filter((o) => ['pending', 'accepted', 'preparing', 'ready'].includes(o.status));
    const done = orders.filter((o) => !['pending', 'accepted', 'preparing', 'ready'].includes(o.status));

    const pendingIds = active.filter((o) => o.status === 'pending').map((o) => o.id);
    const fresh = pendingIds.filter((id) => !state.knownOrders.has(id));
    if (!state.firstLoad && fresh.length) toast(t('r.newOrder'));
    state.knownOrders = new Set(pendingIds);
    state.firstLoad = false;

    body.innerHTML = `
      ${!state.audioReady && state.soundOn ? `
        <div class="alert warn" id="audioPrompt">
          <span class="ic">\ud83d\udd14</span>
          <div class="grow">
            <strong>${esc(t('r.enableSound'))}</strong>
            <div class="small">${esc(t('r.enableSoundWhy'))}</div>
          </div>
          <button class="primary" id="enableSound">${esc(t('r.enableSoundBtn'))}</button>
        </div>` : ''}
      <div class="row between">
        <h2 style="margin:0">${t('r.active')} (${active.length})</h2>
        <div class="row" style="gap:8px">
          <span id="streamBadge" class="badge amber">${esc(t('r.polling'))}</span>
          <label class="row small muted" style="margin:0;gap:6px">
            <input type="checkbox" id="soundToggle" ${state.soundOn ? 'checked' : ''} style="width:auto"> \ud83d\udd14 ${t('r.sound')}
          </label>
          <button class="small" id="refresh">${t('r.refresh')}</button>
        </div>
      </div>
      ${active.length ? active.map(orderCard).join('') : `<div class="empty"><div>✅</div><div>${t('r.noActive')}</div></div>`}
      <h2>${t('r.history')}</h2>
      ${done.length ? `<div class="card"><table><thead><tr>
          <th>${t('r.order')}</th><th>${t('r.date')}</th><th>${t('r.total')}</th><th>${t('r.commission')}</th><th>${t('r.status')}</th>
        </tr></thead><tbody>
        ${done.slice(0, 40).map((o) => `<tr><td>${esc(o.order_number)}</td><td>${fmtDate(o.placed_at)}</td>
          <td class="price">${money(o.total_cents)}</td><td class="muted">${money(o.commission_cents)}</td>
          <td>${statusBadge(o.status)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="small muted">${t('r.nothingYet')}</div>`}`;

    $('refresh').onclick = renderOrders;
    paintStreamBadge();
    updateBell(pendingIds.length);

    /*
     * The browser will not make a sound until someone clicks something, and
     * it says nothing when it refuses. So the owner is asked once, plainly,
     * and hears a test chime the moment they agree.
     */
    if ($('enableSound')) {
      $('enableSound').onclick = async () => {
        state.audioReady = await unlockBell();
        if (state.audioReady) {
          toast(t('r.soundOn'));
          renderOrders();
        } else {
          toast(t('r.soundBlocked'), true);
        }
      };
    }

    $('soundToggle').onchange = async (e) => {
      state.soundOn = e.target.checked;
      if (e.target.checked) {
        state.audioReady = await unlockBell();
        updateBell(pendingIds.length);
      } else {
        stopBell();
      }
    };
    document.querySelectorAll('[data-status]').forEach((b) => {
      b.onclick = async () => {
        const note = b.dataset.status === 'rejected' ? (prompt(t('r.rejectReason')) || t('r.rejected')) : '';
        b.disabled = true;
        try {
          await api(`/restaurant/orders/${b.dataset.order}/status`, { method: 'POST', body: { status: b.dataset.status, note } });
          // Silence it now rather than at the next redraw: the owner has just
          // told us they have seen the order, and a bell that rings on for
          // another second teaches them to ignore it.
          stopBell();
          toast(t('r.updated'));
          renderOrders();
        } catch (e) { toast(e.message, true); b.disabled = false; }
      };
    });
    clearInterval(state.timer);
    state.timer = setInterval(() => { if (state.tab === 'orders') renderOrders(); }, 15000);
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/*
 * What the kitchen has to do to this dish, as two separate lines.
 *
 * Additions and removals are never mixed into one run of words: a cook
 * skimming a ticket must not read "oignons" and put onions on a burger that
 * was ordered without them. So removals get their own line, led by SANS.
 */
const ticketOptions = (item) => {
  const options = item.options || [];
  if (!options.length) return '';
  const label = (o) => esc(lang === 'ar' ? (o.name_ar || o.name) : o.name);
  const added = options.filter((o) => !o.is_removal).map(label);
  const removed = options.filter((o) => o.is_removal).map(label);
  return `
    ${added.length ? `<div class="small muted" style="margin-inline-start:18px">\u21b3 ${added.join(' \u00b7 ')}</div>` : ''}
    ${removed.length ? `<div class="small" style="margin-inline-start:18px;color:var(--red);font-weight:600">
      \u2715 ${t('o.removed')}: ${removed.join(' \u00b7 ')}</div>` : ''}`;
};

/*
 * Allergies, in a box the eye cannot slide past.
 *
 * This is the one field on the ticket where being wrong can put someone in
 * hospital, so it is not a grey note among other grey notes.
 */
const allergyBlock = (order) => (order.special_instructions
  ? `<div class="alert warn mt"><span class="ic">\u26a0\ufe0f</span>
      <div><strong>${t('o.allergy')}</strong><br>${esc(order.special_instructions)}</div></div>`
  : '');

function buildWhatsAppDispatchLink(o) {
  const d = o.delivery;
  const itemsText = (o.items || []).map((i) => `• ${i.quantity}x ${lang === 'ar' ? (i.name_ar || i.name) : i.name}`).join('\n');
  const addrLines = d ? [
    d.recipient_name ? `Destinataire: ${d.recipient_name} (${d.recipient_phone})` : '',
    ...(d.block || []),
    d.map_link ? `GPS: ${d.map_link}` : '',
  ].filter(Boolean).join('\n') : (o.delivery_address || '—');

  const lines = [
    `🛵 *COMMANDE #${o.order_number}*`,
    `Client: ${o.customer_name} (${o.customer_phone})`,
    o.scheduled_for ? `📅 Prévue pour: ${o.scheduled_for} ${o.scheduled_slot || ''}` : '',
    `\n📍 *Adresse de livraison:*\n${addrLines}`,
    `\n🍽️ *Plats:*\n${itemsText}`,
    o.note ? `\n📝 Note: ${o.note}` : '',
    `\n💵 *Total à encaisser (Espèces): ${money(o.total_cents)}*`,
  ].filter(Boolean);

  return `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
}

function buildWhatsAppCustomerPickupLink(o) {
  const rawPhone = String(o.customer_phone || '').replace(/\D/g, '');
  const intPhone = rawPhone.startsWith('0') ? '212' + rawPhone.slice(1) : rawPhone;
  const text = lang === 'ar'
    ? `السلام عليكم ${o.customer_name}، طلبكم #${o.order_number} جاهز للاستلام عند الشيفة. مرحباً بكم! 👩‍🍳`
    : `Bonjour ${o.customer_name}, votre commande #${o.order_number} est prête chez la cheffe. Vous pouvez venir la récupérer. À tout de suite ! 👩‍🍳`;
  return `https://wa.me/${intPhone}?text=${encodeURIComponent(text)}`;
}

const orderCard = (o) => `
  <div class="card mt">
    <div class="row between">
      <div>
        <h3>${esc(o.order_number)} ${statusBadge(o.status)}</h3>
        <div class="small muted">${fmtDate(o.placed_at)} · ${o.fulfillment_type === 'delivery' ? t('orders.delivery') : t('orders.pickup')}</div>
      </div>
      <div class="right"><div class="price">${money(o.total_cents)}</div><div class="small muted">${t('r.cash')}</div></div>
    </div>
    <div class="mt small">
      ${(o.items || []).map((i) => `
        <div class="row between">
          <span>${i.quantity} × ${esc(lang === 'ar' ? (i.name_ar || i.name) : i.name)}</span>
          <span class="price">${money(i.line_total_cents)}</span>
        </div>
        ${ticketOptions(i)}
        ${i.note ? `<div class="small muted" style="margin-inline-start:18px">📝 ${esc(i.note)}</div>` : ''}
      `).join('')}
    </div>
    ${allergyBlock(o)}
    <div class="small muted mt">
      👤 ${esc(o.customer_name)} · <a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a>
      ${o.note ? `<br>📝 ${esc(o.note)}` : ''}
    </div>
    ${o.fulfillment_type === 'delivery' ? deliveryBlock(o) : ''}
    <div class="row mt" style="flex-wrap:wrap;gap:8px">
      ${(NEXT_ACTIONS[o.status] || []).map(([status, key, cls]) =>
        `<button class="${cls} small" data-order="${o.id}" data-status="${status}">${t(key)}</button>`).join('')}
      ${o.fulfillment_type === 'delivery' ? `
        <a class="ghost small btn-like" href="${esc(buildWhatsAppDispatchLink(o))}" target="_blank" rel="noopener noreferrer" style="color:#0f7b4f;border-color:#bbf7d0;background:#f0fdf4">
          📲 ${esc(t('r.sendWhatsApp'))}
        </a>` : ''}
      ${o.fulfillment_type === 'pickup' && ['accepted', 'preparing', 'ready'].includes(o.status) ? `
        <a class="ghost small btn-like" href="${esc(buildWhatsAppCustomerPickupLink(o))}" target="_blank" rel="noopener noreferrer" style="color:#0f7b4f;border-color:#bbf7d0;background:#f0fdf4">
          💬 ${esc(t('r.notifyCustomerPickup'))}
        </a>` : ''}
    </div>
  </div>`;

/*
 * Where the food is going, for whoever carries it.
 *
 * The recipient can be someone other than the account holder — an order sent
 * to a parent or a colleague — so their name and number are shown separately
 * from the customer's. The map button opens the saved pin in whatever map app
 * the phone has; it is only drawn when there is a usable pin, so there is no
 * button that leads nowhere.
 */
const deliveryBlock = (o) => {
  const d = o.delivery;
  if (!d) {
    return `<div class="deliv-block"><div class="small muted">📍 ${esc(o.delivery_address || '—')}</div></div>`;
  }
  return `
    <div class="deliv-block">
      <div class="row between" style="gap:8px;align-items:flex-start">
        <div class="grow small">
          <strong>📍 ${esc(t('r.deliverTo'))}${d.label ? ` · ${esc(d.label)}` : ''}</strong>
          <div>${esc(d.recipient_name)} · <a href="tel:${esc(d.recipient_phone)}">${esc(d.recipient_phone)}</a></div>
          ${d.block.map((line) => `<div class="muted">${esc(line)}</div>`).join('')}
        </div>
        ${d.map_link ? `<a class="ghost small btn-like" href="${esc(d.map_link)}"
          target="_blank" rel="noopener noreferrer">🗺️ ${esc(t('r.openMap'))}</a>` : ''}
      </div>
    </div>`;
};

/* ---------------- menu ---------------- */
async function renderMenu() {
  const body = $('tabBody');
  try {
    const { categories, products } = await api('/restaurant/menu');
    body.innerHTML = `
      <div class="card">
        <h3>${t('m.addCategory')}</h3>
        <div class="grid two mt">
          <div><label>${t('m.categoryName')}</label><input id="catName"></div>
          <div><label>${t('m.nameAr')}</label><input id="catNameAr" dir="rtl"></div>
        </div>
        <button class="primary mt" id="addCat">${t('m.add')}</button>
      </div>

      <div class="card mt">
        <h3>${t('m.addDish')}</h3>
        <div class="grid two">
          <div><label>${t('m.name')}</label><input id="pName"></div>
          <div><label>${t('m.nameAr')}</label><input id="pNameAr" dir="rtl"></div>
        </div>
        <div class="grid two">
          <div><label>${t('m.desc')}</label><input id="pDesc"></div>
          <div><label>${t('m.descAr')}</label><input id="pDescAr" dir="rtl"></div>
        </div>
        <div class="grid three">
          <div><label>${t('m.price')}</label><input id="pPrice" type="number" step="0.5" min="0"></div>
          <div><label>${t('m.category')}</label><select id="pCat">
            <option value="">${t('m.none')}</option>
            ${categories.map((c) => `<option value="${c.id}">${esc(pick(c))}</option>`).join('')}
          </select></div>
          <div><label>🍽️ ${t('m.dailyStock') || 'Portions / jour'}</label><input id="pStock" type="number" min="0" value="0"></div>
        </div>
        <div class="field mt-s">
          <label>📷 ${t('up.photo')} du plat</label>
          ${imagePickerHtml({ fileId: 'pDishPhotoNew', urlId: 'pDishImageUrlNew', previewId: 'pDishImagePrevNew' })}
        </div>
        <button class="primary mt" id="addProd">${t('m.addToMenu')}</button>
      </div>

      <h2>${t('m.myMenu')} (${products.length} ${t('m.dishes')})</h2>
      ${categories.concat([{ id: null, name: t('m.none'), name_ar: t('m.none') }]).map((c) => {
        const list = products.filter((p) => (p.category_id ?? null) === c.id);
        if (!list.length && c.id === null) return '';
        return `<div class="card mt">
          <div class="row between">
            <h3>${esc(pick(c))}</h3>
            ${c.id ? `<button class="danger small" data-delcat="${c.id}">${t('m.deleteCategory')}</button>` : ''}
          </div>
          ${list.length ? list.map(productRow).join('') : `<div class="small muted">${t('m.noDishes')}</div>`}
        </div>`;
      }).join('')}`;

    $('addCat').onclick = async () => {
      const name = $('catName').value.trim();
      if (!name) return toast(t('m.needName'), true);
      try {
        await api('/restaurant/categories', { method: 'POST', body: { name, name_ar: $('catNameAr').value.trim() } });
        toast(t('m.catAdded')); renderMenu();
      } catch (e) { toast(e.message, true); }
    };

    wireImagePicker({ fileId: 'pDishPhotoNew', urlId: 'pDishImageUrlNew', previewId: 'pDishImagePrevNew' });

    $('addProd').onclick = async () => {
      const name = $('pName').value.trim();
      const price = toCents($('pPrice').value);
      const dailyStock = Math.max(0, parseInt($('pStock')?.value || '0', 10) || 0);
      const imageUrl = $('pDishImageUrlNew')?.value?.trim() || '';
      if (!name) return toast(t('m.needName'), true);
      if (!Number.isFinite(price) || price < 0) return toast(t('m.invalidPrice'), true);
      try {
        await api('/restaurant/products', { method: 'POST', body: {
          name, name_ar: $('pNameAr').value.trim(),
          description: $('pDesc').value.trim(), description_ar: $('pDescAr').value.trim(),
          price_cents: price, category_id: $('pCat').value ? Number($('pCat').value) : null,
          daily_stock: dailyStock, image_url: imageUrl } });
        toast(t('m.dishAdded')); renderMenu();
      } catch (e) { toast(e.message, true); }
    };

    wireMenuActions();
  } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

const productRow = (p) => `
  <div class="item" style="flex-wrap:wrap">
    ${p.image_url
      ? `<img src="${esc(p.image_url)}" alt="" class="dish-thumb">`
      : ''}
    <div class="grow">
      <h3>${esc(pick(p))} ${p.is_active ? '' : `<span class="badge red">${t('m.hidden')}</span>`}${p.daily_stock > 0 ? ` <span class="badge" style="background:#e0e7ff;color:#3730a3">🍽️ ${p.daily_stock} ${t('m.portionsDay') || 'portions/j'}</span>` : ''}</h3>
      <div class="small muted">${esc(pick(p, 'description'))}</div>
      ${(p.option_groups || []).map((g) => `
        <div class="small muted" style="margin-top:4px">
          <b>${esc(pick(g))}</b>${g.min_select >= 1 ? ` <span class="badge amber">${t('m.required')}</span>` : ''}
          ${g.max_select > 1 ? ` <span class="badge">${t('m.maxChoice')} ${g.max_select}</span>` : ''}
          <button class="ghost small" data-addopt="${g.id}">+ ${t('m.addOption')}</button>
          <button class="ghost small" data-addremoval="${g.id}">+ ${t('m.addRemoval')}</button>
          <button class="ghost small" data-delgroup="${g.id}">✕</button>
          <div style="margin-inline-start:12px">
            ${(g.options || []).map((o) => `${o.is_removal ? '\u2715 ' : ''}${esc(pick(o))}${
              o.is_removal ? ` <span class="badge small">${t('m.removal')}</span>`
                : o.price_delta_cents > 0 ? ` (+${money(o.price_delta_cents)})` : ''}
              <button class="ghost small" data-delopt="${o.id}">\u2715</button>`).join(' \u00b7 ') || '\u2014'}
          </div>
        </div>`).join('')}
      <button class="ghost small" data-addgroup="${p.id}" style="margin-top:6px">+ ${t('m.addGroup')}</button>
    </div>
    <div class="price">${money(p.price_cents)}</div>
    <div class="row" style="gap:6px">
      <button class="small" data-toggle="${p.id}" data-active="${p.is_active}">${p.is_active ? t('m.hide') : t('m.showAgain')}</button>
      <button class="small" data-editprice="${p.id}" data-price="${fromCents(p.price_cents)}">${t('m.editPrice')}</button>
      <label class="ghost small btn-like" for="dishPhoto${p.id}">\ud83d\udcf7 ${t('up.photo')}</label>
      <input type="file" id="dishPhoto${p.id}" data-dishphoto="${p.id}"
             accept="${UPLOAD_ACCEPT}" class="hidden-file">
      <button class="danger small" data-delprod="${p.id}">\u2715</button>
    </div>
  </div>`;

function wireMenuActions() {
  const on = (selector, handler) => document.querySelectorAll(selector).forEach((b) => b.onclick = () => handler(b));
  const guard = async (fn) => { try { await fn(); renderMenu(); } catch (e) { toast(e.message, true); } };

  /*
   * A photo per dish.
   *
   * The picture is uploaded first and the dish is only pointed at it once the
   * upload succeeded, so a failed upload leaves the menu exactly as it was
   * rather than pointing at a file that is not there.
   */
  document.querySelectorAll('[data-dishphoto]').forEach((input) => {
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      input.disabled = true;
      try {
        const url = await uploadImage(file);
        await api(`/restaurant/products/${input.dataset.dishphoto}`, {
          method: 'PUT', body: { image_url: url },
        });
        toast(t('up.done'));
        renderMenu();
      } catch (error) {
        toast(error.message, true);
      } finally {
        input.disabled = false;
        input.value = '';
      }
    };
  });

  on('[data-delcat]', (b) => { if (confirm(t('m.confirmDeleteCat'))) guard(() => api(`/restaurant/categories/${b.dataset.delcat}`, { method: 'DELETE' })); });
  on('[data-delprod]', (b) => {
    if (!confirm(t('m.confirmDeleteDish'))) return;
    guard(async () => {
      const r = await api(`/restaurant/products/${b.dataset.delprod}`, { method: 'DELETE' });
      toast(r.deactivated ? t('m.deactivated') : t('m.deleted'));
    });
  });
  on('[data-toggle]', (b) => guard(() => api(`/restaurant/products/${b.dataset.toggle}`, {
    method: 'PUT', body: { is_active: b.dataset.active !== '1' } })));
  on('[data-editprice]', (b) => {
    const value = prompt(t('m.newPrice'), b.dataset.price);
    if (value === null) return;
    const cents = toCents(value);
    if (!Number.isFinite(cents) || cents < 0) return toast(t('m.invalidPrice'), true);
    guard(() => api(`/restaurant/products/${b.dataset.editprice}`, { method: 'PUT', body: { price_cents: cents } }));
  });

  on('[data-addgroup]', (b) => {
    const name = prompt(t('m.groupName'));
    if (!name) return;
    const nameAr = prompt(t('m.nameAr')) || '';
    const min = Number(prompt(`${t('m.minChoice')} (0 = ${t('m.none')})`, '0') || 0);
    const max = Number(prompt(t('m.maxChoice'), '1') || 1);
    guard(() => api('/restaurant/option-groups', { method: 'POST', body: {
      product_id: Number(b.dataset.addgroup), name, name_ar: nameAr, min_select: min, max_select: max } }));
  });
  on('[data-delgroup]', (b) => { if (confirm(t('m.confirmDeleteGroup'))) guard(() => api(`/restaurant/option-groups/${b.dataset.delgroup}`, { method: 'DELETE' })); });
  on('[data-addopt]', (b) => {
    const name = prompt(t('m.optionName'));
    if (!name) return;
    const nameAr = prompt(t('m.nameAr')) || '';
    const extra = toCents(prompt(t('m.extraPrice'), '0') || 0);
    if (!Number.isFinite(extra) || extra < 0) return toast(t('m.invalidPrice'), true);
    guard(() => api('/restaurant/options', { method: 'POST', body: {
      option_group_id: Number(b.dataset.addopt), name, name_ar: nameAr, price_delta_cents: extra } }));
  });
  /*
   * A removal is created by its own button rather than a yes/no question in
   * the middle of the add-an-option prompts. It has no price to ask for:
   * taking an ingredient out is free, and the server forces it to zero.
   */
  on('[data-addremoval]', (b) => {
    const name = prompt(t('m.removalName'));
    if (!name) return;
    const nameAr = prompt(t('m.nameAr')) || '';
    guard(() => api('/restaurant/options', { method: 'POST', body: {
      option_group_id: Number(b.dataset.addremoval), name, name_ar: nameAr,
      price_delta_cents: 0, is_removal: true } }));
  });
  on('[data-delopt]', (b) => guard(() => api(`/restaurant/options/${b.dataset.delopt}`, { method: 'DELETE' })));
}

/* ---------------- settings ---------------- */
/** Maps the server's field-name errors onto readable sentences. */
const SERVICE_ERRORS = {
  min_prep_hours: 'svc.errPrep',
  delivery_slots: 'svc.errSlots',
  order_cutoff: 'svc.errCutoff',
};

function renderSettings() {
  const r = state.resto;
  const isImmediate = r.service_type !== 'preorder';
  const days = Array.isArray(r.delivery_day_numbers) ? r.delivery_day_numbers
    : String(r.delivery_days || '').split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));
  const slots = Array.isArray(r.delivery_slot_list) ? r.delivery_slot_list
    : String(r.delivery_slots || '').split(',').map((x) => x.trim()).filter(Boolean);

  $('tabBody').innerHTML = `
    <div class="card" style="max-width:620px">
      <div class="grid two">
        <div><label>${t('r.restoName')}</label><input id="sName" value="${esc(r.name)}"></div>
        <div><label>${t('m.nameAr')}</label><input id="sNameAr" dir="rtl" value="${esc(r.name_ar)}"></div>
      </div>
      <div class="grid two">
        <div><label>${t('s.description')}</label><textarea id="sDesc" rows="2">${esc(r.description)}</textarea></div>
        <div><label>${t('m.descAr')}</label><textarea id="sDescAr" dir="rtl" rows="2">${esc(r.description_ar)}</textarea></div>
      </div>
      <div class="grid two">
        <div><label>${t('r.city')}</label><input id="sCity" value="${esc(r.city)}"></div>
        <div><label>${t('s.phone')}</label><input id="sPhone" value="${esc(r.phone)}"></div>
      </div>
      <label>${t('s.address')}</label><input id="sAddress" value="${esc(r.address)}">
      <label>${t('s.image')}</label>
      ${imagePickerHtml({ fileId: 'sImageFile', urlId: 'sImage', previewId: 'sImagePrev', value: r.image_url })}
      <div class="grid three mt">
        <div><label>${t('s.fee')}</label><input id="sFee" type="number" step="0.5" min="0" value="${fromCents(r.delivery_fee_cents)}"></div>
        <div><label>${t('s.minOrder')}</label><input id="sMin" type="number" step="0.5" min="0" value="${fromCents(r.min_order_cents)}"></div>
        <div><label>${t('s.prep')}</label><input id="sPrep" type="number" min="1" max="240" value="${r.prep_minutes}"></div>
      </div>
      <div class="grid two mt">
        <div><label>👩‍🍳 ${t('chef.about') || 'Histoire de la Cheffe'}</label><textarea id="sChefBio" rows="2" placeholder="Votre histoire, passion, spécialités...">${esc(r.chef_bio || '')}</textarea></div>
        <div><label>👩‍🍳 ${t('m.descAr')} - نبذة عن الطباخة</label><textarea id="sChefBioAr" dir="rtl" rows="2" placeholder="نبذة عن خبرتك وأطباقك المميزة...">${esc(r.chef_bio_ar || '')}</textarea></div>
      </div>
      <div class="grid two mt">
        <div><label>🏠 ${t('chef.pickupNote') || 'Consignes de retrait (lieu de rendez-vous)'}</label><input id="sPickupInst" value="${esc(r.pickup_instructions || '')}" placeholder="Ex: Rendez-vous à l'entrée de la résidence..."></div>
        <div><label>🏠 تعليمات الاستلام للزبون</label><input id="sPickupInstAr" dir="rtl" value="${esc(r.pickup_instructions_ar || '')}" placeholder="مثال: الاستلام عند مدخل الإقامة..."></div>
      </div>
      <label class="inline-check" style="margin-top:16px"><input type="checkbox" id="sPickup" ${r.supports_pickup ? 'checked' : ''}> ${esc(t('s.pickup'))}</label>
      <label class="inline-check"><input type="checkbox" id="sDelivery" ${r.supports_delivery ? 'checked' : ''}> ${esc(t('s.delivery'))}</label>
      <label class="inline-check"><input type="checkbox" id="sOpen" ${r.is_open ? 'checked' : ''}> ${esc(t('s.open'))}</label>
      <div class="formactions"><button class="primary" id="saveSettings">${esc(t('s.save'))}</button></div>
      <div class="small muted mt">${esc(t('s.commissionNote', { rate: (r.commission_rate_bp / 100).toFixed(2) }))}</div>
    </div>

    <div class="card mt" style="max-width:620px">
      <h3>${esc(t('svc.type'))}</h3>
      <p class="small muted" style="margin:0 0 12px">${esc(t('svc.chooseTypeHelp'))}</p>

      <div class="segmented mb" id="svcSwitch">
        <button data-svc="immediate" class="${isImmediate ? 'active' : ''}">⚡ ${esc(t('svc.immediate'))}</button>
        <button data-svc="preorder" class="${isImmediate ? '' : 'active'}">📅 ${esc(t('svc.preorder'))}</button>
      </div>
      <div class="small muted mb">${esc(isImmediate ? t('svc.immediateHelp') : t('svc.preorderHelp'))}</div>

      <div id="svcConfig" class="${isImmediate ? 'hidden' : ''}">
        <div class="field">
          <label>${esc(t('svc.prepTime'))}</label>
          <select id="sPrepHours">
            ${[24, 48, 72].map((h) => `<option value="${h}" ${Number(r.min_prep_hours) === h ? 'selected' : ''}>${
              esc(t('svc.prepHours', { h }))}</option>`).join('')}
            <option value="custom" ${![24, 48, 72].includes(Number(r.min_prep_hours)) && Number(r.min_prep_hours) ? 'selected' : ''}>${
              esc(t('svc.prepCustom'))}</option>
          </select>
        </div>
        <div class="field ${[24, 48, 72].includes(Number(r.min_prep_hours)) || !Number(r.min_prep_hours) ? 'hidden' : ''}" id="customHoursField">
          <label>${esc(t('svc.prepCustom'))}</label>
          <input id="sPrepCustom" type="number" min="1" max="720" value="${Number(r.min_prep_hours) || 24}">
        </div>

        <div class="field">
          <label>${esc(t('svc.days'))}</label>
          <div class="chips">
            ${[1, 2, 3, 4, 5, 6, 0].map((n) => `
              <label class="chip ${days.includes(n) ? 'active' : ''}" data-daychip="${n}" style="cursor:pointer">
                <input type="checkbox" class="hidden" id="sDay${n}" ${days.includes(n) ? 'checked' : ''}>
                ${esc(t(`dowShort.${n}`))}
              </label>`).join('')}
          </div>
          <div class="help">${esc(t('svc.daysHelp'))}</div>
        </div>

        <div class="field">
          <label>${esc(t('svc.slots'))}</label>
          <textarea id="sSlots" rows="3" placeholder="11:00-13:00&#10;18:00-20:00">${esc(slots.join('\n'))}</textarea>
          <div class="help">${esc(t('svc.slotsHelp'))}</div>
        </div>

        <div class="field">
          <label>${esc(t('svc.cutoff'))}</label>
          <input id="sCutoff" placeholder="18:00" value="${esc(r.order_cutoff || '')}">
          <div class="help">${esc(t('svc.cutoffHelp'))}</div>
        </div>
      </div>

      <div class="formactions"><button class="primary" id="saveService">${esc(t('s.save'))}</button></div>
    </div>`;

  // --- service type switch ---
  let chosenType = r.service_type === 'preorder' ? 'preorder' : 'immediate';
  document.querySelectorAll('[data-svc]').forEach((button) => {
    button.onclick = () => {
      chosenType = button.dataset.svc;
      document.querySelectorAll('[data-svc]').forEach((b) => b.classList.toggle('active', b.dataset.svc === chosenType));
      $('svcConfig').classList.toggle('hidden', chosenType === 'immediate');
    };
  });

  document.querySelectorAll('[data-daychip]').forEach((chip) => {
    chip.onclick = (event) => {
      event.preventDefault();
      const box = $(`sDay${chip.dataset.daychip}`);
      box.checked = !box.checked;
      chip.classList.toggle('active', box.checked);
    };
  });

  $('sPrepHours').onchange = () => {
    $('customHoursField').classList.toggle('hidden', $('sPrepHours').value !== 'custom');
  };

  $('saveService').onclick = async () => {
    const body = { service_type: chosenType };
    if (chosenType === 'preorder') {
      const picked = $('sPrepHours').value;
      body.min_prep_hours = picked === 'custom' ? Number($('sPrepCustom').value || 0) : Number(picked);
      body.delivery_days = [1, 2, 3, 4, 5, 6, 0].filter((n) => $(`sDay${n}`).checked);
      body.delivery_slots = $('sSlots').value.split('\n').map((x) => x.trim()).filter(Boolean);
      body.order_cutoff = $('sCutoff').value.trim();
      if (!body.min_prep_hours) return toast(t('svc.errPrep'), true);
      if (!body.delivery_slots.length) return toast(t('svc.errSlots'), true);
    }
    try {
      const { restaurant } = await api('/restaurant/me', { method: 'PUT', body });
      state.resto = restaurant;
      toast(t('s.saved'));
      renderShell();
    } catch (e) { toast(SERVICE_ERRORS[e.message] ? t(SERVICE_ERRORS[e.message]) : e.message, true); }
  };

  // The picture field and its upload button, including the live preview.
  wireImagePicker({ fileId: 'sImageFile', urlId: 'sImage', previewId: 'sImagePrev' });

  $('saveSettings').onclick = async () => {
    try {
      const { restaurant } = await api('/restaurant/me', { method: 'PUT', body: {
        name: $('sName').value.trim(), name_ar: $('sNameAr').value.trim(),
        description: $('sDesc').value.trim(), description_ar: $('sDescAr').value.trim(),
        city: $('sCity').value.trim(), phone: $('sPhone').value.trim(),
        address: $('sAddress').value.trim(), image_url: $('sImage').value.trim(),
        delivery_fee_cents: toCents($('sFee').value || 0), min_order_cents: toCents($('sMin').value || 0),
        prep_minutes: Number($('sPrep').value || 20),
        chef_bio: $('sChefBio').value.trim(), chef_bio_ar: $('sChefBioAr').value.trim(),
        pickup_instructions: $('sPickupInst').value.trim(), pickup_instructions_ar: $('sPickupInstAr').value.trim(),
        supports_pickup: $('sPickup').checked, supports_delivery: $('sDelivery').checked, is_open: $('sOpen').checked } });
      state.resto = restaurant;
      toast(t('s.saved'));
      renderShell();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------------- stats ---------------- */
async function renderStats() {
  try {
    const s = await api('/restaurant/stats');
    const rate = (s.commission_rate_bp / 100).toFixed(2);
    $('tabBody').innerHTML = `
      <div class="grid three">
        <div class="stat"><div class="label">${t('st.today')}</div><div class="value">${s.today.orders}</div><div class="small muted">${t('st.ordersDone')}</div></div>
        <div class="stat"><div class="label">${t('st.cashed')}</div><div class="value">${money(s.today.revenue_cents)}</div><div class="small muted">${t('r.cash')}</div></div>
        <div class="stat"><div class="label">${t('st.owed')}</div><div class="value">${money(s.today.commission_cents)}</div><div class="small muted">${t('st.commissionPlatform')}</div></div>
      </div>
      <h2>${t('st.sinceStart')}</h2>
      <div class="grid three">
        <div class="stat"><div class="label">${t('st.orders')}</div><div class="value">${s.all_time.orders}</div></div>
        <div class="stat"><div class="label">${t('st.revenue')}</div><div class="value">${money(s.all_time.revenue_cents)}</div></div>
        <div class="stat"><div class="label">${t('st.commissionTotal')}</div><div class="value">${money(s.all_time.commission_cents)}</div></div>
        ${s.all_time.refunded_cents ? `<div class="stat"><div class="label">${t('st.refunded')}</div><div class="value">${money(s.all_time.refunded_cents)}</div></div>` : ''}
      </div>
      <div class="card mt">
        <h3>${t('st.howTitle')}</h3>
        <div class="small muted">${t('st.howText', { rate })}</div>
      </div>
      <h2>${t('cashbox.title')}</h2>
      <div class="card" id="codBox"><div class="small muted">…</div></div>`;
    renderCashbox();
  } catch (e) { $('tabBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

/* ---------------- daily cash declaration ---------------- */
async function renderCashbox() {
  const box = $('codBox');
  if (!box) return;
  try {
    const { days, owed_cents: owed } = await api('/restaurant/cod');
    box.innerHTML = `
      <div class="small muted">${t('cashbox.intro')}</div>
      <div class="row between mt"><span>${t('cashbox.owed')}</span><span class="price">${money(owed)}</span></div>
      ${days.length ? `<table class="mt">
        <thead><tr><th>${t('cashbox.day')}</th><th>${t('cashbox.collected')}</th><th>${t('cashbox.owedShort')}</th>
          <th>${t('cashbox.declared')}</th><th>${t('r.status')}</th><th></th></tr></thead>
        <tbody>${days.slice(0, 14).map((d) => `<tr>
          <td class="small"><b>${esc(d.day)}</b></td>
          <td class="small muted">${money(d.gross_cents)}</td>
          <td class="price">${money(d.expected_cents)}</td>
          <td class="small">${Number(d.declared_cents) ? money(d.declared_cents) : '—'}</td>
          <td><span class="badge ${d.status === 'reconciled' ? 'green' : d.status === 'disputed' ? 'red' : 'amber'}">${t(`cod.${d.status}`)}</span></td>
          <td class="right">${d.status !== 'reconciled'
            ? `<button class="small" data-declare="${esc(d.day)}" data-amount="${(Number(d.expected_cents) / 100).toFixed(2)}">${t('cashbox.declare')}</button>`
            : ''}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="small muted mt">${t('cashbox.none')}</div>`}`;

    box.querySelectorAll('[data-declare]').forEach((button) => {
      button.onclick = async () => {
        const value = prompt(t('cashbox.howMuch'), button.dataset.amount);
        if (value === null) return;
        const cents = toCents(value);
        if (!Number.isFinite(cents) || cents < 0) return toast(t('m.invalidPrice'), true);
        try {
          await api('/restaurant/cod/declare', { method: 'POST', body: { day: button.dataset.declare, amount_cents: cents } });
          toast(t('cashbox.saved'));
          renderCashbox();
        } catch (e) { toast(e.message, true); }
      };
    });
  } catch (e) { box.innerHTML = `<div class="small muted">${esc(e.message)}</div>`; }
}

/* ---------------- boot ---------------- */
$('langBtn').onclick = () => {
  toggleLang();
  paintChrome();
  if (getToken()) api('/me/locale', { method: 'PUT', body: { locale: lang } }).catch(() => {});
  if (state.resto) renderShell(); else renderAuth();
};

async function boot() {
  paintChrome();
  const who = $('whoami'), out = $('logoutBtn');
  if (!getToken()) { who.textContent = ''; out.classList.add('hidden'); return renderAuth(); }
  try {
    const { user, restaurant } = await api('/me');
    if (user.role !== 'restaurant') throw new Error(t('r.notRestaurant'));
    state.user = user;
    state.resto = restaurant;
    who.textContent = user.email;
    out.classList.remove('hidden');
    out.onclick = () => { closeOrderStream(); stopBell(); logout(); location.reload(); };
    if (!restaurant) { app.innerHTML = '<div class="empty">—</div>'; return; }
    renderShell();
    openOrderStream();
  } catch {
    setToken(null);
    renderAuth();
  }
}
boot();
