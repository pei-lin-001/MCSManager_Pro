import StorageSystem from "../common/system_storage";
import AiConfig, { type AiThinkingEffort } from "../entity/ai_config";

let aiConfig: AiConfig | null = null;

const THINKING_EFFORTS: AiThinkingEffort[] = ["off", "low", "medium", "high"];

function normalizeThinkingEffort(value: unknown, fallback: AiThinkingEffort = "medium"): AiThinkingEffort {
  const text = String(value || "").toLowerCase();
  if ((THINKING_EFFORTS as string[]).includes(text)) {
    return text as AiThinkingEffort;
  }
  return fallback;
}

function hydrateAiConfig(raw: AiConfig): AiConfig {
  const config = new AiConfig();
  config.enabled = Boolean(raw.enabled);
  config.apiBaseUrl = String(raw.apiBaseUrl || config.apiBaseUrl);
  config.apiKey = String(raw.apiKey || "");
  config.model = String(raw.model || config.model);
  config.systemPrompt = String(raw.systemPrompt || "");
  config.maxLogChars = Number(raw.maxLogChars || 12000);
  config.allowActions = raw.allowActions !== false;
  config.streamEnabled = raw.streamEnabled !== false;
  config.showThinking = raw.showThinking !== false;
  config.thinkingEffort = normalizeThinkingEffort(raw.thinkingEffort, "medium");
  config.provider = "openai_compatible";
  if (config.maxLogChars < 1000) config.maxLogChars = 1000;
  if (config.maxLogChars > 80000) config.maxLogChars = 80000;
  return config;
}

export function initAiConfig(): AiConfig {
  const loaded = StorageSystem.load("AiConfig", AiConfig, "ai");
  if (loaded) {
    const config = hydrateAiConfig(loaded as AiConfig);
    aiConfig = config;
    return config;
  }
  const created = new AiConfig();
  aiConfig = created;
  StorageSystem.store("AiConfig", "ai", created);
  return created;
}

export function getAiConfig(): AiConfig {
  if (!aiConfig) {
    return initAiConfig();
  }
  return aiConfig;
}

export function saveAiConfig(config: AiConfig): void {
  const normalized = hydrateAiConfig(config);
  aiConfig = normalized;
  StorageSystem.store("AiConfig", "ai", normalized);
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

export function toPublicAiConfig(config: AiConfig): AiPublicConfig {
  return {
    enabled: Boolean(config.enabled),
    apiBaseUrl: String(config.apiBaseUrl || ""),
    model: String(config.model || ""),
    systemPrompt: String(config.systemPrompt || ""),
    maxLogChars: Number(config.maxLogChars || 12000),
    allowActions: Boolean(config.allowActions),
    streamEnabled: config.streamEnabled !== false,
    showThinking: config.showThinking !== false,
    thinkingEffort: normalizeThinkingEffort(config.thinkingEffort, "medium"),
    provider: String(config.provider || "openai_compatible"),
    hasApiKey: Boolean(config.apiKey && config.apiKey.length > 0)
  };
}

export { normalizeThinkingEffort, THINKING_EFFORTS };
