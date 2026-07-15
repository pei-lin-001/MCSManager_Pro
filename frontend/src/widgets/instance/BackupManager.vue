<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { t } from "@/lang/i18n";
import {
  createBackup,
  deleteBackup,
  getBackupSettings,
  listBackups,
  restoreBackup,
  setBackupSettings,
  type BackupRecord,
  type BackupScope
} from "@/services/apis/backup";
import type { LayoutCard } from "@/types";
import { useLayoutCardTools } from "@/hooks/useCardTools";
import { reportErrorMsg } from "@/tools/validator";
import {
  CloudUploadOutlined,
  DeleteOutlined,
  HistoryOutlined,
  ReloadOutlined
} from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import dayjs from "dayjs";
import { onMounted, ref } from "vue";

const props = defineProps<{ card: LayoutCard }>();
const { getMetaOrRouteValue } = useLayoutCardTools(props.card);
const instanceId = getMetaOrRouteValue("instanceId") || "";
const daemonId = getMetaOrRouteValue("daemonId") || "";

const loading = ref(false);
const creating = ref(false);
const items = ref<BackupRecord[]>([]);
const keepCount = ref(5);
const scope = ref<BackupScope>("core");
const note = ref("");

const { execute: execList } = listBackups();
const { execute: execCreate } = createBackup();
const { execute: execDelete } = deleteBackup();
const { execute: execRestore } = restoreBackup();
const { execute: execGetSettings } = getBackupSettings();
const { execute: execSetSettings } = setBackupSettings();

const formatBytes = (n?: number) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(2)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
};

const refresh = async () => {
  if (!instanceId || !daemonId) return;
  loading.value = true;
  try {
    const [listRes, setRes] = await Promise.all([
      execList({ params: { daemonId, uuid: instanceId } }),
      execGetSettings({ params: { daemonId, uuid: instanceId } })
    ]);
    items.value = listRes.value?.items || [];
    if (setRes.value?.keepCount) keepCount.value = setRes.value.keepCount;
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    loading.value = false;
  }
};

const onCreate = async () => {
  if (!instanceId || !daemonId) return;
  creating.value = true;
  try {
    await execCreate({
      params: { daemonId, uuid: instanceId },
      data: { scope: scope.value, note: note.value }
    });
    message.success(t("TXT_CODE_BACKUP_CREATE_OK"));
    note.value = "";
    await refresh();
  } catch (e: any) {
    reportErrorMsg(e);
  } finally {
    creating.value = false;
  }
};

const onSaveKeep = async () => {
  try {
    const res = await execSetSettings({
      params: { daemonId, uuid: instanceId },
      data: { keepCount: keepCount.value }
    });
    keepCount.value = res.value?.keepCount || keepCount.value;
    message.success(t("TXT_CODE_BACKUP_KEEP_SAVED"));
    await refresh();
  } catch (e: any) {
    reportErrorMsg(e);
  }
};

const onDelete = (row: BackupRecord) => {
  Modal.confirm({
    title: t("TXT_CODE_BACKUP_DELETE_TITLE"),
    content: row.id,
    okType: "danger",
    onOk: async () => {
      await execDelete({ params: { daemonId, uuid: instanceId, backupId: row.id } });
      message.success(t("TXT_CODE_BACKUP_DELETE_OK"));
      await refresh();
    }
  });
};

const onRestore = (row: BackupRecord) => {
  Modal.confirm({
    title: t("TXT_CODE_BACKUP_RESTORE_TITLE"),
    content: t("TXT_CODE_BACKUP_RESTORE_HINT"),
    okType: "danger",
    okText: t("TXT_CODE_BACKUP_RESTORE_OK"),
    onOk: async () => {
      const hide = message.loading(t("TXT_CODE_BACKUP_RESTORE_RUNNING"), 0);
      try {
        await execRestore({
          params: { daemonId, uuid: instanceId },
          data: { backupId: row.id, autoStart: true }
        });
        message.success(t("TXT_CODE_BACKUP_RESTORE_DONE"));
        await refresh();
      } catch (e: any) {
        reportErrorMsg(e);
      } finally {
        hide();
      }
    }
  });
};

