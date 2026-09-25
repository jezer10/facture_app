import type { IssuerCredentialHandle } from '../models/sunat-outcome';

export const ISSUER_CREDENTIAL_PORT = Symbol('ISSUER_CREDENTIAL_PORT');

/** Resolves opaque handles only. Secret bytes remain inside infrastructure adapters. */
export interface IssuerCredentialPort {
  resolve(issuerId: string): Promise<IssuerCredentialHandle>;
  readiness(): Promise<{ ready: boolean; durable: boolean; detail?: string }>;
}
