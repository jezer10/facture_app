import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sha256Bytes } from '../canonical-json';
import {
  FilesystemArtifactReaderAdapter,
  FilesystemLocalInvoiceSourceAdapter,
} from './filesystem-local-source';

describe('FilesystemLocalInvoiceSourceAdapter', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('accepts only complete verified generations and quarantines orphan PDFs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'legacy-invoices-'));
    temporaryRoots.push(root);
    const generationDirectory = path.join(root, 'generated', '20999999999', '01');
    const orphanDirectory = path.join(root, 'output', 'pdf');
    await Promise.all([
      mkdir(generationDirectory, { recursive: true }),
      mkdir(orphanDirectory, { recursive: true }),
    ]);
    const baseName = 'F001-42-source-1';
    const jsonName = `${baseName}.json`;
    const pdfName = `${baseName}.pdf`;
    const jsonBody = Buffer.from(
      JSON.stringify({
        datosEmisor: { numRuc: '20999999999' },
        datosReceptor: { numDocIdeRecep: '20111111111' },
        fecEmision: '2026-08-20',
        numCpe: '42',
        numSerie: 'F001',
      }),
    );
    const pdfBody = Buffer.from('%PDF-verified');
    await Promise.all([
      writeFile(path.join(generationDirectory, jsonName), jsonBody),
      writeFile(path.join(generationDirectory, pdfName), pdfBody),
      writeFile(path.join(orphanDirectory, 'old-demo.pdf'), Buffer.from('%PDF-orphan')),
      writeFile(
        path.join(generationDirectory, `${baseName}.manifest.json`),
        JSON.stringify({
          artifacts: {
            json: { name: jsonName, sha256: sha256Bytes(jsonBody), size: jsonBody.byteLength },
            pdf: { name: pdfName, sha256: sha256Bytes(pdfBody), size: pdfBody.byteLength },
          },
          version: 1,
        }),
      ),
    ]);

    const inventory = await new FilesystemLocalInvoiceSourceAdapter(root).inventory();

    expect(inventory.generations).toHaveLength(1);
    expect(inventory.generations[0]).toMatchObject({
      documentType: '01',
      issueDate: '2026-08-20',
      number: '42',
      recipientRuc: '20111111111',
      series: 'F001',
      source: 1,
      supplierRuc: '20999999999',
    });
    expect(inventory.generations[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(inventory.quarantine).toHaveLength(1);
    expect(inventory.quarantine[0]?.reason).toBe('ORPHAN_LOCAL_ARTIFACT');
    expect(JSON.stringify(inventory.quarantine)).not.toContain('old-demo.pdf');

    const firstArtifact = inventory.generations[0]?.artifacts[0];
    expect(firstArtifact).toBeDefined();
    const body = await new FilesystemArtifactReaderAdapter(root).read(firstArtifact!.source);
    expect(body).toEqual(jsonBody);
  });

  it('does not scan fixtures, virtual environments, or arbitrary repository JSON', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'legacy-invoices-'));
    temporaryRoots.push(root);
    const fixtureDirectory = path.join(root, 'tests', 'fixtures');
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(path.join(fixtureDirectory, 'invoice.json'), '{"secret":"fixture"}');

    const inventory = await new FilesystemLocalInvoiceSourceAdapter(root).inventory();

    expect(inventory).toEqual({ generations: [], quarantine: [] });
  });
});
