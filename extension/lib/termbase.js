/* 术语库：规范化、匹配、遮罩保护、CSV/JSON 导入导出。 */

(function () {
  const NS = {};

  const POLICY_KEEP = 'keep';
  const POLICY_TRANSLATE = 'translate';

  function uid(prefix) {
    return (prefix || 't') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function hashString(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function normalizePolicy(p) {
    const v = String(p == null ? '' : p).trim().toLowerCase();
    if (!v) return POLICY_KEEP;
    if (/^(keep|保留|保留英文|原文|不译|不翻译|keep\s*english)$/i.test(v)) return POLICY_KEEP;
    if (/^(translate|翻译|指定|指定译法|中文|译法|译)$/i.test(v)) return POLICY_TRANSLATE;
    return POLICY_KEEP;
  }

  function sanitizeEntry(raw) {
    if (!raw) return null;
    let source = '';
    let target = '';
    let policy = '';
    let category = '';
    let note = '';
    let enabled = true;
    let id = '';

    if (Array.isArray(raw)) {
      source = raw[0];
      target = raw[1];
      policy = raw[2];
      category = raw[3];
      note = raw[4];
    } else if (typeof raw === 'string') {
      const m = raw.split(/\s*(?:=>|=|\t)\s*/);
      source = m[0] || '';
      target = m[1] || '';
      policy = m[2] || '';
    } else {
      source = raw.source != null ? raw.source : (raw.src != null ? raw.src : (raw.en != null ? raw.en : raw.term));
      target = raw.target != null ? raw.target : (raw.dst != null ? raw.dst : (raw.zh != null ? raw.zh : raw.translation));
      policy = raw.policy != null ? raw.policy : (raw.rule != null ? raw.rule : raw.strategy);
      category = raw.category != null ? raw.category : raw.tag;
      note = raw.note != null ? raw.note : (raw.remark != null ? raw.remark : raw.description);
      enabled = raw.enabled !== false;
      id = raw.id || '';
    }

    source = String(source == null ? '' : source).trim().slice(0, 200);
    target = String(target == null ? '' : target).trim().slice(0, 500);
    category = String(category == null ? '' : category).trim().slice(0, 40) || '自定义';
    note = String(note == null ? '' : note).trim().slice(0, 500);
    policy = normalizePolicy(policy);
    if (!source) return null;
    if (!target) target = source;
    if (policy === POLICY_KEEP) target = target || source;

    return {
      id: id || uid('t'),
      source: source,
      target: target,
      policy: policy,
      category: category,
      note: note,
      enabled: enabled !== false
    };
  }

  function normalizeEntries(input) {
    let arr = input;
    if (!Array.isArray(arr)) {
      if (arr && Array.isArray(arr.entries)) arr = arr.entries;
      else if (arr && Array.isArray(arr.terms)) arr = arr.terms;
      else arr = [];
    }
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      const e = sanitizeEntry(item);
      if (!e) continue;
      const key = e.source.toLowerCase() + '|' + e.policy;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  function normalizeTermbase(input) {
    let entries = [];
    let updatedAt = Date.now();
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      entries = normalizeEntries(input.entries || input.terms || []);
      updatedAt = Number(input.updatedAt) || updatedAt;
      return { version: 1, updatedAt: updatedAt, entries: entries };
    }
    entries = normalizeEntries(input);
    return { version: 1, updatedAt: updatedAt, entries: entries };
  }

  function defaultEntries() {
    const raw = (typeof AIT_DEFAULT_TERMS_RAW !== 'undefined') ? AIT_DEFAULT_TERMS_RAW : [];
    return normalizeEntries(raw);
  }

  function mergeDefaults(entries) {
    const current = normalizeEntries(entries);
    const existing = new Set(current.map(function (e) {
      return e.source.toLowerCase() + '|' + e.policy;
    }));
    let added = 0;
    for (const e of defaultEntries()) {
      const key = e.source.toLowerCase() + '|' + e.policy;
      if (existing.has(key)) continue;
      existing.add(key);
      current.push(e);
      added++;
    }
    return { entries: current, added: added };
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function makeMatcher(entries) {
    const list = normalizeEntries(entries).filter(function (e) {
      return e.enabled && e.source && e.policy;
    });
    if (!list.length) {
      return { re: null, list: [], byLower: new Map(), version: '0' };
    }
    list.sort(function (a, b) {
      return b.source.length - a.source.length;
    });
    const byLower = new Map();
    const parts = [];
    for (const e of list) {
      const lower = e.source.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, e);
      else if (e.policy === POLICY_TRANSLATE && byLower.get(lower).policy === POLICY_KEEP) byLower.set(lower, e);
      let p = escapeRegExp(e.source);
      const first = e.source.charAt(0);
      const last = e.source.charAt(e.source.length - 1);
      // 允许英文术语的常见复数形式：Agent/Agents、API/APIs、rate cut/rate cuts
      if (/[\p{L}]/u.test(last) && !/s$/i.test(e.source) && e.source.length > 1) {
        p += '(?:s|es)?';
      }
      if (/[\p{L}\p{N}_]/u.test(first)) p = '(?<![\\p{L}\\p{N}_])' + p;
      if (/[\p{L}\p{N}_]/u.test(last)) p = p + '(?![\\p{L}\\p{N}_])';
      parts.push(p);
    }
    let re = null;
    try {
      re = new RegExp(parts.join('|'), 'giu');
    } catch (err) {
      try { re = new RegExp(parts.join('|'), 'gi'); } catch (e2) { re = null; }
    }
    const version = hashString(list.map(function (e) {
      return e.source + '>' + e.target + '>' + e.policy + '>' + (e.enabled ? 1 : 0);
    }).join('\n'));
    return { re: re, list: list, byLower: byLower, version: version };
  }

  function entryForMatch(byLower, matched) {
    const m = String(matched || '');
    let e = byLower.get(m.toLowerCase());
    if (e) return e;
    if (/ies$/i.test(m)) {
      e = byLower.get(m.slice(0, -3).toLowerCase() + 'y');
      if (e) return e;
    }
    if (/es$/i.test(m)) {
      e = byLower.get(m.slice(0, -2).toLowerCase());
      if (e) return e;
    }
    if (/s$/i.test(m)) {
      e = byLower.get(m.slice(0, -1).toLowerCase());
      if (e) return e;
    }
    return null;
  }

  /**
   * 把文本中的术语替换为占位符，翻译完成后再还原。
   * keep 策略还原原文，translate 策略还原指定译法。
   */
  function maskText(text, matcher) {
    const src = String(text == null ? '' : text);
    if (!matcher || !matcher.re || !matcher.byLower.size) {
      return { masked: src, terms: [] };
    }
    const terms = [];
    const masked = src.replace(matcher.re, function (m) {
      const entry = entryForMatch(matcher.byLower, m);
      if (!entry) return m;
      const replacement = entry.policy === POLICY_TRANSLATE ? entry.target : m;
      const idx = terms.length;
      terms.push({ token: 'ZXQTERM' + idx + 'QXZ', text: replacement });
      return 'ZXQTERM' + idx + 'QXZ';
    });
    return { masked: masked, terms: terms };
  }

  function restoreMasks(text, terms) {
    const s = String(text == null ? '' : text);
    if (!terms || !terms.length) return s;
    return s.replace(/ZXQ\s*TERM\s*(\d+)\s*QXZ/gi, function (all, n) {
      const item = terms[parseInt(n, 10)];
      return item ? item.text : all;
    });
  }

  function findMatchedEntries(entries, texts, limit) {
    const matcher = makeMatcher(entries);
    if (!matcher.re) return [];
    const joined = Array.isArray(texts) ? texts.join('\n') : String(texts || '');
    const found = new Map();
    let m;
    matcher.re.lastIndex = 0;
    while ((m = matcher.re.exec(joined))) {
      const entry = entryForMatch(matcher.byLower, m[0]);
      if (entry && !found.has(entry.id)) found.set(entry.id, entry);
      if (limit && found.size >= limit) break;
      if (m.index === matcher.re.lastIndex) matcher.re.lastIndex++;
    }
    return Array.from(found.values());
  }

  // ---------- CSV ----------

  function parseCSV(text, delimiter) {
    const delim = delimiter || ',';
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); field = '';
        if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    row.push(field);
    if (row.some(function (x) { return String(x).trim() !== ''; })) rows.push(row);
    return rows;
  }

  function looksLikeHeader(row) {
    if (!row || !row.length) return false;
    const cells = row.map(function (c) { return String(c || '').trim(); });
    const isSource = /^(source|原文|英文|术语|term|en)(\s|$|\(|（|:|\/)/i;
    const isTarget = /^(target|translation|中文|译文|译法|翻译|释义|zh|dst)(\s|$|\(|（|:|\/)/i;
    const isMeta = /^(policy|rule|规则|策略|方式|category|tag|分类|领域|note|remark|备注|说明|enabled|启用)(\s|$|\(|（|:|\/)/i;
    let sourceHit = false;
    let targetHit = false;
    let metaHits = 0;
    for (let i = 0; i < cells.length; i++) {
      if (isSource.test(cells[i])) sourceHit = true;
      if (isTarget.test(cells[i])) targetHit = true;
      if (isMeta.test(cells[i])) metaHits++;
    }
    return (sourceHit && targetHit) || (sourceHit && metaHits >= 1) || (targetHit && metaHits >= 1);
  }

  function headerIndex(row, names, fallback) {
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] || '').trim().toLowerCase();
      for (const n of names) {
        if (cell === n.toLowerCase() || cell.indexOf(n.toLowerCase()) !== -1) return i;
      }
    }
    return fallback;
  }

  function parseImport(text, filename) {
    let raw = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    const name = String(filename || '').toLowerCase();

    if (raw.charAt(0) === '[' || raw.charAt(0) === '{') {
      try {
        const data = JSON.parse(raw);
        return normalizeEntries(data);
      } catch (e) { /* 继续按文本解析 */ }
    }

    const firstLine = raw.split('\n')[0] || '';
    let delim = ',';
    if (firstLine.indexOf('\t') !== -1) delim = '\t';
    else if (firstLine.indexOf(',') === -1 && firstLine.indexOf('|') !== -1) delim = '|';

    const rows = parseCSV(raw, delim);
    if (!rows.length) return [];
    let start = 0;
    let map = { source: 0, target: 1, policy: 2, category: 3, note: 4 };
    if (looksLikeHeader(rows[0])) {
      const h = rows[0];
      map = {
        source: headerIndex(h, ['source', '英文', '原文', '术语', 'term', 'en'], 0),
        target: headerIndex(h, ['target', '中文', '译法', '翻译', 'zh', 'dst'], 1),
        policy: headerIndex(h, ['policy', 'rule', '规则', '策略', '方式'], -1),
        category: headerIndex(h, ['category', 'tag', '分类', '领域'], -1),
        note: headerIndex(h, ['note', 'remark', '备注', '说明'], -1)
      };
      start = 1;
    }

    const entries = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.length) continue;

      // 兼容「英文=中文」「英文 => 中文」的逐行格式混在 CSV 里
      if (r.length === 1 && /=>|[\uFF1D=]/.test(String(r[0] || ''))) {
        const parts = String(r[0]).split(/\s*(?:=>|=|\uFF1D)\s*/);
        if (parts.length >= 2 && parts[0].trim()) {
          const e = sanitizeEntry({
            source: parts[0],
            target: parts[1],
            policy: parts[2] || (parts[0].trim() === parts[1].trim() ? 'keep' : 'translate'),
            category: '导入'
          });
          if (e) entries.push(e);
          continue;
        }
      }

      const source = r[map.source];
      let target = map.target >= 0 ? r[map.target] : '';
      let policy = map.policy >= 0 ? r[map.policy] : '';
      const category = map.category >= 0 ? r[map.category] : '';
      const note = map.note >= 0 ? r[map.note] : '';
      if (!source || !String(source).trim()) continue;
      if (!policy) policy = String(target || '').trim() === String(source).trim() ? 'keep' : 'translate';
      const e = sanitizeEntry({
        source: source,
        target: target,
        policy: policy,
        category: category || '导入',
        note: note,
        enabled: true
      });
      if (e) entries.push(e);
    }

    // 没有分隔符时，尝试「英文=中文」逐行格式
    if (!entries.length && /[=\uFF1D]|=>/.test(raw)) {
      for (const line of raw.split('\n')) {
        if (!line.trim() || line.trim().charAt(0) === '#') continue;
        const m = line.split(/\s*(?:=>|=|\uFF1D)\s*/);
        if (m.length >= 2 && m[0].trim()) {
          const e = sanitizeEntry({
            source: m[0],
            target: m[1],
            policy: m[2] || (m[0].trim() === m[1].trim() ? 'keep' : 'translate'),
            category: '导入'
          });
          if (e) entries.push(e);
        }
      }
    }

    return normalizeEntries(entries);
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(entries) {
    const rows = [['原文', '译法', '策略', '分类', '备注', '启用']];
    for (const e of normalizeEntries(entries)) {
      rows.push([
        e.source,
        e.target,
        e.policy === POLICY_KEEP ? '保留英文' : '指定译法',
        e.category,
        e.note,
        e.enabled ? '1' : '0'
      ]);
    }
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function stats(entries) {
    const list = normalizeEntries(entries);
    const cats = new Map();
    let enabled = 0;
    for (const e of list) {
      if (e.enabled) enabled++;
      cats.set(e.category, (cats.get(e.category) || 0) + 1);
    }
    return {
      total: list.length,
      enabled: enabled,
      categories: Array.from(cats.entries()).sort(function (a, b) { return b[1] - a[1]; })
    };
  }

  NS.uid = uid;
  NS.hashString = hashString;
  NS.normalizePolicy = normalizePolicy;
  NS.sanitizeEntry = sanitizeEntry;
  NS.normalizeEntries = normalizeEntries;
  NS.normalizeTermbase = normalizeTermbase;
  NS.defaultEntries = defaultEntries;
  NS.mergeDefaults = mergeDefaults;
  NS.makeMatcher = makeMatcher;
  NS.maskText = maskText;
  NS.restoreMasks = restoreMasks;
  NS.findMatchedEntries = findMatchedEntries;
  NS.parseImport = parseImport;
  NS.toCSV = toCSV;
  NS.stats = stats;
  NS.POLICY_KEEP = POLICY_KEEP;
  NS.POLICY_TRANSLATE = POLICY_TRANSLATE;

  self.AIT_Termbase = NS;
})();
