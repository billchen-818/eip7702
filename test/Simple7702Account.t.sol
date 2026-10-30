// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Simple7702Account} from "../src/Simple7702Account.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function signAndAttachDelegation(address implementation, uint256 privateKey) external;
}

/// @dev 无 forge-std 依赖。这里测试本地 EVM，不替代 Anvil 上的签名交易 demo。
contract Simple7702AccountTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant ALICE_KEY = 0xA11CE; // 公开的测试用数字，不用于真实钱包。
    address alice;
    address payable recipient = payable(address(0xB0B));
    Simple7702Account implementation;

    function setUp() public {
        alice = vm.addr(ALICE_KEY);
        vm.deal(alice, 10 ether);
        implementation = new Simple7702Account();
        vm.signAndAttachDelegation(address(implementation), ALICE_KEY);
        // attach 将下一次调用视为携带授权的交易。
        (bool success,) = alice.call("");
        require(success, "delegation failed");
    }

    function testDelegationIndicator() public view {
        require(
            keccak256(alice.code) == keccak256(abi.encodePacked(hex"ef0100", address(implementation))),
            "wrong delegation indicator"
        );
    }

    function testSelfExecutionUsesAliceBalance() public {
        vm.prank(alice);
        Simple7702Account(payable(alice)).execute(recipient, 0.1 ether);
        require(recipient.balance == 0.1 ether, "recipient not paid");
        require(alice.balance == 9.9 ether, "not Alice's balance");
        require(address(implementation).balance == 0, "template balance changed");
    }

    function testStrangerCannotExecute() public {
        vm.prank(address(0xBAD));
        (bool success, bytes memory result) =
            alice.call(abi.encodeCall(Simple7702Account.execute, (recipient, 0.1 ether)));
        require(!success, "stranger executed");
        require(bytes4(result) == Simple7702Account.OnlySelf.selector, "wrong revert reason");
        require(recipient.balance == 0, "stranger moved funds");
    }

    function testInsufficientFundsReverts() public {
        vm.prank(alice);
        (bool success, bytes memory result) =
            alice.call(abi.encodeCall(Simple7702Account.execute, (recipient, 11 ether)));
        require(!success, "overspend succeeded");
        require(bytes4(result) == Simple7702Account.TransferFailed.selector, "wrong revert reason");
        require(alice.balance == 10 ether, "balance changed");
    }

    function testRevokeStopsExecution() public {
        vm.signAndAttachDelegation(address(0), ALICE_KEY);
        (bool cleared,) = alice.call("");
        require(cleared, "revocation failed");
        require(alice.code.length == 0, "code not cleared");
        vm.prank(alice);
        (bool success,) = alice.call(abi.encodeCall(Simple7702Account.execute, (recipient, 0.1 ether)));
        require(success, "EOA call should succeed");
        require(recipient.balance == 0, "revoked code still executed");
    }
}
