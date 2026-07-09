'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  HASHES_PER_DIFFICULTY,
  REGTEST_BITS,
  GENESIS_BLOCK,
  BLOCK_125552,
  doubleSha256,
  serializeHeader,
  headerHash,
  bitsToTarget,
  targetToBits,
  hashMeetsTarget,
  bitsToDifficulty,
  calculateMerkleRoot,
  mineHeader,
  measureHashrate,
  estimateMiningEconomics
} = require('../src/BtcMiner');

// ===== 本物の Bitcoin ブロックの再現(実装の正しさの根拠) =====

test('本物のジェネシスブロック (2009-01-03) のハッシュを再現できる', () => {
  assert.equal(headerHash(GENESIS_BLOCK), GENESIS_BLOCK.hash);
});

test('本物のブロック #125552 (2011-05-21) のハッシュを再現できる', () => {
  assert.equal(headerHash(BLOCK_125552), BLOCK_125552.hash);
});

test('ジェネシスブロックのハッシュは当時のターゲットを満たす', () => {
  assert.equal(
    hashMeetsTarget(GENESIS_BLOCK.hash, bitsToTarget(GENESIS_BLOCK.bits)),
    true
  );
});

test('nonce を 1 変えるとハッシュはターゲットを満たさなくなる', () => {
  const tampered = Object.assign({}, GENESIS_BLOCK, { nonce: GENESIS_BLOCK.nonce + 1 });
  const hash = headerHash(tampered);
  assert.notEqual(hash, GENESIS_BLOCK.hash);
  assert.equal(hashMeetsTarget(hash, bitsToTarget(GENESIS_BLOCK.bits)), false);
});

test('serializeHeader: ヘッダは 80 バイト', () => {
  assert.equal(serializeHeader(GENESIS_BLOCK).length, 80);
});

// ===== bits / ターゲット / 難易度 =====

test('bitsToTarget: 難易度1 (0x1d00ffff) のターゲット値', () => {
  assert.equal(
    bitsToTarget(0x1d00ffff).toString(16).padStart(64, '0'),
    '00000000ffff0000000000000000000000000000000000000000000000000000'
  );
});

test('targetToBits: 実在の bits 値をラウンドトリップできる', () => {
  for (const bits of [0x1d00ffff, 0x1a44b9f2, REGTEST_BITS]) {
    assert.equal(targetToBits(bitsToTarget(bits)), bits);
  }
});

test('bitsToDifficulty: 難易度1 と 2011年当時の難易度', () => {
  assert.equal(bitsToDifficulty(0x1d00ffff), 1);
  // ブロック #125552 当時の難易度は約 244,112
  const d = bitsToDifficulty(BLOCK_125552.bits);
  assert.ok(d > 244000 && d < 245000, 'difficulty was ' + d);
});

test('hashMeetsTarget: 大きいハッシュは拒否', () => {
  assert.equal(hashMeetsTarget('f'.repeat(64), bitsToTarget(0x1d00ffff)), false);
});

// ===== マークルルート =====

test('calculateMerkleRoot: txid が1件ならそれ自身 (ジェネシスブロック)', () => {
  // ジェネシスブロックはコインベース1件のみで、マークルルート = その txid
  assert.equal(
    calculateMerkleRoot([GENESIS_BLOCK.merkleRoot]),
    GENESIS_BLOCK.merkleRoot
  );
});

test('calculateMerkleRoot: 2件はペアの double SHA-256 (バイト順も検証)', () => {
  const a = '11'.repeat(32);
  const b = '22'.repeat(32);
  const internal = Buffer.concat([
    Buffer.from(a, 'hex').reverse(),
    Buffer.from(b, 'hex').reverse()
  ]);
  const expected = Buffer.from(doubleSha256(internal)).reverse().toString('hex');
  assert.equal(calculateMerkleRoot([a, b]), expected);
});

test('calculateMerkleRoot: 奇数個は最後の txid を複製 (Bitcoin 仕様)', () => {
  const a = 'aa'.repeat(32);
  const b = 'bb'.repeat(32);
  const c = 'cc'.repeat(32);
  assert.equal(calculateMerkleRoot([a, b, c]), calculateMerkleRoot([a, b, c, c]));
});

test('calculateMerkleRoot: 空配列はエラー', () => {
  assert.throws(() => calculateMerkleRoot([]), /1件以上/);
});

// ===== マイニング =====

test('mineHeader: regtest 難易度なら即座に採掘でき、結果は検証可能', () => {
  const fields = {
    version: 1,
    prevHash: GENESIS_BLOCK.hash,
    merkleRoot: 'ab'.repeat(32),
    time: 1231006505,
    bits: REGTEST_BITS
  };
  const result = mineHeader(fields);

  assert.equal(result.found, true);
  assert.ok(Number.isInteger(result.nonce));
  // 採掘結果は誰でも再検証できる
  const verified = headerHash(Object.assign({}, fields, { nonce: result.nonce }));
  assert.equal(verified, result.hash);
  assert.equal(hashMeetsTarget(result.hash, bitsToTarget(REGTEST_BITS)), true);
});

test('mineHeader: maxNonce まで見つからなければ found=false', () => {
  const fields = {
    version: 1,
    prevHash: '00'.repeat(32),
    merkleRoot: 'cd'.repeat(32),
    time: 1231006505,
    bits: 0x1d00ffff // CPU では事実上見つからない難易度
  };
  const result = mineHeader(fields, { startNonce: 0, maxNonce: 99 });
  assert.equal(result.found, false);
  assert.equal(result.nonce, null);
  assert.equal(result.attempts, 100);
});

test('measureHashrate: 正のハッシュレートを返す', () => {
  const hps = measureHashrate(50);
  assert.ok(hps > 0);
});

// ===== 経済性試算 =====

test('estimateMiningEconomics: 1日1ブロック相当のハッシュレートなら報酬=期待値', () => {
  const difficulty = 1000;
  const hashrateHps = difficulty * HASHES_PER_DIFFICULTY / 86400; // ちょうど1ブロック/日
  const e = estimateMiningEconomics({
    hashrateHps,
    difficulty,
    blockRewardBtc: 3.125,
    btcPriceJpy: 10000000,
    powerWatts: 1000,
    electricityJpyPerKwh: 30
  });
  assert.ok(Math.abs(e.expectedBlocksPerDay - 1) < 1e-9);
  assert.ok(Math.abs(e.expectedBtcPerDay - 3.125) < 1e-9);
  assert.ok(Math.abs(e.revenueJpyPerDay - 31250000) < 1e-3);
  assert.equal(e.powerCostJpyPerDay, 720); // 1kW × 24h × 30円
  assert.ok(Math.abs(e.profitJpyPerDay - (31250000 - 720)) < 1e-3);
  assert.ok(Math.abs(e.daysPerBlock - 1) < 1e-9);
});

test('estimateMiningEconomics: CPU で実際の BTC 難易度はほぼ発掘不能', () => {
  const e = estimateMiningEconomics({
    hashrateHps: 500e3,        // CPU: ~500 kH/s
    difficulty: 124.9e12,      // 2026年7月時点の実難易度
    blockRewardBtc: 3.125,
    btcPriceJpy: 10000000,
    powerWatts: 65,
    electricityJpyPerKwh: 31
  });
  assert.ok(e.yearsPerBlock > 1e9, '10億年以上かかるはず: ' + e.yearsPerBlock);
  assert.ok(e.profitJpyPerDay < 0, '電気代で確実に赤字');
});
