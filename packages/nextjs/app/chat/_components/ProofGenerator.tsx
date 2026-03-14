"use client";

import { useState, useEffect } from "react";
import { useScaffoldEventHistory } from "~~/hooks/scaffold-eth";

interface CommitmentData {
  commitment: string;
  nullifier: string;
  secret: string;
  index?: number;
}

interface ProofGeneratorProps {
  onProofGenerated: (data: {
    proof: string;
    nullifier_hash: string;
    root: string;
    depth: number;
  }) => void;
  hasProof: boolean;
}

const STORAGE_KEY = "zk-api-credits";

/**
 * Async LeanIMT implementation using bb.js Poseidon2.
 *
 * @zk-kit/lean-imt requires a synchronous hash function, but bb.js poseidon2Hash
 * is async (WASM-backed). So we build the tree manually.
 *
 * DO NOT use poseidon-lite — its "poseidon2" is original Poseidon with 2 inputs,
 * which is a completely different hash function from Noir's Poseidon2.
 */
class AsyncLeanIMT {
  private sideNodes: Record<number, bigint> = {};
  public depth = 0;
  public size = 0;
  private hashFn: (a: bigint, b: bigint) => Promise<bigint>;

  // Store all leaves for sibling extraction
  private allLeaves: bigint[] = [];

  constructor(hashFn: (a: bigint, b: bigint) => Promise<bigint>) {
    this.hashFn = hashFn;
  }

  async insert(leaf: bigint) {
    const index = this.size;
    if (2 ** this.depth < index + 1) {
      this.depth++;
    }

    this.allLeaves.push(leaf);
    let node = leaf;

    for (let level = 0; level < this.depth; level++) {
      if ((index >> level) & 1) {
        node = await this.hashFn(this.sideNodes[level], node);
      } else {
        this.sideNodes[level] = node;
      }
    }

    this.size = index + 1;
    this.sideNodes[this.depth] = node;
  }

  get root(): bigint {
    return this.sideNodes[this.depth];
  }

  /**
   * Generate a Merkle proof for the leaf at `leafIndex`.
   * We rebuild the full tree level by level to get all intermediate nodes.
   */
  async generateProof(leafIndex: number): Promise<{ siblings: bigint[] }> {
    // Build full tree level by level
    const levels: Record<number, Record<number, bigint>> = { 0: {} };
    for (let i = 0; i < this.allLeaves.length; i++) {
      levels[0][i] = this.allLeaves[i];
    }

    for (let level = 0; level < this.depth; level++) {
      const currentLevel = levels[level];
      levels[level + 1] = {};
      const numNodes = Math.ceil(this.size / (2 ** (level + 1)));
      for (let i = 0; i < numNodes; i++) {
        const left = currentLevel[i * 2];
        const right = currentLevel[i * 2 + 1];
        if (left !== undefined && right !== undefined) {
          levels[level + 1][i] = await this.hashFn(left, right);
        } else if (left !== undefined) {
          levels[level + 1][i] = left;
        }
      }
    }

    // Extract sibling path
    const siblings: bigint[] = [];
    let idx = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const sibIdx = idx ^ 1;
      const sibling = levels[level]?.[sibIdx];
      siblings.push(sibling !== undefined ? sibling : 0n);
      idx >>= 1;
    }

    return { siblings };
  }
}

