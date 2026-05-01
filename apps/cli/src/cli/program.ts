import { Command } from "commander";

type GlobalOptions = {
  baseUrl?: string;
  token?: string;
  home?: string;
};

type DaemonGlobalOptions = {
  home?: string;
};

type TuiOptions = {
  workspace?: string;
  runtime?: string;
  autoStart?: boolean;
  home?: string;
};

export function resolveConnection(options: GlobalOptions) {
  return {
    baseUrl: options.baseUrl ?? process.env.OAH_BASE_URL ?? "http://127.0.0.1:8787",
    token: options.token ?? process.env.OAH_TOKEN ?? ""
  };
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("oah")
    .description("OpenAgentHarness terminal client")
    .version("0.1.0")
    .option("--base-url <url>", "OpenAgentHarness server URL", process.env.OAH_BASE_URL)
    .option("--token <token>", "Bearer token for API requests", process.env.OAH_TOKEN)
    .option("--home <path>", "OAH home directory for local daemon defaults", process.env.OAH_HOME);

  const daemon = program.command("daemon").description("Manage the local OAP daemon").option("--home <path>", "OAH home directory");

  daemon
    .command("init")
    .description("Initialize OAH_HOME for the local OAP daemon")
    .action(async (_options: unknown, command: Command) => {
      const { initDaemonHome } = await import("../daemon/lifecycle.js");
      const paths = await initDaemonHome(resolveGroupedHomeOptions(command, daemon, program));
      console.log(`Initialized OAH_HOME at ${paths.home}`);
      console.log(`Daemon config: ${paths.configPath}`);
    });

  daemon
    .command("start")
    .description("Start the local OAP daemon")
    .option("--timeout-ms <ms>", "Startup health check timeout", parseIntegerOption)
    .action(async (options: { timeoutMs?: number }, command: Command) => {
      const { startDaemon } = await import("../daemon/lifecycle.js");
      console.log(await startDaemon({ ...resolveGroupedHomeOptions(command, daemon, program), ...options }));
    });

  daemon
    .command("status")
    .description("Show local OAP daemon status")
    .action(async (_options: unknown, command: Command) => {
      const { daemonStatus } = await import("../daemon/lifecycle.js");
      console.log(await daemonStatus(resolveGroupedHomeOptions(command, daemon, program)));
    });

  daemon
    .command("stop")
    .description("Stop the local OAP daemon")
    .action(async (_options: unknown, command: Command) => {
      const { stopDaemon } = await import("../daemon/lifecycle.js");
      console.log(await stopDaemon(resolveGroupedHomeOptions(command, daemon, program)));
    });

  daemon
    .command("restart")
    .description("Restart the local OAP daemon")
    .option("--timeout-ms <ms>", "Startup health check timeout", parseIntegerOption)
    .action(async (options: { timeoutMs?: number }, command: Command) => {
      const { restartDaemon } = await import("../daemon/lifecycle.js");
      console.log(await restartDaemon({ ...resolveGroupedHomeOptions(command, daemon, program), ...options }));
    });

  daemon
    .command("logs")
    .description("Show local OAP daemon logs")
    .option("-n, --lines <count>", "Number of lines to print", parseIntegerOption)
    .option("-f, --follow", "Follow daemon log output")
    .action(async (options: { lines?: number; follow?: boolean }, command: Command) => {
      const { followDaemonLogs, readDaemonLogs } = await import("../daemon/lifecycle.js");
      const input = { ...resolveGroupedHomeOptions(command, daemon, program), ...options };
      if (options.follow) {
        followDaemonLogs(input);
        return;
      }
      console.log(await readDaemonLogs(input));
    });

  const models = program.command("models").description("Manage OAP platform models").option("--home <path>", "OAH home directory");

  models
    .command("list")
    .description("List OAP platform models")
    .action(async (_options: unknown, command: Command) => {
      const { listModels } = await import("../daemon/assets.js");
      console.log(await listModels(resolveGroupedHomeOptions(command, models, program)));
    });

  models
    .command("add")
    .description("Add a model YAML file to OAH_HOME/models")
    .argument("<file>", "Model YAML file")
    .option("--overwrite", "Overwrite an existing model file or model id")
    .action(async (file: string, options: { overwrite?: boolean }, command: Command) => {
      const { addModel } = await import("../daemon/assets.js");
      console.log(await addModel(file, { ...resolveGroupedHomeOptions(command, models, program), ...options }));
    });

  models
    .command("default")
    .description("Set the default OAP model")
    .argument("<model>", "Model id")
    .action(async (model: string, _options: unknown, command: Command) => {
      const { setDefaultModel } = await import("../daemon/assets.js");
      console.log(await setDefaultModel(model, resolveGroupedHomeOptions(command, models, program)));
    });

  const runtimes = program.command("runtimes").description("Manage OAP workspace runtimes").option("--home <path>", "OAH home directory");

  runtimes
    .command("list")
    .description("List OAP workspace runtimes")
    .action(async (_options: unknown, command: Command) => {
      const { listRuntimes } = await import("../daemon/assets.js");
      console.log(await listRuntimes(resolveGroupedHomeOptions(command, runtimes, program)));
    });

  const tools = program.command("tools").description("Manage OAP platform tool catalog").option("--home <path>", "OAH home directory");

  tools
    .command("list")
    .description("List OAP platform tools")
    .action(async (_options: unknown, command: Command) => {
      const { listTools } = await import("../daemon/assets.js");
      console.log(await listTools(resolveGroupedHomeOptions(command, tools, program)));
    });

  const skills = program.command("skills").description("Manage OAP platform skill catalog").option("--home <path>", "OAH home directory");

  skills
    .command("list")
    .description("List OAP platform skills")
    .action(async (_options: unknown, command: Command) => {
      const { listSkills } = await import("../daemon/assets.js");
      console.log(await listSkills(resolveGroupedHomeOptions(command, skills, program)));
    });

  program
    .command("web")
    .description("Start the WebUI against an OAH-compatible API")
    .option("--host <host>", "WebUI dev server host", "127.0.0.1")
    .option("--port <port>", "WebUI dev server port", parseIntegerOption, 5173)
    .option("--open", "Open the browser after the WebUI starts")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (options: { host: string; port: number; open?: boolean; autoStart?: boolean }) => {
      const { launchWebUi } = await import("../web/dev-server.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {
        autoStartLocalDaemon: options.autoStart !== false,
        announceAutoStart: true
      });
      await launchWebUi({
        connection,
        host: options.host,
        port: options.port,
        open: Boolean(options.open)
      });
    });

  program
    .command("tui")
    .description("Open the interactive TUI")
    .option("--workspace <path>", "Register and open a local workspace path; defaults to the current directory for local OAP")
    .option("--runtime <name>", "Initialize the local workspace with a runtime before opening it")
    .option("--home <path>", "OAH home directory for local daemon defaults")
    .option("--no-auto-start", "Do not auto-start the local OAP daemon when no --base-url is provided")
    .action(async (options: TuiOptions) => {
      const { launchTui } = await import("../tui/launcher.js");
      const { connection, workspaceId } = await resolveTuiConnection(program.opts<GlobalOptions>(), options);
      await launchTui(connection, { ...(workspaceId ? { initialWorkspaceId: workspaceId } : {}) });
    });

  program
    .command("system:profile")
    .description("Show connected OAH-compatible server profile")
    .action(async () => {
      const { OahApiClient } = await import("../api/oah-api.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {});
      const client = new OahApiClient(connection);
      const profile = await client.getSystemProfile();
      console.log(JSON.stringify(profile, null, 2));
    });

  program
    .command("workspace:list")
    .alias("workspaces")
    .description("List visible workspaces")
    .action(async () => {
      const { OahApiClient, formatWorkspaceLine } = await import("../api/oah-api.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {});
      const client = new OahApiClient(connection);
      const workspaces = await client.listAllWorkspaces();
      if (workspaces.length === 0) {
        console.log("No workspaces found.");
        return;
      }
      for (const workspace of workspaces) {
        console.log(formatWorkspaceLine(workspace));
      }
    });

  program
    .command("catalog:show")
    .description("Show a workspace catalog as JSON")
    .requiredOption("-w, --workspace <id>", "Workspace id")
    .action(async (options: { workspace: string }) => {
      const { OahApiClient } = await import("../api/oah-api.js");
      const { connection } = await resolveClientConnection(program.opts<GlobalOptions>(), {});
      const client = new OahApiClient(connection);
      const catalog = await client.getWorkspaceCatalog(options.workspace);
      console.log(JSON.stringify(catalog, null, 2));
    });

  return program;
}

async function resolveTuiConnection(globalOptions: GlobalOptions, tuiOptions: TuiOptions) {
  const { OahApiClient } = await import("../api/oah-api.js");
  const localDefaultWorkspace = !globalOptions.baseUrl && !process.env.OAH_BASE_URL;
  const workspacePath = tuiOptions.workspace ?? (localDefaultWorkspace || tuiOptions.runtime ? process.cwd() : undefined);
  const { connection } = await resolveClientConnection(
    { ...globalOptions, ...(tuiOptions.home ? { home: tuiOptions.home } : {}) },
    {
      autoStartLocalDaemon: tuiOptions.autoStart !== false,
      announceAutoStart: true
    }
  );
  if (!workspacePath) {
    return { connection };
  }

  const client = new OahApiClient(connection);
  let profile;
  try {
    profile = await client.getSystemProfile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read server profile before local workspace registration: ${message}`);
  }
  if (!profile.capabilities.localWorkspacePaths || !profile.capabilities.workspaceRegistration) {
    throw new Error(
      `Connected server "${profile.displayName}" does not support local workspace path registration. ` +
        "Use an OAP local daemon or omit --workspace when connecting to OAH enterprise."
    );
  }
  let workspace;
  try {
    workspace = await client.registerLocalWorkspace({
      rootPath: workspacePath,
      ...(tuiOptions.runtime ? { runtime: tuiOptions.runtime } : {})
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to register local workspace "${workspacePath}": ${message}\n` +
        "Check that the path exists and is readable. If you passed --runtime, it only bootstraps directories that do not already have .openharness. If this is a remote OAH server, omit --workspace/--runtime or connect to an OAP local daemon."
    );
  }
  console.log(`Registered workspace ${workspace.name} (${workspace.id}) at ${workspace.rootPath}`);
  return { connection, workspaceId: workspace.id };
}

