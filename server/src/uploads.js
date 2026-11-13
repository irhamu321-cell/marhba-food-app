/*
 * Uploading a picture, without a single dependency.
 *
 * Two jobs live here: reading a multipart/form-data body, and deciding
 * whether what arrived is really an image.
 *
 * The second job is the one that matters. A browser tells the server what it
 * thinks it is sending, and an attacker's browser lies, so the declared type
 * is treated as a hint and the first bytes of the file decide. The stored
 * name is random and its extension comes from those bytes, never from the
 * name the client chose — which is what stops ".php", ".html" or
 * "../../etc/passwd" from ever becoming a path on disk.
 */
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './store.js';

/** 5 MB, as a photo from a phone comfortably fits and a disk filler does not. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** The only three types accepted, each recognisable from its first bytes. */
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const uploadDir = () => join(ROOT, 'web', 'uploads');

export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

/* ------------------------------------------------------------------ *
 * What is this file, really?
 * ------------------------------------------------------------------ */

/**
 * Identifies an image from its leading bytes, or returns null.
 *
 * JPEG starts FF D8 FF. PNG has an eight-byte signature. WebP is a RIFF
 * container whose fourth word is "WEBP", so both parts are checked — a plain
 * RIFF file (a .wav, say) is not a WebP and is refused.
 */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => buffer[i] === byte)) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * multipart/form-data
 * ------------------------------------------------------------------ */

/** Pulls the boundary out of a Content-Type header. */
export function readBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = match ? (match[1] || match[2]).trim() : '';
  return boundary || null;
}

/**
 * Splits a multipart body into its parts.
 *
 * Returns { fields, files } where a file is
 * { field, filename, contentType, data }. Only the bytes between the
 * boundaries are kept; nothing is written to disk here.
 */
export function parseMultipart(buffer, boundary) {
  if (!boundary) throw new UploadError('no_boundary', 'Requete multipart sans delimiteur.');

  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) throw new UploadError('malformed', 'Requete multipart illisible.');

  while (cursor !== -1) {
    let start = cursor + delimiter.length;

    // "--" right after the delimiter marks the end of the body.
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start, 'latin1');
    if (headerEnd === -1) break;

    const headerText = buffer.subarray(start, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;

    const next = buffer.indexOf(delimiter, bodyStart);
    if (next === -1) break;
    // The CRLF immediately before the next delimiter belongs to the protocol.
    const bodyEnd = next >= 2 && buffer[next - 2] === 0x0d && buffer[next - 1] === 0x0a
      ? next - 2 : next;

    const disposition = /content-disposition:[^\r\n]*/i.exec(headerText);
    const nameMatch = disposition && /name="([^"]*)"/i.exec(disposition[0]);
    const fileMatch = disposition && /filename="([^"]*)"/i.exec(disposition[0]);
    const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);
    const field = nameMatch ? nameMatch[1] : '';

    if (fileMatch) {
      files.push({
        field,
        filename: fileMatch[1],
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: buffer.subarray(bodyStart, bodyEnd),
      });
    } else if (field) {
      fields[field] = buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    }

    cursor = next;
  }

  return { fields, files };
}

/* ------------------------------------------------------------------ *
 * Storing it
 * ------------------------------------------------------------------ */

/**
 * Validates one uploaded file and writes it under web/uploads/.
 *
 * Returns { url, path, bytes, mime }. The name is a random UUID, so two
 * customers uploading "photo.jpg" never collide and nobody can guess the URL
 * of someone else's upload by its name.
 */
export function saveUpload(file, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  if (!file || !file.data || file.data.length === 0) {
    throw new UploadError('empty', 'Aucun fichier recu.');
  }
  if (file.data.length > maxBytes) {
    throw new UploadError('too_large',
      `Fichier trop volumineux (max ${Math.floor(maxBytes / (1024 * 1024))} Mo).`);
  }

  const sniffed = sniffImage(file.data);
  if (!sniffed) {
    throw new UploadError('bad_type', 'Formats acceptes: JPEG, PNG ou WebP.');
  }
  /*
   * The declared type is checked too, but only to refuse a mismatch: a client
   * claiming PNG while sending a JPEG is either broken or probing, and
   * neither deserves a stored file.
   */
  if (file.contentType && !ALLOWED_TYPES.includes(file.contentType)) {
    throw new UploadError('bad_type', 'Formats acceptes: JPEG, PNG ou WebP.');
  }
  if (file.contentType && file.contentType !== sniffed.mime) {
    throw new UploadError('type_mismatch',
      'Le type declare ne correspond pas au contenu du fichier.');
  }

  const dir = uploadDir();
  mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}${sniffed.ext}`;
  writeFileSync(join(dir, name), file.data);

  return {
    url: `/uploads/${name}`,
    path: join(dir, name),
    bytes: file.data.length,
    mime: sniffed.mime,
  };
}

/**
 * Deletes a previously stored upload, by the URL that was handed out.
 *
 * Anything that is not a plain /uploads/<name> is ignored rather than
 * followed, so a crafted value cannot reach a file elsewhere on the disk.
 */
export function deleteUpload(url) {
  const name = /^\/uploads\/([A-Za-z0-9-]+\.(?:jpg|png|webp))$/.exec(String(url || ''));
  if (!name) return false;
  const target = join(uploadDir(), name[1]);
  if (!target.startsWith(uploadDir()) || !existsSync(target)) return false;
  unlinkSync(target);
  return true;
}

/** How much the uploads folder holds, for the admin health panel. */
export function uploadStats() {
  const dir = uploadDir();
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(dir)) {
    try {
      const info = statSync(join(dir, name));
      if (info.isFile()) { files += 1; bytes += info.size; }
    } catch { /* a file removed mid-scan is not an error */ }
  }
  return { files, bytes };
}
