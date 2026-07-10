'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 設定（APIキー・音声パラメータなど）を userData ディレクトリに保存します。
// APIキーは平文でローカル保存されます。共有端末では取り扱いにご注意ください。

const DEFAULTS = {
  apiKey: '',
  model: 'claude-sonnet-5',
  voice: {
    enabled: true, // 応答を音声で読み上げるか
    lang: 'ja-JP',
    rate: 1.0, // 読み上げ速度 0.5〜2.0
    pitch: 1.1, // 声の高さ 0〜2
    voiceName: '', // OSの音声名（空なら自動選択）
  },
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const key of Object.keys(override || {})) {
    const ov = override[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && typeof out[key] === 'object') {
      out[key] = deepMerge(out[key], ov);
    } else if (ov !== undefined) {
      out[key] = ov;
    }
  }
  return out;
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (_e) {
    return deepMerge(DEFAULTS, {});
  }
}

function save(partial) {
  const merged = deepMerge(load(), partial || {});
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('設定の保存に失敗しました:', e);
  }
  return merged;
}

// 環境変数 ANTHROPIC_API_KEY が設定されていればそちらを優先します。
function resolveApiKey() {
  const cfg = load();
  return process.env.ANTHROPIC_API_KEY || cfg.apiKey || '';
}

module.exports = { DEFAULTS, load, save, resolveApiKey, configPath };
