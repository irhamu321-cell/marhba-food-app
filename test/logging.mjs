/*
 * The logger's two promises, and the Sentry hook.
 *
 * The promises are that nothing secret and nothing identifying is ever
 * written, locally or to a third party. Those are easy to break by accident —
 * one new field name and a phone number is in somebody else's database — so
 * they are checked directly rather than assumed.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

import {
  log, parseSentryDsn, sentryEvent, captureToSentry, sentryStats, resetSentry,
} from '../server/src/logger.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + label)) : (fail++, console.log('  FAIL ' + label + ' ' + extra));
};

const clean = log._clean;

console.log('\n== Ce qui ne doit jamais etre ecrit ==');
for (const key of ['password', 'password_hash', 'token', 'jwt', 'secret', 'code',
  'code_hash', 'otp', 'authorization', 'idempotency_key', 'cookie']) {
  check(`${key} est masque`, clean({ [key]: 'valeur-sensible' })[key] === '[redacted]',
    JSON.stringify(clean({ [key]: 'valeur-sensible' })));
}
for (const key of ['phone', 'email', 'destination', 'identifier', 'address', 'delivery_address']) {
  const out = clean({ [key]: '0612345678' })[key];
  check(`${key} devient une empreinte`,
    typeof out === 'string' && out.startsWith('#') && !out.includes('0612345678'), String(out));
}
check('la meme valeur donne la meme empreinte',
  clean({ phone: '0612345678' }).phone === clean({ phone: '0612345678' }).phone);
check('deux valeurs donnent deux empreintes',
  clean({ phone: '0612345678' }).phone !== clean({ phone: '0698765432' }).phone);
check('les objets imbriques sont nettoyes aussi',
  clean({ user: { password: 'x', phone: '0612345678' } }).user.password === '[redacted]');
check('un texte tres long est tronque',
  clean({ note: 'x'.repeat(500) }).note.length < 320);
check('une imbrication profonde est coupee',
  JSON.stringify(clean({ a: { b: { c: { d: { e: 1 } } } } })).includes('[deep]'),
  JSON.stringify(clean({ a: { b: { c: { d: { e: 1 } } } } })));
check('un champ ordinaire passe tel quel', clean({ order_id: 42 }).order_id === 42);

console.log('\n== Lire un DSN Sentry ==');
const dsn = parseSentryDsn('https://abc123def@o4507.ingest.sentry.io/4508');
check('le point de collecte est construit',
  dsn.endpoint === 'https://o4507.ingest.sentry.io/api/4508/store/', dsn && dsn.endpoint);
check('la cle publique est extraite', dsn.key === 'abc123def');
check('le projet est extrait', dsn.projectId === '4508');
check('un DSN vide donne null', parseSentryDsn('') === null);
check('un DSN absent donne null', parseSentryDsn(undefined) === null);
check('un DSN sans cle donne null',
  parseSentryDsn('https://o4507.ingest.sentry.io/4508') === null);
check('un DSN sans projet donne null',
  parseSentryDsn('https://abc@o4507.ingest.sentry.io/') === null);
check('un texte quelconque donne null', parseSentryDsn('pas-un-dsn') === null);

console.log('\n== Le contenu envoye a Sentry ==');
{
  const error = new Error('la base de donnees est injoignable');
  const event = sentryEvent('database.error', {
    phone: '0612345678', password: 'secret', order_id: 7,
  }, { error });

  check('l evenement a un identifiant', /^[0-9a-f]{32}$/.test(event.event_id), event.event_id);
  check('le niveau est transmis', event.level === 'error');
  check('l environnement est transmis', event.environment === 'test');
  check('le message est le nom de l evenement', event.message === 'database.error');
  check('l exception est transmise',
    event.exception.values[0].value.includes('injoignable'));
  check('la pile est transmise',
    event.exception.values[0].stacktrace.frames.length > 0,
    String(event.exception.values[0].stacktrace.frames.length));

  const body = JSON.stringify(event);
  check('AUCUN mot de passe ne part chez Sentry', !body.includes('secret'), body.slice(0, 200));
  check('AUCUN numero de telephone ne part chez Sentry',
    !body.includes('0612345678'), body.slice(0, 200));
  check('le numero est remplace par une empreinte',
    body.includes('"phone":"#'), body.slice(0, 200));
  check('les champs ordinaires partent bien', event.extra.order_id === 7);
  check('les chemins absolus ne partent pas',
    !event.exception.values[0].stacktrace.frames.some((f) => f.filename.startsWith('/')),
    event.exception.values[0].stacktrace.frames.map((f) => f.filename).join(','));
  check('nos fichiers sont marques in_app',
    event.exception.values[0].stacktrace.frames.some((f) => f.in_app === true));
}

console.log('\n== L envoi ==');
function fakeFetch({ ok = true, status = 200, throws = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(throws);
    return { ok, status, text: async () => '', json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

{
  delete process.env.SENTRY_DSN;
  resetSentry();
  const impl = fakeFetch();
  const sent = await captureToSentry('x', {}, { fetchImpl: impl });
  check('sans DSN, aucun appel', sent === false && impl.calls.length === 0);
  check('et rien n est signale comme configure', sentryStats().configured === false);
}
{
  process.env.SENTRY_DSN = 'https://cle@o1.ingest.sentry.io/2';
  resetSentry();
  const impl = fakeFetch();
  const sent = await captureToSentry('database.error', { order_id: 1 },
    { error: new Error('boum'), fetchImpl: impl });
  check('avec un DSN, un appel est fait', sent === true && impl.calls.length === 1);
  check('l url est le point de collecte',
    impl.calls[0].url === 'https://o1.ingest.sentry.io/api/2/store/', impl.calls[0].url);
  check('la cle part dans l en-tete X-Sentry-Auth',
    impl.calls[0].options.headers['X-Sentry-Auth'].includes('sentry_key=cle'),
    impl.calls[0].options.headers['X-Sentry-Auth']);
  check('la version du protocole est annoncee',
    impl.calls[0].options.headers['X-Sentry-Auth'].includes('sentry_version=7'));
  check('le compteur avance', sentryStats().sent === 1);
}
{
  process.env.SENTRY_DSN = 'https://cle@o1.ingest.sentry.io/2';
  resetSentry();
  const sent = await captureToSentry('x', {}, { fetchImpl: fakeFetch({ ok: false, status: 429 }) });
  check('un refus de Sentry ne jette rien', sent === false);
  check('il est compte comme echec', sentryStats().failed === 1);
}
{
  process.env.SENTRY_DSN = 'https://cle@o1.ingest.sentry.io/2';
  resetSentry();
  const sent = await captureToSentry('x', {}, { fetchImpl: fakeFetch({ throws: 'ECONNREFUSED' }) });
  check('un reseau coupe ne jette rien', sent === false);
  check('il est aussi compte comme echec', sentryStats().failed === 1);
}
{
  // A crash loop must not turn into a flood of requests.
  process.env.SENTRY_DSN = 'https://cle@o1.ingest.sentry.io/2';
  resetSentry();
  const impl = fakeFetch();
  for (let i = 0; i < 50; i++) {
    await captureToSentry('boucle', {}, { fetchImpl: impl });
  }
  check('les envois sont plafonnes par minute',
    impl.calls.length === 20, String(impl.calls.length));
  check('les evenements en trop sont comptes',
    sentryStats().dropped === 30, String(sentryStats().dropped));
}

console.log('\n== log.error declenche la capture ==');
{
  process.env.SENTRY_DSN = 'https://cle@o1.ingest.sentry.io/2';
  resetSentry();
  const before = sentryStats().sent;
  log.error('test.error', { order_id: 1 });
  await new Promise((r) => setTimeout(r, 50));
  check('une erreur est capturee', sentryStats().sent === before + 1,
    `${before} -> ${sentryStats().sent}`);
  const beforeInfo = sentryStats().sent;
  log.info('test.info', {});
  log.warn('test.warn', {});
  await new Promise((r) => setTimeout(r, 50));
  check('un info ou un warn ne coute rien', sentryStats().sent === beforeInfo,
    String(sentryStats().sent));
}

delete process.env.SENTRY_DSN;
resetSentry();

console.log(`\n  ${pass} tests reussis, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
