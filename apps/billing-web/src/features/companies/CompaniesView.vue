<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { session, refreshSession, selectOrganization } from '@/features/session/session';
import { errorMessage } from '@/lib/http';
import {
  companyApi,
  emptyCompany,
  fieldErrors,
  type CompanyData,
  type CompanyRegistration,
} from './api';
import { useRucLookup } from './useRucLookup';
const router = useRouter();
const registrations = ref<CompanyRegistration[]>([]);
const loading = ref(true),
  busy = ref(false),
  editing = ref(false),
  error = ref(''),
  message = ref('');
const id = ref(''),
  step = ref(0),
  lastSaved = ref('');
const form = reactive<CompanyData>(emptyCompany());
const { lookup, searching, lookupError, search } = useRucLookup(form, editing, step);
const errors = ref<Partial<Record<keyof CompanyData, string>>>({});
const steps = ['Tu empresa', 'Tu autorización', 'Facturación', 'Revisar y enviar'];
const labels = {
  draft: 'Borrador',
  pending: 'En revisión',
  approved: 'Verificada',
  rejected: 'No aprobada',
};
const relationships = {
  owner: 'Titular',
  representative: 'Representante legal',
  authorized: 'Persona autorizada',
};
async function load() {
  loading.value = true;
  error.value = '';
  try {
    if (session.value.authenticated) registrations.value = await companyApi.list();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
function corrected(record: CompanyRegistration) {
  edit({ ...record, id: crypto.randomUUID(), status: 'draft' });
}
function edit(record?: CompanyRegistration) {
  Object.assign(form, emptyCompany(), record?.data ?? {});
  id.value = record?.id ?? crypto.randomUUID();
  step.value = 0;
  errors.value = {};
  error.value = '';
  message.value = '';
  lastSaved.value = JSON.stringify(form);
  editing.value = true;
  void focusHeading();
}
async function focusHeading() {
  await nextTick();
  document.querySelector<HTMLElement>('#step-title')?.focus();
}
async function focusError() {
  await nextTick();
  document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
async function save(): Promise<boolean> {
  try {
    const saved = await companyApi.save(id.value, { ...form });
    registrations.value = [saved, ...registrations.value.filter((item) => item.id !== saved.id)];
    lastSaved.value = JSON.stringify(form);
    return true;
  } catch (e) {
    error.value = errorMessage(e);
    return false;
  }
}
async function saveAndExit() {
  busy.value = true;
  error.value = '';
  try {
    if (await save()) {
      editing.value = false;
      message.value = 'Borrador guardado. Puedes continuar cuando quieras.';
    }
  } finally {
    busy.value = false;
  }
}
async function advance() {
  error.value = '';
  if (searching.value && step.value === 0) return;
  errors.value = fieldErrors(form, step.value);
  if (Object.keys(errors.value).length) {
    await focusError();
    return;
  }
  busy.value = true;
  try {
    if (!(await save())) return;
    if (step.value < 3) {
      step.value++;
      await focusHeading();
      return;
    }
    // Revalidate every step before submission, including drafts restored from the server.
    for (let index = 0; index < 4; index++) {
      const invalid = fieldErrors(form, index);
      if (Object.keys(invalid).length) {
        step.value = index;
        errors.value = invalid;
        await focusError();
        return;
      }
    }
    const submitted = await companyApi.submit(id.value);
    registrations.value = registrations.value.map((item) =>
      item.id === submitted.id ? submitted : item,
    );
    editing.value = false;
    message.value = 'Solicitud enviada a revisión. Todavía no habilita la emisión de facturas.';
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function openCompany(record: CompanyRegistration) {
  if (!record.organization_id) return;
  busy.value = true;
  error.value = '';
  try {
    await refreshSession();
    await selectOrganization(record.organization_id);
    await router.push('/facturas');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onBeforeRouteLeave(() => {
  if (busy.value) return false;
  if (editing.value && JSON.stringify(form) !== lastSaved.value)
    return window.confirm('Hay cambios sin guardar. ¿Quieres salir sin guardarlos?');
  return true;
});
</script>
<template>
  <header class="page-header">
    <div>
      <h1 tabindex="-1">{{ editing ? 'Registrar mi empresa' : 'Mis empresas' }}</h1>
      <p class="page-description">
        {{
          editing
            ? 'Avanza a tu ritmo. Guardaremos cada paso al continuar.'
            : 'Registra una empresa y acredita tu autorización para administrarla.'
        }}
      </p>
    </div>
    <button
      v-if="session.authenticated && !editing && !loading"
      class="button button--primary"
      @click="edit()"
    >
      Registrar empresa
    </button>
  </header>
  <p v-if="error" role="alert" class="alert alert--error">{{ error }}</p>
  <p v-if="message" role="status" class="alert alert--success">{{ message }}</p>
  <section v-if="!session.authenticated" class="panel empty-state">
    <h2>Inicia sesión para registrar tu empresa</h2>
    <p>Tu solicitud quedará asociada a tu cuenta, aunque todavía no tengas una organización.</p>
    <RouterLink to="/conexion" class="button button--primary">Iniciar sesión</RouterLink>
  </section>
  <p v-else-if="loading" role="status">Cargando tus solicitudes…</p>
  <div v-else-if="editing" class="registration-layout">
    <aside class="progress-panel" aria-label="Progreso del registro">
      <ol class="steps">
        <li
          v-for="(label, index) in steps"
          :key="label"
          :class="{ current: index === step, completed: index < step }"
          :aria-current="index === step ? 'step' : undefined"
        >
          <span class="step-number">{{ index + 1 }}</span
          ><span>{{ label }}</span>
        </li>
      </ol>
      <div class="progress-help">
        <h2>Tu empresa, protegida</h2>
        <p>
          Conocer un RUC no otorga acceso. Revisaremos tu autorización antes de crear la empresa y
          habilitar su emisor.
        </p>
        <p>Un borrador no reserva el RUC ni bloquea a su titular.</p>
      </div>
    </aside>
    <form class="panel wizard" novalidate @submit.prevent="advance">
      <fieldset class="form-section" :disabled="busy">
        <p class="hint">Paso {{ step + 1 }} de 4</p>
        <h2 id="step-title" tabindex="-1">{{ steps[step] }}</h2>
        <div v-if="step === 0" class="wizard-fields">
          <p class="section-description">
            Ingresa el RUC y completaremos los datos disponibles en el padrón oficial de SUNAT. Tu
            autorización para administrar la empresa se revisa por separado.
          </p>
          <label class="field" for="company-ruc"
            >RUC<input
              id="company-ruc"
              @input="
                form.legalName = '';
                form.address = '';
              "
              v-model.trim="form.ruc"
              class="input"
              inputmode="numeric"
              maxlength="11"
              autocomplete="off"
              :aria-invalid="!!errors.ruc"
              aria-describedby="ruc-help ruc-error"
            /><span id="ruc-help" class="hint">11 dígitos, sin espacios ni guiones.</span
            ><span v-if="errors.ruc" id="ruc-error" class="field-error">{{
              errors.ruc
            }}</span></label
          >
          <div aria-live="polite" class="registry-result">
            <p v-if="searching" role="status">Consultando el padrón de SUNAT…</p>
            <template v-else-if="lookup">
              <p>
                <strong>{{
                  lookup.found
                    ? 'Datos encontrados en SUNAT'
                    : 'RUC no encontrado en esta copia del padrón'
                }}</strong>
              </p>
              <p class="hint">
                Padrón del {{ lookup.sourceDate.split('-').reverse().join('/') }} · No es una
                consulta en vivo.
              </p>
              <p v-if="lookup.taxpayer" class="registry-status">
                Estado: {{ lookup.taxpayer.status }} · Condición:
                {{ lookup.taxpayer.condition || 'No informada' }}
              </p>
              <p v-if="lookup.taxpayer && !lookup.taxpayer.address" class="hint">
                Este registro no incluye domicilio. Complétalo con tu ficha RUC.
              </p>
              <p v-if="lookup.stale" class="hint">
                Esta copia tiene más de 7 días. Los cambios recientes podrían no aparecer.
              </p>
              <p v-if="!lookup.found" class="hint">
                Esto no demuestra que el RUC no exista. Revisa los dígitos o completa los datos para
                su revisión.
              </p>
            </template>
            <template v-else-if="lookupError"
              ><p class="hint">{{ lookupError }}</p>
              <button type="button" class="button button--quiet" @click="search">
                Reintentar consulta
              </button></template
            >
          </div>
          <label class="field" for="company-name"
            >Razón social<input
              id="company-name"
              v-model.trim="form.legalName"
              class="input"
              maxlength="200"
              autocomplete="organization"
              :aria-invalid="!!errors.legalName"
              aria-describedby="name-error"
            /><span v-if="errors.legalName" id="name-error" class="field-error">{{
              errors.legalName
            }}</span></label
          >
          <label class="field" for="company-address"
            >Domicilio fiscal<textarea
              id="company-address"
              v-model.trim="form.address"
              class="input"
              rows="2"
              maxlength="400"
              autocomplete="street-address"
              :aria-invalid="!!errors.address"
              aria-describedby="address-error"
            /><span v-if="errors.address" id="address-error" class="field-error">{{
              errors.address
            }}</span></label
          >
        </div>
        <div v-if="step === 1" class="wizard-fields">
          <p class="section-description">
            Necesitamos comprobar que puedes actuar por esta empresa. Esta información se revisará
            manualmente; tu declaración por sí sola no aprueba la solicitud.
          </p>
          <label class="field" for="representative-name"
            >Tu nombre completo<input
              id="representative-name"
              v-model.trim="form.representativeName"
              class="input"
              maxlength="160"
              autocomplete="name"
              :aria-invalid="!!errors.representativeName"
              aria-describedby="representative-error"
            /><span
              v-if="errors.representativeName"
              id="representative-error"
              class="field-error"
              >{{ errors.representativeName }}</span
            ></label
          >
          <label class="field" for="relationship"
            >Tu relación con la empresa<select
              id="relationship"
              v-model="form.relationship"
              class="input"
              :aria-invalid="!!errors.relationship"
              aria-describedby="relationship-error"
            >
              <option value="">Selecciona una opción</option>
              <option v-for="(label, key) in relationships" :key="key" :value="key">
                {{ label }}
              </option></select
            ><span v-if="errors.relationship" id="relationship-error" class="field-error">{{
              errors.relationship
            }}</span></label
          >
          <label class="field" for="authority"
            >¿Cómo podemos comprobar tu autorización?<textarea
              id="authority"
              v-model.trim="form.authorityExplanation"
              class="input"
              rows="4"
              maxlength="1500"
              :aria-invalid="!!errors.authorityExplanation"
              aria-describedby="authority-help authority-error"
            /><span id="authority-help" class="hint"
              >Por ejemplo, indica si figuras como representante o cuentas con un poder. No incluyas
              contraseñas, clave SOL ni imágenes de documentos. Si se necesita evidencia adicional,
              se coordinará por un canal seguro.</span
            ><span v-if="errors.authorityExplanation" id="authority-error" class="field-error">{{
              errors.authorityExplanation
            }}</span></label
          >
        </div>
        <div v-if="step === 2" class="wizard-fields">
          <p class="section-description">
            Prepara tu primera serie de facturas. Se creará únicamente cuando se apruebe la empresa.
          </p>
          <label class="field" for="invoice-series"
            >Serie de facturas<input
              id="invoice-series"
              v-model.trim="form.series"
              class="input"
              maxlength="4"
              :aria-invalid="!!errors.series"
              aria-describedby="series-help series-error"
              @input="form.series = form.series.toUpperCase()"
            /><span id="series-help" class="hint"
              >Por ejemplo, F001. El primer correlativo será 1. Usa una serie nueva que no tenga
              comprobantes emitidos.</span
            ><span v-if="errors.series" id="series-error" class="field-error">{{
              errors.series
            }}</span></label
          >
          <div class="registration-note">
            La conexión con SUNAT y sus credenciales se configuran por separado. No se enviará
            ningún comprobante al registrar esta solicitud.
          </div>
        </div>
        <div v-if="step === 3" class="wizard-fields">
          <p class="section-description">
            Comprueba los datos antes de enviarlos. Una vez en revisión, la solicitud no se puede
            editar.
          </p>
          <dl class="summary">
            <dt>RUC</dt>
            <dd>{{ form.ruc }}</dd>
            <dt>Razón social</dt>
            <dd>{{ form.legalName }}</dd>
            <dt>Domicilio</dt>
            <dd>{{ form.address }}</dd>
            <dt>Solicitante</dt>
            <dd>{{ form.representativeName }}</dd>
            <dt>Relación</dt>
            <dd>{{ relationships[form.relationship as keyof typeof relationships] }}</dd>
            <dt>Autorización</dt>
            <dd>{{ form.authorityExplanation }}</dd>
            <dt>Serie / inicio</dt>
            <dd>{{ form.series }} / 1</dd>
          </dl>
          <label class="declaration"
            ><input
              v-model="form.declaration"
              type="checkbox"
              :aria-invalid="!!errors.declaration"
              aria-describedby="declaration-error"
            /><span
              >Declaro que los datos son correctos y que tengo autorización para solicitar la
              administración de esta empresa.</span
            ></label
          ><span v-if="errors.declaration" id="declaration-error" class="field-error">{{
            errors.declaration
          }}</span>
          <p class="hint">
            Si el RUC ya está registrado, revisaremos el caso sin transferirte la empresa ni darte
            acceso automáticamente.
          </p>
        </div>
      </fieldset>
      <div class="wizard-actions">
        <button type="button" class="button button--quiet" :disabled="busy" @click="saveAndExit">
          Guardar y salir
        </button>
        <div class="actions">
          <button
            v-if="step > 0"
            type="button"
            class="button button--secondary"
            :disabled="busy"
            @click="
              step--;
              errors = {};
              focusHeading();
            "
          >
            Atrás</button
          ><button type="submit" class="button button--primary" :disabled="busy || searching">
            {{ busy ? 'Guardando…' : step === 3 ? 'Enviar a revisión' : 'Guardar y continuar' }}
          </button>
        </div>
      </div>
    </form>
  </div>
  <div v-else>
    <section v-if="!registrations.length" class="panel empty-state">
      <h2>Empieza con los datos de tu empresa</h2>
      <p>Completa cuatro pasos sencillos. Podrás guardar el avance y volver después.</p>
      <button class="button button--primary" @click="edit()">Registrar mi empresa</button>
    </section>
    <div v-else class="company-list">
      <article v-for="record in registrations" :key="record.id" class="panel company-card">
        <div class="company-heading">
          <h2>{{ record.data.legalName || 'Empresa sin nombre' }}</h2>
          <span class="company-status" :class="`status-${record.status}`">{{
            labels[record.status]
          }}</span>
        </div>
        <p class="hint">{{ record.data.ruc ? `RUC ${record.data.ruc}` : 'RUC pendiente' }}</p>
        <p v-if="record.status === 'pending'" class="company-description">
          Revisaremos los datos y tu autorización. Todavía no puedes emitir facturas con esta
          solicitud.
        </p>
        <p v-if="record.decision_note" class="company-description">{{ record.decision_note }}</p>
        <div class="company-actions">
          <button
            v-if="record.status === 'draft'"
            class="button button--secondary"
            @click="edit(record)"
          >
            Continuar registro</button
          ><button
            v-if="record.status === 'rejected'"
            class="button button--secondary"
            @click="corrected(record)"
          >
            Crear solicitud corregida</button
          ><button
            v-if="record.status === 'approved'"
            class="button button--primary"
            :disabled="busy"
            @click="openCompany(record)"
          >
            Abrir empresa
          </button>
        </div>
      </article>
    </div>
    <button class="button button--quiet refresh" :disabled="busy" @click="load">
      Actualizar estado
    </button>
  </div>
</template>
<style scoped>
@reference "../../styles/main.css";
.registration-layout {
  @apply grid items-start gap-7 lg:grid-cols-[240px_minmax(0,720px)];
}
.progress-panel {
  @apply lg:sticky lg:top-8;
}
.steps {
  @apply grid grid-cols-2 gap-3 lg:grid-cols-1 lg:gap-5;
}
.steps li {
  @apply flex items-center gap-3 text-sm text-muted;
}
.step-number {
  @apply flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-sm;
}
.current {
  @apply font-semibold text-brand!;
}
.current .step-number {
  @apply border-brand bg-brand text-white;
}
.completed .step-number {
  @apply border-brand bg-brand-soft text-brand;
}
.progress-help {
  @apply mt-8 hidden border-t border-line pt-6 text-sm leading-relaxed text-muted lg:block;
}
.progress-help h2 {
  @apply mb-3 text-base text-ink;
}
.progress-help p + p {
  @apply mt-3;
}
.wizard h2 {
  @apply mt-2;
}
.wizard-fields {
  @apply mt-5 grid gap-5;
}
.field-error {
  @apply text-sm font-normal text-danger;
}
.input[aria-invalid='true'] {
  @apply border-danger;
}
.wizard-actions {
  @apply flex flex-wrap items-center justify-between gap-3 p-5 sm:p-7;
}
.registration-note {
  @apply border-l-2 border-brand bg-brand-soft p-4 text-sm leading-relaxed;
}
.summary {
  @apply grid gap-x-5 gap-y-2 text-sm sm:grid-cols-[140px_minmax(0,1fr)];
}
.summary dt {
  @apply text-muted;
}
.summary dd {
  @apply mb-3 break-words font-medium;
}
.declaration {
  @apply flex items-start gap-3 text-sm leading-relaxed;
}
.declaration input {
  @apply mt-1 size-4 shrink-0 accent-brand;
}
.company-list {
  @apply grid max-w-4xl gap-4;
}
.company-card {
  @apply p-6;
}
.company-heading {
  @apply mb-2 flex flex-wrap items-center justify-between gap-3;
}
.company-heading h2 {
  @apply text-lg;
}
.company-status {
  @apply rounded-md bg-canvas px-3 py-1 text-xs font-semibold;
}
.status-pending {
  @apply bg-amber-50 text-warning;
}
.status-approved {
  @apply bg-brand-soft text-brand;
}
.status-rejected {
  @apply bg-red-50 text-danger;
}
.company-description {
  @apply mt-4 max-w-2xl text-sm leading-relaxed text-muted;
}
.company-actions {
  @apply mt-4;
}
.refresh {
  @apply mt-5;
}
.registry-result:empty {
  @apply hidden;
}
.registry-result {
  @apply border-l-2 border-brand pl-4 text-sm leading-relaxed;
}
.registry-status {
  @apply mt-2 text-sm;
}
</style>
