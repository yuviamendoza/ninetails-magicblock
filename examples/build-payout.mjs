// Builds (does not sign or send) one MagicBlock private payout with the Ninetails platform fee embedded.
// Read-only: it only calls MagicBlock's public builder and prints what it returned.
//
//   node examples/build-payout.mjs <senderPubkey> <recipientPubkey> [lamports]
//
// Needs Node 18+ (global fetch).

const API = 'https://payments.magicblock.app';
const WSOL = 'So11111111111111111111111111111111111111112';
// Ninetails fee vault (owner 7t4RCc1JfBNbtUguW4JDQ8PPNuLGvNQBum8t9XSRiiuJ): its wrapped-SOL token account.
const FEE_ACCOUNT_WSOL = '98umJRd4txSrB4LVhu3AjpdoGqhgwsPCn4SRN7BpBLdk';

const [from, to, amount = '20000000'] = process.argv.slice(2);
if (!from || !to) { console.error('usage: node examples/build-payout.mjs <sender> <recipient> [lamports]'); process.exit(1); }

async function build(extra) {
  const res = await fetch(API + '/v1/spl/transfer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to, mint: WSOL, amount: Number(amount),
      cluster: 'mainnet',
      visibility: 'private',        // MagicBlock private payment
      fromBalance: 'base', toBalance: 'base',
      minDelayMs: '0', maxDelayMs: '0', // Ninetails sets a delay window here for staggered payouts
      initIfMissing: true, initAtasIfMissing: true, initVaultIfMissing: false,
      ...extra,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.transactionBase64) throw new Error('builder: ' + (json.error || json.message || res.status));
  return json;
}

const plain = await build({});
const withFee = await build({ platformFeeBps: 40, platformFeeAccount: FEE_ACCOUNT_WSOL });

for (const [name, r] of [['without platform fee', plain], ['with 40 bps platform fee', withFee]]) {
  console.log(name);
  console.log('  sendTo          :', r.sendTo);
  console.log('  required signers:', JSON.stringify(r.requiredSigners));
  console.log('  fees            :', JSON.stringify(r.fees));
}
console.log('\nThe platform fee is charged on top of the amount, in the transferred token, and credited to platformFeeAccount.');
console.log('Nothing was signed or sent.');
