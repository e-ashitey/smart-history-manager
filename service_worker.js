/**
 * service_worker.js
 * Background script — Smart History Manager
 *
 * Detection model layers (all contribute to a score):
 *   1. URL Intent Detection   — path-based signals (/watch, /cart, /adsmanager)
 *   2. Domain Variety         — many unrelated domains = personal browsing
 *   3. Rapid Navigation       — pages/min spike = non-work browsing
 *   4. Time Pattern           — during work hours ups the stakes
 *   5. User Override          — stored domain prefs (work/personal) adjust score
 *   6. Adaptive Memory        — repeated ignores auto-elevate a domain to "work"
 *
 * A suggestion is only surfaced when score >= CONFIDENCE_THRESHOLD.
 *
 * Messages handled:
 *   SEARCH_HISTORY    { query, days? }         → { results[] }
 *   GET_SUGGESTIONS   {}                        → { suggestions[] }
 *   IGNORE_SUGGESTION { id }                    → { ok }
 *   SET_DOMAIN_PREF   { domain, pref }          → { ok }
 *   GET_DOMAIN_PREFS  {}                        → { prefs }
 *   DELETE_ITEMS      { urls[] }                → { ok, deleted, errored }
 */

const api = typeof browser !== "undefined" ? browser : chrome;

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: URL Intent Rules
// Each rule provides a score signal. Positive = personal, Negative = work.
// A single path match can flip an otherwise borderline session.
// ─────────────────────────────────────────────────────────────────────────────

const URL_INTENT_RULES = [
  // ── Entertainment ──────────────────────────────────────────────────────────
  { match: "/watch",          score:  2, category: "entertainment", label: "Video" },
  { match: "/shorts",         score:  2, category: "entertainment", label: "Video" },
  { match: "/clip",           score:  1, category: "entertainment", label: "Video" },
  { match: "/video",          score:  1, category: "entertainment", label: "Video" },
  { match: "/stream",         score:  1, category: "entertainment", label: "Video" },
  { match: "/live",           score:  1, category: "entertainment", label: "Video" },
  // ── Social ─────────────────────────────────────────────────────────────────
  { match: "/reels",          score:  2, category: "social",        label: "Social" },
  { match: "/reel",           score:  2, category: "social",        label: "Social" },
  { match: "/story",          score:  1, category: "social",        label: "Social" },
  { match: "/post",           score:  1, category: "social",        label: "Social" },
  { match: "/feed",           score:  1, category: "social",        label: "Social" },
  { match: "/profile",        score:  1, category: "social",        label: "Social" },
  { match: "/explore",        score:  1, category: "social",        label: "Social" },
  { match: "/trending",       score:  1, category: "social",        label: "Social" },
  // ── Shopping ───────────────────────────────────────────────────────────────
  { match: "/cart",           score:  2, category: "shopping",      label: "Shopping" },
  { match: "/checkout",       score:  3, category: "shopping",      label: "Shopping" },
  { match: "/wishlist",       score:  1, category: "shopping",      label: "Shopping" },
  { match: "/product",        score:  1, category: "shopping",      label: "Shopping" },
  { match: "/item/",          score:  1, category: "shopping",      label: "Shopping" },
  { match: "/dp/",            score:  1, category: "shopping",      label: "Shopping" }, // Amazon
  { match: "/buy",            score:  2, category: "shopping",      label: "Shopping" },
  { match: "/order",          score:  1, category: "shopping",      label: "Shopping" },
  // ── Work signals (negative — suppress flagging) ────────────────────────────
  { match: "/adsmanager",     score: -5, category: "work",          label: "Ads Manager" },
  { match: "/business",       score: -4, category: "work",          label: "Business" },
  { match: "/analytics",      score: -4, category: "work",          label: "Analytics" },
  { match: "/dashboard",      score: -4, category: "work",          label: "Dashboard" },
  { match: "/admin",          score: -3, category: "work",          label: "Admin" },
  { match: "/studio",         score: -3, category: "work",          label: "Studio" },
  { match: "/manage",         score: -3, category: "work",          label: "Manage" },
  { match: "/creator",        score: -2, category: "work",          label: "Creator Tools" },
  { match: "/report",         score: -2, category: "work",          label: "Reports" },
  { match: "/docs",           score: -2, category: "work",          label: "Docs" },
  { match: "/api",            score: -2, category: "work",          label: "API" },
  { match: "/settings",       score: -1, category: "work",          label: "Settings" },
  { match: "/campaigns",      score: -3, category: "work",          label: "Campaigns" },
  { match: "/insights",       score: -2, category: "work",          label: "Insights" },
];

const CATEGORY_META = {
  entertainment: { label: "Video & Entertainment", icon: "🎬" },
  social:        { label: "Social Media",          icon: "📱" },
  shopping:      { label: "Online Shopping",        icon: "🛍" },
  work:          { label: "Work Activity",          icon: "💼" },
};

