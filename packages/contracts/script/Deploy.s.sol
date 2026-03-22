// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {APICredits} from "../src/APICredits.sol";
import {CLAWDPricing} from "../src/CLAWDPricing.sol";
import {CLAWDRouter} from "../src/CLAWDRouter.sol";

/**
 * @notice Deploy APICredits + CLAWDPricing + CLAWDRouter to Base mainnet.
 *
 * Deploys in order: CLAWDPricing → APICredits → CLAWDRouter
 * then sets creditPriceUSD on CLAWDPricing.
 *
 * Usage:
 *   cd packages/contracts
 *   forge script script/Deploy.s.sol \
 *     --rpc-url https://base-mainnet.g.alchemy.com/v2/YOUR_KEY \
 *     --private-key YOUR_PRIVATE_KEY \
 *     --broadcast
 */
contract DeployScript is Script {
    // ─── Base Mainnet Addresses ──────────────────────────────
    address constant CLAWD_TOKEN    = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
    address constant WETH          = 0x4200000000000000000000000000000000000006;
    address constant USDC           = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER    = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant UNISWAP_POOL   = 0xCD55381a53da35Ab1D7Bc5e3fE5F76cac976FAc3; // WETH/CLAWD V3
    address constant CHAINLINK_ETH  = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70; // ETH/USD

    // Revenue recipient
    address constant CLAIM_RECIPIENT = 0x90eF2A9211A3E7CE788561E5af54C76B0Fa3aEd0; // safe.clawd.atg.eth

    // $0.05 per credit = 5e16 wei
    uint256 constant CREDIT_PRICE_USD = 5e16;

    // Must match oracle-computed pricePerCreditCLAWD at deployment time:
    // pricePerCreditCLAWD = creditPriceUSD * clawdPerEth / ethUsd
    // Run this first to get current oracle value:
    //   cast call <CLAWDPricing> "getCreditPriceInCLAWD()(uint256)" <PRICING_ADDR>
    //
    // ⚠️  The oracle TWAP changes constantly. After deploying APICredits,
    //     you MUST call setPricePerCredit on the new APICredits contract
    //     with the current oracle value to ensure router ↔ APICredits alignment.
    //     Otherwise buyWithETH will revert with "commitment count mismatch".
    uint256 constant PRICE_PER_CREDIT_CLAWD = 1419906253491699114606; // oracle value at deploy time

    function run() external {
        // PRIVATE_KEY env var — set when running forge script
        //   PRIVATE_KEY=0x... forge script ...
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        console.log("Deployer:        ", deployer);
        console.log("CLAIM_RECIPIENT: ", CLAIM_RECIPIENT);

        vm.startBroadcast(deployerPk);

        // 1. Deploy CLAWDPricing first (no constructor price set)
        CLAWDPricing pricing = new CLAWDPricing(
            UNISWAP_POOL,
            CHAINLINK_ETH,
            deployer
        );
        console.log("CLAWDPricing:    ", address(pricing));

        // Set $0.05 credit price
        pricing.setCreditPriceUSD(CREDIT_PRICE_USD);
        console.log("creditPriceUSD set to:", CREDIT_PRICE_USD);

        // 2. Deploy APICredits
        APICredits apiCredits = new APICredits(
            CLAWD_TOKEN,
            PRICE_PER_CREDIT_CLAWD,
            deployer,       // owner
            CLAIM_RECIPIENT // revenue auto-forwarded here
        );
        console.log("APICredits:      ", address(apiCredits));

        // Sync APICredits.pricePerCredit with oracle's current TWAP.
        // This prevents "commitment count mismatch" if TWAP shifted since deployment.
        uint256 currentOraclePrice = pricing.getCreditPriceInCLAWD();
        apiCredits.setPricePerCredit(currentOraclePrice);
        console.log("APICredits.pricePerCredit synced to oracle:", currentOraclePrice);

        // 3. Deploy CLAWDRouter
        CLAWDRouter router = new CLAWDRouter(
            address(apiCredits),
            address(pricing),
            CLAWD_TOKEN,
            USDC,
            WETH,
            SWAP_ROUTER,
            deployer // owner
        );
        console.log("CLAWDRouter:    ", address(router));

        vm.stopBroadcast();

        console.log("\n========== DEPLOYMENT SUMMARY ==========");
        console.log("CLAWDPricing: ", address(pricing), "(creditPriceUSD=5e16=$0.05)");
        console.log("APICredits:  ", address(apiCredits), "(pricePerCredit=1420.33 CLAWD)");
        console.log("CLAWDRouter: ", address(router));
        console.log("CLAWD_TOKEN: ", CLAWD_TOKEN);
        console.log("claimRecipient:", CLAIM_RECIPIENT);
        console.log("=========================================");
    }
}
