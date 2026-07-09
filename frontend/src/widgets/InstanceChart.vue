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
  // Backend currently packs runningInstance into chart.request points.
  const source = state.value?.chart?.request || [];
  return source.map((item, index) => {
    const max = source.length - 1;
    const row = item as { runningInstance?: number; value?: number };
    return {
      time: `${Math.max(max - index, 0)}s`,
      runningInstance: Number(row.runningInstance ?? row.value ?? 0)
    };
  });
});

const currentValue = computed(
  () => series.value[0]?.runningInstance ?? state.value?.runningInstance ?? 0
);
const totalValue = computed(() => state.value?.totalInstance ?? 0);

watch(
  () => [series.value, totalValue.value] as const,
  ([source, total]) => {
    if (!chart || source.length === 0) return;
    const maxY = Math.max(total || 1, ...source.map((v) => v.runningInstance), 1);
    chart.setOption({
      color: ["#10b981"],
      yAxis: {
        max: maxY,
        minInterval: 1
      },
      dataset: {
        dimensions: ["time", "runningInstance"],
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
            color: "#10b981",
            shadowColor: "rgba(16, 185, 129, 0.35)",
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
                { offset: 0, color: "rgba(16, 185, 129, 0.42)" },
                { offset: 1, color: "rgba(16, 185, 129, 0.02)" }
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
          <div class="chart-metric__label">{{ t("TXT_CODE_OV_CHART_RUNNING") }}</div>
          <div class="chart-metric__value chart-metric__value--green">
            {{ currentValue }}
            <span class="chart-metric__unit">/ {{ totalValue }}</span>
          </div>
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
    line-height: 1.1;

    &--green {
      color: #10b981;
    }
  }
  &__unit {
    margin-left: 4px;
    font-size: 14px;
    font-weight: 500;
    color: var(--color-gray-7);
  }
}

.chart-canvas {
  width: 100%;
  min-height: 160px;
  height: calc(100% - 48px);
}
</style>
