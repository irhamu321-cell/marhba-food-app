// A very small HTTP helper: routing, JSON bodies, static files, validation.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (m, d) => new HttpError(400, m, d);
export const unauthorized = (m = 'Connecte-toi pour continuer.') => new HttpError(401, m);
export const forbidden = (m = 'Action non autorisee.') => new HttpError(403, m);
export const notFound = (m = 'Introuvable.') => new HttpError(404, m);
export const conflict = (m) => new HttpError(409, m);

export function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MAX_BODY = 1024 * 1024; // 1 MB

export function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(badRequest('Requete trop volumineuse.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(badRequest('JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

/*
 * The body as bytes, for an upload.
 *
 * readBody above expects JSON and caps the body at 1 MB; a photo is neither.
 *
 * Going over the limit does NOT close the socket. A browser that is still
 * sending a 7 MB photo when the connection dies reports a network error, and
 * the person is told nothing useful; drained instead, it gets a real answer
 * saying the file is too big. So past the limit the bytes are counted and
 * thrown away rather than kept, and the refusal is raised once the request
 * finishes.
 *
 * There is still a ceiling on that patience: something sending vastly more
 * than the limit is not a mistaken photo, and that connection is dropped.
 */
const DRAIN_FACTOR = 4;

export function readRawBody(req, { maxBytes = 5 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const hardLimit = maxBytes * DRAIN_FACTOR;
    const tooBig = () => badRequest(
      `Fichier trop volumineux (max ${Math.floor(maxBytes / (1024 * 1024))} Mo).`);

    let size = 0;
    let overflow = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!overflow) { overflow = true; chunks.length = 0; }
        if (size > hardLimit) {
          reject(tooBig());
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return reject(tooBig());
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** True when the request carries a multipart body rather than JSON. */
export const isMultipart = (req) =>
  /^multipart\/form-data/i.test(String(req.headers['content-type'] || ''));

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method, parts, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let pathExists = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const expected = route.parts[i];
        if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(parts[i]);
        else if (expected !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathExists = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    if (pathExists) throw new HttpError(405, 'Methode non autorisee.');
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveStatic(res, rootDir, urlPath) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '' || rel === '\\') rel = '/index.html';
  const filePath = join(rootDir, rel);
  if (!filePath.startsWith(rootDir)) { json(res, 403, { error: 'Chemin interdit.' }); return true; }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

// ---- validation helpers ----
export function str(body, field, { required = true, max = 500, min = 0 } = {}) {
  const value = body[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`Le champ "${field}" est obligatoire.`);
    return '';
  }
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`Le champ "${field}" est trop long (max ${max}).`);
  if (s.length < min) throw badRequest(`Le champ "${field}" est trop court (min ${min}).`);
  return s;
}

export function int(body, field, { required = true, min = 0, max = 100000000, fallback = 0 } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Le champ "${field}" est obligatoire.`);
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest(`Le champ "${field}" doit etre un nombre entier.`);
  if (n < min || n > max) throw badRequest(`Le champ "${field}" doit etre entre ${min} et ${max}.`);
  return n;
}

export function bool(body, field, fallback = false) {
  const value = body[field];
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function oneOf(body, field, allowed, { required = true, fallback = null } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`Le champ "${field}" est obligatoire.`);
    return fallback;
  }
  const s = String(value);
  if (!allowed.includes(s)) throw badRequest(`"${field}" doit etre: ${allowed.join(', ')}.`);
  return s;
}

export function email(body, field = 'email') {
  const value = str(body, field, { max: 200 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw badRequest('Adresse email invalide.');
  return value;
}
