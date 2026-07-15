<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import {
  getGlobalLeaderboard,
  type LeaderboardMetric,
  type LeaderboardRow,
  type LeaderboardSummary
} from "@/services/apis/playerLeaderboard";
import { skinUrl } from "@/tools/minecraftSkin";
import { reportErrorMsg } from "@/tools/validator";
import { ReloadOutlined, TrophyOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref, watch } from "vue";

defineProps<{ card: LayoutCard }>();

const loading = ref(false);
const data = ref<LeaderboardSummary | null>(null);
const metric = ref<LeaderboardMetric>("playtime");
const serverKey = ref<string>("all");
const limit = ref(50);

const { execute: fetchBoard } = getGlobalLeaderboard();

const metrics: Array<{ key: LeaderboardMetric; label: string }> = [
  { key: "playtime", label: t("TXT_CODE_PLAYER_RANK_PLAYTIME") },
  { key: "activePlaytime", label: t("TXT_CODE_PLAYER_RANK_ACTIVE") },
  { key: "mobKills", label: t("TXT_CODE_PLAYER_RANK_MKILLS") },
  { key: "playerKills", label: t("TXT_CODE_PLAYER_RANK_PKILLS") },
  { key: "blocksBroken", label: t("TXT_CODE_PLAYER_RANK_BROKEN") },
  { key: "blocksPlaced", label: t("TXT_CODE_PLAYER_RANK_PLACED") },
  { key: "distance", label: t("TXT_CODE_PLAYER_RANK_DISTANCE") },
  { key: "deaths", label: t("TXT_CODE_PLAYER_RANK_DEATHS") },
  { key: "xpGained", label: t("TXT_CODE_PLAYER_RANK_XP") }
];

const serverOptions = computed(() => {
  const list = data.value?.servers || [];
  return [
    { value: "all", label: t("TXT_CODE_PLAYER_LB_ALL_SERVERS") },
    ...list.map((s) => ({
      value: `${s.daemonId}::${s.instanceUuid}`,
      label: `${s.nickname} (${s.playerCount})`
    }))
  ];
});

