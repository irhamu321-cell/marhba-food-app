/*
 * Delivery addresses on the customer side: the first-run address screen, the
 * address book, the "use my location" button and the map picker.
 *
 * Three rules shape this file.
 *
 * 1. Nothing here blocks on the map. Leaflet comes from a CDN, and a phone on
 *    a weak connection in Morocco will sometimes not get it. Every screen has
 *    a path that works with no map at all, so a customer is never stuck
 *    looking at a blank square.
 * 2. Location is read once, on a tap, never watched.
 * 3. Written details are required even with a pin, because a pin is often
 *    tens of metres out and many streets are not mapped at building level.
 */
import { api, esc, toast, getToken } from './api.js';
import { t, lang } from './i18n.js';

const SELECTED_KEY = 'food_app_address';
const DRAFT_KEY = 'food_app_address_draft';
const $ = (id) => document.getElementById(id);

/* Casablanca city centre: where the map opens when there is nothing better. */
const FALLBACK_CENTRE = { lat: 33.5731, lng: -7.5898 };

export const MOROCCAN_CITIES = [
  'Casablanca', 'Rabat', 'Marrakech', 'Fès', 'Tanger', 'Agadir', 'Meknès',
  'Oujda', 'Kénitra', 'Tétouan', 'Salé', 'Safi', 'Mohammedia', 'El Jadida',
  'Béni Mellal', 'Nador', 'Khouribga', 'Settat', 'Essaouira', 'Ouarzazate',
];

export const addressState = {
  list: [],
  selectedId: Number(localStorage.getItem(SELECTED_KEY)) || null,
  loaded: false,
};

/* ---------------- data ---------------- */

export async function loadAddresses() {
  try {
    const { addresses } = await api('/me/addresses');
    addressState.list = addresses;
    addressState.loaded = true;
    const stillThere = addresses.some((a) => a.id === addressState.selectedId);
    if (!stillThere) {
      const fallback = addresses.find((a) => a.is_default) || addresses[0];
      setSelected(fallback ? fallback.id : null);
    }
  } catch {
    // Signed out, or offline. The caller decides what to show.
    addressState.list = [];
    addressState.loaded = false;
  }
  return addressState.list;
}

export function setSelected(id) {
  addressState.selectedId = id || null;
  if (id) localStorage.setItem(SELECTED_KEY, String(id));
  else localStorage.removeItem(SELECTED_KEY);
}

export const selectedAddress = () =>
  addressState.list.find((a) => a.id === addressState.selectedId) || null;

export const hasAddresses = () => addressState.list.length > 0;

/*
 * Does this address carry a usable map pin?
 *
 * The server decides this for real, in server/src/addresses.js, and refuses a
 * delivery without it. This copy exists only so the browser can label an
 * address "no pin yet" before anything is sent, and it deliberately applies
 * the same range check rather than a looser one, so the badge never promises
 * something checkout will reject.
 */
export function hasValidPin(address) {
  if (!address) return false;
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  if (String(address.lat ?? '').trim() === '' || String(address.lng ?? '').trim() === '') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/* ---------------- the draft address ---------------- */

/*
 * A visitor who has not signed in yet still gets asked where they are, because
 * that is the question that makes the restaurant list mean anything. There is
 * no account to attach it to, so it is kept here, in this browser only, and
 * written to the account the moment they sign in.
 *
 * It is never used to place an order: checkout sends an address_id, and the
 * server only accepts one of the customer's own saved rows. So a draft can
 * shape what the home screen shows and nothing more.
 */
export function readDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return raw && raw.city && raw.street ? raw : null;
  } catch { return null; }
}

export const saveDraft = (address) => localStorage.setItem(DRAFT_KEY, JSON.stringify(address));
export const clearDraft = () => localStorage.removeItem(DRAFT_KEY);

