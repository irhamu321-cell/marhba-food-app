import { api, getToken, setToken, logout, money, statusBadge, toast, esc, fmtDate } from './api.js';
import { t, lang, pick, toggleLang, applyDirection } from './i18n.js';
import { FAQ, buildLegal, LEGAL_PAGES } from './content.js';
import { icon } from './icons.js';
import {
  addressState, loadAddresses, selectedAddress, activeAddress, hasAddresses,
  setSelected, chipLabel, outsideDeliveryArea, addressCard, wireAddressCards,
  addressGateHtml, wireAddressGate, addFromCurrentLocation, addFromMap, addManually,
  readDraft, promoteDraft,
} from './addresses.js';

const CART_KEY = 'food_app_cart';
const $ = (id) => document.getElementById(id);

/*
 * "Browse without an address" has to survive a page refresh.
 *
 * It used to live only in memory, so reloading the page put the address wall
 * back in front of someone who had already said they did not want it. It sits
 * in sessionStorage rather than localStorage on purpose: skipping is a choice
 * about this visit, and a customer who comes back tomorrow should be offered
 * the address screen again, because that is the screen that makes delivery
 * work.
 */
const GATE_SKIP_KEY = 'food_app_gate_skipped';

function readGateSkip() {
  try { return sessionStorage.getItem(GATE_SKIP_KEY) === '1'; } catch { return false; }
}

function rememberGateSkip() {
  try { sessionStorage.setItem(GATE_SKIP_KEY, '1'); } catch { /* private mode: in-memory only */ }
}

const state = {
  user: null, restaurants: [], resto: null, cart: loadCart(), promo: null, quote: null,
  orders: [], ordersFilter: 'all',
  filters: { service: '', cuisine: '', q: '' },
  cuisines: [],
  schedule: { date: '', slot: '' },
  legal: null,
  gateSkipped: readGateSkip(),
};


function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || 'null');
    if (raw && raw.restaurant_id && Array.isArray(raw.items)) return raw;
  } catch { /* ignore */ }
  return { restaurant_id: null, restaurant_name: '', items: [] };
}
function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  renderCartBar();
}
const cartSubtotal = () => state.cart.items.reduce((sum, i) => sum + i.unit_price_cents * i.quantity, 0);
const cartCount = () => state.cart.items.reduce((sum, i) => sum + i.quantity, 0);

/* ---------------- navigation ---------------- */
const VIEWS = ['viewHome', 'viewResto', 'viewCart', 'viewOrders', 'viewTrack', 'viewAccount',
  'viewHelp', 'viewLegal', 'viewAddresses', 'viewGate'];

/** Which bottom tab lights up for each screen. */
const TAB_FOR_VIEW = {
  viewHome: 'home', viewResto: 'home', viewGate: 'home',
  viewOrders: 'orders', viewTrack: 'orders',
  viewCart: 'cart',
  viewHelp: 'help', viewLegal: 'help',
  viewAccount: 'account', viewAddresses: 'account',
};

function show(view) {
  // A screen redrawing itself (the 20-second refresh) keeps its scroll
  // position; arriving on a new screen starts at the top.
  const already = !$(view).classList.contains('hidden');
  VIEWS.forEach((v) => $(v).classList.toggle('hidden', v !== view));
  if (!already) window.scrollTo(0, 0);
  document.querySelectorAll('#tabBar [data-tab]').forEach((tab) => {
    const on = tab.dataset.tab === TAB_FOR_VIEW[view];
    tab.classList.toggle('active', on);
    if (on) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  });
  // Leaving the tracking screen stops its refresh.
  if (view !== 'viewTrack') clearInterval(trackTimer);
  renderCartBar(view);
}

function renderCartBar(view) {
  const count = cartCount();
  const onCart = view ? view === 'viewCart' : !$('viewCart').classList.contains('hidden');
  $('cartCount').textContent = `${t('cart.items', { n: count })} · ${state.cart.restaurant_name}`;
  $('cartTotal').textContent = money(cartSubtotal());
  $('goToCart').textContent = t('cart.title');
  $('cartBar').classList.toggle('hidden', count === 0 || onCart);
  const badge = $('navCartCount');
  badge.textContent = String(count);
  badge.classList.toggle('hidden', count === 0);
}

/** A round back button followed by the screen title, as on every inner screen. */
const pageBar = (id, title, extra = '') => `
  <div class="pagebar">
    <button class="iconround" id="${id}" aria-label="${esc(t('common.back'))}">${icon('back', 20)}</button>
    <h1 class="grow truncate">${esc(title)}</h1>${extra}
  </div>`;

function paintChrome() {
  applyDirection();
  $('langBtn').textContent = t('lang.switch');
  const tabs = [
    ['navHome', 'home', 'nav.home'],
    ['navOrders', 'receipt', 'nav.orders'],
    ['navCart', 'bag', 'cart.title'],
    ['navHelp', 'help', 'nav.help'],
    ['navAccount', 'user', 'nav.profile'],
  ];
  for (const [id, name, label] of tabs) {
    $(id).querySelector('.ic').innerHTML = icon(name, id === 'navCart' ? 24 : 22);
    $(id).querySelector('.lbl').textContent = t(label);
  }
  $('brandText').innerHTML = lang === 'ar' ? esc(t('brand')) : 'Mar<span>hba</span>';
}

/* ---------------- addresses ---------------- */

/*
 * The address screen a new customer sees before any restaurant.
 *
 * Shown when there is nowhere to deliver to yet — no saved address and no
 * draft. Someone who only ever collects in person can walk past it, and it
 * does not come back once they have.
 */
function renderGate() {
  $('viewGate').innerHTML = addressGateHtml();
  wireAddressGate({
    onDone: () => renderHome(),
    onSkip: () => { state.gateSkipped = true; rememberGateSkip(); renderHome(); },
  });
  show('viewGate');
}

const needsGate = () =>
  !state.gateSkipped && !selectedAddress() && !readDraft();

/** The chosen address, across the top of the home screen. */
function addressBannerHtml() {
  const address = activeAddress();
  if (!address) {
    return `<div class="addr-banner">
      <span class="pin">${icon('pin', 18)}</span>
      <div class="who"><strong>${esc(t('addr.none'))}</strong>
        <span>${esc(t('addr.gateSub'))}</span></div>
      <button class="ghost small" id="bannerAdd">${esc(t('addr.addAnother'))}</button>
    </div>`;
  }
  return `<div class="addr-banner">
    <span class="pin">${icon('pin', 18)}</span>
    <div class="who">
      <strong>${esc(t('addr.deliverTo'))} · ${esc(chipLabel(address))}${
        address.draft ? ` <span class="badge amber">${esc(t('addr.draftBadge'))}</span>` : ''}</strong>
      <span>${esc(address.one_line)}</span>
    </div>
    <button class="ghost small" id="bannerChange">${esc(t('addr.change'))}</button>
  </div>`;
}

function wireAddressBanner() {
  if ($('bannerAdd')) $('bannerAdd').onclick = () => renderGate();
  if ($('bannerChange')) $('bannerChange').onclick = () => renderAddresses();
}

/** The address book: add, edit, delete, choose, set default. */
async function renderAddresses() {
  if (getToken() && !addressState.loaded) await loadAddresses();
  const draft = readDraft();

  $('viewAddresses').innerHTML = `
    ${pageBar('addrBack', t('addr.myAddresses'))}
    <p class="sub">${esc(t('addr.chooseForOrder'))}</p>

    ${!getToken() ? `<div class="alert warn mb"><span class="ic">👤</span>
      <div>${esc(t('auth.needLogin'))}</div></div>` : ''}

    ${draft ? `<div class="alert warn mb"><span class="ic">📍</span>
      <div>${esc(t('addr.savedLocal'))}</div></div>` : ''}

    <div id="addrList">
      ${addressState.list.length
        ? addressState.list.map((a) => addressCard(a, { selectable: true })).join('')
        : `<div class="empty"><div class="ic">📍</div><h3>${esc(t('addr.none'))}</h3></div>`}
    </div>

    <div class="card">
      <button class="primary" id="addrLocate" style="width:100%">📍 ${esc(t('addr.useLocation'))}</button>
      <button class="mt" id="addrMap" style="width:100%">🗺️ ${esc(t('addr.pickOnMap'))}</button>
      <button class="ghost mt" id="addrManual" style="width:100%">⌨️ ${esc(t('addr.typeIt'))}</button>
      <div class="small muted mt">${esc(t('addr.privacyNote'))}</div>
    </div>`;

  $('addrBack').onclick = () => renderHome();
  wireAddressCards($('addrList'), renderAddresses);
  $('addrLocate').onclick = async () => {
    if (await addFromCurrentLocation($('addrLocate'))) renderAddresses();
  };
  $('addrMap').onclick = async () => { if (await addFromMap()) renderAddresses(); };
  $('addrManual').onclick = async () => { if (await addManually()) renderAddresses(); };
  show('viewAddresses');
}

/* ---------------- home ---------------- */
async function renderHome(query = '') {
  if (needsGate()) return renderGate();
  state.filters.q = query;
  if (!state.cuisines.length) {
    try { state.cuisines = (await api('/cuisines')).cuisines; } catch { state.cuisines = []; }
  }

  $('viewHome').innerHTML = `
    ${addressBannerHtml()}
    <section class="hero">
      <h1>${esc(t('home.title'))}</h1>
      <p>${esc(t('home.sub'))}</p>
      <div class="searchbox">
        <input id="search" value="${esc(query)}" placeholder="${esc(t('home.searchPlaceholder'))}">
      </div>
    </section>

    <div class="stack mb">
      <div class="chips scroll" id="serviceChips">
        <button class="chip" data-service="">${esc(t('filter.all'))}</button>
        <button class="chip" data-service="immediate">⚡ ${esc(t('svc.immediate'))}</button>
        <button class="chip" data-service="preorder">📅 ${esc(t('svc.preorder'))}</button>
      </div>
      <div class="chips scroll" id="cuisineChipsRow">
        <button class="chip" data-cuisine="">${esc(t('cuisine.all'))}</button>
        ${state.cuisines.map((c) => `<button class="chip" data-cuisine="${c.key}">${esc(lang === 'ar' ? c.ar : c.fr)}</button>`).join('')}
      </div>
    </div>

    <div class="row between mb">
      <div class="small muted" id="restoCount"></div>
      <button class="ghost small hidden" id="clearFilters">${esc(t('common.reset'))}</button>
    </div>
    <div class="restogrid" id="restoList"></div>`;

  $('search').oninput = debounce(() => {
    state.filters.q = $('search').value.trim();
    loadRestaurants();
  }, 300);
  $('search').onkeydown = (e) => {
    if (e.key === 'Enter') { state.filters.q = $('search').value.trim(); loadRestaurants(); }
  };
  wireAddressBanner();
  wireFilterChips();
  await loadRestaurants();
  show('viewHome');
}

