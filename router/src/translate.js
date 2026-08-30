'use strict';

/**
 * Claude (Anthropic Messages API) 形式のリクエスト/レスポンスと
 * Gemini API 形式の相互変換ロジック。
 *
 * 設計メモ:
 *  - ネットワークアクセスを含まない純粋関数のみをここに置く（テスト容易性のため）。
 *  - スコープ: テキスト会話のみ対応。tool_use / tool_result / 画像等の
 *    マルチモーダルブロックは現バージョンでは非対応（テキストブロックのみ抽出）。
 */

// Anthropic の content は string、または {type:'text', text:'...'} 等のブロック配列。
// テキストブロックのみ連結して取り出す。
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(function (block) {
      return block && block.type === 'text' && typeof block.text === 'string';
    })
    .map(function (block) {
      return block.text;
    })
    .join('\n');
}

// Anthropic の role ('user' | 'assistant') を Gemini の role ('user' | 'model') に変換。
function anthropicRoleToGemini(role) {
  return role === 'assistant' ? 'model' : 'user';
}

// Anthropic Messages API リクエストを Gemini generateContent リクエストに変換。
// options.thinkingBudget: Gemini の内部思考トークン予算。
//   小さい max_tokens だと思考だけで使い切り本文が空になることがあるため、
//   既定では 0（無効化）にして通常のテキスト応答として振る舞わせる。
function buildGeminiRequest(anthropicReq, options) {
  anthropicReq = anthropicReq || {};
  options = options || {};
  const messages = Array.isArray(anthropicReq.messages) ? anthropicReq.messages : [];

  const contents = messages
    .map(function (m) {
      const text = extractText(m && m.content);
      if (!text) return null;
      return { role: anthropicRoleToGemini(m.role), parts: [{ text: text }] };
    })
    .filter(Boolean);

  const geminiReq = { contents: contents };

  const systemText = extractText(anthropicReq.system);
  if (systemText) {
    geminiReq.systemInstruction = { parts: [{ text: systemText }] };
  }

  const generationConfig = {};
  if (typeof anthropicReq.max_tokens === 'number') {
    generationConfig.maxOutputTokens = anthropicReq.max_tokens;
  }
  if (typeof anthropicReq.temperature === 'number') {
    generationConfig.temperature = anthropicReq.temperature;
  }
  if (typeof anthropicReq.top_p === 'number') {
    generationConfig.topP = anthropicReq.top_p;
  }
  if (Array.isArray(anthropicReq.stop_sequences) && anthropicReq.stop_sequences.length > 0) {
    generationConfig.stopSequences = anthropicReq.stop_sequences;
  }
  if (typeof options.thinkingBudget === 'number') {
    generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget };
  }
  if (Object.keys(generationConfig).length > 0) {
    geminiReq.generationConfig = generationConfig;
  }

  return geminiReq;
}

const FINISH_REASON_MAP = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'stop_sequence',
  RECITATION: 'stop_sequence',
  OTHER: 'end_turn'
};

// Gemini の finishReason を Anthropic の stop_reason に変換（未知の値は end_turn 扱い）。
function mapFinishReason(reason) {
  return FINISH_REASON_MAP[reason] || 'end_turn';
}

// Gemini のレスポンス候補からテキストのみを連結して取り出す。
function extractGeminiText(candidate) {
  if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) return '';
  return candidate.content.parts
    .filter(function (p) {
      return p && typeof p.text === 'string';
    })
    .map(function (p) {
      return p.text;
    })
    .join('');
}

// Gemini generateContent レスポンス（非ストリーミング）を
// Anthropic Messages API レスポンス形式に変換。
function geminiResponseToAnthropic(geminiResp, requestedModel, messageId) {
  const candidate = geminiResp && geminiResp.candidates && geminiResp.candidates[0];
  const text = extractGeminiText(candidate);
  const usage = (geminiResp && geminiResp.usageMetadata) || {};

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content: [{ type: 'text', text: text }],
    stop_reason: mapFinishReason(candidate && candidate.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0
    }
  };
}

module.exports = {
  extractText: extractText,
  anthropicRoleToGemini: anthropicRoleToGemini,
  buildGeminiRequest: buildGeminiRequest,
  mapFinishReason: mapFinishReason,
  extractGeminiText: extractGeminiText,
  geminiResponseToAnthropic: geminiResponseToAnthropic
};
