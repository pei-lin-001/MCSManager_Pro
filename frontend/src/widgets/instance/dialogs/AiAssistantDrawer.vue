<script setup lang="ts">
import { t } from "@/lang/i18n";
import {
  aiExecuteApi,
  aiStatusApi,
  streamAiChat,
  type AiChatMessage,
  type AiChatScene,
  type AiProposedAction,
  type AiStatus,
  type AiThinkingEffort
} from "@/services/apis/ai";
import { markdownToHTML } from "@/tools/safe";
import { reportErrorMsg } from "@/tools/validator";
import {
  AlertOutlined,
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
  RobotOutlined,
  SendOutlined
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    instanceId: string;
    daemonId: string;
    instanceName?: string;
    scene?: AiChatScene;
    hideIncludeLog?: boolean;
  }>(),
  {
    scene: "terminal",
    hideIncludeLog: false
  }
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

interface ChatItem {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  actions?: AiProposedAction[];
  streaming?: boolean;
  showThinking?: boolean;
}

const inputText = ref("");
const includeLog = ref(props.scene !== "mod_library");
const messages = ref<ChatItem[]>([]);
const status = ref<AiStatus | null>(null);
const listRef = ref<HTMLElement | null>(null);
const executingKey = ref("");
const chatLoading = ref(false);
const thinkingEffort = ref<AiThinkingEffort>("medium");
let abortController: AbortController | null = null;

const { execute: fetchStatus, isLoading: statusLoading } = aiStatusApi();
const { execute: requestExecute, isLoading: executeLoading } = aiExecuteApi();

const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit("update:open", value)
});

const canSend = computed(() => {
  return (
    !!props.instanceId &&
    !!props.daemonId &&
    !!inputText.value.trim() &&
    !chatLoading.value &&
    status.value?.enabled === true &&
    status.value?.configured === true
  );
});

const thinkingOptions = computed(() => [
  { label: t("TXT_CODE_AI_THINKING_OFF"), value: "off" as const },
  { label: t("TXT_CODE_AI_THINKING_LOW"), value: "low" as const },
  { label: t("TXT_CODE_AI_THINKING_MEDIUM"), value: "medium" as const },
  { label: t("TXT_CODE_AI_THINKING_HIGH"), value: "high" as const }
]);

const quickPrompts = computed(() => {
  if (props.scene === "mod_library") {
    return [
      t("TXT_CODE_AI_PROMPT_INSTALL_MOD"),
      t("TXT_CODE_AI_PROMPT_RECOMMEND_MODS"),
      t("TXT_CODE_AI_PROMPT_INSTALL_PLUGIN"),
      t("TXT_CODE_AI_PROMPT_CHECK_LOADER")
    ];
  }
  return [
    t("TXT_CODE_AI_PROMPT_DIAGNOSE"),
    t("TXT_CODE_AI_PROMPT_WHY_OFFLINE"),
    t("TXT_CODE_AI_PROMPT_RESTART_SAFE"),
    t("TXT_CODE_AI_PROMPT_ANNOUNCE")
  ];
});

const loadStatus = async () => {
  try {
    const res = await fetchStatus();
    status.value = res.value ?? null;
    if (status.value?.thinkingEffort) {
      thinkingEffort.value = status.value.thinkingEffort;
    }
  } catch (error: unknown) {
    reportErrorMsg(error);
  }
};

const scrollToBottom = async () => {
  await nextTick();
  if (listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight;
  }
};

/**
 * Extract user-facing text from model output.
 * During stream the model may still be emitting protocol JSON like {"reply":"..."}.
 * We hide raw braces and only show the reply field (even partially).
 */
