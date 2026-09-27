<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { calculate, newLine } from '../calculation';
import type { DraftLine } from '../calculation';
import { money } from '../format';
const lines = defineModel<DraftLine[]>({ required: true });
const totals = computed(() => calculate(lines.value));
defineProps<{ currency: string; beta: boolean; disabled: boolean }>();
</script>
<template>
  <div class="lines-heading">
    <div>
      <h2>Productos o servicios</h2>
      <p class="section-description">Ingresa el valor unitario sin IGV.</p>
    </div>
    <AppButton
      v-if="!beta"
      :disabled="disabled || lines.length >= 500"
      @click="lines.push(newLine())"
      ><AppIcon name="plus" :size="16" />Agregar ítem</AppButton
    >
  </div>
  <div v-for="(line, index) in lines" :key="line.key" class="line-item">
    <label class="field line-description"
      >Descripción<input
        v-model="line.description"
        class="input"
        required
        maxlength="500"
        placeholder="Ej. Servicio de diseño web"
        :disabled="disabled"
        :aria-label="`Descripción del ítem ${index + 1}`" /></label
    ><label class="field"
      >Cantidad<input
        :value="line.quantity"
        @input="line.quantity = ($event.target as HTMLInputElement).value"
        class="input"
        type="number"
        min="0.0000000001"
        step="any"
        required
        :readonly="beta"
        :disabled="disabled"
        :aria-label="`Cantidad del ítem ${index + 1}`" /></label
    ><label class="field"
      >Valor unitario<input
        :value="line.unitValue"
        @input="line.unitValue = ($event.target as HTMLInputElement).value"
        class="input"
        type="number"
        min="0.01"
        :max="beta ? 500 : undefined"
        step="0.01"
        required
        placeholder="0.00"
        :disabled="disabled"
        :aria-label="`Valor unitario del ítem ${index + 1}`" /></label
    ><label class="field"
      >Impuesto<select
        v-model="line.taxAffectation"
        class="input"
        :disabled="beta || disabled"
        :aria-label="`Impuesto del ítem ${index + 1}`"
      >
        <option value="taxed">IGV 18%</option>
        <option value="exonerated">Exonerado</option>
        <option value="unaffected">Inafecto</option>
      </select></label
    >
    <div class="line-total">
      <span>Total</span><strong>{{ money(totals.items[index], currency) }}</strong>
    </div>
    <AppButton
      v-if="!beta"
      variant="quiet"
      :disabled="disabled || lines.length === 1"
      :aria-label="`Eliminar ítem ${index + 1}`"
      @click="lines.splice(index, 1)"
      ><AppIcon name="trash" :size="17"
    /></AppButton>
  </div>
</template>
<style scoped>
@reference "../../../styles/main.css";
.lines-heading {
  @apply mb-6 flex flex-wrap items-start justify-between gap-4;
}
.line-item {
  @apply grid grid-cols-2 items-end gap-4 border-b border-line py-5 first:pt-0 last:border-0 lg:grid-cols-[minmax(0,2fr)_80px_110px_130px];
}
.line-description {
  @apply col-span-2 lg:col-span-1;
}
.line-total {
  @apply flex flex-col gap-2 text-xs text-muted;
}
.line-total strong {
  @apply text-sm font-semibold text-ink tabular-nums;
}
</style>
