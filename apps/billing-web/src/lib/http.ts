import { session, clearSession } from '@/features/session/session';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method.toUpperCase()))
    headers.set('X-CSRF-Token', session.value.csrfToken ?? '');
  if (init.body) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(20000),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(
      0,
      'No pudimos conectar con el servidor. Revisa la conexión y vuelve a intentarlo.',
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string | string[];
    } | null;
    if (response.status === 401) clearSession();
    const messages: Record<number, string> = {
      401: 'Tu acceso venció o no es válido. Inicia sesión de nuevo.',
      403: 'Tu acceso no tiene permisos para realizar esta acción.',
      404: 'No encontramos este recurso. Puede que todavía no esté disponible.',
      429: 'Hay demasiadas solicitudes. Espera un momento y vuelve a intentarlo.',
    };
    throw new ApiError(
      response.status,
      messages[response.status] ??
        (Array.isArray(body?.message) ? body.message.join('. ') : body?.message) ??
        'No pudimos completar la solicitud. Inténtalo de nuevo.',
    );
  }
  return response.json() as Promise<T>;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado.';
}
