'use strict';
/**
 * BtcMiner — Bitcoin プロトコル準拠のマイニング実装(研究・教育用)
 *
 * 実際の Bitcoin のブロックヘッダ形式・ハッシュ計算・難易度エンコーディングを
 * 忠実に実装している。正しさは「本物の Bitcoin ブロック(ジェネシスブロック等)の
 * ハッシュを再現できること」で検証済み (test/btc-miner.test.js)。
 *
 * Bitcoin マイニングの仕組み:
 *  1. 80 バイトのブロックヘッダ(version / prevHash / merkleRoot / time / bits / nonce)
 *     を組み立てる
 *  2. double SHA-256 でハッシュ化する
 *  3. ハッシュ値(256bit 整数)が bits から導かれるターゲット以下なら採掘成功。
 *     そうでなければ nonce を変えて再試行する
 *  4. 成功したブロックのコインベーストランザクションで新規 BTC が発行される
 *
 * 注意: 本実装は CPU で動くリファレンス実装であり、実際の BTC 採掘は
 * ASIC(数百 TH/s)の独壇場のため CPU(数百 kH/s)では経済的に成立しない。
 * その事実自体を estimateMiningEconomics で定量的に確認できる。
 * 依存パッケージなし(Node.js 標準の node:crypto のみ)。
 */

const crypto = require('node:crypto');

/** 難易度 1 のターゲット (bits = 0x1d00ffff) に対応する 2^32 ハッシュ/難易度 */
const HASHES_PER_DIFFICULTY = 4294967296; // 2^32

/** Bitcoin regtest モードと同じ最低難易度 bits (約2回の試行で採掘可能) */
const REGTEST_BITS = 0x207fffff;

/** 本物の Bitcoin ジェネシスブロック (2009-01-03, Satoshi Nakamoto 採掘) */
const GENESIS_BLOCK = {
  version: 1,
  prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
  merkleRoot: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  time: 1231006505,
  bits: 0x1d00ffff,
  nonce: 2083236893,
  hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
};

/** 本物の Bitcoin ブロック #125552 (Bitcoin wiki の Block hashing algorithm 例) */
const BLOCK_125552 = {
  version: 1,
  prevHash: '00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81',
  merkleRoot: '2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3',
  time: 1305998791,
  bits: 0x1a44b9f2,
  nonce: 2504433986,
  hash: '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d'
};

function doubleSha256(buffer) {
  const first = crypto.createHash('sha256').update(buffer).digest();
  return crypto.createHash('sha256').update(first).digest();
}

/** 表示用 hex (ビッグエンディアン) を内部表現 (リトルエンディアン) のバイト列へ */
function hexToInternal(displayHex) {
  return Buffer.from(displayHex, 'hex').reverse();
}

/**
 * 80 バイトのブロックヘッダを構築する。
 * ハッシュ類は Bitcoin の慣例どおり表示用 hex で受け取り、内部では逆順で格納する。
 */
function serializeHeader(fields) {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(fields.version >>> 0, 0);
  hexToInternal(fields.prevHash).copy(header, 4);
  hexToInternal(fields.merkleRoot).copy(header, 36);
  header.writeUInt32LE(fields.time >>> 0, 68);
  header.writeUInt32LE(fields.bits >>> 0, 72);
  header.writeUInt32LE(fields.nonce >>> 0, 76);
  return header;
}

/** ブロックヘッダのハッシュ(表示用 hex)。double SHA-256 して逆順表示 */
function headerHash(fields) {
  return Buffer.from(doubleSha256(serializeHeader(fields))).reverse().toString('hex');
}

/**
 * compact 形式の bits を 256bit ターゲット (BigInt) へ変換する。
 * bits = [1byte 指数][3byte 仮数], target = 仮数 × 256^(指数-3)
 */
function bitsToTarget(bits) {
  const exponent = bits >>> 24;
  const coefficient = BigInt(bits & 0x007fffff);
  if (exponent <= 3) {
    return coefficient >> BigInt(8 * (3 - exponent));
  }
  return coefficient << BigInt(8 * (exponent - 3));
}

/** ターゲット (BigInt) を compact 形式の bits へ変換する */
function targetToBits(target) {
  if (target <= 0n) throw new Error('ターゲットは正の値が必要です');
  let hex = target.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  let exponent = hex.length / 2;
  let coefficient = parseInt(hex.slice(0, 6).padEnd(6, '0'), 16);
  // 仮数の最上位ビットは符号として扱われるため、立っている場合は桁上げする
  if (coefficient & 0x800000) {
    coefficient >>= 8;
    exponent += 1;
  }
  return ((exponent << 24) | coefficient) >>> 0;
}

