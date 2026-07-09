'use strict';
/**
 * SasaCoin デモ
 * 実行: node src/coin-demo.js
 *
 * ウォレット生成 → マイニングで新規コイン発行 → 送金 → 改ざん検知
 * までの一連の流れをローカルで確認できる。
 */

const { Blockchain, Transaction, createWallet } = require('./SasaCoin');

function shortAddr(address) {
  return address.slice(0, 8) + '…' + address.slice(-6);
}

function printBalances(chain, wallets) {
  for (const [name, wallet] of Object.entries(wallets)) {
    console.log(
      '   ' + name.padEnd(6) + ' (' + shortAddr(wallet.address) + '): ' +
      chain.getBalanceOfAddress(wallet.address) + ' SASA'
    );
  }
}

const sasaCoin = new Blockchain({
  difficulty: 3,
  miningReward: 50,
  halvingInterval: 5,
  maxSupply: 300
});

const wallets = {
  miner: createWallet(),
  alice: createWallet(),
  bob: createWallet()
};

console.log('=== SasaCoin デモ ===\n');
console.log('1) miner が最初のブロックを採掘(ここで新規コインが生み出される)');
let block = sasaCoin.minePendingTransactions(wallets.miner.address);
console.log('   ⛏️ nonce=' + block.nonce + ' hash=' + block.hash.slice(0, 16) + '…');
printBalances(sasaCoin, wallets);

console.log('\n2) miner → alice へ 30 SASA を送金(署名付き)し、次のブロックで確定');
sasaCoin.addTransaction(
  new Transaction(wallets.miner.address, wallets.alice.address, 30).sign(wallets.miner.privateKey)
);
block = sasaCoin.minePendingTransactions(wallets.miner.address);
console.log('   ⛏️ nonce=' + block.nonce + ' hash=' + block.hash.slice(0, 16) + '…');
printBalances(sasaCoin, wallets);

console.log('\n3) alice → bob へ 10 SASA を送金');
sasaCoin.addTransaction(
  new Transaction(wallets.alice.address, wallets.bob.address, 10).sign(wallets.alice.privateKey)
);
sasaCoin.minePendingTransactions(wallets.miner.address);
printBalances(sasaCoin, wallets);

console.log('\n4) 残高を超える送金は拒否される');
try {
  sasaCoin.addTransaction(
    new Transaction(wallets.bob.address, wallets.alice.address, 999).sign(wallets.bob.privateKey)
  );
} catch (e) {
  console.log('   🚫 ' + e.message);
}

console.log('\n5) 発行上限までマイニングを続ける(半減期あり)');
while (sasaCoin.getTotalSupply() < 300) {
  const height = sasaCoin.chain.length;
  const before = sasaCoin.getTotalSupply();
  sasaCoin.minePendingTransactions(wallets.miner.address);
  console.log('   ブロック#' + height + ': 報酬 ' + (sasaCoin.getTotalSupply() - before) + ' SASA' +
    ' (総発行量 ' + sasaCoin.getTotalSupply() + '/300)');
}
console.log('   → 上限到達。以降の新規発行は 0');

console.log('\n6) チェーン検証: ' + (sasaCoin.isChainValid() ? '✅ 正常' : '❌ 不正'));

console.log('\n7) ブロック#2 の取引金額を改ざんしてみる');
sasaCoin.chain[2].transactions[1].amount = 10000;
console.log('   チェーン検証: ' + (sasaCoin.isChainValid() ? '✅ 正常' : '❌ 改ざんを検知'));
