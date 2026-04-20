import { AppError } from "../errors.js";
import type { ModelDefinition, WorkspaceRecord } from "../types.js";

export interface ResolvedRunModel {
  model: string;
  canonicalModelRef: string;
  provider?: string | undefined;
  modelDefinition?: ModelDefinition | undefined;
}

export interface ModelResolverServiceDependencies {
  defaultModel: string;
  platformModels: Record<string, ModelDefinition>;
}

export class ModelResolverService {
  readonly #defaultModel: string;
  readonly #platformModels: Record<string, ModelDefinition>;

  constructor(dependencies: ModelResolverServiceDependencies) {
    this.#defaultModel = dependencies.defaultModel;
    this.#platformModels = dependencies.platformModels;
  }

  resolveModelForRun(workspace: WorkspaceRecord, modelRef?: string | undefined): ResolvedRunModel {
    if (!modelRef || modelRef.length === 0) {
      const defaultPlatformModel = this.#platformModels[this.#defaultModel];
      return {
        model: this.#defaultModel,
        canonicalModelRef: `platform/${this.#defaultModel}`,
        ...(defaultPlatformModel ? { provider: defaultPlatformModel.provider, modelDefinition: defaultPlatformModel } : {})
      };
    }

    if (modelRef.startsWith("platform/")) {
      const platformModelName = modelRef.slice("platform/".length);
      const platformModel = this.#platformModels[platformModelName];
      return {
        model: platformModelName,
        canonicalModelRef: modelRef,
        ...(platformModel ? { provider: platformModel.provider, modelDefinition: platformModel } : {})
      };
    }

    if (modelRef.startsWith("workspace/")) {
      const workspaceModelName = modelRef.slice("workspace/".length);
      const workspaceModel = workspace.workspaceModels[workspaceModelName];
      if (!workspaceModel) {
        throw new AppError(
          404,
          "model_not_found",
          `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`
        );
      }

      return {
        model: modelRef,
        canonicalModelRef: modelRef,
        provider: workspaceModel.provider,
        modelDefinition: workspaceModel
      };
    }

    if (workspace.workspaceModels[modelRef]) {
      return {
        model: `workspace/${modelRef}`,
        canonicalModelRef: `workspace/${modelRef}`,
        provider: workspace.workspaceModels[modelRef].provider,
        modelDefinition: workspace.workspaceModels[modelRef]
      };
    }

    if (this.#platformModels[modelRef]) {
      return {
        model: modelRef,
        canonicalModelRef: `platform/${modelRef}`,
        provider: this.#platformModels[modelRef].provider,
        modelDefinition: this.#platformModels[modelRef]
      };
    }

    return {
      model: modelRef,
      canonicalModelRef: modelRef
    };
  }

  normalizeSessionModelRef(workspace: WorkspaceRecord, modelRef?: string): string | undefined {
    const candidate = modelRef?.trim();
    if (!candidate) {
      return undefined;
    }

    if (candidate.startsWith("platform/")) {
      const platformModelName = candidate.slice("platform/".length);
      if (!this.#platformModels[platformModelName]) {
        throw new AppError(404, "model_not_found", `Platform model ${platformModelName} was not found.`);
      }

      return candidate;
    }

    if (candidate.startsWith("workspace/")) {
      const workspaceModelName = candidate.slice("workspace/".length);
      if (!workspace.workspaceModels[workspaceModelName]) {
        throw new AppError(
          404,
          "model_not_found",
          `Workspace model ${workspaceModelName} was not found in workspace ${workspace.id}.`
        );
      }

      return candidate;
    }

    if (workspace.workspaceModels[candidate]) {
      return `workspace/${candidate}`;
    }

    if (this.#platformModels[candidate]) {
      return `platform/${candidate}`;
    }

    throw new AppError(404, "model_not_found", `Model ${candidate} was not found in workspace ${workspace.id}.`);
  }
}
