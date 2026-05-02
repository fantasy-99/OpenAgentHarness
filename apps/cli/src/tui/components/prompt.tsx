import React from "react";
import { Box, Text, useCursor, useWindowSize } from "ink";
import { formatSystemProfileDisplayName, type Run, type Session, type SystemProfile, type Workspace } from "@oah/api-contracts";

import type { Notice } from "../domain/types.js";
import { clampIndex, getSlashCommandMatches, shortId } from "../domain/utils.js";

export function PromptInput(props: {
  value: string;
  cursor: number;
  slashSelection: number;
  cursorY: number;
  disabled?: boolean;
  running: boolean;
  workspace: Workspace | null;
  session: Session | null;
  systemProfile: SystemProfile | null;
  run: Run | null;
  notice: Notice;
  streamState: string;
  agentMode: string;
}) {
  const { setCursorPosition } = useCursor();
  const { columns, rows } = useWindowSize();
  const prompt = "❯ ";
  const inputLayout = layoutComposerInput(props.value, props.cursor, columns);
  const suggestionRows = props.disabled ? 0 : getSlashSuggestionRowCount(props.value);
  const cursorX = Math.min(Math.max(0, columns - 1), terminalWidth(prompt) + inputLayout.cursorColumn);
  const nativeCursorY = props.cursorY + inputLayout.cursorLine;
  const shouldParkNativeCursor = !props.disabled && nativeCursorY <= rows * 3;

  setCursorPosition(
    shouldParkNativeCursor
      ? {
          x: cursorX,
          y: Math.max(0, nativeCursorY)
        }
      : undefined
  );

  return (
    <Box flexDirection="column" height={inputLayout.rows.length + suggestionRows + 4} overflow="hidden">
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      <Box flexDirection="column" width="100%">
        {inputLayout.rows.map((row, index) => (
          <PromptInputRow
            key={index}
            row={row}
            prefix={index === 0 && inputLayout.viewportStart === 0 ? prompt : "  "}
            disabled={props.disabled}
            showCursor={index === inputLayout.cursorLine}
            cursorColumn={inputLayout.cursorColumn}
          />
        ))}
      </Box>
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      {!props.disabled ? <SlashSuggestions value={props.value} selectedIndex={props.slashSelection} /> : null}
      <PromptFooter
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        workspace={props.workspace}
        session={props.session}
        systemProfile={props.systemProfile}
        run={props.run}
        notice={props.notice}
        streamState={props.streamState}
        agentMode={props.agentMode}
      />
    </Box>
  );
}

function PromptInputRow(props: {
  row: string;
  prefix: string;
  disabled?: boolean | undefined;
  showCursor: boolean;
  cursorColumn: number;
}) {
  const parts = splitRowAtTerminalColumn(props.row, props.cursorColumn);
  const cursorGlyph = parts.cursor || " ";
  return (
    <Text wrap="truncate-end">
      <Text {...(props.disabled ? { color: "gray" } : {})} dimColor={Boolean(props.disabled)}>
        {props.prefix}
      </Text>
      {props.showCursor && !props.disabled ? (
        <>
          {parts.before}
          <Text inverse>{cursorGlyph}</Text>
          {parts.after}
        </>
      ) : (
        props.row || " "
      )}
    </Text>
  );
}

function splitRowAtTerminalColumn(row: string, column: number) {
  const chars = Array.from(row);
  let currentColumn = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const charWidth = characterWidth(char);
    if (currentColumn >= column || currentColumn + charWidth > column) {
      return {
        before: chars.slice(0, index).join(""),
        cursor: char,
        after: chars.slice(index + 1).join("")
      };
    }
    currentColumn += charWidth;
  }
  return {
    before: row,
    cursor: "",
    after: ""
  };
}

export function getPromptInputRowCount(value: string, columns: number) {
  return layoutComposerInput(value, value.length, columns).rows.length;
}

export function getSlashSuggestionRowCount(value: string) {
  const matches = getSlashCommandMatches(value);
  return matches.length > 0 ? Math.min(matches.length, SLASH_SUGGESTION_MAX_ROWS) : 0;
}

