# agent-plugin-dsh

[English](README.en.md)

把复杂任务交给 **DeepSeek Harness（DSH）** 的 Codex、Claude Code 与 pi 插件。它让你的主代理可以委派实现、续接 DSH 会话、请求独立代码评审，以及管理后台作业。

## 目录

- [工作原理](#工作原理)
- [安装](#安装)
- [基本工作流](#基本工作流)
- [可选能力](#可选能力)
- [包含内容](#包含内容)
- [模型与权限](#模型与权限)
- [问题排查](#问题排查)
- [开发](#开发)
- [许可](#许可)

## 工作原理

1. 你在 Codex 或 pi 中用自然语言提出委派或评审请求，或在 Claude Code 中调用 `/dsh:*` 命令。
2. 插件通过共享入口 `scripts/dsh-companion.mjs` 启动 DSH 的 `acp` profile。
3. DSH 在当前工作区中执行任务，插件原样返回最终答复，或把长任务记录为后台作业。
4. Codex、Claude Code 与 pi 共用按工作区隔离的作业记录，因此可以跨宿主查询同一个任务。

插件不绑定 provider，也不维护自己的模型列表。模型、reasoning effort 和真正的沙箱策略都由 DSH 决定。

## 安装

需要：

- Node.js 18.18 或更高版本
- `dsh` 在 `PATH` 中可用
- DSH 中至少配置一个可用模型

如果同时使用多个宿主，需要分别安装。

### Codex

```sh
codex plugin marketplace add JiaMingWang-CN/codex-dsh
codex plugin add dsh@dsh
```

本地开发时，将仓库名换成仓库根目录的绝对路径。安装或更新后，新建一个 Codex 任务以加载最新技能。

### Claude Code

```sh
/plugin marketplace add JiaMingWang-CN/codex-dsh
/plugin install dsh@dsh
/reload-plugins
```

本地开发时，也可以把仓库名换成绝对路径。

### pi

```sh
pi install git:github.com/JiaMingWang-CN/codex-dsh   # 或 pi install <本地仓库路径>
```

本地开发时也可以用 `pi -e <仓库路径>` 临时加载，不写入设置。安装后新开一个 pi 会话即可；项目首次使用时 pi 会询问是否信任 `.pi` 目录，项目级扩展与技能只在信任后加载。本插件不发布到 npm（`private: true`），只支持本地路径与 git 源两种安装方式。

## 基本工作流

### 1. 检查环境

```sh
npm run setup
node scripts/dsh-companion.mjs models
```

`setup` 检查 DSH、profile、凭据来源和本工作区的状态目录；`models` 列出当前环境实际提供的 provider、模型和 effort 值。

### 2. 委派任务

在 Codex 中直接说：

> 让 DSH 调查并修复这个失败的测试。

在 Claude Code 中使用：

```text
/dsh:rescue 调查并修复这个失败的测试
```

在 pi 中调用 `dsh_task` 工具，或使用技能命令：

```text
/skill:dsh-delegate 调查并修复这个失败的测试
```

也可以直接运行共享脚本：

```sh
node scripts/dsh-companion.mjs task --wait "调查并修复这个失败的测试"
```

### 3. 管理长任务

```sh
node scripts/dsh-companion.mjs task --background "运行完整测试套件并修复失败项"
node scripts/dsh-companion.mjs status <job-id> --wait
node scripts/dsh-companion.mjs result <job-id>
node scripts/dsh-companion.mjs cancel <job-id>
```

在 Codex 中可以直接询问 DSH 作业状态；Claude Code 提供 `/dsh:status`、`/dsh:result` 和 `/dsh:cancel`；pi 提供 `dsh_jobs` 工具。

`--background` 是直接运行 CLI 时的选项。通过技能或斜杠命令委派时（Codex 的 `dsh-delegate` / `dsh-review`，Claude Code 的 `/dsh:rescue`、`/dsh:review`、`/dsh:adversarial-review`），代理会以前台 `--wait` 运行 DSH 并在结束时把最终输出返回给你；`/dsh:rescue` 和两个评审命令中的 `--background` / `--wait` 只决定宿主是否后台执行这次调用，不会让 DSH 脱离代理自行运行。

### 4. 续接会话

```sh
node scripts/dsh-companion.mjs task --resume "继续处理剩余问题"
```

`--resume` 使用 ACP `session/resume` 恢复真实上下文。没有可续接会话时会直接失败，不会用摘要伪造历史。

### 5. 请求独立评审

```sh
node scripts/dsh-companion.mjs review --wait
node scripts/dsh-companion.mjs review --adversarial --base main --wait "重点检查并发问题"
```

Codex 会自动触发 `dsh-review` 技能；Claude Code 对应 `/dsh:review` 和 `/dsh:adversarial-review`；pi 对应 `dsh_review` 工具与 `/skill:dsh-review`。

完整 CLI 参数：

```sh
node scripts/dsh-companion.mjs --help
```

## 可选能力

### 分析调研层

`task --analyze` 会先启动一个只读 DSH 会话生成任务简报，再启动独立会话执行任务：

```sh
node scripts/dsh-companion.mjs task --analyze --wait "修复会话过期流程"
```

分析失败时不会继续执行。它会多消耗一轮调用并留下两个 DSH 会话，且不能与 `--resume` 同时使用。

### Stop 复审门

复审门让 DSH 在宿主准备结束一轮时检查最终答复。它默认关闭，并按工作区配置：

```sh
node scripts/dsh-companion.mjs setup --enable-review-gate
node scripts/dsh-companion.mjs setup --disable-review-gate
```

钩子会先在本地检查最终答复，只有答复明确报告了仓库变更时才启动 DSH；提问、只读调查结果和纯状态汇报不会创建 DSH 会话。只有首行明确返回 `BLOCK: <原因>` 才会阻断；DSH 缺失、超时、崩溃或输出无法解析时均放行。一次宿主轮次最多阻断一次。Codex 还需要信任插件 hook；Claude Code 在安装插件时处理信任；pi 在 `agent_settled`（pi 不再自动继续的时刻）触发同一个门，项目首次使用时需要信任 `.pi` 目录。

## 包含内容

Codex 自动使用以下技能：

| 技能 | 用途 |
|---|---|
| `dsh-delegate` | 仅在用户明确要求 DSH 时委派任务或续接会话 |
| `dsh-review` | 用户明确要求的 DSH 代码评审 |
| `dsh-jobs` | 查询、取回和取消后台作业 |
| `dsh-setup` | 诊断 DSH 与插件配置 |

Claude Code 额外提供以下命令：

| 命令 | 用途 |
|---|---|
| `/dsh:setup` | 自检并管理复审门 |
| `/dsh:rescue` | 显式把任务交给 DSH 子代理 |
| `/dsh:review` / `/dsh:adversarial-review` | 请求代码评审 |
| `/dsh:status` / `/dsh:result` / `/dsh:cancel` | 管理后台作业 |
| `/dsh:transfer` | 把 Codex 或 Claude Code JSONL 会话交给 DSH |

pi 通过扩展提供以下工具；上表的四个技能由三个宿主共用，在 pi 中也可以用 `/skill:dsh-*` 调用：

| 工具 | 用途 |
|---|---|
| `dsh_task` | 委派任务和续接会话 |
| `dsh_review` | 标准或挑战式代码评审 |
| `dsh_jobs` | 查询、取回和取消后台作业 |
| `dsh_setup` | 自检、列出模型、开关复审门 |

仓库本身就是插件根目录：

```text
agent-plugin-dsh/
├── .agents/plugins/marketplace.json
├── .claude-plugin/{marketplace.json,plugin.json}
├── .codex-plugin/plugin.json
├── .pi/extensions/dsh.ts
├── agents/
├── commands/
├── hooks/
├── prompts/
├── scripts/
├── skills/
└── tests/
```

## 模型与权限

```sh
node scripts/dsh-companion.mjs models
node scripts/dsh-companion.mjs task --wait --model glm-5.3 "..."
node scripts/dsh-companion.mjs task --wait --model deepseek-v4-pro --provider volcengine "..."
```

- `flash` 和 `pro` 是 `deepseek-v4-flash` 与 `deepseek-v4-pro` 的别名。
- 不传 `--model` 时，插件保留 DSH 当前选择。
- `--effort` 必须使用所选路由实际公布的值。
- `--write` 只表达写入意图，不构成沙箱。需要真实隔离时设置 `DSH_PERMISSION_MODE=read-only` 或 `workspace-write`。

常用环境变量：

| 变量 | 作用 |
|---|---|
| `DSH_CODEX_DSH_BIN` | 指定 `dsh` 可执行文件 |
| `DSH_CODEX_MODEL` / `DSH_CODEX_PROVIDER` / `DSH_CODEX_EFFORT` | 默认执行模型 |
| `DSH_CODEX_ANALYZE_MODEL` / `DSH_CODEX_ANALYZE_PROVIDER` / `DSH_CODEX_ANALYZE_EFFORT` | 默认分析模型 |
| `DSH_COMPANION_DATA` | 作业状态根目录 |
| `DSH_HOME` | DSH 主目录 |
| `DSH_PERMISSION_MODE` | DSH 沙箱策略 |

## 问题排查

先运行：

```sh
node scripts/dsh-companion.mjs setup --json
node scripts/dsh-companion.mjs models --json
```

需要注意：

- 被取消的作业可能没有完整刷盘，因此不可续接。
- 评审的“只读”默认是提示约束；文件系统保证来自 DSH 沙箱。
- `transfer` 是有长度上限的转写，不是原生会话导入，也不支持 `.jsonl.zst`。
- ACP 会把 `completed`、`aborted` 和 `blocked` 都映射为 `end_turn`，插件无法进一步区分。
- `models` 与复审门会留下 DSH 会话，因为 ACP 没有删除会话的能力。
- pi 宿主不提供斜杠命令：用 `dsh_*` 工具，或 pi 自动生成的 `/skill:dsh-*`。
- pi 会话的会话转写（`transfer`）仍未实现；`transfer` 只接受 Codex 与 Claude Code 的 JSONL。
- 在 pi 中被中止的 DSH 任务：Windows 上终止插件进程会连带终止未分离的 ACP 子进程；POSIX 上被刻意分离的 DSH 运行时可能存活，用 `dsh_jobs` 的 `cancel` 停止它。
- pi 项目级扩展与技能需要项目信任：`pi list` 查看已安装的源，会话内用 `/reload` 重载扩展与技能。

## 开发

```sh
npm test
npm run setup
```

修改版本时，请同步 `package.json`、两个 `plugin.json` 和 Claude marketplace 中的插件版本；测试会检查它们是否一致。

## 许可

MIT
