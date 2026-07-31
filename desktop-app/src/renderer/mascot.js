'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const textEl = $('text');
const sendBtn = $('send');
const micBtn = $('mic');
const bubbleEl = $('bubble');
const mouthEl = $('mouth');
const eyesEl = $('eyes');
const listeningEl = $('listening');

let config = null;
let busy = false;
let currentBubble = null; // 応答中の吹き出しDOM

// ---- 起動時 ----
(async function init() {
  config = await window.butler.getConfig();
  window.butler.onConfigChanged((cfg) => { config = cfg; });

  const apiKey = await hasApiKey();
  if (!apiKey) {
    addMessage('butler', 'はじめまして、ご主人さま。執事のメリーでございます。まずは設定画面にてAPIキーをご登録くださいませ。歯車…ではなく、私を右クリックして「設定」をお選びください。');
  } else {
    addMessage('butler', 'お呼びでございますか、ご主人さま。ご用件をお申し付けください。');
  }
  startBlinking();
})();

async function hasApiKey() {
  const cfg = await window.butler.getConfig();
  return Boolean(cfg && cfg.apiKey);
}

// ---- メッセージ表示 ----
function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function showBubble() {
  bubbleEl.classList.remove('hidden');
}

// ---- 送信処理 ----
async function submit() {
  const text = textEl.value.trim();
  if (!text || busy) return;
  textEl.value = '';
  addMessage('user', text);
  showBubble();
  await ask(text);
}

async function ask(text) {
  busy = true;
  sendBtn.disabled = true;

  // 応答用の吹き出しを用意（タイピング表示）。
  currentBubble = addMessage('butler', '');
  const dots = document.createElement('span');
  dots.className = 'dots';
  currentBubble.appendChild(dots);

  let acc = '';
  const removeDelta = window.butler.onChatDelta((delta) => {
    acc += delta;
    currentBubble.textContent = acc;
    logEl.scrollTop = logEl.scrollHeight;
  });

  try {
    const reply = await window.butler.sendMessage(text);
    removeDelta();

    if (reply === '__NO_API_KEY__') {
      currentBubble.className = 'msg error';
      currentBubble.textContent = 'APIキーが未設定でございます。設定画面よりご登録くださいませ。';
      return;
    }
    if (typeof reply === 'string' && reply.startsWith('__ERROR__')) {
      currentBubble.className = 'msg error';
      currentBubble.textContent = '申し訳ございません。' + reply.replace('__ERROR__', '');
      return;
    }

    const finalText = acc || reply || '';
    currentBubble.textContent = finalText;
    speak(finalText);
  } catch (e) {
    removeDelta();
    currentBubble.className = 'msg error';
    currentBubble.textContent = '申し訳ございません。応答に失敗いたしました。';
  } finally {
    busy = false;
    sendBtn.disabled = false;
    currentBubble = null;
    logEl.scrollTop = logEl.scrollHeight;
  }
}

// メインプロセスからの応答開始通知。
window.butler.onChatStart(() => {});

// ---- 音声合成（TTS） ----
let voicesCache = [];
function loadVoices() { voicesCache = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(lang, name) {
  if (!voicesCache.length) loadVoices();
  if (name) {
    const byName = voicesCache.find((v) => v.name === name);
    if (byName) return byName;
  }
  const byLang = voicesCache.find((v) => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith((lang || 'ja').toLowerCase().slice(0, 2)));
  return byLang || voicesCache[0] || null;
}

function speak(text) {
  const v = config && config.voice;
  if (!v || !v.enabled || !window.speechSynthesis || !text) return;
  try {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = v.lang || 'ja-JP';
    utt.rate = v.rate || 1.0;
    utt.pitch = v.pitch || 1.0;
    const voice = pickVoice(utt.lang, v.voiceName);
    if (voice) utt.voice = voice;
    utt.onstart = () => setTalking(true);
    utt.onend = () => setTalking(false);
    utt.onerror = () => setTalking(false);
    window.speechSynthesis.speak(utt);
  } catch (_e) { /* 音声非対応環境では無視 */ }
}

// ---- 口・目のアニメーション ----
function setTalking(on) {
  if (on) mouthEl.classList.add('talking');
  else mouthEl.classList.remove('talking');
}

function startBlinking() {
  const blink = () => {
    eyesEl.classList.add('blink');
    setTimeout(() => eyesEl.classList.remove('blink'), 130);
    setTimeout(blink, 2500 + Math.random() * 3000);
  };
  setTimeout(blink, 2000);
}

// ---- 音声入力（STT） ----
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;

function setupRecognition() {
  if (!SR) return null;
  const r = new SR();
  r.lang = (config && config.voice && config.voice.lang) || 'ja-JP';
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.continuous = false;
  r.onresult = (ev) => {
    const said = ev.results[0][0].transcript;
    textEl.value = said;
    stopRecording();
    if (said.trim()) submit();
  };
  r.onerror = (ev) => {
    stopRecording();
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      addMessage('error', 'マイクの使用が許可されませんでした。OSの権限設定をご確認ください。');
    } else if (ev.error === 'network') {
      addMessage('error', '音声認識サービスに接続できませんでした。チャット入力をご利用ください。');
    } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
      addMessage('error', '音声を聞き取れませんでした。もう一度お試しください。');
    }
  };
  r.onend = () => stopRecording();
  return r;
}

function startRecording() {
  if (recording || busy) return;
  if (!SR) {
    addMessage('error', 'この環境では音声入力に対応しておりません。チャットでお申し付けください。');
    return;
  }
  recognition = setupRecognition();
  if (!recognition) return;
  try {
    recognition.start();
    recording = true;
    micBtn.classList.add('recording');
    listeningEl.hidden = false;
    showBubble();
  } catch (_e) { stopRecording(); }
}

function stopRecording() {
  recording = false;
  micBtn.classList.remove('recording');
  listeningEl.hidden = true;
  if (recognition) {
    try { recognition.stop(); } catch (_e) { /* noop */ }
  }
}

// ---- イベント ----
sendBtn.addEventListener('click', submit);
textEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
});
micBtn.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

// マスコットを右クリック → メニュー。
document.getElementById('mascot').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.butler.showContextMenu();
});
// マスコットをダブルクリック → 入力にフォーカス。
document.getElementById('mascot').addEventListener('dblclick', () => {
  showBubble();
  textEl.focus();
});
