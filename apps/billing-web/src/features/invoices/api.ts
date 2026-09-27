import type {
  AcceptedFiscalDocument,
  CreateFiscalDocumentInput,
  FiscalDocumentView,
  InvoiceIssuerOption,
  PublicDocumentStatus,
} from '@contracts';
import { request } from '@/lib/http';
export type { FiscalDocumentView, InvoiceIssuerOption, PublicDocumentStatus } from '@contracts';
export const invoiceApi = {
  list: (query: {
    offset: number;
    limit: number;
    status?: PublicDocumentStatus;
    issuerId?: string;
  }) => {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== '') params.set(key, String(value));
    });
    return request<FiscalDocumentView[]>(`/fiscal-documents?${params}`);
  },
  get: (id: string) => request<FiscalDocumentView>(`/fiscal-documents/${encodeURIComponent(id)}`),
  options: () => request<InvoiceIssuerOption[]>('/fiscal-documents/creation-options'),
  create: (input: CreateFiscalDocumentInput, key: string) =>
    request<AcceptedFiscalDocument>('/fiscal-documents', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  void: (id: string, reason: string) =>
    request<FiscalDocumentView>(`/fiscal-documents/${encodeURIComponent(id)}/void-requests`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  artifact: (id: string, kind: string) =>
    request<{ url: string }>(
      `/fiscal-documents/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(kind)}`,
    ),
};
