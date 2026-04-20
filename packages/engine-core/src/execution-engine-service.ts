import type { EngineService } from "./engine-service.js";

type ExecutionRuntimeKernel = Pick<
  EngineService,
  "processQueuedRun" | "getRun" | "recoverRunAfterDrainTimeout" | "recoverStaleRuns"
>;

export interface ExecutionRuntimeOperations extends ExecutionRuntimeKernel {}

export class ExecutionEngineService implements ExecutionRuntimeOperations {
  readonly processQueuedRun: EngineService["processQueuedRun"];
  readonly getRun: EngineService["getRun"];
  readonly recoverRunAfterDrainTimeout: EngineService["recoverRunAfterDrainTimeout"];
  readonly recoverStaleRuns: EngineService["recoverStaleRuns"];

  constructor(kernel: ExecutionRuntimeKernel) {
    this.processQueuedRun = kernel.processQueuedRun.bind(kernel);
    this.getRun = kernel.getRun.bind(kernel);
    this.recoverRunAfterDrainTimeout = kernel.recoverRunAfterDrainTimeout.bind(kernel);
    this.recoverStaleRuns = kernel.recoverStaleRuns.bind(kernel);
  }
}
