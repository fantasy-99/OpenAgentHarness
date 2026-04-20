import { memo, type ReactNode } from "react";

import { Network, RefreshCw, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { EmptyState, EntityPreview } from "../primitives";
import { useHealthStore } from "../stores/health-store";
import { useModelsStore } from "../stores/models-store";
import { useSettingsStore } from "../stores/settings-store";
import { useStreamStore } from "../stores/stream-store";
import { useUiStore } from "../stores/ui-store";
import { probeTone, streamTone, toneBadgeClass } from "../support";
import type { useAppController } from "../use-app-controller";
import { InspectorPanelHeader } from "../inspector-panels";

type ProviderProps = ReturnType<typeof useAppController>["providerSurfaceProps"];

function Section(props: { title: string; description: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ob-section space-y-4 rounded-[20px] p-5">
      <InspectorPanelHeader title={props.title} description={props.description} action={props.action} />
      {props.children}
    </section>
  );
}

function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value.toLocaleString() : "unknown";
}

function ProviderWorkspaceImpl(props: ProviderProps) {
  const connection = useSettingsStore((state) => state.connection);
  const setConnection = useSettingsStore((state) => state.setConnection);
  const modelDraft = useSettingsStore((state) => state.modelDraft);
  const setModelDraft = useSettingsStore((state) => state.setModelDraft);
  const healthStatus = useHealthStore((state) => state.healthStatus);
  const healthReport = useHealthStore((state) => state.healthReport);
  const readinessReport = useHealthStore((state) => state.readinessReport);
  const modelProviders = useModelsStore((state) => state.modelProviders);
  const platformModels = useModelsStore((state) => state.platformModels);
  const streamState = useStreamStore((state) => state.streamState);
  const generateOutput = useStreamStore((state) => state.generateOutput);
  const generateBusy = useStreamStore((state) => state.generateBusy);
  const setStreamRevision = useUiStore((state) => state.setStreamRevision);

  const readinessLabel = readinessReport?.status ?? "unknown";
  const defaultModel = platformModels.find((model) => model.isDefault);
  const selectedModel =
    platformModels.find((model) => model.id === modelDraft.model) ?? defaultModel ?? platformModels[0];
  const providerIndex = new Map<string, (typeof modelProviders)[number]>(
    modelProviders.map((provider) => [provider.id, provider])
  );
  const providerSummaries = modelProviders.map((provider) => ({
    ...provider,
    modelCount: platformModels.filter((model) => model.provider === provider.id).length
  }));

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="space-y-4">
          <div className="grid gap-4 2xl:grid-cols-[minmax(360px,0.82fr)_minmax(0,1.18fr)]">
            <div className="space-y-4">
              <Section
                title="Connection"
                description="配置 API 地址、token，并触发健康检查或 SSE 重连。状态摘要压缩在这里，不再重复成独立卡片。"
                action={
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={props.pingHealth}>
                      <Network className="h-4 w-4" />
                      Health
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setStreamRevision((current) => current + 1)}>
                      <RefreshCw className="h-4 w-4" />
                      SSE
                    </Button>
                  </div>
                }
              >
                <Input
                  value={connection.baseUrl}
                  onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="Base URL"
                />
                <Input
                  value={connection.token}
                  onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))}
                  placeholder="Bearer token (optional)"
                />

                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className={toneBadgeClass(probeTone(healthStatus))}>{`health ${healthStatus}`}</Badge>
                  <Badge variant="outline" className={toneBadgeClass(streamTone(streamState))}>{`stream ${streamState}`}</Badge>
                  <Badge variant="outline" className={toneBadgeClass(probeTone(readinessLabel))}>{`ready ${readinessLabel}`}</Badge>
                </div>
              </Section>

              <Section title="Diagnostics" description="保留原始 health / readiness 结果，便于快速核对服务与依赖状态。">
                {healthReport || readinessReport ? (
                  <div className="space-y-3">
                    {healthReport ? <EntityPreview title="healthz" data={healthReport} /> : null}
                    {readinessReport ? <EntityPreview title="readyz" data={readinessReport} /> : null}
                  </div>
                ) : (
                  <EmptyState title="No diagnostics yet" description="Run Health once to load service and dependency diagnostics." />
                )}
              </Section>
            </div>

            <div className="space-y-4">
              <Section
                title="Selected Model"
                description="集中展示 provider 摘要和当前选中模型详情。模型切换放在侧边栏完成。"
              >
                {providerSummaries.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {providerSummaries.map((provider) => (
                      <div
                        key={provider.id}
                        className="flex items-center gap-2 rounded-full border border-border/70 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground"
                      >
                        <span className="font-medium text-foreground">{provider.id}</span>
                        <span>{provider.modelCount} models</span>
                        {provider.requiresUrl ? <span>URL required</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {selectedModel ? (
                  <div className="space-y-4">
                    <div className="rounded-[18px] border border-border/70 bg-background/75 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge>{selectedModel.id}</Badge>
                        <Badge variant="outline">{selectedModel.provider}</Badge>
                        <Badge variant="outline">{selectedModel.modelName}</Badge>
                        {selectedModel.isDefault ? <Badge className="bg-foreground text-background">default</Badge> : null}
                        {selectedModel.url ? <Badge variant="outline">custom url</Badge> : null}
                        {selectedModel.hasKey ? (
                          <Badge variant="outline" className={toneBadgeClass("emerald")}>key ready</Badge>
                        ) : (
                          <Badge variant="outline" className={toneBadgeClass("amber")}>no key</Badge>
                        )}
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="border-l border-border/70 pl-4">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Provider Package</p>
                          <p className="mt-2 text-sm text-foreground">
                            {providerIndex.get(selectedModel.provider)?.packageName ?? "unknown provider"}
                          </p>
                        </div>
                        <div className="border-l border-border/70 pl-4">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Base URL</p>
                          <p className="mt-2 break-all text-sm text-foreground">{selectedModel.url ?? "provider default"}</p>
                        </div>
                        <div className="border-l border-border/70 pl-4">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Context Window
                          </p>
                          <p className="mt-2 text-sm text-foreground">{formatTokenCount(selectedModel.contextWindowTokens)}</p>
                        </div>
                      </div>
                    </div>
                    {selectedModel.metadata ? <EntityPreview title={`${selectedModel.id}.metadata`} data={selectedModel.metadata} /> : null}
                  </div>
                ) : (
                  <EmptyState title="No models" description="Use the sidebar to refresh and load platform models from paths.model_dir." />
                )}
              </Section>

              <Section title="Model Playground" description="做单次模型验证，不依赖当前 Inspector 状态，也不打断正在看的 session 诊断。">
                <Select
                  value={selectedModel?.id ?? modelDraft.model}
                  onValueChange={(value) => setModelDraft((current) => ({ ...current, model: value }))}
                >
                  <SelectTrigger aria-label="Platform model">
                    <SelectValue placeholder="Choose a loaded model" />
                  </SelectTrigger>
                  <SelectContent>
                    {platformModels.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.id} · {model.modelName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  value={modelDraft.prompt}
                  onChange={(event) => setModelDraft((current) => ({ ...current, prompt: event.target.value }))}
                  className="min-h-32"
                  placeholder="Prompt"
                />
                <Button onClick={props.generateOnce} disabled={generateBusy}>
                  <Sparkles className="h-4 w-4" />
                  Generate
                </Button>
                {generateOutput ? (
                  <EntityPreview title={generateOutput.model} data={generateOutput} />
                ) : (
                  <EmptyState title="No output" description="Generate output appears here after a single-shot request." />
                )}
              </Section>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export const ProviderWorkspace = memo(ProviderWorkspaceImpl);
