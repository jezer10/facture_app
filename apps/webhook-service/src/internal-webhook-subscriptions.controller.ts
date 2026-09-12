import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  PermanentWebhookDeliveryError,
  type WebhookSubscriptionView,
  WebhookSubscriptionConfigurationService,
} from '@app/webhooks';

import { InternalWebhookAuthGuard } from './internal-webhook-auth.guard';

@Controller('internal/organizations/:organizationId/webhook-subscriptions')
@UseGuards(InternalWebhookAuthGuard)
export class InternalWebhookSubscriptionsController {
  constructor(private readonly configurationService: WebhookSubscriptionConfigurationService) {}

  @Get()
  async list(
    @Param('organizationId') organizationId: string,
  ): Promise<Readonly<{ items: readonly WebhookSubscriptionView[] }>> {
    try {
      const items = await this.configurationService.list(organizationId);
      return { items };
    } catch (error) {
      rethrowConfigurationError(error);
    }
  }

  @Put(':subscriptionId')
  @HttpCode(200)
  async configure(
    @Param('organizationId') organizationId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() body: unknown,
  ): Promise<WebhookSubscriptionView> {
    try {
      return await this.configurationService.configure(organizationId, subscriptionId, body);
    } catch (error) {
      rethrowConfigurationError(error);
    }
  }
}

function rethrowConfigurationError(error: unknown): never {
  if (error instanceof PermanentWebhookDeliveryError) {
    throw new BadRequestException({
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}
