<script setup lang="ts">
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import { t } from "@/lang/i18n";
import { getProgressStrokeColor } from "@/tools/progressColor";
import type { LayoutCard } from "@/types";
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  DesktopOutlined,
  InfoCircleOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined
} from "@ant-design/icons-vue";
import { computed } from "vue";

defineProps<{
  card: LayoutCard;
}>();

const { state } = useOverviewInfo();

const summary = computed(() => {
  if (!state.value) return null;
  const {
    system,
    version,
    specifiedDaemonVersion,
    process,
    remoteCount,
    runningInstance,
    totalInstance,
    cpu,
    mem
  } = state.value;

  const freePercent = Math.min(100, Math.max(0, Number(mem || 0)));
  const memUsedPercent = Math.min(100, Math.max(0, 100 - freePercent));
  const cpuPercent = Math.min(100, Math.max(0, Number(cpu || 0)));
  const totalMem = Number((system.totalmem / 1024 / 1024 / 1024).toFixed(1));
  const usedMem = Number(((totalMem * memUsedPercent) / 100).toFixed(1));
  const processMem = Number((process.memory / 1024 / 1024).toFixed(1));
  const nodeOnline = remoteCount?.available ?? 0;
  const nodeTotal = remoteCount?.total ?? 0;
  const healthTone =
    nodeTotal > 0 && nodeOnline < nodeTotal
      ? "danger"
      : Math.max(cpuPercent, memUsedPercent) >= 85
        ? "danger"
        : Math.max(cpuPercent, memUsedPercent) >= 65
          ? "warn"
          : totalInstance > 0 && runningInstance === 0
            ? "warn"
            : "ok";

  return {
    healthTone,
    healthText:
      healthTone === "danger"
        ? t("TXT_CODE_OV_HEALTH_BAD")
        : healthTone === "warn"
          ? t("TXT_CODE_OV_HEALTH_WARN")
          : t("TXT_CODE_OV_HEALTH_OK"),
    cpuPercent,
    memUsedPercent,
    usedMem,
    totalMem,
    processMem,
    version,
    specifiedDaemonVersion,
    hostname: system.hostname || "--",
    platform: `${system.type} ${system.platform}`,
    node: system.node,
    osVersion:
      system.version.length > 24
        ? `${system.version.slice(0, 24)}...`
        : `${system.version} ${system.release}`,
    loadavg: system.loadavg?.map((v) => Number(Number(v).toFixed(2))) || [],
    isWindows: system.type.toLowerCase().includes("windows"),
    runningInstance,
    totalInstance,
    nodeOnline,
    nodeTotal,
    banips: state.value.record?.banips ?? 0,
    illegalAccess: state.value.record?.illegalAccess ?? 0
  };
});
</script>

