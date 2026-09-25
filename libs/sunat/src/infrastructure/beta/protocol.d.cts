export interface BetaInput {
  environment: 'beta';
  issuer: { ruc: string; legalName: string };
  customer: { ruc: string; legalName: string };
  series: string;
  number: string;
  issueDate: string;
  description: string;
  netAmount: string;
}
export const BETA_URL: string;
export function buildBetaInvoice(input: BetaInput): {
  xml: string;
  documentId: string;
  fileBase: string;
  total: string;
};
export function signBetaInvoice(xml: string, privateKey: Buffer, certificate: Buffer): string;
export function verifySignature(xml: string, certificate: Buffer): boolean;
export function packageInvoice(fileBase: string, xml: string): Buffer;
export function betaEnvelope(issuerRuc: string, fileBase: string, zip: Buffer): string;
export function sendToBeta(envelope: string): Promise<{ httpStatus: number; body: string }>;
export function parseBetaResponse(
  xml: string,
  documentId: string,
  fileBase: string,
): {
  status: 'soap_fault' | 'accepted_beta' | 'rejected_beta';
  responseCode: string;
  description: string;
  observations?: string[];
  cdrZip?: Buffer;
  cdrXml?: string;
};
