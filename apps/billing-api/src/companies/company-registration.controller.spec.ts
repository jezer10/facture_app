import 'reflect-metadata';
import { validate } from 'class-validator';
import { ForbiddenException } from '@nestjs/common';
import type { CompanyRegistrationService } from '@app/fiscal-core';
import { type BrowserSessionService } from '@app/fiscal-core';
import {
  CompanyDraftDto,
  CompanyRegistrationController,
  CompanyReviewController,
} from './company-registration.controller';
import type { Request } from 'express';
it('rejects null draft fields instead of persisting values the form cannot render', async () => {
  expect((await validate(Object.assign(new CompanyDraftDto(), { legalName: null }))).length).toBe(
    1,
  );
});
it('requires an authenticated identity for listing and CSRF-checked identity for writes', async () => {
  const identity = jest.fn().mockRejectedValue(new ForbiddenException());
  const save = jest.fn(),
    list = jest.fn(),
    submit = jest.fn();
  const controller = new CompanyRegistrationController(
    { identity } as unknown as BrowserSessionService,
    { save, list, submit } as unknown as CompanyRegistrationService,
  );
  await expect(controller.list({} as Request)).rejects.toBeInstanceOf(ForbiddenException);
  await expect(controller.save({} as Request, 'id', {})).rejects.toBeInstanceOf(ForbiddenException);
  await expect(controller.submit({} as Request, 'id')).rejects.toBeInstanceOf(ForbiddenException);
  expect(save).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});
it('requires a platform reviewer and explicit independent checks', () => {
  const decide = jest.fn();
  const controller = new CompanyReviewController({
    decide,
  } as unknown as CompanyRegistrationService);
  const body = {
    decision: 'approve' as const,
    note: 'Datos comprobados',
    evidenceReference: 'Expediente externo',
    registryChecked: true,
    authorityChecked: true,
  };
  expect(() =>
    controller.decide(
      'id',
      { kind: 'human', subject: 'owner', platformAdmin: false, role: 'owner' },
      body,
    ),
  ).toThrow(ForbiddenException);
  expect(() =>
    controller.decide(
      'id',
      { kind: 'human', subject: 'reviewer', platformAdmin: true },
      { ...body, authorityChecked: false },
    ),
  ).toThrow(ForbiddenException);
  expect(decide).not.toHaveBeenCalled();
});
