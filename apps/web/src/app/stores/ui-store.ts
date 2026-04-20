import { create } from "zustand";

import type {
  AppRequestErrorSummary,
  ConsoleFilter,
  InspectorTab,
  MainViewMode,
  SurfaceMode
} from "../support";

type TimelineInspectorMode = "all" | "execution" | "messages" | "calls" | "steps" | "events";

type UiState = {
  surfaceMode: SurfaceMode;
  mainViewMode: MainViewMode;
  inspectorTab: InspectorTab;
  timelineInspectorMode: TimelineInspectorMode;
  selectedTraceId: string;
  selectedMessageId: string;
  selectedStepId: string;
  selectedEventId: string;
  consoleOpen: boolean;
  consoleHeight: number;
  consoleFilter: ConsoleFilter;
  activity: string;
  errorMessage: string;
  activeError: AppRequestErrorSummary | null;
  streamRevision: number;
  autoStream: boolean;
  filterSelectedRun: boolean;
  setSurfaceMode: (value: SurfaceMode) => void;
  setMainViewMode: (value: MainViewMode) => void;
  setInspectorTab: (value: InspectorTab) => void;
  setTimelineInspectorMode: (value: TimelineInspectorMode) => void;
  setSelectedTraceId: (value: string) => void;
  setSelectedMessageId: (value: string) => void;
  setSelectedStepId: (value: string) => void;
  setSelectedEventId: (value: string) => void;
  setConsoleOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setConsoleHeight: (value: number) => void;
  setConsoleFilter: (value: ConsoleFilter) => void;
  setActivity: (value: string) => void;
  setErrorMessage: (value: string) => void;
  setActiveError: (value: AppRequestErrorSummary | null | ((current: AppRequestErrorSummary | null) => AppRequestErrorSummary | null)) => void;
  setStreamRevision: (value: number | ((current: number) => number)) => void;
  setAutoStream: (value: boolean) => void;
  setFilterSelectedRun: (value: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  surfaceMode: "engine",
  mainViewMode: "conversation",
  inspectorTab: "overview",
  timelineInspectorMode: "all",
  selectedTraceId: "",
  selectedMessageId: "",
  selectedStepId: "",
  selectedEventId: "",
  consoleOpen: false,
  consoleHeight: 280,
  consoleFilter: "all",
  activity: "等待连接",
  errorMessage: "",
  activeError: null,
  streamRevision: 0,
  autoStream: true,
  filterSelectedRun: false,
  setSurfaceMode: (surfaceMode) => set({ surfaceMode }),
  setMainViewMode: (mainViewMode) => set({ mainViewMode }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setTimelineInspectorMode: (timelineInspectorMode) => set({ timelineInspectorMode }),
  setSelectedTraceId: (selectedTraceId) => set({ selectedTraceId }),
  setSelectedMessageId: (selectedMessageId) => set({ selectedMessageId }),
  setSelectedStepId: (selectedStepId) => set({ selectedStepId }),
  setSelectedEventId: (selectedEventId) => set({ selectedEventId }),
  setConsoleOpen: (value) =>
    set((state) => ({ consoleOpen: typeof value === "function" ? value(state.consoleOpen) : value })),
  setConsoleHeight: (consoleHeight) => set({ consoleHeight }),
  setConsoleFilter: (consoleFilter) => set({ consoleFilter }),
  setActivity: (activity) => set({ activity }),
  setErrorMessage: (errorMessage) => set({ errorMessage }),
  setActiveError: (value) =>
    set((state) => ({ activeError: typeof value === "function" ? value(state.activeError) : value })),
  setStreamRevision: (value) =>
    set((state) => ({ streamRevision: typeof value === "function" ? value(state.streamRevision) : value })),
  setAutoStream: (autoStream) => set({ autoStream }),
  setFilterSelectedRun: (filterSelectedRun) => set({ filterSelectedRun })
}));
