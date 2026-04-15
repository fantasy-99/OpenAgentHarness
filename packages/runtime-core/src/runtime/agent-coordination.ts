import type { Message, Run, RunStep, Session } from "@oah/api-contracts";

import { AppError } from "../errors.js";
import { textContent, toolErrorResultContent, toolResultContent } from "../runtime-message-content.js";
import { canDelegateFromAgent } from "../runtime-tooling.js";
import { formatToolOutput } from "../tool-output.js";
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

export interface AgentCoordinationServiceDependencies {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  runRepository: RunRepository;
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
  resolveModelForRun: (
    workspace: WorkspaceRecord,
    modelRef?: string | undefined
  ) => { canonicalModelRef: string };
  extractMessageDisplayText: (message: Message) => string;
  hasMeaningfulText: (value: string | undefined) => value is string;
  createId: (prefix: string) => string;
  nowIso: () => string;
}

export class AgentCoordinationService {
  readonly #sessionRepository: SessionRepository;
  readonly #messageRepository: MessageRepository;
  readonly #runRepository: RunRepository;
  readonly #getRun: AgentCoordinationServiceDependencies["getRun"];
  readonly #startRunStep: AgentCoordinationServiceDependencies["startRunStep"];
  readonly #completeRunStep: AgentCoordinationServiceDependencies["completeRunStep"];
  readonly #updateRun: AgentCoordinationServiceDependencies["updateRun"];
  readonly #appendEvent: AgentCoordinationServiceDependencies["appendEvent"];
  readonly #enqueueRun: AgentCoordinationServiceDependencies["enqueueRun"];
  readonly #resolveModelForRun: AgentCoordinationServiceDependencies["resolveModelForRun"];
  readonly #extractMessageDisplayText: AgentCoordinationServiceDependencies["extractMessageDisplayText"];
  readonly #hasMeaningfulText: AgentCoordinationServiceDependencies["hasMeaningfulText"];
  readonly #createId: AgentCoordinationServiceDependencies["createId"];
  readonly #nowIso: AgentCoordinationServiceDependencies["nowIso"];

