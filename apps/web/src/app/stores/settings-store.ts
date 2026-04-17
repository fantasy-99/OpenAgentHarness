import { create } from "zustand";

import {
  SERVICE_SCOPE_ALL,
  storageKeys,
  type ConnectionSettings,
  type ModelDraft,
  type ServiceScope
} from "../support";

type Updater<T> = T | ((current: T) => T);

function hydrate<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function persist<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function resolve<T>(updater: Updater<T>, current: T): T {
  return typeof updater === "function" ? (updater as (current: T) => T)(current) : updater;
}

type SettingsState = {
  connection: ConnectionSettings;
  workspaceBlueprintFilter: string;
  serviceScope: ServiceScope;
  modelDraft: ModelDraft;
  setConnection: (updater: Updater<ConnectionSettings>) => void;
  setWorkspaceBlueprintFilter: (updater: Updater<string>) => void;
  setServiceScope: (updater: Updater<ServiceScope>) => void;
  setModelDraft: (updater: Updater<ModelDraft>) => void;
};

const DEFAULT_CONNECTION: ConnectionSettings = { baseUrl: "", token: "" };
const DEFAULT_MODEL_DRAFT: ModelDraft = {
  model: "",
  prompt: "你好，请简短回复一句话，确认模型链路已经接通。"
};

export const useSettingsStore = create<SettingsState>((set) => ({
  connection: hydrate<ConnectionSettings>(storageKeys.connection, DEFAULT_CONNECTION),
  workspaceBlueprintFilter: hydrate<string>(storageKeys.workspaceBlueprintFilter, ""),
  serviceScope: hydrate<ServiceScope>(storageKeys.serviceScope, SERVICE_SCOPE_ALL),
  modelDraft: hydrate<ModelDraft>(storageKeys.modelDraft, DEFAULT_MODEL_DRAFT),
  setConnection: (updater) =>
    set((state) => {
      const next = resolve(updater, state.connection);
      persist(storageKeys.connection, next);
      return { connection: next };
    }),
  setWorkspaceBlueprintFilter: (updater) =>
    set((state) => {
      const next = resolve(updater, state.workspaceBlueprintFilter);
      persist(storageKeys.workspaceBlueprintFilter, next);
      return { workspaceBlueprintFilter: next };
    }),
  setServiceScope: (updater) =>
    set((state) => {
      const next = resolve(updater, state.serviceScope);
      persist(storageKeys.serviceScope, next);
      return { serviceScope: next };
    }),
  setModelDraft: (updater) =>
    set((state) => {
      const next = resolve(updater, state.modelDraft);
      persist(storageKeys.modelDraft, next);
      return { modelDraft: next };
    })
}));
