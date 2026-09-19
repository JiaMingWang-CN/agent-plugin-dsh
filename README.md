# agent-plugin-dsh

一个 **Codex 与 Claude Code 双宿主插件**：让两个宿主都能把工作委派给 **DeepSeek Harness（DSH）**——派任务、
续接 DSH 会话、做标准或挑战式代码评审、管理后台作业，全部通过零 npm 依赖的 `dsh-companion.mjs` 完成。
两个宿主共用同一套脚本、同一份提示模板和同一个按工作区隔离的作业存储。

设计与取舍见 `PLAN.md`，英文版见 `README.en.md`。

## 一、环境要求

| 依赖 | 说明 |
|---|---|
| **DSH** | `dsh` 必须在 `PATH` 上可运行（`dsh --version`）。插件驱动 DSH 自带的 `acp` profile。 |
| **Node.js ≥ 18.18** | 插件脚本用 Node 运行。 |
| **DSH 里已配置至少一个可用模型** | 插件**不绑定 provider**：用你在 DSH 里配好的任意模型即可（DeepSeek 官方、火山引擎、GLM …… 都行）。装完后跑 `models` 查看本机实际可用项，见「六、选择模型」。 |

## 二、安装

```sh
# 1) 把本目录注册为本地 marketplace（用绝对路径）
codex plugin marketplace add /absolute/path/to/agent-plugin-dsh

# 2) 安装插件
codex plugin add dsh@dsh

# 3) 确认已安装并启用
codex plugin list
```

已发布到 GitHub 后，也可以直接用 git 源一条命令装（仓库根的 `.agents/plugins/marketplace.json` 让 codex
认得出整个仓库，Claude Code 侧对应 `.claude-plugin/marketplace.json`）：

```sh
codex plugin marketplace add JiaMingWang-CN/codex-dsh
codex plugin add dsh@dsh
```

> **清单为什么有两层？** 每个宿主只认一个固定路径：Codex 读 `.agents/plugins/marketplace.json`
> （它的候选顺序里还把 `.claude-plugin/marketplace.json` 当兜底），Claude Code 只读
> `.claude-plugin/marketplace.json`。所以「把 `agent-plugin-dsh/` 目录本身注册为 marketplace」用的是该
> 仓库根目录下的两份清单都指向 `plugins/dsh`（`source: ./plugins/dsh`）。两者只指向同一份
> 插件本体，不复制、也不重复维护。

### Codex 侧

安装成功后，新开的 Codex 会话会多出 4 个技能：

| 技能 | 触发场景 |
|---|---|
| `dsh-delegate` | “让 DSH 去做……”、“继续之前的 DSH 会话” |
| `dsh-review` | “让 DSH 评审一下这个改动”、“挑挑这个设计的刺” |
| `dsh-jobs` | “DSH 作业跑得怎么样了”、“取消它” |
| `dsh-setup` | “DSH 装好了吗 / 配好 key 了吗” |

### Claude Code 侧

Claude Code 通过仓库根的 `.claude-plugin/marketplace.json` 认识同一个仓库、同一个插件：

```sh
# 本地目录（用绝对路径），或直接从 git 源装：
/plugin marketplace add /absolute/path/to/agent-plugin-dsh
/plugin marketplace add JiaMingWang-CN/codex-dsh

/plugin install dsh@dsh
/reload-plugins
```

装好后 Claude Code 会多出这些入口（4 个技能与 Codex 侧相同，另外多了命令和子代理）：

| 命令 | 作用 |
|---|---|
| `/dsh:setup` | 检查 `dsh`、profile、凭据来源；可开关 Stop 复审门 |
| `/dsh:review` | 对本工作区改动做只读评审（`--wait` / `--background` / `--base` / `--scope`） |
| `/dsh:adversarial-review` | 可带 focus 文本的挑战式评审 |
| `/dsh:rescue` | 通过 `dsh:dsh-rescue` 子代理把实质任务交给 DSH |
| `/dsh:status` / `/dsh:result` / `/dsh:cancel` | 查看、取回、取消后台作业 |
| `/dsh:transfer` | 把 Codex rollout 或 Claude Code 会话交给 DSH 继续 |

