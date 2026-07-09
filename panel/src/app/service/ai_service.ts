import axios from "axios";
import { PassThrough } from "stream";
import AiConfig, { type AiThinkingEffort } from "../entity/ai_config";
import { getAiConfig } from "./ai_config_service";
import { logger } from "./log";
import { operationLogger } from "./operation_logger";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export type AiActionType = "open" | "stop" | "restart" | "command";

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiProposedAction {
  type: AiActionType;
  command?: string;
  reason: string;
}

export interface AiChatRequest {
  daemonId: string;
  instanceUuid: string;
  message: string;
  history?: AiChatMessage[];
  includeLog?: boolean;
  // Optional per-request override. Falls back to panel AI settings.
  thinkingEffort?: AiThinkingEffort;
  operatorName?: string;
  operatorIp?: string;
}

export interface AiChatResponse {
  reply: string;
  thinking: string;
  actions: AiProposedAction[];
  context: {
    instanceName: string;
    status: number;
    type: string;
    logIncluded: boolean;
    thinkingEffort: AiThinkingEffort;
    stream: boolean;
  };
}

export type AiStreamEvent =
  | {
      type: "meta";
      context: AiChatResponse["context"];
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
      context: AiChatResponse["context"];
    }
  | {
      type: "error";
      message: string;
    };

export interface AiExecuteRequest {
  daemonId: string;
  instanceUuid: string;
  action: AiProposedAction;
  operatorName?: string;
  operatorIp?: string;
}

export interface AiExecuteResponse {
  ok: boolean;
  message: string;
  result?: unknown;
}

export interface InstanceContextSnapshot {
  instanceUuid: string;
  status: number;
  nickname: string;
  type: string;
  startCommand: string;
  stopCommand: string;
  cwd: string;
  processType: string;
  ie: string;
  oe: string;
  info: Record<string, unknown>;
  logText: string;
}

interface ProviderChatResult {
  content: string;
  thinking: string;
}

const GLOBAL_INSTANCE_UUID = "global0001";
const GLOBAL_INSTANCE_NAME = "__MCSM_GLOBAL_INSTANCE__";

const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^say\s+.+/i,
  /^broadcast\s+.+/i,
  /^save-all$/i,
  /^save-on$/i,
  /^save-off$/i,
  /^list$/i,
  /^whitelist\s+(list|add|remove|on|off|reload)\b/i,
  /^op\s+\S+$/i,
  /^deop\s+\S+$/i,
  /^kick\s+\S+(\s+.+)?$/i,
  /^ban\s+\S+(\s+.+)?$/i,
  /^pardon\s+\S+$/i,
  /^ban-ip\s+\S+$/i,
  /^pardon-ip\s+\S+$/i,
  /^tp\s+.+/i,
  /^teleport\s+.+/i,
  /^time\s+(set|add)\s+\S+$/i,
  /^weather\s+(clear|rain|thunder)(\s+\d+)?$/i,
  /^difficulty\s+\S+$/i,
  /^gamemode\s+\S+(\s+\S+)?$/i,
  /^gamerule\s+\S+\s+\S+$/i,
  /^xp\s+.+/i,
  /^experience\s+.+/i,
  /^effect\s+.+/i,
  /^give\s+.+/i,
  /^clear\s+.+/i,
  /^title\s+.+/i,
  /^tellraw\s+.+/i,
  /^scoreboard\s+.+/i,
  /^reload$/i,
  /^stop$/i,
  /^help(\s+.+)?$/i,
  /^version$/i,
  /^plugins$/i,
  /^pl$/i,
  /^bukkit:version$/i,
  /^paper\s+version$/i
];

