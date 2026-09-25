import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import type { EnvelopeEncryption } from '@app/platform';
import { ArrayContains, type DataSource, type EntityManager } from 'typeorm';

import {
  WebhookDeadLetterEntity,
  WebhookDeliveryAttemptEntity,
  WebhookDeliveryEntity,
  WebhookSecretVersionEntity,
  WebhookSubscriptionEntity,
} from '../database/entities';
import type {
  ClaimWebhookDeliveryInput,
  CompleteWebhookDeliveryInput,
  WebhookDeadLetter,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryClaim,
} from '../domain/webhook-delivery';
import type {
  SaveWebhookSubscriptionOptions,
  WebhookRepository,
} from '../domain/webhook-repository';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import {
  PermanentWebhookDeliveryError,
  TransientWebhookDeliveryError,
} from '../domain/webhook.errors';
import { WebhookSecretCipher } from './webhook-secret-cipher';

export class TypeOrmWebhookRepository implements WebhookRepository {
  private readonly secretCipher: WebhookSecretCipher;

  constructor(
    private readonly dataSource: DataSource,
    encryption: EnvelopeEncryption,
  ) {
    this.secretCipher = new WebhookSecretCipher(encryption);
  }

  async checkHealth(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }

  async claimDelivery(input: ClaimWebhookDeliveryInput): Promise<WebhookDeliveryClaim> {
    return this.dataSource.transaction(async (manager) => {
      await acquireTransactionLock(manager, deliveryLockKey(input));
      const repository = manager.getRepository(WebhookDeliveryEntity);
      let delivery = await repository.findOne({
        where: {
          eventId: input.eventId,
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (delivery !== null && delivery.bodySha256 !== input.bodySha256) {
        throw new PermanentWebhookDeliveryError(
          'EVENT_ID_PAYLOAD_CONFLICT',
          'A webhook event ID was reused with a different canonical payload',
        );
      }
      if (
        delivery?.status === 'dead_letter' ||
        delivery?.status === 'delivered' ||
        delivery?.status === 'permanent_failure'
      ) {
        return { decision: 'final' };
      }

      const startedAt = new Date(input.startedAt);
      if (
        delivery?.status === 'processing' &&
        delivery.leaseExpiresAt !== null &&
        delivery.leaseExpiresAt.getTime() > startedAt.getTime()
      ) {
        return { decision: 'busy' };
      }

      const lockToken = randomUUID();
      if (delivery === null) {
        delivery = repository.create({
          attemptCount: input.attempt,
          bodySha256: input.bodySha256,
          deliveredAt: null,
          eventId: input.eventId,
          eventType: input.eventType,
          failureCode: null,
          firstAttemptAt: startedAt,
          lastAttemptAt: startedAt,
          leaseExpiresAt: new Date(input.leaseExpiresAt),
          lockToken,
          organizationId: input.organizationId,
          rawBody: input.rawBody,
          responseStatus: null,
          status: 'processing',
          subscriptionId: input.subscriptionId,
        });
      } else {
        delivery.attemptCount = Math.max(delivery.attemptCount, input.attempt);
        delivery.eventType = input.eventType;
        delivery.failureCode = null;
        delivery.lastAttemptAt = startedAt;
        delivery.leaseExpiresAt = new Date(input.leaseExpiresAt);
        delivery.lockToken = lockToken;
        delivery.responseStatus = null;
        delivery.status = 'processing';
      }
      const savedDelivery = await repository.save(delivery);

      const attempt = manager.getRepository(WebhookDeliveryAttemptEntity).create({
        attemptNumber: input.attempt,
        completedAt: null,
        deliveryId: savedDelivery.id,
        failureCode: null,
        organizationId: input.organizationId,
        responseStatus: null,
        startedAt,
        status: 'processing',
      });
      const savedAttempt = await manager.getRepository(WebhookDeliveryAttemptEntity).save(attempt);

      return {
        attemptId: savedAttempt.id,
        decision: 'claimed',
        lockToken,
      };
    });
  }

  async completeDelivery(input: CompleteWebhookDeliveryInput): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await acquireTransactionLock(manager, deliveryLockKey(input));
      const deliveryRepository = manager.getRepository(WebhookDeliveryEntity);
      const delivery = await deliveryRepository.findOne({
        where: {
          eventId: input.eventId,
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (
        delivery === null ||
        delivery.status !== 'processing' ||
        delivery.lockToken !== input.lockToken
      ) {
        throw leaseLost();
      }

      const attemptRepository = manager.getRepository(WebhookDeliveryAttemptEntity);
      const attempt = await attemptRepository.findOne({
        where: {
          deliveryId: delivery.id,
          id: input.attemptId,
          organizationId: input.organizationId,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (attempt === null || attempt.status !== 'processing') {
        throw leaseLost();
      }

      const completedAt = new Date(input.completedAt);
      delivery.deliveredAt = input.status === 'delivered' ? completedAt : null;
      delivery.failureCode = input.failureCode ?? null;
      delivery.lastAttemptAt = completedAt;
      delivery.leaseExpiresAt = null;
      delivery.lockToken = null;
      delivery.responseStatus = input.responseStatus ?? null;
      delivery.status = input.status;

      attempt.completedAt = completedAt;
      attempt.failureCode = input.failureCode ?? null;
      attempt.responseStatus = input.responseStatus ?? null;
      attempt.status = input.status;

      await deliveryRepository.save(delivery);
      await attemptRepository.save(attempt);

      if (input.status === 'dead_letter' || input.status === 'permanent_failure') {
        await saveDeadLetter(manager, delivery, input);
      }
    });
  }

  async findDeadLetter(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDeadLetter | undefined> {
    const entity = await this.dataSource
      .getRepository(WebhookDeadLetterEntity)
      .findOne({ where: { eventId, organizationId, subscriptionId } });
    return entity === null ? undefined : mapDeadLetter(entity);
  }

  async findDelivery(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<WebhookDelivery | undefined> {
    const entity = await this.dataSource
      .getRepository(WebhookDeliveryEntity)
      .findOne({ where: { eventId, organizationId, subscriptionId } });
    return entity === null ? undefined : mapDelivery(entity);
  }

  async findSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<WebhookSubscription | undefined> {
    const entity = await this.dataSource
      .getRepository(WebhookSubscriptionEntity)
      .findOne({ where: { id: subscriptionId, organizationId } });
    if (entity === null) {
      return undefined;
    }
    return this.hydrateSubscription(this.dataSource.manager, entity);
  }

  async listActiveSubscriptions(
    organizationId: string,
    eventType: string,
  ): Promise<readonly WebhookSubscription[]> {
    const entities = await this.dataSource.getRepository(WebhookSubscriptionEntity).find({
      order: { id: 'ASC' },
      where: {
        eventTypes: ArrayContains([eventType]),
        organizationId,
        status: 'active',
      },
    });
    return Promise.all(
      entities.map((entity) => this.hydrateSubscription(this.dataSource.manager, entity)),
    );
  }

  async listDeliveryAttempts(
    organizationId: string,
    eventId: string,
    subscriptionId: string,
  ): Promise<readonly WebhookDeliveryAttempt[]> {
    const delivery = await this.dataSource
      .getRepository(WebhookDeliveryEntity)
      .findOne({ where: { eventId, organizationId, subscriptionId } });
    if (delivery === null) {
      return [];
    }
    const attempts = await this.dataSource.getRepository(WebhookDeliveryAttemptEntity).find({
      order: { startedAt: 'ASC' },
      where: { deliveryId: delivery.id, organizationId },
    });
    return attempts.map((attempt) => mapAttempt(attempt, delivery));
  }

  async listSubscriptions(organizationId: string): Promise<readonly WebhookSubscription[]> {
    const entities = await this.dataSource
      .getRepository(WebhookSubscriptionEntity)
      .find({ order: { id: 'ASC' }, where: { organizationId } });
    return Promise.all(
      entities.map((entity) => this.hydrateSubscription(this.dataSource.manager, entity)),
    );
  }

  async saveSubscription(
    subscription: WebhookSubscription,
    options: SaveWebhookSubscriptionOptions = { secretWasProvided: true },
  ): Promise<WebhookSubscription> {
    return this.dataSource.transaction(async (manager) => {
      await acquireTransactionLock(
        manager,
        `subscription:${subscription.organizationId}:${subscription.id}`,
      );
      const repository = manager.getRepository(WebhookSubscriptionEntity);
      let entity = await repository.findOne({
        where: {
          id: subscription.id,
          organizationId: subscription.organizationId,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (entity === null) {
        entity = repository.create({
          activeSecretVersion: 1,
          createdAt: new Date(subscription.createdAt),
          endpointUrl: subscription.endpointUrl,
          eventTypes: [...subscription.eventTypes],
          id: subscription.id,
          organizationId: subscription.organizationId,
          status: subscription.status,
          updatedAt: new Date(subscription.updatedAt),
        });
        await repository.save(entity);
        await this.createSecretVersion(manager, subscription, 1);
      } else {
        if (options.secretWasProvided) {
          const currentSecret = await this.loadSecretVersion(
            manager,
            entity.organizationId,
            entity.id,
            entity.activeSecretVersion,
            true,
          );
          if (!secretsEqual(currentSecret, subscription.secret)) {
            await manager.getRepository(WebhookSecretVersionEntity).update(
              {
                organizationId: entity.organizationId,
                subscriptionId: entity.id,
                version: entity.activeSecretVersion,
              },
              { retiredAt: new Date(subscription.updatedAt) },
            );
            entity.activeSecretVersion += 1;
            await this.createSecretVersion(manager, subscription, entity.activeSecretVersion);
          }
        }

        entity.endpointUrl = subscription.endpointUrl;
        entity.eventTypes = [...subscription.eventTypes];
        entity.status = subscription.status;
        entity.updatedAt = new Date(subscription.updatedAt);
        await repository.save(entity);
      }

      return {
        createdAt: entity.createdAt.toISOString(),
        endpointUrl: entity.endpointUrl,
        eventTypes: [...entity.eventTypes],
        id: entity.id,
        organizationId: entity.organizationId,
        secret: subscription.secret,
        status: entity.status,
        updatedAt: entity.updatedAt.toISOString(),
      };
    });
  }

  private async createSecretVersion(
    manager: EntityManager,
    subscription: WebhookSubscription,
    version: number,
  ): Promise<void> {
    const entity = manager.getRepository(WebhookSecretVersionEntity).create({
      encryptedEnvelope: this.secretCipher.encrypt(
        subscription.secret,
        subscription.organizationId,
        subscription.id,
        version,
      ),
      organizationId: subscription.organizationId,
      retiredAt: null,
      subscriptionId: subscription.id,
      version,
    });
    await manager.getRepository(WebhookSecretVersionEntity).save(entity);
  }

  private async hydrateSubscription(
    manager: EntityManager,
    entity: WebhookSubscriptionEntity,
  ): Promise<WebhookSubscription> {
    const secret = await this.loadSecretVersion(
      manager,
      entity.organizationId,
      entity.id,
      entity.activeSecretVersion,
      false,
    );
    return {
      createdAt: entity.createdAt.toISOString(),
      endpointUrl: entity.endpointUrl,
      eventTypes: [...entity.eventTypes],
      id: entity.id,
      organizationId: entity.organizationId,
      secret,
      status: entity.status,
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private async loadSecretVersion(
    manager: EntityManager,
    organizationId: string,
    subscriptionId: string,
    version: number,
    lock: boolean,
  ): Promise<string> {
    const options = {
      where: { organizationId, subscriptionId, version },
      ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    };
    const entity = await manager.getRepository(WebhookSecretVersionEntity).findOne(options);
    if (entity === null) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_SUBSCRIPTION',
        'Webhook subscription has no active encrypted secret version',
      );
    }

    try {
      return this.secretCipher.decrypt(
        entity.encryptedEnvelope,
        organizationId,
        subscriptionId,
        version,
      );
    } catch (error) {
      throw new PermanentWebhookDeliveryError(
        'INVALID_SUBSCRIPTION',
        'Webhook subscription secret could not be decrypted',
        { cause: error },
      );
    }
  }
}

async function acquireTransactionLock(manager: EntityManager, key: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function deliveryLockKey(input: {
  readonly eventId: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
}): string {
  return `delivery:${input.organizationId}:${input.eventId}:${input.subscriptionId}`;
}

function leaseLost(): TransientWebhookDeliveryError {
  return new TransientWebhookDeliveryError(
    'DELIVERY_LEASE_LOST',
    'Webhook delivery lease was lost before completion',
  );
}

function mapAttempt(
  entity: WebhookDeliveryAttemptEntity,
  delivery: WebhookDeliveryEntity,
): WebhookDeliveryAttempt {
  return {
    attempt: entity.attemptNumber,
    ...(entity.completedAt === null ? {} : { completedAt: entity.completedAt.toISOString() }),
    eventId: delivery.eventId,
    ...(entity.failureCode === null ? {} : { failureCode: entity.failureCode }),
    id: entity.id,
    organizationId: entity.organizationId,
    ...(entity.responseStatus === null ? {} : { responseStatus: entity.responseStatus }),
    startedAt: entity.startedAt.toISOString(),
    status: entity.status,
    subscriptionId: delivery.subscriptionId,
  };
}

function mapDeadLetter(entity: WebhookDeadLetterEntity): WebhookDeadLetter {
  return {
    createdAt: entity.createdAt.toISOString(),
    eventId: entity.eventId,
    failureCode: entity.failureCode,
    id: entity.id,
    organizationId: entity.organizationId,
    subscriptionId: entity.subscriptionId,
  };
}

function mapDelivery(entity: WebhookDeliveryEntity): WebhookDelivery {
  return {
    attempt: entity.attemptCount,
    bodySha256: entity.bodySha256,
    ...(entity.deliveredAt === null ? {} : { deliveredAt: entity.deliveredAt.toISOString() }),
    eventId: entity.eventId,
    eventType: entity.eventType,
    ...(entity.failureCode === null ? {} : { failureCode: entity.failureCode }),
    firstAttemptAt: entity.firstAttemptAt.toISOString(),
    lastAttemptAt: entity.lastAttemptAt.toISOString(),
    ...(entity.leaseExpiresAt === null
      ? {}
      : { leaseExpiresAt: entity.leaseExpiresAt.toISOString() }),
    ...(entity.lockToken === null ? {} : { lockToken: entity.lockToken }),
    organizationId: entity.organizationId,
    rawBody: entity.rawBody,
    ...(entity.responseStatus === null ? {} : { responseStatus: entity.responseStatus }),
    status: entity.status,
    subscriptionId: entity.subscriptionId,
  };
}

async function saveDeadLetter(
  manager: EntityManager,
  delivery: WebhookDeliveryEntity,
  input: CompleteWebhookDeliveryInput,
): Promise<void> {
  const repository = manager.getRepository(WebhookDeadLetterEntity);
  const existing = await repository.findOne({
    where: { deliveryId: delivery.id },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing !== null) {
    return;
  }

  await repository.save(
    repository.create({
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      failureCode: input.failureCode ?? 'UNCLASSIFIED_FAILURE',
      organizationId: delivery.organizationId,
      subscriptionId: delivery.subscriptionId,
    }),
  );
}

function secretsEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
