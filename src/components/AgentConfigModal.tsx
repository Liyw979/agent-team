import React, { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  DEFAULT_BUILTIN_AGENT_TEMPLATES,
  type ProjectSnapshot,
  usesOpenCodeBuiltinPrompt,
} from "@shared/types";

export const NEW_AGENT_DRAFT_PATH = "__agentflow_new_agent__";

const BUILTIN_TEMPLATE_PATH_PREFIX = "__agentflow_builtin_template__:";

function toBuiltinTemplatePath(name: string) {
  return `${BUILTIN_TEMPLATE_PATH_PREFIX}${name}`;
}

function getBuiltinTemplateName(selectedPath: string | null): string | null {
  if (!selectedPath?.startsWith(BUILTIN_TEMPLATE_PATH_PREFIX)) {
    return null;
  }
  return selectedPath.slice(BUILTIN_TEMPLATE_PATH_PREFIX.length) || null;
}

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
  const [isWritable, setIsWritable] = useState(false);
  const [savedIsWritable, setSavedIsWritable] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resettingTemplate, setResettingTemplate] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const viewableAgents = useMemo(
    () => project?.agentFiles ?? [],
    [project],
  );
  const hasTaskRecords = (project?.tasks.length ?? 0) > 0;
  const existingAgentNames = useMemo(
    () => new Set(viewableAgents.map((agent) => agent.name)),
    [viewableAgents],
  );
  const currentWritableAgentName = useMemo(
    () => viewableAgents.find((agent) => agent.isWritable)?.name ?? null,
    [viewableAgents],
  );
  const builtinTemplates = useMemo(
    () => project?.builtinAgentTemplates ?? [],
    [project],
  );
  const selectedTemplateName = useMemo(
    () => getBuiltinTemplateName(selectedPath),
    [selectedPath],
  );
  const selectedFile = useMemo(
    () => viewableAgents.find((agent) => agent.name === selectedPath),
    [selectedPath, viewableAgents],
  );
  const selectedBuiltinTemplate = useMemo(
    () =>
      selectedTemplateName
        ? builtinTemplates.find((template) => template.name === selectedTemplateName) ?? null
        : null,
    [builtinTemplates, selectedTemplateName],
  );
  const selectedAgentDefaultTemplate = useMemo(
    () =>
      selectedFile
        ? DEFAULT_BUILTIN_AGENT_TEMPLATES.find((template) => template.name === selectedFile.name) ?? null
        : null,
    [selectedFile],
  );
  const creatingNewAgent = selectedPath === NEW_AGENT_DRAFT_PATH;
  const editingBuiltinTemplate = Boolean(selectedBuiltinTemplate);
  const creatingBuiltinBuildAgent = creatingNewAgent && usesOpenCodeBuiltinPrompt(agentName);
  const selectedFileUsesBuiltinPrompt = usesOpenCodeBuiltinPrompt(selectedFile?.name ?? "");
  const selectedTemplateUsesBuiltinPrompt = usesOpenCodeBuiltinPrompt(selectedBuiltinTemplate?.name ?? "");
  const buildAgentExists = useMemo(
    () => viewableAgents.some((agent) => usesOpenCodeBuiltinPrompt(agent.name)),
    [viewableAgents],
  );
  const currentSelectionUsesBuiltinPrompt =
    selectedFileUsesBuiltinPrompt || selectedTemplateUsesBuiltinPrompt || creatingBuiltinBuildAgent;
  const isNameEditingLocked =
    hasTaskRecords || editingBuiltinTemplate || selectedFileUsesBuiltinPrompt;
  const isNewAgentCreationLocked = hasTaskRecords;
  const isAnyConfigEditingLocked = hasTaskRecords;
  const isPromptEditingLocked =
    loading
    || saving
    || deleting
    || resettingTemplate
    || isAnyConfigEditingLocked
    || currentSelectionUsesBuiltinPrompt
    || (creatingNewAgent && isNewAgentCreationLocked);

  useEffect(() => {
    if (!creatingNewAgent) {
      return;
    }
    setAgentName("");
    setSavedAgentName("");
    setIsWritable(false);
    setSavedIsWritable(false);
    setPrompt("");
    setSavedPrompt("");
    setLoadError(null);
    setSaveError(null);
    setSaveSuccess(null);
  }, [creatingNewAgent, viewableAgents.length]);

  useEffect(() => {
    if (!creatingBuiltinBuildAgent) {
      return;
    }
    setIsWritable(true);
  }, [creatingBuiltinBuildAgent]);

  useEffect(() => {
    if (selectedPath) {
      return;
    }
    if (viewableAgents[0]) {
      onSelectPath(viewableAgents[0].name);
      return;
    }
    if (builtinTemplates[0]) {
      onSelectPath(toBuiltinTemplatePath(builtinTemplates[0].name));
    }
  }, [builtinTemplates, onSelectPath, selectedPath, viewableAgents]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!project) {
      return;
    }

    if (!selectedFile && !selectedBuiltinTemplate) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    const request = selectedFile
      ? window.agentFlow.readAgentFile({
          projectId: project.project.id,
          agentName: selectedFile.name,
        })
      : window.agentFlow.readBuiltinAgentTemplate({
          projectId: project.project.id,
          templateName: selectedBuiltinTemplate!.name,
        });

    void request
      .then((file) => {
        if (cancelled) {
          return;
        }
        setAgentName(file.name);
        setSavedAgentName(file.name);
        const nextWritable = usesOpenCodeBuiltinPrompt(file.name) || file.isWritable === true;
        setIsWritable(nextWritable);
        setSavedIsWritable(nextWritable);
        setPrompt(file.prompt);
        setSavedPrompt(file.prompt);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const fallback = selectedFile ?? selectedBuiltinTemplate;
        if (fallback) {
          setAgentName(fallback.name);
          setSavedAgentName(fallback.name);
          const nextWritable = usesOpenCodeBuiltinPrompt(fallback.name) || selectedFile?.isWritable === true;
          setIsWritable(nextWritable);
          setSavedIsWritable(nextWritable);
          setPrompt(fallback.prompt);
          setSavedPrompt(fallback.prompt);
        }
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
  }, [
    open,
    project?.project.id,
    selectedPath,
  ]);

  useEffect(() => {
    if (!selectedBuiltinTemplate) {
      return;
    }
    const nextWritable = selectedTemplateUsesBuiltinPrompt;
    setIsWritable(nextWritable);
    setSavedIsWritable(nextWritable);
  }, [selectedBuiltinTemplate, selectedTemplateUsesBuiltinPrompt]);

  const hasUnsavedChanges = creatingNewAgent
    ? Boolean(agentName.trim() || prompt.trim() || isWritable !== savedIsWritable)
    : editingBuiltinTemplate
      ? prompt !== savedPrompt || agentName !== savedAgentName
      : prompt !== savedPrompt || agentName !== savedAgentName || isWritable !== savedIsWritable;
  const isRenamingBlocked = hasTaskRecords
    && !creatingNewAgent
    && !editingBuiltinTemplate
    && Boolean(selectedFile)
    && agentName.trim() !== (selectedFile?.name ?? "");
  const saveDisabled = loading
    || saving
    || deleting
    || resettingTemplate
    || !hasUnsavedChanges
    || !agentName.trim()
    || (editingBuiltinTemplate && selectedTemplateUsesBuiltinPrompt)
    || (creatingNewAgent && isNewAgentCreationLocked)
    || isRenamingBlocked;
  const deleteDisabled =
    loading
    || saving
    || deleting
    || resettingTemplate
    || creatingNewAgent
    || editingBuiltinTemplate
    || !selectedFile
    || hasTaskRecords;
  const resetAgentPromptDisabled =
    loading
    || saving
    || deleting
    || resettingTemplate
    || hasTaskRecords
    || editingBuiltinTemplate
    || !selectedFile
    || selectedFileUsesBuiltinPrompt
    || !selectedAgentDefaultTemplate
    || prompt === selectedAgentDefaultTemplate.prompt;
  const resetTemplateDisabled =
    loading
    || saving
    || deleting
    || resettingTemplate
    || hasTaskRecords
    || !editingBuiltinTemplate
    || selectedTemplateUsesBuiltinPrompt
    || prompt === (builtinTemplates.find((template) => template.name === selectedBuiltinTemplate?.name)?.prompt ?? "");
  const addCurrentTemplateDisabled =
    !editingBuiltinTemplate
    || loading
    || saving
    || deleting
    || resettingTemplate
    || hasTaskRecords
    || isNewAgentCreationLocked
    || !agentName.trim()
    || existingAgentNames.has(selectedBuiltinTemplate?.name ?? "");
  const showResetBuiltinTemplateButton = editingBuiltinTemplate && !selectedTemplateUsesBuiltinPrompt;
  const showResetAgentPromptButton =
    !editingBuiltinTemplate && Boolean(selectedAgentDefaultTemplate) && !selectedFileUsesBuiltinPrompt;
  const showRestoreButton = creatingNewAgent || !editingBuiltinTemplate;
  const showSaveButton = creatingNewAgent || !editingBuiltinTemplate;

  async function handleSavePrompt() {
    if (!project || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      if (editingBuiltinTemplate && selectedBuiltinTemplate) {
        if (selectedTemplateUsesBuiltinPrompt) {
          throw new Error("Build 使用 OpenCode 内置 prompt，不支持在这里保存模板内容。");
        }
        if (hasTaskRecords) {
          throw new Error("当前 Project 已有 Task 启动记录，不允许再修改内置模板。");
        }
        const updatedProject = await window.agentFlow.saveBuiltinAgentTemplate({
          projectId: project.project.id,
          templateName: selectedBuiltinTemplate.name,
          prompt,
        });
        const matchedTemplate = updatedProject.builtinAgentTemplates.find(
          (template) => template.name === selectedBuiltinTemplate.name,
        );
        const nextPrompt = matchedTemplate?.prompt ?? prompt;
        setAgentName(selectedBuiltinTemplate.name);
        setSavedAgentName(selectedBuiltinTemplate.name);
        setPrompt(nextPrompt);
        setSavedPrompt(nextPrompt);
        setSaveSuccess("保存成功，已更新当前 Project 的内置模板覆盖，不会影响新项目默认值。");
        return;
      }

      const nextAgentName = agentName.trim();
      const nextIsWritable = usesOpenCodeBuiltinPrompt(nextAgentName) ? true : isWritable;
      if (hasTaskRecords) {
        throw new Error("当前 Project 已有 Task 启动记录，不允许再修改 Agent 配置。");
      }
      const updatedProject = await window.agentFlow.saveAgentPrompt({
        projectId: project.project.id,
        currentAgentName: selectedFile?.name ?? "",
        nextAgentName,
        prompt,
        isWritable: nextIsWritable,
      });
      const matchedAgent = updatedProject.agentFiles.find((agent) => agent.name === nextAgentName);
      if (matchedAgent) {
        setAgentName(matchedAgent.name);
        setSavedAgentName(matchedAgent.name);
        setIsWritable(matchedAgent.isWritable === true);
        setSavedIsWritable(matchedAgent.isWritable === true);
        onSelectPath(matchedAgent.name);
      } else {
        setAgentName(nextAgentName);
        setSavedAgentName(nextAgentName);
        setSavedIsWritable(isWritable);
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

  async function handleAddCurrentTemplateAsAgent() {
    if (!project || !selectedBuiltinTemplate || saving || isNewAgentCreationLocked) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      if (!selectedTemplateUsesBuiltinPrompt) {
        await window.agentFlow.saveBuiltinAgentTemplate({
          projectId: project.project.id,
          templateName: selectedBuiltinTemplate.name,
          prompt,
        });
      }
      const updatedProject = await window.agentFlow.saveAgentPrompt({
        projectId: project.project.id,
        currentAgentName: "",
        nextAgentName: selectedBuiltinTemplate.name,
        prompt,
        isWritable: selectedTemplateUsesBuiltinPrompt,
      });
      const matchedAgent = updatedProject.agentFiles.find(
        (agent) => agent.name === selectedBuiltinTemplate.name,
      );
      if (!matchedAgent) {
        throw new Error(`写入 Agent 失败：${selectedBuiltinTemplate.name}`);
      }
      setAgentName(matchedAgent.name);
      setSavedAgentName(matchedAgent.name);
      setIsWritable(matchedAgent.isWritable === true);
      setSavedIsWritable(matchedAgent.isWritable === true);
      setPrompt(matchedAgent.prompt);
      setSavedPrompt(matchedAgent.prompt);
      onSelectPath(matchedAgent.name);
      setSelectedPresetNames((prev) => prev.filter((name) => name !== matchedAgent.name));
      setSaveSuccess(`已将内置模板「${matchedAgent.name}」写入当前 Project。`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "写入 Agent 失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetBuiltinTemplate() {
    if (!project || !selectedBuiltinTemplate || resettingTemplate) {
      return;
    }
    if (selectedTemplateUsesBuiltinPrompt) {
      setSaveError("Build 使用 OpenCode 内置 prompt，不支持在这里恢复模板。");
      setSaveSuccess(null);
      return;
    }
    if (hasTaskRecords) {
      setSaveError("当前 Project 已有 Task 启动记录，不允许再修改内置模板。");
      setSaveSuccess(null);
      return;
    }
    setResettingTemplate(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const updatedProject = await window.agentFlow.resetBuiltinAgentTemplate({
        projectId: project.project.id,
        templateName: selectedBuiltinTemplate.name,
      });
      const matchedTemplate = updatedProject.builtinAgentTemplates.find(
        (template) => template.name === selectedBuiltinTemplate.name,
      );
      const nextPrompt = matchedTemplate?.prompt ?? "";
      setAgentName(selectedBuiltinTemplate.name);
      setSavedAgentName(selectedBuiltinTemplate.name);
      setPrompt(nextPrompt);
      setSavedPrompt(nextPrompt);
      setSaveSuccess("已恢复为默认模板内容，不会影响其他项目。");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "恢复默认模板失败");
    } finally {
      setResettingTemplate(false);
    }
  }

  async function handleResetAgentPromptToDefault() {
    if (!project || !selectedFile || !selectedAgentDefaultTemplate || saving) {
      return;
    }
    if (selectedFileUsesBuiltinPrompt) {
      setSaveError("Build 使用 OpenCode 内置 prompt，不支持在这里恢复 Prompt。");
      setSaveSuccess(null);
      return;
    }
    if (hasTaskRecords) {
      setSaveError("当前 Project 已有 Task 启动记录，不允许再修改 Agent 配置。");
      setSaveSuccess(null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const updatedProject = await window.agentFlow.saveAgentPrompt({
        projectId: project.project.id,
        currentAgentName: selectedFile.name,
        nextAgentName: selectedFile.name,
        prompt: selectedAgentDefaultTemplate.prompt,
        isWritable: selectedFile.isWritable === true,
      });
      const matchedAgent = updatedProject.agentFiles.find((agent) => agent.name === selectedFile.name);
      const nextPrompt = matchedAgent?.prompt ?? selectedAgentDefaultTemplate.prompt;
      setAgentName(selectedFile.name);
      setSavedAgentName(selectedFile.name);
      setIsWritable(matchedAgent?.isWritable === true);
      setSavedIsWritable(matchedAgent?.isWritable === true);
      setPrompt(nextPrompt);
      setSavedPrompt(nextPrompt);
      setSaveSuccess("已恢复为默认 Prompt。");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "恢复默认 Prompt 失败");
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
      const nextViewableAgents = updatedProject.agentFiles;
      const restoredTemplate = updatedProject.builtinAgentTemplates.find(
        (template) => template.name === selectedFile.name,
      );
      onSelectPath(nextViewableAgents[0]?.name ?? (restoredTemplate ? toBuiltinTemplatePath(restoredTemplate.name) : NEW_AGENT_DRAFT_PATH));
      setAgentName("");
      setSavedAgentName("");
      setIsWritable(false);
      setSavedIsWritable(false);
      setPrompt("");
      setSavedPrompt("");
      setSaveSuccess(`已删除 Agent「${selectedFile.name}」。`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "删除 Agent 失败");
    } finally {
      setDeleting(false);
    }
  }

  const detailTitle = selectedFile?.name
    ?? selectedBuiltinTemplate?.name
    ?? (creatingNewAgent ? "新建 Agent" : "未选择文件");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/25" />
        <Dialog.Content className="PANEL-surface fixed left-1/2 top-1/2 flex h-[min(760px,88vh)] w-[min(1080px,94vw)] min-h-0 -translate-x-1/2 -translate-y-1/2 flex-col rounded-[10px] p-6">
          <Dialog.Title className="font-display text-2xl font-bold text-primary">
            自定义 Agent Prompt 配置
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            Build 现作为默认内置模板提供，可按需写入当前 Project，也可像其他已写入 Agent 一样删除。
            <br />
            当前 Project 可以不设置可写 Agent；但一旦写入 Build，Build 会固定为唯一可写 Agent。
            <br />
            内置模板会一直保留在这里供选择；其中 Build 使用 OpenCode 自带 prompt，这里只负责选择是否加入当前 Project。
            {hasTaskRecords
              ? " 当前 Project 已有 Task 启动记录：Agent 与内置模板均不允许再修改。"
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
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold">{agent.name}</p>
                      {agent.isWritable && (
                        <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold">
                          唯一可写
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    onSelectPath(NEW_AGENT_DRAFT_PATH);
                    setAgentName("");
                    setSavedAgentName("");
                    setIsWritable(false);
                    setSavedIsWritable(false);
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
                  <p className="text-xs font-semibold text-foreground/85">内置 Agent 模板</p>
                  <div className="mt-2 space-y-1.5">
                    {builtinTemplates.map((template) => {
                      const exists = existingAgentNames.has(template.name);
                      const isSelected = selectedPath === toBuiltinTemplatePath(template.name);
                      return (
                        <div
                          key={template.name}
                          className={`rounded-[6px] border px-2 py-2 ${
                            isSelected ? "border-primary/50 bg-primary/10" : "border-border/60 bg-white/40"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectPath(toBuiltinTemplatePath(template.name));
                                onOpenChange(true);
                                setSaveError(null);
                                setSaveSuccess(null);
                              }}
                              className="min-w-0 flex-1 text-left text-xs font-medium text-foreground/90"
                            >
                              {template.name}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                onSelectPath(toBuiltinTemplatePath(template.name));
                                onOpenChange(true);
                                setSaveError(null);
                                setSaveSuccess(null);
                              }}
                              className="shrink-0 rounded-[6px] border border-border px-2 py-1 text-[10px] text-foreground/75"
                            >
                              编辑
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {viewableAgents.length === 0 && !creatingNewAgent && builtinTemplates.length === 0 && (
                  <div className="rounded-[8px] border border-dashed border-border bg-white/50 px-3 py-4 text-sm text-muted-foreground">
                    当前还没有自定义 Agent，也没有可写入的内置模板。
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col rounded-[8px] border border-border bg-card/80 p-4">
              <div className="mb-3">
                <p className="font-semibold text-primary">{detailTitle}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedFile
                    ? selectedFileUsesBuiltinPrompt
                      ? "这是已写入当前 Project 的 Build Agent。它继续使用 OpenCode 内置 prompt，并固定为当前 Project 的唯一可写 Agent；如需移除可直接删除。"
                      : ""
                    : selectedBuiltinTemplate
                      ? selectedTemplateUsesBuiltinPrompt
                        ? "这是 opencode 的 build agent，不可修改配置。"
                        : "这是当前 Project 的内置模板入口。保存这里只会更新模板本身，不会自动创建 Agent，而且内置模板不能在这里设为可写 Agent。"
                      : creatingNewAgent
                        ? ""
                        : "请选择左侧已有 Agent，或选择一个内置模板继续编辑。"}
                </p>
                {loadError && <p className="mt-1 text-xs text-[#9a5a2e]">{loadError}</p>}
                {saveError && <p className="mt-1 text-xs text-[#9a5a2e]">{saveError}</p>}
                {saveSuccess && <p className="mt-1 text-xs text-[#2f6b34]">{saveSuccess}</p>}
                {!loadError
                  && (selectedFile || selectedBuiltinTemplate)
                  && !(editingBuiltinTemplate && selectedTemplateUsesBuiltinPrompt)
                  && !(selectedFile && !selectedFileUsesBuiltinPrompt) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {loading
                      ? "正在读取磁盘..."
                      : currentSelectionUsesBuiltinPrompt
                        ? hasUnsavedChanges
                            ? "Build 会固定保持可写；保存后仍会是当前 Project 的唯一可写 Agent。"
                            : "该 Agent 使用 OpenCode 内置 prompt，并固定保持可写；如需移除请直接删除。"
                        : editingBuiltinTemplate
                          ? hasUnsavedChanges
                            ? "模板有未保存修改。"
                          : "当前模板已与项目配置同步；内置模板不能在这里设为可写 Agent。"
                        : hasTaskRecords
                          ? "当前 Project 已有 Task 启动记录：配置已锁定。"
                          : hasUnsavedChanges
                            ? "有未保存修改。"
                            : "已与磁盘内容同步。"}
                  </p>
                )}
                {!loadError && creatingNewAgent && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isNewAgentCreationLocked
                      ? "当前 Project 已有 Task 启动记录：不允许新增 Agent。"
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
                  disabled={loading || saving || deleting || resettingTemplate || isNameEditingLocked}
                  placeholder="输入 Agent 名称"
                  className="w-full rounded-[8px] border border-border bg-white px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </label>
              {!editingBuiltinTemplate && (
                <label className="mb-3 flex items-center gap-3 rounded-[8px] border border-border/70 bg-white/70 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={isWritable}
                    className="shrink-0"
                    disabled={loading || saving || deleting || resettingTemplate || hasTaskRecords || buildAgentExists || creatingBuiltinBuildAgent}
                    onChange={(event) => {
                      setIsWritable(event.target.checked);
                      if (saveError) {
                        setSaveError(null);
                      }
                      if (saveSuccess) {
                        setSaveSuccess(null);
                      }
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">设为可写 Agent（1 个Project 中最多有1个可写 Agent，避免冲突）</span>
                  </span>
                </label>
              )}
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
                placeholder={
                  currentSelectionUsesBuiltinPrompt
                    ? "Build Agent 的 prompt 由 OpenCode 内置提供，这里不支持编辑。"
                    : editingBuiltinTemplate
                      ? "在这里编辑当前内置模板的 prompt..."
                      : "在这里编辑当前 Agent 的 prompt..."
                }
                className="min-h-0 flex-1 resize-none rounded-[8px] border border-border bg-[#172019] px-4 py-4 font-mono text-sm leading-6 text-[#F4EFE6] placeholder:text-[#A8B0A6] focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            {showResetBuiltinTemplateButton ? (
              <button
                type="button"
                onClick={() => {
                  void handleResetBuiltinTemplate();
                }}
                disabled={resetTemplateDisabled}
                className="rounded-[8px] border border-[#c96f3b] px-4 py-2 text-sm text-[#8d4c22] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resettingTemplate ? "恢复中..." : "恢复默认模板"}
              </button>
            ) : !editingBuiltinTemplate ? (
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
            ) : (
              <div />
            )}
            <div className="flex items-center gap-3">
              {showResetAgentPromptButton && (
                <button
                  type="button"
                  onClick={() => {
                    void handleResetAgentPromptToDefault();
                  }}
                  disabled={resetAgentPromptDisabled}
                  className="rounded-[8px] border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  恢复默认 Prompt
                </button>
              )}
              {editingBuiltinTemplate && (
                <button
                  type="button"
                  onClick={() => {
                    void handleAddCurrentTemplateAsAgent();
                  }}
                  disabled={addCurrentTemplateDisabled}
                  className="rounded-[8px] border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  添加为项目成员
                </button>
              )}
              {showRestoreButton && (
                <button
                  type="button"
                  onClick={() => {
                    setPrompt(savedPrompt);
                    setAgentName(savedAgentName);
                    setIsWritable(savedIsWritable);
                    setSaveError(null);
                    setSaveSuccess(null);
                  }}
                  disabled={
                    loading
                    || saving
                    || deleting
                    || resettingTemplate
                    || !hasUnsavedChanges
                    || (creatingNewAgent && isNewAgentCreationLocked)
                  }
                  className="rounded-[8px] border border-border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  还原
                </button>
              )}
              {showSaveButton && (
                <button
                  type="button"
                  onClick={() => {
                    void handleSavePrompt();
                  }}
                  disabled={saveDisabled}
                  className="rounded-[8px] border border-primary bg-primary px-4 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving
                    ? "保存中..."
                    : creatingNewAgent
                      ? "创建 Agent"
                      : editingBuiltinTemplate
                        ? "保存模板"
                        : selectedFileUsesBuiltinPrompt
                          ? "保存配置"
                          : "保存 Prompt"}
                </button>
              )}
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
