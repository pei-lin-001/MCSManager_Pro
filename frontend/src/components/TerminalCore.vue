<script setup lang="ts">
import connectErrorImage from "@/assets/daemon_connection_error.png";
import {
  MC_QUICK_COMMAND_GROUPS,
  isMinecraftJavaType,
  loadCustomQuickCommands,
  saveCustomQuickCommands,
  type McCustomQuickCommand,
  type McQuickCommandItem
} from "@/config/mcQuickCommands";
import { useCommandHistory } from "@/hooks/useCommandHistory";
import { useXhrPollError } from "@/hooks/useXhrPollError";
import { t } from "@/lang/i18n";
import { getInstanceOutputLog } from "@/services/apis/instance";
import { useLayoutContainerStore } from "@/stores/useLayoutContainerStore";
import {
  CodeOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PlusOutlined,
  ThunderboltOutlined
} from "@ant-design/icons-vue";
import { Terminal } from "@xterm/xterm";
import { Modal, message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import { encodeConsoleColor, type UseTerminalHook } from "../hooks/useTerminal";
import { getRandomId } from "../tools/randId";

const props = defineProps<{
  instanceId: string;
  daemonId: string;
  height: string;
  useTerminalHook: UseTerminalHook;
}>();

const { containerState } = useLayoutContainerStore();

const {
  focusHistoryList,
  selectLocation,
  history,
  commandInputValue,
  handleHistorySelect,
  clickHistoryItem
} = useCommandHistory();

const {
  state,
  events,
  isConnect,
  isRunning,
  socketAddress,
  execute: setUpTerminal,
  reconnect,
  initTerminalWindow,
  sendCommand,
  clearTerminal
} = props.useTerminalHook;

const showQuickCommands = computed(() => {
  if (containerState.isDesignMode) return false;
  return isMinecraftJavaType(state.value?.config?.type);
});

const quickDisabled = computed(() => !isConnect.value || !isRunning.value);

// Primary groups always visible; gamerule group can be long → collapse extras.
const primaryGroupIds = new Set(["time", "weather", "difficulty", "gamemode", "world"]);
const expandedRules = ref(false);
const customOpen = ref(false);
const customList = ref<McCustomQuickCommand[]>(loadCustomQuickCommands());
const customLabel = ref("");
const customCommand = ref("");
const customConfirm = ref(false);
const sendingId = ref("");

const visibleGroups = computed(() => {
  return MC_QUICK_COMMAND_GROUPS.filter((g) => {
    if (g.id === "gamerule") return expandedRules.value;
    return primaryGroupIds.has(g.id);
  });
});

const labelOf = (item: McQuickCommandItem) => {
  const key = item.labelKey;
  const translated = t(key);
  return translated === key ? item.label : translated;
};

const groupLabel = (groupId: string, fallback: string, key: string) => {
  const translated = t(key);
  return translated === key ? fallback : translated;
};

const runCommand = async (item: { id: string; command: string; confirm?: boolean; label?: string }) => {
  if (quickDisabled.value) {
    message.warning(t("TXT_CODE_MC_QC_NEED_RUNNING"));
    return;
  }
  const cmd = String(item.command || "").trim().replace(/^\//, "");
  if (!cmd) return;

  const doSend = () => {
    try {
      sendingId.value = item.id;
      sendCommand(cmd);
      message.success(t("TXT_CODE_MC_QC_SENT", { cmd }));
    } catch (e: any) {
      message.error(e?.message || String(e));
    } finally {
      setTimeout(() => {
        if (sendingId.value === item.id) sendingId.value = "";
      }, 300);
    }
  };

  if (item.confirm) {
    Modal.confirm({
      title: t("TXT_CODE_MC_QC_CONFIRM_TITLE"),
      content: cmd,
      okText: t("TXT_CODE_MC_QC_CONFIRM_OK"),
      cancelText: t("TXT_CODE_MC_QC_CONFIRM_CANCEL"),
      okType: item.id.includes("kill") || item.id.includes("clear") ? "danger" : "primary",
      onOk: () => doSend()
    });
    return;
  }
  doSend();
};

const saveCustom = () => {
  const label = customLabel.value.trim().slice(0, 32);
  const command = customCommand.value.trim().replace(/^\//, "");
  if (!label || !command) {
    message.warning(t("TXT_CODE_MC_QC_CUSTOM_CMD"));
    return;
  }
  const next: McCustomQuickCommand = {
    id: `custom-${Date.now()}`,
    label,
    command,
    confirm: customConfirm.value
  };
  customList.value = [...customList.value, next].slice(0, 40);
  saveCustomQuickCommands(customList.value);
  customLabel.value = "";
  customCommand.value = "";
  customConfirm.value = false;
  customOpen.value = false;
  message.success(t("TXT_CODE_MC_QC_CUSTOM_SAVE"));
};

const removeCustom = (id: string) => {
  customList.value = customList.value.filter((x) => x.id !== id);
  saveCustomQuickCommands(customList.value);
};

const instanceId = props.instanceId;
const daemonId = props.daemonId;

const terminalDomId = `terminal-window-${getRandomId()}`;

const socketError = ref<Error>();
const { isXhrPollError, xhrPollErrorReason } = useXhrPollError(socketError);

let term: Terminal | undefined;

let inputRef = ref<HTMLElement | null>(null);

const handleSendCommand = () => {
  if (focusHistoryList.value) return;
  sendCommand(commandInputValue.value || "");
  commandInputValue.value = "";
};

const handleClickHistoryItem = (item: string) => {
  clickHistoryItem(item);
  inputRef.value?.focus();
};

const initTerminal = async () => {
  if (containerState.isDesignMode) return;
  const dom = document.getElementById(terminalDomId);
  if (dom) {
    const term = initTerminalWindow(dom);
    return term;
  }
  throw new Error(t("TXT_CODE_42bcfe0c"));
};

events.on("opened", () => {
  message.success(t("TXT_CODE_e13abbb1"));
});

events.on("stopped", () => {
  message.success(t("TXT_CODE_efb6d377"));
});

events.on("error", (error: Error) => {
  socketError.value = error;
});

// Only load a tail of history. Full InstanceLog can be hundreds of KB and
// writing it into xterm blocks the UI for seconds after connect.
const TERMINAL_HISTORY_SIZE = "64KB";

events.once("detail", async () => {
  try {
    const { value } = await getInstanceOutputLog().execute({
      params: {
        uuid: instanceId || "",
        daemonId: daemonId || "",
        size: TERMINAL_HISTORY_SIZE
      }
    });

    if (value) {
      if (state.value?.config?.terminalOption?.haveColor) {
        term?.write(encodeConsoleColor(value));
      } else {
        term?.write(value);
      }
    }
  } catch (error: any) {}
});

const refreshPage = async () => {
  try {
    socketError.value = undefined;
    if (reconnect) {
      await reconnect();
      return;
    }
  } catch (error: any) {
    console.error(error);
  }
  window.location.reload();
};

// Initialize the terminal when the component is mounted.
// Do not reinitialize it in the parent component.
onMounted(async () => {
  try {
    // Start stream channel + xterm in parallel. Previously xterm waited for the
    // channel request even though they are independent; that added open latency.
    const setupTask =
      instanceId && daemonId
        ? setUpTerminal({
            instanceId,
            daemonId
          })
        : Promise.resolve();
    const [_, termInst] = await Promise.all([setupTask, initTerminal()]);
    term = termInst as any;
  } catch (error: any) {
    console.error(error);
    throw error;
  }
});
</script>

<template>
  <!-- Terminal Page View -->
  <div class="console-wrapper">
    <div v-if="!isConnect" class="terminal-loading">
      <LoadingOutlined style="font-size: 72px; color: white" />
    </div>
    <div class="terminal-button-group position-absolute-right position-absolute-top">
      <ul>
        <li @click="clearTerminal()">
          <a-tooltip placement="top">
            <template #title>
              <span>{{ t("TXT_CODE_b1e2e1b4") }}</span>
            </template>
            <delete-outlined />
          </a-tooltip>
        </li>
      </ul>
    </div>
    <div class="terminal-wrapper global-card-container-shadow position-relative">
      <div class="terminal-container">
        <div
          v-if="!containerState.isDesignMode"
          :id="terminalDomId"
          :style="{ height: props.height }"
        ></div>
        <div v-else :style="{ height: props.height }">
          <p class="terminal-design-tip">{{ $t("TXT_CODE_7ac6f85c") }}</p>
        </div>
      </div>
    </div>
    <div class="command-input">
      <div v-show="focusHistoryList" class="history">
        <li v-for="(item, key) in history" :key="item">
          <a-tag
            :color="key !== selectLocation ? 'blue' : '#108ee9'"
            @click="handleClickHistoryItem(item)"
          >
            {{ item.length > 14 ? item.slice(0, 14) + "..." : item }}
          </a-tag>
        </li>
      </div>
      <a-input
        ref="inputRef"
        v-model:value="commandInputValue"
        :placeholder="t('TXT_CODE_555e2c1b')"
        autofocus
        :disabled="containerState.isDesignMode || !isConnect"
        @press-enter="handleSendCommand"
        @keydown="handleHistorySelect"
      >
        <template #prefix>
          <CodeOutlined style="font-size: 18px" />
        </template>
      </a-input>
    </div>

    <!-- Minecraft quick console actions: below command line, above performance card -->
    <div v-if="showQuickCommands" class="mc-quick-commands">
      <div class="mc-qc-header">
        <div class="mc-qc-title">
          <ThunderboltOutlined />
          <span>{{ t("TXT_CODE_MC_QC_TITLE") }}</span>
          <a-typography-text type="secondary" class="mc-qc-hint">
            {{ t("TXT_CODE_MC_QC_HINT") }}
          </a-typography-text>
        </div>
        <div class="mc-qc-actions">
          <a-button size="small" type="link" @click="expandedRules = !expandedRules">
            {{ expandedRules ? t("TXT_CODE_MC_QC_COLLAPSE") : t("TXT_CODE_MC_QC_EXPAND") }}
          </a-button>
          <a-button size="small" type="link" @click="customOpen = !customOpen">
            <PlusOutlined />
            {{ t("TXT_CODE_MC_QC_CUSTOM") }}
          </a-button>
        </div>
      </div>

      <div v-if="customOpen" class="mc-qc-custom-form">
        <a-input
          v-model:value="customLabel"
          size="small"
          :placeholder="t('TXT_CODE_MC_QC_CUSTOM_LABEL')"
          style="max-width: 140px"
        />
        <a-input
          v-model:value="customCommand"
          size="small"
          :placeholder="t('TXT_CODE_MC_QC_CUSTOM_CMD')"
          style="flex: 1; min-width: 180px"
        />
        <a-checkbox v-model:checked="customConfirm">
          {{ t("TXT_CODE_MC_QC_CUSTOM_CONFIRM") }}
        </a-checkbox>
        <a-button size="small" type="primary" @click="saveCustom">
          {{ t("TXT_CODE_MC_QC_CUSTOM_SAVE") }}
        </a-button>
      </div>

      <div
        v-for="group in visibleGroups"
        :key="group.id"
        class="mc-qc-group"
      >
        <div class="mc-qc-group-label">
          {{ groupLabel(group.id, group.label, group.labelKey) }}
        </div>
        <div class="mc-qc-btns">
          <a-tooltip
            v-for="item in group.items"
            :key="item.id"
            :title="item.tip || item.command"
          >
            <a-button
              size="small"
              :danger="!!item.danger"
              :disabled="quickDisabled"
              :loading="sendingId === item.id"
              @click="runCommand(item)"
            >
              {{ labelOf(item) }}
            </a-button>
          </a-tooltip>
        </div>
      </div>

      <div v-if="customList.length" class="mc-qc-group">
        <div class="mc-qc-group-label">{{ t("TXT_CODE_MC_QC_CUSTOM") }}</div>
        <div class="mc-qc-btns">
          <span v-for="item in customList" :key="item.id" class="mc-qc-custom-item">
            <a-tooltip :title="item.command">
              <a-button
                size="small"
                :disabled="quickDisabled"
                :loading="sendingId === item.id"
                @click="runCommand(item)"
              >
                {{ item.label }}
              </a-button>
            </a-tooltip>
            <a-button
              size="small"
              type="text"
              danger
              :title="t('TXT_CODE_MC_QC_CUSTOM_DELETE')"
              @click="removeCustom(item.id)"
            >
              ×
            </a-button>
          </span>
        </div>
      </div>
    </div>

    <!-- Error Dialog -->
    <div v-if="socketError" class="error-card">
      <div class="error-card-container">
        <a-typography-title :level="5">{{ $t("TXT_CODE_6929b0b2") }}</a-typography-title>
        <a-typography-paragraph>
          {{ $t("TXT_CODE_812a629e") + socketAddress }}
        </a-typography-paragraph>
        <div>
          <img :src="connectErrorImage" style="width: 100%; height: 110px" />
        </div>
        <a-typography-title :level="5">{{ $t("TXT_CODE_9c95b60f") }}</a-typography-title>
        <a-typography-paragraph>
          <pre style="font-size: 12px"><code>{{ socketError?.message||"" }}</code></pre>

          <div v-if="isXhrPollError" style="font-size: 12px">
            <span> {{ xhrPollErrorReason }}</span>
          </div>
        </a-typography-paragraph>
        <a-typography-paragraph v-if="isXhrPollError">
          <div class="flex" style="gap: 8px; font-size: 12px">
            <span>
              <strong>{{ $t("TXT_CODE_d4c8fb3b") }}</strong>
            </span>
            <a
              href="https://docs.mcsmanager.com/ops/proxy_https.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ $t("TXT_CODE_9b3ce825") }}
            </a>
            <span>|</span>
            <a
              href="https://docs.mcsmanager.com/ops/mcsm_network.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ $t("TXT_CODE_10cc2794") }}
            </a>
          </div>
        </a-typography-paragraph>
        <a-typography-title :level="5">{{ $t("TXT_CODE_f1c96d8a") }}</a-typography-title>
        <a-typography-paragraph>
          <ul>
            <li>
              {{ $t("TXT_CODE_ceba9262") }}
            </li>
            <li>
              {{ $t("TXT_CODE_84099e5") }}
            </li>
            <li>
              {{ $t("TXT_CODE_86ff658a") }}
            </li>
          </ul>
          <div class="flex flex-center">
            <a-typography-link @click="refreshPage">
              {{ $t("TXT_CODE_f8b28901") }}
            </a-typography-link>
          </div>
        </a-typography-paragraph>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.error-card {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: 0;
  z-index: 10;
  border-radius: 20px;

  display: flex;
  align-items: center;
  justify-content: center;

  .error-card-container {
    overflow: hidden;
    max-width: 440px;
    border: 1px solid var(--color-gray-6) !important;
    background-color: var(--color-gray-1);
    border-radius: 4px;
    padding: 12px;
    box-shadow: 0px 0px 2px var(--color-gray-7);
  }

  @media (max-width: 992px) {
    .error-card-container {
      max-width: 90vw !important;
    }
  }
}
.console-wrapper {
  position: relative;

  .terminal-loading {
    z-index: 12;
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .terminal-button-group {
    z-index: 11;
    margin-right: 20px;
    padding-bottom: 50px;
    padding-left: 50px;
    border-radius: 6px;
    color: #fff;

    &:hover {
      ul {
        transition: all 1s;
        opacity: 0.8;
      }
    }

    ul {
      display: flex;
      opacity: 0;

      li {
        cursor: pointer;
        list-style: none;
        padding: 5px;
        margin-left: 5px;
        border-radius: 6px;
        font-size: 20px;

        &:hover {
          background-color: #3e3e3e;
        }
      }
    }
  }

  .terminal-wrapper {
    border: 1px solid var(--card-border-color);
    position: relative;
    overflow: hidden;
    height: 100%;
    background-color: #1e1e1e;
    padding: 8px;
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    .terminal-container {
      // min-width: 1200px;
      height: 100%;
    }

    margin-bottom: 12px;
  }

  .command-input {
    position: relative;

    .history {
      display: flex;
      max-width: 100%;
      overflow: scroll;
      z-index: 10;
      position: absolute;
      top: -35px;
      left: 0;

      li {
        list-style: none;
        span {
          padding: 3px 20px;
          max-width: 300px;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: pointer;
        }
      }

      &::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
      }
    }
  }

  .terminal-design-tip {
    color: rgba(255, 255, 255, 0.584);
  }

  .mc-quick-commands {
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px solid var(--card-border-color);
    border-radius: 8px;
    background: var(--card-color, var(--color-gray-1, #fafafa));
  }

  .mc-qc-custom-item {
    display: inline-flex;
    align-items: center;
    gap: 0;
  }

  .mc-qc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .mc-qc-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 13px;
  }

  .mc-qc-hint {
    font-weight: 400;
    font-size: 12px;
  }

  .mc-qc-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .mc-qc-custom-form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
    padding: 8px;
    border-radius: 6px;
    background: var(--color-gray-2, #f5f5f5);
  }

  .mc-qc-group {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 6px;
  }

  .mc-qc-group-label {
    min-width: 88px;
    padding-top: 4px;
    font-size: 12px;
    color: var(--color-gray-8, #595959);
    flex-shrink: 0;
  }

  .mc-qc-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
}
</style>
