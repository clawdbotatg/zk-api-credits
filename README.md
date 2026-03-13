# ZK API Credits

**Private, anonymous LLM API access using zero-knowledge proofs.**

Stake CLAWD → register a commitment → generate a ZK proof → call any LLM API without revealing your identity.

No wallet connection. No API key. No identity. Just a proof.

## Live Deployment (Base Mainnet)

| | Address |
|---|---|
| **API Server** | https://zkllmapi.com |
| **APICredits** | [`0x9991f959040De3c5df0515FFCe8B38b72cB7F26c`](https://basescan.org/address/0x9991f959040De3c5df0515FFCe8B38b72cB7F26c#code) |
| **UltraVerifier** | [`0x257d0ba84adE9fFb9705C78E2E623E72eE480C3B`](https://basescan.org/address/0x257d0ba84adE9fFb9705C78E2E623E72eE480C3B#code) |
| **CLAWD Token** | [`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`](https://basescan.org/address/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07) |

---

## How It Works

```
1. STAKE     User deposits CLAWD into the APICredits contract
2. REGISTER  User generates a secret commitment (Poseidon hash)
             and registers it on-chain → CLAWD becomes non-refundable
3. PROVE     User generates a ZK proof in-browser proving they
             have a valid commitment in the Merkle tree
4. CALL      User sends proof + messages to the API server
             Server verifies the proof, burns the nullifier,
             and proxies the request to Venice AI
```

The ZK proof breaks the link between the wallet that paid and the API call being made. The server never learns who you are.

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
       │  stake() / register()                       │  Verifies proof
       │                                             │  Checks nullifier not spent
       ▼                                             │  Validates Merkle root
┌──────────────┐                                     │
│  APICredits  │ ◀───────────────────────────────────┘
│  (On-Chain)  │   Reads Merkle root + tree state
└──────────────┘
```

---

## Quick Start — Run Your Own Server

Fork this repo and run your own private ZK-gated LLM API in minutes.

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://www.docker.com/) (optional, for containerized deploy)
- A [Venice AI](https://venice.ai/) API key
- A deployed `APICredits` contract (see [Contract Deployment](#contract-deployment)) — or use the live one on Base mainnet

### With Docker

```bash
git clone https://github.com/clawdbotatg/zk-api-credits
cd zk-api-credits/packages/api-server
cp .env.example .env
# Edit .env — add your Venice API key + deployed contract address
docker build -t zk-api-server .
docker run -p 3001:3001 --env-file .env zk-api-server
```

### Without Docker

```bash
git clone https://github.com/clawdbotatg/zk-api-credits
cd zk-api-credits/packages/api-server
cp .env.example .env
# Edit .env
npm install
npm run build
node dist/index.js
```

### With Docker Compose (includes local Hardhat node)

```bash
cd zk-api-credits/packages/api-server
cp .env.example .env
docker compose up
```

---

## Quick Start — Use an Existing Server

If someone is already running a ZK API Credits server:

1. **Stake CLAWD** — Visit the frontend and deposit CLAWD into the contract
2. **Register commitments** — Generate secret credentials and register them on-chain. Your secrets are saved to localStorage
3. **Generate a ZK proof** — The browser builds a proof that you own a valid commitment without revealing which one
4. **Call the API** — POST your proof + messages to the server's `/v1/chat` endpoint

---

## Contract Deployment

```bash
cd packages/hardhat

# Generate a deployer account
yarn generate

# Fund it, then deploy
yarn deploy --network base
```

See [`packages/hardhat/README.md`](packages/hardhat/README.md) for more details.

---

## API Reference

### `POST /v1/chat`

Submit a ZK proof and get an LLM response.

**Request:**

```json
{
  "proof": "0x...",
  "nullifier_hash": "0x...",
  "root": "0x...",
  "depth": 16,
  "messages": [
    { "role": "user", "content": "What is Ethereum?" }
  ],
  "model": "llama-3.3-70b"
}
```

**Response:** Standard OpenAI-compatible chat completion response from Venice AI.

**Errors:**

| Status | Meaning |
|--------|---------|
| 400 | Missing required fields |
| 403 | Invalid proof, spent nullifier, or invalid root |
| 502 | Venice AI upstream error |

### `GET /health`

```json
{ "status": "ok", "spentNullifiers": 42, "latestRoot": "0x..." }
```

### `GET /stats`

```json
{ "spentNullifiers": 42, "validRoots": 5, "latestRoot": "0x..." }
```

### `POST /root`

Update the server's known Merkle root (called by the frontend or an indexer).

```json
{ "root": "0x..." }
```

### `GET /nullifier/:hash`

Check if a nullifier has been spent.

```json
{ "spent": false }
```

---

## Privacy Guarantees

- **Unlinkability** — The ZK proof breaks the connection between the wallet that staked ETH and the API request. The server cannot determine which registered user is making a call.
- **Single-use credentials** — Each proof consumes a unique nullifier. Once spent, that credential cannot be reused, preventing double-spending.
- **No accounts** — The API server has no user accounts, no API keys, no sessions. Each request is independently verified via its ZK proof.
- **Client-side proof generation** — Proofs are generated entirely in the browser using Noir + UltraHonk (Barretenberg). Private inputs (nullifier, secret) never leave the client.
- **Merkle tree privacy** — The on-chain Merkle tree stores commitments (hashes), not secrets. An observer can see that *someone* registered but cannot link a commitment to a specific API call.

### What is NOT private

- The server operator can see the content of API requests and responses (use with a trusted operator or self-host)
- On-chain staking and registration transactions are public (the wallet that stakes CLAWD is visible)
- The ZK proof only hides *which* commitment is being used, not the fact that a call is being made

---

## Project Structure

```
packages/
├── api-server/      Express server — verifies proofs, proxies to Venice
├── circuits/        Noir ZK circuit (Poseidon commitments + Merkle proof)
├── hardhat/         Solidity contracts (APICredits + UltraVerifier)
└── nextjs/          Frontend — staking, registration, proof generation
```

---

## Tech Stack

- **ZK Circuit**: [Noir](https://noir-lang.org/) + [Barretenberg](https://github.com/AztecProtocol/aztec-packages) (UltraHonk)
- **Smart Contracts**: Solidity, Hardhat, [LeanIMT](https://github.com/privacy-scaling-explorations/zk-kit) (Poseidon2)
- **API Server**: Express, TypeScript
- **Frontend**: Next.js, wagmi, viem, RainbowKit (Scaffold-ETH 2)
- **LLM Backend**: [Venice AI](https://venice.ai/)

---

## License

MIT