const extractDisplayText = (content: string, streaming = false): string => {
  const raw = content || "";
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Full JSON protocol object
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        "reply" in parsed &&
        typeof (parsed as { reply: unknown }).reply === "string"
      ) {
        return (parsed as { reply: string }).reply;
      }
    } catch {
      // Partial stream: try to pull "reply":"..."
      const match = trimmed.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)/);
      if (match?.[1] != null) {
        try {
          return JSON.parse(`"${match[1]}"`) as string;
        } catch {
          return match[1]
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
        }
      }
      // Still incomplete JSON and no reply yet — don't dump braces to UI
      if (streaming) return "";
    }
  }

  // ```json ... ``` fenced block
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenced?.[1]) {
    return extractDisplayText(fenced[1], streaming);
  }

  return raw;
};

const renderMarkdown = (content: string, streaming = false): string => {
  const text = extractDisplayText(content, streaming);
  if (!text) return "";
  return markdownToHTML(text);
};

const actionLabel = (action: AiProposedAction): string => {
  if (action.type === "open") return t("TXT_CODE_AI_ACTION_OPEN");
  if (action.type === "stop") return t("TXT_CODE_AI_ACTION_STOP");
  if (action.type === "restart") return t("TXT_CODE_AI_ACTION_RESTART");
  if (action.type === "kill") return t("TXT_CODE_AI_ACTION_KILL");
  if (action.type === "install_mod") {
    const name = action.projectName || action.modQuery || action.fileName || action.projectId || "";
    return name
      ? `${t("TXT_CODE_AI_ACTION_INSTALL_MOD")}: ${name}`
      : t("TXT_CODE_AI_ACTION_INSTALL_MOD");
  }
  if (action.type === "toggle_mod") {
    return `${t("TXT_CODE_AI_ACTION_TOGGLE_MOD")}: ${action.fileName || ""}`;
  }
  if (action.type === "delete_mod") {
    return `${t("TXT_CODE_AI_ACTION_DELETE_MOD")}: ${action.fileName || ""}`;
  }
  if (action.type === "list_files") {
    return `${t("TXT_CODE_AI_ACTION_LIST_FILES")}: ${action.path || action.target || "."}`;
  }
  if (action.type === "read_file") {
    return `${t("TXT_CODE_AI_ACTION_READ_FILE")}: ${action.target || action.path || ""}`;
  }
  if (action.type === "write_file") {
    return `${t("TXT_CODE_AI_ACTION_WRITE_FILE")}: ${action.target || action.path || ""}`;
  }
  if (action.type === "delete_files") {
    const n = action.targets?.length || (action.target || action.path || action.fileName ? 1 : 0);
    return `${t("TXT_CODE_AI_ACTION_DELETE_FILES")} (${n})`;
  }
  if (action.type === "mkdir") {
    return `${t("TXT_CODE_AI_ACTION_MKDIR")}: ${action.target || action.path || ""}`;
  }
  if (action.type === "download_file") {
    return `${t("TXT_CODE_AI_ACTION_DOWNLOAD_FILE")}: ${action.fileName || action.target || ""}`;
  }
  if (action.type === "accept_eula") return t("TXT_CODE_AI_ACTION_ACCEPT_EULA");
  if (action.type === "update_instance_config") return t("TXT_CODE_AI_ACTION_UPDATE_CONFIG");
  if (action.type === "get_logs") return t("TXT_CODE_AI_ACTION_GET_LOGS");
  if (action.type === "list_mods") return t("TXT_CODE_AI_ACTION_LIST_MODS");
  if (action.type === "action_chain") {
    const title = action.title || t("TXT_CODE_AI_ACTION_CHAIN");
    const n = action.steps?.length || 0;
    return `${title} (${n} ${t("TXT_CODE_AI_ACTION_CHAIN_STEPS")})`;
  }
  return `${t("TXT_CODE_AI_ACTION_COMMAND")}: ${action.command || ""}`;
};

const stopStreaming = () => {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  chatLoading.value = false;
};

