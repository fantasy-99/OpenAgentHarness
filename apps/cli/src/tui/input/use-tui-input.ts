import { useInput } from "ink";

import type { Dialog, WorkspaceCreateDialog } from "../domain/types.js";
import {
  cleanControlInput,
  clampIndex,
  createWorkspaceDialog,
  cycleRuntime,
  hasRawControl,
  insertTextAt,
  isReturnInput,
  moveWorkspaceCreateField,
  SLASH_COMMANDS
} from "../domain/utils.js";
import type { useOahReplState } from "../state/use-oah-repl-state.js";

type OahReplState = ReturnType<typeof useOahReplState>;

type TuiInputKey = {
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  return?: boolean;
};

export function useTuiInput(input: { state: OahReplState; exit: () => void }) {
  const state = input.state;

  useInput((value, key) => {
    if ((value === "c" && key.ctrl) || hasRawControl(value, "\u0003")) {
      input.exit();
      return;
    }

    if (state.dialog) {
      handleDialogInput({ value, key, state });
      return;
    }

    handleComposerInput({ value, key, state });
  });
}

function handleDialogInput(input: { value: string; key: TuiInputKey; state: OahReplState }) {
  const { value, key, state } = input;
  const dialog = state.dialog;
  if (!dialog) {
    return;
  }

  if (key.escape) {
    if (dialog.kind === "workspace-create") {
      state.setDialog({ kind: "workspace-list", selectedIndex: 0 });
    } else if (dialog.kind === "session-create") {
      state.setDialog({ kind: "session-list", selectedIndex: 0 });
    } else {
      state.setDialog(null);
    }
    return;
  }
  if (dialog.kind === "help") {
    return;
  }
  if (dialog.kind === "workspace-create") {
    handleWorkspaceCreateInput({ value, key, dialog, state });
    return;
  }
  if (dialog.kind === "session-create") {
    handleSessionCreateInput({ value, key, dialog, state });
    return;
  }
  if (value === "n") {
    state.setDialog(
      dialog.kind === "workspace-list"
        ? createWorkspaceDialog(state.currentWorkspace?.runtime ?? state.runtimes[0]?.name)
        : { kind: "session-create", draft: "" }
    );
    return;
  }
  if (value === "r") {
    if (dialog.kind === "workspace-list") {
      void state.refreshWorkspaces();
    } else {
      void state.refreshCurrentWorkspaceSessions();
    }
    return;
  }
  if (key.downArrow || value === "j") {
    const length = dialog.kind === "workspace-list" ? state.workspaces.length : state.sessions.length;
    state.setDialog({ ...dialog, selectedIndex: clampIndex(dialog.selectedIndex + 1, length) });
    return;
  }
  if (key.upArrow || value === "k") {
    const length = dialog.kind === "workspace-list" ? state.workspaces.length : state.sessions.length;
    state.setDialog({ ...dialog, selectedIndex: clampIndex(dialog.selectedIndex - 1, length) });
    return;
  }
  if (isReturnInput(value, key)) {
    if (dialog.kind === "workspace-list") {
      const workspace = state.workspaces[dialog.selectedIndex];
      if (workspace) {
        void state.loadWorkspace(workspace);
      }
    } else {
      const session = state.sessions[dialog.selectedIndex];
      if (session) {
        state.selectSession(session);
      }
    }
  }
}

