// ==UserScript==
// @name         FB*Matrix Siphon
// @namespace    aliasnet/fb
// @version      1.0
// @description  Hourly fetch of shared keyword seeding rules; stores for page scripts
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      raw.githubusercontent.com
// @noframes
// ==/UserScript==

(() => {
  // >>>> UPDATE THIS to raw JSON URL
  const URL = 'https://example.com/fb-matrix-seed.json';

  const K_RULES = '__fb_matrix_seed_rules_v1';       // raw JSON text
  const K_ETAG  = '__fb_seed_matrix_rules_etag_v1';  // last seen ETag
  const K_TS    = '__fb_matrix_seed_rules_ts_v1';    // last fetch timestamp (ms)

  // 55–65 min jitter to avoid thundering herd
  const EVERY_HOUR_MS = 60 * 60 * 1000;
  const jitter = () => (55 + Math.floor(Math.random() * 10)) * 60 * 1000;

  const valid = (o) => {
    const arr = v => Array.isArray(v) && v.every(x => typeof x === 'string');
    return !!o && arr(o.feed) && arr(o.post) && arr(o.postText) && (!o.keywords || arr(o.keywords));
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

  // Helper your page scripts can call to read cached rules
  // Example usage in another userscript: const rules = unsafeWindow.fbfeederGetRules();
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

  // Expose helper (ScriptCat/Tampermonkey-compatible)
try { window.fbfeederGetRules = getRules; } catch (e) { /* no-op */ }

  // Kick off now + repeat hourly with jitter
  refresh();
  setInterval(refresh, jitter() || EVERY_HOUR_MS);
})();
