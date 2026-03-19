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
}
