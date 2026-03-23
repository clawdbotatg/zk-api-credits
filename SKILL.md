# ZK API Credits — Agent Skill

This skill teaches an AI agent how to use **zkllmapi.com** — a private, anonymous LLM API powered by zero-knowledge proofs and CLAWD token staking on Base mainnet.

No API key. No account. No identity. Just a ZK proof.

---

## What You Need

- A wallet on **Base mainnet** with ETH (for buying credits via CLAWDRouter)
- Node.js with `@aztec/bb.js`, `@noir-lang/noir_js`, `poseidon-lite`, `viem`
- The circuit artifact: `packages/circuits/target/api_credits.json` (in this repo)

---

## Deployed Contracts (Base Mainnet)

| Contract | Address |
|---|---|
| APICredits | `0xE7cc1F41Eb59775bD201Bb943d2230BA52294608` |
| CLAWDRouter | `0x9302e14c54fbA35A96457f6dD7A3AF5c082D5C24` |
| CLAWDPricing | `0xaca9733Cc19aD837899dc7D1170aF1d5367C332E` |
| CLAWD Token | `0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07` |
| API Server | https://backend.zkllmapi.com |

> ⚠️ Contract addresses change on every deploy. Always fetch the live address:
> `curl https://zkllmapi.com/contract`

---

## Step 1 — Generate Credentials Locally

Before buying, generate your nullifier, secret, and commitment. You need these to prove ownership later.

```js
import { poseidon2 } from "poseidon-lite";
import { randomBytes } from "crypto";

// Generate nullifier and secret
const nullifier = BigInt("0x" + randomBytes(31).toString("hex"));
const secret = BigInt("0x" + randomBytes(31).toString("hex"));
const commitment = poseidon2([nullifier, secret]);

// Save these — you need them to generate proofs later
const credentials = {
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  commitment: commitment.toString(),
};
// Store securely (localStorage, file, etc.)
```

---

## Step 2 — Buy Credits (One Transaction)

Use `CLAWDRouter.buyWithETH(commitments, minCLAWDOut)` — this does ETH → CLAWD swap + stake + register in a single transaction. No approve needed.

The `commitments` parameter is an **array** — you can batch multiple credits in one tx (10+ is fine).

Price is dynamic (oracle-based via Uniswap TWAP). Fetch the current price first:

```js
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const ROUTER = "0x9302e14c54fbA35A96457f6dD7A3AF5c082D5C24";
const PRICING = "0xaca9733Cc19aD837899dc7D1170aF1d5367C332E";

const publicClient = createPublicClient({ chain: base, transport: http() });

// Get current price per credit (in CLAWD, 18 decimals)
const priceInClawd = await publicClient.readContract({
  address: PRICING,
  abi: parseAbi(["function getCreditPriceInCLAWD() view returns (uint256)"]),
  functionName: "getCreditPriceInCLAWD",
});

// Or use quoteCredits for USD equivalent:
// const [clawdNeeded, usdEquivalent] = await publicClient.readContract({
//   address: ROUTER,
//   abi: parseAbi(["function quoteCredits(uint256) view returns (uint256, uint256)"]),
//   functionName: "quoteCredits",
//   args: [1n],
// });

// Buy 1 credit — sends ETH, router swaps → stakes → registers atomically
// Send enough ETH to cover the CLAWD price + slippage buffer
const ethAmount = (priceInClawd * 120n) / 100n; // 20% buffer

const txHash = await walletClient.writeContract({
  address: ROUTER,
  abi: parseAbi([
    "function buyWithETH(uint256[] calldata commitments, uint256 minCLAWDOut) payable",
  ]),
  functionName: "buyWithETH",
  args: [[commitment], 0n], // array of commitments, 0 for no slippage protection on swap
  value: ethAmount,
});
```

After the transaction mines, your commitment is registered on-chain. Parse the `CreditRegistered` event to get your leaf index:

```js
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
const creditRegisteredLog = receipt.logs.find(
  (log) =>
    log.address.toLowerCase() ===
    "0xE7cc1F41Eb59775bD201Bb943d2230BA52294608".toLowerCase()
);
// The event emits: user, index, commitment, newStakedBalance
const leafIndex = creditRegisteredLog.args.index;
```

---

## Step 3 — Get the Full Merkle Tree

The server maintains a complete Merkle tree. Fetch it once — the client computes its own Merkle path locally.

```js
// Fetch the full tree from the API server
const tree = await fetch("https://backend.zkllmapi.com/tree").then((r) => r.json());
// tree = { leaves, levels, root, depth, zeros }

// The root clients generate proofs against:
const latestRoot = tree.root; // "1234..." (string of a Field element)

// Compute the Merkle sibling path from the tree's levels array:
// levels[0] = leaf level (depth 0), levels[depth] = root
// Given leafIndex, levels[d] contains the sibling at depth d.
const siblings = [];
let idx = Number(leafIndex);
for (let d = 0; d < tree.depth; d++) {
  const siblingIdx = idx ^ 1; // flip last bit to get sibling
  siblings.push(tree.levels[d][siblingIdx] ?? tree.zeros[d]);
  idx = idx >> 1;
}
```

---

## Step 4 — Generate a ZK Proof

