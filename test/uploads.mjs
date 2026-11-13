/*
 * The multipart parser and the image sniffer.
 *
 * These run without a server, because the interesting cases are the malformed
 * and the dishonest ones: a body cut short, a declared type that does not
 * match the bytes, a filename trying to escape the folder. Each of those is
 * cheap to construct here and awkward to construct through a browser.
 */
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sniffImage, readBoundary, parseMultipart, saveUpload, deleteUpload, uploadStats,
  uploadDir, MAX_UPLOAD_BYTES, ALLOWED_TYPES, UploadError,
} from '../server/src/uploads.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + label)) : (fail++, console.log('  FAIL ' + label + ' ' + extra));
};

/* --- the smallest files that are honestly what they claim to be --- */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 7)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(20, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20, 7)]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]),
  Buffer.from('WAVE', 'latin1'), Buffer.alloc(20, 7)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

console.log('\n== Reconnaitre une image a ses octets ==');
check('un JPEG est reconnu', sniffImage(JPEG)?.mime === 'image/jpeg');
check('un JPEG donne .jpg', sniffImage(JPEG)?.ext === '.jpg');
check('un PNG est reconnu', sniffImage(PNG)?.mime === 'image/png');
check('un WebP est reconnu', sniffImage(WEBP)?.mime === 'image/webp');
check('un GIF est refuse', sniffImage(GIF) === null);
check('un fichier RIFF qui n est pas WebP est refuse', sniffImage(WAV) === null);
check('du HTML est refuse', sniffImage(HTML) === null);
check('un fichier vide est refuse', sniffImage(Buffer.alloc(0)) === null);
check('un fichier trop court est refuse', sniffImage(Buffer.from([0xff, 0xd8])) === null);
check('trois types sont acceptes', ALLOWED_TYPES.length === 3);

console.log('\n== Lire le delimiteur ==');
check('un delimiteur simple est lu',
  readBoundary('multipart/form-data; boundary=----abc123') === '----abc123');
check('un delimiteur entre guillemets est lu',
  readBoundary('multipart/form-data; boundary="xy z"') === 'xy z');
check('sans delimiteur, null', readBoundary('multipart/form-data') === null);
check('sur un autre type, null', readBoundary('application/json') === null);

