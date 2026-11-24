// MagicBlock (SOL, USDC, USDT): take the Ninetails fee INSIDE each MagicBlock payout transaction instead of a separate
// fee transaction. Behind NT_CONFIG.platformFee.magicblockEmbedFee (default off; on QA hosts also localStorage
// nt_mb_embed_qa = "1"). With the flag off nothing here runs: enabled() and eligible() are false and the page keeps the
// separate fee leg exactly as before.
//
// How the fee is taken: MagicBlock's builder (POST /v1/spl/transfer, visibility private, base -> base) accepts
// platformFeeBps and platformFeeAccount. The fee is charged ON TOP of `amount`, in the transferred token (wrapped SOL
// for SOL, USDC, USDT), and credited to platformFeeAccount, which must be an initialized token account of that mint.
// Measured on the live builder (read only): SOL amount 20,000,000 -> fees.tokens 20,000 without a platform fee and
// 100,000 with platformFeeBps 40; USDC and USDT amount 5,000,000 -> 5,000 and 25,000. fees.lamports 2,039,280 either
// way, the sender still the only signer.
//
// Revenue stays what it is today. Today the fee is 40 bps of the WHOLE wallet share g (the separate fee leg):
//   f = floor(g * 40 / 10,000)
// MagicBlock applies platformFeeBps to the amount it transfers (A), which excludes MagicBlock's own 0.1% and, for SOL,
// the 0.0072 SOL reserve. So each payout gets its own whole-number bps b (1 to 200, MAX_SCHEDULE_BPS):
//   for each b, A_b = the largest A with A + ceil(A * 10 / 10,000) + floor(A * b / 10,000) + reserve <= g, lowered by
//   at most 5,000 / b units so that A * b / 10,000 has a fractional part below one half (floor and round-half agree);
//   b = the one whose fee floor(A_b * b / 10,000) is closest to f (ties: the higher fee); A = A_b; fee = floor(A * b /
//   10,000). reserve = 7,200,000 lamports for SOL (MB_SOL_FIXED), 0 for USDC and USDT.
// Tolerance: |fee - f| <= floor(g / 10,000), one base unit per 10,000 of the share (0.01% of the share). In practice the
// difference is at most about half a bp of A (b is the nearest whole bp). A payout outside it (the share too small for
// the bps grid, or more than 200 bps needed) keeps the whole order on the separate fee. The recipient gets A, within
// about the same half bp of what it gets today, and the review shows exactly A and fee.
//
// Before ANY wallet prompt each built payout is checked: response shape, the sender as the only signer, size,
// MagicBlock's own fee accounting (fees.tokens == fee + its 0.1%), and a simulation proving the fee token account grows
// by exactly `fee`. Any problem (builder refused the fee fields, fee account missing or not the vault's account of that
// mint, unexpected shape, a different rounding, simulation) throws EmbedFallback and the page charges the same fee as
// one separate transfer (the existing fee leg), then builds the payouts without the fee fields, with the same
// recipient amounts. The fee is therefore never charged twice: a leg is either 'mb_embed' (fee inside its payout,
// never in the fee leg) or 'fee_leg' (fee leg only).
(() => {
  'use strict';

  const VAULT = '7t4RCc1JfBNbtUguW4JDQ8PPNuLGvNQBum8t9XSRiiuJ';
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKENS = ['SOL', 'USDC', 'USDT'];
  const MINTS = { SOL: 'So11111111111111111111111111111111111111112', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' };
  // The vault owner's associated token account per mint (deploy/fee-token-account.mjs derives them).
  const FEE_ACCOUNTS = { SOL: '98umJRd4txSrB4LVhu3AjpdoGqhgwsPCn4SRN7BpBLdk', USDC: '8PJ4mHi3jUiViAKSKRZBUxfCWn9o34WLKVbHkuvvJN72', USDT: '58tc8wX1zDJb3Dkt6fTe6cDoVUsBHawTJni72Fjz8vaj' };
  const RESERVE = { SOL: 7200000n, USDC: 0n, USDT: 0n }; // MB_SOL_FIXED in index.html (0.0072 SOL); tokens have none
  const RAIL_BPS = 10n; // MagicBlock's own fee, MB_FEE in index.html (0.1%)
  const MAX_BPS = 200; // platform-fee.js MAX_SCHEDULE_BPS
  const DEN = 10000n;
  const SIZE_LIMIT = 1232;
  const OK_TTL = 60e3; // a fresh check before a split if the last one is older than this
  const BAD_TTL = 20e3;
  const SHOW_TTL = 10 * 60e3; // the review trusts a good check this old
  const BIND_MS = 15e3; // bounded wait to bind the payout signatures to the order (same as the fee leg)
  const QA_HOSTS = ['staging.ninetails.trade', 'ninetails-site-staging.adam-6d1.workers.dev', 'localhost', '127.0.0.1'];
  const QA_KEY = 'nt_mb_embed_qa';
  const OFF_KEY = 'nt_mb_embed_off'; // sessionStorage: this tab uses the separate fee again

  const g = typeof window !== 'undefined' ? window : globalThis;
  const store = name => { try { return g[name] || null; } catch { return null; } };

  /* ---------- base58 / base64 ---------- */
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58enc = bytes => {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) + BigInt(b);
    let out = '';
    while (n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
    return out;
  };
  const b64bytes = text => { const raw = atob(text); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i); return out; };
  const bytesB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const u64 = (bytes, at) => { let v = 0n; for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[at + i]); return v; };

  /* ---------- config ---------- */
  const qaOptIn = () => {
    try { return QA_HOSTS.includes(g.location && g.location.hostname) && !!store('localStorage') && g.localStorage.getItem(QA_KEY) === '1'; } catch { return false; }
  };
  // The configured fee token account for this token, only if it is exactly the vault's associated token account of
  // that mint. On QA hosts with the QA opt-in, a config without the map (the hosting overlays) uses the same fixed
  // accounts. Anything else: null (off for that token).
  function feeAccount(token) {
    const cfg = g.NT_CONFIG && g.NT_CONFIG.platformFee;
    if (!cfg || !TOKENS.includes(token)) return null;
    const map = cfg.magicblockFeeAccounts;
    if (map && typeof map === 'object') return map[token] === FEE_ACCOUNTS[token] ? FEE_ACCOUNTS[token] : null;
    return map === undefined && qaOptIn() ? FEE_ACCOUNTS[token] : null;
  }
  function enabled() {
    try {
      const s = store('sessionStorage');
      if (s && s.getItem(OFF_KEY) === '1') return false;
    } catch {}
    const cfg = g.NT_CONFIG && g.NT_CONFIG.platformFee;
    if (!cfg || cfg.solDestination !== VAULT) return false;
    return cfg.magicblockEmbedFee === true || qaOptIn();
  }
  // Ninetails' schedule rate for MagicBlock (40 bps today): what the separate fee leg charges on the whole share.
  function bpsFor(staggered) {
    const P = g.NTPlatformFee;
    if (!P || typeof P.rateFor !== 'function' || typeof P.scheduleInfo !== 'function' || !P.scheduleInfo()) return 0;
    const bps = P.rateFor({ route: 'magicblock', staggered: !!staggered });
    return Number.isInteger(bps) && bps > 0 && bps <= MAX_BPS ? bps : 0;
  }

  /* ---------- math ---------- */
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  // Largest A for bps b inside the share, then lowered so the fee's fractional part is below one half.
  function largestA(G, reserve, b) {
    const B = BigInt(b);
    let A = (G - reserve) * DEN / (DEN + RAIL_BPS + B) + 2n;
    const spend = x => x + ceilDiv(x * RAIL_BPS, DEN) + x * B / DEN + reserve;
    while (A > 0n && spend(A) > G) A -= 1n;
    const r = A * B % DEN;
    if (r >= 5000n) A -= ceilDiv(r - 4999n, B);
    return A > 0n && spend(A) <= G ? A : 0n;
  }
  // One wallet: gross share -> { a (to the recipient), fee (Ninetails), bps, todayFee, rail, amount (g - fee) } or null.
  function split(gross, { token = 'SOL', scheduleBps = 40 } = {}) {
    if (!Number.isSafeInteger(gross) || gross <= 0 || !TOKENS.includes(token) || !Number.isInteger(scheduleBps) || scheduleBps <= 0) return null;
    const G = BigInt(gross), reserve = RESERVE[token];
    if (G <= reserve) return null;
    const f = G * BigInt(scheduleBps) / DEN, tol = G / DEN;
    // The bps that would make the fee exactly f with the whole share used: b* = f * 10,010 / (g - reserve - f).
    const room = G - reserve - f;
    if (room <= 0n) return null;
    const star = Number(f * (DEN + RAIL_BPS)) / Number(room);
    if (!(star > 0) || star > MAX_BPS + 1) return null;
    let best = null;
    for (let b = Math.max(1, Math.floor(star) - 1); b <= Math.min(MAX_BPS, Math.ceil(star) + 1); b += 1) {
      const A = largestA(G, reserve, b);
      if (A <= 0n) continue;
      const fee = A * BigInt(b) / DEN, d = fee > f ? fee - f : f - fee;
      if (!best || d < best.d || (d === best.d && fee > best.fee)) best = { b, A, fee, d };
    }
    if (!best || best.d > tol) return null;
    return { a: Number(best.A), fee: Number(best.fee), bps: best.b, todayFee: Number(f), rail: Number(ceilDiv(best.A * RAIL_BPS, DEN)), amount: Number(G - best.fee), gross, token };
  }
  function plan({ grossBaseUnits, staggered = false, token = 'SOL' } = {}) {
    const scheduleBps = bpsFor(staggered);
    if (!scheduleBps || !Array.isArray(grossBaseUnits) || !grossBaseUnits.length) return null;
    const legs = grossBaseUnits.map(x => split(x, { token, scheduleBps }));
    if (legs.some(x => !x)) return null;
    return { token, scheduleBps, feeAccount: feeAccount(token), legs, fee: legs.reduce((s, x) => s + x.fee, 0), todayFee: legs.reduce((s, x) => s + x.todayFee, 0) };
  }

  /* ---------- fee account check (per mint, cached briefly) ---------- */
  const cache = {}; // token -> { ok, at, reason }
  // A token account (165 bytes, Token program) for this token's mint, owned by the vault, Initialized (not frozen).
  function accountProblem(value, token = 'SOL') {
    if (!value) return 'missing';
    if (value.owner !== TOKEN_PROGRAM) return 'not_token_account';
    const d = value.data;
    if (!Array.isArray(d) || d[1] !== 'base64') return 'unreadable';
    const bytes = b64bytes(d[0]);
    if (bytes.length !== 165) return 'not_token_account';
    if (b58enc(bytes.subarray(0, 32)) !== MINTS[token]) return 'wrong_mint';
    if (b58enc(bytes.subarray(32, 64)) !== VAULT) return 'wrong_owner';
    if (bytes[108] !== 1) return 'not_initialized';
    return null;
  }
  async function refresh(rpc, { force = false, token = 'SOL' } = {}) {
    const acct = feeAccount(token);
    if (!acct || typeof rpc !== 'function') { cache[token] = { ok: false, at: Date.now(), reason: 'not_configured' }; return false; }
    const c = cache[token];
    if (!force && c && Date.now() - c.at < (c.ok ? OK_TTL : BAD_TTL)) return c.ok;
    let reason;
    try {
      const r = await rpc('getAccountInfo', [acct, { encoding: 'base64', commitment: 'confirmed' }]);
      reason = accountProblem(r && r.value, token);
    } catch { reason = 'rpc'; }
    cache[token] = { ok: !reason, at: Date.now(), reason: reason || null };
    return cache[token].ok;
  }
  const ready = (token = 'SOL') => { const c = cache[token]; return !!(c && c.ok && Date.now() - c.at < SHOW_TTL); };
  function markBad(reason, token = 'SOL') { cache[token] = { ok: false, at: Date.now(), reason }; }

  /* ---------- eligibility ---------- */
  // Every wallet explicitly on MagicBlock (never Auto, never Ninetails Funding or MagicBlock + NEAR), the same token in
  // and out (SOL, USDC or USDT), the schedule charging MagicBlock, that token's fee account checked recently, every
  // share inside the fee tolerance. Mixed plans are not eligible: the whole order keeps the separate fee (it needs one
  // separate approval anyway, so embedding a part would save nothing and would split one fee across two mechanisms).
  function eligible({ token, tout, picks, routes, staggered = false, relay = false, grossBaseUnits, skipReady = false } = {}) {
    try {
      if (!enabled() || !TOKENS.includes(token) || (tout != null && tout !== token) || relay || !feeAccount(token)) return false;
      if (!Array.isArray(picks) || !picks.length || !picks.every(r => r === 'magicblock')) return false;
      if (routes !== undefined && (!Array.isArray(routes) || routes.length !== picks.length || !routes.every(r => r === 'magicblock'))) return false;
      if (!bpsFor(staggered)) return false;
      if (grossBaseUnits !== undefined && !plan({ grossBaseUnits, staggered, token })) return false;
      return skipReady || ready(token);
    } catch {
      return false;
    }
  }

  /* ---------- request + checks ---------- */
  const request = (bps, token = 'SOL') => ({ platformFeeBps: bps, platformFeeAccount: FEE_ACCOUNTS[token] });

  class EmbedFallback extends Error {
    constructor(reason, cause) { super('The Ninetails fee could not be added to the MagicBlock payout (' + reason + ')'); this.name = 'NTMbEmbedFallback'; this.code = 'mb_embed_fallback'; this.reason = reason; if (cause !== undefined) this.cause = cause; }
  }
  const isFallback = e => !!(e && e.code === 'mb_embed_fallback');

  // Static checks on one builder response and its deserialized transaction. Returns a reason or null.
  function shapeProblem({ response, tx, payer, a, fee, bps }) {
    if (!response || response.kind !== 'transfer' || response.sendTo !== 'base' || typeof response.transactionBase64 !== 'string') return 'response';
    if (response.requiredSigners !== undefined && (!Array.isArray(response.requiredSigners) || response.requiredSigners.length !== 1 || response.requiredSigners[0] !== payer)) return 'signers';
    const f = response.fees;
    let tokens;
    try { tokens = BigInt(f && f.tokens); } catch { return 'fees'; }
    const A = BigInt(a), F = BigInt(fee);
    if (F !== A * BigInt(bps) / DEN) return 'fees';
    // MagicBlock's total = our fee + its 0.1% of A, within one unit for its own rounding of the 0.1%.
    const gap = tokens * DEN - (F * DEN + A * RAIL_BPS);
    if (gap <= -DEN || gap >= DEN) return 'fees';
    const m = tx && tx.message;
    if (!m || !m.header || m.header.numRequiredSignatures !== 1) return 'signers';
    const keys = m.staticAccountKeys || m.accountKeys;
    if (!Array.isArray(keys) || !keys.length || String(keys[0] && (keys[0].toBase58 ? keys[0].toBase58() : keys[0])) !== payer) return 'payer';
    let size = 0;
    try { size = tx.serialize().length; } catch { return 'serialize'; }
    if (!(size > 0) || size > SIZE_LIMIT) return 'size';
    return null;
  }

  // Simulates the payout and requires this token's fee account to grow by exactly `fee`.
  async function simulateFee({ tx, rpc, fee, token = 'SOL' }) {
    const acct = feeAccount(token);
    if (!acct) return 'not_configured';
    const pre = await rpc('getAccountInfo', [acct, { encoding: 'base64', commitment: 'confirmed' }]);
    const why = accountProblem(pre && pre.value, token);
    if (why) { markBad(why, token); return why; }
    const before = u64(b64bytes(pre.value.data[0]), 64);
    const sim = await rpc('simulateTransaction', [bytesB64(tx.serialize()), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [acct] } }]);
    const v = sim && sim.value;
    if (!v || v.err) return 'simulation';
    const post = Array.isArray(v.accounts) && v.accounts[0];
    if (!post || accountProblem(post, token)) return 'simulation_account';
    return u64(b64bytes(post.data[0]), 64) - before === BigInt(fee) ? null : 'fee_amount';
  }

  // All embedded payouts of one batch, before any wallet prompt. Throws EmbedFallback on the first problem.
  async function check(items, { payer, rpc, token = 'SOL' }) {
    for (const it of items) {
      const leg = it.l;
      const why = shapeProblem({ response: it.o, tx: it.tx, payer, a: leg.mbAmt, fee: leg.platformFeeAmount, bps: it.bps });
      if (why) throw new EmbedFallback(why);
      let sim;
      try { sim = await simulateFee({ tx: it.tx, rpc, fee: leg.platformFeeAmount, token }); } catch (e) { throw new EmbedFallback('simulation', e); }
      if (sim) throw new EmbedFallback(sim);
    }
    return true;
  }

  // Bind payout signatures that carry the fee to the order (fee-legs takes at most 4 per call). Bounded; a failure
  // still sends the payouts, unbound, exactly like the separate fee leg (it then earns no ref reward).
  async function bind(sigs, bindFees, orderNumber, wallet) {
    if (!orderNumber || typeof bindFees !== 'function' || !sigs.length) return 'unavailable';
    const chunks = [];
    for (let i = 0; i < sigs.length; i += 4) chunks.push(sigs.slice(i, i + 4));
    try {
      const out = await Promise.race([Promise.all(chunks.map(c => bindFees(orderNumber, wallet, c, 8e3))), new Promise(z => setTimeout(() => z(['timeout']), BIND_MS))]);
      return out.every(x => x === 'bound') ? 'bound' : out.find(x => x !== 'bound') || 'retry';
    } catch { return 'retry'; }
  }

  // Resume: what happened to a signed payout that carries the fee. 'landed' | 'not_landed' | 'unknown'.
  const NOT_LANDED_MS = 18e4; // a blockhash is long expired after 3 minutes
  function outcome(status, ok, at, now = Date.now()) {
    if (!ok) return 'unknown';
    if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return 'landed';
    if (status && status.err) return 'not_landed';
    return now - (at || 0) > NOT_LANDED_MS ? 'not_landed' : 'unknown';
  }

  /* ---------- page glue ---------- */
  function pageRpc() { try { return typeof rpc === 'function' ? rpc : null; } catch { return null; } } // eslint-disable-line no-undef
  function prefetch(r, token) {
    if (!enabled()) return Promise.resolve(false);
    const list = token ? [token] : TOKENS.filter(t => feeAccount(t));
    return Promise.all(list.map(t => refresh(r || pageRpc(), { token: t }).catch(() => false))).then(x => x.every(Boolean));
  }
  function off() { try { const s = store('sessionStorage'); s && s.setItem(OFF_KEY, '1'); } catch {} }
  if (typeof g.setTimeout === 'function' && g.document) {
    g.setTimeout(() => { prefetch(); }, 1500);
    if (typeof g.setInterval === 'function') g.setInterval(() => { if (enabled()) prefetch(); }, 5 * 60e3);
  }

  g.NTMbEmbedFee = {
    VAULT, TOKEN_PROGRAM, MINTS: { ...MINTS }, FEE_ACCOUNTS: { ...FEE_ACCOUNTS }, RAIL_BPS: Number(RAIL_BPS), MAX_BPS, SIZE_LIMIT,
    reserve: token => Number(RESERVE[token] ?? 0n),
    enabled, feeAccount, bpsFor, split, plan, refresh, ready, markBad, accountProblem, eligible,
    request, shapeProblem, simulateFee, check, bind, outcome, prefetch, off, EmbedFallback, isFallback,
    status: token => (cache[token || 'SOL'] ? { ...cache[token || 'SOL'] } : null), reset: () => { for (const k of Object.keys(cache)) delete cache[k]; },
  };
})();
