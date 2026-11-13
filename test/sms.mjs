/*
 * The SMS drivers, without an SMS account.
 *
 * Every provider is checked by handing it a fake transport and inspecting the
 * request it builds: the URL, the headers, the body. That is the part that is
 * either right or wrong before a single real message is sent, and it is the
 * part no amount of manual testing in Morocco would reveal quickly.
 */
process.env.NODE_ENV = 'test';

import {
  SMS_PROVIDERS, smsProvider, smsConfig, missingSmsConfig, toE164, maskPhone,
  smsText, sendSms, smsDelivery,
} from '../server/src/sms.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + label))
     : (fail++, console.log('  FAIL ' + label + ' ' + extra));
};

/** Records what was asked of it and answers however the test wants. */
function fakeFetch({ ok = true, status = 200, body = '{}' } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok, status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  impl.calls = calls;
  return impl;
}

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

console.log('\n== Numeros et masquage ==');
check('06 devient +212', toE164('0612345678') === '+212612345678', toE164('0612345678'));
check('les espaces sont ignores', toE164('06 12 34 56 78') === '+212612345678', toE164('06 12 34 56 78'));
check('un numero deja international est laisse tel quel',
  toE164('+33612345678') === '+33612345678', toE164('+33612345678'));
check('212 sans plus est complete', toE164('212612345678') === '+212612345678');
check('un numero vide donne une chaine vide', toE164('') === '');
check('un numero est masque dans les journaux',
  maskPhone('0612345678') === '0612***78', maskPhone('0612345678'));
check('un numero trop court est entierement masque', maskPhone('061') === '****');

console.log('\n== Le texte du message ==');
const textRegister = smsText('123456', 'register');
check('le code apparait une fois par langue',
  (textRegister.match(/123456/g) || []).length === 2, textRegister);
check('le francais est present', /Votre code de confirmation Marhba est/.test(textRegister));
check('l arabe est present', /رمز تأكيد مرحبة/.test(textRegister), textRegister);
const textReset = smsText('654321', 'reset');
check('la reinitialisation a son propre texte',
  /reinitialisation/i.test(textReset) && /إعادة تعيين/.test(textReset), textReset);

console.log('\n== Le choix du fournisseur ==');
await withEnv({ SMS_PROVIDER: undefined, NODE_ENV: 'development' }, () => {
  check('sans reglage, console en developpement', smsProvider() === 'console', smsProvider());
});
await withEnv({ SMS_PROVIDER: undefined, NODE_ENV: 'production' }, () => {
  check('sans reglage, rien en production', smsProvider() === '', `"${smsProvider()}"`);
});
await withEnv({ SMS_PROVIDER: 'TWILIO' }, () => {
  check('le nom du fournisseur est insensible a la casse', smsProvider() === 'twilio');
});
check('les quatre pilotes sont declares',
  SMS_PROVIDERS.join(',') === 'infobip,twilio,generic_http,console', SMS_PROVIDERS.join(','));

console.log('\n== Configuration manquante ==');
check('infobip sans cle est signale',
  missingSmsConfig({ provider: 'infobip', apiKey: '', apiUrl: 'https://x.api.infobip.com' })
    .join(',') === 'SMS_API_KEY');
check('infobip sans url est signale',
  missingSmsConfig({ provider: 'infobip', apiKey: 'k', apiUrl: '' }).join(',') === 'SMS_API_URL');
check('twilio sans identifiants est signale',
  missingSmsConfig({ provider: 'twilio', twilioSid: '', twilioToken: '', sender: 'Marhba' })
    .join(',') === 'TWILIO_ACCOUNT_SID,TWILIO_AUTH_TOKEN');
check('generic_http sans url ni cle est signale',
  missingSmsConfig({ provider: 'generic_http', apiUrl: '', apiKey: '' })
    .join(',') === 'SMS_API_URL,SMS_API_KEY');
check('console ne demande rien',
  missingSmsConfig({ provider: 'console' }).length === 0);
check('une configuration complete ne signale rien',
  missingSmsConfig({ provider: 'twilio', twilioSid: 'AC1', twilioToken: 't', sender: 'Marhba' })
    .length === 0);

console.log('\n== Infobip ==');
{
  const impl = fakeFetch();
  const config = { provider: 'infobip', apiKey: 'cle-secrete', apiUrl: 'https://abc.api.infobip.com/', sender: 'Marhba' };
  const result = await sendSms({ to: '0612345678', text: 'bonjour', config, fetchImpl: impl });
  const [call] = impl.calls;
  check('un seul appel est fait', impl.calls.length === 1);
  check('l url est celle du compte',
    call.url === 'https://abc.api.infobip.com/sms/2/text/advanced', call.url);
  check('la cle part dans un en-tete App',
    call.options.headers.Authorization === 'App cle-secrete', call.options.headers.Authorization);
  const body = JSON.parse(call.options.body);
  check('le numero est en E.164 dans le corps',
    body.messages[0].destinations[0].to === '+212612345678',
    body.messages[0].destinations[0].to);
  check('l expediteur est transmis', body.messages[0].from === 'Marhba');
  check('le texte est transmis', body.messages[0].text === 'bonjour');
  check('le transport est rapporte', result.transport === 'infobip');
}