/** Debounce so typing in the search box does not fire a request per keystroke. */
function debounce(fn, wait) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

function wireFilterChips() {
  document.querySelectorAll('[data-service]').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.service === state.filters.service);
    chip.onclick = () => { state.filters.service = chip.dataset.service; renderHome(state.filters.q); };
  });
  document.querySelectorAll('[data-cuisine]').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.cuisine === state.filters.cuisine);
    chip.onclick = () => { state.filters.cuisine = chip.dataset.cuisine; renderHome(state.filters.q); };
  });
  const clear = $('clearFilters');
  clear.onclick = () => {
    state.filters = { service: '', cuisine: '', q: '' };
    renderHome('');
  };
  refreshClearButton();
}

/** Shows the reset button as soon as any filter or the search box is in use. */
function refreshClearButton() {
  const clear = $('clearFilters');
  if (!clear) return;
  const active = Boolean(state.filters.service || state.filters.cuisine || state.filters.q);
  clear.classList.toggle('hidden', !active);
}

async function loadRestaurants() {
  const list = $('restoList');
  list.innerHTML = `<div class="sk-card skeleton"></div><div class="sk-card skeleton"></div><div class="sk-card skeleton"></div>`;
  try {
    const params = new URLSearchParams();
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.service) params.set('service', state.filters.service);
    if (state.filters.cuisine) params.set('cuisine', state.filters.cuisine);
    const { restaurants } = await api(`/restaurants${params.toString() ? `?${params}` : ''}`);
    state.restaurants = restaurants;

    $('restoCount').textContent = t('home.count', { n: restaurants.length });
    refreshClearButton();
    list.innerHTML = restaurants.length
      ? restaurants.map(restoCard).join('')
      : `<div class="empty" style="grid-column:1/-1">
           <div class="ic">🍽️</div><h3>${esc(t('home.empty'))}</h3>
           <p>${esc(t('home.emptySub'))}</p></div>`;
    document.querySelectorAll('[data-resto]').forEach((el) => {
      el.onclick = () => openResto(Number(el.dataset.resto));
    });
  } catch (e) { toast(e.message, true); }
}

/** "Commande immediate" or "Precommande 24h", as a pill. */
const serviceRibbon = (r) => (r.service_type === 'preorder'
  ? `<span class="badge preorder ribbon">📅 ${esc(Number(r.min_prep_hours)
      ? t('svc.preorderH', { h: Number(r.min_prep_hours) }) : t('svc.preorder'))}</span>`
  : `<span class="badge immediate ribbon">⚡ ${esc(t('svc.immediate'))}</span>`);

const cuisineText = (r) => (r.cuisine_keys || [])
  .map((key) => t(`cuisine.${key}`)).join(' · ');

const isPhotoUrl = (url) => {
  const s = String(url || '').trim();
  return /^https?:\/\//i.test(s) || s.startsWith('/uploads/') || s.startsWith('data:image/');
};

const thumbContent = (r) => {
  const image = String(r.image_url || '').trim();
  if (isPhotoUrl(image)) {
    return `<img src="${esc(image)}" alt="${esc(pick(r))}" class="resto-cover-img" loading="lazy">`;
  }
  return `<div class="resto-placeholder"><span class="resto-placeholder-emoji">${image || '👩‍🍳'}</span></div>`;
};

const restoCard = (r) => `
  <div class="resto-card ${r.is_open ? '' : 'closed'}" data-resto="${r.id}">
    <div class="resto-thumb">
      ${thumbContent(r)}
      <div class="resto-thumb-overlay"></div>
      ${serviceRibbon(r)}
      ${ratingChip(r)}
      ${r.is_open ? '' : `<span class="badge red ribbon b">${esc(t('resto.closed'))}</span>`}
    </div>
    <div class="body">
      <div class="row between" style="gap:8px">
        <h3 class="truncate">${esc(pick(r))}</h3>
      </div>
      ${cuisineText(r) ? `<div class="tiny muted">${esc(cuisineText(r))}</div>` : ''}
      <div class="desc">${esc(pick(r, 'description') || r.city)}</div>
      <div class="meta">
        <span>${icon('scooter', 16)} ${money(r.delivery_fee_cents)}</span>
        <span>${icon('tag', 16)} ${esc(t('resto.min'))} ${money(r.min_order_cents)}</span>
        <span>${icon('clock', 16)} ${r.service_type === 'preorder'
          ? esc(t('svc.prepHours', { h: Number(r.min_prep_hours) }))
          : esc(t('svc.readyIn', { m: r.prep_minutes }))}</span>
      </div>
      ${outsideDeliveryArea(r, activeAddress())
        ? `<div class="area-warn">⚠️ ${esc(t('addr.outsideArea'))}</div>` : ''}
    </div>
  </div>`;

/* ---------------- restaurant + menu ---------------- */
async function openResto(id) {
  try {
    const data = await api(`/restaurants/${id}`);
    state.resto = data;
    const r = data.restaurant;
    const sections = data.menu.filter((c) => c.products.length);
    if (data.uncategorized.length) sections.push({ id: 0, name: t('resto.other'), name_ar: t('resto.other'), products: data.uncategorized });

    const isPreorder = r.service_type === 'preorder';
    // A new restaurant means the previously chosen delivery day no longer applies.
    if (state.cart.restaurant_id !== r.id) state.schedule = { date: '', slot: '' };

    $('viewResto').innerHTML = `
      ${pageBar('backHome', pick(r))}

      <div class="card" style="padding:0;overflow:hidden">
        <div class="resto-thumb resto-detail-banner">
          ${thumbContent(r)}
          <div class="resto-thumb-overlay"></div>
          ${serviceRibbon(r)}
          ${r.is_open ? '' : `<span class="badge red ribbon b">${esc(t('resto.closed'))}</span>`}
        </div>
        <div style="padding:20px 22px 22px">
          <div class="row between" style="gap:10px">
            <div class="grow">
              <h1 style="margin:0 0 4px;font-size:24px;letter-spacing:-.4px">${esc(pick(r))}</h1>
              ${cuisineText(r) ? `<div class="small muted" style="font-weight:500">${esc(cuisineText(r))}</div>` : ''}
            </div>
            ${ratingChip(r, { big: true })}
          </div>
          <p class="sub" style="margin:10px 0 14px;line-height:1.5">${esc(pick(r, 'description'))}</p>
          <div class="row wrap small" style="gap:8px">
            <span class="badge ${r.is_open ? 'green' : 'red'}">${r.is_open ? esc(t('resto.open')) : esc(t('resto.closed'))}</span>
            <span class="chip-info">${icon('pin', 14)} ${esc(r.address || r.city)}</span>
            <span class="chip-info">${icon('scooter', 14)} ${money(r.delivery_fee_cents)}</span>
            <span class="chip-info">${icon('tag', 14)} ${esc(t('resto.min'))} ${money(r.min_order_cents)}</span>
            <span class="chip-info">${icon('clock', 14)} ${isPreorder
              ? esc(t('svc.prepHours', { h: Number(r.min_prep_hours) }))
              : esc(t('svc.readyIn', { m: r.prep_minutes }))}</span>
          </div>
        </div>
      </div>

      ${pick(r, 'chef_bio') ? `
        <div class="card mt chef-bio-card">
          <div class="row top" style="gap:14px;">
            <div class="chef-avatar">👩‍🍳</div>
            <div class="grow">
              <div class="chef-label">${esc(t('chef.about') || 'À propos de la Cheffe')}</div>
              <div class="chef-bio-text">${esc(pick(r, 'chef_bio'))}</div>
            </div>
          </div>
        </div>` : ''}

      ${isPreorder ? `
        <div class="preorder-note mt">
          <span>📅</span>
          <div>
            <b>${esc(t('svc.noteTitle'))}</b>
            <div class="small" style="margin-top:2px">${esc(t('svc.noteBody'))}</div>
          </div>
        </div>
        <div id="slotPicker" class="mt"></div>` : ''}

      ${sections.map((section) => `
        <h2 class="section-title">${esc(pick(section))}</h2>
        <div class="dishes-grid">
          ${section.products.map((p) => {
            const hasOptions = (p.option_groups || []).length > 0;
            const isSoldOut = Boolean(p.is_sold_out);
            const hasPhoto = isPhotoUrl(p.image_url);
            return `
            <div class="dish-card ${isSoldOut ? 'sold-out' : ''}">
              <div class="dish-body">
                <div class="dish-title-wrap">
                  <h3 class="dish-title">${esc(pick(p))}</h3>
                  ${isSoldOut ? `<span class="badge red dish-badge">${esc(t('product.soldOut') || 'Épuisé')}</span>` : (p.remaining_stock !== null && p.remaining_stock <= 5 ? `<span class="badge orange dish-badge">🔥 ${esc(t('product.remainingPortions', { n: p.remaining_stock }) || `${p.remaining_stock} restante(s)`)}</span>` : '')}
                </div>
                <div class="dish-desc">${esc(pick(p, 'description'))}</div>
                <div class="dish-footer">
                  <span class="price">${hasOptions ? `<span class="small muted">${esc(t('menu.from'))} </span>` : ''}${money(p.price_cents)}</span>
                  ${isSoldOut
                    ? `<button class="ghost small" disabled style="opacity:0.5">${esc(t('product.soldOut') || 'Épuisé')}</button>`
                    : `<button class="primary small add-dish-btn" data-add="${p.id}"><span class="plus-icon">+</span> ${esc(t('menu.add'))}</button>`}
                </div>
              </div>
              ${hasPhoto ? `
                <div class="dish-photo-wrap">
                  <img src="${esc(p.image_url)}" alt="${esc(pick(p))}" loading="lazy" class="dish-photo">
                </div>` : ''}
            </div>`;
          }).join('')}
        </div>`).join('')}
      ${sections.length === 0 ? `<div class="empty"><div class="ic">📋</div><h3>${esc(t('resto.emptyMenu'))}</h3></div>` : ''}
      <div id="restoReviews"></div>`;

    if (isPreorder) renderSlotPicker(data.preorder);
    // Loaded after the menu: a customer came here to see the food first, and
    // the reviews must not hold up the page they actually asked for.
    paintReviews(r.id);

    $('backHome').onclick = () => show('viewHome');
    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.onclick = () => startAdd(Number(btn.dataset.add));
    });
    show('viewResto');
  } catch (e) { toast(e.message, true); }
}

