/**
 * popup.js – Smart History Manager
 * Cross-browser (Chrome + Firefox).
 *
 * Uses the DOM API exclusively — NO innerHTML — to satisfy Firefox AMO
 * validation (unsafe assignment to innerHTML warning).
 *
 * All element construction goes through the lightweight el() helper, which
 * accepts a tag name, an attribute object, and spread children (Node|string|Array).
 */

import { groupByDomain } from "../grouping.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ── DOM refs ───────────────────────────────────────────────────────────────
const searchInput        = document.getElementById("search");
const btnSearch          = document.getElementById("btn-search");
const btnDeleteSel       = document.getElementById("btn-delete-selected");
const btnClear           = document.getElementById("btn-clear");
const btnClearSearch     = document.getElementById("btn-clear-search");
const toolbar            = document.getElementById("toolbar");
const resultSummary      = document.getElementById("result-summary");
const resultsEl          = document.getElementById("results");
const toast              = document.getElementById("toast");
const suggestionsSection = document.getElementById("suggestions-section");
const suggestionsList    = document.getElementById("suggestions-list");
const suggestionsCount   = document.getElementById("suggestions-count");

// ── State ──────────────────────────────────────────────────────────────────
let allGroups   = [];
let lastQuery   = "";
let domainPrefs = {};

// ── Safe DOM builder (replaces all innerHTML usage) ────────────────────────
/**
 * Creates a DOM element without innerHTML.
 * @param {string} tag
 * @param {{ class?:string, text?:string, [attr:string]: any }|null} attrs
 * @param {...(Node|string|Array|null)} children
 */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class")                        node.className = v;
      else if (k === "text")                    node.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else                                      node.setAttribute(k, v);
    }
  }
  (function mount(kids) {
    for (const child of kids) {
      if (child == null) continue;
      if (Array.isArray(child)) { mount(child); continue; }
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  })(children);
  return node;
}

// ── Utilities ──────────────────────────────────────────────────────────────
function showToast(msg, type = "") {
  toast.textContent = msg;
  toast.className   = "show" + (type ? " " + type : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.className = ""; }, 2800);
}

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatSessionTime(startMs, endMs) {
  const start = new Date(startMs);
  const end   = new Date(endMs);
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest  = new Date(+today - 86_400_000);
  const sDay  = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  let dayLabel;
  if (+sDay === +today)     dayLabel = "Today";
  else if (+sDay === +yest) dayLabel = "Yesterday";
  else dayLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const tf = { hour: "numeric", minute: "2-digit" };
  return `${dayLabel} ${start.toLocaleTimeString(undefined, tf)} – ${end.toLocaleTimeString(undefined, tf)}`;
}

function getRootDomain(domain) {
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

function capitalize(str) {
  return str ? str[0].toUpperCase() + str.slice(1) : "";
}

function getCheckedUrls() {
  return [...document.querySelectorAll(".item-check:checked")].map(cb => cb.dataset.url);
}

function updateDeleteBtn() {
  const count = getCheckedUrls().length;
  btnDeleteSel.disabled    = count === 0;
  btnDeleteSel.textContent = count > 0 ? `Delete selected (${count})` : "Delete selected";
}

// ── Message helpers ────────────────────────────────────────────────────────
function sendMsg(payload) {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(payload, (res) => {
      if (api.runtime.lastError) reject(api.runtime.lastError);
      else resolve(res);
    });
  });
}

// ── Domain pref helpers ────────────────────────────────────────────────────
async function setDomainPref(domain, pref) {
  const root = getRootDomain(domain);
  const res  = await sendMsg({ type: "SET_DOMAIN_PREF", domain: root, pref });
  if (res?.prefs) domainPrefs = res.prefs;
}

function getDomainPref(domain) {
  return domainPrefs[getRootDomain(domain)] || null;
}

// ── Reusable element factories ─────────────────────────────────────────────
function makeFavicon(domain) {
  const img = el("img", { class: "domain-favicon", alt: "" });
  img.src = `https://www.google.com/s2/favicons?sz=16&domain=${domain}`;
  img.addEventListener("error", () => { img.style.display = "none"; });
  return img;
}

