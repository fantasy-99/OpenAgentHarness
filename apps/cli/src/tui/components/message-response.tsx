import React, { useContext } from "react";
import { Box, Text } from "ink";

const MessageResponseContext = React.createContext(false);

export function MessageResponse(props: { children: React.ReactNode; height?: number | undefined }) {
  const isNested = useContext(MessageResponseContext);
  if (isNested) {
    return props.children;
  }

  return (
    <MessageResponseContext.Provider value={true}>
      <Box flexDirection="row" height={props.height} overflowY="hidden">
        <Box flexShrink={0}>
          <Text dimColor>{"  "}⎿  </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} flexDirection="column">
          {props.children}
        </Box>
      </Box>
    </MessageResponseContext.Provider>
  );
}
