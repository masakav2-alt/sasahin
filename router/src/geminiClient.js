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

  // res.body のチャンクは Buffer とは限らない（undici の fetch は Uint8Array を返す）。
  // Buffer.isBuffer では弾かれてしまい文字列化が壊れるため、TextDecoder で統一的にデコードする。
  // { stream: true } を指定し、マルチバイト文字（日本語等）がチャンク境界で分断されても安全に扱う。
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    // 実際の HTTP SSE ストリームは CRLF (\r\n) 改行で届く。チャンク境界で \r と \n が
    // 分断される可能性があるため、正規化はせず蓄積済みバッファ全体に正規表現で区切りを探す。
    let match;
    while ((match = buffer.match(/\r?\n\r?\n/)) !== null) {
      const rawEvent = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const dataLine = rawEvent.split(/\r?\n/).find(function (l) {
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
