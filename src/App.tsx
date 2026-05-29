import { useCallback, useEffect, useMemo, useState, type RefCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UiSnapshotPayload } from "@shared/types";
import { ChatWindow } from "./components/ChatWindow";
import { SystemPromptDrawer } from "./components/SystemPromptDrawer";
import { TopologyGraph } from "./components/TopologyGraph";
import {
  fetchUiSnapshot,
  openAgentTerminal,
  submitTask,
} from "./lib/web-api";
import { getAgentColorToken } from "./lib/agent-colors";
import { calculateAgentCardPanelLayout } from "./lib/agent-card-layout";
import { getAppShellClassName } from "./lib/app-shell-layout";
import { resolveAppUiSnapshot, createInitialAppUiSnapshot, type AppUiSnapshot } from "./lib/app-ui-snapshot";
import { buildAgentPromptSnippetText } from "./lib/agent-prompt-snippet";
import {
  PANEL_SECTION_BODY_CLASS,
} from "./lib/panel-header";
import {
  buildAvailableAgentIdsForFrontend,
  orderAgentsForFrontend,
} from "./lib/frontend-agent-order";
import { MarkdownMessage } from "./lib/chat-markdown";
import {
  buildAgentPromptDialogState,
  type AgentPromptDialogState,
} from "./lib/agent-prompt-dialog";
import { getUiSnapshotPollingIntervalMs } from "./lib/ui-snapshot-polling";
import { resolveAppPanelVisibility, type AppPanelMode } from "./lib/app-panel-visibility";

type AgentPromptDialogViewState =
  | {
      kind: "closed";
    }
  | ({
      kind: "open";
    } & AgentPromptDialogState);

const CLOSED_AGENT_PROMPT_DIALOG: AgentPromptDialogViewState = {
  kind: "closed",
};

type AgentPanelViewportState =
  | {
      kind: "unmounted";
    }
  | {
      kind: "mounted";
      element: HTMLDivElement;
    };

const UNMOUNTED_AGENT_PANEL_VIEWPORT: AgentPanelViewportState = {
  kind: "unmounted",
};
const PANEL_GAP_PX = 5;

