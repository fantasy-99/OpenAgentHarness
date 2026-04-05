export type ToolOutputValue = string | number | boolean | null | undefined;

export interface ToolOutputSection {
  title: string;
  lines: string[];
  emptyText?: string | undefined;
}

export function formatToolOutput(
  fields: Array<[string, ToolOutputValue]>,
  sections: ToolOutputSection[] = []
): string {
  const lines: string[] = [];

  for (const [key, value] of fields) {
    if (value === undefined || value === null) {
      continue;
    }

    lines.push(`${key}: ${String(value)}`);
  }

  for (const section of sections) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(`${section.title}:`);
    if (section.lines.length > 0) {
      lines.push(...section.lines);
    } else {
      lines.push(section.emptyText ?? "(none)");
    }
  }

  return lines.join("\n");
}
