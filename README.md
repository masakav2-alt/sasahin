# sasahin — GAS 自動化スクリプト集

Google Apps Script による自動化スクリプトを、Node.js のテストとともに管理するリポジトリです。

| システム | 本体 | テスト |
| --- | --- | --- |
| [問い合わせメール → Notion 自動登録](#問い合わせメール--notion-自動登録) | [`src/Code.gs`](src/Code.gs) | `test/unit.test.js` / `test/integration.test.js` |
| [仮想通貨ペーパートレードボット](#仮想通貨ペーパートレードボット) | [`src/CryptoBot.gs`](src/CryptoBot.gs) | `test/crypto-unit.test.js` / `test/crypto-integration.test.js` |

## 問い合わせメール → Notion 自動登録

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

## 仮想通貨ペーパートレードボット

仮想通貨の価格を **CoinGecko** の公開 API（APIキー不要）から取得し、テクニカル指標で
売買シグナルを判定して**仮想売買（ペーパートレード）** を行う Google Apps Script です。
取引は **Notion** データベースに記録し、メールで通知します。
時間主導型トリガー（1日1回程度）での定期実行を想定しています。

> ⚠️ **免責事項**: 本スクリプトはシミュレーション（ペーパートレード）であり、
> 実際の資産は一切動かしません。利益を保証するものでもありません。
> 実売買へ拡張して運用する場合は、投資判断・損失リスクはすべて自己責任となります。

- 本体: [`src/CryptoBot.gs`](src/CryptoBot.gs)
- テスト: `test/crypto-unit.test.js` / `test/crypto-integration.test.js`

### 仕組み

1. `CRYPTO_CONFIG.COINS`（既定は BTC / ETH）の日足終値を CoinGecko から取得
2. シグナル判定（優先順）
   - **ゴールデンクロス**（短期SMAが長期SMAを上抜け）かつ RSI が買われすぎでない → **BUY**
   - **デッドクロス**（短期SMAが長期SMAを下抜け）→ **SELL**
   - RSI ≤ 30（売られすぎ）→ **BUY** / RSI ≥ 70（買われすぎ）→ **SELL**
3. スクリプトプロパティに保存した仮想ポートフォリオ（初期資金 10 万円）に対して売買を執行
   - BUY: 現金の 20% を予算に、手数料 0.15% を差し引いて購入
   - SELL: 対象コインを全量売却し、実現損益を計上
   - 1コインにつき 1 日 1 回まで（トリガー多重実行での重複売買を防止）
4. 取引を Notion に記録し、メールで通知

### セットアップ

1. Apps Script プロジェクトに `src/CryptoBot.gs` の内容を貼り付けます
   （`src/Code.gs` と同一プロジェクトでも名前は衝突しません）。
2. `setupCryptoProperties()` を編集して各値を設定し、一度だけ実行します。
   - `NOTION_API_KEY`（`Code.gs` と共用。未設定なら Notion 記録はスキップ）
   - `TRADES_DATABASE_ID`（取引記録用 DB。任意）
   - `CRYPTO_PORTFOLIO`（仮想ポートフォリオ。自動初期化）
3. `autoCryptoTrade` を時間主導型トリガー（日次）に登録します。

補助関数: `showPortfolio()`（ポートフォリオ確認）/ `resetPortfolio()`（初期資金にリセット）

### Notion データベースの想定プロパティ（取引記録）

| プロパティ名 | 型 |
| --- | --- |
| 名前 | タイトル（例: `BUY BTC @ ¥1,000,000`） |
| 通貨 | テキスト |
| 売買 | テキスト |
| 価格 | 数値 |
| 数量 | 数値 |
| 金額 | 数値 |
| 手数料 | 数値 |
| 理由 | テキスト |
| 日時 | 日付 |
| 現金残高 | 数値 |
| 実現損益 | 数値（SELL のみ） |

### 実売買への拡張

`autoCryptoTrade` 内の `executePaperTrade` 呼び出しを取引所 API（現物注文）の呼び出しに
差し替えることで実売買へ拡張できます。シグナル判定・記録・通知はそのまま流用可能です。
まずはペーパートレードで一定期間シグナルの成績を検証することを強く推奨します。

## テスト

```bash
npm test
```

GAS 固有 API（`GmailApp` / `UrlFetchApp` / `PropertiesService` / `LockService` など）を
モックし、`src/*.gs` を Node.js のサンドボックスで読み込んで検証します
（本体ファイルはそのまま GAS にも貼り付け可能）。

- `test/unit.test.js` — メール→Notion: 純粋ロジック（パース・整形・バリデーション）
- `test/integration.test.js` — メール→Notion: 外部 API 呼び出しとフルフロー
- `test/crypto-unit.test.js` — 仮想通貨ボット: 指標計算・シグナル判定・売買計算
- `test/crypto-integration.test.js` — 仮想通貨ボット: CoinGecko / Notion 連携とフルフロー

## メール→Notion: オリジナルからの主な改善点

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
