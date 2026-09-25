import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
  ArtifactLocator,
  CandidateArtifact,
  LocalInvoiceGeneration,
  QuarantineEntry,
  QuarantineReason,
} from '../models';
import type { ArtifactReaderPort, LocalInvoiceSourcePort } from '../ports';
import { sha256Bytes, sha256Text } from '../canonical-json';

interface ManifestArtifact {
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}

interface ParsedManifest {
  readonly json: ManifestArtifact;
  readonly pdf: ManifestArtifact;
}

export class FilesystemLocalInvoiceSourceAdapter implements LocalInvoiceSourcePort {
  constructor(private readonly root: string) {}

  async inventory(): Promise<{
    readonly generations: readonly LocalInvoiceGeneration[];
    readonly quarantine: readonly QuarantineEntry[];
  }> {
    const root = await existingRealDirectory(this.root);
    if (!root) {
      return { generations: [], quarantine: [] };
    }

    const files = await listArtifactFiles(root);
    const manifests = files.filter((file) => file.endsWith('.manifest.json'));
    const referenced = new Set<string>();
    const generations: LocalInvoiceGeneration[] = [];
    const quarantine: QuarantineEntry[] = [];

    for (const manifestPath of manifests) {
      const parsed = await readGeneration(root, manifestPath);
      if ('reason' in parsed) {
        quarantine.push(quarantineFile(root, manifestPath, parsed.reason));
        continue;
      }
      generations.push(parsed.generation);
      parsed.referencedFiles.forEach((file) => referenced.add(file));
    }

    for (const file of files) {
      if (
        !file.endsWith('.manifest.json') &&
        (file.endsWith('.pdf') || file.endsWith('.json')) &&
        !referenced.has(file)
      ) {
        quarantine.push(quarantineFile(root, file, 'ORPHAN_LOCAL_ARTIFACT'));
      }
    }

    return { generations, quarantine };
  }
}

export class FilesystemArtifactReaderAdapter implements ArtifactReaderPort {
  constructor(private readonly allowedRoot: string) {}

  async read(locator: ArtifactLocator): Promise<Buffer> {
    if (locator.adapter !== 'local-filesystem') {
      throw new Error('Filesystem reader received an unsupported artifact locator');
    }
    const root = await realpath(this.allowedRoot);
    const resolved = await realpath(locator.value);
    if (!isWithin(root, resolved)) {
      throw new Error('Local artifact is outside the configured source root');
    }
    const status = await lstat(resolved);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new Error('Local artifact is not a regular file');
    }
    return readFile(resolved);
  }
}

async function readGeneration(
  root: string,
  manifestPath: string,
): Promise<
  | {
      readonly generation: LocalInvoiceGeneration;
      readonly referencedFiles: readonly string[];
    }
  | { readonly reason: QuarantineReason }
> {
  try {
    const identity = parsePathIdentity(root, manifestPath);
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    const directory = path.dirname(manifestPath);
    const jsonPath = safeSibling(directory, manifest.json.name);
    const pdfPath = safeSibling(directory, manifest.pdf.name);
    const [jsonBody, pdfBody, manifestStatus] = await Promise.all([
      readFile(jsonPath),
      readFile(pdfPath),
      lstat(manifestPath),
    ]);
    if (!matchesManifest(jsonBody, manifest.json) || !matchesManifest(pdfBody, manifest.pdf)) {
      return { reason: 'INVALID_LOCAL_MANIFEST' };
    }

    const payload: unknown = JSON.parse(jsonBody.toString('utf8'));
    const payloadIdentity = parsePayloadIdentity(payload);
    if (
      payloadIdentity.supplierRuc !== identity.supplierRuc ||
      payloadIdentity.series !== identity.series ||
      payloadIdentity.number !== identity.number
    ) {
      return { reason: 'INVALID_LOCAL_PAYLOAD' };
    }

    return {
      generation: {
        artifacts: [
          localArtifact('canonical-json', jsonPath, manifest.json),
          localArtifact('pdf', pdfPath, manifest.pdf),
        ],
        createdAt: manifestStatus.mtime.toISOString(),
        documentType: identity.documentType,
        id: stableLocalUuid(
          [
            payloadIdentity.recipientRuc,
            identity.supplierRuc,
            identity.documentType,
            identity.series,
            identity.number,
            String(identity.source),
          ].join(':'),
        ),
        issueDate: payloadIdentity.issueDate,
        number: identity.number,
        recipientRuc: payloadIdentity.recipientRuc,
        series: identity.series,
        snapshot: payload as Record<string, unknown>,
        source: identity.source,
        supplierRuc: identity.supplierRuc,
      },
      referencedFiles: [jsonPath, pdfPath],
    };
  } catch {
    return { reason: 'INVALID_LOCAL_MANIFEST' };
  }
}

