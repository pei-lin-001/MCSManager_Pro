import Router from "@koa/router";
import AiConfig, { type AiThinkingEffort } from "../entity/ai_config";
import { ROLE } from "../entity/user";
import { speedLimit } from "../middleware/limit";
import permission from "../middleware/permission";
import validator from "../middleware/validator";
import {
  getAiConfig,
  initAiConfig,
  normalizeThinkingEffort,
  saveAiConfig,
  toPublicAiConfig
} from "../service/ai_config_service";
import {
  chatWithAi,
  createSseStream,
  diagnoseReadyState,
  executeAiAction,
  streamChatWithAi,
  type AiActionType,
  type AiChatMessage,
  type AiProposedAction
} from "../service/ai_service";
import { getUserUuid } from "../service/passport_service";
import { isHaveInstanceByUuid } from "../service/permission_service";

const router = new Router({ prefix: "/ai" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseHistory(value: unknown): AiChatMessage[] {
  if (!Array.isArray(value)) return [];
  const history: AiChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const role = readString(item.role);
    const content = readString(item.content).trim();
    if ((role === "user" || role === "assistant") && content) {
      history.push({ role, content });
    }
  }
  return history;
}

function parseAction(value: unknown): AiProposedAction {
  if (!isRecord(value)) {
    throw new Error("Invalid action payload");
  }
  const type = readString(value.type) as AiActionType;
  const allowed = [
    "open",
    "stop",
    "restart",
    "kill",
    "command",
    "install_mod",
    "toggle_mod",
    "delete_mod",
    "list_files",
    "read_file",
    "write_file",
    "delete_files",
    "mkdir",
    "download_file",
    "accept_eula",
    "update_instance_config",
    "get_logs",
    "list_mods",
    "action_chain"
  ];
  if (!allowed.includes(type)) {
    throw new Error("Invalid action type");
  }
  const action: AiProposedAction = {
    type,
    reason: readString(value.reason, "Confirmed by operator")
  };
  if (type === "command") {
    action.command = readString(value.command).trim();
  }
  if (type === "install_mod") {
    action.modQuery = readString(value.modQuery).trim() || undefined;
    action.projectId = readString(value.projectId).trim() || undefined;
    action.source = readString(value.source).trim() || undefined;
    action.versionId = readString(value.versionId).trim() || undefined;
    action.gameVersion = readString(value.gameVersion).trim() || undefined;
    action.loader = readString(value.loader).trim() || undefined;
    const projectType = readString(value.projectType).trim().toLowerCase();
    if (projectType === "mod" || projectType === "plugin") {
      action.projectType = projectType;
    }
    action.url = readString(value.url).trim() || undefined;
    action.fileName = readString(value.fileName).trim() || undefined;
    action.fallbackUrl = readString(value.fallbackUrl).trim() || undefined;
    action.projectName = readString(value.projectName).trim() || undefined;
    action.versionName = readString(value.versionName).trim() || undefined;
  }
  if (type === "toggle_mod" || type === "delete_mod") {
    action.fileName = readString(value.fileName).trim() || undefined;
  }
  if (
    type === "list_files" ||
    type === "read_file" ||
    type === "write_file" ||
    type === "mkdir" ||
    type === "download_file" ||
    type === "delete_files"
  ) {
    action.path = readString(value.path).trim() || undefined;
    action.target = readString(value.target).trim() || undefined;
    action.fileName = readString(value.fileName).trim() || undefined;
    action.content = typeof value.content === "string" ? value.content : undefined;
    action.url = readString(value.url).trim() || undefined;
    if (Array.isArray(value.targets)) {
      action.targets = value.targets.map((v) => String(v));
    }
    if (typeof value.page === "number") action.page = value.page;
    if (typeof value.pageSize === "number") action.pageSize = value.pageSize;
    if (typeof value.maxChars === "number") action.maxChars = value.maxChars;
  }
  if (type === "get_logs" || type === "list_mods") {
    if (typeof value.page === "number") action.page = value.page;
    if (typeof value.pageSize === "number") action.pageSize = value.pageSize;
    if (typeof value.maxChars === "number") action.maxChars = value.maxChars;
  }
  if (type === "update_instance_config" && isRecord(value.configPatch)) {
    action.configPatch = value.configPatch;
  }
  if (type === "action_chain") {
    action.title = readString(value.title).trim() || undefined;
    action.stopOnError = value.stopOnError !== false;
    const rawSteps = Array.isArray(value.steps) ? value.steps : [];
    action.steps = rawSteps.map((step) => parseAction(step));
  }
  return action;
}

function parseThinkingEffort(value: unknown): AiThinkingEffort | undefined {
  if (value == null || value === "") return undefined;
  return normalizeThinkingEffort(value, "medium");
}

function assertInstanceAccess(userUuid: string, daemonId: string, instanceUuid: string): void {
  if (!isHaveInstanceByUuid(userUuid, daemonId, instanceUuid)) {
    throw new Error("Forbidden instance");
  }
}

function parseChatBody(body: unknown): {
  daemonId: string;
  instanceUuid: string;
  message: string;
  history: AiChatMessage[];
  includeLog: boolean;
  thinkingEffort?: AiThinkingEffort;
} {
  if (!isRecord(body)) {
    throw new Error("Invalid request body");
  }
  const daemonId = String(body.daemonId || "");
  const instanceUuid = String(body.instanceUuid || "");
  const message = String(body.message || "").trim();
  if (!daemonId || !instanceUuid) {
    throw new Error("daemonId and instanceUuid are required");
  }
  if (!message) {
    throw new Error("Message is required");
  }
  if (message.length > 4000) {
    throw new Error("Message is too long");
  }
  return {
    daemonId,
    instanceUuid,
    message,
    history: parseHistory(body.history),
    includeLog: body.includeLog !== false,
    thinkingEffort: parseThinkingEffort(body.thinkingEffort)
  };
}

// Public AI status for UI (no secrets)
router.get("/status", permission({ level: ROLE.USER }), async (ctx) => {
  initAiConfig();
  ctx.body = diagnoseReadyState();
});

// Admin-only full config (apiKey masked as hasApiKey)
router.get("/config", permission({ level: ROLE.ADMIN }), async (ctx) => {
  initAiConfig();
  ctx.body = toPublicAiConfig(getAiConfig());
});

// Admin-only update AI config
router.put("/config", permission({ level: ROLE.ADMIN }), async (ctx) => {
  initAiConfig();
  const body = ctx.request.body;
  if (!isRecord(body)) {
    throw new Error("Invalid request body");
  }

  const current = getAiConfig();
  const next = new AiConfig();
  next.enabled = body.enabled != null ? Boolean(body.enabled) : current.enabled;
  next.apiBaseUrl =
    body.apiBaseUrl != null ? String(body.apiBaseUrl).trim() : current.apiBaseUrl;
  next.model = body.model != null ? String(body.model).trim() : current.model;
  next.systemPrompt =
    body.systemPrompt != null ? String(body.systemPrompt) : current.systemPrompt;
  next.maxLogChars =
    body.maxLogChars != null ? Number(body.maxLogChars) || 12000 : current.maxLogChars;
  next.allowActions =
    body.allowActions != null ? Boolean(body.allowActions) : current.allowActions;
  next.streamEnabled =
    body.streamEnabled != null ? Boolean(body.streamEnabled) : current.streamEnabled;
  next.showThinking =
    body.showThinking != null ? Boolean(body.showThinking) : current.showThinking;
  next.thinkingEffort =
    body.thinkingEffort != null
      ? normalizeThinkingEffort(body.thinkingEffort, current.thinkingEffort)
      : current.thinkingEffort;
  next.provider = "openai_compatible";

  // Empty apiKey means "keep previous key"
  if (body.apiKey != null) {
    const key = String(body.apiKey);
    next.apiKey = key.trim().length > 0 ? key.trim() : current.apiKey;
  } else {
    next.apiKey = current.apiKey;
  }

  if (next.maxLogChars < 1000) next.maxLogChars = 1000;
  if (next.maxLogChars > 80000) next.maxLogChars = 80000;

  saveAiConfig(next);
  ctx.body = toPublicAiConfig(getAiConfig());
});

// Non-stream chat (fallback)
router.post(
  "/chat",
  speedLimit(2),
  permission({ level: ROLE.USER }),
  validator({
    body: {
      daemonId: String,
      instanceUuid: String,
      message: String
    }
  }),
  async (ctx) => {
    initAiConfig();
    const parsed = parseChatBody(ctx.request.body);
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, parsed.daemonId, parsed.instanceUuid);

    const result = await chatWithAi({
      daemonId: parsed.daemonId,
      instanceUuid: parsed.instanceUuid,
      message: parsed.message,
      history: parsed.history,
      includeLog: parsed.includeLog,
      thinkingEffort: parsed.thinkingEffort,
      operatorName: ctx.session?.["userName"],
      operatorIp: ctx.ip
    });

    ctx.body = result;
  }
);

