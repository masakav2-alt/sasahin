'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCrypto } = require('./helpers/load');
const {
  createPropertiesMock,
  createLockMock,
  createGmailMock,
  createUrlFetchMock,
  createSessionMock
} = require('./helpers/gas-mocks');

/** closes 配列を CoinGecko market_chart レスポンスに変換 */
const marketChart = (closes) =>
  JSON.stringify({ prices: closes.map((c, i) => [i * 86400000, c]) });

// ゴールデンクロスで BUY になる終値系列 (SMA2/SMA3, RSI3 前提)
const BUY_SERIES = [10, 10, 10, 9, 12];
// デッドクロスで SELL になる終値系列
const SELL_SERIES = [10, 10, 10, 11, 8];
// 横ばい (HOLD)
const HOLD_SERIES = [10, 10, 10, 10, 10];

/**
 * テスト用にモック一式を組み立てて CryptoBot.gs を読み込む。
 * fetchHandler(url, options, callIndex) -> { status, body }
 */
function setup({ props = {}, acquirable = true, fetchHandler } = {}) {
  const properties = createPropertiesMock(props);
  const lock = createLockMock({ acquirable });
  const gmail = createGmailMock();
  const urlFetch = createUrlFetchMock(fetchHandler || (() => ({ status: 200, body: '{}' })));

  const code = loadCrypto({
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => lock.lock },
    GmailApp: gmail.GmailApp,
    UrlFetchApp: urlFetch.UrlFetchApp,
    ...createSessionMock('user@example.com')
  });

  // テストしやすい小さな期間に設定
  Object.assign(code.CRYPTO_CONFIG, {
    COINS: [{ id: 'bitcoin', symbol: 'BTC' }],
    SMA_SHORT: 2,
    SMA_LONG: 3,
    RSI_PERIOD: 3,
    RSI_OVERBOUGHT: 90,
    RSI_OVERSOLD: 10,
    INTER_REQUEST_DELAY_MS: 0
  });

  return { code, properties, lock, gmail, urlFetch };
}

const NOTION_PROPS = {
  NOTION_API_KEY: 'notion-key',
  TRADES_DATABASE_ID: 'trades-db-id'
};

const coingeckoThenNotion = (closes) => (url) => {
  if (url.includes('coingecko')) return { status: 200, body: marketChart(closes) };
  if (url.includes('notion')) return { status: 200, body: '{}' };
  throw new Error('unexpected url: ' + url);
};

test('フルフロー: BUY シグナルで仮想売買・Notion 記録・メール通知', () => {
  const { code, properties, lock, gmail, urlFetch } = setup({
    props: NOTION_PROPS,
    fetchHandler: coingeckoThenNotion(BUY_SERIES)
  });

  code.autoCryptoTrade();

  // ポートフォリオが保存されている
  const portfolio = JSON.parse(properties._store.CRYPTO_PORTFOLIO);
  assert.equal(portfolio.cashJpy, 80000); // 100000 - 20000
  assert.equal(portfolio.holdings.BTC.qty, (20000 - 30) / 12);
  assert.equal(portfolio.holdings.BTC.costJpy, 20000);
  assert.equal(portfolio.lastTradeDay.BTC, code.toIsoDate(new Date()));

  // CoinGecko 1回 + Notion 1回
  const urls = urlFetch.requests.map((r) => r.url);
  assert.equal(urls.filter((u) => u.includes('coingecko')).length, 1);
  assert.equal(urls.filter((u) => u.includes('notion')).length, 1);

  // Notion リクエストの内容
  const notionReq = urlFetch.requests.find((r) => r.url.includes('notion'));
  const payload = JSON.parse(notionReq.options.payload);
  assert.equal(payload.parent.database_id, 'trades-db-id');
  assert.equal(payload.properties['売買'].rich_text[0].text.content, 'BUY');
  assert.equal(payload.properties['通貨'].rich_text[0].text.content, 'BTC');

  // メール通知
  assert.equal(gmail.sentEmails.length, 1);
  assert.equal(gmail.sentEmails[0].to, 'user@example.com');
  assert.ok(gmail.sentEmails[0].subject.includes('BUY BTC'));
  assert.ok(gmail.sentEmails[0].body.includes('シミュレーション'));

  // ロック解放
  assert.equal(lock.calls.releaseLock, 1);
});

test('同日の再実行では重複売買しない', () => {
  const { code, properties, urlFetch } = setup({
    props: NOTION_PROPS,
    fetchHandler: coingeckoThenNotion(BUY_SERIES)
  });

  code.autoCryptoTrade();
  const after1 = properties._store.CRYPTO_PORTFOLIO;
  code.autoCryptoTrade();
  const after2 = properties._store.CRYPTO_PORTFOLIO;

  assert.equal(after1, after2);
  const urls = urlFetch.requests.map((r) => r.url);
  assert.equal(urls.filter((u) => u.includes('notion')).length, 1); // 2回目は取引なし
});

test('ロックが取れない場合は何もしない', () => {
  const { code, urlFetch, gmail } = setup({
    props: NOTION_PROPS,
    acquirable: false,
    fetchHandler: coingeckoThenNotion(BUY_SERIES)
  });

  code.autoCryptoTrade();

  assert.equal(urlFetch.requests.length, 0);
  assert.equal(gmail.sentEmails.length, 0);
});

