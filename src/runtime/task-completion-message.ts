import type { TaskRecord } from "@shared/types";

export function buildTaskCompletionMessageContent(input: {
  status: TaskRecord["status"];
  taskTitle: string;
  failureReason?: string | null;
}): string {
  if (input.status === "finished") {
    return "所有Agent任务已完成";
  }

  const failureReason = input.failureReason?.trim();
  if (failureReason) {
    return failureReason;
  }

  return `Task「${input.taskTitle}」已结束，本轮仍有待继续处理的问题，或执行过程已中断。请直接查看群聊中最近一条失败消息，并继续处理状态为“继续处理”或“执行失败”的 Agent。`;
}
