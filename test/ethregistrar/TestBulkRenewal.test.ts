import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { artifacts, ethers } from "hardhat"
import { expect } from "chai"
import { BaseRegistrarImplementation, BulkRenewal, ENSRegistry, ETHRegistrarController, NameWrapper, PublicResolver, StablePriceOracle } from "../../typechain-types"
import { namehash } from "ethers/lib/utils"
import { interfaceIdFromABI } from "erc-165"

const ENS = artifacts.require('ENSRegistry')
const PublicResolver = artifacts.require('PublicResolver')
const BaseRegistrar = artifacts.require('BaseRegistrarImplementation')
const ETHRegistrarController = artifacts.require('ETHRegistrarController')
const IETHRegistrarController = artifacts.require('IETHRegistrarController')
const DummyOracle = artifacts.require('DummyOracle')
const StablePriceOracle = artifacts.require('StablePriceOracle')
const BulkRenewal = artifacts.require('BulkRenewal')
const NameWrapper = artifacts.require('DummyNameWrapper')

const sha3 = require('web3-utils').sha3
const toBN = require('web3-utils').toBN

const ETH_LABEL = sha3('eth')
const ETH_NAMEHASH = namehash('eth')

describe('BulkRenewal', () => {
  const provider = ethers.getDefaultProvider()

  let ens: ENSRegistry
  let resolver: PublicResolver
  let baseRegistrar: BaseRegistrarImplementation
  let controller: ETHRegistrarController
  let priceOracle: StablePriceOracle
  let bulkRenewal: BulkRenewal
  let nameWrapper: NameWrapper


  let ownerAccount: SignerWithAddress // Account that owns the registrar
  let registrantAccount: SignerWithAddress // Account that owns test names
  let referrerAccount: SignerWithAddress

  before(async () => {
    [
      ownerAccount,
      registrantAccount,
      referrerAccount,
    ] = await ethers.getSigners();

    // Create a registry
    ens = await ENS.new()
    nameWrapper = await NameWrapper.new()
    // Create a public resolver
    resolver = await PublicResolver.new(
      ens.address,
      nameWrapper.address,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero
    )

    // Create a base registrar
    baseRegistrar = await BaseRegistrar.new(ens.address, namehash('eth'), {
      from: ownerAccount.address,
    })

    // Set up a dummy price oracle and a controller
    const dummyOracle = await DummyOracle.new(toBN(100000000))
    priceOracle = await StablePriceOracle.new(dummyOracle.address, [
      0,
      0,
      4,
      2,
      1,
    ])
    controller = await ETHRegistrarController.new(
      baseRegistrar.address,
      priceOracle.address,
      600,
      86400,
      nameWrapper.address,
      ethers.constants.AddressZero,
      { from: ownerAccount.address }
    )
    await baseRegistrar.addController(controller.address, {
      from: ownerAccount.address,
    })
    await baseRegistrar.addController(ownerAccount.address, { from: ownerAccount.address })
    // Create the bulk registration contract
    bulkRenewal = await BulkRenewal.new(ens.address)

    // Configure a resolver for .eth and register the controller interface
    // then transfer the .eth node to the base registrar.
    await ens.setSubnodeRecord(
      '0x0',
      ETH_LABEL,
      ownerAccount.address,
      resolver.address,
      0
    )
    await resolver.setInterface(ETH_NAMEHASH, interfaceIdFromABI(IETHRegistrarController.abi), controller.address)
    await ens.setOwner(ETH_NAMEHASH, baseRegistrar.address)

    // Register some names
    for (const name of ['test1', 'test2', 'test3']) {
      await baseRegistrar.register(sha3(name), registrantAccount.address, 31536000)
    }
  })

  it('should return the cost of a bulk renewal', async () => {
    expect((await bulkRenewal.rentPrice(['test1', 'test2'], 86400)).toNumber()).to.equal(86400 * 2)
  })

  it('should raise an error trying to renew a nonexistent name', async () => {
    await expect(bulkRenewal.renewAll(['foobar'], 86400, referrerAccount.address, {
      value: 86401,
    })).to.be.reverted
  })

  it('should permit bulk renewal of names', async () => {
    const oldExpiry = await baseRegistrar.nameExpires(sha3('test2'))
    const tx = await bulkRenewal.renewAll(['test1', 'test2'], 86400, referrerAccount.address, {
      value: 86401 * 2,
    })

    expect((tx as any).receipt.status).to.equal(true)
    const newExpiry = await baseRegistrar.nameExpires(sha3('test2'))
    expect(newExpiry.sub(oldExpiry).toNumber()).to.equal(86400)
    // Check any excess funds are returned
    expect((await provider.getBalance(bulkRenewal.address)).toNumber()).to.equal(0)
  })
})
