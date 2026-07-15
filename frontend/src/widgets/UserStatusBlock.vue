<script setup lang="ts">
import { useLayoutCardTools } from "@/hooks/useCardTools";

import { t } from "@/lang/i18n";
import type { LayoutCard } from "@/types";
import { computed, onMounted } from "vue";

import { userInfoApi } from "@/services/apis/index";

const props = defineProps<{
  card: LayoutCard;
}>();

const { execute, state } = userInfoApi();

const getInstanceList = async () => {
  await execute({
    params: {
      advanced: true
    }
  });
};

const { getMetaValue } = useLayoutCardTools(props.card);

const type = getMetaValue<string>("type");

const computedStatusList = computed(() => {
  if (!state.value) return [];

  return [
    {
      type: "instance_all",
      title: t("TXT_CODE_53745cc0"),
      value: state.value.instances.length
    },
    {
      type: "instance_running",
      title: t("TXT_CODE_7638590c"),
      value: state.value.instances.filter((e) => e.status == 3).length
    },
    {
      type: "instance_stop",
      title: t("TXT_CODE_9bc7f49e"),
      value: state.value.instances.filter((e) => e.status == 0).length
    },
    {
      type: "instance_error",
      title: t("TXT_CODE_ecf17071"),
      value: state.value.instances.filter((e) => e.status == -1 || e.status == 1 || e.status == 2)
        .length
    }
  ];
});

const realStatus = computed(() => computedStatusList.value.find((v) => v.type === type));
const tone = computed(() => {
  if (type === "instance_running") return "running";
  if (type === "instance_stop") return "stop";
  if (type === "instance_error") return "error";
  return "all";
});
onMounted(() => {
  getInstanceList();
});
</script>

<template>
  <CardPanel class="StatusBlock" :class="tone" style="height: 100%">
    <template #title>{{ card.title }}</template>
    <template #body>
      <a-typography-text class="color-info">
        {{ realStatus?.title }}
      </a-typography-text>
      <div class="value">{{ realStatus?.value }}</div>
    </template>
  </CardPanel>
</template>

<style lang="scss" scoped>
.StatusBlock {
  .value {
    font-weight: 800;
    font-size: var(--font-h1);
    margin-top: 4px;
  }
  &.running .value { color: #3f8600; }
  &.stop .value { color: #8c8c8c; }
  &.error .value { color: #cf1322; }
  &.all .value { color: #1677ff; }
}
</style>
