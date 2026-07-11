<script setup lang="ts">
import { openNodeSelectDialog } from "@/components/fc";
import { router } from "@/config/router";
import { t } from "@/lang/i18n";
import {
  getMcBuilds,
  getMcLoaders,
  getMcVersions,
  streamMcPreciseInstall,
  type McBuildItem,
  type McInstallStep,
  type McLoaderId,
  type McLoaderInfo,
  type McVersionItem
} from "@/services/apis/mcPrecise";
import { reportErrorMsg } from "@/tools/validator";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  RocketOutlined,
  SearchOutlined
} from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { computed, onMounted, ref, watch } from "vue";

const loaders = ref<McLoaderInfo[]>([]);
const versions = ref<McVersionItem[]>([]);
const builds = ref<McBuildItem[]>([]);

const loader = ref<McLoaderId>("fabric");
const mcVersion = ref<string>("");
const buildId = ref<string | undefined>(undefined);
const keyword = ref("");
const instanceName = ref("");
const useDocker = ref(false);
const autoStart = ref(true);
const loadingLoaders = ref(false);
const loadingVersions = ref(false);
const loadingBuilds = ref(false);
const installing = ref(false);
const installSteps = ref<McInstallStep[]>([]);
const lastResultSummary = ref("");

const { execute: fetchLoaders } = getMcLoaders();
const { execute: fetchVersions } = getMcVersions();
const { execute: fetchBuilds } = getMcBuilds();

const currentLoader = computed(() => loaders.value.find((l) => l.id === loader.value));

const filteredVersions = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return versions.value;
  return versions.value.filter((v) => v.id.toLowerCase().includes(kw));
});

const versionOptions = computed(() =>
  filteredVersions.value.map((v) => ({
    value: v.id,
    label: v.stable === false ? `${v.id} (snapshot)` : v.id
  }))
);

const buildOptions = computed(() =>
  builds.value.map((b) => ({
    value: b.id,
    label: b.label
  }))
);

const selectedVersionMeta = computed(() =>
  versions.value.find((v) => v.id === mcVersion.value)
);

const canInstall = computed(
  () => !!loader.value && !!mcVersion.value && !!instanceName.value.trim() && !installing.value
);

const suggestName = () => {
  if (!mcVersion.value) return;
  const prefix =
    loader.value === "fabric"
      ? "Fabric"
      : loader.value === "forge"
        ? "Forge"
        : loader.value === "neoforge"
          ? "NeoForge"
          : loader.value === "paper"
            ? "Paper"
            : "Vanilla";
  instanceName.value = `${prefix}-${mcVersion.value}`;
};

const loadLoaderList = async () => {
  loadingLoaders.value = true;
  try {
    const res = await fetchLoaders();
    loaders.value = res.value || [];
    if (!loaders.value.find((l) => l.id === loader.value) && loaders.value[0]) {
      loader.value = loaders.value[0].id;
    }
  } catch (e: unknown) {
    reportErrorMsg(e);
  } finally {
    loadingLoaders.value = false;
  }
};

const loadVersionList = async () => {
  if (!loader.value) return;
  loadingVersions.value = true;
  versions.value = [];
  builds.value = [];
  mcVersion.value = "";
  buildId.value = undefined;
  try {
    const res = await fetchVersions({ params: { loader: loader.value } });
    versions.value = res.value || [];
    const prefer =
      versions.value.find((v) => v.id === "1.20.1") ||
      versions.value.find((v) => v.stable !== false) ||
      versions.value[0];
    if (prefer) {
      mcVersion.value = prefer.id;
      suggestName();
    }
  } catch (e: unknown) {
    reportErrorMsg(e);
  } finally {
    loadingVersions.value = false;
  }
};

const loadBuildList = async () => {
  if (!loader.value || !mcVersion.value) return;
  if (currentLoader.value && !currentLoader.value.supportsBuildSelect) {
    builds.value = [];
    buildId.value = undefined;
    return;
  }
  loadingBuilds.value = true;
  builds.value = [];
  buildId.value = undefined;
  try {
    const res = await fetchBuilds({
      params: { loader: loader.value, mcVersion: mcVersion.value }
    });
    builds.value = res.value || [];
    const prefer = builds.value.find((b) => b.stable) || builds.value[0];
    buildId.value = prefer?.id;
  } catch (e: unknown) {
    builds.value = [];
    reportErrorMsg(e);
  } finally {
    loadingBuilds.value = false;
  }
};

watch(loader, () => {
  void loadVersionList();
});

watch(mcVersion, (v) => {
  if (!v) return;
  suggestName();
  void loadBuildList();
});

