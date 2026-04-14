import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ProjectSnapshot } from "@shared/types";

interface AgentConfigModalProps {
  project: ProjectSnapshot | undefined;
  open: boolean;
  selectedPath: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectPath: (path: string) => void;
}

export function AgentConfigModal({
  project,
  open,
  selectedPath,
  onOpenChange,
  onSelectPath,
}: AgentConfigModalProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const viewableAgents = useMemo(
    () => project?.agentFiles.filter((agent) => !agent.relativePath.startsWith("builtin://")) ?? [],
    [project],
  );

  useEffect(() => {
    if (!selectedPath && viewableAgents[0]) {
      onSelectPath(viewableAgents[0].relativePath);
    }
  }, [onSelectPath, selectedPath, viewableAgents]);

  const selectedFile = useMemo(
    () => viewableAgents.find((agent) => agent.relativePath === selectedPath),
    [selectedPath, viewableAgents],
  );

  useEffect(() => {
    if (!open || !project || !selectedFile) {
      if (!selectedFile) {
        setContent("");
        setLoadError(null);
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void window.agentFlow
      .readAgentFile({
        projectId: project.project.id,
        relativePath: selectedFile.relativePath,
      })
      .then((file) => {
        if (cancelled) {
          return;
        }
        setContent(file.content);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setContent(selectedFile.content);
        setLoadError(error instanceof Error ? error.message : "读取文件失败");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, project?.project.id, reloadToken, selectedFile?.relativePath]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25" />
        <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 flex h-[min(760px,88vh)] w-[min(1080px,94vw)] min-h-0 -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] p-6">
          <Dialog.Title className="font-display text-2xl font-bold text-primary">
            .opencode/agents 文件查看器
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            只读查看项目工作目录下的 Markdown Agent 文件内容，方便核对当前 Agent 配置。
          </Dialog.Description>

          <div className="mt-6 grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-4">
            <div className="min-h-0 rounded-[8px] border border-border bg-card/80 p-3">
              <div className="h-full space-y-2 overflow-y-auto">
                {viewableAgents.map((agent) => (
                  <button
                    key={agent.relativePath}
                    type="button"
                    onClick={() => {
                      onSelectPath(agent.relativePath);
                      onOpenChange(true);
                    }}
                    className={`w-full rounded-[8px] border px-3 py-3 text-left transition ${
                      selectedPath === agent.relativePath
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-white/70 hover:border-accent"
                    }`}
                  >
                    <p className="text-sm font-semibold">{agent.name}</p>
                    <p className="mt-1 text-[11px] opacity-75">{agent.mode}</p>
                  </button>
                ))}
                {viewableAgents.length === 0 && (
                  <div className="rounded-[8px] border border-dashed border-border bg-white/50 px-3 py-4 text-sm text-muted-foreground">
                    当前没有可查看的本地 Agent 文件。OpenCode 内置 build agent 不在这里展示原始 Markdown。
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col rounded-[8px] border border-border bg-card/80 p-4">
              <div className="mb-3">
                <p className="font-semibold text-primary">{selectedFile?.relativePath ?? "未选择文件"}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedFile
                    ? "打开时会直接读取磁盘最新内容；这里只读展示，不支持在界面内修改。"
                    : "这里只查看项目工作目录下的 Markdown Agent 文件。"}
                </p>
                {loadError && <p className="mt-1 text-xs text-[#9a5a2e]">{loadError}</p>}
                {!loadError && selectedFile && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {loading ? "正在读取磁盘..." : "当前展示的是磁盘中的最新内容。"}
                  </p>
                )}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-border bg-[#172019] px-4 py-4 font-mono text-sm leading-6 text-[#F4EFE6]">
                <code>{content}</code>
              </pre>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-3 border-t border-border/60 pt-4">
            <button
              type="button"
              className="rounded-[8px] border border-border px-4 py-2 text-sm"
              disabled={!selectedFile || loading}
              onClick={() => setReloadToken((current) => current + 1)}
            >
              重新载入磁盘内容
            </button>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-[8px] border border-border px-4 py-2 text-sm"
              >
                关闭
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
