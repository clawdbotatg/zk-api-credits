# ZK API Credits

**Private, anonymous LLM API access using zero-knowledge proofs.**

Pay with CLAWD → register a ZK commitment → generate a proof → call any LLM without revealing your identity.

No wallet connection. No API key. No identity. Just a proof.

## Live Deployment (Base Mainnet)

| | Address |
|---|---|
| **Frontend** | [https://zkllmapi.com](https://zkllmapi.com) |
| **API Server** | [https://backend.zkllmapi.com](https://backend.zkllmapi.com) |
| **APICredits** | [`0xFc137f8a2E4ca655084731B5eeeF424BEcdae86C`](https://basescan.org/address/0xFc137f8a2E4ca655084731B5eeeF424BEcdae86C#code) |
| **CLAWDRouter** | [`0x1b60CfCe6ddBD2A8f4c5bf83b8bc66f9ef683BC7`](https://basescan.org/address/0x1b60CfCe6ddBD2A8f4c5bf83b8bc66f9ef683BC7#code) |
| **CLAWDPricing** | [`0xaca9733Cc19aD837899dc7D1170aF1d5367C332E`](https://basescan.org/address/0xaca9733Cc19aD837899dc7D1170aF1d5367C332E#code) |
| **CLAWD Token** | [`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`](https://basescan.org/address/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07) |

---

## How It Works

```
1. BUY        User buys credits via CLAWDRouter (CLAWD or ETH → CLAWD)
2. REGISTER   User generates a secret commitment (Poseidon2 hash)
              and registers it on-chain in the Merkle tree
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
       │  CLAWDRouter.buyCredits()                   │  Verifies proof off-chain (bb.js)
       │  → approve + register commitment            │  Checks nullifier not spent
       ▼                                             │  Validates Merkle root
┌──────────────┐                                     │
│  APICredits  │ ◀───────────────────────────────────┘
│  (On-Chain)  │   Reads Merkle root + tree state via events
└──────────────┘
```

---

## Supported Models

- `hermes-3-llama-3.1-405b` (default)
- `llama-3.3-70b`
- `kimi-k2-thinking`
- `qwen3-235b-a22b-thinking-2507`
- `deepseek-v3.2`

All models run on [Venice AI](https://venice.ai/) with private inference.

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
```bash
curl -X POST https://backend.zkllmapi.com/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "proof": "0x...",
    "publicInputs": ["0x...", "0x...", "0x..."],
    "nullifier_hash": "0x...",
    "root": "0x...",
    "depth": 16,
    "messages": [{ "role": "user", "content": "What is Ethereum?" }],
    "model": "llama-3.3-70b"
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

### `POST /v1/chat`
Submit a ZK proof and get an LLM response.

**Request:**
```json
{
  "proof": "0x...",
  "publicInputs": ["0x...", "0x...", "0x..."],
  "nullifier_hash": "0x...",
  "root": "0x...",
  "depth": 16,
  "messages": [{ "role": "user", "content": "..." }],
  "model": "llama-3.3-70b"
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
{ "address": "0xFc137f8a2E4ca655084731B5eeeF424BEcdae86C", "chainId": 8453 }
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
├── hardhat/      Solidity contracts (APICredits, CLAWDPricing, CLAWDRouter)
└── nextjs/       Frontend (also in zk-llm-frontend repo)
```

## Tech Stack

- **ZK Circuit**: [Noir](https://noir-lang.org/) + [Barretenberg](https://github.com/AztecProtocol/aztec-packages) (UltraHonk)
- **Proof Verification**: Off-chain via bb.js (UltraHonk backend)
- **Smart Contracts**: Solidity, Hardhat, [@zk-kit/imt.sol](https://github.com/privacy-scaling-explorations/zk-kit) (Incremental Merkle Tree with Poseidon2)
- **API Server**: Express, TypeScript
- **Frontend**: Next.js, wagmi, viem, RainbowKit (Scaffold-ETH 2)
- **LLM Backend**: [Venice AI](https://venice.ai/) (private inference)

---

## License

MIT
