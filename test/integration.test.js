'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./helpers/load');
const m = require('./helpers/gas-mocks');

function baseGlobals(overrides = {}) {
  return Object.assign(
    {
      Logger: { log() {} },
      Utilities: { sleep() {} }
    },
    overrides
  );
}

test('callGemini: 200 でテキストを返す', () => {
  const fetch = m.createUrlFetchMock(() => ({ status: 200, body: m.geminiResponse('結果テキスト') }));
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  const out = code.callGemini('p', 'key', 1, null);
  assert.equal(out, '結果テキスト');
  assert.equal(fetch.requests.length, 1);
  assert.ok(!fetch.requests[0].url.includes(' ')); // URL に生キーが安全に入っている
});

test('callGemini: 429 をリトライして最終的に成功', () => {
  let calls = 0;
  const fetch = m.createUrlFetchMock(() => {
    calls++;
    return calls < 3
      ? { status: 429, body: 'rate limited' }
      : { status: 200, body: m.geminiResponse('ok') };
  });
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  const out = code.callGemini('p', 'key', 3, null);
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('callGemini: リトライ尽きたら throw', () => {
  const fetch = m.createUrlFetchMock(() => ({ status: 500, body: 'server error' }));
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  assert.throws(() => code.callGemini('p', 'key', 2, null), /Gemini API error: 500/);
});

test('callGemini: 不正なレスポンス形式で throw', () => {
  const fetch = m.createUrlFetchMock(() => ({ status: 200, body: '{"candidates":[]}' }));
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  assert.throws(() => code.callGemini('p', 'key', 1, null), /Invalid Gemini response format/);
});

test('saveToNotion: 200 で true', () => {
  const fetch = m.createUrlFetchMock(() => ({ status: 200, body: '{}' }));
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  const ok = code.saveToNotion('t', 's', '2026-07-01', 'a@b.com', new Date(2026, 5, 15), 'id', 'k', 'db', null);
  assert.equal(ok, true);
  const sent = JSON.parse(fetch.requests[0].options.payload);
  assert.equal(sent.parent.database_id, 'db');
  assert.equal(sent.properties['締切日'].date.start, '2026-07-01');
});

test('saveToNotion: 400 はリトライせず false', () => {
  let calls = 0;
  const fetch = m.createUrlFetchMock(() => { calls++; return { status: 400, body: 'bad request' }; });
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  const ok = code.saveToNotion('t', 's', null, 'a@b.com', new Date(), 'id', 'k', 'db', null);
  assert.equal(ok, false);
  assert.equal(calls, 1); // 4xx はリトライしない
});

test('saveToNotion: 500 はリトライ後 false', () => {
  let calls = 0;
  const fetch = m.createUrlFetchMock(() => { calls++; return { status: 500, body: 'err' }; });
  const code = loadCode(baseGlobals({ UrlFetchApp: fetch.UrlFetchApp }));
  const ok = code.saveToNotion('t', 's', null, 'a@b.com', new Date(), 'id', 'k', 'db', null);
  assert.equal(ok, false);
  assert.equal(calls, 3);
});

// ---- フルフロー ----

function setupFullRun({ threads, properties, fetchHandler, lockAcquirable = true, activeEmail = 'me@example.com' }) {
  const gmail = m.createGmailMock(threads);
  const fetch = m.createUrlFetchMock(fetchHandler);
  const lock = m.createLockMock({ acquirable: lockAcquirable });
  const props = m.createPropertiesMock(properties);

  const globals = baseGlobals({
    GmailApp: gmail.GmailApp,
    UrlFetchApp: fetch.UrlFetchApp,
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => lock.lock },
    Session: m.createSessionMock(activeEmail).Session
  });
  const code = loadCode(globals);
  return { code, gmail, fetch, lock, props };
}

test('autoEmailToNotion: 正常系 - 要約してNotion保存・既読・ID記録', () => {
  const msg = m.makeMessage({
    id: 'msg-1', subject: '問い合わせ: テスト', from: 'Taro <t@e.com>',
    date: new Date(2026, 5, 15), plainBody: 'これはテストの問い合わせ本文です。よろしくお願いします。'
  });
  const thread = m.makeThread([msg]);

  const ctx = setupFullRun({
    threads: [thread],
    properties: {
      GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db',
      PROCESSED_MESSAGE_IDS: '[]'
    },
    fetchHandler: (url) => {
      if (url.includes('generativelanguage')) {
        return { status: 200, body: m.geminiResponse('要約: 対応お願いします。\n締切日: 2026-07-01') };
      }
      return { status: 200, body: '{}' }; // Notion
    }
  });

  ctx.code.autoEmailToNotion();

  assert.equal(thread.state.read, true, 'スレッドが既読になる');
  assert.ok(thread.state.labels.length >= 1, 'ラベルが付与される');

  const ids = JSON.parse(ctx.props._store.PROCESSED_MESSAGE_IDS);
  assert.deepEqual(ids, ['msg-1']);

  assert.equal(ctx.lock.calls.tryLock, 1);
  assert.equal(ctx.lock.calls.releaseLock, 1, 'ロックは必ず解放される');

  // Notion に締切日付きで保存されたか
  const notionReq = ctx.fetch.requests.find((r) => r.url.includes('api.notion.com'));
  const payload = JSON.parse(notionReq.options.payload);
  assert.equal(payload.properties['締切日'].date.start, '2026-07-01');
  assert.equal(payload.properties['メールID'].rich_text[0].text.content, 'msg-1');
});

test('autoEmailToNotion: 重複IDはスキップ（Notion呼び出し無し）', () => {
  const msg = m.makeMessage({
    id: 'dup-1', subject: '問い合わせ', from: 'a@e.com',
    date: new Date(2026, 5, 15), plainBody: '十分に長い本文テキストです。'
  });
  const thread = m.makeThread([msg]);

  const ctx = setupFullRun({
    threads: [thread],
    properties: {
      GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db',
      PROCESSED_MESSAGE_IDS: JSON.stringify(['dup-1'])
    },
    fetchHandler: () => ({ status: 200, body: '{}' })
  });

  ctx.code.autoEmailToNotion();

  assert.equal(thread.state.read, false, 'スキップなので既読化しない');
  assert.equal(ctx.fetch.requests.length, 0, '外部APIは呼ばれない');
});

test('autoEmailToNotion: 短すぎる本文はスキップ', () => {
  const msg = m.makeMessage({
    id: 'short-1', subject: '問い合わせ', from: 'a@e.com',
    date: new Date(2026, 5, 15), plainBody: '短い'
  });
  const thread = m.makeThread([msg]);

  const ctx = setupFullRun({
    threads: [thread],
    properties: {
      GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db',
      PROCESSED_MESSAGE_IDS: '[]'
    },
    fetchHandler: () => ({ status: 200, body: '{}' })
  });

  ctx.code.autoEmailToNotion();
  assert.equal(ctx.fetch.requests.length, 0);
  assert.equal(thread.state.read, false);
});

test('autoEmailToNotion: ロック取得失敗時は即終了', () => {
  const ctx = setupFullRun({
    threads: [],
    properties: { GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db' },
    fetchHandler: () => ({ status: 200, body: '{}' }),
    lockAcquirable: false
  });

  ctx.code.autoEmailToNotion();
  assert.equal(ctx.fetch.requests.length, 0, '何も処理しない');
});

test('autoEmailToNotion: APIキー未設定でエラー通知メール送信', () => {
  const ctx = setupFullRun({
    threads: [],
    properties: {}, // キー無し
    fetchHandler: () => ({ status: 200, body: '{}' })
  });

  ctx.code.autoEmailToNotion();
  assert.equal(ctx.gmail.sentEmails.length, 1, 'エラー通知が送られる');
  assert.ok(ctx.gmail.sentEmails[0].subject.includes('エラー'));
  assert.equal(ctx.lock.calls.releaseLock, 1, 'エラーでもロック解放');
});

test('autoEmailToNotion: Notion保存失敗時は既読化せずID記録しない', () => {
  const msg = m.makeMessage({
    id: 'fail-1', subject: '問い合わせ', from: 'a@e.com',
    date: new Date(2026, 5, 15), plainBody: '十分に長い問い合わせ本文です。'
  });
  const thread = m.makeThread([msg]);

  const ctx = setupFullRun({
    threads: [thread],
    properties: {
      GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db',
      PROCESSED_MESSAGE_IDS: '[]'
    },
    fetchHandler: (url) => {
      if (url.includes('generativelanguage')) {
        return { status: 200, body: m.geminiResponse('要約: テスト\n締切日: なし') };
      }
      return { status: 400, body: 'bad' }; // Notion 失敗
    }
  });

  ctx.code.autoEmailToNotion();

  assert.equal(thread.state.read, false);
  assert.deepEqual(JSON.parse(ctx.props._store.PROCESSED_MESSAGE_IDS), []);
});

test('autoEmailToNotion: PlainBody空ならHTMLをsanitizeして使用', () => {
  const msg = m.makeMessage({
    id: 'html-1', subject: '問い合わせ', from: 'a@e.com',
    date: new Date(2026, 5, 15), plainBody: '',
    htmlBody: '<p>HTMLメールの本文です。十分な長さがあります。</p>'
  });
  const thread = m.makeThread([msg]);

  let geminiPrompt = '';
  const ctx = setupFullRun({
    threads: [thread],
    properties: {
      GEMINI_API_KEY: 'g', NOTION_API_KEY: 'n', NOTION_DATABASE_ID: 'db',
      PROCESSED_MESSAGE_IDS: '[]'
    },
    fetchHandler: (url, options) => {
      if (url.includes('generativelanguage')) {
        geminiPrompt = JSON.parse(options.payload).contents[0].parts[0].text;
        return { status: 200, body: m.geminiResponse('要約: ok\n締切日: なし') };
      }
      return { status: 200, body: '{}' };
    }
  });

  ctx.code.autoEmailToNotion();
  assert.ok(geminiPrompt.includes('HTMLメールの本文'));
  assert.ok(!geminiPrompt.includes('<p>'), 'HTMLタグは除去されている');
});
