// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {APICredits} from "../src/APICredits.sol";
import {CLAWDPricing} from "../src/CLAWDPricing.sol";
import {CLAWDRouter} from "../src/CLAWDRouter.sol";

/**
 * @notice Deploy APICredits + CLAWDRouter to Base mainnet.
 *
 * Usage:
 *   security find-generic-password -s "clawd-deployer-local" -a "clawd" -w > /tmp/pw.txt
 *   forge script packages/contracts/script/Deploy.s.sol \
 *     --rpc-url https://mainnet.base.org \
 *     --account clawd-deployer-local \
 *     --password-file /tmp/pw.txt \
 *     --broadcast --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY
 *   rm /tmp/pw.txt
 */
contract DeployScript is Script {
    // ─── Base Mainnet Addresses ──────────────────────────────
    address constant CLAWD_TOKEN    = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
    address constant CLAWD_PRICING  = 0xaca9733Cc19aD837899dc7D1170aF1d5367C332E; // existing, reuse
    address constant WETH           = 0x4200000000000000000000000000000000000006;
    address constant USDC           = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER    = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // Revenue recipient — CLAWD auto-forwarded here on every credit purchase
    address constant CLAIM_RECIPIENT = 0x90eF2A9211A3E7CE788561E5af54C76B0Fa3aEd0; // safe.clawd.atg.eth

    // Price: 191 CLAWD per credit (~$0.01 at current price, router handles USD peg)
    uint256 constant PRICE_PER_CREDIT = 191 ether;

    function run() external {
        vm.startBroadcast();

        address deployer = msg.sender;
        console.log("Deployer:        ", deployer);
        console.log("CLAIM_RECIPIENT: ", CLAIM_RECIPIENT);

        // 1. Deploy APICredits
        APICredits apiCredits = new APICredits(
            CLAWD_TOKEN,
            PRICE_PER_CREDIT,
            deployer,       // owner
            CLAIM_RECIPIENT // revenue auto-forwarded here
        );
        console.log("APICredits:      ", address(apiCredits));

        // 2. Deploy CLAWDRouter (points to new APICredits, reuses existing CLAWDPricing)
        CLAWDRouter router = new CLAWDRouter(
            address(apiCredits),
            CLAWD_PRICING,
            CLAWD_TOKEN,
            USDC,
            WETH,
            SWAP_ROUTER,
            deployer // owner
        );
        console.log("CLAWDRouter:     ", address(router));

        // Sanity checks
        require(apiCredits.claimRecipient() == CLAIM_RECIPIENT, "claimRecipient mismatch");
        require(apiCredits.pricePerCredit() == PRICE_PER_CREDIT, "price mismatch");

        vm.stopBroadcast();

        console.log("\n========== DEPLOYMENT SUMMARY ==========");
        console.log("APICredits:   ", address(apiCredits));
        console.log("CLAWDRouter:  ", address(router));
        console.log("CLAWDPricing: ", CLAWD_PRICING, " (reused)");
        console.log("claimRecipient:", CLAIM_RECIPIENT, " (safe.clawd.atg.eth)");
        console.log("=========================================");
    }
}
