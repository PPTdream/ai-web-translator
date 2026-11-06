importScripts(
  'ai-translation-rules.js',
  'lib/constants.js',
  'lib/default-terms.js',
  'lib/termbase.js',
  'lib/engines.js',
  'lib/ai.js'
);

/* AI 网页翻译助手 - 后台服务
 * 免费通道：腾讯 / 微软 / Google / MyMemory 自动降级
 * AI 通道：OpenAI 兼容 / Gemini / Claude
 * 术语库：免费翻译用占位符保护，AI 翻译写入提示词
 */

const DEFAULTS = self.AIT_DEFAULT_SETTINGS;
const PRESETS = self.AIT_AI_PRESETS;
const TERM = self.AIT_Termbase;
const ENG = self.AIT_Engines;
const AI = self.AIT_AI;
const MSG = self.AIT_MSG;

const CACHE_KEY = 'ait_translation_cache_v1';
const CACHE_MAX = 5000;

let settingsCache = null;
let termbaseCache = null;
let matcherCache = null;
let cacheMap = null;
let cacheSaveTimer = null;
let cacheDirty = false;

// ---------- 小工具 ----------

function storageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (data) { resolve(data || {}); });
  });
}

function storageSet(obj) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(obj, function () { resolve(); });
  });
}

function clone(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
}

function domainOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch (e) { return ''; }
}

function matchSiteRule(rules, host) {
  if (!rules || !host) return '';
  const h = host.toLowerCase();
  if (rules[h]) return rules[h];
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (rules[d]) return rules[d];
  }
  return '';
}

// ---------- 设置 ----------

function normalizeSettings(raw) {
  const stored = raw || {};
  const s = Object.assign({}, DEFAULTS, stored);
  s.style = Object.assign({}, DEFAULTS.style, stored.style || {});
  s.siteRules = stored.siteRules && typeof stored.siteRules === 'object' ? stored.siteRules : {};
  s.aiTemperature = Math.max(0, Math.min(1.5, Number.isFinite(Number(s.aiTemperature)) ? Number(s.aiTemperature) : 0.2));
  s.aiBatch = Math.max(1, Math.min(20, Number(s.aiBatch) || 12));
  if (s.engine !== 'ai') s.engine = 'free';
  s.freeEngine = s.freeEngine || 'auto';
  if (!s.aiProvider || !PRESETS[s.aiProvider]) {
    s.aiProvider = 'opencode-go';
    s.aiBaseUrl = PRESETS['opencode-go'].baseUrl;
    s.aiModel = PRESETS['opencode-go'].model;
  }
  const preset = PRESETS[s.aiProvider] || PRESETS.custom;
  if (!s.aiBaseUrl) s.aiBaseUrl = preset.baseUrl || '';
  if (!s.aiModel) s.aiModel = preset.model || '';
  return s;
}

async function loadSettings(force) {
  if (settingsCache && !force) return settingsCache;
  const data = await storageGet(['settings', 'autoSelect']);
  let raw = data.settings;
  let migrated = false;
  if (!raw) {
    raw = clone(DEFAULTS);
    if (typeof data.autoSelect === 'boolean') {
      raw.selection = data.autoSelect;
      migrated = true;
    }
    settingsCache = normalizeSettings(raw);
    if (!settingsCache.opencodeSession) {
      settingsCache.opencodeSession = 'ait-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    await storageSet({ settings: settingsCache });
    return settingsCache;
  }
  settingsCache = normalizeSettings(raw);
  if (!settingsCache.opencodeSession) {
    settingsCache.opencodeSession = 'ait-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    await storageSet({ settings: settingsCache });
  }
  return settingsCache;
}

function publicSettings(settings, host) {
  const s = normalizeSettings(settings);
  return {
    targetLang: s.targetLang,
    displayMode: s.displayMode,
    engine: s.engine,
    freeEngine: s.freeEngine,
    autoTranslate: s.autoTranslate,
    dynamic: s.dynamic,
    floating: s.floating,
    selection: s.selection,
    hover: s.hover,
    inputBox: s.inputBox,
    skipSelectors: s.skipSelectors,
    style: s.style,
    siteRule: host ? matchSiteRule(s.siteRules, host) : '',
    aiConfigured: AI.isReady(s),
    aiProvider: s.aiProvider,
    aiModel: s.aiModel,
    termCount: termbaseCache ? termbaseCache.entries.length : 0
  };
}

// ---------- 术语库 ----------

async function loadTermbase(force) {
  if (termbaseCache && !force) return termbaseCache;
  const data = await storageGet(['termbase']);
  let tb = null;
  if (!data.termbase) {
    tb = { version: 1, updatedAt: Date.now(), entries: TERM.defaultEntries() };
    await storageSet({ termbase: tb });
  } else {
    tb = TERM.normalizeTermbase(data.termbase);
  }
  termbaseCache = tb;
  matcherCache = null;
  return tb;
}

async function getMatcher() {
  const tb = await loadTermbase();
  const version = String(tb.updatedAt || '');
  if (!matcherCache || matcherCache.__version !== version) {
    matcherCache = TERM.makeMatcher(tb.entries);
    matcherCache.__version = version;
  }
  return matcherCache;
}

// ---------- 缓存 ----------

async function loadCache() {
  if (cacheMap) return cacheMap;
  const data = await storageGet([CACHE_KEY]);
  cacheMap = data[CACHE_KEY] && typeof data[CACHE_KEY] === 'object' ? data[CACHE_KEY] : {};
  return cacheMap;
}

function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(function () {
    cacheSaveTimer = null;
    if (!cacheDirty || !cacheMap) return;
    cacheDirty = false;
    const obj = {};
    obj[CACHE_KEY] = cacheMap;
    storageSet(obj);
  }, 3500);
}

