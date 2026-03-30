# Workspace Specification

## 1. 设计目标

workspace 是能力发现的主边界。用户打开一个项目后，平台应尽可能从项目根目录自动发现完整能力，而不是要求用户先去平台后台做大量全局配置。

当前约束：

- 只读取 workspace 根目录的 `AGENTS.md`
- 声明式配置放在 workspace 根目录 `.openharness/` 下
- 除 LLM API Key 外，不要求用户额外提供全局设置

## 2. 目录结构

建议的 workspace 结构：

```text
workspace/
  AGENTS.md
  .openharness/
    settings.yaml
    agents/
      planner.md
      builder.md
      reviewer.md
    models/
      GPT.yaml
      Kimi-K25.yaml
    actions/
      code-review/
        ACTION.yaml
      run-tests/
        ACTION.yaml
    skills/
      repo-explorer/
        SKILL.md
        scripts/
        references/
      doc-reader/
        SKILL.md
    mcp/
      settings.yaml
      servers/
        docs-server/
        browser/
    hooks/
      redact-secrets.yaml
      policy-guard.yaml
```

## 3. 自动发现规则

### 3.1 固定加载入口

系统在 run 启动时检查：

- `AGENTS.md`
- `.openharness/settings.yaml`
- `.openharness/agents/*.md`
- `.openharness/models/*.yaml`
- `.openharness/actions/*/ACTION.yaml`
- `.openharness/skills/*/SKILL.md`
- `.openharness/mcp/settings.yaml`
- `.openharness/mcp/servers/*`
- `.openharness/hooks/*.yaml`

### 3.2 当前优先级

当前建议优先级：

1. 平台默认配置
2. workspace 本地声明
3. 当前 API / session / run 显式参数

说明：

- 平台级与 workspace 级模型入口不互相覆盖，而是合并成当前 workspace 的 model catalog
- 模型入口解析优先使用显式 `model_ref`
- 当前不做多级目录合并
- 当前不做子目录 override
- 如果 workspace 中未声明默认 agent，则使用平台默认 agent

## 4. Workspace Settings 规范

### 4.1 目标

`.openharness/settings.yaml` 是 workspace 的总配置入口，用于定义：

- 默认 primary agent
- 额外的 skill 搜索目录
- workspace 级公共 system prompt
- system prompt 的分层拼装顺序与开关

它不用于定义具体 agent 的个性化行为；agent 自身定义仍放在 `agents/*.md`。

### 4.2 示例

```yaml
default_agent: build
skill_dirs:
  - ./.codex/skills

system_prompt:
  base:
    inline: |-
      You are Open Agent Harness running inside the current workspace.
      Prefer workspace-local configuration and tools.

  llm_optimized:
    providers:
      openai:
        inline: |-
          Be concise, tool-oriented, and explicit about assumptions.
      anthropic:
        file: ./.openharness/prompts/anthropic.md
    models:
      platform/openai-default:
        inline: |-
          Prefer short, direct tool call arguments.

  compose:
    order:
      - base
      - llm_optimized
      - agent
      - project_agents_md
      - skills
    include_environment: true
    include_project_agents_md: true
    include_skills: true
```

### 4.3 顶层字段

- `default_agent`
- `skill_dirs`
- `system_prompt`

### 4.4 `default_agent`

- 可选；声明当前 workspace 默认使用的 primary agent
- 若未声明，则回退到平台默认 agent
- 目标必须存在，且不能是纯 `subagent`

### 4.5 `skill_dirs`

建议结构：

```yaml
skill_dirs:
  - ./.codex/skills
  - ./.shared/skills
```

字段说明：

- 每一项都是一个额外的 skill 根目录
- 每个根目录下仍按 `*/SKILL.md` 发现技能

规则：

- 默认始终扫描 `.openharness/skills/*`
- `skill_dirs` 仅用于追加额外目录，不替代默认目录
- 相对路径按 workspace 根目录解析
- 在可信环境下也可支持绝对路径
- 若出现同名 skill，建议优先级为：
  1. `.openharness/skills/*`
  2. `skill_dirs` 中按声明顺序扫描到的第一个定义

