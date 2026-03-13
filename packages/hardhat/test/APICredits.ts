import { expect } from "chai";
import { ethers } from "hardhat";
import { APICredits, UltraVerifier } from "../typechain-types";

describe("APICredits", function () {
  let apiCredits: APICredits;
  let verifier: UltraVerifier;
  let owner: any;
  let user1: any;
  let user2: any;

  const PRICE_PER_CREDIT = ethers.parseEther("0.001");

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy PoseidonT3
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();

    // Deploy LeanIMT with PoseidonT3 library
    const LeanIMT = await ethers.getContractFactory("LeanIMT", {
      libraries: { PoseidonT3: await poseidonT3.getAddress() },
    });
    const leanIMT = await LeanIMT.deploy();

    // Deploy Verifier
    const Verifier = await ethers.getContractFactory("UltraVerifier");
    verifier = await Verifier.deploy();

    // Deploy APICredits
    const APICreditsFactory = await ethers.getContractFactory("APICredits", {
      libraries: { LeanIMT: await leanIMT.getAddress() },
    });
    apiCredits = await APICreditsFactory.deploy(owner.address, await verifier.getAddress());
  });

  describe("stake()", function () {
    it("should accept ETH and update stakedBalance", async function () {
      const amount = ethers.parseEther("0.01");
      await apiCredits.connect(user1).stake({ value: amount });
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(amount);
    });

    it("should emit Staked event", async function () {
      const amount = ethers.parseEther("0.01");
      await expect(apiCredits.connect(user1).stake({ value: amount }))
        .to.emit(apiCredits, "Staked")
        .withArgs(user1.address, amount, amount);
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).stake({ value: 0 }))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });

    it("should accumulate multiple stakes", async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.005") });
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.005") });
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(ethers.parseEther("0.01"));
    });
  });

  describe("unstake()", function () {
    beforeEach(async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.01") });
    });

    it("should withdraw ETH and update balance", async function () {
      const amount = ethers.parseEther("0.005");
      await apiCredits.connect(user1).unstake(amount);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(ethers.parseEther("0.005"));
    });

    it("should emit Unstaked event", async function () {
      const amount = ethers.parseEther("0.005");
      await expect(apiCredits.connect(user1).unstake(amount))
        .to.emit(apiCredits, "Unstaked")
        .withArgs(user1.address, amount, ethers.parseEther("0.005"));
    });

    it("should revert if insufficient balance", async function () {
      await expect(apiCredits.connect(user1).unstake(ethers.parseEther("0.02")))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).unstake(0))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });
  });

  describe("register()", function () {
    beforeEach(async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.01") });
    });

    it("should register a commitment and move ETH to serverClaimable", async function () {
      const commitment = 12345n;
      await apiCredits.connect(user1).register(commitment);

      expect(await apiCredits.stakedBalance(user1.address)).to.equal(
        ethers.parseEther("0.01") - PRICE_PER_CREDIT
      );
      expect(await apiCredits.serverClaimable()).to.equal(PRICE_PER_CREDIT);
      expect(await apiCredits.isCommitmentUsed(commitment)).to.be.true;
    });

    it("should emit CreditRegistered and NewLeaf events", async function () {
      const commitment = 12345n;
      await expect(apiCredits.connect(user1).register(commitment))
        .to.emit(apiCredits, "NewLeaf")
        .withArgs(0, commitment);
    });

    it("should revert on duplicate commitment", async function () {
      const commitment = 12345n;
      await apiCredits.connect(user1).register(commitment);
      await expect(apiCredits.connect(user1).register(commitment))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__CommitmentAlreadyUsed");
    });

    it("should revert if insufficient stake", async function () {
      // Unstake most of the balance
      await apiCredits.connect(user1).unstake(ethers.parseEther("0.0095"));
      await expect(apiCredits.connect(user1).register(999n))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });

    it("should register multiple commitments sequentially", async function () {
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);
      await apiCredits.connect(user1).register(333n);

      expect(await apiCredits.serverClaimable()).to.equal(PRICE_PER_CREDIT * 3n);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(
        ethers.parseEther("0.01") - PRICE_PER_CREDIT * 3n
      );
    });
  });

  describe("registerBatch()", function () {
    beforeEach(async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.01") });
    });

    it("should register multiple commitments in one tx", async function () {
      const commitments = [100n, 200n, 300n];
      await apiCredits.connect(user1).registerBatch(commitments);

      expect(await apiCredits.serverClaimable()).to.equal(PRICE_PER_CREDIT * 3n);
      for (const c of commitments) {
        expect(await apiCredits.isCommitmentUsed(c)).to.be.true;
      }
    });

    it("should revert if total cost exceeds balance", async function () {
      // Try to register 11 commitments (0.011 ETH) with only 0.01 staked
      const commitments = Array.from({ length: 11 }, (_, i) => BigInt(i + 1000));
      await expect(apiCredits.connect(user1).registerBatch(commitments))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });
  });

  describe("claimServer()", function () {
    beforeEach(async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.01") });
      await apiCredits.connect(user1).register(12345n);
    });

    it("should allow owner to claim server funds", async function () {
      const balanceBefore = await ethers.provider.getBalance(owner.address);
      const tx = await apiCredits.connect(owner).claimServer(owner.address, PRICE_PER_CREDIT);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(owner.address);

      expect(balanceAfter).to.equal(balanceBefore + PRICE_PER_CREDIT - gasUsed);
      expect(await apiCredits.serverClaimable()).to.equal(0);
    });

    it("should revert if not owner", async function () {
      await expect(apiCredits.connect(user1).claimServer(user1.address, PRICE_PER_CREDIT))
        .to.be.revertedWithCustomError(apiCredits, "OwnableUnauthorizedAccount");
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(owner).claimServer(owner.address, 0))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });
  });

  describe("getTreeData()", function () {
    it("should revert when tree is empty", async function () {
      await expect(apiCredits.getTreeData())
        .to.be.revertedWithCustomError(apiCredits, "APICredits__EmptyTree");
    });

    it("should return correct data after insertions", async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.01") });
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);

      const [size, depth, root] = await apiCredits.getTreeData();
      expect(size).to.equal(2);
      expect(depth).to.be.gte(1);
      expect(root).to.not.equal(0);
    });
  });

  describe("Economic model invariants", function () {
    it("registered ETH cannot be withdrawn by user", async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.003") });
      await apiCredits.connect(user1).register(1n);
      await apiCredits.connect(user1).register(2n);

      // User should only have 0.001 ETH withdrawable (0.003 - 0.002 registered)
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(PRICE_PER_CREDIT);

      // Trying to unstake more should fail
      await expect(apiCredits.connect(user1).unstake(ethers.parseEther("0.002")))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");

      // But can unstake the remaining
      await apiCredits.connect(user1).unstake(PRICE_PER_CREDIT);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(0);
    });

    it("contract balance equals stakedBalance + serverClaimable", async function () {
      await apiCredits.connect(user1).stake({ value: ethers.parseEther("0.005") });
      await apiCredits.connect(user2).stake({ value: ethers.parseEther("0.003") });
      await apiCredits.connect(user1).register(1n);
      await apiCredits.connect(user2).register(2n);

      const contractBalance = await ethers.provider.getBalance(await apiCredits.getAddress());
      const staked1 = await apiCredits.stakedBalance(user1.address);
      const staked2 = await apiCredits.stakedBalance(user2.address);
      const serverClaimable = await apiCredits.serverClaimable();

      expect(contractBalance).to.equal(staked1 + staked2 + serverClaimable);
    });
  });
});