function pruneCache() {
  if (!cacheMap) return;
  const keys = Object.keys(cacheMap);
  if (keys.length <= CACHE_MAX) return;
  keys.sort(function (a, b) {
    return (cacheMap[a].ts || 0) - (cacheMap[b].ts || 0);
  });
  const remove = keys.length - CACHE_MAX;
  for (let i = 0; i < remove; i++) delete cacheMap[keys[i]];
}

function cacheKeyFor(text, kind, target, settings, domain) {
  const model = kind === 'ai'
    ? (settings.aiProvider + ':' + settings.aiModel + ':' + settings.aiBaseUrl + ':' + TERM.hashString(settings.customPrompt || ''))
    : settings.freeEngine;
  const contextKey = kind === 'ai' ? String(domain || '') : '';
  const parts = [kind, target, model];
  if (kind === 'ai') parts.push(contextKey);
  parts.push(matcherCache ? matcherCache.version : '0', TERM.hashString(text), text.length);
  return parts.join('|');
}

async function cacheGet(key) {
  const map = await loadCache();
  const item = map[key];
  return item && typeof item.t === 'string' ? item.t : null;
}

async function cacheSet(key, text) {
  if (!key) return;
  const map = await loadCache();
  map[key] = { t: text, ts: Date.now() };
  pruneCache();
  scheduleCacheSave();
}

// ---------- 翻译 ----------

function cjkCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

function looksPoor(src, out, target) {
  const s = String(src || '');
  const o = String(out || '');
  if (!o.trim()) return true;
  if (o.trim() === s.trim()) return true;
  if (!String(target).startsWith('zh')) return false;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 6) return false;
  const urlChars = (s.match(/https?:\/\/\S+/g) || []).join('').length;
  if (urlChars > s.length * 0.45) return false;
  const cjk = cjkCount(o);
  if (cjk === 0 && letters > 8) return true;
  if (cjk / Math.max(1, o.length) < 0.06 && letters > 8) return true;
  if (o.length < s.length * 0.16 && s.length > 36) return true;
  const run = o.match(/[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){6,}/);
  if (run && s.toLowerCase().indexOf(run[0].toLowerCase()) !== -1) return true;
  return false;
}

async function translateFreeWithTerms(texts, settings, target) {
  const isZh = String(target).startsWith('zh');
  let masked = texts;
  let masks = null;
  if (isZh) {
    const matcher = await getMatcher();
    if (matcher && matcher.re) {
      masks = texts.map(function (t) { return TERM.maskText(t, matcher); });
      masked = masks.map(function (m) { return m.masked; });
    }
  }
  const out = await ENG.translateFree(masked, {
    target: target,
    engine: settings.freeEngine || 'auto'
  });
  if (!masks) return out;
  return out.map(function (t, i) {
    return TERM.restoreMasks(t, masks[i] ? masks[i].terms : []);
  });
}

