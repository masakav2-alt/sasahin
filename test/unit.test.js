'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./helpers/load');

const code = loadCode();

test('isValidDate: 実在する日付を受理', () => {
  assert.equal(code.isValidDate('2026-06-15'), true);
  assert.equal(code.isValidDate('2024-02-29'), true); // 閏年
});

test('isValidDate: 不正・存在しない日付を拒否', () => {
  assert.equal(code.isValidDate('2026-02-30'), false); // 存在しない
  assert.equal(code.isValidDate('2026-13-01'), false); // 月超過
  assert.equal(code.isValidDate('2026-00-10'), false); // 月0
  assert.equal(code.isValidDate('2025-02-29'), false); // 非閏年
  assert.equal(code.isValidDate('2026/06/15'), false); // 形式違い
  assert.equal(code.isValidDate('15-06-2026'), false);
  assert.equal(code.isValidDate(''), false);
  assert.equal(code.isValidDate(null), false);
  assert.equal(code.isValidDate(20260615), false);
});

test('parseGeminiResult: 構造化出力から要約と締切日を抽出', () => {
  const r = code.parseGeminiResult('要約: お問い合わせの件です。\n至急対応が必要です。\n締切日: 2026-07-01');
  assert.equal(r.deadline, '2026-07-01');
  assert.ok(r.summary.includes('お問い合わせの件です'));
  assert.ok(!r.summary.includes('締切日'));
  assert.ok(!r.summary.includes('2026-07-01'));
});

test('parseGeminiResult: 締切なしの場合は null', () => {
  const r = code.parseGeminiResult('要約: 特に締切はありません。\n締切日: なし');
  assert.equal(r.deadline, null);
  assert.ok(r.summary.includes('締切はありません'));
});

test('parseGeminiResult: 本文中の日付を締切日に誤検出しない（ラベル優先）', () => {
  const r = code.parseGeminiResult('要約: 2026-01-01に受信したメールです。\n締切日: 2026-09-09');
  assert.equal(r.deadline, '2026-09-09');
});

test('parseGeminiResult: 全角コロンに対応', () => {
  const r = code.parseGeminiResult('要約：テスト\n締切日：2026-08-08');
  assert.equal(r.deadline, '2026-08-08');
  assert.equal(r.summary, 'テスト');
});

test('parseGeminiResult: 不正入力で安全に返す', () => {
  assert.deepEqual(code.parseGeminiResult(null), { summary: '', deadline: null });
  assert.deepEqual(code.parseGeminiResult(undefined), { summary: '', deadline: null });
  assert.deepEqual(code.parseGeminiResult(42), { summary: '', deadline: null });
});

test('parseGeminiResult: ラベル無しのプレーン応答でも日付を拾う', () => {
  const r = code.parseGeminiResult('概要は以下です。期限は 2026-12-31 まで。');
  assert.equal(r.deadline, '2026-12-31');
});

test('parseGeminiResult: 無効な日付はフォールバックでも採用しない', () => {
  const r = code.parseGeminiResult('要約: テスト\n締切日: 2026-02-30');
  assert.equal(r.deadline, null);
});

test('extractSenderName: 表示名を抽出', () => {
  assert.equal(code.extractSenderName('John Doe <john@example.com>'), 'John Doe');
  assert.equal(code.extractSenderName('"山田 太郎" <taro@example.com>'), '山田 太郎');
  assert.equal(code.extractSenderName('<only@example.com>'), 'only@example.com');
  assert.equal(code.extractSenderName('plain@example.com'), 'plain@example.com');
  assert.equal(code.extractSenderName(''), '');
  assert.equal(code.extractSenderName(null), '');
});

test('sanitizeHtml: タグ除去と改行保持', () => {
  const out = code.sanitizeHtml('<p>こんにちは</p><br>世界<div>行</div>');
  assert.ok(out.includes('こんにちは'));
  assert.ok(out.includes('世界'));
  assert.ok(out.includes('\n'));
  assert.ok(!out.includes('<'));
});

