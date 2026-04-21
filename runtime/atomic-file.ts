import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

export function buildAtomicWriteTempPath(filePath: string, nonce = `${process.pid}-${randomUUID()}`) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${nonce}.tmp`);
}

export function writeFileAtomicSync(filePath: string, content: string, encoding: BufferEncoding = "utf8") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = buildAtomicWriteTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, content, encoding);
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export async function writeFileAtomic(filePath: string, content: string, encoding: BufferEncoding = "utf8") {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = buildAtomicWriteTempPath(filePath);
  try {
    await fsPromises.writeFile(tempPath, content, encoding);
    await fsPromises.rename(tempPath, filePath);
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
