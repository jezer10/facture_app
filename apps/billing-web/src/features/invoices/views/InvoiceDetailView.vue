<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invoiceApi } from '../api';
import type { FiscalDocumentView } from '../api';
import { date, documentName, money } from '../format';
import { connected } from '@/features/session/session';
import { environment, refreshEnvironment } from '@/features/session/environment';
import { errorMessage } from '@/lib/http';
const route = useRoute();
const doc = ref<FiscalDocumentView | null>(null);
const error = ref('');
const actionError = ref('');
const loading = ref(false);
const downloading = ref('');
const voidBusy = ref(false);
const reason = ref('');
const showVoid = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let sequence = 0;
const pending = computed(
  () => doc.value && ['queued', 'processing', 'void_pending'].includes(doc.value.status),
);
const canVoid = computed(
  () =>
    environment.value?.sunat === 'mock' &&
    doc.value &&
    ['accepted', 'accepted_with_observations'].includes(doc.value.status),
);
async function load() {
  clearTimeout(timer);
  if (!connected.value) return;
  const current = ++sequence;
  loading.value = true;
  error.value = '';
  try {
    const result = await invoiceApi.get(String(route.params.id));
    if (disposed || current !== sequence) return;
    doc.value = result;
    if (pending.value)
      timer = setTimeout(() => {
        void load();
      }, 5000);
  } catch (cause) {
    if (!disposed && current === sequence) error.value = errorMessage(cause);
  } finally {
    if (!disposed && current === sequence) loading.value = false;
  }
}
onMounted(() => {
  void refreshEnvironment();
  void load();
});
watch(
  () => route.params.id,
  () => {
    doc.value = null;
    actionError.value = '';
    showVoid.value = false;
    void load();
  },
);
onUnmounted(() => {
  disposed = true;
  sequence++;
  clearTimeout(timer);
});
async function download(kind: string) {
  if (!doc.value || downloading.value) return;
  actionError.value = '';
  downloading.value = kind;
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    if (!tab)
      throw new Error('Permite abrir una pestaña para descargar el archivo e inténtalo de nuevo.');
    const { url } = await invoiceApi.artifact(doc.value.id, kind);
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol))
      throw new Error('El enlace de descarga no es válido.');
    tab.location.replace(url);
  } catch (cause) {
    tab?.close();
    actionError.value = errorMessage(cause);
  } finally {
    downloading.value = '';
  }
}
async function requestVoid() {
  if (!doc.value || !reason.value.trim() || voidBusy.value || !canVoid.value) return;
  actionError.value = '';
  voidBusy.value = true;
  clearTimeout(timer);
  sequence++;
  try {
    doc.value = await invoiceApi.void(doc.value.id, reason.value.trim());
    showVoid.value = false;
    reason.value = '';
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause);
  } finally {
    voidBusy.value = false;
  }
}
</script>
<template>
  <RouterLink to="/facturas" class="back-link"
    ><AppIcon name="back" :size="16" />Volver a facturas</RouterLink
  >
  <div v-if="!connected" class="panel empty-state">
    <h1 tabindex="-1">Conecta tu organización</h1>
    <p>Accede para consultar este comprobante.</p>
    <RouterLink to="/conexion" class="button button--primary">Conectar</RouterLink>
  </div>
  <template v-else
    ><div v-if="error" role="alert" class="alert alert--error">
      {{ error }} <button type="button" class="text-link" @click="load">Reintentar</button>
    </div>
    <div v-if="!doc && loading" class="empty-state" role="status">
      <h1 tabindex="-1">Cargando comprobante…</h1>
    </div>
    <template v-if="doc"
      ><header class="page-header">
        <div>
          <div class="detail-title">
            <h1 tabindex="-1">{{ doc.series }}-{{ doc.number.padStart(8, '0') }}</h1>
            <StatusBadge :status="doc.status" />
          </div>
          <p class="page-description">
            {{ documentName(doc.documentType) }} · Emitida el {{ date(doc.issueDate) }}
          </p>
        </div>
        <AppButton :busy="loading" :disabled="voidBusy" @click="load"
          ><AppIcon name="refresh" :size="18" />Actualizar</AppButton
        >
      </header>
      <p v-if="pending && !error" class="alert" role="status">
        Estamos procesando tu comprobante. El estado se actualiza automáticamente.
      </p>
      <p v-if="actionError" class="alert alert--error" role="alert">{{ actionError }}</p>
      <div class="detail-layout">
        <div class="panel">
          <section class="form-section">
            <h2>Cliente</h2>
            <p class="customer-title">{{ doc.customer?.legalName || 'Cliente no disponible' }}</p>
            <p class="section-description">
              {{
                doc.customer?.identityNumber
                  ? `Documento ${doc.customer.identityNumber}`
                  : 'Sin información del cliente'
              }}
            </p>
            <p v-if="doc.customer?.email" class="section-description">{{ doc.customer.email }}</p>
          </section>
          <section class="form-section"><h2>Detalle del comprobante</h2></section>
          <div v-if="doc.lines?.length" class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Descripción</th>
                  <th scope="col" class="numeric">Cantidad</th>
                  <th scope="col" class="numeric">Valor unitario</th>
                  <th scope="col" class="numeric">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(line, index) in doc.lines" :key="index">
                  <td>{{ line.description }}</td>
                  <td class="numeric">{{ line.quantity }}</td>
                  <td class="numeric">{{ money(line.unitValue, doc.currency) }}</td>
                  <td class="numeric">{{ money(line.payableAmount, doc.currency) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="form-section section-description">
            Este comprobante no contiene un detalle de ítems disponible.
          </p>
          <div class="detail-totals">
            <dl>
              <div>
                <dt>Operaciones gravadas</dt>
                <dd>{{ money(doc.totals.taxableAmount, doc.currency) }}</dd>
              </div>
              <div v-if="Number(doc.totals.exoneratedAmount)">
                <dt>Exoneradas</dt>
                <dd>{{ money(doc.totals.exoneratedAmount, doc.currency) }}</dd>
              </div>
              <div v-if="Number(doc.totals.unaffectedAmount)">
                <dt>Inafectas</dt>
                <dd>{{ money(doc.totals.unaffectedAmount, doc.currency) }}</dd>
              </div>
              <div>
                <dt>IGV</dt>
                <dd>{{ money(doc.totals.igvAmount, doc.currency) }}</dd>
              </div>
              <div class="grand-total">
                <dt>Total</dt>
                <dd>{{ money(doc.totals.payableAmount, doc.currency) }}</dd>
              </div>
            </dl>
          </div>
        </div>
        <aside>
          <section class="panel download-panel">
            <h2>Archivos</h2>
            <p class="section-description">
              Descarga los archivos generados para este comprobante.
            </p>
            <div class="download-actions">
              <AppButton
                v-for="file in [
                  { kind: 'pdf', label: 'Descargar PDF' },
                  { kind: 'xml', label: 'Descargar XML' },
                  { kind: 'cdr', label: 'Descargar CDR' },
                ]"
                :key="file.kind"
                :busy="downloading === file.kind"
                :disabled="Boolean(downloading)"
                @click="download(file.kind)"
                ><AppIcon name="download" :size="17" />{{
                  downloading === file.kind ? 'Preparando…' : file.label
                }}</AppButton
              >
            </div>
            <p class="hint">
              Si un archivo aún no está disponible, vuelve a intentarlo cuando termine el
              procesamiento.
            </p>
          </section>
          <section class="void-section">
            <h2>Anulación</h2>
            <p v-if="environment?.sunat === 'beta'" class="section-description">
              La anulación todavía no está disponible en SUNAT beta.
            </p>
            <p v-else-if="!canVoid" class="section-description">
              Solo se pueden anular comprobantes aceptados en un entorno compatible.
            </p>
            <template v-else
              ><p class="section-description">
                Solicita la baja de este comprobante indicando el motivo.
              </p>
              <AppButton
                v-if="!showVoid"
                class="void-toggle"
                variant="quiet"
                @click="showVoid = true"
                >Solicitar anulación</AppButton
              >
              <form v-else class="void-form" @submit.prevent="requestVoid">
                <label class="field"
                  >Motivo<textarea
                    v-model="reason"
                    class="input"
                    required
                    maxlength="500"
                    rows="3"
                    :disabled="voidBusy"
                  />
                </label>
                <p class="hint">
                  Esta acción enviará una solicitud de baja para {{ doc.series }}-{{ doc.number }}.
                </p>
                <AppButton variant="danger" type="submit" :busy="voidBusy"
                  >Confirmar solicitud</AppButton
                ><AppButton :disabled="voidBusy" variant="quiet" @click="showVoid = false"
                  >Cancelar</AppButton
                >
              </form></template
            >
          </section>
        </aside>
      </div>
    </template>
  </template>
</template>
<style scoped>
@reference "../../../styles/main.css";
.detail-title {
  @apply flex flex-wrap items-center gap-4;
}
.detail-layout {
  @apply grid items-start gap-7 xl:grid-cols-[minmax(0,1fr)_285px];
}
.customer-title {
  @apply mt-5 text-base font-semibold;
}
.detail-totals {
  @apply flex justify-end border-t border-line p-6;
}
.detail-totals dl {
  @apply w-full max-w-xs;
}
.detail-totals dl > div {
  @apply flex justify-between gap-4 py-2 text-sm text-muted;
}
.detail-totals dd {
  @apply text-ink tabular-nums;
}
.detail-totals dl > .grand-total {
  @apply mt-3 border-t border-line pt-5 text-lg font-semibold text-ink;
}
.download-panel {
  @apply p-6;
}
.download-actions {
  @apply my-5 grid gap-3;
}
.void-section {
  @apply px-2 pt-7;
}
.void-toggle {
  @apply mt-3;
}
.void-form {
  @apply mt-4 grid gap-3;
}
</style>
