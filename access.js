// ============================================================
// QFwork.ai — Access control
// ------------------------------------------------------------
// The product is a paid demo: every live call spends Tavus minutes and
// Groq tokens, so the trial is gated behind a shared access code.
//
// Two codes, two tiers:
//   demo   → our own demos. Full report, no run cap.
//   sales  → prospects. One run, and the deep sections of the report are
//            withheld so a recruitment expert can walk them through it
//            on the follow-up call.
//
// The code check is a plain string compare. The real control is that the
// three token-spending endpoints require a session token issued here, so
// the codes never reach the browser and a bypassed front-end gate buys
// nothing.
// ============================================================

const crypto = require('crypto');

const SESSION_TTL_MS   = 4 * 60 * 60 * 1000;   // a trial session is good for an afternoon
const UNLIMITED        = Infinity;

// token → { tier, runs, at }
// In memory on purpose: a redeploy resets it, which costs us at most a few
// extra trial runs. Persisting it would mean a database for a demo gate.
const sessions = new Map();

// ip → { count, windowStart } — blunt brute-force guard on the code check.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 60 * 1000;
const ATTEMPT_MAX       = 8;


// ── configuration ───────────────────────────────────────────
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Number of runs a tier gets. Blank or 0 in the environment means unlimited.
function runCap(tier) {
  const raw = tier === 'demo' ? process.env.TRIAL_RUNS_DEMO : process.env.TRIAL_RUNS_SALES;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return tier === 'demo' ? UNLIMITED : 1;
  return n;
}

function configuredCodes() {
  return {
    demo:  norm(process.env.ACCESS_CODE_DEMO),
    sales: norm(process.env.ACCESS_CODE_SALES)
  };
}

// True when at least one code is set. With none set the gate would lock
// everybody out, so the server refuses to run that way (see server.js).
function isConfigured() {
  const c = configuredCodes();
  return !!(c.demo || c.sales);
}


// ── code check ──────────────────────────────────────────────
// Returns 'demo' | 'sales' | null. Case- and whitespace-insensitive, so a
// code read off a slide still works when someone types it with a capital.
function checkCode(input) {
  const given = norm(input);
  if (!given) return null;
  const c = configuredCodes();
  if (c.demo  && given === c.demo)  return 'demo';
  if (c.sales && given === c.sales) return 'sales';
  return null;
}

// Rate limit by IP so the codes can't be guessed in a loop.
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > ATTEMPT_MAX;
}

function clearAttempts(ip) {
  attempts.delete(ip);
}


// ── sessions ────────────────────────────────────────────────
function purgeStale() {
  const now = Date.now();
  for (const [token, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(token);
  for (const [ip, a] of attempts) if (now - a.windowStart > ATTEMPT_WINDOW_MS) attempts.delete(ip);
}

function openSession(tier) {
  purgeStale();
  const token = crypto.randomUUID();
  sessions.set(token, { tier, runs: 0, at: Date.now() });
  return token;
}

function getSession(token) {
  purgeStale();
  if (!token) return null;
  const s = sessions.get(String(token));
  if (!s) return null;
  s.at = Date.now();          // sliding expiry — an active trial doesn't time out mid-call
  return s;
}

function runsLeft(session) {
  const cap = runCap(session.tier);
  if (cap === UNLIMITED) return null;              // null → "no cap" for the client
  return Math.max(0, cap - session.runs);
}

// Charge one run against the session. Called only from /api/conversation,
// the point at which Tavus starts billing.
// Returns { ok:true, runsLeft } or { ok:false, reason }.
function consumeRun(session) {
  const cap = runCap(session.tier);
  if (cap !== UNLIMITED && session.runs >= cap) {
    return { ok: false, reason: 'trial-spent' };
  }
  session.runs++;
  return { ok: true, runsLeft: runsLeft(session) };
}


// ── express helper ──────────────────────────────────────────
// Reads the token from the X-QF-Access header (or an accessToken body field
// for sendBeacon calls, which cannot set headers) and resolves the session.
// Responds 401 and returns null when there isn't a valid one.
function requireSession(req, res) {
  const token = req.get('X-QF-Access') || (req.body && req.body.accessToken) || req.query.accessToken;
  const session = getSession(token);
  if (!session) {
    res.status(401).json({ error: 'Your trial session has expired. Reload the page and enter your access code again.', code: 'no-session' });
    return null;
  }
  return session;
}


// ── report gating (tier: sales) ─────────────────────────────
// Withheld sections are REMOVED from the payload rather than hidden in CSS,
// so they are absent from view-source, from Print / Save as PDF and from the
// downloadReport() export. The client renders a locked placeholder for each.
const LOCKED_SECTIONS = ['presence', 'voice', 'corrections', 'model', 'detail'];

function redactForTier(feedback, tier) {
  if (tier !== 'sales' || !feedback) return { feedback, locked: [] };

  const f = { ...feedback };
  const locked = [];

  // Keep the headline verdict intact — score, band, coach's take, summary and
  // the four metrics are what make the follow-up call worth booking.

  // One strength and one improvement stay visible as a taste of the detail.
  const strengths    = Array.isArray(f.strengths)    ? f.strengths.filter(Boolean)    : [];
  const improvements = Array.isArray(f.improvements) ? f.improvements.filter(Boolean) : [];
  f.strengthsHeldBack    = Math.max(0, strengths.length - 1);
  f.improvementsHeldBack = Math.max(0, improvements.length - 1);
  f.strengths    = strengths.slice(0, 1);
  f.improvements = improvements.slice(0, 1);
  if (f.strengthsHeldBack || f.improvementsHeldBack) locked.push('detail');

  if (f.presenceFeedback || (Array.isArray(f.presencePoints) && f.presencePoints.filter(Boolean).length)) {
    locked.push('presence');
  }
  f.presenceFeedback = '';
  f.presencePoints   = [];

  const va = f.voiceAnalysis || {};
  if (va.toneIntonation || va.pacing || va.clarityPronunciation || va.vocalEnergy) locked.push('voice');
  f.voiceAnalysis = {};

  if (Array.isArray(f.sentenceCorrections) && f.sentenceCorrections.length) locked.push('corrections');
  f.sentenceCorrections = [];

  if (f.rewrittenResponse) locked.push('model');
  f.rewrittenResponse = '';

  // The transcript-derived language notes are left in — they read as
  // measurement rather than coaching, and they show the report is real.

  return { feedback: f, locked };
}


module.exports = {
  isConfigured,
  checkCode,
  tooManyAttempts,
  clearAttempts,
  openSession,
  getSession,
  requireSession,
  consumeRun,
  runsLeft,
  runCap,
  redactForTier,
  LOCKED_SECTIONS,
  UNLIMITED
};
