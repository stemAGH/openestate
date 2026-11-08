import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import {
  createUserSchema,
  updateUserSchema,
  pickForSchema,
  forcePasswordResetResponseSchema,
  twoFactorResetResponseSchema,
  PERMISSIONS,
  type CreateUserDto,
  type UpdateUserDto,
  type ForcePasswordResetResponse,
  type TwoFactorResetResponse,
} from '@openestate/shared';
import { api } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';
import { useAuth } from '../../lib/auth';
import RevealedResetLink, { ResetLinkSupersedeNote } from '../../components/RevealedResetLink';

interface Role {
  id: string;
  name: string;
  slug: string;
}

interface UserOption {
  id: string;
  name: string;
}

export default function UserForm() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id && id !== 'new';
  const navigate = useNavigate();
  const { hasPermission, user: currentUser } = useAuth();
  const [error, setError] = useState('');

  // GET /roles returns a plain array, not {data, meta} — see Roles.tsx's
  // own fix for this same shape mismatch.
  const { data: roles } = useQuery<Role[]>({
    queryKey: ['roles-all'],
    queryFn: () => api('/roles'),
  });

  // GET /users IS paginated ({data, meta}) — 100 is paginationQuerySchema's
  // own max limit, the most this endpoint will ever return in one page
  // without building a search-as-you-type control.
  const { data: usersPage } = useQuery({
    queryKey: ['users-all-for-manager-picker'],
    queryFn: () => api<{ data: UserOption[] }>('/users?limit=100'),
  });
  const managerOptions = (usersPage?.data ?? []).filter((u) => u.id !== id);

  const { data: existingUser } = useQuery({
    queryKey: ['user', id],
    queryFn: () => api<Record<string, unknown>>(`/users/${id}`),
    enabled: !!isEdit,
  });
  const applicantId = existingUser?.applicantId as string | null | undefined;
  const brokerId = existingUser?.brokerId as string | null | undefined;
  const isPortalUser = !!applicantId || !!brokerId;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateUserDto>({
    // Real bug, caught by a Playwright run of this exact flow, not by
    // review: this resolver was ALWAYS createUserSchema, edit mode
    // included — createUserSchema requires `password`, which edit mode
    // never renders/registers at all, so react-hook-form's client-side
    // validation failed silently on every single edit attempt and
    // handleSubmit(onSubmit) never even ran. This is a layer earlier
    // than the email-leak 400 the update endpoint itself would 400 on —
    // the form couldn't reach the network at all. Picking the resolver by
    // isEdit fixes the actual observed symptom ("nothing happens on
    // Update User"); pickForSchema below still strips email defensively.
    resolver: (isEdit
      ? zodResolver(updateUserSchema)
      : zodResolver(createUserSchema)) as Resolver<CreateUserDto>,
  });

  useEffect(() => {
    // Real bug, caught by the same Playwright run: gating this only on
    // existingUser races GET /roles — a native <select>'s value assignment
    // silently no-ops if no matching <option> exists yet, and won't
    // retroactively apply once the options DO render. Gating on both
    // queries means reset() only runs once the role dropdown actually has
    // something for roleId to match against.
    if (existingUser && roles && usersPage) {
      // Real bug, caught by a Playwright run of this exact flow: reset()
      // seeds react-hook-form's internal values for EVERY key passed to
      // it, regardless of whether that field is currently rendered as an
      // input — disabling the email <input> via register()'s `disabled`
      // option does NOT retroactively strip a value reset() already put
      // there. zodResolver(updateUserSchema) then validated the FULL
      // reset payload (email + password included) against a .strict()
      // schema that declares neither, and rejected every single edit
      // submission with "Unrecognized key(s): 'email', 'password'" before
      // onSubmit ever ran. email/password simply don't belong in this
      // reset call at all — updateUserSchema can't change either one
      // (email has no update path; password goes through the separate
      // force-reset flow below), so only the fields that ARE part of an
      // update belong here.
      reset({
        name: existingUser.name as string,
        phone: (existingUser.phone as string) ?? undefined,
        roleId: (existingUser.role as Role)?.id,
        managerId: (existingUser.managerId as string | null) ?? null,
      });
    }
  }, [existingUser, roles, usersPage, reset]);

  const createMutation = useApiMutation<unknown, CreateUserDto>(
    'POST',
    '/users',
    [['users']],
  );

  const updateMutation = useApiMutation<unknown, UpdateUserDto>(
    'PATCH',
    `/users/${id}`,
    [['users'], ['user', id!]],
  );

  const forceResetMutation = useApiMutation<ForcePasswordResetResponse, void>(
    'POST',
    `/users/${id}/force-password-reset`,
  );
  const [resetLink, setResetLink] = useState<{ url: string; expiresAt: string } | null>(null);

  const resetTotpMutation = useApiMutation<TwoFactorResetResponse, void>(
    'POST',
    `/users/${id}/reset-2fa`,
    [['users'], ['user', id!]],
  );
  const [totpResetMessage, setTotpResetMessage] = useState('');
  const isSelf = !!currentUser && currentUser.sub === id;

  const onSubmit = async (data: CreateUserDto) => {
    setError('');
    try {
      if (isEdit) {
        await updateMutation.mutateAsync(pickForSchema(updateUserSchema, data));
      } else {
        await createMutation.mutateAsync(data);
      }
      navigate('/admin/users');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-lg">
      <h1 className="page-title">
        {isEdit ? 'Edit User' : 'Add User'}
      </h1>

      {error && (
        <div className="mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700">Name</label>
          <input
            type="text"
            {...register('name')}
            className="mt-1 input"
          />
          {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Email</label>
          {isEdit ? (
            // updateUserSchema has no `email` field — it can't be changed
            // via this endpoint. Plain text, not a registered input: a
            // registered-but-disabled input still needed a value from
            // somewhere (reset() or otherwise), and any value present in
            // react-hook-form's internal state gets validated regardless
            // of whether the input rendering it is disabled — that's what
            // broke every edit submission (see the reset() comment above).
            // Not registering it at all is the only way it can never
            // reach the resolver or the submitted payload.
            <p className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
              {existingUser?.email as string}
            </p>
          ) : (
            <input
              type="email"
              {...register('email')}
              className="mt-1 input"
            />
          )}
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        {!isEdit && (
          <div>
            <label className="block text-sm font-medium text-slate-700">Password</label>
            <input
              type="password"
              {...register('password')}
              className="mt-1 input"
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
            <p className="mt-1 text-xs text-slate-500">User will be forced to change on first login</p>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-slate-700">Phone</label>
          <input
            type="text"
            {...register('phone')}
            className="mt-1 input"
          />
          {errors.phone && <p className="mt-1 text-xs text-red-600">{errors.phone.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Role</label>
          <select
            {...register('roleId')}
            className="mt-1 input"
          >
            <option value="">Select a role</option>
            {roles?.map((r: Role) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {errors.roleId && <p className="mt-1 text-xs text-red-600">{errors.roleId.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Manager</label>
          <select
            {...register('managerId', {
              // Native <select>s only ever produce strings — zod's
              // `.nullable()` expects a real null for "no manager", not
              // the empty string an unset select gives back.
              setValueAs: (v) => (v === '' ? null : v),
            })}
            className="mt-1 input"
          >
            <option value="">No manager</option>
            {managerOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {errors.managerId && (
            <p className="mt-1 text-xs text-red-600">{errors.managerId.message}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            Determines what this user's manager can see in their leads/reports lists.
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : isEdit ? 'Update User' : 'Create User'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/admin/users')}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      </form>

      {/* Gated on the loaded record, like the reset() effect above: until it
          arrives isPortalUser reads false, so a portal user's screen would
          briefly offer the staff button — which the API refuses with a 400. */}
      {isEdit && existingUser && hasPermission(PERMISSIONS.ADMIN_USER_UPDATE) && (
        <div className="mt-8 rounded-md border border-slate-200 p-4">
          <h2 className="text-sm font-medium text-slate-900">Password</h2>
          {isPortalUser ? (
            <p className="mt-1 text-xs text-slate-500">
              This is a portal user. Reset their password or 2FA from the{' '}
              {applicantId ? (
                <Link to={`/postsales/applicants/${applicantId}`} className="text-blue-600 hover:underline">
                  customer record
                </Link>
              ) : (
                <Link to={`/postsales/brokers/${brokerId}`} className="text-blue-600 hover:underline">
                  broker record
                </Link>
              )}
              , not here.
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-slate-500">
                Generates a one-time reset link for you to send this user directly. Their current
                password stays valid until they use it — you never see or set their password directly.
              </p>
              <ResetLinkSupersedeNote />
              <button
                type="button"
                onClick={() => {
                  setResetLink(null);
                  forceResetMutation.mutate(undefined, {
                    onSuccess: (data) => {
                      const parsed = forcePasswordResetResponseSchema.parse(data);
                      setResetLink({
                        url: `${window.location.origin}/reset-password?token=${parsed.token}`,
                        expiresAt: parsed.expiresAt,
                      });
                    },
                  });
                }}
                disabled={forceResetMutation.isPending}
                className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
              >
                {forceResetMutation.isPending ? 'Generating…' : 'Generate reset link'}
              </button>
              {resetLink && (
                <RevealedResetLink
                  url={resetLink.url}
                  expiresAt={resetLink.expiresAt}
                  onDismiss={() => setResetLink(null)}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Same gate as the Password block above, for the same reason: until
          the record loads, totpEnabled reads undefined — and undefined keeps
          the button disabled, the safe direction. */}
      {/* Not rendered for portal users: the Password section's pointer
          above already sends them to the customer/broker record for both. */}
      {isEdit && existingUser && !isPortalUser && hasPermission(PERMISSIONS.ADMIN_USER_UPDATE) && (
        <div className="mt-4 rounded-md border border-slate-200 p-4">
          <h2 className="text-sm font-medium text-slate-900">Two-factor authentication</h2>
          {isSelf ? (
            <p className="mt-1 text-xs text-slate-500">
              To turn off your own 2FA, use{' '}
              <Link to="/settings" className="text-blue-600 hover:underline">
                Settings
              </Link>
              .
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs text-slate-500">
                {existingUser.totpEnabled
                  ? '2FA is on. Reset it if this user has lost both their authenticator and their recovery codes — they will sign in with their password and can set it up again.'
                  : '2FA is not enabled on this account.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Reset two-factor authentication for ${existingUser.name as string}?\n\n` +
                        'They will sign in with their password alone and can set up 2FA again. ' +
                        'Any device they are signed in on is signed out within 15 minutes. ' +
                        'Their password does not change.',
                    )
                  ) {
                    return;
                  }
                  setTotpResetMessage('');
                  resetTotpMutation.mutate(undefined, {
                    onSuccess: (data) => {
                      setTotpResetMessage(
                        twoFactorResetResponseSchema.parse(data).wasEnabled
                          ? 'Two-factor authentication cleared. They can sign in with their password and set it up again.'
                          : 'Two-factor authentication was already off — nothing to clear.',
                      );
                    },
                  });
                }}
                disabled={!existingUser.totpEnabled || resetTotpMutation.isPending}
                className="mt-3 rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
              >
                {resetTotpMutation.isPending ? 'Resetting…' : 'Reset 2FA'}
              </button>
              {totpResetMessage && (
                <p role="status" className="mt-2 text-xs text-slate-700">
                  {totpResetMessage}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
