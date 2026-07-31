'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  model: $('model'),
  test: $('test'),
  testResult: $('testResult'),
  voiceEnabled: $('voiceEnabled'),
  voiceName: $('voiceName'),
  rate: $('rate'),
  rateVal: $('rateVal'),
  pitch: $('pitch'),
  pitchVal: $('pitchVal'),
  preview: $('preview'),
  save: $('save'),
  saved: $('saved'),
};

let config = null;

// ---- 音声一覧 ----
function populateVoices(selectedName) {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  els.voiceName.innerHTML = '<option value="">自動選択（日本語）</option>';
  voices
    .slice()
    .sort((a, b) => (a.lang || '').localeCompare(b.lang || ''))
    .forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name}（${v.lang}）`;
      if (v.name === selectedName) opt.selected = true;
      els.voiceName.appendChild(opt);
    });
}

// ---- 初期化 ----
(async function init() {
  config = await window.butler.getConfig();
  els.apiKey.value = config.apiKey || '';
  els.model.value = config.model || 'claude-sonnet-5';
  els.voiceEnabled.checked = !!config.voice.enabled;
  els.rate.value = config.voice.rate ?? 1.0;
  els.pitch.value = config.voice.pitch ?? 1.1;
  updateVals();

  populateVoices(config.voice.voiceName);
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => populateVoices(els.voiceName.value || config.voice.voiceName);
  }
})();

function updateVals() {
  els.rateVal.textContent = `×${Number(els.rate.value).toFixed(1)}`;
  els.pitchVal.textContent = Number(els.pitch.value).toFixed(1);
}
els.rate.addEventListener('input', updateVals);
els.pitch.addEventListener('input', updateVals);

// ---- キー表示切替 ----
els.toggleKey.addEventListener('click', () => {
  const showing = els.apiKey.type === 'text';
  els.apiKey.type = showing ? 'password' : 'text';
  els.toggleKey.textContent = showing ? '表示' : '隠す';
});

// ---- 接続テスト ----
els.test.addEventListener('click', async () => {
  els.testResult.textContent = 'テスト中…';
  els.testResult.className = 'test-result';
  const res = await window.butler.testApiKey(els.apiKey.value.trim(), els.model.value);
  if (res.ok) {
    els.testResult.textContent = '接続成功';
    els.testResult.className = 'test-result ok';
  } else {
    els.testResult.textContent = res.error || '接続に失敗しました';
    els.testResult.className = 'test-result ng';
  }
});

// ---- 試聴 ----
els.preview.addEventListener('click', () => {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance('お呼びでございますか、ご主人さま。執事のメリーでございます。');
  utt.lang = config.voice.lang || 'ja-JP';
  utt.rate = Number(els.rate.value);
  utt.pitch = Number(els.pitch.value);
  const name = els.voiceName.value;
  if (name) {
    const voice = window.speechSynthesis.getVoices().find((v) => v.name === name);
    if (voice) utt.voice = voice;
  }
  window.speechSynthesis.speak(utt);
});

// ---- 保存 ----
els.save.addEventListener('click', async () => {
  const partial = {
    apiKey: els.apiKey.value.trim(),
    model: els.model.value,
    voice: {
      enabled: els.voiceEnabled.checked,
      rate: Number(els.rate.value),
      pitch: Number(els.pitch.value),
      voiceName: els.voiceName.value,
    },
  };
  config = await window.butler.setConfig(partial);
  els.saved.hidden = false;
  setTimeout(() => { els.saved.hidden = true; }, 1800);
});
