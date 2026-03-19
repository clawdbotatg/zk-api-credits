import { ethers } from "hardhat";
import { parseEther } from "ethers";

/**
 * Deploy new APICredits + CLAWDRouter to Base mainnet.
 * CLAWDPricing stays at 0xaca9733Cc19aD837899dc7D1170aF1d5367C332E (no change).
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // ─── Addresses ──────────────────────────────────────────
  const CLAWD_TOKEN = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
  const CLAWD_PRICING = "0xaca9733Cc19aD837899dc7D1170aF1d5367C332E";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const WETH = "0x4200000000000000000000000000000000000006";
  const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";
  const OWNER = deployer.address;

  // Revenue recipient — CLAWD flows here automatically on every credit purchase
  const CLAIM_RECIPIENT = "0x90eF2A9211A3E7CE788561E5af54C76B0Fa3aEd0"; // safe.clawd.atg.eth

  // Initial price: 191 CLAWD per credit (matches oracle ~$0.01/credit)
  const PRICE_PER_CREDIT = parseEther("191");

  // ─── Step A: Deploy new APICredits ──────────────────────
  console.log("\n--- Deploying APICredits ---");
  const APICredits = await ethers.getContractFactory("APICredits");
  const apiCredits = await APICredits.deploy(CLAWD_TOKEN, PRICE_PER_CREDIT, OWNER, CLAIM_RECIPIENT);
  await apiCredits.waitForDeployment();
  const apiCreditsAddr = await apiCredits.getAddress();
  console.log("APICredits deployed to:", apiCreditsAddr);

  // Verify constructor values
  const price = await apiCredits.pricePerCredit();
  const recipient = await apiCredits.claimRecipient();
  console.log("pricePerCredit:", ethers.formatEther(price), "CLAWD");
  console.log("claimRecipient:", recipient, recipient === CLAIM_RECIPIENT ? "✅" : "❌ MISMATCH");

  // ─── Step B: Deploy new CLAWDRouter ─────────────────────
  console.log("\n--- Deploying CLAWDRouter ---");
  const CLAWDRouter = await ethers.getContractFactory("CLAWDRouter");
  const router = await CLAWDRouter.deploy(
    apiCreditsAddr,
    CLAWD_PRICING,
    CLAWD_TOKEN,
    USDC,
    WETH,
    SWAP_ROUTER,
    OWNER
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("CLAWDRouter deployed to:", routerAddr);

  // ─── Summary ────────────────────────────────────────────
  console.log("\n========== DEPLOYMENT SUMMARY ==========");
  console.log("APICredits:   ", apiCreditsAddr);
  console.log("CLAWDRouter:  ", routerAddr);
  console.log("CLAWDPricing: ", CLAWD_PRICING, "(unchanged)");
  console.log("========================================");

  // Verify quoteCredits works
  try {
    const [clawdNeeded, usdEquivalent] = await router.quoteCredits(1);
    console.log("\nquoteCredits(1):");
    console.log("  clawdNeeded:", ethers.formatEther(clawdNeeded), "CLAWD");
    console.log("  usdEquivalent:", usdEquivalent.toString(), "wei-USD");
  } catch (e: any) {
    console.log("\nquoteCredits(1) failed:", e.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
