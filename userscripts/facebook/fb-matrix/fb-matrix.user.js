// ==UserScript==
// @name         FB*Matrix
// @namespace    aliasnet/fb
// @version      1.0
// @description  Seeding keywords into Facebook's DOM to personalise the feed. This script reads selectors and keywords from local storage and adapts the page accordingly. Rules are fetched by fb-matrix-rules.user.js.
// @match        https://www.facebook.com/*
// @match        https://m.facebook.com/*
// @match        https://touch.facebook.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULT_RULES = {
    feed: ['div[role="feed"]','main [role="main"] div[role="feed"]','[aria-label="Feed"]','[data-pagelet^="Feed"]'],
    post: ['article[role="article"]','div[role="article"]','div[data-pagelet^="FeedUnit"]'],
    postText: ['[data-ad-preview="message"]','[data-lexical-text]','div[dir="auto"]','[contenteditable="false"]'],
    keywords: ['vacation']          // fallback if no remote rules present
  };
  const STORE_RULES = '__fb_matrix_rules_json_v1';

  let rules = loadRules();
  let detach = initDomLogic(rules);

  GM_addValueChangeListener(STORE_RULES, (_key, _oldV, newV) => {
    try {
      const incoming = JSON.parse(newV);
      rules = sanitizeRules(incoming, DEFAULT_RULES);
      if (detach) detach();         // disconnect observers
      detach = initDomLogic(rules); // rehook with new selectors/keywords
    } catch {}
  });

  function loadRules(){
    try {
      const saved = GM_getValue(STORE_RULES, '');
      if (saved) return sanitizeRules(JSON.parse(saved), DEFAULT_RULES);
    } catch {}
    return DEFAULT_RULES;
  }

  function sanitizeRules(r, d){
    const ok = v => Array.isArray(v) && v.every(x => typeof x === 'string');
    return {
      feed: ok(r?.feed) ? r.feed : d.feed,
      post: ok(r?.post) ? r.post : d.post,
      postText: ok(r?.postText) ? r.postText : d.postText,
      keywords: ok(r?.keywords) && r.keywords.length ? r.keywords : d.keywords
    };
  }

  // --- your existing DOM logic here, parameterized by `rules` ---
  function initDomLogic(rules){
    // … use rules.feed / rules.post / rules.postText / rules.keywords …
    // return a function that disconnects observers/timeouts.
    const disconnectors = [];
    // (Attach MutationObservers etc.; push cleanup fns into disconnectors.)
    return () => disconnectors.splice(0).forEach(fn => { try{ fn(); }catch{} });
  }
})();
