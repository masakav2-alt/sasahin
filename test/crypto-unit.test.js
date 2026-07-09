'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCrypto } = require('./helpers/load');

const code = loadCrypto();

// decideSignal テスト用の共通オプション(小さい期間で検証しやすくする)
const SIGNAL_OPTS = {
  smaShort: 2,
  smaLong: 3,
  rsiPeriod: 3,
  rsiOverbought: 90,
  rsiOversold: 10
};

// ===== calculateSMA =====

test('calculateSMA: 直近 period 本の平均を返す', () => {
  assert.equal(code.calculateSMA([1, 2, 3, 4, 5], 2), 4.5);
  assert.equal(code.calculateSMA([1, 2, 3, 4, 5], 5), 3);
  assert.equal(code.calculateSMA([10], 1), 10);
});

test('calculateSMA: データ不足・不正入力で null', () => {
  assert.equal(code.calculateSMA([1, 2], 3), null);
  assert.equal(code.calculateSMA([], 1), null);
  assert.equal(code.calculateSMA(null, 2), null);
  assert.equal(code.calculateSMA([1, 2, 3], 0), null);
});

// ===== calculateRSI =====

test('calculateRSI: 上昇のみで 100', () => {
  assert.equal(code.calculateRSI([10, 11, 12, 13], 3), 100);
});

test('calculateRSI: 下落のみで 0', () => {
  assert.equal(code.calculateRSI([13, 12, 11, 10], 3), 0);
});

test('calculateRSI: 変動なしは中立の 50 (100 と誤判定しない)', () => {
  assert.equal(code.calculateRSI([10, 10, 10, 10], 3), 50);
});

test('calculateRSI: 混合ケース (Wilder 初期平均)', () => {
  // 変化: +2, -1 → avgGain=1, avgLoss=0.5, RS=2, RSI=100-100/3
  const rsi = code.calculateRSI([10, 12, 11], 2);
  assert.ok(Math.abs(rsi - (100 - 100 / 3)) < 1e-9);
});

test('calculateRSI: データ不足で null', () => {
  assert.equal(code.calculateRSI([10, 11, 12], 3), null); // period+1 本必要
  assert.equal(code.calculateRSI(null, 3), null);
});

// ===== decideSignal =====

test('decideSignal: ゴールデンクロスで BUY', () => {
  // 前日: SMA2=9.5 <= SMA3≈9.67 / 当日: SMA2=10.5 > SMA3≈10.33
  const s = code.decideSignal([10, 10, 10, 9, 12], SIGNAL_OPTS);
  assert.equal(s.action, 'BUY');
  assert.ok(s.reason.includes('ゴールデンクロス'));
});

test('decideSignal: RSI が買われすぎのときはゴールデンクロスでも BUY しない', () => {
  // 同じクロスでも閾値を下げれば RSI(≈81.8)が引っかかり SELL 側の判定になる
  const s = code.decideSignal([10, 10, 10, 9, 12], Object.assign({}, SIGNAL_OPTS, { rsiOverbought: 70 }));
  assert.notEqual(s.action, 'BUY');
});

test('decideSignal: デッドクロスで SELL', () => {
  // 前日: SMA2=10.5 >= SMA3≈10.33 / 当日: SMA2=9.5 < SMA3≈9.67
  const s = code.decideSignal([10, 10, 10, 11, 8], SIGNAL_OPTS);
  assert.equal(s.action, 'SELL');
  assert.ok(s.reason.includes('デッドクロス'));
});

test('decideSignal: 横ばいは HOLD', () => {
  const s = code.decideSignal([10, 10, 10, 10, 10], SIGNAL_OPTS);
  assert.equal(s.action, 'HOLD');
});

test('decideSignal: クロスなしでも RSI 売られすぎで BUY (逆張り)', () => {
  // 一貫した下落: クロスは発生せず RSI=0
  const s = code.decideSignal([20, 19, 18, 17, 16], SIGNAL_OPTS);
  assert.equal(s.action, 'BUY');
  assert.ok(s.reason.includes('売られすぎ'));
});

test('decideSignal: クロスなしでも RSI 買われすぎで SELL', () => {
  // 一貫した上昇: RSI=100
  const s = code.decideSignal([10, 11, 12, 13, 14], SIGNAL_OPTS);
  assert.equal(s.action, 'SELL');
  assert.ok(s.reason.includes('買われすぎ'));
});

test('decideSignal: データ不足で HOLD', () => {
  const s = code.decideSignal([10, 11, 12], SIGNAL_OPTS); // smaLong+1=4 本必要
  assert.equal(s.action, 'HOLD');
  assert.equal(s.reason, 'データ不足');
});

