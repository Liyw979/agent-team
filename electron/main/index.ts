import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS } from "@shared/ipc";
import type {
  GetTaskRuntimePayload,
  OpenAgentTerminalPayload,
  SubmitTaskPayload,
  UiBootstrapPayload,
} from "@shared/types";
import { Orchestrator } from "./orchestrator";
import { initAppFileLogger } from "./app-log";
import { resolveCliUserDataPath } from "./user-data-path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isIgnorableStreamWriteError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const nodeError = error as Error & { code?: string };
  return (
    nodeError.code === "EIO" ||
    nodeError.code === "ERR_STREAM_DESTROYED" ||
    nodeError.code === "ERR_INVALID_HANDLE_TYPE"
  );
}

function wrapWritableStream(stream: NodeJS.WriteStream | undefined) {
  if (!stream) {
    return;
  }

  const originalWrite = stream.write.bind(stream);
  stream.write = ((chunk: unknown, encoding?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) => {
    const resolvedEncoding = typeof encoding === "string" ? encoding : undefined;
    const resolvedCallback =
      typeof encoding === "function" ? encoding : callback;

    try {
      return originalWrite(
        chunk as Parameters<typeof originalWrite>[0],
        resolvedEncoding as Parameters<typeof originalWrite>[1],
        resolvedCallback as Parameters<typeof originalWrite>[2],
      );
    } catch (error) {
      if (!isIgnorableStreamWriteError(error)) {
        throw error;
      }
      resolvedCallback?.(null);
      return false;
    }
  }) as typeof stream.write;

  stream.on("error", (error) => {
    if (!isIgnorableStreamWriteError(error)) {
      throw error;
    }
  });
}

function installSafeConsoleGuards() {
  wrapWritableStream(process.stdout);
  wrapWritableStream(process.stderr);

  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      try {
        original(...args);
      } catch (error) {
        if (!isIgnorableStreamWriteError(error)) {
          throw error;
        }
      }
    }) as typeof console[typeof method];
  }

  process.on("uncaughtException", (error) => {
    if (isIgnorableStreamWriteError(error)) {
      return;
    }
    throw error;
  });
}

installSafeConsoleGuards();

const userDataPath = resolveCliUserDataPath();
initAppFileLogger(userDataPath);

let mainWindow: BrowserWindow | null = null;
const orchestrator = new Orchestrator({
  userDataPath,
});
let shuttingDown = false;

function readLaunchArgument(flag: string): string | null {
  const index = process.argv.findIndex((value) => value === flag);
  if (index < 0) {
    return null;
  }
  const next = process.argv[index + 1];
  return typeof next === "string" && next.trim().length > 0 ? next : null;
}

async function buildUiBootstrapPayload(): Promise<UiBootstrapPayload> {
  const launchCwd = readLaunchArgument("--agentflow-cwd");
  const launchTaskId = readLaunchArgument("--agentflow-task-id");
  const workspace = await orchestrator.getWorkspaceSnapshot(path.resolve(launchCwd || process.cwd()));
  const task =
    launchTaskId
      ? workspace.tasks.find((item) => item.task.id === launchTaskId) ?? null
      : workspace.tasks[0] ?? null;

  return {
    workspace,
    task,
    launchTaskId,
    launchCwd: workspace.cwd,
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#F4EFE6",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
    },
  });

  orchestrator.attachWindow(mainWindow);

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", {
      errorCode,
      errorDescription,
      validatedURL,
    });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer] render-process-gone", details);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log("[renderer] console-message", {
      level,
      message,
      line,
      sourceId,
    });
  });
  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[renderer] did-finish-load", mainWindow?.webContents.getURL());
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await orchestrator.initialize();

  ipcMain.handle(IPC_CHANNELS.bootstrap, () => buildUiBootstrapPayload());
  ipcMain.handle(
    IPC_CHANNELS.submitTask,
    (_event, payload: SubmitTaskPayload) => orchestrator.submitTask(payload),
  );
  ipcMain.handle(
    IPC_CHANNELS.openAgentTerminal,
    (_event, payload: OpenAgentTerminalPayload) => orchestrator.openAgentTerminal(payload),
  );
  ipcMain.handle(
    IPC_CHANNELS.getTaskRuntime,
    (_event, payload: GetTaskRuntimePayload) => orchestrator.getTaskRuntime(payload),
  );

  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  event.preventDefault();
  void orchestrator.dispose()
    .catch((error) => {
      console.error("[main] orchestrator dispose failed during app shutdown", error);
    })
    .finally(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
