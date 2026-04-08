# Models

## 双层来源

系统维护两类模型入口：

| 来源 | 位置 | 说明 |
| --- | --- | --- |
| 平台级 | 服务端 `paths.model_dir` | 由服务端配置并注册 |
| Workspace 级 | `.openharness/models/*.yaml` | 由 workspace 声明 |

两类入口使用同一套 YAML 结构。进入 workspace 时，运行时将两者合并成可见 catalog。

## 引用方式

Agent 通过 `model.model_ref` 显式引用：

- `platform/openai-default`
- `workspace/openrouter-personal`
- `workspace/中文模型`

`model_ref` 指向具体模型入口，不是抽象 provider 连接。

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

一个文件可声明多个模型入口。`model_ref` 中的名称部分支持中文和其他 Unicode 字符。
