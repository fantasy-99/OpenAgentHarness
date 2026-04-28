import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

import type { ChatLine } from "../domain/types.js";
import { Markdown } from "./markdown.js";
import { MessageResponse } from "./message-response.js";
import { stripAnsi, truncateLines, truncateSingleLine, wrapTerminalRows } from "./terminal-text.js";

type ToolStatus = NonNullable<ChatLine["toolStatus"]>;

type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string | undefined;
};

export function ToolLine(props: { line: ChatLine & { marginBottom?: number | undefined }; columns: number }) {
  const status = props.line.toolStatus ?? (props.line.tone === "error" ? "failed" : "completed");
  const renderer = selectRenderer(props.line);
  return (
    <Box flexDirection="column" marginBottom={props.line.marginBottom ?? 0}>
      {renderer(props.line, status, props.columns)}
    </Box>
  );
}

function selectRenderer(line: ChatLine) {
  const toolName = (line.toolName ?? line.title ?? "").toLowerCase();
  if (toolName === "bash") {
    return BashToolLine;
  }
  if (toolName === "todowrite") {
    return TodoWriteToolLine;
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return FileToolLine;
  }
  if (toolName === "grep" || toolName === "glob") {
    return SearchToolLine;
  }
  if (toolName === "webfetch") {
    return WebFetchToolLine;
  }
  if (toolName === "subagent" || toolName === "agentswitch" || toolName.startsWith("agent.")) {
    return AgentToolLine;
  }
  return GenericToolLine;
}

function BashToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const input = isRecord(line.toolInput) ? line.toolInput : {};
  const command = readString(input.command) ?? readString(input.cmd) ?? commandFromDetail(line.detail);
  const summary = command ? truncateLines(command, 2, 160).text : "";
  const result = parseBashOutput(toolResponseText(line));
  const isError = status === "failed" || status === "denied" || (result.exitCode !== undefined && result.exitCode !== 0);
  const showRunning = status === "running" || status === "queued" || status === "waiting";

  return (
    <>
      <ToolHeader status={status} title="Bash" detail={summary ? `$ ${summary}` : line.detail} sourceType={line.sourceType} isError={isError} />
      {showRunning ? (
        <MessageResponse height={1}>
          <Text dimColor>{status === "queued" ? "Waiting…" : "Running…"}</Text>
        </MessageResponse>
      ) : (
        <BashResult output={result} fallback={toolResponseText(line)} isError={isError} columns={columns} />
      )}
    </>
  );
}

function BashResult(props: { output: ParsedBashOutput; fallback: string; isError: boolean; columns: number }) {
  const hasOutput = Boolean(props.output.stdout.trim() || props.output.stderr.trim());
  if (!hasOutput && !props.fallback.trim()) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>(No output)</Text>
      </MessageResponse>
    );
  }

  if (!hasOutput) {
    return (
      <MessageResponse>
        <OutputBlock text={props.fallback} isError={props.isError} columns={props.columns} />
      </MessageResponse>
    );
  }

  return (
    <Box flexDirection="column">
      {props.output.stdout.trim() ? (
        <MessageResponse>
          <OutputBlock text={props.output.stdout} columns={props.columns} />
        </MessageResponse>
      ) : null}
      {props.output.stderr.trim() ? (
        <MessageResponse>
          <OutputBlock text={props.output.stderr} isError columns={props.columns} />
        </MessageResponse>
      ) : null}
    </Box>
  );
}

function TodoWriteToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const todos = readTodos(line.toolInput) ?? readTodos(line.toolOutput) ?? todosFromText(line.toolOutputText ?? line.text);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
  const pending = todos.filter((todo) => todo.status === "pending").length;
  const summary = todos.length > 0 ? `${completed} done, ${inProgress} in progress, ${pending} pending` : line.detail;

  return (
    <>
      <ToolHeader status={status} title="Update Todos" detail={summary} sourceType={line.sourceType} />
      {todos.length > 0 ? (
        <MessageResponse>
          <TodoList todos={todos} columns={columns} />
        </MessageResponse>
      ) : toolResponseText(line) ? (
        <MessageResponse>
          <OutputBlock text={toolResponseText(line)} columns={columns} />
        </MessageResponse>
      ) : null}
    </>
  );
}

function FileToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const input = isRecord(line.toolInput) ? line.toolInput : {};
  const filePath = readString(input.file_path) ?? readString(input.path) ?? pathFromOutput(line.toolOutputText ?? line.text) ?? line.detail;
  const toolName = (line.toolName ?? "").toLowerCase();
  const title = toolName === "edit" ? "Edit" : toolName === "write" ? "Write" : "Read";
  const response = conciseNativeOutput(line.toolOutputText ?? line.text, title);

  return (
    <>
      <ToolHeader status={status} title={title} detail={filePath} sourceType={line.sourceType} isError={line.tone === "error"} />
      {response ? (
        <MessageResponse>
          <OutputBlock text={response} isError={line.tone === "error"} columns={columns} maxLines={title === "Read" ? 6 : 3} />
        </MessageResponse>
      ) : null}
    </>
  );
}

function SearchToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const input = isRecord(line.toolInput) ? line.toolInput : {};
  const pattern = readString(input.pattern) ?? readString(input.query);
  const root = readString(input.path);
  const title = (line.toolName ?? "").toLowerCase() === "glob" ? "Find Files" : "Search";
  const response = conciseNativeOutput(line.toolOutputText ?? line.text, title);
  const detail = [pattern, root].filter(Boolean).join(" in ");

  return (
    <>
      <ToolHeader status={status} title={title} detail={detail || line.detail} sourceType={line.sourceType} isError={line.tone === "error"} />
      {response ? (
        <MessageResponse>
          <OutputBlock text={response} isError={line.tone === "error"} columns={columns} maxLines={8} />
        </MessageResponse>
      ) : null}
    </>
  );
}

function WebFetchToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const input = isRecord(line.toolInput) ? line.toolInput : {};
  const url = readString(input.url) ?? line.detail;
  return (
    <>
      <ToolHeader status={status} title="Fetch" detail={url} sourceType={line.sourceType} isError={line.tone === "error"} />
      {toolResponseText(line) ? (
        <MessageResponse>
          <Markdown text={capText(toolResponseText(line), 10).text} dimColor={line.tone === "muted"} />
        </MessageResponse>
      ) : null}
    </>
  );
}

function AgentToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const input = isRecord(line.toolInput) ? line.toolInput : {};
  const prompt = readString(input.prompt) ?? readString(input.task) ?? readString(input.description) ?? line.detail;
  return (
    <>
      <ToolHeader status={status} title={line.toolName ?? "Agent"} detail={prompt} sourceType={line.sourceType} isError={line.tone === "error"} />
      {toolResponseText(line) ? (
        <MessageResponse>
          <OutputBlock text={toolResponseText(line)} isError={line.tone === "error"} columns={columns} maxLines={10} />
        </MessageResponse>
      ) : null}
    </>
  );
}

function GenericToolLine(line: ChatLine, status: ToolStatus, columns: number) {
  const response = toolResponseText(line);
  const isError = status === "failed" || status === "denied";
  return (
    <>
      <ToolHeader
        status={status}
        title={line.title ?? line.toolName ?? "Tool"}
        detail={line.detail}
        sourceType={line.sourceType}
        isError={isError}
      />
      {response ? (
        <MessageResponse>
          <OutputBlock text={response} isError={isError} columns={columns} />
        </MessageResponse>
      ) : status === "running" ? (
        <MessageResponse height={1}>
          <Text dimColor>Running…</Text>
        </MessageResponse>
      ) : null}
    </>
  );
}

