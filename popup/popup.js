/**
 * popup.js – Smart History Manager
 * Cross-browser: works in Chrome and Firefox.
 *
 * Flow:
 *  1. User types a keyword/URL and clicks Search
 *  2. Send SEARCH_HISTORY to background → receive flat results array
 *  3. Group results by domain via groupByDomain()
 *  4. Render collapsible domain cards with checkboxes
 *  5. User selects items → Delete selected / Delete all in group
 *  6. Send DELETE_ITEMS to background → refresh view
 */

import { groupByDomain } from "../grouping.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ── DOM refs ──────────────────────────────────────────────────────────────
const searchInput     = document.getElementById("search");
const btnSearch       = document.getElementById("btn-search");
const btnDeleteSel    = document.getElementById("btn-delete-selected");
const btnClear        = document.getElementById("btn-clear");
const toolbar         = document.getElementById("toolbar");
const resultSummary   = document.getElementById("result-summary");
const resultsEl       = document.getElementById("results");
const toast           = document.getElementById("toast");

// ── State ─────────────────────────────────────────────────────────────────
let allGroups = [];   // current grouped results

// ── Utils ─────────────────────────────────────────────────────────────────

function showToast(msg, type = "") {
  toast.textContent = msg;
  toast.className = "show" + (type ? " " + type : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.className = ""; }, 2800);
}

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function getFaviconUrl(domain) {
  return `https://www.google.com/s2/favicons?sz=16&domain=${domain}`;
}

function getCheckedUrls() {
  return [...document.querySelectorAll(".item-check:checked")].map(cb => cb.dataset.url);
}

function updateDeleteBtn() {
  const count = getCheckedUrls().length;
  btnDeleteSel.disabled = count === 0;
  btnDeleteSel.textContent = count > 0 ? `Delete selected (${count})` : "Delete selected";
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderEmpty(query) {
  resultsEl.innerHTML = `
    <div class="state-box">
      <span class="state-icon">🔎</span>
      <p class="state-title">No results</p>
      <p class="state-desc">No history entries matched <strong>"${escHtml(query)}"</strong>. Try a different keyword or URL.</p>
    </div>`;
}

function renderLoading() {
  resultsEl.innerHTML = `
    <div class="state-box">
      <div class="spinner"></div>
      <p class="state-title">Searching history…</p>
    </div>`;
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function renderGroups(groups) {
  if (groups.length === 0) return;

  resultsEl.innerHTML = "";

  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "domain-card";
    card.dataset.domain = group.domain;

    const totalItems = group.items.length;
    const totalVisits = group.totalVisits;

    card.innerHTML = `
      <div class="domain-header">
        <img class="domain-favicon" src="${getFaviconUrl(group.domain)}" alt="" onerror="this.style.display='none'" />
        <span class="domain-name">${escHtml(group.domain)}</span>
        <span class="domain-meta">${totalItems} page${totalItems !== 1 ? "s" : ""} · ${totalVisits} visit${totalVisits !== 1 ? "s" : ""}</span>
        <span class="domain-chevron">▾</span>
      </div>
      <div class="domain-body">
        <div class="domain-actions">
          <label class="select-all-label">
            <input type="checkbox" class="select-all-check" data-domain="${escHtml(group.domain)}" />
            Select all
          </label>
          <button class="btn btn-danger btn-sm delete-group-btn" data-domain="${escHtml(group.domain)}">
            Delete all in group
          </button>
        </div>
        <ul class="item-list">
          ${group.items.map(item => `
            <li class="history-item" data-url="${escHtml(item.url)}">
              <input type="checkbox" class="item-check" data-url="${escHtml(item.url)}" />
              <div class="item-info">
                <p class="item-title">${escHtml(item.title || "(No title)")}</p>
                <a class="item-url" href="${escHtml(item.url)}" target="_blank" title="${escHtml(item.url)}">${escHtml(item.url)}</a>
                <p class="item-meta">${formatDate(item.lastVisitTime)} · ${item.visitCount || 0} visit${item.visitCount !== 1 ? "s" : ""}</p>
              </div>
            </li>
          `).join("")}
        </ul>
      </div>`;

    resultsEl.appendChild(card);
  }

  // ── Collapse toggle ──
  resultsEl.querySelectorAll(".domain-header").forEach(header => {
    header.addEventListener("click", () => {
      header.closest(".domain-card").classList.toggle("collapsed");
      const body = header.nextElementSibling;
      body.style.display = header.closest(".domain-card").classList.contains("collapsed") ? "none" : "";
    });
  });

  // ── Select-all per group ──
  resultsEl.querySelectorAll(".select-all-check").forEach(check => {
    check.addEventListener("change", () => {
      const domain = check.dataset.domain;
      const card = resultsEl.querySelector(`.domain-card[data-domain="${domain}"]`);
      card.querySelectorAll(".item-check").forEach(cb => { cb.checked = check.checked; });
      // highlight rows
      card.querySelectorAll(".history-item").forEach(row => {
        row.classList.toggle("selected", check.checked);
      });
      updateDeleteBtn();
    });
  });

  // ── Individual checkboxes ──
  resultsEl.querySelectorAll(".item-check").forEach(cb => {
    cb.addEventListener("change", () => {
      cb.closest(".history-item").classList.toggle("selected", cb.checked);
      updateDeleteBtn();
    });
  });

  // ── Delete all in group ──
  resultsEl.querySelectorAll(".delete-group-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const domain = btn.dataset.domain;
      const group = allGroups.find(g => g.domain === domain);
      if (!group) return;
      const urls = group.items.map(i => i.url);
      await doDelete(urls);
    });
  });
}

