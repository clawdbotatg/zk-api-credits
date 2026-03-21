# Contributing to ZK API Credits

## Project Overview

Private, anonymous LLM API access using zero-knowledge proofs. Users stake CLAWD on Base mainnet, generate a ZK proof in-browser, and call the API without revealing their identity.

## What to Contribute

- **ZK circuits** (`packages/circuits/`) — Noir circuit logic, constraint optimization
- **Contracts** (`packages/contracts/`) — Solidity security, gas optimization
- **API server** (`packages/api-server/`) — proof verification, Venice proxy, rate limiting
- **Documentation** — this file, README, SKILL.md must stay current with any contract deploys

## Rules

- **Never commit secrets** — private keys, API keys, tokens, `.env` files. Use `.env.example` as the template.
- **Contract addresses change on every deploy** — always use `curl https://zkllmapi.com/contract` as the source of truth. Never hardcode addresses in docs or skill files.
- **Test the full E2E flow** — before merging any change that touches proof generation, contract calls, or API routing, run `zkllmapi-client buy 1` followed by `zkllmapi-client chat` and verify it end-to-end.
- **Deploy requires Austin's approval** — do not push to production without explicit sign-off.

## Workflow

1. Fork and branch: `git checkout -b fix/my-fix`
2. Make changes, commit early and often
3. Test E2E before opening a PR
4. Open PR with a clear description of what changed and why
5. Squash-and-merge on approval

## Architecture Notes

- **Proof verification is off-chain** — bb.js UltraHonk runs in a worker pool, not on-chain
- **Nullifiers are stored in-memory** — file-based JSON (`./data/spent-nullifiers.json`), volume-mounted so it survives container restarts
- **Poseidon2 is the only correct hash** — use `bb.poseidon2Hash()` in JS, `Poseidon2::hash` in Noir, and `LibPoseidon2` on-chain. `poseidon-lite`'s "poseidon2" is original Poseidon with 2 inputs — different function, do not use
- **Model is server-enforced** — `e2ee-glm-5` is hardcoded; the `model` field in requests is ignored

## Links

- Contract: `curl https://zkllmapi.com/contract`
- API: https://backend.zkllmapi.com
- Frontend: https://zkllmapi.com