<template>
  <div class="panel-overview">
    <CardPanel style="height: 100%">
      <template #title>{{ card.title }}</template>
      <template #body>
        <div v-if="!summary" class="overview-loading">
          <a-skeleton active :paragraph="{ rows: 3 }" />
        </div>

        <div v-else class="overview-grid">
          <div class="health-banner" :class="`health-banner--${summary.healthTone}`">
            <div class="health-banner__left">
              <span class="health-banner__dot" />
              <div class="health-banner__text">
                <span class="health-banner__title">{{ summary.healthText }}</span>
                <span class="health-banner__sub">
                  {{
                    t("TXT_CODE_OV_HEALTH_SUB", {
                      nodeOnline: summary.nodeOnline,
                      nodeTotal: summary.nodeTotal,
                      running: summary.runningInstance,
                      total: summary.totalInstance
                    })
                  }}
                </span>
              </div>
            </div>
            <div class="health-banner__meta">
              <span>{{ summary.hostname }}</span>
              <span class="sep">·</span>
              <span>{{ summary.platform }}</span>
            </div>
          </div>

          <div class="main-row">
            <div class="resource-panel">
              <div class="resource-card">
                <div class="resource-card__head">
                  <ThunderboltOutlined />
                  <span>CPU</span>
                  <span
                    class="resource-card__value"
                    :style="{ color: getProgressStrokeColor(summary.cpuPercent)['0%'] }"
                  >
                    {{ summary.cpuPercent }}%
                  </span>
                </div>
                <a-progress
                  :percent="summary.cpuPercent"
                  :stroke-color="getProgressStrokeColor(summary.cpuPercent)"
                  :stroke-width="10"
                  :show-info="false"
                />
              </div>

              <div class="resource-card">
                <div class="resource-card__head">
                  <DesktopOutlined />
                  <span>{{ t("TXT_CODE_593ee330") }}</span>
                  <span
                    class="resource-card__value"
                    :style="{ color: getProgressStrokeColor(summary.memUsedPercent)['0%'] }"
                  >
                    {{ summary.memUsedPercent }}%
                  </span>
                </div>
                <div class="resource-card__detail">
                  {{ summary.usedMem }} / {{ summary.totalMem }} GB
                </div>
                <a-progress
                  :percent="summary.memUsedPercent"
                  :stroke-color="getProgressStrokeColor(summary.memUsedPercent)"
                  :stroke-width="10"
                  :show-info="false"
                />
              </div>

              <div class="resource-card">
                <div class="resource-card__head">
                  <InfoCircleOutlined />
                  <span v-if="!summary.isWindows && summary.loadavg.length >= 3">
                    {{ t("TXT_CODE_190ecd56") }}
                  </span>
                  <span v-else>{{ t("TXT_CODE_77d038f7") }}</span>
                </div>
                <div v-if="!summary.isWindows && summary.loadavg.length >= 3" class="load-tags">
                  <a-tag color="green">1m {{ summary.loadavg[0]?.toFixed(2) }}</a-tag>
                  <a-tag color="gold">5m {{ summary.loadavg[1]?.toFixed(2) }}</a-tag>
                  <a-tag color="volcano">15m {{ summary.loadavg[2]?.toFixed(2) }}</a-tag>
                </div>
                <div v-else class="resource-card__value resource-card__value--inline">
                  {{ summary.processMem }}MB
                </div>
                <div class="resource-card__detail">
                  {{ t("TXT_CODE_OV_PANEL_MEM", { mem: `${summary.processMem}MB` }) }}
                </div>
              </div>
            </div>

            <div class="info-panel">
              <div class="info-item">
                <AppstoreOutlined />
                <div>
                  <div class="info-item__label">{{ t("TXT_CODE_af21e6b") }}</div>
                  <div class="info-item__value">{{ summary.version }}</div>
                </div>
              </div>
              <div class="info-item">
                <ApiOutlined />
                <div>
                  <div class="info-item__label">{{ t("TXT_CODE_a0e70887") }}</div>
                  <div class="info-item__value">{{ summary.specifiedDaemonVersion }}</div>
                </div>
              </div>
              <div class="info-item">
                <CloudServerOutlined />
                <div>
                  <div class="info-item__label">{{ t("TXT_CODE_4df7e9bd") }}</div>
                  <div class="info-item__value">{{ summary.hostname }}</div>
                </div>
              </div>
              <div class="info-item">
                <DesktopOutlined />
                <div>
                  <div class="info-item__label">Node.js</div>
                  <div class="info-item__value">{{ summary.node }}</div>
                </div>
              </div>
              <div class="info-item">
                <InfoCircleOutlined />
                <div>
                  <div class="info-item__label">{{ t("TXT_CODE_b4d8588") }}</div>
                  <div class="info-item__value">{{ summary.osVersion }}</div>
                </div>
              </div>
              <div class="info-item info-item--soft">
                <SafetyCertificateOutlined />
                <div>
                  <div class="info-item__label">{{ t("TXT_CODE_OV_SOFT_SECURITY") }}</div>
                  <div class="info-item__value">
                    {{
                      t("TXT_CODE_OV_SOFT_SECURITY_VALUE", {
                        ban: summary.banips,
                        illegal: summary.illegalAccess
                      })
                    }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </CardPanel>
  </div>
</template>

<style lang="scss" scoped>
.panel-overview {
  height: 100%;

  :deep(.card-panel-content) {
    height: calc(100% - 28px);
    min-height: 0;
    overflow: auto;
  }
}

.overview-loading {
  padding: 4px 0;
}

.overview-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100%;
}

.health-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--color-gray-4);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);

  &__left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  &__text {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 20%, transparent);
    flex: 0 0 auto;
  }

  &__title {
    font-weight: 700;
    font-size: 13px;
    color: var(--color-gray-12);
  }

  &__sub {
    font-size: 12px;
    color: var(--color-gray-7);
  }

  &__meta {
    font-size: 12px;
    color: var(--color-gray-7);
    white-space: nowrap;
    .sep {
      margin: 0 4px;
      opacity: 0.6;
    }
  }

  &--ok {
    background: color-mix(in srgb, var(--color-success) 10%, transparent);
    border-color: color-mix(in srgb, var(--color-success) 28%, transparent);
    .health-banner__dot {
      background: var(--color-success);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 20%, transparent);
    }
  }

  &--warn {
    background: color-mix(in srgb, var(--color-warning) 12%, transparent);
    border-color: color-mix(in srgb, var(--color-warning) 30%, transparent);
    .health-banner__dot {
      background: var(--color-warning);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 20%, transparent);
    }
  }

  &--danger {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 30%, transparent);
    .health-banner__dot {
      background: var(--color-danger);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 20%, transparent);
    }
  }
}

.main-row {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.resource-panel {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.resource-card {
  border: 1px solid var(--color-gray-4);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--color-gray-2) 70%, transparent);

  &__head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-gray-8);
    font-size: 12px;
    margin-bottom: 6px;
  }

  &__value {
    margin-left: auto;
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;

    &--inline {
      margin: 2px 0 4px;
      font-size: 20px;
      font-weight: 700;
      color: var(--color-gray-11);
    }
  }

  &__detail {
    margin: 0 0 4px;
    font-size: 11px;
    color: var(--color-gray-7);
    font-variant-numeric: tabular-nums;
  }
}

.load-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0 4px;

  :deep(.ant-tag) {
    margin: 0;
    line-height: 18px;
    padding-inline: 6px;
  }
}

.info-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-content: start;
}

.info-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--color-gray-4);
  min-width: 0;

  > .anticon {
    margin-top: 2px;
    color: var(--color-primary);
    font-size: 13px;
  }

  &__label {
    font-size: 11px;
    color: var(--color-gray-7);
    margin-bottom: 1px;
  }

  &__value {
    font-size: 12px;
    color: var(--color-gray-11);
    font-weight: 600;
    word-break: break-word;
    line-height: 1.3;
  }

  &--soft {
    opacity: 0.92;
  }
}

@media (max-width: 1100px) {
  .main-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .info-panel {
    grid-template-columns: 1fr;
  }

  .health-banner {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
