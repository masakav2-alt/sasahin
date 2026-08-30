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
export GEMINI_MODEL="gemini-3.5-flash"      # 既定の変換先モデル
export ROUTER_PORT=3456                     # 待受ポート
export GEMINI_THINKING_BUDGET=0             # 内部思考トークン予算（0=無効化, -1=モデル任せ）

# 任意: Claude のモデル名ごとに変換先 Gemini モデルを変えたい場合
export GEMINI_MODEL_MAP='{"claude-3-5-sonnet-20241022":"gemini-3.5-flash","claude-3-5-haiku-20241022":"gemini-3.1-flash-lite"}'

node router/bin/claude-gemini-router.js
```

Gemini のモデル名は頻繁に更新されるため、`gemini-flash-latest` のような
「常に最新版を指すエイリアス」も用意されていますが、新しいプレビュー版は
一時的に混雑して `503` を返すことがあります。安定運用したい場合は
`gemini-3.5-flash` のような具体的なバージョン名の指定を推奨します。
利用可能なモデル一覧は `GET https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY`
で確認できます。

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

### 実機検証で判明した注意点

- Gemini の一部モデル（`gemini-3.5-flash` 等）は既定で内部思考（thinking）を
  行い、その分のトークンも `max_tokens` の予算から消費します。`max_tokens` を
  小さくしすぎると、本文を出力する前に予算を使い切って **空の応答** が
  返ることがあります。本ルーターは既定で `GEMINI_THINKING_BUDGET=0`
  （思考無効化）を設定してこれを回避していますが、必要に応じて調整してください。
- Gemini のモデル名は廃止・置き換えが頻繁です。`404 model is no longer
  available` エラーが出た場合は `GEMINI_MODEL` を現行モデルに変更してください。

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
