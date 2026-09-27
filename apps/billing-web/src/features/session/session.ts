import { computed, ref } from 'vue';
export interface BrowserSession {
  loginMode?: 'native' | 'central';
  enabled: boolean;
  authenticated: boolean;
  email?: string;
  csrfToken?: string;
  organizations?: { id: string; name: string; role: 'owner' | 'admin' | 'viewer' }[];
  organizationId?: string | null;
  expiresAt?: string;
}
export const session = ref<BrowserSession>({ enabled: false, authenticated: false });
export const sessionError = ref('');
export const connected = computed(
  () => session.value.authenticated && Boolean(session.value.organizationId),
);
export function clearSession(): void {
  session.value = {
    enabled: session.value.enabled,
    loginMode: session.value.loginMode,
    authenticated: false,
  };
}
async function sessionRequest(path: string, body?: object): Promise<Response> {
  const response = await fetch(`/api/v1/auth/${path}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: body
      ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session.value.csrfToken ?? '' }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(
      response.status === 403
        ? 'No tienes acceso a esa organización o tu sesión cambió. Actualiza e inténtalo de nuevo.'
        : 'No pudimos completar la solicitud. Vuelve a intentarlo.',
    );
  }
  return response;
}
export async function refreshSession(): Promise<void> {
  sessionError.value = '';
  try {
    session.value = (await (await sessionRequest('session')).json()) as BrowserSession;
  } catch {
    sessionError.value = 'No pudimos conectar con el servicio de acceso. Vuelve a intentarlo.';
    throw new Error(sessionError.value);
  }
}
export async function selectOrganization(organizationId: string): Promise<void> {
  session.value = (await (
    await sessionRequest('organization', { organizationId })
  ).json()) as BrowserSession;
}
export async function signOut(global = false): Promise<void> {
  const result = (await (await sessionRequest(global ? 'logout-all' : 'logout', {})).json()) as {
    url: string;
  };
  clearSession();
  window.location.assign(result.url);
}
