// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BinaryIMTData} from "@zk-kit/imt.sol/internal/InternalBinaryIMT.sol";
import {SNARK_SCALAR_FIELD, MAX_DEPTH} from "@zk-kit/imt.sol/Constants.sol";
import {Field} from "./poseidon2/Field.sol";
import {LibPoseidon2} from "./poseidon2/LibPoseidon2.sol";

/**
 * @title Poseidon2IMT
 * @notice Drop-in replacement for @zk-kit/imt.sol's InternalBinaryIMT that uses
 *         Poseidon2 instead of PoseidonT3. Uses the same BinaryIMTData struct
 *         so the storage layout is fully compatible.
 *
 *         Only implements init + insert (append-only tree).
 */
library Poseidon2IMT {
    using Field for uint256;

    error ValueGreaterThanSnarkScalarField();
    error DepthNotSupported();
    error TreeIsFull();

    function _hash(uint256 left, uint256 right) internal pure returns (uint256) {
        LibPoseidon2.Constants memory constants = LibPoseidon2.load();
        Field.Type result = LibPoseidon2.hash_2(
            constants,
            left.toFieldUnchecked(),
            right.toFieldUnchecked()
        );
        return Field.toUint256(result);
    }

    /// @dev Initialize the tree with Poseidon2 zero hashes.
    /// @param self Tree data (BinaryIMTData from imt.sol).
    /// @param depth Tree depth (max MAX_DEPTH from imt.sol Constants).
    function init(BinaryIMTData storage self, uint256 depth) internal {
        if (depth == 0 || depth > MAX_DEPTH) revert DepthNotSupported();

        self.depth = depth;

        // Compute zero hashes: zeroes[0] = 0, zeroes[i+1] = hash(zeroes[i], zeroes[i])
        uint256 zero = 0;
        for (uint8 i = 0; i < depth; ) {
            self.zeroes[i] = zero;
            zero = _hash(zero, zero);
            unchecked { ++i; }
        }

        self.root = zero;
    }

    /// @dev Insert a leaf into the incremental Merkle tree.
    /// @param self Tree data.
    /// @param leaf Leaf value to insert.
    /// @return The new root.
    function insert(BinaryIMTData storage self, uint256 leaf) internal returns (uint256) {
        uint256 depth = self.depth;

        if (leaf >= SNARK_SCALAR_FIELD) revert ValueGreaterThanSnarkScalarField();
        if (self.numberOfLeaves >= 2 ** depth) revert TreeIsFull();

        uint256 index = self.numberOfLeaves;
        uint256 hash = leaf;

        for (uint8 i = 0; i < depth; ) {
            if (index & 1 == 0) {
                self.lastSubtrees[i] = [hash, self.zeroes[i]];
            } else {
                self.lastSubtrees[i][1] = hash;
            }

            hash = _hash(self.lastSubtrees[i][0], self.lastSubtrees[i][1]);
            index >>= 1;

            unchecked { ++i; }
        }

        self.root = hash;
        self.numberOfLeaves += 1;
        return hash;
    }

    /// @dev Insert multiple leaves into the incremental Merkle tree in a single call.
    ///      Saves gas by computing intermediate hashes in memory and only writing to
    ///      storage once per affected tree node, rather than N times per level.
    ///
    ///      For N leaves, total hashes ≈ 2N instead of 16N (depth × N).
    ///
    /// @param self Tree data.
    /// @param leaves Array of leaf values to insert.
    /// @return The new root.
    function insertBatch(BinaryIMTData storage self, uint256[] memory leaves) internal returns (uint256) {
        uint256 n = leaves.length;
        if (n == 0) revert ValueGreaterThanSnarkScalarField();
        if (self.numberOfLeaves + n > 2 ** self.depth) revert TreeIsFull();

        // Validate all leaves
        for (uint256 i = 0; i < n; ) {
            if (leaves[i] >= SNARK_SCALAR_FIELD) revert ValueGreaterThanSnarkScalarField();
            unchecked { ++i; }
        }

        // Load Poseidon2 constants once (expensive to load, amortize over all hashes)
        LibPoseidon2.Constants memory constants = LibPoseidon2.load();

        uint256 startIndex = self.numberOfLeaves;
        uint256 depth = self.depth;

        // Process level by level: at each level, compute parent hashes from child hashes.
        // `hashes` starts as the leaves and becomes parent hashes each iteration.
        uint256[] memory hashes = leaves;
        uint256 levelStart = startIndex;

        for (uint8 level = 0; level < depth; ) {
            (hashes, levelStart) = _processLevel(self, constants, hashes, levelStart, level);
            unchecked { ++level; }
        }

        self.root = hashes[0];
        self.numberOfLeaves = startIndex + n;
        return hashes[0];
    }

    /// @dev Process one level of the batch insert. Takes the hashes at `level` and
    ///      returns the parent hashes for level+1.
    function _processLevel(
        BinaryIMTData storage self,
        LibPoseidon2.Constants memory constants,
        uint256[] memory hashes,
        uint256 levelStart,
        uint8 level
    ) private returns (uint256[] memory parentHashes, uint256 parentStart) {
        uint256 count = hashes.length;
        parentStart = levelStart >> 1;
        uint256 parentEnd = (levelStart + count - 1) >> 1;
        parentHashes = new uint256[](parentEnd - parentStart + 1);

        for (uint256 i = 0; i < count; ) {
            uint256 nodeIndex = levelStart + i;
            uint256 pIdx = (nodeIndex >> 1) - parentStart;

            if (nodeIndex & 1 == 0) {
                // Left child
                uint256 right;
                if (i + 1 < count && (nodeIndex + 1) & 1 == 1) {
                    right = hashes[i + 1]; // right sibling in this batch
                } else {
                    right = self.zeroes[level]; // empty right subtree
                }
                self.lastSubtrees[level] = [hashes[i], right];
                parentHashes[pIdx] = _hashC(constants, hashes[i], right);
            } else {
                // Right child — left sibling already in lastSubtrees
                self.lastSubtrees[level][1] = hashes[i];
                parentHashes[pIdx] = _hashC(constants, self.lastSubtrees[level][0], hashes[i]);
            }

            unchecked { ++i; }
        }
    }

    /// @dev Hash with pre-loaded constants (avoids reloading per call)
    function _hashC(LibPoseidon2.Constants memory constants, uint256 left, uint256 right) private pure returns (uint256) {
        return Field.toUint256(LibPoseidon2.hash_2(
            constants,
            left.toFieldUnchecked(),
            right.toFieldUnchecked()
        ));
    }
}
