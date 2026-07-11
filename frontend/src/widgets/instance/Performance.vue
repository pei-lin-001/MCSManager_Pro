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
  ClockCircleOutlined,
  DashboardOutlined,
  FieldNumberOutlined,
  FundOutlined,
  HddOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined
} from "@ant-design/icons-vue";
import { init, type ECharts } from "echarts";
import prettyBytes from "pretty-bytes";
import {
  computed,
  nextTick,
  onUnmounted,
  ref,
  watch,
  type Component
} from "vue";

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

type LocalPoint = { t: number; cpu?: number; mem?: number; tps?: number; mspt?: number };
const localSeries = ref<LocalPoint[]>([]);
const chartRangeMin = ref<5 | 15 | 30 | 60>(15);

// Template refs — charts are inside v-if, so we lazy-init when DOM appears.
const tickEl = ref<HTMLDivElement | null>(null);
const cpuEl = ref<HTMLDivElement | null>(null);
const memEl = ref<HTMLDivElement | null>(null);
let tickChart: ECharts | null = null;
let cpuChart: ECharts | null = null;
let memChart: ECharts | null = null;

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

const formatUptime = (startedAt?: number) => {
  if (!startedAt || startedAt <= 0) return "";
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatAxisTime = (ts: number) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (chartRangeMin.value <= 15) return `${hh}:${mm}:${ss}`;
  return `${hh}:${mm}`;
};

const disposeCharts = () => {
  tickChart?.dispose();
  cpuChart?.dispose();
  memChart?.dispose();
  tickChart = null;
  cpuChart = null;
  memChart = null;
};

const ensureCharts = () => {
  if (tickEl.value && !tickChart) tickChart = init(tickEl.value);
  if (cpuEl.value && !cpuChart) cpuChart = init(cpuEl.value);
  if (memEl.value && !memChart) memChart = init(memEl.value);
};

// Merge daemon histories + live samples.
watch(
  () => instanceInfo.value?.info,
  (info) => {
    if (!info) return;
    const now = Date.now();
    const map = new Map<number, LocalPoint>();

    for (const p of localSeries.value) map.set(p.t, { ...p });

    for (const h of info.resourceHistory || []) {
      const t0 = Number(h.t);
      if (!Number.isFinite(t0)) continue;
      const prev = map.get(t0) || { t: t0 };
      if (h.cpu != null && h.cpu !== "") prev.cpu = Number(h.cpu);
      if (h.mem != null && h.mem !== "") prev.mem = Number(h.mem);
      map.set(t0, prev);
    }

    for (const h of info.tpsHistory || []) {
      const t0 = Number(h.time);
      if (!Number.isFinite(t0)) continue;
      const prev = map.get(t0) || { t: t0 };
      if (h.value != null && h.value !== "") prev.tps = Number(h.value);
      if (h.mspt != null && h.mspt !== "") prev.mspt = Number(h.mspt);
      map.set(t0, prev);
    }

    const live: LocalPoint = { t: now };
    if (info.cpuUsage != null) live.cpu = Number(info.cpuUsage);
    if (info.memoryUsagePercent != null) live.mem = Number(info.memoryUsagePercent);
    if (info.tps != null) live.tps = Number(info.tps);
    if (info.mspt != null) live.mspt = Number(info.mspt);

    const ordered = [...map.values()].sort((a, b) => a.t - b.t);
    const last = ordered.at(-1);
    if (!last || now - last.t >= 1500) {
      map.set(now, live);
    } else {
      map.set(last.t, {
        ...last,
        cpu: live.cpu ?? last.cpu,
        mem: live.mem ?? last.mem,
        tps: live.tps ?? last.tps,
        mspt: live.mspt ?? last.mspt
      });
    }

    localSeries.value = [...map.values()]
      .sort((a, b) => a.t - b.t)
      .filter((p) => now - p.t <= 60 * 60_000)
      .slice(-1500);
  },
  { deep: true, immediate: true }
);

