# OAH Kubernetes Deployment Roadmap

## 1. Purpose

这份 roadmap 用来明确 OAH 后续面向 Kubernetes 部署时的优化方向、补强重点和推进顺序。

目标不是为了“把当前 Docker Compose 方案重写成另一套控制逻辑”，而是基于当前已经存在的 split deployment 与 `scale_target` 适配层，把 K8S 路径逐步补到可观测、可扩缩、可运维、可回滚的生产级形态。

这份路线图关注的是：

- `oah-api`
- `oah-controller`
- `oah-sandbox` / standalone `worker`
- 与它们相关的 manifests / Helm / 运维约束

不把本地开发链路当成负担清理掉，而是保留：

- `docker_compose` target 继续服务本地开发和单机验证
- `kubernetes` target 继续作为未来生产部署主路径

## 2. Current State

当前代码基线里，K8S 方向已经有一个可以继续演进的基础，而不是从零开始。

### 2.1 Already In Place

- `controller` 已经通过 `WorkerReplicaTarget` 抽象把“计算 desired replicas”和“实际应用副本数”解耦
- `scale_target` 已支持：
  - `noop`
  - `docker_compose`
  - `kubernetes`
- `kubernetes` target 已支持：
  - 通过 `Deployment /scale` 修改副本数
  - 通过 `label_selector` 自动发现目标 Deployment
- `controller` 已支持 Kubernetes Lease leader election
- 仓库已经提供：
  - `deploy/kubernetes/` 的最小 split deployment 骨架
  - `deploy/charts/open-agent-harness/` 的 Helm chart
  - `controller` 的 health / ready / metrics / snapshot 暴露
- standalone worker 已具备基础 drain 语义和 readiness 摘除能力

### 2.2 Confirmed Direction

当前更合理的方向是：

- 不重写 `docker_compose` target 为 Docker Engine API 作为 K8S 前置工作
- 保留 Compose 路径用于 local/dev
- 优先补强 `kubernetes` scale target、controller HA、worker drain、manifests 与 observability

这是因为现在真正和 K8S 生产落地相关的风险，不在 Compose 控制方式，而在以下几个面：

- scale target 的能力边界仍偏薄
- rollout / drain / readiness / failover 语义还不够完整
- chart / manifest 仍是“起步骨架”，不是“生产交付标准件”
- 可观测性、RBAC、NetworkPolicy、secret/config 分层还需要系统化补齐

## 3. Design Principles

后续所有 K8S 补强都应遵循下面几条原则。

### 3.1 Keep The Adapter Boundary

保留当前边界：

- `controller` 负责算出目标状态
- `scale_target` 负责把目标状态应用到具体平台

不要把平台细节重新灌回 controller 主循环。

### 3.2 Compose And Kubernetes Must Coexist

本地开发与生产部署不需要共享同一套基础设施实现，但应该共享同一套控制面语义。

也就是说：

- 本地继续可以走 `docker_compose`
- 生产继续走 `kubernetes`
- 控制逻辑、指标、状态语义尽量保持一致

### 3.3 Avoid Premature Operator / CRD

在现阶段，不应直接跳到：

- 自定义 Operator
- CRD-first 编排模型
- 用平台抽象重写整个 controller

先把现有 `Deployment /scale + Lease + Helm` 这条路径补完整，再看是否真的需要更重的控制器模型。

### 3.4 Treat Rollout Semantics As First-Class

在 K8S 上，“副本数已经 patch 成功”不等于“容量真的已经可用”。

后续 controller 与 scale target 需要显式区分：

- 期望副本数已提交
- 新 Pod 已创建
- 新 Pod 已 ready
- 新容量已可承接 workload
- 缩容目标已被 drain 完成

### 3.5 Optimize For Operational Clarity

后续改动需要优先提升这三件事的可解释性：

- controller 当前为什么决定 scale up / scale down
- 某次扩缩容为什么被阻塞
- 某次 rollout / failover 现在卡在哪一步

## 4. Gap Analysis

### 4.1 Scale Target Capability Gaps

当前 `kubernetes` target 的核心短板主要是：

- 只聚焦 `Deployment /scale`
- 还没有明确支持 `StatefulSet`
- 对 rollout 状态的理解较浅，主要是“读 replicas / patch replicas”
- 对 selector 发现结果缺少更强的校验与错误分类
- 还没有把 `accepted`, `progressing`, `ready`, `blocked`, `failed` 这些状态清晰建模

### 4.2 Controller HA Gaps

虽然已有 Lease leader election，但还需要继续明确：

- lease 参数调优建议
- leader 丢失、网络抖动、API Server 短暂失败时的行为
- 多 controller 副本下的观测与排障方式
- stale leader / reconcile overlap 的测试覆盖

### 4.3 Worker Lifecycle Gaps

worker 侧已有基础 drain，但仍缺：

