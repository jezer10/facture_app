import { SunatCredentialUnavailableError } from '../../domain/errors/sunat.error';
import type { IssuerCredentialHandle } from '../../domain/models/sunat-outcome';
import type { IssuerCredentialPort } from '../../domain/ports/issuer-credential.port';

export class MockIssuerCredentialAdapter implements IssuerCredentialPort {
  private readonly enabledIssuers = new Set<string>();

  constructor(
    issuerIds: readonly string[] = [],
    private readonly allowAnyIssuer = false,
  ) {
    issuerIds.forEach((issuerId) => this.enable(issuerId));
  }

  enable(issuerId: string): void {
    const normalized = issuerId.trim();
    if (normalized) {
      this.enabledIssuers.add(normalized);
    }
  }

  resolve(issuerId: string): Promise<IssuerCredentialHandle> {
    if (!this.allowAnyIssuer && !this.enabledIssuers.has(issuerId)) {
      return Promise.reject(
        new SunatCredentialUnavailableError(
          'El emisor no está habilitado en el proveedor SUNAT mock.',
        ),
      );
    }
    return Promise.resolve({
      issuerId,
      credentialVersion: 1,
      environment: 'mock' as const,
      certificateReference: null,
      certificateFingerprint: null,
      solCredentialReference: null,
    });
  }

  readiness(): Promise<{
    ready: true;
    durable: false;
    detail: string;
  }> {
    return Promise.resolve({
      ready: true,
      durable: false,
      detail: this.allowAnyIssuer
        ? 'Credenciales mock sin secretos habilitadas para cualquier emisor; sólo desarrollo.'
        : 'Credenciales efímeras sin secretos, exclusivas del modo mock.',
    });
  }
}
