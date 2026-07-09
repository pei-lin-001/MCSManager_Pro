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
      yAxis: {
        max: Math.ceil(max * 1.2)
      },
      dataset: {
        dimensions: ["time", "value"],
        source: [...source].reverse()
      },
      series: [
        {
          type: "line",
          smooth: 0.45,
          showSymbol: false,
          sampling: "lttb",
          lineStyle: {
            width: 2.4,
            color: "#3b82f6",
            shadowColor: "rgba(59, 130, 246, 0.35)",
            shadowBlur: 8
          },
          areaStyle: {
            color: {
              type: "linear",
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(59, 130, 246, 0.45)" },
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
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.ChartCard {
  height: 100%;
}

.chart-head {
  display: flex;
  gap: 18px;
  margin-bottom: 8px;
}

.chart-metric {
  &__label {
    font-size: 12px;
    color: var(--color-gray-7);
  }
  &__value {
    margin-top: 2px;
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-primary);
    line-height: 1.1;
  }

  &--secondary .chart-metric__value {
    color: var(--color-gray-10);
    font-size: 18px;
  }
}

.chart-canvas {
  width: 100%;
  min-height: 160px;
  height: calc(100% - 48px);
}
</style>