const STATUS_TEXT: Record<number, string> = {
  [-1]: "BUSY",
  [0]: "STOPPED",
  [1]: "STOPPING",
  [2]: "STARTING",
  [3]: "RUNNING"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function isGlobalInstance(uuid: string, nickname: string): boolean {
  return uuid === GLOBAL_INSTANCE_UUID || nickname === GLOBAL_INSTANCE_NAME;
}

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 300) return false;
  if (trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes(";")) return false;
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function validateAction(action: AiProposedAction, allowActions: boolean): void {
  if (!allowActions) {
    throw new Error("AI actions are disabled in settings");
  }
  if (!action || typeof action.type !== "string") {
    throw new Error("Invalid AI action");
  }
  if (!["open", "stop", "restart", "command"].includes(action.type)) {
    throw new Error(`Unsupported AI action type: ${action.type}`);
  }
  if (action.type === "command") {
    const command = String(action.command || "").trim();
    if (!command) {
      throw new Error("Command action requires a non-empty command");
    }
    if (!isSafeCommand(command)) {
      throw new Error(
        `Command is not in the safe whitelist: ${command}. Only common Minecraft/server console commands are allowed.`
      );
    }
  }
}

function resolveThinkingEffort(
  config: AiConfig,
  override?: AiThinkingEffort
): AiThinkingEffort {
  if (override === "off" || override === "low" || override === "medium" || override === "high") {
    return override;
  }
  const value = String(config.thinkingEffort || "medium").toLowerCase();
  if (value === "off" || value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return "medium";
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();

  try {
    const parsed: unknown = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
        return isRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseModelPayload(content: string): { reply: string; actions: AiProposedAction[] } {
  const obj = extractJsonObject(content);
  if (!obj) {
    return { reply: content.trim(), actions: [] };
  }

  const reply = readString(obj.reply, content.trim());
  const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
  const actions: AiProposedAction[] = [];

  for (const item of rawActions) {
    if (!isRecord(item)) continue;
    const type = readString(item.type);
    if (type !== "open" && type !== "stop" && type !== "restart" && type !== "command") continue;
    const action: AiProposedAction = {
      type,
      reason: readString(item.reason, "Suggested by AI")
    };
    if (type === "command") {
      action.command = readString(item.command).trim();
    }
    try {
      validateAction(action, true);
      actions.push(action);
    } catch {
      // Drop unsafe actions instead of failing the whole chat.
    }
  }

  return { reply, actions };
}

function buildSystemPrompt(config: AiConfig, thinkingEffort: AiThinkingEffort): string {
  const extra = config.systemPrompt?.trim()
    ? `\n# Operator custom notes\n${config.systemPrompt.trim()}\n`
    : "";

  const thinkingHint =
    thinkingEffort === "off"
      ? "Do not spend long internal reasoning. Answer directly and practically."
      : `Use careful reasoning with effort=${thinkingEffort}. Put only the final user-facing answer in "reply".`;

  return [
    "# Role",
    "You are the built-in AI operations assistant of MCSManager (MCSM Panel).",
    "You help a private operator manage Minecraft / Steam and other game server instances.",
    "This is a personal server environment for the operator and friends, not a commercial multi-tenant product.",
    "",
    "# MCSManager architecture you must understand",
    "- frontend: Vue web UI. The operator chats with you from the instance terminal page.",
    "- panel: control plane (users, permissions, APIs, AI orchestration). You run here.",
    "- daemon: worker node that really starts/stops processes, Docker containers, files, and terminal I/O.",
    "- One panel can manage multiple daemons (nodes). Every instance is identified by daemonId + instanceUuid.",
    "- GLOBAL instance (uuid global0001 / nickname __MCSM_GLOBAL_INSTANCE__) is the host shell. Never operate it.",
    "",
    "# Instance status codes",
    "- -1 BUSY: async task / transitional busy state. Avoid conflicting actions.",
    "- 0 STOPPED: process is not running.",
    "- 1 STOPPING: shutdown in progress.",
    "- 2 STARTING: boot in progress. Wait for logs; do not spam restart.",
    "- 3 RUNNING: process is up. Still verify game readiness from logs/players if needed.",
    "",
    "# Context fields you receive",
    "- nickname/type/processType/cwd/startCommand/stopCommand: how this instance is launched.",
    "- processType=general: host process (optionally via PTY). processType=docker: containerized.",
    "- runtime info may include cpu/memory, mcPingOnline, currentPlayers/maxPlayers, version, ports.",
    "- terminal log is the primary evidence for crash/boot failures. Prefer evidence over guessing.",
    "- If log is empty, say what is missing and ask the operator to start the instance or enable log inclusion.",
    "",
    "# What you can do in this product",
    "You are not a generic chatbot. Prefer MCSManager-native operations.",
    "Executable actions the UI can confirm:",
    "- open: start instance",
    "- stop: stop instance (sends stopCommand, often ^C / stop)",
    "- restart: restart instance",
    "- command: send a SAFE console command to the running process stdin",
    "",
    "Safe command whitelist examples:",
    "say/broadcast, save-all/save-on/save-off, list,",
    "whitelist add|remove|list|on|off|reload,",
    "op/deop, kick/ban/pardon, ban-ip/pardon-ip,",
    "tp/teleport, time, weather, difficulty, gamemode, gamerule,",
    "xp/experience, effect, give, clear, title, tellraw, scoreboard,",
    "reload, stop, help, version, plugins/pl, paper version.",
    "Never invent shell commands, rm, kill -9, docker privileged changes, or file deletion actions.",
    "",
    "You currently CANNOT directly:",
    "- edit files/config files",
    "- install/update/reinstall instances",
    "- manage mods marketplace downloads",
    "- create schedules",
    "- change Docker privileged/volume/network settings",
    "If those are needed, explain the exact MCSManager UI path and commands the operator should use.",
    "",
    "# Diagnosis playbook",
    "When analyzing failures, structure the answer as:",
    "1) Conclusion (what is wrong)",
    "2) Evidence (quote short log lines / key config values)",
    "3) Likely root cause",
    "4) Fix steps ordered from safest to stronger",
    "5) Optional actions[] if a start/stop/restart/safe command helps",
    "",
    "Common Minecraft/Java issues to check:",
    "- wrong Java version / unsupported class file version",
    "- OutOfMemoryError / too low -Xmx",
    "- port already in use",
    "- EULA not accepted (eula=false)",
    "- missing jar / bad startCommand / wrong cwd",
    "- mod/plugin conflict or dependency missing",
    "- world corruption / failed to bind / authentication servers down",
    "",
    "Common Steam/other game server issues:",
    "- update required, missing steamcmd path, wrong launch args,",
    "- bind IP/port, missing dependencies, container image/tag problems.",
    "",
    "# Response style",
    "- Always answer in the same language as the user message.",
    "- Be practical, concise, and operator-friendly.",
    "- Prefer actionable MCSManager steps over generic Linux lectures.",
    "- Never invent log lines or status that are not in the provided context.",
    "- Do not suggest deleting worlds/saves unless the operator explicitly asks and understands the risk.",
    "- Do not recommend operating the GLOBAL host shell instance.",
    "- Markdown is allowed and preferred in reply (headings, lists, bold, code fences).",
    thinkingHint,
    "",
    "# Output contract (strict)",
    "Return ONLY a pure JSON object with this shape:",
    '{"reply":"markdown text for the user","actions":[{"type":"restart","reason":"..."},{"type":"command","command":"say hello","reason":"..."}]}',
    "Rules:",
    '- "reply" is required and must be user-facing Markdown.',
    '- "actions" must be an array. Use [] when no executable action is needed.',
    "- action.type only: open | stop | restart | command",
    "- For command actions, command must be whitelist-safe and without shell chaining.",
    "- Prefer raw JSON only. Do not wrap the whole response in markdown fences.",
    "- Put reasoning only into provider thinking channels if available; never dump chain-of-thought into reply.",
    extra
  ].join("\n");
}

function buildUserPayload(message: string, snapshot: InstanceContextSnapshot): string {
  const statusLabel = STATUS_TEXT[snapshot.status] || String(snapshot.status);
  const infoJson = JSON.stringify(snapshot.info || {}, null, 2);
  const logBlock = snapshot.logText
    ? snapshot.logText
    : "(no terminal log available or log was not requested)";

  const processHint =
    snapshot.processType === "docker"
      ? "This instance runs in Docker. Prefer container/image/port/memory clues."
      : "This instance runs as a host process (general/PTY). Prefer startCommand/Java/cwd clues.";

  return [
    "You are answering inside MCSManager AI Assistant for one concrete instance.",
    "Use the following live context. Do not assume other instances.",
    "",
    "# Instance identity",
    `- uuid: ${snapshot.instanceUuid}`,
    `- name: ${snapshot.nickname}`,
    `- type: ${snapshot.type}`,
    `- processType: ${snapshot.processType}`,
    `- status: ${snapshot.status} (${statusLabel})`,
    `- cwd: ${snapshot.cwd}`,
    `- startCommand: ${snapshot.startCommand || "(empty)"}`,
    `- stopCommand: ${snapshot.stopCommand || "(empty)"}`,
    `- encoding ie/oe: ${snapshot.ie}/${snapshot.oe}`,
    `- process hint: ${processHint}`,
    "",
    "# Runtime info JSON",
    infoJson,
    "",
    "# Recent terminal log (may be truncated; newest at the end)",
    "```log",
    logBlock,
    "```",
    "",
    "# Operator question",
    message,
    "",
    "# Reminder",
    "If you propose executable help, put it into actions[].",
    "If the operator only needs explanation, keep actions empty.",
    "Quote evidence from the log/config when diagnosing."
  ].join("\n");
}

async function fetchInstanceSnapshot(
  daemonId: string,
  instanceUuid: string,
  includeLog: boolean,
  maxLogChars: number
): Promise<InstanceContextSnapshot> {
  const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
  if (!remoteService) {
    throw new Error("Remote daemon not found");
  }

  const detail = await new RemoteRequest(remoteService).request("instance/detail", {
    instanceUuid
  });

  if (!isRecord(detail)) {
    throw new Error("Invalid instance detail response");
  }

  const config = isRecord(detail.config) ? detail.config : {};
  const info = isRecord(detail.info) ? detail.info : {};
  const nickname = readString(config.nickname, instanceUuid);

  if (isGlobalInstance(instanceUuid, nickname)) {
    throw new Error("AI assistant is not allowed to operate the GLOBAL host shell instance");
  }

  let logText = "";
  if (includeLog) {
    try {
      const rawLog = await new RemoteRequest(remoteService).request("instance/outputlog", {
        instanceUuid
      });
      const full = typeof rawLog === "string" ? rawLog : String(rawLog ?? "");
      logText = full.length > maxLogChars ? full.slice(-maxLogChars) : full;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logText = `(failed to load output log: ${msg})`;
    }
  }

  return {
    instanceUuid,
    status: readNumber(detail.status, 0),
    nickname,
    type: readString(config.type, "unknown"),
    startCommand: readString(config.startCommand),
    stopCommand: readString(config.stopCommand),
    cwd: readString(config.cwd),
    processType: readString(config.processType, "general"),
    ie: readString(config.ie, "utf-8"),
    oe: readString(config.oe, "utf-8"),
    info,
    logText
  };
}

function ensureProviderConfig(config: AiConfig): void {
  if (!config.apiKey?.trim()) {
    throw new Error("AI API key is not configured");
  }
  if (!config.apiBaseUrl?.trim()) {
    throw new Error("AI API base URL is not configured");
  }
  if (!config.model?.trim()) {
    throw new Error("AI model is not configured");
  }
}

function buildProviderBody(
  config: AiConfig,
  messages: AiChatMessage[],
  thinkingEffort: AiThinkingEffort,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: thinkingEffort === "off" ? 0.2 : 0.3,
    messages,
    stream
  };

  // OpenAI-compatible reasoning effort (ignored by providers that do not support it).
  if (thinkingEffort !== "off") {
    body.reasoning_effort = thinkingEffort;
    // Some gateways use this field instead.
    body.thinking = { type: "enabled", budget_tokens: thinkingEffort === "high" ? 8192 : thinkingEffort === "medium" ? 4096 : 1024 };
  }

  return body;
}

function extractProviderError(data: unknown, status: number): string {
  let detail = `HTTP ${status}`;
  if (isRecord(data)) {
    if (typeof data.error === "string") detail = data.error;
    else if (isRecord(data.error) && typeof data.error.message === "string") {
      detail = data.error.message;
    } else if (typeof data.message === "string") {
      detail = data.message;
    }
  }
  return detail;
}

function extractThinkingFromMessage(message: Record<string, unknown>): string {
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    message.reasoning_text
  ];
  for (const item of candidates) {
    if (typeof item === "string" && item.trim()) return item;
  }
  if (Array.isArray(message.reasoning_details)) {
    const parts: string[] = [];
    for (const part of message.reasoning_details) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part)) {
        const text = readString(part.text) || readString(part.content);
        if (text) parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

function extractContentFromMessage(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const part of message.content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part)) {
        const text = readString(part.text) || readString(part.content);
        if (text) parts.push(text);
      }
    }
    return parts.join("");
  }
  return "";
}