async function translateAll(texts, opts) {
  const options = opts || {};
  const settings = await loadSettings();
  await loadTermbase();
  await getMatcher();
  await loadCache();

  const list = (Array.isArray(texts) ? texts : []).map(function (t) {
    return String(t == null ? '' : t);
  });
  const out = new Array(list.length).fill('');
  const target = settings.targetLang || options.target || 'zh-CN';
  const engine = options.engine === 'ai' || options.engine === 'free'
    ? options.engine
    : (settings.engine || 'free');
  const context = {
    domain: String(options.context && options.context.domain || '').slice(0, 120),
    title: String(options.context && options.context.title || '').slice(0, 300),
    url: String(options.context && options.context.url || '').slice(0, 500),
    entries: termbaseCache ? termbaseCache.entries : []
  };
  const warnings = [];

  const missIndexes = [];
  const missTexts = [];
  const keys = new Array(list.length).fill('');
  const cacheEnabled = settings.cacheEnabled !== false && !options.noCache;
  for (let i = 0; i < list.length; i++) {
    if (!list[i].trim()) continue;
    if (cacheEnabled) {
      keys[i] = cacheKeyFor(list[i], engine, target, settings, context.domain);
      const hit = await cacheGet(keys[i]);
      if (hit != null) out[i] = hit;
      else { missIndexes.push(i); missTexts.push(list[i]); }
    } else {
      missIndexes.push(i);
      missTexts.push(list[i]);
    }
  }

  if (!engine || engine === 'free') {
    if (missTexts.length) {
      try {
        const translated = await translateFreeWithTerms(missTexts, settings, target);
        for (let i = 0; i < translated.length; i++) {
          const idx = missIndexes[i];
          out[idx] = translated[i] || '';
          if (out[idx]) cacheSet(keys[idx], out[idx]);
        }
        // 自动 AI 补译疑似失败的段落
        if (settings.autoUpgrade && AI.isReady(settings)) {
          const bad = [];
          for (const idx of missIndexes) {
            if (looksPoor(list[idx], out[idx], target)) bad.push(idx);
          }
          if (bad.length && bad.length <= 40) {
            try {
              const res = await AI.translateAI(bad.map(function (i) { return list[i]; }), settings, context);
              let fixed = 0;
              for (let k = 0; k < bad.length; k++) {
                const t = res.translations[k];
                if (t && !looksPoor(list[bad[k]], t, target)) {
                  out[bad[k]] = t;
                  cacheSet(keys[bad[k]], t);
                  fixed++;
                }
              }
              if (fixed) warnings.push('已自动用 AI 精译 ' + fixed + ' 段');
            } catch (e) { /* 自动补译失败不阻塞 */ }
          }
        }
      } catch (e) {
        if (AI.isReady(settings) && settings.autoUpgrade) {
          try {
            const res = await AI.translateAI(missTexts, settings, context);
            for (let i = 0; i < res.translations.length; i++) {
              out[missIndexes[i]] = res.translations[i] || '';
              if (out[missIndexes[i]]) cacheSet(keys[missIndexes[i]], out[missIndexes[i]]);
            }
            warnings.push('免费通道失败，已自动改用 AI');
          } catch (e2) {
            throw new Error('免费翻译失败：' + (e && e.message ? e.message : e) +
              '；AI 备用通道也失败：' + (e2 && e2.message ? e2.message : e2));
          }
        } else {
          throw new Error('免费翻译通道暂时不可用：' + (e && e.message ? e.message : e) +
            '。可在设置里配置 AI 精译作为备用。');
        }
      }
    }
  } else {
    if (!AI.isReady(settings)) {
      throw new Error('AI 尚未配置。请打开设置填写 API Key、接口地址和模型，或改用免费翻译。');
    }
    if (missTexts.length) {
      const res = await AI.translateAI(missTexts, settings, context);
      for (let i = 0; i < res.translations.length; i++) {
        out[missIndexes[i]] = res.translations[i] || '';
        if (out[missIndexes[i]]) cacheSet(keys[missIndexes[i]], out[missIndexes[i]]);
      }
      if (res.errors && res.errors.length) warnings.push('AI 有 ' + res.errors.length + ' 批未完成');
      // AI 个别批次失败时，用免费通道补空白，避免整页缺失
      const blanks = [];
      const blankTexts = [];
      for (const idx of missIndexes) {
        if (!out[idx] && list[idx].trim()) { blanks.push(idx); blankTexts.push(list[idx]); }
      }
      if (blankTexts.length) {
        try {
          const freeOut = await translateFreeWithTerms(blankTexts, settings, target);
          let filled = 0;
          for (let i = 0; i < blanks.length; i++) {
            if (freeOut[i]) {
              out[blanks[i]] = freeOut[i];
              cacheSet(keys[blanks[i]], freeOut[i]);
              filled++;
            }
          }
          if (filled) warnings.push('有 ' + filled + ' 段已用免费通道补译');
        } catch (e) { /* 忽略 */ }
      }
    }
  }

  return {
    ok: true,
    translations: out,
    engineUsed: engine,
    warnings: warnings,
    aiConfigured: AI.isReady(settings)
  };
}

