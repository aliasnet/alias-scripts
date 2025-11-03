// ==UserScript==
// @name         FB*Matrix
// @namespace    aliasnet/fb
// @version      2.0.0
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
    feed: ['div[role="feed"]','[data-pagelet^="Feed"]','main [role="main"] div[role="feed"]'],
    post: ['article[role="article"]','div[role="article"]','div[data-pagelet^="FeedUnit"]'],
    postText: ['[data-ad-preview="message"]','[data-lexical-text]','div[dir="auto"]','[contenteditable="false"]'],
    keywords: ['AI','Artificial Intelligence','Magick','AGI','Secret','Automation','Uncensored']
  };
  const STORE_RULES = '__fb_matrix_rules_json_v1';
  const HOSTNAME = (typeof location === 'object' && location ? location.hostname : '');

  let rules = loadRules();
  let detach = initDomLogic(rules);

  GM_addValueChangeListener(STORE_RULES, (_key, _oldV, newV) => {
    if (typeof newV !== 'string') return;
    try {
      const incoming = JSON.parse(newV);
      const resolved = resolveRemoteRules(incoming) || DEFAULT_RULES;
      rules = resolved;
      if (detach) detach();
      detach = initDomLogic(rules);
    } catch {}
  });

  function loadRules(){
    try {
      const saved = GM_getValue(STORE_RULES, '');
      if (saved) {
        const parsed = JSON.parse(saved);
        const resolved = resolveRemoteRules(parsed);
        if (resolved) return resolved;
      }
    } catch {}
    return DEFAULT_RULES;
  }

  function resolveRemoteRules(payload){
    const isStringArray = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
    if (!payload || typeof payload !== 'object') return null;

    if (payload.schema === 1 && payload.hosts && typeof payload.hosts === 'object') {
      const hosts = payload.hosts;
      const defaultEntry = hosts.default;
      if (!defaultEntry || !isHostEntry(defaultEntry)) return null;

      const hostEntry = resolveHostEntry(hosts) || defaultEntry;
      const pick = (field) => {
        if (isStringArray(hostEntry[field])) return hostEntry[field];
        if (hostEntry !== defaultEntry && isStringArray(defaultEntry[field])) return defaultEntry[field];
        return [];
      };

      const keywords = (() => {
        const hostKeywords = isStringArray(hostEntry.keywords) ? hostEntry.keywords : [];
        if (hostEntry === defaultEntry) return hostKeywords;
        const fallback = isStringArray(defaultEntry.keywords) ? defaultEntry.keywords : [];
        return hostKeywords.length ? hostKeywords : fallback;
      })();

      return {
        feed: pick('feed'),
        post: pick('post'),
        postText: pick('postText'),
        keywords: keywords.length ? keywords : DEFAULT_RULES.keywords
      };
    }

    return null;
  }

  function isHostEntry(entry){
    const isStringArray = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0);
    if (!entry || typeof entry !== 'object') return false;
    if (!isStringArray(entry.feed)) return false;
    if (!isStringArray(entry.post)) return false;
    if (!isStringArray(entry.postText)) return false;
    if ('keywords' in entry && !isStringArray(entry.keywords)) return false;
    return true;
  }

  function resolveHostEntry(hosts){
    if (!hosts || typeof hosts !== 'object') return null;
    const lowerHost = HOSTNAME.toLowerCase();
    const candidates = [lowerHost];
    if (lowerHost.startsWith('www.')) candidates.push(lowerHost.slice(4));
    const parts = lowerHost.split('.');
    if (parts.length > 2) {
      candidates.push(parts.slice(parts.length - 2).join('.'));
      candidates.push(parts.slice(parts.length - 3).join('.'));
    }

    for (const key of candidates) {
      if (hosts[key] && isHostEntry(hosts[key])) return hosts[key];
    }
    return isHostEntry(hosts.default) ? hosts.default : null;
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
