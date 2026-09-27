<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
    type?: 'button' | 'submit';
    busy?: boolean;
    disabled?: boolean;
  }>(),
  { variant: 'secondary', type: 'button', busy: false, disabled: false },
);
</script>
<template>
  <button
    :type="type"
    :class="['button', `button--${variant}`]"
    :disabled="busy || disabled"
    :aria-busy="busy"
  >
    <slot />
  </button>
</template>
