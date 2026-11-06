/* AI 网页翻译助手 - 内容脚本
 * 整页双语翻译 / 还原 / 动态内容 / 划词 / 悬停 / 输入框
 */

(function () {
  if (window.__aitTranslator) return;
  window.__aitTranslator = true;

  const IS_TOP = (function () {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  const MAX_UNITS = 1800;
  const PAGE_LANG = (document.documentElement.lang || '').toLowerCase();

  // ---------- 状态 ----------

  let cfg = null;
  const skipSelectorState = { raw: '', selector: '' };

  const page = {
    translated: false,
    translating: false,
    cancel: false,
    units: [],
    inserted: [],
    replacedEls: [],
    replacedTexts: [],
    doneEls: new WeakSet(),
    doneTexts: new WeakSet(),
    observer: null,
    cache: new Map(),
    lastEngine: 'free',
    total: 0,
    done: 0,
    count: 0,
    lastError: '',
    dynamicTimer: null,
    dynamicRoots: [],
    dynamicBusy: false,
    pillTimer: null,
    pillEpoch: 0,
    runId: 0,
    modeTimer: null,
    pillHost: null,
    pillRoot: null
  };

  const sel = {
    host: null,
    root: null,
    text: '',
    source: '',
    translation: '',
    engine: 'free',
    rect: null,
    cache: new Map(),
    timer: null
  };

  const hover = {
    host: null,
    root: null,
    text: '',
    timer: null,
    x: 0,
    y: 0,
    visible: false
  };

  const inputUI = {
    host: null,
    root: null,
    el: null,
    text: '',
    translation: '',
    engine: 'free',
    visible: false
  };

  // ---------- 基础工具 ----------

  function safeSendMessage(message, callback) {
    try {
      if (!chrome.runtime || !chrome.runtime.id) {
        if (callback) callback(null);
        return;
      }
      chrome.runtime.sendMessage(message, function (res) {
        if (chrome.runtime.lastError) {
          if (callback) callback(null);
          return;
        }
        if (callback) callback(res);
      });
    } catch (e) {
      if (callback) callback(null);
    }
  }

  function askConfig() {
    return new Promise(function (resolve) {
      safeSendMessage({ type: 'get-config' }, function (res) {
        if (res && res.ok && res.config) {
          cfg = res.config;
          resolve(cfg);
        } else {
          resolve(cfg);
        }
      });
    });
  }

  function notifyState(translated, translating) {
    if (!IS_TOP) return;
    safeSendMessage({
      type: 'page-state',
      translated: !!translated,
      translating: !!translating,
      count: page.count || 0
    });
  }

  function openSettings(params) {
    safeSendMessage({ type: 'open-options', params: params || {} });
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\r]+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  function countCJK(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x4e00 && c <= 0x9fff) n++;
    }
    return n;
  }

  function countHangul(s) {
    return (s.match(/[\uac00-\ud7af]/g) || []).length;
  }

  function countKana(s) {
    return (s.match(/[\u3040-\u30ff]/g) || []).length;
  }

  function hasLetters(s) {
    return /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f\u3040-\u30ff\uac00-\ud7af]/.test(s);
  }

  function needsTranslation(raw) {
    const t = cleanText(raw);
    if (t.length < 2) return false;
    if (!hasLetters(t)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return false;

    const target = (cfg && cfg.targetLang) || 'zh-CN';
    if (target.indexOf('zh') === 0) {
      const cjk = countCJK(t);
      const kana = countKana(t);
      if (cjk / Math.max(1, t.length) > 0.55 && kana / Math.max(1, t.length) < 0.03) return false;
      return true;
    }
    if (target === 'ja') {
      const kana = countKana(t);
      const cjk = countCJK(t);
      if (kana / Math.max(1, t.length) > 0.03 &&
        (kana + cjk) / Math.max(1, t.length) > 0.45) return false;
      return true;
    }
    if (target === 'ko') {
      if (countHangul(t) / Math.max(1, t.length) > 0.4) return false;
      return true;
    }
    const base = target.split('-')[0];
    if (PAGE_LANG.indexOf(base) === 0 && !/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0400-\u04ff]/.test(t)) {
      return false;
    }
    if (base === 'en' && !PAGE_LANG &&
      /(^|\s)(the|and|of|to|in|is|for|with|on|that|this|are|was|be|as|by|it|from|at|or|an|we|you|your|have|has|will|not)(\s|$)/i.test(t) &&
      (t.match(/[A-Za-z]/g) || []).length > 12) {
      return false;
    }
    return true;
  }

  function chunkList(list, maxItems, maxChars) {
    const out = [];
    let cur = [];
    let len = 0;
    for (const t of list) {
      if (cur.length >= maxItems || (len + t.length > maxChars && cur.length)) {
        out.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function runPool(items, concurrency, fn) {
    let idx = 0;
    const n = Math.max(1, Math.min(concurrency, items.length));
    async function worker() {
      while (idx < items.length) {
        const my = idx++;
        await fn(items[my], my);
      }
    }
    await Promise.all(Array.from({ length: n }, worker));
  }

  function sendTranslate(texts, engine) {
    return new Promise(function (resolve) {
      let finished = false;
      const timer = setTimeout(function () {
        if (finished) return;
        finished = true;
        resolve({ ok: false, error: '翻译请求超时，请重试' });
      }, 120000);

      safeSendMessage({
        type: 'translate',
        texts: texts,
        engine: engine,
        target: cfg ? cfg.targetLang : 'zh-CN',
        context: {
          domain: location.hostname,
          title: document.title,
          url: location.href
        }
      }, function (res) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (!res) {
          resolve({ ok: false, error: '无法连接翻译后台，请刷新页面或重新加载扩展' });
          return;
        }
        resolve(res);
      });
    });
  }

  function engineForDefault() {
    if (!cfg) return 'free';
    if (cfg.engine === 'ai' && cfg.aiConfigured) return 'ai';
    return 'free';
  }

  // ---------- 样式 ----------

  function isDarkPage() {
    function lum(color) {
      const m = String(color || '').match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
      if (!m) return null;
      const a = m[4] == null ? 1 : parseFloat(m[4]);
      if (a < 0.2) return null;
      return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
    }
    let l = lum(getComputedStyle(document.body || document.documentElement).backgroundColor);
    if (l == null && document.documentElement) {
      l = lum(getComputedStyle(document.documentElement).backgroundColor);
    }
    return l != null && l < 0.35;
  }

  function applyStyle() {
    if (!cfg) return;
    let old = document.getElementById('ait-page-style');
    if (old) old.remove();

    const st = cfg.style || {};
    let color = st.color || '#1a73e8';
    if ((st.theme || 'auto') === 'auto' && color.toLowerCase() === '#1a73e8' && isDarkPage()) {
      color = '#7ab8ff';
    }
    const size = Math.max(0.75, Math.min(1.3, Number(st.size) || 0.94));
    const sep = st.separator
      ? 'border-top:1px dashed rgba(128,128,128,.28)!important;padding-top:.22em!important;'
      : '';

    const css = '' +
      '[data-ait-tr]{all:unset!important;display:block!important;box-sizing:border-box!important;' +
      'width:auto!important;max-width:100%!important;margin:.28em 0 .1em 0!important;' +
      'padding:0!important;color:' + color + '!important;background:transparent!important;' +
      'font-family:inherit!important;font-size:' + size + 'em!important;font-style:normal!important;' +
      'font-weight:400!important;line-height:1.55!important;text-align:inherit!important;' +
      'text-decoration:none!important;letter-spacing:normal!important;text-transform:none!important;' +
      'white-space:pre-wrap!important;float:none!important;position:static!important;' +
      'visibility:visible!important;background-image:none!important;-webkit-text-fill-color:' + color + '!important;' +
      'word-break:break-word!important;overflow-wrap:anywhere!important;' + sep + '}' +
      '[data-ait-tr].ait-inline{display:inline!important;margin:0 0 0 .3em!important;padding:0!important;' +
      'border:none!important;font-size:.9em!important;line-height:inherit!important;' +
      'vertical-align:baseline!important;white-space:normal!important;}' +
      '[data-ait-tr].ait-inside{margin-top:.14em!important;margin-bottom:.06em!important;padding-top:0!important;' +
      'border-top:none!important;}' +
      '[data-ait-tr].ait-replace{margin-top:0!important;margin-bottom:0!important;padding-top:0!important;' +
      'border-top:none!important;}' +
      '[data-ait-orig-hidden]{display:none!important;}' +
      '@media print{[data-ait-tr]{color:#444!important;border-color:#bbb!important;}}';

    const style = document.createElement('style');
    style.id = 'ait-page-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- 文本单元收集 ----------

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1,
    SELECT: 1, OPTION: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1,
    SVG: 1, CANVAS: 1, IFRAME: 1, VIDEO: 1, AUDIO: 1, HEAD: 1, TITLE: 1,
    META: 1, LINK: 1, BR: 1, HR: 1, IMG: 1, PICTURE: 1, SOURCE: 1,
    TRACK: 1, MAP: 1, AREA: 1, OBJECT: 1, EMBED: 1, MATH: 1, PATH: 1
  };

  const CONTAINER_TAGS = {
    BODY: 1, HTML: 1, NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, MAIN: 1,
    SECTION: 1, ARTICLE: 1, FORM: 1, FIELDSET: 1, DETAILS: 1, DIALOG: 1,
    UL: 1, OL: 1, DL: 1, TABLE: 1, THEAD: 1, TBODY: 1, TFOOT: 1,
    TR: 1, FIGURE: 1, MENU: 1
  };

  const INLINE_TAGS = {
    A: 1, SPAN: 1, BUTTON: 1, LABEL: 1, STRONG: 1, EM: 1, B: 1, I: 1,
    SMALL: 1, MARK: 1, ABBR: 1, CITE: 1, Q: 1, TIME: 1, SUB: 1, SUP: 1,
    U: 1, S: 1, DEL: 1, INS: 1, OUTPUT: 1, BDI: 1, BDO: 1, WBR: 0
  };

  function isExcluded(el) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName;
    if (SKIP_TAGS[tag]) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox') return true;
    try {
      if (el.closest('pre,code,kbd,samp,textarea,select,input,[contenteditable="true"],[contenteditable=""],[translate="no"],.notranslate,[data-ait-tr],[data-ait-ui],[data-ait-orig]')) {
        return true;
      }
      if (cfg && cfg.skipSelectors) {
        if (skipSelectorState.raw !== cfg.skipSelectors) {
          skipSelectorState.raw = cfg.skipSelectors;
          skipSelectorState.selector = '';
          try {
            document.querySelector(cfg.skipSelectors);
            skipSelectorState.selector = cfg.skipSelectors;
          } catch (e) { skipSelectorState.selector = ''; }
        }
        if (skipSelectorState.selector && el.closest(skipSelectorState.selector)) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function isHidden(el) {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      if (cs.display !== 'contents' && el.getClientRects().length === 0) return true;
    } catch (e) { return true; }
    return false;
  }

  function isFlexGrid(cs) {
    return /flex|grid/.test(cs.display || '');
  }

  function isBlockLevel(el) {
    const tag = el.tagName;
    if (CONTAINER_TAGS[tag]) return true;
    if (tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'H1' || tag === 'H2' ||
      tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' ||
      tag === 'TD' || tag === 'TH' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION' ||
      tag === 'DD' || tag === 'DT' || tag === 'SUMMARY' || tag === 'CAPTION' ||
      tag === 'ADDRESS') return true;
    try {
      const d = getComputedStyle(el).display;
      if (/^(block|flow-root|list-item|table|table-row|table-cell|table-caption|flex|grid)$/.test(d)) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  function hasBlockChild(el) {
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      if (isExcluded(c)) continue;
      try {
        const cs = getComputedStyle(c);
        if (cs.display === 'none') continue;
      } catch (e) { continue; }
      if (isBlockLevel(c)) return true;
    }
    return false;
  }

  function hasLinkChildren(el) {
    if (!el.children.length) return false;
    let n = 0;
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i];
      if (isExcluded(c)) continue;
      if (c.tagName === 'A' || c.tagName === 'BUTTON' || c.tagName === 'LABEL') n++;
      else return false;
    }
    return n >= 2;
  }

  function containsTranslation(el) {
    try {
      return !!el.querySelector('[data-ait-tr]');
    } catch (e) { return false; }
  }

  function hashText(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function findExistingTranslation(el, hash) {
    try {
      const next = el.nextElementSibling;
      if (next && next.hasAttribute && next.hasAttribute('data-ait-tr') && next.getAttribute('data-ait-hash') === hash) return next;
      const prev = el.previousElementSibling;
      if (prev && prev.hasAttribute && prev.hasAttribute('data-ait-tr') && prev.getAttribute('data-ait-hash') === hash) return prev;
      for (const c of el.children) {
        if (c.hasAttribute && c.hasAttribute('data-ait-tr') && c.getAttribute('data-ait-hash') === hash) return c;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function textOf(el) {
    let t = '';
    try { t = el.innerText != null ? el.innerText : el.textContent; } catch (e) { t = el.textContent || ''; }
    return cleanText(t);
  }

  function placementOf(el, kind) {
    if (kind === 'inline' || kind === 'text') return 'inline';
    const tag = el.tagName;
    let placement = 'after';
    if (tag === 'TD' || tag === 'TH' || tag === 'LI' || tag === 'DD' || tag === 'DT' ||
      tag === 'SUMMARY' || tag === 'CAPTION' || tag === 'P' || tag === 'H1' ||
      tag === 'H2' || tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' ||
      tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION' || tag === 'ADDRESS') {
      placement = 'inside';
    }
    if (placement === 'after' && el.parentElement) {
      try {
        const pcs = getComputedStyle(el.parentElement);
        if (isFlexGrid(pcs) || pcs.display === 'inline' || pcs.display === 'inline-block') {
          placement = 'inside';
        }
      } catch (e) { /* 忽略 */ }
    }
    if (placement === 'inside' && (tag === 'P' || tag === 'H1' || tag === 'H2' || tag === 'H3')) {
      try {
        const cs = getComputedStyle(el);
        if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '0') placement = 'after';
      } catch (e) { /* 忽略 */ }
    }
    return placement;
  }

  function addUnit(units, el, text, kind) {
    if (!text || !needsTranslation(text)) return false;
    if (kind === 'text') {
      units.push({ node: el, el: el.parentElement, text: text, kind: 'text', placement: 'inline' });
      return true;
    }
    if (page.doneEls.has(el)) return false;
    if (isExcluded(el)) return false;
    units.push({ el: el, text: text, kind: kind, placement: placementOf(el, kind) });
    return true;
  }

  function collectUnits(root) {
    const units = [];
    let max = MAX_UNITS;

    function addDirectTexts(el) {
      if (!el || !el.childNodes) return;
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (units.length >= max) return;
        if (n.nodeType !== 3) continue;
        if (page.doneTexts.has(n)) continue;
        const text = cleanText(n.nodeValue);
        if (!needsTranslation(text)) continue;
        addUnit(units, n, text, 'text');
      }
    }

    function descend(el, depth) {
      if (!el || units.length >= max || depth > 60) return;
      for (let i = 0; i < el.children.length; i++) {
        walk(el.children[i], depth + 1);
      }
    }

    function walk(el, depth) {
      if (!el || units.length >= max || depth > 60) return;
      if (isExcluded(el)) return;
      if (page.doneEls.has(el)) return;
      if (isHidden(el)) return;

      const tag = el.tagName;
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { return; }
      const display = cs.display || '';

      if (CONTAINER_TAGS[tag]) {
        addDirectTexts(el);
        descend(el, depth);
        return;
      }

      if (tag === 'A' || tag === 'BUTTON' || tag === 'LABEL') {
        if (!hasBlockChild(el)) {
          if (containsTranslation(el)) { descend(el, depth); return; }
          const t = textOf(el);
          addUnit(units, el, t, 'inline');
          return;
        }
        descend(el, depth);
        return;
      }

      if (INLINE_TAGS[tag] && !/^(block|flow-root|list-item|table|table-cell|flex|grid)$/.test(display)) {
        if (!hasBlockChild(el)) {
          if (containsTranslation(el)) { descend(el, depth); return; }
          const t = textOf(el);
          addUnit(units, el, t, 'inline');
          return;
        }
        descend(el, depth);
        return;
      }

      if (isFlexGrid(cs) || display === 'contents') {
        addDirectTexts(el);
        descend(el, depth);
        return;
      }

      if (!hasBlockChild(el)) {
        if (containsTranslation(el)) {
          addDirectTexts(el);
          descend(el, depth);
          return;
        }
        // 一行多个链接/按钮（常见于导航栏）逐项翻译，避免整行粘在一起
        if (hasLinkChildren(el)) {
          descend(el, depth);
          return;
        }
        const t = textOf(el);
        addUnit(units, el, t, 'block');
        return;
      }

      addDirectTexts(el);
      descend(el, depth);
    }

    if (!root) return units;
    if (root.nodeType === 3) {
      const parent = root.parentElement;
      if (parent && !isExcluded(parent) && !page.doneTexts.has(root)) {
        const t = cleanText(root.nodeValue);
        addUnit(units, root, t, 'text');
      }
      return units;
    }
    if (root.nodeType !== 1) return units;
    if (root === document.body || root === document.documentElement) {
      walk(root, 0);
    } else {
      walk(root, 0);
    }
    return units;
  }

  // ---------- 插入 / 还原 ----------

  function hasMediaChild(el) {
    try {
      return !!el.querySelector('svg,img,picture,video,canvas,iframe');
    } catch (e) { return false; }
  }

  function isTextOnlyContainer(el) {
    try {
      return !el.querySelector('svg,img,picture,video,canvas,iframe,button,input,select,textarea');
    } catch (e) { return false; }
  }

  function replaceTextPreservingMedia(el, out) {
    const nodes = [];
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.trim()) nodes.push(n);
      }
    } catch (e) { /* 忽略 */ }
    if (!nodes.length) {
      const all = Array.from(el.childNodes);
      page.replacedEls.push({ el: el, nodes: all });
      el.textContent = out;
      return;
    }
    nodes.sort(function (a, b) { return b.nodeValue.trim().length - a.nodeValue.trim().length; });
    for (const n of nodes) page.replacedTexts.push({ node: n, orig: n.nodeValue });
    nodes[0].nodeValue = out;
    for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = '';
  }

  function isUiInline(el) {
    try {
      return !!el.closest('nav,header,footer,[role="navigation"],[role="menu"],[role="menubar"],button,[role="button"]');
    } catch (e) { return false; }
  }

  function makeTr(text, inline) {
    const span = document.createElement('span');
    span.setAttribute('data-ait-tr', '1');
    span.setAttribute('dir', 'auto');
    span.className = 'ait-tr' + (inline ? ' ait-inline' : '');
    span.textContent = text;
    return span;
  }

  const REPLACE_INNER_TAGS = {
    P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, FIGCAPTION: 1, ADDRESS: 1,
    LI: 1, TD: 1, TH: 1, DD: 1, DT: 1, SUMMARY: 1, CAPTION: 1
  };

  function insertTranslation(unit, text) {
    if (!unit || unit.done) return;
    const out = String(text || '').trim();
    if (!out) return;

    if (unit.kind === 'text') {
      const node = unit.node;
      if (!node || !node.parentNode) return;
      unit.done = true;
      page.doneTexts.add(node);
      if (out === unit.text) return;

      if (cfg.displayMode === 'replace') {
        page.replacedTexts.push({ node: node, orig: node.nodeValue });
        node.nodeValue = out;
        return;
      }
      const tr = makeTr(out, true);
      if (cfg.displayMode === 'above') {
        node.parentNode.insertBefore(tr, node);
      } else {
        node.parentNode.insertBefore(tr, node.nextSibling);
      }
      page.inserted.push({ tr: tr });
      return;
    }

    const el = unit.el;
    if (!el || !el.parentNode) return;
    unit.done = true;
    page.doneEls.add(el);
    if (out === unit.text) {
      el.setAttribute('data-ait-orig', '1');
      return;
    }

    el.setAttribute('data-ait-orig', '1');

    const srcHash = hashText(unit.text);
    if (cfg.displayMode !== 'replace') {
      const existing = findExistingTranslation(el, srcHash);
      if (existing) {
        existing.textContent = out;
        existing.setAttribute('data-ait-hash', srcHash);
        if (unit.kind === 'inline') existing.classList.add('ait-inline');
        if (unit.placement === 'inside') existing.classList.add('ait-inside');
        return;
      }
    }

    if (cfg.displayMode === 'replace' && unit.kind === 'inline') {
      if (hasMediaChild(el)) {
        replaceTextPreservingMedia(el, out);
      } else {
        const nodes = Array.from(el.childNodes);
        page.replacedEls.push({ el: el, nodes: nodes });
        el.textContent = out;
      }
      return;
    }

    // 导航、按钮等小控件直接换成中文，避免译文把导航栏撑高
    if (unit.kind === 'inline' && isUiInline(el) && out.length <= 80) {
      if (hasMediaChild(el)) {
        replaceTextPreservingMedia(el, out);
      } else {
        const nodes = Array.from(el.childNodes);
        page.replacedEls.push({ el: el, nodes: nodes });
        el.textContent = out;
      }
      return;
    }

    if (cfg.displayMode === 'replace' && unit.kind === 'block' && unit.placement === 'inside') {
      // 表格、列表、段落、纯文本容器：直接换掉内容，保留容器本身
      if (REPLACE_INNER_TAGS[el.tagName] || isTextOnlyContainer(el)) {
        const nodes = Array.from(el.childNodes);
        page.replacedEls.push({ el: el, nodes: nodes });
        el.textContent = out;
        return;
      }
      if (hasMediaChild(el) && out.length <= 80) {
        replaceTextPreservingMedia(el, out);
        return;
      }
      // 卡片、flex 子项等：隐藏原内容但保留占位，让译文单独显示
      const trInside = makeTr(out, false);
      trInside.classList.add('ait-inside', 'ait-replace');
      trInside.setAttribute('data-ait-hash', hashText(unit.text));
      trInside.style.setProperty('visibility', 'visible', 'important');
      const prevVisibility = el.style.getPropertyValue('visibility');
      const prevVisibilityPriority = el.style.getPropertyPriority('visibility');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.appendChild(trInside);
      page.inserted.push({
        el: el,
        tr: trInside,
        prevVisibility: prevVisibility,
        prevVisibilityPriority: prevVisibilityPriority
      });
      return;
    }

    const tr = makeTr(out, unit.kind === 'inline');
    tr.setAttribute('data-ait-hash', srcHash);
    if (unit.placement === 'inside') tr.classList.add('ait-inside');

    if (cfg.displayMode === 'replace' && unit.kind === 'block' && unit.placement === 'after') {
      const prevDisplay = el.style.getPropertyValue('display');
      const prevDisplayPriority = el.style.getPropertyPriority('display');
      tr.classList.add('ait-replace');
      el.setAttribute('data-ait-orig-hidden', '1');
      el.style.setProperty('display', 'none', 'important');
      el.parentNode.insertBefore(tr, el.nextSibling);
      page.inserted.push({
        el: el,
        tr: tr,
        hidden: true,
        prevDisplay: prevDisplay,
        prevDisplayPriority: prevDisplayPriority
      });
      return;
    }

    if (unit.placement === 'inline') {
      el.appendChild(tr);
    } else if (unit.placement === 'inside') {
      if (cfg.displayMode === 'above') el.insertBefore(tr, el.firstChild);
      else el.appendChild(tr);
    } else {
      if (cfg.displayMode === 'above') el.parentNode.insertBefore(tr, el);
      else el.parentNode.insertBefore(tr, el.nextSibling);
    }
    page.inserted.push({ el: el, tr: tr });
  }

  function insertForText(byText, text, translation) {
    const list = byText.get(text);
    if (!list || !list.length) return 0;
    let n = 0;
    for (const unit of list) {
      if (unit.done) continue;
      insertTranslation(unit, translation);
      if (unit.done) n++;
    }
    return n;
  }

  function restorePage(silent) {
    page.cancel = true;
    page.runId++;
    page.translating = false;
    page.translated = false;

    if (page.observer) {
      try { page.observer.disconnect(); } catch (e) { /* 忽略 */ }
      page.observer = null;
    }
    if (page.dynamicTimer) {
      clearTimeout(page.dynamicTimer);
      page.dynamicTimer = null;
    }

    for (const item of page.inserted) {
      try {
        if (item.tr && item.tr.parentNode) item.tr.parentNode.removeChild(item.tr);
        if (item.el) {
          if (item.prevDisplay !== undefined) {
            if (item.prevDisplay) item.el.style.setProperty('display', item.prevDisplay, item.prevDisplayPriority || '');
            else item.el.style.removeProperty('display');
          }
          if (item.prevVisibility !== undefined) {
            if (item.prevVisibility) item.el.style.setProperty('visibility', item.prevVisibility, item.prevVisibilityPriority || '');
            else item.el.style.removeProperty('visibility');
          }
          item.el.removeAttribute('data-ait-orig-hidden');
          item.el.removeAttribute('data-ait-orig');
        }
      } catch (e) { /* 忽略 */ }
    }
    for (const item of page.replacedEls) {
      try {
        if (!item.el) continue;
        if (item.nodes) item.el.replaceChildren.apply(item.el, item.nodes);
        else if (item.html != null) item.el.innerHTML = item.html;
      } catch (e) { /* 忽略 */ }
    }
    for (const item of page.replacedTexts) {
      try {
        if (item.node) item.node.nodeValue = item.orig;
      } catch (e) { /* 忽略 */ }
    }

    // 清理站点重新渲染后残留的标记
    try {
      document.querySelectorAll('[data-ait-tr]').forEach(function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      document.querySelectorAll('[data-ait-orig-hidden]').forEach(function (el) {
        el.removeAttribute('data-ait-orig-hidden');
      });
      document.querySelectorAll('[data-ait-orig]').forEach(function (el) {
        el.removeAttribute('data-ait-orig');
      });
    } catch (e) { /* 忽略 */ }

    page.inserted = [];
    page.replacedEls = [];
    page.replacedTexts = [];
    page.doneEls = new WeakSet();
    page.doneTexts = new WeakSet();
    page.units = [];
    page.cache.clear();
    page.count = 0;
    page.total = 0;
    page.done = 0;
    page.dynamicRoots = [];

    hideBubble();
    hideHover();
    hideInput();
    updatePill('hidden');
    notifyState(false, false);

    if (!silent && cfg && cfg.floating) {
      updatePill('restored');
    }
    return { ok: true };
  }

  // ---------- 整页翻译 ----------

  function buildByText(units) {
    const map = new Map();
    for (const u of units) {
      if (!u.text) continue;
      if (!map.has(u.text)) map.set(u.text, []);
      map.get(u.text).push(u);
    }
    return map;
  }

  async function translatePage(engineOverride) {
    if (page.translating) return { ok: false, error: '正在翻译中，请稍候' };
    await askConfig();
    if (!cfg) {
      page.lastError = '扩展配置读取失败：请在 edge://extensions 重新加载扩展，再刷新本页';
      return { ok: false, error: page.lastError };
    }

    const engine = engineOverride === 'ai' || engineOverride === 'free'
      ? engineOverride
      : engineForDefault();
    if (engine === 'ai' && !cfg.aiConfigured) {
      page.lastError = 'AI 尚未配置，请先在设置里填写 API Key';
      updatePill('need-config');
      return { ok: false, error: page.lastError };
    }

    if (page.translated || page.inserted.length) {
      restorePage(true);
    }

    const runId = ++page.runId;
    page.translating = true;
    page.cancel = false;
    page.lastEngine = engine;
    page.lastError = '';
    page.count = 0;
    page.done = 0;
    page.cache.clear();

    const units = collectUnits(document.body);
    page.units = units;
    if (!units.length) {
      page.translating = false;
      updatePill('empty');
      notifyState(false, false);
      return { ok: true, count: 0, message: '本页没有需要翻译的外文内容' };
    }

    const byText = buildByText(units);
    const unique = Array.from(byText.keys());
    page.total = unique.length;
    updatePill('translating');
    notifyState(false, true);

    const groups = chunkList(unique, 30, 5000);
    const errors = [];
    const warnings = [];

    await runPool(groups, 2, async function (group) {
      if (page.cancel || runId !== page.runId) return;
      const res = await sendTranslate(group, engine);
      if (page.cancel || runId !== page.runId) return;
      if (!res || !res.ok) {
        errors.push((res && res.error) || '翻译失败');
        page.done += group.length;
        updatePill('translating');
        return;
      }
      if (res.warnings && res.warnings.length) {
        for (const w of res.warnings) if (warnings.indexOf(w) === -1) warnings.push(w);
      }
      const translations = res.translations || [];
      for (let i = 0; i < group.length; i++) {
        const text = group[i];
        const out = translations[i] || '';
        if (!out) continue;
        page.cache.set(text, out);
        page.count += insertForText(byText, text, out);
      }
      page.done += group.length;
      updatePill('translating');
    });

    if (runId !== page.runId) {
      return { ok: true, count: page.count, stopped: true, warnings: warnings };
    }
    page.translating = false;
    page.translated = page.count > 0;

    if (page.cancel) {
      updatePill('stopped');
      notifyState(page.translated, false);
      return {
        ok: true,
        count: page.count,
        stopped: true,
        warnings: warnings
      };
    }

    if (!page.translated) {
      page.lastError = errors[0] || '没有拿到译文';
      updatePill('error');
      notifyState(false, false);
      return { ok: false, error: page.lastError, warnings: warnings };
    }

    updatePill('done');
    notifyState(true, false);
    startObserver();
    if (cfg.dynamic) {
      setTimeout(function () {
        if (page.translated && !page.dynamicBusy && !page.dynamicTimer) {
          page.dynamicRoots.push(document.body);
          page.dynamicTimer = setTimeout(flushDynamic, 80);
        }
      }, 1600);
    }

    return {
      ok: true,
      count: page.count,
      engine: engine,
      errors: errors,
      warnings: warnings
    };
  }

  // ---------- 动态内容 ----------

  function startObserver() {
    if (!cfg || !cfg.dynamic || page.observer || !document.body) return;
    page.observer = new MutationObserver(function (mutations) {
      if (!page.translated || page.translating || !cfg || !cfg.dynamic) return;
      let added = [];
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (!n) continue;
          if (n.nodeType === 1) {
            if (n.hasAttribute && (n.hasAttribute('data-ait-tr') || n.hasAttribute('data-ait-ui'))) continue;
            try { if (n.closest && n.closest('[data-ait-ui]')) continue; } catch (e) { /* 忽略 */ }
            added.push(n);
          } else if (n.nodeType === 3 && n.parentElement) {
            added.push(n);
          }
        }
      }
      if (!added.length) return;
      page.dynamicRoots = page.dynamicRoots.concat(added);
      if (page.dynamicRoots.length > 300) page.dynamicRoots = page.dynamicRoots.slice(-300);
      if (page.dynamicTimer) clearTimeout(page.dynamicTimer);
      page.dynamicTimer = setTimeout(flushDynamic, 900);
    });
    try {
      page.observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }
  }

  async function flushDynamic() {
    page.dynamicTimer = null;
    if (page.dynamicBusy || page.translating || !page.translated) {
      page.dynamicRoots = [];
      return;
    }
    const roots = page.dynamicRoots.slice();
    page.dynamicRoots = [];
    if (!roots.length) return;

    page.dynamicBusy = true;
    try {
      let units = [];
      for (const root of roots) {
        if (units.length >= 300) break;
        if (root.nodeType === 1 && !root.parentNode) continue;
        units = units.concat(collectUnits(root));
      }
      if (!units.length) return;

      const byText = buildByText(units);
      const unknown = [];
      for (const [text] of byText) {
        if (page.cache.has(text)) {
          page.count += insertForText(byText, text, page.cache.get(text));
        } else {
          unknown.push(text);
        }
      }
      if (!unknown.length) return;

      const groups = chunkList(unknown, 20, 3800);
      await runPool(groups, 2, async function (group) {
        if (!page.translated) return;
        const res = await sendTranslate(group, page.lastEngine || engineForDefault());
        if (!page.translated || !page.dynamicBusy) return;
        if (!res || !res.ok) return;
        const translations = res.translations || [];
        for (let i = 0; i < group.length; i++) {
          const out = translations[i] || '';
          if (!out) continue;
          page.cache.set(group[i], out);
          page.count += insertForText(byText, group[i], out);
        }
      });
      if (page.translated) updatePill('done');
    } finally {
      page.dynamicBusy = false;
    }
  }

  // ---------- 悬浮球 ----------

  const PILL_CSS = `
    :host{all:initial;}
    .pill{display:flex;align-items:center;gap:7px;background:rgba(17,24,39,.94);color:#fff;
      padding:6px 9px;border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.24);
      font:12px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      opacity:.96;transition:opacity .2s ease;}
    .pill:hover{opacity:1;}
    .logo{width:19px;height:19px;border-radius:50%;display:grid;place-items:center;
      background:linear-gradient(135deg,#4f8cff,#1a73e8);font-size:10px;font-weight:700;
      letter-spacing:-.5px;flex:0 0 auto;}
    .txt{max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    button{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 7px;border-radius:7px;
      background:rgba(255,255,255,.14);color:#fff;font-family:inherit;font-size:11px;line-height:1.3;white-space:nowrap;}
    button:hover{background:rgba(255,255,255,.24);}
    button.primary{background:#2f7cf6;}
    button.icon{padding:3px 5px;background:transparent;font-size:14px;opacity:.75;}
    button.icon:hover{opacity:1;background:rgba(255,255,255,.14);}
  `;

  function ensurePill() {
    if (!IS_TOP || !cfg || !cfg.floating) return null;
    if (page.pillHost && page.pillHost.isConnected) return page.pillHost;
    if (page.pillHost && !page.pillHost.isConnected) {
      page.pillHost = null;
      page.pillRoot = null;
    }
    const host = document.createElement('div');
    host.setAttribute('data-ait-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483646;width:auto;height:auto;';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = PILL_CSS;
    root.appendChild(st);
    root.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'stop') {
        page.cancel = true;
        updatePill('stopped');
      } else if (act === 'restore') {
        restorePage(false);
      } else if (act === 'close') {
        host.style.display = 'none';
      } else if (act === 'retry') {
        translatePage(page.lastEngine || engineForDefault());
      } else if (act === 'ai') {
        if (!cfg || !cfg.aiConfigured) {
          updatePill('need-config');
          openSettings({ tab: 'ai' });
          return;
        }
        translatePage('ai');
      }
    });
    host.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    host.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    (document.body || document.documentElement).appendChild(host);
    page.pillHost = host;
    page.pillRoot = root;
    return host;
  }

  function updatePill(state, message) {
    if (!IS_TOP) return;
    page.pillEpoch++;
    const epoch = page.pillEpoch;
    if (!cfg || !cfg.floating) {
      if (page.pillHost) page.pillHost.style.display = 'none';
      return;
    }
    if (state === 'hidden') {
      if (page.pillHost) page.pillHost.style.display = 'none';
      return;
    }
    const host = ensurePill();
    if (!host) return;
    host.style.display = 'block';

    let txt = '';
    let actions = [];
    if (state === 'translating') {
      txt = '翻译中 ' + Math.min(page.done || 0, page.total || 0) + '/' + (page.total || 0);
      actions = [{ act: 'stop', label: '停止' }, { act: 'close', label: '×', cls: 'icon' }];
    } else if (state === 'done') {
      txt = '已译 ' + (page.count || 0) + ' 段';
      actions = [
        { act: 'ai', label: 'AI 精译', cls: 'primary' },
        { act: 'restore', label: '还原' },
        { act: 'close', label: '×', cls: 'icon' }
      ];
    } else if (state === 'stopped') {
      txt = '已停止 · 已译 ' + (page.count || 0) + ' 段';
      actions = [{ act: 'restore', label: '还原' }, { act: 'close', label: '×', cls: 'icon' }];
    } else if (state === 'error') {
      txt = page.lastError ? ('翻译失败：' + String(page.lastError).slice(0, 60)) : '翻译失败';
      actions = [{ act: 'retry', label: '重试' }, { act: 'close', label: '×', cls: 'icon' }];
    } else if (state === 'need-config') {
      txt = '请先配置 AI';
      actions = [{ act: 'close', label: '×', cls: 'icon' }];
    } else if (state === 'empty') {
      txt = '没有需要翻译的外文';
      actions = [{ act: 'close', label: '×', cls: 'icon' }];
      setTimeout(function () { if (page.pillEpoch === epoch) updatePill('hidden'); }, 2500);
    } else if (state === 'restored') {
      txt = '已还原原文';
      actions = [{ act: 'close', label: '×', cls: 'icon' }];
      setTimeout(function () { if (page.pillEpoch === epoch) updatePill('hidden'); }, 1800);
    } else {
      txt = message || '';
      actions = [{ act: 'close', label: '×', cls: 'icon' }];
    }

    const root = page.pillRoot;
    if (!root) return;
    const old = root.querySelector('.pill');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.className = 'pill';
    wrap.title = page.lastError || '';
    const logo = document.createElement('span');
    logo.className = 'logo';
    logo.textContent = '译';
    const txtEl = document.createElement('span');
    txtEl.className = 'txt';
    txtEl.textContent = txt;
    wrap.appendChild(logo);
    wrap.appendChild(txtEl);
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-act', a.act);
      if (a.cls) b.className = a.cls;
      b.textContent = a.label;
      wrap.appendChild(b);
    }
    root.appendChild(wrap);
  }

  // ---------- 划词气泡 ----------

  const BUBBLE_CSS = `
    :host{all:initial;}
    .card{position:fixed;z-index:2147483647;box-sizing:border-box;
      width:max-content;max-width:min(390px,calc(100vw - 24px));min-width:190px;
      background:#fff;color:#1f2328;border-radius:12px;padding:12px 14px 10px;
      box-shadow:0 12px 40px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);
      font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      text-align:left;animation:aitIn .12s ease-out;}
    @keyframes aitIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
    .src{font-size:12px;line-height:1.5;color:#6b7280;border-bottom:1px solid #eef0f3;
      padding-bottom:7px;margin-bottom:7px;max-height:86px;overflow:auto;word-break:break-word;}
    .src:empty{display:none;}
    .out{font-size:15px;line-height:1.65;color:#111827;white-space:pre-wrap;word-break:break-word;
      max-height:260px;overflow:auto;}
    .out.loading{color:#6b7280;font-size:13px;}
    .out.error{color:#d93025;font-size:13px;}
    .bar{display:flex;align-items:center;gap:5px;margin-top:9px;flex-wrap:wrap;}
    button{all:unset;box-sizing:border-box;cursor:pointer;padding:4px 8px;border-radius:7px;
      background:#f3f4f6;color:#374151;font-family:inherit;font-size:12px;line-height:1.3;white-space:nowrap;}
    button:hover{background:#e8eaee;}
    button.primary{background:#1a73e8;color:#fff;}
    button.primary:hover{background:#1660c4;}
    button.icon{margin-left:auto;padding:2px 5px;background:transparent;color:#9ca3af;font-size:15px;}
    button.icon:hover{color:#374151;background:#f3f4f6;}
    @media (prefers-color-scheme:dark){
      .card{background:#1f2329;color:#e6e8eb;box-shadow:0 12px 40px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);}
      .src{color:#9aa4b2;border-color:#2c313a;}
      .out{color:#e6e8eb;}
      .out.loading{color:#9aa4b2;}
      button{background:#2c313a;color:#d6dae0;}
      button:hover{background:#3a414c;}
      button.primary{background:#2f7cf6;color:#fff;}
      button.icon{background:transparent;color:#7d8794;}
    }
  `;

  function ensureSelHost() {
    if (sel.host && sel.host.isConnected) return sel.host;
    if (sel.host && !sel.host.isConnected) {
      sel.host = null;
      sel.root = null;
    }
    const host = document.createElement('div');
    host.setAttribute('data-ait-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;width:0;height:0;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = BUBBLE_CSS;
    root.appendChild(st);
    root.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'copy') {
        copyText(sel.translation || '');
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1200);
      } else if (act === 'close') {
        hideBubble();
      } else if (act === 'speak') {
        speakText(sel.translation || '');
      } else if (act === 'settings') {
        openSettings({ tab: 'ai' });
      } else if (act === 'ai') {
        translateSelectionAI();
      }
    });
    host.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    host.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    (document.body || document.documentElement).appendChild(host);
    sel.host = host;
    sel.root = root;
    return host;
  }

  function bubbleEls() {
    if (!sel.root) return {};
    return {
      card: sel.root.querySelector('.card'),
      src: sel.root.querySelector('.src'),
      out: sel.root.querySelector('.out'),
      ai: sel.root.querySelector('button[data-act="ai"]'),
      settings: sel.root.querySelector('button[data-act="settings"]')
    };
  }

  function makeActionButton(label, act, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-act', act);
    if (cls) b.className = cls;
    b.textContent = label;
    return b;
  }

  function showBubble(rect, source, translation, state) {
    ensureSelHost();
    const old = sel.root.querySelector('.card');
    if (old) old.remove();

    const card = document.createElement('div');
    card.className = 'card';
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = source || '';
    const out = document.createElement('div');
    out.className = 'out';
    out.textContent = translation || '';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(makeActionButton('复制', 'copy'));
    const aiBtn = makeActionButton('AI 精译', 'ai', 'primary');
    bar.appendChild(aiBtn);
    bar.appendChild(makeActionButton('朗读', 'speak'));
    const settingsBtn = makeActionButton('去设置', 'settings');
    settingsBtn.style.display = 'none';
    bar.appendChild(settingsBtn);
    bar.appendChild(makeActionButton('×', 'close', 'icon'));
    card.appendChild(src);
    card.appendChild(out);
    card.appendChild(bar);
    if (state === 'loading') out.classList.add('loading');
    if (state === 'error') out.classList.add('error');
    if (sel.engine === 'ai') aiBtn.style.display = 'none';
    sel.root.appendChild(card);
    sel.host.style.display = 'block';

    positionBubble(card, rect);
    if (state === 'loading') out.textContent = '翻译中…';
  }

  function positionBubble(card, rect) {
    if (!rect) return;
    const pad = 8;
    const w = card.offsetWidth || 300;
    const h = card.offsetHeight || 80;
    let x = rect.left + Math.min(0, (rect.width - w) / 2);
    x = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - pad) y = rect.top - h - 8;
    if (y < pad) y = pad;
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
  }

  function hideBubble() {
    if (sel.host) sel.host.style.display = 'none';
    if (sel.root) {
      const card = sel.root.querySelector('.card');
      if (card) card.remove();
    }
    sel.text = '';
    sel.source = '';
    sel.translation = '';
  }

  function selectionRect() {
    const s = window.getSelection();
    if (!s || !s.rangeCount) return null;
    const range = s.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return rect;
  }

  function translateSelection(force, engineOverride) {
    if (!cfg) return;
    if (!force && !cfg.selection) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed) return;
    const text = cleanText(s.toString());
    if (!text || text.length > 3000) return;
    if (!needsTranslation(text)) return;
    const rect = selectionRect();
    if (!rect) return;

    sel.text = text;
    sel.source = text;
    sel.rect = rect;
    sel.engine = engineOverride === 'ai' ? 'ai' : (engineOverride === 'free' ? 'free' : engineForDefault());
    if (sel.engine === 'ai' && cfg && !cfg.aiConfigured) {
      showBubble(rect, text, 'AI 尚未配置，请先在设置里填写 API Key。', 'error');
      const e0 = bubbleEls();
      if (e0.settings) e0.settings.style.display = 'inline-block';
      if (e0.ai) e0.ai.style.display = 'none';
      return;
    }

    const selKey = sel.engine + '|' + text;
    if (sel.cache.has(selKey)) {
      sel.translation = sel.cache.get(selKey);
      showBubble(rect, text, sel.translation, 'ok');
      return;
    }

    showBubble(rect, text, '', 'loading');
    sendTranslate([text], sel.engine).then(function (res) {
      if (sel.text !== text) return;
      if (!res || !res.ok || !res.translations || !res.translations[0]) {
        sel.translation = '';
        const els = bubbleEls();
        if (els.out) {
          els.out.classList.remove('loading');
          els.out.classList.add('error');
          els.out.textContent = (res && res.error) || '翻译失败，请重试';
        }
        if (sel.engine === 'ai' && els.settings) els.settings.style.display = 'inline-block';
        return;
      }
      const out = res.translations[0];
      sel.translation = out;
      if (sel.cache.size > 80) sel.cache.clear();
      sel.cache.set(selKey, out);
      const els = bubbleEls();
      if (els.out) {
        els.out.classList.remove('loading');
        els.out.textContent = out;
      }
      const rect2 = selectionRect();
      if (rect2 && els.card) positionBubble(els.card, rect2);
    });
  }

  function translateSelectionAI() {
    if (!cfg || !sel.text) return;
    if (!cfg.aiConfigured) {
      const els = bubbleEls();
      if (els.out) {
        els.out.classList.remove('loading');
        els.out.classList.add('error');
        els.out.textContent = 'AI 尚未配置，请先在设置里填写 API Key。';
      }
      if (els.settings) els.settings.style.display = 'inline-block';
      if (els.ai) els.ai.style.display = 'none';
      return;
    }
    const text = sel.text;
    const els = bubbleEls();
    if (els.out) {
      els.out.classList.remove('error');
      els.out.classList.add('loading');
      els.out.textContent = 'AI 精译中…';
    }
    if (els.ai) els.ai.style.display = 'none';
    sendTranslate([text], 'ai').then(function (res) {
      if (sel.text !== text) return;
      if (!res || !res.ok || !res.translations || !res.translations[0]) {
        const e = bubbleEls();
        if (e.out) {
          e.out.classList.remove('loading');
          e.out.classList.add('error');
          e.out.textContent = (res && res.error) || 'AI 翻译失败';
        }
        if (e.ai) e.ai.style.display = 'inline-block';
        return;
      }
      sel.translation = res.translations[0];
      sel.engine = 'ai';
      sel.cache.set('ai|' + text, sel.translation);
      const e = bubbleEls();
      if (e.out) {
        e.out.classList.remove('loading', 'error');
        e.out.textContent = sel.translation;
      }
      const rect2 = selectionRect();
      if (rect2 && e.card) positionBubble(e.card, rect2);
    });
  }

  function copyText(text) {
    const t = String(text || '');
    if (!t) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    } else {
      fallbackCopy(t);
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) { /* 忽略 */ }
  }

  function speakText(text) {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const target = (cfg && cfg.targetLang) || 'zh-CN';
      const map = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
        fr: 'fr-FR', de: 'de-DE', es: 'es-ES', ru: 'ru-RU', pt: 'pt-PT', it: 'it-IT',
        ar: 'ar-SA', tr: 'tr-TR', vi: 'vi-VN', th: 'th-TH', id: 'id-ID' };
      u.lang = map[target] || target;
      u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 悬停翻译 ----------

  const HOVER_CSS = `
    :host{all:initial;}
    .tip{position:fixed;z-index:2147483645;max-width:min(380px,calc(100vw - 24px));
      background:rgba(17,24,39,.95);color:#fff;border-radius:9px;padding:8px 11px;
      box-shadow:0 10px 30px rgba(0,0,0,.26);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      white-space:pre-wrap;word-break:break-word;pointer-events:none;opacity:0;transition:opacity .12s ease;}
    .tip.show{opacity:1;}
    .tip.loading{color:#cbd5e1;font-size:12px;}
  `;

  function ensureHoverHost() {
    if (hover.host && hover.host.isConnected) return hover.host;
    if (hover.host && !hover.host.isConnected) {
      hover.host = null;
      hover.root = null;
    }
    const host = document.createElement('div');
    host.setAttribute('data-ait-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483645;width:0;height:0;pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = HOVER_CSS;
    root.appendChild(st);
    (document.body || document.documentElement).appendChild(host);
    hover.host = host;
    hover.root = root;
    return host;
  }

  function showHover(x, y, text, loading) {
    ensureHoverHost();
    hover.host.style.display = 'block';
    let tip = hover.root.querySelector('.tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      hover.root.appendChild(tip);
    }
    tip.textContent = text || '';
    tip.classList.toggle('loading', !!loading);
    tip.classList.add('show');
    const w = tip.offsetWidth || 260;
    let left = x + 14;
    if (left + w > window.innerWidth - 10) left = Math.max(10, x - w - 14);
    let top = y + 18;
    const h = tip.offsetHeight || 40;
    if (top + h > window.innerHeight - 10) top = Math.max(10, y - h - 12);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    hover.visible = true;
  }

  function hideHover() {
    if (hover.host) hover.host.style.display = 'none';
    hover.visible = false;
    hover.text = '';
  }

  function hoverCandidate(target) {
    let el = target;
    for (let i = 0; el && i < 7; i++) {
      if (el.nodeType === 1) {
        if (isExcluded(el)) return null;
        const t = textOf(el);
        if (t && t.length >= 2 && t.length <= 700 && needsTranslation(t)) return { el: el, text: t };
      }
      el = el.parentElement;
    }
    return null;
  }

  function onHoverMove(e) {
    if (!cfg || !cfg.hover || !e.altKey) return;
    if (e.target && e.target.closest && e.target.closest('[data-ait-ui],[data-ait-tr],input,textarea,[contenteditable]')) {
      hideHover();
      return;
    }
    const cand = hoverCandidate(e.target);
    if (!cand) { hideHover(); return; }
    hover.x = e.clientX;
    hover.y = e.clientY;
    if (hover.text === cand.text && hover.visible) return;
    hover.text = cand.text;

    if (hover.timer) clearTimeout(hover.timer);
    hover.timer = setTimeout(function () {
      const text = cand.text;
      const hEngine = engineForDefault();
      const hKey = hEngine + '|' + text;
      if (sel.cache.has(hKey)) {
        showHover(hover.x, hover.y, sel.cache.get(hKey), false);
        return;
      }
      showHover(hover.x, hover.y, '翻译中…', true);
      const engine = hEngine;
      sendTranslate([text], engine).then(function (res) {
        if (hover.text !== text) return;
        if (!res || !res.ok || !res.translations || !res.translations[0]) {
          showHover(hover.x, hover.y, '翻译失败', true);
          return;
        }
        const out = res.translations[0];
        sel.cache.set(hKey, out);
        showHover(hover.x, hover.y, out, false);
      });
    }, 420);
  }

  // ---------- 输入框翻译 ----------

  const INPUT_CSS = BUBBLE_CSS;

  function ensureInputHost() {
    if (inputUI.host && inputUI.host.isConnected) return inputUI.host;
    if (inputUI.host && !inputUI.host.isConnected) {
      inputUI.host = null;
      inputUI.root = null;
    }
    const host = document.createElement('div');
    host.setAttribute('data-ait-ui', '1');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;width:0;height:0;display:none;';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = INPUT_CSS;
    root.appendChild(st);
    root.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'close') hideInput();
      else if (act === 'copy') {
        copyText(inputUI.translation);
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1200);
      } else if (act === 'replace') {
        replaceInputText();
      } else if (act === 'ai') {
        translateInputAI();
      } else if (act === 'settings') {
        openSettings({ tab: 'ai' });
      }
    });
    host.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    host.addEventListener('mouseup', function (e) { e.stopPropagation(); });
    (document.body || document.documentElement).appendChild(host);
    inputUI.host = host;
    inputUI.root = root;
    return host;
  }

  function inputEls() {
    if (!inputUI.root) return {};
    return {
      card: inputUI.root.querySelector('.card'),
      out: inputUI.root.querySelector('.out'),
      ai: inputUI.root.querySelector('button[data-act="ai"]'),
      settings: inputUI.root.querySelector('button[data-act="settings"]')
    };
  }

  function showInput(rect, source, result, state) {
    ensureInputHost();
    inputUI.root.querySelectorAll('.card').forEach(function (c) { c.remove(); });
    const card = document.createElement('div');
    card.className = 'card';
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = source || '';
    const out = document.createElement('div');
    out.className = 'out';
    out.textContent = result || '';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(makeActionButton('复制', 'copy'));
    bar.appendChild(makeActionButton('替换原文', 'replace', 'primary'));
    const aiBtn = makeActionButton('AI 精译', 'ai');
    bar.appendChild(aiBtn);
    const settingsBtn = makeActionButton('去设置', 'settings');
    settingsBtn.style.display = 'none';
    bar.appendChild(settingsBtn);
    bar.appendChild(makeActionButton('×', 'close', 'icon'));
    card.appendChild(src);
    card.appendChild(out);
    card.appendChild(bar);
    if (state === 'loading') out.classList.add('loading');
    if (state === 'error') out.classList.add('error');
    if (inputUI.engine === 'ai') aiBtn.style.display = 'none';
    inputUI.root.appendChild(card);
    inputUI.host.style.display = 'block';
    inputUI.visible = true;

    const pad = 8;
    const w = card.offsetWidth || 300;
    const h = card.offsetHeight || 90;
    let x = rect.left;
    x = Math.max(pad, Math.min(x, window.innerWidth - w - pad));
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - pad) y = Math.max(pad, rect.top - h - 8);
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
    if (state === 'loading') out.textContent = '翻译中…';
  }

  function hideInput() {
    if (inputUI.host) inputUI.host.style.display = 'none';
    if (inputUI.root) inputUI.root.querySelectorAll('.card').forEach(function (c) { c.remove(); });
    inputUI.visible = false;
    inputUI.el = null;
    inputUI.text = '';
    inputUI.translation = '';
  }

  function editableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return /^(text|search|url|email|tel|)$/.test(type);
    }
    return el.isContentEditable === true;
  }

  function getEditableText(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function onInputKey(e) {
    if (!cfg || !cfg.inputBox) return;
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || !e.shiftKey || e.key !== 'Enter') return;
    const el = e.target;
    if (!editableTarget(el)) return;
    const raw = String(getEditableText(el) || '').trim();
    if (!raw) return;
    if (raw.length > 6000) return;
    if (!needsTranslation(raw)) return;
    e.preventDefault();
    e.stopPropagation();

    inputUI.el = el;
    inputUI.text = raw;
    inputUI.translation = '';
    inputUI.engine = engineForDefault();
    const rect = el.getBoundingClientRect();
    showInput(rect, raw, '', 'loading');
    const requestText = raw;

    sendTranslate([requestText], inputUI.engine).then(function (res) {
      if (!inputUI.el || inputUI.text !== requestText) return;
      if (!res || !res.ok || !res.translations || !res.translations[0]) {
        const els = inputEls();
        if (els.out) {
          els.out.classList.remove('loading');
          els.out.classList.add('error');
          els.out.textContent = (res && res.error) || '翻译失败';
        }
        return;
      }
      inputUI.translation = res.translations[0];
      const els = inputEls();
      if (els.out) {
        els.out.classList.remove('loading');
        els.out.textContent = inputUI.translation;
      }
    });
  }

  function replaceInputText() {
    const el = inputUI.el;
    const text = inputUI.translation;
    if (!el || !text) return;
    try {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();
        try {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, text);
          else el.value = text;
        } catch (e) {
          el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        const selObj = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selObj.removeAllRanges();
        selObj.addRange(range);
        const ok = document.execCommand('insertText', false, text);
        if (!ok) el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      hideInput();
    } catch (e) { /* 忽略 */ }
  }

  function translateInputAI() {
    if (!inputUI.el || !inputUI.text) return;
    if (!cfg || !cfg.aiConfigured) {
      const els = inputEls();
      if (els.out) {
        els.out.classList.remove('loading');
        els.out.classList.add('error');
        els.out.textContent = 'AI 尚未配置，请先在设置里填写 API Key。';
      }
      if (els.settings) els.settings.style.display = 'inline-block';
      if (els.ai) els.ai.style.display = 'none';
      return;
    }
    const text = inputUI.text;
    const els = inputEls();
    if (els.out) {
      els.out.classList.remove('error');
      els.out.classList.add('loading');
      els.out.textContent = 'AI 精译中…';
    }
    if (els.ai) els.ai.style.display = 'none';
    sendTranslate([text], 'ai').then(function (res) {
      if (!inputUI.el || inputUI.text !== text) return;
      if (!res || !res.ok || !res.translations || !res.translations[0]) {
        const e2 = inputEls();
        if (e2.out) {
          e2.out.classList.remove('loading');
          e2.out.classList.add('error');
          e2.out.textContent = (res && res.error) || 'AI 翻译失败';
        }
        if (e2.ai) e2.ai.style.display = 'inline-block';
        return;
      }
      inputUI.translation = res.translations[0];
      inputUI.engine = 'ai';
      const e2 = inputEls();
      if (e2.out) {
        e2.out.classList.remove('loading');
        e2.out.textContent = inputUI.translation;
      }
    });
  }

  // ---------- 事件 ----------

  document.addEventListener('mouseup', function (e) {
    if (!cfg) return;
    if (e.target && e.target.closest && e.target.closest('[data-ait-ui]')) return;
    if (e.target && e.target.closest && e.target.closest('input,textarea,[contenteditable]')) return;
    if (!cfg.selection) return;
    if (sel.timer) clearTimeout(sel.timer);
    sel.timer = setTimeout(function () {
      translateSelection(false);
    }, 240);
  }, true);

  document.addEventListener('mousedown', function (e) {
    if (sel.host && e.target !== sel.host) hideBubble();
    if (hover.host && e.target !== hover.host) hideHover();
    if (inputUI.host && e.target !== inputUI.host) hideInput();
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideBubble();
      hideHover();
      hideInput();
    }
  }, true);

  document.addEventListener('keydown', onInputKey, true);

  document.addEventListener('mousemove', function (e) {
    if (!cfg || !cfg.hover) return;
    if (!e.altKey) {
      if (hover.visible) hideHover();
      return;
    }
    onHoverMove(e);
  }, true);

  document.addEventListener('keyup', function (e) {
    if (e.key === 'Alt') hideHover();
  }, true);

  window.addEventListener('scroll', function () {
    hideHover();
    if (sel.host && sel.host.style.display !== 'none') hideBubble();
    if (inputUI.visible) hideInput();
  }, true);
  window.addEventListener('resize', function () {
    hideBubble();
    hideHover();
    hideInput();
  });

  // ---------- 自动翻译 / SPA ----------

  function scheduleModeRetranslate() {
    if (page.modeTimer) clearTimeout(page.modeTimer);
    page.modeTimer = setTimeout(function () {
      page.modeTimer = null;
      if (page.translating) { scheduleModeRetranslate(); return; }
      if (page.translated) translatePage(page.lastEngine || engineForDefault()).catch(function () {});
    }, 400);
  }

  function autoCheck() {
    if (!cfg) return;
    if (cfg.siteRule === 'never') return;
    const params = location.search || '';
    if (params.indexOf('aitoff=1') !== -1) return;
    const force = params.indexOf('aitauto=1') !== -1 || params.indexOf('hldauto=1') !== -1;
    if (!force && !cfg.autoTranslate && cfg.siteRule !== 'auto') return;
    setTimeout(function () {
      if (!page.translating && !page.translated) {
        translatePage(engineForDefault());
      }
    }, force ? 600 : 1300);
  }

  function watchUrl() {
    if (!IS_TOP) return;
    let last = location.pathname;
    setInterval(function () {
      const now = location.pathname;
      if (now === last) return;
      last = now;
      if (page.translated || page.inserted.length) restorePage(true);
      setTimeout(autoCheck, 900);
    }, 1200);
  }

  // ---------- 消息 ----------

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'page-translate') {
      translatePage(msg.engine).then(sendResponse).catch(function (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
      return true;
    }
    if (msg.type === 'page-restore') {
      sendResponse(restorePage(false));
      return false;
    }
    if (msg.type === 'page-status') {
      sendResponse({
        ok: true,
        translated: page.translated,
        translating: page.translating,
        count: page.count,
        engine: page.lastEngine,
        aiConfigured: !!(cfg && cfg.aiConfigured)
      });
      return false;
    }
    if (msg.type === 'translate-selection') {
      translateSelection(true, msg.engine);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'config-changed') {
      const prevMode = cfg ? cfg.displayMode : '';
      const prevTarget = cfg ? cfg.targetLang : '';
      const wasTranslated = page.translated || page.translating;
      cfg = msg.config || cfg;
      applyStyle();
      if (!cfg || !cfg.floating) {
        if (page.pillHost) page.pillHost.style.display = 'none';
      } else if (page.translated) {
        updatePill('done');
        if (cfg.dynamic) startObserver();
      }
      if (cfg && !cfg.selection) hideBubble();
      if (wasTranslated && cfg && (prevMode !== cfg.displayMode || prevTarget !== cfg.targetLang)) {
        scheduleModeRetranslate();
      }
      return false;
    }
    return false;
  });

  // ---------- 启动 ----------

  (async function init() {
    await askConfig();
    if (!cfg) return;
    applyStyle();
    watchUrl();
    autoCheck();
  })();
})();
