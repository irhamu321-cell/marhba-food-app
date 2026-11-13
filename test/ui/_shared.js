/*
 * Helpers shared by the browser suites.
 *
 * Named with a leading underscore so run-all.js does not try to run this file
 * as a suite of its own.
 */

/**
 * Clears the address screen that now stands in front of the restaurant list.
 *
 * A new visitor is asked where they live before any restaurant is shown, so a
 * suite that only wants the list has to get past it. The screen offers a
 * "browse without an address" button and that is what a real customer in a
 * hurry would tap, so that is what this does.
 *
 * Returns true if the screen was there and was dismissed, false if it never
 * appeared — a suite that has already saved an address will see no screen,
 * and that is not a failure.
 */
async function dismissAddressGate(page, { timeout = 3000 } = {}) {
  const skip = page.locator('#gateSkip');
  try {
    await skip.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }
  await skip.click();
  await page.waitForSelector('#gateSkip', { state: 'hidden', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  return true;
}

/**
 * Goes to the customer app and lands on the restaurant list.
 *
 * Every suite that used to call page.goto('/') and wait for a card needs this
 * instead, because of the screen above.
 */
async function openCustomerApp(page, { base = 'http://localhost:3000/' } = {}) {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await dismissAddressGate(page);
}

/**
 * A complete, valid address body, for suites that need a delivery to exist.
 *
 * The pin is in Rabat. Callers override whatever they need.
 */
const addressBody = (over = {}) => ({
  label: 'home',
  recipient_name: 'Client Test',
  recipient_phone: '0661234567',
  city: 'Rabat',
  street: 'Avenue Hassan II, n 12',
  building: 'Res. Al Amal, imm. B',
  floor: '3e etage, appt 7',
  landmark: 'En face de la pharmacie',
  instructions: 'Sonner deux fois',
  lat: 34.020882,
  lng: -6.84165,
  ...over,
});

/** Saves an address straight through the API, for the customer holding `token`. */
async function saveAddress(token, over = {}) {
  const res = await fetch('http://localhost:3000/api/me/addresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(addressBody(over)),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`adresse refusee: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Logs in through the API and returns the token. */
async function apiLogin(identifier, password) {
  const res = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`connexion refusee: ${JSON.stringify(data).slice(0, 120)}`);
  return data.token;
}


/*
 * Creates a brand new customer and returns { phone, password, token }.
 *
 * Sign-up needs a verification code, which is read back from the admin
 * console exactly as an operator would read it during the pilot. A suite that
 * makes its own customer cannot be disturbed by addresses another suite left
 * behind on the demo account.
 */
async function createCustomer(prefix = '68') {
  const stamp = String(Date.now()).slice(-7);
  const phone = `0${prefix}${stamp}`;
  const password = 'motdepasse1';

  const asked = await fetch('http://localhost:3000/api/auth/request-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!asked.ok) throw new Error(`code refuse: ${asked.status} ${await asked.text()}`);

  const admin = await apiLogin('0600000000', 'admin1234');
  const live = await (await fetch('http://localhost:3000/api/admin/auth-codes', {
    headers: { Authorization: `Bearer ${admin}` },
  })).json();
  const entry = (live.codes || []).find((c) => c.destination === phone && c.purpose === 'register');
  if (!entry) throw new Error(`code introuvable pour ${phone}`);

  const res = await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Client Adresse', phone, password, code: entry.code }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`inscription refusee: ${JSON.stringify(data).slice(0, 140)}`);
  return { phone, password, token: data.token };
}

/**
 * A stand-in for Leaflet, installed before the page scripts run.
 *
 * The real library comes from a CDN that this machine cannot reach, and the
 * tile server is just as unreachable, so loading it here would prove nothing
 * and would take eight seconds to fail. The app checks for window.L first and
 * fetches nothing when it is already there, which is what makes this possible.
 *
 * The stub records what the app asked for and exposes window.__map so a test
 * can drag the pin or tap the map and watch the app react.
 */
const LEAFLET_STUB = () => {
  const handlers = { map: {}, marker: {} };
  const state = { centre: null, zoom: null, pin: null, tiles: null, draggable: null, invalidated: 0 };

  const marker = {
    addTo: () => marker,
    on: (event, fn) => { handlers.marker[event] = fn; return marker; },
    setLatLng: (ll) => { state.pin = Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll; return marker; },
    getLatLng: () => state.pin,
  };
  const map = {
    setView: (ll, z) => { state.centre = { lat: ll[0], lng: ll[1] }; state.zoom = z; return map; },
    on: (event, fn) => { handlers.map[event] = fn; return map; },
    invalidateSize: () => { state.invalidated += 1; },
  };

  window.L = {
    map: () => map,
    tileLayer: (url) => { state.tiles = url; return { addTo: () => ({}) }; },
    marker: (ll, opts) => {
      state.pin = { lat: ll[0], lng: ll[1] };
      state.draggable = !!(opts && opts.draggable);
      return marker;
    },
  };

  window.__map = {
    state,
    /** Pretends the customer dragged the pin and let go. */
    drag(lat, lng) {
      state.pin = { lat, lng };
      handlers.marker.drag && handlers.marker.drag();
      handlers.marker.dragend && handlers.marker.dragend();
    },
    /** Pretends the customer tapped the map somewhere else. */
    tap(lat, lng) {
      handlers.map.click && handlers.map.click({ latlng: { lat, lng } });
    },
    has: (what) => Object.prototype.hasOwnProperty.call(handlers[what.split('.')[0]], what.split('.')[1]),
  };
};

/** Installs the Leaflet stand-in in a page before any of its scripts run. */
const stubLeaflet = (page) => page.addInitScript(LEAFLET_STUB);

/**
 * Makes navigator.geolocation answer once, from a fixed point, and count calls.
 *
 * window.__geo.calls proves the app asked exactly once, and
 * window.__geo.watches proves it never started a continuous watch.
 */
const stubGeolocation = (page, { lat = 33.5731, lng = -7.5898, accuracy = 25 } = {}) =>
  page.addInitScript(([la, ln, acc]) => {
    window.__geo = { calls: 0, watches: 0 };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok) => {
          window.__geo.calls += 1;
          setTimeout(() => ok({ coords: { latitude: la, longitude: ln, accuracy: acc } }), 30);
        },
        watchPosition: () => { window.__geo.watches += 1; return 1; },
        clearWatch: () => {},
      },
    });
  }, [lat, lng, accuracy]);

