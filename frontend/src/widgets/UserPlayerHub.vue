<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import {
  bindMinecraftName,
  getPlayerHubProfiles,
  unbindMinecraftName,
  type PlayerHubSummary,
  type ServerPlayerCard
} from "@/services/apis/playerHub";
import { skinUrl } from "@/tools/minecraftSkin";
import { reportErrorMsg } from "@/tools/validator";
import { message, Modal } from "ant-design-vue";
import { ReloadOutlined, UserOutlined } from "@ant-design/icons-vue";
import { computed, onMounted, ref } from "vue";

defineProps<{ card: LayoutCard }>();

const loading = ref(false);
const binding = ref(false);
const mcNameInput = ref("");
const hub = ref<PlayerHubSummary | null>(null);

const { execute: fetchProfiles } = getPlayerHubProfiles();
const { execute: execBind } = bindMinecraftName();
const { execute: execUnbind } = unbindMinecraftName();

const identity = computed(() => hub.value?.identity || null);
const servers = computed(() => hub.value?.servers || []);
const totals = computed(() => hub.value?.totals);

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

const avatarOf = (uuid?: string, name?: string) => skinUrl("avatar", uuid || name || "", 96);
const bodyOf = (uuid?: string, name?: string) => skinUrl("body", uuid || name || "", 180);

const kpiItems = computed(() => {
  if (!identity.value || !totals.value) return [];
  return [
    { label: t("TXT_CODE_PLAYER_STAT_PLAY"), value: formatDuration(totals.value.totalPlayMs) },
    { label: t("TXT_CODE_PLAYER_STAT_MOB"), value: String(totals.value.totalMobKills ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_BREAK"), value: String(totals.value.totalBlocksBroken ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_DIST"), value: formatDist(totals.value.totalDistance) }
  ];
});

const refresh = async () => {
  loading.value = true;
  try {
    const res = await fetchProfiles({ forceRequest: true });
    hub.value = res.value || null;
    if (hub.value?.identity?.mcName) mcNameInput.value = hub.value.identity.mcName;
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    loading.value = false;
  }
};

const onBind = async () => {
  if (!mcNameInput.value.trim()) {
    return message.warning(t("TXT_CODE_PLAYER_BIND_NEED_NAME"));
  }
  binding.value = true;
  try {
    await execBind({ data: { mcName: mcNameInput.value.trim() } });
    message.success(t("TXT_CODE_PLAYER_BIND_OK"));
    await refresh();
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    binding.value = false;
  }
};

const onUnbind = () => {
  Modal.confirm({
    title: t("TXT_CODE_PLAYER_UNBIND_TITLE"),
    content: t("TXT_CODE_PLAYER_UNBIND_HINT"),
    okType: "danger",
    onOk: async () => {
      await execUnbind();
      message.success(t("TXT_CODE_PLAYER_UNBIND_OK"));
      await refresh();
    }
  });
};

