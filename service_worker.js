/**
 * service_worker.js
 * Background script — handles SEARCH_HISTORY and DELETE_ITEMS messages.
 * Cross-browser: works in both Chrome (chrome.*) and Firefox (browser.*).
 */

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SEARCH_HISTORY") {
    const days = msg.days || 90;
    api.history.search(
      {
        text: msg.query,
        startTime: Date.now() - days * 24 * 60 * 60 * 1000,
        maxResults: 1000,
      },
      (results) => {
        if (api.runtime.lastError) {
          sendResponse({ error: api.runtime.lastError.message, results: [] });
        } else {
          sendResponse({ results: results || [] });
        }
      }
    );
    // Return true to keep the message channel open for async sendResponse
    return true;
  }

  if (msg.type === "DELETE_ITEMS") {
    const urls = msg.urls || [];
    let completed = 0;
    let errored = 0;

    if (urls.length === 0) {
      sendResponse({ ok: true, deleted: 0 });
      return true;
    }

    for (const url of urls) {
      api.history.deleteUrl({ url }, () => {
        if (api.runtime.lastError) {
          errored++;
        } else {
          completed++;
        }
        if (completed + errored === urls.length) {
          sendResponse({ ok: errored === 0, deleted: completed, errored });
        }
      });
    }

    return true;
  }
});
