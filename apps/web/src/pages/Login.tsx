import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginDto } from '@openestate/shared';
import { useAuth } from '../lib/auth';
import { Navigate } from 'react-router-dom';
import TotpVerify from './TotpVerify';

export default function Login() {
  const { user, login, isLoading, sessionEndedMessage } = useAuth();
  const [error, setError] = useState('');
  const [totpState, setTotpState] = useState<{ tempToken: string } | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginDto>({ resolver: zodResolver(loginSchema) });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-slate-500">Loading…</div>
      </div>
    );
  }

  if (user) return <Navigate to="/" replace />;

  if (totpState) {
    return <TotpVerify tempToken={totpState.tempToken} onBack={() => setTotpState(null)} />;
  }

  const onSubmit = async (data: LoginDto) => {
    setError('');
    const result = await login(data.email, data.password);
    if (!result.ok) {
      if ('requiresTwoFactor' in result) {
        setTotpState({ tempToken: result.tempToken });
      } else {
        setError(result.error);
      }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-slate-900 text-center">OpenEstate</h1>
          <p className="mt-1 text-sm text-slate-500 text-center">Sign in to your account</p>

          {sessionEndedMessage && !error && (
            <div role="status" className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
              {sessionEndedMessage}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                {...register('email')}
                className="mt-1 input"
              />
              {errors.email && (
                <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                {...register('password')}
                className="mt-1 input"
              />
              {errors.password && (
                <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* Plain anchor, not react-router Link: this leaves the staff SPA
              entirely for the portal app, which is a separate origin in dev
              (different Vite port) and only shares this origin in production
              (nginx serves it under /portal/ — see deploy/native/nginx). */}
          <a
            href="/portal/"
            className="mt-4 block text-center text-sm text-slate-500 hover:text-slate-700"
          >
            Customer or broker? Go to the portal
          </a>
        </div>
      </div>
    </div>
  );
}
