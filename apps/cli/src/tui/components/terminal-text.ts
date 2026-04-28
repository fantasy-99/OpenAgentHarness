export function wrapTerminalRows(value: string, width: number) {
  const rows: string[] = [];
  for (const rawLine of value.split("\n")) {
    if (!rawLine) {
      rows.push("");
      continue;
    }

    let row = "";
    let rowWidth = 0;
    for (const char of Array.from(rawLine)) {
      const charWidth = characterWidth(char);
      if (row && rowWidth + charWidth > width) {
        rows.push(row);
        row = "";
        rowWidth = 0;
      }
      row += char;
      rowWidth += charWidth;
    }
    rows.push(row);
  }
  return rows.length > 0 ? rows : [""];
}

export function characterWidth(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function truncateSingleLine(value: string, limit: number) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, limit - 1))}…`;
}

export function truncateLines(value: string, maxLines: number, maxChars?: number | undefined) {
  const lines = value.split("\n");
  let visible = lines.slice(0, maxLines).join("\n");
  if (maxChars !== undefined && visible.length > maxChars) {
    visible = visible.slice(0, Math.max(1, maxChars - 1));
  }
  const hidden = lines.length - Math.min(lines.length, maxLines);
  return {
    text: hidden > 0 || visible.length < value.length ? `${visible.trimEnd()}…` : visible,
    hidden
  };
}

export function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

export function rowCountForText(value: string, width: number) {
  return wrapTerminalRows(value, Math.max(1, width)).length;
}