const allProducts = () => [...state.resto.menu.flatMap((c) => c.products), ...state.resto.uncategorized];

/* ---------------- pre-order: pick a day and a slot ---------------- */

/** "mar 04 nov" split into the pieces the day card shows. */
function dayParts(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return {
    dow: t(`dowShort.${date.getUTCDay()}`),
    num: String(date.getUTCDate()).padStart(2, '0'),
    mon: t(`month.${date.getUTCMonth()}`),
  };
}

export function formatScheduled(iso) {
  if (!iso) return '';
  const parts = dayParts(iso);
  return `${parts.dow} ${parts.num} ${parts.mon}`;
}

/**
 * Renders the delivery day strip and the slot buttons underneath.
 * `window` is the `preorder` block the restaurant endpoint returns.
 */
function renderSlotPicker(window) {
  const host = $('slotPicker');
  if (!host) return;
  const dates = window?.dates || [];
  const slots = window?.slots || [];

  if (!dates.length || !slots.length) {
    host.innerHTML = `<div class="alert warn"><span class="ic">⏳</span><div>${esc(t('svc.noDates'))}</div></div>`;
    return;
  }

  host.innerHTML = `
    <div class="card">
      <h3>${esc(t('svc.chooseDate'))}</h3>
      <div class="daygrid mt-s">
        ${dates.slice(0, 14).map((iso) => {
          const parts = dayParts(iso);
          return `<button class="daycard ${state.schedule.date === iso ? 'active' : ''}" data-day="${iso}">
            <span class="dow">${esc(parts.dow)}</span>
            <span class="dnum">${esc(parts.num)}</span>
            <span class="mon">${esc(parts.mon)}</span>
          </button>`;
        }).join('')}
      </div>

      <h3 style="margin-top:18px">${esc(t('svc.chooseSlot'))}</h3>
      <div class="slotgrid mt-s">
        ${slots.map((slot) => `<button class="slotbtn ${state.schedule.slot === slot ? 'active' : ''}" data-slot="${esc(slot)}">
          ${esc(slot)}</button>`).join('')}
      </div>

      ${window.order_cutoff ? `<div class="small muted mt">⏰ ${esc(t('svc.cutoff'))}: ${esc(window.order_cutoff)}</div>` : ''}
      <div class="alert good mt ${state.schedule.date && state.schedule.slot ? '' : 'hidden'}" id="scheduleSummary">
        <span class="ic">✅</span>
        <div>${esc(t('svc.plannedForSlot', {
          date: formatScheduled(state.schedule.date), slot: state.schedule.slot }))}</div>
      </div>
    </div>`;

  host.querySelectorAll('[data-day]').forEach((button) => {
    button.onclick = () => { state.schedule.date = button.dataset.day; renderSlotPicker(window); };
  });
  host.querySelectorAll('[data-slot]').forEach((button) => {
    button.onclick = () => { state.schedule.slot = button.dataset.slot; renderSlotPicker(window); };
  });
}

/* ---------------- options dialog ---------------- */
function startAdd(productId) {
  const product = allProducts().find((p) => p.id === productId);
  if (!product) return;
  const groups = product.option_groups || [];
  if (!groups.length) return addToCart(product, [], '');
  openOptionsModal(product, groups);
}

