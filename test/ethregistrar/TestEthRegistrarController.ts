import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { BaseRegistrarImplementation, ENSRegistry, ETHRegistrarController, NameWrapper, PublicResolver, ReverseRegistrar, StablePriceOracle } from "../../typechain-types"
import { waffle, ethers } from "hardhat"
import { expect } from "chai"
import { namehash } from "ethers/lib/utils"
import { describe } from "mocha"
import { BigNumber } from "ethers"

const {
  evm,
  reverse: { getReverseNode },
  contracts: { deploy },
} = require('../test-utils')


const provider = ethers.provider
const sha3 = require('web3-utils').sha3

const DAYS = 24 * 60 * 60
const REGISTRATION_TIME = 28 * DAYS
const BUFFERED_REGISTRATION_COST = REGISTRATION_TIME + 3 * DAYS
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'
const EMPTY_BYTES =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

describe('ETHRegistrarController', () => {
  let ens: ENSRegistry
  let resolver: PublicResolver
  let resolver2: PublicResolver // resolver signed by registrant1Account
  let baseRegistrar: BaseRegistrarImplementation
  let controller: ETHRegistrarController
  let controller2: ETHRegistrarController // controller signed by registrant1Account
  let priceOracle: StablePriceOracle
  let reverseRegistrar: ReverseRegistrar
  let nameWrapper: NameWrapper

  let result: any

  const secret =
    '0x0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'


  let ownerAccount: SignerWithAddress // Account that owns the registrar
  let registrant1Account: SignerWithAddress // Account that owns test names
  let registrant2Account: SignerWithAddress // Account that owns test names
  let referrerAccount: SignerWithAddress // Account that refer test names


  async function registerName(
    name: string,
    txOptions = { value: BUFFERED_REGISTRATION_COST }
  ) {
    var commitment = await controller.makeCommitment(
      name,
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      NULL_ADDRESS,
      [],
      false,
      0,
      0
    )
    var tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockHash!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())

    var tx = await controller.register(
      name,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      NULL_ADDRESS,
      [],
      false,
      0,
      0,
      txOptions
    )

    return tx
  }

  before(async () => {
    [
      ownerAccount,
      registrant1Account,
      registrant2Account,
      referrerAccount,
    ] = await ethers.getSigners();

    ens = await deploy('ENSRegistry')

    baseRegistrar = await deploy(
      'BaseRegistrarImplementation',
      ens.address,
      namehash('eth')
    )

    nameWrapper = await deploy(
      'NameWrapper',
      ens.address,
      baseRegistrar.address,
      ownerAccount.address
    )

    reverseRegistrar = await deploy('ReverseRegistrar', ens.address)

    await ens.setSubnodeOwner(EMPTY_BYTES, sha3('eth'), baseRegistrar.address)

    const dummyOracle = await deploy('DummyOracle', '100000000')
    priceOracle = await deploy('StablePriceOracle', dummyOracle.address, [
      0,
      0,
      4,
      2,
      1,
    ])
    controller = await deploy(
      'ETHRegistrarController',
      baseRegistrar.address,
      priceOracle.address,
      600,
      86400,
      reverseRegistrar.address,
      nameWrapper.address
    )

    controller2 = controller.connect(registrant1Account)
    await baseRegistrar.addController(controller.address)
    await nameWrapper.setController(controller.address, true)
    await baseRegistrar.addController(nameWrapper.address)
    await reverseRegistrar.setController(controller.address, true)

    resolver = await deploy(
      'PublicResolver',
      ens.address,
      nameWrapper.address,
      controller.address,
      reverseRegistrar.address
    )

    resolver2 = await resolver.connect(registrant1Account)

    await ens.setSubnodeOwner(EMPTY_BYTES, sha3('reverse'), ownerAccount.address, {
      from: ownerAccount.address,
    })
    await ens.setSubnodeOwner(
      namehash('reverse'),
      sha3('addr'),
      reverseRegistrar.address,
      { from: ownerAccount.address }
    )
  })


  const checkLabels = {
    testing: true,
    longname12345678: true,
    sixsix: true,
    five5: true,
    four: true,
    iii: true,
    ii: false,
    i: false,
    '': false,

    // { ni } { hao } { ma } (chinese; simplified)
    你好吗: true,

    // { ta } { ko } (japanese; hiragana)
    たこ: false,

    // { poop } { poop } { poop } (emoji)
    '\ud83d\udca9\ud83d\udca9\ud83d\udca9': true,

    // { poop } { poop } (emoji)
    '\ud83d\udca9\ud83d\udca9': false,
  }

  beforeEach(async () => {
    result = await ethers.provider.send('evm_snapshot', [])
  })
  afterEach(async () => {
    await ethers.provider.send('evm_revert', [result])
  })


  it('should report label validity', async () => {
    for (const label in checkLabels) {
      expect(await controller.valid(label)).to.equal(checkLabels[label as keyof typeof checkLabels])
    }
  })

  it('should report unused names as available', async () => {
    expect(await controller.available(sha3('available'))).to.equal(true)
  })

  it('should permit new registrations', async () => {
    const name = 'newname'
    const balanceBefore = await (await provider.getBalance(controller.address)).toNumber()
    const tx = await registerName(name)
    const block = await provider.getBlock(tx.blockNumber!)
    await expect(tx)
      .to.emit(controller, 'NameRegistered')
      .withArgs(
        name,
        sha3(name),
        registrant1Account.address,
        REGISTRATION_TIME,
        0,
        block.timestamp + REGISTRATION_TIME
      )

    const balanceAfter = (await provider.getBalance(controller.address)).toNumber()
    expect(
      balanceAfter - balanceBefore
    ).to.equal(REGISTRATION_TIME)
  })

  it('should revert when not enough ether is transferred', async () => {
    await expect(registerName('newname', { value: 0 })).to.be.revertedWith(
      'ETHRegistrarController: Not enough ether provided'
    )
  })

  it('should report registered names as unavailable', async () => {
    const name = 'newname'
    await registerName(name)
    expect(await controller.available(name)).to.equal(false)
  })

  it('should permit new registrations with resolver and records', async () => {
    var commitment = await controller.makeCommitment(
      'newconfigname',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('newconfigname.eth'),
          registrant1Account.address,
        ]),
        resolver.interface.encodeFunctionData('setText', [
          namehash('newconfigname.eth'),
          'url',
          'ethereum.com',
        ]),
      ],
      false,
      0,
      0
    )
    var tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    var balanceBefore = await (await provider.getBalance(controller.address)).toNumber()
    var tx = await controller.register(
      'newconfigname',
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('newconfigname.eth'),
          registrant1Account.address,
        ]),
        resolver.interface.encodeFunctionData('setText', [
          namehash('newconfigname.eth'),
          'url',
          'ethereum.com',
        ]),
      ],
      false,
      0,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    const block = await provider.getBlock(tx.blockNumber!)

    await expect(tx)
      .to.emit(controller, 'NameRegistered')
      .withArgs(
        'newconfigname',
        sha3('newconfigname'),
        registrant1Account.address,
        REGISTRATION_TIME,
        0,
        block.timestamp + REGISTRATION_TIME
      )

    const balanceAfter = await (await provider.getBalance(controller.address)).toNumber()

    expect(
      balanceAfter - balanceBefore
    ).to.equal(REGISTRATION_TIME)

    var nodehash = namehash('newconfigname.eth')
    expect(await ens.resolver(nodehash)).to.equal(resolver.address)
    expect(await ens.owner(nodehash)).to.equal(nameWrapper.address)
    expect(await baseRegistrar.ownerOf(sha3('newconfigname'))).to.equal(
      nameWrapper.address
    )
    expect(await resolver['addr(bytes32)'](nodehash)).to.equal(
      registrant1Account.address
    )
    expect(await resolver['text'](nodehash, 'url')).to.equal('ethereum.com')
    expect(await nameWrapper.ownerOf(nodehash)).to.equal(registrant1Account.address)
  })

  it('should not permit new registrations with 0 resolver', async () => {
    await expect(
      controller.makeCommitment(
        'newconfigname',
        registrant1Account.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [
          resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
            namehash('newconfigname.eth'),
            registrant1Account.address,
          ]),
          resolver.interface.encodeFunctionData('setText', [
            namehash('newconfigname.eth'),
            'url',
            'ethereum.com',
          ]),
        ],
        false,
        0,
        0
      )
    ).to.be.revertedWith(
      'ETHRegistrarController: resolver is required when data is supplied'
    )
  })

  it('should not permit new registrations with EoA resolver', async () => {
    const commitment = await controller.makeCommitment(
      'newconfigname',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      registrant1Account.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('newconfigname.eth'),
          registrant1Account.address,
        ]),
        resolver.interface.encodeFunctionData('setText', [
          namehash('newconfigname.eth'),
          'url',
          'ethereum.com',
        ]),
      ],
      false,
      0,
      0
    )

    const tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await expect(
      controller.register(
        'newconfigname',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        registrant1Account.address,
        [
          resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
            namehash('newconfigname.eth'),
            registrant1Account.address,
          ]),
          resolver.interface.encodeFunctionData('setText', [
            namehash('newconfigname.eth'),
            'url',
            'ethereum.com',
          ]),
        ],
        false,
        0,
        0,
        { value: BUFFERED_REGISTRATION_COST }
      )
    ).to.be.revertedWith('Address: call to non-contract')
  })

  it('should not permit new registrations with an incompatible contract', async () => {
    const commitment = await controller.makeCommitment(
      'newconfigname',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      controller.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('newconfigname.eth'),
          registrant1Account.address,
        ]),
        resolver.interface.encodeFunctionData('setText', [
          namehash('newconfigname.eth'),
          'url',
          'ethereum.com',
        ]),
      ],
      false,
      0,
      0
    )

    const tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await expect(
      controller.register(
        'newconfigname',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        controller.address,
        [
          resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
            namehash('newconfigname.eth'),
            registrant1Account.address,
          ]),
          resolver.interface.encodeFunctionData('setText', [
            namehash('newconfigname.eth'),
            'url',
            'ethereum.com',
          ]),
        ],
        false,
        0,
        0,
        { value: BUFFERED_REGISTRATION_COST }
      )
    ).to.be.revertedWith('ETHRegistrarController: Failed to set Record')
  })

  it('should not permit new registrations with records updating a different name', async () => {
    const commitment = await controller.makeCommitment(
      'awesome',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('othername.eth'),
          registrant1Account.address,
        ]),
      ],
      false,
      0,
      0
    )
    const tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())

    await expect(
      controller.register(
        'awesome',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        resolver.address,
        [
          resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
            namehash('othername.eth'),
            registrant1Account.address,
          ]),
        ],
        false,
        0,
        0,
        { value: BUFFERED_REGISTRATION_COST }
      )
    ).to.be.revertedWith(
      'ETHRegistrarController: Namehash on record do not match the name being registered'
    )
  })

  it('should not permit new registrations with any record updating a different name', async () => {
    const commitment = await controller.makeCommitment(
      'awesome',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          namehash('awesome.eth'),
          registrant1Account.address,
        ]),
        resolver.interface.encodeFunctionData(
          'setText',
          [namehash('other.eth'), 'url', 'ethereum.com']
        ),
      ],
      false,
      0,
      0
    )
    const tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())

    await expect(
      controller.register(
        'awesome',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        resolver.address,
        [
          resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
            namehash('awesome.eth'),
            registrant1Account.address,
          ]),
          resolver.interface.encodeFunctionData(
            'setText',
            [namehash('other.eth'), 'url', 'ethereum.com']
          ),
        ],
        false,
        0,
        0,
        { value: BUFFERED_REGISTRATION_COST }
      )
    ).to.be.revertedWith(
      'ETHRegistrarController: Namehash on record do not match the name being registered'
    )
  })

  it('should permit a registration with resolver but no records', async () => {
    const commitment = await controller.makeCommitment(
      'newconfigname2',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      false,
      0,
      0
    )
    let tx = await controller.commit(commitment)
    expect(await controller.commitments(commitment)).to.equal(
      (await provider.getBlock(tx.blockNumber!)).timestamp
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    const balanceBefore = (await provider.getBalance(controller.address)).toNumber()
    let tx2 = await controller.register(
      'newconfigname2',
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      false,
      0,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    const block = await provider.getBlock(tx2.blockNumber!)

    await expect(tx2)
      .to.emit(controller, 'NameRegistered')
      .withArgs(
        'newconfigname2',
        sha3('newconfigname2'),
        registrant1Account.address,
        REGISTRATION_TIME,
        0,
        block.timestamp + REGISTRATION_TIME
      )

    const nodehash = namehash('newconfigname2.eth')
    const balanceAfter = (await provider.getBalance(controller.address)).toNumber()
    expect(await ens.resolver(nodehash)).to.equal(resolver.address)
    expect(await resolver['addr(bytes32)'](nodehash)).to.equal(NULL_ADDRESS)
    expect(
      balanceAfter - balanceBefore
    ).to.equal(REGISTRATION_TIME)
  })

  it('should include the owner in the commitment', async () => {
    await controller.commit(
      await controller.makeCommitment(
        'newname2',
        registrant2Account.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0
      )
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await expect(
      controller.register(
        'newname2',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0,
        {
          value: BUFFERED_REGISTRATION_COST,
        }
      )
    ).to.be.reverted
  })

  it('should reject duplicate registrations', async () => {
    await registerName('newname')
    await controller.commit(
      await controller.makeCommitment(
        'newname',
        registrant1Account.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0
      )
    )

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    expect(
      controller.register(
        'newname',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0,
        {
          value: BUFFERED_REGISTRATION_COST,
        }
      )
    ).to.be.revertedWith('ETHRegistrarController: Name is unavailable')
  })

  it('should reject for expired commitments', async () => {
    await controller.commit(
      await controller.makeCommitment(
        'newname2',
        registrant1Account.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0
      )
    )

    await evm.advanceTime((await controller.maxCommitmentAge()).toNumber() + 1)
    expect(
      controller.register(
        'newname2',
        registrant1Account.address,
        referrerAccount.address,
        REGISTRATION_TIME,
        secret,
        NULL_ADDRESS,
        [],
        false,
        0,
        0,
        {
          value: BUFFERED_REGISTRATION_COST,
        }
      )
    ).to.be.revertedWith('ETHRegistrarController: Commitment has expired')
  })

  it('should allow anyone to renew a name', async () => {
    await registerName('newname')
    var expires = await baseRegistrar.nameExpires(sha3('newname'))
    var balanceBefore = (await provider.getBalance(controller.address)).toNumber()
    const duration = 86400
    const [price] = await controller.rentPrice(sha3('newname'), duration)
    await controller.renew('newname', duration, referrerAccount.address, { value: price })
    var newExpires = await baseRegistrar.nameExpires(sha3('newname'))
    const balanceAfter = (await provider.getBalance(controller.address)).toNumber()

    expect(newExpires.toNumber() - expires.toNumber()).to.equal(86400)
    expect(
      balanceAfter - balanceBefore
    ).to.equal(86400)
  })

  it('should require sufficient value for a renewal', async () => {
    expect(controller.renew('name', 86400, referrerAccount.address)).to.be.revertedWith(
      'ETHController: Not enough Ether provided for renewal'
    )
  })

  it('should allow anyone to withdraw funds and transfer to the registrar owner', async () => {
    await controller.withdraw({ from: ownerAccount.address })
    expect((await provider.getBalance(controller.address)).toNumber()).to.equal(0)
  })

  it('should set the reverse record of the account', async () => {
    const commitment = await controller.makeCommitment(
      'reverse',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      0,
      0
    )
    await controller.commit(commitment)

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await controller.register(
      'reverse',
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      0,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    expect(await resolver.name(getReverseNode(ownerAccount.address))).to.equal(
      'reverse.eth'
    )
  })

  it('should not set the reverse record of the account when set to false', async () => {
    const commitment = await controller.makeCommitment(
      'noreverse',
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      false,
      0,
      0
    )
    await controller.commit(commitment)

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await controller.register(
      'noreverse',
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      false,
      0,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    expect(await resolver.name(getReverseNode(ownerAccount.address))).to.equal('')
  })

  it('should auto wrap the name and set the ERC721 owner to the wrapper', async () => {
    const label = 'wrapper'
    const name = label + '.eth'
    const commitment = await controller.makeCommitment(
      label,
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      0,
      0
    )
    await controller.commit(commitment)

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    await controller.register(
      label,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      0,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    expect(await nameWrapper.ownerOf(namehash(name))).to.equal(
      registrant1Account.address
    )

    expect(await ens.owner(namehash(name))).to.equal(nameWrapper.address)
    expect(await baseRegistrar.ownerOf(sha3(label))).to.equal(
      nameWrapper.address
    )
  })

  it('should auto wrap the name and allow fuses and expiry to be set', async () => {
    const MAX_INT_64 = BigNumber.from(2).pow(64).sub(1) //2 ** 64 - 1
    const label = 'fuses'
    const name = label + '.eth'
    const commitment = await controller.makeCommitment(
      label,
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      1,
      MAX_INT_64
    )
    await controller.commit(commitment)

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())
    const tx = await controller.register(
      label,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [],
      true,
      1,
      MAX_INT_64, // max number for uint64, but wrapper expiry is block.timestamp + REGISTRATION_TIME
      { value: BUFFERED_REGISTRATION_COST }
    )

    const block = await provider.getBlock(tx.blockNumber!)

    const [, fuses, expiry] = await nameWrapper.getData(namehash(name))
    expect(fuses).to.equal(65)
    expect(expiry).to.equal(REGISTRATION_TIME + block.timestamp)
  })

  it('approval should reduce gas for registration', async () => {
    const label = 'other'
    const name = label + '.eth'
    const node = namehash(name)
    const commitment = await controller.makeCommitment(
      label,
      registrant1Account.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          node,
          registrant1Account.address,
        ]),
      ],
      true,
      1,
      0
    )

    await controller.commit(commitment)

    await evm.advanceTime((await controller.minCommitmentAge()).toNumber())

    const gasA = await controller2.estimateGas.register(
      label,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          node,
          registrant1Account.address,
        ]),
      ],
      true,
      1,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    await resolver2.setApprovalForAll(controller.address, true)

    const gasB = await controller2.estimateGas.register(
      label,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver2.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          node,
          registrant1Account.address,
        ]),
      ],
      true,
      1,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    const tx = await controller2.register(
      label,
      registrant1Account.address,
      referrerAccount.address,
      REGISTRATION_TIME,
      secret,
      resolver2.address,
      [
        resolver.interface.encodeFunctionData('setAddr(bytes32,address)', [
          node,
          registrant1Account.address,
        ]),
      ],
      true,
      1,
      0,
      { value: BUFFERED_REGISTRATION_COST }
    )

    console.log((await tx.wait()).gasUsed.toString())

    console.log(gasA.toString(), gasB.toString())

    expect(await nameWrapper.ownerOf(node)).to.equal(registrant1Account.address)
    expect(await ens.owner(namehash(name))).to.equal(nameWrapper.address)
    expect(await baseRegistrar.ownerOf(sha3(label))).to.equal(
      nameWrapper.address
    )
    expect(await resolver2['addr(bytes32)'](node)).to.equal(registrant1Account.address)
  })
})