test('HOLD シグナルでは取引・記録・通知を行わない', () => {
  const { code, properties, urlFetch, gmail } = setup({
    props: NOTION_PROPS,
    fetchHandler: coingeckoThenNotion(HOLD_SERIES)
  });

  code.autoCryptoTrade();

  assert.equal(properties._store.CRYPTO_PORTFOLIO, undefined);
  const urls = urlFetch.requests.map((r) => r.url);
  assert.equal(urls.filter((u) => u.includes('notion')).length, 0);
  assert.equal(gmail.sentEmails.length, 0);
});

test('保有なしの SELL シグナルは取引しない', () => {
  const { code, properties, urlFetch, gmail } = setup({
    props: NOTION_PROPS,
    fetchHandler: coingeckoThenNotion(SELL_SERIES)
  });

  code.autoCryptoTrade();

  assert.equal(properties._store.CRYPTO_PORTFOLIO, undefined);
  assert.equal(urlFetch.requests.map((r) => r.url).filter((u) => u.includes('notion')).length, 0);
  assert.equal(gmail.sentEmails.length, 0);
});

test('CoinGecko の一時エラー(5xx)はリトライして成功する', () => {
  let coingeckoCalls = 0;
  const { code, properties } = setup({
    props: NOTION_PROPS,
    fetchHandler: (url) => {
      if (url.includes('coingecko')) {
        coingeckoCalls++;
        if (coingeckoCalls < 3) return { status: 500, body: 'server error' };
        return { status: 200, body: marketChart(BUY_SERIES) };
      }
      return { status: 200, body: '{}' };
    }
  });

  code.autoCryptoTrade();

  assert.equal(coingeckoCalls, 3);
  const portfolio = JSON.parse(properties._store.CRYPTO_PORTFOLIO);
  assert.equal(portfolio.cashJpy, 80000);
});

test('CoinGecko が失敗し続けてもクラッシュせずロックを解放する', () => {
  const { code, properties, gmail, lock } = setup({
    props: NOTION_PROPS,
    fetchHandler: (url) => {
      if (url.includes('coingecko')) return { status: 500, body: 'down' };
      return { status: 200, body: '{}' };
    }
  });

  assert.doesNotThrow(() => code.autoCryptoTrade());
  assert.equal(properties._store.CRYPTO_PORTFOLIO, undefined);
  assert.equal(gmail.sentEmails.length, 0); // コイン単位の失敗ではエラーメールを送らない
  assert.equal(lock.calls.releaseLock, 1);
});

test('Notion 未設定でも取引とメール通知は行う', () => {
  const { code, properties, urlFetch, gmail } = setup({
    props: {}, // NOTION_API_KEY / TRADES_DATABASE_ID なし
    fetchHandler: coingeckoThenNotion(BUY_SERIES)
  });

  code.autoCryptoTrade();

  const portfolio = JSON.parse(properties._store.CRYPTO_PORTFOLIO);
  assert.equal(portfolio.cashJpy, 80000);
  assert.equal(urlFetch.requests.map((r) => r.url).filter((u) => u.includes('notion')).length, 0);
  assert.equal(gmail.sentEmails.length, 1);
});

test('Notion への記録が失敗しても取引自体は反映される', () => {
  const { code, properties, gmail } = setup({
    props: NOTION_PROPS,
    fetchHandler: (url) => {
      if (url.includes('coingecko')) return { status: 200, body: marketChart(BUY_SERIES) };
      return { status: 400, body: 'bad request' }; // Notion 即時失敗
    }
  });

  code.autoCryptoTrade();

  const portfolio = JSON.parse(properties._store.CRYPTO_PORTFOLIO);
  assert.equal(portfolio.cashJpy, 80000);
  assert.equal(gmail.sentEmails.length, 1); // 取引通知は送られる
});

test('BUY → 翌日の SELL で保有を清算し実現損益を計上', () => {
  // 前日に BUY 済みのポートフォリオを直接用意し、SELL シグナルの日をシミュレート
  const initial = {
    cashJpy: 80000,
    holdings: { BTC: { qty: 1997, costJpy: 20000 } },
    realizedPnlJpy: 0,
    lastTradeDay: { BTC: '2000-01-01' } // 過去日なので取引可能
  };
  const { code, properties, gmail } = setup({
    props: Object.assign({ CRYPTO_PORTFOLIO: JSON.stringify(initial) }, NOTION_PROPS),
    fetchHandler: coingeckoThenNotion(SELL_SERIES) // 最終価格 8
  });

  code.autoCryptoTrade();

  const portfolio = JSON.parse(properties._store.CRYPTO_PORTFOLIO);
  const proceeds = 1997 * 8;                    // 15976
  const fee = Math.round(proceeds * 0.0015);    // 24
  assert.equal(portfolio.cashJpy, 80000 + proceeds - fee);
  assert.equal(portfolio.realizedPnlJpy, proceeds - fee - 20000);
  assert.equal(portfolio.holdings.BTC, undefined);
  assert.ok(gmail.sentEmails[0].subject.includes('SELL BTC'));
});
