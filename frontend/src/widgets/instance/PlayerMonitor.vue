<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { useInstanceInfo } from "@/hooks/useInstance";
import { useOverviewChart } from "@/hooks/useOverviewChart";
import { t } from "@/lang/i18n";
import {
  getPlayerMonitorSnapshot,
  getPlayerProfile,
  runPlayerMonitorAction,
  type PlayerActionType,
  type PlayerMonitorMode,
  type PlayerMonitorSnapshot,
  type PlayerProfileDetail,
  type PlayerRow,
  type PingHistoryPoint,
  type RankRow
} from "@/services/apis/playerMonitor";
import {
  markSkinBroken,
  playerInitial,
  playerSkinId,
  skinUrl,
  type SkinKind
} from "@/tools/minecraftSkin";
import { getRandomId } from "@/tools/randId";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import { ReloadOutlined, TeamOutlined, TrophyOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import type { TableColumnsType } from "ant-design-vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

const props = defineProps<{ card: LayoutCard }>();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const instanceId = getMetaOrRouteValue("instanceId") || "";
const daemonId = getMetaOrRouteValue("daemonId") || "";

const { instanceInfo, isRunning, statusText } = useInstanceInfo({
  instanceId,
  daemonId,
  autoRefresh: true
});

const snapshot = ref<PlayerMonitorSnapshot | null>(null);
const initialLoading = ref(false);
const refreshing = ref(false);
const actingKey = ref("");
const onlyOnline = ref(true);
const keyword = ref("");
const autoRefresh = ref(true);
const chartRangeMin = ref<5 | 15 | 30 | 60>(15);
const selectedPlayers = ref<string[]>([]);
const rankKey = ref("playtime");

const profileOpen = ref(false);
const profileLoading = ref(false);
const profile = ref<PlayerProfileDetail | null>(null);
const profileName = ref("");
const profileUuid = ref("");
const profileOnline = ref(false);
const profileAfk = ref(false);
/** bump to force avatar re-render after error fallback */
const skinEpoch = ref(0);

let timer: ReturnType<typeof setInterval> | null = null;
let fullTimer: ReturnType<typeof setInterval> | null = null;
let refreshSeq = 0;
const localHistory = ref<PingHistoryPoint[]>([]);

const chartDomId = getRandomId();
const chart = useOverviewChart(chartDomId);
const { execute: fetchSnapshot } = getPlayerMonitorSnapshot();
const { execute: fetchProfile } = getPlayerProfile();
const { execute: execAction } = runPlayerMonitorAction();

const formatDuration = (ms?: number) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec % 60}s`;
};

const formatDistance = (blocks?: number) => {
  if (blocks == null || !Number.isFinite(blocks)) return "-";
  if (blocks >= 1000) return `${(blocks / 1000).toFixed(2)} km`;
  return `${Math.round(blocks)} m`;
};

const formatTime = (ts?: number) => {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString();
};

const avatarSrc = (uuid?: string, name?: string, size = 64) => {
  void skinEpoch.value;
  return skinUrl("avatar", playerSkinId(uuid, name), size);
};

const bodySrc = (uuid?: string, name?: string, size = 180) => {
  void skinEpoch.value;
  return skinUrl("body", playerSkinId(uuid, name), size);
};

const onSkinError = (kind: SkinKind, uuid?: string, name?: string, size = 64) => {
  markSkinBroken(kind, playerSkinId(uuid, name), size);
  skinEpoch.value += 1;
  return false;
};

const filteredPlayers = computed(() => {
  const rows = snapshot.value?.players || [];
  const kw = keyword.value.trim().toLowerCase();
  return rows.filter((p) => {
    if (onlyOnline.value && !p.online) return false;
    if (!kw) return true;
    return p.name.toLowerCase().includes(kw) || (p.uuid || "").toLowerCase().includes(kw);
  });
});

const columns = computed<TableColumnsType<PlayerRow>>(() => [
  { title: t("TXT_CODE_PLAYER_COL_NAME"), key: "name", dataIndex: "name" },
  { title: t("TXT_CODE_PLAYER_COL_STATUS"), key: "status", width: 120 },
  { title: t("TXT_CODE_PLAYER_COL_PING"), key: "ping", width: 100 },
  { title: t("TXT_CODE_PLAYER_COL_PLAYTIME"), key: "playtime", width: 120 },
  { title: t("TXT_CODE_PLAYER_COL_DISTANCE"), key: "distance", width: 110 },
  { title: t("TXT_CODE_PLAYER_COL_DEATHS"), key: "deaths", width: 80 },
  { title: t("TXT_CODE_PLAYER_COL_KILLS"), key: "kills", width: 100 },
  { title: t("TXT_CODE_PLAYER_COL_BLOCKS"), key: "blocks", width: 120 },
  { title: t("TXT_CODE_PLAYER_COL_ACTIONS"), key: "actions", width: 300 }
]);

const summaryText = computed(() => {
  const s = snapshot.value;
  if (!s) return "";
  const parts = [
    `${t("TXT_CODE_PLAYER_ONLINE")}: ${s.onlineCount}${
      s.maxPlayers != null ? ` / ${s.maxPlayers}` : ""
    }`
  ];
  if (s.sparkSummary?.tps != null) parts.push(`TPS ${s.sparkSummary.tps.toFixed(2)}`);
  if (s.sparkSummary?.mspt != null) parts.push(`MSPT ${s.sparkSummary.mspt.toFixed(2)}ms`);
  const last = localHistory.value[localHistory.value.length - 1];
  if (last?.avg != null) parts.push(`${t("TXT_CODE_PLAYER_PING_AVG")} ${last.avg}ms`);
  parts.push(
    s.sparkAvailable ? t("TXT_CODE_PLAYER_METRICS_OK") : t("TXT_CODE_PLAYER_METRICS_MISSING")
  );
  return parts.join(" · ");
});

const rankOptions = [
  { value: "playtime", labelKey: "TXT_CODE_PLAYER_RANK_PLAYTIME" },
  { value: "activePlaytime", labelKey: "TXT_CODE_PLAYER_RANK_ACTIVE" },
  { value: "distance", labelKey: "TXT_CODE_PLAYER_RANK_DISTANCE" },
  { value: "deaths", labelKey: "TXT_CODE_PLAYER_RANK_DEATHS" },
  { value: "playerKills", labelKey: "TXT_CODE_PLAYER_RANK_PKILLS" },
  { value: "mobKills", labelKey: "TXT_CODE_PLAYER_RANK_MKILLS" },
  { value: "blocksBroken", labelKey: "TXT_CODE_PLAYER_RANK_BROKEN" },
  { value: "blocksPlaced", labelKey: "TXT_CODE_PLAYER_RANK_PLACED" },
  { value: "xpGained", labelKey: "TXT_CODE_PLAYER_RANK_XP" }
];

const currentRanking = computed<RankRow[]>(() => {
  const ranks = snapshot.value?.rankings || {};
  return ranks[rankKey.value] || [];
});

const formatRankValue = (key: string, value: number) => {
  if (key === "playtime" || key === "activePlaytime") return formatDuration(value);
  if (key === "distance") return formatDistance(value);
  return String(value ?? 0);
};

const onlinePlayerOptions = computed(() => {
  const names = new Set<string>();
  for (const p of snapshot.value?.players || []) if (p.online) names.add(p.name);
  for (const pt of localHistory.value.slice(-40)) {
    if (!pt.byPlayer) continue;
    for (const n of Object.keys(pt.byPlayer)) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});

const historyInRange = computed(() => {
  const cutoff = Date.now() - chartRangeMin.value * 60_000;
  return localHistory.value.filter((p) => p.t >= cutoff);
});

const chartStats = computed(() => {
  const points = historyInRange.value.filter((p) => p.avg != null);
  if (!points.length) return { current: "-", avg: "-", min: "-", max: "-", samples: 0 };
  const last = points[points.length - 1];
  const avgs = points.map((p) => Number(p.avg));
  const mins = points.map((p) => Number(p.min ?? p.avg));
  const maxs = points.map((p) => Number(p.max ?? p.avg));
  return {
    current: `${last.avg} ms`,
    avg: `${Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length)} ms`,
    min: `${Math.min(...mins)} ms`,
    max: `${Math.max(...maxs)} ms`,
    samples: points.length
  };
});

const pingTone = (ping?: number) => {
  if (ping == null) return "default";
  if (ping <= 80) return "success";
  if (ping <= 150) return "warning";
  return "error";
};

const mergeHistory = (server: PingHistoryPoint[] | undefined) => {
  if (!server?.length) return;
  const map = new Map<number, PingHistoryPoint>();
  for (const p of localHistory.value) map.set(p.t, p);
  for (const p of server) map.set(p.t, p);
  localHistory.value = [...map.values()].sort((a, b) => a.t - b.t).slice(-240);
};

const formatAxisTime = (ts: number) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (chartRangeMin.value <= 15) return `${hh}:${mm}:${ss}`;
  return `${hh}:${mm}`;
};

const forwardFill = (values: (number | null)[]): (number | null)[] => {
  let last: number | null = null;
  return values.map((v) => {
    if (v != null && Number.isFinite(v)) {
      last = v;
      return v;
    }
    return last;
  });
};

const renderChart = () => {
  const points = historyInRange.value;
  if (!chart) return;
  const categories = points.map((p) => formatAxisTime(p.t));
  const avgSeries = forwardFill(points.map((p) => (p.avg != null ? p.avg : null)));
  const maxSeries = forwardFill(points.map((p) => (p.max != null ? p.max : null)));
  const minSeries = forwardFill(points.map((p) => (p.min != null ? p.min : null)));
  const palette = ["#a855f7", "#f59e0b", "#06b6d4", "#f97316", "#84cc16"];
  const series: Record<string, unknown>[] = [
    {
      name: t("TXT_CODE_PLAYER_PING_AVG"),
      type: "line",
      smooth: 0.35,
      showSymbol: false,
      connectNulls: true,
      data: avgSeries,
      lineStyle: { width: 2.4, color: "#3b82f6" },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(59,130,246,0.28)" },
            { offset: 1, color: "rgba(59,130,246,0.02)" }
          ]
        }
      }
    },
    {
      name: t("TXT_CODE_PLAYER_PING_MAX"),
      type: "line",
      smooth: 0.35,
      showSymbol: false,
      connectNulls: true,
      data: maxSeries,
      lineStyle: { width: 1.4, color: "#ef4444", type: "dashed" }
    },
    {
      name: t("TXT_CODE_PLAYER_PING_MIN"),
      type: "line",
      smooth: 0.35,
      showSymbol: false,
      connectNulls: true,
      data: minSeries,
      lineStyle: { width: 1.2, color: "#10b981", type: "dotted" }
    }
  ];
  selectedPlayers.value.slice(0, 5).forEach((name, idx) => {
    series.push({
      name,
      type: "line",
      smooth: 0.3,
      showSymbol: false,
      connectNulls: true,
      data: forwardFill(points.map((p) => p.byPlayer?.[name] ?? null)),
      lineStyle: { width: 1.6, color: palette[idx % palette.length] }
    });
  });
  const numeric = [...avgSeries, ...maxSeries, ...minSeries].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  const yMax = Math.max(50, ...(numeric.length ? numeric : [50]));
  chart.setOption({
    color: ["#3b82f6", "#ef4444", "#10b981", ...palette],
    animationDuration: 250,
    grid: { top: 36, bottom: 28, left: 42, right: 16 },
    legend: { top: 0, type: "scroll", textStyle: { fontSize: 11 } },
    tooltip: {
      trigger: "axis",
      valueFormatter: (v: unknown) => (v == null || v === "" ? "-" : `${v} ms`)
    },
    xAxis: {
      type: "category",
      data: categories,
      boundaryGap: false,
      axisLabel: { fontSize: 10 }
    },
    yAxis: {
      type: "value",
      name: "ms",
      min: 0,
      max: Math.ceil(yMax * 1.2),
      axisLabel: { fontSize: 10 }
    },
    series
  });
};

watch([historyInRange, selectedPlayers, chartRangeMin], () => nextTick(() => renderChart()), {
  deep: true
});

const refresh = async (opts?: { silent?: boolean; mode?: PlayerMonitorMode }) => {
  if (!instanceId || !daemonId) return;
  if (refreshing.value || initialLoading.value) return;
  if (actingKey.value && opts?.silent !== false) return;

  const hasData = snapshot.value != null;
  const silent = opts?.silent === true || (opts?.silent !== false && hasData);
  const mode: PlayerMonitorMode = opts?.mode || "fast";
  const seq = ++refreshSeq;
  if (silent) refreshing.value = true;
  else initialLoading.value = true;
  try {
    const res = await fetchSnapshot({
      params: { uuid: instanceId, daemonId, mode }
    });
    if (seq !== refreshSeq) return;
    snapshot.value = res.value || null;
    mergeHistory(res.value?.pingHistory);
    if (!selectedPlayers.value.length) {
      selectedPlayers.value = (res.value?.players || [])
        .filter((p) => p.online && p.pingMs != null)
        .slice(0, 3)
        .map((p) => p.name);
    }
  } catch (error: unknown) {
    if (seq === refreshSeq) reportErrorMsg(error);
  } finally {
    if (seq === refreshSeq) {
      initialLoading.value = false;
      refreshing.value = false;
    }
  }
};

const openProfile = async (row: PlayerRow) => {
  if (!row.uuid) {
    message.warning(t("TXT_CODE_PLAYER_NO_UUID"));
    return;
  }
  profileOpen.value = true;
  profileLoading.value = true;
  profileName.value = row.name;
  profileUuid.value = row.uuid;
  profileOnline.value = !!row.online;
  profileAfk.value = !!row.afk;
  profile.value = null;
  try {
    const res = await fetchProfile({
      params: {
        uuid: instanceId,
        daemonId,
        playerUuid: row.uuid
      }
    });
    profile.value = res.value || null;
    if (res.value?.name) profileName.value = res.value.name;
  } catch (error: unknown) {
    reportErrorMsg(error);
  } finally {
    profileLoading.value = false;
  }
};

const doAction = async (player: PlayerRow, action: PlayerActionType, reason?: string) => {
  if (!instanceId || !daemonId) return;
  const key = `${player.name}:${action}`;
  actingKey.value = key;
  try {
    const res = await execAction({
      params: { uuid: instanceId, daemonId },
      data: { action, player: player.name, reason }
    });
    message.success(res.value?.message || t("TXT_CODE_PLAYER_ACTION_DONE"));
    setTimeout(() => void refresh({ silent: true, mode: "fast" }), 800);
  } catch (error: unknown) {
    reportErrorMsg(error);
  } finally {
    actingKey.value = "";
  }
};

const confirmAction = (player: PlayerRow, action: PlayerActionType, title: string) => {
  Modal.confirm({
    title,
    content: `${player.name}`,
    onOk: async () => doAction(player, action)
  });
};

const kickPlayer = (player: PlayerRow) => {
  Modal.confirm({
    title: t("TXT_CODE_PLAYER_ACT_KICK"),
    content: player.name,
    onOk: async () => doAction(player, "kick")
  });
};

const banPlayer = (player: PlayerRow) => {
  Modal.confirm({
    title: t("TXT_CODE_PLAYER_ACT_BAN"),
    content: player.name,
    okType: "danger",
    onOk: async () => doAction(player, "ban")
  });
};

const setupTimers = () => {
  if (timer) clearInterval(timer);
  if (fullTimer) clearInterval(fullTimer);
  timer = setInterval(() => {
    if (!autoRefresh.value) return;
    void refresh({ silent: true, mode: "fast" });
  }, 5000);
  fullTimer = setInterval(() => {
    if (!autoRefresh.value) return;
    void refresh({ silent: true, mode: "fast" });
  }, 15000);
};

onMounted(async () => {
  await refresh({ silent: false, mode: "fast" });
  setupTimers();
  nextTick(() => renderChart());
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (fullTimer) clearInterval(fullTimer);
});

const dimEntries = computed(() => {
  const m = profile.value?.dimensionTimeMs || {};
  return Object.entries(m)
    .map(([k, v]) => ({ dim: k, ms: Number(v) || 0 }))
    .sort((a, b) => b.ms - a.ms);
});

const killEntries = computed(() => {
  const m = profile.value?.mobKillsByType || {};
  return Object.entries(m)
    .map(([type, count]) => ({
      type,
      label: type.includes(":") ? type.split(":").slice(1).join(":") : type,
      count: Number(count) || 0
    }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
});
</script>

<template>
  <div class="player-monitor">
    <CardPanel>
      <template #title>
        <TeamOutlined class="mr-8" />
        {{ card.title || t("TXT_CODE_PLAYER_MONITOR_TITLE") }}
      </template>
      <template #body>
        <div class="toolbar">
          <div class="meta">
            <a-tag :color="isRunning ? 'green' : 'default'">{{ statusText }}</a-tag>
            <span class="summary">{{ summaryText }}</span>
            <a-tag v-if="refreshing" color="processing">{{ t("TXT_CODE_PLAYER_REFRESHING") }}</a-tag>
          </div>
          <div class="tools">
            <a-input
              v-model:value="keyword"
              allow-clear
              style="width: 180px"
              :placeholder="t('TXT_CODE_PLAYER_SEARCH')"
            />
            <a-checkbox v-model:checked="onlyOnline">{{ t("TXT_CODE_PLAYER_ONLY_ONLINE") }}</a-checkbox>
            <a-checkbox v-model:checked="autoRefresh">{{ t("TXT_CODE_PLAYER_AUTO_REFRESH") }}</a-checkbox>
            <a-button
              :loading="initialLoading || refreshing"
              @click="() => refresh({ silent: true, mode: 'fast' })"
            >
              <ReloadOutlined />
              {{ t("TXT_CODE_PLAYER_REFRESH") }}
            </a-button>
          </div>
        </div>

        <a-alert
          v-if="snapshot?.warnings?.length"
          class="mb-12"
          type="warning"
          show-icon
          :message="snapshot.warnings.join(' | ')"
        />

        <div class="top-grid mb-12">
          <div class="ping-panel">
            <div class="ping-panel__head">
              <div class="ping-panel__title">{{ t("TXT_CODE_PLAYER_PING_CHART") }}</div>
              <div class="ping-panel__controls">
                <a-radio-group v-model:value="chartRangeMin" size="small" button-style="solid">
                  <a-radio-button :value="5">5m</a-radio-button>
                  <a-radio-button :value="15">15m</a-radio-button>
                  <a-radio-button :value="30">30m</a-radio-button>
                  <a-radio-button :value="60">60m</a-radio-button>
                </a-radio-group>
                <a-select
                  v-model:value="selectedPlayers"
                  mode="multiple"
                  allow-clear
                  size="small"
                  style="min-width: 180px; max-width: 280px"
                  :max-tag-count="2"
                  :placeholder="t('TXT_CODE_PLAYER_PING_SELECT')"
                  :options="onlinePlayerOptions.map((n) => ({ label: n, value: n }))"
                />
              </div>
            </div>
            <div class="ping-metrics">
              <div class="ping-metric">
                <div class="ping-metric__label">{{ t("TXT_CODE_PLAYER_PING_CURRENT") }}</div>
                <div class="ping-metric__value">{{ chartStats.current }}</div>
              </div>
              <div class="ping-metric">
                <div class="ping-metric__label">{{ t("TXT_CODE_PLAYER_PING_AVG") }}</div>
                <div class="ping-metric__value">{{ chartStats.avg }}</div>
              </div>
              <div class="ping-metric">
                <div class="ping-metric__label">{{ t("TXT_CODE_PLAYER_PING_MIN") }}</div>
                <div class="ping-metric__value">{{ chartStats.min }}</div>
              </div>
              <div class="ping-metric">
                <div class="ping-metric__label">{{ t("TXT_CODE_PLAYER_PING_MAX") }}</div>
                <div class="ping-metric__value">{{ chartStats.max }}</div>
              </div>
            </div>
            <div :id="chartDomId" class="ping-chart"></div>
            <div v-if="historyInRange.length < 2" class="ping-empty">
              {{ t("TXT_CODE_PLAYER_PING_WAIT") }}
            </div>
          </div>

          <div class="rank-panel">
            <div class="rank-panel__head">
              <div class="rank-panel__title">
                <TrophyOutlined class="mr-6" />
                {{ t("TXT_CODE_PLAYER_RANKINGS") }}
              </div>
              <a-select
                v-model:value="rankKey"
                size="small"
                style="width: 160px"
                :options="
                  rankOptions.map((o) => ({
                    value: o.value,
                    label: t(o.labelKey)
                  }))
                "
              />
            </div>
            <div v-if="!currentRanking.length" class="rank-empty">
              {{ t("TXT_CODE_PLAYER_RANK_EMPTY") }}
            </div>
            <div v-else class="rank-list">
              <div v-for="(row, idx) in currentRanking" :key="row.uuid || row.name" class="rank-row">
                <span class="rank-idx">#{{ idx + 1 }}</span>
                <a-avatar
                  class="rank-avatar"
                  :size="28"
                  :src="avatarSrc(row.uuid, row.name, 64)"
                  @error="() => onSkinError('avatar', row.uuid, row.name, 64)"
                >
                  {{ playerInitial(row.name) }}
                </a-avatar>
                <span class="rank-name" :title="row.name">{{ row.name }}</span>
                <span class="rank-val">{{ formatRankValue(rankKey, row.value) }}</span>
              </div>
            </div>
          </div>
        </div>

        <a-table
          size="middle"
          row-key="name"
          :loading="initialLoading"
          :columns="columns"
          :data-source="filteredPlayers"
          :pagination="{ pageSize: 12, showSizeChanger: false }"
          :scroll="{ x: 1200 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div class="player-cell">
                <div class="player-avatar-wrap">
                  <a-avatar
                    class="player-avatar"
                    :size="40"
                    :src="avatarSrc(record.uuid, record.name, 64)"
                    @error="() => onSkinError('avatar', record.uuid, record.name, 64)"
                  >
                    {{ playerInitial(record.name) }}
                  </a-avatar>
                  <span
                    class="online-dot"
                    :class="{
                      'online-dot--on': record.online && !record.afk,
                      'online-dot--afk': record.online && record.afk
                    }"
                  ></span>
                </div>
                <div class="player-cell__meta">
                  <a class="name-link" @click="openProfile(record)">
                    <strong>{{ record.name }}</strong>
                  </a>
                  <div v-if="record.dim" class="sub">{{ record.dim }}</div>
                </div>
              </div>
            </template>

            <template v-else-if="column.key === 'status'">
              <a-space wrap>
                <a-tag :color="record.online ? 'green' : 'default'">
                  {{ record.online ? t("TXT_CODE_PLAYER_ONLINE") : t("TXT_CODE_PLAYER_OFFLINE") }}
                </a-tag>
                <a-tag v-if="record.afk" color="orange">AFK</a-tag>
                <a-tag v-if="record.isOp" color="gold">OP</a-tag>
                <a-tag v-if="record.isWhitelisted" color="blue">WL</a-tag>
              </a-space>
            </template>

            <template v-else-if="column.key === 'ping'">
              <a-tag v-if="record.pingMs != null" :color="pingTone(record.pingMs)">
                {{ record.pingMs }} ms
              </a-tag>
              <span v-else class="muted">-</span>
            </template>

            <template v-else-if="column.key === 'playtime'">
              <div>{{ formatDuration(record.totalPlayMs) }}</div>
              <div class="sub">
                {{ t("TXT_CODE_PLAYER_SESSION") }} {{ formatDuration(record.sessionPlayMs) }}
              </div>
            </template>

            <template v-else-if="column.key === 'distance'">
              {{ formatDistance(record.distanceTotal) }}
            </template>

            <template v-else-if="column.key === 'deaths'">
              {{ record.deaths ?? 0 }}
            </template>

            <template v-else-if="column.key === 'kills'">
              <div>P {{ record.playerKills ?? 0 }}</div>
              <div class="sub">M {{ record.mobKills ?? 0 }}</div>
            </template>

            <template v-else-if="column.key === 'blocks'">
              <div>↓ {{ record.blocksBroken ?? 0 }}</div>
              <div class="sub">↑ {{ record.blocksPlaced ?? 0 }}</div>
            </template>

            <template v-else-if="column.key === 'actions'">
              <a-space wrap>
                <a-button size="small" @click="openProfile(record)">
                  {{ t("TXT_CODE_PLAYER_DETAIL") }}
                </a-button>
                <a-button
                  size="small"
                  :loading="actingKey === `${record.name}:op`"
                  :disabled="record.isOp"
                  @click="confirmAction(record, 'op', t('TXT_CODE_PLAYER_ACT_OP'))"
                >
                  OP
                </a-button>
                <a-button
                  size="small"
                  :loading="actingKey === `${record.name}:kick`"
                  :disabled="!record.online"
                  @click="kickPlayer(record)"
                >
                  {{ t("TXT_CODE_PLAYER_ACT_KICK") }}
                </a-button>
                <a-button
                  size="small"
                  danger
                  :loading="actingKey === `${record.name}:ban`"
                  @click="banPlayer(record)"
                >
                  {{ t("TXT_CODE_PLAYER_ACT_BAN") }}
                </a-button>
                <a-dropdown>
                  <template #overlay>
                    <a-menu>
                      <a-menu-item
                        @click="confirmAction(record, 'deop', t('TXT_CODE_PLAYER_ACT_DEOP'))"
                      >
                        DeOP
                      </a-menu-item>
                      <a-menu-item
                        @click="
                          confirmAction(record, 'whitelist_add', t('TXT_CODE_PLAYER_ACT_WL_ADD'))
                        "
                      >
                        {{ t("TXT_CODE_PLAYER_ACT_WL_ADD") }}
                      </a-menu-item>
                      <a-menu-item
                        @click="
                          confirmAction(
                            record,
                            'whitelist_remove',
                            t('TXT_CODE_PLAYER_ACT_WL_REMOVE')
                          )
                        "
                      >
                        {{ t("TXT_CODE_PLAYER_ACT_WL_REMOVE") }}
                      </a-menu-item>
                      <a-menu-item
                        :disabled="!record.online"
                        @click="confirmAction(record, 'kill', t('TXT_CODE_PLAYER_ACT_KILL'))"
                      >
                        {{ t("TXT_CODE_PLAYER_ACT_KILL") }}
                      </a-menu-item>
                      <a-menu-item
                        :disabled="!record.online"
                        @click="
                          confirmAction(record, 'clear_inventory', t('TXT_CODE_PLAYER_ACT_CLEAR'))
                        "
                      >
                        {{ t("TXT_CODE_PLAYER_ACT_CLEAR") }}
                      </a-menu-item>
                      <a-menu-item
                        @click="confirmAction(record, 'pardon', t('TXT_CODE_PLAYER_ACT_PARDON'))"
                      >
                        {{ t("TXT_CODE_PLAYER_ACT_PARDON") }}
                      </a-menu-item>
                    </a-menu>
                  </template>
                  <a-button size="small">{{ t("TXT_CODE_PLAYER_MORE") }}</a-button>
                </a-dropdown>
              </a-space>
            </template>
          </template>
        </a-table>

        <div class="footer-hint">
          {{ t("TXT_CODE_PLAYER_HINT") }}
          <span v-if="instanceInfo?.config?.nickname"> · {{ instanceInfo.config.nickname }}</span>
        </div>
      </template>
    </CardPanel>

    <a-drawer
      v-model:open="profileOpen"
      width="520"
      :title="`${t('TXT_CODE_PLAYER_DETAIL')} · ${profileName}`"
      :destroy-on-close="true"
    >
      <a-spin :spinning="profileLoading">
        <div class="profile">
          <div class="profile-hero">
            <div class="profile-hero__skin">
              <img
                v-if="bodySrc(profileUuid || profile?.uuid, profileName, 180)"
                class="profile-body"
                :src="bodySrc(profileUuid || profile?.uuid, profileName, 180)!"
                :alt="profileName"
                @error="() => onSkinError('body', profileUuid || profile?.uuid, profileName, 180)"
              />
              <div v-else class="profile-body profile-body--fallback">
                <a-avatar :size="96">
                  {{ playerInitial(profileName) }}
                </a-avatar>
              </div>
            </div>
            <div class="profile-hero__info">
              <div class="profile-hero__name">{{ profileName }}</div>
              <div class="profile-hero__tags">
                <a-tag :color="profileOnline ? 'green' : 'default'">
                  {{ profileOnline ? t("TXT_CODE_PLAYER_ONLINE") : t("TXT_CODE_PLAYER_OFFLINE") }}
                </a-tag>
                <a-tag v-if="profileAfk" color="orange">AFK</a-tag>
              </div>
              <div class="profile-hero__uuid muted">
                {{ profileUuid || profile?.uuid || "-" }}
              </div>
            </div>
          </div>

          <template v-if="profile">
            <a-descriptions bordered size="small" :column="1">
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_FIRST_JOIN')">
                {{ formatTime(profile.firstJoin) }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_LAST_JOIN')">
                {{ formatTime(profile.lastJoin) }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_LAST_QUIT')">
                {{ formatTime(profile.lastQuit) }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_JOIN_COUNT')">
                {{ profile.joinCount ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_COL_PLAYTIME')">
                {{ formatDuration(profile.totalPlayMs) }}
                ({{ t("TXT_CODE_PLAYER_ACTIVE") }} {{ formatDuration(profile.totalActiveMs) }} /
                AFK {{ formatDuration(profile.totalAfkMs) }})
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_COL_DISTANCE')">
                {{ formatDistance(profile.distanceTotal) }}
                <div class="sub">
                  walk {{ formatDistance(profile.distanceWalked) }} · sprint
                  {{ formatDistance(profile.distanceSprint) }} · elytra
                  {{ formatDistance(profile.distanceElytra) }} · fly
                  {{ formatDistance(profile.distanceFlown) }}
                </div>
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_COL_DEATHS')">
                {{ profile.deaths ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_COL_KILLS')">
                P {{ profile.playerKills ?? 0 }} / M {{ profile.mobKills ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_DAMAGE')">
                deal {{ profile.damageDealt ?? 0 }} / take {{ profile.damageTaken ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_COL_BLOCKS')">
                break {{ profile.blocksBroken ?? 0 }} / place {{ profile.blocksPlaced ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_ITEMS')">
                craft {{ profile.itemsCrafted ?? 0 }} / pick {{ profile.itemsPicked ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_SOCIAL')">
                chat {{ profile.chatMessages ?? 0 }} / cmd {{ profile.commandsUsed ?? 0 }} / xp
                {{ profile.xpGained ?? 0 }}
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_PING_AVG')">
                {{
                  profile.lastPingAvg != null
                    ? `${Number(profile.lastPingAvg).toFixed(0)} ms`
                    : "-"
                }}
                (max {{ profile.lastPingMax ?? "-" }})
              </a-descriptions-item>
              <a-descriptions-item :label="t('TXT_CODE_PLAYER_LAST_POS')">
                {{ profile.lastDim || "-" }}
                <span v-if="profile.lastX != null">
                  ({{ Number(profile.lastX).toFixed(1) }}, {{ Number(profile.lastY).toFixed(1) }},
                  {{ Number(profile.lastZ).toFixed(1) }})
                </span>
              </a-descriptions-item>
            </a-descriptions>

            <div class="profile-dim">
              <div class="profile-dim__title">{{ t("TXT_CODE_PLAYER_DIM_TIME") }}</div>
              <div v-if="!dimEntries.length" class="muted">-</div>
              <div v-for="d in dimEntries" :key="d.dim" class="profile-dim__row">
                <span>{{ d.dim }}</span>
                <span>{{ formatDuration(d.ms) }}</span>
              </div>
            </div>

            <div class="profile-dim">
              <div class="profile-dim__title">
                {{ t("TXT_CODE_PLAYER_MOB_BREAKDOWN") }}
                <span class="sub"> · M {{ profile.mobKills ?? 0 }}</span>
              </div>
              <div v-if="!killEntries.length" class="muted">
                {{ t("TXT_CODE_PLAYER_MOB_BREAKDOWN_EMPTY") }}
              </div>
              <div v-for="k in killEntries" :key="k.type" class="profile-dim__row" :title="k.type">
                <span>{{ k.label }}</span>
                <span>{{ k.count }}</span>
              </div>
            </div>
          </template>
          <div v-else-if="!profileLoading" class="muted profile-missing">
            {{ t("TXT_CODE_PLAYER_PROFILE_MISSING") }}
          </div>
        </div>
      </a-spin>
    </a-drawer>
  </div>
</template>

<style scoped lang="scss">
.player-monitor {
  height: 100%;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.summary {
  font-size: 12px;
  opacity: 0.85;
}
.tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.top-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 12px;
}
@media (max-width: 1100px) {
  .top-grid {
    grid-template-columns: 1fr;
  }
}
.ping-panel,
.rank-panel {
  border: 1px solid rgba(127, 127, 127, 0.16);
  border-radius: 8px;
  padding: 12px;
  background: rgba(127, 127, 127, 0.03);
}
.ping-panel__head,
.rank-panel__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 8px;
}
.ping-panel__title,
.rank-panel__title {
  font-weight: 600;
  font-size: 13px;
}
.ping-panel__controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ping-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.ping-metric {
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
}
.ping-metric__label {
  font-size: 11px;
  opacity: 0.7;
}
.ping-metric__value {
  font-size: 14px;
  font-weight: 600;
}
.ping-chart {
  width: 100%;
  height: 220px;
}
.ping-empty {
  text-align: center;
  font-size: 12px;
  opacity: 0.65;
  margin-top: -200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 280px;
  overflow: auto;
}
.rank-row {
  display: grid;
  grid-template-columns: 36px 28px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.06);
  font-size: 12px;
}
.rank-idx {
  opacity: 0.7;
}
.rank-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-avatar {
  flex-shrink: 0;
  background: rgba(127, 127, 127, 0.18);
  image-rendering: pixelated;
}
.rank-empty {
  font-size: 12px;
  opacity: 0.65;
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.player-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.player-avatar-wrap {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}
.player-avatar {
  background: rgba(127, 127, 127, 0.18);
  image-rendering: pixelated;
  border: 1px solid rgba(127, 127, 127, 0.2);
}
.online-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #9ca3af;
  border: 2px solid var(--card-bg, #fff);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.online-dot--on {
  background: #22c55e;
}
.online-dot--afk {
  background: #f59e0b;
}
.player-cell__meta {
  min-width: 0;
}
.name-link {
  cursor: pointer;
}
.sub {
  font-size: 11px;
  opacity: 0.65;
}
.muted {
  opacity: 0.55;
}
.footer-hint {
  margin-top: 10px;
  font-size: 12px;
  opacity: 0.7;
}
.mb-12 {
  margin-bottom: 12px;
}
.mr-6 {
  margin-right: 6px;
}
.mr-8 {
  margin-right: 8px;
}
.profile-hero {
  display: flex;
  gap: 16px;
  align-items: flex-end;
  margin-bottom: 16px;
  padding: 14px;
  border-radius: 12px;
  background:
    linear-gradient(135deg, rgba(59, 130, 246, 0.14), rgba(168, 85, 247, 0.1)),
    rgba(127, 127, 127, 0.05);
  border: 1px solid rgba(127, 127, 127, 0.12);
}
.profile-hero__skin {
  flex-shrink: 0;
  width: 110px;
  min-height: 180px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.profile-body {
  width: 100px;
  height: auto;
  image-rendering: pixelated;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.28));
}
.profile-body--fallback {
  width: 110px;
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.profile-hero__info {
  min-width: 0;
  padding-bottom: 10px;
}
.profile-hero__name {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
  margin-bottom: 8px;
  word-break: break-all;
}
.profile-hero__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.profile-hero__uuid {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}
.profile-missing {
  margin-top: 8px;
}
.profile-dim {
  margin-top: 16px;
}
.profile-dim__title {
  font-weight: 600;
  margin-bottom: 8px;
}
.profile-dim__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed rgba(127, 127, 127, 0.2);
}
</style>
