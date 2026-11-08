import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useApiMutation } from '../lib/hooks';
import type { TotpSetupResponse } from '@openestate/shared';

interface Me {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
}

export default function Settings() {
  return (
    <div className="max-w-lg space-y-6">
      <h1 className="page-title">Security</h1>
      <ChangePasswordCard />
      <TwoFactorCard />
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const mutation = useApiMutation<unknown, { currentPassword: string; newPassword: string }>(
    'POST',
    '/auth/change-password',
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    try {
      await mutation.mutateAsync({ currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-medium text-slate-900">Change password</h2>
      <p className="mt-1 text-xs text-slate-500">
        Other devices you&apos;re signed in on will be signed out. This device stays signed in.
      </p>

      {error && (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-2.5 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="mt-3 rounded-md bg-green-50 border border-green-200 p-2.5 text-sm text-green-700">
          Password changed.
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-3 space-y-3">
        <div>
          <label className="block text-sm font-medium text-slate-700">Current password</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 input"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700">New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 input"
          />
        </div>
        <button
          type="submit"
          disabled={mutation.isPending || !currentPassword || newPassword.length < 12}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

function TwoFactorCard() {
  const qc = useQueryClient();
  const { data: me, isLoading } = useQuery<Me>({ queryKey: ['auth', 'me'], queryFn: () => api('/auth/me') });

  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');

  const setupMutation = useApiMutation<TotpSetupResponse, void>('POST', '/auth/totp/setup');
  const confirmMutation = useApiMutation<{ recoveryCodes: string[] }, { code: string }>(
    'POST',
    '/auth/totp/confirm',
  );
  const disableMutation = useApiMutation<unknown, void>('POST', '/auth/totp/disable');

  const startSetup = async () => {
    setError('');
    const result = await setupMutation.mutateAsync();
    setSetup(result);
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const result = await confirmMutation.mutateAsync({ code });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const disable = async () => {
    setError('');
    try {
      await disableMutation.mutateAsync();
      qc.invalidateQueries({ queryKey: ['auth', 'me'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (isLoading) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-medium text-slate-900">Two-factor authentication</h2>

      {error && (
        <div className="mt-3 rounded-md bg-red-50 border border-red-200 p-2.5 text-sm text-red-700">{error}</div>
      )}

      {recoveryCodes && (
        <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm">
          <p className="font-medium text-amber-800">Save these recovery codes — shown once</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900">
            {recoveryCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <button
            onClick={() => setRecoveryCodes(null)}
            className="mt-3 text-sm font-medium text-amber-800 underline"
          >
            Done
          </button>
        </div>
      )}

      {!recoveryCodes && me?.totpEnabled && (
        <div className="mt-3">
          <p className="text-sm text-slate-600">2FA is enabled on your account.</p>
          <button
            onClick={disable}
            disabled={disableMutation.isPending}
            className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {disableMutation.isPending ? 'Disabling…' : 'Disable 2FA'}
          </button>
        </div>
      )}

      {!recoveryCodes && !me?.totpEnabled && !setup && (
        <div className="mt-3">
          <p className="text-sm text-slate-600">2FA is not enabled.</p>
          <button
            onClick={startSetup}
            disabled={setupMutation.isPending}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {setupMutation.isPending ? 'Starting…' : 'Enable 2FA'}
          </button>
        </div>
      )}

      {!recoveryCodes && setup && (
        <form onSubmit={confirm} className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">
            Scan this with your authenticator app, then enter the 6-digit code it shows.
          </p>
          <img
            src={setup.qrDataUrl}
            alt="QR code for authenticator app setup"
            width={176}
            height={176}
          />
          <p className="text-sm text-slate-600">Can&apos;t scan? Enter this key manually.</p>
          <div className="rounded-md bg-slate-50 border border-slate-200 p-2.5 font-mono text-xs break-all">
            {setup.secret}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">6-digit code</label>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-1 input"
            />
          </div>
          <button
            type="submit"
            disabled={confirmMutation.isPending || code.length !== 6}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {confirmMutation.isPending ? 'Confirming…' : 'Confirm'}
          </button>
        </form>
      )}
    </div>
  );
}