// ===== executePaperTrade =====

const TRADE_OPTS = { tradeFraction: 0.2, minTradeJpy: 1000, feeRate: 0.0015 };

test('executePaperTrade: BUY で現金が減り保有が増える(手数料込み)', () => {
  const portfolio = code.createInitialPortfolio(100000);
  const r = code.executePaperTrade(portfolio, 'BTC', 12, 'BUY', TRADE_OPTS);

  assert.ok(r.trade);
  assert.equal(r.trade.action, 'BUY');
  assert.equal(r.trade.amountJpy, 20000);          // 100000 × 0.2
  assert.equal(r.trade.feeJpy, 30);                // 20000 × 0.0015
  assert.equal(r.trade.qty, (20000 - 30) / 12);
  assert.equal(r.portfolio.cashJpy, 80000);
  assert.equal(r.portfolio.holdings.BTC.qty, (20000 - 30) / 12);
  assert.equal(r.portfolio.holdings.BTC.costJpy, 20000);
  // 元のポートフォリオは破壊しない
  assert.equal(portfolio.cashJpy, 100000);
  assert.deepEqual(portfolio.holdings, {});
});

test('executePaperTrade: 予算が最低取引額未満なら BUY しない', () => {
  const portfolio = code.createInitialPortfolio(1000); // 予算 200 < 1000
  const r = code.executePaperTrade(portfolio, 'BTC', 12, 'BUY', TRADE_OPTS);
  assert.equal(r.trade, null);
  assert.ok(r.skippedReason.includes('現金不足'));
  assert.equal(r.portfolio.cashJpy, 1000);
});

test('executePaperTrade: SELL で全量売却し実現損益を計上', () => {
  let portfolio = code.createInitialPortfolio(100000);
  portfolio = code.executePaperTrade(portfolio, 'BTC', 10, 'BUY', TRADE_OPTS).portfolio;
  // 保有: qty=(20000-30)/10=1997, costJpy=20000, 現金=80000

  const r = code.executePaperTrade(portfolio, 'BTC', 20, 'SELL', TRADE_OPTS);
  assert.ok(r.trade);
  assert.equal(r.trade.action, 'SELL');

  const proceeds = 1997 * 20;                       // 39940
  const fee = Math.round(proceeds * 0.0015);        // 60
  const net = proceeds - fee;                       // 39880
  assert.equal(r.trade.feeJpy, fee);
  assert.equal(r.trade.amountJpy, net);
  assert.equal(r.trade.realizedPnlJpy, net - 20000);
  assert.equal(r.portfolio.cashJpy, 80000 + net);
  assert.equal(r.portfolio.realizedPnlJpy, net - 20000);
  assert.equal(r.portfolio.holdings.BTC, undefined);
});

test('executePaperTrade: 保有なしでは SELL しない', () => {
  const portfolio = code.createInitialPortfolio(100000);
  const r = code.executePaperTrade(portfolio, 'BTC', 12, 'SELL', TRADE_OPTS);
  assert.equal(r.trade, null);
  assert.equal(r.skippedReason, '保有なし');
});

test('executePaperTrade: 不正な価格では取引しない', () => {
  const portfolio = code.createInitialPortfolio(100000);
  assert.equal(code.executePaperTrade(portfolio, 'BTC', 0, 'BUY', TRADE_OPTS).trade, null);
  assert.equal(code.executePaperTrade(portfolio, 'BTC', NaN, 'BUY', TRADE_OPTS).trade, null);
  assert.equal(code.executePaperTrade(portfolio, 'BTC', -5, 'BUY', TRADE_OPTS).trade, null);
});

test('executePaperTrade: HOLD では何もしない', () => {
  const portfolio = code.createInitialPortfolio(100000);
  const r = code.executePaperTrade(portfolio, 'BTC', 12, 'HOLD', TRADE_OPTS);
  assert.equal(r.trade, null);
  assert.deepEqual(r.portfolio, portfolio);
});

test('executePaperTrade: 買い増しで数量とコストが積み上がる', () => {
  let portfolio = code.createInitialPortfolio(100000);
  portfolio = code.executePaperTrade(portfolio, 'BTC', 10, 'BUY', TRADE_OPTS).portfolio;
  const r = code.executePaperTrade(portfolio, 'BTC', 10, 'BUY', TRADE_OPTS);
  // 2回目の予算: floor(80000×0.2)=16000, 手数料24
  assert.equal(r.portfolio.holdings.BTC.costJpy, 20000 + 16000);
  assert.equal(r.portfolio.holdings.BTC.qty, (20000 - 30) / 10 + (16000 - 24) / 10);
});

// ===== parsePortfolio =====

