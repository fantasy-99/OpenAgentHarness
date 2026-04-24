import type { PlatformModelRegistry } from "@oah/config";
import type { ModelGenerateResponse } from "@oah/api-contracts";
import type {
  EngineLogger,
  GenerateModelInput,
  ModelGateway,
  ModelStreamOptions,
  StreamedModelResponse
} from "../../../../packages/engine-core/src/types.js";

type RuntimeAiSdkModelGateway = ModelGateway & {
  clearModelCache?(modelNames?: string[]): void;
};

export interface LazyModelGatewayOptions {
  defaultModelName: string;
  models: PlatformModelRegistry;
  logger?: EngineLogger | undefined;
}

export class LazyModelGateway implements ModelGateway {
  readonly #options: LazyModelGatewayOptions;
  #gateway: RuntimeAiSdkModelGateway | undefined;
  #gatewayPromise: Promise<RuntimeAiSdkModelGateway> | undefined;

  constructor(options: LazyModelGatewayOptions) {
    this.#options = options;
  }

  clearModelCache(modelNames?: string[]): void {
    this.#gateway?.clearModelCache?.(modelNames);
  }

  async generate(input: GenerateModelInput, options?: { signal?: AbortSignal }): Promise<ModelGenerateResponse> {
    return (await this.#resolveGateway()).generate(input, options);
  }

  async stream(input: GenerateModelInput, options?: ModelStreamOptions): Promise<StreamedModelResponse> {
    return (await this.#resolveGateway()).stream(input, options);
  }

  async #resolveGateway(): Promise<RuntimeAiSdkModelGateway> {
    if (this.#gateway) {
      return this.#gateway;
    }

    this.#gatewayPromise ??= import("@oah/model-gateway").then(({ AiSdkModelGateway }) => {
      const gateway = new AiSdkModelGateway(this.#options) as RuntimeAiSdkModelGateway;
      this.#gateway = gateway;
      return gateway;
    });

    return this.#gatewayPromise;
  }
}