命令与子代理都只是薄转发：真正的执行体始终是同一个 `dsh-companion.mjs`，作业也仍然按工作区隔离，
所以在 Codex 里起的作业，Claude Code 里用 `/dsh:status` 一样看得到。

## 三、首次自检

> 不用记这些命令：在 Codex 里说「检查一下 DSH 的配置」会触发 `dsh-setup` 技能，Claude Code 里是 `/dsh:setup`，
> 它们替你跑完下面的命令并把输出原样带回来。没有宿主会话时（脚本、CI）直接跑这些 shell 命令也一样。

安装后先跑一次 `setup`，确认 dsh 可用：

```sh
node plugins/dsh/scripts/dsh-companion.mjs setup
# 或输出机器可读格式
node plugins/dsh/scripts/dsh-companion.mjs setup --json
```

报告内容包括：`dsh --version` 是否可用、使用的 profile、默认 provider 凭据的解析来源
（只报来源、绝不回显值）、当前工作区的状态目录、复审门开关状态。**`setup` 是纯本地离线检查。**

**再跑一次 `models` 看能用哪些模型**——它列出当前环境实际公布的全部 provider 与模型，`--model` 只能从中选：

```sh
node plugins/dsh/scripts/dsh-companion.mjs models
```

```sh
# 可选：为本工作区开启 / 关闭 Stop 复审门（默认关闭）
node plugins/dsh/scripts/dsh-companion.mjs setup --enable-review-gate
node plugins/dsh/scripts/dsh-companion.mjs setup --disable-review-gate
```

## 四、在 DSH 里配置模型

模型、provider 和凭据都在 **DSH 本体**里配置（`DSH_HOME` 的 settings / profile），插件不假定用哪个，只读取
运行时实际公布的目录。所以没有插件侧的配置步骤：`models` 的列表里有你要用的模型就算配好了；列表是空的
或报错，说明问题在 DSH 那一侧，用 DSH 自己的方式修好再回来。

> **关于"强度"**：协议层只有一个**会话级**的思考强度旋钮（DeepSeek 官方路由公布 `off / low / high / max`，
> 经 pi-ai 接入的网关可能只公布 `low / medium / high`；**插件不预设词表**），
> 不存在"每个模型各自的强度档位"——它由当前选中的模型决定有哪几档，换模型可能换掉可选档位。
> 所以 `models` 返回的是两样东西：每个模型的**强度描述**（运行时公布的元数据），
> 以及当前模型公布的那组 `reasoning effort` 值与当前选中值。选档位用 `--effort`：值原样交给运行时，
> 由它按这一轮实际选中的模型校验（校验失败时列出的是**那个模型**的可选值）；每轮开始时会打印一行
> `Reasoning effort: <生效值> (offered by this model: ...)`，换模型导致强度回落到默认档也看得到。

## 五、环境变量参考

| 变量 | 作用 |
|---|---|
| `DSH_CODEX_DSH_BIN` | 指定 `dsh` 可执行文件路径。若指向 `.js`/`.mjs` 文件，会用当前 Node 运行它（Windows 下可指向 `dsh.cmd`）。 |
| `DSH_CODEX_PROFILE` | dsh profile，默认 `acp`。**不要改**：换成别的 profile 会过不了 ACP 身份校验。 |
| `DSH_CODEX_MODEL` / `DSH_CODEX_EFFORT` | `--model` / `--effort` 的默认值。不设 = “不改 DSH 自己选的”。 |
| `DSH_CODEX_PROVIDER` | `--provider` 的默认值。只在同一个模型 id 被多个 provider 提供时才用于消歧。 |
| `DSH_CODEX_ANALYZE_MODEL` / `DSH_CODEX_ANALYZE_PROVIDER` / `DSH_CODEX_ANALYZE_EFFORT` | `--analyze-*` 的默认值，只作用于 `task --analyze` 的调研轮（见「八、分析调研层」）。 |
| `DSH_COMPANION_DATA` | 状态根目录，默认 `<tmpdir>/dsh-companion`。 |
| `DSH_HOME` | DSH 主目录，模型目录、会话与续接一致性检查都基于它。 |
| `DSH_PERMISSION_MODE` | **真正的沙箱开关**（`read-only` / `workspace-write` / `danger-full-access`）。插件**不**覆盖它。 |

