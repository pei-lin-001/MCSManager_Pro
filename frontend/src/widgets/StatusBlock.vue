<script setup lang="ts">
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import { t } from "@/lang/i18n";
import { getProgressStrokeColor } from "@/tools/progressColor";
import type { LayoutCard } from "@/types";
import {
  AppstoreOutlined,
  CloudServerOutlined,
  HddOutlined,
  SafetyCertificateOutlined
} from "@ant-design/icons-vue";
import type { Component } from "vue";
import { computed } from "vue";

const props = defineProps<{
  card: LayoutCard;
}>();

const { state } = useOverviewInfo();
const { getMetaValue } = useLayoutCardTools(props.card);
const type = getMetaValue<string>("type");

type Tone = "ok" | "warn" | "danger" | "info" | "muted";

interface KpiView {
  type: string;
  icon: Component;
  primary: string;
  secondary?: string;
  hint: string;
  percent?: number;
  tone: Tone;
  bars?: Array<{
    label: string;
    percent: number;
    detail?: string;
  }>;
}

const kpi = computed<KpiView | null>(() => {
  if (!state.value) return null;
  const s = state.value;

  if (type === "node") {
    const available = s.remoteCount?.available ?? 0;
    const total = s.remoteCount?.total ?? 0;
    const offline = Math.max(total - available, 0);
    const tone: Tone = total === 0 ? "muted" : offline > 0 ? "danger" : "ok";
    return {
      type: "node",
      icon: CloudServerOutlined,
      primary: String(available),
      secondary: `/ ${total}`,
      hint:
        total === 0
          ? t("TXT_CODE_OV_KPI_NODE_EMPTY")
          : offline > 0
            ? t("TXT_CODE_OV_KPI_NODE_OFFLINE", { n: offline })
            : t("TXT_CODE_OV_KPI_NODE_OK"),
      percent: total > 0 ? Math.round((available / total) * 100) : 0,
      tone
    };
  }

  if (type === "instance") {
    const running = s.runningInstance ?? 0;
    const total = s.totalInstance ?? 0;
    const stopped = Math.max(total - running, 0);
    const percent = total > 0 ? Math.round((running / total) * 100) : 0;
    const tone: Tone = total === 0 ? "muted" : running === 0 ? "warn" : "ok";
    return {
      type: "instance",
      icon: AppstoreOutlined,
      primary: String(running),
      secondary: `/ ${total}`,
      hint:
        total === 0
          ? t("TXT_CODE_OV_KPI_INSTANCE_EMPTY")
          : t("TXT_CODE_OV_KPI_INSTANCE_HINT", { running, stopped }),
      percent,
      tone
    };
  }

  if (type === "users") {
    const failed = s.record?.loginFailed ?? 0;
    const logined = s.record?.logined ?? 0;
    const tone: Tone = failed > 0 ? "warn" : "info";
    return {
      type: "users",
      icon: SafetyCertificateOutlined,
      primary: String(failed),
      secondary: `/ ${logined}`,
      hint: t("TXT_CODE_OV_KPI_LOGIN_HINT"),
      tone
    };
  }

  if (type === "system") {
    const cpu = Math.min(100, Math.max(0, Number(s.cpu || 0)));
    const freePercent = Math.min(100, Math.max(0, Number(s.mem || 0)));
    const memUsedPercent = Math.min(100, Math.max(0, 100 - freePercent));
    const memTotalGB = Number((s.system.totalmem / 1024 / 1024 / 1024).toFixed(1));
    const memUsedGB = Number(((memTotalGB * memUsedPercent) / 100).toFixed(1));
    const worst = Math.max(cpu, memUsedPercent);
    const tone: Tone = worst >= 85 ? "danger" : worst >= 65 ? "warn" : "ok";
    return {
      type: "system",
      icon: HddOutlined,
      primary: `${cpu}%`,
      secondary: "CPU",
      hint: t("TXT_CODE_OV_KPI_SYSTEM_HINT", { mem: `${memUsedGB}/${memTotalGB}G` }),
      tone,
      bars: [
        { label: "CPU", percent: cpu },
        {
          label: t("TXT_CODE_593ee330"),
          percent: memUsedPercent,
          detail: `${memUsedGB}/${memTotalGB}G`
        }
      ]
    };
  }

  return null;
});
</script>

