<script setup lang="ts">
import { computed } from "vue";
import { t } from "@/lang/i18n";

const props = withDefaults(
  defineProps<{
    size?: "sm" | "md";
    showWordmark?: boolean;
  }>(),
  {
    size: "sm",
    showWordmark: true
  }
);

const rootClass = computed(() => ["brand-mark", `brand-mark--${props.size}`]);
const productName = computed(() => t("TXT_CODE_PRODUCT_NAME"));
</script>

<template>
  <div :class="rootClass" :aria-label="productName">
    <span class="mark" aria-hidden="true">H</span>
    <span v-if="showWordmark" class="word">{{ productName }}</span>
  </div>
</template>

<style scoped lang="scss">
.brand-mark {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  user-select: none;
  line-height: 1;
  color: inherit;
}

.mark {
  display: inline-grid;
  place-items: center;
  font-weight: 800;
  letter-spacing: -0.04em;
  color: #fff;
  background: var(--sh-accent, #0f766e);
}

.word {
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--color-gray-12);
}

.brand-mark--sm .mark {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 12px;
}

.brand-mark--sm .word {
  font-size: 15px;
}

.brand-mark--md .mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  font-size: 14px;
}

.brand-mark--md .word {
  font-size: 17px;
}
</style>
