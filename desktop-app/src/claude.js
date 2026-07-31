'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./persona');

// Claude Sonnet 5 との会話を担うラッパー。ストリーミングで応答を受け取り、
// テキストの差分（デルタ）をコールバックで返します。

const MAX_HISTORY_TURNS = 20; // 直近のやり取りのみ保持（user+assistant で 1 ターン）

function createClient(apiKey) {
  return new Anthropic({ apiKey });
}

/**
 * ストリーミングでClaudeに問い合わせます。
 * @param {Anthropic} client
 * @param {Array<{role:string, content:string}>} history 会話履歴（今回のuser発話を含む）
 * @param {string} model
 * @param {(text:string)=>void} onDelta テキスト差分ごとに呼ばれる
 * @returns {Promise<string>} 応答の全文
 */
async function streamReply(client, history, model, onDelta) {
  const stream = client.messages.stream({
    model: model || 'claude-sonnet-5',
    max_tokens: 1024,
    // マスコットとしての応答速度を優先し、思考は無効化します。
    thinking: { type: 'disabled' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }, // 固定のシステムプロンプトをキャッシュ
      },
    ],
    messages: history,
  });

  stream.on('text', (delta) => {
    if (delta) onDelta(delta);
  });

  const finalMessage = await stream.finalMessage();
  const text = (finalMessage.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text;
}

// 履歴を上限ターン数に丸めます（先頭のuserから始まるように調整）。
function trimHistory(history) {
  const maxMessages = MAX_HISTORY_TURNS * 2;
  let trimmed = history.slice(-maxMessages);
  while (trimmed.length && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

module.exports = { createClient, streamReply, trimHistory, MAX_HISTORY_TURNS };
