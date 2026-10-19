import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { E2eFixture } from './seed';

interface AllFixtures {
  authTwoFactor: E2eFixture;
  mastersCrud: E2eFixture;
  leadStage: E2eFixture;
  chequeBounce: E2eFixture;
  plcBooking: E2eFixture;
  ticketReply: E2eFixture;
  portalTwoFactor: E2eFixture;
  resetLinks: E2eFixture;
  staffRecoveryCode: E2eFixture;
  portalRecoveryCode: E2eFixture;
  staffTotpReset: E2eFixture;
  portalTotpReset: E2eFixture;
  rolesPortal: E2eFixture;
  portalSessionEnded: E2eFixture;
  interestRule: E2eFixture;
}

/** Reads the named fixture global-setup.ts wrote before any spec ran. */
export function readFixture(name: keyof AllFixtures): E2eFixture {
  const raw = readFileSync(path.join(__dirname, '..', '.fixture-state.json'), 'utf8');
  const all = JSON.parse(raw) as AllFixtures;
  return all[name];
}
