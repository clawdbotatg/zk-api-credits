// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockChainlinkAggregator
 * @notice Mock Chainlink ETH/USD price feed for local testing.
 */
contract MockChainlinkAggregator {
    int256 public mockPrice = 190000000000; // $1900 with 8 decimals
    uint256 public mockUpdatedAt;

    constructor() {
        mockUpdatedAt = block.timestamp;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (1, mockPrice, block.timestamp, mockUpdatedAt, 1);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setMockPrice(int256 newPrice) external {
        mockPrice = newPrice;
        mockUpdatedAt = block.timestamp;
    }
}