function extractDeltaFields(delta: Record<string, unknown>): { content: string; thinking: string } {
  let content = "";
  let thinking = "";

  if (typeof delta.content === "string") content += delta.content;
  if (typeof delta.reasoning_content === "string") thinking += delta.reasoning_content;
  if (typeof delta.reasoning === "string") thinking += delta.reasoning;
  if (typeof delta.thinking === "string") thinking += delta.thinking;

  // OpenAI Responses / newer reasoning delta shapes.
  if (isRecord(delta.delta)) {
    const nested = extractDeltaFields(delta.delta);
    content += nested.content;
    thinking += nested.thinking;
  }

  return { content, thinking };
}

async function callChatCompletions(
  config: AiConfig,
  messages: AiChatMessage[],
  thinkingEffort: AiThinkingEffort
): Promise<ProviderChatResult> {
  ensureProviderConfig(config);
  const url = `${normalizeBaseUrl(config.apiBaseUrl)}/chat/completions`;
  const response = await axios.post(
    url,
    buildProviderBody(config, messages, thinkingEffort, false),
    {
      timeout: 120000,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      validateStatus: () => true
    }
  );

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`AI provider request failed: ${extractProviderError(response.data, response.status)}`);
  }

  const data = response.data;
  if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("AI provider returned an empty response");
  }

  const first = data.choices[0];
  if (!isRecord(first)) {
    throw new Error("AI provider returned an invalid choice");
  }

  let content = "";
  let thinking = "";
  if (isRecord(first.message)) {
    content = extractContentFromMessage(first.message);
    thinking = extractThinkingFromMessage(first.message);
  } else if (typeof first.text === "string") {
    content = first.text;
  }

  if (!content && !thinking) {
    throw new Error("AI provider response missing message content");
  }

  return { content, thinking };
}

