<script setup lang="ts">
import { t } from "@/lang/i18n";
import { useAppStateStore } from "@/stores/useAppStateStore";
import { skinUrl } from "@/tools/minecraftSkin";
import type { LayoutCard } from "@/types";
import { UserOutlined } from "@ant-design/icons-vue";
import { computed } from "vue";

defineProps<{
  card: LayoutCard;
}>();

const { state } = useAppStateStore();

const displayName = computed(() => state.userInfo?.userName || "-");
const boundName = computed(() => (state.userInfo as any)?.mcName as string | undefined);
const boundUuid = computed(() => (state.userInfo as any)?.mcUuid as string | undefined);
const bodySrc = computed(() =>
  boundName.value ? skinUrl("body", boundUuid.value || boundName.value, 220) : ""
);
const avatarSrc = computed(() =>
  boundName.value ? skinUrl("avatar", boundUuid.value || boundName.value, 96) : ""
);
</script>

<template>
  <section class="hero launcher-enter">
    <div class="hero-bg" aria-hidden="true">
      <div class="hero-grid"></div>
      <div class="hero-glow"></div>
      <div class="hero-vignette"></div>
    </div>

    <div class="hero-inner">
      <div class="skin-stage">
        <div class="skin-pedestal"></div>
        <img v-if="bodySrc" class="skin-body" :src="bodySrc" alt="" />
        <div v-else class="skin-empty"><UserOutlined /></div>
      </div>

      <div class="hero-copy">
        <div class="kicker">
          <span class="kicker-dot"></span>
          {{ t("TXT_CODE_PLAYER_CENTER_NAV") }}
        </div>
        <h1 class="hello">{{ t("TXT_CODE_USER_WELCOME_HELLO", { name: displayName }) }}</h1>
        <p class="sub">{{ t("TXT_CODE_PLAYER_WELCOME_SUB") }}</p>

        <div v-if="boundName" class="bound-pill">
          <img class="avatar" :src="avatarSrc" alt="" />
          <div class="bound-text">
            <div class="bound-name">{{ boundName }}</div>
            <div class="bound-tip">{{ t("TXT_CODE_PLAYER_BOUND_CHARACTER") }}</div>
          </div>
        </div>
        <div v-else class="bound-pill muted">
          <div class="avatar avatar-empty"><UserOutlined /></div>
          <div class="bound-text">
            <div class="bound-name">{{ t("TXT_CODE_PLAYER_BIND_HINT") }}</div>
            <div class="bound-tip">{{ t("TXT_CODE_PLAYER_NAME_PH") }}</div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.hero {
  position: relative;
  overflow: hidden;
  min-height: 260px;
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
  background: linear-gradient(180deg, var(--color-primary), color-mix(in srgb, var(--color-primary) 30%, transparent));
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
  opacity: 0.35;
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
    radial-gradient(circle at 30% 40%, color-mix(in srgb, var(--color-primary) 48%, transparent), transparent 60%),
    radial-gradient(circle at 68% 72%, color-mix(in srgb, var(--color-blue-4) 26%, transparent), transparent 55%);
  filter: blur(2px);
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
  gap: 36px;
  min-height: 260px;
  padding: 28px 36px;
}

.skin-stage {
  position: relative;
  width: 128px;
  height: 188px;
  flex: 0 0 auto;
  display: grid;
  place-items: end center;
}

.skin-pedestal {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 88px;
  height: 18px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.28), transparent 70%);
  filter: blur(1px);
}

.skin-body {
  height: 176px;
  width: auto;
  image-rendering: pixelated;
  object-fit: contain;
  filter: drop-shadow(0 12px 18px rgba(0, 0, 0, 0.28));
  animation: skin-float 4.8s ease-in-out infinite;
}

.skin-empty {
  width: 96px;
  height: 140px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  border: 1px dashed var(--color-gray-6);
  background: var(--color-gray-3);
  color: var(--color-gray-7);
  font-size: 32px;
}

.hero-copy {
  min-width: 0;
  flex: 1;
  padding-bottom: 4px;
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
  margin-bottom: 10px;
}

.kicker-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary) 22%, transparent);
}

.hello {
  margin: 0;
  font-size: clamp(28px, 3.2vw, 40px);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.03em;
  color: var(--text-color);
}

.sub {
  margin: 12px 0 0;
  max-width: 42ch;
  font-size: 15px;
  line-height: 1.65;
  color: var(--color-gray-7);
}

.bound-pill {
  margin-top: 22px;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px 10px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-gray-2) 88%, var(--color-primary));
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--color-gray-5));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
}

.bound-pill.muted {
  background: var(--color-gray-2);
  border-color: var(--color-gray-5);
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  image-rendering: pixelated;
  background: #111;
  border: 1px solid var(--color-gray-5);
  object-fit: cover;
}

.avatar-empty {
  display: grid;
  place-items: center;
  color: var(--color-gray-7);
  background: var(--color-gray-3);
}

.bound-name {
  font-size: 14px;
  font-weight: 800;
  color: var(--text-color);
  line-height: 1.2;
}

.bound-tip {
  margin-top: 2px;
  font-size: 12px;
  color: var(--color-gray-7);
  line-height: 1.2;
}

.launcher-enter {
  animation: rise-in 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes skin-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
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

@media (max-width: 720px) {
  .hero-inner {
    gap: 18px;
    padding: 22px 18px 24px;
    min-height: 220px;
  }
  .skin-stage {
    width: 96px;
    height: 148px;
  }
  .skin-body {
    height: 136px;
  }
  .hello {
    font-size: 26px;
  }
  .sub {
    font-size: 13px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .skin-body,
  .launcher-enter {
    animation: none !important;
  }
}
</style>
