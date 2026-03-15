import { ethers } from "hardhat";
import { formatEther } from "viem";

const CLAWD_ROUTER = "0xA646A5843a3af5966206035917228bE6754Ae2e0";
const CLAWD_PRICING = "0xaca9733Cc19aD837899dc7D1170aF1d5367C332E";
const API_CREDITS = "0xc18fad39f72eBe5E54718D904C5012Da74594674";
const WETH = "0x4200000000000000000000000000000000000006";
const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const wethAbi = [
    "function deposit() payable",
    "function approve(address,uint256) returns(bool)",
    "function balanceOf(address) view returns(uint256)",
  ];
  const swapAbi = [
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)",
  ];
  const creditsAbi = [
    "function pricePerCredit() view returns(uint256)",
    "function stakeAndRegister(uint256,uint256[]) external",
  ];
  const clawdAbi = [
    "function approve(address,uint256) returns(bool)",
    "function balanceOf(address) view returns(uint256)",
  ];

  const weth = await ethers.getContractAt(wethAbi, WETH);
  const swapRouter = await ethers.getContractAt(swapAbi, SWAP_ROUTER);
  const credits = await ethers.getContractAt(creditsAbi, API_CREDITS);
  const clawd = await ethers.getContractAt(clawdAbi, CLAWD);
  const pricing = await ethers.getContractAt([
    "function creditPriceUSD() view returns(uint256)",
    "function getEthUsdPrice() view returns(uint256)",
  ], CLAWD_PRICING);

  const creditPriceUSD = await pricing.creditPriceUSD();
  const ethUsdPrice = await pricing.getEthUsdPrice();
  const pricePerCredit = await credits.pricePerCredit();

  const ethCostExact = (creditPriceUSD * 10n**18n) / ethUsdPrice;
  const ethCostWithSlippage = ethCostExact * 102n / 100n;
  const minCLAWDOut = pricePerCredit * 98n / 100n;
  
  const commitment = 36898049252859945812n;

  console.log("Step 1: Wrap ETH to WETH...");
  try {
    await weth.deposit.staticCall({ value: ethCostWithSlippage });
    console.log("✅ deposit would work");
  } catch(e: any) { console.log("❌ deposit:", e.reason || e.message?.slice(0,100)); }

  console.log("\nStep 2: Approve WETH to SwapRouter...");
  // This is non-view but won't revert

  console.log("\nStep 3: WETH→CLAWD swap simulation...");
  try {
    const out = await swapRouter.exactInputSingle.staticCall(
      [WETH, CLAWD, 10000, deployer.address, ethCostWithSlippage, minCLAWDOut, 0n],
      { from: deployer.address } // no ETH value — WETH already approved
    );
    console.log("✅ Swap would get:", formatEther(out), "CLAWD");
  } catch(e: any) { console.log("❌ swap:", e.reason || e.message?.slice(0,200)); }

  // Now try doing all steps manually for real to debug
  console.log("\n--- REAL TX STEPS ---");
  
  console.log("Wrapping ETH...");
  const wrapTx = await weth.deposit({ value: ethCostWithSlippage });
  await wrapTx.wait();
  const wethBal = await weth.balanceOf(deployer.address);
  console.log("✅ WETH balance:", formatEther(wethBal));
  
  console.log("Approving WETH to swap router...");
  const approveTx = await weth.approve(SWAP_ROUTER, ethCostWithSlippage);
  await approveTx.wait();
  
  console.log("Swapping WETH→CLAWD...");
  try {
    const swapTx = await swapRouter.exactInputSingle(
      [WETH, CLAWD, 10000, deployer.address, ethCostWithSlippage, minCLAWDOut, 0n],
    );
    const receipt = await swapTx.wait();
    const clawdBal = await clawd.balanceOf(deployer.address);
    console.log("✅ Swap done! CLAWD balance:", formatEther(clawdBal));
    
    console.log("\nApproving CLAWD to APICredits...");
    const approveClawdTx = await clawd.approve(API_CREDITS, pricePerCredit);
    await approveClawdTx.wait();
    
    console.log("Calling stakeAndRegister...");
    try {
      const stakeTx = await credits.stakeAndRegister(pricePerCredit, [commitment]);
      await stakeTx.wait();
      console.log("✅ stakeAndRegister succeeded!");
    } catch(e: any) { console.log("❌ stakeAndRegister:", e.reason || e.message?.slice(0,200)); }
    
  } catch(e: any) { console.log("❌ swap tx:", e.reason || e.message?.slice(0,200)); }
}
main().catch(console.error);
