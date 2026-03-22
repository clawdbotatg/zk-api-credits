import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { createPublicClient, http, webSocket, parseAbi, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { Barretenberg, Fr } from "@aztec/bb.js";
import { VerifierPool } from "./verifier-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Initialize Barretenberg for Poseidon2 hashing ────────────
// bb.js poseidon2Hash is the ONLY correct Poseidon2 implementation
// that matches Noir's Poseidon2::hash and the on-chain LibPoseidon2.
// DO NOT use poseidon-lite — its "poseidon2" is original Poseidon with 2 inputs,
// which is a completely different hash function.
let bb: Barretenberg;

async function poseidon2Hash(left: bigint, right: bigint): Promise<bigint> {
  const result = await bb.poseidon2Hash([new Fr(left), new Fr(right)]);
  return BigInt(result.toString());
}

// ─── Precomputed zero hashes (computed at startup) ────────────
const MAX_DEPTH = 16;
let zeros: bigint[] = [];

async function precomputeZeros() {
  zeros = new Array(MAX_DEPTH);
  zeros[0] = 0n;
  for (let i = 0; i < MAX_DEPTH - 1; i++) {
    zeros[i + 1] = await poseidon2Hash(zeros[i], zeros[i]);
  }
  console.log("Zero hashes precomputed.");
}

// ─── Configuration ────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const VENICE_API_KEY = process.env.VENICE_API_KEY as string;
if (!VENICE_API_KEY) throw new Error("VENICE_API_KEY is required — set it in packages/api-server/.env");
const VENICE_BASE_URL =
  process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS as `0x${string}`;
const RPC_URL = process.env.RPC_URL || "https://mainnet.base.org";
const WS_URL = process.env.WS_URL || "";
const NULLIFIER_FILE = process.env.NULLIFIER_FILE || "./data/spent-nullifiers.json";

// Circuit bytecode path — loaded by VerifierPool for UltraHonk proof verification
const CIRCUIT_PATH = process.env.CIRCUIT_PATH || path.resolve(
  __dirname,
  "../../circuits/target/circuits.json"
);

// Worker pool for proof verification (initialized in start())
let verifierPool: VerifierPool;

// ─── On-Chain Root Verification ───────────────────────────────
const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// WebSocket client for real-time event watching (if WS_URL configured)
const wsClient = WS_URL
  ? createPublicClient({ chain: base, transport: webSocket(WS_URL) })
  : null;

const API_CREDITS_ABI = parseAbi([
  "function getTreeData() view returns (uint256 size, uint256 depth, uint256 root)",
]);

// ─── Historical Root Tracking (Privacy Fix) ───────────────────
// PROBLEM: Accepting only the current onchain root creates a timing
// correlation attack. When a new commitment is registered, the root
// changes. Any proof generated against the old root is rejected,
// forcing users to regenerate proofs immediately — which reveals
// who they are in a low-traffic system.
//
// FIX: Maintain a rolling set of all historical Merkle roots.
// Accept any proof against a root that existed within the last
// VALID_ROOT_WINDOW blocks (~24h on Base). We replay all
// CreditRegistered events on startup to build the full history,
// then poll for new events to keep it updated.

const VALID_ROOT_WINDOW = 7200n; // ~24h on Base (2s block time)

// root hex string → block number when it became the active root
const validRoots = new Map<string, bigint>();

// Persistent Semaphore-style tree state for incremental root computation.
// This mirrors the contract's filledNodes array exactly.
const treeFilledNodes: bigint[] = new Array(MAX_DEPTH).fill(0n);
let treeSize = 0;

// Cached tree leaves for /tree endpoint (avoids RPC calls per request)
const treeLeaves: bigint[] = [];

// The latest (current) root — never pruned from the valid set
let currentRoot: string | null = null;

// Last block processed by the event watcher
let lastProcessedBlock = 0n;

function rootToHex(root: bigint): string {
  return "0x" + root.toString(16).padStart(64, "0");
}

/**
 * Compute the Merkle root from the current filledNodes state.
 * Replicates the contract's _computeRoot logic exactly.
 */
async function computeRootFromFilledNodes(size: number): Promise<bigint> {
  if (size === 0) return 0n;

  let node = 0n;
  let nodeLevel = -1;
  let hasNode = false;

  for (let i = 0; i < MAX_DEPTH; i++) {
    if (((size >> i) & 1) === 1) {
      if (!hasNode) {
        node = treeFilledNodes[i];
        nodeLevel = i;
        hasNode = true;
      } else {
        for (let lvl = nodeLevel; lvl < i; lvl++) {
          node = await poseidon2Hash(node, zeros[lvl]);
        }
        node = await poseidon2Hash(treeFilledNodes[i], node);
        nodeLevel = i + 1;
      }
    }
  }

  return node;
}

/**
 * Insert a leaf into the incremental tree and return the new root.
 * Replicates the contract's Semaphore-style _insert + _computeRoot.
 */
async function insertLeafAndGetRoot(commitment: bigint): Promise<bigint> {
  treeLeaves.push(commitment);
  let node = commitment;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (((treeSize >> i) & 1) === 0) {
      treeFilledNodes[i] = node;
      break;
    } else {
      node = await poseidon2Hash(treeFilledNodes[i], node);
    }
  }
  treeSize++;
  return computeRootFromFilledNodes(treeSize);
}

