import { expect } from "chai";
import { ethers } from "hardhat";
import { APICredits, MockERC20 } from "../typechain-types";

describe("APICredits", function () {
  let apiCredits: APICredits;
  let mockToken: MockERC20;
  let owner: any;
  let user1: any;
  let user2: any;

  const PRICE_PER_CREDIT = ethers.parseEther("1000"); // 1000 tokens per credit
  const STAKE_AMOUNT = ethers.parseEther("10000"); // 10000 tokens

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy();

    // Mint tokens to users
    await mockToken.mint(user1.address, ethers.parseEther("100000"));
    await mockToken.mint(user2.address, ethers.parseEther("100000"));

    // Deploy APICredits — token-agnostic, static price
    const APICreditsFactory = await ethers.getContractFactory("APICredits");
    apiCredits = await APICreditsFactory.deploy(
      await mockToken.getAddress(),
      PRICE_PER_CREDIT,
      owner.address,
      owner.address, // claimRecipient — use owner in tests
    );
  });

  describe("constructor", function () {
    it("should set paymentToken and pricePerCredit", async function () {
      expect(await apiCredits.paymentToken()).to.equal(await mockToken.getAddress());
      expect(await apiCredits.pricePerCredit()).to.equal(PRICE_PER_CREDIT);
    });
  });

  describe("stake()", function () {
    it("should accept tokens and update stakedBalance", async function () {
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT);
    });

    it("should emit Staked event", async function () {
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await expect(apiCredits.connect(user1).stake(STAKE_AMOUNT))
        .to.emit(apiCredits, "Staked")
        .withArgs(user1.address, STAKE_AMOUNT, STAKE_AMOUNT);
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).stake(0)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__ZeroAmount",
      );
    });

    it("should revert without approval", async function () {
      await expect(apiCredits.connect(user1).stake(STAKE_AMOUNT)).to.be.reverted;
    });

    it("should accumulate multiple stakes", async function () {
      const half = STAKE_AMOUNT / 2n;
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(half);
      await apiCredits.connect(user1).stake(half);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT);
    });
  });

  describe("unstake()", function () {
    beforeEach(async function () {
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
    });

    it("should withdraw tokens and update balance", async function () {
      const half = STAKE_AMOUNT / 2n;
      await apiCredits.connect(user1).unstake(half);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(half);
      expect(await mockToken.balanceOf(user1.address)).to.equal(ethers.parseEther("100000") - STAKE_AMOUNT + half);
    });

    it("should emit Unstaked event", async function () {
      const half = STAKE_AMOUNT / 2n;
      await expect(apiCredits.connect(user1).unstake(half))
        .to.emit(apiCredits, "Unstaked")
        .withArgs(user1.address, half, half);
    });

    it("should revert if insufficient balance", async function () {
      await expect(apiCredits.connect(user1).unstake(STAKE_AMOUNT * 2n)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__InsufficientStake",
      );
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(user1).unstake(0)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__ZeroAmount",
      );
    });
  });

  describe("register()", function () {
    beforeEach(async function () {
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
    });

    it("should register a commitment and auto-forward tokens to claimRecipient", async function () {
      const commitment = 12345n;
      const recipientBefore = await mockToken.balanceOf(owner.address); // owner is claimRecipient in tests
      await apiCredits.connect(user1).register(commitment);

      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT - PRICE_PER_CREDIT);
      expect(await apiCredits.serverClaimable()).to.equal(0); // never accumulates
      expect(await mockToken.balanceOf(owner.address)).to.equal(recipientBefore + PRICE_PER_CREDIT);
      expect(await apiCredits.isCommitmentUsed(commitment)).to.equal(true);
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
      await expect(apiCredits.connect(user1).register(commitment)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__CommitmentAlreadyUsed",
      );
    });

    it("should revert if insufficient stake", async function () {
      const unstakeAmount = STAKE_AMOUNT - ethers.parseEther("500");
      await apiCredits.connect(user1).unstake(unstakeAmount);
      await expect(apiCredits.connect(user1).register(999n)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__InsufficientStake",
      );
    });

    it("should register multiple commitments sequentially and forward all to claimRecipient", async function () {
      const recipientBefore = await mockToken.balanceOf(owner.address);
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);
      await apiCredits.connect(user1).register(333n);

      expect(await apiCredits.serverClaimable()).to.equal(0); // never accumulates
      expect(await mockToken.balanceOf(owner.address)).to.equal(recipientBefore + PRICE_PER_CREDIT * 3n);
      expect(await apiCredits.stakedBalance(user1.address)).to.equal(STAKE_AMOUNT - PRICE_PER_CREDIT * 3n);
    });

    it("should produce a valid root after insertions", async function () {
      await apiCredits.connect(user1).register(111n);
      const [size1, , root1] = await apiCredits.getTreeData();
      expect(size1).to.equal(1);
      expect(root1).to.not.equal(0);

      await apiCredits.connect(user1).register(222n);
      const [size2, , root2] = await apiCredits.getTreeData();
      expect(size2).to.equal(2);
      expect(root2).to.not.equal(root1);
    });
  });

  describe("stakeAndRegister()", function () {
    it("should transfer and register in one tx, forwarding tokens directly to claimRecipient", async function () {
      const amount = PRICE_PER_CREDIT * 3n;
      const commitments = [111n, 222n, 333n];
      const recipientBefore = await mockToken.balanceOf(owner.address);
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), amount);
      await apiCredits.connect(user1).stakeAndRegister(amount, commitments);

      expect(await apiCredits.serverClaimable()).to.equal(0); // never accumulates
      expect(await mockToken.balanceOf(owner.address)).to.equal(recipientBefore + amount);
      expect(await apiCredits.treeSize()).to.equal(3);
      expect(await apiCredits.isCommitmentUsed(111n)).to.equal(true);
      expect(await apiCredits.isCommitmentUsed(222n)).to.equal(true);
      expect(await apiCredits.isCommitmentUsed(333n)).to.equal(true);
    });

    it("should revert on commitment count mismatch", async function () {
      const amount = PRICE_PER_CREDIT * 2n;
      const commitments = [111n, 222n, 333n]; // 3 commitments but amount covers only 2
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), amount);
      await expect(
        apiCredits.connect(user1).stakeAndRegister(amount, commitments),
      ).to.be.revertedWith("commitment count mismatch");
    });

    it("should revert on zero amount", async function () {
      await expect(
        apiCredits.connect(user1).stakeAndRegister(0, [111n]),
      ).to.be.revertedWithCustomError(apiCredits, "APICredits__ZeroAmount");
    });
  });

  describe("claimServer()", function () {
    // claimServer is vestigial — serverClaimable is always 0 with auto-forward
    it("should revert if not owner", async function () {
      await expect(
        apiCredits.connect(user1).claimServer(user1.address, PRICE_PER_CREDIT),
      ).to.be.revertedWithCustomError(apiCredits, "OwnableUnauthorizedAccount");
    });

    it("should revert on zero amount", async function () {
      await expect(apiCredits.connect(owner).claimServer(owner.address, 0)).to.be.revertedWithCustomError(
        apiCredits,
        "APICredits__ZeroAmount",
      );
    });

    it("should revert with InsufficientStake since serverClaimable is always 0", async function () {
      await expect(
        apiCredits.connect(owner).claimServer(owner.address, PRICE_PER_CREDIT),
      ).to.be.revertedWithCustomError(apiCredits, "APICredits__InsufficientStake");
    });
  });

  describe("getTreeData()", function () {
    it("should revert when tree is empty", async function () {
      await expect(apiCredits.getTreeData()).to.be.revertedWithCustomError(apiCredits, "APICredits__EmptyTree");
    });

    it("should return correct data after insertions", async function () {
      await mockToken.connect(user1).approve(await apiCredits.getAddress(), STAKE_AMOUNT);
      await apiCredits.connect(user1).stake(STAKE_AMOUNT);
      await apiCredits.connect(user1).register(111n);
      await apiCredits.connect(user1).register(222n);

      const [size, depth] = await apiCredits.getTreeData();
      expect(size).to.equal(2);
      expect(depth).to.equal(16); // imt.sol uses fixed depth set at init
    });
  });

  describe("zeros precomputation", function () {
    it("should have zeros[0] = 0", async function () {
      expect(await apiCredits.getZeroHash(0)).to.equal(0);
    });

    it("should have non-zero values for zeros[1] through zeros[15]", async function () {
      for (let i = 1; i < 16; i++) {
        const z = await apiCredits.getZeroHash(i);
        expect(z).to.not.equal(0);
      }
    });
  });
});
