import type {
  IssuerCredentialHandle,
  SignedUblDocument,
  UnsignedUblDocument,
} from '../models/sunat-outcome';

export const XML_SIGNER_PORT = Symbol('XML_SIGNER_PORT');

export interface XmlSignerPort {
  sign(
    document: UnsignedUblDocument,
    credentials: IssuerCredentialHandle,
  ): Promise<SignedUblDocument>;

  readiness(): {
    ready: boolean;
    mode: 'mock_unsigned' | 'signed' | 'unavailable';
    detail?: string;
  };
}
