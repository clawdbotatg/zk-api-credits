// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Field} from "./poseidon2/Field.sol";
import {LibPoseidon2} from "./poseidon2/LibPoseidon2.sol";

/**
 * @title APICredits
 * @notice Private anonymous LLM API credits using ZK proofs + ERC-20 token staking.
 *
 * Token-agnostic and forkable — accepts any ERC-20 set at deploy time.
 * PRICE_PER_CREDIT is a static constructor param.
 *
 * Uses a standard incremental Merkle tree with zero-padding (Semaphore-style).
 * This matches the Noir circuit's binary_merkle_root exactly — every level
 * hashes two children, using precomputed zero hashes for empty subtrees.
 *
 * Economic model:
 *   stake()    → tokens sit in stakedBalance (user CAN withdraw)
 *   register() → tokens move to serverClaimable (user CANNOT touch again)
 *   api_call() → burns nullifier offchain (no token movement)
 */
contract APICredits is Ownable {
    using SafeERC20 for IERC20;
    using Field for uint256;

    // ─── Errors ───────────────────────────────────────────────
    error APICredits__ZeroAmount();
    error APICredits__InsufficientStake();
    error APICredits__CommitmentAlreadyUsed(uint256 commitment);
    error APICredits__EmptyTree();
    error APICredits__TreeFull();

    // ─── Constants ────────────────────────────────────────────
    uint256 public constant MAX_DEPTH = 16; // supports up to 65536 leaves

    // ─── Immutables ───────────────────────────────────────────
    IERC20 public immutable paymentToken;
    uint256 public immutable pricePerCredit;

    // ─── State ────────────────────────────────────────────────
    mapping(address => uint256) public stakedBalance;
    uint256 public serverClaimable;

    // Incremental Merkle tree
    uint256 public treeSize;
    uint256 public depth;
    uint256 public root;
    uint256[16] public zeros;       // zeros[i] = hash of empty subtree at depth i
    uint256[16] public filledNodes; // filledNodes[i] = last filled left-subtree hash at level i

    mapping(uint256 => bool) public commitmentUsed;

    // ─── Events ───────────────────────────────────────────────
    event Staked(address indexed user, uint256 amount, uint256 newBalance);
    event Unstaked(address indexed user, uint256 amount, uint256 newBalance);
    event CreditRegistered(
        address indexed user,
        uint256 indexed index,
        uint256 commitment,
        uint256 newStakedBalance
    );
    event NewLeaf(uint256 index, uint256 value);
    event ServerClaimed(address indexed to, uint256 amount);

    // ─── Constructor ──────────────────────────────────────────
    constructor(address _paymentToken, uint256 _pricePerCredit, address _owner) Ownable(_owner) {
        paymentToken = IERC20(_paymentToken);
        pricePerCredit = _pricePerCredit;

        // Precompute zero hashes:
        //   zeros[0] = 0 (empty leaf)
        //   zeros[i+1] = poseidon2(zeros[i], zeros[i])
        zeros[0] = 0;
        for (uint256 i = 0; i < MAX_DEPTH - 1; i++) {
            zeros[i + 1] = _poseidon2Hash(zeros[i], zeros[i]);
        }
    }

    // ─── Internal Hash ────────────────────────────────────────

    function _poseidon2Hash(uint256 left, uint256 right) internal pure returns (uint256) {
        LibPoseidon2.Constants memory constants = LibPoseidon2.load();
        Field.Type result = LibPoseidon2.hash_2(
            constants,
            left.toFieldUnchecked(),
            right.toFieldUnchecked()
        );
        return Field.toUint256(result);
    }

    // ─── User Functions ───────────────────────────────────────

    function stake(uint256 amount) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        emit Staked(msg.sender, amount, stakedBalance[msg.sender]);
    }

    function unstake(uint256 amount) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        if (stakedBalance[msg.sender] < amount) revert APICredits__InsufficientStake();
        stakedBalance[msg.sender] -= amount;
        emit Unstaked(msg.sender, amount, stakedBalance[msg.sender]);
        paymentToken.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Stake tokens and register all credits in one transaction.
     * @param amount  Total tokens to stake (must cover pricePerCredit * commitments.length)
     * @param commitments  One commitment per credit
     */
    function stakeAndRegister(uint256 amount, uint256[] calldata commitments) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        uint256 numCredits = amount / pricePerCredit;
        require(numCredits == commitments.length, "commitment count mismatch");
        require(numCredits > 0, "amount too small");

        // Transfer all tokens in one shot
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        emit Staked(msg.sender, amount, stakedBalance[msg.sender]);

        // Register each commitment
        for (uint256 i = 0; i < numCredits; i++) {
            _register(commitments[i]);
        }
    }

    function register(uint256 _commitment) external {
        if (stakedBalance[msg.sender] < pricePerCredit) revert APICredits__InsufficientStake();
        _register(_commitment);
    }

    function _register(uint256 _commitment) internal {
        if (stakedBalance[msg.sender] < pricePerCredit) revert APICredits__InsufficientStake();
        if (commitmentUsed[_commitment]) revert APICredits__CommitmentAlreadyUsed(_commitment);
        if (treeSize >= (1 << MAX_DEPTH)) revert APICredits__TreeFull();

        // Move tokens from user's withdrawable balance to server-claimable pool
        stakedBalance[msg.sender] -= pricePerCredit;
        serverClaimable += pricePerCredit;

        // Mark commitment as used
        commitmentUsed[_commitment] = true;

        // Insert into incremental Merkle tree
        uint256 index = treeSize;

        // Update depth
        {
            uint256 newSize = treeSize + 1;
            uint256 needed = 0;
            uint256 tmp = newSize;
            while (tmp > 1) {
                needed++;
                tmp = (tmp + 1) >> 1;
            }
            if (needed > depth) depth = needed;
        }

        // Standard incremental Merkle insert
        uint256 node = _commitment;
        for (uint256 i = 0; i < MAX_DEPTH; i++) {
            if ((index >> i) & 1 == 0) {
                filledNodes[i] = node;
                break;
            } else {
                node = _poseidon2Hash(filledNodes[i], node);
            }
        }

        root = _computeRoot(treeSize + 1);
        treeSize++;

        emit NewLeaf(index, _commitment);
        emit CreditRegistered(msg.sender, index, _commitment, stakedBalance[msg.sender]);
    }

    // ─── Root Computation ─────────────────────────────────────

    function _computeRoot(uint256 size) internal view returns (uint256) {
        if (size == 0) return zeros[MAX_DEPTH - 1];

        uint256 node = 0;
        uint256 nodeLevel = 0;
        bool nodeSet = false;

        for (uint256 i = 0; i < MAX_DEPTH; i++) {
            if ((size >> i) & 1 == 1) {
                if (!nodeSet) {
                    node = filledNodes[i];
                    nodeLevel = i;
                    nodeSet = true;
                } else {
                    for (uint256 lvl = nodeLevel; lvl < i; lvl++) {
                        node = _poseidon2Hash(node, zeros[lvl]);
                    }
                    node = _poseidon2Hash(filledNodes[i], node);
                    nodeLevel = i + 1;
                }
            }
        }

        return node;
    }

    // ─── Owner Functions ──────────────────────────────────────

    function claimServer(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert APICredits__ZeroAmount();
        if (amount > serverClaimable) revert APICredits__InsufficientStake();
        serverClaimable -= amount;
        emit ServerClaimed(to, amount);
        paymentToken.safeTransfer(to, amount);
    }

    // ─── View Functions ───────────────────────────────────────

    function getTreeData()
        external
        view
        returns (uint256 size, uint256 treeDepth, uint256 treeRoot)
    {
        if (treeSize == 0) revert APICredits__EmptyTree();
        return (treeSize, depth, root);
    }

    function isCommitmentUsed(uint256 _commitment) external view returns (bool) {
        return commitmentUsed[_commitment];
    }

    function getZeroHash(uint256 level) external view returns (uint256) {
        return zeros[level];
    }
}