const stepIconStatus = (status: McInstallStep["status"]) => {
  if (status === "done") return "finish";
  if (status === "error") return "error";
  if (status === "running") return "process";
  if (status === "skipped") return "finish";
  return "wait";
};

const activeStepIndex = computed(() => {
  const running = installSteps.value.findIndex((s) => s.status === "running");
  if (running >= 0) return running;
  const err = installSteps.value.findIndex((s) => s.status === "error");
  if (err >= 0) return err;
  const pending = installSteps.value.findIndex((s) => s.status === "pending");
  if (pending >= 0) return pending;
  return Math.max(installSteps.value.length - 1, 0);
});

const install = async () => {
  if (!canInstall.value) return;
  installing.value = true;
  installSteps.value = [
    { id: "plan", status: "running", message: t("TXT_CODE_MC_PRECISE_STEP_PLAN") },
    { id: "java", status: "pending", message: t("TXT_CODE_MC_PRECISE_STEP_JAVA") },
    { id: "install", status: "pending", message: t("TXT_CODE_MC_PRECISE_STEP_INSTALL") },
    { id: "eula", status: "pending", message: t("TXT_CODE_MC_PRECISE_STEP_EULA") },
    { id: "start", status: "pending", message: t("TXT_CODE_MC_PRECISE_STEP_START") }
  ];
  lastResultSummary.value = "";
  try {
    const node = await openNodeSelectDialog();
    if (!node) {
      message.warning(t("TXT_CODE_2de92a5d"));
      return;
    }
    const payload = await streamMcPreciseInstall({
      daemonId: node.uuid,
      loader: loader.value,
      mcVersion: mcVersion.value,
      buildId: buildId.value,
      newInstanceName: instanceName.value.trim(),
      useDocker: useDocker.value,
      autoStart: autoStart.value,
      waitForInstall: true,
      onEvent: (event) => {
        if (event.type === "step") {
          installSteps.value = event.steps;
        }
      }
    });
    if (payload?.steps?.length) {
      installSteps.value = payload.steps;
    }
    const instanceUuid = payload?.instanceUuid || payload?.task?.instanceUuid;
    const javaText = payload?.java
      ? `Java ${payload.java.version} (${payload.java.source})`
      : useDocker.value
        ? "Docker Temurin"
        : "Java ?";
    const memText = payload?.memory ? `${payload.memory.xms}/${payload.memory.xmx}` : "";
    if (payload?.ok) {
      lastResultSummary.value = t("TXT_CODE_MC_PRECISE_RESULT_OK", {
        java: javaText,
        mem: memText
      });
      message.success(t("TXT_CODE_MC_PRECISE_INSTALL_DONE"));
    } else {
      lastResultSummary.value =
        payload?.error || payload?.trial?.message || t("TXT_CODE_MC_PRECISE_RESULT_FAIL");
      message.warning(lastResultSummary.value);
    }
    if (instanceUuid) {
      setTimeout(() => {
        router.push({
          path: "/instances/terminal",
          query: {
            daemonId: node.uuid,
            instanceId: instanceUuid
          }
        });
      }, 800);
    }
  } catch (e: unknown) {
    reportErrorMsg(e);
    lastResultSummary.value = t("TXT_CODE_MC_PRECISE_RESULT_FAIL");
  } finally {
    installing.value = false;
  }
};

onMounted(async () => {
  await loadLoaderList();
  await loadVersionList();
});
</script>