> `DSH_CODEX_*` 是这个插件自己的命名，与宿主无关：在 Claude Code 里跑同一套脚本时，这些变量同样生效。

## 六、选择模型

有哪些 provider 和模型取决于你的 `DSH_HOME` 与 profile，插件每次都读当轮实际公布的目录，不写死：

```sh
# 我到底能选什么？
node plugins/dsh/scripts/dsh-companion.mjs models

# 裸模型 id 会自动解析到提供它的那个 provider
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model glm-5.3 "..."

# 消歧：多个 provider 都提供同一个 id 时指定 provider
node plugins/dsh/scripts/dsh-companion.mjs task --wait --model deepseek-v4-pro --provider volcengine "..."
```

解析规则：

1. `--model`（或 `DSH_CODEX_MODEL`）先做别名展开：`flash` → `deepseek-v4-flash`，`pro` →
   `deepseek-v4-pro`；其余按字面模型 id 处理。
2. 在当前会话公布的目录里查找。**找不到 → 在发送提示之前就失败**，并按 provider 分组打印真实目录。
3. 只有一个 provider 提供 → 用它。
4. 多个 provider 提供 → 由 `--provider` / `DSH_CODEX_PROVIDER` 决定；不指定则优先 `deepseek-official`；
   若它不在候选里则失败并列出候选。
5. **不传 `--model` 时，一个模型参数都不发。** 插件不强加默认值，你在 `DSH_HOME` 里配的模型会被保留。

> `models` 需要建一个会话才能读目录，而 ACP 没有删除会话的能力，所以它会留下一个空会话。命令
> 会把这个会话 id 打印出来，而不是偷偷藏起来。

## 七、典型用法

所有功能都通过 `plugins/dsh/scripts/dsh-companion.mjs`：

```sh
node plugins/dsh/scripts/dsh-companion.mjs setup [--json]

node plugins/dsh/scripts/dsh-companion.mjs models [--cwd <d>] [--dsh-profile <p>] [--json]

node plugins/dsh/scripts/dsh-companion.mjs task [--wait|--background] [--resume|--resume-last|--fresh] \
     [--write] [--model <id|flash|pro>] [--provider <id>] [--effort <level>] \
     [--analyze] [--analyze-model <id|flash|pro>] [--analyze-provider <id>] [--analyze-effort <level>] \
     [--prompt-file <p>] [--dsh-profile <p>] [--cwd <d>] [--json] [prompt ...]

node plugins/dsh/scripts/dsh-companion.mjs review [--adversarial] [--wait|--background] [--base <ref>] \
     [--scope auto|working-tree|branch] [--model <m>] [--provider <p>] [--effort <e>] [--cwd <d>] [--json] [focus ...]

node plugins/dsh/scripts/dsh-companion.mjs status [job-id] [--all] [--wait] \
     [--timeout-ms N] [--poll-interval-ms N] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs result [job-id] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs cancel [job-id] [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs task-resume-candidate [--cwd <d>] [--json]
node plugins/dsh/scripts/dsh-companion.mjs transfer --source <transcript.jsonl> [--cwd <d>] [--json]
```

每个 `--json` 响应都含稳定的顶层字段：`jobId`、`status`、`sessionId`、`stopReason`、
`finalResponse`、`exitStatus`；不适用时为 `null`。

**委派并直接读结果。** `task --wait "<任务>"` 会把 DSH 的最终答复**逐字节**写入 stdout，
且只有本轮正常结束时才退出码 0。

**把长任务放后台：**

```sh
node plugins/dsh/scripts/dsh-companion.mjs task --background "跑完整测试套件并修复失败项"
# → DSH Task started in the background as task-… .
node plugins/dsh/scripts/dsh-companion.mjs status task-… --wait --timeout-ms 1800000
node plugins/dsh/scripts/dsh-companion.mjs result task-…
```

**续接上一轮会话。** `task --resume "<追问>"` 通过 ACP `session/resume` 恢复之前的 DSH 上下文。
如果没有可续接的会话，命令会在**创建作业之前**就失败——绝不会用旧名字开个新会话，也不会用摘要重放
冒充真实历史。

**评审改动：**

