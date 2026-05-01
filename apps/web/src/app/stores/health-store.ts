import { create } from "zustand";

import type { HealthReportResponse, ReadinessReportResponse, SystemProfileResponse } from "../support";

type HealthState = {
  healthStatus: string;
  systemProfile: SystemProfileResponse | null;
  healthReport: HealthReportResponse | null;
  readinessReport: ReadinessReportResponse | null;
  setHealthStatus: (status: string) => void;
  setSystemProfile: (profile: SystemProfileResponse | null) => void;
  setHealthReport: (report: HealthReportResponse | null) => void;
  setReadinessReport: (report: ReadinessReportResponse | null) => void;
};

export const useHealthStore = create<HealthState>((set) => ({
  healthStatus: "idle",
  systemProfile: null,
  healthReport: null,
  readinessReport: null,
  setHealthStatus: (healthStatus) => set({ healthStatus }),
  setSystemProfile: (systemProfile) => set({ systemProfile }),
  setHealthReport: (healthReport) => set({ healthReport }),
  setReadinessReport: (readinessReport) => set({ readinessReport })
}));
