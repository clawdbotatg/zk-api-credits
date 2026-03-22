# Ethresear.ch Thread Analysis: ZK API Usage Credits

Full synthesis of [the original Vitalik/Crapis paper](https://ethresear.ch/t/zk-api-usage-credits-llms-and-beyond/24104) and all 31 comments, mapped to design decisions for this project.

## The Paper's Core Design

**Authors:** Davide Crapis and Vitalik Buterin

RLN (Rate-Limit Nullifiers) bind anonymity to a financial stake. Users deposit once, make thousands of API calls anonymously. Honest users remain unlinkable; double-spenders reveal their secret key and get slashed.

**Key primitives:**
- Secret key `k`, deposit `D`, max cost per request `C_max`, ticket index `i` (strictly increasing counter)
- Refund tickets `{r_1, ..., r_n}` — signed by server after each call for `C_max - C_actual`
- Solvency proof: `(i + 1) · C_max ≤ D + R` where `R = Σ refunds`
- RLN nullifier prevents double-spend; reuse reveals `k` → slashing
- Dual staking: `D` (RLN stake, claimable by anyone on double-spend) + `S` (policy stake, burned-not-claimed on ToS violation)

**V2 (Homomorphic Refund Accumulation):**
- Replace growing list of refund tickets with Pedersen commitment `E(R)`
- Server homomorphically updates: `E(R_new) = E(R) ⊕ E(r)`
- Server signs the new ciphertext, user proves opening + solvency in ZK
- Constant client-side data and circuit complexity

## Comment-by-Comment Analysis

### Post #2 — YQ (@jiayaoqijia)
> "Really cool approach. Was looking at similar directions but got blocked by cost and efficiency."

Generic positive. No technical content.

### Post #3 — Stan Kladko (@kladkogex)
> "No market for it. Solution in search of a problem. Privacy seekers will run local models. Inference costs dropping to nothing via ASICs."

**Assessment:** Wrong on multiple counts. SOTA LLMs require ~$50K+ in VRAM (Micah's rebuttal). Local models can't match hosted capabilities. Metering has made sense at every scale of electricity delivery and will for compute too. The "just run it locally" argument ignores that model capability gaps between local and hosted are widening, not shrinking.

### Post #4 — Micah Zoltu (@MicahZoltu)
> Prefers ZK payment over non-ZK. Hates monthly billing. Local VRAM can't fit modern SOTA models (~$50K minimum). Hardware goes out of date before you get your money's worth vs shared resource.

**Assessment:** Correct. The shared-resource economic argument for hosted inference is durable. Also correctly identifies the privacy preference as a feature worth paying for.

### Post #5 — Micah Zoltu
> Pay-per-request and rate-limiting are different use cases. Either you have a paid service where spam isn't an issue, or a free service where rate-limiting matters. Could these be two separate protocols?

**Assessment:** Good architectural observation. In our system, the CLAWD staking model serves both purposes — the stake IS the payment AND the spam prevention. Single mechanism.

### Post #6 — Omar Espejel (@omarespejel) ⭐ MOST IMPORTANT COMMENT
> 1. Refund mechanism leaks via traffic analysis (token counts, TTFT, generation latency, speculative decoding acceptance rates). vLLM CVE-2025-46570 achieved AUC 0.99 on 8-token prefix cache timing.
> 2. Proposes fixed output tiers (256/512/1024/2048 tokens) to eliminate refund circuit entirely. Flat pricing per (input_class × output_class) cell. ~20-40% overhead.

**Assessment:** Point 1 is devastating and correct. Traffic analysis is a fundamental limit that no nullifier scheme can overcome without additional infrastructure (mixnets, padding). This directly supports the conversation-credit approach — per-call unlinkability is already defeated in practice.

Point 2 is killed by Vitalik in post #28 (100x overhead, not 20-40%), but the k-anonymity principle is correct and can be applied at the deposit layer instead (see: quantized credit denominations).

### Post #7 — Stan Kladko (reply to Micah)
> "OpenAI already sells credits without blockchain. KYC/AML means anonymous agents can't sell services."

**Assessment:** Misses the point. The proposal isn't about replacing OpenAI's payment system — it's about building a privacy layer that privacy-focused providers adopt first. KYC/AML argument is a policy question, not a technical limitation.

### Post #8 — Stan Kladko (reply to Omar)
> "Prompts will deanonymize users anyway. Corps use Gemini/Copilot. Government will run own models."

**Assessment:** "Prompts deanonymize" is true (stylometric attribution is real) but doesn't invalidate payment unlinkability. They're separable layers. You don't reject HTTPS because browser fingerprinting exists (Omar's rebuttal in post #13).

### Post #9 — John Guilding
> Could a simpler design be a state channel between client and server?

**Assessment:** Micah correctly responds (post #10) that state channels correlate requests with each other. Loses the core unlinkability property. However, the conversation-credit bearer token IS essentially a mini state channel bounded to one conversation — we accept linkability within but break it between.

### Post #10 — Micah Zoltu (reply to Guilding)
> State channels correlate requests. "If you ask about a local restaurant, then in another context window ask how to overthrow the Iranian government, the provider can't connect the two."

**Assessment:** This is the clearest articulation of what cross-conversation unlinkability actually protects. Conversation credits preserve exactly this property.

### Post #11 — Micah Zoltu (reply to Kladko)
> Expects Venice.ai, PPQ.ai to adopt first, then trickles up. This proposal doesn't require blockchain (correcting Kladko).

**Assessment:** Correct. Our implementation on Base is a design choice, not a requirement. The ZK proofs are verified off-chain by the server; the chain is just for deposits/staking.

### Post #12 — Akash Madhusudan (@AkashMVerma)
> Prior work: "Nirvana" (ePrint 2022/872) and "Reusable, Instant and Private Payment Guarantees" (ACISP 2023). Same guarantees, different crypto machinery. Built 4Mica (4mica.xyz) — live on testnet.

**Assessment:** Relevant prior art. The deposit → cryptographic payment guarantee → instant execution → batched settlement flow matches our approach. Worth studying their implementation for lessons learned.

### Post #13 — Omar Espejel (reply to Kladko)
> "You don't reject HTTPS because browser fingerprinting exists." Payment unlinkability and content anonymity are separable layers. GPU TEE enclaves handle prompt confidentiality.

**Assessment:** Correct layering argument. Our two-layer stack (ZK for identity, Venice TEE/E2EE for content) implements exactly this separation.

### Post #14 — Zekoxyz
> Building on Zeko rollup. Question about UX/proving speed tradeoff of RLN vs model-level rate limiting.

**Assessment:** Proving speed is a real concern. Our current circuit (Poseidon2 Merkle membership) takes 10-30s. Adding RLN or EdDSA verification in-circuit would increase this significantly.

### Post #15 — 4aelius ⭐ IMPORTANT
> Self-slashing attack: user makes N requests, then deliberately double-spends to recover deposit D before server claims payment.

**Assessment:** Critical unresolved flaw. Conversation credits eliminate this — stake is consumed at proof verification time. No settlement race.

### Post #16 — Crapis (reply to Omar)
> Added homomorphic refund accumulation to address fixed-tier concerns.

**Assessment:** The v2 update introduces its own problems (see post #17).

### Post #17 — Omar Espejel (reply to Crapis) ⭐ IMPORTANT
> 1. E(R) linkability: server sees E(R) at settlement, recognizes it from previous signature. Wrote a simulation proving full per-user chain recovery from settlement log.
> 2. Parallelization broken: E(R) only updates after settlement. Parallel requests carry stale state.

**Assessment:** Point 1 is the same structural flaw as Issue #11's encrypted balance model. Server-signed state that travels with the user across requests creates a linkability chain. Needs re-randomization + blind signatures (BBS+) to fix — significant additional complexity.

Point 2 means the v2 design loses one of v1's key advantages (parallelizable requests).

### Post #18 — Crapis (reply to Omar)
> Acknowledged. Added re-randomization to v2 spec. Removed parallelization from v2 for now.

**Assessment:** Honest response. But the re-randomization + blind signature requirement is non-trivial and not fully specified.

### Post #19 — JSeam
> W-9/tax compliance concerns for service providers.

**Assessment:** Real regulatory question. Privacy Pools (post #23) or proof-of-innocence could address this. Out of scope for the protocol itself.

### Posts #20-22 — Zekoxyz
> Demo implementation on Zeko rollup, shared repo link.

**Assessment:** Another implementation data point. Didn't include RLN slashing due to "greater complexity and slower proof generation speed" — validates our concern about circuit complexity.

### Post #23 — Dbrizz ⭐ IMPORTANT
> Deposit itself is public on-chain. Temporal correlation between deposit and first usage is trivially linkable. USDC blacklist risk. Suggests shielded deposits or Privacy Pools integration.

**Assessment:** Valid concern that applies to all versions including ours. Mitigations:
1. Quantized credit denominations (all deposits look identical) — see Issue #13
2. Deposit well in advance of usage (temporal decorrelation)
3. Use native CLAWD token rather than USDC to avoid blacklist risk
4. Privacy Pools integration for regulatory compliance without breaking privacy

### Post #24 — Stan Kladko
> "Any PC will run LLM in the future. Who would use this?"

**Assessment:** Repeating earlier argument. Already addressed by Micah.

### Post #25 — Micah Zoltu (reply to Kladko)
> Models equivalent to today's SOTA will run locally, but bigger hardware will always yield better/smarter/faster AIs. Also useful for non-LLM services (captcha bypass, etc).

**Assessment:** Correct. The gap between local and hosted will narrow for current-gen capabilities but persist at the frontier. And the protocol is general beyond LLMs.

### Post #26 — Sergei Tikhomirov ⭐ CRITICAL
> RLN deposit tries to be both slashable stake AND payment. Payment channel mental model: when does the server claim D? Self-slashing is dominant strategy for rational anonymous user. "Is RLN a good payment mechanism?"

**Assessment:** The most rigorous articulation of the self-slashing problem. RLN is designed for rate-limiting, not payment. Using it for both creates a fundamental tension. Conversation credits separate the concerns: onchain stake is the spam-prevention/payment mechanism (consumed at proof time), bearer token is the session management mechanism.

### Post #27 — Esteban Abaroa
> P2P communities / gossipsub bulletin boards need antispam. Credit-based approach useful for that.

**Assessment:** Interesting application domain. The "deposit funds, get credits to publish" model is broadly applicable.

### Post #28 — Vitalik Buterin ⭐ CRITICAL
> 1. Fixed-tier overhead would be ~100x, not 20-40%. Needs >$5 budget, average cost ~$0.01. Distribution is heavy-tailed (Levy-ish).
> 2. Assumes worse security model: server is forwarder to OpenAI/Anthropic, completely untrusted.
> 3. Privacy requires mixnets + local model sanitization on top of ZK-API.
> 4. **Key insight: system isn't fragile.** Even if 80% of requests get linked, remaining 20% stay anonymized. Partial anonymity >> no anonymity.

**Assessment:** The 100x number is the definitive argument for variable pricing. The non-fragile partial anonymity framing is the right mental model. Conversation credits implement exactly this: accept the 80% (within-conversation), protect the 20% (between conversations).

### Post #29 — Stan Kladko
> "Tell the LLM your budget and it'll stay within it."

**Assessment:** Not how token economics work. The LLM doesn't control thinking token usage, context window size, or multi-step reasoning depth. Also doesn't address the user's actual intent (asking open-ended questions).

### Post #30 — WGlynn ⭐ IMPORTANT
> Shipped x402 + SIWX wallet sessions. 290 lines. Sacrifices unlinkability. The real privacy boundary is agent-to-agent (Agent A shouldn't know Agent B is funded by same wallet), not user-to-server. Quantized pricing (FREE/LOW/MEDIUM/HIGH tiers) is underrated.

**Assessment:** The agent-to-agent privacy reframing is the most important insight for our use case. Multi-agent wallets funded from the same source need cross-agent unlinkability. Conversation credits provide this naturally — different agents burn different nullifiers.

The quantized pricing approach (tiers not tokens) is interesting but faces the same 100x overhead problem for heavy-tailed distributions.

### Post #31 — Drew Stone (@drstone)
> Building vLLM inference + shielded pool + RLN payment gateway on Tangle Network. Looking for GPU contributors.

**Assessment:** Another implementation. The shielded pool + RLN payment gateway is interesting prior art. Audited shielded pool design could inform deposit privacy improvements.

## Unresolved Problems in the Paper

1. **Self-slashing attack** — Rational anonymous users can recover deposits after receiving service. No solution proposed.
2. **E(R) linkability** — Homomorphic accumulation reveals per-user chains via settlement log. Needs re-randomization + blind signatures (BBS+), which is unspecified.
3. **Fixed-tier overhead** — 100x for real-world LLM usage patterns (Vitalik). Variable pricing is mandatory.
4. **Deposit privacy** — Public onchain deposits enable temporal correlation. Partially addressable via quantized denominations.
5. **Traffic analysis** — Server-side metadata (timing, token counts, TTFT) defeats per-call nullifier unlinkability. Fundamental limit without mixnets/padding.
6. **Server trust for refund honesty** — Anonymous users can't dispute under-reported refunds without deanonymizing (Omar, post #6).

## How Conversation Credits Map to These Findings

| Problem | Paper Status | Conversation Credits |
|---|---|---|
| Self-slashing | Unresolved | **Eliminated** — stake consumed at proof time |
| E(R) linkability | Acknowledged, unfixed | **N/A** — no homomorphic state between sessions |
| Variable pricing | Requires refund circuit | **Solved** — server-side per-call deduction |
| Deposit privacy | Unaddressed | **Improved** — quantized denominations (Issue #13) |
| Traffic analysis | Fundamental limit | **Honest** — accepts within-session, breaks between |
| Refund honesty | Unresolved | **Bounded** — trust limited to $1 session windows |
| Agent-to-agent privacy | Not discussed | **Natural** — different nullifiers per agent |

## Key Quotes for Reference

> "Even if 80% of your requests get linked together based on content and timing, the remaining 20% stay anonymized." — Vitalik Buterin, post #28

> "Where ZK becomes essential: multi-agent workflows where Agent A shouldn't know that Agent B is also being funded by the same wallet." — WGlynn, post #30

> "You don't reject HTTPS because browser fingerprinting exists." — Omar Espejel, post #13

> "Is RLN a good payment mechanism?" — Sergei Tikhomirov, post #26
