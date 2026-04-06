import { Bot, Folder, RefreshCw, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { formatTimestamp } from "../support";
import type { useAppController } from "../use-app-controller";
import { MessageContentDetail, MessageToolRefChips } from "../inspector-panels";

type RuntimeProps = ReturnType<typeof useAppController>["runtimeDetailSurfaceProps"];

export function ConversationWorkspace(props: RuntimeProps) {
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
      <div
        ref={props.conversationThreadRef}
        className="flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
          props.shouldAutoFollowConversationRef.current = distanceToBottom < 120;
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-6 md:px-6 md:py-8">
          {!props.hasActiveSession ? (
            <div className="flex min-h-[52vh] items-center justify-center py-10">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/85 text-muted-foreground shadow-[0_10px_26px_rgba(17,19,24,0.04)]">
                  <Folder className="h-5 w-5" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">No Session Selected</h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">Choose a session from the sidebar, or create one in {props.currentWorkspaceName}.</p>
              </div>
            </div>
          ) : props.messageFeed.length === 0 ? (
            <div className="flex min-h-[52vh] items-center justify-center py-10">
              <div className="max-w-md text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background shadow-[0_14px_30px_rgba(17,19,24,0.18)]">
                  <Bot className="h-5 w-5" />
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">OpenAgentHarness</h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">Send a message to start this session. Tool calls, traces, and runtime output will appear as the conversation unfolds.</p>
              </div>
            </div>
          ) : (
            props.messageFeed.map((message) => {
              const isUser = message.role === "user";
              const isStreaming = message.id.startsWith("live:");

              return (
                <article key={message.id} className={`animate-fade-in flex gap-3 py-3 md:gap-4 ${isUser ? "flex-row-reverse" : ""}`}>
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-sm shadow-elegant md:h-9 md:w-9 ${
                      isUser ? "bg-foreground text-background text-xs font-medium" : "bg-muted"
                    }`}
                  >
                    {isUser ? "You" : "AI"}
                  </div>

                  <div className={`flex-1 ${isUser ? "text-right" : ""} ${isUser ? "max-w-[85%] md:max-w-[75%]" : "max-w-[95%] md:max-w-[85%]"}`}>
                    <div
                      className={
                        isUser
                          ? "inline-block text-left rounded-2xl px-4 py-3 bg-foreground text-background shadow-elegant border-elegant selection:bg-background/30 selection:text-background"
                          : "rounded-2xl px-4 py-3 shadow-elegant border-elegant hover-lift bg-card"
                      }
                    >
                      <div className={isUser ? "[&_pre]:text-background [&_.text-slate-700]:text-background" : ""}>
                        <MessageContentDetail content={message.content} maxHeightClassName="max-h-[28rem]" />
                      </div>
                    </div>
                    <div className={`mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-medium text-muted-foreground/50 ${isUser ? "justify-end" : ""}`}>
                      {message.runId ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-5 rounded-md px-1.5 text-[10px]"
                          onClick={() => {
                            props.setSelectedRunId(message.runId ?? "");
                            props.setMainViewMode("inspector");
                            props.setInspectorTab("calls");
                            props.refreshRunById(message.runId ?? "");
                            props.refreshRunStepsById(message.runId ?? "");
                          }}
                        >
                          {message.runId}
                        </Button>
                      ) : null}
                      <MessageToolRefChips content={message.content} />
                      {isStreaming ? <span className="uppercase tracking-[0.14em]">Streaming</span> : null}
                      <span>{formatTimestamp(message.createdAt)}</span>
                    </div>
                  </div>
                </article>
              );
            })
          )}
          {props.hasActiveSession ? <div className="h-24 md:h-28" aria-hidden="true" /> : null}
          <div ref={props.conversationTailRef} aria-hidden="true" />
        </div>
      </div>

      {props.hasActiveSession ? (
        <div className="absolute bottom-0 left-0 right-0 z-20">
          <div className="mx-auto max-w-4xl p-3 md:p-4">
            <div className="relative flex items-end gap-2 rounded-xl border border-foreground/20 bg-background/30 p-2 shadow-lg backdrop-blur-sm">
              <Button
                onClick={props.refreshMessages}
                variant="ghost"
                size="icon"
                className="h-9 w-9 flex-shrink-0"
                title="Refresh"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>

              <Textarea
                value={props.draftMessage}
                onChange={(event) => props.setDraftMessage(event.target.value)}
                placeholder="Message the current session"
                rows={1}
                className="min-h-[24px] max-h-[200px] flex-1 resize-none border-none bg-transparent px-0 py-2 text-sm shadow-none outline-none focus-visible:ring-0"
              />

              <Button
                onClick={props.sendMessage}
                disabled={!props.draftMessage.trim()}
                size="icon"
                className="shadow-elegant h-9 w-9 flex-shrink-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
