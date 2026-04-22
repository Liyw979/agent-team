interface EventStreamReconnectContext {
  hasProjectRecord: boolean;
  isDisposing: boolean;
}

export function shouldScheduleEventStreamReconnect(
  context: EventStreamReconnectContext,
): boolean {
  return context.hasProjectRecord && !context.isDisposing;
}
