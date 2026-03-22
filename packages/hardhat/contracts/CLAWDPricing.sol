// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {FullMath} from "./libraries/FullMath.sol";

/**
 * @title CLAWDPricing
 * @notice Standalone TWAP oracle for CLAWD token pricing.
 *
 * Reads the WETH/CLAWD Uniswap v3 pool TWAP to determine CLAWD/ETH price,
 * then uses Chainlink ETH/USD (with owner-set fallback) to derive CLAWD/USD.
 *
 * Used by CLAWDRouter to compute how much CLAWD is needed per API credit.
 */
contract CLAWDPricing is Ownable {
    // ─── Errors ───────────────────────────────────────────────
    error CLAWDPricing__ZeroValue();
    error CLAWDPricing__ZeroPriceOracle();

    // ─── Constants ────────────────────────────────────────────
    uint32 public constant TWAP_WINDOW = 1800; // 30-minute TWAP

    // ─── Immutables ───────────────────────────────────────────
    IUniswapV3Pool public immutable uniswapPool;
    AggregatorV3Interface public immutable chainlinkEthUsd;

    // ─── State ────────────────────────────────────────────────
    /// @notice Target USD price per credit (18 decimals). Default: $0.10
    uint256 public creditPriceUSD = 0.05e18;

    /// @notice Fallback ETH/USD price if Chainlink is stale/unavailable (18 decimals)
    uint256 public ethUsdPrice = 1900e18;

    /// @notice Maximum age for Chainlink data before falling back (seconds)
    uint256 public chainlinkStalenessThreshold = 3600;

    // ─── Events ───────────────────────────────────────────────
    event CreditPriceUSDUpdated(uint256 oldPrice, uint256 newPrice);
    event EthUsdPriceUpdated(uint256 oldPrice, uint256 newPrice);

    // ─── Constructor ──────────────────────────────────────────
    constructor(
        address _uniswapPool,
        address _chainlinkEthUsd,
        address _owner
    ) Ownable(_owner) {
        uniswapPool = IUniswapV3Pool(_uniswapPool);
        chainlinkEthUsd = AggregatorV3Interface(_chainlinkEthUsd);
    }

    // ─── Oracle Functions ─────────────────────────────────────

    /**
     * @notice Get the ETH/USD price. Tries Chainlink first, falls back to owner-set price.
     * @return ETH price in USD with 18 decimals
     */
    function getEthUsdPrice() public view returns (uint256) {
        try chainlinkEthUsd.latestRoundData() returns (
            uint80, int256 price, uint256, uint256 updatedAt, uint80
        ) {
            if (price > 0 && block.timestamp - updatedAt < chainlinkStalenessThreshold) {
                // Chainlink ETH/USD has 8 decimals, scale to 18
                return uint256(price) * 1e10;
            }
        } catch {}
        return ethUsdPrice;
    }

    /**
     * @notice Get the TWAP tick from the Uniswap v3 pool over TWAP_WINDOW seconds.
     * @return arithmeticMeanTick The time-weighted average tick
     */
    function _getTwapTick() internal view returns (int24 arithmeticMeanTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = uniswapPool.observe(secondsAgos);

        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];

        arithmeticMeanTick = int24(tickCumulativesDelta / int56(int32(TWAP_WINDOW)));
        // Always round to negative infinity
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(int32(TWAP_WINDOW)) != 0)) {
            arithmeticMeanTick--;
        }
    }

    /**
     * @notice Get CLAWD per ETH from the 30-minute TWAP.
     *
     * Pool: WETH (token0) / CLAWD (token1)
     * sqrtPriceX96 = sqrt(CLAWD/WETH) * 2^96
     * price = sqrtPriceX96^2 / 2^192 = CLAWD per WETH (both 18 dec)
     *
     * @return clawdPerEth CLAWD per ETH with 18 decimal precision
     */
    function getClawdPerEth() public view returns (uint256 clawdPerEth) {
        int24 twapTick = _getTwapTick();
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(twapTick);

        // Split: sqrtRatioX96^2 / 2^192 scaled to 18 decimals
        // step1 = sqrtRatioX96^2 / 2^64
        uint256 ratioX128 = FullMath.mulDiv(
            uint256(sqrtRatioX96),
            uint256(sqrtRatioX96),
            1 << 64
        );
        // clawdPerEth = ratioX128 * 1e18 / 2^128
        clawdPerEth = FullMath.mulDiv(ratioX128, 1e18, 1 << 128);
    }

    /**
     * @notice Get CLAWD price in USD.
     * @return clawdUsd CLAWD price in USD with 18 decimal precision
     */
    function getClawdUsdPrice() public view returns (uint256 clawdUsd) {
        uint256 clawdPerEth = getClawdPerEth();
        uint256 ethUsd = getEthUsdPrice();
        if (clawdPerEth == 0) revert CLAWDPricing__ZeroPriceOracle();
        // clawdUsd = ethUsd / clawdPerEth (both 18 dec → result is 18 dec)
        clawdUsd = FullMath.mulDiv(ethUsd, 1e18, clawdPerEth);
    }

    /**
     * @notice Get the credit price in CLAWD tokens.
     *
     * priceInCLAWD = creditPriceUSD / clawdUsdPrice
     *              = creditPriceUSD * clawdPerEth / ethUsdPrice
     *
     * @return priceInCLAWD Amount of CLAWD (18 dec) required per credit
     */
    function getCreditPriceInCLAWD() public view returns (uint256 priceInCLAWD) {
        uint256 clawdPerEth = getClawdPerEth();
        uint256 ethUsd = getEthUsdPrice();

        if (clawdPerEth == 0 || ethUsd == 0) revert CLAWDPricing__ZeroPriceOracle();

        priceInCLAWD = FullMath.mulDiv(creditPriceUSD, clawdPerEth, ethUsd);
    }

    // ─── Owner Functions ──────────────────────────────────────

    /**
     * @notice Set the target USD price per credit. Owner only.
     * @param newPriceUSD New price in USD with 18 decimals (e.g. 0.10e18 = $0.10)
     */
    function setCreditPriceUSD(uint256 newPriceUSD) external onlyOwner {
        if (newPriceUSD == 0) revert CLAWDPricing__ZeroValue();
        emit CreditPriceUSDUpdated(creditPriceUSD, newPriceUSD);
        creditPriceUSD = newPriceUSD;
    }

    /**
     * @notice Set the fallback ETH/USD price (used when Chainlink is stale). Owner only.
     * @param newPrice ETH price in USD with 18 decimals
     */
    function setEthUsdPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert CLAWDPricing__ZeroValue();
        emit EthUsdPriceUpdated(ethUsdPrice, newPrice);
        ethUsdPrice = newPrice;
    }

    /**
     * @notice Set the Chainlink staleness threshold. Owner only.
     * @param newThreshold Seconds before Chainlink data is considered stale
     */
    function setChainlinkStalenessThreshold(uint256 newThreshold) external onlyOwner {
        chainlinkStalenessThreshold = newThreshold;
    }

    // ─── View Helpers ─────────────────────────────────────────

    /**
     * @notice Returns all oracle data in one call for frontend display.
     */
    function getOracleData()
        external
        view
        returns (
            uint256 clawdPerEth,
            uint256 ethUsd,
            uint256 pricePerCreditCLAWD,
            uint256 usdPerCredit,
            uint256 clawdUsd
        )
    {
        clawdPerEth = getClawdPerEth();
        ethUsd = getEthUsdPrice();
        pricePerCreditCLAWD = getCreditPriceInCLAWD();
        usdPerCredit = creditPriceUSD;
        clawdUsd = getClawdUsdPrice();
    }
}
