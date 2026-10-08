# きみどこ (在席管理ボード)

部署別に「誰がいまどこにいるか」を一覧できる在席管理システム。`schema.sql` の5テーブルに準拠。

## 起動

```bash
npm install
npm start            # http://localhost:3000 (PGlite 組込みDB、初期データ自動投入)
DATABASE_URL=postgres://... npm start   # PostgreSQL を使う場合
npm test
```

環境変数: `PORT`, `DATABASE_URL`, `PGLITE_DIR`(PGlite永続化ディレクトリ), `SEED=0`(初期データ無効)

## 機能

- 部署別在席ボード(色・アイコン付きステータス、15秒自動更新)
- ステータスのワンクリック変更、代理更新(更新者を記録・表示)
- ステータスマスタ管理(最大30個、色 `#RRGGBB`、アイコンURL/絵文字)
- 行動予定(行き先・備考)、現在/次の予定をカードに表示
- 予定の自動反映: 開始時刻でステータス切替(予定開始後の手動更新は尊重)、終了で既定(表示順先頭)へ復帰。30秒ごと
- Google/Outlook カレンダーの `.ics` 取り込み(`source` に記録。TZID なしは JST とみなす)
- お気に入り登録と絞り込み、部署・ステータス・氏名検索

## API 概要

`/api/{departments,statuses,users}` CRUD / `PUT /api/users/:id/status` / `GET|POST /api/users/:id/schedules` /
`POST /api/users/:id/schedules/import-ics` / `DELETE /api/schedules/:id` /
`GET|PUT|DELETE /api/users/:id/favorites[/:favId]` / `GET /api/board?department_id&favorites_of&q&status_id`

## 未実装

認証・権限(現在は画面上部「私は」で操作者を選択)、グループウェアとの直接連携(.ics 取り込みのみ)、ステータス履歴。