const sendMessage = async (preset?: string) => {
  const text = (preset ?? inputText.value).trim();
  if (!text || chatLoading.value) return;
  if (!props.instanceId || !props.daemonId) {
    message.warning(t("TXT_CODE_AI_NO_INSTANCE"));
    return;
  }
  if (!status.value?.enabled || !status.value?.configured) {
    message.warning(t("TXT_CODE_AI_NOT_READY"));
    return;
  }

  messages.value.push({ role: "user", content: text });
  inputText.value = "";
  await scrollToBottom();

  const history: AiChatMessage[] = messages.value
    .filter((item) => item.role === "user" || item.role === "assistant")
    .slice(0, -1)
    .slice(-10)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content
    }));

  const assistantIndex =
    messages.value.push({
      role: "assistant",
      content: "",
      thinking: "",
      actions: [],
      streaming: true,
      showThinking: false
    }) - 1;

  chatLoading.value = true;
  abortController = new AbortController();

  try {
    await streamAiChat({
      daemonId: props.daemonId,
      instanceUuid: props.instanceId,
      message: text,
      history,
      includeLog: props.scene === "mod_library" ? false : includeLog.value,
      thinkingEffort: thinkingEffort.value,
      scene: props.scene,
      signal: abortController.signal,
      onEvent: (event) => {
        const current = messages.value[assistantIndex];
        if (!current || current.role !== "assistant") return;

        if (event.type === "thinking") {
          current.thinking = `${current.thinking || ""}${event.delta}`;
          current.showThinking = true;
        } else if (event.type === "delta") {
          // While streaming raw model text (often JSON), show progressive text.
          current.content = `${current.content || ""}${event.delta}`;
        } else if (event.type === "done") {
          current.content = event.reply || current.content || t("TXT_CODE_AI_EMPTY_REPLY");
          current.thinking = event.thinking || current.thinking || "";
          current.actions = event.actions || [];
          current.streaming = false;
          current.showThinking = Boolean(current.thinking);
        } else if (event.type === "error") {
          current.streaming = false;
          current.content = current.content || t("TXT_CODE_AI_CHAT_FAILED");
        }
        void scrollToBottom();
      }
    });

    const finalItem = messages.value[assistantIndex];
    if (finalItem && finalItem.role === "assistant") {
      finalItem.streaming = false;
      if (!finalItem.content) {
        finalItem.content = t("TXT_CODE_AI_EMPTY_REPLY");
      }
    }
  } catch (error: unknown) {
    const aborted =
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");
    if (!aborted) {
      reportErrorMsg(error);
      const current = messages.value[assistantIndex];
      if (current && current.role === "assistant") {
        current.streaming = false;
        if (!current.content) current.content = t("TXT_CODE_AI_CHAT_FAILED");
      } else {
        messages.value.push({
          role: "system",
          content: t("TXT_CODE_AI_CHAT_FAILED")
        });
      }
    } else {
      const current = messages.value[assistantIndex];
      if (current && current.role === "assistant") {
        current.streaming = false;
        if (!current.content) current.content = t("TXT_CODE_AI_STREAM_STOPPED");
      }
    }
  } finally {
    chatLoading.value = false;
    abortController = null;
    await scrollToBottom();
  }
};

