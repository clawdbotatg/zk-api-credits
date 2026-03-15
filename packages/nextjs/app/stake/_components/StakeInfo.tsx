"use client";

import { formatEther } from "viem";

interface StakeInfoProps {
  stakedBalance: bigint | undefined;
  treeData: readonly [bigint, bigint, bigint] | undefined;
  oracleData: readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
  pricePerCredit: bigint | undefined;
  isConnected: boolean;
}

export const StakeInfo = ({ stakedBalance, treeData, oracleData, pricePerCredit, isConnected }: StakeInfoProps) => {
  const balance = stakedBalance ? Number(formatEther(stakedBalance)) : 0;
  const price = pricePerCredit ? Number(formatEther(pricePerCredit)) : 0;

  // Oracle data: [clawdPerEth, ethUsd, pricePerCreditCLAWD, usdPerCredit, clawdUsd]
  const usdPerCredit = oracleData ? Number(formatEther(oracleData[3])) : 0;
  const clawdPerEth = oracleData ? Number(formatEther(oracleData[0])) : 0;
  const ethUsd = oracleData ? Number(formatEther(oracleData[1])) : 0;
  const clawdUsd = oracleData ? Number(formatEther(oracleData[4])) : 0;

  const availableCredits = price > 0 ? Math.floor(balance / price) : 0;

  return (
    <div className="space-y-4">
      {/* Main stats */}
      <div className="stats stats-vertical lg:stats-horizontal shadow w-full bg-base-100">
        <div className="stat">
          <div className="stat-title">Staked Balance</div>
          <div className="stat-value text-primary text-lg">
            {isConnected ? `${balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} CLAWD` : "—"}
          </div>
          <div className="stat-desc">
            {isConnected && clawdUsd > 0
              ? `~$${(balance * clawdUsd).toFixed(2)}`
              : "Withdrawable"}
          </div>
        </div>

        <div className="stat">
          <div className="stat-title">Available Credits</div>
          <div className="stat-value text-secondary">{isConnected ? availableCredits : "—"}</div>
          <div className="stat-desc">
            {price > 0
              ? `@ ${price.toLocaleString(undefined, { maximumFractionDigits: 0 })} CLAWD (~$${usdPerCredit.toFixed(2)})`
              : "Loading price..."}
          </div>
        </div>

        <div className="stat">
          <div className="stat-title">Merkle Tree</div>
          <div className="stat-value text-sm">
            {treeData ? `${treeData[0].toString()} leaves` : "Empty"}
          </div>
          <div className="stat-desc">{treeData ? `Depth: ${treeData[1].toString()}` : "No commitments yet"}</div>
        </div>
      </div>

      {/* Oracle info */}
      {oracleData && (
        <div className="bg-base-200 rounded-lg p-3 text-xs opacity-80">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>📊 CLAWD/ETH: {clawdPerEth.toLocaleString(undefined, { maximumFractionDigits: 0 })} (30min TWAP)</span>
            <span>💵 ETH/USD: ${ethUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span>🪙 CLAWD: ${clawdUsd.toFixed(6)}</span>
          </div>
        </div>
      )}
    </div>
  );
};
