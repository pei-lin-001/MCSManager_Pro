<script setup lang="ts">
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { useInstanceInfo } from "@/hooks/useInstance";
import { t } from "@/lang/i18n";
import { formatMemoryUsage } from "@/tools/memory";
import { getProgressStrokeColor } from "@/tools/progressColor";
import type { LayoutCard } from "@/types";
import {
  ApartmentOutlined,
  BlockOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  HddOutlined,
  TeamOutlined,
  ThunderboltOutlined
} from "@ant-design/icons-vue";
import prettyBytes from "pretty-bytes";
import { computed, type Component } from "vue";

const props = defineProps<{
  card: LayoutCard;
}>();

const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const instanceId = getMetaOrRouteValue("instanceId");
const daemonId = getMetaOrRouteValue("daemonId");

const { instanceInfo, isRunning, isStopped, statusText } = useInstanceInfo({
  instanceId,
  daemonId,
  autoRefresh: true
});

interface MetricCard {
  key: string;
  label: string;
  value: string;
  detail?: string;
  percent?: number;
  icon: Component;
  tone: "blue" | "green" | "gold" | "red" | "purple" | "gray";
}

const formatSpeed = (bytes?: number) =>
  `${prettyBytes(bytes ?? 0, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    binary: false
  })}/s`;

const formatTraffic = (bytes?: number) =>
  prettyBytes(bytes ?? 0, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    binary: false
  });

const metrics = computed<MetricCard[]>(() => {
  const info = instanceInfo.value?.info;
  if (!info) return [];

  const cards: MetricCard[] = [];
  const running = isRunning.value;

  if (info.cpuUsage != null) {
    const cpu = Number(info.cpuUsage);
    const percent = Math.min(Math.max(parseInt(String(cpu), 10) || 0, 0), 100);
    const tone = cpu > 200 ? "red" : cpu > 100 ? "gold" : "blue";
    cards.push({
      key: "cpu",
      label: t("TXT_CODE_b862a158"),
      value: `${parseInt(String(cpu), 10)}%`,
      detail: running ? t("TXT_CODE_INST_PERF_LIVE") : statusText.value,
      percent,
      icon: BlockOutlined,
      tone
    });
  }

  if (info.memoryUsage != null) {
    const memPercent = Math.min(Math.max(info.memoryUsagePercent ?? 0, 0), 100);
    cards.push({
      key: "memory",
      label: t("TXT_CODE_593ee330"),
      value: formatMemoryUsage(info.memoryUsage, info.memoryLimit),
      detail:
        info.memoryUsagePercent != null
          ? `${Math.round(info.memoryUsagePercent)}%`
          : undefined,
      percent: memPercent,
      icon: DashboardOutlined,
      tone: memPercent >= 85 ? "red" : memPercent >= 65 ? "gold" : "green"
    });
  }

  if (info.storageUsage) {
    const storagePercent =
      info.storageUsage && info.storageLimit
        ? Math.min((info.storageUsage / info.storageLimit) * 100, 100)
        : 0;
    cards.push({
      key: "disk",
      label: t("TXT_CODE_DISK_USAGE"),
      value: formatMemoryUsage(info.storageUsage || 0, info.storageLimit || 0),
      percent: storagePercent,
      icon: HddOutlined,
      tone: storagePercent >= 85 ? "red" : storagePercent >= 65 ? "gold" : "purple"
    });
  }

  if (info.rxRate != null || info.txRate != null) {
    cards.push({
      key: "net-rate",
      label: t("TXT_CODE_NETWORK_CURRENT"),
      value: `↓${formatSpeed(info.rxRate)}  ↑${formatSpeed(info.txRate)}`,
      icon: ApartmentOutlined,
      tone: "blue"
    });
  }

  if (info.rxBytes != null || info.txBytes != null) {
    cards.push({
      key: "net-total",
      label: t("TXT_CODE_NETWORK_TOTAL"),
      value: `↓${formatTraffic(info.rxBytes)}  ↑${formatTraffic(info.txBytes)}`,
      icon: ThunderboltOutlined,
      tone: "gray"
    });
  }

  if (info.mcPingOnline) {
    cards.push({
      key: "players",
      label: t("TXT_CODE_INST_PERF_PLAYERS"),
      value: `${info.currentPlayers ?? 0} / ${info.maxPlayers ?? 0}`,
      detail: info.version || undefined,
      percent:
        info.maxPlayers && info.maxPlayers > 0
          ? Math.min(((info.currentPlayers ?? 0) / info.maxPlayers) * 100, 100)
          : 0,
      icon: TeamOutlined,
      tone: "green"
    });

    if (info.latency != null) {
      const latency = Number(info.latency);
      cards.push({
        key: "latency",
        label: t("TXT_CODE_INST_PERF_LATENCY"),
        value: `${latency} ms`,
        icon: CloudServerOutlined,
        tone: latency > 150 ? "red" : latency > 80 ? "gold" : "green"
      });
    }
  }

  return cards;
});

