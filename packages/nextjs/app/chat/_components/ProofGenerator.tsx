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
const MAX_DEPTH = 16;

/**
 * Standard binary Merkle tree with zero-padding (Semaphore-style).
 * Matches the on-chain APICredits contract and Noir binary_merkle_root exactly.
 *
 * Empty positions use precomputed zero hashes:
 *   zeros[0] = 0
 *   zeros[i+1] = poseidon2(zeros[i], zeros[i])
 *
 * Every level always hashes two children — NO promotion of odd nodes.
 */
class BinaryMerkleTree {
  private hashFn: (a: bigint, b: bigint) => Promise<bigint>;
  private leaves: bigint[] = [];
  private zeros: bigint[] = [];
  public depth = 0;

  constructor(hashFn: (a: bigint, b: bigint) => Promise<bigint>) {
    this.hashFn = hashFn;
  }

  async precomputeZeros() {
    this.zeros = new Array(MAX_DEPTH);
    this.zeros[0] = 0n;
    for (let i = 0; i < MAX_DEPTH - 1; i++) {
      this.zeros[i + 1] = await this.hashFn(this.zeros[i], this.zeros[i]);
    }
  }

  addLeaf(leaf: bigint) {
    this.leaves.push(leaf);
    // Update depth
    const n = this.leaves.length;
    let needed = 1;
    let tmp = n;
    while (tmp > 1) {
      needed++;
      tmp = (tmp + 1) >> 1;
    }
    if (needed > this.depth) this.depth = needed;
  }

  get size() {
    return this.leaves.length;
  }

  /**
   * Build the full tree and return levels array.
   * levels[0] = leaves padded to 2^depth with zeros[0] = 0
   * levels[i+1][j] = hash(levels[i][2j], levels[i][2j+1])
   */
  async buildLevels(): Promise<bigint[][]> {
    const d = this.depth;
    const paddedSize = 1 << d;
    const levels: bigint[][] = [];

    // Level 0: leaves + zero padding
    levels[0] = new Array(paddedSize);
    for (let i = 0; i < paddedSize; i++) {
      levels[0][i] = i < this.leaves.length ? this.leaves[i] : 0n;
    }

    // Upper levels
    for (let lvl = 0; lvl < d; lvl++) {
      const parentSize = levels[lvl].length >> 1;
      levels[lvl + 1] = new Array(parentSize);
      for (let j = 0; j < parentSize; j++) {
        levels[lvl + 1][j] = await this.hashFn(
          levels[lvl][j * 2],
          levels[lvl][j * 2 + 1],
        );
      }
    }

    return levels;
  }

  async getRoot(): Promise<bigint> {
    const levels = await this.buildLevels();
    return levels[this.depth][0];
  }

  async generateProof(leafIndex: number): Promise<{
    siblings: bigint[];
    indices: number[];
    root: bigint;
    depth: number;
  }> {
    const levels = await this.buildLevels();
    const root = levels[this.depth][0];

    const siblings: bigint[] = [];
    const indices: number[] = [];
    let idx = leafIndex;

    for (let i = 0; i < MAX_DEPTH; i++) {
      if (i < this.depth) {
        const sibIdx = idx ^ 1;
        siblings.push(levels[i][sibIdx]);
      } else {
        siblings.push(this.zeros[i]);
      }
      indices.push((leafIndex >> i) & 1);
      idx >>= 1;
    }

    return { siblings, indices, root, depth: this.depth };
  }
}

export const ProofGenerator = ({
  onProofGenerated,
  hasProof,
}: ProofGeneratorProps) => {
  const [credits, setCredits] = useState<CommitmentData[]>([]);
  const [usedIndices, setUsedIndices] = useState<Set<number>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    try {
      const stored: CommitmentData[] = JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "[]",
      );
      setCredits(stored);
      const used: number[] = JSON.parse(
        localStorage.getItem(STORAGE_KEY + "-used") || "[]",
      );
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
      // Dynamic imports — heavy WASM packages, only loaded when user clicks
      const [{ UltraHonkBackend, Barretenberg, Fr }, noirModule] =
        await Promise.all([
          import(/* webpackIgnore: true */ "@aztec/bb.js"),
          import(/* webpackIgnore: true */ "@noir-lang/noir_js"),
        ]);
      const Noir = (noirModule as any).Noir;

      const creditIdx = credits.findIndex((_, i) => !usedIndices.has(i));
      const credit = credits[creditIdx];

      setStatus("Initializing Poseidon2 (WASM)...");

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
      } catch {
        /* fallback */
      }
      if (!circuitData) {
        const res2 = await fetch("/circuits.json");
        circuitData = await res2.json();
      }

      setStatus("Rebuilding Merkle tree with Poseidon2...");

      // Build standard binary tree (matches on-chain + Noir circuit exactly)
      const tree = new BinaryMerkleTree(poseidon2Hash);
      await tree.precomputeZeros();

      if (leafEvents) {
        for (const event of leafEvents) {
          tree.addLeaf(BigInt(event.args.value?.toString() || "0"));
        }
      }

      const leafIndex = credit.index ?? 0;
      const { siblings, indices, root, depth } =
        await tree.generateProof(leafIndex);

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
        siblings: siblings.map(
          (s: bigint) => "0x" + s.toString(16).padStart(64, "0"),
        ),
      };

      const { witness } = await noir.execute(inputs);
      const proof = await backend.generateProof(witness);

      await bb.destroy();

      const newUsed = new Set(usedIndices);
      newUsed.add(creditIdx);
      setUsedIndices(newUsed);
      localStorage.setItem(STORAGE_KEY + "-used", JSON.stringify([...newUsed]));

      const proofHex =
        "0x" +
        Array.from(proof.proof as Uint8Array)
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
    <div
      className={`card shadow-xl ${hasProof ? "bg-success/10" : "bg-base-100"}`}
    >
      <div className="card-body py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold">
              {hasProof ? "✅ Proof Ready" : "🔐 Generate Proof"}
            </h3>
            <p className="text-xs opacity-70">
              {availableCredits.length} unused credit
              {availableCredits.length !== 1 ? "s" : ""} available
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
