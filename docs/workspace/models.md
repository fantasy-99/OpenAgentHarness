# Models

## 双层来源

系统维护两类模型入口：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 平台级 | 服务端 `paths.model_dir` | 由服务端配置并注册 |
| Workspace 级 | `.openharness/models/*.yaml` | 由 workspace 声明 |

两类入口使用同一套 YAML 结构。进入 workspace 时，运行时将两者合并成可见 catalog。

## 引用方式

模型入口本身仍然定义在 `.openharness/models/*.yaml` 或平台 `model_dir` 中，但 agent 不再直接写具体 `model_ref`。

推荐做法：

1. 在 `.openharness/settings.yaml` 里声明模型别名
2. 在 `.openharness/agents/*.md` 里通过 `model` 直接引用

例如：

```yaml
# .openharness/settings.yaml
models:
  default:
    ref: platform/openai-default
    temperature: 0.2
    max_tokens: 2048
  planner:
    ref: workspace/openrouter-personal
```

```yaml
# .openharness/agents/builder.md
model: default
```

加载时，运行时会把别名解析成具体 `model_ref`，并带上该别名对应的默认推理参数。因此“切换具体模型”或调整这组默认参数，都只需要修改 `settings.yaml`。

## Model YAML 示例

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

## 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 顶层 key | 是 | 模型入口名称，支持中文 |
| `provider` | 是 | AI SDK provider 标识，见 [model-providers](./model-providers.md) |
| `key` | 是 | 密钥引用，建议 `${env.OPENAI_API_KEY}` |
| `url` | 否 | 自定义 endpoint（`openai-compatible` 必填） |
| `name` | 是 | 对应的模型名 |

一个文件可声明多个模型入口。具体 `model_ref` 中的名称部分支持中文和其他 Unicode 字符。