const formatDuration = (ms?: number) => {
  const v = Number(ms || 0);
  if (v <= 0) return "0m";
  const sec = Math.floor(v / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const formatDist = (n?: number) => {
  const v = Number(n || 0);
  if (v >= 1000) return `${(v / 1000).toFixed(2)} km`;
  return `${Math.round(v)} m`;
};

const formatValue = (row: LeaderboardRow, m: LeaderboardMetric) => {
  if (m === "playtime" || m === "activePlaytime") return formatDuration(row.value);
  if (m === "distance") return formatDist(row.value);
  return String(row.value ?? 0);
};

const avatarOf = (uuid?: string, name?: string) => skinUrl("avatar", uuid || name || "", 72);

const podium = computed(() => (data.value?.rows || []).slice(0, 3));
const rest = computed(() => (data.value?.rows || []).slice(3));

const refresh = async () => {
  loading.value = true;
  try {
    const params: Record<string, any> = {
      metric: metric.value,
      limit: limit.value
    };
    if (serverKey.value && serverKey.value !== "all") {
      const [daemonId, instanceUuid] = serverKey.value.split("::");
      params.daemonId = daemonId;
      params.instanceUuid = instanceUuid;
    }
    const res = await fetchBoard({ params, forceRequest: true });
    data.value = res.value || null;
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    loading.value = false;
  }
};

watch([metric, serverKey], () => {
  refresh();
});

onMounted(refresh);
</script>

<template>
  <div class="lb">
    <section class="hero launcher-enter">
      <div class="hero-bg" aria-hidden="true">
        <div class="hero-grid"></div>
        <div class="hero-glow"></div>
        <div class="hero-vignette"></div>
      </div>
      <div class="hero-inner">
        <div class="hero-icon"><TrophyOutlined /></div>
        <div class="hero-copy">
          <div class="kicker">
            <span class="kicker-dot"></span>
            {{ t("TXT_CODE_PLAYER_LB_NAV") }}
          </div>
          <h1 class="title">{{ card.title || t("TXT_CODE_PLAYER_LB_TITLE") }}</h1>
          <p class="sub">{{ t("TXT_CODE_PLAYER_LB_SUB") }}</p>
        </div>
        <div class="hero-stats" v-if="data">
          <div class="hs">
            <div class="hs-label">{{ t("TXT_CODE_PLAYER_LB_PLAYERS") }}</div>
            <div class="hs-value">{{ data.totalPlayers }}</div>
          </div>
          <div class="hs">
            <div class="hs-label">{{ t("TXT_CODE_PLAYER_LB_SERVERS") }}</div>
            <div class="hs-value">{{ data.servers?.length || 0 }}</div>
          </div>
        </div>
      </div>
    </section>

    <CardPanel class="board-card launcher-enter delay-1" :full-height="false">
      <template #title>
        <span class="panel-title">{{ t("TXT_CODE_PLAYER_RANKINGS") }}</span>
      </template>
      <template #operator>
        <a-button size="middle" type="text" class="refresh-btn" :loading="loading" @click="refresh">
          <ReloadOutlined />
          {{ t("TXT_CODE_PLAYER_REFRESH") }}
        </a-button>
      </template>
      <template #body>
        <div class="filters">
          <div class="filter-group">
            <div class="filter-label">{{ t("TXT_CODE_PLAYER_LB_METRIC") }}</div>
            <div class="metric-chips">
              <button
                v-for="m in metrics"
                :key="m.key"
                type="button"
                class="metric-chip"
                :class="{ active: metric === m.key }"
                @click="metric = m.key"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
          <div class="filter-side">
            <div class="filter-label">{{ t("TXT_CODE_PLAYER_LB_SCOPE") }}</div>
            <a-select
              v-model:value="serverKey"
              size="large"
              class="server-select"
              :options="serverOptions"
            />
          </div>
        </div>

        <a-spin :spinning="loading">
          <a-empty
            v-if="!loading && !(data?.rows?.length)"
            :description="t('TXT_CODE_PLAYER_RANK_EMPTY')"
            class="empty"
          />

          <template v-else>
            <div v-if="podium.length" class="podium">
              <div
                v-for="(row, idx) in [podium[1], podium[0], podium[2]].filter(Boolean)"
                :key="row.uuid + row.rank"
                class="podium-card"
                :class="`place-${row.rank}`"
              >
                <div class="place-badge">#{{ row.rank }}</div>
                <img class="avatar" :src="avatarOf(row.uuid, row.name)" alt="" />
                <div class="p-name">{{ row.name }}</div>
                <div class="p-value">{{ formatValue(row, metric) }}</div>
                <div class="p-servers" v-if="row.servers?.length">
                  {{ row.servers.slice(0, 2).join(" · ") }}
                </div>
              </div>
            </div>

            <div v-if="rest.length" class="table-wrap">
              <div class="table-head">
                <span class="c-rank">#</span>
                <span class="c-player">{{ t("TXT_CODE_PLAYER_COL_NAME") }}</span>
                <span class="c-value">{{ metrics.find((m) => m.key === metric)?.label }}</span>
                <span class="c-extra">{{ t("TXT_CODE_PLAYER_STAT_PLAY") }}</span>
                <span class="c-servers">{{ t("TXT_CODE_PLAYER_SERVERS_SECTION") }}</span>
              </div>
              <div
                v-for="row in rest"
                :key="row.uuid + '-' + row.rank"
                class="table-row launcher-enter"
              >
                <span class="c-rank">{{ row.rank }}</span>
                <span class="c-player">
                  <img class="row-avatar" :src="avatarOf(row.uuid, row.name)" alt="" />
                  <span class="row-name">{{ row.name }}</span>
                </span>
                <span class="c-value">{{ formatValue(row, metric) }}</span>
                <span class="c-extra">{{ formatDuration(row.totalPlayMs) }}</span>
                <span class="c-servers">{{ (row.servers || []).slice(0, 3).join(" · ") || "-" }}</span>
              </div>
            </div>
          </template>
        </a-spin>
      </template>
    </CardPanel>
  </div>
</template>

<style scoped lang="scss">
.lb {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.hero {
  position: relative;
  overflow: hidden;
  min-height: 180px;
  border-radius: 18px;
  border: 1px solid var(--card-border-color);
  background: var(--background-color-white);
  box-shadow:
    0 14px 36px rgba(0, 0, 0, 0.16),
    0 1px 2px 1px var(--card-shadow-color);
}
.hero::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: linear-gradient(
    180deg,
    var(--color-primary),
    color-mix(in srgb, var(--color-primary) 30%, transparent)
  );
  z-index: 2;
}
.hero-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hero-grid {
  position: absolute;
  inset: 0;
  opacity: 0.32;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.07) 1px, transparent 1px);
  background-size: 24px 24px;
  mask-image: radial-gradient(ellipse 90% 100% at 18% 50%, #000 35%, transparent 82%);
}
.app-light-theme .hero-grid {
  opacity: 0.35;
  background-image:
    linear-gradient(rgba(0, 0, 0, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 0, 0, 0.04) 1px, transparent 1px);
}
.hero-glow {
  position: absolute;
  width: 70%;
  height: 160%;
  left: -12%;
  top: -30%;
  background:
    radial-gradient(
      circle at 30% 40%,
      color-mix(in srgb, var(--color-primary) 48%, transparent),
      transparent 60%
    ),
    radial-gradient(
      circle at 68% 72%,
      color-mix(in srgb, var(--color-blue-4) 26%, transparent),
      transparent 55%
    );
}
.hero-vignette {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    105deg,
    color-mix(in srgb, var(--background-color-white) 18%, transparent) 0%,
    color-mix(in srgb, var(--background-color-white) 72%, transparent) 48%,
    var(--background-color-white) 100%
  );
}
.hero-inner {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 20px;
  min-height: 180px;
  padding: 28px 32px;
}
.hero-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  font-size: 28px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 14%, var(--color-gray-2));
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-gray-5));
  flex: 0 0 auto;
}
.hero-copy {
  min-width: 0;
  flex: 1;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-gray-7);
  margin-bottom: 8px;
}
.kicker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary) 22%, transparent);
}
.title {
  margin: 0;
  font-size: clamp(26px, 3vw, 36px);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-color);
  line-height: 1.15;
}
.sub {
  margin: 10px 0 0;
  max-width: 48ch;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-gray-7);
}
.hero-stats {
  display: flex;
  gap: 12px;
  flex: 0 0 auto;
}
.hs {
  min-width: 92px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--color-gray-2);
  border: 1px solid var(--color-gray-5);
}
.hs-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-gray-7);
}
.hs-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-color);
}