function openOptionsModal(product, groups) {
  const hint = (g) => (g.min_select >= 1 && g.max_select === 1
    ? `<span class="badge amber">${t('options.required')}</span>`
    : g.max_select > 1 ? `<span class="badge">${t('options.upTo', { n: g.max_select })}</span>` : '');

  $('modalRoot').innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal" role="dialog" aria-modal="true">
        ${isPhotoUrl(product.image_url) ? `
          <div class="modal-dish-photo-wrap">
            <img src="${esc(product.image_url)}" alt="${esc(pick(product))}" class="modal-dish-photo">
          </div>` : ''}
        <h2 style="margin:0 0 2px">${esc(pick(product))}</h2>
        <div class="small muted">${esc(pick(product, 'description'))}</div>
        ${groups.map((g) => `
          <div class="optgroup">
            <div class="row between">
              <h3>${esc(pick(g))}</h3>${hint(g)}
            </div>
            ${g.options.map((o) => `
              <label class="optrow${o.is_removal ? ' removal' : ''}">
                <input type="${o.is_removal || g.max_select !== 1 ? 'checkbox' : 'radio'}"
                       name="g${g.id}" value="${o.id}" data-group="${g.id}"
                       data-removal="${o.is_removal ? '1' : '0'}"
                       data-delta="${o.is_removal ? 0 : o.price_delta_cents}">
                <span class="grow">${o.is_removal ? '\u2715 ' : ''}${esc(pick(o))}</span>
                ${o.is_removal
                  ? `<span class="badge small">${esc(t('options.removed'))}</span>`
                  : o.price_delta_cents > 0 ? `<span class="price small">+${money(o.price_delta_cents)}</span>` : ''}
              </label>`).join('')}
          </div>`).join('')}
        <label>${t('options.itemNote')}</label>
        <input id="itemNote" placeholder="${t('options.itemNotePlaceholder')}">
        <div class="modal-actions">
          <button id="cancelOpt">${t('options.cancel')}</button>
          <button class="primary" id="confirmOpt">${t('options.addToCart')} · <span id="optTotal">${money(product.price_cents)}</span></button>
        </div>
      </div>
    </div>`;

  const inputs = [...document.querySelectorAll('.modal input[type=radio], .modal input[type=checkbox]')];
  const selected = () => inputs.filter((i) => i.checked);
  const refresh = () => {
    const extra = selected().reduce((sum, i) => sum + Number(i.dataset.delta), 0);
    $('optTotal').textContent = money(Number(product.price_cents) + extra);
  };
  inputs.forEach((input) => {
    input.onchange = () => {
      // Enforce the per-group maximum in the interface too; the server checks again.
      const group = groups.find((g) => String(g.id) === input.dataset.group);
      // Removals are not one of the "choose up to N" choices; a customer can
      // take out as many ingredients as the dish has.
      if (group && group.max_select > 1 && input.dataset.removal !== '1') {
        const chosen = inputs.filter((i) => i.dataset.group === input.dataset.group
          && i.dataset.removal !== '1' && i.checked);
        if (chosen.length > group.max_select) input.checked = false;
      }
      refresh();
    };
  });
  // Preselect the first choice of each single-choice required group.
  for (const group of groups) {
    if (group.min_select >= 1 && group.max_select === 1) {
      // Never tick a removal on the customer's behalf: taking an ingredient
      // out has to be their decision, not a default.
      const first = inputs.find((i) => i.dataset.group === String(group.id)
        && i.dataset.removal !== '1');
      if (first) first.checked = true;
    }
  }
  refresh();

  const close = () => { $('modalRoot').innerHTML = ''; };
  $('cancelOpt').onclick = close;
  $('backdrop').onclick = (e) => { if (e.target.id === 'backdrop') close(); };
  $('confirmOpt').onclick = () => {
    for (const group of groups) {
      const count = inputs.filter((i) => i.dataset.group === String(group.id)
        && i.dataset.removal !== '1' && i.checked).length;
      if (count < group.min_select) return toast(t('options.pickRequired'), true);
    }
    const chosen = selected().map((input) => {
      const group = groups.find((g) => String(g.id) === input.dataset.group);
      const option = group.options.find((o) => String(o.id) === input.value);
      return { ...option, group_name: pick(group) };
    });
    addToCart(product, chosen, $('itemNote').value.trim());
    close();
  };
}

function addToCart(product, chosenOptions, note) {
  const restoId = state.resto.restaurant.id;
  if (state.cart.restaurant_id && state.cart.restaurant_id !== restoId && state.cart.items.length) {
    if (!confirm(t('cart.otherResto'))) return;
    state.cart = { restaurant_id: null, restaurant_name: '', items: [] };
  }
  state.cart.restaurant_id = restoId;
  state.cart.restaurant_name = pick(state.resto.restaurant);

  const optionIds = chosenOptions.map((o) => o.id).sort((a, b) => a - b);
  const signature = `${product.id}|${optionIds.join(',')}|${note}`;
  const unitPrice = Number(product.price_cents) + chosenOptions.reduce((s, o) => s + Number(o.price_delta_cents), 0);

  const existing = state.cart.items.find((i) => i.signature === signature);
  if (existing) existing.quantity += 1;
  else state.cart.items.push({
    signature,
    product_id: product.id,
    name: pick(product),
    image_url: product.image_url || '',
    option_ids: optionIds,
    // A removal carries its cross into the cart line, so "Sans oignons" never
    // reads like one more thing that was added.
    option_labels: chosenOptions.map((o) => (o.is_removal ? `\u2715 ${pick(o)}` : pick(o))),
    note,
    unit_price_cents: unitPrice,
    quantity: 1,
  });

  saveCart();
  toast(t('toast.added', { name: pick(product) }));
}

/* ---------------- cart & checkout ---------------- */
function renderCart() {
  if (!state.cart.items.length) {
    $('viewCart').innerHTML = `<div class="empty"><div class="ic">${icon('bag', 40)}</div><div>${t('cart.empty')}</div>
      <button class="primary mt" id="emptyBack">${t('cart.browse')}</button></div>`;
    $('emptyBack').onclick = () => show('viewHome');
    return show('viewCart');
  }

  const resto = state.restaurants.find((r) => r.id === state.cart.restaurant_id) || state.resto?.restaurant || {};
  const subtotal = cartSubtotal();
  const canDeliver = resto.supports_delivery !== 0;
  const canPickup = resto.supports_pickup !== 0;
  const fee = Number(resto.delivery_fee_cents || 0);

  const restoImage = String(resto?.image_url || '').trim();
  const restoLogo = isPhotoUrl(restoImage)
    ? `<img src="${esc(restoImage)}" alt="" loading="lazy">`
    : esc((pick(resto) || state.cart.restaurant_name || '?').trim().charAt(0).toUpperCase());
  const prep = Number(resto.prep_minutes || 0);

  const isPreorder = resto.service_type === 'preorder';
  const scheduleReady = !isPreorder || (state.schedule.date && state.schedule.slot);

  $('viewCart').innerHTML = `
    ${pageBar('cartBack', t('cart.title'))}

    <div class="card mb" style="display:flex;gap:12px;align-items:center;padding:12px 14px">
      <div class="logotile sm">${restoLogo}</div>
      <div class="grow" style="min-width:0">
        <h3 class="truncate" style="margin:0;font-size:16px">${esc(pick(resto) || state.cart.restaurant_name)}</h3>
        <div class="small muted truncate">${icon('pin', 13)} ${esc(resto.city || resto.address || '')}</div>
        ${prep ? `<div class="small" style="color:#b45309;font-weight:600;margin-top:2px;display:flex;align-items:center;gap:4px">${icon('clock', 13)} ${esc(t('track.eta', { time: `~${prep} min` }))}</div>` : ''}
      </div>
    </div>

    ${isPreorder ? (scheduleReady
      ? `<div class="alert good mb"><span class="ic">📅</span><div>${esc(t('svc.plannedForSlot', {
           date: formatScheduled(state.schedule.date), slot: state.schedule.slot }))}
         <button class="ghost small" id="changeSlot" style="margin-inline-start:6px">${esc(t('common.edit'))}</button></div></div>`
      : `<div class="alert warn mb"><span class="ic">⚠️</span><div>${esc(t('svc.pickFirst'))}
         <button class="ghost small" id="changeSlot" style="margin-inline-start:6px">${esc(t('svc.chooseDate'))}</button></div></div>`) : ''}

    <div class="card">
      ${state.cart.items.map((item, index) => {
        const hasImg = isPhotoUrl(item.image_url);
        return `
        <div class="item" style="display:flex;gap:12px;align-items:center">
          ${hasImg ? `<div class="dish-thumb-sm"><img src="${esc(item.image_url)}" alt=""></div>` : ''}
          <div class="grow">
            <h3>${esc(item.name)}</h3>
            ${item.option_labels.length ? `<div class="small muted">${item.option_labels.map(esc).join(' · ')}</div>` : ''}
            ${item.note ? `<div class="small muted">📝 ${esc(item.note)}</div>` : ''}
            <div class="small muted">${money(item.unit_price_cents)} ${t('cart.each')}</div>
          </div>
          <div class="qty">
            <button data-dec="${index}">−</button><span>${item.quantity}</span><button data-inc="${index}">+</button>
          </div>
          <div class="price" style="min-width:75px;text-align:end">${money(item.unit_price_cents * item.quantity)}</div>
        </div>`;
      }).join('')}
    </div>

    <h2>${t('cart.how')}</h2>
    <div class="card">
      <div class="fulopts">
        ${canPickup ? `<label class="fulopt">
          <input type="radio" name="ful" value="pickup" checked>
          <span>${t('cart.pickup')}</span></label>` : ''}
        ${canDeliver ? `<label class="fulopt">
          <input type="radio" name="ful" value="delivery" ${canPickup ? '' : 'checked'}>
          <span>${t('cart.delivery')}<span class="sub2">${money(fee)}</span></span></label>`
          : `<div class="fulopt off small">${t('cart.noDelivery')}</div>`}
      </div>

      <label>${t('cart.name')}</label>
      <input id="ckName" value="${esc(state.user?.name || '')}">
      <label>${t('cart.phone')}</label>
      <input id="ckPhone" value="${esc(state.user?.phone || '')}" placeholder="06…">
      <div id="addrWrap" class="hidden">
        <label>${t('cart.address')}</label>
        <div id="ckAddrList"></div>
        <button class="ghost small" id="ckAddrAdd">+ ${esc(t('addr.addAnother'))}</button>
      </div>
      <div id="pickupWrap" class="hidden">
        <div class="alert info mt" style="font-size:13px; line-height:1.4;">
          <span class="ic">🏠</span>
          <div>
            <b>${esc(t('chef.pickupNote') || 'Consignes de retrait chez la cheffe')}</b>
            <div style="margin-top:3px">${esc(pick(resto, 'pickup_instructions') || t('chef.pickupRespect') || 'Contactez la cheffe à votre arrivée devant l\'immeuble.')}</div>
          </div>
        </div>
      </div>
      <label>${t('cart.note')}</label>
      <input id="ckNote" placeholder="${t('cart.notePlaceholder')}">

      <label>\u26a0\ufe0f ${t('cart.allergy')}</label>
      <textarea id="ckAllergy" rows="2" maxlength="500"
        placeholder="${t('cart.allergyPlaceholder')}"></textarea>
      <div class="small muted">${t('cart.allergyHint')}</div>

      <label>${t('cart.promo')}</label>
      <div class="row" style="gap:8px">
        <input id="ckPromo" value="${esc(state.promo?.code || '')}" placeholder="${t('cart.promoPlaceholder')}"
               style="text-transform:uppercase">
        <button id="ckPromoBtn">${state.promo ? t('cart.removePromo') : t('cart.apply')}</button>
      </div>

      <h2 style="margin:20px 0 10px">${esc(t('cart.paymentMethod'))}</h2>
      <div class="card" style="display:flex;align-items:center;gap:12px;border:1.5px solid var(--accent-line);background:var(--accent-soft);padding:14px;box-shadow:none">
        <div style="width:40px;height:40px;border-radius:12px;background:#fff;display:flex;align-items:center;justify-content:center;color:var(--accent-dark);box-shadow:var(--sh-1);flex:none">
          ${icon('tag', 20)}
        </div>
        <div class="grow">
          <strong style="display:block;font-size:14px;color:var(--ink)">${esc(t('cart.codTitle'))}</strong>
          <span class="small" style="color:var(--ink-2)">${esc(t('track.cash'))}</span>
        </div>
        <span style="width:24px;height:24px;border-radius:50%;background:var(--green);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none">
          ${icon('check', 14)}
        </span>
      </div>

      <div class="totals">
        <div class="row"><span class="muted">${t('cart.subtotal')}</span><span class="price" id="ckSub">${money(subtotal)}</span></div>
        <div class="row"><span class="muted">${t('cart.deliveryFee')}</span><span class="price" id="ckFee">${money(0)}</span></div>
        <div class="row ${state.promo ? '' : 'hidden'}" id="ckDiscountRow">
          <span style="color:var(--green)">${t('cart.discount')}</span>
          <span class="price" id="ckDiscount" style="color:var(--green)">−${money(0)}</span>
        </div>
        <div class="row grand"><span>${t('cart.total')}</span><span class="price" id="ckTotal">${money(subtotal)}</span></div>
      </div>

      <button class="primary lg mt" id="placeOrder" style="width:100%"${scheduleReady ? '' : ' disabled'}>${esc(t('cart.order'))}</button>
      <div class="small muted mt" style="text-align:center">${esc(t('cart.cashNote'))}</div>
    </div>`;

  $('cartBack').onclick = () => show(state.resto ? 'viewResto' : 'viewHome');
  if ($('changeSlot')) {
    $('changeSlot').onclick = () => {
      if (state.resto?.restaurant?.id === state.cart.restaurant_id) {
        show('viewResto');
        document.getElementById('slotPicker')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        openResto(state.cart.restaurant_id);
      }
    };
  }
  document.querySelectorAll('[data-inc]').forEach((b) => b.onclick = () => {
    state.cart.items[Number(b.dataset.inc)].quantity += 1; saveCart(); renderCart();
  });
  document.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => {
    const index = Number(b.dataset.dec);
    state.cart.items[index].quantity -= 1;
    if (state.cart.items[index].quantity <= 0) state.cart.items.splice(index, 1);
    if (!state.cart.items.length) state.cart.restaurant_id = null;
    saveCart(); renderCart();
  });

  const currentFulfillment = () => document.querySelector('input[name=ful]:checked')?.value || 'pickup';

  // Totals come from the server whenever possible, so a promo code can never
  // be worth something different here than it is at checkout.
  /*
   * Redraws the address block at checkout.
   *
   * A delivery order needs one of the customer's own saved addresses, with a
   * pin — the server checks the same thing, so this only saves them a failed
   * request. Pickup hides the whole block: there is nothing to deliver to.
   */
  const paintCheckoutAddresses = () => {
    const box = $('ckAddrList');
    if (!box) return;
    if (!getToken()) {
      box.innerHTML = `<div class="alert warn"><span class="ic">👤</span>
        <div>${esc(t('auth.needLogin'))}</div></div>`;
      return;
    }
    box.innerHTML = addressState.list.length
      ? addressState.list.map((a) => addressCard(a, { selectable: true, actions: false })).join('')
      : `<div class="alert warn"><span class="ic">📍</span>
          <div>${esc(t('addr.needForDelivery'))}</div></div>`;
    wireAddressCards(box, () => { paintCheckoutAddresses(); refreshOrderButton(); });
  };

  /** Disabled whenever something the order needs is still missing. */
  const refreshOrderButton = () => {
    const button = $('placeOrder');
    if (!button) return;
    const delivery = currentFulfillment() === 'delivery';
    const picked = selectedAddress();
    const addressReady = !delivery || Boolean(picked && picked.has_pin);
    button.disabled = !(scheduleReady && addressReady);
    button.title = addressReady ? '' : t('addr.needForDelivery');
  };

  const refreshTotals = async () => {
    const delivery = currentFulfillment() === 'delivery';
    $('addrWrap').classList.toggle('hidden', !delivery);
    if ($('pickupWrap')) $('pickupWrap').classList.toggle('hidden', delivery);
    if (delivery) paintCheckoutAddresses();
    refreshOrderButton();
    $('ckFee').textContent = money(delivery ? fee : 0);
    $('ckTotal').textContent = money(subtotal + (delivery ? fee : 0));

    if (!getToken()) return;
    try {
      const quote = await api('/orders/quote', { method: 'POST', body: {
        restaurant_id: state.cart.restaurant_id,
        fulfillment_type: currentFulfillment(),
        promo_code: state.promo?.code || '',
        items: state.cart.items.map((i) => ({
          product_id: i.product_id, quantity: i.quantity, option_ids: i.option_ids, note: i.note })),
      } });
      state.quote = quote;
      $('ckSub').textContent = money(quote.items_subtotal_cents);
      $('ckFee').textContent = money(quote.delivery_fee_cents);
      $('ckTotal').textContent = money(quote.total_cents);
      $('ckDiscountRow').classList.toggle('hidden', !quote.discount_cents);
      $('ckDiscount').textContent = `−${money(quote.discount_cents)}`;
    } catch (e) {
      // A code that stopped being valid must not block the cart.
      if (state.promo) { state.promo = null; toast(e.message, true); renderCart(); }
    }
  };

  document.querySelectorAll('input[name=ful]').forEach((radio) => radio.onchange = refreshTotals);

  $('ckPromoBtn').onclick = async () => {
    if (state.promo) { state.promo = null; return renderCart(); }
    const code = $('ckPromo').value.trim().toUpperCase();
    if (!code) return;
    if (!getToken()) { toast(t('auth.needLogin'), true); return renderAccount(); }
    try {
      const quote = await api('/orders/quote', { method: 'POST', body: {
        restaurant_id: state.cart.restaurant_id,
        fulfillment_type: currentFulfillment(),
        promo_code: code,
        items: state.cart.items.map((i) => ({
          product_id: i.product_id, quantity: i.quantity, option_ids: i.option_ids, note: i.note })),
      } });
      state.promo = { code };
      state.quote = quote;
      toast(t('cart.promoApplied'));
      renderCart();
    } catch (e) { toast(e.message, true); }
  };

  $('ckAddrAdd').onclick = async () => {
    if (!getToken()) { toast(t('auth.needLogin'), true); return renderAccount(); }
    if (await addManually()) { paintCheckoutAddresses(); refreshOrderButton(); }
  };

  refreshTotals();
  $('placeOrder').onclick = placeOrder;
  show('viewCart');
}

async function placeOrder() {
  if (!getToken()) { toast(t('auth.needLogin'), true); return renderAccount(); }
  const fulfillment = document.querySelector('input[name=ful]:checked')?.value || 'pickup';
  const resto = state.restaurants.find((r) => r.id === state.cart.restaurant_id) || state.resto?.restaurant || {};
  const isPreorder = resto.service_type === 'preorder';

  // A pre-order cannot be sent without a day and a slot; stop before the request.
  if (isPreorder && (!state.schedule.date || !state.schedule.slot)) {
    return toast(t('svc.pickFirst'), true);
  }

  // Delivery without a pinned address is refused by the server; stop here so
  // the customer gets the reason instead of a failed request.
  const picked = selectedAddress();
  if (fulfillment === 'delivery' && !(picked && picked.has_pin)) {
    toast(t('addr.needForDelivery'), true);
    return renderAddresses();
  }

  const placedFrom = state.cart.restaurant_name;
  const button = $('placeOrder');
  button.disabled = true;
  button.textContent = t('cart.sending');
  try {
    const { order } = await api('/orders', { method: 'POST', body: {
      restaurant_id: state.cart.restaurant_id,
      fulfillment_type: fulfillment,
      customer_name: $('ckName').value.trim(),
      customer_phone: $('ckPhone').value.trim(),
      address_id: fulfillment === 'delivery' ? picked.id : null,
      note: $('ckNote').value.trim(),
      special_instructions: $('ckAllergy') ? $('ckAllergy').value.trim() : '',
      promo_code: state.promo?.code || '',
      scheduled_for: isPreorder ? state.schedule.date : '',
      scheduled_slot: isPreorder ? state.schedule.slot : '',
      items: state.cart.items.map((i) => ({
        product_id: i.product_id, quantity: i.quantity, option_ids: i.option_ids, note: i.note,
      })),
    } });
    state.cart = { restaurant_id: null, restaurant_name: '', items: [] };
    state.promo = null;
    state.schedule = { date: '', slot: '' };
    saveCart();
    toast(t('toast.ordered', { number: order.order_number }));
    state.ordersFilter = 'all';
    renderOrders({ justPlaced: { id: order.id, restaurant_name: placedFrom } });
  } catch (e) {
    toast(e.message, true);
    button.disabled = false;
    button.textContent = t('cart.order');
  }
}

/* ---------------- my orders ---------------- */
const FLOW = ['pending', 'accepted', 'preparing', 'ready', 'completed'];
const ACTIVE = ['pending', 'accepted', 'preparing', 'ready'];
let ordersTimer = null;
let trackTimer = null;

/** The restaurant as the home list knows it — its photo and prep time. */
const restoInfo = (id) => state.restaurants.find((r) => Number(r.id) === Number(id)) || null;

const restoName = (o) => (lang === 'ar' ? (o.restaurant_name_ar || o.restaurant_name) : o.restaurant_name);

/** The restaurant's photo as a square tile, or its initial when it has none. */
function logoTile(o, small = false) {
  const info = restoInfo(o.restaurant_id);
  const image = String(info?.image_url || '').trim();
  const inner = isPhotoUrl(image)
    ? `<img src="${esc(image)}" alt="" loading="lazy">`
    : esc((restoName(o) || '?').trim().charAt(0).toUpperCase());
  return `<div class="logotile${small ? ' sm' : ''}">${inner}</div>`;
}

/** "18:32", in the customer's own clock. */
const clock = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(lang === 'ar' ? 'ar-MA' : 'fr-FR', { hour: '2-digit', minute: '2-digit' });
};

async function renderOrders({ justPlaced = null } = {}) {
  if (!getToken()) return renderAccount();
  try {
    // The home list carries each restaurant's photo; fetch it once if the
    // customer came straight here.
    if (!state.restaurants.length) {
      try { state.restaurants = (await api('/restaurants')).restaurants; } catch { /* tiles fall back to initials */ }
    }
    const { orders } = await api('/orders');
    state.orders = orders;
    const filter = state.ordersFilter || 'all';
    const active = orders.filter((o) => ACTIVE.includes(o.status));
    const past = orders.filter((o) => !ACTIVE.includes(o.status));
    const tick = `<span class="tick">${icon('check', 12)}</span>`;
    const emptyBox = (text) => `<div class="empty"><div class="ic">${icon('receipt', 34)}</div><div>${esc(text)}</div></div>`;

    let body;
    if (!orders.length) {
      body = emptyBox(t('orders.empty'));
    } else if (filter === 'active') {
      body = active.length ? active.map(orderCard).join('') : emptyBox(t('orders.emptyActive'));
    } else if (filter === 'history') {
      body = past.length ? past.map(orderCard).join('') : emptyBox(t('orders.emptyHistory'));
    } else {
      body = `${active.length ? `<h2>${esc(t('orders.activeTitle'))}</h2>${active.map(orderCard).join('')}` : ''}
        ${past.length ? `<h2>${esc(t('orders.historyTitle'))}</h2>${past.map(orderCard).join('')}` : ''}`;
    }

    $('viewOrders').innerHTML = `
      <h1>${t('orders.title')}</h1>
      <p class="sub">${t('orders.sub')}</p>
      ${justPlaced ? `
        <div class="placed">
          <div class="ring">${icon('check', 32)}</div>
          <h2>${esc(t('track.placedTitle'))}</h2>
          <p>${esc(t('track.placedSub', { resto: justPlaced.restaurant_name || '' }))}</p>
          <button class="primary mt" data-track="${justPlaced.id}">${icon('clock', 18)} ${esc(t('track.title'))}</button>
        </div>` : ''}
      <div class="pilltabs" role="tablist">
        ${[['all', 'orders.tabAll'], ['active', 'orders.tabActive'], ['history', 'orders.tabHistory']].map(([key, label]) => `
          <button role="tab" data-ofilter="${key}" class="${filter === key ? 'active' : ''}" aria-selected="${filter === key}">
            ${tick}${esc(t(label))}</button>`).join('')}
      </div>
      ${body}`;

    document.querySelectorAll('[data-ofilter]').forEach((b) => {
      b.onclick = () => { state.ordersFilter = b.dataset.ofilter; renderOrders(); };
    });
    document.querySelectorAll('#viewOrders [data-track]').forEach((el) => {
      el.onclick = (e) => {
        // Buttons and links inside the card keep their own job.
        const control = e.target.closest('a, button');
        if (control && control !== el) return;
        renderTrack(Number(el.dataset.track));
      };
    });
    wireOrderActions($('viewOrders'), () => renderOrders());
    show('viewOrders');
    // Keep the status fresh while the customer is watching this screen.
    clearInterval(ordersTimer);
    ordersTimer = setInterval(() => {
      if (!$('viewOrders').classList.contains('hidden')) renderOrders();
      else clearInterval(ordersTimer);
    }, 20000);
  } catch (e) { toast(e.message, true); }
}

/** Rate and cancel, wherever an order is shown. */
function wireOrderActions(root, refresh) {
  root.querySelectorAll('[data-rate]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openReviewModal(b.dataset.rate, b.dataset.resto); };
  });
  root.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(t('orders.confirmCancel'))) return;
    try {
      await api(`/orders/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} });
      toast(t('toast.cancelled'));
      refresh();
    } catch (err) { toast(err.message, true); }
  });
}