### 4.6 `system_prompt`

建议结构：

```yaml
system_prompt:
  base:
    inline: |-
      ...
  llm_optimized:
    providers:
      openai:
        inline: |-
          ...
    models:
      platform/openai-default:
        file: ./.openharness/prompts/openai-default.md
  compose:
    order:
      - base
      - llm_optimized
      - agent
      - project_agents_md
      - skills
```

字段说明：

- `base`
  - workspace 级公共基础提示词
- `llm_optimized`
  - 针对 provider 或具体 model 的优化提示词
- `compose`
  - system prompt 的拼装顺序和开关

### 4.7 Prompt Source 写法

所有 prompt 段都建议支持两种来源：

- `inline`
  - 直接在 YAML 内联长文本，推荐使用 `|-`
- `file`
  - 引用外部 Markdown / text 文件

示例：

```yaml
base:
  inline: |-
    You are Open Agent Harness.
```

```yaml
base:
  file: ./.openharness/prompts/base.md
```

规则：

- `inline` 与 `file` 二选一
- `file` 路径相对 workspace 根目录解析
- prompt 文件建议使用 `.md` 或 `.txt`

### 4.8 `llm_optimized`

建议结构：

```yaml
llm_optimized:
  providers:
    openai:
      inline: |-
        ...
  models:
    platform/openai-default:
      inline: |-
        ...
```

规则：

- `models` 精确匹配优先级高于 `providers`
- provider key 使用 AI SDK provider 标识
- model key 使用完整 `model_ref`

### 4.9 `compose`

建议结构：

```yaml
compose:
  order:
    - base
    - llm_optimized
    - agent
    - project_agents_md
    - skills
  include_environment: true
  include_project_agents_md: true
  include_skills: true
```

建议支持的段名：

- `base`
- `llm_optimized`
- `agent`
- `project_agents_md`
- `skills`

规则：

- `system_reminder` 不在这里配置，仍由运行时动态注入
- `order` 只控制静态 system prompt 段的拼装顺序
- `include_environment` 控制是否注入运行环境摘要
- `include_project_agents_md` 控制是否拼入根目录 `AGENTS.md`
- `include_skills` 控制是否拼入技能摘要
## 5. Model 解析规则

### 4.1 双层来源

系统同时维护两类模型入口：

- 平台级模型入口
  - 由服务端配置并注册
- workspace 级模型入口
  - 由 `.openharness/models/*.yaml` 声明

### 4.2 可见性

进入某个 workspace 时，运行时会将两类模型入口合并成一个可见 catalog。

这意味着在同一个 workspace 内：

- 可以使用平台统一提供的模型入口
- 也可以使用项目自定义的模型入口

### 4.3 引用方式

Agent 必须通过 `model.model_ref` 显式引用模型入口。

建议格式：

- `platform/openai-default`
- `workspace/openrouter-personal`
- `workspace/中文模型`

这里的 `model_ref` 指向一个具体模型入口，而不是抽象 provider 连接。

## 6. AGENTS.md 角色

`AGENTS.md` 不是结构化执行配置，而是给 Agent 看的项目说明文档。

建议承载：

- 项目目标
- 目录结构说明
- 编码规范
- 构建和测试命令
- 常见注意事项
- 推荐工作流程

不建议承载：

- 严格依赖其解析的结构化 DSL
- 复杂权限配置
- 可执行流程定义

## 7. Agent Markdown 规范

### 6.1 目标

Agent 用于定义一个协作主体的行为、模型和可访问能力。

