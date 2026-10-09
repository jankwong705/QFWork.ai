// ============================================================
// QFwork.ai — Admin endpoints
// ------------------------------------------------------------
// For support: "my code says 0 sessions", "I lost my code", a goodwill
// refund. Every route needs   Authorization: Bearer <ADMIN_TOKEN>
// and the whole router answers 404 when ADMIN_TOKEN is not set, so a
// deployment without one exposes nothing.
//
//   GET  /api/admin/codes?limit=50        → recent paid codes and balances
//   GET  /api/admin/codes/:code           → one code, with its orders
//   POST /api/admin/codes  { credits, note } → issue a code by hand
//   POST /api/admin/codes/:code/credits  { delta, note } → add (or remove) credits
//   GET  /api/admin/orders?limit=50       → recent orders
//   GET  /api/admin/export                → every table, as JSON
//
// e.g.  curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/api/admin/codes
// ============================================================

const crypto  = require('crypto');
const express = require('express');
const db      = require('./db');
const access  = require('./access');

const router = express.Router();

function tokenOk(given) {
  const want = String(process.env.ADMIN_TOKEN || '');
  if (!want) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  if (!process.env.ADMIN_TOKEN) return res.status(404).end();
  if (access.tooManyAttempts('admin:' + req.ip)) return res.status(429).json({ error: 'Too many attempts.' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  if (!m || !tokenOk(m[1].trim())) return res.status(401).json({ error: 'Admin token required.' });
  access.clearAttempts('admin:' + req.ip);
  next();
});

function limitOf(req) {
  const n = parseInt(req.query.limit, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 50;
}

function codeRow(r) {
  return {
    code:    access.displayCode(r.code),
    total:   Number(r.credits_total),
    used:    Number(r.credits_used),
    left:    Math.max(0, Number(r.credits_total) - Number(r.credits_used)),
    plan:    r.plan,
    note:    r.note,
    created: r.created_at
  };
}

const wrap = (fn) => (req, res) => fn(req, res).catch(e => {
  console.error(`[admin] ${e.message}`);
  res.status(500).json({ error: e.message });
});

router.get('/codes', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM paid_codes ORDER BY created_at DESC LIMIT $1', [limitOf(req)]);
  res.json({ codes: r.rows.map(codeRow) });
}));

router.get('/codes/:code', wrap(async (req, res) => {
  const code = access.normCode(req.params.code);
  const r = await db.query('SELECT * FROM paid_codes WHERE code = $1', [code]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such paid code.' });
  const o = await db.query('SELECT order_id, plan, credits, amount, currency, status, topup, created_at, paid_at FROM orders WHERE code = $1 ORDER BY created_at', [code]);
  res.json({ ...codeRow(r.rows[0]), orders: o.rows });
}));

router.post('/codes', wrap(async (req, res) => {
  const credits = parseInt(req.body && req.body.credits, 10);
  if (!(credits > 0 && credits <= 1000)) return res.status(400).json({ error: 'credits must be 1–1000.' });
  const code = access.newPaidCode();
  const note = String((req.body && req.body.note) || 'issued by admin').slice(0, 200);
  await db.query('INSERT INTO paid_codes (code, credits_total, plan, note) VALUES ($1, $2, $3, $4)', [code, credits, 'manual', note]);
  console.log(`[admin] issued a code with ${credits} credit(s) — ${note}`);
  res.json({ code: access.displayCode(code), credits });
}));

router.post('/codes/:code/credits', wrap(async (req, res) => {
  const code  = access.normCode(req.params.code);
  const delta = parseInt(req.body && req.body.delta, 10);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1000) return res.status(400).json({ error: 'delta must be a non-zero integer up to ±1000.' });
  // Never take the total below what has already been used.
  const r = await db.query(
    `UPDATE paid_codes SET credits_total = GREATEST(credits_total + $2, credits_used),
            note = COALESCE($3, note)
      WHERE code = $1 RETURNING *`,
    [code, delta, req.body.note ? String(req.body.note).slice(0, 200) : null]);
  if (!r.rows.length) return res.status(404).json({ error: 'No such paid code.' });
  console.log(`[admin] ${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} credit(s) on a paid code`);
  res.json(codeRow(r.rows[0]));
}));

router.get('/orders', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT $1', [limitOf(req)]);
  res.json({ orders: r.rows.map(o => ({ ...o, code: o.code ? access.displayCode(o.code) : null })) });
}));

router.get('/export', wrap(async (req, res) => {
  const [codes, orders, trial] = await Promise.all([
    db.query('SELECT * FROM paid_codes ORDER BY created_at'),
    db.query('SELECT * FROM orders ORDER BY created_at'),
    db.query('SELECT * FROM trial_code_runs ORDER BY code')
  ]);
  res.setHeader('Content-Disposition', `attachment; filename="qfwork-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), paid_codes: codes.rows, orders: orders.rows, trial_code_runs: trial.rows });
}));

module.exports = router;
