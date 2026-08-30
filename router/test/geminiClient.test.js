'use strict';
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const geminiClient = require('../src/geminiClient');

const config = { apiBase: 'https://example.test/v1beta', apiKey: 'test-key' };

afterEach(() => {
  mock.reset();
});

test('generateContent: 正常応答を JSON として返す', async () => {
  const body = { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] };
  global.fetch = mock.fn(async (url) => {
    assert.match(url, /^https:\/\/example\.test\/v1beta\/models\/gemini-2\.0-flash:generateContent\?key=test-key$/);
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });

  const result = await geminiClient.generateContent(config, 'gemini-2.0-flash', { contents: [] });
  assert.deepEqual(result, body);
});

test('generateContent: エラーレスポンスは Gemini のエラーメッセージを含む例外を投げる', async () => {
  global.fetch = mock.fn(async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } })
  }));

  await assert.rejects(
    geminiClient.generateContent(config, 'gemini-2.0-flash', { contents: [] }),
    /Rate limit exceeded/
  );
});

test('generateContent: 不正な JSON が返ったら例外を投げる', async () => {
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, text: async () => 'not json' }));
  await assert.rejects(geminiClient.generateContent(config, 'gemini-2.0-flash', { contents: [] }), /不正な JSON/);
});

function sseBodyFrom(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield 'data: ' + JSON.stringify(chunk) + '\n\n';
      }
    }
  };
}

test('streamGenerateContent: SSE イベントを1つずつ JSON にして yield する', async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ text: 'こん' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'にちは' }] }, finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 2 } }
  ];
  global.fetch = mock.fn(async (url) => {
    assert.match(url, /streamGenerateContent\?key=test-key&alt=sse$/);
    return { ok: true, status: 200, body: sseBodyFrom(chunks) };
  });

  const received = [];
  for await (const chunk of geminiClient.streamGenerateContent(config, 'gemini-2.0-flash', { contents: [] })) {
    received.push(chunk);
  }
  assert.deepEqual(received, chunks);
});

test('streamGenerateContent: エラー応答は例外を投げる', async () => {
  global.fetch = mock.fn(async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: { message: 'internal error' } })
  }));

  async function collect() {
    const out = [];
    for await (const c of geminiClient.streamGenerateContent(config, 'gemini-2.0-flash', {})) out.push(c);
    return out;
  }

  await assert.rejects(collect(), /internal error/);
});
