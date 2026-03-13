import { expect } from "chai";
import { ethers } from "hardhat";
import { APICredits, UltraVerifier, MockERC20 } from "../typechain-types";

describe("APICredits", function () {
  let apiCredits: APICredits;
  let verifier: UltraVerifier;
  let mockClawd: MockERC20;
  let owner: any;
  let user1: any;
  let user2: any;

  const PRICE_PER_CREDIT = ethers.parseEther("1000"); // 1000 CLAWD
  const STAKE_AMOUNT = ethers.parseEther("10000"); // 10000 CLAWD

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20 (mCLAWD)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockClawd = await MockERC20.deploy();

    // Mint CLAWD to users
    await mockClawd.mint(user1.address, ethers.parseEther("100000"));
    await mockClawd.mint(user2.address, ethers.parseEther("100000"));

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
    apiCredits = await APICreditsFactory.deploy(
      await mockClawd.getAddress(),
      owner.address,
      await verifier.getAddress()
    );
  });

  describe("stake()", function () {
    it("should accept CLAWD and update stakedBalance", async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT);
    });

    it("should emit Staked event", async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await expect(apiCredits.connect(user1).stake(STAKE_AMOUNT))
        .to.emit(apiCredits, "Staked")
        .withArgs(user1.address, STAKE_AMOUNT, STAKE_AMOUNT);
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).stake(0))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });

    it("should revert without approval", async function () {
      await expect(apiCredits.connect(user1).stake(STAKE_AMOUNT))
        .to.be.reverted;
    });

    it("should accumulate multiple stakes", async function () {
      const half = STAKE_AMOUNT / 2n;
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(half);
      await apiCredits.connect(user1).stake(half);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT);
    });
  });

  describe("unstake()", function () {
    beforeEach(async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
    });

    it("should withdraw CLAWD and update balance", async function () {
      const half = STAKE_AMOUNT / 2n;
      await apiCredits.connect(user1).unstake(half);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(half);
      // Check user got the tokens back
      expect(await mockClawd.balanceOf(user1.address)).to.equal(
        ethers.parseEther("100000") - STAKE_AMOUNT + half
      );
    });

    it("should emit Unstaked event", async function () {
      const half = STAKE_AMOUNT / 2n;
      await expect(apiCredits.connect(user1).unstake(half))
        .to.emit(apiCredits, "Unstaked")
        .withArgs(user1.address, half, half);
    });

    it("should revert if insufficient balance", async function () {
      await expect(apiCredits.connect(user1).unstake(STAKE_AMOUNT * 2n))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).unstake(0))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });
  });

  describe("register()", function () {
    beforeEach(async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
    });

    it("should register a commitment and move CLAWD to serverClaimable", async function () {
      const commitment = 12345n;
      await apiCredits.connect(user1).register(commitment);

      expect(await apiCredits.stakedBalance(user1.address)).to.equal(
        STAKE_AMOUNT - PRICE_PER_CREDIT
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
      await apiCredits.connect(user1).unstake(STAKE_AMOUNT - ethers.parseEther("500"));
      await expect(apiCredits.connect(user1).register(999n))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });

    it("should register multiple commitments sequentially", async function () {
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);
      await apiCredits.connect(user1).register(333n);

      expect(await apiCredits.serverClaimable()).to.equal(PRICE_PER_CREDIT * 3n);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(
        STAKE_AMOUNT - PRICE_PER_CREDIT * 3n
      );
    });
  });

  describe("registerBatch()", function () {
    beforeEach(async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
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
      // Try to register 11 commitments (11000 CLAWD) with only 10000 staked
      const commitments = Array.from({ length: 11 }, (_, i) => BigInt(i + 1000));
      await expect(apiCredits.connect(user1).registerBatch(commitments))
        .to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });
  });

  describe("claimServer()", function () {
    beforeEach(async function () {
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
      await apiCredits.connect(user1).register(12345n);
    });

    it("should allow owner to claim server funds in CLAWD", async function () {
      const balanceBefore = await mockClawd.balanceOf(owner.address);
      await apiCredits.connect(owner).claimServer(owner.address, PRICE_PER_CREDIT);
      const balanceAfter = await mockClawd.balanceOf(owner.address);

      expect(balanceAfter - balanceBefore).to.equal(PRICE_PER_CREDIT);
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
      await mockClawd.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);

      const [size, depth] = await apiCredits.getTreeData();
      expect(size).to.equal(2);
      expect(depth).to.equal(1);
    });
  });

  describe("clawdToken()", function () {
    it("should return the correct CLAWD token address", async function () {
      expect(await apiCredits.clawdToken()).to.equal(await mockClawd.getAddress());
    });
  });
});