function makeStateBox(icon, title, desc) {
  const box = el("div", { class: "state-box" },
    el("span", { class: "state-icon",  text: icon }),
    el("p",    { class: "state-title", text: title })
  );
  if (desc) {
    const p = el("p", { class: "state-desc" });
    if (typeof desc === "string") {
      p.textContent = desc;
    } else if (Array.isArray(desc)) {
      desc.forEach(n => p.appendChild(n instanceof Node ? n : document.createTextNode(String(n))));
    } else {
      p.appendChild(desc);
    }
    box.appendChild(p);
  }
  return box;
}

/** Creates a Work / Personal tag button. */
function makePrefTagBtn(pref, domain, activePref) {
  return el("button", {
    class: `btn-tag btn-tag-${pref}${activePref === pref ? " active" : ""}`,
    "data-pref":   pref,
    "data-domain": domain,
    text: pref === "work" ? "🏢 Work" : "👤 Personal",
  });
}

// ── Result summary (uses DOM nodes, not innerHTML) ─────────────────────────
function setResultSummary(items, groups) {
  resultSummary.replaceChildren(
    el("strong", { text: String(items) }),
    ` result${items !== 1 ? "s" : ""} across `,
    el("strong", { text: String(groups) }),
    ` domain${groups !== 1 ? "s" : ""}`,
  );
}

function setReviewSummary(count) {
  resultSummary.replaceChildren(
    "Reviewing ",
    el("strong", { text: String(count) }),
    ` page${count !== 1 ? "s" : ""} from this session`,
  );
}

// ── Render helpers ─────────────────────────────────────────────────────────
function renderLoading() {
  resultsEl.replaceChildren(
    el("div", { class: "state-box" },
      el("div", { class: "spinner" }),
      el("p",   { class: "state-title", text: "Searching history…" })
    )
  );
}

function renderEmpty(query) {
  const descP = el("p", { class: "state-desc" });
  descP.append("No history entries matched ", el("strong", { text: `"${query}"` }), ".");
  resultsEl.replaceChildren(
    el("div", { class: "state-box" },
      el("span", { class: "state-icon",  text: "🔎" }),
      el("p",    { class: "state-title", text: "No results" }),
      descP
    )
  );
}

function renderError(msg) {
  resultsEl.replaceChildren(makeStateBox("⚠️", "Something went wrong", msg));
}

// ── History item row ───────────────────────────────────────────────────────
function makeHistoryItem(item) {
  const cb   = el("input", { type: "checkbox", class: "item-check", "data-url": item.url });
  const link = el("a", { class: "item-url", href: item.url, target: "_blank", text: item.url });
  link.title = item.url;

  const info = el("div", { class: "item-info" },
    el("p", { class: "item-title", text: item.title || "(No title)" }),
    link,
    el("p", { class: "item-meta",
      text: `${formatDate(item.lastVisitTime)} · ${item.visitCount || 0} visit${item.visitCount !== 1 ? "s" : ""}` })
  );
  const li = el("li", { class: "history-item", "data-url": item.url }, cb, info);

  cb.addEventListener("change", () => {
    li.classList.toggle("selected", cb.checked);
    updateDeleteBtn();
  });
  return li;
}