.board-card {
  border-radius: 16px;
  overflow: hidden;
}
.panel-title {
  font-size: 16px;
  font-weight: 800;
}
.refresh-btn {
  font-weight: 600;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 18px 24px;
  justify-content: space-between;
  margin-bottom: 18px;
}
.filter-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-gray-7);
  margin-bottom: 8px;
}
.metric-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.metric-chip {
  border: 1px solid var(--color-gray-5);
  background: var(--color-gray-2);
  color: var(--text-color);
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.metric-chip:hover {
  transform: translateY(-1px);
  border-color: var(--color-gray-7);
}
.metric-chip.active {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-gray-5));
  background: color-mix(in srgb, var(--color-primary) 16%, var(--color-gray-1));
  color: var(--color-primary);
}
.server-select {
  min-width: 220px;
}

.podium {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 20px;
  align-items: end;
  justify-items: stretch;
}
.podium:has(.podium-card:only-child) {
  grid-template-columns: minmax(220px, 360px);
  justify-content: center;
}
.podium:has(.podium-card:only-child) .podium-card {
  order: initial;
}
.podium-card {
  border-radius: 16px;
  border: 1px solid var(--color-gray-5);
  background: var(--color-gray-2);
  padding: 18px 14px 16px;
  text-align: center;
  position: relative;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}
.podium-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.12);
}
.podium-card.place-1 {
  padding-top: 28px;
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-gray-5));
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-gray-2));
  order: 2;
}
.podium-card.place-2 {
  order: 1;
}
.podium-card.place-3 {
  order: 3;
}
.place-badge {
  position: absolute;
  top: 10px;
  left: 12px;
  font-size: 12px;
  font-weight: 800;
  color: var(--color-gray-7);
}
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  image-rendering: pixelated;
  border: 1px solid var(--color-gray-5);
  background: #111;
  object-fit: cover;
}
.p-name {
  margin-top: 10px;
  font-size: 15px;
  font-weight: 800;
  color: var(--text-color);
}
.p-value {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-color);
}
.p-servers {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-gray-7);
}

.table-wrap {
  border-radius: 14px;
  border: 1px solid var(--color-gray-5);
  overflow: hidden;
}
.table-head,
.table-row {
  display: grid;
  grid-template-columns: 56px minmax(140px, 1.4fr) minmax(90px, 0.8fr) minmax(90px, 0.8fr) minmax(
      120px,
      1.2fr
    );
  gap: 8px;
  align-items: center;
  padding: 12px 14px;
}
.table-head {
  background: var(--color-gray-3);
  font-size: 12px;
  font-weight: 700;
  color: var(--color-gray-7);
}
.table-row {
  border-top: 1px solid var(--color-gray-4);
  background: var(--background-color-white);
  transition: background 0.15s ease;
}
.table-row:hover {
  background: var(--color-gray-2);
}
.c-rank {
  font-weight: 800;
  color: var(--color-gray-7);
}
.c-player {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.row-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  image-rendering: pixelated;
  border: 1px solid var(--color-gray-5);
  background: #111;
  flex: 0 0 auto;
}
.row-name {
  font-weight: 700;
  color: var(--text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-value {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--text-color);
}
.c-extra,
.c-servers {
  font-size: 12px;
  color: var(--color-gray-7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table-hint {
  padding: 14px;
  text-align: center;
  color: var(--color-gray-7);
  font-size: 12px;
}
.empty {
  padding: 36px 12px;
}

.launcher-enter {
  animation: rise-in 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.delay-1 {
  animation-delay: 0.08s;
}

@keyframes rise-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 900px) {
  .podium {
    grid-template-columns: 1fr;
  }
  .podium-card.place-1,
  .podium-card.place-2,
  .podium-card.place-3 {
    order: initial;
  }
  .table-head,
  .table-row {
    grid-template-columns: 40px minmax(0, 1fr) auto;
  }
  .c-extra,
  .c-servers,
  .table-head .c-extra,
  .table-head .c-servers {
    display: none;
  }
  .hero-inner {
    flex-wrap: wrap;
    padding: 22px 18px;
  }
  .hero-stats {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .launcher-enter,
  .metric-chip,
  .podium-card,
  .table-row {
    animation: none !important;
    transition: none !important;
  }
}
</style>
