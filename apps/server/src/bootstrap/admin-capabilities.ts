import type { StorageAdmin } from "../storage-admin.js";

export interface EngineAdminCapabilities {
  storageAdmin: StorageAdmin;
  close(): Promise<void>;
}

export function createEngineAdminCapabilities(input: {
  storageAdmin: StorageAdmin;
}): EngineAdminCapabilities {
  return {
    storageAdmin: input.storageAdmin,
    close() {
      return input.storageAdmin.close();
    }
  };
}
