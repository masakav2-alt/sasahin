'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractText,
  anthropicRoleToGemini,
  buildGeminiRequest,
  mapFinishReason,
  extractGeminiText,
  geminiResponseToAnthropic
} = require('../src/translate');

test('extractText: 文字列はそのまま返す', () => {
  assert.equal(extractText('こんにちは'), 'こんにちは');
});

test('extractText: テキストブロック配列を連結する', () => {
  const content = [
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' }
  ];
  assert.equal(extractText(content), 'A\nB');
});

test('extractText: text 以外のブロック（tool_use 等）は無視する', () => {
  const content = [
    { type: 'text', text: 'こんにちは' },
    { type: 'tool_use', id: 'x', name: 'search', input: {} }
  ];
  assert.equal(extractText(content), 'こんにちは');
});

test('extractText: null/undefined/その他は空文字', () => {
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
  assert.equal(extractText(42), '');
});

test('anthropicRoleToGemini: assistant -> model, それ以外 -> user', () => {
  assert.equal(anthropicRoleToGemini('assistant'), 'model');
  assert.equal(anthropicRoleToGemini('user'), 'user');
});

test('buildGeminiRequest: メッセージと system と生成パラメータを変換する', () => {
  const req = buildGeminiRequest({
    system: 'あなたは親切なアシスタントです。',
    max_tokens: 1024,
    temperature: 0.5,
    top_p: 0.9,
    stop_sequences: ['STOP'],
    messages: [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: [{ type: 'text', text: 'どうしましたか?' }] }
    ]
  });

  assert.deepEqual(req.contents, [
    { role: 'user', parts: [{ text: 'こんにちは' }] },
    { role: 'model', parts: [{ text: 'どうしましたか?' }] }
  ]);
  assert.deepEqual(req.systemInstruction, { parts: [{ text: 'あなたは親切なアシスタントです。' }] });
  assert.deepEqual(req.generationConfig, {
    maxOutputTokens: 1024,
    temperature: 0.5,
    topP: 0.9,
    stopSequences: ['STOP']
  });
});

test('buildGeminiRequest: 空のテキストしかないメッセージは除外する', () => {
  const req = buildGeminiRequest({
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ignored' }] },
      { role: 'user', content: '有効なメッセージ' }
    ]
  });
  assert.equal(req.contents.length, 1);
  assert.equal(req.contents[0].parts[0].text, '有効なメッセージ');
});

test('buildGeminiRequest: system や generationConfig が無ければキー自体を作らない', () => {
  const req = buildGeminiRequest({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('systemInstruction' in req, false);
  assert.equal('generationConfig' in req, false);
});

test('buildGeminiRequest: thinkingBudget を指定すると thinkingConfig に反映される', () => {
  const req = buildGeminiRequest({ messages: [{ role: 'user', content: 'hi' }] }, { thinkingBudget: 0 });
  assert.deepEqual(req.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('buildGeminiRequest: thinkingBudget 未指定なら thinkingConfig を作らない', () => {
  const req = buildGeminiRequest({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('thinkingConfig' in req.generationConfig, false);
});

test('mapFinishReason: 既知の値をマップし、未知の値は end_turn', () => {
  assert.equal(mapFinishReason('STOP'), 'end_turn');
  assert.equal(mapFinishReason('MAX_TOKENS'), 'max_tokens');
  assert.equal(mapFinishReason('SAFETY'), 'stop_sequence');
  assert.equal(mapFinishReason('UNKNOWN_VALUE'), 'end_turn');
  assert.equal(mapFinishReason(undefined), 'end_turn');
});

test('extractGeminiText: parts の text を連結する', () => {
  const candidate = { content: { parts: [{ text: 'こん' }, { text: 'にちは' }] } };
  assert.equal(extractGeminiText(candidate), 'こんにちは');
});

test('extractGeminiText: candidate が無い/不正な形でも空文字を返す', () => {
  assert.equal(extractGeminiText(null), '');
  assert.equal(extractGeminiText({}), '');
  assert.equal(extractGeminiText({ content: {} }), '');
});

test('geminiResponseToAnthropic: Anthropic Messages API 形式に変換する', () => {
  const geminiResp = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: 'こんにちは！' }] },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 }
  };

  const result = geminiResponseToAnthropic(geminiResp, 'claude-3-5-sonnet-20241022', 'msg_123');

  assert.equal(result.id, 'msg_123');
  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.model, 'claude-3-5-sonnet-20241022');
  assert.deepEqual(result.content, [{ type: 'text', text: 'こんにちは！' }]);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 });
});

test('geminiResponseToAnthropic: usageMetadata が無くても 0 で埋める', () => {
  const geminiResp = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };
  const result = geminiResponseToAnthropic(geminiResp, 'model', 'msg_1');
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});
