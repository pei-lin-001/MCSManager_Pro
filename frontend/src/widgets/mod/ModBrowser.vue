<script setup lang="ts">
import { useSelectInstances } from "@/components/fc";
import { t } from "@/lang/i18n";
import {
  downloadModApi,
  getMcVersionsApi,
  getModVersionsApi,
  modListApi,
  searchModsApi
} from "@/services/apis/modManager";
import { reportErrorMsg } from "@/tools/validator";
import type { LayoutCard } from "@/types";
import type { UserInstance } from "@/types/user";
import {
  AppstoreOutlined,
  CloudDownloadOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onMounted, ref } from "vue";
import AiAssistantDrawer from "@/widgets/instance/dialogs/AiAssistantDrawer.vue";
import ModVersionModal from "@/widgets/instance/mod-manager/ModVersionModal.vue";

defineProps<{
  card: LayoutCard;
}>();

interface SearchModItem {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  icon_url?: string;
  source?: string;
  project_type?: string;
  version_number?: string;
  updated?: string;
  loaders?: string[];
  game_versions?: string[];
}

const query = ref("");
const source = ref("all");
const mcVersion = ref("");
const loader = ref("all");
const projectType = ref("all");
const page = ref(1);
const pageSize = ref(12);
const total = ref(0);
const loading = ref(false);
const searched = ref(false);
const results = ref<SearchModItem[]>([]);
const mcVersions = ref<string[]>([]);

const selectedInstance = ref<UserInstance | null>(null);
const selectedMod = ref<SearchModItem | null>(null);
const versions = ref<Record<string, unknown>[]>([]);
const versionsLoading = ref(false);
const showVersionModal = ref(false);
const targetFolders = ref<string[]>([]);
const installedMods = ref<Array<{ file?: string; extraInfo?: { project?: { id?: string } } }>>([]);
const aiDrawerOpen = ref(false);




const sourceOptions = [
  { label: t("TXT_CODE_MOD_SOURCE_ALL"), value: "all" },
  { label: "Modrinth", value: "Modrinth" },
  { label: "CurseForge", value: "CurseForge" },
  { label: "SpigotMC", value: "SpigotMC" }
];

const loaderOptions = computed(() => [
  { label: t("TXT_CODE_MOD_LOADER_ALL"), value: "all" },
  { label: "Fabric", value: "fabric" },
  { label: "Forge", value: "forge" },
  { label: "NeoForge", value: "neoforge" },
  { label: "Quilt", value: "quilt" },
  { label: "Paper/Spigot", value: "paper" },
  { label: "Velocity", value: "velocity" }
]);

const typeOptions = [
  { label: t("TXT_CODE_MOD_TYPE_ALL"), value: "all" },
  { label: t("TXT_CODE_MOD"), value: "mod" },
  { label: t("TXT_CODE_PLUGIN"), value: "plugin" }
];

const searchFilters = computed(() => ({
  version: mcVersion.value,
  loader: loader.value === "all" ? "" : loader.value
}));

const columns = computed(() => [
  { title: "", key: "icon", width: 56 },
  { title: t("TXT_CODE_MOD_NAME"), key: "name" },
  { title: t("TXT_CODE_MOD_SOURCE"), key: "source", width: 110 },
  { title: t("TXT_CODE_MOD_TYPE"), key: "type", width: 100 },
  { title: t("TXT_CODE_65b21404"), key: "action", width: 140 }
]);

const loadMcVersions = async () => {
  try {
    const { execute } = getMcVersionsApi();
    const res = await execute();
    mcVersions.value = res.value || [];
  } catch (error: unknown) {
    reportErrorMsg(error);
  }
};

const refreshTargetMods = async () => {
  if (!selectedInstance.value) {
    installedMods.value = [];
    targetFolders.value = [];
    return;
  }
  try {
    const { execute } = modListApi();
    const res = await execute({
      params: {
        uuid: selectedInstance.value.instanceUuid,
        daemonId: selectedInstance.value.daemonId,
        page: 1,
        pageSize: 200
      }
    });
    installedMods.value = (res.value as { mods?: typeof installedMods.value })?.mods || [];
    targetFolders.value = (res.value as { folders?: string[] })?.folders || [];
  } catch {
    installedMods.value = [];
    targetFolders.value = [];
  }
};

const selectTargetInstance = async () => {
  try {
    const selected = await useSelectInstances(
      selectedInstance.value ? [selectedInstance.value] : []
    );
    if (!selected || selected.length === 0) return;
    selectedInstance.value = selected[0];
    await refreshTargetMods();
    message.success(
      t("TXT_CODE_MOD_BROWSER_TARGET_SET", {
        name: selectedInstance.value.nickname || selectedInstance.value.instanceUuid
      })
    );
  } catch (error: unknown) {
    reportErrorMsg(error);
  }
};

const openAiAssistant = async () => {
  if (!selectedInstance.value) {
    message.warning(t("TXT_CODE_MOD_BROWSER_NEED_INSTANCE"));
    await selectTargetInstance();
    if (!selectedInstance.value) return;
  }
  aiDrawerOpen.value = true;
};


