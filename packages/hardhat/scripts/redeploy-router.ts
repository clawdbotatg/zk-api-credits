import { ethers } from "hardhat";

const API_CREDITS = "0xc18fad39f72eBe5E54718D904C5012Da74594674";
const CLAWD_PRICING = "0xaca9733Cc19aD837899dc7D1170aF1d5367C332E";
const CLAWD = "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("ETH balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  const Factory = await ethers.getContractFactory("CLAWDRouter");
  const router = await Factory.deploy(API_CREDITS, CLAWD_PRICING, CLAWD, USDC, WETH, SWAP_ROUTER, deployer.address);
  await router.waitForDeployment();
  const addr = await router.getAddress();
  console.log("✅ CLAWDRouter deployed:", addr);
}
main().catch(console.error);
