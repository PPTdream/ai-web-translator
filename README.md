# AI 网页翻译助手

> Edge / Chromium Manifest V3 翻译扩展：免费整页双语翻译 + AI 精译 + 本地术语库 + 按段缓存。
>
> 本仓库为私有备份，暂不公开、未上架扩展商店。

## 功能

- **整页翻译**：原文下方 / 原文上方 / 仅显示译文三种模式，支持还原
- **AI 精译**：免费结果不准确时，一键用自己的 AI 订阅重翻整页
- **划词翻译**：选中文字弹气泡，可复制、朗读、AI 精译
- **悬停翻译**：按住 Alt 悬停段落显示译文
- **输入框翻译**：Ctrl+Shift+Enter 翻译输入框，可替换原文
- **动态内容**：社媒、素材站、单页应用新加载的内容自动补译
- **站点规则**：始终自动翻译 / 从不自动翻译
- **术语库**：保留英文 / 指定译法两种策略，免费与 AI 共用；支持 CSV/JSON 导入导出
- **按段缓存**：未变段落命中缓存，内容更新只重翻变化段落
- **多 AI 服务商**：OpenCode Go（默认 GLM-5.3-Flash）、DeepSeek、智谱、通义、Kimi、OpenAI、Gemini、Claude、OpenRouter、Ollama / LM Studio、自定义 OpenAI 兼容接口

## 架构

```text
网页 DOM
  └─ content.js：收集文本单元 / 插入译文 / 划词 / 悬停 / 输入框
       └─ chrome.runtime.sendMessage
            └─ background.js：翻译路由 / 缓存 / 术语库 / 免费引擎 / AI
                 ├─ 腾讯 → 微软 → 谷歌 → MyMemory（免费降级）
                 └─ OpenAI 兼容 / Gemini / Claude（AI 精译）
```

关键边界：**内容脚本只操作 DOM，不直接请求翻译 API**；所有网络请求都在后台 Service Worker，避免目标页面 CSP `connect-src` 限制。

## 安装

Edge 137+ 已停用命令行自动加载，需要手动加载一次：

1. 打开 `edge://extensions`
2. 打开「开发人员模式」
3. 点「加载解压缩的扩展」
4. 选择 `extension/` 文件夹（能看到 `manifest.json` 的那一层）
5. 固定到工具栏，刷新已打开的网页

也可以双击 `一键安装.bat` 打开扩展页并复制路径。

## AI 配置

设置 → AI 引擎：

- 默认已选中 **OpenCode Go / `glm-5.3-flash`**
- 点「从 OpenCode 导入 Key」，选择本机 `%USERPROFILE%\.local\share\opencode\auth.json`
- 点「测试连接」
- 也可以手动换成任意 OpenAI 兼容接口

API Key 只保存在本机 `chrome.storage.local`，仓库内不包含任何真实 Key。

## 术语库

- 默认内置 200+ 条 AI / 金融 / 社媒 / 素材术语
- 免费通道：占位符保护术语，翻译后还原
- AI 通道：命中的术语写入提示词
- 修改术语库会让旧缓存失效，确保新术语立即生效

## 目录

```text
extension/
  manifest.json
  background.js
  content.js
  popup.html / popup.css / popup.js
  options.html / options.css / options.js
  lib/
    constants.js
    default-terms.js
    termbase.js
    engines.js
    ai.js
  ai-translation-rules.js
  icons/
一键安装.bat
打开OpenCode配置文件夹.bat
使用说明.txt
```

## 隐私

- 免费翻译会把待翻译文本发送到腾讯 / 微软 / 谷歌 / MyMemory 的公共翻译接口
- AI 精译会把文本发送到你配置的 AI 服务商
- Key、设置、术语库、翻译缓存只存在本机扩展存储
- 扩展没有自建服务器，不收集浏览记录

## 已知边界

- Shadow DOM 内容暂未递归翻译（P1）
- PDF、视频字幕、图片 OCR 暂不支持
- 代码文件页的 `<pre><code>` 内容按设计不翻译
- Edge 更新/扩展重载后，旧标签页需要重新加载扩展并刷新

## 版本

v2.0.0 · 2026-11
