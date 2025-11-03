// ==UserScript==
// @name         FB Graph Matrix
// @namespace    aliasnet/fb
// @version      1.0
// @description  Adaptive Graph gating for Facebook's Matrix scripts. This script selectively blocks or delays network requests to graph based on dwell, language and keyword heuristics. 
// @match        https://*.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://web.facebook.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function bootstrap() {
  const DEFAULT_GRAPH_RULES = {
    languageBlockEnabled: false,
    languageBlock: ["Han", "Thai"],
    minTextLength: 40,
    maxTextLength: 40000,
    keywordsByScript: {
      Latin: ["sponsored", "advertisement", "ad"],
      Han: ["赞助", "广告", "贊助", "廣告", "推荐", "推薦", "为你推荐", "為你推薦"],
    },
    keywordsGlobal: [],
    minDwellMs: 2500,
    cooldownMs: 3000,
    intersectionThreshold: 0.15,
    payloadTripwireEnabled: false,
    payloadNeedles: ["dwell", "impression", "viewport", "logging", "exposure", "scroll", "view_time", "duration", "watch_time"],
    blockHosts: ["graph.facebook.com", "graph-fallback.facebook.com", "b-graph.facebook.com"],
    debug: false,
    uiBadge: true,
    hotkey: { altKey: true, code: "KeyB" },
  };

  const cloneDefaults = () => ({
    languageBlockEnabled: DEFAULT_GRAPH_RULES.languageBlockEnabled,
    languageBlock: [...DEFAULT_GRAPH_RULES.languageBlock],
    minTextLength: DEFAULT_GRAPH_RULES.minTextLength,
    maxTextLength: DEFAULT_GRAPH_RULES.maxTextLength,
    keywordsByScript: Object.fromEntries(
      Object.entries(DEFAULT_GRAPH_RULES.keywordsByScript).map(([script, words]) => [script, [...words]])
    ),
    keywordsGlobal: [...DEFAULT_GRAPH_RULES.keywordsGlobal],
    minDwellMs: DEFAULT_GRAPH_RULES.minDwellMs,
    cooldownMs: DEFAULT_GRAPH_RULES.cooldownMs,
    intersectionThreshold: DEFAULT_GRAPH_RULES.intersectionThreshold,
    payloadTripwireEnabled: DEFAULT_GRAPH_RULES.payloadTripwireEnabled,
    payloadNeedles: [...DEFAULT_GRAPH_RULES.payloadNeedles],
    blockHosts: [...DEFAULT_GRAPH_RULES.blockHosts],
    debug: DEFAULT_GRAPH_RULES.debug,
    uiBadge: DEFAULT_GRAPH_RULES.uiBadge,
    hotkey: { ...DEFAULT_GRAPH_RULES.hotkey },
  });

  const arrOfStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

  const sanitizeGraphRules = (raw) => {
    const result = cloneDefaults();
    if (!isPlainObject(raw)) return result;

    if (typeof raw.languageBlockEnabled === 'boolean') result.languageBlockEnabled = raw.languageBlockEnabled;
    if (arrOfStrings(raw.languageBlock)) result.languageBlock = raw.languageBlock.slice();

    if (isPlainObject(raw.keywordsByScript)) {
      const map = {};
      for (const [script, words] of Object.entries(raw.keywordsByScript)) {
        if (arrOfStrings(words)) map[script] = words.slice();
      }
      result.keywordsByScript = map;
    }

    if (arrOfStrings(raw.keywordsGlobal)) result.keywordsGlobal = raw.keywordsGlobal.slice();
    if (isFiniteNumber(raw.minTextLength)) result.minTextLength = raw.minTextLength;
    if (isFiniteNumber(raw.maxTextLength)) result.maxTextLength = raw.maxTextLength;
    if (isFiniteNumber(raw.minDwellMs)) result.minDwellMs = raw.minDwellMs;
    if (isFiniteNumber(raw.cooldownMs)) result.cooldownMs = raw.cooldownMs;
    if (isFiniteNumber(raw.intersectionThreshold)) result.intersectionThreshold = raw.intersectionThreshold;

    if (typeof raw.payloadTripwireEnabled === 'boolean') result.payloadTripwireEnabled = raw.payloadTripwireEnabled;
    if (arrOfStrings(raw.payloadNeedles)) result.payloadNeedles = raw.payloadNeedles.slice();
    if (arrOfStrings(raw.blockHosts)) result.blockHosts = raw.blockHosts.slice();
    if (typeof raw.debug === 'boolean') result.debug = raw.debug;
    if (typeof raw.uiBadge === 'boolean') result.uiBadge = raw.uiBadge;

    if (isPlainObject(raw.hotkey) && typeof raw.hotkey.code === 'string' && typeof raw.hotkey.altKey === 'boolean') {
      result.hotkey = { altKey: !!raw.hotkey.altKey, code: String(raw.hotkey.code) };
    }

    return result;
  };

  let storedGraph = null;
  try {
    if (typeof window.fbMatrixGetGraphRules === 'function') {
      storedGraph = window.fbMatrixGetGraphRules();
    } else if (typeof window.fbMatrixGetRules === 'function') {
      const maybe = window.fbMatrixGetRules();
      storedGraph = maybe && typeof maybe === 'object' ? maybe.graph : null;
    }
  } catch {}

  const graphConfig = sanitizeGraphRules(storedGraph);

  // Inline inject into page-world so our fetch/XHR/beacon hooks run where FB runs.
  const code = function (config) {
    'use strict';

    /* ========================= CONFIG ========================= */

    // ---- Gate toggles ----
    // Gate A: block by script/language presence (no keywords required)
    const LANGUAGE_BLOCK_ENABLED = !!config.languageBlockEnabled;          // set true to block when selected scripts are present
    const LANGUAGE_BLOCK = Array.isArray(config.languageBlock) ? config.languageBlock : [];
    const MIN_TEXT_LEN = config.minTextLength;
    const MAX_TEXT_LEN = config.maxTextLength;

    // Gate B: block by keywords (no regex; Aho–Corasick)
    // Per-script keyword sets. Omit "Latin" to avoid English triggers.
    const KEYWORDS_BY_SCRIPT = config.keywordsByScript || {};
    // Global keywords (apply regardless of script). Keep empty unless needed.
    const KEYWORDS_GLOBAL = config.keywordsGlobal || [];

    // Dwell behavior
    let   MIN_DWELL_MS   = config.minDwellMs;     // time-in-view to qualify
    const COOLDOWN_MS    = config.cooldownMs;     // keep blocking briefly after leaving view
    const INTERSECTION_THRESHOLD = config.intersectionThreshold; // fraction visible (mobile-friendly)

    // Network scope (Graph endpoints + fallbacks)
    const BLOCK_HOSTS = new Set(Array.isArray(config.blockHosts) ? config.blockHosts : []);
    // Pure-string path filter (no regex). Adjust as needed.
    function pathAllowed(url) {
      const p = url.pathname;
      if (p.startsWith("/api/graphql")) return true;
      if ((p.startsWith("/v") && p.includes("/events"))) return true;
      if (p.includes("tracking")) return true;
      return false;
    }

    // Payload tripwire (optional). If enabled, also block when payload contains these hints.
    const PAYLOAD_TRIPWIRE_ENABLED = !!config.payloadTripwireEnabled;
    const PAYLOAD_NEEDLES = Array.isArray(config.payloadNeedles) ? config.payloadNeedles : [];

    // UI / debugging
    const DEBUG   = !!config.debug;
    const UI_BADGE = !!config.uiBadge;                        // tiny on/off badge on mobile
    const HOTKEY  = config.hotkey || { altKey: true, code: "KeyB" }; // Alt+B desktop toggle

    /* =================== TEXT NORMALIZATION =================== */

    const normalize = (s) => (s||"")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")      // strip diacritics
      .replace(/\s+/g, " ")                 // collapse whitespace
      .trim()
      .toLowerCase();

    const seg = (typeof Intl !== "undefined" && Intl.Segmenter)
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;

    function prepForSearch(s) {
      const t = normalize(s);
      if (!seg) return t;
      try {
        const parts = [];
        for (const {segment} of seg.segment(t)) parts.push(segment);
        return parts.join(" ");
      } catch { return t; }
    }

    /* ===================== SCRIPT DETECTION ==================== */

    // Prefer Unicode property escapes; fallback to ranges if unsupported.
    const ScriptRE = (() => {
      try {
        return {
          Han:   /\p{Script=Han}/gu,
          Thai:  /\p{Script=Thai}/gu,
          Arabic:/\p{Script=Arabic}/gu,
          Latin: /\p{Script=Latin}/gu,
        };
      } catch {
        return {
          Han:    /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g,
          Thai:   /[\u0E00-\u0E7F]/g,
          Arabic: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g,
          Latin:  /[A-Za-z\u00C0-\u024F]/g,
        };
      }
    })();

    // Prioritize scripts; first present wins (helps mixed-script posts)
    const SCRIPT_PRIORITY = ["Han","Thai","Arabic","Latin"];
    function primaryScriptOf(text) {
      const s = String(text || "");
      const counts = {};
      for (const [name, re] of Object.entries(ScriptRE)) {
        re.lastIndex = 0;
        counts[name] = (s.match(re) || []).length;
      }
      for (const name of SCRIPT_PRIORITY) {
        if ((counts[name] || 0) >= 1) return name;
      }
      return "Unknown";
    }

    /* ===================== AHO–CORASICK ======================== */

    function buildAC(patterns) {
      const root = { next: Object.create(null), fail: null, out: [] };
      for (const raw of patterns) {
        if (!raw) continue;
        const p = String(raw);
        let node = root;
        for (const ch of p) {
          node = (node.next[ch] ||= { next: Object.create(null), fail: null, out: [] });
        }
        node.out.push(p);
      }
      const q = [];
      for (const ch in root.next) { const n = root.next[ch]; n.fail = root; q.push(n); }
      while (q.length) {
        const r = q.shift();
        for (const ch in r.next) {
          const s = r.next[ch];
          q.push(s);
          let f = r.fail;
          while (f && !f.next[ch]) f = f.fail;
          s.fail = (f && f.next[ch]) ? f.next[ch] : root;
          s.out = s.out.concat(s.fail.out);
        }
      }
      function test(text) {
        let node = root;
        for (const ch of text) {
          while (node && !node.next[ch]) node = node.fail;
          node = (node && node.next[ch]) ? node.next[ch] : root;
          if (node.out.length) return true;
        }
        return false;
      }
      return { test };
    }

    // Build automatons per script; NO global fallback unless explicitly desired.
    const AC_BY_SCRIPT = {};
    for (const [script, arr] of Object.entries(KEYWORDS_BY_SCRIPT)) {
      AC_BY_SCRIPT[script] = buildAC(arr.map(prepForSearch));
    }
    const AC_FALLBACK = null; // keep null to avoid accidental English triggers
    const AC_GLOBAL   = KEYWORDS_GLOBAL.length ? buildAC(KEYWORDS_GLOBAL.map(prepForSearch)) : null;

    /* ======================== STATE ============================ */

    const log = (...a) => DEBUG && console.log("[FB-GF]", ...a);
    let globallyEnabled = true;
    let blockActive = false;
    let cooldownTimer = null;

    const nodeState = new WeakMap(); // node -> {visible, t0, dwell, hit, reason}
    const metrics = { totalBlocked: 0, lastBlockTs: 0, lastReason: "", hits: 0 };

    /* =================== OBSERVERS / DWELL ===================== */

    function considerNode(el) {
      if (!(el instanceof Element)) return;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;

      const raw = el.textContent || "";
      if (!raw) return;

      const prepared = prepForSearch(raw);
      if (prepared.length < MIN_TEXT_LEN || prepared.length > MAX_TEXT_LEN) return;

      const script = primaryScriptOf(raw); // e.g., "Han" | "Thai" | "Latin" | "Unknown"

      // Gate A: language-only presence
      const langHit = LANGUAGE_BLOCK_ENABLED && LANGUAGE_BLOCK.includes(script);

      // Gate B: keywords
      const acScript = AC_BY_SCRIPT[script] || AC_FALLBACK;
      const kwHit = (acScript && acScript.test(prepared)) || (AC_GLOBAL && AC_GLOBAL.test(prepared));

      if (!(langHit || kwHit)) return;

      if (!nodeState.has(el)) {
        nodeState.set(el, { visible: false, t0: null, dwell: 0, hit: true, reason: (langHit && kwHit) ? "lang+kw" : (langHit ? "lang" : "kw") });
        io.observe(el);
        metrics.hits++;
        log(`[track] script=${script} reason=${(langHit && kwHit)?"lang+kw":(langHit?"lang":"kw")}`, el);
      }
    }

    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) {
              considerNode(n);
              const kids = n.querySelectorAll ? n.querySelectorAll("*") : [];
              for (const k of kids) considerNode(k);
            } else if (m.type === "characterData" && m.target?.parentElement) {
              considerNode(m.target.parentElement);
            }
          });
        }
        if (m.type === "characterData" && m.target?.parentElement) {
          considerNode(m.target.parentElement);
        }
      }
    });

    const io = new IntersectionObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const ns = nodeState.get(e.target);
        if (!ns) continue;
        const nowVisible = e.isIntersecting && e.intersectionRatio >= INTERSECTION_THRESHOLD;
        if (nowVisible && !ns.visible) { ns.visible = true; ns.t0 = performance.now(); changed = true; }
        else if (!nowVisible && ns.visible) { ns.visible = false; if (ns.t0!=null) ns.dwell += performance.now()-ns.t0; ns.t0=null; changed = true; }
      }
      if (changed) recomputeBlock();
    }, { root: null, threshold: INTERSECTION_THRESHOLD });

    function recomputeBlock() {
      let qualified = false;
      const now = performance.now();
      nodeState.forEach((ns) => {
        let live = ns.dwell;
        if (ns.visible && ns.t0 != null) live += (now - ns.t0);
        if (ns.visible && live >= MIN_DWELL_MS) qualified = true;
      });

      const want = globallyEnabled && qualified;
      if (want) {
        clearTimeout(cooldownTimer);
        if (!blockActive) { blockActive = true; log("BLOCK ON (dwell)"); badgeSet(true); }
      } else {
        clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
          if (blockActive) { blockActive = false; log("BLOCK OFF (cooldown)"); badgeSet(false); }
        }, COOLDOWN_MS);
      }
    }

    /* ===================== NETWORK HOOKS ======================= */

    function payloadTrip(bodyStr) {
      if (!PAYLOAD_TRIPWIRE_ENABLED || !bodyStr) return false;
      const t = bodyStr.toLowerCase();
      return PAYLOAD_NEEDLES.some(w => t.includes(w));
    }

    function isBlocked(u, bodyStr) {
      if (!blockActive) return false;
      try {
        const url = new URL(u, location.href);
        if (!BLOCK_HOSTS.has(url.hostname) || url.port) return false;
        if (!pathAllowed(url)) return false;
        if (PAYLOAD_TRIPWIRE_ENABLED && !payloadTrip(bodyStr)) return false;
        return true;
      } catch { return false; }
    }

    const W = window;

    // fetch
    const realFetch = W.fetch;
    W.fetch = function (input, init) {
      let url = typeof input === "string" ? input : (input && input.url) || "";
      let bodyPreview = "";
      try {
        const body = (arguments[1]?.body ?? init?.body);
        if (typeof body === "string") bodyPreview = body.slice(0, 4096);
        else if (body instanceof URLSearchParams) bodyPreview = body.toString().slice(0, 4096);
      } catch {}
      if (isBlocked(url, bodyPreview)) {
        metrics.totalBlocked++; metrics.lastBlockTs = Date.now(); metrics.lastReason = "fetch";
        return Promise.reject(new TypeError("Blocked by FB Graph Filter"));
      }
      return realFetch.apply(this, arguments);
    };

    // XHR
    const XHR = W.XMLHttpRequest;
    const xhrOpen = XHR.prototype.open;
    const xhrSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) { this.__alias_url = url; return xhrOpen.apply(this, arguments); };
    XHR.prototype.send = function (body) {
      const bodyPreview = (typeof body === "string") ? body.slice(0,4096) : "";
      if (isBlocked(this.__alias_url, bodyPreview)) {
        metrics.totalBlocked++; metrics.lastBlockTs = Date.now(); metrics.lastReason = "xhr";
        try { this.abort(); queueMicrotask(() => this.dispatchEvent(new Event("error"))); } catch {}
        return;
      }
      return xhrSend.apply(this, arguments);
    };

    // sendBeacon
    const realBeacon = W.navigator.sendBeacon?.bind(W.navigator);
    if (realBeacon) {
      W.navigator.sendBeacon = function (url, data) {
        const bodyPreview = (typeof data === "string") ? data.slice(0,4096) : "";
        if (isBlocked(url, bodyPreview)) {
          metrics.totalBlocked++; metrics.lastBlockTs = Date.now(); metrics.lastReason = "beacon";
          return false;
        }
        return realBeacon(url, data);
      };
    }

    /* ================== UI + CONTROLS ========================== */

    W.addEventListener("keydown", (e) => {
      if (!!e.altKey === HOTKEY.altKey && e.code === HOTKEY.code) {
        globallyEnabled = !globallyEnabled;
        if (!globallyEnabled) { blockActive = false; badgeSet(false); }
        recomputeBlock();
        e.preventDefault(); e.stopPropagation();
      }
    }, { capture: true });

    let badge;
    function badgeSet(on) {
      if (!UI_BADGE) return;
      if (!badge) {
        badge = document.createElement("div");
        Object.assign(badge.style, {
          position: "fixed", top: "6px", left: "6px", zIndex: 2147483647,
          font: "12px/1.2 -apple-system,Segoe UI,Roboto,Arial,sans-serif",
          padding: "4px 6px", borderRadius: "10px",
          background: "rgba(0,0,0,0.55)", color: "#fff", userSelect: "none", opacity: "0.7"
        });
        badge.textContent = "GB:off";
        badge.title = "Tap: toggle global; Long press: reset metrics";
        let pressTimer = null;
        badge.addEventListener("touchstart", () => { pressTimer = setTimeout(() => { metrics.totalBlocked = 0; badgeUpdate(); }, 700); });
        badge.addEventListener("touchend", () => clearTimeout(pressTimer));
        badge.addEventListener("click", (e) => {
          globallyEnabled = !globallyEnabled;
          if (!globallyEnabled) blockActive = false;
          badgeUpdate(); recomputeBlock();
          e.preventDefault(); e.stopPropagation();
        });
        document.documentElement.appendChild(badge);
      }
      badgeUpdate();
    }
    function badgeUpdate() {
      if (!UI_BADGE || !badge) return;
      badge.textContent = `GB:${(blockActive && globallyEnabled)?"on":"off"} (${metrics.totalBlocked})`;
      badge.style.background = (blockActive && globallyEnabled) ? "rgba(0,128,0,0.55)" : "rgba(0,0,0,0.55)";
    }

    /* ======================== INIT ============================= */

    function initObservers() {
      try {
        mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        if (document.body) considerNode(document.body);
        // Same-origin iframe auto-inject (best-effort)
        new MutationObserver((muts)=> {
          for (const m of muts) {
            m.addedNodes?.forEach(n => {
              if (n.tagName === "IFRAME") {
                try {
                  const doc = n.contentWindow?.document;
                  if (doc && doc.location.hostname.endsWith("facebook.com")) {
                    const s = doc.createElement("script");
                    s.textContent = `(${arguments.callee.toString()})();`; // re-inject self
                    doc.documentElement.appendChild(s); s.remove();
                  }
                } catch {}
              }
            });
          }
        }).observe(document.documentElement, { childList: true, subtree: true });
        badgeSet(false);
        log("Observers started (Lang/Keyword gates; AC/no-regex).");
      } catch (e) { log("Observer error:", e); }
    }
    if (document.readyState === "loading") initObservers(); else initObservers();

    // Tiny console API for quick A/B
    W.__FB_DWELL__ = {
      get metrics() { return { ...metrics, blockActive, globallyEnabled }; },
      enable() { globallyEnabled = true; },
      disable() { globallyEnabled = false; blockActive = false; },
      setDwell(ms) { if (ms>0) MIN_DWELL_MS = ms; }
    };
  };

  const s = document.createElement('script');
  s.textContent = `(${code.toString()})(${JSON.stringify(graphConfig)});`;
  document.documentElement.appendChild(s);
  s.remove();
})();