export const ProofGenerator = ({ onProofGenerated, hasProof }: ProofGeneratorProps) => {
  const [credits, setCredits] = useState<CommitmentData[]>([]);
  const [usedIndices, setUsedIndices] = useState<Set<number>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    try {
      const stored: CommitmentData[] = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      setCredits(stored);
      const used: number[] = JSON.parse(localStorage.getItem(STORAGE_KEY + "-used") || "[]");
      setUsedIndices(new Set(used));
    } catch {
      setCredits([]);
    }
  }, []);

  const { data: leafEvents } = useScaffoldEventHistory({
    contractName: "APICredits",
    eventName: "NewLeaf",
    fromBlock: 0n,
  });

  const availableCredits = credits.filter((_, i) => !usedIndices.has(i));

  const handleGenerateProof = async () => {
    if (availableCredits.length === 0) return;

    setIsGenerating(true);
    setStatus("Loading ZK libraries (this may take a moment)...");

    try {
      // Dynamic imports — these are heavy WASM packages, only loaded when user clicks
      const [{ UltraHonkBackend, Barretenberg, Fr }, noirModule] = await Promise.all([
        import(/* webpackIgnore: true */ "@aztec/bb.js"),
        import(/* webpackIgnore: true */ "@noir-lang/noir_js"),
      ]);
      const Noir = (noirModule as any).Noir;

      const creditIdx = credits.findIndex((_, i) => !usedIndices.has(i));
      const credit = credits[creditIdx];

      setStatus("Initializing Poseidon2 (WASM)...");

      // Initialize Barretenberg for Poseidon2 hashing
      const bb = await Barretenberg.new({ threads: 1 });
      const poseidon2Hash = async (a: bigint, b: bigint): Promise<bigint> => {
        const result = await bb.poseidon2Hash([new Fr(a), new Fr(b)]);
        return BigInt(result.toString());
      };

      setStatus("Loading circuit...");

      let circuitData: any;
      try {
        const res = await fetch("/api/circuit");
        if (res.ok) circuitData = await res.json();
      } catch { /* fallback */ }
      if (!circuitData) {
        const res2 = await fetch("/circuits.json");
        circuitData = await res2.json();
      }

      setStatus("Rebuilding Merkle tree with Poseidon2...");

      // Build tree with bb.js Poseidon2 (matches Noir + on-chain LibPoseidon2)
      const tree = new AsyncLeanIMT(poseidon2Hash);

      if (leafEvents) {
        for (const event of leafEvents) {
          await tree.insert(BigInt(event.args.value?.toString() || "0"));
        }
      }

      const root = tree.root;
      const depth = tree.depth;
      const leafIndex = credit.index ?? 0;

      const merkleProof = await tree.generateProof(leafIndex);
      const siblings = [...merkleProof.siblings];

      while (siblings.length < 16) {
        siblings.push(0n);
      }

      const indices: number[] = [];
      let idx = leafIndex;
      for (let i = 0; i < 16; i++) {
        if (i < depth) {
          indices.push(idx & 1);
          idx >>= 1;
        } else {
          indices.push(0);
        }
      }

      // Compute nullifier hash using bb.js Poseidon2
      const nullifierBigInt = BigInt(credit.nullifier);
      const nullifierHashFr = await bb.poseidon2Hash([new Fr(nullifierBigInt)]);
      const nullifierHash = BigInt(nullifierHashFr.toString());

      setStatus("Generating ZK proof (30-60s)...");

      const noir = new Noir(circuitData);
      const backend = new UltraHonkBackend(circuitData.bytecode);

      const inputs = {
        nullifier_hash: "0x" + nullifierHash.toString(16).padStart(64, "0"),
        root: "0x" + BigInt(root).toString(16).padStart(64, "0"),
        depth: depth,
        nullifier: credit.nullifier,
        secret: credit.secret,
        indices: indices,
        siblings: siblings.map((s: bigint) => "0x" + s.toString(16).padStart(64, "0")),
      };

      const { witness } = await noir.execute(inputs);
      const proof = await backend.generateProof(witness);

      // Clean up bb instance
      await bb.destroy();

      const newUsed = new Set(usedIndices);
      newUsed.add(creditIdx);
      setUsedIndices(newUsed);
      localStorage.setItem(STORAGE_KEY + "-used", JSON.stringify([...newUsed]));

      const proofHex = "0x" + Array.from(proof.proof as Uint8Array)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");

      onProofGenerated({
        proof: proofHex,
        nullifier_hash: "0x" + nullifierHash.toString(16).padStart(64, "0"),
        root: "0x" + BigInt(root).toString(16).padStart(64, "0"),
        depth: depth,
      });

      setStatus("✅ Proof generated!");
    } catch (error: any) {
      console.error("Proof generation error:", error);
      setStatus(`❌ Error: ${error.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className={`card shadow-xl ${hasProof ? "bg-success/10" : "bg-base-100"}`}>
      <div className="card-body py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold">
              {hasProof ? "✅ Proof Ready" : "🔐 Generate Proof"}
            </h3>
            <p className="text-xs opacity-70">
              {availableCredits.length} unused credit{availableCredits.length !== 1 ? "s" : ""} available
            </p>
          </div>
          <button
            className={`btn btn-sm ${hasProof ? "btn-success" : "btn-primary"} ${isGenerating ? "loading" : ""}`}
            onClick={handleGenerateProof}
            disabled={availableCredits.length === 0 || isGenerating || hasProof}
          >
            {isGenerating
              ? "Generating..."
              : hasProof
                ? "Proof Active"
                : availableCredits.length === 0
                  ? "No Credits"
                  : "Generate Proof"}
          </button>
        </div>
        {status && <p className="text-xs mt-1">{status}</p>}
      </div>
    </div>
  );
};
