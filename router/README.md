# claude-gemini-router

Claude Code のリクエストをローカルで受け止め、**Google Gemini** に転送する
ルータープラグインです。[claude-code-router](https://github.com/musistudio/claude-code-router)
と同じ発想（Anthropic Messages API 互換のローカルプロキシを立て、
`ANTHROPIC_BASE_URL` でそこに向ける）を、Gemini 専用に最小構成で実装しています。

外部ライブラリ非依存（Node.js 標準の `http` / グローバル `fetch` のみ）。

## しくみ

```
Claude Code  --(Anthropic Messages API)-->  claude-gemini-router  --(Gemini API)-->  Gemini
             <--(Anthropic Messages API)--                        <--(Gemini API)--
```

1. `POST /v1/messages` で Anthropic Messages API 形式のリクエストを受け取る
2. `src/translate.js` が Gemini の `generateContent` / `streamGenerateContent`
   形式に変換
3. `src/geminiClient.js` が Gemini API を呼び出す
4. レスポンス（非ストリーミング JSON、またはストリーミング SSE）を
   Anthropic Messages API 形式に変換して返す

## セットアップ

```bash
export GEMINI_API_KEY="your_gemini_api_key"

# 任意（省略時のデフォルト）
export GEMINI_MODEL="gemini-2.0-flash"     # 既定の変換先モデル
export ROUTER_PORT=3456                     # 待受ポート

# 任意: Claude のモデル名ごとに変換先 Gemini モデルを変えたい場合
export GEMINI_MODEL_MAP='{"claude-3-5-sonnet-20241022":"gemini-2.0-flash","claude-3-5-haiku-20241022":"gemini-2.0-flash-lite"}'

node router/bin/claude-gemini-router.js
```

起動後、別のターミナルで Claude Code をこのルーター経由にします。

```bash
export ANTHROPIC_BASE_URL="http://localhost:3456"
claude
```

これで Claude Code から送られる会話が Gemini によって処理されます。

## 対応範囲・既知の制限

- **対応**: テキストの会話、system プロンプト、`max_tokens` /
  `temperature` / `top_p` / `stop_sequences`、ストリーミング応答。
- **非対応（現バージョン）**:
  - tool_use / tool_result（Claude Code のツール呼び出し）— テキストブロック
    以外は無視されます。Gemini の Function Calling とのスキーマ変換は未実装。
  - 画像などのマルチモーダル入力。
  - トークンカウントは Gemini 側の `usageMetadata` をそのまま転記するため、
    Anthropic 本来の課金カウントとは一致しません。

これらは将来の拡張ポイントとして `src/translate.js` に集約してあります。

## テスト

```bash
npm test
```

ネットワークアクセスは行わず、`global.fetch` をモックして
Gemini API とのやり取りを再現します（`GEMINI_API_KEY` は不要）。

- `test/config.test.js` — 環境変数からの設定読み込み
- `test/translate.test.js` — Anthropic ⇔ Gemini 変換ロジック（純粋関数）
- `test/geminiClient.test.js` — Gemini API 呼び出し（非ストリーミング / ストリーミング）
- `test/server.test.js` — HTTP サーバー全体の結合テスト