/** Same shape as a saved row, so the banner and the area warning can share code. */
export function draftAsAddress() {
  const draft = readDraft();
  if (!draft) return null;
  return {
    ...draft,
    id: 0,
    is_default: false,
    has_pin: hasValidPin(draft),
    one_line: [draft.street, draft.building, draft.floor, draft.landmark, draft.city]
      .filter(Boolean).join(', '),
    block: [draft.street, [draft.building, draft.floor].filter(Boolean).join(' \u00b7 '),
      draft.landmark, draft.city].filter(Boolean),
    label_text: { home: 'Maison', work: 'Travail', other: draft.label_custom || 'Autre' }[draft.label] || 'Maison',
    label_text_ar: { home: '\u0627\u0644\u0645\u0646\u0632\u0644', work: '\u0627\u0644\u0639\u0645\u0644',
      other: draft.label_custom || '\u0622\u062e\u0631' }[draft.label] || '\u0627\u0644\u0645\u0646\u0632\u0644',
    draft: true,
  };
}

/** The address the home screen should show: a saved one, else the draft. */
export const activeAddress = () => selectedAddress() || draftAsAddress();

/**
 * Writes a draft to the account after a sign-in.
 *
 * Returns true when it landed. A rejection is kept, not thrown away: the
 * draft stays in place so the customer can correct it in "my addresses".
 */
export async function promoteDraft() {
  const draft = readDraft();
  if (!draft) return false;
  try {
    const result = await api('/me/addresses', { method: 'POST', body: { ...draft, is_default: true } });
    addressState.list = result.addresses;
    addressState.loaded = true;
    setSelected(result.address_id);
    clearDraft();
    return true;
  } catch {
    return false;
  }
}

/** The label a chip shows, in the current language. */
export const chipLabel = (address) =>
  !address ? '' : (lang === 'ar' ? address.label_text_ar : address.label_text);

/*
 * Same city or not. The pilot has no delivery zones, so this is the only
 * honest signal available: a restaurant in Rabat is probably not delivering
 * to Marrakech. Accents and case are ignored because both sides are typed by
 * hand. Restaurants are never hidden on the strength of this — it only puts a
 * warning on the card.
 */
const flatten = (value) => String(value || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .trim().toLowerCase();

export function outsideDeliveryArea(resto, address) {
  if (!resto || !address) return false;
  if (!resto.city || !address.city) return false;
  return flatten(resto.city) !== flatten(address.city);
}

/* ---------------- Leaflet, loaded only when a map is opened ---------------- */

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LOAD_TIMEOUT_MS = 8000;

let leafletPromise = null;

/**
 * Resolves with window.L, or rejects if it cannot be had.
 *
 * Only ever attempted when the customer opens a map, so no one pays for the
 * download who is typing their address by hand. A test, or a future offline
 * build, can set window.L beforehand and nothing is fetched at all.
 */
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;

  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
      leafletPromise = null;
    }, LOAD_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      window.L ? resolve(window.L) : reject(new Error('no-global'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      leafletPromise = null;
      reject(new Error('offline'));
    };
    document.head.appendChild(script);
  });
  return leafletPromise;
}

/* ---------------- one tap, one reading ---------------- */

/**
 * Asks the browser for the current position exactly once.
 *
 * The permission prompt appears here and nowhere else, because this is only
 * ever called from a tap on the button. No watchPosition: the app has no use
 * for a moving customer, and a watch left running drains a battery and keeps
 * reporting a location long after the address has been saved.
 */
export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  });
}

const geoMessage = (err) => {
  if (err && err.code === 1) return t('addr.geoDenied');
  if (err && err.code === 3) return t('addr.geoTimeout');
  return t('addr.geoFailed');
};

/* ---------------- the map picker ---------------- */

/*
 * A full-screen pin picker.
 *
 * Resolves with { lat, lng } once the customer confirms, or null if they back
 * out. If Leaflet cannot be loaded the same dialog appears without the map: the
 * coordinates are shown as two fields, so a customer who used the location
 * button can still confirm what the GPS gave, and anyone else can still get to
 * the written address form.
 */
