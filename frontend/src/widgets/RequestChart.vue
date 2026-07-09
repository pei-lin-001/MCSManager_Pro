<script setup lang="ts">
import type { LayoutCard } from "@/types";
import { computed, watch } from "vue";
import { useOverviewChart } from "../hooks/useOverviewChart";
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import { getRandomId } from "@/tools/randId";
import { t } from "@/lang/i18n";

defineProps<{
  card: LayoutCard;
}>();

const domId = getRandomId();
const { state } = useOverviewInfo();
const chart = useOverviewChart(domId);

const series = computed(() => {
  const source = state.value?.chart?.request || [];
  return source.map((item, index) => {
    const max = source.length - 1;
    return {
      time: `${Math.max(max - index, 0)}s`,
      value: Number((item as { value?: number }).value || 0)
    };
  });
});

const currentValue = computed(() => series.value[0]?.value ?? 0);
const maxValue = computed(() => {
  if (series.value.length === 0) return 0;
  return Math.max(...series.value.map((v) => v.value));
});

watch(
  series,
  (source) => {
    if (!chart || source.length === 0) return;
    const max = Math.max(...source.map((v) => v.value), 1);
    chart.setOption({
      color: ["#3b82f6"],
      grid: {
        top: 8,
        bottom: 24,
        left: 34,
        right: 10
      },
      yAxis: {
        max: Math.ceil(max * 1.15)
      },
      dataset: {
        dimensions: ["time", "value"],
        source: [...source].reverse()
      },
      series: [
        {
          type: "line",
          smooth: 0.4,
          showSymbol: false,
          sampling: "lttb",
          lineStyle: {
            width: 2.2,
            color: "#3b82f6",
            shadowColor: "rgba(59, 130, 246, 0.3)",
            shadowBlur: 6
          },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(59, 130, 246, 0.38)" },
                { offset: 1, color: "rgba(59, 130, 246, 0.02)" }
              ]
            }
          }
        }
      ]
    });
  },
  { deep: true }
);
</script>

<template>
  <CardPanel class="ChartCard" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div class="chart-body">
        <div class="chart-head">
          <div class="chart-metric">
            <div class="chart-metric__label">{{ t("TXT_CODE_OV_CHART_CURRENT") }}</div>
            <div class="chart-metric__value">{{ currentValue }}</div>
          </div>
          <div class="chart-metric chart-metric--secondary">
            <div class="chart-metric__label">{{ t("TXT_CODE_OV_CHART_PEAK") }}</div>
            <div class="chart-metric__value">{{ maxValue }}</div>
          </div>
        </div>
        <div :id="domId" class="chart-canvas"></div>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.ChartCard {
  height: 100%;

  :deep(.card-panel-content) {
    height: calc(100% - 28px);
    min-height: 0;
  }
}

.chart-body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chart-head {
  display: flex;
  gap: 16px;
  flex: 0 0 auto;
}

.chart-metric {
  &__label {
    font-size: 12px;
    color: var(--color-gray-7);
  }
  &__value {
    margin-top: 1px;
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-primary);
    line-height: 1.1;
  }

  &--secondary .chart-metric__value {
    color: var(--color-gray-10);
    font-size: 16px;
  }
}

.chart-canvas {
  width: 100%;
  flex: 1 1 auto;
  min-height: 140px;
}
</style>
