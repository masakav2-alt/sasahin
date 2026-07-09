/**
 * autoEmailToNotion
 * 「問い合わせ」メールを Gemini で要約し、Notion データベースに登録する
 * Google Apps Script。時間主導型トリガーでの定期実行を想定。
 *
 * 設計メモ:
 *  - GAS 固有 API (GmailApp / UrlFetchApp / PropertiesService 等) に依存する処理と、
 *    純粋なロジック (パース・整形・バリデーション) を分離している。
 *  - 純粋関数は Node.js + node:test で単体テスト可能 (test/ 配下)。
 */

// ===== 定数 =====
var CONFIG = {
  SEARCH_QUERY: 'is:unread subject:問い合わせ',
  MAX_THREADS: 5,
  MAX_BODY_LENGTH: 4000,
  MIN_BODY_LENGTH: 10,
  EXECUTION_TIME_LIMIT_MS: 5 * 60 * 1000, // 5分
  MAX_PROCESSED_IDS: 500,                 // 重複防止IDの保持上限（プロパティ9KB制限対策）
  GEMINI_MODEL: 'gemini-1.5-flash',
  GEMINI_MAX_OUTPUT_TOKENS: 256,          // 要約3行+締切日で十分な上限（出力トークン浪費防止）
  GEMINI_TEMPERATURE: 0.1,                // 低温度で形式遵守を安定させる
  NOTION_VERSION: '2022-06-28',
  GEMINI_RETRIES: 3,
  NOTION_RETRIES: 3,
  INTER_REQUEST_DELAY_MS: 500
};

var PROP_KEYS = {
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  NOTION_API_KEY: 'NOTION_API_KEY',
  NOTION_DATABASE_ID: 'NOTION_DATABASE_ID',
  LOGS_DATABASE_ID: 'LOGS_DATABASE_ID',
  PROCESSED_MESSAGE_IDS: 'PROCESSED_MESSAGE_IDS'
};

// ===== エントリポイント =====
function autoEmailToNotion() {
  var executionStart = new Date();
  var logger = new ExecutionLogger();

  // 多重起動防止（トリガー重複対策）
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    logger.log('🔒 Another execution is in progress. Exiting.');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var notionApiKey = null;
  var notionDatabaseId = null;

  try {
    var geminiApiKey = props.getProperty(PROP_KEYS.GEMINI_API_KEY);
    notionApiKey = props.getProperty(PROP_KEYS.NOTION_API_KEY);
    notionDatabaseId = props.getProperty(PROP_KEYS.NOTION_DATABASE_ID);

    if (!geminiApiKey || !notionApiKey || !notionDatabaseId) {
      throw new Error('APIキーまたはデータベースIDが設定されていません (setupApiKeys を確認してください)');
    }

    var threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS);
    logger.log('📧 Found ' + threads.length + ' unread emails');

    var processedCount = { success: 0, failed: 0, skipped: 0 };
    var processedIds = readProcessedIds(props);

    for (var i = 0; i < threads.length; i++) {
      var thread = threads[i];

      if (new Date() - executionStart > CONFIG.EXECUTION_TIME_LIMIT_MS) {
        logger.log('⏱️ Approaching execution time limit. Stopping gracefully.');
        break;
      }

      try {
        var messages = thread.getMessages();
        var lastMessage = messages[messages.length - 1];
        var messageId = lastMessage.getId();
        var subject = lastMessage.getSubject() || '(件名なし)';

        if (processedIds.indexOf(messageId) !== -1) {
          logger.log('⏭️ Skipping already processed: ' + subject);
          processedCount.skipped++;
          continue;
        }

        var from = lastMessage.getFrom();
        var receivedDate = new Date(lastMessage.getDate());

        var rawBody = lastMessage.getPlainBody();
        if (!rawBody || rawBody.trim() === '') {
          rawBody = sanitizeHtml(lastMessage.getBody());
        }

        // 引用・署名・URL 等を除去してから切り詰める（Gemini へ送るトークンを削減）
        var compressed = compressBody(rawBody);
        if (compressed.length < CONFIG.MIN_BODY_LENGTH &&
            rawBody.trim().length >= CONFIG.MIN_BODY_LENGTH) {
          // 圧縮で本文が消えた場合（引用のみのメール等）は原文に戻す
          compressed = rawBody.trim();
        }

        var truncated = truncateBody(compressed, CONFIG.MAX_BODY_LENGTH);
        var body = truncated.body;
        if (truncated.wasTruncated) {
          logger.log('⚠️ Email body truncated: ' + subject);
        }

        if (!body || body.trim().length < CONFIG.MIN_BODY_LENGTH) {
          logger.log('⚠️ Email body is too short, skipping: ' + subject);
          processedCount.skipped++;
          continue;
        }

        var prompt = buildPrompt(body);
        var geminiResult = callGemini(prompt, geminiApiKey, CONFIG.GEMINI_RETRIES, logger);

        if (!geminiResult) {
          logger.log('⚠️ Empty Gemini result for: ' + subject);
          processedCount.failed++;
          continue;
        }

        var parsed = parseGeminiResult(geminiResult);

        var success = saveToNotion(
          subject,
          parsed.summary,
          parsed.deadline,
          from,
          receivedDate,
          messageId,
          notionApiKey,
          notionDatabaseId,
          logger
        );

        if (success) {
          thread.markRead();
          addProcessedLabel(thread, logger);

          processedIds.push(messageId);
          processedIds = capProcessedIds(processedIds, CONFIG.MAX_PROCESSED_IDS);
          props.setProperty(PROP_KEYS.PROCESSED_MESSAGE_IDS, JSON.stringify(processedIds));

          logger.log('✅ Processed: ' + subject);
          processedCount.success++;

          Utilities.sleep(CONFIG.INTER_REQUEST_DELAY_MS);
        } else {
          logger.log('❌ Failed to save to Notion: ' + subject);
          processedCount.failed++;
        }
      } catch (threadError) {
        logger.log('❌ Error processing email thread: ' + threadError.message);
        processedCount.failed++;
      }
    }

    logger.log('\n📊 Processing Summary:');
    logger.log('   ✅ Success: ' + processedCount.success);
    logger.log('   ❌ Failed: ' + processedCount.failed);
    logger.log('   ⏭️ Skipped: ' + processedCount.skipped);

    if (processedCount.success > 0 || processedCount.failed > 0) {
      saveExecutionLog(logger, processedCount, notionApiKey, notionDatabaseId);
    }
  } catch (error) {
    logger.log('❌ Error in autoEmailToNotion: ' + error.message);
    logger.log('Stack: ' + (error.stack || '(no stack)'));
    sendErrorNotification(error.message, logger.getFullLog());
  } finally {
    lock.releaseLock();
  }
}

