/**
 * cleanup.js
 * Sends delete requests to the background service worker.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

/**
 * Delete a list of URLs from browser history via the background worker.
 * @param {string[]} urls
 * @returns {Promise<{ ok: boolean, deleted: number }>}
 */
export function deleteItems(urls) {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(
      { type: "DELETE_ITEMS", urls },
      (response) => {
        if (api.runtime.lastError) {
          reject(api.runtime.lastError);
        } else {
          resolve(response || { ok: true, deleted: urls.length });
        }
      }
    );
  });
}
