<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { openMarketDialog, openRenewalDialog } from "@/components/fc";
import IconBtn from "@/components/IconBtn.vue";
import TerminalCore from "@/components/TerminalCore.vue";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { INSTANCE_TYPE_TRANSLATION, verifyEULA } from "@/hooks/useInstance";
import { useScreen } from "@/hooks/useScreen";
import { t } from "@/lang/i18n";
import {
  getConfigFile,
  killInstance,
  openInstance,
  restartInstance,
  stopInstance,
  updateInstance
} from "@/services/apis/instance";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { sleep } from "@/tools/common";
import { toCopy } from "@/tools/copy";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import { INSTANCE_CRASH_TIMEOUT, INSTANCE_STATUS } from "@/types/const";
import {
  CheckCircleOutlined,
  CloseOutlined,
  CloudDownloadOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DownOutlined,
  InfoCircleOutlined,
  InteractionOutlined,
  LaptopOutlined,
  LoadingOutlined,
  LinkOutlined,
  MoneyCollectOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  RobotOutlined
} from "@ant-design/icons-vue";
import { Modal } from "ant-design-vue";
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import { GLOBAL_INSTANCE_NAME } from "../../config/const";
import { useTerminal, type UseTerminalHook } from "../../hooks/useTerminal";
import { arrayFilter } from "../../tools/array";
import AiAssistantDrawer from "./dialogs/AiAssistantDrawer.vue";

const props = defineProps<{
  card: LayoutCard;
}>();

const { isPhone } = useScreen();
const { state, isAdmin } = useAppStateStore();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);

// The `useTerminal` is shared by this component and `TerminalCore`.
// Please do not initialize `useTerminal` in this component; all initialization logic should be placed in its child component `TerminalCore.vue`.
// The state of the shared terminal is used here.
const terminalHook: UseTerminalHook = useTerminal();
const {
  state: instanceInfo,
  isStopped,
  isRunning,
  isBuys,
  isConnect,
  isGlobalTerminal,
  isDockerMode,
  clearTerminal
} = terminalHook;

const instanceId = getMetaOrRouteValue("instanceId");
const daemonId = getMetaOrRouteValue("daemonId");
const aiDrawerOpen = ref(false);
const serverPort = ref<number | null>(null);
const viewType = getMetaOrRouteValue("viewType", false);
const innerTerminalType = computed(() => props.card.width === 12 && viewType === "inner");
const instanceTypeText = computed(
  () => INSTANCE_TYPE_TRANSLATION[instanceInfo.value?.config.type ?? -1]
);

const { execute: requestOpenInstance, isLoading: isOpenInstanceLoading } = openInstance();

let checkRunningTimer: NodeJS.Timeout;
const toOpenInstance = async () => {
  if (checkRunningTimer) clearTimeout(checkRunningTimer);
  clearTerminal();
  try {
    if (instanceInfo.value?.config?.type?.startsWith("minecraft/java")) {
      const flag = await verifyEULA(instanceId ?? "", daemonId ?? "");
      if (!flag) return;
      await sleep(1000);
    }

    await requestOpenInstance({
      params: {
        uuid: instanceId ?? "",
        daemonId: daemonId ?? ""
      }
    });

    checkRunningTimer = setTimeout(() => {
      if (terminalHook.isStopped.value) {
        Modal.error({
          title: t("TXT_CODE_ac405b50"),
          content: h("div", [
            h("p", t("TXT_CODE_3409258a")),
            h("p", `${t("TXT_CODE_973414e1")}：${instanceInfo.value?.config.startCommand || ""}`),
            isDockerMode.value &&
              h("p", `${t("TXT_CODE_44b585c7")}：${instanceInfo.value?.config.docker.image || ""}`)
          ])
        });
      }
    }, INSTANCE_CRASH_TIMEOUT);
  } catch (error: any) {
    reportErrorMsg(error);
  }
};

