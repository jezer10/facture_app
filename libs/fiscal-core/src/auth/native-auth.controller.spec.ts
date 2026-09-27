import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NativeAuthController } from './native-auth.controller';
import type { NativeAuthService } from './native-auth.service';
import type { BrowserSessionService } from './browser-session.service';
it('blocks cross-origin requests before invoking authentication', async () => {
  const login = jest.fn();
  const controller = new NativeAuthController(
    { login } as unknown as NativeAuthService,
    {
      assertOrigin: () => {
        throw new ForbiddenException();
      },
    } as unknown as BrowserSessionService,
  );
  await expect(
    controller.login(
      { email: 'test@example.test', password: 'test' },
      {} as Request,
      {} as Response,
    ),
  ).rejects.toThrow(ForbiddenException);
  expect(login).not.toHaveBeenCalled();
});
it('rotates the browser session and keeps all tokens out of the JSON response', async () => {
  const login = jest.fn().mockResolvedValue({
      step: 'authenticated',
      token: 'private-session',
      expiresAt: new Date(),
      binding: 'private-binding',
    }),
    remove = jest.fn().mockResolvedValue(undefined);
  const controller = new NativeAuthController(
    { login } as unknown as NativeAuthService,
    {
      config: { secure: true },
      assertOrigin: jest.fn(),
      remove,
    } as unknown as BrowserSessionService,
  );
  const response = {
    setHeader: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    json: jest.fn(),
  };
  await controller.login(
    { email: 'test@example.test', password: 'test' },
    {} as Request,
    response as unknown as Response,
  );
  expect(remove).toHaveBeenCalledTimes(1);
  expect(response.cookie).toHaveBeenCalledWith(
    'facture_session',
    'private-session',
    expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax' }),
  );
  expect(JSON.stringify(response.json.mock.calls)).not.toContain('private');
  expect(response.json).toHaveBeenCalledWith({
    step: 'authenticated',
    message: undefined,
    challenge: undefined,
  });
});