```sh
node plugins/dsh/scripts/dsh-companion.mjs review --wait
node plugins/dsh/scripts/dsh-companion.mjs review --adversarial --base main --wait "并发问题"
```

## 八、分析调研层（可选）

有些任务在执行前值得先调研。`task --analyze` 在请求与执行之间插入一轮**只读调研**：更强的模型
读仓库并产出任务简报（目标 / 范围 / 执行者必须读的文件 / 约束 / 可检查的验收标准 / 风险），
再由一个新会话带着简报执行。

```sh
node plugins/dsh/scripts/dsh-companion.mjs task --analyze --wait "让登录流程能挺过会话过期"
```

要点：

- 调研轮与执行轮是**两个独立的 `dsh` 进程和会话**，因此可以用 `--analyze-model`（默认 `pro`）、
  `--analyze-provider`、`--analyze-effort` 单独选型；`result --json` 里会给出 `analysisSessionId`。
- 调研轮**始终只读**，即使带了 `--write`；只有执行轮可以写。
- 调研失败或简报为空 → 作业直接 `failed`，**不执行**。`--analyze` 与 `--resume` 互斥。
- 代价：跑 **两** 轮 DSH、留 **两** 个会话，相当于把任务跑两遍。

## 九、Stop 复审门（可选）

插件自带一个 `Stop` hook，**两个宿主共用同一个 `hooks/hooks.json`**：DSH 认为本轮还有问题时，可以
拒绝让当前宿主结束这一轮。**默认关闭**，需要逐工作区开启（见「首次自检」）。开启后，hook 会把本轮
最终消息连同 `prompts/stop-review-gate.md` 的提示发给 DSH，读取判决：

- 首行为 `BLOCK: <原因>` → 输出 `{"decision":"block","reason":"<原因>"}`，宿主带着原因继续本轮；
- 其它情况 → stdout 保持空，宿主记为一次正常 hook 运行。

要点：

- **只有明确的 `BLOCK:` 才阻断。** 门关着、`dsh` 缺失、超时、崩溃、答案无法解析——一律放行并把
  问题打到 stderr。一道能因为环境没配好就把会话卡死的门，比没有门更糟。
- **第二次通过永不阻断。** 宿主在阻断后会重跑 `Stop` hook；payload 带 `stop_hook_active` 时直接放行，
  不会陷入“阻断—重跑”死循环。
- **每次门控会留下一个已关闭的 DSH 会话**（ACP 没有删除会话的能力）。

### 真正启用它

1. **信任 hook。** Codex 只在 `hooks.state."<key>".trusted_hash` 匹配时才运行插件提供的 hook，未受信任的
   hook 会被静默跳过：在 Codex 询问时授权信任，或接受风险后用 `--dangerously-bypass-hook-trust` 启动。
   Claude Code 不同：插件 hook 在安装时随插件一起被信任（安装时的插件信任提示），没有按 hook 的
   `trusted_hash`；装好后可以在 `/hooks` 里看到它来自 `Plugin Hooks`。
2. **打开开关。** 见「首次自检」中的 `--enable-review-gate`。开关**按工作区**存储，换个检出目录
   要重开一次。
3. **检查接线。** hook 命令是 `node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs"`——两个宿主都会
   替换这个占位符，所以同一个文件在两种平台上是同一条命令。

## 十、常见问题

**`--resume` 真的能恢复上文吗？**
能。它用 ACP `session/resume`，这在写这个插件之前就已用两进程探针验证过，见
`docs/phase-0.1-resume-verification.md`。

**能续接一个被取消的作业吗？**
不能，而且插件会告诉你为什么而不是瞎试。取消是强制终止进程树，DSH 没机会刷会话日志，
日志可能不完整。

**为什么 `cancel` 是杀进程而不是优雅停止？**
ACP 连接属于拥有本轮的 worker 进程，另一个 `cancel` 调用没有通道发 `session/cancel`。
插件会终止记录的 runtime 进程树，**确认进程退出后**才报告 `cancelled`。

**用的哪个 dsh profile？**
`acp`。`sdk` profile 无法跨进程恢复，所以不用。

