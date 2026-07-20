// ===============================================================================
// AviateSync -- Main App  (React + Supabase)
//
// HOW TO USE:
//   1. npm install @supabase/supabase-js
//   2. Copy supabase.js into src/
//   3. Create .env with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      VITE_ANTHROPIC_API_KEY (optional - handled server-side in prod)
//   4. Run schema.sql in Supabase SQL Editor
//   5. npm run dev
// ===============================================================================

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";

// -- Supabase client config
// AviateSync App -- v2.1.0
const SUPA_URL  = import.meta.env.VITE_SUPABASE_URL  || "https://uqqjoxpanxtkmjamuhhk.supabase.co";
const SUPA_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxcWpveHBhbnh0a21qYW11aGhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NzczNzgsImV4cCI6MjA5NzI1MzM3OH0.TnZBp8cxsYvcU_m4iLVHYQTksFJyG7VWhxoLcVCJLPE";

// Lightweight Supabase REST client (no npm needed for the artifact preview)
const sb = {
  _headers(extra={}) {
    // Use the logged-in user's access token when available, so RLS policies
    // (auth.uid() = user_id) can correctly identify the requester.
    // Fall back to the anon key only when no session exists.
    const token = sb.auth._token || SUPA_ANON;
    return { "Content-Type":"application/json", "apikey": SUPA_ANON, "Authorization":`Bearer ${token}`, ...extra };
  },
  async rpc(fn, body={}) {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, { method:"POST", headers:this._headers(), body:JSON.stringify(body) });
    return r.json();
  },
  from(table) {
    const base = `${SUPA_URL}/rest/v1/${table}`;
    const h = this._headers.bind(this);
    // Return a query builder that accumulates filters and options
    // before making the actual HTTP request. This allows proper
    // chaining: .select().eq().order() etc.
    function makeBuilder(method="GET", body=null, prefer="") {
      const state = {
        cols: "*",
        filters: [],  // array of "col=op.val" strings
        orderStr: "",
        method,
        body,
        prefer,
      };

      const builder = {
        select(cols="*") { state.cols = cols; return builder; },
        eq(col, val)     { state.filters.push(`${col}=eq.${val}`); return builder; },
        neq(col, val)    { state.filters.push(`${col}=neq.${val}`); return builder; },
        // PostgREST's "in" filter: col=in.(val1,val2,...). Values are
        // comma-joined as-is; callers pass an array of already-safe values
        // (uuids in this app's usage), matching how eq/neq don't escape
        // either -- consistent with the rest of this hand-rolled builder.
        in(col, vals)    { state.filters.push(`${col}=in.(${(vals||[]).join(",")})`); return builder; },
        order(col, opts={}) {
          state.orderStr = `${col}.${opts.ascending===false?"desc":"asc"}`;
          return builder;
        },
        update(body) { state.method="PATCH"; state.body=body; state.prefer="return=representation"; return builder; },
        delete()     { state.method="DELETE"; return builder; },
        // .single() -- unwraps the first item from an array response.
        // Returns a new thenable that extracts data[0] from the result,
        // matching Supabase JS SDK behavior for .single() queries.
        single() {
          const parentThen = builder.then.bind(builder);
          const singleBuilder = {
            ...builder,
            then(resolve, reject) {
              return parentThen((result) => {
                if(!result) { resolve({ data: null, error: null }); return; }
                if(result.error) { resolve({ data: null, error: result.error }); return; }
                const d = Array.isArray(result.data) ? (result.data[0] || null) : result.data;
                resolve({ data: d, error: d ? null : { message: "No rows found" } });
              }, reject);
            },
          };
          return singleBuilder;
        },
        // .maybeSingle() -- same unwrap as .single(), but zero rows is the
        // NORMAL case here (e.g. "does this flight have a signature row
        // yet?"), not an error. Resolves { data: null, error: null } rather
        // than single()'s { data: null, error: "No rows found" } when the
        // query legitimately returns nothing.
        maybeSingle() {
          const parentThen = builder.then.bind(builder);
          const maybeSingleBuilder = {
            ...builder,
            then(resolve, reject) {
              return parentThen((result) => {
                if(!result) { resolve({ data: null, error: null }); return; }
                if(result.error) { resolve({ data: null, error: result.error }); return; }
                const d = Array.isArray(result.data) ? (result.data[0] || null) : result.data;
                resolve({ data: d, error: null });
              }, reject);
            },
          };
          return maybeSingleBuilder;
        },
        // Execute the query -- called implicitly when awaited
        then(resolve, reject) {
          const isGet = state.method === "GET";
          let url = isGet ? `${base}?select=${state.cols}` : base;
          const sep = isGet ? "&" : "?";
          let first = true;
          state.filters.forEach(f => {
            url += (first && !isGet ? sep : "&") + f;
            first = false;
          });
          if(isGet && state.orderStr) url += `&order=${state.orderStr}`;
          const doFetch = () => {
            const headers = h({});
            if(state.prefer) headers["Prefer"] = state.prefer;
            const fetchOpts = { method: state.method, headers };
            if(state.body) fetchOpts.body = JSON.stringify(state.body);
            return fetch(url, fetchOpts).then(async r => {
              // Auto-refresh on 401 (expired token) and retry once
              if(r.status === 401 && (sb.auth._refreshToken || (typeof localStorage!=="undefined" && localStorage.getItem("fl_refresh_token")))) {
                const refreshed = await sb.auth.refreshSession();
                if(refreshed.data) {
                  // Retry with new token
                  const headers2 = h({});
                  if(state.prefer) headers2["Prefer"] = state.prefer;
                  const r2 = await fetch(url, {...fetchOpts, headers:headers2});
                  if(r2.status === 204 || r2.headers.get("content-length")==="0") return {data:null,error:null};
                  const text2 = await r2.text();
                  const data2 = text2 ? JSON.parse(text2) : null;
                  return {data:r2.ok?data2:null, error:r2.ok?null:data2};
                }
              }
              if(r.status === 204 || r.headers.get("content-length") === "0") {
                return { data: null, error: null };
              }
              const text = await r.text();
              const data = text ? JSON.parse(text) : null;
              return { data: r.ok ? data : null, error: r.ok ? null : data };
            });
          };
          return doFetch().then(resolve, reject);
        },
      };
      return builder;
    }

    return {
      select(cols="*") { return makeBuilder().select(cols); },
      insert(body) {
        const b = makeBuilder("POST", body, "return=representation");
        b.then = (resolve, reject) => {
          const url = base;
          const headers = h({"Prefer":"return=representation"});
          return fetch(url, {method:"POST", headers, body:JSON.stringify(body)}).then(async r => {
            const text = await r.text();
            const data = text ? JSON.parse(text) : null;
            const d = Array.isArray(data) ? data[0] : data;
            return { data: r.ok ? d : null, error: r.ok ? null : data };
          }).then(resolve, reject);
        };
        // Support .insert().select().single() chaining
        b.select = () => b;
        return b;
      },
      upsert(body, opts={}) {
        const b = makeBuilder();
        b.then = (resolve, reject) => {
          const headers = h({"Prefer":"resolution=merge-duplicates,return=representation"});
          // PostgREST requires on_conflict as a URL query param to use a
          // non-primary-key unique constraint -- without it, it tries the PK
          // and fails with "duplicate key" on unique constraint columns.
          const onConflict = opts.onConflict || "";
          const url = onConflict ? `${base}?on_conflict=${encodeURIComponent(onConflict)}` : base;
          return fetch(url, {method:"POST", headers, body:JSON.stringify(body)}).then(async r => {
            if(r.status===204||r.headers.get("content-length")==="0") return {data:null,error:null};
            const data = await r.json();
            return { data: r.ok?data:null, error: r.ok?null:data };
          }).then(resolve, reject);
        };
        return b;
      },
      update(body) {
        // Returns a builder so .eq() can be chained before execution
        return makeBuilder("PATCH", body, "return=representation");
      },
      delete() {
        return makeBuilder("DELETE");
      },
    };
  },
  auth: {
    _token: null,
    _user: null,
    async signUp({ email, password, options:{data:meta}={} }={}) {
      const r = await fetch(`${SUPA_URL}/auth/v1/signup`, {
        method:"POST", headers:{"Content-Type":"application/json","apikey":SUPA_ANON},
        body:JSON.stringify({ email, password, data:meta })
      });
      const d = await r.json();
      if (!r.ok) return { data:null, error:d };
      sb.auth._token = d.access_token; sb.auth._user = d.user;
      sb.auth._refreshToken = d.refresh_token;
      try {
        localStorage.setItem("fl_token", d.access_token);
        localStorage.setItem("fl_user", JSON.stringify(d.user));
        if(d.refresh_token) localStorage.setItem("fl_refresh_token", d.refresh_token);
      } catch{}
      return { data:{ user:d.user }, error:null };
    },
    async signInWithPassword({ email, password }) {
      const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
        method:"POST", headers:{"Content-Type":"application/json","apikey":SUPA_ANON},
        body:JSON.stringify({ email, password })
      });
      const d = await r.json();
      if (!r.ok) return { data:null, error:d };
      sb.auth._token = d.access_token; sb.auth._user = d.user;
      sb.auth._refreshToken = d.refresh_token;
      try {
        localStorage.setItem("fl_token", d.access_token);
        localStorage.setItem("fl_user", JSON.stringify(d.user));
        if(d.refresh_token) localStorage.setItem("fl_refresh_token", d.refresh_token);
      } catch{}
      return { data:{ user:d.user }, error:null };
    },
    async refreshSession() {
      // Use stored refresh token to get a new access token silently
      try {
        const refreshToken = sb.auth._refreshToken || localStorage.getItem("fl_refresh_token");
        if(!refreshToken) return { data:null, error:"No refresh token" };
        const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
          method:"POST", headers:{"Content-Type":"application/json","apikey":SUPA_ANON},
          body:JSON.stringify({ refresh_token: refreshToken })
        });
        const d = await r.json();
        if(!r.ok) return { data:null, error:d };
        sb.auth._token = d.access_token;
        sb.auth._refreshToken = d.refresh_token;
        try {
          localStorage.setItem("fl_token", d.access_token);
          if(d.refresh_token) localStorage.setItem("fl_refresh_token", d.refresh_token);
        } catch{}
        return { data:{ session:d }, error:null };
      } catch(e) { return { data:null, error:e }; }
    },
    async signOut() {
      sb.auth._token = null; sb.auth._user = null; sb.auth._refreshToken = null;
      try {
        localStorage.removeItem("fl_token");
        localStorage.removeItem("fl_user");
        localStorage.removeItem("fl_refresh_token");
        localStorage.removeItem("fl_webauthn_registered");
      } catch{}
    },
    async getUser() {
      if (sb.auth._user && sb.auth._token) return { data:{ user:sb.auth._user } };
      try {
        const u = localStorage.getItem("fl_user");
        const t = localStorage.getItem("fl_token");
        const rt = localStorage.getItem("fl_refresh_token");
        if(rt) sb.auth._refreshToken = rt;
        if (u && t) { sb.auth._user = JSON.parse(u); sb.auth._token = t; return { data:{ user:sb.auth._user } }; }
      } catch{}
      return { data:{ user:null } };
    },
  },
};

// Override fetch headers with auth token when signed in
// -- WEBAUTHN HELPERS
const WEBAUTHN_URL = `${SUPA_URL}/functions/v1/webauthn`;

function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const byte of bytes) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function webauthnCall(action, body={}) {
  const r = await fetch(WEBAUTHN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sb.auth._token || SUPA_ANON}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error || `WebAuthn error ${r.status}`);
  return data;
}

// Detects which platform credential provider WebAuthn will actually use,
// so the sign-in button can say the right thing instead of always saying
// "Face ID" (which is wrong and confusing on Android/Samsung devices).
// Samsung Pass isn't a separate SDK to integrate -- on Samsung Galaxy
// devices running Samsung Internet or any Chromium-based browser with
// Samsung Pass set as the credential manager, it automatically becomes the
// WebAuthn platform authenticator for any site/app that calls the standard
// navigator.credentials API, exactly like isWebAuthnAvailable() already does.
function detectBiometricProvider() {
  if(typeof navigator === "undefined") return {label:"Biometrics", icon:"fingerprint"};
  const ua = navigator.userAgent || "";
  const isSamsung = /SM-|Samsung|SAMSUNG/i.test(ua) || /SamsungBrowser/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMac = /Macintosh/i.test(ua) && !isIOS;
  if(isSamsung) return {label:"Samsung Pass", icon:"fingerprint"};
  if(isAndroid) return {label:"Android biometrics", icon:"fingerprint"};
  if(isIOS) return {label:"Face ID", icon:"face"};
  if(isMac) return {label:"Touch ID", icon:"fingerprint"};
  return {label:"Biometrics", icon:"fingerprint"};
}

// Check if WebAuthn platform authenticator (biometrics) is available
async function isWebAuthnAvailable() {
  try {
    return !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

// Register biometric credential after login
async function registerBiometric(userId, email) {
  // Get challenge from server
  const { options } = await webauthnCall("register-challenge", { userId, email });

  // Prepare options for browser
  const credOptions = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64urlToBuffer(options.user.id),
    },
  };

  // Browser prompts biometric
  const credential = await navigator.credentials.create({ publicKey: credOptions });
  if(!credential) throw new Error("No credential returned");

  // Encode for sending to server
  const encoded = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64url(credential.response.attestationObject),
    },
  };

  // Verify and store on server
  const result = await webauthnCall("register-verify", {
    credential: encoded,
    userId,
    deviceName: navigator.userAgent.includes("Samsung") ? "Samsung Device" :
                navigator.userAgent.includes("Android") ? "Android Device" : "Device",
  });

  if(result.verified) {
    localStorage.setItem("fl_webauthn_registered", "true");
    localStorage.setItem("fl_webauthn_user_id", userId);
  }
  return result.verified;
}

// Authenticate with biometrics
async function authenticateWithBiometric(userId) {
  // Get challenge from server
  const { options } = await webauthnCall("auth-challenge", { userId });

  // Prepare options
  const credOptions = {
    ...options,
    challenge: base64urlToBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map(c => ({
      ...c,
      id: base64urlToBuffer(c.id),
    })),
  };

  // Browser prompts biometric
  const credential = await navigator.credentials.get({ publicKey: credOptions });
  if(!credential) throw new Error("No credential returned");

  // Encode for server
  const encoded = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      authenticatorData: bufferToBase64url(credential.response.authenticatorData),
      signature: bufferToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle
        ? bufferToBase64url(credential.response.userHandle) : null,
    },
  };

  // Verify on server -- returns tempToken
  const result = await webauthnCall("auth-verify", { credential: encoded });
  if(!result.verified) throw new Error("Biometric verification failed");

  // Exchange temp token for session
  const session = await webauthnCall("exchange-token", { tempToken: result.tempToken });
  return session;
}


const origFetch = window.fetch.bind(window);
window._sbFetch = origFetch;

// -- DESIGN TOKENS
// Premium aviation aesthetic -- inspired by Jeppesen charts, Boeing flight decks,
// and professional logbook bindings. Deep navy backgrounds, crisp white surfaces,
// warm amber accents (like instrument lighting), clean Inter typography.
// -- THEME SYSTEM
// Dark mode -- deep cockpit navy with amber accents
const DARK = {
  base:    "#0B1625",   // deep navy -- matches the landing hero
  surface: "#101D31",   // card/panel background
  panel:   "#16263E",   // elevated panel
  panelLt: "#1B2E4A",
  border:  "#1F3252",   // hairline separator
  ink:     "#EDF3FF",   // primary text -- crisp blue-white
  silver:  "#93A7C9",   // secondary text
  muted:   "#5B6E8F",   // placeholder / disabled
  teal:    "#3B82F6",   // primary blue -- confident, aviation instrument blue
  tealDim: "#2563EB",
  red:     "#EF4444",
  redDim:  "#DC2626",
  green:   "#22C55E",
  gold:    "#F59E0B",   // amber -- the color of analog instrument lighting
  orange:  "#3B82F6",
  orangeDim:"#2563EB",
  white:   "#EDF3FF",
  // Theme-aware status tints (bg + border pairs)
  blueBg:  "#0F2044",  blueBdr:  "#1E3A6E",
  greenBg: "#06231A",  greenBdr: "#14532D",
  amberBg: "#241A05",  amberBdr: "#4D3708",
  redBg:   "#2D0A0A",  redBdr:   "#7F1D1D",
};

// Light mode -- Jeppesen chart aesthetic: clean white, navy ink, blue accent
const LIGHT = {
  base:    "#F4F6FB",   // warm off-white -- like chart paper
  surface: "#FFFFFF",
  panel:   "#EEF1F8",
  panelLt: "#E4E9F4",
  border:  "#D8DFEE",
  ink:     "#0B1437",   // deep navy ink
  silver:  "#3D4F72",   // secondary text
  muted:   "#8A97B4",
  teal:    "#1D4ED8",   // deep aviation blue
  tealDim: "#1E40AF",
  red:     "#DC2626",
  redDim:  "#B91C1C",
  green:   "#16A34A",
  gold:    "#D97706",   // amber
  orange:  "#1D4ED8",
  orangeDim:"#1E40AF",
  white:   "#0B1437",
  // Theme-aware status tints (bg + border pairs)
  blueBg:  "#EFF6FF",  blueBdr:  "#BFDBFE",
  greenBg: "#ECFDF5",  greenBdr: "#A7F3D0",
  amberBg: "#FFFBEB",  amberBdr: "#FDE68A",
  redBg:   "#FEF2F2",  redBdr:   "#FECACA",
};

// C is set at runtime based on user preference
// Default to LIGHT theme -- dark stays available in Settings
let C = { ...LIGHT };

function applyTheme(isDark) {
  const src = isDark ? DARK : LIGHT;
  Object.assign(C, src);
  // Update CSS variables on root for any CSS that uses them
  const root = document.documentElement;
  root.setAttribute("data-theme", isDark ? "dark" : "light");
  root.style.setProperty("--c-base",    src.base);
  root.style.setProperty("--c-surface", src.surface);
  root.style.setProperty("--c-panel",   src.panel);
  root.style.setProperty("--c-border",  src.border);
  root.style.setProperty("--c-ink",     src.ink);
  root.style.setProperty("--c-muted",   src.muted);
  root.style.setProperty("--c-silver",  src.silver);
  root.style.setProperty("--c-teal",    src.teal);
  root.style.setProperty("--c-green",   src.green);
  root.style.setProperty("--c-red",     src.red);
  document.body.style.background = src.base;
  document.body.style.color = src.ink;
  const el = document.getElementById("fl-styles");
  if(el) el.textContent = buildStyles();
}

// Returns a theme-aware S object for new components that use S.xxx
function getS() {
  const dark = C.base === DARK.base;
  return {
    bg:       C.base,
    surface:  C.surface,
    border:   C.border,
    ink:      C.ink,
    muted:    C.muted,
    silver:   C.silver,
    blue:     C.teal,
    blueDim:  C.tealDim,
    purple:   dark ? "#60A5FA" : "#0EA5E9",  // secondary accent -- sky blue (purple retired)
    panel:    C.panel,
    panelLt:  C.panelLt,
    green:    C.green,
    red:      C.red,
    gold:     C.gold,
    // Semantic aliases
    card:     C.surface,
    subtext:  C.silver,
    divider:  C.border,
    accent:   C.teal,
    // Status colors (theme-aware, sourced from palette)
    amber:    "#F59E0B",
    amberBg:  C.amberBg,
    amberBdr: C.amberBdr,
    blueBg:   C.blueBg,
    blueBdr:  C.blueBdr,
    greenBg:  C.greenBg,
    greenBdr: C.greenBdr,
    redBg:    C.redBg,
    redBdr:   C.redBdr,
  };
}

// Read preference from localStorage (default: light -- dark stays available in Settings)
function getThemePref() {
  try { return localStorage.getItem("fl_theme") === "dark"; }
  catch { return false; }
}

function setThemePref(isDark) {
  try { localStorage.setItem("fl_theme", isDark ? "dark" : "light"); }
  catch {}
}

// ---- Notification preferences, event log & dismissals ----------------------
// Prefs control which alert types appear under the dashboard bell.
// All default ON; the pilot can toggle each in Settings > Notifications.
function getNotifPrefs() {
  try { return { sync:true, edits:true, signReminders:true, upcoming24h:true, ...JSON.parse(localStorage.getItem("fl_notif_prefs")||"{}") }; }
  catch { return { sync:true, edits:true, signReminders:true, upcoming24h:true }; }
}
function setNotifPrefs(p) { try { localStorage.setItem("fl_notif_prefs", JSON.stringify(p)); } catch {} }

// Persistent event log for things that only happen once (e.g. manual edits
// applied during verification). Deduped by id, capped at 50 entries.
function logNotifEvent(ev) {
  try {
    const arr = JSON.parse(localStorage.getItem("fl_notif_events")||"[]");
    if (!arr.some(e=>e.id===ev.id)) arr.unshift({ ...ev, ts: Date.now() });
    localStorage.setItem("fl_notif_events", JSON.stringify(arr.slice(0,50)));
  } catch {}
}
function getNotifEvents() { try { return JSON.parse(localStorage.getItem("fl_notif_events")||"[]"); } catch { return []; } }
function getDismissedNotifs() { try { return JSON.parse(localStorage.getItem("fl_notif_dismissed")||"[]"); } catch { return []; } }
function dismissNotifs(ids) {
  try {
    const d = new Set(getDismissedNotifs()); ids.forEach(i=>d.add(i));
    localStorage.setItem("fl_notif_dismissed", JSON.stringify([...d].slice(-200)));
  } catch {}
}

// Universal-search month jump: the dashboard search sets this before
// navigating to the logbook hub, which consumes it to select that month.
let PENDING_ROSTER_ID = null;

// Initialize C immediately on module load, before any rendering
C.orange    = C.teal;
C.orangeDim = C.tealDim;
C.white     = C.ink;

// Fonts
const FD = "'Fraunces',serif";
const FB = "'Inter',sans-serif";
const FM = "'JetBrains Mono',monospace";

// -- STYLES
// buildStyles() is called to regenerate the CSS whenever the theme changes.
// The style tag with id="fl-styles" is injected into <head> by App on mount.
function buildStyles() { return `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

/* --- RESET & BASE ----------------------------------------------------------- */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{background:${C.base};color:${C.ink};font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-size:14px;overflow-x:hidden;width:100%;}
button{cursor:pointer;font-family:'Inter',system-ui,sans-serif;font-size:14px;-webkit-tap-highlight-color:transparent}
input,textarea,select{font-family:'Inter',system-ui,sans-serif;font-size:16px;color-scheme:light dark}
a{color:${C.teal};text-decoration:none}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
::placeholder{color:${C.muted}!important;opacity:1}

/* --- LAYOUT ----------------------------------------------------------------- */
.app-shell{display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;flex-shrink:0;background:${C.surface};border-right:1px solid ${C.border};display:flex;flex-direction:column;overflow-y:auto}
.app-content{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.app-topbar{height:52px;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 20px;gap:12px;flex-shrink:0;position:sticky;top:0;z-index:40}
.app-page-title{font-size:15px;font-weight:600;color:${C.ink};flex:1}
.app-body{flex:1;overflow-y:auto;padding:20px;background:${C.base}}

/* --- SIDEBAR ---------------------------------------------------------------- */
.sidebar-brand{padding:18px 16px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid ${C.border}}
.sidebar-logo{font-size:17px;font-weight:700;color:${C.ink};letter-spacing:-.3px}
.sidebar-logo span{color:${C.teal}}
.sidebar-nav{padding:8px 8px;flex:1}
.sidebar-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;font-size:13px;color:${C.silver};background:none;border:none;width:100%;text-align:left;transition:all .12s;font-weight:500}
.sidebar-item:hover{background:${C.panel};color:${C.ink}}
.sidebar-item.active{background:${C.teal};color:#fff;font-weight:600}
.sidebar-item-icon{font-size:15px;width:20px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:12px 8px;border-top:1px solid ${C.border}}

/* --- HAMBURGER / DRAWER ----------------------------------------------------- */
.hamburger-btn{display:none;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;border:1px solid ${C.border};background:none;color:${C.ink};font-size:18px;cursor:pointer;flex-shrink:0}
.drawer-overlay{display:block;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;animation:fadeIn .15s ease}
.drawer-panel{position:fixed;top:0;left:0;bottom:0;width:76vw;max-width:280px;background:${C.surface};border-right:1px solid ${C.border};z-index:1001;display:flex;flex-direction:column;animation:slideInLeft .18s ease;overflow-y:auto}
.drawer-header{padding:16px 16px 12px;border-bottom:1px solid ${C.border};display:flex;align-items:center;justify-content:space-between}
.drawer-logo{font-size:17px;font-weight:700;color:${C.ink}}
.drawer-logo span{color:${C.teal}}
.drawer-close{background:none;border:none;color:${C.muted};font-size:20px;cursor:pointer;padding:4px;line-height:1}
.drawer-nav{padding:8px 8px;flex:1}
.drawer-item{display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:8px;border:none;background:none;color:${C.silver};font-size:14px;width:100%;text-align:left;cursor:pointer;transition:all .12s;font-weight:500}
.drawer-item:hover{background:${C.panel};color:${C.ink}}
.drawer-item.active{background:${C.teal};color:#fff;font-weight:600}
.drawer-item-icon{font-size:16px;width:22px;text-align:center;flex-shrink:0}
.drawer-footer{padding:12px 8px;border-top:1px solid ${C.border}}

/* --- AVATAR ----------------------------------------------------------------- */
.avatar{width:32px;height:32px;border-radius:50%;background:${C.teal};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;cursor:pointer;transition:opacity .15s}
.avatar:hover{opacity:.8}

/* --- CARDS & SHARED --------------------------------------------------------- */
.card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:18px}
.section-title{font-size:18px;font-weight:700;color:${C.ink};margin-bottom:4px}
.section-sub{font-size:13px;color:${C.muted};margin-bottom:16px}
.divider{height:1px;background:${C.border};margin:16px 0}

/* --- BUTTONS ---------------------------------------------------------------- */
.btn-teal,.btn-orange{background:${C.teal};color:#fff;border:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;transition:background .15s}
.btn-teal:hover,.btn-orange:hover{background:${C.tealDim}}
.btn-teal:disabled,.btn-orange:disabled{opacity:.55;cursor:not-allowed}
.btn-sm-ghost{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:5px 12px;font-size:12px;border-radius:7px;transition:all .15s}
.btn-sm-ghost:hover{border-color:${C.teal}66;color:${C.teal}}
.btn-danger{background:transparent;border:1px solid ${C.red}44;color:${C.red};padding:5px 12px;font-size:12px;border-radius:7px}
.btn-full{width:100%;padding:14px;border-radius:10px;font-size:15px;font-weight:600;background:${C.teal};color:#fff;border:none;transition:background .15s}
.btn-full:hover{background:${C.tealDim}}
.btn-full:disabled{opacity:.6;cursor:not-allowed}

/* --- FORMS ------------------------------------------------------------------- */
.form-group{margin-bottom:14px}
.form-label{font-size:12px;font-weight:600;color:${C.silver};margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.4px}
.form-input{width:100%;background:${C.panel};border:1.5px solid ${C.border};color:${C.ink};padding:10px 13px;border-radius:9px;font-size:15px;outline:none;transition:border-color .15s;-webkit-appearance:none}
.form-input:focus{border-color:${C.teal}}
.form-select{width:100%;background:${C.panel};border:1.5px solid ${C.border};color:${C.ink};padding:10px 13px;border-radius:9px;font-size:15px;outline:none;-webkit-appearance:none}

/* --- PILLS / BADGES --------------------------------------------------------- */
.pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:100px;font-size:11px;font-weight:600}
.pill-green{background:${C.green}18;color:${C.green}}
.pill-orange,.pill-red{background:${C.red}18;color:${C.red}}
.pill-muted{background:${C.muted}22;color:${C.silver}}
.pill-teal{background:${C.teal}18;color:${C.teal}}
.admin-badge{background:${C.red}14;border:1px solid ${C.red}33;color:${C.red};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.8px;text-transform:uppercase}

/* --- NOTIFICATIONS ----------------------------------------------------------- */
.notice{background:${C.teal}0d;border:1px solid ${C.teal}33;border-radius:8px;padding:10px 14px;font-size:13px;color:${C.teal};margin-bottom:14px}
.warn{background:${C.gold}0d;border:1px solid ${C.gold}44;border-radius:8px;padding:10px 14px;font-size:13px;color:${C.gold};margin-bottom:14px}
.parse-status{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:10px}
.parse-status.loading{background:${C.teal}18;border:1px solid ${C.teal}33;color:${C.teal}}
.parse-status.success{background:${C.green}18;border:1px solid ${C.green}33;color:${C.green}}
.parse-status.error{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red}}

/* --- ANIMATIONS ------------------------------------------------------------- */
.spinner{display:inline-block;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{left:-40%}100%{left:120%}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideInLeft{from{transform:translateX(-100%)}to{transform:translateX(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* --- LOADING SCREEN ---------------------------------------------------------- */
.loading-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:${C.base}}
.loading-logo{font-size:26px;font-weight:700;color:${C.ink}}
.loading-logo span{color:${C.teal}}
.loading-sub{font-size:13px;color:${C.muted}}

/* --- AUTH -------------------------------------------------------------------- */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(circle at 50% 0%,${C.teal}14,transparent 55%),${C.base}}
.auth-card{background:${C.surface};border:1px solid ${C.border};border-radius:22px;padding:36px 32px;width:100%;max-width:400px;box-shadow:0 8px 40px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.04)}
.auth-logo-img{display:block;max-width:200px;width:64%;height:auto;margin:0 auto 4px}
.auth-tagline{font-size:13.5px;color:${C.muted};margin-bottom:26px;text-align:center;font-weight:500}
.auth-tabs{display:flex;background:${C.panel};border-radius:12px;padding:4px;margin-bottom:22px;gap:4px}
.auth-tab{flex:1;padding:9px;border-radius:9px;border:none;background:none;font-size:13.5px;font-weight:600;color:${C.muted};transition:all .2s cubic-bezier(.4,0,.2,1);cursor:pointer}
.auth-tab.active{background:${C.teal};color:#fff;font-weight:700;box-shadow:0 2px 8px ${C.teal}40}
.auth-error{background:${C.red}12;border:1px solid ${C.red}33;color:${C.red};border-radius:10px;padding:11px 14px;font-size:13px;margin-bottom:14px}
.auth-back{background:none;border:none;color:${C.muted};font-size:13px;margin-top:18px;width:100%;text-align:center;font-weight:500;transition:color .15s;cursor:pointer}
.auth-back:hover{color:${C.ink}}
.auth-field{margin-bottom:14px}
.auth-label{font-size:11.5px;font-weight:700;color:${C.silver};margin-bottom:6px;display:block;letter-spacing:.3px}
.auth-input{width:100%;background:${C.panel};border:1.5px solid transparent;color:${C.ink};padding:12px 14px;border-radius:12px;font-size:15px;outline:none;transition:all .18s;box-sizing:border-box;-webkit-appearance:none}
.auth-input:focus{border-color:${C.teal};background:${C.surface};box-shadow:0 0 0 3px ${C.teal}18}
.auth-input::placeholder{color:${C.muted}}
.auth-row{display:flex;gap:10px}
.auth-row .auth-field{flex:1}

/* --- DASHBOARD --------------------------------------------------------------- */
.dash-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:16px 18px}
.stat-card-label{font-size:11px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.stat-card-val{font-size:26px;font-weight:700;color:${C.ink};line-height:1.1}
.stat-card-sub{font-size:11px;color:${C.muted};margin-top:4px}
.dash-2col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dash-panel{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:16px}
.dash-panel-title{font-size:13px;font-weight:700;color:${C.ink};margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
.recent-flight{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid ${C.border}}
.recent-flight:last-child{border-bottom:none}
.rf-num{font-size:12px;font-weight:700;color:${C.teal};min-width:56px}
.rf-route{font-size:13px;color:${C.ink};flex:1;font-weight:500}
.rf-time{font-size:12px;color:${C.muted};font-family:'JetBrains Mono',monospace}
.rf-tail{font-size:11px;color:${C.silver};background:${C.panel};padding:2px 7px;border-radius:5px;font-family:'JetBrains Mono',monospace}

/* --- UPLOAD ------------------------------------------------------------------- */
.upload-zone{border:2px dashed ${C.border};border-radius:14px;padding:48px 24px;text-align:center;cursor:pointer;transition:all .2s;background:${C.surface};color:${C.silver}}
.upload-zone:hover,.upload-zone.drag{border-color:${C.teal};background:${C.teal}08;color:${C.teal}}
.upload-icon{font-size:44px;display:block;margin-bottom:12px;opacity:.6}
.upload-page{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;max-width:900px}
.upload-info-panel{display:flex;flex-direction:column;gap:14px}
.upload-info-row{display:flex;gap:12px;align-items:flex-start}
.upload-info-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.upload-info-title{font-size:13px;font-weight:600;color:${C.ink};margin-bottom:2px}
.upload-info-desc{font-size:12px;color:${C.muted};line-height:1.5}

/* --- CALENDAR ----------------------------------------------------------------- */
/* --- CALENDAR ----------------------------------------------------------------- */
.month-tab{background:none;border:1px solid ${C.border};color:${C.silver};padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:all .12s}
.month-tab.active{background:${C.teal};border-color:${C.teal};color:#fff}
.cal-month-title{font-size:18px;font-weight:700;color:${C.ink}}
.cal-legend{display:flex;gap:14px;flex-wrap:wrap}
.cal-legend-item{display:flex;align-items:center;gap:5px;font-size:12px;color:${C.silver}}
.cal-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.cal-dot.flown{background:${C.teal}}
.cal-dot.scheduled{background:${C.gold}}
.cal-dot.duty{background:${C.silver}}
.cal-dot.off{background:${C.border}}

/* 7-column grid -- all cells same fixed height */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);border-top:1px solid ${C.border};border-left:1px solid ${C.border};background:${C.border};gap:1px;border-radius:12px;overflow:hidden}
.cal-weekday{background:${C.panel};padding:9px 6px;text-align:center;font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.5px}
.cal-cell{height:80px;padding:7px;cursor:pointer;transition:background .1s;background:${C.surface};position:relative;overflow:hidden;box-sizing:border-box}
.cal-cell:hover{background:${C.panel}}
.cal-cell.today .cal-cell-day{background:${C.teal};color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center}
.cal-cell.off{background:${C.base}}
.cal-cell.selected{background:${C.teal}18}
.cal-cell.cal-cell-blank{background:${C.base};cursor:default;pointer-events:none}
.cal-cell-day{font-size:12px;font-weight:600;color:${C.muted};margin-bottom:3px;line-height:1;width:22px;height:22px;display:flex;align-items:center;justify-content:center}
.cal-cell.scheduled .cal-cell-day,.cal-cell.flown .cal-cell-day,.cal-cell.duty .cal-cell-day{color:${C.ink}}
.cal-cell-dot{width:6px;height:6px;border-radius:50%;position:absolute;top:7px;right:7px}
.cal-cell.flown .cal-cell-dot{background:${C.teal}}
.cal-cell.scheduled .cal-cell-dot{background:${C.gold}}
.cal-cell.duty .cal-cell-dot{background:${C.silver}}
.cal-cell-route{font-size:9px;color:${C.silver};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.cal-cell-legs{font-size:9px;color:${C.teal};font-weight:700;margin-top:2px}

/* Day detail panel */
.cal-detail{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:16px;margin-top:14px}
.cal-detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.cal-detail-title{font-size:15px;font-weight:700;color:${C.ink}}
.cal-detail-close{background:none;border:none;color:${C.muted};font-size:18px;cursor:pointer;line-height:1;padding:0 4px}
.cal-detail-off{font-size:13px;color:${C.muted};font-style:italic;padding:8px 0}
.cal-detail-flights{display:flex;flex-direction:column;gap:8px}
.cal-detail-flight{display:grid;grid-template-columns:72px 1fr 110px 70px 80px 24px;gap:8px;align-items:center;padding:8px 10px;border-radius:9px;background:${C.panel}}
.cal-detail-flight-num{font-size:12px;font-weight:700;color:${C.teal}}
.cal-detail-flight-route{font-size:13px;color:${C.ink};font-weight:600}
.cal-detail-flight-time{font-size:11px;color:${C.muted};font-family:monospace}
.cal-detail-flight-block{font-size:12px;font-weight:600;font-family:monospace}
.cal-detail-flight-tail{font-size:11px;color:${C.silver};font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-detail-flight-del{background:none;border:none;color:${C.muted};font-size:14px;cursor:pointer;padding:0;text-align:center}
.cal-add-form{margin-top:14px;display:flex;flex-direction:column;gap:8px}
.cal-add-row{display:flex;gap:8px}
.cal-add-narrow{width:90px;flex-shrink:0}

/* --- LOGBOOK -- DAY CARDS / SEGMENT TABS -------------------------------------- */
.lb-day-card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;overflow:hidden;margin-bottom:10px}
.lb-day-header{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;user-select:none;transition:background .1s}
.lb-day-header:hover{background:${C.panel}}
.lb-day-num{width:44px;height:44px;border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0}
.lb-day-num-val{font-size:17px;font-weight:800;line-height:1}
.lb-day-num-dow{font-size:9px;font-weight:600;text-transform:uppercase;opacity:.7}
.lb-day-info{flex:1;min-width:0}
.lb-day-route{font-size:14px;font-weight:700;color:${C.ink};line-height:1.2}
.lb-day-meta{font-size:11px;color:${C.muted};margin-top:2px}
.lb-chevron{color:${C.muted};font-size:11px;transition:transform .2s;flex-shrink:0}
.lb-segments{padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px;border-top:1px solid ${C.border}}
.lb-seg{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;cursor:pointer;transition:all .12s;border:1px solid ${C.border};background:${C.panel}}
.lb-seg:hover{border-color:${C.teal}55;background:${C.teal}08}
.lb-seg.actual{background:${C.teal}08;border-color:${C.teal}33}
.lb-seg-num{font-size:11px;font-weight:700;color:${C.teal};min-width:54px;flex-shrink:0}
.lb-seg-route{flex:1;min-width:0}
.lb-seg-dep-arr{font-size:15px;font-weight:700;color:${C.ink};line-height:1.2}
.lb-seg-dep-arr b{letter-spacing:-.2px}
.lb-seg-times{font-size:11px;color:${C.muted};margin-top:2px}
.lb-seg-times.synced{color:${C.teal}}
.lb-seg-right{text-align:right;flex-shrink:0}
.lb-seg-tail{font-size:11px;font-family:monospace;color:${C.silver}}
.lb-seg-dist{font-size:10px;color:${C.muted};margin-top:2px}
.lb-seg-night{font-size:9px;font-weight:700;color:${C.teal};margin-top:2px}
.lb-seg-arrow{color:${C.muted};font-size:13px;flex-shrink:0}

/* --- MAP ---------------------------------------------------------------------- */
.leaflet-container{background:${C.base}}

/* --- DATA TABLE (admin) ------------------------------------------------------- */
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{background:${C.panel};color:${C.muted};font-size:10px;text-transform:uppercase;letter-spacing:.8px;padding:8px 12px;text-align:left;border-bottom:1px solid ${C.border}}
.data-table td{padding:10px 12px;border-bottom:1px solid ${C.border};vertical-align:middle}
.data-table tr:hover td{background:${C.panel}}

/* --- EMPTY / MISC ------------------------------------------------------------- */
.empty-state{text-align:center;padding:48px 24px;color:${C.muted};font-size:13px}
.empty-icon{font-size:40px;margin-bottom:10px;opacity:.35}
.tag{display:inline-flex;background:${C.panel};border:1px solid ${C.border};color:${C.silver};font-size:11px;padding:2px 8px;border-radius:5px}
.table-wrap{overflow-x:auto}


/* -- Landing page -- always light ------------------------------------ */
.lp-root{background:#f8f9fc;min-height:100vh;color:#0F172A;font-family:Inter,system-ui,sans-serif}
.lp-nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;gap:24px;padding:0 40px;height:64px;background:rgba(248,249,252,0.95);backdrop-filter:blur(16px);border-bottom:1px solid #E2E8F0}
.lp-logo{font-size:20px;font-weight:800;color:#0F172A;letter-spacing:-.5px}
.lp-logo span{color:#2C7BE5}
.lp-nav-links{display:flex;gap:28px;margin-left:auto}
.lp-nav-link{font-size:13px;color:#64748B;background:none;border:none;cursor:pointer;font-weight:500;padding:0;transition:color .15s}
.lp-nav-link:hover{color:#0F172A}
.lp-nav-actions{display:flex;align-items:center;gap:8px}
.lp-nav-login{background:none;border:none;color:#0F172A;font-size:13px;font-weight:600;padding:8px 14px;cursor:pointer}
.lp-nav-cta{background:#2C7BE5;color:#fff;border:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s}
.lp-nav-cta:hover{background:#1a6fd4}
.lp-hero{min-height:92vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 24px 64px;position:relative;overflow:hidden;background:#f8f9fc}
.lp-hero-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 50% at 50% -10%,#2C7BE518 0%,transparent 65%)}
.lp-badge{display:inline-flex;align-items:center;gap:8px;background:#EFF6FF;border:1px solid #BFDBFE;color:#2C7BE5;font-size:11px;font-weight:700;letter-spacing:1.5px;padding:6px 16px;border-radius:100px;margin-bottom:28px;text-transform:uppercase}
.lp-badge-dot{width:6px;height:6px;border-radius:50%;background:#2C7BE5;animation:pulse 2s infinite}
.lp-headline{font-size:clamp(38px,6vw,74px);font-weight:900;line-height:1.04;letter-spacing:-2px;color:#0F172A;margin-bottom:20px}
.lp-headline em{color:#2C7BE5;font-style:normal}
.lp-sub{font-size:clamp(15px,1.4vw,18px);color:#475569;max-width:500px;margin:0 auto 36px;line-height:1.65}
.lp-hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:56px}
.btn-primary{background:#2C7BE5;color:#fff;border:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:all .15s;box-shadow:0 4px 14px #2C7BE530}
.btn-primary:hover{background:#1a6fd4;transform:translateY(-1px);box-shadow:0 6px 20px #2C7BE540}
.btn-ghost{background:#fff;color:#0F172A;border:1.5px solid #E2E8F0;padding:13px 28px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-ghost:hover{border-color:#2C7BE5;color:#2C7BE5}
.flight-path-wrap{width:100%;max-width:600px;margin:0 auto;position:relative}
@keyframes fly{0%{transform:translateX(0) translateY(0)}50%{transform:translateX(8px) translateY(-6px)}100%{transform:translateX(0) translateY(0)}}
@keyframes trail-draw{0%{stroke-dashoffset:500}100%{stroke-dashoffset:0}}
.lp-stats{display:flex;justify-content:center;background:#fff;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;flex-wrap:wrap}
.lp-stat{padding:28px 40px;border-right:1px solid #E2E8F0;text-align:center}
.lp-stat:last-child{border-right:none}
.lp-stat-num{font-size:34px;font-weight:900;color:#0F172A;letter-spacing:-1px}
.lp-stat-lbl{font-size:12px;color:#64748B;margin-top:3px;font-weight:500}
.lp-section{padding:80px 40px;max-width:1100px;margin:0 auto}
.lp-section-eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#2C7BE5;margin-bottom:10px}
.lp-section-title{font-size:clamp(26px,3vw,42px);font-weight:900;color:#0F172A;margin-bottom:14px;line-height:1.08;letter-spacing:-.8px}
.lp-section-sub{font-size:16px;color:#475569;max-width:480px;line-height:1.65}
.features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:44px}
.feature-card{background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:28px;transition:all .2s}
.feature-card:hover{border-color:#2C7BE555;transform:translateY(-3px);box-shadow:0 12px 32px rgba(44,123,229,0.08)}
.feature-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
.feature-title{font-size:15px;font-weight:700;color:#0F172A;margin-bottom:6px}
.feature-desc{font-size:13px;color:#64748B;line-height:1.65}
.how-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));background:#fff;border-radius:16px;border:1px solid #E2E8F0;margin-top:44px;overflow:hidden}
.how-step{padding:32px 24px;border-right:1px solid #E2E8F0}
.how-step:last-child{border-right:none}
.how-num{font-size:42px;font-weight:900;color:#EFF6FF;line-height:1;margin-bottom:14px}
.how-title{font-size:15px;font-weight:700;color:#0F172A;margin-bottom:6px}
.how-desc{font-size:13px;color:#64748B;line-height:1.6}
.how-icon{width:40px;height:40px;border-radius:12px;background:#EFF6FF;display:flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:20px}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:44px;max-width:640px}
.price-card{background:#fff;border:1.5px solid #E2E8F0;border-radius:20px;padding:32px;position:relative}
.price-card.featured{border-color:#2C7BE5;box-shadow:0 8px 32px #2C7BE518}
.price-badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#2C7BE5;color:#fff;font-size:10px;font-weight:700;padding:4px 14px;border-radius:100px;letter-spacing:1px;white-space:nowrap}
.price-plan{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#64748B;margin-bottom:6px}
.price-amount{font-size:48px;font-weight:900;color:#0F172A;line-height:1;letter-spacing:-2px}
.price-period{font-size:14px;color:#94A3B8;margin-left:4px}
.price-desc{font-size:13px;color:#64748B;margin:10px 0 20px}
.price-features{list-style:none;display:flex;flex-direction:column;gap:9px;margin-bottom:28px}
.price-features li{font-size:13px;color:#475569;display:flex;align-items:center;gap:9px;font-weight:500}
.price-features li::before{content:"✓";color:#2C7BE5;font-weight:800;flex-shrink:0}
.price-cta{width:100%;padding:14px;border-radius:10px;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:all .15s}
.price-cta-primary{background:#2C7BE5;color:#fff;box-shadow:0 4px 14px #2C7BE530}
.price-cta-primary:hover{background:#1a6fd4}
.price-cta-ghost{background:transparent;color:#0F172A;border:1.5px solid #E2E8F0}
.price-cta-ghost:hover{border-color:#2C7BE5;color:#2C7BE5}
.lp-footer{background:#fff;border-top:1px solid #E2E8F0;padding:32px 40px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.lp-footer-copy{font-size:12px;color:#94A3B8;margin-left:auto}
.lp-eyebrow{display:inline-flex;align-items:center;gap:8px;background:#EFF6FF;border:1px solid #BFDBFE;color:#2C7BE5;font-size:11px;font-weight:700;letter-spacing:1.5px;padding:6px 14px;border-radius:100px;margin-bottom:28px;text-transform:uppercase}
.lp-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:#2C7BE5;animation:pulse 2s infinite}


/* --- MOBILE ------------------------------------------------------------------- */
/* -- Responsive layout -- */
/* Desktop: show sidebar, hide tab bar */
.desktop-sidebar{display:flex}
.mobile-tabbar{display:none}

@media(max-width:768px){
  /* Mobile: hide sidebar, show tab bar */
  .desktop-sidebar{display:none!important}
  /* Fixed bottom nav -- always visible, never scrolls away */
  .mobile-tabbar{
    display:flex!important;
    flex-direction:column;
    position:fixed!important;
    bottom:0;
    left:0;
    right:0;
    z-index:999;
    flex-shrink:0;
  }
  /* Push page content above the fixed nav bar */
  .mobile-page-content{padding-bottom:74px!important;}
  .sidebar{display:none}
  .app-content{margin-left:0}
  .app-body{padding:12px;padding-bottom:20px}
  .hamburger-btn{display:flex}
  .dash-2col{grid-template-columns:1fr}
  .upload-page{grid-template-columns:1fr}
  .upload-info-panel{display:none}
  .lp-nav{padding:0 14px;gap:8px;height:56px}
  .lp-nav-links{display:none}
  .lp-nav-login{padding:7px 10px;font-size:13px}
  .lp-nav-cta{padding:7px 14px;font-size:13px}
  .lp-section{padding:48px 16px}
  .lp-stat{padding:20px 20px}
  .lp-stat-num{font-size:26px}
  .features-grid{grid-template-columns:1fr}
  .how-grid{grid-template-columns:1fr}
  .how-step{border-right:none;border-bottom:1px solid #E2E8F0}
  .how-step:last-child{border-bottom:none}
  .pricing-grid{grid-template-columns:1fr}
  .lp-footer{padding:24px 16px;flex-direction:column;align-items:flex-start;gap:12px}
  .lp-footer-copy{margin-left:0}
  .cal-cell{height:70px;padding:4px 5px}
  .cal-cell-route{font-size:8px}
  .cal-cell-legs{font-size:8px}
  .cal-detail-flight{grid-template-columns:60px 1fr 90px 50px 24px;gap:5px}
  .dash-grid{grid-template-columns:repeat(2,1fr)}
  .stat-card-val{font-size:22px}
  .lp-footer{padding:24px 14px}
  .card{padding:14px}
}
`; } // end buildStyles

// Inject styles immediately on module load -- before any React rendering
// This ensures the landing page CSS is available from the first paint
(function injectStyles() {
  function inject() {
    try {
      const dark = localStorage.getItem("fl_theme") === "dark";
      if(dark) Object.assign(C, DARK); else Object.assign(C, LIGHT);
      let el = document.getElementById("fl-styles");
      if(!el) {
        el = document.createElement("style");
        el.id = "fl-styles";
        document.head.appendChild(el);
      }
      el.textContent = buildStyles();
    } catch(e) { /* will retry */ }
  }
  // Try immediately (works if DOM is ready)
  inject();
  // Also try on DOMContentLoaded in case module loaded before DOM
  if(typeof document !== "undefined") {
    if(document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", inject);
    }
    // Belt-and-suspenders: also try after a tick
    setTimeout(inject, 0);
  }
})();

// -- UTILITIES
const fmtMins = m => !m||isNaN(m) ? "0:00" : `${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;
// Inverse of fmtMins -- parses a pilot-entered "h:mm" (e.g. "1:30") or plain
// decimal-hours string (e.g. "1.5") into whole minutes. Used by any manual
// logged-time override field (night, cross country, actual/sim instrument).
const parseHM = val => {
  if(!val) return 0;
  const s = String(val).trim();
  if(s.includes(":")) {
    const [h,m] = s.split(":").map(Number);
    return (isNaN(h)?0:h)*60 + (isNaN(m)?0:m);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n*60);
};
// Parse "h:mm" or decimal hours string into total minutes
const parseBlockHrToMins = (str) => {
  if(!str) return null;
  const s = String(str).trim();
  if(s.includes(":")) {
    const [h,m] = s.split(":").map(Number);
    if(isNaN(h)||isNaN(m)) return null;
    return h*60 + m;
  }
  const dec = parseFloat(s);
  if(isNaN(dec)) return null;
  return Math.round(dec * 60);
};

// Returns the index of the roster that best matches the current month.
// Falls back to 0 (most recently uploaded) if no current-month roster exists.
// -- AIRPORT COORDINATES & SOLAR/DISTANCE UTILITIES

const AIRPORT_COORDS = {
  ORD:[41.9742,-87.9073], MLI:[41.4485,-90.5075], CHA:[35.0353,-85.2038],
  CMH:[39.9980,-82.8919], CVG:[39.0488,-84.6678], XNA:[36.2819,-94.3068],
  LEX:[38.0365,-84.6060], SCE:[40.8493,-77.8487], COU:[38.8181,-92.2196],
  AVP:[41.3385,-75.7234], ATW:[44.2581,-88.5196], FSD:[43.5820,-96.7419],
  LIT:[34.7294,-92.2243], BHM:[33.5629,-86.7535], MDT:[40.1935,-76.7634],
  JFK:[40.6413,-73.7781], LGA:[40.7769,-73.8740], EWR:[40.6895,-74.1745],
  LAX:[33.9425,-118.4081], SFO:[37.6213,-122.3790], SEA:[47.4502,-122.3088],
  DEN:[39.8561,-104.6737], PHX:[33.4373,-112.0078], DFW:[32.8998,-97.0403],
  IAH:[29.9902,-95.3368], ATL:[33.6407,-84.4277], MIA:[25.7959,-80.2870],
  BOS:[42.3656,-71.0096], DTW:[42.2124,-83.3534], MSP:[44.8820,-93.2218],
  STL:[38.7487,-90.3700], IND:[39.7173,-86.2944], CLT:[35.2140,-80.9431],
  PHL:[39.8729,-75.2437], BWI:[39.1754,-76.6684], DCA:[38.8512,-77.0402],
  IAD:[38.9531,-77.4565], MCO:[28.4312,-81.3081], FLL:[26.0726,-80.1527],
  TPA:[27.9755,-82.5332], LAS:[36.0840,-115.1537], SLC:[40.7884,-111.9778],
  PDX:[45.5898,-122.5951], SAN:[32.7336,-117.1897], AUS:[30.1945,-97.6699],
  SAT:[29.5337,-98.4698], MCI:[39.2976,-94.7139], CLE:[41.4117,-81.8498],
  PIT:[40.4915,-80.2329], RDU:[35.8776,-78.7875], MEM:[35.0424,-89.9767],
  BNA:[36.1245,-86.6782], JAX:[30.4941,-81.6879], OMA:[41.3032,-95.8940],
  DSM:[41.5340,-93.6631], GRR:[42.8808,-85.5228], DAY:[39.9024,-84.2194],
  ROC:[43.1189,-77.6724], SYR:[43.1112,-76.1063], BUF:[42.9405,-78.7322],
  ABQ:[35.0402,-106.6090], TUL:[36.1984,-95.8881], OKC:[35.3931,-97.6007],
  MKE:[42.9472,-87.8966], MSY:[29.9934,-90.2580], SJC:[37.3626,-121.9290],
  SMF:[38.6954,-121.5908], OAK:[37.7213,-122.2208], LGB:[33.8177,-118.1516],
  BDL:[41.9389,-72.6832], ORF:[36.8976,-76.0183], RIC:[37.5052,-77.3197],
  GSO:[36.0978,-79.9373], GSP:[34.8957,-82.2189], CAE:[33.9389,-81.1195],
  CHS:[32.8986,-80.0405], SAV:[32.1276,-81.2021], PNS:[30.4734,-87.1866],
  MOB:[30.6912,-88.2428], HSV:[34.6372,-86.7751], GPT:[30.4073,-89.0701],
  BTR:[30.5332,-91.1496], SHV:[32.4466,-93.8256], TYS:[35.8110,-83.9940],
  EVV:[38.0369,-87.5324], SBN:[41.7087,-86.3173], TOL:[41.5868,-83.8078],
  CAK:[40.9161,-81.4422], HPN:[41.0670,-73.7076], ALB:[42.7483,-73.8020],
  PWM:[43.6462,-70.3093], BGR:[44.8074,-68.8281], MHT:[42.9326,-71.4357],
  PVD:[41.7232,-71.4281], ACK:[41.2531,-70.0600], HYA:[41.6693,-70.2836],
};

// Haversine distance between two lat/lng points in nautical miles
function distanceNM(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}

function airportDistanceNM(dep, arr) {
  const c1=AIRPORT_COORDS[dep], c2=AIRPORT_COORDS[arr];
  if(!c1||!c2) return null;
  return distanceNM(c1[0],c1[1],c2[0],c2[1]);
}

// Alias used throughout the app
const calcDist = (dep, arr) => airportDistanceNM(dep, arr);

// Compute analytics from rosters/tails
function computeAnalytics(rosters, tails, timeRules=[], xc={}, night={}, toLandingMode="every") {
  const byMonth = {};
  let totalMins=0, totalLegs=0, totalNight=0, totalXC=0, totalPIC=0, totalSIC=0;
  let totalLandings=0, totalNightLandings=0, totalDist=0;
  let totalMulti=0, totalTurbine=0, totalSingle=0;
  let totalActualIfr=0, totalSimIfr=0;
  const airportSet=new Set();
  const now2 = new Date();
  const cutoff30  = new Date(now2); cutoff30.setDate(now2.getDate()-30);
  const cutoff6mo = new Date(now2); cutoff6mo.setMonth(now2.getMonth()-6);
  const cutoff12mo= new Date(now2); cutoff12mo.setMonth(now2.getMonth()-12);
  // Upper bound for all three rolling windows -- without this, a flight
  // later in the current month (already parsed into the roster, but not
  // yet flown) would get counted into "last 30 days" etc just because its
  // date fell after the lower cutoff. Windows must only look backward from
  // the moment the page is viewed, never forward into scheduled-but-not-yet-
  // flown days.
  const todayEnd = new Date(now2.getFullYear(), now2.getMonth(), now2.getDate(), 23, 59, 59, 999);
  const last30  = {mins:0,legs:0,night:0,xc:0,landings:0};
  const last6mo = {mins:0,legs:0,night:0,xc:0,landings:0};
  const last12mo= {mins:0,legs:0,night:0,xc:0,landings:0};

  // Find which time rule (if any) applies to a given date — determines
  // PIC/SIC/multi/single/turbine classification for that flight.
  function ruleForDate(dateStr) {
    for(const rule of timeRules) {
      if(!rule.start_date) continue;
      const afterStart = dateStr >= rule.start_date;
      const beforeEnd = !rule.end_date || dateStr <= rule.end_date;
      if(afterStart && beforeEnd) return rule;
    }
    return null;
  }

  // Aircraft type classification — used when no explicit time rule overrides it
  function classifyAcType(acType) {
    const t=(acType||"").toUpperCase();
    const isMulti=/B73[78H]|B737|B738|B739|B74[78]|B767|B772|B77[789]|B787|A3[0-9]{2}|CRJ|CR[79]|E7[05]|E170|E175|E190|ERJ/i.test(t);
    const isTurbine=isMulti||/DH8|ATR|SF3/i.test(t);
    const isSingle=!isMulti&&/C172|PA28|BE[123]/i.test(t);
    return {isMulti,isTurbine,isSingle};
  }

  for(const r of rosters){
    const mNum=r.monthNum??r.month_num??0;
    (r.calendar||[]).forEach((d,di)=>{
      (d.flights||[]).forEach((f,fi)=>{
        const tk=`${r.id}-${di}-${fi}`;
        const t=tails[tk]||{};
        if(t.cancelled) return;
        if(f.isDeadhead) return; // deadhead — pilot is a passenger, doesn't count toward flight time/PIC/SIC totals
        const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
        const flightDate=new Date(dateStr+"T00:00:00");
        const monthKey=dateStr.slice(0,7);
        // Imported logbook rows carry the pilot's LOGGED values — those are
        // authoritative and override recomputation (solar night, distance XC).
        const mins=f.loggedMins!=null?f.loggedMins:(t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0);
        const dist=calcDist(f.dep,f.arr)||0;
        const solar=(f.depTime&&f.arrTime)?computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr):null;
        const nightMins=f.loggedNightMins!=null?f.loggedNightMins:(solar?.nightMins||0);
        const isXC=f.loggedXcMins!=null?f.loggedXcMins>0:dist>50;
        const xcMins=f.loggedXcMins!=null?f.loggedXcMins:(isXC?mins:0);
        const actualIfrMins=f.loggedActualIfrMins||0;
        const simIfrMins=f.loggedSimIfrMins||0;
        const ldgs=f.loggedLandings!=null?f.loggedLandings:1;
        const nightLdgs=f.loggedNightLandings!=null?Math.min(f.loggedNightLandings,ldgs):(solar?.nightArr?ldgs:0);
        const dayLdgs=f.loggedDayLandings!=null?f.loggedDayLandings:Math.max(0,ldgs-nightLdgs);

        // Apply matching time rule for this date, else default classification
        const rule = ruleForDate(dateStr);
        const acClass = classifyAcType(f.acType);
        const isPIC = rule ? !!rule.is_pic : false;
        const isSIC = rule ? !!rule.is_sic : !rule; // default to SIC if no rule set (airline FO ops)
        const picContrib = f.loggedPicMins!=null ? f.loggedPicMins : (isPIC?mins:0);
        const sicContrib = f.loggedSicMins!=null ? f.loggedSicMins : (isSIC?mins:0);
        const isMulti = rule ? !!rule.is_multi : acClass.isMulti;
        const isSingle = rule ? !!rule.is_single : acClass.isSingle;
        const isTurbine = rule ? !!rule.is_turbine : acClass.isTurbine;

        if(!byMonth[monthKey]) byMonth[monthKey]={
          mins:0,flownMins:0,legs:0,night:0,xc:0,landings:0,nightLandings:0,
          pic:0,sic:0,multi:0,turbine:0,single:0,dist:0,
          dayTo:0,nightTo:0,dayLdg:0,nightLdg:0,
        };
        const bm = byMonth[monthKey];
        bm.mins+=mins;
        bm.flownMins+=mins; // alias used by Overview tab
        bm.legs+=1;
        bm.night+=nightMins;
        bm.xc+=xcMins; // XC shown as TIME, not leg count
        bm.landings+=ldgs;
        bm.dist+=dist;
        bm.pic+=picContrib;
        bm.sic+=sicContrib;
        if(isMulti) bm.multi+=mins;
        if(isTurbine) bm.turbine+=mins;
        if(isSingle) bm.single+=mins;
        bm.nightLandings+=nightLdgs; bm.nightTo+=nightLdgs;
        bm.dayLdg+=dayLdgs; bm.dayTo+=dayLdgs;

        totalMins+=mins; totalLegs+=1; totalNight+=nightMins; totalDist+=dist;
        totalXC+=xcMins;
        totalActualIfr+=actualIfrMins; totalSimIfr+=simIfrMins;
        totalLandings+=ldgs;
        totalPIC+=picContrib;
        totalSIC+=sicContrib;
        if(isMulti) totalMulti+=mins;
        if(isTurbine) totalTurbine+=mins;
        if(isSingle) totalSingle+=mins;
        totalNightLandings+=nightLdgs;
        if(f.dep) airportSet.add(f.dep);
        if(f.arr) airportSet.add(f.arr);
        // Rolling time buckets -- bounded both sides: on/after the cutoff,
        // and never later than today (excludes upcoming scheduled days).
        if(flightDate>=cutoff30 &&flightDate<=todayEnd)  { last30.mins+=mins;  last30.legs+=1;  last30.night+=nightMins;  last30.xc+=xcMins;  last30.landings+=ldgs; }
        if(flightDate>=cutoff6mo&&flightDate<=todayEnd) { last6mo.mins+=mins; last6mo.legs+=1; last6mo.night+=nightMins; last6mo.xc+=xcMins; last6mo.landings+=ldgs; }
        if(flightDate>=cutoff12mo&&flightDate<=todayEnd){ last12mo.mins+=mins;last12mo.legs+=1;last12mo.night+=nightMins;last12mo.xc+=xcMins;last12mo.landings+=ldgs; }
      });
    });
  }
  return{
    totalMins,totalLegs,totalNight,totalXC,totalLandings,totalNightLandings,
    totalPIC,totalSIC,totalMulti,totalTurbine,totalSingle,totalDist,
    airports:airportSet.size,
    byMonth, last30, last6mo, last12mo,
    totalHrs:fmtMins(totalMins),
    nightHrs:fmtMins(totalNight),
    // totals object — field names match what AnalyticsPage Overview tab reads
    totals:{
      pic:totalPIC,
      sic:totalSIC,
      multi:totalMulti,
      turbine:totalTurbine,
      single:totalSingle,
      night:totalNight,
      xc:totalXC,
      actualIfr:totalActualIfr,
      simIfr:totalSimIfr,
      dist:totalDist,
      dayTo:totalLandings-totalNightLandings,
      nightTo:totalNightLandings,
      dayLdg:totalLandings-totalNightLandings,
      nightLdg:totalNightLandings,
    },
  };
}


// NOAA solar civil twilight calculation (96 deg zenith)
function solarTimes(dateStr, lat, lon) {
  const date = new Date(dateStr+"T12:00:00Z");
  const JD = date.getTime()/86400000+2440587.5;
  const n = JD-2451545.0;
  const L = (280.460+0.9856474*n)%360;
  const g = ((357.528+0.9856003*n)%360)*Math.PI/180;
  const lambda = (L+1.915*Math.sin(g)+0.020*Math.sin(2*g))*Math.PI/180;
  const epsilon = 23.439*Math.PI/180;
  const sinDec = Math.sin(epsilon)*Math.sin(lambda);
  const dec = Math.asin(sinDec);
  const cosHA = (Math.cos(96*Math.PI/180)-sinDec*Math.sin(lat*Math.PI/180))/(Math.cos(dec)*Math.cos(lat*Math.PI/180));
  if(Math.abs(cosHA)>1) return null;
  const HA = Math.acos(cosHA)*180/Math.PI;
  const EqT = (-1.915*Math.sin(g)-0.020*Math.sin(2*g)+2.466*Math.sin(2*lambda)-0.053*Math.sin(4*lambda))/60;
  const transit = 12-EqT-lon/15;
  return { sunrise:transit-HA/15, sunset:transit+HA/15 };
}

function computeSolarTimes(dep, arr, depTime, arrTime, dateStr) {
  const result = computeNightTime(dateStr, dep, arr, depTime, arrTime);
  return result || {nightMins:0, nightDep:false, nightArr:false, dayDep:true, dayArr:true};
}

function computeNightTime(dateStr, depCode, arrCode, depTime, arrTime) {
  const depCoords = AIRPORT_COORDS[depCode], arrCoords = AIRPORT_COORDS[arrCode];
  if(!depCoords||!arrCoords||!depTime||!arrTime) {
    return {nightMins:0,dayDep:true,nightDep:false,dayArr:true,nightArr:false};
  }

  // Step 1: Get UTC offsets for the actual flight date (DST-aware)
  const depOffMin = getAirportUtcOffsetMins(depCode, dateStr); // e.g. -240 (EDT)
  const arrOffMin = getAirportUtcOffsetMins(arrCode, dateStr);

  const [dh,dm] = depTime.split(":").map(Number);
  const [ah,am] = arrTime.split(":").map(Number);
  if(isNaN(dh)||isNaN(dm)||isNaN(ah)||isNaN(am)) {
    return {nightMins:0,dayDep:true,nightDep:false,dayArr:true,nightArr:false};
  }

  // Step 2: Convert dep/arr local times to absolute UTC minutes
  // (relative to the departure calendar date at 00:00 UTC)
  const depUtcMin = (dh*60+dm) - depOffMin;  // may be negative or >1440
  const arrUtcMin = (ah*60+am) - arrOffMin;

  // Block time = UTC arrival minus UTC departure, wrapping for overnight
  let blockMins = arrUtcMin - depUtcMin;
  while(blockMins <= 0) blockMins += 1440;
  if(blockMins > 1200) blockMins = blockMins % 1440; // sanity cap

  // Step 3: Get sunrise/sunset as UTC hours from solarTimes()
  // solarTimes returns values like 9.1 (sunrise) and 25.3 (sunset in UTC for
  // summer US evenings that occur after midnight UTC). We keep them as-is and
  // convert to UTC MINUTES for comparison, then use them directly on the
  // continuous UTC minute timeline -- no wrapping into 0-24, which causes bugs.
  const depSolar = solarTimes(dateStr, depCoords[0], depCoords[1]);
  const arrDateStr = (depUtcMin + blockMins >= 1440) ? addDaysToDateStr(dateStr,1) : dateStr;
  const arrSolar  = solarTimes(arrDateStr, arrCoords[0], arrCoords[1]);
  if(!depSolar||!arrSolar) return {nightMins:0,dayDep:true,nightDep:false,dayArr:true,nightArr:false};

  // Convert solar times to UTC minutes on the SAME reference timeline as
  // depUtcMin / arrUtcMin. solarTimes() anchors to the noon UTC of dateStr,
  // so sunrise/sunset values like 9.1 hrs and 25.3 hrs are already in that
  // frame -- just multiply by 60 to get minutes. For arrSolar, the reference
  // shifts by one day if the flight crosses midnight UTC.
  const depSrMin = depSolar.sunrise * 60;  // UTC minutes of sunrise at dep
  const depSsMin = depSolar.sunset  * 60;  // UTC minutes of sunset  at dep
  const arrSrMin = arrSolar.sunrise * 60 + (arrDateStr !== dateStr ? 1440 : 0);
  const arrSsMin = arrSolar.sunset  * 60 + (arrDateStr !== dateStr ? 1440 : 0);

  // Night = UTC time is BEFORE sunrise OR AFTER sunset
  function isNight(utcMin, srMin, ssMin) {
    return utcMin < srMin || utcMin > ssMin;
  }

  const depIsNight = isNight(depUtcMin, depSrMin, depSsMin);
  const arrIsNight = isNight(arrUtcMin, arrSrMin, arrSsMin);

  // Step 4: Walk the flight minute-by-minute to count actual night minutes.
  // This is simple and handles any number of twilight transitions correctly
  // (e.g. ultra-long-haul flights crossing sunrise AND sunset). Each minute
  // we interpolate where "along the route" we are and check against the
  // interpolated sunrise/sunset at that point.
  let nightMins = 0;
  for(let m = 0; m < blockMins; m++) {
    const t = m / blockMins;          // 0=departure, 1=arrival
    const utcMin = depUtcMin + m;     // current UTC minute
    // Interpolate sunrise/sunset between departure and arrival airports
    const srMin = depSrMin + t*(arrSrMin - depSrMin);
    const ssMin = depSsMin + t*(arrSsMin - depSsMin);
    if(isNight(utcMin, srMin, ssMin)) nightMins++;
  }

  return {
    nightMins: Math.round(nightMins),
    dayDep:  !depIsNight, nightDep: depIsNight,
    dayArr:  !arrIsNight, nightArr: arrIsNight,
  };
}

function addDaysToDateStr(dateStr, days) {
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  dt.setUTCDate(dt.getUTCDate()+days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,"0")}-${String(dt.getUTCDate()).padStart(2,"0")}`;
}


function defaultRosterIndex(rosters) {
  if(!rosters||rosters.length===0) return 0;
  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth(); // 0-indexed
  const idx = rosters.findIndex(r => r.year===curYear && r.monthNum===curMonth);
  return idx >= 0 ? idx : 0;
}

// Same but returns the roster id instead of index (for RouteMapPage)
function defaultRosterId(rosters) {
  if(!rosters||rosters.length===0) return null;
  const idx = defaultRosterIndex(rosters);
  return rosters[idx]?.id || null;
}
// Formats a stored UTC timestamp (e.g. tail_logs.updated_at) into a short,
// readable local date+time string for "last synced" notes in the UI.
// Formats an AI-briefing cache expiry into a short "next update in Xm/Xh Ym"
// countdown string, or "" once expired (caller should treat expired as
// no-cache / eligible for a fresh fetch).
const fmtBriefingCountdown = expiresAt => {
  if(!expiresAt) return "";
  const msLeft = expiresAt - Date.now();
  if(msLeft <= 0) return "";
  const minsLeft = Math.ceil(msLeft/60000);
  if(minsLeft < 60) return `next update in ${minsLeft}m`;
  const h = Math.floor(minsLeft/60), m = minsLeft%60;
  return `next update in ${h}h${m>0?` ${m}m`:""}`;
};
// Minutes from now until a flight's scheduled departure, computed correctly
// in UTC via the departure airport's real timezone offset (reuses the same
// DST-aware lookup the auto-sync scheduling already relies on) -- NOT a
// naive string/wall-clock comparison, which would be wrong for a departure
// airport in a different timezone than the pilot's device.
// Returns null if depTime/dateStr are missing (can't compute).
function minsUntilDeparture(depAirport, dateStrYMD, depTimeHHMM) {
  if(!depAirport || !dateStrYMD || !depTimeHHMM) return null;
  const [y,mo,d] = dateStrYMD.split("-").map(Number);
  const [hh,mm] = depTimeHHMM.split(":").map(Number);
  if(!y||!mo||!d||isNaN(hh)||isNaN(mm)) return null;
  // Build as if UTC, then subtract the airport's local UTC offset to get
  // the true UTC instant (offset is "local minus UTC", so local = UTC+offset
  // => UTC = local - offset).
  const asIfUtc = Date.UTC(y, mo-1, d, hh, mm);
  const offsetMins = getAirportUtcOffsetMins(depAirport, new Date(asIfUtc));
  const trueUtcMs = asIfUtc - offsetMins*60000;
  return Math.round((trueUtcMs - Date.now())/60000);
}
// Briefings are gated to flights departing within the next 24h (or already
// in progress/recently departed within a small grace window) -- a briefing
// for a flight a week out is stale by the time it matters, and generating
// one costs a real AI call.
const BRIEFING_WINDOW_MINS = 24*60;
function briefingEligible(depAirport, dateStrYMD, depTimeHHMM) {
  const mins = minsUntilDeparture(depAirport, dateStrYMD, depTimeHHMM);
  if(mins === null) return true; // can't determine -- don't block on missing data
  return mins <= BRIEFING_WINDOW_MINS && mins >= -180; // small grace period after departure
}

// Formats a stored UTC timestamp (e.g. tail_logs.updated_at) into a short,
// readable local date+time string for "last synced" notes in the UI.
const fmtSyncTime = iso => {
  if(!iso) return "";
  try {
    const d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    const dateStr = d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    const timeStr = d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
    return `${dateStr}, ${timeStr}`;
  } catch { return ""; }
};
const flightMins = (dep,arr) => { const [dh,dm]=dep.split(":").map(Number),[ah,am]=arr.split(":").map(Number); let x=(ah*60+am)-(dh*60+dm); return x<0?x+1440:x; };
// Prefer the block time stated directly in the roster (schedBlockMins, extracted
// by the AI parser) since naive local-time subtraction is wrong whenever a flight
// crosses timezones. Falls back to the naive calculation only if the roster didn't
// state a per-leg figure, in which case the value may be off for cross-timezone legs.
// Sanity-checked: a single leg longer than 8 hours from naive subtraction is almost
// certainly a wraparound artifact (arrival clock time appearing "before" departure
// due to timezone, not an genuinely 8+ hour regional hop) -- treat as unknown
// rather than display a misleading double-digit-hour figure.
// Timezone-aware scheduled block time.
// Roster departure/arrival times are LOCAL at each airport. Using raw time
// subtraction fails for cross-timezone flights (e.g. ORD->LAX shows 2:30
// instead of 4:30 because LAX local arrival looks "earlier" than ORD dep).
// We estimate UTC offset from airport longitude (lon/15) and convert both
// times to UTC minutes before subtracting. Falls back to naive if coords unknown.
// Airport IANA timezone map for accurate DST-aware block time calculation
const AIRPORT_TZ = {
  // Eastern
  BHB:"America/New_York",BGR:"America/New_York",RKD:"America/New_York",PQI:"America/New_York",WVL:"America/New_York",AUG:"America/New_York",
  BML:"America/New_York",SFM:"America/New_York",MVL:"America/New_York",IWI:"America/New_York",IWS:"America/New_York",MHT:"America/New_York",
  PSM:"America/New_York",LEB:"America/New_York",CON:"America/New_York",ASH:"America/New_York",EEN:"America/New_York",BTV:"America/New_York",
  MPV:"America/New_York",RUT:"America/New_York",DDH:"America/New_York",VSQ:"America/New_York",BOS:"America/New_York",ORH:"America/New_York",
  PVC:"America/New_York",HYA:"America/New_York",MVY:"America/New_York",ACK:"America/New_York",ACE:"America/New_York",FMH:"America/New_York",
  OWD:"America/New_York",BED:"America/New_York",GBR:"America/New_York",CEF:"America/New_York",FIT:"America/New_York",LWM:"America/New_York",
  ESN:"America/New_York",NZW:"America/New_York",PVD:"America/New_York",WST:"America/New_York",SFZ:"America/New_York",BDL:"America/New_York",
  HVN:"America/New_York",GON:"America/New_York",BDR:"America/New_York",OXC:"America/New_York",DXR:"America/New_York",JFK:"America/New_York",
  LGA:"America/New_York",EWR:"America/New_York",SWF:"America/New_York",HPN:"America/New_York",ISP:"America/New_York",FRG:"America/New_York",
  BUF:"America/New_York",ROC:"America/New_York",SYR:"America/New_York",ALB:"America/New_York",BGM:"America/New_York",ELM:"America/New_York",
  ITH:"America/New_York",OGS:"America/New_York",PBG:"America/New_York",SLK:"America/New_York",MSS:"America/New_York",GFL:"America/New_York",
  SCH:"America/New_York",ART:"America/New_York",CWA:"America/New_York",TOB:"America/New_York",ACY:"America/New_York",TTN:"America/New_York",
  CDW:"America/New_York",PHL:"America/New_York",PIT:"America/New_York",ABE:"America/New_York",MDT:"America/New_York",AVP:"America/New_York",
  ERI:"America/New_York",IPT:"America/New_York",LBE:"America/New_York",JST:"America/New_York",DUJ:"America/New_York",FKL:"America/New_York",
  AGC:"America/New_York",UNV:"America/New_York",CRY:"America/New_York",HZL:"America/New_York",SCE:"America/New_York",LHV:"America/New_York",
  RDG:"America/New_York",MUI:"America/New_York",ILG:"America/New_York",DOV:"America/New_York",GED:"America/New_York",BWI:"America/New_York",
  DCA:"America/New_York",IAD:"America/New_York",MTN:"America/New_York",ANP:"America/New_York",HGR:"America/New_York",FDK:"America/New_York",
  SBY:"America/New_York",ORF:"America/New_York",RIC:"America/New_York",ROA:"America/New_York",CHO:"America/New_York",LYH:"America/New_York",
  PHF:"America/New_York",SHD:"America/New_York",HSP:"America/New_York",DAA:"America/New_York",NGU:"America/New_York",CRW:"America/New_York",
  HTS:"America/New_York",BKW:"America/New_York",LWB:"America/New_York",PKB:"America/New_York",CKB:"America/New_York",HLG:"America/New_York",
  MGW:"America/New_York",ZZV:"America/New_York",BLF:"America/New_York",BVL:"America/New_York",LBR:"America/New_York",CLT:"America/New_York",
  RDU:"America/New_York",GSO:"America/New_York",AVL:"America/New_York",FAY:"America/New_York",ILM:"America/New_York",EWN:"America/New_York",
  OAJ:"America/New_York",PGV:"America/New_York",INT:"America/New_York",HKY:"America/New_York",ISO:"America/New_York",SOP:"America/New_York",
  RWI:"America/New_York",MRH:"America/New_York",PMZ:"America/New_York",CAE:"America/New_York",CHS:"America/New_York",GSP:"America/New_York",
  FLO:"America/New_York",MYR:"America/New_York",HXD:"America/New_York",MHC:"America/New_York",AND:"America/New_York",ATL:"America/New_York",
  SAV:"America/New_York",AGS:"America/New_York",MCN:"America/New_York",ABY:"America/New_York",VLD:"America/New_York",AHN:"America/New_York",
  LGC:"America/New_York",MGR:"America/New_York",RMG:"America/New_York",PIM:"America/New_York",GNV:"America/New_York",MIA:"America/New_York",
  FLL:"America/New_York",PBI:"America/New_York",MCO:"America/New_York",TPA:"America/New_York",PIE:"America/New_York",SRQ:"America/New_York",
  RSW:"America/New_York",EYW:"America/New_York",DAB:"America/New_York",MLB:"America/New_York",VRB:"America/New_York",TLH:"America/New_York",
  JAX:"America/New_York",OCF:"America/New_York",ORL:"America/New_York",APF:"America/New_York",FPR:"America/New_York",LAL:"America/New_York",
  LEE:"America/New_York",SFB:"America/New_York",SGJ:"America/New_York",OZR:"America/New_York",TYS:"America/New_York",CHA:"America/New_York",
  TRI:"America/New_York",SDF:"America/New_York",LEX:"America/New_York",OWB:"America/New_York",CVG:"America/New_York",HOP:"America/New_York",
  BWG:"America/New_York",CMH:"America/New_York",CLE:"America/New_York",DAY:"America/New_York",TOL:"America/New_York",YNG:"America/New_York",
  CAK:"America/New_York",MFD:"America/New_York",HIO:"America/New_York",LCK:"America/New_York",ESK:"America/New_York",EKN:"America/New_York",
  FFO:"America/New_York",
  // Michigan/Detroit
  DTW:"America/Detroit",GRR:"America/Detroit",LAN:"America/Detroit",FNT:"America/Detroit",MBS:"America/Detroit",TVC:"America/Detroit",
  MKG:"America/Detroit",AZO:"America/Detroit",BEH:"America/Detroit",BTL:"America/Detroit",MCD:"America/Detroit",STE:"America/Detroit",
  ANJ:"America/Detroit",
  // Indiana
  IND:"America/Indiana/Indianapolis",EVV:"America/Indiana/Indianapolis",FWA:"America/Indiana/Indianapolis",GUS:"America/Indiana/Indianapolis",LAF:"America/Indiana/Indianapolis",BMG:"America/Indiana/Indianapolis",
  MIE:"America/Indiana/Indianapolis",HUF:"America/Indiana/Indianapolis",MTO:"America/Indiana/Indianapolis",
  // Central
  CSG:"America/Chicago",PNS:"America/Chicago",VPS:"America/Chicago",ECP:"America/Chicago",CEW:"America/Chicago",BHM:"America/Chicago",
  HSV:"America/Chicago",MOB:"America/Chicago",MGM:"America/Chicago",DHN:"America/Chicago",ANB:"America/Chicago",JAN:"America/Chicago",
  GPT:"America/Chicago",MEI:"America/Chicago",GLH:"America/Chicago",GWO:"America/Chicago",PIB:"America/Chicago",HKS:"America/Chicago",
  TUP:"America/Chicago",BNA:"America/Chicago",MEM:"America/Chicago",MKL:"America/Chicago",NQA:"America/Chicago",MQY:"America/Chicago",
  CSV:"America/Chicago",PAH:"America/Chicago",PLN:"America/Chicago",APN:"America/Chicago",ESC:"America/Chicago",IMT:"America/Chicago",
  IWD:"America/Chicago",CMX:"America/Chicago",GLR:"America/Chicago",SBN:"America/Chicago",MKE:"America/Chicago",MSN:"America/Chicago",
  GRB:"America/Chicago",ATW:"America/Chicago",EAU:"America/Chicago",LSE:"America/Chicago",RHI:"America/Chicago",OSH:"America/Chicago",
  SBM:"America/Chicago",ORD:"America/Chicago",MDW:"America/Chicago",PIA:"America/Chicago",BMI:"America/Chicago",SPI:"America/Chicago",
  MLI:"America/Chicago",CMI:"America/Chicago",DEC:"America/Chicago",GBG:"America/Chicago",UIN:"America/Chicago",MDH:"America/Chicago",
  MSP:"America/Chicago",DLH:"America/Chicago",RST:"America/Chicago",HIB:"America/Chicago",INL:"America/Chicago",BJI:"America/Chicago",
  BRD:"America/Chicago",RWF:"America/Chicago",AXN:"America/Chicago",OWA:"America/Chicago",STC:"America/Chicago",AIT:"America/Chicago",
  TVF:"America/Chicago",GFK:"America/Chicago",DSM:"America/Chicago",CID:"America/Chicago",DBQ:"America/Chicago",SUX:"America/Chicago",
  ALO:"America/Chicago",IOW:"America/Chicago",MIW:"America/Chicago",MCW:"America/Chicago",EST:"America/Chicago",OTM:"America/Chicago",
  BRL:"America/Chicago",FOD:"America/Chicago",STL:"America/Chicago",MCI:"America/Chicago",SGF:"America/Chicago",JLN:"America/Chicago",
  COU:"America/Chicago",VIH:"America/Chicago",SUS:"America/Chicago",UOX:"America/Chicago",LIT:"America/Chicago",XNA:"America/Chicago",
  FSM:"America/Chicago",TXK:"America/Chicago",HOT:"America/Chicago",HRO:"America/Chicago",BYH:"America/Chicago",MSY:"America/Chicago",
  BTR:"America/Chicago",LFT:"America/Chicago",SHV:"America/Chicago",MLU:"America/Chicago",AEX:"America/Chicago",NEW:"America/Chicago",
  TUL:"America/Chicago",OKC:"America/Chicago",LAW:"America/Chicago",MLC:"America/Chicago",CSM:"America/Chicago",SWO:"America/Chicago",
  END:"America/Chicago",GAG:"America/Chicago",OKM:"America/Chicago",RKS:"America/Chicago",DAL:"America/Chicago",DFW:"America/Chicago",
  HOU:"America/Chicago",IAH:"America/Chicago",SAT:"America/Chicago",AUS:"America/Chicago",LBB:"America/Chicago",ABI:"America/Chicago",
  CRP:"America/Chicago",MAF:"America/Chicago",MFE:"America/Chicago",BRO:"America/Chicago",GGG:"America/Chicago",TYR:"America/Chicago",
  SJT:"America/Chicago",CLL:"America/Chicago",ACT:"America/Chicago",GRK:"America/Chicago",SPS:"America/Chicago",HRL:"America/Chicago",
  LRD:"America/Chicago",DRT:"America/Chicago",INK:"America/Chicago",AMA:"America/Chicago",ICT:"America/Chicago",TOP:"America/Chicago",
  HYS:"America/Chicago",DDC:"America/Chicago",IXD:"America/Chicago",EAR:"America/Chicago",SLN:"America/Chicago",FOE:"America/Chicago",
  OMA:"America/Chicago",LNK:"America/Chicago",GRI:"America/Chicago",OFK:"America/Chicago",AIA:"America/Chicago",ANW:"America/Chicago",
  FSD:"America/Chicago",PIR:"America/Chicago",ATY:"America/Chicago",HON:"America/Chicago",MBG:"America/Chicago",YKN:"America/Chicago",
  ABR:"America/Chicago",MHE:"America/Chicago",FAR:"America/Chicago",BIS:"America/Chicago",MOT:"America/Chicago",DVL:"America/Chicago",
  JMS:"America/Chicago",RDR:"America/Chicago",XWA:"America/Chicago",EFD:"America/Chicago",MQT:"America/Chicago",NPA:"America/Chicago",
  // Mountain
  MRF:"America/Denver",ELP:"America/Denver",LBL:"America/Denver",GCK:"America/Denver",LBF:"America/Denver",BFF:"America/Denver",
  MCK:"America/Denver",RAP:"America/Denver",DIK:"America/Denver",ISN:"America/Denver",BIL:"America/Denver",MSO:"America/Denver",
  GTF:"America/Denver",HLN:"America/Denver",GPI:"America/Denver",BZN:"America/Denver",FCA:"America/Denver",HVR:"America/Denver",
  GGW:"America/Denver",SDY:"America/Denver",OLF:"America/Denver",MLS:"America/Denver",BTM:"America/Denver",DLN:"America/Denver",
  LWT:"America/Denver",JAC:"America/Denver",COD:"America/Denver",CYS:"America/Denver",LAR:"America/Denver",CPR:"America/Denver",
  GCC:"America/Denver",WRL:"America/Denver",RIW:"America/Denver",EKI:"America/Denver",DEN:"America/Denver",COS:"America/Denver",
  GJT:"America/Denver",DRO:"America/Denver",ASE:"America/Denver",EGE:"America/Denver",GUC:"America/Denver",MTJ:"America/Denver",
  PUB:"America/Denver",HDN:"America/Denver",ALS:"America/Denver",LAA:"America/Denver",LIC:"America/Denver",FCS:"America/Denver",
  ABQ:"America/Denver",SAF:"America/Denver",ROW:"America/Denver",FMN:"America/Denver",CVN:"America/Denver",LAM:"America/Denver",
  HOB:"America/Denver",CRQ:"America/Denver",SLC:"America/Denver",CDC:"America/Denver",CNY:"America/Denver",PVU:"America/Denver",
  OGD:"America/Denver",VEL:"America/Denver",SBO:"America/Denver",SGU:"America/Denver",BTF:"America/Denver",BOI:"America/Denver",
  TWF:"America/Denver",IDA:"America/Denver",PIH:"America/Denver",SUN:"America/Denver",COE:"America/Denver",MYL:"America/Denver",
  SMN:"America/Denver",BYI:"America/Denver",ONO:"America/Denver",LGD:"America/Denver",CEZ:"America/Denver",
  // Arizona (no DST)
  PHX:"America/Phoenix",TUS:"America/Phoenix",FLG:"America/Phoenix",YUM:"America/Phoenix",GCN:"America/Phoenix",PRC:"America/Phoenix",
  IFP:"America/Phoenix",AVW:"America/Phoenix",CHD:"America/Phoenix",DVT:"America/Phoenix",GEU:"America/Phoenix",MZJ:"America/Phoenix",
  RYN:"America/Phoenix",
  // Pacific
  LAS:"America/Los_Angeles",RNO:"America/Los_Angeles",ELY:"America/Los_Angeles",LSV:"America/Los_Angeles",EKO:"America/Los_Angeles",VGT:"America/Los_Angeles",
  LWS:"America/Los_Angeles",PDX:"America/Los_Angeles",EUG:"America/Los_Angeles",MFR:"America/Los_Angeles",RDM:"America/Los_Angeles",OTH:"America/Los_Angeles",
  SLE:"America/Los_Angeles",RBG:"America/Los_Angeles",AST:"America/Los_Angeles",LKV:"America/Los_Angeles",SEA:"America/Los_Angeles",GEG:"America/Los_Angeles",
  YKM:"America/Los_Angeles",ALW:"America/Los_Angeles",PSC:"America/Los_Angeles",BLI:"America/Los_Angeles",PWT:"America/Los_Angeles",CLM:"America/Los_Angeles",
  OLM:"America/Los_Angeles",EAT:"America/Los_Angeles",MWH:"America/Los_Angeles",FHR:"America/Los_Angeles",SKA:"America/Los_Angeles",NUW:"America/Los_Angeles",
  LAX:"America/Los_Angeles",SFO:"America/Los_Angeles",OAK:"America/Los_Angeles",SJC:"America/Los_Angeles",SMF:"America/Los_Angeles",BUR:"America/Los_Angeles",
  ONT:"America/Los_Angeles",LGB:"America/Los_Angeles",SNA:"America/Los_Angeles",PSP:"America/Los_Angeles",SBA:"America/Los_Angeles",FAT:"America/Los_Angeles",
  RDD:"America/Los_Angeles",ACV:"America/Los_Angeles",MRY:"America/Los_Angeles",SBP:"America/Los_Angeles",CIC:"America/Los_Angeles",BFL:"America/Los_Angeles",
  MOD:"America/Los_Angeles",STS:"America/Los_Angeles",SMX:"America/Los_Angeles",WVI:"America/Los_Angeles",PMD:"America/Los_Angeles",NZJ:"America/Los_Angeles",
  SAN:"America/Los_Angeles",SZP:"America/Los_Angeles",PDT:"America/Los_Angeles",
  // Alaska
  ANC:"America/Anchorage",FAI:"America/Anchorage",JNU:"America/Anchorage",KTN:"America/Anchorage",SIT:"America/Anchorage",WRG:"America/Anchorage",
  OME:"America/Anchorage",BET:"America/Anchorage",ADQ:"America/Anchorage",DUT:"America/Anchorage",OTZ:"America/Anchorage",ANI:"America/Anchorage",
  GAL:"America/Anchorage",CDV:"America/Anchorage",CDB:"America/Anchorage",YAK:"America/Anchorage",HNS:"America/Anchorage",DLG:"America/Anchorage",
  AKN:"America/Anchorage",AIK:"America/Anchorage",
  // Hawaii
  HNL:"Pacific/Honolulu",OGG:"Pacific/Honolulu",KOA:"Pacific/Honolulu",LIH:"Pacific/Honolulu",ITO:"Pacific/Honolulu",MKK:"Pacific/Honolulu",
  LNY:"Pacific/Honolulu",JHM:"Pacific/Honolulu",
  // Canada Eastern
  YYZ:"America/Toronto",YTZ:"America/Toronto",YKF:"America/Toronto",YHM:"America/Toronto",YOO:"America/Toronto",YQT:"America/Toronto",
  YUL:"America/Toronto",YOW:"America/Toronto",YQB:"America/Toronto",YVQ:"America/Toronto",YZR:"America/Toronto",YXU:"America/Toronto",
  YFB:"America/Toronto",YGK:"America/Toronto",YSB:"America/Toronto",
  // Canada Atlantic
  YHZ:"America/Halifax",YYG:"America/Halifax",YQM:"America/Halifax",YSJ:"America/Halifax",YQY:"America/Halifax",YAY:"America/Halifax",
  YDF:"America/Halifax",YFC:"America/Halifax",YQI:"America/Halifax",
  // Canada Central
  YWG:"America/Winnipeg",YQR:"America/Winnipeg",YBR:"America/Winnipeg",YQL:"America/Winnipeg",YMJ:"America/Winnipeg",YPA:"America/Winnipeg",
  // Canada Mountain
  YYC:"America/Edmonton",YEG:"America/Edmonton",YQF:"America/Edmonton",YXH:"America/Edmonton",YMM:"America/Edmonton",
  // Canada Pacific
  YLW:"America/Vancouver",YVR:"America/Vancouver",YYJ:"America/Vancouver",YXS:"America/Vancouver",YXT:"America/Vancouver",YPR:"America/Vancouver",
  YZT:"America/Vancouver",
  // Mexico Central
  MEX:"America/Mexico_City",GDL:"America/Mexico_City",BJX:"America/Mexico_City",AGU:"America/Mexico_City",ACA:"America/Mexico_City",ZIH:"America/Mexico_City",
  OAX:"America/Mexico_City",VSA:"America/Mexico_City",VER:"America/Mexico_City",TAP:"America/Mexico_City",
  // Mexico Eastern (no DST)
  CUN:"America/Cancun",CZM:"America/Cancun",CBM:"America/Cancun",
  // Mexico Monterrey
  MTY:"America/Monterrey",
  // Mexico Mountain
  SJD:"America/Mazatlan",CUL:"America/Mazatlan",MZT:"America/Mazatlan",PVR:"America/Mazatlan",ZLO:"America/Mazatlan",TPQ:"America/Mazatlan",
  // Mexico Pacific
  TIJ:"America/Tijuana",MXL:"America/Tijuana",
  // Mexico Sonora (no DST)
  HMO:"America/Hermosillo",GYM:"America/Hermosillo",CEN:"America/Hermosillo",
  // Mexico Merida
  MID:"America/Merida",
};

function getAirportUtcOffsetMins(airportCode, refDate) {
  const tz = AIRPORT_TZ[airportCode];
  if(!tz) {
    // Unknown airport -- estimate from longitude using US timezone boundaries
    // Longitude ranges (approximate): ET>-67, CT>-87, MT>-104, PT>-125, AK>-141
    const coords = AIRPORT_COORDS[airportCode];
    if(coords) {
      const lon = coords[1];
      const lat = coords[0];
      let estimatedTz;
      if(lat > 40 && lon > -52) {
        // Canadian Atlantic (Newfoundland/Maritimes)
        estimatedTz = "America/Halifax";
      } else if(lon > -87)       estimatedTz = "America/New_York";
      else if(lon > -104)        estimatedTz = "America/Chicago";
      else if(lon > -115)        estimatedTz = "America/Denver";
      else if(lon > -125)        estimatedTz = "America/Los_Angeles";
      else                       estimatedTz = "America/Anchorage";
      return getOffsetFromTz(estimatedTz, refDate);
    }
    return 0;
  }
  return getOffsetFromTz(tz, refDate);
}

// BUG THAT WAS HERE (critical): this used to default to `new Date()` --
// i.e. the moment the code happens to run, in REAL wall-clock time --
// completely ignoring which date the flight itself occurred on. That meant
// the DST state used for every offset calculation was today's DST state,
// not the flight's. Since DST changes the UTC offset by a full hour, this
// silently corrupted night-time math (and any other UTC conversion) for
// every flight whose date falls on the opposite side of a DST boundary
// from today -- which, depending on when you happen to open the app, can
// be most flights in the roster. Fixed: always pass the flight's own date
// in, so the correct historical/future DST state is used for that specific
// date, not today's.
function getOffsetFromTz(tz, refDate) {
  try {
    // refDate may be a Date object or a "YYYY-MM-DD" string. Default to
    // noon UTC on that date (not "now") so DST is evaluated correctly for
    // the actual flight date, not whatever day it happens to be when this
    // function runs.
    let dateObj;
    if(refDate instanceof Date) dateObj = refDate;
    else if(typeof refDate === "string" && refDate) dateObj = new Date(refDate+"T12:00:00Z");
    else dateObj = new Date(); // fallback only when no date is available at all

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false,
    });
    const parts = fmt.formatToParts(dateObj);
    let h = parseInt(parts.find(p=>p.type==="hour")?.value||"0");
    const m = parseInt(parts.find(p=>p.type==="minute")?.value||"0");
    if(h===24) h=0;
    const uh=dateObj.getUTCHours(), um=dateObj.getUTCMinutes();
    let off=(h*60+m)-(uh*60+um);
    if(off>720) off-=1440;
    if(off<-720) off+=1440;
    return off;
  } catch { return 0; }
}

function schedMinsFromAirports(depTime, arrTime, depCode, arrCode) {
  if(!depTime || !arrTime) return null;
  const [dh, dm] = depTime.split(":").map(Number);
  const [ah, am] = arrTime.split(":").map(Number);
  if(isNaN(dh)||isNaN(dm)||isNaN(ah)||isNaN(am)) return null;

  const depOff = getAirportUtcOffsetMins(depCode);
  const arrOff = getAirportUtcOffsetMins(arrCode);

  // Convert local times to UTC then subtract
  const depUtc = (dh * 60 + dm) - depOff;
  const arrUtc = (ah * 60 + am) - arrOff;
  let block = arrUtc - depUtc;
  if(block < 0) block += 1440;
  if(block >= 15 && block <= 600) return block;
  return null;
}
const schedMins = (f, tailEntry=null) => {
  // Priority 1: FlightAware confirmed scheduled block (set when flight is synced)
  if(tailEntry?.schedBlockMins!=null) return tailEntry.schedBlockMins;
  // Priority 2: Parser-extracted block time from roster
  if(f.schedBlockMins!=null) return f.schedBlockMins;
  // Priority 3: Naive local time subtraction (may be off by 1hr for cross-tz flights)
  return schedMinsFromAirports(f.depTime, f.arrTime, f.dep, f.arr);
};
const schedMinsIsEstimate = (f) => f.schedBlockMins==null;
const rosterMins = r => r?.calendar?.reduce((a,d)=>a+d.flights.reduce((b,f)=>b+(schedMins(f)??0),0),0)??0;

// "Best available" duration for a flight: prefer the actual (synced, post-flight)
// block time when we have it -- it's the real figure. Fall back to scheduled time
// for flights that haven't happened yet (or haven't synced), since that's the
// best estimate available until the real data arrives.
const bestMins = (f, tailEntry) => tailEntry?.cancelled ? 0 : (tailEntry?.actualBlockMins!=null ? tailEntry.actualBlockMins : (schedMins(f)??0));
const bestMinsIsActual = (tailEntry) => tailEntry?.actualBlockMins!=null;

// Total minutes across all rosters using best-available duration per flight
// (actual where synced, scheduled otherwise) -- this is what the Dashboard's
// "Total flight time" stat should show, since it reflects real flown hours
// wherever possible rather than always showing the original plan.
function totalMinsBest(rosters, tails) {
  let total = 0;
  (rosters||[]).forEach(r => {
    (r.calendar||[]).forEach((d, di) => {
      d.flights.forEach((f, fi) => {
        const tk = `${r.id}-${di}-${fi}`;
        total += bestMins(f, tails?.[tk]);
      });
    });
  });
  return total;
}

const allFlights = rs => (rs||[]).flatMap(r=>(r.calendar||[]).flatMap(d=>d.flights.map(f=>({...f,date:d.day,dow:d.dow,period:r.periodLabel,rosterId:r.id}))));
const initials = name => name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase()||"?";

function downloadCsv(filename, csvStr) {
  const blob = new Blob([csvStr], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvExport(rosters, tails) {
  const rows=[["Date","Day","Flight","Dep","SchedDep","ActualDep","Arr","SchedArr","ActualArr","AircraftType","Tail","SchedBlock","ActualBlock","Night","CrossCountry","MultiEng","Period","Deadhead","Remarks"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const isDH=!!f.isDeadhead;
    // Deadhead legs are listed for record-keeping but logged with zero block time
    const actualBlock=isDH?"":(t.actualBlockMins!=null?fmtMins(t.actualBlockMins):"");
    const schedMinsVal=isDH?null:schedMins(f);
    const schedBlock=schedMinsVal!=null?fmtMins(schedMinsVal):"";
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    const nightStr=f.loggedNightMins!=null?fmtMins(f.loggedNightMins):"";
    const xcStr=f.loggedXcMins!=null?fmtMins(f.loggedXcMins):"";
    const multiEngStr=f.loggedMultiEngMins!=null?fmtMins(f.loggedMultiEngMins):"";
    rows.push([dateStr,d.dow,f.flightNum,f.dep,f.depTime,t.actualDep||"",f.arr,f.arrTime,t.actualArr||"",f.acType||"",t.tail||"",schedBlock,actualBlock,nightStr,xcStr,multiEngStr,r.periodLabel||"",isDH?"DH":"",t.remarks||""]);
  })));
  downloadCsv("aviatesync-export.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
}

function jeppesenExport(rosters, tails) {
  // Jeppesen Professional Pilot Logbook column order
  const rows=[["Date","Flight No","From","To","Departure Time","Arrival Time","Aircraft Make & Model","Aircraft Ident","Total Duration of Flight","Night","Actual Instrument","Simulated Instrument","Cross Country","Multi-Engine","Dual Received","Pilot in Command","Solo","Ground Trainer","Remarks and Endorsements"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    const isDH=!!f.isDeadhead;
    // Deadhead: zero flight time, noted in remarks per standard logbook convention
    const block=isDH?"":(t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"");
    const remarks=isDH?`DEADHEAD${t.remarks?" -- "+t.remarks:""}`:(t.remarks||"");
    const nightStr=isDH?"":(f.loggedNightMins!=null?fmtMins(f.loggedNightMins):"");
    const actualIfrStr=isDH?"":(f.loggedActualIfrMins!=null?fmtMins(f.loggedActualIfrMins):"");
    const simIfrStr=isDH?"":(f.loggedSimIfrMins!=null?fmtMins(f.loggedSimIfrMins):"");
    const xcStr=isDH?"":(f.loggedXcMins!=null?fmtMins(f.loggedXcMins):"");
    const multiEngStr=isDH?"":(f.loggedMultiEngMins!=null?fmtMins(f.loggedMultiEngMins):"");
    const picStr=isDH?"":(f.loggedPicMins!=null&&f.loggedPicMins>0?block:"");
    rows.push([dateStr,f.flightNum,f.dep,f.arr,t.actualDep||f.depTime,t.actualArr||f.arrTime,f.acType||"","N/"+  (t.tail||""),isDH?"":block,nightStr,actualIfrStr,simIfrStr,xcStr,multiEngStr,isDH?"":block,picStr,"","",remarks]);
  })));
  downloadCsv("aviatesync-jeppesen.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
}

function asaExport(rosters, tails) {
  // ASA Standard Pilot Logbook columns
  const rows=[["Date","Aircraft Make/Model","Aircraft Ident","Route From","Route To","Total Flight Time","Night","Actual IMC","Simulated IMC","Cross-Country","Multi-Engine","Dual","PIC","Solo","Approaches","Remarks"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    const isDH=!!f.isDeadhead;
    const block=isDH?"":(t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"");
    const remarks=isDH?`DEADHEAD${t.remarks?" -- "+t.remarks:""}`:(t.remarks||"");
    const nightStr=isDH?"":(f.loggedNightMins!=null?fmtMins(f.loggedNightMins):"");
    const actualIfrStr=isDH?"":(f.loggedActualIfrMins!=null?fmtMins(f.loggedActualIfrMins):"");
    const simIfrStr=isDH?"":(f.loggedSimIfrMins!=null?fmtMins(f.loggedSimIfrMins):"");
    const xcStr=isDH?"":(f.loggedXcMins!=null?fmtMins(f.loggedXcMins):"");
    const multiEngStr=isDH?"":(f.loggedMultiEngMins!=null?fmtMins(f.loggedMultiEngMins):"");
    const picStr=isDH?"":(f.loggedPicMins!=null&&f.loggedPicMins>0?block:"");
    const approachesStr=f.loggedApproaches>0?String(f.loggedApproaches):"";
    rows.push([dateStr,f.acType||"","N/"+(t.tail||""),f.dep,f.arr,block,nightStr,actualIfrStr,simIfrStr,xcStr,multiEngStr,"",picStr,"",approachesStr,remarks]);
  })));
  downloadCsv("aviatesync-asa.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
}

// -- PDF to BASE64
// Instead of extracting text positionally (which scrambles complex roster
// grids/tables), we send the raw PDF bytes to Claude, which reads the
// document visually -- far more reliable for dense calendar-style layouts.
async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// -- AI ROSTER PARSER (native PDF)
// Sends the PDF directly to our Supabase Edge Function, which forwards it
// to Claude as a document for visual extraction.
async function aiParseRosterPdf(base64Pdf) {
  if (!SUPA_URL || !SUPA_ANON) {
    throw new Error("Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }
  const res = await fetch(`${SUPA_URL}/functions/v1/parse-roster`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPA_ANON}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify({ pdfBase64: base64Pdf }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Parse failed (${res.status})`);
  }
  return data;
}

// -- AERODATA LOOKUP
// Goes through our Edge Function, which holds the shared FlightAware key
// server-side. No pilot needs to provide their own key anymore.
// Client-side rate limit for manual Auto Sync clicks.
// Stored in localStorage -- resets at midnight. Prevents pilots from
// hammering FlightAware and running up API costs.
const AUTO_SYNC_DAILY_LIMIT = 10;

function getAutoSyncCount(userId) {
  try {
    const today = new Date().toISOString().slice(0,10);
    const raw = localStorage.getItem(`fl_autosync_${userId}_${today}`);
    return raw ? parseInt(raw) : 0;
  } catch { return 0; }
}

function incrementAutoSyncCount(userId) {
  try {
    const today = new Date().toISOString().slice(0,10);
    const key = `fl_autosync_${userId}_${today}`;
    const count = getAutoSyncCount(userId) + 1;
    localStorage.setItem(key, String(count));
    // Clean up yesterday's key
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    localStorage.removeItem(`fl_autosync_${userId}_${yesterday}`);
    return count;
  } catch { return 0; }
}

function checkAutoSyncLimit(userId) {
  const count = getAutoSyncCount(userId);
  const remaining = AUTO_SYNC_DAILY_LIMIT - count;
  return { allowed: remaining > 0, count, remaining };
}

async function lookupFlight(flightNum, date, depTime, dep="", arr="", forceRefresh=false) {
  const r = await fetch(`${SUPA_URL}/functions/v1/lookup-flight`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sb.auth._token || SUPA_ANON}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify({ flightNum, date, depTime, dep, arr, forceRefresh }),
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error || `Lookup failed (${r.status})`);
  return data;
}

// -- SUPABASE DATA LAYER
// All DB calls go through these functions.
// When SUPA_URL is set, they hit real Supabase.
// When empty (artifact preview), they fall back to sessionStorage.

const isConfigured = () => Boolean(SUPA_URL && SUPA_ANON && SUPA_URL !== "https://YOUR_PROJECT.supabase.co");

const local = {
  get: k => { try{ const v=sessionStorage.getItem(k); return v?JSON.parse(v):null; }catch{return null;} },
  set: (k,v) => { try{ sessionStorage.setItem(k,JSON.stringify(v)); }catch{} },
};

async function db_signUp(email, password, name, plan) {
  if(isConfigured()) {
    // plan is intentionally NOT forwarded here. It used to flow straight
    // into auth signup metadata -> handle_new_user() trigger -> profiles.plan,
    // meaning every signup could claim any plan value with zero payment
    // verification. The database default ('starter') and the Stripe webhook
    // (supabase-functions/stripe-webhook) are now the only legitimate writers
    // of a paid plan/subscription_status -- both fire only on real Stripe
    // events, never at account creation.
    //
    // Airline IATA/name are no longer collected at signup -- a pilot can
    // add them later from their own Profile page if they want to. That
    // separate field/flow is untouched; this function just stopped asking
    // for it here.
    const {data,error} = await sb.auth.signUp({email,password,options:{data:{name}}});
    if(error) { console.error("Signup error:", error); throw new Error(error.message||"Sign up failed"); }
    return data.user;
  }
  // local fallback (demo/offline mode only -- not tied to real payment)
  const users = local.get("fl_users")||[];
  if(users.find(u=>u.email===email)) throw new Error("Email already registered.");
  const user = {id:"u"+Date.now(),email,name,plan:"starter",role:"pilot",joined:new Date().toISOString().slice(0,10),active:true};
  users.push({...user,password});
  local.set("fl_users",users);
  local.set("fl_session",user);
  return user;
}

// Password reset (this app hand-rolls auth via fetch, not the Supabase JS
// SDK — see db_signIn below for the same pattern). Two-step Supabase GoTrue
// flow: request sends the pilot an email containing a recovery link; that
// link lands them back here with a token in the URL hash, which
// db_confirmPasswordReset exchanges for a new password via the recovery
// session it establishes.
async function db_requestPasswordReset(email) {
  const res = await fetch(`${SUPA_URL}/auth/v1/recover`, {
    method: "POST",
    headers: { "apikey": SUPA_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, options: { redirectTo: `${window.location.origin}/?type=recovery` } }),
  });
  if(!res.ok) {
    const d = await res.json().catch(()=>({}));
    throw new Error(d.error_description || d.msg || "Could not send reset email.");
  }
}

async function db_confirmPasswordReset(accessToken, newPassword) {
  const res = await fetch(`${SUPA_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      "apikey": SUPA_ANON,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: newPassword }),
  });
  if(!res.ok) {
    const d = await res.json().catch(()=>({}));
    throw new Error(d.error_description || d.msg || "Could not update password. The reset link may have expired.");
  }
  return res.json();
}

async function db_signIn(email, password) {
  if(isConfigured()) {
    const {data,error} = await sb.auth.signInWithPassword({email,password});
    if(error) throw new Error("Invalid email or password.");
    const profile = await fetchProfile(data.user.id, data.session?.access_token);
    return {...data.user, ...profile};
  }
  const users = local.get("fl_users")||[
    {id:"u1",email:"admin@flightlog.app",password:"admin1234",name:"Admin",role:"admin",plan:"admin",joined:"2026-01-01",active:true},
    {id:"u2",email:"pilot@example.com",password:"pilot123",name:"Mohammed Al Obaidi",role:"pilot",plan:"pro",joined:"2026-05-10",active:true},
  ];
  const user = users.find(u=>u.email===email&&u.password===password);
  if(!user) throw new Error("Invalid email or password.");
  if(!user.active) throw new Error("Account suspended.");
  local.set("fl_users",users);
  local.set("fl_session",user);
  return user;
}

async function fetchProfile(userId, accessToken) {
  try {
    if(!sb.auth._token && !accessToken) {
      try { const t = localStorage.getItem("fl_token"); if(t) sb.auth._token = t; } catch {}
    }
    if(accessToken) sb.auth._token = accessToken;

    // Use security definer RPC -- bypasses RLS entirely
    const res = await fetch(`${SUPA_URL}/rest/v1/rpc/get_my_profile`, {
      method: "POST",
      headers: {
        "apikey": SUPA_ANON,
        "Authorization": `Bearer ${sb.auth._token || SUPA_ANON}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid: userId }),
    });
    if(!res.ok) {
      // Fallback: try direct table read
      const { data } = await sb.from("profiles").select("*").eq("id", userId);
      return data?.[0] || {};
    }
    const profile = await res.json();
    return profile || {};
  } catch(e) {
    console.error("fetchProfile error:", e.message);
    return {};
  }
}

async function db_signOut() {
  if(isConfigured()) await sb.auth.signOut();
  local.set("fl_session",null);
}

async function db_getSession() {
  if(isConfigured()) {
    try {
      // Timeout after 5 seconds -- prevents infinite loading screen
      const timeout = new Promise((_,reject)=>setTimeout(()=>reject(new Error("timeout")),5000));
      const {data:{user}} = await Promise.race([sb.auth.getUser(), timeout.catch(()=>({data:{user:null}}))]);
      if(!user) return null;
      const profile = await fetchProfile(user.id);
      return {...user, ...profile};
    } catch {
      return null;
    }
  }
  return local.get("fl_session");
}

async function db_loadRosters(userId) {
  if(isConfigured()) {
    const {data} = await sb.from("rosters").select("*").eq("user_id", userId);
    return (data||[])
      .map(r=>({id:r.id,periodLabel:r.period_label,year:r.year,monthNum:r.month_num,calendar:r.calendar,uploadedAt:r.uploaded_at}))
      .sort((a,b)=> (b.year*100+b.monthNum) - (a.year*100+a.monthNum));
  }
  return local.get("fl_rosters_"+userId)||[];
}

// Authenticated fetch for raw REST calls that bypass sb.from's builder.
// Pre-refreshes when the JWT is about to expire and retries once on 401 —
// a pilot can sit on the verification screen far longer than a token's
// lifetime, and "Confirm & Save" must never fail with "JWT expired".
async function sbFetch(url, opts={}) {
  const expiringSoon = () => {
    try {
      const t = sb.auth._token;
      if(!t) return false;
      const { exp } = JSON.parse(atob(t.split(".")[1]));
      return exp*1000 - Date.now() < 60000;
    } catch { return false; }
  };
  const hasRefresh = sb.auth._refreshToken || (typeof localStorage!=="undefined" && localStorage.getItem("fl_refresh_token"));
  if(expiringSoon() && hasRefresh) await sb.auth.refreshSession();
  const build = () => ({
    ...opts,
    headers: { "apikey":SUPA_ANON, "Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`, ...(opts.headers||{}) },
  });
  let r = await fetch(url, build());
  if(r.status === 401 && hasRefresh) {
    const refreshed = await sb.auth.refreshSession();
    if(refreshed.data) r = await fetch(url, build());
  }
  return r;
}

async function db_saveRoster(userId, roster, opts={}) {
  const skipMergeProtection = !!opts.skipMergeProtection;
  if(isConfigured()) {

    const daysInMonth = new Date(roster.year, roster.monthNum+1, 0).getDate();
    const cal = roster.calendar || [];

    // -- Step 1: Separate this month's days from carry-forward days
    // carryForwardDays comes directly from the AI parser (nextMonthDays field)
    // These are next-month days (e.g. March 1-2 at end of February roster)
    const explicitCarry = Array.isArray(roster.carryForwardDays) ? roster.carryForwardDays : [];

    // Filter this month's calendar to only valid days (1 to daysInMonth)
    // If explicit carry days exist, remove any calendar entries that match them
    // by day number AND have the same flight count (disambiguates Feb day 1 vs Mar day 1)
    const carryDayNums = new Set(explicitCarry.map((d) => d.day));
    const thisDays = cal.filter((d) => {
      if(typeof d.day !== "number" || d.day < 1 || d.day > daysInMonth) return false;
      if(!carryDayNums.has(d.day)) return true;
      // Same day number exists in carry -- keep it only if it has DIFFERENT flights
      // (meaning it's the real this-month day, not the carry-forward duplicate)
      const carry = explicitCarry.find((c) => c.day === d.day);
      const thisFlightNums = (d.flights||[]).map((f)=>f.flightNum).join(",");
      const carryFlightNums = (carry?.flights||[]).map((f)=>f.flightNum).join(",");
      return thisFlightNums !== carryFlightNums;
    });

    // Auto-detect carry days if not explicitly provided (pattern: day resets after 20+)
    let carryForwardDays = explicitCarry;
    if(carryForwardDays.length === 0) {
      // Find reset point in raw calendar
      for(let i = 1; i < cal.length; i++) {
        if(cal[i]?.day < cal[i-1]?.day && cal[i]?.day <= 7 && cal[i-1]?.day >= 20) {
          carryForwardDays = cal.slice(i).filter((d) => d.day >= 1 && d.day <= 7);
          break;
        }
      }
      // Also check for days numbered beyond month end (e.g. day:29 in Feb=28 days)
      const highDays = cal.filter((d) => d.day > daysInMonth).map((d) => ({...d, day: d.day - daysInMonth}));
      if(highDays.length > 0) carryForwardDays = [...carryForwardDays, ...highDays];
    }

    // -- Step 2: Route carry-forward days to next month's roster
    if(carryForwardDays.length > 0) {
      const nextMonth = roster.monthNum === 11 ? 0 : roster.monthNum + 1;
      const nextYear  = roster.monthNum === 11 ? roster.year + 1 : roster.year;
      const nextDaysInMonth = new Date(nextYear, nextMonth+1, 0).getDate();
      const validCarry = carryForwardDays.filter((d) => d.day >= 1 && d.day <= nextDaysInMonth);

      if(validCarry.length > 0) {
        const cfRes = await sbFetch(
          `${SUPA_URL}/rest/v1/rosters?select=id,calendar&user_id=eq.${userId}&year=eq.${nextYear}&month_num=eq.${nextMonth}`
        );
        const cfData = await cfRes.json();
        const nextRoster = Array.isArray(cfData) && cfData.length > 0 ? cfData[0] : null;

        if(nextRoster?.id) {
          const existingCal = Array.isArray(nextRoster.calendar) ? nextRoster.calendar : [];
          // Per-day RICHNESS compare: whichever version carries more
          // information wins. Score = flight count (dominant) + populated
          // per-flight fields + dutyCode. This protects an already-uploaded
          // full month from being downgraded by a thin carry stub, while
          // letting a richer carryover (e.g. July's relocated midnight leg)
          // upgrade a thinner existing day.
          const rich = (d) => {
            if(!d) return -1;
            const fl = Array.isArray(d.flights) ? d.flights : [];
            let s = fl.length * 1000 + (d.dutyCode ? 1 : 0);
            for(const f of fl) s += (f.acType?1:0)+(f.schedBlockMins!=null?1:0)+(f.depTime?1:0)+(f.arrTime?1:0)+(f.flightNum?1:0)+(f.tail?1:0);
            return s;
          };
          const existingByDayC = {};
          existingCal.forEach((d) => { existingByDayC[d.day] = d; });
          const daysToAdd = validCarry.filter((d) => rich(d) > rich(existingByDayC[d.day] ?? null));
          if(daysToAdd.length > 0) {
            // Remove the existing versions being replaced by richer carry data
            const daysToAddNums = new Set(daysToAdd.map((d) => d.day));
            const filteredExisting = existingCal.filter((d) => !daysToAddNums.has(d.day));
            const merged = [...filteredExisting, ...daysToAdd].sort((a,b)=>a.day-b.day);
            await sbFetch(
              `${SUPA_URL}/rest/v1/rosters?id=eq.${nextRoster.id}`,
              {method:"PATCH", headers:{"Content-Type":"application/json","Prefer":"return=minimal"},
               body:JSON.stringify({calendar:merged})}
            );
          }
        } else {
          // Create stub roster for next month
          const nextMonthLabel = new Date(nextYear, nextMonth, 1)
            .toLocaleString("default",{month:"long",year:"numeric"});
          await sb.from("rosters").insert({
            user_id: userId,
            period_label: nextMonthLabel,
            year: nextYear,
            month_num: nextMonth,
            calendar: validCarry,
          });
        }
      }
    }

    // -- Step 3: Save this month's roster
    // Use direct fetch to bypass any custom client issues with chained .eq() calls
    const restBase = `${SUPA_URL}/rest/v1/rosters`;
    const lookupRes = await sbFetch(
      `${restBase}?select=id,calendar&user_id=eq.${userId}&year=eq.${roster.year}&month_num=eq.${roster.monthNum}`
    );
    const lookupData = await lookupRes.json();
    const existing = Array.isArray(lookupData) && lookupData.length > 0 ? lookupData[0] : null;

    if(existing?.id) {
      const existingCal = Array.isArray(existing.calendar) ? existing.calendar : [];
      const newDayNums = new Set(thisDays.map((d) => d.day));

      // Preserve existing days not touched by this save -- this always
      // applies regardless of skipMergeProtection, since it's not a
      // "protection rule" second-guessing intent, it's just correctly not
      // clobbering days this save never mentioned at all.
      const preservedDays = existingCal.filter((d) => !newDayNums.has(d.day));

      const existingByDay = {};
      existingCal.forEach((d) => { existingByDay[d.day] = d; });

      const resolvedNewDays = thisDays.map((d) => {
        // Intentional direct edits (delete flight, edit field, add flight,
        // sign & lock) bypass these rules entirely and write exactly what
        // was given for this day. The rules below exist to protect a fresh
        // ROSTER UPLOAD from silently destroying carryover/actual data it
        // doesn't know about -- they were never meant to override a
        // pilot's own deliberate edit to this exact day, which is what was
        // actually happening: deleting a flight left the day empty, this
        // block saw "existing has flights, new day is empty" and
        // concluded the delete must have been a mistake, silently
        // restoring the deleted flight on the next save/reload.
        if(skipMergeProtection) return d;

        const existingDay = existingByDay[d.day];
        if (!existingDay) return d;

        const newFlights = d.flights?.length || 0;
        const existingFlights = existingDay.flights?.length || 0;

        // Rule 1: new upload says off but existing has flights → keep existing
        // (carryover +1 midnight flight protection)
        if ((d.isOff || newFlights === 0) && existingFlights > 0) {
          return existingDay;
        }

        // Rule 2: both have flights but existing has MORE flights → keep existing
        // This handles the case where a carryover day has a midnight +1 flight
        // AND a next-month flight on day 1, while the new upload only sees day 1's
        // scheduled flight and overwrites the carryover data.
        if (newFlights > 0 && existingFlights > newFlights) {
          return existingDay;
        }

        // Rule 3: same flight count but existing has tail/actual data → keep existing
        // (don't overwrite synced actuals with new scheduled data)
        if (newFlights > 0 && existingFlights === newFlights && existingDay.flights?.some((f) => f.acType || f.schedBlockMins)) {
          const newHasData = d.flights?.some((f) => f.acType || f.schedBlockMins);
          if (!newHasData) return existingDay;
        }

        return d;
      });

      const mergedCal = [...resolvedNewDays, ...preservedDays].sort((a,b)=>a.day-b.day);
      const updateRes = await sbFetch(
        `${restBase}?id=eq.${existing.id}`,
        {method:"PATCH", headers:{"Content-Type":"application/json","Prefer":"return=representation"}, body:JSON.stringify({period_label:roster.periodLabel, calendar:mergedCal})}
      );
      if(!updateRes.ok) {
        const err = await updateRes.text();
        throw new Error("Failed to update roster: " + err);
      }
      return {...roster, id:existing.id, calendar:mergedCal};
    }

    // Insert new roster
    const {data,error} = await sb.from("rosters")
      .insert({user_id:userId, period_label:roster.periodLabel, year:roster.year, month_num:roster.monthNum, calendar:thisDays})
      .select()
      .single();
    if(error) throw new Error(error.message||"Failed to save roster");
    return {...roster, id:data?.id||roster.id};
  }

  // -- Local storage fallback
  const list = local.get("fl_rosters_"+userId)||[];
  const existingIdx = list.findIndex(r=>r.year===roster.year&&r.monthNum===roster.monthNum);
  if(existingIdx>=0) list[existingIdx]={...roster, id:list[existingIdx].id};
  else list.unshift(roster);
  local.set("fl_rosters_"+userId, list);
  return roster;
}

// Persists edits (Pilot Function, logged night/XC/IFR time, landings,
// approaches, remarks) onto one specific flight inside a roster's calendar.
// Shared by every place FlightDetailPage can be reached from (Dashboard,
// Logbook hub's Daily View / Permanent Logbook, and the Active Logs
// drill-down), so the same "Flight Details" section works identically
// everywhere. Returns the updated calendar array so the caller can push it
// into whatever local state it's tracking.
async function saveFlightFieldsToRoster(userId, roster, di, fi, fields) {
  const nc = [...(roster.calendar||[])];
  const dayEntry = {...nc[di]};
  const flights = [...(dayEntry.flights||[])];
  flights[fi] = {...flights[fi], ...fields};
  dayEntry.flights = flights;
  nc[di] = dayEntry;
  await db_saveRoster(userId, {...roster, calendar:nc}, {skipMergeProtection:true});
  return nc;
}

// Removes a single flight leg from a SAVED roster (persists immediately via
// db_saveRoster) -- the flight-detail page's counterpart to
// saveFlightFieldsToRoster above, since deleting is structurally different
// from patching (removing an array element, and potentially collapsing the
// day itself if no flights remain and there's no standalone dutyCode).
async function deleteFlightFromRoster(userId, roster, di, fi) {
  const nc = [...(roster.calendar||[])];
  const dayEntry = {...nc[di]};
  const flights = (dayEntry.flights||[]).filter((_,i)=>i!==fi);
  dayEntry.flights = flights;
  // A day with zero flights and no dutyCode reverts to off -- matches the
  // same rule PostUploadVerifyScreen's own deleteFlight uses for an
  // in-memory (pre-save) roster, kept consistent here for a saved one.
  if(flights.length===0 && !dayEntry.dutyCode) dayEntry.isOff = true;
  nc[di] = dayEntry;
  await db_saveRoster(userId, {...roster, calendar:nc}, {skipMergeProtection:true});
  return nc;
}

async function db_deleteRoster(userId, rosterId) {
  if(isConfigured()) {
    const {error} = await sb.from("rosters").delete().eq("id", rosterId);
    if(error) throw new Error(error.message||"Failed to delete roster");
    return;
  }
  const list = (local.get("fl_rosters_"+userId)||[]).filter(r=>r.id!==rosterId);
  local.set("fl_rosters_"+userId, list);
}

// Saves an updated calendar array back to an existing roster -- used when a
// pilot manually adds/edits a flight on a day (e.g. one the AI parser marked
// as off, or a flight that needs correcting).
async function db_updateRosterCalendar(userId, rosterId, calendar) {
  if(isConfigured()) {
    const {error} = await sb.from("rosters").update({calendar}, "id=eq."+rosterId);
    if(error) throw new Error("Failed to save changes");
    return;
  }
  const list = local.get("fl_rosters_"+userId)||[];
  const r = list.find(r=>r.id===rosterId);
  if(r) r.calendar = calendar;
  local.set("fl_rosters_"+userId, list);
}

async function db_loadTails(userId) {
  if(isConfigured()) {
    const {data} = await sb.from("tail_logs").select("*").eq("user_id", userId);
    const map={};
    (data||[]).forEach(r=>{
      map[`${r.roster_id}-${r.flight_key}`] = {
        tail: r.tail_number,
        actualDep: r.actual_dep_time || "",
        actualArr: r.actual_arr_time || "",
        actualBlockMins: r.actual_block_mins ?? null,
        schedBlockMins: r.sched_block_mins ?? null,
        finalSynced: !!r.final_synced,
        cancelled: !!r.cancelled,
        updatedAt: r.updated_at || null,
        remarks: r.remarks || "",
        crewName: r.crew_name || "",
        depGate: r.dep_gate || null,
        arrGate: r.arr_gate || null,
      };
    });
    return map;
  }
  return local.get("fl_tails_"+userId)||{};
}

// Accepts EITHER:
//   db_saveTail(userId, rosterId, flightKey, tailStringOrUpdatesObj, actualDep, actualArr, actualBlockMins, lock, schedBlockMins, depGate, arrGate)
//   db_saveTail(userId, fullTkKey, tailStringOrUpdatesObj)   <- composite key shorthand, used by many call sites
// The composite key form is detected when `flightKeyArg` is missing/undefined
// AND `rosterIdArg` contains the "roster-di-fi" pattern (2+ dashes after a UUID).
async function db_saveTail(userId, rosterIdArg, flightKeyOrUpdates, tailOrRest, actualDep="", actualArr="", actualBlockMins=null, lock=false, schedBlockMins=null, depGate=null, arrGate=null) {
  let rosterId, flightKey, updates;

  // Detect composite-key shorthand: db_saveTail(userId, tk, updatesObjOrString)
  // tk looks like "<uuid>-<dayIndex>-<flightIndex>" — split off the last two
  // dash-separated segments as di/fi, everything before that is the rosterId.
  const looksLikeCompositeKey = typeof rosterIdArg === "string" &&
    /-\d+-\d+$/.test(rosterIdArg) &&
    (flightKeyOrUpdates === undefined || typeof flightKeyOrUpdates === "object" || typeof flightKeyOrUpdates === "string");

  if(looksLikeCompositeKey) {
    const parts = rosterIdArg.split("-");
    flightKey = parts.slice(-2).join("-");          // "di-fi"
    rosterId  = parts.slice(0, -2).join("-");        // everything before — the actual roster UUID
    const arg = flightKeyOrUpdates;
    if(typeof arg === "object" && arg !== null) {
      updates = arg; // {tail, actualDep, actualArr, actualBlockMins, depGate, arrGate, ...}
    } else {
      updates = { tail: arg ?? "" }; // plain tail-number string shorthand
    }
  } else {
    // Standard explicit-args form
    rosterId  = rosterIdArg;
    flightKey = flightKeyOrUpdates;
    updates = {
      tail: tailOrRest ?? "",
      actualDep, actualArr, actualBlockMins, schedBlockMins, depGate, arrGate,
    };
  }

  const finalTail        = updates.tail ?? "";
  const finalActualDep   = updates.actualDep ?? "";
  const finalActualArr   = updates.actualArr ?? "";
  const finalActualBlock = updates.actualBlockMins ?? null;
  const finalSchedBlock  = updates.schedBlockMins ?? null;
  const finalLock        = updates.lock ?? lock ?? false;
  const finalDepGate     = updates.depGate ?? null;
  const finalArrGate     = updates.arrGate ?? null;

  if(isConfigured()) {
    const payload = {
      user_id:userId, roster_id:rosterId, flight_key:flightKey,
      tail_number:finalTail,
      actual_dep_time: finalActualDep || null,
      actual_arr_time: finalActualArr || null,
      actual_block_mins: finalActualBlock ?? null,
    };
    if(finalSchedBlock!=null) payload.sched_block_mins = finalSchedBlock;
    if(finalLock) payload.final_synced = true;
    if(finalDepGate!=null) payload.dep_gate = finalDepGate;
    if(finalArrGate!=null) payload.arr_gate = finalArrGate;
    const {error} = await sb.from("tail_logs").upsert(payload, {onConflict:"user_id,roster_id,flight_key"});
    if(error) throw new Error(error.message||"Failed to save tail data");
    return;
  }
  const map = local.get("fl_tails_"+userId)||{};
  map[`${rosterId}-${flightKey}`]={tail:finalTail, actualDep:finalActualDep, actualArr:finalActualArr, actualBlockMins:finalActualBlock, schedBlockMins:finalSchedBlock};
  local.set("fl_tails_"+userId, map);
}

async function db_adminUsers() {
  if(isConfigured()) {
    const token = sb.auth._token || SUPA_ANON;
    // Call the get_admin_users() RPC which joins profiles + auth.users for email
    const res = await fetch(
      `${SUPA_URL}/rest/v1/rpc/get_admin_users`,
      {method:"POST", headers:{
        "apikey":SUPA_ANON,
        "Authorization":`Bearer ${token}`,
        "Content-Type":"application/json",
      }, body:"{}"}
    );
    const data = await res.json();
    if(Array.isArray(data)) return data;
    // Fallback: just return profiles without email
    const res2 = await fetch(
      `${SUPA_URL}/rest/v1/profiles?select=*&order=joined.desc`,
      {headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${token}`}}
    );
    const data2 = await res2.json();
    return Array.isArray(data2) ? data2 : [];
  }
  return (local.get("fl_users")||[
    {id:"u1",email:"admin@flightlog.app",name:"Admin",role:"admin",plan:"admin",joined:"2026-01-01",active:true},
    {id:"u2",email:"pilot@example.com",name:"Mohammed Al Obaidi",role:"pilot",plan:"pro",joined:"2026-05-10",active:true},
  ]).map(u=>({...u}));
}

async function db_adminAllRosters() {
  if(isConfigured()) {
    const token = sb.auth._token || SUPA_ANON;
    const res = await fetch(
      `${SUPA_URL}/rest/v1/rpc/get_admin_rosters`,
      {method:"POST", headers:{
        "apikey":SUPA_ANON,
        "Authorization":`Bearer ${token}`,
        "Content-Type":"application/json",
      }, body:"{}"}
    );
    const data = await res.json();
    if(Array.isArray(data)) return data;
    // Fallback: direct rosters query
    const res2 = await fetch(
      `${SUPA_URL}/rest/v1/rosters?select=*&order=uploaded_at.desc`,
      {headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${token}`}}
    );
    const data2 = await res2.json();
    return Array.isArray(data2) ? data2 : [];
  }
  const users = await db_adminUsers();
  return users.flatMap(u=>(local.get("fl_rosters_"+u.id)||[]).map(r=>({...r,user_name:u.name,user_email:u.email})));
}

// Loads one specific pilot's rosters for "View As User" -- reuses the same
// get_admin_rosters RPC the admin "All Rosters" page already relies on
// (proven to work, since AdminUsers' own viewRosters() drill-down uses this
// exact RPC + client-side filter today), then maps the raw snake_case rows
// into the same shape db_loadRosters produces so every existing pilot-facing
// component (Dashboard, Logbook, Stats...) can consume it unmodified.
async function db_adminLoadUserRosters(targetUserId) {
  const all = await db_adminAllRosters();
  return all
    .filter(r=>r.user_id===targetUserId)
    .map(r=>({id:r.id,periodLabel:r.period_label,year:r.year,monthNum:r.month_num,calendar:r.calendar,uploadedAt:r.uploaded_at}))
    .sort((a,b)=>(b.year*100+b.monthNum)-(a.year*100+a.monthNum));
}

// Loads one specific pilot's tail_logs for "View As User". There's no
// dedicated admin RPC for tail_logs yet, so this attempts the same direct
// query db_loadTails uses for a pilot's own data. AdminUsers' existing
// deleteUser() flow already performs direct tail_logs REST calls scoped to
// another user's id with the admin's own token successfully, which suggests
// this table's access rules permit it -- but if a project's RLS setup ever
// blocks this, it fails closed to an empty map (flights show as "pending
// sync") rather than throwing, so viewing a pilot's schedule never breaks.
async function db_adminLoadUserTails(targetUserId) {
  if(isConfigured()) {
    try {
      const {data} = await sb.from("tail_logs").select("*").eq("user_id", targetUserId);
      const map={};
      (data||[]).forEach(r=>{
        map[`${r.roster_id}-${r.flight_key}`] = {
          tail:r.tail_number, actualDep:r.actual_dep_time||"", actualArr:r.actual_arr_time||"",
          actualBlockMins:r.actual_block_mins??null, schedBlockMins:r.sched_block_mins??null,
          finalSynced:!!r.final_synced, cancelled:!!r.cancelled, updatedAt:r.updated_at||null,
          remarks:r.remarks||"", crewName:r.crew_name||"", depGate:r.dep_gate||null, arrGate:r.arr_gate||null,
        };
      });
      return map;
    } catch { return {}; }
  }
  return local.get("fl_tails_"+targetUserId)||{};
}

// -----------------------------------------------------------------------------
// APP CONFIG -- lets an admin edit landing-page copy and a few app-wide
// switches (announcement banner, maintenance mode) without touching code.
// Backed by a single row in an "app_config" table (id=1, a jsonb "data"
// column). If that table doesn't exist yet -- e.g. on first use, before
// Mali has run the one-time setup SQL the admin editor shows her -- every
// read/write here fails closed to the hardcoded defaults rather than
// throwing, so the app behaves exactly as it does today until she opts in.
// -----------------------------------------------------------------------------
const APP_CONFIG_DEFAULTS = {
  heroHeadline1:"The Pilot's Logbook.",
  heroHeadline2:"Automated.",
  heroSubhead:"Securely sync your airline roster and log every flight in seconds with industry-leading accuracy.",
  pricingHeadline:"Simple, honest pricing",
  pricingSubhead:"One plan, everything included. No feature tiers, no hidden fees.",
  announcementEnabled:false,
  announcementText:"",
  maintenanceEnabled:false,
  maintenanceMessage:"AviateSync is undergoing scheduled maintenance. We'll be back shortly.",
};
async function db_loadAppConfig() {
  if(!isConfigured()) return {...APP_CONFIG_DEFAULTS};
  try {
    const {data,error} = await sb.from("app_config").select("data").eq("id",1).single();
    if(error||!data) return {...APP_CONFIG_DEFAULTS, _unconfigured:true};
    return {...APP_CONFIG_DEFAULTS, ...(data.data||{})};
  } catch { return {...APP_CONFIG_DEFAULTS, _unconfigured:true}; }
}
async function db_saveAppConfig(config) {
  if(!isConfigured()) throw new Error("Connect Supabase to save app configuration.");
  const clean = {...config}; delete clean._unconfigured;
  const {error} = await sb.from("app_config").upsert({id:1, data:clean, updated_at:new Date().toISOString()});
  if(error) throw new Error(error.message||"Save failed -- see the setup note above if this is your first time saving.");
}

async function db_adminUpdateUser(userId, updates) {
  if(isConfigured()) {
    await sb.from("profiles").update(updates).eq("id", userId);
    return;
  }
  const users=local.get("fl_users")||[];
  const u=users.find(u=>u.id===userId); if(u) Object.assign(u,updates);
  local.set("fl_users",users);
}

// -----------------------------------------------------------------------------
// LANDING PAGE
// -----------------------------------------------------------------------------
// Detect if running as installed PWA (standalone mode)
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

// -----------------------------------------------------------------------------
// APP LANDING PAGE -- shown only when running as installed PWA
// Clean, aviation-themed screen with Sign In / Sign Up / Biometric buttons.
// The website landing page (LandingPage below) is unchanged.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// LOCK SCREEN -- shown after 60 minutes of inactivity
// User is still authenticated (token valid), we just need to re-verify
// identity before showing data again. Biometrics first, password fallback.
// -----------------------------------------------------------------------------
function LockScreen({user, onUnlock}) {
  const [bioLoading, setBioLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const bioAvailable = !!localStorage.getItem("fl_webauthn_registered");
  const savedUserId = localStorage.getItem("fl_webauthn_user_id");

  // Don't auto-trigger on mount -- Safari on iOS requires a direct user
  // gesture to initiate WebAuthn. Show the button instead and let the
  // user tap it. Android Chrome handles auto-trigger fine but iOS blocks it.
  // useEffect removed intentionally.

  async function bioUnlock() {
    if(!savedUserId) return;
    setBioLoading(true); setErr("");
    try {
      await authenticateWithBiometric(savedUserId);
      onUnlock();
    } catch(e) {
      setErr("Biometric failed -- enter your password instead.");
      setShowPassword(true);
    } finally { setBioLoading(false); }
  }

  async function passwordUnlock() {
    if(!password) return;
    setLoading(true); setErr("");
    try {
      const {data, error} = await sb.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if(error || !data?.user) throw new Error("Incorrect password.");
      setPassword("");
      onUnlock();
    } catch(e) { setErr(e.message||"Incorrect password."); }
    finally { setLoading(false); }
  }

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:`linear-gradient(160deg, #060B14 0%, #0D1829 50%, #091220 100%)`,
      display:"flex", flexDirection:"column", alignItems:"center",
      justifyContent:"center", padding:32,
    }}>
      {/* Lock icon */}
      <div style={{
        width:72, height:72, borderRadius:"50%",
        background:"rgba(45,140,240,0.1)",
        border:"1.5px solid rgba(45,140,240,0.3)",
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:32, marginBottom:24,
      }}>🔒</div>

      <div style={{fontSize:22,fontWeight:700,color:"#FFFFFF",fontFamily:"Fraunces,serif",marginBottom:6}}>
        Aviate<span style={{color:"#2D8CF0"}}>Sync</span>
      </div>
      <div style={{fontSize:13,color:"#5A6680",marginBottom:32,textAlign:"center"}}>
        Session locked after inactivity
      </div>
      <div style={{fontSize:12,color:"#A8B4CC",marginBottom:24}}>
        {user.name || user.email}
      </div>

      {err && <div style={{fontSize:12,color:"#E05A5A",marginBottom:16,textAlign:"center",maxWidth:280}}>{err}</div>}

      {/* Biometric button */}
      {bioAvailable && !showPassword && (
        <button onClick={bioUnlock} disabled={bioLoading} style={{
          width:"100%", maxWidth:320, padding:"16px", borderRadius:14, marginBottom:12,
          background:"linear-gradient(135deg,#2D8CF022,#2D8CF010)",
          border:"1px solid #2D8CF044",
          color:"#2D8CF0", fontSize:15, fontWeight:600,
          fontFamily:"Inter,sans-serif", cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center", gap:10,
        }}>
          {bioLoading ? <span className="spinner">⟳</span> : <>🔒 Unlock with biometrics</>}
        </button>
      )}

      {/* Password fallback */}
      {showPassword && (
        <div style={{width:"100%",maxWidth:320}}>
          <input
            className="form-input"
            type="password"
            placeholder="Enter your password"
            value={password}
            autoFocus
            onChange={e=>setPassword(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&passwordUnlock()}
            style={{marginBottom:10,fontSize:15}}
          />
          <button onClick={passwordUnlock} disabled={loading||!password} style={{
            width:"100%", padding:"15px", borderRadius:14,
            background:"#2D8CF0", border:"none",
            color:"#fff", fontSize:15, fontWeight:600,
            fontFamily:"Inter,sans-serif", cursor:"pointer",
          }}>
            {loading?<span className="spinner">⟳</span>:"Unlock"}
          </button>
        </div>
      )}

      {/* Show password option */}
      {!showPassword && (
        <button onClick={()=>setShowPassword(true)} style={{
          marginTop:12, background:"none", border:"none",
          color:"#5A6680", fontSize:12, cursor:"pointer",
        }}>
          Use password instead
        </button>
      )}
    </div>
  );
}

function AppLandingPage({onAuth}) {
  const [mode, setMode] = useState(null); // null | "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);
  const [bioErr, setBioErr] = useState("");
  const registered = localStorage.getItem("fl_webauthn_registered") === "true";
  const savedUserId = localStorage.getItem("fl_webauthn_user_id");

  useEffect(()=>{ isWebAuthnAvailable().then(setBioAvailable); },[]);

  async function bioSignIn() {
    if(!savedUserId) return;
    setBioLoading(true); setBioErr("");
    try {
      await authenticateWithBiometric(savedUserId);
      const profile = await fetchProfile(savedUserId);
      onAuth({...profile, id:savedUserId});
    } catch(e) { setBioErr(e.message||"Biometric sign-in failed."); }
    finally { setBioLoading(false); }
  }

  async function submit() {
    if(!email||!password) { setErr("Email and password required."); return; }
    setErr(""); setLoading(true);
    try {
      if(mode==="login") {
        const {data,error} = await sb.auth.signInWithPassword({email,password});
        if(error||!data?.user) throw new Error(error?.message||"Sign in failed.");
        const profile = await fetchProfile(data.user.id, data.session?.access_token);
        onAuth({...data.user,...profile});
      } else {
        const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
        const {data,error} = await sb.auth.signUp({email,password,options:{data:{name:fullName,first_name:firstName.trim(),last_name:lastName.trim()}}});
        if(error) throw new Error(error.message||"Sign up failed.");
        const profile = await fetchProfile(data.user.id, data.session?.access_token);
        onAuth({...data.user,...profile});
      }
    } catch(e) { setErr(e.message||"Authentication failed."); }
    finally { setLoading(false); }
  }

  const showBio = bioAvailable && registered && savedUserId;

  const features = [
    {
      color:"#2563EB",
      icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#2563EB" strokeWidth="2"/><path d="M8 13h8M8 17h5" stroke="#2563EB" strokeWidth="2" strokeLinecap="round"/></svg>,
      text:"Upload your PDF roster -- any airline",
    },
    {
      color:"#10B981",
      icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" stroke="#10B981" strokeWidth="2" strokeLinejoin="round" fill="none"/></svg>,
      text:"Tail numbers & block times sync automatically",
    },
    {
      color:"#3B82F6",
      icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill="#3B82F6"/><rect x="10" y="7" width="4" height="14" rx="1" fill="#3B82F6"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#3B82F6"/></svg>,
      text:"Currency tracking & Jeppesen export",
    },
  ];

  return (
    <div style={{
      width:"100%",maxWidth:400,margin:"0 auto",
      minHeight:"100dvh",display:"flex",flexDirection:"column",
      background:"#F8FAFC",fontFamily:"Inter,system-ui,sans-serif",
      position:"relative",overflow:"hidden",
    }}>
      {/* Background blobs */}
      <div style={{position:"absolute",top:"-10%",right:"-10%",width:"70%",height:"40%",background:"#DBEAFE",borderRadius:"50%",filter:"blur(80px)",opacity:0.6,pointerEvents:"none",zIndex:0}}/>
      <div style={{position:"absolute",top:"20%",left:"-20%",width:"60%",height:"40%",background:"#BAE6FD",borderRadius:"50%",filter:"blur(80px)",opacity:0.6,pointerEvents:"none",zIndex:0}}/>

      <main style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"space-between",padding:"64px 24px 40px",position:"relative",zIndex:1,overflowY:"auto"}}>

        {/* Form view */}
        {mode?(
          <div style={{display:"flex",flexDirection:"column",flex:1,justifyContent:"center"}}>
            {/* Back */}
            <button onClick={()=>{setMode(null);setErr("");}} style={{display:"flex",alignItems:"center",gap:6,background:"none",border:"none",color:"#64748B",fontSize:14,fontWeight:600,cursor:"pointer",marginBottom:28,padding:0,alignSelf:"flex-start"}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke="#64748B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Back
            </button>
            {/* Logo small */}
            <div style={{textAlign:"center",marginBottom:28}}>
              <div style={{fontSize:26,fontWeight:900,color:"#0F172A",letterSpacing:"-.5px"}}>
                Aviate<span style={{color:"#1D4ED8"}}>Sync</span>
              </div>
              <div style={{fontSize:14,color:"#64748B",marginTop:4}}>{mode==="login"?"Welcome back":"Create your account"}</div>
            </div>
            {/* Error */}
            {err&&<div style={{fontSize:13,color:"#DC2626",marginBottom:12,padding:"10px 14px",background:"#FEF2F2",borderRadius:10,border:"1px solid #FECACA"}}>{err}</div>}
            {/* Fields */}
            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
              {mode==="signup"&&(
                <div style={{display:"flex",gap:10}}>
                  <input
                    style={{flex:1,padding:"14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none"}}
                    placeholder="First name" value={firstName} onChange={e=>setFirstName(e.target.value)}
                  />
                  <input
                    style={{flex:1,padding:"14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none"}}
                    placeholder="Last name" value={lastName} onChange={e=>setLastName(e.target.value)}
                  />
                </div>
              )}
              <input
                type="email"
                style={{padding:"14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none"}}
                placeholder="Email address" value={email} onChange={e=>setEmail(e.target.value)}
              />
              <div style={{position:"relative"}}>
                <input
                  type={showPass?"text":"password"}
                  style={{width:"100%",padding:"14px 44px 14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none",boxSizing:"border-box"}}
                  placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&submit()}
                />
                <button type="button" onClick={()=>setShowPass(p=>!p)} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"#94A3B8",cursor:"pointer",padding:4}}>
                  {showPass
                    ?<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round"/></svg>
                    :<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="#94A3B8" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="#94A3B8" strokeWidth="2"/></svg>
                  }
                </button>
              </div>
            </div>
            {/* Submit */}
            <button
              onClick={submit} disabled={loading}
              style={{width:"100%",padding:"16px",borderRadius:16,background:loading?"#93C5FD":"#1D4ED8",border:"none",color:"#fff",fontSize:15,fontWeight:700,cursor:loading?"not-allowed":"pointer",boxShadow:"0 8px 24px rgba(29,78,216,0.25)",marginBottom:12,transition:"background .15s"}}
            >
              {loading?"⟳":mode==="login"?"Sign in":"Create account"}
            </button>
            {/* Toggle */}
            <button onClick={()=>{setMode(mode==="login"?"signup":"login");setErr("");}} style={{background:"none",border:"none",color:"#64748B",fontSize:13,cursor:"pointer",padding:"8px"}}>
              {mode==="login"?"Don't have an account? Create one":"Already have an account? Sign in"}
            </button>
          </div>
        ):(
          <>
            {/* -- DEFAULT VIEW -- */}

            {/* Top: logo + features */}
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",marginTop:16}}>
              {/* App icon -- real AviateSync mark, matching the icon used
                  everywhere else in the app (Dashboard header, hero nav) */}
              <div style={{
                width:80,height:80,
                background:"linear-gradient(165deg,#1D4ED8 0%,#2E6BE6 55%,#3B82F6 100%)",
                borderRadius:24,
                boxShadow:"0 12px 32px rgba(29,78,216,0.3)",
                display:"flex",alignItems:"center",justifyContent:"center",
                marginBottom:24,position:"relative",
              }}>
                <div style={{width:52,height:52,borderRadius:14,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
                  <img src="/icons/icon-192.png" alt="" style={{width:40,height:40,objectFit:"contain"}}/>
                </div>
                <div style={{position:"absolute",bottom:12,right:12,width:14,height:14,borderRadius:"50%",background:"#1D4ED8",border:"2.5px solid #fff",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
              </div>
              {/* App name */}
              <h1 style={{fontSize:32,fontWeight:900,color:"#0F172A",letterSpacing:"-1px",margin:0,lineHeight:1.1}}>
                Aviate<span style={{color:"#1D4ED8"}}>Sync</span>
              </h1>
              <p style={{fontSize:15,fontWeight:500,color:"#64748B",marginTop:8,marginBottom:0}}>
                Your automated pilot logbook
              </p>
            </div>

            {/* Features */}
            <div style={{display:"flex",flexDirection:"column",gap:10,margin:"32px 0"}}>
              {features.map(({color,icon,text})=>(
                <div key={text} style={{
                  background:"rgba(255,255,255,0.85)",
                  backdropFilter:"blur(8px)",
                  border:"1px solid rgba(226,232,240,0.8)",
                  borderRadius:16,padding:"14px 16px",
                  display:"flex",alignItems:"center",gap:14,
                  boxShadow:"0 4px 20px rgba(0,0,0,0.03)",
                }}>
                  <div style={{width:36,height:36,borderRadius:10,background:`${color}15`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {icon}
                  </div>
                  <span style={{fontSize:14,fontWeight:600,color:"#374151",lineHeight:1.4}}>{text}</span>
                </div>
              ))}
            </div>

            {/* Bottom: CTAs */}
            <div style={{marginTop:"auto",display:"flex",flexDirection:"column",gap:12}}>
              {/* Biometric if available -- label/icon adapt to the actual
                  platform provider (Samsung Pass, Android biometrics, Face
                  ID, Touch ID) instead of always saying "Face ID" */}
              {showBio&&(()=>{
                const provider = detectBiometricProvider();
                return(
                  <button onClick={bioSignIn} disabled={bioLoading} style={{width:"100%",padding:"15px",borderRadius:16,background:"rgba(29,78,216,0.08)",border:"1.5px solid rgba(29,78,216,0.2)",color:"#1D4ED8",fontSize:14,fontWeight:700,cursor:bioLoading?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:4}}>
                    {provider.icon==="fingerprint"?(
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2a8 8 0 00-8 8c0 1.5.3 2.9.8 4.2M12 2a8 8 0 018 8c0 5-3 9-3 9M12 6a6 6 0 00-6 6c0 2 .5 3.8 1.3 5.3M12 6a6 6 0 016 6c0 3-1 5.5-2 7M12 10a4 4 0 00-4 4c0 1.5.5 2.8 1 3.8M12 10a4 4 0 014 4c0 1.8-.5 3.3-1.2 4.5M12 14v4" stroke="#1D4ED8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    ):(
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="#1D4ED8" strokeWidth="2"/><path d="M8 11V7a4 4 0 018 0v4" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round"/></svg>
                    )}
                    {bioLoading?"Authenticating...":`Sign in with ${provider.label}`}
                  </button>
                );
              })()}
              {bioErr&&<div style={{fontSize:12,color:"#DC2626",textAlign:"center",marginTop:-4}}>{bioErr}</div>}
              {/* Sign in */}
              <button
                onClick={()=>{setMode("login");setErr("");}}
                style={{width:"100%",background:"#1D4ED8",border:"none",color:"#fff",padding:"16px",borderRadius:16,fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:"0 8px 24px rgba(29,78,216,0.2)",transition:"background .15s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#1E40AF"}
                onMouseLeave={e=>e.currentTarget.style.background="#1D4ED8"}
              >
                Sign in
              </button>
              {/* Create account */}
              <button
                onClick={()=>{setMode("signup");setErr("");}}
                style={{width:"100%",background:"#fff",border:"1px solid #E2E8F0",color:"#0F172A",padding:"15px",borderRadius:16,fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:"0 1px 4px rgba(0,0,0,0.04)",transition:"background .15s"}}
                onMouseEnter={e=>e.currentTarget.style.background="#F8FAFC"}
                onMouseLeave={e=>e.currentTarget.style.background="#fff"}
              >
                Create account
              </button>
              {/* Trust line */}
              <p style={{textAlign:"center",fontSize:11,fontWeight:500,color:"#94A3B8",margin:"8px 0 0"}}>
                Secured by Stripe · Your data is encrypted
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}


function LandingPage({onLogin, onSignup}) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(()=>{
    const onScroll = ()=>setScrolled(window.scrollY>20);
    window.addEventListener("scroll",onScroll);
    return()=>window.removeEventListener("scroll",onScroll);
  },[]);

  // Hero/pricing copy is admin-editable (Admin > Landing Page & Content);
  // falls back to the hardcoded defaults instantly if that hasn't been set
  // up yet, so there's no loading flash or broken state either way.
  const [cfg, setCfg] = useState(APP_CONFIG_DEFAULTS);
  useEffect(()=>{ db_loadAppConfig().then(setCfg); },[]);
  const [announcementDismissed, setAnnouncementDismissed] = useState(false);

  const S = {
    bg:"#F8FAFC", surface:"#FFFFFF", border:"#E2E8F0",
    ink:"#0F172A", muted:"#64748B", silver:"#475569",
    blue:"#1D4ED8", blueDim:"#1E40AF", panel:"#F1F5F9",
  };

  return(
    <div style={{background:S.bg,minHeight:"100vh",fontFamily:"Inter,system-ui,sans-serif",color:S.ink,overflowX:"hidden",overscrollBehaviorY:"none",position:"relative"}}>

      {/* Background blobs */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",left:"-10%",width:"40%",height:"40%",background:"#BFDBFE",borderRadius:"50%",filter:"blur(100px)",opacity:0.5}}/>
        <div style={{position:"absolute",top:"20%",right:"-10%",width:"40%",height:"40%",background:"#BAE6FD",borderRadius:"50%",filter:"blur(100px)",opacity:0.5}}/>
        <div style={{position:"absolute",bottom:"-10%",left:"20%",width:"50%",height:"40%",background:"#FDE8D8",borderRadius:"50%",filter:"blur(120px)",opacity:0.4}}/>
      </div>

      {/* -- ANNOUNCEMENT BANNER -- same admin-editable config the signed-in
          app shell reads (Admin > Landing Page & Content), now ALSO shown
          here so a visitor sees it before ever logging in. Sits above the
          fixed nav so it pushes the page down rather than overlapping it.
          Dismiss state is local to this page load -- a marketing page
          visitor doesn't have an ongoing session to persist it against the
          way the in-app version does. */}
      {cfg.announcementEnabled&&cfg.announcementText&&!announcementDismissed&&(
        <div style={{position:"relative",zIndex:101,padding:"8px 16px",background:"linear-gradient(135deg,#1D4ED8,#3B82F6)",display:"flex",alignItems:"center",gap:10}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
          <span style={{fontSize:12.5,fontWeight:600,color:"#fff",flex:1}}>{cfg.announcementText}</span>
          <button onClick={()=>setAnnouncementDismissed(true)} style={{background:"none",border:"none",color:"rgba(255,255,255,0.8)",fontSize:16,cursor:"pointer",padding:0,lineHeight:1,flexShrink:0}}>✕</button>
        </div>
      )}

      {/* NAV -- floating glass pill on dark navy: real AviateSync logo mark
          on a white tile, AVIATESYNC wordmark, Features / Pricing / Support /
          Log In, white Get Started pill. Links collapse below 860px. */}
      <nav style={{position:"fixed",top:0,left:0,right:0,zIndex:100,padding:"24px 16px 0"}}>
        <div className="as-navpill" style={{maxWidth:1200,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",padding:12,borderRadius:100,background:"rgba(255,255,255,0.05)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",border:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"0 8px 0 6px",minWidth:0}}>
            <div style={{width:34,height:34,borderRadius:9,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
              <img src="/icons/icon-192.png" alt="AviateSync" style={{width:26,height:26,objectFit:"contain"}}/>
            </div>
            <span className="as-word" style={{fontWeight:800,fontSize:17,letterSpacing:".5px",color:"#fff",whiteSpace:"nowrap"}}>AVIATE<span style={{color:"#A9BEDE"}}>SYNC</span></span>
          </div>
          <div className="as-navright" style={{display:"flex",alignItems:"center",gap:20}}>
            <div className="as-navlinks" style={{display:"flex",gap:24,fontSize:14,color:"#D1D5DB",alignItems:"center"}}>
              {["Features","Pricing","Support"].map(l=>(
                <button key={l} onClick={()=>document.getElementById(l.toLowerCase())?.scrollIntoView({behavior:"smooth"})} style={{background:"none",border:"none",color:"#D1D5DB",cursor:"pointer",padding:0,fontSize:14}}>{l}</button>
              ))}
            </div>
            <button className="as-login" onClick={onLogin} style={{background:"none",border:"none",color:"#D1D5DB",cursor:"pointer",padding:0,fontSize:14,whiteSpace:"nowrap"}}>Log In</button>
            <button className="as-cta" onClick={onSignup} style={{background:"#fff",color:"#0B1625",padding:"10px 24px",borderRadius:100,fontWeight:700,fontSize:14,border:"none",cursor:"pointer",whiteSpace:"nowrap"}}>Get Started</button>
          </div>
        </div>
      </nav>

      {/* HERO -- matched to comp: #0B1625 navy with a faint route-map
          backdrop (great-circle line, dashed branches, waypoint fixes),
          two-line headline, store badges, and a glowing iPhone mockup
          running the AviateSync dashboard. The phone is intentionally
          clipped by the section's bottom edge, exactly like the comp. */}
      <section className="as-hero" style={{background:"#0B1625",paddingTop:140,position:"relative",overflow:"hidden"}}>
        <style>{`
          @media(max-width:860px){.as-navlinks{display:none!important}}
          @media(max-width:700px){
            .as-hero{padding-top:112px!important}
            .as-hero-inner{gap:24px!important}
            .as-hero-copy{padding-bottom:0!important;text-align:center}
            .as-h1{font-size:38px!important}
            .as-sub{font-size:17px!important;margin-left:auto!important;margin-right:auto!important}
            .as-badges{justify-content:center}
            .as-badge{width:150px!important;height:52px!important}
            .as-navpill{padding:8px!important}
            .as-navright{gap:12px!important}
            .as-word{font-size:14px!important}
            .as-login{font-size:13px!important}
            .as-cta{padding:8px 16px!important;font-size:13px!important}
            .as-phonewrap{transform:scale(.88);transform-origin:top center;margin-bottom:-190px!important}
          }
          @media(max-width:390px){
            .as-h1{font-size:34px!important}
            .as-word{font-size:13px!important}
            .as-phonewrap{transform:scale(.8);margin-bottom:-215px!important}
          }
          @media(prefers-reduced-motion:no-preference){
            .as-dash{animation:asDash 8s linear infinite}
            .as-pulse{animation:asPulse 3s ease-in-out infinite}
          }
          @keyframes asDash{to{stroke-dashoffset:-48}}
          @keyframes asPulse{0%,100%{opacity:.15}50%{opacity:.6}}
        `}</style>

        {/* Route-map backdrop */}
        <svg aria-hidden="true" viewBox="0 0 1440 700" preserveAspectRatio="xMidYMid slice" style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none"}}>
          {/* faint chart boundary lines */}
          <path d="M-40 620 L140 560 L260 585 L390 500 L430 530 L560 470" fill="none" stroke="rgba(148,163,184,0.10)" strokeWidth="1"/>
          <path d="M900 700 L1010 640 L1120 660 L1240 590 L1330 610 L1460 540" fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth="1"/>
          {/* main great-circle route through the upper right */}
          <path d="M690 700 C 900 480, 1080 300, 1400 60" fill="none" stroke="rgba(96,165,250,0.28)" strokeWidth="1.5"/>
          {/* dashed branch routes */}
          <path className="as-dash" d="M1052 330 C 1150 360, 1230 430, 1280 520" fill="none" stroke="rgba(96,165,250,0.35)" strokeWidth="1.2" strokeDasharray="5 7"/>
          <path className="as-dash" d="M1160 218 C 1230 190, 1300 185, 1385 205" fill="none" stroke="rgba(96,165,250,0.25)" strokeWidth="1.2" strokeDasharray="5 7"/>
          <path d="M180 180 C 320 140, 470 150, 620 210" fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="1" strokeDasharray="4 8"/>
          <path className="as-dash" d="M600 250 C 680 200, 780 170, 880 120" fill="none" stroke="rgba(96,165,250,0.22)" strokeWidth="1.2" strokeDasharray="5 7"/>
          <circle cx="760" cy="182" r="3" fill="#93C5FD" opacity="0.7"/>
          {/* waypoint fixes */}
          <circle cx="1052" cy="330" r="4" fill="#60A5FA" opacity="0.9"/>
          <circle className="as-pulse" cx="1052" cy="330" r="10" fill="none" stroke="#60A5FA" strokeWidth="1" opacity="0.3"/>
          <circle cx="1160" cy="218" r="3" fill="#93C5FD" opacity="0.8"/>
          <circle cx="1280" cy="520" r="3" fill="#93C5FD" opacity="0.6"/>
          <circle cx="180" cy="180" r="2.5" fill="#64748B" opacity="0.5"/>
          <text x="1066" y="326" fill="rgba(191,219,254,0.5)" fontSize="10" fontFamily="Inter,system-ui,sans-serif" letterSpacing="1">DVC</text>
          <text x="1174" y="214" fill="rgba(191,219,254,0.4)" fontSize="10" fontFamily="Inter,system-ui,sans-serif" letterSpacing="1">OBK</text>
        </svg>

        <div className="as-hero-inner" style={{maxWidth:1200,margin:"0 auto",padding:"0 16px",display:"flex",alignItems:"center",flexWrap:"wrap",gap:40,position:"relative"}}>
          <div className="as-hero-copy" style={{flex:"1 1 480px",minWidth:0,paddingBottom:60}}>
            <h1 className="as-h1" style={{fontSize:"clamp(40px,6vw,72px)",fontWeight:700,lineHeight:1.1,marginBottom:24,color:"#fff"}}>
              {cfg.heroHeadline1}<br/>{cfg.heroHeadline2}
            </h1>
            <p className="as-sub" style={{fontSize:20,color:"#9CA3AF",marginBottom:32,maxWidth:512,lineHeight:1.5}}>
              {cfg.heroSubhead}
            </p>
            <div className="as-badges" style={{display:"flex",gap:16,flexWrap:"wrap"}}>
              <a className="as-badge" href="#" onClick={e=>e.preventDefault()} style={{height:56,width:160,background:"#000",borderRadius:12,border:"1px solid #374151",display:"flex",alignItems:"center",justifyContent:"center",gap:8,textDecoration:"none"}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.55C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.5 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.82M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
                <div><div style={{fontSize:9,color:"#9CA3AF"}}>Download on the</div><div style={{fontSize:15,fontWeight:600,color:"#fff"}}>App Store</div></div>
              </a>
              <a className="as-badge" href="#" onClick={e=>e.preventDefault()} style={{height:56,width:160,background:"#000",borderRadius:12,border:"1px solid #374151",display:"flex",alignItems:"center",justifyContent:"center",gap:8,textDecoration:"none"}}>
                <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#00D9FF" d="M3 3.5v17l14-8.5L3 3.5z"/><path fill="#00F076" d="M17 12L3 3.5c.3-.2.7-.2 1 0l13.3 7.7L17 12z"/><path fill="#FF3D3D" d="M17 12l.3.8L4 20.5c-.3.2-.7.2-1 0L17 12z"/><path fill="#FFD84D" d="M17 12l3.5-.8c.7.4.7 1.6 0 2L17 12z"/></svg>
                <div><div style={{fontSize:9,color:"#9CA3AF"}}>GET IT ON</div><div style={{fontSize:15,fontWeight:600,color:"#fff"}}>Google Play</div></div>
              </a>
            </div>
          </div>

          {/* Phone mockup -- AviateSync dashboard. Gradient rim + layered
              blue glow like the comp; .as-phonewrap scales it on mobile and
              the section edge clips it at every breakpoint. */}
          <div style={{flex:"1 1 320px",display:"flex",justifyContent:"center",minWidth:0}}>
            <div className="as-phonewrap" style={{position:"relative",marginBottom:-150}}>
              {/* wide soft backdrop glow */}
              <div style={{position:"absolute",inset:-40,background:"radial-gradient(55% 50% at 50% 42%, rgba(59,130,246,0.5) 0%, rgba(59,130,246,0) 70%)",filter:"blur(30px)",pointerEvents:"none"}}/>
              {/* gradient rim tracing the bezel */}
              <div style={{position:"relative",padding:3,borderRadius:52,background:"linear-gradient(160deg,#CFE3FF 0%,#7EB2FB 20%,#2E6BE6 48%,#123A7A 78%,#5EA0F8 100%)",boxShadow:"0 0 0 1px rgba(147,197,253,0.22), 0 0 42px rgba(59,130,246,0.45), 0 28px 60px rgba(1,7,20,0.65)"}}>
                <div style={{position:"relative",width:288,height:600,background:"#000",borderRadius:49,border:"8px solid #0E1626"}}>
                <div style={{position:"absolute",inset:0,borderRadius:41,overflow:"hidden",display:"flex",flexDirection:"column",background:"#E8EEF6"}}>

                  {/* Blue app header */}
                  <div style={{background:"linear-gradient(165deg,#1D4ED8 0%,#2E6BE6 55%,#3B82F6 100%)",padding:"12px 14px 0"}}>
                    {/* status bar */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <span style={{fontSize:12,fontWeight:700,color:"#fff",width:44}}>9:41</span>
                      <div style={{width:66,height:18,borderRadius:12,background:"#000"}}/>
                      <div style={{display:"flex",alignItems:"center",gap:4,width:44,justifyContent:"flex-end"}}>
                        <svg width="14" height="10" viewBox="0 0 14 10" fill="#fff"><rect x="0" y="6" width="2.5" height="4" rx="0.5"/><rect x="3.8" y="4" width="2.5" height="6" rx="0.5"/><rect x="7.6" y="2" width="2.5" height="8" rx="0.5"/><rect x="11.4" y="0" width="2.5" height="10" rx="0.5" opacity="0.4"/></svg>
                        <svg width="20" height="10" viewBox="0 0 20 10" fill="none"><rect x="0.5" y="0.5" width="16" height="9" rx="2.5" stroke="#fff" opacity="0.5"/><rect x="2" y="2" width="11" height="6" rx="1.5" fill="#fff"/><rect x="17.5" y="3" width="2" height="4" rx="1" fill="#fff" opacity="0.5"/></svg>
                      </div>
                    </div>
                    {/* app bar */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:12}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:22,height:22,borderRadius:6,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>
                          <img src="/icons/icon-192.png" alt="" style={{width:17,height:17,objectFit:"contain"}}/>
                        </div>
                        <div>
                          <div style={{fontSize:10,fontWeight:800,color:"#fff",letterSpacing:".4px",lineHeight:1}}>AVIATE<span style={{color:"#BFDBFE"}}>SYNC</span></div>
                          <div style={{fontSize:6.5,color:"rgba(255,255,255,0.6)",letterSpacing:".3px",marginTop:2}}>PILOT LOGBOOK</div>
                        </div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#fff" strokeWidth="2"/><path d="M20 20l-3.5-3.5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                        <div style={{position:"relative"}}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke="#fff" strokeWidth="2" strokeLinejoin="round"/><path d="M10 21a2 2 0 004 0" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                          <div style={{position:"absolute",top:-2,right:-2,width:6,height:6,borderRadius:"50%",background:"#F87171",border:"1.5px solid #2E6BE6"}}/>
                        </div>
                      </div>
                    </div>
                    <div style={{fontSize:19,fontWeight:800,color:"#fff",lineHeight:1.25,margin:"14px 0 12px",maxWidth:200}}>Flight Log & Roster Sync</div>
                    {/* tabs */}
                    <div style={{display:"flex",gap:16,fontSize:10.5}}>
                      <div style={{color:"#fff",fontWeight:700,paddingBottom:8,borderBottom:"2px solid #fff"}}>Dashboard</div>
                      <div style={{color:"rgba(255,255,255,0.6)",paddingBottom:8}}>Pricing</div>
                      <div style={{color:"rgba(255,255,255,0.6)",paddingBottom:8}}>Support</div>
                    </div>
                  </div>

                  {/* Dashboard sheet */}
                  <div style={{flex:1,padding:10,minHeight:0}}>
                    <div style={{background:"#fff",borderRadius:14,padding:12,boxShadow:"0 6px 18px rgba(15,23,42,0.08)"}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                        <span style={{fontSize:12.5,fontWeight:800,color:"#0F172A"}}>Dashboard</span>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,border:"1px solid #E2E8F0",borderRadius:8,padding:"3px 8px",fontSize:9,fontWeight:600,color:"#475569"}}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M7 12h10M10 18h4" stroke="#475569" strokeWidth="2.4" strokeLinecap="round"/></svg>
                          Filter
                        </span>
                      </div>
                      {/* flight card 1 */}
                      <div style={{border:"1px solid #E8EDF4",borderLeft:"3px solid #3B82F6",borderRadius:12,padding:"10px 11px",marginBottom:8}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#94A3B8",marginBottom:3}}>
                          <span>Recent Flight</span><span>3h 59m</span>
                        </div>
                        <div style={{fontSize:13,fontWeight:800,color:"#0F172A"}}>Jun 28, 2026</div>
                        <div style={{fontSize:9.5,color:"#64748B",marginTop:2}}>ORD → DEN · UA 2314 · N37502</div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
                          <span style={{background:"#DCFCE7",color:"#15803D",fontSize:8.5,fontWeight:800,padding:"3px 9px",borderRadius:100,letterSpacing:".2px"}}>Synced</span>
                          <span style={{fontSize:9.5,fontWeight:700,color:"#2563EB"}}>Details →</span>
                        </div>
                      </div>
                      {/* flight card 2 -- runs under the section edge like the comp */}
                      <div style={{border:"1px solid #E8EDF4",borderRadius:12,padding:"10px 11px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#94A3B8",marginBottom:3}}>
                          <span>Upcoming Flight</span><span>1h 06m</span>
                        </div>
                        <div style={{fontSize:13,fontWeight:800,color:"#0F172A"}}>Jul 6, 2026</div>
                        <div style={{fontSize:9.5,color:"#64748B",marginTop:2}}>DEN → ASE · UA 5432 · CRJ-550</div>
                      </div>
                    </div>
                  </div>{/* dashboard sheet */}

                </div>{/* screen */}
                </div>{/* frame */}
              </div>{/* gradient rim */}
            </div>{/* phone wrap */}
          </div>{/* phone col */}
        </div>{/* hero inner */}
      </section>

      {/* Everything below this line -- testimonials, badge strip, features,
          how-it-works, pricing, footer -- is UNCHANGED from before. */}

      {/* STATS BAR */}
      <div style={{borderTop:`1px solid ${S.border}`,borderBottom:`1px solid ${S.border}`,background:"rgba(255,255,255,0.7)",backdropFilter:"blur(8px)",position:"relative",zIndex:1}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"0 20px",display:"flex",justifyContent:"center",flexWrap:"wrap"}}>
          {[["99.2%","Parse accuracy"],["< 15 min","After-landing sync"],["40+","Airlines"],["Jeppesen & ASA","Export ready"]].map(([num,lab],i,arr)=>(
            <div key={lab} style={{padding:"22px 28px",borderRight:i<arr.length-1?`1px solid ${S.border}`:"none",textAlign:"center",flex:"1 1 120px"}}>
              <div style={{fontSize:"clamp(18px,3vw,26px)",fontWeight:900,color:S.ink,letterSpacing:"-1px"}}>{num}</div>
              <div style={{fontSize:11,color:S.muted,marginTop:3,fontWeight:500}}>{lab}</div>
            </div>
          ))}
        </div>
      </div>

      {/* TESTIMONIALS */}
      <div style={{background:"rgba(255,255,255,0.6)",backdropFilter:"blur(8px)",borderTop:`1px solid ${S.border}`,borderBottom:`1px solid ${S.border}`,position:"relative",zIndex:1}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"52px 20px"}}>
          <div style={{textAlign:"center",marginBottom:36}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:S.blue,marginBottom:8}}>From the crew room</div>
            <h2 style={{fontSize:"clamp(20px,3vw,32px)",fontWeight:900,color:S.ink,letterSpacing:"-.5px"}}>Pilots who ditched the spreadsheet</h2>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:16}}>
            {[
              {quote:"This saved me hours of digging through OOOI times at the end of every month. I upload my FLICA PDF and everything just appears.",role:"F/O, B737 · Major carrier",initials:"MR"},
              {quote:"Finally a logbook that actually knows what my airline's roster looks like. The tail number sync is magic -- I haven't typed a tail in months.",role:"Captain, Regional airline",initials:"JT"},
              {quote:"Currency tracking alone is worth it. Before AviateSync I was manually counting landings in a spreadsheet before every IPC. Never again.",role:"F/O, A320 · Low-cost carrier",initials:"SA"},
            ].map(({quote,role,initials})=>(
              <div key={initials} style={{background:S.surface,borderRadius:20,padding:"24px 22px",border:`1px solid ${S.border}`,boxShadow:"0 2px 12px rgba(0,0,0,0.05)",display:"flex",flexDirection:"column",gap:16}}>
                {/* Stars */}
                <div style={{display:"flex",gap:3}}>
                  {[1,2,3,4,5].map(i=>(
                    <svg key={i} width="14" height="14" viewBox="0 0 24 24" fill="#FBBF24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                  ))}
                </div>
                {/* Quote */}
                <p style={{fontSize:14,color:"#1E293B",lineHeight:1.7,fontStyle:"italic",margin:0}}>"{quote}"</p>
                {/* Author */}
                <div style={{display:"flex",alignItems:"center",gap:10,marginTop:"auto"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${S.blue},#3B82F6)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700,flexShrink:0}}>
                    {initials}
                  </div>
                  <div style={{fontSize:12,color:S.muted,fontWeight:600,lineHeight:1.4}}>{role}</div>
                </div>
              </div>
            ))}
          </div>
          {/* Scheduling systems badge strip */}
          <div style={{marginTop:36,textAlign:"center"}}>
            <div style={{fontSize:12,color:S.muted,marginBottom:12,fontWeight:500}}>Works with scheduling systems used at 40+ airlines</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:10,justifyContent:"center"}}>
              {["FLICA","AIMS","CrewTrac","SkedPlus+","PBS","eTripPro","Sabre Crew","JetStream"].map(sys=>(
                <span key={sys} style={{padding:"5px 14px",borderRadius:100,background:S.panel,border:`1px solid ${S.border}`,fontSize:12,fontWeight:600,color:S.silver}}>
                  {sys}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* FEATURES */}
      <section id="features" style={{maxWidth:1200,margin:"0 auto",padding:"72px 20px",position:"relative",zIndex:1}}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:S.blue,marginBottom:8}}>Features</div>
          <h2 style={{fontSize:"clamp(24px,4vw,42px)",fontWeight:900,color:S.ink,marginBottom:12,letterSpacing:"-.8px",lineHeight:1.1}}>Everything pilots actually need</h2>
          <p style={{fontSize:15,color:S.silver,maxWidth:440,margin:"0 auto",lineHeight:1.65}}>No manual entry. One PDF upload and AviateSync handles the rest.</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14}}>
          {[
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#1D4ED8" strokeWidth="2" strokeLinejoin="round"/><path d="M14 2v6h6" stroke="#1D4ED8" strokeWidth="2" strokeLinejoin="round"/><path d="M8 13h8M8 17h5" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round"/></svg>,bg:"#EFF6FF",bc:"#DBEAFE",title:"Smart Roster Parsing",desc:"Reads any airline PDF -- FLICA, AIMS, CrewTrac, SkedPlus+, and more."},
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="#16A34A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="19" cy="6" r="3" fill="#16A34A"/></svg>,bg:"#F0FDF4",bc:"#BBF7D0",title:"Live FlightAware Sync",desc:"Actual tail numbers and block times pulled within 15 minutes of landing. Zero manual entry, ever."},
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="13" r="8" stroke="#EA580C" strokeWidth="2"/><path d="M12 13l3.5-3.5" stroke="#EA580C" strokeWidth="2" strokeLinecap="round"/><path d="M9 3h6M12 3v3" stroke="#EA580C" strokeWidth="2" strokeLinecap="round"/></svg>,bg:"#FFF7ED",bc:"#FED7AA",title:"Currency Tracking",desc:"FAR 61.57 landings, IFR currency, FAR 117 duty limits -- always current, always audit-ready."},
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round"/></svg>,bg:"#EFF6FF",bc:"#BFDBFE",title:"Jeppesen & ASA Export",desc:"Download in formats that match physical logbook columns exactly. Ready to import anywhere."},
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" fill="#16A34A"/><circle cx="12" cy="12" r="8" stroke="#16A34A" strokeWidth="1.5" opacity="0.5"/><circle cx="12" cy="12" r="11" stroke="#16A34A" strokeWidth="1.5" opacity="0.25"/></svg>,bg:"#ECFDF5",bc:"#A7F3D0",title:"Route Maps & Radar",desc:"Interactive route maps with live weather radar overlay for upcoming flights within 24 hours."},
            {icon:<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#0EA5E9" strokeWidth="2"/><path d="M9 21h6" stroke="#0EA5E9" strokeWidth="2" strokeLinecap="round"/></svg>,bg:"#F0F9FF",bc:"#BAE6FD",title:"AI Flight Briefing",desc:"One-tap briefing for your next flight -- weather, NOTAMs, and route summary. Updated hourly."},
          ].map(({icon,bg,bc,title,desc})=>(
            <div key={title} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:24}}>
              <div style={{width:48,height:48,borderRadius:12,background:bg,border:`1px solid ${bc}`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:14}}>{icon}</div>
              <div style={{fontSize:15,fontWeight:700,color:S.ink,marginBottom:6}}>{title}</div>
              <div style={{fontSize:13,color:"#334155",lineHeight:1.7}}>{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how-it-works" style={{borderTop:`1px solid ${S.border}`,background:"rgba(255,255,255,0.5)",position:"relative",zIndex:1}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"72px 20px"}}>
          <div style={{textAlign:"center",marginBottom:48}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:S.blue,marginBottom:8}}>How it works</div>
            <h2 style={{fontSize:"clamp(24px,4vw,40px)",fontWeight:900,color:S.ink,letterSpacing:"-.8px"}}>Up and running in 3 steps</h2>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",background:S.surface,borderRadius:20,border:`1px solid ${S.border}`,overflow:"hidden",boxShadow:"0 8px 32px rgba(0,0,0,0.05)"}}>
            {[
              {icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 15v2a3 3 0 003 3h10a3 3 0 003-3v-2" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round"/></svg>,num:"01",title:"Upload your roster",desc:"Drop your monthly PDF from FLICA, AIMS, CrewTrac, SkedPlus+, or any airline format. AI extracts every leg automatically."},
              {icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,num:"02",title:"Flights sync automatically",desc:"Within 15 minutes of landing, actual tail number and block time are pulled from FlightAware."},
              {icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#1D4ED8" strokeWidth="2" strokeLinejoin="round"/><path d="M9 14l2 2 4-4" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,num:"03",title:"Export & stay current",desc:"Download in Jeppesen or ASA format. Currency tracking always ready for a checkride."},
            ].map(({icon,num,title,desc},i)=>(
              <div key={title} style={{padding:"32px 24px",borderRight:i<2?`1px solid ${S.border}`:"none",borderBottom:"none"}}>
                <div style={{fontSize:48,fontWeight:900,color:S.panel,lineHeight:1,marginBottom:14}}>{num}</div>
                <div style={{width:40,height:40,borderRadius:10,background:"#EFF6FF",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12}}>{icon}</div>
                <div style={{fontSize:15,fontWeight:700,color:S.ink,marginBottom:6}}>{title}</div>
                <div style={{fontSize:13,color:S.silver,lineHeight:1.65}}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section id="pricing" style={{maxWidth:1200,margin:"0 auto",padding:"72px 20px",position:"relative",zIndex:1}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:40,alignItems:"start"}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:S.blue,marginBottom:8}}>Pricing</div>
            <h2 style={{fontSize:"clamp(24px,3.5vw,38px)",fontWeight:900,color:S.ink,marginBottom:12,letterSpacing:"-.8px",lineHeight:1.1}}>{cfg.pricingHeadline}</h2>
            <p style={{fontSize:14,color:S.silver,lineHeight:1.65,marginBottom:20}}>{cfg.pricingSubhead}</p>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {["Unlimited roster uploads","Live FlightAware sync","Jeppesen & ASA export","Currency tracking","Route maps & radar","AI flight briefings","30-day money-back guarantee"].map(f=>(
                <div key={f} style={{display:"flex",alignItems:"center",gap:10,fontSize:13,color:S.silver,fontWeight:500}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:"#F0FDF4",border:"1px solid #BBF7D0",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                  {f}
                </div>
              ))}
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:14}}>
            {/* Monthly */}
            <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:24,padding:28,boxShadow:"0 4px 20px rgba(0,0,0,0.05)",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
              <div>
                <div style={{display:"inline-flex",padding:"4px 12px",borderRadius:100,background:S.panel,fontSize:11,fontWeight:700,color:S.muted,marginBottom:16}}>Monthly</div>
                <div style={{display:"flex",alignItems:"baseline",marginBottom:4}}>
                  <span style={{fontSize:40,fontWeight:900,color:S.ink,letterSpacing:"-1.5px"}}>$14.99</span>
                  <span style={{fontSize:13,color:S.muted,marginLeft:5}}>/month</span>
                </div>
                <p style={{fontSize:12,color:S.muted,marginBottom:20,lineHeight:1.5}}>Full access. Cancel anytime.</p>
                {["All features","Cancel anytime","30-day refund"].map(f=>(
                  <div key={f} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13,color:S.silver,padding:"7px 0",borderBottom:`1px solid ${S.panel}`}}>
                    {f}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={S.blue} strokeWidth="1.5"/><path d="M8 12l3 3 5-5" stroke={S.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                ))}
              </div>
              <button onClick={onSignup} style={{width:"100%",padding:"13px",borderRadius:100,background:"none",border:`1.5px solid ${S.border}`,color:S.ink,fontSize:14,fontWeight:700,cursor:"pointer",marginTop:20}}>
                Get started
              </button>
            </div>
            {/* Annual */}
            <div style={{background:`linear-gradient(160deg,${S.blue},#3B82F6)`,borderRadius:24,padding:28,boxShadow:`0 16px 48px ${S.blue}35`,display:"flex",flexDirection:"column",justifyContent:"space-between",position:"relative"}}>
              <div style={{position:"absolute",top:0,right:24,transform:"translateY(-50%)",background:"linear-gradient(90deg,#F59E0B,#F97316)",color:"#fff",fontSize:10,fontWeight:800,letterSpacing:"1px",textTransform:"uppercase",padding:"5px 12px",borderRadius:100,boxShadow:"0 4px 12px rgba(249,115,22,0.4)"}}>Best Value</div>
              <div>
                <div style={{display:"inline-flex",padding:"4px 12px",borderRadius:100,background:"rgba(255,255,255,0.2)",fontSize:11,fontWeight:700,color:"#fff",marginBottom:16}}>Annual</div>
                <div style={{display:"flex",alignItems:"baseline",marginBottom:4}}>
                  <span style={{fontSize:40,fontWeight:900,color:"#fff",letterSpacing:"-1.5px"}}>$139.99</span>
                  <span style={{fontSize:13,color:"rgba(255,255,255,0.65)",marginLeft:5}}>/year</span>
                </div>
                <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginBottom:4}}>$11.67/month · Save 22%</div>
                {["Everything in monthly","Over 2 months free","Locked-in rate","Priority support"].map(f=>(
                  <div key={f} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:13,color:"rgba(255,255,255,0.85)",padding:"7px 0",borderBottom:"1px solid rgba(255,255,255,0.1)"}}>
                    {f}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  </div>
                ))}
              </div>
              <button onClick={onSignup} style={{width:"100%",padding:"13px",borderRadius:100,background:"#fff",border:"none",color:S.blue,fontSize:14,fontWeight:800,cursor:"pointer",marginTop:20,boxShadow:"0 4px 14px rgba(0,0,0,0.12)"}}>
                Start annual →
              </button>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",textAlign:"center",marginTop:10}}>30-day money-back guarantee</div>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer style={{borderTop:`1px solid ${S.border}`,background:"rgba(255,255,255,0.7)",backdropFilter:"blur(8px)",position:"relative",zIndex:1}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:26,height:26,borderRadius:7,background:`linear-gradient(135deg,${S.blue},#3B82F6)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <span style={{fontSize:15,fontWeight:800,color:S.ink,letterSpacing:"-.5px"}}>Aviate<span style={{color:S.blue}}>Sync</span></span>
          </div>
          <div style={{display:"flex",gap:20}}>
            {["Privacy","Terms","Support"].map(l=><span key={l} style={{fontSize:12,color:S.muted,cursor:"pointer",fontWeight:500}}>{l}</span>)}
          </div>
          <div style={{fontSize:11,color:"#94A3B8"}}>© 2026 AviateSync. All rights reserved.</div>
        </div>
      </footer>

      <style>{`html,body{overscroll-behavior-y:none;background:#F8FAFC;}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}@media(max-width:768px){.lp-how-step{border-right:none!important;border-bottom:1px solid #E2E8F0}}`}</style>
    </div>
  );
}

function ResetPasswordScreen({accessToken, onDone}) {
  const [pw,setPw]=useState(""); const [pw2,setPw2]=useState("");
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  const [done,setDone]=useState(false);

  async function submit(e){
    e.preventDefault(); setErr("");
    if(pw.length<8){ setErr("Password must be at least 8 characters."); return; }
    if(pw!==pw2){ setErr("Passwords don\'t match."); return; }
    setLoading(true);
    try{
      await db_confirmPasswordReset(accessToken, pw);
      setDone(true);
      setTimeout(()=>onDone(), 2000);
    }catch(e){ setErr(e.message); }
    setLoading(false);
  }

  return (
    <div className="auth-wrap" style={{background:C.base,overscrollBehaviorY:"none"}}>
      <div className="auth-card">
        <img src="/icons/logo-wordmark.png" alt="AviateSync" className="auth-logo-img"/>
        <div className="auth-tagline">Set a new password</div>
        {done ? (
          <div style={{padding:"14px 16px",background:"#ECFDF5",border:"1px solid #A7F3D0",borderRadius:10,fontSize:13,color:"#065F46",lineHeight:1.5}}>
            Password updated. Taking you to log in...
          </div>
        ) : (
          <form onSubmit={submit} autoComplete="on">
            {err && <div className="auth-error">{err}</div>}
            <div className="form-group">
              <label className="form-label">New password</label>
              <input className="form-input" type="password" placeholder="••••••••" value={pw} onChange={e=>setPw(e.target.value)} autoComplete="new-password" minLength={8}/>
            </div>
            <div className="form-group">
              <label className="form-label">Confirm new password</label>
              <input className="form-input" type="password" placeholder="••••••••" value={pw2} onChange={e=>setPw2(e.target.value)} autoComplete="new-password" minLength={8}/>
            </div>
            <button type="submit" className="btn-full" disabled={loading}>
              {loading ? <span className="spinner">⟳</span> : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function AuthPage({onAuth, onBack, initialMode="login"}) {
  const [mode,setMode]=useState(initialMode);
  const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [firstName,setFirstName]=useState(""); const [lastName,setLastName]=useState("");
  // This value is no longer sent to the server -- db_signUp() ignores it for
  // real (Supabase-configured) signups. Every account starts on the
  // database's default plan ('starter') with no active subscription; the
  // Stripe webhook is the only thing that ever grants 'pro' /
  // subscription_status='active', and only after a real successful payment.
  const plan="starter";
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  const [resetSent,setResetSent]=useState(false);
  const [savedCred, setSavedCred]=useState(null); // saved email from PasswordCredential
  const [bioLoading, setBioLoading]=useState(false);
  const [savePassword, setSavePassword]=useState(true);

  // Check for saved credentials on mount
  useEffect(()=>{
    if(mode!=="login") return;
    (async()=>{
      try {
        if(!navigator.credentials) return;
        const cred = await navigator.credentials.get({
          password: true,
          mediation: "optional",
        });
        if(cred?.type==="password") {
          setSavedCred({email:cred.id, password:cred.password});
        }
      } catch {}
    })();
  }, [mode]);

  async function submit() {
    setErr(""); setLoading(true);
    try {
      if(mode==="forgot") {
        if(!email) throw new Error("Enter your account email first.");
        await db_requestPasswordReset(email);
        setResetSent(true);
      } else if(mode==="login") {
        const user = await db_signIn(email, password);
        // Save credentials -- triggers browser/Samsung Pass "Save password?" prompt
        if(navigator.credentials && window.PasswordCredential) {
          try {
            const cred = new window.PasswordCredential({id:email, password, name:user.name||email});
            await navigator.credentials.store(cred);
          } catch {}
        }
        onAuth(user);
      } else {
        if(!firstName||!lastName||!email||!password) throw new Error("All fields required.");
        const name = `${firstName.trim()} ${lastName.trim()}`.trim();
        const user = await db_signUp(email,password,name,plan);
        // Save new credentials too
        if(navigator.credentials && window.PasswordCredential) {
          try {
            const cred = new window.PasswordCredential({id:email, password, name:user.name||email});
            await navigator.credentials.store(cred);
          } catch {}
        }
        onAuth(user);
      }
    } catch(e) { setErr(e.message); } finally { setLoading(false); }
  }

  // Sign in with saved biometric credential
  async function bioSignIn() {
    if(!savedCred) return;
    setBioLoading(true); setErr("");
    try {
      const user = await db_signIn(savedCred.email, savedCred.password);
      onAuth(user);
    } catch(e) { setErr(e.message||"Biometric sign-in failed."); }
    finally { setBioLoading(false); }
  }

  const configured = isConfigured();

  return (
    <div className="auth-wrap" style={{background:C.base,overscrollBehaviorY:"none"}}>
      <div className="auth-card">
        <img src="/icons/logo-wordmark.png" alt="AviateSync" className="auth-logo-img"/>
        <div className="auth-tagline">Your automated pilot logbook</div>

        {!configured && (
          <div className="warn" style={{fontSize:12}}>
            ⚠ Running in demo mode. Add <code>VITE_SUPABASE_URL</code> + <code>VITE_SUPABASE_ANON_KEY</code> to connect to your database.
          </div>
        )}

        {mode!=="forgot" && (
          <div className="auth-tabs">
            <button className={`auth-tab ${mode==="login"?"active":""}`} onClick={()=>{setMode("login");setErr("")}}>Log in</button>
            <button className={`auth-tab ${mode==="signup"?"active":""}`} onClick={()=>{setMode("signup");setErr("")}}>Sign up</button>
          </div>
        )}

        {/* Biometric quick sign-in -- shown when saved credentials exist */}
        {mode==="login" && savedCred && (
          <div style={{marginBottom:16,padding:"14px 16px",background:"#F1F5F9",borderRadius:10,border:"1px solid #E2E8F0"}}>
            <div style={{fontSize:12,color:C.muted,marginBottom:8}}>Saved account</div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:13,color:C.ink,fontWeight:500}}>{savedCred.email}</span>
              <button
                onClick={bioSignIn}
                disabled={bioLoading}
                style={{
                  display:"flex",alignItems:"center",gap:6,padding:"8px 14px",
                  borderRadius:8,border:`1px solid ${C.teal}`,background:C.teal+"22",
                  color:C.teal,fontSize:12,fontWeight:600,cursor:"pointer",
                }}>
                {bioLoading?<span className="spinner">⟳</span>:<>🔒 Sign in</>}
              </button>
            </div>
          </div>
        )}

        <form onSubmit={e=>{e.preventDefault();submit();}} autoComplete="on">
        {err && <div className="auth-error">{err}</div>}
        {mode==="forgot" && resetSent && (
          <div style={{padding:"14px 16px",background:C.greenBg,border:"1px solid #A7F3D0",borderRadius:10,marginBottom:16,fontSize:13,color:"#065F46",lineHeight:1.5}}>
            If an account exists for <strong>{email}</strong>, a password reset link is on its way. Check your inbox (and spam folder) — the link expires after 1 hour.
          </div>
        )}
        {mode==="signup" && (
          <div className="auth-row">
            <div className="auth-field">
              <label className="auth-label">First name</label>
              <input className="auth-input" placeholder="Jane" value={firstName} onChange={e=>setFirstName(e.target.value)} autoComplete="given-name" name="firstName"/>
            </div>
            <div className="auth-field">
              <label className="auth-label">Last name</label>
              <input className="auth-input" placeholder="Smith" value={lastName} onChange={e=>setLastName(e.target.value)} autoComplete="family-name" name="lastName"/>
            </div>
          </div>
        )}
        <div className="auth-field">
          <label className="auth-label">Email</label>
          <input className="auth-input" type="email" placeholder="you@airline.com" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" name="email" id="fl-email"/>
        </div>
        {mode!=="forgot" && (
          <div className="auth-field">
            <label className="auth-label">Password</label>
            <input className="auth-input" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} name="password" id="fl-password"/>
          </div>
        )}
        {mode==="login" && (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <span style={{fontSize:12,color:C.muted}}>Your browser will offer to save your password.</span>
            <button type="button" onClick={()=>{setMode("forgot");setErr("");setResetSent(false);}}
              style={{background:"none",border:"none",padding:0,fontSize:12,fontWeight:600,color:C.teal,cursor:"pointer",textDecoration:"underline"}}>
              Forgot password?
            </button>
          </div>
        )}
        <button type="submit" className="btn-full" disabled={loading || (mode==="forgot" && resetSent)}>
          {loading ? <span className="spinner">⟳</span> : mode==="forgot" ? (resetSent?"Email sent":"Send reset link") : mode==="login"?"Log in":"Create account"}
        </button>
        </form>
        {(mode==="login"||mode==="signup")&&(
          <>
            <div style={{display:"flex",alignItems:"center",gap:10,margin:"16px 0"}}>
              <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
              <span style={{fontSize:11,color:"#94A3B8",fontWeight:600}}>OR</span>
              <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
            </div>
            <button
              type="button"
              onClick={()=>{
                // Redirect-based OAuth via GoTrue directly (this app has no
                // Supabase JS SDK -- sb.auth is hand-rolled fetch calls, and
                // OAuth is a full-page redirect rather than a request/response,
                // so it can't go through sb.auth the way password sign-in does).
                // GoTrue sends the browser to Google's consent screen, then
                // back here with tokens in the URL hash -- caught by the
                // oauth-callback effect near the top-level App component.
                window.location.href = `${SUPA_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(window.location.origin)}`;
              }}
              style={{width:"100%",padding:"12px",borderRadius:14,border:"1px solid #E2E8F0",background:"#fff",color:"#0F172A",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}
            >
              <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>
            {/* Apple sign-in intentionally removed for now (to be re-added
                later) -- this is a straightforward re-add: same GoTrue
                /authorize?provider=apple pattern as Google above, plus
                whatever Apple Developer Program / Services ID setup that
                provider needs on the Supabase dashboard side. */}
          </>
        )}
        {mode==="forgot" ? (
          <button className="auth-back" onClick={()=>{setMode("login");setErr("");setResetSent(false);}}>← Back to log in</button>
        ) : (
          <button className="auth-back" onClick={onBack}>← Back to home</button>
        )}
        {!configured && mode==="login" && (
          <div style={{marginTop:16,padding:"10px 14px",background:"#F1F5F9",borderRadius:8,fontSize:12,color:C.muted}}>
            <div style={{marginBottom:4,color:C.silver,fontWeight:600}}>Demo accounts</div>
            <div>Admin: admin@flightlog.app / admin1234</div>
            <div>Pilot: pilot@example.com / pilot123</div>
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// SIDEBAR
// -----------------------------------------------------------------------------
function Sidebar({user,page,setPage,onLogout}) {
  const isAdmin=user.role==="admin";
  const pilotNav=[
    {id:"dashboard",icon:"⊞",label:"Dashboard"},
    {id:"calendar",icon:"▦",label:"Calendar"},
    {id:"upload",icon:"⊕",label:"Upload Roster"},
    {id:"logbook",icon:"≡",label:"Logbook"},
    {id:"map",icon:"⊗",label:"Route Map"},
    {id:"analytics",icon:"⟁",label:"Stats"},
    {id:"settings",icon:"◎",label:"Settings"},
  ];
  const adminNav=[
    {id:"admin-overview",icon:"◈",label:"Overview"},
    {id:"admin-users",icon:"👥",label:"Users"},
    {id:"admin-audit",icon:"🔍",label:"Audit Logs"},
    {id:"admin-rosters",icon:"📄",label:"All Rosters"},
    {id:"admin-settings",icon:"⚙",label:"Settings"},
  ];
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-text">Aviate<span>Sync</span></div>
        <div className="sidebar-plan">{isAdmin?"Admin Console":user.plan+" plan"}</div>
      </div>
      <nav className="sidebar-nav">
        {(isAdmin?adminNav:pilotNav).map(item=>(
          <button key={item.id} className={`sidebar-item ${page===item.id?"active":""}`} onClick={()=>setPage(item.id)}>
            <span className="sidebar-item-icon">{item.icon}</span>{item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{initials(user.name)}</div>
          <div>
            <div className="sidebar-user-name">{user.name?.split(" ")[0]}</div>
            <div className="sidebar-user-role">{isAdmin?"Administrator":"Pilot · "+user.plan}</div>
          </div>
          <button className="sidebar-logout" onClick={onLogout} title="Log out">⏻</button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// HAMBURGER DRAWER -- replaces the bottom tab bar on mobile
// -----------------------------------------------------------------------------
function HamburgerDrawer({user, page, setPage, onLogout, open, onClose}) {
  const isAdmin = user.role === "admin";
  const pilotNav = [
    {id:"dashboard",  icon:"⊞",  label:"Dashboard"},
    {id:"calendar",   icon:"▦", label:"Calendar"},
    {id:"upload",     icon:"⊕",  label:"Upload Roster"},
    {id:"logbook",    icon:"≡", label:"Logbook"},
    {id:"map",        icon:"⊗", label:"Route Map"},
    {id:"analytics",  icon:"⟁", label:"Stats"},
    {id:"settings",   icon:"◎",  label:"Settings"},
  ];
  const adminNav = [
    {id:"admin-overview", icon:"◈",  label:"Overview"},
    {id:"admin-users",    icon:"👥", label:"Users"},
    {id:"admin-audit",    icon:"🔍", label:"Audit Logs"},
    {id:"admin-rosters",  icon:"📄", label:"All Rosters"},
    {id:"admin-settings", icon:"⚙",  label:"Settings"},
  ];
  const items = isAdmin ? adminNav : pilotNav;
  if(!open) return null;
  return (
    <>
      <div className="drawer-overlay" onClick={onClose}/>
      <div className="drawer-panel">
        <div className="drawer-header">
          <div className="drawer-logo">Aviate<span>Sync</span></div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </div>
        <nav className="drawer-nav">
          {items.map(item=>(
            <button key={item.id} className={`drawer-item ${page===item.id?"active":""}`}
              onClick={()=>{setPage(item.id);onClose();}}>
              <span className="drawer-item-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="drawer-footer">
          <button className="drawer-item" style={{color:C.red}} onClick={onLogout}>
            <span className="drawer-item-icon">⎋</span>Sign out
          </button>
          {user.name&&<div style={{fontSize:11,color:C.muted,marginTop:8,paddingLeft:12}}>{user.name}</div>}
        </div>
      </div>
    </>
  );
}

function MobileNav() { return null; } // kept as stub to avoid breaking any refs

// -----------------------------------------------------------------------------
// DASHBOARD
// -----------------------------------------------------------------------------
function PageHeader({title}) {
  return (
    <div style={{
      padding:"16px 16px 12px",
      borderBottom:`1px solid ${C.border}`,
      background:C.surface,
      flexShrink:0,
    }}>
      <div style={{fontSize:22,fontWeight:700,color:C.ink,letterSpacing:"-0.3px"}}>{title}</div>
    </div>
  );
}

// -- Add Flight Page
function AddFlightPage({user, rosters, onRosterSaved, setPage}) {
  const S = getS();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;

  const [form, setForm] = useState({
    date:todayStr, flightNum:"", dep:"", depTime:"", arr:"", arrTime:"",
    acType:"", tail:"", picTime:"", sicTime:"", nightTime:"", xcTime:"",
    actualIfr:"", simIfr:"", multiEngTime:"", singleEngTime:"", dayLdg:0, nightLdg:0, approaches:0, approachTypes:[],
    remarks:"", isXC:false, isPIC:false, isSIC:true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState(false);

  function set(k,v){setForm(p=>({...p,[k]:v}));}

  function computeBlock(){
    if(form.depTime&&form.arrTime){
      const [dh,dm]=form.depTime.split(":").map(Number);
      const [ah,am]=form.arrTime.split(":").map(Number);
      let mins=(ah*60+am)-(dh*60+dm);
      if(mins<0)mins+=24*60;
      return mins;
    }
    return null;
  }

  async function save(){
    if(!form.date){setErr("Date is required.");return;}
    if(!form.dep||!form.arr){setErr("Departure and arrival airports are required.");return;}
    setSaving(true); setErr("");
    try{
      // Find or create roster for this month
      const [yr,mo] = form.date.split("-").map(Number);
      const monthNum = mo-1;
      // Always re-fetch fresh from DB before saving to avoid stale snapshot
      // overwrites when the user adds multiple flights quickly in sequence.
      // The props `rosters` may not have updated yet between rapid saves.
      let freshRosters = rosters;
      try { freshRosters = await db_loadRosters(user.id); } catch {}
      let roster = freshRosters.find(r=>(r.monthNum??r.month_num??0)===monthNum&&r.year===yr)
                || rosters.find(r=>(r.monthNum??r.month_num??0)===monthNum&&r.year===yr);
      const computedBlock = computeBlock() || 0;
      const flight = {
        flightNum:form.flightNum||"MANUAL",
        dep:form.dep.toUpperCase().slice(0,4),
        depTime:form.depTime,
        arr:form.arr.toUpperCase().slice(0,4),
        arrTime:form.arrTime,
        acType:form.acType.toUpperCase().slice(0,6)||"",
        schedBlockMins:computeBlock(),
        ...(form.remarks?{remarks:form.remarks}:{}),
        ...((form.dayLdg>0||form.nightLdg>0)?{
          loggedDayLandings:form.dayLdg||0,
          loggedNightLandings:form.nightLdg||0,
          loggedLandings:(form.dayLdg||0)+(form.nightLdg||0),
        }:{}),
        ...(form.approaches>0?{
          loggedApproaches:form.approaches,
          approachTypes:(form.approachTypes||[]).slice(0,form.approaches),
        }:{}),
        // Pilot Function -- explicit per-flight override, takes precedence
        // over any date-based Time Rule for this specific leg.
        loggedPicMins: form.isPIC ? computedBlock : 0,
        loggedSicMins: form.isSIC ? computedBlock : 0,
        // Time breakdown -- only persisted when actually entered, so an
        // empty field doesn't zero out a value some other mechanism (solar
        // night calc, distance-based XC) would otherwise have supplied.
        ...(form.nightTime ? {loggedNightMins:parseHM(form.nightTime)} : {}),
        ...(form.xcTime    ? {loggedXcMins:parseHM(form.xcTime)}       : {}),
        ...(form.actualIfr ? {loggedActualIfrMins:parseHM(form.actualIfr)} : {}),
        ...(form.simIfr    ? {loggedSimIfrMins:parseHM(form.simIfr)}       : {}),
        ...(form.multiEngTime  ? {loggedMultiEngMins:parseHM(form.multiEngTime)}   : {}),
        ...(form.singleEngTime ? {loggedSingleEngMins:parseHM(form.singleEngTime)} : {}),
      };
      const dayNum = parseInt(form.date.split("-")[2]);
      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(form.date+"T12:00:00").getDay()];

      let savedRosterId, di, fi;

      if(!roster){
        // Create new roster for this month
        const newRoster = {
          id:Date.now().toString(),
          periodLabel:`${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][monthNum]} ${yr}`,
          year:yr,monthNum,
          calendar:[{day:dayNum,dow,isOff:false,dutyCode:null,flights:[flight]}],
          uploadedAt:new Date().toISOString(),
          _manual:true,
        };
        const saved = await db_saveRoster(user.id, newRoster, {skipMergeProtection:true});
        onRosterSaved(saved||newRoster);
        savedRosterId = saved?.id || newRoster.id;
        di = 0; fi = 0;
      } else {
        const nc = [...(roster.calendar||[])];
        const dayIdx = nc.findIndex(d=>d.day===dayNum);
        if(dayIdx>=0){
          fi = (nc[dayIdx].flights||[]).length; // new flight lands at the end of today's list
          nc[dayIdx]={...nc[dayIdx],flights:[...(nc[dayIdx].flights||[]),flight]};
          di = dayIdx;
        } else {
          nc.push({day:dayNum,dow,isOff:false,dutyCode:null,flights:[flight]});
          nc.sort((a,b)=>a.day-b.day);
          di = nc.findIndex(d=>d.day===dayNum); // re-find post-sort position
          fi = 0;
        }
        await db_saveRoster(user.id,{...roster,calendar:nc},{skipMergeProtection:true});
        onRosterSaved({...roster,calendar:nc});
        savedRosterId = roster.id;
      }

      // Save the tail number -- this used to be a no-op stub; now that we
      // track the exact day/flight index the new leg landed at, we can
      // build the correct composite key and persist it for real.
      if(form.tail){
        try { await db_saveTail(user.id, savedRosterId, `${di}-${fi}`, form.tail); }
        catch(e) { /* tail save is best-effort -- the flight itself already saved above */ }
      }

      // Feed the dashboard bell: manually added flight
      logNotifEvent({type:"edit",id:`add-${flight.flightNum}-${form.date}-${Date.now()}`,
        label:`${flight.flightNum} added manually`,
        sub:`${flight.dep} → ${flight.arr} · ${form.date}`});

      setSuccess(true);
      setTimeout(()=>{setPage&&setPage("active-logs");},1200);
    }catch(e){setErr(e.message||"Save failed.");}
    setSaving(false);
  }

  const INPUT = {
    padding:"11px 14px",borderRadius:12,border:`1.5px solid ${S.border}`,
    fontSize:15,background:S.surface,color:S.ink,outline:"none",
    width:"100%",boxSizing:"border-box",fontFamily:"Inter,system-ui,sans-serif",
  };
  const LABEL = {fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:5,display:"block"};
  const SECTION = {background:S.surface,borderRadius:18,border:`1px solid ${S.border}`,padding:"16px 18px",marginBottom:14};

  if(success) return(
    <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14,background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
      <div style={{width:64,height:64,borderRadius:"50%",background:C.greenBg,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      <div style={{fontSize:18,fontWeight:800,color:S.ink}}>Flight Added</div>
      <div style={{fontSize:13,color:S.muted}}>Redirecting to Active Logs...</div>
    </div>
  );

  return(
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
      {/* Header */}
      <div style={{padding:"14px 18px",background:S.surface,borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10,backdropFilter:"blur(12px)"}}>
        <button onClick={()=>setPage&&setPage("dashboard")} style={{width:36,height:36,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke={S.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div style={{flex:1}}>
          <div style={{fontSize:18,fontWeight:800,color:S.ink,letterSpacing:"-.3px"}}>Add Flight</div>
          <div style={{fontSize:12,color:S.muted}}>Manually log a flight to your record</div>
        </div>
        <button onClick={save} disabled={saving} style={{padding:"9px 20px",borderRadius:12,background:saving?"#94A3B8":"linear-gradient(135deg,#1D4ED8,#3B82F6)",border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:saving?"not-allowed":"pointer",boxShadow:"0 4px 12px rgba(29,78,216,0.3)"}}>
          {saving?"⟳":"Save"}
        </button>
      </div>

      <div style={{padding:"16px 16px 80px",maxWidth:560,margin:"0 auto"}}>
        {err&&<div style={{padding:"10px 14px",borderRadius:10,background:C.redBg,border:"1px solid #FECACA",color:C.red,fontSize:13,marginBottom:12}}>{err}</div>}

        {/* Date */}
        <div style={SECTION}>
          <label style={LABEL}>Flight Date</label>
          <input type="date" value={form.date} onChange={e=>set("date",e.target.value)} style={{...INPUT,fontSize:16}} max={todayStr}/>
        </div>

        {/* Flight Info */}
        <div style={SECTION}>
          <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:12}}>Flight Information</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <div>
              <label style={LABEL}>Flight Number</label>
              <input type="text" placeholder="e.g. 1234" value={form.flightNum} onChange={e=>set("flightNum",e.target.value.toUpperCase())} style={INPUT}/>
            </div>
            <div>
              <label style={LABEL}>Aircraft Type</label>
              <input type="text" placeholder="CRJ7" value={form.acType} onChange={e=>set("acType",e.target.value.toUpperCase().slice(0,6))} style={INPUT}/>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:10,alignItems:"end",marginBottom:10}}>
            <div>
              <label style={LABEL}>Departure</label>
              <input type="text" placeholder="ORD" maxLength={4} value={form.dep} onChange={e=>set("dep",e.target.value.toUpperCase())} style={{...INPUT,textTransform:"uppercase"}}/>
            </div>
            <div style={{paddingBottom:12,color:S.muted,textAlign:"center"}}>→</div>
            <div>
              <label style={LABEL}>Arrival</label>
              <input type="text" placeholder="DSM" maxLength={4} value={form.arr} onChange={e=>set("arr",e.target.value.toUpperCase())} style={{...INPUT,textTransform:"uppercase"}}/>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div>
              <label style={LABEL}>Out / Depart</label>
              <input type="time" value={form.depTime} onChange={e=>set("depTime",e.target.value)} style={INPUT}/>
            </div>
            <div>
              <label style={LABEL}>In / Arrive</label>
              <input type="time" value={form.arrTime} onChange={e=>set("arrTime",e.target.value)} style={INPUT}/>
            </div>
          </div>
          {computeBlock()&&<div style={{fontSize:12,color:S.blue,fontWeight:600,marginTop:8}}>Computed block: {fmtMins(computeBlock())}</div>}
        </div>

        {/* Tail Number */}
        <div style={SECTION}>
          <label style={LABEL}>Tail Number</label>
          <input type="text" placeholder="N542GJ" maxLength={8} value={form.tail} onChange={e=>set("tail",e.target.value.toUpperCase())} style={{...INPUT,fontFamily:"monospace"}}/>
        </div>

        {/* Pilot Function */}
        <div style={SECTION}>
          <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:12}}>Pilot Function</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["PIC","isPIC"],["SIC","isSIC"]].map(([lbl,k])=>(
              <button key={k} onClick={()=>{set("isPIC",k==="isPIC");set("isSIC",k==="isSIC");}} style={{padding:"12px",borderRadius:12,border:`1.5px solid ${form[k]?S.blue:S.border}`,background:form[k]?C.blueBg:S.surface,color:form[k]?S.blue:S.muted,fontSize:14,fontWeight:700,cursor:"pointer"}}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Time breakdown */}
        <div style={SECTION}>
          <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:12}}>Time Breakdown (h:mm)</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["Night","nightTime"],["Cross Country","xcTime"],["Actual IMC","actualIfr"],["Hood / Sim","simIfr"],["Multi Eng","multiEngTime"],["Single Eng","singleEngTime"]].map(([lbl,k])=>(
              <div key={k}>
                <label style={LABEL}>{lbl}</label>
                <input type="text" placeholder="0:00" value={form[k]} onChange={e=>set(k,e.target.value)} style={INPUT}/>
              </div>
            ))}
          </div>
        </div>

        {/* Landings & Approaches */}
        <div style={SECTION}>
          <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:12}}>Landings & Approaches</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            {[["Day Ldg","dayLdg"],["Night Ldg","nightLdg"],["Approaches","approaches"]].map(([lbl,k])=>(
              <div key={k}>
                <label style={LABEL}>{lbl}</label>
                <input type="text" inputMode="numeric" placeholder="0"
                  value={form[k]===0?"":String(form[k])}
                  onChange={e=>{
                    const raw=e.target.value.replace(/[^0-9]/g,"");
                    const n=raw===""?0:Math.min(99,parseInt(raw));
                    if(k==="approaches"){
                      const types=[...(form.approachTypes||[])];
                      types.length=n; for(let i=0;i<n;i++) if(!types[i]) types[i]="ILS";
                      set("approachTypes",types);
                    }
                    set(k,n);
                  }}
                  style={{...INPUT,textAlign:"center"}}/>
              </div>
            ))}
          </div>
          {form.approaches>0&&(
            <div style={{marginTop:12,display:"grid",gridTemplateColumns:form.approaches>1?"1fr 1fr":"1fr",gap:10}}>
              {Array.from({length:form.approaches},(_,i)=>(
                <div key={i}>
                  <label style={LABEL}>Approach {i+1} type</label>
                  <select
                    value={form.approachTypes?.[i]||"ILS"}
                    onChange={e=>{
                      const types=[...(form.approachTypes||[])];
                      types[i]=e.target.value;
                      set("approachTypes",types);
                    }}
                    style={{...INPUT,appearance:"auto",WebkitAppearance:"menulist",cursor:"pointer"}}>
                    {["ILS","RNAV (GPS)","VOR","LOC","LOC-BC","RNP","NDB","VISUAL","CIRCLING","PAR"].map(t=>
                      <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Remarks */}
        <div style={SECTION}>
          <label style={LABEL}>Remarks / Notes</label>
          <textarea rows={3} placeholder="IOE, checkride, special ops..." value={form.remarks} onChange={e=>set("remarks",e.target.value)} style={{...INPUT,resize:"vertical",minHeight:72,lineHeight:1.5}}/>
        </div>

      </div>
    </div>
  );
}


function Dashboard({user,rosters,tails,setPage,onOpenFlight}) {
  const [wx,setWx]=useState({});
  const [wxLoading,setWxLoading]=useState(false);
  const [miniBriefing,setMiniBriefing]=useState(null);
  const [briefingLoading,setBriefingLoading]=useState(false);
  const [notifOpen,setNotifOpen]=useState(false);
  const [searchOpen,setSearchOpen]=useState(false);
  const [query,setQuery]=useState("");
  const [dismissedNotifs,setDismissedNotifs]=useState(getDismissedNotifs());

  const now=new Date();
  const firstName=(user?.name||user?.email||"Pilot").split(/\s|@/)[0];

  // Formats the countdown to next duty: shows whole days while more than
  // 24 hours away, then switches to hours (and minutes once under 1 hour)
  // once inside the 24-hour window before departure.
  function formatDutyCountdown(minsToGo){
    if(minsToGo==null||isNaN(minsToGo)) return "";
    if(minsToGo<0) return "now";
    const hrs = minsToGo/60;
    if(hrs>=24){
      const days = Math.floor(hrs/24);
      const remHrs = Math.round(hrs%24);
      return remHrs>0 ? `${days}d ${remHrs}h` : `${days}d`;
    }
    const h = Math.floor(minsToGo/60);
    const m = minsToGo%60;
    if(h>0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Today flights using local date
  const todayFlights=useMemo(()=>{
    const results=[];
    const localToday=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
    for(const roster of rosters){
      const mNum=roster.monthNum??roster.month_num??0;
      for(let di=0;di<(roster.calendar||[]).length;di++){
        const day=roster.calendar[di];
        const dateStr=`${roster.year}-${String(mNum+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
        if(dateStr!==localToday) continue;
        for(let fi=0;fi<(day.flights||[]).length;fi++){
          const f=day.flights[fi];
          const tk=`${roster.id}-${di}-${fi}`;
          const tail=tails[tk]||{};
          results.push({f,day,roster,di,fi,tk,tail,dateStr});
        }
      }
    }
    return results;
  },[rosters,tails]);

  // Next future flight -- nearest upcoming, within 30 days
  const nextFlight=useMemo(()=>{
    const upcoming=[];
    const nowTs=Date.now();
    const cutoff=nowTs+(30*24*60*60*1000); // 30 day lookahead
    for(const roster of rosters){
      const mNum=roster.monthNum??roster.month_num??0;
      for(let di=0;di<(roster.calendar||[]).length;di++){
        const day=roster.calendar[di];
        const dateStr=`${roster.year}-${String(mNum+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
        for(let fi=0;fi<(day.flights||[]).length;fi++){
          const f=day.flights[fi];
          if(!f.depTime||!f.dep) continue;
          const tk=`${roster.id}-${di}-${fi}`;
          const tail=tails[tk]||{};
          if(tail.cancelled) continue;
          const [h,m]=(f.depTime||"00:00").split(":").map(Number);
          const [yr,mo,dy]=dateStr.split("-").map(Number);
          // Build the departure instant using the DEPARTURE AIRPORT's own
          // timezone, not the viewing device's local timezone. The previous
          // `new Date(yr,mo-1,dy,h,m)` construction always interprets those
          // values in whatever timezone the browser/device happens to be
          // set to -- meaning the SAME flight could compute a different
          // "is this upcoming" instant depending on which timezone the
          // pilot's phone is in, exactly the class of bug already found and
          // fixed in the server-side sync scheduling (GRB/TVC).
          const offsetMins = getAirportUtcOffsetMins(f.dep, new Date(Date.UTC(yr,mo-1,dy,12,0)));
          const dtTs = Date.UTC(yr,mo-1,dy,h,m) - offsetMins*60000;
          if(dtTs>nowTs&&dtTs<cutoff) upcoming.push({f,day,roster,di,fi,tk,tail,dateStr,dt:dtTs});
        }
      }
    }
    upcoming.sort((a,b)=>a.dt-b.dt);
    return upcoming[0]||null;
  },[rosters,tails]);

  const depAirport=nextFlight?.f?.dep;

  // Auto-fetch gate info when within 3 hours of departure
  useEffect(()=>{
    if(!nextFlight) return;
    const {f,tk,tail,dateStr,dt}=nextFlight;
    const minsToGo=Math.round((dt-Date.now())/60000);
    if(minsToGo>180||minsToGo<-60) return;
    if(tail?.depGate||tail?.arrGate) return; // Already have gate
    const token=sb.auth._token||SUPA_ANON;
    fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
      body:JSON.stringify({flightNum:f.flightNum,date:dateStr,dep:f.dep,arr:f.arr,depTime:f.depTime}),
    }).then(r=>r.json()).then(d=>{
      if(d.depGate||d.arrGate){
        // Persist gate via db_saveTail then trigger re-render via setPage trick
        const parts=tk.split("-");
        const rosterId=parts.slice(0,-2).join("-");
        const flightKey=`${parts[parts.length-2]}-${parts[parts.length-1]}`;
        db_saveTail(user?.id,rosterId,flightKey,d.tail||tail?.tail||"",d.actualDep||"",d.actualArr||"",d.actualBlockMins??null,false,null,d.depGate,d.arrGate)
          .catch(()=>{});
      }
    }).catch(()=>{});
  },[nextFlight?.tk]);


  // Weather
  useEffect(()=>{
    if(!depAirport||wx[depAirport]) return;
    setWxLoading(true);
    const ICAO_ALIASES={SCE:"UNV"};
    const base=depAirport.length===3?"K"+depAirport:depAirport;
    const alt=ICAO_ALIASES[depAirport]?("K"+ICAO_ALIASES[depAirport]):null;
    const tryFetch=(icao)=>fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=2`).then(r=>r.json());
    tryFetch(base).then(data=>{
      if(data?.[0]) return data;
      if(alt) return tryFetch(alt);
      return null;
    }).then(data=>{
      if(data?.[0]){
        const m=data[0];
        setWx(prev=>({...prev,[depAirport]:{
          raw:m.rawOb,
          temp:m.temp!=null?Math.round(m.temp*9/5+32)+"°F":null,
          wind:m.wdir!=null?`${m.wdir}°@${m.wspd}kts`:"Calm",
          vis:m.visib!=null?`${m.visib}SM`:null,
          ceiling:m.clouds?m.clouds.filter(c=>["BKN","OVC","OVX"].includes(c.cover))[0]:null,
          flight_category:m.fltcat||"VFR",
        }}));
      }
    }).catch(()=>{}).finally(()=>setWxLoading(false));
  },[depAirport]);

  // AI Briefing
  const [briefingExpiresAt,setBriefingExpiresAt]=useState(null);
  const briefKey=nextFlight?`fl_mini_brief_${nextFlight.f.flightNum}_${nextFlight.dateStr}`:"";
  useEffect(()=>{
    if(!briefKey) return;
    try{const c=localStorage.getItem(briefKey);if(c){const p=JSON.parse(c);if(Date.now()-p.ts<3600000){setMiniBriefing(p.text);setBriefingExpiresAt(p.ts+3600000);}}}catch{}
  },[briefKey]);
  // Re-render once a minute so the "next update in Xm" countdown ticks down
  // without a full refetch -- a minute-granularity countdown doesn't need a
  // faster clock, and this avoids a wasteful per-second timer.
  const [, forceTick] = useState(0);
  useEffect(()=>{
    const iv = setInterval(()=>forceTick(t=>t+1), 60000);
    return ()=>clearInterval(iv);
  },[]);

  async function fetchMiniBriefing(){
    if(!nextFlight||briefingLoading) return;
    if(!briefingEligible(nextFlight.f?.dep, nextFlight.dateStr, nextFlight.f?.depTime)) {
      setMiniBriefing("AI briefing is only available for flights departing within 24 hours.");
      setBriefingExpiresAt(null);
      return;
    }
    setBriefingLoading(true);
    try{
      const f=nextFlight.f;
      const wxInfo=wx[f.dep];
      const prompt=`Brief this flight for an airline pilot: ${f.flightNum} ${f.dep}→${f.arr} on ${nextFlight.dateStr} departing ${f.depTime}. Aircraft: ${f.acType||"regional jet"}. ${wxInfo?`Current ${f.dep} weather: ${wxInfo.raw||"not available"}.`:""} Give a concise 3-paragraph briefing: departure weather, enroute conditions, arrival. Include any relevant NOTAMs or cautions. Be direct and professional.`;
      const briefRes=await fetch(`${SUPA_URL}/functions/v1/flight-briefing`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f.flightNum,dep:f.dep,arr:f.arr,date:nextFlight.dateStr,depTime:f.depTime,acType:f.acType})});
      const d=await briefRes.json();
      const text=d.briefing||d.text||d.content?.[0]?.text||"Briefing unavailable.";
      setMiniBriefing(text);
      try{const ts=Date.now();localStorage.setItem(briefKey,JSON.stringify({text,ts}));setBriefingExpiresAt(ts+3600000);}catch{}
    }catch{setMiniBriefing("Briefing unavailable -- check connection.");}
    setBriefingLoading(false);
  }

  // Stats
  const stats=useMemo(()=>{
    const nowD=new Date(), curY=nowD.getFullYear(), curM=nowD.getMonth();
    let totalMins=0,legs=0,airports=new Set(),synced=0,night=0;
    let mtdMins=0, mtdDutyDays=0;
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      const isCurMonth = r.year===curY && mNum===curM;
      (r.calendar||[]).forEach((d,di)=>{
        // Duty days this month: any day with flights (incl. deadhead
        // positioning) or a duty code (Sby/LCR/...) counts as duty.
        if(isCurMonth && (((d.flights||[]).length>0) || d.dutyCode)) mtdDutyDays++;
        (d.flights||[]).forEach((f,fi)=>{
          const tk=`${r.id}-${di}-${fi}`;
          const t=tails[tk]||{};
          if(t.cancelled) return;
          if(f.isDeadhead) return; // deadhead doesn't count toward block hours
          legs++;
          if(f.dep) airports.add(f.dep);
          if(f.arr) airports.add(f.arr);
          if(t.tail) synced++;
          // loggedMins first: imported logbook history carries the pilot's
          // own totals — "Total Hours to Date" = prior logbooks + this app.
          const mins=f.loggedMins!=null?f.loggedMins:(t.actualBlockMins??schedMins(f)??0);
          totalMins+=mins;
          if(isCurMonth) mtdMins+=mins;
          const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
          const solar=(f.depTime&&f.arrTime)?computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr):null;
          if(solar&&(solar.nightDep||solar.nightArr)) night+=Math.round((mins||0)*0.3);
        });
      });
    }
    return{hours:fmtMins(totalMins),legs,airports:airports.size,synced,nightHrs:fmtMins(night),
           hoursMTD:fmtMins(mtdMins),dutyDaysMTD:mtdDutyDays};
  },[rosters,tails]);

  // FAR 117 duty limit estimate
  const dutyPct=useMemo(()=>{
    const now2=new Date();
    const monthStart=new Date(now2.getFullYear(),now2.getMonth(),1);
    let mins=0;
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      if(r.year!==now2.getFullYear()||mNum!==now2.getMonth()) continue;
      (r.calendar||[]).forEach((d,di)=>(d.flights||[]).forEach((f,fi)=>{
        const tk=`${r.id}-${di}-${fi}`;
        const t=tails[tk]||{};
        mins+=t.actualBlockMins??schedMins(f)??0;
      }));
    }
    return Math.min(100,Math.round((mins/60)/100*100));
  },[rosters,tails]);

  const wxInfo=wx[depAirport]||null;
  const fltCat=wxInfo?.flight_category||"VFR";
  const catColor=fltCat==="VFR"?"#16A34A":fltCat==="MVFR"?"#2563EB":fltCat==="IFR"?"#DC2626":"#C026D3"/*LIFR magenta -- aviation chart convention*/;

  // ---- Notifications & universal search ------------------------------------
  const MONTHS_FU=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const agoLabel=(ts)=>{const d=Date.now()-ts;if(d<0)return"upcoming";const h=Math.floor(d/36e5);if(h<1)return"just now";if(h<24)return`${h}h ago`;const days=Math.floor(h/24);if(days<30)return`${days}d ago`;return`${Math.floor(days/30)}mo ago`;};

  // Open a flight detail from a search/notification hit -- same payload the
  // upcoming-flight card builds on click.
  const openFlightItem=(it)=>{
    if(!onOpenFlight) return;
    const {f,day,roster,di,fi,tk,tail,dateStr}=it;
    const dist2=calcDist(f.dep,f.arr);
    onOpenFlight({f,day,roster,di,fi,tk,tail,dateStr,dist:dist2,solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr),blockMins:tail.actualBlockMins??schedMins(f)??0,hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),dep:f.dep,arr:f.arr,isXC:(dist2||0)>50,userId:user?.id});
  };

  // Derive the bell feed: auto-sync (last 7 days), manual edits (event log,
  // last 14 days), and past-due unsigned months. Filtered by prefs.
  const notifications=useMemo(()=>{
    const items=[]; const nowTs=Date.now(); const weekAgo=nowTs-7*864e5;
    const prefs=getNotifPrefs();
    let sm={}; try{sm=JSON.parse(localStorage.getItem("fl_signed_months")||"{}");}catch{}
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      if(prefs.signReminders){
        const monthEnd=new Date(r.year,mNum+1,0,23,59).getTime();
        const hasFlights=(r.calendar||[]).some(d=>(d.flights||[]).length>0);
        if(hasFlights&&monthEnd<nowTs&&!sm[r.id]){
          items.push({id:`sign-${r.id}`,type:"sign",ts:monthEnd,
            title:`${MONTHS_FU[mNum]||""} ${r.year} needs verification & signature`,
            sub:"Past-due active log -- review and sign to lock your records",
            action:()=>{PENDING_ROSTER_ID=r.id;setPage("logbook");}});
        }
      }
      if(prefs.sync){
        (r.calendar||[]).forEach((d,di)=>{
          const dTs=new Date(r.year,mNum,d.day).getTime();
          if(dTs<weekAgo||dTs>nowTs+864e5) return;
          const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
          (d.flights||[]).forEach((f,fi)=>{
            const tk=`${r.id}-${di}-${fi}`; const t=tails[tk]||{};
            if(t.cancelled||f.isDeadhead) return;
            if(t.tail||t.actualBlockMins!=null){
              const bm=t.actualBlockMins;
              items.push({id:`sync-${tk}`,type:"sync",ts:dTs,
                title:`${f.flightNum||"Flight"} synced automatically`,
                sub:`${f.dep} → ${f.arr}${t.tail?` · ${t.tail}`:""}${bm!=null?` · ${Math.floor(bm/60)}:${String(bm%60).padStart(2,"0")}`:""}`,
                action:()=>openFlightItem({f,day:d,roster:r,di,fi,tk,tail:t,dateStr})});
            }
          });
        });
      }
      if(prefs.upcoming24h){
        // Pairing-aware: only the FIRST flight of each pairing (the run of
        // duty days between two off-days) generates a notification, and
        // only at the 24h and 12h marks specifically -- not a per-leg
        // countdown for every flight in a multi-leg day. A "day off" uses
        // the same definition as the rest of the app (CalendarPage): no
        // flights AND no standby/duty code means off.
        //
        // Departure instants are computed using the DEPARTURE AIRPORT's
        // own timezone (getAirportUtcOffsetMins), not device-local time --
        // the same class of bug already found and fixed in the dashboard's
        // nextFlight calculation applies equally here: a pairing's first
        // flight shouldn't fire at the wrong real-world moment just
        // because the pilot's phone happens to be in a different zone
        // than the departure airport.
        //
        // KNOWN LIMITATION: pairing detection runs within a single
        // roster/month. A pairing that starts in the last days of one
        // month and continues into the next (spanning the month boundary)
        // is not stitched across rosters here -- the first day of the new
        // month would be treated as a fresh pairing start even if the
        // pilot was still on duty from the prior month. This matches the
        // existing carryover-day handling's general shape but is worth
        // flagging explicitly rather than silently getting it wrong.
        const cal=(r.calendar||[]).slice().sort((a,b)=>a.day-b.day);
        let prevWasOff=true; // treat the start of the roster as "coming from off"
        for(const d of cal){
          const hasFlights=(d.flights||[]).length>0;
          const isOffDay=!d||d.isOff||(!hasFlights&&!d.dutyCode);
          if(isOffDay){ prevWasOff=true; continue; }
          // This is a duty day. If it immediately follows an off day, it's
          // the start of a new pairing -- find its first real flight.
          if(prevWasOff && hasFlights){
            const di=(r.calendar||[]).findIndex(dd=>dd.day===d.day);
            const firstFlight=(d.flights||[]).find(f=>f.depTime&&f.dep&&!f.isDeadhead) || (d.flights||[]).find(f=>f.depTime&&f.dep);
            if(firstFlight){
              const fi=(d.flights||[]).indexOf(firstFlight);
              const tk=`${r.id}-${di}-${fi}`; const t=tails[tk]||{};
              if(!t.cancelled){
                const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
                const [h,m]=(firstFlight.depTime||"00:00").split(":").map(Number);
                const offsetMins=getAirportUtcOffsetMins(firstFlight.dep, new Date(Date.UTC(r.year,mNum,d.day,12,0)));
                const depUtcMs=Date.UTC(r.year,mNum,d.day,h||0,m||0)-offsetMins*60000;
                const hrsToGo=(depUtcMs-nowTs)/3600000;
                // Fire once per mark, within a 30-minute window either side
                // -- this memo recomputes on data changes, not a steady
                // clock tick, so a window (not an exact instant) is needed
                // to reliably catch each mark at least once.
                const near24h = hrsToGo<=24.5 && hrsToGo>=23.5;
                const near12h = hrsToGo<=12.5 && hrsToGo>=11.5;
                if((near24h||near12h) && depUtcMs>nowTs){
                  const mark = near24h ? 24 : 12;
                  items.push({id:`upcoming-pairing-${tk}-${mark}h`,type:"upcoming",ts:depUtcMs-mark*3600000,
                    title:`${firstFlight.flightNum||"Flight"} (first of pairing) departs in ${mark}h`,
                    sub:`${firstFlight.dep} → ${firstFlight.arr}${firstFlight.isDeadhead?" · Deadhead":""}${t.tail?` · ${t.tail}`:""}`,
                    action:()=>openFlightItem({f:firstFlight,day:d,roster:r,di,fi,tk,tail:t,dateStr})});
                }
              }
            }
          }
          prevWasOff=false;
        }
      }
    }
    if(prefs.edits){
      for(const ev of getNotifEvents()){
        if(ev.type==="edit"&&Date.now()-ev.ts<14*864e5)
          items.push({id:ev.id,type:"edit",ts:ev.ts,title:ev.label,sub:ev.sub,action:()=>setPage("logbook")});
      }
    }
    items.sort((a,b)=>b.ts-a.ts);
    return items.slice(0,20);
  },[rosters,tails,notifOpen]);
  const unreadNotifs=notifications.filter(n=>!dismissedNotifs.includes(n.id));

  // Suggestion engine: flight numbers (digits), months (with/without year),
  // app pages and settings entries -- live as the pilot types.
  const searchResults=useMemo(()=>{
    const q=query.trim().toLowerCase();
    const PAGES=[["dashboard","Dashboard","home overview stats"],["upload","Upload Roster","import pdf csv roster"],["logbook","Logbook & Active Logs","flights daily roster view verify sign"],["analytics","Analytics","stats charts hours breakdown"],["map","Route Map","radar routes"],["settings","Settings","preferences appearance account theme"],["subscriptions","Subscription","billing plan upgrade invoices payment"],["referral","Referral","refer a pilot earn credit"],["support","Support","help contact"],["export","Export","jeppesen asa download backup"],["profile","Profile","pilot identity avatar"],["add-flight","Add Flight","manual entry new leg"]];
    const SETTINGS_ITEMS=[["Notification preferences","settings","alerts bell sync edits sign reminders"],["Dark mode / light mode","settings","theme appearance night"],["Export logbook data","export","csv download backup"],["Manage billing","subscriptions","invoices payment card"],["Sign out","settings","logout account"]];
    if(!q){
      return PAGES.slice(1,5).map(([id,label])=>({kind:"Page",title:label,sub:"Open page",action:()=>setPage(id)}));
    }
    const out=[];
    for(const [label,pid,kw] of SETTINGS_ITEMS)
      if((label+" "+kw).toLowerCase().includes(q)) out.push({kind:"Setting",title:label,sub:"Settings",action:()=>setPage(pid)});
    for(const [id,label,kw] of PAGES)
      if((label+" "+kw).toLowerCase().includes(q)) out.push({kind:"Page",title:label,sub:"Open page",action:()=>setPage(id)});
    const mm=q.match(/^([a-z]{3,9})\.?\s*(\d{4})?$/);
    if(mm){
      const mi=MONTHS_FU.findIndex(n=>n.toLowerCase().startsWith(mm[1]));
      if(mi>=0){
        rosters.filter(r=>((r.monthNum??r.month_num??0)===mi)&&(!mm[2]||String(r.year)===mm[2]))
          .forEach(r=>{
            const legs=(r.calendar||[]).reduce((a,d)=>a+(d.flights||[]).length,0);
            out.push({kind:"Month",title:`${MONTHS_FU[mi]} ${r.year}`,sub:`${legs} flights · open roster & logbook`,action:()=>{PENDING_ROSTER_ID=r.id;setPage("logbook");}});
          });
      }
    }
    const digits=q.replace(/\D/g,"");
    if(digits.length>=2){
      let count=0;
      outer:
      for(const r of rosters){
        const mNum=r.monthNum??r.month_num??0;
        for(let di=0;di<(r.calendar||[]).length;di++){
          const d=r.calendar[di];
          for(let fi=0;fi<(d.flights||[]).length;fi++){
            const f=d.flights[fi];
            if((f.flightNum||"").replace(/\D/g,"").includes(digits)){
              const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
              const tk=`${r.id}-${di}-${fi}`;
              out.push({kind:"Flight",title:`${f.flightNum} · ${f.dep} → ${f.arr}`,sub:`${MONTHS_FU[mNum]?.slice(0,3)} ${d.day}, ${r.year}${f.depTime?` · ${f.depTime}`:""}`,action:()=>openFlightItem({f,day:d,roster:r,di,fi,tk,tail:tails[tk]||{},dateStr})});
              if(++count>=6) break outer;
            }
          }
        }
      }
    }
    return out.slice(0,12);
  },[query,rosters,tails]);

  const S=getS();

  return(
    <div style={{flex:1,overflowY:"auto",overflowX:"hidden",background:S.bg,fontFamily:"Inter,system-ui,sans-serif",position:"relative",width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>

      {/* Background blobs */}
      <div style={{position:"absolute",top:"-5%",right:"-5%",width:"35%",height:"35%",background:"#1D4ED8",borderRadius:"50%",filter:"blur(80px)",opacity:0.16,pointerEvents:"none",zIndex:0}}/>
      <div style={{position:"absolute",top:"20%",left:"-10%",width:"25%",height:"25%",background:"#2563EB",borderRadius:"50%",filter:"blur(80px)",opacity:0.13,pointerEvents:"none",zIndex:0}}/>

      {/* HEADER -- brand bar + greeting on the phone-mockup blue gradient
          (matches the marketing hero header): logo/wordmark left, search +
          notifications + profile right, big white greeting title below. */}
      <div style={{background:"linear-gradient(165deg,#1D4ED8 0%,#2E6BE6 55%,#3B82F6 100%)",position:"relative",zIndex:1,boxShadow:"0 8px 24px rgba(29,78,216,0.25)"}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"14px 20px 18px",width:"100%",boxSizing:"border-box"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
              <div style={{width:26,height:26,borderRadius:7,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",flexShrink:0}}>
                <img src="/icons/icon-192.png" alt="" style={{width:20,height:20,objectFit:"contain"}}/>
              </div>
              <div style={{minWidth:0}}>
                <div style={{fontSize:12,fontWeight:800,color:"#fff",letterSpacing:".5px",lineHeight:1}}>AVIATE<span style={{color:"#BFDBFE"}}>SYNC</span></div>
                <div style={{fontSize:7,color:"rgba(255,255,255,0.65)",letterSpacing:".4px",marginTop:2,whiteSpace:"nowrap"}}>PILOT LOGBOOK</div>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <button onClick={()=>{setSearchOpen(true);setQuery("");}} aria-label="Search" style={{width:34,height:34,borderRadius:"50%",background:"rgba(255,255,255,0.14)",border:"1px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="#fff" strokeWidth="2"/><path d="M20 20l-3.5-3.5" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
              <button onClick={()=>setNotifOpen(true)} aria-label="Notifications" style={{width:34,height:34,borderRadius:"50%",background:"rgba(255,255,255,0.14)",border:"1px solid rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative"}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke="#fff" strokeWidth="2" strokeLinejoin="round"/><path d="M10 21a2 2 0 004 0" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                {unreadNotifs.length>0&&(
                  <span style={{position:"absolute",top:-3,right:-3,minWidth:16,height:16,padding:"0 4px",borderRadius:100,background:"#EF4444",border:"2px solid #2E6BE6",color:"#fff",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{unreadNotifs.length>9?"9+":unreadNotifs.length}</span>
                )}
              </button>
              <div onClick={()=>setPage("profile")} style={{width:34,height:34,borderRadius:"50%",background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.35)",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",flexShrink:0}}>
                {firstName[0]?.toUpperCase()}
              </div>
            </div>
          </div>
          <h1 style={{fontSize:"clamp(20px,4vw,26px)",fontWeight:800,color:"#fff",margin:"16px 0 0",letterSpacing:"-.5px",lineHeight:1.2}}>
            Flight Log & Roster Sync
          </h1>
          <p style={{fontSize:13,color:"rgba(255,255,255,0.8)",margin:"4px 0 0"}}>
            {now.getHours()<12?"Good morning":now.getHours()<17?"Good afternoon":"Good evening"}, {firstName}{nextFlight?` · Next duty in ${formatDutyCountdown(Math.round((nextFlight.dt-now)/60000))}`:""}
          </p>
        </div>
      </div>

      {/* NOTIFICATIONS PANEL */}
      {notifOpen&&(
        <div onClick={()=>setNotifOpen(false)} style={{position:"fixed",inset:0,zIndex:9998,background:"rgba(11,22,37,0.45)",backdropFilter:"blur(3px)",display:"flex",justifyContent:"center",alignItems:"flex-start",padding:"64px 14px 24px",overflowY:"auto"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:20,width:"100%",maxWidth:420,boxShadow:"0 24px 64px rgba(0,0,0,0.3)",overflow:"hidden"}}>
            <div style={{padding:"14px 16px",borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:15,fontWeight:800,color:S.ink}}>Notifications{unreadNotifs.length>0&&<span style={{marginLeft:8,fontSize:10,fontWeight:800,color:"#fff",background:S.blue,padding:"2px 8px",borderRadius:100,verticalAlign:"middle"}}>{unreadNotifs.length} new</span>}</div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <button onClick={()=>{setNotifOpen(false);setPage("settings");}} title="Notification settings" style={{background:"none",border:"none",cursor:"pointer",padding:2,display:"flex"}}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={S.muted} strokeWidth="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
                <button onClick={()=>setNotifOpen(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:16,color:S.muted,padding:2,lineHeight:1}}>✕</button>
              </div>
            </div>
            <div style={{maxHeight:"60vh",overflowY:"auto"}}>
              {notifications.length===0&&(
                <div style={{padding:"36px 20px",textAlign:"center",color:S.muted,fontSize:13}}>
                  You're all caught up<br/><span style={{fontSize:11.5}}>Sync updates, manual edits and signature reminders will appear here.</span>
                </div>
              )}
              {notifications.map(n=>{
                const seen=dismissedNotifs.includes(n.id);
                const ic=n.type==="sync"
                  ?{bg:S.blueBg,svg:<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke={S.blue} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  :n.type==="edit"
                  ?{bg:S.amberBg,svg:<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5L17 3z" stroke={S.gold} strokeWidth="2" strokeLinejoin="round"/></svg>}
                  :n.type==="upcoming"
                  ?{bg:S.greenBg,svg:<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={S.green} strokeWidth="2"/><path d="M12 7v5l3 3" stroke={S.green} strokeWidth="2" strokeLinecap="round"/></svg>}
                  :{bg:S.redBg,svg:<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h4M9 8h6M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" stroke={S.red} strokeWidth="2" strokeLinecap="round"/></svg>};
                return(
                  <div key={n.id} onClick={()=>{dismissNotifs([n.id]);setDismissedNotifs(getDismissedNotifs());setNotifOpen(false);if(n.action)n.action();}} style={{display:"flex",gap:11,padding:"12px 16px",borderTop:`1px solid ${S.border}`,cursor:"pointer",background:seen?"transparent":`${S.blue}0F`}}>
                    <div style={{width:32,height:32,borderRadius:10,background:ic.bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{ic.svg}</div>
                    <div style={{minWidth:0,flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:S.ink,lineHeight:1.3}}>{n.title}</div>
                      <div style={{fontSize:11.5,color:S.silver,marginTop:1}}>{n.sub}</div>
                      <div style={{fontSize:10,color:S.muted,marginTop:3}}>{agoLabel(n.ts)}</div>
                    </div>
                    {!seen&&<span style={{width:7,height:7,borderRadius:"50%",background:S.blue,marginTop:6,flexShrink:0}}/>}
                  </div>
                );
              })}
            </div>
            {notifications.length>0&&(
              <button onClick={()=>{dismissNotifs(notifications.map(n=>n.id));setDismissedNotifs(getDismissedNotifs());}} style={{width:"100%",padding:"11px",border:"none",borderTop:`1px solid ${S.border}`,background:S.panel,color:S.silver,fontSize:12,fontWeight:700,cursor:"pointer"}}>Mark all as read</button>
            )}
          </div>
        </div>
      )}

      {/* UNIVERSAL SEARCH OVERLAY */}
      {searchOpen&&(
        <div style={{position:"fixed",inset:0,zIndex:9998,background:S.bg,display:"flex",flexDirection:"column"}}>
          <div style={{padding:"14px 16px",borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:10,background:S.surface}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><circle cx="11" cy="11" r="7" stroke={S.muted} strokeWidth="2"/><path d="M20 20l-3.5-3.5" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
            <input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder='Flight number, "June 2026", or a page…' style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:15,color:S.ink,fontFamily:"inherit",minWidth:0}}/>
            <button onClick={()=>{setSearchOpen(false);setQuery("");}} style={{background:"none",border:"none",color:S.blue,fontSize:13,fontWeight:700,cursor:"pointer",flexShrink:0}}>Cancel</button>
          </div>
          <div style={{flex:1,overflowY:"auto",padding:"4px 0 40px"}}>
            {query.trim()===""&&(
              <div style={{padding:"14px 18px 6px",fontSize:10.5,fontWeight:800,letterSpacing:"1.2px",textTransform:"uppercase",color:S.muted}}>Quick access</div>
            )}
            {searchResults.length===0&&query.trim()!==""&&(
              <div style={{padding:"36px 20px",textAlign:"center",color:S.muted,fontSize:13}}>No matches for "{query}"<br/><span style={{fontSize:11.5}}>Try a flight number, a month like "June 2026", or a page name.</span></div>
            )}
            {searchResults.map((s,i)=>(
              <div key={i} onClick={()=>{setSearchOpen(false);setQuery("");if(s.action)s.action();}} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 18px",cursor:"pointer",borderBottom:`1px solid ${S.border}`}}>
                <div style={{width:34,height:34,borderRadius:10,background:S.blueBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {s.kind==="Flight"?<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke={S.blue} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  :s.kind==="Month"?<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="3" stroke={S.blue} strokeWidth="2"/><path d="M8 2v4M16 2v4M3 9h18" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>
                  :s.kind==="Setting"?<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={S.blue} strokeWidth="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>
                  :<svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1.5" stroke={S.blue} strokeWidth="2"/><rect x="14" y="3" width="7" height="7" rx="1.5" stroke={S.blue} strokeWidth="2"/><rect x="3" y="14" width="7" height="7" rx="1.5" stroke={S.blue} strokeWidth="2"/><rect x="14" y="14" width="7" height="7" rx="1.5" stroke={S.blue} strokeWidth="2"/></svg>}
                </div>
                <div style={{minWidth:0,flex:1}}>
                  <div style={{fontSize:13.5,fontWeight:700,color:S.ink}}>{s.title}</div>
                  <div style={{fontSize:11.5,color:S.muted}}>{s.sub}</div>
                </div>
                <span style={{fontSize:9.5,fontWeight:800,color:S.blue,background:S.blueBg,border:`1px solid ${S.blueBdr}`,padding:"3px 8px",borderRadius:100,flexShrink:0}}>{s.kind}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{padding:"16px 16px 32px",maxWidth:"100%",width:"100%",boxSizing:"border-box",position:"relative",zIndex:1}}>

        {/* QUICK ACTIONS -- above upcoming flight */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginBottom:20}}>
          {[
            {label:"Upload Roster",page:"upload",primary:true,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M12 4L8 8M12 4l4 4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>},
            {label:"Add Flight",page:"add-flight",primary:false,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={S.blue} strokeWidth="2"/><path d="M12 8v8M8 12h8" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>},
            {label:"Calendar",page:"calendar",primary:false,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke={S.blue} strokeWidth="2"/><path d="M8 2v4M16 2v4M3 9h18" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>},
            {label:"Export",page:"export",primary:false,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke={S.blue} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke={S.blue} strokeWidth="2.2" strokeLinecap="round"/></svg>},
          ].map(({label,svg,page:pg,primary})=>(
            <button key={label} onClick={()=>setPage(pg)} style={{padding:"14px 12px",borderRadius:14,textAlign:"left",background:primary?`linear-gradient(135deg,${S.blue},${S.purple})`:S.surface,border:primary?"none":`1px solid ${S.border}`,color:primary?"#fff":S.ink,cursor:"pointer",display:"flex",alignItems:"center",gap:10,boxShadow:primary?`0 4px 14px ${S.blue}30`:"0 2px 4px rgba(0,0,0,0.04)"}}>
              <span style={{flexShrink:0}}>{svg}</span>
              <span style={{fontSize:13,fontWeight:600}}>{label}</span>
            </button>
          ))}
        </div>

        {/* NEXT FLIGHT + AI BRIEFING */}
        {nextFlight&&(()=>{
          const f=nextFlight.f;
          const tail=nextFlight.tail;
          const minsToGo=Math.round((nextFlight.dt-now)/60000);
          const within3hrs = minsToGo <= 180;
          const depGate = tail?.depGate || null;
          const arrGate = tail?.arrGate || null;
          return(
            <div style={{display:"grid",gridTemplateColumns:"1fr",gap:14,marginBottom:20}}>
              {/* Flight card */}
              <div
                onClick={()=>{if(onOpenFlight){const dist2=calcDist(f.dep,f.arr);onOpenFlight({f,day:nextFlight.day,roster:nextFlight.roster,di:nextFlight.di,fi:nextFlight.fi,tk:nextFlight.tk,tail:nextFlight.tail,dateStr:nextFlight.dateStr,dist:dist2,solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,nextFlight.dateStr),blockMins:tail.actualBlockMins??schedMins(f)??0,hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),dep:f.dep,arr:f.arr,isXC:(dist2||0)>50,userId:user?.id});}}}
                style={{background:S.surface,borderRadius:24,padding:"20px 22px",border:`1px solid ${S.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.06)",position:"relative",overflow:"hidden",cursor:"pointer",transition:"box-shadow .15s"}}
                onMouseEnter={e=>e.currentTarget.style.boxShadow="0 12px 40px rgba(29,78,216,0.12)"}
                onMouseLeave={e=>e.currentTarget.style.boxShadow="0 8px 32px rgba(0,0,0,0.06)"}
              >
                <div style={{position:"absolute",top:0,right:0,width:100,height:100,background:C.blueBg,borderRadius:"0 24px 0 100%",zIndex:0}}/>
                <div style={{position:"relative",zIndex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
                    <div>
                      <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:100,background:C.blueBg,border:"1px solid #BFDBFE",color:S.blue,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",marginBottom:6}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:S.blue,display:"inline-block",animation:"pulse 2s infinite"}}/>
                        Upcoming Flight
                      </span>
                      <div style={{fontSize:18,fontWeight:800,color:S.ink}}>{f.flightNum}</div>
                      <div style={{fontSize:12,color:S.muted,marginTop:2}}>{nextFlight.dateStr}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:10,color:S.muted,textTransform:"uppercase",fontWeight:600,marginBottom:4}}>Tail Number</div>
                      <div style={{fontSize:14,fontWeight:700,color:tail.tail?S.ink:S.muted,background:tail.tail?S.panel:"transparent",padding:"6px 12px",borderRadius:8,border:`1px solid ${S.border}`,fontFamily:"monospace",display:"inline-flex",alignItems:"center",gap:6}}>
                        {tail.tail||(
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:"#F59E0B",background:C.amberBg,padding:"4px 10px",borderRadius:100,border:"1px solid #FDE68A",letterSpacing:".3px"}}>
                            <span style={{width:6,height:6,borderRadius:"50%",background:"#F59E0B",animation:"pulse 1.5s infinite",display:"inline-block"}}/>
                            Awaiting sync
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{textAlign:"center",minWidth:0,flex:1}}>
                      <div style={{fontSize:"clamp(18px,6vw,32px)",fontWeight:900,color:S.ink,lineHeight:1,letterSpacing:"-1px"}}>{f.dep}</div>
                      <div style={{fontSize:11,color:S.muted,fontWeight:500,marginTop:3}}>Departure</div>
                      <div style={{fontSize:13,fontWeight:700,color:S.purple,marginTop:4}}>{f.depTime}</div>
                    </div>
                    <div style={{flex:1,padding:"0 12px",display:"flex",flexDirection:"column",alignItems:"center"}}>
                      <div style={{fontSize:11,fontWeight:600,color:S.muted,marginBottom:6}}>
                        {formatDutyCountdown(minsToGo)} until dep
                      </div>
                      <div style={{width:"100%",height:2,background:S.panel,position:"relative",display:"flex",alignItems:"center",justifyContent:"center"}}>
                        <div style={{position:"absolute",width:"100%",height:2,background:S.panel}}/>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{background:S.surface,padding:2,position:"relative",zIndex:1}}>
                          <path d="M5 17l6-10 3 5 3-4 4 9" stroke={S.blue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                      <div style={{fontSize:11,fontWeight:600,color:S.muted,marginTop:6}}>{f.acType||"Regional jet"} · Direct</div>
                    </div>
                    <div style={{textAlign:"center",minWidth:0,flex:1}}>
                      <div style={{fontSize:"clamp(18px,6vw,32px)",fontWeight:900,color:S.ink,lineHeight:1,letterSpacing:"-1px"}}>{f.arr}</div>
                      <div style={{fontSize:11,color:S.muted,fontWeight:500,marginTop:3}}>Arrival</div>
                      <div style={{fontSize:13,fontWeight:700,color:S.blue,marginTop:4}}>{f.arrTime}</div>
                    </div>
                  </div>

                  {/* -- Gate information row --------------------------------- */}
                  <div style={{marginTop:18,paddingTop:16,borderTop:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:8}}>
                    {/* Dep gate */}
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:36,height:36,borderRadius:10,background:within3hrs&&depGate?C.blueBg:S.panel,border:`1px solid ${within3hrs&&depGate?`${S.blue}30`:S.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" stroke={within3hrs&&depGate?S.blue:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M9 22V12h6v10" stroke={within3hrs&&depGate?S.blue:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                      <div>
                        <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Dep Gate</div>
                        {within3hrs?(
                          depGate
                            ? <div style={{fontSize:20,fontWeight:900,color:S.blue,letterSpacing:"-0.5px",lineHeight:1.1}}>{depGate}</div>
                            : <div style={{fontSize:13,fontWeight:700,color:S.muted}}>Checking...</div>
                        ):(
                          <div style={{fontSize:11,fontWeight:600,color:S.muted,lineHeight:1.3}}>
                            Updates 3 hrs<br/>prior departure
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Center divider */}
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke={S.border} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>

                    {/* Arr gate */}
                    <div style={{display:"flex",alignItems:"center",gap:10,justifyContent:"flex-end",textAlign:"right"}}>
                      <div>
                        <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Arr Gate</div>
                        {within3hrs?(
                          arrGate
                            ? <div style={{fontSize:20,fontWeight:900,color:S.blue,letterSpacing:"-0.5px",lineHeight:1.1}}>{arrGate}</div>
                            : <div style={{fontSize:13,fontWeight:700,color:S.muted}}>Checking...</div>
                        ):(
                          <div style={{fontSize:11,fontWeight:600,color:S.muted,lineHeight:1.3}}>
                            Updates 3 hrs<br/>prior departure
                          </div>
                        )}
                      </div>
                      <div style={{width:36,height:36,borderRadius:10,background:within3hrs&&arrGate?C.blueBg:S.panel,border:`1px solid ${within3hrs&&arrGate?`${S.blue}30`:S.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" stroke={within3hrs&&arrGate?S.blue:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M9 22V12h6v10" stroke={within3hrs&&arrGate?S.blue:S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>
                    </div>
                  </div>
                  {/* Gate source note */}
                  {within3hrs&&(
                    <div style={{marginTop:10,display:"flex",alignItems:"center",gap:6,fontSize:10,color:S.muted}}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={S.muted} strokeWidth="2"/><path d="M12 8v4M12 16h.01" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
                      {depGate||arrGate?"Gate data from FlightAware · updates automatically":"Gate data updates when assigned by airline (usually 60-90 min before departure)"}
                    </div>
                  )}
                </div>
              </div>

              {/* AI Briefing card */}
              <div style={{background:`linear-gradient(135deg,${S.blueDim},${S.blue})`,borderRadius:24,padding:"20px 22px",color:"#fff",boxShadow:`0 8px 32px ${S.blue}25`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{background:"rgba(255,255,255,0.2)",padding:"8px",borderRadius:10,backdropFilter:"blur(8px)"}}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                    </div>
                    <div>
                      <div style={{fontSize:12,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",color:"rgba(255,255,255,0.8)"}}>AI Briefing</div>
                      <div style={{fontSize:11,color:"rgba(255,255,255,0.6)"}}>{f.flightNum} · {f.dep}→{f.arr}{miniBriefing&&fmtBriefingCountdown(briefingExpiresAt)?` · ${fmtBriefingCountdown(briefingExpiresAt)}`:""}</div>
                    </div>
                  </div>
                  <div style={{fontSize:18}}>
                    {fltCat==="VFR"?"☀️":fltCat==="MVFR"?"⛅":fltCat==="IFR"?"🌧️":"⛈️"}
                  </div>
                </div>
                {miniBriefing?(
                  <div style={{background:"rgba(255,255,255,0.12)",backdropFilter:"blur(8px)",borderRadius:14,padding:"12px 14px",border:"1px solid rgba(255,255,255,0.2)",fontSize:12,lineHeight:1.7,color:"rgba(255,255,255,0.9)",marginBottom:12,maxHeight:120,overflowY:"auto"}}>
                    {miniBriefing}
                  </div>
                ):(
                  <div style={{background:"rgba(255,255,255,0.1)",borderRadius:14,padding:"12px 14px",fontSize:12,color:"rgba(255,255,255,0.65)",marginBottom:12}}>
                    Tap "Get Briefing" for weather, NOTAMs, and route info · updates every hour
                  </div>
                )}
                <button onClick={fetchMiniBriefing} disabled={briefingLoading} style={{width:"100%",padding:"11px",borderRadius:12,background:"#fff",border:"none",color:S.blue,fontSize:13,fontWeight:700,cursor:briefingLoading?"not-allowed":"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.12)"}}>
                  {briefingLoading?"⟳ Loading...":miniBriefing?"↻ Refresh":"Get Briefing"}
                </button>
                {/* Compact route/radar map -- DASHBOARD ONLY (this card), per
                    explicit instruction not to add this to the flight detail
                    page's own briefing section. */}
                <div style={{marginTop:12,borderRadius:14,overflow:"hidden",border:"1px solid rgba(255,255,255,0.2)"}}>
                  <FlightRouteMap dep={f.dep} arr={f.arr} dist={calcDist(f.dep,f.arr)} flightDateStr={nextFlight.dateStr} flightDepTime={f.depTime} S={S} compact/>
                </div>
              </div>
            </div>
          );
        })()}

        {/* STATS GRID */}
        <div style={{marginBottom:20}}>
          <h3 style={{fontSize:15,fontWeight:700,color:S.ink,marginBottom:12}}>Flight Statistics</h3>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
            {/* Block hours */}
            <div style={{background:S.surface,borderRadius:18,padding:"16px 18px",border:`1px solid ${S.border}`,boxShadow:"0 2px 8px rgba(0,0,0,0.04)",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                <div style={{width:38,height:38,borderRadius:100,background:C.blueBg,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={S.purple} strokeWidth="2"/><path d="M12 7v5l3 3" stroke={S.purple} strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <span style={{fontSize:11,fontWeight:700,color:C.green,background:C.greenBg,padding:"3px 8px",borderRadius:6}}>Total</span>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Total Hours to Date</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2,letterSpacing:"-1px"}}>{stats.hours}</div>
            </div>
            {/* Sectors */}
            <div style={{background:S.surface,borderRadius:18,padding:"16px 18px",border:`1px solid ${S.border}`,boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}>
              <div style={{width:38,height:38,borderRadius:100,background:C.blueBg,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke={S.blue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Duty Days This Month</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2}}>{stats.dutyDaysMTD}</div>
            </div>
            {/* Night hours */}
            <div style={{background:S.surface,borderRadius:18,padding:"16px 18px",border:`1px solid ${S.border}`,boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}>
              <div style={{width:38,height:38,borderRadius:100,background:C.amberBg,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke={C.gold} strokeWidth="2"/></svg>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Hours This Month</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2}}>{stats.hoursMTD}</div>
            </div>
            {/* Duty limit */}
            <div style={{background:"#1E293B",borderRadius:18,padding:"16px 18px",border:"1px solid #334155",boxShadow:"0 2px 8px rgba(0,0,0,0.1)",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",right:"-15%",bottom:"-15%",fontSize:60,color:"#334155",pointerEvents:"none"}}>◎</div>
              <div style={{fontSize:10,color:"#94A3B8",fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:8}}>Duty Limit</div>
              <div style={{fontSize:26,fontWeight:900,color:"#fff",marginBottom:8}}>{dutyPct}%</div>
              <div style={{width:"100%",height:5,background:"#334155",borderRadius:100,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${dutyPct}%`,background:`linear-gradient(90deg,${S.blue},${S.purple})`,borderRadius:100,transition:"width .5s"}}/>
              </div>
              <div style={{fontSize:10,color:"#64748B",marginTop:4}}>{dutyPct} of 100 hrs this month</div>
            </div>
          </div>
        </div>

        {/* TODAY'S DUTY -- moved above recent flights */}
        {todayFlights.length>0&&(
          <div style={{background:S.surface,borderRadius:20,border:`1px solid ${S.border}`,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,0.04)",marginBottom:20}}>
            <div style={{padding:"16px 20px",borderBottom:`1px solid ${S.border}`,background:"rgba(248,250,252,0.5)"}}>
              <h3 style={{fontSize:15,fontWeight:700,color:S.ink,margin:0}}>{"Today's Duty"}</h3>
            </div>
            {todayFlights.map(({f,day:tday,roster:troster,di:tdi,fi:tfi,tk,tail,dateStr:tdateStr},i)=>(
              <div key={tk}
                style={{padding:"14px 20px",borderBottom:i<todayFlights.length-1?`1px solid ${S.panel}`:"none",display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}
                onClick={()=>{
                  const bm=tail.actualBlockMins??schedMins(f)??0;
                  const dist2=calcDist(f.dep,f.arr);
                  onOpenFlight&&onOpenFlight({f,day:tday,roster:troster,di:tdi,fi:tfi,tk,tail,dateStr:tdateStr,dist:dist2,solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,tdateStr),blockMins:bm,hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),dep:f.dep,arr:f.arr,isXC:(dist2||0)>50,userId:user?.id});
                }}
              >
                <div style={{width:8,height:8,borderRadius:"50%",background:tail.tail?"#22C55E":S.muted,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:14,fontWeight:700,color:S.ink}}>{f.flightNum} <span style={{fontWeight:500,color:S.muted}}>{f.dep} → {f.arr}</span></div>
                  <div style={{fontSize:12,color:S.muted,marginTop:2}}>{f.depTime} → {f.arrTime} · {f.acType||"--"}</div>
                </div>
                <div style={{fontSize:12,color:S.muted,fontFamily:"monospace"}}>{tail.tail||"--"}</div>
              </div>
            ))}
          </div>
        )}

        {/* RECENT FLIGHTS TABLE */}
        <div style={{background:S.surface,borderRadius:20,border:`1px solid ${S.border}`,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,0.04)",marginBottom:20}}>
          <div style={{padding:"16px 20px",borderBottom:`1px solid ${S.border}`,background:"rgba(248,250,252,0.5)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <h3 style={{fontSize:15,fontWeight:700,color:S.ink,margin:0}}>Recent Flights</h3>
            <button onClick={()=>setPage("logbook")} style={{fontSize:13,fontWeight:600,color:S.blue,background:"none",border:"none",cursor:"pointer"}}>View Logbook →</button>
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead>
                <tr style={{background:S.panel,borderBottom:`1px solid ${S.border}`}}>
                  {["Date","Flight","Route","Tail #","Block","Status"].map(h=>(
                    <th key={h} style={{padding:"10px 16px",textAlign:"left",fontSize:10,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(()=>{
                  const rows=[];
                  for(const r of rosters){
                    const mNum=r.monthNum??r.month_num??0;
                    (r.calendar||[]).forEach((d,di)=>{
                      (d.flights||[]).forEach((f,fi)=>{
                        const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
                        const tk=`${r.id}-${di}-${fi}`;
                        const t=tails[tk]||{};
                        if(f.isDeadhead) return; // deadheads are informational only -- never shown in Recent Flights
                        rows.push({f,d,di,fi,r,tk,t,dateStr,mNum});
                      });
                    });
                  }
                  const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
                  rows.sort((a,b)=>{
                    const dc=b.dateStr.localeCompare(a.dateStr);
                    if(dc!==0) return dc;
                    return (b.f.depTime||"00:00").localeCompare(a.f.depTime||"00:00");
                  });
                  const pastRows = rows.filter(row=>row.dateStr<=todayStr);
                  if(pastRows.length===0) return(
                    <tr><td colSpan={6} style={{padding:"32px",textAlign:"center",color:S.muted,fontSize:13}}>
                      No flights yet -- <button onClick={()=>setPage("upload")} style={{color:S.blue,background:"none",border:"none",cursor:"pointer",fontWeight:600,fontSize:13}}>upload your roster</button>
                    </td></tr>
                  );
                  return pastRows.slice(0,3).map(({f,d,di,fi,r,tk,t,dateStr},idx)=>(
                    <tr key={tk} style={{borderBottom:`1px solid ${S.panel}`,cursor:"pointer"}} onClick={()=>{const bm=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;const dist2=calcDist(f.dep,f.arr);onOpenFlight&&onOpenFlight({f,day:d,roster:r,di,fi,tk,tail:t,dateStr,dist:dist2,solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr),blockMins:bm,hasActual:!!(t.actualDep||t.actualArr||t.tail),dep:f.dep,arr:f.arr,isXC:(dist2||0)>50,userId:user?.id});}}>
                      <td style={{padding:"12px 16px",fontWeight:600,color:S.ink,whiteSpace:"nowrap"}}>{dateStr}</td>
                      <td style={{padding:"12px 16px",color:S.silver}}>{f.flightNum}</td>
                      <td style={{padding:"12px 16px"}}>
                        <span style={{fontWeight:700,color:S.ink}}>{f.dep}</span>
                        <span style={{color:S.muted,margin:"0 4px"}}>→</span>
                        <span style={{fontWeight:700,color:S.ink}}>{f.arr}</span>
                      </td>
                      <td style={{padding:"12px 16px",color:S.silver,fontFamily:"monospace",fontSize:12}}>{t.tail||"--"}</td>
                      <td style={{padding:"12px 16px",fontWeight:600,color:S.ink}}>{t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"--"}</td>
                      <td style={{padding:"12px 16px"}}>
                        {t.tail?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:6,background:C.greenBg,color:C.green,fontSize:11,fontWeight:700}} title={t.updatedAt?`Synced ${fmtSyncTime(t.updatedAt)}`:undefined}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            {t.updatedAt?`Synced ${fmtSyncTime(t.updatedAt)}`:"Auto-Synced"}
                          </span>
                        ):(
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:6,background:S.panel,color:S.muted,fontSize:11,fontWeight:700}}>
                            Pending
                          </span>
                        )}
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>

      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </div>
  );
}

// -- Logbook Hub -- unified shell for Daily View / Logbook View / Roster View / Active Logs --
// LogbookPage already internally switches between "daily" and "logbook" views
// via its own pill toggle. This hub adds a 4th-level grouping on top: it lets
// the person pick between those two LogbookPage views, the Roster (Calendar)
// view, or Active Logs — all under one "Logbook" label, matching the visual
// language of the Quick Actions tabs on the Dashboard.
function LogbookHubPage({user, rosters, tails, onTailSaved, onDeleteRoster, onRosterUpdated, onOpenFlight, pendingFlight, onPendingFlightConsumed, setPage, initialTab}) {
  const S = getS();
  // Simple, global default for how a newly-synced flight (no explicit
  // PIC/SIC override yet) should be classified going forward -- distinct
  // from the heavier, date-range-based Time Rules system in Analytics.
  const [picSicDefault, setPicSicDefault] = useState(user?.pic_sic_default || null);
  const [showPicSicSettings, setShowPicSicSettings] = useState(false);
  const [savingPicSicDefault, setSavingPicSicDefault] = useState(false);
  async function savePicSicDefault(val){
    setSavingPicSicDefault(true);
    try{
      await sb.from("profiles").update({pic_sic_default:val}).eq("id",user.id);
      setPicSicDefault(val);
    }catch(e){ alert(e.message||"Could not save default."); }
    setSavingPicSicDefault(false);
  }
  const VALID_HUB_TABS = ["daily","logbookview","activelogs"];
  const [hubTab, setHubTab] = useState(()=>{
    if(initialTab) return initialTab;
    try{
      const stored = sessionStorage.getItem("fl_logbook_hub_tab");
      // Guards against a stale "roster" (Roster View, now a standalone page
      // outside the hub) cached from before this tab was removed.
      return VALID_HUB_TABS.includes(stored) ? stored : "daily";
    }catch{ return "daily"; }
  });
  useEffect(()=>{ if(initialTab) setHubTab(initialTab); },[initialTab]);
  useEffect(()=>{ try{ sessionStorage.setItem("fl_logbook_hub_tab", hubTab); }catch{} },[hubTab]);

  // Hoist flight detail state here so FlightDetailPage renders ABOVE
  // the hub shell (no title bar / tab strip showing behind it)
  const [hubSelectedFlight, setHubSelectedFlight] = useState(null);

  // Open a flight directly regardless of which hub tab is currently active
  // (sticky from a previous visit via sessionStorage). Without this, a real
  // pendingFlight payload only got consumed when LogbookPage happened to be
  // mounted (Daily View / Permanent Logbook tabs) -- if the pilot's last-used
  // tab was Active Logs, tapping a flight elsewhere in the app silently
  // landed on Active Logs instead of opening that flight's detail page.
  useEffect(()=>{
    if(!pendingFlight || pendingFlight.clearFlight) return;
    setHubSelectedFlight(pendingFlight);
    try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:pendingFlight.roster?.id,di:pendingFlight.di,fi:pendingFlight.fi,flightData:pendingFlight}));}catch{}
    onPendingFlightConsumed?.();
  },[pendingFlight]);

  // Restore an open flight detail page after a hard browser refresh -- same
  // sticky-tab problem as above, but for the sessionStorage-driven restore
  // instead of the live pendingFlight prop. A full refresh clears pendingFlight
  // (it's just React state), so this is the ONLY thing that can bring a
  // flight detail page back after reload, and it needs to work regardless
  // of which hub tab happens to be cached from before the refresh.
  useEffect(()=>{
    if(rosters.length===0 || hubSelectedFlight) return;
    try {
      const saved = sessionStorage.getItem("fl_open_flight");
      if(!saved) return;
      const {flightData, rosterId, di, fi} = JSON.parse(saved);
      if(rosterId==null || di==null || fi==null) return;
      const freshRoster = rosters.find(r=>r.id===rosterId);
      if(!freshRoster) return;
      const day = freshRoster.calendar?.[di];
      const f = day?.flights?.[fi];
      if(!f) return;
      const mNum2 = freshRoster.monthNum ?? freshRoster.month_num ?? 0;
      const dateStr = `${freshRoster.year}-${String(mNum2+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
      const tk = `${freshRoster.id}-${di}-${fi}`;
      const tail = tails[tk] || {};
      const dist = calcDist(f.dep, f.arr);
      setHubSelectedFlight({
        f, day, roster:freshRoster, di, fi, tk, tail, dateStr,
        dist, solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr),
        blockMins:tail.actualBlockMins??schedMins(f)??0,
        hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),
        dep:f.dep, arr:f.arr, isXC:(dist||0)>50, userId:flightData?.userId||user?.id,
      });
    } catch {}
  },[rosters.length]);

  // When bottom nav logbook icon is tapped while on flight detail, go back to hub
  useEffect(()=>{
    if(!hubSelectedFlight) return;
    // pendingFlight with clearFlight flag signals "go back"
    if(pendingFlight?.clearFlight){ setHubSelectedFlight(null); onPendingFlightConsumed?.(); }
  },[pendingFlight]);

  // signedRosters count -- used to badge Active Logs vs Logbook tabs
  const signedCount = useMemo(()=>{
    try {
      const sm = JSON.parse(localStorage.getItem("fl_signed_months")||"{}");
      return rosters.filter(r=>!!sm[r.id]).length;
    } catch { return 0; }
  },[rosters]);
  const unsignedCount = rosters.length - signedCount;

  // Roster View moved out of the hub -- it's now the standalone "Calendar"
  // page, reachable only from the Dashboard's Quick Actions.
  const TABS = [
    {id:"daily",       label:"Daily View",       icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M3 9h18M8 2v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"logbookview", label:"Permanent Logbook",icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="13" height="18" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M8 7h6M8 11h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"activelogs",  label:"Active Logs",      icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>, badge:unsignedCount>0?unsignedCount:null},
  ];


  // If a flight is selected, render FlightDetailPage OUTSIDE the hub shell
  // so the "Logbook" title and 4-tab strip don't show behind it, and
  // tapping the bottom nav Logbook icon goes back to the hub (not the OS back).
  // State for when FlightDetailPage is rendered above the hub shell
  const [hubLkStatus,      setHubLkStatus]      = useState("idle");
  const [hubLkError,       setHubLkError]        = useState(null);
  const [hubTmp,           setHubTmp]            = useState("");
  const [hubTimeEdits,     setHubTimeEdits]      = useState({});
  const [hubEditingTimes,  setHubEditingTimes]   = useState(false);

  if(hubSelectedFlight){
    const {f,day,roster:r2,di,fi,tk,tail,dateStr,dist,solar,blockMins,hasActual,dep,arr,isXC,userId:uid2}=hubSelectedFlight;
    return(
      <FlightDetailPage
        flight={f} tail={tail} solar={solar} dist={dist} blockMins={blockMins}
        day={day} roster={r2} hasActual={hasActual} dep={dep} arr={arr} isXC={isXC}
        onBack={()=>{try{sessionStorage.removeItem("fl_open_flight");}catch{}setHubSelectedFlight(null);setHubLkStatus("idle");setHubLkError(null);setHubTmp("");setHubTimeEdits({});setHubEditingTimes(false);}}
        onAutoLookup={async()=>{
          setHubLkStatus("loading"); setHubLkError(null);
          try{
            const res=await fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f.flightNum,date:dateStr,dep:f.dep,arr:f.arr,depTime:f.depTime,forceRefresh:true})});
            const d=await res.json();
            if(d.error)throw new Error(d.error);
            if(d.tail||d.actualDep||d.actualArr){
              const updates={tail:d.tail||tail.tail,actualDep:d.actualDep||tail.actualDep,actualArr:d.actualArr||tail.actualArr,actualBlockMins:d.actualBlockMins??tail.actualBlockMins,depGate:d.depGate||tail.depGate||null,arrGate:d.arrGate||tail.arrGate||null};
              await db_saveTail(user.id,tk,updates);
              onTailSaved(tk,{...tail,...updates});
              setHubSelectedFlight(p=>({...p,tail:{...p.tail,...updates},hasActual:true}));
              setHubLkStatus("done");
            } else { setHubLkStatus("error"); setHubLkError("No data found"); }
          }catch(e){ setHubLkStatus("error"); setHubLkError(e.message); }
        }}
        lkStatus={hubLkStatus} lkError={hubLkError} onResetLimit={()=>{setHubLkStatus("idle");setHubLkError(null);}}
        tmp={hubTmp||tail?.tail||""} onTmpChange={setHubTmp}
        onSaveTail={async(val)=>{
          const parts=tk.split("-"); const rId=parts.slice(0,-2).join("-"); const fk=parts.slice(-2).join("-");
          try{ await db_saveTail(user.id,rId,fk,val||""); onTailSaved(tk,{...(tail||{}),tail:val}); setHubSelectedFlight(p=>({...p,tail:{...p.tail,tail:val}})); logNotifEvent({type:"edit",id:`edit-tail-${tk}-${Date.now()}`,label:`${hubSelectedFlight?.f?.flightNum||"Flight"} manually edited`,sub:val?`Tail set to ${val}`:"Tail cleared"}); }catch(e){alert(e.message);}
        }}
        saving={false}
        onTailSaved={async(v)=>{
          const parts=tk.split("-"); const rId=parts.slice(0,-2).join("-"); const fk=parts.slice(-2).join("-");
          try{ await db_saveTail(user.id,rId,fk,v); onTailSaved(tk,v); setHubSelectedFlight(p=>({...p,tail:{...p.tail,...v},hasActual:true})); logNotifEvent({type:"edit",id:`edit-times-${tk}-${Date.now()}`,label:`${hubSelectedFlight?.f?.flightNum||"Flight"} manually edited`,sub:"Block times updated manually"}); }catch(e){alert(e.message);}
        }}
        editingTimes={hubEditingTimes} setEditingTimes={setHubEditingTimes}
        timeEdits={hubTimeEdits} setTimeEdits={setHubTimeEdits}
        onSaveFlightFields={async(fields)=>{
          const nc = await saveFlightFieldsToRoster(user.id, r2, di, fi, fields);
          onRosterUpdated(r2.id, nc);
          setHubSelectedFlight(p=>({...p, f:{...p.f, ...fields}}));
        }}
        onDeleteFlight={async()=>{
          const nc = await deleteFlightFromRoster(user.id, r2, di, fi);
          onRosterUpdated(r2.id, nc);
          setHubSelectedFlight(null);
        }}
        di={di} fi={fi} userId={uid2||user?.id}
      />
    );
  }

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
     {/* One scroll container for title + tabs + content, so the 4-button
         switcher scrolls away with the page instead of pinning at the top
         and eating view area. */}
     <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",display:"flex",flexDirection:"column"}}>
      {/* Top label */}
      <div style={{padding:"16px 18px 12px",flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative"}}>
        <h1 style={{fontSize:22,fontWeight:900,color:S.ink,margin:0,letterSpacing:"-.5px"}}>Logbook</h1>
        <button onClick={()=>setShowPicSicSettings(v=>!v)} title="Default classification for new syncs" style={{width:34,height:34,borderRadius:10,background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={S.muted} strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke={S.muted} strokeWidth="1.6"/></svg>
        </button>
        {showPicSicSettings&&(
          <>
            <div onClick={()=>setShowPicSicSettings(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
            <div style={{position:"absolute",top:"calc(100% + 4px)",right:18,zIndex:21,background:S.surface,border:`1px solid ${S.border}`,borderRadius:14,boxShadow:"0 12px 32px rgba(0,0,0,0.14)",padding:14,minWidth:260}}>
              <div style={{fontSize:12,fontWeight:700,color:S.ink,marginBottom:4}}>Default for new syncs</div>
              <div style={{fontSize:11,color:S.muted,marginBottom:10,lineHeight:1.5}}>When a flight syncs and has no explicit PIC/SIC set on it yet, classify it as:</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                {[["PIC","PIC"],["SIC","SIC"],["None","None"]].map(([lbl,val])=>{
                  const isActive = val==="None" ? !picSicDefault : picSicDefault===val;
                  return(
                    <button key={val} disabled={savingPicSicDefault} onClick={()=>savePicSicDefault(val==="None"?null:val)} style={{padding:"9px 6px",borderRadius:9,border:`1.5px solid ${isActive?S.blue:S.border}`,background:isActive?`${S.blue}18`:S.surface,color:isActive?S.blue:S.muted,fontSize:12,fontWeight:700,cursor:savingPicSicDefault?"not-allowed":"pointer"}}>{lbl}</button>
                  );
                })}
              </div>
              <div style={{fontSize:10,color:S.muted,marginTop:8,lineHeight:1.4}}>This never overrides a flight you've already classified manually, and doesn't change anything already synced.</div>
            </div>
          </>
        )}
      </div>

      {/* 4-tab switcher -- 2x2 grid, same size/style as Dashboard Quick Actions */}
      <div style={{padding:"0 18px 16px",flexShrink:0}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
          {TABS.map(({id,label,icon,badge})=>{
            const isActive = hubTab===id;
            return(
              <button
                key={id}
                onClick={()=>setHubTab(id)}
                style={{
                  padding:"14px 12px",borderRadius:14,textAlign:"left",
                  background:isActive?`linear-gradient(135deg,${S.blue},${S.purple})`:S.surface,
                  border:isActive?"none":`1px solid ${S.border}`,
                  color:isActive?"#fff":S.ink,
                  cursor:"pointer",display:"flex",alignItems:"center",gap:10,
                  boxShadow:isActive?`0 4px 14px ${S.blue}30`:"0 2px 4px rgba(0,0,0,0.04)",
                  position:"relative",
                }}
              >
                <span style={{flexShrink:0}}>{icon}</span>
                <span style={{fontSize:13,fontWeight:600}}>{label}</span>
                {badge!=null&&(
                  <span style={{position:"absolute",top:-6,right:-6,minWidth:18,height:18,borderRadius:100,background:"#F59E0B",color:"#fff",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 4px",border:`2px solid ${S.bg}`}}>{badge}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active tab content -- natural height inside the shared scroller */}
      <div style={{display:"flex",flexDirection:"column"}}>
        {(hubTab==="daily"||hubTab==="logbookview")&&(
          <LogbookPage
            user={user} rosters={rosters} tails={tails}
            onTailSaved={onTailSaved} onDeleteRoster={onDeleteRoster}
            onRosterUpdated={onRosterUpdated}
            pendingFlight={hubSelectedFlight?{clearFlight:true}:pendingFlight}
            onPendingFlightConsumed={onPendingFlightConsumed}
            setPage={setPage}
            forcedView={hubTab==="daily"?"daily":"logbook"}
            onOpenFlightExternal={(flight)=>{ setHubSelectedFlight(flight); try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:flight.roster?.id,di:flight.di,fi:flight.fi,flightData:flight}));}catch{}}}
          />
        )}
        {hubTab==="activelogs"&&(
          <ActiveLogsPage user={user} rosters={rosters} tails={tails} onRosterUpdated={onRosterUpdated} onTailSaved={onTailSaved} onDeleteRoster={onDeleteRoster}/>
        )}
      </div>
     </div>
    </div>
  );
}

function LogbookPage({user, rosters, tails, onTailSaved, onDeleteRoster, onRosterUpdated, pendingFlight, onPendingFlightConsumed, setPage, forcedView, onOpenFlightExternal}) {
  // Only show signedRosters that have been verified and signed -- this
  // restriction applies to the Permanent Logbook view specifically.
  const signedMonths = useMemo(()=>{
    try { return JSON.parse(localStorage.getItem("fl_signed_months")||"{}"); } catch { return {}; }
  },[]);
  const signedRosters = useMemo(()=>rosters.filter(r=>!!signedMonths[r.id]),[rosters,signedMonths]);
  // Daily View shows every roster -- signed or not -- so a pilot can review
  // this month's (or any month's) flights before it's ever verified/signed.
  const dailyRosters = useMemo(()=>[...rosters].sort((a,b)=>
    (b.year-a.year) || ((b.monthNum??b.month_num??0)-(a.monthNum??a.month_num??0))
  ),[rosters]);

  // Daily View filters -- month/year/equipment. Left at "all" (the default),
  // Daily View behaves exactly as before: one roster at a time, picked from
  // the dropdown. Touching any filter switches to a flattened list spanning
  // every roster that matches, so a pilot can e.g. see every August across
  // all years, or every leg flown in a specific airplane type.
  const [dvFilterMonth, setDvFilterMonth] = useState("all");
  const [dvFilterYear, setDvFilterYear] = useState("all");
  const [dvFilterEquip, setDvFilterEquip] = useState("all");
  const [dvFilterPanelOpen, setDvFilterPanelOpen] = useState(false);
  const dvFiltersActive = dvFilterMonth!=="all"||dvFilterYear!=="all"||dvFilterEquip!=="all";
  const dvYearOptions = useMemo(()=>[...new Set(dailyRosters.map(r=>r.year))].sort((a,b)=>b-a),[dailyRosters]);
  const dvEquipOptions = useMemo(()=>{
    const set=new Set();
    dailyRosters.forEach(r=>(r.calendar||[]).forEach(d=>(d.flights||[]).forEach(f=>{ if(f.acType) set.add(f.acType); })));
    return [...set].sort();
  },[dailyRosters]);

  const [view, setView] = useState(forcedView || "daily"); // "daily" | "logbook"
  const [selRoster, setSelRoster] = useState(()=>{
    const firstList = (forcedView||"daily")==="logbook" ? signedRosters : dailyRosters;
    return firstList.length>0 ? 0 : -1;
  });
  const activeRosterList = view==="logbook" ? signedRosters : dailyRosters;
  // Universal-search month jump: the dashboard search sets PENDING_ROSTER_ID
  // before navigating here; select that month once rosters are loaded.
  useEffect(()=>{
    if(!PENDING_ROSTER_ID||signedRosters.length===0) return;
    const idx=signedRosters.findIndex(r=>r.id===PENDING_ROSTER_ID);
    if(idx>=0) setSelRoster(idx);
    PENDING_ROSTER_ID=null;
  },[signedRosters]);
  const [_selectedFlight, _setSelectedFlight] = useState(null);

  // When inside the hub (onOpenFlightExternal provided), every call to
  // setSelectedFlight must go through the hub so FlightDetailPage renders
  // ABOVE the shell (no title bar / 4 tabs visible behind it).
  // This single intercept fixes every call site at once — including the
  // logbook-view table rows and the session-storage restore effect — without
  // having to individually patch each one.
  const selectedFlight = _selectedFlight;
  function setSelectedFlight(val) {
    if(typeof val === "function") {
      // Updater function form — apply to internal state only
      _setSelectedFlight(val);
      return;
    }
    if(val && onOpenFlightExternal) {
      // Route through hub so it renders above the shell
      onOpenFlightExternal(val);
    } else {
      _setSelectedFlight(val);
    }
  }
  const [saving, setSaving] = useState({});
  const [tmp, setTmp] = useState({});
  const [lkStatus, setLkStatus] = useState({});
  const [lkError, setLkError] = useState({});
  const [timeEdits, setTimeEdits] = useState({});
  const [editingTimes, setEditingTimes] = useState({});
  const [confirmDel, setConfirmDel] = useState(null);
  const [collapsedDays, setCollapsedDays] = useState({});
  const [lbAddForm, setLbAddForm] = useState({show:false,flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
  const [lbAddSaving, setLbAddSaving] = useState(false);
  // Sync internal view with externally-controlled forcedView (from LogbookHubPage tabs),
  // and re-point selRoster at the newly-active list's most recent month.
  useEffect(()=>{
    if(forcedView && forcedView!==view){
      setView(forcedView);
      const nextList = forcedView==="logbook" ? signedRosters : dailyRosters;
      setSelRoster(nextList.length>0?0:-1);
    }
  },[forcedView]);
  const [search, setSearch] = useState("");
  const [lbPage, setLbPage] = useState(0);
  const LB_PAGE_SIZE = 20;

  const roster = selRoster >= 0 ? (activeRosterList[selRoster]||null) : null;
  const mNum = roster ? (roster.monthNum??roster.month_num??0) : new Date().getMonth();
  const year = roster ? roster.year : new Date().getFullYear();

  // Restore flight detail from sessionStorage after page refresh
  // Store only the lookup key (rosterId, di, fi) so we reconstruct from fresh data
  useEffect(()=>{
    if(rosters.length === 0) return; // Wait for rosters to load
    try {
      const saved = sessionStorage.getItem("fl_open_flight");
      if(!saved) return;
      const {flightData, rosterIdx, rosterId, di, fi} = JSON.parse(saved);

      // Try to reconstruct from fresh rosters using stored keys -- search
      // ALL rosters (not just signed ones), since Daily View can open a
      // flight from an unsigned month too.
      if(rosterId != null && di != null && fi != null) {
        const freshRoster = rosters.find(r => r.id === rosterId)
          || signedRosters.find(r => r.id === rosterId);
        if(freshRoster) {
          const day = freshRoster.calendar?.[di];
          const f = day?.flights?.[fi];
          if(f) {
            const mNum2 = freshRoster.monthNum ?? freshRoster.month_num ?? 0;
            const dateStr = `${freshRoster.year}-${String(mNum2+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
            const tk = `${freshRoster.id}-${di}-${fi}`;
            const tail = tails[tk] || {};
            const dist = calcDist(f.dep, f.arr);
            setSelectedFlight({
              f, day, roster:freshRoster, di, fi, tk, tail, dateStr,
              dist, solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr),
              blockMins:tail.actualBlockMins??schedMins(f)??0,
              hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),
              dep:f.dep, arr:f.arr, isXC:(dist||0)>50, userId:flightData?.userId,
            });
            return;
          }
        }
      }
      // Fallback: use stored flightData directly (same session, no refresh needed)
      if(flightData) setSelectedFlight(flightData);
    } catch {}
    return ()=>{ try { sessionStorage.removeItem("fl_open_flight"); } catch {} };
  },[signedRosters.length, rosters.length]); // Re-run when rosters finish loading


  useEffect(()=>{
    if(!pendingFlight) return;
    if(pendingFlight.clearFlight) {
      try { sessionStorage.removeItem("fl_open_flight"); } catch {}
      setSelectedFlight(null);
      onPendingFlightConsumed?.();
      return;
    }
    setSelectedFlight(pendingFlight);
    onPendingFlightConsumed?.();
  },[pendingFlight]);

  async function lbSaveFlight(){
    const fn=lbAddForm.flightNum.trim().toUpperCase().replace(/\s+/g,"");
    const dep=lbAddForm.dep.trim().toUpperCase();
    const arr=lbAddForm.arr.trim().toUpperCase();
    if(!fn||!dep||!arr||!lbAddForm.depTime||!lbAddForm.arrTime) return alert("Please fill in all fields");
    const hasPrefix=/^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])\d+$/.test(fn);
    if(!hasPrefix) return alert("Include carrier prefix in flight number (e.g. UA374, G74475)");
    if(!roster) return alert("No roster selected");
    setLbAddSaving(true);
    try{
      const nc=[...(roster.calendar||[])];
      const today=new Date();
      const day=today.getDate();
      const dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][today.getDay()];
      const existing=nc.findIndex(d=>d.day===day);
      const nf={flightNum:fn,dep,arr,depTime:lbAddForm.depTime,arrTime:lbAddForm.arrTime,acType:lbAddForm.acType.trim().toUpperCase()||""};
      if(existing>=0){ nc[existing]={...nc[existing],flights:[...(nc[existing].flights||[]),nf]}; }
      else { nc.push({day,dow,isOff:false,flights:[nf]}); nc.sort((a,b)=>a.day-b.day); }
      await db_saveRoster(user.id,{...roster,calendar:nc},{skipMergeProtection:true});
      onRosterUpdated(roster.id,nc);
      setLbAddForm({show:false,flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
    }catch(e){alert(e.message);}
    setLbAddSaving(false);
  }

  function openFlight(di,fi,f,day,rosterOverride){
    const r=rosterOverride||roster;
    const tk=`${r.id}-${di}-${fi}`;
    const tail=tails[tk]||{};
    const mNum2=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum2+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
    const dist=calcDist(f.dep,f.arr);
    const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
    const blockMinsVal=(tail.actualBlockMins!=null?tail.actualBlockMins:schedMins(f))||0;
    const flightData={f,day,roster:r,di,fi,tk,tail,dateStr,dist,solar,blockMins:blockMinsVal,hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),dep:f.dep,arr:f.arr,isXC:(dist||0)>50,userId:user.id};
    try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterIdx:selRoster,rosterId:r.id,di,fi,flightData}));}catch{}
    setSelectedFlight(flightData);
  }

  // All flights flat for logbook view
  const allFlightsFlat = useMemo(()=>{
    const rows=[];
    for(const r of signedRosters){
      const mNum2=r.monthNum??r.month_num??0;
      (r.calendar||[]).forEach((d,di)=>{
        (d.flights||[]).forEach((f,fi)=>{
          const tk=`${r.id}-${di}-${fi}`;
          const t=tails[tk]||{};
          // Cancelled flights never operated -- they don't belong in the
          // permanent signed logbook record, even though the roster line
          // item still exists for reference in the roster/calendar view.
          if(t.cancelled) return;
          if(f.isDeadhead) return; // deadhead legs are informational-only -- never part of the logbook
          const dateStr=`${r.year}-${String(mNum2+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
          const blockMinsVal=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
          rows.push({f,d,di,fi,r,tk,t,dateStr,blockMins:blockMinsVal,mNum:mNum2});
        });
      });
    }
    rows.sort((a,b)=>{
      const dc=b.dateStr.localeCompare(a.dateStr);
      if(dc!==0) return dc;
      return (a.f.depTime||"00:00").localeCompare(b.f.depTime||"00:00");
    });
    return rows;
  },[signedRosters,tails]);

  const filteredFlights = useMemo(()=>{
    if(!search) return allFlightsFlat;
    const q=search.toLowerCase();
    return allFlightsFlat.filter(({f,t,dateStr})=>
      f.flightNum?.toLowerCase().includes(q)||
      f.dep?.toLowerCase().includes(q)||
      f.arr?.toLowerCase().includes(q)||
      t.tail?.toLowerCase().includes(q)||
      dateStr.includes(q)
    );
  },[allFlightsFlat,search]);

  // Stats for logbook view
  const lbStats = useMemo(()=>{
    let totalMins=0,legs=0,synced=0;
    const now=new Date();
    let monthMins=0;
    allFlightsFlat.forEach(({t,f,dateStr})=>{
      if(t.cancelled) return;
      if(f.isDeadhead) return; // deadhead -- doesn't count toward block time totals
      legs++;
      if(t.tail) synced++;
      const mins=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
      totalMins+=mins;
      const d=new Date(dateStr+"T00:00:00");
      if(d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()) monthMins+=mins;
    });
    return{totalHrs:fmtMins(totalMins),legs,synced,monthHrs:fmtMins(monthMins)};
  },[allFlightsFlat]);

  const S=getS();

  if(selectedFlight){
    const {f,day,roster:r,di,fi,tk,tail,dateStr,dist,solar,blockMins,hasActual,dep,arr,isXC,userId}=selectedFlight;
    return(
      <FlightDetailPage
        flight={f} tail={tail} solar={solar} dist={dist} blockMins={blockMins}
        day={day} roster={r} hasActual={hasActual} dep={dep} arr={arr} isXC={isXC}
        onBack={()=>{try{sessionStorage.removeItem("fl_open_flight");}catch{}setSelectedFlight(null);}}
        onAutoLookup={async()=>{
          setLkStatus(p=>({...p,[tk]:"loading"}));
          try{
            // forceRefresh:true — this button doubles as the manual
            // "Re-sync" action, which must always bypass the cache and
            // hit FlightAware fresh, otherwise it can never correct a
            // previously-cached wrong (pre-timezone-fix) time.
            const res=await fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f.flightNum,date:dateStr,dep:f.dep,arr:f.arr,depTime:f.depTime,forceRefresh:true})});
            const d=await res.json();
            if(d.error)throw new Error(d.error);
            if(d.tail||d.actualDep||d.actualArr){
              const updates={
                tail:d.tail||tail.tail,
                actualDep:d.actualDep||tail.actualDep,
                actualArr:d.actualArr||tail.actualArr,
                actualBlockMins:d.actualBlockMins??tail.actualBlockMins,
                depGate:d.depGate||tail.depGate||null,
                arrGate:d.arrGate||tail.arrGate||null,
              };
              const nc=[...(r.calendar||[])];
              const newTails={...tails,[tk]:{...tail,...updates}};
              await db_saveTail(user.id,tk,updates);
              onTailSaved(tk,{...tail,...updates});
              setSelectedFlight(p=>({...p,tail:{...p.tail,...updates},hasActual:true}));
              setLkStatus(p=>({...p,[tk]:"done"}));
            }else{setLkStatus(p=>({...p,[tk]:"notfound"}));}
          }catch(e){setLkStatus(p=>({...p,[tk]:"error"}));setLkError(p=>({...p,[tk]:e.message}));}
        }}
        onForceResync={()=>{}}
        lkStatus={lkStatus[tk]}
        lkError={lkError[tk]}
        onResetLimit={()=>{}}
        tmp={tmp[tk]||""}
        onTmpChange={v=>setTmp(p=>({...p,[tk]:v}))}
        onSaveTail={async(val)=>{
          setSaving(p=>({...p,[tk]:true}));
          try{
            await db_saveTail(user.id,tk,{tail:val});
            onTailSaved(tk,{...tail,tail:val});
            setSelectedFlight(p=>({...p,tail:{...p.tail,tail:val}}));
          }catch(e){alert(e.message);}
          setSaving(p=>({...p,[tk]:false}));
        }}
        saving={saving[tk]}
        onTailSaved={async(v)=>{
          const parts=tk.split("-");
          const rosterId2=parts.slice(0,-2).join("-");
          const fk2=parts.slice(-2).join("-");
          try{
            await db_saveTail(user.id,rosterId2,fk2,v);
            onTailSaved(tk,v);
            setSelectedFlight(p=>({...p,tail:{...p.tail,...v},hasActual:true}));
          }catch(e){alert(e.message);}
        }}
        editingTimes={editingTimes[tk]||false}
        setEditingTimes={v=>setEditingTimes(p=>({...p,[tk]:v}))}
        timeEdits={timeEdits[tk]||{}}
        setTimeEdits={v=>setTimeEdits(p=>({...p,[tk]:v}))}
        onSaveFlightFields={async(fields)=>{
          const nc = await saveFlightFieldsToRoster(user.id, r, di, fi, fields);
          onRosterUpdated(r.id, nc);
          setSelectedFlight(p=>({...p, f:{...p.f, ...fields}}));
        }}
        onDeleteFlight={async()=>{
          const nc = await deleteFlightFromRoster(user.id, r, di, fi);
          onRosterUpdated(r.id, nc);
          setSelectedFlight(null);
        }}
        di={di} fi={fi} userId={userId||user.id}
      />
    );
  }

  // -- PERMANENT LOGBOOK (view==="logbook") -- gated on signed months only;
  // Daily View has its own empty state further down and must never be
  // blocked by the absence of signed rosters.
  if(view==="logbook"&&signedRosters.length === 0) {
    return(
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:C.base,padding:32,gap:16,textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:4}}>🔒</div>
        <div style={{fontSize:18,fontWeight:800,color:C.ink,letterSpacing:"-.5px"}}>No verified flights yet</div>
        <div style={{fontSize:14,color:C.muted,lineHeight:1.6,maxWidth:320}}>
          Your permanent logbook only shows flights from <strong>verified & signed</strong> months. Upload a roster, then go to <strong>Active Logs</strong> to verify and sign it.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",maxWidth:280}}>
          <button onClick={()=>setPage?.("upload")} style={{padding:"13px",borderRadius:14,background:C.teal,border:"none",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
            Upload Roster
          </button>
          <button onClick={()=>setPage?.("active-logs")} style={{padding:"12px",borderRadius:14,background:"none",border:`1px solid ${C.border}`,color:C.muted,fontSize:14,fontWeight:600,cursor:"pointer"}}>
            Go to Active Logs
          </button>
        </div>
      </div>
    );
  }
  if(view==="logbook"){
    const pageCount=Math.ceil(filteredFlights.length/LB_PAGE_SIZE);
    const pageFlights=filteredFlights.slice(lbPage*LB_PAGE_SIZE,(lbPage+1)*LB_PAGE_SIZE);
    return(
      <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
        {/* Header */}
        <div style={{padding:"16px 20px",background:"rgba(248,250,252,0.9)",backdropFilter:"blur(12px)",borderBottom:`1px solid ${S.border}`,position:"sticky",top:0,zIndex:10,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
          <div>
            <h1 style={{fontSize:20,fontWeight:800,color:S.ink,margin:0,letterSpacing:"-.5px"}}>Digital Logbook</h1>
            <p style={{fontSize:12,color:S.muted,margin:"2px 0 0"}}>Your comprehensive, audit-ready flight history</p>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {/* Add Flight -- quick top-right shortcut straight to the Add
                Flight page, rather than needing the bottom-center "+"
                popup (which also offers Upload Roster as a second choice)
                every time from inside Daily View specifically. */}
            <button onClick={()=>setPage?.("add-flight")} title="Add Flight" style={{width:34,height:34,borderRadius:10,background:S.blue,border:"none",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/></svg>
            </button>
            {/* Export button */}
            <button onClick={()=>csvExport(signedRosters,tails)} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:10,background:S.surface,border:`1px solid ${S.border}`,color:S.silver,fontSize:12,fontWeight:600,cursor:"pointer"}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke={S.silver} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke={S.silver} strokeWidth="2.5" strokeLinecap="round"/></svg>
              Export CSV
            </button>
          </div>
        </div>

        <div style={{padding:"16px 20px",maxWidth:1200,margin:"0 auto",width:"100%",boxSizing:"border-box"}}>
          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12,marginBottom:20}}>
            {[
              {label:"Total Time",val:lbStats.totalHrs,gradient:false},
              {label:"Total Legs",val:lbStats.legs,gradient:false},
              {label:"Auto-Synced",val:lbStats.synced,gradient:false},
              {label:"This Month",val:lbStats.monthHrs,gradient:true},
            ].map(({label,val,gradient})=>(
              <div key={label} style={{background:gradient?`linear-gradient(135deg,${S.blueDim},${S.blue})`:S.surface,borderRadius:16,padding:"16px 18px",border:gradient?"none":`1px solid ${S.border}`,boxShadow:gradient?`0 4px 16px ${S.blue}25`:"0 1px 4px rgba(0,0,0,0.04)"}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",color:gradient?"rgba(255,255,255,0.75)":S.muted,marginBottom:4}}>{label}</div>
                <div style={{fontSize:24,fontWeight:900,color:gradient?"#fff":S.ink,letterSpacing:"-1px"}}>{val}</div>
              </div>
            ))}
          </div>

          {/* Main table container */}
          <div style={{background:S.surface,borderRadius:24,border:`1px solid ${S.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.06)",overflow:"hidden"}}>
            {/* Filters */}
            <div style={{padding:"14px 20px",borderBottom:`1px solid ${S.border}`,background:"rgba(248,250,252,0.5)",display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",justifyContent:"space-between"}}>
              <div style={{position:"relative",flex:1,minWidth:200,maxWidth:360}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)"}}>
                  <circle cx="11" cy="11" r="8" stroke={S.muted} strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <input
                  value={search}
                  onChange={e=>{setSearch(e.target.value);setLbPage(0);}}
                  placeholder="Search flights, tails, or airports..."
                  style={{width:"100%",padding:"8px 12px 8px 32px",borderRadius:10,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box"}}
                />
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <select
                  value={selRoster}
                  onChange={e=>setSelRoster(Number(e.target.value))}
                  style={{padding:"8px 12px",borderRadius:10,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.silver,outline:"none",cursor:"pointer"}}
                >
                  <option value={-1}>All signedRosters</option>
                  {signedRosters.map((r,i)=><option key={r.id} value={i}>{r.periodLabel}</option>)}
                </select>
              </div>
            </div>

            {/* Table */}
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,whiteSpace:"nowrap"}}>
                <thead>
                  <tr style={{background:S.panel,borderBottom:`1px solid ${S.border}`}}>
                    {["Date","Flight","Aircraft Type","Tail #","Route","Actual Dep","Actual Arr","Time","T/O & Ldg","Total Time","Multi-Eng","PIC/SIC","Night","XC","Dual","Actual Instr","Instrument","Sim","Instructor","Status"].map(h=>(
                      <th key={h} style={{padding:"10px 16px",textAlign:["Time","Total Time","Multi-Eng","Night","XC","Dual","Actual Instr","Instrument","Sim","Instructor","T/O & Ldg"].includes(h)?"right":["Status","PIC/SIC"].includes(h)?"center":"left",fontSize:10,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageFlights.length===0&&(
                    <tr><td colSpan={20} style={{padding:"40px",textAlign:"center",color:S.muted,fontSize:13}}>
                      {search?"No flights match your search":"No flights yet -- upload a roster to get started"}
                    </td></tr>
                  )}
                  {pageFlights.map(({f,t,dateStr,tk,di,fi,r,d},idx)=>{
                    const synced=!!t.tail;
                    const cancelled=!!t.cancelled;
                    const blockMinsForRow=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
                    const block=t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"--";
                    // Total Time is the same figure as Time (this app logs a
                    // single block-time value; there's no separate airborne-
                    // vs-block distinction in the data model) -- included as
                    // its own column since a traditional paper logbook lists
                    // both, even when a pilot's own operation makes them equal.
                    const totalTimeStr=blockMinsForRow>0?fmtMins(blockMinsForRow):"--";
                    const multiEngStr=f.loggedMultiEngMins!=null?fmtMins(f.loggedMultiEngMins):"--";
                    const picSicStr=f.loggedPicMins!=null&&f.loggedPicMins>0?"PIC":(f.loggedSicMins!=null&&f.loggedSicMins>0?"SIC":"--");
                    const nightStr=f.loggedNightMins!=null?fmtMins(f.loggedNightMins):"--";
                    const xcStr=f.loggedXcMins!=null?fmtMins(f.loggedXcMins):"--";
                    // Dual Received / Instrument (total, as distinct from
                    // Actual) / Instructor-given time have no corresponding
                    // fields anywhere in this app's data model -- there's no
                    // UI anywhere that captures dual-received or CFI-given
                    // time, so these three columns are genuinely always "--"
                    // rather than a fabricated value. Worth building real
                    // input fields for these if dual/instructor time logging
                    // is something to support going forward.
                    const dualStr="--";
                    const instructorStr="--";
                    const actualInstrStr=f.loggedActualIfrMins!=null?fmtMins(f.loggedActualIfrMins):"--";
                    // "Instrument" (total instrument time) is read as Actual +
                    // Simulated combined, the standard logbook convention --
                    // this app tracks the two separately (Actual IMC vs Hood/
                    // Sim) but not a pre-combined total field.
                    const instrumentTotalMins=(f.loggedActualIfrMins||0)+(f.loggedSimIfrMins||0);
                    const instrumentStr=instrumentTotalMins>0?fmtMins(instrumentTotalMins):"--";
                    const simStr=f.loggedSimIfrMins!=null?fmtMins(f.loggedSimIfrMins):"--";
                    const toLdgCount=(f.loggedDayLandings||0)+(f.loggedNightLandings||0);
                    const toLdgStr=toLdgCount>0?String(toLdgCount):"--";
                    return(
                      <tr
                        key={tk}
                        onClick={()=>{
                          const dist=calcDist(f.dep,f.arr);
                          const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
                          const bm=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
                          setSelectedFlight({f,day:d,roster:r,di,fi,tk,tail:t,dateStr,dist,solar,blockMins:bm,hasActual:!!(t.actualDep||t.actualArr||t.tail),dep:f.dep,arr:f.arr,isXC:(dist||0)>50,userId:user.id});
                        }}
                        style={{borderBottom:`1px solid ${S.panel}`,cursor:"pointer",background:idx%2===0?"transparent":"rgba(248,250,252,0.4)",transition:"background .1s"}}
                        onMouseEnter={e=>e.currentTarget.style.background="rgba(124,58,237,0.04)"}
                        onMouseLeave={e=>e.currentTarget.style.background=idx%2===0?"transparent":"rgba(248,250,252,0.4)"}
                      >
                        <td style={{padding:"13px 16px",color:S.ink,fontWeight:600}}>{dateStr}</td>
                        <td style={{padding:"13px 16px",color:S.silver}}>{cancelled?<span style={{textDecoration:"line-through",opacity:.6}}>{f.flightNum}</span>:f.flightNum}</td>
                        <td style={{padding:"13px 16px",color:f.acType?S.ink:S.muted,fontSize:12}}>{f.acType||"--"}</td>
                        <td style={{padding:"13px 16px",fontWeight:700,color:S.ink,fontFamily:"monospace",fontSize:12}}>{t.tail||<span style={{color:S.muted,fontWeight:400,fontSize:11}}>Pending</span>}</td>
                        <td style={{padding:"13px 16px"}}>
                          <span style={{fontWeight:700,color:S.ink}}>{f.dep}</span>
                          <span style={{color:S.muted,margin:"0 6px",fontSize:10}}>→</span>
                          <span style={{fontWeight:700,color:S.ink}}>{f.arr}</span>
                        </td>
                        <td style={{padding:"13px 16px",color:t.actualDep?S.ink:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12,fontWeight:t.actualDep?600:400}}>{t.actualDep||"--"}</td>
                        <td style={{padding:"13px 16px",color:t.actualArr?S.ink:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12,fontWeight:t.actualArr?600:400}}>{t.actualArr||"--"}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",fontWeight:700,color:S.ink}}>{block}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{toLdgStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",fontWeight:700,color:S.ink}}>{totalTimeStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{multiEngStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"center",fontSize:11,fontWeight:700,color:picSicStr==="--"?S.muted:S.blue}}>{picSicStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{nightStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{xcStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{dualStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{actualInstrStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{instrumentStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{simStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",color:S.muted,fontSize:12}}>{instructorStr}</td>
                        <td style={{padding:"13px 16px",textAlign:"center"}}>
                          {cancelled?(
                            <span style={{fontSize:10,fontWeight:700,color:C.red,background:C.redBg,padding:"3px 8px",borderRadius:100}}>CNCL</span>
                          ):synced?(
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" title={t.updatedAt?`Auto-Synced · ${fmtSyncTime(t.updatedAt)}`:"Auto-Synced"}><circle cx="12" cy="12" r="10" fill={C.greenBg}/><path d="M8 12l3 3 5-5" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          ):(
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" title="Pending sync"><circle cx="12" cy="12" r="10" fill={S.panel}/><path d="M12 8v4l2.5 2.5" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div style={{padding:"14px 20px",borderTop:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8,background:S.surface}}>
              <p style={{fontSize:12,color:S.muted,fontWeight:500}}>
                Showing <strong style={{color:S.ink}}>{lbPage*LB_PAGE_SIZE+1}</strong> to <strong style={{color:S.ink}}>{Math.min((lbPage+1)*LB_PAGE_SIZE,filteredFlights.length)}</strong> of <strong style={{color:S.ink}}>{filteredFlights.length}</strong> flights
              </p>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <button onClick={()=>setLbPage(p=>Math.max(0,p-1))} disabled={lbPage===0} style={{width:32,height:32,borderRadius:8,border:`1px solid ${S.border}`,background:S.surface,color:lbPage===0?S.muted:S.silver,cursor:lbPage===0?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:lbPage===0?.5:1}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                {Array.from({length:Math.min(5,pageCount)},(_,i)=>{
                  const pg=lbPage<=2?i:lbPage>=pageCount-3?pageCount-5+i:lbPage-2+i;
                  if(pg<0||pg>=pageCount) return null;
                  return(
                    <button key={pg} onClick={()=>setLbPage(pg)} style={{width:32,height:32,borderRadius:8,border:`1px solid ${pg===lbPage?S.purple+"44":S.border}`,background:pg===lbPage?C.blueBg:S.surface,color:pg===lbPage?S.purple:S.silver,fontWeight:pg===lbPage?700:500,fontSize:13,cursor:"pointer"}}>
                      {pg+1}
                    </button>
                  );
                })}
                <button onClick={()=>setLbPage(p=>Math.min(pageCount-1,p+1))} disabled={lbPage>=pageCount-1} style={{width:32,height:32,borderRadius:8,border:`1px solid ${S.border}`,background:S.surface,color:lbPage>=pageCount-1?S.muted:S.silver,cursor:lbPage>=pageCount-1?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:lbPage>=pageCount-1?.5:1}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // -- DAILY VIEW
  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:C.base}}>
      {/* Header */}
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flex:1}}>
          <select
            value={selRoster}
            onChange={e=>setSelRoster(Number(e.target.value))}
            style={{padding:"7px 12px",borderRadius:10,border:`1px solid ${C.border}`,fontSize:13,fontWeight:600,background:C.surface,color:C.ink,outline:"none",cursor:"pointer",flex:1,maxWidth:200}}
          >
            {dailyRosters.map((r,i)=>(
              <option key={r.id} value={i}>{r.periodLabel}{!signedMonths[r.id]?" (unsigned)":""}</option>
            ))}
          </select>
          {roster&&(
            <button
              onClick={async()=>{if(!window.confirm(`Delete roster "${roster.periodLabel}"? This cannot be undone.`))return;try{await onDeleteRoster(roster.id);setSelRoster(Math.max(0,selRoster-1));}catch(e){alert(e.message);}}}
              style={{padding:"7px 12px",borderRadius:10,border:`1px solid ${C.border}`,background:"none",color:C.muted,fontSize:12,cursor:"pointer",flexShrink:0}}
            >
              Delete
            </button>
          )}
          {/* Filter icon -- replaces the three standalone month/year/equipment
              dropdowns with a single popover, keeping the same underlying
              dvFilterMonth/dvFilterYear/dvFilterEquip state and filtering
              logic unchanged. */}
          <div style={{position:"relative",flexShrink:0}}>
            <button
              onClick={()=>setDvFilterPanelOpen(o=>!o)}
              aria-label="Filters"
              style={{width:34,height:34,borderRadius:10,border:`1px solid ${dvFiltersActive?C.teal:C.border}`,background:dvFiltersActive?`${C.teal}12`:"none",color:dvFiltersActive?C.teal:C.muted,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
              {dvFiltersActive&&<span style={{position:"absolute",top:-2,right:-2,width:8,height:8,borderRadius:"50%",background:C.teal,border:`1.5px solid ${C.surface}`}}/>}
            </button>
            {dvFilterPanelOpen&&(
              <>
                <div onClick={()=>setDvFilterPanelOpen(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
                <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,zIndex:21,background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,boxShadow:"0 12px 32px rgba(0,0,0,0.14)",padding:14,minWidth:220,display:"flex",flexDirection:"column",gap:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>Filter flights</div>
                  <select value={dvFilterMonth} onChange={e=>setDvFilterMonth(e.target.value)} style={{padding:"7px 10px",borderRadius:9,border:`1px solid ${C.border}`,fontSize:12,fontWeight:600,background:C.panel,color:C.ink,outline:"none",cursor:"pointer",width:"100%"}}>
                    <option value="all">All months</option>
                    {["January","February","March","April","May","June","July","August","September","October","November","December"].map((m,i)=>(
                      <option key={m} value={i}>{m}</option>
                    ))}
                  </select>
                  <select value={dvFilterYear} onChange={e=>setDvFilterYear(e.target.value)} style={{padding:"7px 10px",borderRadius:9,border:`1px solid ${C.border}`,fontSize:12,fontWeight:600,background:C.panel,color:C.ink,outline:"none",cursor:"pointer",width:"100%"}}>
                    <option value="all">All years</option>
                    {dvYearOptions.map(y=><option key={y} value={y}>{y}</option>)}
                  </select>
                  {dvEquipOptions.length>0&&(
                    <select value={dvFilterEquip} onChange={e=>setDvFilterEquip(e.target.value)} style={{padding:"7px 10px",borderRadius:9,border:`1px solid ${C.border}`,fontSize:12,fontWeight:600,background:C.panel,color:C.ink,outline:"none",cursor:"pointer",width:"100%"}}>
                      <option value="all">All equipment</option>
                      {dvEquipOptions.map(t=><option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {dvFiltersActive&&(
                    <button onClick={()=>{setDvFilterMonth("all");setDvFilterYear("all");setDvFilterEquip("all");}} style={{padding:"7px 10px",borderRadius:9,border:"none",background:"none",color:C.teal,fontSize:12,fontWeight:700,cursor:"pointer",textAlign:"center"}}>
                      Clear filters
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filter controls now live in the popover triggered by the filter icon
          in the header row above (next to Delete), rather than as standalone
          dropdowns taking up their own row. */}


      {/* Daily content -- LogTen Pro style: each flight is its own row with a
          big bold day number on the left, month/year beneath it, bold
          departure/arrival in the middle with duration, and tail number
          below the route. */}
      <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>
        {(!roster&&!dvFiltersActive)?(
          <div style={{textAlign:"center",padding:"48px 16px",color:C.muted}}>
            <div style={{fontSize:32,marginBottom:8}}>📋</div>
            <div style={{fontSize:14}}>No roster loaded -- upload one first</div>
          </div>
        ):(
          <>
            {(()=>{
              const MONTH_ABBR=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
              const mNum2=roster?(roster.monthNum??roster.month_num??0):0;
              const now=new Date();
              // Flatten every flight into one list, sorted chronologically --
              // the 1st of the month at the top, counting up toward month-end.
              // Unfiltered: just this month's roster (existing behavior).
              // Filtered: every roster matching month/year, across all of
              // dailyRosters, so a pilot can e.g. see every August across
              // every year, or every leg flown in one airplane type.
              const allDayFlights=[];
              if(dvFiltersActive){
                dailyRosters.forEach(r=>{
                  const rMNum=r.monthNum??r.month_num??0;
                  if(dvFilterMonth!=="all"&&Number(dvFilterMonth)!==rMNum) return;
                  if(dvFilterYear!=="all"&&Number(dvFilterYear)!==r.year) return;
                  (r.calendar||[]).filter(d=>(d.flights||[]).length>0).forEach(day=>{
                    const di=(r.calendar||[]).findIndex(d=>d.day===day.day);
                    const sorted=[...(day.flights||[])].map((f,fi)=>({f,fi}))
                      .filter(({f})=>!f.isDeadhead)
                      .filter(({f})=>dvFilterEquip==="all"||f.acType===dvFilterEquip);
                    sorted.forEach(({f,fi})=>allDayFlights.push({f,fi,di,day,roster:r,mNum:rMNum}));
                  });
                });
                allDayFlights.sort((a,b)=>{
                  const ad=`${a.roster.year}-${String(a.mNum+1).padStart(2,"0")}-${String(a.day.day).padStart(2,"0")}`;
                  const bd=`${b.roster.year}-${String(b.mNum+1).padStart(2,"0")}-${String(b.day.day).padStart(2,"0")}`;
                  return ad.localeCompare(bd)||(a.f.depTime||"00:00").localeCompare(b.f.depTime||"00:00");
                });
              } else if(roster){
                (roster.calendar||[]).filter(d=>(d.flights||[]).length>0).sort((a,b)=>a.day-b.day).forEach(day=>{
                  const di=(roster.calendar||[]).findIndex(d=>d.day===day.day);
                  const sorted=[...(day.flights||[])].map((f,fi)=>({f,fi})).filter(({f})=>!f.isDeadhead).sort((a,b)=>(a.f.depTime||"00:00").localeCompare(b.f.depTime||"00:00"));
                  sorted.forEach(({f,fi})=>allDayFlights.push({f,fi,di,day,roster,mNum:mNum2}));
                });
              }

              if(allDayFlights.length===0) return(
                <div style={{textAlign:"center",padding:"48px 16px",color:C.muted}}>
                  <div style={{fontSize:32,marginBottom:8}}>✈️</div>
                  <div style={{fontSize:14}}>{dvFiltersActive?"No flights match these filters":"No flights in this roster yet"}</div>
                </div>
              );

              return allDayFlights.map(({f,fi,di,day,roster:rowRoster,mNum:rowMNum})=>{
                const tk=`${rowRoster.id}-${di}-${fi}`;
                const tail=tails[tk]||{};
                const hasActual=!!(tail.actualDep||tail.actualArr||tail.tail);
                const isCancelled=!!tail.cancelled;
                const isDH=!!f.isDeadhead;
                const dist=calcDist(f.dep,f.arr);
                const blockMinsVal=tail.actualBlockMins!=null?tail.actualBlockMins:schedMins(f)||0;
                const isToday=day.day===now.getDate()&&rowMNum===now.getMonth()&&rowRoster.year===now.getFullYear();
                const depDisplay = hasActual?tail.actualDep:f.depTime;
                const arrDisplay = hasActual?tail.actualArr:f.arrTime;

                return(
                  <div key={`${rowRoster.id}-${di}-${fi}`}
                    onClick={()=>openFlight(di,fi,f,day,rowRoster)}
                    style={{
                      display:"flex",alignItems:"stretch",gap:14,
                      background:isCancelled?C.red+"08":C.surface,
                      border:`1px solid ${isCancelled?C.red+"33":C.border}`,
                      borderRadius:16,padding:"14px 16px",marginBottom:8,
                      cursor:"pointer",position:"relative",
                    }}
                  >
                    {/* Big bold day number, month/year beneath -- LogTen Pro style */}
                    <div style={{flexShrink:0,width:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",borderRight:`1px solid ${C.border}`,paddingRight:14}}>
                      <div style={{fontSize:28,fontWeight:900,color:isToday?C.teal:"#0F172A",lineHeight:1,letterSpacing:"-1px"}}>{day.day}</div>
                      <div style={{fontSize:10,fontWeight:700,color:C.muted,marginTop:3,letterSpacing:".5px"}}>{MONTH_ABBR[rowMNum]}</div>
                      <div style={{fontSize:10,fontWeight:600,color:C.muted}}>{rowRoster.year}</div>
                    </div>


                    {/* Route + duration + tail */}
                    <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",justifyContent:"center",gap:4}}>
                      <div style={{display:"flex",alignItems:"baseline",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,fontWeight:600,color:C.muted}}>{f.flightNum}</span>
                        {isDH&&<span style={{fontSize:9,fontWeight:800,color:"#fff",background:"#64748B",padding:"1px 6px",borderRadius:4}}>DH</span>}
                        {isCancelled&&<span style={{fontSize:9,fontWeight:700,color:C.red,background:C.red+"18",padding:"1px 6px",borderRadius:4}}>CANCELLED</span>}
                        {!isCancelled&&!isDH&&(dist||0)>50&&<span style={{fontSize:9,fontWeight:700,color:C.teal,background:C.teal+"18",padding:"1px 6px",borderRadius:4}}>XC</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:19,fontWeight:800,color:isCancelled?C.muted:"#0F172A",textDecoration:isCancelled?"line-through":"none",letterSpacing:"-.3px"}}>{f.dep}</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M5 12h14M14 6l6 6-6 6" stroke={C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        <span style={{fontSize:19,fontWeight:800,color:isCancelled?C.muted:"#0F172A",textDecoration:isCancelled?"line-through":"none",letterSpacing:"-.3px"}}>{f.arr}</span>
                        {!isCancelled&&depDisplay&&arrDisplay&&(
                          <span style={{fontSize:12,color:C.muted,marginLeft:4}}>{depDisplay} - {arrDisplay}</span>
                        )}
                      </div>
                      {!isCancelled&&tail.tail&&(
                        <div style={{display:"flex",alignItems:"center",gap:4}}>
                          <span style={{fontSize:12,fontWeight:600,color:hasActual?"#059669":C.muted,fontFamily:"monospace"}}>{tail.tail}</span>
                          {tail.finalSynced&&<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </div>
                      )}
                    </div>

                    {/* Duration on the right */}
                    {!isCancelled&&(
                      <div style={{flexShrink:0,display:"flex",flexDirection:"column",alignItems:"flex-end",justifyContent:"center",gap:2}}>
                        <div style={{fontSize:16,fontWeight:800,color:"#0F172A"}}>{blockMinsVal?fmtMins(blockMinsVal):"--"}</div>
                        {dist&&<div style={{fontSize:10,color:C.muted}}>{dist} NM</div>}
                      </div>
                    )}

                    {/* Delete button */}
                    <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm(`Delete flight ${f.flightNum} ${f.dep}→${f.arr}?`))return;const nc=[...(rowRoster.calendar||[])];nc[di]={...nc[di],flights:(nc[di].flights||[]).filter((_,i)=>i!==fi)};try{await db_saveRoster(user.id,{...rowRoster,calendar:nc},{skipMergeProtection:true});onRosterUpdated(rowRoster.id,nc);}catch(err){alert(err.message);}}}
                      style={{position:"absolute",top:6,right:6,width:20,height:20,borderRadius:"50%",background:"none",border:"none",color:C.muted,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:0.4,lineHeight:1}}
                      title="Delete flight"
                    >×</button>
                  </div>
                );
              });
            })()}

            {/* Add flight */}
            <div style={{margin:"8px 0 20px"}}>
              {!lbAddForm.show?(
                <button onClick={()=>setLbAddForm(f=>({...f,show:true}))} style={{
                  width:"100%",padding:"18px 16px",borderRadius:16,
                  background:C.surface,
                  border:`2px dashed ${C.border}`,
                  color:C.muted,cursor:"pointer",
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,
                  transition:"all .15s",
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor=C.teal;e.currentTarget.style.background=C.teal+"08";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.background=C.surface;}}
                >
                  <div style={{width:44,height:44,borderRadius:12,background:C.teal+"15",display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke={C.teal} strokeWidth="2.5" strokeLinecap="round"/></svg>
                  </div>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:C.ink}}>Add a flight</div>
                    <div style={{fontSize:12,color:C.muted,marginTop:2}}>Manually add to {"today's"} roster</div>
                  </div>
                </button>
              ):(
                <div className="card">
                  <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:12}}>Add flight</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    {[["flightNum","Flight # (e.g. UA374)","UA374"],["acType","Aircraft","CRJ7"],["dep","Dep airport","ORD"],["arr","Arr airport","SCE"]].map(([key,label,ph])=>(
                      <div key={key}>
                        <div className="form-label">{label}</div>
                        <input className="form-input" placeholder={ph} value={lbAddForm[key]} onChange={e=>setLbAddForm(f=>({...f,[key]:e.target.value}))}/>
                      </div>
                    ))}
                    <div>
                      <div className="form-label">Dep time</div>
                      <input className="form-input" type="time" value={lbAddForm.depTime} onChange={e=>setLbAddForm(f=>({...f,depTime:e.target.value}))}/>
                    </div>
                    <div>
                      <div className="form-label">Arr time</div>
                      <input className="form-input" type="time" value={lbAddForm.arrTime} onChange={e=>setLbAddForm(f=>({...f,arrTime:e.target.value}))}/>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={lbSaveFlight} disabled={lbAddSaving} style={{flex:1,padding:"10px",borderRadius:8,background:C.teal,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                      {lbAddSaving?<span className="spinner">⟳</span>:"Save flight"}
                    </button>
                    <button onClick={()=>setLbAddForm(f=>({...f,show:false}))} style={{flex:1,padding:"10px",borderRadius:8,background:"none",border:"1px solid #E2E8F0",color:C.muted,fontSize:13,cursor:"pointer"}}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Module-level cache so the same airport is only ever geocoded once per
// session, regardless of how many times a flight involving it is viewed.
// Persisted to localStorage too, so it survives a reload -- a geocode
// lookup is a real network round-trip, worth not repeating needlessly.
const _airportGeocodeCache = (() => {
  try { return JSON.parse(localStorage.getItem("fl_airport_geocode_cache")||"{}"); }
  catch { return {}; }
})();
function _persistGeocodeCache() {
  try { localStorage.setItem("fl_airport_geocode_cache", JSON.stringify(_airportGeocodeCache)); } catch {}
}

// OurAirports publishes a free, open, no-API-key CSV of essentially every
// airport worldwide with real IATA codes and verified coordinates -- a
// dataset purpose-built for exactly this, unlike Nominatim (a general
// place-name search with zero aviation awareness, which is what sent PIA
// to Australia: "PIA" is also a real place-name match elsewhere, and
// nothing about a bare 3-letter string tells a general geocoder "this is
// specifically an airport"). Fetched and parsed ONCE per session, cached
// in localStorage so every subsequent lookup for ANY airport code is an
// instant, reliable local match rather than a repeated network guess.
let _ourAirportsTable = null; // null = not yet loaded, {} = loaded (may still be empty on failure)
let _ourAirportsLoadPromise = null;
async function _loadOurAirportsTable() {
  // A real parse of this dataset yields ~9,000 IATA-keyed entries. Anything
  // dramatically smaller is not a partial success -- it's the signature of a
  // poisoned parse (see below), so size is the validity check throughout.
  const isValidTable = t => t && typeof t==="object" && Object.keys(t).length > 500;
  if(isValidTable(_ourAirportsTable)) return _ourAirportsTable;
  if(_ourAirportsLoadPromise) return _ourAirportsLoadPromise;
  _ourAirportsLoadPromise = (async () => {
    try {
      // Cache key is VERSIONED (v2) specifically because the previous
      // parser used a naive comma-split that silently corrupted or
      // dropped any airport whose name field contained a comma -- a
      // browser that already ran the old parser has a bad table sitting
      // in localStorage under the old key, and would keep serving it
      // forever if this read used the same key. Bumping the key forces
      // a fresh fetch+parse with the corrected quote-aware splitter.
      //
      // The persisted table must ALSO pass the size sanity check before
      // being trusted: a captive-portal WiFi login page (an everyday
      // reality on hotel/airport networks) returns HTTP 200 with HTML
      // instead of the CSV, which used to parse to an EMPTY table that
      // was then persisted here and trusted forever after -- permanently
      // killing this entire data source on that device, so every airport
      // outside the small built-in dictionary showed "map unavailable".
      // An undersized persisted table is that poison; discard it and
      // refetch rather than serving it.
      const persisted = localStorage.getItem("fl_ourairports_table_v2");
      if(persisted) {
        const parsed = JSON.parse(persisted);
        if(isValidTable(parsed)) { _ourAirportsTable = parsed; return _ourAirportsTable; }
        try { localStorage.removeItem("fl_ourairports_table_v2"); } catch {}
      }
    } catch {}
    try {
      const res = await fetch("https://davidmegginson.github.io/ourairports-data/airports.csv");
      if(!res.ok) throw new Error(`ourairports fetch ${res.status}`);
      const text = await res.text();
      const table = {};
      // A naive line.split(",") is WRONG for real CSV: this dataset's own
      // `name` column routinely contains a comma inside quotes (e.g.
      // "Peoria, Greater Peoria Regional Airport"), which shifts every
      // column after it out of position for that row -- silently
      // corrupting or dropping the coordinates for any airport whose name
      // happens to contain a comma. That's not random bad luck; CID, PIA,
      // GRB, SGF and others failing together is exactly the signature of
      // a systematic parsing bug, not scattered lookup failures. This is a
      // minimal, genuinely quote-aware CSV line splitter (handles quoted
      // fields, embedded commas, and "" as an escaped quote per RFC 4180)
      // rather than another shortcut that only works until the next field
      // with a comma in it.
      function splitCsvLine(line) {
        const fields = [];
        let cur = "";
        let inQuotes = false;
        for(let i=0;i<line.length;i++){
          const ch = line[i];
          if(inQuotes){
            if(ch==='"'){
              if(line[i+1]==='"'){ cur+='"'; i++; } // escaped quote
              else { inQuotes=false; }
            } else { cur+=ch; }
          } else {
            if(ch==='"'){ inQuotes=true; }
            else if(ch===','){ fields.push(cur); cur=""; }
            else { cur+=ch; }
          }
        }
        fields.push(cur);
        return fields;
      }
      const lines = text.split("\n");
      const header = splitCsvLine(lines[0]);
      const iataIdx = header.indexOf("iata_code");
      const latIdx = header.indexOf("latitude_deg");
      const lonIdx = header.indexOf("longitude_deg");
      if(iataIdx>=0 && latIdx>=0 && lonIdx>=0) {
        for(let i=1;i<lines.length;i++) {
          if(!lines[i].trim()) continue;
          const row = splitCsvLine(lines[i]);
          const iata = (row[iataIdx]||"").trim().toUpperCase();
          if(!iata || iata.length!==3) continue;
          const lat = parseFloat(row[latIdx]), lon = parseFloat(row[lonIdx]);
          if(isNaN(lat) || isNaN(lon)) continue;
          table[iata] = [lat, lon];
        }
      }
      // Only accept a parse that looks like the real dataset. An empty or
      // near-empty result here means the response body wasn't the CSV at
      // all (captive portal, error page, truncated response) -- caching or
      // persisting it would poison this source until manually cleared, so
      // treat it exactly like a network failure: reset and let a later
      // call retry.
      if(!isValidTable(table)) {
        _ourAirportsLoadPromise = null;
        return {};
      }
      _ourAirportsTable = table;
      try { localStorage.setItem("fl_ourairports_table_v2", JSON.stringify(table)); } catch {}
      return table;
    } catch {
      // Network/parse failure -- don't cache a permanent empty table for
      // what might just be a transient error; leave _ourAirportsTable null
      // so the next call retries instead of assuming this source is dead.
      _ourAirportsLoadPromise = null;
      return {};
    }
  })();
  return _ourAirportsLoadPromise;
}

// Resolves an IATA/ICAO-ish code to [lat, lon] when it's NOT in the local
// AIRPORT_COORDS fast-path dictionary. That dictionary is a small, hand-
// curated list (~96 major/regional airports) -- it will never keep pace
// with every field a pilot actually routes through (this fix exists
// because TVC, a genuine, real, mid-size regional airport, wasn't in it).
// Rather than keep hand-adding one code at a time, an unknown code gets a
// real geocode attempt against Nominatim (OpenStreetMap's free, no-API-key
// geocoder) before the map gives up and shows "unavailable" -- so this
// closes the whole CLASS of missing-airport bugs, not just this one code.
// Coarse [minLat, maxLat, minLon, maxLon] bounding boxes per IANA timezone
// PREFIX (matched by startsWith, so e.g. "America/Indiana/Indianapolis"
// matches the "America/" box) -- deliberately generous, not precise. This
// exists purely to catch a GROSSLY wrong geocode result (wrong continent,
// wrong hemisphere), not to validate exact position. AIRPORT_TZ already
// has this app's own independently-verified region for ~630 airports; if
// a code is known there, its geocoded coordinate must plausibly fall
// within its own region's box or the result is rejected outright.
const TZ_REGION_BOUNDS = {
  "America/":  [5, 72, -180, -52],   // North America incl. Mexico, Canada, Alaska out to the far Aleutians (ADK/GAM/SNP sit west of -168)
  "Pacific/Honolulu": [18, 23, -161, -154],
  "Pacific/":  [-52, 22, 130, -150], // wraps the antimeridian -- wide on purpose
  "Europe/":   [34, 71, -25, 45],
  "Asia/":     [-10, 55, 25, 150],
  "Africa/":   [-35, 38, -18, 52],
  "Australia/":[-45, -9, 110, 155],
  "Atlantic/": [14, 68, -70, 0],
};
function isCoordPlausibleForTz(lat, lon, tz) {
  if(!tz) return true; // no known region to check against -- can't reject, don't block
  const prefixMatch = Object.keys(TZ_REGION_BOUNDS).find(p => tz.startsWith(p));
  if(!prefixMatch) return true; // region not covered by this coarse table -- don't block on absence of data
  const [minLat,maxLat,minLon,maxLon] = TZ_REGION_BOUNDS[prefixMatch];
  if(minLon > maxLon) { // antimeridian-wrapping box (Pacific)
    return lat>=minLat && lat<=maxLat && (lon>=minLon || lon<=maxLon);
  }
  return lat>=minLat && lat<=maxLat && lon>=minLon && lon<=maxLon;
}

async function resolveAirportCoords(code) {
  if(!code) return null;
  if(AIRPORT_COORDS[code]) return AIRPORT_COORDS[code];
  if(_airportGeocodeCache[code] !== undefined) {
    const cached = _airportGeocodeCache[code];
    // A cached NULL means "every source we tried at the time failed" --
    // but that's not a stable fact the way a real coordinate is. It may
    // predate the OurAirports fallback entirely, or predate the parser
    // fix for it (which silently corrupted/dropped some airports from the
    // table). Don't trust a cached null; fall through and let the current,
    // corrected resolution chain actually run. A cached REAL coordinate is
    // still checked for plausibility before being trusted, same as before.
    if(cached!==null && isCoordPlausibleForTz(cached[0], cached[1], AIRPORT_TZ[code])) {
      return cached;
    }
    // Falls through to a fresh lookup below.
  }
  // Try real aviation data FIRST -- a direct IATA-code lookup against a
  // purpose-built airport dataset has none of the ambiguity a general
  // place-name search does. This is the actual fix for PIA: the previous
  // fix correctly caught and rejected the wrong Australian match, but
  // without a real alternative source, a code whose every Nominatim
  // candidate happens to be a non-airport match was left stuck at
  // "unresolvable" -- correctly not-wrong, but still not useful.
  try {
    const table = await _loadOurAirportsTable();
    if(table && table[code]) {
      const coords = table[code];
      // Lower risk of a wrong-region match here than with Nominatim's
      // free-text search (this is structured, IATA-keyed aviation data,
      // not a place-name guess), but the check is cheap and consistent
      // application closes the gap rather than assuming this source is
      // infallible.
      if(isCoordPlausibleForTz(coords[0], coords[1], AIRPORT_TZ[code])) {
        _airportGeocodeCache[code] = coords;
        _persistGeocodeCache();
        return coords;
      }
    }
  } catch {}
  try {
    // limit=3, not 1: Nominatim is a general place-name search with no
    // aviation awareness -- a short code like "PIA" is also a real place
    // name elsewhere (this is exactly what sent Peoria's PIA to Australia
    // previously), so the top-ranked hit isn't automatically the airport.
    // Requesting a few candidates and checking each against the airport's
    // own known region (via AIRPORT_TZ, independently verified for ~630
    // airports) means a wrong top match doesn't waste the whole lookup --
    // often a correct result is sitting right behind it.
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=3&q=${encodeURIComponent(code+" airport")}`,
      { headers: { "Accept-Language": "en" } }
    );
    const data = await res.json();
    const knownTz = AIRPORT_TZ[code]; // may be undefined -- isCoordPlausibleForTz handles that
    let coords = null;
    for(const hit of (data||[])) {
      const lat = parseFloat(hit.lat), lon = parseFloat(hit.lon);
      if(isNaN(lat) || isNaN(lon)) continue;
      if(isCoordPlausibleForTz(lat, lon, knownTz)) { coords = [lat, lon]; break; }
    }
    // Every candidate failed the plausibility check (or there were none) --
    // this is a REJECTED result, not silently accepting the top hit anyway.
    // A wrong-but-confident coordinate is worse than admitting "unresolvable":
    // it produces a fabricated, plausible-looking distance that could
    // actively mislead a pilot, rather than an honest "--".
    _airportGeocodeCache[code] = coords;
    _persistGeocodeCache();
    return coords;
  } catch {
    // Network failure: don't cache a permanent null for what might just be
    // a transient error -- let the next attempt try again.
    return null;
  }
}

// -- Flight Route Map -- dark basemap + live weather radar (RainViewer) --------
// Shown on the Flight Detail page. Uses CartoDB Dark Matter tiles for a true
// dark geographical landscape (coastlines, terrain shading, roads, labels —
// all rendered dark, unlike a plain dark-tinted background). Always overlays
// the latest RainViewer radar frame, regardless of how far away the flight
// is, so the pilot can see current precipitation along the route any time
// they open a flight's detail page.
function FlightRouteMap({dep, arr, dist, flightDateStr, flightDepTime, S, compact, hero}) {
  const mapElRef = useRef(null);
  const leafletMapRef = useRef(null);
  const layersRef = useRef([]);
  const [radarLoaded, setRadarLoaded] = useState(false);
  const [radarFailed, setRadarFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [resolving, setResolving] = useState(true);
  const [c1, setC1] = useState(AIRPORT_COORDS[dep] || null);
  const [c2, setC2] = useState(AIRPORT_COORDS[arr] || null);
  const [mapResolveAttempt, setMapResolveAttempt] = useState(0);
  // Tracks which dep|arr pair the current c1/c2/attempt state belongs to.
  // Without this, a mounted map whose props change to a NEW airport pair
  // (the Dashboard's compact card does this whenever nextFlight advances)
  // carried the PREVIOUS pair's state forward: the dictionary fast-path
  // below never wrote c1/c2 (it only relied on the useState initializers,
  // which run once per mount), so a stale coordinate -- or worse, a stale
  // null from a pair that failed to resolve -- rendered the wrong region
  // or "Route map unavailable" for airports that resolve perfectly fine.
  // The retry budget had the same leak: a pair that exhausted its 3
  // attempts left mapResolveAttempt at 3, so the next pair started with
  // zero retries.
  const pairRef = useRef(`${dep}|${arr}`);

  // Fast path: if both are already in the static dictionary, this resolves
  // synchronously on first render (no flicker, no network call). Anything
  // missing goes through the geocoding fallback -- this is the actual fix
  // for airports like TVC that simply aren't in the ~96-entry hand-curated
  // list, without needing to add every such airport by hand one at a time.
  useEffect(() => {
    let cancelled = false;
    const pair = `${dep}|${arr}`;
    if(pairRef.current !== pair) {
      pairRef.current = pair;
      if(mapResolveAttempt !== 0) { setMapResolveAttempt(0); return; } // re-enter with a fresh retry budget
    }
    async function resolve() {
      const [r1, r2] = await Promise.all([resolveAirportCoords(dep), resolveAirportCoords(arr)]);
      if(cancelled) return;
      if((!r1 || !r2) && mapResolveAttempt < 3) {
        // A genuine resolution failure here previously meant c1/c2 were
        // set to null ONCE, resolving=false, and that was permanent -- no
        // retry, since this effect's dependency array only watches
        // [dep, arr], which never changes for the same flight. That
        // silently hid the ENTIRE map (radar included, since radar only
        // ever loads once mapReady flips true) behind "Route map
        // unavailable" for any airport whose resolution happened to fail
        // even once, indistinguishable from a genuinely unresolvable one.
        setTimeout(()=>{ if(!cancelled) setMapResolveAttempt(a=>a+1); }, 2000*(mapResolveAttempt+1));
        return; // don't set resolving=false yet -- keep showing "Locating..." through the retry
      }
      setC1(r1); setC2(r2); setResolving(false);
    }
    if(AIRPORT_COORDS[dep] && AIRPORT_COORDS[arr]) {
      // Write the coordinates explicitly rather than trusting the useState
      // initializers -- those only ran for whatever pair was mounted FIRST.
      setC1(AIRPORT_COORDS[dep]); setC2(AIRPORT_COORDS[arr]); setResolving(false);
    }
    else { setResolving(true); resolve(); }
    return () => { cancelled = true; };
  }, [dep, arr, mapResolveAttempt]);

  // Load Leaflet once, init the map
  useEffect(() => {
    if(!c1 || !c2 || !mapElRef.current) return;

    if(!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    function initMap() {
      const L = window.L;
      if(!L || leafletMapRef.current) return;

      const midLat = (c1[0]+c2[0])/2, midLon = (c1[1]+c2[1])/2;
      const map = L.map(mapElRef.current, {
        center: [midLat, midLon],
        zoom: 5,
        zoomControl: true,
        attributionControl: false,
        scrollWheelZoom: false,
      });

      // Dark Matter basemap — real coastlines, terrain, roads, city labels,
      // all rendered in a dark theme. This is a genuine geographic map, not
      // a flat dark background.
      // Dark Matter basemap — real coastlines, terrain, roads, city labels,
      // all rendered in a dark theme. This is a genuine geographic map, not
      // a flat dark background. {r} is Leaflet's own retina-detection
      // placeholder -- it automatically requests @2x tiles on high-DPI
      // screens and standard tiles otherwise, which is the correct behavior
      // (hardcoding @2x would force double-resolution tiles even on
      // standard screens for no visual benefit there, just wasted bandwidth).
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        subdomains: "abcd",
      }).addTo(map);

      leafletMapRef.current = map;
      setMapReady(true);
    }

    if(window.L) {
      initMap();
    } else if(!document.getElementById("leaflet-js")) {
      const script = document.createElement("script");
      script.id = "leaflet-js";
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      script.onload = initMap;
      document.head.appendChild(script);
    } else {
      // Script tag exists but may still be loading — poll briefly
      const iv = setInterval(() => { if(window.L) { clearInterval(iv); initMap(); } }, 150);
      setTimeout(() => clearInterval(iv), 5000);
    }

    return () => {
      if(leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
      setMapReady(false);
    };
  }, [dep, arr, c1, c2]);

  // Draw route + airport markers once map is ready
  useEffect(() => {
    if(!mapReady || !c1 || !c2) return;
    const L = window.L;
    const map = leafletMapRef.current;
    if(!L || !map) return;

    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];

    const pts = greatCirclePoints(c1[0], c1[1], c2[0], c2[1]);
    const line = L.polyline(pts, { color:"#3B82F6", weight:3.5, opacity:0.95, smoothFactor:1 }).addTo(map);
    layersRef.current.push(line);

    const depIcon = L.divIcon({
      html: `<div style="width:14px;height:14px;border-radius:50%;background:#3B82F6;border:3px solid rgba(255,255,255,0.9);box-shadow:0 0 0 4px rgba(59,130,246,0.25)"></div>`,
      className: "", iconSize:[14,14], iconAnchor:[7,7],
    });
    const arrIcon = L.divIcon({
      html: `<div style="width:14px;height:14px;border-radius:50%;background:#10B981;border:3px solid rgba(255,255,255,0.9);box-shadow:0 0 0 4px rgba(16,185,129,0.25)"></div>`,
      className: "", iconSize:[14,14], iconAnchor:[7,7],
    });
    const depMarker = L.marker(c1, {icon:depIcon}).addTo(map).bindTooltip(dep, {permanent:true, direction:"top", className:"flmap-label", offset:[0,-10]});
    const arrMarker = L.marker(c2, {icon:arrIcon}).addTo(map).bindTooltip(arr, {permanent:true, direction:"top", className:"flmap-label", offset:[0,-10]});
    layersRef.current.push(depMarker, arrMarker);

    const bounds = L.latLngBounds([c1, c2]);
    map.fitBounds(bounds, {padding:[40,40], maxZoom:7});
  }, [mapReady, dep, arr]);

  // Overlay live weather radar (RainViewer) for every flight
  useEffect(() => {
    if(!mapReady) return;
    const L = window.L;
    const map = leafletMapRef.current;
    if(!L || !map) return;

    let radarLayer = null;
    let refreshInterval = null;
    let retryTimeout = null;
    let cancelled = false;

    async function loadRadar(attempt=0) {
      try {
        // cache:"no-store" + a unique query param: radar frames expire from
        // RainViewer's tile servers within ~2 hours, so a STALE copy of
        // this frame list (from the browser HTTP cache, or a not-yet-
        // updated service worker's offline fallback) yields tile URLs that
        // all 404 silently -- the badge said "Live" over an empty layer,
        // and the retry logic below never engaged because the fetch itself
        // "succeeded". Making this request uncacheable turns stale-cache
        // scenarios into honest network errors that the retry/radarFailed
        // path already handles correctly.
        const r = await fetch(`https://api.rainviewer.com/public/weather-maps.json?t=${Date.now()}`, {cache:"no-store"});
        const data = await r.json();
        const frames = data?.radar?.past || [];
        const latest = frames[frames.length - 1];
        if(!latest) throw new Error("no radar frames in response");
        if(cancelled) return;
        if(radarLayer) { try { map.removeLayer(radarLayer); } catch {} }
        radarLayer = L.tileLayer(
          `https://tilecache.rainviewer.com${latest.path}/256/{z}/{x}/{y}/2/1_1.png`,
          { opacity:0.55, maxZoom:12, zIndex:400 }
        ).addTo(map);
        layersRef.current = layersRef.current.filter(l=>l!==radarLayer);
        layersRef.current.push(radarLayer);
        setRadarLoaded(true);
        setRadarFailed(false);
      } catch {
        // Previously this failed completely silently with no retry until
        // the next scheduled 5-minute refresh tick -- a single transient
        // network hiccup at page-load time could leave radar missing for
        // up to 5 minutes with zero indication anything went wrong. Now:
        // retry a few times with backoff, and if every attempt genuinely
        // fails, surface that as a real state (setRadarFailed) rather than
        // silence indistinguishable from "just hasn't loaded yet."
        if(cancelled) return;
        if(attempt < 3) {
          retryTimeout = setTimeout(()=>{ if(!cancelled) loadRadar(attempt+1); }, 3000*(attempt+1));
        } else {
          setRadarFailed(true);
        }
      }
    }

    loadRadar();
    // Auto-refresh radar every 5 minutes so it stays current
    refreshInterval = setInterval(()=>loadRadar(0), 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(refreshInterval);
      if(retryTimeout) clearTimeout(retryTimeout);
      if(radarLayer && map) { try { map.removeLayer(radarLayer); } catch {} }
    };
  }, [mapReady]);

  if(resolving) return hero ? (
    <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",background:"#0B1120"}}>
      <div style={{fontSize:12.5,color:"rgba(255,255,255,0.55)"}}>Locating {dep} / {arr}...</div>
    </div>
  ) : (
    <div style={{padding:"16px",borderRadius:14,background:S.panel,border:`1px solid ${S.border}`,textAlign:"center"}}>
      <div style={{fontSize:12.5,color:S.muted}}>Locating {dep} / {arr}...</div>
    </div>
  );

  if(!c1 || !c2) return hero ? (
    <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#0B1120",padding:20,textAlign:"center"}}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{marginBottom:8}}><path d="M12 21c-4-4.5-7-8.2-7-11.5A7 7 0 0119 9.5c0 3.3-3 7-7 11.5z" stroke="rgba(255,255,255,0.4)" strokeWidth="1.8"/><circle cx="12" cy="9.5" r="2.3" stroke="rgba(255,255,255,0.4)" strokeWidth="1.8"/><path d="M4 21h16" stroke="rgba(255,255,255,0.4)" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2 3"/></svg>
      <div style={{fontSize:12.5,color:"rgba(255,255,255,0.55)",lineHeight:1.5}}>Route map unavailable -- couldn't locate {!c1?dep:arr}.</div>
    </div>
  ) : (
    <div style={{padding:"16px",borderRadius:14,background:S.panel,border:`1px solid ${S.border}`,textAlign:"center"}}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{marginBottom:8}}><path d="M12 21c-4-4.5-7-8.2-7-11.5A7 7 0 0119 9.5c0 3.3-3 7-7 11.5z" stroke={S.muted} strokeWidth="1.8"/><circle cx="12" cy="9.5" r="2.3" stroke={S.muted} strokeWidth="1.8"/><path d="M4 21h16" stroke={S.muted} strokeWidth="1.8" strokeLinecap="round" strokeDasharray="2 3"/></svg>
      <div style={{fontSize:12.5,color:S.muted,lineHeight:1.5}}>
        Route map unavailable -- couldn't locate {!c1?dep:arr}.
      </div>
    </div>
  );

  if(hero) return (
    <>
      <div ref={mapElRef} style={{width:"100%",height:"100%"}}/>
      {/* Radar live indicator -- sits below the back/delete button row (not
          beside it) so the two floating UI groups never occupy the same
          top-right corner of the map. */}
      <div style={{position:"absolute",top:60,right:16,zIndex:1100,display:"flex",alignItems:"center",gap:5,background:"rgba(15,23,42,0.65)",backdropFilter:"blur(8px)",padding:"5px 10px",borderRadius:100,border:"1px solid rgba(255,255,255,0.15)"}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:radarFailed?"#EF4444":radarLoaded?"#22C55E":"#94A3B8",display:"inline-block",animation:radarLoaded?"radarPulse 2s ease-in-out infinite":"none",flexShrink:0}}/>
        <span style={{fontSize:10,fontWeight:700,color:radarFailed?"#F87171":radarLoaded?"#4ADE80":"#94A3B8"}}>{radarFailed?"Radar unavailable":radarLoaded?"Live":"Radar..."}</span>
      </div>
      <style>{`
        .flmap-label{background:rgba(15,23,42,0.85)!important;color:#fff!important;border:none!important;box-shadow:0 2px 8px rgba(0,0,0,0.3)!important;font-weight:800!important;font-size:11px!important;padding:3px 8px!important;border-radius:6px!important;}
        .flmap-label::before{display:none!important;}
        .leaflet-control-zoom a{background:#1E293B!important;color:#fff!important;border-color:#334155!important;}
        @keyframes radarPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(1.3)}}
      `}</style>
    </>
  );

  return (
    <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:"16px 18px",overflow:"hidden"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px"}}>Route Map</div>
        {dist&&<span style={{fontSize:11,color:S.muted,fontWeight:600}}>{dist} NM</span>}
      </div>
      {/* Map container — radar dot overlaid at top-right inside the map */}
      <div style={{position:"relative",width:"100%",height:compact?130:220,borderRadius:12,overflow:"hidden",background:"#0B1120"}}>
        <div ref={mapElRef} style={{width:"100%",height:"100%"}}/>
        {/* Radar live indicator -- top-right corner of the map itself */}
        <div style={{position:"absolute",top:8,right:8,zIndex:1000,display:"flex",alignItems:"center",gap:5,background:"rgba(15,23,42,0.75)",backdropFilter:"blur(6px)",padding:"4px 8px",borderRadius:100,border:"1px solid rgba(255,255,255,0.1)"}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:radarFailed?"#EF4444":radarLoaded?"#22C55E":"#94A3B8",display:"inline-block",animation:radarLoaded?"radarPulse 2s ease-in-out infinite":"none",flexShrink:0}}/>
          <span style={{fontSize:10,fontWeight:700,color:radarFailed?"#F87171":radarLoaded?"#4ADE80":"#94A3B8"}}>{radarFailed?"Radar unavailable":radarLoaded?"Live":"Radar..."}</span>
        </div>
      </div>
      <style>{`
        .flmap-label{background:rgba(15,23,42,0.85)!important;color:#fff!important;border:none!important;box-shadow:0 2px 8px rgba(0,0,0,0.3)!important;font-weight:800!important;font-size:11px!important;padding:3px 8px!important;border-radius:6px!important;}
        .flmap-label::before{display:none!important;}
        .leaflet-control-zoom a{background:#1E293B!important;color:#fff!important;border-color:#334155!important;}
        @keyframes radarPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(1.3)}}
      `}</style>
    </div>
  );
}


function FlightDetailPage({
  flight:f, tail, solar, dist, blockMins, day, roster,
  hasActual, dep, arr, isXC, onBack, onAutoLookup, onForceResync,
  lkStatus, lkError, onResetLimit, tmp, onTmpChange, onSaveTail,
  saving, onTailSaved, editingTimes, setEditingTimes, timeEdits,
  setTimeEdits, di, fi, userId, onSaveFlightFields, onDeleteFlight
}) {
  const S = getS();
  const [briefing, setBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingExpiresAt, setBriefingExpiresAt] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingFlight, setDeletingFlight] = useState(false);
  const [sigExpanded, setSigExpanded] = useState(false);
  // Tick once a minute so the "next update in Xm" countdown advances without
  // a refetch -- minute-granularity display doesn't need a faster clock.
  const [, briefingForceTick] = useState(0);
  useEffect(()=>{
    const iv = setInterval(()=>briefingForceTick(t=>t+1), 60000);
    return ()=>clearInterval(iv);
  },[]);
  const [showMap, setShowMap] = useState(false);

  // -- Digital signature ------------------------------------------------------
  const [pilotDisplayName, setPilotDisplayName] = useState("");
  useEffect(()=>{
    if(!userId) return;
    sb.from("profiles").select("name").eq("id", userId).maybeSingle()
      .then(({data})=>{ if(data?.name) setPilotDisplayName(data.name); })
      .catch(()=>{});
  },[userId]);

  // Global default for how a newly-synced flight (no explicit PIC/SIC
  // override yet) should be classified -- set via the toggle in
  // LogbookHubPage's header. Fetched directly here the same way
  // pilotDisplayName is above, since this is genuinely per-user
  // preference data, not something specific to any one of the three
  // separate places that can open this page.
  const [picSicDefault, setPicSicDefault] = useState(null);
  useEffect(()=>{
    if(!userId) return;
    sb.from("profiles").select("pic_sic_default").eq("id", userId).maybeSingle()
      .then(({data})=>{ if(data?.pic_sic_default) setPicSicDefault(data.pic_sic_default); })
      .catch(()=>{});
  },[userId]);

  const [signature, setSignature] = useState(null); // { id, status, pilot_signed_at, counter_name, counter_signed_at, ... } | null
  const [sigLoading, setSigLoading] = useState(true);
  const sigCanvasRef = useRef(null);
  const [sigCanvasEmpty, setSigCanvasEmpty] = useState(true);
  const [savingSig, setSavingSig] = useState(false);
  const [showCounterForm, setShowCounterForm] = useState(false);
  const [counterName, setCounterName] = useState("");
  const [counterEmail, setCounterEmail] = useState("");
  const [sendingRequest, setSendingRequest] = useState(false);
  const [sigErr, setSigErr] = useState("");

  useEffect(()=>{
    if(!roster?.id) { setSigLoading(false); return; }
    setSigLoading(true);
    const flightKeyForSig = `${di}-${fi}`;
    sb.from("flight_signatures")
      .select("*")
      .eq("roster_id", roster.id)
      .eq("flight_key", flightKeyForSig)
      .maybeSingle()
      .then(({data})=>{ setSignature(data||null); setSigLoading(false); })
      .catch(()=>setSigLoading(false));
  },[roster?.id, di, fi]);

  function sigCanvasPos(e, canvas){
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX-rect.left) * (canvas.width/rect.width), y: (clientY-rect.top) * (canvas.height/rect.height) };
  }
  function startSigDraw(e){
    const canvas = sigCanvasRef.current; if(!canvas) return;
    e.preventDefault();
    const ctx = canvas.getContext("2d");
    const {x,y} = sigCanvasPos(e, canvas);
    ctx.beginPath(); ctx.moveTo(x,y);
    canvas._drawing = true;
  }
  function moveSigDraw(e){
    const canvas = sigCanvasRef.current; if(!canvas || !canvas._drawing) return;
    e.preventDefault();
    const ctx = canvas.getContext("2d");
    const {x,y} = sigCanvasPos(e, canvas);
    ctx.lineTo(x,y); ctx.strokeStyle="#0F172A"; ctx.lineWidth=2.5; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.stroke();
    setSigCanvasEmpty(false);
  }
  function endSigDraw(){ const c = sigCanvasRef.current; if(c) c._drawing = false; }
  function clearSigCanvas(){
    const canvas = sigCanvasRef.current; if(!canvas) return;
    canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);
    setSigCanvasEmpty(true);
  }

  async function savePilotSignature(){
    const canvas = sigCanvasRef.current;
    if(!canvas || sigCanvasEmpty) { setSigErr("Draw your signature first."); return; }
    setSavingSig(true); setSigErr("");
    try{
      const dataUrl = canvas.toDataURL("image/png");
      const flightKeyForSig = `${di}-${fi}`;
      const payload = {
        user_id: userId, roster_id: roster.id, flight_key: flightKeyForSig,
        pilot_signature_png: dataUrl,
        pilot_signed_at: new Date().toISOString(),
        pilot_signed_name: pilotDisplayName || "",
        status: "pilot_signed",
      };
      const { data, error } = await sb.from("flight_signatures")
        .upsert(payload, { onConflict: "user_id,roster_id,flight_key" })
        .select().single();
      if(error) throw new Error(error.message);
      setSignature(data);
      clearSigCanvas();
    }catch(e){ setSigErr(e.message||"Could not save signature."); }
    setSavingSig(false);
  }

  async function sendCounterRequest(){
    if(!counterName.trim()) { setSigErr("Enter the countersigner's name."); return; }
    if(!counterEmail.trim().includes("@")) { setSigErr("Enter a valid email address."); return; }
    setSendingRequest(true); setSigErr("");
    try{
      const res = await fetch(`${SUPA_URL}/functions/v1/send-signature-request`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`, "apikey":SUPA_ANON },
        body: JSON.stringify({
          rosterId: roster.id, flightKey: `${di}-${fi}`,
          flightNum: f?.flightNum, dep: f?.dep, arr: f?.arr, dateStr,
          pilotName: pilotDisplayName || "",
          counterName: counterName.trim(), counterEmail: counterEmail.trim(),
        }),
      });
      const d = await res.json();
      if(d.error) throw new Error(d.error);
      setSignature(prev=>({...(prev||{}), status:"counter_requested", counter_name:counterName.trim(), counter_email:counterEmail.trim(), request_sent_at:new Date().toISOString(), request_expires_at:d.expiresAt}));
      setShowCounterForm(false); setCounterName(""); setCounterEmail("");
    }catch(e){ setSigErr(e.message||"Could not send signature request."); }
    setSendingRequest(false);
  }
  const mNum = roster?.monthNum ?? roster?.month_num ?? 0;
  const dateStr = `${roster?.year}-${String(mNum+1).padStart(2,"0")}-${String(day?.day||1).padStart(2,"0")}`;
  const tk = `${roster?.id}-${di}-${fi}`;

  // dist2 starts from the synchronous fast-path (calcDist against the
  // small ~96-airport AIRPORT_COORDS dictionary, or whatever the caller
  // passed), then upgrades reactively via resolveAirportCoords -- the same
  // async geocoding-fallback resolver already proven correct in
  // FlightRouteMap for its "airport not found" problem (built after the
  // TVC incident). Without this, ANY flight touching an airport outside
  // that small dictionary (confirmed missing: SDF, GRB, likely others)
  // would show distance AND, because isXCFlight/xcMins both derive from
  // it, cross-country time as "--" permanently, regardless of sync state
  // -- this has nothing to do with syncing at all, it's a coordinate-
  // lookup gap that happens to affect both fields at once since they
  // share the same distance calculation.
  const [dist2Live, setDist2Live] = useState(dist || calcDist(f?.dep, f?.arr));
  const [distResolveAttempt, setDistResolveAttempt] = useState(0);
  useEffect(()=>{
    let cancelled=false;
    if(dist2Live || !f?.dep || !f?.arr) return; // already have it, or nothing to resolve
    (async()=>{
      const [c1,c2] = await Promise.all([resolveAirportCoords(f.dep), resolveAirportCoords(f.arr)]);
      if(cancelled) return;
      if(!c1 || !c2) {
        // Resolution genuinely failed this attempt (could be a transient
        // network issue, not necessarily "this airport doesn't exist") --
        // retry with backoff rather than give up silently forever, which
        // is what happened before: a single failed attempt left dist2Live
        // stuck at null permanently, since this effect's dependency array
        // only re-fires on dep/arr changing, never on a retry.
        if(distResolveAttempt < 3) {
          setTimeout(()=>{ if(!cancelled) setDistResolveAttempt(a=>a+1); }, 2000*(distResolveAttempt+1));
        }
        return;
      }
      const d = distanceNM(c1[0],c1[1],c2[0],c2[1]); // already rounds internally
      if(d!=null && !isNaN(d)) setDist2Live(d);
    })();
    return ()=>{ cancelled=true; };
  },[f?.dep, f?.arr, distResolveAttempt]);
  const dist2 = dist2Live;
  const blockMins2 = tail?.actualBlockMins != null ? tail.actualBlockMins : (blockMins || schedMins(f) || 0);
  // Night time and XC time are recomputed HERE, reactively, from whichever
  // departure/arrival clock times are actually current -- NOT passed in as
  // a static prop computed once when the flight was first opened. Every
  // caller that opens this page used to call computeSolarTimes(...) with
  // f.depTime/f.arrTime (the SCHEDULED times) unconditionally, so if a
  // pilot then synced or manually entered actual times, night/XC would
  // silently keep showing the scheduled-time values forever -- there was
  // nothing to re-trigger the calculation. Deriving these locally from
  // `tail` means they update the instant tail changes, exactly like
  // blockMins2 above already correctly does.
  // Both actual times must be present together, or neither is used. Mixing
  // a genuine actual departure with a stale SCHEDULED arrival (because the
  // flight hadn't landed yet when only the early +15min sync pass ran)
  // produces a fabricated time window that never actually happened -- a
  // badly delayed departure combined with the ORIGINAL scheduled arrival
  // can span many hours of pure fiction, and computeNightTime faithfully
  // computes real math over that fake window (this is exactly how a
  // partial sync -- out time captured, in time still airborne -- produced
  // 10 hours of "night time" that was really the gap between a real late
  // departure and a stale early-scheduled arrival). Falling back to the
  // FULLY scheduled pair when actual arrival isn't in yet gives an
  // internally consistent hypothetical instead of a mismatched fabrication
  // -- it may still be wrong once the flight actually lands, but it's
  // wrong in an honest, bounded way, not a fabricated multi-hour gap.
  const bothActualPresent = !!(tail?.actualDep && tail?.actualArr);
  const effDepTime = bothActualPresent ? tail.actualDep : f?.depTime;
  const effArrTime = bothActualPresent ? tail.actualArr : f?.arrTime;
  const solar2Sync = (f?.dep && f?.arr && effDepTime && effArrTime)
    ? computeSolarTimes(f.dep, f.arr, effDepTime, effArrTime, dateStr)
    : solar; // fall back to whatever the caller passed, if times aren't available at all
  // computeSolarTimes/computeNightTime read AIRPORT_COORDS directly (the
  // small ~96-entry dictionary) and have NO fallback of their own -- unlike
  // dist2Live above, which was already wired into the async
  // resolveAirportCoords resolver (local dictionary -> OurAirports dataset
  // -> geocoding). Any airport outside that small dictionary (confirmed:
  // CID, PIA, GRB, SGF, likely others) silently computes nightMins:0 every
  // time, indistinguishable from "genuinely no night time on this flight."
  // Rather than change computeNightTime's signature (14 call sites across
  // the file depend on its current shape), this resolves coordinates the
  // same way dist2Live does and, if the small dictionary was missing an
  // entry the resolver found, patches AIRPORT_COORDS with it -- letting
  // the existing, unmodified solar-math function pick it up naturally on
  // a recompute, without changing its contract for any other caller.
  const [nightMinsLive, setNightMinsLive] = useState(null); // null = not yet attempted an upgrade
  const [nightResolveAttempt, setNightResolveAttempt] = useState(0);
  useEffect(()=>{
    let cancelled=false;
    const alreadyHaveBoth = !!(AIRPORT_COORDS[f?.dep] && AIRPORT_COORDS[f?.arr]);
    if(alreadyHaveBoth || nightMinsLive!=null || !f?.dep || !f?.arr || !effDepTime || !effArrTime) return;
    (async()=>{
      const [c1,c2] = await Promise.all([resolveAirportCoords(f.dep), resolveAirportCoords(f.arr)]);
      if(cancelled) return;
      if(!c1 || !c2) {
        if(nightResolveAttempt < 3) {
          setTimeout(()=>{ if(!cancelled) setNightResolveAttempt(a=>a+1); }, 2000*(nightResolveAttempt+1));
        }
        return;
      }
      // Patch the small dictionary with the resolved entries so the
      // existing computeSolarTimes/computeNightTime chain (unchanged, same
      // as every other caller relies on) finds real coordinates instead of
      // nothing. This is additive only -- never overwrites an existing
      // entry, only fills in what was genuinely missing.
      if(!AIRPORT_COORDS[f.dep]) AIRPORT_COORDS[f.dep] = c1;
      if(!AIRPORT_COORDS[f.arr]) AIRPORT_COORDS[f.arr] = c2;
      const recomputed = computeSolarTimes(f.dep, f.arr, effDepTime, effArrTime, dateStr);
      setNightMinsLive(recomputed?.nightMins ?? 0);
    })();
    return ()=>{ cancelled=true; };
  },[f?.dep, f?.arr, effDepTime, effArrTime, nightResolveAttempt]);
  const solar2 = nightMinsLive!=null ? {...solar2Sync, nightMins:nightMinsLive} : solar2Sync;
  const nightMins = solar2?.nightMins || 0;
  // XC time is a DURATION (the full block time counted as cross-country),
  // matching computeAnalytics' own xcMins convention -- not the "Yes/No"
  // qualification flag alone, which can never reflect a time change.
  const isXCFlight = (dist2||0) > 50;
  const xcMins = isXCFlight ? blockMins2 : 0;
  const isSynced = !!(tail?.tail);
  // hasActual (the PROP) is a one-time snapshot computed by whichever of
  // the eight call sites opened this page -- baked in at that instant and
  // never updated again, even after tail changes once sync data arrives.
  // That's the actual bug behind "distance/XC/times revert to scheduled
  // display after syncing": lines 6387/6403 below read hasActual to decide
  // whether to show actual vs scheduled dep/arr times, and a pilot who
  // opened the flight BEFORE it synced would keep seeing scheduled times
  // forever in that view, since the stale prop never flips to true.
  // Recomputing reactively from the current `tail` object (same pattern
  // isSynced above already correctly uses) fixes this the same way the
  // night/XC time fix did for those two fields earlier.
  const hasActualLive = !!(tail?.actualDep || tail?.actualArr || tail?.tail);
  const isCancelled = !!(tail?.cancelled);

  const BLUE = S.blue; const GREEN = S.green;

  // -- Flight Details: same fields as the Add Flight form (Pilot Function,
  // time breakdown, landings & approaches, remarks) so any flight -- including
  // ones parsed straight from an uploaded roster -- can have this information
  // filled in after the fact, directly from its own detail page.
  const [editingDetails, setEditingDetails] = useState(true);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsForm, setDetailsForm] = useState(()=>({
    // Pilot Function starts UNSET (neither PIC nor SIC highlighted) unless
    // this flight already carries an explicit override from a previous edit.
    // Leaving it unset means saving other fields (e.g. just a remark) will
    // never silently overwrite whatever a pilot's date-based Time Rule
    // already classifies this flight as.
    isPIC: f?.loggedPicMins!=null && f.loggedPicMins>0,
    isSIC: f?.loggedSicMins!=null && f.loggedSicMins>0,
    // Default to the reactively-computed night/XC time (same values the
    // top-of-page tile shows) when nothing has been explicitly saved here
    // yet -- previously this only ever read f.loggedNightMins/loggedXcMins,
    // which stays undefined until a pilot manually opens this exact form
    // and hits Save, so the two sections silently disagreed: the tile
    // showed a real, correct, auto-computed value while this form showed
    // nothing at all. A pilot can still override either field manually;
    // this only changes what it starts pre-filled with.
    nightTime:   f?.loggedNightMins!=null     ? fmtMins(f.loggedNightMins)     : (nightMins>0 ? fmtMins(nightMins) : ""),
    xcTime:      f?.loggedXcMins!=null        ? fmtMins(f.loggedXcMins)        : (xcMins>0    ? fmtMins(xcMins)    : ""),
    multiEngTime: f?.loggedMultiEngMins!=null ? fmtMins(f.loggedMultiEngMins)  : "",
    acType:      f?.acType || "",
    actualIfr:   f?.loggedActualIfrMins!=null ? fmtMins(f.loggedActualIfrMins) : "",
    simIfr:      f?.loggedSimIfrMins!=null    ? fmtMins(f.loggedSimIfrMins)    : "",
    dayLdg:      f?.loggedDayLandings ?? 0,
    nightLdg:    f?.loggedNightLandings ?? 0,
    approaches:  f?.loggedApproaches ?? 0,
    approachTypes: f?.approachTypes || [],
    remarks:     f?.remarks || "",
  }));

  // Apply the pilot's global PIC/SIC default once it's fetched, but ONLY if
  // this flight genuinely has no explicit override already -- checked
  // against f's own saved data, not detailsForm's current state, so this
  // can never clobber a pilot's own manual toggle mid-edit (which would
  // happen if this raced against detailsForm and read its own just-changed
  // value back). Applying via an effect rather than the synchronous
  // initializer above is necessary because picSicDefault is fetched
  // asynchronously and is reliably still null at the exact moment
  // detailsForm's lazy initializer runs.
  useEffect(()=>{
    if(!picSicDefault) return;
    const alreadyExplicit = (f?.loggedPicMins!=null && f.loggedPicMins>0) || (f?.loggedSicMins!=null && f.loggedSicMins>0);
    if(alreadyExplicit) return;
    setDetailsForm(p=>{
      if(p.isPIC || p.isSIC) return p; // pilot already toggled it manually this session -- don't override
      return {...p, isPIC:picSicDefault==="PIC", isSIC:picSicDefault==="SIC"};
    });
  },[picSicDefault]);

  async function fetchBriefing() {
    if(briefingLoading) return;
    if(!briefingEligible(f?.dep, dateStr, f?.depTime)) {
      setBriefing("AI briefing is only available for flights departing within 24 hours.");
      setBriefingExpiresAt(null);
      return;
    }
    setBriefingLoading(true);
    try {
      const briefKey = `fl_brief_${f?.flightNum}_${dateStr}`;
      const cached = localStorage.getItem(briefKey);
      if(cached) { const p = JSON.parse(cached); if(Date.now()-p.ts < 3600000) { setBriefing(p.text); setBriefingExpiresAt(p.ts+3600000); setBriefingLoading(false); return; } }
      const briefRes = await fetch(`${SUPA_URL}/functions/v1/flight-briefing`,{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},
        body:JSON.stringify({flightNum:f?.flightNum,dep:f?.dep,arr:f?.arr,date:dateStr,depTime:f?.depTime,acType:f?.acType}),
      });
      const bd = await briefRes.json();
      const text = bd.briefing||bd.text||bd.content?.[0]?.text||"Briefing unavailable.";
      setBriefing(text);
      try { const ts=Date.now(); localStorage.setItem(briefKey, JSON.stringify({text, ts})); setBriefingExpiresAt(ts+3600000); } catch {}
    } catch { setBriefing("Briefing unavailable -- check connection."); }
    setBriefingLoading(false);
  }

  function formatTime(t) { return t || "--"; }

  return (
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>

      {/* HERO MAP -- full-bleed at the top of the page. Back/delete controls
          float on top of it (frosted circles, not a solid header bar), and
          the flight-info card below is pulled up to overlap its bottom
          edge, so the map reads as sitting "behind" the page the way a
          cover photo does -- scrolling down moves past it into the rest of
          the page underneath. */}
      <div style={{position:"relative",width:"100%",height:260,background:"#0B1120",overflow:"hidden",flexShrink:0,zIndex:1}}>
        {dep&&arr
          ? <FlightRouteMap dep={dep} arr={arr} dist={dist2} flightDateStr={dateStr} flightDepTime={f?.depTime} S={S} hero/>
          : <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:"rgba(255,255,255,0.5)",fontSize:13}}>Route map unavailable</div>
        }
        <div style={{position:"absolute",top:0,left:0,right:0,padding:"14px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",zIndex:1150,pointerEvents:"none"}}>
          <button onClick={onBack} style={{pointerEvents:"auto",width:36,height:36,borderRadius:"50%",background:"rgba(15,23,42,0.55)",backdropFilter:"blur(8px)",border:"1px solid rgba(255,255,255,0.18)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          {onDeleteFlight&&(
            <button onClick={()=>setConfirmingDelete(true)} title="Delete flight" style={{pointerEvents:"auto",width:36,height:36,borderRadius:"50%",background:"rgba(15,23,42,0.55)",backdropFilter:"blur(8px)",border:"1px solid rgba(255,255,255,0.18)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" stroke="#F87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
        </div>
      </div>

      {confirmingDelete&&(
        <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(15,23,42,0.5)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>!deletingFlight&&setConfirmingDelete(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:S.surface,borderRadius:18,padding:22,maxWidth:340,width:"100%"}}>
            <div style={{fontSize:16,fontWeight:800,color:S.ink,marginBottom:6}}>Delete this flight?</div>
            <div style={{fontSize:13,color:S.muted,marginBottom:18,lineHeight:1.5}}>
              {f?.flightNum} · {f?.dep}→{f?.arr} will be permanently removed from this roster. This can't be undone.
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmingDelete(false)} disabled={deletingFlight} style={{flex:1,padding:"11px",borderRadius:12,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:13,fontWeight:700,cursor:deletingFlight?"not-allowed":"pointer"}}>Cancel</button>
              <button
                onClick={async()=>{
                  setDeletingFlight(true);
                  try{ await onDeleteFlight(); }
                  catch(e){ alert(e.message||"Could not delete flight."); setDeletingFlight(false); setConfirmingDelete(false); }
                }}
                disabled={deletingFlight}
                style={{flex:1,padding:"11px",borderRadius:12,background:"#DC2626",border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:deletingFlight?"not-allowed":"pointer",opacity:deletingFlight?0.7:1}}
              >
                {deletingFlight?"Deleting...":"Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{position:"relative",zIndex:2,padding:"0 16px 32px",maxWidth:600,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

        {/* Overlap card -- pulled up over the hero map's bottom edge via a
            negative top margin, so it reads as a sheet floating on the map
            rather than a plain card that happens to be first in the list. */}
        <div style={{position:"relative",zIndex:2,marginTop:-32,background:`linear-gradient(135deg,${BLUE},#1E3A8A)`,borderRadius:20,padding:"18px 20px",boxShadow:"0 14px 32px rgba(0,0,0,0.35)",overflow:"hidden"}}>
          <div style={{position:"absolute",top:-20,right:-20,width:100,height:100,borderRadius:"50%",background:"rgba(255,255,255,0.06)"}}/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",zIndex:1,marginBottom:14}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:17,fontWeight:800,color:"#fff",letterSpacing:"-.3px"}}>{f?.flightNum}</div>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.65)",marginTop:1}}>{dateStr}</div>
            </div>
            <div style={{display:"flex",gap:6,flexShrink:0}}>
              {isCancelled&&<span style={{background:"#EF4444",color:"#fff",fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:100,letterSpacing:".5px",whiteSpace:"nowrap"}}>CANCELLED</span>}
              {isSynced&&!isCancelled&&(
                <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(255,255,255,0.16)",color:"#fff",fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:100,whiteSpace:"nowrap"}} title={tail?.updatedAt?`Synced ${fmtSyncTime(tail.updatedAt)}`:undefined}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Synced
                </span>
              )}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",zIndex:1}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:34,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:"-1px"}}>{f?.dep}</div>
              <div style={{fontSize:15,fontWeight:800,color:"#fff",marginTop:6}}>{formatTime(hasActualLive?tail?.actualDep:f?.depTime)}</div>
              {hasActualLive&&f?.depTime&&<div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>Sched {f.depTime}</div>}
            </div>
            <div style={{flex:1,padding:"0 14px",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <div style={{fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.55)"}}>{blockMins2?fmtMins(blockMins2):"--"}</div>
              <div style={{width:"100%",display:"flex",alignItems:"center",gap:4}}>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.2)"}}/>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="rgba(255,255,255,0.9)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.2)"}}/>
              </div>
              {dist2&&<div style={{fontSize:10,color:"rgba(255,255,255,0.45)"}}>{dist2} NM</div>}
              {f?.acType&&<div style={{fontSize:10,color:"rgba(255,255,255,0.55)",fontWeight:600}}>{f.acType}</div>}
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:34,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:"-1px"}}>{f?.arr}</div>
              <div style={{fontSize:15,fontWeight:800,color:"#fff",marginTop:6}}>{formatTime(hasActualLive?tail?.actualArr:f?.arrTime)}</div>
              {hasActualLive&&f?.arrTime&&<div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>Sched {f.arrTime}</div>}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {[
            {label:"Block Time",val:blockMins2?fmtMins(blockMins2):"--",icon:"🕐"},
            {label:"Distance",val:dist2?`${dist2} NM`:"--",icon:"✈"},
            {label:"Night Time",val:nightMins?fmtMins(nightMins):"--",icon:"🌙"},
            {label:"XC Time",val:xcMins?fmtMins(xcMins):"--",icon:"🗺️"},
          ].map(({label,val,icon})=>(
            <div key={label} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:14,padding:"12px 10px",textAlign:"center"}}>
              <div style={{fontSize:18,marginBottom:4}}>{icon}</div>
              <div style={{fontSize:13,fontWeight:800,color:S.ink}}>{val}</div>
              <div style={{fontSize:9,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginTop:2}}>{label}</div>
            </div>
          ))}
        </div>

        {/* Tail Number + Times -- merged into one box, per request: tail
            number sits above the times grid inside the same card rather
            than as its own separate box. */}
        <div style={{background:S.surface,border:`1px solid ${hasActualLive?`${GREEN}44`:S.border}`,borderRadius:18,padding:"16px 18px"}}>
          <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:12}}>Tail Number</div>
          {isSynced?(
            <div style={{marginBottom:18}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                <div style={{fontSize:22,fontWeight:900,color:S.ink,fontFamily:"monospace"}}>{tail.tail}</div>
                <span style={{fontSize:11,color:GREEN,fontWeight:700,background:C.greenBg,padding:"3px 10px",borderRadius:100}} title={tail?.updatedAt?fmtSyncTime(tail.updatedAt):undefined}>✓ {tail?.updatedAt?`Synced ${fmtSyncTime(tail.updatedAt)}`:"Auto-Synced"}</span>
              </div>
              <button onClick={onAutoLookup} disabled={lkStatus==="loading"} style={{width:"100%",padding:"9px",borderRadius:10,background:S.panel,border:`1px solid ${S.border}`,color:S.muted,fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {lkStatus==="loading"?<><svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{animation:"spin 1s linear infinite"}}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" stroke={S.muted} strokeWidth="2.5" strokeLinecap="round"/></svg>Re-syncing...</>:<><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>Manual Re-sync (testing)</>}
              </button>
              {lkStatus==="done"&&<div style={{fontSize:11,color:GREEN,textAlign:"center",marginTop:6}}>✓ Re-synced from FlightAware</div>}
            </div>
          ):(
            <div style={{marginBottom:18}}>
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                <input
                  type="text" placeholder="Enter tail number (N#####)"
                  value={tmp||""}
                  onChange={e=>onTmpChange&&onTmpChange(e.target.value.toUpperCase().slice(0,8))}
                  style={{flex:1,padding:"10px 12px",borderRadius:10,border:`1px solid ${S.border}`,fontSize:14,background:S.surface,color:S.ink,outline:"none",fontFamily:"monospace"}}
                />
                <button onClick={()=>onSaveTail&&onSaveTail(tmp)} disabled={!tmp||saving} style={{padding:"10px 16px",borderRadius:10,background:BLUE,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:(!tmp||saving)?"not-allowed":"pointer",opacity:(!tmp||saving)?0.6:1}}>
                  {saving?"⟳":"Save"}
                </button>
              </div>
              <button onClick={onAutoLookup} disabled={lkStatus==="loading"} style={{width:"100%",padding:"10px",borderRadius:10,background:S.panel,border:`1px solid ${S.border}`,color:S.ink,fontSize:13,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {lkStatus==="loading"
                  ?<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{animation:"spin 1s linear infinite"}}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" stroke={S.muted} strokeWidth="2.5" strokeLinecap="round"/></svg>Looking up...</>
                  :<><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>Auto-lookup from FlightAware</>
                }
              </button>
              {lkStatus==="notfound"&&<div style={{fontSize:12,color:S.muted,textAlign:"center",marginTop:8}}>Not found yet -- flight may not have landed</div>}
              {lkStatus==="error"&&<div style={{fontSize:12,color:C.red,textAlign:"center",marginTop:8}}>{lkError||"Lookup failed"}</div>}
              {lkStatus==="done"&&<div style={{fontSize:12,color:GREEN,textAlign:"center",marginTop:8}}>✓ Synced from FlightAware</div>}
            </div>
          )}

          <div style={{height:1,background:S.border,margin:"0 0 16px"}}/>

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:12,fontWeight:700,color:hasActualLive?GREEN:S.muted,textTransform:"uppercase",letterSpacing:".5px"}}>
                {hasActualLive?"Actual Times":"Scheduled Times"}
              </div>
              {hasActualLive&&(
                <span style={{fontSize:10,fontWeight:700,color:GREEN,background:C.greenBg,padding:"2px 8px",borderRadius:100}}>
                  ✓ Synced
                </span>
              )}
            </div>
            {!editingTimes&&(
              <button onClick={()=>setEditingTimes&&setEditingTimes(true)} style={{fontSize:12,fontWeight:600,color:BLUE,background:"none",border:"none",cursor:"pointer"}}>Edit</button>
            )}
          </div>
          {editingTimes?(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
                {[["Actual Dep","actualDep",tail?.actualDep||f?.depTime||""],["Actual Arr","actualArr",tail?.actualArr||f?.arrTime||""],["Block Mins","actualBlockMins",tail?.actualBlockMins||blockMins2||""]].map(([label,field,defaultVal])=>(
                  <div key={field} style={{gridColumn:field==="actualBlockMins"?"span 2":"auto"}}>
                    <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>{label}</div>
                    <input
                      type={field==="actualBlockMins"?"number":"time"}
                      defaultValue={defaultVal}
                      onChange={e=>setTimeEdits&&setTimeEdits(p=>({...p,[field]:e.target.value}))}
                      style={{width:"100%",padding:"9px 12px",borderRadius:10,border:`1px solid ${S.border}`,fontSize:14,background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box"}}
                    />
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={async()=>{
                  if(timeEdits&&Object.keys(timeEdits).length){
                    const updates={...tail,...timeEdits};
                    await onTailSaved&&onTailSaved(updates);
                  }
                  setEditingTimes&&setEditingTimes(false);
                }} style={{flex:1,padding:"10px",borderRadius:10,background:BLUE,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
                <button onClick={()=>{setEditingTimes&&setEditingTimes(false);setTimeEdits&&setTimeEdits({});}} style={{flex:1,padding:"10px",borderRadius:10,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:13,cursor:"pointer"}}>Cancel</button>
              </div>
            </div>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              {[
                ["Out", hasActualLive?(tail?.actualDep||"--"):(f?.depTime||"--")],
                ["In",  hasActualLive?(tail?.actualArr||"--"):(f?.arrTime||"--")],
                ["Block", blockMins2?fmtMins(blockMins2):"--"],
              ].map(([label,val])=>(
                <div key={label} style={{textAlign:"center",background:S.panel,borderRadius:12,padding:"12px 8px"}}>
                  <div style={{fontSize:20,fontWeight:900,color:S.ink,fontFamily:"monospace",letterSpacing:"-0.5px"}}>{val}</div>
                  <div style={{fontSize:10,color:hasActualLive?GREEN:S.muted,marginTop:4,textTransform:"uppercase",letterSpacing:".5px",fontWeight:600}}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Flight Details -- Pilot Function, time breakdown, landings &
            approaches, remarks. Same fields as Add Flight, added here so
            a pilot can fill this in on any existing flight after the fact. */}
        <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:"16px 18px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px"}}>Flight Details</div>
            {!editingDetails&&<button onClick={()=>setEditingDetails(true)} style={{fontSize:12,fontWeight:600,color:BLUE,background:"none",border:"none",cursor:"pointer"}}>Edit</button>}
          </div>

          {!editingDetails?(()=>{
            const chips=[];
            if(detailsForm.acType) chips.push(detailsForm.acType);
            if(detailsForm.isPIC) chips.push("PIC");
            if(detailsForm.isSIC) chips.push("SIC");
            if(parseHM(detailsForm.nightTime)>0) chips.push(`Night ${detailsForm.nightTime}`);
            if(parseHM(detailsForm.xcTime)>0) chips.push(`XC ${detailsForm.xcTime}`);
            if(parseHM(detailsForm.multiEngTime)>0) chips.push(`Multi-Eng ${detailsForm.multiEngTime}`);
            if(parseHM(detailsForm.actualIfr)>0) chips.push(`Actual IMC ${detailsForm.actualIfr}`);
            if(parseHM(detailsForm.simIfr)>0) chips.push(`Hood/Sim ${detailsForm.simIfr}`);
            if(detailsForm.dayLdg>0||detailsForm.nightLdg>0) chips.push(`${detailsForm.dayLdg} day / ${detailsForm.nightLdg} night ldg`);
            if(detailsForm.approaches>0) chips.push(`${detailsForm.approaches} approach${detailsForm.approaches>1?"es":""}`);
            return(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {chips.length>0?(
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {chips.map(c=>(
                      <span key={c} style={{fontSize:11,fontWeight:600,color:S.silver,background:S.panel,padding:"4px 10px",borderRadius:100}}>{c}</span>
                    ))}
                  </div>
                ):(
                  <div style={{fontSize:12,color:S.muted}}>Nothing logged yet -- tap Edit to add Pilot Function, night/XC/IFR time, landings, approaches, or remarks.</div>
                )}
                {detailsForm.remarks&&<div style={{fontSize:13,color:S.silver,lineHeight:1.5,fontStyle:"italic"}}>"{detailsForm.remarks}"</div>}
              </div>
            );
          })():(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {/* Pilot Function */}
              <div>
                <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Pilot Function</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[["PIC","isPIC"],["SIC","isSIC"]].map(([lbl,k])=>(
                    <button key={k} onClick={()=>setDetailsForm(p=>({...p,isPIC:k==="isPIC",isSIC:k==="isSIC"}))} style={{padding:"10px",borderRadius:10,border:`1.5px solid ${detailsForm[k]?BLUE:S.border}`,background:detailsForm[k]?C.blueBg:S.surface,color:detailsForm[k]?BLUE:S.muted,fontSize:13,fontWeight:700,cursor:"pointer"}}>{lbl}</button>
                  ))}
                </div>
                <div style={{fontSize:10,color:S.muted,marginTop:5}}>Leave unset to keep using your Time Rules classification for this date.</div>
              </div>

              {/* Aircraft Type -- editable here so a pilot can correct or
                  fill this in after the fact, same as every other field in
                  this section; f.acType is set at parse/creation time and
                  wasn't previously editable at all once a flight existed. */}
              <div>
                <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Aircraft Type</div>
                <input type="text" placeholder="e.g. A320, CRJ7, B738" value={detailsForm.acType} onChange={e=>setDetailsForm(p=>({...p,acType:e.target.value.toUpperCase()}))} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box"}}/>
              </div>

              {/* Time breakdown */}
              <div>
                <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Time Breakdown (h:mm)</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[["Night","nightTime"],["Cross Country","xcTime"],["Actual IMC","actualIfr"],["Hood / Sim","simIfr"],["Multi-Eng","multiEngTime"]].map(([lbl,k])=>(
                    <div key={k}>
                      <div style={{fontSize:10,color:S.muted,marginBottom:3}}>{lbl}</div>
                      <input type="text" placeholder="0:00" value={detailsForm[k]} onChange={e=>setDetailsForm(p=>({...p,[k]:e.target.value}))} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box"}}/>
                    </div>
                  ))}
                </div>
              </div>

              {/* Landings & Approaches */}
              <div>
                <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Landings & Approaches</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[["Day Ldg","dayLdg"],["Night Ldg","nightLdg"],["Approaches","approaches"]].map(([lbl,k])=>(
                    <div key={k}>
                      <div style={{fontSize:10,color:S.muted,marginBottom:3}}>{lbl}</div>
                      <input type="text" inputMode="numeric" placeholder="0"
                        value={detailsForm[k]===0?"":String(detailsForm[k])}
                        onChange={e=>{
                          const raw=e.target.value.replace(/[^0-9]/g,"");
                          const n=raw===""?0:Math.min(99,parseInt(raw));
                          setDetailsForm(p=>{
                            const next={...p,[k]:n};
                            if(k==="approaches"){
                              const types=[...(p.approachTypes||[])];
                              types.length=n; for(let i=0;i<n;i++) if(!types[i]) types[i]="ILS";
                              next.approachTypes=types;
                            }
                            return next;
                          });
                        }}
                        style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,textAlign:"center",background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box"}}/>
                    </div>
                  ))}
                </div>
                {detailsForm.approaches>0&&(
                  <div style={{marginTop:10,display:"grid",gridTemplateColumns:detailsForm.approaches>1?"1fr 1fr":"1fr",gap:8}}>
                    {Array.from({length:detailsForm.approaches},(_,i)=>(
                      <div key={i}>
                        <div style={{fontSize:10,color:S.muted,marginBottom:3}}>Approach {i+1}</div>
                        <select value={detailsForm.approachTypes?.[i]||"ILS"} onChange={e=>{
                          const types=[...(detailsForm.approachTypes||[])]; types[i]=e.target.value;
                          setDetailsForm(p=>({...p,approachTypes:types}));
                        }} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",cursor:"pointer"}}>
                          {["ILS","RNAV (GPS)","VOR","LOC","LOC-BC","RNP","NDB","VISUAL","CIRCLING","PAR"].map(t=><option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Remarks */}
              <div>
                <div style={{fontSize:10,color:S.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:6}}>Remarks / Notes</div>
                <textarea rows={3} placeholder="IOE, checkride, special ops..." value={detailsForm.remarks} onChange={e=>setDetailsForm(p=>({...p,remarks:e.target.value}))} style={{width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",resize:"vertical",minHeight:64,lineHeight:1.5,boxSizing:"border-box",fontFamily:"inherit"}}/>
              </div>

              <div style={{display:"flex",gap:8}}>
                <button onClick={async()=>{
                  setSavingDetails(true);
                  try{
                    const blockForPicSic = blockMins2 || 0;
                    const hasLdg = detailsForm.dayLdg>0 || detailsForm.nightLdg>0;
                    const fields = {
                      ...((detailsForm.isPIC||detailsForm.isSIC)?{
                        loggedPicMins: detailsForm.isPIC ? blockForPicSic : 0,
                        loggedSicMins: detailsForm.isSIC ? blockForPicSic : 0,
                      }:{}),
                      acType:              detailsForm.acType || undefined,
                      loggedNightMins:     detailsForm.nightTime ? parseHM(detailsForm.nightTime) : undefined,
                      loggedXcMins:        detailsForm.xcTime    ? parseHM(detailsForm.xcTime)    : undefined,
                      loggedMultiEngMins:  detailsForm.multiEngTime ? parseHM(detailsForm.multiEngTime) : undefined,
                      loggedActualIfrMins: detailsForm.actualIfr ? parseHM(detailsForm.actualIfr) : undefined,
                      loggedSimIfrMins:    detailsForm.simIfr    ? parseHM(detailsForm.simIfr)    : undefined,
                      loggedDayLandings:   hasLdg ? (detailsForm.dayLdg||0)   : undefined,
                      loggedNightLandings: hasLdg ? (detailsForm.nightLdg||0) : undefined,
                      loggedLandings:      hasLdg ? ((detailsForm.dayLdg||0)+(detailsForm.nightLdg||0)) : undefined,
                      loggedApproaches:    detailsForm.approaches>0 ? detailsForm.approaches : undefined,
                      approachTypes:       detailsForm.approaches>0 ? (detailsForm.approachTypes||[]).slice(0,detailsForm.approaches) : undefined,
                      remarks:             detailsForm.remarks || undefined,
                    };
                    await onSaveFlightFields && onSaveFlightFields(fields);
                    setEditingDetails(false);
                  }catch(e){ alert(e.message||"Failed to save flight details."); }
                  setSavingDetails(false);
                }} disabled={savingDetails} style={{flex:1,padding:"10px",borderRadius:10,background:BLUE,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:savingDetails?"not-allowed":"pointer",opacity:savingDetails?0.7:1}}>
                  {savingDetails?"⟳ Saving...":"Save Details"}
                </button>
                <button onClick={()=>setEditingDetails(false)} style={{flex:1,padding:"10px",borderRadius:10,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:13,cursor:"pointer"}}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* Digital signature card -- moved here to sit directly under
            Flight Details. Collapsed by default; header alone shows enough
            status (fully signed / awaiting / not yet signed) that a pilot
            doesn't need to expand it just to check state. */}
        <div style={{background:S.surface,border:`1px solid ${signature?.status==="fully_signed"?`${GREEN}44`:S.border}`,borderRadius:18,overflow:"hidden"}}>
          <button
            onClick={()=>setSigExpanded(v=>!v)}
            style={{width:"100%",padding:"16px 18px",background:"none",border:"none",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",textAlign:"left"}}
          >
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px"}}>Digital Signature</div>
              {signature?.status==="fully_signed"?(
                <span style={{fontSize:10,fontWeight:700,color:GREEN,background:C.greenBg,padding:"2px 8px",borderRadius:100}}>✓ Fully Signed</span>
              ):signature?.pilot_signed_at?(
                <span style={{fontSize:10,fontWeight:700,color:S.muted,background:S.panel,padding:"2px 8px",borderRadius:100}}>Pilot signed</span>
              ):null}
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{transform:sigExpanded?"rotate(180deg)":"none",transition:"transform .15s",flexShrink:0}}><path d="M6 9l6 6 6-6" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>

          {sigExpanded&&(
          <div style={{padding:"0 18px 18px"}}>
          {sigLoading?(
            <div style={{fontSize:12,color:S.muted,textAlign:"center",padding:"12px 0"}}>Loading...</div>
          ):(
            <>
              {/* Pilot's own signature status/action */}
              {signature?.pilot_signed_at?(
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,padding:"10px 12px",background:C.greenBg,borderRadius:10}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M20 6L9 17l-5-5" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <div style={{fontSize:12,color:GREEN,fontWeight:600}}>
                    Signed by {signature.pilot_signed_name||"you"} · {fmtSyncTime(signature.pilot_signed_at)}
                  </div>
                </div>
              ):(
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,color:S.muted,marginBottom:8}}>Draw your signature below</div>
                  <canvas
                    ref={sigCanvasRef} width={500} height={140}
                    style={{width:"100%",height:120,borderRadius:10,border:`1.5px dashed ${S.border}`,background:S.panel,touchAction:"none",cursor:"crosshair"}}
                    onMouseDown={startSigDraw} onMouseMove={moveSigDraw} onMouseUp={endSigDraw} onMouseLeave={endSigDraw}
                    onTouchStart={startSigDraw} onTouchMove={moveSigDraw} onTouchEnd={endSigDraw}
                  />
                  <div style={{display:"flex",gap:8,marginTop:8}}>
                    <button onClick={clearSigCanvas} style={{flex:1,padding:"9px",borderRadius:10,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:12,fontWeight:600,cursor:"pointer"}}>Clear</button>
                    <button onClick={savePilotSignature} disabled={savingSig||sigCanvasEmpty} style={{flex:2,padding:"9px",borderRadius:10,background:BLUE,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:(savingSig||sigCanvasEmpty)?"not-allowed":"pointer",opacity:(savingSig||sigCanvasEmpty)?0.6:1}}>
                      {savingSig?"Saving...":"Save Signature"}
                    </button>
                  </div>
                </div>
              )}

              {/* Counter-signature status/action -- only relevant once the
                  pilot has signed; requesting a second signature on an
                  unsigned flight is a valid order to allow too, so this
                  isn't gated behind pilot_signed_at. */}
              {signature?.counter_signed_at?(
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:C.greenBg,borderRadius:10}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M20 6L9 17l-5-5" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <div style={{fontSize:12,color:GREEN,fontWeight:600}}>
                    Countersigned by {signature.counter_name} · {fmtSyncTime(signature.counter_signed_at)}
                  </div>
                </div>
              ):signature?.status==="counter_requested"?(
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:S.panel,borderRadius:10}}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><circle cx="12" cy="12" r="9" stroke={S.muted} strokeWidth="2"/><path d="M12 7v5l3 3" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
                  <div style={{fontSize:12,color:S.muted,fontWeight:600}}>
                    Awaiting signature from {signature.counter_name} ({signature.counter_email})
                  </div>
                </div>
              ):showCounterForm?(
                <div style={{padding:"12px",background:S.panel,borderRadius:10}}>
                  <div style={{fontSize:11,color:S.muted,marginBottom:8}}>Request a signature from someone without an account</div>
                  <input type="text" placeholder="Their name" value={counterName} onChange={e=>setCounterName(e.target.value)}
                    style={{width:"100%",padding:"9px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",marginBottom:6,boxSizing:"border-box"}}/>
                  <input type="email" placeholder="Their email" value={counterEmail} onChange={e=>setCounterEmail(e.target.value)}
                    style={{width:"100%",padding:"9px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",marginBottom:8,boxSizing:"border-box"}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{setShowCounterForm(false);setSigErr("");}} style={{flex:1,padding:"9px",borderRadius:8,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:12,fontWeight:600,cursor:"pointer"}}>Cancel</button>
                    <button onClick={sendCounterRequest} disabled={sendingRequest} style={{flex:2,padding:"9px",borderRadius:8,background:BLUE,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:sendingRequest?"not-allowed":"pointer",opacity:sendingRequest?0.6:1}}>
                      {sendingRequest?"Sending...":"Send Request"}
                    </button>
                  </div>
                </div>
              ):(
                <button onClick={()=>{setShowCounterForm(true);setSigErr("");}} style={{width:"100%",padding:"10px",borderRadius:10,background:"none",border:`1px solid ${S.border}`,color:S.ink,fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke={S.ink} strokeWidth="1.7" strokeLinejoin="round"/></svg>
                  Request Countersignature
                </button>
              )}

              {sigErr&&<div style={{fontSize:11,color:C.red,textAlign:"center",marginTop:8}}>{sigErr}</div>}
            </>
          )}
          </div>
          )}
        </div>

        {/* AI Briefing */}
        <div style={{background:`linear-gradient(135deg,#3B82F6,${BLUE})`,borderRadius:18,padding:"16px 18px",color:"#fff"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{background:"rgba(255,255,255,0.2)",padding:7,borderRadius:9,backdropFilter:"blur(8px)"}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <div>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",color:"rgba(255,255,255,0.75)"}}>AI Briefing</div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>{briefing?(fmtBriefingCountdown(briefingExpiresAt)||"Tap Refresh for latest"):"Tap to generate"}</div>
              </div>
            </div>
          </div>
          {briefing?(
            <div style={{background:"rgba(255,255,255,0.12)",borderRadius:12,padding:"12px 14px",fontSize:12,lineHeight:1.7,color:"rgba(255,255,255,0.9)",marginBottom:10,maxHeight:160,overflowY:"auto"}}>
              {briefing}
            </div>
          ):(
            <div style={{background:"rgba(255,255,255,0.1)",borderRadius:12,padding:"12px 14px",fontSize:12,color:"rgba(255,255,255,0.55)",marginBottom:10}}>
              Get weather, NOTAMs, and route info for this flight.
            </div>
          )}
          <button onClick={fetchBriefing} disabled={briefingLoading} style={{width:"100%",padding:"10px",borderRadius:12,background:"#fff",border:"none",color:"#1D4ED8",fontSize:13,fontWeight:700,cursor:briefingLoading?"not-allowed":"pointer"}}>
            {briefingLoading?"⟳ Loading...":(briefing?"↻ Refresh":"Get Briefing")}
          </button>
        </div>

      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function CalendarPage({user, rosters, tails, onRosterUpdated, onOpenFlight, setPage}) {
  const [selRosterIdx, setSelRosterIdx] = useState(0);
  const [selDay, setSelDay]   = useState(null);
  const S = getS();
  const BLUE = S.blue; const GREEN = S.green;

  const roster = rosters[selRosterIdx] || null;
  const mNum   = roster ? (roster.monthNum??roster.month_num??0) : new Date().getMonth();
  const year   = roster ? roster.year : new Date().getFullYear();

  // Calendar grid helpers
  const daysInMonth = new Date(year, mNum+1, 0).getDate();
  const firstDow    = new Date(year, mNum, 1).getDay(); // 0=Sun
  const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DOW_LABELS  = ["S","M","T","W","T","F","S"];
  const NOW = new Date();
  const todayStr = `${NOW.getFullYear()}-${String(NOW.getMonth()+1).padStart(2,"0")}-${String(NOW.getDate()).padStart(2,"0")}`;

  // Build lookup: day -> {flights, dutyCode, isOff}
  const dayMap = {};
  (roster?.calendar||[]).forEach(d=>{ dayMap[d.day]=d; });

  const selDayData = selDay!=null ? (dayMap[selDay]||null) : null;
  const selDateStr = selDay!=null ? `${year}-${String(mNum+1).padStart(2,"0")}-${String(selDay).padStart(2,"0")}` : null;

  // Stats for selected day
  const selFlights = selDayData?.flights||[];
  const selBlock = selFlights.reduce((acc,f,fi)=>{
    const di=(roster?.calendar||[]).findIndex(d=>d.day===selDay);
    const tk=`${roster?.id}-${di}-${fi}`;
    const t=tails[tk]||{};
    return acc+(t.actualBlockMins??schedMins(f)??0);
  },0);
  const selDow = selDay!=null ? ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(year,mNum,selDay).getDay()] : "";
  const selMonName = MONTHS_FULL[mNum];

  return(
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>

      {/* Sticky header -- back arrow since this is now a standalone page
          reached only from the Dashboard, not a tab inside the Logbook hub */}
      <div style={{position:"sticky",top:0,zIndex:20,background:`${S.bg}f0`,backdropFilter:"blur(12px)",borderBottom:`1px solid ${S.border}`,padding:"14px 18px",display:"flex",alignItems:"center",gap:12,justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <button onClick={()=>setPage&&setPage("dashboard")} style={{width:36,height:36,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke={S.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <h1 style={{fontSize:20,fontWeight:800,color:S.ink,margin:0,letterSpacing:"-.5px"}}>Calendar</h1>
        </div>
        <button onClick={()=>window.location.reload()} style={{width:36,height:36,borderRadius:"50%",background:S.surface,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      <div style={{padding:"16px 16px 80px"}}>
        {/* Background decorations */}
        <div style={{position:"fixed",top:"-5%",right:"-5%",width:"40%",height:"40%",background:"#1D4ED8",borderRadius:"50%",filter:"blur(100px)",opacity:0.14,pointerEvents:"none",zIndex:0}}/>
        <div style={{position:"fixed",top:"25%",left:"-5%",width:"30%",height:"30%",background:"#2563EB",borderRadius:"50%",filter:"blur(100px)",opacity:0.11,pointerEvents:"none",zIndex:0}}/>

        {!rosters.length?(
          <div style={{textAlign:"center",padding:"60px 20px",color:S.muted}}>
            <div style={{fontSize:40,marginBottom:12}}>📅</div>
            <div style={{fontSize:16,fontWeight:700,color:S.ink,marginBottom:6}}>No roster uploaded yet</div>
            <div style={{fontSize:13,marginBottom:16}}>Upload your monthly PDF roster to see your schedule</div>
          </div>
        ):(
        <div style={{display:"grid",gridTemplateColumns:"1fr",gap:16,position:"relative",zIndex:1}}>

          {/* -- CALENDAR CARD -- */}
          <div style={{background:S.surface,borderRadius:24,border:`1px solid ${S.border}`,boxShadow:"0 8px 32px rgba(0,0,0,0.06)",padding:"20px 18px",overflow:"hidden"}}>

            {/* Month title + roster pills */}
            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
              <h2 style={{fontSize:28,fontWeight:900,color:S.ink,margin:0,letterSpacing:"-1px",lineHeight:1}}>
                {MONTHS_FULL[mNum]}<br style={{}}/>
                <span style={{fontSize:20,fontWeight:700,color:S.muted}}>{year}</span>
              </h2>
              <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:2}}>
                {rosters.map((r,i)=>{
                  const mn=r.monthNum??r.month_num??0;
                  const lbl=`${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mn]} ${r.year}`;
                  const active=i===selRosterIdx;
                  return(
                    <button key={r.id} onClick={()=>{setSelRosterIdx(i);setSelDay(null);}}
                      style={{padding:"7px 16px",borderRadius:100,flexShrink:0,border:"none",fontSize:13,fontWeight:700,cursor:"pointer",
                        background:active?BLUE:S.panel,color:active?"#fff":S.muted,
                        boxShadow:active?"0 4px 12px rgba(29,78,216,0.3)":"none",transition:"all .15s"}}
                    >{lbl}</button>
                  );
                })}
              </div>
            </div>

            {/* Legend */}
            <div style={{display:"flex",gap:16,marginBottom:14}}>
              {[["#1D4ED8","Flight"],["#10B981","Flown"],["#F59E0B","Standby"]].map(([clr,lbl])=>(
                <div key={lbl} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:S.muted}}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:clr,display:"inline-block"}}/>
                  {lbl}
                </div>
              ))}
            </div>

            {/* Day-of-week header */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,minmax(0,1fr))",marginBottom:4}}>
              {DOW_LABELS.map((d,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,fontWeight:800,color:S.muted,textTransform:"uppercase",letterSpacing:"1px",padding:"4px 0"}}>{d}</div>
              ))}
            </div>

            {/* Calendar grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,minmax(0,1fr))",width:"100%",boxSizing:"border-box",border:`1px solid ${S.border}`,borderRadius:12,overflow:"hidden",gap:1,background:S.border}}>
              {/* Empty cells before month start */}
              {Array.from({length:firstDow},(_,i)=>(
                <div key={`e${i}`} style={{background:S.panel,aspectRatio:"1",minHeight:44}}/>
              ))}
              {/* Day cells */}
              {Array.from({length:daysInMonth},(_,i)=>{
                const day=i+1;
                const d=dayMap[day];
                const hasFlights=d&&(d.flights||[]).length>0;
                const isOff=!d||d.isOff||(!hasFlights&&!d.dutyCode);
                const dutyCode=d?.dutyCode||null;
                const dateStr2=`${year}-${String(mNum+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                const isPast=dateStr2<todayStr;
                const isToday=dateStr2===todayStr;
                const isSel=selDay===day;

                // Check if flown (has tail sync)
                let isFlown=false;
                if(hasFlights&&roster){
                  const di=(roster.calendar||[]).findIndex(dd=>dd.day===day);
                  isFlown=(d.flights||[]).some((_,fi)=>!!(tails[`${roster.id}-${di}-${fi}`]?.tail));
                }

                const bg=isSel?"#1D4ED8":hasFlights?(isFlown?"#10B981":"#1D4ED8"):dutyCode?"#F59E0B":S.surface;
                const textCol=hasFlights||isSel||dutyCode?"#fff":(isOff?S.muted:S.ink);
                const innerShadow=isSel?"inset 0 0 0 2px #1D4ED8,inset 0 0 0 4px #ffffff":"none";

                return(
                  <div key={day}
                    onClick={()=>hasFlights||dutyCode?setSelDay(isSel?null:day):null}
                    style={{
                      background:bg,aspectRatio:"1",minHeight:44,
                      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",
                      padding:"4px 2px",cursor:hasFlights||dutyCode?"pointer":"default",
                      position:"relative",transition:"filter .1s",
                      boxShadow:innerShadow,
                    }}
                    onMouseEnter={e=>{ if(hasFlights||dutyCode) e.currentTarget.style.filter="brightness(0.92)"; }}
                    onMouseLeave={e=>{ e.currentTarget.style.filter="none"; }}
                  >
                    <span style={{fontSize:11,fontWeight:isSel||hasFlights?800:500,color:textCol,marginTop:2,lineHeight:1}}>{day}</span>
                    {hasFlights&&(
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" style={{marginTop:2}}>
                        <path d="M5 17l6-10 3 5 3-4 4 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {dutyCode&&!hasFlights&&<span style={{fontSize:6,color:"#fff",fontWeight:800,marginTop:1,lineHeight:1}}>{dutyCode.slice(0,3)}</span>}
                    {isToday&&!isSel&&(
                      <div style={{position:"absolute",bottom:2,right:3,width:5,height:5,borderRadius:"50%",background:"#10B981"}}/>
                    )}
                    {isSel&&isFlown&&(
                      <div style={{position:"absolute",bottom:2,right:3,width:5,height:5,borderRadius:"50%",background:"#34D399"}}/>
                    )}
                  </div>
                );
              })}
              {/* Fill remaining grid */}
              {Array.from({length:(7-(firstDow+daysInMonth)%7)%7},(_,i)=>(
                <div key={`z${i}`} style={{background:S.panel,aspectRatio:"1",minHeight:44}}/>
              ))}
            </div>
          </div>

          {/* -- SELECTED DAY DETAIL PANEL -- */}
          {selDay&&selDayData&&(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {/* Day header */}
              <div style={{background:S.surface,borderRadius:24,border:`1px solid ${S.border}`,padding:"18px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:0,right:0,width:80,height:80,background:C.blueBg,borderRadius:"0 24px 0 100%",zIndex:0}}/>
                <div style={{position:"relative",zIndex:1}}>
                  <h3 style={{fontSize:18,fontWeight:800,color:S.ink,margin:0}}>{selDow}, {selMonName} {selDay}</h3>
                  <p style={{fontSize:13,color:S.muted,margin:"4px 0 0",fontWeight:500}}>
                    {selFlights.length} leg{selFlights.length!==1?"s":""}
                    {selBlock>0?` · ${fmtMins(selBlock)} block`:""}
                    {selDayData.dutyCode?` · ${selDayData.dutyCode}`:""}
                  </p>
                </div>
                <button onClick={()=>setSelDay(null)} style={{width:32,height:32,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative",zIndex:1}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke={S.muted} strokeWidth="2" strokeLinecap="round"/></svg>
                </button>
              </div>

              {/* Flight legs */}
              {selFlights.sort((a,b)=>(a.depTime||"").localeCompare(b.depTime||"")).map((f,fi)=>{
                const di=(roster?.calendar||[]).findIndex(d=>d.day===selDay);
                const tk=`${roster?.id}-${di}-${fi}`;
                const t=tails[tk]||{};
                const bm=t.actualBlockMins??schedMins(f)??0;
                const dist=calcDist(f.dep,f.arr)||0;
                const isFlown=!!t.tail;
                const isXC=dist>50;
                return(
                  <div key={fi}
                    onClick={()=>onOpenFlight&&onOpenFlight({f,day:selDayData,roster,di,fi,tk,tail:t,dateStr:selDateStr,dist,solar:computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,selDateStr),blockMins:bm,hasActual:!!(t.actualDep||t.actualArr||t.tail),dep:f.dep,arr:f.arr,isXC,userId:user?.id})}
                    style={{background:S.surface,borderRadius:20,border:`1px solid ${S.border}`,padding:"14px 18px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",transition:"border-color .1s",boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor=C.blueBdr;}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=S.border;}}
                  >
                    {/* Status bar */}
                    <div style={{width:6,height:48,borderRadius:3,background:f.isDeadhead?"#94A3B8":isFlown?"#10B981":S.border,flexShrink:0}}/>

                    {/* Times */}
                    <div style={{width:52,flexShrink:0}}>
                      <div style={{fontSize:15,fontWeight:800,color:S.ink,lineHeight:1}}>{f.depTime||"--"}</div>
                      <div style={{fontSize:11,color:S.muted,marginTop:3}}>{f.arrTime||"--"}</div>
                    </div>

                    {/* Flight info */}
                    <div style={{flex:1,borderLeft:`1px solid ${S.border}`,paddingLeft:14,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:13,fontWeight:800,color:f.isDeadhead?S.muted:S.blue}}>{f.flightNum}</span>
                        {f.isDeadhead&&<span style={{fontSize:10,fontWeight:800,color:"#fff",background:"#64748B",padding:"2px 7px",borderRadius:4,letterSpacing:".3px"}}>DH</span>}
                        {f.acType&&<span style={{fontSize:10,fontWeight:700,color:S.muted,background:S.panel,padding:"2px 6px",borderRadius:4}}>{f.acType}</span>}
                        {isXC&&!f.isDeadhead&&<span style={{fontSize:10,fontWeight:700,color:S.purple,background:`${S.purple}15`,padding:"2px 6px",borderRadius:4}}>XC</span>}
                      </div>
                      <div style={{fontSize:13,fontWeight:700,color:S.ink,display:"flex",alignItems:"center",gap:6}}>
                        {f.dep}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M14 6l6 6-6 6" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        {f.arr}
                      </div>
                      {t.tail&&(
                        <div style={{display:"flex",alignItems:"center",gap:4,marginTop:3}}>
                          <span style={{fontSize:11,color:S.muted,fontFamily:"monospace"}}>{t.tail}</span>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#10B981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                      )}
                    </div>

                    {/* Duration / distance */}
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:14,fontWeight:800,color:f.isDeadhead?S.muted:S.ink}}>{f.isDeadhead?"DH":(bm?fmtMins(bm):"--")}</div>
                      {dist>0&&<div style={{fontSize:10,color:S.muted,marginTop:2}}>{dist} NM</div>}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{marginTop:6,opacity:.3}}><path d="M9 18l6-6-6-6" stroke={S.purple} strokeWidth="2.5" strokeLinecap="round"/></svg>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </div>
        )}
      </div>

      <style>{`.cal-left-panel{overflow-y:visible!important}`}</style>
    </div>
  );
}

// Sub-component so hooks can be called unconditionally (React rules of hooks
// forbid calling useState/useEffect inside a conditional block).
// ── LOGBOOK CSV IMPORT ────────────────────────────────────────────────────────
// Imports historical flights from electronic-logbook CSV/TSV exports:
// ForeFlight (two-section file with Aircraft Table join), LogTen Pro,
// MyFlightbook, and ASA / Jeppesen classic-column logbooks. Mapping is
// synonym-based on normalized headers so naming/order variants still map;
// unrecognized columns are surfaced in the preview rather than silently
// dropped, and NOTHING is saved until the pilot confirms.

function lbNorm(h){ return String(h||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

const LB_HEADERS = {
  date:"date", flightdate:"date", dateofflight:"date",
  flightnumber:"flightNum", flightno:"flightNum", flight:"flightNum", flt:"flightNum",
  aircraftid:"tail", tailnumber:"tail", ident:"tail", aircraftident:"tail",
  registration:"tail", aircraftregistration:"tail", nnumber:"tail", acreg:"tail", reg:"tail",
  aircrafttype:"acType", typecode:"acType", model:"acType", type:"acType", actype:"acType",
  makemodel:"acType", aircraftmakemodel:"acType", makeandmodel:"acType", equipment:"acType", aircraftmakeandmodel:"acType",
  from:"dep", origin:"dep", departure:"dep", dep:"dep", departureairport:"dep",
  to:"arr", destination:"arr", arrival:"arr", arr:"arr", arrivalairport:"arr", dest:"arr",
  route:"route",
  timeout:"depTime", out:"depTime", outtime:"depTime", deptime:"depTime", departuretime:"depTime",
  timeoff:"depTimeAlt", off:"depTimeAlt",
  timein:"arrTime", in:"arrTime", intime:"arrTime", arrtime:"arrTime", arrivaltime:"arrTime",
  timeon:"arrTimeAlt", on:"arrTimeAlt",
  totaltime:"totalMins", total:"totalMins", totalflighttime:"totalMins", totalduration:"totalMins",
  blocktime:"totalMins", flighttime:"totalMins", duration:"totalMins", block:"totalMins",
  pic:"picMins", pictime:"picMins", picus:"picMins", pilotincommand:"picMins",
  sic:"sicMins", sictime:"sicMins", copilot:"sicMins", secondincommand:"sicMins",
  night:"nightMins", nighttime:"nightMins",
  actualinstrument:"instMins", imc:"instMins", instrument:"instMins", actualimc:"instMins",
  simulatedinstrument:"simInstMins", hood:"simInstMins", simulatedimc:"simInstMins", simulatedinstrumenthood:"simInstMins",
  crosscountry:"xcMins", xcountry:"xcMins", xc:"xcMins", xcountrytime:"xcMins",
  solo:"soloMins",
  dualreceived:"dualMins", dual:"dualMins",
  dualgiven:"dualGivenMins", cfi:"dualGivenMins", flightinstructor:"dualGivenMins", asflightinstructor:"dualGivenMins", instructor:"dualGivenMins",
  simulatedflight:"simMins", groundsimulator:"simMins", flightsimulator:"simMins", ffs:"simMins", simtime:"simMins", ftd:"simMins",
  landings:"landings", alllandings:"landings", nrldgs:"landings", ldg:"landings", ldgs:"landings", numberoflandings:"landings", totallandings:"landings",
  daylandings:"dayLandings", daylandingsfullstop:"dayLandings", fsdaylandings:"dayLandings", landingsday:"dayLandings",
  nightlandings:"nightLandings", nightlandingsfullstop:"nightLandings", fsnightlandings:"nightLandings", landingsnight:"nightLandings",
  daytakeoffs:"dayTakeoffs", nighttakeoffs:"nightTakeoffs",
  approaches:"approaches", nrinstapp:"approaches", instrumentapproaches:"approaches", numberofapproaches:"approaches", app:"approaches",
  holds:"holds", hold:"holds",
  remarks:"remarks", comments:"remarks", pilotcomments:"remarks", notes:"remarks", comment:"remarks",
};

// Duration → minutes. Logbook conventions: decimal hours ("1.5"), h:mm
// ("1:30"), h+mm ("1+30"). A bare integer is hours unless >24 (then minutes).
function lbDur(s){
  s = String(s==null?"":s).trim();
  if(!s) return null;
  let m;
  if((m = s.match(/^(\d{1,2})[:+](\d{2})$/))) return parseInt(m[1])*60 + parseInt(m[2]);
  if((m = s.match(/^[:+](\d{1,2})$/))) return parseInt(m[1]);
  if((m = s.match(/^(\d*)[.,](\d+)$/))) return Math.round(parseFloat((m[1]||"0")+"."+m[2]) * 60);
  if(/^\d+$/.test(s)){
    const n = parseInt(s);
    return n > 24 ? n : n*60;
  }
  return null;
}

function lbCount(s){
  s = String(s==null?"":s).trim();
  if(!s) return null;
  const n = parseInt(s);
  return isNaN(n) ? null : n;
}

function lbClock(s){
  s = String(s==null?"":s).trim();
  if(!s) return "";
  let ampm = null;
  const ap = s.match(/\s*([AaPp])\.?[Mm]\.?\s*$/);
  if(ap){ ampm = ap[1].toLowerCase(); s = s.slice(0, ap.index); }
  const m = s.match(/^(\d{1,2}):?(\d{2})$/);
  if(!m) return "";
  let h = parseInt(m[1]);
  if(ampm==="p" && h<12) h += 12;
  if(ampm==="a" && h===12) h = 0;
  if(h>23 || parseInt(m[2])>59) return "";
  return String(h).padStart(2,"0")+":"+m[2];
}

const LB_MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

// Two-pass date handling: numeric x/y/z dates are ambiguous (m/d vs d/m), so
// the caller first scans ALL rows — any first-field >12 proves d/m, any
// second-field >12 proves m/d — then parses with the resolved order.
function lbDate(s, order){
  s = String(s==null?"":s).trim();
  if(!s) return null;
  let m;
  if((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/)))
    return `${m[1]}-${String(parseInt(m[2])).padStart(2,"0")}-${String(parseInt(m[3])).padStart(2,"0")}`;
  if((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s,]+(\d{2,4})$/))){
    const mo = LB_MONTHS[m[2].toLowerCase().slice(0,3)];
    if(mo===undefined) return null;
    let y = parseInt(m[3]); if(y<100) y += y<=(new Date().getFullYear()%100+1)?2000:1900;
    return `${y}-${String(mo+1).padStart(2,"0")}-${String(parseInt(m[1])).padStart(2,"0")}`;
  }
  if((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))){
    let a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    if(y<100) y += y<=(new Date().getFullYear()%100+1)?2000:1900;
    const [mo,da] = order==="dmy" ? [b,a] : [a,b];
    if(mo<1||mo>12||da<1||da>31) return null;
    return `${y}-${String(mo).padStart(2,"0")}-${String(da).padStart(2,"0")}`;
  }
  return null;
}

// CSV/TSV tokenizer: quotes, "" escapes, CRLF; delimiter passed in.
function lbTokenize(line, delim){
  const out = []; let cur = "", q = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(q){
      if(ch==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if(ch==='"') q = true;
      else if(ch===delim){ out.push(cur); cur=""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function lbSniffDelim(line){
  const t = (line.match(/\t/g)||[]).length, c = (line.match(/,/g)||[]).length, s = (line.match(/;/g)||[]).length;
  if(t>=c && t>=s && t>0) return "\t";
  if(s>c) return ";";
  return ",";
}

function parseLogbookCsv(text){
  const rawLines = String(text||"").split(/\r?\n/);
  const warnings = [], skipped = [];
  let format = "Generic logbook CSV";
  let headerIdx = -1, tailInfo = {};

  // ForeFlight two-section layout: "Aircraft Table" then "Flights Table".
  const ffFlights = rawLines.findIndex(l=>/^"?flights table/i.test(l.trim()));
  if(ffFlights >= 0){
    format = "ForeFlight";
    const ffAircraft = rawLines.findIndex(l=>/^"?aircraft table/i.test(l.trim()));
    if(ffAircraft >= 0 && ffAircraft < ffFlights){
      let hi = ffAircraft+1;
      while(hi<ffFlights && !rawLines[hi].trim()) hi++;
      const d0 = lbSniffDelim(rawLines[hi]);
      const ah = lbTokenize(rawLines[hi], d0).map(lbNorm);
      const idI = ah.indexOf("aircraftid"), idT = ah.findIndex(h=>h==="typecode"||h==="model"||h==="type");
      for(let r=hi+1;r<ffFlights;r++){
        const line = rawLines[r]; if(!line.trim()) continue;
        const cells = lbTokenize(line, d0);
        if(idI>=0 && cells[idI]) tailInfo[cells[idI].trim().toUpperCase()] = (idT>=0 ? (cells[idT]||"").trim() : "");
      }
    }
    headerIdx = ffFlights+1;
    while(headerIdx<rawLines.length && !rawLines[headerIdx].trim()) headerIdx++;
  } else {
    headerIdx = rawLines.findIndex(l=>l.trim());
    if(headerIdx < 0) return {error:"File is empty."};
  }

  const delim = lbSniffDelim(rawLines[headerIdx]);
  const headersRaw = lbTokenize(rawLines[headerIdx], delim).map(h=>h.trim());
  const colMap = {};        // column index -> canonical field
  const mapped = {};        // canonical field -> original header (first hit)
  const unmapped = [];
  const approachCols = [];
  headersRaw.forEach((h, i)=>{
    const n = lbNorm(h);
    if(/^approach\d+$/.test(n)){ approachCols.push(i); return; }
    const canon = LB_HEADERS[n];
    if(canon){ colMap[i]=canon; if(!mapped[canon]) mapped[canon]=h; }
    else if(h) unmapped.push(h);
  });

  if(format!=="ForeFlight"){
    const has = k=>!!mapped[k];
    if(mapped.tail==="Tail Number" && (has("route")||lbNorm(mapped.totalMins||"")==="totalflighttime")) format = "MyFlightbook";
    else if(mapped.tail==="Aircraft ID" && has("totalMins")) format = "LogTen Pro";
    else if((lbNorm(mapped.tail||"").includes("ident")||lbNorm(mapped.acType||"").includes("makemodel")) && has("dualMins")) format = "ASA/Jeppesen (classic)";
  }

  if(!mapped.date) return {error:"No date column recognized. Headers found: "+headersRaw.join(", ")};
  if(!mapped.dep && !mapped.route && !mapped.totalMins)
    return {error:"Could not find route (From/To or Route) or a total-time column. Headers found: "+headersRaw.join(", ")};

  // Pass 1: resolve numeric date order across the whole file.
  const dateCol = headersRaw.findIndex((h,i)=>colMap[i]==="date");
  let order = "mdy", proven = false;
  for(let r=headerIdx+1;r<rawLines.length;r++){
    if(!rawLines[r].trim()) continue;
    const v = (lbTokenize(rawLines[r], delim)[dateCol]||"").trim();
    const m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{2,4}$/);
    if(!m) continue;
    if(parseInt(m[1])>12){ order="dmy"; proven=true; break; }
    if(parseInt(m[2])>12){ order="mdy"; proven=true; }
  }
  const anyNumericDate = rawLines.slice(headerIdx+1).some(l=>{
    if(!l.trim()) return false;
    const v = (lbTokenize(l, delim)[dateCol]||"").trim();
    return /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(v);
  });
  if(anyNumericDate && !proven) warnings.push("Date order ambiguous (no day >12 found) — assumed month/day/year (US). Check dates in the preview.");

  // Pass 2: rows → canonical flights.
  const flights = [];
  for(let r=headerIdx+1;r<rawLines.length;r++){
    const line = rawLines[r];
    if(!line.trim()) continue;
    if(/^"?(aircraft|flights) table/i.test(line.trim())) break;
    const cells = lbTokenize(line, delim);
    const raw = {};
    cells.forEach((v,i)=>{ const k=colMap[i]; if(k && String(v).trim()!=="") raw[k] = String(v).trim(); });
    if(Object.keys(raw).length===0) continue;

    const dateStr = lbDate(raw.date, order);
    if(!dateStr){ skipped.push({row:r+1, reason:`unparseable date "${raw.date||""}"`}); continue; }

    let dep = (raw.dep||"").toUpperCase(), arr = (raw.arr||"").toUpperCase();
    if((!dep || !arr) && raw.route){
      const toks = raw.route.toUpperCase().split(/[\s>\-]+/).filter(t=>/^[A-Z0-9]{3,4}$/.test(t));
      if(toks.length){ dep = dep || toks[0]; arr = arr || toks[toks.length-1]; }
    }

    const totalMins = lbDur(raw.totalMins);
    const simMins = lbDur(raw.simMins);
    if((totalMins==null || totalMins===0) && (simMins||0)>0 && !dep && !arr){
      skipped.push({row:r+1, reason:"simulator session (no route, zero flight time) — not imported"});
      continue;
    }
    if(totalMins==null && !dep && !arr){
      skipped.push({row:r+1, reason:"no route and no total time"});
      continue;
    }

    let approaches = lbCount(raw.approaches);
    if(approaches==null && approachCols.length){
      const n = approachCols.filter(i=>(cells[i]||"").trim()!=="").length;
      if(n>0) approaches = n;
    }

    const tail = (raw.tail||"").toUpperCase();
    let acType = raw.acType || "";
    if(!acType && tail && tailInfo[tail]) acType = tailInfo[tail];

    flights.push({
      dateStr, flightNum: raw.flightNum||"", tail, acType,
      dep, arr,
      depTime: lbClock(raw.depTime) || lbClock(raw.depTimeAlt) || "",
      arrTime: lbClock(raw.arrTime) || lbClock(raw.arrTimeAlt) || "",
      totalMins: totalMins==null ? 0 : totalMins,
      picMins: lbDur(raw.picMins), sicMins: lbDur(raw.sicMins),
      nightMins: lbDur(raw.nightMins),
      instMins: lbDur(raw.instMins), simInstMins: lbDur(raw.simInstMins),
      xcMins: lbDur(raw.xcMins), soloMins: lbDur(raw.soloMins),
      dualMins: lbDur(raw.dualMins), dualGivenMins: lbDur(raw.dualGivenMins),
      landings: lbCount(raw.landings),
      dayLandings: lbCount(raw.dayLandings), nightLandings: lbCount(raw.nightLandings),
      approaches, holds: lbCount(raw.holds),
      remarks: raw.remarks||"",
    });
  }

  if(!flights.length) return {error:"No importable flight rows found."+(skipped.length?` ${skipped.length} row(s) skipped.`:"")};

  flights.sort((a,b)=>a.dateStr<b.dateStr?-1:a.dateStr>b.dateStr?1:0);
  const totalAll = flights.reduce((a,f)=>a+(f.totalMins||0),0);
  return {
    format, delimiter: delim==="\t"?"tab":delim, headersRaw, mapped, unmapped,
    flights, skipped, warnings, dateOrder: order,
    totalFlights: flights.length, totalMins: totalAll,
    dateRange: [flights[0].dateStr, flights[flights.length-1].dateStr],
  };
}

// Group canonical flights into month rosters. Months that already have a
// roster are SKIPPED (never merged/overwritten) and reported — imports are
// for history the app doesn't have yet.
function buildImportRosters(flights, existingRosters){
  const MF = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const byMonth = {};
  for(const f of flights){
    const key = f.dateStr.slice(0,7);
    (byMonth[key] = byMonth[key]||[]).push(f);
  }
  const months = Object.keys(byMonth).sort().map(key=>{
    const [ys, ms] = key.split("-");
    const year = parseInt(ys), monthNum = parseInt(ms)-1;
    const exists = (existingRosters||[]).some(r=>r.year===year && (r.monthNum??r.month_num??-1)===monthNum);
    const dim = new Date(year, monthNum+1, 0).getDate();
    const byDay = {};
    for(const f of byMonth[key]){
      const day = parseInt(f.dateStr.slice(8));
      (byDay[day] = byDay[day]||[]).push({
        flightNum: f.flightNum, dep: f.dep, arr: f.arr,
        depTime: f.depTime, arrTime: f.arrTime, acType: f.acType,
        // schedBlockMins mirrors loggedMins so every existing duration UI works.
        schedBlockMins: f.totalMins||null, isDeadhead: false,
        tail: f.tail||null, source: "import", remarks: f.remarks||"",
        loggedMins: f.totalMins||0,
        loggedPicMins: f.picMins, loggedSicMins: f.sicMins,
        loggedNightMins: f.nightMins, loggedXcMins: f.xcMins,
        loggedInstMins: f.instMins, loggedSimInstMins: f.simInstMins,
        loggedDualMins: f.dualMins, loggedDualGivenMins: f.dualGivenMins,
        loggedSoloMins: f.soloMins,
        loggedLandings: f.landings!=null ? f.landings
          : (f.dayLandings!=null || f.nightLandings!=null) ? (f.dayLandings||0)+(f.nightLandings||0) : null,
        loggedDayLandings: f.dayLandings, loggedNightLandings: f.nightLandings,
        loggedApproaches: f.approaches, loggedHolds: f.holds,
      });
    }
    const calendar = [];
    for(let d=1; d<=dim; d++){
      const fl = (byDay[d]||[]).sort((a,b)=>(a.depTime||"").localeCompare(b.depTime||""));
      calendar.push({day:d, dow:DOW[new Date(year,monthNum,d).getDay()], isOff:fl.length===0, dutyCode:null, flights:fl});
    }
    const roster = {
      year, monthNum, periodLabel:`${MF[monthNum]} ${year}`, calendar,
      _layer:"csv_import", imported:true, uploadedAt:new Date().toISOString(),
    };
    const n = byMonth[key].length;
    const mins = byMonth[key].reduce((a,f)=>a+(f.totalMins||0),0);
    return {key, year, monthNum, label:roster.periodLabel, roster, exists, flights:n, mins};
  });
  return months;
}
// ── END LOGBOOK CSV IMPORT ────────────────────────────────────────────────────


function PostUploadVerifyScreen({parsedRoster, rosters, user, onRosterSaved, onReloadRosters, setParsedRoster, setStatus, setMsg, setPage}) {
  const S = getS();

  // DEFERRED-SAVE MODEL: the parsed roster lives ONLY in memory until the
  // pilot taps "Confirm & Save". Nothing is in the database yet, so the
  // carryover tab reads parsedRoster.carryForwardDays directly (the parser
  // attaches it) instead of looking for a DB stub. Discarding or leaving
  // this screen throws the upload away with zero cleanup needed.
  const [saving, setSaving] = useState(false);

    const mNum = parsedRoster.monthNum ?? parsedRoster.month_num ?? 0;
    const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const MONTH_ABBR  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const nextMNum  = mNum===11?0:mNum+1;
    const nextYear  = mNum===11?parsedRoster.year+1:parsedRoster.year;
    const carry = Array.isArray(parsedRoster.carryForwardDays) ? parsedRoster.carryForwardDays : [];

    // Tab toggle between this month and the carryover month (always shown)
    const [vTab, setVTab] = useState("current"); // "current" | "carryover"
    const activeCalendar = vTab==="carryover" ? carry : (parsedRoster.calendar||[]);
    const activeMNum   = vTab==="carryover" ? nextMNum : mNum;
    const activeYear   = vTab==="carryover" ? nextYear : parsedRoster.year;
    // Compat shape for the day-list JSX below
    const activeRoster = {year:activeYear, monthNum:activeMNum, calendar:activeCalendar};

    // Build the full calendar grid for the active tab
    // Show ALL days in the month, not just duty days
    const daysInMonth = new Date(activeYear, activeMNum+1, 0).getDate();
    const dayMap = {};
    activeCalendar.forEach(d=>{ dayMap[d.day] = d; });
    const allDays = Array.from({length:daysInMonth},(_,i)=>({
      day: i+1,
      data: dayMap[i+1] || {day:i+1,dow:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(activeYear,activeMNum,i+1).getDay()],isOff:true,dutyCode:null,flights:[]},
    }));

    const totalFlights = activeCalendar.reduce((a,d)=>a+(d.flights||[]).length,0);
    const dutyDays     = activeCalendar.filter(d=>(d.flights||[]).length>0||d.dutyCode).length;

    // Inline edit state
    const [addingFlightToDay, setAddingFlightToDay] = useState(null); // day number
    const [flightDraft, setFlightDraft] = useState({flightNum:"",dep:"",depTime:"",arr:"",arrTime:"",acType:""});
    const [editingFlight, setEditingFlight] = useState(null); // {day,fi}

    // All edits are IN MEMORY — routed to the active tab's array. The database
    // is only touched by confirmSave below.
    function updateCalendar(newCal) {
      if(vTab==="carryover") setParsedRoster({...parsedRoster, carryForwardDays:newCal});
      else setParsedRoster({...parsedRoster, calendar:newCal});
    }

    function deleteDay(dayNum) {
      if(!window.confirm(`Remove day ${dayNum} (all flights) from the roster?`)) return;
      updateCalendar(activeCalendar.filter(d=>d.day!==dayNum));
    }

    function deleteFlight(dayNum, fi) {
      if(!window.confirm("Remove this flight?")) return;
      const newCal = activeCalendar.map(d=>
        d.day===dayNum ? {...d, flights:(d.flights||[]).filter((_,i)=>i!==fi)} : d
      ).filter(d=>(d.flights||[]).length>0||d.dutyCode||!d.isOff);
      updateCalendar(newCal);
    }

    function addFlight(dayNum) {
      const f = flightDraft;
      if(!f.flightNum&&!f.dep) return;
      const nc = activeCalendar.map(d=>({...d, flights:[...(d.flights||[])]}));
      const existing = nc.find(d=>d.day===dayNum);
      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(activeYear,activeMNum,dayNum).getDay()];
      const newFlight = {flightNum:f.flightNum||"MANUAL",dep:f.dep.toUpperCase(),depTime:f.depTime,arr:f.arr.toUpperCase(),arrTime:f.arrTime,acType:f.acType.toUpperCase(),schedBlockMins:null,isDeadhead:false};
      if(existing){ existing.flights=[...(existing.flights||[]),newFlight]; existing.isOff=false; }
      else { nc.push({day:dayNum,dow,isOff:false,dutyCode:null,flights:[newFlight]}); nc.sort((a,b)=>a.day-b.day); }
      updateCalendar(nc);
      setAddingFlightToDay(null);
      setFlightDraft({flightNum:"",dep:"",depTime:"",arr:"",arrTime:"",acType:""});
    }

    async function confirmSave() {
      setSaving(true);
      try {
        // db_saveRoster handles everything: this month's merge-protection
        // rules AND routing carryForwardDays into next month's roster/stub.
        const saved = await db_saveRoster(user.id, parsedRoster);
        onRosterSaved(saved||parsedRoster);
        try { const fresh = await db_loadRosters(user.id); if(fresh?.length) onReloadRosters?.(fresh); } catch {}
        setParsedRoster(null);
        setStatus("success");
        setMsg(`✓ Saved ${parsedRoster.periodLabel}${carry.length?` + ${carry.length} carryover day${carry.length>1?"s":""}`:""}. Verify & Sign in Active Logs when ready.`);
      } catch(e) {
        alert("Save failed: "+e.message);
      }
      setSaving(false);
    }

    const INPUT = {width:"100%",padding:"8px 10px",borderRadius:8,border:`1px solid ${S.border}`,fontSize:12,background:S.surface,color:S.ink,boxSizing:"border-box",outline:"none"};

    return(
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
        {/* Header */}
        <div style={{background:`linear-gradient(135deg,#10B981,#059669)`,padding:"20px 18px 16px",color:"#fff",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
            <div style={{width:40,height:40,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <div>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:"1.5px",textTransform:"uppercase",color:"rgba(255,255,255,0.75)"}}>Roster Parsed -- Not Yet Signed</div>
              <h2 style={{fontSize:18,fontWeight:900,margin:"2px 0 0",letterSpacing:"-.5px"}}>{MONTHS_FULL[mNum]} {parsedRoster.year}</h2>
            </div>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            {[[`${dutyDays}`,"Duty Days"],[`${totalFlights}`,"Flights"]].map(([val,lbl])=>(
              <div key={lbl} style={{background:"rgba(255,255,255,0.15)",padding:"5px 12px",borderRadius:100,border:"1px solid rgba(255,255,255,0.2)"}}>
                <span style={{fontSize:13,fontWeight:800,color:"#fff"}}>{val}</span>
                <span style={{fontSize:10,color:"rgba(255,255,255,0.7)",marginLeft:5}}>{lbl}</span>
              </div>
            ))}
          </div>
          {/* Carryover: tabs only when carryover actually exists (or the
              pilot opts into manual entry). An always-present empty
              next-month tab read as a parsing bug. */}
          {(carry.length>0 || vTab==="carryover") ? (
            <div style={{background:"rgba(255,255,255,0.15)",borderRadius:12,padding:"10px 14px",border:"1px solid rgba(255,255,255,0.25)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#fff",marginBottom:8}}>
                {carry.length>0
                  ? `${carry.length} carryover day${carry.length>1?"s":""} detected → ${MONTHS_FULL[nextMNum]} ${nextYear}`
                  : `Add carryover flights for ${MONTHS_FULL[nextMNum]} ${nextYear} below`}
              </div>
              <div style={{display:"flex",gap:6}}>
                {[["current",`${MONTH_ABBR[mNum]} ${parsedRoster.year}`],["carryover",`${MONTH_ABBR[nextMNum]} ${nextYear}${carry.length?` (${carry.length})`:""}`]].map(([tid,lbl])=>(
                  <button key={tid} onClick={()=>setVTab(tid)} style={{padding:"5px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,background:vTab===tid?"rgba(255,255,255,0.9)":"rgba(255,255,255,0.2)",color:vTab===tid?"#059669":"#fff"}}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,0.12)",borderRadius:12,padding:"8px 14px",border:"1px solid rgba(255,255,255,0.2)"}}>
              <span style={{fontSize:12,fontWeight:700,color:"#fff"}}>No carryover into {MONTHS_FULL[nextMNum]} {nextYear} detected</span>
              <button onClick={()=>setVTab("carryover")} style={{fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:8,border:"1px solid rgba(255,255,255,0.45)",background:"none",color:"#fff",cursor:"pointer"}}>
                Add manually
              </button>
            </div>
          )}
        </div>

        {/* Note */}
        <div style={{padding:"10px 16px 4px",flexShrink:0,background:S.surface,borderBottom:`1px solid ${S.border}`}}>
          <div style={{fontSize:11,color:S.muted,lineHeight:1.5}}>
            Review and edit below. <strong style={{color:S.ink}}>Nothing is saved until you tap Confirm & Save</strong> — discarding or leaving this screen throws the upload away.
          </div>
        </div>

        {/* Full calendar -- ALL days */}
        <div style={{flex:1,overflowY:"auto",padding:"10px 12px 16px"}}>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {allDays.map(({day,data})=>{
              const isOff = (data.flights||[]).length===0 && !data.dutyCode;
              const isAdding = addingFlightToDay===day;
              return(
                <div key={day} style={{borderRadius:14,border:`1px solid ${isOff?S.border:S.blue+"44"}`,background:isOff?S.panel:S.surface,overflow:"hidden"}}>
                  {/* Day header */}
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:isOff?"transparent":`${S.blue}08`}}>
                    <div style={{width:36,height:36,borderRadius:10,background:isOff?S.border:S.blue,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <div style={{fontSize:15,fontWeight:900,color:isOff?S.muted:"#fff",lineHeight:1}}>{day}</div>
                      <div style={{fontSize:8,fontWeight:700,color:isOff?S.muted:"rgba(255,255,255,0.7)",textTransform:"uppercase"}}>{data.dow}</div>
                    </div>
                    <div style={{flex:1}}>
                      {isOff?(
                        <div style={{fontSize:12,color:S.muted}}>Off day</div>
                      ):(
                        <div style={{fontSize:12,fontWeight:600,color:S.ink}}>
                          {(data.flights||[]).length} flight{(data.flights||[]).length!==1?"s":""}
                          {data.dutyCode&&<span style={{marginLeft:6,fontSize:10,color:S.muted,background:S.panel,padding:"1px 6px",borderRadius:4}}>{data.dutyCode}</span>}
                        </div>
                      )}
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>{ setAddingFlightToDay(isAdding?null:day); setFlightDraft({flightNum:"",dep:"",depTime:"",arr:"",arrTime:"",acType:""});}}
                        title="Add flight to this day"
                        style={{width:28,height:28,borderRadius:"50%",background:S.blue+"18",border:"none",color:S.blue,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>+</button>
                      {!isOff&&(
                        <button onClick={()=>deleteDay(day)} title="Remove day"
                          style={{width:28,height:28,borderRadius:"50%",background:C.redBg,border:"none",color:C.red,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
                      )}
                    </div>
                  </div>

                  {/* Flights */}
                  {(data.flights||[]).map((f,fi)=>{
                    const isEditing = editingFlight?.day===day && editingFlight?.fi===fi;

                    // Edit form -- shown inline when pencil icon tapped
                    if(isEditing){
                      const draft = editingFlight.draft;
                      return(
                        <div key={fi} style={{borderTop:`1px solid ${S.border}`,padding:"10px 12px",background:`${S.blue}06`}}>
                          <div style={{fontSize:11,fontWeight:700,color:S.blue,marginBottom:8}}>Edit flight</div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Flight #</div>
                              <input style={INPUT} value={draft.flightNum} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,flightNum:e.target.value}}))}/>
                            </div>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Aircraft</div>
                              <input style={INPUT} value={draft.acType||""} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,acType:e.target.value.toUpperCase()}}))}/>
                            </div>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Dep airport</div>
                              <input style={INPUT} value={draft.dep} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,dep:e.target.value.toUpperCase().slice(0,4)}}))}/>
                            </div>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Arr airport</div>
                              <input style={INPUT} value={draft.arr} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,arr:e.target.value.toUpperCase().slice(0,4)}}))}/>
                            </div>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Dep time</div>
                              <input type="time" style={INPUT} value={draft.depTime||""} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,depTime:e.target.value}}))}/>
                            </div>
                            <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Arr time</div>
                              <input type="time" style={INPUT} value={draft.arrTime||""} onChange={e=>setEditingFlight(p=>({...p,draft:{...p.draft,arrTime:e.target.value}}))}/>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:6}}>
                            <button onClick={()=>{
                              const newCal=activeCalendar.map(d=>
                                d.day===day?{...d,flights:(d.flights||[]).map((fl,i)=>i===fi?{...fl,...draft}:fl)}:d
                              );
                              updateCalendar(newCal);
                              setEditingFlight(null);
                            }} style={{flex:1,padding:"8px",borderRadius:8,background:S.blue,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Save</button>
                            <button onClick={()=>setEditingFlight(null)} style={{flex:1,padding:"8px",borderRadius:8,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:12,cursor:"pointer"}}>Cancel</button>
                          </div>
                        </div>
                      );
                    }

                    // Read view with edit + delete buttons
                    return(
                      <div key={fi} style={{borderTop:`1px solid ${S.border}`,padding:"8px 12px",display:"flex",alignItems:"center",gap:10}}>
                        <div style={{width:4,height:28,borderRadius:2,background:f.isDeadhead?"#94A3B8":S.blue,flexShrink:0}}/>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:800,color:S.ink}}>
                            {f.flightNum}
                            {f.isDeadhead&&<span style={{marginLeft:5,fontSize:9,fontWeight:700,color:"#fff",background:"#64748B",padding:"1px 5px",borderRadius:3}}>DH</span>}
                          </div>
                          <div style={{fontSize:11,color:S.muted}}>
                            {f.dep}→{f.arr}
                            {(f.depTime||f.arrTime)&&<span> · {f.depTime||"--"}{f.arrTime?` – ${f.arrTime}`:""}</span>}
                            {f.acType&&<span> · {f.acType}</span>}
                            {f.schedBlockMins&&<span> · {fmtMins(f.schedBlockMins)}</span>}
                          </div>
                        </div>
                        {/* Edit button */}
                        <button
                          onClick={()=>setEditingFlight({day,fi,draft:{flightNum:f.flightNum||"",dep:f.dep||"",depTime:f.depTime||"",arr:f.arr||"",arrTime:f.arrTime||"",acType:f.acType||""}})}
                          title="Edit flight"
                          style={{width:26,height:26,borderRadius:"50%",background:S.blue+"15",border:"none",color:S.blue,fontSize:13,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {/* Delete button */}
                        <button onClick={()=>deleteFlight(day,fi)} title="Remove flight"
                          style={{width:26,height:26,borderRadius:"50%",background:C.redBg,border:"none",color:C.red,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>×</button>
                      </div>
                    );
                  })}

                  {/* Add flight form */}
                  {isAdding&&(
                    <div style={{borderTop:`1px solid ${S.border}`,padding:"10px 12px",background:`${S.blue}06`}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Flight #</div><input style={INPUT} placeholder="e.g. 1234" value={flightDraft.flightNum} onChange={e=>setFlightDraft(p=>({...p,flightNum:e.target.value}))}/></div>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Aircraft</div><input style={INPUT} placeholder="e.g. A320" value={flightDraft.acType} onChange={e=>setFlightDraft(p=>({...p,acType:e.target.value.toUpperCase()}))}/></div>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Dep</div><input style={INPUT} placeholder="ORD" value={flightDraft.dep} onChange={e=>setFlightDraft(p=>({...p,dep:e.target.value.toUpperCase().slice(0,4)}))}/></div>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Arr</div><input style={INPUT} placeholder="SCE" value={flightDraft.arr} onChange={e=>setFlightDraft(p=>({...p,arr:e.target.value.toUpperCase().slice(0,4)}))}/></div>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Dep time</div><input type="time" style={INPUT} value={flightDraft.depTime} onChange={e=>setFlightDraft(p=>({...p,depTime:e.target.value}))}/></div>
                        <div><div style={{fontSize:10,color:S.muted,marginBottom:3}}>Arr time</div><input type="time" style={INPUT} value={flightDraft.arrTime} onChange={e=>setFlightDraft(p=>({...p,arrTime:e.target.value}))}/></div>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>addFlight(day)} style={{flex:1,padding:"8px",borderRadius:8,background:S.blue,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Add Flight</button>
                        <button onClick={()=>setAddingFlightToDay(null)} style={{flex:1,padding:"8px",borderRadius:8,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:12,cursor:"pointer"}}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom buttons — side by side to maximize review area */}
        <div style={{flexShrink:0,background:S.surface,borderTop:`1px solid ${S.border}`,padding:"10px 14px",display:"flex",gap:10}}>
          <button
            onClick={()=>{
              if(!window.confirm("Discard this upload? Nothing has been saved yet — this parsed roster will be thrown away.")) return;
              setParsedRoster(null); setStatus(null); setMsg("");
            }}
            disabled={saving}
            style={{flex:1,padding:"13px 8px",borderRadius:14,background:"none",border:"1.5px solid #FECACA",color:C.red,fontSize:13,fontWeight:700,cursor:saving?"not-allowed":"pointer",opacity:saving?0.6:1}}
          >
            Discard
          </button>
          <button
            onClick={confirmSave}
            disabled={saving}
            style={{flex:1.7,padding:"13px 8px",borderRadius:14,background:saving?"#6EE7B7":"linear-gradient(135deg,#10B981,#059669)",border:"none",color:"#fff",fontSize:13.5,fontWeight:800,cursor:saving?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}
          >
            {saving ? "Saving..." : (<>
              Confirm & Save
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </>)}
          </button>
        </div>
      </div>
    );

}

// Preview + confirm screen for logbook CSV imports. Deferred-save: months
// are only written when the pilot taps Confirm; Discard/leaving loses nothing
// because nothing was saved.
function ImportLogbookPreview({preview, rosters, user, onReloadRosters, setImportPreview, setStatus, setMsg}) {
  const S = getS();
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const months = useMemo(()=>buildImportRosters(preview.flights, rosters), [preview, rosters]);
  const importable = months.filter(m=>!m.exists);
  const collisions = months.filter(m=>m.exists);
  const hrs = m=>`${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;

  async function confirmImport(){
    if(!importable.length) return;
    setSaving(true);
    let done = 0, failed = [];
    for(const m of importable){
      setProgress(`Saving ${m.label}... (${done+1}/${importable.length})`);
      try { await db_saveRoster(user.id, m.roster); done++; }
      catch(e){ failed.push(`${m.label}: ${e.message}`); }
    }
    try { const fresh = await db_loadRosters(user.id); if(fresh?.length) onReloadRosters?.(fresh); } catch {}
    setSaving(false);
    setImportPreview(null);
    if(failed.length){
      setStatus("error");
      setMsg(`Imported ${done}/${importable.length} months. Failed: ${failed.join("; ")}`);
    } else {
      setStatus("success");
      setMsg(`✓ Imported ${done} month${done!==1?"s":""} · ${preview.totalFlights - collisions.reduce((a,m)=>a+m.flights,0)} flights${collisions.length?` · ${collisions.length} existing month${collisions.length>1?"s":""} skipped`:""}`);
    }
  }

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"#F8FAFC"}}>
      <div style={{flexShrink:0,background:"linear-gradient(135deg,#3B82F6,#2563EB)",padding:"18px 16px 14px"}}>
        <div style={{fontSize:16,fontWeight:800,color:"#fff",marginBottom:2}}>Import Logbook History</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.85)",marginBottom:10}}>
          {preview.format} · {preview.totalFlights} flights · {preview.dateRange[0]} → {preview.dateRange[1]} · {hrs(preview.totalMins)} total
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {Object.entries(preview.mapped).map(([canon,orig])=>(
            <span key={canon} style={{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:99,background:"rgba(255,255,255,0.18)",color:"#fff"}}>{orig}</span>
          ))}
        </div>
      </div>

      <div style={{padding:"10px 16px 4px",flexShrink:0,background:S.surface,borderBottom:`1px solid ${S.border}`}}>
        <div style={{fontSize:11,color:S.muted,lineHeight:1.5}}>
          Review below. <strong style={{color:S.ink}}>Nothing is saved until you tap Confirm & Import.</strong> Logged times (PIC, night, XC, landings) from your CSV are imported as authoritative.
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>
        {(preview.warnings.length>0 || preview.unmapped.length>0 || preview.skipped.length>0) && (
          <div style={{background:C.amberBg,border:"1px solid #FDE68A",borderRadius:12,padding:"10px 12px",marginBottom:12}}>
            {preview.warnings.map((w,i)=><div key={i} style={{fontSize:11,color:"#92400E",marginBottom:4}}>⚠ {w}</div>)}
            {preview.unmapped.length>0 && <div style={{fontSize:11,color:"#92400E",marginBottom:4}}>Unmapped columns (ignored): {preview.unmapped.join(", ")}</div>}
            {preview.skipped.length>0 && (
              <div style={{fontSize:11,color:"#92400E"}}>
                {preview.skipped.length} row{preview.skipped.length>1?"s":""} skipped:
                {preview.skipped.slice(0,4).map((s,i)=><div key={i} style={{paddingLeft:8}}>· row {s.row}: {s.reason}</div>)}
                {preview.skipped.length>4 && <div style={{paddingLeft:8}}>· ...and {preview.skipped.length-4} more</div>}
              </div>
            )}
          </div>
        )}

        <div style={{fontSize:12,fontWeight:800,color:S.ink,marginBottom:8}}>Months to import ({importable.length})</div>
        {months.map(m=>(
          <div key={m.key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:10,background:m.exists?C.redBg:S.surface,border:`1px solid ${m.exists?C.redBdr:S.border}`,marginBottom:6}}>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:S.ink}}>{m.label}</div>
              <div style={{fontSize:11,color:S.muted}}>{m.flights} flight{m.flights!==1?"s":""} · {hrs(m.mins)}</div>
            </div>
            {m.exists
              ? <span style={{fontSize:10,fontWeight:800,color:C.red,background:"#FEE2E2",padding:"3px 8px",borderRadius:99}}>SKIPPED — roster exists</span>
              : <span style={{fontSize:10,fontWeight:800,color:C.green,background:"#D1FAE5",padding:"3px 8px",borderRadius:99}}>NEW</span>}
          </div>
        ))}

        <div style={{fontSize:12,fontWeight:800,color:S.ink,margin:"14px 0 8px"}}>Sample flights</div>
        {preview.flights.slice(0,5).map((f,i)=>(
          <div key={i} style={{padding:"8px 12px",borderRadius:10,background:S.surface,border:`1px solid ${S.border}`,marginBottom:6,fontSize:12,color:S.ink}}>
            <strong>{f.dateStr}</strong> · {f.flightNum||f.tail||"—"} · {f.dep||"?"}→{f.arr||"?"} · {hrs(f.totalMins||0)}
            {f.acType?` · ${f.acType}`:""}{f.nightMins?` · night ${hrs(f.nightMins)}`:""}
          </div>
        ))}
      </div>

      <div style={{flexShrink:0,background:S.surface,borderTop:`1px solid ${S.border}`,padding:"12px 14px",display:"flex",flexDirection:"column",gap:8}}>
        <button onClick={confirmImport} disabled={saving||!importable.length}
          style={{width:"100%",padding:"14px",borderRadius:14,background:saving?C.blueBdr:!importable.length?"#E2E8F0":"linear-gradient(135deg,#3B82F6,#2563EB)",border:"none",color:!importable.length&&!saving?"#94A3B8":"#fff",fontSize:14,fontWeight:800,cursor:saving||!importable.length?"not-allowed":"pointer"}}>
          {saving ? progress : importable.length ? `Confirm & Import ${importable.length} Month${importable.length>1?"s":""}` : "Nothing to import (all months exist)"}
        </button>
        <button onClick={()=>{ if(saving) return; setImportPreview(null); }} disabled={saving}
          style={{width:"100%",padding:"11px",borderRadius:14,background:"none",border:"1.5px solid #FECACA",color:C.red,fontSize:13,fontWeight:700,cursor:saving?"not-allowed":"pointer",opacity:saving?0.6:1}}>
          Discard
        </button>
      </div>
    </div>
  );
}


// Shared hero header — the app's house style: blue→purple gradient card,
// glassy icon chip, heavy title, quiet subtitle. Used across the "chrome"
// pages so Upload / Analytics / Profile / Settings read as one product.
function PageHero({title, subtitle, icon, from="#1D4ED8", to="#3B82F6"}) {
  return (
    <div style={{background:`linear-gradient(135deg,${from},${to})`,borderRadius:20,padding:"18px 18px",marginBottom:18,display:"flex",alignItems:"center",gap:14,boxShadow:"0 8px 24px rgba(29,78,216,0.25)"}}>
      <div style={{width:46,height:46,borderRadius:14,background:"rgba(255,255,255,0.18)",border:"1px solid rgba(255,255,255,0.25)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
        {icon}
      </div>
      <div style={{minWidth:0}}>
        <div style={{fontSize:19,fontWeight:900,color:"#fff",letterSpacing:"-.4px"}}>{title}</div>
        {subtitle&&<div style={{fontSize:12,color:"rgba(255,255,255,0.85)",marginTop:2}}>{subtitle}</div>}
      </div>
    </div>
  );
}

function UploadPage({user, rosters, onRosterSaved, onReloadRosters, setPage}) {
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [status, setStatus] = useState(null); // null | "success" | "error"
  const [msg, setMsg] = useState("");
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const importRef = useRef(null);

  async function handleCsvFile(f){
    if(!f) return;
    setStatus(null); setMsg("");
    try {
      const text = await f.text();
      const res = parseLogbookCsv(text);
      if(res.error){ setStatus("error"); setMsg(res.error); return; }
      setImportPreview(res);
    } catch(e){ setStatus("error"); setMsg("Could not read file: "+e.message); }
  }

  const [parsedRoster, setParsedRoster] = useState(null); // shows verification screen when set
  const fileRef = useRef();

  function handleFile(f) {
    if(!f) return;
    setFile(f);
    setStatus(null);
    setMsg("");
    setPreview(f.name);
  }

  async function parseRoster() {
    if(!file) { setStatus("error"); setMsg("Select a PDF roster first."); return; }
    setParsing(true); setStatus(null); setMsg("Reading roster...");
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Read failed"));
        r.readAsDataURL(file);
      });

      // -- Extract layout-preserved text using pdf.js -------------------------
      // The browser can load pdf.js from CDN to get text with X/Y positions,
      // which we reconstruct into layout-preserved lines (like pdftotext -layout).
      // This lets us run the deterministic parser entirely client-side for
      // known formats (zero API calls, instant), and send clean layout text
      // to the edge function for unknown formats (much better AI accuracy).
      let layoutText = "";
      let pdfItems = []; // [{x, y, str, page}] normalized visual coordinates
      let roster;
      try {
        setMsg("Reading roster layout...");
        const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs");
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
        const pdfDoc = await pdfjsLib.getDocument({data: Uint8Array.from(atob(base64), c=>c.charCodeAt(0))}).promise;
        const rawItems = [];
        for(let p=1; p<=pdfDoc.numPages; p++){
          const page = await pdfDoc.getPage(p);
          const content = await page.getTextContent();
          const viewport = page.getViewport({scale:1});
          for(const item of content.items){
            if(!item.str?.trim()) continue;
            const tx = pdfjsLib.Util?.transform ? pdfjsLib.Util.transform(viewport.transform, item.transform) : item.transform;
            rawItems.push({x: Math.round(tx[4]), y: Math.round(tx[5]), str: item.str, page: p, width: item.width || 0});
          }
        }

        // ── Orientation normalization ─────────────────────────────────────────
        // Some rosters draw text rotated 90° via the text matrix (not the page
        // /Rotate attribute). pdf.js viewport only corrects /Rotate, so the day
        // strip can end up running vertically in raw coordinates. Try all 8 axis
        // transforms and keep the one where a horizontal day-label strip with an
        // FlD marker row beneath it actually appears.
        const DAY_LBL = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{2}$/;
        function stripScore(items){
          const p1 = items.filter(i=>i.page===1);
          // Scan INSIDE strings: batched items can carry the whole strip in one
          // run ('Mon01 Tue02 ...'), so anchored whole-string tests find nothing.
          const DAY_G = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})/g;
          const labels = [];
          for(const it of p1){
            const pitch = (it.width && it.str.length) ? it.width/it.str.length : 6;
            DAY_G.lastIndex = 0;
            let m;
            while((m = DAY_G.exec(it.str)) !== null){
              labels.push({x: it.x + m.index*pitch, y: it.y, day: parseInt(m[2])});
            }
          }
          if(labels.length < 15) return 0;
          const bands = {};
          labels.forEach(i=>{const b=Math.round(i.y/5)*5;(bands[b]=bands[b]||[]).push(i);});
          let best=[], bestY=0;
          Object.entries(bands).forEach(([b,arr])=>{ if(arr.length>best.length){best=arr;bestY=Number(b);} });
          if(best.length < 15) return 0;
          const xs = best.map(i=>i.x);
          if(Math.max(...xs)-Math.min(...xs) < 200) return 0; // must span horizontally
          // Reject mirrored orientations: day numbers must ascend left-to-right
          const ordered = best.slice().sort((a,b)=>a.x-b.x).map(i=>i.day);
          let asc=0, desc=0;
          for(let k=1;k<ordered.length;k++){ if(ordered[k]>ordered[k-1]) asc++; else desc++; }
          if(asc <= desc) return 0;
          const hasFld = p1.some(i=>/\bFlD\b/.test(i.str) && i.y>bestY && i.y<bestY+60);
          return hasFld ? best.length : 0;
        }
        function transformItems(items, mode){
          // Per-page extents for mirrored transforms
          const ext = {};
          items.forEach(i=>{ const e=ext[i.page]=ext[i.page]||{X:0,Y:0}; if(i.x>e.X)e.X=i.x; if(i.y>e.Y)e.Y=i.y; });
          return items.map(i=>{
            const {X,Y}=ext[i.page];
            let x,y;
            switch(mode){
              case 0: x=i.x;   y=i.y;   break;
              case 1: x=i.x;   y=Y-i.y; break;
              case 2: x=X-i.x; y=i.y;   break;
              case 3: x=X-i.x; y=Y-i.y; break;
              case 4: x=i.y;   y=i.x;   break;
              case 5: x=i.y;   y=X-i.x; break;
              case 6: x=Y-i.y; y=i.x;   break;
              default:x=Y-i.y; y=X-i.x; break;
            }
            return {x, y, str:i.str, page:i.page, width:i.width};
          });
        }
        let bestMode=0, bestScore=stripScore(rawItems);
        for(let m=1;m<8;m++){
          const s=stripScore(transformItems(rawItems,m));
          if(s>bestScore){bestScore=s;bestMode=m;}
        }
        pdfItems = bestMode===0 ? rawItems : transformItems(rawItems,bestMode);
        console.log(`[Upload] Orientation mode ${bestMode}, strip score ${bestScore}`);

        // ── Layout text reconstruction from normalized items ──────────────────
        // Character-cell width is estimated from the median gap between adjacent
        // items on the same line, instead of a hardcoded ratio.
        const pageNums=[...new Set(pdfItems.map(i=>i.page))].sort((a,b)=>a-b);
        const pageTexts=[];
        for(const p of pageNums){
          const byY={};
          pdfItems.filter(i=>i.page===p).forEach(({x,y,str})=>{
            const yKey=Math.round(y/3)*3;
            (byY[yKey]=byY[yKey]||[]).push({x,text:str});
          });
          const sortedYs=Object.keys(byY).map(Number).sort((a,b)=>a-b);
          // Estimate units-per-character from item widths on dense lines
          let unitPerChar=6;
          const samples=[];
          for(const y of sortedYs){
            const line=byY[y].sort((a,b)=>a.x-b.x);
            for(let i2=1;i2<line.length;i2++){
              const prev=line[i2-1];
              const gap=line[i2].x-prev.x;
              if(gap>0 && prev.text.length>0 && gap/prev.text.length<15) samples.push(gap/prev.text.length);
            }
          }
          if(samples.length>10){ samples.sort((a,b)=>a-b); unitPerChar=samples[Math.floor(samples.length/2)]; }
          unitPerChar = Math.min(12, Math.max(3, unitPerChar)); // clamp — bad estimates bloat lines
          const pageLines=[];
          for(const y of sortedYs){
            const line=byY[y].sort((a,b)=>a.x-b.x);
            const maxX=Math.max(...line.map(i=>i.x));
            const lineLen=Math.min(600, Math.ceil(maxX/unitPerChar)+40); // hard cap per line
            const chars=new Array(lineLen).fill(' ');
            for(const {x,text} of line){
              const col=Math.round(x/unitPerChar);
              for(let ci=0;ci<text.length;ci++){
                if(col+ci<chars.length) chars[col+ci]=text[ci];
              }
            }
            pageLines.push(chars.join('').trimEnd());
          }
          pageTexts.push(pageLines.join('\n'));
        }
        layoutText = pageTexts.join('\n\f\n');
      } catch(e) {
        console.warn('[Upload] pdf.js layout extraction failed:', e?.message);
        // Fall back to crude text extraction
        try {
          const bytes = atob(base64);
          const textRuns = [];
          let run = "";
          for(let i=0;i<Math.min(bytes.length,50000);i++){
            const c=bytes.charCodeAt(i);
            if(c>=32&&c<127) run+=bytes[i];
            else if(run.length>3){textRuns.push(run);run="";}
            else run="";
          }
          if(run.length>3) textRuns.push(run);
          layoutText = textRuns.join("\n");
        } catch {}
      }

      const PARSE_URL = `${SUPA_URL}/functions/v1/parse-roster`;
      const token = sb.auth._token || SUPA_ANON;
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "apikey": SUPA_ANON,
      };

      // -- TIER 0a: Exact-coordinate deterministic parse (instant, no API) ----
      // Parses directly from pdf.js positioned items — no text reconstruction,
      // no character-cell drift. Self-validating: returns {_fail:reason} unless
      // every FlD duty day has flights, so it's either provably complete or
      // defers to AI with a logged, specific reason (not a silent guess).
      if(pdfItems.length > 50) {
        setMsg("Parsing roster (deterministic)...");
        try {
          const det = parseNetlineFromItems(pdfItems);
          if(det && det._fail) {
            console.warn('[Upload] Tier 0a declined:', det._fail);
          } else if(det) {
            roster = det;
            setMsg(`✓ Parsed instantly · ${roster.calendar.filter(d=>d.flights?.length>0).length} duty days`);
          } else {
            console.warn('[Upload] Tier 0a returned null with no reason — this should not happen, check for a missed exit point');
          }
        } catch(e) { console.warn('[Upload] Items parser threw:', e?.message, e?.stack); }
      } else {
        console.warn(`[Upload] Tier 0a skipped: only ${pdfItems.length} pdf.js items extracted (need >50)`);
      }

      // -- TIER 0b: Text-based deterministic parse (backup) -------------------
      if(!roster && layoutText.length > 200 && /FlD/.test(layoutText) && /G7\s*\d{3,4}/.test(layoutText)) {
        try {
          const pm = layoutText.match(/Period:\s*0?1(\w{3})(\d{2})/);
          const MONTHS = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
          if(pm) {
            const monthNum = MONTHS[pm[1]] ?? new Date().getMonth();
            const year = 2000 + parseInt(pm[2]);
            const det = parseNetlineGoJet(layoutText, year, monthNum);
            if(det && det.calendar?.filter(d=>d.flights?.length>0).length > 0) {
              roster = det;
              setMsg(`✓ Parsed instantly · Deterministic · ${roster.calendar.filter(d=>d.flights?.length>0).length} duty days`);
            } else {
              console.warn('[Upload] Tier 0b declined: text parser returned no duty days with flights');
            }
          } else {
            console.warn('[Upload] Tier 0b skipped: no "Period:" line matched in layoutText');
          }
        } catch(e) { console.warn('[Upload] Tier 0b threw:', e?.message); }
      } else if(!roster) {
        console.warn(`[Upload] Tier 0b skipped: layoutText.length=${layoutText.length}, has FlD=${/FlD/.test(layoutText)}, has G7=${/G7\s*\d{3,4}/.test(layoutText)}`);
      }

      // -- Fall through to edge function if deterministic parse didn't succeed -
      if(!roster) {
        setMsg("Parsing roster with AI...");
        // Oversized layout text means the reconstruction went wrong (bad glyph
        // spacing estimate) — sending it would poison the AI prompt and blow the
        // server's CPU/time budget. Only send it when it's a sane size.
        const layoutReliable = layoutText.length > 200 && layoutText.length < 60000;
        const firstBody = layoutReliable
          ? { layoutText, pdfBase64: base64, filename: file.name }
          : { pdfBase64: base64, filename: file.name };
        let response = await fetch(PARSE_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(firstBody),
        });
        // Read the server's actual error message instead of showing a bare
        // status code — the edge function returns {error: "..."} JSON.
        async function serverError(res){
          try { const j = await res.json(); if(j?.error) return j; } catch {}
          return { error: `Parse server error: ${res.status}` };
        }
        if(!response.ok) {
          const err = await serverError(response);
          // Rate limited: don't retry — that makes it worse. Tell the user.
          if(response.status === 429 || err.rateLimited) throw new Error(err.error);
          // The server tells us whether IT already spent an internal retry
          // (30-90s we can't see) before returning this failure. If so, a
          // client-side retry here would stack on top of that instead of
          // being a fresh fast attempt — that stacking is exactly what
          // produced 2-3 minute uploads. Only retry when the server confirms
          // this was its first and only attempt.
          if(layoutReliable && !err.serverAlreadyRetried) {
            setMsg("Retrying with full PDF...");
            response = await fetch(PARSE_URL, {
              method: "POST",
              headers,
              body: JSON.stringify({ pdfBase64: base64, filename: file.name }),
            });
            if(!response.ok) {
              const err2 = await serverError(response);
              throw new Error(err2.error);
            }
          } else {
            throw new Error(err.error);
          }
        }
        roster = await response.json();
      }

      // (scanned PDF fallback handled above via pdfBase64 path)

      if(!roster.calendar?.length) throw new Error("No flights found in this roster.");
      // Sanitize carryover from ANY parse path (deterministic, text, AI):
      // an entry with no flights and no duty code is a phantom — usually an
      // AI placeholder emitted to satisfy the "scan for next-month days"
      // instruction. Showing "carryover detected" with nothing in it is
      // strictly worse than showing nothing.
      if(Array.isArray(roster.carryForwardDays)){
        roster.carryForwardDays = roster.carryForwardDays.filter(c=>
          (Array.isArray(c.flights) && c.flights.length>0) || (typeof c.dutyCode==="string" && c.dutyCode));
        if(!roster.carryForwardDays.length) delete roster.carryForwardDays;
      }
      console.log('[Upload] Parsed via', roster._layer||'server-AI', '· carryover:',
        JSON.stringify((roster.carryForwardDays||[]).map(c=>({day:c.day, flights:(c.flights||[]).length, code:c.dutyCode}))));
      // DEFERRED SAVE: nothing touches the database until the pilot taps
      // "Confirm & Save" on the verification screen. Every upload is
      // automatically discarded unless explicitly confirmed.
      if(!roster.id) roster.id = "pending-"+Date.now();
      setStatus("success");
      setMsg(`✓ Parsed ${roster.calendar.filter(d=>(d.flights||[]).length>0).length} duty days for ${roster.periodLabel} — review & confirm below`);
      setFile(null); setPreview(null);
      setParsedRoster(roster); // show post-upload verification screen (unsaved)
    } catch(e) {
      setStatus("error");
      setMsg(e.message||"Parse failed.");
    }
    setParsing(false);
  }

  // -- Layer 1: Deterministic gateway parser (inline, no import needed)
  // ── NetLine/GoJet 3-column format parser ──────────────────────────────────
  // This roster format (used by GoJet/SkyWest via NetLine/Crew) lays out all
  // 30/31 days in THREE side-by-side columns on the same physical lines, making
  // it impossible for an LLM to reliably assign flights to the correct day
  // without explicit column-position math.
  //
  // The FlD (Flight Day) marker row is the definitive off-day oracle:
  //   "Mon01  Tue02  Wed03  Thu04 ..."
  //   "               FlD    FlD  ..."  <- only days with FlD have duty
  //
  // We parse this deterministically (no AI needed) and return a complete
  // roster calendar with 100% accuracy for this format.
  // ── TIER 0a: Inline-label NetLine parser (unified) ─────────────────────────
  // Verified against two real rosters with materially different content flow
  // (June 2026: dense concatenated items; Aug 2023: page-2 continuation,
  // Sby standby days, deadheads on other carriers).
  //
  // Mechanism: every day WITH content prints its own day label a SECOND time
  // inline in the body flow at its block's left margin. Days without content
  // have only the header-strip occurrence. Day attribution = slice everything
  // between consecutive inline labels within the same margin block. This is a
  // direct text signal — no column-width guessing, no fixed rails.
  //
  // Self-validation: returns {_fail:reason} instead of a wrong result.
  function parseNetlineFromItems(items) {
    const DAY_ANY = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})/g;
    const DAY_START = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})/;
    const MONTHS = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const HEADER_WORDS = new Set(["date","duty","dep","arr","info","AC","Hot","Rep","Crew","H"]);
    // Any 2-char carrier (G7/UA/AA...), optional DH/ prefix, optional AC type
    // (deadhead rows omit it). \s* throughout: pdf.js may concatenate items.
    const FLIGHT_SRC = '(DH\\s*\\/?\\s*)?([A-Z][A-Z0-9])\\s*(\\d{2,4})(?:\\s*\\/\\s*\\d+)?\\s*([A-Z]{3})\\s*!?\\s*(\\d{4})(?:\\s*\\(?\\+1\\)?)?\\s*!?\\s*(\\d{4})(?:\\s*\\(?\\+1\\)?)?\\s*([A-Z]{3})(?:\\s*(CR[0-9J]|E[0-9]{2}|[A-Z][0-9]{2}[A-Z]?))?';

    const joined = items.map(i=>i.str).join(' ');
    if(!/FlD/.test(joined) && !/Sby|RP\d/.test(joined)) return {_fail:"no FlD/Sby markers anywhere — not a NetLine duty plan"};
    const pm = joined.match(/Period:\s*0?1\s*([A-Z][a-z]{2})\s*(\d{2})/);
    if(!pm || MONTHS[pm[1]]===undefined) return {_fail:"Period: line not found or month unrecognized"};
    const monthNum = MONTHS[pm[1]];
    const year = 2000 + parseInt(pm[2]);

    function charPitch(it){ return (it.width && it.str.length) ? it.width/it.str.length : 6; }

    // Day-of-week checksum: every label prints dow+day ('Tue01'). For a given
    // day number, the main month and the next month almost always yield
    // different weekdays — so the dow tells us directly whether 'Tue01' is
    // this month's day 1 or next month's (carryover), with no ordering
    // heuristics. Signal is void only when the month lengths align the
    // weekdays (28-day February → March), where we fall back to heuristics.
    const DOW3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dimNext = new Date(year, monthNum+2, 0).getDate();
    function labelSide(dow, d){
      const mainDow = (d>=1 && d<=31) ? DOW3[new Date(year, monthNum, d).getDay()] : null;
      const nextDow = (d>=1 && d<=dimNext) ? DOW3[new Date(year, monthNum+1, d).getDay()] : null;
      if(mainDow && mainDow===nextDow) return null;
      if(dow===mainDow) return 'main';
      if(dow===nextDow) return 'carry';
      return null;
    }

    // ── Per page: header strip (majority day-label y-band) → duty markers;
    //    every other day-label occurrence = inline body label ────────────────
    const dayMarker = {};   // day -> 'FlD' | code (main month)
    const carryMarker = {}; // same, after a day-number reset in the strip
    const carryDayNums = new Set(); // every strip day AFTER the reset, marker or not
    const inline = [];      // {pg,x,y,day,rest}
    const pages = [...new Set(items.map(i=>i.page))].sort((a,b)=>a-b);

    for(const pg of pages){
      const pi = items.filter(i=>i.page===pg);
      const hits = [];
      for(const it of pi){
        DAY_ANY.lastIndex = 0;
        let m;
        while((m = DAY_ANY.exec(it.str)) !== null){
          hits.push({x: it.x + m.index*charPitch(it), y: it.y, day: parseInt(m[2]), dow: m[1], rest: it.str.slice(m.index + m[0].length)});
        }
      }
      if(!hits.length) continue;
      const bands = {};
      hits.forEach(h=>{const b=Math.round(h.y/5)*5;(bands[b]=bands[b]||[]).push(h);});
      let stripY = null, stripArr = [];
      Object.entries(bands).forEach(([b,arr])=>{ if(arr.length>stripArr.length){stripArr=arr;stripY=Number(b);} });

      if(stripArr.length >= 10){
        const strip = [...stripArr].sort((a,b)=>a.x-b.x);
        const markerRow = pi.filter(i=>i.y>stripY && i.y<stripY+15);
        // Scan INSIDE marker-row strings: batched items can carry several
        // markers in one run ('FlD FlD FlD Sby Sby') — anchored whole-string
        // matching misses all of them. Offset each token's x via char pitch.
        const MARKER_G = /\b([A-Z][a-zA-Z0-9]{1,4})\b/g;
        const markerHits = [];
        for(const mi of markerRow){
          MARKER_G.lastIndex = 0;
          let mm;
          while((mm = MARKER_G.exec(mi.str)) !== null){
            const s = mm[1];
            if(DAY_START.test(s) || HEADER_WORDS.has(s)) continue;
            markerHits.push({x: mi.x + mm.index*charPitch(mi), str: s});
          }
        }
        let prev = 0, inCarry = false;
        for(const h of strip){
          if(!inCarry && prev>=20 && h.day<prev && h.day<=14) inCarry = true;
          prev = h.day;
          const side = labelSide(h.dow, h.day);
          const isC = side==='carry' || (side!=='main' && inCarry);
          if(isC){ inCarry = true; carryDayNums.add(h.day); }
          const near = markerHits.filter(mh=>Math.abs(mh.x-h.x)<15);
          if(near.length){
            const mk = near.sort((a,b)=>Math.abs(a.x-h.x)-Math.abs(b.x-h.x))[0].str;
            // Some months print an explicit 'Off' marker where others leave
            // the cell blank — it means off day, never a duty code.
            if(mk !== 'Off'){
              const tgt = isC ? carryMarker : dayMarker;
              if(tgt[h.day]===undefined) tgt[h.day]=mk;
            }
          }
        }
        for(const h of hits) if(Math.abs(h.y-stripY)>10) inline.push({pg, x:h.x, y:h.y, day:h.day, dow:h.dow, rest:h.rest});
      } else {
        for(const h of hits) inline.push({pg, x:h.x, y:h.y, day:h.day, dow:h.dow, rest:h.rest});
      }
    }

    if(Object.keys(dayMarker).length===0) return {_fail:"header strip yielded no day markers (FlD/codes)"};
    if(!inline.length) return {_fail:"no inline day labels found in body — cannot attribute content"};

    // ── Slice content between consecutive inline labels per margin block ─────
    const dayText = {}, carryText = {};
    const bodyCode = {}, carryBodyCode = {}; // dutyCode printed only in the body (e.g. 'RP2 ORD 0800 2000')
    const FLIGHT_RE = new RegExp(FLIGHT_SRC); // non-global, for gate tests
    const CODE_ROW = /^\s*([A-Z][A-Z0-9]{1,4})\s+[A-Z]{3}\s*!?\s*\d{4}/;
    for(const pg of pages){
      const pl = inline.filter(l=>l.pg===pg).sort((a,b)=>a.x-b.x);
      if(!pl.length) continue;
      // Cluster inline-label x into margin blocks; tag each label with its block
      const margins = [];
      for(const l of pl){
        if(margins.length && l.x - margins[margins.length-1].max < 40){
          margins[margins.length-1].max = l.x;
          margins[margins.length-1].labels.push(l);
        } else {
          margins.push({min:l.x, max:l.x, labels:[l]});
        }
      }
      const pi = items.filter(i=>i.page===pg);
      const pageRight = Math.max(...pi.map(i=>i.x)) + 30;
      margins.forEach((mg, bi)=>{
        const lo = mg.min, hi = bi+1<margins.length ? margins[bi+1].min-8 : pageRight;
        const blk = [...mg.labels].sort((a,b)=>a.y-b.y);
        // Day-number reset is tracked PER BLOCK: blocks are internally
        // chronological (top→bottom), but cross-block/cross-page iteration
        // order is layout order, not calendar order — a global flag gets
        // corrupted by page-2 crew manifests and page-2 main-month
        // continuations. Local state can't.
        let blkPrev = 0, blkReset = false;
        blk.forEach((l, k)=>{
          const nextY = k+1<blk.length ? blk[k+1].y : l.y+400;
          const seg = pi.filter(i=>i.x>=lo-40 && i.x<hi && i.y>=l.y && i.y<nextY)
                        .sort((a,b)=>(a.y-b.y)||(a.x-b.x));
          const text = (l.rest ? l.rest+' ' : '') + seg.map(i=>i.str).join(' ');
          // Relevance gate BEFORE any bookkeeping: a slice with no C/I or C/O,
          // no flight row, and no dutyCode pattern is not roster content —
          // it's a crew-manifest date, hotel line, or footer. Skipping it here
          // keeps phantom labels from poisoning the reset sequence or
          // creating duplicate day buckets.
          const relevant = /C\/[IO]/.test(text) || FLIGHT_RE.test(text) || CODE_ROW.test(text);
          if(!relevant) return;
          if(!blkReset && blkPrev>=20 && l.day<blkPrev && l.day<=14) blkReset = true;
          blkPrev = l.day;
          // Routing: the dow checksum is authoritative. 'Tue01' when this
          // month's day 1 is a Saturday can ONLY be next month's day 1.
          // Heuristics (block reset, strip carry set) apply only when the
          // dow signal is void or unrecognized.
          const side = labelSide(l.dow, l.day);
          const isCarry = side==='carry'
            || (side!=='main' && (blkReset
                || (carryDayNums.has(l.day) && (dayText[l.day] !== undefined || !dayMarker[l.day]))));
          const bucket = isCarry ? carryText : dayText;
          if(!bucket[l.day]) bucket[l.day] = [];
          bucket[l.day].push(text);
          // Body-only duty code (ported from the AI prompt rules): a slice
          // with no C/I and no flights that starts with CODE + station + time
          // is a non-flying duty day whose code was printed only in the body.
          if(!/C\/I/.test(text) && !FLIGHT_RE.test(text)){
            const bc = text.match(CODE_ROW);
            if(bc && !DAY_START.test(bc[1]) && !HEADER_WORDS.has(bc[1]))
              (isCarry ? carryBodyCode : bodyCode)[l.day] = bc[1];
          }
        });
      });
    }

    function extractFlights(texts){
      const t = (texts||[]).join(' ');
      const rx = new RegExp(FLIGHT_SRC, 'g');
      const out = [], seen = new Set();
      let m;
      while((m = rx.exec(t)) !== null){
        const key = m[2]+m[3]+m[4]+m[5];
        if(seen.has(key)) continue;
        seen.add(key);
        out.push({
          flightNum: `${m[2]} ${m[3]}`, dep: m[4],
          depTime: `${m[5].slice(0,2)}:${m[5].slice(2)}`,
          arr: m[7], arrTime: `${m[6].slice(0,2)}:${m[6].slice(2)}`,
          acType: m[8] || "", schedBlockMins: null, isDeadhead: !!m[1],
        });
      }
      return out;
    }

    const flightsByDay = {};
    for(const d of Object.keys(dayText).map(Number)){
      const fl = extractFlights(dayText[d]);
      if(fl.length) flightsByDay[d] = fl;
    }

    // ── Midnight relocation: legs departing 00:00–05:59 after an evening duty
    //    start belong on the departure DATE (day+1), including past month-end
    //    into carryover. Conservative triggers only. ──────────────────────────
    const mins = s => { const p = s.split(':'); return parseInt(p[0])*60 + parseInt(p[1]); };
    const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dim = new Date(year, monthNum+1, 0).getDate();
    const donors = new Set(), relocTargets = new Set();
    const overflowCarry = [];
    Object.keys(flightsByDay).map(Number).sort((a,b)=>a-b).forEach(d=>{
      const fl = flightsByDay[d];
      const txt = (dayText[d]||[]).join(' ');
      const cim = txt.match(/C\/I\s*!?\s*[A-Z]{3}\s*!?\s*(\d{4})/);
      let clock = cim ? parseInt(cim[1].slice(0,2))*60 + parseInt(cim[1].slice(2)) : null;
      let wrapped = false;
      const stay = [], go = [];
      for(const f of fl){
        const dm = mins(f.depTime), am = mins(f.arrTime);
        if(!wrapped && clock!==null && dm < 360 && (clock - dm) > 360) wrapped = true;
        (wrapped ? go : stay).push(f);
        if(am < dm) wrapped = true; // leg crossed midnight → subsequent legs next day
        clock = am;
      }
      if(go.length){
        flightsByDay[d] = stay;
        if(!stay.length) donors.add(d);
        const target = d + 1;
        if(target <= dim){
          const existing = flightsByDay[target] || [];
          const exKeys = new Set(existing.map(f=>f.flightNum+f.dep+f.depTime));
          const incoming = go.filter(f=>!exKeys.has(f.flightNum+f.dep+f.depTime));
          // Relocated legs departed 00:00–05:59 — chronologically the EARLIEST
          // events of the target day, so they go at the FRONT of its flight
          // list, ahead of the day's own later duty.
          flightsByDay[target] = [...incoming, ...existing];
          relocTargets.add(target);
        } else {
          const nd = new Date(year, monthNum+1, 1);
          overflowCarry.push({day:1, dow:DOW[nd.getDay()], isOff:false, dutyCode:null, flights:go});
        }
      }
    });

    // ── Calendar ──────────────────────────────────────────────────────────────
    const calendar = [];
    for(let d=1; d<=dim; d++){
      const dow = DOW[new Date(year, monthNum, d).getDay()];
      const mk = dayMarker[d] || bodyCode[d]; // strip authoritative; body code fills gaps
      const fl = flightsByDay[d] || [];
      if(mk === 'FlD' || fl.length){
        calendar.push({day:d, dow, isOff:false, dutyCode:null, flights:fl});
      } else if(mk){
        calendar.push({day:d, dow, isOff:false, dutyCode:mk, flights:fl});
      } else {
        calendar.push({day:d, dow, isOff:true, dutyCode:null, flights:[]});
      }
    }

    // ── SELF-VALIDATION: provably complete or defer with a reason ────────────
    for(const d of Object.keys(dayMarker).map(Number)){
      if(dayMarker[d]!=='FlD') continue;
      const day = calendar.find(c=>c.day===d);
      if((!day || day.flights.length===0) && !donors.has(d))
        return {_fail:`FlD duty day ${d} produced zero flights — column text: ${JSON.stringify((dayText[d]||[]).slice(0,2))}`};
    }
    for(const day of calendar){
      if(day.isOff && dayText[day.day] && /C\/I/.test((dayText[day.day]||[]).join(' ')))
        return {_fail:`day ${day.day} marked off but its block contains C/I — unrecognized duty day`};
      if(day.isOff===false && !dayMarker[day.day] && day.flights.length && !relocTargets.has(day.day))
        return {_fail:`flights extracted for day ${day.day} which has no duty marker — possible misattribution: ${JSON.stringify(day.flights.map(f=>f.flightNum))}`};
    }

    // ── Carryover days: UNION of strip-detected markers and body-detected
    //    slices. The old code iterated only carryMarker (strip) keys, so
    //    carry flights found in the body without a matching strip marker
    //    were silently dropped — the "carryover days show no flights" bug. ────
    const carryForwardDays = [];
    const carryDaysAll = new Set([
      ...Object.keys(carryMarker).map(Number),
      ...Object.keys(carryText).map(Number),
    ]);
    for(const d of [...carryDaysAll].sort((a,b)=>a-b)){
      const mk = carryMarker[d] || carryBodyCode[d] || null;
      // Only slices containing a real duty block (C/I or C/O) contribute
      // flights — crew-manifest and hotel-section slices legitimately carry
      // next-month date labels, and must not inject their table rows.
      const fl = extractFlights((carryText[d]||[]).filter(t=>/C\/[IO]/.test(t)));
      if(mk==='FlD' && fl.length===0)
        return {_fail:`carryover duty day ${d} produced zero flights — carry text: ${JSON.stringify((carryText[d]||[]).slice(0,2))}`};
      if(!fl.length && !mk) continue; // nothing real on this carry day
      carryForwardDays.push({day:d, dow:DOW[new Date(year, monthNum+1, d).getDay()], isOff:false, dutyCode:(mk && mk!=='FlD')?mk:null, flights:fl});
    }
    // Merge midnight-relocation overflow (post-midnight legs past month end)
    for(const oc of overflowCarry){
      const ex = carryForwardDays.find(c=>c.day===oc.day);
      if(ex){
        const seen = new Set(ex.flights.map(f=>f.flightNum+f.dep+f.depTime));
        const incoming = oc.flights.filter(f=>!seen.has(f.flightNum+f.dep+f.depTime));
        // Overflow legs departed just after midnight — chronologically FIRST
        // on the carry day, before the day's own duty block.
        ex.flights = [...incoming, ...ex.flights];
      } else {
        carryForwardDays.push(oc);
      }
    }
    carryForwardDays.sort((a,b)=>a.day-b.day);

    const MF = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return {
      year, monthNum, periodLabel: `${MF[monthNum]} ${year}`, calendar,
      ...(carryForwardDays.length ? {carryForwardDays} : {}),
      _layer: 'netline_inline', uploadedAt: new Date().toISOString(),
    };
  }

  function parseNetlineGoJet(layoutText, year, monthNum) {
    const lines = layoutText.split('\n');
    const DOW   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const DAY_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})\b/g;
    const FLIGHT_PAT = /G7\s+(\d{3,4})(?:\s*\/\d+)?\s+([A-Z]{3})\s+[!]?(\d{4})\s+[!]?(\d{4})\s+([A-Z]{3})\s+(\w{2,5})/g;

    // Step 1: Find the day-header line and FlD line
    let dayHeaderLine = null, fldLine = null;
    for(let i=0;i<lines.length;i++){
      if(/Mon01/.test(lines[i]) && /Tue02/.test(lines[i]) && /Wed03/.test(lines[i])){
        dayHeaderLine = lines[i];
        for(let j=i+1;j<Math.min(i+5,lines.length);j++){
          if(/FlD/.test(lines[j])){ fldLine=lines[j]; break; }
        }
        break;
      }
    }
    if(!dayHeaderLine || !fldLine) return null; // not this format

    // Step 2: Which days have FlD?
    const dutyDays = new Set();
    const dayPositions = {}; // daynum -> char position in header
    let m;
    const drx = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})\b/g;
    while((m=drx.exec(dayHeaderLine))!==null){
      const pos=m.index, daynum=parseInt(m[2]);
      dayPositions[daynum]=pos;
      const win=fldLine.slice(Math.max(0,pos-3),pos+9);
      if(/FlD/.test(win)) dutyDays.add(daynum);
    }
    if(dutyDays.size===0) return null; // FlD strip not found

    // Step 3: Determine column boundaries from header positions
    // Days sort by char position; big gaps mark column splits
    const sortedByPos = Object.entries(dayPositions)
      .map(([d,p])=>({d:parseInt(d),p}))
      .sort((a,b)=>a.p-b.p);
    const gaps = [];
    for(let i=0;i<sortedByPos.length-1;i++){
      const diff=sortedByPos[i+1].p - sortedByPos[i].p;
      if(diff>30) gaps.push({pos:sortedByPos[i+1].p, after:sortedByPos[i].d});
    }
    // Two biggest gaps = column boundaries (left|center, center|right)
    const splitPositions = gaps.sort((a,b)=>b.pos-a.pos).slice(0,2)
      .map(g=>g.pos).sort((a,b)=>a-b);
    const C1E = splitPositions[0] || 80;
    const C2E = splitPositions[1] || 160;

    // Step 4: Find body start (line after "date  H  duty..." header)
    let bodyStart=0;
    for(let i=0;i<lines.length;i++){
      if(/^date\s+H\s+duty/.test(lines[i])){ bodyStart=i+1; break; }
    }

    // Step 5: Walk body lines, track current day per column, collect text
    const colCurrent = [null, null, null];
    const dayTexts = {}; // daynum -> string[]

    for(const line of lines.slice(bodyStart)){
      // Detect day label appearances and assign to a column
      const drx2 = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(\d{2})\b/g;
      let dm;
      while((dm=drx2.exec(line))!==null){
        const pos=dm.index, daynum=parseInt(dm[2]);
        const col = pos<C1E ? 0 : pos<C2E ? 1 : 2;
        colCurrent[col]=daynum;
        if(!dayTexts[daynum]) dayTexts[daynum]=[];
      }
      // Assign segments to current days
      const bounds=[[0,C1E],[C1E,C2E],[C2E,10000]];
      bounds.forEach(([lo,hi],ci)=>{
        if(colCurrent[ci]!==null){
          const seg=line.slice(lo,Math.min(hi,line.length));
          if(seg.trim()){ 
            const dn=colCurrent[ci];
            if(!dayTexts[dn]) dayTexts[dn]=[];
            dayTexts[dn].push(seg);
          }
        }
      });
    }

    // Step 6: Build calendar
    const daysInMonth = new Date(year, monthNum+1, 0).getDate();
    const calendar = [];

    for(let d=1;d<=daysInMonth;d++){
      const dt=new Date(year,monthNum,d);
      const dow=DOW[dt.getDay()];

      if(!dutyDays.has(d)){
        calendar.push({day:d,dow,isOff:true,dutyCode:null,flights:[]});
        continue;
      }

      // Extract flights from this day's collected text
      const allText=(dayTexts[d]||[]).join('\n');
      const flights=[];
      const seen=new Set();
      const fp=/G7\s+(\d{3,4})(?:\s*\/\d+)?\s+([A-Z]{3})\s+[!]?(\d{4})\s+[!]?(\d{4})\s+([A-Z]{3})\s+(\w{2,5})/g;
      let fm;
      while((fm=fp.exec(allText))!==null){
        const key=`G7${fm[1]}${fm[2]}${fm[5]}`;
        if(seen.has(key)) continue;
        seen.add(key);
        const dt2=fm[3], at2=fm[4];
        flights.push({
          flightNum:`G7 ${fm[1]}`,
          dep:fm[2], depTime:`${dt2.slice(0,2)}:${dt2.slice(2)}`,
          arr:fm[5], arrTime:`${at2.slice(0,2)}:${at2.slice(2)}`,
          acType:fm[6], schedBlockMins:null, isDeadhead:false,
        });
      }

      calendar.push({day:d,dow,isOff:flights.length===0,dutyCode:null,flights});
    }

    const dutyCount = calendar.filter(d=>d.flights.length>0).length;
    return {
      year, monthNum,
      periodLabel:`${['January','February','March','April','May','June','July','August','September','October','November','December'][monthNum]} ${year}`,
      calendar,
      _layer:'netline',
      uploadedAt:new Date().toISOString(),
      _meta:{dutyDays:dutyCount, totalFlights:calendar.reduce((a,d)=>a+d.flights.length,0)},
    };
  }

  function parseRosterLayer1(rawText, filename) {
    const FLIGHT_RE = /\b([A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])\s*(\d{1,4})\b/;
    const COMBINED_DATE_RE = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{1,2}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{1,2}/i;
    const CI_CO_RE = /\bC\/[IO]\b/i;
    const BLOCK_RE = /(?:(?:\[FT\s*|BLK\s*)(\d{1,2})[+:](\d{2})(?:\])?|(\d{1,2})[+:](\d{2})\s*(?:BLK|FT|\]|$))/i;
    // Duty code detection -- matches any 2-5 letter all-caps code that:
    //   - is NOT a known 3-letter airport IATA code in AIRPORT_COORDS
    //   - is NOT the start of an airline+flight-number pattern (e.g. "UA", "G7", "AA")
    // This catches airline-specific codes like LCR, TVL, SIM, VGS, GRD, TRN,
    // RSV, HOL, VAC, SCK, etc. without needing to maintain an exhaustive list.
    // A code is treated as a duty code when it appears as the FIRST token on a
    // line that has no recognizable flight number elsewhere on the same line.
    const KNOWN_AIRPORTS = new Set(Object.keys(AIRPORT_COORDS));
    const AIRLINE_PREFIX_RE = /^([A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])\d{1,4}[A-Z]?$/;
    function isDutyCode(word, line) {
      if(!/^[A-Z]{2,5}$/.test(word)) return false;        // must be 2-5 caps letters only
      if(KNOWN_AIRPORTS.has(word)) return false;           // airport code, not duty
      if(AIRLINE_PREFIX_RE.test(word)) return false;       // looks like a flight number
      if(FLIGHT_RE.test(line)) return false;               // line has a real flight number
      return true;
    }
    const AC_RE = /\b(B73[78H]|B737|B738|B739|B74[78]|B767|B772|B78[789]|A31[89]|A32[01]|A319|A220|A333|A350|A380|CR[79]|CRJ|CR7|CR9|CRJ7|CRJ9|E7[05]|E170|E175|E190|ERJ|DH8|ATR)\b/i;

    const lines = rawText.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const flights=[], partial=[], failed=[], reasons=[], dutyDays=[];
    let confidence=0.85, skipTimes=false, currentDate=null;

    for(const line of lines){
      if(COMBINED_DATE_RE.test(line)){
        failed.push(line);
        if(!reasons.includes("combined_date_header")) reasons.push("combined_date_header");
        continue;
      }
      if(CI_CO_RE.test(line)){skipTimes=true;continue;}

      const fmatch=line.match(FLIGHT_RE);
      if(!fmatch){skipTimes=false;continue;}

      const words=line.split(/\s+/);
      if(words.length>=1&&isDutyCode(words[0], line)){
        dutyDays.push({code:words[0],date:currentDate});
        skipTimes=false;continue;
      }

      // Deadhead detection — pilot rides as passenger, doesn't operate the
      // flight. Commonly marked "DH/UA1234", "DH/G7 4522", "DHD UA1234",
      // or a standalone "DH" token immediately before the flight number.
      // Format varies by airline, so we match any of these patterns.
      const DEADHEAD_RE = /\bDH\/?D?\s*(?=[A-Z]{1,2}[0-9]|\d)/i;
      const isDeadhead = DEADHEAD_RE.test(line);

      const airports=[...line.replace(FLIGHT_RE,"").replace(AC_RE,"").matchAll(/(?<![0-9A-Z])([A-Z]{3})(?![A-Z0-9])/g)]
        .map(m=>m[1]).filter(c=>!/^(BLK|FLT|FDP|ETD|ETA|UTC|LCL|REG|DHD)$/.test(c)).slice(0,2);
      if(airports.length<2){failed.push(line);if(!reasons.includes("missing_airports"))reasons.push("missing_airports");continue;}

      const times=skipTimes?[]:([...line.matchAll(/!?(\d{2}):?(\d{2})/g)].map(m=>`${m[1]}:${m[2]}`).filter(t=>{const[h,m]=t.split(":").map(Number);return h<=23&&m<=59;}));
      const blockMatch=line.match(BLOCK_RE);
      const blockMins=blockMatch?((parseInt(blockMatch[1]||blockMatch[3]||"0")*60)+parseInt(blockMatch[2]||blockMatch[4]||"0")):null;
      const acMatch=line.match(AC_RE);

      const f={
        flightNum:`${fmatch[1]} ${fmatch[2]}`,
        dep:airports[0],arr:airports[1],
        depTime:times[0]||null,arrTime:times[1]||null,
        blockMins,acType:acMatch?acMatch[1].toUpperCase():null,
        date:currentDate,raw:line,
        confidence:1.0,failureReason:null,
        isDeadhead,
      };

      if(!f.depTime||!f.arrTime){f.confidence=0.65;f.failureReason="missing_times";}
      if(!f.blockMins){f.confidence=Math.min(f.confidence,0.88);f.failureReason=f.failureReason||"block_time_missing";}

      if(f.confidence>=0.9) flights.push(f);
      else{partial.push(f);failed.push(line);if(!reasons.includes(f.failureReason))reasons.push(f.failureReason);}
      skipTimes=false;
    }

    const total=flights.length+partial.length;
    const finalConf=total>0?Math.min(1.0,confidence*(flights.length/total)):0.2;
    const roster=finalConf>=0.9&&flights.length>0?buildL1Roster(flights,dutyDays):null;
    return{confidence:Math.round(finalConf*100)/100,flights,partialFlights:partial,failedSegments:failed,failureReasons:reasons,dutyDays,roster,dateContext:currentDate};
  }

  function buildL1Roster(flights, dutyDays){
    const byDay={};
    for(const f of flights){
      const d=f.date?new Date(f.date):null;
      const day=d&&!isNaN(d)?d.getDate():0;
      if(!byDay[day])byDay[day]=[];
      byDay[day].push({flightNum:f.flightNum,dep:f.dep,depTime:f.depTime,arr:f.arr,arrTime:f.arrTime,acType:f.acType,schedBlockMins:f.blockMins,isDeadhead:!!f.isDeadhead});
    }
    const calendar=Object.entries(byDay).map(([day,fs])=>{
      const d=new Date();d.setDate(parseInt(day));
      return{day:parseInt(day),dow:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()],isOff:false,dutyCode:null,flights:fs};
    }).sort((a,b)=>a.day-b.day);
    return{id:Date.now().toString(),periodLabel:"",year:new Date().getFullYear(),monthNum:new Date().getMonth(),calendar,_layer:1,uploadedAt:new Date().toISOString()};
  }

  function mergeGatewayResults(l1Result, l2Result){
    // L1 clean flights + L2 resolved flights merged into one calendar
    const l1Roster = l1Result.roster || {calendar:[]};
    const l2Calendar = l2Result.flights
      ? l2Result.flights.map(f=>({
          day:f.duty_date?new Date(f.duty_date).getDate():0,
          dow:"Mon",isOff:false,dutyCode:f.duty_code||null,
          flights:f.duty_code?[]:[{flightNum:f.flight_number,dep:f.departure_code,depTime:f.departure_time,arr:f.arrival_code,arrTime:f.arrival_time,acType:f.aircraft_type,schedBlockMins:f.block_time_mins}],
        }))
      : (l2Result.calendar||[]);
    const merged=[...l1Roster.calendar];
    for(const l2day of l2Calendar){
      if(!merged.find(d=>d.day===l2day.day)) merged.push(l2day);
    }
    return{...l1Roster,...l2Result,calendar:merged.sort((a,b)=>a.day-b.day),_layer:"1+2"};
  }

  // -- Logbook CSV import preview -----------------------------------------
  if(importPreview) return(
    <ImportLogbookPreview
      preview={importPreview} rosters={rosters} user={user}
      onReloadRosters={onReloadRosters} setImportPreview={setImportPreview}
      setStatus={setStatus} setMsg={setMsg}
    />
  );

  // -- Post-upload verification screen -----------------------------------
  // Shown immediately after a successful parse, before the user navigates
  // away. Lets them sanity-check what was extracted, then either go verify
  // & sign in Active Logs, or upload another roster.
  if(parsedRoster) return(
    <PostUploadVerifyScreen
      parsedRoster={parsedRoster} rosters={rosters} user={user}
      onRosterSaved={onRosterSaved} onReloadRosters={onReloadRosters}
      setParsedRoster={setParsedRoster}
      setStatus={setStatus} setMsg={setMsg} setPage={setPage}
    />
  );

  return (
    <div style={{flex:1,overflowY:"auto",background:"#F8FAFC"}}>
      <div style={{padding:16,maxWidth:560}}>
        <PageHero title="Upload Roster" subtitle="Monthly roster PDF · logbook CSV import" icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 15v2a3 3 0 003 3h10a3 3 0 003-3v-2" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>}/>

        {/* Upload box */}
        <div
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);handleFile(e.dataTransfer.files[0]);}}
          onClick={()=>fileRef.current?.click()}
          style={{
            border:`2px dashed ${drag?"#1D4ED8":file?"#1D4ED8":"#E2E8F0"}`,
            borderRadius:20,padding:"36px 20px",textAlign:"center",cursor:"pointer",
            background:drag?C.blueBg:file?C.greenBg:C.surface,
            transition:"all .2s",marginBottom:16,
          }}
        >
          <input ref={fileRef} type="file" accept=".pdf" style={{display:"none"}} onChange={e=>handleFile(e.target.files?.[0])}/>
          <div style={{marginBottom:14,display:"flex",justifyContent:"center"}}>
            {file?(
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#1D4ED8" strokeWidth="1.8" strokeLinejoin="round"/><path d="M14 2v6h6" stroke="#1D4ED8" strokeWidth="1.8" strokeLinejoin="round"/><path d="M9 13h6M9 17h4" stroke="#1D4ED8" strokeWidth="1.8" strokeLinecap="round"/></svg>
            ):(
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M7 18a4.5 4.5 0 01-.5-8.98A5.5 5.5 0 0117 8a4 4 0 01-.5 8H7z" stroke="#94A3B8" strokeWidth="1.8" strokeLinejoin="round"/><path d="M12 12v6M9.5 15.5L12 13l2.5 2.5" stroke="#94A3B8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            )}
          </div>
          {file?(
            <>
              <div style={{fontSize:15,fontWeight:700,color:"#1D4ED8",marginBottom:4}}>{file.name}</div>
              <div style={{fontSize:12,color:"#64748B"}}>{(file.size/1024).toFixed(1)} KB · Tap to change</div>
            </>
          ):(
            <>
              <div style={{fontSize:15,fontWeight:700,color:"#0F172A",marginBottom:6}}>Drop your roster PDF here</div>
              <div style={{fontSize:13,color:"#64748B",lineHeight:1.5}}>or tap to browse · Any airline format</div>
            </>
          )}
        </div>

        {/* Status */}
        {status&&(
          <div style={{marginBottom:16,padding:"12px 14px",borderRadius:10,background:status==="success"?C.greenBg:C.redBg,border:`1px solid ${status==="success"?C.greenBdr:C.redBdr}`,fontSize:13,color:status==="success"?"#059669":"#DC2626",fontWeight:500}}>
            {msg}
          </div>
        )}

        {/* Parse button */}
        <button
          onClick={parseRoster}
          disabled={!file||parsing}
          style={{
            width:"100%",padding:"15px",borderRadius:14,
            background:!file||parsing?"#F1F5F9":"#0D9488",
            border:"none",color:!file||parsing?"#94A3B8":"#fff",
            fontSize:15,fontWeight:700,cursor:!file||parsing?"not-allowed":"pointer",
            marginBottom:20,transition:"all .15s",
          }}
        >
          {parsing?(
            <span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <span className="spinner">⟳</span> Uploading...
            </span>
          ):"Upload Roster →"}
        </button>

        {/* Logbook CSV import */}
        <div style={{display:"flex",alignItems:"center",gap:10,margin:"2px 0 14px"}}>
          <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
          <span style={{fontSize:11,color:"#94A3B8",fontWeight:700}}>OR</span>
          <div style={{flex:1,height:1,background:"#E2E8F0"}}/>
        </div>
        <div onClick={()=>importRef.current?.click()}
          style={{border:`1.5px solid ${C.blueBdr}`,borderRadius:16,padding:"14px 16px",background:C.blueBg,cursor:"pointer",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
          <input ref={importRef} type="file" accept=".csv,.tsv,.txt" style={{display:"none"}} onChange={e=>{handleCsvFile(e.target.files?.[0]); e.target.value="";}}/>
          <div style={{flexShrink:0}}><svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M4 19.5V4.5a2 2 0 012-2h13v17H6a2 2 0 00-2 2z" stroke="#7C3AED" strokeWidth="1.8" strokeLinejoin="round"/><path d="M4 19.5a2 2 0 002 2h13" stroke="#7C3AED" strokeWidth="1.8" strokeLinejoin="round"/><path d="M8 7h8M8 10.5h8" stroke="#7C3AED" strokeWidth="1.8" strokeLinecap="round"/></svg></div>
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:800,color:"#5B21B6"}}>Import Logbook History (CSV)</div>
            <div style={{fontSize:11.5,color:"#3B82F6",lineHeight:1.45}}>ForeFlight · LogTen Pro · MyFlightbook · ASA / Jeppesen exports</div>
          </div>
          <div style={{fontSize:18,color:"#3B82F6"}}>→</div>
        </div>

        {/* Info */}
        <div style={{background:"#F1F5F9",borderRadius:12,padding:"14px 16px",border:"1px solid #E2E8F0"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0F172A",marginBottom:8}}>How it works</div>
          {[
            [<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 16V4M12 4l-4 4M12 4l4 4" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 15v2a3 3 0 003 3h10a3 3 0 003-3v-2" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round"/></svg>,"Upload your monthly PDF roster from any airline"],
            [<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4" y="7" width="16" height="12" rx="2" stroke="#7C3AED" strokeWidth="2"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/></svg>,"AI reads every flight leg, time, and airport"],
            [<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,"Tail numbers sync via FlightAware within 15 min of landing"],
          ].map(([icon,text])=>(
            <div key={text} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:8}}>
              <span style={{flexShrink:0,marginTop:1}}>{icon}</span>
              <span style={{fontSize:13,color:"#64748B",lineHeight:1.5}}>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActiveLogsPage({user, rosters, tails, onRosterUpdated, onTailSaved, onDeleteRoster}) {
  const S = getS();
  const now = new Date();
  const [verifyModal, setVerifyModal] = useState(null);
  const [editEdits, setEditEdits] = useState({});
  const [auditLog, setAuditLog] = useState([]);
  const [signing, setSigning] = useState(false);
  const [signedMonths, setSignedMonths] = useState(()=>{
    try { return JSON.parse(localStorage.getItem("fl_signed_months")||"{}"); } catch { return {}; }
  });
  const [auditVisible, setAuditVisible] = useState(false);
  const [drillRoster, setDrillRoster] = useState(null); // month detail view
  const [drillFlight, setDrillFlight] = useState(null); // flight detail view
  // -- Verification confirmation. Each month now gets its own independent
  // VerifyModal instance (see signMonth) -- no more shared tab state, since
  // there's genuinely only ever one roster being reviewed/signed at a time.
  const [currentConfirmed, setCurrentConfirmed] = useState(false);
  // Bulk PIC/SIC selection inside VerifyModal -- lets a pilot select many
  // flights at once and classify them all with a single tap, rather than
  // opening each flight's own Flight Details form individually.
  const [bulkSelected, setBulkSelected] = useState(()=>new Set());
  const [applyingBulk, setApplyingBulk] = useState(false);

  // Find the next-month roster that may have been auto-created as a
  // carryover stub when this roster was uploaded (see db_saveRoster's
  // carry-forward logic). Only treated as "needs separate verification"
  // if it actually has flight data and isn't already signed.
  function findNextMonthCarryover(r){
    if(!r) return null;
    const mNum=r.monthNum??r.month_num??0;
    const nextMonth = mNum===11?0:mNum+1;
    const nextYear  = mNum===11?r.year+1:r.year;
    const next = rosters.find(rr=>(rr.monthNum??rr.month_num??0)===nextMonth&&rr.year===nextYear);
    if(!next) return null;
    if(signedMonths[next.id]) return null; // already signed, nothing to verify
    const hasFlights = (next.calendar||[]).some(d=>(d.flights||[]).length>0);
    return hasFlights ? next : null;
  }

  function openVerify(r){
    setVerifyModal(r);
    setCurrentConfirmed(false);
    setEditEdits({});
    setAuditLog([]);
  }

  // -- Classify rosters
  const classified = useMemo(()=>{
    const active=[], needsVerify=[], verified=[];
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      const rDate=new Date(r.year,mNum,1);
      const isSigned=!!signedMonths[r.id];
      if(isSigned){ verified.push({r,mNum,isSigned}); continue; }
      // Is this month in the past?
      const isPast=r.year<now.getFullYear()||(r.year===now.getFullYear()&&mNum<now.getMonth());
      const totalFlights=(r.calendar||[]).reduce((a,d)=>a+(d.flights||[]).filter(f=>!f.isDeadhead).length,0);
      const syncedCount=Object.keys(tails).filter(tk=>tk.startsWith(r.id)&&tails[tk]?.tail).length;
      const syncPct=totalFlights>0?Math.round(syncedCount/totalFlights*100):0;
      if(isPast||syncPct>=90){ needsVerify.push({r,mNum,totalFlights,syncedCount,syncPct}); }
      else { active.push({r,mNum,totalFlights,syncedCount,syncPct}); }
    }
    return{active,needsVerify,verified};
  },[rosters,tails,signedMonths]);

  const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
  const MON3=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function monthLabel(r,mNum){ return `${MON3[mNum].toUpperCase()} ${r.year}`; }

  // Compares the original tail/flight data against a draft edits object and
  // produces audit log entries ONLY for fields that actually differ -- this
  // is the single point where audit entries are created, called once at
  // sign-time rather than on every keystroke or blur.
  function buildAuditDiff(roster, edits){
    const entries=[];
    for(const [tk,ed] of Object.entries(edits)){
      const t = tails[tk] || {};
      const parts=tk.split("-");
      const di=parseInt(parts[parts.length-2]);
      const fi=parseInt(parts[parts.length-1]);
      const f = roster?.calendar?.[di]?.flights?.[fi];
      if(!f) continue;
      if(ed.tail!=null && String(ed.tail)!==String(t.tail||"")){
        entries.push({id:Date.now()+Math.random(),ts:new Date().toISOString(),tk,field:"tail",oldVal:String(t.tail||"--"),newVal:String(ed.tail||"--"),userId:user?.email});
      }
      if(ed.actualBlockMins!=null && ed.actualBlockMins!==t.actualBlockMins){
        entries.push({id:Date.now()+Math.random(),ts:new Date().toISOString(),tk,field:"actualBlockMins",oldVal:String(t.actualBlockMins??"--"),newVal:String(ed.actualBlockMins),userId:user?.email});
      }
      if(ed.acType!=null && String(ed.acType)!==String(f.acType||"")){
        entries.push({id:Date.now()+Math.random(),ts:new Date().toISOString(),tk,field:"acType",oldVal:String(f.acType||"--"),newVal:String(ed.acType||"--"),userId:user?.email});
      }
      if(ed.picSic!=null){
        const oldClassification = f.loggedPicMins>0?"PIC":(f.loggedSicMins>0?"SIC":"--");
        if(ed.picSic!==oldClassification){
          entries.push({id:Date.now()+Math.random(),ts:new Date().toISOString(),tk,field:"picSic",oldVal:oldClassification,newVal:ed.picSic,userId:user?.email});
        }
      }
    }
    return entries;
  }

  // Applies a draft edits object to one roster + its tail_logs, persists
  // both, and returns the audit entries that were actually recorded.
  // Applies a draft edits object to one roster + its tail_logs, persists
  // both, and returns the audit entries that were actually recorded, plus
  // any audit-server-write error so the caller can surface it -- a silent
  // console.warn was invisible to anyone not actively watching dev tools,
  // which made a genuine write failure indistinguishable from "there were
  // no edits to log" from the pilot's (and admin's) point of view.
  async function applyAndSignRoster(roster, edits){
    const mNum = roster.monthNum??roster.month_num??0;
    const auditEntries = buildAuditDiff(roster, edits);
    const nc=[...(roster.calendar||[])];
    for(const [tk,ed] of Object.entries(edits)){
      const parts=tk.split("-");
      const di=parseInt(parts[parts.length-2]);
      const fi=parseInt(parts[parts.length-1]);
      if(nc[di]&&nc[di].flights[fi]){
        if(ed.acType!=null) nc[di]={...nc[di],flights:nc[di].flights.map((f,i)=>i===fi?{...f,acType:ed.acType}:f)};
        if(ed.picSic!=null){
          const flightForBlock = nc[di].flights[fi];
          const tForBlock = tails[tk]||{};
          const blockForClassification = (ed.actualBlockMins!=null?ed.actualBlockMins:tForBlock.actualBlockMins) ?? schedMins(flightForBlock) ?? 0;
          nc[di]={...nc[di],flights:nc[di].flights.map((f,i)=>i===fi?{
            ...f,
            loggedPicMins: ed.picSic==="PIC" ? blockForClassification : 0,
            loggedSicMins: ed.picSic==="SIC" ? blockForClassification : 0,
          }:f)};
        }
      }
      const tailUpdate={};
      if(ed.tail!=null) tailUpdate.tail=ed.tail;
      if(ed.actualBlockMins!=null) tailUpdate.actualBlockMins=ed.actualBlockMins;
      if(Object.keys(tailUpdate).length){
        await db_saveTail(user.id,tk,tailUpdate);
        onTailSaved(tk,{...(tails[tk]||{}),...tailUpdate});
      }
    }
    await db_saveRoster(user.id,{...roster,calendar:nc,signed:true,signedAt:new Date().toISOString()},{skipMergeProtection:true});
    onRosterUpdated(roster.id,nc);
    const newSigned={...signedMonths,[roster.id]:{at:new Date().toISOString(),userId:user?.id}};
    setSignedMonths(newSigned);
    localStorage.setItem("fl_signed_months",JSON.stringify(newSigned));
    let auditServerError=null;
    if(auditEntries.length){
      const auditKey=`fl_audit_${roster.id}`;
      const existing=JSON.parse(localStorage.getItem(auditKey)||"[]");
      localStorage.setItem(auditKey,JSON.stringify([...auditEntries,...existing]));
      // Also write server-side (audit_log table) so an admin can review any
      // pilot's edit history -- localStorage alone is only ever visible on
      // the pilot's own device, which is what made admin audit access
      // impossible before this table existed. Best-effort: a failure here
      // shouldn't block the sign itself, since the pilot's own localStorage
      // copy (already written above) is the record they see immediately.
      try {
        const {error} = await sb.from("audit_log").insert(auditEntries.map(e=>({
          user_id: user.id, roster_id: roster.id, flight_key: e.tk,
          field: e.field, old_value: e.oldVal, new_value: e.newVal,
          signed_at: e.ts,
        })));
        if(error) throw new Error(error.message||JSON.stringify(error));
      } catch(e) {
        auditServerError = e?.message || String(e);
        console.warn("audit_log server write failed (non-fatal):", auditServerError);
      }
    }
    return {auditEntries, auditServerError};
  }

  // -- Sign month
  async function signMonth(){
    if(!verifyModal) return;
    const r=verifyModal;

    // Each month is now its own independent sign event -- gated ONLY on
    // this month's own confirmation, never on a carryover month that
    // belongs to a completely separate roster/modal.
    if(!currentConfirmed){ return; }

    setSigning(true);
    try {
      const {auditEntries:currentAudit, auditServerError} = await applyAndSignRoster(r, editEdits);
      setAuditLog(currentAudit);
      // Feed the dashboard bell: one event per manually edited flight
      Object.entries(editEdits||{}).forEach(([tk,ed])=>{
        const fields=Object.keys(ed||{}).filter(k=>!k.startsWith("_"));
        if(!fields.length) return;
        const parts=tk.split("-"); const fi=+parts.pop(); const di=+parts.pop();
        const f=r.calendar?.[di]?.flights?.[fi];
        logNotifEvent({type:"edit",id:`edit-${tk}-${Date.now()}`,
          label:`${f?.flightNum||"Flight"} manually edited`,
          sub:`${fields.join(", ")} updated during verification`});
      });
      setEditEdits({});
      setCurrentConfirmed(false);

      // If this month had carryover days, they were already routed into
      // next month's own roster by db_saveRoster's carry logic -- open
      // THAT roster as its own separate, fresh modal now, rather than
      // switching a tab inside the modal that's about to close. The pilot
      // sees this month's sign complete, then a genuinely distinct
      // verification window for the carryover month.
      const nextMonthRoster = findNextMonthCarryover(r);
      if(nextMonthRoster){
        setVerifyModal(nextMonthRoster);
      } else {
        setVerifyModal(null);
      }
      if(auditServerError){
        // Sign itself succeeded -- this alert fires after, so the pilot
        // isn't blocked, but the actual Postgres/RLS error is now visible
        // instead of only reaching a browser console nobody may be
        // watching. This is precisely the failure mode that made "signed
        // successfully but nothing shows in the admin audit log" silent
        // and undiagnosable before.
        alert(`Signed successfully, but the audit record could not be saved to the server (it's still recorded locally): ${auditServerError}`);
      }
    } catch(e){ alert(e.message); }
    setSigning(false);
  }

  // -- Status card colors
  const AMBER=S.amber; const AMBER_BG=S.amberBg; const AMBER_BORDER=S.amberBdr;
  const BLUE=S.blue; const BLUE_BG=S.blueBg; const BLUE_BORDER=S.blueBdr;
  const GREEN=S.green; const GREEN_BG=S.greenBg; const GREEN_BORDER=S.greenBdr;

  // -- Verify Modal
  function VerifyModal(){
    if(!verifyModal) return null;
    const r=verifyModal;
    const mNum=r.monthNum??r.month_num??0;
    // Still detect carryover for the header's informational note, but it no
    // longer drives a tab switcher or a combined confirm/sign gate -- it's
    // purely "heads up, a second modal for next month will open after you
    // sign this one."
    const nextMonthRoster = findNextMonthCarryover(r);
    const hasCarryover = !!nextMonthRoster;

    const allRows=[];
    (r?.calendar||[]).forEach((d,di)=>{
      (d.flights||[]).forEach((f,fi)=>{
        const tk=`${r.id}-${di}-${fi}`;
        const t=tails[tk]||{};
        const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
        allRows.push({f,d,di,fi,tk,t,dateStr});
      });
    });
    allRows.sort((a,b)=>a.dateStr.localeCompare(b.dateStr)||(a.f.depTime||"").localeCompare(b.f.depTime||""));
    const totalBlock=allRows.reduce((acc,{tk,f})=>{
      const ed=editEdits[tk];
      const mins=ed?.actualBlockMins!=null?ed.actualBlockMins:(tails[tk]?.actualBlockMins??schedMins(f)??0);
      return acc+mins;
    },0);

    return(
      <div style={{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"flex-start",justifyContent:"center",background:"rgba(0,0,0,0.5)",backdropFilter:"blur(4px)",overflowY:"auto",padding:"24px 16px"}}>
        <div style={{background:S.surface,borderRadius:24,width:"100%",maxWidth:840,boxShadow:"0 32px 80px rgba(0,0,0,0.2)",overflow:"hidden",marginBottom:24}}>
          {/* Modal header */}
          <div style={{background:"linear-gradient(135deg,#1D4ED8,#3B82F6)",padding:"24px 28px",color:"#fff"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:"rgba(255,255,255,0.7)",marginBottom:6}}>Verification Required</div>
                <h2 style={{fontSize:24,fontWeight:900,margin:0,letterSpacing:"-0.5px"}}>{MONTHS[mNum]} {r.year} Flight Log</h2>
                <p style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:6}}>
                  {hasCarryover
                    ? "Review and sign this month first. A separate window for the carried-over days will open next."
                    : "Review all flights, make corrections, then sign to lock this record permanently."}
                </p>
              </div>
              <button onClick={()=>{setVerifyModal(null);setEditEdits({});setAuditLog([]);setCurrentConfirmed(false);}} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",width:36,height:36,borderRadius:"50%",cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>×</button>
            </div>

            {/* Summary pills */}
            <div style={{display:"flex",gap:12,marginTop:18,flexWrap:"wrap"}}>
              {[
                [`${allRows.length}`,`Total Legs`],
                [fmtMins(totalBlock),`Total Block`],
                [`${allRows.filter(({tk})=>tails[tk]?.tail||editEdits[tk]?.tail).length}/${allRows.length}`,`Synced`],
              ].map(([val,lbl])=>(
                <div key={lbl} style={{background:"rgba(255,255,255,0.15)",backdropFilter:"blur(8px)",padding:"8px 16px",borderRadius:100,border:"1px solid rgba(255,255,255,0.2)"}}>
                  <span style={{fontSize:16,fontWeight:800,color:"#fff"}}>{val}</span>
                  <span style={{fontSize:11,color:"rgba(255,255,255,0.7)",marginLeft:6}}>{lbl}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Bulk PIC/SIC classification bar -- appears once at least one
              flight is selected below. Writes into the same editEdits
              object every other field edit here uses, so it's picked up
              by the existing buildAuditDiff/applyAndSignRoster path at
              sign-time with zero separate persistence logic needed. */}
          {bulkSelected.size>0&&(
            <div style={{padding:"10px 20px",background:`${S.blue}10`,borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <span style={{fontSize:12,fontWeight:700,color:S.ink}}>{bulkSelected.size} selected</span>
              <div style={{display:"flex",gap:6}}>
                {["PIC","SIC"].map(cls=>(
                  <button key={cls} disabled={applyingBulk} onClick={()=>{
                    setApplyingBulk(true);
                    setEditEdits(prev=>{
                      const next={...prev};
                      bulkSelected.forEach(tk=>{ next[tk]={...next[tk], picSic:cls}; });
                      return next;
                    });
                    setApplyingBulk(false);
                  }} style={{padding:"6px 14px",borderRadius:8,border:`1.5px solid ${S.blue}`,background:S.blue,color:"#fff",fontSize:12,fontWeight:700,cursor:applyingBulk?"not-allowed":"pointer"}}>
                    Mark as {cls}
                  </button>
                ))}
              </div>
              <button onClick={()=>setBulkSelected(new Set())} style={{padding:"6px 12px",borderRadius:8,border:"none",background:"none",color:S.muted,fontSize:12,fontWeight:600,cursor:"pointer"}}>Clear selection</button>
            </div>
          )}

          {/* Flight table */}
          <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead style={{position:"sticky",top:0,zIndex:1}}>
                <tr style={{background:S.panel}}>
                  <th style={{padding:"10px 14px",borderBottom:`1px solid ${S.border}`,width:1}}>
                    <input type="checkbox"
                      checked={allRows.length>0 && bulkSelected.size===allRows.length}
                      onChange={e=>setBulkSelected(e.target.checked ? new Set(allRows.map(row=>row.tk)) : new Set())}
                      style={{cursor:"pointer"}}/>
                  </th>
                  {["Date","Flight","Route","Sched Block","Actual Block","Tail #","Equipment","Status"].map(h=>(
                    <th key={h} style={{padding:"10px 14px",textAlign:"left",fontSize:10,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",whiteSpace:"nowrap",borderBottom:`1px solid ${S.border}`}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allRows.map(({f,tk,t,dateStr},idx)=>{
                  const ed=editEdits[tk]||{};
                  const dispTail=ed.tail!==undefined?ed.tail:t.tail||"";
                  const dispActBlockMins=ed.actualBlockMins!==undefined?ed.actualBlockMins:t.actualBlockMins;
                  const dispAcType=ed.acType!==undefined?ed.acType:f.acType||"";
                  const schedMinsVal=schedMins(f)||0;
                  const synced=!!(dispTail);
                  const isMod=Object.keys(ed).length>0;
                  const isSelected=bulkSelected.has(tk);
                  return(
                    <tr key={tk} style={{borderBottom:`1px solid ${S.border}`,background:isSelected?`${S.blue}10`:isMod?"rgba(245,243,255,0.5)":idx%2===0?S.surface:"rgba(248,250,252,0.4)"}}>
                      <td style={{padding:"11px 14px"}}>
                        <input type="checkbox" checked={isSelected} onChange={e=>{
                          setBulkSelected(prev=>{
                            const next=new Set(prev);
                            if(e.target.checked) next.add(tk); else next.delete(tk);
                            return next;
                          });
                        }} style={{cursor:"pointer"}}/>
                      </td>
                      <td style={{padding:"11px 14px",color:S.ink,fontWeight:600,whiteSpace:"nowrap"}}>{dateStr}</td>
                      <td style={{padding:"11px 14px",color:S.silver}}>{f.flightNum}</td>
                      <td style={{padding:"11px 14px",fontWeight:700,color:S.ink}}>{f.dep}→{f.arr}</td>
                      <td style={{padding:"11px 14px",color:S.muted,fontFamily:"monospace"}}>{schedMinsVal?fmtMins(schedMinsVal):"--"}</td>
                      {/* Editable actual block -- uncontrolled, same reasoning
                          as tail/acType below: typing shouldn't touch shared
                          editEdits state (and re-render every row in the
                          table) until the field is actually done being
                          edited. Previously this used a controlled value +
                          a _blockRaw draft field that itself lived in
                          shared state, which caused the same per-keystroke
                          re-render this whole change is meant to avoid. */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder={schedMinsVal?fmtMins(schedMinsVal):"--"}
                          defaultValue={dispActBlockMins!=null?fmtMins(dispActBlockMins):""}
                          key={`${tk}-block-${dispActBlockMins}`}
                          onFocus={e=>e.target.select()}
                          onChange={e=>{ e.target.value = e.target.value.replace(/[^0-9:]/g,""); }}
                          onBlur={e=>{
                            const raw=e.target.value;
                            if(!raw) return;
                            const [hh,mm]=raw.split(":").map(Number);
                            const mins=isNaN(hh)?null:(hh*60+(mm||0));
                            if(mins!=null && mins!==dispActBlockMins){
                              // Audit logging deferred to sign-time (see
                              // buildAuditDiff in signMonth) -- editing a
                              // field no longer writes an audit entry per
                              // keystroke or even per blur; it's only
                              // recorded once, when Verify & Sign is
                              // actually clicked, and only for fields that
                              // truly differ from their original value.
                              setEditEdits(p=>({...p,[tk]:{...p[tk],actualBlockMins:mins}}));
                            }
                          }}
                          style={{width:64,padding:"5px 8px",borderRadius:7,border:`1px solid ${isMod&&dispActBlockMins!=null?C.blueBdr:S.border}`,fontSize:12,fontFamily:"monospace",background:isMod&&dispActBlockMins!=null?C.blueBg:S.surface,color:S.ink,outline:"none"}}
                        />
                      </td>
                      {/* Editable tail -- uncontrolled (defaultValue) so
                          typing doesn't touch shared editEdits state on
                          every keystroke; the whole verify table would
                          otherwise re-render on every character typed in
                          any row. Committed to editEdits only on blur. */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder="N#####"
                          defaultValue={dispTail}
                          key={`${tk}-tail-${dispTail}`}
                          onChange={e=>{ e.target.value = e.target.value.toUpperCase().slice(0,8); }}
                          onBlur={e=>{
                            const val=e.target.value;
                            if(val===dispTail) return; // no real change, skip a needless state update
                            setEditEdits(p=>({...p,[tk]:{...p[tk],tail:val}}));
                          }}
                          style={{width:76,padding:"5px 8px",borderRadius:7,border:`1px solid ${dispTail?C.greenBdr:S.border}`,fontSize:12,fontFamily:"monospace",background:dispTail?C.greenBg:S.surface,color:S.ink,outline:"none"}}
                        />
                      </td>
                      {/* Editable equipment -- same uncontrolled pattern */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder="CRJ7"
                          defaultValue={dispAcType}
                          key={`${tk}-acType-${dispAcType}`}
                          onChange={e=>{ e.target.value = e.target.value.toUpperCase().slice(0,6); }}
                          onBlur={e=>{
                            const val=e.target.value;
                            if(val===dispAcType) return;
                            setEditEdits(p=>({...p,[tk]:{...p[tk],acType:val}}));
                          }}
                          style={{width:60,padding:"5px 8px",borderRadius:7,border:`1px solid ${S.border}`,fontSize:12,fontFamily:"monospace",background:S.surface,color:S.ink,outline:"none"}}
                        />
                      </td>
                      <td style={{padding:"11px 14px"}}>
                        {synced?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:100,background:GREEN_BG,color:GREEN,fontSize:11,fontWeight:700}}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Synced
                          </span>
                        ):(
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:100,background:AMBER_BG,color:AMBER,fontSize:11,fontWeight:700}}>
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill={AMBER}/></svg>
                            Pending
                          </span>
                        )}
                        {isMod&&<span style={{marginLeft:4,fontSize:10,fontWeight:700,color:"#3B82F6",background:C.blueBg,padding:"2px 6px",borderRadius:100}}>Edited</span>}
                        {ed.picSic&&<span style={{marginLeft:4,fontSize:10,fontWeight:700,color:S.blue,background:`${S.blue}18`,padding:"2px 6px",borderRadius:100}}>{ed.picSic}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Audit log */}
          {auditLog.length>0&&(
            <div style={{borderTop:`1px solid ${S.border}`,background:S.panel}}>
              <button onClick={()=>setAuditVisible(p=>!p)} style={{width:"100%",padding:"12px 20px",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",color:S.ink,fontSize:13,fontWeight:600}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round"/></svg>
                  <span style={{color:"#3B82F6"}}>Audit Log</span>
                  <span style={{background:"#3B82F6",color:"#fff",fontSize:10,fontWeight:800,padding:"1px 7px",borderRadius:100}}>{auditLog.length}</span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{transform:auditVisible?"rotate(180deg)":"none",transition:"transform .2s"}}><path d="M6 9l6 6 6-6" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              {auditVisible&&(
                <div style={{padding:"0 20px 16px",maxHeight:180,overflowY:"auto"}}>
                  <table style={{width:"100%",fontSize:12,borderCollapse:"collapse"}}>
                    <thead><tr>{["Time","Field","Original","Changed to","User"].map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",fontSize:10,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".4px",borderBottom:`1px solid ${S.border}`}}>{h}</th>)}</tr></thead>
                    <tbody>
                      {auditLog.map(entry=>(
                        <tr key={entry.id} style={{borderBottom:`1px solid ${S.border}`}}>
                          <td style={{padding:"7px 10px",color:S.muted,fontFamily:"monospace",fontSize:11}}>{new Date(entry.ts).toLocaleTimeString()}</td>
                          <td style={{padding:"7px 10px",color:"#3B82F6",fontWeight:600}}>{entry.field}</td>
                          <td style={{padding:"7px 10px",color:C.red,fontFamily:"monospace",textDecoration:"line-through",opacity:.7}}>{entry.oldVal}</td>
                          <td style={{padding:"7px 10px",color:C.green,fontFamily:"monospace",fontWeight:600}}>{entry.newVal}</td>
                          <td style={{padding:"7px 10px",color:S.muted,fontSize:11}}>{entry.userId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Confirmation checkbox */}
          <div style={{padding:"16px 28px 0",background:S.surface}}>
            <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer",padding:"12px 14px",borderRadius:12,background:currentConfirmed?C.greenBg:S.panel,border:`1px solid ${currentConfirmed?C.greenBdr:S.border}`}}>
              <input
                type="checkbox"
                checked={currentConfirmed}
                onChange={e=>setCurrentConfirmed(e.target.checked)}
                style={{marginTop:2,width:16,height:16,accentColor:"#059669",cursor:"pointer",flexShrink:0}}
              />
              <span style={{fontSize:12,color:currentConfirmed?"#065F46":S.ink,lineHeight:1.5}}>
                I confirm the {MONTHS[mNum]} {r?.year} flight data above is accurate and ready to sign.
              </span>
            </label>
          </div>

          {/* Modal footer */}
          <div style={{padding:"20px 28px",borderTop:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",background:S.surface}}>
            <div style={{fontSize:12,color:S.muted,lineHeight:1.6,maxWidth:400}}>
              By signing, you certify this record is accurate and complete under{" "}
              <strong style={{color:S.ink}}>14 CFR §61.51</strong>.
              {hasCarryover&&(
                <div style={{marginTop:6,color:S.muted}}>
                  A separate window for {MONTHS[(mNum===11?0:mNum+1)]} {mNum===11?r.year+1:r.year} (carryover) will open once this month is signed.
                </div>
              )}
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setVerifyModal(null);setEditEdits({});setAuditLog([]);setCurrentConfirmed(false);}} style={{padding:"11px 22px",borderRadius:12,background:"none",border:`1.5px solid ${S.border}`,color:S.silver,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                Cancel
              </button>
              <button onClick={signMonth} disabled={signing||!currentConfirmed} style={{padding:"11px 28px",borderRadius:12,background:(signing||!currentConfirmed)?"#94A3B8":"linear-gradient(135deg,#1D4ED8,#3B82F6)",border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:(signing||!currentConfirmed)?"not-allowed":"pointer",boxShadow:currentConfirmed?"0 4px 16px rgba(29,78,216,0.3)":"none",display:"flex",alignItems:"center",gap:8}}>
                {signing?(
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{animation:"spin 1s linear infinite"}}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/></svg>Signing...</>
                ):(
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>Sign & Lock Record</>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // -- Main render
  // Flight detail drill-down
  if(drillFlight){
    const {f,day,roster,di,fi,tk,tail,dateStr}=drillFlight;
    return <FlightDetailPage
      flight={f} tail={tail||{}} solar={computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr)}
      dist={calcDist(f.dep,f.arr)} blockMins={(tail?.actualBlockMins)??schedMins(f)??0}
      day={day} roster={roster} hasActual={!!(tail?.actualDep||tail?.actualArr||tail?.tail)}
      dep={f.dep} arr={f.arr} isXC={(calcDist(f.dep,f.arr)||0)>50}
      onBack={()=>setDrillFlight(null)}
      onAutoLookup={async()=>{try{const res=await fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f?.flightNum,date:dateStr,dep:f?.dep,arr:f?.arr,depTime:f?.depTime,forceRefresh:true})});if(!res.ok){const e2=await res.text();throw new Error(`Sync failed: ${res.status} ${e2.slice(0,100)}`);};const d=await res.json();if(d.tail||d.actualDep){const u={...tail,...d};onTailSaved(tk,u);setDrillFlight(p=>({...p,tail:{...p.tail,...u},hasActual:true}));}}catch(e){alert(e.message);}}}
      onForceResync={()=>{}} lkStatus={null} lkError={null} onResetLimit={()=>{}}
      tmp="" onTmpChange={()=>{}}
      onSaveTail={async(val)=>{const parts=tk.split("-");const rosterId=parts.slice(0,-2).join("-");const fk=parts.slice(-2).join("-");await db_saveTail(user.id,rosterId,fk,val||"");onTailSaved(tk,{...(tail||{}),tail:val});setDrillFlight(p=>({...p,tail:{...p.tail,tail:val}}));}}
      saving={false} onTailSaved={async(v)=>{
        const parts=tk.split("-");
        const rosterId3=parts.slice(0,-2).join("-");
        const fk3=parts.slice(-2).join("-");
        try{
          await db_saveTail(user.id,rosterId3,fk3,v);
          onTailSaved(tk,v);
          setDrillFlight(p=>({...p,tail:{...p.tail,...v},hasActual:true}));
        }catch(e){alert(e.message);}
      }}
      editingTimes={false} setEditingTimes={()=>{}} timeEdits={{}} setTimeEdits={()=>{}}
      onSaveFlightFields={async(fields)=>{
        const nc = await saveFlightFieldsToRoster(user.id, roster, di, fi, fields);
        onRosterUpdated(roster.id, nc);
        setDrillFlight(p=>({...p, f:{...p.f, ...fields}}));
      }}
      onDeleteFlight={async()=>{
        const nc = await deleteFlightFromRoster(user.id, roster, di, fi);
        onRosterUpdated(roster.id, nc);
        setDrillFlight(null);
      }}
      di={di} fi={fi} userId={user?.id}
    />;
  }

  // Month detail drill-down
  if(drillRoster){
    const r=drillRoster;
    const mNum=r.monthNum??r.month_num??0;
    const MONTHS_FULL=["January","February","March","April","May","June","July","August","September","October","November","December"];
    const isSigned=!!signedMonths[r.id];
    const allRows=[];
    (r.calendar||[]).forEach((d,di)=>{(d.flights||[]).forEach((f,fi)=>{
      if(f.isDeadhead) return; // deadheads are informational only -- never shown in Active Logs or any logbook view
      const tk=`${r.id}-${di}-${fi}`;
      const t=tails[tk]||{};
      const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
      allRows.push({f,d,di,fi,tk,t,dateStr});
    });});
    allRows.sort((a,b)=>a.dateStr.localeCompare(b.dateStr)||(a.f.depTime||"").localeCompare(b.f.depTime||""));
    const totalBlock=allRows.reduce((acc,{tk,f})=>acc+((tails[tk]?.actualBlockMins)??schedMins(f)??0),0);
    return(
      <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
        <VerifyModal/>
        <div style={{padding:"14px 18px",background:S.surface,borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10,backdropFilter:"blur(12px)"}}>
          <button onClick={()=>setDrillRoster(null)} style={{width:36,height:36,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke={S.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div style={{flex:1}}>
            <div style={{fontSize:18,fontWeight:800,color:S.ink}}>{MONTHS_FULL[mNum]} {r.year}</div>
            <div style={{fontSize:12,color:S.muted,marginTop:1}}>{allRows.length} flights · {fmtMins(totalBlock)} total block · {isSigned?"✓ Signed":"Not verified"}</div>
          </div>
          {isSigned&&<span style={{fontSize:11,fontWeight:700,color:"#2563EB",background:C.blueBg,padding:"4px 10px",borderRadius:100,border:"1px solid #BFDBFE",flexShrink:0,marginRight:8}}>🔒 Verified</span>}
          {!isSigned&&onDeleteRoster&&(
            <button
              onClick={async()=>{
                if(!window.confirm(`Delete the ${MONTHS_FULL[mNum]} ${r.year} roster? This removes all ${allRows.length} flights and cannot be undone.`)) return;
                try{
                  await onDeleteRoster(r.id);
                  setDrillRoster(null);
                }catch(e){alert(e.message||"Failed to delete roster.");}
              }}
              title="Delete this roster"
              style={{width:36,height:36,borderRadius:"50%",background:C.redBg,border:"1px solid #FECACA",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          )}
        </div>
        <div style={{padding:"16px 16px 80px"}}>
          <button onClick={()=>openVerify(r)} style={{width:"100%",padding:"13px",borderRadius:14,background:isSigned?"none":`linear-gradient(135deg,${S.blue},#3B82F6)`,border:isSigned?`1.5px solid ${S.border}`:"none",color:isSigned?S.muted:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:16,boxShadow:isSigned?"none":`0 4px 16px ${S.blue}30`}}>
            {isSigned?"✏️ Edit signed record (tracked in audit log)":"Verify & Sign this month"}
          </button>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {allRows.map(({f,d,di,fi,tk,t,dateStr})=>{
              const synced=!!t.tail; const bm=t.actualBlockMins??schedMins(f)??0;
              return(
                <div key={tk} onClick={()=>setDrillFlight({f,day:d,roster:r,di,fi,tk,tail:t,dateStr})}
                  style={{background:S.surface,borderRadius:16,padding:"14px 16px",border:`1px solid ${synced?C.greenBdr:S.border}`,display:"flex",alignItems:"center",gap:14,cursor:"pointer"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=C.blueBdr}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=synced?C.greenBdr:S.border}
                >
                  <div style={{width:4,height:44,borderRadius:2,background:synced?"#10B981":S.border,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:800,color:S.ink}}>{f.flightNum}</div>
                    <div style={{fontSize:12,color:S.muted,marginTop:2}}>{dateStr} · {f.dep}→{f.arr} · {f.depTime||"--"}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:S.ink}}>{bm?fmtMins(bm):"--"}</div>
                    {t.tail?<div style={{fontSize:11,color:C.green,fontFamily:"monospace",marginTop:2}}>{t.tail}</div>:<div style={{fontSize:11,color:S.muted,marginTop:2}}>Pending</div>}
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{opacity:.3,flexShrink:0}}><path d="M9 18l6-6-6-6" stroke={S.purple} strokeWidth="2.5" strokeLinecap="round"/></svg>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return(
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      <VerifyModal/>

      {/* Header */}
      <div style={{padding:"20px 24px",background:S.surface,borderBottom:`1px solid ${S.border}`,position:"sticky",top:0,zIndex:10,backdropFilter:"blur(12px)"}}>
        <h1 style={{fontSize:22,fontWeight:800,color:S.ink,margin:0,letterSpacing:"-.5px"}}>Active Logs</h1>
        <p style={{fontSize:13,color:S.muted,margin:"3px 0 0"}}>Review, verify and sign your monthly flight records · <strong style={{color:S.ink}}>14 CFR §61.51 compliant</strong></p>
      </div>

      <div style={{padding:"20px 24px",display:"flex",flexDirection:"column",gap:24}}>

        {/* -- Active Months -- */}
        {classified.active.length>0&&(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:GREEN,boxShadow:`0 0 0 3px ${GREEN_BG}`}}/>
              <h2 style={{fontSize:14,fontWeight:700,color:S.ink,margin:0,textTransform:"uppercase",letterSpacing:"1px"}}>Active -- Auto Syncing</h2>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
              {classified.active.map(({r,mNum,totalFlights,syncedCount,syncPct})=>(
                <div key={r.id} onClick={()=>setDrillRoster(r)} style={{background:S.surface,borderRadius:20,border:`1.5px solid ${GREEN_BORDER}`,padding:"20px 22px",boxShadow:"0 2px 12px rgba(5,150,105,0.08)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(5,150,105,0.15)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(5,150,105,0.08)"}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:14,marginBottom:16}}>
                    <div style={{width:52,height:52,borderRadius:16,background:GREEN_BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:16,fontWeight:800,color:S.ink,letterSpacing:"-.3px"}}>{monthLabel(r,mNum)} BLOCK</div>
                      <div style={{fontSize:12,color:GREEN,fontWeight:700,marginTop:3,display:"flex",alignItems:"center",gap:5}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:GREEN,display:"inline-block",animation:"pulse 1.5s infinite"}}/>
                        Currently Active · Auto Syncing
                      </div>
                    </div>
                  </div>
                  {/* Sync progress */}
                  <div style={{marginBottom:6,display:"flex",justifyContent:"space-between",fontSize:12,color:S.muted,fontWeight:600}}>
                    <span>Sync Progress</span>
                    <span style={{color:GREEN,fontWeight:700}}>{syncedCount}/{totalFlights} flights</span>
                  </div>
                  <div style={{height:6,background:S.panel,borderRadius:100,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${syncPct}%`,background:`linear-gradient(90deg,${GREEN},#34D399)`,borderRadius:100,transition:"width .5s"}}/>
                  </div>
                  <div style={{fontSize:11,color:S.muted,marginTop:6,marginBottom:14}}>{syncPct}% · Updates within 15 min of landing</div>
                  {/* Early verification option */}
                  <div style={{background:GREEN_BG,border:`1px solid ${GREEN_BORDER}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke={GREEN} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span style={{fontSize:12,fontWeight:600,color:"#065F46"}}>Early verification available</span>
                    </div>
                    <button
                      onClick={e=>{e.stopPropagation();openVerify(r);}}
                      style={{padding:"7px 14px",borderRadius:10,background:GREEN,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",boxShadow:`0 2px 8px ${GREEN}40`}}
                    >
                      Verify & Sign
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* -- Requires Verification -- */}
        {classified.needsVerify.length>0&&(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:AMBER,boxShadow:`0 0 0 3px ${AMBER_BG}`}}/>
              <h2 style={{fontSize:14,fontWeight:700,color:S.ink,margin:0,textTransform:"uppercase",letterSpacing:"1px"}}>Requires Verification</h2>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
              {classified.needsVerify.map(({r,mNum,totalFlights,syncedCount,syncPct})=>(
                <div key={r.id} onClick={()=>setDrillRoster(r)} style={{background:S.surface,borderRadius:20,border:`1.5px solid ${AMBER_BORDER}`,padding:"20px 22px",boxShadow:"0 2px 12px rgba(245,158,11,0.08)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(245,158,11,0.15)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(245,158,11,0.08)"}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:14,marginBottom:16}}>
                    <div style={{width:52,height:52,borderRadius:16,background:AMBER_BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke={AMBER} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:16,fontWeight:800,color:S.ink,letterSpacing:"-.3px"}}>{monthLabel(r,mNum)} BLOCK</div>
                      <div style={{fontSize:12,color:AMBER,fontWeight:700,marginTop:3}}>Sync complete · Awaiting signature</div>
                    </div>
                  </div>
                  <div style={{background:AMBER_BG,border:`1px solid ${AMBER_BORDER}`,borderRadius:12,padding:"12px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke={AMBER} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      <span style={{fontSize:13,fontWeight:700,color:"#92400E"}}>Verification & Signature Required</span>
                    </div>
                    <button
                      onClick={e=>{e.stopPropagation();openVerify(r);}}
                      style={{padding:"8px 16px",borderRadius:10,background:AMBER,border:"none",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",boxShadow:`0 2px 8px ${AMBER}40`}}
                    >
                      Verify & Sign
                    </button>
                  </div>
                  <div style={{fontSize:11,color:S.muted,marginTop:10}}>{syncedCount}/{totalFlights} flights synced · {syncPct}%</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* -- Verified & Locked -- */}
        {classified.verified.length>0&&(
          <div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:BLUE,boxShadow:`0 0 0 3px ${BLUE_BG}`}}/>
              <h2 style={{fontSize:14,fontWeight:700,color:S.ink,margin:0,textTransform:"uppercase",letterSpacing:"1px"}}>Verified & Locked</h2>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:14}}>
              {classified.verified.map(({r,mNum})=>{
                const sig=signedMonths[r.id];
                const totalFlights=(r.calendar||[]).reduce((a,d)=>a+(d.flights||[]).filter(f=>!f.isDeadhead).length,0);
                return(
                  <div key={r.id} onClick={()=>setDrillRoster(r)} style={{background:S.surface,borderRadius:20,border:`1.5px solid ${BLUE_BORDER}`,padding:"20px 22px",boxShadow:"0 2px 12px rgba(37,99,235,0.06)",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 20px rgba(37,99,235,0.12)"} onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(37,99,235,0.06)"}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:14}}>
                      <div style={{width:52,height:52,borderRadius:16,background:BLUE_BG,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke={BLUE} strokeWidth="2"/><path d="M7 11V7a5 5 0 0110 0v4" stroke={BLUE} strokeWidth="2" strokeLinecap="round"/></svg>
                      </div>
                      <div>
                        <div style={{fontSize:16,fontWeight:800,color:S.ink,letterSpacing:"-.3px"}}>{monthLabel(r,mNum)} BLOCK</div>
                        <div style={{fontSize:12,color:BLUE,fontWeight:700,marginTop:3}}>Verified · Archive locked</div>
                        {sig&&<div style={{fontSize:11,color:S.muted,marginTop:4}}>Signed {new Date(sig.at).toLocaleDateString()}</div>}
                        <div style={{fontSize:11,color:S.muted,marginTop:2}}>{totalFlights} flights · Permanent record</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!rosters.length&&(
          <div style={{textAlign:"center",padding:"60px 24px",color:S.muted}}>
            <div style={{fontSize:48,marginBottom:16}}>📋</div>
            <div style={{fontSize:16,fontWeight:700,color:S.ink,marginBottom:8}}>No rosters loaded</div>
            <div style={{fontSize:13}}>Upload a monthly roster PDF to get started</div>
          </div>
        )}
      </div>
    </div>
  );
}

// -- FAR 117 FDP Calculator
// -- Jeppesen Total Times Tab
function TotalTimesTab({analytics, rosters, tails}) {
  const S = getS();
  const BLUE="#1D4ED8"; const PURPLE="#0EA5E9"; // secondary accent (sky) -- purple retired

  const [priorTimes, setPriorTimes] = useState(()=>{
    try { return JSON.parse(localStorage.getItem("fl_prior_times")||"{}"); } catch { return {}; }
  });
  const [editingPrior, setEditingPrior] = useState(false);
  const [priorDraft, setPriorDraft] = useState({});

  function savePrior() {
    const merged = {...priorTimes,...priorDraft};
    setPriorTimes(merged);
    try { localStorage.setItem("fl_prior_times", JSON.stringify(merged)); } catch {}
    setEditingPrior(false);
    setPriorDraft({});
  }

  function parseHM(val) {
    if(!val) return 0;
    const s = String(val).trim();
    if(s.includes(":")) {
      const [h,m] = s.split(":").map(Number);
      return (isNaN(h)?0:h)*60 + (isNaN(m)?0:m);
    }
    const n = parseFloat(s);
    return isNaN(n) ? 0 : Math.round(n*60);
  }

  // Use the shared analytics computation (already applies time rules for
  // PIC/SIC/multi/turbine classification) instead of recomputing locally —
  // this was the source of SIC always defaulting and PIC never appearing.
  const appTotals = useMemo(()=>({
    totalMins: analytics?.totalMins || 0,
    picMins:   analytics?.totalPIC || 0,
    sicMins:   analytics?.totalSIC || 0,
    nightMins: analytics?.totalNight || 0,
    xcMins:    analytics?.totalXC || 0,
    turbineMins: analytics?.totalTurbine || 0,
    multiMins:   analytics?.totalMulti || 0,
    singleMins:  analytics?.totalSingle || 0,
    dayLdg:    (analytics?.totalLandings||0) - (analytics?.totalNightLandings||0),
    nightLdg:  analytics?.totalNightLandings || 0,
    totalLegs: analytics?.totalLegs || 0,
    airports:  analytics?.airports || 0,
  }),[analytics]);

  const FIELDS = [
    {key:"totalTime",  label:"Total Time",      color:BLUE,     desc:"All logged block time"},
    {key:"pic",        label:"PIC",             color:PURPLE,   desc:"Pilot-in-command"},
    {key:"sic",        label:"SIC / Co-Pilot",  color:PURPLE,   desc:"Second-in-command"},
    {key:"night",      label:"Night",           color:"#0F172A",desc:"Civil twilight or later"},
    {key:"xc",         label:"Cross Country",   color:C.green,desc:"Legs > 50 NM"},
    {key:"actualIfr",  label:"Actual IMC",      color:PURPLE,   desc:"Actual instrument"},
    {key:"hoodIfr",    label:"Hood / Sim IFR",  color:PURPLE,   desc:"Simulated instrument"},
    {key:"turbine",    label:"Turbine",         color:BLUE,     desc:"Jet or turboprop"},
    {key:"multi",      label:"Multi-Engine",    color:BLUE,     desc:"Multi-engine aircraft"},
    {key:"single",     label:"Single-Engine",   color:"#F59E0B",desc:"Single-engine flights"},
    {key:"sim",        label:"Simulator",       color:S.muted,  desc:"Sim sessions"},
    {key:"dayLdg",     label:"Day Ldg",         color:C.green,desc:"Daytime landings",     isInt:true},
    {key:"nightLdg",   label:"Night Ldg",       color:"#0F172A",desc:"Night landings",        isInt:true},
    {key:"approaches", label:"Approaches",      color:PURPLE,   desc:"IFR approaches logged", isInt:true},
  ];

  const appValues = {
    totalTime:appTotals.totalMins, pic:appTotals.picMins, sic:appTotals.sicMins,
    night:appTotals.nightMins, xc:appTotals.xcMins,
    actualIfr:0, hoodIfr:0, turbine:appTotals.turbineMins,
    multi:appTotals.multiMins, single:appTotals.singleMins, sim:0,
    dayLdg:appTotals.dayLdg, nightLdg:appTotals.nightLdg, approaches:0,
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${BLUE},${PURPLE})`,borderRadius:18,padding:"16px 18px",color:"#fff"}}>
        <div style={{fontSize:14,fontWeight:800,letterSpacing:"-.3px"}}>Jeppesen Logbook -- Total Times</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:3}}>Enter your prior logbook totals · AviateSync records on top automatically</div>
      </div>

      {/* Prior times entry */}
      <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:16,padding:"16px 18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:S.ink}}>Prior Logbook Times</div>
            <div style={{fontSize:11,color:S.muted,marginTop:2}}>Times from your previous logbook before using AviateSync</div>
          </div>
          <button
            onClick={()=>{if(editingPrior){savePrior();}else{setPriorDraft({...priorTimes});setEditingPrior(true);}}}
            style={{padding:"8px 18px",borderRadius:10,background:editingPrior?BLUE:S.panel,border:"none",color:editingPrior?"#fff":S.muted,fontSize:13,fontWeight:700,cursor:"pointer"}}
          >
            {editingPrior?"Save":"Edit prior times"}
          </button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
          {FIELDS.map(({key,label,isInt})=>{
            const priorMins = parseHM(priorTimes[key]||"0");
            const priorDisplay = isInt ? (priorTimes[key]||"0") : fmtMins(priorMins)||"0:00";
            return(
              <div key={key}>
                <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".4px",marginBottom:3}}>{label}</div>
                {editingPrior?(
                  <input
                    type="text"
                    defaultValue={priorTimes[key]||""}
                    placeholder={isInt?"0":"h:mm"}
                    onChange={e=>setPriorDraft(p=>({...p,[key]:e.target.value}))}
                    style={{width:"100%",padding:"7px 10px",borderRadius:8,border:`1px solid ${BLUE}`,fontSize:13,background:S.surface,color:S.ink,outline:"none",boxSizing:"border-box",fontFamily:"monospace"}}
                  />
                ):(
                  <div style={{padding:"7px 10px",borderRadius:8,background:S.panel,fontSize:13,fontFamily:"monospace",fontWeight:600,color:S.ink}}>{priorDisplay}</div>
                )}
              </div>
            );
          })}
        </div>
        {editingPrior&&(
          <div style={{marginTop:12,fontSize:11,color:S.muted}}>Enter as <strong>h:mm</strong> (e.g. 1234:30) or decimal hours (e.g. 1234.5). For landings/approaches, whole numbers.</div>
        )}
      </div>

      {/* Grand total boxes */}
      <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:"1px",padding:"2px 0"}}>Grand Total (Prior + AviateSync)</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))",gap:10}}>
        {FIELDS.map(({key,label,color,desc,isInt})=>{
          const priorVal = parseHM(priorTimes[key]||"0");
          const appVal = appValues[key]||0;
          const total = priorVal + appVal;
          const display = isInt ? total : (fmtMins(total)||"--");
          const appDisplay = isInt ? appVal : (fmtMins(appVal)||"--");
          return(
            <div key={key} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:16,padding:"14px 16px",display:"flex",flexDirection:"column",gap:4}}>
              <div style={{fontSize:22,fontWeight:900,color,letterSpacing:"-0.5px",lineHeight:1}}>{display}</div>
              <div style={{fontSize:12,fontWeight:700,color:S.ink}}>{label}</div>
              <div style={{fontSize:10,color:S.muted}}>{desc}</div>
              {appVal>0&&<div style={{fontSize:10,color:BLUE,fontWeight:600,marginTop:2}}>+{appDisplay} AviateSync</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FDPCalculator({analytics}) {
  const S = getS();
  const now = new Date();
  // FAR 117 Table B -- max FDP by ADEP (Acclimated to rest time departure)
  // Simplified: use scheduled vs actual block hours this month
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const monthData = analytics.byMonth[thisMonthKey] || {mins:0,legs:0,night:0};
  const hoursThisMonth = monthData.mins / 60;

  // FAR 117 limits
  const LIMITS = [
    {label:"Max FDP (Rest ≥10h, 2 pilots)",hours:9,desc:"Standard single-carrier ops, 2-pilot crew"},
    {label:"Max FDP (Rest ≥10h, 3 pilots)",hours:13,desc:"Augmented crew, domestic"},
    {label:"Max flight time / 24h",hours:9,desc:"14 CFR §117.11"},
    {label:"Max flight time / calendar month",hours:100,desc:"14 CFR §117.11"},
    {label:"Max flight time / calendar year",hours:1000,desc:"14 CFR §117.11"},
  ];

  const flightTimeMonth = hoursThisMonth;
  const pct = Math.min(100, Math.round((flightTimeMonth/100)*100));

  // 28-day rolling from analytics
  const rolling28 = (analytics.last30?.mins||0)/60;
  const pct28 = Math.min(100, Math.round((rolling28/100)*100));

  return (
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${S.blue},#3B82F6)`,borderRadius:18,padding:"18px 20px",color:"#fff"}}>
        <div style={{fontSize:14,fontWeight:800,letterSpacing:"-.3px",marginBottom:4}}>FAR 117 -- Flight & Duty Period Limits</div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.7)"}}>14 CFR Part 117 · Fatigue Risk Management</div>
      </div>

      {/* Monthly usage */}
      <div style={{background:S.surface,borderRadius:16,padding:"16px 18px",border:`1px solid ${S.border}`}}>
        <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:14}}>Current Month Usage</div>
        <div style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:S.muted,marginBottom:5}}>
            <span>Monthly flight time limit (§117.11)</span>
            <span style={{fontWeight:700,color:pct>85?"#DC2626":pct>70?"#F59E0B":S.green}}>{flightTimeMonth.toFixed(1)} / 100 hrs</span>
          </div>
          <div style={{height:8,background:S.panel,borderRadius:100,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct}%`,background:pct>85?"#EF4444":pct>70?"#F59E0B":S.green,borderRadius:100,transition:"width .5s"}}/>
          </div>
          <div style={{fontSize:10,color:S.muted,marginTop:4}}>{100-flightTimeMonth>0?(100-flightTimeMonth).toFixed(1)+" hrs remaining":"Limit reached"}</div>
        </div>
        <div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:S.muted,marginBottom:5}}>
            <span>Last 28-day rolling (§117.11)</span>
            <span style={{fontWeight:700,color:pct28>85?"#DC2626":pct28>70?"#F59E0B":S.green}}>{rolling28.toFixed(1)} / 100 hrs</span>
          </div>
          <div style={{height:8,background:S.panel,borderRadius:100,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct28}%`,background:pct28>85?"#EF4444":pct28>70?"#F59E0B":S.green,borderRadius:100,transition:"width .5s"}}/>
          </div>
        </div>
      </div>

      {/* Limits reference table */}
      <div style={{background:S.surface,borderRadius:16,border:`1px solid ${S.border}`,overflow:"hidden"}}>
        <div style={{padding:"12px 18px",borderBottom:`1px solid ${S.border}`,fontSize:13,fontWeight:700,color:S.ink,background:"rgba(248,250,252,0.5)"}}>FAR 117 Reference Limits</div>
        {LIMITS.map((l,i)=>(
          <div key={i} style={{padding:"12px 18px",borderBottom:i<LIMITS.length-1?`1px solid ${S.border}`:"none",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:S.ink}}>{l.label}</div>
              <div style={{fontSize:11,color:S.muted,marginTop:2}}>{l.desc}</div>
            </div>
            <div style={{fontSize:16,fontWeight:900,color:S.blue,flexShrink:0,fontFamily:"monospace"}}>{l.hours}h</div>
          </div>
        ))}
      </div>

      {/* WOCL warning */}
      <div style={{background:C.amberBg,border:"1px solid #FDE68A",borderRadius:14,padding:"12px 16px",display:"flex",gap:10}}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{flexShrink:0,marginTop:1}}><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <div>
          <div style={{fontSize:12,fontWeight:700,color:"#92400E",marginBottom:3}}>WOCL Awareness (§117.5)</div>
          <div style={{fontSize:11,color:"#78350F",lineHeight:1.5}}>Window of Circadian Low: 0200-0559 local. FDP starting or during WOCL requires additional rest. Ensure rest period compliance before each duty period.</div>
        </div>
      </div>

      <div style={{fontSize:11,color:S.muted,textAlign:"center",padding:"8px 0"}}>Reference only · Consult your airline ops specs for certificate-specific limits</div>
    </div>
  );
}

function AnalyticsPage({user,rosters,tails}){
  const[tab,setTabRaw]=useState(()=>{
    try{ return sessionStorage.getItem("fl_analytics_tab") || "overview"; }catch{ return "overview"; }
  });
  function setTab(t){ setTabRaw(t); try{ sessionStorage.setItem("fl_analytics_tab", t); }catch{} }
  const[timeRules,setTimeRules]=useState([]);
  const[showRuleForm,setShowRuleForm]=useState(false);
  const[confirmDeleteId,setConfirmDeleteId]=useState(null);
  const[ruleForm,setRuleForm]=useState({start_date:"",end_date:"",is_pic:false,is_sic:false,is_multi:false,is_single:false,is_turbine:false,label:""});
  const[savingRule,setSavingRule]=useState(false);
  const[toLandingMode,setToLandingMode]=useState("every");

  useEffect(()=>{
    if(!user?.id) return;
    sb.from("time_rules").select("*").eq("user_id",user.id).order("start_date",{ascending:false})
      .then(({data})=>{if(data)setTimeRules(data);});
  },[user?.id]);

  const analytics=useMemo(()=>computeAnalytics(rosters,tails,timeRules,{},{},toLandingMode),[rosters,tails,timeRules,toLandingMode]);
  const sortedMonths=Object.keys(analytics.byMonth).sort((a,b)=>b.localeCompare(a));

  async function saveRule(){
    setSavingRule(true);
    try{
      const payload={user_id:user.id,...ruleForm,end_date:ruleForm.end_date||null};const{data,error}=await sb.from("time_rules").insert(payload).select().single();
      if(error)throw new Error(error.message);
      setTimeRules(p=>[data,...p]);
      setRuleForm({start_date:"",end_date:"",is_pic:false,is_sic:false,is_multi:false,is_single:false,is_turbine:false,label:""});
      setShowRuleForm(false);
    }catch(e){alert(e.message||"Failed to save.");}
    finally{setSavingRule(false);}
  }

  async function deleteRule(id){
    try{await sb.from("time_rules").delete().eq("id",id);setTimeRules(p=>p.filter(r=>r.id!==id));setConfirmDeleteId(null);}
    catch(e){alert(e.message);}
  }

  return(
    <div style={{flex:1,overflowY:"auto",overflowX:"hidden",background:C.base}}>
      <PageHeader title="Stats"/>
      <div style={{padding:"0 0 2px"}}><PageHero title="Analytics" subtitle="Your flying, quantified" icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 19V5M4 19h16" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/><path d="M7 15l4-5 3 3 5-7" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>}/></div>
      <div style={{display:"flex",gap:6,marginBottom:20,padding:"0 16px 4px",overflowX:"auto"}}>
        {[["overview","Overview"],["totaltimes","Total Times"],["far117","FAR 117"],["rules","Time Rules"],["recency","Recency"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"8px 16px",border:"none",borderRadius:100,cursor:"pointer",fontSize:12.5,fontWeight:700,whiteSpace:"nowrap",flexShrink:0,background:tab===id?`linear-gradient(135deg,${C.blueDim||"#1D4ED8"},${C.teal})`:C.panel,color:tab===id?"#fff":C.muted,boxShadow:tab===id?`0 3px 10px ${C.teal}35`:"none",transition:"all .15s"}}>{label}</button>
        ))}
      </div>

      {tab==="totaltimes"&&<div style={{padding:"0 16px 80px"}}><TotalTimesTab analytics={analytics} rosters={rosters} tails={tails}/></div>}
      {tab==="overview"&&(()=>{
        const maxWindow=Math.max(analytics.last12mo.mins,1);
        const TIME_TILES=[
          {l:"PIC",v:analytics.totals.pic,bg:C.blueBg,fg:C.teal,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke={C.teal} strokeWidth="2"/><path d="M4 20c0-3.5 3.5-6 8-6s8 2.5 8 6" stroke={C.teal} strokeWidth="2" strokeLinecap="round"/></svg>},
          {l:"SIC",v:analytics.totals.sic,bg:`${C.purple}18`,fg:C.purple,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke={C.purple} strokeWidth="2"/><circle cx="17" cy="9" r="2.6" stroke={C.purple} strokeWidth="2"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" stroke={C.purple} strokeWidth="2" strokeLinecap="round"/><path d="M15 15c2.8.3 4.5 2 4.5 5" stroke={C.purple} strokeWidth="2" strokeLinecap="round"/></svg>},
          {l:"Multi Engine",v:analytics.totals.multi,bg:C.greenBg,fg:C.green,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="12" r="3.4" stroke={C.green} strokeWidth="2"/><circle cx="16" cy="12" r="3.4" stroke={C.green} strokeWidth="2"/><path d="M11 12h2" stroke={C.green} strokeWidth="2"/></svg>},
          {l:"Single Engine",v:analytics.totals.single,bg:C.blueBg,fg:C.teal,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.4" stroke={C.teal} strokeWidth="2"/></svg>},
          {l:"Turbine",v:analytics.totals.turbine,bg:C.greenBg,fg:C.green,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={C.green} strokeWidth="2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.8 2.8M15.2 15.2L18 18M18 6l-2.8 2.8M8.8 15.2L6 18" stroke={C.green} strokeWidth="2" strokeLinecap="round"/></svg>},
          {l:"Night",v:analytics.totals.night,bg:C.amberBg,fg:C.gold,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke={C.gold} strokeWidth="2" strokeLinejoin="round"/></svg>},
          {l:"Cross Country",v:analytics.totals.xc,bg:C.blueBg,fg:C.teal,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={C.teal} strokeWidth="2"/><path d="M15.5 8.5l-2.2 5.2-5.2 2.2 2.2-5.2 5.2-2.2z" fill={C.teal}/></svg>},
          {l:"Actual IMC",v:analytics.totals.actualIfr,bg:C.blueBg,fg:C.teal,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M17 18a4 4 0 000-8 5 5 0 00-9.6-1.5A4.5 4.5 0 007 18h10z" stroke={C.teal} strokeWidth="2" strokeLinejoin="round"/></svg>},
          {l:"Hood / Sim",v:analytics.totals.simIfr,bg:`${C.purple}18`,fg:C.purple,icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="13" rx="2" stroke={C.purple} strokeWidth="2"/><path d="M8 21h8" stroke={C.purple} strokeWidth="2" strokeLinecap="round"/></svg>},
        ];
        return(
        <div style={{display:"flex",flexDirection:"column",gap:14,paddingBottom:80,padding:"0 16px 80px"}}>

          {/* Hero -- all-time total, matching the app's signature blue gradient */}
          <div style={{background:`linear-gradient(135deg,${C.blueDim||"#1D4ED8"},${C.teal})`,borderRadius:22,padding:"22px 22px 20px",color:"#fff",boxShadow:`0 10px 30px ${C.teal}30`,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:-30,right:-30,width:120,height:120,borderRadius:"50%",background:"rgba(255,255,255,0.08)"}}/>
            <div style={{position:"relative",display:"flex",alignItems:"center",gap:8,fontSize:11,fontWeight:800,letterSpacing:".6px",textTransform:"uppercase",color:"rgba(255,255,255,0.8)",marginBottom:8}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#fff" strokeWidth="1.7" strokeLinejoin="round"/></svg>
              All-Time Total
            </div>
            <div style={{position:"relative",fontSize:40,fontWeight:900,letterSpacing:"-1.5px",lineHeight:1}}>{analytics.totalHrs}</div>
            <div style={{position:"relative",fontSize:12.5,color:"rgba(255,255,255,0.85)",marginTop:8}}>{analytics.totalLegs} legs logged · {analytics.airports} airports visited</div>
          </div>

          {/* Rolling windows -- icon + mini relative-proportion bar against the 12mo figure */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
            {[["30 DAYS",analytics.last30.mins],["6 MONTHS",analytics.last6mo.mins],["12 MONTHS",analytics.last12mo.mins]].map(([l,m])=>(
              <div key={l} className="card" style={{padding:"14px 12px"}}>
                <div style={{width:26,height:26,borderRadius:8,background:C.blueBg,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={C.teal} strokeWidth="2"/><path d="M12 7v5l3 3" stroke={C.teal} strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <div style={{fontFamily:"monospace",fontSize:16,fontWeight:800,color:C.ink}}>{m?fmtMins(m):"--"}</div>
                <div style={{fontSize:9,fontWeight:700,letterSpacing:".4px",color:C.muted,marginTop:2}}>{l}</div>
                <div style={{marginTop:8,height:4,borderRadius:100,background:C.panel,overflow:"hidden"}}>
                  <div style={{height:"100%",borderRadius:100,width:`${Math.min(100,(m/maxWindow)*100)}%`,background:`linear-gradient(90deg,${C.blueDim||"#1D4ED8"},${C.teal})`}}/>
                </div>
              </div>
            ))}
          </div>

          {/* All-Time Totals -- icon-tagged stat tiles instead of a flat list */}
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.ink}}>All-Time Totals</div>
              <div style={{display:"flex",gap:4}}>
                {[["every","Every leg"],["alternate","Alt. leg"]].map(([m,l])=>(
                  <button key={m} onClick={()=>setToLandingMode(m)} style={{padding:"3px 8px",borderRadius:5,fontSize:10,fontWeight:600,cursor:"pointer",border:"1px solid "+(toLandingMode===m?C.teal:C.border),background:toLandingMode===m?C.teal+"18":"none",color:toLandingMode===m?C.teal:C.muted}}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              {TIME_TILES.map(({l,v,bg,fg,icon})=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:C.panel,borderRadius:12}}>
                  <div style={{width:30,height:30,borderRadius:9,background:bg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{icon}</div>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:10,color:C.muted,fontWeight:600}}>{l}</div>
                    <div style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:v?C.ink:C.muted}}>{v?fmtMins(v):"--"}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:C.panel,borderRadius:12}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M12 20V6M12 6l-5 5M12 6l5 5" stroke={C.teal} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 20h16" stroke={C.teal} strokeWidth="2" strokeLinecap="round"/></svg>
                <span style={{fontSize:12,color:C.silver,flex:1}}>Day / Night T/O</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.ink}}>{analytics.totals.dayTo} / {analytics.totals.nightTo}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:C.panel,borderRadius:12}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M12 4v14M12 18l-5-5M12 18l5-5" stroke={C.teal} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 20h16" stroke={C.teal} strokeWidth="2" strokeLinecap="round"/></svg>
                <span style={{fontSize:12,color:C.silver,flex:1}}>Day / Night Ldg</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.ink}}>{analytics.totals.dayLdg} / {analytics.totals.nightLdg}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",background:C.panel,borderRadius:12}}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><circle cx="12" cy="12" r="9" stroke={C.teal} strokeWidth="2"/><path d="M15.5 8.5l-2.2 5.2-5.2 2.2 2.2-5.2 5.2-2.2z" fill={C.teal}/></svg>
                <span style={{fontSize:12,color:C.silver,flex:1}}>Distance</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.ink}}>{analytics.totals.dist.toLocaleString()} NM</span>
              </div>
            </div>
          </div>
          <div className="card">
            <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:14}}>Monthly Breakdown</div>
            {sortedMonths.length===0&&<div style={{color:C.muted,fontSize:13}}>No flight data yet.</div>}
            {sortedMonths.map(mo=>{
              const d=analytics.byMonth[mo];
              const[yr,mn]=mo.split("-");
              const label=new Date(Number(yr),Number(mn)-1,1).toLocaleDateString(undefined,{month:"long",year:"numeric"});
              return(<div key={mo} style={{marginBottom:16,paddingBottom:16,borderBottom:"1px solid "+C.border}}>
                <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:8}}>{label}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(60px,1fr))",gap:6,marginBottom:6}}>
                  {[["Block",d.flownMins],["Night",d.night],["XC",d.xc],["PIC",d.pic],["SIC",d.sic],["Multi",d.multi]].map(([l,v])=>(
                    <div key={l} style={{textAlign:"center",padding:"6px 4px",background:"#F1F5F9",borderRadius:7}}>
                      <div style={{fontFamily:"monospace",fontSize:11,color:v?C.teal:C.muted,fontWeight:600}}>{v?fmtMins(v):"--"}</div>
                      <div style={{fontSize:9,color:C.muted,marginTop:1}}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                  {[["Day T/O",d.dayTo],["Night T/O",d.nightTo],["Day Ldg",d.dayLdg],["Night Ldg",d.nightLdg]].map(([l,v])=>(
                    <span key={l} style={{fontSize:11,color:C.silver}}>{l}: <b style={{color:C.ink}}>{v}</b></span>
                  ))}
                  <span style={{fontSize:11,color:C.silver}}>{(d.dist||0).toLocaleString()} NM</span>
                </div>
              </div>);
            })}
          </div>
        </div>
        );
      })()}

      {tab==="far117"&&<div style={{padding:"0 0 80px"}}><FDPCalculator analytics={analytics}/></div>}

      {tab==="rules"&&(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,color:C.ink}}>Time Rules</div>
          <button className="btn-teal" style={{padding:"7px 14px",fontSize:12}} onClick={()=>setShowRuleForm(p=>!p)}>{showRuleForm?"Cancel":"+ Add rule"}</button>
        </div>
        {showRuleForm&&(
          <div className="card" style={{marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginBottom:12}}>
              <div><div className="form-label">Start date</div><input className="form-input" type="date" value={ruleForm.start_date} onChange={e=>setRuleForm(p=>({...p,start_date:e.target.value}))}/></div>
              <div><div className="form-label">End date</div><input className="form-input" type="date" value={ruleForm.end_date} onChange={e=>setRuleForm(p=>({...p,end_date:e.target.value}))}/></div>
              <div style={{gridColumn:"span 2"}}><div className="form-label">Label</div><input className="form-input" placeholder="e.g. Captain upgrade" value={ruleForm.label} onChange={e=>setRuleForm(p=>({...p,label:e.target.value}))}/></div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:12}}>
              {[["is_pic","PIC"],["is_sic","SIC"],["is_multi","Multi"],["is_single","Single"],["is_turbine","Turbine"]].map(([k,l])=>(
                <label key={k} style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:C.silver,cursor:"pointer"}}>
                  <input type="checkbox" checked={!!ruleForm[k]} onChange={e=>setRuleForm(p=>({...p,[k]:e.target.checked}))}/>{l}
                </label>
              ))}
            </div>
            <button className="btn-teal" style={{padding:"8px 18px",fontSize:13}} onClick={saveRule} disabled={savingRule}>{savingRule?<span className="spinner">⟳</span>:"Save rule"}</button>
          </div>
        )}
        {timeRules.length===0&&!showRuleForm&&<div style={{textAlign:"center",padding:"32px 0",color:C.muted,fontSize:13}}>No time rules yet.</div>}
        {timeRules.map(rule=>(
          <div key={rule.id} className="card" style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:4}}>{rule.label||"Unnamed rule"}</div>
                <div style={{fontSize:11,color:C.muted,marginBottom:6}}>{rule.start_date} → {rule.end_date||"present"}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[["is_pic","PIC"],["is_sic","SIC"],["is_multi","Multi"],["is_single","Single"],["is_turbine","Turbine"]].filter(([k])=>rule[k]).map(([,l])=>(
                    <span key={l} className="pill pill-teal">{l}</span>
                  ))}
                </div>
              </div>
              {confirmDeleteId===rule.id?(
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:11,color:C.red}}>Delete?</span>
                  <button className="btn-danger" onClick={()=>deleteRule(rule.id)}>Yes</button>
                  <button className="btn-sm-ghost" onClick={()=>setConfirmDeleteId(null)}>No</button>
                </div>
              ):(
                <button className="btn-danger" onClick={()=>setConfirmDeleteId(rule.id)}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </>)}

      {tab==="recency"&&(()=>{
        const now=new Date(),d90=new Date(now);d90.setDate(d90.getDate()-90);
        let dayTo=0,nightTo=0,dayLdg=0,nightLdg=0;
        rosters.forEach(roster=>{
          const monthNum=roster.monthNum!=null?roster.monthNum:(roster.month_num||0);
          (roster.calendar||[]).forEach((day,di)=>{
            (day.flights||[]).forEach((f,fi)=>{
              const tk=roster.id+"-"+di+"-"+fi;
              const tail=tails[tk]||{};
              if(tail.cancelled)return;
              const dateStr=roster.year+"-"+String(monthNum+1).padStart(2,"0")+"-"+String(day.day).padStart(2,"0");
              if(new Date(dateStr+"T12:00:00Z")<d90)return;
              const solar=computeNightTime(dateStr,f.dep,f.arr,tail.actualDep||f.depTime,tail.actualArr||f.arrTime);
              if(solar.dayDep)dayTo++;if(solar.nightDep)nightTo++;
              if(solar.dayArr)dayLdg++;if(solar.nightArr)nightLdg++;
            });
          });
        });
        const dayOk=dayTo>=3&&dayLdg>=3,nightOk=nightTo>=3&&nightLdg>=3;
        return(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div className="card">
              <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:4}}>FAR 61.57 -- 90-Day Recency</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:16}}>3 T/O + 3 landings in last 90 days required to carry passengers.</div>
              {[{label:"Day Currency",ok:dayOk,items:[["Day T/O",dayTo],["Day Ldg",dayLdg]]},
                {label:"Night Currency",ok:nightOk,items:[["Night T/O",nightTo],["Night Ldg",nightLdg]]}].map(({label,ok,items})=>(
                <div key={label} style={{marginBottom:12,padding:"14px",borderRadius:10,background:ok?C.teal+"0d":C.red+"0d",border:"1px solid "+(ok?C.teal+"44":C.red+"44")}}>
                  <div style={{fontSize:14,fontWeight:700,color:ok?C.teal:C.red,marginBottom:10}}>{ok?"✓":"✗"} {label} -- {ok?"CURRENT":"NOT CURRENT"}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {items.map(([l,v])=>(
                      <div key={l}>
                        <div style={{fontSize:11,color:C.muted,marginBottom:3}}>{l}</div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{height:6,flex:1,background:C.border,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:Math.min(100,(v/3)*100)+"%",background:v>=3?C.teal:C.red,borderRadius:3}}/></div>
                          <span style={{fontFamily:"monospace",fontSize:13,fontWeight:700,color:v>=3?C.teal:C.red}}>{v}/3</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{fontSize:10,color:C.muted,marginTop:8}}>Based on solar position (civil twilight). Source: 14 CFR 61.57.</div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function greatCirclePoints(lat1, lon1, lat2, lon2, numPoints=50) {
  // Generates intermediate points along a great-circle arc between two
  // coordinates -- gives the map route arcs their characteristic curve.
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const φ1=toRad(lat1), λ1=toRad(lon1), φ2=toRad(lat2), λ2=toRad(lon2);
  const d = 2*Math.asin(Math.sqrt(Math.pow(Math.sin((φ2-φ1)/2),2)+Math.cos(φ1)*Math.cos(φ2)*Math.pow(Math.sin((λ2-λ1)/2),2)));
  if(d===0) return [[lat1,lon1],[lat2,lon2]];
  const pts=[];
  for(let i=0;i<=numPoints;i++){
    const f=i/numPoints;
    const A=Math.sin((1-f)*d)/Math.sin(d), B=Math.sin(f*d)/Math.sin(d);
    const x=A*Math.cos(φ1)*Math.cos(λ1)+B*Math.cos(φ2)*Math.cos(λ2);
    const y=A*Math.cos(φ1)*Math.sin(λ1)+B*Math.cos(φ2)*Math.sin(λ2);
    const z=A*Math.sin(φ1)+B*Math.sin(φ2);
    pts.push([toDeg(Math.atan2(z,Math.sqrt(x*x+y*y))), toDeg(Math.atan2(y,x))]);
  }
  return pts;
}

function RouteMapPage({rosters, tails}) {
  const mapRef = useRef(null);
  const leafletMapRef = useRef(null);
  const layersRef = useRef([]);
  const [allTime, setAllTime] = useState(false);
  const [selectedRosterId, setSelectedRosterId] = useState(
    ()=>defaultRosterId(rosters)
  );

  // Compute route data whenever selection changes
  const routeData = useMemo(() => {
    const sourceRosters = allTime ? rosters : rosters.filter(r=>r.id===selectedRosterId);
    const flownRoutes = {};  // key="DEP-ARR" → count
    const schedRoutes = {};  // key="DEP-ARR" → count (scheduled only, not flown)

    for(const roster of sourceRosters) {
      (roster.calendar||[]).forEach((day,di) => {
        (day.flights||[]).forEach((f,fi) => {
          if(!f.dep || !f.arr) return;
          if(!AIRPORT_COORDS[f.dep] || !AIRPORT_COORDS[f.arr]) return;
          const key = `${f.dep}-${f.arr}`;
          const tk = `${roster.id}-${di}-${fi}`;
          const tail = tails[tk];
          const isFlown = !!(tail?.actualBlockMins != null || tail?.actualDep);
          const isCancelled = !!tail?.cancelled;
          if(isCancelled) return;
          if(isFlown) {
            flownRoutes[key] = (flownRoutes[key]||0) + 1;
          } else {
            // Only add to scheduled if not already in flown
            if(!flownRoutes[key]) {
              schedRoutes[key] = (schedRoutes[key]||0) + 1;
            }
          }
        });
      });
    }

    // Collect unique airports
    const airports = new Set();
    [...Object.keys(flownRoutes), ...Object.keys(schedRoutes)].forEach(k => {
      const [dep,arr] = k.split("-");
      airports.add(dep); airports.add(arr);
    });

    return { flownRoutes, schedRoutes, airports: [...airports] };
  }, [rosters, tails, allTime, selectedRosterId]);

  // Initialize Leaflet map once
  useEffect(() => {
    if(!mapRef.current || leafletMapRef.current) return;

    // Load Leaflet CSS
    if(!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }

    // Load Leaflet JS then init map
    function initMap() {
      const L = window.L;
      const map = L.map(mapRef.current, {
        center: [38.5, -96],
        zoom: 4,
        zoomControl: true,
        attributionControl: false,
      });
      // Positron basemap -- CartoDB's light-theme sibling of the dark_all
      // tiles used elsewhere (same CDN host, same {z}/{x}/{y}{r} pattern,
      // just a different style path) -- real coastlines, terrain, roads,
      // and city labels, rendered light per request, rather than the
      // previously always-dark "ops center" look.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19, subdomains: "abcd",
      }).addTo(map);
      leafletMapRef.current = map;
      drawRoutes();
    }

    if(window.L) {
      initMap();
    } else {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      script.onload = initMap;
      document.head.appendChild(script);
    }

    return () => {
      if(leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
      }
    };
  }, []);

  // Redraw routes when data changes
  function drawRoutes() {
    const L = window.L;
    const map = leafletMapRef.current;
    if(!L || !map) return;

    // Clear existing layers
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];

    const { flownRoutes, schedRoutes, airports } = routeData;
    const allCounts = [...Object.values(flownRoutes), ...Object.values(schedRoutes)];
    const maxCount = Math.max(1, ...allCounts);

    function addRoute(key, count, isFlown) {
      const [dep,arr] = key.split("-");
      const [lat1,lon1] = AIRPORT_COORDS[dep];
      const [lat2,lon2] = AIRPORT_COORDS[arr];
      const pts = greatCirclePoints(lat1,lon1,lat2,lon2);
      const weight = 1.5 + (count/maxCount)*3.5;
      // Blue arcs throughout -- flown routes bright and solid, scheduled-only
      // routes a dimmer, lighter blue so the two stay visually distinct
      // without introducing a second hue.
      const color = isFlown ? "#3B82F6" : "#60A5FA";
      const opacity = isFlown ? 0.9 : 0.4;
      const line = L.polyline(pts, {
        color, weight, opacity, smoothFactor:1,
      }).addTo(map);
      line.bindTooltip(`${dep} → ${arr} · ${count}×${isFlown?" (flown)":" (scheduled)"}`, {sticky:true});
      layersRef.current.push(line);
    }

    // Draw scheduled first (underneath), then flown on top
    Object.entries(schedRoutes).forEach(([key,count]) => addRoute(key,count,false));
    Object.entries(flownRoutes).forEach(([key,count]) => addRoute(key,count,true));

    // Draw airport dots -- glowing blue marker with a white ring, matching
    // the Flight Detail mini-map's airport-pin style
    airports.forEach(code => {
      const coords = AIRPORT_COORDS[code];
      if(!coords) return;
      const glow = L.circleMarker(coords, {
        radius: 9, color: "transparent", weight: 0,
        fillColor: "#3B82F6", fillOpacity: 0.22,
      }).addTo(map);
      const circle = L.circleMarker(coords, {
        radius: 5, color: "#1E3A8A", weight: 1.5,
        fillColor: "#3B82F6", fillOpacity: 1,
      }).addTo(map);
      circle.bindTooltip(code, {permanent:false, direction:"top"});
      layersRef.current.push(glow, circle);
    });

    // Fit map to show all routes
    if(airports.length > 0) {
      const pts = airports.map(c=>AIRPORT_COORDS[c]).filter(Boolean);
      if(pts.length > 0) map.fitBounds(pts, {padding:[32,32]});
    }
  }

  useEffect(() => { drawRoutes(); }, [routeData]);

  const selectedRoster = rosters.find(r=>r.id===selectedRosterId);

  return (
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 56px)",gap:0}}>
      {/* Controls */}
      <div style={{padding:"12px 16px",background:C.surface,borderBottom:`1px solid ${C.border}`,display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",flexShrink:0}}>
        <div className="section-title" style={{margin:0,fontSize:16}}>Route Map</div>
        <div style={{flex:1}}/>
        {/* Month / All time toggle -- segmented pill */}
        <div style={{display:"flex",gap:2,padding:3,borderRadius:100,background:C.panel}}>
          <button
            onClick={()=>setAllTime(false)}
            style={{padding:"6px 14px",borderRadius:100,border:"none",background:!allTime?`linear-gradient(135deg,${C.blueDim||"#1D4ED8"},${C.teal})`:"transparent",color:!allTime?"#fff":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",boxShadow:!allTime?`0 2px 8px ${C.teal}35`:"none"}}>
            Monthly
          </button>
          <button
            onClick={()=>setAllTime(true)}
            style={{padding:"6px 14px",borderRadius:100,border:"none",background:allTime?`linear-gradient(135deg,${C.blueDim||"#1D4ED8"},${C.teal})`:"transparent",color:allTime?"#fff":C.muted,fontSize:12,fontWeight:700,cursor:"pointer",boxShadow:allTime?`0 2px 8px ${C.teal}35`:"none"}}>
            All time
          </button>
        </div>
        {/* Roster picker -- only shown in monthly mode */}
        {!allTime && (
          <select
            value={selectedRosterId||""}
            onChange={e=>setSelectedRosterId(e.target.value)}
            style={{padding:"6px 12px",borderRadius:100,border:`1px solid ${C.border}`,background:C.panel,color:C.ink,fontSize:12,fontWeight:600,outline:"none",cursor:"pointer"}}>
            {rosters.map(r=>(
              <option key={r.id} value={r.id}>{r.periodLabel||`${r.year}`}</option>
            ))}
          </select>
        )}
        {/* Legend -- blue family throughout: bright/solid = flown, dim/light = scheduled */}
        <div style={{display:"flex",gap:12,alignItems:"center",marginLeft:4}}>
          <span style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:C.silver,fontWeight:600}}>
            <span style={{width:18,height:3,background:"#3B82F6",borderRadius:2,display:"inline-block"}}/>Flown
          </span>
          <span style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:C.silver,fontWeight:600}}>
            <span style={{width:18,height:3,background:"#60A5FA",borderRadius:2,display:"inline-block",opacity:.6}}/>Scheduled
          </span>
        </div>
      </div>
      {/* Map -- dark fill behind the ref div so there's no white flash while
          Leaflet and the dark tile set are still loading */}
      <div ref={mapRef} style={{flex:1,width:"100%",minHeight:0,background:"#0B1625"}}/>
      {/* No data state -- always light text, since it sits on the always-dark map regardless of the app's own theme */}
      {routeData.airports.length===0&&(
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",color:"rgba(255,255,255,0.75)",fontSize:13,textAlign:"center",pointerEvents:"none"}}>
          {rosters.length===0?"Upload a roster to see your routes":"No routes found for this period"}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// PROFILE PAGE
// -----------------------------------------------------------------------------
// Certificates stored in localStorage as base64 (no storage bucket needed)
function CertificatesTab({userId}) {
  const [docs, setDocs] = useState(()=>{
    try { return JSON.parse(localStorage.getItem(`fl_certs_${userId}`)||"[]"); } catch { return []; }
  });
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  function saveDocs(newDocs) {
    setDocs(newDocs);
    try { localStorage.setItem(`fl_certs_${userId}`, JSON.stringify(newDocs)); } catch {}
  }

  async function handleFile(file) {
    if(!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = e => {
        const newDoc = {
          id: Date.now().toString(),
          name: file.name,
          type: file.type,
          size: file.size,
          data: e.target.result,
          uploadedAt: new Date().toISOString().slice(0,10),
        };
        const updated = [...docs, newDoc];
        saveDocs(updated);
        setUploading(false);
      };
      reader.onerror = ()=>setUploading(false);
      reader.readAsDataURL(file);
    } catch { setUploading(false); }
  }

  function removeDoc(id) {
    saveDocs(docs.filter(d=>d.id!==id));
  }

  function downloadDoc(doc) {
    const a = document.createElement("a");
    a.href = doc.data;
    a.download = doc.name;
    a.click();
  }

  const DOC_TYPES = [
    "Medical Certificate","Pilot Certificate","Type Rating","Instrument Rating",
    "Passport","Employee ID","Training Record","Other",
  ];

  return (
    <div>
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:C.ink}}>Certificates & Documents</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>Stored locally on this device</div>
          </div>
          <button onClick={()=>fileRef.current?.click()} disabled={uploading} className="btn-teal" style={{padding:"8px 14px",fontSize:13}}>
            {uploading?<span className="spinner">⟳</span>:"+ Upload"}
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic" style={{display:"none"}}
            onChange={e=>handleFile(e.target.files?.[0])}/>
        </div>

        {docs.length===0&&(
          <div style={{textAlign:"center",padding:"32px 0",color:C.muted}}>
            <div style={{marginBottom:10,opacity:.45}}><svg width="34" height="34" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#94A3B8" strokeWidth="1.8"/><path d="M14 2v6h6M8 13h8M8 17h5" stroke="#94A3B8" strokeWidth="1.8" strokeLinecap="round"/></svg></div>
            <div style={{fontSize:13}}>No documents uploaded yet.</div>
            <div style={{fontSize:12,marginTop:4}}>Upload your medical certificate, pilot certificate, type ratings, passport etc.</div>
          </div>
        )}

        {docs.map(doc=>(
          <div key={doc.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 0",borderBottom:`1px solid ${C.border}`}}>
            <div style={{width:36,height:36,borderRadius:8,background:C.teal+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
              {doc.type?.includes("pdf")
  ?<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#DC2626" strokeWidth="2"/><path d="M14 2v6h6" stroke="#DC2626" strokeWidth="2"/></svg>
  :doc.type?.includes("image")
  ?<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="#0EA5E9" strokeWidth="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="#0EA5E9"/><path d="M21 15l-5-5L5 21" stroke="#0EA5E9" strokeWidth="2"/></svg>
  :<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="#64748B" strokeWidth="2" strokeLinecap="round"/></svg>}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,color:C.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{doc.name}</div>
              <div style={{fontSize:11,color:C.muted}}>{(doc.size/1024).toFixed(0)} KB · Uploaded {doc.uploadedAt}</div>
            </div>
            <button onClick={()=>downloadDoc(doc)} style={{background:"none",border:"1px solid #E2E8F0",borderRadius:7,padding:"5px 10px",color:C.silver,fontSize:11,cursor:"pointer",flexShrink:0}}>
              Open
            </button>
            <button onClick={()=>removeDoc(doc.id)} style={{background:"none",border:"none",color:C.red,fontSize:16,cursor:"pointer",padding:"0 4px",flexShrink:0}}>×</button>
          </div>
        ))}
      </div>

      <div style={{fontSize:11,color:C.muted,lineHeight:1.6,padding:"0 4px"}}>
        ⚠ Documents are stored only on this device in your browser's local storage. They will not sync across devices or be backed up to the cloud. For important documents, keep separate copies.
      </div>
    </div>
  );
}

function ProfilePage({user, onUserUpdated, setPage}) {
  const [name, setName] = useState(user?.name||"");
  const [airlineIata, setAirlineIata] = useState(user?.airline_iata||user?.airlineIata||"");
  const [airlineName, setAirlineName] = useState(user?.airline_name||user?.airlineName||"");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [photoUrl, setPhotoUrl] = useState(user?.avatar_url||null);
  const fileRef = useRef();

  useEffect(()=>{
    try{const s=localStorage.getItem("fl_avatar_"+user?.id);if(s)setPhotoUrl(s);}catch{}
  },[]);

  async function saveProfile() {
    setSaving(true); setErr(""); setSaved(false);
    try {
      // Use supabase client -- raw fetch triggers RLS recursion bug
      const { error } = await sb.from("profiles")
        .update({ name, airline_iata: airlineIata||null, airline_name: airlineName||null })
        .eq("id", user.id);
      if(error) {
        // This specific error means the database's RLS policy on the
        // profiles table is still broken server-side -- no amount of
        // client-side retry logic can fix it. It requires running the SQL
        // migration in FIX_profiles_recursion.sql directly in the Supabase
        // SQL Editor. Surface that clearly instead of a cryptic Postgres
        // error code.
        if(/infinite recursion/i.test(error.message||"")){
          throw new Error("Database configuration issue: the profiles table's security policy needs to be fixed by running FIX_profiles_recursion.sql in the Supabase SQL Editor. This can't be fixed from the app itself.");
        }
        throw new Error(error.message);
      }
      onUserUpdated({...user, name, airline_iata: airlineIata, airline_name: airlineName});
      setSaved(true);
      setTimeout(()=>setSaved(false), 2500);
    } catch(e){ setErr(e.message); }
    setSaving(false);
  }

  function handlePhoto(file) {
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const url = e.target.result;
      setPhotoUrl(url);
      try{localStorage.setItem("fl_avatar_"+user.id, url);}catch{}
    };
    reader.readAsDataURL(file);
  }

  return (
    <div style={{flex:1,overflowY:"auto",background:C.base}}>
      <div style={{padding:16,maxWidth:540}}>
        <PageHero title="Profile" subtitle="Your pilot identity" icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="#fff" strokeWidth="2.2"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>}/>

        {/* Avatar */}
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24,padding:"16px",background:C.surface,borderRadius:14,border:"1px solid #E2E8F0"}}>
          <div onClick={()=>fileRef.current?.click()} style={{
            width:64,height:64,borderRadius:"50%",cursor:"pointer",
            background:photoUrl?"transparent":C.teal,
            display:"flex",alignItems:"center",justifyContent:"center",
            overflow:"hidden",flexShrink:0,
          }}>
            {photoUrl
              ?<img src={photoUrl} alt="Profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              :<span style={{fontSize:24,fontWeight:700,color:"#fff"}}>{(user?.name||"P")[0].toUpperCase()}</span>
            }
          </div>
          <div style={{flex:1}}>
            <div style={{fontSize:16,fontWeight:700,color:C.ink}}>{user?.name||"Pilot"}</div>
            <div style={{fontSize:13,color:C.muted}}>{user?.email}</div>
            <button onClick={()=>fileRef.current?.click()} style={{marginTop:4,fontSize:12,color:C.teal,background:"none",border:"none",cursor:"pointer",padding:0,fontWeight:600}}>
              Change photo
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handlePhoto(e.target.files?.[0])}/>
        </div>

        {/* Form */}
        <div className="card" style={{marginBottom:14}}>
          <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:16}}>Personal Information</div>
          {err&&<div style={{fontSize:13,color:C.red,marginBottom:12,padding:"8px 12px",background:C.redBg,borderRadius:8}}>{err}</div>}
          {saved&&<div style={{fontSize:13,color:C.green,marginBottom:12,padding:"8px 12px",background:C.green+"12",borderRadius:8}}>✓ Profile saved successfully</div>}
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <div className="form-label">Full name</div>
              <input className="form-input" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name"/>
            </div>
            <div>
              <div className="form-label">Email</div>
              <input className="form-input" value={user?.email||""} disabled style={{opacity:.55,cursor:"not-allowed"}}/>
            </div>
            <div>
              <div className="form-label">Airline name</div>
              <input className="form-input" value={airlineName} onChange={e=>setAirlineName(e.target.value)} placeholder="e.g. Delta Air Lines"/>
            </div>
            <div>
              <div className="form-label">Airline IATA code</div>
              <input className="form-input" value={airlineIata} onChange={e=>setAirlineIata(e.target.value.toUpperCase().slice(0,3))} placeholder="e.g. G7" maxLength={3} style={{width:100}}/>
            </div>
          </div>
          <button
            className="btn-teal"
            style={{marginTop:20,padding:"12px 24px",fontSize:14,width:"100%"}}
            onClick={saveProfile}
            disabled={saving}
          >
            {saving?<span className="spinner">⟳</span>:"Save changes"}
          </button>
        </div>

        {/* Account info */}
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:12}}>Account</div>
          {[
            {label:"Plan",val:user?.subscription_status==="active"?"Pro -- Active":"Inactive"},
            {label:"Member since",val:user?.joined?new Date(user.joined).toLocaleDateString("en-US",{month:"long",year:"numeric"}):"--"},
            {label:"User ID",val:user?.id?.slice(0,8)+"..."},
          ].map(({label,val})=>(
            <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontSize:13,color:C.muted}}>{label}</span>
              <span style={{fontSize:13,fontWeight:600,color:C.ink}}>{val}</span>
            </div>
          ))}
          <button onClick={()=>setPage&&setPage("subscriptions")} style={{marginTop:12,width:"100%",padding:"10px",borderRadius:8,background:"none",border:"1px solid #E2E8F0",color:C.teal,fontSize:13,fontWeight:600,cursor:"pointer"}}>
            Manage Subscription →
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({user, rosters, tails, isDark, onToggleTheme}) {
  const [notifPrefs, setNotifPrefsState] = useState(getNotifPrefs());
  function toggleNotif(key){
    const next={...notifPrefs,[key]:!notifPrefs[key]};
    setNotifPrefsState(next); setNotifPrefs(next);
  }
  function download(){
    const csv=csvExport(rosters,tails);
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download=`aviatesync_${(user.name||"pilot").replace(/\s/g,"_")}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }
  const totalMins=totalMinsBest(rosters, tails);
  const flights=allFlights(rosters);
  return (
    <div style={{flex:1,overflowY:"auto",background:C.base}}>
    <div style={{maxWidth:600,margin:"0 auto",padding:"0 0 40px"}}>
      <PageHero title="Settings" subtitle="Account, data & appearance" icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#fff" strokeWidth="2.2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.14.55.63.94 1.2 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="#fff" strokeWidth="1.8"/></svg>}/>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:16}}>Appearance</div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:14,color:C.ink,fontWeight:500}}>{isDark?"Dark mode":"Light mode"}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{isDark?"Deep navy -- easier on the eyes at night":"Clean white -- better in bright light"}</div>
          </div>
          <button
            onClick={onToggleTheme}
            style={{
              width:52,height:28,borderRadius:14,border:"none",cursor:"pointer",
              background:isDark?C.teal:C.border,
              position:"relative",transition:"background .2s",flexShrink:0,
            }}
          >
            <span style={{
              position:"absolute",top:3,left:isDark?26:3,
              width:22,height:22,borderRadius:"50%",
              background:"#fff",transition:"left .2s",
              boxShadow:"0 1px 4px rgba(0,0,0,.3)",
            }}/>
          </button>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:4}}>Notifications</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:10}}>Choose which alerts appear under the bell on your dashboard. All are on by default.</div>
        {[
          {key:"sync",          title:"Automatic flight sync",           desc:"When FlightAware fills in a tail number or block time"},
          {key:"edits",         title:"Manual edits",                    desc:"When a flight record is changed during verification"},
          {key:"signReminders", title:"Verification & sign reminders",   desc:"When a past month's active log still needs your signature"},
          {key:"upcoming24h",   title:"Upcoming flight reminders",       desc:"When your next flight departs within 24 hours"},
        ].map(row=>(
          <div key={row.key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"11px 0",borderTop:`1px solid ${C.border}`}}>
            <div style={{paddingRight:12}}>
              <div style={{fontSize:14,color:C.ink,fontWeight:500}}>{row.title}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>{row.desc}</div>
            </div>
            <button onClick={()=>toggleNotif(row.key)} aria-label={`Toggle ${row.title}`} style={{width:52,height:28,borderRadius:14,border:"none",cursor:"pointer",background:notifPrefs[row.key]?C.teal:C.border,position:"relative",transition:"background .2s",flexShrink:0}}>
              <span style={{position:"absolute",top:3,left:notifPrefs[row.key]?26:3,width:22,height:22,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
            </button>
          </div>
        ))}
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:16}}>Account</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          {[["Name",user.name],["Email",user.email],["Airline",user.airlineName||user.airline_name||"--"],["IATA Code",user.airlineIata||user.airline_iata||"--"],["Plan",<span className="pill pill-orange">{user.plan}</span>],["Member since",user.joined]].map(([l,v])=>(
            <div key={l}><div className="form-label">{l}</div><div style={{fontSize:14,color:C.silver}}>{v}</div></div>
          ))}
        </div>
        <div className="divider"/>
        <div style={{display:"flex",gap:24,flexWrap:"wrap"}}>
          <div><div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Total hours</div><div style={{fontFamily:FM,fontSize:22,color:C.orange}}>{fmtMins(totalMins)}</div></div>
          <div><div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Total legs</div><div style={{fontFamily:FM,fontSize:22,color:C.orange}}>{flights.length}</div></div>
          <div><div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Rosters</div><div style={{fontFamily:FM,fontSize:22,color:C.orange}}>{rosters.length}</div></div>
        </div>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:8}}>⚡ Automatic Tail Number Sync</div>
        <p style={{fontSize:13,color:C.muted}}>Tail numbers and block times are pulled automatically from live flight data shortly after each flight lands. No setup required -- this runs in the background for every pilot.</p>
      </div>

      <div className="card">
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:8}}>Export Logbook</div>
        <p style={{fontSize:13,color:C.muted,marginBottom:12}}>Download your complete logbook as CSV. Compatible with Excel, Google Sheets, ForeFlight, and Logbook Pro.</p>
        <button className="btn-orange" onClick={download} disabled={rosters.length===0}>↓ Download CSV ({flights.length} flights)</button>
      </div>
    </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ADMIN PAGES
// -----------------------------------------------------------------------------
function AdminOverview() {
  const [users,setUsers]=useState([]);
  const [rosters,setRosters]=useState([]);
  useEffect(()=>{ db_adminUsers().then(setUsers); db_adminAllRosters().then(setRosters); },[]);
  const pilots=users.filter(u=>u.role!=="admin");
  const pro=pilots.filter(u=>u.plan==="pro");
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:24}}>
        <div className="section-title" style={{marginBottom:0}}>Admin Overview</div>
        <span className="admin-badge">ADMIN</span>
      </div>
      {!isConfigured()&&<div className="warn">⚠ Demo mode -- connect Supabase to see real user data.</div>}
      <div className="dash-grid">
        {[
          {label:"Total pilots",val:pilots.length,sub:`${pilots.filter(u=>u.active!==false).length} active`},
          {label:"Pro subscribers",val:pro.length,sub:"paying accounts"},
          {label:"MRR",val:`$${pro.length*9}`,sub:"monthly recurring revenue"},
          {label:"Rosters uploaded",val:rosters.length,sub:"all time"},
        ].map(s=>(
          <div className="stat-card" key={s.label}>
            <div className="stat-card-label">{s.label}</div>
            <div className="stat-card-val">{s.val}</div>
            <div className="stat-card-sub">{s.sub}</div>
          </div>
        ))}
      </div>
      <div className="notice">🔧 Tip: after going live, manage subscriptions from your Stripe Dashboard and use Supabase Edge Functions to handle webhook events.</div>
    </div>
  );
}

function AdminUsers({onViewAsUser}) {
  const [users,setUsers]=useState([]);
  const [loading,setLoading]=useState(true);
  const [deleting,setDeleting]=useState(null);
  const [viewingRosters,setViewingRosters]=useState(null);
  const [rostersLoading,setRostersLoading]=useState(false);
  const [selectedRoster,setSelectedRoster]=useState(null);
  const [expandedDay,setExpandedDay]=useState(null);

  useEffect(()=>{db_adminUsers().then(u=>{setUsers(u);setLoading(false);});},[]);

  async function toggleActive(id,current) {
    await db_adminUpdateUser(id,{active:!current});
    setUsers(prev=>prev.map(u=>u.id===id?{...u,active:!current}:u));
  }
  async function changePlan(id,plan) {
    await db_adminUpdateUser(id,{plan});
    setUsers(prev=>prev.map(u=>u.id===id?{...u,plan}:u));
  }

  async function deleteUser(u) {
    const confirm1 = window.confirm(`Delete pilot "${u.name}" (${u.email})?\n\nThis will permanently delete:\n• Their profile\n• All rosters\n• All tail logs\n• Their auth account\n\nThis cannot be undone.`);
    if(!confirm1) return;
    const confirm2 = window.confirm(`Are you absolutely sure? Type OK to confirm deletion of ${u.email}.`);
    if(!confirm2) return;
    setDeleting(u.id);
    try {
      const token = sb.auth._token || SUPA_ANON;
      // Delete related data first (cascade should handle it but be explicit)
      const headers = {"apikey":SUPA_ANON,"Authorization":`Bearer ${token}`,"Content-Type":"application/json"};
      // Delete tail_logs
      await fetch(`${SUPA_URL}/rest/v1/tail_logs?user_id=eq.${u.id}`, {method:"DELETE",headers});
      // Delete rosters
      await fetch(`${SUPA_URL}/rest/v1/rosters?user_id=eq.${u.id}`, {method:"DELETE",headers});
      // Delete profile
      await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${u.id}`, {method:"DELETE",headers});
      // Delete auth user via admin RPC
      const rpcRes = await fetch(`${SUPA_URL}/rest/v1/rpc/admin_delete_user`, {
        method:"POST",headers,
        body:JSON.stringify({user_id:u.id}),
      });
      if(!rpcRes.ok) {
        // If RPC doesn't exist yet, show instructions
        alert(`Profile and data deleted. To delete the auth account, run in Supabase:\n\nSELECT auth.users WHERE id = '${u.id}';\nDELETE FROM auth.users WHERE id = '${u.id}';`);
      }
      setUsers(prev=>prev.filter(x=>x.id!==u.id));
    } catch(e){ alert("Delete failed: "+e.message); }
    setDeleting(null);
  }

  async function viewRosters(user) {
    setRostersLoading(true);
    setViewingRosters({user, rosters:[]});
    setSelectedRoster(null);
    try {
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(`${SUPA_URL}/rest/v1/rpc/get_admin_rosters`,
        {method:"POST", headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${token}`,"Content-Type":"application/json"}, body:"{}"}
      );
      const data = await res.json();
      const userRosters = Array.isArray(data)
        ? data.filter(r=>r.user_id===user.id).sort((a,b)=>b.year-a.year||b.month_num-a.month_num)
        : [];
      setViewingRosters({user, rosters:userRosters});
    } catch(e){alert(e.message);}
    setRostersLoading(false);
  }

  // -- Roster calendar view
  if(viewingRosters && selectedRoster) {
    const r = selectedRoster;
    const year=r.year, mNum=r.month_num??0;
    const daysInMonth=new Date(year,mNum+1,0).getDate();
    const firstDow=new Date(year,mNum,1).getDay();
    const cells=[]; for(let i=0;i<firstDow;i++)cells.push(null); for(let d=1;d<=daysInMonth;d++)cells.push(d); while(cells.length%7!==0)cells.push(null);
    const dayMap={}; (r.calendar||[]).forEach(d=>{dayMap[d.day]=d;});
    return(
      <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
        <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <button onClick={()=>{setSelectedRoster(null);setExpandedDay(null);}} style={{background:"none",border:"1px solid #E2E8F0",borderRadius:7,padding:"5px 12px",color:C.muted,fontSize:13,cursor:"pointer"}}>← Rosters</button>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{viewingRosters.user.name} -- {r.period_label}</div>
            <div style={{fontSize:11,color:C.muted}}>{(r.calendar||[]).filter(d=>d.flights?.length>0).length} duty days · {(r.calendar||[]).reduce((a,d)=>a+(d.flights?.length||0),0)} flights</div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:C.surface,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          {["S","M","T","W","T","F","S"].map((d,i)=><div key={i} style={{textAlign:"center",fontSize:11,fontWeight:600,color:C.muted,padding:"5px 0"}}>{d}</div>)}
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,background:C.border}}>
            {cells.map((day,idx)=>{
              if(!day) return <div key={`b${idx}`} style={{background:C.base,minHeight:56}}/>;
              const d=dayMap[day];
              const hasFlights=d?.flights?.length>0;
              const bg=hasFlights?"#2C7BE5":d?.dutyCode?"#F59E0B":null;
              return(
                <div key={day} onClick={()=>setExpandedDay(expandedDay===day?null:day)} style={{background:bg||C.surface,minHeight:56,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,cursor:"pointer",outline:expandedDay===day?`2px solid ${C.teal}`:"none",outlineOffset:"-2px"}}>
                  <div style={{fontSize:12,fontWeight:500,color:bg?"#fff":C.muted}}>{day}</div>
                  {hasFlights&&<div style={{fontSize:13}}>✈</div>}
                  {!hasFlights&&d?.dutyCode&&<div style={{fontSize:8,fontWeight:700,color:"#fff"}}>{d.dutyCode}</div>}
                </div>
              );
            })}
          </div>
          {expandedDay&&dayMap[expandedDay]&&(
            <div style={{margin:12,padding:14,borderRadius:12,background:C.surface,border:"1px solid #E2E8F0"}}>
              <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:10}}>
                {new Date(year,mNum,expandedDay).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}
              </div>
              {(dayMap[expandedDay].flights||[]).length===0&&<div style={{fontSize:13,color:C.muted}}>{dayMap[expandedDay].dutyCode||"Rest day"}</div>}
              {(dayMap[expandedDay].flights||[]).map((f,fi)=>(
                <div key={fi} style={{padding:"10px 0",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between"}}>
                  <div><span style={{fontSize:13,fontWeight:700,color:C.teal,marginRight:8}}>{f.flightNum}</span><span style={{fontSize:14,fontWeight:700,color:C.ink}}>{f.dep} → {f.arr}</span>{f.acType&&<span style={{fontSize:11,color:C.muted,marginLeft:8}}>{f.acType}</span>}</div>
                  <div style={{fontSize:12,color:C.muted,textAlign:"right"}}>{f.depTime} → {f.arrTime}{schedMins(f)?<div style={{color:C.teal,fontWeight:600}}>{fmtMins(schedMins(f))}</div>:null}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // -- Roster list for a specific pilot
  if(viewingRosters) {
    return(
      <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
        <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
          <button onClick={()=>setViewingRosters(null)} style={{background:"none",border:"1px solid #E2E8F0",borderRadius:7,padding:"5px 12px",color:C.muted,fontSize:13,cursor:"pointer"}}>← Users</button>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{viewingRosters.user.name}</div>
            <div style={{fontSize:11,color:C.muted}}>{viewingRosters.user.email}</div>
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:16}}>
          {rostersLoading&&<div style={{textAlign:"center",padding:32,color:C.muted}}><span className="spinner">⟳</span> Loading…</div>}
          {!rostersLoading&&viewingRosters.rosters.length===0&&<div style={{textAlign:"center",padding:32,color:C.muted}}>No rosters uploaded yet.</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10}}>
            {viewingRosters.rosters.map((r,i)=>(
              <button key={i} onClick={()=>{setSelectedRoster(r);setExpandedDay(null);}} style={{
                padding:"16px",borderRadius:12,background:C.surface,border:"1px solid #E2E8F0",
                cursor:"pointer",textAlign:"left",transition:"border-color .15s",
              }}>
                <div style={{fontSize:14,fontWeight:700,color:"#1D4ED8",marginBottom:4}}>{r.period_label}</div>
                <div style={{fontSize:11,color:C.muted}}>{(r.calendar||[]).filter(d=>d.flights?.length>0).length} duty days</div>
                <div style={{fontSize:11,color:C.muted}}>{(r.calendar||[]).reduce((a,d)=>a+(d.flights?.length||0),0)} flights</div>
                <div style={{fontSize:10,color:C.muted,marginTop:4}}>Tap to view →</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // -- Main users table
  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{padding:"16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
        <div className="section-title" style={{marginBottom:0}}>Users</div>
        <span className="admin-badge">ADMIN</span>
        <div style={{marginLeft:"auto",fontSize:13,color:C.muted}}>{users.filter(u=>u.role!=="admin").length} pilots</div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Name</th><th>Email</th><th>Plan</th><th>Joined</th><th>Status</th><th>Rosters</th><th>Actions</th><th>Delete</th></tr></thead>
              <tbody>
                {loading&&<tr><td colSpan={8} style={{color:C.muted,textAlign:"center",padding:32}}><span className="spinner">⟳</span> Loading…</td></tr>}
                {users.map(u=>(
                  <tr key={u.id}>
                    <td style={{fontWeight:500,color:C.white}}>{u.name}</td>
                    <td style={{color:C.silver,fontSize:12}}>{u.email}</td>
                    <td>
                      {u.role==="admin"
                        ? <span className="pill pill-red">Admin</span>
                        : <select style={{background:"#F1F5F9",border:"1px solid #E2E8F0",color:C.silver,padding:"4px 8px",borderRadius:6,fontSize:12}} value={u.plan||"starter"} onChange={e=>changePlan(u.id,e.target.value)}>
                            <option value="starter">Starter</option>
                            <option value="pro">Pro</option>
                            <option value="enterprise">Enterprise</option>
                          </select>}
                    </td>
                    <td style={{color:C.muted,fontSize:12}}>{u.joined?.slice?.(0,10)}</td>
                    <td><span className={`pill ${u.active!==false?"pill-green":"pill-muted"}`}>{u.active!==false?"Active":"Suspended"}</span></td>
                    <td>
                      {u.role!=="admin"&&<button onClick={()=>viewRosters(u)} style={{padding:"4px 10px",borderRadius:6,background:C.teal+"18",border:`1px solid ${C.teal}44`,color:C.teal,fontSize:12,cursor:"pointer"}}>📋 Rosters</button>}
                      {u.role!=="admin"&&onViewAsUser&&(
                        <button onClick={()=>{if(window.confirm(`View AviateSync as ${u.name}? You'll see their Dashboard, Logbook and Stats exactly as they would. Use "Exit Admin View" to return.`))onViewAsUser(u);}} style={{marginLeft:6,padding:"4px 10px",borderRadius:6,background:C.green+"18",border:`1px solid ${C.green}44`,color:C.green,fontSize:12,cursor:"pointer"}}>
                          👁 View Dashboard
                        </button>
                      )}
                    </td>
                    <td>{u.role!=="admin"&&<button className="btn-danger" onClick={()=>toggleActive(u.id,u.active!==false)}>{u.active!==false?"Suspend":"Activate"}</button>}</td>
                    <td>
                      {u.role!=="admin"&&(
                        <button
                          onClick={()=>deleteUser(u)}
                          disabled={deleting===u.id}
                          style={{padding:"4px 10px",borderRadius:6,background:C.red+"18",border:`1px solid ${C.red}44`,color:C.red,fontSize:12,cursor:"pointer",fontWeight:600}}
                        >
                          {deleting===u.id?<span className="spinner">⟳</span>:"🗑 Delete"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminAuditLogs() {
  const [pilots, setPilots] = useState([]);
  const [loadingPilots, setLoadingPilots] = useState(true);
  const [selectedPilotId, setSelectedPilotId] = useState(null);
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [rosterLabels, setRosterLabels] = useState({}); // roster_id -> periodLabel, for readable display

  useEffect(()=>{ db_adminUsers().then(u=>{ setPilots(u||[]); setLoadingPilots(false); }); },[]);

  useEffect(()=>{
    if(!selectedPilotId) { setEntries([]); setFetchError(null); return; }
    setLoadingEntries(true); setFetchError(null);
    (async()=>{
      try{
        const {data,error} = await sb.from("audit_log")
          .select("*")
          .eq("user_id", selectedPilotId)
          .order("signed_at",{ascending:false});
        if(error) throw new Error(error.message);
        setEntries(data||[]);
        // Resolve roster_id -> period label for anything not already cached,
        // so entries read as "June 2026, day 14" rather than a bare uuid.
        const rosterIds=[...new Set((data||[]).map(e=>e.roster_id))].filter(id=>!rosterLabels[id]);
        if(rosterIds.length){
          const {data:rosterRows} = await sb.from("rosters")
            .select("id,period_label")
            .in("id",rosterIds);
          if(rosterRows){
            setRosterLabels(prev=>{
              const next={...prev};
              rosterRows.forEach(r=>{ next[r.id]=r.period_label; });
              return next;
            });
          }
        }
      }catch(e){ console.warn("audit_log fetch failed:", e.message); setEntries([]); setFetchError(e.message); }
      setLoadingEntries(false);
    })();
  },[selectedPilotId]);

  const filteredPilots = pilots.filter(p=>
    !search || (p.name||"").toLowerCase().includes(search.toLowerCase()) || (p.email||"").toLowerCase().includes(search.toLowerCase())
  );
  const selectedPilot = pilots.find(p=>p.id===selectedPilotId);

  const FIELD_LABELS = {tail:"Tail Number", actualBlockMins:"Actual Block Time", acType:"Aircraft Type"};

  return(
    <div>
      <div className="section-title">Audit Logs</div>
      <div className="section-sub">Every edit a pilot made at Sign &amp; Lock time -- never per keystroke, only the final change recorded when they signed.</div>

      <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:20,marginTop:20,alignItems:"flex-start"}}>
        {/* Pilot selector */}
        <div className="card" style={{padding:0,overflow:"hidden"}}>
          <div style={{padding:"12px 14px",borderBottom:"1px solid var(--border)"}}>
            <input
              type="text" placeholder="Search pilots..."
              value={search} onChange={e=>setSearch(e.target.value)}
              style={{width:"100%",padding:"8px 10px",borderRadius:8,border:"1px solid var(--border)",fontSize:13,outline:"none",boxSizing:"border-box"}}
            />
          </div>
          <div style={{maxHeight:520,overflowY:"auto"}}>
            {loadingPilots?(
              <div style={{padding:16,fontSize:13,color:"var(--muted)",textAlign:"center"}}>Loading...</div>
            ):filteredPilots.length===0?(
              <div style={{padding:16,fontSize:13,color:"var(--muted)",textAlign:"center"}}>No pilots found</div>
            ):filteredPilots.map(p=>(
              <button key={p.id} onClick={()=>setSelectedPilotId(p.id)}
                style={{width:"100%",textAlign:"left",padding:"10px 14px",background:selectedPilotId===p.id?"var(--blue-bg)":"none",border:"none",borderBottom:"1px solid var(--border)",cursor:"pointer"}}>
                <div style={{fontSize:13,fontWeight:700,color:selectedPilotId===p.id?"var(--blue)":"var(--ink)"}}>{p.name||"(no name)"}</div>
                <div style={{fontSize:11,color:"var(--muted)"}}>{p.email}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Entries table */}
        <div className="card" style={{padding:0,overflow:"hidden",minHeight:200}}>
          {!selectedPilotId?(
            <div style={{padding:40,textAlign:"center",color:"var(--muted)",fontSize:13}}>Select a pilot to view their audit history</div>
          ):loadingEntries?(
            <div style={{padding:40,textAlign:"center",color:"var(--muted)",fontSize:13}}>Loading audit history for {selectedPilot?.name}...</div>
          ):fetchError?(
            <div style={{padding:40,textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:700,color:"#DC2626",marginBottom:6}}>Could not load audit history</div>
              <div style={{fontSize:12,color:"var(--muted)",fontFamily:"monospace",background:"#FEF2F2",padding:"8px 12px",borderRadius:8,display:"inline-block"}}>{fetchError}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:10}}>This is a real error, not "no edits yet" -- check that the audit_log table and its RLS policies exist in the database (see schema.sql).</div>
            </div>
          ):entries.length===0?(
            <div style={{padding:40,textAlign:"center",color:"var(--muted)",fontSize:13}}>No recorded edits for {selectedPilot?.name}. Either they haven't signed a month with edits yet, or every value matched what was already on file.</div>
          ):(
            <>
              <div style={{padding:"12px 16px",borderBottom:"1px solid var(--border)",fontSize:13,fontWeight:700,color:"var(--ink)"}}>
                {selectedPilot?.name} -- {entries.length} recorded edit{entries.length!==1?"s":""}
              </div>
              <div style={{maxHeight:520,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12.5}}>
                  <thead style={{position:"sticky",top:0,background:"var(--panel)",zIndex:1}}>
                    <tr>
                      {["Signed At","Roster","Flight","Field","Was","Changed To"].map(h=>(
                        <th key={h} style={{padding:"8px 12px",textAlign:"left",fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:".4px",borderBottom:"1px solid var(--border)",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(e=>(
                      <tr key={e.id} style={{borderBottom:"1px solid var(--border)"}}>
                        <td style={{padding:"9px 12px",color:"var(--muted)",fontFamily:"monospace",whiteSpace:"nowrap"}}>{new Date(e.signed_at).toLocaleString()}</td>
                        <td style={{padding:"9px 12px",color:"var(--ink)"}}>{rosterLabels[e.roster_id]||"--"}</td>
                        <td style={{padding:"9px 12px",color:"var(--muted)",fontFamily:"monospace"}}>{e.flight_key}</td>
                        <td style={{padding:"9px 12px",color:"#3B82F6",fontWeight:600}}>{FIELD_LABELS[e.field]||e.field}</td>
                        <td style={{padding:"9px 12px",color:"#DC2626",fontFamily:"monospace",textDecoration:"line-through",opacity:.75}}>{e.old_value||"--"}</td>
                        <td style={{padding:"9px 12px",color:"#059669",fontFamily:"monospace",fontWeight:700}}>{e.new_value||"--"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AdminRosters() {
  const [rosters,setRosters]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selected,setSelected]=useState(null); // {roster, pilotName, pilotEmail}
  const [expandedDay,setExpandedDay]=useState(null);

  useEffect(()=>{db_adminAllRosters().then(r=>{setRosters(r);setLoading(false);});},[]);

  if(selected) {
    const r = selected.roster;
    const year = r.year;
    const mNum = r.month_num??0;
    const daysInMonth = new Date(year,mNum+1,0).getDate();
    const firstDow = new Date(year,mNum,1).getDay();
    const cells=[];
    for(let i=0;i<firstDow;i++) cells.push(null);
    for(let d=1;d<=daysInMonth;d++) cells.push(d);
    while(cells.length%7!==0) cells.push(null);
    const dayMap={};
    (r.calendar||[]).forEach(d=>{ dayMap[d.day]=d; });
    const COLORS={flight:"#2C7BE5",flown:"#2C7BE5",standby:"#F59E0B",off:null};

    return(
      <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
        {/* Header */}
        <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
          <button onClick={()=>{setSelected(null);setExpandedDay(null);}} style={{background:"none",border:"1px solid #E2E8F0",borderRadius:7,padding:"5px 12px",color:C.muted,fontSize:13,cursor:"pointer"}}>← Back</button>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:C.ink}}>{selected.pilotName} -- {r.period_label}</div>
            <div style={{fontSize:11,color:C.muted}}>{selected.pilotEmail}</div>
          </div>
          <div style={{marginLeft:"auto",fontSize:12,color:C.muted}}>
            {(r.calendar||[]).filter(d=>d.flights?.length>0).length} duty days ·{" "}
            {(r.calendar||[]).reduce((a,d)=>a+(d.flights?.length||0),0)} flights
          </div>
        </div>

        {/* DOW header */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:C.surface,borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          {["S","M","T","W","T","F","S"].map((d,i)=>(
            <div key={i} style={{textAlign:"center",fontSize:11,fontWeight:600,color:C.muted,padding:"5px 0"}}>{d}</div>
          ))}
        </div>

        {/* Calendar grid + expanded day */}
        <div style={{flex:1,overflowY:"auto"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:1,background:C.border}}>
            {cells.map((day,idx)=>{
              if(!day) return <div key={`b${idx}`} style={{background:C.base,minHeight:56}}/>;
              const d = dayMap[day];
              const hasFlights = d?.flights?.length>0;
              const isStandby = !hasFlights && d?.dutyCode;
              const bg = hasFlights?COLORS.flight:isStandby?COLORS.standby:null;
              const isSelected = expandedDay===day;
              return(
                <div key={day} onClick={()=>setExpandedDay(expandedDay===day?null:day)} style={{
                  background:bg||C.surface,minHeight:56,
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                  gap:3,cursor:"pointer",position:"relative",
                  outline:isSelected?`2px solid ${C.teal}`:"none",outlineOffset:"-2px",
                }}>
                  <div style={{fontSize:12,fontWeight:500,color:bg?"#fff":C.muted}}>{day}</div>
                  {hasFlights&&<div style={{fontSize:13,opacity:.9}}>✈</div>}
                  {isStandby&&<div style={{fontSize:8,fontWeight:700,color:"#fff"}}>{d.dutyCode}</div>}
                </div>
              );
            })}
          </div>

          {/* Day detail */}
          {expandedDay&&dayMap[expandedDay]&&(
            <div style={{margin:12,padding:14,borderRadius:12,background:C.surface,border:"1px solid #E2E8F0"}}>
              <div style={{fontSize:14,fontWeight:700,color:C.ink,marginBottom:10}}>
                {new Date(year,mNum,expandedDay).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
              </div>
              {dayMap[expandedDay].dutyCode&&<div style={{fontSize:12,color:C.gold,fontWeight:600,marginBottom:8}}>{dayMap[expandedDay].dutyCode}</div>}
              {(dayMap[expandedDay].flights||[]).length===0&&<div style={{fontSize:13,color:C.muted}}>Rest day</div>}
              {(dayMap[expandedDay].flights||[]).map((f,fi)=>(
                <div key={fi} style={{padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:13,fontWeight:700,color:C.teal,marginRight:8}}>{f.flightNum}</span>
                      <span style={{fontSize:14,fontWeight:700,color:C.ink}}>{f.dep} → {f.arr}</span>
                      {f.acType&&<span style={{fontSize:11,color:C.muted,marginLeft:8}}>{f.acType}</span>}
                    </div>
                    <div style={{fontSize:12,color:C.muted,textAlign:"right"}}>
                      {f.depTime} → {f.arrTime}
                      {schedMins(f)&&<div style={{color:C.teal,fontWeight:600}}>{fmtMins(schedMins(f))}</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{padding:"16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
        <div className="section-title" style={{marginBottom:0}}>All Rosters</div>
        <span className="admin-badge">ADMIN</span>
        <div style={{marginLeft:"auto",fontSize:13,color:C.muted}}>{rosters.length} total</div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Pilot</th><th>Period</th><th>Duty days</th><th>Flights</th><th>Uploaded</th><th></th></tr></thead>
              <tbody>
                {loading&&<tr><td colSpan={6} style={{color:C.muted,textAlign:"center",padding:32}}><span className="spinner">⟳</span> Loading…</td></tr>}
                {!loading&&rosters.length===0&&<tr><td colSpan={6} style={{color:C.muted,textAlign:"center",padding:32}}>No rosters yet.</td></tr>}
                {rosters.map((r,i)=>(
                  <tr key={i} style={{cursor:"pointer"}} onClick={()=>setSelected({roster:r,pilotName:r.name||"--",pilotEmail:r.email||""})}>
                    <td style={{fontWeight:500,color:C.white}}>{r.name||"--"}<br/><span style={{fontSize:11,color:C.muted}}>{r.email||""}</span></td>
                    <td><span className="tag">{r.period_label||r.periodLabel}</span></td>
                    <td style={{fontFamily:FM,color:C.orange}}>{r.calendar?.filter(d=>d.flights?.length>0).length||0}</td>
                    <td style={{fontFamily:FM,color:C.silver}}>{r.calendar?.reduce((a,d)=>a+(d.flights?.length||0),0)||0}</td>
                    <td style={{color:C.muted,fontSize:12}}>{(r.uploaded_at||r.uploadedAt)?.slice(0,10)||"--"}</td>
                    <td style={{color:C.teal,fontSize:13}}>View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminAnalysis() {
  const [users,setUsers]=useState([]);
  const [rosters,setRosters]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    Promise.all([db_adminUsers(),db_adminAllRosters()]).then(([u,r])=>{
      setUsers(u); setRosters(r); setLoading(false);
    });
  },[]);

  if(loading) return <div style={{padding:32,textAlign:"center",color:C.muted}}><span className="spinner">⟳</span> Loading…</div>;

  const pilots = users.filter(u=>u.role!=="admin");
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthStr = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth()+1).padStart(2,"0")}`;

  // Signups this month
  const signupsThisMonth = pilots.filter(u=>u.joined?.startsWith(thisMonth)).length;
  const signupsLastMonth = pilots.filter(u=>u.joined?.startsWith(lastMonthStr)).length;

  // Rosters this month
  const rostersThisMonth = rosters.filter(r=>r.uploaded_at?.startsWith(thisMonth)).length;

  // Airlines breakdown
  const airlineMap = {};
  pilots.forEach(u=>{
    const al = u.airline_iata||u.airline_name||"Unknown";
    airlineMap[al]=(airlineMap[al]||0)+1;
  });
  const airlines = Object.entries(airlineMap).sort((a,b)=>b[1]-a[1]);

  // Signups by month (last 6 months)
  const months = [];
  for(let i=5;i>=0;i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const label = d.toLocaleString("default",{month:"short"});
    const count = pilots.filter(u=>u.joined?.startsWith(key)).length;
    months.push({key,label,count});
  }
  const maxCount = Math.max(...months.map(m=>m.count),1);

  return(
    <div style={{flex:1,overflowY:"auto",padding:16,background:C.base}}>
      <PageHeader title="Analysis"/>

      {/* KPI row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:16,marginTop:16}}>
        {[
          {label:"Total Pilots",value:pilots.length,color:C.green},
          {label:"This Month",value:signupsThisMonth,sub:`+${signupsThisMonth-signupsLastMonth} vs last month`,color:C.green},
          {label:"Pro Subscribers",value:pilots.filter(u=>u.plan==="pro").length,color:"#60A5FA"},
          {label:"Rosters This Month",value:rostersThisMonth,color:C.gold},
          {label:"Airlines",value:airlines.length,color:"#60A5FA"},
        ].map(({label,value,sub,color})=>(
          <div key={label} className="card" style={{textAlign:"center"}}>
            <div style={{fontSize:28,fontWeight:800,color,fontFamily:FM}}>{value}</div>
            <div style={{fontSize:11,fontWeight:600,color:C.ink,marginTop:2}}>{label}</div>
            {sub&&<div style={{fontSize:10,color:C.muted,marginTop:2}}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* Signup trend bar chart */}
      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:14}}>New Pilots -- Last 6 Months</div>
        <div style={{display:"flex",alignItems:"flex-end",gap:8,height:120}}>
          {months.map(m=>(
            <div key={m.key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <div style={{fontSize:11,fontWeight:700,color:C.green}}>{m.count||""}</div>
              <div style={{
                width:"100%",borderRadius:"4px 4px 0 0",
                background:m.key===thisMonth?C.teal:C.teal+"44",
                height:`${Math.max((m.count/maxCount)*90,m.count>0?8:2)}px`,
                transition:"height .3s",
              }}/>
              <div style={{fontSize:10,color:C.muted}}>{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Airlines breakdown */}
      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:12}}>Pilots by Airline</div>
        {airlines.length===0&&<div style={{fontSize:13,color:C.muted}}>No airline data yet.</div>}
        {airlines.map(([airline,count])=>(
          <div key={airline} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <div style={{fontSize:12,fontWeight:600,color:C.ink,minWidth:80}}>{airline}</div>
            <div style={{flex:1,height:8,borderRadius:4,background:C.border,overflow:"hidden"}}>
              <div style={{height:"100%",borderRadius:4,background:C.teal,width:`${(count/pilots.length)*100}%`,transition:"width .3s"}}/>
            </div>
            <div style={{fontSize:12,fontWeight:700,color:C.teal,minWidth:24,textAlign:"right"}}>{count}</div>
          </div>
        ))}
      </div>

      {/* Recent signups */}
      <div className="card">
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:12}}>Recent Signups</div>
        {pilots.slice(0,10).map(u=>(
          <div key={u.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{u.name||"--"}</div>
              <div style={{fontSize:11,color:C.muted}}>{u.email} · {u.airline_iata||"No airline"}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <span className={`pill ${u.plan==="pro"?"pill-orange":"pill-muted"}`}>{u.plan||"starter"}</span>
              <div style={{fontSize:10,color:C.muted,marginTop:2}}>{u.joined?.slice(0,10)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminSettings() {
  const configured=isConfigured();
  return (
    <div style={{maxWidth:580}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div className="section-title" style={{marginBottom:0}}>Admin Settings</div>
        <span className="admin-badge">ADMIN</span>
      </div>
      <div className={configured?"notice":"warn"} style={{marginBottom:20}}>
        {configured ? "✓ Supabase connected and active." : "⚠ Supabase not connected. Set environment variables to go live."}
      </div>
      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:12}}>Environment Variables (Vercel)</div>
        <p style={{fontSize:13,color:C.muted,marginBottom:16}}>Set these in your <code style={{color:C.green}}>.env</code> file locally and in Vercel → Project → Settings → Environment Variables.</p>
        {[
          ["VITE_SUPABASE_URL","https://your-project.supabase.co",configured?"✓":null],
          ["VITE_SUPABASE_ANON_KEY","eyJhbGci…",configured?"✓":null],
        ].map(([k,ph,ok])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{fontFamily:FM,fontSize:12,color:ok?C.green:C.teal,minWidth:240}}>{k}</div>
            <div style={{fontSize:12,color:C.muted}}>{ok?"Connected ✓":ph}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:12}}>Edge Function Secrets (Supabase)</div>
        <p style={{fontSize:13,color:C.muted,marginBottom:16}}>Set via Supabase Dashboard → Edge Functions → Manage secrets. Shared across all pilots -- never exposed to the browser.</p>
        {[
          ["ANTHROPIC_API_KEY","for AI roster parsing"],
          ["FLIGHTAWARE_API_KEY","for tail number & block time sync"],
        ].map(([k,desc])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{fontFamily:FM,fontSize:12,color:C.teal,minWidth:200}}>{k}</div>
            <div style={{fontSize:12,color:C.muted}}>{desc}</div>
          </div>
        ))}
      </div>
      <div className="card">
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:8}}>Stripe Subscriptions</div>
        <p style={{fontSize:13,color:C.muted,marginBottom:12}}>Connect Stripe via a Supabase Edge Function to handle Pro and Enterprise billing.</p>
        <div style={{fontFamily:FM,fontSize:12,color:C.muted,lineHeight:2}}>
          <div>1. Create products in Stripe Dashboard</div>
          <div>2. Add <span style={{color:C.green}}>STRIPE_SECRET_KEY</span> to Supabase secrets</div>
          <div>3. Deploy the webhook Edge Function</div>
          <div>4. Point Stripe webhook → your Edge Function URL</div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ADMIN CONTENT -- edit landing-page copy and a couple of app-wide switches
// (announcement banner, maintenance mode) without touching App.jsx. Backed
// by db_loadAppConfig/db_saveAppConfig; the landing page and the app shell
// itself read the same config at runtime.
// -----------------------------------------------------------------------------
function AdminContent() {
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(()=>{ db_loadAppConfig().then(setConfig); },[]);

  function set(k,v){ setConfig(p=>({...p,[k]:v})); setSaved(false); }

  async function save(){
    setSaving(true); setErr(""); setSaved(false);
    try { await db_saveAppConfig(config); setSaved(true); }
    catch(e){ setErr(e.message||"Save failed."); }
    setSaving(false);
  }

  if(!config) return <div style={{padding:32,color:C.muted}}><span className="spinner">⟳</span> Loading…</div>;

  const needsSetup = !!config._unconfigured;

  return(
    <div style={{maxWidth:640}}>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div className="section-title" style={{marginBottom:0}}>Landing Page & Content</div>
        <span className="admin-badge">ADMIN</span>
      </div>
      <p style={{fontSize:13,color:C.muted,marginBottom:16,lineHeight:1.6}}>
        Edit the marketing landing page's copy and a couple of app-wide switches here -- changes apply immediately, no code deploy needed.
      </p>

      {needsSetup&&(
        <div className="warn" style={{marginBottom:20,lineHeight:1.7}}>
          ⚠ One-time setup needed: this editor saves to a table that doesn't exist yet. Run this once in your Supabase SQL editor, then Save will work:
          <pre style={{marginTop:10,padding:12,background:"rgba(0,0,0,0.25)",borderRadius:8,fontSize:11.5,overflowX:"auto",whiteSpace:"pre-wrap"}}>
{`create table app_config (
  id int primary key,
  data jsonb not null default '{}',
  updated_at timestamptz
);
alter table app_config enable row level security;
create policy "Admins can read/write app_config"
  on app_config for all
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "Anyone can read app_config"
  on app_config for select using (true);`}
          </pre>
        </div>
      )}

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:4}}>Landing Page -- Hero</div>
        <p style={{fontSize:12,color:C.muted,marginBottom:14}}>The big two-line headline at the top of aviatesync.com.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <div><div className="form-label">Headline -- line 1</div><input className="form-input" value={config.heroHeadline1} onChange={e=>set("heroHeadline1",e.target.value)}/></div>
          <div><div className="form-label">Headline -- line 2</div><input className="form-input" value={config.heroHeadline2} onChange={e=>set("heroHeadline2",e.target.value)}/></div>
        </div>
        <div className="form-label">Subheadline</div>
        <textarea className="form-input" rows={2} value={config.heroSubhead} onChange={e=>set("heroSubhead",e.target.value)} style={{resize:"vertical",lineHeight:1.5}}/>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:4}}>Landing Page -- Pricing Section</div>
        <p style={{fontSize:12,color:C.muted,marginBottom:14}}>Headline copy above the pricing cards. Prices themselves stay code-controlled so they can never drift out of sync with what Stripe actually charges -- update those in App.jsx alongside your Stripe Price IDs.</p>
        <div className="form-label">Headline</div>
        <input className="form-input" value={config.pricingHeadline} onChange={e=>set("pricingHeadline",e.target.value)} style={{marginBottom:10}}/>
        <div className="form-label">Subheadline</div>
        <input className="form-input" value={config.pricingSubhead} onChange={e=>set("pricingSubhead",e.target.value)}/>
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:14,fontWeight:600,color:C.white}}>Announcement Banner</div>
          <button onClick={()=>set("announcementEnabled",!config.announcementEnabled)} style={{width:44,height:24,borderRadius:12,border:"none",cursor:"pointer",background:config.announcementEnabled?C.teal:C.border,position:"relative",flexShrink:0}}>
            <span style={{position:"absolute",top:2,left:config.announcementEnabled?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .15s"}}/>
          </button>
        </div>
        <p style={{fontSize:12,color:C.muted,marginBottom:10}}>A short dismissible banner shown at the top of the app to every pilot -- good for "new feature" or short-notice announcements.</p>
        <textarea className="form-input" rows={2} placeholder="e.g. New: Route Map now shows live weather radar!" value={config.announcementText} onChange={e=>set("announcementText",e.target.value)} disabled={!config.announcementEnabled} style={{resize:"vertical",lineHeight:1.5,opacity:config.announcementEnabled?1:0.5}}/>
      </div>

      <div className="card" style={{marginBottom:20}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
          <div style={{fontSize:14,fontWeight:600,color:C.white}}>Maintenance Mode</div>
          <button onClick={()=>set("maintenanceEnabled",!config.maintenanceEnabled)} style={{width:44,height:24,borderRadius:12,border:"none",cursor:"pointer",background:config.maintenanceEnabled?C.red:C.border,position:"relative",flexShrink:0}}>
            <span style={{position:"absolute",top:2,left:config.maintenanceEnabled?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .15s"}}/>
          </button>
        </div>
        <p style={{fontSize:12,color:C.muted,marginBottom:10}}>
          {config.maintenanceEnabled
            ? "⚠ Live now -- every pilot sees the maintenance message below instead of the app. Admin accounts are never blocked."
            : "When on, pilots see the message below instead of the app. Your own admin account is never blocked."}
        </p>
        <textarea className="form-input" rows={2} value={config.maintenanceMessage} onChange={e=>set("maintenanceMessage",e.target.value)} style={{resize:"vertical",lineHeight:1.5}}/>
      </div>

      {err&&<div className="warn" style={{marginBottom:14}}>{err}</div>}
      {saved&&<div className="notice" style={{marginBottom:14}}>✓ Saved -- live for every pilot now.</div>}
      <button className="btn-teal" onClick={save} disabled={saving} style={{padding:"11px 24px"}}>
        {saving?<span className="spinner">⟳</span>:"Save Changes"}
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// INSTALL PROMPT
// Listens for the browser's "beforeinstallprompt" event (fires on Android
// Chrome when the PWA criteria are met) and shows a small dismissible banner
// inviting the pilot to install the app to their home screen.
// -----------------------------------------------------------------------------
function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem("fl_install_dismissed") === "1"; } catch { return false; }
  });

  useEffect(() => {
    function onBeforeInstall(e) {
      e.preventDefault();
      setDeferredPrompt(e);
      if (!dismissed) setVisible(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, [dismissed]);

  if (!visible || !deferredPrompt) return null;

  async function handleInstall() {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setVisible(false);
  }

  function handleDismiss() {
    setVisible(false);
    try { sessionStorage.setItem("fl_install_dismissed", "1"); } catch {}
  }

  return (
    <div style={{
      position:"fixed", left:16, right:16, bottom:16, zIndex:200,
      background:C.ink, color:C.base, borderRadius:12, padding:"14px 16px",
      display:"flex", alignItems:"center", gap:12, boxShadow:"0 8px 30px rgba(0,0,0,.25)",
      maxWidth:420, margin:"0 auto",
    }}>
      <span style={{fontSize:24}}>📲</span>
      <div style={{flex:1}}>
        <div style={{fontSize:13,fontWeight:600}}>Install AviateSync</div>
        <div style={{fontSize:11,opacity:.75,marginTop:1}}>Add to your home screen for quick access</div>
      </div>
      <button onClick={handleInstall} style={{background:C.red,color:"#fff",border:"none",padding:"8px 14px",borderRadius:7,fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>Install</button>
      <button onClick={handleDismiss} style={{background:"none",border:"none",color:C.base,opacity:.6,fontSize:16,padding:4}}>✕</button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ROOT APP
// -----------------------------------------------------------------------------
const STRIPE_PK = "pk_live_51TjY9eFfOJrsbSPE5THy2lXaFHXolKUPZe2htnuyDELpGVmL7yjP9fbSokGyrb6VN9ft6xyseLU1zwTjJiFQMbvI005klt3GAS";
const CHECKOUT_URL = `${SUPA_URL}/functions/v1/create-checkout`;
const PORTAL_URL = `${SUPA_URL}/functions/v1/customer-portal`;
const REFERRAL_URL = `${SUPA_URL}/functions/v1/referral`;

function MembershipPage({user}) {
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("plan");
  const [referralData, setReferralData] = useState(null);
  const [refLoading, setRefLoading] = useState(false);
  const [refCode, setRefCode] = useState("");
  const [refApplied, setRefApplied] = useState(false);
  const [refApplyMsg, setRefApplyMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const isActive = user?.subscription_status === "active";
  const isPastDue = user?.subscription_status === "past_due";
  const interval = user?.subscription_interval || "month";
  const subEnd = user?.subscription_end
    ? new Date(user.subscription_end).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})
    : null;
  // stripe_customer_id is set exactly once, the moment a real Stripe
  // checkout completes (see stripe-webhook's checkout.session.completed
  // handler), and is never cleared afterward even if the subscription
  // later lapses or gets cancelled. That makes it the correct signal for
  // "has this person EVER actually subscribed" -- subscription_status
  // alone can't distinguish that, since it's null both for a brand-new
  // signup who's never subscribed AND could theoretically read the same
  // way for other non-active states; a new user should see no "Current
  // Plan" card at all (there's genuinely nothing to report), while a
  // lapsed subscriber should still see their own history.
  const hasSubscribedBefore = !!user?.stripe_customer_id;

  async function subscribe(billingInterval) {
    setLoading(billingInterval); setError("");
    try {
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(CHECKOUT_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({interval:billingInterval,successUrl:`${window.location.origin}?checkout=success`,cancelUrl:`${window.location.origin}?checkout=cancelled`}),
      });
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      window.location.href = data.url;
    } catch(e){ setError(e.message); }
    setLoading(null);
  }

  async function openPortal() {
    setLoading("portal"); setError("");
    try {
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(PORTAL_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({returnUrl:window.location.origin}),
      });
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      window.location.href = data.url;
    } catch(e){ setError(e.message); }
    setLoading(null);
  }

  async function loadReferral() {
    if(referralData) return;
    setRefLoading(true);
    try {
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(REFERRAL_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({action:"get-code"}),
      });
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      setReferralData(data);
    } catch(e){ setError(e.message); }
    setRefLoading(false);
  }

  async function applyCode() {
    if(!refCode.trim()) return;
    setLoading("apply"); setError("");
    try {
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(REFERRAL_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({action:"apply",code:refCode.trim()}),
      });
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      setRefApplied(true); setRefApplyMsg(data.message);
    } catch(e){ setError(e.message); }
    setLoading(null);
  }

  function copyLink() {
    if(referralData?.shareUrl) {
      navigator.clipboard.writeText(referralData.shareUrl).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
    }
  }

  function shareMsg() {
    if(navigator.share && referralData?.shareMessage) {
      navigator.share({title:"AviateSync",text:referralData.shareMessage,url:referralData.shareUrl});
    } else {
      navigator.clipboard.writeText(referralData?.shareMessage||"");
      setCopied(true); setTimeout(()=>setCopied(false),2000);
    }
  }

  return(
    <div style={{flex:1,overflowY:"auto",background:C.base,padding:"0 0 32px"}}>
      <PageHeader title="Manage Subscription"/>
      <div style={{padding:16}}>

        {/* PLAN TAB */}
        <>
          {hasSubscribedBefore&&(
            <div className="card" style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontSize:13,fontWeight:700,color:C.ink}}>Current Plan</div>
                <span className={`pill ${isActive?"pill-green":isPastDue?"pill-orange":"pill-muted"}`}>
                  {isActive?"Active":isPastDue?"Past Due":"Inactive"}
                </span>
              </div>
              <div style={{fontSize:24,fontWeight:800,color:"#1D4ED8",marginBottom:4}}>AviateSync Pro</div>
              {isActive&&<div style={{fontSize:12,color:C.muted}}>{interval==="year"?"Annual - $139.99/year - $11.67/mo":"Monthly - $14.99/month"}{subEnd&&` - Renews ${subEnd}`}</div>}
              {isPastDue&&<div style={{fontSize:12,color:C.red,marginTop:4}}>Payment failed - update your payment method</div>}
              {(isActive||isPastDue)&&(
                <button onClick={openPortal} disabled={loading==="portal"} style={{marginTop:12,padding:"9px 16px",borderRadius:8,background:"none",border:"1px solid #E2E8F0",color:C.muted,fontSize:13,cursor:"pointer"}}>
                  {loading==="portal"?<span className="spinner">loading</span>:"Manage billing"}
                </button>
              )}
            </div>
          )}

          <div className="card" style={{marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:12}}>Everything included</div>
            {["PDF roster parsing -- any airline","Auto tail number & block time sync","FAR 61.57 & 117 currency tracking","Jeppesen & ASA export","Route maps with live radar","Flight briefings","Unlimited roster history"].map(f=>(
              <div key={f} style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="8" fill={C.teal}/><path d="M4.5 8L6.8 10.5L11.5 5.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span style={{fontSize:13,color:C.ink}}>{f}</span>
              </div>
            ))}
          </div>

          {!isActive&&!isPastDue&&(<>
            <div style={{textAlign:"center",marginBottom:18}}>
              <div style={{fontSize:18,fontWeight:800,color:C.ink,marginBottom:4}}>Simple, honest pricing</div>
              <div style={{fontSize:12.5,color:C.muted,lineHeight:1.5}}>One plan, everything included. No feature tiers, no hidden fees.</div>
            </div>

            {/* Annual hero */}
            <div style={{marginBottom:10,padding:20,borderRadius:14,background:`linear-gradient(135deg,${C.teal},${C.tealDim})`,position:"relative",overflow:"visible"}}>
              <div style={{position:"absolute",top:-12,left:"50%",transform:"translateX(-50%)",background:"#fff",color:C.teal,fontSize:10,fontWeight:800,padding:"4px 14px",borderRadius:100,letterSpacing:"1px",whiteSpace:"nowrap",boxShadow:"0 2px 8px rgba(0,0,0,0.15)"}}>BEST VALUE -- SAVE 22%</div>
              <div style={{position:"absolute",top:4,right:4,width:60,height:60,borderRadius:"50%",background:"rgba(255,255,255,0.08)"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,marginTop:8}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:"#fff"}}>Annual Plan</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,0.75)"}}>Just $11.67/month</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:24,fontWeight:900,color:"#fff",letterSpacing:"-1px"}}>$139.99</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.7)"}}>/year</div>
                </div>
              </div>
              {/* Annual-only features */}
              <div style={{marginBottom:14}}>
                {["Everything in monthly","Over 2 months free","Locked-in rate","Priority support"].map(f=>(
                  <div key={f} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="7" fill="rgba(255,255,255,0.25)"/><path d="M3.5 7L5.8 9.5L10.5 4.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span style={{fontSize:12,color:"rgba(255,255,255,0.9)"}}>{f}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={()=>subscribe("year")}
                disabled={!!loading}
                style={{
                  width:"100%",padding:"13px",borderRadius:10,
                  background:loading==="year"?"rgba(255,255,255,0.7)":"#fff",
                  border:"none",color:C.teal,fontSize:14,fontWeight:700,
                  cursor:loading?"not-allowed":"pointer",
                  transition:"all .15s",
                  opacity:loading&&loading!=="year"?0.7:1,
                }}
              >
                {loading==="year"
                  ?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,color:C.green}}><span className="spinner">⟳</span> Processing...</span>
                  :"Subscribe Annual -- $139.99/year →"}
              </button>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",textAlign:"center",marginTop:8}}>30-day money-back guarantee</div>
            </div>

            {/* Monthly */}
            <div className="card" style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div>
                  <div style={{fontSize:14,fontWeight:600,color:C.ink}}>Monthly</div>
                  <div style={{fontSize:12,color:C.muted}}>Flexible -- cancel anytime</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:22,fontWeight:800,color:C.ink}}>$14.99</div>
                  <div style={{fontSize:11,color:C.muted}}>/month</div>
                </div>
              </div>
              <div style={{marginBottom:14}}>
                {["All features","Cancel anytime","30-day refund"].map(f=>(
                  <div key={f} style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="7" fill={C.teal+"18"}/><path d="M3.5 7L5.8 9.5L10.5 4.5" stroke={C.teal} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    <span style={{fontSize:12,color:C.silver}}>{f}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={()=>subscribe("month")}
                disabled={!!loading}
                style={{
                  width:"100%",padding:"12px",borderRadius:10,
                  background:loading==="month"?C.teal+"22":"none",
                  border:`1.5px solid ${loading==="month"?C.teal:C.border}`,
                  color:loading==="month"?C.teal:C.silver,
                  fontSize:13,fontWeight:600,
                  cursor:loading?"not-allowed":"pointer",
                  transition:"all .15s",
                  opacity:loading&&loading!=="month"?0.7:1,
                }}
              >
                {loading==="month"
                  ?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><span className="spinner">⟳</span> Processing...</span>
                  :"Subscribe Monthly -- $14.99/mo"}
              </button>
            </div>

            {!user?.referred_by&&!refApplied&&(
              <div className="card" style={{marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:8}}>Have a referral code?</div>
                <div style={{display:"flex",gap:8}}>
                  <input value={refCode} onChange={e=>setRefCode(e.target.value.toUpperCase())} placeholder="Enter code (e.g. FLY2026)" style={{flex:1,padding:"9px 12px",borderRadius:8,border:"1px solid #E2E8F0",background:C.surface,color:C.ink,fontSize:13,fontFamily:"monospace",letterSpacing:"1px"}}/>
                  <button onClick={applyCode} disabled={!refCode.trim()||loading==="apply"} style={{padding:"9px 14px",borderRadius:8,background:C.teal,border:"none",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                    {loading==="apply"?<span className="spinner">loading</span>:"Apply"}
                  </button>
                </div>
              </div>
            )}
            {refApplied&&<div style={{padding:"10px 14px",borderRadius:8,background:C.green+"15",border:`1px solid ${C.green}44`,color:C.green,fontSize:13,marginBottom:14}}>{refApplyMsg}</div>}
            {user?.referred_by&&!refApplied&&<div style={{padding:"10px 14px",borderRadius:8,background:C.greenBg,border:`1px solid ${C.teal}33`,color:C.teal,fontSize:12,marginBottom:14}}>Referral applied - your referrer earns a free month when you subscribe</div>}
          </>)}

          {error&&<div style={{padding:"10px 14px",borderRadius:8,background:C.red+"15",border:`1px solid ${C.red}44`,color:C.red,fontSize:13,marginTop:8}}>{error}</div>}
          <div style={{fontSize:11,color:C.muted,textAlign:"center",marginTop:12}}>Secured by Stripe - 30-day money-back guarantee</div>
        </>
      </div>
    </div>
  );
}


function ReferralPage({user}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  useEffect(()=>{
    (async()=>{
      try{
        const token=sb.auth._token||SUPA_ANON;
        const res=await fetch(REFERRAL_URL,{
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
          body:JSON.stringify({action:"get-code"}),
        });
        const d=await res.json();
        if(d.error)throw new Error(d.error);
        setData(d);
      }catch(e){setErr(e.message);}
      setLoading(false);
    })();
  },[]);

  function copyLink(){
    if(data?.shareUrl){
      navigator.clipboard.writeText(data.shareUrl).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);});
    }
  }

  function share(){
    if(navigator.share&&data?.shareMessage){
      navigator.share({title:"AviateSync",text:data.shareMessage,url:data.shareUrl});
    } else {
      copyLink();
    }
  }

  return(
    <div style={{flex:1,overflowY:"auto",background:C.base}}>
      <PageHeader title="Refer & Earn"/>
      <div style={{padding:16}}>
        {loading&&<div style={{textAlign:"center",padding:40,color:C.muted}}><span className="spinner">⟳</span></div>}
        {err&&<div style={{padding:"10px 14px",borderRadius:8,background:C.red+"15",color:C.red,fontSize:13}}>{err}</div>}
        {data&&(<>
          {/* How it works */}
          <div style={{marginBottom:14,padding:20,borderRadius:14,background:`linear-gradient(135deg,${C.teal},${C.tealDim})`,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:-20,right:-20,width:100,height:100,borderRadius:"50%",background:"rgba(255,255,255,0.08)"}}/>
            <div style={{fontSize:16,fontWeight:700,color:"#fff",marginBottom:4}}>Refer a pilot, get a free month</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.8)",marginBottom:16}}>For every pilot you refer who subscribes, you get a free month -- a $14.99 credit -- on your next bill.</div>
            {[["1","Share your unique referral code or link"],["2","Your friend subscribes to AviateSync"],["3","You automatically get a free month credited to your account"]].map(([n,t])=>(
              <div key={n} style={{display:"flex",gap:12,alignItems:"center",marginBottom:10}}>
                <div style={{width:24,height:24,borderRadius:"50%",background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#fff",flexShrink:0}}>{n}</div>
                <div style={{fontSize:13,color:"rgba(255,255,255,0.9)"}}>{t}</div>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
            {[
              {label:"Referred",val:data.referrals||0},
              {label:"Subscribed",val:data.converted||0},
              {label:"Credits",val:`$${((data.credits||0)*14.99).toFixed(2)}`},
            ].map(s=>(
              <div key={s.label} className="card" style={{textAlign:"center",padding:"14px 8px"}}>
                <div style={{fontSize:24,fontWeight:800,color:C.teal,letterSpacing:"-1px"}}>{s.val}</div>
                <div style={{fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginTop:4}}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Code */}
          <div className="card" style={{marginBottom:14}}>
            <div style={{fontSize:12,color:C.muted,fontWeight:600,marginBottom:8,textTransform:"uppercase",letterSpacing:".5px"}}>Your referral code</div>
            <div style={{padding:"18px",borderRadius:10,background:"#F1F5F9",border:"1px solid #E2E8F0",textAlign:"center",marginBottom:12}}>
              <div style={{fontSize:30,fontWeight:900,color:C.teal,letterSpacing:"5px",fontFamily:"monospace"}}>{data.code}</div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={copyLink} style={{flex:1,padding:"12px",borderRadius:10,background:"#F1F5F9",border:"1px solid #E2E8F0",color:C.ink,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                {copied?"✓ Copied!":"Copy link"}
              </button>
              <button onClick={share} style={{flex:1,padding:"12px",borderRadius:10,background:C.teal,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                Share →
              </button>
            </div>
          </div>

          {/* Referrals list */}
          {data.referralList?.length>0?(
            <div className="card">
              <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:12}}>Your referrals</div>
              {data.referralList.map((r,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:i<data.referralList.length-1?`1px solid ${C.border}`:"none"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:C.ink}}>{r.name||"Pilot"}</div>
                    <div style={{fontSize:11,color:C.muted}}>{r.joined?.slice(0,10)}</div>
                  </div>
                  <span className={`pill ${r.converted?"pill-green":"pill-muted"}`}>
                    {r.converted?"Subscribed ✓":"Pending"}
                  </span>
                </div>
              ))}
            </div>
          ):(
            <div className="card" style={{textAlign:"center",padding:"28px 16px"}}>
              <div style={{fontSize:13,color:C.muted}}>No referrals yet -- share your code with pilots in your crew room or Facebook aviation groups</div>
            </div>
          )}
        </>)}
      </div>
    </div>
  );
}

function ExportPage({rosters, tails}) {
  const now = new Date();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [inclCancelled, setInclCancelled] = useState(false);
  // Category filter -- restrict export to only flights matching one time
  // category. Classification reuses the same aircraft-type heuristic as the
  // Stats page (classifyAcType). NOTE: this does NOT apply a pilot's custom
  // Time Rules (per-date PIC/SIC/multi/turbine overrides) since ExportPage
  // isn't currently threaded with that data -- it reflects the same
  // aircraft-type-based default the Stats page falls back to when no rule
  // is set for a date.
  const [exportFilter, setExportFilter] = useState("all"); // all|pic|sic|turbine|single|multi
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  function classifyAcType(acType) {
    const t=(acType||"").toUpperCase();
    const isMulti=/B73[78H]|B737|B738|B739|B74[78]|B767|B772|B77[789]|B787|A3[0-9]{2}|CRJ|CR[79]|E7[05]|E170|E175|E190|ERJ/i.test(t);
    const isTurbine=isMulti||/DH8|ATR|SF3/i.test(t);
    const isSingle=!isMulti&&/C172|PA28|BE[123]/i.test(t);
    return {isMulti,isTurbine,isSingle};
  }
  function matchesCategory(f) {
    if(exportFilter==="all") return true;
    const isPIC = f.loggedPicMins!=null ? f.loggedPicMins>0 : false;
    const isSIC = f.loggedSicMins!=null ? f.loggedSicMins>0 : !( f.loggedPicMins!=null && f.loggedPicMins>0 );
    const acClass = classifyAcType(f.acType);
    if(exportFilter==="pic") return isPIC;
    if(exportFilter==="sic") return isSIC;
    if(exportFilter==="turbine") return acClass.isTurbine;
    if(exportFilter==="single") return acClass.isSingle;
    if(exportFilter==="multi") return acClass.isMulti;
    return true;
  }

  // Quick date selectors
  function setRange(months) {
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - months);
    setDateFrom(from.toISOString().slice(0,10));
    setDateTo(to.toISOString().slice(0,10));
  }
  function setAllTime() { setDateFrom(""); setDateTo(""); }

  // Filter rosters/tails by date range
  function filteredFlights() {
    const results = [];
    (rosters||[]).forEach(r => {
      const mNum = r.monthNum??r.month_num??0;
      (r.calendar||[]).forEach((d,di) => {
        (d.flights||[]).forEach((f,fi) => {
          const dateStr = `${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
          if(dateFrom && dateStr < dateFrom) return;
          if(dateTo && dateStr > dateTo) return;
          const tk = `${r.id}-${di}-${fi}`;
          const t = tails[tk]||{};
          if(!inclCancelled && t.cancelled) return;
          if(!matchesCategory(f)) return;
          results.push({f, d, di, fi, r, tk, t, dateStr});
        });
      });
    });
    return results;
  }

  const flights = filteredFlights();
  const synced = flights.filter(x=>x.t.tail).length;
  const total = flights.length;

  function doExport(type) {
    if(total===0) return;
    if(type==="csv") {
      const rows = [["Date","Day","Flight","Dep","SchedDep","ActualDep","Arr","SchedArr","ActualArr","AircraftType","Tail","SchedBlock","ActualBlock","Period","Remarks"]];
      flights.forEach(({f,d,t,r,dateStr}) => {
        const block = t.actualBlockMins!=null?fmtMins(t.actualBlockMins):"";
        const sb2 = schedMins(f)!=null?fmtMins(schedMins(f)):"";
        rows.push([dateStr,d.dow,f.flightNum,f.dep,f.depTime,t.actualDep||"",f.arr,f.arrTime,t.actualArr||"",f.acType||"",t.tail||"",sb2,block,r.periodLabel||"",t.remarks||""]);
      });
      downloadCsv("aviatesync-export.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    } else if(type==="jeppesen") {
      const rows = [["Date","Flight No","From","To","Departure Time","Arrival Time","Aircraft Make & Model","Aircraft Ident","Total Duration","Night","Actual Instrument","Simulated Instrument","Cross Country","Dual Received","Pilot in Command","Solo","Ground Trainer","Remarks"]];
      flights.forEach(({f,d,t,r,dateStr}) => {
        const block = t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
        rows.push([dateStr,f.flightNum,f.dep,f.arr,t.actualDep||f.depTime,t.actualArr||f.arrTime,f.acType||"","N/"+(t.tail||""),block,"","","","","",block,"","",t.remarks||""]);
      });
      downloadCsv("aviatesync-jeppesen.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    } else if(type==="asa") {
      const rows = [["Date","Aircraft Make/Model","Aircraft Ident","Route From","Route To","Total Flight Time","Night","Actual IMC","Simulated IMC","Cross-Country","Dual","PIC","Solo","Approaches","Remarks"]];
      flights.forEach(({f,d,t,r,dateStr}) => {
        const block = t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
        rows.push([dateStr,f.acType||"","N/"+(t.tail||""),f.dep,f.arr,block,"","","","",block,"","","",t.remarks||""]);
      });
      downloadCsv("aviatesync-asa.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    }
  }

  return (
    <div style={{flex:1,overflowY:"auto",background:C.base}}>
      <PageHeader title="Export Logbook"/>
      <div style={{padding:16}}>

        {/* Category filter -- restricts the export to one time category */}
        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10,position:"relative"}}>
          <button
            onClick={()=>setFilterPanelOpen(o=>!o)}
            style={{display:"flex",alignItems:"center",gap:6,padding:"7px 12px",borderRadius:10,border:`1px solid ${exportFilter!=="all"?C.teal:C.border}`,background:exportFilter!=="all"?`${C.teal}12`:C.surface,color:exportFilter!=="all"?C.teal:C.muted,fontSize:12,fontWeight:700,cursor:"pointer"}}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
            {exportFilter==="all"?"Filter":{pic:"PIC only",sic:"SIC only",turbine:"Turbine only",single:"Single-engine only",multi:"Multi-engine only"}[exportFilter]}
          </button>
          {filterPanelOpen&&(
            <>
              <div onClick={()=>setFilterPanelOpen(false)} style={{position:"fixed",inset:0,zIndex:20}}/>
              <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,zIndex:21,background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,boxShadow:"0 12px 32px rgba(0,0,0,0.14)",padding:8,minWidth:200,display:"flex",flexDirection:"column",gap:2}}>
                {[["all","All flights"],["pic","PIC time only"],["sic","SIC time only"],["turbine","Turbine time only"],["single","Single-engine time only"],["multi","Multi-engine time only"]].map(([val,label])=>(
                  <button
                    key={val}
                    onClick={()=>{setExportFilter(val);setFilterPanelOpen(false);}}
                    style={{textAlign:"left",padding:"9px 10px",borderRadius:9,border:"none",background:exportFilter===val?C.blueBg:"none",color:exportFilter===val?C.teal:C.ink,fontSize:13,fontWeight:exportFilter===val?700:500,cursor:"pointer"}}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Stats */}
        <div className="card" style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            {[{label:"Flights",val:total,color:C.green},{label:"Synced",val:synced,color:C.green},{label:"Rosters",val:(rosters||[]).length,color:C.ink}].map(({label,val,color})=>(
              <div key={label} style={{textAlign:"center",flex:1}}>
                <div style={{fontSize:22,fontWeight:800,color}}>{val}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div className="card" style={{marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:10}}>Date range</div>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            {[["3M",3],["6M",6],["1Y",12],["All",null]].map(([label,months])=>(
              <button key={label} onClick={()=>months?setRange(months):setAllTime()} style={{
                flex:1,padding:"7px 4px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",border:"none",
                background:(!dateFrom&&!dateTo&&label==="All")||(months&&dateFrom)?C.teal+"18":C.panel,
                color:(!dateFrom&&!dateTo&&label==="All")?C.teal:C.muted,
              }}>{label}</button>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <div>
              <div className="form-label">From</div>
              <input className="form-input" type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} style={{fontSize:13}}/>
            </div>
            <div>
              <div className="form-label">To</div>
              <input className="form-input" type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} style={{fontSize:13}}/>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="card" style={{marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:10}}>Filters</div>
          {[
            {label:"Include cancelled flights",val:inclCancelled,set:setInclCancelled},
          ].map(({label,val,set})=>(
            <div key={label} onClick={()=>set(p=>!p)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",cursor:"pointer"}}>
              <span style={{fontSize:13,color:C.ink}}>{label}</span>
              <div style={{width:40,height:22,borderRadius:11,background:val?C.teal:C.border,transition:"background .2s",position:"relative",flexShrink:0}}>
                <div style={{position:"absolute",top:2,left:val?20:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Export buttons */}
        <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10}}>Export format</div>
        {[
          {type:"csv",      fmt:"CSV Universal",   desc:"All fields -- Excel & Google Sheets", color:C.green},
          {type:"jeppesen", fmt:"Jeppesen Format",  desc:"Matches Jeppesen logbook columns",   color:"#1D4ED8"},
          {type:"asa",      fmt:"ASA Standard",     desc:"Matches ASA-SP-30 logbook columns",  color:"#16A34A"},
        ].map(({type,fmt,desc,color})=>(
          <div key={type} className="card" style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:14,fontWeight:700,color:C.ink}}>{fmt}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:2}}>{desc}</div>
              </div>
              <button onClick={()=>doExport(type)} disabled={total===0} style={{
                padding:"9px 18px",borderRadius:9,
                background:total===0?C.panel:color,
                border:"none",color:total===0?C.muted:"#fff",
                fontSize:13,fontWeight:700,cursor:total===0?"not-allowed":"pointer",
                flexShrink:0,marginLeft:12,
                display:"flex",alignItems:"center",gap:6,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke={total===0?C.muted:"#fff"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke={total===0?C.muted:"#fff"} strokeWidth="2.5" strokeLinecap="round"/></svg>
                {total===0?"No data":"Export"}
              </button>
            </div>
          </div>
        ))}
        <div style={{fontSize:11,color:C.muted,textAlign:"center",marginTop:8}}>
          {total} flight{total!==1?"s":""} selected · {synced} synced with tail numbers
        </div>
      </div>
    </div>
  );
}

function SupportPage({user}) {
  const [subject,setSubject]=useState("");
  const [message,setMessage]=useState("");
  const [sent,setSent]=useState(false);
  return (
    <div style={{flex:1,overflowY:"auto",background:C.base,padding:"24px 16px"}}>
      <PageHeader title="Support"/>
      <div style={{padding:16}}>
      {sent?(
        <div className="card" style={{textAlign:"center",padding:"32px"}}>
          <div style={{fontSize:40,marginBottom:12}}>checkmark</div>
          <div style={{fontSize:16,fontWeight:700,color:C.ink,marginBottom:4}}>Ticket submitted</div>
          <div style={{fontSize:13,color:C.muted}}>We will respond to {user?.email} within 24 hours.</div>
        </div>
      ):(
        <div className="card">
          <div style={{marginBottom:12}}>
            <div className="form-label">Subject</div>
            <input className="form-input" placeholder="Describe your issue briefly" value={subject} onChange={e=>setSubject(e.target.value)}/>
          </div>
          <div style={{marginBottom:16}}>
            <div className="form-label">Message</div>
            <textarea className="form-input" placeholder="Describe your issue in detail..." value={message} onChange={e=>setMessage(e.target.value)} rows={5} style={{resize:"vertical"}}/>
          </div>
          <button onClick={()=>{if(subject&&message)setSent(true);}} style={{width:"100%",padding:"12px",borderRadius:10,background:C.teal,border:"none",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
            Submit Ticket
          </button>
        </div>
      )}
      <div className="card" style={{marginTop:14}}>
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:8}}>Quick Help</div>
        {[["How do I upload a roster?","Go to the Upload tab and drag your PDF roster file."],
          ["Why is my flight not syncing?","FlightAware data appears within 15 min after landing. Tap Auto on the flight to manually trigger."],
          ["Can I edit times manually?","Yes -- open any flight in the Logbook and tap Edit."],
          ["What airlines are supported?","Any airline roster in PDF format -- major and regional carriers, and more."],
        ].map(([q,a])=>(
          <div key={q} style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${C.border}`}}>
            <div style={{fontSize:12,fontWeight:600,color:C.ink,marginBottom:3}}>{q}</div>
            <div style={{fontSize:11,color:C.muted}}>{a}</div>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

// --- DESKTOP SIDEBAR ----------------------------------------------------------
function DesktopSidebar({user, page, setPage, onLogout}) {
  const isAdmin = user?.role === "admin";
  const pilotNav = [
    {id:"dashboard", label:"Home", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 12L12 3L21 12V21H15V15H9V21H3V12Z" fill={c}/></svg>},
    {id:"logbook",   label:"Logbook", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="13" height="18" rx="2" stroke={c} strokeWidth="2" fill="none"/><path d="M8 7H13M8 11H11" stroke={c} strokeWidth="2" strokeLinecap="round"/><circle cx="17" cy="17" r="4" fill={c}/><path d="M17 15.5V17L18.5 18" stroke={C.surface} strokeWidth="1.5" strokeLinecap="round"/></svg>},
    {id:"add-flight",label:"Add Flight", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none"/><path d="M12 8v8M8 12h8" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"upload",    label:"Upload Roster", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 4L12 15M12 4L8 8M12 4L16 8" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V17" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"analytics", label:"Stats", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={c}/><rect x="10" y="7" width="4" height="14" rx="1" fill={c}/><rect x="17" y="3" width="4" height="18" rx="1" fill={c}/></svg>},
    {id:"map",       label:"Route Map", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 4L3 7v13l6-3 6 3 6-3V4l-6 3-6-3z" stroke={c} strokeWidth="2" strokeLinejoin="round" fill="none"/><path d="M9 4v13M15 7v13" stroke={c} strokeWidth="2"/></svg>},
    {id:"export",    label:"Export Logbook", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 15L12 4M12 15L8 11M12 15L16 11" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V17" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"subscriptions",label:"Subscriptions", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2" stroke={c} strokeWidth="2" fill="none"/><path d="M2 10H22" stroke={c} strokeWidth="2"/></svg>},
    {id:"referral",  label:"Refer & Earn", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke={c} strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke={c} strokeWidth="2"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"support",   label:"Support", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={c} strokeWidth="2"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"profile",   label:"Profile", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke={c} strokeWidth="2" fill="none"/><path d="M4 20C4 17 7.6 15 12 15C16.4 15 20 17 20 20" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"settings",  label:"Settings", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={c} strokeWidth="2" fill="none"/><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none"/></svg>},
  ];
  const adminNav = [
    {id:"admin-overview", label:"Overview", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill={c}/><rect x="14" y="3" width="7" height="7" rx="1" fill={c}/><rect x="3" y="14" width="7" height="7" rx="1" fill={c}/><rect x="14" y="14" width="7" height="7" rx="1" fill={c}/></svg>},
    {id:"admin-users",    label:"Users", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="7" r="4" stroke={c} strokeWidth="2" fill="none"/><path d="M3 20C3 17 5.7 15 9 15" stroke={c} strokeWidth="2" strokeLinecap="round"/><path d="M16 11C17.7 11 19 12.3 19 14C19 15.7 17.7 17 16 17" stroke={c} strokeWidth="2" strokeLinecap="round"/><path d="M13 20C13 18 14.3 16.5 16 16.5C17.7 16.5 21 17.5 21 20" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-audit",    label:"Audit Logs", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke={c} strokeWidth="2"/><path d="M21 21l-4.3-4.3" stroke={c} strokeWidth="2" strokeLinecap="round"/><path d="M8 11h6M8 8h3" stroke={c} strokeWidth="1.5" strokeLinecap="round"/></svg>},
    {id:"admin-analysis", label:"Analysis", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={c}/><rect x="10" y="7" width="4" height="14" rx="1" fill={c}/><rect x="17" y="3" width="4" height="18" rx="1" fill={c}/></svg>},
    {id:"admin-rosters",  label:"All Rosters", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" stroke={c} strokeWidth="2" fill="none"/><path d="M8 13H16M8 17H13" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-settings", label:"Admin Settings", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={c} strokeWidth="2" fill="none"/><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none"/></svg>},
    {id:"admin-content",  label:"Landing Page & Content", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 5a2 2 0 012-2h8l6 6v10a2 2 0 01-2 2H6a2 2 0 01-2-2V5z" stroke={c} strokeWidth="2" strokeLinejoin="round"/><path d="M14 3v6h6" stroke={c} strokeWidth="2" strokeLinejoin="round"/><path d="M8 13h8M8 17h5" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
  ];
  const navItems = isAdmin ? adminNav : pilotNav;
  return (
    <div style={{width:220,height:"100%",background:C.surface,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",flexShrink:0}}>
      <div style={{padding:"20px 20px 16px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontSize:18,fontWeight:800,color:C.teal,letterSpacing:"-.5px"}}>Aviate<span style={{color:C.ink}}>Sync</span></div>
        {isAdmin&&<div style={{fontSize:10,fontWeight:700,color:C.red,letterSpacing:"1px",marginTop:2}}>ADMIN CONSOLE</div>}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"8px 0"}}>
        {navItems.map(item=>{
          const isActive=page===item.id;
          const color=isActive?C.teal:C.muted;
          return(
            <button key={item.id} onClick={()=>setPage(item.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 20px",border:"none",background:"none",cursor:"pointer",textAlign:"left",borderLeft:`3px solid ${isActive?C.teal:"transparent"}`,backgroundColor:isActive?C.teal+"10":"transparent",transition:"all .1s"}}>
              {item.icon(color)}
              <span style={{fontSize:13,fontWeight:isActive?600:400,color}}>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{padding:"12px 20px",borderTop:`1px solid ${C.border}`}}>
        <div style={{fontSize:12,fontWeight:600,color:C.ink,marginBottom:2}}>{user?.name}</div>
        <div style={{fontSize:11,color:C.muted,marginBottom:10}}>{isAdmin?"Administrator":"Pilot"}</div>
        <button onClick={onLogout} style={{width:"100%",padding:"7px",borderRadius:7,background:"none",border:"1px solid #E2E8F0",color:C.muted,fontSize:12,cursor:"pointer"}}>Sign Out</button>
      </div>
    </div>
  );
}

// --- BOTTOM TAB BAR -----------------------------------------------------------
// New 5-slot layout: Dashboard | Stats | + (popup: Add Flight / Upload Roster) | Logbook | More
const TAB_PAGES = ["dashboard","analytics","add-flight","logbook","more"];
const MORE_PAGES = ["map","profile","settings","subscriptions","support","export","referral"];

function BottomTabBar({page, setPage, user}) {
  const isAdmin = user?.role === "admin";
  const ADMIN_TAB_PAGES = ["admin-overview","admin-users","admin-analysis","admin-rosters","more"];
  const active = isAdmin
    ? (ADMIN_TAB_PAGES.includes(page)?page:page==="admin-settings"||page==="admin-content"||page==="profile"?"more":"admin-overview")
    : (TAB_PAGES.includes(page)?page:MORE_PAGES.includes(page)?"more":"dashboard");

  const BLUE = C.teal;
  const MUTED = C.muted;
  const [showAddPopup, setShowAddPopup] = useState(false);

  const pilotTabs = [
    {
      id:"dashboard",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 12L12 3L21 12V21H15V15H9V21H3V12Z" fill={active?BLUE:MUTED}/>
        </svg>
      ),
    },
    {
      id:"analytics",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M3 17l5-5.5 4 3L21 6" stroke={active?BLUE:MUTED} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M15 6h6v6" stroke={active?BLUE:MUTED} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      id:"add-flight",
      // Tapping the center + button doesn't navigate directly anymore --
      // it opens a small popup with Add Flight / Upload Roster choices.
      isPopupTrigger: true,
      icon:(active)=>(
        <div style={{width:34,height:34,borderRadius:11,background:showAddPopup?BLUE:"linear-gradient(135deg,#1D4ED8,#3B82F6)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:showAddPopup?"0 3px 10px rgba(29,78,216,0.4)":"0 3px 10px rgba(29,78,216,0.3)",transition:"transform .15s",transform:showAddPopup?"rotate(45deg)":"none"}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/></svg>
        </div>
      ),
    },
    {
      id:"logbook",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="4" y="2" width="13" height="18" rx="2" stroke={active?BLUE:MUTED} strokeWidth="2" fill="none"/>
          <path d="M8 7h6M8 11h4" stroke={active?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id:"more",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M4 6h16M4 12h16M4 18h16" stroke={active?BLUE:MUTED} strokeWidth="2.3" strokeLinecap="round"/>
        </svg>
      ),
    },
  ];

  const adminTabs = [
    {id:"admin-overview",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="14" y="3" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="3" y="14" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="14" y="14" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/></svg>},
    {id:"admin-users",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="7" r="4" stroke={a?BLUE:MUTED} strokeWidth="2" fill="none"/><path d="M3 20c0-3 2.7-5 6-5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/><path d="M16 11c1.7 0 3 1.3 3 3s-1.3 3-3 3M13 20c0-2 1.3-3.5 3-3.5s5 1 5 3.5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-analysis",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={a?BLUE:MUTED}/><rect x="10" y="7" width="4" height="14" rx="1" fill={a?BLUE:MUTED}/><rect x="17" y="3" width="4" height="18" rx="1" fill={a?BLUE:MUTED}/></svg>},
    {id:"admin-rosters",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke={a?BLUE:MUTED} strokeWidth="2" fill="none"/><path d="M8 13h8M8 17h5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"more",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke={a?BLUE:MUTED} strokeWidth="2.3" strokeLinecap="round"/></svg>},
  ];

  const tabs = isAdmin ? adminTabs : pilotTabs;

  return (
    <>
      {/* Plus-button popup -- Add Flight / Upload Roster small choice cards */}
      {showAddPopup && (
        <>
          <div
            onClick={()=>setShowAddPopup(false)}
            style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.4)",backdropFilter:"blur(2px)",zIndex:998}}
          />
          <div style={{
            position:"fixed",bottom:"calc(64px + env(safe-area-inset-bottom, 0px))",left:"50%",
            transform:"translateX(-50%)",zIndex:999,
            display:"flex",gap:12,padding:"0 20px",width:"100%",maxWidth:380,boxSizing:"border-box",
          }}>
            <button
              onClick={()=>{setShowAddPopup(false);setPage("add-flight");}}
              style={{
                flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:8,
                padding:"16px 12px",borderRadius:18,background:C.surface,
                border:`1px solid ${C.border}`,cursor:"pointer",
                boxShadow:"0 8px 24px rgba(0,0,0,0.18)",
                animation:"popIn .18s ease-out",
              }}
            >
              <div style={{width:40,height:40,borderRadius:12,background:`${BLUE}18`,display:"flex",alignItems:"center",justifyContent:"center"}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={BLUE} strokeWidth="2"/><path d="M12 8v8M8 12h8" stroke={BLUE} strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <span style={{fontSize:13,fontWeight:700,color:C.ink}}>Add Flight</span>
            </button>
            <button
              onClick={()=>{setShowAddPopup(false);setPage("upload");}}
              style={{
                flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:8,
                padding:"16px 12px",borderRadius:18,
                background:`linear-gradient(135deg,${BLUE},#3B82F6)`,
                border:"none",cursor:"pointer",
                boxShadow:"0 8px 24px rgba(29,78,216,0.35)",
                animation:"popIn .18s ease-out .03s backwards",
              }}
            >
              <div style={{width:40,height:40,borderRadius:12,background:"rgba(255,255,255,0.2)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M12 4L8 8M12 4l4 4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>
              </div>
              <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>Upload Roster</span>
            </button>
          </div>
          <style>{`@keyframes popIn{from{opacity:0;transform:translateY(8px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}`}</style>
        </>
      )}

      <nav style={{
        display:"flex",
        justifyContent:"space-evenly",
        alignItems:"center",
        background:C.surface,
        borderTop:`1px solid ${C.border}`,
        boxShadow:"0 -10px 40px rgba(0,0,0,0.06)",
        padding:"5px 8px",
        paddingBottom:`calc(5px + env(safe-area-inset-bottom, 0px))`,
        flexShrink:0,
        zIndex:999,
        width:"100%",
        boxSizing:"border-box",
        position:"relative",
      }}>
        {tabs.map(tab=>{
          const isActive = tab.isPopupTrigger ? showAddPopup : active===tab.id;
          return(
            <button
              key={tab.id}
              onClick={()=>{
                if(tab.isPopupTrigger){ setShowAddPopup(p=>!p); return; }
                setShowAddPopup(false);
                setPage(tab.id);
              }}
              style={{
                display:"flex",
                flexDirection:"column",
                alignItems:"center",
                justifyContent:"center",
                padding:"5px 0",
                border:"none",
                background:"none",
                cursor:"pointer",
                position:"relative",
                color:isActive?BLUE:MUTED,
                transition:"color .15s",
                flex:1,
              }}
            >
              {tab.icon(isActive)}
              {/* Active dot indicator -- not shown for the popup trigger */}
              {isActive&&!tab.isPopupTrigger&&(
                <div style={{
                  position:"absolute",
                  bottom:0,
                  width:6,
                  height:6,
                  borderRadius:"50%",
                  background:BLUE,
                }}/>
              )}
            </button>
          );
        })}
      </nav>
    </>
  );
}


const BILLING_URL = `${SUPA_URL}/functions/v1/billing-history`;

// Subscriptions: current plan + upgrade path + billing history. House style:
// gradient plan card as the hero, quiet table for the money.
function SubscriptionsPage({user}) {
  const S = getS();
  const [tab, setTab] = useState("plan"); // "plan" | "billing"
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState("");
  const [invoices, setInvoices] = useState(null); // null=not loaded, []=empty
  const [invErr, setInvErr] = useState("");
  const [invLoading, setInvLoading] = useState(false);

  const isActive  = user?.subscription_status === "active";
  const isPastDue = user?.subscription_status === "past_due";
  const interval  = user?.subscription_interval || "month";
  const isAnnual  = interval === "year";
  const subEnd = user?.subscription_end
    ? new Date(user.subscription_end).toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})
    : null;

  async function subscribe(billingInterval){
    setLoading(billingInterval); setError("");
    try{
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(CHECKOUT_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({interval:billingInterval,successUrl:`${window.location.origin}?checkout=success`,cancelUrl:`${window.location.origin}?checkout=cancelled`})});
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      window.location.href = data.url;
    }catch(e){ setError(e.message); }
    setLoading(null);
  }
  async function openPortal(){
    setLoading("portal"); setError("");
    try{
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(PORTAL_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},
        body:JSON.stringify({returnUrl:window.location.origin})});
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      window.location.href = data.url;
    }catch(e){ setError(e.message); }
    setLoading(null);
  }
  async function loadInvoices(){
    setInvLoading(true); setInvErr("");
    try{
      const token = sb.auth._token || SUPA_ANON;
      const res = await fetch(BILLING_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`,"apikey":SUPA_ANON},body:JSON.stringify({})});
      const data = await res.json();
      if(data.error) throw new Error(data.error);
      setInvoices(Array.isArray(data.invoices)?data.invoices:[]);
    }catch(e){ setInvErr(e.message); setInvoices([]); }
    setInvLoading(false);
  }
  useEffect(()=>{ if(tab==="billing" && invoices===null && !invLoading) loadInvoices(); },[tab]);

  const chip = (txt,bg,fg)=>(<span style={{fontSize:10,fontWeight:800,padding:"3px 9px",borderRadius:99,background:bg,color:fg,textTransform:"uppercase",letterSpacing:".5px"}}>{txt}</span>);
  const money = (v,cur)=>new Intl.NumberFormat("en-US",{style:"currency",currency:(cur||"usd").toUpperCase()}).format(v);

  return(
    <div style={{flex:1,overflowY:"auto",padding:"16px 18px 90px",background:S.bg}}>
      <PageHero title="Subscription" subtitle="Plan & billing"
        icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="3" stroke="#fff" strokeWidth="2.2"/><path d="M2 10h20" stroke="#fff" strokeWidth="2.2"/><path d="M6 15h4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>}/>

      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {[["plan","Plan"],["billing","Billing"]].map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{padding:"8px 18px",borderRadius:100,border:"none",cursor:"pointer",fontSize:13,fontWeight:700,
              background:tab===id?S.ink:S.surface,color:tab===id?"#fff":S.muted,
              boxShadow:tab===id?"0 4px 12px rgba(15,23,42,0.2)":"inset 0 0 0 1px "+S.border}}>
            {lbl}
          </button>
        ))}
      </div>

      {error&&<div style={{background:C.redBg,border:"1px solid #FECACA",color:C.red,borderRadius:12,padding:"10px 12px",fontSize:12,fontWeight:600,marginBottom:12}}>{error}</div>}

      {tab==="plan"&&(
        <>
          {/* Current plan card */}
          <div style={{borderRadius:20,padding:"20px",marginBottom:14,color:"#fff",
            background:isActive?"linear-gradient(135deg,#1D4ED8,#3B82F6)":"linear-gradient(135deg,#334155,#1E293B)",
            boxShadow:"0 10px 28px rgba(29,78,216,0.28)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div>
                <div style={{fontSize:11,fontWeight:700,opacity:.8,textTransform:"uppercase",letterSpacing:"1px"}}>Current plan</div>
                <div style={{fontSize:22,fontWeight:900,letterSpacing:"-.5px",marginTop:2}}>
                  {isActive?`Pro ${isAnnual?"Annual":"Monthly"}`:"Free"}
                </div>
              </div>
              {isActive?chip("Active","rgba(16,185,129,0.25)","#6EE7B7")
               :isPastDue?chip("Past due","rgba(245,158,11,0.25)","#FCD34D")
               :chip("Inactive","rgba(148,163,184,0.25)","#CBD5E1")}
            </div>
            {isActive&&subEnd&&(
              <div style={{fontSize:12,opacity:.9}}>{isAnnual?"Renews":"Renews"} {subEnd}</div>
            )}
            {!isActive&&(
              <div style={{fontSize:12,opacity:.85}}>Upgrade to unlock unlimited rosters, FlightAware sync and exports.</div>
            )}
          </div>

          {/* Upgrade path */}
          {isActive&&!isAnnual&&(
            <div style={{borderRadius:18,padding:"16px 18px",marginBottom:14,background:"linear-gradient(135deg,#059669,#0D9488)",color:"#fff",boxShadow:"0 8px 22px rgba(5,150,105,0.3)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                <div>
                  <div style={{fontSize:15,fontWeight:800}}>Switch to Annual</div>
                  <div style={{fontSize:12,opacity:.9,marginTop:2}}>2 months free vs monthly billing</div>
                </div>
                <button onClick={()=>subscribe("year")} disabled={loading==="year"}
                  style={{padding:"10px 16px",borderRadius:12,border:"none",background:"rgba(255,255,255,0.95)",color:"#047857",fontSize:13,fontWeight:800,cursor:"pointer",flexShrink:0}}>
                  {loading==="year"?"Opening...":"Upgrade"}
                </button>
              </div>
            </div>
          )}
          {!isActive&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <button onClick={()=>subscribe("month")} disabled={!!loading} style={{padding:"14px",borderRadius:14,border:`1.5px solid ${S.border}`,background:S.surface,color:S.ink,fontSize:13,fontWeight:800,cursor:"pointer"}}>
                {loading==="month"?"Opening...":"Monthly"}
              </button>
              <button onClick={()=>subscribe("year")} disabled={!!loading} style={{padding:"14px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#1D4ED8,#3B82F6)",color:"#fff",fontSize:13,fontWeight:800,cursor:"pointer"}}>
                {loading==="year"?"Opening...":"Annual · best value"}
              </button>
            </div>
          )}

          {isActive&&(
            <button onClick={openPortal} disabled={loading==="portal"}
              style={{width:"100%",padding:"13px",borderRadius:14,border:`1.5px solid ${S.border}`,background:S.surface,color:S.ink,fontSize:13,fontWeight:700,cursor:"pointer"}}>
              {loading==="portal"?"Opening...":"Manage billing & payment method"}
            </button>
          )}
        </>
      )}

      {tab==="billing"&&(
        <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1.1fr 1fr .8fr",padding:"11px 16px",borderBottom:`1px solid ${S.border}`,fontSize:10.5,fontWeight:800,color:S.muted,textTransform:"uppercase",letterSpacing:".6px"}}>
            <span>Date</span><span>Amount</span><span style={{textAlign:"right"}}>Status</span>
          </div>
          {invLoading&&<div style={{padding:"26px",textAlign:"center",fontSize:13,color:S.muted}}>Loading billing history...</div>}
          {!invLoading&&invErr&&(
            <div style={{padding:"22px 16px",textAlign:"center"}}>
              <div style={{fontSize:12.5,color:C.red,fontWeight:600,marginBottom:10}}>{invErr}</div>
              <button onClick={loadInvoices} style={{padding:"8px 18px",borderRadius:10,border:`1.5px solid ${S.border}`,background:"none",color:S.ink,fontSize:12,fontWeight:700,cursor:"pointer"}}>Retry</button>
            </div>
          )}
          {!invLoading&&!invErr&&invoices&&invoices.length===0&&(
            <div style={{padding:"26px",textAlign:"center",fontSize:13,color:S.muted}}>No payments on this account yet.</div>
          )}
          {!invLoading&&!invErr&&(invoices||[]).map((inv,i)=>(
            <a key={i} href={inv.url||undefined} target="_blank" rel="noreferrer"
              style={{display:"grid",gridTemplateColumns:"1.1fr 1fr .8fr",padding:"13px 16px",borderBottom:i<invoices.length-1?`1px solid ${S.border}`:"none",textDecoration:"none",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:600,color:S.ink}}>{new Date(inv.date).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</span>
              <span style={{fontSize:13,fontWeight:800,color:S.ink}}>{money(inv.amount,inv.currency)}</span>
              <span style={{textAlign:"right"}}>{chip(inv.status||"paid", inv.status==="paid"||!inv.status?C.greenBg:C.amberBg, inv.status==="paid"||!inv.status?"#059669":"#B45309")}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function MorePage({user, setPage, onLogout, rosters, tails}) {
  const isAdmin = user?.role === "admin";

  const S = getS();

  const pilotItems = [
    {id:"map",         label:"Route Map",               bg:S.greenBg, color:S.green,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 4L3 7v13l6-3 6 3 6-3V4l-6 3-6-3z" stroke="#10B981" strokeWidth="2" strokeLinejoin="round" fill="none"/><path d="M9 4v13M15 7v13" stroke="#10B981" strokeWidth="2"/></svg>},
    {id:"profile",     label:"Profile",                 bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="#F97316" strokeWidth="2"/><path d="M4 20c0-3 3.6-5 8-5s8 2 8 5" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"referral",    label:"Refer & Earn",            bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke="#F97316" strokeWidth="2"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"support",     label:"Support",                 bg:S.greenBg, color:S.green,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#10B981" strokeWidth="2"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" stroke="#10B981" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"export",      label:"Export Logbook",          bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="#1D4ED8" strokeWidth="2.2" strokeLinecap="round"/></svg>},
    {id:"subscriptions", label:"Subscriptions",        bg:"#05966918", color:C.green,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="3" stroke="#059669" strokeWidth="2"/><path d="M2 10h20" stroke="#059669" strokeWidth="2"/><path d="M6 15h4" stroke="#059669" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"settings",    label:"Settings",                bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#3B82F6" strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="#3B82F6" strokeWidth="2"/></svg>},
  ];

  const adminItems = [
    {id:"admin-overview",  label:"Admin Overview",    bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="14" y="3" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="3" y="14" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="14" y="14" width="7" height="7" rx="1" fill="#1D4ED8"/></svg>},
    {id:"admin-users",     label:"User Management",   bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke="#F97316" strokeWidth="2"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-analysis",  label:"Analysis",          bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={S.blue}/><rect x="10" y="7" width="4" height="14" rx="1" fill="#1D4ED8"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#1D4ED8"/></svg>},
    {id:"admin-rosters",   label:"All Rosters",       bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#3B82F6" strokeWidth="2"/><path d="M8 13h8M8 17h5" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-settings",  label:"Admin Settings",    bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#3B82F6" strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="#3B82F6" strokeWidth="2"/></svg>},
    {id:"admin-content",   label:"Landing Page & Content", bg:"#05966918", color:C.green,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 5a2 2 0 012-2h8l6 6v10a2 2 0 01-2 2H6a2 2 0 01-2-2V5z" stroke="#059669" strokeWidth="2" strokeLinejoin="round"/><path d="M14 3v6h6" stroke="#059669" strokeWidth="2" strokeLinejoin="round"/><path d="M8 13h8M8 17h5" stroke="#059669" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"profile",         label:"Profile",           bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="#F97316" strokeWidth="2"/><path d="M4 20c0-3 3.6-5 8-5s8 2 8 5" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
  ];

  const items = isAdmin ? adminItems : pilotItems;

  return (
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif",paddingBottom:80}}>

      {/* Background blobs */}
      <div style={{position:"fixed",top:"-10%",right:"-5%",width:"40%",height:"40%",background:"#E9D5FF",borderRadius:"50%",filter:"blur(100px)",opacity:0.4,pointerEvents:"none",zIndex:0}}/>
      <div style={{position:"fixed",top:"20%",left:"-10%",width:"30%",height:"30%",background:C.blueBdr,borderRadius:"50%",filter:"blur(100px)",opacity:0.4,pointerEvents:"none",zIndex:0}}/>

      {/* Header */}
      <div style={{padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:10,background:"rgba(248,250,252,0.9)",backdropFilter:"blur(12px)",borderBottom:`1px solid ${S.border}`}}>
        <h1 style={{fontSize:11,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:"2px",margin:0}}>More</h1>
      </div>

      <div style={{padding:"16px 16px 0",maxWidth:640,margin:"0 auto",position:"relative",zIndex:1}}>
        {isAdmin&&(
          <div style={{marginBottom:12,padding:"10px 14px",borderRadius:12,background:C.redBg,border:"1px solid #FECACA",fontSize:12,fontWeight:700,color:"#EF4444",letterSpacing:"1px",textTransform:"uppercase"}}>
            Administrator Console
          </div>
        )}

        {/* Main menu card */}
        <div style={{background:S.surface,borderRadius:24,border:`1px solid ${S.border}`,boxShadow:"0 20px 60px rgba(0,0,0,0.06)",overflow:"hidden",marginBottom:20}}>
          {items.map((item, i)=>(
            <button
              key={item.id}
              onClick={()=>setPage(item.id)}
              style={{
                width:"100%",display:"flex",alignItems:"center",gap:16,
                padding:"16px 20px",border:"none",background:"none",
                cursor:"pointer",textAlign:"left",
                borderBottom:i<items.length-1?`1px solid ${S.border}`:"none",
                transition:"background .1s",
              }}
              onMouseEnter={e=>e.currentTarget.style.background="#F8FAFC"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}
            >
              {/* Icon box */}
              <div style={{
                width:40,height:40,borderRadius:12,background:item.bg,
                display:"flex",alignItems:"center",justifyContent:"center",
                flexShrink:0,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",
                transition:"transform .15s",
              }}>
                {item.icon}
              </div>
              {/* Label */}
              <span style={{fontSize:15,fontWeight:700,color:"#374151",flex:1}}>{item.label}</span>
              {/* Chevron */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{color:"#CBD5E1",transition:"color .15s",flexShrink:0}}>
                <path d="M9 18l6-6-6-6" stroke="#CBD5E1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          ))}
        </div>

        {/* Sign out button */}
        <button
          onClick={onLogout}
          style={{
            width:"100%",padding:"16px",
            border:`1.5px solid ${S.redBdr}`,
            borderRadius:20,background:S.surface,
            color:"#EF4444",fontSize:15,fontWeight:700,
            cursor:"pointer",textAlign:"center",
            boxShadow:"0 1px 4px rgba(0,0,0,0.04)",
            transition:"background .15s",
          }}
          onMouseEnter={e=>e.currentTarget.style.background=S.redBg}
          onMouseLeave={e=>e.currentTarget.style.background=S.surface}
        >
          Sign Out
        </button>

        {/* Footer */}
        <div style={{textAlign:"center",padding:"20px 0 8px",fontSize:12,fontWeight:500,color:"#94A3B8"}}>
          AviateSync · {user?.email}
        </div>
      </div>
    </div>
  );
}

// --- ROOT APP -----------------------------------------------------------------
function SubscriptionWall({user, onSubscribed, onLogout}) {
  const [checking, setChecking] = useState(true);

  async function checkSubscription() {
    try {
      if(!sb.auth._token) {
        try { const t = localStorage.getItem("fl_token"); if(t) sb.auth._token = t; } catch {}
      }
      // Use fetchProfile which calls security definer RPC -- bypasses RLS
      const profile = await fetchProfile(user.id);
      console.log("[Wall] subscription_status:", profile?.subscription_status);
      if(profile?.subscription_status === "active" || profile?.subscription_status === "past_due") {
        onSubscribed({...user, ...profile});
        return true;
      }
      return false;
    } catch(e) {
      console.error("[Wall]", e.message);
      return false;
    }
  }

  // Poll every 3 seconds, silently -- no visible "listening..." indicator,
  // the app just opens on its own the moment payment confirms.
  useEffect(()=>{
    checkSubscription().then(found => { if(!found) setChecking(false); });

    let count = 0;
    const poll = setInterval(async()=>{
      count++;
      const found = await checkSubscription();
      if(found || count >= 60) clearInterval(poll);
    }, 3000);
    return ()=>clearInterval(poll);
  },[]);

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.base,minHeight:"100vh"}}>
      <div style={{background:"linear-gradient(165deg,#1D4ED8 0%,#2E6BE6 55%,#3B82F6 100%)",padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,boxShadow:"0 8px 24px rgba(29,78,216,0.25)"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:26,height:26,borderRadius:7,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",flexShrink:0}}>
            <img src="/icons/icon-192.png" alt="" style={{width:20,height:20,objectFit:"contain"}}/>
          </div>
          <div style={{fontSize:15,fontWeight:800,color:"#fff",letterSpacing:".3px"}}>AVIATE<span style={{color:"#BFDBFE"}}>SYNC</span></div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onLogout} style={{fontSize:12,color:"rgba(255,255,255,0.75)",background:"none",border:"none",cursor:"pointer"}}>Sign out</button>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 16px"}}>
        <div style={{width:"100%",maxWidth:420}}>
          <MembershipPage user={user}/>
        </div>
      </div>
    </div>
  );
}

// --- ERROR BOUNDARY ----------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = {error:null}; }
  static getDerivedStateFromError(e) { return {error:e}; }
  componentDidCatch(e,info) { console.error("AviateSync crash:", e, info); }
  render() {
    if(this.state.error) return(
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,padding:24,background:"#F8FAFC",fontFamily:"Inter,system-ui,sans-serif"}}>
        <div style={{fontSize:32}}>⚠️</div>
        <div style={{fontSize:18,fontWeight:800,color:"#0F172A"}}>Something crashed</div>
        <div style={{fontSize:13,color:"#64748B",maxWidth:400,textAlign:"center",lineHeight:1.6,background:C.redBg,padding:"12px 16px",borderRadius:12,border:"1px solid #FECACA",fontFamily:"monospace"}}>
          {this.state.error?.message||String(this.state.error)}
        </div>
        <button onClick={()=>window.location.reload()} style={{padding:"10px 24px",borderRadius:10,background:"#1D4ED8",color:"#fff",border:"none",fontWeight:700,cursor:"pointer",fontSize:14}}>
          Reload app
        </button>
      </div>
    );
    return this.props.children;
  }
}

export default function App() {
  const [screen,setScreen]=useState("loading");
  const [authMode,setAuthMode]=useState("login");
  const [user,setUser]=useState(null);
  const [page,setPage]=useState("dashboard");
  const [rosters,setRosters]=useState([]);
  const [tails,setTails]=useState({});
  const [isDark,setIsDark]=useState(()=>{try{return localStorage.getItem("fl_theme")==="dark";}catch{return false;}});
  const [themeKey,setThemeKey]=useState(0);
  const [pendingFlight,setPendingFlight]=useState(null);
  const [locked,setLocked]=useState(false);
  const [recoveryToken,setRecoveryToken]=useState(null);
  // Admin "view as user" -- lets an admin browse a specific pilot's
  // Dashboard/Logbook/Stats exactly as that pilot would see it, for support
  // and oversight. adminOwnState snapshots the admin's own session data so
  // Exit can restore it exactly; adminViewUser holds the pilot's profile
  // being viewed and doubles as the "is this mode active" flag.
  const [adminViewUser,setAdminViewUser]=useState(null);
  const [adminOwnState,setAdminOwnState]=useState(null);

  async function enterAdminView(targetUser) {
    try {
      setAdminOwnState({user, rosters, tails, page});
      const [targetRosters, targetTails] = await Promise.all([
        db_adminLoadUserRosters(targetUser.id),
        db_adminLoadUserTails(targetUser.id),
      ]);
      setAdminViewUser(targetUser);
      setUser(targetUser);
      setRosters(targetRosters);
      setTails(targetTails);
      setPage("dashboard");
    } catch(e) { alert("Could not load this pilot's data: "+(e.message||e)); }
  }
  function exitAdminView() {
    if(!adminOwnState) return;
    setUser(adminOwnState.user);
    setRosters(adminOwnState.rosters);
    setTails(adminOwnState.tails);
    setPage("admin-users");
    setAdminViewUser(null);
    setAdminOwnState(null);
  }

  // App-wide config (Admin > Landing Page & Content) -- maintenance mode and
  // the announcement banner. Loaded once on sign-in and re-checked every
  // couple of minutes so a maintenance toggle or announcement Mali turns on
  // reaches pilots who already have the app open, without a full reload.
  const [appConfig,setAppConfig]=useState(APP_CONFIG_DEFAULTS);
  const [announcementDismissed,setAnnouncementDismissed]=useState(false);
  useEffect(()=>{
    if(!user) return;
    let cancelled=false;
    function load(){ db_loadAppConfig().then(c=>{ if(!cancelled) setAppConfig(c); }); }
    load();
    const iv=setInterval(load,120000);
    return ()=>{ cancelled=true; clearInterval(iv); };
  },[user?.id]);


  // Password-reset recovery link lands here with the token in the URL
  // HASH (Supabase GoTrue convention: #access_token=...&type=recovery),
  // not a query param -- must be checked before any normal screen routing
  // decides what to render, since the pilot isn't in a real session yet.
  useEffect(()=>{
    const hash = window.location.hash;
    if(hash.includes("type=recovery")){
      const p = new URLSearchParams(hash.slice(1));
      const token = p.get("access_token");
      if(token){
        setRecoveryToken(token);
        setScreen("reset-password");
        window.history.replaceState({},"",window.location.pathname+window.location.search);
      }
    }
  },[]);

  // Google/Apple sign-in lands back here the same GoTrue way (tokens in the
  // URL hash), but WITHOUT type=recovery -- that's what distinguishes a
  // successful OAuth login from a password-reset link, since both use
  // #access_token=... in the hash. This app has no Supabase JS SDK, so the
  // token has to be captured and stored through the same sb.auth fields
  // every other auth method uses, then routed through handleAuth exactly
  // like a normal password sign-in would be -- no parallel logic path.
  useEffect(()=>{
    const hash = window.location.hash;
    if(hash.includes("access_token") && !hash.includes("type=recovery")){
      const p = new URLSearchParams(hash.slice(1));
      const accessToken = p.get("access_token");
      const refreshToken = p.get("refresh_token");
      if(!accessToken) return;
      sb.auth._token = accessToken;
      sb.auth._refreshToken = refreshToken;
      try{
        localStorage.setItem("fl_token", accessToken);
        if(refreshToken) localStorage.setItem("fl_refresh_token", refreshToken);
      }catch{}
      window.history.replaceState({},"",window.location.pathname+window.location.search);
      fetch(`${SUPA_URL}/auth/v1/user`, {
        headers: { "apikey": SUPA_ANON, "Authorization": `Bearer ${accessToken}` },
      })
        .then(r=>r.json())
        .then(u=>{ if(u?.id) handleAuth(u); })
        .catch(()=>{});
    }
  },[]);

  // Apply theme synchronously before first paint
  useEffect(()=>{
    const dark=getThemePref();
    setIsDark(dark);
    applyTheme(dark);
    let el=document.getElementById("fl-styles");
    if(!el){el=document.createElement("style");el.id="fl-styles";document.head.appendChild(el);}
    el.textContent=buildStyles();
  },[]);

  function handleToggleTheme(){
    const next=!isDark;
    setIsDark(next);
    setThemePref(next);
    applyTheme(next);
    setThemeKey(k=>k+1);
  }

  const ADMIN_EMAILS = ["admin@flightlog.app"];
  function ensureRole(u){
    if(!u) return u;
    if(!u.role||u.role==="authenticated"){
      return {...u, role:ADMIN_EMAILS.includes(u.email)?"admin":"pilot"};
    }
    return u;
  }

  // Restore session on mount
  useEffect(()=>{
    // A Google/Apple OAuth redirect lands here with the token still sitting
    // unread in the URL hash -- at that exact instant, db_getSession() and
    // refreshSession() correctly find nothing yet (the token hasn't been
    // captured into sb.auth by the separate OAuth-callback effect below),
    // so without this check, this effect would conclude "not signed in"
    // and flash the landing page before that other effect's async fetch
    // resolves and corrects it moments later. Detecting the pending
    // callback here and deferring the landing/loading decision to it
    // instead removes the race entirely -- one effect, not two guessing
    // independently off incomplete information.
    const hash = window.location.hash;
    const hasOAuthCallback = hash.includes("access_token") && !hash.includes("type=recovery");
    if(hasOAuthCallback) return; // the OAuth-callback effect owns screen state for this load

    (async()=>{
      try{
        let u=await db_getSession();
        if(u){
          u=ensureRole(u);
          setUser(u);
          const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
          setRosters(rs);setTails(ts);
          let savedPage="dashboard";
          try{savedPage=sessionStorage.getItem("fl_page")||savedPage;}catch{}
          const defaultPage=u.role==="admin"?"admin-overview":"dashboard";
          const isValidForRole=u.role==="admin"?savedPage.startsWith("admin"):!savedPage.startsWith("admin");
          setPage(isValidForRole?savedPage:defaultPage);
          setScreen("app");
        } else {
          const {data}=await sb.auth.refreshSession();
          if(data?.session){
            let refreshed=await db_getSession();
            if(refreshed){
              refreshed=ensureRole(refreshed);
              setUser(refreshed);
              const [rs,ts]=await Promise.all([db_loadRosters(refreshed.id),db_loadTails(refreshed.id)]);
              setRosters(rs);setTails(ts);
              setPage(refreshed.role==="admin"?"admin-overview":"dashboard");
              setScreen("app");
            } else setScreen("landing");
          } else setScreen("landing");
        }
      } catch{setScreen("landing");}
    })();
  },[]);

  // Idle lock (15 min)
  const idleRef=useRef(null);
  function resetIdleTimer(){
    if(idleRef.current) clearTimeout(idleRef.current);
    idleRef.current=setTimeout(()=>{if(screen==="app")setLocked(true);},15*60*1000);
  }
  useEffect(()=>{
    if(screen!=="app") return;
    resetIdleTimer();
    const events=["mousemove","keydown","touchstart","click"];
    events.forEach(e=>window.addEventListener(e,resetIdleTimer));
    return()=>{events.forEach(e=>window.removeEventListener(e,resetIdleTimer));if(idleRef.current)clearTimeout(idleRef.current);};
  },[screen]);

  const [logbookInitialTab, setLogbookInitialTab] = useState(null);
  // Used by bottom nav tap to signal "go back to hub" when on flight detail
  const [logbookResetKey, setLogbookResetKey] = useState(0);

  function navigate(newPage){
    if(newPage.startsWith("admin-")&&user?.role!=="admin") newPage="dashboard";
    // Redirect old standalone routes into the unified Logbook hub with the
    // matching tab pre-selected, so every existing call site (Quick Actions,
    // More menu, post-upload screen, etc) keeps working without having to
    // touch every single one of them individually.
    // NOTE: "calendar" (Roster View) used to redirect here too, but it's now
    // its own standalone page -- reachable only from the Dashboard -- so it
    // no longer clutters the Logbook hub's tab strip.
    if(newPage==="active-logs"){ setLogbookInitialTab("activelogs"); newPage="logbook"; }
    // If already on logbook page, bump the reset key so LogbookHubPage clears
    // any open flight detail and returns to the hub tab strip.
    //
    // Also clear the "fl_open_flight" sessionStorage entry here -- that key
    // exists so a genuine PAGE RELOAD can restore whatever flight detail was
    // open (LogbookHubPage's own recovery effect reads it on mount). But a
    // key-triggered remount is indistinguishable from a fresh mount to that
    // effect, so without clearing this first, the remount correctly resets
    // hubSelectedFlight to null and the recovery effect immediately reads
    // the still-present stale entry and reopens the exact same flight --
    // which is the actual reason tapping the Logbook icon while viewing a
    // flight detail appeared to do nothing.
    if(newPage==="logbook" && page==="logbook"){
      try{ sessionStorage.removeItem("fl_open_flight"); }catch{}
      setLogbookResetKey(k=>k+1);
      return;
    }
    if(newPage===page) return;
    try{sessionStorage.setItem("fl_page",newPage);}catch{}
    window.history.pushState({page:newPage},"","");
    setPage(newPage);
  }

  useEffect(()=>{
    function onPopState(e){
      const p=e.state?.page||"dashboard";
      navigate(p);
    }
    window.addEventListener("popstate",onPopState);
    return()=>window.removeEventListener("popstate",onPopState);
  },[page,user]);

  async function handleAuth(u){
    if(!u.role||u.role==="authenticated"){
      u={...u,role:ADMIN_EMAILS.includes(u.email)?"admin":"pilot"};
    }
    setUser(u);
    try{
      const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
      setRosters(rs);setTails(ts);
    }catch{}

    // Use current token directly
    const token = sb.auth._token || SUPA_ANON;

    const params=new URLSearchParams(window.location.search);
    if(params.get("checkout")==="success"){
      window.history.replaceState({},"",window.location.pathname);
      // Poll profile for up to 15 seconds -- webhook may not have fired yet
      let attempts = 0;
      while(attempts < 10) {
        await new Promise(r=>setTimeout(r,1500));
        try{
          const profile = await fetchProfile(u.id, token);
          if(profile?.id) u = {...u, ...profile};
          setUser({...u});
          if(u.subscription_status==="active"||u.subscription_status==="past_due") break;
        }catch{}
        attempts++;
      }
    } else {
      // Normal login -- just refresh profile once
      try{
        const profile = await fetchProfile(u.id, token);
        if(profile?.id) u = {...u, ...profile};
        setUser({...u});
      }catch{}
    }

    setPage(u.role==="admin"?"admin-overview":"dashboard");
    setScreen("app");

    if(isStandalone()&&!localStorage.getItem("fl_webauthn_registered")){
      try{
        const available=await isWebAuthnAvailable();
        if(available&&u.id&&u.email){
          setTimeout(async()=>{
            try{const registered=await registerBiometric(u.id,u.email);if(registered)localStorage.setItem("fl_webauthn_registered","1");}catch{}
          },2000);
        }
      }catch{}
    }
  }

  async function handleRosterSaved(roster){
    // Upsert the saved roster into state immediately for fast feedback
    setRosters(prev=>{
      const idx=prev.findIndex(r=>r.id===roster.id);
      if(idx>=0){const n=[...prev];n[idx]=roster;return n;}
      return[...prev,roster];
    });
    // Then do a full reload from DB -- this is the only way to pick up
    // any carryover roster that db_saveRoster may have created as a new
    // row (for next month), since that row is never returned to the client
    // by the save call itself.
    try{
      const fresh = await db_loadRosters(user.id);
      if(fresh?.length) setRosters(fresh);
    }catch{}
  }

  async function handleDeleteRoster(rosterId){
    const previous=rosters;
    setRosters(prev=>prev.filter(r=>r.id!==rosterId));
    try{await db_deleteRoster(user.id,rosterId);}catch(e){setRosters(previous);alert(e.message||"Failed to delete roster.");}
  }

  function handleRosterCalendarUpdated(rosterId,newCalendar){
    setRosters(prev=>prev.map(r=>r.id===rosterId?{...r,calendar:newCalendar}:r));
  }

  function handleTailSaved(tk,val){
    setTails(prev=>({...prev,[tk]:val}));
  }

  async function handleLogout(){
    await db_signOut();
    setUser(null);setRosters([]);setTails({});
    setPage("dashboard");
    try{sessionStorage.removeItem("fl_page");}catch{}
    setScreen("landing");
  }

  return(
    <ErrorBoundary>
    <div key={themeKey} style={{height:"100dvh",overflow:screen==="app"?"hidden":"auto",overscrollBehaviorY:"contain"}}>
      {screen==="loading"&&(
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14,background:"#F4F6FB"}}>
          <div style={{fontSize:28,fontWeight:800,color:"#0B1437",letterSpacing:"-.5px"}}>Aviate<span style={{color:"#1D4ED8"}}>Sync</span></div>
          <div style={{fontSize:13,color:"#8A97B4"}}>Loading...</div>
        </div>
      )}
      {screen==="landing"&&(isStandalone()
        ?<AppLandingPage onAuth={handleAuth}/>
        :<LandingPage onLogin={()=>{setAuthMode("login");setScreen("auth");}} onSignup={()=>{setAuthMode("signup");setScreen("auth");}}/>
      )}
      {screen==="auth"&&<AuthPage onAuth={handleAuth} onBack={()=>setScreen("landing")} initialMode={authMode}/>}
      {screen==="reset-password"&&<ResetPasswordScreen accessToken={recoveryToken} onDone={()=>{setRecoveryToken(null);setAuthMode("login");setScreen("auth");}}/>}
      {screen==="app"&&user&&(()=>{
        // Real role behind the wheel right now -- if an admin is impersonating
        // a pilot, `user.role` is temporarily "pilot" (that's the whole point),
        // so maintenance mode must check the underlying admin identity instead,
        // or an admin doing oversight would get locked out by their own toggle.
        const realRole = adminOwnState ? adminOwnState.user.role : user.role;
        const maintenanceBlocking = appConfig.maintenanceEnabled && realRole!=="admin";
        if(maintenanceBlocking) return(
          <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,padding:32,background:C.base,textAlign:"center"}}>
            <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#1D4ED8,#3B82F6)",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 8v5M12 16h.01" stroke="#fff" strokeWidth="2.4" strokeLinecap="round"/><circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="2"/></svg>
            </div>
            <div style={{fontSize:19,fontWeight:800,color:C.ink}}>AviateSync</div>
            <div style={{fontSize:14,color:C.muted,maxWidth:360,lineHeight:1.6}}>{appConfig.maintenanceMessage}</div>
            <button onClick={handleLogout} style={{marginTop:8,padding:"9px 20px",borderRadius:10,background:"none",border:`1px solid ${C.border}`,color:C.muted,fontSize:13,cursor:"pointer"}}>Sign out</button>
          </div>
        );
        return(
        <div style={{display:"flex",flexDirection:"column",height:"100dvh",overflow:"hidden",background:C.base,position:"fixed",top:0,left:0,right:0,bottom:0}} className="app-shell">
          {locked&&<LockScreen user={user} onUnlock={()=>{setLocked(false);resetIdleTimer();}}/>}

          {/* -- ANNOUNCEMENT BANNER -- admin-editable, dismissible per session */}
          {appConfig.announcementEnabled&&appConfig.announcementText&&!announcementDismissed&&(
            <div style={{flexShrink:0,padding:"8px 16px",background:"linear-gradient(135deg,#1D4ED8,#3B82F6)",display:"flex",alignItems:"center",gap:10}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
              <span style={{fontSize:12.5,fontWeight:600,color:"#fff",flex:1}}>{appConfig.announcementText}</span>
              <button onClick={()=>setAnnouncementDismissed(true)} style={{background:"none",border:"none",color:"rgba(255,255,255,0.8)",fontSize:16,cursor:"pointer",padding:0,lineHeight:1,flexShrink:0}}>✕</button>
            </div>
          )}

          {/* -- ADMIN VIEW BANNER -- persistent, always visible while an
              admin is browsing a pilot's account, regardless of which page
              they're on. This is for the admin's own clarity (so they never
              lose track of whose data they're looking at) -- the pilot being
              viewed sees nothing on their end, since none of this touches
              their own session. */}
          {adminViewUser&&(
            <div style={{flexShrink:0,padding:"8px 16px",background:"linear-gradient(135deg,#059669,#047857)",display:"flex",alignItems:"center",gap:10,zIndex:200}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:"#fff",flexShrink:0,animation:"pulse 1.5s infinite"}}/>
              <span style={{fontSize:12.5,fontWeight:700,color:"#fff",flex:1}}>
                Admin View -- viewing as <strong>{adminViewUser.name}</strong> ({adminViewUser.email})
              </span>
              <button onClick={exitAdminView} style={{padding:"5px 14px",borderRadius:100,background:"rgba(255,255,255,0.2)",border:"1px solid rgba(255,255,255,0.35)",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0}}>
                Exit Admin View
              </button>
            </div>
          )}

          {/* -- SUBSCRIPTION WALL -- skipped while in admin view: oversight
              means seeing the pilot's actual data, not their paywall.
              ALLOWLIST, not denylist: only these two states grant access.
              A brand-new signup's subscription_status is null/undefined
              (no row has ever been written by the Stripe webhook yet) --
              the old check only blocked the literal strings "inactive" or
              "cancelled", which null never matches, so every new signup
              silently passed straight through the paywall with zero
              payment. Every state that ISN'T explicitly "active" or
              "past_due" now blocks, including null/undefined/anything else. */}
          {!adminViewUser&&user.role!=="admin"&&!(user.subscription_status==="active"||user.subscription_status==="past_due")?(
            <SubscriptionWall user={user} onSubscribed={(profile)=>{
              const updated={...user,...profile};
              setUser(updated);
              setPage("dashboard");
            }} onLogout={handleLogout}/>
          ):(
          <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"row",minHeight:0}}>
            <div className="desktop-sidebar">
              <DesktopSidebar user={user} page={page} setPage={navigate} onLogout={handleLogout}/>
            </div>
            <div style={{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"}}>
              {/* Page content -- fills remaining height, each page handles its own scroll */}
              <div style={{flex:1,minHeight:0,overflow:"hidden",display:"flex",flexDirection:"column",overscrollBehavior:"contain"}} className="mobile-page-content">
              {page==="dashboard"&&<Dashboard user={user} rosters={rosters} tails={tails} setPage={navigate} onOpenFlight={(flight)=>{try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:flight.roster?.id,di:flight.di,fi:flight.fi,flightData:flight}));}catch{}setPendingFlight(flight);navigate("logbook");}}/>}
              {page==="logbook"&&<LogbookHubPage key={logbookResetKey} user={user} rosters={rosters} tails={tails} onTailSaved={handleTailSaved} onDeleteRoster={handleDeleteRoster} onRosterUpdated={handleRosterCalendarUpdated} pendingFlight={pendingFlight} onPendingFlightConsumed={()=>setPendingFlight(null)} setPage={navigate} initialTab={logbookInitialTab} onOpenFlight={(flight)=>{try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:flight.roster?.id,di:flight.di,fi:flight.fi,flightData:flight}));}catch{}setPendingFlight(flight);}}/>}
              {page==="upload"&&<UploadPage user={user} rosters={rosters} onRosterSaved={handleRosterSaved} onReloadRosters={(fresh)=>{if(fresh?.length)setRosters(fresh);else db_loadRosters(user.id).then(r=>{if(r?.length)setRosters(r);}).catch(()=>{});}} setPage={navigate}/>}
              {page==="calendar"&&<CalendarPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated} setPage={navigate} onOpenFlight={(flight)=>{try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:flight.roster?.id,di:flight.di,fi:flight.fi,flightData:flight}));}catch{}setPendingFlight(flight);navigate("logbook");}}/>}
              {page==="add-flight"&&<AddFlightPage user={user} rosters={rosters} onRosterSaved={handleRosterSaved} setPage={navigate}/>}
              {page==="more"&&<MorePage user={user} setPage={navigate} onLogout={handleLogout} rosters={rosters} tails={tails}/>}
              {page==="settings"&&<SettingsPage user={user} rosters={rosters} tails={tails} isDark={isDark} onToggleTheme={handleToggleTheme}/>}
              {page==="map"&&<RouteMapPage rosters={rosters} tails={tails}/>}
              {page==="analytics"&&<AnalyticsPage user={user} rosters={rosters} tails={tails}/>}
              {page==="profile"&&<ProfilePage user={user} onUserUpdated={u=>setUser(u)} setPage={navigate}/>}
              {page==="referral"&&<ReferralPage user={user}/>}
              {page==="membership"&&<MembershipPage user={user}/>}
              {page==="subscriptions"&&<SubscriptionsPage user={user}/>}
              {page==="support"&&<SupportPage user={user}/>}
              {page==="export"&&<ExportPage rosters={rosters} tails={tails}/>}
              {page==="admin-overview"&&user?.role==="admin"&&<AdminOverview/>}
              {page==="admin-users"&&user?.role==="admin"&&<AdminUsers onViewAsUser={enterAdminView}/>}
              {page==="admin-audit"&&user?.role==="admin"&&<AdminAuditLogs/>}
              {page==="admin-rosters"&&user?.role==="admin"&&<AdminRosters/>}
              {page==="admin-analysis"&&user?.role==="admin"&&<AdminAnalysis/>}
              {page==="admin-settings"&&user?.role==="admin"&&<AdminSettings/>}
              {page==="admin-content"&&user?.role==="admin"&&<AdminContent/>}
              </div>
              {/* Fixed bottom nav -- outside scrollable area so it never scrolls away */}
              <div className="mobile-tabbar" style={{flexShrink:0}}>
                <BottomTabBar page={page} user={user} setPage={navigate}/>
              </div>
            </div>
          </div>
          )}
        </div>
        );
      })()}
      <InstallPrompt/>
    </div>
    </ErrorBoundary>
  );
}