/** Makes geolocation refuse, the way a customer who taps "Block" would. */
const stubGeolocationDenied = (page) =>
  page.addInitScript(() => {
    window.__geo = { calls: 0, watches: 0 };
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok, err) => {
          window.__geo.calls += 1;
          setTimeout(() => err({ code: 1, message: 'refus' }), 30);
        },
        watchPosition: () => { window.__geo.watches += 1; return 1; },
        clearWatch: () => {},
      },
    });
  });

/*
 * Creates a brand new restaurant, approved and ready, and returns
 * { phone, password, token, restaurantId, name }.
 *
 * Signing up goes through the same verification code a real owner would get,
 * then an admin approves it — which is also the only way to end up with a
 * restaurant that has no reviews, no orders and no history.
 */
async function createRestaurant(prefix = '64') {
  const stamp = String(Date.now()).slice(-7);
  const phone = `0${prefix}${stamp}`;
  const password = 'motdepasse1';
  const name = `Resto test ${stamp}`;

  const asked = await fetch('http://localhost:3000/api/auth/request-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!asked.ok) throw new Error(`code refuse: ${asked.status}`);

  const admin = await apiLogin('0600000000', 'admin1234');
  const live = await (await fetch('http://localhost:3000/api/admin/auth-codes', {
    headers: { Authorization: `Bearer ${admin}` },
  })).json();
  const entry = (live.codes || []).find((c) => c.destination === phone && c.purpose === 'register');
  if (!entry) throw new Error(`code introuvable pour ${phone}`);

  const registered = await (await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `Proprietaire ${stamp}`, phone, password, code: entry.code,
      role: 'restaurant', restaurant_name: name,
    }),
  })).json();
  if (!registered.token) {
    throw new Error(`inscription refusee: ${JSON.stringify(registered).slice(0, 140)}`);
  }

  const pending = await (await fetch('http://localhost:3000/api/admin/restaurants', {
    headers: { Authorization: `Bearer ${admin}` },
  })).json();
  const mine = (pending.restaurants || []).find((r) => r.name === name);
  if (!mine) throw new Error(`restaurant introuvable: ${name}`);

  await fetch(`http://localhost:3000/api/admin/restaurants/${mine.id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
    body: JSON.stringify({ status: 'approved' }),
  });

  return { phone, password, token: registered.token, restaurantId: mine.id, name };
}

module.exports = {
  dismissAddressGate, openCustomerApp, addressBody, saveAddress, apiLogin,
  createCustomer, createRestaurant, stubLeaflet, stubGeolocation, stubGeolocationDenied,
};
