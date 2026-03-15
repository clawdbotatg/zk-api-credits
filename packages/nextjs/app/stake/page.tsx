"use client";

import { useState } from "react";
import { parseEther, formatEther } from "viem";
import { useAccount } from "wagmi";
import {
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
} from "~~/hooks/scaffold-eth";
import { StakeInfo } from "./_components/StakeInfo";
import { RegisterCredits } from "./_components/RegisterCredits";
import { CreditsList } from "./_components/CreditsList";

export default function StakePage() {
  const { address: userAddress, isConnected } = useAccount();
  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");

  // Read staked balance from APICredits
  const { data: stakedBalance } = useScaffoldReadContract({
    contractName: "APICredits",
    functionName: "stakedBalance",
    args: [userAddress],
  });

  // Read tree data (might fail if tree is empty)
  const { data: treeData } = useScaffoldReadContract({
    contractName: "APICredits",
    functionName: "getTreeData",
  });

  // Read static price from APICredits
  const { data: pricePerCredit } = useScaffoldReadContract({
    contractName: "APICredits",
    functionName: "pricePerCredit",
  });

  // Read oracle data from CLAWDPricing: [clawdPerEth, ethUsd, pricePerCreditCLAWD, usdPerCredit, clawdUsd]
  const { data: oracleData } = useScaffoldReadContract({
    contractName: "CLAWDPricing",
    functionName: "getOracleData",
  });

  // Read leaf events for tree reconstruction
  const { data: leafEvents } = useScaffoldEventHistory({
    contractName: "APICredits",
    eventName: "NewLeaf",
    fromBlock: 0n,
  });

  // Write functions for stake/unstake (direct to APICredits)
  const { writeContractAsync: stake, isPending: isStaking } =
    useScaffoldWriteContract({
      contractName: "APICredits",
    });

  const { writeContractAsync: unstake, isPending: isUnstaking } =
    useScaffoldWriteContract({
      contractName: "APICredits",
    });

  const handleStake = async () => {
    if (!stakeAmount) return;
    await stake({
      functionName: "stake",
      args: [parseEther(stakeAmount)],
    });
    setStakeAmount("");
  };

  const handleUnstake = async () => {
    if (!unstakeAmount) return;
    await unstake({
      functionName: "unstake",
      args: [parseEther(unstakeAmount)],
    });
    setUnstakeAmount("");
  };

  // USD per credit from oracle
  const usdPerCredit = oracleData ? Number(formatEther(oracleData[3])) : 0;

  return (
    <div className="flex flex-col items-center pt-10 px-4">
      <h1 className="text-3xl font-bold mb-8">
        💰 Stake &amp; Register Credits
      </h1>

      <div className="w-full max-w-2xl space-y-6">
        {/* Staking Info with Oracle Data */}
        <StakeInfo
          stakedBalance={stakedBalance}
          treeData={treeData}
          oracleData={oracleData}
          pricePerCredit={pricePerCredit}
          isConnected={isConnected}
        />

        {/* Stake CLAWD */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">Stake CLAWD</h2>
            <p className="text-sm opacity-70">
              Deposit CLAWD tokens into the APICredits contract. Withdrawable until you register credits.
            </p>
            <div className="flex gap-2 items-end mt-2">
              <div className="flex-grow">
                <input
                  type="number"
                  step="1000"
                  min="0"
                  value={stakeAmount}
                  onChange={(e) => setStakeAmount(e.target.value)}
                  placeholder="100000"
                  className="input input-bordered w-full"
                />
              </div>
              <button
                className={`btn btn-primary ${isStaking ? "loading" : ""}`}
                onClick={handleStake}
                disabled={!isConnected || !stakeAmount || isStaking}
              >
                {isStaking ? "Staking..." : "Stake"}
              </button>
            </div>
          </div>
        </div>

        {/* Unstake CLAWD */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">Unstake CLAWD</h2>
            <p className="text-sm opacity-70">
              Withdraw unregistered CLAWD from your staked balance.
            </p>
            <div className="flex gap-2 items-end mt-2">
              <div className="flex-grow">
                <input
                  type="number"
                  step="1000"
                  min="0"
                  value={unstakeAmount}
                  onChange={(e) => setUnstakeAmount(e.target.value)}
                  placeholder="50000"
                  className="input input-bordered w-full"
                />
              </div>
              <button
                className={`btn btn-warning ${isUnstaking ? "loading" : ""}`}
                onClick={handleUnstake}
                disabled={!isConnected || !unstakeAmount || isUnstaking}
              >
                {isUnstaking ? "Unstaking..." : "Unstake"}
              </button>
            </div>
          </div>
        </div>

        {/* Register Credits */}
        <RegisterCredits
          leafEvents={leafEvents}
          stakedBalance={stakedBalance}
          isConnected={isConnected}
          pricePerCredit={pricePerCredit}
          usdPerCredit={usdPerCredit}
        />

        {/* Credits List */}
        <CreditsList />
      </div>
    </div>
  );
}