const confirmAction = async (action: AiProposedAction, index: number) => {
  if (!props.instanceId || !props.daemonId) return;
  const key = `${index}-${action.type}-${action.command || ""}-${action.modQuery || ""}-${action.projectId || ""}-${action.versionId || ""}-${action.target || ""}-${action.path || ""}-${action.fileName || ""}-${action.title || ""}`;
  executingKey.value = key;
  try {
    const res = await requestExecute({
      data: {
        daemonId: props.daemonId,
        instanceUuid: props.instanceId,
        action
      }
    });

    const ok = res.value?.ok !== false;
    if (ok) {
      message.success(res.value?.message || t("TXT_CODE_AI_ACTION_DONE"));
    } else {
      message.warning(res.value?.message || t("TXT_CODE_AI_CHAIN_PARTIAL"));
    }

    let detail = `${ok ? t("TXT_CODE_AI_ACTION_DONE") : t("TXT_CODE_AI_CHAIN_PARTIAL")}: ${actionLabel(action)}`;
    const result = res.value?.result as any;

    if (action.type === "action_chain" && result?.steps) {
      detail += `\n\n${t("TXT_CODE_AI_CHAIN_PROGRESS")}: ${result.successCount}/${result.total}`;
      const lines = (result.steps as any[])
        .map((step, i) => {
          const mark = step.ok ? "✅" : "❌";
          return `${mark} ${i + 1}. ${step.type}: ${step.message || ""}`;
        })
        .join("\n");
      detail += `\n\n\`\`\`text\n${lines}\n\`\`\``;
      // include short outputs from read/get_logs steps
      for (const step of result.steps as any[]) {
        if (!step?.ok) continue;
        if ((step.type === "read_file" || step.type === "get_logs") && step.result?.content) {
          detail += `\n\n**${step.type}**\n\`\`\`text\n${String(step.result.content).slice(0, 2500)}\n\`\`\``;
        }
      }
    } else if (action.type === "read_file" && result?.content != null) {
      detail += `\n\n\`\`\`text\n${String(result.content).slice(0, 4000)}\n\`\`\``;
      if (result.truncated) detail += `\n\n_${t("TXT_CODE_AI_RESULT_TRUNCATED")}_`;
    } else if (action.type === "get_logs" && result?.content != null) {
      detail += `\n\n\`\`\`log\n${String(result.content).slice(0, 4000)}\n\`\`\``;
      if (result.truncated) detail += `\n\n_${t("TXT_CODE_AI_RESULT_TRUNCATED")}_`;
    } else if ((action.type === "list_files" || action.type === "list_mods") && result) {
      try {
        const pretty = JSON.stringify(result, null, 2);
        detail += `\n\n\`\`\`json\n${pretty.slice(0, 4000)}\n\`\`\``;
      } catch {
        // ignore
      }
    } else if (res.value?.message) {
      detail += `\n${res.value.message}`;
    }

    messages.value.push({
      role: "system",
      content: detail
    });
    await scrollToBottom();
  } catch (error: unknown) {
    reportErrorMsg(error);
  } finally {
    executingKey.value = "";
  }
};

const clearChat = () => {
  stopStreaming();
  messages.value = [];
};

const toggleThinking = (index: number) => {
  const item = messages.value[index];
  if (!item || item.role !== "assistant") return;
  item.showThinking = !item.showThinking;
};

watch(
  () => props.open,
  (open) => {
    if (open) loadStatus();
  }
);

watch(
  () => [props.instanceId, props.daemonId],
  () => {
    stopStreaming();
    messages.value = [];
  }
);

onMounted(() => {
  if (props.open) loadStatus();
});

onUnmounted(() => {
  stopStreaming();
});
</script>

