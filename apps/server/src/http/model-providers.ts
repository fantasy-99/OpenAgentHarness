export interface SupportedModelProviderDefinition {
  id: string;
  packageName: string;
  description: string;
  requiresUrl: boolean;
  useCases: string[];
}

export const SUPPORTED_MODEL_PROVIDERS = [
  {
    id: "openai",
    packageName: "@ai-sdk/openai",
    description: "OpenAI 官方 provider，适合直接连接 OpenAI 兼容度最高的官方接口。",
    requiresUrl: false,
    useCases: ["直接调用 OpenAI 官方模型", "需要 OpenAI provider 的完整特性集"]
  },
  {
    id: "openai-compatible",
    packageName: "@ai-sdk/openai-compatible",
    description: "OpenAI 兼容接口 provider，适合接入第三方或自建的 `/chat/completions` 风格端点。",
    requiresUrl: true,
    useCases: ["OpenRouter 等兼容端点", "自建网关", "学校或企业内网的兼容代理"]
  }
] as const satisfies readonly SupportedModelProviderDefinition[];
