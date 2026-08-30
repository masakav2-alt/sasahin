'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, resolveGeminiModel, DEFAULT_MODEL, DEFAULT_PORT, DEFAULT_THINKING_BUDGET } = require('../src/config');

test('loadConfig: 未設定ならデフォルト値を使う', () => {
  const config = loadConfig({});
  assert.equal(config.apiKey, '');
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.defaultModel, DEFAULT_MODEL);
  assert.equal(config.thinkingBudget, DEFAULT_THINKING_BUDGET);
  assert.deepEqual(config.modelMap, {});
});

test('loadConfig: 環境変数を反映する', () => {
  const config = loadConfig({
    GEMINI_API_KEY: 'secret',
    ROUTER_PORT: '9999',
    GEMINI_MODEL: 'gemini-1.5-pro',
    GEMINI_MODEL_MAP: '{"claude-3-5-sonnet-20241022":"gemini-1.5-pro"}',
    GEMINI_THINKING_BUDGET: '512'
  });
  assert.equal(config.apiKey, 'secret');
  assert.equal(config.port, 9999);
  assert.equal(config.defaultModel, 'gemini-1.5-pro');
  assert.deepEqual(config.modelMap, { 'claude-3-5-sonnet-20241022': 'gemini-1.5-pro' });
  assert.equal(config.thinkingBudget, 512);
});

test('loadConfig: GEMINI_MODEL_MAP が不正な JSON ならエラー', () => {
  assert.throws(() => loadConfig({ GEMINI_MODEL_MAP: 'not-json' }), /JSON/);
});

test('resolveGeminiModel: マップにあればそれを使い、無ければ既定モデル', () => {
  const config = loadConfig({ GEMINI_MODEL_MAP: '{"claude-x":"gemini-mapped"}' });
  assert.equal(resolveGeminiModel(config, 'claude-x'), 'gemini-mapped');
  assert.equal(resolveGeminiModel(config, 'unknown-model'), DEFAULT_MODEL);
  assert.equal(resolveGeminiModel(config, undefined), DEFAULT_MODEL);
});