参考 [OpenCode Agents](https://opencode.ai/docs/zh-cn/agents/) 的设计，agent 采用 Markdown 文件管理：

- 文件名表示默认 agent 名
- YAML frontmatter 承载结构化配置
- Markdown 正文承载主 system prompt
- 额外支持 `system_reminder` 字段，用于 agent 激活或切换时注入专门的提醒段
- frontmatter 只保留少量高价值字段，避免 agent 重新演化成复杂 DSL
- 额外支持 agent 间切换和 subagent 调用的显式 allowlist

### 6.2 示例

```md
---
mode: primary
description: Implement requested changes in the current workspace
model:
  model_ref: platform/openai-default
  temperature: 0.2
system_reminder: |
  You are now acting as the builder agent.
  Focus on making concrete code changes in the current workspace.
tools:
  native:
    - shell.exec
    - file.read
    - file.write
    - file.list
  actions:
    - code.review
    - test.run
  skills:
    - repo.explorer
    - docs.reader
  mcp:
    - docs-server
switch:
  - plan
subagents:
  - repo-explorer
  - code-reviewer
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
---

# Builder

You are a pragmatic software engineering agent.
Prefer making concrete progress in the current workspace.
```

### 6.3 关键字段

- `mode`
- `description`
- `model`
- `system_reminder`
- `tools`
- `switch`
- `subagents`
- `policy`
- Markdown 正文

说明：

- agent 名默认取文件名，例如 `builder.md` -> `builder`
- frontmatter 与正文都应支持中文和其他 Unicode 字符
- Markdown 正文即该 agent 的主 system prompt
- `name` 不建议重复出现在 frontmatter 中，文件名就是单一事实来源

### 6.4 frontmatter 字段

推荐结构：

```yaml
mode: primary
description: Implement requested changes in the current workspace
model:
  model_ref: platform/openai-default
  temperature: 0.2
system_reminder: |
  You are now acting as the builder agent.
tools:
  actions:
    - code.review
    - test.run
switch:
  - plan
subagents:
  - repo-explorer
```

字段说明：

- `mode`
  - 可选；`primary`、`subagent`、`all`，默认 `primary`
- `description`
  - agent 的简短说明
- `model`
  - 指定模型入口和推理参数
- `system_reminder`
  - 可选；定义 agent 激活或切换时的提醒段内容
- `tools`
  - 可选；声明该 agent 可见的 native tools、actions、skills、mcp
- `switch`
  - 可选；声明该 agent 在当前 run 内允许切换到的其他 agent 名称列表
- `subagents`
  - 可选；声明该 agent 允许调用的 subagent 名称列表
- `policy`
  - 可选；声明步数、超时、并发等运行限制

当前建议只保留以上字段。

关于 `mode` 的约定：

- `primary`
  - 可作为 session 的当前主 agent，也可作为 `switch` 的目标
- `subagent`
  - 主要作为 `subagents` 调用目标，不建议直接作为 `switch` 目标
- `all`
  - 同时可作为主 agent 和 subagent 使用，但应谨慎使用

以下内容不建议放进 agent frontmatter：

- `name`
  - 会与文件名重复
- `context`
  - 当前由运行时按固定规则装配
- `hooks`
  - 属于运行时扩展，不属于 agent 角色定义

### 6.5 model 字段

建议结构：

```yaml
model:
  model_ref: platform/openai-default
  temperature: 0.2
```

字段说明：

- `model_ref`
  - 指向一个具体模型入口的 canonical ref
- `temperature`
- `max_tokens`

`model` 是 frontmatter 中唯一建议必填的结构化字段。

### 6.6 tools 字段

建议结构：

```yaml
tools:
  native:
    - shell.exec
    - file.read
  actions:
    - code.review
  skills:
    - repo.explorer
  mcp:
    - docs-server
```

字段说明：

- `native`
  - 允许该 agent 使用的内建工具
- `actions`
  - 允许该 agent 调用的 action 名称列表
- `skills`
  - 允许该 agent 调用的 skill 名称列表
- `mcp`
  - 允许该 agent 使用的 MCP server 名称列表

规则：

- `tools` 整体可选
- 未声明的子字段按空列表处理
- 保持 `native`、`actions`、`skills`、`mcp` 分开，不合并成统一 registry 名称
- `tools` 只表达 allowlist，不承载执行逻辑

### 6.7 switch 字段

建议结构：

```yaml
switch:
  - plan
  - build
```

字段说明：

- 列表中的每一项都是可切换的目标 agent 名
- 目标 agent 通常应为 `mode: primary` 或 `mode: all`

规则：

- `switch` 整体可选
- 未声明时默认不允许 agent 主动切换
- 仅表达 allowlist，不表达切换条件
- 运行时在执行 `agent.switch` 前，必须校验目标 agent 是否在该列表中

### 6.8 subagents 字段

建议结构：

```yaml
subagents:
  - repo-explorer
  - code-reviewer
```

字段说明：

- 列表中的每一项都是该 agent 允许调用的 subagent 名
- 目标 agent 通常应为 `mode: subagent` 或 `mode: all`

规则：

- `subagents` 整体可选
- 未声明时默认不允许 agent 主动调用 subagent
- 运行时在执行 `agent.delegate` 或等价 task tool 前，必须校验目标 agent 是否在该列表中
- `subagents` 表达的是 delegation allowlist，不影响用户手动选择 agent

### 6.9 policy 字段

建议结构：

```yaml
policy:
  max_steps: 40
  run_timeout_seconds: 1800
  tool_timeout_seconds: 120
```

建议先只保留少量限制型字段：

- `max_steps`
- `run_timeout_seconds`
- `tool_timeout_seconds`
- `parallel_tool_calls`

不建议在 `policy` 中加入复杂路由、重试、流程控制或条件表达式。

### 6.10 正文 prompt 规则

- Markdown 正文是该 agent 的主 system prompt
- 运行时会保留正文文本内容，不要求解析特定标题结构
- 可以使用多段文本、标题、列表等 Markdown 组织 prompt
- 若正文为空，则视为 agent 定义不完整

### 6.11 `system_reminder` 规则

`system_reminder` 用于对齐 OpenCode 切换 agent 时的提醒语义。

运行时在以下场景注入该段：

- 创建 session 时显式选择了某个 agent
- 同一 session 内从 agent A 切换到 agent B

注入形式建议为：

```text
<system_reminder>
{标准切换提示 + agent.system_reminder}
</system_reminder>
```

规则：

- `system_reminder` 是可选字段
- 运行时负责包裹 `<system_reminder>` 标签
- 该段默认只在 agent 激活或切换时注入，不在每轮对话重复注入
- 适合放角色切换提醒、边界说明、交接要求、工具偏好等内容
- 不建议把完整主 prompt 重复写入 `system_reminder`

## 8. Model YAML 规范

### 7.1 目标

Model YAML 用于声明 workspace 级模型入口。

其中 `provider` 字段应对齐 [AI SDK Providers](https://ai-sdk.dev/docs/foundations/providers-and-models#ai-sdk-providers)。

### 7.2 示例

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5

openrouter-main:
  provider: openai-compatible
  key: ${env.OPENROUTER_API_KEY}
  url: https://openrouter.ai/api/v1
  name: openai/gpt-5
```

### 7.3 关键字段

- 顶层 key
  - 模型入口的自定义名称
- `provider`
  - AI SDK provider 标识
- `key`
  - 密钥或密钥引用，建议使用变量引用
- `url`
  - 可选，自定义 endpoint 或兼容接口地址
- `name`
  - 该自定义名称对应的唯一模型名

说明：

- 一个文件可以声明多个模型入口
- 每个自定义名称只对应一个模型
- 顶层自定义名称支持中文和其他 Unicode 字符
- `model_ref` 中的自定义名称部分也支持中文和其他 Unicode 字符
- `key` 建议写变量引用，例如 `${env.OPENAI_API_KEY}`

## 9. Action 目录规范

### 8.1 目标

Action 表达一个可被模型和用户调用的命名任务入口。

Action 不再承担通用工作流 DSL 的职责，而是把固定执行逻辑封装成一个高层入口。

### 8.2 目录结构

最小结构：

```text
actions/
  test-run/
    ACTION.yaml
```

常见结构：

```text
actions/
  test-run/
    ACTION.yaml
    scripts/
    references/
    assets/
```

### 8.3 示例

```yaml
name: test.run
description: Run project tests

expose:
  to_llm: true
  callable_by_user: true
  callable_by_api: true

input_schema:
  type: object
  properties:
    watch:
      type: boolean
  additionalProperties: false

entry:
  command:
    - bash
    - -lc
    - npm test
```

### 8.4 当前 DSL 约束

- 一个 action 只声明一个入口
- 入口统一使用 `command`
- `command` 支持 `string | string[]`
- shell 命令、本地脚本和解释器调用都通过 `command` 表达
- 复杂编排逻辑交给脚本或被调用的程序实现
- 不提供 steps / if / loop / matrix / DAG 语义

### 8.5 顶层字段

- `name`
- `description`
- `expose`
- `input_schema`
- `entry`

### 8.6 `ACTION.yaml` 规范

`ACTION.yaml` 是 action 的主定义文件。

推荐与 action 目录配合使用：

- `scripts/`
  - action 内部用到的脚本
- `references/`
  - 补充文档
- `assets/`
  - 模板和静态资源

### 8.7 `entry` 字段

建议结构：

```yaml
entry:
  command:
    - bash
    - -lc
    - npm test
```

字段说明：

- `command`
  - 命令字符串或显式命令数组
- `environment`
  - 可选，追加环境变量
- `cwd`
  - 可选，工作目录
- `timeout_seconds`
  - 可选，当前 action 超时

规则：

- 推荐使用 `string[]`
- 若使用 `string`，则按 shell 命令执行

### 8.8 `command` 示例

字符串形式：

```yaml
entry:
  command: npm test
```

Shell：

```yaml
entry:
  command:
    - bash
    - -lc
    - npm test
```

Python：

```yaml
entry:
  command:
    - python
    - ./scripts/run_tests.py
    - --watch
```

JS：

```yaml
entry:
  command:
    - node
    - ./scripts/run-tests.js
```

TypeScript：

```yaml
entry:
  command:
    - npx
    - tsx
    - ./scripts/code-review.ts
```

### 8.9 设计原则

- action 是命名任务入口，不是工作流语言
- action 内部复杂逻辑优先放在命令调用的脚本或程序中
- 模型调用 action 时，只需要理解 action 的高层语义，不需要关心内部实现

## 10. Skill 目录规范

### 9.1 目标

Skill 表达能力封装型能力，仍可被 LLM 直接调用，但语义上不同于 Action。

Skill 采用目录式组织，参考 [Agent Skills](https://agentskills.io/home) 规范。

### 9.2 目录结构

最小结构：

```text
skills/
  repo-explorer/
    SKILL.md
```

常见结构：

```text
skills/
  repo-explorer/
    SKILL.md
    scripts/
    references/
    assets/
```

### 9.3 `SKILL.md` 规范

`SKILL.md` 是 skill 的主入口文件。

frontmatter 是可选的，不做强约束。

如果提供 frontmatter，推荐字段包括：

- `name`
- `description`
- `license`
- `compatibility`
- `metadata`
- `allowed-tools`

frontmatter 和正文都应支持中文及其他 Unicode 字符。

带 frontmatter 的示例：

```md
---
name: repo-explorer
description: Explore repository structure and summarize key modules. Use when the task requires understanding project layout and major components.
---

# Repo Explorer

1. List key files and directories.
2. Read only the most relevant files first.
3. Summarize findings before taking action.
```

无 frontmatter 的示例：

```md
# 仓库探索器

适用于需要快速理解项目目录结构、核心模块和主要入口文件的场景。

1. 先列出关键目录和文件。
2. 优先阅读最相关的少量文件。
3. 输出结构化总结。
```

### 9.4 加载规则

- 发现阶段优先读取 `SKILL.md` frontmatter
- 若无 frontmatter，则从目录名和正文推断基础元数据
- 激活 skill 后再读取完整 `SKILL.md`
- `scripts/`、`references/`、`assets/` 按需加载
- skill 名称允许与目录名不同，但建议保持语义一致

### 9.5 目录约定

- `scripts/`
  - 可执行脚本
- `references/`
  - 按需读取的补充文档
- `assets/`
  - 模板、图片、数据文件等静态资源

## 11. MCP 目录规范

### 10.1 目标

MCP 采用目录式组织：

- `settings.yaml`
  - MCP server 注册中心
- `servers/`
  - 本地代码型 MCP server 目录

这种方式更适合同时支持：

- workspace 自带 MCP server
- 用户上传自己的 MCP server 代码
- 远程 MCP server
- stdio / http 等不同连接方式
- 显式声明本地 server 的启动命令

### 10.2 目录结构

```text
mcp/
  settings.yaml
  servers/
    docs-server/
      package.json
      index.js
    browser/
      package.json
      server.py
```

### 10.3 `settings.yaml` 规范

`settings.yaml` 用于声明当前 workspace 中可见的 MCP servers。

建议结构：

```yaml
docs-server:
  command:
    - node
    - ./servers/docs-server/index.js
  enabled: true
  environment:
    DOCS_TOKEN: ${secrets.DOCS_TOKEN}
  timeout: 30000
  expose:
    tool_prefix: mcp.docs
    include:
      - search
      - fetch

browser:
  url: https://example.com/mcp
  headers:
    Authorization: Bearer ${secrets.BROWSER_TOKEN}
  enabled: true
  timeout: 30000
  oauth: false
```

### 10.4 设计原则

- `settings.yaml` 负责注册、命名、启用、暴露策略和连接参数
- 有 `command` 的 server 视为本地进程型 server
- 有 `url` 的 server 视为远程 server
- 每个 server 必须二选一，只能声明 `command` 或 `url`
- 本地代码目录建议放在 `servers/<name>/`
- 远程 server 可以只在 `settings.yaml` 中声明，无需本地目录
- 运行时应支持用户上传自己的 server 目录
- `settings.yaml` 是当前 workspace 的单一 MCP 配置入口
- `command` 支持字符串或数组，推荐数组形式以避免 shell 解析歧义

### 10.5 当前范围

- 支持 `stdio`
- 支持 `http`
- 从 workspace 关联 secrets 或平台注入环境中读取认证信息
- 支持本地代码型 server 和远程 server 并存
- 本地 server 使用 `command` 声明启动方式

## 12. Hook YAML 规范

### 11.1 目标

Hook 用于运行时扩展和拦截，不对 LLM 直接暴露。

### 11.2 示例

```yaml
name: redact-secrets
events:
  - before_model_call

handler:
  type: code
  entry: ./.openharness/hooks/redact-secrets.ts

capabilities:
  - rewrite_model_request
```

### 11.3 当前建议限制

- Hook 入口统一使用本地代码文件
- 只允许声明少量 capability
- 只能操作当前 run 的上下文对象

## 13. 运行时加载规则

### 12.1 缓存策略

- workspace 配置在首次访问时加载
- 文件变更可通过 mtime 或 hash 触发缓存失效
- 运行时可维护基于 workspace 的内存缓存

### 12.2 失败策略

- YAML 语法错误时，标记该定义加载失败
- 单个定义失败不应导致整个 workspace 不可用
- Agent 启动时若引用不存在的 action / skill / mcp / hook，则该 run 失败并返回明确错误

## 14. 配置校验

建议在加载时进行：

- Agent Markdown frontmatter 解析校验
- YAML 解析校验
- JSON Schema 校验
- 引用存在性校验
- 名称唯一性校验
- tool 暴露名称冲突校验

对应 schema 文件：

- `settings` -> [schemas/settings.schema.json](./schemas/settings.schema.json)
- `models` -> [schemas/models.schema.json](./schemas/models.schema.json)
- `action` -> [schemas/action.schema.json](./schemas/action.schema.json)
- `mcp settings` -> [schemas/mcp-settings.schema.json](./schemas/mcp-settings.schema.json)
- `hook` -> [schemas/hook.schema.json](./schemas/hook.schema.json)

说明：

- `agent` 不使用本地 JSON Schema 强约束
- 运行时主要校验 frontmatter 可解析性、`model.model_ref` 存在性、`tools` 引用存在性和文件名一致性
