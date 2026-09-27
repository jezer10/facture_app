import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { SOURCE_URL, SOURCE_PAGE, parseRow, assertHeader, assertDate } from './format.mjs';
const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    'source-date': { type: 'string' },
    output: { type: 'string' },
  },
});
const target = resolve(
  values.output ?? process.env.SUNAT_PADRON_DB_FILE ?? 'generated/sunat/padron.sqlite',
);
await mkdir(dirname(target), { recursive: true });
const lock = await open(`${target}.lock`, 'wx', 0o600).catch(() => {
  throw new Error('An import is already running; check the .lock file before retrying.');
});
const stage = `${target}.${randomUUID()}.tmp`;
const download = `${stage}.zip`;
let database;
let child;
try {
  let zip = values.file && resolve(values.file),
    sourceDate = values['source-date'];
  if (!zip) {
    const page = await fetch(SOURCE_PAGE, { signal: AbortSignal.timeout(30000) });
    if (!page.ok) throw new Error('Could not read the official publication date');
    const match = (await page.text()).match(/Actualizado al\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) throw new Error('Official publication date not found');
    sourceDate = `${match[3]}-${match[2]}-${match[1]}`;
    const response = await fetch(SOURCE_URL, {
      signal: AbortSignal.timeout(600000),
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('Official download failed');
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > 1024 ** 3 ? new Error('Archive exceeds 1 GiB limit') : null, chunk);
        },
      }),
      createWriteStream(download, { flags: 'wx', mode: 0o600 }),
    );
    zip = download;
  }
  assertDate(sourceDate);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const archiveHash = hash.digest('hex');
  database = new DatabaseSync(stage);
  database.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; CREATE TABLE taxpayers(ruc TEXT NOT NULL, legal_name TEXT NOT NULL, status TEXT NOT NULL, condition TEXT NOT NULL, ubigeo TEXT NOT NULL, address TEXT NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID; BEGIN;',
  );
  const insert = database.prepare('INSERT INTO taxpayers VALUES(?,?,?,?,?,?)');
  child = spawn('unzip', ['-p', zip, 'padron_reducido_ruc.txt'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Never extract paths from the archive. The one expected entry streams directly into SQLite.
  const completion = new Promise((res, rej) => {
    child.once('error', rej);
    child.once('close', (code) =>
      code === 0 ? res() : rej(new Error('ZIP extraction or CRC verification failed')),
    );
  });
  completion.catch(() => {});
  child.stderr.resume();
  const decoder = new TextDecoder('windows-1252');
  const decoded = child.stdout.pipe(
    new Transform({
      transform(chunk, _encoding, done) {
        done(null, decoder.decode(chunk, { stream: true }));
      },
      flush(done) {
        this.push(decoder.decode());
        done();
      },
    }),
  );
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  const skippedLines = [];
  let lineNumber = 0;
  let count = 0,
    header = false;
  for await (const line of lines) {
    lineNumber++;
    if (!header) {
      assertHeader(line);
      header = true;
      continue;
    }
    let row;
    try {
      row = parseRow(line);
    } catch {
      skippedLines.push(lineNumber);
      if (skippedLines.length > 100)
        throw new Error('Too many malformed rows; previous database is preserved');
      continue;
    }
    if (!row) continue;
    insert.run(...row);
    count++;
    if (count % 250000 === 0) {
      database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); BEGIN;');
      console.log(`Imported ${count.toLocaleString('en-US')} records`);
    }
  }
  await completion;
  if (count < 1000000) throw new Error('Incomplete national padrón: fewer than 1 million rows');
  const metadata = database.prepare('INSERT INTO metadata VALUES(?,?)');
  for (const [key, value] of Object.entries({
    sourceUrl: SOURCE_URL,
    sourceDate,
    importedAt: new Date().toISOString(),
    rows: String(count),
    sha256: archiveHash,
    skippedLines: JSON.stringify(skippedLines),
  }))
    metadata.run(key, value);
  database.exec(
    'COMMIT; CREATE UNIQUE INDEX taxpayers_ruc ON taxpayers(ruc); PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;',
  );
  if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
    throw new Error('SQLite integrity check failed');
  database.close();
  database = undefined;
  const handle = await open(stage, 'r+');
  await handle.sync();
  await handle.close();
  await rename(stage, target);
  console.log(
    JSON.stringify({
      file: target,
      sourceDate,
      rows: count,
      skippedRows: skippedLines.length,
      sha256: archiveHash,
    }),
  );
} finally {
  child?.kill();
  database?.close();
  await rm(stage, { force: true });
  for (const suffix of ['-wal', '-shm', '-journal']) await rm(stage + suffix, { force: true });
  await rm(download, { force: true });
  await lock.close();
  await rm(`${target}.lock`, { force: true });
}
