/**
 * grouping.js
 * Groups flat history results by domain (hostname).
 */

/**
 * Groups history items by their domain.
 * @param {chrome.history.HistoryItem[]} items
 * @returns {Array<{ domain: string, items: chrome.history.HistoryItem[], totalVisits: number }>}
 */
export function groupByDomain(items) {
  const map = new Map();

  for (const item of items) {
    let domain = "(unknown)";
    try {
      domain = new URL(item.url).hostname || "(unknown)";
    } catch (_) {
      // malformed URL
    }

    if (!map.has(domain)) {
      map.set(domain, { domain, items: [], totalVisits: 0 });
    }

    const group = map.get(domain);
    group.items.push(item);
    group.totalVisits += item.visitCount || 0;
  }

  // Sort groups by total visit count descending
  const groups = Array.from(map.values());
  groups.sort((a, b) => b.totalVisits - a.totalVisits);

  // Sort items within each group by last visit time descending
  for (const group of groups) {
    group.items.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
  }

  return groups;
}
