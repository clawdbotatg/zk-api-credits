"use client";

import { useState, useEffect } from "react";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

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

  const { data: treeData } = useScaffoldReadContract({
    contractName: "APICredits",
    functionName: "getTreeData",
  });

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
      const [{ UltraHonkBackend }, noirModule, { LeanIMT }, { poseidon2 }] = await Promise.all([
        import(/* webpackIgnore: true */ "@aztec/bb.js"),
        import(/* webpackIgnore: true */ "@noir-lang/noir_js"),
        import("@zk-kit/lean-imt"),
        import("poseidon-lite"),
      ]);
      const Noir = (noirModule as any).Noir;

      const creditIdx = credits.findIndex((_, i) => !usedIndices.has(i));
      const credit = credits[creditIdx];

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

      setStatus("Rebuilding Merkle tree...");

      const hash = (a: bigint, b: bigint): bigint => poseidon2([a, b]);
      const tree = new LeanIMT(hash);

      if (leafEvents) {
        for (const event of leafEvents) {
          tree.insert(BigInt(event.args.value?.toString() || "0"));
        }
      }

      const root = tree.root;
      const depth = tree.depth;
      const leafIndex = credit.index ?? 0;

      const merkleProof = tree.generateProof(leafIndex);
      const siblings = merkleProof.siblings.map((s: any) =>
        Array.isArray(s) ? s[0] : s
      );

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

      const nullifierBigInt = BigInt(credit.nullifier);
      const nullifierHash = poseidon2([nullifierBigInt]);

      setStatus("Generating ZK proof (30-60s)...");

      const noir = new Noir(circuitData);
      const backend = new UltraHonkBackend(circuitData.bytecode);

      const inputs = {
        nullifier_hash: "0x" + BigInt(nullifierHash).toString(16).padStart(64, "0"),
        root: "0x" + BigInt(root).toString(16).padStart(64, "0"),
        depth: depth,
        nullifier: credit.nullifier,
        secret: credit.secret,
        indices: indices,
        siblings: siblings.map((s: bigint) => "0x" + s.toString(16).padStart(64, "0")),
      };

      const { witness } = await noir.execute(inputs);
      const proof = await backend.generateProof(witness);

      const newUsed = new Set(usedIndices);
      newUsed.add(creditIdx);
      setUsedIndices(newUsed);
      localStorage.setItem(STORAGE_KEY + "-used", JSON.stringify([...newUsed]));

      const proofHex = "0x" + Array.from(proof.proof as Uint8Array)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");

      onProofGenerated({
        proof: proofHex,
        nullifier_hash: "0x" + BigInt(nullifierHash).toString(16).padStart(64, "0"),
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
