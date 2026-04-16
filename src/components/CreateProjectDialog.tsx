import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getProjectNameFromPath } from "@shared/types";

interface CreateProjectDialogProps {
  onCreated: (path: string) => Promise<void>;
}

export function CreateProjectDialog({ onCreated }: CreateProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="shrink-0 whitespace-nowrap rounded-[8px] bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground"
        >
          新建项目
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25" />
        <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-[10px] p-8">
          <Dialog.Title className="font-display text-2xl font-bold text-primary">
            创建项目
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            将创建独立 Project、OpenCode Session、Project 内 `.agentflow` 数据文件和 Zellij Session，项目名会自动使用文件夹名称。
          </Dialog.Description>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">项目路径</span>
              <div className="flex gap-3">
                <input
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="请选择一个工作目录"
                  className="w-full rounded-[8px] border border-border bg-card px-4 py-3 text-sm outline-none focus:border-primary"
                />
                <button
                  type="button"
                  disabled={picking}
                  className="min-w-[116px] shrink-0 whitespace-nowrap rounded-[8px] border border-border px-5 py-3 text-sm font-medium transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={async () => {
                    setPicking(true);
                    try {
                      const selected = await window.agentFlow.pickProjectPath();
                      if (selected) {
                        setPath(selected);
                      }
                    } finally {
                      setPicking(false);
                    }
                  }}
                >
                  {picking ? "选择中..." : "选择目录"}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {path.trim()
                  ? `将自动使用“${getProjectNameFromPath(path) || "未识别到目录名"}”作为项目名称`
                  : "选择目录后会自动使用文件夹名称作为项目名称"}
              </p>
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-[8px] border border-border px-4 py-2 text-sm"
              >
                取消
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!path.trim() || !getProjectNameFromPath(path)}
              className="rounded-[8px] bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
              onClick={async () => {
                await onCreated(path.trim());
                setOpen(false);
              }}
            >
              创建
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
