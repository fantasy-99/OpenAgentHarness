import { Suspense, lazy, memo } from "react";

import { useUiStore } from "../stores/ui-store";
import type { useAppController } from "../use-app-controller";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];
const ConversationWorkspace = lazy(async () => ({
  default: (await import("../chat/ConversationWorkspace")).ConversationWorkspace
}));
const InspectorWorkspace = lazy(async () => ({
  default: (await import("../inspector/InspectorWorkspace")).InspectorWorkspace
}));

function EngineWorkspaceImpl(props: RuntimeProps) {
  const mainViewMode = useUiStore((state) => state.mainViewMode);
  const runtimePanelFallback = (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
      <div className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground shadow-[0_10px_30px_-24px_rgba(17,17,17,0.35)]">
        {mainViewMode === "conversation" ? "Loading conversation..." : "Loading inspector..."}
      </div>
    </div>
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Suspense fallback={runtimePanelFallback}>
        {mainViewMode === "conversation" ? (
          <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
            <ConversationWorkspace {...props} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-5 md:py-5">
            <InspectorWorkspace {...props} />
          </div>
        )}
      </Suspense>
    </section>
  );
}

export const EngineWorkspace = memo(EngineWorkspaceImpl);