/**
 * Prune roots older than VALID_ROOT_WINDOW blocks.
 * The current root is never pruned.
 */
async function pruneOldRoots(): Promise<void> {
  try {
    const currentBlock = await publicClient.getBlockNumber();
    const cutoff = currentBlock > VALID_ROOT_WINDOW
      ? currentBlock - VALID_ROOT_WINDOW
      : 0n;
    let pruned = 0;

    for (const [root, blockNum] of validRoots) {
      if (blockNum < cutoff && root !== currentRoot) {
        validRoots.delete(root);
        pruned++;
      }
    }

    if (pruned > 0) {
      console.log(
        `Pruned ${pruned} roots older than block ${cutoff}. ${validRoots.size} remain.`
      );
    }
  } catch (err) {
    console.error("Error pruning old roots:", err);
  }
}

/**
 * Replay all CreditRegistered events to build the full set of historical roots.
 * Each insertion produces a new root; we store every root with its block number.
 */
async function buildHistoricalRoots(): Promise<void> {
  console.log("Building historical root set from CreditRegistered events...");

  const events = await publicClient.getLogs({
    address: CONTRACT_ADDRESS,
    event: parseAbiItem(
      "event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)"
    ),
    fromBlock: 0n,
  });

  if (events.length === 0) {
    console.log("No CreditRegistered events found.");
    return;
  }

  // Sort by index to replay insertions in correct order
  const sorted = events.sort(
    (a, b) => Number(a.args.index!) - Number(b.args.index!)
  );

  for (const event of sorted) {
    const root = await insertLeafAndGetRoot(event.args.commitment!);
    const rootHex = rootToHex(root);
    validRoots.set(rootHex, event.blockNumber);
    currentRoot = rootHex;

    // Also register the compact root for this tree state
    const compactRoot = await computeCompactRoot(treeLeaves);
    if (compactRoot !== null) {
      const compactRootHex = rootToHex(compactRoot);
      if (compactRootHex !== rootHex) {
        validRoots.set(compactRootHex, event.blockNumber);
      }
    }
  }

  // Verify our computed root matches the contract's current root
  try {
    const [, , contractRoot] = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: API_CREDITS_ABI,
      functionName: "getTreeData",
    });
    const contractRootHex = rootToHex(contractRoot);
    if (currentRoot === contractRootHex) {
      console.log(`✓ Computed root matches onchain: ${currentRoot}`);
    } else {
      console.error(
        `✗ ROOT MISMATCH! Computed: ${currentRoot}, Onchain: ${contractRootHex}`
      );
    }
  } catch {
    console.log("Could not verify root against contract (may be empty).");
  }

  console.log(
    `Built ${validRoots.size} historical roots from ${events.length} events.`
  );

  // Prune roots outside the validity window
  await pruneOldRoots();
}

/**
 * Poll for new CreditRegistered events every 10 seconds.
 * Updates the tree state and valid roots set incrementally.
 */
/**
 * Compute the compact Merkle root from a list of leaves.
 * depth = ceil(log2(n)), padded with zeros[0] on right.
 * This is the root clients generate proofs against via /tree.
 */
async function computeCompactRoot(leaves: bigint[]): Promise<bigint | null> {
  const n = leaves.length;
  if (n === 0) return null;

  let depth = 0;
  let tmp = n;
  while (tmp > 1) { depth++; tmp = Math.ceil(tmp / 2); }

  const level0Size = depth === 0 ? 1 : 1 << depth;
  let level: bigint[] = new Array(level0Size);
  for (let i = 0; i < level0Size; i++) {
    level[i] = i < n ? leaves[i] : zeros[0];
  }
  for (let lvl = 0; lvl < depth; lvl++) {
    const parentSize = level.length >> 1;
    const parent: bigint[] = new Array(parentSize);
    for (let j = 0; j < parentSize; j++) {
      parent[j] = await poseidon2Hash(level[j * 2], level[j * 2 + 1]);
    }
    level = parent;
  }
  return level[0];
}

async function handleNewEvent(event: {
  args: { commitment?: bigint; index?: bigint };
  blockNumber: bigint | null;
}): Promise<void> {
  if (!event.args.commitment || event.blockNumber === null) return;
  const root = await insertLeafAndGetRoot(event.args.commitment);
  const rootHex = rootToHex(root);
  validRoots.set(rootHex, event.blockNumber);
  currentRoot = rootHex;
  if (event.blockNumber > lastProcessedBlock) lastProcessedBlock = event.blockNumber;

  // Also register the compact root that /tree returns — clients generate
  // proofs against this root (depth=ceil(log2(n))), not the incremental root.
  const compactRoot = await computeCompactRoot(treeLeaves);
  if (compactRoot !== null) {
    const compactRootHex = rootToHex(compactRoot);
    if (compactRootHex !== rootHex) {
      validRoots.set(compactRootHex, event.blockNumber);
    }
  }

  console.log(`New root: ${rootHex} (block ${event.blockNumber}, index ${event.args.index})`);
  await pruneOldRoots();
}