async function streamChatCompletions(
  config: AiConfig,
  messages: AiChatMessage[],
  thinkingEffort: AiThinkingEffort,
  onDelta: (chunk: { content?: string; thinking?: string }) => void
): Promise<ProviderChatResult> {
  ensureProviderConfig(config);
  const url = `${normalizeBaseUrl(config.apiBaseUrl)}/chat/completions`;
  const response = await axios.post(
    url,
    buildProviderBody(config, messages, thinkingEffort, true),
    {
      timeout: 180000,
      responseType: "stream",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      validateStatus: () => true
    }
  );

  if (response.status < 200 || response.status >= 300) {
    // When responseType=stream, error body may also be a stream.
    const data = response.data;
    if (data && typeof data.read === "function") {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        data.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        data.on("end", () => resolve());
        data.on("error", (err: Error) => reject(err));
      });
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed: unknown = JSON.parse(text);
        throw new Error(`AI provider request failed: ${extractProviderError(parsed, response.status)}`);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("AI provider request failed:")) {
          throw error;
        }
        throw new Error(`AI provider request failed: HTTP ${response.status} ${text.slice(0, 300)}`);
      }
    }
    throw new Error(`AI provider request failed: ${extractProviderError(data, response.status)}`);
  }

  const stream = response.data as NodeJS.ReadableStream;
  let buffer = "";
  let content = "";
  let thinking = "";

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          resolve();
          return;
        }

        try {
          const parsed: unknown = JSON.parse(payload);
          if (!isRecord(parsed)) continue;
          const choices = parsed.choices;
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const first = choices[0];
          if (!isRecord(first)) continue;

          if (isRecord(first.delta)) {
            const fields = extractDeltaFields(first.delta);
            if (fields.content) {
              content += fields.content;
              onDelta({ content: fields.content });
            }
            if (fields.thinking) {
              thinking += fields.thinking;
              onDelta({ thinking: fields.thinking });
            }
          }

          // Some providers send full message objects mid-stream.
          if (isRecord(first.message)) {
            const fullContent = extractContentFromMessage(first.message);
            const fullThinking = extractThinkingFromMessage(first.message);
            if (fullContent && fullContent.length > content.length) {
              const delta = fullContent.slice(content.length);
              content = fullContent;
              if (delta) onDelta({ content: delta });
            }
            if (fullThinking && fullThinking.length > thinking.length) {
              const delta = fullThinking.slice(thinking.length);
              thinking = fullThinking;
              if (delta) onDelta({ thinking: delta });
            }
          }
        } catch {
          // Ignore malformed SSE chunks and keep reading.
        }
      }
    });

    stream.on("end", () => resolve());
    stream.on("error", (err: Error) => reject(err));
  });

  if (!content && !thinking) {
    throw new Error("AI provider stream ended without content");
  }

  return { content, thinking };
}

