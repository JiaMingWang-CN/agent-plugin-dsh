# Phase 4：分析调研层（codex → 分析模型 → dsh）

> 状态：计划已批准，开发中。本文件是 PLAN.md 的增补（Phase 4），与 PLAN.md 同级维护。

## 1. 目标与成功标准

### 1.1 目标
在 codex 与 dsh 之间插入一轮**分析调研**（由一个可自由选择的 DSH 模型承担）：codex 只交付意图，分析层调研仓库后产出一份**任务简报**，执行模型基于简报工作。解决两个已感知的问题：

- **codex 过度详细**：把实现步骤一路写死，抑制了执行侧的自主判断；
- **dsh 偷懒**：接到处方式指令后机械跟随、不复核、不验证。

### 1.2 成功标准（可验证）
1. `task --analyze "…" --wait` 顺序跑两轮 DSH 回合（分析轮 + 执行轮），stdout 只回传**执行轮**的最终答复（原样、不变），退出码语义不变。
2. 分析轮模型可自由选择且与执行轮独立：`--analyze-model/--analyze-provider/--analyze-effort` 与 `--model/--provider/--effort` 互不影响。
3. 分析轮**始终只读**（即使带 `--write`）；执行轮才继承写入许可。
4. 分析轮失败时作业直接 `failed`，**绝不**进入执行轮。
5. `--background` 可用：worker 回放 `request` 时完整重放两轮。
6. 作业记录与 `--json` 载荷携带 `analysisSessionId` 与 `analysisBrief`；`result`/`--resume` 只认**执行轮**的 sessionId。
7. `node --test` 全绿（现有 70 + 新增用例）。
8. 不改动 `codex/`、`deepseek-harness/`、`codex-plugin-cc/` 任何文件（沿用 PLAN §1.2-8 的边界）。

## 2. 现状基线（已核实，非推断）
- 唯一 DSH 专属模块 `plugins/dsh/scripts/lib/dsh.mjs`：`runDshTurn({cwd,prompt,sessionId,model,provider,reasoningEffort,dshProfile,onProgress,onRuntime,onSession})` = 启动一个 `dsh --profile acp` 进程 → `initialize` → `session/new|resume` → `applyRoute`（`resolveModelRoute` 依据**该会话公布的目录**解析，未指定 model 时**不发送**配置）→ `session/prompt` → `session/close` + stdin EOF 关停。
- `dsh-companion.mjs`：`handleTask` → `buildTaskRequest` → `executeRequest`（按 `kind` 分派到 `executeTaskRun`/`executeReviewRun`）→ `runForegroundJob`；`--background` 由 `task-worker`（dsh-companion.mjs:1172）用 `executeRequest(storedJob.request, …)` 回放。
- 执行提示 = `prompts/delegated-task.md` 前置 + 调用方 prompt（`buildDelegatedTaskPrompt`）；stdout 原样回传契约见 `dsh-delegate/SKILL.md`。
- 假 runtime `tests/fake-acp-runtime.mjs` 默认回复 `echo:<prompt>`，支持顺序多次 `session/new`，足以端到端验证两轮管线（无需改 fake）。

## 3. 目标数据流

```
codex（只给意图 + --analyze）
  └─ dsh-companion task --analyze [--analyze-model pro] [--model <执行模型>] [--write]
       ├─ 第 1 轮 runDshTurn（新会话 S_a，只读，分析模型）
       │     prompt = prompts/analyze.md + codex 原始意图
       │     → brief（固定章节 Markdown）
       ├─ 校验：end_turn && brief 非空，否则 failed
       └─ 第 2 轮 runDshTurn（新会话 S_e，执行模型）
             prompt = prompts/delegated-task.md（写入许可）+ brief
             → 最终答复 → stdout / 作业记录（sessionId = S_e）
```

## 4. 设计决策（含备选与取舍）

