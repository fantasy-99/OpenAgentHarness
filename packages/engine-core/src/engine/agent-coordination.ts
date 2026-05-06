import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { textContent } from "../execution-message-content.js";
import { canDelegateFromAgent } from "../capabilities/engine-capabilities.js";
import {
  buildDelegatedRunCompletedMessage,
  buildDelegatedRunFailedMessage,
  buildDelegatedTaskMessage,
  renderAwaitedRunSummary
} from "./agent-delegation-messages.js";
import type {
  MessageRepository,
  RunQueuePriority,
  RunRepository,
  SessionEvent,
  SessionRepository,
  WorkspaceRecord
} from "../types.js";

export interface DelegatedRunRecord {
  childRunId: string;
  childSessionId: string;
  targetAgentName: string;
  parentAgentName: string;
}

export interface AwaitedRunSummary {
  run: Run;
  outputContent?: string | undefined;
}

export interface AgentCoordinationPersistence {
  sessions: Pick<SessionRepository, "getById" | "create" | "update">;
  messages: Pick<MessageRepository, "create" | "listBySessionId">;
  runs: Pick<RunRepository, "create" | "getById">;
}

export interface AgentCoordinationLifecycle {
  getRun: (runId: string) => Promise<Run>;
  startRunStep: (input: {
    runId: string;
    stepType: "agent_switch" | "agent_delegate";
    name?: string | undefined;
    agentName?: string | undefined;
    input?: Record<string, unknown> | undefined;
  }) => Promise<RunStep>;
  completeRunStep: (
    step: RunStep,
    status: "completed" | "failed" | "cancelled",
    output?: Record<string, unknown> | undefined
  ) => Promise<RunStep>;
  updateRun: (run: Run, patch: Partial<Run>) => Promise<Run>;
  appendEvent: (input: Omit<SessionEvent, "id" | "cursor" | "createdAt">) => Promise<SessionEvent>;
  enqueueRun: (sessionId: string, runId: string, options?: { priority?: RunQueuePriority | undefined }) => Promise<void>;
}

export interface AgentCoordinationHelpers {
  resolveModelForRun: (
    workspace: WorkspaceRecord,
    modelRef?: string | undefined
  ) => { canonicalModelRef: string };
  extractMessageDisplayText: (message: Message) => string;
  hasMeaningfulText: (value: string | undefined) => value is string;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export interface AgentCoordinationServiceDependencies {
  persistence: AgentCoordinationPersistence;
  lifecycle: AgentCoordinationLifecycle;
  helpers: AgentCoordinationHelpers;
}

export class AgentCoordinationService {
  readonly #persistence: AgentCoordinationPersistence;
  readonly #lifecycle: AgentCoordinationLifecycle;
  readonly #helpers: AgentCoordinationHelpers;
  readonly #delegationQueues = new Map<string, Promise<void>>();

  constructor(dependencies: AgentCoordinationServiceDependencies) {
    this.#persistence = dependencies.persistence;
    this.#lifecycle = dependencies.lifecycle;
    this.#helpers = dependencies.helpers;
  }

  delegatedRunRecords(run: Run): DelegatedRunRecord[] {
    const rawRecords = run.metadata?.delegatedRuns;
    if (!Array.isArray(rawRecords)) {
      return [];
    }

    return rawRecords.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { childRunId?: unknown }).childRunId === "string" &&
        typeof (entry as { childSessionId?: unknown }).childSessionId === "string" &&
        typeof (entry as { targetAgentName?: unknown }).targetAgentName === "string" &&
        typeof (entry as { parentAgentName?: unknown }).parentAgentName === "string"
      ) {
        return [
          {
            childRunId: (entry as { childRunId: string }).childRunId,
            childSessionId: (entry as { childSessionId: string }).childSessionId,
            targetAgentName: (entry as { targetAgentName: string }).targetAgentName,
            parentAgentName: (entry as { parentAgentName: string }).parentAgentName
          }
        ];
      }

