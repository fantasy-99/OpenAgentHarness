import React from "react";
import { Box, Text } from "ink";

import { shortId } from "../domain/utils.js";

export function startBannerRows(params: { height: number; columns: number; hasMessages: boolean }) {
  if (params.height < 7) {
    return 0;
  }
  if (!params.hasMessages) {
    return params.height;
  }
  const target = params.columns >= 70 ? 10 : 7;
  return Math.max(0, Math.min(target, params.height - 6));
}

export function StartBanner(props: {
  height: number;
  columns: number;
  subtitle: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
  compact?: boolean | undefined;
}) {
  if (props.height <= 0) {
    return null;
  }
  if (props.height < 5) {
    return (
      <Box height={props.height} overflow="hidden">
        <Text dimColor>{props.subtitle}</Text>
      </Box>
    );
  }

  const compact = props.compact || props.columns < 70 || props.height < 9;
  return (
    <Box height={props.height} overflow="hidden" flexDirection="column">
      {compact ? <CompactBanner {...props} /> : <FullBanner {...props} />}
    </Box>
  );
}

function FullBanner(props: {
  columns: number;
  subtitle: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
}) {
  const title = " OAH TUI v0.1.0 ";
  const sessionLabel = props.sessionTitle ?? shortId(props.sessionId);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width="100%" overflow="hidden">
      <Text>
        <Text color="cyan" bold>
          {title}
        </Text>
      </Text>
      <Box flexDirection="row" gap={1}>
        <Box width={Math.min(32, Math.max(24, Math.floor(props.columns * 0.36)))} alignItems="center" flexDirection="column">
          <Text bold>Welcome back!</Text>
          <Box marginTop={1}>
            <OahMark />
          </Box>
          <Box alignItems="center" flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {props.workspaceName ?? "no workspace"}
            </Text>
            <Text dimColor wrap="truncate-end">
              {sessionLabel}
            </Text>
          </Box>
        </Box>
        <Box borderStyle="single" borderColor="cyan" borderDimColor borderTop={false} borderBottom={false} borderLeft={false} />
        <BannerFeeds subtitle={props.subtitle} />
      </Box>
    </Box>
  );
}

function CompactBanner(props: {
  subtitle: string;
  workspaceName?: string | undefined;
  sessionTitle?: string | undefined;
  sessionId?: string | undefined;
}) {
  const sessionLabel = props.sessionTitle ?? shortId(props.sessionId);
  return (
    <Box flexDirection="row" gap={2} alignItems="center" paddingX={1} overflow="hidden">
      <OahMark small />
      <Box flexDirection="column" flexShrink={1}>
        <Text>
          <Text bold>OAH TUI</Text> <Text dimColor>v0.1.0</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {props.workspaceName ?? "no workspace"}
          {sessionLabel ? ` / ${sessionLabel}` : ""}
        </Text>
        <Text dimColor wrap="truncate-end">
          {props.subtitle}
        </Text>
      </Box>
    </Box>
  );
}

function BannerFeeds(props: { subtitle: string }) {
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Text color="cyan" bold>
        Tips for getting started
      </Text>
      <Text wrap="truncate-end">{props.subtitle}</Text>
      <Text wrap="truncate-end">Use / for commands, ^W for workspaces, ^O for sessions.</Text>
      <Text dimColor>{"─".repeat(44)}</Text>
      <Text color="cyan" bold>
        What's new
      </Text>
      <Text wrap="truncate-end">Workspace and session details stay visible in the status bar.</Text>
      <Text wrap="truncate-end">SSE output streams live and remains pinned to the bottom.</Text>
    </Box>
  );
}

function OahMark(props: { small?: boolean | undefined }) {
  if (props.small) {
    return (
      <Box flexDirection="column">
        <Text color="cyan"> ▐███▌ </Text>
        <Text color="cyan">▝█████▘</Text>
        <Text color="cyan">  ▘ ▝  </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="cyan"> ▐███▌ </Text>
      <Text color="cyan">▝█████▘</Text>
      <Text color="cyan">  ▘ ▝  </Text>
    </Box>
  );
}
