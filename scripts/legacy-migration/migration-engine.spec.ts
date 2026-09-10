import { sha256Bytes } from './canonical-json';
import { LegacyMigrationEngine } from './migration-engine';
import type {
  DatabaseSchema,
  DestinationDisposition,
  LegacyCompanyRow,
  LegacyInvoiceRow,
  ObjectMetadata,
  ReceivedDocumentImport,
  TenantMapping,
} from './models';
import type {
  ArtifactReaderPort,
  BillingDestinationPort,
  DestinationObjectStorePort,
  LegacyDatabaseSourcePort,
  TenantMappingPort,
} from './ports';

const ORGANIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ISSUER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOCUMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COMPANY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CREATED_AT = '2026-08-20T14:30:00.000Z';
const RAW_BODY = Buffer.from('{"fiscal":true}', 'utf8');
const PDF_BODY = Buffer.from('%PDF-test', 'utf8');

describe('LegacyMigrationEngine', () => {
  it('is dry-run by default and emits only aggregate credential information', async () => {
    const fixture = createFixture();

    const report = await fixture.engine.run();

    expect(report.mode).toBe('dry-run');
    expect(report.documents).toMatchObject({
      discovered: 1,
      eligible: 1,
      imported: 0,
      wouldImport: 1,
    });
    expect(report.artifacts).toMatchObject({ copied: 0, wouldCopy: 2 });
    expect(report.credentials).toEqual({
      accessTokensDiscarded: 1,
      categories: { corrupt: 0, envelope: 0, plaintext: 2 },
    });
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(0);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('password-must-not-leak');
    expect(serialized).not.toContain('client-secret-must-not-leak');
    expect(serialized).not.toContain('token-must-not-leak');
    expect(report.safety).toEqual({ secretsEmitted: false, sourceDeletes: 0 });
  });

  it('imports historical invoices alongside WhatsApp companies without fiscal credentials', async () => {
    const fixture = createFixture();
    const existing = await fixture.source.listCompanies();
    jest
      .spyOn(fixture.source, 'listCompanies')
      .mockResolvedValue([
        ...existing,
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          recipientRuc: '20999999999',
          companyPassword: null,
          clientSecret: null,
          accessToken: null,
        },
      ]);
    const report = await fixture.engine.run();
    expect(report.status).toBe('completed');
    expect(report.documents.wouldImport).toBe(1);
    expect(report.artifacts.wouldCopy).toBe(2);
    expect(fixture.destination.persisted).toHaveLength(0);
  });

  it('copies and verifies every object before atomically persisting metadata', async () => {
    const fixture = createFixture();

    const report = await fixture.engine.run('apply');

    expect(report.documents.imported).toBe(1);
    expect(report.artifacts.copied).toBe(2);
    expect(fixture.destination.persisted).toHaveLength(1);
    const persisted = fixture.destination.persisted[0]!;
    expect(persisted).toMatchObject({
      createdAt: CREATED_AT,
      id: DOCUMENT_ID,
      organizationId: ORGANIZATION_ID,
      recipientIssuerId: ISSUER_ID,
      recipientRuc: '20111111111',
      source: 'sndr-sunat:1',
    });
    expect(JSON.stringify(persisted)).not.toContain('token-must-not-leak');
    expect(fixture.events.at(-1)).toBe('persist');
    expect(fixture.events.filter((event) => event.startsWith('verified:'))).toHaveLength(2);
  });

  it('quarantines a source hash mismatch without writing objects or metadata', async () => {
    const fixture = createFixture();
    fixture.reader.bodies.set('raw/key.json', Buffer.from('tampered'));

    const report = await fixture.engine.run('apply');

    expect(report.documents.quarantined).toBe(1);
    expect(report.quarantine[0]?.reason).toBe('SOURCE_ARTIFACT_MISMATCH');
    expect(report.quarantine[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(0);
  });

  it('does not read rows or mutate anything when preflight fails', async () => {
    const fixture = createFixture();
    fixture.destination.schema = { tables: [] };

    const report = await fixture.engine.run('apply');

    expect(report.status).toBe('blocked');
    expect(fixture.source.companyReads).toBe(0);
    expect(fixture.source.invoiceReads).toBe(0);
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(0);
  });

  it('is idempotent when document metadata and objects already exist', async () => {
    const fixture = createFixture('identical');
    fixture.objects.seedExpectedObjects();

    const report = await fixture.engine.run('apply');

    expect(report.documents.alreadyPresent).toBe(1);
    expect(report.artifacts.reused).toBe(2);
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(0);
  });

  it('repairs partial destination metadata after an interrupted run', async () => {
    const fixture = createFixture('partial');
    fixture.objects.seedExpectedObjects();

    const report = await fixture.engine.run('apply');

    expect(report.documents.imported).toBe(1);
    expect(report.documents.alreadyPresent).toBe(0);
    expect(report.artifacts.reused).toBe(2);
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(1);
  });

  it('recalculates the destination hash instead of trusting R2 metadata', async () => {
    const fixture = createFixture();
    fixture.objects.seedExpectedObjects();
    fixture.objects.tamperRawObject();

    const report = await fixture.engine.run('apply');

    expect(report.documents.conflicts).toBe(1);
    expect(report.quarantine[0]?.reason).toBe('DESTINATION_OBJECT_CONFLICT');
    expect(fixture.objects.putCalls).toHaveLength(0);
    expect(fixture.destination.persisted).toHaveLength(0);
  });

  it('reports destination and mapping conflicts without copying artifacts', async () => {
    const destinationConflict = createFixture('conflict');
    const conflictReport = await destinationConflict.engine.run('apply');
    expect(conflictReport.documents.conflicts).toBe(1);
    expect(destinationConflict.reader.reads).toBe(0);

    const missingMapping = createFixture();
    missingMapping.mapping.enabled = false;
    const mappingReport = await missingMapping.engine.run('apply');
    expect(mappingReport.status).toBe('blocked');
    expect(mappingReport.preflight.diagnostics).toContainEqual({
      code: 'MISSING_TENANT_MAPPING',
      count: 1,
    });
    expect(missingMapping.reader.reads).toBe(0);
    expect(missingMapping.objects.putCalls).toHaveLength(0);
  });
});

function createFixture(disposition: DestinationDisposition = 'new'): {
  readonly destination: FakeDestination;
  readonly engine: LegacyMigrationEngine;
  readonly events: string[];
  readonly mapping: FakeMapping;
  readonly objects: FakeObjects;
  readonly reader: FakeReader;
  readonly source: FakeLegacySource;
} {
  const events: string[] = [];
  const source = new FakeLegacySource();
  const reader = new FakeReader(
    new Map([
      ['raw/key.json', RAW_BODY],
      ['pdf/key.pdf', PDF_BODY],
    ]),
  );
  const objects = new FakeObjects(events);
  const destination = new FakeDestination(disposition, events);
  const mapping = new FakeMapping();
  return {
    destination,
    engine: new LegacyMigrationEngine({
      artifactReader: reader,
      destination,
      destinationObjects: objects,
      legacyDatabase: source,
      mapping,
    }),
    events,
    mapping,
    objects,
    reader,
    source,
  };
}

class FakeLegacySource implements LegacyDatabaseSourcePort {
  companyReads = 0;
  invoiceReads = 0;

  inspectSchema(): Promise<DatabaseSchema> {
    return Promise.resolve(legacySchema());
  }

  listCompanies(): Promise<readonly LegacyCompanyRow[]> {
    this.companyReads += 1;
    return Promise.resolve([
      {
        accessToken: 'token-must-not-leak',
        clientSecret: 'client-secret-must-not-leak',
        companyPassword: 'password-must-not-leak',
        id: COMPANY_ID,
        recipientRuc: '20111111111',
      },
    ]);
  }

  listInvoices(): Promise<readonly LegacyInvoiceRow[]> {
    this.invoiceReads += 1;
    return Promise.resolve([legacyInvoice()]);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMapping implements TenantMappingPort {
  enabled = true;

  resolveLegacyCompany(): TenantMapping | undefined {
    return this.enabled ? mapping() : undefined;
  }

  resolveRecipientRuc(): TenantMapping | undefined {
    return this.enabled ? mapping() : undefined;
  }
}

class FakeReader implements ArtifactReaderPort {
  reads = 0;

  constructor(readonly bodies: Map<string, Buffer>) {}

  read(locator: { readonly value: string }): Promise<Buffer> {
    this.reads += 1;
    const body = this.bodies.get(locator.value);
    if (!body) {
      return Promise.reject(new Error('missing source object'));
    }
    return Promise.resolve(body);
  }
}

class FakeObjects implements DestinationObjectStorePort {
  readonly putCalls: string[] = [];
  private readonly bodies = new Map<string, Buffer>();
  private readonly objects = new Map<string, ObjectMetadata>();

  constructor(private readonly events: string[]) {}

  head(key: string): Promise<ObjectMetadata | undefined> {
    const value = this.objects.get(key);
    if (value && this.putCalls.includes(key)) {
      this.events.push(`verified:${key}`);
    }
    return Promise.resolve(value);
  }

  read(key: string): Promise<Buffer | undefined> {
    return Promise.resolve(this.bodies.get(key));
  }

  putIfAbsent(key: string, body: Buffer, _contentType: string, sha256: string): Promise<void> {
    this.putCalls.push(key);
    this.events.push(`put:${key}`);
    this.objects.set(key, { sha256, sizeBytes: body.byteLength });
    this.bodies.set(key, body);
    return Promise.resolve();
  }

  seedExpectedObjects(): void {
    const rawKey = destinationKey('canonical-json', RAW_BODY, 'json');
    const pdfKey = destinationKey('pdf', PDF_BODY, 'pdf');
    this.objects.set(rawKey, {
      sha256: sha256Bytes(RAW_BODY),
      sizeBytes: RAW_BODY.byteLength,
    });
    this.objects.set(pdfKey, {
      sha256: sha256Bytes(PDF_BODY),
      sizeBytes: PDF_BODY.byteLength,
    });
    this.bodies.set(rawKey, RAW_BODY);
    this.bodies.set(pdfKey, PDF_BODY);
  }

  tamperRawObject(): void {
    this.bodies.set(
      destinationKey('canonical-json', RAW_BODY, 'json'),
      Buffer.alloc(RAW_BODY.byteLength, 120),
    );
  }
}

class FakeDestination implements BillingDestinationPort {
  readonly persisted: ReceivedDocumentImport[] = [];
  schema = destinationSchema();

  constructor(
    private readonly disposition: DestinationDisposition,
    private readonly events: string[],
  ) {}

  inspectSchema(): Promise<DatabaseSchema> {
    return Promise.resolve(this.schema);
  }

  validateTenantMapping(value: TenantMapping): Promise<boolean> {
    return Promise.resolve(value.recipientRuc === '20111111111');
  }

  classify(): Promise<DestinationDisposition> {
    return Promise.resolve(this.disposition);
  }

  persist(document: ReceivedDocumentImport): Promise<void> {
    this.events.push('persist');
    this.persisted.push(document);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function legacyInvoice(): LegacyInvoiceRow {
  return {
    companyId: COMPANY_ID,
    createdAt: CREATED_AT,
    currencyCode: 'PEN',
    documentType: '01',
    failureMessage: null,
    id: DOCUMENT_ID,
    issueDate: '2026-08-20',
    lastSyncedAt: CREATED_AT,
    number: '42',
    pdfObjectKey: 'pdf/key.pdf',
    pdfSha256: sha256Bytes(PDF_BODY),
    pdfSize: PDF_BODY.byteLength,
    rawObjectKey: 'raw/key.json',
    rawSha256: sha256Bytes(RAW_BODY),
    rawSize: RAW_BODY.byteLength,
    series: 'F001',
    source: 1,
    status: 'stored',
    supplierRuc: '20999999999',
    totalAmount: '118.00',
    updatedAt: CREATED_AT,
  };
}

function mapping(): TenantMapping {
  return {
    organizationId: ORGANIZATION_ID,
    recipientIssuerId: ISSUER_ID,
    recipientRuc: '20111111111',
  };
}

function destinationKey(kind: 'canonical-json' | 'pdf', body: Buffer, extension: string): string {
  return `received/${DOCUMENT_ID}/${kind}-${sha256Bytes(body)}.${extension}`;
}

function legacySchema(): DatabaseSchema {
  return {
    tables: [
      {
        columns: ['id', 'companyId', 'companyPassword', 'clientSecret', 'token'],
        foreignKeys: [],
        name: 'companies',
      },
      {
        columns: [
          'id',
          'company_id',
          'issuer_ruc',
          'document_type',
          'series',
          'number',
          'source',
          'status',
          'issue_date',
          'currency_code',
          'total_amount',
          'raw_object_key',
          'raw_sha256',
          'raw_size',
          'pdf_object_key',
          'pdf_sha256',
          'pdf_size',
          'failure_message',
          'last_synced_at',
          'created_at',
          'updated_at',
        ],
        foreignKeys: [],
        name: 'invoices',
      },
    ],
  };
}

function destinationSchema(): DatabaseSchema {
  return {
    tables: [
      {
        columns: ['id', 'organization_id', 'ruc'],
        foreignKeys: [],
        name: 'issuers',
      },
      {
        columns: [
          'id',
          'organization_id',
          'recipient_issuer_id',
          'supplier_ruc',
          'document_type',
          'series',
          'number',
          'source',
          'issue_date',
          'snapshot',
          'snapshot_sha256',
          'created_at',
        ],
        foreignKeys: [],
        name: 'received_documents',
      },
      {
        columns: [
          'id',
          'received_document_id',
          'kind',
          'object_key',
          'sha256',
          'content_type',
          'size_bytes',
          'created_at',
        ],
        foreignKeys: [
          {
            column: 'received_document_id',
            referencedColumn: 'id',
            referencedTable: 'received_documents',
          },
        ],
        name: 'received_document_artifacts',
      },
    ],
  };
}
