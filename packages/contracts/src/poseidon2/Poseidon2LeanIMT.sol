// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {Field} from "./Field.sol";
import {LibPoseidon2} from "./LibPoseidon2.sol";

/// @dev SNARK_SCALAR_FIELD for BN254
uint256 constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

struct Poseidon2LeanIMTData {
    uint256 size;
    uint256 depth;
    mapping(uint256 => uint256) sideNodes;
    mapping(uint256 => uint256) leaves;
}

error WrongSiblingNodes();
error LeafGreaterThanSnarkScalarField();
error LeafCannotBeZero();
error LeafAlreadyExists();
error LeafDoesNotExist();

/// @title Poseidon2 Lean Incremental Merkle Tree
/// @notice Fork of zk-kit's LeanIMT that uses Poseidon2 (Noir-compatible) instead of PoseidonT3
library Poseidon2LeanIMT {
    using Field for uint256;

    function _poseidon2Hash(uint256 left, uint256 right) private pure returns (uint256) {
        LibPoseidon2.Constants memory constants = LibPoseidon2.load();
        Field.Type result = LibPoseidon2.hash_2(constants, left.toFieldUnchecked(), right.toFieldUnchecked());
        return Field.toUint256(result);
    }

    function insert(Poseidon2LeanIMTData storage self, uint256 leaf) public returns (uint256) {
        if (leaf >= SNARK_SCALAR_FIELD) {
            revert LeafGreaterThanSnarkScalarField();
        } else if (leaf == 0) {
            revert LeafCannotBeZero();
        } else if (has(self, leaf)) {
            revert LeafAlreadyExists();
        }

        uint256 index = self.size;
        uint256 treeDepth = self.depth;

        if (2 ** treeDepth < index + 1) {
            ++treeDepth;
        }

        self.depth = treeDepth;

        uint256 node = leaf;

        for (uint256 level = 0; level < treeDepth; ) {
            if ((index >> level) & 1 == 1) {
                node = _poseidon2Hash(self.sideNodes[level], node);
            } else {
                self.sideNodes[level] = node;
            }

            unchecked {
                ++level;
            }
        }

        self.size = ++index;

        self.sideNodes[treeDepth] = node;
        self.leaves[leaf] = index;

        return node;
    }

    function insertMany(Poseidon2LeanIMTData storage self, uint256[] calldata leaves) public returns (uint256) {
        uint256 treeSize = self.size;

        for (uint256 i = 0; i < leaves.length; ) {
            if (leaves[i] >= SNARK_SCALAR_FIELD) {
                revert LeafGreaterThanSnarkScalarField();
            } else if (leaves[i] == 0) {
                revert LeafCannotBeZero();
            } else if (has(self, leaves[i])) {
                revert LeafAlreadyExists();
            }

            self.leaves[leaves[i]] = treeSize + 1 + i;

            unchecked {
                ++i;
            }
        }

        uint256[] memory currentLevelNewNodes;
        currentLevelNewNodes = leaves;

        uint256 treeDepth = self.depth;

        while (2 ** treeDepth < treeSize + leaves.length) {
            ++treeDepth;
        }

        self.depth = treeDepth;

        uint256 currentLevelStartIndex = treeSize;
        uint256 currentLevelSize = treeSize + leaves.length;
        uint256 nextLevelStartIndex = currentLevelStartIndex >> 1;
        uint256 nextLevelSize = ((currentLevelSize - 1) >> 1) + 1;

        for (uint256 level = 0; level < treeDepth; ) {
            uint256 numberOfNewNodes = nextLevelSize - nextLevelStartIndex;
            uint256[] memory nextLevelNewNodes = new uint256[](numberOfNewNodes);
            for (uint256 i = 0; i < numberOfNewNodes; ) {
                uint256 leftNode;

                if ((i + nextLevelStartIndex) * 2 < currentLevelStartIndex) {
                    leftNode = self.sideNodes[level];
                } else {
                    leftNode = currentLevelNewNodes[(i + nextLevelStartIndex) * 2 - currentLevelStartIndex];
                }

                uint256 rightNode;

                if ((i + nextLevelStartIndex) * 2 + 1 < currentLevelSize) {
                    rightNode = currentLevelNewNodes[(i + nextLevelStartIndex) * 2 + 1 - currentLevelStartIndex];
                }

                uint256 parentNode;

                if (rightNode != 0) {
                    parentNode = _poseidon2Hash(leftNode, rightNode);
                } else {
                    parentNode = leftNode;
                }

                nextLevelNewNodes[i] = parentNode;

                unchecked {
                    ++i;
                }
            }

            if (currentLevelSize & 1 == 1) {
                self.sideNodes[level] = currentLevelNewNodes[currentLevelNewNodes.length - 1];
            } else if (currentLevelNewNodes.length > 1) {
                self.sideNodes[level] = currentLevelNewNodes[currentLevelNewNodes.length - 2];
            }

            currentLevelStartIndex = nextLevelStartIndex;
            nextLevelStartIndex >>= 1;
            currentLevelNewNodes = nextLevelNewNodes;
            currentLevelSize = nextLevelSize;
            nextLevelSize = ((nextLevelSize - 1) >> 1) + 1;

            unchecked {
                ++level;
            }
        }

        self.size = treeSize + leaves.length;
        self.sideNodes[treeDepth] = currentLevelNewNodes[0];

        return currentLevelNewNodes[0];
    }

    function update(
        Poseidon2LeanIMTData storage self,
        uint256 oldLeaf,
        uint256 newLeaf,
        uint256[] calldata siblingNodes
    ) public returns (uint256) {
        if (newLeaf >= SNARK_SCALAR_FIELD) {
            revert LeafGreaterThanSnarkScalarField();
        } else if (!has(self, oldLeaf)) {
            revert LeafDoesNotExist();
        } else if (has(self, newLeaf)) {
            revert LeafAlreadyExists();
        }

        uint256 index = indexOf(self, oldLeaf);
        uint256 node = newLeaf;
        uint256 oldRoot = oldLeaf;

        uint256 lastIndex = self.size - 1;
        uint256 i = 0;

        uint256 treeDepth = self.depth;

        for (uint256 level = 0; level < treeDepth; ) {
            if ((index >> level) & 1 == 1) {
                if (siblingNodes[i] >= SNARK_SCALAR_FIELD) {
                    revert LeafGreaterThanSnarkScalarField();
                }

                node = _poseidon2Hash(siblingNodes[i], node);
                oldRoot = _poseidon2Hash(siblingNodes[i], oldRoot);

                unchecked {
                    ++i;
                }
            } else {
                if (index >> level != lastIndex >> level) {
                    if (siblingNodes[i] >= SNARK_SCALAR_FIELD) {
                        revert LeafGreaterThanSnarkScalarField();
                    }

                    if (self.sideNodes[level] == oldRoot) {
                        self.sideNodes[level] = node;
                    }

                    node = _poseidon2Hash(node, siblingNodes[i]);
                    oldRoot = _poseidon2Hash(oldRoot, siblingNodes[i]);

                    unchecked {
                        ++i;
                    }
                } else {
                    self.sideNodes[level] = node;
                }
            }

            unchecked {
                ++level;
            }
        }

        if (oldRoot != root(self)) {
            revert WrongSiblingNodes();
        }

        self.sideNodes[treeDepth] = node;

        if (newLeaf != 0) {
            self.leaves[newLeaf] = self.leaves[oldLeaf];
        }

        self.leaves[oldLeaf] = 0;

        return node;
    }

    function remove(
        Poseidon2LeanIMTData storage self,
        uint256 oldLeaf,
        uint256[] calldata siblingNodes
    ) public returns (uint256) {
        return update(self, oldLeaf, 0, siblingNodes);
    }

    function has(Poseidon2LeanIMTData storage self, uint256 leaf) public view returns (bool) {
        return self.leaves[leaf] != 0;
    }

    function indexOf(Poseidon2LeanIMTData storage self, uint256 leaf) public view returns (uint256) {
        if (self.leaves[leaf] == 0) {
            revert LeafDoesNotExist();
        }

        return self.leaves[leaf] - 1;
    }

    function root(Poseidon2LeanIMTData storage self) public view returns (uint256) {
        return self.sideNodes[self.depth];
    }
}
