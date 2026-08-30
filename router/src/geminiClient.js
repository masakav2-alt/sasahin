'use strict';

/**
 * Gemini API への薄いクライアント。
 * ネットワーク I/O をここに閉じ込め、translate.js を純粋関数のまま保つ。
 */

function buildUrl(apiBase, model, apiKey, method) {
  return apiBase + '/models/' + encodeURIComponent(model) + ':' + method +
    '?key=' + encodeURIComponent(apiKey);
}

function extractErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return (parsed && parsed.error && parsed.error.message) || text;
  } catch (e) {
    return text;
  }
}

// 非ストリーミング呼び出し。
async function generateContent(config, model, geminiReq) {
  const url = buildUrl(config.apiBase, model, config.apiKey, 'generateContent');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiReq)
  });

  const text = await res.text();

  if (!res.ok) {
    const err = new Error('Gemini API error (' + res.status + '): ' + extractErrorMessage(text));
    err.status = res.status;
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Gemini から不正な JSON が返されました: ' + text.slice(0, 500));
  }
}

// ストリーミング呼び出し。Gemini の SSE (`alt=sse`) を1チャンクずつ JSON にして yield する。
// 各チャンクの text は「これまでの累計」ではなく「今回追加された差分」である点に注意。
async function* streamGenerateContent(config, model, geminiReq) {
  const url = buildUrl(config.apiBase, model, config.apiKey, 'streamGenerateContent') + '&alt=sse';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiReq)
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error('Gemini API error (' + res.status + '): ' + extractErrorMessage(errText));
    err.status = res.status;
    throw err;
  }

  let buffer = '';
  for await (const chunk of res.body) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;

    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      const dataLine = rawEvent.split('\n').find(function (l) {
        return l.indexOf('data:') === 0;
      });
      if (!dataLine) continue;

      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      yield JSON.parse(jsonStr);
    }
  }
}

module.exports = {
  buildUrl: buildUrl,
  generateContent: generateContent,
  streamGenerateContent: streamGenerateContent
};
