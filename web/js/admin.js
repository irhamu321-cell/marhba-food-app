import { api, getToken, setToken, logout, toast, esc } from './api.js';
import { t, lang, toggleLang, applyDirection } from './i18n.js';
import { renderDashboard } from './admin-dashboard.js';
import { renderRestaurants } from './admin-restaurants.js';
import { renderOrders, renderRefunds } from './admin-orders.js';
import { renderCustomers, renderStaff, renderSupport } from './admin-people.js';
import { renderCatalog } from './admin-catalog.js';
import { renderCod, renderSettlements } from './admin-money.js';
import { renderReports } from './admin-reports.js';
import { renderPromos, renderAudit, renderSettings, renderCommissions } from './admin-system.js';

const root = document.getElementById('root');
const $ = (id) => document.getElementById(id);

export const state = {
  user: null, permissions: [], section: 'dashboard',
  badges: {}, adminRole: null, pendingSearch: null, navOpen: false, freshNav: false,
  health: null,
};

/** Each entry: sidebar icon, required permission, renderer, optional badge key. */
const SECTIONS = [
  { group: 'nav.steering', items: [
    { key: 'dashboard', ic: '📊', perm: 'dashboard.view', render: renderDashboard },
  ] },
  { group: 'nav.operations', items: [
    { key: 'restaurants', ic: '🏪', perm: 'restaurants.view', render: renderRestaurants, badge: 'pending_restaurants' },
    { key: 'orders',      ic: '🧾', perm: 'orders.view',      render: renderOrders },
    { key: 'catalog',     ic: '📖', perm: 'restaurants.view', render: renderCatalog },
    { key: 'customers',   ic: '👥', perm: 'customers.view',   render: renderCustomers },
  ] },
  { group: 'nav.finance', items: [
    { key: 'cod',         ic: '💵', perm: 'cod.manage',         render: renderCod, badge: 'cod_disputed' },
    { key: 'settlements', ic: '🏦', perm: 'settlements.manage', render: renderSettlements },
    { key: 'refunds',     ic: '↩️', perm: 'refunds.view',       render: renderRefunds },
    { key: 'commissions', ic: '📈', perm: 'reports.view',       render: renderCommissions },
    { key: 'reports',     ic: '📑', perm: 'reports.view',       render: renderReports },
  ] },
  { group: 'nav.platform', items: [
    { key: 'promos',   ic: '🎟️', perm: 'promotions.manage', render: renderPromos },
    { key: 'messages', ic: '💬', perm: 'support.manage',    render: renderSupport, badge: 'open_support' },
    { key: 'staff',    ic: '🧑‍💼', perm: 'staff.manage',     render: renderStaff },
    { key: 'audit',    ic: '🗂️', perm: 'audit.view',        render: renderAudit },
    { key: 'settings', ic: '⚙️', perm: 'settings.manage',   render: renderSettings },
  ] },
];

const allItems = () => SECTIONS.flatMap((g) => g.items);
const allowed = (item) => state.permissions.includes(item.perm);

export const ctx = {
  go(section, search = null) {
    const item = allItems().find((i) => i.key === section);
    if (!item || !allowed(item)) return;
    state.section = section;
    state.pendingSearch = search;
    // Entering a section anew should show its list, not the record left open before.
    state.freshNav = true;
    closeNav();
    renderShell();
  },
  refresh() { renderShell(); },
  get state() { return state; },
  can(permission) { return state.permissions.includes(permission); },
  /** A section calls this once to consume a search term sent from the top bar. */
  takeSearch() { const s = state.pendingSearch; state.pendingSearch = null; return s; },
  /**
   * True once per navigation into a section. A section that keeps an open
   * record calls this to decide whether to drop back to its list.
   */
  takeFresh() { const fresh = state.freshNav; state.freshNav = false; return fresh; },
};

/* ------------------------------------------------------------------ login */

