'use strict';
/**
 * BtcMiner デモ — Bitcoin マイニングの研究結果を実際に動かして確認する
 * 実行: node src/btc-miner-demo.js
 */

const {
  GENESIS_BLOCK,
  BLOCK_125552,
  REGTEST_BITS,
  HASHES_PER_DIFFICULTY,
  headerHash,
  bitsToTarget,
  bitsToDifficulty,
  mineHeader,
  measureHashrate,
  estimateMiningEconomics
} = require('./BtcMiner');

const jpy = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');

console.log('=== BTC マイニングシステム デモ ===\n');

console.log('1) 研究の検証: 本物の Bitcoin ブロックのハッシュを再現');
console.log('   ジェネシスブロック (2009-01-03, Satoshi Nakamoto):');
console.log('     再現: ' + headerHash(GENESIS_BLOCK));
console.log('     実物: ' + GENESIS_BLOCK.hash);
console.log('     一致: ' + (headerHash(GENESIS_BLOCK) === GENESIS_BLOCK.hash ? '✅' : '❌'));
console.log('   ブロック #125552 (2011-05-21):');
console.log('     一致: ' + (headerHash(BLOCK_125552) === BLOCK_125552.hash ? '✅' : '❌'));

console.log('\n2) 難易度の仕組み: bits → ターゲット');
console.log('   難易度1 (0x1d00ffff): target=' +
  bitsToTarget(0x1d00ffff).toString(16).padStart(64, '0').slice(0, 20) + '…');
console.log('   2011年 (0x1a44b9f2): 難易度 ' +
  Math.round(bitsToDifficulty(BLOCK_125552.bits)).toLocaleString());
console.log('   2026年7月時点の実難易度: 約 124,900,000,000,000 (124.9兆)');

console.log('\n3) 実際に採掘してみる (regtest 相当の最低難易度)');
const easy = mineHeader({
  version: 1,
  prevHash: GENESIS_BLOCK.hash,
  merkleRoot: 'ab'.repeat(32),
  time: Math.floor(Date.now() / 1000),
  bits: REGTEST_BITS
});
console.log('   ⛏️ found nonce=' + easy.nonce + ' (試行 ' + easy.attempts + ' 回)');
console.log('   hash=' + easy.hash.slice(0, 24) + '…');

console.log('\n4) もう少し高い難易度 (先頭8桁が0、平均 ~6.6万試行)');
const harder = mineHeader({
  version: 1,
  prevHash: GENESIS_BLOCK.hash,
  merkleRoot: 'cd'.repeat(32),
  time: Math.floor(Date.now() / 1000),
  bits: 0x1f00ffff
});
console.log('   ⛏️ found nonce=' + harder.nonce + ' (試行 ' + harder.attempts.toLocaleString() +
  ' 回, ' + harder.durationMs + 'ms, ' + Math.round(harder.hashrate).toLocaleString() + ' H/s)');
console.log('   hash=' + harder.hash.slice(0, 24) + '…');

console.log('\n5) この CPU のハッシュレートを実測');
const cpuHps = measureHashrate(2000);
console.log('   ' + Math.round(cpuHps).toLocaleString() + ' H/s (double SHA-256)');

console.log('\n6) 経済性試算 (2026年7月の実データ: 難易度124.9兆, BTC≈¥1,000万, 報酬3.125BTC)');
const params = {
  difficulty: 124.9e12,
  blockRewardBtc: 3.125,
  btcPriceJpy: 10000000,
  electricityJpyPerKwh: 31 // 日本の平均的な電気料金
};

const cpu = estimateMiningEconomics({ ...params, hashrateHps: cpuHps, powerWatts: 65 });
console.log('   【この CPU】');
console.log('     1ブロック発掘までの期待時間: ' + cpu.yearsPerBlock.toExponential(2) + ' 年');
console.log('     期待収益: ' + jpy(cpu.revenueJpyPerDay) + '/日, 電気代: ' +
  jpy(cpu.powerCostJpyPerDay) + '/日 → 損益 ' + jpy(cpu.profitJpyPerDay) + '/日');

const asic = estimateMiningEconomics({ ...params, hashrateHps: 200e12, powerWatts: 3550 });
console.log('   【最新 ASIC (Antminer S21 相当: 200 TH/s, 3550W)】');
console.log('     ソロ発掘の期待時間: ' + Math.round(asic.yearsPerBlock) + ' 年 → プール参加が前提');
console.log('     期待収益: ' + jpy(asic.revenueJpyPerDay) + '/日, 電気代(日本): ' +
  jpy(asic.powerCostJpyPerDay) + '/日 → 損益 ' + jpy(asic.profitJpyPerDay) + '/日');

const asicCheap = estimateMiningEconomics({ ...params, hashrateHps: 200e12, powerWatts: 3550, electricityJpyPerKwh: 8 });
console.log('   【同 ASIC を電気代 ¥8/kWh の地域で運用】');
console.log('     損益 ' + jpy(asicCheap.profitJpyPerDay) + '/日');

console.log('\n結論: BTC マイニングは「安価な電力 × ASIC × プール参加」が成立条件。');
console.log('CPU/GPU での BTC 採掘は物理的に不可能ではないが経済的に成立しない。');
