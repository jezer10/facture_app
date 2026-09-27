<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import NativeAccessForm from './NativeAccessForm.vue';
import {
  connected,
  refreshSession,
  selectOrganization,
  session,
  sessionError,
  signOut,
} from './session';
const router = useRouter();
const route = useRoute();
const busy = ref(false);
const error = ref(
  route.query.error === 'login_failed'
    ? 'No se pudo completar el inicio de sesión. Inténtalo de nuevo.'
    : '',
);
const organizationId = ref(
  session.value.organizationId ?? session.value.organizations?.[0]?.id ?? '',
);
onMounted(() => {
  if (connected.value && route.query.login === 'success') void router.replace('/facturas');
});
async function refresh() {
  busy.value = true;
  try {
    await refreshSession();
    organizationId.value =
      session.value.organizationId ?? session.value.organizations?.[0]?.id ?? '';
  } catch {
    /* Shared error is displayed below. */
  } finally {
    busy.value = false;
  }
}
async function enter() {
  busy.value = true;
  error.value = '';
  try {
    await selectOrganization(organizationId.value);
    await router.push('/facturas');
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'No se pudo seleccionar la organización.';
  } finally {
    busy.value = false;
  }
}
async function logout(global = false) {
  busy.value = true;
  try {
    await signOut(global);
  } catch {
    error.value = 'No pudimos cerrar la sesión. Inténtalo de nuevo.';
    busy.value = false;
  }
}
</script>
<template>
  <header class="page-header">
    <div>
      <h1 tabindex="-1">Tu espacio de facturación</h1>
      <p class="page-description">
        Accede con tu cuenta y elige la organización con la que quieres trabajar.
      </p>
    </div>
  </header>
  <div class="connection-layout">
    <section class="panel">
      <div class="form-section">
        <div v-if="error || sessionError" class="alert alert--error" role="alert">
          {{ error || sessionError }}
        </div>
        <template v-if="sessionError"
          ><h2>No pudimos verificar tu sesión</h2>
          <p class="section-description">Comprueba que el servicio esté disponible.</p>
          <AppButton class="connection-action" :busy="busy" @click="refresh"
            >Volver a intentar</AppButton
          ></template
        >
        <template v-else-if="!session.enabled"
          ><h2>Estamos preparando el acceso</h2>
          <p class="section-description">
            El inicio de sesión centralizado aún no está habilitado en este entorno.
          </p>
          <AppButton class="connection-action" :busy="busy" @click="refresh"
            >Comprobar de nuevo</AppButton
          ></template
        >
        <template v-else-if="!session.authenticated && session.loginMode === 'central'">
          <h2>Entra con tu cuenta de la suite</h2>
          <p class="section-description">
            Continúa a FCTR desde el acceso compartido de tus productos.
          </p>
          <a class="button button--primary connection-action" href="/api/v1/auth/login"
            >Continuar a FCTR</a
          >
        </template>
        <NativeAccessForm v-else-if="!session.authenticated" @authenticated="refresh" />
        <template v-else
          ><h2>Hola, {{ session.email }}</h2>
          <form
            v-if="session.organizations?.length"
            class="connection-fields"
            @submit.prevent="enter"
          >
            <label class="field"
              >Organización<select
                v-model="organizationId"
                class="input"
                required
                aria-label="Organización"
              >
                <option v-for="org in session.organizations" :key="org.id" :value="org.id">
                  {{ org.name }} · {{ org.environment === 'production' ? 'Producción' : 'Sandbox' }}
                </option>
              </select></label
            ><AppButton variant="primary" type="submit" :busy="busy"
              >Entrar a facturas<AppIcon name="arrow" :size="16"
            /></AppButton>
          </form>
          <template v-else
            ><p class="section-description">
              Tu cuenta está lista. Aún no tienes una organización asignada en FCTR.
            </p>
            <p class="connection-note">
              Puedes registrar tu empresa desde Mis empresas o solicitar acceso al administrador de
              una organización existente.
            </p>
            <AppButton class="connection-action" :busy="busy" @click="refresh"
              >Actualizar mis accesos</AppButton
            ></template
          ><AppButton variant="quiet" class="connection-action" :busy="busy" @click="logout(false)"
            >Cerrar sesión</AppButton
          ><AppButton
            v-if="session.loginMode === 'central'"
            variant="quiet"
            class="connection-action"
            :busy="busy"
            @click="logout(true)"
            >Cerrar sesión en todos los productos</AppButton
          ></template
        >
      </div>
    </section>
    <aside class="connection-help">
      <h2>Una cuenta.<br />Tus espacios de trabajo.</h2>
      <p>
        La misma identidad te permitirá acceder a FCTR y a las aplicaciones que se incorporen a la
        plataforma.
      </p>
      <hr />
      <h3>Cada empresa, con su acceso</h3>
      <p>
        Solo verás las organizaciones que te hayan autorizado. Tus permisos determinan qué puedes
        consultar y gestionar.
      </p>
    </aside>
  </div>
  <RouterLink v-if="session.authenticated" to="/empresas" class="button button--secondary"
    >Registrar o consultar mis empresas</RouterLink
  >
</template>
<style scoped>
@reference "../../styles/main.css";
.connection-layout {
  @apply grid max-w-5xl items-start gap-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)];
}
.connection-fields {
  @apply mt-7 grid gap-5;
}
.connection-action {
  @apply mt-6;
}
.connection-note {
  @apply mt-4 text-sm text-muted;
}
.connection-help {
  @apply py-5 text-muted;
}
.connection-help h2 {
  @apply max-w-xs text-2xl leading-snug text-brand;
}
.connection-help h3 {
  @apply text-ink;
}
.connection-help p {
  @apply mt-3 max-w-sm;
}
.connection-help hr {
  @apply my-7 border-line;
}
</style>