```js
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";

// Load circuit (fetch from repo or bundle locally)
const circuit = await fetch(
  "https://raw.githubusercontent.com/clawdbotatg/zk-api-credits/main/packages/circuits/target/api_credits.json"
).then((r) => r.json());

const backend = new UltraHonkBackend(circuit.bytecode);
const noir = new Noir(circuit);

// nullifier_hash = poseidon2([nullifier])
const nullifierHash = poseidon2([nullifier]);

const { witness } = await noir.execute({
  // Public inputs
  nullifier_hash: nullifierHash.toString(),
  root: latestRoot, // string from /tree response
  depth: 16,
  // Private inputs
  nullifier: nullifier.toString(),
  secret: secret.toString(),
  index: leafIndex.toString(),
  siblings: siblings.map((s) => s.toString()),
});

const { proof } = await backend.generateProof(witness);
const proofHex = "0x" + Buffer.from(proof).toString("hex");
```

---

## Step 5 — Call the API

There are two ways to call the API:

### Option A — `/v1/chat/key` (Simple, recommended for agents)

Use a composite API key and let the server generate the ZK proof for you. No client-side proving needed.

The key format is: `zk-llm-{nullifier}:{secret}:{commitment}`

```bash
curl -X POST https://backend.zkllmapi.com/v1/chat/key \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer zk-llm-<nullifier>:<secret>:<commitment>" \
  -d '{
    "messages": [{"role": "user", "content": "What is Ethereum?"}]
  }'
```

```js
const apiKey = `zk-llm-${nullifier}:${secret}:${commitment}`;

const response = await fetch("https://backend.zkllmapi.com/v1/chat/key", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "What is Ethereum?" }],
  }),
});

const { choices } = await response.json();
console.log(choices[0].message.content);
```

### Option B — `/v1/chat` (DIY proof, maximum privacy)

Generate the proof client-side and send it directly. The server never sees your nullifier or secret.

```bash
curl -X POST https://backend.zkllmapi.com/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "proof": "0x...",
    "nullifier_hash": "0x...",
    "root": "...",
    "depth": 16,
    "messages": [{"role": "user", "content": "What is Ethereum?"}]
  }'
```

```js
const response = await fetch("https://backend.zkllmapi.com/v1/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    proof: proofHex,
    nullifier_hash:
      "0x" + BigInt(nullifierHash).toString(16).padStart(64, "0"),
    root: latestRoot,
    depth: 16,
    messages: [{ role: "user", content: "What is Ethereum?" }],
  }),
});

const { choices } = await response.json();
console.log(choices[0].message.content);
```

Each credit is **single-use**. The nullifier is burned after the first call. Buy a new credit for each API call.

---

## Error Handling

| Status | Meaning | Fix |
| ------ | ------- | --- |
| 400 | Missing required fields | Check proof, nullifier_hash, root, depth, messages are all present |
| 403 | Invalid proof | Regenerate proof — root may have changed since you generated it |
| 403 | Nullifier already spent | This credential is used up — buy a new credit |
| 403 | Invalid root | Fetch latest root from `/tree` and regenerate proof |
| 502 | Venice upstream error | Retry — Venice may be temporarily unavailable |
| 503 | Server busy | All verifier workers occupied — retry in a moment |

---

## Check Nullifier Status

Before generating a proof, verify your nullifier hasn't been spent:

```js
const nullifierHashHex =
  "0x" + BigInt(nullifierHash).toString(16).padStart(64, "0");
const { spent } = await fetch(
  `https://backend.zkllmapi.com/nullifier/${nullifierHashHex}`
).then((r) => r.json());
if (spent) {
  // Buy a new credit
}
```

---

## Model

The API server uses a single fixed model: `zai-org-glm-5`. One credit = one call to this model.

The `model` field in the request body is ignored — the server always uses its configured model. Self-hosters can change the model via the `VENICE_MODEL` environment variable.

---

## Full Example (one-shot, using /v1/chat/key)

```js
import { poseidon2 } from "poseidon-lite";
import { randomBytes } from "crypto";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// 1. Generate credentials
const nullifier = BigInt("0x" + randomBytes(31).toString("hex"));
const secret = BigInt("0x" + randomBytes(31).toString("hex"));
const commitment = poseidon2([nullifier, secret]);

// 2. Buy credit
const ROUTER = "0x9302e14c54fbA35A96457f6dD7A3AF5c082D5C24";
const PRICING = "0xaca9733Cc19aD837899dc7D1170aF1d5367C332E";
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({
  chain: base,
  transport: http(),
  account: privateKeyToAccount("0x..."),
});

const priceInClawd = await publicClient.readContract({
  address: PRICING,
  abi: parseAbi(["function getCreditPriceInCLAWD() view returns (uint256)"]),
  functionName: "getCreditPriceInCLAWD",
});

const txHash = await walletClient.writeContract({
  address: ROUTER,
  abi: parseAbi([
    "function buyWithETH(uint256[] calldata commitments, uint256 minCLAWDOut) payable",
  ]),
  functionName: "buyWithETH",
  args: [[commitment], 0n],
  value: (priceInClawd * 120n) / 100n,
});

await publicClient.waitForTransactionReceipt({ hash: txHash });

// 3. Call the API (server-side proving)
const apiKey = `zk-llm-${nullifier}:${secret}:${commitment}`;
const res = await fetch("https://backend.zkllmapi.com/v1/chat/key", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

const { choices } = await res.json();
console.log(choices[0].message.content);
```

---

## Source

- Repo: https://github.com/clawdbotatg/zk-api-credits
- Live contracts: `curl https://zkllmapi.com/contract`
- API server: https://backend.zkllmapi.com
