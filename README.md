# Ninetails x MagicBlock

[Ninetails](https://ninetails.trade) is a non-custodial private multi-wallet swap on Solana. You deposit once, choose several destination wallets and how much each receives, and Ninetails delivers to each one through private payment routes. We never hold user funds, and the sender signs every transaction.

This repo is a small public extract for the MagicBlock Forge application. It contains only the MagicBlock part of the integration. The rest of the product lives in a private repo.

## How Ninetails uses MagicBlock

- **Private payouts.** Each recipient wallet gets its own MagicBlock private payment, built with the Payments API (`POST https://payments.magicblock.app/v1/spl/transfer`, `visibility: "private"`, `fromBalance: "base"`, `toBalance: "base"`). Tokens: SOL (wrapped), USDC and USDT.
- **Staggered delivery.** For staggered splits, each payout gets its own `minDelayMs` / `maxDelayMs` window in the same request, so delivery is scheduled without Ninetails holding any keys.
- **Sender is the only signer.** The page checks the built transaction before any wallet prompt.

## Platform fee attribution

Ninetails takes its fee inside the MagicBlock payout using the builder's `platformFeeBps` and `platformFeeAccount` fields, instead of a separate fee transaction.

- Fee vault (owner wallet): `7t4RCc1JfBNbtUguW4JDQ8PPNuLGvNQBum8t9XSRiiuJ`
- Fee token accounts (all owned by the vault): wrapped SOL `98umJRd4txSrB4LVhu3AjpdoGqhgwsPCn4SRN7BpBLdk`, USDC `8PJ4mHi3jUiViAKSKRZBUxfCWn9o34WLKVbHkuvvJN72`, USDT `58tc8wX1zDJb3Dkt6fTe6cDoVUsBHawTJni72Fjz8vaj`
- The fee is charged on top of `amount`. Before a wallet prompt, `src/mb-embed-fee.js` checks the builder response, confirms the sender is the only signer, and simulates the payout to prove the fee token account grows by exactly the expected fee. If anything is off, the page falls back to charging the same fee as one separate transfer. The fee is never charged twice.

### Verified on mainnet

Two MagicBlock private payouts from one Ninetails split (0.04 SOL, two wallets, one wallet approval) each paid the platform fee inside the payout:

- [`5hcMkRCx…5sa97xk`](https://solscan.io/tx/5hcMkRCx9ZeXq7LtC7YQzuPZswYz2vnJQshqgWssNGP6LuhbkU14Tj1qCvyWN2J2QTUsN7PbnWeW1FTuB5sa97xk)
- [`4kfTPtWF…oC6mJ9`](https://solscan.io/tx/4kfTPtWFWUfQw4224RhFQYP4V3LP1tUMctTzNxrMsW2WYqMU7XhQNnUADHP2bWBjRyLqwYCDS5icNgY3ZgoC6mJ9)

Each credited 80,055 base units of wrapped SOL to the fee token account above (160,110 in total, 0.4% of the split).

## Status

- MagicBlock payouts are live in production with the fee as a separate transfer.
- The embedded fee above is verified on mainnet and is rolling out behind a feature flag, together with the backend that records it.

## What is here

- `src/mb-embed-fee.js`: the fee-embedding module, identical to the file served at <https://ninetails.trade/mb-embed-fee.js>.
- `examples/build-payout.mjs`: a read-only script that calls the builder with and without the platform fee fields and prints what comes back. Nothing is signed or sent.

```
node examples/build-payout.mjs <senderPubkey> <recipientPubkey> [lamports]
```

All rights reserved. Shared for review by MagicBlock; no license is granted.
