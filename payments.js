// ============================================================
// QFwork.ai — Payments
// ------------------------------------------------------------
// There are no user accounts. A payment buys a PAID ACCESS CODE carrying a
// balance of sessions, redeemed through the same gate as the trial codes
// (access.js). Buying while signed in on a paid code tops that code up
// instead of minting a second one.
//
//   1. POST /api/checkout       → an order is recorded here as 'pending', with
//                                 the price and credits the SERVER chose, and
//                                 the visitor is sent to the provider's page.
//   2. provider → webhook       → signature checked by the provider adapter;
//                                 the order flips to 'paid' and the code is
//                                 minted in one SQL statement. A retried
//                                 webhook finds nothing pending and mints
//                                 nothing.
//   3. checkout-return.html     → polls GET /api/checkout/status, shows the
//                                 code and redeems it.
//
// The provider is a plug-in under providers/, chosen by PAYMENT_PROVIDER.
// Until a real gateway is picked, 'mock' stands in: a fake checkout page with
// Pay / Cancel buttons that drives the exact same webhook path.
//
// A provider module exports:
//   name
//   createCheckout({ order, baseUrl, returnUrl, cancelUrl }) → { url, providerRef }
//   verifyWebhook(rawBody, headers)  → { orderId, paid, cancelled, amount, currency }
//                                      or null to ignore; THROWS on a bad signature
//   getStatus(order)                 → { paid, amount, currency } or null (optional;
//                                      the fallback for a late webhook)
//   routes(app, ctx)                 → extra routes (optional; the mock's fake page)
//   configProblems({ production })   → [string] reasons it cannot run (optional)
// ============================================================

const crypto = require('crypto');
const db     = require('./db');
const access = require('./access');

const PROVIDERS = {
  mock: () => require('./providers/mock')
};

// Placeholder prices until real pricing is decided. id:credits:price, price
// in whole units of PLANS_CURRENCY.
const DEFAULT_PLANS = 'single:1:98,pack5:5:398,pack10:10:698';


// ── configuration ───────────────────────────────────────────
function providerName() {
  return String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
}

function enabled() {
  return !!providerName();
}

let cached = null;
function provider() {
  const name = providerName();
  if (!cached || cached.name !== name) {
    const load = PROVIDERS[name];
    if (!load) throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
    cached = load();
  }
  return cached;
}

let plansSrc = null;
let plansList = [];
function plans() {
  const src = String(process.env.PLANS || DEFAULT_PLANS) + '|' + (process.env.PLANS_CURRENCY || '');
  if (src !== plansSrc) {
    plansSrc = src;
    const currency = String(process.env.PLANS_CURRENCY || 'HKD').trim().toUpperCase();
    plansList = String(process.env.PLANS || DEFAULT_PLANS).split(',').map(s => s.trim()).filter(Boolean).map(entry => {
      const [id, credits, price] = entry.split(':').map(x => (x || '').trim());
      const c = parseInt(credits, 10);
      const p = Number(price);
      if (!/^[a-z0-9_-]+$/i.test(id || '') || !(c > 0) || !(p > 0)) {
        console.warn(`[payments] ignoring malformed plan "${entry}" — expected id:credits:price`);
        return null;
      }
      return { id, credits: c, amount: Math.round(p * 100), currency };
    }).filter(Boolean);
  }
  return plansList;
}

function planById(id) {
  return plans().find(p => p.id === id) || null;
}

function isProduction() {
  // Render sets RENDER=true on every service; NODE_ENV covers everything else.
  return process.env.NODE_ENV === 'production' || !!process.env.RENDER;
}

// Reasons payments must not run, checked once at boot. Each one is fatal:
// a misconfigured payment path either loses customers' money or gives
// sessions away.
function configProblems() {
  if (!enabled()) return [];
  const problems = [];
  let p;
  try { p = provider(); } catch (e) { return [e.message]; }
  const production = isProduction();
  if (production && db.kind() !== 'postgres') {
    problems.push('payments need a durable database in production — set DATABASE_URL (Neon). The local PGlite store is wiped on every deploy.');
  }
  if (!plans().length) problems.push('no valid PLANS configured');
  if (typeof p.configProblems === 'function') problems.push(...p.configProblems({ production }));
  return problems;
}


