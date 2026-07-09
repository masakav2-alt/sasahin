/**
 * autoCryptoTrade
 * 仮想通貨の自動売買シミュレーション(ペーパートレード)を行う Google Apps Script。
 * 時間主導型トリガーでの定期実行(1日1回程度)を想定。
 *
 * 仕組み:
 *  - CoinGecko の公開 API (APIキー不要) から日足の価格履歴を取得
 *  - SMA(単純移動平均)のゴールデンクロス/デッドクロスと RSI でシグナルを判定
 *  - スクリプトプロパティに保存した仮想ポートフォリオに対して売買を執行
 *  - 取引を Notion データベースへ記録し、メールで通知
 *
 * 重要: 実際の資産は一切動かしません(ペーパートレード)。
 * 実売買へ拡張する場合は executePaperTrade の呼び出し箇所を
 * 取引所 API 呼び出しに差し替えてください。利益を保証するものではありません。
 *
 * 設計メモ:
 *  - src/Code.gs と同じ方針で、GAS 固有 API に依存する処理と純粋なロジック
 *    (指標計算・シグナル判定・売買計算)を分離している。
 *  - 純粋関数は Node.js + node:test で単体テスト可能 (test/ 配下)。
 *  - Code.gs と同一プロジェクトに貼り付けても衝突しないよう、
 *    トップレベルの名前はすべて Code.gs と重複しないものにしている。
 */

// ===== 定数 =====
var CRYPTO_CONFIG = {
  COINS: [
    { id: 'bitcoin', symbol: 'BTC' },
    { id: 'ethereum', symbol: 'ETH' }
  ],
  VS_CURRENCY: 'jpy',
  HISTORY_DAYS: 60,          // 取得する日足の日数
  SMA_SHORT: 5,              // 短期移動平均の期間
  SMA_LONG: 20,              // 長期移動平均の期間
  RSI_PERIOD: 14,
  RSI_OVERBOUGHT: 70,        // これ以上は買われすぎ(買いを抑制/売りシグナル)
  RSI_OVERSOLD: 30,          // これ以下は売られすぎ(買いシグナル)
  TRADE_FRACTION: 0.2,       // 1回の買いに使う現金の割合
  MIN_TRADE_JPY: 1000,       // これ未満の買い注文は出さない
  INITIAL_BALANCE_JPY: 100000, // 仮想ポートフォリオの初期資金
  FEE_RATE: 0.0015,          // 想定手数料率 (0.15%)
  API_RETRIES: 3,
  NOTION_VERSION: '2022-06-28',
  NOTION_RETRIES: 3,
  INTER_REQUEST_DELAY_MS: 500
};

var CRYPTO_PROP_KEYS = {
  NOTION_API_KEY: 'NOTION_API_KEY',           // Code.gs と共用
  TRADES_DATABASE_ID: 'TRADES_DATABASE_ID',   // 取引記録用 Notion DB (任意)
  PORTFOLIO: 'CRYPTO_PORTFOLIO'               // 仮想ポートフォリオ (JSON)
};

