import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { parseEther } from "ethers";

// Base mainnet addresses
const BASE_ADDRESSES = {
  clawd: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  uniswapPool: "0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3",     // WETH/CLAWD 1% fee
  chainlinkEthUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Chainlink ETH/USD
  swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",       // Uniswap V3 SwapRouter on Base
};

// Price per credit in CLAWD for APICredits constructor.
// Must match oracle-computed price: creditPriceUSD * clawdPerEth / ethUsd
// At creditPriceUSD=$0.05 and ~$0.000035 CLAWD/USD → ~1000-1500 CLAWD per credit.
// Set conservatively high so the contract check passes; the router computes dynamically.
const PRICE_PER_CREDIT = parseEther("1500"); // 1500 CLAWD per credit (covers oracle TWAP at $0.05)

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  let clawdAddress: string;
  let uniswapPoolAddress: string;
  let chainlinkAddress: string;
  let wethAddress: string;
  let usdcAddress: string;
  let swapRouterAddress: string;

  if (hre.network.name === "base") {
    // Base mainnet
    clawdAddress = BASE_ADDRESSES.clawd;
    uniswapPoolAddress = BASE_ADDRESSES.uniswapPool;
    chainlinkAddress = BASE_ADDRESSES.chainlinkEthUsd;
    wethAddress = BASE_ADDRESSES.weth;
    usdcAddress = BASE_ADDRESSES.usdc;
    swapRouterAddress = BASE_ADDRESSES.swapRouter;
  } else {
    // Local / testnet — deploy mocks
    const mockClawd = await deploy("MockERC20", {
      from: deployer,
      log: true,
      autoMine: true,
    });
    clawdAddress = mockClawd.address;

    const mockPool = await deploy("MockUniswapV3Pool", {
      from: deployer,
      log: true,
      autoMine: true,
    });
    uniswapPoolAddress = mockPool.address;

    const mockChainlink = await deploy("MockChainlinkAggregator", {
      from: deployer,
      log: true,
      autoMine: true,
    });
    chainlinkAddress = mockChainlink.address;

    // Use mock addresses for WETH/USDC/SwapRouter on local
    wethAddress = clawdAddress;      // placeholder
    usdcAddress = clawdAddress;      // placeholder
    swapRouterAddress = clawdAddress; // placeholder
  }

  // Revenue recipient — CLAWD flows here automatically on every credit purchase
  const CLAIM_RECIPIENT = "0x90eF2A9211A3E7CE788561E5af54C76B0Fa3aEd0"; // safe.clawd.atg.eth

  // 1. Deploy APICredits (token-agnostic core)
  const apiCredits = await deploy("APICredits", {
    from: deployer,
    args: [clawdAddress, PRICE_PER_CREDIT, deployer, CLAIM_RECIPIENT],
    log: true,
    autoMine: true,
  });

  // 2. Deploy CLAWDPricing (TWAP oracle)
  const clawdPricing = await deploy("CLAWDPricing", {
    from: deployer,
    args: [uniswapPoolAddress, chainlinkAddress, deployer],
    log: true,
    autoMine: true,
  });

  // 3. Deploy CLAWDRouter (payment router)
  await deploy("CLAWDRouter", {
    from: deployer,
    args: [
      apiCredits.address,
      clawdPricing.address,
      clawdAddress,
      usdcAddress,
      wethAddress,
      swapRouterAddress,
      deployer,
    ],
    log: true,
    autoMine: true,
  });
};

export default deploy;
deploy.tags = ["APICredits", "CLAWDPricing", "CLAWDRouter"];
