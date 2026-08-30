'use strict';

const http = require('http');
const crypto = require('crypto');
const { loadConfig, resolveGeminiModel } = require('./config');
const {
  buildGeminiRequest,
  geminiResponseToAnthropic,
  extractGeminiText,
  mapFinishReason
} = require('./translate');
const geminiClient = require('./geminiClient');

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on('data', function (c) {
      chunks.push(c);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

// Anthropic API のエラーレスポンス形式に合わせる
// （Claude Code 側がエラーメッセージをそのまま表示できるように）。
function sendAnthropicError(res, status, message, type) {
  sendJson(res, status, {
    type: 'error',
    error: { type: type || 'api_error', message: message }
  });
}

function writeSseEvent(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

async function handleStreamingMessages(res, config, anthropicReq, requestedModel, geminiModel, geminiReq, messageId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' }
  });

  let finishReason = null;
  let outputTokens = 0;

  try {
    for await (const chunk of geminiClient.streamGenerateContent(config, geminiModel, geminiReq)) {
      const candidate = chunk.candidates && chunk.candidates[0];
      const text = extractGeminiText(candidate);
      if (text) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: text }
        });
      }
      if (candidate && candidate.finishReason) finishReason = candidate.finishReason;
      if (chunk.usageMetadata && typeof chunk.usageMetadata.candidatesTokenCount === 'number') {
        outputTokens = chunk.usageMetadata.candidatesTokenCount;
      }
    }
  } catch (error) {
    writeSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '\n[router error] ' + error.message }
    });
    finishReason = finishReason || 'OTHER';
  }

  writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleMessages(req, res, config) {
  let anthropicReq;
  try {
    const raw = await readBody(req);
    anthropicReq = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendAnthropicError(res, 400, 'リクエストボディが不正な JSON です: ' + e.message, 'invalid_request_error');
  }

  if (!config.apiKey) {
    return sendAnthropicError(res, 500, 'GEMINI_API_KEY が設定されていません', 'api_error');
  }

  const requestedModel = anthropicReq.model || config.defaultModel;
  const geminiModel = resolveGeminiModel(config, requestedModel);
  const geminiReq = buildGeminiRequest(anthropicReq);
  const messageId = 'msg_' + crypto.randomUUID();

  if (anthropicReq.stream) {
    return handleStreamingMessages(res, config, anthropicReq, requestedModel, geminiModel, geminiReq, messageId);
  }

  try {
    const geminiResp = await geminiClient.generateContent(config, geminiModel, geminiReq);
    const anthropicResp = geminiResponseToAnthropic(geminiResp, requestedModel, messageId);
    return sendJson(res, 200, anthropicResp);
  } catch (error) {
    return sendAnthropicError(res, error.status || 502, error.message, 'api_error');
  }
}

function createServer(config) {
  config = config || loadConfig();

  return http.createServer(function (req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
      return handleMessages(req, res, config).catch(function (error) {
        if (!res.headersSent) {
          sendAnthropicError(res, 500, error.message, 'api_error');
        } else {
          res.end();
        }
      });
    }
    return sendAnthropicError(res, 404, 'Not found: ' + req.method + ' ' + req.url, 'not_found_error');
  });
}

module.exports = {
  createServer: createServer,
  handleMessages: handleMessages,
  readBody: readBody
};
