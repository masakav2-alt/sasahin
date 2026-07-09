'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createWallet,
  Transaction,
  Block,
  Blockchain
} = require('../src/SasaCoin');

// テストは低難易度で高速に(PoW の探索コストを抑える)
const CHAIN_OPTS = { difficulty: 1, miningReward: 50, halvingInterval: 10, maxSupply: Infinity };

// 鍵生成は比較的重いので共有ウォレットを使い回す
const miner = createWallet();
const alice = createWallet();
const bob = createWallet();

// ===== Wallet / Transaction =====

test('createWallet: hex アドレスと鍵ペアを生成する', () => {
  assert.match(miner.address, /^[0-9a-f]+$/);
  assert.notEqual(miner.address, alice.address);
});

test('Transaction: 署名付きトランザクションは有効', () => {
  const tx = new Transaction(alice.address, bob.address, 10).sign(alice.privateKey);
  assert.equal(tx.isValid(), true);
});

test('Transaction: 未署名は無効', () => {
  const tx = new Transaction(alice.address, bob.address, 10);
  assert.equal(tx.isValid(), false);
});

test('Transaction: 署名後の改ざんを検知する', () => {
  const tx = new Transaction(alice.address, bob.address, 10).sign(alice.privateKey);
  tx.amount = 9999;
  assert.equal(tx.isValid(), false);
});

test('Transaction: 他人の秘密鍵による署名は無効', () => {
  const tx = new Transaction(alice.address, bob.address, 10).sign(bob.privateKey);
  assert.equal(tx.isValid(), false);
});

test('Transaction: 金額が 0 以下・非数は無効', () => {
  assert.equal(new Transaction(null, bob.address, 0).isValid(), false);
  assert.equal(new Transaction(null, bob.address, -5).isValid(), false);
  assert.equal(new Transaction(null, bob.address, NaN).isValid(), false);
});

test('Transaction: コインベース(fromAddress=null)は署名不要で有効', () => {
  const tx = new Transaction(null, miner.address, 50);
  assert.equal(tx.isCoinbase(), true);
  assert.equal(tx.isValid(), true);
  assert.throws(() => tx.sign(miner.privateKey), /署名は不要/);
});

// ===== Block =====

test('Block: mineBlock で難易度条件を満たすハッシュを探索する', () => {
  const block = new Block(1000, [], 'prev-hash');
  block.mineBlock(2);
  assert.ok(block.hash.startsWith('00'));
  assert.equal(block.hash, block.calculateHash());
});

// ===== Blockchain: 新規発行(マイニング) =====

test('Blockchain: マイニング報酬として新規コインが発行される', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  assert.equal(chain.getTotalSupply(), 0);

  chain.minePendingTransactions(miner.address);

  assert.equal(chain.getBalanceOfAddress(miner.address), 50);
  assert.equal(chain.getTotalSupply(), 50);
  assert.equal(chain.chain.length, 2);
  assert.equal(chain.isChainValid(), true);
});

test('Blockchain: 半減期ごとに報酬が半減する', () => {
  const chain = new Blockchain({ ...CHAIN_OPTS, miningReward: 8, halvingInterval: 2 });
  assert.equal(chain.rewardForHeight(1), 8);
  assert.equal(chain.rewardForHeight(2), 8);
  assert.equal(chain.rewardForHeight(3), 4);
  assert.equal(chain.rewardForHeight(4), 4);
  assert.equal(chain.rewardForHeight(5), 2);
  assert.equal(chain.rewardForHeight(7), 1);
  assert.equal(chain.rewardForHeight(9), 0);

  // 実際に採掘しても同じ供給曲線になる: 8+8+4+4+2+2+1+1 = 30
  for (let i = 0; i < 8; i++) chain.minePendingTransactions(miner.address);
  assert.equal(chain.getTotalSupply(), 30);
  assert.equal(chain.isChainValid(), true);
});

test('Blockchain: 発行上限を超えて新規発行しない', () => {
  const chain = new Blockchain({ ...CHAIN_OPTS, miningReward: 50, maxSupply: 120 });
  chain.minePendingTransactions(miner.address); // +50
  chain.minePendingTransactions(miner.address); // +50
  chain.minePendingTransactions(miner.address); // +20 (残り枠のみ)
  assert.equal(chain.getTotalSupply(), 120);

  // 上限到達後はコインベースなしでブロックだけが積まれる
  const block = chain.minePendingTransactions(miner.address);
  assert.equal(block.transactions.filter((tx) => tx.isCoinbase()).length, 0);
  assert.equal(chain.getTotalSupply(), 120);
  assert.equal(chain.isChainValid(), true);
});

