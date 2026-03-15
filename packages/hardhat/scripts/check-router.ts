import { ethers } from "hardhat";
import { formatEther } from "viem";

const CLAWD_ROUTER = "0xA646A5843a3af5966206035917228bE6754Ae2e0";

async function main() {
  const router = await ethers.getContractAt("CLAWDRouter", CLAWD_ROUTER);
  
  // Check all immutables
  console.log("weth:", await router.weth());
  console.log("clawdToken:", await router.clawdToken());
  console.log("apiCredits:", await router.apiCredits());
  console.log("swapRouter:", await router.swapRouter());
  console.log("usdc:", await router.usdc());
  console.log("owner:", await router.owner());
}
main().catch(console.error);