// ── checkout ────────────────────────────────────────────────
// `session` is the caller's access session, if any. On a paid code the
// purchase tops that code up; otherwise a new code is minted on payment.
async function createCheckout({ planId, baseUrl, session }) {
  const plan = planById(planId);
  if (!plan) {
    const e = new Error('Unknown plan.');
    e.status = 400;
    throw e;
  }
  const orderId = 'ord_' + crypto.randomBytes(12).toString('hex');
  const topupCode = session && session.tier === 'paid' ? session.code : null;
  const p = provider();

  await db.query(
    `INSERT INTO orders (order_id, provider, plan, credits, amount, currency, code, topup)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orderId, p.name, plan.id, plan.credits, plan.amount, plan.currency, topupCode, !!topupCode]);

  const back = `${baseUrl}/checkout-return.html?order=${orderId}`;
  const { url, providerRef } = await p.createCheckout({
    order: { id: orderId, plan: plan.id, credits: plan.credits, amount: plan.amount, currency: plan.currency },
    baseUrl,
    returnUrl: back,
    cancelUrl: back + '&cancelled=1'
  });
  if (providerRef) {
    await db.query('UPDATE orders SET provider_ref = $2 WHERE order_id = $1', [orderId, providerRef]);
  }
  console.log(`[payments] order ${orderId} created — ${plan.id}, ${plan.credits} credit(s), ${formatAmount(plan.amount, plan.currency)}${topupCode ? ' (top-up)' : ''}`);
  return { url, orderId };
}


// ── fulfilment ──────────────────────────────────────────────
// Flip the order to 'paid' and credit the code, as ONE statement. The UPDATE
// only matches a pending order, so a duplicate or retried webhook falls
// through it and the INSERT has nothing to insert. A top-up order already
// carries its code, so the insert collides and adds to the balance instead.
const FULFIL_SQL = `
  WITH paid AS (
    UPDATE orders SET status = 'paid', paid_at = now(), code = COALESCE(code, $2)
     WHERE order_id = $1 AND status = 'pending'
     RETURNING code, credits, plan, order_id
  )
  INSERT INTO paid_codes (code, credits_total, plan, order_id)
  SELECT code, credits, plan, order_id FROM paid
  ON CONFLICT (code) DO UPDATE SET credits_total = paid_codes.credits_total + EXCLUDED.credits_total
  RETURNING code, credits_total - credits_used AS left`;

async function getOrder(orderId) {
  if (!/^ord_[0-9a-f]{24}$/.test(String(orderId || ''))) return null;
  const r = await db.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
  return r.rows[0] || null;
}

async function fulfil(orderId, paidAmount, paidCurrency) {
  const order = await getOrder(orderId);
  if (!order) {
    console.warn(`[payments] payment for unknown order ${orderId} — ignored`);
    return false;
  }
  // The provider confirms what was CHARGED; it must match what we asked for.
  // Anything else is a misconfiguration or tampering, and needs a human.
  if (Number(paidAmount) !== Number(order.amount) || String(paidCurrency || '').toUpperCase() !== order.currency) {
    console.error(`[payments] AMOUNT MISMATCH on ${orderId}: expected ${formatAmount(order.amount, order.currency)}, provider reported ${paidAmount} ${paidCurrency} — not fulfilled`);
    return false;
  }
  const r = await db.query(FULFIL_SQL, [orderId, access.newPaidCode()]);
  if (r.rows.length) {
    console.log(`[payments] order ${orderId} paid — ${order.credits} credit(s) ${order.topup ? 'added to existing code' : 'on a new code'}, balance ${r.rows[0].left}`);
  }
  return true;
}

async function cancel(orderId) {
  await db.query(`UPDATE orders SET status = 'cancelled' WHERE order_id = $1 AND status = 'pending'`, [orderId]);
}

// Called by POST /api/payments/webhook with the UNPARSED body, which the
// signature is computed over. Throws when the signature does not verify.
async function handleWebhook(rawBody, headers) {
  const evt = provider().verifyWebhook(rawBody, headers);
  if (!evt || !evt.orderId) return { handled: false };
  if (evt.paid) await fulfil(evt.orderId, evt.amount, evt.currency);
  else if (evt.cancelled) await cancel(evt.orderId);
  return { handled: true };
}

// What the return page polls. The order id is 96 random bits that only the
// payer's browser was given, so it is safe to hand the code back to whoever
// presents it.
async function status(orderId) {
  let order = await getOrder(orderId);
  if (!order) return null;

  // Webhooks can lag. If the provider can be asked directly, ask.
  const p = provider();
  if (order.status === 'pending' && typeof p.getStatus === 'function') {
    try {
      const st = await p.getStatus(order);
      if (st && st.paid) {
        await fulfil(order.order_id, st.amount, st.currency);
        order = await getOrder(orderId);
      }
    } catch (e) {
      console.warn(`[payments] status check for ${orderId} failed: ${e.message}`);
    }
  }

  const out = { status: order.status, credits: order.credits, topup: !!order.topup };
  if (order.status === 'paid' && order.code) {
    out.code = access.displayCode(order.code);
    const b = await access.paidBalance(order.code);
    out.balance = b ? b.left : 0;
  }
  return out;
}


// ── helpers ─────────────────────────────────────────────────
function formatAmount(minor, currency) {
  return `${currency} ${(Number(minor) / 100).toFixed(Number(minor) % 100 ? 2 : 0)}`;
}

// For the pricing section: what can be bought, and whether buying works.
function publicPlans() {
  if (!enabled()) return { enabled: false, plans: [] };
  return {
    enabled:     true,
    plans:       plans(),
    callSeconds: access.callSeconds('paid'),
    testMode:    providerName() === 'mock'
  };
}

// Lets a provider add its own routes (the mock's fake checkout page).
function mountProviderRoutes(app) {
  if (!enabled()) return;
  const p = provider();
  if (typeof p.routes === 'function') p.routes(app, { getOrder, formatAmount });
}

module.exports = {
  enabled,
  providerName,
  plans,
  publicPlans,
  configProblems,
  createCheckout,
  handleWebhook,
  status,
  getOrder,
  formatAmount,
  mountProviderRoutes,
  isProduction
};
