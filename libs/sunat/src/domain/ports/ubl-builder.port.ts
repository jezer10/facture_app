import type { FiscalDocumentSnapshot } from '../models/fiscal-document';
import type { UnsignedUblDocument } from '../models/sunat-outcome';

export const UBL_BUILDER_PORT = Symbol('UBL_BUILDER_PORT');

export interface UblBuilderPort {
  build(snapshot: FiscalDocumentSnapshot): UnsignedUblDocument;
}