export function openMapPicker({ lat, lng } = {}) {
  return new Promise((resolve) => {
    let pin = {
      lat: Number(lat) || FALLBACK_CENTRE.lat,
      lng: Number(lng) || FALLBACK_CENTRE.lng,
    };
    const hadStartingPoint = Boolean(lat && lng);

    const overlay = document.createElement('div');
    overlay.className = 'map-sheet';
    overlay.id = 'mapSheet';
    overlay.innerHTML = `
      <div class="map-sheet-head">
        <button class="ghost small" id="mapCancel">${esc(t('common.cancel'))}</button>
        <strong>${esc(t('addr.pickOnMap'))}</strong>
        <span></span>
      </div>
      <div class="map-sheet-body">
        <div id="mapCanvas" class="map-canvas"></div>
        <div id="mapFallback" class="map-fallback hidden">
          <div class="alert warn"><span class="ic">🗺️</span><div>${esc(t('addr.mapUnavailable'))}</div></div>
          <label>${esc(t('addr.lat'))}</label>
          <input id="mapLat" inputmode="decimal" value="${esc(String(pin.lat))}">
          <label>${esc(t('addr.lng'))}</label>
          <input id="mapLng" inputmode="decimal" value="${esc(String(pin.lng))}">
        </div>
      </div>
      <div class="map-sheet-foot">
        <button class="ghost" id="mapLocate">📍 ${esc(t('addr.useLocation'))}</button>
        <div class="small muted" id="mapCoords">${esc(t('addr.coords'))}: ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}</div>
        <button class="primary lg" id="mapConfirm" style="width:100%">${esc(t('addr.confirmPoint'))}</button>
        <div class="small muted" style="text-align:center">${esc(t('addr.dragHint'))}</div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');

    const showCoords = () => {
      $('mapCoords').textContent = `${t('addr.coords')}: ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
      if ($('mapLat')) { $('mapLat').value = String(pin.lat); $('mapLng').value = String(pin.lng); }
    };

    const close = (value) => {
      document.body.classList.remove('no-scroll');
      overlay.remove();
      resolve(value);
    };

    let map = null;
    let marker = null;

    const movePin = (next) => {
      pin = { lat: Number(next.lat), lng: Number(next.lng) };
      showCoords();
      if (marker) marker.setLatLng([pin.lat, pin.lng]);
    };

    // Typed coordinates, when there is no map to drag.
    const readFields = () => {
      const typedLat = Number($('mapLat')?.value);
      const typedLng = Number($('mapLng')?.value);
      if (Number.isFinite(typedLat) && Number.isFinite(typedLng)
        && typedLat >= -90 && typedLat <= 90 && typedLng >= -180 && typedLng <= 180) {
        pin = { lat: typedLat, lng: typedLng };
        return true;
      }
      return false;
    };

    const useFallback = () => {
      $('mapCanvas').classList.add('hidden');
      $('mapFallback').classList.remove('hidden');
    };

    loadLeaflet().then((L) => {
      map = L.map('mapCanvas', { zoomControl: true })
        .setView([pin.lat, pin.lng], hadStartingPoint ? 17 : 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(map);

      marker = L.marker([pin.lat, pin.lng], { draggable: true }).addTo(map);
      // dragend carries the final position; drag fires continuously and is
      // only used to keep the coordinate line in step with the finger.
      marker.on('drag', () => movePin(marker.getLatLng()));
      marker.on('dragend', () => movePin(marker.getLatLng()));
      map.on('click', (e) => movePin(e.latlng));
      // A map created inside a sheet that was just inserted measures itself
      // before the layout settles, and draws a quarter of a map.
      setTimeout(() => map.invalidateSize && map.invalidateSize(), 60);
    }).catch(useFallback);

    $('mapCancel').onclick = () => close(null);
    $('mapConfirm').onclick = () => {
      if ($('mapFallback') && !$('mapFallback').classList.contains('hidden') && !readFields()) {
        return toast(t('addr.badCoords'), true);
      }
      close({ lat: pin.lat, lng: pin.lng });
    };
    $('mapLocate').onclick = async () => {
      const button = $('mapLocate');
      button.disabled = true;
      button.textContent = t('addr.locating');
      try {
        const where = await currentPosition();
        movePin(where);
        if (map) map.setView([where.lat, where.lng], 17);
      } catch (e) {
        toast(geoMessage(e), true);
      }
      button.disabled = false;
      button.textContent = `📍 ${t('addr.useLocation')}`;
    };
  });
}

/* ---------------- the written address form ---------------- */

/*
 * Asks for the details a courier actually needs, with the pin already chosen.
 *
 * Resolves with the saved address list, or null if the customer backs out.
 * `existing` switches it to editing, keeping the same fields so there is only
 * one form to maintain and one place where the rules live.
 */
