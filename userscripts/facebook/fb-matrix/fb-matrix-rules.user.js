// ==UserScript==
// @name         FB Matrix Rules
// @namespace    aliasnet/fb
// @version      2.0.0
// @description  Unified rules fetcher for the fb-matrix family (no legacy). Caches raw JSON and announces updates.
// @match        https://*.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://touch.facebook.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @noframes
// ==/UserScript==

(() => {
  const URL = "https://raw.githubusercontent.com/aliasnet/alias-scripts/refs/heads/main/userscripts/facebook/fb-matrix/fb-matrix-rules.json";

  // unified storage keys: use a single prefix so all scripts can read the same cache
  const K_RULES = '__fb_matrix_rules_json_v1';       // raw JSON text
  const K_ETAG  = '__fb_matrix_rules_etag_v1';       // last seen ETag
  const K_TS    = '__fb_matrix_rules_ts_v1';         // last fetch timestamp (ms)

  // 55–65 min jitter to avoid thundering herd
  const EVERY_HOUR_MS = 60 * 60 * 1000;
  const jitter = () => (55 + Math.floor(Math.random() * 10)) * 60 * 1000;

  const isStringArray = (value) => Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0);
  const isHostEntry = (entry) => !!entry && typeof entry === 'object' &&
    isStringArray(entry.feed) && isStringArray(entry.post) && isStringArray(entry.postText) &&
    (!('keywords' in entry) || isStringArray(entry.keywords));

  const valid = (payload) => {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.schema !== 1) return false;
    if (!payload.hosts || typeof payload.hosts !== 'object') return false;

    const hostKeys = Object.keys(payload.hosts);
    if (!hostKeys.length) return false;

    let hasDefault = false;
    for (const key of hostKeys) {
      if (!isHostEntry(payload.hosts[key])) return false;
      if (key === 'default') hasDefault = true;
    }
    return hasDefault;
  };

  const pickHostKey = (hosts, hostname) => {
    if (!hostname) return 'default';
    const lower = hostname.toLowerCase();
    const candidates = new Set([lower]);
    if (lower.startsWith('www.')) candidates.add(lower.slice(4));
    const parts = lower.split('.');
    if (parts.length > 2) {
      candidates.add(parts.slice(parts.length - 2).join('.'));
      candidates.add(parts.slice(parts.length - 3).join('.'));
    }

    for (const key of candidates) {
      if (hosts[key]) return key;
    }
    return hosts.default ? 'default' : null;
  };

  const toLegacyShape = (payload, hostname) => {
    if (!valid(payload)) return null;
    const hosts = payload.hosts;
    const defaultEntry = hosts.default;
    const key = pickHostKey(hosts, hostname) || 'default';
    const hostEntry = hosts[key] || defaultEntry;
    const select = (field) => {
      if (isStringArray(hostEntry?.[field])) return hostEntry[field];
      if (hostEntry !== defaultEntry && isStringArray(defaultEntry?.[field])) return defaultEntry[field];
      return [];
    };

    const keywords = (() => {
      const hostKeywords = isStringArray(hostEntry?.keywords) ? hostEntry.keywords : [];
      if (hostEntry === defaultEntry) return hostKeywords;
      const defaultKeywords = isStringArray(defaultEntry?.keywords) ? defaultEntry.keywords : [];
      return hostKeywords.length ? hostKeywords : defaultKeywords;
    })();

    return {
      feed: select('feed'),
      post: select('post'),
      postText: select('postText'),
      keywords
    };
  };

  function refresh() {
    const etag = GM_getValue(K_ETAG, null);

    GM_xmlhttpRequest({
      method: 'GET',
      url: URL,
      headers: etag ? { 'If-None-Match': etag } : {},
      timeout: 15000,
      onload: (r) => {
        // 304 = not modified → keep cache
        if (r.status === 304) return;

        if (r.status >= 200 && r.status < 300) {
          try {
            const incomingText = typeof r.responseText === 'string' ? r.responseText : '';
            const json = JSON.parse(incomingText);

            if (!valid(json)) {
              // Don’t poison cache with invalid shape
              return;
            }

            GM_setValue(K_RULES, JSON.stringify(json));
            GM_setValue(K_TS, Date.now());

            // capture ETag from headers if present
            const m = r.responseHeaders && r.responseHeaders.match(/^etag:\s*(.+)$/mi);
            if (m) GM_setValue(K_ETAG, m[1].trim());
          } catch {
            // swallow parse errors silently; keep previous cache
          }
        }
      },
      onerror: () => {},
      ontimeout: () => {}
    });
  }

  // Helper your page scripts can call to read cached rules
  // Example usage in another userscript: const rules = unsafeWindow.fbMatrixGetRules();
  function getRules(hostname = (typeof location === 'object' && location ? location.hostname : '')) {
    try {
      const txt = GM_getValue(K_RULES, null);
      if (!txt) return null;
      const obj = JSON.parse(txt);
      return toLegacyShape(obj, hostname);
    } catch {
      return null;
    }
  }

  // Expose helper (ScriptCat/Tampermonkey-compatible)
  try { window.fbMatrixGetRules = getRules; } catch (e) { /* no-op */ }

  // Kick off now + repeat hourly with jitter
  refresh();
  setInterval(refresh, jitter() || EVERY_HOUR_MS);
})();
