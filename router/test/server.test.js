'use strict';
const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../src/server');

afterEach(() => {
  mock.reset();
});

function startTestServer(config) {
  const server = createServer(config);
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

function request(port, path, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const baseConfig = { apiBase: 'https://example.test/v1beta', apiKey: 'test-key', defaultModel: 'gemini-2.0-flash', modelMap: {} };

test('GET /health は 200 を返す', async () => {
  const server = await startTestServer(baseConfig);
  try {
    const res = await request(server.address().port, '/health', 'GET');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  } finally {
    server.close();
  }
});

test('未知のパスは 404 (Anthropic 形式のエラー)', async () => {
  const server = await startTestServer(baseConfig);
  try {
    const res = await request(server.address().port, '/unknown', 'GET');
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).type, 'error');
  } finally {
    server.close();
  }
});

test('POST /v1/messages (非ストリーミング): Gemini 応答を Anthropic 形式に変換して返す', async () => {
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'こんにちは！' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 }
      })
  }));

  const server = await startTestServer(baseConfig);
  try {
    const res = await request(server.address().port, '/v1/messages', 'POST', {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'こんにちは' }]
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.type, 'message');
    assert.equal(json.role, 'assistant');
    assert.equal(json.model, 'claude-3-5-sonnet-20241022');
    assert.deepEqual(json.content, [{ type: 'text', text: 'こんにちは！' }]);
    assert.equal(json.stop_reason, 'end_turn');
    assert.deepEqual(json.usage, { input_tokens: 3, output_tokens: 4 });
  } finally {
    server.close();
  }
});

test('POST /v1/messages: GEMINI_API_KEY 未設定なら 500', async () => {
  const server = await startTestServer(Object.assign({}, baseConfig, { apiKey: '' }));
  try {
    const res = await request(server.address().port, '/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(res.status, 500);
    assert.match(JSON.parse(res.body).error.message, /GEMINI_API_KEY/);
  } finally {
    server.close();
  }
});

test('POST /v1/messages: 不正な JSON ボディは 400', async () => {
  const server = await startTestServer(baseConfig);
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: server.address().port, path: '/v1/messages', method: 'POST' },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.write('{not json');
      req.end();
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /v1/messages: Gemini がエラーを返したら 502 系で転送する', async () => {
  global.fetch = mock.fn(async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } })
  }));

  const server = await startTestServer(baseConfig);
  try {
    const res = await request(server.address().port, '/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(res.status, 429);
    assert.match(JSON.parse(res.body).error.message, /Rate limit exceeded/);
  } finally {
    server.close();
  }
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

test('POST /v1/messages (ストリーミング): Anthropic SSE イベント列を返す', async () => {
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    body: sseBodyFrom([
      { candidates: [{ content: { parts: [{ text: 'こん' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: 'にちは' }] }, finishReason: 'STOP' }],
        usageMetadata: { candidatesTokenCount: 2 }
      }
    ])
  }));

  const server = await startTestServer(baseConfig);
  try {
    const raw = await request(server.address().port, '/v1/messages', 'POST', {
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    });
    assert.equal(raw.status, 200);
    assert.match(raw.headers['content-type'], /text\/event-stream/);

    const events = raw.body
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const lines = block.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event:'));
        const dataLine = lines.find((l) => l.startsWith('data:'));
        return { event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) };
      });

    assert.equal(events[0].event, 'message_start');
    assert.equal(events[1].event, 'content_block_start');

    const deltaEvents = events.filter((e) => e.event === 'content_block_delta');
    assert.deepEqual(
      deltaEvents.map((e) => e.data.delta.text),
      ['こん', 'にちは']
    );

    const messageDelta = events.find((e) => e.event === 'message_delta');
    assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');
    assert.equal(messageDelta.data.usage.output_tokens, 2);

    assert.equal(events[events.length - 1].event, 'message_stop');
  } finally {
    server.close();
  }
});
