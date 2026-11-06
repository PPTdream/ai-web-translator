/* 免费翻译通道：腾讯 / 微软 / Google / MyMemory，自动降级。 */

(function () {
  const NS = {};

  const TM_URL = 'https://transmart.qq.com/api/imt';
  const MS_URL = 'https://api.edge.microsoft.com/translate/translate';
  const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
  const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

  const BATCH_SIZE = 30;
  const BATCH_CHARS = 5500;
  const MAX_TEXT = 2200;

  const LANG_MAP = {
    'zh-CN': { tencent: 'zh', ms: 'zh-Hans', google: 'zh-CN', mm: 'zh-CN' },
    'zh-TW': { tencent: 'zh-TW', ms: 'zh-Hant', google: 'zh-TW', mm: 'zh-TW' },
    en: { tencent: 'en', ms: 'en', google: 'en', mm: 'en' },
    ja: { tencent: 'ja', ms: 'ja', google: 'ja', mm: 'ja' },
    ko: { tencent: 'ko', ms: 'ko', google: 'ko', mm: 'ko' },
    fr: { tencent: 'fr', ms: 'fr', google: 'fr', mm: 'fr' },
    de: { tencent: 'de', ms: 'de', google: 'de', mm: 'de' },
    es: { tencent: 'es', ms: 'es', google: 'es', mm: 'es' },
    ru: { tencent: 'ru', ms: 'ru', google: 'ru', mm: 'ru' },
    pt: { tencent: 'pt', ms: 'pt', google: 'pt', mm: 'pt' },
    it: { tencent: 'it', ms: 'it', google: 'it', mm: 'it' },
    ar: { tencent: 'ar', ms: 'ar', google: 'ar', mm: 'ar' },
    tr: { tencent: 'tr', ms: 'tr', google: 'tr', mm: 'tr' },
    vi: { tencent: 'vi', ms: 'vi', google: 'vi', mm: 'vi' },
    th: { tencent: 'th', ms: 'th', google: 'th', mm: 'th' },
    id: { tencent: 'id', ms: 'id', google: 'id', mm: 'id' },
    hi: { tencent: 'hi', ms: 'hi', google: 'hi', mm: 'hi' },
    nl: { tencent: 'nl', ms: 'nl', google: 'nl', mm: 'nl' },
    pl: { tencent: 'pl', ms: 'pl', google: 'pl', mm: 'pl' }
  };

  function langOf(target, engine) {
    const m = LANG_MAP[target] || LANG_MAP['zh-CN'];
    return m[engine] || m.google;
  }

  function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(function () {
      clearTimeout(timer);
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  async function withRetry(fn, retries) {
    const n = retries == null ? 1 : retries;
    let last;
    for (let i = 0; i <= n; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (i < n) await sleep(500 + i * 500);
      }
    }
    throw last;
  }

  function splitText(text, max) {
    const s = String(text || '');
    const limit = max || MAX_TEXT;
    if (s.length <= limit) return [s];
    const pieces = [];
    let rest = s;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('. ', limit);
      if (cut < limit * 0.45) cut = rest.lastIndexOf('? ', limit);
      if (cut < limit * 0.45) cut = rest.lastIndexOf('! ', limit);
      if (cut < limit * 0.45) cut = rest.lastIndexOf('; ', limit);
      if (cut < limit * 0.45) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.45) cut = limit;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
    return pieces.filter(function (x) { return x !== ''; });
  }

  function chunkTexts(texts) {
    const chunks = [];
    let cur = [];
    let len = 0;
    for (const t of texts) {
      if (cur.length >= BATCH_SIZE || (len + t.length > BATCH_CHARS && cur.length)) {
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

  // ---------- 腾讯 ----------

  async function tencentTranslate(texts, target) {
    const lang = langOf(target, 'tencent');
    const payload = {
      header: { fn: 'auto_translation', session: '', client_key: 'browser_chrome' },
      type: 'plain',
      model_category: 'normal',
      source: { lang: 'auto', text_list: texts },
      target: { lang: lang }
    };

    async function call(body) {
      const res = await fetchWithTimeout(TM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 25000);
      if (!res.ok) throw new Error('腾讯 HTTP ' + res.status);
      const data = await res.json();
      const ret = data && data.header && data.header.ret_code;
      if (ret !== 'succ' || !Array.isArray(data.auto_translation)) {
        throw new Error('腾讯接口返回异常（' + (ret || '无返回') + '）');
      }
      if (data.auto_translation.length !== texts.length) {
        throw new Error('腾讯返回条数不匹配');
      }
      return data.auto_translation.map(function (t) {
        return typeof t === 'string' ? t : (t && (t.target || t.text)) || '';
      });
    }

    try {
      return await call(payload);
    } catch (e) {
      // 兼容旧接口参数（只支持中文目标）
      if (target === 'zh-CN' || target === 'zh-TW') {
        const legacy = {
          header: { fn: 'auto_translation', session: '', client_key: 'browser_chrome' },
          type: 'plain',
          model_category: 'normal',
          source: { text_source: 'input', text_list: texts }
        };
        return await call(legacy);
      }
      throw e;
    }
  }

  // ---------- 微软 Edge ----------

  async function microsoftTranslate(texts, target) {
    const url = MS_URL + '?from=&to=' + encodeURIComponent(langOf(target, 'ms')) + '&api-version=3.0';
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(texts.map(function (t) { return { Text: t }; }))
    }, 20000);
    if (!res.ok) throw new Error('微软 HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error('微软返回格式异常');
    }
    return data.map(function (item) {
      const tr = item && item.translations && item.translations[0];
      return tr && tr.text ? tr.text : '';
    });
  }

  // ---------- Google ----------

  function googleOne(text, target) {
    const url = GOOGLE_URL + '?client=gtx&sl=auto&tl=' + encodeURIComponent(langOf(target, 'google')) +
      '&dt=t&q=' + encodeURIComponent(text);
    return fetchWithTimeout(url, { method: 'GET' }, 15000).then(function (res) {
      if (!res.ok) throw new Error('Google HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!Array.isArray(data) || !Array.isArray(data[0])) {
        throw new Error('Google 返回格式异常');
      }
      return data[0].map(function (seg) { return seg && seg[0] ? seg[0] : ''; }).join('');
    });
  }

  async function googleTranslate(texts, target) {
    const out = new Array(texts.length).fill('');
    let idx = 0;
    async function worker() {
      while (idx < texts.length) {
        const i = idx++;
        const pieces = splitText(texts[i], 1600);
        const parts = [];
        for (const p of pieces) {
          parts.push(await googleOne(p, target));
        }
        out[i] = parts.join(' ');
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  // ---------- MyMemory ----------

  function guessSource(text) {
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[\u0600-\u06ff]/.test(text)) return 'ar';
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
    return 'en';
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  async function myMemoryOne(text, target) {
    const src = guessSource(text);
    const tl = langOf(target, 'mm');
    const url = MYMEMORY_URL + '?q=' + encodeURIComponent(text) + '&langpair=' +
      encodeURIComponent(src + '|' + tl);
    const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    if (!res.ok) throw new Error('MyMemory HTTP ' + res.status);
    const data = await res.json();
    const tr = data && data.responseData && data.responseData.translatedText;
    if (!tr || /MYMEMORY WARNING/i.test(tr)) throw new Error('MyMemory 额度不足');
    return decodeEntities(tr);
  }

  async function myMemoryTranslate(texts, target) {
    const out = new Array(texts.length).fill('');
    let idx = 0;
    async function worker() {
      while (idx < texts.length) {
        const i = idx++;
        const pieces = splitText(texts[i], 450);
        const parts = [];
        for (const p of pieces) parts.push(await myMemoryOne(p, target));
        out[i] = parts.join(' ');
      }
    }
    await Promise.all([worker(), worker()]);
    return out;
  }

  const ENGINES = {
    tencent: { label: '腾讯', fn: tencentTranslate },
    microsoft: { label: '微软', fn: microsoftTranslate },
    google: { label: 'Google', fn: googleTranslate },
    mymemory: { label: 'MyMemory', fn: myMemoryTranslate }
  };

  function chainFor(engine) {
    if (engine && engine !== 'auto' && ENGINES[engine]) return [engine];
    return ['tencent', 'microsoft', 'google', 'mymemory'];
  }

  async function translateChunk(texts, engine, target, depth) {
    const chain = chainFor(engine);
    let lastErr = null;
    for (const name of chain) {
      try {
        return await withRetry(function () {
          return ENGINES[name].fn(texts, target);
        }, chain.length > 1 ? 0 : 1);
      } catch (e) {
        lastErr = e;
      }
    }
    // 整批失败时拆分，避免一条坏文本拖累整页
    const msg = String(lastErr && lastErr.message || '');
    const fatal = /HTTP 429|HTTP 5\d\d|fetch failed|Failed to fetch|无法连接|超时|timeout|abort|额度/i.test(msg);
    if (texts.length > 1 && !fatal && (depth || 0) < 6) {
      const mid = Math.ceil(texts.length / 2);
      const left = await translateChunk(texts.slice(0, mid), engine, target, (depth || 0) + 1);
      const right = await translateChunk(texts.slice(mid), engine, target, (depth || 0) + 1);
      return left.concat(right);
    }
    throw lastErr || new Error('免费翻译失败');
  }

  /**
   * 免费翻译入口。会自动拆分超长文本、按块合并，并保持与输入一一对应。
   */
  async function translateFree(texts, opts) {
    const options = opts || {};
    const target = options.target || 'zh-CN';
    const engine = options.engine || 'auto';
    const list = Array.isArray(texts) ? texts.map(function (t) { return String(t == null ? '' : t); }) : [];

    const groups = [];
    const items = [];
    for (const t of list) {
      if (!t.trim()) {
        groups.push({ start: 0, count: 0 });
        continue;
      }
      const pieces = splitText(t, MAX_TEXT);
      groups.push({ start: items.length, count: pieces.length });
      items.push.apply(items, pieces);
    }

    const outItems = new Array(items.length).fill('');
    const chunkErrors = [];
    if (items.length) {
      const chunks = chunkTexts(items);
      let idx = 0;
      async function worker() {
        while (idx < chunks.length) {
          const my = idx++;
          let offset = 0;
          for (let c = 0; c < my; c++) offset += chunks[c].length;
          try {
            const translated = await translateChunk(chunks[my], engine, target, 0);
            for (let i = 0; i < translated.length; i++) outItems[offset + i] = translated[i];
          } catch (e) {
            chunkErrors.push(e);
          }
        }
      }
      await Promise.all([worker(), worker()]);
      if (chunkErrors.length && outItems.every(function (x) { return !x; })) {
        throw chunkErrors[0];
      }
    }

    const out = [];
    for (const g of groups) {
      if (!g.count) { out.push(''); continue; }
      out.push(outItems.slice(g.start, g.start + g.count).join(' ').trim());
    }
    return out;
  }

  NS.translateFree = translateFree;
  NS.splitText = splitText;
  NS.langOf = langOf;
  NS.ENGINES = ENGINES;
  self.AIT_Engines = NS;
})();
