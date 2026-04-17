import { create } from "zustand";

import type { HealthReportResponse, ReadinessReportResponse } from "../support";

type HealthState = {
  healthStatus: string;
  healthReport: HealthReportResponse | null;
  readinessReport: ReadinessReportResponse | null;
  setHealthStatus: (status: string) => void;
  setHealthReport: (report: HealthReportResponse | null) => void;
  setReadinessReport: (report: ReadinessReportResponse | null) => void;
};

export const useHealthStore = create<HealthState>((set) => ({
  healthStatus: "idle",
  healthReport: null,
  readinessReport: null,
  setHealthStatus: (healthStatus) => set({ healthStatus }),
  setHealthReport: (healthReport) => set({ healthReport }),
  setReadinessReport: (readinessReport) => set({ readinessReport })
}));