test('sanitizeHtml: script/style ブロックを除去', () => {
  const out = code.sanitizeHtml('<style>.a{color:red}</style><script>alert(1)</script>本文');
  assert.equal(out, '本文');
  assert.ok(!out.includes('alert'));
  assert.ok(!out.includes('color'));
});

test('sanitizeHtml: 実体参照をデコード', () => {
  const out = code.sanitizeHtml('A &amp; B &lt;tag&gt; &nbsp;X &#65;');
  assert.ok(out.includes('A & B'));
  assert.ok(out.includes('<tag>'));
  assert.ok(out.includes('A')); // &#65; -> A
});

test('sanitizeHtml: 空入力', () => {
  assert.equal(code.sanitizeHtml(''), '');
  assert.equal(code.sanitizeHtml(null), '');
});

test('formatDateToISO: ゼロ埋め', () => {
  assert.equal(code.formatDateToISO(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(code.formatDateToISO(new Date(2026, 11, 31)), '2026-12-31');
});

test('truncateBody: 上限以下はそのまま', () => {
  const r = code.truncateBody('short', 100);
  assert.equal(r.body, 'short');
  assert.equal(r.wasTruncated, false);
});

test('truncateBody: 上限超過で切り詰め＋注記', () => {
  const r = code.truncateBody('x'.repeat(50), 10);
  assert.equal(r.wasTruncated, true);
  assert.ok(r.body.startsWith('xxxxxxxxxx'));
  assert.ok(r.body.includes('省略'));
});

test('truncateBody: 空入力', () => {
  assert.deepEqual(code.truncateBody('', 10), { body: '', wasTruncated: false });
  assert.deepEqual(code.truncateBody(null, 10), { body: '', wasTruncated: false });
});

test('capProcessedIds: 上限超過分を古い順に削除', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(code.capProcessedIds(ids, 3), ['c', 'd', 'e']);
  assert.deepEqual(code.capProcessedIds(ids, 5), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(code.capProcessedIds(ids, 10), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(code.capProcessedIds('nope', 3), []);
});

test('truncateText: Notion 2000文字制限', () => {
  assert.equal(code.truncateText('x'.repeat(2500), 2000).length, 2000);
  assert.equal(code.truncateText('ok', 2000), 'ok');
  assert.equal(code.truncateText(null, 2000), '');
});

test('buildNotionProperties: 必須プロパティと締切日の条件付与', () => {
  const props = code.buildNotionProperties(
    '件名', '要約本文', '2026-07-01',
    'Taro <taro@example.com>', new Date(2026, 5, 15), 'msg-123'
  );
  assert.equal(props['名前'].title[0].text.content, '件名');
  assert.equal(props['要約'].rich_text[0].text.content, '要約本文');
  assert.equal(props['送信者'].rich_text[0].text.content, 'Taro');
  assert.equal(props['受信日'].date.start, '2026-06-15');
  assert.equal(props['締切日'].date.start, '2026-07-01');
  assert.equal(props['メールID'].rich_text[0].text.content, 'msg-123');
});

test('buildNotionProperties: 締切日が無効なら付与しない', () => {
  const props = code.buildNotionProperties(
    '件名', '要約', '2026-02-30',
    'a@b.com', new Date(2026, 5, 15), 'id'
  );
  assert.equal('締切日' in props, false);
});

test('buildNotionProperties: messageId 無しなら メールID 無し', () => {
  const props = code.buildNotionProperties(
    '件名', '要約', null, 'a@b.com', new Date(2026, 5, 15), null
  );
  assert.equal('メールID' in props, false);
  assert.equal('締切日' in props, false);
});

test('buildPrompt: 構造化出力を要求', () => {
  const p = code.buildPrompt('本文テキスト');
  assert.ok(p.includes('要約:'));
  assert.ok(p.includes('締切日:'));
  assert.ok(p.includes('本文テキスト'));
});