// ---------- 页面命令 ----------

function sendTabMessage(tabId, message, frameId) {
  return new Promise(function (resolve, reject) {
    const options = { frameId: typeof frameId === 'number' ? frameId : 0 };
    chrome.tabs.sendMessage(tabId, message, options, function (res) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function ensureContent(tabId) {
  try {
    const res = await sendTabMessage(tabId, { type: 'page-status' });
    if (res) return true;
  } catch (e) { /* 需要注入 */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
    await new Promise(function (r) { setTimeout(r, 150); });
    return true;
  } catch (e) {
    return false;
  }
}

async function runPageCommand(tabId, message) {
  const ok = await ensureContent(tabId);
  if (!ok) throw new Error('此页面不支持翻译（浏览器内置页、扩展商店页等）');
  return await sendTabMessage(tabId, message);
}

function openOptions(params) {
  let url = chrome.runtime.getURL('options.html');
  if (params && Object.keys(params).length) {
    url += '?' + new URLSearchParams(params).toString();
  }
  chrome.tabs.create({ url: url });
}

// ---------- 徽标 ----------

function setBadge(tabId, text, color) {
  if (tabId == null) return;
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: text || '' });
    if (text && color) chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
  } catch (e) { /* 标签页可能已关闭 */ }
}

// ---------- 右键菜单 ----------

function createMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'ait-free-page',
      title: '翻译此页面（免费）',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'ait-ai-page',
      title: 'AI 精译此页面',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'ait-sel',
      title: '翻译选中文字（免费）',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'ait-sel-ai',
      title: 'AI 精译选中文字',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'ait-add-term',
      title: '将选中文字加入术语库…',
      contexts: ['selection']
    });
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'ait-free-page' || info.menuItemId === 'ait-ai-page') {
    const engine = info.menuItemId === 'ait-ai-page' ? 'ai' : 'free';
    runPageCommand(tab.id, { type: 'page-translate', engine: engine }).catch(function (e) {
      setBadge(tab.id, '!', '#d93025');
    });
    return;
  }
  if (info.menuItemId === 'ait-sel' || info.menuItemId === 'ait-sel-ai') {
    const engine = info.menuItemId === 'ait-sel-ai' ? 'ai' : 'free';
    sendTabMessage(tab.id, { type: 'translate-selection', engine: engine }, info.frameId).catch(function () {
      runPageCommand(tab.id, { type: 'translate-selection', engine: engine }).catch(function () {});
    });
    return;
  }
  if (info.menuItemId === 'ait-add-term') {
    const text = String(info.selectionText || '').trim().slice(0, 200);
    if (!text) return;
    chrome.storage.local.set({
      pendingTerm: {
        text: text,
        url: tab.url || '',
        ts: Date.now()
      }
    }, function () {
      openOptions({ tab: 'termbase', add: '1' });
    });
  }
});

// ---------- 快捷键 ----------

chrome.commands.onCommand.addListener(function (command, tab) {
  if (!tab || !tab.id) return;
  if (command === 'toggle-translate') {
    sendTabMessage(tab.id, { type: 'page-status' }).then(function (res) {
      const msg = res && res.translated ? { type: 'page-restore' } : { type: 'page-translate' };
      return runPageCommand(tab.id, msg);
    }).catch(function () {});
  } else if (command === 'ai-refine') {
    runPageCommand(tab.id, { type: 'page-translate', engine: 'ai' }).catch(function () {
      setBadge(tab.id, '!', '#d93025');
    });
  } else if (command === 'translate-selection') {
    sendTabMessage(tab.id, { type: 'translate-selection' }).catch(function () {});
  }
});

