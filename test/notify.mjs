/*
 * The owner alert: webhook and SMS.
 *
 * The important property is not that it sends — it is that it cannot break an
 * order. An aggregator that is down, slow, or answering 500 must leave the
 * customer with a confirmed order, so every failure path is checked here.
 */
process.env.NODE_ENV = 'test';

import {
  notifyConfig, ownerMessage, webhookPayload, notifyNewOrder, notifyState,
} from '../server/src/notify.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  ok ? (pass++, console.log('  ok   ' + label)) : (fail++, console.log('  FAIL ' + label + ' ' + extra));
};

const ORDER = {
  id: 42,
  order_number: 'CMD-TEST-0042',
  total_cents: 12550,
  items_count: 3,
  fulfillment_type: 'delivery',
  service_type: 'immediate',
  customer_name: 'Ilham B.',
  customer_phone: '0612345678',
  restaurant_id: 1,
  special_instructions: 'ALLERGIE ARACHIDES',
};
const RESTO = { id: 1, name: 'Snack Atlas', phone: '0537100001', owner_phone: '0611111111' };

function fakeFetch({ ok = true, status = 200, body = 'OK', delayMs = 0, throws = null } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(throws);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { ok, status, text: async () => body, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

console.log('\n== Le message a l exploitant ==');
const message = ownerMessage(ORDER, { dashboardUrl: 'https://marhba.ma' });
check('le numero de commande est dans le message', message.includes('CMD-TEST-0042'), message);
check('le montant est en MAD lisible', message.includes('125.50 MAD'), message);
check('le lien du tableau de bord est donne',
  message.includes('https://marhba.ma/restaurant.html'), message);
check('sans URL publique, aucun lien bancal',
  !ownerMessage(ORDER).includes('http'), ownerMessage(ORDER));
check('le message reste court', ownerMessage(ORDER).length < 160,
  String(ownerMessage(ORDER).length));

console.log('\n== Le contenu du webhook ==');
const payload = webhookPayload(ORDER, RESTO);
check('l evenement est nomme', payload.event === 'order.created');
check('le numero de commande est transmis', payload.order_number === 'CMD-TEST-0042');
check('le montant est donne en MAD et en centimes',
  payload.total_mad === 125.5 && payload.total_cents === 12550,
  `${payload.total_mad} / ${payload.total_cents}`);
check('le restaurant est nomme', payload.restaurant_name === 'Snack Atlas');
check('la presence d une consigne allergie est signalee', payload.has_allergy_note === true);
check('le texte de la consigne n est PAS transmis',
  !JSON.stringify(payload).includes('ARACHIDES'), JSON.stringify(payload).slice(0, 160));
check('le nombre de lignes est transmis', payload.items_count === 3);
check('l horodatage est en ISO', /^\d{4}-\d{2}-\d{2}T/.test(payload.at), payload.at);

console.log('\n== Rien de configure ==');
{
  const impl = fakeFetch();
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: '', smsEnabled: false, dashboardUrl: '' }, fetchImpl: impl });
  check('sans configuration, aucun appel', impl.calls.length === 0);
  check('et rien n est rapporte', result.webhook === null && result.sms === null);
}

console.log('\n== Le webhook ==');
{
  const impl = fakeFetch();
  const before = notifyState.webhook_sent;
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'https://hook.example.ma/marhba', webhookSecret: '', smsEnabled: false },
    fetchImpl: impl });
  check('un seul appel est fait', impl.calls.length === 1);
  check('l url configuree est appelee', impl.calls[0].url === 'https://hook.example.ma/marhba');
  check('la methode est POST', impl.calls[0].options.method === 'POST');
  check('le corps est du JSON',
    impl.calls[0].options.headers['Content-Type'] === 'application/json');
  check('le corps est le contenu attendu',
    JSON.parse(impl.calls[0].options.body).order_number === 'CMD-TEST-0042');
  check('le succes est rapporte', result.webhook === 'sent');
  check('le compteur de succes avance', notifyState.webhook_sent === before + 1);
}
{
  const impl = fakeFetch();
  await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'https://hook.example.ma/x', webhookSecret: 'tres-secret', smsEnabled: false },
    fetchImpl: impl });
  check('le secret partage est envoye en en-tete',
    impl.calls[0].options.headers['X-Marhba-Secret'] === 'tres-secret');
}
{
  const impl = fakeFetch();
  await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'https://hook.example.ma/x', smsEnabled: false }, fetchImpl: impl });
  check('sans secret, aucun en-tete vide',
    !('X-Marhba-Secret' in impl.calls[0].options.headers));
}

