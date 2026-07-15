<script setup lang="ts">
import UploadBubble from "@/components/UploadBubble.vue";
import { useScreen } from "@/hooks/useScreen";
import { useAppConfigStore } from "@/stores/useAppConfigStore";

import { Button, Input, Select, Table } from "ant-design-vue";
import { computed, onMounted } from "vue";
import { RouterView } from "vue-router";
import AppBottomNav from "./components/AppBottomNav.vue";
import AppConfigProvider from "./components/AppConfigProvider.vue";
import AppHeader from "./components/AppHeader.vue";
import AppSidebarMenu from "./components/AppSidebarMenu.vue";
import Breadcrumbs from "./components/Breadcrumbs.vue";
import InputDialogProvider from "./components/InputDialogProvider.vue";
import MyselfInfoDialog from "./components/MyselfInfoDialog.vue";
import { ROLE } from "./config/router";
import { useAppStateStore } from "./stores/useAppStateStore";
import { useLayoutContainerStore } from "./stores/useLayoutContainerStore";
import { closeAppLoading, setLoadingTitle } from "./tools/dom";

const { hasBgImage, initAppTheme, useSidebarLayout } = useAppConfigStore();
const { containerState } = useLayoutContainerStore();
const { state: appState } = useAppStateStore();
const { isPhone } = useScreen();

const isPlayerShell = computed(() => {
  const p = Number(appState.userInfo?.permission ?? 0);
  return p > 0 && p < ROLE.MANAGER;
});

const GLOBAL_COMPONENTS = [InputDialogProvider, MyselfInfoDialog, UploadBubble];

[Button, Select, Input, Table].forEach((element) => {
  element.props.size.default = "large";
});

const designModeNavStyle = computed(() => {
  if (!appState.userInfo) return {};
  return {
    zIndex: containerState.isDesignMode ? 997 : 1
  };
});

onMounted(async () => {
  setLoadingTitle("Loading application settings...");
  await initAppTheme();
  closeAppLoading();
});
</script>

<template>
  <AppConfigProvider :has-bg-image="hasBgImage">
    <!-- App Container -->
    <div class="global-app-container" :class="{ 'player-shell': isPlayerShell }">
      <AppSidebarMenu v-if="useSidebarLayout" :style="designModeNavStyle" />
      <main class="main-content" :class="{ 'app-layout-sidebar-only': useSidebarLayout }">
        <AppHeader v-if="!useSidebarLayout" :style="designModeNavStyle" />
        <Breadcrumbs />
        <RouterView :key="$route.fullPath" />
      </main>
    </div>

    <!-- Mobile Bottom Navigation -->
    <AppBottomNav v-if="isPhone && !useSidebarLayout" />

    <!-- Global Components -->
    <component :is="component" v-for="(component, index) in GLOBAL_COMPONENTS" :key="index" />
  </AppConfigProvider>
</template>

<style lang="scss">
.player-shell {
  min-height: 100%;
}
.player-shell .main-layout-container {
  max-width: 1180px;
  margin: 0 auto;
  padding-top: 8px;
  padding-bottom: 56px;
}
.player-shell .layout-card-col {
  /* give launcher cards breathing room without fighting gutter */
}
.player-shell .nav-button {
  border-radius: 10px;
  font-weight: 700;
}
.player-shell .breadcrumbs {
  display: none !important;
}
/* Keep native card surfaces; hero provides the launcher drama */
.player-shell .card-panel {
  border-radius: 16px;
}
</style>
