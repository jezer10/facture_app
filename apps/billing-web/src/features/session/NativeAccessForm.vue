<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
type Mode = 'login' | 'register' | 'confirm' | 'forgot' | 'reset' | 'challenge' | 'hosted';
const emit = defineEmits<{ authenticated: [] }>();
const mode = ref<Mode>('login'),
  email = ref(''),
  password = ref(''),
  repeat = ref(''),
  code = ref(''),
  challenge = ref('');
const busy = ref(false),
  showPassword = ref(false),
  error = ref(''),
  message = ref('');
const titles: Record<Mode, string> = {
  login: 'Inicia sesión',
  register: 'Crea tu cuenta',
  confirm: 'Verifica tu correo',
  forgot: 'Recupera tu acceso',
  reset: 'Elige una nueva contraseña',
  challenge: 'Completa la verificación',
  hosted: 'Un paso adicional para tu cuenta',
};
const action = computed(
  () =>
    ({
      login: 'Iniciar sesión',
      register: 'Crear cuenta',
      confirm: 'Verificar correo',
      forgot: 'Enviar código',
      reset: 'Cambiar contraseña',
      challenge: 'Continuar',
      hosted: 'Continuar',
    })[mode.value],
);
const needsPassword = computed(
  () =>
    ['login', 'register', 'reset'].includes(mode.value) ||
    (mode.value === 'challenge' && challenge.value === 'NEW_PASSWORD_REQUIRED'),
);
const newPassword = computed(() => needsPassword.value && mode.value !== 'login');
const needsCode = computed(
  () =>
    ['confirm', 'reset'].includes(mode.value) ||
    (mode.value === 'challenge' && challenge.value !== 'NEW_PASSWORD_REQUIRED'),
);
async function changeMode(next: Mode) {
  mode.value = next;
  password.value = '';
  repeat.value = '';
  code.value = '';
  error.value = '';
  message.value = '';
  showPassword.value = false;
  await nextTick();
  document.querySelector<HTMLElement>('#access-title')?.focus();
}
async function send(path: string, body: object) {
  const response = await fetch(`/api/v1/auth/native/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    step: Mode | 'authenticated';
    message?: string | string[];
    challenge?: string;
  };
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? 'Has realizado varios intentos. Espera un minuto y vuelve a intentarlo.'
        : Array.isArray(result.message)
          ? 'Revisa los campos e inténtalo de nuevo.'
          : result.message || 'No pudimos completar la operación.',
    );
  return result;
}
async function submit(resend = false) {
  error.value = '';
  message.value = '';
  if (!email.value.trim()) {
    error.value = 'Escribe tu correo electrónico.';
    return;
  }
  if (!resend && newPassword.value) {
    if (
      password.value.length < 12 ||
      !/[a-z]/.test(password.value) ||
      !/[A-Z]/.test(password.value) ||
      !/[0-9]/.test(password.value) ||
      !/[\W_]/.test(password.value)
    ) {
      error.value = 'Usa al menos 12 caracteres con mayúsculas, minúsculas, números y símbolos.';
      return;
    }
    if (password.value !== repeat.value) {
      error.value = 'Las contraseñas no coinciden.';
      return;
    }
  }
  busy.value = true;
  const previous = mode.value;
  try {
    const path = resend ? (mode.value === 'reset' ? 'forgot' : 'resend') : mode.value;
    const body: Record<string, string> = { email: email.value.trim().toLowerCase() };
    if (!resend) {
      if (mode.value === 'challenge') delete body.email;
      if (needsPassword.value) body.password = password.value;
      if (needsCode.value) body.code = code.value.trim();
    }
    const result = await send(path, body);
    password.value = '';
    repeat.value = '';
    code.value = '';
    showPassword.value = false;
    if (result.step === 'authenticated') {
      emit('authenticated');
      return;
    }
    mode.value = result.step;
    challenge.value = result.challenge ?? '';
    message.value = typeof result.message === 'string' ? result.message : '';
    await nextTick();
    document.querySelector<HTMLElement>('#access-title')?.focus();
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'No pudimos conectar. Inténtalo de nuevo.';
    password.value = '';
    repeat.value = '';
    if (previous === 'challenge') {
      mode.value = 'login';
      code.value = '';
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="native-access">
    <h2 id="access-title" tabindex="-1">{{ titles[mode] }}</h2>
    <p class="section-description">
      {{
        mode === 'login'
          ? 'Accede con tu cuenta de la plataforma.'
          : mode === 'confirm'
            ? 'Introduce el código de seis dígitos que recibiste por correo.'
            : mode === 'forgot'
              ? 'Te enviaremos las instrucciones si el correo tiene una cuenta recuperable.'
              : mode === 'reset'
                ? 'Introduce el código recibido y una contraseña nueva.'
                : mode === 'register'
                  ? 'Usarás esta cuenta para acceder a tus empresas.'
                  : 'Completa el paso de seguridad solicitado para tu cuenta.'
      }}
    </p>
    <p v-if="error" class="alert alert--error access-message" role="alert">{{ error }}</p>
    <p v-if="message" class="alert alert--success access-message" role="status">{{ message }}</p>
    <template v-if="mode === 'hosted'"
      ><a class="button button--primary access-message" href="/api/v1/auth/login"
        >Continuar por el acceso seguro</a
      ></template
    >
    <form v-else class="access-fields" @submit.prevent="submit()">
      <fieldset :disabled="busy" class="access-fields">
        <label v-if="mode !== 'challenge'" class="field" for="access-email"
          >Correo electrónico<input
            id="access-email"
            v-model.trim="email"
            type="email"
            class="input"
            autocomplete="username"
            maxlength="254"
            required
        /></label>
        <label v-if="needsCode" class="field" for="access-code"
          >Código de verificación<input
            id="access-code"
            v-model="code"
            class="input"
            inputmode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]{6}"
            maxlength="6"
            required
        /></label>
        <label v-if="needsPassword" class="field" for="access-password"
          >{{ newPassword ? 'Nueva contraseña' : 'Contraseña'
          }}<input
            id="access-password"
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="input"
            :autocomplete="newPassword ? 'new-password' : 'current-password'"
            :minlength="newPassword ? 12 : 1"
            maxlength="256"
            required
            aria-describedby="password-help"
        /></label>
        <p v-if="newPassword" id="password-help" class="hint">
          Al menos 12 caracteres, con mayúsculas, minúsculas, números y símbolos.
        </p>
        <label v-if="newPassword" class="field" for="access-repeat"
          >Repite la contraseña<input
            id="access-repeat"
            v-model="repeat"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="new-password"
            class="input"
            maxlength="256"
            required
        /></label>
        <label v-if="needsPassword" class="show-password"
          ><input v-model="showPassword" type="checkbox" />Mostrar contraseña</label
        >
        <button class="button button--primary" type="submit">
          {{ busy ? 'Procesando…' : action }}
        </button>
      </fieldset>
    </form>
    <div class="access-links">
      <template v-if="mode === 'login'"
        ><button type="button" class="text-link" :disabled="busy" @click="changeMode('forgot')">
          Olvidé mi contraseña</button
        ><button type="button" class="text-link" :disabled="busy" @click="changeMode('register')">
          Crear una cuenta
        </button></template
      >
      <template v-else
        ><button
          v-if="mode === 'confirm' || mode === 'reset'"
          type="button"
          class="text-link"
          :disabled="busy"
          @click="submit(true)"
        >
          Enviar otro código</button
        ><button type="button" class="text-link" :disabled="busy" @click="changeMode('login')">
          Volver a iniciar sesión
        </button></template
      >
    </div>
  </div>
</template>
<style scoped>
@reference "../../styles/main.css";
.access-fields {
  @apply grid gap-4;
}
form.access-fields {
  @apply mt-6;
}
.access-message {
  @apply mt-5;
}
.access-links {
  @apply mt-6 flex flex-wrap justify-between gap-4 text-sm;
}
.show-password {
  @apply flex items-center gap-2 text-sm text-muted;
}
.show-password input {
  @apply size-4 accent-brand;
}
</style>
