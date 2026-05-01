import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addModel, listModels, listRuntimes, listSkills, listTools, setDefaultModel } from "../apps/cli/src/daemon/assets.js";
import { initDaemonHome } from "../apps/cli/src/daemon/lifecycle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("OAP daemon asset helpers", () => {
  it("adds, lists, and selects a daemon model", async () => {
    const home = await createTempDir("oah-assets-home-");
    const sourceDir = await createTempDir("oah-assets-source-");
    const modelPath = path.join(sourceDir, "local-openai.yaml");
    await writeFile(
      modelPath,
      [
        "local-openai:",
        "  provider: openai",
        "  name: gpt-4o-mini",
        "  metadata:",
        "    context_window_tokens: 128000",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(addModel(modelPath, { home })).resolves.toContain("local-openai");
    await expect(listModels({ home })).resolves.toContain("local-openai");
    await expect(setDefaultModel("local-openai", { home })).resolves.toContain("local-openai");

    const config = await readFile(path.join(home, "config", "daemon.yaml"), "utf8");
    expect(config).toContain('default_model: "local-openai"');
    await expect(listModels({ home })).resolves.toContain("local-openai (default)");
  });

  it("rejects invalid model YAML before copying it into OAH_HOME", async () => {
    const home = await createTempDir("oah-assets-invalid-home-");
    const sourceDir = await createTempDir("oah-assets-invalid-source-");
    const modelPath = path.join(sourceDir, "broken.yaml");
    await writeFile(
      modelPath,
      [
        "broken:",
        "  provider: made-up-provider",
        "  name: gpt-test",
        ""
      ].join("\n"),
      "utf8"
    );

    await initDaemonHome({ home });
    await expect(addModel(modelPath, { home })).rejects.toThrow(/Invalid model config/u);
    await expect(listModels({ home })).resolves.not.toContain("broken");
  });

  it("lists bundled runtime templates from OAH_HOME", async () => {
    const home = await createTempDir("oah-assets-runtimes-");

    await expect(listRuntimes({ home })).resolves.toBe(["micro-learning", "vibe-coding"].join("\n"));
  });

  it("lists platform tool and skill catalogs from OAH_HOME", async () => {
    const home = await createTempDir("oah-assets-catalog-");
    await initDaemonHome({ home });
    await writeFile(
      path.join(home, "tools", "settings.yaml"),
      [
        "docs-search:",
        "  command: node",
        "  expose:",
        "    tool_prefix: docs",
        "",
        "remote-index:",
        "  enabled: false",
        "  url: https://example.com/mcp",
        ""
      ].join("\n"),
      "utf8"
    );
    await mkdir(path.join(home, "skills", "summarize"), { recursive: true });
    await writeFile(
      path.join(home, "skills", "summarize", "SKILL.md"),
      [
        "---",
        "name: summarize",
        "description: Summarize long project notes.",
        "---",
        "Use this skill to summarize long project notes into short decisions.",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(listTools({ home })).resolves.toBe(["docs-search · stdio · docs", "remote-index · http · disabled"].join("\n"));
    await expect(listSkills({ home })).resolves.toBe("summarize · Summarize long project notes.");
  });
});
