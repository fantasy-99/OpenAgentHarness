import React from "react";
import { Box, Text } from "ink";

import { rowCountForText } from "./terminal-text.js";

type Block =
  | { type: "blank" }
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: Array<{ marker: string; text: string; checked?: boolean | undefined }> }
  | { type: "code"; language: string; text: string }
  | { type: "table"; rows: string[][] };

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /u;
const tokenCache = new Map<string, Block[]>();
const TOKEN_CACHE_MAX = 500;

export function Markdown(props: { text: string; dimColor?: boolean | undefined }) {
  const blocks = parseMarkdown(props.text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} block={block} dimColor={props.dimColor} />
      ))}
    </Box>
  );
}

function MarkdownBlock(props: { block: Block; dimColor?: boolean | undefined }) {
  switch (props.block.type) {
    case "blank":
      return <Text> </Text>;
    case "heading":
      return (
        <Text bold {...(props.block.depth <= 2 ? { color: "cyan" } : {})} {...(props.dimColor !== undefined ? { dimColor: props.dimColor } : {})}>
          {props.block.text}
        </Text>
      );
    case "paragraph":
      return (
        <Text wrap="wrap" {...(props.dimColor !== undefined ? { dimColor: props.dimColor } : {})}>
          {renderInline(props.block.text)}
        </Text>
      );
    case "quote":
      return (
        <Text dimColor wrap="wrap">
          │ {renderInline(props.block.text)}
        </Text>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {props.block.items.map((item, index) => (
            <Text key={index} wrap="wrap" {...(props.dimColor !== undefined ? { dimColor: props.dimColor } : {})}>
              <Text dimColor>{item.checked === true ? "☑" : item.checked === false ? "☐" : item.marker}</Text> {renderInline(item.text)}
            </Text>
          ))}
        </Box>
      );
    case "code":
      return (
        <Box flexDirection="column" paddingLeft={2}>
          {props.block.language ? <Text dimColor>{props.block.language}</Text> : null}
          {props.block.text.split("\n").map((line, index) => (
            <Text key={index} color="gray" wrap="truncate-end">
              {line || " "}
            </Text>
          ))}
        </Box>
      );
    case "table":
      return (
        <Box flexDirection="column">
          {formatTableRows(props.block.rows).map((row, index) => (
            <Text key={index} dimColor={index === 1} wrap="truncate-end">
              {row}
            </Text>
          ))}
        </Box>
      );
  }
}

function renderInline(text: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/\S+)/gu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = nodes.length;
    if (token.startsWith("`")) {
      nodes.push(
        <Text key={key} color="yellow">
          {token.slice(1, -1)}
        </Text>
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <Text key={key} bold>
          {token.slice(2, -2)}
        </Text>
      );
    } else if (token.startsWith("http")) {
      nodes.push(
        <Text key={key} color="blue" underline>
          {token}
        </Text>
      );
    } else {
      nodes.push(
        <Text key={key} italic>
          {token.slice(1, -1)}
        </Text>
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : text;
}

function parseMarkdown(text: string): Block[] {
  if (!MD_SYNTAX_RE.test(text.slice(0, 500))) {
    return [{ type: "paragraph", text }];
  }

  const cached = tokenCache.get(text);
  if (cached) {
    tokenCache.delete(text);
    tokenCache.set(text, cached);
    return cached;
  }

  const blocks = parseMarkdownUncached(text);
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) {
      tokenCache.delete(oldest);
    }
  }
  tokenCache.set(text, blocks);
  return blocks;
}

function parseMarkdownUncached(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (blocks.at(-1)?.type !== "blank") {
        blocks.push({ type: "blank" });
      }
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```([^`]*)$/u);
    if (fence) {
      const language = fence[1]?.trim() ?? "";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, text: codeLines.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/u);
    if (heading) {
      blocks.push({ type: "heading", depth: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableRows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index] ?? "")) {
        const cells = (lines[index] ?? "")
          .trim()
          .replace(/^\|/u, "")
          .replace(/\|$/u, "")
          .split("|")
          .map((cell) => cell.trim());
        tableRows.push(cells);
        index += 1;
      }
      blocks.push({ type: "table", rows: tableRows });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/u);
    if (quote) {
      const quoteLines = [quote[1] ?? ""];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? "").match(/^\s*>\s?(.*)$/u);
        if (!next) {
          break;
        }
        quoteLines.push(next[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    const list = collectList(lines, index);
    if (list) {
      blocks.push(list.block);
      index = list.nextIndex;
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && shouldContinueParagraph(lines[index] ?? "")) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  while (blocks[0]?.type === "blank") {
    blocks.shift();
  }
  while (blocks.at(-1)?.type === "blank") {
    blocks.pop();
  }
  return blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }];
}

function isTableStart(lines: string[], index: number) {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return /^\s*\|.*\|\s*$/u.test(current) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(next);
}

function collectList(lines: string[], startIndex: number) {
  const first = parseListItem(lines[startIndex] ?? "");
  if (!first) {
    return null;
  }
  const items = [first];
  let index = startIndex + 1;
  while (index < lines.length) {
    const item = parseListItem(lines[index] ?? "");
    if (!item) {
      break;
    }
    items.push(item);
    index += 1;
  }
  return {
    block: {
      type: "list" as const,
      ordered: /^\d+\./u.test(first.marker),
      items
    },
    nextIndex: index
  };
}

function parseListItem(line: string) {
  const match = line.match(/^\s*((?:[-*+])|(?:\d+\.))\s+(\[[ xX]\]\s+)?(.+)$/u);
  if (!match) {
    return null;
  }
  const checkbox = match[2];
  return {
    marker: match[1] ?? "-",
    text: match[3] ?? "",
    checked: checkbox ? /x/iu.test(checkbox) : undefined
  };
}

function shouldContinueParagraph(line: string) {
  const trimmed = line.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith("```") &&
    !/^#{1,6}\s/u.test(trimmed) &&
    !/^\s*>/u.test(line) &&
    !parseListItem(line)
  );
}

function formatTableRows(rows: string[][]) {
  if (rows.length === 0) {
    return [];
  }
  const widths = rows.reduce<number[]>((current, row) => {
    row.forEach((cell, index) => {
      current[index] = Math.max(current[index] ?? 0, cell.length);
    });
    return current;
  }, []);

  return rows.map((row, rowIndex) => {
    if (rowIndex === 1 && row.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      return widths.map((width) => "─".repeat(Math.max(3, width))).join("─┼─");
    }
    return row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" │ ");
  });
}

export function getMarkdownRowCount(text: string, columns: number) {
  const width = Math.max(1, columns - 2);
  return parseMarkdown(text).reduce((rows, block) => {
    switch (block.type) {
      case "blank":
        return rows + 1;
      case "heading":
        return rows + rowCountForText(block.text, width);
      case "paragraph":
      case "quote":
        return rows + rowCountForText(block.text, width);
      case "code":
        return rows + (block.language ? 1 : 0) + Math.max(1, block.text.split("\n").length);
      case "list":
        return rows + block.items.reduce((total, item) => total + rowCountForText(`${item.marker} ${item.text}`, width), 0);
      case "table":
        return rows + block.rows.length;
    }
  }, 0);
}