const STEP_LABELS = ['status.pending', 'orders.step.accepted', 'orders.step.preparing', 'status.ready', 'status.completed'];

/** The call / WhatsApp / rate / cancel row, shared by the card and the tracking screen. */
function orderActions(o) {
  const pill = 'padding:5px 11px;border-radius:999px;gap:5px';
  return `
    <a class="small btn-like ghost" href="tel:${esc(o.restaurant_phone)}" style="${pill}">${icon('phone', 14)}${t('orders.call')}</a>
    ${o.restaurant_phone ? `<a class="small btn-like ghost" href="https://wa.me/212${String(o.restaurant_phone).replace(/\D/g, '').replace(/^0/, '')}" target="_blank" rel="noopener noreferrer" style="color:#0f7b4f;border-color:#bbf7d0;background:#f0fdf4;${pill}">${icon('chat', 14)}WhatsApp</a>` : ''}
    ${o.status === 'completed' ? (o.my_review
      ? `<span class="small muted" style="margin-inline-start:auto">
          ${esc(t('rev.yourRating'))} ${'★'.repeat(o.my_review.rating)}</span>`
      : `<button class="primary small" data-rate="${o.id}"
          data-resto="${esc(o.restaurant_name)}" style="margin-inline-start:auto">
          ★ ${esc(t('rev.rateOrder'))}</button>`) : ''}
    ${o.status === 'pending' ? `<button class="danger small" data-cancel="${o.id}" style="margin-inline-start:auto">${t('orders.cancel')}</button>` : ''}`;
}

