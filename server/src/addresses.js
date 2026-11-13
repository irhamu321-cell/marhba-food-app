/*
 * Delivery addresses: validation, normalisation and display.
 *
 * Everything here is a pure function over plain objects, with no database and
 * no HTTP, so the rules can be tested on their own. The routes in routes.js
 * call these and then read or write rows; they never re-implement a rule.
 *
 * Why both a pin and written details are required for a delivery address:
 * a phone's GPS is routinely tens of metres out, and many Moroccan streets
 * are not mapped at building level. The pin gets a courier to the corner;
 * "3rd floor, blue door, opposite the pharmacy" gets them to the door.
 */

/** Longest value accepted for each written field. */
export const ADDRESS_LIMITS = {
  label_custom: 40,
  recipient_name: 120,
  recipient_phone: 30,
  city: 80,
  street: 200,
  building: 80,
  floor: 80,
  landmark: 160,
  instructions: 300,
};

export const ADDRESS_LABELS = ['home', 'work', 'other'];

/** Fields a saved address cannot be without. */
export const REQUIRED_FIELDS = ['recipient_name', 'recipient_phone', 'city', 'street'];

export class AddressError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/*
 * Coordinates.
 *
 * Accepts a number or a string, refuses anything outside the real range of
 * the Earth, and refuses NaN and Infinity — a browser that loses its GPS fix
 * can hand over either. The value is returned as a string rounded to six
 * decimals: about 11 cm, far finer than any address needs, and short enough
 * that the stored value is readable.
 */
export const LAT_RANGE = [-90, 90];
export const LNG_RANGE = [-180, 180];
const DECIMALS = 6;

