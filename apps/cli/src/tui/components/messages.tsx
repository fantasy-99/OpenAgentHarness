import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Run, Session, Workspace } from "@oah/api-contracts";

import type { ChatLine, Notice } from "../domain/types.js";
import { shortId, SPINNER_FRAMES } from "../domain/utils.js";

export function StatusLine(props: { workspace: Workspace | null; session: Session | null; run: Run | null; notice: Notice; streamState: string }) {
  const runStatus = props.run?.status;
  const sessionLabel = props.session?.title ?? shortId(props.session?.id);
  const showRunStatus = runStatus && runStatus !== "completed";
  const rightStatus = showRunStatus
    ? `${props.session?.activeAgentName ?? "agent"} · ${runStatus}`
    : props.session && props.streamState !== "idle"
      ? props.streamState === "open"
        ? "connected"
        : props.streamState
      : "";
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color="cyan" bold>
            OAH
          </Text>{" "}
          <Text dimColor>{props.workspace?.name ?? "no workspace"}</Text>
          {props.session ? <Text dimColor> / {sessionLabel}</Text> : null}
        </Text>
        <Text dimColor>{rightStatus}</Text>
      </Box>
      {props.notice.level === "error" ? (
        <Text color="red" wrap="truncate-end">
          {props.notice.message}
        </Text>
      ) : null}
    </Box>
  );
}

type VisibleChatLine = ChatLine & {
  displayText: string;
  marginBottom: number;
};

export function Messages(props: { lines: ChatLine[]; session: Session | null; height: number; columns: number }) {
  const visibleLines = getBottomAnchoredLines(props.lines, props.height, props.columns);
  if (!props.session) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>No session selected. Press ctrl+o to create or switch.</Text>
      </Box>
    );
  }

  if (visibleLines.length === 0) {
    return (
      <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
        <Text dimColor>Start typing or use / for commands.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={props.height} flexShrink={1} justifyContent="flex-end" overflow="hidden">
      {visibleLines.map((line) => (
        <MessageRow key={line.id} line={line} />
      ))}
    </Box>
  );
}

function MessageRow(props: { line: VisibleChatLine }) {
  if (props.line.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom}>
        <Text color="cyan">
          ❯ <Text>{props.line.displayText}</Text>
        </Text>
      </Box>
    );
  }

  if (props.line.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={props.line.marginBottom} paddingLeft={2}>
        <Text wrap="wrap">{props.line.displayText}</Text>
      </Box>
    );
  }

  const color = props.line.tone === "error" ? "red" : props.line.role === "assistant" ? undefined : "gray";
  return (
    <Box flexDirection="row" marginBottom={props.line.marginBottom}>
      <Box flexShrink={0}>
        <Text dimColor>{"  "}⎿  </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text {...(color ? { color } : {})} dimColor={props.line.tone === "muted"} wrap="wrap">
          {props.line.displayText}
        </Text>
      </Box>
    </Box>
  );
}

function getBottomAnchoredLines(lines: ChatLine[], height: number, columns: number): VisibleChatLine[] {
  const maxRows = Math.max(1, height);
  const visible: VisibleChatLine[] = [];
  let remainingRows = maxRows;

  for (let index = lines.length - 1; index >= 0 && remainingRows > 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const textWidth = lineTextWidth(line.role, columns);
    const rows = wrapTerminalRows(line.text, textWidth);
    const marginBottom = visible.length === 0 ? 0 : 1;
    const fullHeight = rows.length + marginBottom;

    if (fullHeight <= remainingRows) {
      visible.unshift({
        ...line,
        displayText: rows.join("\n"),
        marginBottom
      });
      remainingRows -= fullHeight;
      continue;
    }

    const availableTextRows = remainingRows - marginBottom;
    if (availableTextRows > 0) {
      visible.unshift({
        ...line,
        displayText: rows.slice(-availableTextRows).join("\n"),
        marginBottom
      });
    } else if (visible.length === 0 && remainingRows > 0) {
      visible.unshift({
        ...line,
        displayText: rows.slice(-remainingRows).join("\n"),
        marginBottom: 0
      });
    }
    break;
  }

  return visible;
}

function lineTextWidth(role: string, columns: number) {
  if (role === "user") {
    return Math.max(1, columns - 2);
  }
  if (role === "assistant") {
    return Math.max(1, columns - 2);
  }
  return Math.max(1, columns - 5);
}

function wrapTerminalRows(value: string, width: number) {
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

function characterWidth(char: string) {
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

export function SpinnerLine(props: { run: Run | null }) {
  const [frame, setFrame] = useState(0);
  const active = props.run?.status === "queued" || props.run?.status === "running" || props.run?.status === "waiting_tool";

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) {
    return null;
  }

  const verb = props.run?.status === "waiting_tool" ? "Waiting for tool" : props.run?.status === "queued" ? "Queued" : "Working";
  return (
    <Box marginTop={1}>
      <Text color="cyan">✻ </Text>
      <Text dimColor>{verb}… </Text>
      <Text dimColor>{shortId(props.run?.id)}</Text>
      <Text dimColor> {SPINNER_FRAMES[frame]}</Text>
    </Box>
  );
}
