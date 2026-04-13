import { describe, expect, it } from "vitest";

import type { RunStep } from "@oah/api-contracts";

import { RunStepService } from "../packages/runtime-core/src/runtime/run-steps.js";
import type { RunStepRepository } from "../packages/runtime-core/src/types.js";

describe("RunStepService", () => {
  it("serializes step creation per run so concurrent calls do not reuse the same seq", async () => {
    const persisted: RunStep[] = [];
    const repository: RunStepRepository = {
      async create(input) {
        persisted.push(input);
        return input;
      },
      async update(input) {
        const index = persisted.findIndex((step) => step.id === input.id);
        if (index >= 0) {
          persisted[index] = input;
        }
        return input;
      },
      async listByRunId(runId) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return persisted.filter((step) => step.runId === runId);
      }
    };

    let idCounter = 0;
    const service = new RunStepService({
      runStepRepository: repository,
      createId: (prefix) => `${prefix}_${++idCounter}`,
      nowIso: () => "2026-04-13T08:31:35.378Z"
    });

    const [first, second, third] = await Promise.all([
      service.startRunStep({ runId: "run-1", stepType: "tool_call", name: "Skill" }),
      service.startRunStep({ runId: "run-1", stepType: "tool_call", name: "Skill" }),
      service.startRunStep({ runId: "run-1", stepType: "model_call", name: "kimi-k25" })
    ]);

    expect([first.seq, second.seq, third.seq].sort((left, right) => left - right)).toEqual([
      1,
      2,
      3
    ]);
    expect(new Set(persisted.map((step) => `${step.runId}:${step.seq}`)).size).toBe(3);
  });
});
