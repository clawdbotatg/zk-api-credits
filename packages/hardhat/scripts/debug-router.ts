import { ethers } from "hardhat";
import { formatEther } from "viem";

const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
const WETH = "0x4200000000000000000000000000000000000006";
const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  // SwapRouter02 interface (no deadline)
  const swapAbi02 = [
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256 amountOut)"
  ];
  // SwapRouter01 interface (with deadline)
  const swapAbi01 = [
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256 amountOut)"
  ];
  
  const ethAmount = ethers.parseEther("0.00005");
  const minClawd = ethers.parseEther("1800"); // loose for testing
  const deadline = BigInt(Math.floor(Date.now()/1000) + 300);

  // Try SwapRouter02 (no deadline)
  try {
    const router02 = await ethers.getContractAt(swapAbi02, SWAP_ROUTER);
    const out = await router02.exactInputSingle.staticCall(
      [WETH, CLAWD, 10000, deployer.address, ethAmount, minClawd, 0n],
      { value: ethAmount }
    );
    console.log("✅ SwapRouter02 (no deadline) works! Would get:", formatEther(out), "CLAWD");
  } catch(e: any) {
    console.log("❌ SwapRouter02:", e.reason || e.message?.slice(0,100));
  }

  // Try SwapRouter01 (with deadline)  
  try {
    const router01 = await ethers.getContractAt(swapAbi01, SWAP_ROUTER);
    const out = await router01.exactInputSingle.staticCall(
      [WETH, CLAWD, 10000, deployer.address, deadline, ethAmount, minClawd, 0n],
      { value: ethAmount }
    );
    console.log("✅ SwapRouter01 (with deadline) works! Would get:", formatEther(out), "CLAWD");
  } catch(e: any) {
    console.log("❌ SwapRouter01:", e.reason || e.message?.slice(0,100));
  }
}
main().catch(console.error);
