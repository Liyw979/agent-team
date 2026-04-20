type BuildAgentPanelAttachButtonInput = {
  agentName: string;
  hasSession: boolean;
  isOpening: boolean;
};

export type AgentPanelAttachButtonState = {
  disabled: boolean;
  label: string;
  title: string;
  className: string;
};

export function buildAgentPanelAttachButtonState(
  input: BuildAgentPanelAttachButtonInput,
): AgentPanelAttachButtonState {
  const baseClassName =
    "inline-flex h-7 items-center justify-center rounded-full border border-[#d8cdbd] bg-[#fffaf2] px-2.5 text-[11px] font-semibold text-foreground/76 shadow-[0_1px_0_rgba(255,255,255,0.45)] transition hover:border-[#cda27d] hover:bg-white disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[#d8cdbd] disabled:hover:bg-[#fffaf2]";

  if (!input.hasSession) {
    return {
      disabled: true,
      label: "attach",
      title: `${input.agentName} 当前还没有可 attach 的 OpenCode session。`,
      className: baseClassName,
    };
  }

  if (input.isOpening) {
    return {
      disabled: true,
      label: "打开中...",
      title: `正在打开 ${input.agentName} 的 attach 终端`,
      className: baseClassName,
    };
  }

  return {
    disabled: false,
    label: "attach",
    title: `attach 到 ${input.agentName}`,
    className: baseClassName,
  };
}
