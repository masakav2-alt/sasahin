'use strict';

/**
 * 統合テスト用の Google Apps Script グローバルのモック群。
 */

function createPropertiesMock(initial = {}) {
  const store = Object.assign({}, initial);
  const service = {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); return service; },
    deleteProperty: (k) => { delete store[k]; return service; },
    _store: store
  };
  return service;
}

function createLockMock({ acquirable = true } = {}) {
  const calls = { tryLock: 0, releaseLock: 0 };
  return {
    calls,
    lock: {
      tryLock: () => { calls.tryLock++; return acquirable; },
      releaseLock: () => { calls.releaseLock++; }
    }
  };
}

/** 1通のメッセージモック */
function makeMessage({ id, subject, from, date, plainBody, htmlBody = '' }) {
  return {
    getId: () => id,
    getSubject: () => subject,
    getFrom: () => from,
    getDate: () => date,
    getPlainBody: () => plainBody,
    getBody: () => htmlBody
  };
}

/** 1スレッドモック (操作の記録付き) */
function makeThread(messages) {
  const state = { read: false, labels: [] };
  return {
    state,
    getMessages: () => messages,
    markRead: () => { state.read = true; },
    addLabel: (label) => { state.labels.push(label); }
  };
}

function createGmailMock(threads = []) {
  const sentEmails = [];
  const labels = {};
  return {
    sentEmails,
    labels,
    GmailApp: {
      search: () => threads,
      getUserLabelByName: (name) => labels[name] || null,
      createLabel: (name) => { labels[name] = { name }; return labels[name]; },
      sendEmail: (to, subject, body) => { sentEmails.push({ to, subject, body }); }
    }
  };
}

/**
 * UrlFetchApp モック。リクエストを順番に処理するハンドラを受け取る。
 * handler(url, options, callIndex) -> { status, body }
 */
function createUrlFetchMock(handler) {
  const requests = [];
  return {
    requests,
    UrlFetchApp: {
      fetch: (url, options) => {
        const idx = requests.length;
        requests.push({ url, options });
        const res = handler(url, options, idx) || { status: 200, body: '{}' };
        return {
          getResponseCode: () => res.status,
          getContentText: () => res.body
        };
      }
    }
  };
}

function createSessionMock(activeEmail = '', effectiveEmail = '') {
  return {
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getEffectiveUser: () => ({ getEmail: () => effectiveEmail })
    }
  };
}

const geminiResponse = (text) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

module.exports = {
  createPropertiesMock,
  createLockMock,
  makeMessage,
  makeThread,
  createGmailMock,
  createUrlFetchMock,
  createSessionMock,
  geminiResponse
};