const emptyHint = computed(() => {
  if (isStopped.value) return t("TXT_CODE_INST_PERF_EMPTY_STOPPED");
  if (!isRunning.value) return t("TXT_CODE_INST_PERF_EMPTY_BUSY");
  return t("TXT_CODE_INST_PERF_EMPTY");
});
</script>

<template>
  <CardPanel class="InstancePerformance" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div v-if="metrics.length === 0" class="perf-empty">
        <CloudServerOutlined class="perf-empty__icon" />
        <div class="perf-empty__text">{{ emptyHint }}</div>
        <div class="perf-empty__sub">{{ t("TXT_CODE_INST_PERF_EMPTY_HINT") }}</div>
      </div>

      <div v-else class="perf-grid">
        <div
          v-for="item in metrics"
          :key="item.key"
          class="perf-item"
          :class="`perf-item--${item.tone}`"
        >
          <div class="perf-item__top">
            <span class="perf-item__icon">
              <component :is="item.icon" />
            </span>
            <div class="perf-item__meta">
              <div class="perf-item__label">{{ item.label }}</div>
              <div class="perf-item__value">{{ item.value }}</div>
              <div v-if="item.detail" class="perf-item__detail">{{ item.detail }}</div>
            </div>
          </div>
          <a-progress
            v-if="typeof item.percent === 'number' && item.percent > 0"
            :percent="item.percent"
            :stroke-color="getProgressStrokeColor(item.percent)"
            :show-info="false"
            :stroke-width="8"
          />
        </div>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.InstancePerformance {
  height: 100%;

  :deep(.card-panel-content) {
    height: calc(100% - 28px);
    min-height: 0;
    overflow: auto;
  }
}

.perf-empty {
  height: 100%;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-gray-7);
  gap: 4px;

  &__icon {
    font-size: 22px;
    margin-bottom: 4px;
    opacity: 0.7;
  }

  &__text {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-gray-9);
  }

  &__sub {
    font-size: 12px;
    color: var(--color-gray-7);
  }
}

.perf-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  height: 100%;
  align-content: start;
}

.perf-item {
  border: 1px solid var(--color-gray-4);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--color-gray-2) 65%, transparent);
  min-width: 0;

  &__top {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-bottom: 8px;
  }

  &__icon {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    font-size: 14px;
  }

  &__meta {
    min-width: 0;
    flex: 1;
  }

  &__label {
    font-size: 12px;
    color: var(--color-gray-7);
    margin-bottom: 2px;
  }

  &__value {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-gray-12);
    font-variant-numeric: tabular-nums;
    word-break: break-word;
    line-height: 1.25;
  }

  &__detail {
    margin-top: 2px;
    font-size: 11px;
    color: var(--color-gray-7);
  }

  &--blue .perf-item__icon {
    background: color-mix(in srgb, var(--color-blue-5) 16%, transparent);
    color: var(--color-blue-6);
  }
  &--green .perf-item__icon {
    background: color-mix(in srgb, var(--color-success) 16%, transparent);
    color: var(--color-success);
  }
  &--gold .perf-item__icon {
    background: color-mix(in srgb, var(--color-warning) 16%, transparent);
    color: var(--color-warning);
  }
  &--red .perf-item__icon {
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
    color: var(--color-danger);
  }
  &--purple .perf-item__icon {
    background: color-mix(in srgb, var(--color-purple-6) 16%, transparent);
    color: var(--color-purple-6);
  }
  &--gray .perf-item__icon {
    background: color-mix(in srgb, var(--color-gray-7) 14%, transparent);
    color: var(--color-gray-8);
  }
}

@media (max-width: 1200px) {
  .perf-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .perf-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .perf-grid {
    grid-template-columns: 1fr;
  }
}
</style>
