'use strict';
/**
 * SasaCoin — 独自仮想通貨(教育用ブロックチェーン実装)
 *
 * 新しいコインはマイニング(Proof of Work)の報酬としてのみ「生み出される」。
 * ビットコインと同様に、一定ブロックごとに報酬が半減し、発行上限に達すると
 * 新規発行は停止する。
 *
 * 構成要素:
 *  - Wallet      : secp256k1 鍵ペア。公開鍵(DER hex)がそのままアドレス
 *  - Transaction : ECDSA 署名付き送金。fromAddress が null のものは
 *                  マイニング報酬(コインベース)
 *  - Block       : トランザクション群 + 前ブロックハッシュ + nonce。
 *                  先頭 difficulty 桁が 0 になるハッシュを探索して採掘
 *  - Blockchain  : チェーン本体。残高計算・二重支払い防止・改ざん検証
 *
 * 注意: これはローカルで完結する教育用実装であり、P2P ネットワーク・
 * 分散コンセンサス・実際の金銭価値は持たない。依存パッケージなし
 * (Node.js 標準の node:crypto のみ)。
 */

const crypto = require('node:crypto');

const COIN_DEFAULTS = {
  DIFFICULTY: 2,          // ブロックハッシュに要求する先頭 0 の桁数
  MINING_REWARD: 50,      // 初期マイニング報酬
  HALVING_INTERVAL: 10,   // このブロック数ごとに報酬が半減
  MAX_SUPPLY: Infinity    // 発行上限(コイン総数)
};

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * ウォレット(鍵ペア)を生成する。アドレスは公開鍵の DER(SPKI) hex 表現。
 */
function createWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'secp256k1'
  });
  const address = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  return { address, publicKey, privateKey };
}

/** アドレス(DER hex)から検証用の公開鍵オブジェクトを復元する */
function publicKeyFromAddress(address) {
  return crypto.createPublicKey({
    key: Buffer.from(address, 'hex'),
    type: 'spki',
    format: 'der'
  });
}

class Transaction {
  /**
   * @param {?string} fromAddress 送信元アドレス。null ならマイニング報酬
   * @param {string} toAddress 送信先アドレス
   * @param {number} amount 金額
   */
  constructor(fromAddress, toAddress, amount, timestamp = Date.now()) {
    this.fromAddress = fromAddress;
    this.toAddress = toAddress;
    this.amount = amount;
    this.timestamp = timestamp;
    this.signature = null;
  }

  isCoinbase() {
    return this.fromAddress === null;
  }

  calculateHash() {
    return sha256(
      String(this.fromAddress) + String(this.toAddress) +
      String(this.amount) + String(this.timestamp)
    );
  }

  /** 送信元の秘密鍵で署名する */
  sign(privateKey) {
    if (this.isCoinbase()) {
      throw new Error('マイニング報酬に署名は不要です');
    }
    const signer = crypto.createSign('SHA256');
    signer.update(this.calculateHash());
    this.signature = signer.sign(privateKey, 'hex');
    return this;
  }

  /** 署名が fromAddress の公開鍵で検証できるか */
  isValid() {
    if (!this.toAddress || typeof this.amount !== 'number' ||
        !isFinite(this.amount) || this.amount <= 0) {
      return false;
    }
    if (this.isCoinbase()) return true;
    if (!this.signature) return false;
    try {
      const verifier = crypto.createVerify('SHA256');
      verifier.update(this.calculateHash());
      return verifier.verify(publicKeyFromAddress(this.fromAddress), this.signature, 'hex');
    } catch (e) {
      return false;
    }
  }
}

class Block {
  constructor(timestamp, transactions, previousHash) {
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.nonce = 0;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return sha256(
      this.previousHash + String(this.timestamp) +
      JSON.stringify(this.transactions) + String(this.nonce)
    );
  }

  /**
   * Proof of Work: 先頭 difficulty 桁が 0 のハッシュが見つかるまで
   * nonce を増やして探索する。
   */
  mineBlock(difficulty) {
    const target = '0'.repeat(difficulty);
    while (!this.hash.startsWith(target)) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
    return this;
  }

  hasValidTransactions() {
    return this.transactions.every((tx) => tx.isValid());
  }
}

class Blockchain {
  constructor(opts = {}) {
    this.difficulty = opts.difficulty !== undefined ? opts.difficulty : COIN_DEFAULTS.DIFFICULTY;
    this.miningReward = opts.miningReward !== undefined ? opts.miningReward : COIN_DEFAULTS.MINING_REWARD;
    this.halvingInterval = opts.halvingInterval !== undefined ? opts.halvingInterval : COIN_DEFAULTS.HALVING_INTERVAL;
    this.maxSupply = opts.maxSupply !== undefined ? opts.maxSupply : COIN_DEFAULTS.MAX_SUPPLY;
    this.chain = [this.createGenesisBlock()];
    this.pendingTransactions = [];
  }