function layoutComposerInput(value: string, cursor: number, columns: number) {
  const maxVisibleRows = 6;
  const prompt = "❯ ";
  const contentWidth = Math.max(1, columns - terminalWidth(prompt));
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const beforeCursor = value.slice(0, safeCursor);
  const cursorLogicalLine = beforeCursor.split("\n").length - 1;
  const cursorColumnInLogicalLine = beforeCursor.slice(beforeCursor.lastIndexOf("\n") + 1).length;
  const logicalLines = value.split("\n");

  const rows: string[] = [];
  let cursorLine = 0;
  let cursorColumn = 0;

  logicalLines.forEach((line, lineIndex) => {
    const wrappedRows = wrapInputLine(line, contentWidth);
    if (lineIndex === cursorLogicalLine) {
      const cursorPrefix = line.slice(0, cursorColumnInLogicalLine);
      const beforeRows = wrapInputLine(cursorPrefix, contentWidth);
      cursorLine = rows.length + beforeRows.length - 1;
      cursorColumn = terminalWidth(beforeRows[beforeRows.length - 1] ?? "");
    }
    rows.push(...wrappedRows);
  });

  const viewportStart = Math.max(0, Math.min(cursorLine - maxVisibleRows + 1, rows.length - maxVisibleRows));
  const visibleRows = rows.slice(viewportStart, viewportStart + maxVisibleRows);
  return {
    rows: visibleRows.length > 0 ? visibleRows : [""],
    cursorLine: Math.max(0, cursorLine - viewportStart),
    cursorColumn,
    viewportStart
  };
}

function wrapInputLine(value: string, width: number) {
  if (!value) {
    return [""];
  }

  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  for (const char of Array.from(value)) {
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
  return rows;
}

function terminalWidth(value: string) {
  return Array.from(value).reduce((width, char) => width + characterWidth(char), 0);
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

function PromptFooter(props: {
  disabled?: boolean;
  workspace: Workspace | null;
  session: Session | null;
  systemProfile: SystemProfile | null;
  run: Run | null;
  notice: Notice;
  streamState: string;
  agentMode: string;
}) {
  const sessionLabel = props.session?.title ?? shortId(props.session?.id);
  const location = props.session ? `${props.workspace?.name ?? "no workspace"} / ${sessionLabel}` : props.workspace?.name ?? "no workspace";
  const activity = footerActivity(props.run, props.session, props.streamState);
  const shortcuts = props.disabled ? "modal · esc" : "? · ^W ws · ^O sess · ^C";
  const modelAgent = footerModelAgent(props.session, props.agentMode);
  const systemName = props.systemProfile ? formatSystemProfileDisplayName(props.systemProfile) : "OAH";
  const serverLabel = props.systemProfile ? systemName : "server profile unknown";

  return (
    <Box paddingX={2} flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor wrap="truncate-end">
            <Text color="cyan" bold>
              {systemName}
            </Text>{" "}
            {location}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {props.notice.level === "error" ? (
            <Text color="red" wrap="truncate-start">
              {props.notice.message}
            </Text>
          ) : (
            <Text dimColor wrap="truncate-start">
              {activity ? `${activity} · ` : ""}
              {shortcuts}
            </Text>
          )}
        </Box>
      </Box>
      <Box flexDirection="row" width="100%">
        <Box flexShrink={1} flexGrow={1}>
          <Text dimColor wrap="truncate-start">
            {modelAgent} · {serverLabel}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function footerModelAgent(session: Session | null, agentMode: string) {
  if (!session) {
    return "model auto · agent none";
  }
  const model = session.modelRef ? session.modelRef.replace(/^(platform|workspace)\//u, "") : "auto";
  const agent = session.activeAgentName || session.agentName || "agent";
  const mode = agentMode || "unknown";
  return `model ${model} · agent ${agent} · mode ${mode}`;
}

function footerActivity(run: Run | null, session: Session | null, streamState: string) {
  const runStatus = run?.status;
  if (runStatus && runStatus !== "completed") {
    return `${session?.activeAgentName ?? "agent"} · ${runStatus}`;
  }
  if (!session || streamState === "idle") {
    return "";
  }
  return streamState === "open" ? "connected" : streamState;
}

const SLASH_SUGGESTION_MAX_ROWS = 5;

export function SlashSuggestions(props: { value: string; selectedIndex: number }) {
  const { columns } = useWindowSize();
  const matches = getSlashCommandMatches(props.value);
  if (matches.length === 0) {
    return null;
  }
  const selectedIndex = clampIndex(props.selectedIndex, matches.length);
  const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(SLASH_SUGGESTION_MAX_ROWS / 2), matches.length - SLASH_SUGGESTION_MAX_ROWS));
  const visibleMatches = matches.slice(startIndex, startIndex + SLASH_SUGGESTION_MAX_ROWS);
  const commandColumnWidth = Math.min(
    Math.max(12, Math.floor(columns * 0.4)),
    Math.max(28, ...visibleMatches.map((item) => terminalWidth(item.command) + 6))
  );
  return (
    <Box flexDirection="column">
      {visibleMatches.map((item, index) => {
        const absoluteIndex = startIndex + index;
        const selected = absoluteIndex === selectedIndex;
        const paddedCommand = `${item.command}${" ".repeat(Math.max(1, commandColumnWidth - terminalWidth(item.command)))}`;
        return (
          <Text key={item.command} wrap="truncate">
            <Text {...(selected ? { color: "cyan" } : {})} dimColor={!selected}>
              {paddedCommand}
            </Text>
            <Text {...(selected ? { color: "cyan" } : {})} dimColor={!selected}>
              {item.description}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
