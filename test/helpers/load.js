'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', '..', 'src', 'Code.gs');

// Code.gs が参照しうる GAS グローバル名（関数引数として注入する）
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
 * src/Code.gs を「現在の realm」で評価し、module.exports を返す。
 * vm.createContext と違い別 realm を作らないため、返り値の配列/オブジェクトの
 * プロトタイプが Node テスト側と一致し、deepStrictEqual が正しく動作する。
 *
 * @param {object} gasGlobals 注入する GAS グローバル (GmailApp, UrlFetchApp, ...)
 * @returns {object} Code.gs がエクスポートする関数群
 */
function loadCode(gasGlobals = {}) {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const moduleObj = { exports: {} };

  const params = ['module', 'exports', ...GAS_GLOBAL_NAMES];
  const wrapped = `(function(${params.join(', ')}) {\n${source}\n})`;
  const factory = vm.runInThisContext(wrapped, { filename: 'Code.gs' });

  const defaults = {
    Logger: { log() {} },
    Utilities: { sleep() {} }
  };
  const resolved = Object.assign(defaults, gasGlobals);
  const args = [moduleObj, moduleObj.exports, ...GAS_GLOBAL_NAMES.map((n) => resolved[n])];

  factory(...args);
  return moduleObj.exports;
}

module.exports = { loadCode, SOURCE_PATH };
