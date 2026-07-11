import axios from "axios";
import { PassThrough } from "stream";
import AiConfig, { type AiThinkingEffort } from "../entity/ai_config";
import { checkSafeUrl } from "../utils/url";
import { getAiConfig } from "./ai_config_service";
import { logger } from "./log";
import { modManagerService } from "./mod_manager_service";
import { operationLogger } from "./operation_logger";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export type AiActionType =
  | "open"
  | "stop"
  | "restart"
  | "kill"
  | "command"
  | "install_mod"
  | "toggle_mod"
  | "delete_mod"
  | "list_files"
  | "read_file"
  | "write_file"
  | "delete_files"
  | "mkdir"
  | "download_file"
  | "accept_eula"
  | "update_instance_config"
  | "get_logs"
  | "list_mods"
  | "action_chain";

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiProposedAction {
  type: AiActionType;
  command?: string;
  reason: string;
  // install_mod fields (resolved by backend when only query is provided)
  modQuery?: string;
  projectId?: string;
  source?: string;
  versionId?: string;
  gameVersion?: string;
  loader?: string;
  projectType?: "mod" | "plugin";
  url?: string;
  fileName?: string;
  fallbackUrl?: string;
  projectName?: string;
  versionName?: string;
  // generic file / path ops
  path?: string;
  target?: string;
  content?: string;
  targets?: string[];
  // listing / paging
  page?: number;
  pageSize?: number;
  // instance config patch (safe subset only)
  configPatch?: Record<string, unknown>;
  // optional size limit for get_logs / read_file
  maxChars?: number;
  // action_chain: ordered multi-step repair plan
  steps?: AiProposedAction[];
  stopOnError?: boolean;
  title?: string;
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
  // For action_chain, includes per-step progress even if some steps fail.
  partial?: boolean;
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
  /^paper\s+version$/i,
  /^forge\s+.+/i,
  /^neoforge\s+.+/i,
  /^fabric\s+.+/i,
  /^spark\s+.+/i,
  /^carpet\s+.+/i,
  /^seed$/i,
  /^worldborder\s+.+/i,
  /^banlist(\s+.+)?$/i,
  /^whitelist$/i
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


const ALL_ACTION_TYPES: AiActionType[] = [
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

const DANGEROUS_PATH_PARTS = ["../", "..\\", "/etc", "C:\\Windows", "C:/Windows"];

function normalizeRelPath(input?: string): string {
  const raw = String(input || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new Error("Absolute paths are not allowed. Use instance-relative paths.");
  }
  if (raw.includes("\0")) throw new Error("Invalid path");
  const lowered = raw.toLowerCase();
  for (const bad of DANGEROUS_PATH_PARTS) {
    if (lowered.includes(bad.toLowerCase())) {
      throw new Error(`Path is not allowed: ${raw}`);
    }
  }
  const parts = raw.split("/").filter((p) => p && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length === 0) throw new Error(`Path escapes instance root: ${raw}`);
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

function isProtectedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  return (
    p === "world" ||
    p.startsWith("world/") ||
    p === "world_nether" ||
    p.startsWith("world_nether/") ||
    p === "world_the_end" ||
    p.startsWith("world_the_end/") ||
    p.includes("/session.lock")
  );
}

function isWritableConfigPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  const allowExact = new Set([
    "eula.txt",
    "server.properties",
    "ops.json",
    "whitelist.json",
    "banned-players.json",
    "banned-ips.json",
    "bukkit.yml",
    "spigot.yml",
    "paper.yml",
    "paper-global.yml",
    "paper-world-defaults.yml",
    "purpur.yml",
    "pufferfish.yml",
    "config/paper-global.yml",
    "config/paper-world-defaults.yml",
    "config.yml",
    "settings.yml",
    "permissions.yml",
    "commands.yml",
    "help.yml",
    "user_jvm_args.txt",
    "start.sh",
    "start.bat",
    "run.sh",
    "run.bat"
  ]);
  if (allowExact.has(p)) return true;
  if (
    p.endsWith(".properties") ||
    p.endsWith(".yml") ||
    p.endsWith(".yaml") ||
    p.endsWith(".json") ||
    p.endsWith(".toml") ||
    p.endsWith(".txt") ||
    p.endsWith(".cfg") ||
    p.endsWith(".conf")
  ) {
    if (
      p.startsWith("config/") ||
      p.startsWith("configs/") ||
      p.startsWith("plugins/") ||
      p.startsWith("mods/") ||
      p.startsWith("kubejs/") ||
      p.startsWith("scripts/") ||
      p.startsWith("local/") ||
      p.startsWith("world/serverconfig/") ||
      p.startsWith("serverconfig/")
    ) {
      return true;
    }
  }
  return false;
}

function isSafeInstanceConfigPatch(patch: Record<string, unknown>): void {
  const allowedTop = new Set([
    "nickname",
    "startCommand",
    "stopCommand",
    "cwd",
    "type",
    "ie",
    "oe",
    "fileCode",
    "processType",
    "updateCommand",
    "docker",
    "pingConfig",
    "eventTask",
    "terminalOption",
    "extraServiceConfig",
    "tag",
    "maxSpace",
    "runAs",
    "basePort"
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowedTop.has(key)) {
      throw new Error(`Config field not allowed for AI update: ${key}`);
    }
  }
  if (isRecord(patch.docker)) {
    const docker = patch.docker;
    if (docker.privileged === true) {
      throw new Error("AI is not allowed to enable docker privileged mode");
    }
    if (docker.extraVolumes != null || docker.devices != null || docker.capAdd != null) {
      throw new Error("AI is not allowed to change docker volumes/devices/capabilities");
    }
  }
}

function clampText(input: string, maxChars: number): string {
  if (!input) return "";
  if (input.length <= maxChars) return input;
  return input.slice(input.length - maxChars);
}

function validateAction(action: AiProposedAction, allowActions: boolean): void {
  if (!allowActions) {
    throw new Error("AI actions are disabled in settings");
  }
  if (!action || typeof action.type !== "string") {
    throw new Error("Invalid AI action");
  }
  if (!ALL_ACTION_TYPES.includes(action.type)) {
    throw new Error(`Unsupported AI action type: ${action.type}`);
  }

  if (action.type === "command") {
    const command = String(action.command || "").trim();
    if (!command) throw new Error("Command action requires a non-empty command");
    if (!isSafeCommand(command)) {
      throw new Error(
        `Command is not in the safe whitelist: ${command}. Only common Minecraft/server console commands are allowed.`
      );
    }
  }

  if (action.type === "install_mod") {
    const hasResolved = Boolean(action.url && action.fileName);
    const hasLookup =
      Boolean(action.modQuery && action.modQuery.trim()) ||
      Boolean(action.projectId && action.projectId.trim());
    if (!hasResolved && !hasLookup) {
      throw new Error(
        "install_mod requires either a resolved url+fileName, or a modQuery/projectId to look up"
      );
    }
    if (action.url && !checkSafeUrl(action.url)) {
      throw new Error("install_mod url is invalid or unsafe");
    }
    if (action.fallbackUrl && !checkSafeUrl(action.fallbackUrl)) {
      throw new Error("install_mod fallbackUrl is invalid or unsafe");
    }
    if (action.projectType && action.projectType !== "mod" && action.projectType !== "plugin") {
      throw new Error("install_mod projectType must be mod or plugin");
    }
  }

  if (action.type === "toggle_mod" || action.type === "delete_mod") {
    const fileName = String(action.fileName || "").trim();
    if (!fileName) throw new Error(`${action.type} requires fileName`);
    normalizeRelPath(fileName);
  }

  if (action.type === "list_files") {
    if (action.path) normalizeRelPath(action.path);
  }

  if (action.type === "read_file" || action.type === "write_file" || action.type === "mkdir") {
    const target = normalizeRelPath(action.target || action.path);
    if (!target) throw new Error(`${action.type} requires target/path`);
    if (action.type === "write_file") {
      if (typeof action.content !== "string") {
        throw new Error("write_file requires content string");
      }
      if (action.content.length > 500000) {
        throw new Error("write_file content too large (max 500KB)");
      }
      if (!isWritableConfigPath(target)) {
        throw new Error(
          `write_file target is not in the editable allow-list: ${target}. Use config/mod/plugin text configs or common server files.`
        );
      }
    }
  }

  if (action.type === "delete_files") {
    const targets = Array.isArray(action.targets)
      ? action.targets
      : action.target
        ? [action.target]
        : action.path
          ? [action.path]
          : action.fileName
            ? [action.fileName]
            : [];
    if (targets.length === 0) throw new Error("delete_files requires targets");
    if (targets.length > 50) throw new Error("delete_files allows at most 50 paths per action");
    for (const item of targets) {
      const rel = normalizeRelPath(String(item));
      if (!rel) throw new Error("delete_files contains empty path");
      if (isProtectedPath(rel)) {
        throw new Error(
          `Refusing to delete protected world/runtime path: ${rel}. Do this manually if truly needed.`
        );
      }
    }
  }

  if (action.type === "download_file") {
    const url = String(action.url || "").trim();
    const fileName = String(action.fileName || action.target || "").trim();
    if (!url || !fileName) throw new Error("download_file requires url and fileName/target");
    if (!checkSafeUrl(url)) throw new Error("download_file url is invalid or unsafe");
    normalizeRelPath(fileName);
  }

  if (action.type === "update_instance_config") {
    if (!action.configPatch || !isRecord(action.configPatch) || Object.keys(action.configPatch).length === 0) {
      throw new Error("update_instance_config requires configPatch object");
    }
    isSafeInstanceConfigPatch(action.configPatch);
  }

  if (action.type === "action_chain") {
    const steps = Array.isArray(action.steps) ? action.steps : [];
    if (steps.length === 0) {
      throw new Error("action_chain requires a non-empty steps array");
    }
    if (steps.length > 12) {
      throw new Error("action_chain allows at most 12 steps");
    }
    for (const step of steps) {
      if (!step || typeof step !== "object") {
        throw new Error("action_chain contains invalid step");
      }
      if (step.type === "action_chain") {
        throw new Error("Nested action_chain is not allowed");
      }
      validateAction(step, true);
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

function tryParseJsonRecord(candidate: string): Record<string, unknown> | null {
  const raw = String(candidate || "").trim();
  if (!raw) return null;

  const attempts = [
    raw,
    // Common model issues: trailing commas before } or ]
    raw.replace(/,\s*([}\]])/g, "$1"),
    // Smart quotes
    raw.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  ];

  for (const item of attempts) {
    try {
      const parsed: unknown = JSON.parse(item);
      if (isRecord(parsed)) return parsed;
    } catch {
      // continue
    }
  }
  return null;
}

function extractBalancedJsonObjects(text: string): string[] {
  const input = String(text || "");
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const source = String(text || "").trim();
  if (!source) return null;

  // Prefer fenced json blocks first.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const fenceBlocks: string[] = [];
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(source)) !== null) {
    if (fenceMatch[1]) fenceBlocks.push(fenceMatch[1]);
  }
  for (let i = fenceBlocks.length - 1; i >= 0; i--) {
    const block = fenceBlocks[i] || "";
    const parsed = tryParseJsonRecord(block);
    if (parsed && ("reply" in parsed || "actions" in parsed)) return parsed;
    if (parsed) return parsed;
  }

  // Direct parse whole payload.
  const direct = tryParseJsonRecord(source);
  if (direct && ("reply" in direct || "actions" in direct)) return direct;
  if (direct) return direct;

  // Scan balanced objects and pick the best candidate (prefer ones with actions/reply).
  const objects = extractBalancedJsonObjects(source);
  let fallback: Record<string, unknown> | null = null;
  for (let i = objects.length - 1; i >= 0; i--) {
    const parsed = tryParseJsonRecord(objects[i]);
    if (!parsed) continue;
    if ("reply" in parsed || "actions" in parsed) return parsed;
    if (!fallback) fallback = parsed;
  }
  return fallback;
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
    const type = readString(item.type) as AiActionType;
    if (!ALL_ACTION_TYPES.includes(type)) continue;

    const action: AiProposedAction = {
      type,
      reason: readString(item.reason, "Suggested by AI")
    };

    if (type === "command") {
      action.command = readString(item.command).trim();
    }

    if (type === "install_mod") {
      action.modQuery = readString(item.modQuery).trim() || undefined;
      action.projectId = readString(item.projectId).trim() || undefined;
      action.source = readString(item.source).trim() || undefined;
      action.versionId = readString(item.versionId).trim() || undefined;
      action.gameVersion = readString(item.gameVersion).trim() || undefined;
      action.loader = readString(item.loader).trim() || undefined;
      const projectType = readString(item.projectType).trim().toLowerCase();
      if (projectType === "mod" || projectType === "plugin") {
        action.projectType = projectType;
      }
      action.url = readString(item.url).trim() || undefined;
      action.fileName = readString(item.fileName).trim() || undefined;
      action.fallbackUrl = readString(item.fallbackUrl).trim() || undefined;
      action.projectName = readString(item.projectName).trim() || undefined;
      action.versionName = readString(item.versionName).trim() || undefined;
    }

    if (type === "toggle_mod" || type === "delete_mod") {
      action.fileName = readString(item.fileName).trim() || undefined;
    }

    if (
      type === "list_files" ||
      type === "read_file" ||
      type === "write_file" ||
      type === "mkdir" ||
      type === "download_file" ||
      type === "delete_files"
    ) {
      action.path = readString(item.path).trim() || undefined;
      action.target = readString(item.target).trim() || undefined;
      action.fileName = readString(item.fileName).trim() || undefined;
      action.content = typeof item.content === "string" ? item.content : undefined;
      action.url = readString(item.url).trim() || undefined;
      if (Array.isArray(item.targets)) {
        action.targets = item.targets.map((v) => String(v));
      }
      if (typeof item.page === "number") action.page = item.page;
      if (typeof item.pageSize === "number") action.pageSize = item.pageSize;
      if (typeof item.maxChars === "number") action.maxChars = item.maxChars;
    }

    if (type === "get_logs" || type === "list_mods") {
      if (typeof item.page === "number") action.page = item.page;
      if (typeof item.pageSize === "number") action.pageSize = item.pageSize;
      if (typeof item.maxChars === "number") action.maxChars = item.maxChars;
    }

    if (type === "update_instance_config" && isRecord(item.configPatch)) {
      action.configPatch = item.configPatch;
    }

    if (type === "action_chain") {
      action.title = readString(item.title).trim() || undefined;
      action.stopOnError = item.stopOnError !== false;
      const rawSteps = Array.isArray(item.steps) ? item.steps : [];
      const steps: AiProposedAction[] = [];
      for (const rawStep of rawSteps) {
        if (!isRecord(rawStep)) continue;
        // Reuse the same field extraction by recursively wrapping as one-item actions array payload.
        const nested = parseModelPayload(
          JSON.stringify({
            reply: "nested",
            actions: [rawStep]
          })
        ).actions;
        if (nested[0] && nested[0].type !== "action_chain") {
          steps.push(nested[0]);
        }
      }
      action.steps = steps;
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
    "Executable actions the UI can confirm (operator still clicks confirm):",
    "- open / stop / restart / kill: power control of the current instance",
    "- command: send a SAFE console command to the running process stdin",
    "- install_mod / toggle_mod / delete_mod / list_mods: manage mods and plugins",
    "- list_files / read_file / write_file / mkdir / delete_files / download_file: inspect and fix instance files",
    "- accept_eula: set eula=true for Minecraft servers",
    "- update_instance_config: patch safe instance launch settings (startCommand/cwd/type/etc.)",
    "- get_logs: pull latest terminal logs when more evidence is needed",
    "- action_chain: multi-step automatic repair plan. Operator confirms once, backend runs steps in order",
    "",
    "Safe command whitelist examples:",
    "say/broadcast, save-all/save-on/save-off, list,",
    "whitelist add|remove|list|on|off|reload,",
    "op/deop, kick/ban/pardon, ban-ip/pardon-ip,",
    "tp/teleport, time, weather, difficulty, gamemode, gamerule,",
    "xp/experience, effect, give, clear, title, tellraw, scoreboard,",
    "reload, stop, help, version, plugins/pl, paper version, spark ..., seed.",
    "Never invent shell commands, rm, kill -9, docker privileged changes, or host-level file deletion.",
    "",
    "install_mod guidance:",
    "- Prefer: {\"type\":\"install_mod\",\"modQuery\":\"sodium\",\"source\":\"Modrinth\",\"gameVersion\":\"1.20.1\",\"loader\":\"fabric\",\"projectType\":\"mod\",\"reason\":\"...\"}",
    "- Backend resolves real download URLs from Modrinth/CurseForge/SpigotMC. Do not invent urls.",
    "",
    "File ops guidance:",
    "- Paths are relative to the instance working directory (cwd).",
    "- For crashes: get_logs, list_files, read_file key configs (eula.txt, server.properties, latest logs, start scripts).",
    "- For EULA issues: prefer accept_eula, or write_file eula.txt with eula=true.",
    "- write_file is allow-listed to common configs/scripts and config/mod/plugin text files.",
    "- delete_files refuses world/ and other protected runtime paths.",
    "",
    "You currently CANNOT / MUST NOT:",
    "- delete world saves / force wipe players without explicit operator intent + manual UI",
    "- enable docker privileged mode, mount host devices, or change host firewall",
    "- operate the GLOBAL host shell instance",
    "- run arbitrary host shell commands",
    "If something is outside these actions, explain the exact MCSManager UI path.",
    "",
    "# Diagnosis playbook",
    "When analyzing failures, structure the answer as:",
    "1) Conclusion (what is wrong)",
    "2) Evidence (quote short log lines / key config values)",
    "3) Likely root cause",
    "4) Fix steps ordered from safest to stronger",
    "5) REQUIRED: actions[] with one-click fix buttons. Do not stop at advice when an action can help.",
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

    "# One-click repair policy (IMPORTANT)",
    "Default behavior is ACTION-FIRST, not advice-first.",
    "If the operator reports install/start/crash/offline/mod problems, you MUST include executable actions in actions[].",
    "Prefer a single action_chain for multi-step recovery so the operator can click one button.",
    "Typical chains:",
    "- Boot/EULA: get_logs -> accept_eula -> open/restart",
    "- Config error: get_logs -> read_file(server.properties/eula.txt/start script) -> write_file fix -> restart",
    "- Mod issue: list_mods -> install_mod/toggle_mod/delete_mod -> restart",
    "- Hang: get_logs -> kill -> open",
    "Only use empty actions[] when the request is pure Q&A with no operable fix.",
    "Never say 'you can click settings and do X manually' if an action type already exists.",
    "In reply text, explicitly tell the operator there is a one-click button below to execute the plan.",
    "# Response style",
    "- Always answer in the same language as the user message.",
    "- Be practical, concise, and operator-friendly.",
    "- Prefer actionable MCSManager steps over generic Linux lectures.",
    "- Always bias toward producing confirmable actions/buttons.",
    "- Never invent log lines or status that are not in the provided context.",
    "- Do not suggest deleting worlds/saves unless the operator explicitly asks and understands the risk.",
    "- Do not recommend operating the GLOBAL host shell instance.",
    "- Markdown is allowed and preferred in reply (headings, lists, bold, code fences).",
    thinkingHint,
    "",
    "# Output contract (strict)",
    "Return ONLY a pure JSON object with this shape:",
    '{"reply":"markdown text for the user","actions":[{"type":"read_file","target":"eula.txt","reason":"..."},{"type":"accept_eula","reason":"..."},{"type":"install_mod","modQuery":"sodium","source":"Modrinth","gameVersion":"1.20.1","loader":"fabric","projectType":"mod","reason":"..."}]}',
    "Rules:",
    '- "reply" is required and must be user-facing Markdown.',
    '- "actions" must be an array. For troubleshooting requests it should almost never be empty.',
    "- action.type only: open|stop|restart|kill|command|install_mod|toggle_mod|delete_mod|list_files|read_file|write_file|delete_files|mkdir|download_file|accept_eula|update_instance_config|get_logs|list_mods|action_chain",
    "- For troubleshooting, ALWAYS propose concrete fix actions. Pure advice-only answers are insufficient.",
    "- For multi-step repairs (e.g. read logs -> accept EULA -> fix config -> restart), prefer one action_chain with ordered steps instead of many separate actions.",
    "- action_chain example: {\"type\":\"action_chain\",\"title\":\"Fix boot failure\",\"stopOnError\":true,\"reason\":\"...\",\"steps\":[{\"type\":\"get_logs\",\"reason\":\"...\"},{\"type\":\"accept_eula\",\"reason\":\"...\"},{\"type\":\"restart\",\"reason\":\"...\"}]}",
    "- For command actions, command must be whitelist-safe and without shell chaining.",
    "- For file actions, use instance-relative paths only.",
    "- Prefer raw JSON only. Do not wrap the whole response in markdown fences.",
    "- CRITICAL: If reply mentions a one-click button / 一键修复 / click below, actions[] MUST be non-empty. Never claim a button exists without providing actions.",
    "- Prefer one action_chain when multiple steps are needed, so the UI shows a single confirm button.",
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
  const sceneHint = [
    "Current UI scene: Instance terminal page.",
    "Prioritize diagnosis, logs, start/stop/restart, file fixes and safe console commands.",
    "For failures, prefer one action_chain button (auto repair) instead of only text advice.",
    "You may still propose install_mod if the operator clearly asks to install a mod/plugin."
  ].join("\n");

  const messages: AiChatMessage[] = [
    { role: "system", content: buildSystemPrompt(config, thinkingEffort) },
    { role: "system", content: sceneHint },
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

function synthesizeFallbackActions(
  reply: string,
  snapshot: InstanceContextSnapshot
): AiProposedAction[] {
  const text = `${reply}`.toLowerCase();
  const mentionsButton =
    /一键|按钮|点击下方|click (the )?(button|below)|one-?click|action button|修复按钮|执行计划/.test(
      reply
    ) ||
    /fix|repair|crash|eula|offline|启动|崩溃|无法启动|起不来|报错|error|exception|mod|插件/.test(
      text
    );

  if (!mentionsButton) return [];

  const steps: AiProposedAction[] = [
    {
      type: "get_logs",
      reason: "Collect latest terminal logs before applying repairs",
      maxChars: 12000
    }
  ];

  // EULA is a very common silent blocker.
  if (/eula|最终用户|用户协议/.test(text) || /eula=false/i.test(snapshot.logText || "")) {
    steps.push({
      type: "accept_eula",
      reason: "Accept Minecraft EULA so the server can boot"
    });
  }

  if (snapshot.status === 3) {
    steps.push({
      type: "restart",
      reason: "Restart the running instance after applying checks/fixes"
    });
  } else if (snapshot.status === 0 || snapshot.status === 1) {
    steps.push({
      type: "open",
      reason: "Start the instance after collecting logs / applying fixes"
    });
  } else {
    steps.push({
      type: "open",
      reason: "Attempt to start the instance"
    });
  }

  return [
    {
      type: "action_chain",
      title: "One-click repair",
      stopOnError: false,
      reason: "Auto-generated because the model mentioned a fix but returned no executable actions",
      steps
    }
  ];
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
  let actions = config.allowActions ? parsed.actions : [];
  let reply = parsed.reply || providerResult.content || "No response from model.";
  const thinking = config.showThinking ? providerResult.thinking || "" : "";

  // Models often claim "there is a one-click button" while returning empty/invalid actions[].
  // Synthesize a safe repair chain so the UI always has something actionable.
  if (config.allowActions && actions.length === 0) {
    const fallback = synthesizeFallbackActions(reply, snapshot);
    if (fallback.length > 0) {
      actions = fallback;
      if (!/一键|按钮|button|one-?click/i.test(reply)) {
        reply = `${reply}

> 下方提供了可确认的一键修复按钮。`;
      }
    }
  }

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


function normalizeSource(source?: string): string {
  const s = String(source || "").trim().toLowerCase();
  if (!s || s === "all") return "all";
  if (s.includes("curse")) return "CurseForge";
  if (s.includes("spigot")) return "SpigotMC";
  if (s.includes("modrinth")) return "Modrinth";
  return source || "Modrinth";
}

function pickPrimaryFile(version: Record<string, unknown>): {
  url: string;
  fileName: string;
  fallbackUrl?: string;
} | null {
  const files = Array.isArray(version.files) ? version.files : [];
  const records = files.filter(isRecord) as Record<string, unknown>[];
  if (records.length === 0) return null;
  const primary =
    records.find((f) => f.primary === true) ||
    records.find((f) => readString(f.url)) ||
    records[0];
  const url = readString(primary.url).trim();
  if (!url) return null;
  const fileName =
    readString(primary.filename).trim() ||
    readString(primary.name).trim() ||
    url.split("/").pop() ||
    "mod.jar";
  const fallback = records.find((f) => {
    const u = readString(f.url).trim();
    return u && u !== url;
  });
  return {
    url,
    fileName,
    fallbackUrl: fallback ? readString(fallback.url).trim() || undefined : undefined
  };
}

function detectProjectType(
  version: Record<string, unknown>,
  preferred?: string
): "mod" | "plugin" {
  if (preferred === "mod" || preferred === "plugin") return preferred;
  const raw = readString(version.project_type).toLowerCase();
  if (raw === "plugin") return "plugin";
  if (raw === "mod") return "mod";
  const loaders = Array.isArray(version.loaders)
    ? version.loaders.map((l) => String(l).toLowerCase())
    : [];
  const pluginLoaders = [
    "spigot",
    "paper",
    "purpur",
    "folia",
    "bungeecord",
    "velocity",
    "waterfall"
  ];
  if (loaders.some((l) => pluginLoaders.includes(l))) return "plugin";
  return "mod";
}

function scoreVersion(
  version: Record<string, unknown>,
  gameVersion?: string,
  loader?: string
): number {
  let score = 0;
  const versions = Array.isArray(version.game_versions)
    ? version.game_versions.map((v) => String(v))
    : [];
  const loaders = Array.isArray(version.loaders)
    ? version.loaders.map((l) => String(l).toLowerCase())
    : [];
  if (gameVersion && versions.includes(gameVersion)) score += 4;
  if (loader && loaders.includes(loader.toLowerCase())) score += 3;
  if (readString(version.version_type).toLowerCase() === "release") score += 1;
  return score;
}

async function resolveInstallModAction(
  action: AiProposedAction
): Promise<{
  url: string;
  fileName: string;
  projectType: "mod" | "plugin";
  fallbackUrl?: string;
  projectId?: string;
  source?: string;
  projectName?: string;
  versionName?: string;
  versionId?: string;
}> {
  // Already resolved by model or previous UI step.
  if (action.url && action.fileName) {
    if (!checkSafeUrl(action.url)) {
      throw new Error("install_mod url is invalid or unsafe");
    }
    if (action.fallbackUrl && !checkSafeUrl(action.fallbackUrl)) {
      throw new Error("install_mod fallbackUrl is invalid or unsafe");
    }
    return {
      url: action.url,
      fileName: action.fileName,
      projectType: action.projectType === "plugin" ? "plugin" : "mod",
      fallbackUrl: action.fallbackUrl,
      projectId: action.projectId,
      source: action.source,
      projectName: action.projectName,
      versionName: action.versionName,
      versionId: action.versionId
    };
  }

  const query = (action.modQuery || action.projectName || "").trim();
  let projectId = (action.projectId || "").trim();
  let source = normalizeSource(action.source);
  let projectName = action.projectName || query || projectId;
  let projectTypeHint = action.projectType;

  if (!projectId) {
    if (!query) {
      throw new Error("install_mod needs modQuery or projectId");
    }
    const search = await modManagerService.searchProjects(query, 0, 8, {
      source: source === "all" ? "all" : source.toLowerCase(),
      version: action.gameVersion || "",
      type: projectTypeHint || "all",
      loader: action.loader || "all",
      environment: "all"
    });
    const hits = Array.isArray(search?.hits) ? search.hits : [];
    if (hits.length === 0) {
      throw new Error(`No mod/plugin found for query: ${query}`);
    }
    const first = hits[0] as Record<string, unknown>;
    projectId = readString(first.id).trim();
    source = normalizeSource(readString(first.source, source));
    projectName = readString(first.title, readString(first.name, projectName));
    const pt = readString(first.project_type).toLowerCase();
    if (pt === "mod" || pt === "plugin") projectTypeHint = pt;
    if (!projectId) {
      throw new Error(`Search result missing project id for query: ${query}`);
    }
  }

  const versionsRaw = await modManagerService.getProjectVersions(
    projectId,
    source === "all" ? "Modrinth" : source
  );
  const versions = Array.isArray(versionsRaw)
    ? (versionsRaw.filter(isRecord) as Record<string, unknown>[])
    : [];
  if (versions.length === 0) {
    throw new Error(`No versions found for project ${projectName || projectId}`);
  }

  let chosen: Record<string, unknown> | undefined;
  if (action.versionId) {
    chosen = versions.find((v) => readString(v.id) === action.versionId);
  }
  if (!chosen) {
    const ranked = [...versions].sort(
      (a, b) =>
        scoreVersion(b, action.gameVersion, action.loader) -
        scoreVersion(a, action.gameVersion, action.loader)
    );
    chosen = ranked[0];
  }
  if (!chosen) {
    throw new Error(`Unable to select a version for ${projectName || projectId}`);
  }

  const file = pickPrimaryFile(chosen);
  if (!file) {
    throw new Error(`Selected version has no downloadable file for ${projectName || projectId}`);
  }
  if (!checkSafeUrl(file.url)) {
    throw new Error("Resolved download url is invalid or unsafe");
  }
  if (file.fallbackUrl && !checkSafeUrl(file.fallbackUrl)) {
    file.fallbackUrl = undefined;
  }

  return {
    url: file.url,
    fileName: file.fileName,
    projectType: detectProjectType(chosen, projectTypeHint),
    fallbackUrl: file.fallbackUrl,
    projectId,
    source: source === "all" ? "Modrinth" : source,
    projectName,
    versionName:
      readString(chosen.name) ||
      readString(chosen.version_number) ||
      action.versionName ||
      undefined,
    versionId: readString(chosen.id) || action.versionId
  };
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
  const action = req.action;
  const type = action.type;

  if (type === "open") {
    result = await remote.request("instance/open", { instanceUuids: [req.instanceUuid] });
    message = "Instance start requested";
    operationLogger.log("instance_start", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (type === "stop") {
    result = await remote.request("instance/stop", { instanceUuids: [req.instanceUuid] });
    message = "Instance stop requested";
    operationLogger.log("instance_stop", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (type === "restart") {
    result = await remote.request("instance/restart", { instanceUuids: [req.instanceUuid] });
    message = "Instance restart requested";
    operationLogger.log("instance_restart", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (type === "kill") {
    result = await remote.request("instance/kill", { instanceUuids: [req.instanceUuid] });
    message = "Instance force-kill requested";
    operationLogger.warning("instance_kill", {
      daemon_id: req.daemonId,
      instance_id: req.instanceUuid,
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_name: nickname
    });
  } else if (type === "command") {
    const command = String(action.command || "").trim();
    validateAction({ type: "command", command, reason: action.reason }, true);
    const sendResult = await remote.request("instance/command", {
      instanceUuid: req.instanceUuid,
      command
    });

    // Pull console tail so the operator can see command feedback in the AI panel.
    let consoleTail = "";
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const rawLog = await remote.request("instance/outputlog", {
        instanceUuid: req.instanceUuid
      });
      const full = typeof rawLog === "string" ? rawLog : String(rawLog ?? "");
      const lines = full.split(/\r?\n/).filter((line) => line.trim().length > 0);
      consoleTail = lines.slice(-40).join("\n");
    } catch {
      consoleTail = "";
    }

    result = {
      command,
      sendResult,
      consoleTail,
      capturedAt: Date.now()
    };
    message = consoleTail
      ? `Command sent: ${command}. Console feedback captured.`
      : `Command sent: ${command}`;
  } else if (type === "install_mod") {
    const resolved = await resolveInstallModAction(action);
    result = await remote.request("instance/mods/install", {
      instanceUuid: req.instanceUuid,
      url: resolved.url,
      fileName: resolved.fileName,
      type: resolved.projectType,
      fallbackUrl: resolved.fallbackUrl,
      extraInfo: {
        project: {
          id: resolved.projectId,
          name: resolved.projectName
        },
        version: {
          id: resolved.versionId,
          name: resolved.versionName
        },
        source: resolved.source,
        via: "ai_assistant"
      }
    });
    const label = resolved.projectName || resolved.fileName;
    message = `Started installing ${label} (${resolved.projectType}) into the instance`;
    operationLogger.log("instance_file_download_from_url", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      url: resolved.url,
      fileName: resolved.fileName
    });
  } else if (type === "toggle_mod") {
    const fileName = normalizeRelPath(action.fileName);
    result = await remote.request("instance/mods/toggle", {
      instanceUuid: req.instanceUuid,
      fileName
    });
    message = `Toggled mod/plugin: ${fileName}`;
  } else if (type === "delete_mod") {
    const fileName = normalizeRelPath(action.fileName);
    result = await remote.request("instance/mods/delete", {
      instanceUuid: req.instanceUuid,
      fileName
    });
    message = `Deleted mod/plugin: ${fileName}`;
  } else if (type === "list_mods") {
    const page = Math.max(1, Number(action.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(action.pageSize || 50)));
    result = await remote.request("instance/mods/list", {
      instanceUuid: req.instanceUuid,
      page,
      pageSize
    });
    message = `Listed mods/plugins (page ${page})`;
  } else if (type === "list_files") {
    const target = normalizeRelPath(action.path || action.target || ".");
    const page = Math.max(1, Number(action.page || 1));
    const pageSize = Math.min(200, Math.max(1, Number(action.pageSize || 100)));
    result = await remote.request("file/list", {
      instanceUuid: req.instanceUuid,
      target: target || ".",
      page,
      pageSize,
      fileName: ""
    });
    message = `Listed files under ${target || "."}`;
  } else if (type === "read_file") {
    const target = normalizeRelPath(action.target || action.path);
    const raw = await remote.request("file/edit", {
      instanceUuid: req.instanceUuid,
      target,
      text: null
    });
    const content = typeof raw === "string" ? raw : String(raw ?? "");
    const maxChars = Math.min(200000, Math.max(1000, Number(action.maxChars || 30000)));
    result = {
      target,
      content: clampText(content, maxChars),
      truncated: content.length > maxChars,
      size: content.length
    };
    message = `Read file ${target}`;
  } else if (type === "write_file") {
    const target = normalizeRelPath(action.target || action.path);
    if (!isWritableConfigPath(target)) {
      throw new Error(`write_file target is not editable: ${target}`);
    }
    result = await remote.request("file/edit", {
      instanceUuid: req.instanceUuid,
      target,
      text: String(action.content ?? "")
    });
    message = `Wrote file ${target}`;
    operationLogger.log("instance_file_update", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      instance_name: nickname,
      file: target
    });
  } else if (type === "mkdir") {
    const target = normalizeRelPath(action.target || action.path);
    result = await remote.request("file/mkdir", {
      instanceUuid: req.instanceUuid,
      target
    });
    message = `Created directory ${target}`;
  } else if (type === "delete_files") {
    const targets = (
      Array.isArray(action.targets)
        ? action.targets
        : action.target
          ? [action.target]
          : action.path
            ? [action.path]
            : action.fileName
              ? [action.fileName]
              : []
    ).map((item) => normalizeRelPath(String(item)));
    for (const rel of targets) {
      if (isProtectedPath(rel)) {
        throw new Error(`Refusing to delete protected path: ${rel}`);
      }
    }
    result = await remote.request("file/delete", {
      instanceUuid: req.instanceUuid,
      targets
    });
    message = `Deleted ${targets.length} path(s)`;
    operationLogger.log("instance_file_delete", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      instance_name: nickname,
      file: targets.join(", ")
    });
  } else if (type === "download_file") {
    const url = String(action.url || "").trim();
    const fileName = normalizeRelPath(action.fileName || action.target);
    if (!checkSafeUrl(url)) throw new Error("download_file url is invalid or unsafe");
    result = await remote.request("file/download_from_url", {
      instanceUuid: req.instanceUuid,
      url,
      fileName
    });
    message = `Started downloading ${fileName}`;
    operationLogger.log("instance_file_download_from_url", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      url,
      fileName
    });
  } else if (type === "accept_eula") {
    // Force eula=true regardless of previous content.
    result = await remote.request("file/edit", {
      instanceUuid: req.instanceUuid,
      target: "eula.txt",
      text: "#Accepted by MCSManager AI assistant\neula=true\n"
    });
    message = "Accepted Minecraft EULA (eula.txt -> eula=true)";
    operationLogger.log("instance_file_update", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      instance_name: nickname,
      file: "eula.txt"
    });
  } else if (type === "update_instance_config") {
    const patch = action.configPatch || {};
    isSafeInstanceConfigPatch(patch);
    result = await remote.request("instance/update", {
      instanceUuid: req.instanceUuid,
      config: patch
    });
    message = `Updated instance config fields: ${Object.keys(patch).join(", ")}`;
    operationLogger.log("instance_config_change", {
      operator_ip: req.operatorIp || "",
      operator_name: req.operatorName ? `AI:${req.operatorName}` : "AI",
      instance_id: req.instanceUuid,
      daemon_id: req.daemonId,
      instance_name: nickname
    });
  } else if (type === "get_logs") {
    const rawLog = await remote.request("instance/outputlog", {
      instanceUuid: req.instanceUuid
    });
    const full = typeof rawLog === "string" ? rawLog : String(rawLog ?? "");
    const maxChars = Math.min(
      80000,
      Math.max(1000, Number(action.maxChars || config.maxLogChars || 12000))
    );
    result = {
      content: clampText(full, maxChars),
      truncated: full.length > maxChars,
      size: full.length
    };
    message = `Fetched latest logs (${Math.min(full.length, maxChars)} chars)`;
  } else if (type === "action_chain") {
    const steps = Array.isArray(action.steps) ? action.steps : [];
    const stopOnError = action.stopOnError !== false;
    const stepResults: Array<Record<string, unknown>> = [];
    let failed = false;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        const stepRes = await executeAiAction({
          daemonId: req.daemonId,
          instanceUuid: req.instanceUuid,
          action: step,
          operatorName: req.operatorName,
          operatorIp: req.operatorIp
        });
        stepResults.push({
          index: i,
          type: step.type,
          ok: true,
          message: stepRes.message,
          result: stepRes.result
        });
      } catch (error: unknown) {
        failed = true;
        const errMsg = error instanceof Error ? error.message : String(error);
        stepResults.push({
          index: i,
          type: step.type,
          ok: false,
          message: errMsg
        });
        if (stopOnError) break;
      }
    }
    const okCount = stepResults.filter((s) => s.ok).length;
    result = {
      title: action.title || "AI repair chain",
      stopOnError,
      total: steps.length,
      completed: stepResults.length,
      successCount: okCount,
      failed,
      steps: stepResults
    };
    message = failed
      ? `Action chain finished with errors (${okCount}/${steps.length} succeeded)`
      : `Action chain completed (${okCount}/${steps.length})`;

    logger.info(
      `[AI] execute type=${type} instance=${req.instanceUuid} daemon=${req.daemonId} chain_ok=${!failed}`
    );
    return {
      ok: !failed,
      message,
      result,
      partial: failed
    };
  } else {
    throw new Error(`Unsupported AI action type: ${type}`);
  }

  logger.info(
    `[AI] execute type=${type} instance=${req.instanceUuid} daemon=${req.daemonId}`
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