// ── Domain card (search results) ───────────────────────────────────────────
function makeDomainCard(group) {
  const pref = getDomainPref(group.domain);
  const root = getRootDomain(group.domain);
  const card = el("div", { class: "domain-card", "data-domain": group.domain });

  // ── Header ─────────────────────────
  const prefBadge = pref
    ? el("span", { class: `domain-pref-badge ${pref}`, text: pref === "work" ? "🏢 Work" : "👤 Personal" })
    : null;

  const header = el("div", { class: "domain-header" },
    makeFavicon(group.domain),
    el("span", { class: "domain-name", text: group.domain }),
    prefBadge,
    el("span", { class: "domain-meta",
      text: `${group.items.length} page${group.items.length !== 1 ? "s" : ""} · ${group.totalVisits} visit${group.totalVisits !== 1 ? "s" : ""}` }),
    el("span", { class: "domain-chevron", text: "▾" })
  );

  // ── Body ─────────────────────────────
  const selectAllCb    = el("input", { type: "checkbox", class: "select-all-check", "data-domain": group.domain });
  const selectAllLabel = el("label", { class: "select-all-label" }, selectAllCb, " Select all");
  const workBtn        = makePrefTagBtn("work",     root, pref);
  const personalBtn    = makePrefTagBtn("personal", root, pref);
  const deleteGrpBtn   = el("button", { class: "btn btn-danger btn-sm", text: "Delete all" });

  const actionsRow = el("div", { class: "domain-actions" },
    selectAllLabel, workBtn, personalBtn, deleteGrpBtn
  );

  const itemList = el("ul", { class: "item-list" });
  group.items.forEach(item => itemList.appendChild(makeHistoryItem(item)));

  const body = el("div", { class: "domain-body" }, actionsRow, itemList);
  card.append(header, body);

  // ── Events ──────────────────────────
  header.addEventListener("click", (e) => {
    if (e.target.closest(".btn-tag, .domain-pref-badge")) return;
    card.classList.toggle("collapsed");
    body.style.display = card.classList.contains("collapsed") ? "none" : "";
  });

  selectAllCb.addEventListener("change", () => {
    card.querySelectorAll(".item-check").forEach(cb => { cb.checked = selectAllCb.checked; });
    card.querySelectorAll(".history-item").forEach(row => row.classList.toggle("selected", selectAllCb.checked));
    updateDeleteBtn();
  });

  [workBtn, personalBtn].forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const newPref = btn.classList.contains("active") ? null : btn.dataset.pref;
      btn.disabled  = true;
      try {
        await setDomainPref(root, newPref);
        showToast(newPref ? `✓ ${root} marked as ${newPref}` : `✓ ${root} preference cleared`, "success");
        renderGroups(allGroups);
      } catch (_) { btn.disabled = false; }
    });
  });

  deleteGrpBtn.addEventListener("click", () => doDelete(group.items.map(i => i.url)));
  return card;
}

function renderGroups(groups) {
  resultsEl.replaceChildren(...groups.map(g => makeDomainCard(g)));
}

