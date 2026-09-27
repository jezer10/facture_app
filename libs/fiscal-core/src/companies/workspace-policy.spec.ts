import { requireIssuingWorkspace } from './workspace-policy';
import type { EntityManager } from 'typeorm';
function manager(workspace: unknown): EntityManager {
  return {
    getRepository: () => ({ findOneBy: () => Promise.resolve(workspace) }),
  } as unknown as EntityManager;
}
it('allows the isolated sandbox while company verification is pending', async () => {
  await expect(
    requireIssuingWorkspace(manager({ environment: 'sandbox', verifiedAt: null }), 'sandbox'),
  ).resolves.toMatchObject({ environment: 'sandbox' });
});
it('rejects an unverified production workspace', async () => {
  await expect(
    requireIssuingWorkspace(manager({ environment: 'production', verifiedAt: null }), 'production'),
  ).rejects.toThrow('validada');
});
it('stored credentials or verification alone cannot bypass the production connection gate', async () => {
  await expect(
    requireIssuingWorkspace(
      manager({ environment: 'production', verifiedAt: new Date() }),
      'production',
    ),
  ).rejects.toThrow('productiva');
});