      return [];
    });
  }

  async switchAgent(input: {
    session: Session;
    run: Run;
    currentAgentName: string;
    targetAgentName: string;
  }): Promise<{ switchCount: number }> {
    const switchStep = await this.#lifecycle.startRunStep({
      runId: input.run.id,
      stepType: "agent_switch",
      name: `${input.currentAgentName}->${input.targetAgentName}`,
      agentName: input.currentAgentName,
      input: {
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName
      }
    });
    await this.#lifecycle.appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "agent.switch.requested",
      data: {
        runId: input.run.id,
        sessionId: input.session.id,
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName
      }
    });

    const latestRun = await this.#lifecycle.getRun(input.run.id);
    const nextSwitchCount = (latestRun.switchCount ?? 0) + 1;
    await this.#lifecycle.updateRun(latestRun, {
      effectiveAgentName: input.targetAgentName,
      switchCount: nextSwitchCount
    });
    await this.#lifecycle.completeRunStep(switchStep, "completed", {
      fromAgent: input.currentAgentName,
      toAgent: input.targetAgentName,
      switchCount: nextSwitchCount
    });

    await this.#lifecycle.appendEvent({
      sessionId: input.session.id,
      runId: input.run.id,
      event: "agent.switched",
      data: {
        runId: input.run.id,
        sessionId: input.session.id,
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName,
        switchCount: nextSwitchCount
      }
    });

    return { switchCount: nextSwitchCount };
  }

  async delegateAgentRun(input: {
    workspace: WorkspaceRecord;
    parentSession: Session;
    parentRun: Run;
    currentAgentName: string;
    targetAgentName?: string | undefined;
    task: string;
    handoffSummary?: string | undefined;
    taskId?: string | undefined;
    notifyParentOnCompletion?: boolean | undefined;
  }): Promise<{ childSessionId: string; childRunId: string; targetAgentName: string }> {
    if (!canDelegateFromAgent(input.workspace, input.currentAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${input.currentAgentName} is not allowed to delegate subagent work.`
      );
    }

    const resumedSession = input.taskId ? await this.#persistence.sessions.getById(input.taskId) : null;
    if (input.taskId && !resumedSession) {
      throw new AppError(404, "task_not_found", `Subagent task ${input.taskId} was not found.`);
    }

    if (resumedSession && resumedSession.workspaceId !== input.workspace.id) {
      throw new AppError(
        409,
        "task_workspace_mismatch",
        `Subagent task ${input.taskId} does not belong to workspace ${input.workspace.id}.`
      );
    }

    const resolvedTargetAgentName =
      input.targetAgentName ?? resumedSession?.activeAgentName ?? resumedSession?.agentName;
    if (!resolvedTargetAgentName) {
      throw new AppError(400, "agent_type_required", "SubAgent requires subagent_name or a resumable task_id.");
    }

    const allowedTargets = input.workspace.agents[input.currentAgentName]?.subagents ?? [];
    if (!allowedTargets.includes(resolvedTargetAgentName)) {
      throw new AppError(
        403,
        "agent_delegate_not_allowed",
        `Agent ${input.currentAgentName} is not allowed to delegate to ${resolvedTargetAgentName}.`
      );
    }

    const targetAgent = input.workspace.agents[resolvedTargetAgentName];
    if (!targetAgent) {
      throw new AppError(
        404,
        "agent_not_found",
        `Agent ${resolvedTargetAgentName} was not found in workspace ${input.workspace.id}.`
      );
    }

    if (targetAgent.mode === "primary") {
      throw new AppError(
        409,
        "invalid_subagent_target",
        `Agent ${resolvedTargetAgentName} is a primary agent and cannot be used as a subagent target.`
      );
    }

    if (
      resumedSession &&
      input.targetAgentName &&
      resumedSession.activeAgentName !== input.targetAgentName &&
      resumedSession.agentName !== input.targetAgentName
    ) {
      throw new AppError(
        409,
        "task_agent_mismatch",
        `Subagent task ${input.taskId} is currently associated with ${resumedSession.activeAgentName}, not ${input.targetAgentName}.`
      );
    }

    return this.#serializeDelegation(input.parentRun.id, async () => {
      const latestParentRun = await this.#lifecycle.getRun(input.parentRun.id);
      await this.#enforceSubagentConcurrencyLimit(input.workspace, latestParentRun, input.currentAgentName);

      const delegateStep = await this.#lifecycle.startRunStep({
        runId: input.parentRun.id,
        stepType: "agent_delegate",
        name: resolvedTargetAgentName,
        agentName: input.currentAgentName,
        input: {
          targetAgent: resolvedTargetAgentName,
          task: input.task,
          ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {})
        }
      });

      const now = this.#helpers.nowIso();
      const childSessionId = resumedSession?.id ?? this.#helpers.createId("ses");
      const childRunId = this.#helpers.createId("run");
      const parentModelRef = this.#helpers.resolveModelForRun(
        input.workspace,
        input.parentSession.modelRef ?? input.workspace.agents[input.currentAgentName]?.modelRef
      ).canonicalModelRef;
      const childSession: Session = resumedSession ?? {
        id: childSessionId,
        workspaceId: input.workspace.id,
        parentSessionId: input.parentSession.id,
        subjectRef: input.parentSession.subjectRef,
        ...(input.parentSession.modelRef ? { modelRef: input.parentSession.modelRef } : {}),
        agentName: resolvedTargetAgentName,
        activeAgentName: resolvedTargetAgentName,
        title: `Agent ${resolvedTargetAgentName}`,
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      const childMessage: Message = {
        id: this.#helpers.createId("msg"),
        sessionId: childSessionId,
        role: "user",
        content: textContent(
          buildDelegatedTaskMessage(
            input.currentAgentName,
            resolvedTargetAgentName,
            input.task,
            input.handoffSummary
          )
        ),
        metadata: {
          parentRunId: input.parentRun.id,
          parentSessionId: input.parentSession.id,
          delegatedByAgent: input.currentAgentName,
          ...(input.taskId ? { delegatedTaskId: input.taskId } : {})
        },
        createdAt: now
      };
      const childRun: Run = {
        id: childRunId,
        workspaceId: input.workspace.id,
        sessionId: childSessionId,
        parentRunId: input.parentRun.id,
        initiatorRef: input.parentRun.initiatorRef ?? input.parentSession.subjectRef,
        triggerType: "system",
        triggerRef: "agent.delegate",
        agentName: childSession.activeAgentName,
        effectiveAgentName: childSession.activeAgentName,
        switchCount: 0,
        status: "queued",
        createdAt: now,
        metadata: {
          parentRunId: input.parentRun.id,
          parentSessionId: input.parentSession.id,
          parentAgentName: input.currentAgentName,
          delegatedTask: input.task,
          ...(input.handoffSummary ? { handoffSummary: input.handoffSummary } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(targetAgent.modelRef ? {} : { inheritedModelRef: parentModelRef })
        }
      };

      if (resumedSession) {
        await this.#persistence.sessions.update({
          ...childSession,
          status: "active",
          updatedAt: now
        });
      } else {
        await this.#persistence.sessions.create(childSession);
      }
      await this.#persistence.messages.create(childMessage);
      await this.#persistence.runs.create(childRun);

      await this.#appendDelegatedRunRecord(input.parentRun.id, {
        childRunId,
        childSessionId,
        targetAgentName: resolvedTargetAgentName,
        parentAgentName: input.currentAgentName
      });

      await this.#lifecycle.appendEvent({
        sessionId: input.parentSession.id,
        runId: input.parentRun.id,
        event: "agent.delegate.started",
        data: {
          runId: input.parentRun.id,
          sessionId: input.parentSession.id,
          agentName: input.currentAgentName,
          targetAgent: resolvedTargetAgentName,
          childSessionId,
          childRunId,
          ...(input.taskId ? { taskId: input.taskId, resumed: true } : {})
        }
      });
      await this.#lifecycle.completeRunStep(delegateStep, "completed", {
        targetAgent: resolvedTargetAgentName,
        childSessionId,
        childRunId,
        ...(input.taskId ? { taskId: input.taskId, resumed: true } : {})
      });

      await this.#lifecycle.enqueueRun(childSessionId, childRunId, {
        priority: "subagent"
      });
      void this.#monitorDelegatedRun({
        parentSessionId: input.parentSession.id,
        parentRunId: input.parentRun.id,
        parentAgentName: input.currentAgentName,
        targetAgentName: resolvedTargetAgentName,
        childRunId,
        notifyParentOnCompletion: input.notifyParentOnCompletion ?? false
      });

      return {
        childSessionId,
        childRunId,
        targetAgentName: resolvedTargetAgentName
      };
    });
  }

  async awaitDelegatedRuns(runIds: string[], mode: "all" | "any"): Promise<string> {
    const awaitedRuns =
      mode === "any"
        ? [await this.#waitForAnyRunTerminalState(runIds)]
        : await Promise.all(runIds.map(async (runId) => this.#waitForRunTerminalState(runId)));
    const summaries = await Promise.all(awaitedRuns.map(async (run) => this.#collectAwaitedRunSummary(run.id)));
    const rendered = summaries.map((summary) => renderAwaitedRunSummary(summary));

    if (rendered.length === 1) {
      return rendered[0] ?? "";
    }

    return [`mode: ${mode}`, `results: ${rendered.length}`, "", rendered.join("\n\n")].join("\n");
  }

  async #enforceSubagentConcurrencyLimit(
    workspace: WorkspaceRecord,
    parentRun: Run,
    currentAgentName: string
  ): Promise<void> {
    const maxConcurrentSubagents = workspace.agents[currentAgentName]?.policy?.maxConcurrentSubagents;
    if (maxConcurrentSubagents === undefined) {
      return;
    }

    const childRuns = await Promise.all(
      this.delegatedRunRecords(parentRun).map(async (record) => this.#persistence.runs.getById(record.childRunId))
    );
    const activeRuns = childRuns.filter(
      (run): run is Run => run !== null && (run.status === "queued" || run.status === "running" || run.status === "waiting_tool")
    );

    if (activeRuns.length >= maxConcurrentSubagents) {
      throw new AppError(
        409,
        "subagent_concurrency_limit_exceeded",
        `Agent ${currentAgentName} reached max_concurrent_subagents=${maxConcurrentSubagents}.`
      );
    }
  }

  async #serializeDelegation<T>(parentRunId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#delegationQueues.get(parentRunId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#delegationQueues.set(parentRunId, queued);

    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      release();
      if (this.#delegationQueues.get(parentRunId) === queued) {
        this.#delegationQueues.delete(parentRunId);
      }
    }
  }

  async #monitorDelegatedRun(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    targetAgentName: string;
    childRunId: string;
    notifyParentOnCompletion: boolean;
  }): Promise<void> {
    const childRun = await this.#waitForRunTerminalState(input.childRunId);
    const childSummary = await this.#collectAwaitedRunSummary(input.childRunId);

    if (childRun.status === "completed") {
      if (input.notifyParentOnCompletion) {
        await this.#persistDelegatedRunUpdate({
          parentSessionId: input.parentSessionId,
          parentRunId: input.parentRunId,
          parentAgentName: input.parentAgentName,
          childSummary
        });
      }
      await this.#lifecycle.appendEvent({
        sessionId: input.parentSessionId,
        runId: input.parentRunId,
        event: "agent.delegate.completed",
        data: {
          runId: input.parentRunId,
          sessionId: input.parentSessionId,
          agentName: input.parentAgentName,
          targetAgent: input.targetAgentName,
          childRunId: input.childRunId,
          childStatus: childRun.status,
          output: childSummary.outputContent ?? ""
        }
      });
      return;
    }

    if (input.notifyParentOnCompletion) {
      await this.#persistDelegatedRunFailure({
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        childRun
      });
    }
    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "agent.delegate.failed",
      data: {
        runId: input.parentRunId,
        sessionId: input.parentSessionId,
        agentName: input.parentAgentName,
        targetAgent: input.targetAgentName,
        childRunId: input.childRunId,
        childStatus: childRun.status,
        errorCode: childRun.errorCode,
        errorMessage: childRun.errorMessage
      }
    });
  }

  async #waitForRunTerminalState(runId: string): Promise<Run> {
    while (true) {
      const run = await this.#lifecycle.getRun(runId);
      if (this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async #waitForAnyRunTerminalState(runIds: string[]): Promise<Run> {
    while (true) {
      const runs = await Promise.all(runIds.map(async (runId) => this.#lifecycle.getRun(runId)));
      const completedRun = runs.find((run) => this.#isRunTerminal(run.status));
      if (completedRun) {
        return completedRun;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #isRunTerminal(status: Run["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out";
  }

  async #collectAwaitedRunSummary(runId: string): Promise<AwaitedRunSummary> {
    const run = await this.#lifecycle.getRun(runId);
    if (!run.sessionId) {
      return { run };
    }

    const messages = await this.#persistence.messages.listBySessionId(run.sessionId);
    const runMessages = messages.filter((message) => message.runId === run.id);
    const assistantMessage = [...runMessages].reverse().find((message) => message.role === "assistant");
    const assistantContent = assistantMessage ? this.#helpers.extractMessageDisplayText(assistantMessage) : undefined;

    if (this.#helpers.hasMeaningfulText(assistantContent)) {
      return {
        run,
        outputContent: assistantContent
      };
    }

    const toolMessage = [...runMessages].reverse().find((message) => message.role === "tool");
    const toolContent = toolMessage ? this.#helpers.extractMessageDisplayText(toolMessage) : undefined;

    return {
      run,
      ...(this.#helpers.hasMeaningfulText(toolContent) ? { outputContent: toolContent } : {})
    };
  }

  async #appendDelegatedRunRecord(parentRunId: string, record: DelegatedRunRecord): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const currentParentRun = await this.#lifecycle.getRun(parentRunId);
      const currentRecords = this.delegatedRunRecords(currentParentRun);
      if (currentRecords.some((existing) => existing.childRunId === record.childRunId)) {
        return;
      }

      const nextRecords = [...currentRecords, record];
      await this.#lifecycle.updateRun(currentParentRun, {
        metadata: {
          ...(currentParentRun.metadata ?? {}),
          delegatedRuns: nextRecords
        }
      });

      const persistedParentRun = await this.#lifecycle.getRun(parentRunId);
      if (this.delegatedRunRecords(persistedParentRun).some((existing) => existing.childRunId === record.childRunId)) {
        return;
      }
    }

    throw new AppError(409, "delegated_run_record_conflict", `Failed to attach delegated run ${record.childRunId}.`);
  }

  async #persistDelegatedRunUpdate(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    childSummary: AwaitedRunSummary;
  }): Promise<void> {
    const message = await this.#persistence.messages.create(
      buildDelegatedRunCompletedMessage({
        createId: this.#helpers.createId,
        nowIso: this.#helpers.nowIso,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        childSummary: input.childSummary
      })
    );

    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "message.completed",
      data: {
        runId: input.parentRunId,
        messageId: message.id,
        content: message.content,
        toolName: "SubAgent",
        toolCallId: `delegate_${input.childSummary.run.id}`,
        ...(message.metadata ? { metadata: message.metadata } : {})
      }
    });
  }

  async #persistDelegatedRunFailure(input: {
    parentSessionId: string;
    parentRunId: string;
    parentAgentName: string;
    childRun: Run;
  }): Promise<void> {
    const message = await this.#persistence.messages.create(
      buildDelegatedRunFailedMessage({
        createId: this.#helpers.createId,
        nowIso: this.#helpers.nowIso,
        parentSessionId: input.parentSessionId,
        parentRunId: input.parentRunId,
        parentAgentName: input.parentAgentName,
        childRun: input.childRun
      })
    );

    await this.#lifecycle.appendEvent({
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      event: "message.completed",
      data: {
        runId: input.parentRunId,
        messageId: message.id,
        content: message.content,
        toolName: "SubAgent",
        toolCallId: `delegate_${input.childRun.id}`,
        resultType: "error",
        ...(message.metadata ? { metadata: message.metadata } : {})
      }
    });
  }
}