export function openAddressForm({ pin, existing = null } = {}) {
  return new Promise((resolve) => {
    const a = existing || {};
    const coords = {
      lat: pin?.lat ?? a.lat ?? '',
      lng: pin?.lng ?? a.lng ?? '',
    };

    const overlay = document.createElement('div');
    overlay.className = 'map-sheet';
    overlay.id = 'addrSheet';
    overlay.innerHTML = `
      <div class="map-sheet-head">
        <button class="ghost small" id="afCancel">${esc(t('common.cancel'))}</button>
        <strong>${esc(existing ? t('addr.editTitle') : t('addr.newTitle'))}</strong>
        <span></span>
      </div>
      <div class="map-sheet-body scrollable">
        <div class="card">
          <label>${esc(t('addr.label'))}</label>
          <div class="row wrap" id="afLabels">
            ${[['home', '🏠'], ['work', '💼'], ['other', '📍']].map(([key, icon]) => `
              <button class="chip ${(a.label || 'home') === key ? 'active' : ''}" data-label="${key}">
                ${icon} ${esc(t(`addr.label.${key}`))}</button>`).join('')}
          </div>
          <div id="afCustomWrap" class="${(a.label === 'other') ? '' : 'hidden'}">
            <label>${esc(t('addr.labelCustom'))}</label>
            <input id="afCustom" maxlength="40" value="${esc(a.label_custom || '')}"
                   placeholder="${esc(t('addr.labelCustomPlaceholder'))}">
          </div>

          <label>${esc(t('addr.recipient'))} *</label>
          <input id="afName" maxlength="120" value="${esc(a.recipient_name || '')}">
          <label>${esc(t('addr.phone'))} *</label>
          <input id="afPhone" maxlength="30" inputmode="tel" value="${esc(a.recipient_phone || '')}"
                 placeholder="06…">

          <label>${esc(t('addr.city'))} *</label>
          <input id="afCity" maxlength="80" list="cityList" value="${esc(a.city || '')}">
          <datalist id="cityList">${MOROCCAN_CITIES.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>

          <label>${esc(t('addr.street'))} *</label>
          <input id="afStreet" maxlength="200" value="${esc(a.street || '')}"
                 placeholder="${esc(t('addr.streetPlaceholder'))}">
          <label>${esc(t('addr.building'))}</label>
          <input id="afBuilding" maxlength="80" value="${esc(a.building || '')}"
                 placeholder="${esc(t('addr.buildingPlaceholder'))}">
          <label>${esc(t('addr.floor'))}</label>
          <input id="afFloor" maxlength="80" value="${esc(a.floor || '')}"
                 placeholder="${esc(t('addr.floorPlaceholder'))}">
          <label>${esc(t('addr.landmark'))}</label>
          <input id="afLandmark" maxlength="160" value="${esc(a.landmark || '')}"
                 placeholder="${esc(t('addr.landmarkPlaceholder'))}">
          <label>${esc(t('addr.instructions'))}</label>
          <input id="afInstructions" maxlength="300" value="${esc(a.instructions || '')}"
                 placeholder="${esc(t('addr.instructionsPlaceholder'))}">

          <div class="pin-row mt" id="afPinRow">
            <div class="grow small">
              <strong>${esc(t('addr.pin'))}</strong>
              <div class="muted" id="afPinText">${coords.lat
                ? `${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`
                : esc(t('addr.noPin'))}</div>
            </div>
            <button class="ghost small" id="afPinBtn">${esc(coords.lat ? t('addr.changePin') : t('addr.addPin'))}</button>
          </div>

          <label class="row small mt" style="gap:6px;margin:12px 0 0">
            <input type="checkbox" id="afDefault" style="width:auto"
              ${(a.is_default || !hasAddresses()) ? 'checked' : ''}> ${esc(t('addr.makeDefault'))}
          </label>

          <div class="small muted mt">${esc(t('addr.privacyNote'))}</div>
          <button class="primary lg mt" id="afSave" style="width:100%">${esc(t('addr.save'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');

    const close = (value) => {
      document.body.classList.remove('no-scroll');
      overlay.remove();
      resolve(value);
    };

    let chosenLabel = a.label || 'home';
    overlay.querySelectorAll('[data-label]').forEach((button) => {
      button.onclick = () => {
        chosenLabel = button.dataset.label;
        overlay.querySelectorAll('[data-label]').forEach((b) =>
          b.classList.toggle('active', b.dataset.label === chosenLabel));
        $('afCustomWrap').classList.toggle('hidden', chosenLabel !== 'other');
      };
    });

    $('afPinBtn').onclick = async () => {
      const picked = await openMapPicker({ lat: coords.lat, lng: coords.lng });
      if (!picked) return;
      coords.lat = picked.lat;
      coords.lng = picked.lng;
      $('afPinText').textContent = `${picked.lat.toFixed(5)}, ${picked.lng.toFixed(5)}`;
      $('afPinBtn').textContent = t('addr.changePin');
    };

    $('afCancel').onclick = () => close(null);

    $('afSave').onclick = async () => {
      if (!coords.lat || !coords.lng) return toast(t('addr.pinRequired'), true);
      const body = {
        label: chosenLabel,
        label_custom: $('afCustom')?.value || '',
        recipient_name: $('afName').value,
        recipient_phone: $('afPhone').value,
        city: $('afCity').value,
        street: $('afStreet').value,
        building: $('afBuilding').value,
        floor: $('afFloor').value,
        landmark: $('afLandmark').value,
        instructions: $('afInstructions').value,
        lat: coords.lat,
        lng: coords.lng,
        is_default: $('afDefault').checked,
      };
      const button = $('afSave');
      button.disabled = true;
      button.textContent = t('addr.saving');

      // No account yet: keep it in this browser and carry on. It is written
      // to the account at the next sign-in, by promoteDraft().
      if (!getToken()) {
        saveDraft(body);
        toast(t('addr.savedLocal'));
        return close([]);
      }

      try {
        const result = existing
          ? await api(`/me/addresses/${existing.id}`, { method: 'PUT', body })
          : await api('/me/addresses', { method: 'POST', body });
        addressState.list = result.addresses;
        addressState.loaded = true;
        const target = result.address_id || existing?.id;
        if (target && (body.is_default || !addressState.selectedId)) setSelected(target);
        else if (target && existing) setSelected(existing.id);
        toast(t('addr.saved'));
        close(result.addresses);
      } catch (e) {
        toast(e.message, true);
        button.disabled = false;
        button.textContent = t('addr.save');
      }
    };
  });
}

/* ---------------- flows ---------------- */

/** Location button → map centred on the reading → written details. */
export async function addFromCurrentLocation(button) {
  const original = button ? button.innerHTML : '';
  if (button) { button.disabled = true; button.textContent = t('addr.locating'); }
  let where = null;
  try {
    where = await currentPosition();
  } catch (e) {
    toast(geoMessage(e), true);
  }
  if (button) { button.disabled = false; button.innerHTML = original; }

  // A refusal is not a dead end: the map still opens, on the city centre.
  const picked = await openMapPicker(where || {});
  if (!picked) return null;
  return openAddressForm({ pin: picked });
}

/** Map button → map, no location reading at all. */
export async function addFromMap() {
  const picked = await openMapPicker({});
  if (!picked) return null;
  return openAddressForm({ pin: picked });
}

/** Manual button → the written form first, pin chosen inside it. */
export const addManually = () => openAddressForm({});

export async function editAddress(address) {
  return openAddressForm({ existing: address });
}

export async function deleteAddress(address) {
  if (!window.confirm(t('addr.confirmDelete', { label: chipLabel(address) }))) return null;
  try {
    const { addresses } = await api(`/me/addresses/${address.id}`, { method: 'DELETE' });
    addressState.list = addresses;
    if (addressState.selectedId === address.id) {
      const next = addresses.find((x) => x.is_default) || addresses[0];
      setSelected(next ? next.id : null);
    }
    toast(t('addr.deleted'));
    return addresses;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

export async function makeAddressDefault(address) {
  try {
    const { addresses } = await api(`/me/addresses/${address.id}/default`, { method: 'POST' });
    addressState.list = addresses;
    setSelected(address.id);
    toast(t('addr.defaultSet'));
    return addresses;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/* ---------------- rendering helpers ---------------- */

/** One saved address as a card, with its actions. Used by the book and checkout. */
export function addressCard(address, { selectable = false, actions = true } = {}) {
  const selected = selectable && address.id === addressState.selectedId;
  return `
    <div class="addr-card ${selected ? 'on' : ''}" data-addr="${address.id}">
      <div class="row" style="align-items:flex-start;gap:10px">
        ${selectable ? `<input type="radio" name="addrPick" value="${address.id}"
          ${selected ? 'checked' : ''} style="width:auto;margin-top:3px" data-pick="${address.id}">` : ''}
        <div class="grow">
          <div class="row" style="gap:6px;margin:0">
            <strong>${esc(chipLabel(address))}</strong>
            ${address.is_default ? `<span class="badge green">${esc(t('addr.default'))}</span>` : ''}
            ${address.has_pin ? '' : `<span class="badge amber">${esc(t('addr.noPin'))}</span>`}
          </div>
          <div class="small">${esc(address.recipient_name)} · ${esc(address.recipient_phone)}</div>
          ${address.block.map((line) => `<div class="small muted">${esc(line)}</div>`).join('')}
        </div>
      </div>
      ${actions ? `<div class="row wrap" style="gap:6px;margin-top:8px">
        <button class="ghost small" data-edit="${address.id}">${esc(t('common.edit'))}</button>
        ${address.is_default ? '' : `<button class="ghost small" data-default="${address.id}">${esc(t('addr.setDefault'))}</button>`}
        ${address.map_link ? `<a class="ghost small btn-like" href="${esc(address.map_link)}"
          target="_blank" rel="noopener noreferrer">${esc(t('addr.openMap'))}</a>` : ''}
        <button class="ghost small danger" data-del="${address.id}">${esc(t('common.delete'))}</button>
      </div>` : ''}
    </div>`;
}

/**
 * Wires the buttons inside a container that has address cards in it.
 * `after` is called whenever the list changed, so the caller can redraw.
 */
export function wireAddressCards(container, after) {
  const root = container || document;
  root.querySelectorAll('[data-pick]').forEach((input) => {
    input.onchange = () => { setSelected(Number(input.dataset.pick)); after && after(); };
  });
  root.querySelectorAll('[data-edit]').forEach((button) => {
    button.onclick = async () => {
      const address = addressState.list.find((a) => a.id === Number(button.dataset.edit));
      if (address && await editAddress(address)) after && after();
    };
  });
  root.querySelectorAll('[data-default]').forEach((button) => {
    button.onclick = async () => {
      const address = addressState.list.find((a) => a.id === Number(button.dataset.default));
      if (address && await makeAddressDefault(address)) after && after();
    };
  });
  root.querySelectorAll('[data-del]').forEach((button) => {
    button.onclick = async () => {
      const address = addressState.list.find((a) => a.id === Number(button.dataset.del));
      if (address && await deleteAddress(address)) after && after();
    };
  });
}

/*
 * The first-run screen: no restaurants until there is somewhere to deliver to.
 *
 * `onDone` runs once an address exists. `onSkip` is offered so that someone
 * who only ever collects their food in person is not held at this gate.
 */
export function addressGateHtml() {
  return `
    <div class="gate">
      <div class="gate-art">📍</div>
      <h1>${esc(t('addr.gateTitle'))}</h1>
      <p class="sub">${esc(t('addr.gateSub'))}</p>
      <div class="card">
        <button class="primary lg" id="gateLocate" style="width:100%">📍 ${esc(t('addr.useLocation'))}</button>
        <button class="lg mt" id="gateMap" style="width:100%">🗺️ ${esc(t('addr.pickOnMap'))}</button>
        <button class="ghost lg mt" id="gateManual" style="width:100%">⌨️ ${esc(t('addr.typeIt'))}</button>
      </div>
      <button class="ghost small mt" id="gateSkip">${esc(t('addr.skipGate'))}</button>
      <div class="small muted mt">${esc(t('addr.privacyNote'))}</div>
    </div>`;
}

export function wireAddressGate({ onDone, onSkip } = {}) {
  const done = (result) => { if (result) onDone && onDone(); };
  if ($('gateLocate')) $('gateLocate').onclick = async () => done(await addFromCurrentLocation($('gateLocate')));
  if ($('gateMap')) $('gateMap').onclick = async () => done(await addFromMap());
  if ($('gateManual')) $('gateManual').onclick = async () => done(await addManually());
  if ($('gateSkip')) $('gateSkip').onclick = () => onSkip && onSkip();
}
