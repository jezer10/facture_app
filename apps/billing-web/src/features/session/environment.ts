import { computed, ref } from 'vue';
import { request } from '@/lib/http';
export interface Environment {
  sunat: string;
  email: string;
  fiscalValidity: boolean;
}
export const environment = ref<Environment | null>(null);
export const environmentLabel = computed(() =>
  environment.value?.sunat === 'beta'
    ? 'SUNAT beta'
    : environment.value?.sunat === 'mock'
      ? 'Simulación'
      : 'Entorno sin verificar',
);
export const canIssue = computed(() => ['mock', 'beta'].includes(environment.value?.sunat ?? ''));
export async function refreshEnvironment(): Promise<void> {
  try {
    environment.value = await request<Environment>('/health/mode');
  } catch {
    environment.value = null;
  }
}
