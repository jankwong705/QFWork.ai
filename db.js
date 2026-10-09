// ============================================================
// QFwork.ai — Database
// ------------------------------------------------------------
// Everything that has to outlive a deploy lives here: which one-time trial
// codes are spent, which paid codes exist and what they have left, and every
// checkout order. Render's filesystem is wiped on each deploy, so none of it
// can sit in a file next to server.js any more.
//
// Two backends, one SQL dialect:
//   • DATABASE_URL set   → Postgres over the network (Neon in production).
//   • DATABASE_URL blank → PGlite, real Postgres compiled to WebAssembly and
//                          running in-process, stored under .data/. Nothing to
//                          install and no account, so development and the
//                          placeholder phase work out of the box.
// Both run the same queries, so nothing behaves differently when the
// connection string is pasted in.
//
// The one rule PGlite cannot follow is durability on a host that wipes its
// disk. server.js refuses to take payments on it in production.
// ============================================================

const fs   = require('fs');
const path = require('path');

const PGLITE_DIR = process.env.PGLITE_DIR || path.join(__dirname, '.data', 'pglite');

let backend = null;   // { kind, label, query(text, params), exec(sql), close() }

const SCHEMA = `
  -- Runs spent per one-time trial code (ACCESS_CODES_TRIAL). The issued list
  -- stays in the environment; only what each code has used is state.
  CREATE TABLE IF NOT EXISTS trial_code_runs (
    code        TEXT PRIMARY KEY,
    runs        INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per checkout. Created 'pending' when the visitor is sent to the
  -- provider, flipped to 'paid' exactly once by the webhook. The price and
  -- credits are recorded HERE, at checkout, so a webhook can only ever confirm
  -- what the server itself asked for.
  CREATE TABLE IF NOT EXISTS orders (
    order_id      TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    provider_ref  TEXT,
    plan          TEXT NOT NULL,
    credits       INTEGER NOT NULL,
    amount        INTEGER NOT NULL,          -- minor units (cents)
    currency      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | cancelled
    code          TEXT,                      -- set at checkout for a top-up, at payment otherwise
    topup         BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at       TIMESTAMPTZ
  );

  -- Paid access codes and their balance. Stored normalised (lowercase
  -- alphanumerics), the same form access.js compares against.
  CREATE TABLE IF NOT EXISTS paid_codes (
    code           TEXT PRIMARY KEY,
    credits_total  INTEGER NOT NULL,
    credits_used   INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
    plan           TEXT,
    order_id       TEXT,
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;


async function openPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30000 });
  // Neon closes idle connections. Without a listener, that error on an idle
  // client would crash the process.
  pool.on('error', (e) => console.warn(`[db] idle connection dropped: ${e.message}`));
  await pool.query('SELECT 1');
  let host = 'postgres';
  try { host = new URL(url).hostname; } catch (e) {}
  return {
    kind:  'postgres',
    label: `Postgres (${host})`,
    query: (text, params) => pool.query(text, params),
    exec:  (sql) => pool.query(sql),
    close: () => pool.end()
  };
}

async function openPglite(dir) {
  // ESM-only package, hence the dynamic import from this CommonJS module.
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind:  'pglite',
    label: `PGlite, local (${dir.startsWith(__dirname) ? path.relative(__dirname, dir) : dir})`,
    query: async (text, params) => {
      const r = await db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows != null ? r.affectedRows : r.rows.length };
    },
    exec:  (sql) => db.exec(sql),
    close: () => db.close()
  };
}

// Connects and creates the tables. Called once before the server listens;
// a failure here stops the boot, because every paid path depends on it.
async function init() {
  const url = (process.env.DATABASE_URL || '').trim();
  backend = url ? await openPostgres(url) : await openPglite(PGLITE_DIR);
  await backend.exec(SCHEMA);
  return backend;
}

function query(text, params) {
  if (!backend) return Promise.reject(new Error('Database not initialised'));
  return backend.query(text, params);
}

module.exports = {
  init,
  query,
  kind:  () => backend && backend.kind,
  label: () => backend ? backend.label : 'not connected',
  close: () => backend && backend.close()
};