onMounted(refresh);
</script>

<template>
  <CardPanel class="BackupManager" style="height: 100%">
    <template #title>
      <span class="title">
        <HistoryOutlined />
        {{ card.title || t("TXT_CODE_BACKUP_TITLE") }}
      </span>
    </template>
    <template #operator>
      <a-button size="small" type="link" :loading="loading" @click="refresh">
        <ReloadOutlined />
      </a-button>
    </template>
    <template #body>
      <div class="toolbar">
        <a-select v-model:value="scope" style="width: 140px">
          <a-select-option value="world">{{ t("TXT_CODE_BACKUP_SCOPE_WORLD") }}</a-select-option>
          <a-select-option value="core">{{ t("TXT_CODE_BACKUP_SCOPE_CORE") }}</a-select-option>
          <a-select-option value="full">{{ t("TXT_CODE_BACKUP_SCOPE_FULL") }}</a-select-option>
        </a-select>
        <a-input
          v-model:value="note"
          :placeholder="t('TXT_CODE_BACKUP_NOTE_PH')"
          style="max-width: 220px"
          allow-clear
        />
        <a-button type="primary" :loading="creating" @click="onCreate">
          <CloudUploadOutlined />
          {{ t("TXT_CODE_BACKUP_CREATE") }}
        </a-button>
        <div class="keep">
          <span>{{ t("TXT_CODE_BACKUP_KEEP") }}</span>
          <a-input-number v-model:value="keepCount" :min="1" :max="50" size="small" />
          <a-button size="small" @click="onSaveKeep">{{ t("TXT_CODE_BACKUP_KEEP_SAVE") }}</a-button>
        </div>
      </div>
      <a-typography-paragraph class="hint">
        <a-typography-text type="secondary">{{ t("TXT_CODE_BACKUP_HOT_HINT") }}</a-typography-text>
      </a-typography-paragraph>

      <a-spin :spinning="loading">
        <a-empty v-if="!items.length" :description="t('TXT_CODE_BACKUP_EMPTY')" />
        <div v-else class="list">
          <div v-for="row in items" :key="row.id" class="item">
            <div class="main">
              <div class="id">
                {{ dayjs(row.createdAt).format("MM-DD HH:mm:ss") }}
                <a-tag size="small">{{ row.scope }}</a-tag>
                <a-tag v-if="row.protected" color="orange" size="small">pre-restore</a-tag>
                <a-tag
                  :color="row.status === 'done' ? 'green' : row.status === 'failed' ? 'red' : 'blue'"
                  size="small"
                >
                  {{ row.status }}
                </a-tag>
              </div>
              <div class="meta">
                {{ formatBytes(row.sizeBytes) }}
                <span v-if="row.note"> · {{ row.note }}</span>
                <span v-if="row.error" class="err"> · {{ row.error }}</span>
              </div>
            </div>
            <div class="ops">
              <a-button
                size="small"
                type="primary"
                ghost
                :disabled="row.status !== 'done'"
                @click="onRestore(row)"
              >
                {{ t("TXT_CODE_BACKUP_RESTORE") }}
              </a-button>
              <a-button size="small" danger ghost @click="onDelete(row)">
                <DeleteOutlined />
              </a-button>
            </div>
          </div>
        </div>
      </a-spin>
    </template>
  </CardPanel>
</template>

<style scoped lang="scss">
.title {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.keep {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  margin-left: auto;
  font-size: 12px;
}
.hint {
  margin-bottom: 8px !important;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}
.item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--color-gray-4);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-gray-2) 80%, transparent);
}
.main {
  min-width: 0;
}
.id {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-weight: 600;
}
.meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-gray-7);
}
.err {
  color: var(--color-danger, #cf1322);
}
.ops {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}
</style>
