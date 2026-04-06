import { MessageSquareText, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import type { useAppController } from "../use-app-controller";
import { ConversationWorkspace } from "../chat/ConversationWorkspace";
import { InspectorWorkspace } from "../inspector/InspectorWorkspace";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

export function RuntimeWorkspace(props: RuntimeProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-4">
        <Tabs value={props.mainViewMode} onValueChange={(value) => props.setMainViewMode(value as RuntimeProps["mainViewMode"])}>
          <TabsList className="h-8">
            <TabsTrigger value="conversation" className="text-xs">
              <MessageSquareText className="h-4 w-4" />
              Conversation
            </TabsTrigger>
            <TabsTrigger value="inspector" className="text-xs">
              <Sparkles className="h-4 w-4" />
              Inspector
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          {props.hasActiveSession ? <Badge variant="secondary">{props.session?.activeAgentName ?? props.run?.effectiveAgentName ?? "no agent"}</Badge> : null}
          {props.selectedRunId ? <Badge variant="outline">run {props.selectedRunId}</Badge> : null}
          {props.mainViewMode === "inspector" ? (
            <>
              <Badge variant="secondary">{props.runSteps.length} steps</Badge>
              <Badge variant="secondary">{props.deferredEvents.length} events</Badge>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {props.hasActiveSession ? `${props.messages.length} messages` : "Choose a session to start"}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {props.mainViewMode === "conversation" ? <ConversationWorkspace {...props} /> : <InspectorWorkspace {...props} />}
      </div>
    </section>
  );
}
