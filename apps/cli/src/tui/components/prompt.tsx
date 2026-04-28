import React, { useRef } from "react";
import { Box, Text, useBoxMetrics, useCursor, type DOMElement } from "ink";

import { clampIndex, getSlashCommandMatches } from "../domain/utils.js";

export function PromptInput(props: { value: string; cursor: number; disabled?: boolean; running: boolean }) {
  const beforeCursor = props.value.slice(0, props.cursor);
  const afterCursor = props.value.slice(props.cursor);
  const promptRef = useRef<DOMElement>(null!);
  const promptMetrics = useBoxMetrics(promptRef);
  const { setCursorPosition } = useCursor();

  setCursorPosition(
    !props.disabled && promptMetrics.hasMeasured
      ? {
          x: promptMetrics.left + 4 + terminalWidth(beforeCursor),
          y: promptMetrics.top + 1
        }
      : undefined
  );

  return (
    <Box ref={promptRef} flexDirection="column">
      <Box
        flexDirection="row"
        alignItems="flex-start"
        borderStyle="round"
        borderColor={props.disabled ? "gray" : "cyan"}
        paddingX={1}
        width="100%"
      >
        <Text {...(props.disabled ? { color: "gray" } : {})} dimColor={Boolean(props.disabled)}>
          ❯{" "}
        </Text>
        {props.value ? (
          <Text wrap="truncate-end">
            {beforeCursor}
            {afterCursor}
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <PromptFooter {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </Box>
  );
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

function PromptFooter(props: { disabled?: boolean }) {
  const help = props.disabled ? "modal active" : "? help";
  return (
    <Box paddingX={1}>
      <Text dimColor wrap="truncate-end">
        {help} · /workspace · /session · ctrl+c quit
      </Text>
    </Box>
  );
}

export function SlashSuggestions(props: { value: string; selectedIndex: number }) {
  const matches = getSlashCommandMatches(props.value);
  if (matches.length === 0) {
    return null;
  }
  const selectedIndex = clampIndex(props.selectedIndex, matches.length);
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {matches.map((item, index) => (
        <Text key={item.command} {...(index === selectedIndex ? { color: "cyan" } : {})} dimColor={index !== selectedIndex}>
          {index === selectedIndex ? "❯" : " "} {item.command} <Text dimColor>{item.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