test('Blockchain: 採掘者アドレスなしでは採掘できない', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  assert.throws(() => chain.minePendingTransactions(''), /アドレスが必要/);
});

// ===== Blockchain: 送金 =====

test('Blockchain: 送金フロー (miner→alice→bob) の残高が正しい', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address); // miner: 50

  chain.addTransaction(
    new Transaction(miner.address, alice.address, 30).sign(miner.privateKey)
  );
  chain.minePendingTransactions(bob.address); // bob が採掘: +50

  chain.addTransaction(
    new Transaction(alice.address, bob.address, 10).sign(alice.privateKey)
  );
  chain.minePendingTransactions(bob.address); // bob: +50

  assert.equal(chain.getBalanceOfAddress(miner.address), 20);
  assert.equal(chain.getBalanceOfAddress(alice.address), 20);
  assert.equal(chain.getBalanceOfAddress(bob.address), 110);
  assert.equal(chain.isChainValid(), true);
});

test('Blockchain: 残高を超える送金は拒否', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address); // miner: 50
  assert.throws(
    () => chain.addTransaction(
      new Transaction(miner.address, alice.address, 51).sign(miner.privateKey)
    ),
    /残高不足/
  );
});

test('Blockchain: 保留中の支出を考慮して二重支払いを拒否', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address); // miner: 50

  chain.addTransaction(
    new Transaction(miner.address, alice.address, 40).sign(miner.privateKey)
  );
  // 確定残高は 50 だが、保留中に 40 使っているので 20 は送れない
  assert.throws(
    () => chain.addTransaction(
      new Transaction(miner.address, bob.address, 20).sign(miner.privateKey)
    ),
    /残高不足/
  );
});

test('Blockchain: 署名の無いトランザクションは追加できない', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);
  assert.throws(
    () => chain.addTransaction(new Transaction(miner.address, alice.address, 10)),
    /署名が無効/
  );
});

test('Blockchain: コインベースの直接追加(勝手な新規発行)は拒否', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  assert.throws(
    () => chain.addTransaction(new Transaction(null, alice.address, 1000)),
    /直接追加することはできません/
  );
});

// ===== Blockchain: 改ざん検証 =====

test('isChainValid: 取引金額の改ざんを検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);
  chain.addTransaction(
    new Transaction(miner.address, alice.address, 30).sign(miner.privateKey)
  );
  chain.minePendingTransactions(miner.address);
  assert.equal(chain.isChainValid(), true);

  chain.chain[2].transactions[1].amount = 45; // 署名とブロックハッシュの両方が崩れる
  assert.equal(chain.isChainValid(), false);
});

test('isChainValid: ハッシュを再計算して整合させても PoW とリンクで検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);
  chain.minePendingTransactions(miner.address);

  // 中間ブロックを書き換えてハッシュも付け直す
  chain.chain[1].timestamp = 999999;
  chain.chain[1].hash = chain.chain[1].calculateHash();
  assert.equal(chain.isChainValid(), false); // 次ブロックの previousHash と不一致
});

test('isChainValid: 報酬額の水増しを検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);

  // 報酬 50 のところを 1000 に書き換え、ブロックを掘り直して PoW も整合させる
  chain.chain[1].transactions[0].amount = 1000;
  chain.chain[1].mineBlock(chain.difficulty);
  assert.equal(chain.isChainValid(), false);
});

test('isChainValid: 1ブロックに複数のコインベースを検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);

  chain.chain[1].transactions.push(new Transaction(null, miner.address, 50));
  chain.chain[1].mineBlock(chain.difficulty);
  assert.equal(chain.isChainValid(), false);
});

test('isChainValid: 発行されていないコインの使用(残高マイナス)を検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address); // miner: 50

  // 検証をすり抜けて残高以上の送金を直接ブロックに入れ、掘り直す
  const tx = new Transaction(miner.address, alice.address, 500).sign(miner.privateKey);
  const prev = chain.getLatestBlock();
  const block = new Block(Date.now(), [tx], prev.hash);
  block.mineBlock(chain.difficulty);
  chain.chain.push(block);

  assert.equal(chain.isChainValid(), false);
});

test('isChainValid: ジェネシスブロックの改ざんを検知', () => {
  const chain = new Blockchain(CHAIN_OPTS);
  chain.minePendingTransactions(miner.address);
  chain.chain[0].timestamp = 12345;
  assert.equal(chain.isChainValid(), false);
});
