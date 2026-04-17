import { create } from "zustand";

import type { PlatformModelRecord, ModelProviderRecord } from "../support";

type ModelsState = {
  modelProviders: ModelProviderRecord[];
  platformModels: PlatformModelRecord[];
  setModelProviders: (providers: ModelProviderRecord[]) => void;
  setPlatformModels: (models: PlatformModelRecord[]) => void;
};

export const useModelsStore = create<ModelsState>((set) => ({
  modelProviders: [],
  platformModels: [],
  setModelProviders: (modelProviders) => set({ modelProviders }),
  setPlatformModels: (platformModels) => set({ platformModels })
}));
