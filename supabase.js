// ─────────────────────────────────────────────────────────────────────────────
// supabase.js  —  Drop this file into your src/ folder
// Replace the two placeholder strings with your real values from:
// Supabase Dashboard → Settings → API
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "YOUR_ANON_KEY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── AUTH ──────────────────────────────────────────────────────────────────────

export async function signUp({ email, password, name, plan }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name, plan } },
  });
  if (error) throw error;
  return data.user;
}

export async function signIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user ?? null);
  });
  return data.subscription;
}

// ── PROFILE ───────────────────────────────────────────────────────────────────

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateProfile(userId, updates) {
  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);
  if (error) throw error;
}

// ── ROSTERS ───────────────────────────────────────────────────────────────────

export async function saveRoster(userId, roster) {
  const { data, error } = await supabase
    .from("rosters")
    .insert({
      user_id:      userId,
      period_label: roster.periodLabel,
      year:         roster.year,
      month_num:    roster.monthNum,
      calendar:     roster.calendar,
    })
    .select()
    .single();
  if (error) throw error;
  return data; // includes the generated id
}

export async function loadRosters(userId) {
  const { data, error } = await supabase
    .from("rosters")
    .select("*")
    .eq("user_id", userId)
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  // Normalise column names back to camelCase for the app
  return (data || []).map(r => ({
    id:          r.id,
    periodLabel: r.period_label,
    year:        r.year,
    monthNum:    r.month_num,
    calendar:    r.calendar,
    uploadedAt:  r.uploaded_at,
  }));
}

export async function deleteRoster(rosterId) {
  const { error } = await supabase.from("rosters").delete().eq("id", rosterId);
  if (error) throw error;
}

// ── TAIL LOGS ─────────────────────────────────────────────────────────────────

export async function saveTailLog(userId, rosterId, flightKey, tailNumber) {
  const { error } = await supabase.from("tail_logs").upsert(
    { user_id: userId, roster_id: rosterId, flight_key: flightKey, tail_number: tailNumber },
    { onConflict: "user_id,roster_id,flight_key" }
  );
  if (error) throw error;
}

export async function loadTailLogs(userId) {
  const { data, error } = await supabase
    .from("tail_logs")
    .select("roster_id, flight_key, tail_number")
    .eq("user_id", userId);
  if (error) throw error;
  // Returns a flat map: "rosterId-flightKey" → tailNumber
  const map = {};
  for (const row of data || []) {
    map[`${row.roster_id}-${row.flight_key}`] = row.tail_number;
  }
  return map;
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
// These require the service_role key — call from a Supabase Edge Function,
// NOT from the browser. Shown here for reference only.

export async function adminListUsers() {
  // Use supabase.auth.admin.listUsers() inside an Edge Function with service_role key
  throw new Error("Must be called from a Supabase Edge Function with service_role key");
}

export async function adminUpdateUserPlan(userId, plan) {
  const { error } = await supabase
    .from("profiles")
    .update({ plan })
    .eq("id", userId);
  if (error) throw error;
}

export async function adminToggleUserActive(userId, active) {
  const { error } = await supabase
    .from("profiles")
    .update({ active })
    .eq("id", userId);
  if (error) throw error;
}

export async function adminListAllRosters() {
  const { data, error } = await supabase
    .from("rosters")
    .select("*, profiles(name, email, plan)")
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
  return data || [];
}
