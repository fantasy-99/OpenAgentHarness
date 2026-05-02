import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import { OAH_VERSION } from "./version.js";

export type ReleaseChannel = "latest" | "latest-prerelease";

export type ReleaseAsset = {
  platform: string;
  binaryName: string;
};

export type ReleaseInstallOptions = {
  home?: string | undefined;
  installRoot?: string | undefined;
  repo?: string | undefined;
  apiBaseUrl?: string | undefined;
  releaseBaseUrl?: string | undefined;
  version?: string | undefined;
  channel?: ReleaseChannel | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  verifyChecksum?: boolean | undefined;
};

export type RollbackOptions = {
  home?: string | undefined;
  installRoot?: string | undefined;
  version?: string | undefined;
};

export type InstallationInfoOptions = {
  home?: string | undefined;
  installRoot?: string | undefined;
};

type ReleasePaths = {
  installRoot: string;
  binDir: string;
  versionsDir: string;
  currentPath: string;
  binShimPath: string;
};

type GithubRelease = {
  tag_name?: string | undefined;
  prerelease?: boolean | undefined;
};

const DEFAULT_REPO = "fairyshine/OpenAgentHarness";

export function resolveInstallRoot(options: InstallationInfoOptions = {}): string {
  return path.resolve(
    options.installRoot ??
      process.env.OAH_INSTALL_ROOT ??
      options.home ??
      process.env.OAH_HOME ??
      path.join(homedir(), ".openagentharness")
  );
}

export function resolveReleasePaths(options: InstallationInfoOptions = {}): ReleasePaths {
  const installRoot = resolveInstallRoot(options);
  return {
    installRoot,
    binDir: path.join(installRoot, "bin"),
    versionsDir: path.join(installRoot, "versions"),
    currentPath: path.join(installRoot, "current"),
    binShimPath: path.join(installRoot, "bin", process.platform === "win32" ? "oah.cmd" : "oah")
  };
}

