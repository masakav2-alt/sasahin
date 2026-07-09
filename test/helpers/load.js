'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'src', 'Code.gs');
const CRYPTO_SOURCE_PATH = path.join(__dirname, '..', '..', 'src', 'CryptoBot.gs');

// src/*.gs が参照しうる GAS グローバル名（関数引数として注入する）
const GAS_GLOBAL_NAMES = [
  'Logger',
  'Utilities',
  'GmailApp',
  'UrlFetchApp',
  'PropertiesService',
  'LockService',
  'Session'
];

/**
 * 指定した .gs ファイルを「現在の realm」で評価し、module.exports を返す。
 * vm.createContext と違い別 realm を作らないため、返り値の配列/オブジェクトの
 * プロトタイプが Node テスト側と一致し、deepStrictEqual が正しく動作する。
 *
 * @param {string} sourcePath 読み込む .gs ファイルの絶対パス
 * @param {object} gasGlobals 注入する GAS グローバル (GmailApp, UrlFetchApp, ...)
 * @returns {object} .gs ファイルがエクスポートする関数群
 */
function loadSource(sourcePath, gasGlobals = {}) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const moduleObj = { exports: {} };

  const params = ['module', 'exports', ...GAS_GLOBAL_NAMES];
  const wrapped = `(function(${params.join(', ')}) {\n${source}\n})`;
  const factory = vm.runInThisContext(wrapped, { filename: path.basename(sourcePath) });

  const defaults = {
    Logger: { log() {} },
    Utilities: { sleep() {} }
  };
  const resolved = Object.assign(defaults, gasGlobals);
  const args = [moduleObj, moduleObj.exports, ...GAS_GLOBAL_NAMES.map((n) => resolved[n])];

  factory(...args);
  return moduleObj.exports;
}

/** src/Code.gs (メール→Notion) を読み込む */
function loadCode(gasGlobals = {}) {
  return loadSource(SOURCE_PATH, gasGlobals);
}

/** src/CryptoBot.gs (仮想通貨ペーパートレード) を読み込む */
function loadCrypto(gasGlobals = {}) {
  return loadSource(CRYPTO_SOURCE_PATH, gasGlobals);
}

module.exports = { loadCode, loadCrypto, loadSource, SOURCE_PATH, CRYPTO_SOURCE_PATH };
