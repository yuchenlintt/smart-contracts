import { Wallet } from 'ethers'
import {
  MockTrueCurrency,
  TrueCreditAgency,
  TrueCreditAgency__factory,
  TrueFiCreditOracle,
  TrueFiCreditOracle__factory,
  TrueFiPool2,
} from 'contracts'
import { beforeEachWithFixture, parseEth, setupTruefi2 } from 'utils'
import { expect } from 'chai'
import { AddressZero, MaxUint256 } from '@ethersproject/constants'

describe('TrueCreditAgency', () => {
  let owner: Wallet
  let borrower: Wallet
  let creditAgency: TrueCreditAgency
  let tusd: MockTrueCurrency
  let tusdPool: TrueFiPool2
  let creditOracle: TrueFiCreditOracle

  beforeEachWithFixture(async (wallets) => {
    [owner, borrower] = wallets

    ;({
      standardToken: tusd,
      standardPool: tusdPool,
    } = await setupTruefi2(owner))

    await tusd.mint(owner.address, parseEth(1e7))
    await tusd.approve(tusdPool.address, parseEth(1e7))
    await tusdPool.join(parseEth(1e7))

    creditOracle = await new TrueFiCreditOracle__factory(owner).deploy()
    await creditOracle.initialize()
    await creditOracle.setManager(owner.address)

    creditAgency = await new TrueCreditAgency__factory(owner).deploy()
    await creditAgency.initialize(creditOracle.address, 100)

    await tusdPool.setCreditAgency(creditAgency.address)
    await creditAgency.allowPool(tusdPool.address, true)

    await creditOracle.setScore(borrower.address, 255)
  })

  describe('initializer', () => {
    it('sets riskPremium', async () => {
      expect(await creditAgency.riskPremium()).to.eq(100)
    })

    it('sets creditOracle', async () => {
      expect(await creditAgency.creditOracle()).to.equal(creditOracle.address)
    })
  })

  describe('Ownership', () => {
    it('owner is set to msg.sender of initialize()', async () => {
      expect(await creditAgency.owner()).to.equal(owner.address)
    })

    it('ownership transfer', async () => {
      await creditAgency.transferOwnership(borrower.address)
      expect(await creditAgency.owner()).to.equal(owner.address)
      expect(await creditAgency.pendingOwner()).to.equal(borrower.address)
      await creditAgency.connect(borrower).claimOwnership()
      expect(await creditAgency.owner()).to.equal(borrower.address)
      expect(await creditAgency.pendingOwner()).to.equal(AddressZero)
    })
  })

  describe('setRiskPremium', () => {
    it('reverts if not called by the owner', async () => {
      await expect(creditAgency.connect(borrower).setRiskPremium(1))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('changes riskPremium rate', async () => {
      await creditAgency.setRiskPremium(1)
      expect(await creditAgency.riskPremium()).to.eq(1)
    })

    it('emits event', async () => {
      await expect(creditAgency.setRiskPremium(1))
        .to.emit(creditAgency, 'RiskPremiumChanged')
        .withArgs(1)
    })
  })

  describe('Borrower allowance', () => {
    it('only owner can set allowance', async () => {
      await expect(creditAgency.connect(borrower).allowBorrower(borrower.address, true))
        .to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('allowance is properly set', async () => {
      expect(await creditAgency.isBorrowerAllowed(borrower.address)).to.equal(false)
      await creditAgency.allowBorrower(borrower.address, true)
      expect(await creditAgency.isBorrowerAllowed(borrower.address)).to.equal(true)
      await creditAgency.allowBorrower(borrower.address, false)
      expect(await creditAgency.isBorrowerAllowed(borrower.address)).to.equal(false)
    })

    it('emits a proper event', async () => {
      await expect(creditAgency.allowBorrower(borrower.address, true))
        .to.emit(creditAgency, 'BorrowerAllowed')
        .withArgs(borrower.address, true)
      await expect(creditAgency.allowBorrower(borrower.address, false))
        .to.emit(creditAgency, 'BorrowerAllowed')
        .withArgs(borrower.address, false)
    })
  })

  describe('Setting pool allowance', () => {
    it('can only be called by the owner', async () => {
      await expect(creditAgency.connect(borrower).allowPool(tusdPool.address, true)).to.be.revertedWith('Ownable: caller is not the owner')
    })

    it('changes pool allowance status', async () => {
      await creditAgency.allowPool(tusdPool.address, false)
      expect(await creditAgency.isPoolAllowed(tusdPool.address)).to.be.false
      await creditAgency.allowPool(tusdPool.address, true)
      expect(await creditAgency.isPoolAllowed(tusdPool.address)).to.be.true
    })

    it('emits event', async () => {
      await expect(creditAgency.allowPool(tusdPool.address, false)).to.emit(creditAgency, 'PoolAllowed')
        .withArgs(tusdPool.address, false)
    })
  })

  describe('Borrowing', () => {
    beforeEach(async () => {
      await creditAgency.allowBorrower(borrower.address, true)
    })

    it('borrows funds from the pool', async () => {
      await creditAgency.connect(borrower).borrow(tusdPool.address, 1000)
      expect(await tusd.balanceOf(borrower.address)).to.equal(1000)
    })

    it('fails if borrower is not whitelisted', async () => {
      await creditAgency.allowBorrower(borrower.address, false)
      await expect(creditAgency.connect(borrower).borrow(tusdPool.address, 1000))
        .to.be.revertedWith('TrueCreditAgency: Sender is not allowed to borrow')
    })

    it('cannot borrow from the pool that is not whitelisted', async () => {
      await creditAgency.allowPool(tusdPool.address, false)
      await expect(creditAgency.connect(borrower).borrow(tusdPool.address, 1000))
        .to.be.revertedWith('TrueCreditAgency: The pool is not whitelisted for borrowing')
    })
  })

  describe('Credit score rate adjustment', () => {
    [
      [255, 0],
      [223, 143],
      [191, 335],
      [159, 603],
      [127, 1007],
      [95, 1684],
      [63, 3047],
      [31, 7225],
    ].map(([score, adjustment]) =>
      it(`returns ${adjustment} when score is ${score}`, async () => {
        await creditOracle.setScore(borrower.address, score)
        expect(await creditAgency.creditScoreAdjustmentRate(borrower.address)).to.equal(adjustment)
      }),
    )

    it('returns infinity if credit score is 0', async () => {
      expect(await creditAgency.creditScoreAdjustmentRate(owner.address)).to.equal(MaxUint256)
    })
  })

  describe('Repaying', () => {
    beforeEach(async () => {
      await creditAgency.allowBorrower(borrower.address, true)
    })

    it('repays the funds to the pool', async () => {
      await creditAgency.connect(borrower).borrow(tusdPool.address, 1000)
      await tusd.connect(borrower).approve(creditAgency.address, 1000)
      await creditAgency.connect(borrower).repay(tusdPool.address, 1000)
      expect(await tusd.balanceOf(borrower.address)).to.equal(0)
      expect(await tusd.balanceOf(tusdPool.address)).to.equal(parseEth(1e7))
    })
  })
})