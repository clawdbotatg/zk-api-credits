// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";
import {IWETH} from "./interfaces/IWETH.sol";

interface IAPICredits {
    function stakeAndRegister(uint256 amount, uint256[] calldata commitments) external;
    function paymentToken() external view returns (IERC20);
    function pricePerCredit() external view returns (uint256);
}

interface ICLAWDPricing {
    function getCreditPriceInCLAWD() external view returns (uint256);
    function getOracleData() external view returns (
        uint256 clawdPerEth,
        uint256 ethUsd,
        uint256 pricePerCreditCLAWD,
        uint256 usdPerCredit,
        uint256 clawdUsd
    );
}

/**
 * @title CLAWDRouter
 * @notice Payment router for ZK API Credits.
 *
 * Accepts CLAWD directly, ETH, or USDC. Non-CLAWD payments are swapped to CLAWD
 * via Uniswap v3 before calling APICredits.stakeAndRegister().
 *
 * Uses CLAWDPricing for TWAP-based price discovery.
 */
contract CLAWDRouter is Ownable {
    using SafeERC20 for IERC20;

    // ─── Errors ───────────────────────────────────────────────
    error CLAWDRouter__ZeroCommitments();
    error CLAWDRouter__InsufficientOutput();
    error CLAWDRouter__ETHTransferFailed();
    error CLAWDRouter__NothingToRefund();

    // ─── Immutables ───────────────────────────────────────────
    IAPICredits public immutable apiCredits;
    ICLAWDPricing public immutable pricing;
    IERC20 public immutable clawdToken;
    IERC20 public immutable usdc;
    IWETH public immutable weth;
    ISwapRouter public immutable swapRouter;

    // ─── Constants ────────────────────────────────────────────
    uint24 public constant CLAWD_WETH_FEE = 10000; // 1% fee tier
    uint24 public constant USDC_WETH_FEE = 500;    // 0.05% fee tier (standard)

    // ─── Events ───────────────────────────────────────────────
    event CreditsPurchasedWithCLAWD(
        address indexed buyer,
        uint256 numCredits,
        uint256 clawdSpent
    );
    event CreditsPurchasedWithETH(
        address indexed buyer,
        uint256 numCredits,
        uint256 ethSpent,
        uint256 clawdAcquired
    );
    event CreditsPurchasedWithUSDC(
        address indexed buyer,
        uint256 numCredits,
        uint256 usdcSpent,
        uint256 clawdAcquired
    );

    // ─── Constructor ──────────────────────────────────────────
    constructor(
        address _apiCredits,
        address _pricing,
        address _clawdToken,
        address _usdc,
        address _weth,
        address _swapRouter,
        address _owner
    ) Ownable(_owner) {
        apiCredits = IAPICredits(_apiCredits);
        pricing = ICLAWDPricing(_pricing);
        clawdToken = IERC20(_clawdToken);
        usdc = IERC20(_usdc);
        weth = IWETH(_weth);
        swapRouter = ISwapRouter(_swapRouter);

        // Pre-approve APICredits to spend CLAWD from this contract
        IERC20(_clawdToken).approve(_apiCredits, type(uint256).max);
    }

    // ─── Buy with CLAWD ───────────────────────────────────────

    /**
     * @notice Buy credits by paying CLAWD directly.
     * @param commitments ZK commitments (one per credit)
     * @param maxCLAWD Maximum CLAWD willing to spend (slippage protection)
     */
    function buyWithCLAWD(
        uint256[] calldata commitments,
        uint256 maxCLAWD
    ) external {
        if (commitments.length == 0) revert CLAWDRouter__ZeroCommitments();

        uint256 totalCLAWD = apiCredits.pricePerCredit() * commitments.length;
        if (maxCLAWD < totalCLAWD) revert CLAWDRouter__InsufficientOutput();

        // Pull CLAWD from user
        clawdToken.safeTransferFrom(msg.sender, address(this), totalCLAWD);

        // Approve APICredits to pull CLAWD, then register
        clawdToken.approve(address(apiCredits), totalCLAWD);
        apiCredits.stakeAndRegister(totalCLAWD, commitments);

        emit CreditsPurchasedWithCLAWD(msg.sender, commitments.length, totalCLAWD);
    }

    // ─── Buy with ETH ─────────────────────────────────────────

    /**
     * @notice Buy credits by paying ETH. Swaps ETH → WETH → CLAWD via Uniswap.
     * @param commitments ZK commitments (one per credit)
     * @param minCLAWDOut Minimum CLAWD to receive from swap (slippage protection)
     */
    function buyWithETH(
        uint256[] calldata commitments,
        uint256 minCLAWDOut
    ) external payable {
        if (commitments.length == 0) revert CLAWDRouter__ZeroCommitments();

        uint256 totalCLAWD = apiCredits.pricePerCredit() * commitments.length;

        // Wrap ETH → WETH, then swap WETH → CLAWD
        IWETH(address(weth)).deposit{value: msg.value}();
        IERC20(address(weth)).approve(address(swapRouter), msg.value);
        uint256 clawdReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(clawdToken),
                fee: CLAWD_WETH_FEE,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minCLAWDOut,
                sqrtPriceLimitX96: 0
            })
        );

        if (clawdReceived < totalCLAWD) revert CLAWDRouter__InsufficientOutput();

        // Approve APICredits to pull CLAWD from this router, then register
        clawdToken.approve(address(apiCredits), totalCLAWD);
        apiCredits.stakeAndRegister(totalCLAWD, commitments);

        // Refund excess CLAWD to buyer
        uint256 excess = clawdReceived - totalCLAWD;
        if (excess > 0) {
            clawdToken.safeTransfer(msg.sender, excess);
        }

        emit CreditsPurchasedWithETH(msg.sender, commitments.length, msg.value, clawdReceived);
    }

    // ─── Buy with USDC ────────────────────────────────────────

    /**
     * @notice Buy credits by paying USDC. Swaps USDC → WETH → CLAWD via Uniswap.
     * @param commitments ZK commitments (one per credit)
     * @param usdcAmount Amount of USDC to spend (6 decimals)
     * @param minCLAWDOut Minimum CLAWD to receive from swap (slippage protection)
     */
    function buyWithUSDC(
        uint256[] calldata commitments,
        uint256 usdcAmount,
        uint256 minCLAWDOut
    ) external {
        if (commitments.length == 0) revert CLAWDRouter__ZeroCommitments();

        uint256 totalCLAWD = apiCredits.pricePerCredit() * commitments.length;

        // Pull USDC from user
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Approve router to spend USDC
        usdc.approve(address(swapRouter), usdcAmount);

        // Swap USDC → WETH (0.05% pool) → CLAWD (1% pool) via two-hop
        // For simplicity, use two exactInputSingle calls
        // Step 1: USDC → WETH
        uint256 wethReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(usdc),
                tokenOut: address(weth),
                fee: USDC_WETH_FEE,
                recipient: address(this),
                amountIn: usdcAmount,
                amountOutMinimum: 0, // protected by final minCLAWDOut
                sqrtPriceLimitX96: 0
            })
        );

        // Step 2: WETH → CLAWD
        IERC20(address(weth)).approve(address(swapRouter), wethReceived);
        uint256 clawdReceived = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(clawdToken),
                fee: CLAWD_WETH_FEE,
                recipient: address(this),
                amountIn: wethReceived,
                amountOutMinimum: minCLAWDOut,
                sqrtPriceLimitX96: 0
            })
        );

        if (clawdReceived < totalCLAWD) revert CLAWDRouter__InsufficientOutput();

        // Approve APICredits to pull CLAWD from this router, then register
        clawdToken.approve(address(apiCredits), totalCLAWD);
        apiCredits.stakeAndRegister(totalCLAWD, commitments);

        // Refund excess CLAWD to buyer
        uint256 excess = clawdReceived - totalCLAWD;
        if (excess > 0) {
            clawdToken.safeTransfer(msg.sender, excess);
        }

        emit CreditsPurchasedWithUSDC(msg.sender, commitments.length, usdcAmount, clawdReceived);
    }

    // ─── View Helpers ─────────────────────────────────────────

    /**
     * @notice Get the CLAWD amount needed for N credits (from TWAP oracle).
     * @dev This is a convenience view — the actual amount charged uses
     *      apiCredits.pricePerCredit() which is the static contract rate.
     *      The TWAP price from CLAWDPricing is for frontend USD display.
     */
    function quoteCredits(uint256 numCredits)
        external
        view
        returns (uint256 clawdNeeded, uint256 usdEquivalent)
    {
        clawdNeeded = apiCredits.pricePerCredit() * numCredits;
        // USD equivalent from pricing oracle
        (,,, uint256 usdPerCredit,) = pricing.getOracleData();
        usdEquivalent = usdPerCredit * numCredits;
    }

    // ─── Owner Functions ──────────────────────────────────────

    /**
     * @notice Rescue stuck tokens. Owner only.
     */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Accept ETH (for Uniswap refunds).
     */
    receive() external payable {}
}