function coordinate(value, [min, max], name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AddressError('coord_missing', `La ${name} est obligatoire.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AddressError('coord_not_number', `La ${name} doit etre un nombre.`);
  }
  if (n < min || n > max) {
    throw new AddressError('coord_range', `La ${name} doit etre entre ${min} et ${max}.`);
  }
  // Number() then toFixed() drops the trailing zeros that toFixed() adds,
  // so 33.5 stays "33.5" instead of becoming "33.500000".
  return String(Number(n.toFixed(DECIMALS)));
}

export const validateLat = (value) => coordinate(value, LAT_RANGE, 'latitude');
export const validateLng = (value) => coordinate(value, LNG_RANGE, 'longitude');

/** True when both coordinates are present and valid. Never throws. */
export function hasValidPin(address) {
  if (!address) return false;
  try {
    validateLat(address.lat);
    validateLng(address.lng);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */

const text = (value, field) => {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  const max = ADDRESS_LIMITS[field];
  if (max && s.length > max) {
    throw new AddressError('too_long', `Le champ "${field}" est trop long (max ${max} caracteres).`);
  }
  return s;
};

/**
 * Turns whatever the browser sent into the exact set of columns the table has.
 *
 * `requirePin` is false only for an address a customer saves before choosing a
 * point; a delivery order checks the pin again at checkout, where it matters.
 */
export function normalizeAddress(input, { requirePin = true } = {}) {
  const body = input || {};
  const label = ADDRESS_LABELS.includes(String(body.label)) ? String(body.label) : 'home';

  const out = {
    label,
    label_custom: label === 'other' ? text(body.label_custom, 'label_custom') : '',
    recipient_name: text(body.recipient_name, 'recipient_name'),
    recipient_phone: text(body.recipient_phone, 'recipient_phone'),
    city: text(body.city, 'city'),
    street: text(body.street, 'street'),
    building: text(body.building, 'building'),
    floor: text(body.floor, 'floor'),
    landmark: text(body.landmark, 'landmark'),
    instructions: text(body.instructions, 'instructions'),
    lat: '',
    lng: '',
  };

  for (const field of REQUIRED_FIELDS) {
    if (!out[field]) throw new AddressError('missing', `Le champ "${field}" est obligatoire.`);
  }
  if (out.recipient_phone.replace(/\D/g, '').length < 9) {
    throw new AddressError('bad_phone', 'Numero de telephone invalide.');
  }

  const givenPin = body.lat !== undefined && body.lat !== null && String(body.lat).trim() !== '';
  if (requirePin || givenPin) {
    out.lat = validateLat(body.lat);
    out.lng = validateLng(body.lng);
  }
  return out;
}

/* ------------------------------------------------------------------ */

/** What the customer sees on the chip: "Maison", "Travail", or their own word. */
export function labelText(address, lang = 'fr') {
  const names = {
    fr: { home: 'Maison', work: 'Travail', other: 'Autre' },
    ar: { home: 'المنزل', work: 'العمل', other: 'آخر' },
  };
  const set = names[lang] || names.fr;
  if (address?.label === 'other' && address.label_custom) return address.label_custom;
  return set[address?.label] || set.home;
}

/**
 * One readable line, for a list, a CSV column or the old delivery_address field.
 * Only the parts that were filled in appear, so there are no empty commas.
 */
export function oneLine(address) {
  if (!address) return '';
  return [address.street, address.building, address.floor, address.landmark, address.city]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Everything a courier needs, as a short block of lines.
 * Used by the restaurant order card and the admin order detail.
 */
export function addressBlock(address) {
  if (!address) return [];
  const lines = [];
  if (address.street) lines.push(address.street);
  const second = [address.building, address.floor].filter(Boolean).join(' · ');
  if (second) lines.push(second);
  if (address.landmark) lines.push(`Repere: ${address.landmark}`);
  if (address.city) lines.push(address.city);
  if (address.instructions) lines.push(`Note: ${address.instructions}`);
  return lines;
}

/**
 * A link that opens the pin in whatever map app the phone has.
 * Returns an empty string when there is no usable pin, so a caller can simply
 * hide the button rather than test the coordinates itself.
 */
export function mapLink(address) {
  if (!hasValidPin(address)) return '';
  return `https://www.openstreetmap.org/?mlat=${address.lat}&mlon=${address.lng}#map=18/${address.lat}/${address.lng}`;
}

/**
 * Coordinates cut down to roughly a neighbourhood (about 1 km), for logs.
 *
 * A log line is read by more people, kept for longer and copied into more
 * places than a database row, so it gets the coarse version: enough to tell
 * two orders apart or spot a city, not enough to point at someone's door.
 */
export function coarsePin(address) {
  if (!hasValidPin(address)) return '';
  return `${Number(address.lat).toFixed(2)},${Number(address.lng).toFixed(2)}`;
}

/** The order columns that freeze an address onto an order. */
export function snapshotColumns(address) {
  return {
    addr_label: address.label === 'other' && address.label_custom ? address.label_custom : (address.label || ''),
    addr_recipient_name: address.recipient_name || '',
    addr_recipient_phone: address.recipient_phone || '',
    addr_city: address.city || '',
    addr_street: address.street || '',
    addr_building: address.building || '',
    addr_floor: address.floor || '',
    addr_landmark: address.landmark || '',
    addr_instructions: address.instructions || '',
    addr_lat: address.lat || '',
    addr_lng: address.lng || '',
  };
}

/** Reads those columns back into the shape the helpers above expect. */
export function snapshotFromOrder(order) {
  if (!order) return null;
  const snap = {
    label: order.addr_label || '',
    label_custom: '',
    recipient_name: order.addr_recipient_name || '',
    recipient_phone: order.addr_recipient_phone || '',
    city: order.addr_city || '',
    street: order.addr_street || '',
    building: order.addr_building || '',
    floor: order.addr_floor || '',
    landmark: order.addr_landmark || '',
    instructions: order.addr_instructions || '',
    lat: order.addr_lat || '',
    lng: order.addr_lng || '',
  };
  const filled = snap.street || snap.city || snap.lat;
  return filled ? snap : null;
}
