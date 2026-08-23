import type { IssuerCredentialHandle } from '../models/sunat-outcome';

export const SUNAT_CREDENTIAL_VAULT_PORT = Symbol('SUNAT_CREDENTIAL_VAULT_PORT');

export interface SolCredentials {
  readonly ruc: string;
  readonly username: string;
  readonly password: string;
}

export interface CertificateCredentials {
  /** The caller owns this buffer and must zero it after use. */
  readonly pkcs12: Buffer;
  readonly password: string;
}

/** Decrypts secrets only inside the SUNAT process; values never enter jobs or logs. */
export interface SunatCredentialVaultPort {
  loadSolCredentials(handle: IssuerCredentialHandle): Promise<SolCredentials>;
  loadCertificate(handle: IssuerCredentialHandle): Promise<CertificateCredentials>;
}
