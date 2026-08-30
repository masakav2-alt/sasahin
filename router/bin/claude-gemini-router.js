#!/usr/bin/env node
'use strict';

const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error('❌ ' + e.message);
  process.exit(1);
}

if (!config.apiKey) {
  console.error('❌ GEMINI_API_KEY が設定されていません。環境変数を設定してから起動してください。');
  process.exit(1);
}

const server = createServer(config);

server.listen(config.port, function () {
  console.log('✅ claude-gemini-router がポート ' + config.port + ' で起動しました');
  console.log('   既定の Gemini モデル: ' + config.defaultModel);
  console.log('');
  console.log('   Claude Code をこのルーター経由で動かすには、別のターミナルで:');
  console.log('     export ANTHROPIC_BASE_URL=http://localhost:' + config.port);
  console.log('     claude');
});

process.on('SIGINT', function () {
  server.close(function () {
    process.exit(0);
  });
});