// ===== エントリポイント =====
function autoCryptoTrade() {
  var logger = new CryptoLogger();

  // 多重起動防止(トリガー重複対策)
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    logger.log('🔒 Another execution is in progress. Exiting.');
    return;
  }

  var props = PropertiesService.getScriptProperties();

  try {
    var notionApiKey = props.getProperty(CRYPTO_PROP_KEYS.NOTION_API_KEY);
    var tradesDbId = props.getProperty(CRYPTO_PROP_KEYS.TRADES_DATABASE_ID);
    var notionEnabled = Boolean(notionApiKey && tradesDbId);
    if (!notionEnabled) {
      logger.log('ℹ️ Notion 未設定のため取引記録はログのみに出力します');
    }

    var portfolio = parsePortfolio(
      props.getProperty(CRYPTO_PROP_KEYS.PORTFOLIO),
      CRYPTO_CONFIG.INITIAL_BALANCE_JPY
    );
    var today = toIsoDate(new Date());
    var counts = { trades: 0, holds: 0, skipped: 0, failed: 0 };

    for (var i = 0; i < CRYPTO_CONFIG.COINS.length; i++) {
      var coin = CRYPTO_CONFIG.COINS[i];
      try {
        var closes = fetchDailyCloses(
          coin.id,
          CRYPTO_CONFIG.VS_CURRENCY,
          CRYPTO_CONFIG.HISTORY_DAYS,
          logger
        );

        if (!closes || closes.length < CRYPTO_CONFIG.SMA_LONG + 1) {
          logger.log('⚠️ ' + coin.symbol + ': 価格データ不足のためスキップ');
          counts.skipped++;
          continue;
        }

        var price = closes[closes.length - 1];
        var signal = decideSignal(closes, {
          smaShort: CRYPTO_CONFIG.SMA_SHORT,
          smaLong: CRYPTO_CONFIG.SMA_LONG,
          rsiPeriod: CRYPTO_CONFIG.RSI_PERIOD,
          rsiOverbought: CRYPTO_CONFIG.RSI_OVERBOUGHT,
          rsiOversold: CRYPTO_CONFIG.RSI_OVERSOLD
        });

        logger.log(
          '📈 ' + coin.symbol + ': ' + signal.action +
          ' (' + signal.reason + ') 価格=' + formatJpy(price) +
          ' RSI=' + (signal.rsi === null ? '-' : signal.rsi.toFixed(1))
        );

        if (signal.action === 'HOLD') {
          counts.holds++;
          continue;
        }

        // 1コインにつき1日1回まで(トリガー多重実行や再実行での重複売買防止)
        if (portfolio.lastTradeDay[coin.symbol] === today) {
          logger.log('⏭️ ' + coin.symbol + ': 本日は取引済みのためスキップ');
          counts.skipped++;
          continue;
        }

        var result = executePaperTrade(portfolio, coin.symbol, price, signal.action, {
          tradeFraction: CRYPTO_CONFIG.TRADE_FRACTION,
          minTradeJpy: CRYPTO_CONFIG.MIN_TRADE_JPY,
          feeRate: CRYPTO_CONFIG.FEE_RATE
        });

        if (!result.trade) {
          logger.log('⏭️ ' + coin.symbol + ': ' + result.skippedReason);
          counts.skipped++;
          continue;
        }

        result.trade.reason = signal.reason;
        result.trade.at = today;

        portfolio = result.portfolio;
        portfolio.lastTradeDay[coin.symbol] = today;
        // 取引ごとに即保存(後続コインでの失敗時にも取引を失わない)
        props.setProperty(CRYPTO_PROP_KEYS.PORTFOLIO, JSON.stringify(portfolio));

        logger.log(
          '✅ ' + result.trade.action + ' ' + coin.symbol +
          ' ' + result.trade.qty + ' @ ' + formatJpy(result.trade.priceJpy) +
          ' (' + formatJpy(result.trade.amountJpy) + ')'
        );
        counts.trades++;

        if (notionEnabled) {
          var saved = saveTradeToNotion(result.trade, portfolio, notionApiKey, tradesDbId, logger);
          if (!saved) logger.log('⚠️ Notion への取引記録に失敗 (取引自体は反映済み)');
        }
        sendTradeNotification(result.trade, portfolio, logger);

        Utilities.sleep(CRYPTO_CONFIG.INTER_REQUEST_DELAY_MS);
      } catch (coinError) {
        logger.log('❌ ' + coin.symbol + ' の処理でエラー: ' + coinError.message);
        counts.failed++;
      }
    }

    logger.log('\n📊 Summary: 取引=' + counts.trades + ' 様子見=' + counts.holds +
      ' スキップ=' + counts.skipped + ' 失敗=' + counts.failed);
    logger.log('💰 現金残高: ' + formatJpy(portfolio.cashJpy) +
      ' / 実現損益: ' + formatJpy(portfolio.realizedPnlJpy));
  } catch (error) {
    logger.log('❌ Error in autoCryptoTrade: ' + error.message);
    logger.log('Stack: ' + (error.stack || '(no stack)'));
    sendCryptoErrorNotification(error.message, logger.getFullLog());
  } finally {
    lock.releaseLock();
  }
}

// ===== 純粋ロジック(テスト対象) =====

/**
 * 単純移動平均 (SMA)。直近 period 本の終値の平均。データ不足なら null。
 */