const seriesInRange = computed(() => {
  const cutoff = Date.now() - chartRangeMin.value * 60_000;
  return localSeries.value.filter((p) => p.t >= cutoff);
});

const statsOf = (key: "cpu" | "mem" | "tps" | "mspt") => {
  const vals = seriesInRange.value
    .map((p) => p[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return { current: "-", avg: "-", min: "-", max: "-", n: 0 };
  const current = vals[vals.length - 1];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const unit = key === "mspt" ? " ms" : key === "tps" ? "" : "%";
  const fmt = (v: number) =>
    key === "tps" || key === "mspt" ? `${v.toFixed(2)}${unit}` : `${Math.round(v)}${unit}`;
  return {
    current: fmt(current),
    avg: fmt(avg),
    min: fmt(Math.min(...vals)),
    max: fmt(Math.max(...vals)),
    n: vals.length
  };
};

const cpuStats = computed(() => statsOf("cpu"));
const memStats = computed(() => statsOf("mem"));
const tpsStats = computed(() => statsOf("tps"));
const msptStats = computed(() => statsOf("mspt"));


const forwardFill = (values: (number | null)[]): (number | null)[] => {
  let last: number | null = null;
  return values.map((v) => {
    if (v != null && Number.isFinite(v)) {
      last = v;
      return v;
    }
    // Keep line continuous across sparse multi-source timestamps.
    return last;
  });
};

const renderCharts = () => {
  ensureCharts();

  const points = seriesInRange.value;
  // Need at least a placeholder axis so the canvas paints.
  const categories =
    points.length > 0
      ? points.map((p) => formatAxisTime(p.t))
      : [formatAxisTime(Date.now())];

  // Different metrics are sampled on different clocks (CPU ~3s, TPS ~15s).
  // Build a shared timeline then forward-fill so lines are continuous.
  const rawTps =
    points.length > 0 ? points.map((p) => (p.tps != null ? p.tps : null)) : [null];
  const rawMspt =
    points.length > 0 ? points.map((p) => (p.mspt != null ? p.mspt : null)) : [null];
  const rawCpu =
    points.length > 0 ? points.map((p) => (p.cpu != null ? p.cpu : null)) : [null];
  const rawMem =
    points.length > 0 ? points.map((p) => (p.mem != null ? p.mem : null)) : [null];
  const tpsData = forwardFill(rawTps);
  const msptData = forwardFill(rawMspt);
  const cpuData = forwardFill(rawCpu);
  const memData = forwardFill(rawMem);

  const msptNums = msptData.filter((v): v is number => v != null);
  const cpuNums = cpuData.filter((v): v is number => v != null);
  const memNums = memData.filter((v): v is number => v != null);
  const msptMax = Math.max(20, ...(msptNums.length ? msptNums : [20]));
  const cpuMax = Math.max(100, ...(cpuNums.length ? cpuNums : [0]));
  const memMax = Math.max(100, ...(memNums.length ? memNums : [0]));

  if (tickChart) {
    tickChart.setOption(
      {
        animation: false,
        color: ["#10b981", "#f59e0b"],
        grid: { top: 36, bottom: 28, left: 48, right: 48 },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: categories,
          boundaryGap: false,
          axisLabel: { fontSize: 10 }
        },
        yAxis: [
          {
            type: "value",
            name: "TPS",
            min: 0,
            max: 20.5,
            axisLabel: { fontSize: 10 }
          },
          {
            type: "value",
            name: "MSPT",
            min: 0,
            max: Math.ceil(msptMax * 1.25),
            axisLabel: { fontSize: 10 },
            splitLine: { show: false }
          }
        ],
        series: [
          {
            name: "TPS",
            type: "line",
            yAxisIndex: 0,
            smooth: 0.3,
            showSymbol: points.length <= 2,
            symbolSize: 6,
            connectNulls: true,
            data: tpsData,
            lineStyle: { width: 2.4, color: "#10b981" },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: "rgba(16,185,129,0.30)" },
                  { offset: 1, color: "rgba(16,185,129,0.02)" }
                ]
              }
            }
          },
          {
            name: "MSPT",
            type: "line",
            yAxisIndex: 1,
            smooth: 0.3,
            showSymbol: points.length <= 2,
            symbolSize: 6,
            connectNulls: true,
            data: msptData,
            lineStyle: { width: 2.2, color: "#f59e0b" }
          }
        ]
      },
      { notMerge: true }
    );
    tickChart.resize();
  }

  if (cpuChart) {
    cpuChart.setOption(
      {
        animation: false,
        color: ["#3b82f6"],
        grid: { top: 36, bottom: 28, left: 44, right: 16 },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (v == null ? "-" : `${v}%`) },
        xAxis: {
          type: "category",
          data: categories,
          boundaryGap: false,
          axisLabel: { fontSize: 10 }
        },
        yAxis: {
          type: "value",
          name: "%",
          min: 0,
          max: Math.ceil(Math.min(Math.max(cpuMax * 1.15, 100), 400)),
          axisLabel: { fontSize: 10 }
        },
        series: [
          {
            name: t("TXT_CODE_b862a158"),
            type: "line",
            smooth: 0.3,
            showSymbol: points.length <= 2,
            symbolSize: 6,
            connectNulls: true,
            data: cpuData,
            lineStyle: { width: 2.2, color: "#3b82f6" },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: "rgba(59,130,246,0.30)" },
                  { offset: 1, color: "rgba(59,130,246,0.02)" }
                ]
              }
            }
          }
        ]
      },
      { notMerge: true }
    );
    cpuChart.resize();
  }

  if (memChart) {
    memChart.setOption(
      {
        animation: false,
        color: ["#a855f7"],
        grid: { top: 36, bottom: 28, left: 44, right: 16 },
        legend: { top: 0, textStyle: { fontSize: 11 } },
        tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (v == null ? "-" : `${v}%`) },
        xAxis: {
          type: "category",
          data: categories,
          boundaryGap: false,
          axisLabel: { fontSize: 10 }
        },
        yAxis: {
          type: "value",
          name: "%",
          min: 0,
          max: Math.ceil(Math.min(Math.max(memMax * 1.1, 100), 100)),
          axisLabel: { fontSize: 10 }
        },
        series: [
          {
            name: t("TXT_CODE_593ee330"),
            type: "line",
            smooth: 0.3,
            showSymbol: points.length <= 2,
            symbolSize: 6,
            connectNulls: true,
            data: memData,
            lineStyle: { width: 2.2, color: "#a855f7" },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: "rgba(168,85,247,0.30)" },
                  { offset: 1, color: "rgba(168,85,247,0.02)" }
                ]
              }
            }
          }
        ]
      },
      { notMerge: true }
    );
    memChart.resize();
  }
};

