## Summary

Replace the current **fixed 1-credit-per-call** model with a **variable-cost encrypted balance** system. Users deposit once, spend down per actual Venice token usage, and prove solvency with ZK. The server never learns cumulative spend.

---

## Problem

- **Fixed $0.01/credit** — server loses money on calls > ~2K in + 2K out tokens (Venice cost exceeds revenue)
- A single 8K+8K call costs the server $0.042 but only earns $0.01
- Light users subsidize heavy users
- Poseidon2 gas cost (~$0.30/tx) makes small on-chain purchases unviable

### Venice pricing (e2ee-glm-5): $1.10/1M input, $4.15/1M output

| Query | Venice Cost | Revenue ($0.01) | P&L |
|---|---|---|---|
| 500+500 | $0.0026 | $0.01 | +$0.007 |
| 2K+2K | $0.0105 | $0.01 | -$0.0005 |
| 8K+8K | $0.042 | $0.01 | **-$0.032** |

---

## How It Works

### Setup (one-time, on-chain)
1. User deposits D CLAWD into contract
2. User registers a commitment ID in the Merkle tree (existing mechanism, unchanged)
3. Server creates a balance record for this user (off-chain, see Storage section)
4. User stores plaintext balance locally

### Per API Call
1. User sends ZK proof proving:
   - ID is in the Merkle tree
   - Nullifier is valid and unspent
   - `balance ≥ call_cost_usd` — plaintext balance covers today's Venice cost
2. Server verifies proof, proxies to Venice, gets `usage.prompt_tokens` + `usage.completion_tokens`
3. Server calculates cost: `(prompt_tokens/1M × $1.10) + (completion_tokens/1M × $4.15)`
4. Server returns: `(llm_response, new_balance, server_signature_over_new_balance)`
5. User decrements local balance: `balance -= cost_usd`
6. User stores new balance + signature

### Withdrawal (on-chain)
1. User submits: `(final_balance, server_signature, ZK_proof_of_balance)`
2. Contract verifies server's signature on balance
3. Contract sends `D - spent` CLAWD back to user

---

## Concrete Data Structures

### Server storage (Redis, key per user_id derived from nullifier_hash)

```
Key:   balance:{nullifier_hash}
Value: {
  "balance": "2.50",           // USD remaining (string for precision)
  "signature": "0x...",         // EdDSA sig over keccak256(balance || nullifier_hash)
  "server_nonce": 5,            // monotonic counter (anti-replay)
  "last_updated": 1742600000    // unix timestamp
}
```

### Server signature scheme
- **Curve:** secp256k1 (same as Ethereum, available in Noir stdlib)
- **Algorithm:** ECDSA (Noir stdlib has `std::ecdsa::verify_signature`)
- **What is signed:** `keccak256(balance_as_u256 || nullifier_hash || server_nonce)`
- Balance encoded as: `uint256` representing cents (i.e., $2.50 = 25000000)
- Nonce prevents replay of old signatures

### ZK circuit (new public inputs)
```
// NEW public inputs
balance_commitment: pub Field,       // Pedersen commitment to balance (G·balance + H·blinding)
server_pubkey_x: pub Field,          // server's secp256k1 public key X coord
server_pubkey_y: pub Field,          // server's secp256k1 public key Y coord  
server_signature_r: pub Field,       // ECDSA signature r value
server_signature_s: pub Field,       // ECDSA signature s value

// EXISTING public inputs (unchanged)
nullifier_hash: pub Field,
root: pub Field,
depth: pub u32,

// NEW private inputs
balance: Field,                      // plaintext balance in cents
blinding: Field,                     // Pedersen blinding factor
nullifier: Field,
secret: Field,
indices: [u1; 16],
siblings: [Field; 16],
```