function startEventWatcher(): void {
  const eventAbi = parseAbiItem(
    "event CreditRegistered(address indexed user, uint256 indexed index, uint256 commitment, uint256 newStakedBalance)"
  );

  if (wsClient) {
    // ── WebSocket path: fires within ~1 block (~2s) of tx confirmation ──
    wsClient.watchContractEvent({
      address: CONTRACT_ADDRESS,
      abi: [eventAbi],
      eventName: "CreditRegistered",
      onLogs: async (logs) => {
        const sorted = [...logs].sort((a, b) => Number(a.args.index!) - Number(b.args.index!));
        for (const log of sorted) {
          await handleNewEvent(log).catch(err =>
            console.error("Event handler error:", err)
          );
        }
      },
      onError: (err) => console.error("WebSocket watcher error:", err),
    });
    console.log("Event watcher started (WebSocket — real-time).");
  }

  // ── Polling fallback: runs every 2s regardless (catches WS gaps) ──
  setInterval(async () => {
    try {
      const currentBlock = await publicClient.getBlockNumber();
      if (currentBlock <= lastProcessedBlock) return;

      const events = await publicClient.getLogs({
        address: CONTRACT_ADDRESS,
        event: eventAbi,
        fromBlock: lastProcessedBlock + 1n,
        toBlock: currentBlock,
      });

      if (events.length > 0) {
        const sorted = events.sort((a, b) => Number(a.args.index!) - Number(b.args.index!));
        for (const event of sorted) {
          await handleNewEvent(event).catch(err =>
            console.error("Poll handler error:", err)
          );
        }
      } else {
        lastProcessedBlock = currentBlock;
      }
    } catch (err) {
      console.error("Poll watcher error:", err);
    }
  }, 2_000);

  if (!wsClient) console.log("Event watcher started (polling every 2s — set WS_URL for real-time).");
}

// ─── Redis Nullifier Storage ──────────────────────────────────
// Atomic SADD/SISMEMBER — no file corruption, no write races, crash-safe.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
const NULLIFIER_KEY = "nullifiers";
const pendingNullifiers = new Set<string>();

async function isNullifierSpent(hash: string): Promise<boolean> {
  return !!(await redis.sismember(NULLIFIER_KEY, hash));
}

async function saveNullifier(hash: string): Promise<void> {
  await redis.sadd(NULLIFIER_KEY, hash);
}

async function getNullifierCount(): Promise<number> {
  return redis.scard(NULLIFIER_KEY);
}

// Migrate existing file-based nullifiers into Redis on startup (one-time)
async function migrateNullifiersFromFile(): Promise<number> {
  try {
    const data = JSON.parse(fs.readFileSync(NULLIFIER_FILE, "utf-8")) as string[];
    if (data.length === 0) return 0;
    await redis.sadd(NULLIFIER_KEY, ...data as [string, ...string[]]);
    console.log(`[startup] Migrated ${data.length} nullifiers from file → Redis`);
    return data.length;
  } catch {
    return 0; // file doesn't exist or empty — that's fine
  }
}

// ─── Model (locked for demo — one credit, one model) ─────────
const MODEL = process.env.VENICE_MODEL || "e2ee-glm-5";

// ─── Express App ──────────────────────────────────────────────
const app = express();

// Trust proxy headers (required for correct IP detection behind AWS/Cloudflare)
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ─── Rate Limiting ────────────────────────────────────────────
// /v1/chat is CPU-heavy (2s ZK proof verification per request).
// Without throttling, an attacker can saturate the verifier pool
// with garbage proofs and DoS all legitimate users at zero cost.
const chatLimiter = rateLimit({
  windowMs: 60_000,           // 1-minute rolling window
  max: parseInt(process.env.RATE_LIMIT_CHAT || "10"),  // 10 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a moment and try again" },
});

// Light limiter for read endpoints (tree, circuit, stats) — prevents scraping/hammering
const readLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_READ || "60"),  // 60 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Health check
app.get("/health", async (_req, res) => {
  res.json({
    status: "ok",
    spentNullifiers: await getNullifierCount(),
    currentRoot,
    validRoots: validRoots.size,
    treeSize,
  });
});

// Get server stats
app.get("/stats", async (_req, res) => {
  res.json({
    spentNullifiers: await getNullifierCount(),
    currentRoot,
    validRoots: validRoots.size,
    treeSize,
  });
});

// Check if a nullifier has been spent
app.get("/nullifier/:hash", async (req, res) => {
  const spent = await isNullifierSpent(req.params.hash);
  res.json({ spent });
});

// ─── Contract Info ─────────────────────────────────────────────
// GET /contract — returns current contract address (for update.sh auto-sync)
app.get("/contract", (_req, res) => {
  res.json({ address: CONTRACT_ADDRESS, chainId: 8453 });
});

// ─── Circuit Artifact ──────────────────────────────────────────
// GET /circuit
// Returns the compiled Noir circuit JSON for client-side proof generation
app.get("/circuit", readLimiter, (_req, res) => {
  try {
    const circuitPath = process.env.CIRCUIT_PATH || path.resolve(__dirname, "../../circuits/target/circuits.json");
    const circuit = JSON.parse(fs.readFileSync(circuitPath, "utf-8"));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(circuit);
  } catch (err: any) {
    res.status(500).json({ error: "Circuit not found: " + err.message });
  }
});

