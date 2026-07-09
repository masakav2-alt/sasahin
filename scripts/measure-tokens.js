'use strict';
/**
 * トークン削減効果の計測スクリプト。
 *
 *   node scripts/measure-tokens.js
 *
 * 旧パイプライン（圧縮なし・先頭切り詰め・旧プロンプト）と
 * 新パイプライン（compressBody + 先頭/末尾切り詰め + 短縮プロンプト）で、
 * Gemini へ送るプロンプトの推定トークン数をサンプルメールごとに比較する。
 *
 * トークン推定: CJK 文字 ≈ 1 トークン / 文字、その他 ≈ 1 トークン / 4 文字。
 * （Gemini / Claude 系トークナイザの日本語ビジネス文での実測に近い保守的な近似）
 */
const { loadCode } = require('../test/helpers/load');

const code = loadCode();
const MAX_BODY_LENGTH = code.CONFIG.MAX_BODY_LENGTH;

// ---- 旧パイプライン（変更前の実装を再現。比較専用） ----
function oldTruncateBody(body, maxLength) {
  if (!body) return '';
  if (body.length <= maxLength) return body;
  return body.substring(0, maxLength) + '...\n\n【本文が長すぎるため、省略されています】';
}

function oldBuildPrompt(body) {
  return [
    '以下のメール本文を日本語で要約してください。',
    '次の形式で厳密に出力してください（余計な説明は不要）:',
    '要約: <3行程度の要約>',
    '締切日: <YYYY-MM-DD 形式。締切が無ければ「なし」>',
    '',
    'メール本文:',
    body
  ].join('\n');
}

function oldPipeline(rawBody) {
  return oldBuildPrompt(oldTruncateBody(rawBody, MAX_BODY_LENGTH));
}

// ---- 新パイプライン（src/Code.gs の実装をそのまま使用） ----
function newPipeline(rawBody) {
  let compressed = code.compressBody(rawBody);
  if (compressed.length < code.CONFIG.MIN_BODY_LENGTH &&
      rawBody.trim().length >= code.CONFIG.MIN_BODY_LENGTH) {
    compressed = rawBody.trim();
  }
  return code.buildPrompt(code.truncateBody(compressed, MAX_BODY_LENGTH).body);
}

// ---- トークン推定 ----
function estimateTokens(s) {
  const cjk = (s.match(/[　-鿿豈-﫿＀-｠￠-￯]/g) || []).length;
  const other = s.length - cjk;
  return Math.round(cjk + other / 4);
}

// ---- サンプルメール ----
const SIGNATURE = [
  '--',
  '━━━━━━━━━━━━━━━━━━━━━━',
  '株式会社サンプル商事 営業企画部',
  '山田 太郎 (Taro Yamada)',
  '〒100-0001 東京都千代田区千代田1-1-1 サンプルビル7F',
  'TEL: 03-0000-0000 / FAX: 03-0000-0001',
  'Mail: t.yamada@sample-shoji.example.co.jp',
  'Web: https://www.sample-shoji.example.co.jp/company/profile?ref=mailsig',
  '━━━━━━━━━━━━━━━━━━━━━━'
].join('\n');

