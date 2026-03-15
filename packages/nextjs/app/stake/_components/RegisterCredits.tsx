"use client";

import { useState } from "react";
import { formatEther } from "viem";
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
  pricePerCredit: bigint | undefined;
  usdPerCredit: number;
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
 */
async function generateCommitmentData(): Promise<{
  commitment: bigint;
  nullifierHex: string;
  secretHex: string;
}> {
  const { Barretenberg, Fr } = await import(/* webpackIgnore: true */ "@aztec/bb.js");
  const bb = await Barretenberg.new({ threads: 1 });

  const nullifierBytes = new Uint8Array(32);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(nullifierBytes);
  crypto.getRandomValues(secretBytes);

  const nullifierHex = "0x" + Array.from(nullifierBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const secretHex = "0x" + Array.from(secretBytes).map(b => b.toString(16).padStart(2, "0")).join("");

  const BN254_MODULUS = BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617");
  const nullifierBigInt = BigInt(nullifierHex) % BN254_MODULUS;
  const secretBigInt = BigInt(secretHex) % BN254_MODULUS;

  const commitmentFr = await bb.poseidon2Hash([new Fr(nullifierBigInt), new Fr(secretBigInt)]);
  const commitment = BigInt(commitmentFr.toString());

  await bb.destroy();

  return {
    commitment,
    nullifierHex: "0x" + nullifierBigInt.toString(16).padStart(64, "0"),
    secretHex: "0x" + secretBigInt.toString(16).padStart(64, "0"),
  };
}

export const RegisterCredits = ({
  leafEvents,
  stakedBalance,
  isConnected,
  pricePerCredit,
  usdPerCredit,
}: RegisterCreditsProps) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [count, setCount] = useState(1);
  const [lastGenerated, setLastGenerated] = useState<CommitmentData | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"clawd" | "stake">("clawd");

  // Write to CLAWDRouter for direct buy
  const { writeContractAsync: routerWrite, isPending: isRouterPending } = useScaffoldWriteContract({
    contractName: "CLAWDRouter",
  });

  // Write to APICredits for stake-based register
  const { writeContractAsync: creditsWrite, isPending: isCreditsP } = useScaffoldWriteContract({
    contractName: "APICredits",
  });

  const isPending = isRouterPending || isCreditsP;

  const priceClawd = pricePerCredit ? Number(formatEther(pricePerCredit)) : 0;
  const totalClawd = priceClawd * count;
  const totalUsd = usdPerCredit * count;

  // For direct buy via router — need maxCLAWD
  const maxClawdBigInt = pricePerCredit
    ? pricePerCredit * BigInt(count)
    : BigInt(0);

  const hasEnoughStake = stakedBalance && pricePerCredit
    ? stakedBalance >= pricePerCredit * BigInt(count)
    : false;

  const canRegister = isConnected && pricePerCredit && pricePerCredit > 0n;

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

      if (paymentMethod === "clawd") {
        // Buy via CLAWDRouter — user approves CLAWD to router, router handles the rest
        await routerWrite(
          {
            functionName: "buyWithCLAWD",
            args: [commitments, maxClawdBigInt],
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
      } else {
        // Register from existing stake on APICredits
        if (count === 1) {
          await creditsWrite(
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
          for (let i = 0; i < commitments.length; i++) {
            await creditsWrite(
              {
                functionName: "register",
                args: [commitments[i]],
              },
              {
                blockConfirmations: 1,
                onBlockConfirmation: () => {
                  const idx = (leafEvents?.length || 0) + i;
                  const data = { ...creditsToSave[i], index: idx };
                  saveCredit(data);
                  if (i === creditsToSave.length - 1) setLastGenerated(data);
                },
              },
            );
          }
        }
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
        <h2 className="card-title">🔐 Buy API Credits</h2>
        <p className="text-sm opacity-70">
          Generate anonymous commitments and insert them into the Merkle tree.
          Price derived from Uniswap v3 TWAP oracle.
        </p>

        {/* Payment method toggle */}
        <div className="flex gap-2 mt-2">
          <button
            className={`btn btn-sm ${paymentMethod === "clawd" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setPaymentMethod("clawd")}
          >
            💰 Pay with CLAWD
          </button>
          <button
            className={`btn btn-sm ${paymentMethod === "stake" ? "btn-primary" : "btn-outline"}`}
            onClick={() => setPaymentMethod("stake")}
          >
            📥 Use Staked Balance
          </button>
        </div>

        <div className="flex gap-2 items-end mt-3">
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
            disabled={!canRegister || isGenerating || isPending || (paymentMethod === "stake" && !hasEnoughStake)}
          >
            {isGenerating
              ? "Generating..."
              : isPending
                ? "Confirming..."
                : !isConnected
                  ? "Connect Wallet"
                  : !canRegister
                    ? "Loading Price..."
                    : paymentMethod === "stake" && !hasEnoughStake
                      ? "Insufficient Stake"
                      : `Buy ${count} Credit${count > 1 ? "s" : ""}`}
          </button>
        </div>

        {/* Price info */}
        <div className="mt-3 space-y-1">
          <p className="text-sm">
            <span className="font-semibold">Price per credit:</span>{" "}
            {priceClawd > 0
              ? `${priceClawd.toLocaleString(undefined, { maximumFractionDigits: 0 })} CLAWD (~$${usdPerCredit.toFixed(2)})`
              : "Loading..."}
          </p>
          {count > 1 && priceClawd > 0 && (
            <p className="text-sm">
              <span className="font-semibold">Total:</span>{" "}
              {totalClawd.toLocaleString(undefined, { maximumFractionDigits: 0 })} CLAWD (~${totalUsd.toFixed(2)})
            </p>
          )}
        </div>

        <div className="alert mt-3">
          <span className="text-xs">
            ⚠️ You must approve the {paymentMethod === "clawd" ? "CLAWDRouter" : "APICredits"} contract to spend your CLAWD first.
          </span>
        </div>

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