function orderCard(o) {
  const index = FLOW.indexOf(o.status);
  const dead = o.status === 'cancelled' || o.status === 'rejected';
  const preorder = o.service_type === 'preorder' && o.scheduled_for;
  const showTrackHint = !dead && o.status !== 'completed' && o.status !== 'pending';
  const showSteps = !dead && o.status !== 'completed';
  return `
  <div class="card mt ordercard" data-track="${o.id}">
    <div class="head">
      ${logoTile(o)}
      <div class="grow">
        <h3 class="truncate">${esc(restoName(o))}</h3>
        <div class="meta2"><bdi>${esc(o.order_number)}</bdi> · <bdi>${esc(fmtDate(o.placed_at))}</bdi></div>
        <div class="meta2">${o.fulfillment_type === 'delivery'
          ? `${t('orders.delivery')} · ${esc(o.delivery?.one_line || o.delivery_address)}`
          : t('orders.pickup')} · <span class="price">${money(o.total_cents)}</span></div>
      </div>
      ${statusBadge(o.status)}
    </div>
    ${preorder ? `<div class="alert info mt" style="padding:9px 12px">
      ${icon('calendar', 16)}<div class="small">${esc(o.scheduled_slot
        ? t('svc.plannedForSlot', { date: formatScheduled(o.scheduled_for), slot: o.scheduled_slot })
        : t('svc.plannedFor', { date: formatScheduled(o.scheduled_for) }))}</div></div>` : ''}
    ${dead ? `<div class="small muted mt">${esc(o.cancellation_reason || '')}</div>`
      : (showSteps ? `<div class="steps">${FLOW.map((key, i) => `
          <div class="stepitem ${i < index ? 'done' : i === index ? 'now' : ''}">
            <div class="dotc">${i <= index ? icon('check', 14) : i + 1}</div>
            <div class="lbl">${esc(t(STEP_LABELS[i]))}</div>
          </div>`).join('')}</div>` : '')}
    ${o.delivery && o.fulfillment_type === 'delivery' ? `<div class="small muted mt-s">
      ${esc(o.delivery.recipient_name)} · ${esc(o.delivery.recipient_phone)}</div>` : ''}
    ${Number(o.refunded_cents) > 0 ? `<div class="small" style="color:var(--green)">${t('orders.refunded')}: ${money(o.refunded_cents)}</div>` : ''}
    <div class="foot">
      ${orderActions(o)}
      ${showTrackHint ? `<span class="small" style="margin-inline-start:auto;color:var(--brand);font-weight:700;display:inline-flex;align-items:center;gap:2px">${esc(t('orders.track'))}${icon('chevron', 16)}</span>` : ''}
    </div>
  </div>`;
}

/* ---------------- tracking screen ---------------- */

/*
 * One order, step by step, with the time each step happened.
 *
 * The times come from the order's status history, so they are the moments
 * the restaurant actually pressed the button, not guesses. Steps not reached
 * yet show no time at all.
 */
async function renderTrack(orderId) {
  if (!getToken()) return renderAccount();
  try {
    const { order: o } = await api(`/orders/${orderId}`);
    const listed = (state.orders || []).find((x) => Number(x.id) === Number(o.id));
    o.my_review = listed ? listed.my_review : null;

    const dead = o.status === 'cancelled' || o.status === 'rejected';
    const index = FLOW.indexOf(o.status);
    const pickup = o.fulfillment_type !== 'delivery';
    const reachedAt = (status) => (status === 'pending'
      ? o.placed_at
      : (o.history || []).find((h) => h.to_status === status)?.created_at || '');

    // Estimated ready time: the restaurant's prep time, counted from when it
    // accepted (or from when the order was placed, until it has).
    let eta = '';
    if (!dead && index < FLOW.indexOf('ready')) {
      if (o.service_type === 'preorder' && o.scheduled_for) {
        eta = t('track.scheduled', { date: `${formatScheduled(o.scheduled_for)}${o.scheduled_slot ? ` · ${o.scheduled_slot}` : ''}` });
      } else {
        const prep = Number(restoInfo(o.restaurant_id)?.prep_minutes || 0);
        const start = reachedAt('accepted') || o.placed_at;
        if (prep && start) eta = t('track.eta', { time: clock(new Date(new Date(start).getTime() + prep * 60000).toISOString()) });
      }
    }

    const subFor = (status) => (status === 'ready'
      ? t(pickup ? 'track.step.readySubPickup' : 'track.step.readySubDelivery')
      : t(`track.step.${status}Sub`));

    const timeline = FLOW.map((status, i) => {
      const cls = i < index || o.status === 'completed' ? 'done' : i === index ? 'now' : '';
      const at = i <= index ? reachedAt(status) : '';
      return `<li class="${cls}">
        <div class="node">${cls === 'done' ? icon('check', 16) : i + 1}</div>
        <div class="txt">
          <div class="row between" style="gap:8px"><strong>${esc(t(`track.step.${status}`))}</strong>
            ${cls === 'now' ? `<span class="badge now">${esc(t('track.now'))}</span>` : ''}</div>
          <span>${esc(subFor(status))}</span>
          ${at ? `<span class="time">${esc(clock(at))}</span>` : ''}
        </div>
      </li>`;
    }).join('');

    const itemName = (row) => (lang === 'ar' ? (row.name_ar || row.name) : row.name);
    const whereTo = pickup
      ? (o.restaurant_address || o.restaurant_city || '')
      : (o.delivery?.one_line || '');

    $('viewTrack').innerHTML = `
      ${pageBar('trackBack', t('track.title'))}

      <div class="card">
        <div class="track-head">
          ${logoTile(o, true)}
          <div class="grow">
            <div class="ordno">${esc(t('track.order', { n: o.order_number }))}</div>
            <h2>${esc(restoName(o))}</h2>
            ${whereTo ? `<div class="addr">${icon('pin', 14)} ${esc(whereTo)}</div>` : ''}
          </div>
          ${statusBadge(o.status)}
        </div>
        ${eta ? `<div class="eta">${icon('clock', 16)} ${esc(eta)}</div>` : ''}
      </div>

      ${dead
        ? `<div class="alert bad mt"><span class="ic">${icon('x', 16)}</span><div>${esc(t('track.cancelled'))}
            ${o.cancellation_reason ? `<div class="small">${esc(o.cancellation_reason)}</div>` : ''}</div></div>`
        : `<div class="card mt"><ol class="timeline">${timeline}</ol></div>`}

      ${o.status === 'ready' && pickup ? `
        <div class="collect mt">
          <strong>${esc(t('track.collectTitle'))}</strong>
          <ol>
            <li>${esc(t('track.collect1', { resto: restoName(o) }))}</li>
            <li>${esc(t('track.collect2'))} <span class="bigcode">${esc(o.order_number)}</span></li>
            <li>${esc(t('track.collect3'))}</li>
          </ol>
        </div>` : ''}

      <h2>${esc(t('track.items'))}</h2>
      <div class="card">
        ${(o.items || []).map((item) => `
          <div class="item">
            <div class="grow">
              <h3>${esc(itemName(item))} <span class="muted small">×${item.quantity}</span></h3>
              ${(item.options || []).length ? `<div class="small muted">${item.options.map((op) =>
                `${op.is_removal ? '✕ ' : ''}${esc(itemName(op))}`).join(' · ')}</div>` : ''}
              ${item.note ? `<div class="small muted">${esc(item.note)}</div>` : ''}
            </div>
            <div class="price">${money(item.line_total_cents)}</div>
          </div>`).join('')}
        <div class="totals">
          <div class="row"><span class="muted">${t('cart.subtotal')}</span><span class="price">${money(o.items_subtotal_cents)}</span></div>
          ${Number(o.delivery_fee_cents) ? `<div class="row"><span class="muted">${t('cart.deliveryFee')}</span><span class="price">${money(o.delivery_fee_cents)}</span></div>` : ''}
          ${Number(o.discount_cents) ? `<div class="row"><span style="color:var(--green)">${t('cart.discount')}</span><span class="price" style="color:var(--green)">−${money(o.discount_cents)}</span></div>` : ''}
          <div class="row grand"><span>${t('cart.total')}</span><span class="price">${money(o.total_cents)}</span></div>
        </div>
        <div class="small muted mt">${esc(t('track.cash'))}</div>
      </div>

      <div class="row wrap mt" style="gap:8px">${orderActions(o)}</div>

      <div class="stack mt">
        <button class="primary lg" id="trackHome">${esc(t('track.backHome'))}</button>
        <button class="outline lg" id="trackAll">${esc(t('track.allOrders'))}</button>
      </div>`;

    $('trackBack').onclick = () => renderOrders();
    $('trackAll').onclick = () => renderOrders();
    $('trackHome').onclick = () => renderHome();
    wireOrderActions($('viewTrack'), () => renderTrack(orderId));
    show('viewTrack');

    clearInterval(trackTimer);
    if (!dead && o.status !== 'completed') {
      trackTimer = setInterval(() => {
        if (!$('viewTrack').classList.contains('hidden')) renderTrack(orderId);
        else clearInterval(trackTimer);
      }, 20000);
    }
  } catch (e) { toast(e.message, true); }
}

/*
 * A star rating, shown only when somebody actually gave one.
 *
 * A restaurant with no reviews shows "Nouveau" rather than a number. An
 * average with nothing behind it is a claim made to a customer deciding where
 * to spend their money, and the honest thing to say is that nobody has
 * ordered yet.
 */
/*
 * The reviews under a restaurant's menu.
 *
 * Fetched separately and drawn when it arrives, so a slow query cannot delay
 * the menu. Nothing is shown at all when there are no reviews: an empty
 * "Reviews (0)" heading is noise on a phone screen.
 */
