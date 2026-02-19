# Smart History Manager

Smart History Manager helps people maintain healthy boundaries between work and personal browsing — without hiding activity or compromising organizational policies.
---

## Features

### 🔍 Manual Search
Type any keyword or paste a URL to search your history. Results are grouped by domain (most-visited first), displayed as collapsible cards with per-item checkboxes for selective deletion.

### ⚡ Smart Cleanup Suggestions
The extension automatically analyses your last 7 days of history on popup open and proactively surfaces sessions that may contain personal browsing — without you needing to search for anything.

Instead of accusatory language, it uses neutral framing:
> **"Mixed browsing session detected. Some activity may be personal. Would you like to review?"**

### 🧠 5-Layer Context Analysis Engine

The suggestion engine scores each browsing session. A session is only surfaced when its score passes a confidence threshold — reducing false positives for power users.

| Layer | Signal | How it works |
|---|---|---|
| **1. URL Intent** | Path-based scoring | `/watch`, `/cart`, `/reels` → personal; `/adsmanager`, `/dashboard` → work |
| **2. Domain Variety** | Number of unique domains | Many unrelated domains = personal browsing |
| **3. Rapid Navigation** | Pages per minute | High page-switching rate = browsing feeds/videos |
| **4. Time Pattern** | Work hours check | Personal activity during 9–5 weekdays scores higher |
| **5. User Override** | Stored preferences | Mark a domain as Work/Personal; score adjusts instantly |

**Work signals suppress suggestions** — if a session contains Ads Manager, dashboards, or analytics URLs, it does not get flagged even if YouTube was also visited in the same window.

### 👤 Domain Override System
Every suggestion card and every review result shows **[🏢 Work] [👤 Personal]** toggle buttons per domain.

Once set, preferences are stored locally:
```json
{ "youtube.com": "work" }
```
The scoring engine reads these on the next analysis — a domain marked as Work will subtract from the session's personal score. Marked domains are never flagged again.

### 📈 Adaptive Learning
Each time you click **Ignore** on a suggestion, the extension increments a per-domain ignore counter. After **3 ignores** involving the same domain, that domain is automatically treated as a work domain in future scoring — with no explicit user action required.

---

## Project Structure

```
smart-history-manager/
├── manifest.json           # Firefox MV3 manifest
├── manifest.chrome.json    # Chrome MV3 manifest
├── service_worker.js       # Background: Context Analysis Engine + message router
├── history.js              # Cross-browser history API wrappers
├── grouping.js             # Groups flat history items by domain
├── cleanup.js              # Sends delete requests to background
└── popup/
    ├── popup.html          # UI shell
    ├── popup.css           # Dark-mode design system
    └── popup.js            # UI controller
```

---

## How to Load

### Chrome
1. Copy `manifest.chrome.json` → `manifest.json` (save the original as `manifest.firefox.json`)
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder

### Firefox
1. Keep `manifest.json` as-is (it's the Firefox version)
2. Open `about:debugging` → **This Firefox**
3. Click **Load Temporary Add-on** → select `manifest.json`

---

## Cross-Browser Compatibility

All API calls use a single compatibility shim — no polyfill library required:
```js
const api = typeof browser !== "undefined" ? browser : chrome;
```
Chrome and Firefox have different `background` manifest keys but otherwise share the full WebExtensions API surface used here.

---

## Privacy

All data stays on-device.

- History is read using the browser's built-in `history` API
- User preferences (`domainPrefs`, `ignoredSessions`, `domainIgnoreCounts`) are stored in `chrome.storage.local` / `browser.storage.local`
- Nothing is sent to any server

This extension does NOT:

- bypass company monitoring
- hide network activity
- anonymize browsing

---

## Permissions Used

| Permission | Why |
|---|---|
| `history` | Read and delete browsing history |
| `storage` | Persist domain preferences and ignored sessions |
| `tabs` | (Reserved for future tab-context enrichment) |