  constructor(dependencies: AgentCoordinationServiceDependencies) {
    this.#sessionRepository = dependencies.sessionRepository;
    this.#messageRepository = dependencies.messageRepository;
    this.#runRepository = dependencies.runRepository;
    this.#getRun = dependencies.getRun;
    this.#startRunStep = dependencies.startRunStep;
    this.#completeRunStep = dependencies.completeRunStep;
    this.#updateRun = dependencies.updateRun;
    this.#appendEvent = dependencies.appendEvent;
    this.#enqueueRun = dependencies.enqueueRun;
    this.#resolveModelForRun = dependencies.resolveModelForRun;
    this.#extractMessageDisplayText = dependencies.extractMessageDisplayText;
    this.#hasMeaningfulText = dependencies.hasMeaningfulText;
    this.#createId = dependencies.createId;
    this.#nowIso = dependencies.nowIso;
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
    const switchStep = await this.#startRunStep({
      runId: input.run.id,
      stepType: "agent_switch",
      name: `${input.currentAgentName}->${input.targetAgentName}`,
      agentName: input.currentAgentName,
      input: {
        fromAgent: input.currentAgentName,
        toAgent: input.targetAgentName
      }
    });
    await this.#appendEvent({
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

    const latestRun = await this.#getRun(input.run.id);
    const nextSwitchCount = (latestRun.switchCount ?? 0) + 1;
    await this.#updateRun(latestRun, {
      effectiveAgentName: input.targetAgentName,
      switchCount: nextSwitchCount
    });
    await this.#completeRunStep(switchStep, "completed", {
      fromAgent: input.currentAgentName,
      toAgent: input.targetAgentName,
      switchCount: nextSwitchCount
    });

    await this.#appendEvent({
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

    const resumedSession = input.taskId ? await this.#sessionRepository.getById(input.taskId) : null;
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

    const latestParentRun = await this.#getRun(input.parentRun.id);
    await this.#enforceSubagentConcurrencyLimit(input.workspace, latestParentRun, input.currentAgentName);
    const delegateStep = await this.#startRunStep({
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

    const now = this.#nowIso();
    const childSessionId = resumedSession?.id ?? this.#createId("ses");
    const childRunId = this.#createId("run");
    const parentModelRef = this.#resolveModelForRun(
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
      id: this.#createId("msg"),
      sessionId: childSessionId,
      role: "user",
      content: textContent(
        this.#buildDelegatedTaskMessage(
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
      await this.#sessionRepository.update({
        ...childSession,
        status: "active",
        updatedAt: now
      });
    } else {
      await this.#sessionRepository.create(childSession);
    }
    await this.#messageRepository.create(childMessage);
    await this.#runRepository.create(childRun);

    await this.#appendDelegatedRunRecord(input.parentRun.id, {
      childRunId,
      childSessionId,
      targetAgentName: resolvedTargetAgentName,
      parentAgentName: input.currentAgentName
    });

    await this.#appendEvent({
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
    await this.#completeRunStep(delegateStep, "completed", {
      targetAgent: resolvedTargetAgentName,
      childSessionId,
      childRunId,
      ...(input.taskId ? { taskId: input.taskId, resumed: true } : {})
    });

    await this.#enqueueRun(childSessionId, childRunId, {
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
  }

  async awaitDelegatedRuns(runIds: string[], mode: "all" | "any"): Promise<string> {
    const awaitedRuns =
      mode === "any"
        ? [await this.#waitForAnyRunTerminalState(runIds)]
        : await Promise.all(runIds.map(async (runId) => this.#waitForRunTerminalState(runId)));
    const summaries = await Promise.all(awaitedRuns.map(async (run) => this.#collectAwaitedRunSummary(run.id)));
    const rendered = summaries.map((summary) => this.#renderAwaitedRunSummary(summary));

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
      this.delegatedRunRecords(parentRun).map(async (record) => this.#runRepository.getById(record.childRunId))
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

  #buildDelegatedTaskMessage(
    currentAgentName: string,
    targetAgentName: string,
    task: string,
    handoffSummary?: string | undefined
  ): string {
    return [
      `<delegated_task from_agent="${currentAgentName}" to_agent="${targetAgentName}">`,
      "<task>",
      task,
      "</task>",
      ...(handoffSummary ? ["<handoff_summary>", handoffSummary, "</handoff_summary>"] : []),
      "</delegated_task>"
    ].join("\n");
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
      await this.#appendEvent({
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
    await this.#appendEvent({
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
      const run = await this.#getRun(runId);
      if (this.#isRunTerminal(run.status)) {
        return run;
      }

      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async #waitForAnyRunTerminalState(runIds: string[]): Promise<Run> {
    while (true) {
      const runs = await Promise.all(runIds.map(async (runId) => this.#getRun(runId)));
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
    const run = await this.#getRun(runId);
    if (!run.sessionId) {
      return { run };
    }

    const messages = await this.#messageRepository.listBySessionId(run.sessionId);
    const runMessages = messages.filter((message) => message.runId === run.id);
    const assistantMessage = [...runMessages].reverse().find((message) => message.role === "assistant");
    const assistantContent = assistantMessage ? this.#extractMessageDisplayText(assistantMessage) : undefined;

    if (this.#hasMeaningfulText(assistantContent)) {
      return {
        run,
        outputContent: assistantContent
      };
    }

    const toolMessage = [...runMessages].reverse().find((message) => message.role === "tool");
    const toolContent = toolMessage ? this.#extractMessageDisplayText(toolMessage) : undefined;

    return {
      run,
      ...(this.#hasMeaningfulText(toolContent) ? { outputContent: toolContent } : {})
    };
  }

  #renderAwaitedRunSummary(summary: AwaitedRunSummary): string {
    return formatToolOutput(
      [
        ["task_id", summary.run.sessionId],
        ["run_id", summary.run.id],
        ["status", summary.run.status],
        ["subagent_name", summary.run.effectiveAgentName]
      ],
      [
        ...(summary.outputContent
          ? [
              {
                title: "output",
                lines: summary.outputContent.split(/\r?\n/),
                emptyText: "(empty output)"
              }
            ]
          : []),
        ...(summary.run.errorMessage
          ? [
              {
                title: "error_message",
                lines: summary.run.errorMessage.split(/\r?\n/),
                emptyText: "(empty error)"
              }
            ]
          : [])
      ]
    );
  }

  async #appendDelegatedRunRecord(parentRunId: string, record: DelegatedRunRecord): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const currentParentRun = await this.#getRun(parentRunId);
      const currentRecords = this.delegatedRunRecords(currentParentRun);
      if (currentRecords.some((existing) => existing.childRunId === record.childRunId)) {
        return;
      }

      const nextRecords = [...currentRecords, record];
      await this.#updateRun(currentParentRun, {
        metadata: {
          ...(currentParentRun.metadata ?? {}),
          delegatedRuns: nextRecords
        }
      });

      const persistedParentRun = await this.#getRun(parentRunId);
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
    const renderedSummary = this.#renderAwaitedRunSummary(input.childSummary);
    const message = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      role: "tool",
      content: toolResultContent({
        toolCallId: `delegate_${input.childSummary.run.id}`,
        toolName: "SubAgent",
        output: renderedSummary
      }),
      metadata: {
        agentName: input.parentAgentName,
        effectiveAgentName: input.parentAgentName,
        toolStatus: "completed",
        toolSourceType: "agent",
        synthetic: true,
        delegatedUpdate: "completed",
        delegatedChildRunId: input.childSummary.run.id,
        delegatedChildSessionId: input.childSummary.run.sessionId
      },
      createdAt: this.#nowIso()
    });

    await this.#appendEvent({
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
    const message = await this.#messageRepository.create({
      id: this.#createId("msg"),
      sessionId: input.parentSessionId,
      runId: input.parentRunId,
      role: "tool",
      content: toolErrorResultContent({
        toolCallId: `delegate_${input.childRun.id}`,
        toolName: "SubAgent",
        error: formatToolOutput(
          [
            ["task_id", input.childRun.sessionId],
            ["run_id", input.childRun.id],
            ["status", input.childRun.status],
            ["subagent_name", input.childRun.effectiveAgentName]
          ],
          [
            ...(input.childRun.errorMessage
              ? [
                  {
                    title: "error_message",
                    lines: input.childRun.errorMessage.split(/\r?\n/),
                    emptyText: "(empty error)"
                  }
                ]
              : [])
          ]
        )
      }),
      metadata: {
        agentName: input.parentAgentName,
        effectiveAgentName: input.parentAgentName,
        toolStatus: "failed",
        toolSourceType: "agent",
        synthetic: true,
        delegatedUpdate: "failed",
        delegatedChildRunId: input.childRun.id,
        delegatedChildSessionId: input.childRun.sessionId
      },
      createdAt: this.#nowIso()
    });

    await this.#appendEvent({
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
