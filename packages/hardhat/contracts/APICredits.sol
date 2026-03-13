// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

import {LeanIMT, LeanIMTData} from "@zk-kit/lean-imt.sol/LeanIMT.sol";
import {InternalLeanIMT} from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UltraVerifier} from "./Verifier.sol";

/**
 * @title APICredits
 * @notice Private anonymous LLM API credits using ZK proofs + CLAWD token staking.
 *
 * Economic model:
 *   stake()    → CLAWD sits in stakedBalance (user CAN withdraw)
 *   register() → CLAWD moves to serverClaimable (user CANNOT touch again)
 *   api_call() → burns nullifier offchain (no token movement)
 *
 * Privacy: ZK proof breaks the link between wallet and API usage.
 */
contract APICredits is Ownable {
    using LeanIMT for LeanIMTData;
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────
    error APICredits__InsufficientStake();
    error APICredits__CommitmentAlreadyUsed(uint256 commitment);
    error APICredits__EmptyTree();
    error APICredits__ZeroAmount();

    // ─── Constants ────────────────────────────────────────────
    uint256 public constant PRICE_PER_CREDIT = 1000 * 1e18; // 1000 CLAWD per credit

    // ─── State ────────────────────────────────────────────────
    IERC20 public immutable clawdToken;
    mapping(address => uint256) public stakedBalance;
    uint256 public serverClaimable;

    LeanIMTData private s_tree;
    mapping(uint256 => bool) private s_commitmentUsed;

    UltraVerifier private immutable i_verifier;

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
    constructor(address _clawdToken, address _owner, address _verifier) Ownable(_owner) {
        clawdToken = IERC20(_clawdToken);
        i_verifier = UltraVerifier(_verifier);
    }

    // ─── User Functions ───────────────────────────────────────

    /**
     * @notice Deposit CLAWD tokens into your staked balance.
     * @dev Requires prior approval of this contract to spend `amount` CLAWD.
     * @param amount Amount of CLAWD to stake.
     */
    function stake(uint256 amount) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        clawdToken.safeTransferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        emit Staked(msg.sender, amount, stakedBalance[msg.sender]);
    }

    /**
     * @notice Withdraw unregistered staked CLAWD.
     * @param amount Amount to withdraw (must be ≤ stakedBalance).
     */
    function unstake(uint256 amount) external {
        if (amount == 0) revert APICredits__ZeroAmount();
        if (stakedBalance[msg.sender] < amount) revert APICredits__InsufficientStake();

        stakedBalance[msg.sender] -= amount;
        emit Unstaked(msg.sender, amount, stakedBalance[msg.sender]);

        clawdToken.safeTransfer(msg.sender, amount);
    }

    /**
     * @notice Register a commitment to create one API credit.
     * @dev Moves PRICE_PER_CREDIT from stakedBalance → serverClaimable.
     *      Inserts commitment into the Merkle tree. Irreversible.
     * @param _commitment The Poseidon2(nullifier, secret) commitment.
     */
    function register(uint256 _commitment) external {
        if (stakedBalance[msg.sender] < PRICE_PER_CREDIT) revert APICredits__InsufficientStake();
        if (s_commitmentUsed[_commitment]) revert APICredits__CommitmentAlreadyUsed(_commitment);

        // Move CLAWD from user's withdrawable balance to server-claimable pool
        stakedBalance[msg.sender] -= PRICE_PER_CREDIT;
        serverClaimable += PRICE_PER_CREDIT;

        // Mark commitment as used and insert into Merkle tree
        s_commitmentUsed[_commitment] = true;
        s_tree.insert(_commitment);

        uint256 idx = s_tree.size - 1;
        emit NewLeaf(idx, _commitment);
        emit CreditRegistered(msg.sender, idx, _commitment, stakedBalance[msg.sender]);
    }

    /**
     * @notice Batch register multiple commitments in one transaction.
     * @param _commitments Array of commitments to register.
     */
    function registerBatch(uint256[] calldata _commitments) external {
        uint256 totalCost = _commitments.length * PRICE_PER_CREDIT;
        if (stakedBalance[msg.sender] < totalCost) revert APICredits__InsufficientStake();

        for (uint256 i = 0; i < _commitments.length; i++) {
            uint256 c = _commitments[i];
            if (s_commitmentUsed[c]) revert APICredits__CommitmentAlreadyUsed(c);

            stakedBalance[msg.sender] -= PRICE_PER_CREDIT;
            serverClaimable += PRICE_PER_CREDIT;

            s_commitmentUsed[c] = true;
            s_tree.insert(c);

            uint256 idx = s_tree.size - 1;
            emit NewLeaf(idx, c);
            emit CreditRegistered(msg.sender, idx, c, stakedBalance[msg.sender]);
        }
    }

    // ─── Owner Functions ──────────────────────────────────────

    /**
     * @notice Server operator claims accumulated CLAWD from registered credits.
     * @param to Address to send claimed CLAWD.
     * @param amount Amount to claim (must be ≤ serverClaimable).
     */
    function claimServer(address to, uint256 amount) external onlyOwner {
        if (amount == 0) revert APICredits__ZeroAmount();
        if (amount > serverClaimable) revert APICredits__InsufficientStake();

        serverClaimable -= amount;
        emit ServerClaimed(to, amount);

        clawdToken.safeTransfer(to, amount);
    }

    // ─── View Functions ───────────────────────────────────────

    function getTreeData()
        external
        view
        returns (uint256 size, uint256 depth, uint256 root)
    {
        if (s_tree.size == 0) revert APICredits__EmptyTree();
        size = s_tree.size;
        depth = s_tree.depth;
        root = s_tree.root();
    }

    function isCommitmentUsed(uint256 _commitment) external view returns (bool) {
        return s_commitmentUsed[_commitment];
    }

    function getVerifier() external view returns (address) {
        return address(i_verifier);
    }
}
