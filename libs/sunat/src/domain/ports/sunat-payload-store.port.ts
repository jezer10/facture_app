export const SUNAT_PAYLOAD_STORE_PORT = Symbol('SUNAT_PAYLOAD_STORE_PORT');

/** Loads an immutable payload by opaque reference and verifies its expected SHA-256. */
export interface SunatPayloadStorePort {
  load(payloadRef: string, expectedSha256: string): Promise<unknown>;
  readiness(): Promise<{ ready: boolean; durable: boolean; detail?: string }>;
}
