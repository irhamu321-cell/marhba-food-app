/*
 * Telling a restaurant owner that an order has arrived, when nobody is
 * looking at the dashboard.
 *
 * This is the single most valuable alert in the whole app: an order nobody
 * notices is a customer who waits, gives up, and does not come back. The
 * browser tab rings, but a tab that is closed rings for no one.
 *
 * Two optional channels, both off by default:
 *   ORDER_WEBHOOK_URL — a POST of JSON, which is what a WhatsApp Business
 *     relay, an n8n or Make flow, or a small script of your own expects;
 *   ORDER_ALERT_SMS   — a text to the owner's phone through the SMS driver
 *     already configured for verification codes.
 *
 * Neither can delay or fail an order. The customer has paid attention to a
 * cart and pressed a button; an aggregator being down is not their problem,
 * so every send here happens after the order is safely written, and a failure
 * is logged and dropped.
 */
import { log } from './logger.js';
import { sendSms, smsProvider, toE164 } from './sms.js';

const WEBHOOK_TIMEOUT_MS = 8000;

export const notifyConfig = () => ({
  webhookUrl: String(process.env.ORDER_WEBHOOK_URL || '').trim(),
  webhookSecret: String(process.env.ORDER_WEBHOOK_SECRET || '').trim(),
  smsEnabled: String(process.env.ORDER_ALERT_SMS || '').toLowerCase() === 'true',
  dashboardUrl: String(process.env.PUBLIC_URL || '').trim(),
});

/** Counters for the admin health panel, so a silent failure is visible. */
export const notifyState = {
  webhook_sent: 0, webhook_failed: 0, sms_sent: 0, sms_failed: 0, last_error: '',
};

/**
 * The message an owner reads on their phone.
 *
 * Short on purpose: it has to survive being a notification preview, and the
 * only decision it needs to prompt is "open the dashboard".
 */
export function ownerMessage(order, { dashboardUrl = '' } = {}) {
  const total = (Number(order.total_cents || 0) / 100).toFixed(2);
  const where = dashboardUrl ? ` ${dashboardUrl.replace(/\/+$/, '')}/restaurant.html` : '';
  return `Nouvelle commande ${order.order_number} recue ! Montant: ${total} MAD.`
    + `${where ? ` Ouvrez votre tableau de bord:${where}` : ''}`;
}

/** What a webhook receives. Deliberately flat, so a no-code tool can map it. */
export function webhookPayload(order, restaurant) {
  return {
    event: 'order.created',
    at: new Date().toISOString(),
    order_number: order.order_number,
    order_id: Number(order.id),
    total_mad: Number(order.total_cents || 0) / 100,
    total_cents: Number(order.total_cents || 0),
    items_count: Number(order.items_count || 0),
    fulfillment_type: order.fulfillment_type,
    service_type: order.service_type || 'immediate',
    scheduled_for: order.scheduled_for || '',
    scheduled_slot: order.scheduled_slot || '',
    has_allergy_note: Boolean(order.special_instructions),
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    restaurant_id: Number(restaurant?.id || order.restaurant_id),
    restaurant_name: restaurant?.name || '',
    dashboard_url: notifyConfig().dashboardUrl
      ? `${notifyConfig().dashboardUrl.replace(/\/+$/, '')}/restaurant.html`
      : '',
  };
}

async function postWebhook(url, payload, { secret, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    /*
     * A shared secret, when one is set, so the receiving end can tell a real
     * event from anybody who guessed the URL.
     */
    if (secret) headers['X-Marhba-Secret'] = secret;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${response.status} ${body.slice(0, 120)}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fires every configured alert for one new order.
 *
 * Awaited by the caller only in tests; in the request path it is called
 * without await, so the customer's response is not held up by somebody
 * else's server.
 */
export async function notifyNewOrder(order, restaurant, {
  config = notifyConfig(), fetchImpl = globalThis.fetch,
} = {}) {
  const results = { webhook: null, sms: null };

  if (config.webhookUrl) {
    try {
      await postWebhook(config.webhookUrl, webhookPayload(order, restaurant), {
        secret: config.webhookSecret, fetchImpl,
      });
      notifyState.webhook_sent += 1;
      results.webhook = 'sent';
      log.info('notify.webhook', { order_number: order.order_number, ok: true });
    } catch (error) {
      notifyState.webhook_failed += 1;
      notifyState.last_error = error.message;
      results.webhook = 'failed';
      log.warn('notify.webhook_failed', {
        order_number: order.order_number, error: error.message.slice(0, 160),
      });
    }
  }

  const ownerPhone = restaurant?.owner_phone || restaurant?.phone || '';
  if (config.smsEnabled && ownerPhone && smsProvider() !== 'console') {
    try {
      await sendSms({
        to: toE164(ownerPhone),
        text: ownerMessage(order, { dashboardUrl: config.dashboardUrl }),
        purpose: 'order',
        fetchImpl,
      });
      notifyState.sms_sent += 1;
      results.sms = 'sent';
    } catch (error) {
      notifyState.sms_failed += 1;
      notifyState.last_error = error.message;
      results.sms = 'failed';
      log.warn('notify.sms_failed', {
        order_number: order.order_number, error: error.message.slice(0, 160),
      });
    }
  }

  return results;
}
