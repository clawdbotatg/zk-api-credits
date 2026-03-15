import { ethers } from "hardhat";
import { formatEther } from "viem";

const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const WETH = "0x4200000000000000000000000000000000000006";
const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const wethAbi = ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"];
  const swapAbi = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns(uint256)"];
  
  const weth = await ethers.getContractAt(wethAbi, WETH);
  const swap = await ethers.getContractAt(swapAbi, SWAP_ROUTER);
  
  // We already have WETH from previous test — check balance
  const wethBal = await weth.balanceOf(deployer.address);
  console.log("WETH balance:", formatEther(wethBal));
  
  // Try with zero minOut to see how much CLAWD we actually get
  try {
    const out = await swap.exactInputSingle.staticCall(
      [WETH, CLAWD, 10000, deployer.address, wethBal, 0n, 0n],
    );
    console.log("Actual CLAWD out with 0 minOut:", formatEther(out), "CLAWD");
    console.log("Price: 1 WETH =", Number(out) / Number(wethBal) * 1e18 / 1e18, "... wait");
    const ethToClawdRatio = Number(out) / (Number(wethBal) / 1e18);
    console.log("Effective rate:", ethToClawdRatio.toFixed(0), "CLAWD per ETH");
    console.log("For 2000 CLAWD need:", (2000 / ethToClawdRatio).toFixed(8), "ETH");
  } catch(e: any) {
    console.log("Failed even with 0 minOut:", e.reason || e.message?.slice(0,200));
  }
}
main().catch(console.error);