async function prepareChat(
  req: AiChatRequest
): Promise<{
  config: AiConfig;
  messages: AiChatMessage[];
  snapshot: InstanceContextSnapshot;
  includeLog: boolean;
  thinkingEffort: AiThinkingEffort;
}> {
  const config = getAiConfig();
  if (!config.enabled) {
    throw new Error("AI assistant is disabled. Enable it in Settings first.");
  }

  const includeLog = req.includeLog !== false;
  const thinkingEffort = resolveThinkingEffort(config, req.thinkingEffort);
  const snapshot = await fetchInstanceSnapshot(
    req.daemonId,
    req.instanceUuid,
    includeLog,
    config.maxLogChars || 12000
  );

  const history = Array.isArray(req.history) ? req.history.slice(-12) : [];
  const messages: AiChatMessage[] = [
    { role: "system", content: buildSystemPrompt(config, thinkingEffort) },
    ...history.filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim().length > 0
    ),
    { role: "user", content: buildUserPayload(req.message, snapshot) }
  ];

  return { config, messages, snapshot, includeLog, thinkingEffort };
}

function finalizeChatResult(
  config: AiConfig,
  snapshot: InstanceContextSnapshot,
  includeLog: boolean,
  thinkingEffort: AiThinkingEffort,
  stream: boolean,
  providerResult: ProviderChatResult
): AiChatResponse {
  const parsed = parseModelPayload(providerResult.content || "");
  const actions = config.allowActions ? parsed.actions : [];
  const reply = parsed.reply || providerResult.content || "No response from model.";
  const thinking = config.showThinking ? providerResult.thinking || "" : "";

  return {
    reply,
    thinking,
    actions,
    context: {
      instanceName: snapshot.nickname,
      status: snapshot.status,
      type: snapshot.type,
      logIncluded: includeLog,
      thinkingEffort,
      stream
    }
  };
}

