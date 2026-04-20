import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_DIRECTORY_NAME = "agentflow";

function resolveDefaultUserDataPath() {
  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIRECTORY_NAME);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return path.join(appData || path.join(home, "AppData", "Roaming"), APP_DIRECTORY_NAME);
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdgConfigHome || path.join(home, ".config"), APP_DIRECTORY_NAME);
}

export function resolveCliUserDataPath() {
  const override = process.env.AGENTFLOW_USER_DATA_DIR?.trim();
  if (override) {
    return ensureWritableDirectory(path.resolve(override));
  }

  const preferred = resolveDefaultUserDataPath();

  try {
    return ensureWritableDirectory(preferred);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `默认全局用户数据目录不可写：${preferred}。`
      + ` 为避免在 <project>/.agentflow 下生成第二份 projects.json，CLI 不再静默回退到项目目录。`
      + ` 请显式设置 AGENTFLOW_USER_DATA_DIR 指向一个可写的全局目录。`
      + ` 原始错误：${details}`,
    );
  }
}

function ensureWritableDirectory(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
  fs.accessSync(targetPath, fs.constants.W_OK);
  return targetPath;
}