// ─── Full Tree Data (Privacy-Preserving) ──────────────────────
// GET /tree
// readLimiter: tree rebuild is O(n) Poseidon hashes — cap it
// Returns ALL tree data (leaves, precomputed levels, root, depth, zeros).
// The client computes its own Merkle path locally — the server never learns
// which commitment is about to be used. This replaces /merkle-path/:commitment.
app.get("/tree", readLimiter, async (_req, res) => {
  const tTree = Date.now();
  try {
    const leaves = treeLeaves;
    const numLeaves = leaves.length;

    if (numLeaves === 0) {
      res.json({
        leaves: [],
        levels: [],
        root: "0",
        depth: 0,
        zeros: zeros.map((z) => z.toString()),
      });
      return;
    }

    // Use the actual tree depth (ceil(log2(numLeaves))) for Merkle paths.
    // The circuit uses MAX_DEPTH=16 — clients pad indices/siblings to 16.
    // The root must match the incremental Semaphore-style tree, so we
    // compute depth levels for path extraction, then fold remaining
    // levels up to MAX_DEPTH using zero hashes (same as the contract).
    let treeDepth = 0;
    {
      let tmp = numLeaves;
      while (tmp > 1) {
        treeDepth++;
        tmp = Math.ceil(tmp / 2);
      }
    }

    // Build full level-by-level tree from cached leaves (no RPC calls)
    const levels: bigint[][] = [];
    const level0Size = treeDepth === 0 ? 1 : 1 << treeDepth;
    levels[0] = new Array(level0Size);
    for (let i = 0; i < level0Size; i++) {
      levels[0][i] = i < numLeaves ? leaves[i] : zeros[0];
    }
    for (let lvl = 0; lvl < treeDepth; lvl++) {
      const parentSize = levels[lvl].length >> 1;
      levels[lvl + 1] = new Array(parentSize);
      for (let j = 0; j < parentSize; j++) {
        levels[lvl + 1][j] = await poseidon2Hash(levels[lvl][j * 2], levels[lvl][j * 2 + 1]);
      }
    }

    const treeRoot = levels[treeDepth]?.[0] ?? leaves[0];

    console.log(`[tree] built ${numLeaves} leaves (depth ${treeDepth}) in ${Date.now() - tTree}ms`);
    res.json({
      leaves: leaves.map((l) => l.toString()),
      levels: levels.map((level) => level.map((n) => n.toString())),
      root: treeRoot.toString(),
      depth: treeDepth,
      zeros: zeros.map((z) => z.toString()),
    });
  } catch (err: any) {
    console.error(`[tree] error after ${Date.now() - tTree}ms:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API Key Endpoint (server-side proof generation) ──────────
// POST /v1/chat/key
// Accepts a one-time API key, generates the ZK proof server-side,
// verifies it, and proxies to Venice. No bb.js needed on the client.

// Lazy-loaded Noir + UltraHonkBackend for proof generation
let noirInstance: any = null;
let proverBackend: any = null;
let circuitData: any = null;

async function getProverBackend() {
  if (proverBackend) return { noir: noirInstance, backend: proverBackend, circuit: circuitData };

  const { Noir } = await import("@noir-lang/noir_js");
  const { UltraHonkBackend } = await import("@aztec/bb.js");

  circuitData = JSON.parse(fs.readFileSync(CIRCUIT_PATH, "utf-8"));
  noirInstance = new Noir(circuitData);
  proverBackend = new UltraHonkBackend(circuitData.bytecode);

  console.log("[key] Noir + UltraHonkBackend initialized for server-side proving");
  return { noir: noirInstance, backend: proverBackend, circuit: circuitData };
}

function decodeApiKey(apiKey: string): { nullifier: string; secret: string; commitment: string } | null {
  if (!apiKey || !apiKey.startsWith("zk-llm-")) return null;
  try {
    const b64url = apiKey.slice(7); // strip "zk-llm-"
    // base64url → base64
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(b64, "base64").toString("utf-8");
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    const [nullifier, secret, commitment] = parts;
    // Validate they look like bigints
    BigInt(nullifier);
    BigInt(secret);
    BigInt(commitment);
    return { nullifier, secret, commitment };
  } catch {
    return null;
  }
}

app.post("/v1/chat/key", chatLimiter, async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const ts = () => `+${Date.now() - t0}ms`;
  console.log(`[${reqId}] POST /v1/chat/key — received`);

  const { apiKey, messages, encrypted_messages } = req.body;
  const isE2EE = !!encrypted_messages;

  // ─── Decode API Key ─────────────────────────────────────
  const decoded = decodeApiKey(apiKey);
  if (!decoded) {
    res.status(400).json({ error: "Invalid API key format — expected zk-llm-<base64url>" });
    return;
  }
  const { nullifier, secret, commitment } = decoded;
  console.log(`[${reqId}] API key decoded, commitment=${commitment.slice(0, 12)}... (${ts()})`);

  if (!isE2EE && (!messages || !Array.isArray(messages))) {
    res.status(400).json({ error: "Missing required field: messages (or encrypted_messages for E2EE)" });
    return;
  }

  // ─── Compute nullifier hash ─────────────────────────────
  const nullifierBigInt = BigInt(nullifier);
  const nullifierHashFr = await bb.poseidon2Hash([new Fr(nullifierBigInt)]);
  const nullifierHash = "0x" + BigInt(nullifierHashFr.toString()).toString(16).padStart(64, "0");
  console.log(`[${reqId}] nullifier_hash=${nullifierHash.slice(0, 20)}... (${ts()})`);

  // ─── Check nullifier not already spent ──────────────────
  if (pendingNullifiers.has(nullifierHash)) {
    res.status(429).json({ error: "This credit is currently being processed — try again in a moment" });
    return;
  }
  if (await isNullifierSpent(nullifierHash)) {
    res.status(403).json({ error: "This API key has already been used (nullifier spent)" });
    return;
  }
  pendingNullifiers.add(nullifierHash);

  try {
    // ─── Find commitment in tree ────────────────────────────
    const commitmentBigInt = BigInt(commitment);
    const leafIndex = treeLeaves.findIndex(l => l === commitmentBigInt);
    if (leafIndex === -1) {
      res.status(403).json({
        error: "Commitment not found in tree — it may not have been registered yet, or was registered after the current root",
      });
      return;
    }
    console.log(`[${reqId}] commitment found at leafIndex=${leafIndex} (${ts()})`);

    // ─── Build Merkle path ──────────────────────────────────
    const numLeaves = treeLeaves.length;
    let treeDepth = 0;
    { let tmp = numLeaves; while (tmp > 1) { treeDepth++; tmp = Math.ceil(tmp / 2); } }

    const level0Size = treeDepth === 0 ? 1 : 1 << treeDepth;
    const levels: bigint[][] = [];
    levels[0] = new Array(level0Size);
    for (let i = 0; i < level0Size; i++) {
      levels[0][i] = i < numLeaves ? treeLeaves[i] : zeros[0];
    }
    for (let lvl = 0; lvl < treeDepth; lvl++) {
      const parentSize = levels[lvl].length >> 1;
      levels[lvl + 1] = new Array(parentSize);
      for (let j = 0; j < parentSize; j++) {
        levels[lvl + 1][j] = await poseidon2Hash(levels[lvl][j * 2], levels[lvl][j * 2 + 1]);
      }
    }

    const root = levels[treeDepth]?.[0] ?? treeLeaves[0];
    const rootHex = "0x" + root.toString(16).padStart(64, "0");

    // Compute siblings and indices, padded to MAX_DEPTH=16
    const siblings: bigint[] = [];
    const indices: number[] = [];
    let idx = leafIndex;
    for (let i = 0; i < MAX_DEPTH; i++) {
      if (i < treeDepth) {
        const sibIdx = idx ^ 1;
        siblings.push(levels[i][sibIdx]);
      } else {
        siblings.push(zeros[i]);
      }
      indices.push((leafIndex >> i) & 1);
      idx >>= 1;
    }

    console.log(`[${reqId}] Merkle path computed, root=${rootHex.slice(0, 20)}... depth=${treeDepth} (${ts()})`);

    // ─── Verify root is valid ───────────────────────────────
    if (!validRoots.has(rootHex)) {
      res.status(403).json({ error: "Computed root not in valid root set — tree may have changed" });
      return;
    }

    // ─── Generate ZK proof server-side ──────────────────────
    console.log(`[${reqId}] generating ZK proof server-side... (${ts()})`);
    const tProofStart = Date.now();

    let proofHex: string;
    try {
      const { noir, backend } = await getProverBackend();

      const circuitInputs = {
        nullifier_hash: nullifierHash,
        root: rootHex,
        depth: treeDepth,
        nullifier: "0x" + nullifierBigInt.toString(16).padStart(64, "0"),
        secret: "0x" + BigInt(secret).toString(16).padStart(64, "0"),
        indices: indices,
        siblings: siblings.map(s => "0x" + s.toString(16).padStart(64, "0")),
      };

      const { witness } = await noir.execute(circuitInputs);
      const proof = await backend.generateProof(witness);

      proofHex = "0x" + Array.from(proof.proof as Uint8Array)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");

      const proofMs = Date.now() - tProofStart;
      console.log(`[${reqId}] proof generated ✅ — ${proofMs}ms (${ts()})`);
    } catch (proofError: any) {
      const proofMs = Date.now() - tProofStart;
      console.error(`[${reqId}] proof generation failed — ${proofMs}ms:`, proofError);
      res.status(400).json({ error: "Proof generation failed", details: proofError.message });
      return;
    }

    // ─── Verify proof (same as /v1/chat) ────────────────────
    const tVerifyStart = Date.now();
    console.log(`[${reqId}] verifying proof (${ts()})`);
    try {
      const proofValid = await verifyProof(proofHex, nullifierHash, rootHex, treeDepth);
      const verifyMs = Date.now() - tVerifyStart;
      if (!proofValid) {
        console.log(`[${reqId}] proof INVALID — ${verifyMs}ms`);
        res.status(403).json({ error: "Generated proof failed verification" });
        return;
      }
      console.log(`[${reqId}] proof verified ✅ — ${verifyMs}ms`);
    } catch (verifyError: any) {
      const verifyMs = Date.now() - tVerifyStart;
      console.error(`[${reqId}] proof verification threw — ${verifyMs}ms:`, verifyError);
      res.status(403).json({ error: "Proof verification failed", details: verifyError.message });
      return;
    }

    // ─── Forward to Venice API ──────────────────────────────
    const tVeniceStart = Date.now();
    console.log(`[${reqId}] calling Venice (${ts()})${isE2EE ? " [E2EE 🔒]" : ""}`);
    try {
      const veniceHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VENICE_API_KEY}`,
      };
      const e2eeHeaderNames = [
        "x-venice-tee-client-pub-key",
        "x-venice-tee-model-pub-key",
        "x-venice-tee-signing-algo",
      ];
      for (const h of e2eeHeaderNames) {
        const val = req.headers[h] as string | undefined;
        if (val) veniceHeaders[h] = val;
      }

      const veniceBody: Record<string, any> = { model: MODEL, stream: false };
      if (isE2EE) {
        veniceBody.encrypted_messages = encrypted_messages;
        veniceBody.messages = [];
      } else {
        veniceBody.messages = messages;
      }

      const VENICE_TIMEOUT_MS = parseInt(process.env.VENICE_TIMEOUT_MS || "90000");
      const veniceResponse = await fetch(`${VENICE_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: veniceHeaders,
        body: JSON.stringify(veniceBody),
        signal: AbortSignal.timeout(VENICE_TIMEOUT_MS),
      });

      const veniceMs = Date.now() - tVeniceStart;

      if (!veniceResponse.ok) {
        const errorText = await veniceResponse.text();
        console.error(`[${reqId}] Venice error ${veniceResponse.status} — ${veniceMs}ms:`, errorText);
        res.status(502).json({ error: "Venice API error", status: veniceResponse.status });
        return;
      }

      const veniceData = await veniceResponse.json();
      const totalMs = Date.now() - t0;
      console.log(`[${reqId}] ✅ done — Venice: ${veniceMs}ms | total: ${totalMs}ms`);

      await saveNullifier(nullifierHash);
      console.log(`[${reqId}] nullifier burned (${ts()})`);

      res.json(veniceData);
    } catch (veniceError: any) {
      const veniceMs = Date.now() - tVeniceStart;
      const isTimeout = veniceError?.name === "TimeoutError" || veniceError?.name === "AbortError";
      if (isTimeout) {
        console.error(`[${reqId}] Venice timed out after ${veniceMs}ms — nullifier NOT burned`);
        res.status(504).json({ error: "Venice API timed out — your credit was NOT spent, please retry" });
      } else {
        console.error(`[${reqId}] Venice request failed — ${veniceMs}ms:`, veniceError);
        res.status(502).json({ error: "Failed to reach Venice API", details: veniceError.message });
      }
    }
  } catch (error: any) {
    console.error(`[${reqId}] unexpected error (${ts()}):`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    pendingNullifiers.delete(nullifierHash);
  }
});

/**
 * Main API endpoint — verify proof + proxy to Venice
 *
 * POST /v1/chat
 * {
 *   "proof": "<hex string>",
 *   "nullifier_hash": "0x...",
 *   "root": "0x...",
 *   "depth": 16,
 *   "messages": [{ "role": "user", "content": "..." }],
 * }
 */
app.post("/v1/chat", chatLimiter, async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const ts = () => `+${Date.now() - t0}ms`;
  console.log(`[${reqId}] POST /v1/chat — received`);

  const {
    proof,
    nullifier_hash,
    root,
    depth,
    messages,
    encrypted_messages,
  } = req.body;

  if (req.body.model && req.body.model !== MODEL) {
    console.log(`[${reqId}] client requested model "${req.body.model}" — ignored, using "${MODEL}"`);
  }

  // E2EE mode: encrypted_messages replaces messages
  const isE2EE = !!encrypted_messages;

  // ─── Input Validation ───────────────────────────────────
  if (!proof || !nullifier_hash || !root || depth === undefined) {
    res.status(400).json({
      error: "Missing required fields: proof, nullifier_hash, root, depth",
    });
    return;
  }
  if (!isE2EE && (!messages || !Array.isArray(messages))) {
    res.status(400).json({
      error: "Missing required field: messages (or encrypted_messages for E2EE)",
    });
    return;
  }

  // ─── Double-spend protection ──────────────────────────────────
  // pendingNullifiers is checked first (sync) to catch concurrent in-flight requests.
  // Redis SISMEMBER is the durable spent check (survives restarts).
  if (pendingNullifiers.has(nullifier_hash)) {
    console.log(`[${reqId}] nullifier already pending (${ts()})`);
    res.status(429).json({ error: "This nullifier is currently being processed — try again in a moment" });
    return;
  }
  if (await isNullifierSpent(nullifier_hash)) {
    console.log(`[${reqId}] nullifier already spent (${ts()})`);
    res.status(403).json({ error: "Nullifier already spent" });
    return;
  }
  if (pendingNullifiers.has(nullifier_hash)) {
    console.log(`[${reqId}] nullifier already pending (${ts()})`);
    res.status(429).json({ error: "This nullifier is currently being processed — try again in a moment" });
    return;
  }
  pendingNullifiers.add(nullifier_hash);
  console.log(`[${reqId}] nullifier + root checks passed (${ts()})`);

  try {
    // ─── Verify root is in the valid historical set ─────────
    console.log(`[${reqId}] root check: validRoots.size=${validRoots.size}, checking root=${root.slice(0, 20)}... (${ts()})`);
    if (validRoots.size === 0) {
      console.log(`[${reqId}] no valid roots (${ts()})`);
      res.status(403).json({ error: "No commitments registered yet" });
      return;
    }
    if (!validRoots.has(root)) {
      console.log(`[${reqId}] root not in valid set (${ts()})`);
      res.status(403).json({
        error: "Invalid root — not in valid root set (may be expired or incorrect)",
      });
      return;
    }
    console.log(`[${reqId}] root valid ✅ (${ts()})`);

    // ─── Queue depth guard ─────────────────────────────────
    // Reject early if all verifier workers are busy — prevents unbounded
    // queue pile-up that would delay legitimate requests indefinitely.
    if (verifierPool.activeCount >= verifierPool.size) {
      console.log(`[${reqId}] verifier pool full (${verifierPool.activeCount}/${verifierPool.size}) — rejecting (${ts()})`);
      res.status(503).json({ error: "Server busy — all verifier workers occupied, please retry in a moment" });
      return;
    }

    // ─── Verify ZK proof ───────────────────────────────────
    const tVerifyStart = Date.now();
    console.log(`[${reqId}] starting proof verification (${ts()})`);
    try {
      const proofValid = await verifyProof(proof, nullifier_hash, root, depth);
      const verifyMs = Date.now() - tVerifyStart;
      if (!proofValid) {
        console.log(`[${reqId}] proof INVALID — ${verifyMs}ms`);
        res.status(403).json({ error: "Invalid proof" });
        return;
      }
      console.log(`[${reqId}] proof verified ✅ — ${verifyMs}ms`);
    } catch (verifyError: any) {
      const verifyMs = Date.now() - tVerifyStart;
      console.error(`[${reqId}] proof verification threw — ${verifyMs}ms:`, verifyError);
      res.status(403).json({
        error: "Proof verification failed",
        details: verifyError.message,
      });
      return;
    }

    // ─── Forward to Venice API ──────────────────────────────
    const tVeniceStart = Date.now();
    console.log(`[${reqId}] calling Venice (${ts()})${isE2EE ? " [E2EE 🔒 — forwarding blind]" : ""}`);
    try {
      // Pass E2EE headers from client through to Venice if present
      const veniceHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VENICE_API_KEY}`,
      };
      const e2eeHeaderNames = [
        "x-venice-tee-client-pub-key",
        "x-venice-tee-model-pub-key",
        "x-venice-tee-signing-algo",
      ];
      for (const h of e2eeHeaderNames) {
        const val = req.headers[h] as string | undefined;
        if (val) veniceHeaders[h] = val;
      }

      // ─── Cost cap: reject if estimated Venice cost > $0.05 ─────
      // e2ee-glm-5: $1.10/1M input tokens, $4.15/1M output tokens
      // Estimate input tokens conservatively at 1 token per 4 bytes.
      const MAX_COST_USD = 0.05;
      const INPUT_PRICE_PER_TOKEN = 1.10 / 1_000_000; // $1.10 per 1M tokens

      let estimatedInputBytes: number;
      if (isE2EE && encrypted_messages) {
        estimatedInputBytes = Buffer.byteLength(
          typeof encrypted_messages === "string" ? encrypted_messages : JSON.stringify(encrypted_messages),
          "utf8"
        );
      } else {
        estimatedInputBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      }
      const estimatedInputTokens = Math.ceil(estimatedInputBytes / 4);
      const estimatedInputCost = estimatedInputTokens * INPUT_PRICE_PER_TOKEN;

      if (estimatedInputCost > MAX_COST_USD) {
        const maxBytes = Math.floor((MAX_COST_USD / INPUT_PRICE_PER_TOKEN) * 4);
        console.log(`[${reqId}] request too large — estimated $${estimatedInputCost.toFixed(4)}, cap $${MAX_COST_USD} (${estimatedInputBytes} bytes → ~${estimatedInputTokens} tokens)`);
        res.status(400).json({
          error: `Request too large — max ~${maxBytes.toLocaleString()} bytes ($${MAX_COST_USD} budget at e2ee-glm-5 pricing)`,
          detail: `Estimated cost $${estimatedInputCost.toFixed(4)} exceeds $${MAX_COST_USD} cap. Try shortening or splitting your messages.`,
        });
        return;
      }
      console.log(`[${reqId}] cost estimate: $${estimatedInputCost.toFixed(4)} (${estimatedInputBytes} bytes → ~${estimatedInputTokens} tokens) ✅`);

      // ─── Build Venice request body ────────────────────────────
      // NOTE: always stream: false — server does veniceResponse.json(), not SSE piping
      const veniceBody: Record<string, any> = {
        model: MODEL,
        stream: false,
      };
      if (isE2EE) {
        // E2EE: forward encrypted blob, Venice TEE will decrypt
        veniceBody.encrypted_messages = encrypted_messages;
        veniceBody.messages = []; // required field, sent empty
      } else {
        veniceBody.messages = messages;
      }

      const VENICE_TIMEOUT_MS = parseInt(process.env.VENICE_TIMEOUT_MS || "90000");
      const veniceResponse = await fetch(
        `${VENICE_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: veniceHeaders,
          body: JSON.stringify(veniceBody),
          signal: AbortSignal.timeout(VENICE_TIMEOUT_MS),
        }
      );

      const veniceMs = Date.now() - tVeniceStart;

      if (!veniceResponse.ok) {
        const errorText = await veniceResponse.text();
        console.error(`[${reqId}] Venice error ${veniceResponse.status} — ${veniceMs}ms:`, errorText);
        res.status(502).json({
          error: "Venice API error",
          status: veniceResponse.status,
        });
        return;
      }

      const veniceData = await veniceResponse.json();
      const totalMs = Date.now() - t0;

      // Post-call audit: verify actual Venice cost was within budget
      const usage = veniceData?.usage;
      if (usage?.prompt_tokens) {
        const actualInputCost = (usage.prompt_tokens / 1_000_000) * INPUT_PRICE_PER_TOKEN;
        const actualOutputCost = ((usage.completion_tokens || 0) / 1_000_000) * (4.15 / 1_000_000);
        const actualTotalCost = actualInputCost + actualOutputCost;
        console.log(`[${reqId}] Venice usage: ${usage.prompt_tokens} in + ${usage.completion_tokens || 0} out = $${actualTotalCost.toFixed(4)} (cap $${MAX_COST_USD})`);
        if (actualTotalCost > MAX_COST_USD) {
          console.warn(`[${reqId}] ⚠️  actual cost $${actualTotalCost.toFixed(4)} exceeded cap — consider refund or adjustment`);
        }
      }
      console.log(`[${reqId}] ✅ done — Venice: ${veniceMs}ms | total: ${totalMs}ms`);

      // ─── Mark nullifier as spent AFTER Venice succeeds ───
      await saveNullifier(nullifier_hash);
      console.log(`[${reqId}] nullifier burned (${ts()})`);

      res.json(veniceData);
    } catch (veniceError: any) {
      const veniceMs = Date.now() - tVeniceStart;
      const isTimeout = veniceError?.name === "TimeoutError" || veniceError?.name === "AbortError";
      if (isTimeout) {
        console.error(`[${reqId}] Venice timed out after ${veniceMs}ms — nullifier NOT burned, safe to retry`);
        res.status(504).json({
          error: "Venice API timed out — your credit was NOT spent, please retry",
        });
      } else {
        console.error(`[${reqId}] Venice request failed — ${veniceMs}ms:`, veniceError);
        res.status(502).json({
          error: "Failed to reach Venice API",
          details: veniceError.message,
        });
      }
      return;
    }
  } catch (error: any) {
    console.error(`[${reqId}] unexpected error (${ts()}):`, error);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    pendingNullifiers.delete(nullifier_hash);
  }
});

// ─── Proof Verification ───────────────────────────────────────
async function verifyProof(
  proofHex: string,
  nullifierHash: string,
  root: string,
  depth: number,
): Promise<boolean> {
  try {
    const publicInputs = [
      nullifierHash,
      root,
      "0x" + BigInt(depth).toString(16).padStart(64, "0"),
    ];
    return await verifierPool.verify(proofHex, publicInputs);
  } catch (error) {
    console.error("Proof verification error:", error);
    return false;
  }
}

// ─── Start Server ─────────────────────────────────────────────
async function start() {
  console.log("Initializing Barretenberg (Poseidon2 WASM)...");
  bb = await Barretenberg.new({ threads: 1 });
  console.log("Barretenberg ready.");

  // Precompute zero hashes (must happen after bb is initialized)
  await precomputeZeros();

  // Build historical root set from all past events
  await buildHistoricalRoots();

  // Initialize verifier worker pool
  const poolSize = Math.max(1, os.cpus().length - 1);
  console.log(`Initializing verifier pool (${poolSize} workers)...`);
  const workerScript = path.resolve(__dirname, "verifier-worker.js");
  const circuit = JSON.parse(fs.readFileSync(CIRCUIT_PATH, "utf-8"));
  verifierPool = new VerifierPool(circuit.bytecode, workerScript, poolSize);
  await verifierPool.init();
  console.log(`Verifier pool ready (${poolSize} workers, WASM hot)`);

  // Record current block for incremental watching
  try {
    lastProcessedBlock = await publicClient.getBlockNumber();
  } catch {
    lastProcessedBlock = 0n;
  }

  // Migrate any existing file-based nullifiers to Redis (one-time, idempotent)
  await migrateNullifiersFromFile();

  // Start polling for new commitment events
  startEventWatcher();

  const nullifierCount = await getNullifierCount();

  app.listen(PORT, () => {
    console.log(`\n🔐 ZK API Credits Server`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   Venice: ${VENICE_BASE_URL}`);
    console.log(`   Circuit: ${CIRCUIT_PATH}`);
    console.log(`   Contract: ${CONTRACT_ADDRESS}`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   WS:  ${WS_URL || "(not set — WebSocket disabled, using 2s polling)"}`);
    console.log(`   Current root: ${currentRoot || "(no commitments yet)"}`);
    console.log(`   Valid roots: ${validRoots.size} (window: ${VALID_ROOT_WINDOW} blocks)`);
    console.log(`   Tree size: ${treeSize} commitments`);
    console.log(`   Spent nullifiers: ${nullifierCount} (Redis)`);
    console.log(`   Upstash: ${process.env.UPSTASH_REDIS_REST_URL}`);
    console.log(`   Hash function: bb.js Poseidon2 (Noir-compatible)`);
    console.log(`   Tree type: Standard binary with zero-padding (Semaphore-style)`);
    console.log(`   Verifier pool: ${verifierPool.size} workers (UltraHonkBackend pre-warmed)`);
    console.log(`\n   POST /v1/chat — Submit proof + get LLM response`);
    console.log(`   GET  /health  — Server health + valid roots count`);
    console.log(`   GET  /stats   — Server stats`);
    console.log(`\n   No wallet. No API key. No identity.\n`);
  });
}

start().catch(console.error);
