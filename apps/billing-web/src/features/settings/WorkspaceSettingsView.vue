<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { request, errorMessage } from '@/lib/http';
import { connected, session } from '@/features/session/session';
import { environment, refreshEnvironment } from '@/features/session/environment';
import { invoiceApi, type InvoiceIssuerOption } from '@/features/invoices/api';
const issuers = ref<InvoiceIssuerOption[]>([]);
const issuerId = ref('');
const busy = ref(false),
  error = ref(''),
  message = ref('');
const credential = ref<{ configured: boolean; hasCertificate?: boolean; version?: number } | null>(
  null,
);
const credentials = reactive({ solUsername: '', solPassword: '', certificatePassword: '' });
const certificate = ref<HTMLInputElement>();
const accountName = ref('Mi integración');
const createdKey = ref<{ id: string; apiKey: string } | null>(null);
const accounts = ref<{ id: string; name: string }[]>([]);
const keys = ref<{ id: string; prefix: string; revoked_at: string | null }[]>([]);
const endpointUrl = ref('');
const webhookSecret = ref('');
const subscriptions = ref<
  { id: string; endpointUrl: string; status: string; eventTypes: string[] }[]
>([]);
const admin = computed(() =>
  ['owner', 'admin'].includes(
    session.value.organizations?.find((org) => org.id === session.value.organizationId)?.role ?? '',
  ),
);
let keyAttempt: { accountId: string; key: string } | null = null;
let webhookId = crypto.randomUUID();
async function load() {
  if (!connected.value) return;
  await refreshEnvironment();
  issuers.value = await invoiceApi.options();
  issuerId.value = issuers.value[0]?.id ?? '';
  if (!admin.value) return;
  const integration = await request<{ accounts: typeof accounts.value; keys: typeof keys.value }>(
    '/workspace/integration',
  );
  accounts.value = integration.accounts;
  keys.value = integration.keys;
  if (environment.value?.environment === 'production' && issuerId.value)
    credential.value = await request(`/issuers/${issuerId.value}/sunat-credentials`);
  subscriptions.value = await request('/webhook-subscriptions');
}
async function run(action: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await action();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => run(load));
async function saveCredentials() {
  await run(async () => {
    const file = certificate.value?.files?.[0];
    if (!file || file.size > 2 * 1024 * 1024)
      throw new Error('Selecciona un certificado P12/PFX de hasta 2 MiB.');
    const certificatePkcs12Base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      await request(`/issuers/${issuerId.value}/sunat-credentials`, {
        method: 'PUT',
        body: JSON.stringify({
          environment: 'production',
          ...credentials,
          certificatePkcs12Base64,
        }),
      });
      message.value =
        'Credenciales guardadas cifradas. Esto no confirma todavía la conexión con SUNAT.';
      credential.value = await request(`/issuers/${issuerId.value}/sunat-credentials`);
    } finally {
      credentials.solPassword = '';
      credentials.certificatePassword = '';
      if (certificate.value) certificate.value.value = '';
    }
  });
}
async function createKey() {
  await run(async () => {
    if (!keyAttempt) {
      const account = await request<{ id: string }>('/service-accounts', {
        method: 'POST',
        body: JSON.stringify({ name: accountName.value }),
      });
      keyAttempt = { accountId: account.id, key: crypto.randomUUID() };
    }
    for (const issuer of issuers.value)
      await request(`/service-accounts/${keyAttempt.accountId}/issuer-grants`, {
        method: 'POST',
        body: JSON.stringify({ issuerId: issuer.id }),
      });
    createdKey.value = await request(`/service-accounts/${keyAttempt.accountId}/api-keys`, {
      method: 'POST',
      headers: { 'Idempotency-Key': keyAttempt.key },
      body: JSON.stringify({ scopes: ['documents:read', 'documents:write'] }),
    });
    keyAttempt = null;
    const integration = await request<{ accounts: typeof accounts.value; keys: typeof keys.value }>(
      '/workspace/integration',
    );
    accounts.value = integration.accounts;
    keys.value = integration.keys;
  });
}
async function revoke(id: string) {
  await run(async () => {
    await request(`/api-keys/${id}`, { method: 'DELETE' });
    if (createdKey.value?.id === id) createdKey.value = null;
    keys.value = keys.value.map((key) =>
      key.id === id ? { ...key, revoked_at: new Date().toISOString() } : key,
    );
  });
}
async function saveWebhook() {
  await run(async () => {
    await request(`/webhook-subscriptions/${webhookId}`, {
      method: 'PUT',
      body: JSON.stringify({
        endpointUrl: endpointUrl.value,
        eventTypes: [
          'fiscal-document.accepted.v1',
          'fiscal-document.rejected.v1',
          'fiscal-document.failed.v1',
          'fiscal-document.voided.v1',
        ],
        enabled: true,
        secret: webhookSecret.value,
      }),
    });
    webhookId = crypto.randomUUID();
    webhookSecret.value = '';
    endpointUrl.value = '';
    subscriptions.value = await request('/webhook-subscriptions');
    message.value = 'Webhook configurado para este ambiente.';
  });
}
async function disableWebhook(subscription: (typeof subscriptions.value)[number]) {
  await run(async () => {
    await request(`/webhook-subscriptions/${subscription.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        endpointUrl: subscription.endpointUrl,
        eventTypes: subscription.eventTypes,
        enabled: false,
      }),
    });
    subscriptions.value = await request('/webhook-subscriptions');
  });
}
</script>
<template>
  <header class="page-header">
    <div>
      <h1 tabindex="-1">Configuración</h1>
      <p class="page-description">Conexión con SUNAT e integraciones de este ambiente.</p>
    </div>
  </header>
  <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
  <p v-if="message" class="alert" role="status">{{ message }}</p>
  <section v-if="!connected" class="panel empty-state">
    <h2>Selecciona una empresa</h2>
    <RouterLink to="/empresas" class="button button--primary">Mis empresas</RouterLink>
  </section>
  <template v-else>
    <section class="panel form-section">
      <h2>SUNAT</h2>
      <p v-if="environment?.environment === 'sandbox'" class="section-description">
        Sandbox usa la conexión oficial de pruebas de SUNAT. No necesitas ingresar tu clave SOL ni
        tu certificado productivo.
      </p>
      <template v-else
        ><p class="section-description">
          Tu empresa está validada. Guarda el usuario SOL de envío, su contraseña y el certificado
          digital. La emisión seguirá bloqueada hasta que la conexión productiva esté habilitada.
        </p>
        <p v-if="credential?.configured" class="hint">
          Credenciales guardadas · versión {{ credential.version }} ·
          {{ credential.hasCertificate ? 'Con certificado' : 'Falta certificado' }}
        </p>
        <form v-if="admin" class="settings-form" @submit.prevent="saveCredentials">
          <fieldset :disabled="busy">
            <label class="field"
              >Emisor<select v-model="issuerId" class="input" required>
                <option v-for="issuer in issuers" :key="issuer.id" :value="issuer.id">
                  {{ issuer.legalName }} · {{ issuer.ruc }}
                </option>
              </select></label
            ><label class="field"
              >Usuario SOL secundario<input
                v-model="credentials.solUsername"
                class="input"
                required
                autocomplete="off"
                maxlength="100" /></label
            ><label class="field"
              >Contraseña SOL<input
                v-model="credentials.solPassword"
                class="input"
                required
                type="password"
                autocomplete="new-password"
                maxlength="300" /></label
            ><label class="field"
              >Certificado digital P12/PFX<input
                ref="certificate"
                class="input"
                type="file"
                accept=".p12,.pfx"
                required /></label
            ><label class="field"
              >Contraseña del certificado<input
                v-model="credentials.certificatePassword"
                class="input"
                type="password"
                required
                autocomplete="new-password"
                maxlength="300" /></label
            ><button class="button button--primary" type="submit">Guardar credenciales</button>
          </fieldset>
        </form>
      </template>
    </section>
    <section class="panel form-section">
      <h2>Correo de comprobantes</h2>
      <p class="section-description">
        Facture gestiona el envío. No necesitas configurar un servidor SMTP.
      </p>
      <p v-if="environment?.email === 'disabled'" class="alert">
        El servicio de correo de Facture todavía no está configurado.
      </p>
      <p v-else-if="environment?.email === 'mailpit'" class="alert">
        Este despliegue usa un buzón local. Los mensajes no llegan a Internet.
      </p>
      <p v-if="environment?.environment === 'sandbox'" class="hint">
        Los mensajes llevan la marca Sandbox y solo se envían a:
        {{ environment.verifiedRecipients.join(', ') || 'ningún destinatario verificado todavía' }}.
      </p>
    </section>
    <section class="panel form-section">
      <h2>API de Facture</h2>
      <p class="section-description">
        Las claves solo tienen acceso a los comprobantes del ambiente seleccionado. Usa otra clave
        para Producción.
      </p>
      <p class="hint">
        Base de la API: <code>/api/v1</code>. Autenticación:
        <code>Authorization: ApiKey &lt;clave&gt;</code>.
      </p>
      <form v-if="admin" class="settings-form" @submit.prevent="createKey">
        <label class="field"
          >Nombre de la integración<input
            v-model="accountName"
            class="input"
            required
            minlength="2"
            maxlength="160"
            :disabled="busy" /></label
        ><button class="button button--primary" :disabled="busy || !issuers.length">
          Crear clave API
        </button>
      </form>
      <label v-if="createdKey" class="field"
        >Copia y guarda tu clave; no se volverá a mostrar<textarea
          class="input"
          readonly
          :value="createdKey.apiKey"
          rows="3"
        />
      </label>
      <ul>
        <li v-for="key in keys" :key="key.id">
          <code>{{ key.prefix }}</code> · {{ key.revoked_at ? 'Revocada' : 'Activa' }}
          <button
            v-if="!key.revoked_at && admin"
            class="button button--quiet"
            :disabled="busy"
            @click="revoke(key.id)"
          >
            Revocar
          </button>
        </li>
      </ul>
    </section>
    <section class="panel form-section">
      <h2>Webhooks</h2>
      <p class="section-description">
        Recibe los cambios de estado en un endpoint HTTPS de tu integración. Configura un destino de
        prueba en Sandbox.
      </p>
      <form v-if="admin" class="settings-form" @submit.prevent="saveWebhook">
        <label class="field"
          >URL del endpoint<input
            v-model="endpointUrl"
            class="input"
            type="url"
            pattern="https://.*"
            required
            :disabled="busy" /></label
        ><label class="field"
          >Secreto de firma<input
            v-model="webhookSecret"
            class="input"
            type="password"
            minlength="32"
            maxlength="512"
            required
            :disabled="busy"
            autocomplete="new-password" /></label
        ><button class="button button--primary" :disabled="busy">Guardar webhook</button>
      </form>
      <ul>
        <li v-for="subscription in subscriptions" :key="subscription.id">
          {{ subscription.endpointUrl }} ·
          {{ subscription.status === 'active' ? 'Activo' : 'Deshabilitado' }}
          <button
            v-if="subscription.status === 'active' && admin"
            class="button button--quiet"
            :disabled="busy"
            @click="disableWebhook(subscription)"
          >
            Deshabilitar
          </button>
        </li>
      </ul>
    </section>
  </template>
</template>
<style scoped>
@reference "../../styles/main.css";
.panel {
  @apply mb-6 max-w-4xl;
}
.settings-form {
  @apply mt-5 max-w-xl;
}
.settings-form fieldset {
  @apply grid gap-4;
}
.field {
  @apply mb-4;
}
ul {
  @apply mt-5 space-y-3 break-words text-sm;
}
</style>
