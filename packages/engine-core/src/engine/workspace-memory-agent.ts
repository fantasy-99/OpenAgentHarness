import type { Run } from "@oah/api-contracts";

import type { AgentDefinition, WorkspaceRecord } from "../types.js";
import {
  WORKSPACE_MEMORY_FRONTMATTER_TEMPLATE_LINES,
  WORKSPACE_MEMORY_SAVE_GUIDANCE_LINES,
  WORKSPACE_MEMORY_TYPE_GUIDANCE_LINES
} from "./workspace-memory-taxonomy.js";

export const WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME = "__workspace_memory_extractor__";

export const WORKSPACE_MEMORY_EXTRACTION_PROMPT = [
  "You are the workspace memory extraction subagent.",
  "Your only job is to maintain the workspace memory directory for this repository.",
  "Use Read, Glob, Grep, Edit, and Write to inspect and update files inside `.openharness/memory/`.",
  "Treat `.openharness/memory/MEMORY.md` as a concise index, not the place for full memory bodies.",
  "Store durable notes in topic files and keep MEMORY.md as one-line links or hooks pointing to those files.",
  "If a file already exists, read it before editing or rewriting it.",
  "Keep only cross-session facts that are likely to help future work in this repository.",
  "Preserve important architecture facts, file locations, commands, constraints, conventions, and validated decisions.",
  "Exclude transient turn-by-turn chatter, temporary plans, and details that are no longer useful.",
  "If the conversation delta contains no durable information worth keeping, do not write any memory files and say that no memory update was needed.",
  "Do not write outside `.openharness/memory/`.",
  "",
  ...WORKSPACE_MEMORY_TYPE_GUIDANCE_LINES,
  "",
  ...WORKSPACE_MEMORY_SAVE_GUIDANCE_LINES,
  "",
  "Use this frontmatter format in topic files:",
  ...WORKSPACE_MEMORY_FRONTMATTER_TEMPLATE_LINES
].join("\n");

export function isWorkspaceMemoryExtractionRun(run: Pick<Run, "metadata">): boolean {
  return run.metadata?.workspaceMemoryExtraction === true;
}

export function withWorkspaceMemoryExtractorAgent(workspace: WorkspaceRecord): WorkspaceRecord {
  if (workspace.agents[WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME]) {
    return workspace;
  }

  const extractorAgent: AgentDefinition = {
    name: WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME,
    mode: "subagent",
    hidden: true,
    prompt: WORKSPACE_MEMORY_EXTRACTION_PROMPT,
    tools: {
      native: ["Read", "Write", "Edit", "Glob", "Grep"],
      actions: [],
      skills: [],
      external: []
    },
    switch: [],
    subagents: []
  };

  return {
    ...workspace,
    agents: {
      ...workspace.agents,
      [WORKSPACE_MEMORY_EXTRACTOR_AGENT_NAME]: extractorAgent
    }
  };
}