- 与 K8S `preStop`、readiness、termination grace 的系统联动
- 缩容前后 workspace / session / queue 的更精细闭环
- PDB 与 scale-down 的协同约束
- rollout 中旧 worker 退出与新 worker ready 的承接验证

### 4.4 Packaging And Ops Gaps

现在 chart / manifests 已经能用，但距离生产标准还差：

- 更明确的 requests / limits 基线
- probes、PDB、topology spread、anti-affinity 的默认策略
- 分环境 values 约定
- secret / config / endpoint / ingress 的分层规范
- NetworkPolicy、RBAC 最小权限收缩

### 4.5 Observability Gaps

还需要把下面几类信息补齐：

- scale decision metrics
- scale target apply latency / failure metrics
- leader election metrics
- rollout / drain / workspace flush 指标
- 关键事件与结构化日志字段

### 4.6 Validation Gaps

需要从“能启动”提升到“能证明稳定”：

- scale up / scale down e2e
- leader failover e2e
- rollout / drain e2e
- K8S API 异常注入
- staging checklist 与 chaos drill

## 5. Delivery Phases

### Phase 0: Freeze The K8S Contract

目标：
先把现有 K8S 路径的契约、组件职责和配置面冻结清楚，避免边做边漂移。

交付项：

- 明确记录 `controller.scale_target.kubernetes.*` 的正式配置语义
- 明确记录 `controller.leader_election.kubernetes.*` 的正式配置语义
- 明确 `api` / `controller` / `worker` 三个 Deployment 的职责边界
- 明确 local Compose 与 K8S 的映射关系，避免后续文档出现两套心智模型
- 补一份 K8S 生产部署最小参数表

建议落点：

- `docs/deploy.md`
- `docs/server-config.md`
- `docs/engine/split-deployment.md`
- Helm chart README / example values

退出标准：

- 新同学可以只看文档完成一次最小 K8S split 部署
- controller / worker / api 的职责边界不再依赖口头约定

### Phase 1: Harden The Kubernetes Scale Target

目标：
把当前“能 patch 副本数”的 scale target，补强成“能表达真实扩缩容过程”的目标适配层。

交付项：

- 为 `kubernetes` scale target 增加更细的结果状态：
  - request accepted
  - steady
  - progressing
  - ready
  - blocked
  - error
- 在 reconcile 结果里纳入更多观测字段：
  - `readyReplicas`
  - `updatedReplicas`
  - `availableReplicas`
  - `observedGeneration`
- 强化 `label_selector` 发现逻辑：
  - 0 个目标时报错要更明确
  - 多个目标命中时要显式阻断
  - 把“发现失败”和“scale 失败”分开建模
- 增加对 K8S API 超时、429、5xx、权限不足的错误分类
- 补齐单测与 mock K8S API 测试

退出标准：

- controller 可以明确区分“已提交扩容”与“扩容已 ready”
- K8S scale 失败时日志和指标能直接指出失败阶段

### Phase 2: Expand Workload Model

目标：
把 K8S target 从单一 `Deployment` 心智，扩到更可扩展的 workload 形态。

交付项：

- 在 `scale_target.kubernetes` 下显式引入 workload 类型：
  - `Deployment`
  - `StatefulSet`
- 把当前 `deployment` 配置扩成更通用的 target identity 结构
- 对未来多 worker pool 做准备：
  - 按 label / class / tier 指向不同 worker group
  - 为后续冷热池、GPU/CPU 池、owner-affinity pool 预留字段
- 明确与 HPA 的关系：
  - 当前默认不和 HPA 混用
  - 如果混用，谁是 source of truth 要写死

退出标准：

- K8S target 不再被 `Deployment` 名称写死
- 后续新增 worker pool 不需要回头重构 controller 主循环

### Phase 3: Strengthen Controller HA And Failure Semantics

目标：
把“已有 leader election”升级成“可多副本稳定运行的 controller 控制面”。

交付项：

- 为 leader election 暴露更完整的 metrics / snapshot 字段
- 明确 lease 参数推荐值与环境差异：
  - dev
  - staging
  - prod
- 增加 leader failover 集成测试
- 验证网络抖动、apiserver timeout、Lease 更新失败时的行为
- 对 reconcile loop 做防重复、防重入观测
- 明确非 leader 副本的 readiness / health 行为是否需要差异化暴露

退出标准：

- controller 可安全跑成 2+ 副本
- leader 切换时不会出现明显的重复扩缩容抖动

### Phase 4: Make Worker Drain Kubernetes-Native

目标：
把 worker 的退出、缩容、滚动更新流程补齐成真正的 K8S lifecycle。

交付项：

- 明确 worker 在收到终止信号后的阶段：
  - 立即摘 readiness
  - 停止接收新任务
  - 等待运行中任务自然结束
  - flush / evict 可清理 workspace
  - 超时后退出