<template>
  <a-drawer
    v-model:open="drawerOpen"
    :title="t('TXT_CODE_AI_ASSISTANT_TITLE')"
    placement="right"
    :width="460"
    :body-style="{ padding: '12px 16px', display: 'flex', flexDirection: 'column', height: '100%' }"
  >
    <div class="ai-header mb-12">
      <div class="ai-title-row">
        <RobotOutlined class="mr-8" />
        <span>{{ instanceName || t("TXT_CODE_AI_CURRENT_INSTANCE") }}</span>
      </div>
      <a-typography-text type="secondary" class="ai-desc">
        {{
          scene === "mod_library"
            ? t("TXT_CODE_AI_MOD_ASSISTANT_DESC")
            : t("TXT_CODE_AI_ASSISTANT_DESC")
        }}
      </a-typography-text>

      <a-alert
        v-if="!statusLoading && status && (!status.enabled || !status.configured)"
        class="mt-12"
        type="warning"
        show-icon
        :message="t('TXT_CODE_AI_NOT_READY')"
        :description="t('TXT_CODE_AI_NOT_READY_HINT')"
      />
      <a-alert
        v-else-if="status?.enabled && status?.configured"
        class="mt-12"
        type="info"
        show-icon
        :message="`${t('TXT_CODE_AI_MODEL')}: ${status.model}`"
      />
    </div>

    <div class="quick-row mb-12">
      <a-space wrap>
        <a-button
          v-for="prompt in quickPrompts"
          :key="prompt"
          size="small"
          :disabled="chatLoading"
          @click="sendMessage(prompt)"
        >
          {{ prompt }}
        </a-button>
      </a-space>
    </div>

    <div ref="listRef" class="chat-list">
      <div v-if="messages.length === 0" class="empty-tip">
        <AlertOutlined class="mb-8" />
        <div>
          {{
            scene === "mod_library"
              ? t("TXT_CODE_AI_MOD_EMPTY_HINT")
              : t("TXT_CODE_AI_EMPTY_HINT")
          }}
        </div>
      </div>

      <div
        v-for="(item, index) in messages"
        :key="`${item.role}-${index}`"
        class="chat-item"
        :class="`role-${item.role}`"
      >
        <div class="chat-bubble">
          <div v-if="item.role === 'assistant' && item.thinking" class="thinking-box mb-8">
            <div class="thinking-header" @click="toggleThinking(index)">
              <span>
                {{ t("TXT_CODE_AI_THINKING_LABEL") }}
                <LoadingOutlined v-if="item.streaming && !item.content" class="ml-4" />
              </span>
              <a-button type="link" size="small">
                {{ item.showThinking ? t("TXT_CODE_AI_THINKING_HIDE") : t("TXT_CODE_AI_THINKING_SHOW") }}
              </a-button>
            </div>
            <pre v-if="item.showThinking" class="thinking-content">{{ item.thinking }}</pre>
          </div>

          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-if="
              (item.role === 'assistant' || item.role === 'system') &&
              item.content &&
              (item.role === 'system' || extractDisplayText(item.content, item.streaming))
            "
            class="chat-content global-markdown-html ai-markdown"
            v-html="
              item.role === 'system'
                ? markdownToHTML(item.content)
                : renderMarkdown(item.content, item.streaming)
            "
          ></div>
          <div
            v-else-if="item.role === 'user' && item.content"
            class="chat-content"
          >
            {{ item.content }}
          </div>
          <div v-else-if="item.role === 'assistant' && item.streaming" class="chat-content">
            <span class="streaming-placeholder">
              <LoadingOutlined class="mr-4" />
              {{ t("TXT_CODE_AI_STREAMING") }}
            </span>
          </div>

          <div v-if="item.actions && item.actions.length > 0" class="action-list">
            <div
              v-for="(action, actionIndex) in item.actions"
              :key="`${action.type}-${action.command || ''}-${action.modQuery || ''}-${action.projectId || ''}-${action.target || ''}-${action.path || ''}-${action.fileName || ''}-${actionIndex}`"
              class="action-card"
            >
              <div class="action-title">{{ actionLabel(action) }}</div>
              <div class="action-reason">{{ action.reason }}</div>
              <div
                v-if="action.type === 'action_chain' && action.steps?.length"
                class="action-steps"
              >
                <div
                  v-for="(step, stepIndex) in action.steps"
                  :key="`${step.type}-${stepIndex}`"
                  class="action-step-item"
                >
                  {{ stepIndex + 1 }}. {{ actionLabel(step) }}
                </div>
              </div>
              <a-button
                type="primary"
                size="small"
                class="mt-8"
                :loading="
                  executeLoading &&
                  executingKey ===
                    `${index}-${action.type}-${action.command || ''}-${action.modQuery || ''}-${action.projectId || ''}-${action.versionId || ''}-${action.target || ''}-${action.path || ''}-${action.fileName || ''}-${action.title || ''}`
                "
                @click="confirmAction(action, index)"
              >
                <CheckOutlined />
                {{
                  action.type === "action_chain"
                    ? t("TXT_CODE_AI_CONFIRM_CHAIN")
                    : t("TXT_CODE_AI_CONFIRM_ACTION")
                }}
              </a-button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="composer">
      <div class="composer-tools mb-8">
        <a-space wrap>
          <a-checkbox v-if="!hideIncludeLog && scene !== 'mod_library'" v-model:checked="includeLog">
            {{ t("TXT_CODE_AI_INCLUDE_LOG") }}
          </a-checkbox>
          <a-select
            v-model:value="thinkingEffort"
            size="small"
            style="width: 140px"
            :options="thinkingOptions"
            :disabled="chatLoading"
          />
        </a-space>
        <a-space>
          <a-button v-if="chatLoading" type="link" size="small" danger @click="stopStreaming">
            {{ t("TXT_CODE_AI_STOP_STREAM") }}
          </a-button>
          <a-button type="link" size="small" @click="clearChat">
            {{ t("TXT_CODE_AI_CLEAR_CHAT") }}
          </a-button>
        </a-space>
      </div>
      <a-textarea
        v-model:value="inputText"
        :rows="3"
        :placeholder="t('TXT_CODE_AI_INPUT_PLACEHOLDER')"
        :disabled="chatLoading"
        @pressEnter="
          (e: KeyboardEvent) => {
            if (!e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }
        "
      />
      <div class="composer-actions mt-8">
        <a-button @click="drawerOpen = false">
          <CloseOutlined />
          {{ t("TXT_CODE_AI_CLOSE") }}
        </a-button>
        <a-button type="primary" :loading="chatLoading" :disabled="!canSend" @click="sendMessage()">
          <SendOutlined />
          {{ t("TXT_CODE_AI_SEND") }}
        </a-button>
      </div>
    </div>
  </a-drawer>
</template>

<style scoped lang="scss">
.ai-header {
  .ai-title-row {
    display: flex;
    align-items: center;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .ai-desc {
    display: block;
    font-size: 12px;
  }
}

.chat-list {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
  min-height: 240px;
}

.empty-tip {
  opacity: 0.7;
  text-align: center;
  padding: 32px 12px;
  font-size: 13px;
}

.chat-item {
  margin-bottom: 12px;
  display: flex;
}

.role-user {
  justify-content: flex-end;
  .chat-bubble {
    background: rgba(22, 119, 255, 0.12);
  }
}

.role-assistant {
  justify-content: flex-start;
  .chat-bubble {
    background: rgba(0, 0, 0, 0.04);
  }
}

.role-system {
  justify-content: center;
  .chat-bubble {
    background: rgba(250, 173, 20, 0.12);
    font-size: 12px;
  }
}

.chat-bubble {
  max-width: 94%;
  border-radius: 10px;
  padding: 10px 12px;
  word-break: break-word;
}

.chat-content {
  line-height: 1.55;
  font-size: 13px;
}

.role-user .chat-content,
.role-system .chat-content {
  white-space: pre-wrap;
}

.ai-markdown {
  :deep(p) {
    margin: 0 0 8px;
  }
  :deep(p:last-child) {
    margin-bottom: 0;
  }
  :deep(ul),
  :deep(ol) {
    margin: 0 0 8px;
    padding-left: 18px;
  }
  :deep(pre) {
    margin: 0 0 8px;
    overflow-x: auto;
    border-radius: 6px;
  }
  :deep(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 12px;
  }
  :deep(pre code) {
    white-space: pre;
  }
  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    margin: 0 0 8px;
    line-height: 1.35;
  }
  :deep(blockquote) {
    margin: 0 0 8px;
  }
  :deep(a) {
    word-break: break-all;
  }
}

.streaming-placeholder {
  opacity: 0.7;
  font-size: 12px;
}

.thinking-box {
  border: 1px dashed rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.02);
}

.thinking-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  opacity: 0.85;
  cursor: pointer;
}

.thinking-content {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.45;
  max-height: 180px;
  overflow: auto;
  opacity: 0.85;
}

.action-list {
  margin-top: 10px;
}

.action-steps {
  margin-top: 8px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.04);
  font-size: 12px;
  line-height: 1.5;
}
.action-step-item {
  opacity: 0.9;
}
.action-card {
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 8px;
  background: #fff;
}

.action-title {
  font-weight: 600;
  font-size: 13px;
}

.action-reason {
  margin-top: 4px;
  opacity: 0.75;
  font-size: 12px;
}

.composer {
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding-top: 12px;
  margin-top: 8px;
}

.composer-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