const updateCmd = computed(() => (instanceInfo.value?.config.updateCommand ? true : false));
const instanceStatusText = computed(() => {
  const status = instanceInfo.value?.status;
  if (status === undefined || status === null) {
    return isConnect.value ? t("TXT_CODE_AI_TERMINAL_SYNCING") : t("TXT_CODE_AI_TERMINAL_CONNECTING");
  }
  return INSTANCE_STATUS[status] || String(status);
});
const quickOperations = computed(() =>
  arrayFilter([
    {
      title: t("TXT_CODE_57245e94"),
      icon: PlayCircleOutlined,
      noConfirm: false,
      type: "default",
      class: "button-color-success",
      click: toOpenInstance,
      props: {},
      condition: () => isStopped.value
    },
    {
      title: t("TXT_CODE_b1dedda3"),
      icon: PauseCircleOutlined,
      type: "default",
      click: async () => {
        try {
          await stopInstance().execute({
            params: {
              uuid: instanceId || "",
              daemonId: daemonId || ""
            }
          });
        } catch (error: any) {
          reportErrorMsg(error);
        }
      },
      props: {
        danger: true
      },
      condition: () => isRunning.value
    }
  ])
);
const instanceOperations = computed(() =>
  arrayFilter([
    {
      title: t("TXT_CODE_47dcfa5"),
      icon: RedoOutlined,
      type: "default",
      noConfirm: false,
      click: async () => {
        try {
          await restartInstance().execute({
            params: {
              uuid: instanceId || "",
              daemonId: daemonId || ""
            }
          });
        } catch (error: any) {
          reportErrorMsg(error);
        }
      },
      condition: () => isRunning.value
    },
    {
      title: t("TXT_CODE_7b67813a"),
      icon: CloseOutlined,
      type: "danger",
      class: "color-warning",
      click: async () => {
        try {
          await killInstance().execute({
            params: {
              uuid: instanceId || "",
              daemonId: daemonId || ""
            }
          });
        } catch (error: any) {
          reportErrorMsg(error);
        }
      },
      condition: () => !isStopped.value
    },
    {
      title: t("TXT_CODE_40ca4f2"),
      type: "default",
      icon: CloudDownloadOutlined,
      click: async () => {
        try {
          clearTerminal();
          await updateInstance().execute({
            params: {
              uuid: instanceId || "",
              daemonId: daemonId || "",
              task_name: "update"
            },
            data: {
              time: new Date().getTime()
            }
          });
        } catch (error: any) {
          reportErrorMsg(error);
        }
      },
      condition: () => isStopped.value && updateCmd.value
    },
    {
      title: t("TXT_CODE_b19ed1dd"),
      icon: InteractionOutlined,
      noConfirm: true,
      click: async () => {
        try {
          clearTerminal();
          await openMarketDialog(daemonId ?? "", instanceId ?? "", {
            autoInstall: true,
            onlyDockerTemplate: isDockerMode.value
          });
        } catch (error: any) {
          // ignore
        }
      },
      props: {},
      condition: () =>
        isStopped.value &&
        (state.settings.allowUsePreset || isAdmin.value) &&
        !isGlobalTerminal.value
    },
    {
      title: t("TXT_CODE_f77093c8"),
      icon: MoneyCollectOutlined,
      noConfirm: true,
      click: async () => {
        await openRenewalDialog(
          instanceInfo.value?.instanceUuid ?? "",
          daemonId ?? "",
          instanceInfo.value?.config.category ?? 0
        );
      },
      props: {},
      condition: () => !!instanceInfo.value?.config?.category
    }
  ])
);

const getInstanceName = computed(() => {
  if (instanceInfo.value?.config.nickname === GLOBAL_INSTANCE_NAME) {
    return t("TXT_CODE_5bdaf23d");
  } else {
    return instanceInfo.value?.config.nickname;
  }
});

const openAiAssistant = () => {
  if (!instanceId || !daemonId) return;
  aiDrawerOpen.value = true;
};

const connectHost = computed(() => {
  // Prefer the host the operator is currently using in the browser.
  // This works for both domain reverse-proxy and raw IP access.
  const host = window.location.hostname;
  return host || "127.0.0.1";
});

const parsePort = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null;
  return Math.floor(n);
};

const loadServerPort = async () => {
  if (!instanceId || !daemonId) return;
  const type = String(instanceInfo.value?.config?.type || "");
  const isMc =
    type.includes("minecraft/java") ||
    type.includes("minecraft/bedrock") ||
    type.includes("universal/mcdr");
  if (!isMc) {
    serverPort.value = null;
    return;
  }
  try {
    const res = await getConfigFile().execute({
      params: {
        uuid: instanceId,
        daemonId: daemonId,
        fileName: "server.properties",
        type: "properties"
      }
    });
    const data = res.value as Record<string, unknown> | null;
    const port =
      parsePort(data?.["server-port"]) ||
      parsePort(data?.["server-portv6"]) ||
      parsePort(data?.["query.port"]);
    serverPort.value = port;
  } catch {
    serverPort.value = null;
  }
};

