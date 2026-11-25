# Voice Mode Daemon（本地语音守护进程与浏览器扩展）

**简体中文** | [English](./README.md)

Voice Mode Daemon 在电脑上运行语音模型，为浏览器扩展、Obsidian 和 SillyTavern 等宿主提供本地朗读和听写。本仓库包含 Node.js 守护进程（`@voice-mode/daemon`）及 Chrome / Edge Manifest V3 侧边栏扩展（`@voice-mode/browser-extension`）。

> **定位：面向开发者与高阶用户的可选后端。** 本仓库不提供安装包，也不上架 Chrome / Edge 商店，需要从源码构建运行（Node.js `>= 22.18.0`、pnpm `12.21.0`、`pnpm run build`、`voice-daemon models download`）。`obsidian-voice-mode` 与 `sillytavern-voice-mode` 将它作为可选的 `kokoro-daemon` 后端，以获得更好的本地音色与识别；不安装它，两个插件仍可正常使用。

## 核心功能

- **本地语音模型。** 通过原生 `sherpa-onnx-node` 运行 Kokoro v1.1（103 款音色，24 kHz）、Streaming Zipformer2（中英双语识别）和 SenseVoice Small int8（中、英、日、韩、粤语识别）。
- **共享模型缓存。** 宿主连接同一个守护进程时，可共享 `~/.cache/voice-mode/models/` 中的模型。守护进程为每个已加载模型保留一份内存实例，并可只读使用旧目录 `~/.cache/dsh-voice-mode/models/` 中符合要求的模型文件。
- **回环认证。** 服务默认监听 `127.0.0.1:18790`，校验 `Host` 和 `Origin`，并用 Bearer 令牌保护 API。首次运行将生成带有 `sk-vmd-` 前缀的 192 位随机令牌，默认保存在 `~/.cache/voice-mode/daemon.token`。macOS 和 Linux 上文件权限为 `0600`。
- **浏览器侧边栏。** 扩展支持朗读选中文本或聊天回复，也能听写并将结果插入当前网页输入框。侧边栏中的 Markdown 会跳过围栏代码块和管道表格。DeepSeek、Gemini 和 Kimi 需要在侧边栏授权。

## 环境要求

- Node.js `>= 22.18.0`
- pnpm `12.21.0`（见 `package.json`）

## 启动本地守护进程

在仓库根目录运行以下命令。

```bash
pnpm install --frozen-lockfile
pnpm run build

# 查看本地共享模型缓存状态
node packages/voice-daemon/dist/cli.js models status

# 下载模型包并校验 SHA-256（可选 --mirror https://hf-mirror.com）
node packages/voice-daemon/dist/cli.js models download all

# 启动守护进程（默认 127.0.0.1:18790，保持此终端运行）
node packages/voice-daemon/dist/cli.js serve
```

另开一个终端，查看访问令牌文件的位置。此命令只输出文件路径。

```bash
node packages/voice-daemon/dist/cli.js token-path
```

只需要朗读时，可以将 `models download all` 换成 `models download kokoro-int8`。其他可单独下载的模型包为 `zipformer2` 和 `sensevoice-int8`。

## 加载 Chrome / Edge 扩展

1. 执行 `pnpm run build`。
2. 打开 `chrome://extensions`（或 `edge://extensions`），开启**开发者模式**，点击**加载已解压的扩展程序**。
3. 选择目录 `packages/browser-extension/dist`。
4. 从工具栏打开 **Voice Mode** 侧边栏。用文本编辑器打开令牌文件，将整行 `sk-vmd-…` 令牌粘贴到 **守护进程访问令牌**，然后点击 **保存并检测**（英文为 **Save & Probe**）。
5. 看到 **已连接本地语音守护进程** 后，可先在侧边栏输入一句话，点击 **朗读文本**。要朗读聊天页面，点击 **授权聊天网站** 后，在相应页面选择文本，再点击 **朗读选区或回复**。
6. 听写时，授权聊天网站后，先在网页点击目标输入框，再在侧边栏点击 **打开麦克风**。首次使用时按浏览器提示授权。口述后点击 **关闭麦克风**，可在 **听写预览** 查看结果，或点击 **插入当前输入框** 手动插入。

侧边栏跟随浏览器的界面语言，简体中文对应 `zh-CN`，默认语言为英文。连接成功表示守护进程通过认证并正常响应，可用 `models status` 检查模型包是否就绪。

## 连接失败和回退

- **令牌无效。** 从 `token-path` 指向的文件重新复制当前令牌。若启动服务时指定了 `--token-file`，查找令牌时也使用同一个参数。
- **无法连接。** 确认 `serve` 仍在运行，侧边栏地址与启动日志中的端口一致。扩展的健康探测超时为 500 ms，模型加载、推理以及云端响应的耗时取决于设备和网络。
- **使用浏览器或云端回退。** 云端回退填写兼容 OpenAI 的 API 地址和自备密钥，服务须允许浏览器跨域请求，并会收到朗读文本或听写音频。未配置时，朗读可回退到浏览器语音合成。本地守护进程不可用时，新发起的听写可使用浏览器语音识别，具体取决于浏览器支持，识别可能需要联网。

## 本地 HTTP 接口

默认地址为 `http://127.0.0.1:18790`。调用以下接口时使用 `Authorization: Bearer <token>`。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/health` | 查询版本、能力、已加载模型和音色列表 |
| `GET /v1/models/status` | 查询磁盘缓存中的模型包状态 |
| `POST /v1/audio/speech` | 接收含 `input`、`voice`、`speed` 的 JSON，返回 24 kHz PCM16 WAV |
| `POST /v1/audio/transcriptions` | 接收 `multipart/form-data` 中的 WAV `file` 和 `model`（`zipformer2` 或 `sensevoice`），返回 `text`、`language`、`durationMs` |

## 开发与验证

```bash
# 构建、类型检查、lint、测试及扩展发布规则检查
pnpm run check:all
```

查看[架构与代码入口](./CONTEXT.md)、[代码规范](./CODING_STANDARDS.md)、[术语表](./GLOSSARY.md)和[安全边界与漏洞报告](./SECURITY.md)。

## 开源许可

仓库源码采用 [MIT 许可证](./LICENSE)。模型权重及 `espeak-ng-data`（GPL-3.0）音素数据按需下载到用户本地缓存，遵循各自的上游许可证。
