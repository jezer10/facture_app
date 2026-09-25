import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { ObjectStoragePort } from '@app/platform';
// Keep the mutable CommonJS export so sendToBeta can be stubbed without network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import protocol = require('./protocol.cjs');
import { BetaCredentials, BetaSigner, BetaSunatProvider, BetaUblBuilder } from './beta-adapters';
import type { FiscalDocumentSnapshot } from '../../domain/models/fiscal-document';

const snapshot: FiscalDocumentSnapshot = {
  documentId: '00000000-0000-4000-8000-000000000001',
  documentType: '01',
  series: 'FB01',
  number: '1',
  issueDate: '2026-09-24',
  currencyCode: 'PEN',
  issuer: { documentType: '6', documentNumber: '20100066603', legalName: 'EMISOR BETA' },
  recipient: { documentType: '6', documentNumber: '20100070970', legalName: 'CLIENTE BETA' },
  lines: [
    {
      id: '1',
      description: 'Web beta',
      quantity: '1',
      unitCode: 'ZZ',
      unitPrice: '100.00',
      lineExtensionAmount: '100.00',
      tax: { schemeId: '1000', schemeName: 'IGV', taxAmount: '18.00', taxableAmount: '100.00' },
    },
  ],
  lineExtensionTotal: '100.00',
  taxTotal: '18.00',
  payableTotal: '118.00',
};
const issuerId = '00000000-0000-4000-8000-000000000002';
const organizationId = '00000000-0000-4000-8000-000000000003';
const priorEnv = { ...process.env };
let directory: string;
let signer: BetaSigner;
beforeAll(() => {
  process.env.NODE_ENV = 'development';
  process.env.SUNAT_PROVIDER_MODE = 'beta';
  directory = mkdtempSync(join(tmpdir(), 'facture-beta-adapter-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=TEST ONLY',
      '-keyout',
      join(directory, 'test.key'),
      '-out',
      join(directory, 'test.pem'),
    ],
    { stdio: 'pipe' },
  );
  signer = new BetaSigner(join(directory, 'test.key'), join(directory, 'test.pem'));
});
afterAll(() => {
  process.env = priorEnv;
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => jest.restoreAllMocks());

function storage(): ObjectStoragePort {
  const objects = new Map<string, Buffer>();
  return {
    healthCheck: () => Promise.resolve(),
    get: (key) =>
      objects.has(key)
        ? Promise.resolve(objects.get(key)!)
        : Promise.reject(Object.assign(new Error('Missing'), { name: 'NoSuchKey' })),
    createReadUrl: () => Promise.resolve(''),
    putImmutable: (input) => {
      objects.set(input.key, input.body);
      return Promise.resolve({
        key: input.key,
        sha256: input.sha256,
        contentType: input.contentType,
        sizeBytes: input.body.length,
      });
    },
  };
}
function cdr(): string {
  const xml =
    '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cac:DocumentResponse><cac:Response><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>Aceptada</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>FB01-1</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>';
  const zip = Buffer.from(zipSync({ 'R-20100066603-01-FB01-1.xml': Buffer.from(xml) }));
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><applicationResponse>${zip.toString('base64')}</applicationResponse></s:Body></s:Envelope>`;
}
it('refuses another issuer, unsupported invoice and mismatched totals before sending', () => {
  const builder = new BetaUblBuilder('20100066603');
  expect(() => builder.build({ ...snapshot, documentType: '03' })).toThrow();
  expect(() => builder.build({ ...snapshot, payableTotal: '999.00' })).toThrow();
  expect(() => new BetaUblBuilder('20100070970').build(snapshot)).toThrow();
});
it('blocks beta in production', () => {
  process.env.NODE_ENV = 'production';
  try {
    expect(() => new BetaCredentials()).toThrow();
  } finally {
    process.env.NODE_ENV = 'development';
  }
});
it('stores tenant-owned ZIP/CDR and returns cached acceptance without resending', async () => {
  const send = jest
    .spyOn(protocol, 'sendToBeta')
    .mockResolvedValue({ httpStatus: 200, body: cdr() });
  const provider = new BetaSunatProvider(storage(), signer);
  const credentials = await new BetaCredentials().resolve(issuerId);
  const signed = await signer.sign(new BetaUblBuilder('20100066603').build(snapshot), credentials);
  const outcome = await provider.submitDocument(signed, credentials, { organizationId });
  expect(outcome.status).toBe('accepted_with_observations');
  if (outcome.status === 'pending') throw new Error('Unexpected');
  expect(outcome.artifacts?.map((a) => a.kind)).toEqual(['zip', 'cdr']);
  expect(
    outcome.artifacts?.every((a) =>
      a.objectKey.startsWith(
        `sunat/${organizationId}/${issuerId}/documents/${snapshot.documentId}/`,
      ),
    ),
  ).toBe(true);
  await provider.submitDocument(signed, credentials, { organizationId });
  expect(send).toHaveBeenCalledTimes(1);
  expect((await provider.storedArtifacts(snapshotToIdentity(), credentials)).length).toBe(2);
});
it('keeps a timeout ambiguous; reconciliation never sends again', async () => {
  const send = jest.spyOn(protocol, 'sendToBeta').mockRejectedValue(new Error('Timeout'));
  const provider = new BetaSunatProvider(storage(), signer);
  const credentials = await new BetaCredentials().resolve(issuerId);
  const signed = await signer.sign(new BetaUblBuilder('20100066603').build(snapshot), credentials);
  await expect(
    provider.submitDocument(signed, credentials, { organizationId }),
  ).rejects.toMatchObject({ code: 'SUNAT_SUBMISSION_AMBIGUOUS' });
  expect((await provider.reconcileDocument(snapshotToIdentity(), null, credentials)).status).toBe(
    'pending',
  );
  expect(send).toHaveBeenCalledTimes(1);
});
function snapshotToIdentity(): {
  documentId: string;
  issuerRuc: string;
  documentType: '01' | '03' | '07' | '08';
  series: string;
  number: string;
} {
  return {
    documentId: snapshot.documentId,
    issuerRuc: snapshot.issuer.documentNumber,
    documentType: snapshot.documentType,
    series: snapshot.series,
    number: snapshot.number,
  };
}