function renderAuth() {
  applyDirection();
  root.innerHTML = `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:22px;
              background:linear-gradient(140deg,#14171e,#241a16 65%,#33201a)">
    <div style="width:100%;max-width:400px">
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:20px;color:#fff">
        <div class="mark" style="width:38px;height:38px;border-radius:11px;display:flex;align-items:center;
             justify-content:center;font-size:20px;background:linear-gradient(135deg,#c8452b,#e8714f)">🍽️</div>
        <div>
          <div style="font-size:20px;font-weight:720;letter-spacing:-.4px">Marhba</div>
          <div style="font-size:12.5px;color:rgba(255,255,255,.6)">${esc(t('a.title'))}</div>
        </div>
      </div>
      <div class="card" style="padding:22px">
        <h3 style="font-size:16px;margin-bottom:3px">${esc(t('auth.login'))}</h3>
        <p class="small muted" style="margin:0 0 16px">${esc(t('a.sub'))}</p>
        <div class="field">
          <label for="email">${esc(t('auth.identifier'))}</label>
          <input id="email" autocomplete="username" placeholder="0600000000">
        </div>
        <div class="field">
          <label for="pass">${esc(t('auth.password'))}</label>
          <input id="pass" type="password" autocomplete="current-password">
        </div>
        <button class="primary block lg" id="btn">${esc(t('auth.login'))}</button>
        <div class="alert info small" style="margin-top:14px">
          <span class="ic">💡</span><div>${esc(t('a.testAccount'))}</div>
        </div>
      </div>
      <div style="text-align:center;margin-top:14px">
        <button class="ghost small" id="langBtn" style="color:rgba(255,255,255,.75)">${esc(t('lang.switch'))}</button>
      </div>
    </div>
  </div>`;

  $('btn').onclick = async () => {
    const button = $('btn');
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>`;
    try {
      const data = await api('/auth/login', { method: 'POST', body: {
        identifier: $('email').value.trim(), password: $('pass').value } });
      if (data.user.role !== 'admin') throw new Error(t('a.notAdmin'));
      setToken(data.token);
      boot();
    } catch (e) {
      toast(e.message, true);
      button.disabled = false;
      button.textContent = t('auth.login');
    }
  };
  $('email').onkeydown = (e) => { if (e.key === 'Enter') $('pass').focus(); };
  $('pass').onkeydown  = (e) => { if (e.key === 'Enter') $('btn').click(); };
  $('langBtn').onclick = switchLang;
}

/* ------------------------------------------------------------------ shell */

const initials = (user) => {
  const source = user?.name || user?.email || user?.phone || '?';
  return source.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
};

function sidebarHtml() {
  return SECTIONS.map((group) => {
    const visible = group.items.filter(allowed);
    if (!visible.length) return '';
    return `<div class="navgroup">${esc(t(group.group))}</div>` + visible.map((item) => {
      const count = state.badges[item.badge];
      return `<button class="navlink ${item.key === state.section ? 'active' : ''}" data-section="${item.key}">
        <span class="ic">${item.ic}</span>
        <span class="lbl">${esc(t(`nav.${item.key}`))}</span>
        ${count ? `<span class="count">${count}</span>` : ''}
      </button>`;
    }).join('');
  }).join('');
}

function notificationsHtml() {
  const rows = [];
  if (state.badges.pending_restaurants) {
    rows.push({ ic: '🏪', key: 'restaurants', text: t('notif.pendingRestaurants', { n: state.badges.pending_restaurants }) });
  }
  if (state.badges.open_support) {
    rows.push({ ic: '💬', key: 'messages', text: t('notif.openSupport', { n: state.badges.open_support }) });
  }
  if (state.badges.cod_disputed) {
    rows.push({ ic: '⚠️', key: 'cod', text: t('notif.codDisputed', { n: state.badges.cod_disputed }) });
  }
  if (!rows.length) {
    return `<div class="po-item" style="cursor:default;color:var(--ink-2)">
      <span class="ic">✅</span><div>${esc(t('notif.none'))}</div></div>`;
  }
  return rows.map((r) => `<div class="po-item" data-notif="${r.key}">
    <span class="ic">${r.ic}</span><div>${esc(r.text)}</div></div>`).join('');
}

const notifCount = () =>
  (state.badges.pending_restaurants || 0) + (state.badges.open_support || 0) + (state.badges.cod_disputed || 0);

function renderShell() {
  const current = allItems().find((i) => i.key === state.section);
  if (!current || !allowed(current)) {
    state.section = (allItems().find(allowed) || {}).key || 'dashboard';
  }
  applyDirection();

  const n = notifCount();
  root.innerHTML = `
    <div class="appshell">
      <aside class="sidebar ${state.navOpen ? 'open' : ''}" id="sidebar">
        <div class="sb-brand" id="brand">
          <div class="mark">🍽️</div>
          <div><div>Marhba</div><small>${esc(t('a.title'))}</small></div>
        </div>
        <nav class="sb-nav">${sidebarHtml()}</nav>
        <div class="sb-foot" id="whoami"></div>
      </aside>

      <div class="maincol">
        <header class="topbar2">
          <button class="iconbtn burger" id="burger" aria-label="Menu">☰</button>
          <div class="searchbox">
            <input id="globalSearch" placeholder="${esc(t('search.placeholder'))}" autocomplete="off">
            <div id="searchResults" class="dropdown hidden" style="inset-inline-start:0;inset-inline-end:auto;width:100%;max-width:420px"></div>
          </div>
          <div style="flex:1"></div>
          <button class="ghost small" id="langBtn">${esc(t('lang.switch'))}</button>
          <div class="dropwrap">
            <button class="iconbtn" id="notifBtn" aria-label="${esc(t('notif.title'))}">🔔${n ? `<span class="dot">${n > 9 ? '9+' : n}</span>` : ''}</button>
            <div class="popover hidden" id="notifPop">
              <div class="po-head">${esc(t('notif.title'))}</div>
              <div class="po-body">${notificationsHtml()}</div>
            </div>
          </div>
          <div class="dropwrap">
            <button class="avatar" id="accountBtn">${esc(initials(state.user))}</button>
            <div class="dropdown hidden" id="accountMenu">
              <div class="dd-head">
                <strong>${esc(state.user?.name || state.user?.email || state.user?.phone || '')}</strong>
                <span>${esc(t(`role.${state.adminRole}`))}</span>
              </div>
              <button data-acc="settings">⚙️ ${esc(t('nav.settings'))}</button>
              <button data-acc="lang">🌐 ${esc(t('lang.switch'))}</button>
              <div class="sep"></div>
              <button data-acc="logout" style="color:var(--red)">↪ ${esc(t('nav.logout'))}</button>
            </div>
          </div>
        </header>
        <main class="content" id="content">
          <div id="systemBanner"></div>
        </main>
      </div>
      ${state.navOpen ? '<div class="scrim" id="scrim"></div>' : ''}
    </div>`;

  $('whoami').textContent =
    `${state.user?.email || state.user?.phone || ''} · ${t(`role.${state.adminRole}`)}`;

  document.querySelectorAll('[data-section]').forEach((button) => {
    button.onclick = () => ctx.go(button.dataset.section);
  });

  $('burger').onclick = () => { state.navOpen = true; renderShell(); };
  if ($('scrim')) $('scrim').onclick = closeNav;
  $('brand').onclick = () => ctx.go('dashboard');
  $('langBtn').onclick = switchLang;

  wireMenus();
  wireGlobalSearch();

  const item = allItems().find((i) => i.key === state.section);
  $('content').innerHTML = `<div class="loadwrap"><span class="spinner dark"></span>${esc(t('common.loading'))}</div>`;
  item.render(ctx);
  paintSystemBanner();
}

/**
 * A standing banner for anything an operator must fix: incomplete legal
 * details, a failed or stale backup, low disk, a bad production setting.
 * It is drawn above whatever section is open, in every section.
 */
async function paintSystemBanner() {
  if (!state.permissions.includes('dashboard.view')) return;
  try { state.health = await api('/admin/health'); }
  catch { return; }

  const warnings = state.health.warnings || [];
  if (!warnings.length) return;

  const banner = document.createElement('div');
  banner.id = 'systemBanner';
  banner.innerHTML = warnings.map((warning) => `
    <div class="alert ${warning.level === 'critical' ? 'bad' : 'warn'} mb">
      <span class="ic">${warning.level === 'critical' ? '⛔' : '⚠️'}</span>
      <div>${esc(warning.message)}</div>
    </div>`).join('');

  const content = $('content');
  const existing = $('systemBanner');
  if (existing) existing.replaceWith(banner);
  else content.prepend(banner);
}

function closeNav() {
  if (!state.navOpen) return;
  state.navOpen = false;
  const bar = $('sidebar'), scrim = $('scrim');
  if (bar) bar.classList.remove('open');
  if (scrim) scrim.remove();
}

function wireMenus() {
  const notifBtn = $('notifBtn'), notifPop = $('notifPop');
  const accBtn = $('accountBtn'), accMenu = $('accountMenu');

  const closeAll = () => { notifPop.classList.add('hidden'); accMenu.classList.add('hidden'); };

  notifBtn.onclick = (e) => {
    e.stopPropagation();
    accMenu.classList.add('hidden');
    notifPop.classList.toggle('hidden');
  };
  accBtn.onclick = (e) => {
    e.stopPropagation();
    notifPop.classList.add('hidden');
    accMenu.classList.toggle('hidden');
  };
  document.addEventListener('click', closeAll, { once: false });

  notifPop.querySelectorAll('[data-notif]').forEach((row) => {
    row.onclick = () => { closeAll(); ctx.go(row.dataset.notif); };
  });

  accMenu.querySelectorAll('[data-acc]').forEach((button) => {
    button.onclick = () => {
      closeAll();
      const what = button.dataset.acc;
      if (what === 'logout') { logout(); location.reload(); }
      else if (what === 'lang') switchLang();
      else ctx.go('settings');
    };
  });
}

/** Top-bar search: jumps to a section, or hands a query to a searchable one. */
function wireGlobalSearch() {
  const input = $('globalSearch'), panel = $('searchResults');
  const targets = [
    { key: 'orders', perm: 'orders.view' },
    { key: 'restaurants', perm: 'restaurants.view' },
    { key: 'customers', perm: 'customers.view' },
  ];

  const hide = () => panel.classList.add('hidden');

  const paint = () => {
    const q = input.value.trim();
    if (!q) return hide();
    const low = q.toLowerCase();

    const sections = allItems().filter(allowed)
      .filter((i) => t(`nav.${i.key}`).toLowerCase().includes(low))
      .slice(0, 5)
      .map((i) => `<button data-go="${i.key}">${i.ic} ${esc(t(`nav.${i.key}`))}</button>`);

    const searches = targets
      .filter((x) => state.permissions.includes(x.perm))
      .map((x) => `<button data-go="${x.key}" data-q="1">🔎 ${esc(t('search.in', { section: t(`nav.${x.key}`), q }))}</button>`);

    panel.innerHTML = (sections.length ? `<div class="dd-head"><span>${esc(t('search.sections'))}</span></div>${sections.join('')}` : '')
      + (searches.length ? `<div class="sep"></div>${searches.join('')}` : '');
    panel.classList.remove('hidden');

    panel.querySelectorAll('[data-go]').forEach((button) => {
      button.onclick = (e) => {
        e.stopPropagation();
        hide();
        ctx.go(button.dataset.go, button.dataset.q ? q : null);
      };
    });
  };

  input.oninput = paint;
  input.onclick = (e) => { e.stopPropagation(); paint(); };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { input.value = ''; hide(); }
    if (e.key === 'Enter') { const first = panel.querySelector('[data-go]'); if (first) first.click(); }
  };
  panel.onclick = (e) => e.stopPropagation();
}

/* ------------------------------------------------------------------ misc */

async function switchLang() {
  toggleLang();
  if (getToken()) api('/me/locale', { method: 'PUT', body: { locale: lang } }).catch(() => {});
  if (state.user) renderShell(); else renderAuth();
}

async function loadBadges() {
  try {
    const d = await api('/admin/dashboard');
    state.badges = {
      pending_restaurants: d.restaurants.pending || 0,
      open_support: d.open_support || 0,
      cod_disputed: d.cod.disputed || 0,
    };
  } catch { state.badges = {}; }
}

export async function refreshBadges() {
  await loadBadges();
}

async function boot() {
  applyDirection();
  if (!getToken()) return renderAuth();
  try {
    const me = await api('/me');
    if (me.user.role !== 'admin') throw new Error(t('a.notAdmin'));
    state.user = me.user;
    state.permissions = me.permissions || [];
    state.adminRole = me.admin_role;
    await loadBadges();
    renderShell();
  } catch {
    setToken(null);
    renderAuth();
  }
}
boot();
