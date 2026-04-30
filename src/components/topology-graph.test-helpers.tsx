import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type {
  TaskSnapshot,
  WorkspaceSnapshot,
} from "@shared/types";

import { TopologyGraph } from "./TopologyGraph";

type GlobalDomPatchKey =
  | "window"
  | "document"
  | "navigator"
  | "HTMLElement"
  | "HTMLDivElement"
  | "HTMLButtonElement"
  | "Node"
  | "Event"
  | "MouseEvent"
  | "KeyboardEvent"
  | "ResizeObserver"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "getComputedStyle"
  | "IS_REACT_ACT_ENVIRONMENT";

type GlobalDomPatch = {
  existed: boolean;
  value: unknown;
};

interface RenderTopologyGraphInput {
  workspace: WorkspaceSnapshot;
  task: TaskSnapshot;
  selectedAgentId: string | null;
  openingAgentTerminalId: string;
  onSelectAgent: (agentId: string) => void;
  onToggleMaximize: () => void;
  onOpenAgentTerminal?: (agentId: string) => void;
}

function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const previousValues = new Map<GlobalDomPatchKey, GlobalDomPatch>();
  let nextAnimationFrameId = 1;
  const pendingAnimationFrames = new Map<number, FrameRequestCallback>();

  function setGlobal(key: GlobalDomPatchKey, value: unknown) {
    previousValues.set(key, {
      existed: key in globalThis,
      value: (globalThis as Record<string, unknown>)[key],
    });
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class MockResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("navigator", window.navigator);
  setGlobal("HTMLElement", window.HTMLElement);
  setGlobal("HTMLDivElement", window.HTMLDivElement);
  setGlobal("HTMLButtonElement", window.HTMLButtonElement);
  setGlobal("Node", window.Node);
  setGlobal("Event", window.Event);
  setGlobal("MouseEvent", window.MouseEvent);
  setGlobal("KeyboardEvent", window.KeyboardEvent);
  setGlobal("ResizeObserver", MockResizeObserver);
  setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frameId = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    pendingAnimationFrames.set(frameId, callback);
    return frameId;
  });
  setGlobal("cancelAnimationFrame", (handle: number) => {
    pendingAnimationFrames.delete(handle);
  });
  setGlobal("getComputedStyle", window.getComputedStyle.bind(window));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return {
    window,
    async flushAnimationFrames() {
      const callbacks = Array.from(pendingAnimationFrames.values());
      pendingAnimationFrames.clear();
      for (const callback of callbacks) {
        callback(window.performance.now());
      }
      await Promise.resolve();
    },
    cleanup() {
      for (const [key, patch] of previousValues) {
        if (patch.existed) {
          Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value: patch.value,
          });
          continue;
        }
        delete (globalThis as Record<string, unknown>)[key];
      }
      dom.window.close();
    },
  };
}

export async function renderTopologyGraphInDom(input: RenderTopologyGraphInput) {
  const dom = setupDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  async function render(nextInput: RenderTopologyGraphInput) {
    await act(async () => {
      root.render(
        <TopologyGraph
          workspace={nextInput.workspace}
          task={nextInput.task}
          selectedAgentId={nextInput.selectedAgentId}
          onSelectAgent={nextInput.onSelectAgent}
          onToggleMaximize={nextInput.onToggleMaximize}
          openingAgentTerminalId={nextInput.openingAgentTerminalId}
          {...(nextInput.onOpenAgentTerminal ? { onOpenAgentTerminal: nextInput.onOpenAgentTerminal } : {})}
        />,
      );
    });
  }

  await render(input);

  return {
    window: dom.window,
    flushAnimationFrames: dom.flushAnimationFrames,
    render,
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      dom.cleanup();
    },
  };
}
