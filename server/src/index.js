import http from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { connectStore, store, ROOT } from './store.js';
import { loadEnv, enforceEnvironment, isProduction } from './env.js';
import { createSchema, seedIfEmpty, seedFirstAdmin } from './schema.js';
import { verifyToken } from './auth.js';
import { router } from './routes.js';
import { json, readBody, serveStatic, isMultipart, HttpError } from './http.js';
import { scheduleBackups, backupStatus } from './backup.js';
import { log, installCrashHandlers } from './logger.js';
import { setDelivery } from './codes.js';
import { smsDelivery, smsProvider } from './sms.js';

loadEnv(ROOT);
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  process.env.NODE_ENV = 'development';
}
enforceEnvironment();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = join(ROOT, 'web');
// Same-origin by default. Set CORS_ORIGIN only when a separate app needs the API.
// A wildcard is refused by enforceEnvironment, so it can never reach here in production.
const CORS_ORIGIN = process.env.CORS_ORIGIN === '*' ? '' : (process.env.CORS_ORIGIN || '');
// Behind Caddy or nginx the socket address is the proxy's; the real client is in a header.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '') === '1'
  || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';

/*
 * Installed before anything else can fail, so even a failure during start-up
 * is written down instead of vanishing into whatever launched the process.
 */
installCrashHandlers();

const connection = await connectStore();
await createSchema();
if (await seedIfEmpty()) console.log('Donnees de demonstration creees.');
await seedFirstAdmin();
scheduleBackups();

/*
 * Verification codes now go out through the SMS driver.
 *
 * On the console provider this still prints the code, which is what lets a
 * pilot run before an SMS account exists; env.js refuses to start in
 * production on that setting.
 */
setDelivery(smsDelivery());
console.log(`  SMS             : ${smsProvider() || '(non configure)'}`);

/**
 * The caller's address. `X-Forwarded-For` is only believed when TRUST_PROXY is
 * set, because a client can send that header itself: trusting it unconditionally
 * would let anyone forge an address and walk around the login rate limit.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') { res.writeHead(CORS_ORIGIN ? 204 : 403); return res.end(); }

  try {
    const route = router.match(req.method, url.pathname);
    if (route) {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const ctx = {
        req, res,
        params: route.params,
        query: url.searchParams,
        /*
         * An upload brings bytes, not JSON, so readBody would choke on it.
         * The route reads the stream itself through readRawBody.
         */
        body: isMultipart(req) ? {} : await readBody(req),
        user: verifyToken(token),
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] || '',
      };
      const result = await route.handler(ctx);
      /*
       * A handler that has already written its own headers owns the response:
       * the order stream, for instance, stays open for hours. Anything else
       * written here would corrupt it.
       */
      if (res.writableEnded || res.headersSent) return;
      return json(res, req.method === 'POST' ? 201 : 200, result ?? { ok: true });
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint inconnu.' });
    if (serveStatic(res, WEB_DIR, url.pathname)) return;
    /*
     * An uploaded picture that is not there is missing, not a page.
     *
     * Everything else falls through to index.html so the single-page app can
     * handle its own routes, but doing that for /uploads/ would answer a
     * deleted image with an HTML page and a 200, which hides the problem from
     * anything that checks.
     */
    if (url.pathname.startsWith('/uploads/')) return json(res, 404, { error: 'Image introuvable.' });
    if (serveStatic(res, WEB_DIR, '/index.html')) return;
    return json(res, 404, { error: 'Page introuvable.' });
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message, details: err.details });
    if (err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === '23505')) {
      return json(res, 409, { error: 'Cette valeur existe deja.' });
    }
    // A database failure is an operational event, not just a 500 for the caller.
    const message = String(err?.message || err);
    const isDatabase = /SQLITE|database|ECONNREFUSED|connexion|pg|relation/i.test(message)
      || typeof err?.errcode === 'number';
    log[isDatabase ? 'error' : 'warn'](isDatabase ? 'database.error' : 'request.failed', {
      message: message.slice(0, 300),
      path: url.pathname,
      method: req.method,
    });
    return json(res, 500, { error: 'Erreur interne du serveur.' });
  }
});

function localAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Base de donnees : ${connection.driver} (${connection.target})`);
  console.log(`  Serveur pret    : http://localhost:${PORT}`);
  console.log(`  Client          : http://localhost:${PORT}/`);
  console.log(`  Restaurant      : http://localhost:${PORT}/restaurant.html`);
  console.log(`  Admin           : http://localhost:${PORT}/admin.html`);
  const addresses = localAddresses();
  if (addresses.length) {
    console.log('\n  Sur ton telephone (meme wifi) :');
    for (const address of addresses) console.log(`      http://${address}:${PORT}`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await store.close().catch(() => {}); process.exit(0); });
}
