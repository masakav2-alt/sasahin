# エピソード1「おほしさまを かぞえよう（1〜5）」

- 1クリップ = 約8秒（Veo3 の標準長）。全 7 クリップ ≒ 56 秒。
- 縦動画（Shorts）にする場合は `9:16`、通常動画は `16:9` を生成設定で指定。
- 各プロンプトの `[STYLE]` `[MOMO]` `[POPO]` は character_bible.md の固定記述に置換して使う。
- 台詞の日本語は Veo3 が読み間違えることがある。生成後に確認し、崩れたら台詞だけ短く言い換える。

---

## クリップ1：オープニング
```
[STYLE]. A sunny meadow at dawn with a soft pastel sky. [MOMO] waves at the camera and smiles. [POPO] floats beside her in a bubble, blowing rainbow bubbles. Audio: gentle cheerful xylophone and ukulele melody, soft and slow. Momo says in a bright, slow, child-friendly Japanese voice: "こんにちは！モモだよ！" Popo says: "ポポだよ！いっしょに おほしさまを かぞえよう！"
```

## クリップ2：数字の1
```
[STYLE]. Close-up of [MOMO] on a grassy hill at twilight, gently pointing up at a sky where one single glowing yellow star twinkles. A big friendly number "1" made of soft light appears next to the star. Audio: same gentle xylophone melody, a soft twinkle sound when the star appears. Momo says slowly in Japanese: "おほしさま、いち！"
```

## クリップ3：数字の2
```
[STYLE]. [POPO] blows two rainbow bubbles from his blowhole. Each bubble pops with a soft sparkle and turns into a small glowing yellow star in the pastel evening sky. A big friendly number "2" made of soft light appears. [MOMO] claps happily beside him. Audio: gentle xylophone melody, soft pop and twinkle sounds. Popo says slowly in Japanese: "いち、に！おほしさま、に！"
```

## クリップ4：数字の3
```
[STYLE]. [MOMO] and [POPO] sit together on a hill. Three glowing yellow stars drift down slowly like feathers. Momo catches one in her paws, Popo catches one in a bubble, and one lands on her yellow raincoat button. Big number "3" in soft light. Audio: gentle xylophone melody, soft twinkle. Both say in Japanese, counting slowly: "いち、に、さん！"
```

## クリップ5：数字の4
```
[STYLE]. Four small glowing stars twirl in a circle around [MOMO] and [POPO], who spin gently and laugh. Big number "4" appears in soft light. Smooth slow camera orbit around the characters. Audio: gentle xylophone melody with a soft chime for each star. Together in Japanese: "いち、に、さん、し！"
```

## クリップ6：数字の5
```
[STYLE]. Five glowing stars line up in the night sky and form a happy smile-shaped arc above [MOMO] and [POPO]. Both look up in wonder. Big number "5" appears in soft light. Audio: gentle xylophone melody building softly, a warm chime. Together in Japanese: "いち、に、さん、し、ご！ごこの おほしさま！"
```

## クリップ7：エンディング
```
[STYLE]. [MOMO] and [POPO] wave goodbye on the hill under a calm starry sky; the five stars twinkle and the camera slowly rises. Audio: gentle xylophone melody fading out softly. Momo says in Japanese: "みてくれて ありがとう！" Popo says: "またね！ばいばーい！"
```

---

## 編集メモ（ffmpeg 等で結合）
1. クリップ1→7 を順に連結。クリップ間は 0.3 秒のクロスフェード。
2. 字幕（ひらがな）を追加。数字は画面下に大きく表示。
3. BGM の音量差が出た場合は loudnorm で揃える。

## 投稿メモ
- タイトル例: `【かぞえうた】おほしさまを かぞえよう 1〜5｜モモとポポ｜知育・幼児向け`
- 設定: 「子ども向け」= はい、「改変または合成されたコンテンツ」= AI 生成として申告。
- 説明欄に「AI 生成のオリジナルキャラクター」と明記。