// ── Search ────────────────────────────────────────────────────────────────

async function runSearch() {
  const query = searchInput.value.trim();

  renderLoading();
  toolbar.classList.remove("visible");
  btnSearch.disabled = true;

  try {
    const response = await new Promise((resolve, reject) => {
      api.runtime.sendMessage({ type: "SEARCH_HISTORY", query }, (res) => {
        if (api.runtime.lastError) reject(api.runtime.lastError);
        else resolve(res);
      });
    });

    const results = response?.results || [];
    allGroups = groupByDomain(results);

    const totalItems  = results.length;
    const totalGroups = allGroups.length;

    if (totalItems === 0) {
      renderEmpty(query);
      toolbar.classList.remove("visible");
    } else {
      renderGroups(allGroups);
      resultSummary.innerHTML =
        `<strong>${totalItems}</strong> result${totalItems !== 1 ? "s" : ""} across <strong>${totalGroups}</strong> domain${totalGroups !== 1 ? "s" : ""}`;
      toolbar.classList.add("visible");
      updateDeleteBtn();
    }
  } catch (err) {
    resultsEl.innerHTML = `
      <div class="state-box">
        <span class="state-icon">⚠️</span>
        <p class="state-title">Something went wrong</p>
        <p class="state-desc">${escHtml(err?.message || String(err))}</p>
      </div>`;
  } finally {
    btnSearch.disabled = false;
  }
}

// ── Delete ────────────────────────────────────────────────────────────────

async function doDelete(urls) {
  if (urls.length === 0) return;

  const confirmed = confirm(`Delete ${urls.length} history item${urls.length !== 1 ? "s" : ""}?`);
  if (!confirmed) return;

  btnDeleteSel.disabled = true;
  btnDeleteSel.textContent = "Deleting…";

  try {
    const response = await new Promise((resolve, reject) => {
      api.runtime.sendMessage({ type: "DELETE_ITEMS", urls }, (res) => {
        if (api.runtime.lastError) reject(api.runtime.lastError);
        else resolve(res);
      });
    });

    showToast(`✓ Deleted ${response?.deleted ?? urls.length} item${urls.length !== 1 ? "s" : ""}`, "success");
    // Re-run the last search to refresh results
    await runSearch();
  } catch (err) {
    showToast("⚠ Delete failed: " + (err?.message || String(err)), "error");
  } finally {
    updateDeleteBtn();
  }
}

// ── Event listeners ───────────────────────────────────────────────────────

btnSearch.addEventListener("click", runSearch);

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

btnDeleteSel.addEventListener("click", () => {
  doDelete(getCheckedUrls());
});

btnClear.addEventListener("click", () => {
  searchInput.value = "";
  allGroups = [];
  toolbar.classList.remove("visible");
  resultsEl.innerHTML = `
    <div class="state-box">
      <span class="state-icon">🕐</span>
      <p class="state-title">Search your history</p>
      <p class="state-desc">Enter a keyword or paste a URL above to find and clean up matching history entries.</p>
    </div>`;
  searchInput.focus();
});

// Focus search on open
searchInput.focus();
