/*
 * Pushing new orders to a restaurant's open dashboard.
 *
 * The board already polls every 15 seconds, which is fine for a correct list
 * and far too slow for a kitchen: a customer waits a quarter of a minute
 * before anyone knows they are hungry. Server-Sent Events close that gap, and
 * the polling stays as the fallback — a proxy that buffers the stream, a
 * phone that drops its connection, and the board still fills in.
 *
 * Authentication is the awkward part. EventSource cannot send an
 * Authorization header, and putting a session token in a URL leaves it in
 * proxy logs and browser history. So a dashboard asks for a ticket over the
 * normal authenticated API, and spends it immediately on the stream: one use,
 * one minute, one restaurant.
 */
import crypto from 'node:crypto';
import { log } from './logger.js';

/** How long a ticket is worth anything, and how many may wait at once. */
const TICKET_TTL_MS = 60_000;
const TICKET_MAX = 500;

/** A comment down the wire now and then, so no proxy decides we are idle. */
const HEARTBEAT_MS = 25_000;

/** Tickets waiting to be spent: token -> { restaurantId, userId, expires }. */
const tickets = new Map();

/** Open streams, grouped by restaurant: restaurantId -> Set<res>. */
const clients = new Map();

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

function sweepTickets() {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (ticket.expires <= now) tickets.delete(token);
  }
}

export function issueTicket({ restaurantId, userId }) {
  sweepTickets();
  // A flood of unspent tickets must not grow without end.
  if (tickets.size >= TICKET_MAX) {
    const oldest = [...tickets.entries()].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) tickets.delete(oldest[0]);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  tickets.set(token, {
    restaurantId: Number(restaurantId),
    userId: Number(userId),
    expires: Date.now() + TICKET_TTL_MS,
  });
  return { ticket: token, expires_in_seconds: Math.floor(TICKET_TTL_MS / 1000) };
}

/**
 * Spends a ticket, or returns null.
 *
 * Deleted whether or not it was still valid, so a leaked ticket cannot be
 * replayed even once.
 */
export function redeemTicket(token) {
  const ticket = tickets.get(String(token || ''));
  if (!ticket) return null;
  tickets.delete(String(token));
  if (ticket.expires <= Date.now()) return null;
  return ticket;
}

export const ticketCount = () => { sweepTickets(); return tickets.size; };

/* ------------------------------------------------------------------ *
 * The stream itself
 * ------------------------------------------------------------------ */

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Turns one response into a long-lived event stream.
 *
 * Returns nothing: from here on the response belongs to this module, and the
 * request handler must not write to it again.
 */
export function openStream(req, res, { restaurantId }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which would hold every
    // event until the connection closed. This asks it not to.
    'X-Accel-Buffering': 'no',
  });

  const key = Number(restaurantId);
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(res);

  res.write(frame('ready', { restaurant_id: key, at: new Date().toISOString() }));

  const heartbeat = setInterval(() => {
    // A comment line: valid SSE, ignored by the browser, enough to keep the
    // connection from being reaped.
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closing */ }
  }, HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    const set = clients.get(key);
    if (set) {
      set.delete(res);
      if (!set.size) clients.delete(key);
    }
  };

  req.on('close', close);
  req.on('error', close);
  res.on('error', close);

  log.info('stream.opened', { restaurant_id: key, clients: clients.get(key)?.size || 0 });
}

/**
 * Sends one event to every dashboard of one restaurant.
 *
 * Never throws: a write to a dead socket must not take down whatever was
 * happening when the event was raised — an order being placed, most often.
 */
export function publish(restaurantId, event, data) {
  const set = clients.get(Number(restaurantId));
  if (!set || !set.size) return 0;
  const payload = frame(event, data);
  let sent = 0;
  for (const res of [...set]) {
    try { res.write(payload); sent += 1; }
    catch { set.delete(res); }
  }
  return sent;
}

/** How many dashboards are listening, for the admin health panel. */
export function streamStats() {
  let total = 0;
  for (const set of clients.values()) total += set.size;
  return { restaurants: clients.size, clients: total, tickets: ticketCount() };
}

/** Closes every stream; used when the process is shutting down. */
export function closeAllStreams() {
  for (const set of clients.values()) {
    for (const res of set) { try { res.end(); } catch { /* already gone */ } }
  }
  clients.clear();
}
