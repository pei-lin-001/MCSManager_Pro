import { useDefineApi } from "@/stores/useDefineApi";
import { useAppStateStore } from "@/stores/useAppStateStore";

export type AiActionType = "open" | "stop" | "restart" | "command";
export type AiThinkingEffort = "off" | "low" | "medium" | "high";

export interface AiProposedAction {
  type: AiActionType;
  command?: string;
  reason: string;
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiStatus {
  enabled: boolean;
  configured: boolean;
  allowActions: boolean;
  streamEnabled: boolean;
  showThinking: boolean;
  thinkingEffort: AiThinkingEffort;
  model: string;
  apiBaseUrl: string;
}

export interface AiPublicConfig {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  systemPrompt: string;
  maxLogChars: number;
  allowActions: boolean;
  streamEnabled: boolean;
  showThinking: boolean;
  thinkingEffort: AiThinkingEffort;
  provider: string;
  hasApiKey: boolean;
}

export interface AiChatContext {
  instanceName: string;
  status: number;
  type: string;
  logIncluded: boolean;
  thinkingEffort: AiThinkingEffort;
  stream: boolean;
}

export interface AiChatResponse {
  reply: string;
  thinking: string;
  actions: AiProposedAction[];
  context: AiChatContext;
}

export interface AiExecuteResponse {
  ok: boolean;
  message: string;
  result?: unknown;
}

export type AiStreamEvent =
  | {
      type: "meta";
      context: AiChatContext;
    }
  | {
      type: "thinking";
      delta: string;
    }
  | {
      type: "delta";
      delta: string;
    }
  | {
      type: "done";
      reply: string;
      thinking: string;
      actions: AiProposedAction[];
      context: AiChatContext;
    }
  | {
      type: "error";
      message: string;
    };

export const aiStatusApi = useDefineApi<undefined, AiStatus>({
  url: "/api/ai/status",
  method: "GET"
});

export const aiConfigApi = useDefineApi<undefined, AiPublicConfig>({
  url: "/api/ai/config",
  method: "GET"
});

export const updateAiConfigApi = useDefineApi<
  {
    data: {
      enabled?: boolean;
      apiBaseUrl?: string;
      apiKey?: string;
      model?: string;
      systemPrompt?: string;
      maxLogChars?: number;
      allowActions?: boolean;
      streamEnabled?: boolean;
      showThinking?: boolean;
      thinkingEffort?: AiThinkingEffort;
    };
  },
  AiPublicConfig
>({
  url: "/api/ai/config",
  method: "PUT"
});

export const aiChatApi = useDefineApi<
  {
    data: {
      daemonId: string;
      instanceUuid: string;
      message: string;
      history?: AiChatMessage[];
      includeLog?: boolean;
      thinkingEffort?: AiThinkingEffort;
    };
  },
  AiChatResponse
>({
  url: "/api/ai/chat",
  method: "POST"
});

export const aiExecuteApi = useDefineApi<
  {
    data: {
      daemonId: string;
      instanceUuid: string;
      action: AiProposedAction;
    };
  },
  AiExecuteResponse
>({
  url: "/api/ai/execute",
  method: "POST"
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStreamEvent(payload: string): AiStreamEvent | null {
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return parsed as AiStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Stream AI chat via SSE.
 * Uses fetch (not axios) so the browser can read the response body incrementally.
 */
export async function streamAiChat(options: {
  daemonId: string;
  instanceUuid: string;
  message: string;
  history?: AiChatMessage[];
  includeLog?: boolean;
  thinkingEffort?: AiThinkingEffort;
  signal?: AbortSignal;
  onEvent: (event: AiStreamEvent) => void;
}): Promise<void> {
  const { state } = useAppStateStore();
  const token = state.userInfo?.token || "";
  const url = `/api/ai/chat/stream?token=${encodeURIComponent(token)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      daemonId: options.daemonId,
      instanceUuid: options.instanceUuid,
      message: options.message,
      history: options.history || [],
      includeLog: options.includeLog !== false,
      thinkingEffort: options.thinkingEffort
    }),
    signal: options.signal,
    credentials: "include"
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isRecord(parsed) && typeof parsed.data === "string") detail = parsed.data;
          else if (isRecord(parsed) && typeof parsed.message === "string") detail = parsed.message;
          else detail = text.slice(0, 300);
        } catch {
          detail = text.slice(0, 300);
        }
      }
    } catch {
      // ignore body parse failures
    }
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error("Streaming is not supported in this browser");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        const event = parseStreamEvent(payload);
        if (event) options.onEvent(event);
        if (event?.type === "error") {
          throw new Error(event.message || "AI stream error");
        }
      }
    }
  }

  // Flush trailing buffer if provider closed without blank line.
  if (buffer.trim()) {
    const lines = buffer.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      const event = parseStreamEvent(payload);
      if (event) options.onEvent(event);
      if (event?.type === "error") {
        throw new Error(event.message || "AI stream error");
      }
    }
  }
}
