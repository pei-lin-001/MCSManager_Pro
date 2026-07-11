<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { t } from "@/lang/i18n";
import { getFrpTraffic, type FrpTrafficSummary } from "@/services/apis/frp";
import type { LayoutCard } from "@/types";
import { CloudServerOutlined, ReloadOutlined } from "@ant-design/icons-vue";
import { onMounted, onUnmounted, ref } from "vue";

defineProps<{ card: LayoutCard }>();

const loading = ref(false);
const data = ref<FrpTrafficSummary | null>(null);
const { execute } = getFrpTraffic();
let timer: any;

const formatBytes = (n?: number) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v.toFixed(0)} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(2)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
};

const formatRate = (n?: number) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v.toFixed(0)} B/s`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${(v / 1024 ** 2).toFixed(2)} MB/s`;
};

const formatMoney = (n?: number, currency = "CNY") => {
  const v = Number(n || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
};

const refresh = async () => {
  if (loading.value) return;
  loading.value = true;
  try {
    const res = await execute();
    data.value = res.value || null;
  } catch {
    // keep last
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  refresh();
  timer = setInterval(refresh, 5000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <CardPanel class="FrpTrafficCard" style="height: 100%">
    <template #title>
      <span class="title-row">
        <CloudServerOutlined />
        {{ card.title || t("TXT_CODE_FRP_TRAFFIC_TITLE") }}
      </span>
    </template>
    <template #operator>
      <a-button size="small" type="link" :loading="loading" @click="refresh">
        <ReloadOutlined />
      </a-button>
    </template>
    <template #body>
      <div v-if="!data" class="empty">{{ t("TXT_CODE_FRP_TRAFFIC_LOADING") }}</div>
      <div v-else class="body">
        <div class="kpis">
          <div class="kpi">
            <div class="label">{{ t("TXT_CODE_FRP_TRAFFIC_STATUS") }}</div>
            <div class="value">
              {{ data.online }} {{ t("TXT_CODE_FRP_ONLINE") }}
              <span class="muted">/ {{ data.totalTunnels }}</span>
            </div>
          </div>
          <div class="kpi">
            <div class="label">{{ t("TXT_CODE_FRP_TRAFFIC_LIVE") }}</div>
            <div class="value rate">
              ↓{{ formatRate(data.liveRxRate) }} ↑{{ formatRate(data.liveTxRate) }}
            </div>
          </div>
          <div class="kpi">
            <div class="label">{{ t("TXT_CODE_FRP_TRAFFIC_TODAY") }}</div>
            <div class="value">{{ formatBytes(data.today.totalBytes) }}</div>
            <div class="sub">
              ↓{{ formatBytes(data.today.rxBytes) }} ↑{{ formatBytes(data.today.txBytes) }}
            </div>
          </div>
          <div class="kpi">
            <div class="label">{{ t("TXT_CODE_FRP_TRAFFIC_MONTH") }}</div>
            <div class="value">{{ formatBytes(data.month.totalBytes) }}</div>
            <div class="sub">
              {{ t("TXT_CODE_FRP_TRAFFIC_COST") }}:
              {{ formatMoney(data.estimate.monthCost, data.estimate.currency) }}
            </div>
          </div>
        </div>

        <div class="section-title">{{ t("TXT_CODE_FRP_TRAFFIC_RANK") }}</div>
        <div v-if="!data.month.byInstance?.length" class="empty-mini">
          {{ t("TXT_CODE_FRP_TRAFFIC_EMPTY") }}
        </div>
        <div v-else class="rank-list">
          <div v-for="row in data.month.byInstance.slice(0, 8)" :key="row.instanceUuid" class="rank-item">
            <div class="name">{{ row.nickname || row.instanceUuid.slice(0, 8) }}</div>
            <div class="bytes">{{ formatBytes(row.totalBytes) }}</div>
            <div class="ports" v-if="row.remotePort">:{{ row.remotePort }}</div>
          </div>
        </div>

        <div class="section-title">{{ t("TXT_CODE_FRP_TRAFFIC_TUNNELS") }}</div>
        <div v-if="!data.tunnels?.length" class="empty-mini">{{ t("TXT_CODE_FRP_TRAFFIC_NO_TUNNEL") }}</div>
        <div v-else class="tunnel-list">
          <a-tag
            v-for="tunn in data.tunnels.slice(0, 12)"
            :key="tunn.instanceUuid + (tunn.daemonId || '')"
            :color="tunn.status === 'online' ? 'green' : tunn.status === 'error' ? 'red' : 'default'"
          >
            {{ tunn.nickname || tunn.instanceUuid.slice(0, 6) }}
            {{ tunn.publicAddr || `${tunn.localPort}` }}
            · ↓{{ formatRate(tunn.rxRate) }}
          </a-tag>
        </div>
      </div>
    </template>
  </CardPanel>
</template>

<style scoped lang="scss">
.FrpTrafficCard {
  :deep(.card-panel-content) {
    overflow: auto;
  }
}
.title-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.kpi {
  border: 1px solid var(--color-gray-4);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--color-gray-2) 80%, transparent);
}
.label {
  font-size: 12px;
  color: var(--color-gray-7);
}
.value {
  margin-top: 4px;
  font-size: 16px;
  font-weight: 700;
}
.value.rate {
  font-size: 14px;
}
.sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--color-gray-7);
}
.muted {
  color: var(--color-gray-7);
  font-weight: 500;
}
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-gray-8);
}
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rank-item {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.rank-item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-item .bytes {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.rank-item .ports {
  color: var(--color-gray-7);
}
.tunnel-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.empty,
.empty-mini {
  color: var(--color-gray-7);
  font-size: 13px;
}
</style>