const samples = [
  {
    name: '1. 標準的な問い合わせ（署名付き）',
    body: [
      'ご担当者様',
      '',
      'お世話になっております。株式会社サンプル商事の山田です。',
      '貴社製品「オフィスプランナーPro」の法人向けライセンスについてお問い合わせいたします。',
      '',
      '・利用人数: 50名程度',
      '・希望開始時期: 2026年9月1日',
      '・お見積もりを7月18日までにいただけますと幸いです。',
      '',
      'ご検討のほどよろしくお願いいたします。',
      '',
      SIGNATURE
    ].join('\n')
  },
  {
    name: '2. 返信チェーン付き（引用2通分）',
    body: [
      '田中様',
      '',
      'お世話になっております。先日お送りいただいたお見積もりの件、',
      '社内で検討した結果、オプションBの内容で進めたいと考えております。',
      '契約書のドラフトを7月25日までにお送りいただけますでしょうか。',
      '',
      'よろしくお願いいたします。',
      '',
      SIGNATURE,
      '',
      '2026年7月6日(月) 14:22 田中 花子 <h.tanaka@example-corp.example.jp>:',
      '> 山田様',
      '>',
      '> お世話になっております。例の件のお見積もりをお送りします。',
      '> オプションAは初期費用30万円、月額5万円です。',
      '> オプションBは初期費用50万円、月額3万円です。',
      '> ご不明点がございましたらお気軽にお問い合わせください。',
      '>',
      '> 2026年7月3日(金) 10:05 山田 太郎 <t.yamada@sample-shoji.example.co.jp>:',
      '>> 田中様',
      '>>',
      '>> お世話になっております。新サービスの導入を検討しており、',
      '>> お見積もりをお願いできますでしょうか。',
      '>> 予算は年間100万円程度を想定しています。',
      '>> よろしくお願いいたします。'
    ].join('\n')
  },
  {
    name: '3. URL・装飾の多い案内系問い合わせ',
    body: [
      '＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊',
      'セミナー参加に関するお問い合わせ',
      '＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊',
      '',
      'ご担当者様',
      '',
      '8月5日開催の「業務自動化セミナー」への参加を検討しています。',
      '申込ページ https://seminar.example.com/register?id=aut2026&utm_source=mail&utm_medium=email&utm_campaign=summer2026&token=abcdef123456 から',
      '申し込もうとしたところエラーが表示されました。',
      'エラー画面のスクリーンショットはこちらです:',
      'https://storage.example.com/uploads/screenshots/2026/07/08/error-capture-1234567890abcdef.png',
      '',
      '申込締切が2026-07-31とのことですので、それまでに対応方法をご教示ください。',
      '',
      '参考: 過去に同様の問い合わせをした際のページ',
      'https://support.example.com/hc/ja/articles/360000000000-申込エラーが発生した場合の対処方法?page=2&sort_by=created_at',
      '',
      '＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊',
      SIGNATURE
    ].join('\n')
  },
  {
    name: '4. 超長文（4000字超・引用チェーン含む）',
    body: [
      'ご担当者様',
      '',
      'お世話になっております。導入中のシステムについて詳細な問い合わせです。',
      // 長い本文（仕様の質問を繰り返して4000字超を再現）
      Array.from({ length: 48 }, (_, i) =>
        `質問${i + 1}: 帳票出力機能について、明細行が${i + 10}行を超えた場合の改ページ挙動と、` +
        'ヘッダー・フッターの繰り返し設定が仕様書のどこに記載されているか教えてください。'
      ).join('\n'),
      '',
      '回答は2026-08-10までにお願いできますと幸いです。',
      '',
      SIGNATURE,
      '',
      'On Mon, Jul 6, 2026 at 9:00 AM Support <support@vendor.example.com> wrote:',
      '> いつもご利用ありがとうございます。',
      '> 前回のお問い合わせへの回答は添付の通りです。',
      Array.from({ length: 20 }, () => '> （以前の回答本文が続く）').join('\n')
    ].join('\n')
  },
  {
    name: '5. 短い問い合わせ（圧縮対象が少ないケース）',
    body: [
      'お世話になります。',
      '請求書の再発行をお願いできますでしょうか。6月分です。',
      'よろしくお願いいたします。'
    ].join('\n')
  }
];

// ---- 計測 ----
let totalOld = 0;
let totalNew = 0;
const rows = [];

for (const s of samples) {
  const oldPrompt = oldPipeline(s.body);
  const newPrompt = newPipeline(s.body);
  const oldTok = estimateTokens(oldPrompt);
  const newTok = estimateTokens(newPrompt);
  totalOld += oldTok;
  totalNew += newTok;
  rows.push({
    name: s.name,
    rawChars: s.body.length,
    oldChars: oldPrompt.length,
    newChars: newPrompt.length,
    oldTok,
    newTok,
    saved: oldTok - newTok,
    pct: ((1 - newTok / oldTok) * 100).toFixed(1)
  });
}

console.log('| サンプル | 元本文(字) | 旧プロンプト(推定tok) | 新プロンプト(推定tok) | 削減(tok) | 削減率 |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  console.log(`| ${r.name} | ${r.rawChars} | ${r.oldTok} | ${r.newTok} | ${r.saved} | ${r.pct}% |`);
}
const totalPct = ((1 - totalNew / totalOld) * 100).toFixed(1);
console.log(`| **合計** | - | **${totalOld}** | **${totalNew}** | **${totalOld - totalNew}** | **${totalPct}%** |`);