function handleWorkspaceCreateInput(input: {
  value: string;
  key: TuiInputKey;
  dialog: WorkspaceCreateDialog;
  state: OahReplState;
}) {
  const { dialog, key, state, value } = input;
  if ((value === "u" && key.ctrl) || hasRawControl(value, "\u0015")) {
    state.setDialog({ ...dialog, [dialog.field]: "" });
    return;
  }
  if ((value === "r" && key.ctrl) || hasRawControl(value, "\u0012")) {
    void state.refreshRuntimes();
    return;
  }
  if (key.tab || key.downArrow) {
    state.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, 1) });
    return;
  }
  if (key.upArrow) {
    state.setDialog({ ...dialog, field: moveWorkspaceCreateField(dialog.field, -1) });
    return;
  }
  if (key.leftArrow && dialog.field === "runtime") {
    state.setDialog({ ...dialog, runtime: cycleRuntime(dialog.runtime, state.runtimes, -1) });
    return;
  }
  if (key.rightArrow && dialog.field === "runtime") {
    state.setDialog({ ...dialog, runtime: cycleRuntime(dialog.runtime, state.runtimes, 1) });
    return;
  }
  if (isReturnInput(value, key)) {
    const cleanInput = cleanControlInput(value);
    const nextDialog = dialog.field === "runtime" ? dialog : { ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` };
    void state.createWorkspace(nextDialog);
    return;
  }
  if (key.backspace || key.delete) {
    if (dialog.field !== "runtime") {
      state.setDialog({ ...dialog, [dialog.field]: dialog[dialog.field].slice(0, -1) });
    }
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput && dialog.field !== "runtime") {
      state.setDialog({ ...dialog, [dialog.field]: `${dialog[dialog.field]}${cleanInput}` });
    }
  }
}

function handleSessionCreateInput(input: {
  value: string;
  key: TuiInputKey;
  dialog: Extract<Dialog, { kind: "session-create" }>;
  state: OahReplState;
}) {
  const { value, key, dialog, state } = input;
  if ((value === "u" && key.ctrl) || hasRawControl(value, "\u0015")) {
    state.setDialog({ ...dialog, draft: "" });
    return;
  }
  if (isReturnInput(value, key)) {
    void state.createSession(`${dialog.draft}${cleanControlInput(value)}`);
    return;
  }
  if (key.backspace || key.delete) {
    state.setDialog({ ...dialog, draft: dialog.draft.slice(0, -1) });
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput) {
      state.setDialog({ ...dialog, draft: `${dialog.draft}${cleanInput}` });
    }
  }
}

function handleComposerInput(input: { value: string; key: TuiInputKey; state: OahReplState }) {
  const { value, key, state } = input;
  if ((value === "w" && key.ctrl) || hasRawControl(value, "\u0017")) {
    state.setDialog({ kind: "workspace-list", selectedIndex: Math.max(0, state.workspaces.findIndex((item) => item.id === state.currentWorkspace?.id)) });
    return;
  }
  if ((value === "o" && key.ctrl) || hasRawControl(value, "\u000f")) {
    state.setDialog({ kind: "session-list", selectedIndex: Math.max(0, state.sessions.findIndex((item) => item.id === state.currentSession?.id)) });
    return;
  }
  if (value === "?") {
    state.setDialog({ kind: "help" });
    return;
  }
  if (isReturnInput(value, key)) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput) {
      const nextComposer = insertTextAt(state.composer, state.composerCursor, cleanInput);
      state.setComposerValue(nextComposer);
      void state.sendComposer(nextComposer);
    } else {
      void state.sendComposer();
    }
    return;
  }
  if (key.tab && state.composer.startsWith("/")) {
    const match = SLASH_COMMANDS.find((item) => item.command.startsWith(state.composer));
    if (match) {
      state.setComposerValue(match.command);
    }
    return;
  }
  if (key.leftArrow) {
    state.setComposerCursor((current) => Math.max(0, current - 1));
    return;
  }
  if (key.rightArrow) {
    state.setComposerCursor((current) => Math.min(state.composer.length, current + 1));
    return;
  }
  if (value === "a" && key.ctrl) {
    state.setComposerCursor(0);
    return;
  }
  if (value === "e" && key.ctrl) {
    state.setComposerCursor(state.composer.length);
    return;
  }
  if ((value === "u" && key.ctrl) || hasRawControl(value, "\u0015")) {
    state.setComposerValue("");
    return;
  }
  if (key.backspace || key.delete) {
    state.deleteComposerInput();
    return;
  }
  if (value && !key.ctrl && !key.meta) {
    const cleanInput = cleanControlInput(value);
    if (cleanInput) {
      state.insertComposerInput(cleanInput);
    }
  }
}
