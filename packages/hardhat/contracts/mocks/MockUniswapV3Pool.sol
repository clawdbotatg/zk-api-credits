// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockUniswapV3Pool
 * @notice Mock for local testing. Simulates a pool with ~38M CLAWD per ETH.
 */
contract MockUniswapV3Pool {
    // Tick for ~38M CLAWD/ETH ratio
    // ln(38_000_000) / ln(1.0001) ≈ 174_750
    int24 public mockTick = 174750;
    int56 public tickCumulative0;
    int56 public tickCumulative1;

    constructor() {
        // Set up tick cumulatives such that the 30-min average = mockTick
        // Assume observation at T-1800 and T-0
        tickCumulative0 = 0;
        tickCumulative1 = int56(mockTick) * 1800; // tick * seconds
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);

        for (uint256 i = 0; i < secondsAgos.length; i++) {
            if (secondsAgos[i] >= 1800) {
                tickCumulatives[i] = tickCumulative0;
            } else {
                tickCumulatives[i] = tickCumulative1;
            }
        }
    }

    function setMockTick(int24 newTick) external {
        mockTick = newTick;
        tickCumulative0 = 0;
        tickCumulative1 = int56(newTick) * 1800;
    }

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        tick = mockTick;
        sqrtPriceX96 = 0; // Not used by our TWAP
        observationIndex = 1;
        observationCardinality = 2;
        observationCardinalityNext = 2;
        feeProtocol = 0;
        unlocked = true;
    }
}