<template>
  <CardPanel class="StatusBlock" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div v-if="!kpi" class="kpi kpi--loading">
        <a-skeleton active :paragraph="{ rows: 2 }" :title="false" />
      </div>

      <div v-else class="kpi" :class="`kpi--${kpi.tone}`">
        <div class="kpi__hint-row">
          <span class="kpi__badge">
            <component :is="kpi.icon" />
          </span>
          <span class="kpi__hint">{{ kpi.hint }}</span>
          <span class="kpi__tone-dot" />
        </div>

        <template v-if="kpi.type === 'system' && kpi.bars">
          <div class="kpi__bars">
            <div v-for="bar in kpi.bars" :key="bar.label" class="kpi__bar">
              <div class="kpi__bar-head">
                <span>{{ bar.label }}</span>
                <span class="kpi__bar-val">
                  {{ bar.percent }}%
                  <span v-if="bar.detail" class="kpi__bar-detail">{{ bar.detail }}</span>
                </span>
              </div>
              <a-progress
                :percent="bar.percent"
                :stroke-color="getProgressStrokeColor(bar.percent)"
                :stroke-width="8"
                :show-info="false"
              />
            </div>
          </div>
        </template>

        <template v-else>
          <div class="kpi__value-row">
            <span class="kpi__primary">{{ kpi.primary }}</span>
            <span v-if="kpi.secondary" class="kpi__secondary">{{ kpi.secondary }}</span>
          </div>
          <a-progress
            v-if="typeof kpi.percent === 'number'"
            class="kpi__progress"
            :percent="kpi.percent"
            :stroke-color="getProgressStrokeColor(kpi.percent)"
            :stroke-width="7"
            :show-info="false"
          />
        </template>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.StatusBlock {
  position: relative;
  overflow: visible;

  :deep(.card-panel-content) {
    overflow: visible;
  }
}

.kpi {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  min-height: 0;
  // Keep glow/halo of the right status dot inside the card.
  padding-right: 4px;

  &--loading {
    justify-content: center;
  }

  &__hint-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding-right: 2px;
  }

  &__badge {
    width: 26px;
    height: 26px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    flex: 0 0 auto;
    background: color-mix(in srgb, var(--color-primary) 14%, transparent);
    color: var(--color-primary);
  }

  &__hint {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--color-gray-7);
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__tone-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    margin-right: 2px;
    background: var(--color-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent);
  }

  &__value-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }

  &__primary {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--color-gray-12);
  }

  &__secondary {
    font-size: 14px;
    color: var(--color-gray-7);
    font-weight: 500;
  }

  &__progress {
    margin-top: auto;
    max-width: 100%;
  }

  &__bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 2px;
  }

  &__bar-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 11px;
    margin-bottom: 2px;
    color: var(--color-gray-8);
  }

  &__bar-val {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--color-gray-10);
  }

  &__bar-detail {
    margin-left: 6px;
    font-weight: 400;
    color: var(--color-gray-7);
  }

  &--ok {
    .kpi__badge {
      background: color-mix(in srgb, var(--color-success) 16%, transparent);
      color: var(--color-success);
    }
    .kpi__tone-dot {
      background: var(--color-success);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 18%, transparent);
    }
    .kpi__primary {
      color: var(--color-success);
    }
  }

  &--warn {
    .kpi__badge {
      background: color-mix(in srgb, var(--color-warning) 16%, transparent);
      color: var(--color-warning);
    }
    .kpi__tone-dot {
      background: var(--color-warning);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 18%, transparent);
    }
    .kpi__primary {
      color: var(--color-warning);
    }
  }

  &--danger {
    .kpi__badge {
      background: color-mix(in srgb, var(--color-danger) 16%, transparent);
      color: var(--color-danger);
    }
    .kpi__tone-dot {
      background: var(--color-danger);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 18%, transparent);
    }
    .kpi__primary {
      color: var(--color-danger);
    }
  }

  &--info {
    .kpi__primary {
      color: var(--color-primary);
    }
  }

  &--muted {
    .kpi__primary {
      color: var(--color-gray-8);
    }
    .kpi__tone-dot {
      background: var(--color-gray-6);
      box-shadow: none;
    }
  }
}
</style>