### ZK circuit constraints
1. `commitment = Poseidon2(nullifier, secret)` — existing
2. `computed_root = merkle_path(commitment, ...)` — existing
3. `nullifier_hash = Poseidon2(nullifier)` — existing
4. `balance_commitment = balance·G + blinding·H` — Pedersen verify
5. `ecdsa_verify(server_pubkey, server_signature, keccak(balance || nullifier_hash || nonce))` — server sig verify
6. `balance ≥ call_cost_cents` — solvency check (new)

### Contract changes
New functions on APICredits:
```
function withdraw(bytes32[] proof, uint256 balance, uint256 blinding, 
                 uint256[2] calldata server_pubkey,
                 uint256[2] calldata server_signature) 
```
- Verifies Pedersen commitment opens to balance
- Verifies server ECDSA signature
- Sends `D - spent` to caller

### Server signing key
- Held as env var `SERVER_SIGNING_PRIVKEY` (secp256k1 private key, 32 bytes hex)
- In production: move to HSM or AWS KMS
- Public key hardcoded in circuit and contract (or stored as contract constant)

### API endpoint changes

**POST /v1/chat** — existing, adds two new fields to response:
```json
{
  "response": "...",
  "new_balance": "2.47",
  "balance_signature": {
    "r": "0x...",
    "s": "0x...",
    "nonce": 6
  }
}
```

**GET /balance/:nullifier_hash** — new:
```json
{
  "balance": "2.50",
  "signature": { "r": "0x...", "s": "0x..." },
  "nonce": 5
}
```

### Venice token → USD cost calculation
```typescript
function calculateCost(usage: { prompt_tokens: number; completion_tokens: number }): number {
  const INPUT_PRICE_PER_M = 1.10;  // $/1M input
  const OUTPUT_PRICE_PER_M = 4.15; // $/1M output
  const cost = (usage.prompt_tokens / 1e6) * INPUT_PRICE_PER_M
             + (usage.completion_tokens / 1e6) * OUTPUT_PRICE_PER_M;
  return Math.round(cost * 1e6); // return in microdollars (uint256)
}
```

---

## Open Questions

1. **Minimum deposit:** What D is required to start? Must cover at least one Venice call + withdrawal gas. Suggest $1.00 minimum.
2. **Backwards compatibility:** Keep old 1-credit = 1-call flow running alongside new balance flow? Or migrate?
3. **Withdrawal timing:** Can user withdraw anytime, or only after N calls? Paper allows anytime.
4. **Overdraw protection:** What happens if a call costs more than remaining balance? Reject with error before Venice call.
5. **Concurrency:** What if user sends two calls simultaneously? Use server nonce + pending set (same pattern as nullifiers today).

---

## What Changes vs. What Stays

| Component | Status | Notes |
|---|---|---|
| Merkle tree + registration | Unchanged | Same on-chain flow |
| Poseidon2 hashing | Unchanged | Same circuit logic |
| Nullifier (per-call) | Unchanged | Still one nullifier per call |
| bb.js proof generation | Unchanged | Same client-side flow |
| Server proof verification | Unchanged | Just adds balance sig check |
| Venice proxy | Unchanged | Just reads `usage` field |
| API endpoint path | **Changes** | /v1/chat returns new_balance + sig |
| Client state | **Changes** | Stores balance + sig instead of credits count |
| Noir circuit | **Changes** | New inputs + Pedersen verify + ECDSA verify |
| Contract | **Changes** | New withdrawal function |
| Server storage | **Changes** | Redis `balance:{nullifier}` map |

---

## Implementation Order

1. Server-side: Redis balance map + ECDSA signing (easy, no circuit change yet)
2. Client-side: Store balance + signature, send with each request
3. New ZK circuit: Add Pedersen commitment + ECDSA verify + balance ≥ cost
4. Contract: Withdrawal function verifying server signature
5. Frontend: Update /buy flow to show balance instead of credits

---

## Related

- [Original paper](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) by Vitalik Buterin & Davide Crapis
- About page roadmap — "Variable Cost + Refund Tickets"