export async function chatWithAi(req: AiChatRequest): Promise<AiChatResponse> {
  const prepared = await prepareChat(req);
  const providerResult = await callChatCompletions(
    prepared.config,
    prepared.messages,
    prepared.thinkingEffort
  );
  const result = finalizeChatResult(
    prepared.config,
    prepared.snapshot,
    prepared.includeLog,
    prepared.thinkingEffort,
    false,
    providerResult
  );

  logger.info(
    `[AI] chat instance=${req.instanceUuid} daemon=${req.daemonId} actions=${result.actions.length} effort=${prepared.thinkingEffort}`
  );
  return result;
}

export async function streamChatWithAi(
  req: AiChatRequest,
  emit: (event: AiStreamEvent) => void
): Promise<AiChatResponse> {
  const prepared = await prepareChat(req);
  const context: AiChatResponse["context"] = {
    instanceName: prepared.snapshot.nickname,
    status: prepared.snapshot.status,
    type: prepared.snapshot.type,
    logIncluded: prepared.includeLog,
    thinkingEffort: prepared.thinkingEffort,
    stream: true
  };
  emit({ type: "meta", context });

  // If stream is disabled in settings, fall back to one-shot completion and emit deltas once.
  if (prepared.config.streamEnabled === false) {
    const providerResult = await callChatCompletions(
      prepared.config,
      prepared.messages,
      prepared.thinkingEffort
    );
    if (prepared.config.showThinking && providerResult.thinking) {
      emit({ type: "thinking", delta: providerResult.thinking });
    }
    if (providerResult.content) {
      emit({ type: "delta", delta: providerResult.content });
    }
    const result = finalizeChatResult(
      prepared.config,
      prepared.snapshot,
      prepared.includeLog,
      prepared.thinkingEffort,
      false,
      providerResult
    );
    emit({
      type: "done",
      reply: result.reply,
      thinking: result.thinking,
      actions: result.actions,
      context: result.context
    });
    return result;
  }

  const providerResult = await streamChatCompletions(
    prepared.config,
    prepared.messages,
    prepared.thinkingEffort,
    (chunk) => {
      if (chunk.thinking && prepared.config.showThinking) {
        emit({ type: "thinking", delta: chunk.thinking });
      }
      if (chunk.content) {
        emit({ type: "delta", delta: chunk.content });
      }
    }
  );

  const result = finalizeChatResult(
    prepared.config,
    prepared.snapshot,
    prepared.includeLog,
    prepared.thinkingEffort,
    true,
    providerResult
  );

  emit({
    type: "done",
    reply: result.reply,
    thinking: result.thinking,
    actions: result.actions,
    context: result.context
  });

  logger.info(
    `[AI] stream-chat instance=${req.instanceUuid} daemon=${req.daemonId} actions=${result.actions.length} effort=${prepared.thinkingEffort}`
  );
  return result;
}

