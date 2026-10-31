# Claude Code ⇄ Gemini Spark 連携運用

優先順位: ①指示出し → ②情報共有 → ③技術向上

## 前提(要確認)
- Spark の提供範囲は発表時点で Ultra 向けベータ等と報じられている。Pro プランで利用できるかは Gemini アプリ側で確認する。
- Spark の公式 API は未確認。連携は「メール」「Drive 共有ファイル」「GitHub」の既存手段で行う。

## ① 指示出し(Claude Code → Spark)
Gmail MCP で Spark 専用アドレスにメール送信する。書式は `instruction-template.md`。
- 1通=1タスク。件名先頭に `[CC→Spark]` とタスクID(`T-YYYYMMDD-NN`)。
- 完了条件と返却先(Drive の `spark_to_claude.md`)を必ず書く。
- 送信前にユーザー確認(外部送信のため)。

## ② 情報共有
Google Drive の共有フォルダ `claude-spark-sync/` に2ファイルを置く。
- `claude_to_spark.md` … Claude Code が書く(状況、決定事項、依頼の背景)
- `spark_to_claude.md` … Spark が書く(調査結果、作業報告)
各エントリは `shared-notes-template.md` の形式で追記のみ(削除・書き換えしない)。

## ③ 技術向上(週次ループ)
1. Claude Code: 開発ログ・詰まった点を `claude_to_spark.md` に追記
2. Spark: 関連の最新情報・改善案を調査して `spark_to_claude.md` に追記
3. Claude Code: 有用なものを CLAUDE.md / スキル / `docs/` に反映し、採否を `decisions.md` に記録

## ルール
- 機密情報(APIキー、顧客情報)は共有ファイル・メールに書かない。
- Spark の出力は未検証情報として扱い、反映前に確認する。
- 破壊的・対外的な操作は Spark に任せず、人が承認する。