function ToolHeader(props: {
  status: ToolStatus;
  title: string;
  detail?: string | undefined;
  sourceType?: string | undefined;
  isError?: boolean | undefined;
}) {
  const detail = props.detail ? truncateSingleLine(props.detail, 120) : "";
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      <ToolStatusDot status={props.status} />
      <Text bold wrap="truncate-end" {...(props.isError ? { color: "red" } : {})}>
        {props.title}
      </Text>
      {detail ? <Text dimColor> {detail}</Text> : null}
      {props.sourceType ? <Text dimColor> · {props.sourceType}</Text> : null}
    </Box>
  );
}

function ToolStatusDot(props: { status: ToolStatus }) {
  const [visible, setVisible] = useState(true);
  const running = props.status === "running" || props.status === "queued" || props.status === "waiting";

  useEffect(() => {
    if (!running) {
      setVisible(true);
      return;
    }
    const timer = setInterval(() => setVisible((current) => !current), 420);
    return () => clearInterval(timer);
  }, [running]);

  const color = props.status === "failed" || props.status === "denied" ? "red" : props.status === "completed" ? "green" : "cyan";
  return (
    <Box minWidth={2}>
      <Text color={color} dimColor={running}>
        {running && !visible ? " " : "●"}
      </Text>
    </Box>
  );
}

function OutputBlock(props: {
  text: string;
  isError?: boolean | undefined;
  columns: number;
  maxLines?: number | undefined;
}) {
  const maxLines = props.maxLines ?? 10;
  const capped = capText(formatOutputText(props.text), maxLines);
  const color = props.isError ? "red" : undefined;
  return (
    <Box flexDirection="column">
      {capped.text.split("\n").map((line, index) => (
        <Text key={index} {...(color ? { color } : {})} dimColor={!props.isError} wrap="wrap">
          {formatOutputLine(line, props.columns)}
        </Text>
      ))}
      {capped.hidden > 0 ? (
        <Text dimColor>
          … +{capped.hidden} {capped.hidden === 1 ? "line" : "lines"}
        </Text>
      ) : null}
    </Box>
  );
}

function TodoList(props: { todos: TodoItem[]; columns: number }) {
  const maxDisplay = 10;
  const visible = props.todos.slice(0, maxDisplay);
  const hidden = props.todos.length - visible.length;
  return (
    <Box flexDirection="column">
      {visible.map((todo, index) => {
        const isCompleted = todo.status === "completed";
        const isInProgress = todo.status === "in_progress";
        const icon = isCompleted ? "✓" : isInProgress ? "▪" : "◦";
        const color = isCompleted ? "green" : isInProgress ? "cyan" : undefined;
        const text = truncateSingleLine(todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content, Math.max(20, props.columns - 12));
        return (
          <Text
            key={index}
            {...(color ? { color } : {})}
            dimColor={isCompleted || todo.status === "pending"}
            strikethrough={isCompleted}
          >
            {icon} {text}
          </Text>
        );
      })}
      {hidden > 0 ? <Text dimColor>… +{hidden} more</Text> : null}
    </Box>
  );
}

type ParsedBashOutput = {
  exitCode?: number | undefined;
  stdout: string;
  stderr: string;
  description?: string | undefined;
};

function parseBashOutput(text: string): ParsedBashOutput {
  const output: ParsedBashOutput = { stdout: "", stderr: "" };
  let section: "stdout" | "stderr" | undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const line of text.split("\n")) {
    const exitCode = line.match(/^exit_code:\s*(-?\d+)/u);
    if (exitCode) {
      output.exitCode = Number(exitCode[1]);
      section = undefined;
      continue;
    }
    const description = line.match(/^description:\s*(.*)$/u);
    if (description) {
      output.description = description[1] ?? "";
      section = undefined;
      continue;
    }
    if (line.trim() === "stdout:") {
      section = "stdout";
      continue;
    }
    if (line.trim() === "stderr:") {
      section = "stderr";
      continue;
    }
    if (section === "stdout") {
      stdout.push(line);
    } else if (section === "stderr") {
      stderr.push(line);
    }
  }
  output.stdout = stdout.join("\n").trimEnd();
  output.stderr = stderr.join("\n").trimEnd();
  return output;
}