function calculateSMA(closes, period) {
  if (!Array.isArray(closes) || period < 1 || closes.length < period) return null;
  var sum = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    sum += closes[i];
  }
  return sum / period;
}

/**
 * RSI (Wilder 平滑化)。データ不足なら null。
 * 変動が全く無い場合は中立の 50 を返す(100 と誤判定して売りを出さないため)。
 */
function calculateRSI(closes, period) {
  if (!Array.isArray(closes) || period < 1 || closes.length < period + 1) return null;

  var gains = 0;
  var losses = 0;
  for (var i = 1; i <= period; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;

  for (var j = period + 1; j < closes.length; j++) {
    var d = closes[j] - closes[j - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }

  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * 売買シグナルを判定。
 * 優先順位:
 *  1. ゴールデンクロス(短期SMAが長期SMAを上抜け) かつ RSI が買われすぎでない → BUY
 *  2. デッドクロス(短期SMAが長期SMAを下抜け) → SELL
 *  3. RSI が売られすぎ → BUY (逆張り)
 *  4. RSI が買われすぎ → SELL
 *  5. それ以外 → HOLD
 *
 * @returns {{action: string, reason: string, rsi: ?number, smaShort: ?number, smaLong: ?number}}
 */
function decideSignal(closes, opts) {
  if (!Array.isArray(closes) || closes.length < opts.smaLong + 1) {
    return { action: 'HOLD', reason: 'データ不足', rsi: null, smaShort: null, smaLong: null };
  }

  var prev = closes.slice(0, closes.length - 1);
  var smaShortNow = calculateSMA(closes, opts.smaShort);
  var smaLongNow = calculateSMA(closes, opts.smaLong);
  var smaShortPrev = calculateSMA(prev, opts.smaShort);
  var smaLongPrev = calculateSMA(prev, opts.smaLong);
  var rsi = calculateRSI(closes, opts.rsiPeriod);

  var base = { rsi: rsi, smaShort: smaShortNow, smaLong: smaLongNow };

  var goldenCross = smaShortPrev <= smaLongPrev && smaShortNow > smaLongNow;
  var deadCross = smaShortPrev >= smaLongPrev && smaShortNow < smaLongNow;

  if (goldenCross && (rsi === null || rsi < opts.rsiOverbought)) {
    return Object.assign({ action: 'BUY', reason: 'ゴールデンクロス' }, base);
  }
  if (deadCross) {
    return Object.assign({ action: 'SELL', reason: 'デッドクロス' }, base);
  }
  if (rsi !== null && rsi <= opts.rsiOversold) {
    return Object.assign({ action: 'BUY', reason: 'RSI売られすぎ(' + rsi.toFixed(1) + ')' }, base);
  }
  if (rsi !== null && rsi >= opts.rsiOverbought) {
    return Object.assign({ action: 'SELL', reason: 'RSI買われすぎ(' + rsi.toFixed(1) + ')' }, base);
  }
  return Object.assign({ action: 'HOLD', reason: 'シグナルなし' }, base);
}

/**
 * 初期状態の仮想ポートフォリオを生成。
 */
function createInitialPortfolio(initialBalanceJpy) {
  return {
    cashJpy: initialBalanceJpy,
    holdings: {},        // symbol -> { qty, costJpy(手数料込み取得コスト) }
    realizedPnlJpy: 0,
    lastTradeDay: {}     // symbol -> 'YYYY-MM-DD'
  };
}

/**
 * スクリプトプロパティの JSON からポートフォリオを復元。
 * 壊れている/未初期化なら初期ポートフォリオを返す。
 */
function parsePortfolio(raw, initialBalanceJpy) {
  if (!raw) return createInitialPortfolio(initialBalanceJpy);
  try {
    var p = JSON.parse(raw);
    if (!p || typeof p.cashJpy !== 'number' || !isFinite(p.cashJpy)) {
      return createInitialPortfolio(initialBalanceJpy);
    }
    return {
      cashJpy: p.cashJpy,
      holdings: (p.holdings && typeof p.holdings === 'object') ? p.holdings : {},
      realizedPnlJpy: (typeof p.realizedPnlJpy === 'number' && isFinite(p.realizedPnlJpy))
        ? p.realizedPnlJpy : 0,
      lastTradeDay: (p.lastTradeDay && typeof p.lastTradeDay === 'object') ? p.lastTradeDay : {}
    };
  } catch (e) {
    return createInitialPortfolio(initialBalanceJpy);
  }
}

/**
 * 仮想売買を執行する。元のポートフォリオは変更せず、新しいオブジェクトを返す。
 *
 * BUY:  現金 × tradeFraction を予算とし、手数料を引いた分だけ購入。
 * SELL: 対象コインの保有を全量売却し、実現損益を計上。
 *
 * @returns {{portfolio: object, trade: ?object, skippedReason: ?string}}
 */
function executePaperTrade(portfolio, symbol, priceJpy, action, opts) {
  var p = JSON.parse(JSON.stringify(portfolio));

  if (!isFinite(priceJpy) || priceJpy <= 0) {
    return { portfolio: p, trade: null, skippedReason: '価格が不正' };
  }

  if (action === 'BUY') {
    var budget = Math.floor(p.cashJpy * opts.tradeFraction);
    if (budget < opts.minTradeJpy) {
      return { portfolio: p, trade: null, skippedReason: '現金不足(予算 ' + budget + ' 円)' };
    }
    var buyFee = Math.round(budget * opts.feeRate);
    var qty = (budget - buyFee) / priceJpy;
    var held = p.holdings[symbol] || { qty: 0, costJpy: 0 };
    p.holdings[symbol] = { qty: held.qty + qty, costJpy: held.costJpy + budget };
    p.cashJpy -= budget;
    return {
      portfolio: p,
      trade: { symbol: symbol, action: 'BUY', priceJpy: priceJpy, qty: qty, amountJpy: budget, feeJpy: buyFee },
      skippedReason: null
    };
  }

  if (action === 'SELL') {
    var holding = p.holdings[symbol];
    if (!holding || holding.qty <= 0) {
      return { portfolio: p, trade: null, skippedReason: '保有なし' };
    }
    var proceeds = holding.qty * priceJpy;
    var sellFee = Math.round(proceeds * opts.feeRate);
    var net = proceeds - sellFee;
    var realized = net - holding.costJpy;
    p.cashJpy += net;
    p.realizedPnlJpy += realized;
    delete p.holdings[symbol];
    return {
      portfolio: p,
      trade: {
        symbol: symbol, action: 'SELL', priceJpy: priceJpy, qty: holding.qty,
        amountJpy: net, feeJpy: sellFee, realizedPnlJpy: realized
      },
      skippedReason: null
    };
  }

  return { portfolio: p, trade: null, skippedReason: 'HOLD' };
}

/**
 * CoinGecko market_chart レスポンスから終値配列を抽出。
 * prices は [[timestampMs, price], ...] 形式。数値以外は除外する。
 */
function extractClosesFromMarketChart(json) {
  if (!json || !Array.isArray(json.prices)) return [];
  var closes = [];
  for (var i = 0; i < json.prices.length; i++) {
    var point = json.prices[i];
    if (Array.isArray(point) && typeof point[1] === 'number' && isFinite(point[1])) {
      closes.push(point[1]);
    }
  }
  return closes;
}

/**
 * Notion ページ作成用の取引記録 properties を構築。
 */
function buildTradeNotionProperties(trade, portfolio) {
  var properties = {
    '名前': { title: [{ text: { content: truncateForNotion(buildTradeTitle(trade), 2000) } }] },
    '通貨': { rich_text: [{ text: { content: trade.symbol } }] },
    '売買': { rich_text: [{ text: { content: trade.action } }] },
    '価格': { number: trade.priceJpy },
    '数量': { number: trade.qty },
    '金額': { number: trade.amountJpy },
    '手数料': { number: trade.feeJpy },
    '理由': { rich_text: [{ text: { content: truncateForNotion(trade.reason || '', 2000) } }] },
    '日時': { date: { start: trade.at } },
    '現金残高': { number: Math.round(portfolio.cashJpy) }
  };
  if (typeof trade.realizedPnlJpy === 'number') {
    properties['実現損益'] = { number: Math.round(trade.realizedPnlJpy) };
  }
  return properties;
}

function buildTradeTitle(trade) {
  return trade.action + ' ' + trade.symbol + ' @ ' + formatJpy(trade.priceJpy);
}

/**
 * Date を YYYY-MM-DD (ローカルタイムゾーン基準) に整形。
 */
function toIsoDate(date) {
  var year = date.getFullYear();
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/**
 * 金額を「¥1,234,567」形式に整形(四捨五入)。
 */
function formatJpy(n) {
  var rounded = Math.round(n);
  var sign = rounded < 0 ? '-' : '';
  var digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '¥' + digits;
}

/**
 * Notion の rich_text / title は 2000 文字上限。安全に切り詰める。
 */
function truncateForNotion(text, maxLength) {
  if (!text) return '';
  var s = String(text);
  return s.length <= maxLength ? s : s.substring(0, maxLength);
}

// ===== 外部 API / GAS 依存処理 =====

/**
 * CoinGecko から日足の終値配列を取得。429 / 5xx は指数バックオフで再試行。
 */
function fetchDailyCloses(coinId, vsCurrency, days, logger) {
  var url = 'https://api.coingecko.com/api/v3/coins/' + encodeURIComponent(coinId) +
    '/market_chart?vs_currency=' + encodeURIComponent(vsCurrency) +
    '&days=' + days + '&interval=daily';

  var options = { method: 'get', muteHttpExceptions: true };
  var lastError;

  for (var attempt = 1; attempt <= CRYPTO_CONFIG.API_RETRIES; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var statusCode = response.getResponseCode();
      var responseText = response.getContentText();

      if (statusCode !== 200) {
        lastError = new Error('CoinGecko API error: ' + statusCode + ' - ' + responseText);
        if ((statusCode === 429 || statusCode >= 500) && attempt < CRYPTO_CONFIG.API_RETRIES) {
          if (logger) logger.log('⚠️ CoinGecko ' + statusCode + ', retry ' + attempt + '/' + CRYPTO_CONFIG.API_RETRIES);
          Utilities.sleep(2000 * attempt);
          continue;
        }
        throw lastError;
      }

      return extractClosesFromMarketChart(JSON.parse(responseText));
    } catch (error) {
      lastError = error;
      if (attempt < CRYPTO_CONFIG.API_RETRIES) {
        if (logger) logger.log('⚠️ Attempt ' + attempt + ' failed: ' + error.message);
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  throw lastError;
}

function saveTradeToNotion(trade, portfolio, apiKey, databaseId, logger) {
  var url = 'https://api.notion.com/v1/pages';
  var payload = {
    parent: { database_id: databaseId },
    properties: buildTradeNotionProperties(trade, portfolio)
  };

  var options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Notion-Version': CRYPTO_CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var attempt = 1; attempt <= CRYPTO_CONFIG.NOTION_RETRIES; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var statusCode = response.getResponseCode();

      if (statusCode === 200) return true;

      var responseText = response.getContentText();
      if ((statusCode === 429 || statusCode >= 500) && attempt < CRYPTO_CONFIG.NOTION_RETRIES) {
        if (logger) logger.log('⚠️ Notion API ' + statusCode + ', retry ' + attempt + '/' + CRYPTO_CONFIG.NOTION_RETRIES);
        Utilities.sleep(1000 * attempt);
        continue;
      }
      if (logger) logger.log('⚠️ Notion API error: ' + statusCode + ' - ' + responseText);
      return false;
    } catch (error) {
      if (logger) logger.log('❌ saveTradeToNotion error: ' + error.message);
      if (attempt < CRYPTO_CONFIG.NOTION_RETRIES) {
        Utilities.sleep(1000 * attempt);
        continue;
      }
      return false;
    }
  }
  return false;
}

function sendTradeNotification(trade, portfolio, logger) {
  try {
    var userEmail = Session.getActiveUser().getEmail();
    // インストール型トリガーでは getActiveUser が空になることがあるためフォールバック
    if (!userEmail) {
      userEmail = Session.getEffectiveUser().getEmail();
    }
    if (!userEmail) {
      if (logger) logger.log('⚠️ 通知先メールアドレスが取得できませんでした');
      return;
    }

    var lines = [
      '仮想通貨ペーパートレードで取引を執行しました。',
      '',
      '銘柄: ' + trade.symbol,
      '売買: ' + trade.action,
      '価格: ' + formatJpy(trade.priceJpy),
      '数量: ' + trade.qty,
      '金額: ' + formatJpy(trade.amountJpy),
      '手数料: ' + formatJpy(trade.feeJpy),
      '理由: ' + (trade.reason || '-'),
      ''
    ];
    if (typeof trade.realizedPnlJpy === 'number') {
      lines.push('この取引の実現損益: ' + formatJpy(trade.realizedPnlJpy));
    }
    lines.push('現金残高: ' + formatJpy(portfolio.cashJpy));
    lines.push('累計実現損益: ' + formatJpy(portfolio.realizedPnlJpy));
    lines.push('');
    lines.push('※ これは仮想売買(シミュレーション)であり、実際の資産は動いていません。');

    GmailApp.sendEmail(
      userEmail,
      '📈 [ペーパートレード] ' + buildTradeTitle(trade),
      lines.join('\n')
    );
  } catch (e) {
    if (logger) logger.log('⚠️ Could not send trade notification: ' + e.message);
  }
}

function sendCryptoErrorNotification(errorMessage, fullLog) {
  try {
    var userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) {
      userEmail = Session.getEffectiveUser().getEmail();
    }
    if (!userEmail) {
      Logger.log('No recipient email available for error notification.');
      return;
    }
    GmailApp.sendEmail(
      userEmail,
      '❌ autoCryptoTrade エラーが発生しました',
      'エラー内容:\n' + errorMessage + '\n\n実行ログ:\n' + fullLog
    );
  } catch (e) {
    Logger.log('Could not send error notification: ' + e.message);
  }
}

// ===== ロガー =====
function CryptoLogger() {
  this.logs = [];
}
CryptoLogger.prototype.log = function (message) {
  var timestamp = new Date().toLocaleTimeString('ja-JP');
  var logEntry = '[' + timestamp + '] ' + message;
  this.logs.push(logEntry);
  Logger.log(logEntry);
};
CryptoLogger.prototype.getFullLog = function () {
  return this.logs.join('\n');
};

// ===== セットアップ / ユーティリティ =====
function setupCryptoProperties() {
  var scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty(CRYPTO_PROP_KEYS.NOTION_API_KEY, 'your_notion_key_here');
  scriptProperties.setProperty(CRYPTO_PROP_KEYS.TRADES_DATABASE_ID, 'your_trades_database_id_here');
  scriptProperties.setProperty(
    CRYPTO_PROP_KEYS.PORTFOLIO,
    JSON.stringify(createInitialPortfolio(CRYPTO_CONFIG.INITIAL_BALANCE_JPY))
  );
  Logger.log('✅ Crypto properties have been set');
}

function resetPortfolio() {
  PropertiesService.getScriptProperties().setProperty(
    CRYPTO_PROP_KEYS.PORTFOLIO,
    JSON.stringify(createInitialPortfolio(CRYPTO_CONFIG.INITIAL_BALANCE_JPY))
  );
  Logger.log('✅ Portfolio has been reset');
}

function showPortfolio() {
  var raw = PropertiesService.getScriptProperties().getProperty(CRYPTO_PROP_KEYS.PORTFOLIO);
  Logger.log(raw || '(未初期化)');
}

function testAutoCryptoTrade() {
  Logger.log('🧪 Testing autoCryptoTrade...');
  autoCryptoTrade();
}

// ===== Node.js テスト用エクスポート (GAS では実行されない) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CRYPTO_CONFIG: CRYPTO_CONFIG,
    CRYPTO_PROP_KEYS: CRYPTO_PROP_KEYS,
    autoCryptoTrade: autoCryptoTrade,
    calculateSMA: calculateSMA,
    calculateRSI: calculateRSI,
    decideSignal: decideSignal,
    createInitialPortfolio: createInitialPortfolio,
    parsePortfolio: parsePortfolio,
    executePaperTrade: executePaperTrade,
    extractClosesFromMarketChart: extractClosesFromMarketChart,
    buildTradeNotionProperties: buildTradeNotionProperties,
    buildTradeTitle: buildTradeTitle,
    toIsoDate: toIsoDate,
    formatJpy: formatJpy,
    truncateForNotion: truncateForNotion,
    fetchDailyCloses: fetchDailyCloses,
    saveTradeToNotion: saveTradeToNotion,
    CryptoLogger: CryptoLogger
  };
}
