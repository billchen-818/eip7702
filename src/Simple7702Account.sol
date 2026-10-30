// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice 教学示例：只允许钱包自己发起调用，不支持第三方代付执行。
/// @dev 委托执行时 address(this) 是 EOA 地址，不是实现合约地址。
contract Simple7702Account {
    error OnlySelf();
    error TransferFailed();

    event Executed(address indexed account, address indexed recipient, uint256 amount);

    function execute(address payable recipient, uint256 amount) external {
        // EOA 用自己的私钥签交易并调用自己，此时两者相等。
        // 陌生地址即使知道 ABI，也不能调用本函数转走钱包的 ETH。
        if (msg.sender != address(this)) revert OnlySelf();

        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Executed(address(this), recipient, amount);
    }

    receive() external payable {}
}