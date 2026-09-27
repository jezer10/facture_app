import { request } from '@/lib/http';
export interface CompanyData {
  ruc: string;
  legalName: string;
  address: string;
  representativeName: string;
  relationship: string;
  authorityExplanation: string;
  series: string;
  declaration: boolean;
}
export interface CompanyRegistration {
  id: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  data: Partial<CompanyData>;
  organization_id: string | null;
  decision_note: string | null;
}
export const emptyCompany = (): CompanyData => ({
  ruc: '',
  legalName: '',
  address: '',
  representativeName: '',
  relationship: '',
  authorityExplanation: '',
  series: 'F001',
  declaration: false,
});
export interface TaxpayerLookup {
  found: boolean;
  source: 'SUNAT';
  sourceDate: string;
  stale: boolean;
  taxpayer?: {
    ruc: string;
    legalName: string;
    address: string;
    status: string;
    condition: string;
    ubigeo: string;
  };
}
export const companyApi = {
  lookup: (ruc: string, signal: AbortSignal) =>
    request<TaxpayerLookup>(`/taxpayer-registry/${encodeURIComponent(ruc)}`, { signal }),
  list: () => request<CompanyRegistration[]>('/company-registrations'),
  save: (id: string, data: CompanyData) =>
    request<CompanyRegistration>(`/company-registrations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  submit: (id: string) =>
    request<CompanyRegistration>(`/company-registrations/${id}/submit`, { method: 'POST' }),
};
export function validRuc(ruc: string): boolean {
  if (!/^(10|15|16|17|20)[0-9]{9}$/.test(ruc)) return false;
  const remainder =
    11 -
    ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce(
      (sum, weight, index) => sum + Number(ruc[index]) * weight,
      0,
    ) %
      11);
  return Number(ruc[10]) === (remainder === 10 ? 0 : remainder === 11 ? 1 : remainder);
}
export function fieldErrors(
  data: CompanyData,
  step: number,
): Partial<Record<keyof CompanyData, string>> {
  const errors: Partial<Record<keyof CompanyData, string>> = {};
  if (step === 0) {
    if (!validRuc(data.ruc)) errors.ruc = 'Revisa los 11 dígitos del RUC.';
    if (data.legalName.trim().length < 3) errors.legalName = 'Escribe la razón social completa.';
    if (data.address.trim().length < 3) errors.address = 'Escribe el domicilio fiscal.';
  }
  if (step === 1) {
    if (data.representativeName.trim().length < 3)
      errors.representativeName = 'Escribe tu nombre completo.';
    if (!data.relationship) errors.relationship = 'Selecciona tu relación con la empresa.';
    if (data.authorityExplanation.trim().length < 20)
      errors.authorityExplanation =
        'Explica cómo comprobar tu autorización (al menos 20 caracteres).';
  }
  if (step === 2 && !/^F[A-Z0-9]{3}$/.test(data.series))
    errors.series = 'Usa 4 caracteres, comenzando con F. Por ejemplo, F001.';
  if (step === 3 && !data.declaration)
    errors.declaration = 'Confirma esta declaración para enviar la solicitud.';
  return errors;
}
