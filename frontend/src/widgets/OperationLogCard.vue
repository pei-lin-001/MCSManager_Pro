<script setup lang="ts">
import CardPanel from "@/components/CardPanel.vue";
import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import { useOperationLog } from "@/hooks/useOperationLog";
import dayjs from "dayjs";
import { computed, onMounted } from "vue";

const { fetchData, formattedLogs } = useOperationLog();

const props = defineProps<{
  card: LayoutCard;
}>();

// Only this card self-limits height. Do NOT change global layout constraints.
const cardStyle = computed(() => {
  const h = props.card?.height;
  if (!h || h === "unset") {
    return { height: "400px", maxHeight: "400px" };
  }
  return { height: h, maxHeight: h };
});

onMounted(() => {
  fetchData();
});
</script>

<template>
  <card-panel class="OperationLogCard" :style="cardStyle">
    <template #title>{{ card.title }}</template>
    <template #body>
      <div v-if="formattedLogs.length" class="log-list">
        <div
          v-for="item in formattedLogs"
          :key="item.operation_id || `${item.operation_time}-${item.text}`"
          class="log-item"
          :class="`log-item--${item.operation_level || 'info'}`"
        >
          <div class="log-item__rail" />
          <div class="log-item__body">
            <div class="log-content">{{ item.text }}</div>
            <div class="log-meta">
              <a-tag :color="item.color || 'blue'">
                {{ item.operation_level || "info" }}
              </a-tag>
              <span class="log-time">
                {{
                  item.operation_time
                    ? dayjs(Number(item.operation_time)).format("MM-DD HH:mm:ss")
                    : "--"
                }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty-state">
        <div class="empty-text">{{ t("TXT_CODE_OV_LOG_EMPTY") }}</div>
        <div class="empty-description">{{ t("TXT_CODE_OV_LOG_EMPTY_HINT") }}</div>
      </div>
    </template>
  </card-panel>
</template>

<style lang="scss" scoped>
.OperationLogCard {
  // Self-contained height clamp — only for this sensitive-ops card.
  min-height: 0;
  overflow: hidden;

  :deep(.card-panel-content) {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
}

.log-item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-gray-2) 80%, transparent);
  border: 1px solid var(--color-gray-4);
  transition: border-color 0.15s ease, background 0.15s ease;

  &:hover {
    border-color: var(--color-gray-5);
    background: var(--color-gray-3);
  }

  &__rail {
    width: 3px;
    border-radius: 999px;
    background: var(--color-primary);
    flex: 0 0 auto;
  }

  &__body {
    min-width: 0;
    flex: 1;
  }

  &--info .log-item__rail {
    background: var(--color-primary);
  }
  &--warning .log-item__rail {
    background: var(--color-warning);
  }
  &--error .log-item__rail {
    background: var(--color-danger);
  }
}

.log-content {
  font-size: 13px;
  line-height: 1.45;
  color: var(--color-gray-11);
  word-break: break-word;
}

.log-meta {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-time {
  font-size: 12px;
  color: var(--color-gray-7);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 16px;
  text-align: center;
  min-height: 140px;
}

.empty-text {
  font-size: 15px;
  color: var(--color-gray-9);
  margin-bottom: 6px;
  font-weight: 600;
}

.empty-description {
  font-size: 13px;
  color: var(--color-gray-7);
  line-height: 1.4;
}
</style>
