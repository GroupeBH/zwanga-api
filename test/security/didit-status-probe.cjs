// Characterize a trust-boundary failure without .env, database or network.
// This is an audit reproducer, NOT a regression assertion accepting the behavior.
// Run: node test/security/didit-status-probe.cjs
const path = require('node:path');
require('ts-node').register({ project: path.join(__dirname, '../../tsconfig.json'), transpileOnly: true });
const { Logger } = require('@nestjs/common');
const { DiditKycService } = require('../../src/users/didit-kyc.service');
const { KycProvider, KycStatus } = require('../../src/users/entities/kyc-document.entity');
const { UserRole, UserStatus } = require('../../src/users/entities/user.entity');
Logger.overrideLogger(false);

async function probe(providerStatus) {
  const user = { id: '00000000-0000-4000-8000-000000000001', role: UserRole.PASSENGER,
    status: UserStatus.PENDING_KYC, isDriver: false, isActive: true };
  const kyc = { id: '00000000-0000-4000-8000-000000000002', userId: user.id,
    provider: KycProvider.DIDIT, diditSessionId: 'synthetic-owned-session', status: KycStatus.PENDING };
  const users = { findOne: async () => user, update: async (_id, patch) => Object.assign(user, patch) };
  const dossiers = { findOne: async () => kyc, save: async (value) => value, create: (value) => value };
  const dataSource = { transaction: async (callback) => callback({ getRepository: (entity) => {
    if (entity.name === 'User') return users;
    if (entity.name === 'Vehicle') return { exists: async () => false };
    return dossiers;
  } }) };
  const config = { get: (key) => ({ DIDIT_API_KEY: 'synthetic-fixture-key',
    DIDIT_WORKFLOW_ID: 'synthetic-workflow', DIDIT_KYC_ENABLED: 'true' })[key] };
  const service = new DiditKycService(users, dossiers, config, dataSource);
  const originalFetch = global.fetch;
  let simulatedProviderCalls = 0;
  global.fetch = async () => {
    simulatedProviderCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      session_id: kyc.diditSessionId, vendor_data: user.id,
      ...(providerStatus === undefined ? {} : { status: providerStatus }),
    }) };
  };
  try {
    let result;
    let rejectedCode = null;
    try {
      result = await service.syncSession(user.id, { sessionId: kyc.diditSessionId, status: 'Approved' });
    } catch (error) {
      if (error.getStatus?.() !== 502 || error.getResponse?.().code !== 'KYC_PROVIDER_INVALID_RESPONSE') throw error;
      rejectedCode = error.getResponse().code;
    }
    if (simulatedProviderCalls !== 1) throw new Error('Provider decision branch was not exercised.');
    return { providerStatus: providerStatus === undefined ? 'MISSING' : providerStatus,
      clientStatus: 'Approved', savedStatus: kyc.status, accountStatus: user.status, rejectedCode,
      simulatedProviderCalls, realProviderCalls: 0,
      clientApprovalAccepted: result?.status === KycStatus.APPROVED || kyc.status === KycStatus.APPROVED || user.status === UserStatus.ACTIVE };
  } finally { global.fetch = originalFetch; }
}

(async () => {
  let findings = 0;
  for (const providerStatus of ['In Review', undefined, null, '']) {
    const result = await probe(providerStatus);
    console.log(JSON.stringify(result));
    if (result.clientApprovalAccepted) findings++;
  }
  console.log(JSON.stringify({ finding: 'DIDIT_CLIENT_STATUS_FALLBACK', reproducedCases: findings,
    scope: 'in-memory service characterization; no live provider or database' }));
  if (findings) process.exitCode = 1;
})().catch(() => { console.error('Isolated probe failed unexpectedly.'); process.exitCode = 2; });
