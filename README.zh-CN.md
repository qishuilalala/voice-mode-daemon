# Voice Mode Daemon（本地语音加速守护进程与浏览器扩展）

**简体中文** | [English](./README.md)

面向 **Voice Mode** 生态的原生 Node.js 本地回环语音加速守护进程（`@voice-mode/daemon`）与 Chrome / Edge Manifest V3 侧边栏扩展（`@voice-mode/browser-extension`）。

## 核心特性

- **绕过 Electron V8 内存笼与浏览器 WASM 上限**：通过原生 `sherpa-onnx-node` 驱动 `Kokoro v1.1`（`103` 款中英多语言音色，`24 kHz`）、`Streaming Zipformer2`（中英双语识别）与 `SenseVoice Small int8`（中/英/日/韩/粤五语识别）。
- **单份磁盘缓存、单实例内存共享**：Obsidian（`app://obsidian.md`）、SillyTavern（`http://127.0.0.1:*`）与 Chrome/Edge MV3 扩展（`chrome-extension://*`）共享 `~/.cache/voice-mode/models/`（并支持只读发现 `~/.cache/dsh-voice-mode/models/`），同一模型在内存中仅驻留 1 份实例。
- **回环安全加固**：严格绑定 `127.0.0.1:18790`，校验回环 `Host` 阻断 DNS 重绑定，严格 `Origin` 白名单拦截恶意网页跨域请求（`403`），并以 `crypto.timingSafeEqual` 校验 `0o600` 权限的 256 位随机 Bearer 令牌（`~/.cache/voice-mode/daemon.token`）。
- **亚秒级自动回退（`< 1,000 ms`）**：当守护进程离线或令牌不匹配时，客户端在 1 秒内自动切换至浏览器原生 `speechSynthesis` 或用户自配 BYOK 云端接口，绝不卡死。
- **符合商店规范的 MV3 扩展**：零 `<all_urls>`、零 `*://*/*`、零远程代码与 `eval()`、零逆向网页版 WebSocket 接口；支持跳过代码块与管道表格朗读聊天回复，并将口述文本经词表纠错后直接注入 DeepSeek、Gemini、Kimi 等网页输入框。

## 环境要求

- Node.js `>= 22.18.0`
- `pnpm` `12.x`

## 快速开始

```bash
pnpm install
pnpm run build

# 查看本地共享模型缓存状态
node packages/voice-daemon/dist/cli.js models status

# 下载并校验 SHA-256 模型包（国内可选 --mirror https://hf-mirror.com）
node packages/voice-daemon/dist/cli.js models download all

# 启动本地回环守护进程（默认 127.0.0.1:18790）
node packages/voice-daemon/dist/cli.js serve

# 查看 0o600 令牌文件路径（命令行与日志绝不打印密钥明文）
node packages/voice-daemon/dist/cli.js token-path
```

## 加载 Chrome / Edge MV3 扩展

1. 执行 `pnpm run build`。
2. 打开 `chrome://extensions`（或 `edge://extensions`），开启**开发者模式**，点击**加载已解压的扩展程序**。
3. 选择目录 `packages/browser-extension/dist`。
4. 打开 **Voice Mode** 侧边栏，粘贴 `~/.cache/voice-mode/daemon.token` 中的令牌并点击 **Save & Probe**。

## 全量门禁校验

```bash
pnpm run check:all
```

## 开源许可

仓库源码采用 [MIT 许可证](./LICENSE)。语音模型权重与运行时 `espeak-ng-data`（GPL-3.0）音素数据仅在用户本地缓存目录按需下载，绝不打包进本仓库或发布产物。
