import type { RefCallback } from "react";

import { getAgentColorToken } from "@/lib/agent-colors";
import {
  PANEL_HEADER_CLASS,
  PANEL_HEADER_LEADING_CLASS,
  PANEL_HEADER_TITLE_CLASS,
  PANEL_SECTION_BODY_CLASS,
} from "@/lib/panel-header";

interface SystemPromptDrawerAgentCard {
  id: string;
  prompt: string;
  promptSnippet: string;
}

interface SystemPromptDrawerProps {
  agentCards: SystemPromptDrawerAgentCard[];
  agentCardGapPx: number;
  agentTerminalActionError: string;
  bindViewport: RefCallback<HTMLDivElement>;
  onClose: () => void;
  onOpenAgentPromptDialog: (agent: {
    id: string;
    prompt: string;
  }) => void;
  promptLineCount: number;
}

export function SystemPromptDrawer({
  agentCards,
  agentCardGapPx,
  agentTerminalActionError,
  bindViewport,
  onClose,
  onOpenAgentPromptDialog,
  promptLineCount,
}: SystemPromptDrawerProps) {
  return (
    <div
      className="fixed inset-0 z-40 overflow-hidden bg-black/24"
      onClick={onClose}
      aria-hidden="true"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="System Prompt 面板"
        className="absolute inset-y-0 right-0 flex w-full max-w-[380px] flex-col overflow-hidden border-l border-border/70 bg-background shadow-[-18px_0_44px_rgba(23,32,25,0.14)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={PANEL_HEADER_CLASS}>
          <div className={PANEL_HEADER_LEADING_CLASS}>
            <p className={PANEL_HEADER_TITLE_CLASS}>System Prompt</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/90 text-lg leading-none text-foreground/68 transition hover:bg-background"
            aria-label="关闭 System Prompt 面板"
          >
            ×
          </button>
        </header>

        <div
          ref={bindViewport}
          className={`min-h-0 flex-1 overflow-y-auto ${PANEL_SECTION_BODY_CLASS}`}
        >
          {agentTerminalActionError ? (
            <div className="mb-1.5 rounded-[8px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
              {agentTerminalActionError}
            </div>
          ) : null}

          <div className="flex flex-col" style={{ gap: `${agentCardGapPx}px` }}>
            {agentCards.map((agent) => {
              const color = getAgentColorToken(agent.id);
              const promptSnippetLine = agent.promptSnippet.replace(/\s+/gu, "");
              return (
                <div
                  key={agent.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    onOpenAgentPromptDialog(agent);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenAgentPromptDialog(agent);
                    }
                  }}
                  className="rounded-[8px] border px-3 py-2 text-left shadow-sm transition"
                  style={{
                    background: color.soft,
                    borderColor: color.border,
                    color: color.text,
                  }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span
                        className="inline-flex max-w-full shrink-0 rounded-[8px] px-2 py-px text-center text-[14px] font-semibold leading-[1.2] tracking-[0.02em]"
                        style={{
                          background: color.solid,
                          color: color.badgeText,
                        }}
                      >
                        {agent.id}
                      </span>
                    </div>
                  </div>
                  {agent.promptSnippet !== "-" ? (
                    <div className="mt-1 min-w-0">
                      <p
                        title={agent.promptSnippet}
                        className="min-w-0 overflow-hidden break-all text-[13px] leading-[18px]"
                        style={{
                          color: color.mutedText,
                          display: "-webkit-box",
                          WebkitBoxOrient: "vertical",
                          WebkitLineClamp: promptLineCount,
                        }}
                      >
                        {promptSnippetLine}
                      </p>
                    </div>
                  ) : (
                    <div className="mt-1 min-w-0 text-[13px] leading-5" style={{ color: color.mutedText }}>
                      -
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
