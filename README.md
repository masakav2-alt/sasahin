# sasahin — 問い合わせメール → Notion 自動登録

「問い合わせ」メールを **Gemini** で要約し、締切日を抽出して **Notion** データベースに
自動登録する Google Apps Script です。時間主導型トリガーでの定期実行を想定しています。

- 本体: [`src/Code.gs`](src/Code.gs)
- テスト: [`test/`](test/)（Node.js 標準の `node:test` で実行）

## セットアップ

1. Apps Script プロジェクトに `src/Code.gs` の内容を貼り付けます。
2. `setupApiKeys()` を編集して各値を設定し、一度だけ実行します。
   スクリプトプロパティに以下が保存されます。
   - `GEMINI_API_KEY`
   - `NOTION_API_KEY`
   - `NOTION_DATABASE_ID`
   - `LOGS_DATABASE_ID`（任意。実行ログ用 DB。未設定ならログ保存はスキップ）
3. `autoEmailToNotion` を時間主導型トリガーに登録します。

### Notion データベースの想定プロパティ

| プロパティ名 | 型 |
| --- | --- |
| 名前 | タイトル |
| 要約 | テキスト |
| 送信者 | テキスト |
| 受信日 | 日付 |
| 締切日 | 日付（任意） |
| メールID | テキスト（重複防止用） |

## テスト

```bash
npm test
```

GAS 固有 API（`GmailApp` / `UrlFetchApp` / `PropertiesService` / `LockService` など）を
モックし、`src/Code.gs` を Node.js のサンドボックスで読み込んで検証します
（本体ファイルはそのまま GAS にも貼り付け可能）。

- `test/unit.test.js` — 純粋ロジック（パース・整形・バリデーション）
- `test/integration.test.js` — 外部 API 呼び出しとフルフロー

## オリジナルからの主な改善点

1. **重複防止IDの肥大化対策** — `PROCESSED_MESSAGE_IDS` を上限件数で打ち切り
   （`capProcessedIds`）。Apps Script のプロパティ 9KB 制限による恒久的な破綻を防止。
2. **多重起動防止** — `LockService` で重複トリガー実行をガードし、`finally` で確実に解放。
3. **締切日バリデーションの厳格化** — `2026-02-30` のような存在しない日付を拒否
   （旧 `new Date()` はロールオーバーして誤受理していた）。
4. **要約・締切日抽出の堅牢化** — Gemini に構造化出力（`要約:` / `締切日:`）を要求し、
   本文中の日付を締切日に誤検出しないようラベルを優先。要約からラベル残骸を除去。
5. **HTML サニタイズ強化** — `<script>` / `<style>` ブロックの除去、数値文字参照の
   デコードに対応。
6. **エラー通知の到達性向上** — `getActiveUser()` が空（インストール型トリガー）でも
   `getEffectiveUser()` にフォールバック。
7. **Notion 保存のリトライ** — 429 / 5xx を指数バックオフで再試行、4xx は即時失敗。
8. **Notion 文字数上限対策** — タイトル / リッチテキストを 2000 文字で安全に切り詰め。
9. **設定の定数化** — マジックナンバーを `CONFIG` / `PROP_KEYS` に集約。
10. **テスト容易性** — 副作用を持つ処理と純粋ロジックを分離し、自動テストを整備。