// ===== 純粋ロジック（テスト対象） =====

/**
 * Gemini へ渡すプロンプトを生成。
 * 構造化された出力を強制することで parseGeminiResult の堅牢性を高める。
 */
function buildPrompt(body) {
  return [
    '次のメール本文を日本語で要約し、この形式のみで出力:',
    '要約: <3行程度>',
    '締切日: <YYYY-MM-DD、無ければ「なし」>',
    '',
    '本文:',
    body
  ].join('\n');
}

/**
 * LLM へ渡す前に、要約品質に寄与しない定型部分を本文から除去してトークンを削減する。
 * 問い合わせ内容そのものは変更しない。
 *  - 返信引用ヘッダ（"On ... wrote:" / "-----Original Message-----" / Gmail 日本語形式）以降
 *  - "> " で始まる引用行
 *  - 署名区切り（"-- " 行）以降
 *  - URL（[URL] プレースホルダに置換）
 *  - 装飾罫線行・連続重複行・過剰な空白
 */
function compressBody(body) {
  if (!body) return '';
  var text = String(body).replace(/\r\n/g, '\n');

  // 1) 返信引用ヘッダ以降を切り落とす（過去のやり取りは要約対象外）
  var quoteHeaders = [
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
    /^-{2,}\s*(元の|転送)メッセージ\s*-{2,}\s*$/im,
    /^On .+ wrote:\s*$/im,
    /^\d{4}年\d{1,2}月\d{1,2}日\D.*[<＜][^>＞]+[>＞]\s*[:：]?\s*$/im
  ];
  var cutAt = -1;
  for (var i = 0; i < quoteHeaders.length; i++) {
    var m = text.match(quoteHeaders[i]);
    if (m && (cutAt === -1 || m.index < cutAt)) cutAt = m.index;
  }
  if (cutAt !== -1) text = text.slice(0, cutAt);

  // 2) "> " 引用行を除去
  text = text.replace(/^[ \t]*>.*$/gm, '');

  // 3) 署名区切り以降を除去（"-- " は標準的な署名デリミタ）
  var sig = text.match(/^--[ \t]*$/m);
  if (sig) text = text.slice(0, sig.index);

  // 4) URL をプレースホルダに置換（URL 全文は要約に不要でトークンを浪費する）
  text = text.replace(/https?:\/\/[^\s<>"'）)】]+/g, '[URL]');

  // 5) 装飾罫線行（──── / ==== / ＊＊＊＊ 等）を除去
  text = text.replace(/^[ \t]*[-=＝*＊_＿─━#＃~〜■□●○◆◇♪]{6,}[ \t]*$/gm, '');

  // 6) 連続する同一行を1行に圧縮（定型フッターの繰り返し対策）
  var lines = text.split('\n');
  var deduped = [];
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j].replace(/[ \t]+$/, '');
    if (line !== '' && deduped.length > 0 && deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }
  text = deduped.join('\n');

  // 7) 空白の圧縮
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Gemini の応答から要約と締切日を抽出。
 * 「締切日:」ラベル行の日付を優先し、無ければ全体から YYYY-MM-DD を探す。
 * 要約からは締切日行・ラベルを除去する。
 */
function parseGeminiResult(result) {
  if (!result || typeof result !== 'string') {
    return { summary: '', deadline: null };
  }

  var text = result.replace(/\r\n/g, '\n').trim();
  var deadline = null;

  // 1) 「締切日:」ラベル行を優先
  var labelMatch = text.match(/締切日\s*[:：]\s*([^\n]*)/);
  if (labelMatch) {
    var dateInLabel = labelMatch[1].match(/(\d{4}-\d{2}-\d{2})/);
    if (dateInLabel && isValidDate(dateInLabel[1])) {
      deadline = dateInLabel[1];
    }
  }

  // 「要約:」ラベルがあれば本文を抽出（締切日行より前まで）
  var summary = text;
  var summaryMatch = text.match(/要約\s*[:：]\s*([\s\S]*?)(?:\n\s*締切日\s*[:：]|$)/);
  if (summaryMatch) {
    summary = summaryMatch[1];
  } else {
    // ラベルが無い場合は締切日行のみ取り除く
    summary = text.replace(/締切日\s*[:：][^\n]*/g, '');
  }

  // 2) フォールバック: 締切日ラベルから取れなければ本文以外から日付を探す
  if (!deadline) {
    var anyDate = text.match(/(\d{4}-\d{2}-\d{2})/);
    if (anyDate && isValidDate(anyDate[1])) {
      deadline = anyDate[1];
    }
  }

  // 整形: ラベル残骸・余分な空行を除去
  summary = summary
    .replace(/^要約\s*[:：]\s*/i, '')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  return { summary: summary, deadline: deadline };
}

/**
 * 本文を最大長に切り詰める。
 * 冒頭に用件、末尾に締切・連絡先が書かれることが多いため、
 * 先頭 75% + 末尾 25% を残す（単純な先頭切りより情報落ちが少ない）。
 */
function truncateBody(body, maxLength) {
  if (!body) return { body: '', wasTruncated: false };
  if (body.length <= maxLength) return { body: body, wasTruncated: false };
  var headLen = Math.ceil(maxLength * 0.75);
  var tailLen = maxLength - headLen;
  return {
    body: body.slice(0, headLen) + '\n…(中略)…\n' + (tailLen > 0 ? body.slice(-tailLen) : ''),
    wasTruncated: true
  };
}

/**
 * 送信者文字列から表示名を抽出。
 *  "John Doe <john@example.com>" -> "John Doe"
 *  "<john@example.com>"          -> "john@example.com"
 */
function extractSenderName(from) {
  if (!from) return '';
  var name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  if (name) return name;
  var emailMatch = from.match(/<([^>]*)>/);
  if (emailMatch && emailMatch[1].trim()) return emailMatch[1].trim();
  return from.trim();
}

/**
 * 簡易 HTML -> テキスト変換。script/style ブロックを除去し、改行を保持。
 */
function sanitizeHtml(html) {
  if (!html) return '';
  var text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(parseInt(code, 10)); })
    .replace(/&amp;/gi, '&'); // & は最後にデコード

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Date を YYYY-MM-DD (ローカルタイムゾーン基準) に整形。
 */
function formatDateToISO(date) {
  var year = date.getFullYear();
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/**
 * YYYY-MM-DD が「実在する」日付かを検証（2026-02-30 等を弾く）。
 */
function isValidDate(dateString) {
  if (typeof dateString !== 'string') return false;
  var m = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  var year = parseInt(m[1], 10);
  var month = parseInt(m[2], 10);
  var day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  var d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * 重複防止IDリストを上限件数に抑える（古いものから削除）。
 */
function capProcessedIds(ids, maxCount) {
  if (!Array.isArray(ids)) return [];
  if (ids.length <= maxCount) return ids;
  return ids.slice(ids.length - maxCount);
}

/**
 * Notion ページ作成用 properties を構築。
 */
function buildNotionProperties(title, summary, deadline, from, receivedDate, messageId) {
  var senderName = extractSenderName(from);
  var properties = {
    '名前': { title: [{ text: { content: truncateText(title, 2000) } }] },
    '要約': { rich_text: [{ text: { content: truncateText(summary, 2000) } }] },
    '送信者': { rich_text: [{ text: { content: truncateText(senderName, 2000) } }] },
    '受信日': { date: { start: formatDateToISO(receivedDate) } }
  };
  if (deadline && isValidDate(deadline)) {
    properties['締切日'] = { date: { start: deadline } };
  }
  if (messageId) {
    properties['メールID'] = { rich_text: [{ text: { content: truncateText(messageId, 2000) } }] };
  }
  return properties;
}

/**
 * Notion の rich_text / title は 2000 文字上限。安全に切り詰める。
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  var s = String(text);
  return s.length <= maxLength ? s : s.substring(0, maxLength);
}

// ===== 外部 API / GAS 依存処理 =====

function callGemini(prompt, apiKey, maxRetries, logger) {
  maxRetries = maxRetries || 1;
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: CONFIG.GEMINI_TEMPERATURE,
        maxOutputTokens: CONFIG.GEMINI_MAX_OUTPUT_TOKENS
      }
    }),
    muteHttpExceptions: true
  };

  var lastError;

  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var statusCode = response.getResponseCode();
      var responseText = response.getContentText();

      if (statusCode !== 200) {
        lastError = new Error('Gemini API error: ' + statusCode + ' - ' + responseText);

        if (statusCode === 429 && attempt < maxRetries) {
          if (logger) logger.log('⚠️ Rate limit reached. Attempt ' + attempt + '/' + maxRetries);
          Utilities.sleep(2000 * attempt);
          continue;
        } else if (statusCode >= 500 && attempt < maxRetries) {
          if (logger) logger.log('⚠️ Server error (' + statusCode + '). Attempt ' + attempt + '/' + maxRetries);
          Utilities.sleep(1000 * attempt);
          continue;
        }
        throw lastError;
      }

      var json = JSON.parse(responseText);
      var textOut = json &&
        json.candidates && json.candidates[0] &&
        json.candidates[0].content && json.candidates[0].content.parts &&
        json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;

      if (!textOut) {
        throw new Error('Invalid Gemini response format');
      }
      return textOut;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        if (logger) logger.log('⚠️ Attempt ' + attempt + ' failed: ' + error.message);
        Utilities.sleep(1000 * attempt);
      }
    }
  }

  if (logger) logger.log('❌ callGemini failed after ' + maxRetries + ' attempts: ' + lastError);
  throw lastError;
}

function saveToNotion(title, summary, deadline, from, receivedDate, messageId, apiKey, databaseId, logger) {
  var url = 'https://api.notion.com/v1/pages';
  var payload = {
    parent: { database_id: databaseId },
    properties: buildNotionProperties(title, summary, deadline, from, receivedDate, messageId)
  };

  var options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Notion-Version': CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (var attempt = 1; attempt <= CONFIG.NOTION_RETRIES; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var statusCode = response.getResponseCode();

      if (statusCode === 200) return true;

      var responseText = response.getContentText();
      // 429 / 5xx はリトライ、それ以外は即失敗
      if ((statusCode === 429 || statusCode >= 500) && attempt < CONFIG.NOTION_RETRIES) {
        if (logger) logger.log('⚠️ Notion API ' + statusCode + ', retry ' + attempt + '/' + CONFIG.NOTION_RETRIES);
        Utilities.sleep(1000 * attempt);
        continue;
      }
      if (logger) logger.log('⚠️ Notion API error: ' + statusCode + ' - ' + responseText);
      return false;
    } catch (error) {
      if (logger) logger.log('❌ saveToNotion error: ' + error.message);
      if (attempt < CONFIG.NOTION_RETRIES) {
        Utilities.sleep(1000 * attempt);
        continue;
      }
      return false;
    }
  }
  return false;
}

function readProcessedIds(props) {
  try {
    var raw = props.getProperty(PROP_KEYS.PROCESSED_MESSAGE_IDS) || '[]';
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function addProcessedLabel(thread, logger) {
  try {
    var label = GmailApp.getUserLabelByName('処理済み');
    if (!label) {
      label = GmailApp.createLabel('処理済み');
    }
    thread.addLabel(label);
  } catch (error) {
    if (logger) logger.log('⚠️ Could not add label: ' + error.message);
  }
}

function sendErrorNotification(errorMessage, fullLog) {
  try {
    var userEmail = Session.getActiveUser().getEmail();
    // インストール型トリガーでは getActiveUser が空になることがあるためフォールバック
    if (!userEmail) {
      userEmail = Session.getEffectiveUser().getEmail();
    }
    if (!userEmail) {
      Logger.log('No recipient email available for error notification.');
      return;
    }
    GmailApp.sendEmail(
      userEmail,
      '❌ autoEmailToNotion エラーが発生しました',
      'エラー内容:\n' + errorMessage + '\n\n実行ログ:\n' + fullLog
    );
  } catch (e) {
    Logger.log('Could not send error notification: ' + e.message);
  }
}

function saveExecutionLog(logger, processedCount, apiKey, databaseId) {
  var logsDbId = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.LOGS_DATABASE_ID);
  if (!logsDbId) return;

  var url = 'https://api.notion.com/v1/pages';
  var payload = {
    parent: { database_id: logsDbId },
    properties: {
      '実行日時': { title: [{ text: { content: new Date().toLocaleString('ja-JP') } }] },
      '成功': { number: processedCount.success },
      '失敗': { number: processedCount.failed },
      'スキップ': { number: processedCount.skipped },
      'ログ': { rich_text: [{ text: { content: truncateText(logger.getFullLog(), 2000) } }] }
    }
  };

  var options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Notion-Version': CONFIG.NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    UrlFetchApp.fetch(url, options);
  } catch (error) {
    Logger.log('Could not save execution log: ' + error.message);
  }
}

// ===== ロガー =====
function ExecutionLogger() {
  this.logs = [];
}
ExecutionLogger.prototype.log = function (message) {
  var timestamp = new Date().toLocaleTimeString('ja-JP');
  var logEntry = '[' + timestamp + '] ' + message;
  this.logs.push(logEntry);
  Logger.log(logEntry);
};
ExecutionLogger.prototype.getFullLog = function () {
  return this.logs.join('\n');
};

// ===== セットアップ / ユーティリティ =====
function setupApiKeys() {
  var scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty(PROP_KEYS.GEMINI_API_KEY, 'your_gemini_key_here');
  scriptProperties.setProperty(PROP_KEYS.NOTION_API_KEY, 'your_notion_key_here');
  scriptProperties.setProperty(PROP_KEYS.NOTION_DATABASE_ID, 'your_database_id_here');
  scriptProperties.setProperty(PROP_KEYS.LOGS_DATABASE_ID, 'your_logs_database_id_here');
  scriptProperties.setProperty(PROP_KEYS.PROCESSED_MESSAGE_IDS, '[]');
  Logger.log('✅ API keys have been set');
}

function testAutoEmailToNotion() {
  Logger.log('🧪 Testing autoEmailToNotion...');
  autoEmailToNotion();
}

function resetProcessedIds() {
  PropertiesService.getScriptProperties().setProperty(PROP_KEYS.PROCESSED_MESSAGE_IDS, '[]');
  Logger.log('✅ Processed IDs have been reset');
}

// ===== Node.js テスト用エクスポート (GAS では実行されない) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG: CONFIG,
    PROP_KEYS: PROP_KEYS,
    autoEmailToNotion: autoEmailToNotion,
    buildPrompt: buildPrompt,
    compressBody: compressBody,
    parseGeminiResult: parseGeminiResult,
    truncateBody: truncateBody,
    extractSenderName: extractSenderName,
    sanitizeHtml: sanitizeHtml,
    formatDateToISO: formatDateToISO,
    isValidDate: isValidDate,
    capProcessedIds: capProcessedIds,
    buildNotionProperties: buildNotionProperties,
    truncateText: truncateText,
    callGemini: callGemini,
    saveToNotion: saveToNotion,
    readProcessedIds: readProcessedIds,
    ExecutionLogger: ExecutionLogger
  };
}
