# Model Providers

这里集中列出当前 Open Agent Harness 已支持的 `provider` 取值。

如果后续新增 provider，应同时更新：

- `packages/model-gateway/src/providers.ts`
- 本文档

## 当前支持列表

### `openai`

- AI SDK package: `@ai-sdk/openai`
- 是否必须填写 `url`: 否
- 适用场景:
  - 直接连接 OpenAI 官方接口
  - 需要 OpenAI provider 的完整特性集

示例：

```yaml
openai-default:
  provider: openai
  key: ${env.OPENAI_API_KEY}
  name: gpt-5
```

### `openai-compatible`

- AI SDK package: `@ai-sdk/openai-compatible`
- 是否必须填写 `url`: 是
- 适用场景:
  - OpenRouter 等兼容端点
  - 自建网关
  - 学校或企业内网的兼容代理

示例：

```yaml
openrouter-main:
  provider: openai-compatible
  key: ${env.OPENROUTER_API_KEY}
  url: https://openrouter.ai/api/v1
  name: openai/gpt-5
```

```yaml
kimi-campus:
  provider: openai-compatible
  key: ${env.KIMI_API_KEY}
  url: https://example.internal/v1
  name: Kimi-K25
```

## 选择建议

- 目标端点就是 OpenAI 官方接口时，用 `openai`
- 目标端点只保证 `/chat/completions` 兼容时，用 `openai-compatible`
- 如果第二轮对话、assistant 历史消息或工具流异常，优先确认 provider 选择是否正确