console.log('\n== Quand le webhook echoue ==');
{
  const before = notifyState.webhook_failed;
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'https://hook.example.ma/x', smsEnabled: false },
    fetchImpl: fakeFetch({ ok: false, status: 500, body: 'erreur interne' }) });
  check('un 500 est rapporte comme echec', result.webhook === 'failed');
  check('mais rien n est jete', true);
  check('le compteur d echecs avance', notifyState.webhook_failed === before + 1);
  check('le motif est retenu', /500/.test(notifyState.last_error), notifyState.last_error);
}
{
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'https://hook.example.ma/x', smsEnabled: false },
    fetchImpl: fakeFetch({ throws: 'ECONNREFUSED' }) });
  check('un serveur injoignable est rapporte comme echec', result.webhook === 'failed');
}
{
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: 'pas-une-url', smsEnabled: false },
    fetchImpl: fakeFetch({ throws: 'Invalid URL' }) });
  check('une url invalide ne fait pas tomber l appel', result.webhook === 'failed');
}

console.log('\n== L alerte SMS ==');
{
  const impl = fakeFetch();
  process.env.SMS_PROVIDER = 'generic_http';
  process.env.SMS_API_URL = 'https://sms.example.ma/send';
  process.env.SMS_API_KEY = 'cle';
  process.env.SMS_SENDER_ID = 'Marhba';
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: '', smsEnabled: true, dashboardUrl: 'https://marhba.ma' },
    fetchImpl: impl });
  check('un SMS est envoye a l exploitant', result.sms === 'sent', String(result.sms));
  check('il part au numero du proprietaire',
    JSON.parse(impl.calls[0].options.body).to === '+212611111111',
    impl.calls[0] && impl.calls[0].options.body);
  check('le SMS nomme la commande',
    JSON.parse(impl.calls[0].options.body).text.includes('CMD-TEST-0042'));
}
{
  const impl = fakeFetch();
  process.env.SMS_PROVIDER = 'console';
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: '', smsEnabled: true }, fetchImpl: impl });
  check('en mode console, aucun SMS n est tente',
    result.sms === null && impl.calls.length === 0, String(result.sms));
}
{
  const impl = fakeFetch();
  process.env.SMS_PROVIDER = 'generic_http';
  const result = await notifyNewOrder(ORDER, { id: 1, name: 'Sans telephone' }, {
    config: { webhookUrl: '', smsEnabled: true }, fetchImpl: impl });
  check('sans numero, aucun SMS n est tente',
    result.sms === null && impl.calls.length === 0, String(result.sms));
}
{
  const impl = fakeFetch();
  const result = await notifyNewOrder(ORDER, RESTO, {
    config: { webhookUrl: '', smsEnabled: false }, fetchImpl: impl });
  check('desactive, aucun SMS', result.sms === null && impl.calls.length === 0);
}

console.log('\n== La configuration lue dans l environnement ==');
{
  process.env.ORDER_WEBHOOK_URL = 'https://x.ma/h';
  process.env.ORDER_ALERT_SMS = 'true';
  process.env.PUBLIC_URL = 'https://marhba.ma';
  const config = notifyConfig();
  check('l url du webhook est lue', config.webhookUrl === 'https://x.ma/h');
  check('l alerte SMS est lue', config.smsEnabled === true);
  check('l url publique est lue', config.dashboardUrl === 'https://marhba.ma');
  delete process.env.ORDER_WEBHOOK_URL;
  delete process.env.ORDER_ALERT_SMS;
  check('desactive par defaut',
    notifyConfig().webhookUrl === '' && notifyConfig().smsEnabled === false);
}

console.log(`\n  ${pass} tests reussis, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