function readTodos(value: unknown): TodoItem[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.todos)) {
    return undefined;
  }
  const todos: TodoItem[] = [];
  for (const todo of value.todos) {
    if (!isRecord(todo)) {
      continue;
    }
    const content = readString(todo.content);
    const activeForm = readString(todo.activeForm);
    const status = todo.status;
    if (!content || (status !== "pending" && status !== "in_progress" && status !== "completed")) {
      continue;
    }
    todos.push({
      content,
      status,
      ...(activeForm ? { activeForm } : {})
    });
  }
  return todos.length > 0 ? todos : undefined;
}

function todosFromText(text: string): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^(pending|in_progress|completed):\s+(.+)$/u);
    if (match) {
      todos.push({ status: match[1] as TodoItem["status"], content: match[2] ?? "" });
    }
  }
  return todos;
}

function conciseNativeOutput(text: string, toolTitle: string) {
  if (!text.trim()) {
    return "";
  }
  if (toolTitle === "Read") {
    const contentIndex = text.indexOf("\ncontent:\n");
    if (contentIndex >= 0) {
      return text.slice(contentIndex + "\ncontent:\n".length).trim();
    }
  }
  if (toolTitle === "Write" || toolTitle === "Edit") {
    return text
      .split("\n")
      .filter((line) => /^(bytes_written|occurrences|file_path):/u.test(line))
      .join("\n");
  }
  return text.replace(/^pattern: .+\nroot: .+\nmode: .+\n/u, "").trim();
}

function pathFromOutput(text: string) {
  return text.match(/^file_path:\s*(.+)$/mu)?.[1]?.trim();
}

function commandFromDetail(detail: string | undefined) {
  if (!detail) {
    return undefined;
  }
  return detail.startsWith("$ ") ? detail.slice(2) : detail;
}

function toolResponseText(line: ChatLine) {
  const text = line.toolOutputText ?? line.text;
  const title = line.title ?? line.toolName;
  if (!text.trim()) {
    return "";
  }
  if (title && text.trim() === title.trim()) {
    return "";
  }
  const compactHeader = title && line.detail ? `${title} (${line.detail})` : title;
  if (compactHeader && text.trim() === compactHeader.trim()) {
    return "";
  }
  return text;
}

function capText(text: string, maxLines: number) {
  const lines = text.split("\n");
  const visible = lines.slice(0, maxLines);
  return {
    text: visible.join("\n"),
    hidden: Math.max(0, lines.length - visible.length)
  };
}

function formatOutputText(text: string) {
  const clean = stripAnsi(text).trimEnd();
  return clean
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return line;
      }
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return line;
      }
    })
    .join("\n");
}

function formatOutputLine(line: string, columns: number) {
  const urlMatch = line.match(/https?:\/\/\S+/u);
  if (!urlMatch) {
    return line || " ";
  }
  const [url] = urlMatch;
  const before = line.slice(0, urlMatch.index);
  const after = line.slice((urlMatch.index ?? 0) + url.length);
  return (
    <>
      {before}
      <Text color="blue" underline>
        {truncateSingleLine(url, Math.max(20, columns - before.length - after.length - 8))}
      </Text>
      {after}
    </>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function getToolLineRowCount(line: ChatLine, columns: number) {
  const status = line.toolStatus ?? (line.tone === "error" ? "failed" : "completed");
  const toolName = (line.toolName ?? line.title ?? "").toLowerCase();
  if (toolName === "todowrite") {
    const todos = readTodos(line.toolInput) ?? readTodos(line.toolOutput) ?? todosFromText(line.toolOutputText ?? line.text);
    return 1 + (todos.length > 0 ? Math.min(todos.length, 10) + (todos.length > 10 ? 1 : 0) : 0);
  }
  if (status === "running" || status === "queued" || status === "waiting") {
    return 2;
  }
  const response = toolResponseText(line);
  if (!response) {
    return 1;
  }
  const responseRows = wrapTerminalRows(response, Math.max(1, columns - 5));
  return 1 + Math.min(10, responseRows.length) + (responseRows.length > 10 ? 1 : 0);
}
