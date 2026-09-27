<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter, useRoute } from 'vue-router';
import type { CreateFiscalDocumentInput, FiscalDocumentView } from '@contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import InvoiceLinesEditor from '../components/InvoiceLinesEditor.vue';
import { invoiceApi } from '../api';
import type { InvoiceIssuerOption } from '../api';
import { calculate, newLine } from '../calculation';
import { money, today, documentName } from '../format';
import { connected } from '@/features/session/session';
import { canIssue, environment, refreshEnvironment } from '@/features/session/environment';
import { ApiError, errorMessage } from '@/lib/http';
const router = useRouter();
const route = useRoute();
const originals = ref<FiscalDocumentView[]>([]);
const options = ref<InvoiceIssuerOption[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const beta = computed(() => environment.value?.sunat === 'beta');
const form = reactive({
  documentType: (['01', '03', '07', '08'].includes(String(route.query.type))
    ? String(route.query.type)
    : '01') as CreateFiscalDocumentInput['documentType'],
  referenceId: String(route.query.reference ?? ''),
  reasonCode: '01',
  reasonDescription: '',
  identityType: '6' as '6' | '1',
  issuerId: '',
  seriesId: '',
  currency: 'PEN' as 'PEN' | 'USD',
  issueDate: today(),
  legalName: '',
  ruc: '',
  email: '',
  notes: '',
});
const lines = ref([newLine()]);
const totals = computed(() => calculate(lines.value));
const selectedIssuer = computed(() => options.value.find((item) => item.id === form.issuerId));
const isNote = computed(() => ['07', '08'].includes(form.documentType));
const original = computed(() => originals.value.find((item) => item.id === form.referenceId));
const series = computed(
  () =>
    selectedIssuer.value?.series.filter(
      (item) =>
        item.documentType === form.documentType &&
        (!isNote.value ||
          item.series.startsWith(original.value?.documentType === '03' ? 'B' : 'F')),
    ) ?? [],
);
watch([() => form.documentType, () => form.referenceId], () => {
  form.seriesId = series.value[0]?.id ?? '';
  if (form.documentType === '01') form.identityType = '6';
});
watch(original, (doc) => {
  if (doc) {
    form.legalName = doc.customer?.legalName ?? '';
    form.ruc = doc.customer?.identityNumber ?? '';
    form.identityType = form.ruc.length === 11 ? '6' : '1';
    form.currency = doc.currency;
  }
});
const attempt = ref<{ key: string; input: CreateFiscalDocumentInput } | null>(null);
let succeeded = false;
const dirty = computed(() =>
  Boolean(
    form.legalName ||
      form.ruc ||
      form.email ||
      form.notes ||
      lines.value.some((line) => line.description || line.unitValue),
  ),
);
watch(
  () => form.issuerId,
  () => {
    form.seriesId = series.value[0]?.id ?? '';
  },
);
async function load() {
  loading.value = true;
  error.value = '';
  try {
    await refreshEnvironment();
    options.value = await invoiceApi.options();
    originals.value = (await invoiceApi.list({ offset: 0, limit: 100 })).filter(
      (doc) =>
        ['01', '03'].includes(doc.documentType) &&
        ['accepted', 'accepted_with_observations'].includes(doc.status),
    );
    if (form.referenceId && !originals.value.some((doc) => doc.id === form.referenceId))
      originals.value.push(await invoiceApi.get(form.referenceId));
    form.issuerId = original.value?.issuerId ?? options.value[0]?.id ?? '';
    form.seriesId = series.value[0]?.id ?? '';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}
onMounted(() => {
  if (connected.value) void load();
  else loading.value = false;
});
async function submit() {
  if (busy.value || !canIssue.value) return;
  error.value = '';
  if (!attempt.value) {
    if (!form.legalName.trim() || lines.value.some((line) => !line.description.trim())) {
      error.value = 'Completa la razón social y la descripción de cada ítem.';
      return;
    }
    if (!form.seriesId) {
      error.value = 'Selecciona una serie de facturas activa.';
      return;
    }
    if (isNote.value && (!original.value || !form.reasonDescription.trim())) {
      error.value = 'Selecciona el comprobante original e indica el motivo de la nota.';
      return;
    }
    attempt.value = {
      key: crypto.randomUUID(),
      input: {
        issuerId: form.issuerId,
        seriesId: form.seriesId,
        documentType: form.documentType,
        ...(isNote.value && original.value
          ? {
              reference: {
                documentId: original.value.id,
                documentType: original.value.documentType as '01' | '03',
                series: original.value.series,
                number: original.value.number,
                reasonCode: form.reasonCode,
                reasonDescription: form.reasonDescription.trim(),
              },
            }
          : {}),
        currency: form.currency,
        issueDate: form.issueDate,
        customer: {
          identityType: form.identityType,
          identityNumber: form.ruc.trim(),
          legalName: form.legalName.trim(),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
        },
        lines: lines.value.map((line) => ({
          description: line.description.trim(),
          unitCode: 'NIU',
          quantity: line.quantity,
          unitValue: line.unitValue,
          taxAffectation: line.taxAffectation,
          taxRate: line.taxAffectation === 'taxed' ? '0.18' : '0',
        })),
        ...(form.notes.trim() ? { notes: [form.notes.trim()] } : {}),
      },
    };
  }
  busy.value = true;
  try {
    const result = await invoiceApi.create(attempt.value.input, attempt.value.key);
    succeeded = true;
    attempt.value = null;
    await router.push(`/facturas/${result.id}`);
  } catch (cause) {
    error.value = errorMessage(cause);
    // Only definitive validation/authorization failures allow a new payload/key.
    // Network errors, conflicts and 5xx keep the exact request for a safe retry.
    if (cause instanceof ApiError && [400, 403, 404, 422, 429].includes(cause.status))
      attempt.value = null;
  } finally {
    busy.value = false;
  }
}
function leaveWarning(event: BeforeUnloadEvent) {
  if ((dirty.value || attempt.value) && !succeeded) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', leaveWarning));
onUnmounted(() => window.removeEventListener('beforeunload', leaveWarning));
onBeforeRouteLeave(() => {
  if (succeeded || !connected.value || (!dirty.value && !attempt.value)) return true;
  if (busy.value) return false;
  return window.confirm(
    attempt.value
      ? 'El envío aún no se confirmó. Reintenta desde esta pantalla para evitar duplicados. ¿Salir de todos modos?'
      : 'Tienes una factura sin enviar. ¿Descartar los cambios y salir?',
  );
});
</script>
<template>
  <RouterLink to="/facturas" class="back-link"
    ><AppIcon name="back" :size="16" />Volver a comprobantes</RouterLink
  >
  <header class="page-header">
    <div>
      <h1 tabindex="-1">Nuevo comprobante</h1>
      <p class="page-description">Completa los datos. Nosotros nos encargamos del correlativo.</p>
    </div>
  </header>
  <div v-if="!connected" class="panel empty-state">
    <h2>Conecta tu organización</h2>
    <p>Necesitas acceso para emitir comprobantes.</p>
    <RouterLink to="/conexion" class="button button--primary">Conectar</RouterLink>
  </div>
  <div v-else-if="loading" class="panel empty-state" role="status">
    <p>Cargando emisores y series…</p>
  </div>
  <template v-else>
    <div v-if="error" class="alert alert--error" role="alert">{{ error }}</div>
    <div v-if="!options.length" class="panel empty-state">
      <h2>No hay emisores disponibles</h2>
      <RouterLink to="/empresas" class="button button--primary">Registrar mi empresa</RouterLink>
      <p>Registra tu empresa para empezar a probar en Sandbox.</p>
      <AppButton @click="load">Volver a consultar</AppButton>
    </div>
    <form v-else class="invoice-form" @submit.prevent="submit">
      <div class="form-content">
        <div v-if="beta" class="alert">
          Este comprobante se enviará a SUNAT beta y no tendrá validez fiscal.
        </div>
        <div v-if="!canIssue" class="alert">
          La emisión no está habilitada en este ambiente. Revisa su configuración.
          <button class="text-link" type="button" @click="refreshEnvironment">
            Comprobar entorno
          </button>
        </div>
        <div v-if="attempt && !busy" class="alert" role="status">
          El envío no se confirmó. Reintenta con los mismos datos para evitar crear un duplicado.
        </div>
        <fieldset class="panel" :disabled="busy || Boolean(attempt)">
          <legend class="sr-only">Datos de la factura</legend>
          <section class="form-section">
            <h2>Datos del comprobante</h2>
            <div class="form-grid">
              <label class="field"
                >Tipo de comprobante<select v-model="form.documentType" class="input">
                  <option value="01">Factura</option>
                  <option value="03">Boleta</option>
                  <option value="07">Nota de crédito</option>
                  <option value="08">Nota de débito</option>
                </select></label
              >
              <label class="field"
                >Emisor<select v-model="form.issuerId" class="input" required>
                  <option v-for="issuer in options" :key="issuer.id" :value="issuer.id">
                    {{ issuer.legalName }} · {{ issuer.ruc }}
                  </option>
                </select></label
              ><label class="field"
                >Serie<select v-model="form.seriesId" class="input" required>
                  <option v-if="!series.length" value="">Sin series de factura activas</option>
                  <option v-for="item in series" :key="item.id" :value="item.id">
                    {{ item.series }} · {{ documentName(form.documentType) }}
                  </option></select
                ><span class="hint">El número se asigna al emitir.</span></label
              ><label class="field"
                >Fecha de emisión<input
                  v-model="form.issueDate"
                  class="input"
                  type="date"
                  required
                  :max="today()" /></label
              ><label class="field"
                >Moneda<select v-model="form.currency" class="input" aria-label="Moneda">
                  <option value="PEN">Soles (PEN)</option>
                  <option value="USD">Dólares (USD)</option>
                </select></label
              >
            </div>
          </section>
          <section v-if="isNote" class="form-section">
            <h2>Comprobante afectado</h2>
            <div class="form-grid">
              <label class="field"
                >Comprobante original<select v-model="form.referenceId" class="input" required>
                  <option value="">Selecciona un comprobante aceptado</option>
                  <option
                    v-for="doc in originals.filter((item) => item.issuerId === form.issuerId)"
                    :key="doc.id"
                    :value="doc.id"
                  >
                    {{ doc.series }}-{{ doc.number }} · {{ doc.customer?.legalName }}
                  </option>
                </select></label
              >
              <label class="field"
                >Código del motivo<select v-model="form.reasonCode" class="input">
                  <template v-if="form.documentType === '07'"
                    ><option value="01">01 · Anulación de la operación</option>
                    <option value="06">06 · Devolución total</option>
                    <option value="07">07 · Devolución por ítem</option>
                    <option value="09">09 · Disminución en el valor</option></template
                  ><template v-else
                    ><option value="01">01 · Intereses por mora</option>
                    <option value="02">02 · Aumento en el valor</option>
                    <option value="03">03 · Penalidades</option></template
                  >
                </select></label
              >
              <label class="field"
                >Descripción del motivo<input
                  v-model="form.reasonDescription"
                  class="input"
                  required
                  maxlength="500"
              /></label>
            </div>
          </section>
          <section class="form-section">
            <h2>Cliente</h2>
            <div class="form-grid">
              <label class="field"
                >Documento del cliente<select v-model="form.identityType" class="input">
                  <option value="6">RUC</option>
                  <option v-if="form.documentType !== '01'" value="1">DNI</option></select
                ><input
                  v-model="form.ruc"
                  class="input"
                  inputmode="numeric"
                  :pattern="form.identityType === '6' ? '[0-9]{11}' : '[0-9]{8}'"
                  :maxlength="form.identityType === '6' ? 11 : 8"
                  required
                  :placeholder="form.identityType === '6' ? '11 dígitos' : '8 dígitos'" /></label
              ><label class="field"
                >Razón social<input
                  v-model="form.legalName"
                  class="input"
                  required
                  maxlength="200"
                  placeholder="Nombre de la empresa" /></label
              ><label class="field"
                >Correo electrónico <span class="hint">Opcional</span
                ><input
                  v-model="form.email"
                  class="input"
                  type="email"
                  maxlength="254"
                  placeholder="facturacion@empresa.pe"
                /><span class="hint">{{
                  beta
                    ? 'En Sandbox usa un destinatario verificado: ' +
                      (environment?.verifiedRecipients.join(', ') || 'revisa Configuración')
                    : 'Facture enviará el comprobante a este correo.'
                }}</span></label
              >
            </div>
          </section>
          <section class="form-section">
            <InvoiceLinesEditor
              v-model="lines"
              :currency="form.currency"
              :disabled="busy || Boolean(attempt)"
            />
          </section>
          <section class="form-section">
            <label class="field"
              >Observaciones <span class="hint">Opcional</span
              ><textarea
                v-model="form.notes"
                class="input"
                rows="3"
                maxlength="500"
                placeholder="Información adicional para este comprobante"
              />
            </label>
          </section>
        </fieldset>
      </div>
      <aside class="summary panel">
        <h2>Resumen</h2>
        <p class="section-description">{{ documentName(form.documentType) }}</p>
        <dl>
          <div>
            <dt>Valor de venta</dt>
            <dd>{{ money(totals.subtotal, form.currency) }}</dd>
          </div>
          <div>
            <dt>IGV</dt>
            <dd>{{ money(totals.tax, form.currency) }}</dd>
          </div>
          <div class="summary-total">
            <dt>Total</dt>
            <dd>{{ money(totals.total, form.currency) }}</dd>
          </div>
        </dl>
        <p class="hint">
          Importes estimados. El cálculo definitivo lo valida el servidor al emitir.
        </p>
        <AppButton
          variant="primary"
          type="submit"
          :busy="busy"
          :disabled="!canIssue || !form.seriesId"
          class="submit-button"
          ><AppIcon name="check" :size="18" />{{
            busy ? 'Enviando…' : attempt ? 'Reintentar mismo envío' : 'Emitir comprobante'
          }}</AppButton
        >
        <p class="summary-note">
          Se enviará al entorno de pruebas. Podrás seguir el estado en el detalle.
        </p>
      </aside>
    </form>
  </template>
</template>
<style scoped>
@reference "../../../styles/main.css";
.invoice-form {
  @apply grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_285px];
}
.form-content {
  @apply min-w-0;
}
.summary {
  @apply p-6 xl:sticky xl:top-6;
}
.summary dl {
  @apply mt-7 mb-4;
}
.summary dl > div {
  @apply mb-4 flex justify-between gap-3 text-sm text-muted;
}
.summary dd {
  @apply font-medium text-ink tabular-nums;
}
.summary dl > .summary-total {
  @apply mt-5 border-t border-line pt-5 text-base font-semibold text-ink;
}
.summary-total dd {
  @apply text-xl text-brand;
}
.submit-button {
  @apply mt-6 w-full;
}
.summary-note {
  @apply mt-3 text-center text-xs text-muted;
}
</style>