export function createSseStream(): {
  stream: PassThrough;
  writeEvent: (event: AiStreamEvent) => void;
  end: () => void;
} {
  const stream = new PassThrough();
  const writeEvent = (event: AiStreamEvent) => {
    stream.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const end = () => {
    stream.write("data: [DONE]\n\n");
    stream.end();
  };
  return { stream, writeEvent, end };
}

export async function executeAiAction(req: AiExecuteRequest): Promise<AiExecuteResponse> {
  const config = getAiConfig();
  if (!config.enabled) {
    throw new Error("AI assistant is disabled");
  }
  validateAction(req.action, config.allowActions);

  const remoteService = RemoteServiceSubsystem.getInstance(req.daemonId);
  if (!remoteService) {
    throw new Error("Remote daemon not found");
  }

  const detail = await new RemoteRequest(remoteService).request("instance/detail", {
    instanceUuid: req.instanceUuid
  });
  const configObj = isRecord(detail) && isRecord(detail.config) ? detail.config : {};
  const nickname = readString(configObj.nickname, req.instanceUuid);
  if (isGlobalInstance(req.instanceUuid, nickname)) {
    throw new Error("AI assistant is not allowed to operate the GLOBAL host shell instance");
  }

  const remote = new RemoteRequest(remoteService);
  let result: unknown;
  let message = "";

  if (req.action.type === "open") {
    result = await remote.request("instance/open", { instanceUuids: [req.instanceUuid] });
    message = "Instance start requested";
    operationLogger.log("instance_start", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (req.action.type === "stop") {
    result = await remote.request("instance/stop", { instanceUuids: [req.instanceUuid] });
    message = "Instance stop requested";
    operationLogger.log("instance_stop", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (req.action.type === "restart") {
    result = await remote.request("instance/restart", { instanceUuids: [req.instanceUuid] });
    message = "Instance restart requested";
    operationLogger.log("instance_restart", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else {
    const command = String(req.action.command || "").trim();
    validateAction({ type: "command", command, reason: req.action.reason }, true);
    result = await remote.request("instance/command", {
      instanceUuid: req.instanceUuid,
      command
    });
    message = `Command sent: ${command}`;
  }

  logger.info(
    `[AI] execute type=${req.action.type} instance=${req.instanceUuid} daemon=${req.daemonId}`
  );

  return { ok: true, message, result };
}

export function diagnoseReadyState(): {
  enabled: boolean;
  configured: boolean;
  allowActions: boolean;
  streamEnabled: boolean;
  showThinking: boolean;
  thinkingEffort: AiThinkingEffort;
  model: string;
  apiBaseUrl: string;
} {
  const config = getAiConfig();
  return {
    enabled: Boolean(config.enabled),
    configured: Boolean(config.apiKey && config.apiBaseUrl && config.model),
    allowActions: Boolean(config.allowActions),
    streamEnabled: config.streamEnabled !== false,
    showThinking: config.showThinking !== false,
    thinkingEffort: resolveThinkingEffort(config),
    model: config.model,
    apiBaseUrl: config.apiBaseUrl
  };
}
