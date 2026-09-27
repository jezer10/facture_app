<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6M9 12h6',
  plus: 'M12 5v14M5 12h14',
  arrow: 'm9 5 7 7-7 7',
  back: 'm15 5-7 7 7 7',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1',
  connection: 'M8 10V4m8 6V4M6 10h12v3a6 6 0 0 1-12 0v-3Zm6 9v3',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',
  check: 'm5 12 4 4L19 6',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
  logout: 'M9 5H4v14h5m6-14 7 7-7 7M8 12h14',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.invoice" />
  </svg>
</template>
