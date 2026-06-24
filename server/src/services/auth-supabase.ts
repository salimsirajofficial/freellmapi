import { supabase, supabaseAdmin } from '../lib/supabase.js';

export interface SessionUser {
  userId: string;
  email: string;
}

async function confirmUserByEmail(email: string): Promise<void> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;
  const user = data.users.find(u => u.email?.toLowerCase() === email);
  if (!user) throw new Error('User not found');
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    email_confirm: true,
  });
  if (updateError) throw updateError;
}

/** Create account with email pre-confirmed — no verification step required. */
export async function signUp(email: string, password: string): Promise<{ user: SessionUser; session: string }> {
  const normalizedEmail = email.trim().toLowerCase();

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
  });

  if (createError) throw createError;
  if (!created.user) throw new Error('Signup failed: No user returned');

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error) throw error;
  if (!data.session) throw new Error('Sign in failed after account creation');

  return {
    user: { userId: created.user.id, email: created.user.email! },
    session: data.session.access_token,
  };
}

export async function signIn(email: string, password: string): Promise<{ user: SessionUser; session: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  let { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });

  if (error && /not confirmed/i.test(error.message)) {
    await confirmUserByEmail(normalizedEmail);
    ({ data, error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    }));
  }

  if (error) throw error;
  if (!data.user || !data.session) {
    throw new Error('Sign in failed: No user or session returned');
  }

  return {
    user: { userId: data.user.id, email: data.user.email! },
    session: data.session.access_token,
  };
}

export async function signOut(_accessToken: string): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getUser(accessToken: string): Promise<SessionUser | null> {
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) return null;
  return { userId: user.id, email: user.email! };
}

export async function hasNonDesktopUser(): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 100 });
  if (error) {
    console.error('[auth] Failed to list users:', error.message);
    return false;
  }
  return data.users.some(u => u.email !== 'desktop@localhost');
}