function parsePathIdentity(
  root: string,
  manifestPath: string,
): {
  readonly documentType: string;
  readonly number: string;
  readonly series: string;
  readonly source: number;
  readonly supplierRuc: string;
} {
  const relative = path.relative(root, manifestPath);
  const parts = relative.split(path.sep);
  if (parts.length < 3 || relative.startsWith('..')) {
    throw new Error('Invalid local invoice path');
  }
  const supplierRuc = parts.at(-3)!;
  const documentType = parts.at(-2)!;
  const filename = parts.at(-1)!;
  const match = /^([A-Z0-9-]{1,4})-(\d{1,20})-source-(\d+)\.manifest\.json$/u.exec(filename);
  if (!/^\d{11}$/u.test(supplierRuc) || !/^[A-Z0-9]{2}$/u.test(documentType) || !match) {
    throw new Error('Invalid local invoice identity');
  }
  const source = Number(match[3]);
  if (!Number.isSafeInteger(source) || source < 0) {
    throw new Error('Invalid local invoice source');
  }
  return {
    documentType,
    number: match[2]!,
    series: match[1]!,
    source,
    supplierRuc,
  };
}

function parsePayloadIdentity(value: unknown): {
  readonly issueDate: string;
  readonly number: string;
  readonly recipientRuc: string;
  readonly series: string;
  readonly supplierRuc: string;
} {
  if (!isRecord(value)) {
    throw new Error('Invalid local JSON payload');
  }
  const issuer = requireRecord(value.datosEmisor);
  const recipient = requireRecord(value.datosReceptor);
  const issueDate = requireString(value.fecEmision);
  const result = {
    issueDate,
    number: String(value.numCpe),
    recipientRuc: requireString(recipient.numDocIdeRecep),
    series: requireString(value.numSerie),
    supplierRuc: requireString(issuer.numRuc),
  };
  if (
    !isDate(result.issueDate) ||
    !/^\d{11}$/u.test(result.recipientRuc) ||
    !/^\d{11}$/u.test(result.supplierRuc) ||
    !/^\d{1,20}$/u.test(result.number)
  ) {
    throw new Error('Invalid local JSON fiscal identity');
  }
  return result;
}

function parseManifest(value: unknown): ParsedManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.artifacts)) {
    throw new Error('Invalid manifest');
  }
  return {
    json: parseManifestArtifact(value.artifacts.json),
    pdf: parseManifestArtifact(value.artifacts.pdf),
  };
}

function parseManifestArtifact(value: unknown): ManifestArtifact {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    path.basename(value.name) !== value.name ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw new Error('Invalid manifest artifact');
  }
  return { name: value.name, sha256: value.sha256, size: value.size };
}

function localArtifact(
  kind: CandidateArtifact['kind'],
  filePath: string,
  manifest: ManifestArtifact,
): CandidateArtifact {
  return {
    contentType: kind === 'pdf' ? 'application/pdf' : 'application/json',
    expectedSha256: manifest.sha256,
    expectedSizeBytes: manifest.size,
    kind,
    source: { adapter: 'local-filesystem', value: filePath },
  };
}

function matchesManifest(body: Buffer, manifest: ManifestArtifact): boolean {
  return body.byteLength === manifest.size && sha256Bytes(body) === manifest.sha256;
}

async function listArtifactFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const relativeDirectory of ['generated', path.join('output', 'pdf')]) {
    const directory = await existingRealDirectory(path.join(root, relativeDirectory));
    if (directory && isWithin(root, directory)) {
      files.push(...(await listRegularFiles(directory)));
    }
  }
  return files;
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(candidate)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

async function existingRealDirectory(value: string): Promise<string | undefined> {
  try {
    const resolved = await realpath(value);
    return (await lstat(resolved)).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function safeSibling(directory: string, name: string): string {
  const candidate = path.resolve(directory, name);
  if (path.dirname(candidate) !== path.resolve(directory)) {
    throw new Error('Manifest artifact escapes its directory');
  }
  return candidate;
}

function quarantineFile(root: string, file: string, reason: QuarantineReason): QuarantineEntry {
  return {
    fingerprint: sha256Text(path.relative(root, file)),
    reason,
  };
}

function stableLocalUuid(identity: string): string {
  const bytes = createHash('sha256')
    .update(`legacy-local:${identity}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Expected text');
  }
  const result = String(value).trim();
  if (result.length === 0) {
    throw new Error('Expected non-empty text');
  }
  return result;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