- **D1 两轮各用独立新会话**，而非同会话续接。理由：(a) 与插件既有哲学「传任务、不传上下文」一致（`SKILL.md`：DSH 自己读仓库）；(b) 执行模型必须在**新会话**里重新 engagement 仓库，正是对付「偷懒」；(c) 规避未验证的 ACP 会话内切换模型行为——每轮一个进程、一次 `applyRoute`，复用 100% 现有机制。代价：每次分析型任务产生 **2 个 DSH 会话**（与 `models` 命令的会话代价同源，照实写进文档）。
- **D2 分析模型默认 `pro`**（即 `deepseek-v4-pro`）。这**有意偏离** README「不带 --model 时不发 model 配置」的立场：分析层的全部价值就是用更强模型做调研。可覆盖（`--analyze-model` / `DSH_CODEX_ANALYZE_*`）、可关闭（不带 `--analyze`），且若目录不含该模型会**当场报错并列出真实目录**（复用 `resolveModelRoute` 的既有错误路径）。
- **D3 分析轮强制只读**。`--write` 只作用于执行轮；分析提示词恒为「Do NOT create, modify, delete, or rename any file」。
- **D4 只做 `task --analyze` 一个入口**，不新增子命令、不新增技能。`kind` 仍为 `"task"`（保证 `task-resume-candidate` 的既有筛选逻辑不变），title 用 "DSH Analyzed Task"。考虑过独立 `analyze` 子命令 / 新 `dsh-analyze` 技能——均为同一能力的重复入口，弃。
- **D5 反「过度详细」与反「偷懒」由提示词承担**，代码只负责编排：`analyze.md` 明令「不得写代码、不得给逐步实现处方」（处方会让执行者停止思考），并强製「Definition of done」章节——每条都必须是执行者**自己能验证**的检查项；执行侧在 `delegated-task.md` 加一行收口（见 5.2）。

## 5. 改动清单（按子系统）

### 5.1 新增 `plugins/dsh/prompts/analyze.md`（核心）
固定输出章节，顺序固定：`## Goal`（成功算什么）/ `## Scope`(In/Out) / `## Grounding`（必须先读的文件·函数·测试，带路径与一行理由）/ `## Constraints`（约定与不可破坏项）/ `## Definition of done`（可自检的验收标准）/ `## Risks and ambiguities`（含建议处置）。占位符 `{{WORKSPACE_ROOT}}`；规则：只读、自己读仓库（描述可能指错位置）、区分「结果」与「描述者想象的做法」（后者只是建议）、不写代码不下发步骤处方。

### 5.2 `prompts/delegated-task.md`（最小增补）
现有 6 条规则不动，仅在第 5 条后加一条：「若任务带研究简报，其 Definition of done 属于需求本身：逐条满足，或明确说明哪一条被什么阻塞。」

### 5.3 `plugins/dsh/scripts/dsh-companion.mjs`
- `printUsage()`：task 行加 `[--analyze]`、`[--analyze-model <id|flash|pro>]`、`[--analyze-provider <id>]`、`[--analyze-effort <off|low|high|max>]`。
- `handleTask(argv)`：`valueOptions` 增 `analyze-model/analyze-provider/analyze-effort`，`booleanOptions` 增 `analyze`；校验 `--analyze` 与 `--resume/--resume-last` 互斥（与 `--fresh` 不冲突，`--analyze` 本就隐含新管线）；`buildTaskRequest` 增 `analyze: { enabled, model, provider, effort }`，其中 model 解析顺序 = `--analyze-model` → `DSH_CODEX_ANALYZE_MODEL` → `"pro"`（仅 enabled 时），provider/effort 同理（未给则为 null）。
- 新增 `buildAnalysisPrompt({workspaceRoot, userPrompt})`：插值 `analyze.md` + 原始意图。
- 新增 `executeAnalyzedTaskRun(request, context)`：
  1. `context.progress({message:"Analyzing…", phase:"analyzing"})`；`runDshTurn`（prompt=分析提示，model=分析路由，**write 固定 false**）→ 得 `analysis`（sessionId `S_a`、brief、exitStatus）。
  2. 守卫：`exitStatus!==0` → 直接返回失败载荷（errorMessage 透出分析轮错误，`stopReason` 透出）；brief 为空白 → 失败并写明「analysis pass produced an empty brief」。
  3. `context.progress({message:"Analysis brief ready (N lines). Executing…", phase:"running"})`（写 stderr/日志，**不写 stdout**）；`runDshTurn`（prompt=`buildDelegatedTaskPrompt` 嵌入 brief，sessionId=null 新会话，model=执行路由，write=request.write）。
  4. 返回 {`execution` 的退出码/sessionId/stopReason/rendered/summary，payload 追加 `analysisSessionId`、`analysisBrief`}。
