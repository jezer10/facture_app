<script setup lang="ts">
import type { PublicDocumentStatus } from '@contracts';
import { statuses } from '../format';
defineProps<{ status: PublicDocumentStatus }>();
</script>
<template>
  <span :class="['status', `status--${statuses[status]?.tone ?? 'neutral'}`]"
    ><span class="status-dot" />{{ statuses[status]?.label ?? status }}</span
  >
</template>
<style scoped>
@reference "../../../styles/main.css";
.status {
  @apply inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium;
}
.status-dot {
  @apply size-1.5 rounded-full bg-current;
}
.status--neutral {
  @apply bg-stone-100 text-stone-600;
}
.status--info {
  @apply bg-sky-50 text-sky-800;
}
.status--success {
  @apply bg-emerald-50 text-emerald-800;
}
.status--warning {
  @apply bg-amber-50 text-amber-800;
}
.status--danger {
  @apply bg-red-50 text-red-800;
}
</style>
