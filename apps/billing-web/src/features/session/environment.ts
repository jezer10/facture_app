import { computed, ref } from 'vue';
import { request } from '@/lib/http';
import { session } from './session';
export interface Environment {
  id: string;
  environment: 'sandbox' | 'production';
  sunat: string;
  email: string;
  fiscalValidity: boolean;
  canIssue: boolean;
  message: string;
  verifiedRecipients: string[];
  capabilities: { documentTypes: string[]; voids: boolean; received: boolean };
}
export const environment = ref<Environment | null>(null);
export const environmentLabel = computed(() =>
  environment.value?.environment === 'production'
    ? 'Producción'
    : environment.value
      ? 'Sandbox'
      : 'Selecciona una empresa',
);
export const canIssue = computed(
  () =>
    environment.value?.id === session.value.organizationId && environment.value?.canIssue === true,
);
let revision = 0;
export async function refreshEnvironment(): Promise<void> {
  const current = ++revision;
  const organizationId = session.value.organizationId;
  environment.value = null;
  if (!organizationId) return;
  try {
    const result = await request<Environment>('/workspace');
    if (current === revision && session.value.organizationId === organizationId)
      environment.value = result;
  } catch {
    /* No verified context means issuance remains disabled. */
  }
}