const profileStats = (row: ServerPlayerCard) => {
  const p = row.profile;
  if (!p) return [];
  return [
    { label: t("TXT_CODE_PLAYER_STAT_PLAY"), value: formatDuration(p.totalPlayMs) },
    { label: t("TXT_CODE_PLAYER_STAT_DEATHS"), value: String(p.deaths ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_MOB"), value: String(p.mobKills ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_BREAK"), value: String(p.blocksBroken ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_PLACE"), value: String(p.blocksPlaced ?? 0) },
    { label: t("TXT_CODE_PLAYER_STAT_DIST"), value: formatDist(p.distanceTotal) }
  ];
};

onMounted(refresh);
</script>

<template>
  <div class="hub">
    <CardPanel class="hub-card launcher-enter delay-1" :full-height="false">
      <template #title>
        <span class="panel-title">{{ card.title || t("TXT_CODE_PLAYER_HUB_TITLE") }}</span>
      </template>
      <template #operator>
        <a-button size="middle" type="text" class="refresh-btn" :loading="loading" @click="refresh">
          <ReloadOutlined />
          {{ t("TXT_CODE_PLAYER_REFRESH") }}
        </a-button>
      </template>
      <template #body>
        <a-spin :spinning="loading">
          <div class="bind-row">
            <div class="who" v-if="identity">
              <img class="avatar" :src="avatarOf(identity.mcUuid, identity.mcName)" alt="" />
              <div class="who-text">
                <div class="name">{{ identity.mcName }}</div>
                <div class="meta">
                  <span class="mono">{{ identity.mcUuid }}</span>
                  <span class="sep">·</span>
                  <span>
                    {{ t("TXT_CODE_PLAYER_BOUND_AT") }}
                    {{ identity.bindAt ? new Date(identity.bindAt).toLocaleString() : "-" }}
                  </span>
                </div>
              </div>
            </div>
            <div class="who" v-else>
              <div class="avatar avatar-empty"><UserOutlined /></div>
              <div class="who-text">
                <div class="name">{{ t("TXT_CODE_PLAYER_BIND_HINT") }}</div>
                <div class="meta">{{ t("TXT_CODE_PLAYER_NAME_PH") }}</div>
              </div>
            </div>

            <div class="actions">
              <a-input
                v-model:value="mcNameInput"
                size="large"
                :placeholder="t('TXT_CODE_PLAYER_NAME_PH')"
                allow-clear
                class="name-input"
                @pressEnter="onBind"
              />
              <a-button type="primary" size="large" :loading="binding" @click="onBind">
                {{ identity ? t("TXT_CODE_PLAYER_REBIND") : t("TXT_CODE_PLAYER_BIND") }}
              </a-button>
              <a-button v-if="identity" size="large" danger ghost @click="onUnbind">
                {{ t("TXT_CODE_PLAYER_UNBIND") }}
              </a-button>
            </div>
          </div>

          <div v-if="kpiItems.length" class="kpi-grid">
            <div
              v-for="(item, idx) in kpiItems"
              :key="item.label"
              class="kpi"
              :style="{ animationDelay: `${0.08 + idx * 0.05}s` }"
            >
              <div class="kpi-label">{{ item.label }}</div>
              <div class="kpi-value">{{ item.value }}</div>
            </div>
          </div>

          <div v-if="hub?.activity" class="activity">
            <div class="section-title">{{ t("TXT_CODE_PLAYER_ACTIVITY_TITLE") }}</div>
            <div class="chips">
              <span class="chip chip-accent">
                {{ t("TXT_CODE_PLAYER_POINTS") }} {{ hub.activity.points }}
              </span>
              <span
                v-for="f in hub.activity.features"
                :key="f.id"
                class="chip"
                :class="{ on: f.enabled }"
              >
                {{ f.title }} · {{ f.enabled ? t("TXT_CODE_PLAYER_ON") : t("TXT_CODE_PLAYER_SOON") }}
              </span>
            </div>
          </div>
        </a-spin>
      </template>
    </CardPanel>

    <div class="servers-head launcher-enter delay-2">
      <div class="section-title large">{{ t("TXT_CODE_PLAYER_SERVERS_SECTION") }}</div>
      <div class="section-sub">{{ servers.length }} servers</div>
    </div>

    <a-empty
      v-if="identity && !servers.length && !loading"
      :description="t('TXT_CODE_PLAYER_NO_SERVER_DATA')"
      class="empty launcher-enter delay-2"
    />

    <div v-else-if="servers.length" class="server-grid">
      <CardPanel
        v-for="(row, idx) in servers"
        :key="row.daemonId + row.instanceUuid"
        class="server-card launcher-enter"
        :class="`delay-${Math.min(idx + 2, 5)}`"
        :full-height="false"
      >
        <template #body>
          <div class="server-top">
            <div class="body-wrap">
              <img
                class="body"
                :src="
                  bodyOf(
                    row.profile?.uuid || identity?.mcUuid,
                    row.profile?.name || identity?.mcName
                  )
                "
                alt=""
              />
            </div>
            <div class="server-info">
              <div class="server-name">{{ row.nickname }}</div>
              <div class="server-sub">
                {{ row.profile?.name || identity?.mcName || "-" }}
                <span class="tag">{{ row.matchedBy === "uuid" ? "UUID" : "Name" }}</span>
              </div>
            </div>
          </div>
          <div class="stat-grid">
            <div v-for="s in profileStats(row)" :key="s.label" class="stat">
              <div class="stat-label">{{ s.label }}</div>
              <div class="stat-value">{{ s.value }}</div>
            </div>
          </div>
        </template>
      </CardPanel>
    </div>
  </div>
</template>

<style scoped lang="scss">
.hub {
  display: flex;
  flex-direction: column;
  gap: 22px;
}
/* Ant Design inserts letter-spacing for exactly 2 Chinese chars ("解绑") */
.hub :deep(.ant-btn-two-chinese-chars > *:not(.anticon)) {
  letter-spacing: 0 !important;
  margin-right: 0 !important;
}

.hub-card,
.server-card {
  border-radius: 16px;
  overflow: hidden;
}

.panel-title {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.refresh-btn {
  font-weight: 600;
}

.bind-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px 20px;
  padding: 4px 0 18px;
  border-bottom: 1px solid var(--color-gray-4);
}

.who {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.avatar {
  width: 64px;
  height: 64px;
  border-radius: 16px;
  image-rendering: pixelated;
  background: #111;
  border: 1px solid var(--color-gray-5);
  object-fit: cover;
  flex: 0 0 auto;
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.14);
}

.avatar-empty {
  display: grid;
  place-items: center;
  color: var(--color-gray-7);
  background: var(--color-gray-3);
  font-size: 22px;
}

.who-text {
  min-width: 0;
}

.name {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text-color);
}

.meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-gray-7);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.sep {
  opacity: 0.45;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  margin-left: auto;
}

.name-input {
  width: min(240px, 58vw);
}