// Streaming chat (SSE). Prefer this from the UI.
router.post(
  "/chat/stream",
  speedLimit(2),
  permission({ level: ROLE.USER }),
  validator({
    body: {
      daemonId: String,
      instanceUuid: String,
      message: String
    }
  }),
  async (ctx) => {
    initAiConfig();
    const parsed = parseChatBody(ctx.request.body);
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, parsed.daemonId, parsed.instanceUuid);

    const { stream, writeEvent, end } = createSseStream();
    ctx.status = 200;
    ctx.set("Content-Type", "text/event-stream; charset=utf-8");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("Connection", "keep-alive");
    ctx.set("X-Accel-Buffering", "no");
    ctx.body = stream;

    // Keep the connection open while the provider streams tokens.
    void (async () => {
      try {
        await streamChatWithAi(
          {
            daemonId: parsed.daemonId,
            instanceUuid: parsed.instanceUuid,
            message: parsed.message,
            history: parsed.history,
            includeLog: parsed.includeLog,
            thinkingEffort: parsed.thinkingEffort,
            operatorName: ctx.session?.["userName"],
            operatorIp: ctx.ip
          },
          (event) => writeEvent(event)
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        writeEvent({ type: "error", message });
      } finally {
        end();
      }
    })();
  }
);

// Execute a confirmed action proposed by AI
router.post(
  "/execute",
  speedLimit(2),
  permission({ level: ROLE.USER }),
  validator({
    body: {
      daemonId: String,
      instanceUuid: String
    }
  }),
  async (ctx) => {
    initAiConfig();
    const body = ctx.request.body;
    if (!isRecord(body)) {
      throw new Error("Invalid request body");
    }

    const daemonId = String(body.daemonId);
    const instanceUuid = String(body.instanceUuid);
    const userUuid = getUserUuid(ctx);
    assertInstanceAccess(userUuid, daemonId, instanceUuid);

    const action = parseAction(body.action);
    const result = await executeAiAction({
      daemonId,
      instanceUuid,
      action,
      operatorName: ctx.session?.["userName"],
      operatorIp: ctx.ip
    });
    ctx.body = result;
  }
);

export default router;