async function paintReviews(restaurantId) {
  const box = $('restoReviews');
  if (!box) return;
  try {
    const data = await api(`/restaurants/${restaurantId}/reviews?limit=10`);
    if (!data.reviews_count) {
      box.innerHTML = `<div class="small muted mt">${esc(t('rev.noReviews'))}</div>`;
      return;
    }
    const bars = [5, 4, 3, 2, 1].map((n) => {
      const count = Number(data.breakdown[n] || 0);
      const share = data.reviews_count ? Math.round((count / data.reviews_count) * 100) : 0;
      return `<div class="revbar">
        <span class="tiny muted">${n}\u2605</span>
        <span class="revbar-track"><span class="revbar-fill" style="width:${share}%"></span></span>
        <span class="tiny muted">${count}</span>
      </div>`;
    }).join('');

    box.innerHTML = `
      <h2>${esc(t('rev.allReviews'))}</h2>
      <div class="card">
        <div class="row between wrap" style="gap:14px;align-items:center">
          <div>
            <div style="font-size:30px;font-weight:700;line-height:1">${data.rating.toFixed(1)}</div>
            <div class="small muted">${esc(t('rev.basedOn', { n: data.reviews_count }))}</div>
          </div>
          <div class="grow" style="min-width:160px">${bars}</div>
        </div>
        ${data.reviews.map((review) => `
          <div class="listrow">
            <div class="grow">
              <div class="row" style="gap:8px;margin:0">
                <strong class="small">${esc(review.author)}</strong>
                <span class="star small">${'\u2605'.repeat(review.rating)}</span>
                <span class="tiny muted">${esc(fmtDate(review.created_at))}</span>
              </div>
              ${review.comment ? `<div class="small muted">${esc(review.comment)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
  } catch {
    // A restaurant page without its reviews is still a usable page.
    box.innerHTML = '';
  }
}

function ratingChip(resto, { big = false } = {}) {
  const count = Number(resto.reviews_count || 0);
  if (!count) return `<span class="badge">${esc(t('rev.new'))}</span>`;
  const size = big ? ' style="font-size:15px"' : '';
  return `<span class="rating"${size} title="${esc(t('rev.basedOn', { n: count }))}">
    <span class="star">\u2605</span>${Number(resto.rating || 0).toFixed(1)}
    <span class="tiny muted">(${count})</span></span>`;
}

/* ---------------- reviews ---------------- */

/*
 * The rating dialog: five stars and an optional comment.
 *
 * The stars are radio inputs rather than clickable spans, so a keyboard and a
 * screen reader can use them without any extra work, and the label text says
 * what each one means instead of leaving the reader to count.
 */
function openReviewModal(orderId, restaurantName) {
  const labels = ['rev.star1', 'rev.star2', 'rev.star3', 'rev.star4', 'rev.star5'];
  $('modalRoot').innerHTML = `
    <div class="modal-backdrop" id="revBackdrop">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="row" style="gap:12px">
          <div class="logotile sm">${esc((restaurantName || '?').trim().charAt(0).toUpperCase())}</div>
          <div class="grow">
            <h3 style="margin:0">${esc(restaurantName || '')}</h3>
            <div class="small muted">${esc(t('rev.title'))}</div>
          </div>
        </div>
        <div class="small muted center mt">${esc(t('rev.tapStar'))}</div>
        <div class="starpick" id="starPick">
          ${[5, 4, 3, 2, 1].map((n) => `
            <label class="starrow" title="${esc(t(labels[n - 1]))}">
              <input type="radio" name="rating" value="${n}" data-star="${n}">
              <span class="stars">${'\u2605'.repeat(n)}${'\u2606'.repeat(5 - n)}</span>
              <span class="bigstar">${icon('star', 40)}</span>
              <span class="word">${n} \u00b7 ${esc(t(labels[n - 1]))}</span>
            </label>`).join('')}
        </div>
        <div class="starcaption" id="starCaption" aria-live="polite"></div>
        <label>${esc(t('rev.comment'))}</label>
        <textarea id="revComment" rows="3" maxlength="1000"
          placeholder="${esc(t('rev.commentPlaceholder'))}"></textarea>
        <div class="modal-actions">
          <button id="revCancel">${esc(t('options.cancel'))}</button>
          <button class="primary" id="revSend" disabled>${esc(t('rev.send'))}</button>
        </div>
      </div>
    </div>`;

  const close = () => { $('modalRoot').innerHTML = ''; };
  const chosen = () => document.querySelector('input[name=rating]:checked');

  document.querySelectorAll('[data-star]').forEach((input) => {
    input.onchange = () => {
      $('revSend').disabled = !chosen();
      const n = Number(input.value);
      $('starCaption').textContent = t('rev.outOf', { word: t(labels[n - 1]), n });
    };
  });
  $('revCancel').onclick = close;
  $('revBackdrop').onclick = (e) => { if (e.target.id === 'revBackdrop') close(); };

  $('revSend').onclick = async () => {
    const picked = chosen();
    if (!picked) return;
    const button = $('revSend');
    button.disabled = true;
    try {
      await api(`/orders/${orderId}/review`, { method: 'POST', body: {
        rating: Number(picked.value),
        comment: $('revComment').value.trim(),
      } });
      close();
      toast(t('rev.thanks'));
      // The restaurant's average has just moved; drop the cached list so the
      // next visit to the home screen shows the new number.
      state.restaurants = [];
      renderOrders();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  };
}

/** One row of the profile menu: icon, label, optional value, chevron. */
const menuRow = ({ id = '', attrs = '', ic, label, value = '', red = false, href = '' }) => {
  const inner = `<span class="ic${red ? ' red' : ''}">${icon(ic, 18)}</span>
    <span class="lbl">${esc(label)}</span>
    ${value ? `<span class="val">${esc(value)}</span>` : ''}
    <span class="chev">${icon('chevron', 18)}</span>`;
  return href
    ? `<a class="rowlink" href="${href}"${id ? ` id="${id}"` : ''} ${attrs}>${inner}</a>`
    : `<button class="rowlink"${id ? ` id="${id}"` : ''} ${attrs}>${inner}</button>`;
};

/* ---------------- account ---------------- */

/*
 * The profile hub: who is signed in, then everything about the account as
 * one list. Each row opens its own screen instead of stacking every form on
 * one long page.
 */
function renderAccount() {
  if (state.user) {
    const user = state.user;
    const initial = (user.name || '?').trim().charAt(0).toUpperCase();
    $('viewAccount').innerHTML = `
      <div class="profile-head">
        <div class="avatar-lg">${esc(initial)}</div>
        <div class="grow">
          <h1>${esc(user.name || '')}</h1>
          <div class="small">${esc(user.phone || user.email || '')}</div>
        </div>
      </div>

      <div class="grouptitle">${esc(t('profile.activity'))}</div>
      <div class="card menulist" style="padding:4px 0">
        ${menuRow({ id: 'goOrders', ic: 'receipt', label: t('orders.title') })}
        ${menuRow({ id: 'goAddresses', ic: 'pin', label: t('addr.myAddresses'),
          value: addressState.list.length ? addressState.list.map((a) => chipLabel(a)).join(' · ') : t('addr.none') })}
      </div>

      <div class="grouptitle">${esc(t('profile.personal'))}</div>
      <div class="card">
        <label>${t('auth.name')}</label><input id="acName" value="${esc(user.name)}">
        <label>${t('auth.phone')}</label><input id="acPhone" inputmode="tel" value="${esc(user.phone || '')}">
        <label>${t('auth.emailOptional')}</label><input id="acEmail" type="email" value="${esc(user.email || '')}">
        <button class="primary mt" id="acSave" style="width:100%">${t('account.saveDetails')}</button>
      </div>

      <div class="grouptitle">${esc(t('profile.settings'))}</div>
      <div class="card menulist" style="padding:4px 0">
        ${menuRow({ id: 'goSecurity', ic: 'lock', label: t('profile.security') })}
        ${menuRow({ id: 'goLang', ic: 'globe', label: t('profile.language'), value: t('profile.languageVal') })}
        ${menuRow({ id: 'goHelp', ic: 'help', label: t('account.help') })}
        ${menuRow({ id: 'goLegal', ic: 'doc', label: t('account.legal') })}
        ${menuRow({ ic: 'store', label: t('account.restaurantPrompt'), href: '/restaurant.html' })}
        <button class="rowlink logout" id="logoutBtn"><span class="ic">${icon('logout', 18)}</span>
          <span class="lbl">${esc(t('account.logout'))}</span></button>
      </div>`;

    $('goOrders').onclick = () => renderOrders();
    $('goAddresses').onclick = renderAddresses;
    $('acSave').onclick = async () => {
      try {
        const { user: saved } = await api('/me', { method: 'PUT', body: {
          name: $('acName').value.trim(), phone: $('acPhone').value.trim(), email: $('acEmail').value.trim() } });
        state.user = saved;
        toast(t('account.detailsSaved'));
        renderAccount();
      } catch (e) { toast(e.message, true); }
    };
    $('goSecurity').onclick = renderSecurity;
    $('goLang').onclick = () => $('langBtn').click();
    $('goHelp').onclick = renderHelp;
    $('goLegal').onclick = () => renderLegal('about');
    $('logoutBtn').onclick = () => {
      logout();
      state.user = null;
      state.orders = [];
      addressState.list = [];
      addressState.loaded = false;
      setSelected(null);
      toast(t('toast.loggedOut'));
      renderAccount();
    };
    return show('viewAccount');
  }

  $('viewAccount').innerHTML = `
    <h1>${t('auth.title')}</h1>
    <p class="sub">${t('auth.sub')}</p>
    <div class="pilltabs">
      <button class="active" id="tabLogin">${t('auth.have')}</button>
      <button id="tabRegister">${t('auth.create')}</button>
    </div>
    <div class="card" id="authCard"></div>`;

  const loginForm = `
    <label>${t('auth.identifier')}</label><input id="liId" inputmode="tel" placeholder="0612345678">
    <label>${t('auth.password')}</label><input id="liPass" type="password">
    <button class="primary mt" id="liBtn" style="width:100%">${t('auth.login')}</button>
    <div class="small muted mt">${t('auth.testPhone')}</div>`;

  // Sign-up is two steps: details, then the code sent to the phone.
  const registerForm = `
    <div class="field"><label>${esc(t('auth.name'))}</label><input id="rgName"></div>
    <div class="field"><label>${esc(t('auth.phone'))}</label>
      <input id="rgPhone" inputmode="tel" placeholder="0612345678">
      <div class="help">${esc(t('auth.phoneHint'))}</div></div>
    <div class="field"><label>${esc(t('auth.emailOptional'))}</label><input id="rgEmail" type="email"></div>
    <div class="field"><label>${esc(t('auth.passwordNew'))}</label><input id="rgPass" type="password"></div>
    <button class="primary block lg" id="rgBtn">${esc(t('auth.sendCode'))}</button>`;

  /** Step two: the six-digit code. */
  const codeForm = (phone) => `
    <div class="alert info"><span class="ic">📩</span>
      <div>${esc(t('auth.codeSent', { phone }))}</div></div>
    <div class="field mt"><label>${esc(t('auth.code'))}</label>
      <input id="rgCode" inputmode="numeric" maxlength="6" placeholder="123456"
             style="font-size:22px;letter-spacing:6px;text-align:center"></div>
    <button class="primary block lg" id="rgConfirm">${esc(t('auth.register'))}</button>
    <div class="row between mt">
      <button class="ghost small" id="rgBack">${esc(t('auth.changeNumber'))}</button>
      <button class="ghost small" id="rgResend">${esc(t('auth.resend'))}</button>
    </div>`;

  /** Keeps what was typed in step one while the code is entered. */
  let pending = null;

  const mount = (html) => {
    $('authCard').innerHTML = html;

    if ($('liBtn')) {
      $('liBtn').onclick = () => doAuth('/auth/login', {
        identifier: $('liId').value.trim(), password: $('liPass').value });
      $('liPass').onkeydown = (e) => { if (e.key === 'Enter') $('liBtn').click(); };
    }

    if ($('rgBtn')) {
      $('rgBtn').onclick = async () => {
        const details = {
          name: $('rgName').value.trim(), email: $('rgEmail').value.trim(),
          phone: $('rgPhone').value.trim(), password: $('rgPass').value,
          role: 'customer', locale: lang,
        };
        if (details.name.length < 2) return toast(t('auth.needName'), true);
        if (!details.phone) return toast(t('auth.needPhone'), true);
        if (details.password.length < 8) return toast(t('auth.needPassword'), true);

        const button = $('rgBtn');
        button.disabled = true;
        button.innerHTML = `<span class="spinner"></span>`;
        try {
          await api('/auth/request-code', { method: 'POST', body: { phone: details.phone } });
          pending = details;
          mount(codeForm(details.phone));
        } catch (e) {
          toast(e.message, true);
          button.disabled = false;
          button.textContent = t('auth.sendCode');
        }
      };
    }

    if ($('rgConfirm')) {
      $('rgConfirm').onclick = () => doAuth('/auth/register', {
        ...pending, code: $('rgCode').value.trim() });
      $('rgCode').onkeydown = (e) => { if (e.key === 'Enter') $('rgConfirm').click(); };
      $('rgCode').focus();
      $('rgBack').onclick = () => mount(registerForm);
      $('rgResend').onclick = async () => {
        try {
          await api('/auth/request-code', { method: 'POST', body: { phone: pending.phone } });
          toast(t('auth.codeResent'));
        } catch (e) { toast(e.message, true); }
      };
    }
  };
  mount(loginForm);
  $('tabLogin').onclick = () => { $('tabLogin').classList.add('active'); $('tabRegister').classList.remove('active'); mount(loginForm); };
  $('tabRegister').onclick = () => { $('tabRegister').classList.add('active'); $('tabLogin').classList.remove('active'); mount(registerForm); };
  show('viewAccount');
}

/** Personal information: name, phone, email. */
function renderPersonal() {
  const user = state.user;
  if (!user) return renderAccount();
  const initial = (user.name || '?').trim().charAt(0).toUpperCase();
  $('viewAccount').innerHTML = `
    ${pageBar('personalBack', t('profile.personal'))}
    <div class="center mb"><div class="avatar-lg" style="margin:0 auto;width:72px;height:72px;font-size:28px">${esc(initial)}</div></div>
    <div class="card">
      <label>${t('auth.name')}</label><input id="acName" value="${esc(user.name)}">
      <label>${t('auth.phone')}</label><input id="acPhone" inputmode="tel" value="${esc(user.phone || '')}">
      <label>${t('auth.emailOptional')}</label><input id="acEmail" type="email" value="${esc(user.email || '')}">
    </div>
    <button class="primary lg block mt" id="acSave">${t('account.saveDetails')}</button>`;

  $('personalBack').onclick = renderAccount;
  $('acSave').onclick = async () => {
    try {
      const { user: saved } = await api('/me', { method: 'PUT', body: {
        name: $('acName').value.trim(), phone: $('acPhone').value.trim(), email: $('acEmail').value.trim() } });
      state.user = saved;
      toast(t('account.detailsSaved'));
      renderAccount();
    } catch (e) { toast(e.message, true); }
  };
  show('viewAccount');
}

/** Password change. */
function renderSecurity() {
  if (!state.user) return renderAccount();
  $('viewAccount').innerHTML = `
    ${pageBar('securityBack', t('profile.security'))}
    <div class="card">
      <h3>${t('account.changePassword')}</h3>
      <label>${t('account.currentPassword')}</label><input id="pwCurrent" type="password" autocomplete="current-password">
      <label>${t('account.newPassword')}</label><input id="pwNew" type="password" autocomplete="new-password">
    </div>
    <button class="primary lg block mt" id="pwBtn">${t('account.save')}</button>`;

  $('securityBack').onclick = renderAccount;
  $('pwBtn').onclick = async () => {
    try {
      const data = await api('/auth/password', { method: 'POST', body: {
        current_password: $('pwCurrent').value, new_password: $('pwNew').value } });
      setToken(data.token);
      toast(t('account.passwordChanged'));
      renderAccount();
    } catch (e) { toast(e.message, true); }
  };
  show('viewAccount');
}

async function doAuth(path, body) {
  try {
    const data = await api(path, { method: 'POST', body });
    setToken(data.token);
    state.user = data.user;
    toast(t('auth.welcome', { name: data.user.name }));

    // The account's own addresses come first; an address typed before signing
    // in is written to the account now, so it is not lost.
    await loadAddresses();
    if (!hasAddresses()) await promoteDraft();

    if (state.cart.items.length) renderCart(); else renderHome();
  } catch (e) { toast(e.message, true); }
}

/* ---------------- help & legal ---------------- */
function renderHelp() {
  const questions = FAQ[lang] || FAQ.fr;
  $('viewHelp').innerHTML = `
    <h1>${t('help.title')}</h1>
    <p class="sub">${t('help.sub')}</p>

    <h2>${t('help.faq')}</h2>
    <div class="card">
      ${questions.map((item, i) => `
        <div class="item" style="display:block;cursor:pointer" data-faq="${i}">
          <div class="row between"><h3 style="margin:0">${esc(item.q)}</h3><span class="muted">+</span></div>
          <div class="small muted hidden" id="faq${i}" style="margin-top:6px">${esc(item.a)}</div>
        </div>`).join('')}
    </div>

    <h2>${t('help.contactTitle')}</h2>
    <div class="card">
      <div class="small muted">${t('help.contactSub')}</div>
      <label>${t('help.name')}</label><input id="spName" value="${esc(state.user?.name || '')}">
      <label>${t('help.phone')}</label><input id="spPhone" inputmode="tel" value="${esc(state.user?.phone || '')}">
      <label>${t('help.orderNumber')}</label><input id="spOrder" placeholder="CMD-…">
      <label>${t('help.subject')}</label><input id="spSubject">
      <label>${t('help.message')}</label>
      <textarea id="spMessage" rows="4" placeholder="${t('help.messagePlaceholder')}"></textarea>
      <button class="primary mt" id="spSend" style="width:100%">${t('help.send')}</button>
    </div>

    <h2>${esc(t('legal.pages'))}</h2>
    <div class="chips" style="justify-content:center">
      <button class="chip" data-legal="about">${esc(t('legal.about'))}</button>
      <button class="chip" data-legal="terms">${esc(t('legal.terms'))}</button>
      <button class="chip" data-legal="privacy">${esc(t('legal.privacy'))}</button>
      <button class="chip" data-legal="cod">${esc(t('legal.cod'))}</button>
      <button class="chip" data-legal="cookies">${esc(t('legal.cookies'))}</button>
      <button class="chip" data-legal="retention">${esc(t('legal.retention'))}</button>
      <button class="chip" data-legal="contact">${esc(t('legal.contact'))}</button>
    </div>`;

  document.querySelectorAll('[data-faq]').forEach((row) => {
    row.onclick = () => {
      const answer = $(`faq${row.dataset.faq}`);
      answer.classList.toggle('hidden');
      row.querySelector('.muted').textContent = answer.classList.contains('hidden') ? '+' : '−';
    };
  });
  document.querySelectorAll('[data-legal]').forEach((b) => b.onclick = () => renderLegal(b.dataset.legal));

  $('spSend').onclick = async () => {
    const button = $('spSend');
    button.disabled = true;
    try {
      await api('/support', { method: 'POST', body: {
        name: $('spName').value.trim(),
        phone: $('spPhone').value.trim(),
        order_number: $('spOrder').value.trim(),
        subject: $('spSubject').value.trim(),
        message: $('spMessage').value.trim(),
      } });
      toast(t('help.sent'));
      $('spMessage').value = '';
      $('spSubject').value = '';
      $('spOrder').value = '';
    } catch (e) { toast(e.message, true); }
    button.disabled = false;
  };
  show('viewHelp');
}

/** The business identity, fetched once and reused by every legal page. */
async function legalContext() {
  if (!state.legal) {
    try { state.legal = await api('/legal'); }
    catch { state.legal = { values: {}, fields: [], missing: [], complete: false }; }
  }
  return state.legal;
}

async function renderLegal(which) {
  const business = await legalContext();
  const pages = buildLegal(business, lang);
  const page = pages[which] || pages.about;

  $('viewLegal').innerHTML = `
    ${pageBar('legalBack', page.title)}

    ${business.complete
      ? `<div class="alert info small"><span class="ic">ℹ️</span><div>${esc(t('legal.template'))}</div></div>`
      : `<div class="alert warn small"><span class="ic">⚠️</span><div>${esc(t('legal.incomplete'))}</div></div>`}

    <div class="chips scroll mt">
      ${LEGAL_PAGES.map((key) => `<button class="chip ${key === which ? 'active' : ''}" data-legalnav="${key}">
        ${esc(pages[key].title)}</button>`).join('')}
    </div>

    <div class="card mt">
      ${page.sections.map((section) => `
        <h3 style="margin:18px 0 8px">${esc(section.heading)}</h3>
        ${section.paragraphs.map((paragraph) =>
          `<p class="small" style="margin:0 0 10px">${esc(paragraph)}</p>`).join('')}
      `).join('')}
    </div>`;

  $('legalBack').onclick = renderHelp;
  document.querySelectorAll('[data-legalnav]').forEach((button) => {
    button.onclick = () => renderLegal(button.dataset.legalnav);
  });
  show('viewLegal');
}

/* ---------------- boot ---------------- */
$('homeLink').onclick = () => renderHome();
$('navHome').onclick = () => renderHome();
$('navOrders').onclick = () => renderOrders();
$('navCart').onclick = renderCart;
$('navHelp').onclick = renderHelp;
$('navAccount').onclick = renderAccount;
$('goToCart').onclick = renderCart;
$('langBtn').onclick = async () => {
  toggleLang();
  paintChrome();
  if (getToken()) api('/me/locale', { method: 'PUT', body: { locale: lang } }).catch(() => {});
  const current = VIEWS.find((v) => !$(v).classList.contains('hidden'));
  if (current === 'viewResto' && state.resto) openResto(state.resto.restaurant.id);
  else if (current === 'viewCart') renderCart();
  else if (current === 'viewOrders') renderOrders();
  else if (current === 'viewTrack') renderOrders();
  else if (current === 'viewAccount') renderAccount();
  else if (current === 'viewHelp') renderHelp();
  else if (current === 'viewAddresses') renderAddresses();
  else if (current === 'viewGate') renderGate();
  else renderHome();
};

(async function boot() {
  paintChrome();
  if (getToken()) {
    try { const { user } = await api('/me'); state.user = user; } catch { setToken(null); }
  }
  if (getToken()) {
    await loadAddresses();
    // A draft left over from before this account signed in.
    if (!hasAddresses() && readDraft()) await promoteDraft();
  }
  await renderHome();
})();
