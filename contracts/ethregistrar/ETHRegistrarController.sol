pragma solidity >=0.8.4;

import "./BaseRegistrarImplementation.sol";
import "./StringUtils.sol";
import "../resolvers/Resolver.sol";
import "../registry/ReverseRegistrar.sol";
import "./IETHRegistrarController.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "../wrapper/INameWrapper.sol";

/**
 * @dev A registrar controller for registering and renewing names at fixed cost.
 */
contract ETHRegistrarController is Ownable, IETHRegistrarController {
    using StringUtils for *;
    using Address for address;

    uint256 public constant MIN_REGISTRATION_DURATION = 28 days;
    bytes32 private constant ETH_NODE =
        0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae;

    BaseRegistrarImplementation immutable base;
    IPriceOracle public immutable prices;
    uint256 public immutable minCommitmentAge;
    uint256 public immutable maxCommitmentAge;
    ReverseRegistrar public immutable reverseRegistrar;
    INameWrapper public immutable nameWrapper;

    mapping(bytes32 => uint256) public commitments;
    mapping(address => uint256) public balances;
    uint256 public referralFee = 50;

    /**
     * @dev Constructor
     * @param _base The address of the ENS registry.
     * @param _prices The IPriceOracle interface.
     * @param _minCommitmentAge Minimum commitment time.
     * @param _maxCommitmentAge Maximum commitment time.
     * @param _reverseRegistrar The ReverseRegistrar interface.
     * @param _nameWrapper The INameWrapper interface
     */
    constructor(
        BaseRegistrarImplementation _base,
        IPriceOracle _prices,
        uint256 _minCommitmentAge,
        uint256 _maxCommitmentAge,
        ReverseRegistrar _reverseRegistrar,
        INameWrapper _nameWrapper
    ) {
        require(_maxCommitmentAge > _minCommitmentAge);

        base = _base;
        prices = _prices;
        minCommitmentAge = _minCommitmentAge;
        maxCommitmentAge = _maxCommitmentAge;
        reverseRegistrar = _reverseRegistrar;
        nameWrapper = _nameWrapper;
    }

    /**
     * @dev Checks if the name is available.
     * @param name The name to be checked.
     * @return True if `name` is available.
     */
    function available(string memory name) public view override returns (bool) {
        bytes32 label = keccak256(bytes(name));
        return valid(name) && base.available(uint256(label));
    }

    /**
     * @dev Price of the ENS name, given a duration
     * @param name Name to be checked for availability.
     * @param duration The address of the ENS registry.
     * @return price struct from IPriceOracle.
     */
    function rentPrice(string memory name, uint256 duration)
        public
        view
        override
        returns (IPriceOracle.Price memory price)
    {
        bytes32 label = keccak256(bytes(name));
        price = prices.price(name, base.nameExpires(uint256(label)), duration);
    }

    /**
     * @dev Return True or False for match criteria.
     * @param name The name to be checked.
     * @return True if `lenght` is bigger than 3.
     */
    function valid(string memory name) public pure returns (bool) {
        return name.strlen() >= 3;
    }

    /**
     * @dev Set the commitment for a given hash as the current block
     *      timestamp. Max commitment must happen at the same instant.
     * @param commitment The hash of the current commitment.
     */
    function commit(bytes32 commitment) public override {
        require(
            commitments[commitment] + maxCommitmentAge < block.timestamp,
            "ETHRegistrarController: Cannot insert timestamp due to max commitment age extrapolation"
        );
        commitments[commitment] = block.timestamp;
    }

    /**
     * @dev Check if interface is implemented.
     * @param interfaceID The first 4 bytes of the interface ID.
     * @return True if interface is supported, false otherwise.
     */
    function supportsInterface(bytes4 interfaceID)
        external
        pure
        returns (bool)
    {
        return
            interfaceID == type(IERC165).interfaceId ||
            interfaceID == type(IETHRegistrarController).interfaceId;
    }

    /**
     * @dev Sets the new referral fee in percentage with one decimal.
     * @param _referralFee The fee to be used. From 0 to 1000.
     */
    function setReferralFee(uint256 _referralFee) external onlyOwner {
        require(
            _referralFee <= 1000,
            "ETHRegistrarController: Referral fee max is 1000"
        );

        emit ReferralFeeUpdated(referralFee, _referralFee);
        referralFee = _referralFee;
    }

    /**
     * @dev Withdraw everything from balance.
     */
    function withdraw() public {
        uint256 amount = balances[msg.sender];
        require(amount != 0, "ETHRegistrarController: No balance to withdraw");
        balances[msg.sender] = 0;
        payable(msg.sender).transfer(amount);
    }

    /**
     * @dev Checks if the name is available.
     * @param name The ENS name.
     * @param owner The owner to be.
     * @param duration The expiration period.
     * @param secret The secret hash for validation.
     * @param resolver The resolver.
     * @param data Extra data.
     * @param reverseRecord If there is a reverse record.
     * @param fuses The initial fuses to set.
     * @param wrapperExpiry The expiry date.
     * @return The commitment hash.
     */
    function makeCommitment(
        string memory name,
        address owner,
        uint256 duration,
        bytes32 secret,
        address resolver,
        bytes[] calldata data,
        bool reverseRecord,
        uint32 fuses,
        uint64 wrapperExpiry
    ) public pure override returns (bytes32) {
        bytes32 label = keccak256(bytes(name));
        if (data.length > 0) {
            require(
                resolver != address(0),
                "ETHRegistrarController: resolver is required when data is supplied"
            );
        }
        return
            keccak256(
                abi.encode(
                    label,
                    owner,
                    duration,
                    resolver,
                    data,
                    secret,
                    reverseRecord,
                    fuses,
                    wrapperExpiry
                )
            );
    }

    /**
     * @dev Registers a new ENS domain.
     * @param name The ENS name.
     * @param owner The owner to be.
     * @param referrer The referrer of the owner.
     * @param duration The expiration period.
     * @param secret The secret hash for validation.
     * @param resolver The resolver.
     * @param data Extra data.
     * @param reverseRecord If there is a reverse record.
     * @param fuses The initial fuses to set.
     * @param wrapperExpiry The expiry date.
     */
    function register(
        string calldata name,
        address owner,
        address referrer,
        uint256 duration,
        bytes32 secret,
        address resolver,
        bytes[] calldata data,
        bool reverseRecord,
        uint32 fuses,
        uint64 wrapperExpiry
    ) public payable override {
        IPriceOracle.Price memory price = rentPrice(name, duration);
        uint256 totalPrice = price.base + price.premium;
        require(
            msg.value >= totalPrice,
            "ETHRegistrarController: Not enough ether provided"
        );

        _register(
            name,
            owner,
            duration,
            secret,
            resolver,
            data,
            reverseRecord,
            fuses,
            wrapperExpiry,
            price
        );

        if (msg.value > totalPrice) {
            payable(msg.sender).transfer(msg.value - totalPrice);
        }

        _setBalance(referrer, totalPrice);
    }

    /**
     * @dev Renew the current ENS registration for a given duration.
     * @param name The ENS name to be renewed.
     * @param duration The increase in the duration.
     * @param referrer The referrer to receive the commission.
     */
    function renew(
        string calldata name,
        uint256 duration,
        address referrer
    ) external payable override {
        bytes32 label = keccak256(bytes(name));
        IPriceOracle.Price memory price = rentPrice(name, duration);
        require(
            msg.value >= price.base,
            "ETHRegistrarController: Not enough Ether provided for renewal"
        );

        uint256 expires = base.renew(uint256(label), duration);

        if (msg.value > price.base) {
            (bool ok, ) = msg.sender.call{value: msg.value - price.base}("");
            require(
                ok,
                "ETHRegistrarController: failed to refund renew excess"
            );
        }

        _setBalance(referrer, price.base);

        emit NameRenewed(name, label, msg.value, expires, referrer);
    }

    /**
     * @dev Registers a new ENS domain.
     * @param name The ENS name.
     * @param nameOwner The name owner.
     * @param duration The expiration period of tmie.
     * @param secret The secret hash for validation.
     * @param resolver The resolver.
     * @param data Extra data.
     * @param reverseRecord If there is a reverse record.
     * @param fuses The initial fuses to set.
     * @param wrapperExpiry The expiry date.
     */
    function _register(
        string calldata name,
        address nameOwner,
        uint256 duration,
        bytes32 secret,
        address resolver,
        bytes[] calldata data,
        bool reverseRecord,
        uint32 fuses,
        uint64 wrapperExpiry,
        IPriceOracle.Price memory price
    ) internal {
        _consumeCommitment(
            name,
            duration,
            makeCommitment(
                name,
                nameOwner,
                duration,
                secret,
                resolver,
                data,
                reverseRecord,
                fuses,
                wrapperExpiry
            )
        );

        uint256 expires = nameWrapper.registerAndWrapETH2LD(
            name,
            nameOwner,
            duration,
            resolver,
            fuses,
            wrapperExpiry
        );

        _setRecords(resolver, keccak256(bytes(name)), data);

        if (reverseRecord) {
            _setReverseRecord(name, resolver, msg.sender);
        }

        emit NameRegistered(
            name,
            keccak256(bytes(name)),
            nameOwner,
            price.base,
            price.premium,
            expires
        );
    }

    /**
     * @dev Requires a valid commitment (is old enough and is committed).
     *      If the commitment is too old, or the name is registered, stop.
     * @param name The ENS name.
     * @param duration The expiration days.
     * @param commitment The hash of the commitments.
     */
    function _consumeCommitment(
        string memory name,
        uint256 duration,
        bytes32 commitment
    ) internal {
        require(
            commitments[commitment] + minCommitmentAge <= block.timestamp,
            "ETHRegistrarController: Commitment is not valid"
        );

        require(
            commitments[commitment] + maxCommitmentAge > block.timestamp,
            "ETHRegistrarController: Commitment has expired"
        );
        require(available(name), "ETHRegistrarController: Name is unavailable");

        delete (commitments[commitment]);

        require(duration >= MIN_REGISTRATION_DURATION);
    }

    /**
     * @dev Set the balance after a successful registration or renewal.
     * @param referrer The referrer of the purchase.
     * @param amount The amount in wei.
     */
    function _setBalance(address referrer, uint256 amount) internal {
        if (referrer == address(0) || referralFee == 0) {
            balances[owner()] += amount;
        } else {
            uint256 referralFeePrice = (amount / 1000) * referralFee;
            balances[referrer] += referralFeePrice;
            balances[owner()] += amount - referralFeePrice;
            emit ReferrerReceived(referrer, referralFeePrice);
        }
    }

    /**
     * @dev Set the records by checking if the first few bytes
     *      the hardcoded .eth namehash.
     * @param resolver The resolver to use.
     * @param label The hash of the ENS name.
     */
    function _setRecords(
        address resolver,
        bytes32 label,
        bytes[] calldata data
    ) internal {
        bytes32 nodehash = keccak256(abi.encodePacked(ETH_NODE, label));
        for (uint256 i = 0; i < data.length; i++) {
            bytes32 txNamehash = bytes32(data[i][4:36]);
            require(
                txNamehash == nodehash,
                "ETHRegistrarController: Namehash on record do not match the name being registered"
            );
            resolver.functionCall(
                data[i],
                "ETHRegistrarController: Failed to set Record"
            );
        }
    }

    /**
     * @dev Reverse resolution maps from an address back to a name.
     * @param name The name to be settled.
     * @param resolver The resolver address.
     * @param owner The owner of the ENS reverse record.
     */
    function _setReverseRecord(
        string memory name,
        address resolver,
        address owner
    ) internal {
        reverseRegistrar.setNameForAddr(
            msg.sender,
            owner,
            resolver,
            string.concat(name, ".eth")
        );
    }
}