<template>
  <div class="mc-precise">
    <div class="mc-precise__head">
      <div>
        <div class="mc-precise__title">
          <RocketOutlined class="mr-8" />
          {{ t("TXT_CODE_MC_PRECISE_TITLE") }}
        </div>
        <div class="mc-precise__desc">{{ t("TXT_CODE_MC_PRECISE_DESC") }}</div>
      </div>
      <a-tag color="blue">{{ t("TXT_CODE_MC_PRECISE_BADGE") }}</a-tag>
    </div>

    <a-spin :spinning="loadingLoaders || installing">
      <a-form layout="vertical" class="mc-precise__form">
        <a-form-item :label="t('TXT_CODE_MC_PRECISE_LOADER')">
          <a-radio-group v-model:value="loader" button-style="solid" class="loader-group">
            <a-radio-button v-for="item in loaders" :key="item.id" :value="item.id">
              {{ item.name }}
            </a-radio-button>
          </a-radio-group>
          <div v-if="currentLoader" class="hint">{{ currentLoader.description }}</div>
        </a-form-item>

        <a-row :gutter="16">
          <a-col :span="24" :md="10">
            <a-form-item :label="t('TXT_CODE_MC_PRECISE_SEARCH')">
              <a-input
                v-model:value="keyword"
                allow-clear
                :placeholder="t('TXT_CODE_MC_PRECISE_SEARCH_PH')"
              >
                <template #prefix>
                  <SearchOutlined />
                </template>
              </a-input>
            </a-form-item>
          </a-col>
          <a-col :span="24" :md="14">
            <a-form-item :label="t('TXT_CODE_MC_PRECISE_VERSION')">
              <a-select
                v-model:value="mcVersion"
                show-search
                :loading="loadingVersions"
                :options="versionOptions"
                :placeholder="t('TXT_CODE_MC_PRECISE_VERSION_PH')"
                option-filter-prop="label"
                style="width: 100%"
              />
              <div v-if="selectedVersionMeta?.recommendedJava" class="hint">
                Java {{ selectedVersionMeta.recommendedJava }}+ ·
                {{ t("TXT_CODE_MC_PRECISE_JAVA_AUTO") }}
              </div>
            </a-form-item>
          </a-col>
        </a-row>

        <a-form-item
          v-if="currentLoader?.supportsBuildSelect"
          :label="t('TXT_CODE_MC_PRECISE_BUILD')"
        >
          <a-select
            v-model:value="buildId"
            show-search
            :loading="loadingBuilds"
            :options="buildOptions"
            :placeholder="t('TXT_CODE_MC_PRECISE_BUILD_PH')"
            option-filter-prop="label"
            style="width: 100%"
          />
          <div class="hint">{{ t("TXT_CODE_MC_PRECISE_BUILD_HINT") }}</div>
        </a-form-item>

        <a-row :gutter="16">
          <a-col :span="24" :md="12">
            <a-form-item :label="t('TXT_CODE_MC_PRECISE_NAME')">
              <a-input
                v-model:value="instanceName"
                :placeholder="t('TXT_CODE_MC_PRECISE_NAME_PH')"
                allow-clear
              />
            </a-form-item>
          </a-col>
          <a-col :span="12" :md="6">
            <a-form-item :label="t('TXT_CODE_MC_PRECISE_DOCKER')">
              <a-switch v-model:checked="useDocker" />
              <div class="hint">{{ t("TXT_CODE_MC_PRECISE_DOCKER_HINT") }}</div>
            </a-form-item>
          </a-col>
          <a-col :span="12" :md="6">
            <a-form-item :label="t('TXT_CODE_MC_PRECISE_AUTOSTART')">
              <a-switch v-model:checked="autoStart" />
              <div class="hint">{{ t("TXT_CODE_MC_PRECISE_AUTOSTART_HINT") }}</div>
            </a-form-item>
          </a-col>
        </a-row>

        <div v-if="installSteps.length" class="mc-precise__steps">
          <a-steps direction="vertical" size="small" :current="activeStepIndex">
            <a-step
              v-for="step in installSteps"
              :key="step.id"
              :title="step.message"
              :status="stepIconStatus(step.status)"
            >
              <template #icon>
                <LoadingOutlined v-if="step.status === 'running'" />
                <CheckCircleOutlined v-else-if="step.status === 'done'" />
                <CloseCircleOutlined v-else-if="step.status === 'error'" />
                <MinusCircleOutlined v-else />
              </template>
            </a-step>
          </a-steps>
          <div v-if="lastResultSummary" class="hint mt-8">{{ lastResultSummary }}</div>
        </div>

        <div class="mc-precise__actions">
          <a-button
            type="primary"
            size="large"
            :loading="installing"
            :disabled="!canInstall"
            @click="install"
          >
            <CloudDownloadOutlined />
            {{ t("TXT_CODE_MC_PRECISE_INSTALL") }}
          </a-button>
          <span class="hint">{{ t("TXT_CODE_MC_PRECISE_FOOT") }}</span>
        </div>
      </a-form>
    </a-spin>
  </div>
</template>

<style scoped lang="scss">
.mc-precise {
  border: 1px solid rgba(127, 127, 127, 0.16);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 24px;
  background: rgba(127, 127, 127, 0.03);
}
.mc-precise__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 14px;
}
.mc-precise__title {
  font-size: 16px;
  font-weight: 700;
}
.mc-precise__desc {
  margin-top: 4px;
  opacity: 0.7;
  font-size: 13px;
}
.loader-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.hint {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.65;
}
.mc-precise__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.mc-precise__steps {
  margin: 8px 0 16px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.05);
}
.mr-8 {
  margin-right: 8px;
}
.mt-8 {
  margin-top: 8px;
}
</style>