async function resolveClientConnection(
  globalOptions: GlobalOptions,
  options: { autoStartLocalDaemon?: boolean; announceAutoStart?: boolean }
) {
  const explicitBaseUrl = globalOptions.baseUrl ?? process.env.OAH_BASE_URL;
  if (explicitBaseUrl) {
    return {
      connection: {
        baseUrl: explicitBaseUrl,
        token: globalOptions.token ?? process.env.OAH_TOKEN ?? ""
      },
      source: "explicit" as const
    };
  }

  const { resolveDaemonApiConnection, startDaemon } = await import("../daemon/lifecycle.js");
  if (options.autoStartLocalDaemon) {
    const message = await startDaemon({ home: globalOptions.home });
    if (options.announceAutoStart) {
      console.error(message);
    }
  }

  const daemonConnection = await resolveDaemonApiConnection({ home: globalOptions.home });
  return {
    connection: {
      baseUrl: daemonConnection.baseUrl,
      token: globalOptions.token ?? process.env.OAH_TOKEN ?? daemonConnection.token
    },
    source: "local-daemon" as const
  };
}

function parseIntegerOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

function resolveGroupedHomeOptions(command: Command | undefined, group: Command, program: Command): DaemonGlobalOptions {
  const home =
    command?.parent?.opts<DaemonGlobalOptions>().home ?? group.opts<DaemonGlobalOptions>().home ?? program.opts<DaemonGlobalOptions>().home;
  return home ? { home } : {};
}

export async function runCli(argv = process.argv): Promise<void> {
  const normalizedArgv = argv.filter((arg, index) => index < 2 || arg !== "--");
  await createProgram().parseAsync(normalizedArgv);
}