- `executeRequest` 分派：`request.kind==="task" && request.analyze?.enabled` → `executeAnalyzedTaskRun`（worker 回放路径自动覆盖后台）。
- `outputResult`：`--json` 顶层增 `analysisSessionId`/`analysisBrief`（沿用稳定键约定，不破坏既有 `jobId/status/sessionId/stopReason/finalResponse/exitStatus`）。
- 作业记录 schema 增 `analysisSessionId`；`request.analyze` 完整落盘以供回放。

### 5.4 `skills/dsh-delegate/SKILL.md`
加一节「When to use --analyze」：任务需要先摸清现状、或发现自己正在写长篇步骤清单时，**停下来**，改交一句意图 + `--analyze`；列出四个新旗标；说明代价（两轮、两个会话、分析模型默认 pro 可换）与失败语义（分析轮失败不执行）。

### 5.5 文档
`README.md`（Commands / Choosing a model / 新增「Analysis layer」小节，含会话代价与 D1/D2 取舍）、`PLAN.md` 增「Phase 4（分析调研层）」并标注其为当前计划。

## 6. 边界情况与失败模式
| 场景 | 期望 |
|---|---|
| 分析轮退出码非 0 / stopReason≠end_turn | 作业 `failed`，不创建执行会话，错误写 stderr |
| brief 为空白 | `failed` + 明确原因，不执行空提示 |
| `--analyze-model` 不在目录 | 分析轮即报错并列出真实目录（退 1，无执行会话） |
| `--analyze --resume` | 建作业前报错：分析层只跑新管线 |
| `--analyze --background` | 排队后 worker 完整重放两轮；取消时 `runtimePid` 记录的是**当前正在跑的那一轮**的 runtime（分析轮结束后 recorder 自然被执行轮覆盖） |
| `--write` | 分析轮提示恒只读；执行轮才含「may modify」 |
| 会话污染 | 每次分析型任务留 2 个会话；`analysisSessionId` 写进作业与输出，`result` 只用执行 sessionId 判可续接 |
| 大 prompt / 长 brief | 沿用无截断策略（简报即文本，与 transfer 的硬上限无关） |

## 7. 测试与验收（`tests/runtime.test.mjs`，fake runtime 无需改动）
1. **管线直通**：`task --analyze --wait "fix the bug"` → 断言执行轮 prompt（=fake 的 echo 回复可反推）包含分析轮回复文本；`--json` 含 `analysisSessionId !== sessionId`、`analysisBrief===分析轮回复`；stdout 仅为执行轮答复；退 0。
2. **写入许可隔离**：`--analyze --write` → 分析轮回复（echo 了分析提示）含「Do NOT … modify」且不含「You may modify」；执行轮反之。
3. **分析轮失败不执行**：`FAKE_ACP_FAIL=1` → 退 1、`status=failed`、会话存储里恰有 1 个会话、无执行轮回复。
4. **模型解析失败**：`--analyze-model nope` → 退 1 + 目录分组列出，无新执行会话。
5. **互斥**：`--analyze --resume` → 退非 0 且错误明确，无作业、无 DSH 调用。
6. **后台**：`task --analyze --background` → `status --wait` 到 `completed`；`result` 同时含 brief 与执行答复；`--resume` 续接的是执行会话（`turns` 从 1 起算于该会话）。
7. `npm test` 全绿（现有 70 + 新增约 6 组）。

## 8. 假设、已知代价与立场偏离
- 假设：分析层价值来自「更强模型 + 只读调研 + 结构化简报」，而非会话内上下文继承（D1）。
- 偏离既有立场（已显式记录，可覆盖/可关闭）：分析模型默认 `pro`（D2）。
- 代价：分析型任务产生 2 个 DSH 会话、耗时约为单任务的 2 倍。
- 不变：`kind==="task"`、stdout 原样回传、退出码语义、`--resume` 只认执行会话、零 npm 运行时依赖、三仓库零改动。

## 9. 不在本次范围
- 让分析层作用于 `review`；独立 `analyze` 子命令 / 新技能；会话内切换模型（未验证的 ACP 行为）；分析结果缓存；强制只读沙箱（沿用既有「只读仅为提示约定」的限制，不新增承诺）。
