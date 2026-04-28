import React from "react";
import { Box, Text } from "ink";

import { clampIndex, getSlashCommandMatches } from "../domain/utils.js";

export function PromptInput(props: { value: string; cursor: number; disabled?: boolean; running: boolean }) {
  const beforeCursor = props.value.slice(0, props.cursor);
  const afterCursor = props.value.slice(props.cursor);
  return (
    <Box flexDirection="column">
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
            {!props.disabled ? <Text inverse>{afterCursor[0] ?? " "}</Text> : null}
            {afterCursor.slice(1)}
          </Text>
        ) : (
          <Text>{!props.disabled ? <Text inverse> </Text> : " "}</Text>
        )}
      </Box>
      <PromptFooter {...(props.disabled === undefined ? {} : { disabled: props.disabled })} />
    </Box>
  );
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
