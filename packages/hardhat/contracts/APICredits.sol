// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BinaryIMTData} from "@zk-kit/imt.sol/internal/InternalBinaryIMT.sol";
import {Poseidon2IMT} from "./Poseidon2IMT.sol";

/**
 * @title APICredits
 * @notice Private anonymous LLM API credits using ZK proofs + ERC-20 token staking.
 *
 * Token-agnostic and forkable — accepts any ERC-20 set at deploy time.
 * PRICE_PER_CREDIT is a static constructor param.
 *
 * Uses zk-kit imt.sol's BinaryIMTData struct with a Poseidon2 hash adapter
 * (Poseidon2IMT library). This matches the Noir circuit's binary_merkle_root
 * exactly — every level hashes two children, using precomputed zero hashes
 * for empty subtrees.
 *
 * Economic model:
 *   stake()    → tokens sit in stakedBalance (user CAN withdraw)
 *   register() → tokens move to serverClaimable (user CANNOT touch again)
 *   api_call() → burns nullifier offchain (no token movement)
 */
contract APICredits is Ownable {
    using SafeERC20 for IERC20;
    using Poseidon2IMT for BinaryIMTData;

    // ─── Errors ───────────────────────────────────────────────
    error APICredits__ZeroAmount();
    error APICredits__InsufficientStake();
    error APICredits__CommitmentAlreadyUsed(uint256 commitment);
    error APICredits__EmptyTree();

    // ─── Constants ────────────────────────────────────────────
    uint256 public constant MAX_DEPTH = 16; // supports up to 65536 leaves

    // ─── Immutables ───────────────────────────────────────────
    IERC20 public immutable paymentToken;

    // ─── Mutable pricing ─────────────────────────────────────
    uint256 public pricePerCredit;

    // ─── State ────────────────────────────────────────────────
    mapping(address => uint256) public stakedBalance;

    // Revenue recipient — receives CLAWD immediately on every registration
    address public claimRecipient;

    // Kept for backwards-compat view calls; always 0 with auto-forward
    uint256 public serverClaimable;

    // Incremental Merkle tree (imt.sol struct, Poseidon2 hashing)
    BinaryIMTData public tree;

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
    event ClaimRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    // ─── Constructor ──────────────────────────────────────────
    constructor(address _paymentToken, uint256 _pricePerCredit, address _owner, address _claimRecipient) Ownable(_owner) {
        require(_claimRecipient != address(0), "zero claim recipient");
        paymentToken = IERC20(_paymentToken);
        pricePerCredit = _pricePerCredit;
        claimRecipient = _claimRecipient;

        // Initialize the imt.sol tree with Poseidon2 zero hashes
        tree.init(MAX_DEPTH);
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
     * @notice Pay tokens and register commitments in one transaction.
     * @dev All tokens go directly to serverClaimable — the caller (usually CLAWDRouter)
     *      is responsible for sending the correct amount. No pricePerCredit check here.
     * @param amount  Total tokens to pay
     * @param commitments  One commitment per credit
     */
    function stakeAndRegister(uint256 amount, uint256[] calldata commitments) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        require(commitments.length > 0, "no commitments");
        require(amount >= pricePerCredit * commitments.length, "commitment count mismatch");

        // Transfer tokens directly to claimRecipient (Safe) — no accumulation
        paymentToken.safeTransferFrom(msg.sender, claimRecipient, amount);
        emit ServerClaimed(claimRecipient, amount);

        // Register each commitment (payment already forwarded)
        for (uint256 i = 0; i < commitments.length; i++) {
            _registerDirect(commitments[i]);
        }
    }

    function register(uint256 _commitment) external {
        if (stakedBalance[msg.sender] < pricePerCredit) revert APICredits__InsufficientStake();
        _register(_commitment);
    }

    function _register(uint256 _commitment) internal {
        if (stakedBalance[msg.sender] < pricePerCredit) revert APICredits__InsufficientStake();
        if (commitmentUsed[_commitment]) revert APICredits__CommitmentAlreadyUsed(_commitment);

        // Move tokens from user's staked balance directly to claimRecipient (Safe)
        stakedBalance[msg.sender] -= pricePerCredit;
        paymentToken.safeTransfer(claimRecipient, pricePerCredit);
        emit ServerClaimed(claimRecipient, pricePerCredit);

        commitmentUsed[_commitment] = true;
        _insertLeaf(_commitment);
    }

    /// @dev Register a commitment without balance checks (used by stakeAndRegister where payment is pre-handled)
    function _registerDirect(uint256 _commitment) internal {
        if (commitmentUsed[_commitment]) revert APICredits__CommitmentAlreadyUsed(_commitment);

        commitmentUsed[_commitment] = true;
        _insertLeaf(_commitment);
    }

    /// @dev Insert a leaf into the incremental Merkle tree
    function _insertLeaf(uint256 _commitment) internal {
        uint256 index = tree.numberOfLeaves;
        tree.insert(_commitment);

        emit NewLeaf(index, _commitment);
        emit CreditRegistered(msg.sender, index, _commitment, stakedBalance[msg.sender]);
    }

    // ─── Owner Functions ──────────────────────────────────────

    function claimServer(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert APICredits__ZeroAmount();
        if (amount > serverClaimable) revert APICredits__InsufficientStake();
        serverClaimable -= amount;
        emit ServerClaimed(to, amount);
        paymentToken.safeTransfer(to, amount);
    }

    /**
     * @notice Update the revenue recipient. Owner only.
     */
    function setClaimRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "zero address");
        emit ClaimRecipientUpdated(claimRecipient, newRecipient);
        claimRecipient = newRecipient;
    }

    /**
     * @notice Update the price per credit. Owner only.
     */
    function setPricePerCredit(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, "zero price");
        pricePerCredit = newPrice;
    }

    // ─── View Functions ───────────────────────────────────────

    /// @notice Backwards-compatible view: returns (size, depth, root).
    function getTreeData()
        external
        view
        returns (uint256 size, uint256 treeDepth, uint256 treeRoot)
    {
        if (tree.numberOfLeaves == 0) revert APICredits__EmptyTree();
        return (tree.numberOfLeaves, tree.depth, tree.root);
    }

    /// @notice Alias for tree.numberOfLeaves (backwards compat).
    function treeSize() external view returns (uint256) {
        return tree.numberOfLeaves;
    }

    /// @notice Alias for tree.depth (backwards compat).
    function depth() external view returns (uint256) {
        return tree.depth;
    }

    /// @notice Alias for tree.root (backwards compat).
    function root() external view returns (uint256) {
        return tree.root;
    }

    function isCommitmentUsed(uint256 _commitment) external view returns (bool) {
        return commitmentUsed[_commitment];
    }

    /// @notice Returns the Poseidon2 zero hash at the given level.
    function getZeroHash(uint256 level) external view returns (uint256) {
        return tree.zeroes[level];
    }
}
