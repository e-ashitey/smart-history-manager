/**
 * history.js
 * Cross-browser wrappers around the history API.
 * Works in both Chrome (chrome.*) and Firefox (browser.*).
 */

const api = typeof browser !== "undefined" ? browser : chrome;

/**
 * Search browser history.
 * @param {string} query  - Keyword or URL fragment to search for.
 * @param {number} [days] - How many days back to search (default: 90).
 * @returns {Promise<chrome.history.HistoryItem[]>}
 */
export function searchHistory(query, days = 90) {
  return new Promise((resolve, reject) => {
    api.history.search(
      {
        text: query,
        startTime: Date.now() - days * 24 * 60 * 60 * 1000,
        maxResults: 1000,
      },
      (results) => {
        if (api.runtime.lastError) {
          reject(api.runtime.lastError);
        } else {
          resolve(results || []);
        }
      }
    );
  });
}

/**
 * Delete a single URL from history.
 * @param {string} url
 * @returns {Promise<void>}
 */
export function deleteUrl(url) {
  return new Promise((resolve, reject) => {
    api.history.deleteUrl({ url }, () => {
      if (api.runtime.lastError) {
        reject(api.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Delete multiple URLs from history.
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
export async function deleteItems(urls) {
  for (const url of urls) {
    await deleteUrl(url);
  }
}
