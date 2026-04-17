import { create } from "zustand";

type SessionAgentState = {
  pendingSessionAgentName: string | null;
  switchingSessionAgentId: string | null;
  pendingSessionModelRef: string | null;
  switchingSessionModelId: string | null;
  setPendingSessionAgentName: (value: string | null) => void;
  setSwitchingSessionAgentId: (value: string | null) => void;
  setPendingSessionModelRef: (value: string | null) => void;
  setSwitchingSessionModelId: (value: string | null) => void;
};

export const useSessionAgentStore = create<SessionAgentState>((set) => ({
  pendingSessionAgentName: null,
  switchingSessionAgentId: null,
  pendingSessionModelRef: null,
  switchingSessionModelId: null,
  setPendingSessionAgentName: (pendingSessionAgentName) => set({ pendingSessionAgentName }),
  setSwitchingSessionAgentId: (switchingSessionAgentId) => set({ switchingSessionAgentId }),
  setPendingSessionModelRef: (pendingSessionModelRef) => set({ pendingSessionModelRef }),
  setSwitchingSessionModelId: (switchingSessionModelId) => set({ switchingSessionModelId })
}));
