import { describe, expect, it } from "vitest";

import {
  describeObjectStoragePolicy,
  objectStorageBacksManagedWorkspaces,
  resolveManagedWorkspaceExternalRef,
  resolveObjectStorageMirrorConfig,
  resolveMirroredObjectStoragePaths
} from "../apps/server/src/bootstrap/object-storage-policy.ts";

describe("object storage policy", () => {
  it("strips workspace from mirrored paths while keeping readonly prefixes", () => {
    expect(
      resolveMirroredObjectStoragePaths({
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        managed_paths: ["workspace", "runtime", "model", "tool", "skill"]
      })
    ).toEqual(["runtime", "model", "tool", "skill"]);
  });

  it("treats workspace as a managed backing-store opt-in", () => {
    expect(
      objectStorageBacksManagedWorkspaces({
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          managed_paths: ["workspace"]
        }
      })
    ).toBe(true);

    expect(
      objectStorageBacksManagedWorkspaces({
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          managed_paths: ["runtime", "model"]
        }
      })
    ).toBe(false);
  });

  it("prefers explicit workspace backing and mirror config when provided", () => {
    expect(
      resolveObjectStorageMirrorConfig({
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        workspace_backing_store: {
          enabled: true,
          key_prefix: "workspace-live"
        },
        mirrors: {
          paths: ["runtime", "tool"],
          sync_on_boot: false,
          sync_on_change: false,
          poll_interval_ms: 12_000,
          key_prefixes: {
            runtime: "bp",
            tool: "tools"
          }
        }
      })
    ).toMatchObject({
      managed_paths: ["runtime", "tool"],
      sync_on_boot: false,
      sync_on_change: false,
      poll_interval_ms: 12_000,
      key_prefixes: {
        runtime: "bp",
        model: "model",
        tool: "tools",
        skill: "skill"
      }
    });

    expect(
      objectStorageBacksManagedWorkspaces({
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          mirrors: {
            paths: ["model"]
          }
        }
      })
    ).toBe(false);

    expect(
      resolveMirroredObjectStoragePaths({
        provider: "s3",
        bucket: "test-bucket",
        region: "us-east-1",
        workspace_backing_store: {
          enabled: true
        }
      })
    ).toEqual([]);
  });

  it("infers workspace external refs only for managed workspace roots", () => {
    expect(
      resolveManagedWorkspaceExternalRef("/tmp/workspaces/demo", "project", {
        paths: {
          workspace_dir: "/tmp/workspaces"
        } as never,
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          managed_paths: ["workspace"],
          key_prefixes: {
            workspace: "workspace"
          }
        }
      })
    ).toBe("s3://test-bucket/workspace/demo");

    expect(
      resolveManagedWorkspaceExternalRef("/tmp/external/demo", "project", {
        paths: {
          workspace_dir: "/tmp/workspaces"
        } as never,
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          managed_paths: ["workspace"]
        }
      })
    ).toBeUndefined();

    expect(
      resolveManagedWorkspaceExternalRef("/tmp/workspaces/demo", "project", {
        paths: {
          workspace_dir: "/tmp/workspaces"
        } as never,
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          workspace_backing_store: {
            enabled: true,
            key_prefix: "workspace-live"
          },
          mirrors: {
            paths: ["model"]
          }
        }
      })
    ).toBe("s3://test-bucket/workspace-live/demo");
  });

  it("describes mirrored paths and workspace backing separately", () => {
    expect(
      describeObjectStoragePolicy({
        object_storage: {
          provider: "s3",
          bucket: "test-bucket",
          region: "us-east-1",
          managed_paths: ["workspace", "runtime", "tool"]
        }
      })
    ).toEqual({
      mirroredPaths: ["runtime", "tool"],
      workspaceBackingStoreEnabled: true
    });
  });
});
