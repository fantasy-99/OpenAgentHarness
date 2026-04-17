# `@oah/runtime-core`

`runtime-core` 是 Open Agent Harness 的运行时内核包，负责会话编排、运行执行、能力装配、workspace 访问抽象，以及对上层 server/bootstrap 的核心类型与服务出口。

## 目录结构

```text
src/
  capabilities/   # 暴露给模型的能力编排层：action、skill、agent switch、runtime capability assembly
  native-tools/   # 内置本地工具的具体实现：read/write/bash/grep/web-fetch 等
  runtime/        # 运行时内部服务：编排、恢复、消息投影、模型执行、session/workspace 生命周期
  types/          # 拆分后的领域类型模块
  workspace/      # workspace 文件系统、命令执行、文件服务
```

`src` 顶层只保留包级入口、跨域基础模块和兼容性 facade，例如：

- `runtime-service.ts`
- `control-plane-runtime-service.ts`
- `execution-runtime-service.ts`
- `coordination.ts`
- `errors.ts`
- `runtime-message-content.ts`
- `types.ts`
- `index.ts`

## 子目录职责

### `capabilities/`

这一层描述“运行时允许模型看到和调用的能力”，不是底层工具实现本身。

适合放在这里的内容：

- action catalog 与 action tool 适配
- skill catalog、skill resource 暴露
- agent switch / subagent capability
- capability 可见性筛选与 runtime 装配
- capability 输出格式辅助

不适合放在这里的内容：

- `read` / `write` / `bash` 这类具体工具实现
- run queue、recovery、message sync 这类 orchestrator 服务
- workspace 文件读写底层适配

### `native-tools/`

这一层只放“真实执行”的内置工具实现和其支撑代码。

适合放在这里的内容：

- 单个内置工具实现，如 `bash.ts`、`read.ts`
- native tool 参数 schema、tool retry policy
- native tool 专用的路径、搜索、IO 辅助函数

命名上要把它理解成“built-in tool implementations”，而不是泛指整个能力体系。

### `workspace/`

这一层提供运行时访问 workspace 的抽象边界。

适合放在这里的内容：

- `WorkspaceCommandExecutor`
- `WorkspaceFileSystem`
- `WorkspaceFileService`
- 与 workspace 本地文件读写、下载、目录遍历直接相关的能力

### `runtime/`

这一层是运行时内部应用服务层，负责 orchestration 和执行流程。

适合放在这里的内容：

- run processor / recovery / state / steps
- model execution / prompt composition / session history
- runtime message projection 与 sync
- workspace runtime / session runtime 等领域服务

如果一个模块主要是“运行一轮 agent / session / run 生命周期的一部分”，通常应先考虑放在 `runtime/`。

### `types/`

这里存放按主题拆分的 runtime-core 类型模块，`src/types.ts` 作为 barrel 暴露。

## 命名约定

### 目录命名

- `capabilities/`：模型可见的能力层
- `native-tools/`：本地内置工具实现层
- `workspace/`：workspace 访问抽象层
- `runtime/`：运行时内部服务层
- `types/`：类型定义层

### 文件命名

- `*-service.ts`：有明确依赖注入和长期职责边界的服务对象
- `*-runtime.ts`：某个运行时子域的 facade 或较粗粒度服务
- `*-messages.ts`：消息转换、渲染、投影
- `*-state.ts`：状态更新与状态查询逻辑
- `*-recovery.ts`：恢复、补偿、超时回收逻辑
- `*-executor.ts`：执行抽象
- `*-file-system.ts` / `*-files.ts`：文件系统适配与更高层文件服务

如果一个文件名开始变成“什么都能装一点”的杂项名，通常说明它该被继续拆开或放错层了。

## 新代码放置规则

新增代码时，优先按下面的判断顺序放置：

1. 如果它是具体内置工具实现，放 `native-tools/`
2. 如果它是在给模型装配 action / skill / subagent / tool visibility，放 `capabilities/`
3. 如果它是在处理 workspace 文件、目录、命令执行边界，放 `workspace/`
4. 如果它是在编排 run、session、message、model execution 生命周期，放 `runtime/`
5. 如果它只是包级 facade、跨域基础错误或兼容性入口，才考虑放 `src` 顶层

## 导出约定

- 外部包应优先从 `@oah/runtime-core` 根入口导入
- `src/capabilities/index.ts` 与 `src/workspace/index.ts` 是子域聚合出口
- runtime-core 内部实现优先直接相对引用具体文件，而不是滥用 barrel，避免隐藏依赖和循环引用

## 当前整理目标

当前结构的目标不是“所有文件都塞进子目录”，而是：

- 顶层只保留真正的包入口和跨域基础模块
- 子目录表达清晰的职责边界
- 后续继续拆分时，优先做边界增强，而不是纯目录搬运
