import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addModel,
  enableSkill,
  enableTool,
  listModels,
  listRuntimes,
  listSkills,
  listTools,
  setDefaultModel
} from "../apps/cli/src/daemon/assets.js";
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

  it("enables a platform tool into a workspace", async () => {
    const home = await createTempDir("oah-assets-tool-home-");
    const workspace = await createTempDir("oah-assets-tool-workspace-");
    await initDaemonHome({ home });

    const sourceServerDir = path.join(home, "tools", "servers", "docs-search");
    await mkdir(sourceServerDir, { recursive: true });
    await writeFile(path.join(sourceServerDir, "index.js"), "console.log('docs');\n", "utf8");
    await writeFile(
      path.join(home, "tools", "settings.yaml"),
      [
        "docs-search:",
        `  command: node ${path.join(sourceServerDir, "index.js")}`,
        "  environment:",
        "    DOCS_ROOT: ./docs",
        "  expose:",
        "    tool_prefix: docs",
        "",
        "remote-index:",
        "  url: https://example.com/mcp",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(enableTool("docs-search", { home, workspace })).resolves.toContain("Enabled tool docs-search");

    const workspaceSettings = await readFile(path.join(workspace, ".openharness", "tools", "settings.yaml"), "utf8");
    expect(workspaceSettings).toContain("docs-search:");
    expect(workspaceSettings).toContain("command: node ./.openharness/tools/servers/docs-search/index.js");
    expect(workspaceSettings).toContain("tool_prefix: docs");
    expect(await readFile(path.join(workspace, ".openharness", "tools", "servers", "docs-search", "index.js"), "utf8")).toContain(
      "docs"
    );

    await expect(enableTool("docs-search", { home, workspace })).rejects.toThrow(/already enabled/u);
    await expect(enableTool("docs-search", { home, workspace, overwrite: true })).resolves.toContain("Enabled tool docs-search");
  });

  it("previews a platform tool enable without writing workspace files", async () => {
    const home = await createTempDir("oah-assets-tool-dry-home-");
    const workspace = await createTempDir("oah-assets-tool-dry-workspace-");
    await initDaemonHome({ home });
    await writeFile(
      path.join(home, "tools", "settings.yaml"),
      [
        "remote-index:",
        "  url: https://example.com/mcp",
        ""
      ].join("\n"),
      "utf8"
    );

    await expect(enableTool("remote-index", { home, workspace, dryRun: true })).resolves.toContain("Would enable tool remote-index");
    await expect(readFile(path.join(workspace, ".openharness", "tools", "settings.yaml"), "utf8")).rejects.toThrow();
  });

  it("enables a platform skill into a workspace", async () => {
    const home = await createTempDir("oah-assets-skill-home-");
    const workspace = await createTempDir("oah-assets-skill-workspace-");
    await initDaemonHome({ home });
    const sourceSkillDir = path.join(home, "skills", "summarize");
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(
      path.join(sourceSkillDir, "SKILL.md"),
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
    await writeFile(path.join(sourceSkillDir, "examples.md"), "# Examples\n", "utf8");

    await expect(enableSkill("summarize", { home, workspace })).resolves.toContain("Enabled skill summarize");

    const workspaceSkillPath = path.join(workspace, ".openharness", "skills", "summarize");
    await expect(readFile(path.join(workspaceSkillPath, "SKILL.md"), "utf8")).resolves.toContain("Summarize long project notes");
    await expect(readFile(path.join(workspaceSkillPath, "examples.md"), "utf8")).resolves.toContain("Examples");

    await expect(enableSkill("summarize", { home, workspace })).rejects.toThrow(/already enabled/u);
    await expect(enableSkill("summarize", { home, workspace, overwrite: true })).resolves.toContain("Enabled skill summarize");
  });
});