/* --- building a multipart body by hand --- */
function multipart(parts, boundary = '----test1234') {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`, 'latin1'));
      if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`, 'latin1'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n`, 'latin1'));
    }
    chunks.push(Buffer.from('\r\n', 'latin1'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Buffer.concat(chunks);
}

console.log('\n== Decouper un corps multipart ==');
{
  const body = multipart([
    { name: 'kind', data: 'logo' },
    { name: 'file', filename: 'photo.jpg', type: 'image/jpeg', data: JPEG },
  ]);
  const { fields, files } = parseMultipart(body, '----test1234');
  check('le champ texte est lu', fields.kind === 'logo', JSON.stringify(fields));
  check('un seul fichier est trouve', files.length === 1, String(files.length));
  check('le nom du champ est lu', files[0].field === 'file');
  check('le nom du fichier est lu', files[0].filename === 'photo.jpg');
  check('le type declare est lu', files[0].contentType === 'image/jpeg');
  check('les octets sont intacts', files[0].data.equals(JPEG),
    `${files[0].data.length} vs ${JPEG.length}`);
}
{
  const body = multipart([
    { name: 'a', filename: 'a.png', type: 'image/png', data: PNG },
    { name: 'b', filename: 'b.webp', type: 'image/webp', data: WEBP },
  ]);
  const { files } = parseMultipart(body, '----test1234');
  check('plusieurs fichiers sont trouves', files.length === 2);
  check('chaque fichier garde ses octets',
    files[0].data.equals(PNG) && files[1].data.equals(WEBP));
}
{
  // A JPEG happens to contain the boundary text inside its own bytes.
  const tricky = Buffer.concat([JPEG, Buffer.from('----test1234 pas un delimiteur', 'latin1'), JPEG]);
  const body = multipart([{ name: 'file', filename: 'x.jpg', type: 'image/jpeg', data: tricky }]);
  const { files } = parseMultipart(body, '----test1234');
  check('un corps contenant du texte proche du delimiteur est coupe au bon endroit',
    files.length === 1 && files[0].data.length === tricky.length,
    `${files[0] && files[0].data.length} attendu ${tricky.length}`);
}
{
  let code = '';
  try { parseMultipart(Buffer.from('rien du tout'), '----test1234'); }
  catch (e) { code = e.code; }
  check('un corps sans delimiteur est refuse', code === 'malformed', code);
}
{
  let code = '';
  try { parseMultipart(multipart([]), null); }
  catch (e) { code = e.code; }
  check('un appel sans delimiteur est refuse', code === 'no_boundary', code);
}
{
  const body = Buffer.from('--x\r\nContent-Disposition: form-data; name="f"; filename="a.jpg"\r\n', 'latin1');
  const { files } = parseMultipart(body, 'x');
  check('un corps tronque ne produit aucun fichier', files.length === 0, String(files.length));
}

console.log('\n== Enregistrer un fichier ==');
const before = uploadStats();
{
  const saved = saveUpload({ field: 'file', filename: 'photo.jpg', contentType: 'image/jpeg', data: JPEG });
  check('un JPEG est enregistre', existsSync(saved.path));
  check('l url pointe vers /uploads/', saved.url.startsWith('/uploads/'), saved.url);
  check('le nom stocke est un UUID',
    /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/.test(saved.url),
    saved.url);
  check('la taille est rapportee', saved.bytes === JPEG.length);
  check('le contenu est celui envoye', readFileSync(saved.path).equals(JPEG));
  check('le compteur augmente', uploadStats().files === before.files + 1);
  check('le fichier peut etre supprime', deleteUpload(saved.url) === true);
  check('le fichier a bien disparu', !existsSync(saved.path));
}
{
  // The client's filename is never used, so these cannot become paths.
  for (const filename of ['../../etc/passwd', 'x.php', 'a.html', 'shell.jpg.php', '']) {
    const saved = saveUpload({ field: 'file', filename, contentType: 'image/png', data: PNG });
    check(`un nom hostile est ignore: ${filename || '(vide)'}`,
      saved.url.endsWith('.png') && saved.path.startsWith(uploadDir()),
      saved.url);
    deleteUpload(saved.url);
  }
}
{
  const cases = [
    ['du HTML deguise en image', { contentType: 'image/jpeg', data: HTML }, 'bad_type'],
    ['un GIF', { contentType: 'image/gif', data: GIF }, 'bad_type'],
    ['un fichier vide', { contentType: 'image/jpeg', data: Buffer.alloc(0) }, 'empty'],
    ['un type interdit declare', { contentType: 'application/pdf', data: JPEG }, 'bad_type'],
    ['un type declare qui ne correspond pas', { contentType: 'image/png', data: JPEG }, 'type_mismatch'],
  ];
  for (const [label, file, expected] of cases) {
    let code = '';
    try { saveUpload({ field: 'file', filename: 'x', ...file }); }
    catch (e) { code = e.code; }
    check(`refus: ${label}`, code === expected, `${code} attendu ${expected}`);
  }
}
{
  let code = '';
  const big = Buffer.concat([JPEG, Buffer.alloc(200, 1)]);
  try { saveUpload({ field: 'file', filename: 'x.jpg', contentType: 'image/jpeg', data: big },
    { maxBytes: 100 }); }
  catch (e) { code = e.code; }
  check('refus: fichier trop volumineux', code === 'too_large', code);
  check('la limite par defaut est de 5 Mo', MAX_UPLOAD_BYTES === 5 * 1024 * 1024);
}
{
  check('un type declare absent est accepte si les octets sont bons',
    (() => {
      const saved = saveUpload({ field: 'file', filename: 'x', contentType: '', data: WEBP });
      const ok = saved.url.endsWith('.webp');
      deleteUpload(saved.url);
      return ok;
    })());
}

console.log('\n== Supprimer ==');
check('une url hors /uploads/ est ignoree', deleteUpload('/etc/passwd') === false);
check('une traversee de dossier est ignoree', deleteUpload('/uploads/../../secret.key') === false);
check('une extension interdite est ignoree', deleteUpload('/uploads/a.php') === false);
check('un fichier inconnu est ignore', deleteUpload('/uploads/00000000-0000-0000-0000-000000000000.jpg') === false);
check('une valeur vide est ignoree', deleteUpload('') === false);

console.log(`\n  ${pass} tests reussis, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
