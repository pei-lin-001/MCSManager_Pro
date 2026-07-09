// AI assistant configuration for personal server management.

export type AiProviderKind = "openai_compatible";

// How hard the model should "think" before answering.
// off = no thinking request / hide thinking UI by default
// low | medium | high = provider reasoning effort (best-effort across OpenAI-compatible APIs)
export type AiThinkingEffort = "off" | "low" | "medium" | "high";

export default class AiConfig {
  // Master switch for the AI assistant feature.
  enabled: boolean = false;

  // OpenAI-compatible chat completions endpoint, e.g. https://api.openai.com/v1
  // DeepSeek / Tongyi OpenAI-compatible gateways also work here.
  apiBaseUrl: string = "https://api.openai.com/v1";

  // Cloud model API key. Never expose this field to non-admin clients.
  apiKey: string = "";

  // Model id used by the provider, e.g. gpt-4o-mini / deepseek-chat / deepseek-reasoner
  model: string = "gpt-4o-mini";

  // Optional custom system prompt appended to the built-in assistant policy.
  systemPrompt: string = "";

  // Max terminal log characters sent as context for diagnosis.
  maxLogChars: number = 12000;

  // Whether the assistant may propose executable actions (still requires confirm).
  allowActions: boolean = true;

  // Stream tokens to the browser (SSE). Recommended on.
  streamEnabled: boolean = true;

  // Show model thinking / reasoning content in the UI when available.
  showThinking: boolean = true;

  // Thinking intensity for compatible models.
  thinkingEffort: AiThinkingEffort = "medium";

  // Provider protocol. V1 only supports OpenAI-compatible chat completions.
  provider: AiProviderKind = "openai_compatible";
}