const onSearch = async (nextPage = 1) => {
  loading.value = true;
  searched.value = true;
  page.value = nextPage;
  try {
    const { execute } = searchModsApi();
    const res = await execute({
      params: {
        query: query.value.trim(),
        source: source.value,
        version: mcVersion.value,
        type: projectType.value,
        loader: loader.value,
        environment: "all",
        offset: (nextPage - 1) * pageSize.value,
        limit: pageSize.value
      }
    });
    const data = res.value as { hits?: SearchModItem[]; total_hits?: number } | SearchModItem[];
    if (Array.isArray(data)) {
      results.value = data;
      total.value = data.length;
    } else {
      results.value = data?.hits || [];
      total.value = data?.total_hits || 0;
    }
  } catch (error: unknown) {
    reportErrorMsg(error);
    results.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
};

const openVersions = async (mod: SearchModItem) => {
  if (!selectedInstance.value) {
    message.warning(t("TXT_CODE_MOD_BROWSER_NEED_INSTANCE"));
    await selectTargetInstance();
    if (!selectedInstance.value) return;
  }
  selectedMod.value = mod;
  showVersionModal.value = true;
  versionsLoading.value = true;
  versions.value = [];
  try {
    const { execute } = getModVersionsApi();
    const res = await execute({
      params: {
        projectId: mod.id,
        source: mod.source || "Modrinth"
      }
    });
    versions.value = (res.value || []) as Record<string, unknown>[];
  } catch (error: unknown) {
    reportErrorMsg(error);
  } finally {
    versionsLoading.value = false;
  }
};

const detectProjectType = (version: {
  project_type?: string;
  loaders?: string[];
}): "mod" | "plugin" => {
  const pluginLoaders = [
    "spigot",
    "paper",
    "purpur",
    "folia",
    "bungeecord",
    "velocity",
    "waterfall"
  ];
  if (selectedMod.value?.source === "SpigotMC") return "plugin";
  if (version.loaders?.some((l) => pluginLoaders.includes(String(l).toLowerCase()))) {
    return "plugin";
  }
  const raw = version.project_type || selectedMod.value?.project_type || "mod";
  return raw === "plugin" ? "plugin" : "mod";
};

const resolveSaveType = (detected: "mod" | "plugin"): "mod" | "plugin" => {
  const hasMods = targetFolders.value.includes("mods");
  const hasPlugins = targetFolders.value.includes("plugins");
  if (hasMods && !hasPlugins) return "mod";
  if (hasPlugins && !hasMods) return "plugin";
  return detected;
};

const onDownloadVersion = async (version: {
  id?: string;
  name?: string;
  version_number?: string;
  files?: Array<{ primary?: boolean; url?: string; filename?: string; name?: string }>;
  project_type?: string;
  loaders?: string[];
}) => {
  if (!selectedInstance.value || !selectedMod.value) {
    message.warning(t("TXT_CODE_MOD_BROWSER_NEED_INSTANCE"));
    return;
  }
  const file = version.files?.find((f) => f.primary) || version.files?.[0];
  if (!file?.url) {
    message.error(t("TXT_CODE_MOD_BROWSER_NO_FILE"));
    return;
  }

  const detected = detectProjectType(version);
  const projectTypeFinal = resolveSaveType(detected);
  const fallback = version.files?.find((f) => f.url && f.url !== file.url)?.url;
  const fileName = file.filename || file.name || file.url.split("/").pop() || `${selectedMod.value.id}.jar`;

  try {
    const { execute } = downloadModApi();
    await execute({
      data: {
        daemonId: selectedInstance.value.daemonId,
        uuid: selectedInstance.value.instanceUuid,
        url: file.url,
        fileName,
        projectType: projectTypeFinal,
        fallbackUrl: fallback,
        extraInfo: {
          project: {
            id: selectedMod.value.id,
            name: selectedMod.value.title || selectedMod.value.name,
            icon_url: selectedMod.value.icon_url
          },
          version: {
            id: version.id,
            name: version.name,
            version_number: version.version_number
          },
          source: selectedMod.value.source
        }
      }
    });
    message.success(
      t("TXT_CODE_MOD_BROWSER_INSTALL_STARTED", {
        name: selectedMod.value.title || selectedMod.value.name || fileName,
        instance: selectedInstance.value.nickname || selectedInstance.value.instanceUuid
      })
    );
    showVersionModal.value = false;
    await refreshTargetMods();
  } catch (error: unknown) {
    reportErrorMsg(error);
  }
};

onMounted(async () => {
  await loadMcVersions();
  await onSearch(1);
});
</script>

<template>
  <div class="mod-browser">
    <CardPanel class="mod-browser__panel">
      <template #title>{{ card.title }}</template>
      <template #body>
        <div class="toolbar">
          <div class="target-box">
            <div class="target-label">{{ t("TXT_CODE_MOD_BROWSER_TARGET") }}</div>
            <div class="target-row">
              <div class="target-name">
                <AppstoreOutlined />
                <span>
                  {{
                    selectedInstance
                      ? selectedInstance.nickname || selectedInstance.instanceUuid
                      : t("TXT_CODE_MOD_BROWSER_NO_TARGET")
                  }}
                </span>
              </div>
              <div class="target-actions">
                <a-button type="primary" ghost @click="selectTargetInstance">
                  {{ t("TXT_CODE_MOD_BROWSER_SELECT_INSTANCE") }}
                </a-button>
                <a-button type="primary" @click="openAiAssistant">
                  <RobotOutlined />
                  {{ t("TXT_CODE_AI_ASSISTANT_TITLE") }}
                </a-button>
              </div>
            </div>
          </div>

          <div class="filters">
            <a-input
              v-model:value="query"
              allow-clear
              :placeholder="t('TXT_CODE_MOD_BROWSER_SEARCH_PLACEHOLDER')"
              @pressEnter="onSearch(1)"
            >
              <template #prefix>
                <SearchOutlined />
              </template>
            </a-input>
            <a-select v-model:value="source" :options="sourceOptions" style="width: 140px" />
            <a-select
              v-model:value="mcVersion"
              allow-clear
              show-search
              :placeholder="t('TXT_CODE_MOD_MC_VERSION')"
              style="width: 140px"
              :options="mcVersions.map((v) => ({ label: v, value: v }))"
            />
            <a-select v-model:value="loader" :options="loaderOptions" style="width: 140px" />
            <a-select v-model:value="projectType" :options="typeOptions" style="width: 120px" />
            <a-button type="primary" :loading="loading" @click="onSearch(1)">
              <SearchOutlined />
              {{ t("TXT_CODE_MOD_BROWSER_SEARCH") }}
            </a-button>
            <a-button :loading="loading" @click="onSearch(page)">
              <ReloadOutlined />
            </a-button>
          </div>
        </div>

        <a-alert
          class="mb-12"
          type="info"
          show-icon
          :message="t('TXT_CODE_MOD_BROWSER_TIP')"
        />

        <a-table
          :loading="loading"
          :data-source="results"
          :columns="columns"
          row-key="id"
          size="middle"
          :pagination="{
            current: page,
            pageSize,
            total,
            showSizeChanger: false,
            onChange: (p: number) => onSearch(p)
          }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'icon'">
              <a-avatar :src="record.icon_url" shape="square" :size="40" />
            </template>
            <template v-else-if="column.key === 'name'">
              <div class="mod-name">
                <div class="mod-title">{{ record.title || record.name }}</div>
                <div class="mod-desc">{{ record.description }}</div>
              </div>
            </template>
            <template v-else-if="column.key === 'source'">
              <a-tag
                :color="
                  record.source === 'CurseForge'
                    ? 'orange'
                    : record.source === 'SpigotMC'
                      ? 'gold'
                      : 'green'
                "
              >
                {{ record.source || "Modrinth" }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'type'">
              <a-tag color="blue">{{ record.project_type || "mod" }}</a-tag>
            </template>
            <template v-else-if="column.key === 'action'">
              <a-button type="link" @click="openVersions(record)">
                <CloudDownloadOutlined />
                {{ t("TXT_CODE_65b21404") }}
              </a-button>
            </template>
          </template>
        </a-table>

        <div v-if="searched && !loading && results.length === 0" class="empty">
          {{ t("TXT_CODE_MOD_BROWSER_EMPTY") }}
        </div>
      </template>
    </CardPanel>

    <ModVersionModal
      v-model:visible="showVersionModal"
      :selected-mod="selectedMod"
      :versions="versions"
      :versions-loading="versionsLoading"
      :search-filters="searchFilters"
      :mods="installedMods"
      @download="onDownloadVersion"
    />

    <AiAssistantDrawer
      v-if="selectedInstance"
      v-model:open="aiDrawerOpen"
      :instance-id="selectedInstance.instanceUuid"
      :daemon-id="selectedInstance.daemonId"
      :instance-name="selectedInstance.nickname || selectedInstance.instanceUuid"
      scene="mod_library"
      :hide-include-log="true"
    />
  </div>
</template>

<style lang="scss" scoped>
.mod-browser {
  height: 100%;
}

.mod-browser__panel {
  height: 100%;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}

.target-box {
  border: 1px solid var(--color-gray-4);
  border-radius: 10px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--color-gray-2) 70%, transparent);
}

.target-label {
  font-size: 12px;
  color: var(--color-gray-7);
  margin-bottom: 6px;
}

.target-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.target-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--color-gray-11);
  min-width: 0;
}

.target-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;

  :deep(.ant-input-affix-wrapper) {
    max-width: 280px;
  }
}

.mod-name {
  min-width: 0;
}

.mod-title {
  font-weight: 700;
  color: var(--color-gray-12);
  margin-bottom: 2px;
}

.mod-desc {
  font-size: 12px;
  color: var(--color-gray-7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}

.empty {
  text-align: center;
  color: var(--color-gray-7);
  padding: 28px 0;
}

.mb-12 {
  margin-bottom: 12px;
}

@media (max-width: 900px) {
  .target-row {
    flex-direction: column;
    align-items: flex-start;
  }

  .filters :deep(.ant-input-affix-wrapper) {
    max-width: 100%;
    width: 100%;
  }

  .mod-desc {
    max-width: 240px;
  }
}
</style>