test('parsePortfolio: 保存した JSON を復元できる', () => {
  const original = code.createInitialPortfolio(50000);
  original.holdings.BTC = { qty: 1.5, costJpy: 30000 };
  original.lastTradeDay.BTC = '2026-07-09';
  const restored = code.parsePortfolio(JSON.stringify(original), 100000);
  assert.deepEqual(restored, original);
});

test('parsePortfolio: 壊れた JSON・不正値は初期ポートフォリオにフォールバック', () => {
  const initial = code.createInitialPortfolio(100000);
  assert.deepEqual(code.parsePortfolio(null, 100000), initial);
  assert.deepEqual(code.parsePortfolio('', 100000), initial);
  assert.deepEqual(code.parsePortfolio('{broken json', 100000), initial);
  assert.deepEqual(code.parsePortfolio('"just a string"', 100000), initial);
  assert.deepEqual(code.parsePortfolio('{"cashJpy":"abc"}', 100000), initial);
});

test('parsePortfolio: 欠けたフィールドを補完する', () => {
  const restored = code.parsePortfolio('{"cashJpy": 12345}', 100000);
  assert.deepEqual(restored, {
    cashJpy: 12345,
    holdings: {},
    realizedPnlJpy: 0,
    lastTradeDay: {}
  });
});

// ===== extractClosesFromMarketChart =====

test('extractClosesFromMarketChart: prices 配列から終値のみ抽出', () => {
  const json = { prices: [[1000, 10.5], [2000, 11], [3000, 12.25]] };
  assert.deepEqual(code.extractClosesFromMarketChart(json), [10.5, 11, 12.25]);
});

test('extractClosesFromMarketChart: 不正な要素を除外し、不正入力で空配列', () => {
  const json = { prices: [[1000, 10], [2000, null], 'garbage', [3000, NaN], [4000, 20]] };
  assert.deepEqual(code.extractClosesFromMarketChart(json), [10, 20]);
  assert.deepEqual(code.extractClosesFromMarketChart(null), []);
  assert.deepEqual(code.extractClosesFromMarketChart({}), []);
});

// ===== buildTradeNotionProperties =====

test('buildTradeNotionProperties: BUY の取引記録を構築', () => {
  const trade = {
    symbol: 'BTC', action: 'BUY', priceJpy: 1000000, qty: 0.01,
    amountJpy: 20000, feeJpy: 30, reason: 'ゴールデンクロス', at: '2026-07-09'
  };
  const portfolio = { cashJpy: 80000.4, realizedPnlJpy: 0 };
  const props = code.buildTradeNotionProperties(trade, portfolio);

  assert.equal(props['名前'].title[0].text.content, 'BUY BTC @ ¥1,000,000');
  assert.equal(props['通貨'].rich_text[0].text.content, 'BTC');
  assert.equal(props['売買'].rich_text[0].text.content, 'BUY');
  assert.equal(props['価格'].number, 1000000);
  assert.equal(props['数量'].number, 0.01);
  assert.equal(props['金額'].number, 20000);
  assert.equal(props['手数料'].number, 30);
  assert.equal(props['理由'].rich_text[0].text.content, 'ゴールデンクロス');
  assert.equal(props['日時'].date.start, '2026-07-09');
  assert.equal(props['現金残高'].number, 80000);
  assert.equal(props['実現損益'], undefined); // BUY には付かない
});

test('buildTradeNotionProperties: SELL は実現損益を含む', () => {
  const trade = {
    symbol: 'ETH', action: 'SELL', priceJpy: 500000, qty: 0.1,
    amountJpy: 49925, feeJpy: 75, realizedPnlJpy: 9925.6, reason: 'デッドクロス', at: '2026-07-09'
  };
  const props = code.buildTradeNotionProperties(trade, { cashJpy: 129925, realizedPnlJpy: 9925.6 });
  assert.equal(props['実現損益'].number, 9926);
});

// ===== formatJpy / toIsoDate =====

test('formatJpy: 3桁区切り・四捨五入・負数対応', () => {
  assert.equal(code.formatJpy(1234567), '¥1,234,567');
  assert.equal(code.formatJpy(1000), '¥1,000');
  assert.equal(code.formatJpy(999.6), '¥1,000');
  assert.equal(code.formatJpy(0), '¥0');
  assert.equal(code.formatJpy(-12345), '-¥12,345');
});

test('toIsoDate: ローカルタイムゾーンで YYYY-MM-DD', () => {
  assert.equal(code.toIsoDate(new Date(2026, 6, 9)), '2026-07-09');
  assert.equal(code.toIsoDate(new Date(2026, 0, 1)), '2026-01-01');
});
