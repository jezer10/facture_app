<script setup lang="ts">
import { watch, ref } from 'vue';
import AppIcon from '@/components/ui/AppIcon.vue';
import { session, signOut, selectOrganization } from '@/features/session/session';
import { environment, environmentLabel, refreshEnvironment } from '@/features/session/environment';
const logoutError = ref('');
watch(() => session.value.organizationId, refreshEnvironment, { immediate: true });
const switching = ref(false);
async function switchWorkspace(event: Event) {
  const target = (event.target as HTMLSelectElement).value;
  switching.value = true;
  try {
    await selectOrganization(target);
  } catch {
    logoutError.value = 'No pudimos cambiar de ambiente. Vuelve a intentarlo.';
  } finally {
    switching.value = false;
  }
}
async function disconnect() {
  logoutError.value = '';
  try {
    await signOut();
  } catch {
    logoutError.value = 'No pudimos cerrar la sesión. Inténtalo de nuevo.';
  }
}
</script>
<template>
  <a class="skip-link" href="#main">Saltar al contenido</a>
  <div class="app-shell">
    <aside class="sidebar">
      <RouterLink to="/facturas" class="brand" aria-label="FCTR, inicio">
        <img class="brand-mark" src="/brand/fctr-symbol.svg" alt="" width="32" height="37" />
        <span>FCTR</span>
      </RouterLink>
      <div class="workspace-label">Tu espacio de facturación</div>
      <nav aria-label="Navegación principal" class="navigation">
        <RouterLink
          to="/facturas"
          class="nav-link"
          :class="{ 'nav-link--active': $route.path.startsWith('/facturas') }"
          ><AppIcon name="invoice" />Comprobantes</RouterLink
        >
        <RouterLink to="/empresas" class="nav-link"
          ><AppIcon name="connection" />Mis empresas</RouterLink
        >
        <RouterLink to="/conexion" class="nav-link"
          ><AppIcon name="connection" />Mi cuenta</RouterLink
        >
        <RouterLink to="/configuracion" class="nav-link"
          ><AppIcon name="connection" />Configuración</RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <span class="sidebar-note">Cada comprobante,<br />en su lugar.</span>
        <div class="sidebar-version">FCTR · Panel de gestión</div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <label v-if="session.organizations?.length" class="topbar-label"
          >Empresa y ambiente
          <select
            class="input"
            aria-label="Empresa y ambiente"
            :value="session.organizationId ?? ''"
            :disabled="switching || $route.path === '/facturas/nueva'"
            @change="switchWorkspace"
          >
            <option disabled value="">Selecciona un ambiente</option>
            <option v-for="org in session.organizations" :key="org.id" :value="org.id">
              {{ org.name }} · {{ org.environment === 'production' ? 'Producción' : 'Sandbox' }}
            </option>
          </select> </label
        ><span v-else class="topbar-label">Facturación electrónica</span>
        <div class="topbar-actions">
          <span class="environment"><span class="environment-dot" />{{ environmentLabel }}</span
          ><button v-if="session.authenticated" class="disconnect" @click="disconnect">
            <AppIcon name="logout" :size="17" /><span>Cerrar sesión</span></button
          ><RouterLink v-else to="/conexion" class="text-link">Iniciar sesión</RouterLink>
        </div>
      </header>
      <div v-if="environment" class="environment-notice">
        {{ environment.message }}
      </div>
      <main id="main" class="main">
        <p v-if="logoutError" class="alert alert--error" role="alert">{{ logoutError }}</p>
        <RouterView
          :key="$route.path === '/conexion' ? 'connection' : String(session.organizationId)"
        />
      </main>
      <footer class="footer">
        Hecho para llevar tus facturas al día.<span>Perú · PEN / USD</span>
      </footer>
    </div>
  </div>
</template>
<style scoped>
@reference "../styles/main.css";
.app-shell {
  @apply min-h-screen lg:grid lg:grid-cols-[232px_minmax(0,1fr)];
}
.sidebar {
  @apply flex flex-col border-b border-line bg-[#eef1eb] px-5 py-5 lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-b-0 lg:px-6 lg:py-8;
}
.brand {
  @apply flex w-fit items-center gap-3 text-2xl font-bold tracking-tight;
}
.brand-mark {
  width: 27px;
  height: 32px;
  flex-shrink: 0;
}
.workspace-label {
  @apply mt-6 hidden text-xs text-muted lg:block;
}
.navigation {
  @apply mt-5 flex flex-wrap gap-2 lg:mt-8 lg:flex-col;
}
.nav-link {
  @apply flex min-h-11 items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium text-muted transition-colors hover:bg-white/70 hover:text-brand;
}
.nav-link.router-link-active,
.nav-link--active {
  @apply bg-white text-brand shadow-[0_1px_3px_0_#202d2908];
}
.sidebar-bottom {
  @apply mt-auto hidden pt-10 lg:block;
}
.sidebar-note {
  @apply text-xl font-medium leading-relaxed tracking-tight text-brand;
}
.sidebar-version {
  @apply mt-6 border-t border-line pt-5 text-[11px] text-muted;
}
.workspace {
  @apply flex min-w-0 flex-col;
}
.topbar {
  @apply flex min-h-18 flex-wrap items-center justify-between gap-3 border-b border-line bg-paper px-5 py-4 sm:px-9;
}
.topbar-label {
  @apply text-xs font-medium text-muted;
}
.topbar-actions {
  @apply flex items-center gap-5 text-xs;
}
.environment {
  @apply inline-flex items-center gap-2 text-muted;
}
.environment-dot {
  @apply size-1.5 rounded-full bg-warning;
}
.disconnect {
  @apply flex min-h-9 items-center gap-2 text-muted hover:text-brand;
}
.environment-notice {
  @apply border-b border-line bg-[#f3f1e8] px-5 py-2.5 text-center text-xs text-[#726039];
}
.main {
  @apply mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 sm:px-9 sm:py-10 lg:px-12;
}
.footer {
  @apply flex flex-wrap justify-between gap-2 px-5 py-5 text-[11px] text-muted sm:px-9 lg:px-12;
}
.skip-link {
  @apply sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:h-auto focus:w-auto focus:bg-paper focus:p-4;
}
</style>
