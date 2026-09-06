// ============================================================
// QFwork.ai — Access gate (shared by index.html and exam.html)
// ------------------------------------------------------------
// Covers the page with a code prompt until the server hands back a trial
// session. Loaded as a plain script by both pages, so the gate lives in
// one place and neither page needs a build step.
//
// This is the front door, not the lock: it exists so visitors see a code
// prompt rather than a live product. The actual control is server-side —
// /api/conversation, /api/analyze and /api/interview-feedback all require
// the session token this script obtains. Bypassing the overlay gets you a
// landing page and nothing else.
//
// Exposes:
//   window.QFAccess.token()        → session token, or null
//   window.QFAccess.tier()         → 'demo' | 'sales' | null
//   window.QFAccess.calendlyUrl()  → booking link from the server
//   window.QFAccess.runsLeft()     → number, or null when uncapped
//   window.QFAccess.headers()      → { 'X-QF-Access': token } for fetch()
//   window.QFAccess.expired()      → re-show the gate (a 401 came back)
// Fires a 'qf-access-granted' event on document once the page is unlocked.
// ============================================================
(function () {
  'use strict';

  var STORE_KEY = 'qfAccess';
  var session = { token: null, tier: null, runsLeft: null, calendlyUrl: '' };

  // Hide the page from the first parsed byte. The overlay can only be appended
  // once <body> exists, and without this the product flashes up in between.
  document.documentElement.classList.add('qf-booting');

  // ── persisted session ──
  // sessionStorage, not localStorage: closing the tab ends the trial, and the
  // server-side run counter means a reload cannot buy extra calls anyway.
  function load() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (raw) session = Object.assign(session, JSON.parse(raw));
    } catch (e) { /* private mode / storage disabled — just show the gate */ }
  }
  function save() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch (e) {}
  }
  function clear() {
    session = { token: null, tier: null, runsLeft: null, calendlyUrl: '' };
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  // ── styles ──
  var css = document.createElement('style');
  css.textContent = [
    '#qf-gate{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;',
    '  background:#0d1b24;background-image:radial-gradient(70% 60% at 80% 10%,rgba(13,122,111,.35),transparent 65%),',
    '  radial-gradient(60% 60% at 10% 95%,rgba(239,106,61,.22),transparent 65%);',
    '  font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-y:auto;}',
    '#qf-gate[hidden]{display:none;}',
    '.qf-gate-card{width:100%;max-width:420px;background:#fff;border-radius:20px;padding:34px 30px 30px;',
    '  box-shadow:0 30px 70px rgba(2,6,23,.45);animation:qf-gate-rise .4s cubic-bezier(.22,.61,.36,1) both;}',
    '@keyframes qf-gate-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
    '.qf-gate-brand{display:flex;align-items:center;gap:10px;margin-bottom:22px;}',
    '.qf-gate-brand img{width:34px;height:34px;object-fit:contain;display:block;}',
    '.qf-gate-brand .qf-gate-mark{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;',
    '  background:linear-gradient(135deg,#ef6a3d,#f59e6b);color:#fff;font-weight:700;font-size:13px;}',
    '.qf-gate-brand .qf-gate-name{font-weight:700;font-size:16px;letter-spacing:-.01em;color:#101828;}',
    '.qf-gate-brand .qf-gate-name span{color:#0d7a6f;}',
    '.qf-gate-card h2{margin:0 0 8px;font-size:21px;letter-spacing:-.01em;color:#101828;font-weight:600;}',
    '.qf-gate-card p.qf-gate-lede{margin:0 0 22px;font-size:14px;line-height:1.55;color:#667085;}',
    '.qf-gate-card label{display:block;font-size:13px;font-weight:600;color:#101828;margin-bottom:7px;}',
    '#qf-gate-input{width:100%;box-sizing:border-box;border:1px solid #e7eaee;border-radius:12px;',
    '  padding:13px 15px;font:inherit;font-size:16px;letter-spacing:.06em;color:#101828;background:#fcfdfd;}',
    '#qf-gate-input:focus{outline:none;border-color:#0d7a6f;box-shadow:0 0 0 3px rgba(13,122,111,.14);}',
    '#qf-gate-input.qf-bad{border-color:#dc2626;box-shadow:0 0 0 3px rgba(220,38,38,.12);}',
    '#qf-gate-btn{width:100%;margin-top:14px;border:0;border-radius:12px;background:#0d7a6f;color:#fff;',
    '  font:inherit;font-size:16px;font-weight:600;padding:14px 22px;cursor:pointer;transition:.15s;}',
    '#qf-gate-btn:hover:not(:disabled){background:#0a5f56;}',
    '#qf-gate-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '#qf-gate-err{min-height:19px;margin:11px 0 0;font-size:13px;line-height:1.5;color:#dc2626;}',
    '#qf-gate-err a{display:inline-block;margin-top:7px;color:#0d7a6f;font-weight:600;}',
    '.qf-gate-foot{margin:20px 0 0;padding-top:18px;border-top:1px solid #eef2f4;',
    '  font-size:12.5px;line-height:1.55;color:#98a2b3;}',
    '.qf-gate-foot a{color:#0d7a6f;}',
    'html.qf-locked,body.qf-locked{overflow:hidden;}',
    'html.qf-booting body{visibility:hidden!important;}'
  ].join('');
  document.head.appendChild(css);

  // ── overlay ──
  var overlay = document.createElement('div');
  overlay.id = 'qf-gate';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Access code required');
  overlay.innerHTML = [
    '<div class="qf-gate-card">',
    '  <div class="qf-gate-brand">',
    '    <img src="logo-mark.png" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'qf-gate-mark\',textContent:\'QF\'}))" />',
    '    <div class="qf-gate-name">QFwork<span>.ai</span></div>',
    '  </div>',
    '  <h2>Enter your access code</h2>',
    '  <p class="qf-gate-lede">Live practice sessions are invite-only while we are in trial. Enter the code from your invitation to begin.</p>',
    '  <form id="qf-gate-form" novalidate>',
    '    <label for="qf-gate-input">Access code</label>',
    '    <input id="qf-gate-input" type="text" name="code" autocomplete="off" autocapitalize="off"',
    '           spellcheck="false" placeholder="e.g. QFWORK-TRIAL-a308b5" aria-describedby="qf-gate-err" />',
    '    <p id="qf-gate-err" role="alert" aria-live="polite"></p>',
    '    <button id="qf-gate-btn" type="submit">Continue</button>',
    '  </form>',
    '  <p class="qf-gate-foot">Don\'t have a code? <a href="mailto:hello@qfwork.ai?subject=QFwork.ai%20trial%20access">Request access</a> and we\'ll send you one.</p>',
    '</div>'
  ].join('');

  var input, btn, err;

  function lock() {
    document.documentElement.classList.add('qf-locked');
    if (document.body) document.body.classList.add('qf-locked');
    overlay.hidden = false;
    if (input) { input.value = ''; input.classList.remove('qf-bad'); setTimeout(function () { input.focus(); }, 80); }
  }
  function unlock() {
    overlay.hidden = true;
    document.documentElement.classList.remove('qf-locked');
    if (document.body) document.body.classList.remove('qf-locked');
    document.dispatchEvent(new CustomEvent('qf-access-granted', {
      detail: { tier: session.tier, runsLeft: session.runsLeft, calendlyUrl: session.calendlyUrl }
    }));
  }

  function fail(msg) {
    err.textContent = msg;
    input.classList.add('qf-bad');
    input.focus();
    input.select();
  }

  // A used-up one-time code is a dead end: retyping it will never work, so the
  // refusal offers the booking link instead of inviting another attempt.
  // The message is set as text, never HTML — it comes from the server.
  function failSpent(msg, url) {
    err.textContent = msg;
    input.classList.add('qf-bad');
    if (!url) return;
    err.appendChild(document.createElement('br'));
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Book your free review →';
    err.appendChild(a);
  }

  // A code carried in the link (?code=QFWORK-TRIAL-a308b5). These are emailed
  // to people who open them on a phone, where typing the code by thumb is the
  // worst part of the experience.
  function codeFromUrl() {
    try {
      var v = new URLSearchParams(location.search).get('code');
      return v ? v.trim() : '';
    } catch (e) { return ''; }
  }

  async function submit(e) {
    if (e) e.preventDefault();
    var code = (input.value || '').trim();
    if (!code) return fail('Please enter your access code.');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    err.textContent = '';
    input.classList.remove('qf-bad');
    try {
      var r = await fetch('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code })
      });
      var data = await r.json().catch(function () { return {}; });
      if (r.status === 403 && data.code === 'trial-spent') {
        return failSpent(data.error || 'This code has already been used.', data.calendlyUrl);
      }
      if (!r.ok) return fail(data.error || 'Could not check that code. Please try again.');
      session = {
        token: data.token, tier: data.tier,
        runsLeft: data.runsLeft == null ? null : data.runsLeft,
        calendlyUrl: data.calendlyUrl || ''
      };
      save();
      unlock();
    } catch (e2) {
      fail('Network problem — check your connection and try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  }

  // A stored token may have expired while the tab sat open, or the server may
  // have restarted. Confirm it before revealing the page, so the visitor hits
  // the code prompt now rather than a 401 halfway into a call.
  async function revalidate() {
    if (!session.token) return false;
    try {
      var r = await fetch('/api/access/verify', { headers: { 'X-QF-Access': session.token } });
      if (!r.ok) { clear(); return false; }
      var data = await r.json();
      session.tier        = data.tier;
      session.runsLeft    = data.runsLeft == null ? null : data.runsLeft;
      session.calendlyUrl = data.calendlyUrl || '';
      save();
      return true;
    } catch (e) {
      clear();
      return false;
    }
  }

  function boot() {
    document.body.appendChild(overlay);
    input = document.getElementById('qf-gate-input');
    btn   = document.getElementById('qf-gate-btn');
    err   = document.getElementById('qf-gate-err');
    document.getElementById('qf-gate-form').addEventListener('submit', submit);

    load();
    lock();                       // locked by default — never flash the product
    document.documentElement.classList.remove('qf-booting');
    revalidate().then(function (ok) {
      if (ok) return unlock();
      var pre = codeFromUrl();
      if (!pre) return;
      input.value = pre;
      // Take the code back out of the address bar — these links get screen-
      // shared, and a stale one in history is just confusing.
      try {
        var u = new URL(location.href);
        u.searchParams.delete('code');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      } catch (e) {}
      submit();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.QFAccess = {
    token:       function () { return session.token; },
    tier:        function () { return session.tier; },
    runsLeft:    function () { return session.runsLeft; },
    calendlyUrl: function () { return session.calendlyUrl; },
    setRunsLeft: function (n) { session.runsLeft = n == null ? null : n; save(); },
    headers:     function () { return session.token ? { 'X-QF-Access': session.token } : {}; },
    // Called by the pages when an API returns 401 mid-flow.
    expired:     function () { clear(); lock(); err.textContent = 'Your session expired. Please enter your code again.'; }
  };
})();
