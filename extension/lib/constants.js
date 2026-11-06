/* 全局常量：目标语言、AI 服务商预设、默认设置。 */

const AIT_TARGETS = [
  { code: 'zh-CN', label: '简体中文', short: '简中' },
  { code: 'zh-TW', label: '繁體中文', short: '繁中' },
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'ja', label: '日本語', short: 'JA' },
  { code: 'ko', label: '한국어', short: 'KO' },
  { code: 'fr', label: 'Français', short: 'FR' },
  { code: 'de', label: 'Deutsch', short: 'DE' },
  { code: 'es', label: 'Español', short: 'ES' },
  { code: 'ru', label: 'Русский', short: 'RU' },
  { code: 'pt', label: 'Português', short: 'PT' },
  { code: 'it', label: 'Italiano', short: 'IT' },
  { code: 'ar', label: 'العربية', short: 'AR' },
  { code: 'tr', label: 'Türkçe', short: 'TR' },
  { code: 'vi', label: 'Tiếng Việt', short: 'VI' },
  { code: 'th', label: 'ไทย', short: 'TH' },
  { code: 'id', label: 'Bahasa Indonesia', short: 'ID' },
  { code: 'hi', label: 'हिन्दी', short: 'HI' },
  { code: 'nl', label: 'Nederlands', short: 'NL' },
  { code: 'pl', label: 'Polski', short: 'PL' }
];

const AIT_FREE_ENGINES = [
  { id: 'auto', label: '自动选择（推荐）', desc: '腾讯 → 微软 → 谷歌 → MyMemory 依次尝试' },
  { id: 'tencent', label: '腾讯交互翻译', desc: '国内直连，免费无密钥' },
  { id: 'microsoft', label: '微软 Edge 翻译', desc: '质量稳定，网络有时受限' },
  { id: 'google', label: 'Google 翻译', desc: '语种最全，国内需网络条件' },
  { id: 'mymemory', label: 'MyMemory', desc: '免费备用，有字数限制' }
];

const AIT_AI_PRESETS = {
  'opencode-go': {
    label: 'OpenCode Go',
    api: 'openai',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'glm-5.3-flash',
    needsKey: true,
    hint: '你的 OpenCode Go 订阅。默认用 GLM-5.3-Flash，便宜、中文表达稳；也可改成 glm-5.3 / deepseek-v4.1-flash 等。',
    docs: 'https://opencode.ai/console'
  },
  deepseek: {
    label: 'DeepSeek',
    api: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    needsKey: true,
    hint: '性价比高，中文表达自然。模型可填 deepseek-chat。',
    docs: 'https://platform.deepseek.com/api_keys'
  },
  zhipu: {
    label: '智谱 GLM',
    api: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    needsKey: true,
    hint: 'glm-4-flash 有免费额度，适合日常精译。',
    docs: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  qwen: {
    label: '阿里通义千问',
    api: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needsKey: true,
    hint: '阿里云百炼平台，OpenAI 兼容接口。',
    docs: 'https://bailian.console.aliyun.com/'
  },
  moonshot: {
    label: '月之暗面 Kimi',
    api: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsKey: true,
    hint: '长文本理解好，适合文章类页面。',
    docs: 'https://platform.moonshot.cn/console/api-keys'
  },
  siliconflow: {
    label: '硅基流动',
    api: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    needsKey: true,
    hint: '聚合多种开源模型，模型名可在官网查询。',
    docs: 'https://cloud.siliconflow.cn/account/ak'
  },
  openai: {
    label: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    hint: '需要海外网络环境；gpt-4o-mini 速度快、成本低。',
    docs: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    label: 'Google Gemini',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    needsKey: true,
    hint: 'Google AI Studio 免费额度较充足，需海外网络。',
    docs: 'https://aistudio.google.com/apikey'
  },
  claude: {
    label: 'Anthropic Claude',
    api: 'claude',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    needsKey: true,
    hint: '长文翻译质量好；浏览器直连已附加所需请求头。',
    docs: 'https://console.anthropic.com/settings/keys'
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsKey: true,
    hint: '一个 Key 调用多家模型，模型名格式为 vendor/model。',
    docs: 'https://openrouter.ai/keys'
  },
  ollama: {
    label: '本地 Ollama / LM Studio',
    api: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    hint: '本地模型不耗 API 费用；使用 LM Studio 时端口通常为 1234。',
    docs: 'https://ollama.com/'
  },
  custom: {
    label: '自定义 OpenAI 兼容接口',
    api: 'openai',
    baseUrl: '',
    model: '',
    needsKey: false,
    hint: '填入任何兼容 /chat/completions 的地址与模型名。',
    docs: ''
  }
};

const AIT_DEFAULT_SETTINGS = {
  targetLang: 'zh-CN',
  displayMode: 'below',          // below | above | replace
  engine: 'free',                // free | ai
  freeEngine: 'auto',

  autoTranslate: false,          // 全局：打开网页就翻译（站点规则可覆盖）
  dynamic: true,                 // 翻译动态加载的新内容
  floating: true,                // 页面右下角悬浮球
  selection: true,               // 划词翻译
  hover: false,                  // 按住 Alt 悬停翻译
  inputBox: true,                // Ctrl+Shift+Enter 翻译输入框
  skipSelectors: '',             // 额外跳过区域，CSS 选择器

  aiProvider: 'opencode-go',
  aiApiKey: '',
  aiBaseUrl: 'https://opencode.ai/inference/go/openai/v1',
  aiModel: 'glm-5.3-flash',
  aiTemperature: 0.2,
  aiBatch: 12,
  autoUpgrade: false,            // 免费结果疑似失败时自动 AI 补译
  customPrompt: '',
  opencodeSession: '',

  style: {
    color: '#1a73e8',
    size: 0.94,
    separator: true,
    theme: 'auto'
  },

  siteRules: {},                 // { "example.com": "auto" | "never" }
  cacheEnabled: true
};

const AIT_MSG = {
  TRANSLATE: 'translate',
  GET_CONFIG: 'get-config',
  PAGE_TRANSLATE: 'page-translate',
  PAGE_RESTORE: 'page-restore',
  PAGE_STATUS: 'page-status',
  PAGE_STATE: 'page-state',
  TRANSLATE_SELECTION: 'translate-selection',
  OPEN_OPTIONS: 'open-options',
  ADD_TERM: 'add-term',
  AI_TEST: 'ai-test',
  CLEAR_CACHE: 'clear-cache',
  CONFIG_CHANGED: 'config-changed'
};

self.AIT_TARGETS = AIT_TARGETS;
self.AIT_FREE_ENGINES = AIT_FREE_ENGINES;
self.AIT_AI_PRESETS = AIT_AI_PRESETS;
self.AIT_DEFAULT_SETTINGS = AIT_DEFAULT_SETTINGS;
self.AIT_MSG = AIT_MSG;
