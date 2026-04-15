import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { BUILD_AGENT_NAME, type ProjectSnapshot } from "@shared/types";

export const NEW_AGENT_DRAFT_PATH = "__agentflow_new_agent__";

interface DefaultAgentPreset {
  name: string;
  prompt: string;
}

const DEFAULT_AGENT_PRESETS: DefaultAgentPreset[] = [
  {
    name: "BA",
    prompt:
      "你是 BA。\n你的职责：\n1. 润色原始 User Story，输出完善、可执行的需求，不需要写代码\n2. 明确目标、范围、约束与验收标准，让实现方可以直接推进",
  },
  {
    name: "UnitTest",
    prompt:
      "你是单元测试审查角色，负责检查单元测试是否遵循四条标准：单功能单测试、每个测试有注释、执行极快、尽量使用纯函数而不是 Mock。\n\n并给出修改建议。",
  },
  {
    name: "TaskReview",
    prompt:
      "你是任务交付审视角色，负责站在最终交付质量的角度审视本轮结果是否已经达到可交付标准。\n\n请重点检查：\n1. 用户真正要解决的问题是否被完整解决。\n2. 最终交付是否自洽，关键说明、验证结论与必要文档是否同步。\n3. 是否还存在阻塞交付的问题，若有就明确指出具体修改意见。",
  },
  {
    name: "CodeReview",
    prompt:
      "你是代码审查角色，关注冗余实现、可读性和是否符合 BA 定义的使用旅程。\n\n要求代码最小化改动，思考并质疑当前的改动是不是最小的，并给出修改建议。",
  },
];

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
  const [agentName, setAgentName] = useState("");
  const [savedAgentName, setSavedAgentName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [selectedPresetNames, setSelectedPresetNames] = useState<string[]>([]);
  const [addingPresets, setAddingPresets] = useState(false);
  const viewableAgents = useMemo(
    () => project?.agentFiles.filter((agent) => agent.name !== BUILD_AGENT_NAME) ?? [],
    [project],
  );
  const hasTaskRecords = (project?.tasks.length ?? 0) > 0;
  const existingAgentNames = useMemo(
    () => new Set(viewableAgents.map((agent) => agent.name)),
    [viewableAgents],
  );

  useEffect(() => {
    if (!selectedPath && viewableAgents[0]) {
      onSelectPath(viewableAgents[0].name);
    }
  }, [onSelectPath, selectedPath, viewableAgents]);

  const selectedFile = useMemo(
    () => viewableAgents.find((agent) => agent.name === selectedPath),
    [selectedPath, viewableAgents],
  );
  const creatingNewAgent = selectedPath === NEW_AGENT_DRAFT_PATH;
  const isNameEditingLocked = hasTaskRecords;
  const isNewAgentCreationLocked = hasTaskRecords;
  const isPromptEditingLocked =
    loading || saving || deleting || (creatingNewAgent && isNewAgentCreationLocked);

  useEffect(() => {
    if (!open || !project || !selectedFile) {
      if (!selectedFile) {
        setAgentName("");
        setSavedAgentName("");
        setPrompt("");
        setSavedPrompt("");
        setLoadError(null);
        setSaveError(null);
        setSaveSuccess(null);
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    void window.agentFlow
      .readAgentFile({
        projectId: project.project.id,
        agentName: selectedFile.name,
      })
      .then((file) => {
        if (cancelled) {
          return;
        }
        setAgentName(file.name);
        setSavedAgentName(file.name);
        setPrompt(file.prompt);
        setSavedPrompt(file.prompt);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setAgentName(selectedFile.name);
        setSavedAgentName(selectedFile.name);
        setPrompt(selectedFile.prompt);
        setSavedPrompt(selectedFile.prompt);
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
  }, [open, project?.project.id, selectedFile?.name, selectedFile?.prompt]);

  const hasUnsavedChanges = creatingNewAgent
    ? Boolean(agentName.trim() || prompt.trim())
    : prompt !== savedPrompt || agentName !== savedAgentName;
  const isRenamingBlocked = hasTaskRecords
    && !creatingNewAgent
    && Boolean(selectedFile)
    && agentName.trim() !== (selectedFile?.name ?? "");
  const saveDisabled = loading
    || saving
    || deleting
    || !hasUnsavedChanges
    || !agentName.trim()
    || (creatingNewAgent && isNewAgentCreationLocked)
    || isRenamingBlocked;
  const deleteDisabled =
    loading
    || saving
    || deleting
    || creatingNewAgent
    || !selectedFile
    || hasTaskRecords;
  const canAddSelectedPresets = selectedPresetNames.length > 0
    && !isNewAgentCreationLocked
    && !addingPresets;

  async function handleAddPresetAgents() {
    if (!project || isNewAgentCreationLocked || addingPresets || selectedPresetNames.length === 0) {
      return;
    }
    setAddingPresets(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      let createdCount = 0;
      let skippedCount = 0;
      let latestProject: ProjectSnapshot | null = null;
      for (const presetName of selectedPresetNames) {
        if (existingAgentNames.has(presetName)) {
          skippedCount += 1;
          continue;
        }
        const preset = DEFAULT_AGENT_PRESETS.find((item) => item.name === presetName);
        if (!preset) {
          skippedCount += 1;
          continue;
        }
        latestProject = await window.agentFlow.saveAgentPrompt({
          projectId: project.project.id,
          currentAgentName: "",
          nextAgentName: preset.name,
          prompt: preset.prompt,
        });
        createdCount += 1;
      }
      if (latestProject) {
        const firstCreated = latestProject.agentFiles.find((agent) => selectedPresetNames.includes(agent.name));
        if (firstCreated) {
          onSelectPath(firstCreated.name);
        }
      }
      setSelectedPresetNames([]);
      setSaveSuccess(`已添加 ${createdCount} 个默认 Agent${skippedCount > 0 ? `，跳过 ${skippedCount} 个已存在项` : ""}。`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "添加默认 Agent 失败");
    } finally {
      setAddingPresets(false);
    }
  }

  async function handleSavePrompt() {
    if (!project || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const nextAgentName = agentName.trim();
      if (isNewAgentCreationLocked && creatingNewAgent) {
        throw new Error("当前 Project 已进入任务驱动阶段，不允许新增 Agent。");
      }
      if (hasTaskRecords && selectedFile && nextAgentName !== selectedFile.name) {
        throw new Error("当前 Project 已进入任务驱动阶段，不允许修改 Agent 名称，仅允许更新 prompt。");
      }
      const updatedProject = await window.agentFlow.saveAgentPrompt({
        projectId: project.project.id,
        currentAgentName: selectedFile?.name ?? "",
        nextAgentName,
        prompt,
      });
      const matchedAgent = updatedProject.agentFiles.find((agent) => agent.name === nextAgentName);
      if (matchedAgent) {
        setAgentName(matchedAgent.name);
        setSavedAgentName(matchedAgent.name);
        onSelectPath(matchedAgent.name);
      } else {
        setAgentName(nextAgentName);
        setSavedAgentName(nextAgentName);
      }
      setSavedPrompt(prompt);
      setSaveSuccess(
        creatingNewAgent ? "创建成功，已写入用户目录配置。" : "保存成功，已写入用户目录配置。",
      );
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAgent() {
    if (!project || !selectedFile || deleting) {
      return;
    }
    if (hasTaskRecords) {
      setSaveError("当前 Project 已进入任务驱动阶段，不允许删除 Agent。");
      setSaveSuccess(null);
      return;
    }
    const confirmed = window.confirm(`确认删除 Agent「${selectedFile.name}」吗？`);
    if (!confirmed) {
      return;
    }
    setDeleting(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const updatedProject = await window.agentFlow.deleteAgent({
        projectId: project.project.id,
        agentName: selectedFile.name,
      });
      const nextViewableAgents = updatedProject.agentFiles.filter(
        (agent) => agent.name !== BUILD_AGENT_NAME,
      );
      onSelectPath(nextViewableAgents[0]?.name ?? NEW_AGENT_DRAFT_PATH);
      setAgentName("");
      setSavedAgentName("");
      setPrompt("");
      setSavedPrompt("");
      setSaveSuccess(`已删除 Agent「${selectedFile.name}」。`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "删除 Agent 失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25" />
        <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 flex h-[min(760px,88vh)] w-[min(1080px,94vw)] min-h-0 -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] p-6">
          <Dialog.Title className="font-display text-2xl font-bold text-primary">
            自定义 Agent Prompt 配置
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            当前项目设计为单一 Build Agent 负责代码改动，且 Build 为默认必选 Agent（不在这里编辑）。
            自定义 Agent 均为建议性 Agent，不参与代码修改。
            自定义 Agent 默认禁用 write / edit / patch / bash / task 工具，且不支持在这里修改工具权限。
            {hasTaskRecords
              ? " 当前 Project 已进入任务驱动阶段：仅允许更新 prompt，名称修改、新增与删除 Agent 已锁定。"
              : ""}
          </Dialog.Description>

          <div className="mt-6 grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-4">
            <div className="min-h-0 rounded-[8px] border border-border bg-card/80 p-3">
              <div className="h-full space-y-2 overflow-y-auto">
                {viewableAgents.map((agent) => (
                  <button
                    key={agent.name}
                    type="button"
                    onClick={() => {
                      onSelectPath(agent.name);
                      onOpenChange(true);
                      setSaveError(null);
                      setSaveSuccess(null);
                    }}
                    className={`w-full rounded-[8px] border px-3 py-3 text-left transition ${
                      selectedPath === agent.name
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-white/70 hover:border-accent"
                    }`}
                  >
                    <p className="text-sm font-semibold">{agent.name}</p>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    onSelectPath(NEW_AGENT_DRAFT_PATH);
                    setAgentName("");
                    setSavedAgentName("");
                    setPrompt("");
                    setSavedPrompt("");
                    setLoadError(null);
                    setSaveError(null);
                    setSaveSuccess(null);
                  }}
                  disabled={isNewAgentCreationLocked}
                  className={`w-full rounded-[8px] border border-dashed px-3 py-2 text-left text-sm transition ${
                    creatingNewAgent
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-white/70 text-foreground/80 hover:border-accent"
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  + 新建 Agent
                </button>
                <div className="mt-3 rounded-[8px] border border-border/70 bg-white/60 px-3 py-3">
                  <p className="text-xs font-semibold text-foreground/85">默认 Agent 模板</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    可勾选并批量添加历史默认模板（仅添加不存在的 Agent）。
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {DEFAULT_AGENT_PRESETS.map((preset) => {
                      const exists = existingAgentNames.has(preset.name);
                      const checked = selectedPresetNames.includes(preset.name);
                      return (
                        <label
                          key={preset.name}
                          className={`flex items-center gap-2 rounded-[6px] px-2 py-1 text-xs ${
                            exists ? "text-muted-foreground/70" : "text-foreground/85"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={exists || isNewAgentCreationLocked || addingPresets}
                            onChange={(event) => {
                              const nextChecked = event.target.checked;
                              setSelectedPresetNames((prev) => {
                                if (nextChecked) {
                                  return prev.includes(preset.name) ? prev : [...prev, preset.name];
                                }
                                return prev.filter((name) => name !== preset.name);
                              });
                            }}
                          />
                          <span className="font-medium">{preset.name}</span>
                          {exists ? <span className="text-[10px]">已存在</span> : null}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleAddPresetAgents();
                    }}
                    disabled={!canAddSelectedPresets}
                    className="mt-2 w-full rounded-[8px] border border-border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {addingPresets ? "添加中..." : "添加选中模板"}
                  </button>
                </div>
                {viewableAgents.length === 0 && (
                  <div className="rounded-[8px] border border-dashed border-border bg-white/50 px-3 py-4 text-sm text-muted-foreground">
                    当前还没有自定义 Agent，点击上方“新建 Agent”开始配置。
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col rounded-[8px] border border-border bg-card/80 p-4">
              <div className="mb-3">
                <p className="font-semibold text-primary">
                  {selectedFile?.name ?? (creatingNewAgent ? "新建 Agent" : "未选择文件")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selectedFile
                    ? "打开时会直接读取最新配置；仅可修改 Agent 名称与 prompt，工具权限固定禁用。"
                    : creatingNewAgent
                      ? "填写 Agent 名称和 prompt 后可直接创建到用户目录配置。"
                      : "这里只查看用户目录下的自定义 Agent 配置。"}
                </p>
                {loadError && <p className="mt-1 text-xs text-[#9a5a2e]">{loadError}</p>}
                {saveError && <p className="mt-1 text-xs text-[#9a5a2e]">{saveError}</p>}
                {saveSuccess && <p className="mt-1 text-xs text-[#2f6b34]">{saveSuccess}</p>}
                {!loadError && selectedFile && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {loading
                      ? "正在读取磁盘..."
                      : hasTaskRecords
                        ? "任务驱动阶段：可编辑 prompt，Agent 名称已锁定。"
                        : hasUnsavedChanges
                          ? "有未保存修改。"
                          : "已与磁盘内容同步。"}
                  </p>
                )}
                {!loadError && creatingNewAgent && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isNewAgentCreationLocked
                      ? "任务驱动后不允许新增 Agent。"
                      : hasUnsavedChanges
                        ? "有未保存修改。"
                        : "请输入 Agent 名称和 prompt。"}
                  </p>
                )}
              </div>
              <label className="mb-3 block">
                <span className="mb-1 block text-xs text-muted-foreground">Agent 名称</span>
                <input
                  value={agentName}
                  onChange={(event) => {
                    setAgentName(event.target.value);
                    if (saveError) {
                      setSaveError(null);
                    }
                    if (saveSuccess) {
                      setSaveSuccess(null);
                    }
                  }}
                  disabled={loading || saving || deleting || isNameEditingLocked}
                  placeholder="输入 Agent 名称"
                  className="w-full rounded-[8px] border border-border bg-white px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              <textarea
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (saveError) {
                    setSaveError(null);
                  }
                  if (saveSuccess) {
                    setSaveSuccess(null);
                  }
                }}
                disabled={isPromptEditingLocked}
                placeholder="在这里编辑当前 Agent 的 prompt..."
                className="min-h-0 flex-1 resize-none rounded-[8px] border border-border bg-[#172019] px-4 py-4 font-mono text-sm leading-6 text-[#F4EFE6] placeholder:text-[#A8B0A6] focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <button
              type="button"
              onClick={() => {
                void handleDeleteAgent();
              }}
              disabled={deleteDisabled}
              className="rounded-[8px] border border-[#c96f3b] px-4 py-2 text-sm text-[#8d4c22] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? "删除中..." : "删除 Agent"}
            </button>
            <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setPrompt(savedPrompt);
                setAgentName(savedAgentName);
                setSaveError(null);
                setSaveSuccess(null);
              }}
              disabled={
                loading
                || saving
                || deleting
                || !hasUnsavedChanges
                || (creatingNewAgent && isNewAgentCreationLocked)
              }
              className="rounded-[8px] border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              还原
            </button>
            <button
              type="button"
              onClick={() => {
                void handleSavePrompt();
              }}
              disabled={saveDisabled}
              className="rounded-[8px] border border-primary bg-primary px-4 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "保存中..." : creatingNewAgent ? "创建 Agent" : "保存 Prompt"}
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
