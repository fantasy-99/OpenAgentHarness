import { loadModelRegistryFromDirectory } from "./shared.js";
import type { PlatformModelRegistry } from "./types.js";

export async function loadPlatformModels(
  modelsDir: string,
  options?: { onError?: ((input: { filePath: string; error: unknown }) => void) | undefined }
): Promise<PlatformModelRegistry> {
  return loadModelRegistryFromDirectory(modelsDir, options);
}
