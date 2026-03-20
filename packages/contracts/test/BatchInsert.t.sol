// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {APICredits} from "../src/APICredits.sol";
import {MockERC20} from "../src/MockERC20.sol";

/**
 * @title BatchInsertGasTest
 * @notice Gas benchmarks for batch vs sequential Merkle tree insertion.
 *
 * Tests:
 *   1. Single insert (original path) — baseline
 *   2. Batch insert N = 1, 5, 10, 20
 *   3. Correctness: batch produces the same root as sequential inserts
 */
contract BatchInsertGasTest is Test {
    APICredits credits;
    MockERC20 token;

    address owner = address(0xBEEF);
    address claimRecipient = address(0xCAFE);
    address buyer = address(0xDEAD);

    uint256 constant PRICE = 191 ether;

    function setUp() public {
        token = new MockERC20();
        credits = new APICredits(address(token), PRICE, owner, claimRecipient);

        // Give buyer unlimited tokens
        token.mint(buyer, 1_000_000 ether);
        vm.prank(buyer);
        token.approve(address(credits), type(uint256).max);
    }

    // ─── Correctness ─────────────────────────────────────────

    function test_batchMatchesSequential() public {
        // Deploy two separate contracts, insert same leaves, compare roots
        APICredits seqCredits = new APICredits(address(token), PRICE, owner, claimRecipient);
        APICredits batchCredits = new APICredits(address(token), PRICE, owner, claimRecipient);

        token.mint(address(this), 1_000_000 ether);
        token.approve(address(seqCredits), type(uint256).max);
        token.approve(address(batchCredits), type(uint256).max);

        uint256 n = 7; // odd number to test edge cases
        uint256[] memory commitments = _makeCommitments(n, 100);

        // Sequential: insert one at a time
        for (uint256 i = 0; i < n; i++) {
            uint256[] memory single = new uint256[](1);
            single[0] = commitments[i];
            seqCredits.stakeAndRegister(PRICE, single);
        }

        // Batch: insert all at once
        batchCredits.stakeAndRegister(PRICE * n, commitments);

        // Compare roots — they MUST match
        (,, uint256 seqRoot) = seqCredits.getTreeData();
        (,, uint256 batchRoot) = batchCredits.getTreeData();

        assertEq(seqRoot, batchRoot, "batch root must match sequential root");
        assertEq(seqCredits.treeSize(), batchCredits.treeSize(), "tree sizes must match");
    }

    function test_batchMatchesSequential_evenCount() public {
        APICredits seqCredits = new APICredits(address(token), PRICE, owner, claimRecipient);
        APICredits batchCredits = new APICredits(address(token), PRICE, owner, claimRecipient);

        token.mint(address(this), 1_000_000 ether);
        token.approve(address(seqCredits), type(uint256).max);
        token.approve(address(batchCredits), type(uint256).max);

        uint256 n = 10;
        uint256[] memory commitments = _makeCommitments(n, 200);

        for (uint256 i = 0; i < n; i++) {
            uint256[] memory single = new uint256[](1);
            single[0] = commitments[i];
            seqCredits.stakeAndRegister(PRICE, single);
        }

        batchCredits.stakeAndRegister(PRICE * n, commitments);

        (,, uint256 seqRoot) = seqCredits.getTreeData();
        (,, uint256 batchRoot) = batchCredits.getTreeData();
        assertEq(seqRoot, batchRoot, "batch root must match sequential root (even)");
    }

    function test_batchAfterExistingInserts() public {
        // Insert 3 leaves first, then batch insert 5 more
        // Compare against sequential for the same 8 total
        APICredits seqCredits = new APICredits(address(token), PRICE, owner, claimRecipient);
        APICredits batchCredits = new APICredits(address(token), PRICE, owner, claimRecipient);

        token.mint(address(this), 1_000_000 ether);
        token.approve(address(seqCredits), type(uint256).max);
        token.approve(address(batchCredits), type(uint256).max);

        uint256[] memory first3 = _makeCommitments(3, 300);
        uint256[] memory next5 = _makeCommitments(5, 400);

        // Insert first 3 sequentially in both
        for (uint256 i = 0; i < 3; i++) {
            uint256[] memory single = new uint256[](1);
            single[0] = first3[i];
            seqCredits.stakeAndRegister(PRICE, single);
            batchCredits.stakeAndRegister(PRICE, single);
        }

        // Sequential: insert next 5 one at a time
        for (uint256 i = 0; i < 5; i++) {
            uint256[] memory single = new uint256[](1);
            single[0] = next5[i];
            seqCredits.stakeAndRegister(PRICE, single);
        }

        // Batch: insert next 5 all at once
        batchCredits.stakeAndRegister(PRICE * 5, next5);

        (,, uint256 seqRoot) = seqCredits.getTreeData();
        (,, uint256 batchRoot) = batchCredits.getTreeData();
        assertEq(seqRoot, batchRoot, "batch after existing must match sequential");
    }

    // ─── Gas Benchmarks ──────────────────────────────────────

    function test_gas_insert1_single() public {
        uint256[] memory commitments = _makeCommitments(1, 1000);
        uint256 gasBefore = gasleft();
        vm.prank(buyer);
        credits.stakeAndRegister(PRICE, commitments);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("Gas: 1 credit (batch path):", gasUsed);
    }

    function test_gas_insert5() public {
        uint256[] memory commitments = _makeCommitments(5, 2000);
        uint256 gasBefore = gasleft();
        vm.prank(buyer);
        credits.stakeAndRegister(PRICE * 5, commitments);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("Gas: 5 credits (batch):", gasUsed);
    }

    function test_gas_insert10() public {
        uint256[] memory commitments = _makeCommitments(10, 3000);
        uint256 gasBefore = gasleft();
        vm.prank(buyer);
        credits.stakeAndRegister(PRICE * 10, commitments);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("Gas: 10 credits (batch):", gasUsed);
    }

    function test_gas_insert20() public {
        uint256[] memory commitments = _makeCommitments(20, 4000);
        uint256 gasBefore = gasleft();
        vm.prank(buyer);
        credits.stakeAndRegister(PRICE * 20, commitments);
        uint256 gasUsed = gasBefore - gasleft();
        console.log("Gas: 20 credits (batch):", gasUsed);
    }

    function test_gas_insert5_sequential() public {
        // Baseline: 5 credits inserted one at a time (old behavior)
        uint256[] memory commitments = _makeCommitments(5, 5000);
        uint256 totalGas = 0;
        for (uint256 i = 0; i < 5; i++) {
            uint256[] memory single = new uint256[](1);
            single[0] = commitments[i];
            uint256 gasBefore = gasleft();
            vm.prank(buyer);
            credits.stakeAndRegister(PRICE, single);
            totalGas += gasBefore - gasleft();
        }
        console.log("Gas: 5 credits (sequential, 5 txs):", totalGas);
    }

    // ─── Helpers ─────────────────────────────────────────────

    function _makeCommitments(uint256 n, uint256 seed) internal pure returns (uint256[] memory) {
        uint256[] memory c = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            // Must be < SNARK_SCALAR_FIELD
            c[i] = uint256(keccak256(abi.encodePacked(seed, i))) % 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        }
        return c;
    }
}
