<script setup lang="ts">
import { t } from "@/lang/i18n";
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { LayoutCard } from "@/types";
import { userInfoApi } from "@/services/apis/index";
import { useRouter } from "vue-router";
import { INSTANCE_STATUS, INSTANCE_STATUS_CODE } from "@/types/const";
import { parseTimestamp } from "../tools/time";
import {
  openInstance,
  restartInstance,
  stopInstance,
  killInstance
} from "@/services/apis/instance";
import { verifyEULA } from "@/hooks/useInstance";
import { reportErrorMsg } from "@/tools/validator";
import { message, Modal } from "ant-design-vue";
import {
  CodeOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  RedoOutlined,
  ReloadOutlined,
  StopOutlined
} from "@ant-design/icons-vue";
import type { UserInstance } from "@/types/user";

defineProps<{
  card: LayoutCard;
}>();

const router = useRouter();
const { execute, state, isLoading } = userInfoApi();
const busyMap = ref<Record<string, string>>({});
let timer: number | undefined;

const instances = computed(() => (state.value?.instances || []) as UserInstance[]);

const statusColor = (status?: number) => {
  if (status === INSTANCE_STATUS_CODE.RUNNING) return "success";
  if (status === INSTANCE_STATUS_CODE.STOPPED) return "default";
  if (status === INSTANCE_STATUS_CODE.BUSY) return "processing";
  return "error";
};

const statusText = (status?: number) =>
  INSTANCE_STATUS[(status as INSTANCE_STATUS_CODE) ?? INSTANCE_STATUS_CODE.STOPPED] || String(status);

const refresh = async () => {
  await execute({
    params: { advanced: true },
    forceRequest: true
  });
};

const keyOf = (row: UserInstance) => `${row.daemonId}:${row.instanceUuid}`;

const setBusy = (row: UserInstance, act?: string) => {
  const k = keyOf(row);
  if (!act) {
    const next = { ...busyMap.value };
    delete next[k];
    busyMap.value = next;
  } else {
    busyMap.value = { ...busyMap.value, [k]: act };
  }
};

const isBusy = (row: UserInstance, act?: string) => {
  const v = busyMap.value[keyOf(row)];
  return act ? v === act : Boolean(v);
};

const toConsole = (row: UserInstance) => {
  router.push({
    path: "/instances/terminal",
    query: {
      daemonId: row.daemonId,
      instanceId: row.instanceUuid
    }
  });
};

const runAction = async (
  row: UserInstance,
  act: "start" | "stop" | "restart" | "kill"
) => {
  const params = { uuid: row.instanceUuid, daemonId: row.daemonId };
  setBusy(row, act);
  try {
    if (act === "start") {
      const ok = await verifyEULA(row.instanceUuid, row.daemonId);
      if (!ok) return;
      await openInstance().execute({ params });
      message.success(t("TXT_CODE_e13abbb1"));
    } else if (act === "stop") {
      await stopInstance().execute({ params });
      message.success(t("TXT_CODE_efb6d377"));
    } else if (act === "restart") {
      await restartInstance().execute({ params });
      message.success(t("TXT_CODE_efb6d377"));
    } else {
      await killInstance().execute({ params });
      message.success(t("TXT_CODE_efb6d377"));
    }
    setTimeout(refresh, 800);
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    setBusy(row);
  }
};

const confirmKill = (row: UserInstance) => {
  Modal.confirm({
    title: t("TXT_CODE_USER_KILL_TITLE"),
    content: row.nickname || row.instanceUuid,
    okType: "danger",
    onOk: () => runAction(row, "kill")
  });
};

onMounted(async () => {
  await refresh();
  timer = window.setInterval(refresh, 15000);
});

onUnmounted(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <CardPanel class="UserInstanceList" style="height: 100%">
    <template #title>{{ card.title || t("TXT_CODE_d655beec") }}</template>
    <template #operator>
      <a-button size="small" type="link" :loading="isLoading" @click="refresh">
        <ReloadOutlined />
      </a-button>
    </template>
    <template #body>
      <a-spin :spinning="isLoading && !instances.length">
        <a-empty v-if="!instances.length" :description="t('TXT_CODE_USER_NO_INSTANCE')" />
        <div v-else class="grid">
          <div v-for="row in instances" :key="keyOf(row)" class="card">
            <div class="head">
              <div class="name" :title="row.nickname">{{ row.nickname || row.instanceUuid }}</div>
              <a-tag :color="statusColor(row.status)">{{ statusText(row.status) }}</a-tag>
            </div>
            <div class="meta">
              <div>
                <span class="label">{{ t("TXT_CODE_5ab2062d") }}</span>
                {{ parseTimestamp((row as any).lastDatetime) || "-" }}
              </div>
              <div>
                <span class="label">{{ t("TXT_CODE_fa920c0") }}</span>
                {{ parseTimestamp((row as any).endTime) || t("TXT_CODE_abc080d") }}
              </div>
              <div class="mono">
                <span class="label">UUID</span>
                {{ row.instanceUuid }}
              </div>
            </div>
            <div class="ops">
              <a-button
                type="primary"
                size="small"
                :loading="isBusy(row, 'start')"
                :disabled="
                  row.status === INSTANCE_STATUS_CODE.RUNNING ||
                  row.status === INSTANCE_STATUS_CODE.BUSY ||
                  isBusy(row)
                "
                @click="runAction(row, 'start')"
              >
                <PlayCircleOutlined />
                {{ t("TXT_CODE_USER_START") }}
              </a-button>
              <a-button
                size="small"
                :loading="isBusy(row, 'stop')"
                :disabled="
                  row.status === INSTANCE_STATUS_CODE.STOPPED ||
                  row.status === INSTANCE_STATUS_CODE.BUSY ||
                  isBusy(row)
                "
                @click="runAction(row, 'stop')"
              >
                <PoweroffOutlined />
                {{ t("TXT_CODE_USER_STOP") }}
              </a-button>
              <a-button
                size="small"
                :loading="isBusy(row, 'restart')"
                :disabled="
                  row.status === INSTANCE_STATUS_CODE.STOPPED ||
                  row.status === INSTANCE_STATUS_CODE.BUSY ||
                  isBusy(row)
                "
                @click="runAction(row, 'restart')"
              >
                <RedoOutlined />
                {{ t("TXT_CODE_USER_RESTART") }}
              </a-button>
              <a-button
                size="small"
                danger
                :loading="isBusy(row, 'kill')"
                :disabled="row.status === INSTANCE_STATUS_CODE.STOPPED || isBusy(row)"
                @click="confirmKill(row)"
              >
                <StopOutlined />
                {{ t("TXT_CODE_USER_KILL") }}
              </a-button>
              <a-button
                size="small"
                type="primary"
                ghost
                :disabled="row.status === INSTANCE_STATUS_CODE.BUSY"
                @click="toConsole(row)"
              >
                <CodeOutlined />
                {{ t("TXT_CODE_USER_CONSOLE") }}
              </a-button>
            </div>
          </div>
        </div>
      </a-spin>
    </template>
  </CardPanel>
</template>

<style scoped lang="scss">
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}
.card {
  border: 1px solid var(--color-gray-4);
  border-radius: 12px;
  padding: 14px;
  background: color-mix(in srgb, var(--color-gray-2) 75%, transparent);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.name {
  font-weight: 700;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--color-gray-7);
}
.label {
  display: inline-block;
  min-width: 64px;
  color: var(--color-gray-6);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