  /** 全ノードで同一になるよう、固定タイムスタンプのジェネシスブロックを生成 */
  createGenesisBlock() {
    return new Block(0, [], '0');
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * 指定ブロック高でのマイニング報酬(半減期適用後)。
   * 高さ 1..halvingInterval は初期報酬、以降は半減していく。
   */
  rewardForHeight(height) {
    const halvings = Math.floor((height - 1) / this.halvingInterval);
    let reward = this.miningReward;
    for (let i = 0; i < halvings && reward > 0; i++) {
      reward = Math.floor(reward / 2);
    }
    return reward;
  }

  /** これまでに発行(採掘)されたコインの総量 */
  getTotalSupply() {
    let supply = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.isCoinbase()) supply += tx.amount;
      }
    }
    return supply;
  }

  /**
   * 保留中トランザクションをブロックにまとめて採掘する。
   * 採掘者への報酬(コインベース)として新しいコインがここで生み出される。
   * 発行上限に達すると報酬は 0 になる(トランザクション処理は継続)。
   *
   * @returns {Block} 採掘されたブロック
   */
  minePendingTransactions(minerAddress) {
    if (!minerAddress) {
      throw new Error('採掘者のアドレスが必要です');
    }

    const height = this.chain.length;
    const reward = Math.min(this.rewardForHeight(height), this.maxSupply - this.getTotalSupply());

    const transactions = [];
    if (reward > 0) {
      transactions.push(new Transaction(null, minerAddress, reward));
    }
    transactions.push(...this.pendingTransactions);

    const block = new Block(Date.now(), transactions, this.getLatestBlock().hash);
    block.mineBlock(this.difficulty);

    this.chain.push(block);
    this.pendingTransactions = [];
    return block;
  }

  /**
   * 送金トランザクションを保留リストへ追加する。
   * 署名・金額・残高(保留中の支出も考慮)を検証する。
   */
  addTransaction(transaction) {
    if (!(transaction instanceof Transaction)) {
      throw new Error('Transaction インスタンスが必要です');
    }
    if (transaction.isCoinbase()) {
      throw new Error('マイニング報酬を直接追加することはできません');
    }
    if (!transaction.isValid()) {
      throw new Error('署名が無効なトランザクションです');
    }

    const available =
      this.getBalanceOfAddress(transaction.fromAddress) -
      this.getPendingOutgoing(transaction.fromAddress);
    if (transaction.amount > available) {
      throw new Error('残高不足です (利用可能: ' + available + ')');
    }

    this.pendingTransactions.push(transaction);
    return this;
  }

  /** 確定済みブロックから残高を計算する */
  getBalanceOfAddress(address) {
    let balance = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.fromAddress === address) balance -= tx.amount;
        if (tx.toAddress === address) balance += tx.amount;
      }
    }
    return balance;
  }

  /** 保留中トランザクションによる支出合計(二重支払い防止用) */
  getPendingOutgoing(address) {
    let total = 0;
    for (const tx of this.pendingTransactions) {
      if (tx.fromAddress === address) total += tx.amount;
    }
    return total;
  }

  /**
   * チェーン全体の整合性を検証する。
   *  - ブロックのハッシュ再計算・前ブロックとのリンク・PoW 条件
   *  - 各トランザクションの署名
   *  - コインベースの個数(ブロックあたり最大1件)と報酬額(半減期・発行上限)
   *  - 残高リプレイ(どのアドレスも残高がマイナスにならないこと)
   */
  isChainValid() {
    const genesis = this.chain[0];
    if (genesis.hash !== genesis.calculateHash() || genesis.previousHash !== '0') {
      return false;
    }

    const target = '0'.repeat(this.difficulty);
    const balances = {};
    let supply = 0;

    for (let i = 1; i < this.chain.length; i++) {
      const block = this.chain[i];
      const prev = this.chain[i - 1];

      if (block.previousHash !== prev.hash) return false;
      if (block.hash !== block.calculateHash()) return false;
      if (!block.hash.startsWith(target)) return false;
      if (!block.hasValidTransactions()) return false;

      const coinbases = block.transactions.filter((tx) => tx.isCoinbase());
      if (coinbases.length > 1) return false;
      if (coinbases.length === 1) {
        const allowed = Math.min(this.rewardForHeight(i), this.maxSupply - supply);
        if (coinbases[0].amount > allowed) return false;
        supply += coinbases[0].amount;
      }

      // 残高リプレイ: 発行されていないコインを使っていないか
      for (const tx of block.transactions) {
        if (!tx.isCoinbase()) {
          balances[tx.fromAddress] = (balances[tx.fromAddress] || 0) - tx.amount;
          if (balances[tx.fromAddress] < 0) return false;
        }
        balances[tx.toAddress] = (balances[tx.toAddress] || 0) + tx.amount;
      }
    }
    return true;
  }
}

module.exports = {
  COIN_DEFAULTS,
  sha256,
  createWallet,
  publicKeyFromAddress,
  Transaction,
  Block,
  Blockchain
};
