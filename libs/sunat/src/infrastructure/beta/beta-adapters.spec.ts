import type { DataSource } from 'typeorm';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { ObjectStoragePort } from '@app/platform';
// Keep the mutable CommonJS export so sendToBeta can be stubbed without network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import protocol = require('./protocol.cjs');
import { buildVoidXml } from './void-ubl';
import { BetaCredentials, BetaSigner, BetaSunatProvider, BetaUblBuilder } from './beta-adapters';
import type { FiscalDocumentSnapshot } from '../../domain/models/fiscal-document';

const snapshot: FiscalDocumentSnapshot = {
  environment: 'beta',
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
it('refuses production payloads, invalid series and mismatched totals before sending', () => {
  const builder = new BetaUblBuilder();
  expect(() => builder.build({ ...snapshot, documentType: '03' })).toThrow();
  expect(() => builder.build({ ...snapshot, payableTotal: '999.00' })).toThrow();
  expect(() => new BetaUblBuilder().build({ ...snapshot, environment: 'production' })).toThrow();
});
it('allows a hosted sandbox with NODE_ENV=production', () => {
  process.env.NODE_ENV = 'production';
  try {
    expect(() => new BetaCredentials()).not.toThrow();
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
  const signed = await signer.sign(new BetaUblBuilder().build(snapshot), credentials);
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
  const signed = await signer.sign(new BetaUblBuilder().build(snapshot), credentials);
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
it.each(['03', '07', '08'] as const)(
  'builds signed UBL for document type %s',
  async (documentType) => {
    const adapted: FiscalDocumentSnapshot = {
      ...snapshot,
      documentType,
      series: documentType === '03' ? 'B001' : documentType === '07' ? 'FC01' : 'FD01',
      ...(documentType === '03'
        ? {}
        : {
            reference: {
              documentType: '01',
              id: 'FB01-1',
              reasonCode: '01',
              reasonDescription: 'Prueba',
            },
          }),
    };
    const built = new BetaUblBuilder().build(adapted);
    const signed = await signer.sign(built, await new BetaCredentials().resolve(issuerId));
    expect(protocol.verifySignature(signed.xml, signer.certificate)).toBe(true);
    expect(() =>
      protocol.packageInvoice(
        `${adapted.issuer.documentNumber}-${documentType}-${adapted.series}-1`,
        signed.xml,
      ),
    ).not.toThrow();
    expect(built.xml).toContain(
      documentType === '03' ? '<Invoice ' : documentType === '07' ? '<CreditNote ' : '<DebitNote ',
    );
  },
);
it('supports multiple quantities, currency and exempt lines without the pilot caps', () => {
  const adapted: FiscalDocumentSnapshot = {
    ...snapshot,
    currencyCode: 'USD',
    lines: [
      {
        ...snapshot.lines[0]!,
        quantity: '2',
        unitPrice: '1000',
        lineExtensionAmount: '2000',
        tax: { schemeId: '9997', schemeName: 'EXO', taxableAmount: '2000', taxAmount: '0' },
      },
    ],
    lineExtensionTotal: '2000',
    taxTotal: '0',
    payableTotal: '2000',
  };
  const built = new BetaUblBuilder().build(adapted);
  expect(built.xml).toContain('<cbc:TaxExemptionReasonCode>20</cbc:TaxExemptionReasonCode>');
  expect(built.xml).toContain('<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>');
});
it('keeps production credentials away from the beta transport', async () => {
  const send = jest.spyOn(protocol, 'sendToBeta');
  const provider = new BetaSunatProvider(storage(), signer);
  const credentials = await new BetaCredentials().resolve(issuerId);
  const signed = await signer.sign(new BetaUblBuilder().build(snapshot), credentials);
  await expect(
    provider.submitDocument(
      signed,
      { ...credentials, environment: 'production' },
      { organizationId },
    ),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it('a void timeout cannot be submitted again, including after a process restart', async () => {
  const database = { query: jest.fn().mockResolvedValue([{ number: 1 }]) };
  const store = storage();
  const send = jest.spyOn(protocol, 'sendToBeta').mockRejectedValue(new Error('timeout'));
  const credentials = await new BetaCredentials().resolve(issuerId);
  const provider = new BetaSunatProvider(store, signer, database as unknown as DataSource);
  await expect(
    provider.submitVoidCommunication(snapshotToIdentity(), 'Prueba', credentials, {
      organizationId,
      snapshot,
    }),
  ).rejects.toMatchObject({ code: 'SUNAT_SUBMISSION_AMBIGUOUS' });
  const restarted = new BetaSunatProvider(store, signer, database as unknown as DataSource);
  await expect(
    restarted.submitVoidCommunication(snapshotToIdentity(), 'Prueba', credentials, {
      organizationId,
      snapshot,
    }),
  ).rejects.toMatchObject({ code: 'SUNAT_SUBMISSION_AMBIGUOUS' });
  expect(send).toHaveBeenCalledTimes(1);
});
it('persists the void ticket and consults it without sending a second summary', async () => {
  const database = { query: jest.fn().mockResolvedValue([{ number: 2 }]) };
  const provider = new BetaSunatProvider(storage(), signer, database as unknown as DataSource);
  const send = jest
    .spyOn(protocol, 'sendToBeta')
    .mockResolvedValueOnce({
      httpStatus: 200,
      body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ticket>12345</ticket></soap:Body></soap:Envelope>',
    })
    .mockResolvedValue({
      httpStatus: 200,
      body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><statusCode>98</statusCode></soap:Body></soap:Envelope>',
    });
  const credentials = await new BetaCredentials().resolve(issuerId);
  const pending = await provider.submitVoidCommunication(
    snapshotToIdentity(),
    'Prueba',
    credentials,
    { organizationId, snapshot },
  );
  expect(pending).toEqual({ status: 'pending', providerTrackingId: 'void:12345' });
  await provider.submitVoidCommunication(snapshotToIdentity(), 'Prueba', credentials, {
    organizationId,
    snapshot,
  });
  const status = await provider.reconcileDocument(snapshotToIdentity(), 'void:12345', credentials);
  expect(status.status).toBe('pending');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map((call) => call[1])).toEqual(['sendSummary', 'getStatus']);
});

test('RC separa operaciones gravadas, exoneradas e inafectas sin inventar IGV', () => {
  const doc: FiscalDocumentSnapshot = {
    ...snapshot,
    documentType: '03',
    series: 'B001',
    lines: ['1000', '9997', '9998'].map((schemeId, index) => ({
      ...snapshot.lines[0]!,
      id: String(index + 1),
      tax: {
        schemeId,
        schemeName: '',
        taxAmount: index === 0 ? '18.00' : '0.00',
        taxableAmount: '100.00',
      },
    })),
    lineExtensionTotal: '300.00',
    taxTotal: '18.00',
    payableTotal: '318.00',
  };
  const { xml } = buildVoidXml(doc, 'Prueba', '2026-09-27', '1');
  expect(xml).toContain('<cbc:ConditionCode>3</cbc:ConditionCode>');
  for (const code of ['01', '02', '03'])
    expect(xml).toContain('<cbc:InstructionID>' + code + '</cbc:InstructionID>');
  for (const code of ['1000', '9997', '9998'])
    expect(xml).toContain('<cbc:ID>' + code + '</cbc:ID>');
});