export function detectReleaseAsset(platform = process.platform, arch = process.arch): ReleaseAsset {
  const rawArch = String(arch);
  const normalizedArch = rawArch === "x64" || rawArch === "amd64" ? "x86_64" : rawArch === "arm64" || rawArch === "aarch64" ? "aarch64" : rawArch;
  if (platform === "darwin" && (normalizedArch === "x86_64" || normalizedArch === "aarch64")) {
    return { platform: `macos-${normalizedArch}`, binaryName: "oah" };
  }
  if (platform === "linux" && (normalizedArch === "x86_64" || normalizedArch === "aarch64")) {
    return { platform: `linux-${normalizedArch}`, binaryName: "oah" };
  }
  if (platform === "win32" && (normalizedArch === "x86_64" || normalizedArch === "aarch64")) {
    return { platform: `windows-${normalizedArch}`, binaryName: "oah.cmd" };
  }
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

export async function describeInstallation(options: InstallationInfoOptions = {}): Promise<string> {
  const paths = resolveReleasePaths(options);
  const currentVersion = await readCurrentVersion(paths).catch(() => undefined);
  const installedVersions = await listInstalledVersions(paths);
  return [
    `OpenAgentHarness ${OAH_VERSION}`,
    `Install root: ${paths.installRoot}`,
    `Current release: ${currentVersion ?? "unmanaged"}`,
    `Installed releases: ${installedVersions.length > 0 ? installedVersions.join(", ") : "none"}`
  ].join("\n");
}

export async function updateInstallation(options: ReleaseInstallOptions = {}): Promise<string> {
  const paths = resolveReleasePaths(options);
  const asset = detectReleaseAsset();
  const repo = options.repo ?? process.env.OAH_UPDATE_REPO ?? DEFAULT_REPO;
  const releaseBaseUrl = options.releaseBaseUrl ?? process.env.OAH_RELEASE_BASE_URL ?? `https://github.com/${repo}/releases/download`;
  const tag = normalizeTag(options.version ?? process.env.OAH_UPDATE_VERSION ?? (await resolveReleaseTag({ ...options, repo })));
  const version = tag.replace(/^v/u, "");
  const archiveName = `oah-v${version}-${asset.platform}.tar.gz`;
  const archiveUrl = `${releaseBaseUrl.replace(/\/+$/u, "")}/${tag}/${archiveName}`;
  const checksumUrl = `${archiveUrl}.sha256`;
  const targetPath = path.join(paths.versionsDir, version);

  if (options.dryRun) {
    return [
      `Would install OpenAgentHarness ${tag} for ${asset.platform}.`,
      `Archive: ${archiveUrl}`,
      `Install root: ${paths.installRoot}`,
      `Target: ${targetPath}`,
      `Current symlink: ${paths.currentPath}`
    ].join("\n");
  }

  if ((await pathExists(targetPath)) && !options.force) {
    await switchCurrentVersion(paths, version);
    return `OpenAgentHarness ${version} is already installed. Current release now points to ${targetPath}.`;
  }

  await mkdir(paths.versionsDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(tmpdir(), "oah-update-"));
  try {
    const archivePath = path.join(tempDir, archiveName);
    await downloadFile(archiveUrl, archivePath);
    if (options.verifyChecksum !== false) {
      const checksumPath = path.join(tempDir, `${archiveName}.sha256`);
      await downloadFile(checksumUrl, checksumPath);
      await verifyChecksum(archivePath, checksumPath);
    }

    const extractedRoot = path.join(tempDir, "package");
    await mkdir(extractedRoot, { recursive: true });
    await runCommand("tar", ["-xzf", archivePath, "-C", extractedRoot]);
    const packageRoot = await resolveExtractedPackageRoot(extractedRoot);
    const stagedTarget = path.join(paths.versionsDir, `.${version}.${process.pid}.tmp`);
    await rm(stagedTarget, { recursive: true, force: true });
    await cp(packageRoot, stagedTarget, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    if (await pathExists(targetPath)) {
      if (!options.force) {
        await rm(stagedTarget, { recursive: true, force: true });
      } else {
        await rm(targetPath, { recursive: true, force: true });
        await renamePath(stagedTarget, targetPath);
      }
    } else {
      await renamePath(stagedTarget, targetPath);
    }
    await switchCurrentVersion(paths, version);
    return [
      `Installed OpenAgentHarness ${version} from ${archiveName}.`,
      `Current release: ${targetPath}`,
      `Command shim: ${paths.binShimPath}`
    ].join("\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function rollbackInstallation(options: RollbackOptions = {}): Promise<string> {
  const paths = resolveReleasePaths(options);
  const versions = await listInstalledVersions(paths);
  if (versions.length === 0) {
    return `No installed releases found under ${paths.versionsDir}.`;
  }

  const current = await readCurrentVersion(paths).catch(() => undefined);
  const target = options.version ?? versions.filter((version) => version !== current).at(-1);
  if (!target) {
    return `No rollback target found. Current release is ${current ?? "unmanaged"}.`;
  }
  if (!versions.includes(target)) {
    throw new Error(`Release ${target} is not installed under ${paths.versionsDir}.`);
  }

  await switchCurrentVersion(paths, target);
  return `Current release now points to OpenAgentHarness ${target}.`;
}

async function resolveReleaseTag(options: ReleaseInstallOptions & { repo: string }): Promise<string> {
  const channel = options.channel ?? (process.env.OAH_UPDATE_CHANNEL as ReleaseChannel | undefined) ?? "latest-prerelease";
  if (channel !== "latest" && channel !== "latest-prerelease") {
    throw new Error(`Unsupported release channel: ${channel}. Use latest or latest-prerelease.`);
  }
  const apiBaseUrl = options.apiBaseUrl ?? process.env.OAH_RELEASE_API_BASE_URL ?? `https://api.github.com/repos/${options.repo}`;
  if (channel === "latest") {
    const release = await fetchJson<GithubRelease>(`${apiBaseUrl.replace(/\/+$/u, "")}/releases/latest`);
    if (!release.tag_name) {
      throw new Error("Latest release response did not include tag_name.");
    }
    return release.tag_name;
  }

  const releases = await fetchJson<GithubRelease[]>(`${apiBaseUrl.replace(/\/+$/u, "")}/releases`);
  const release = releases.find((entry) => entry.tag_name);
  if (!release?.tag_name) {
    throw new Error("No GitHub releases found.");
  }
  return release.tag_name;
}

function normalizeTag(versionOrTag: string): string {
  return versionOrTag.startsWith("v") ? versionOrTag : `v${versionOrTag}`;
}

async function switchCurrentVersion(paths: ReleasePaths, version: string): Promise<void> {
  const targetPath = path.join(paths.versionsDir, version);
  if (!(await pathExists(targetPath))) {
    throw new Error(`Release ${version} is not installed at ${targetPath}.`);
  }
  await mkdir(paths.binDir, { recursive: true });
  await writeRootShim(paths);

  const tempLink = `${paths.currentPath}.${process.pid}.tmp`;
  await rm(tempLink, { recursive: true, force: true });
  await symlink(path.join("versions", version), tempLink, "dir");
  await renamePath(tempLink, paths.currentPath, { replace: true });
}

async function writeRootShim(paths: ReleasePaths): Promise<void> {
  if (process.platform === "win32") {
    await writeFile(
      paths.binShimPath,
      [
        "@echo off",
        "setlocal",
        "set OAH_ROOT=%~dp0..",
        "if not defined OAH_INSTALL_ROOT set OAH_INSTALL_ROOT=%OAH_ROOT%",
        "\"%OAH_ROOT%\\current\\bin\\oah.cmd\" %*",
        ""
      ].join("\r\n"),
      "utf8"
    );
    return;
  }

  await writeFile(
    paths.binShimPath,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      "ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\"",
      "export OAH_INSTALL_ROOT=\"${OAH_INSTALL_ROOT:-$ROOT}\"",
      "exec \"$ROOT/current/bin/oah\" \"$@\"",
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(paths.binShimPath, 0o755);
}

async function readCurrentVersion(paths: ReleasePaths): Promise<string | undefined> {
  const current = await lstat(paths.currentPath).catch(() => undefined);
  if (!current) {
    return undefined;
  }
  if (current.isSymbolicLink()) {
    const linkTarget = await readFileSymlink(paths.currentPath);
    return path.basename(linkTarget);
  }
  return path.basename(paths.currentPath);
}

async function readFileSymlink(filePath: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  return readlink(filePath);
}

async function listInstalledVersions(paths: ReleasePaths): Promise<string[]> {
  const entries = await readdir(paths.versionsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(compareVersionsLoosely);
}

function compareVersionsLoosely(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function resolveExtractedPackageRoot(extractedRoot: string): Promise<string> {
  if (await pathExists(path.join(extractedRoot, "bin", "oah"))) {
    return extractedRoot;
  }
  if (await pathExists(path.join(extractedRoot, "bin", "oah.cmd"))) {
    return extractedRoot;
  }
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    const [directory] = directories;
    if (!directory) {
      throw new Error("Release archive did not contain bin/oah.");
    }
    const child = path.join(extractedRoot, directory.name);
    if ((await pathExists(path.join(child, "bin", "oah"))) || (await pathExists(path.join(child, "bin", "oah.cmd")))) {
      return child;
    }
  }
  throw new Error("Release archive did not contain bin/oah.");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenAgentHarness updater",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenAgentHarness updater",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(targetPath));
}

async function verifyChecksum(archivePath: string, checksumPath: string): Promise<void> {
  const expected = (await readFile(checksumPath, "utf8")).trim().split(/\s+/u)[0]?.toLowerCase();
  if (!expected) {
    throw new Error(`Checksum file is empty: ${checksumPath}`);
  }
  const hash = createHash("sha256");
  const content = await readFile(archivePath);
  hash.update(content);
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${path.basename(archivePath)}: expected ${expected}, got ${actual}`);
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

async function renamePath(source: string, target: string, options: { replace?: boolean } = {}): Promise<void> {
  const { rename } = await import("node:fs/promises");
  try {
    await rename(source, target);
  } catch (error) {
    if (!options.replace) {
      throw error;
    }
    await rm(target, { recursive: true, force: true });
    await rename(source, target);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return lstat(filePath).then(
    () => true,
    () => false
  );
}
