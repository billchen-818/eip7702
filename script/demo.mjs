import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import solc from 'solc';
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData,
  formatEther, http, parseEther, zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// 只创建临时的本地链和随机测试钱包，不读取用户私钥或外部 RPC。
const port = 20000 + Math.floor(Math.random() * 30000);
const chain = defineChain({
  id: 31337, name: 'Local EIP-7702 Demo',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } },
});
const transport = http(chain.rpcUrls.default.http[0], { retryCount: 0, timeout: 2000 });
const publicClient = createPublicClient({ chain, transport });
let startupError;
let output = '';
const anvil = spawn('anvil', [
  '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
  '--hardfork', 'prague', '--silent',
], { stdio: ['ignore', 'pipe', 'pipe'] });
anvil.once('error', error => { startupError = error; });
anvil.stdout.on('data', chunk => { output += chunk; });
anvil.stderr.on('data', chunk => { output += chunk; });
const cleanup = () => { anvil.kill('SIGTERM'); };
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });

async function confirm(hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `交易失败: ${hash}`);
  return receipt;
}

try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (startupError) throw new Error(`无法启动 Anvil，请先安装 Foundry: ${startupError.message}`);
    if (anvil.exitCode !== null) throw new Error(`Anvil 启动失败: ${output}`);
    try {
      assert.equal(await publicClient.getChainId(), 31337);
      ready = true;
      break;
    } catch { await delay(100); }
  }
  if (!ready) throw new Error(`等待本地链超时: ${output}`);

  const source = readFileSync(new URL('../src/Simple7702Account.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'Simple7702Account.sol': { content: source } },
    settings: {
      evmVersion: 'prague', optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })));
  const errors = (compiled.errors ?? []).filter(error => error.severity === 'error');
  assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
  const { abi, evm } = compiled.contracts['Simple7702Account.sol'].Simple7702Account;

  const alice = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const aliceClient = createWalletClient({ account: alice, chain, transport });
  const strangerClient = createWalletClient({ account: stranger, chain, transport });
  for (const account of [alice, stranger]) {
    await publicClient.request({ method: 'anvil_setBalance', params: [account.address, '0x8ac7230489e80000'] });
  }
  console.log('Alice 钱包:', alice.address);
  console.log('收款地址:', recipient);
  const deployed = await confirm(await aliceClient.deployContract({ abi, bytecode: `0x${evm.bytecode.object}` }));
  const implementation = deployed.contractAddress;
  assert.ok(implementation);
  console.log('实现合约:', implementation);
  assert.ok(['0x', undefined].includes(await publicClient.getCode({ address: alice.address })));
  console.log('\n1. 授权前钱包 code = 0x');

  // Alice 自己提交外层交易，授权 nonce 必须考虑外层交易先消耗的那一次。
  const authorization = await aliceClient.signAuthorization({
    contractAddress: implementation, executor: 'self',
  });
  const delegationReceipt = await confirm(await aliceClient.sendTransaction({
    to: alice.address, authorizationList: [authorization], data: '0x', gas: 100000n,
  }));
  assert.equal((await publicClient.getTransaction({ hash: delegationReceipt.transactionHash })).type, 'eip7702');
  const expectedCode = `0xef0100${implementation.slice(2)}`.toLowerCase();
  assert.equal((await publicClient.getCode({ address: alice.address })).toLowerCase(), expectedCode);
  console.log('2. Type 0x04 授权交易:', delegationReceipt.transactionHash);
  console.log('   钱包 code =', expectedCode);

  // 后续普通交易仍使用该代码，证明委托不会在授权交易结束后消失。
  const amount = parseEther('0.1');
  const data = encodeFunctionData({ abi, functionName: 'execute', args: [recipient, amount] });
  const before = await publicClient.getBalance({ address: recipient });
  const transferReceipt = await confirm(await aliceClient.sendTransaction({ to: alice.address, data, gas: 100000n }));
  assert.equal(await publicClient.getBalance({ address: recipient }), before + amount);
  assert.equal(transferReceipt.logs[0].address.toLowerCase(), alice.address.toLowerCase());
  assert.equal(await publicClient.getBalance({ address: implementation }), 0n);
  console.log(`3. Alice 调用自己的 execute，收款人增加 ${formatEther(amount)} ETH`);
  console.log('   日志发出地址为 Alice，合约模板余额仍为 0');

  const unauthorizedHash = await strangerClient.sendTransaction({ to: alice.address, data, gas: 100000n });
  const unauthorized = await publicClient.waitForTransactionReceipt({ hash: unauthorizedHash });
  assert.equal(unauthorized.status, 'reverted');
  assert.equal(await publicClient.getBalance({ address: recipient }), before + amount);
  console.log('4. 陌生地址调用 execute：交易回滚，余额未变化');

  // 这是合法授权，但 execute 的权限校验会让执行阶段回滚。
  // 用它验证 EIP-7702 的重要边界：执行回滚不会撤回已处理的委托。
  const reauthorization = await aliceClient.signAuthorization({ contractAddress: implementation });
  const revertedHash = await strangerClient.sendTransaction({
    to: alice.address, data, authorizationList: [reauthorization], gas: 100000n,
  });
  const reverted = await publicClient.waitForTransactionReceipt({ hash: revertedHash });
  assert.equal(reverted.status, 'reverted');
  assert.equal((await publicClient.getCode({ address: alice.address })).toLowerCase(), expectedCode);
  assert.equal(await publicClient.getTransactionCount({ address: alice.address }), reauthorization.nonce + 1);
  console.log('5. 另一账户代提交授权但执行失败：授权 nonce 仍消耗，委托仍保留');

  const revocation = await aliceClient.signAuthorization({ contractAddress: zeroAddress, executor: 'self' });
  await confirm(await aliceClient.sendTransaction({
    to: alice.address, authorizationList: [revocation], data: '0x', gas: 100000n,
  }));
  assert.ok(['0x', undefined].includes(await publicClient.getCode({ address: alice.address })));
  const afterTransfer = await publicClient.getBalance({ address: recipient });
  await confirm(await aliceClient.sendTransaction({ to: alice.address, data, gas: 100000n }));
  assert.equal(await publicClient.getBalance({ address: recipient }), afterTransfer);
  console.log('6. 委托到零地址后 code = 0x，原 execute 调用不再转账');
  console.log('\n全部断言通过。仅使用临时本地链，退出后关闭。');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  cleanup();
}