// ---------- 消息 ----------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'translate') {
    translateAll(msg.texts, msg)
      .then(function (res) { sendResponse(res); })
      .catch(function (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true;
  }

  if (msg.type === 'get-config') {
    (async function () {
      const settings = await loadSettings();
      await loadTermbase();
      const host = (sender && sender.tab && sender.tab.url) ? domainOf(sender.tab.url) : (msg.host || '');
      sendResponse({ ok: true, config: publicSettings(settings, host) });
    })();
    return true;
  }

  if (msg.type === 'ai-test') {
    (async function () {
      try {
        await loadTermbase();
        const s = normalizeSettings(msg.settings || {});
        const res = await AI.test(s);
        sendResponse({ ok: true, result: res });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }

  if (msg.type === 'open-options') {
    openOptions(msg.params || {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'page-state') {
    if (sender && sender.tab && sender.tab.id != null) {
      if (msg.translating) setBadge(sender.tab.id, '…', '#1a73e8');
      else if (msg.translated) setBadge(sender.tab.id, '译', '#1a73e8');
      else setBadge(sender.tab.id, '', '#1a73e8');
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'clear-cache') {
    (async function () {
      const map = await loadCache();
      const count = Object.keys(map).length;
      cacheMap = {};
      cacheDirty = false;
      if (cacheSaveTimer) { clearTimeout(cacheSaveTimer); cacheSaveTimer = null; }
      const obj = {}; obj[CACHE_KEY] = {};
      await storageSet(obj);
      sendResponse({ ok: true, count: count });
    })();
    return true;
  }

  if (msg.type === 'get-stats') {
    (async function () {
      const settings = await loadSettings();
      const tb = await loadTermbase();
      const map = await loadCache();
      sendResponse({
        ok: true,
        termCount: tb.entries.length,
        enabledTermCount: tb.entries.filter(function (e) { return e.enabled; }).length,
        cacheCount: Object.keys(map).length,
        aiConfigured: AI.isReady(settings),
        provider: settings.aiProvider,
        model: settings.aiModel
      });
    })();
    return true;
  }

  if (msg.type === 'add-term') {
    (async function () {
      const tb = await loadTermbase();
      const entry = TERM.sanitizeEntry({
        source: msg.source,
        target: msg.target || msg.source,
        policy: msg.policy || 'keep',
        category: msg.category || '自定义',
        note: msg.note || ''
      });
      if (!entry) { sendResponse({ ok: false, error: '术语不能为空' }); return; }
      const dup = tb.entries.find(function (e) {
        return e.source.toLowerCase() === entry.source.toLowerCase() && e.policy === entry.policy;
      });
      if (dup) {
        dup.target = entry.target;
        dup.category = entry.category;
        dup.note = entry.note;
        dup.enabled = true;
      } else {
        tb.entries.push(entry);
      }
      tb.updatedAt = Date.now();
      termbaseCache = tb;
      matcherCache = null;
      await storageSet({ termbase: tb });
      sendResponse({ ok: true, count: tb.entries.length, updated: !!dup });
    })();
    return true;
  }

  if (msg.type === 'translate-selection') {
    sendResponse({ ok: true });
    return false;
  }
});

// ---------- 存储变化 ----------

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.settings) {
    settingsCache = normalizeSettings(changes.settings.newValue);
    loadTermbase().then(function (tb) {
      const base = publicSettings(settingsCache, '');
      base.termCount = tb.entries.length;
      chrome.tabs.query({}, function (tabs) {
        for (const t of tabs) {
          if (!t.id) continue;
          const cfg = Object.assign({}, base, { siteRule: matchSiteRule(settingsCache.siteRules, domainOf(t.url || '')) });
          chrome.tabs.sendMessage(t.id, { type: 'config-changed', config: cfg }, function () {
            if (chrome.runtime.lastError) { /* 忽略无内容脚本的页面 */ }
          });
        }
      });
    });
  }
  if (changes.termbase) {
    termbaseCache = TERM.normalizeTermbase(changes.termbase.newValue);
    matcherCache = null;
  }
});

// ---------- 生命周期 ----------

async function initializeStorage() {
  await loadSettings(true);
  await loadTermbase(true);
}

chrome.runtime.onInstalled.addListener(function (details) {
  initializeStorage().then(function () {
    createMenus();
    if (details.reason === 'install') {
      openOptions({ welcome: '1' });
    }
  });
});

chrome.runtime.onStartup.addListener(function () {
  createMenus();
  initializeStorage().catch(function () {});
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === 'loading') setBadge(tabId, '', '#1a73e8');
});

// 服务启动时确保有默认数据（不阻塞消息）
initializeStorage().catch(function () {});
