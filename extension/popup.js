(function () {
  const $ = function (id) { return document.getElementById(id); };
  const TARGETS = window.AIT_TARGETS || [];
  const DEFAULTS = window.AIT_DEFAULT_SETTINGS || {};

  let activeTab = null;
  let host = '';
  let cfg = null;
  let settings = null;
  let translated = false;
  let busy = false;

  function setStatus(text, cls, showAction) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'status' + (cls ? ' ' + cls : '');
    $('status-action').hidden = !showAction;
  }

  function setBadge() {
    const badge = $('engine-badge');
    if (!cfg) { badge.textContent = '读取中'; badge.className = 'badge'; return; }
    if (settings && settings.engine === 'ai' && !cfg.aiConfigured) {
      badge.textContent = 'AI 未配置';
      badge.className = 'badge warn';
    } else if (cfg.aiConfigured) {
      badge.textContent = 'AI 就绪';
      badge.className = 'badge ai';
    } else {
      badge.textContent = '免费通道';
      badge.className = 'badge free';
    }
  }

  function updateButtons() {
    const primary = $('btn-translate');
    const alt = $('btn-alt');
    if (!activeTab || !/^https?:|^file:/i.test(activeTab.url || '')) {
      primary.disabled = true;
      alt.disabled = true;
      return;
    }
    if (busy) {
      primary.disabled = true;
      alt.disabled = true;
      return;
    }
    primary.disabled = false;
    alt.disabled = false;
    primary.textContent = translated ? '还原原文' : '翻译此页';

    if (!cfg) { alt.textContent = 'AI 精译'; return; }
    if (settings && settings.engine === 'ai') alt.textContent = '免费翻译';
    else alt.textContent = 'AI 精译';
    if (!cfg.aiConfigured && (!settings || settings.engine !== 'ai')) {
      alt.title = '需要先在设置中配置 AI API';
    } else {
      alt.title = '';
    }
  }

  function fillSelects() {
    const target = $('target');
    target.innerHTML = '';
    for (const t of TARGETS) {
      const o = document.createElement('option');
      o.value = t.code;
      o.textContent = t.label;
      target.appendChild(o);
    }
    if (settings) {
      target.value = settings.targetLang || 'zh-CN';
      $('mode').value = settings.displayMode || 'below';
      $('selection').checked = settings.selection !== false;
      $('dynamic').checked = settings.dynamic !== false;
      $('auto-site').checked = !!(cfg && cfg.siteRule === 'auto');
    }
  }

  function sendBg(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }

  function sendTab(message, inject) {
    return new Promise(function (resolve) {
      if (!activeTab || activeTab.id == null) { resolve(null); return; }
      chrome.tabs.sendMessage(activeTab.id, message, { frameId: 0 }, function (res) {
        if (chrome.runtime.lastError || !res) {
          if (!inject) { resolve(null); return; }
          chrome.scripting.executeScript(
            { target: { tabId: activeTab.id }, files: ['content.js'] },
            function () {
              if (chrome.runtime.lastError) { resolve(null); return; }
              setTimeout(function () {
                chrome.tabs.sendMessage(activeTab.id, message, { frameId: 0 }, function (res2) {
                  if (chrome.runtime.lastError) resolve(null);
                  else resolve(res2 || null);
                });
              }, 160);
            }
          );
          return;
        }
        resolve(res);
      });
    });
  }

  async function loadSettings() {
    let data = {};
    try { data = await chrome.storage.local.get('settings'); } catch (e) { data = {}; }
    settings = Object.assign({}, DEFAULTS, data.settings || {});
    settings.style = Object.assign({}, DEFAULTS.style || {}, (data.settings && data.settings.style) || {});
    settings.siteRules = (data.settings && data.settings.siteRules) || {};
    if (!settings.opencodeSession) {
      settings.opencodeSession = 'ait-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { await chrome.storage.local.set({ settings: settings }); } catch (e) { /* 忽略 */ }
    }
  }

  async function saveSettings(patch) {
    const data = await chrome.storage.local.get('settings');
    const next = Object.assign({}, DEFAULTS, data.settings || {}, patch);
    next.style = Object.assign({}, DEFAULTS.style || {}, (data.settings && data.settings.style) || {}, patch.style || {});
    if (patch.siteRules) next.siteRules = patch.siteRules;
    await chrome.storage.local.set({ settings: next });
    settings = next;
  }

  function openOptions(params) {
    let url = chrome.runtime.getURL('options.html');
    if (params && Object.keys(params).length) url += '?' + new URLSearchParams(params).toString();
    chrome.tabs.create({ url: url });
  }

  function unsupported() {
    $('site').textContent = '浏览器内置页 / 扩展商店页';
    setStatus('此页面不支持翻译', 'err', false);
    $('term-count').textContent = '—';
    $('auto-site').disabled = true;
    updateButtons();
  }

  async function refreshStatus() {
    const res = await sendTab({ type: 'page-status' }, true);
    if (!res || !res.ok) {
      translated = false;
      updateButtons();
      return;
    }
    translated = !!res.translated;
    if (res.aiConfigured != null && cfg) cfg.aiConfigured = res.aiConfigured;
    updateButtons();
    if (translated) setStatus('已翻译 ' + (res.count || 0) + ' 段', 'ok', false);
    else if (res.translating) setStatus('翻译中…', '', false);
    else setStatus('就绪', '', false);
  }

  async function init() {
    fillSelects();
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = tabs && tabs[0] ? tabs[0] : null;
    } catch (e) { activeTab = null; }

    if (!activeTab || !/^https?:|^file:/i.test(activeTab.url || '')) {
      unsupported();
      return;
    }

    try { host = new URL(activeTab.url).hostname.replace(/^www\./i, ''); } catch (e) { host = ''; }
    $('site').textContent = host || activeTab.url || '当前页面';
    if (!host) $('auto-site').disabled = true;

    await loadSettings();
    const conf = await sendBg({ type: 'get-config', host: host });
    if (conf && conf.ok) cfg = conf.config;
    if (!cfg) cfg = {
      aiConfigured: false,
      siteRule: settings.siteRules[host] || '',
      termCount: 0
    };

    if (!cfg.termCount && cfg.termCount !== 0) {
      const stats = await sendBg({ type: 'get-stats' });
      if (stats && stats.ok) cfg.termCount = stats.termCount;
    }

    $('term-count').textContent = cfg.termCount != null ? cfg.termCount : '—';
    $('auto-site').checked = cfg.siteRule === 'auto';
    $('selection').checked = settings.selection !== false;
    $('dynamic').checked = settings.dynamic !== false;
    $('target').value = settings.targetLang || 'zh-CN';
    $('mode').value = settings.displayMode || 'below';
    setBadge();
    updateButtons();
    await refreshStatus();
  }

  // ---------- 事件 ----------

  $('btn-translate').addEventListener('click', async function () {
    if (busy || !activeTab) return;
    if (translated) {
      busy = true;
      updateButtons();
      const res = await sendTab({ type: 'page-restore' }, true);
      busy = false;
      translated = false;
      updateButtons();
      setStatus(res && res.ok ? '已还原原文' : '还原失败', res && res.ok ? 'ok' : 'err', false);
      return;
    }

    const engine = settings && settings.engine === 'ai' ? 'ai' : 'free';
    if (engine === 'ai' && cfg && !cfg.aiConfigured) {
      setStatus('请先配置 AI API', 'err', true);
      return;
    }

    busy = true;
    $('btn-translate').textContent = '翻译中…';
    updateButtons();
    setStatus('正在翻译，请稍候…', '', false);
    const res = await sendTab({ type: 'page-translate', engine: engine }, true);
    busy = false;
    if (res && res.ok) {
      translated = !!(res.count > 0);
      updateButtons();
      if (res.count > 0) {
        let text = '已翻译 ' + res.count + ' 段';
        if (res.errors && res.errors.length) text += ' · ' + res.errors.length + ' 批失败';
        if (res.warnings && res.warnings.length) text += ' · ' + res.warnings[0];
        setStatus(text, 'ok', false);
      } else {
        setStatus((res.message || '本页没有需要翻译的内容'), 'ok', false);
      }
    } else {
      updateButtons();
      const msg = (res && res.error) || '翻译失败';
      setStatus(msg, 'err', /AI|配置|Key/i.test(msg));
    }
  });

  $('btn-alt').addEventListener('click', async function () {
    if (busy || !activeTab) return;
    const altEngine = settings && settings.engine === 'ai' ? 'free' : 'ai';
    if (altEngine === 'ai' && cfg && !cfg.aiConfigured) {
      setStatus('AI 尚未配置，点右侧「去设置」', 'err', true);
      return;
    }
    busy = true;
    $('btn-alt').textContent = altEngine === 'ai' ? 'AI 精译中…' : '翻译中…';
    updateButtons();
    setStatus(altEngine === 'ai' ? 'AI 正在精译整页…' : '正在用免费通道翻译…', '', false);
    const res = await sendTab({ type: 'page-translate', engine: altEngine }, true);
    busy = false;
    if (res && res.ok && res.count > 0) translated = true;
    updateButtons();
    if (res && res.ok && res.count > 0) {
      translated = true;
      let text = (altEngine === 'ai' ? 'AI 已精译 ' : '已翻译 ') + res.count + ' 段';
      if (res.errors && res.errors.length) text += ' · ' + res.errors.length + ' 批失败';
      if (res.warnings && res.warnings.length) text += ' · ' + res.warnings[0];
      setStatus(text, 'ok', false);
    } else if (res && res.ok) {
      setStatus(res.message || '没有需要翻译的内容', 'ok', false);
    } else {
      const msg = (res && res.error) || '翻译失败';
      setStatus(msg, 'err', /AI|配置|Key/i.test(msg));
    }
  });

  $('status-action').addEventListener('click', function () {
    openOptions({ tab: 'ai' });
  });

  $('open-settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  $('manage-terms').addEventListener('click', function () {
    openOptions({ tab: 'termbase' });
  });

  $('help').addEventListener('click', function () {
    openOptions({ tab: 'help' });
  });

  $('target').addEventListener('change', async function () {
    await saveSettings({ targetLang: $('target').value });
    if (translated) setStatus('已保存，重新翻译后生效', '', false);
    else setStatus('目标语言已保存', 'ok', false);
  });

  $('mode').addEventListener('change', async function () {
    await saveSettings({ displayMode: $('mode').value });
    if (translated) setStatus('已保存，重新翻译后生效', '', false);
    else setStatus('显示方式已保存', 'ok', false);
  });

  $('selection').addEventListener('change', async function () {
    await saveSettings({ selection: $('selection').checked });
    setStatus($('selection').checked ? '已开启划词翻译' : '已关闭划词翻译', 'ok', false);
  });

  $('dynamic').addEventListener('change', async function () {
    await saveSettings({ dynamic: $('dynamic').checked });
    setStatus($('dynamic').checked ? '已开启动态内容翻译' : '已关闭动态内容翻译', 'ok', false);
  });

  $('auto-site').addEventListener('change', async function () {
    const rules = Object.assign({}, settings.siteRules || {});
    if ($('auto-site').checked) rules[host] = 'auto';
    else delete rules[host];
    await saveSettings({ siteRules: rules });
    if (cfg) cfg.siteRule = rules[host] || '';
    if ($('auto-site').checked) {
      setStatus('本站已设为打开后自动翻译', 'ok', false);
      if (!translated && !busy) {
        // 立即翻译一次，用户不用再点按钮
        busy = true;
        updateButtons();
        const res = await sendTab({ type: 'page-translate', engine: (settings.engine === 'ai' && cfg.aiConfigured) ? 'ai' : 'free' }, true);
        busy = false;
        if (res && res.ok && res.count > 0) {
          translated = true;
          setStatus('已翻译 ' + res.count + ' 段', 'ok', false);
        }
        updateButtons();
      }
    } else {
      setStatus('已取消本站自动翻译', '', false);
    }
  });

  init().catch(function (e) {
    setStatus('初始化失败，请刷新页面后重试', 'err', false);
  });
})();