// Minimum score to surface a suggestion (avoids noise)
const CONFIDENCE_THRESHOLD = 4;

// After this many ignores, a domain is auto-treated as "work"
const AUTO_WORK_IGNORE_COUNT = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDomain(url) {
  try { return new URL(url).hostname; } catch (_) { return null; }
}

function getRootDomain(url) {
  const h = getDomain(url);
  if (!h) return null;
  const parts = h.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : h;
}

function getPath(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).toLowerCase();
  } catch (_) { return ""; }
}

function classifyUrl(url) {
  const path = getPath(url);
  for (const rule of URL_INTENT_RULES) {
    if (path.includes(rule.match)) return rule;
  }
  return null;
}

function getConfidence(score) {
  if (score >= 9) return "high";
  if (score >= 6) return "medium";
  return "low"; // still above threshold, just less certain
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2–5: Multi-signal Session Scorer
// ─────────────────────────────────────────────────────────────────────────────

function scoreSession(session, domainPrefs, ignoreCounts) {
  let urlIntentScore    = 0;
  let workSignalScore   = 0;
  const categoryHits    = new Map();  // category → { count, label, icon, urls }
  const domains         = new Set();

  for (const item of session) {
    const domain     = getDomain(item.url);
    const rootDomain = getRootDomain(item.url);

    if (domain) domains.add(domain);

    // ── User override: domain preference ────────────────────────────────────
    const pref = domainPrefs[domain] || domainPrefs[rootDomain];
    if (pref === "work") {
      workSignalScore += 3;
      continue; // Skip URL-intent check — user marked this domain as work
    }
    if (pref === "personal") {
      urlIntentScore += 1; // Boost personal signal
    }

    // ── Adaptive: auto-work if repeatedly ignored ────────────────────────────
    const ignoreCount = (ignoreCounts[rootDomain] || 0);
    if (ignoreCount >= AUTO_WORK_IGNORE_COUNT) {
      workSignalScore += 2;
      continue;
    }

    // ── URL Intent scoring ────────────────────────────────────────────────────
    const rule = classifyUrl(item.url);
    if (!rule) continue;

    if (rule.score < 0) {
      workSignalScore += Math.abs(rule.score);
    } else {
      urlIntentScore += rule.score;

      const meta = CATEGORY_META[rule.category] || { label: rule.category, icon: "🔗" };
      if (!categoryHits.has(rule.category)) {
        categoryHits.set(rule.category, {
          category: rule.category,
          label:    meta.label,
          icon:     meta.icon,
          count:    0,
          urls:     [],
        });
      }
      const entry = categoryHits.get(rule.category);
      entry.count++;
      entry.urls.push(item.url);
    }
  }

  // ── Layer 2: Domain variety ───────────────────────────────────────────────
  // Many unrelated domains = personal. Work tends to cluster on few domains.
  const domainVariety = Math.min(domains.size / 5, 2.0);

  // ── Layer 3: Rapid navigation ─────────────────────────────────────────────
  // High pages/min is a personal signal (clicking though feeds, videos)
  let rapidScore = 0;
  if (session.length >= 3) {
    const durationMin = (session[session.length - 1].lastVisitTime - session[0].lastVisitTime) / 60_000;
    if (durationMin > 0) {
      const ppm = session.length / durationMin;
      if (ppm > 3) rapidScore = 1;
      if (ppm > 8) rapidScore = 2;
    }
  }

  // ── Layer 4: Timing ───────────────────────────────────────────────────────
  // Personal browsing during business hours is more notable than at 11pm.
  const hour          = new Date(session[0].lastVisitTime).getHours();
  const day           = new Date(session[0].lastVisitTime).getDay();
  const isDuringWork  = day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  const timingScore   = isDuringWork ? 1 : 0;

  // ── Final score ───────────────────────────────────────────────────────────
  // Work signals subtract with a 0.6 weight so a single work path
  // doesn't fully cancel out a session, but multiple work signals do.
  const total = urlIntentScore + domainVariety + rapidScore + timingScore
              - (workSignalScore * 0.6);

  const categories = [...categoryHits.values()].sort((a, b) => b.count - a.count);

  return {
    score:         Math.max(0, total),
    categories,
    domains:       [...domains],
    breakdown: {
      urlIntent:    urlIntentScore,
      domainVariety,
      rapid:        rapidScore,
      timing:       timingScore,
      workSignals:  workSignalScore,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Detection: Clustering + Scoring
// ─────────────────────────────────────────────────────────────────────────────

function detectMixedSessions(items, domainPrefs, ignoreCounts) {
  if (!items || items.length === 0) return [];

  const SESSION_GAP_MS = 30 * 60 * 1000;

  const sorted = items
    .filter(i => i.lastVisitTime && i.url)
    .sort((a, b) => a.lastVisitTime - b.lastVisitTime);

  if (sorted.length === 0) return [];

  // Split history into time-contiguous sessions
  const sessions = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].lastVisitTime - sorted[i - 1].lastVisitTime > SESSION_GAP_MS) {
      sessions.push(current);
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  sessions.push(current);

  const suggestions = [];

  for (const session of sessions) {
    if (session.length < 5) continue;

    const scored = scoreSession(session, domainPrefs, ignoreCounts);

    // Only surface when confidence is meaningful
    if (scored.score < CONFIDENCE_THRESHOLD) continue;
    if (scored.categories.length === 0) continue;

    const sessionStart = session[0].lastVisitTime;
    const sessionEnd   = session[session.length - 1].lastVisitTime;

    suggestions.push({
      id:          `session_${sessionStart}`,
      sessionStart,
      sessionEnd,
      totalItems:  session.length,
      score:       scored.score,
      confidence:  getConfidence(scored.score),
      categories:  scored.categories,
      domains:     scored.domains,
      allUrls:     scored.categories.flatMap(c => c.urls),
      breakdown:   scored.breakdown,
    });
  }

  // Highest-score first (most confident), then most recent
  return suggestions
    .sort((a, b) => b.score - a.score || b.sessionStart - a.sessionStart)
    .slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── SEARCH_HISTORY ────────────────────────────────────────────────────────
  if (msg.type === "SEARCH_HISTORY") {
    const days = msg.days || 90;
    api.history.search(
      { text: msg.query, startTime: Date.now() - days * 24 * 60 * 60 * 1000, maxResults: 1000 },
      (results) => {
        if (api.runtime.lastError) {
          sendResponse({ error: api.runtime.lastError.message, results: [] });
        } else {
          sendResponse({ results: results || [] });
        }
      }
    );
    return true;
  }

  // ── GET_SUGGESTIONS ───────────────────────────────────────────────────────
  if (msg.type === "GET_SUGGESTIONS") {
    api.history.search(
      { text: "", startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, maxResults: 5000 },
      (items) => {
        api.storage.local.get(["ignoredSessions", "domainPrefs", "domainIgnoreCounts"], (data) => {
          const ignored      = new Set(data.ignoredSessions || []);
          const domainPrefs  = data.domainPrefs        || {};
          const ignoreCounts = data.domainIgnoreCounts || {};

          const all      = detectMixedSessions(items || [], domainPrefs, ignoreCounts);
          const filtered = all.filter(s => !ignored.has(s.id));
          sendResponse({ suggestions: filtered });
        });
      }
    );
    return true;
  }

  // ── IGNORE_SUGGESTION ─────────────────────────────────────────────────────
  // Permanently ignores the session AND increments domain ignore counters.
  if (msg.type === "IGNORE_SUGGESTION") {
    api.storage.local.get(["ignoredSessions", "domainIgnoreCounts"], (data) => {
      const ignored = data.ignoredSessions   || [];
      const counts  = data.domainIgnoreCounts || {};

      if (!ignored.includes(msg.id)) ignored.push(msg.id);

      // Increment ignore counter for each affected domain (adaptive learning)
      (msg.domains || []).forEach(domain => {
        const root = domain.split(".").slice(-2).join(".");
        counts[root] = (counts[root] || 0) + 1;
      });

      api.storage.local.set({ ignoredSessions: ignored, domainIgnoreCounts: counts }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ── GET_DOMAIN_PREFS ──────────────────────────────────────────────────────
  if (msg.type === "GET_DOMAIN_PREFS") {
    api.storage.local.get("domainPrefs", (data) => {
      sendResponse({ prefs: data.domainPrefs || {} });
    });
    return true;
  }

  // ── SET_DOMAIN_PREF ───────────────────────────────────────────────────────
  // pref: "work" | "personal" | null (null removes the override)
  if (msg.type === "SET_DOMAIN_PREF") {
    api.storage.local.get("domainPrefs", (data) => {
      const prefs = data.domainPrefs || {};
      if (msg.pref === null) {
        delete prefs[msg.domain];
      } else {
        prefs[msg.domain] = msg.pref;
      }
      api.storage.local.set({ domainPrefs: prefs }, () => {
        sendResponse({ ok: true, prefs });
      });
    });
    return true;
  }

  // ── DELETE_ITEMS ──────────────────────────────────────────────────────────
  if (msg.type === "DELETE_ITEMS") {
    const urls = msg.urls || [];
    if (urls.length === 0) {
      sendResponse({ ok: true, deleted: 0, errored: 0 });
      return true;
    }

    let completed = 0;
    let errored   = 0;

    for (const url of urls) {
      api.history.deleteUrl({ url }, () => {
        if (api.runtime.lastError) errored++;
        else completed++;
        if (completed + errored === urls.length) {
          sendResponse({ ok: errored === 0, deleted: completed, errored });
        }
      });
    }
    return true;
  }
});
