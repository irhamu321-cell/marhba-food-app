/*
 * Minimal PostgreSQL client — speaks the PostgreSQL wire protocol directly,
 * so the app needs no installed packages.
 *
 * It exposes the same shape as the standard `pg` library:
 *     const rows = (await client.query('SELECT * FROM t WHERE id = $1', [1])).rows;
 * so if you ever want to swap in `pg` (npm install pg), only this file changes.
 *
 * Queries are serialised on one connection, which keeps BEGIN/COMMIT blocks
 * safe without pool bookkeeping. Plenty for a pilot; add a pool when traffic
 * justifies it.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const FRONTEND = { Parse: 0x50, Bind: 0x42, Describe: 0x44, Execute: 0x45, Sync: 0x53, Query: 0x51, Terminate: 0x58, PasswordMessage: 0x70 };

class Writer {
  constructor() { this.chunks = []; }
  byte(b) { this.chunks.push(Buffer.from([b])); return this; }
  int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); this.chunks.push(b); return this; }
  int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.chunks.push(b); return this; }
  cstr(s) { this.chunks.push(Buffer.from(`${s}\0`, 'utf8')); return this; }
  raw(buf) { this.chunks.push(buf); return this; }
  build(type) {
    const body = Buffer.concat(this.chunks);
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length + 4);
    return type ? Buffer.concat([Buffer.from([type]), len, body]) : Buffer.concat([len, body]);
  }
}

function parseValue(oid, text) {
  if (text === null) return null;
  switch (oid) {
    case 16: return text === 't' ? 1 : 0;              // bool -> 0/1, matching SQLite
    case 20: case 21: case 23: case 26: {              // int8 / int2 / int4 / oid
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    case 700: case 701: case 1700: return Number(text); // float4 / float8 / numeric
    case 114: case 3802: try { return JSON.parse(text); } catch { return text; }
    default: return text;
  }
}

export function parseConnectionString(url) {
  // postgres://user:password@host:port/database?sslmode=require
  const u = new URL(url);
  return {
    host: decodeURIComponent(u.hostname),
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: decodeURIComponent((u.pathname || '/postgres').slice(1)) || 'postgres',
    ssl: /^(require|verify-ca|verify-full|true|1)$/i.test(u.searchParams.get('sslmode') || ''),
  };
}

export class PgClient {
  constructor(config) {
    this.config = typeof config === 'string' ? parseConnectionString(config) : config;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.connecting = null;
    this.queue = Promise.resolve();
    this.handlers = null;
    this.serverParams = {};
  }

  /* ---------- connection ---------- */
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async _connect() {
    const { host, port, ssl } = this.config;
    let socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    if (ssl) {
      // SSLRequest: length 8, magic 80877103
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      socket.write(req);
      const answer = await new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
      });
      if (answer.toString('utf8', 0, 1) !== 'S') throw new Error('Le serveur PostgreSQL refuse le SSL.');
      socket = tls.connect({ socket, servername: host, rejectUnauthorized: false });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
    }

    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => { this.connected = false; this._fail(new Error('Connexion PostgreSQL fermee.')); });

    await this._startup();
    this.connected = true;
  }

  _startup() {
    return new Promise((resolve, reject) => {
      this.handlers = { resolve, reject, phase: 'auth' };
      const w = new Writer();
      w.int32(196608); // protocol 3.0
      w.cstr('user').cstr(this.config.user);
      w.cstr('database').cstr(this.config.database);
      w.cstr('application_name').cstr('marhba');
      w.cstr('client_encoding').cstr('UTF8');
      w.byte(0);
      this.socket.write(w.build(null));
    });
  }

  _fail(err) {
    const h = this.handlers;
    this.handlers = null;
    if (h) h.reject(err);
  }

  _send(buf) { this.socket.write(buf); }

  /* ---------- protocol reader ---------- */
  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const type = this.buffer[0];
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try { this._message(String.fromCharCode(type), body); }
      catch (err) { this._fail(err); }
    }
  }

  _message(type, body) {
    const h = this.handlers;
    switch (type) {
      case 'R': return this._auth(body);
      case 'S': { // ParameterStatus
        const parts = body.toString('utf8').split('\0');
        this.serverParams[parts[0]] = parts[1];
        return;
      }
      case 'K': return; // BackendKeyData
      case 'Z': { // ReadyForQuery
        if (!h) return;
        this.handlers = null;
        if (h.error) h.reject(h.error);
        else h.resolve({ rows: h.rows || [], rowCount: h.rowCount ?? (h.rows ? h.rows.length : 0), fields: h.fields || [] });
        return;
      }
      case 'T': { // RowDescription
        if (!h) return;
        const count = body.readInt16BE(0);
        let offset = 2;
        const fields = [];
        for (let i = 0; i < count; i++) {
          const end = body.indexOf(0, offset);
          const name = body.toString('utf8', offset, end);
          offset = end + 1;
          const oid = body.readInt32BE(offset + 6);
          offset += 18;
          fields.push({ name, oid });
        }
        h.fields = fields;
        h.rows = [];
        return;
      }
      case 'D': { // DataRow
        if (!h) return;
        const count = body.readInt16BE(0);
        let offset = 2;
        const row = {};
        for (let i = 0; i < count; i++) {
          const size = body.readInt32BE(offset);
          offset += 4;
          let value = null;
          if (size >= 0) { value = body.toString('utf8', offset, offset + size); offset += size; }
          const field = h.fields[i];
          row[field.name] = parseValue(field.oid, value);
        }
        (h.rows ||= []).push(row);
        return;
      }
      case 'C': { // CommandComplete  e.g. "INSERT 0 1" / "UPDATE 2"
        if (!h) return;
        const tag = body.toString('utf8').replace(/\0$/, '').split(' ');
        const n = Number(tag[tag.length - 1]);
        if (Number.isFinite(n)) h.rowCount = n;
        return;
      }
      case 'E': { // ErrorResponse
        const err = pgError(body);
        if (h) h.error = err; else this._fail(err);
        return;
      }
      case 'N': return; // NoticeResponse
      case '1': case '2': case 'n': case 's': return; // Parse/Bind complete, NoData, PortalSuspended
      case 'I': return; // EmptyQueryResponse
      case 'A': return; // NotificationResponse
      default: return;
    }
  }

  _auth(body) {
    const code = body.readInt32BE(0);
    const { user, password } = this.config;
    if (code === 0) return; // AuthenticationOk — wait for ReadyForQuery
    if (code === 3) { // cleartext
      const w = new Writer().cstr(password);
      return this._send(w.build(FRONTEND.PasswordMessage));
    }
    if (code === 5) { // md5
      const salt = body.subarray(4, 8);
      const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');
      const inner = md5(password + user);
      const token = `md5${md5(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))}`;
      return this._send(new Writer().cstr(token).build(FRONTEND.PasswordMessage));
    }
    if (code === 10) return this._scramStart(body);
    if (code === 11) return this._scramContinue(body);
    if (code === 12) return this._scramFinal(body);
    throw new Error(`Methode d authentification PostgreSQL non supportee (${code}).`);
  }

  _scramStart(body) {
    const mechanisms = body.subarray(4).toString('utf8').split('\0').filter(Boolean);
    if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('SCRAM-SHA-256 indisponible sur ce serveur.');
    this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
    this.scram.clientFirstBare = `n=*,r=${this.scram.nonce}`;
    const payload = Buffer.from(`n,,${this.scram.clientFirstBare}`, 'utf8');
    const w = new Writer().cstr('SCRAM-SHA-256').int32(payload.length).raw(payload);
    this._send(w.build(FRONTEND.PasswordMessage));
  }

  _scramContinue(body) {
    const serverFirst = body.subarray(4).toString('utf8');
    const parts = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
    const salt = Buffer.from(parts.s, 'base64');
    const iterations = Number(parts.i);
    const serverNonce = parts.r;
    if (!serverNonce.startsWith(this.scram.nonce)) throw new Error('Nonce SCRAM invalide (serveur non fiable).');

    const saltedPassword = crypto.pbkdf2Sync(this.config.password, salt, iterations, 32, 'sha256');
    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const clientKey = hmac(saltedPassword, 'Client Key');
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const clientFinalBare = `c=biws,r=${serverNonce}`;
    const authMessage = `${this.scram.clientFirstBare},${serverFirst},${clientFinalBare}`;
    const clientSignature = hmac(storedKey, authMessage);
    const proof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSignature[i];

    this.scram.serverSignature = hmac(hmac(saltedPassword, 'Server Key'), authMessage).toString('base64');
    const payload = Buffer.from(`${clientFinalBare},p=${proof.toString('base64')}`, 'utf8');
    this._send(new Writer().raw(payload).build(FRONTEND.PasswordMessage));
  }

  _scramFinal(body) {
    const final = body.subarray(4).toString('utf8');
    const signature = final.split(',').find((kv) => kv.startsWith('v='))?.slice(2);
    if (signature !== this.scram.serverSignature) throw new Error('Signature du serveur PostgreSQL invalide.');
  }

  /* ---------- queries ---------- */
  query(text, values = []) {
    const run = async () => {
      if (!this.connected) await this.connect();
      return new Promise((resolve, reject) => {
        this.handlers = { resolve, reject, rows: [], fields: [] };
        if (!values.length) {
          this._send(new Writer().cstr(text).build(FRONTEND.Query));
          return;
        }
        const parse = new Writer().cstr('').cstr(text).int16(0).build(FRONTEND.Parse);
        const bind = new Writer().cstr('').cstr('').int16(0).int16(values.length);
        for (const value of values) {
          if (value === null || value === undefined) { bind.int32(-1); continue; }
          const buf = Buffer.from(String(value), 'utf8');
          bind.int32(buf.length).raw(buf);
        }
        bind.int16(0);
        const describe = new Writer().byte(0x50).cstr('').build(FRONTEND.Describe);
        const execute = new Writer().cstr('').int32(0).build(FRONTEND.Execute);
        const sync = new Writer().build(FRONTEND.Sync);
        this._send(Buffer.concat([parse, bind.build(FRONTEND.Bind), describe, execute, sync]));
      });
    };
    // Serialise: one query at a time, so transactions stay coherent.
    const result = this.queue.then(run, run);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async end() {
    if (!this.socket) return;
    try { this._send(new Writer().build(FRONTEND.Terminate)); } catch { /* already gone */ }
    this.socket.end();
    this.connected = false;
  }
}

function pgError(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length) {
    const code = String.fromCharCode(body[offset]);
    if (code === '\0') break;
    const end = body.indexOf(0, offset + 1);
    fields[code] = body.toString('utf8', offset + 1, end);
    offset = end + 1;
  }
  const err = new Error(fields.M || 'Erreur PostgreSQL');
  err.code = fields.C;
  err.detail = fields.D;
  err.constraint = fields.n;
  err.table = fields.t;
  return err;
}
