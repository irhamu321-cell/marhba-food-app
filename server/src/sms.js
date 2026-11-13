/*
 * Sending an SMS, through whichever provider the deployment has an account
 * with.
 *
 * Four drivers ship here: Infobip, Twilio, a generic HTTP endpoint for
 * anything else (most Moroccan aggregators offer one), and a console driver
 * for development. All four speak through native fetch, so nothing is
 * installed to make this work.
 *
 * The transport is injectable. That is what lets the test suite prove the
 * request each provider builds — URL, headers, body — without an account and
 * without reaching the internet, which is the part that would otherwise go
 * untested until the first real customer tried to sign up.
 */
import { log } from './logger.js';

/*
 * Read straight from the environment rather than importing env.js.
 *
 * env.js asks this module which settings a provider needs, so importing it
 * back would make the two files depend on each other in a circle.
 */
const isProduction = () => String(process.env.NODE_ENV || '').toLowerCase() === 'production';

export const SMS_PROVIDERS = ['infobip', 'twilio', 'generic_http', 'console'];

/** The chosen provider: console in development, nothing assumed in production. */
export function smsProvider() {
  const raw = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (SMS_PROVIDERS.includes(raw)) return raw;
  return raw ? raw : (isProduction() ? '' : 'console');
}

export const smsConfig = () => ({
  provider: smsProvider(),
  apiKey: String(process.env.SMS_API_KEY || '').trim(),
  apiUrl: String(process.env.SMS_API_URL || '').trim(),
  sender: String(process.env.SMS_SENDER_ID || 'Marhba').trim(),
  twilioSid: String(process.env.TWILIO_ACCOUNT_SID || '').trim(),
  twilioToken: String(process.env.TWILIO_AUTH_TOKEN || '').trim(),
});

/**
 * Which settings a provider cannot work without.
 *
 * env.js turns these into a refusal to start in production, so a server is
 * never left quietly unable to send a signup code.
 */
export function missingSmsConfig(config = smsConfig()) {
  const missing = [];
  switch (config.provider) {
    case 'infobip':
      if (!config.apiKey) missing.push('SMS_API_KEY');
      if (!config.apiUrl) missing.push('SMS_API_URL');
      break;
    case 'twilio':
      if (!config.twilioSid) missing.push('TWILIO_ACCOUNT_SID');
      if (!config.twilioToken) missing.push('TWILIO_AUTH_TOKEN');
      if (!config.sender) missing.push('SMS_SENDER_ID');
      break;
    case 'generic_http':
      if (!config.apiUrl) missing.push('SMS_API_URL');
      if (!config.apiKey) missing.push('SMS_API_KEY');
      break;
    default:
      break;
  }
  return missing;
}

/*
 * Moroccan numbers are stored as 06… locally; a provider needs E.164.
 *
 * Anything already in international form is left alone, so a deployment that
 * one day serves another country does not have its numbers rewritten.
 */
export function toE164(phone, countryCode = '212') {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(countryCode)) return `+${digits}`;
  if (digits.startsWith('0')) return `+${countryCode}${digits.slice(1)}`;
  return `+${digits}`;
}

/** A phone number fit for a log line: enough to recognise, not enough to call. */
export const maskPhone = (phone) => {
  const s = String(phone || '');
  return s.length <= 4 ? '****' : `${s.slice(0, 4)}***${s.slice(-2)}`;
};

/*
 * The message itself, in both languages at once.
 *
 * One SMS carries both because the app does not know which language the
 * person reads before they have an account, and a second message would cost
 * twice as much to be half as useful.
 */
export function smsText(code, purpose = 'register') {
  const fr = purpose === 'reset'
    ? `Votre code de reinitialisation Marhba est : ${code}`
    : `Votre code de confirmation Marhba est : ${code}`;
  const ar = purpose === 'reset'
    ? `رمز إعادة تعيين كلمة السر لمرحبة هو: ${code}`
    : `رمز تأكيد مرحبة الخاص بك هو: ${code}`;
  return `${fr} / ${ar}`;
}

