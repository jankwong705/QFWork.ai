// ============================================================
// QFwork.ai — Mock payment provider (PAYMENT_PROVIDER=mock)
// ------------------------------------------------------------
// A stand-in gateway for building and testing before a real one is chosen.
// "Checkout" is /mock-checkout.html, a page with Pay and Cancel buttons. The
// buttons do not touch the order directly: they ask this module to send a
// SIGNED webhook to our own /api/payments/webhook, over HTTP, so the raw-body
// route, signature check and fulfilment run exactly as they will for a real
// provider.
//
// Anyone can press Pay, so in production this refuses to run unless
// ALLOW_MOCK_PAYMENTS=true is set on purpose (e.g. a staging service).
// ============================================================

const crypto = require('crypto');

// Both ends of the signature live in this process, so a fresh random secret
// per boot is enough. PAYMENT_WEBHOOK_SECRET overrides it, which lets a test
// script sign its own webhooks.
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const SIG_HEADER = 'x-mock-signature';

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

function createCheckout({ order }) {
  return {
    url: `/mock-checkout.html?order=${encodeURIComponent(order.id)}`,
    providerRef: 'mock_' + order.id.slice(4)
  };
}

function verifyWebhook(rawBody, headers) {
  const given = String(headers[SIG_HEADER] || '');
  const want  = sign(rawBody);
  const ok = given.length === want.length &&
             crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (!ok) throw new Error('bad signature');
  const evt = JSON.parse(rawBody.toString('utf8'));
  return {
    orderId:   evt.order,
    paid:      evt.type === 'payment.succeeded',
    cancelled: evt.type === 'payment.cancelled',
    amount:    evt.amount,
    currency:  evt.currency
  };
}

// Sends the webhook to ourselves, the way a provider's servers would.
async function deliver(type, order) {
  const body = Buffer.from(JSON.stringify({
    type, order: order.order_id, amount: Number(order.amount), currency: order.currency
  }));
  const port = process.env.PORT || 3000;
  const r = await fetch(`http://127.0.0.1:${port}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIG_HEADER]: sign(body) },
    body
  });
  if (!r.ok) throw new Error(`webhook returned ${r.status}`);
}

function routes(app, { getOrder, formatAmount }) {
  // What the fake checkout page shows.
  app.get('/api/mock-checkout/:order', async (req, res) => {
    const order = await getOrder(req.params.order).catch(() => null);
    if (!order) return res.status(404).json({ error: 'Unknown order.' });
    res.json({
      status:  order.status,
      plan:    order.plan,
      credits: order.credits,
      price:   formatAmount(order.amount, order.currency),
      topup:   !!order.topup
    });
  });

  app.post('/api/mock-checkout/:order/:action(pay|cancel)', async (req, res) => {
    const order = await getOrder(req.params.order).catch(() => null);
    if (!order) return res.status(404).json({ error: 'Unknown order.' });
    const back = `/checkout-return.html?order=${order.order_id}`;
    if (order.status !== 'pending') return res.json({ redirect: back });
    try {
      if (req.params.action === 'pay') {
        await deliver('payment.succeeded', order);
        return res.json({ redirect: back });
      }
      await deliver('payment.cancelled', order);
      return res.json({ redirect: back + '&cancelled=1' });
    } catch (e) {
      console.error(`[mock-pay] ${e.message}`);
      return res.status(502).json({ error: 'The mock webhook failed: ' + e.message });
    }
  });
}

function configProblems({ production }) {
  if (production && process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
    return ['PAYMENT_PROVIDER=mock gives sessions away to anyone who presses Pay. Set a real provider, or ALLOW_MOCK_PAYMENTS=true for a staging service.'];
  }
  return [];
}

module.exports = { name: 'mock', createCheckout, verifyWebhook, routes, configProblems };
