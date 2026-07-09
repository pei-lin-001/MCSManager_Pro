<script setup lang="ts">
import { useOverviewInfo } from "@/hooks/useOverviewInfo";
import { t } from "@/lang/i18n";
import { getProgressStrokeColor } from "@/tools/progressColor";
import { hasVersionUpdate } from "@/tools/version";
import type { LayoutCard } from "@/types";
import { CheckCircleOutlined, InfoCircleOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";

defineProps<{
  card: LayoutCard;
}>();

const { state } = useOverviewInfo();
const specifiedDaemonVersion = computed(() => state.value?.specifiedDaemonVersion);

const columns = [
  {
    title: t("TXT_CODE_OV_NODE_COL_NODE"),
    dataIndex: "node",
    key: "node",
    width: 220
  },
  { title: "CPU", dataIndex: "cpu", key: "cpu", width: 150 },
  { title: t("TXT_CODE_593ee330"), dataIndex: "mem", key: "mem", width: 170 },
  { title: t("TXT_CODE_eaed6901"), dataIndex: "instances", key: "instances", width: 150 },
  { title: t("TXT_CODE_3f99f17f"), dataIndex: "version", key: "version", width: 120 },
  { title: t("TXT_CODE_f80e0786"), dataIndex: "status", key: "status", width: 100 }
];

const dataSource = computed(() => {
  const list =
    state.value?.remote.map((v) => {
      const totalMem = v.system?.totalmem ?? 0;
      const freeMem = v.system?.freemem ?? 0;
      const memUsedPercent = totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 100) : 0;
      const cpuPercent = v.system ? Number((v.system.cpuUsage * 100).toFixed(0)) : 0;
      const running = v.instance?.running ?? 0;
      const total = v.instance?.total ?? 0;
      const instancePercent = total > 0 ? Math.round((running / total) * 100) : 0;
      return {
        key: v.uuid,
        address: `${v.ip}:${v.port}`,
        remark: v.remarks || "--",
        cpu: v.cpuInfo ?? "--",
        cpuPercent,
        mem: v.memText ?? "--",
        memUsedPercent,
        instances: `${running} / ${total}`,
        running,
        total,
        instancePercent,
        version: v.version || "--",
        status: v.available ? t("TXT_CODE_823bfe63") : t("TXT_CODE_66ce073e"),
        available: v.available
      };
    }) ?? [];

  return list;
});

const sortedData = computed(() => {
  return [...dataSource.value].sort((a, b) => {
    if (a.available === b.available) return 0;
    return a.available ? 1 : -1;
  });
});

const paginationConfig = computed(() => {
  const total = sortedData.value.length;
  if (total <= 8) return false;
  return {
    pageSize: 8,
    showSizeChanger: false,
    showTotal: (n: number) => t("TXT_CODE_TOTAL_ITEMS", { total: n }),
    size: "small" as const
  };
});
</script>

<template>
  <CardPanel class="NodeOverview" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div class="NodeOverview__wrap">
        <a-table
          :scroll="{ x: 'max-content' }"
          :columns="columns"
          :data-source="sortedData"
          :pagination="paginationConfig"
          size="small"
          :row-class-name="(record: { available: boolean }) => (record.available ? '' : 'row-offline')"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'node'">
              <div class="node-cell">
                <span class="node-dot" :class="record.available ? 'is-on' : 'is-off'" />
                <div class="node-text">
                  <div class="node-name">{{ record.remark }}</div>
                  <div class="node-addr">{{ record.address }}</div>
                </div>
              </div>
            </template>

            <template v-else-if="column.key === 'cpu'">
              <div v-if="record.available" class="metric-cell">
                <div class="metric-cell__top">
                  <span>{{ record.cpu }}</span>
                </div>
                <a-progress
                  :percent="record.cpuPercent"
                  :stroke-color="getProgressStrokeColor(record.cpuPercent)"
                  :show-info="false"
                  :stroke-width="8"
                />
              </div>
              <span v-else class="muted">--</span>
            </template>

            <template v-else-if="column.key === 'mem'">
              <div v-if="record.available" class="metric-cell">
                <div class="metric-cell__top">
                  <span>{{ record.mem }}</span>
                </div>
                <a-progress
                  :percent="record.memUsedPercent"
                  :stroke-color="getProgressStrokeColor(record.memUsedPercent)"
                  :show-info="false"
                  :stroke-width="8"
                />
              </div>
              <span v-else class="muted">--</span>
            </template>

            <template v-else-if="column.key === 'instances'">
              <div class="metric-cell">
                <div class="metric-cell__top">
                  <span>{{ record.running }} / {{ record.total }}</span>
                </div>
                <a-progress
                  :percent="record.instancePercent"
                  :stroke-color="getProgressStrokeColor(record.instancePercent)"
                  :show-info="false"
                  :stroke-width="8"
                />
              </div>
            </template>

            <template v-else-if="column.key === 'version'">
              <a-tooltip
                v-if="record.available && hasVersionUpdate(specifiedDaemonVersion, record.version)"
              >
                <template #title>
                  {{ t("TXT_CODE_e520908a") }}
                </template>
                <span class="color-danger">
                  <InfoCircleOutlined class="mr-2" />
                  {{ record.version }}
                </span>
              </a-tooltip>

              <span v-else-if="record.available" class="color-success">
                <CheckCircleOutlined class="mr-2" />
                {{ record.version }}
              </span>
              <span v-else class="muted">{{ record.version }}</span>
            </template>

            <template v-else-if="column.key === 'status'">
              <a-tag :color="record.available ? 'success' : 'error'">
                {{ record.status }}
              </a-tag>
            </template>
          </template>
        </a-table>
      </div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.NodeOverview {
  height: 100%;

  :deep(.card-panel-content) {
    height: calc(100% - 28px);
    min-height: 0;
  }
}

.NodeOverview__wrap {
  overflow: auto;
  height: 100%;
  min-height: 0;
  padding: 0 1px;
}

.node-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.node-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;

  &.is-on {
    background: var(--color-success);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 18%, transparent);
  }
  &.is-off {
    background: var(--color-danger);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 18%, transparent);
  }
}

.node-name {
  font-weight: 600;
  color: var(--color-gray-11);
  line-height: 1.2;
  font-size: 12px;
}

.node-addr {
  margin-top: 1px;
  font-size: 11px;
  color: var(--color-gray-7);
  font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, monospace;
}

.metric-cell {
  min-width: 100px;

  &__top {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    margin-bottom: 2px;
    font-variant-numeric: tabular-nums;
    color: var(--color-gray-10);
  }
}

.muted {
  color: var(--color-gray-6);
}

:deep(.NodeOverview__wrap .ant-table-pagination) {
  margin: 6px 0 0;
}

:deep(.NodeOverview__wrap .ant-table) {
  font-size: 12px;
}

:deep(.NodeOverview__wrap .ant-table-thead > tr > th) {
  font-weight: 600;
  padding: 8px !important;
}

:deep(.NodeOverview__wrap .ant-table-tbody > tr > td) {
  padding: 8px !important;
}

:deep(.row-offline) {
  background: color-mix(in srgb, var(--color-danger) 6%, transparent) !important;
}
</style>