const metrics = computed<MetricCard[]>(() => {
  const info = instanceInfo.value?.info;
  if (!info) return [];

  const cards: MetricCard[] = [];
  const running = isRunning.value;
  const statusTone = isStopped.value ? "gray" : running ? "green" : "gold";

  cards.push({
    key: "status",
    label: t("TXT_CODE_INST_PERF_STATUS"),
    value: statusText.value,
    detail: running ? t("TXT_CODE_INST_PERF_LIVE") : undefined,
    icon: InfoCircleOutlined,
    tone: statusTone
  });

  if (info.startedAt) {
    cards.push({
      key: "uptime",
      label: t("TXT_CODE_INST_PERF_UPTIME"),
      value: formatUptime(info.startedAt) || "-",
      detail: running ? t("TXT_CODE_INST_PERF_LIVE") : statusText.value,
      icon: ClockCircleOutlined,
      tone: running ? "blue" : "gray"
    });
  }

  if (info.processPid != null) {
    cards.push({
      key: "pid",
      label: t("TXT_CODE_INST_PERF_PID"),
      value: String(info.processPid),
      icon: FieldNumberOutlined,
      tone: "gray"
    });
  }

  if (info.cpuUsage != null) {
    const cpu = Number(info.cpuUsage);
    const percent = Math.min(Math.max(parseInt(String(cpu), 10) || 0, 0), 100);
    cards.push({
      key: "cpu",
      label: t("TXT_CODE_b862a158"),
      value: `${parseInt(String(cpu), 10)}%`,
      detail: running ? t("TXT_CODE_INST_PERF_LIVE") : statusText.value,
      percent,
      icon: BlockOutlined,
      tone: cpu > 85 ? "red" : cpu > 60 ? "gold" : "blue"
    });
  }

  if (info.memoryUsage != null) {
    const memPercent = Math.min(Math.max(info.memoryUsagePercent ?? 0, 0), 100);
    cards.push({
      key: "memory",
      label: t("TXT_CODE_593ee330"),
      value: formatMemoryUsage(info.memoryUsage, info.memoryLimit),
      detail:
        info.memoryUsagePercent != null ? `${Math.round(info.memoryUsagePercent)}%` : undefined,
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

  if (info.tps != null || info.mspt != null) {
    const tps = info.tps != null ? Number(info.tps) : undefined;
    const mspt = info.mspt != null ? Number(info.mspt) : undefined;
    const loadFromMspt =
      mspt != null && Number.isFinite(mspt)
        ? Math.min(Math.max((mspt / 50) * 100, 0), 100)
        : undefined;
    const loadPercent =
      info.tpsLoadPercent != null
        ? Math.min(Number(info.tpsLoadPercent), 100)
        : loadFromMspt ?? 0;
    const tone = loadPercent <= 40 ? "green" : loadPercent <= 80 ? "gold" : "red";
    const details: string[] = [];
    if (tps != null) details.push(`TPS ${tps.toFixed(2)}`);
    if (info.tpsSource) details.push(String(info.tpsSource));
    cards.push({
      key: "tick-health",
      label: t("TXT_CODE_INST_PERF_TICK"),
      value: mspt != null ? `${mspt.toFixed(2)} ms` : tps != null ? `${tps.toFixed(2)}` : "-",
      detail: details.join(" · ") || t("TXT_CODE_INST_PERF_LIVE"),
      percent: loadPercent,
      icon: FundOutlined,
      tone
    });
  }

  return cards;
});

// Show charts whenever we have instance info (not only when metric cards exist).
const showCharts = computed(() => !!instanceInfo.value?.info);

const emptyHint = computed(() => {
  if (isStopped.value) return t("TXT_CODE_INST_PERF_EMPTY_STOPPED");
  if (!isRunning.value) return t("TXT_CODE_INST_PERF_EMPTY_BUSY");
  return t("TXT_CODE_INST_PERF_EMPTY");
});

const hasChartData = computed(() =>
  seriesInRange.value.some(
    (p) => p.cpu != null || p.mem != null || p.tps != null || p.mspt != null
  )
);

// Re-init + redraw whenever data changes or chart containers appear.
watch(
  [seriesInRange, chartRangeMin, showCharts, metrics],
  async () => {
    if (!showCharts.value) {
      disposeCharts();
      return;
    }
    await nextTick();
    // One more frame so layout has real width/height.
    requestAnimationFrame(() => {
      renderCharts();
    });
  },
  { deep: true, immediate: true }
);

onUnmounted(() => {
  disposeCharts();
});
</script>

<template>
  <CardPanel class="InstancePerformance" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div v-if="!instanceInfo?.info" class="perf-empty">
        <CloudServerOutlined class="perf-empty__icon" />
        <div class="perf-empty__text">{{ emptyHint }}</div>
        <div class="perf-empty__sub">{{ t("TXT_CODE_INST_PERF_EMPTY_HINT") }}</div>
      </div>

      <div v-else class="perf-body">
        <div v-if="metrics.length" class="perf-grid">
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

        <div class="chart-toolbar">
          <div class="chart-toolbar__title">{{ t("TXT_CODE_INST_PERF_CHARTS") }}</div>
          <a-radio-group v-model:value="chartRangeMin" size="small" button-style="solid">
            <a-radio-button :value="5">5m</a-radio-button>
            <a-radio-button :value="15">15m</a-radio-button>
            <a-radio-button :value="30">30m</a-radio-button>
            <a-radio-button :value="60">60m</a-radio-button>
          </a-radio-group>
        </div>

        <div class="chart-grid">
          <div class="chart-card">
            <div class="chart-card__head">
              <div class="chart-card__title">TPS / MSPT</div>
              <div class="chart-card__stats">
                <span>TPS {{ tpsStats.current }}</span>
                <span>MSPT {{ msptStats.current }}</span>
                <span>avg {{ msptStats.avg }}</span>
                <span>max {{ msptStats.max }}</span>
              </div>
            </div>
            <div ref="tickEl" class="chart-card__canvas"></div>
            <div v-if="!hasChartData" class="chart-card__empty">
              {{ t("TXT_CODE_INST_PERF_CHART_WAIT") }}
            </div>
          </div>

          <div class="chart-card">
            <div class="chart-card__head">
              <div class="chart-card__title">{{ t("TXT_CODE_b862a158") }}</div>
              <div class="chart-card__stats">
                <span>{{ cpuStats.current }}</span>
                <span>avg {{ cpuStats.avg }}</span>
                <span>max {{ cpuStats.max }}</span>
              </div>
            </div>
            <div ref="cpuEl" class="chart-card__canvas"></div>
          </div>

          <div class="chart-card">
            <div class="chart-card__head">
              <div class="chart-card__title">{{ t("TXT_CODE_593ee330") }}</div>
              <div class="chart-card__stats">
                <span>{{ memStats.current }}</span>
                <span>avg {{ memStats.avg }}</span>
                <span>max {{ memStats.max }}</span>
              </div>
            </div>
            <div ref="memEl" class="chart-card__canvas"></div>
          </div>
        </div>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.InstancePerformance {
  :deep(.card-panel-content) {
    overflow: auto;
  }
}

.perf-empty {
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  opacity: 0.8;

  &__icon {
    font-size: 28px;
  }
  &__text {
    font-weight: 600;
  }
  &__sub {
    font-size: 12px;
    opacity: 0.7;
  }
}

.perf-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.perf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.perf-item {
  border: 1px solid rgba(127, 127, 127, 0.16);
  border-radius: 8px;
  padding: 10px;
  background: rgba(127, 127, 127, 0.04);

  &__top {
    display: flex;
    gap: 8px;
    margin-bottom: 6px;
  }
  &__icon {
    font-size: 16px;
    opacity: 0.85;
  }
  &__label {
    font-size: 12px;
    opacity: 0.7;
  }
  &__value {
    font-size: 15px;
    font-weight: 600;
  }
  &__detail {
    font-size: 11px;
    opacity: 0.65;
    margin-top: 2px;
  }
}

.chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;

  &__title {
    font-weight: 600;
    font-size: 13px;
  }
}

.chart-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.chart-card {
  border: 1px solid rgba(127, 127, 127, 0.16);
  border-radius: 8px;
  padding: 10px 12px 6px;
  position: relative;
  background: rgba(127, 127, 127, 0.03);

  &__head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  &__title {
    font-weight: 600;
    font-size: 13px;
  }
  &__stats {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 11px;
    opacity: 0.8;
  }
  &__canvas {
    width: 100%;
    height: 240px;
    min-height: 240px;
  }
  &__empty {
    position: absolute;
    inset: 48px 12px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    opacity: 0.6;
    pointer-events: none;
  }
}

@media (min-width: 1100px) {
  .chart-grid {
    grid-template-columns: 1.2fr 1fr;
  }
  .chart-card:first-child {
    grid-column: 1 / -1;
  }
}
</style>