// ── Suggestion card ─────────────────────────────────────────────────────────
function makeSuggestionCard(s) {
  const maxCount = Math.max(...s.categories.map(c => c.count), 1);
  const card     = el("div", { class: "suggestion-card", "data-id": s.id });

  // Warning bar
  card.appendChild(
    el("div", { class: "suggestion-warning-bar" },
      el("span", { class: "suggestion-warning-icon", text: "⚡" }),
      el("div",  { class: "suggestion-warning-text" },
        el("p", { class: "suggestion-warning-title", text: "Mixed browsing session detected." }),
        el("p", { class: "suggestion-warning-sub",   text: "Some activity may be personal. Would you like to review?" })
      )
    )
  );

  // Meta bar
  const timeLabel = `${formatSessionTime(s.sessionStart, s.sessionEnd)} · ${s.totalItems} pages`;
  card.appendChild(
    el("div", { class: "suggestion-meta-bar" },
      el("span", { class: "suggestion-time",                         text: timeLabel }),
      el("span", { class: `confidence-badge ${s.confidence}`,        text: `${capitalize(s.confidence)} confidence` })
    )
  );

  // Body
  const body = el("div", { class: "suggestion-body" });
  body.appendChild(el("p", { class: "suggestion-group-label", text: "Activity Breakdown" }));

  // Category rows
  const catList = el("ul", { class: "suggestion-categories" });
  for (const cat of s.categories) {
    const pct = Math.round(cat.count / maxCount * 100);
    catList.appendChild(
      el("li", { class: "suggestion-category-row" },
        el("span", { class: "suggestion-category-icon",  text: cat.icon }),
        el("span", { class: "suggestion-category-name",  text: cat.label }),
        el("span", { class: "suggestion-category-count", text: `${cat.count} page${cat.count !== 1 ? "s" : ""}` })
      )
    );
    catList.appendChild(
      el("div", { class: "suggestion-bar-wrap" },
        el("div", { class: "suggestion-bar-fill", style: { width: `${pct}%` } })
      )
    );
  }
  body.appendChild(catList);

  // Domain overrides
  const topDomains = (s.domains || []).slice(0, 5);
  if (topDomains.length > 0) {
    const overrideWrap = el("div", { class: "domain-overrides" },
      el("p", { class: "domain-override-label", text: "Mark domains as" })
    );
    for (const domain of topDomains) {
      const root = getRootDomain(domain);
      const pref = domainPrefs[root] || null;
      overrideWrap.appendChild(
        el("div", { class: "domain-override-row", "data-domain": root },
          el("span", { class: "domain-override-name", text: domain }),
          makePrefTagBtn("work",     root, pref),
          makePrefTagBtn("personal", root, pref)
        )
      );
    }
    body.appendChild(overrideWrap);
  }

  // Actions
  const reviewBtn = el("button", { class: "btn btn-review btn-sm", "data-id": s.id, text: "Review" });
  const ignoreBtn = el("button", { class: "btn btn-ignore btn-sm", "data-id": s.id, text: "Ignore" });
  body.appendChild(el("div", { class: "suggestion-actions" }, reviewBtn, ignoreBtn));
  card.appendChild(body);

  return { card, reviewBtn, ignoreBtn };
}

// ── Suggestions rendering ───────────────────────────────────────────────────
function renderSuggestions(suggestions) {
  suggestionsList.replaceChildren();

  for (const s of suggestions) {
    const { card, reviewBtn, ignoreBtn } = makeSuggestionCard(s);
    suggestionsList.appendChild(card);

    // Domain override buttons
    card.querySelectorAll(".btn-tag").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const domain  = btn.dataset.domain;
        const row     = btn.closest(".domain-override-row");
        const newPref = btn.classList.contains("active") ? null : btn.dataset.pref;
        btn.disabled  = true;
        try {
          await setDomainPref(domain, newPref);
          row.querySelectorAll(".btn-tag").forEach(b => b.classList.remove("active"));
          if (newPref) btn.classList.add("active");
          showToast(newPref ? `✓ ${domain} marked as ${newPref}` : `✓ ${domain} preference cleared`, "success");
          await loadSuggestions();
        } catch (_) { btn.disabled = false; }
      });
    });

    // Review
    reviewBtn.addEventListener("click", async () => {
      renderLoading();
      toolbar.classList.remove("visible");
      suggestionsSection.hidden = true;
      try {
        const [histRes, sugRes] = await Promise.all([
          sendMsg({ type: "SEARCH_HISTORY", query: "", days: 7 }),
          sendMsg({ type: "GET_SUGGESTIONS" }),
        ]);
        const match    = (sugRes?.suggestions || []).find(x => x.id === s.id);
        const urlSet   = new Set(match?.allUrls || []);
        const filtered = urlSet.size > 0
          ? (histRes?.results || []).filter(r => urlSet.has(r.url))
          : (histRes?.results || []);
        allGroups = groupByDomain(filtered);
        if (allGroups.length === 0) {
          renderEmpty("this session");
        } else {
          renderGroups(allGroups);
          setReviewSummary(filtered.length);
          toolbar.classList.add("visible");
          updateDeleteBtn();
        }
      } catch (err) { renderError(err?.message || String(err)); }
    });

    // Ignore
    ignoreBtn.addEventListener("click", async () => {
      const domains = [...card.querySelectorAll(".domain-override-row")]
        .map(r => r.dataset.domain).filter(Boolean);
      ignoreBtn.disabled = true;
      try {
        await sendMsg({ type: "IGNORE_SUGGESTION", id: s.id, domains });
        card.style.transition = "opacity .3s, transform .3s";
        card.style.opacity    = "0";
        card.style.transform  = "translateY(-6px)";
        setTimeout(() => {
          card.remove();
          if (suggestionsList.children.length === 0) {
            suggestionsSection.hidden = true;
          } else {
            suggestionsCount.textContent = suggestionsList.children.length;
          }
        }, 300);
      } catch (_) { ignoreBtn.disabled = false; }
    });
  }
}