console.log('\n== Twilio ==');
{
  const impl = fakeFetch();
  const config = { provider: 'twilio', twilioSid: 'AC123', twilioToken: 'jeton', sender: '+212600000000' };
  const result = await sendSms({ to: '0612345678', text: 'bonjour', config, fetchImpl: impl });
  const [call] = impl.calls;
  check('l url contient le SID du compte',
    call.url === 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', call.url);
  check('l authentification est basique',
    call.options.headers.Authorization
      === `Basic ${Buffer.from('AC123:jeton').toString('base64')}`);
  check('le corps est un formulaire',
    call.options.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(call.options.body);
  check('le destinataire est en E.164', form.get('To') === '+212612345678');
  check('l expediteur est transmis', form.get('From') === '+212600000000');
  check('le texte est transmis', form.get('Body') === 'bonjour');
  check('le transport est rapporte', result.transport === 'twilio');
}

console.log('\n== generic_http ==');
{
  const impl = fakeFetch();
  const config = { provider: 'generic_http', apiKey: 'cle', apiUrl: 'https://sms.example.ma/send', sender: 'Marhba' };
  const result = await sendSms({ to: '+212612345678', text: 'bonjour', config, fetchImpl: impl });
  const [call] = impl.calls;
  check('l url configuree est appelee', call.url === 'https://sms.example.ma/send');
  check('la cle part en bearer', call.options.headers.Authorization === 'Bearer cle');
  const body = JSON.parse(call.options.body);
  check('le corps porte to, text et sender',
    body.to === '+212612345678' && body.text === 'bonjour' && body.sender === 'Marhba',
    call.options.body);
  check('le transport est rapporte', result.transport === 'generic_http');
}

console.log('\n== Les echecs ==');
{
  const impl = fakeFetch({ ok: false, status: 401, body: 'cle invalide' });
  const config = { provider: 'infobip', apiKey: 'mauvaise', apiUrl: 'https://x.api.infobip.com', sender: 'M' };
  let message = '';
  try { await sendSms({ to: '0612345678', text: 'x', config, fetchImpl: impl }); }
  catch (e) { message = e.message; }
  check('un refus du fournisseur remonte une erreur', /401/.test(message), message);
  check('le motif du fournisseur est conserve', /cle invalide/.test(message), message);
}
{
  const impl = fakeFetch();
  let message = '';
  try {
    await sendSms({ to: '0612345678', text: 'x',
      config: { provider: 'infobip', apiKey: '', apiUrl: '' }, fetchImpl: impl });
  } catch (e) { message = e.message; }
  check('une configuration incomplete est refusee avant l appel',
    /incomplete/.test(message) && impl.calls.length === 0, message);
}
{
  const impl = fakeFetch();
  let message = '';
  try {
    await sendSms({ to: '', text: 'x', config: { provider: 'console' }, fetchImpl: impl });
  } catch (e) { message = e.message; }
  check('un numero vide est refuse', /vide/.test(message), message);
}
{
  const impl = fakeFetch();
  let message = '';
  try {
    await sendSms({ to: '0612345678', text: 'x',
      config: { provider: 'pigeon' }, fetchImpl: impl });
  } catch (e) { message = e.message; }
  check('un fournisseur inconnu est refuse', /inconnu/.test(message), message);
}

console.log('\n== La fonction de livraison branchee sur codes.js ==');
await withEnv({ SMS_PROVIDER: 'console' }, async () => {
  const impl = fakeFetch();
  const result = await smsDelivery({ fetchImpl: impl })({
    purpose: 'register', channel: 'phone', destination: '0612345678', code: '424242',
  });
  check('le pilote console n appelle aucun reseau', impl.calls.length === 0);
  check('le pilote console rapporte son transport', result.transport === 'console');
});
await withEnv({
  SMS_PROVIDER: 'generic_http', SMS_API_URL: 'https://sms.example.ma/send',
  SMS_API_KEY: 'cle', SMS_SENDER_ID: 'Marhba',
}, async () => {
  const impl = fakeFetch();
  const result = await smsDelivery({ fetchImpl: impl })({
    purpose: 'register', channel: 'phone', destination: '0612345678', code: '424242',
  });
  check('un vrai fournisseur est appele une fois', impl.calls.length === 1);
  const body = JSON.parse(impl.calls[0].options.body);
  check('le message envoye contient le code', body.text.includes('424242'), body.text);
  check('le message envoye est bilingue',
    /Marhba/.test(body.text) && /مرحبة/.test(body.text), body.text);
  check('le transport rapporte est celui du fournisseur', result.transport === 'generic_http');
});
await withEnv({
  SMS_PROVIDER: 'generic_http', SMS_API_URL: 'https://sms.example.ma/send', SMS_API_KEY: 'cle',
}, async () => {
  const impl = fakeFetch();
  await smsDelivery({ fetchImpl: impl })({
    purpose: 'reset', channel: 'email', destination: 'a@b.ma', code: '111111',
  });
  check('un code par email ne passe pas par le SMS', impl.calls.length === 0);
});

console.log(`\n  ${pass} tests reussis, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
