import { expect } from "chai";
import { ethers } from "hardhat";
import { CLAWDPricing, MockUniswapV3Pool, MockChainlinkAggregator } from "../typechain-types";

describe("CLAWDPricing", function () {
  let pricing: CLAWDPricing;
  let mockPool: MockUniswapV3Pool;
  let mockChainlink: MockChainlinkAggregator;
  let owner: any;
  let user1: any;

  beforeEach(async function () {
    [owner, user1] = await ethers.getSigners();

    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    mockPool = await MockPool.deploy();

    const MockChainlink = await ethers.getContractFactory("MockChainlinkAggregator");
    mockChainlink = await MockChainlink.deploy();

    const PricingFactory = await ethers.getContractFactory("CLAWDPricing");
    pricing = await PricingFactory.deploy(
      await mockPool.getAddress(),
      await mockChainlink.getAddress(),
      owner.address,
    );
  });

  describe("getEthUsdPrice()", function () {
    it("should return Chainlink price when fresh", async function () {
      const price = await pricing.getEthUsdPrice();
      // Mock returns $1900 with 8 dec → scaled to 18 dec = 1900e18
      expect(price).to.equal(ethers.parseEther("1900"));
    });

    it("should fall back to owner-set price when Chainlink is stale", async function () {
      await pricing.connect(owner).setChainlinkStalenessThreshold(0);
      const price = await pricing.getEthUsdPrice();
      expect(price).to.equal(ethers.parseEther("1900")); // fallback default is also 1900
    });

    it("should use updated fallback price", async function () {
      await pricing.connect(owner).setChainlinkStalenessThreshold(0);
      await pricing.connect(owner).setEthUsdPrice(ethers.parseEther("2500"));
      const price = await pricing.getEthUsdPrice();
      expect(price).to.equal(ethers.parseEther("2500"));
    });
  });

  describe("getClawdPerEth()", function () {
    it("should return a non-zero value", async function () {
      const clawdPerEth = await pricing.getClawdPerEth();
      expect(clawdPerEth).to.be.gt(0);
    });

    it("should return a value in the right ballpark (~38M CLAWD per ETH)", async function () {
      const clawdPerEth = await pricing.getClawdPerEth();
      const clawdPerEthNum = Number(ethers.formatEther(clawdPerEth));
      // Mock tick 174750 should give roughly 38M CLAWD per ETH
      // Allow wide range since tick-to-price math is exponential
      expect(clawdPerEthNum).to.be.gt(1_000_000);   // at least 1M
      expect(clawdPerEthNum).to.be.lt(500_000_000); // at most 500M
    });
  });

  describe("getCreditPriceInCLAWD()", function () {
    it("should return a non-zero credit price", async function () {
      const price = await pricing.getCreditPriceInCLAWD();
      expect(price).to.be.gt(0);
    });

    it("should increase when creditPriceUSD increases", async function () {
      const priceBefore = await pricing.getCreditPriceInCLAWD();
      await pricing.connect(owner).setCreditPriceUSD(ethers.parseEther("0.20")); // double
      const priceAfter = await pricing.getCreditPriceInCLAWD();
      expect(priceAfter).to.be.closeTo(priceBefore * 2n, priceBefore / 50n);
    });

    it("should decrease when ETH price increases (CLAWD worth more USD)", async function () {
      await pricing.connect(owner).setChainlinkStalenessThreshold(0);
      const priceBefore = await pricing.getCreditPriceInCLAWD();
      await pricing.connect(owner).setEthUsdPrice(ethers.parseEther("3800")); // double ETH
      const priceAfter = await pricing.getCreditPriceInCLAWD();
      // Higher ETH → CLAWD worth more USD → fewer CLAWD per credit
      expect(priceAfter).to.be.closeTo(priceBefore / 2n, priceBefore / 50n);
    });
  });

  describe("getOracleData()", function () {
    it("should return all oracle values", async function () {
      const [clawdPerEth, ethUsd, pricePerCredit, usdPerCredit, clawdUsd] = await pricing.getOracleData();
      expect(clawdPerEth).to.be.gt(0);
      expect(ethUsd).to.equal(ethers.parseEther("1900"));
      expect(pricePerCredit).to.be.gt(0);
      expect(usdPerCredit).to.equal(ethers.parseEther("0.1"));
      expect(clawdUsd).to.be.gt(0);
    });
  });

  describe("owner functions", function () {
    it("should revert setCreditPriceUSD from non-owner", async function () {
      await expect(
        pricing.connect(user1).setCreditPriceUSD(ethers.parseEther("1")),
      ).to.be.revertedWithCustomError(pricing, "OwnableUnauthorizedAccount");
    });

    it("should revert setEthUsdPrice from non-owner", async function () {
      await expect(
        pricing.connect(user1).setEthUsdPrice(ethers.parseEther("2000")),
      ).to.be.revertedWithCustomError(pricing, "OwnableUnauthorizedAccount");
    });

    it("should revert on zero creditPriceUSD", async function () {
      await expect(pricing.connect(owner).setCreditPriceUSD(0)).to.be.revertedWithCustomError(
        pricing,
        "CLAWDPricing__ZeroValue",
      );
    });

    it("should revert on zero ethUsdPrice", async function () {
      await expect(pricing.connect(owner).setEthUsdPrice(0)).to.be.revertedWithCustomError(
        pricing,
        "CLAWDPricing__ZeroValue",
      );
    });
  });
});
