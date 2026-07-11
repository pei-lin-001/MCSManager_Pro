import { useDefineApi } from "@/stores/useDefineApi";
import { useAppStateStore } from "@/stores/useAppStateStore";

export type McLoaderId = "vanilla" | "fabric" | "forge" | "neoforge" | "paper";

export interface McLoaderInfo {
  id: McLoaderId;
  name: string;
  description: string;
  supportsBuildSelect: boolean;
}

export interface McVersionItem {
  id: string;
  type?: string;
  releaseTime?: string;
  stable?: boolean;
  recommendedJava?: number;
}

export interface McBuildItem {
  id: string;
  label: string;
  stable?: boolean;
  time?: string;
}

export interface McInstallPlan {
  loader: McLoaderId;
  mcVersion: string;
  buildId?: string;
  title: string;
  targetLink: string;
  recommendedJava: number;
  setupInfo: Record<string, unknown>;
  memory?: {
    xms: string;
    xmx: string;
    xmsMb: number;
    xmxMb: number;
  };
  dockerOptional?: {
    image: string;
    updateCommandImage: string;
    workingDir?: string;
    changeWorkdir?: boolean;
    ports?: string[];
  };
}

export interface McInstallStep {
  id: string;
  status: "pending" | "running" | "done" | "error" | "skipped";
  message: string;
}

export interface McInstallMemory {
  xms: string;
  xmx: string;
  xmsMb: number;
  xmxMb: number;
  hostMemoryMb: number;
  preferredXmxMb: number;
  reduced: boolean;
}

export interface McInstallJava {
  id: string;
  version: number;
  source: "managed" | "system" | "downloaded";
  command: string;
  hostMemoryMb: number;
  hostFreeMemoryMb: number;
}

export interface McInstallTrial {
  ok: boolean;
  status: number;
  message: string;
  logTail?: string;
}

export interface McInstallResponse {
  ok: boolean;
  plan: McInstallPlan;
  task: {
    instanceUuid?: string;
    taskId?: string;
    status?: number;
    [k: string]: unknown;
  };
  java?: McInstallJava | null;
  memory?: McInstallMemory;
  steps?: McInstallStep[];
  trial?: McInstallTrial;
  instanceUuid?: string;
  error?: string;
}

export type McInstallStreamEvent =
  | { type: "step"; steps: McInstallStep[] }
  | {
      type: "result";
      ok: boolean;
      plan?: McInstallPlan;
      task?: McInstallResponse["task"];
      java?: McInstallJava | null;
      memory?: McInstallMemory;
      steps: McInstallStep[];
      trial?: McInstallTrial;
      instanceUuid?: string;
      error?: string;
    }
  | { type: "error"; message: string };

export const getMcLoaders = useDefineApi<undefined, McLoaderInfo[]>({
  url: "/api/mc_precise/loaders",
  method: "GET"
});

export const getMcVersions = useDefineApi<
  {
    params: { loader: string };
  },
  McVersionItem[]
>({
  url: "/api/mc_precise/versions",
  method: "GET"
});

export const getMcBuilds = useDefineApi<
  {
    params: { loader: string; mcVersion: string };
  },
  McBuildItem[]
>({
  url: "/api/mc_precise/builds",
  method: "GET"
});

export const createMcPreciseInstall = useDefineApi<
  {
    params: { daemonId: string };
    data: {
      loader: string;
      mcVersion: string;
      buildId?: string;
      newInstanceName: string;
      useDocker?: boolean;
      autoStart?: boolean;
      waitForInstall?: boolean;
    };
  },
  McInstallResponse
>({
  url: "/api/mc_precise/install",
  method: "POST"
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStreamEvent(payload: string): McInstallStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    return parsed as McInstallStreamEvent;
  } catch {
    return null;
  }
}

/**
 * Stream precise install progress via SSE.
 */
export async function streamMcPreciseInstall(options: {
  daemonId: string;
  loader: string;
  mcVersion: string;
  buildId?: string;
  newInstanceName: string;
  useDocker?: boolean;
  autoStart?: boolean;
  waitForInstall?: boolean;
  signal?: AbortSignal;
  onEvent: (event: McInstallStreamEvent) => void;
}): Promise<McInstallResponse | null> {
  const { state } = useAppStateStore();
  const token = state.userInfo?.token || "";
  const url = `/api/mc_precise/install/stream?daemonId=${encodeURIComponent(
    options.daemonId
  )}&token=${encodeURIComponent(token)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/event-stream"
    },
    body: JSON.stringify({
      loader: options.loader,
      mcVersion: options.mcVersion,
      buildId: options.buildId,
      newInstanceName: options.newInstanceName,
      useDocker: options.useDocker,
      autoStart: options.autoStart,
      waitForInstall: options.waitForInstall
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
      // ignore
    }
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error("Streaming is not supported in this browser");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalResult: McInstallResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const event = parseStreamEvent(payload);
        if (!event) continue;
        options.onEvent(event);
        if (event.type === "result") {
          finalResult = {
            ok: event.ok,
            plan: (event.plan || {}) as McInstallPlan,
            task: event.task || {},
            java: event.java,
            memory: event.memory,
            steps: event.steps,
            trial: event.trial,
            instanceUuid: event.instanceUuid,
            error: event.error
          };
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }
  }
  return finalResult;
}
