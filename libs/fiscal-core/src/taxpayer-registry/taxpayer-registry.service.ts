import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { isValidPeruvianRuc } from '../administration/administration.service';
export interface TaxpayerLookup {
  found: boolean;
  source: 'SUNAT';
  sourceDate: string;
  importedAt: string;
  stale: boolean;
  taxpayer?: {
    ruc: string;
    legalName: string;
    status: string;
    condition: string;
    ubigeo: string;
    address: string;
  };
}
@Injectable()
export class TaxpayerRegistryService implements OnModuleDestroy {
  private database?: DatabaseSync;
  private version = '';
  lookup(ruc: string): TaxpayerLookup {
    if (!isValidPeruvianRuc(ruc)) throw new BadRequestException('Revisa los 11 dígitos del RUC.');
    try {
      const file = resolve(process.env.SUNAT_PADRON_DB_FILE ?? 'generated/sunat/padron.sqlite');
      const stat = statSync(file);
      const version = `${file}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (version !== this.version) {
        const next = new DatabaseSync(file, { readOnly: true });
        try {
          next.prepare('SELECT value FROM metadata WHERE key=?').get('sourceDate');
        } catch (error) {
          next.close();
          throw error;
        }
        this.database?.close();
        this.database = next;
        this.version = version;
      }
      const metadata = Object.fromEntries(
        (
          this.database!.prepare('SELECT key,value FROM metadata').all() as {
            key: string;
            value: string;
          }[]
        ).map((row) => [row.key, row.value]),
      );
      if (!metadata.sourceDate || !metadata.importedAt)
        throw new Error('Missing registry metadata');
      const taxpayer = this.database!.prepare(
        'SELECT ruc,legal_name AS legalName,status,condition,ubigeo,address FROM taxpayers WHERE ruc=?',
      ).get(ruc) as TaxpayerLookup['taxpayer'];
      return {
        found: !!taxpayer,
        source: 'SUNAT',
        sourceDate: metadata.sourceDate,
        importedAt: metadata.importedAt,
        stale: Date.now() - Date.parse(`${metadata.sourceDate}T00:00:00Z`) > 7 * 86400000,
        ...(taxpayer ? { taxpayer } : {}),
      };
    } catch {
      throw new ServiceUnavailableException(
        'El padrón no está disponible. Puedes completar los datos manualmente y guardar el borrador.',
      );
    }
  }
  onModuleDestroy(): void {
    this.database?.close();
    this.database = undefined;
    this.version = '';
  }
}