/** ハッシュ(表示用 hex)がターゲット以下か */
function hashMeetsTarget(hashHex, target) {
  return BigInt('0x' + hashHex) <= target;
}

/** bits から難易度を計算する (難易度1 = bits 0x1d00ffff) */
function bitsToDifficulty(bits) {
  return Number(bitsToTarget(0x1d00ffff)) / Number(bitsToTarget(bits));
}

/**
 * トランザクション ID (表示用 hex) の配列からマークルルートを計算する。
 * ペアごとに double SHA-256、奇数個なら最後の要素を複製(Bitcoin 仕様)。
 */
function calculateMerkleRoot(txids) {
  if (!Array.isArray(txids) || txids.length === 0) {
    throw new Error('txid が1件以上必要です');
  }
  let level = txids.map(hexToInternal);
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(doubleSha256(Buffer.concat([level[i], level[i + 1]])));
    }
    level = next;
  }
  return Buffer.from(level[0]).reverse().toString('hex');
}

/**
 * nonce を探索してブロックヘッダを採掘する。
 *
 * @param {object} fields version/prevHash/merkleRoot/time/bits (nonce は無視される)
 * @param {object} [opts] startNonce / maxNonce / target (省略時は bits から導出)
 * @returns {{found: boolean, nonce: ?number, hash: ?string, attempts: number,
 *            durationMs: number, hashrate: number}}
 */
function mineHeader(fields, opts = {}) {
  const startNonce = opts.startNonce !== undefined ? opts.startNonce : 0;
  const maxNonce = opts.maxNonce !== undefined ? opts.maxNonce : 0xffffffff;
  const target = opts.target !== undefined ? opts.target : bitsToTarget(fields.bits);

  const header = serializeHeader(Object.assign({}, fields, { nonce: startNonce }));
  const started = Date.now();
  let attempts = 0;

  for (let nonce = startNonce; nonce <= maxNonce; nonce++) {
    header.writeUInt32LE(nonce >>> 0, 76);
    attempts++;
    const hashHex = Buffer.from(doubleSha256(header)).reverse().toString('hex');
    if (hashMeetsTarget(hashHex, target)) {
      const durationMs = Date.now() - started;
      return {
        found: true,
        nonce,
        hash: hashHex,
        attempts,
        durationMs,
        hashrate: attempts / Math.max(durationMs, 1) * 1000
      };
    }
  }

  const durationMs = Date.now() - started;
  return {
    found: false,
    nonce: null,
    hash: null,
    attempts,
    durationMs,
    hashrate: attempts / Math.max(durationMs, 1) * 1000
  };
}

/** この CPU の double SHA-256 ハッシュレート (H/s) を実測する */
function measureHashrate(durationMs = 1000) {
  const header = serializeHeader(Object.assign({}, GENESIS_BLOCK, { nonce: 0 }));
  const deadline = Date.now() + durationMs;
  let hashes = 0;
  while (Date.now() < deadline) {
    for (let i = 0; i < 1000; i++) {
      header.writeUInt32LE(hashes >>> 0, 76);
      doubleSha256(header);
      hashes++;
    }
  }
  return hashes / durationMs * 1000;
}

/**
 * マイニングの経済性を試算する(ソロマイニングの期待値ベース。
 * プールマイニングでも手数料を除けば期待値はほぼ同じ)。
 *
 * 期待ブロック数/日 = hashrate × 86400 / (difficulty × 2^32)
 */
function estimateMiningEconomics(params) {
  const {
    hashrateHps,          // 自分のハッシュレート (H/s)
    difficulty,           // ネットワーク難易度
    blockRewardBtc,       // ブロック報酬 (BTC)
    btcPriceJpy,          // BTC 価格 (円)
    powerWatts,           // 消費電力 (W)
    electricityJpyPerKwh  // 電気料金 (円/kWh)
  } = params;

  const hashesPerBlock = difficulty * HASHES_PER_DIFFICULTY;
  const expectedBlocksPerDay = hashrateHps * 86400 / hashesPerBlock;
  const expectedBtcPerDay = expectedBlocksPerDay * blockRewardBtc;
  const revenueJpyPerDay = expectedBtcPerDay * btcPriceJpy;
  const powerCostJpyPerDay = powerWatts / 1000 * 24 * electricityJpyPerKwh;

  return {
    expectedBlocksPerDay,
    expectedBtcPerDay,
    revenueJpyPerDay,
    powerCostJpyPerDay,
    profitJpyPerDay: revenueJpyPerDay - powerCostJpyPerDay,
    daysPerBlock: 1 / expectedBlocksPerDay,
    yearsPerBlock: 1 / expectedBlocksPerDay / 365
  };
}

module.exports = {
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
};
