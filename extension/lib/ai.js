/* AI 精译：OpenAI 兼容 / Gemini / Claude，自带术语表提示词。 */

(function () {
  const NS = {};
  const PRESETS = self.AIT_AI_PRESETS || {};
  const TARGETS = self.AIT_TARGETS || [];
  const TERM = self.AIT_Termbase;
  const ENG = self.AIT_Engines;
  const SESSION_ID = 'ait-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function targetLabel(code) {
    const t = TARGETS.find(function (x) { return x.code === code; });
    return t ? t.label : (code || '简体中文');
  }

  function resolve(settings) {
    const s = settings || {};
    const preset = PRESETS[s.aiProvider] || PRESETS.custom || {};
    return {
      provider: s.aiProvider || 'custom',
      api: preset.api || 'openai',
      baseUrl: String(s.aiBaseUrl || preset.baseUrl || '').trim().replace(/\/+$/, ''),
      model: String(s.aiModel || preset.model || '').trim(),
      key: String(s.aiApiKey || '').trim(),
      needsKey: preset.needsKey !== false,
      temperature: typeof s.aiTemperature === 'number' ? s.aiTemperature : 0.2,
      batch: Math.max(1, Math.min(20, Number(s.aiBatch) || 12)),
      sessionId: String(s.opencodeSession || SESSION_ID)
    };
  }

  function isReady(settings) {
    const c = resolve(settings);
    if (!c.baseUrl || !c.model) return false;
    if (c.needsKey && !c.key) return false;
    return true;
  }

  function joinUrl(base, path) {
    const b = String(base || '').replace(/\/+$/, '');
    if (!b) return path;
    if (b.endsWith(path)) return b;
    return b + path;
  }

  function buildGlossary(entries, texts, targetLang) {
    if (!TERM || !entries || !entries.length) return '';
    if (String(targetLang || '').indexOf('zh') !== 0) return '';
    const matched = TERM.findMatchedEntries(entries, texts, 70);
    if (!matched.length) return '';
    const lines = matched.map(function (e) {
      const rule = e.policy === 'translate' ? ('译为「' + e.target + '」') : '保留英文原文';
      return '- ' + e.source + ' → ' + e.target + '（' + rule + '）';
    });
    return '\n# 术语表（优先级最高，必须遵守）\n' + lines.join('\n') + '\n';
  }

  function buildSystemPrompt(settings, texts, context) {
    const custom = String((settings && settings.customPrompt) || '').trim();
    const base = custom || self.AI_TRANSLATION_PROMPT || '';
    const target = targetLabel(settings && settings.targetLang);
    const glossary = buildGlossary(
      context && context.entries ? context.entries : [],
      texts,
      settings && settings.targetLang
    );
    const ctx = context || {};
    const pageInfo = [
      ctx.domain ? ('网站：' + ctx.domain) : '',
      ctx.title ? ('页面标题：' + String(ctx.title).slice(0, 200)) : ''
    ].filter(Boolean).join('\n');

    return base + '\n\n' +
      '# 网页翻译任务（本次必须遵守）\n' +
      '- 目标语言：' + target + '\n' +
      (pageInfo ? pageInfo + '\n' : '') +
      '- 根据页面语境判断领域（AI、金融、社交媒体、素材设计等），选择该领域最自然的译法。\n' +
      '- 先判断领域再翻译：如果页面不是 AI/技术内容，不要强行套用 AI 术语；金融页用金融表达，社媒页用平台习惯说法，素材/设计页用设计行业用语。术语表仍然优先。\n' +
      '- 金融内容里的 policy 是「政策」，不是 AI 语境下的「策略」；yield 是「收益率」，不是「产量」；position 是「仓位」，不是「位置」。\n' +
      '- 译文要像中文行业媒体/专业文章，通顺、克制，不要机翻腔，不要逐字硬译。\n' +
      '- 输入是一个 JSON 对象，其中 texts 是待翻译的字符串数组，顺序固定。\n' +
      '- 必须返回一个 JSON 对象：{"translations":[{"i":0,"t":"译文"},{"i":1,"t":"译文"}]}。\n' +
      '- i 是原文下标，必须从 0 开始，数量与 texts 完全一致；不要遗漏、不要合并段落。\n' +
      '- 只输出 JSON，不要 Markdown 代码块，不要解释，不要加“以下是翻译”之类的前缀。\n' +
      '- 保留代码、URL、邮箱、变量名、占位符、数字和专有名词；不要翻译代码块内容。\n' +
      '- 译文要通顺、准确、简洁；导航和按钮用短译法，正文保持完整语义。\n' +
      '- 注意：上面「输出要求」只约束译文内容；本次任务的最终输出格式以本节 JSON 要求为准。\n' +
      glossary;
  }

  function buildUserPrompt(texts, settings, context) {
    const ctx = context || {};
    const payload = {
      domain: ctx.domain || '',
      title: String(ctx.title || '').slice(0, 200),
      target: targetLabel(settings && settings.targetLang),
      texts: texts
    };
    return '请翻译下面 JSON 中的 texts，并按要求返回 JSON：\n' + JSON.stringify(payload);
  }

  function extractJSON(raw) {
    let s = String(raw || '').trim();
    if (!s) throw new Error('AI 返回为空');
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(s); } catch (e) { /* 继续 */ }
    const firstObj = s.indexOf('{');
    const firstArr = s.indexOf('[');
    let start = -1;
    if (firstObj === -1) start = firstArr;
    else if (firstArr === -1) start = firstObj;
    else start = Math.min(firstObj, firstArr);
    if (start === -1) throw new Error('AI 返回不是 JSON：' + s.slice(0, 120));
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end <= start) throw new Error('AI 返回 JSON 不完整');
    const candidate = s.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (e) {
      throw new Error('AI 返回 JSON 解析失败：' + candidate.slice(0, 120));
    }
  }

  function normalizeAIResult(data, count) {
    let items = null;
    if (Array.isArray(data)) items = data;
    else if (data && Array.isArray(data.translations)) items = data.translations;
    else if (data && Array.isArray(data.texts)) items = data.texts;
    else if (data && Array.isArray(data.results)) items = data.results;
    if (!items) throw new Error('AI 返回缺少 translations 数组');

    const out = new Array(count).fill('');
    let seq = 0;
    for (const item of items) {
      if (typeof item === 'string') {
        if (seq < count) out[seq++] = item;
        continue;
      }
      if (item && typeof item === 'object') {
        const idx = Number(item.i != null ? item.i : item.index != null ? item.index : item.id);
        const text = item.t != null ? item.t : item.text != null ? item.text : item.translation;
        if (Number.isFinite(idx) && idx >= 0 && idx < count) out[idx] = String(text == null ? '' : text);
        else if (seq < count && text != null) out[seq++] = String(text);
      }
    }
    const missing = out.filter(function (x) { return !String(x).trim(); }).length;
    if (missing === count) throw new Error('AI 没有返回有效译文');
    return out;
  }

  function apiError(status, body, label) {
    let msg = '';
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : body;
      msg = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
    } catch (e) { msg = String(body || '').slice(0, 160); }
    if (status === 401) return (label || 'AI') + '：API Key 无效或已过期';
    if (status === 403) return (label || 'AI') + '：无权限（检查 Key、模型权限或地区限制）';
    if (status === 404) return (label || 'AI') + '：接口地址或模型名不正确';
    if (status === 429) return (label || 'AI') + '：请求太频繁或额度用尽';
    if (status >= 500) return (label || 'AI') + '：服务端错误 ' + status;
    return (label || 'AI') + '：HTTP ' + status + (msg ? '（' + String(msg).slice(0, 160) + '）' : '');
  }

  async function callOpenAI(config, messages) {
    const url = joinUrl(config.baseUrl, '/chat/completions');
    const headers = { 'Content-Type': 'application/json' };
    if (config.key) headers.Authorization = 'Bearer ' + config.key;
    if (config.provider === 'opencode-go' || String(config.baseUrl || '').indexOf('opencode.ai/inference/go') !== -1) {
      headers['x-opencode-session'] = config.sessionId || SESSION_ID;
    }
    if (config.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/ai-web-translator';
      headers['X-Title'] = 'AI Web Translator';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 90000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model: config.model,
          messages: messages,
          temperature: config.temperature,
          max_tokens: 4096,
          stream: false
        })
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('AI 请求超时（90 秒）');
      throw new Error('AI 网络请求失败：' + (e && e.message ? e.message : '无法连接'));
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(apiError(res.status, text, 'AI'));
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('AI 返回非 JSON：' + text.slice(0, 120)); }
    const choice = data && data.choices && data.choices[0];
    if (!choice) throw new Error('AI 返回缺少 choices');
    const content = choice.message && choice.message.content;
    if (Array.isArray(content)) {
      return content.map(function (p) { return p && (p.text || p.content) || ''; }).join('');
    }
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回内容为空');
    if (choice.finish_reason === 'length') throw new Error('AI 输出被截断（可减少每批段数）');
    return content;
  }

  async function callGemini(config, system, user) {
    const url = joinUrl(config.baseUrl, '/models/' + encodeURIComponent(config.model) +
      ':generateContent?key=' + encodeURIComponent(config.key));
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 90000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json'
          }
        })
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Gemini 请求超时（90 秒）');
      throw new Error('Gemini 网络请求失败：' + (e && e.message ? e.message : '无法连接'));
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(apiError(res.status, text, 'Gemini'));
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Gemini 返回非 JSON'); }
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) {
      const block = data && data.promptFeedback && data.promptFeedback.blockReason;
      throw new Error('Gemini 未返回结果' + (block ? '（拦截原因：' + block + '）' : ''));
    }
    const parts = cand.content && cand.content.parts;
    if (!Array.isArray(parts) || !parts.length) throw new Error('Gemini 返回内容为空');
    const out = parts.map(function (p) { return p && p.text ? p.text : ''; }).join('');
    if (!out.trim()) throw new Error('Gemini 返回内容为空');
    if (cand.finishReason === 'MAX_TOKENS') throw new Error('Gemini 输出被截断（可减少每批段数）');
    return out;
  }

  async function callClaude(config, system, user) {
    const url = joinUrl(config.baseUrl, '/messages');
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 90000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          temperature: config.temperature,
          system: system,
          messages: [{ role: 'user', content: user }]
        })
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Claude 请求超时（90 秒）');
      throw new Error('Claude 网络请求失败：' + (e && e.message ? e.message : '无法连接'));
    }
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(apiError(res.status, text, 'Claude'));
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Claude 返回非 JSON'); }
    const content = data && data.content;
    if (!Array.isArray(content)) throw new Error('Claude 返回内容为空');
    const out = content.map(function (p) { return p && p.text ? p.text : ''; }).join('');
    if (!out.trim()) throw new Error('Claude 返回内容为空');
    if (data.stop_reason === 'max_tokens') throw new Error('Claude 输出被截断（可减少每批段数）');
    return out;
  }

  async function callAI(config, system, user) {
    if (config.api === 'gemini') return callGemini(config, system, user);
    if (config.api === 'claude') return callClaude(config, system, user);
    return callOpenAI(config, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  }

  async function translateChunk(texts, config, settings, context, depth) {
    const system = buildSystemPrompt(settings, texts, context);
    const user = buildUserPrompt(texts, settings, context);
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callAI(config, system, user);
        const data = extractJSON(raw);
        return normalizeAIResult(data, texts.length);
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message || '');
        if (/API Key|无权限|额度|超时|网络|模型名|地址/.test(msg)) break;
        if (attempt === 0) await new Promise(function (r) { setTimeout(r, 800); });
      }
    }
    if (texts.length > 1 && (depth || 0) < 3) {
      const msg = String(lastErr && lastErr.message || '');
      if (!/API Key|无权限|额度|模型名|地址|超时|网络|HTTP 4|HTTP 5/i.test(msg)) {
        const mid = Math.ceil(texts.length / 2);
        const left = await translateChunk(texts.slice(0, mid), config, settings, context, (depth || 0) + 1);
        const right = await translateChunk(texts.slice(mid), config, settings, context, (depth || 0) + 1);
        return left.concat(right);
      }
    }
    throw lastErr || new Error('AI 翻译失败');
  }

  function chunkAI(texts, maxItems, maxChars) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const t of texts) {
      if (cur.length >= maxItems || (len + t.length > maxChars && cur.length)) {
        chunks.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(t);
      len += t.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /**
   * AI 翻译入口。返回 { translations, errors }。
   */
  async function translateAI(texts, settings, context) {
    const config = resolve(settings);
    if (!isReady(settings)) {
      throw new Error('AI 尚未配置，请到设置里填写 API Key / 接口地址 / 模型');
    }
    const list = (Array.isArray(texts) ? texts : []).map(function (t) {
      return String(t == null ? '' : t);
    });

    const groups = [];
    const items = [];
    for (const t of list) {
      if (!t.trim()) { groups.push({ start: 0, count: 0 }); continue; }
      const pieces = ENG ? ENG.splitText(t, 4500) : [t];
      groups.push({ start: items.length, count: pieces.length });
      for (const p of pieces) items.push(p);
    }

    const outItems = new Array(items.length).fill('');
    const errors = [];
    if (items.length) {
      const chunks = chunkAI(items, config.batch, 3800);
      let idx = 0;
      async function worker() {
        while (idx < chunks.length) {
          const my = idx++;
          const chunk = chunks[my];
          let offset = 0;
          for (let c = 0; c < my; c++) offset += chunks[c].length;
          try {
            const translated = await translateChunk(chunk, config, settings, context, 0);
            for (let i = 0; i < translated.length; i++) outItems[offset + i] = translated[i];
          } catch (e) {
            errors.push(String(e && e.message || e));
          }
        }
      }
      const concurrency = Math.min(2, chunks.length);
      await Promise.all(Array.from({ length: concurrency }, worker));
    }

    const out = [];
    for (const g of groups) {
      if (!g.count) { out.push(''); continue; }
      out.push(outItems.slice(g.start, g.start + g.count).join(' ').trim());
    }
    if (errors.length && out.every(function (x) { return !x; })) {
      throw new Error(errors[0] || 'AI 翻译失败');
    }
    return { translations: out, errors: errors };
  }

  async function test(settings) {
    const config = resolve(settings);
    if (!isReady(settings)) throw new Error('请先填写完整的 API Key、接口地址和模型');
    const settings2 = Object.assign({}, settings, { targetLang: settings.targetLang || 'zh-CN' });
    const sample = 'The quick brown fox jumps over the lazy dog.';
    const raw = await callAI(
      config,
      buildSystemPrompt(settings2, [sample], { domain: 'test', title: 'connection test' }),
      buildUserPrompt([sample], settings2, { domain: 'test', title: 'connection test' })
    );
    const data = extractJSON(raw);
    const result = normalizeAIResult(data, 1);
    return { ok: true, translation: result[0], model: config.model, provider: config.provider };
  }

  NS.resolve = resolve;
  NS.isReady = isReady;
  NS.translateAI = translateAI;
  NS.test = test;
  NS.extractJSON = extractJSON;
  NS.normalizeAIResult = normalizeAIResult;
  self.AIT_AI = NS;
})();
