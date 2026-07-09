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
      grid: {
        top: 8,
        bottom: 24,
        left: 34,
        right: 10
      },
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
          smooth: 0.4,
          showSymbol: false,
          sampling: "lttb",
          lineStyle: {
            width: 2.2,
            color: "#10b981",
            shadowColor: "rgba(16, 185, 129, 0.3)",
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
                { offset: 0, color: "rgba(16, 185, 129, 0.36)" },
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
      <div class="chart-body">
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
    line-height: 1.1;

    &--green {
      color: #10b981;
    }
  }
  &__unit {
    margin-left: 4px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-gray-7);
  }
}

.chart-canvas {
  width: 100%;
  flex: 1 1 auto;
  min-height: 140px;
}
</style>
