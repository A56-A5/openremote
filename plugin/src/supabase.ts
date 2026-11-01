import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadState, saveState, loadAuth, saveAuth, StoredState } from "./config.js";

export function createSupabase(state: StoredState): SupabaseClient {
  if (!state.supabaseUrl || !state.supabaseAnonKey) {
    throw new Error(
      "Missing Supabase config. Set OPENREMOTE_SUPABASE_URL and OPENREMOTE_SUPABASE_ANON_KEY, or run `openremote config`."
    );
  }
  return createClient(state.supabaseUrl, state.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function persistSession(state: StoredState, client: SupabaseClient): Promise<StoredState> {
  const { data } = await client.auth.getSession();
  const session = data.session;
  if (!session) return state;
  const next: StoredState = { ...state, ownerId: session.user.id };
  saveAuth({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    userId: session.user.id,
    expiresAt: session.expires_at,
  });
  saveState(next);
  return next;
}

/**
 * Owner identity: Supabase anonymous sign-in. The refresh token is kept in
 * ~/.config/openremote/auth.json (chmod 600) and reused across runs so this
 * machine keeps ownership of its rows. No password is ever created or stored.
 */
export async function ensureAuth(
  state: StoredState
): Promise<{ state: StoredState; client: SupabaseClient }> {
  const client = createSupabase(state);

  const stored = loadAuth();
  if (stored?.refreshToken) {
    const { error } = await client.auth.setSession({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
    });
    if (!error) {
      const { data } = await client.auth.getSession();
      if (data.session) {
        return { state: await persistSession(state, client), client };
      }
    }
  }

  const { error } = await client.auth.signInAnonymously();
  if (error) {
    throw new Error(
      `Anonymous sign-in failed: ${error.message}. ` +
        `Check that anonymous sign-ins are enabled in Supabase → Authentication → Providers.`
    );
  }
  return { state: await persistSession(state, client), client };
}

/** Keep the anonymous refresh token alive (call periodically from the worker). */
export async function refreshAuth(
  state: StoredState,
  client: SupabaseClient
): Promise<StoredState> {
  const { error } = await client.auth.refreshSession();
  if (error) return state;
  return await persistSession(state, client);
}