**复审门为什么没拦住任何东西？**
按顺序排查：本工作区门没开、宿主没信任该插件 hook（Codex 的 `trusted_hash`、Claude Code 的插件信任
提示）、DSH 回答的不是 `BLOCK:`。每种情况都会在 stderr 留一行；可以手工带着抓到的 payload 跑一遍
hook 看到底卡在哪。

## 十一、已知限制

1. **只读评审是提示契约，不是沙箱。** 评审与不带 `--write` 的提示只是要求 DSH 不要改文件，
   插件对 DSH 的一次性权限请求一律回 *allow once*。**没有任何东西真正阻止写入。** 需要真实屏障
   就用 `DSH_PERMISSION_MODE=read-only`，那会启用 DSH 自己的沙箱策略——插件**不**替你做这个决定。
   所以别把“只读评审”当成“文件没被改过”的保证。
2. **轮次结束的粒度比 DSH 自身粗。** ACP 把 `completed`、`aborted`、`blocked` 全映射为
   `end_turn`，插件无法区分；失败的轮次会以 `session/prompt` 拒绝的形式体现，退出码非 0。
3. **取消不保证 DSH 日志干净。** 强杀不跑 DSH 的清理路径、不刷盘、不写 `turn/end`；被取消的会话
   因此被标为不可续接。
4. **评审结果没有结构化输出。** 评审是固定章节的 Markdown，不是 JSON schema。
5. **作业按工作区隔离。** 同一工作区里的两个会话（无论来自哪个宿主）共享同一份作业列表。
6. **`transfer` 是有界的交接，不是原生导入。** 必须给 `--source`，且转写内容按硬字节上限截断；支持
   Codex rollout 与 Claude Code 会话两种 JSONL（按内容自动识别），`.jsonl.zst` 压缩档不支持，需先解压。
7. **复审门要真的起作用，需要 `dsh` 可用，且宿主信任插件 hook**：Codex 走 `trusted_hash`，Claude Code 走
   安装期的插件信任提示。Claude Code 还会限制连续阻断——门在 `stop_hook_active === true` 时一律放行，所以
   一轮最多阻断一次，另有 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 上限，到顶后它直接结束本轮。

## 十二、目录结构

```
agent-plugin-dsh/
├─ .agents/plugins/marketplace.json     # Codex marketplace 清单
├─ .claude-plugin/marketplace.json      # Claude Code marketplace 清单
├─ plugins/dsh/
│  ├─ .codex-plugin/plugin.json         # Codex 插件清单
│  ├─ .claude-plugin/plugin.json        # Claude Code 插件清单
│  ├─ skills/{dsh-delegate,dsh-review,dsh-jobs,dsh-setup}/SKILL.md   # 两个宿主共用
│  ├─ commands/*.md                     # Claude Code slash 命令（setup/review/rescue/…）
│  ├─ agents/dsh-rescue.md              # Claude Code 子代理：薄转发到 task
│  ├─ prompts/*.md                      # 评审 / 分析 / 委派 / 复审门提示模板
│  ├─ hooks/hooks.json                  # Stop 复审门（一个文件，两个宿主）
│  └─ scripts/
│     ├─ dsh-companion.mjs              # 所有子命令的入口
│     ├─ stop-review-gate-hook.mjs
│     └─ lib/*.mjs                      # 传输 / 状态 / 进程 / 作业控制 / git
├─ tests/*.test.mjs                     # node --test，含假 ACP runtime 端到端
├─ probes/                              # 对真 dsh 做协议层验证的一次性探针
├─ docs/                                # 阶段验证记录
└─ PLAN.md                              # 完整设计与验收记录
```

## 十三、开发与测试

```sh
npm test          # node --test tests/*.test.mjs
npm run setup     # 等价于跑一次 companion setup
```

测试用注入的假 ACP runtime（`DSH_CODEX_DSH_BIN`）覆盖：前台/后台任务、跨进程续接、评审、
status/result/cancel、权限请求、transfer、进程树清理与 worker 崩溃回收。

版本号在项目内的 5 处由 `tests/claude-host.test.mjs` 守着一致（`package.json`、两份 marketplace 清单、两个
plugin.json）；改版本时要一起改，且两份 marketplace 清单的 `source` 必须保持 `./plugins/dsh`。

## 许可

MIT。
