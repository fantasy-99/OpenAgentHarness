export const WORKSPACE_MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type WorkspaceMemoryType = (typeof WORKSPACE_MEMORY_TYPES)[number];

export function parseWorkspaceMemoryType(raw: unknown): WorkspaceMemoryType | undefined {
  return typeof raw === "string" && WORKSPACE_MEMORY_TYPES.includes(raw as WorkspaceMemoryType)
    ? (raw as WorkspaceMemoryType)
    : undefined;
}

export const WORKSPACE_MEMORY_TYPE_GUIDANCE_LINES = [
  "## Types of memory",
  "- `user`: durable user-specific preferences, responsibilities, or expertise that matter in this workspace.",
  "- `feedback`: collaboration rules, response constraints, or validated ways of working that should guide future turns.",
  "- `project`: durable project decisions, constraints, commands, conventions, timelines, or non-obvious context for this repository.",
  "- `reference`: pointers to external systems, dashboards, docs, trackers, or resources to consult later.",
  "",
  "Use the narrowest fitting type. Update existing memories instead of creating duplicates."
] as const;

export const WORKSPACE_MEMORY_SAVE_GUIDANCE_LINES = [
  "## How to save memories",
  "- Every topic file should include frontmatter with `name`, `description`, and `type`.",
  "- Keep `MEMORY.md` as a concise index of one-line links or hooks; do not put full memory bodies there.",
  "- For `feedback` and `project` memories, prefer a body that starts with the rule or fact, then adds `Why:` and `How to apply:` lines when useful.",
  "- Exclude transient turn-by-turn chatter, temporary plans, and details that are unlikely to matter in a future session."
] as const;

export const WORKSPACE_MEMORY_FRONTMATTER_TEMPLATE_LINES = [
  "```markdown",
  "---",
  "name: {{memory name}}",
  "description: {{one-line description}}",
  `type: {{${WORKSPACE_MEMORY_TYPES.join(", ")}}}`,
  "---",
  "",
  "{{memory content}}",
  "```"
] as const;
