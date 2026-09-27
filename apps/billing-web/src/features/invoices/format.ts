import type { PublicDocumentStatus } from '@contracts';
export const statuses: Record<PublicDocumentStatus, { label: string; tone: string }> = {
  queued: { label: 'En cola', tone: 'neutral' },
  processing: { label: 'Procesando', tone: 'info' },
  accepted: { label: 'Aceptada', tone: 'success' },
  accepted_with_observations: { label: 'Con observaciones', tone: 'warning' },
  rejected: { label: 'Rechazada', tone: 'danger' },
  failed: { label: 'Error de envío', tone: 'danger' },
  void_pending: { label: 'Anulación pendiente', tone: 'warning' },
  voided: { label: 'Anulada', tone: 'neutral' },
};
export function money(value: string | undefined, currency = 'PEN'): string {
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency }).format(
    Number(value ?? '0'),
  );
}
export function date(value: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
}
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}
export function documentName(type: string): string {
  return (
    (
      {
        '01': 'Factura',
        '03': 'Boleta',
        '07': 'Nota de crédito',
        '08': 'Nota de débito',
      } as Record<string, string>
    )[type] ?? 'Comprobante'
  );
}
