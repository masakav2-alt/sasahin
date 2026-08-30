'use strict';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_PORT = 3456;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * 環境変数からルーターの設定を読み込む。
 *  - GEMINI_API_KEY    : 必須。Gemini API キー
 *  - GEMINI_MODEL      : 既定の変換先モデル（未指定なら DEFAULT_MODEL）
 *  - GEMINI_MODEL_MAP  : 任意。Claude モデル名 -> Gemini モデル名 の JSON マップ
 *                        例: '{"claude-3-5-sonnet-20241022":"gemini-2.0-flash"}'
 *  - ROUTER_PORT       : 待受ポート（未指定なら DEFAULT_PORT）
 */
function loadConfig(env) {
  env = env || process.env;

  const apiKey = env.GEMINI_API_KEY || '';
  const port = parseInt(env.ROUTER_PORT, 10) || DEFAULT_PORT;
  const defaultModel = env.GEMINI_MODEL || DEFAULT_MODEL;

  let modelMap = {};
  if (env.GEMINI_MODEL_MAP) {
    try {
      modelMap = JSON.parse(env.GEMINI_MODEL_MAP);
    } catch (e) {
      throw new Error('GEMINI_MODEL_MAP は有効な JSON である必要があります: ' + e.message);
    }
  }

  return {
    apiKey: apiKey,
    port: port,
    defaultModel: defaultModel,
    modelMap: modelMap,
    apiBase: GEMINI_API_BASE
  };
}

/**
 * Claude Code が指定してきたモデル名を Gemini のモデル名に解決する。
 * マップに無ければ既定モデルにフォールバック（＝どんな Claude モデル名が来ても動く）。
 */
function resolveGeminiModel(config, claudeModel) {
  if (claudeModel && Object.prototype.hasOwnProperty.call(config.modelMap, claudeModel)) {
    return config.modelMap[claudeModel];
  }
  return config.defaultModel;
}

module.exports = {
  loadConfig: loadConfig,
  resolveGeminiModel: resolveGeminiModel,
  DEFAULT_MODEL: DEFAULT_MODEL,
  DEFAULT_PORT: DEFAULT_PORT,
  GEMINI_API_BASE: GEMINI_API_BASE
};