const connectLinks = computed(() => {
  const links: Array<{ label: string; value: string }> = [];
  const host = connectHost.value;
  const ports = instanceInfo.value?.info?.allocatedPorts || [];

  // Docker mapped ports are the most accurate public endpoints.
  if (ports.length > 0) {
    for (const item of ports) {
      const hostPort = String(item.host || "").split(":")[0] || String(item.host || "");
      const port = parsePort(hostPort.includes("->") ? hostPort.split("->").pop() : hostPort);
      // allocatedPorts.host may already be "0.0.0.0:25565" style or plain port.
      let finalHost = host;
      let finalPort = port;
      const hostText = String(item.host || "");
      if (hostText.includes(":")) {
        const parts = hostText.split(":");
        const maybePort = parsePort(parts[parts.length - 1]);
        if (maybePort) finalPort = maybePort;
        const maybeHost = parts.slice(0, -1).join(":");
        if (maybeHost && maybeHost !== "0.0.0.0" && maybeHost !== "::" && maybeHost !== "[::]") {
          finalHost = maybeHost.replace(/^\[|\]$/g, "");
        }
      } else if (parsePort(hostText)) {
        finalPort = parsePort(hostText);
      }
      if (!finalPort) continue;
      const protocol = String(item.protocol || "tcp").toUpperCase();
      links.push({
        label: protocol,
        value: `${finalHost}:${finalPort}`
      });
    }
  }

  // Non-docker: use server.properties / pingConfig / basePort fallbacks.
  if (links.length === 0) {
    const port =
      serverPort.value ||
      parsePort(instanceInfo.value?.config?.pingConfig?.port) ||
      parsePort(instanceInfo.value?.config?.basePort);
    if (port) {
      links.push({
        label: t("TXT_CODE_INST_CONNECT_PRIMARY"),
        value: `${host}:${port}`
      });
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return links.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
});

const copyConnectLink = async (value: string) => {
  await toCopy(value);
};

watch(
  () => [instanceId, daemonId, instanceInfo.value?.config?.type, instanceInfo.value?.status],
  () => {
    void loadServerPort();
  },
  { immediate: true }
);

onMounted(() => {
  void loadServerPort();
});

onUnmounted(() => {
  if (checkRunningTimer) clearTimeout(checkRunningTimer);
});
</script>

<template>
  <!-- Terminal Page View -->
  <div v-if="innerTerminalType">
    <div class="mb-24">
      <BetweenMenus>
        <template #left>
          <div class="align-center">
            <a-typography-title class="mb-0 mr-12" :level="4">
              <CloudServerOutlined />
              <span class="ml-6"> {{ getInstanceName }} </span>
            </a-typography-title>
            <a-typography-paragraph v-if="!isPhone" class="mb-0 ml-4">
              <span class="ml-6">
                <a-tag v-if="isRunning" color="green">
                  <CheckCircleOutlined />
                  {{ instanceStatusText }}
                </a-tag>
                <a-tag v-else-if="isBuys" color="red">
                  <LoadingOutlined />
                  {{ instanceStatusText }}
                </a-tag>
                <a-tag v-else-if="!instanceInfo" color="blue">
                  <LoadingOutlined />
                  {{ instanceStatusText }}
                </a-tag>
                <a-tag v-else-if="instanceStatusText">
                  <InfoCircleOutlined />
                  {{ instanceStatusText }}
                </a-tag>
              </span>

              <a-tag v-if="instanceTypeText" color="purple"> {{ instanceTypeText }} </a-tag>

              <span
                v-if="instanceInfo?.watcher && instanceInfo?.watcher > 1 && !isPhone"
                class="ml-16"
              >
                <a-tooltip>
                  <template #title>
                    {{ t("TXT_CODE_4a37ec9c") }}
                  </template>
                  <LaptopOutlined />
                </a-tooltip>
                <span class="ml-6" style="opacity: 0.8">
                  {{ instanceInfo?.watcher }}
                </span>
              </span>
            </a-typography-paragraph>
          </div>
        </template>
        <template #right>
          <div v-if="!isPhone">
            <template v-for="item in [...quickOperations, ...instanceOperations]" :key="item.title">
              <a-button
                v-if="item.noConfirm"
                class="ml-8"
                :class="item.class ? item.class : ''"
                :danger="item.type === 'danger'"
                :disabled="isOpenInstanceLoading"
                @click="item.click"
              >
                <component :is="item.icon" />
                {{ item.title }}
              </a-button>
              <a-popconfirm
                v-else
                :key="item.title"
                :title="t('TXT_CODE_276756b2')"
                @confirm="item.click"
              >
                <a-button
                  class="ml-8"
                  :danger="item.type === 'danger'"
                  :class="item.class ? item.class : ''"
                >
                  <component :is="item.icon" />
                  {{ item.title }}
                </a-button>
              </a-popconfirm>
            </template>
            <a-button class="ml-8" type="primary" ghost @click="openAiAssistant">
              <RobotOutlined />
              {{ t("TXT_CODE_AI_ASSISTANT_TITLE") }}
            </a-button>
          </div>

          <a-dropdown v-else>
            <template #overlay>
              <a-menu>
                <a-menu-item
                  v-for="item in [...quickOperations, ...instanceOperations]"
                  :key="item.title"
                  @click="item.click"
                >
                  <component :is="item.icon" />
                  {{ item.title }}
                </a-menu-item>
                <a-menu-item key="ai-assistant" @click="openAiAssistant">
                  <RobotOutlined />
                  {{ t("TXT_CODE_AI_ASSISTANT_TITLE") }}
                </a-menu-item>
              </a-menu>
            </template>
            <a-button type="primary">
              {{ t("TXT_CODE_fe731dfc") }}
              <DownOutlined />
            </a-button>
          </a-dropdown>
        </template>
      </BetweenMenus>
    </div>
    <div class="mb-10 connect-row">
      <div v-if="connectLinks.length" class="connect-link-bar">
        <span class="connect-link-label">
          <LinkOutlined />
          {{ t("TXT_CODE_INST_CONNECT_LINK") }}
        </span>
        <a-tag
          v-for="item in connectLinks"
          :key="item.value"
          class="connect-link-tag"
          color="processing"
          @click="copyConnectLink(item.value)"
        >
          <span class="connect-link-text">{{ item.value }}</span>
          <CopyOutlined class="ml-4" />
        </a-tag>
      </div>
    </div>
    <TerminalCore
      v-if="instanceId && daemonId"
      :use-terminal-hook="terminalHook"
      :instance-id="instanceId"
      :daemon-id="daemonId"
      :height="card.height"
    />
  </div>

  <!-- Other Page View -->
  <CardPanel v-else class="containerWrapper" style="height: 100%">
    <template #title>
      <CloudServerOutlined />
      <span class="ml-8"> {{ getInstanceName }} </span>
      <span class="ml-8">
        <a-tag v-if="isRunning" color="green">
          <CheckCircleOutlined />
          {{ instanceStatusText }}
        </a-tag>
        <a-tag v-else-if="isBuys" color="red">
          <LoadingOutlined />
          {{ instanceStatusText }}
        </a-tag>
        <a-tag v-else-if="!instanceInfo" color="blue">
          <LoadingOutlined />
          {{ instanceStatusText }}
        </a-tag>
        <a-tag v-else>
          <InfoCircleOutlined />
          {{ instanceStatusText }}
        </a-tag>
        <a-tag color="purple"> {{ instanceTypeText }} </a-tag>
      </span>
    </template>
    <template #operator>
      <span
        v-for="item in quickOperations"
        :key="item.title"
        size="default"
        class="mr-2"
        v-bind="item.props"
      >
        <IconBtn :icon="item.icon" :title="item.title" @click="item.click"></IconBtn>
      </span>
      <span class="mr-2">
        <IconBtn
          :icon="RobotOutlined"
          :title="t('TXT_CODE_AI_ASSISTANT_TITLE')"
          @click="openAiAssistant"
        />
      </span>
      <a-dropdown>
        <template #overlay>
          <a-menu>
            <a-menu-item v-for="item in instanceOperations" :key="item.title" @click="item.click">
              <component :is="item.icon"></component>
              <span>&nbsp;{{ item.title }}</span>
            </a-menu-item>
          </a-menu>
        </template>
        <span size="default" type="primary">
          <IconBtn :icon="DownOutlined" :title="t('TXT_CODE_fe731dfc')"></IconBtn>
        </span>
      </a-dropdown>
    </template>
    <template #body>
      <div class="mb-6 connect-row">
        <div v-if="connectLinks.length" class="connect-link-bar">
          <span class="connect-link-label">
            <LinkOutlined />
            {{ t("TXT_CODE_INST_CONNECT_LINK") }}
          </span>
          <a-tag
            v-for="item in connectLinks"
            :key="item.value"
            class="connect-link-tag"
            color="processing"
            @click="copyConnectLink(item.value)"
          >
            <span class="connect-link-text">{{ item.value }}</span>
            <CopyOutlined class="ml-4" />
          </a-tag>
        </div>
      </div>
      <TerminalCore
        v-if="instanceId && daemonId"
        :use-terminal-hook="terminalHook"
        :instance-id="instanceId"
        :daemon-id="daemonId"
        :height="card.height"
      />
    </template>
  </CardPanel>

  <AiAssistantDrawer
    v-if="instanceId && daemonId"
    v-model:open="aiDrawerOpen"
    :instance-id="instanceId"
    :daemon-id="daemonId"
    :instance-name="getInstanceName"
  />
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
}

.connect-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.connect-link-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.connect-link-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.85;
}

.connect-link-tag {
  cursor: pointer;
  user-select: none;
  margin-inline-end: 0 !important;
}

.connect-link-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
  font-weight: 600;
}
</style>
