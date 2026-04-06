import { Bot, Network, Orbit, Sparkles } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { probeTone } from "../support";
import type { useAppController } from "../use-app-controller";

type HeaderProps = ReturnType<typeof useAppController>["headerProps"];

function statusClass(tone: "sky" | "emerald" | "rose" | "amber") {
  switch (tone) {
    case "emerald":
      return "border-emerald-200/80 bg-emerald-50/70 text-emerald-700";
    case "rose":
      return "border-rose-200/80 bg-rose-50/70 text-rose-700";
    case "amber":
      return "border-amber-200/80 bg-amber-50/70 text-amber-700";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function StatusPill(props: { label: string; value: string; tone: "sky" | "emerald" | "rose" | "amber"; icon: typeof Network }) {
  const Icon = props.icon;
  return (
    <div className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${statusClass(props.tone)}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="uppercase tracking-[0.14em]">{props.label}</span>
      <span className="font-medium normal-case tracking-normal">{props.value}</span>
    </div>
  );
}

export function AppHeader(props: HeaderProps) {
  return (
    <header className="app-topbar flex min-h-[52px] items-center justify-between gap-4 border-b border-border/80 px-6 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-gradient-to-br from-background via-card to-muted/70 shadow-[0_10px_24px_rgba(17,19,24,0.08)]">
          <Bot className="h-4 w-4 text-foreground" />
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background shadow-[0_4px_10px_rgba(17,19,24,0.18)]">
            <Sparkles className="h-2.5 w-2.5" />
          </span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">OpenAgentHarness</p>
            <span className="hidden rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground md:inline-flex">
              Beta
            </span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            {props.surfaceMode === "storage" ? "Storage Workbench" : "Runtime Workbench"}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2.5">
        <Tabs value={props.surfaceMode} onValueChange={(value) => props.onSurfaceModeChange(value as HeaderProps["surfaceMode"])}>
          <TabsList className="h-8">
            <TabsTrigger value="runtime" className="text-xs">
              Runtime
            </TabsTrigger>
            <TabsTrigger value="storage" className="text-xs">
              Storage
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="hidden items-center gap-2 xl:flex">
          <StatusPill icon={Network} label="Health" value={props.healthStatus} tone={probeTone(props.healthStatus)} />
          <StatusPill
            icon={Orbit}
            label="Stream"
            value={props.streamState}
            tone={props.streamState === "open" || props.streamState === "listening" ? "emerald" : props.streamState === "error" ? "rose" : "sky"}
          />
        </div>
      </div>
    </header>
  );
}
