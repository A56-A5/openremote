import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { loadState, saveState, StoredState } from "./config.js";

export function createSupabase(state: StoredState): SupabaseClient {
  if (!state.supabaseUrl || !state.supabaseAnonKey) {
    throw new Error(
      "Missing Supabase config. Set OPENREMOTE_SUPABASE_URL and OPENREMOTE_SUPABASE_ANON_KEY, or run `openremote config`."
    );
  }
  return createClient(state.supabaseUrl, state.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function clientForState(state: StoredState): Promise<SupabaseClient> {
  const client = createSupabase(state);
  if (state.accessToken && state.refreshToken) {
    await client.auth.setSession({ access_token: state.accessToken, refresh_token: state.refreshToken });
  }
  return client;
}

export async function ensureAuth(state: StoredState): Promise<{ state: StoredState; client: SupabaseClient }> {
  const client = await clientForState(state);
  const { data } = await client.auth.getSession();
  if (data.session) {
    return {
      state: {
        ...state,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        userId: data.session.user.id,
        email: data.session.user.email,
      },
      client,
    };
  }
  if (!state.email) throw new Error("Not authenticated. Run `openremote pair <code>` first.");
  throw new Error("Session expired. Run `openremote pair <code>` again from the web app.");
}

export async function saveAuth(state: StoredState, client: SupabaseClient): Promise<void> {
  const { data } = await client.auth.getSession();
  if (data.session) {
    saveState({
      ...state,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId: data.session.user.id,
      email: data.session.user.email,
    });
  }
}