- 把这些阶段和 K8S 配置对齐：
  - `preStop`
  - `terminationGracePeriodSeconds`
  - readiness probe
  - PodDisruptionBudget
- controller 在 scale down 时考虑 drain 中实例，不把它们误判为可立即回收容量
- 验证 rollout 时的旧 Pod 退出 / 新 Pod ready 衔接

退出标准：

- 滚动发布和 scale down 不会明显打断活跃 run
- worker 的 drain 状态可以从日志、metrics、probe 上看出来

### Phase 5: Productionize Chart And Manifest Defaults

目标：
把当前 manifests / Helm 从“示例骨架”推进到“组织内可复用基线”。

交付项：

- 为 `api` / `controller` / `worker` 分别定义默认 requests / limits 档位
- 明确默认 probe 策略与阈值
- 为 worker 默认启用更合理的：
  - PDB
  - topology spread
  - anti-affinity / node affinity
- 把 `ConfigMap`、`Secret`、`envFrom`、object storage endpoint 约定清楚
- 补 `NetworkPolicy` 示例
- 继续收紧 `controller` 的 RBAC，只保留实际需要的 verbs / resources
- 梳理 Ingress / Service / internal-only service 的默认暴露策略

退出标准：

- 团队内新环境落地时，不需要每次从零手搓 values
- chart 示例 values 能覆盖 dev / staging / prod 三档起步场景

### Phase 6: Observability And SLO Readiness

目标：
让 K8S 上的控制面和执行面具备生产排障能力，而不是只能看容器是否存活。

交付项：

- 新增并规范下列指标：
  - scale decision count
  - scale apply latency
  - scale blocked reason count
  - rollout progress lag
  - leader changes
  - worker drain duration
  - workspace flush / evict latency
- 补统一结构化日志字段：
  - worker pool
  - target workload
  - desired / observed / ready replicas
  - leadership identity
  - reconcile reason
- 提供 Prometheus / ServiceMonitor / Grafana 起步模板
- 定义最小 SLO / 告警建议：
  - controller reconcile error rate
  - worker unavailable replica duration
  - backlog aging
  - stuck drain duration

退出标准：

- 发生扩容卡住、缩容卡住、leader 抖动、worker drain 卡住时，可以在几分钟内定位问题阶段

### Phase 7: Validation, Staging, And Release Gate

目标：
把 K8S 路径从“文档上可行”提升到“变更前后都可验证”。

交付项：

- 建立一套 K8S e2e 验证矩阵：
  - cold start
  - scale up
  - scale down
  - rolling update
  - leader failover
  - object storage / Redis / Postgres 短暂异常
- 增加 staging 环境发布检查单
- 增加版本升级 / 回滚检查单
- 补一轮 failure drill：
  - kill leader
  - kill worker during drain
  - apiserver timeout
  - target workload missing / selector mismatch

退出标准：

- 每次发布前可以跑固定的 K8S 验证集
- 关键故障不再依赖人工临场猜测

## 6. Recommended Execution Order

建议按下面顺序推进，而不是并行乱铺：

1. Phase 0
2. Phase 1
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 2

说明：

- `Phase 2` 很重要，但不是最早阻塞项
- 真正先卡生产可用性的，是 scale target 语义、leader failover、worker drain 与可观测性
- workload model 扩展更适合在第一轮生产路径跑稳后再做

## 7. What We Should Not Do Now

现阶段明确不优先做：

- 不把 `docker_compose` target 重写为 Docker Engine API 作为 K8S 前置工作
- 不为了 K8S 先引入 Operator / CRD
- 不在控制面尚未稳定前引入过度复杂的多池调度策略
- 不让本地开发链路和生产链路分叉成两套完全不同的控制语义

## 8. Success Criteria

当下面这些条件都满足时，可以认为 OAH 的 K8S 路径进入“可稳定扩展”的阶段：

- controller 可以 2+ 副本高可用运行
- `kubernetes` scale target 能清晰表达 accepted / progressing / ready / blocked / failed
- worker rollout 与 scale down 已具备可验证 drain 语义
- Helm / manifests 可以直接作为团队默认部署基线
- 关键扩缩容、failover、drain、rollout 问题能通过 metrics + logs 快速定位
- staging 已有固定发布检查和故障演练清单

## 9. Immediate Next Slice

如果按最小闭环来推进，建议下一轮先做这 4 件事：

1. 补齐 `docs/server-config.md` 与 `docs/deploy.md` 中 K8S 配置契约
2. 强化 `packages/scale-target-control` 的 `kubernetes` target 结果建模和错误分类
3. 给 `controller` 增加 leader election / scale target 相关 metrics 与 snapshot 字段
4. 把 worker drain 与 Helm / manifests 的 lifecycle 配置完全对齐

这四步完成后，后面的 chart 生产化、SLO、staging gate 才会真正变得顺手。