// ── Suggestions loader ──────────────────────────────────────────────────────
async function loadSuggestions() {
  try {
    const [prefsRes, sugRes] = await Promise.all([
      sendMsg({ type: "GET_DOMAIN_PREFS" }),
      sendMsg({ type: "GET_SUGGESTIONS" }),
    ]);
    domainPrefs = prefsRes?.prefs || {};
    const suggestions = sugRes?.suggestions || [];
    if (suggestions.length === 0) {
      suggestionsSection.hidden = true;
      return;
    }
    suggestionsSection.hidden = false;
    suggestionsCount.textContent = suggestions.length;
    renderSuggestions(suggestions);
  } catch (_) {
    suggestionsSection.hidden = true;
  }
}

// ── Search ──────────────────────────────────────────────────────────────────
async function runSearch() {
  const query = searchInput.value.trim();
  lastQuery   = query;

  suggestionsSection.hidden = true;
  renderLoading();
  toolbar.classList.remove("visible");
  btnSearch.disabled = true;

  try {
    const { results = [] } = await sendMsg({ type: "SEARCH_HISTORY", query });
    allGroups = groupByDomain(results);
    if (results.length === 0) {
      renderEmpty(query);
    } else {
      renderGroups(allGroups);
      setResultSummary(results.length, allGroups.length);
      toolbar.classList.add("visible");
      updateDeleteBtn();
    }
  } catch (err) {
    renderError(err?.message || String(err));
  } finally {
    btnSearch.disabled = false;
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────
async function doDelete(urls) {
  if (urls.length === 0) return;
  if (!confirm(`Delete ${urls.length} history item${urls.length !== 1 ? "s" : ""}?`)) return;

  btnDeleteSel.disabled    = true;
  btnDeleteSel.textContent = "Deleting…";
  try {
    const res = await sendMsg({ type: "DELETE_ITEMS", urls });
    showToast(`✓ Deleted ${res?.deleted ?? urls.length} item${urls.length !== 1 ? "s" : ""}`, "success");
    if (lastQuery !== null) await runSearch();
    await loadSuggestions();
  } catch (err) {
    showToast("⚠ Delete failed: " + (err?.message || String(err)), "error");
  } finally {
    updateDeleteBtn();
  }
}

// ── Reset to home ────────────────────────────────────────────────────────────
function resetToHome() {
  allGroups = [];
  lastQuery = "";
  toolbar.classList.remove("visible");
  resultsEl.replaceChildren(
    makeStateBox(
      "🕐",
      "Search your history",
      "Enter a keyword or paste a URL above to find and clean up matching history entries."
    )
  );
  if (suggestionsList.children.length > 0) suggestionsSection.hidden = false;
  searchInput.focus();
}

// ── Event listeners ──────────────────────────────────────────────────────────
btnSearch.addEventListener("click", runSearch);

searchInput.addEventListener("keydown",  (e) => { if (e.key === "Enter") runSearch(); });
searchInput.addEventListener("input",    ()  => { btnClearSearch.hidden = searchInput.value.length === 0; });
btnClearSearch.addEventListener("click", ()  => { searchInput.value = ""; btnClearSearch.hidden = true; resetToHome(); });
btnClear.addEventListener("click",       ()  => { searchInput.value = ""; btnClearSearch.hidden = true; resetToHome(); });
btnDeleteSel.addEventListener("click",   ()  => doDelete(getCheckedUrls()));

// ── Init ──────────────────────────────────────────────────────────────────────
searchInput.focus();
loadSuggestions();
