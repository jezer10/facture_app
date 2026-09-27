import { mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaxpayerRegistryService } from './taxpayer-registry.service';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
let directory: string, service: TaxpayerRegistryService;
const previous = process.env.SUNAT_PADRON_DB_FILE;
function fixture(file: string, name: string, date = '2026-01-01'): void {
  const database = new DatabaseSync(file);
  database.exec(
    'CREATE TABLE taxpayers(ruc TEXT PRIMARY KEY,legal_name TEXT,status TEXT,condition TEXT,ubigeo TEXT,address TEXT);CREATE TABLE metadata(key TEXT,value TEXT);',
  );
  database
    .prepare('INSERT INTO taxpayers VALUES(?,?,?,?,?,?)')
    .run('20131312955', name, 'ACTIVO', 'HABIDO', '150101', 'AV. PRUEBA 123');
  database.prepare('INSERT INTO metadata VALUES(?,?)').run('sourceDate', date);
  database.prepare('INSERT INTO metadata VALUES(?,?)').run('importedAt', '2026-09-25T00:00:00Z');
  database.close();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'padron-test-'));
  process.env.SUNAT_PADRON_DB_FILE = join(directory, 'registry.sqlite');
  service = new TaxpayerRegistryService();
});
afterEach(() => {
  service.onModuleDestroy();
  rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SUNAT_PADRON_DB_FILE;
  else process.env.SUNAT_PADRON_DB_FILE = previous;
});
it('validates RUCs and reports missing datasets without creating empty files', () => {
  expect(() => service.lookup('invalid')).toThrow(BadRequestException);
  expect(() => service.lookup('20131312955')).toThrow(ServiceUnavailableException);
});
it('returns source freshness and missing entries without claiming ownership', () => {
  fixture(process.env.SUNAT_PADRON_DB_FILE!, 'COMPAÑÍA PERÚ');
  const result = service.lookup('20131312955');
  expect(result.taxpayer?.legalName).toBe('COMPAÑÍA PERÚ');
  expect(result.stale).toBe(true);
  expect(result).not.toHaveProperty('verified');
  expect(service.lookup('20100070970')).toMatchObject({
    found: false,
    source: 'SUNAT',
    sourceDate: '2026-01-01',
  });
});
it('reopens an atomically replaced snapshot', () => {
  fixture(process.env.SUNAT_PADRON_DB_FILE!, 'OLD');
  expect(service.lookup('20131312955').taxpayer?.legalName).toBe('OLD');
  const next = join(directory, 'next.sqlite');
  fixture(next, 'NEW');
  renameSync(next, process.env.SUNAT_PADRON_DB_FILE!);
  expect(service.lookup('20131312955').taxpayer?.legalName).toBe('NEW');
});
