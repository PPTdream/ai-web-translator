(function () {
  const $ = function (id) { return document.getElementById(id); };
  const TB = window.AIT_Termbase;
  const TARGETS = window.AIT_TARGETS || [];
  const PRESETS = window.AIT_AI_PRESETS || {};
  const FREE_ENGINES = window.AIT_FREE_ENGINES || [];
  const DEFAULTS = window.AIT_DEFAULT_SETTINGS || {};

  let settings = null;
  let termbase = null;
  let currentTab = 'general';
  let saveTimer = null;
  let termSaveTimer = null;

  let termPage = 1;
  const termPageSize = 50;
  let termQuery = '';
  let termCat = '';
  let importParsed = [];
  let importFileName = '';
  let resetting = false;

  const TITLES = {
    general: ['通用设置', '决定默认怎么翻、翻成什么样'],
    ai: ['AI 引擎', '接上你的订阅，需要精译时再使用'],
    termbase: ['术语库', '免费翻译和 AI 翻译都会遵守这里'],
    sites: ['站点规则', '哪些网站打开就翻译，哪些永远不自动翻译'],
    data: ['数据与备份', '缓存、导入导出与重置'],
    help: ['使用帮助', '三分钟上手']
  };

  // ---------- 基础 ----------

  function clone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function setSaveState(text, cls) {
    const el = $('save-state');
    el.textContent = text;
    el.className = 'save-state' + (cls ? ' ' + cls : '');
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

  function fillSelect(el, items, value) {
    el.innerHTML = '';
    for (const item of items) {
      const o = document.createElement('option');
      o.value = item.value != null ? item.value : item.code;
      o.textContent = item.label;
      el.appendChild(o);
    }
    if (value != null) el.value = value;
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      const self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }

  async function loadAll() {
    let data = {};
    try { data = await chrome.storage.local.get(['settings', 'termbase']); } catch (e) { data = {}; }

    settings = clone(DEFAULTS);
    if (data.settings) {
      settings = Object.assign(settings, data.settings);
      settings.style = Object.assign({}, DEFAULTS.style || {}, data.settings.style || {});
      settings.siteRules = data.settings.siteRules || {};
    }
    if (!PRESETS[settings.aiProvider]) {
      settings.aiProvider = 'opencode-go';
      settings.aiBaseUrl = PRESETS['opencode-go'].baseUrl;
      settings.aiModel = PRESETS['opencode-go'].model;
    }
    if (!settings.opencodeSession) {
      settings.opencodeSession = 'ait-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      await chrome.storage.local.set({ settings: settings });
    }
    if (!settings.aiBaseUrl) {
      const p = PRESETS[settings.aiProvider] || PRESETS.custom;
      settings.aiBaseUrl = p.baseUrl || '';
    }
    if (!settings.aiModel) {
      const p = PRESETS[settings.aiProvider] || PRESETS.custom;
      settings.aiModel = p.model || '';
    }

    if (data.termbase) {
      termbase = TB.normalizeTermbase(data.termbase);
    } else {
      termbase = { version: 1, updatedAt: Date.now(), entries: TB.defaultEntries() };
      await chrome.storage.local.set({ termbase: termbase });
    }
    if (!data.settings) {
      await chrome.storage.local.set({ settings: settings });
    }
  }

  function queueSettings(patch) {
    if (!patch) return;
    if (patch.style) {
      settings.style = Object.assign({}, settings.style || {}, patch.style);
    }
    for (const k in patch) {
      if (k !== 'style') settings[k] = patch[k];
    }
    setSaveState('保存中…', 'saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, 320);
  }

  async function flushSettings() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
      await chrome.storage.local.set({ settings: settings });
      setSaveState('已自动保存');
    } catch (e) {
      setSaveState('保存失败，请重试', 'error');
    }
  }

  function queueTermSave(immediate) {
    termbase.updatedAt = Date.now();
    setSaveState('保存中…', 'saving');
    if (termSaveTimer) { clearTimeout(termSaveTimer); termSaveTimer = null; }
    const doSave = async function () {
      try {
        await chrome.storage.local.set({ termbase: termbase });
        setSaveState('已自动保存');
      } catch (e) {
        setSaveState('术语库保存失败', 'error');
      }
    };
    if (immediate) doSave();
    else termSaveTimer = setTimeout(doSave, 380);
  }

  // ---------- 导航 ----------

  function activate(tab) {
    if (!TITLES[tab]) tab = 'general';
    currentTab = tab;
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + tab);
    });
    $('page-title').textContent = TITLES[tab][0];
    $('page-sub').textContent = TITLES[tab][1];
    try { history.replaceState(null, '', location.pathname + '?tab=' + tab); } catch (e) { /* 忽略 */ }
    if (tab === 'data') refreshCacheCount();
  }

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { activate(btn.getAttribute('data-tab')); });
  });
  document.querySelectorAll('.jump').forEach(function (btn) {
    btn.addEventListener('click', function () { activate(btn.getAttribute('data-jump')); });
  });

  // ---------- 通用 ----------

  function renderGeneral() {
    fillSelect($('set-target'), TARGETS.map(function (t) { return { value: t.code, label: t.label }; }), settings.targetLang);
    fillSelect($('set-free-engine'), FREE_ENGINES.map(function (e) { return { value: e.id, label: e.label }; }), settings.freeEngine);
    $('set-engine').value = settings.engine || 'free';
    $('set-mode').value = settings.displayMode || 'below';
    $('set-auto').checked = !!settings.autoTranslate;
    $('set-auto-2').checked = !!settings.autoTranslate;
    $('set-dynamic').checked = settings.dynamic !== false;
    $('set-floating').checked = settings.floating !== false;
    $('set-selection').checked = settings.selection !== false;
    $('set-hover').checked = !!settings.hover;
    $('set-input').checked = settings.inputBox !== false;
    $('set-cache').checked = settings.cacheEnabled !== false;

    const st = settings.style || {};
    $('set-color').value = st.color || '#1a73e8';
    $('set-size').value = st.size || 0.94;
    $('size-val').textContent = Math.round((Number(st.size) || 0.94) * 100) + '%';
    $('set-separator').value = st.separator ? '1' : '0';
    $('set-theme').value = st.theme || 'auto';
    $('set-skip').value = settings.skipSelectors || '';
  }

  function bindGeneral() {
    $('set-engine').addEventListener('change', function () {
      queueSettings({ engine: $('set-engine').value });
    });
    $('set-target').addEventListener('change', function () {
      queueSettings({ targetLang: $('set-target').value });
    });
    $('set-mode').addEventListener('change', function () {
      queueSettings({ displayMode: $('set-mode').value });
    });
    $('set-free-engine').addEventListener('change', function () {
      queueSettings({ freeEngine: $('set-free-engine').value });
    });

    function bindCheck(id, key) {
      $(id).addEventListener('change', function () {
        const v = $(id).checked;
        queueSettings({ [key]: v });
        if (key === 'autoTranslate') $('set-auto-2').checked = v;
      });
    }
    bindCheck('set-auto', 'autoTranslate');
    bindCheck('set-dynamic', 'dynamic');
    bindCheck('set-floating', 'floating');
    bindCheck('set-selection', 'selection');
    bindCheck('set-hover', 'hover');
    bindCheck('set-input', 'inputBox');
    bindCheck('set-cache', 'cacheEnabled');

    $('set-color').addEventListener('input', function () {
      queueSettings({ style: { color: $('set-color').value } });
    });
    document.querySelectorAll('.swatches button').forEach(function (b) {
      b.addEventListener('click', function () {
        const c = b.getAttribute('data-color');
        $('set-color').value = c;
        queueSettings({ style: { color: c } });
      });
    });
    $('set-size').addEventListener('input', function () {
      const v = Number($('set-size').value);
      $('size-val').textContent = Math.round(v * 100) + '%';
      queueSettings({ style: { size: v } });
    });
    $('set-separator').addEventListener('change', function () {
      queueSettings({ style: { separator: $('set-separator').value === '1' } });
    });
    $('set-theme').addEventListener('change', function () {
      queueSettings({ style: { theme: $('set-theme').value } });
    });
    $('set-skip').addEventListener('input', function () {
      queueSettings({ skipSelectors: $('set-skip').value });
    });

    $('open-shortcuts').addEventListener('click', function () {
      try {
        chrome.tabs.create({ url: 'edge://extensions/shortcuts' }, function () {
          if (chrome.runtime.lastError) {
            alert('请手动在地址栏打开 edge://extensions/shortcuts');
          }
        });
      } catch (e) {
        alert('请手动在地址栏打开 edge://extensions/shortcuts');
      }
    });
  }

  // ---------- AI ----------

  function renderProviders() {
    const grid = $('provider-grid');
    grid.innerHTML = '';
    for (const id in PRESETS) {
      const p = PRESETS[id];
      const btn = document.createElement('button');
      btn.className = 'provider' + (settings.aiProvider === id ? ' active' : '');
      btn.type = 'button';
      const b = document.createElement('b');
      b.textContent = p.label;
      const s = document.createElement('small');
      s.textContent = p.api === 'gemini' ? 'Gemini 原生接口' : (p.api === 'claude' ? 'Claude 原生接口' : 'OpenAI 兼容');
      btn.appendChild(b);
      btn.appendChild(s);
      btn.addEventListener('click', function () { selectProvider(id); });
      grid.appendChild(btn);
    }
  }

  function selectProvider(id) {
    const p = PRESETS[id];
    if (!p) return;
    settings.aiProvider = id;
    if (id !== 'custom') {
      settings.aiBaseUrl = p.baseUrl || '';
      settings.aiModel = p.model || '';
    }
    queueSettings({
      aiProvider: settings.aiProvider,
      aiBaseUrl: settings.aiBaseUrl,
      aiModel: settings.aiModel
    });
    renderProviders();
    renderAI();
    const tr = $('test-result');
    if (tr) { tr.textContent = ''; tr.className = 'test-result'; }
  }

  function renderAI() {
    const p = PRESETS[settings.aiProvider] || PRESETS.custom;
    $('set-key').value = settings.aiApiKey || '';
    $('set-key').placeholder = p.needsKey === false ? '本地服务可留空' : '粘贴你的 API Key';
    $('set-base').value = settings.aiBaseUrl || '';
    $('set-model').value = settings.aiModel || '';
    $('set-temp').value = settings.aiTemperature == null ? 0.2 : settings.aiTemperature;
    $('temp-val').textContent = Number($('set-temp').value).toFixed(1);
    $('set-batch').value = settings.aiBatch || 12;
    $('set-autoupgrade').checked = !!settings.autoUpgrade;
    $('set-prompt').value = settings.customPrompt || '';

    let hint = p.hint || '';
    if (p.needsKey === false) hint += ' 无需 API Key。';
    $('preset-hint').textContent = hint;
    const docs = $('preset-docs');
    if (p.docs) {
      docs.href = p.docs;
      docs.hidden = false;
    } else {
      docs.hidden = true;
    }
  }

  function bindAI() {
    $('set-key').addEventListener('input', function () {
      queueSettings({ aiApiKey: $('set-key').value.trim() });
    });
    $('set-base').addEventListener('input', function () {
      queueSettings({ aiBaseUrl: $('set-base').value.trim() });
    });
    $('set-model').addEventListener('input', function () {
      queueSettings({ aiModel: $('set-model').value.trim() });
    });
    $('set-temp').addEventListener('input', function () {
      const v = Number($('set-temp').value);
      $('temp-val').textContent = v.toFixed(1);
      queueSettings({ aiTemperature: v });
    });
    $('set-batch').addEventListener('change', function () {
      let v = Number($('set-batch').value) || 12;
      v = Math.max(4, Math.min(20, v));
      $('set-batch').value = v;
      queueSettings({ aiBatch: v });
    });
    $('set-autoupgrade').addEventListener('change', function () {
      queueSettings({ autoUpgrade: $('set-autoupgrade').checked });
    });
    $('set-prompt').addEventListener('input', function () {
      queueSettings({ customPrompt: $('set-prompt').value });
    });

    $('toggle-key').addEventListener('click', function () {
      const input = $('set-key');
      if (input.type === 'password') {
        input.type = 'text';
        $('toggle-key').textContent = '隐藏';
      } else {
        input.type = 'password';
        $('toggle-key').textContent = '显示';
      }
    });

    $('btn-import-opencode').addEventListener('click', function () {
      $('import-opencode-file').click();
    });
    $('import-opencode-file').addEventListener('change', async function (e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const result = $('test-result');
      try {
        const text = await readFileSmart(file);
        const data = JSON.parse(text);
        const node = data['opencode-go'] || data['opencode'] || data;
        const key = typeof node === 'string'
          ? node
          : (node && (node.key || node.apiKey || node.token));
        if (!key || typeof key !== 'string' || key.trim().length < 10) {
          throw new Error('文件里没有找到 OpenCode Go 的 Key');
        }
        const preset = PRESETS['opencode-go'];
        settings.aiProvider = 'opencode-go';
        settings.aiBaseUrl = preset.baseUrl;
        settings.aiModel = 'glm-5.3-flash';
        settings.aiApiKey = key.trim();
        await chrome.storage.local.set({ settings: settings });
        renderProviders();
        renderAI();
        setSaveState('已自动保存');
        result.className = 'test-result ok';
        result.textContent = '已导入 OpenCode Go Key（' + key.trim().length + ' 位），点「测试连接」验证。';
      } catch (err) {
        result.className = 'test-result err';
        result.textContent = '导入失败：' + (err && err.message ? err.message : err);
      }
    });

    $('btn-test').addEventListener('click', async function () {
      await flushSettings();
      const result = $('test-result');
      const key = $('set-key').value.trim();
      const base = $('set-base').value.trim();
      const model = $('set-model').value.trim();
      if (!base || !model) {
        result.className = 'test-result err';
        result.textContent = '请先填写接口地址和模型名';
        return;
      }
      const p = PRESETS[settings.aiProvider] || PRESETS.custom;
      if (p.needsKey !== false && !key) {
        result.className = 'test-result err';
        result.textContent = '请先填写 API Key';
        return;
      }
      result.className = 'test-result loading';
      result.textContent = '正在连接…';
      $('btn-test').disabled = true;
      const testSettings = Object.assign({}, settings, {
        aiApiKey: key,
        aiBaseUrl: base,
        aiModel: model
      });
      const res = await sendBg({ type: 'ai-test', settings: testSettings });
      $('btn-test').disabled = false;
      if (res && res.ok) {
        result.className = 'test-result ok';
        result.textContent = '连接成功：' + (res.result.translation || '') +
          '（' + (res.result.model || model) + '）';
      } else {
        result.className = 'test-result err';
        result.textContent = (res && res.error) || '连接失败，请检查 Key、地址和网络';
      }
    });
  }

  // ---------- 术语库 ----------

  function termStats() {
    return TB.stats(termbase.entries);
  }

  function renderTermStats() {
    const s = termStats();
    $('stat-total').textContent = s.total;
    $('stat-enabled').textContent = s.enabled;
    $('stat-cats').textContent = s.categories.length;
    $('nav-term-count').textContent = s.total;

    const sel = $('term-category');
    const current = termCat;
    sel.innerHTML = '<option value="">全部分类</option>';
    for (const c of s.categories) {
      const o = document.createElement('option');
      o.value = c[0];
      o.textContent = c[0] + '（' + c[1] + '）';
      sel.appendChild(o);
    }
    if (current && s.categories.some(function (c) { return c[0] === current; })) sel.value = current;
    else if (current) { termCat = ''; sel.value = ''; }
  }

  function filteredTerms() {
    const q = termQuery.trim().toLowerCase();
    return termbase.entries.filter(function (e) {
      if (termCat && e.category !== termCat) return false;
      if (!q) return true;
      return (e.source + ' ' + e.target + ' ' + e.category + ' ' + e.note).toLowerCase().indexOf(q) !== -1;
    });
  }

  function makeCellInput(value, field, cls) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.title = value || '';
    input.dataset.field = field;
    if (cls) input.className = cls;
    return input;
  }

  function renderTermTable() {
    const list = filteredTerms();
    const pages = Math.max(1, Math.ceil(list.length / termPageSize));
    if (termPage > pages) termPage = pages;
    if (termPage < 1) termPage = 1;
    const start = (termPage - 1) * termPageSize;
    const slice = list.slice(start, start + termPageSize);

    const body = $('term-body');
    body.innerHTML = '';
    $('term-empty').hidden = list.length > 0;

    for (const e of slice) {
      const tr = document.createElement('tr');
      tr.dataset.id = e.id;
      tr.dataset.origSource = e.source;
      tr.dataset.origTarget = e.target;

      const tdOn = document.createElement('td');
      tdOn.className = 'col-on';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = e.enabled !== false;
      cb.dataset.field = 'enabled';
      cb.title = '启用 / 停用';
      tdOn.appendChild(cb);

      const tdSrc = document.createElement('td');
      tdSrc.appendChild(makeCellInput(e.source, 'source', 'src-cell'));

      const tdDst = document.createElement('td');
      tdDst.appendChild(makeCellInput(e.target, 'target'));

      const tdPolicy = document.createElement('td');
      const pol = document.createElement('select');
      pol.dataset.field = 'policy';
      pol.innerHTML = '<option value="keep">保留英文</option><option value="translate">指定译法</option>';
      pol.value = e.policy;
      tdPolicy.appendChild(pol);

      const tdCat = document.createElement('td');
      tdCat.appendChild(makeCellInput(e.category, 'category'));

      const tdNote = document.createElement('td');
      tdNote.appendChild(makeCellInput(e.note, 'note'));

      const tdDel = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.type = 'button';
      del.dataset.act = 'del';
      del.title = '删除';
      del.textContent = '×';
      tdDel.appendChild(del);

      tr.appendChild(tdOn);
      tr.appendChild(tdSrc);
      tr.appendChild(tdDst);
      tr.appendChild(tdPolicy);
      tr.appendChild(tdCat);
      tr.appendChild(tdNote);
      tr.appendChild(tdDel);
      body.appendChild(tr);
    }

    $('term-page-info').textContent = list.length
      ? ('第 ' + termPage + ' / ' + pages + ' 页 · 共 ' + list.length + ' 条')
      : '共 0 条';
    $('term-prev').disabled = termPage <= 1;
    $('term-next').disabled = termPage >= pages;
  }

  function findTerm(id) {
    return termbase.entries.find(function (e) { return e.id === id; });
  }

  function showAddForm(prefill) {
    $('add-form').hidden = false;
    $('new-source').value = prefill && prefill.source ? prefill.source : '';
    $('new-target').value = prefill && prefill.target ? prefill.target : '';
    $('new-policy').value = prefill && prefill.policy ? prefill.policy : 'keep';
    $('new-category').value = prefill && prefill.category ? prefill.category : '自定义';
    $('new-note').value = prefill && prefill.note ? prefill.note : '';
    $('term-form-hint').textContent = '';
    if (prefill && prefill.source) $('new-target').focus();
    else $('new-source').focus();
    $('add-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideAddForm() {
    $('add-form').hidden = true;
    $('term-form-hint').textContent = '';
  }

  function addTerm() {
    const source = $('new-source').value.trim();
    let target = $('new-target').value.trim();
    const policy = $('new-policy').value;
    const category = $('new-category').value.trim() || '自定义';
    const note = $('new-note').value.trim();
    if (!source) {
      $('term-form-hint').textContent = '原文不能为空';
      return;
    }
    if (!target) target = source;
    if (policy === 'translate' && target === source) {
      $('term-form-hint').textContent = '「指定译法」需要填写一个不同的中文译法';
      return;
    }
    const dup = termbase.entries.find(function (e) {
      return e.source.toLowerCase() === source.toLowerCase() && e.policy === policy;
    });
    if (dup) {
      dup.target = target;
      dup.category = category;
      dup.note = note;
      dup.enabled = true;
      $('term-form-hint').textContent = '已更新同名术语';
    } else {
      termbase.entries.push(TB.sanitizeEntry({
        source: source,
        target: target,
        policy: policy,
        category: category,
        note: note
      }));
      $('term-form-hint').textContent = '已添加';
    }
    queueTermSave(true);
    renderTermStats();
    $('term-search').value = source;
    termQuery = source;
    termPage = 1;
    renderTermTable();
    setTimeout(hideAddForm, 450);
  }

  function bindTermbase() {
    const body = $('term-body');

    body.addEventListener('input', function (e) {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const field = e.target.dataset.field;
      if (!field || field === 'enabled' || field === 'policy') return;
      const entry = findTerm(tr.dataset.id);
      if (!entry) return;
      entry[field] = e.target.value;
      if (field === 'source' && e.target.value.trim()) tr.dataset.origSource = e.target.value;
      if (field === 'target' && e.target.value.trim()) tr.dataset.origTarget = e.target.value;
      queueTermSave(false);
    });

    body.addEventListener('change', function (e) {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const field = e.target.dataset.field;
      if (!field) return;
      const entry = findTerm(tr.dataset.id);
      if (!entry) return;
      if (field === 'enabled') entry.enabled = e.target.checked;
      else if (field === 'policy') {
        entry.policy = e.target.value;
        if (entry.policy === 'translate' && !String(entry.target || '').trim()) {
          entry.target = entry.source;
          const tInput = tr.querySelector('input[data-field="target"]');
          if (tInput) { tInput.value = entry.target; tInput.title = entry.target; }
          tr.dataset.origTarget = entry.target;
        }
      }
      queueTermSave(false);
      renderTermStats();
    });

    body.addEventListener('focusout', function (e) {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const entry = findTerm(tr.dataset.id);
      if (!entry) return;
      if (e.target.dataset.field === 'source') {
        if (!e.target.value.trim()) {
          e.target.value = tr.dataset.origSource || entry.source || '';
          entry.source = e.target.value;
          queueTermSave(false);
        } else {
          entry.source = e.target.value.trim();
          tr.dataset.origSource = entry.source;
        }
      } else if (e.target.dataset.field === 'target') {
        if (entry.policy === 'translate' && !e.target.value.trim()) {
          e.target.value = tr.dataset.origTarget || entry.source || '';
          entry.target = e.target.value;
          tr.dataset.origTarget = entry.target;
          e.target.title = entry.target;
          queueTermSave(false);
        } else if (e.target.value.trim()) {
          entry.target = e.target.value.trim();
          tr.dataset.origTarget = entry.target;
        }
      }
    });

    body.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-act="del"]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const entry = findTerm(tr.dataset.id);
      if (!entry) return;
      if (!confirm('删除术语「' + entry.source + '」？')) return;
      termbase.entries = termbase.entries.filter(function (x) { return x.id !== entry.id; });
      queueTermSave(true);
      renderTermStats();
      renderTermTable();
    });

    $('btn-add-term').addEventListener('click', function () { showAddForm(); });
    $('btn-cancel-term').addEventListener('click', hideAddForm);
    $('btn-save-term').addEventListener('click', addTerm);
    $('new-source').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTerm(); });
    $('new-target').addEventListener('keydown', function (e) { if (e.key === 'Enter') addTerm(); });

    $('term-search').addEventListener('input', debounce(function () {
      termQuery = $('term-search').value;
      termPage = 1;
      renderTermTable();
    }, 160));
    $('term-category').addEventListener('change', function () {
      termCat = $('term-category').value;
      termPage = 1;
      renderTermTable();
    });
    $('term-prev').addEventListener('click', function () {
      if (termPage > 1) { termPage--; renderTermTable(); }
    });
    $('term-next').addEventListener('click', function () {
      termPage++; renderTermTable();
    });

    $('btn-term-more').addEventListener('click', function (e) {
      e.stopPropagation();
      const menu = $('term-more-menu');
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function () { $('term-more-menu').hidden = true; });

    $('btn-merge-default').addEventListener('click', function () {
      if (!confirm('把内置术语里缺少的条目补进当前术语库？不会覆盖你改过的词。')) return;
      const res = TB.mergeDefaults(termbase.entries);
      termbase.entries = res.entries;
      queueTermSave(true);
      renderTermStats();
      renderTermTable();
      alert('已补充 ' + res.added + ' 条内置术语。');
    });

    $('btn-clear-terms').addEventListener('click', function () {
      if (!confirm('清空全部术语？此操作不可撤销，建议先导出备份。')) return;
      if (!confirm('再确认一次：确定清空 ' + termbase.entries.length + ' 条术语？')) return;
      termbase.entries = [];
      queueTermSave(true);
      renderTermStats();
      renderTermTable();
    });

    $('btn-export-csv').addEventListener('click', exportTermsCSV);
    $('btn-export-json').addEventListener('click', exportTermsJSON);
    $('btn-import').addEventListener('click', openImport);
    ['import-file'].forEach(function (id) {
      $(id).addEventListener('change', onImportFile);
    });
    $('import-text').addEventListener('input', debounce(parseImportPreview, 200));
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { $(b.getAttribute('data-close')).hidden = true; });
    });
    $('import-modal').addEventListener('click', function (e) {
      if (e.target === $('import-modal')) $('import-modal').hidden = true;
    });
    $('btn-do-import').addEventListener('click', doImport);
  }

  function exportTermsCSV() {
    const csv = TB.toCSV(termbase.entries);
    download('ait-termbase-' + dateStamp() + '.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
  }

  function exportTermsJSON() {
    download('ait-termbase-' + dateStamp() + '.json',
      JSON.stringify({ version: 1, updatedAt: Date.now(), entries: termbase.entries }, null, 2),
      'application/json;charset=utf-8');
  }

  function openImport() {
    $('import-modal').hidden = false;
    $('import-file').value = '';
    $('import-text').value = '';
    $('import-preview').textContent = '等待选择文件或粘贴内容…';
    importParsed = [];
    importFileName = '';
  }

  function readFileSmart(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(reader.error); };
      reader.onload = function () {
        try {
          const buf = reader.result;
          let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
          if (text.indexOf('\uFFFD') !== -1) {
            try { text = new TextDecoder('gbk').decode(buf); } catch (e) { /* 保留 UTF-8 */ }
          }
          resolve(text.replace(/^\uFEFF/, ''));
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    importFileName = file.name;
    try {
      const text = await readFileSmart(file);
      $('import-text').value = text.slice(0, 400000);
      parseImportPreview();
    } catch (err) {
      $('import-preview').textContent = '文件读取失败：' + (err && err.message ? err.message : err);
    }
  }

  function parseImportPreview() {
    const text = $('import-text').value;
    if (!text.trim()) {
      importParsed = [];
      $('import-preview').textContent = '等待选择文件或粘贴内容…';
      return;
    }
    try {
      importParsed = TB.parseImport(text, importFileName);
      if (!importParsed.length) {
        $('import-preview').textContent = '没有识别到术语。请检查格式：原文,译法,策略,分类,备注';
      } else {
        const keeps = importParsed.filter(function (e) { return e.policy === 'keep'; }).length;
        $('import-preview').textContent = '已识别 ' + importParsed.length + ' 条（保留英文 ' +
          keeps + ' 条，指定译法 ' + (importParsed.length - keeps) + ' 条）';
      }
    } catch (err) {
      importParsed = [];
      $('import-preview').textContent = '解析失败：' + (err && err.message ? err.message : err);
    }
  }

  async function doImport() {
    parseImportPreview();
    if (!importParsed.length) {
      $('import-preview').textContent = '没有可导入的术语';
      return;
    }
    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    if (mode === 'replace') {
      if (!confirm('替换会删除现有 ' + termbase.entries.length + ' 条术语，确定继续？')) return;
      termbase.entries = importParsed;
    } else {
      const map = new Map();
      for (const e of termbase.entries) map.set(e.source.toLowerCase() + '|' + e.policy, e);
      for (const e of importParsed) {
        const key = e.source.toLowerCase() + '|' + e.policy;
        if (map.has(key)) {
          const old = map.get(key);
          old.target = e.target;
          if (e.category && e.category !== '导入') old.category = e.category;
          if (e.note) old.note = e.note;
          old.enabled = true;
        } else {
          map.set(key, e);
        }
      }
      termbase.entries = Array.from(map.values());
    }
    termbase.updatedAt = Date.now();
    await chrome.storage.local.set({ termbase: termbase });
    $('import-modal').hidden = true;
    renderTermStats();
    renderTermTable();
    setSaveState('术语库已保存');
  }

  // ---------- 站点 ----------

  function renderSites() {
    const body = $('site-body');
    body.innerHTML = '';
    const rules = settings.siteRules || {};
    const keys = Object.keys(rules).sort();
    $('site-empty').hidden = keys.length > 0;

    for (const domain of keys) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = domain;
      const td2 = document.createElement('td');
      const sel = document.createElement('select');
      sel.dataset.domain = domain;
      sel.innerHTML = '<option value="auto">始终自动翻译</option><option value="never">从不自动翻译</option>';
      sel.value = rules[domain] === 'never' ? 'never' : 'auto';
      sel.addEventListener('change', function () {
        const r = Object.assign({}, settings.siteRules);
        r[domain] = sel.value;
        settings.siteRules = r;
        queueSettings({ siteRules: r });
      });
      td2.appendChild(sel);
      const td3 = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.type = 'button';
      del.textContent = '×';
      del.title = '删除规则';
      del.addEventListener('click', function () {
        const r = Object.assign({}, settings.siteRules);
        delete r[domain];
        settings.siteRules = r;
        queueSettings({ siteRules: r });
        renderSites();
      });
      td3.appendChild(del);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      body.appendChild(tr);
    }
  }

  function normalizeDomain(input) {
    let s = String(input || '').trim().toLowerCase();
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!s) return '';
    try {
      const u = new URL('http://' + s);
      if (!u.hostname) return '';
      if (u.hostname.indexOf('.') === -1 && u.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return '';
      return u.hostname;
    } catch (e) { return ''; }
  }

  function bindSites() {
    $('set-auto-2').addEventListener('change', function () {
      const v = $('set-auto-2').checked;
      $('set-auto').checked = v;
      queueSettings({ autoTranslate: v });
    });
    $('btn-add-site').addEventListener('click', function () {
      const domain = normalizeDomain($('site-domain').value);
      if (!domain) { alert('请输入有效域名，例如 example.com'); return; }
      const mode = $('site-mode').value;
      const r = Object.assign({}, settings.siteRules);
      r[domain] = mode;
      settings.siteRules = r;
      queueSettings({ siteRules: r });
      $('site-domain').value = '';
      renderSites();
    });
    $('btn-current-site').addEventListener('click', async function () {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0] && tabs[0].url) {
          const u = new URL(tabs[0].url);
          $('site-domain').value = u.hostname;
          $('site-domain').focus();
        }
      } catch (e) { /* 忽略 */ }
    });
  }

  // ---------- 数据 ----------

  async function refreshCacheCount() {
    const res = await sendBg({ type: 'get-stats' });
    if (res && res.ok) $('cache-count').textContent = res.cacheCount;
  }

  function bindData() {
    $('btn-clear-cache').addEventListener('click', async function () {
      if (!confirm('清空全部翻译缓存？')) return;
      const res = await sendBg({ type: 'clear-cache' });
      $('cache-count').textContent = '0';
      alert(res && res.ok ? ('已清空 ' + res.count + ' 条缓存') : '清空失败');
    });

    $('btn-export-settings').addEventListener('click', async function () {
      const data = await chrome.storage.local.get(['settings', 'termbase']);
      const includeKey = $('export-key').checked;
      const payload = {
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: Object.assign({}, settings),
        termbase: { version: 1, updatedAt: termbase.updatedAt || Date.now(), entries: termbase.entries }
      };
      if (!includeKey) payload.settings.aiApiKey = '';
      download('ait-backup-' + dateStamp() + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    });

    $('btn-import-settings').addEventListener('click', function () {
      $('import-settings-file').click();
    });
    $('import-settings-file').addEventListener('change', async function (e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const text = await readFileSmart(file);
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object') throw new Error('不是有效的备份文件');
        if (data.settings) {
          const imported = Object.assign({}, DEFAULTS, data.settings);
          imported.style = Object.assign({}, DEFAULTS.style || {}, data.settings.style || {});
          if (!imported.aiApiKey && settings.aiApiKey) imported.aiApiKey = settings.aiApiKey;
          settings = imported;
        }
        if (data.termbase) {
          termbase = TB.normalizeTermbase(data.termbase);
        }
        await chrome.storage.local.set({ settings: settings, termbase: termbase });
        renderAll();
        alert('导入成功。已刷新设置与术语库。');
      } catch (err) {
        alert('导入失败：' + (err && err.message ? err.message : err));
      }
    });

    $('btn-data-terms-csv').addEventListener('click', exportTermsCSV);
    $('btn-data-terms-json').addEventListener('click', exportTermsJSON);

    $('btn-reset').addEventListener('click', async function () {
      if (!confirm('恢复默认会清空当前设置、术语库和缓存，确定继续？')) return;
      if (!confirm('最后确认：建议先导出备份。继续恢复默认？')) return;
      resetting = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (termSaveTimer) { clearTimeout(termSaveTimer); termSaveTimer = null; }
      await chrome.storage.local.clear();
      const fresh = clone(DEFAULTS);
      const tb = { version: 1, updatedAt: Date.now(), entries: TB.defaultEntries() };
      settings = fresh;
      termbase = tb;
      await chrome.storage.local.set({ settings: fresh, termbase: tb });
      location.reload();
    });
  }

  // ---------- 帮助 ----------

  function bindHelp() {
    // 帮助页只有静态内容和跳转按钮，无额外逻辑
  }

  // ---------- 初始化 ----------

  function renderAll() {
    renderGeneral();
    renderProviders();
    renderAI();
    renderTermStats();
    renderTermSearchDefaults();
    renderTermTable();
    renderSites();
  }

  function renderTermSearchDefaults() {
    if (!$('term-search').value) $('term-search').value = termQuery;
  }

  function dateStamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  async function handleQuery() {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && TITLES[tab]) activate(tab);
    if (params.get('welcome') === '1') {
      $('welcome-card').hidden = false;
      activate('help');
    }
    if (params.get('add') === '1') {
      activate('termbase');
      let pending = null;
      try {
        const data = await chrome.storage.local.get('pendingTerm');
        pending = data.pendingTerm;
      } catch (e) { /* 忽略 */ }
      showAddForm(pending ? { source: String(pending.text || '').slice(0, 200) } : null);
      if (pending) {
        try { await chrome.storage.local.remove('pendingTerm'); } catch (e) { /* 忽略 */ }
      }
    }
  }

  async function init() {
    await loadAll();
    bindGeneral();
    bindAI();
    bindTermbase();
    bindSites();
    bindData();
    bindHelp();
    renderAll();
    await handleQuery();

    window.addEventListener('beforeunload', function () {
      if (resetting) return;
      if (saveTimer) {
        clearTimeout(saveTimer);
        chrome.storage.local.set({ settings: settings });
      }
      if (termSaveTimer) {
        clearTimeout(termSaveTimer);
        termbase.updatedAt = Date.now();
        chrome.storage.local.set({ termbase: termbase });
      }
    });
  }

  init().catch(function (e) {
    console.error(e);
    setSaveState('初始化失败', 'error');
  });
})();
