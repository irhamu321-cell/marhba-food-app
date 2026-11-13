// End-to-end test — run with the server running:  node test/smoke.js
const BASE = process.env.BASE || 'http://localhost:3000';
let pass = 0, fail = 0;
const failures = [];

function check(label, condition, extra = '') {
  if (condition) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label} ${extra}`); }
}
const section = (name) => console.log(`\n== ${name} ==`);

async function call(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  return raw ? { status: res.status, data, res } : { status: res.status, data };
}

/**
 * Registration now requires a phone code. This walks the real flow:
 * ask for a code, read it from the pilot console, then register.
 * `adminToken` is needed to read the console; before an admin token exists,
 * the code is read straight from the module instead.
 */
let consoleToken = null;
async function registerWithCode(body) {
  const asked = await call('/auth/request-code', { method: 'POST', body: { phone: body.phone } });
  if (asked.status !== 201 && asked.status !== 200) return asked;
  const code = await latestCode(body.phone, 'register');
  if (!code) return { status: 0, data: { error: 'code introuvable dans la console' } };
  return call('/auth/register', { method: 'POST', body: { ...body, code } });
}

/** A working admin token, re-fetched whenever the cached one stops working. */
async function adminToken() {
  const login = await call('/auth/login', { method: 'POST', body: {
    identifier: ADMIN_PHONE, password: ADMIN_PASSWORD } });
  return login.data.token;
}

/**
 * Reads the live code for a destination from the admin console endpoint.
 * The suite revokes sessions along the way, so the token is renewed on refusal.
 */
async function latestCode(destination, purpose) {
  if (!consoleToken) consoleToken = await adminToken();
  let seen = await call('/admin/auth-codes', { token: consoleToken });
  if (seen.status !== 200) {
    consoleToken = await adminToken();
    seen = await call('/admin/auth-codes', { token: consoleToken });
  }
  const match = (seen.data.codes || []).find(
    (entry) => entry.destination === destination && entry.purpose === purpose);
  return match ? match.code : null;
}

const money = (c) => `${(c / 100).toFixed(2)} MAD`;
const ADMIN_PHONE = process.env.TEST_ADMIN_PHONE || '0600000000';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'admin1234';
const stamp = Date.now();
const uniquePhone = (prefix) => `0${prefix}${String(stamp).slice(-7)}`;
const RESTO_NEW = `Chez Test ${String(stamp).slice(-6)}`;
const RESTO_REJECTED = `Chez Refuse ${String(stamp).slice(-6)}`;

(async () => {
  section('Serveur');
  const health = await call('/health');
  check('GET /api/health repond 200', health.status === 200 && health.data.ok);
  console.log(`       (base de donnees: ${health.data.database})`);

  const corsProbe = await call('/health', { raw: true });
  check('pas d en-tete CORS ouvert par defaut', !corsProbe.res.headers.get('access-control-allow-origin'),
    corsProbe.res.headers.get('access-control-allow-origin') || '');

  section('Comptes');
  const customer = await registerWithCode({
    name: 'Test Client', email: `client${stamp}@test.ma`, phone: uniquePhone('61'), password: 'motdepasse1' });
  check('inscription client', customer.status === 201 && !!customer.data.token);
  let cToken = customer.data.token;

  const other = await registerWithCode({
    name: 'Autre', email: `autre${stamp}@test.ma`, phone: uniquePhone('69'), password: 'motdepasse1' });
  const oToken = other.data.token;

  check('mot de passe trop court refuse',
    (await call('/auth/register', { method: 'POST', body: { name: 'Nom Valide', email: `w${stamp}@t.ma`, phone: uniquePhone('62'), password: 'court' } })).status === 400);
  check('email en double refuse',
    (await registerWithCode({
      name: 'Test Deux', email: `client${stamp}@test.ma`, phone: uniquePhone('63'), password: 'motdepasse1' })).status === 409);

  const r1Login = await call('/auth/login', { method: 'POST', body: { email: 'resto1@demo.ma', password: 'resto1234' } });
  const r1Token = r1Login.data.token;
  check('connexion restaurant', !!r1Token);
  const r2Token = (await call('/auth/login', { method: 'POST', body: { email: 'resto2@demo.ma', password: 'resto1234' } })).data.token;
  const aToken = (await call('/auth/login', { method: 'POST', body: { email: 'admin@demo.ma', password: 'admin1234' } })).data.token;
  check('connexion admin', !!aToken);
  check('mauvais mot de passe refuse',
    (await call('/auth/login', { method: 'POST', body: { email: 'admin@demo.ma', password: 'mauvais123' } })).status === 401);

  section('Connexion par telephone');
  const phoneOnly = uniquePhone('65');
  const noEmail = await registerWithCode({
    name: 'Sans Email', phone: phoneOnly, password: 'motdepasse1' });
  check('inscription sans email', noEmail.status === 201 && noEmail.data.user.email === '', JSON.stringify(noEmail.data).slice(0, 90));
  check('telephone normalise', noEmail.data.user.phone === phoneOnly, noEmail.data.user.phone);

  const byPhone = await call('/auth/login', { method: 'POST', body: { identifier: phoneOnly, password: 'motdepasse1' } });
  check('connexion avec le numero', byPhone.status === 201);
  const international = await call('/auth/login', { method: 'POST', body: {
    identifier: `+212${phoneOnly.slice(1)}`, password: 'motdepasse1' } });
  check('connexion avec le format +212', international.status === 201);
  const spaced = await call('/auth/login', { method: 'POST', body: {
    identifier: phoneOnly.replace(/(\d{4})(\d{3})/, '$1 $2 '), password: 'motdepasse1' } });
  check('connexion avec des espaces dans le numero', spaced.status === 201);
  check('telephone deja pris refuse',
    (await registerWithCode({ name: 'Doublon', phone: phoneOnly, password: 'motdepasse1' })).status === 409);
  check('telephone invalide refuse',
    (await registerWithCode({ name: 'Mauvais', phone: 'abcdef', password: 'motdepasse1' })).status === 400);
  check('connexion par email toujours possible',
    (await call('/auth/login', { method: 'POST', body: { identifier: 'admin@demo.ma', password: 'admin1234' } })).status === 201);

  const phoneToken = byPhone.data.token;
  const edited = await call('/me', { method: 'PUT', token: phoneToken, body: {
    name: 'Nom Modifie', email: `edit${stamp}@test.ma` } });
  check('modification de mes informations', edited.status === 200 && edited.data.user.name === 'Nom Modifie');
  check('email ajoute apres coup', edited.data.user.email === `edit${stamp}@test.ma`);
  check('numero deja utilise refuse a la modification',
    (await call('/me', { method: 'PUT', token: phoneToken, body: { phone: '0633333333' } })).status === 409);

  section('Catalogue et arabe');
  const list = await call('/restaurants');
  check('liste des restaurants', list.status === 200 && list.data.restaurants.length >= 2);
  const atlas = list.data.restaurants.find((r) => r.name === 'Snack Atlas');
  const bella = list.data.restaurants.find((r) => r.name === 'Pizzeria Bella');
  check('nom arabe present dans la liste', atlas.name_ar === 'سناك أطلس', atlas.name_ar);

  const menu = await call(`/restaurants/${atlas.id}`);
  const products = menu.data.menu.flatMap((c) => c.products);
  const tacos = products.find((p) => p.name === 'Tacos poulet');
  const coca = products.find((p) => p.name === 'Coca 33cl');
  check('menu charge', menu.status === 200 && products.length >= 5);
  check('nom de plat en arabe', tacos.name_ar === 'طاكوس دجاج', tacos.name_ar);
  check('categories traduites', menu.data.menu.find((c) => c.name === 'Tacos')?.name_ar === 'طاكوس');

  section('Options de plat');
  check('groupes d options livres avec le menu', Array.isArray(tacos.option_groups) && tacos.option_groups.length === 3,
    String(tacos.option_groups?.length));
  const sizeGroup = tacos.option_groups.find((g) => g.name === 'Taille');
  const sauceGroup = tacos.option_groups.find((g) => g.name.startsWith('Sauces'));
  const extraGroup = tacos.option_groups.find((g) => g.name === 'Supplements');
  check('groupe obligatoire marque min_select=1', sizeGroup.min_select === 1 && sizeGroup.max_select === 1);
  check('options arabes presentes', sizeGroup.options[0].name_ar === 'متوسط', sizeGroup.options[0].name_ar);
  const sizeM = sizeGroup.options.find((o) => o.name === 'M');
  const sizeXXL = sizeGroup.options.find((o) => o.name === 'XXL');
  const cheese = extraGroup.options.find((o) => o.name === 'Fromage');
  check('supplement avec prix', cheese.price_delta_cents === 500);

  const missingRequired = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup', items: [{ product_id: tacos.id, quantity: 1 }] } });
  check('option obligatoire manquante refusee', missingRequired.status === 400, missingRequired.data.error);

  const tooMany = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [...sauceGroup.options.map((o) => o.id), sizeM.id] }] } });
  check('trop d options dans un groupe refusee', tooMany.status === 400, tooMany.data.error);

  const foreignOption = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: coca.id, quantity: 3, option_ids: [cheese.id] }] } });
  check('option d un autre plat refusee', foreignOption.status === 400, foreignOption.data.error);

  section('Commande avec options');
  const placed = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup', customer_phone: '0612345678',
    items: [{ product_id: tacos.id, quantity: 2, option_ids: [sizeXXL.id, cheese.id], note: 'bien cuit' }],
    total_cents: 1, commission_cents: 0 } });
  check('commande creee', placed.status === 201, JSON.stringify(placed.data).slice(0, 150));
  const order = placed.data.order;
  const expectedUnit = 3500 + 2000 + 500;              // base + XXL + fromage
  const expectedSubtotal = expectedUnit * 2;           // 120.00 MAD
  const expectedCommission = Math.round(expectedSubtotal * 0.15);
  check(`prix unitaire avec options = ${money(expectedUnit)}`, order.items[0].unit_price_cents === expectedUnit, String(order.items[0].unit_price_cents));
  check(`sous-total = ${money(expectedSubtotal)}`, order.items_subtotal_cents === expectedSubtotal);
  check('prix envoye par le client ignore', order.total_cents === expectedSubtotal);
  check('options enregistrees sur la ligne', order.items[0].options.length === 2);
  check('option archivee avec son nom arabe', order.items[0].options.some((o) => o.name_ar === 'كبير جدا'));
  check(`commission = ${money(expectedCommission)}`, order.commission_cents === expectedCommission);
  check('taux de commission fige sur la commande', order.commission_rate_bp === 1500);
  check('net restaurant correct', order.restaurant_net_cents === expectedSubtotal - expectedCommission);

  section('Securite');
  check('un autre client ne voit pas la commande', (await call(`/orders/${order.id}`, { token: oToken })).status === 403);
  check('visiteur non connecte bloque', (await call(`/orders/${order.id}`)).status === 401);
  check('un autre restaurant ne peut pas la modifier',
    (await call(`/restaurant/orders/${order.id}/status`, { method: 'POST', token: r2Token, body: { status: 'accepted' } })).status === 403);
  check('un client ne peut pas acceder a l admin', (await call('/admin/stats', { token: cToken })).status === 403);
  check('un client ne peut pas gerer un menu', (await call('/restaurant/menu', { token: cToken })).status === 403);
  check('token falsifie rejete',
    (await call('/me', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjEsInJvbGUiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OSwidHYiOjB9.fake' })).status === 401);

  section('Revocation de session');
  const pwBad = await call('/auth/password', { method: 'POST', token: cToken, body: { current_password: 'faux', new_password: 'nouveaumdp1' } });
  check('mot de passe actuel verifie', pwBad.status === 401);
  const oldToken = cToken;
  const pwOk = await call('/auth/password', { method: 'POST', token: cToken, body: { current_password: 'motdepasse1', new_password: 'nouveaumdp1' } });
  check('changement de mot de passe accepte', pwOk.status === 201 && !!pwOk.data.token);
  cToken = pwOk.data.token;
  check('ancien token invalide apres changement', (await call('/me', { token: oldToken })).status === 401);
  check('nouveau token valide', (await call('/me', { token: cToken })).status === 200);
  check('ancien mot de passe ne marche plus',
    (await call('/auth/login', { method: 'POST', body: { email: `client${stamp}@test.ma`, password: 'motdepasse1' } })).status === 401);

  const beforeLogoutAll = cToken;
  check('deconnexion globale', (await call('/auth/logout-all', { method: 'POST', token: cToken, body: {} })).status === 201);
  check('token tue par la deconnexion globale', (await call('/me', { token: beforeLogoutAll })).status === 401);
  cToken = (await call('/auth/login', { method: 'POST', body: { email: `client${stamp}@test.ma`, password: 'nouveaumdp1' } })).data.token;
  check('reconnexion apres deconnexion globale', !!cToken);

  section('Langue');
  check('changement de langue enregistre',
    (await call('/me/locale', { method: 'PUT', token: cToken, body: { locale: 'ar' } })).status === 200);
  check('langue relue depuis le profil', (await call('/me', { token: cToken })).data.user.locale === 'ar');
  check('langue invalide refusee',
    (await call('/me/locale', { method: 'PUT', token: cToken, body: { locale: 'de' } })).status === 400);

  const statsBefore = (await call('/admin/stats', { token: aToken })).data;
  const rStatsBefore = (await call('/restaurant/stats', { token: r1Token })).data;

  section('Traitement de la commande');
  const board = await call('/restaurant/orders?status=active', { token: r1Token });
  const onBoard = board.data.orders.find((o) => o.id === order.id);
  check('commande visible par le restaurant', !!onBoard);
  check('options visibles pour la cuisine', onBoard.items[0].options.length === 2);
  check('transition invalide refusee',
    (await call(`/restaurant/orders/${order.id}/status`, { method: 'POST', token: r1Token, body: { status: 'completed' } })).status === 409);
  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    const step = await call(`/restaurant/orders/${order.id}/status`, { method: 'POST', token: r1Token, body: { status } });
    check(`passage a "${status}"`, step.status === 201 && step.data.order.status === status, JSON.stringify(step.data).slice(0, 90));
  }
  const done = await call(`/orders/${order.id}`, { token: cToken });
  check('encaissement enregistre', done.data.order.cash_collected === 1);
  check('historique complet', done.data.order.history.length === 5, String(done.data.order.history.length));
  check('annulation impossible apres acceptation',
    (await call(`/orders/${order.id}/cancel`, { method: 'POST', token: cToken, body: {} })).status === 409);

  section('Remboursement');
  check('un restaurant ne peut pas rembourser',
    (await call(`/admin/orders/${order.id}/refund`, { method: 'POST', token: r1Token, body: { amount_cents: 100 } })).status === 403);
  check('remboursement superieur au total refuse',
    (await call(`/admin/orders/${order.id}/refund`, { method: 'POST', token: aToken, body: { amount_cents: 999999 } })).status === 409);

  const refund = await call(`/admin/orders/${order.id}/refund`, { method: 'POST', token: aToken, body: { amount_cents: 1200, reason: 'Plat manquant' } });
  check('remboursement partiel accepte', refund.status === 201, JSON.stringify(refund.data).slice(0, 120));
  const refunded = refund.data.order;
  check('montant rembourse enregistre', refunded.refunded_cents === 1200);
  const newCommission = Math.round((expectedSubtotal - 1200) * 0.15);
  check(`commission recalculee = ${money(newCommission)}`, refunded.commission_cents === newCommission, String(refunded.commission_cents));
  check('net restaurant recalcule', refunded.restaurant_net_cents === (expectedSubtotal - 1200) - newCommission);
  check('remboursement trace', refunded.refunds.length === 1 && refunded.refunds[0].reason === 'Plat manquant');

  section('Livraison et annulation');
  const noAddress = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'delivery', items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  check('adresse obligatoire en livraison', noAddress.status === 400);

  // A delivery needs one of the customer's own saved addresses, with a pin.
  const cAddress = await call('/me/addresses', { method: 'POST', token: cToken, body: {
    label: 'home', recipient_name: 'Test Client', recipient_phone: '0612345678',
    city: 'Casablanca', street: '12 rue des Fleurs', floor: '2e etage',
    landmark: 'face au four', lat: 33.5731, lng: -7.5898 } });
  check('adresse de livraison enregistree', cAddress.status === 201, JSON.stringify(cAddress.data).slice(0, 90));
  const cAddressId = cAddress.data.address_id;

  const delivery = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'delivery', address_id: cAddressId,
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  const d = delivery.data.order;
  const atlasFee = Number(atlas.delivery_fee_cents);
  check('frais de livraison ajoutes', d.delivery_fee_cents === atlasFee && d.total_cents === 3500 + atlasFee,
    `fee ${d.delivery_fee_cents} total ${d.total_cents}`);
  check('le restaurant garde les frais de livraison',
    d.restaurant_net_cents === 3500 - Math.round(3500 * 0.15) + atlasFee, String(d.restaurant_net_cents));
  check('annulation possible tant que pending',
    (await call(`/orders/${d.id}/cancel`, { method: 'POST', token: cToken, body: { reason: 'Erreur' } })).data.order.status === 'cancelled');

  const tooSmall = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup', items: [{ product_id: coca.id, quantity: 1 }] } });
  check('minimum de commande applique', tooSmall.status === 409, tooSmall.data.error);

  section('Gestion du menu');
  const cat = await call('/restaurant/categories', { method: 'POST', token: r1Token, body: { name: 'Desserts', name_ar: 'حلويات' } });
  check('categorie creee avec nom arabe', cat.status === 201 && cat.data.category.name_ar === 'حلويات');
  const prod = await call('/restaurant/products', { method: 'POST', token: r1Token, body: {
    name: 'Tiramisu', name_ar: 'تيراميسو', price_cents: 2500, category_id: cat.data.category.id } });
  check('plat cree', prod.status === 201);
  const newProductId = prod.data.product.id;

  const group = await call('/restaurant/option-groups', { method: 'POST', token: r1Token, body: {
    product_id: newProductId, name: 'Portion', name_ar: 'الحصة', min_select: 1, max_select: 1 } });
  check('groupe d options cree', group.status === 201);
  check('min superieur au max refuse',
    (await call('/restaurant/option-groups', { method: 'POST', token: r1Token, body: {
      product_id: newProductId, name: 'X', min_select: 3, max_select: 2 } })).status === 400);
  const opt = await call('/restaurant/options', { method: 'POST', token: r1Token, body: {
    option_group_id: group.data.group.id, name: 'Double', name_ar: 'مضاعف', price_delta_cents: 800 } });
  check('option creee', opt.status === 201 && opt.data.option.price_delta_cents === 800);
  check('un autre restaurant ne peut pas ajouter d option a ce groupe',
    (await call('/restaurant/options', { method: 'POST', token: r2Token, body: {
      option_group_id: group.data.group.id, name: 'Pirate' } })).status === 404);
  check('un autre restaurant ne peut pas modifier ce plat',
    (await call(`/restaurant/products/${newProductId}`, { method: 'PUT', token: r2Token, body: { price_cents: 1 } })).status === 404);
  check('prix modifie',
    (await call(`/restaurant/products/${newProductId}`, { method: 'PUT', token: r1Token, body: { price_cents: 3000 } })).data.product.price_cents === 3000);
  /*
   * Removals: an ingredient the customer can take out.
   *
   * The price is forced to zero on the way in, whatever the request says,
   * because a paid "removal" would let a crafted order shrink its own total.
   */
  const rmGroup = await call('/restaurant/option-groups', { method: 'POST', token: r1Token, body: {
    product_id: newProductId, name: 'Retirer', name_ar: 'حذف', min_select: 0, max_select: 1 } });
  const removal = await call('/restaurant/options', { method: 'POST', token: r1Token, body: {
    option_group_id: rmGroup.data.group.id, name: 'Sans oignons', name_ar: 'بدون بصل',
    is_removal: true, price_delta_cents: 500 } });
  check('retrait cree', removal.status === 201, JSON.stringify(removal.data).slice(0, 110));
  check('un retrait est marque comme tel', !!removal.data.option.is_removal);
  check('un retrait ne coute jamais rien',
    Number(removal.data.option.price_delta_cents) === 0,
    String(removal.data.option.price_delta_cents));
  const paidThenFree = await call(`/restaurant/options/${removal.data.option.id}`, {
    method: 'PUT', token: r1Token, body: { price_delta_cents: 900 } });
  check('un retrait reste gratuit apres modification',
    Number(paidThenFree.data.option.price_delta_cents) === 0 && !!paidThenFree.data.option.is_removal);
  const backToExtra = await call(`/restaurant/options/${removal.data.option.id}`, {
    method: 'PUT', token: r1Token, body: { is_removal: false, price_delta_cents: 250 } });
  check('un retrait peut redevenir un supplement payant',
    !backToExtra.data.option.is_removal && Number(backToExtra.data.option.price_delta_cents) === 250);

  check('option supprimee',
    (await call(`/restaurant/options/${opt.data.option.id}`, { method: 'DELETE', token: r1Token })).data.deleted === true);
  check('plat supprime',
    (await call(`/restaurant/products/${newProductId}`, { method: 'DELETE', token: r1Token })).data.deleted === true);
  const usedProduct = await call(`/restaurant/products/${tacos.id}`, { method: 'DELETE', token: r1Token });
  check('plat deja commande = masque, pas supprime', usedProduct.data.deactivated === true);
  await call(`/restaurant/products/${tacos.id}`, { method: 'PUT', token: r1Token, body: { is_active: true } });

  section('Admin');
  const newResto = await registerWithCode({
    name: 'Nouveau Proprio', email: `resto${stamp}@test.ma`, phone: uniquePhone('66'),
    password: 'motdepasse1', role: 'restaurant', restaurant_name: RESTO_NEW, city: 'Rabat' });
  check('inscription restaurant', newResto.status === 201);
  const pendingList = await call('/admin/restaurants?status=pending', { token: aToken });
  const pendingResto = pendingList.data.restaurants.find((r) => r.name === RESTO_NEW);
  check('restaurant en attente de validation', !!pendingResto);
  check('restaurant non valide invisible du public',
    !(await call('/restaurants')).data.restaurants.some((r) => r.name === RESTO_NEW));
  check('admin approuve',
    (await call(`/admin/restaurants/${pendingResto.id}/status`, { method: 'POST', token: aToken, body: { status: 'approved' } })).data.restaurant.status === 'approved');
  check('restaurant visible apres validation',
    (await call('/restaurants')).data.restaurants.some((r) => r.name === RESTO_NEW));
  check('commission modifiable',
    (await call(`/admin/restaurants/${pendingResto.id}/commission`, { method: 'POST', token: aToken, body: { commission_rate_bp: 1000 } })).data.restaurant.commission_rate_bp === 1000);

  const suspended = await call(`/admin/restaurants/${pendingResto.id}/status`, { method: 'POST', token: aToken, body: { status: 'suspended' } });
  check('restaurant suspendu', suspended.data.restaurant.status === 'suspended');

  section('Reinitialisation de mot de passe par l admin');
  // This owner's restaurant was suspended just above; bring it back so the test
  // exercises the password reset rather than the suspension rule.
  await call(`/admin/restaurants/${pendingResto.id}/status`, { method: 'POST', token: aToken, body: { status: 'approved' } });
  const target = newResto.data.user.id;
  const beforeReset = newResto.data.token;
  const reset = await call(`/admin/users/${target}/reset-password`, { method: 'POST', token: aToken, body: {} });
  check('mot de passe temporaire genere', reset.status === 201 && reset.data.temporary_password.length >= 10);
  check('session de l utilisateur coupee', (await call('/me', { token: beforeReset })).status === 401);
  const relog = await call('/auth/login', { method: 'POST', body: { email: `resto${stamp}@test.ma`, password: reset.data.temporary_password } });
  check('connexion avec le mot de passe temporaire', relog.status === 201);
  check('un non-admin ne peut pas reinitialiser',
    (await call(`/admin/users/${target}/reset-password`, { method: 'POST', token: cToken, body: {} })).status === 403);

  section('Journal d audit');
  const audit = await call('/admin/audit', { token: aToken });
  check('journal accessible a l admin', audit.status === 200 && audit.data.logs.length > 0);
  const actions = audit.data.logs.map((l) => l.action);
  check('approbation tracee', actions.includes('restaurant_status'));
  check('changement de commission trace', actions.includes('commission_change'));
  check('remboursement trace', actions.includes('refund'));
  check('reinitialisation tracee', actions.includes('password_reset'));
  check('journal interdit aux non-admins', (await call('/admin/audit', { token: cToken })).status === 403);

  section('Statistiques');
  const stats = await call('/admin/stats', { token: aToken });
  check('statistiques plateforme', stats.status === 200 && stats.data.completed_orders >= 1);
  check('remboursements comptes', stats.data.refunded_cents - statsBefore.refunded_cents === 1200,
    `delta ${stats.data.refunded_cents - statsBefore.refunded_cents}`);
  const rStats = await call('/restaurant/stats', { token: r1Token });
  check('statistiques restaurant', rStats.status === 200 && rStats.data.all_time.orders >= 1);
  check('commission du jour coherente',
    rStats.data.today.commission_cents - rStatsBefore.today.commission_cents === newCommission,
    `delta ${rStats.data.today.commission_cents - rStatsBefore.today.commission_cents}`);

  section('Codes promo');
  const promoBase = { restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 2, option_ids: [sizeM.id] }] };          // 2 x 35.00 = 70.00

  // The test makes its own code: a database upgraded from an older version has no demo codes.
  const welcomeCode = `WELCOME${String(stamp).slice(-6)}`;
  const welcome = await call('/admin/promotions', { method: 'POST', token: aToken, body: {
    code: welcomeCode, discount_type: 'percent', discount_value: 10,
    max_discount_cents: 2000, min_order_cents: 3000, funded_by: 'platform', per_customer_limit: 1 } });
  check('creation du code de bienvenue', welcome.status === 201, JSON.stringify(welcome.data).slice(0, 110));

  const quotePlain = await call('/orders/quote', { method: 'POST', token: cToken, body: promoBase });
  check('devis sans code', quotePlain.data.items_subtotal_cents === 7000 && quotePlain.data.total_cents === 7000,
    JSON.stringify(quotePlain.data).slice(0, 110));

  const quotePromo = await call('/orders/quote', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: welcomeCode.toLowerCase() } });
  check('code insensible a la casse', quotePromo.status === 201, String(quotePromo.status));
  check('reduction de 10% appliquee', quotePromo.data.discount_cents === 700 && quotePromo.data.total_cents === 6300,
    JSON.stringify(quotePromo.data).slice(0, 110));
  check('code inconnu refuse',
    (await call('/orders/quote', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: 'NEXISTEPAS' } })).status === 400);

  const promoOrder = await call('/orders', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: welcomeCode } });
  const po = promoOrder.data.order;
  check('commande avec code promo', promoOrder.status === 201 && po.promo_code === welcomeCode,
    JSON.stringify(promoOrder.data).slice(0, 110));
  check('reduction enregistree sur la commande', po.discount_cents === 700 && po.total_cents === 6300);
  check('reduction payee par la plateforme', po.discount_funded_by === 'platform');
  check('commission calculee sur le prix plein (plateforme paie)', po.commission_cents === 1050, String(po.commission_cents));
  check('part du restaurant intacte', po.restaurant_net_cents === 7000 - 1050, String(po.restaurant_net_cents));
  check('limite par client respectee',
    (await call('/orders', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: welcomeCode } })).status === 409);

  // a restaurant-funded code: the discount comes out of the restaurant's share
  const restoCode = `RESTO${String(stamp).slice(-6)}`;
  const created = await call('/admin/promotions', { method: 'POST', token: aToken, body: {
    code: restoCode, discount_type: 'fixed', discount_value: 1000, funded_by: 'restaurant', per_customer_limit: 0 } });
  check('creation d un code par l admin', created.status === 201, JSON.stringify(created.data).slice(0, 110));
  check('code en double refuse',
    (await call('/admin/promotions', { method: 'POST', token: aToken, body: {
      code: restoCode, discount_type: 'fixed', discount_value: 500 } })).status === 409);
  check('pourcentage invalide refuse',
    (await call('/admin/promotions', { method: 'POST', token: aToken, body: {
      code: `BAD${stamp}`, discount_type: 'percent', discount_value: 150 } })).status === 400);
  check('un client ne peut pas creer de code',
    (await call('/admin/promotions', { method: 'POST', token: cToken, body: {
      code: `X${stamp}`, discount_type: 'percent', discount_value: 10 } })).status === 403);

  const restoFunded = await call('/orders', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: restoCode } });
  const rf = restoFunded.data.order;
  check('commande avec code paye par le restaurant', restoFunded.status === 201);
  check('reduction de 10.00 appliquee', rf.discount_cents === 1000 && rf.total_cents === 6000);
  check('commission calculee sur le prix reduit (restaurant paie)', rf.commission_cents === Math.round(6000 * 0.15),
    String(rf.commission_cents));
  check('part du restaurant reduite', rf.restaurant_net_cents === 6000 - Math.round(6000 * 0.15),
    String(rf.restaurant_net_cents));

  const minCode = `MIN${String(stamp).slice(-6)}`;
  await call('/admin/promotions', { method: 'POST', token: aToken, body: {
    code: minCode, discount_type: 'percent', discount_value: 50, min_order_cents: 50000, per_customer_limit: 0 } });
  check('minimum de commande du code respecte',
    (await call('/orders/quote', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: minCode } })).status === 409);

  const freeDel = `LIV${String(stamp).slice(-6)}`;
  await call('/admin/promotions', { method: 'POST', token: aToken, body: {
    code: freeDel, discount_type: 'free_delivery', per_customer_limit: 0 } });
  check('code livraison offerte refuse en retrait',
    (await call('/orders/quote', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: freeDel } })).status === 409);
  const freeDelQuote = await call('/orders/quote', { method: 'POST', token: cToken, body: {
    ...promoBase, fulfillment_type: 'delivery', promo_code: freeDel } });
  check('livraison offerte annule les frais',
    freeDelQuote.data.discount_cents === Number(atlas.delivery_fee_cents) && freeDelQuote.data.total_cents === 7000,
    JSON.stringify(freeDelQuote.data).slice(0, 110));

  const toggled = await call(`/admin/promotions/${created.data.promotion.id}/toggle`, { method: 'POST', token: aToken, body: {} });
  check('desactivation d un code', toggled.data.promotion.is_active === 0);
  check('code desactive refuse',
    (await call('/orders/quote', { method: 'POST', token: cToken, body: { ...promoBase, promo_code: restoCode } })).status === 409);
  const deleteUsed = await call(`/admin/promotions/${created.data.promotion.id}`, { method: 'DELETE', token: aToken });
  check('code deja utilise: desactive au lieu d etre supprime', deleteUsed.data.deactivated === true);

  section('Messages au support');
  const sent = await call('/support', { method: 'POST', token: cToken, body: {
    subject: 'Plat manquant', message: 'Il manque une boisson dans ma commande.', order_number: po.order_number } });
  check('message envoye par un client connecte', sent.status === 201 && sent.data.sent);
  const anonymous = await call('/support', { method: 'POST', body: {
    name: 'Visiteur', phone: uniquePhone('67'), message: 'Comment je commande sans compte ?' } });
  check('message envoye sans compte', anonymous.status === 201);
  check('message trop court refuse',
    (await call('/support', { method: 'POST', token: cToken, body: { message: 'ok' } })).status === 400);

  const inbox = await call('/admin/support', { token: aToken });
  check('boite de reception admin', inbox.status === 200 && inbox.data.messages.length >= 2);
  check('numero du client transmis', inbox.data.messages.some((m) => m.phone === uniquePhone('67')));
  check('compteur de messages ouverts', inbox.data.open_count >= 2, String(inbox.data.open_count));
  check('un client ne voit pas la boite', (await call('/admin/support', { token: cToken })).status === 403);
  const handled = await call(`/admin/support/${inbox.data.messages[0].id}/handled`, { method: 'POST', token: aToken, body: {} });
  check('message marque comme traite', handled.data.message.status === 'handled');

  const statsWithPromos = await call('/admin/stats', { token: aToken });
  check('revenu net = commissions moins reductions offertes',
    statsWithPromos.data.net_revenue_cents === statsWithPromos.data.commission_cents - statsWithPromos.data.platform_discount_cents,
    JSON.stringify({ net: statsWithPromos.data.net_revenue_cents, c: statsWithPromos.data.commission_cents, d: statsWithPromos.data.platform_discount_cents }));
  check('messages ouverts comptes dans les statistiques', statsWithPromos.data.open_support >= 1);

  section('Gestion des utilisateurs');
  const userList = await call('/admin/users', { token: aToken });
  check('liste des utilisateurs', userList.status === 200 && userList.data.users.length >= 4);
  check('compteurs par role', userList.data.counts.customers >= 1 && userList.data.counts.restaurants >= 2,
    JSON.stringify(userList.data.counts));
  const listed = userList.data.users.find((u) => u.phone === uniquePhone('61'));
  check('client visible avec son numero', !!listed, uniquePhone('61'));
  check('nombre de commandes par client', listed && listed.orders_count >= 1, String(listed?.orders_count));

  const searched = await call(`/admin/users?q=${uniquePhone('65')}`, { token: aToken });
  check('recherche par numero', searched.data.users.length === 1 && searched.data.users[0].phone === uniquePhone('65'),
    String(searched.data.users.length));
  const filtered = await call('/admin/users?role=restaurant', { token: aToken });
  check('filtre par role', filtered.data.users.every((u) => u.role === 'restaurant'));
  check('nom du restaurant rattache au proprietaire', filtered.data.users.some((u) => u.restaurant_name));
  check('un client ne voit pas la liste des utilisateurs', (await call('/admin/users', { token: cToken })).status === 403);

  // suspend the phone-only account, then check it is locked out
  const victim = noEmail.data.user.id;
  const suspendedUser = await call(`/admin/users/${victim}/status`, { method: 'POST', token: aToken, body: { status: 'suspended' } });
  check('compte suspendu', suspendedUser.status === 201 && suspendedUser.data.user.id === victim,
    JSON.stringify(suspendedUser.data).slice(0, 90));
  const suspendedMe = await call('/me', { token: phoneToken });
  check('session du compte suspendu coupee', suspendedMe.status === 403 || suspendedMe.status === 401,
    String(suspendedMe.status));
  const blockedLogin = await call('/auth/login', { method: 'POST', body: { identifier: phoneOnly, password: 'motdepasse1' } });
  check('connexion refusee pour un compte suspendu', blockedLogin.status === 403, String(blockedLogin.status));
  const reactivated = await call(`/admin/users/${victim}/status`, { method: 'POST', token: aToken, body: { status: 'active' } });
  check('compte reactive', reactivated.data.user.id === victim);
  check('connexion a nouveau possible',
    (await call('/auth/login', { method: 'POST', body: { identifier: phoneOnly, password: 'motdepasse1' } })).status === 201);

  const adminUser = userList.data.users.find((u) => u.email === 'admin@demo.ma');
  const selfSuspend = await call(`/admin/users/${adminUser.id}/status`, { method: 'POST', token: aToken, body: { status: 'suspended' } });
  check('un admin ne peut pas se suspendre lui-meme', selfSuspend.status === 409, String(selfSuspend.status));
  check('le compte admin connecte est toujours actif',
    (await call('/admin/users?role=admin', { token: aToken })).data.users
      .find((u) => u.email === 'admin@demo.ma').status === 'active');
  const otherAdmin = userList.data.users.find((u) => u.role === 'admin' && u.email !== 'admin@demo.ma');
  if (otherAdmin) {
    check('un autre admin ne se suspend pas depuis l ecran clients',
      (await call(`/admin/users/${otherAdmin.id}/status`, { method: 'POST', token: aToken, body: { status: 'suspended' } })).status === 403);
  }
  check('un client ne peut pas suspendre un compte',
    (await call(`/admin/users/${victim}/status`, { method: 'POST', token: cToken, body: { status: 'suspended' } })).status === 403);

  section('Fiche client');
  const profile = await call(`/admin/customers/${listed.id}`, { token: aToken });
  check('fiche client accessible', profile.status === 200 && profile.data.user.id === listed.id);
  check('coordonnees presentes', !!profile.data.user.phone);
  check('date d inscription presente', !!profile.data.user.created_at);
  check('nombre de commandes', profile.data.stats.orders_count >= 1, String(profile.data.stats.orders_count));
  check('total depense', profile.data.stats.spent_cents > 0, String(profile.data.stats.spent_cents));
  check('derniere commande datee', !!profile.data.stats.last_order_at);
  check('commandes annulees comptees', typeof profile.data.stats.cancelled_count === 'number');
  check('remboursements du client', typeof profile.data.stats.refunded_cents === 'number');
  check('historique des commandes', Array.isArray(profile.data.orders) && profile.data.orders.length >= 1);
  check('messages du client', Array.isArray(profile.data.messages));
  check('client inexistant -> 404', (await call('/admin/customers/999999', { token: aToken })).status === 404);
  check('un client ne voit pas les fiches', (await call(`/admin/customers/${listed.id}`, { token: cToken })).status === 403);

  section('Vue des remboursements');
  const refundList = await call('/admin/refunds', { token: aToken });
  check('liste des remboursements', refundList.status === 200 && refundList.data.refunds.length >= 1);
  const firstRefund = refundList.data.refunds[0];
  check('remboursement rattache a sa commande', !!firstRefund.order_number && !!firstRefund.restaurant_name);
  check('auteur du remboursement enregistre', !!firstRefund.by_email);
  check('total rembourse coherent',
    refundList.data.total_cents === refundList.data.refunds.reduce((sum, r) => sum + Number(r.amount_cents), 0),
    String(refundList.data.total_cents));
  check('un client ne voit pas les remboursements', (await call('/admin/refunds', { token: cToken })).status === 403);

  section('Reglages de la plateforme');
  const settingsGet = await call('/admin/settings', { token: aToken });
  check('reglages lisibles', settingsGet.status === 200 && !!settingsGet.data.settings.platform_name);
  check('valeurs par defaut fournies', !!settingsGet.data.defaults);

  const saved = await call('/admin/settings', { method: 'PUT', token: aToken, body: {
    platform_name: 'Marhba Pilote', support_phone: '+212 600 11 22 33', support_email: 'aide@marhba.ma',
    default_commission_bp: 1800 } });
  check('reglages enregistres', saved.status === 200 && saved.data.settings.platform_name === 'Marhba Pilote');
  check('telephone du support normalise', saved.data.settings.support_phone === '0600112233',
    saved.data.settings.support_phone);
  check('commission par defaut enregistree', saved.data.settings.default_commission_bp === '1800');
  check('email invalide refuse',
    (await call('/admin/settings', { method: 'PUT', token: aToken, body: { support_email: 'pasunemail' } })).status === 400);
  check('commission hors limites refusee',
    (await call('/admin/settings', { method: 'PUT', token: aToken, body: { default_commission_bp: 20000 } })).status === 400);

  const publicSettings = await call('/settings/public');
  check('reglages publics exposes', publicSettings.data.platform_name === 'Marhba Pilote');
  check('reglages publics sans secrets', publicSettings.data.default_commission_bp === undefined);

  // the default commission applies to a brand new restaurant
  const defPhone = uniquePhone('76');
  const defName = `Resto Defaut ${String(stamp).slice(-5)}`;
  await registerWithCode({
    name: 'Proprio Defaut', phone: defPhone, password: 'motdepasse1',
    role: 'restaurant', restaurant_name: defName, city: 'Casablanca' });
  const defResto = (await call('/admin/restaurants?status=pending', { token: aToken }))
    .data.restaurants.find((r) => r.name === defName);
  check('nouveau restaurant prend la commission par defaut', defResto.commission_rate_bp === 1800,
    String(defResto.commission_rate_bp));

  // maintenance mode stops customers ordering but not the admin
  await call('/admin/settings', { method: 'PUT', token: aToken, body: { maintenance_mode: true } });
  const blockedOrder = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  check('mode maintenance bloque les commandes clients', blockedOrder.status === 409, String(blockedOrder.status));
  check('mode maintenance visible publiquement',
    (await call('/settings/public')).data.maintenance_mode === 1);
  await call('/admin/settings', { method: 'PUT', token: aToken, body: { maintenance_mode: false } });
  check('commandes de nouveau possibles apres maintenance',
    (await call('/orders', { method: 'POST', token: cToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'pickup',
      items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } })).status === 201);

  // the promotions switch
  await call('/admin/settings', { method: 'PUT', token: aToken, body: { promotions_enabled: false } });
  check('codes promo desactives globalement',
    (await call('/orders/quote', { method: 'POST', token: cToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'pickup', promo_code: welcomeCode,
      items: [{ product_id: tacos.id, quantity: 2, option_ids: [sizeM.id] }] } })).status === 409);
  await call('/admin/settings', { method: 'PUT', token: aToken, body: { promotions_enabled: true } });

  check('un non super admin ne touche pas aux reglages',
    (await call('/admin/settings', { token: cToken })).status === 403);
  const settingsAudit = await call('/admin/audit', { token: aToken });
  check('modification des reglages tracee',
    settingsAudit.data.logs.some((l) => l.action === 'settings_update' && l.before_state && l.after_state));

  section('Journal d audit filtre');
  const auditAll = await call('/admin/audit', { token: aToken });
  check('journal complet', auditAll.data.logs.length >= 5);
  check('listes de filtres fournies',
    auditAll.data.filters.actions.length >= 3 && auditAll.data.filters.actors.length >= 1,
    JSON.stringify(auditAll.data.filters.actions.slice(0, 4)));
  check('user agent et ip enregistres',
    auditAll.data.logs.some((l) => l.ip) , 'ip');
  const byAction = await call('/admin/audit?action=refund', { token: aToken });
  check('filtre par action', byAction.data.logs.length >= 1 && byAction.data.logs.every((l) => l.action.includes('refund')));
  const byResource = await call('/admin/audit?resource_type=settings', { token: aToken });
  check('filtre par type de ressource', byResource.data.logs.every((l) => l.resource_type === 'settings'));
  const adminId = (await call('/admin/users?role=admin', { token: aToken })).data.users
    .find((u) => u.email === 'admin@demo.ma').id;
  const byActor = await call(`/admin/audit?actor_user_id=${adminId}`, { token: aToken });
  check('filtre par auteur', byActor.data.logs.length >= 1 &&
    byActor.data.logs.every((l) => Number(l.actor_user_id) === Number(adminId)));
  const auditToday = new Date().toISOString().slice(0, 10);
  check('filtre par date', (await call(`/admin/audit?from=${auditToday}&to=${auditToday}`, { token: aToken })).data.logs.length >= 1);
  check('filtre date future vide', (await call('/admin/audit?from=2099-01-01', { token: aToken })).data.logs.length === 0);

  section('Equipe et permissions');
  const staffList = await call('/admin/staff', { token: aToken });
  check('liste de l equipe', staffList.status === 200 && staffList.data.staff.length >= 1);
  check('roles disponibles', staffList.data.roles.length === 4, JSON.stringify(staffList.data.roles));
  check('admin historique considere super admin',
    staffList.data.staff.find((u) => u.email === 'admin@demo.ma').admin_role === 'super_admin');
  check('derniere connexion affichee',
    !!staffList.data.staff.find((u) => u.email === 'admin@demo.ma').last_login_at);
  check('nombre d actions par membre',
    typeof staffList.data.staff[0].actions_count === 'number');

  // one admin per role
  const made = {};
  for (const role of ['operations', 'finance', 'support']) {
    const created = await call('/admin/staff', { method: 'POST', token: aToken, body: {
      name: `Staff ${role}`, phone: uniquePhone(role === 'operations' ? '71' : role === 'finance' ? '72' : '73'),
      password: 'motdepasse1', admin_role: role } });
    check(`compte ${role} cree`, created.status === 201 && created.data.staff.admin_role === role,
      JSON.stringify(created.data).slice(0, 100));
    made[role] = created.data.staff;
  }
  const opsToken = (await call('/auth/login', { method: 'POST', body: {
    identifier: uniquePhone('71'), password: 'motdepasse1' } })).data.token;
  const finToken = (await call('/auth/login', { method: 'POST', body: {
    identifier: uniquePhone('72'), password: 'motdepasse1' } })).data.token;
  const supToken = (await call('/auth/login', { method: 'POST', body: {
    identifier: uniquePhone('73'), password: 'motdepasse1' } })).data.token;

  const opsMe = await call('/me', { token: opsToken });
  check('role renvoye dans /me', opsMe.data.admin_role === 'operations');
  check('permissions listees pour l interface', Array.isArray(opsMe.data.permissions) &&
    opsMe.data.permissions.includes('restaurants.manage'), JSON.stringify(opsMe.data.permissions || []).slice(0, 80));

  // operations: restaurants yes, money no
  check('operations peut voir le tableau de bord', (await call('/admin/dashboard', { token: opsToken })).status === 200);
  check('operations peut gerer les restaurants',
    (await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: opsToken, body: { prep_minutes: 21 } })).status === 200);
  check('operations ne peut pas rembourser',
    (await call(`/admin/orders/${order.id}/refund`, { method: 'POST', token: opsToken, body: { amount_cents: 100 } })).status === 403);
  check('operations ne peut pas toucher la caisse', (await call('/admin/cod', { token: opsToken })).status === 403);
  check('operations ne peut pas changer la commission',
    (await call(`/admin/restaurants/${atlas.id}/commission`, { method: 'POST', token: opsToken, body: { commission_rate_bp: 1000 } })).status === 403);
  check('operations ne peut pas gerer l equipe', (await call('/admin/staff', { token: opsToken })).status === 403);

  // finance: money yes, restaurants no
  check('finance voit la caisse', (await call('/admin/cod', { token: finToken })).status === 200);
  check('finance voit les reglements', (await call('/admin/settlements', { token: finToken })).status === 200);
  check('finance peut changer la commission',
    (await call(`/admin/restaurants/${atlas.id}/commission`, { method: 'POST', token: finToken, body: { commission_rate_bp: 1500 } })).status === 201);
  check('finance ne peut pas modifier un restaurant',
    (await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: finToken, body: { name: 'X' } })).status === 403);
  check('finance ne peut pas toucher au catalogue',
    (await call(`/admin/products/${coca.id}`, { method: 'PUT', token: finToken, body: { is_active: false } })).status === 403);

  // support: read and notes only
  check('support voit les commandes', (await call('/admin/orders', { token: supToken })).status === 200);
  check('support peut ajouter une note',
    (await call(`/admin/orders/${po.id}/notes`, { method: 'POST', token: supToken, body: { note: 'Note support' } })).status === 201);
  check('support peut repondre aux messages', (await call('/admin/support', { token: supToken })).status === 200);
  check('support ne peut pas annuler une commande',
    (await call(`/admin/orders/${po.id}/cancel`, { method: 'POST', token: supToken, body: { reason: 'non' } })).status === 403);
  check('support ne voit pas le journal d audit', (await call('/admin/audit', { token: supToken })).status === 403);
  check('support ne peut pas rembourser',
    (await call(`/admin/orders/${order.id}/refund`, { method: 'POST', token: supToken, body: { amount_cents: 100 } })).status === 403);

  // super-admin protections
  check('un non super admin ne peut pas creer de super admin',
    (await call('/admin/staff', { method: 'POST', token: opsToken, body: {
      name: 'Pirate', phone: uniquePhone('74'), password: 'motdepasse1', admin_role: 'super_admin' } })).status === 403);
  const selfId = staffList.data.staff.find((u) => u.email === 'admin@demo.ma').id;
  check('un admin ne peut pas se desactiver',
    (await call(`/admin/staff/${selfId}`, { method: 'PUT', token: aToken, body: { status: 'suspended' } })).status === 409);
  check('un admin ne peut pas changer son propre role',
    (await call(`/admin/staff/${selfId}`, { method: 'PUT', token: aToken, body: { admin_role: 'support' } })).status === 409);
  check('le dernier super admin est protege',
    (await call(`/admin/staff/${selfId}`, { method: 'PUT', token: aToken, body: { admin_role: 'finance' } })).status === 409);

  // role change takes effect immediately and kills the old session
  const promoted = await call(`/admin/staff/${made.support.id}`, { method: 'PUT', token: aToken, body: { admin_role: 'finance' } });
  check('changement de role enregistre', promoted.data.staff.admin_role === 'finance');
  check('ancienne session invalidee par le changement de role',
    (await call('/me', { token: supToken })).status === 401);
  const supAgain = (await call('/auth/login', { method: 'POST', body: {
    identifier: uniquePhone('73'), password: 'motdepasse1' } })).data.token;
  check('nouveau role actif apres reconnexion', (await call('/admin/cod', { token: supAgain })).status === 200);

  const deactivated = await call(`/admin/staff/${made.operations.id}`, { method: 'PUT', token: aToken, body: { status: 'suspended' } });
  check('membre desactive', deactivated.data.staff.status === 'suspended');
  check('membre desactive ne peut plus se connecter',
    (await call('/auth/login', { method: 'POST', body: { identifier: uniquePhone('71'), password: 'motdepasse1' } })).status === 403);

  const staffActions = await call(`/admin/staff/${selfId}/actions`, { token: aToken });
  check('actions recentes d un membre', Array.isArray(staffActions.data.actions) && staffActions.data.actions.length >= 1);

  const staffAudit = await call('/admin/audit', { token: aToken });
  check('creation d equipe tracee', staffAudit.data.logs.some((l) => l.action === 'staff_create'));
  check('modification d equipe tracee', staffAudit.data.logs.some((l) => l.action === 'staff_update'));

  section('Rapports');
  const repToday = new Date().toISOString().slice(0, 10);
  const reports = await call(`/admin/reports?from=${repToday}&to=${repToday}`, { token: aToken });
  check('rapport global', reports.status === 200 && !!reports.data.summary);
  const rs = reports.data.summary;
  check('commandes comptees', rs.orders >= 1, String(rs.orders));
  check('chiffre d affaires calcule', rs.revenue_cents > 0, String(rs.revenue_cents));
  check('commission calculee', rs.commission_cents > 0, String(rs.commission_cents));
  check('panier moyen coherent',
    rs.average_order_cents === (rs.completed ? Math.round(rs.revenue_cents / rs.completed) : 0),
    `${rs.average_order_cents} vs ${rs.revenue_cents}/${rs.completed}`);
  check('revenu net = commission - reductions plateforme',
    rs.net_revenue_cents === rs.commission_cents - rs.platform_discounts_cents);
  check('retraits et livraisons separes',
    typeof rs.pickup_orders === 'number' && typeof rs.delivery_orders === 'number');
  check('ventes par restaurant', Array.isArray(reports.data.by_restaurant) && reports.data.by_restaurant.length >= 1);
  check('ventes par produit', Array.isArray(reports.data.by_product) && reports.data.by_product.length >= 1);
  check('nouveaux vs fideles',
    typeof reports.data.customers.new_customers === 'number' &&
    typeof reports.data.customers.returning_customers === 'number',
    JSON.stringify(reports.data.customers));
  check('resume caisse dans les rapports', Array.isArray(reports.data.cod));
  check('periode inversee refusee',
    (await call(`/admin/reports?from=${repToday}&to=2020-01-01`, { token: aToken })).status === 400);
  check('rapport inconnu refuse',
    (await call(`/admin/reports?report=nexistepas&from=${repToday}&to=${repToday}`, { token: aToken })).status === 400);
  check('un client ne voit pas les rapports', (await call('/admin/reports', { token: cToken })).status === 403);

  // CSV export for each report
  for (const name of ['summary', 'restaurants', 'products', 'customers', 'cod']) {
    const res = await fetch(`${BASE}/api/admin/reports?report=${name}&from=${repToday}&to=${repToday}&format=csv`,
      { headers: { Authorization: `Bearer ${aToken}` } });
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    const disposition = res.headers.get('content-disposition') || '';
    check(`export CSV "${name}"`, res.status === 200 && type.includes('text/csv') &&
      disposition.includes('.csv') && text.split('\n').length >= 1 && text.includes(','),
      `${res.status} ${type} ${text.slice(0, 40).replace(/\n/g, '|')}`);
  }

  section('Supervision du catalogue');
  const catalog = await call(`/admin/catalog?restaurant_id=${atlas.id}`, { token: aToken });
  check('catalogue charge', catalog.status === 200 && catalog.data.products.length >= 5);
  check('categories incluses', catalog.data.categories.length >= 2);
  check('options incluses', catalog.data.products.some((p) => (p.option_groups || []).length > 0));
  check('meilleures ventes calculees', Array.isArray(catalog.data.best_sellers) && catalog.data.best_sellers.length >= 1,
    JSON.stringify(catalog.data.best_sellers.slice(0, 2)));
  check('meilleures ventes triees par quantite',
    catalog.data.best_sellers.every((b, i, arr) => i === 0 || arr[i - 1].units >= b.units));
  check('restaurant obligatoire', (await call('/admin/catalog', { token: aToken })).status === 400);

  const adminCat = await call('/admin/categories', { method: 'POST', token: aToken, body: {
    restaurant_id: atlas.id, name: `Cat admin ${String(stamp).slice(-5)}`, name_ar: 'فئة' } });
  check('admin cree une categorie', adminCat.status === 201);
  const adminProd = await call('/admin/products', { method: 'POST', token: aToken, body: {
    restaurant_id: atlas.id, name: `Produit admin ${String(stamp).slice(-5)}`, price_cents: 4200,
    category_id: adminCat.data.category.id } });
  check('admin cree un produit', adminProd.status === 201 && adminProd.data.product.price_cents === 4200);
  const adminGroup = await call('/admin/option-groups', { method: 'POST', token: aToken, body: {
    product_id: adminProd.data.product.id, name: 'Cuisson', min_select: 1, max_select: 1 } });
  check('admin cree un groupe d options', adminGroup.status === 201);
  const adminOption = await call('/admin/options', { method: 'POST', token: aToken, body: {
    option_group_id: adminGroup.data.group.id, name: 'Bien cuit', price_delta_cents: 0 } });
  check('admin cree une option', adminOption.status === 201);
  check('option modifiable',
    (await call(`/admin/options/${adminOption.data.option.id}`, { method: 'PUT', token: aToken, body: {
      price_delta_cents: 300 } })).data.option.price_delta_cents === 300);
  check('categorie d un autre restaurant refusee',
    (await call('/admin/products', { method: 'POST', token: aToken, body: {
      restaurant_id: bella.id, name: 'Mauvais', price_cents: 100, category_id: adminCat.data.category.id } })).status === 400);

  const catMenu = await call(`/restaurants/${atlas.id}`);
  check('produit ajoute par l admin visible aux clients',
    catMenu.data.menu.flatMap((c) => c.products).some((p) => p.id === adminProd.data.product.id));

  check('option supprimee',
    (await call(`/admin/options/${adminOption.data.option.id}`, { method: 'DELETE', token: aToken })).data.deleted === true);
  check('groupe supprime',
    (await call(`/admin/option-groups/${adminGroup.data.group.id}`, { method: 'DELETE', token: aToken })).data.deleted === true);
  check('un client ne peut pas toucher au catalogue',
    (await call('/admin/products', { method: 'POST', token: cToken, body: {
      restaurant_id: atlas.id, name: 'Pirate', price_cents: 1 } })).status === 403);

  const catalogAudit = await call('/admin/audit', { token: aToken });
  check('creations de catalogue tracees',
    catalogAudit.data.logs.some((l) => l.action === 'product_create') &&
    catalogAudit.data.logs.some((l) => l.action === 'option_group_create'));

  section('Caisse COD et reglements');
  // Its own restaurant, so today's cash day is always fresh and the run repeats cleanly.
  const codOwnerPhone = uniquePhone('64');
  const codRestoName = `Caisse Test ${String(stamp).slice(-6)}`;
  const codOwner = await registerWithCode({
    name: 'Proprio Caisse', phone: codOwnerPhone, password: 'motdepasse1',
    role: 'restaurant', restaurant_name: codRestoName, city: 'Casablanca' });
  const codResto = (await call('/admin/restaurants?status=pending', { token: aToken }))
    .data.restaurants.find((r) => r.name === codRestoName);
  await call(`/admin/restaurants/${codResto.id}/status`, { method: 'POST', token: aToken, body: { status: 'approved' } });
  const codRestoToken = (await call('/auth/login', { method: 'POST', body: {
    identifier: codOwnerPhone, password: 'motdepasse1' } })).data.token;
  const codCat = await call('/restaurant/categories', { method: 'POST', token: codRestoToken, body: { name: 'Plats' } });
  const codProduct = await call('/restaurant/products', { method: 'POST', token: codRestoToken, body: {
    name: 'Plat test caisse', price_cents: 10000, category_id: codCat.data.category.id } });
  const codOrder = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: codResto.id, fulfillment_type: 'pickup',
    items: [{ product_id: codProduct.data.product.id, quantity: 1 }] } });
  check('commande de test pour la caisse', codOrder.status === 201, JSON.stringify(codOrder.data).slice(0, 110));
  for (const st of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${codOrder.data.order.id}/status`, { method: 'POST', token: codRestoToken, body: { status: st } });
  }
  const codCommission = codOrder.data.order.commission_cents;

  const codList = await call(`/admin/cod?restaurant_id=${codResto.id}`, { token: aToken });
  check('journees de caisse calculees', codList.status === 200 && codList.data.days.length >= 1,
    String(codList.data.days.length));
  const todayStr = new Date().toISOString().slice(0, 10);
  const codToday = codList.data.days.find((d) => d.day === todayStr);
  check('journee du jour pour le restaurant', !!codToday, todayStr);
  check('montant attendu = commissions du jour', codToday && codToday.expected_cents === codCommission,
    `${codToday?.expected_cents} vs ${codCommission}`);
  check('encaisse brut enregistre', codToday && codToday.gross_cents === 10000, String(codToday?.gross_cents));
  check('statut initial ouvert', codToday && codToday.status === 'open', String(codToday?.status));

  // the restaurant declares its cash
  const declared = await call('/restaurant/cod/declare', { method: 'POST', token: codRestoToken, body: {
    day: todayStr, amount_cents: codToday.expected_cents } });
  check('le restaurant declare sa caisse', declared.status === 201 && declared.data.day.status === 'declared',
    JSON.stringify(declared.data).slice(0, 110));
  check('montant declare enregistre', declared.data.day.declared_cents === codToday.expected_cents);
  check('un client ne peut pas declarer',
    (await call('/restaurant/cod/declare', { method: 'POST', token: cToken, body: { day: todayStr, amount_cents: 100 } })).status === 403);
  check('journee inexistante refusee',
    (await call('/restaurant/cod/declare', { method: 'POST', token: codRestoToken, body: { day: '2020-01-01', amount_cents: 100 } })).status === 404);

  const restoCodView = await call('/restaurant/cod', { token: codRestoToken });
  check('le restaurant voit ses journees', restoCodView.data.days.length >= 1);
  check('solde du restaurant calcule', typeof restoCodView.data.owed_cents === 'number');

  // admin records what actually arrived — short by 5.00 MAD
  const shortBy = 500;
  const received = await call(`/admin/cod/${codToday.id}/received`, { method: 'POST', token: aToken, body: {
    amount_cents: codToday.expected_cents - shortBy, note: 'Depot partiel', idempotency_key: `cod-${stamp}` } });
  check('admin enregistre l argent recu', received.status === 201 && received.data.day.status === 'received');
  check('ecart calcule automatiquement', received.data.day.difference_cents === -shortBy,
    String(received.data.day.difference_cents));
  const codReplay = await call(`/admin/cod/${codToday.id}/received`, { method: 'POST', token: aToken, body: {
    amount_cents: 999, idempotency_key: `cod-${stamp}` } });
  check('encaissement idempotent', codReplay.data.replayed === true);

  const disputed = await call(`/admin/cod/${codToday.id}/dispute`, { method: 'POST', token: aToken, body: {
    note: 'Manque 5 MAD, a verifier' } });
  check('journee mise en litige', disputed.data.day.status === 'disputed');
  check('note du litige enregistree', disputed.data.day.note === 'Manque 5 MAD, a verifier');
  check('litige sans raison refuse',
    (await call(`/admin/cod/${codToday.id}/dispute`, { method: 'POST', token: aToken, body: {} })).status === 400);

  const resolved = await call(`/admin/cod/${codToday.id}/reconcile`, { method: 'POST', token: aToken, body: {
    note: 'Complement recu en main propre' } });
  check('litige resolu par rapprochement', resolved.data.day.status === 'reconciled');
  check('un client ne voit pas la caisse', (await call('/admin/cod', { token: cToken })).status === 403);

  const codSummaryAfter = await call('/admin/cod', { token: aToken });
  check('resume des statuts', codSummaryAfter.data.summary.reconciled >= 1, JSON.stringify(codSummaryAfter.data.summary));

  // settlements
  const preview = await call(`/admin/settlements/preview?restaurant_id=${codResto.id}&from=${todayStr}&to=${todayStr}`, { token: aToken });
  check('apercu du reglement', preview.status === 200 && preview.data.orders_count >= 1, JSON.stringify(preview.data));
  check('a reverser = commission', preview.data.net_payable_cents === preview.data.commission_cents);

  const settlement = await call('/admin/settlements', { method: 'POST', token: aToken, body: {
    restaurant_id: codResto.id, period_start: todayStr, period_end: todayStr, adjustments_cents: 200,
    idempotency_key: `set-${stamp}` } });
  check('reglement cree', settlement.status === 201, JSON.stringify(settlement.data).slice(0, 110));
  check('ajustement deduit du montant a reverser',
    settlement.data.settlement.net_payable_cents === preview.data.commission_cents - 200,
    String(settlement.data.settlement.net_payable_cents));
  check('statut initial brouillon', settlement.data.settlement.status === 'draft');
  check('periode inversee refusee',
    (await call('/admin/settlements', { method: 'POST', token: aToken, body: {
      restaurant_id: codResto.id, period_start: todayStr, period_end: '2020-01-01' } })).status === 400);

  const settlementId = settlement.data.settlement.id;
  const approved = await call(`/admin/settlements/${settlementId}/status`, { method: 'POST', token: aToken, body: {
    status: 'approved', idempotency_key: `seta-${stamp}` } });
  check('reglement approuve', approved.data.settlement.status === 'approved');
  const paid = await call(`/admin/settlements/${settlementId}/status`, { method: 'POST', token: aToken, body: {
    status: 'paid', idempotency_key: `setp-${stamp}` } });
  check('reglement marque paye', paid.data.settlement.status === 'paid' && !!paid.data.settlement.paid_at);
  check('reglement deja paye non repayable',
    (await call(`/admin/settlements/${settlementId}/status`, { method: 'POST', token: aToken, body: { status: 'approved' } })).status === 409);

  const settlementList = await call('/admin/settlements', { token: aToken });
  check('liste des reglements', settlementList.data.settlements.length >= 1);
  check('total paye comptabilise', settlementList.data.totals.paid_cents >= 1, String(settlementList.data.totals.paid_cents));
  check('solde du restaurant tient compte du reglement',
    (await call(`/admin/restaurants/${codResto.id}`, { token: aToken })).data.balance.settled_cents >= 1);
  check('un client ne voit pas les reglements', (await call('/admin/settlements', { token: cToken })).status === 403);

  const codAudit = await call('/admin/audit', { token: aToken });
  for (const action of ['cod_declared', 'cod_received', 'cod_disputed', 'cod_reconciled', 'settlement_create', 'settlement_status']) {
    check(`action "${action}" tracee`, codAudit.data.logs.some((l) => l.action === action));
  }

  section('Controle des commandes');
  const oc_allOrders = await call('/admin/orders', { token: aToken });
  check('liste des commandes admin', oc_allOrders.status === 200 && oc_allOrders.data.orders.length >= 1);
  check('totaux de la recherche', typeof oc_allOrders.data.totals.total_cents === 'number',
    JSON.stringify(oc_allOrders.data.totals));

  const oc_byNumber = await call(`/admin/orders?q=${encodeURIComponent(po.order_number)}`, { token: aToken });
  check('recherche par numero de commande', oc_byNumber.data.orders.length === 1 &&
    oc_byNumber.data.orders[0].order_number === po.order_number, String(oc_byNumber.data.orders.length));
  const oc_byPhone = await call(`/admin/orders?q=${uniquePhone('61')}`, { token: aToken });
  check('recherche par telephone client', oc_byPhone.data.orders.length >= 1, String(oc_byPhone.data.orders.length));
  const oc_byStatus = await call('/admin/orders?status=completed', { token: aToken });
  check('filtre par statut', oc_byStatus.data.orders.every((o) => o.status === 'completed'));
  const oc_byMode = await call('/admin/orders?fulfillment=delivery', { token: aToken });
  check('filtre par mode', oc_byMode.data.orders.every((o) => o.fulfillment_type === 'delivery'));
  const oc_byResto = await call(`/admin/orders?restaurant_id=${atlas.id}`, { token: aToken });
  check('filtre par restaurant', oc_byResto.data.orders.every((o) => Number(o.restaurant_id) === Number(atlas.id)));
  const oc_refundedOnly = await call('/admin/orders?status=refunded', { token: aToken });
  check('filtre "rembourses"', oc_refundedOnly.data.orders.every((o) => Number(o.refunded_cents) > 0),
    String(oc_refundedOnly.data.orders.length));
  const oc_today = new Date().toISOString().slice(0, 10);
  const oc_byDate = await call(`/admin/orders?from=${oc_today}&to=${oc_today}`, { token: aToken });
  check('filtre par date', oc_byDate.data.orders.length >= 1, String(oc_byDate.data.orders.length));
  const oc_future = await call('/admin/orders?from=2099-01-01', { token: aToken });
  check('plage de dates vide ne renvoie rien', oc_future.data.orders.length === 0);

  const oc_odetail = await call(`/admin/orders/${po.id}`, { token: aToken });
  check('fiche commande complete', oc_odetail.status === 200 && !!oc_odetail.data.order && !!oc_odetail.data.customer);
  check('contenu et options presents', oc_odetail.data.order.items.length >= 1 &&
    Array.isArray(oc_odetail.data.order.items[0].options));
  check('historique des statuts present', oc_odetail.data.order.history.length >= 1);
  check('historique des remboursements present', Array.isArray(oc_odetail.data.order.refunds));
  check('notes internes vides au depart', Array.isArray(oc_odetail.data.notes));
  check('nombre de commandes du client', oc_odetail.data.customer.orders_count >= 1);

  const oc_noted = await call(`/admin/orders/${po.id}/notes`, { method: 'POST', token: aToken, body: {
    note: 'Client a rappele pour confirmer.' } });
  check('note interne ajoutee', oc_noted.status === 201);
  check('note visible sur la fiche',
    (await call(`/admin/orders/${po.id}`, { token: aToken })).data.notes
      .some((n) => n.note === 'Client a rappele pour confirmer.'));
  check('note trop courte refusee',
    (await call(`/admin/orders/${po.id}/notes`, { method: 'POST', token: aToken, body: { note: 'x' } })).status === 400);
  check('un client ne peut pas ajouter de note',
    (await call(`/admin/orders/${po.id}/notes`, { method: 'POST', token: cToken, body: { note: 'pirate' } })).status === 403);

  // admin cancels a live order
  const oc_toCancel = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  await call(`/restaurant/orders/${oc_toCancel.data.order.id}/status`, { method: 'POST', token: r1Token, body: { status: 'accepted' } });
  check('annulation sans raison refusee',
    (await call(`/admin/orders/${oc_toCancel.data.order.id}/cancel`, { method: 'POST', token: aToken, body: {} })).status === 400);
  const oc_cancelled = await call(`/admin/orders/${oc_toCancel.data.order.id}/cancel`, { method: 'POST', token: aToken, body: {
    reason: 'Restaurant injoignable' } });
  check('admin annule une commande acceptee', oc_cancelled.data.order.status === 'cancelled',
    String(oc_cancelled.data.order.status));
  check('raison enregistree dans l historique',
    oc_cancelled.data.order.history.some((h) => (h.note || '').includes('Restaurant injoignable')));
  // `order` is the one that was taken all the way to completed earlier.
  const oc_lateCancel = await call(`/admin/orders/${order.id}/cancel`, { method: 'POST', token: aToken, body: { reason: 'test' } });
  check('commande terminee non annulable', oc_lateCancel.status === 409,
    `${oc_lateCancel.status} ${JSON.stringify(oc_lateCancel.data).slice(0, 80)}`);

  const oc_orderAudit = await call('/admin/audit', { token: aToken });
  check('annulation tracee', oc_orderAudit.data.logs.some((l) => l.action === 'order_cancel'));
  check('note tracee', oc_orderAudit.data.logs.some((l) => l.action === 'order_note'));
  check('un client ne voit pas la recherche de commandes',
    (await call('/admin/orders', { token: cToken })).status === 403);

  section('Gestion des restaurants');
  const detail = await call(`/admin/restaurants/${atlas.id}`, { token: aToken });
  check('fiche restaurant complete', detail.status === 200 && !!detail.data.restaurant && !!detail.data.owner);
  check('carte du restaurant incluse', detail.data.products.length >= 5, String(detail.data.products.length));
  check('options incluses dans la carte', detail.data.products.some((p) => (p.option_groups || []).length > 0));
  check('commandes du restaurant incluses', Array.isArray(detail.data.orders) && detail.data.orders.length >= 1);
  check('remboursements du restaurant inclus', Array.isArray(detail.data.refunds));
  check('solde calcule', typeof detail.data.balance.commission_cents === 'number' &&
    typeof detail.data.balance.settled_cents === 'number', JSON.stringify(detail.data.balance));

  const restoEdit = await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: aToken, body: {
    description: 'Modifie par l admin', prep_minutes: 33, delivery_fee_cents: 1200 } });
  check('admin modifie la fiche', restoEdit.status === 200 && restoEdit.data.restaurant.prep_minutes === 33);
  check('frais de livraison modifies', restoEdit.data.restaurant.delivery_fee_cents === 1200);
  check('nom conserve si non fourni', restoEdit.data.restaurant.name === 'Snack Atlas');
  await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: aToken, body: {
    delivery_fee_cents: Number(atlas.delivery_fee_cents), prep_minutes: 20 } });

  const closed = await call(`/admin/restaurants/${atlas.id}/open`, { method: 'POST', token: aToken, body: { is_open: false } });
  check('admin ferme le restaurant', closed.data.restaurant.is_open === 0);
  const orderWhileClosed = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup', items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  check('commande refusee quand le restaurant est ferme', orderWhileClosed.status === 409);
  await call(`/admin/restaurants/${atlas.id}/open`, { method: 'POST', token: aToken, body: { is_open: true } });

  const unavailable = await call(`/admin/products/${coca.id}`, { method: 'PUT', token: aToken, body: { is_active: false } });
  check('admin rend un produit indisponible', unavailable.data.product.is_active === 0);
  const menuAfter = await call(`/restaurants/${atlas.id}`);
  check('produit indisponible masque aux clients',
    !menuAfter.data.menu.flatMap((c) => c.products).some((p) => p.id === coca.id));
  await call(`/admin/products/${coca.id}`, { method: 'PUT', token: aToken, body: { is_active: true } });

  // reject a pending restaurant, and check its owner is locked out
  const rejectOwner = await registerWithCode({
    name: 'Proprio Refuse', phone: uniquePhone('68'), password: 'motdepasse1',
    role: 'restaurant', restaurant_name: RESTO_REJECTED, city: 'Fes' });
  const rejectedResto = (await call('/admin/restaurants?status=pending', { token: aToken }))
    .data.restaurants.find((r) => r.name === RESTO_REJECTED);
  check('refus sans raison impossible',
    (await call(`/admin/restaurants/${rejectedResto.id}/status`, { method: 'POST', token: aToken, body: { status: 'rejected' } })).status === 400);
  const rejected = await call(`/admin/restaurants/${rejectedResto.id}/status`, { method: 'POST', token: aToken, body: {
    status: 'rejected', reason: 'Documents manquants' } });
  check('restaurant refuse', rejected.data.restaurant.status === 'rejected');
  check('raison du refus enregistree', rejected.data.restaurant.rejection_reason === 'Documents manquants');
  check('session du proprietaire refuse coupee', (await call('/me', { token: rejectOwner.data.token })).status === 403);
  check('proprietaire refuse ne peut plus se connecter',
    (await call('/auth/login', { method: 'POST', body: { identifier: uniquePhone('68'), password: 'motdepasse1' } })).status === 403);

  // suspend an approved restaurant: invisible to customers, owner locked out
  const suspendTarget = (await call('/admin/restaurants', { token: aToken })).data.restaurants.find((r) => r.name === 'Pizzeria Bella');
  await call(`/admin/restaurants/${suspendTarget.id}/status`, { method: 'POST', token: aToken, body: {
    status: 'suspended', reason: 'Controle hygiene' } });
  check('restaurant suspendu invisible du public',
    !(await call('/restaurants')).data.restaurants.some((r) => r.id === suspendTarget.id));
  check('proprietaire suspendu ne peut plus se connecter',
    (await call('/auth/login', { method: 'POST', body: { identifier: 'resto2@demo.ma', password: 'resto1234' } })).status === 403);
  const reactivatedResto = await call(`/admin/restaurants/${suspendTarget.id}/status`, { method: 'POST', token: aToken, body: { status: 'approved' } });
  check('restaurant reactive', reactivatedResto.data.restaurant.status === 'approved');
  check('proprietaire peut se reconnecter',
    (await call('/auth/login', { method: 'POST', body: { identifier: 'resto2@demo.ma', password: 'resto1234' } })).status === 201);

  check('un client ne peut pas modifier un restaurant',
    (await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: cToken, body: { name: 'Pirate' } })).status === 403);
  check('un restaurateur ne peut pas modifier un autre restaurant',
    (await call(`/admin/restaurants/${atlas.id}`, { method: 'PUT', token: r2Token, body: { name: 'Pirate' } })).status === 403);

  const auditAfter = await call('/admin/audit', { token: aToken });
  check('modifications tracees avec avant/apres',
    auditAfter.data.logs.some((l) => l.action === 'restaurant_edit' && l.before_state && l.after_state),
    auditAfter.data.logs.slice(0, 3).map((l) => l.action).join(','));

  section('Tableau de bord admin');
  const dash = await call('/admin/dashboard', { token: aToken });
  check('tableau de bord accessible', dash.status === 200);
  check('chiffres du jour presents',
    dash.data.today && typeof dash.data.today.orders === 'number' && typeof dash.data.today.revenue_cents === 'number',
    JSON.stringify(dash.data.today));
  check('commandes du jour comptees', dash.data.today.orders >= 1, String(dash.data.today.orders));
  check('commission du jour comptee', dash.data.today.commission_cents > 0, String(dash.data.today.commission_cents));
  check('remboursements du jour comptes', dash.data.today.refunded_cents >= 1200, String(dash.data.today.refunded_cents));
  check('compteurs de commandes en cours',
    dash.data.live && ['pending', 'preparing', 'ready'].every((k) => typeof dash.data.live[k] === 'number'),
    JSON.stringify(dash.data.live));
  check('compteurs de restaurants', dash.data.restaurants.active >= 2, JSON.stringify(dash.data.restaurants));
  check('etat de la caisse COD', dash.data.cod && typeof dash.data.cod.pending === 'number', JSON.stringify(dash.data.cod));
  const codTracked = ['open', 'declared', 'received', 'reconciled', 'disputed']
    .reduce((sum, key) => sum + Number(dash.data.cod[key] || 0), 0);
  check('journees COD calculees depuis les commandes', codTracked > 0, JSON.stringify(dash.data.cod));
  check('remboursements recents listes', Array.isArray(dash.data.recent_refunds) && dash.data.recent_refunds.length >= 1);
  check('actions recentes listees', Array.isArray(dash.data.recent_actions) && dash.data.recent_actions.length >= 1);
  check('liens rapides (restaurants en attente)', Array.isArray(dash.data.pending_restaurants));
  check('role de l admin renvoye', dash.data.admin_role === 'super_admin', String(dash.data.admin_role));
  check('un client ne voit pas le tableau de bord', (await call('/admin/dashboard', { token: cToken })).status === 403);

  section('Idempotence des actions financieres');
  const idemOrder = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 2, option_ids: [sizeM.id] }] } });
  const idemId = idemOrder.data.order.id;
  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${idemId}/status`, { method: 'POST', token: r1Token, body: { status } });
  }
  const key = `test-key-${stamp}`;
  const idemFirst = await call(`/admin/orders/${idemId}/refund`, { method: 'POST', token: aToken, body: {
    amount_cents: 500, reason: 'Test idempotence', idempotency_key: key } });
  check('premier remboursement accepte', idemFirst.status === 201 && idemFirst.data.order.refunded_cents === 500,
    JSON.stringify(idemFirst.data).slice(0, 110));
  const replay = await call(`/admin/orders/${idemId}/refund`, { method: 'POST', token: aToken, body: {
    amount_cents: 500, reason: 'Test idempotence', idempotency_key: key } });
  check('meme cle = reponse rejouee, pas de double remboursement', replay.data.replayed === true,
    JSON.stringify(replay.data).slice(0, 90));
  const afterReplay = await call(`/orders/${idemId}`, { token: aToken });
  check('montant rembourse inchange apres rejeu', afterReplay.data.order.refunded_cents === 500,
    String(afterReplay.data.order.refunded_cents));
  const differentKey = await call(`/admin/orders/${idemId}/refund`, { method: 'POST', token: aToken, body: {
    amount_cents: 500, reason: 'Deuxieme', idempotency_key: `${key}-b` } });
  check('cle differente = nouveau remboursement', differentKey.data.order.refunded_cents === 1000,
    String(differentKey.data.order.refunded_cents));

  section('Types de service et cuisines');
  const cuisineList = await call('/cuisines');
  check('liste des cuisines servie', cuisineList.status === 200 && cuisineList.data.cuisines.length >= 7,
    String(cuisineList.data.cuisines?.length));
  check('types de service servis',
    Array.isArray(cuisineList.data.service_types) && cuisineList.data.service_types.includes('preorder'));

  const allRestos = await call('/restaurants');
  check('les 10 restaurants de demo sont la', allRestos.data.restaurants.length >= 10,
    String(allRestos.data.restaurants.length));
  check('chaque restaurant a un type de service',
    allRestos.data.restaurants.every((r) => ['immediate', 'preorder'].includes(r.service_type)));

  const italians = await call('/restaurants?cuisine=italienne');
  check('filtre cuisine italienne', italians.data.restaurants.length >= 4,
    String(italians.data.restaurants.length));
  check('filtre cuisine coherent',
    italians.data.restaurants.every((r) => r.cuisine_keys.includes('italienne')));

  const preorders = await call('/restaurants?service=preorder');
  check('filtre precommande', preorders.data.restaurants.length >= 4,
    String(preorders.data.restaurants.length));
  check('filtre precommande coherent',
    preorders.data.restaurants.every((r) => r.service_type === 'preorder'));

  const combined = await call('/restaurants?service=preorder&cuisine=italienne');
  check('filtres combines',
    combined.data.restaurants.length > 0
    && combined.data.restaurants.length < preorders.data.restaurants.length
    && combined.data.restaurants.every((r) => r.service_type === 'preorder' && r.cuisine_keys.includes('italienne')),
    String(combined.data.restaurants.length));

  check('cuisine inconnue ignoree',
    (await call('/restaurants?cuisine=klingon')).data.restaurants.length === allRestos.data.restaurants.length);

  const roma = preorders.data.restaurants.find((r) => r.name === 'Roma Gourmet');
  check('Roma Gourmet trouve', !!roma);
  const romaDetail = await call(`/restaurants/${roma.id}`);
  check('fenetre de precommande servie', !!romaDetail.data.preorder);
  check('delai de preparation expose', romaDetail.data.preorder.min_prep_hours === 24,
    String(romaDetail.data.preorder.min_prep_hours));
  check('creneaux exposes', romaDetail.data.preorder.slots.length === 2,
    romaDetail.data.preorder.slots.join(','));
  check('dates proposees', romaDetail.data.preorder.dates.length > 0,
    String(romaDetail.data.preorder.dates.length));
  const today = new Date().toISOString().slice(0, 10);
  check('aucune date avant le delai', !romaDetail.data.preorder.dates.includes(today));
  check('jours de livraison respectes',
    romaDetail.data.preorder.dates.every((d) =>
      romaDetail.data.preorder.days.includes(new Date(`${d}T00:00:00Z`).getUTCDay())));

  const romaDish = romaDetail.data.menu.flatMap((c) => c.products)[0];
  const romaLine = [{ product_id: romaDish.id, quantity: 3 }];

  const noSchedule = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: roma.id, fulfillment_type: 'pickup', items: romaLine } });
  check('precommande sans date refusee', noSchedule.status === 400, String(noSchedule.status));

  const badDate = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: roma.id, fulfillment_type: 'pickup', items: romaLine,
    scheduled_for: today, scheduled_slot: romaDetail.data.preorder.slots[0] } });
  check('date trop proche refusee', badDate.status === 400, String(badDate.status));

  const goodDate = romaDetail.data.preorder.dates[0];
  const badSlot = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: roma.id, fulfillment_type: 'pickup', items: romaLine,
    scheduled_for: goodDate, scheduled_slot: '03:00-04:00' } });
  check('creneau inconnu refuse', badSlot.status === 400, String(badSlot.status));

  const goodSlot = romaDetail.data.preserve || romaDetail.data.preorder.slots[1];
  const preorderOk = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: roma.id, fulfillment_type: 'pickup', items: romaLine,
    scheduled_for: goodDate, scheduled_slot: goodSlot } });
  check('precommande valide acceptee', preorderOk.status === 201, JSON.stringify(preorderOk.data).slice(0, 120));
  check('type de service enregistre', preorderOk.data.order?.service_type === 'preorder');
  check('date de livraison enregistree', preorderOk.data.order?.scheduled_for === goodDate,
    preorderOk.data.order?.scheduled_for);
  check('creneau enregistre', preorderOk.data.order?.scheduled_slot === goodSlot,
    preorderOk.data.order?.scheduled_slot);

  const immediateResto = allRestos.data.restaurants.find((r) => r.service_type === 'immediate' && r.is_open);
  const immediateDetail = await call(`/restaurants/${immediateResto.id}`);
  check('restaurant immediat sans fenetre', immediateDetail.data.preorder.dates.length === 0);
  const immediateDish = immediateDetail.data.menu.flatMap((c) => c.products)
    .find((p) => !(p.option_groups || []).some((g) => g.min_select > 0));
  const scheduleOnImmediate = await call('/orders', { method: 'POST', token: cToken, body: {
    restaurant_id: immediateResto.id, fulfillment_type: 'pickup',
    items: [{ product_id: immediateDish.id, quantity: 4 }],
    scheduled_for: goodDate, scheduled_slot: goodSlot } });
  check('planning refuse sur un restaurant immediat', scheduleOnImmediate.status === 400,
    String(scheduleOnImmediate.status));

  section('Admin: type de service et cuisines');
  const adminRestos = await call('/admin/restaurants?service=preorder', { token: aToken });
  check('admin filtre par service',
    adminRestos.data.restaurants.length > 0
    && adminRestos.data.restaurants.every((r) => r.service_type === 'preorder'));
  const adminItalian = await call('/admin/restaurants?cuisine=italienne', { token: aToken });
  check('admin filtre par cuisine',
    adminItalian.data.restaurants.length >= 4
    && adminItalian.data.restaurants.every((r) => r.cuisine_keys.includes('italienne')));

  const grill = allRestos.data.restaurants.find((r) => r.name === 'Le Grill Royal');
  const toPreorder = await call(`/admin/restaurants/${grill.id}`, { method: 'PUT', token: aToken, body: {
    service_type: 'preorder', min_prep_hours: 48, delivery_days: [2, 5],
    delivery_slots: ['11:00-13:00', '18:00-20:00'], order_cutoff: '17:00',
    cuisines: ['grillades', 'healthy'], rating_bp: 44000 } });
  check('admin bascule en precommande', toPreorder.data.restaurant?.service_type === 'preorder');
  check('delai enregistre', toPreorder.data.restaurant?.min_prep_hours === 48);
  check('jours normalises', toPreorder.data.restaurant?.delivery_days === '2,5',
    toPreorder.data.restaurant?.delivery_days);
  check('creneaux normalises', toPreorder.data.restaurant?.delivery_slots === '11:00-13:00,18:00-20:00',
    toPreorder.data.restaurant?.delivery_slots);
  check('cuisines enregistrees', toPreorder.data.restaurant?.cuisine_keys.join(',') === 'grillades,healthy',
    toPreorder.data.restaurant?.cuisines);
  check('note enregistree', toPreorder.data.restaurant?.rating === 4.4,
    String(toPreorder.data.restaurant?.rating));

  const badPrep = await call(`/admin/restaurants/${grill.id}`, { method: 'PUT', token: aToken, body: {
    service_type: 'preorder', min_prep_hours: 0, delivery_slots: ['11:00-13:00'] } });
  check('delai invalide refuse', badPrep.status === 400, String(badPrep.status));
  const noSlots = await call(`/admin/restaurants/${grill.id}`, { method: 'PUT', token: aToken, body: {
    service_type: 'preorder', min_prep_hours: 24, delivery_slots: [] } });
  check('absence de creneau refusee', noSlots.status === 400, String(noSlots.status));
  const badCutoff = await call(`/admin/restaurants/${grill.id}`, { method: 'PUT', token: aToken, body: {
    service_type: 'preorder', min_prep_hours: 24, delivery_slots: ['11:00-13:00'], order_cutoff: '25:99' } });
  check('heure limite invalide refusee', badCutoff.status === 400, String(badCutoff.status));

  const backToImmediate = await call(`/admin/restaurants/${grill.id}`, { method: 'PUT', token: aToken, body: {
    service_type: 'immediate' } });
  check('retour en immediat', backToImmediate.data.restaurant?.service_type === 'immediate');
  check('config precommande effacee',
    backToImmediate.data.restaurant?.min_prep_hours === 0
    && backToImmediate.data.restaurant?.delivery_slots === '');

  const ordersByService = await call('/admin/orders?service=preorder', { token: aToken });
  check('admin filtre les commandes par service',
    ordersByService.data.orders.length > 0
    && ordersByService.data.orders.every((o) => o.service_type === 'preorder'),
    String(ordersByService.data.orders.length));

  section('Restaurant: son propre type de service');
  const bellaLogin = await call('/auth/login', { method: 'POST', body: {
    identifier: '0611000001', password: 'resto1234' } });
  check('connexion restaurant par telephone', bellaLogin.status === 201 && !!bellaLogin.data.token,
    String(bellaLogin.status));
  const rToken2 = bellaLogin.data.token;

  const selfPreorder = await call('/restaurant/me', { method: 'PUT', token: rToken2, body: {
    service_type: 'preorder', min_prep_hours: 24,
    delivery_days: [3, 6], delivery_slots: ['12:00-14:00'], order_cutoff: '19:00' } });
  check('restaurant se met en precommande', selfPreorder.data.restaurant?.service_type === 'preorder');
  check('restaurant garde son delai', selfPreorder.data.restaurant?.min_prep_hours === 24);
  const selfBack = await call('/restaurant/me', { method: 'PUT', token: rToken2, body: {
    service_type: 'immediate' } });
  check('restaurant revient en immediat', selfBack.data.restaurant?.service_type === 'immediate');
  const selfBadSlots = await call('/restaurant/me', { method: 'PUT', token: rToken2, body: {
    service_type: 'preorder', min_prep_hours: 24, delivery_slots: [] } });
  check('restaurant: creneau obligatoire', selfBadSlots.status === 400, String(selfBadSlots.status));

  section('Reinitialisation du mot de passe');
  const liveAdmin = await adminToken();
  const rs_resetPhone = uniquePhone('81');
  const rs_resetUser = await registerWithCode({
    name: 'Oubli Motdepasse', phone: rs_resetPhone, password: 'ancien-mot-de-passe' });
  check('compte cree pour le test de reinitialisation', rs_resetUser.status === 201);
  const rsOldToken = rs_resetUser.data.token;

  const rs_unknown = await call('/auth/forgot-password', { method: 'POST', body: { identifier: '0699999999' } });
  check('numero inconnu: meme reponse', rs_unknown.status === 201 && rs_unknown.data.sent === true,
    JSON.stringify(rs_unknown.data));

  const rsAsked = await call('/auth/forgot-password', { method: 'POST', body: { identifier: rs_resetPhone } });
  check('demande de reinitialisation acceptee', rsAsked.data.sent === true);
  check('la reponse ne contient pas de code', !JSON.stringify(rsAsked.data).match(/\d{6}/),
    JSON.stringify(rsAsked.data));

  const rsCode = await latestCode(rs_resetPhone, 'reset');
  check('le code de reinitialisation est visible dans la console admin', !!rsCode);

  const rs_wrongCode = await call('/auth/reset-password', { method: 'POST', body: {
    identifier: rs_resetPhone, code: '000000', new_password: 'nouveau-mot-de-passe' } });
  check('mauvais code refuse', rs_wrongCode.status === 400, String(rs_wrongCode.status));

  const rs_done = await call('/auth/reset-password', { method: 'POST', body: {
    identifier: rs_resetPhone, code: rsCode, new_password: 'nouveau-mot-de-passe' } });
  check('reinitialisation acceptee', rs_done.status === 201, JSON.stringify(rs_done.data).slice(0, 90));

  const rs_reused = await call('/auth/reset-password', { method: 'POST', body: {
    identifier: rs_resetPhone, code: rsCode, new_password: 'encore-un-autre' } });
  check('le code ne sert qu une fois', rs_reused.status === 400, String(rs_reused.status));

  check('l ancien mot de passe ne marche plus',
    (await call('/auth/login', { method: 'POST', body: {
      identifier: rs_resetPhone, password: 'ancien-mot-de-passe' } })).status === 401);
  check('le nouveau mot de passe marche',
    (await call('/auth/login', { method: 'POST', body: {
      identifier: rs_resetPhone, password: 'nouveau-mot-de-passe' } })).status === 201);
  check('les anciennes sessions sont invalidees',
    (await call('/me', { token: rsOldToken })).status === 401);

  section('Code d inscription');
  const rs_otpPhone = uniquePhone('82');
  await call('/auth/request-code', { method: 'POST', body: { phone: rs_otpPhone } });
  const rs_regCode = await latestCode(rs_otpPhone, 'register');
  check('code d inscription emis', !!rs_regCode);
  check('inscription sans code refusee',
    (await call('/auth/register', { method: 'POST', body: {
      name: 'Sans Code', phone: rs_otpPhone, password: 'motdepasse1' } })).status === 400);
  check('inscription avec un mauvais code refusee',
    (await call('/auth/register', { method: 'POST', body: {
      name: 'Mauvais Code', phone: rs_otpPhone, password: 'motdepasse1', code: '000000' } })).status === 400);
  const rs_withCode = await call('/auth/register', { method: 'POST', body: {
    name: 'Avec Code', phone: rs_otpPhone, password: 'motdepasse1', code: rs_regCode } });
  check('inscription avec le bon code acceptee', rs_withCode.status === 201, String(rs_withCode.status));
  check('le code ne sert qu une fois',
    (await call('/auth/register', { method: 'POST', body: {
      name: 'Double', phone: uniquePhone('83'), password: 'motdepasse1', code: rs_regCode } })).status === 400);

  section('Sante et sauvegardes');
  const rs_pub = await call('/health');
  check('etat public: ok', rs_pub.data.status === 'ok' && rs_pub.data.ok === true);
  check('etat public ne revele rien de sensible',
    !('warnings' in rs_pub.data) && !('disk' in rs_pub.data), Object.keys(rs_pub.data).join(','));
  check('duree de fonctionnement exposee', typeof rs_pub.data.uptime_seconds === 'number');

  const rs_privateHealth = await call('/admin/health', { token: liveAdmin });
  check('etat admin accessible', rs_privateHealth.status === 200);
  check('etat admin: sauvegarde rapportee', !!rs_privateHealth.data.backup);
  check('etat admin: espace disque rapporte', typeof rs_privateHealth.data.disk.free_mb === 'number');
  check('etat admin: avertissements listes', Array.isArray(rs_privateHealth.data.warnings));
  check('etat admin refuse a un client', (await call('/admin/health', { token: cToken })).status === 403);

  const rs_madeBackup = await call('/admin/backup', { method: 'POST', token: liveAdmin, body: {} });
  check('sauvegarde declenchee par l admin', rs_madeBackup.status === 201 && rs_madeBackup.data.ok === true,
    JSON.stringify(rs_madeBackup.data).slice(0, 90));
  check('la sauvegarde couvre toutes les tables', rs_madeBackup.data.tables >= 22,
    String(rs_madeBackup.data.tables));
  check('la sauvegarde compte des lignes', rs_madeBackup.data.rows > 0, String(rs_madeBackup.data.rows));

  const rs_afterBackup = await call('/admin/health', { token: liveAdmin });
  check('la sauvegarde est marquee recente', rs_afterBackup.data.backup.stale === false);
  check('aucune erreur de sauvegarde', rs_afterBackup.data.backup.last_error === '');

  const rs_events = await call('/admin/events', { token: liveAdmin });
  check('journal des evenements accessible', rs_events.status === 200 && Array.isArray(rs_events.data.events));
  check('les evenements sont horodates', rs_events.data.events.every((e) => !!e.t));
  check('aucun mot de passe dans le journal',
    !JSON.stringify(rs_events.data.events).toLowerCase().includes('motdepasse1'));

  /* ------------------------------------------------------------------ *
   * Delivery addresses
   *
   * The point of every check here is that an address belongs to one customer
   * and that an order keeps its own frozen copy. Those two together are what
   * stop a courier being sent to the wrong door and stop an old order being
   * quietly rewritten.
   * ------------------------------------------------------------------ */
  section('Adresses de livraison');

  const ad_valid = {
    label: 'work', recipient_name: 'Ilham B.', recipient_phone: '0612000111',
    city: 'Rabat', street: 'Avenue Hassan II, n 48', building: 'Residence Nour, bloc C',
    floor: '4e etage, appt 12', landmark: 'face a la banque', instructions: 'sonner deux fois',
    lat: 34.020882, lng: -6.841650,
  };

  const ad_created = await call('/me/addresses', { method: 'POST', token: oToken, body: ad_valid });
  check('le client peut enregistrer une adresse', ad_created.status === 201,
    JSON.stringify(ad_created.data).slice(0, 110));
  const ad_id = ad_created.data.address_id;
  const ad_row = (ad_created.data.addresses || []).find((a) => a.id === ad_id);
  check('l adresse revient avec son point', ad_row && ad_row.has_pin === true);
  check('la premiere adresse devient celle par defaut', ad_row && ad_row.is_default === true);
  check('les coordonnees sont arrondies a 6 decimales',
    ad_row && ad_row.lat === '34.020882' && ad_row.lng === '-6.84165',
    `${ad_row && ad_row.lat} / ${ad_row && ad_row.lng}`);
  check('l adresse est resumee en une ligne',
    ad_row && ad_row.one_line.includes('Avenue Hassan II') && ad_row.one_line.includes('Rabat'),
    ad_row && ad_row.one_line);
  check('un lien de carte est fourni',
    ad_row && ad_row.map_link.includes('34.020882') && ad_row.map_link.includes('-6.84165'));

  // --- coordinates ---
  const ad_badCoords = [
    ['latitude au-dela de 90', { ...ad_valid, lat: 90.1 }],
    ['latitude sous -90', { ...ad_valid, lat: -90.5 }],
    ['longitude au-dela de 180', { ...ad_valid, lng: 180.2 }],
    ['longitude sous -180', { ...ad_valid, lng: -181 }],
    ['latitude non numerique', { ...ad_valid, lat: 'ici' }],
    ['latitude vide', { ...ad_valid, lat: '' }],
    ['longitude absente', { ...ad_valid, lng: undefined }],
    ['latitude infinie', { ...ad_valid, lat: 'Infinity' }],
  ];
  for (const [label, body] of ad_badCoords) {
    const r = await call('/me/addresses', { method: 'POST', token: oToken, body });
    check(`refus: ${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.data).slice(0, 70)}`);
  }
  check('les coins du monde sont acceptes',
    (await call('/me/addresses', { method: 'POST', token: oToken,
      body: { ...ad_valid, lat: -90, lng: 180 } })).status === 201);

  // --- required fields and length limits ---
  check('refus: sans rue', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, street: '' } })).status === 400);
  check('refus: sans ville', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, city: '' } })).status === 400);
  check('refus: sans destinataire', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, recipient_name: '' } })).status === 400);
  check('refus: telephone trop court', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, recipient_phone: '0612' } })).status === 400);
  check('refus: rue trop longue', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, street: 'r'.repeat(201) } })).status === 400);
  check('refus: repere trop long', (await call('/me/addresses', { method: 'POST', token: oToken,
    body: { ...ad_valid, landmark: 'x'.repeat(161) } })).status === 400);

  // --- edit ---
  const ad_edited = await call(`/me/addresses/${ad_id}`, { method: 'PUT', token: oToken,
    body: { ...ad_valid, floor: '5e etage, appt 20', lat: 34.03, lng: -6.85 } });
  check('le client peut modifier une adresse', ad_edited.status === 200);
  const ad_afterEdit = ad_edited.data.addresses.find((a) => a.id === ad_id);
  check('la modification est enregistree', ad_afterEdit && ad_afterEdit.floor === '5e etage, appt 20');
  check('le point modifie est enregistre', ad_afterEdit && ad_afterEdit.lat === '34.03');

  // --- default address ---
  const ad_second = await call('/me/addresses', { method: 'POST', token: oToken, body: {
    ...ad_valid, label: 'home', street: 'Rue de Fes, n 3', lat: 34.01, lng: -6.83 } });
  const ad_secondId = ad_second.data.address_id;
  check('une deuxieme adresse ne devient pas celle par defaut',
    ad_second.data.addresses.find((a) => a.id === ad_secondId).is_default === false);
  const ad_defaulted = await call(`/me/addresses/${ad_secondId}/default`, { method: 'POST', token: oToken });
  // Every POST in this app answers 201; see index.js.
  check('le client peut choisir son adresse par defaut', ad_defaulted.status === 201,
    String(ad_defaulted.status));
  check('la nouvelle adresse par defaut est marquee',
    ad_defaulted.data.addresses.find((a) => a.id === ad_secondId).is_default === true);
  check('une seule adresse par defaut a la fois',
    ad_defaulted.data.addresses.filter((a) => a.is_default).length === 1);

  // --- isolation between customers ---
  const ad_mine = await call('/me/addresses', { token: cToken });
  check('chaque client ne voit que ses propres adresses',
    ad_mine.data.addresses.every((a) => a.id !== ad_id && a.id !== ad_secondId),
    String(ad_mine.data.addresses.length));
  check('le client A ne peut pas modifier l adresse du client B',
    (await call(`/me/addresses/${ad_id}`, { method: 'PUT', token: cToken, body: ad_valid })).status === 404);
  check('le client A ne peut pas supprimer l adresse du client B',
    (await call(`/me/addresses/${ad_id}`, { method: 'DELETE', token: cToken })).status === 404);
  check('le client A ne peut pas imposer l adresse du client B par defaut',
    (await call(`/me/addresses/${ad_id}/default`, { method: 'POST', token: cToken })).status === 404);
  check('le client A ne peut pas livrer a l adresse du client B',
    (await call('/orders', { method: 'POST', token: cToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'delivery', address_id: ad_id,
      items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } })).status === 404);
  check('sans jeton, aucune adresse', (await call('/me/addresses')).status === 401);
  check('le restaurant n a pas de carnet d adresses',
    (await call('/me/addresses', { token: r1Token })).status === 403);

  // --- orders ---
  check('une commande a emporter ne demande aucune adresse',
    (await call('/orders', { method: 'POST', token: oToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'pickup',
      items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } })).status === 201);
  check('une livraison sans adresse est refusee',
    (await call('/orders', { method: 'POST', token: oToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'delivery',
      items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } })).status === 400);
  check('une livraison vers une adresse inexistante est refusee',
    (await call('/orders', { method: 'POST', token: oToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'delivery', address_id: 99999999,
      items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } })).status === 404);

  const ad_order = await call('/orders', { method: 'POST', token: oToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'delivery', address_id: ad_secondId,
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  check('une livraison vers une adresse enregistree est acceptee', ad_order.status === 201,
    JSON.stringify(ad_order.data).slice(0, 110));
  const ad_orderId = ad_order.data.order.id;
  const ad_snap = ad_order.data.order.delivery;
  check('la commande fige le destinataire', ad_snap && ad_snap.recipient_name === 'Ilham B.');
  check('la commande fige la rue', ad_snap && ad_snap.one_line.includes('Rue de Fes'),
    JSON.stringify(ad_snap).slice(0, 100));
  check('la commande fige le point', ad_snap && ad_snap.lat === '34.01' && ad_snap.lng === '-6.83');
  check('la commande fournit un lien de carte', ad_snap && ad_snap.has_pin === true && !!ad_snap.map_link);
  check('l adresse est aussi lisible en une ligne',
    ad_snap && ad_snap.one_line.includes('Rue de Fes'), ad_snap && ad_snap.one_line);

  // --- the snapshot does not move when the address does ---
  await call(`/me/addresses/${ad_secondId}`, { method: 'PUT', token: oToken, body: {
    ...ad_valid, label: 'home', recipient_name: 'Quelqu un d autre',
    street: 'Rue Totalement Differente, n 999', city: 'Agadir', lat: 30.42, lng: -9.6 } });
  const ad_afterMove = (await call(`/orders/${ad_orderId}`, { token: oToken })).data.order;
  check('modifier l adresse ne change pas la commande passee',
    ad_afterMove.delivery.recipient_name === 'Ilham B.'
    && ad_afterMove.delivery.one_line.includes('Rue de Fes')
    && ad_afterMove.delivery.lat === '34.01',
    JSON.stringify(ad_afterMove.delivery).slice(0, 120));

  const ad_deleted = await call(`/me/addresses/${ad_secondId}`, { method: 'DELETE', token: oToken });
  check('le client peut supprimer une adresse', ad_deleted.status === 200);
  check('l adresse supprimee disparait du carnet',
    !ad_deleted.data.addresses.some((a) => a.id === ad_secondId));
  check('une autre adresse reprend le role par defaut',
    ad_deleted.data.addresses.filter((a) => a.is_default).length === 1);
  const ad_afterDelete = (await call(`/orders/${ad_orderId}`, { token: oToken })).data.order;
  check('supprimer l adresse ne change pas la commande passee',
    ad_afterDelete.delivery.recipient_name === 'Ilham B.'
    && ad_afterDelete.delivery.one_line.includes('Rue de Fes')
    && ad_afterDelete.delivery.lat === '34.01',
    JSON.stringify(ad_afterDelete.delivery).slice(0, 120));
  check('la commande ne peut plus etre reliee a l adresse supprimee',
    (await call(`/me/addresses/${ad_secondId}`, { method: 'PUT', token: oToken, body: ad_valid })).status === 404);

  // --- who else sees it ---
  const ad_restoView = (await call('/restaurant/orders', { token: r1Token })).data.orders
    .find((o) => o.id === ad_orderId);
  check('le restaurant voit l adresse de livraison',
    ad_restoView && ad_restoView.delivery && ad_restoView.delivery.one_line.includes('Rue de Fes'));
  check('le restaurant voit le destinataire et son numero',
    ad_restoView && ad_restoView.delivery.recipient_name === 'Ilham B.'
    && ad_restoView.delivery.recipient_phone === '0612000111');
  check('le restaurant voit l etage et le repere',
    ad_restoView && ad_restoView.delivery.block.join(' | ').includes('etage'),
    ad_restoView && ad_restoView.delivery.block.join(' | '));
  check('le restaurant recoit un lien de carte',
    ad_restoView && !!ad_restoView.delivery.map_link);

  const ad_adminView = (await call(`/admin/orders/${ad_orderId}`, { token: aToken })).data.order;
  check('l admin voit la meme adresse figee',
    ad_adminView.delivery && ad_adminView.delivery.one_line.includes('Rue de Fes')
    && ad_adminView.delivery.lat === '34.01');

  const ad_csvText = await (await fetch(`${BASE}/api/admin/orders?format=csv`,
    { headers: { Authorization: `Bearer ${aToken}` } })).text();
  check('l export CSV contient les colonnes d adresse',
    ad_csvText.includes('addr_street') && ad_csvText.includes('addr_lat'));
  check('l export CSV contient l adresse figee', ad_csvText.includes('Rue de Fes'));

  /* ------------------------------------------------------------------
   * Uploads
   * ------------------------------------------------------------------ */
  section('Envoi d images');

  const up_jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
  const up_png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
  const up_html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

  /** Posts one file to /api/upload with whatever token and declared type. */
  const upload = async (token, bytes, type, filename = 'photo.jpg') => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), filename);
    const res = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const up_ok = await upload(r1Token, up_jpeg, 'image/jpeg');
  check('un restaurant peut envoyer une image', up_ok.status === 201,
    `${up_ok.status} ${JSON.stringify(up_ok.data).slice(0, 110)}`);
  check('l url renvoyee est sous /uploads/',
    String(up_ok.data.url || '').startsWith('/uploads/'), String(up_ok.data.url));
  check('le type reconnu est rapporte', up_ok.data.mime === 'image/jpeg');
  check('la taille est rapportee', up_ok.data.bytes === up_jpeg.length);

  const up_served = await fetch(`${BASE}${up_ok.data.url}`);
  check('l image envoyee est servie', up_served.status === 200);
  check('elle est servie avec le bon type',
    String(up_served.headers.get('content-type')).includes('image/jpeg'),
    String(up_served.headers.get('content-type')));

  check('un admin peut envoyer une image',
    (await upload(aToken, up_png, 'image/png', 'logo.png')).status === 201);
  check('un client ne peut pas envoyer d image',
    (await upload(cToken, up_jpeg, 'image/jpeg')).status === 403);
  check('sans jeton, aucun envoi', (await upload(null, up_jpeg, 'image/jpeg')).status === 401);

  const up_bad = await upload(r1Token, up_html, 'image/jpeg', 'evil.jpg');
  check('du HTML deguise en JPEG est refuse', up_bad.status === 400,
    `${up_bad.status} ${JSON.stringify(up_bad.data).slice(0, 90)}`);
  check('le motif du refus est explicite',
    /JPEG|PNG|WebP/i.test(String(up_bad.data.error)), String(up_bad.data.error));
  check('un PDF declare est refuse',
    (await upload(r1Token, up_jpeg, 'application/pdf', 'x.pdf')).status === 400);
  check('un type declare qui ne correspond pas est refuse',
    (await upload(r1Token, up_jpeg, 'image/png', 'x.png')).status === 400);
  check('un fichier vide est refuse',
    (await upload(r1Token, Buffer.alloc(0), 'image/jpeg')).status === 400);

  const up_bigger = Buffer.concat([up_jpeg, Buffer.alloc(6 * 1024 * 1024, 1)]);
  check('un fichier de plus de 5 Mo est refuse',
    (await upload(r1Token, up_bigger, 'image/jpeg')).status === 400);

  const up_notMultipart = await call('/upload', { method: 'POST', token: r1Token, body: { file: 'x' } });
  check('un envoi qui n est pas multipart est refuse', up_notMultipart.status === 400,
    String(up_notMultipart.status));

  const up_limits = await call('/upload/limits');
  check('les limites sont publiques', up_limits.status === 200);
  check('la limite annoncee est de 5 Mo', up_limits.data.max_bytes === 5 * 1024 * 1024);
  check('les trois types sont annonces', (up_limits.data.types || []).length === 3);

  check('un restaurant ne peut pas supprimer un fichier',
    (await call(`/admin/upload?url=${encodeURIComponent(up_ok.data.url)}`,
      { method: 'DELETE', token: r1Token })).status === 403);
  check('un admin peut supprimer un fichier',
    (await call(`/admin/upload?url=${encodeURIComponent(up_ok.data.url)}`,
      { method: 'DELETE', token: aToken })).data.deleted === true);
  check('le fichier supprime n est plus servi',
    (await fetch(`${BASE}${up_ok.data.url}`)).status === 404);
  check('une url hors /uploads/ ne supprime rien',
    (await call('/admin/upload?url=%2Fetc%2Fpasswd', { method: 'DELETE', token: aToken }))
      .data.deleted === false);

  /* ------------------------------------------------------------------
   * Customisation: allergies, extras and removals, all the way through
   * ------------------------------------------------------------------ */
  section('Personnalisation et allergies');

  // A dish of its own, so the rest of the suite cannot disturb it.
  const cz_product = (await call('/restaurant/products', { method: 'POST', token: r1Token, body: {
    category_id: null, name: 'Burger test perso', name_ar: 'برغر', price_cents: 4000,
    description: '', description_ar: '' } })).data.product;
  const cz_extras = (await call('/restaurant/option-groups', { method: 'POST', token: r1Token, body: {
    product_id: cz_product.id, name: 'Suppléments', name_ar: 'إضافات',
    min_select: 0, max_select: 3 } })).data.group;
  const cz_outs = (await call('/restaurant/option-groups', { method: 'POST', token: r1Token, body: {
    product_id: cz_product.id, name: 'Retirer', name_ar: 'حذف',
    min_select: 0, max_select: 1 } })).data.group;
  const cz_cheese = (await call('/restaurant/options', { method: 'POST', token: r1Token, body: {
    option_group_id: cz_extras.id, name: 'Double fromage', name_ar: 'جبن مزدوج',
    price_delta_cents: 500 } })).data.option;
  const cz_onion = (await call('/restaurant/options', { method: 'POST', token: r1Token, body: {
    option_group_id: cz_outs.id, name: 'Sans oignons', name_ar: 'بدون بصل',
    is_removal: true } })).data.option;
  const cz_sauce = (await call('/restaurant/options', { method: 'POST', token: r1Token, body: {
    option_group_id: cz_outs.id, name: 'Sans sauce piquante', name_ar: 'بدون صوص حار',
    is_removal: true } })).data.option;

  const cz_allergy = 'ALLERGIE ARACHIDES - ne pas utiliser d huile de cacahuete';
  const cz_order = await call('/orders', { method: 'POST', token: oToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    special_instructions: cz_allergy,
    items: [{ product_id: cz_product.id, quantity: 2,
      option_ids: [cz_cheese.id, cz_onion.id, cz_sauce.id] }] } });
  check('commande avec personnalisation acceptee', cz_order.status === 201,
    JSON.stringify(cz_order.data).slice(0, 140));
  const cz_id = cz_order.data.order.id;

  // 4000 + 500 for the cheese; the two removals add nothing.
  check('seuls les supplements changent le prix',
    Number(cz_order.data.order.items_subtotal_cents) === (4000 + 500) * 2,
    String(cz_order.data.order.items_subtotal_cents));

  const cz_read = (await call(`/orders/${cz_id}`, { token: oToken })).data.order;
  check('la consigne allergie est gardee', cz_read.special_instructions === cz_allergy,
    String(cz_read.special_instructions).slice(0, 60));
  const cz_opts = cz_read.items[0].options;
  check('les trois options sont figees sur la ligne', cz_opts.length === 3, String(cz_opts.length));
  check('le supplement n est pas marque comme retrait',
    !cz_opts.find((o) => o.name === 'Double fromage').is_removal);
  check('les retraits sont marques comme tels',
    cz_opts.filter((o) => o.is_removal).length === 2,
    cz_opts.map((o) => `${o.name}:${o.is_removal}`).join(','));

  const cz_resto = (await call('/restaurant/orders', { token: r1Token })).data.orders
    .find((o) => o.id === cz_id);
  check('le restaurant lit la consigne allergie',
    cz_resto && cz_resto.special_instructions === cz_allergy);
  check('le restaurant distingue retraits et supplements',
    cz_resto && cz_resto.items[0].options.filter((o) => o.is_removal).length === 2);

  const cz_admin = (await call(`/admin/orders/${cz_id}`, { token: aToken })).data.order;
  check('l admin lit la consigne allergie', cz_admin.special_instructions === cz_allergy);
  check('l admin distingue retraits et supplements',
    cz_admin.items[0].options.filter((o) => o.is_removal).length === 2);

  check('une commande sans consigne garde un champ vide',
    (await call(`/orders/${ad_orderId}`, { token: oToken })).data.order.special_instructions === '');
  check('une consigne trop longue est refusee',
    (await call('/orders', { method: 'POST', token: oToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'pickup',
      special_instructions: 'x'.repeat(501),
      items: [{ product_id: cz_product.id, quantity: 1 }] } })).status === 400);

  // A removal cannot be smuggled in as a discount from another restaurant.
  check('une option d un autre restaurant est refusee',
    (await call('/orders', { method: 'POST', token: oToken, body: {
      restaurant_id: atlas.id, fulfillment_type: 'pickup',
      items: [{ product_id: cz_product.id, quantity: 1, option_ids: [999999] }] } })).status === 400);

  /* ------------------------------------------------------------------
   * Reviews
   * ------------------------------------------------------------------ */
  section('Avis et notes');

  const rv_before = (await call('/restaurants/1/reviews')).data;
  check('les avis sont publics, sans jeton', rv_before.reviews_count >= 0,
    String(rv_before.reviews_count));
  check('la note est un nombre', typeof rv_before.rating === 'number');
  check('la repartition par etoile est fournie',
    Object.keys(rv_before.breakdown || {}).length === 5);

  // A fresh order of our own, carried all the way to completed.
  const rv_order = await call('/orders', { method: 'POST', token: oToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: cz_product.id, quantity: 1 }] } });
  const rv_id = rv_order.data.order.id;

  check('on ne peut pas noter une commande en attente',
    (await call(`/orders/${rv_id}/review`, { method: 'POST', token: oToken,
      body: { rating: 5 } })).status === 409);

  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${rv_id}/status`,
      { method: 'POST', token: r1Token, body: { status, note: '' } });
  }

  const rv_posted = await call(`/orders/${rv_id}/review`, { method: 'POST', token: oToken,
    body: { rating: 5, comment: 'Parfait, rien a redire.' } });
  check('on peut noter une commande terminee', rv_posted.status === 201,
    `${rv_posted.status} ${JSON.stringify(rv_posted.data).slice(0, 110)}`);
  check('la note renvoyee est celle envoyee', rv_posted.data.review.rating === 5);
  check('le nombre d avis du restaurant augmente',
    rv_posted.data.restaurant.reviews_count === rv_before.reviews_count + 1,
    `${rv_before.reviews_count} -> ${rv_posted.data.restaurant.reviews_count}`);

  check('on ne note pas deux fois la meme commande',
    (await call(`/orders/${rv_id}/review`, { method: 'POST', token: oToken,
      body: { rating: 3 } })).status === 409);

  const rv_after = (await call('/restaurants/1/reviews')).data;
  check('l avis apparait dans la liste publique',
    rv_after.reviews.some((r) => r.comment === 'Parfait, rien a redire.'));
  check('le compte public a augmente', rv_after.reviews_count === rv_before.reviews_count + 1);
  check('la moyenne est recalculee',
    Math.abs(rv_after.rating - rv_after.reviews.length ? 1 : 1) >= 0
    && rv_after.rating > 0 && rv_after.rating <= 5, String(rv_after.rating));
  check('le nom complet du client n est pas publie',
    rv_after.reviews.every((r) => !String(r.author).includes('Autre ')),
    rv_after.reviews.map((r) => r.author).join(','));
  check('l auteur est abrege',
    rv_after.reviews.some((r) => /^[^ ]+( [A-Z]\.)?$/.test(r.author)),
    rv_after.reviews.map((r) => r.author).join(','));
  check('la liste publique ne donne aucun identifiant de client',
    !JSON.stringify(rv_after).includes('customer_id'));

  // The restaurant card must carry the same numbers as the reviews endpoint.
  const rv_card = (await call('/restaurants')).data.restaurants.find((r) => r.id === atlas.id);
  check('la carte du restaurant porte le meme nombre d avis',
    Number(rv_card.reviews_count) === rv_after.reviews_count,
    `${rv_card.reviews_count} vs ${rv_after.reviews_count}`);
  check('la carte du restaurant porte la meme note',
    Math.abs(Number(rv_card.rating) - rv_after.rating) < 0.001,
    `${rv_card.rating} vs ${rv_after.rating}`);

  // --- what is refused ---
  const rv_order2 = await call('/orders', { method: 'POST', token: oToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: cz_product.id, quantity: 1 }] } });
  const rv_id2 = rv_order2.data.order.id;
  for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
    await call(`/restaurant/orders/${rv_id2}/status`,
      { method: 'POST', token: r1Token, body: { status, note: '' } });
  }
  for (const [label, rating] of [['0 etoile', 0], ['6 etoiles', 6], ['note negative', -2],
    ['note decimale', 3.5], ['note vide', '']]) {
    check(`refus: ${label}`,
      (await call(`/orders/${rv_id2}/review`, { method: 'POST', token: oToken,
        body: { rating } })).status === 400, String(rating));
  }
  check('refus: commentaire trop long',
    (await call(`/orders/${rv_id2}/review`, { method: 'POST', token: oToken,
      body: { rating: 4, comment: 'x'.repeat(1001) } })).status === 400);
  check('un autre client ne peut pas noter ma commande',
    (await call(`/orders/${rv_id2}/review`, { method: 'POST', token: cToken,
      body: { rating: 1 } })).status === 404);
  check('un restaurant ne peut pas noter',
    (await call(`/orders/${rv_id2}/review`, { method: 'POST', token: r1Token,
      body: { rating: 5 } })).status === 403);
  check('sans jeton, aucune note',
    (await call(`/orders/${rv_id2}/review`, { method: 'POST', body: { rating: 5 } })).status === 401);
  check('une commande inexistante ne peut pas etre notee',
    (await call('/orders/99999999/review', { method: 'POST', token: oToken,
      body: { rating: 5 } })).status === 404);
  check('les avis d un restaurant inconnu sont introuvables',
    (await call('/restaurants/99999999/reviews')).status === 404);

  // --- what is left to rate ---
  const rv_todo = await call('/me/reviewable', { token: oToken });
  check('les commandes a noter sont listees', rv_todo.status === 200);
  check('la commande deja notee n y est plus',
    !(rv_todo.data.orders || []).some((o) => o.id === rv_id),
    (rv_todo.data.orders || []).map((o) => o.id).join(','));
  check('la commande non notee y est',
    (rv_todo.data.orders || []).some((o) => o.id === rv_id2));

  // --- the admin can remove one, and the average follows ---
  const rv_toRemove = (await call('/restaurants/1/reviews')).data.reviews[0];
  const rv_countBefore = (await call('/restaurants/1/reviews')).data.reviews_count;
  check('un restaurant ne peut pas supprimer un avis',
    (await call(`/admin/reviews/${rv_toRemove.id}`, { method: 'DELETE', token: r1Token })).status === 403);
  check('un admin peut supprimer un avis',
    (await call(`/admin/reviews/${rv_toRemove.id}`, { method: 'DELETE', token: aToken }))
      .data.deleted === true);
  const rv_final = (await call('/restaurants/1/reviews')).data;
  check('la suppression fait baisser le compte',
    rv_final.reviews_count === rv_countBefore - 1,
    `${rv_countBefore} -> ${rv_final.reviews_count}`);
  check('la moyenne est recalculee apres suppression',
    rv_final.rating >= 0 && rv_final.rating <= 5, String(rv_final.rating));
  check('un avis inexistant ne peut pas etre supprime',
    (await call('/admin/reviews/99999999', { method: 'DELETE', token: aToken })).status === 404);

  // --- the arithmetic itself ---
  const rv_math = (await call('/restaurants/1/reviews?limit=100')).data;
  const rv_sum = rv_math.reviews.reduce((total, r) => total + r.rating, 0);
  const rv_expected = rv_math.reviews.length ? rv_sum / rv_math.reviews.length : 0;
  check('la moyenne annoncee est bien la moyenne des avis',
    rv_math.reviews.length === rv_math.reviews_count
      && Math.abs(rv_math.rating - rv_expected) < 0.0002,
    `${rv_math.rating} vs ${rv_expected.toFixed(4)}`);


  // --- limits ---
  const ad_pickupOrder = await call('/orders', { method: 'POST', token: oToken, body: {
    restaurant_id: atlas.id, fulfillment_type: 'pickup',
    items: [{ product_id: tacos.id, quantity: 1, option_ids: [sizeM.id] }] } });
  check('une commande a emporter n a pas d adresse figee',
    ad_pickupOrder.data.order.delivery === null, JSON.stringify(ad_pickupOrder.data.order.delivery));

  section('Erreurs');
  check('endpoint inconnu -> 404', (await call('/nexistepas')).status === 404);
  check('methode non autorisee -> 405', (await call('/restaurants', { method: 'DELETE' })).status === 405);
  check('JSON invalide -> 400', (await (async () => {
    const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{pas du json' });
    return { status: res.status };
  })()).status === 400);

  console.log(`\n${'-'.repeat(50)}`);
  console.log(`  ${pass} tests reussis, ${fail} echecs`);
  if (failures.length) console.log(`  Echecs: ${failures.join(' | ')}`);
  console.log(`${'-'.repeat(50)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('Erreur du test:', err); process.exit(1); });
