import type { EventEnvelope } from './event-envelope';

export interface PdfRenderPayload {
  readonly documentId: string;
}

export type PdfRenderEnvelope = EventEnvelope<'core.pdf.requested.v1', PdfRenderPayload>;