function App() {
  const queryClient = useQueryClient();
  const appShellClassName = getAppShellClassName();
  const [agentTerminalActionError, setAgentTerminalActionError] = useState("");
  const [promptLineCount, setPromptLineCount] = useState(1);
  const [agentCardGapPx, setAgentCardGapPx] = useState(6);
  const [panelMode, setPanelMode] = useState<AppPanelMode>("default");
  const [selectedAgentPromptDialog, setSelectedAgentPromptDialog] = useState<AgentPromptDialogViewState>(
    CLOSED_AGENT_PROMPT_DIALOG,
  );
  const [isSystemPromptDrawerOpen, setIsSystemPromptDrawerOpen] = useState(false);
  const [agentPanelViewport, setAgentPanelViewport] = useState<AgentPanelViewportState>(
    UNMOUNTED_AGENT_PANEL_VIEWPORT,
  );

  const uiSnapshotPollingIntervalMs = getUiSnapshotPollingIntervalMs();
  const panelVisibility = resolveAppPanelVisibility(panelMode);
  const uiSnapshotQueryKey = ["ui-snapshot"] as const;
  const uiSnapshotQuery = useQuery<UiSnapshotPayload, Error, AppUiSnapshot>({
    queryKey: uiSnapshotQueryKey,
    enabled: true,
    retry: false,
    queryFn: fetchUiSnapshot,
    refetchInterval: uiSnapshotPollingIntervalMs ?? false,
    refetchIntervalInBackground: true,
    select: resolveAppUiSnapshot,
  });
  const submitTaskMutation = useMutation({
    mutationFn: submitTask,
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: uiSnapshotQueryKey });
    },
  });
  const uiSnapshot = uiSnapshotQuery.data ?? createInitialAppUiSnapshot();

  const bindAgentPanelViewport: RefCallback<HTMLDivElement> = useCallback((element) => {
    setAgentPanelViewport((current) => {
      if (!element) {
        return current.kind === "unmounted"
          ? current
          : UNMOUNTED_AGENT_PANEL_VIEWPORT;
      }
      return current.kind === "mounted"
        && current.element === element
        ? current
        : {
            kind: "mounted",
            element,
          };
    });
  }, []);

  const availableAgents = useMemo(
    () =>
      uiSnapshot.taskView.kind === "ready"
        ? buildAvailableAgentIdsForFrontend(
            uiSnapshot.taskView.workspace.agents,
            uiSnapshot.taskView.task.topology.nodes,
          )
        : [],
    [uiSnapshot],
  );
  const agentCards = useMemo(() => {
    if (uiSnapshot.taskView.kind !== "ready") {
      return [];
    }

    const { workspace, task } = uiSnapshot.taskView;
    return orderAgentsForFrontend(
      workspace.agents,
      task.topology.nodes,
    ).map((agent) => {
      const promptSnippet = buildAgentPromptSnippetText({
        agentId: agent.id,
        prompt: agent.prompt,
      });
      return {
        id: agent.id,
        prompt: agent.prompt,
        promptSnippet,
      };
    });
  }, [uiSnapshot]);

  useEffect(() => {
    if (agentPanelViewport.kind !== "mounted" || agentCards.length === 0) {
      setPromptLineCount(1);
      setAgentCardGapPx(6);
      return;
    }

    const viewport = agentPanelViewport.element;
    const updatePromptLineCount = () => {
      const layout = calculateAgentCardPanelLayout({
        viewportHeight: viewport.clientHeight,
        cardCount: agentCards.length,
        promptCardCount: agentCards.filter((agent) => agent.promptSnippet !== "-").length,
        hasErrorBanner: agentTerminalActionError.length > 0,
      });
      setPromptLineCount(layout.promptLineCount);
      setAgentCardGapPx(layout.gapPx);
    };

    updatePromptLineCount();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updatePromptLineCount);
      return () => {
        window.removeEventListener("resize", updatePromptLineCount);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      updatePromptLineCount();
    });
    resizeObserver.observe(viewport);
    window.addEventListener("resize", updatePromptLineCount);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePromptLineCount);
    };
  }, [agentCards.length, agentPanelViewport, agentTerminalActionError]);

  async function handleOpenAgentTerminal(agentId: string) {
    if (uiSnapshot.taskView.kind !== "ready") {
      return;
    }

    setAgentTerminalActionError("");
    try {
      await openAgentTerminal(agentId);
    } catch (error) {
      setIsSystemPromptDrawerOpen(true);
      setAgentTerminalActionError(
        error instanceof Error ? error.message : `打开 ${agentId} 对应终端失败，请稍后重试。`,
      );
    }
  }

  function handleOpenAgentPromptDialog(agent: {
    id: string;
    prompt: string;
  }) {
    setSelectedAgentPromptDialog(
      {
        kind: "open",
        ...buildAgentPromptDialogState({
          agentId: agent.id,
          prompt: agent.prompt,
        }),
      },
    );
  }

  if (uiSnapshot.taskView.kind !== "ready") {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-foreground">
        <div className="PANEL-surface max-w-xl rounded-[12px] p-6 text-center">
          <p className="font-display text-[1.8rem] font-bold text-primary">当前没有可展示的 Task</p>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            请先通过命令行执行 <code>task ui --file &lt;topology-file&gt; --message &lt;message&gt;</code>
            打开当前任务页面。
          </p>
        </div>
      </div>
    );
  }

  const { workspace, task } = uiSnapshot.taskView;

  return (
    <div className="flex h-screen flex-col overflow-hidden text-foreground">
      <main className={`min-h-0 min-w-0 flex-1 overflow-hidden ${appShellClassName}`}>
        {!panelVisibility.showChatPanel && panelVisibility.showTopologyPanel ? (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <TopologyGraph
              task={task}
              isMaximized={panelMode === "topology-only"}
              onOpenSystemPromptPanel={() => {
                setIsSystemPromptDrawerOpen(true);
              }}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "topology-only" ? "default" : "topology-only"));
              }}
              onOpenAgentTerminal={(agentId) => {
                void handleOpenAgentTerminal(agentId);
              }}
            />
          </div>
        ) : panelVisibility.showChatPanel && !panelVisibility.showTopologyPanel ? (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <ChatWindow
              workspace={workspace}
              task={task}
              availableAgents={availableAgents}
              taskLogFilePath={uiSnapshot.taskView.taskLogFilePath}
              taskUrl={uiSnapshot.taskUrl}
              isMaximized={panelMode === "chat-only"}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "chat-only" ? "default" : "chat-only"));
              }}
              onOpenAgentTerminal={(agentId) => {
                void handleOpenAgentTerminal(agentId);
              }}
              onSubmit={async (payload) => {
                await submitTaskMutation.mutateAsync(payload);
              }}
            />
          </div>
        ) : (
          <div
            className="grid h-full min-w-0 overflow-hidden grid-rows-[minmax(320px,42%)_minmax(0,1fr)]"
            style={{ gap: `${PANEL_GAP_PX}px` }}
          >
            <TopologyGraph
              task={task}
              isMaximized={panelMode === "topology-only"}
              onOpenSystemPromptPanel={() => {
                setIsSystemPromptDrawerOpen(true);
              }}
              onToggleMaximize={() => {
                setPanelMode((current) => (current === "topology-only" ? "default" : "topology-only"));
              }}
              onOpenAgentTerminal={(agentId) => {
                void handleOpenAgentTerminal(agentId);
              }}
            />

            <div className="min-h-0 min-w-0">
              <ChatWindow
                workspace={workspace}
                task={task}
                availableAgents={availableAgents}
                taskLogFilePath={uiSnapshot.taskView.taskLogFilePath}
                taskUrl={uiSnapshot.taskUrl}
                isMaximized={panelMode === "chat-only"}
                onToggleMaximize={() => {
                  setPanelMode((current) => (current === "chat-only" ? "default" : "chat-only"));
                }}
                onOpenAgentTerminal={(agentId) => {
                  void handleOpenAgentTerminal(agentId);
                }}
                onSubmit={async (payload) => {
                  await submitTaskMutation.mutateAsync(payload);
                }}
              />
            </div>
          </div>
        )}
      </main>

      {isSystemPromptDrawerOpen ? (
        <SystemPromptDrawer
          agentCards={agentCards}
          agentCardGapPx={agentCardGapPx}
          agentTerminalActionError={agentTerminalActionError}
          bindViewport={bindAgentPanelViewport}
          onClose={() => {
            setIsSystemPromptDrawerOpen(false);
          }}
          onOpenAgentPromptDialog={handleOpenAgentPromptDialog}
          promptLineCount={promptLineCount}
        />
      ) : null}

      {selectedAgentPromptDialog.kind === "open" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/28 px-6 py-6"
          onClick={() => setSelectedAgentPromptDialog(CLOSED_AGENT_PROMPT_DIALOG)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedAgentPromptDialog.agentId} Prompt 详情`}
            className="flex max-h-[min(82vh,720px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[14px] border bg-background shadow-[0_24px_80px_rgba(23,32,25,0.22)]"
            style={{
              borderColor: getAgentColorToken(selectedAgentPromptDialog.agentId).border,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-5 py-3"
              style={{
                background: getAgentColorToken(selectedAgentPromptDialog.agentId).soft,
                borderColor: getAgentColorToken(selectedAgentPromptDialog.agentId).border,
              }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                    style={{
                      background: getAgentColorToken(selectedAgentPromptDialog.agentId).solid,
                      color: getAgentColorToken(selectedAgentPromptDialog.agentId).badgeText,
                    }}
                  >
                    {selectedAgentPromptDialog.agentId}
                  </span>
                </div>
                <p className="mt-1 text-xs text-foreground/60">
                  {selectedAgentPromptDialog.promptSourceLabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAgentPromptDialog(CLOSED_AGENT_PROMPT_DIALOG)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/90 text-lg leading-none text-foreground/68 transition hover:bg-background"
                aria-label="关闭 Prompt 详情"
              >
                ×
              </button>
            </div>

            <div className={`min-h-0 overflow-y-auto ${PANEL_SECTION_BODY_CLASS}`}>
              <MarkdownMessage
                content={selectedAgentPromptDialog.content}
                className="text-[14px] leading-[1.35] text-foreground/84"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
