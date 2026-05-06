import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createNativeToolSet } from "../packages/engine-core/src/native-tools.ts";
import { createLocalWorkspaceFileSystem } from "../packages/engine-core/src/workspace/workspace-file-system.ts";
import type { WorkspaceCommandExecutor, WorkspaceFileAccessProvider, WorkspaceFileSystem, WorkspaceRecord } from "../packages/engine-core/src/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    })
  );
});

describe("native tools", () => {
  it("uses workspace file access leases for file tools", async () => {
    const staleRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-stale-root-"));
    const liveRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-live-root-"));
    tempDirs.push(staleRoot, liveRoot);

    await writeFile(path.join(liveRoot, "spec.json"), "{\"ok\":true}\n", "utf8");

    const workspace = {
      id: "ws_file_lease",
      kind: "project",
      name: "file lease workspace",
      rootPath: staleRoot,
      readOnly: false,
      historyMirrorEnabled: false,
      settings: {},
      workspaceModels: {},
      agents: {},
      actions: {},
      skills: {},
      toolServers: {},
      hooks: {},
      catalog: {
        workspaceId: "ws_file_lease",
        agents: [],
        models: [],
        actions: [],
        skills: [],
        tools: [],
        hooks: [],
        nativeTools: []
      },
      executionPolicy: "local",
      status: "active",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } satisfies WorkspaceRecord;
    const acquire = vi.fn(async () => ({
      workspace: {
        ...workspace,
        rootPath: liveRoot
      },
      release: vi.fn()
    }));
    const workspaceFileAccessProvider = { acquire } satisfies WorkspaceFileAccessProvider;

    const tools = createNativeToolSet(staleRoot, () => ["Read", "Write"], {
      sessionId: "session-file-lease",
      workspace,
      workspaceFileAccessProvider
    });

    const readResult = String(await tools.Read.execute({ file_path: "spec.json" }, {}));
    expect(readResult).toContain("file_path: spec.json");
    expect(readResult).toContain("1: {\"ok\":true}");

    await tools.Write.execute({ file_path: "generated.txt", content: "from live lease\n" }, {});
    await expect(readFile(path.join(staleRoot, "generated.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(liveRoot, "generated.txt"), "utf8")).toBe("from live lease\n");
    expect(acquire).toHaveBeenCalledWith({ workspace, access: "read", path: "spec.json" });
    expect(acquire).toHaveBeenCalledWith({ workspace, access: "write", path: "generated.txt" });
  });

  it("executes Title Case workspace tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-title-case-"));
    tempDirs.push(workspaceRoot);

    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 41;\n", "utf8");

    const tools = createNativeToolSet(
      workspaceRoot,
      () => ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"],
      { sessionId: "session-title-case" }
    );

    const writeResult = await tools.Write.execute({
      file_path: "notes/summary.txt",
      content: "line one\nline two"
    }, {});
    expect(String(writeResult)).toContain("file_path: notes/summary.txt");
    expect(String(writeResult)).toContain("bytes_written:");

    const readResult = await tools.Read.execute({ file_path: "notes/summary.txt" }, {});
    expect(String(readResult)).toContain("file_path: notes/summary.txt");
    expect(String(readResult)).toContain("content:");
    expect(String(readResult)).toContain("1: line one");
    expect(String(readResult)).toContain("2: line two");

    await tools.Read.execute({ file_path: "src/app.ts" }, {});
    const editResult = await tools.Edit.execute(
      {
        file_path: "src/app.ts",
        old_string: "41",
        new_string: "42"
      },
      {}
    );
    expect(String(editResult)).toContain("file_path: src/app.ts");
    expect(String(editResult)).toContain("occurrences: 1");
    expect(await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8")).toContain("42");

    const globResult = await tools.Glob.execute({ pattern: "**/*.ts" }, {});
    expect(String(globResult)).toContain("files:");
    expect(String(globResult)).toContain("src/app.ts");

    const grepResult = await tools.Grep.execute({ pattern: "answer", path: "src", output_mode: "content" }, {});
    expect(String(grepResult)).toContain('src/app.ts:1:export const answer = 42;');

    const bashResult = await tools.Bash.execute({ command: "printf bash-ok" }, {});
    expect(String(bashResult)).toContain("exit_code: 0");
    expect(String(bashResult)).toContain("stdout:");
    expect(String(bashResult)).toContain("bash-ok");

    const todoResult = await tools.TodoWrite.execute(
      {
        todos: [
          { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
          { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" }
        ]
      },
      {}
    );
    expect(String(todoResult)).toContain("todo_path: .openharness/state/todos/session-title-case.json");
    expect(String(todoResult)).toContain("remaining: 1");
    expect(String(todoResult)).toContain("in_progress: Ship fix");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-title-case.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" }
    ]);
  });

  it("requires existing files to be read before Write or Edit", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-read-before-write-"));
    tempDirs.push(workspaceRoot);

    await writeFile(path.join(workspaceRoot, "existing.txt"), "hello\n", "utf8");

    const tools = createNativeToolSet(workspaceRoot, () => ["Read", "Write", "Edit"], {
      sessionId: "session-read-before-write"
    });

    await expect(
      tools.Write.execute(
        {
          file_path: "existing.txt",
          content: "updated\n"
        },
        {}
      )
    ).rejects.toThrow(/read first/i);

    await tools.Read.execute({ file_path: "existing.txt" }, {});

    await expect(
      tools.Write.execute(
        {
          file_path: "existing.txt",
          content: "updated\n"
        },
        {}
      )
    ).resolves.toContain("file_path: existing.txt");

    await expect(
      tools.Edit.execute(
        {
          file_path: "existing.txt",
          old_string: "updated",
          new_string: "done"
        },
        {}
      )
    ).resolves.toContain("file_path: existing.txt");
  });

  it("supports Bash run_in_background with a readable output file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "Read", "TaskOutput"], {
      sessionId: "session-background"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "printf background-ok",
          run_in_background: true,
          description: "Print background output"
        },
        {}
      )
    );

    expect(backgroundResult).toContain("started: true");
    const outputPathMatch = backgroundResult.match(/output_path: (.+)/);
    expect(outputPathMatch?.[1]).toBeTruthy();

    const outputPath = outputPathMatch?.[1] ?? "";
    let output = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      output = await readFile(path.join(workspaceRoot, outputPath), "utf8").catch(() => "");
      if (output.includes("background-ok")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(output).toContain("background-ok");

    const taskIdMatch = backgroundResult.match(/task_id: (.+)/);
    expect(taskIdMatch?.[1]).toBeTruthy();
    const taskOutput = String(await tools.TaskOutput.execute({ task_id: taskIdMatch?.[1] ?? "" }, {}));
    expect(taskOutput).toContain("status:");
    expect(taskOutput).toContain("output_path:");
    expect(taskOutput).toContain("background-ok");
  });

  it("can send input to a running Bash background task", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-input-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TaskInput", "TaskOutput", "TaskStop"], {
      sessionId: "session-background-input"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "cat",
          run_in_background: true,
          description: "Echo stdin"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/task_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    try {
      const inputResult = String(await tools.TaskInput.execute({ task_id: taskId, input: "hello-background-stdin" }, {}));
      expect(inputResult).toContain("input_written: true");

      let taskOutput = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        taskOutput = String(await tools.TaskOutput.execute({ task_id: taskId }, {}));
        if (taskOutput.includes("hello-background-stdin")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(taskOutput).toContain("input_writable: true");
      expect(taskOutput).toContain("hello-background-stdin");
    } finally {
      await tools.TaskStop.execute({ task_id: taskId }, {}).catch(() => undefined);
    }
  });

  it("runs Bash background tasks inside a PTY when available", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-pty-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TaskOutput"], {
      sessionId: "session-background-pty"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "if [ -t 0 ]; then printf tty-yes; else printf tty-no; fi",
          run_in_background: true,
          description: "Check terminal mode"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/task_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    let taskOutput = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      taskOutput = String(await tools.TaskOutput.execute({ task_id: taskId }, {}));
      if (taskOutput.includes("tty-yes") || taskOutput.includes("tty-no")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(taskOutput).toContain("terminal_kind: pty");
    expect(taskOutput).toContain("tty-yes");
  });

  it("can stop a Bash background task", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-background-stop-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "TaskOutput", "TaskStop"], {
      sessionId: "session-background-stop"
    });

    const backgroundResult = String(
      await tools.Bash.execute(
        {
          command: "while true; do printf tick; sleep 1; done",
          run_in_background: true,
          description: "Loop until stopped"
        },
        {}
      )
    );
    const taskId = backgroundResult.match(/task_id: (.+)/)?.[1] ?? "";
    expect(taskId).toBeTruthy();

    const stopResult = String(await tools.TaskStop.execute({ task_id: taskId }, {}));
    expect(stopResult).toContain("status: stopped");

    const taskOutput = String(await tools.TaskOutput.execute({ task_id: taskId }, {}));
    expect(taskOutput).toContain("status: stopped");
  });

  it("supports Bash persistent terminal sessions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-bash-"));
    tempDirs.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "subdir"), { recursive: true });

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-bash"
    });

    const exportResult = String(
      await tools.Bash.execute(
        {
          command: "export OAH_PERSISTENT_VALUE=kept",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(exportResult).toContain("persistent_session_id: shell-a");
    expect(exportResult).toContain("status: completed");

    const envResult = String(
      await tools.Bash.execute(
        {
          command: "printf \"$OAH_PERSISTENT_VALUE\"",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(envResult).toContain("kept");

    await tools.Bash.execute(
      {
        command: "cd subdir",
        persistent_session_id: "shell-a",
        timeout: 2_000
      },
      {}
    );
    const pwdResult = String(
      await tools.Bash.execute(
        {
          command: "pwd",
          persistent_session_id: "shell-a",
          timeout: 2_000
        },
        {}
      )
    );
    expect(pwdResult).toContain(path.join(workspaceRoot, "subdir"));

    const isolatedResult = String(
      await tools.Bash.execute(
        {
          command: "printf \"${OAH_PERSISTENT_VALUE:-missing}\"",
          persistent_session_id: "shell-b",
          timeout: 2_000
        },
        {}
      )
    );
    expect(isolatedResult).toContain("missing");

    await tools.Bash.execute({ persistent_session_id: "shell-a", close_persistent_session: true }, {});
    await tools.Bash.execute({ persistent_session_id: "shell-b", close_persistent_session: true }, {});
  });

  it("supports Bash persistent input mode for interactive processes", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-input-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-input"
    });

    const catStart = String(
      await tools.Bash.execute(
        {
          command: "cat",
          persistent_session_id: "interactive",
          persistent_mode: "input",
          timeout: 200
        },
        {}
      )
    );
    expect(catStart).toContain("persistent_session_id: interactive");

    const inputResult = String(
      await tools.Bash.execute(
        {
          command: "hello-through-stdin",
          persistent_session_id: "interactive",
          persistent_mode: "input",
          timeout: 200
        },
        {}
      )
    );
    expect(inputResult).toContain("hello-through-stdin");

    const closeResult = String(
      await tools.Bash.execute(
        {
          persistent_session_id: "interactive",
          close_persistent_session: true
        },
        {}
      )
    );
    expect(closeResult).toContain("persistent_session_id: interactive");
    expect(closeResult).toContain("status: exited");
  });

  it("rejects unsupported persistent Bash executors", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-persistent-unsupported-"));
    tempDirs.push(workspaceRoot);

    const commandExecutor: WorkspaceCommandExecutor = {
      runForeground: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      runProcess: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      runBackground: vi.fn(async () => ({ outputPath: "/tmp/task.log", taskId: "task-1", pid: 1 }))
    };
    const tools = createNativeToolSet(workspaceRoot, () => ["Bash"], {
      sessionId: "session-persistent-unsupported",
      commandExecutor
    });

    await expect(
      tools.Bash.execute(
        {
          command: "printf no",
          persistent_session_id: "unsupported"
        },
        {}
      )
    ).rejects.toThrow(/Persistent Bash terminals are not supported/);
  });

  it("routes Bash through the injected workspace command executor", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-command-executor-"));
    tempDirs.push(workspaceRoot);

    const commandExecutor: WorkspaceCommandExecutor = {
      runForeground: vi.fn(async () => ({
        stdout: "executor-ok",
        stderr: "",
        exitCode: 0
      })),
      runProcess: vi.fn(async () => ({
        stdout: `${path.join(workspaceRoot, "src", "app.ts")}:1:export const value = 1;`,
        stderr: "",
        exitCode: 0
      })),
      runBackground: vi.fn(async () => ({
        outputPath: path.join(workspaceRoot, ".openharness", "state", "background", "session-executor", "task.log"),
        taskId: "task-executor",
        pid: 1234
      })),
      getBackgroundTask: vi.fn(async () => null),
      stopBackgroundTask: vi.fn(async () => null),
      writeBackgroundTaskInput: vi.fn(async (input) => ({
        taskId: input.taskId,
        outputPath: ".openharness/state/background/session-executor/task.log",
        status: "running",
        pid: 1234,
        inputWritable: true
      })),
      runPersistentTerminal: vi.fn(async (input) => ({
        terminalId: input.terminalId,
        output: "persistent-ok",
        status: "completed",
        pid: 4321,
        exitCode: 0
      })),
      stopPersistentTerminal: vi.fn(async (input) => ({
        terminalId: input.terminalId,
        output: "closed-ok",
        status: "exited",
        pid: 4321,
        exitCode: 0
      }))
    };

    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");

    const tools = createNativeToolSet(workspaceRoot, () => ["Bash", "Grep", "TaskInput"], {
      sessionId: "session-executor",
      commandExecutor
    });

    const foreground = String(await tools.Bash.execute({ command: "printf ignored" }, {}));
    expect(foreground).toContain("executor-ok");
    expect(commandExecutor.runForeground).toHaveBeenCalledTimes(1);

    const background = String(
      await tools.Bash.execute({ command: "printf ignored", run_in_background: true }, {})
    );
    expect(background).toContain("task_id: task-executor");
    expect(commandExecutor.runBackground).toHaveBeenCalledTimes(1);

    const taskInput = String(await tools.TaskInput.execute({ task_id: "task-executor", input: "ignored" }, {}));
    expect(taskInput).toContain("input_written: true");
    expect(commandExecutor.writeBackgroundTaskInput).toHaveBeenCalledTimes(1);
    expect(commandExecutor.writeBackgroundTaskInput).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-executor",
        sessionId: "session-executor",
        inputText: "ignored"
      })
    );

    const persistent = String(
      await tools.Bash.execute({ command: "printf ignored", persistent_session_id: "executor-shell" }, {})
    );
    expect(persistent).toContain("persistent-ok");
    expect(commandExecutor.runPersistentTerminal).toHaveBeenCalledTimes(1);
    expect(commandExecutor.runPersistentTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalId: "executor-shell",
        sessionId: "session-executor",
        command: "printf ignored",
        mode: "command"
      })
    );
    const closePersistent = String(
      await tools.Bash.execute({ persistent_session_id: "executor-shell", close_persistent_session: true }, {})
    );
    expect(closePersistent).toContain("closed-ok");
    expect(commandExecutor.stopPersistentTerminal).toHaveBeenCalledTimes(1);

    const grep = String(await tools.Grep.execute({ pattern: "value", path: "src", output_mode: "content" }, {}));
    expect(grep).toContain("src/app.ts:1:export const value = 1;");
    expect(commandExecutor.runProcess).toHaveBeenCalledTimes(1);
    expect(commandExecutor.runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "rg",
        args: expect.arrayContaining(["value", "src"]),
        cwd: workspaceRoot
      })
    );
    expect(commandExecutor.runProcess).not.toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([path.join(workspaceRoot, "src")])
      })
    );
  });

  it("routes native tool file access through the injected workspace file system", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-filesystem-"));
    tempDirs.push(workspaceRoot);

    const localFileSystem = createLocalWorkspaceFileSystem();
    const statCalls: string[] = [];
    const readCalls: string[] = [];
    const readdirCalls: string[] = [];
    const writeCalls: string[] = [];
    const fileSystem: WorkspaceFileSystem = {
      ...localFileSystem,
      async stat(targetPath) {
        statCalls.push(targetPath);
        return localFileSystem.stat(targetPath);
      },
      async readFile(targetPath) {
        readCalls.push(targetPath);
        return localFileSystem.readFile(targetPath);
      },
      async readdir(targetPath) {
        readdirCalls.push(targetPath);
        return localFileSystem.readdir(targetPath);
      },
      async writeFile(targetPath, data) {
        writeCalls.push(targetPath);
        await localFileSystem.writeFile(targetPath, data);
      }
    };

    const tools = createNativeToolSet(workspaceRoot, () => ["Read", "Write", "Edit", "TodoWrite", "Glob"], {
      sessionId: "session-fs",
      fileSystem
    });

    await tools.Write.execute({ file_path: "notes.txt", content: "one\n" }, {});
    await tools.Read.execute({ file_path: "notes.txt" }, {});
    await tools.Edit.execute(
      { file_path: "notes.txt", old_string: "one", new_string: "two" },
      {}
    );
    await tools.Glob.execute({ pattern: "**/*.txt" }, {});
    await tools.TodoWrite.execute(
      {
        todos: [{ content: "Ship", activeForm: "Shipping", status: "in_progress" }]
      },
      {}
    );

    expect(writeCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(writeCalls).toContain(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-fs.json")
    );
    expect(readCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(statCalls).toContain(path.join(workspaceRoot, "notes.txt"));
    expect(readdirCalls).toContain(workspaceRoot);
    expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("two\n");
  });

  it("accepts todos when no item is marked in progress", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-todo-no-progress-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["TodoWrite"], {
      sessionId: "session-todo-no-progress"
    });

    const result = String(
      await tools.TodoWrite.execute(
        {
          todos: [
            { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
            { content: "Ship fix", activeForm: "Shipping fix", status: "pending" },
            { content: "Write tests", activeForm: "Writing tests", status: "pending" }
          ]
        },
        {}
      )
    );

    expect(result).toContain("remaining: 2");
    expect(result).toContain("pending: Ship fix");
    expect(result).toContain("pending: Write tests");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-todo-no-progress.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "completed" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "pending" },
      { content: "Write tests", activeForm: "Writing tests", status: "pending" }
    ]);
  });

  it("accepts multiple in-progress todos without failing", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-todo-multi-progress-"));
    tempDirs.push(workspaceRoot);

    const tools = createNativeToolSet(workspaceRoot, () => ["TodoWrite"], {
      sessionId: "session-todo-multi-progress"
    });

    const result = String(
      await tools.TodoWrite.execute(
        {
          todos: [
            { content: "Inspect files", activeForm: "Inspecting files", status: "in_progress" },
            { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" },
            { content: "Write tests", activeForm: "Writing tests", status: "pending" }
          ]
        },
        {}
      )
    );

    expect(result).toContain("remaining: 3");
    expect(result).toContain("in_progress: Inspect files");
    expect(result).toContain("in_progress: Ship fix");
    expect(result).toContain("pending: Write tests");

    const todoFile = await readFile(
      path.join(workspaceRoot, ".openharness", "state", "todos", "session-todo-multi-progress.json"),
      "utf8"
    );
    expect(JSON.parse(todoFile)).toEqual([
      { content: "Inspect files", activeForm: "Inspecting files", status: "in_progress" },
      { content: "Ship fix", activeForm: "Shipping fix", status: "in_progress" },
      { content: "Write tests", activeForm: "Writing tests", status: "pending" }
    ]);
  });

  it("fetches and searches the web with Title Case tools", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "oah-native-tools-web-"));
    tempDirs.push(workspaceRoot);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html><body><h1>Demo Page</h1><p>Hello web fetch.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        })
      );

    const tools = createNativeToolSet(workspaceRoot, () => ["WebFetch"]);

    const fetchResult = await tools.WebFetch.execute(
      {
        url: "https://example.com/page",
        prompt: "Summarize the page"
      },
      {}
    );
    expect(String(fetchResult)).toContain("url: https://example.com/page");
    expect(String(fetchResult)).toContain("status_code: 200");
    expect(String(fetchResult)).toContain("result:");
    expect(String(fetchResult)).toContain("Prompt execution fallback:");
    expect(String(fetchResult)).toContain("Summarize the page");
    expect(String(fetchResult)).toContain("Demo Page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
