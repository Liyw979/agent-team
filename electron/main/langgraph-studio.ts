import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 2024;
const STUDIO_WEB_ORIGIN = "https://smith.langchain.com/studio/";
const STUDIO_GRAPH_EXPORT = "agentflowStudio";

interface LangGraphStudioConfig {
  dependencies: string[];
  graphs: Record<string, string>;
}

interface LangGraphStudioCliInvocation {
  command: string;
  args: string[];
}

interface LangGraphStudioServerHandle {
  process: ChildProcessWithoutNullStreams;
  port: number;
  baseUrl: string;
}

interface LangGraphStudioServerState {
  projectPath: string;
  runtimeDir: string;
  serverHandle: Promise<LangGraphStudioServerHandle> | null;
  shutdownPromise: Promise<void> | null;
}

interface LangGraphStudioManagerOptions {
  runtimeRoot?: string;
  appRoot?: string;
  entryModulePath?: string;
  spawnProcess?: typeof spawn;
}

export function buildLangGraphStudioUrl(baseUrl: string): string {
  return `${STUDIO_WEB_ORIGIN}?baseUrl=${encodeURIComponent(baseUrl)}`;
}

export function buildLangGraphStudioConfig(input: {
  appRoot: string;
  entryModulePath: string;
}): LangGraphStudioConfig {
  return {
    dependencies: [input.appRoot],
    graphs: {
      agentflow: `${input.entryModulePath}:${STUDIO_GRAPH_EXPORT}`,
    },
  };
}

export function buildLangGraphStudioCliInvocation(input: {
  platform: NodeJS.Platform;
  configPath: string;
  port: number;
  host: string;
}): LangGraphStudioCliInvocation {
  return {
    command: input.platform === "win32" ? "npx.cmd" : "npx",
    args: [
      "@langchain/langgraph-cli",
      "dev",
      "--config",
      input.configPath,
      "--port",
      String(input.port),
      "--host",
      input.host,
    ],
  };
}

export class LangGraphStudioManager {
  private readonly runtimeRoot: string;
  private readonly appRoot: string;
  private readonly entryModulePath: string;
  private readonly spawnProcess: typeof spawn;
  private readonly servers = new Map<string, LangGraphStudioServerState>();

  constructor(options: LangGraphStudioManagerOptions = {}) {
    this.runtimeRoot = options.runtimeRoot
      ? path.resolve(options.runtimeRoot)
      : path.join(os.tmpdir(), "agentflow-langgraph-studio");
    this.entryModulePath = options.entryModulePath ?? resolveLangGraphStudioEntryModulePath();
    this.appRoot = options.appRoot ?? findPackageRoot(path.dirname(this.entryModulePath));
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async open(projectPath: string): Promise<string> {
    const handle = await this.restartServer(projectPath);
    return buildLangGraphStudioUrl(handle.baseUrl);
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()].map((state) => this.shutdownState(state)),
    );
  }

  private getServerState(projectPath: string): LangGraphStudioServerState {
    const normalizedProjectPath = path.resolve(projectPath);
    const existing = this.servers.get(normalizedProjectPath);
    if (existing) {
      return existing;
    }

    const runtimeDir = path.join(
      this.runtimeRoot,
      path.basename(normalizedProjectPath).replace(/[^a-zA-Z0-9._-]/g, "_") || "project",
    );
    const created: LangGraphStudioServerState = {
      projectPath: normalizedProjectPath,
      runtimeDir,
      serverHandle: null,
      shutdownPromise: null,
    };
    this.servers.set(normalizedProjectPath, created);
    return created;
  }

  private async restartServer(projectPath: string): Promise<LangGraphStudioServerHandle> {
    const state = this.getServerState(projectPath);
    await this.shutdownState(state);
    state.serverHandle = this.startServer(state).catch((error) => {
      state.serverHandle = null;
      throw error;
    });
    return state.serverHandle;
  }

  private async startServer(state: LangGraphStudioServerState): Promise<LangGraphStudioServerHandle> {
    await fs.mkdir(state.runtimeDir, { recursive: true });
    const configPath = path.join(state.runtimeDir, "langgraph.json");
    const port = await findAvailablePort(DEFAULT_PORT);
    const config = buildLangGraphStudioConfig({
      appRoot: this.appRoot,
      entryModulePath: this.entryModulePath,
    });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const invocation = buildLangGraphStudioCliInvocation({
      platform: process.platform,
      configPath,
      port,
      host: DEFAULT_HOST,
    });
    const child = this.spawnProcess(invocation.command, invocation.args, {
      cwd: this.appRoot,
      env: {
        ...process.env,
        AGENTFLOW_LANGGRAPH_PROJECT_PATH: state.projectPath,
      },
      stdio: "pipe",
    });

    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    try {
      await waitForPortReady({
        host: DEFAULT_HOST,
        port,
        process: child,
      });
    } catch (error) {
      child.kill("SIGTERM");
      throw new Error(
        `启动 LangGraph Studio 本地服务失败：${error instanceof Error ? error.message : String(error)}${stderrBuffer ? `\n${stderrBuffer.trim()}` : ""}`,
      );
    }

    return {
      process: child,
      port,
      baseUrl: `http://${DEFAULT_HOST}:${port}`,
    };
  }

  private async shutdownState(state: LangGraphStudioServerState): Promise<void> {
    if (state.shutdownPromise) {
      await state.shutdownPromise;
      return;
    }

    const active = state.serverHandle;
    if (!active) {
      return;
    }
    state.serverHandle = null;
    state.shutdownPromise = active
      .then((handle) => terminateChildProcess(handle.process))
      .finally(() => {
        state.shutdownPromise = null;
      });
    await state.shutdownPromise;
  }
}

function resolveLangGraphStudioEntryModulePath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const jsPath = path.join(currentDir, "langgraph-studio-entry.js");
  const tsPath = path.join(currentDir, "langgraph-studio-entry.ts");
  return path.resolve(pathExistsSync(jsPath) ? jsPath : tsPath);
}

function findPackageRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (pathExistsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`未找到 package.json，无法定位 LangGraph Studio 依赖根目录：${startDir}`);
    }
    current = parent;
  }
}

function pathExistsSync(targetPath: string): boolean {
  try {
    return fsSync.existsSync(targetPath);
  } catch {
    return false;
  }
}

async function findAvailablePort(preferredPort: number): Promise<number> {
  const preferred = await canListenOnPort(preferredPort);
  if (preferred) {
    return preferredPort;
  }

  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function canListenOnPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, DEFAULT_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForPortReady(input: {
  host: string;
  port: number;
  process: ChildProcessWithoutNullStreams;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const onExit = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("LangGraph Studio 进程已提前退出"));
    };
    input.process.once("exit", onExit);
    input.process.once("error", onExit);

    const probe = () => {
      const socket = net.createConnection({
        host: input.host,
        port: input.port,
      });
      socket.once("connect", () => {
        socket.destroy();
        if (settled) {
          return;
        }
        settled = true;
        input.process.removeListener("exit", onExit);
        input.process.removeListener("error", onExit);
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > 15000) {
          if (settled) {
            return;
          }
          settled = true;
          input.process.removeListener("exit", onExit);
          input.process.removeListener("error", onExit);
          reject(new Error("等待 LangGraph Studio 端口就绪超时"));
          return;
        }
        setTimeout(probe, 200);
      });
    };

    probe();
  });
}

async function terminateChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 1000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}
