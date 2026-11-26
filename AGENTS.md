# AGENTS.md — voice-mode-daemon（developer-only）

> 面向在本仓库工作的 AI 编码代理。服务器级基线见 `~/.dsh/AGENTS.md`；本文件只放本仓库特有约束。
> 单一真源：`CONTEXT.md`、`CODING_STANDARDS.md`、`GLOSSARY.md`、`SECURITY.md`。

## 命令

- `pnpm run check:all`：typecheck → lint → test → build → release gate（提交前必跑）。
- 共享内核来自 `vendor/` tgz；同步后跑 `pnpm install --lockfile-only` + `check:all`。

## 硬约束

1. 本产品 **developer-only**：不发布、不上架、不做商店物料。
2. 仅绑定回环地址 + Bearer；错误体保持 `{error:{message,type,code}}`；不新增未脱敏错误。
3. 模型权重/GPL 音素数据不入仓；下载必须 allowlist + SHA256。
4. 能力变化同步 `/v1/capabilities` 与 `/v1/models`（source: `@voice-mode/core` 契约）。
5. TTS 输入 ≤8000 字符、ASR ≤25MiB；新增端点必须更新 README 与 `docs/13` 契约。

## 禁止

- 不 `git add -A`；提交白名单。
- 不擅自发布/上架。
- 不启用声音克隆；不做多角色同时说话。
