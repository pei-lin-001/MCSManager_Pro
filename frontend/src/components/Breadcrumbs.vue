<script setup lang="ts">
import { ROLE, type RouterMetaInfo } from "@/config/router";
import { useAppRouters } from "@/hooks/useAppRouters";
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { computed } from "vue";
import { useRoute } from "vue-router";

export interface BreadcrumbItem {
  title: string;
  disabled: boolean;
  href: string;
}

const route = useRoute();
const { getRouteParamsUrl } = useAppRouters();
const { state: appState } = useAppStateStore();

const isPlayerShell = computed(() => Number(appState.userInfo?.permission ?? 0) < ROLE.MANAGER);

const items = computed<BreadcrumbItem[]>(() => {
  const perm = Number(appState.userInfo?.permission ?? 0);
  const player = perm > 0 && perm < ROLE.MANAGER;

  // Player home is a single destination — no admin-style trail.
  if (player && (route.path === "/customer" || route.path === "/leaderboard")) return [];

  const rootTitle = player ? t("TXT_CODE_PLAYER_CENTER_NAV") : t("TXT_CODE_f5b9d58f");
  const rootHref = player ? "./#/customer" : ".";
  const arr: BreadcrumbItem[] = [
    {
      title: rootTitle,
      disabled: false,
      href: rootHref
    }
  ];

  const queryUrl = getRouteParamsUrl();

  if (route.meta.breadcrumbs instanceof Array) {
    const meta = route.meta as RouterMetaInfo;
    meta.breadcrumbs?.forEach((v) => {
      const params = queryUrl && !v.mainMenu ? `?${queryUrl}` : "";
      if ((appState.userInfo?.permission || 0) < v.permission) return;
      arr.push({
        title: v.name,
        disabled: false,
        href: `./#${v.path}${params}`
      });
    });
  }

  arr.push({
    title: String(route.name),
    disabled: true,
    href: `./#${route.fullPath}`
  });

  return arr;
});
</script>

<template>
  <div v-if="items.length" class="breadcrumbs" :class="{ 'breadcrumbs--player': isPlayerShell }">
    <a-breadcrumb>
      <a-breadcrumb-item v-for="item in items" :key="item.title + item.href">
        <a v-if="!item.disabled" :href="item.href">{{ item.title }}</a>
        <span v-else>{{ item.title }}</span>
      </a-breadcrumb-item>
    </a-breadcrumb>
  </div>
</template>

<style lang="scss" scoped>
.breadcrumbs {
  font-size: 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 0px;
}
.breadcrumbs--player {
  font-size: 15px;
  padding: 12px 0 8px;
  opacity: 0.9;
}
</style>
