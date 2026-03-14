"use client";

import { useState } from "react";
import { useScaffoldWriteContract } from "~~/hooks/scaffold-eth";

interface CommitmentData {
  commitment: string;
  nullifier: string;
  secret: string;
  index?: number;
}

interface RegisterCreditsProps {
  leafEvents: any;
  stakedBalance: bigint | undefined;
  isConnected: boolean;
}

const STORAGE_KEY = "zk-api-credits";

function loadCredits(): CommitmentData[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCredit(data: CommitmentData) {
  const credits = loadCredits();
  credits.push(data);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credits));
}

/**
 * Generate random field elements and compute Poseidon2 commitment
 * Uses bb.js poseidon2Hash — the ONLY correct Poseidon2 implementation
 * that matches Noir's Poseidon2::hash and the on-chain LibPoseidon2.
 *
 * DO NOT use poseidon-lite — its "poseidon2" is original Poseidon with 2 inputs,
 * which is a completely different hash function.
 */
async function generateCommitmentData(): Promise<{
  commitment: bigint;
  nullifierHex: string;
  secretHex: string;
}> {
  const { Barretenberg, Fr } = await import(/* webpackIgnore: true */ "@aztec/bb.js");
  const bb = await Barretenberg.new({ threads: 1 });

  // Generate 32 random bytes for nullifier and secret
  const nullifierBytes = new Uint8Array(32);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(nullifierBytes);
  crypto.getRandomValues(secretBytes);

  const nullifierHex = "0x" + Array.from(nullifierBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const secretHex = "0x" + Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  // Reduce to field element range (BN254 field)
  const BN254_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
  const nullifierBigInt = BigInt(nullifierHex) % BN254_MODULUS;
  const secretBigInt = BigInt(secretHex) % BN254_MODULUS;

  // Use bb.js Poseidon2 — matches Noir Poseidon2::hash([nullifier, secret], 2)
  const commitmentFr = await bb.poseidon2Hash([new Fr(nullifierBigInt), new Fr(secretBigInt)]);
  const commitment = BigInt(commitmentFr.toString());

  await bb.destroy();

  return {
    commitment,
    nullifierHex: "0x" + nullifierBigInt.toString(16).padStart(64, "0"),
    secretHex: "0x" + secretBigInt.toString(16).padStart(64, "0"),
  };
}

export const RegisterCredits = ({ leafEvents, stakedBalance, isConnected }: RegisterCreditsProps) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [count, setCount] = useState(1);
  const [lastGenerated, setLastGenerated] = useState<CommitmentData | null>(null);

  const { writeContractAsync, isPending } = useScaffoldWriteContract({
    contractName: "APICredits",
  });

  const canRegister = isConnected && stakedBalance && stakedBalance >= BigInt(count) * BigInt(1e15);

  const handleRegister = async () => {
    if (!canRegister) return;
    setIsGenerating(true);

    try {
      const commitments: bigint[] = [];
      const creditsToSave: CommitmentData[] = [];

      for (let i = 0; i < count; i++) {
        const { commitment, nullifierHex, secretHex } = await generateCommitmentData();
        commitments.push(commitment);
        creditsToSave.push({
          commitment: "0x" + commitment.toString(16).padStart(64, "0"),
          nullifier: nullifierHex,
          secret: secretHex,
        });
      }

      if (count === 1) {
        await writeContractAsync(
          {
            functionName: "register",
            args: [commitments[0]],
          },
          {
            blockConfirmations: 1,
            onBlockConfirmation: () => {
              const idx = leafEvents?.length || 0;
              const data = { ...creditsToSave[0], index: idx };
              saveCredit(data);
              setLastGenerated(data);
            },
          },
        );
      } else {
        await writeContractAsync(
          {
            functionName: "registerBatch",
            args: [commitments],
          },
          {
            blockConfirmations: 1,
            onBlockConfirmation: () => {
              const startIdx = leafEvents?.length || 0;
              creditsToSave.forEach((c, i) => {
                const data = { ...c, index: startIdx + i };
                saveCredit(data);
                if (i === creditsToSave.length - 1) setLastGenerated(data);
              });
            },
          },
        );
      }
    } catch (error) {
      console.error("Error registering credits:", error);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="card bg-base-100 shadow-xl">
      <div className="card-body">
        <h2 className="card-title">🔐 Register API Credits</h2>
        <p className="text-sm opacity-70">
          Generate anonymous commitments and insert them into the Merkle tree.
          Each credit costs 0.001 ETH (moved to server pool — irreversible).
        </p>

        <div className="flex gap-2 items-end mt-4">
          <div className="form-control">
            <label className="label">
              <span className="label-text">Number of credits</span>
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
              className="input input-bordered w-32"
            />
          </div>
          <button
            className={`btn btn-primary ${isGenerating || isPending ? "loading" : ""}`}
            onClick={handleRegister}
            disabled={!canRegister || isGenerating || isPending}
          >
            {isGenerating
              ? "Generating..."
              : isPending
                ? "Confirming..."
                : !isConnected
                  ? "Connect Wallet"
                  : !canRegister
                    ? "Insufficient Balance"
                    : `Register ${count} Credit${count > 1 ? "s" : ""}`}
          </button>
        </div>

        <p className="text-xs opacity-50 mt-2">
          Cost: {(count * 0.001).toFixed(3)} ETH
        </p>

        {lastGenerated && (
          <div className="alert alert-success mt-4">
            <span>
              ✅ Credit registered! Your secrets are saved to localStorage.
              Go to the <a href="/chat" className="link font-bold">Chat page</a> to use them.
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
