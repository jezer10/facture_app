import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DataSource } from 'typeorm';
import type { ObjectStoragePort } from '@app/platform';
import { coreDocumentArtifactObjectKey, sunatDocumentArtifactObjectKey } from '@app/contracts';
import { DocumentEmailService } from './document-email.service';

jest.mock('nodemailer', () => ({ __esModule: true, default: { createTransport: jest.fn() } }));
const id = '00000000-0000-4000-8000-000000000001';
const ownership = {
  documentId: id,
  organizationId: '00000000-0000-4000-8000-000000000002',
  issuerId: '00000000-0000-4000-8000-000000000003',
};
const body = Buffer.from('attachment');
const sha256 = createHash('sha256').update(body).digest('hex');
const artifacts = [
  {
    kind: 'pdf',
    objectKey: coreDocumentArtifactObjectKey({ ...ownership, kind: 'pdf', sha256 }),
    sha256,
    sizeBytes: String(body.length),
    contentType: 'application/pdf',
  },
  {
    kind: 'signed-xml',
    objectKey: sunatDocumentArtifactObjectKey({ ...ownership, kind: 'signed-xml', sha256 }),
    sha256,
    sizeBytes: String(body.length),
    contentType: 'application/xml',
  },
  {
    kind: 'cdr',
    objectKey: sunatDocumentArtifactObjectKey({ ...ownership, kind: 'cdr', sha256 }),
    sha256,
    sizeBytes: String(body.length),
    contentType: 'application/zip',
  },
];
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.NODE_ENV = 'development';
  process.env.SUNAT_PROVIDER_MODE = 'beta';
  process.env.BILLING_EMAIL_MODE = 'mailpit';
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.clearAllMocks();
});
// Test doubles intentionally expose Jest matchers and mocks.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup(options: { smtpFailure?: boolean; corrupt?: boolean } = {}) {
  const sendMail = jest.fn();
  if (options.smtpFailure) sendMail.mockRejectedValue(new Error('SMTP timeout'));
  else sendMail.mockResolvedValue({});
  jest
    .mocked(nodemailer.createTransport)
    .mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
  let claimed = false;
  const query = jest.fn((sql: string) => {
    if (sql.includes('SELECT * FROM claimed')) {
      if (claimed) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([{ document_id: id, recipient: 'buyer@example.test', attempts: 1 }]);
    }
    if (sql.includes('SELECT id,organization_id'))
      return Promise.resolve([
        {
          id,
          organization_id: ownership.organizationId,
          issuer_id: ownership.issuerId,
          series: 'FAPI',
          number: '1',
          fiscal_snapshot: { environment: 'beta' },
        },
      ]);
    if (sql.includes('SELECT DISTINCT ON')) return Promise.resolve(artifacts);
    return Promise.resolve([]);
  });
  const get = jest.fn().mockResolvedValue(options.corrupt ? Buffer.from('corrupt') : body);
  const service = new DocumentEmailService(
    { query } as unknown as DataSource,
    { get } as unknown as ObjectStoragePort,
  );
  return { service, query, sendMail };
}
it('delivers matching artifacts once with beta labeling and a deterministic Message-ID', async () => {
  const { service, query, sendMail } = setup();
  await service.deliverPending();
  await service.deliverPending();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'buyer@example.test',
      subject: '[PRUEBA BETA] Comprobante FAPI-1',
      messageId: `<facture-beta-${id}@facture.local>`,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      attachments: expect.arrayContaining([
        expect.objectContaining({ filename: 'FAPI-1.pdf', content: body }),
      ]),
    }),
  );
  expect(query).toHaveBeenCalledWith(expect.stringContaining("status='sent'"), [
    id,
    `<facture-beta-${id}@facture.local>`,
  ]);
});
it('does not send corrupted attachments', async () => {
  const { service, query, sendMail } = setup({ corrupt: true });
  await service.deliverPending();
  expect(sendMail).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledWith(expect.stringContaining('SET status=$2'), [
    id,
    'pending',
    'EMAIL_PREPARATION_FAILED',
  ]);
});
it('does not automatically retry an uncertain SMTP send', async () => {
  const { service, query } = setup({ smtpFailure: true });
  await service.deliverPending();
  expect(query).toHaveBeenCalledWith(expect.stringContaining('SET status=$2'), [
    id,
    'unconfirmed',
    'EMAIL_DELIVERY_UNCONFIRMED',
  ]);
});
it('does nothing when email delivery is disabled', async () => {
  process.env.BILLING_EMAIL_MODE = 'disabled';
  const { service, query, sendMail } = setup();
  await service.deliverPending();
  expect(query).not.toHaveBeenCalled();
  expect(sendMail).not.toHaveBeenCalled();
});
