<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invoiceApi } from '../api';
import type { FiscalDocumentView, InvoiceIssuerOption, PublicDocumentStatus } from '../api';
import { date, documentName, money, statuses } from '../format';
import { connected } from '@/features/session/session';
import { errorMessage } from '@/lib/http';
const documents = ref<FiscalDocumentView[]>([]);
const issuers = ref<InvoiceIssuerOption[]>([]);
const status = ref<PublicDocumentStatus | ''>('');
const issuer = ref('');
const search = ref('');
const page = ref(0);
const more = ref(false);
const loading = ref(false);
const error = ref('');
let sequence = 0;
const visible = computed(() => {
  const query = search.value.trim().toLocaleLowerCase('es');
  return documents.value.filter((doc) =>
    `${doc.series}-${doc.number} ${doc.customer?.legalName ?? ''} ${doc.customer?.identityNumber ?? ''}`
      .toLocaleLowerCase('es')
      .includes(query),
  );
});
async function load() {
  if (!connected.value) return;
  const current = ++sequence;
  loading.value = true;
  error.value = '';
  try {
    const rows = await invoiceApi.list({
      offset: page.value * 20,
      limit: 21,
      ...(status.value ? { status: status.value } : {}),
      ...(issuer.value ? { issuerId: issuer.value } : {}),
    });
    if (current !== sequence) return;
    more.value = rows.length > 20;
    documents.value = rows.slice(0, 20);
  } catch (cause) {
    if (current === sequence) {
      error.value = errorMessage(cause);
      documents.value = [];
    }
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch([status, issuer], () => {
  page.value = 0;
  search.value = '';
  void load();
});
function changePage(delta: number) {
  page.value += delta;
  search.value = '';
  void load();
}
onMounted(async () => {
  await load();
  if (connected.value) {
    try {
      issuers.value = await invoiceApi.options();
    } catch {
      /* List remains usable without creation options. */
    }
  }
});
</script>
<template>
  <header class="page-header">
    <div>
      <h1 tabindex="-1">Comprobantes</h1>
      <p class="page-description">Tus comprobantes, del primer envío a la descarga.</p>
    </div>
    <RouterLink :to="connected ? '/facturas/nueva' : '/conexion'" class="button button--primary"
      ><AppIcon name="plus" />Nuevo comprobante</RouterLink
    >
  </header>
  <section class="panel" aria-label="Listado de comprobantes">
    <div class="list-heading">
      <div>
        <h2>Comprobantes emitidos</h2>
        <p>Revisa el estado de cada envío.</p>
      </div>
      <AppButton v-if="connected" variant="quiet" :busy="loading" @click="load"
        ><AppIcon name="refresh" />Actualizar</AppButton
      >
    </div>
    <template v-if="connected">
      <div class="filters">
        <label class="search-field"
          ><AppIcon name="search" :size="18" /><span class="sr-only">Buscar en esta página</span
          ><input
            v-model="search"
            class="input search-input"
            placeholder="Cliente, RUC o comprobante"
            type="search" /></label
        ><label class="filter-field"
          ><span class="sr-only">Estado</span
          ><select v-model="status" class="input" aria-label="Estado">
            <option value="">Todos los estados</option>
            <option v-for="(entry, key) in statuses" :key="key" :value="key">
              {{ entry.label }}
            </option>
          </select></label
        ><label v-if="issuers.length > 1" class="filter-field"
          ><span class="sr-only">Emisor</span
          ><select v-model="issuer" class="input">
            <option value="">Todos los emisores</option>
            <option v-for="option in issuers" :key="option.id" :value="option.id">
              {{ option.legalName }}
            </option>
          </select></label
        >
      </div>
      <div v-if="error" class="list-error" role="alert">
        <p class="alert alert--error">{{ error }}</p>
        <AppButton @click="load">Volver a intentar</AppButton>
      </div>
      <div v-else-if="loading" class="empty-state" role="status">
        <AppIcon name="refresh" :size="28" />
        <h2>Cargando comprobantes…</h2>
        <p>Estamos consultando tu organización.</p>
      </div>
      <div v-else-if="visible.length" class="table-scroll">
        <table class="data-table">
          <caption class="sr-only">
            Comprobantes de tu organización, página
            {{
              page + 1
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">Comprobante</th>
              <th scope="col">Cliente</th>
              <th scope="col">Emisión</th>
              <th scope="col">Estado SUNAT</th>
              <th scope="col" class="numeric">Importe</th>
              <th scope="col"><span class="sr-only">Detalle</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="doc in visible" :key="doc.id">
              <td>
                <RouterLink :to="`/facturas/${doc.id}`" class="invoice-number"
                  >{{ doc.series }}-{{ doc.number.padStart(8, '0') }}</RouterLink
                ><span class="secondary-text">{{ documentName(doc.documentType) }}</span>
              </td>
              <td>
                <span class="customer-name">{{
                  doc.customer?.legalName || 'Cliente no disponible'
                }}</span
                ><span class="secondary-text">{{ doc.customer?.identityNumber || '—' }}</span>
              </td>
              <td class="date-cell">{{ date(doc.issueDate) }}</td>
              <td><StatusBadge :status="doc.status" /></td>
              <td class="numeric amount-cell">
                {{ money(doc.totals.payableAmount, doc.currency) }}
              </td>
              <td>
                <RouterLink
                  :to="`/facturas/${doc.id}`"
                  class="row-link"
                  :aria-label="`Ver ${doc.series}-${doc.number}`"
                  ><AppIcon name="arrow" :size="18"
                /></RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-state">
        <span class="empty-icon"><AppIcon name="invoice" :size="28" /></span>
        <h2>
          {{
            search || status || issuer
              ? 'No encontramos coincidencias'
              : 'Todo empieza con tu primera factura'
          }}
        </h2>
        <p>
          {{
            search
              ? 'La búsqueda se aplica a esta página. Prueba otro cliente o número.'
              : status || issuer
                ? 'Prueba con otro estado o emisor.'
                : 'Cuando emitas un comprobante, podrás seguir su estado y descargar sus archivos aquí.'
          }}
        </p>
        <RouterLink
          v-if="!search && !status && !issuer"
          to="/facturas/nueva"
          class="button button--primary"
          ><AppIcon name="plus" />Crear primera factura</RouterLink
        >
      </div>
      <div class="pagination">
        <span
          >{{
            search
              ? `${visible.length} coincidencias en esta página`
              : `${documents.length} comprobantes en esta página`
          }}<span class="search-note"> · Búsqueda dentro de la página</span></span
        >
        <div class="actions">
          <AppButton
            :disabled="page === 0 || loading"
            variant="quiet"
            aria-label="Página anterior"
            @click="changePage(-1)"
            ><AppIcon name="back" :size="16" /></AppButton
          ><span>Página {{ page + 1 }}</span
          ><AppButton
            :disabled="!more || loading || Boolean(error)"
            variant="quiet"
            aria-label="Página siguiente"
            @click="changePage(1)"
            ><AppIcon name="arrow" :size="16"
          /></AppButton>
        </div>
      </div>
    </template>
    <div v-else class="empty-state">
      <span class="empty-icon"><AppIcon name="invoice" :size="28" /></span>
      <h2>Tu facturación empieza aquí</h2>
      <p>
        Conecta tu organización para ver tus comprobantes, emitir nuevas facturas y revisar sus
        estados.
      </p>
      <RouterLink to="/conexion" class="button button--primary"
        >Conectar mi organización<AppIcon name="arrow" :size="16" /></RouterLink
      ><span class="empty-note">Los datos se consultan directamente desde tu API.</span>
    </div>
  </section>
  <div class="list-footnote">
    <AppIcon name="check" :size="16" /><span
      >Los archivos estarán disponibles cuando termine el procesamiento.</span
    >
  </div>
</template>
<style scoped>
@reference "../../../styles/main.css";
.list-heading {
  @apply flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-5 sm:px-6;
}
.list-heading p {
  @apply mt-1 text-xs text-muted;
}
.filters {
  @apply flex flex-wrap gap-3 border-b border-line p-4 sm:px-6;
}
.search-field {
  @apply relative min-w-48 flex-1;
}
.search-field > svg {
  @apply absolute top-3.5 left-3 text-muted;
}
.search-input {
  @apply pl-10;
}
.filter-field {
  @apply min-w-44 max-w-full;
}
.invoice-number {
  @apply whitespace-nowrap font-semibold text-ink underline-offset-4 hover:text-brand hover:underline;
}
.customer-name {
  @apply block min-w-40 max-w-64 truncate font-medium;
}
.date-cell {
  @apply whitespace-nowrap text-xs text-muted;
}
.amount-cell {
  @apply whitespace-nowrap font-semibold;
}
.row-link {
  @apply inline-flex size-10 items-center justify-center rounded-md text-muted hover:bg-brand-soft hover:text-brand;
}
.pagination {
  @apply flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted;
}
.search-note {
  @apply hidden xl:inline;
}
.list-error {
  @apply p-6;
}
.list-footnote {
  @apply mt-5 flex items-start gap-2 text-xs text-muted;
}
.empty-note {
  @apply mt-4 text-xs text-muted;
}
</style>
