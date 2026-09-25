import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: 'AES-256-GCM';
  readonly encryptedDataKey: string;
  readonly dataKeyIv: string;
  readonly dataKeyTag: string;
  readonly ciphertext: string;
  readonly dataIv: string;
  readonly dataTag: string;
}

interface CipherResult {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

function encryptWithKey(key: Buffer, plaintext: Buffer, associatedData: Buffer): CipherResult {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptWithKey(
  key: Buffer,
  ciphertext: Buffer,
  iv: Buffer,
  tag: Buffer,
  associatedData: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class EnvelopeEncryption {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('Envelope encryption master key must contain exactly 32 bytes');
    }
  }

  encrypt(plaintext: Buffer, context: string): EncryptedEnvelope {
    const associatedData = Buffer.from(context, 'utf8');
    const dataKey = randomBytes(32);
    const encryptedData = encryptWithKey(dataKey, plaintext, associatedData);
    const encryptedKey = encryptWithKey(this.masterKey, dataKey, associatedData);
    dataKey.fill(0);

    return {
      version: 1,
      algorithm: 'AES-256-GCM',
      encryptedDataKey: encryptedKey.ciphertext.toString('base64'),
      dataKeyIv: encryptedKey.iv.toString('base64'),
      dataKeyTag: encryptedKey.tag.toString('base64'),
      ciphertext: encryptedData.ciphertext.toString('base64'),
      dataIv: encryptedData.iv.toString('base64'),
      dataTag: encryptedData.tag.toString('base64'),
    };
  }

  decrypt(envelope: EncryptedEnvelope, context: string): Buffer {
    if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') {
      throw new Error('Unsupported encrypted envelope version or algorithm');
    }

    const associatedData = Buffer.from(context, 'utf8');
    const dataKey = decryptWithKey(
      this.masterKey,
      Buffer.from(envelope.encryptedDataKey, 'base64'),
      Buffer.from(envelope.dataKeyIv, 'base64'),
      Buffer.from(envelope.dataKeyTag, 'base64'),
      associatedData,
    );

    try {
      return decryptWithKey(
        dataKey,
        Buffer.from(envelope.ciphertext, 'base64'),
        Buffer.from(envelope.dataIv, 'base64'),
        Buffer.from(envelope.dataTag, 'base64'),
        associatedData,
      );
    } finally {
      dataKey.fill(0);
    }
  }
}
