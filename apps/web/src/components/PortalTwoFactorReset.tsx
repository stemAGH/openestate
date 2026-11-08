import { useState } from 'react';
import { NO_PORTAL_ACCOUNT_ERROR, twoFactorResetResponseSchema } from '@openestate/shared';
import { api, type ApiError } from '../lib/api';

type Outcome = 'cleared' | 'already-off' | 'no-account' | null;

/**
 * "Reset portal 2FA" for a customer's or broker's portal account, used on
 * Applicant360 and BrokerDetail. Callers gate it on ADMIN_USER_UPDATE on its
 * own, not inside the ADMIN_PORTAL_INVITE_SEND block beside it: the API
 * requires ADMIN_USER_UPDATE, and nesting would hide it from a role that holds
 * only that.
 *
 * There's no "2FA is on" indicator here — the staff app never reads a portal
 * user's 2FA state — so the response's wasEnabled decides what to say.
 */
export default function PortalTwoFactorReset({
  principal,
  name,
}: {
  principal: { applicantId: string } | { brokerId: string };
  name: string;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [error, setError] = useState('');

  async function reset() {
    if (
      !window.confirm(
        `Reset two-factor authentication for ${name}'s portal account?\n\n` +
          'They will sign in with their password alone and can set up 2FA again. ' +
          'Any device they are signed in on is signed out within 15 minutes. ' +
          'Their password does not change.',
      )
    ) {
      return;
    }
    setOutcome(null);
    setError('');
    setPending(true);
    try {
      const res = await api<unknown>('/admin/portal-2fa-resets', { method: 'POST', body: JSON.stringify(principal) });
      setOutcome(twoFactorResetResponseSchema.parse(res).wasEnabled ? 'cleared' : 'already-off');
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 409 && apiErr.body?.code === NO_PORTAL_ACCOUNT_ERROR) setOutcome('no-account');
      else setError(apiErr.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        onClick={reset}
        disabled={pending}
        className="btn btn-secondary px-3 py-1.5 text-sm"
      >
        {pending ? 'Resetting…' : 'Reset portal 2FA'}
      </button>
      <p className="mt-1 text-xs text-slate-500">For someone who has lost their authenticator and recovery codes.</p>
      {outcome === 'cleared' && (
        <p role="status" className="mt-1 text-xs text-slate-700">
          Two-factor authentication cleared. They can sign in with their password and set it up again.
        </p>
      )}
      {outcome === 'already-off' && (
        <p role="status" className="mt-1 text-xs text-slate-700">
          Two-factor authentication was already off for this account — nothing to clear.
        </p>
      )}
      {outcome === 'no-account' && (
        <p role="status" className="mt-1 text-xs text-slate-600">
          This person doesn&apos;t have a portal account yet, so there is no 2FA to reset.
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
