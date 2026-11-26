# Contributing to Voice Mode Daemon / 贡献指南

感谢参与缺陷报告、文档完善与代码贡献。参与社区协作即表示同意遵守[社区行为准则](CODE_OF_CONDUCT.md)。

> 本项目是 **developer-only 可选后端**：只监听回环地址、零遥测、不承诺 SLA。贡献请保持这个边界。

## 开发环境

- **Node.js** `>= 22.18.0`；**pnpm** `12.21.0`（`pnpm install --frozen-lockfile`）
- pnpm 工作区：`packages/voice-daemon`（CLI/HTTP/WS/MCP）与 `packages/browser-extension`（MV3 扩展）
- 原生依赖 `sherpa-onnx-node`（onnxruntime）需要可用的预编译二进制；平台不支持时用 mock backend 测试
- 共享内核 `@voice-mode/core` 来自 `vendor/` 归档，**不要直接改 `vendor/`**（真源在母仓 `obsidian-voice-mode`）

## 本地验证

```bash
pnpm run check:all        # typecheck → lint → test → build → MV3/许可/版本 gate
pnpm run verify:mcp       # 真实 daemon + MCP stdio 端到端（Linux 可跑）
pnpm run check:api-doc    # 真实 daemon 与 docs/API.md 字段一致性（Linux 可跑）
```

- 修改 HTTP/WS 端点或响应字段时，必须同步更新 `docs/API.md`（`check:api-doc` 会守护）
- 依赖/许可红线：零权重、零 GPL 打包（`espeak-ng-data` 仅运行时下载并披露）
- 复用共享内核时在母仓运行 `pnpm run verify:matrix --require-all /mnt`

## 提交规范

- 提交信息中文、简短专业；一次一件事；不提交密钥/本地路径/私人音频
- 安全边界（loopback-only、Host/Origin 校验、Bearer）不可放宽
