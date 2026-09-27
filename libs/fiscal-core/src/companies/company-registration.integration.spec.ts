import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { CORE_ENTITIES } from '../database/entities';
import { FiscalDocumentsService } from '../documents/fiscal-documents.service';
import { CompanyRegistrationService, type CompanyData } from './company-registration.service';

// Explicit local-only opt-in; all test data is rolled back, including approved companies.
const integration = process.env.RUN_COMPANY_DB_TESTS === '1' ? describe : describe.skip;
integration('company registration with real PostgreSQL transactions', () => {
  let database: DataSource;
  let runner: QueryRunner;
  let service: CompanyRegistrationService;
  beforeAll(async () => {
    database = new DataSource({
      type: 'postgres',
      entities: [...CORE_ENTITIES],
      host: '127.0.0.1',
      port: 54330,
      username: 'billing_core',
      database: 'billing_core',
      password: readFileSync('deploy/secrets/local/core_db_password', 'utf8').trim(),
    });
    await database.initialize();
    runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    service = new CompanyRegistrationService({
      transaction: (callback: (manager: typeof runner.manager) => unknown) =>
        callback(runner.manager),
      query: runner.query.bind(runner),
    } as unknown as DataSource);
  });
  afterAll(async () => {
    if (runner) {
      await runner.rollbackTransaction();
      await runner.release();
    }
    if (database?.isInitialized) await database.destroy();
  });
  it('isolates requests, preserves duplicate claims, and grants one verified company atomically', async () => {
    const subject = `test-${randomUUID()}`;
    const prefix = `20${String(Date.now()).slice(-8)}`;
    const remainder =
      11 -
      ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce(
        (sum, weight, index) => sum + Number(prefix[index]) * weight,
        0,
      ) %
        11);
    const ruc = prefix + String(remainder === 10 ? 0 : remainder === 11 ? 1 : remainder);
    const data: CompanyData = {
      ruc,
      legalName: 'Integration test only',
      address: 'Test address',
      representativeName: 'Test applicant',
      relationship: 'representative',
      authorityExplanation: 'Test evidence only, all changes are rolled back.',
      series: 'F001',
      declaration: true,
    };
    const first = randomUUID(),
      second = randomUUID();
    await service.save({ subject, email: 'test@example.test' }, first, data);
    await service.save(
      { subject: 'other-test-subject', email: 'other@example.test' },
      second,
      data,
    );
    await expect(service.submit('other-test-subject', first)).rejects.toThrow('No encontramos');
    const sandbox = await service.submit(subject, first);
    await service.submit('other-test-subject', second);
    expect(await runner.query('SELECT id FROM issuers WHERE ruc=$1', [ruc])).toHaveLength(2);
    const approved = await service.decide(
      first,
      'independent-test-reviewer',
      'approve',
      'Test review completed',
      'Test evidence reference',
    );
    expect(approved.status).toBe('approved');
    expect(approved.sandbox_organization_id).toBe(sandbox.sandbox_organization_id);
    expect(approved.organization_id).not.toBe(sandbox.sandbox_organization_id);
    const documents = new FiscalDocumentsService({
      transaction: (_isolation: unknown, callback: (manager: typeof runner.manager) => unknown) =>
        callback(runner.manager),
      manager: runner.manager,
      getRepository: runner.manager.getRepository.bind(runner.manager),
    } as unknown as DataSource);
    const [sandboxSeries] = await runner.manager.query<{ id: string }[]>(
      'SELECT id FROM issuer_series WHERE issuer_id=$1 AND document_type=$2',
      [sandbox.sandbox_issuer_id, '01'],
    );
    const principal = {
      organizationId: sandbox.sandbox_organization_id!,
      subject,
      correlationId: randomUUID(),
    };
    const document = await documents.create(principal, {
      idempotencyKey: 'isolated-test',
      input: {
        issuerId: sandbox.sandbox_issuer_id!,
        seriesId: sandboxSeries!.id,
        documentType: '01',
        issueDate: '2026-09-27',
        currency: 'PEN',
        customer: {
          identityType: '6',
          identityNumber: '20100070970',
          legalName: 'Sandbox customer',
        },
        lines: [
          {
            description: 'Sandbox test',
            unitCode: 'NIU',
            quantity: '2',
            unitValue: '10',
            taxAffectation: 'taxed',
            taxRate: '0.18',
          },
        ],
      },
    });
    expect(document.number).toBe('1');
    await expect(
      documents.get({ ...principal, organizationId: approved.organization_id! }, document.id),
    ).rejects.toThrow('not found');
    expect(
      await documents.list({ ...principal, organizationId: approved.organization_id! }),
    ).toHaveLength(0);
    const [productionSeries] = await runner.manager.query<{ next_number: string }[]>(
      'SELECT next_number FROM issuer_series WHERE issuer_id=$1 AND document_type=$2',
      [approved.issuer_id, '01'],
    );
    expect(productionSeries!.next_number).toBe('1');
    // A forged environment selection cannot turn a sandbox operation into production.
    await expect(
      documents.requestVoid(
        { ...principal, organizationId: approved.organization_id! },
        { documentId: document.id, reason: 'No cross-environment operations' },
      ),
    ).rejects.toThrow('productiva');
    await runner.query('SAVEPOINT isolation_check');
    await expect(
      runner.query('UPDATE organizations SET environment=$2 WHERE id=$1', [
        sandbox.sandbox_organization_id,
        'production',
      ]),
    ).rejects.toThrow('immutable');
    await runner.query('ROLLBACK TO SAVEPOINT isolation_check');

    expect(
      await runner.query(
        'SELECT id FROM organization_members WHERE organization_id=$1 AND subject=$2',
        [approved.organization_id, subject],
      ),
    ).toHaveLength(1);
    expect(
      await runner.query('SELECT id FROM issuer_series WHERE issuer_id=$1 AND organization_id=$2', [
        approved.issuer_id,
        approved.organization_id,
      ]),
    ).toHaveLength(6);
    expect(
      await runner.query('SELECT id FROM company_registration_events WHERE registration_id=$1', [
        first,
      ]),
    ).toHaveLength(2);
    await expect(
      service.decide(
        second,
        'independent-test-reviewer',
        'approve',
        'Test duplicate review',
        'Test evidence reference',
      ),
    ).rejects.toThrow('RUC ya está registrado');
    expect(
      await runner.query(
        'SELECT id FROM organization_members WHERE organization_id=$1 AND subject=$2',
        [approved.organization_id, 'other-test-subject'],
      ),
    ).toHaveLength(0);
  });
});
