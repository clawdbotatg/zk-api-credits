import { ethers } from "hardhat";

const WETH_CLAWD_POOL = "0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3";
const CLAWD_ROUTER = "0xedeCFFec6E166f88a39DF452f9251f505a19Ef62";
const WETH = "0x4200000000000000000000000000000000000006";
const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";

async function main() {
  const poolAbi = [
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function liquidity() view returns (uint128)",
    "function fee() view returns (uint24)",
  ];
  const routerAbi = [
    "function weth() view returns (address)",
    "function clawdToken() view returns (address)",
    "function apiCredits() view returns (address)",
    "function swapRouter() view returns (address)",
  ];
  const pool = await ethers.getContractAt(poolAbi, WETH_CLAWD_POOL);
  const router = await ethers.getContractAt(routerAbi, CLAWD_ROUTER);

  console.log("Pool token0:", await pool.token0());
  console.log("Pool token1:", await pool.token1());
  console.log("Pool fee:", (await pool.fee()).toString());
  console.log("Pool liquidity:", (await pool.liquidity()).toString());
  console.log("---");
  console.log("Router.weth:", await router.weth());
  console.log("Router.clawdToken:", await router.clawdToken());
  console.log("Router.apiCredits:", await router.apiCredits());
  console.log("Router.swapRouter:", await router.swapRouter());

  // Check if CLAWDRouter is approved to call stakeAndRegister on APICredits
  const creditsAbi = ["function owner() view returns (address)"];
  const credits = await ethers.getContractAt(creditsAbi, await router.apiCredits());
  console.log("APICredits owner:", await credits.owner());
}
main().catch(console.error);