.actions :deep(.ant-btn) {
  white-space: nowrap !important;
  font-weight: 700;
  border-radius: 10px;
  flex: 0 0 auto;
  letter-spacing: 0 !important;
}
.actions :deep(.ant-btn > span) {
  white-space: nowrap !important;
  letter-spacing: 0 !important;
  margin-right: 0 !important;
}
.actions :deep(.ant-btn-two-chinese-chars > *:not(.anticon)) {
  letter-spacing: 0 !important;
  margin-right: 0 !important;
}

.actions :deep(.ant-input-affix-wrapper),
.actions :deep(.ant-input) {
  border-radius: 10px;
}

.kpi-grid {
  margin-top: 20px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.kpi {
  border-radius: 14px;
  background: var(--color-gray-2);
  border: 1px solid var(--color-gray-5);
  padding: 18px 16px 16px;
  min-height: 104px;
  animation: rise-in 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
}

.kpi:hover {
  transform: translateY(-3px);
  border-color: var(--color-gray-6);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.1);
}

.kpi-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-gray-7);
}

.kpi-value {
  margin-top: 12px;
  font-size: clamp(26px, 2.4vw, 34px);
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-color);
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
}

.activity {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--color-gray-4);
}

.section-title {
  font-size: 14px;
  font-weight: 800;
  color: var(--text-color);
  margin-bottom: 10px;
}

.section-title.large {
  font-size: 18px;
  margin-bottom: 0;
  letter-spacing: -0.02em;
}

.servers-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px 0;
}

.section-sub {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-gray-7);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 7px 12px;
  border-radius: 999px;
  border: 1px solid var(--color-gray-5);
  background: var(--color-gray-2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-color);
  transition:
    border-color 0.15s ease,
    transform 0.15s ease,
    background 0.15s ease;
}

.chip:hover {
  transform: translateY(-1px);
  border-color: var(--color-gray-7);
}

.chip-accent {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--color-gray-5));
  background: color-mix(in srgb, var(--color-primary) 14%, var(--color-gray-1));
  color: var(--color-primary);
}

.chip.on {
  border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-gray-5));
  background: color-mix(in srgb, var(--color-success) 12%, var(--color-gray-1));
  color: var(--color-success);
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 18px;
}

.server-card {
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.server-card:hover {
  transform: translateY(-4px);
  box-shadow:
    0 14px 28px rgba(0, 0, 0, 0.14),
    0 1px 2px 1px var(--card-shadow-color);
}

.server-top {
  display: flex;
  gap: 14px;
  align-items: center;
  margin-bottom: 16px;
}

.body-wrap {
  width: 56px;
  height: 96px;
  display: grid;
  place-items: end center;
  flex: 0 0 auto;
  border-radius: 12px;
  background:
    radial-gradient(ellipse at bottom, color-mix(in srgb, var(--color-primary) 14%, transparent), transparent 70%),
    var(--color-gray-2);
  border: 1px solid var(--color-gray-5);
}

.body {
  width: 42px;
  height: 88px;
  object-fit: contain;
  image-rendering: pixelated;
}

.server-name {
  font-size: 17px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text-color);
}

.server-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-gray-7);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tag {
  display: inline-flex;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-gray-5);
  background: var(--color-gray-3);
  font-size: 11px;
  font-weight: 800;
  color: var(--color-gray-8);
}

.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.stat {
  border-radius: 12px;
  background: var(--color-gray-2);
  border: 1px solid var(--color-gray-5);
  padding: 12px 12px 10px;
  min-height: 68px;
}

.stat-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-gray-7);
}

.stat-value {
  margin-top: 6px;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text-color);
  font-variant-numeric: tabular-nums;
}

.empty {
  padding: 40px 12px;
  border-radius: 16px;
  background: var(--background-color-white);
  box-shadow: 0 1px 2px 1px var(--card-shadow-color);
}

.launcher-enter {
  animation: rise-in 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.delay-1 {
  animation-delay: 0.08s;
}
.delay-2 {
  animation-delay: 0.14s;
}
.delay-3 {
  animation-delay: 0.2s;
}
.delay-4 {
  animation-delay: 0.26s;
}
.delay-5 {
  animation-delay: 0.32s;
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

@media (prefers-reduced-motion: reduce) {
  .kpi,
  .server-card,
  .chip,
  .launcher-enter {
    animation: none !important;
    transition: none !important;
  }
  .kpi:hover,
  .server-card:hover,
  .chip:hover {
    transform: none;
  }
}

@media (max-width: 960px) {
  .kpi-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .actions {
    width: 100%;
    justify-content: stretch;
  }
  .name-input {
    flex: 1 1 100%;
    width: 100%;
  }
  .actions :deep(.ant-btn) {
    flex: 1 1 auto;
  }
  .avatar {
    width: 52px;
    height: 52px;
  }
  .name {
    font-size: 17px;
  }
  .kpi {
    min-height: 92px;
    padding: 14px 12px 12px;
  }
  .kpi-value {
    font-size: 24px;
  }
}
</style>
