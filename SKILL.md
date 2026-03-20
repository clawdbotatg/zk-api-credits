# ZK API Credits — Agent Skill

This skill teaches an AI agent how to use **zkllmapi.com** — a private, anonymous LLM API powered by zero-knowledge proofs and CLAWD token staking on Base mainnet.

No API key. No account. No identity. Just a ZK proof.

---

## What You Need

- A wallet on **Base mainnet** with CLAWD tokens
- Node.js with `@aztec/bb.js`, `@noir-lang/noir_js`, `poseidon-lite`, `viem`
- The circuit artifact: `packages/circuits/target/api_credits.json` (in this repo)

---

## Deployed Contracts (Base Mainnet)

| Contract | Address |
|---|---|
| APICredits | `0x9991f959040De3c5df0515FFCe8B38b72cB7F26c` |
| CLAWD Token | `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07` |
| API Server | https://zkllmapi.com |

---

## Step 1 — Stake CLAWD

Each API credit costs **1000 CLAWD**. You must stake first, then register a commitment.

```js
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const API_CREDITS = "0x9991f959040De3c5df0515FFCe8B38b72cB7F26c";
const PRICE = 1000n * 10n ** 18n; // 1000 CLAWD

// 1. Approve
await walletClient.writeContract({
  address: CLAWD,
  abi: parseAbi(["function approve(address,uint256)"]),
  functionName: "approve",
  args: [API_CREDITS, PRICE],
});

// 2. Stake
await walletClient.writeContract({
  address: API_CREDITS,
  abi: parseAbi(["function stake(uint256)"]),
  functionName: "stake",
  args: [PRICE],
});
```

---

## Step 2 — Generate a Commitment and Register

Generate a nullifier and secret locally. **Save them — you cannot recover them.**

```js
import { poseidon2 } from "poseidon-lite";
import { randomBytes } from "crypto";

// Generate random secrets
const nullifier = BigInt("0x" + randomBytes(31).toString("hex"));
const secret = BigInt("0x" + randomBytes(31).toString("hex"));

// Compute commitment
const commitment = poseidon2([nullifier, secret]);

// Save these — you'll need them to generate a proof later
const credentials = { nullifier: nullifier.toString(), secret: secret.toString(), commitment: commitment.toString() };

// Register on-chain
await walletClient.writeContract({
  address: API_CREDITS,
  abi: parseAbi(["function register(uint256)"]),
  functionName: "register",
  args: [commitment],
});
```

After registering, note the **leaf index** — it's your position in the Merkle tree (0-indexed, increments per registration).

---

## Step 3 — Get the Merkle Tree State

You need the current Merkle root and your sibling path to generate a proof.

```js
// Get current root from the API server
const { latestRoot } = await fetch("https://zkllmapi.com/health").then(r => r.json());

// Get Merkle path from the contract (or build from on-chain events)
const siblings = await publicClient.readContract({
  address: API_CREDITS,
  abi: parseAbi(["function getMerklePath(uint256 index) view returns (uint256[] memory, uint256)"]),
  functionName: "getMerklePath",
  args: [leafIndex],
});
```

---

## Step 4 — Generate a ZK Proof

```js
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";

// Load circuit (fetch from repo or bundle locally)
const circuit = await fetch(
  "https://raw.githubusercontent.com/clawdbotatg/zk-api-credits/main/packages/circuits/target/api_credits.json"
).then(r => r.json());

const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

const nullifierHash = poseidon2([nullifier]);

const { witness } = await noir.execute({
  // Public inputs
  nullifier_hash: nullifierHash.toString(),
  root: latestRoot,
  depth: 16,
  // Private inputs
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  index: leafIndex.toString(),
  siblings: siblings.map(s => s.toString()),
});

const { proof } = await backend.generateProof(witness);
const proofHex = "0x" + Buffer.from(proof).toString("hex");
```

---

## Step 5 — Call the API

```js
const response = await fetch("https://zkllmapi.com/v1/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    proof: proofHex,
    nullifier_hash: "0x" + nullifierHash.toString(16).padStart(64, "0"),
    root: latestRoot,
    depth: 16,
    messages: [
      { role: "user", content: "What is Ethereum?" }
    ],
  }),
});

const { choices } = await response.json();
console.log(choices[0].message.content);
```

Each proof is **single-use**. The nullifier is burned after the first call. Register a new commitment for each credit you want.

---

## Error Handling

| Status | Meaning | Fix |
|--------|---------|-----|
| 400 | Missing required fields | Check proof, nullifier_hash, root, depth, messages are all present |
| 403 | Invalid proof | Regenerate proof — root may have changed since you generated it |
| 403 | Nullifier already spent | This credential is used up — register a new commitment |
| 403 | Invalid root | Fetch latest root from `/health` and regenerate proof |
| 502 | Venice upstream error | Retry — Venice may be temporarily unavailable |

---

## Check Nullifier Status

Before generating a proof, verify your nullifier hasn't been spent:

```js
const nullifierHashHex = "0x" + nullifierHash.toString(16).padStart(64, "0");
const { spent } = await fetch(`https://zkllmapi.com/nullifier/${nullifierHashHex}`).then(r => r.json());
if (spent) {
  // Register a new commitment
}
```

---

## Model

The API server uses a single fixed model: `hermes-3-llama-3.1-405b`. One credit = one call to this model.

The `model` field in the request body is ignored — the server always uses its configured model. Self-hosters can change the model via the `VENICE_MODEL` environment variable.

---

## Full Example (one-shot)

```js
// Assumes you already have: nullifier, secret, leafIndex, siblings, latestRoot

import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { poseidon2 } from "poseidon-lite";

const circuit = await fetch("https://raw.githubusercontent.com/clawdbotatg/zk-api-credits/main/packages/circuits/target/api_credits.json").then(r => r.json());
const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

const nullifierHash = poseidon2([nullifier]);
const { witness } = await noir.execute({
  nullifier_hash: nullifierHash.toString(),
  root: latestRoot,
  depth: 16,
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  index: leafIndex.toString(),
  siblings: siblings.map(s => s.toString()),
});
const { proof } = await backend.generateProof(witness);

const res = await fetch("https://zkllmapi.com/v1/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    proof: "0x" + Buffer.from(proof).toString("hex"),
    nullifier_hash: "0x" + nullifierHash.toString(16).padStart(64, "0"),
    root: latestRoot,
    depth: 16,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

const { choices } = await res.json();
console.log(choices[0].message.content);
```

---

## Source

- Repo: https://github.com/clawdbotatg/zk-api-credits
- Contract: https://basescan.org/address/0x9991f959040De3c5df0515FFCe8B38b72cB7F26c
- API: https://zkllmapi.com
