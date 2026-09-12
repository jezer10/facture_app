import { Module } from '@nestjs/common';
import { parseEnvironment, readSecretFile } from '../config';
import { OBJECT_STORAGE_PORT } from './object-storage.port';
import { R2ObjectStorage } from './r2-object-storage';

@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_PORT,
      useFactory: () => {
        const environment = parseEnvironment(process.env);
        if (
          !environment.R2_ENDPOINT ||
          !environment.R2_ACCESS_KEY_ID_FILE ||
          !environment.R2_SECRET_ACCESS_KEY_FILE
        ) {
          throw new Error(
            'R2 storage configuration is required; no implicit in-memory storage is available',
          );
        }
        return new R2ObjectStorage({
          endpoint: environment.R2_ENDPOINT,
          region: environment.R2_REGION,
          bucket: environment.R2_BUCKET,
          accessKeyId: readSecretFile(environment.R2_ACCESS_KEY_ID_FILE).toString('utf8'),
          secretAccessKey: readSecretFile(environment.R2_SECRET_ACCESS_KEY_FILE).toString('utf8'),
        });
      },
    },
  ],
  exports: [OBJECT_STORAGE_PORT],
})
export class ObjectStorageModule {}
