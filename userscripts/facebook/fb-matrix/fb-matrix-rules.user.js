// ==UserScript==
// @name         FB Matrix Updater
// @namespace    aliasnet/fb
// @version      1.0
// @description  Periodic fetch of the unified Matrix rules shared across Facebook scripts; stores the JSON for page scripts.
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
  // >>>> UPDATE THIS to raw JSON URL
  const URL = 'https://raw.githubusercontent.com/aliasnet/alias-scripts/refs/heads/main/userscripts/facebook/fb-matrix/fb-matrix-rules.json';

  // unified storage keys: use a single prefix so all scripts can read the same cache
  const K_RULES = '__fb_matrix_rules_json_v1';       // raw JSON text
  const K_ETAG  = '__fb_matrix_rules_etag_v1';       // last seen ETag
  const K_TS    = '__fb_matrix_rules_ts_v1';         // last fetch timestamp (ms)

  // 55–65 min jitter to avoid thundering herd
  const EVERY_HOUR_MS = 60 * 60 * 1000;
  const jitter = () => (55 + Math.floor(Math.random() * 10)) * 60 * 1000;

  const arr = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  const validHostEntry = (entry) => (
    isPlainObject(entry)
    && arr(entry.feed)
    && arr(entry.post)
    && arr(entry.postText)
    && (!('keywords' in entry) || arr(entry.keywords))
  );

  const validHosts = (hosts) => (
    isPlainObject(hosts)
    && Object.values(hosts).every(validHostEntry)
  );

  const validKeywordsByScript = (value) => (
    isPlainObject(value)
    && Object.values(value).every(arr)
  );

  const validHotkey = (value) => (
    isPlainObject(value)
    && typeof value.code === 'string'
    && typeof value.altKey === 'boolean'
  );

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

  const validGraph = (graph) => (
    isPlainObject(graph)
    && typeof graph.languageBlockEnabled === 'boolean'
    && arr(graph.languageBlock)
    && validKeywordsByScript(graph.keywordsByScript)
    && arr(graph.keywordsGlobal)
    && isFiniteNumber(graph.minTextLength)
    && isFiniteNumber(graph.maxTextLength)
    && isFiniteNumber(graph.minDwellMs)
    && isFiniteNumber(graph.cooldownMs)
    && isFiniteNumber(graph.intersectionThreshold)
    && typeof graph.payloadTripwireEnabled === 'boolean'
    && arr(graph.payloadNeedles)
    && arr(graph.blockHosts)
    && typeof graph.debug === 'boolean'
    && typeof graph.uiBadge === 'boolean'
    && validHotkey(graph.hotkey)
  );

  const valid = (obj) => (
    isPlainObject(obj)
    && validHosts(obj.hosts)
    && (!('graph' in obj) || validGraph(obj.graph))
  );

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

            GM_setValue(K_RULES, incomingText);
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

  // Helper your page scripts can call to read cached rules (hosts + graph)
  // Example usage in another userscript: const rules = unsafeWindow.fbMatrixGetRules();
  function getRules() {
    try {
      const txt = GM_getValue(K_RULES, null);
      if (!txt) return null;
      const obj = JSON.parse(txt);
      return valid(obj) ? obj : null;
    } catch {
      return null;
    }
  }

  function getGraphRules() {
    const rules = getRules();
    return rules && typeof rules === 'object' ? (rules.graph || null) : null;
  }

  // Expose helper (ScriptCat/Tampermonkey-compatible)
  try {
    window.fbMatrixGetRules = getRules;
    window.fbMatrixGetGraphRules = getGraphRules;
  } catch (e) { /* no-op */ }

  // Kick off now + repeat hourly with jitter
  refresh();
  setInterval(refresh, jitter() || EVERY_HOUR_MS);
})();
