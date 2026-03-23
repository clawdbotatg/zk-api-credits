# ZK API Credits

**Private, anonymous LLM API access using zero-knowledge proofs.**

Pay with CLAWD → register a ZK commitment → generate a proof → call any LLM without revealing your identity.

No wallet connection. No API key. No identity. Just a proof.

## Live Deployment (Base Mainnet)

| | Address |
|---|---|
| **Frontend** | [https://zkllmapi.com](https://zkllmapi.com) |
| **API Server** | [https://backend.zkllmapi.com](https://backend.zkllmapi.com) |
| **OpenAI-compatible proxy** | [zkllmapi-proxy repo](https://github.com/clawdbotatg/zkllmapi-proxy) |
| **CLI tool** | [zkllmapi-client repo](https://github.com/clawdbotatg/zkllmapi-client) |
| **APICredits** | [`0x799c5F602C357bc36379734bcd5D1438D50E4A80`](https://basescan.org/address/0x799c5F602C357bc36379734bcd5D1438D50E4A80#code) |
| **CLAWDRouter** | [`0xbe1BD1956281075DFE5aB9FEde2B9A0d0AC17116`](https://basescan.org/address/0xbe1BD1956281075DFE5aB9FEde2B9A0d0AC17116#code) |
| **CLAWDPricing** | [`0x2B3c8bD1Db3fC52C58F416681e7F80e5f0f0597c`](https://basescan.org/address/0x2B3c8bD1Db3fC52C58F416681e7F80e5f0f0597c#code) |
| **CLAWD Token** | [`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`](https://basescan.org/address/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07) |

---

## How It Works

```
1. BUY        User buys credits via CLAWDRouter (ETH → CLAWD swap + stake + register, one tx)
2. REGISTER   buyWithETH() atomically registers a Poseidon2 commitment in the Merkle tree
3. PROVE      User generates a ZK proof in-browser proving they
              own a valid commitment in the tree — without revealing which one
4. CALL       User sends proof + messages to the API server
              Server verifies the proof off-chain (bb.js UltraHonk),
              burns the nullifier, and proxies the request to Venice AI
```

The ZK proof breaks the link between the wallet that paid and the API call. The server never learns who you are.

---

## Architecture

```
┌──────────────┐     ZK Proof + Messages     ┌──────────────┐     LLM Request     ┌──────────────┐
│              │ ──────────────────────────▶  │              │ ──────────────────▶  │              │
│    User      │                              │  API Server  │                      │  Venice AI   │
│  (Browser)   │  ◀──────────────────────────  │  (Express)   │  ◀──────────────────  │              │
│              │     LLM Response             │              │     LLM Response     │              │
└──────┬───────┘                              └──────┬───────┘                      └──────────────┘
       │                                             │
       │  CLAWDRouter.buyWithETH(commitments)        │  Verifies proof off-chain (bb.js)
       │  → ETH→CLAWD swap + stake + register        │  Checks nullifier not spent
       ▼                                             │  Validates Merkle root
┌──────────────┐                                     │
│  APICredits  │ ◀───────────────────────────────────┘
│  (On-Chain)  │   Reads Merkle root + tree state via events
└──────────────┘
```

---

## Model

`zai-org-glm-5` — Z.AI's flagship GLM-5 model, next-gen over GLM-4.7, FP8 quantized, 198K context, reasoning-capable — running in Venice AI's TEE for private inference.

Model is fixed: **one credit = one call to this model.** The model field in requests is ignored — `zai-org-glm-5` is always used.

---

## Quick Start — Use the Live System

### Step 1 — Get Credits
1. Go to [https://zkllmapi.com/buy](https://zkllmapi.com/buy)
2. Connect a wallet on Base
3. Buy credits with CLAWD (or ETH via the router)
4. A ZK commitment is registered on-chain; your secret is stored locally in-browser

### Step 2 — Chat Privately
1. Go to [https://zkllmapi.com/chat](https://zkllmapi.com/chat)
2. Type a message — the app generates a ZK proof in-browser (~10-30s)
3. The proof is sent to the API server, which verifies it and forwards your message to Venice AI
4. You get an LLM response. No one knows who asked.

### Step 3 — Or Call the API Directly

**Option A — Server-side proving (no bb.js needed):**
```bash
curl -X POST https://backend.zkllmapi.com/v1/chat/key \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "zk-llm-{base64url(\"nullifier:secret:commitment\")}",
    "messages": [{ "role": "user", "content": "What is Ethereum?" }]
  }'
```

**Option B — DIY ZK proof (maximum privacy, proof generated client-side):**
```bash
curl -X POST https://backend.zkllmapi.com/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "proof": "0x...",
    "nullifier_hash": "0x...",
    "root": "0x...",
    "depth": latestTree.depth, // current tree depth — fetch from /tree
    "messages": [{ "role": "user", "content": "What is Ethereum?" }]
  }'
```

No API key. No account. Just a proof.

---

## Quick Start — Run Your Own Server

### Prerequisites
- Node.js >= 20
- A [Venice AI](https://venice.ai/) API key
- A deployed `APICredits` contract (or use the live one on Base)

### Setup
```bash
git clone https://github.com/clawdbotatg/zk-api-credits
cd zk-api-credits/packages/api-server
cp .env.example .env
# Edit .env — add VENICE_API_KEY + CONTRACT_ADDRESS
npm install
npm run build
node dist/index.js
```

---

## API Reference

### `POST /v1/chat/key`
Server-side ZK proving — the server generates the proof for you from an API key. No bb.js needed on the client.

**Request:**
```json
{
  "apiKey": "zk-llm-{base64url(\"nullifier:secret:commitment\")}",
  "messages": [{ "role": "user", "content": "..." }]
}
```

**Response:** Standard OpenAI-compatible chat completion response.

### `POST /v1/chat`
DIY ZK proof — client generates the proof in-browser using bb.js. Maximum privacy (private inputs never leave the client).

**Request:**
```json
{
  "proof": "0x...",
  "nullifier_hash": "0x...",
  "root": "0x...",
  "depth": latestTree.depth, // current tree depth — fetch from /tree
  "messages": [{ "role": "user", "content": "..." }]
}
```

**Response:** Standard OpenAI-compatible chat completion response.

| Status | Meaning |
|--------|---------|
| 400 | Missing required fields |
| 403 | Invalid proof, spent nullifier, or invalid root |
| 429 | Nullifier currently being processed (retry shortly) |
| 502 | Venice AI upstream error |

### `GET /health`
```json
{ "status": "ok", "spentNullifiers": 20, "currentRoot": "0x...", "validRoots": 12, "treeSize": 29 }
```

### `GET /stats`
```json
{ "spentNullifiers": 20, "currentRoot": "0x...", "validRoots": 12, "treeSize": 29 }
```

### `GET /nullifier/:hash`
```json
{ "spent": false }
```

### `GET /contract`
```json
{ "address": "0x799c5F602C357bc36379734bcd5D1438D50E4A80", "chainId": 8453, "apiUrl": "https://backend.zkllmapi.com" }
```

### `GET /circuit`
Returns the compiled Noir circuit JSON for client-side proof generation.

### `GET /tree`
Returns the full Merkle tree (leaves, levels, root, depth, zeros) for client-side path computation. The client computes its own Merkle path locally — the server never learns which commitment is being used.

---

## Privacy Guarantees

- **Unlinkability** — The ZK proof breaks the connection between the wallet that paid and the API request. The server cannot determine which registered user is making a call.
- **Single-use credentials** — Each proof consumes a unique nullifier. Once spent, that credential cannot be reused.
- **No accounts** — No user accounts, no API keys, no sessions. Each request is independently verified.
- **Client-side proof generation** — Proofs are generated entirely in the browser. Private inputs (nullifier, secret) never leave the client.
- **Client-side path computation** — The full tree is fetched once; Merkle paths are computed locally. The server never sees which commitment you're using.
- **Off-chain verification** — Proof verification happens server-side via bb.js (UltraHonk), not via an on-chain verifier contract.

### Anonymity Set & Current Limitations

**Your privacy is proportional to the anonymity set** — the number of registered commitments in the Merkle tree. With N commitments, each API call could plausibly come from any of the N registered users.

⚠️ **This system is early-stage.** The anonymity set is currently small (~29 commitments). Privacy improves significantly as more people use the system. With hundreds or thousands of commitments, the unlinkability guarantee becomes much stronger.

### What is NOT Private

- **Request content** — The server operator sees the content of API requests and responses. Self-host or use a trusted operator.
- **On-chain transactions** — Staking and registration are public. The wallet that buys credits is visible on-chain.
- **Timing correlation** — In a low-traffic system, timing of on-chain registration vs. API usage could narrow the anonymity set. Historical root acceptance (rolling ~24h window) mitigates this.
- **Network metadata** — IP addresses are visible at the transport layer. Use Tor or a VPN for stronger privacy.

---

## Project Structure

```
packages/
├── api-server/   Express server — verifies proofs (bb.js UltraHonk), proxies to Venice
├── circuits/     Noir ZK circuit (Poseidon2 commitments + Merkle proof)
├── contracts/    Solidity contracts (Foundry) (APICredits, CLAWDPricing, CLAWDRouter)
└── nextjs/       Frontend (also in zk-llm-frontend repo)
```

## Deploying Contracts

### Deployment Order (important)

`update.sh` reads `CONTRACT_ADDRESS` from `https://zkllmapi.com/contract` — the Vercel frontend. **Always follow this order:**

1. Compile: `cd packages/contracts && forge build`
2. Deploy (Foundry `cast send --create` with compiled bytecode + constructor args)
3. Update `externalContracts.ts` in `zk-llm-frontend` with new addresses → push to GitHub
3. **Wait for Vercel to finish deploying** — verify `curl https://zkllmapi.com/contract` returns the correct address before proceeding
4. Run `update.sh` on AWS: `ssh ubuntu@backend.zkllmapi.com "bash ~/zk-api-credits/update.sh"`

Never run `update.sh` before the frontend has redeployed. It will read a stale address from the live frontend.

### AWS Backend Deployment

The API server runs in Docker on an AWS box behind `backend.zkllmapi.com`.

**To deploy an update:** SSH into the AWS box and run:
```bash
bash ~/zk-api-credits/update.sh
```

## Tech Stack

- **ZK Circuit**: [Noir](https://noir-lang.org/) + [Barretenberg](https://github.com/AztecProtocol/aztec-packages) (UltraHonk)
- **Proof Verification**: Off-chain via bb.js (UltraHonk backend)
- **Smart Contracts**: Solidity, Foundry, [@zk-kit/imt.sol](https://github.com/privacy-scaling-explorations/zk-kit) (Incremental Merkle Tree with Poseidon2)
- **API Server**: Express, TypeScript
- **Frontend**: Next.js, wagmi, viem, RainbowKit (Scaffold-ETH 2)
- **LLM Backend**: [Venice AI](https://venice.ai/) (private inference)

---

## License

MIT
