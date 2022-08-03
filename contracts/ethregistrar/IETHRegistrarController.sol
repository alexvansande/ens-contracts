pragma solidity >=0.8.4;

import "./IPriceOracle.sol";

interface IETHRegistrarController {
    event NameRegistered(
        string name,
        bytes32 indexed label,
        address indexed owner,
        uint256 baseCost,
        uint256 premium,
        uint256 expires
    );
    event NameRenewed(
        string name,
        bytes32 indexed label,
        uint256 cost,
        uint256 expires,
        address referrer
    );
    event ReferrerReceived(address indexed referrer, uint256 amount);
    event ReferralFeeUpdated(uint256 indexed prevFee, uint256 indexed curFee);

    function rentPrice(string memory, uint256)
        external
        returns (IPriceOracle.Price memory);

    function available(string memory) external returns (bool);

    function makeCommitment(
        string memory,
        address,
        uint256,
        bytes32,
        address,
        bytes[] calldata,
        bool,
        uint32,
        uint64
    ) external returns (bytes32);

    function commit(bytes32) external;

    function register(
        string calldata,
        address,
        address,
        uint256,
        bytes32,
        address,
        bytes[] calldata,
        bool,
        uint32,
        uint64
    ) external payable;

    function renew(
        string calldata,
        uint256,
        address
    ) external payable;
}