/* ------------------------------------------------------------------ */

const asError = async (response) => {
  const body = await response.text().catch(() => '');
  return new Error(`${response.status} ${body.slice(0, 200)}`);
};

/*
 * Infobip: one JSON call, the API key in an App header.
 * https://www.infobip.com/docs/api — SMS_API_URL is the base shown in the
 * Infobip portal, which differs per account.
 */
async function sendInfobip({ to, text, config, fetchImpl }) {
  const base = config.apiUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/sms/2/text/advanced`, {
    method: 'POST',
    headers: {
      Authorization: `App ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      messages: [{ destinations: [{ to }], from: config.sender, text }],
    }),
  });
  if (!response.ok) throw await asError(response);
  return { transport: 'infobip' };
}

/*
 * Twilio: form-encoded, basic auth with the account SID and token.
 */
async function sendTwilio({ to, text, config, fetchImpl }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioSid)}/Messages.json`;
  const body = new URLSearchParams({ To: to, From: config.sender, Body: text });
  const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!response.ok) throw await asError(response);
  return { transport: 'twilio' };
}

/*
 * Anything else: a POST of {to, text, sender} with a bearer token.
 *
 * Most aggregators accept this shape or document a close cousin; when one
 * does not, this is the single function to adjust.
 */
async function sendGeneric({ to, text, config, fetchImpl }) {
  const response = await fetchImpl(config.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, text, sender: config.sender }),
  });
  if (!response.ok) throw await asError(response);
  return { transport: 'generic_http' };
}

/**
 * Sends one SMS. Returns { transport }.
 *
 * `fetchImpl` exists for the tests; nothing else passes it.
 */
export async function sendSms({ to, text, purpose = 'register', config = smsConfig(),
  fetchImpl = globalThis.fetch } = {}) {
  const number = toE164(to);
  if (!number) throw new Error('numero de telephone vide');

  const missing = missingSmsConfig(config);
  if (missing.length) {
    throw new Error(`configuration SMS incomplete: ${missing.join(', ')}`);
  }

  // The message is never logged, and the number only in masked form.
  const line = { provider: config.provider, to: maskPhone(number), purpose };
  try {
    let result;
    if (config.provider === 'infobip') result = await sendInfobip({ to: number, text, config, fetchImpl });
    else if (config.provider === 'twilio') result = await sendTwilio({ to: number, text, config, fetchImpl });
    else if (config.provider === 'generic_http') result = await sendGeneric({ to: number, text, config, fetchImpl });
    else if (config.provider === 'console') result = { transport: 'console' };
    else throw new Error(`fournisseur SMS inconnu: ${config.provider || '(aucun)'}`);
    log.info('sms.sent', line);
    return result;
  } catch (error) {
    log.error('sms.failed', { ...line, error: error.message });
    throw error;
  }
}

/**
 * The delivery function codes.js installs at start-up.
 *
 * On the console provider it prints the code, which is what makes a pilot
 * possible before an SMS account exists. On a real provider it prints
 * nothing: the code goes to the customer's phone and nowhere else.
 */
export function smsDelivery({ fetchImpl } = {}) {
  return async ({ purpose, channel, destination, code }) => {
    const config = smsConfig();

    if (channel !== 'phone' || config.provider === 'console') {
      if (config.provider === 'console') {
        console.log(`  [code ${purpose}] ${channel} ${destination} -> ${code}`);
      }
      log.info('code.delivered', { purpose, channel, to: maskPhone(destination), transport: 'console' });
      return { transport: 'console' };
    }

    const result = await sendSms({
      to: destination, text: smsText(code, purpose), purpose, config, fetchImpl,
    });
    log.info('code.delivered', {
      purpose, channel, to: maskPhone(destination), transport: result.transport,
    });
    return result;
  };
}
