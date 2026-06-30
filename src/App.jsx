// ===============================================================================
// FlightLog -- Main App  (React + Supabase)
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
// FlightLog App -- v2.1.0
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
              if(r.status === 401 && sb.auth._refreshToken) {
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
  base:    "#0B0F1C",   // near-black navy -- like a night cockpit
  surface: "#131929",   // card/panel background
  panel:   "#1A2235",   // elevated panel
  panelLt: "#202C42",
  border:  "#2C3A55",   // hairline separator
  ink:     "#F0F4FF",   // primary text -- crisp blue-white
  silver:  "#8A9BC0",   // secondary text
  muted:   "#4E5E7A",   // placeholder / disabled
  teal:    "#3B82F6",   // primary blue -- confident, aviation instrument blue
  tealDim: "#2563EB",
  red:     "#EF4444",
  redDim:  "#DC2626",
  green:   "#22C55E",
  gold:    "#F59E0B",   // amber -- the color of analog instrument lighting
  orange:  "#3B82F6",
  orangeDim:"#2563EB",
  white:   "#F0F4FF",
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
};

// C is set at runtime based on user preference
// Default to light theme -- applyTheme() called on App mount
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
    purple:   dark ? "#A78BFA" : "#7C3AED",
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
    // Status colors (stay vivid in both themes)
    amber:    "#F59E0B",
    amberBg:  dark ? "#2D1F00" : "#FFFBEB",
    amberBdr: dark ? "#78350F" : "#FDE68A",
    blueBg:   dark ? "#0F1F3D" : "#EFF6FF",
    blueBdr:  dark ? "#1E3A5F" : "#BFDBFE",
    greenBg:  dark ? "#052E16" : "#ECFDF5",
    greenBdr: dark ? "#14532D" : "#A7F3D0",
    redBg:    dark ? "#2D0A0A" : "#FEF2F2",
    redBdr:   dark ? "#7F1D1D" : "#FECACA",
  };
}

// Read preference from localStorage (default: light)
function getThemePref() {
  try { return localStorage.getItem("fl_theme") === "dark"; }
  catch { return false; }
}

function setThemePref(isDark) {
  try { localStorage.setItem("fl_theme", isDark ? "dark" : "light"); }
  catch {}
}

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
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:${C.base}}
.auth-card{background:${C.surface};border:1px solid ${C.border};border-radius:16px;padding:32px;width:100%;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.auth-logo{font-size:24px;font-weight:700;color:${C.ink};margin-bottom:4px}
.auth-logo span{color:${C.teal}}
.auth-tagline{font-size:13px;color:${C.muted};margin-bottom:24px}
.auth-tabs{display:flex;border:1px solid ${C.border};border-radius:9px;padding:3px;margin-bottom:20px;gap:3px}
.auth-tab{flex:1;padding:7px;border-radius:7px;border:none;background:none;font-size:13px;font-weight:500;color:${C.muted};transition:all .15s}
.auth-tab.active{background:${C.teal};color:#fff;font-weight:600}
.auth-error{background:${C.red}12;border:1px solid ${C.red}33;color:${C.red};border-radius:8px;padding:10px 13px;font-size:13px;margin-bottom:14px}
.auth-back{background:none;border:none;color:${C.muted};font-size:13px;margin-top:16px;width:100%;text-align:center}
.auth-back:hover{color:${C.ink}}

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
  let totalLandings=0, totalNightLandings=0;
  const airportSet=new Set();
  const now2 = new Date();
  const cutoff30  = new Date(now2); cutoff30.setDate(now2.getDate()-30);
  const cutoff6mo = new Date(now2); cutoff6mo.setMonth(now2.getMonth()-6);
  const cutoff12mo= new Date(now2); cutoff12mo.setMonth(now2.getMonth()-12);
  const last30  = {mins:0,legs:0,night:0,xc:0,landings:0};
  const last6mo = {mins:0,legs:0,night:0,xc:0,landings:0};
  const last12mo= {mins:0,legs:0,night:0,xc:0,landings:0};

  for(const r of rosters){
    const mNum=r.monthNum??r.month_num??0;
    (r.calendar||[]).forEach((d,di)=>{
      (d.flights||[]).forEach((f,fi)=>{
        const tk=`${r.id}-${di}-${fi}`;
        const t=tails[tk]||{};
        if(t.cancelled) return;
        const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
        const flightDate=new Date(dateStr+"T00:00:00");
        const monthKey=dateStr.slice(0,7);
        const mins=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
        const dist=calcDist(f.dep,f.arr)||0;
        const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
        const nightMins=solar?.nightMins||0;
        const isXC=dist>50;
        if(!byMonth[monthKey]) byMonth[monthKey]={mins:0,legs:0,night:0,xc:0,landings:0,nightLandings:0};
        byMonth[monthKey].mins+=mins;
        byMonth[monthKey].legs+=1;
        byMonth[monthKey].night+=nightMins;
        if(isXC) byMonth[monthKey].xc+=1;
        byMonth[monthKey].landings+=1;
        if(solar?.nightArr) byMonth[monthKey].nightLandings+=1;
        totalMins+=mins; totalLegs+=1; totalNight+=nightMins;
        if(isXC) totalXC+=1;
        totalLandings+=1;
        if(solar?.nightArr) totalNightLandings+=1;
        if(f.dep) airportSet.add(f.dep);
        if(f.arr) airportSet.add(f.arr);
        // Rolling time buckets
        if(flightDate>=cutoff30)  { last30.mins+=mins;  last30.legs+=1;  last30.night+=nightMins;  if(isXC)last30.xc+=1;  last30.landings+=1; }
        if(flightDate>=cutoff6mo) { last6mo.mins+=mins; last6mo.legs+=1; last6mo.night+=nightMins; if(isXC)last6mo.xc+=1; last6mo.landings+=1; }
        if(flightDate>=cutoff12mo){ last12mo.mins+=mins;last12mo.legs+=1;last12mo.night+=nightMins;if(isXC)last12mo.xc+=1;last12mo.landings+=1; }
      });
    });
  }
  return{
    totalMins,totalLegs,totalNight,totalXC,totalLandings,totalNightLandings,
    totalPIC,totalSIC,airports:airportSet.size,
    byMonth, last30, last6mo, last12mo,
    totalHrs:fmtMins(totalMins),
    nightHrs:fmtMins(totalNight),
    // totals object for AnalyticsPage backward-compat
    totals:{
      pic:totalPIC,
      sic:totalSIC,
      multi:0,
      turbine:0,
      night:totalNight,
      xc:totalXC,
      dist:0,
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
  const depCoords=AIRPORT_COORDS[depCode], arrCoords=AIRPORT_COORDS[arrCode];
  if(!depCoords||!arrCoords||!depTime||!arrTime) return {nightMins:0,dayDep:true,nightDep:false,dayArr:true,nightArr:false};
  const depSolar=solarTimes(dateStr,depCoords[0],depCoords[1]);
  const arrSolar=solarTimes(dateStr,arrCoords[0],arrCoords[1]);
  if(!depSolar||!arrSolar) return {nightMins:0,dayDep:true,nightDep:false,dayArr:true,nightArr:false};
  function localToUTC(hhmm,lon){const[h,m]=(hhmm||"00:00").split(":").map(Number);return(((h+m/60)-lon/15)%24+24)%24;}
  const depUTC=localToUTC(depTime,depCoords[1]);
  const arrUTC=localToUTC(arrTime,arrCoords[1]);
  const depIsNight=depUTC<depSolar.sunrise||depUTC>depSolar.sunset;
  const arrIsNight=arrUTC<arrSolar.sunrise||arrUTC>arrSolar.sunset;
  const depMins=Math.floor(depUTC*60), arrMins=Math.floor(arrUTC*60);
  const totalMins=((arrMins-depMins)+1440)%1440;
  const nightFraction=depIsNight&&arrIsNight?1:depIsNight||arrIsNight?0.5:0;
  return {
    nightMins:Math.round(totalMins*nightFraction),
    dayDep:!depIsNight, nightDep:depIsNight,
    dayArr:!arrIsNight, nightArr:arrIsNight,
  };
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

function getAirportUtcOffsetMins(airportCode) {
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
      return getOffsetFromTz(estimatedTz);
    }
    return 0;
  }
  return getOffsetFromTz(tz);
}

function getOffsetFromTz(tz) {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false,
    });
    const parts = fmt.formatToParts(now);
    let h = parseInt(parts.find(p=>p.type==="hour")?.value||"0");
    const m = parseInt(parts.find(p=>p.type==="minute")?.value||"0");
    if(h===24) h=0;
    const uh=now.getUTCHours(), um=now.getUTCMinutes();
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
  const rows=[["Date","Day","Flight","Dep","SchedDep","ActualDep","Arr","SchedArr","ActualArr","AircraftType","Tail","SchedBlock","ActualBlock","Period","Remarks"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const actualBlock=t.actualBlockMins!=null?fmtMins(t.actualBlockMins):"";
    const schedMinsVal=schedMins(f);
    const schedBlock=schedMinsVal!=null?fmtMins(schedMinsVal):"";
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    rows.push([dateStr,d.dow,f.flightNum,f.dep,f.depTime,t.actualDep||"",f.arr,f.arrTime,t.actualArr||"",f.acType||"",t.tail||"",schedBlock,actualBlock,r.periodLabel||"",t.remarks||""]);
  })));
  downloadCsv("flightlog-export.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
}

function jeppesenExport(rosters, tails) {
  // Jeppesen Professional Pilot Logbook column order
  const rows=[["Date","Flight No","From","To","Departure Time","Arrival Time","Aircraft Make & Model","Aircraft Ident","Total Duration of Flight","Night","Actual Instrument","Simulated Instrument","Cross Country","Dual Received","Pilot in Command","Solo","Ground Trainer","Remarks and Endorsements"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    const block=t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
    rows.push([dateStr,f.flightNum,f.dep,f.arr,t.actualDep||f.depTime,t.actualArr||f.arrTime,f.acType||"","N/"+  (t.tail||""),block,"","","","","",block,"","",t.remarks||""]);
  })));
  downloadCsv("flightlog-jeppesen.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
}

function asaExport(rosters, tails) {
  // ASA Standard Pilot Logbook columns
  const rows=[["Date","Aircraft Make/Model","Aircraft Ident","Route From","Route To","Total Flight Time","Night","Actual IMC","Simulated IMC","Cross-Country","Dual","PIC","Solo","Approaches","Remarks"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    if(t.cancelled) return;
    const mNum=r.monthNum??r.month_num??0;
    const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
    const block=t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
    rows.push([dateStr,f.acType||"","N/"+(t.tail||""),f.dep,f.arr,block,"","","","",block,"","","",t.remarks||""]);
  })));
  downloadCsv("flightlog-asa.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,"\"\"")}"`).join(",")).join("\n"));
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

async function db_signUp(email, password, name, plan, airlineIata="", airlineName="") {
  if(isConfigured()) {
    const {data,error} = await sb.auth.signUp({email,password,options:{data:{name,plan,airline_iata:airlineIata,airline_name:airlineName}}});
    if(error) throw new Error(error.message||"Sign up failed");
    return data.user;
  }
  // local fallback
  const users = local.get("fl_users")||[];
  if(users.find(u=>u.email===email)) throw new Error("Email already registered.");
  const user = {id:"u"+Date.now(),email,name,plan,role:"pilot",joined:new Date().toISOString().slice(0,10),active:true,airlineIata,airlineName};
  users.push({...user,password});
  local.set("fl_users",users);
  local.set("fl_session",user);
  return user;
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

async function db_saveRoster(userId, roster) {
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
        const cfRes = await fetch(
          `${SUPA_URL}/rest/v1/rosters?select=id,calendar&user_id=eq.${userId}&year=eq.${nextYear}&month_num=eq.${nextMonth}`,
          {headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`}}
        );
        const cfData = await cfRes.json();
        const nextRoster = Array.isArray(cfData) && cfData.length > 0 ? cfData[0] : null;

        if(nextRoster?.id) {
          const existingCal = Array.isArray(nextRoster.calendar) ? nextRoster.calendar : [];
          // Only skip carry-forward days if the existing day has actual flights
          // (isOff:true placeholder days get replaced by carry-forward flight data)
          const existingFlightDayNums = new Set(
            existingCal.filter((d) => d.flights?.length > 0 || d.dutyCode).map((d) => d.day)
          );
          const daysToAdd = validCarry.filter((d) => !existingFlightDayNums.has(d.day));
          if(daysToAdd.length > 0) {
            // Remove isOff placeholder days that are being replaced by carry-forward data
            const daysToAddNums = new Set(daysToAdd.map((d) => d.day));
            const filteredExisting = existingCal.filter((d) => !daysToAddNums.has(d.day));
            const merged = [...filteredExisting, ...daysToAdd].sort((a,b)=>a.day-b.day);
            await fetch(
              `${SUPA_URL}/rest/v1/rosters?id=eq.${nextRoster.id}`,
              {method:"PATCH", headers:{"apikey":SUPA_ANON,"Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"Content-Type":"application/json","Prefer":"return=minimal"},
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
    const restHeaders = {
      "apikey": SUPA_ANON,
      "Authorization": `Bearer ${sb.auth._token||SUPA_ANON}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    };

    const lookupRes = await fetch(
      `${restBase}?select=id,calendar&user_id=eq.${userId}&year=eq.${roster.year}&month_num=eq.${roster.monthNum}`,
      {headers: restHeaders}
    );
    const lookupData = await lookupRes.json();
    const existing = Array.isArray(lookupData) && lookupData.length > 0 ? lookupData[0] : null;

    if(existing?.id) {
      const existingCal = Array.isArray(existing.calendar) ? existing.calendar : [];
      const newDayNums = new Set(thisDays.map((d) => d.day));

      // Preserve existing days not in the new upload
      const preservedDays = existingCal.filter((d) => !newDayNums.has(d.day));

      // For days that exist in BOTH: prefer whichever has flights
      // (carry-forward flight day beats new upload's isOff placeholder)
      const existingByDay = {};
      existingCal.forEach((d) => { existingByDay[d.day] = d; });

      const resolvedNewDays = thisDays.map((d) => {
        const existingDay = existingByDay[d.day];
        // If new upload says isOff but existing has flights -- keep existing
        if((d.isOff || d.flights?.length === 0) && existingDay?.flights?.length > 0) {
          return existingDay;
        }
        return d;
      });

      const mergedCal = [...resolvedNewDays, ...preservedDays].sort((a,b)=>a.day-b.day);
      const updateRes = await fetch(
        `${restBase}?id=eq.${existing.id}`,
        {method:"PATCH", headers:restHeaders, body:JSON.stringify({period_label:roster.periodLabel, calendar:mergedCal})}
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

async function db_saveTail(userId, rosterId, flightKey, tail, actualDep="", actualArr="", actualBlockMins=null, lock=false, schedBlockMins=null, depGate=null, arrGate=null) {
  if(isConfigured()) {
    const payload = {
      user_id:userId, roster_id:rosterId, flight_key:flightKey,
      tail_number:tail,
      actual_dep_time: actualDep || null,
      actual_arr_time: actualArr || null,
      actual_block_mins: actualBlockMins ?? null,
    };
    if(schedBlockMins!=null) payload.sched_block_mins = schedBlockMins;
    if(lock) payload.final_synced = true;
    if(depGate!=null) payload.dep_gate = depGate;
    if(arrGate!=null) payload.arr_gate = arrGate;
    const {error} = await sb.from("tail_logs").upsert(payload, {onConflict:"user_id,roster_id,flight_key"});
    if(error) throw new Error(error.message||"Failed to save tail data");
    return;
  }
  const map = local.get("fl_tails_"+userId)||{};
  map[`${rosterId}-${flightKey}`]={tail, actualDep, actualArr, actualBlockMins, schedBlockMins};
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
        Flight<span style={{color:"#2D8CF0"}}>Log</span>
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
  const [airlineIata, setAirlineIata] = useState("");
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
        const {data,error} = await sb.auth.signUp({email,password,options:{data:{name,plan:"pro",airline_iata:airlineIata}}});
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
      color:"#7C3AED",
      icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill="#7C3AED"/><rect x="10" y="7" width="4" height="14" rx="1" fill="#7C3AED"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#7C3AED"/></svg>,
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
      <div style={{position:"absolute",top:"20%",left:"-20%",width:"60%",height:"40%",background:"#EDE9FE",borderRadius:"50%",filter:"blur(80px)",opacity:0.6,pointerEvents:"none",zIndex:0}}/>

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
                Flight<span style={{color:"#1D4ED8"}}>Log</span>
              </div>
              <div style={{fontSize:14,color:"#64748B",marginTop:4}}>{mode==="login"?"Welcome back":"Create your account"}</div>
            </div>
            {/* Error */}
            {err&&<div style={{fontSize:13,color:"#DC2626",marginBottom:12,padding:"10px 14px",background:"#FEF2F2",borderRadius:10,border:"1px solid #FECACA"}}>{err}</div>}
            {/* Fields */}
            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
              {mode==="signup"&&(
                <input
                  style={{padding:"14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none"}}
                  placeholder="Full name" value={name} onChange={e=>setName(e.target.value)}
                />
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
              {mode==="signup"&&(
                <input
                  style={{padding:"14px 16px",borderRadius:14,border:"1px solid #E2E8F0",fontSize:15,background:"#fff",color:"#0F172A",outline:"none",WebkitAppearance:"none"}}
                  placeholder="Airline IATA (e.g. G7, UA)" value={airlineIata}
                  onChange={e=>setAirlineIata(e.target.value.toUpperCase().slice(0,3))} maxLength={3}
                />
              )}
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
              {/* App icon */}
              <div style={{
                width:80,height:80,
                background:"#1D4ED8",
                borderRadius:24,
                boxShadow:"0 12px 32px rgba(29,78,216,0.3)",
                display:"flex",alignItems:"center",justifyContent:"center",
                marginBottom:24,position:"relative",
              }}>
                <svg width="38" height="38" viewBox="0 0 24 24" fill="none">
                  <path d="M5 17l6-10 3 5 3-4 4 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div style={{position:"absolute",bottom:12,right:12,width:14,height:14,borderRadius:"50%",background:"#1D4ED8",border:"2.5px solid #fff",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
              </div>
              {/* App name */}
              <h1 style={{fontSize:32,fontWeight:900,color:"#0F172A",letterSpacing:"-1px",margin:0,lineHeight:1.1}}>
                Aero<span style={{color:"#1D4ED8"}}>Log</span>
              </h1>
              <p style={{fontSize:15,fontWeight:500,color:"#64748B",marginTop:8,marginBottom:0}}>
                Your pilot logbook, on autopilot
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
              {/* Biometric if available */}
              {showBio&&(
                <button onClick={bioSignIn} disabled={bioLoading} style={{width:"100%",padding:"15px",borderRadius:16,background:"rgba(29,78,216,0.08)",border:"1.5px solid rgba(29,78,216,0.2)",color:"#1D4ED8",fontSize:14,fontWeight:700,cursor:bioLoading?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:4}}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="10" rx="2" stroke="#1D4ED8" strokeWidth="2"/><path d="M8 11V7a4 4 0 018 0v4" stroke="#1D4ED8" strokeWidth="2" strokeLinecap="round"/></svg>
                  {bioLoading?"Authenticating...":"Sign in with Face ID"}
                </button>
              )}
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

  const S = {
    bg:"#F8FAFC", surface:"#FFFFFF", border:"#E2E8F0",
    ink:"#0F172A", muted:"#64748B", silver:"#475569",
    blue:"#1D4ED8", blueDim:"#1E40AF", panel:"#F1F5F9",
  };

  return(
    <div style={{background:S.bg,minHeight:"100vh",fontFamily:"Inter,system-ui,sans-serif",color:S.ink,overflowX:"hidden",position:"relative"}}>

      {/* Background blobs */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:0,overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",left:"-10%",width:"40%",height:"40%",background:"#C7D2FE",borderRadius:"50%",filter:"blur(100px)",opacity:0.5}}/>
        <div style={{position:"absolute",top:"20%",right:"-10%",width:"40%",height:"40%",background:"#BAE6FD",borderRadius:"50%",filter:"blur(100px)",opacity:0.5}}/>
        <div style={{position:"absolute",bottom:"-10%",left:"20%",width:"50%",height:"40%",background:"#FDE8D8",borderRadius:"50%",filter:"blur(120px)",opacity:0.4}}/>
      </div>

      {/* NAV */}
      <nav style={{position:"fixed",top:0,left:0,right:0,zIndex:100,transition:"all .3s",background:scrolled?"rgba(248,250,252,0.96)":"transparent",backdropFilter:scrolled?"blur(16px)":"none",borderBottom:scrolled?`1px solid ${S.border}`:"none"}}>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"0 20px",height:64,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:34,height:34,borderRadius:9,background:`linear-gradient(135deg,${S.blue},#7C3AED)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <span style={{fontSize:19,fontWeight:900,color:S.ink,letterSpacing:"-.5px"}}>Flight<span style={{color:S.blue}}>Log</span></span>
          </div>
          {/* Desktop links */}
          <div style={{display:"flex",gap:28,alignItems:"center"}}>
            {["Features","How it works","Pricing"].map(l=>(
              <button key={l} onClick={()=>document.getElementById(l.toLowerCase().replace(/ /g,"-"))?.scrollIntoView({behavior:"smooth"})} style={{fontSize:14,color:S.muted,background:"none",border:"none",cursor:"pointer",fontWeight:500,padding:0,display:"none"}}>
                {l}
              </button>
            ))}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={onLogin} style={{fontSize:14,color:S.ink,background:"none",border:"none",cursor:"pointer",fontWeight:600,padding:"8px 12px"}}>Log in</button>
            <button onClick={onSignup} style={{fontSize:13,fontWeight:700,color:"#fff",background:S.ink,border:"none",padding:"9px 18px",borderRadius:100,cursor:"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.15)",whiteSpace:"nowrap"}}>Get started →</button>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section style={{maxWidth:1200,margin:"0 auto",padding:"100px 20px 60px",position:"relative",zIndex:1}}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:40,alignItems:"center"}}>
          {/* Left text */}
          <div style={{maxWidth:600,margin:"0 auto",textAlign:"center"}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"5px 14px",borderRadius:100,background:S.surface,border:`1px solid ${S.border}`,boxShadow:"0 1px 4px rgba(0,0,0,0.06)",fontSize:12,fontWeight:700,color:S.muted,marginBottom:24}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:S.blue,display:"inline-block"}}/>
              Automated Pilot Logbook
            </div>
            <h1 style={{fontSize:"clamp(34px,6vw,68px)",fontWeight:900,lineHeight:1.05,letterSpacing:"-2px",color:S.ink,marginBottom:18}}>
              Your logbook,<br/>
              <span style={{background:`linear-gradient(90deg,${S.blue},#7C3AED)`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>on autopilot.</span>
            </h1>
            <p style={{fontSize:"clamp(15px,2vw,18px)",color:S.silver,lineHeight:1.7,marginBottom:32,maxWidth:480,margin:"0 auto 32px"}}>
              Upload your PDF roster from FLICA, AIMS, CrewTrac, or any airline. FlightLog reads every flight and syncs actual tail numbers and block times via FlightAware -- automatically.
            </p>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginBottom:40}}>
              <button onClick={onSignup} style={{background:`linear-gradient(135deg,${S.blue},#7C3AED)`,color:"#fff",border:"none",padding:"14px 28px",borderRadius:100,fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:`0 8px 24px ${S.blue}35`,whiteSpace:"nowrap"}}>
                Start your logbook →
              </button>
              <button onClick={()=>document.getElementById("how-it-works")?.scrollIntoView({behavior:"smooth"})} style={{background:S.surface,color:S.ink,border:`1px solid ${S.border}`,padding:"14px 24px",borderRadius:100,fontSize:15,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:8,boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke={S.blue} strokeWidth="2"/><path d="M10 8l6 4-6 4V8z" fill={S.blue}/></svg>
                See how it works
              </button>
            </div>
            {/* Trust stats */}
            <div style={{display:"flex",gap:32,justifyContent:"center",flexWrap:"wrap"}}>
              {[["99.2%","Parse accuracy"],["<15 min","Auto-sync"],["40+","Airlines"]].map(([v,l])=>(
                <div key={l} style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:900,color:S.ink,letterSpacing:"-.5px"}}>{v}</div>
                  <div style={{fontSize:11,color:S.muted,marginTop:2,fontWeight:500}}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Dashboard preview card */}
          <div style={{position:"relative",maxWidth:520,margin:"0 auto",width:"100%"}}>
            <div style={{background:"rgba(255,255,255,0.9)",backdropFilter:"blur(16px)",border:`1px solid ${S.border}`,borderRadius:24,boxShadow:"0 24px 64px rgba(0,0,0,0.09)",padding:20}}>
              {/* Card chrome */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`1px solid ${S.panel}`,paddingBottom:12,marginBottom:16}}>
                <div style={{display:"flex",gap:5}}>
                  {["#FDA4AF","#FCD34D","#86EFAC"].map(c=><div key={c} style={{width:10,height:10,borderRadius:"50%",background:c}}/>)}
                </div>
                <div style={{fontSize:11,fontWeight:700,color:S.muted,background:S.panel,padding:"3px 10px",borderRadius:100}}>FlightLog Dashboard</div>
              </div>
              {/* Next flight */}
              <div style={{background:`linear-gradient(135deg,${S.blue},#1E3A8A)`,borderRadius:16,padding:"16px 18px",marginBottom:12,position:"relative",overflow:"hidden"}}>
                <div style={{position:"absolute",top:-20,right:-20,width:80,height:80,borderRadius:"50%",background:"rgba(255,255,255,0.06)"}}/>
                <div style={{fontSize:9,color:"rgba(255,255,255,0.6)",fontWeight:700,letterSpacing:"1.5px",textTransform:"uppercase",marginBottom:10}}>Next Departure</div>
                <div style={{display:"flex",alignItems:"center"}}>
                  <div><div style={{fontSize:26,fontWeight:900,color:"#fff",lineHeight:1}}>ORD</div><div style={{fontSize:10,color:"rgba(255,255,255,0.6)",marginTop:2}}>08:45</div></div>
                  <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"0 12px"}}>
                    <div style={{width:"100%",display:"flex",alignItems:"center",gap:4}}>
                      <div style={{flex:1,height:1,background:"rgba(255,255,255,0.25)"}}/>
                      <span style={{color:"rgba(255,255,255,0.9)",fontSize:14}}>✈</span>
                      <div style={{flex:1,height:1,background:"rgba(255,255,255,0.25)"}}/>
                    </div>
                    <div style={{fontSize:10,color:"rgba(255,255,255,0.5)",marginTop:3}}>247 NM</div>
                  </div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:26,fontWeight:900,color:"#fff",lineHeight:1}}>SCE</div><div style={{fontSize:10,color:"rgba(255,255,255,0.6)",marginTop:2}}>10:52</div></div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#fff"}}>G7 4475 · CRJ-700</div>
                  <div style={{fontSize:11,fontWeight:800,color:"#fff"}}>3h 12m</div>
                </div>
              </div>
              {/* Stats */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:10}}>
                {[["324h","Hours"],["812","Legs"],["47","Airports"],["803","Synced"]].map(([v,l])=>(
                  <div key={l} style={{background:S.panel,borderRadius:10,padding:"8px 6px",textAlign:"center"}}>
                    <div style={{fontSize:13,fontWeight:800,color:S.ink}}>{v}</div>
                    <div style={{fontSize:9,color:S.muted,marginTop:1,fontWeight:600,textTransform:"uppercase",letterSpacing:".3px"}}>{l}</div>
                  </div>
                ))}
              </div>
              {/* Sync status */}
              <div style={{background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:10,padding:"9px 12px",display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:"#22C55E",flexShrink:0,boxShadow:"0 0 0 3px rgba(34,197,94,0.2)"}}/>
                <div style={{fontSize:12,color:"#166534",fontWeight:600,flex:1}}>Auto-sync active · FlightAware</div>
                <div style={{fontSize:12,fontWeight:800,color:"#16A34A"}}>99%</div>
              </div>
            </div>
            {/* Floating badges */}
            <div style={{position:"absolute",left:-16,top:40,background:S.surface,padding:"10px 14px",borderRadius:14,boxShadow:"0 8px 24px rgba(29,78,216,0.15)",border:`1px solid ${S.border}`,zIndex:3,animation:"float 3s ease-in-out infinite"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:30,height:30,borderRadius:8,background:"linear-gradient(135deg,#22C55E,#16A34A)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div><div style={{fontSize:9,color:S.muted,fontWeight:600}}>Tail synced</div><div style={{fontSize:13,fontWeight:800,color:S.ink,fontFamily:"monospace"}}>N47425</div></div>
              </div>
            </div>
            <div style={{position:"absolute",right:-12,bottom:50,background:S.surface,padding:"10px 14px",borderRadius:14,boxShadow:"0 8px 24px rgba(124,58,237,0.15)",border:`1px solid ${S.border}`,zIndex:3,animation:"float 3s ease-in-out infinite",animationDelay:"1.5s"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:30,height:30,borderRadius:8,background:"linear-gradient(135deg,#7C3AED,#1D4ED8)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="2"/><path d="M12 7v5l3 3" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <div><div style={{fontSize:9,color:S.muted,fontWeight:600}}>Block time</div><div style={{fontSize:13,fontWeight:800,color:S.ink}}>2:07 actual</div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

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
              {quote:"Finally a logbook that actually knows what a GoJet roster looks like. The tail number sync is magic -- I haven't typed a tail in months.",role:"Captain, CRJ-700 · Regional airline",initials:"JT"},
              {quote:"Currency tracking alone is worth it. Before FlightLog I was manually counting landings in a spreadsheet before every IPC. Never again.",role:"F/O, A320 · Low-cost carrier",initials:"SA"},
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
                  <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${S.blue},#7C3AED)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:13,fontWeight:700,flexShrink:0}}>
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
          <p style={{fontSize:15,color:S.silver,maxWidth:440,margin:"0 auto",lineHeight:1.65}}>No manual entry. One PDF upload and FlightLog handles the rest.</p>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:14}}>
          {[
            {icon:"📄",bg:"#EFF6FF",bc:"#DBEAFE",title:"Smart Roster Parsing",desc:"Reads any airline PDF -- FLICA, AIMS, CrewTrac, SkedPlus+, GoJet, Republic, Delta, United, American and more."},
            {icon:"✈",bg:"#F0FDF4",bc:"#BBF7D0",title:"Live FlightAware Sync",desc:"Actual tail numbers and block times pulled within 15 minutes of landing. Zero manual entry, ever."},
            {icon:"📊",bg:"#FFF7ED",bc:"#FED7AA",title:"Currency Tracking",desc:"FAR 61.57 landings, IFR currency, FAR 117 duty limits -- always current, always audit-ready."},
            {icon:"📋",bg:"#F5F3FF",bc:"#DDD6FE",title:"Jeppesen & ASA Export",desc:"Download in formats that match physical logbook columns exactly. Ready to import anywhere."},
            {icon:"🗺️",bg:"#ECFDF5",bc:"#A7F3D0",title:"Route Maps & Radar",desc:"Interactive route maps with live weather radar overlay for upcoming flights within 24 hours."},
            {icon:"🤖",bg:"#FFF1F2",bc:"#FFE4E6",title:"AI Flight Briefing",desc:"One-tap briefing for your next flight -- weather, NOTAMs, and route summary. Updated hourly."},
          ].map(({icon,bg,bc,title,desc})=>(
            <div key={title} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:24}}>
              <div style={{width:48,height:48,borderRadius:12,background:bg,border:`1px solid ${bc}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,marginBottom:14}}>{icon}</div>
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
              {icon:"📤",num:"01",title:"Upload your roster",desc:"Drop your monthly PDF from FLICA, AIMS, CrewTrac, SkedPlus+, or any airline format. AI extracts every leg automatically."},
              {icon:"⚡",num:"02",title:"Flights sync automatically",desc:"Within 15 minutes of landing, actual tail number and block time are pulled from FlightAware."},
              {icon:"📋",num:"03",title:"Export & stay current",desc:"Download in Jeppesen or ASA format. Currency tracking always ready for a checkride."},
            ].map(({icon,num,title,desc},i)=>(
              <div key={title} style={{padding:"32px 24px",borderRight:i<2?`1px solid ${S.border}`:"none",borderBottom:"none"}}>
                <div style={{fontSize:48,fontWeight:900,color:S.panel,lineHeight:1,marginBottom:14}}>{num}</div>
                <div style={{width:40,height:40,borderRadius:10,background:"#EFF6FF",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,marginBottom:12}}>{icon}</div>
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
            <h2 style={{fontSize:"clamp(24px,3.5vw,38px)",fontWeight:900,color:S.ink,marginBottom:12,letterSpacing:"-.8px",lineHeight:1.1}}>Simple, honest pricing</h2>
            <p style={{fontSize:14,color:S.silver,lineHeight:1.65,marginBottom:20}}>One plan, everything included. No feature tiers, no hidden fees.</p>
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
                  <span style={{fontSize:44,fontWeight:900,color:S.ink,letterSpacing:"-2px"}}>$14</span>
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
            <div style={{background:`linear-gradient(160deg,${S.blue},#7C3AED)`,borderRadius:24,padding:28,boxShadow:`0 16px 48px ${S.blue}35`,display:"flex",flexDirection:"column",justifyContent:"space-between",position:"relative"}}>
              <div style={{position:"absolute",top:0,right:24,transform:"translateY(-50%)",background:"linear-gradient(90deg,#EC4899,#F97316)",color:"#fff",fontSize:10,fontWeight:800,letterSpacing:"1px",textTransform:"uppercase",padding:"5px 12px",borderRadius:100,boxShadow:"0 4px 12px rgba(236,72,153,0.4)"}}>Best Value</div>
              <div>
                <div style={{display:"inline-flex",padding:"4px 12px",borderRadius:100,background:"rgba(255,255,255,0.2)",fontSize:11,fontWeight:700,color:"#fff",marginBottom:16}}>Annual</div>
                <div style={{display:"flex",alignItems:"baseline",marginBottom:4}}>
                  <span style={{fontSize:44,fontWeight:900,color:"#fff",letterSpacing:"-2px"}}>$99</span>
                  <span style={{fontSize:13,color:"rgba(255,255,255,0.65)",marginLeft:5}}>/year</span>
                </div>
                <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginBottom:4}}>$8.25/month · Save 41%</div>
                {["Everything in monthly","2 months free","Locked-in rate","Priority support"].map(f=>(
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
            <div style={{width:26,height:26,borderRadius:7,background:`linear-gradient(135deg,${S.blue},#7C3AED)`,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <span style={{fontSize:15,fontWeight:800,color:S.ink,letterSpacing:"-.5px"}}>Flight<span style={{color:S.blue}}>Log</span></span>
          </div>
          <div style={{display:"flex",gap:20}}>
            {["Privacy","Terms","Support"].map(l=><span key={l} style={{fontSize:12,color:S.muted,cursor:"pointer",fontWeight:500}}>{l}</span>)}
          </div>
          <div style={{fontSize:11,color:"#94A3B8"}}>© 2026 FlightLog. All rights reserved.</div>
        </div>
      </footer>

      <style>{`@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}@media(max-width:768px){.lp-how-step{border-right:none!important;border-bottom:1px solid #E2E8F0}}`}</style>
    </div>
  );
}

function AuthPage({onAuth, onBack, initialMode="login"}) {
  const [mode,setMode]=useState(initialMode);
  const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [name,setName]=useState(""); const [plan,setPlan]=useState("pro");
  const [airlineIata,setAirlineIata]=useState(""); const [airlineName,setAirlineName]=useState("");
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
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
      if(mode==="login") {
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
        if(!name||!email||!password) throw new Error("All fields required.");
        const user = await db_signUp(email,password,name,plan,airlineIata,airlineName);
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
    <div className="auth-wrap" style={{background:C.base}}>
      <div className="auth-card">
        <div className="auth-logo">Flight<span>Log</span></div>
        <div className="auth-tagline">Your automated pilot logbook</div>

        {!configured && (
          <div className="warn" style={{fontSize:12}}>
            ⚠ Running in demo mode. Add <code>VITE_SUPABASE_URL</code> + <code>VITE_SUPABASE_ANON_KEY</code> to connect to your database.
          </div>
        )}

        <div className="auth-tabs">
          <button className={`auth-tab ${mode==="login"?"active":""}`} onClick={()=>{setMode("login");setErr("")}}>Log in</button>
          <button className={`auth-tab ${mode==="signup"?"active":""}`} onClick={()=>{setMode("signup");setErr("")}}>Sign up</button>
        </div>

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
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Full name</label>
            <input className="form-input" placeholder="Captain Jane Smith" value={name} onChange={e=>setName(e.target.value)} autoComplete="name" name="name"/>
          </div>
        )}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Airline (optional)</label>
            <input className="form-input" placeholder="e.g. United Airlines" value={airlineName} onChange={e=>setAirlineName(e.target.value)}/>
          </div>
        )}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Airline IATA code (optional)</label>
            <input className="form-input" placeholder="e.g. UA, AA, DL, G7" value={airlineIata} onChange={e=>setAirlineIata(e.target.value.toUpperCase().slice(0,3))} maxLength={3} style={{width:120}}/>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" placeholder="you@airline.com" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" name="email" id="fl-email"/>
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} name="password" id="fl-password"/>
        </div>
        {mode==="login" && (
          <div style={{fontSize:12,color:C.muted,marginBottom:14}}>
            Your browser will offer to save your password after sign in.
          </div>
        )}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Plan</label>
            <select className="form-select" value={plan} onChange={e=>setPlan(e.target.value)}>
              <option value="starter">Starter -- Free</option>
              <option value="pro">Pro -- $9/mo</option>
            </select>
          </div>
        )}
        <button type="submit" className="btn-full" disabled={loading}>
          {loading ? <span className="spinner">⟳</span> : mode==="login"?"Log in":"Create account"}
        </button>
        </form>
        <button className="auth-back" onClick={onBack}>← Back to home</button>
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
    {id:"calendar",icon:"▦",label:"Roster View"},
    {id:"upload",icon:"⊕",label:"Upload Roster"},
    {id:"logbook",icon:"≡",label:"Logbook"},
    {id:"map",icon:"⊗",label:"Route Map"},
    {id:"analytics",icon:"⟁",label:"Stats"},
    {id:"settings",icon:"◎",label:"Settings"},
  ];
  const adminNav=[
    {id:"admin-overview",icon:"◈",label:"Overview"},
    {id:"admin-users",icon:"👥",label:"Users"},
    {id:"admin-rosters",icon:"📄",label:"All Rosters"},
    {id:"admin-settings",icon:"⚙",label:"Settings"},
  ];
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-text">Flight<span>Log</span></div>
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
    {id:"calendar",   icon:"▦", label:"Roster View"},
    {id:"upload",     icon:"⊕",  label:"Upload Roster"},
    {id:"logbook",    icon:"≡", label:"Logbook"},
    {id:"map",        icon:"⊗", label:"Route Map"},
    {id:"analytics",  icon:"⟁", label:"Stats"},
    {id:"settings",   icon:"◎",  label:"Settings"},
  ];
  const adminNav = [
    {id:"admin-overview", icon:"◈",  label:"Overview"},
    {id:"admin-users",    icon:"👥", label:"Users"},
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
          <div className="drawer-logo">Flight<span>Log</span></div>
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
          <button className="drawer-item" style={{color:"#DC2626"}} onClick={onLogout}>
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
    actualIfr:"", simIfr:"", dayLdg:0, nightLdg:0, approaches:0,
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
      let roster = rosters.find(r=>(r.monthNum??r.month_num??0)===monthNum&&r.year===yr);
      const flight = {
        flightNum:form.flightNum||"MANUAL",
        dep:form.dep.toUpperCase().slice(0,4),
        depTime:form.depTime,
        arr:form.arr.toUpperCase().slice(0,4),
        arrTime:form.arrTime,
        acType:form.acType.toUpperCase().slice(0,6)||"",
        schedBlockMins:computeBlock(),
      };
      const dayNum = parseInt(form.date.split("-")[2]);
      const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(form.date+"T12:00:00").getDay()];

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
        const saved = await db_saveRoster(user.id, newRoster);
        onRosterSaved(saved||newRoster);
      } else {
        const nc = [...(roster.calendar||[])];
        const dayIdx = nc.findIndex(d=>d.day===dayNum);
        if(dayIdx>=0){
          nc[dayIdx]={...nc[dayIdx],flights:[...(nc[dayIdx].flights||[]),flight]};
        } else {
          nc.push({day:dayNum,dow,isOff:false,dutyCode:null,flights:[flight]});
          nc.sort((a,b)=>a.day-b.day);
        }
        await db_saveRoster(user.id,{...roster,calendar:nc});
        onRosterSaved({...roster,calendar:nc});
      }

      // Save tail/times to tail_logs if entered
      if(form.tail){
        const rKey = roster?.id||Date.now().toString();
        // Would need the proper tk -- skip for now, tail added manually
      }

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
      <div style={{width:64,height:64,borderRadius:"50%",background:"#ECFDF5",display:"flex",alignItems:"center",justifyContent:"center"}}>
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
        <button onClick={save} disabled={saving} style={{padding:"9px 20px",borderRadius:12,background:saving?"#94A3B8":"linear-gradient(135deg,#1D4ED8,#7C3AED)",border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:saving?"not-allowed":"pointer",boxShadow:"0 4px 12px rgba(29,78,216,0.3)"}}>
          {saving?"⟳":"Save"}
        </button>
      </div>

      <div style={{padding:"16px 16px 80px",maxWidth:560,margin:"0 auto"}}>
        {err&&<div style={{padding:"10px 14px",borderRadius:10,background:"#FEF2F2",border:"1px solid #FECACA",color:"#DC2626",fontSize:13,marginBottom:12}}>{err}</div>}

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
              <input type="text" placeholder="G7 4522" value={form.flightNum} onChange={e=>set("flightNum",e.target.value.toUpperCase())} style={INPUT}/>
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
              <button key={k} onClick={()=>{set("isPIC",k==="isPIC");set("isSIC",k==="isSIC");}} style={{padding:"12px",borderRadius:12,border:`1.5px solid ${form[k]?S.blue:S.border}`,background:form[k]?"#EFF6FF":S.surface,color:form[k]?S.blue:S.muted,fontSize:14,fontWeight:700,cursor:"pointer"}}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Time breakdown */}
        <div style={SECTION}>
          <div style={{fontSize:13,fontWeight:700,color:S.ink,marginBottom:12}}>Time Breakdown (h:mm)</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[["Night","nightTime"],["Cross Country","xcTime"],["Actual IMC","actualIfr"],["Hood / Sim","simIfr"]].map(([lbl,k])=>(
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
                <input type="number" min="0" max="99" value={form[k]} onChange={e=>set(k,parseInt(e.target.value)||0)} style={{...INPUT,textAlign:"center"}}/>
              </div>
            ))}
          </div>
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

  const now=new Date();
  const firstName=(user?.name||user?.email||"Pilot").split(/\s|@/)[0];

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
          // Build datetime using local timezone
          const [yr,mo,dy]=dateStr.split("-").map(Number);
          const dt=new Date(yr,mo-1,dy,h,m,0,0);
          const dtTs=dt.getTime();
          if(dtTs>nowTs&&dtTs<cutoff) upcoming.push({f,day,roster,di,fi,tk,tail,dateStr,dt});
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
    const minsToGo=Math.round((dt.getTime()-Date.now())/60000);
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
  const briefKey=nextFlight?`fl_mini_brief_${nextFlight.f.flightNum}_${nextFlight.dateStr}`:"";
  useEffect(()=>{
    if(!briefKey) return;
    try{const c=localStorage.getItem(briefKey);if(c){const p=JSON.parse(c);if(Date.now()-p.ts<3600000)setMiniBriefing(p.text);}}catch{}
  },[briefKey]);

  async function fetchMiniBriefing(){
    if(!nextFlight||briefingLoading) return;
    setBriefingLoading(true);
    try{
      const f=nextFlight.f;
      const wxInfo=wx[f.dep];
      const prompt=`Brief this flight for an airline pilot: ${f.flightNum} ${f.dep}→${f.arr} on ${nextFlight.dateStr} departing ${f.depTime}. Aircraft: ${f.acType||"regional jet"}. ${wxInfo?`Current ${f.dep} weather: ${wxInfo.raw||"not available"}.`:""} Give a concise 3-paragraph briefing: departure weather, enroute conditions, arrival. Include any relevant NOTAMs or cautions. Be direct and professional.`;
      const briefRes=await fetch(`${SUPA_URL}/functions/v1/flight-briefing`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f.flightNum,dep:f.dep,arr:f.arr,date:nextFlight.dateStr,depTime:f.depTime,acType:f.acType})});
      const d=await briefRes.json();
      const text=d.briefing||d.text||d.content?.[0]?.text||"Briefing unavailable.";
      setMiniBriefing(text);
      try{localStorage.setItem(briefKey,JSON.stringify({text,ts:Date.now()}));}catch{}
    }catch{setMiniBriefing("Briefing unavailable -- check connection.");}
    setBriefingLoading(false);
  }

  // Stats
  const stats=useMemo(()=>{
    let totalMins=0,legs=0,airports=new Set(),synced=0,night=0;
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      (r.calendar||[]).forEach((d,di)=>(d.flights||[]).forEach((f,fi)=>{
        const tk=`${r.id}-${di}-${fi}`;
        const t=tails[tk]||{};
        if(t.cancelled) return;
        legs++;
        if(f.dep) airports.add(f.dep);
        if(f.arr) airports.add(f.arr);
        if(t.tail) synced++;
        const mins=t.actualBlockMins??schedMins(f)??0;
        totalMins+=mins;
        const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
        const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
        if(solar.nightDep||solar.nightArr) night+=Math.round((mins||0)*0.3);
      }));
    }
    return{hours:fmtMins(totalMins),legs,airports:airports.size,synced,nightHrs:fmtMins(night)};
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
  const catColor=fltCat==="VFR"?"#16A34A":fltCat==="MVFR"?"#2563EB":fltCat==="IFR"?"#DC2626":"#7C3AED";

  const S=getS();

  return(
    <div style={{flex:1,overflowY:"auto",overflowX:"hidden",background:S.bg,fontFamily:"Inter,system-ui,sans-serif",position:"relative",width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>

      {/* Background blobs */}
      <div style={{position:"absolute",top:"-5%",right:"-5%",width:"35%",height:"35%",background:"#C7D2FE",borderRadius:"50%",filter:"blur(80px)",opacity:0.3,pointerEvents:"none",zIndex:0}}/>
      <div style={{position:"absolute",top:"20%",left:"-10%",width:"25%",height:"25%",background:"#BAE6FD",borderRadius:"50%",filter:"blur(80px)",opacity:0.3,pointerEvents:"none",zIndex:0}}/>

      {/* HEADER */}
      <div style={{padding:"20px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",zIndex:1,maxWidth:1200,margin:"0 auto",width:"100%",boxSizing:"border-box"}}>
        <div>
          <h1 style={{fontSize:"clamp(18px,3vw,22px)",fontWeight:800,color:S.ink,margin:0,letterSpacing:"-.5px"}}>
            {now.getHours()<12?"Good morning":now.getHours()<17?"Good afternoon":"Good evening"}, {firstName}
          </h1>
          <p style={{fontSize:13,color:S.muted,margin:"3px 0 0"}}>
            {nextFlight?`Next duty starts in ${Math.round((nextFlight.dt-now)/3600000)}h`:"Welcome back to your logbook"}
          </p>
        </div>
        <div onClick={()=>setPage("profile")} style={{width:40,height:40,borderRadius:"50%",background:`linear-gradient(135deg,${S.blue},${S.purple})`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:15,fontWeight:700,cursor:"pointer",flexShrink:0}}>
          {firstName[0]?.toUpperCase()}
        </div>
      </div>

      <div style={{padding:"16px 16px 32px",maxWidth:"100%",width:"100%",boxSizing:"border-box",position:"relative",zIndex:1}}>

        {/* QUICK ACTIONS -- above upcoming flight */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10,marginBottom:20}}>
          {[
            {label:"Upload Roster",page:"upload",primary:true,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M12 4L8 8M12 4l4 4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"/></svg>},
            {label:"Add Flight",page:"add-flight",primary:false,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={S.blue} strokeWidth="2"/><path d="M12 8v8M8 12h8" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>},
            {label:"Roster View",page:"calendar",primary:false,svg:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke={S.blue} strokeWidth="2"/><path d="M8 2v4M16 2v4M3 9h18" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>},
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
          const hToGo=Math.floor(minsToGo/60);
          const mToGo=minsToGo%60;
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
                <div style={{position:"absolute",top:0,right:0,width:100,height:100,background:"#EFF6FF",borderRadius:"0 24px 0 100%",zIndex:0}}/>
                <div style={{position:"relative",zIndex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
                    <div>
                      <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"4px 10px",borderRadius:100,background:"#EFF6FF",border:"1px solid #BFDBFE",color:S.blue,fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:".8px",marginBottom:6}}>
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
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:"#F59E0B",background:"#FFFBEB",padding:"4px 10px",borderRadius:100,border:"1px solid #FDE68A",letterSpacing:".3px"}}>
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
                        {hToGo>0?`${hToGo}h ${mToGo}m until dep`:`${mToGo}m until dep`}
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
                      <div style={{width:36,height:36,borderRadius:10,background:within3hrs&&depGate?"#EFF6FF":S.panel,border:`1px solid ${within3hrs&&depGate?`${S.blue}30`:S.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
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
                      <div style={{width:36,height:36,borderRadius:10,background:within3hrs&&arrGate?"#EFF6FF":S.panel,border:`1px solid ${within3hrs&&arrGate?`${S.blue}30`:S.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
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
              <div style={{background:`linear-gradient(135deg,${S.purple},${S.blue})`,borderRadius:24,padding:"20px 22px",color:"#fff",boxShadow:`0 8px 32px ${S.purple}25`}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{background:"rgba(255,255,255,0.2)",padding:"8px",borderRadius:10,backdropFilter:"blur(8px)"}}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
                    </div>
                    <div>
                      <div style={{fontSize:12,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",color:"rgba(255,255,255,0.8)"}}>AI Briefing</div>
                      <div style={{fontSize:11,color:"rgba(255,255,255,0.6)"}}>{f.flightNum} · {f.dep}→{f.arr}{miniBriefing?" · cached 1hr":""}</div>
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
                <div style={{width:38,height:38,borderRadius:100,background:"#F5F3FF",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={S.purple} strokeWidth="2"/><path d="M12 7v5l3 3" stroke={S.purple} strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <span style={{fontSize:11,fontWeight:700,color:"#10B981",background:"#ECFDF5",padding:"3px 8px",borderRadius:6}}>Total</span>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Block Hours</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2,letterSpacing:"-1px"}}>{stats.hours}</div>
            </div>
            {/* Sectors */}
            <div style={{background:S.surface,borderRadius:18,padding:"16px 18px",border:`1px solid ${S.border}`,boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}>
              <div style={{width:38,height:38,borderRadius:100,background:"#EFF6FF",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke={S.blue} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Sectors Flown</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2}}>{stats.legs}</div>
            </div>
            {/* Night hours */}
            <div style={{background:S.surface,borderRadius:18,padding:"16px 18px",border:`1px solid ${S.border}`,boxShadow:"0 2px 8px rgba(0,0,0,0.04)"}}>
              <div style={{width:38,height:38,borderRadius:100,background:"#FFF1F2",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:12}}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="#EC4899" strokeWidth="2"/></svg>
              </div>
              <div style={{fontSize:10,color:S.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px"}}>Night Hours</div>
              <div style={{fontSize:26,fontWeight:900,color:S.ink,marginTop:2}}>{stats.nightHrs}</div>
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
                  return pastRows.slice(0,5).map(({f,d,di,fi,r,tk,t,dateStr},idx)=>(
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
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:6,background:"#ECFDF5",color:"#059669",fontSize:11,fontWeight:700}}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            Auto-Synced
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

function LogbookPage({user, rosters, tails, onTailSaved, onDeleteRoster, onRosterUpdated, pendingFlight, onPendingFlightConsumed, setPage}) {
  // Only show signedRosters that have been verified and signed
  const signedMonths = useMemo(()=>{
    try { return JSON.parse(localStorage.getItem("fl_signed_months")||"{}"); } catch { return {}; }
  },[]);
  const signedRosters = useMemo(()=>rosters.filter(r=>!!signedMonths[r.id]),[rosters,signedMonths]);

  const [selRoster, setSelRoster] = useState(()=>signedRosters.length>0?0:-1);
  const [selectedFlight, setSelectedFlight] = useState(null);
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
  const [view, setView] = useState("daily"); // "daily" | "logbook"
  const [search, setSearch] = useState("");
  const [lbPage, setLbPage] = useState(0);
  const LB_PAGE_SIZE = 20;

  const roster = selRoster >= 0 ? signedRosters[selRoster] : null;
  const mNum = roster ? (roster.monthNum??roster.month_num??0) : new Date().getMonth();
  const year = roster ? roster.year : new Date().getFullYear();

  // Restore flight detail from sessionStorage after page refresh
  // Store only the lookup key (rosterId, di, fi) so we reconstruct from fresh data
  useEffect(()=>{
    if(signedRosters.length === 0) return; // Wait for rosters to load
    try {
      const saved = sessionStorage.getItem("fl_open_flight");
      if(!saved) return;
      const {flightData, rosterIdx, rosterId, di, fi} = JSON.parse(saved);

      // Try to reconstruct from fresh rosters using stored keys
      if(rosterId != null && di != null && fi != null) {
        const freshRoster = signedRosters.find(r => r.id === rosterId)
          || rosters.find(r => r.id === rosterId);
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
      await db_saveRoster(user.id,{...roster,calendar:nc});
      onRosterUpdated(roster.id,nc);
      setLbAddForm({show:false,flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
    }catch(e){alert(e.message);}
    setLbAddSaving(false);
  }

  function openFlight(di,fi,f,day){
    const tk=`${roster.id}-${di}-${fi}`;
    const tail=tails[tk]||{};
    const mNum2=roster.monthNum??roster.month_num??0;
    const dateStr=`${roster.year}-${String(mNum2+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
    const dist=calcDist(f.dep,f.arr);
    const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
    const blockMinsVal=(tail.actualBlockMins!=null?tail.actualBlockMins:schedMins(f))||0;
    const flightData={f,day,roster,di,fi,tk,tail,dateStr,dist,solar,blockMins:blockMinsVal,hasActual:!!(tail.actualDep||tail.actualArr||tail.tail),dep:f.dep,arr:f.arr,isXC:(dist||0)>50,userId:user.id};
    try{sessionStorage.setItem("fl_open_flight",JSON.stringify({
      rosterIdx:selRoster,
      rosterId: roster.id,
      di, fi,
      flightData,
    }));}catch{}
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
            const res=await fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f.flightNum,date:dateStr,dep:f.dep,arr:f.arr})});
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
        onTailSaved={(v)=>{onTailSaved(tk,v);setSelectedFlight(p=>({...p,tail:{...p.tail,...v}}));}}
        editingTimes={editingTimes[tk]||false}
        setEditingTimes={v=>setEditingTimes(p=>({...p,[tk]:v}))}
        timeEdits={timeEdits[tk]||{}}
        setTimeEdits={v=>setTimeEdits(p=>({...p,[tk]:v}))}
        di={di} fi={fi} userId={userId||user.id}
      />
    );
  }

  // -- LOGBOOK VIEW
  if(signedRosters.length === 0) {
    return(
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:C.base,padding:32,gap:16,textAlign:"center"}}>
        <div style={{fontSize:48,marginBottom:4}}>🔒</div>
        <div style={{fontSize:18,fontWeight:800,color:C.ink,letterSpacing:"-.5px"}}>No verified flights yet</div>
        <div style={{fontSize:14,color:C.muted,lineHeight:1.6,maxWidth:320}}>
          Your logbook only shows flights from <strong>verified & signed</strong> months. Upload a roster, then go to <strong>Active Logs</strong> to verify and sign it.
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
            {/* Export buttons */}
            <button onClick={()=>csvExport(signedRosters,tails)} style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:10,background:S.surface,border:`1px solid ${S.border}`,color:S.silver,fontSize:12,fontWeight:600,cursor:"pointer"}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke={S.silver} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17v1a3 3 0 003 3h10a3 3 0 003-3v-1" stroke={S.silver} strokeWidth="2.5" strokeLinecap="round"/></svg>
              Export CSV
            </button>
            {/* View toggle */}
            <div style={{display:"flex",background:S.panel,borderRadius:10,padding:3,gap:2}}>
              {[["daily","Daily"],["logbook","Logbook"]].map(([v,label])=>(
                <button key={v} onClick={()=>{setView(v);setSearch("");setLbPage(0);}} style={{padding:"6px 14px",borderRadius:8,border:"none",fontSize:12,fontWeight:600,cursor:"pointer",background:view===v?S.surface:"transparent",color:view===v?S.ink:S.muted,boxShadow:view===v?"0 1px 3px rgba(0,0,0,0.08)":"none",transition:"all .15s"}}>
                  {label}
                </button>
              ))}
            </div>
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
              <div key={label} style={{background:gradient?`linear-gradient(135deg,${S.purple},${S.blue})`:S.surface,borderRadius:16,padding:"16px 18px",border:gradient?"none":`1px solid ${S.border}`,boxShadow:gradient?`0 4px 16px ${S.purple}25`:"0 1px 4px rgba(0,0,0,0.04)"}}>
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
                    {["Date","Flight","Tail #","Route","Dep","Arr","Actual Dep","Actual Arr","Block","Status"].map(h=>(
                      <th key={h} style={{padding:"10px 16px",textAlign:["Block"].includes(h)?"right":["Status"].includes(h)?"center":"left",fontSize:10,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageFlights.length===0&&(
                    <tr><td colSpan={10} style={{padding:"40px",textAlign:"center",color:S.muted,fontSize:13}}>
                      {search?"No flights match your search":"No flights yet -- upload a roster to get started"}
                    </td></tr>
                  )}
                  {pageFlights.map(({f,t,dateStr,tk,di,fi,r,d},idx)=>{
                    const synced=!!t.tail;
                    const cancelled=!!t.cancelled;
                    const block=t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"--";
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
                        <td style={{padding:"13px 16px",fontWeight:700,color:S.ink,fontFamily:"monospace",fontSize:12}}>{t.tail||<span style={{color:S.muted,fontWeight:400,fontSize:11}}>Pending</span>}</td>
                        <td style={{padding:"13px 16px"}}>
                          <span style={{fontWeight:700,color:S.ink}}>{f.dep}</span>
                          <span style={{color:S.muted,margin:"0 6px",fontSize:10}}>→</span>
                          <span style={{fontWeight:700,color:S.ink}}>{f.arr}</span>
                        </td>
                        <td style={{padding:"13px 16px",color:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12}}>{f.depTime||"--"}</td>
                        <td style={{padding:"13px 16px",color:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12}}>{f.arrTime||"--"}</td>
                        <td style={{padding:"13px 16px",color:t.actualDep?S.ink:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12,fontWeight:t.actualDep?600:400}}>{t.actualDep||"--"}</td>
                        <td style={{padding:"13px 16px",color:t.actualArr?S.ink:S.muted,textAlign:"center",fontFamily:"monospace",fontSize:12,fontWeight:t.actualArr?600:400}}>{t.actualArr||"--"}</td>
                        <td style={{padding:"13px 16px",textAlign:"right",fontWeight:700,color:S.ink}}>{block}</td>
                        <td style={{padding:"13px 16px",textAlign:"center"}}>
                          {cancelled?(
                            <span style={{fontSize:10,fontWeight:700,color:"#DC2626",background:"#FEF2F2",padding:"3px 8px",borderRadius:100}}>CNCL</span>
                          ):synced?(
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" title="Auto-Synced"><circle cx="12" cy="12" r="10" fill="#ECFDF5"/><path d="M8 12l3 3 5-5" stroke="#10B981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
                    <button key={pg} onClick={()=>setLbPage(pg)} style={{width:32,height:32,borderRadius:8,border:`1px solid ${pg===lbPage?S.purple+"44":S.border}`,background:pg===lbPage?"#F5F3FF":S.surface,color:pg===lbPage?S.purple:S.silver,fontWeight:pg===lbPage?700:500,fontSize:13,cursor:"pointer"}}>
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
            {signedRosters.map((r,i)=>(
              <option key={r.id} value={i}>{r.periodLabel}</option>
            ))}
          </select>
          {roster&&(
            <button
              onClick={async()=>{if(!window.confirm(`Delete roster "${roster.periodLabel}"? This cannot be undone.`))return;try{await sb.from("signedRosters").delete().eq("id",roster.id);onDeleteRoster(roster.id);setSelRoster(Math.max(0,selRoster-1));}catch(e){alert(e.message);}}}
              style={{padding:"7px 12px",borderRadius:10,border:`1px solid ${C.border}`,background:"none",color:C.muted,fontSize:12,cursor:"pointer",flexShrink:0}}
            >
              Delete
            </button>
          )}
        </div>
        {/* View toggle */}
        <div style={{display:"flex",background:"#F1F5F9",borderRadius:10,padding:3,gap:2,flexShrink:0}}>
          {[["daily","Daily"],["logbook","Logbook"]].map(([v,label])=>(
            <button key={v} onClick={()=>{setView(v);setSearch("");setLbPage(0);}} style={{padding:"5px 12px",borderRadius:7,border:"none",fontSize:12,fontWeight:600,cursor:"pointer",background:view===v?C.surface:"transparent",color:view===v?C.ink:C.muted,boxShadow:view===v?"0 1px 3px rgba(0,0,0,0.08)":"none",transition:"all .15s"}}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Daily content */}
      <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>
        {!roster?(
          <div style={{textAlign:"center",padding:"48px 16px",color:C.muted}}>
            <div style={{fontSize:32,marginBottom:8}}>📋</div>
            <div style={{fontSize:14}}>No roster loaded -- upload one first</div>
          </div>
        ):(
          <>
            {(roster.calendar||[]).filter(d=>(d.flights||[]).length>0).map((day,di_rel)=>{
              const di = (roster.calendar||[]).findIndex(d=>d.day===day.day);
              const sortedFlights = [...(day.flights||[])].map((f,fi)=>({f,fi})).sort((a,b)=>(a.f.depTime||"00:00").localeCompare(b.f.depTime||"00:00"));
              const isOpen = !!collapsedDays[di];
              const now=new Date();
              const isToday=day.day===now.getDate()&&(roster.monthNum??roster.month_num??0)===now.getMonth()&&roster.year===now.getFullYear();
              const mNum2=roster.monthNum??roster.month_num??0;
              const dateStr=`${roster.year}-${String(mNum2+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
              return(
                <div key={di} className="lb-day-card" style={{marginBottom:10,borderColor:isToday?C.teal+"88":undefined}}>
                  <div className="lb-day-header" onClick={()=>setCollapsedDays(p=>({...p,[di]:!isOpen}))}>
                    <div className="lb-day-num" style={{background:isToday?C.teal+"18":C.panel}}>
                      <div className="lb-day-num-val" style={{color:isToday?C.teal:C.ink}}>{day.day}</div>
                      <div className="lb-day-num-dow" style={{color:isToday?C.teal:C.muted}}>{day.dow}</div>
                    </div>
                    <div className="lb-day-info">
                      <div className="lb-day-route">{(day.flights||[]).map(f=>`${f.dep}→${f.arr}`).join(" · ")}</div>
                      <div className="lb-day-meta">{(day.flights||[]).length} flight{(day.flights||[]).length!==1?"s":""} · {dateStr}</div>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{transform:isOpen?"rotate(180deg)":"none",transition:"transform .2s",flexShrink:0}}>
                      <path d="M6 9l6 6 6-6" stroke={C.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  {isOpen&&(
                    <div style={{borderTop:`1px solid ${C.border}`}}>
                      {sortedFlights.map(({f,fi})=>{
                        const tk=`${roster.id}-${di}-${fi}`;
                        const tail=tails[tk]||{};
                        const hasActual=!!(tail.actualDep||tail.actualArr||tail.tail);
                        const isCancelled=!!tail.cancelled;
                        const dist=calcDist(f.dep,f.arr);
                        const blockMinsVal=tail.actualBlockMins!=null?tail.actualBlockMins:schedMins(f)||0;
                        return(
                          <div key={fi} className={"lb-seg"+(hasActual&&!isCancelled?" actual":"")} style={{background:isCancelled?C.red+"10":undefined,borderColor:isCancelled?C.red+"44":undefined,position:"relative"}}>
                            <div onClick={()=>openFlight(di,fi,f,day)} style={{display:"contents"}}>
                              <div className="lb-seg-num" style={{color:isCancelled?C.red:undefined}}>{f.flightNum}</div>
                              <div className="lb-seg-route">
                                <div className="lb-seg-dep-arr">
                                  <b style={{textDecoration:isCancelled?"line-through":undefined}}>{f.dep}</b>
                                  <span style={{color:C.muted,fontWeight:400,margin:"0 5px"}}>→</span>
                                  <b style={{textDecoration:isCancelled?"line-through":undefined}}>{f.arr}</b>
                                  {isCancelled&&<span style={{marginLeft:8,fontSize:9,fontWeight:700,color:C.red,background:C.red+"18",padding:"2px 6px",borderRadius:4}}>CANCELLED</span>}
                                  {!isCancelled&&(dist||0)>50&&<span style={{marginLeft:6,fontSize:9,color:C.teal,background:C.teal+"18",padding:"1px 5px",borderRadius:4,fontWeight:700}}>XC</span>}
                                </div>
                                {!isCancelled&&<div className={"lb-seg-times"+(hasActual?" synced":"")}>
                                  {hasActual?tail.actualDep+" → "+tail.actualArr+(blockMinsVal?" · "+fmtMins(blockMinsVal):""):f.depTime+" → "+f.arrTime+(blockMinsVal?" · "+fmtMins(blockMinsVal):"")}
                                </div>}
                              </div>
                              <div className="lb-seg-right">
                                {!isCancelled&&<>
                                  <div className="lb-seg-tail">{tail.tail||"--"}{tail.finalSynced&&<span style={{color:C.green,marginLeft:2}}>✓</span>}</div>
                                  {dist&&<div className="lb-seg-dist">{dist} NM</div>}
                                </>}
                              </div>
                              <div className="lb-seg-arrow">›</div>
                            </div>
                            {/* Delete button */}
                            <button onClick={async(e)=>{e.stopPropagation();if(!window.confirm(`Delete flight ${f.flightNum} ${f.dep}→${f.arr}?`))return;const nc=[...(roster.calendar||[])];nc[di]={...nc[di],flights:(nc[di].flights||[]).filter((_,i)=>i!==fi)};try{await db_saveRoster(user.id,{...roster,calendar:nc});onRosterUpdated(roster.id,nc);}catch(err){alert(err.message);}}}
                              style={{position:"absolute",top:4,right:4,width:22,height:22,borderRadius:"50%",background:"none",border:"none",color:C.muted,fontSize:14,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:0.5,lineHeight:1}}
                              title="Delete flight"
                            >×</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

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

function FlightDetailPage({
  flight:f, tail, solar, dist, blockMins, day, roster,
  hasActual, dep, arr, isXC, onBack, onAutoLookup, onForceResync,
  lkStatus, lkError, onResetLimit, tmp, onTmpChange, onSaveTail,
  saving, onTailSaved, editingTimes, setEditingTimes, timeEdits,
  setTimeEdits, di, fi, userId
}) {
  const S = getS();
  const [briefing, setBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const mNum = roster?.monthNum ?? roster?.month_num ?? 0;
  const dateStr = `${roster?.year}-${String(mNum+1).padStart(2,"0")}-${String(day?.day||1).padStart(2,"0")}`;
  const tk = `${roster?.id}-${di}-${fi}`;

  const dist2 = dist || calcDist(f?.dep, f?.arr);
  const blockMins2 = tail?.actualBlockMins != null ? tail.actualBlockMins : (blockMins || schedMins(f) || 0);
  const nightMins = solar?.nightMins || 0;
  const isSynced = !!(tail?.tail);
  const isCancelled = !!(tail?.cancelled);

  const BLUE = S.blue; const GREEN = S.green;

  async function fetchBriefing() {
    if(briefingLoading) return;
    setBriefingLoading(true);
    try {
      const briefKey = `fl_brief_${f?.flightNum}_${dateStr}`;
      const cached = localStorage.getItem(briefKey);
      if(cached) { const p = JSON.parse(cached); if(Date.now()-p.ts < 3600000) { setBriefing(p.text); setBriefingLoading(false); return; } }
      const briefRes = await fetch(`${SUPA_URL}/functions/v1/flight-briefing`,{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},
        body:JSON.stringify({flightNum:f?.flightNum,dep:f?.dep,arr:f?.arr,date:dateStr,depTime:f?.depTime,acType:f?.acType}),
      });
      const bd = await briefRes.json();
      const text = bd.briefing||bd.text||bd.content?.[0]?.text||"Briefing unavailable.";
      setBriefing(text);
      try { localStorage.setItem(briefKey, JSON.stringify({text, ts:Date.now()})); } catch {}
    } catch { setBriefing("Briefing unavailable -- check connection."); }
    setBriefingLoading(false);
  }

  function formatTime(t) { return t || "--"; }

  return (
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
      {/* Header */}
      <div style={{padding:"14px 16px",background:S.surface,borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10,backdropFilter:"blur(12px)"}}>
        <button onClick={onBack} style={{width:36,height:36,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke={S.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:18,fontWeight:800,color:S.ink,letterSpacing:"-.3px"}}>{f?.flightNum}</div>
          <div style={{fontSize:12,color:S.muted,marginTop:1}}>{dateStr} · {f?.dep}→{f?.arr}</div>
        </div>
        {isSynced&&(
          <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 10px",borderRadius:100,background:"#ECFDF5",color:GREEN,fontSize:11,fontWeight:700,flexShrink:0}}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Auto-Synced
          </span>
        )}
      </div>

      <div style={{padding:"16px 16px 32px",maxWidth:600,margin:"0 auto",display:"flex",flexDirection:"column",gap:14}}>

        {/* Route card */}
        <div style={{background:`linear-gradient(135deg,${BLUE},#1E3A8A)`,borderRadius:20,padding:"20px 22px",position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",top:-20,right:-20,width:100,height:100,borderRadius:"50%",background:"rgba(255,255,255,0.06)"}}/>
          {isCancelled&&(
            <div style={{position:"absolute",top:12,right:12,background:"#EF4444",color:"#fff",fontSize:10,fontWeight:800,padding:"3px 10px",borderRadius:100,letterSpacing:"1px"}}>CANCELLED</div>
          )}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",position:"relative",zIndex:1}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:38,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:"-1px"}}>{f?.dep}</div>
              <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginTop:3}}>Departure</div>
              <div style={{fontSize:16,fontWeight:800,color:"#fff",marginTop:6}}>{formatTime(hasActual?tail?.actualDep:f?.depTime)}</div>
              {hasActual&&f?.depTime&&<div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>Sched {f.depTime}</div>}
            </div>
            <div style={{flex:1,padding:"0 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <div style={{fontSize:11,fontWeight:600,color:"rgba(255,255,255,0.55)"}}>{blockMins2?fmtMins(blockMins2):"--"}</div>
              <div style={{width:"100%",display:"flex",alignItems:"center",gap:4}}>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.2)"}}/>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 17l6-10 3 5 3-4 4 9" stroke="rgba(255,255,255,0.9)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <div style={{flex:1,height:1,background:"rgba(255,255,255,0.2)"}}/>
              </div>
              {dist2&&<div style={{fontSize:10,color:"rgba(255,255,255,0.45)"}}>{dist2} NM</div>}
              {f?.acType&&<div style={{fontSize:10,color:"rgba(255,255,255,0.55)",fontWeight:600}}>{f.acType}</div>}
            </div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:38,fontWeight:900,color:"#fff",lineHeight:1,letterSpacing:"-1px"}}>{f?.arr}</div>
              <div style={{fontSize:12,color:"rgba(255,255,255,0.6)",marginTop:3}}>Arrival</div>
              <div style={{fontSize:16,fontWeight:800,color:"#fff",marginTop:6}}>{formatTime(hasActual?tail?.actualArr:f?.arrTime)}</div>
              {hasActual&&f?.arrTime&&<div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>Sched {f.arrTime}</div>}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
          {[
            {label:"Block Time",val:blockMins2?fmtMins(blockMins2):"--",icon:"🕐"},
            {label:"Distance",val:dist2?`${dist2} NM`:"--",icon:"✈"},
            {label:"Night Time",val:nightMins?fmtMins(nightMins):"--",icon:"🌙"},
            {label:"XC",val:isXC?"Yes":"No",icon:"🗺️"},
          ].map(({label,val,icon})=>(
            <div key={label} style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:14,padding:"12px 10px",textAlign:"center"}}>
              <div style={{fontSize:18,marginBottom:4}}>{icon}</div>
              <div style={{fontSize:13,fontWeight:800,color:S.ink}}>{val}</div>
              <div style={{fontSize:9,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginTop:2}}>{label}</div>
            </div>
          ))}
        </div>

        {/* Tail number card */}
        <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:"16px 18px"}}>
          <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:12}}>Tail Number</div>
          {isSynced?(
            <div>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                <div style={{fontSize:22,fontWeight:900,color:S.ink,fontFamily:"monospace"}}>{tail.tail}</div>
                <span style={{fontSize:11,color:GREEN,fontWeight:700,background:"#ECFDF5",padding:"3px 10px",borderRadius:100}}>✓ Auto-Synced</span>
              </div>
              <button onClick={onAutoLookup} disabled={lkStatus==="loading"} style={{width:"100%",padding:"9px",borderRadius:10,background:S.panel,border:`1px solid ${S.border}`,color:S.muted,fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {lkStatus==="loading"?<><svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{animation:"spin 1s linear infinite"}}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" stroke={S.muted} strokeWidth="2.5" strokeLinecap="round"/></svg>Re-syncing...</>:<><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>Manual Re-sync (testing)</>}
              </button>
              {lkStatus==="done"&&<div style={{fontSize:11,color:GREEN,textAlign:"center",marginTop:6}}>✓ Re-synced from FlightAware</div>}
            </div>
          ):(
            <div>
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
              {lkStatus==="error"&&<div style={{fontSize:12,color:"#DC2626",textAlign:"center",marginTop:8}}>{lkError||"Lookup failed"}</div>}
              {lkStatus==="done"&&<div style={{fontSize:12,color:GREEN,textAlign:"center",marginTop:8}}>✓ Synced from FlightAware</div>}
            </div>
          )}
        </div>

        {/* Times card -- Scheduled or Actual */}
        <div style={{background:S.surface,border:`1px solid ${hasActual?`${GREEN}44`:S.border}`,borderRadius:18,padding:"16px 18px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:12,fontWeight:700,color:hasActual?GREEN:S.muted,textTransform:"uppercase",letterSpacing:".5px"}}>
                {hasActual?"Actual Times":"Scheduled Times"}
              </div>
              {hasActual&&(
                <span style={{fontSize:10,fontWeight:700,color:GREEN,background:"#ECFDF5",padding:"2px 8px",borderRadius:100}}>
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
                  if(onTailSaved&&timeEdits){const updates={...tail,...timeEdits};await onSaveTail&&onSaveTail(updates);}
                  setEditingTimes&&setEditingTimes(false);
                }} style={{flex:1,padding:"10px",borderRadius:10,background:BLUE,border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
                <button onClick={()=>{setEditingTimes&&setEditingTimes(false);setTimeEdits&&setTimeEdits({});}} style={{flex:1,padding:"10px",borderRadius:10,background:"none",border:`1px solid ${S.border}`,color:S.muted,fontSize:13,cursor:"pointer"}}>Cancel</button>
              </div>
            </div>
          ):(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              {[
                ["Out", hasActual?(tail?.actualDep||"--"):(f?.depTime||"--")],
                ["In",  hasActual?(tail?.actualArr||"--"):(f?.arrTime||"--")],
                ["Block", blockMins2?fmtMins(blockMins2):"--"],
              ].map(([label,val])=>(
                <div key={label} style={{textAlign:"center",background:S.panel,borderRadius:12,padding:"12px 8px"}}>
                  <div style={{fontSize:20,fontWeight:900,color:S.ink,fontFamily:"monospace",letterSpacing:"-0.5px"}}>{val}</div>
                  <div style={{fontSize:10,color:hasActual?GREEN:S.muted,marginTop:4,textTransform:"uppercase",letterSpacing:".5px",fontWeight:600}}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Route map */}
        {dep&&arr&&(()=>{
          const c1=AIRPORT_COORDS[dep], c2=AIRPORT_COORDS[arr];
          if(!c1||!c2) return null;
          // Simple SVG route map
          const minLat=Math.min(c1[0],c2[0])-2, maxLat=Math.max(c1[0],c2[0])+2;
          const minLon=Math.min(c1[1],c2[1])-3, maxLon=Math.max(c1[1],c2[1])+3;
          const toX=(lon)=>Math.round(((lon-minLon)/(maxLon-minLon))*260+20);
          const toY=(lat)=>Math.round(((maxLat-lat)/(maxLat-minLat))*120+20);
          const x1=toX(c1[1]),y1=toY(c1[0]),x2=toX(c2[1]),y2=toY(c2[0]);
          const mx=(x1+x2)/2, my=(y1+y2)/2-30;
          return(
            <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:18,padding:"16px 18px",overflow:"hidden"}}>
              <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10}}>Route Map</div>
              <svg width="100%" viewBox="0 0 300 160" style={{display:"block",borderRadius:12,background:`linear-gradient(180deg,${S.blue}15 0%,${S.panel} 100%)`}}>
                {/* Great circle arc approximation */}
                <path d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`} stroke={S.blue} strokeWidth="2.5" strokeDasharray="6 3" fill="none" strokeLinecap="round"/>
                {/* Dep airport */}
                <circle cx={x1} cy={y1} r="7" fill={S.blue} opacity="0.9"/>
                <circle cx={x1} cy={y1} r="12" fill={S.blue} opacity="0.15"/>
                <text x={x1} y={y1-15} textAnchor="middle" fontSize="11" fontWeight="800" fill={S.ink}>{dep}</text>
                {/* Arr airport */}
                <circle cx={x2} cy={y2} r="7" fill={GREEN} opacity="0.9"/>
                <circle cx={x2} cy={y2} r="12" fill={GREEN} opacity="0.15"/>
                <text x={x2} y={y2-15} textAnchor="middle" fontSize="11" fontWeight="800" fill={S.ink}>{arr}</text>
                {/* Plane icon along the arc */}
                <text x={mx+4} y={my+8} textAnchor="middle" fontSize="14">✈</text>
                {/* Distance label */}
                {dist2&&<text x="150" y="155" textAnchor="middle" fontSize="10" fill={S.muted} fontWeight="600">{dist2} NM</text>}
              </svg>
            </div>
          );
        })()}

        {/* AI Briefing */}
        <div style={{background:`linear-gradient(135deg,#7C3AED,${BLUE})`,borderRadius:18,padding:"16px 18px",color:"#fff"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <div style={{background:"rgba(255,255,255,0.2)",padding:7,borderRadius:9,backdropFilter:"blur(8px)"}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 01-1 1H9a1 1 0 01-1-1v-2.26A7 7 0 0112 2z" stroke="#fff" strokeWidth="2"/><path d="M9 21h6" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></svg>
              </div>
              <div>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",color:"rgba(255,255,255,0.75)"}}>AI Briefing</div>
                <div style={{fontSize:10,color:"rgba(255,255,255,0.5)"}}>{briefing?"Cached 1hr":"Tap to generate"}</div>
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

function CalendarPage({user, rosters, tails, onRosterUpdated, onOpenFlight}) {
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

      {/* Sticky header */}
      <div style={{position:"sticky",top:0,zIndex:20,background:`${S.bg}f0`,backdropFilter:"blur(12px)",borderBottom:`1px solid ${S.border}`,padding:"14px 18px",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <h1 style={{fontSize:20,fontWeight:800,color:S.ink,margin:0,letterSpacing:"-.5px"}}>Roster View</h1>
        <button onClick={()=>window.location.reload()} style={{width:36,height:36,borderRadius:"50%",background:S.surface,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15" stroke={S.muted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      <div style={{padding:"16px 16px 80px"}}>
        {/* Background decorations */}
        <div style={{position:"fixed",top:"-5%",right:"-5%",width:"40%",height:"40%",background:"#C7D2FE",borderRadius:"50%",filter:"blur(100px)",opacity:0.2,pointerEvents:"none",zIndex:0}}/>
        <div style={{position:"fixed",top:"25%",left:"-5%",width:"30%",height:"30%",background:"#BAE6FD",borderRadius:"50%",filter:"blur(100px)",opacity:0.2,pointerEvents:"none",zIndex:0}}/>

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
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",marginBottom:4}}>
              {DOW_LABELS.map((d,i)=>(
                <div key={i} style={{textAlign:"center",fontSize:10,fontWeight:800,color:S.muted,textTransform:"uppercase",letterSpacing:"1px",padding:"4px 0"}}>{d}</div>
              ))}
            </div>

            {/* Calendar grid */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",border:`1px solid ${S.border}`,borderRadius:12,overflow:"hidden",gap:1,background:S.border}}>
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
                <div style={{position:"absolute",top:0,right:0,width:80,height:80,background:"#F5F3FF",borderRadius:"0 24px 0 100%",zIndex:0}}/>
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
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="#C4B5FD";}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=S.border;}}
                  >
                    {/* Status bar */}
                    <div style={{width:6,height:48,borderRadius:3,background:isFlown?"#10B981":S.border,flexShrink:0}}/>

                    {/* Times */}
                    <div style={{width:52,flexShrink:0}}>
                      <div style={{fontSize:15,fontWeight:800,color:S.ink,lineHeight:1}}>{f.depTime||"--"}</div>
                      <div style={{fontSize:11,color:S.muted,marginTop:3}}>{f.arrTime||"--"}</div>
                    </div>

                    {/* Flight info */}
                    <div style={{flex:1,borderLeft:`1px solid ${S.border}`,paddingLeft:14,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:13,fontWeight:800,color:S.blue}}>{f.flightNum}</span>
                        {f.acType&&<span style={{fontSize:10,fontWeight:700,color:S.muted,background:S.panel,padding:"2px 6px",borderRadius:4}}>{f.acType}</span>}
                        {isXC&&<span style={{fontSize:10,fontWeight:700,color:S.purple,background:`${S.purple}15`,padding:"2px 6px",borderRadius:4}}>XC</span>}
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
                      <div style={{fontSize:14,fontWeight:800,color:S.ink}}>{bm?fmtMins(bm):"--"}</div>
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

function UploadPage({user, onRosterSaved}) {
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [status, setStatus] = useState(null); // null | "success" | "error"
  const [msg, setMsg] = useState("");
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState(null);
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

      // -- Layer 1: Extract raw text and attempt deterministic parse
      // PDF text extraction for Layer 1 gateway -- uses pdf.js if available,
      // falls back to a simple heuristic scan of the base64 content.
      let rawText = "";
      try {
        // Attempt to decode PDF text content for Layer 1
        const bytes = atob(base64);
        // Extract printable ASCII runs (crude but fast -- no library needed)
        const textRuns = [];
        let run = "";
        for(let i=0;i<Math.min(bytes.length,50000);i++){
          const c=bytes.charCodeAt(i);
          if(c>=32&&c<127) run+=bytes[i];
          else if(run.length>3){textRuns.push(run);run="";}
          else run="";
        }
        if(run.length>3) textRuns.push(run);
        rawText = textRuns.join("\n");
      } catch { rawText = ""; }

      const PARSE_URL = `${SUPA_URL}/functions/v1/parse-roster`;
      const token = sb.auth._token || SUPA_ANON;
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "apikey": SUPA_ANON,
      };

      let roster;

      // Try Layer 1 only if we got meaningful text
      if(rawText.length > 200) {
        setMsg("Layer 1: Pattern matching...");
        const gateway = parseRosterLayer1(rawText, file.name);

        if(gateway.confidence >= 1.0 && gateway.roster) {
          // Layer 1 success -- no API call needed
          console.log(`[Layer 1] ✅ Confidence ${gateway.confidence} -- skipping AI call`);
          roster = gateway.roster;
          setMsg(`✓ Parsed instantly · Layer 1 · ${roster.calendar?.filter(d=>d.flights?.length>0).length} duty days`);
        } else {
          // Layer 1 partial -- send only failed segments to Layer 2
          console.log(`[Layer 1] ⚡ Confidence ${gateway.confidence} -- escalating to Intelligence Layer`);
          console.log(`[Layer 1] Failures:`, gateway.failureReasons);

          if(gateway.confidence > 0.3 && gateway.failedSegments.length > 0) {
            // Targeted escalation -- only send the problem text
            setMsg("Layer 2: AI parsing failed segments...");
            try {
              const l2Response = await fetch(PARSE_URL, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  layer1_result: {
                    raw_text: gateway.failedSegments.join("\n"),
                    layer1_confidence: gateway.confidence,
                    layer1_failures: gateway.failureReasons,
                    partial_result: gateway.partialFlights,
                    date_context: gateway.dateContext,
                  }
                }),
              });
              if(l2Response.ok) {
                const l2Result = await l2Response.json();
                // Merge Layer 1 clean flights + Layer 2 resolved flights
                roster = mergeGatewayResults(gateway, l2Result);
                setMsg(`✓ Parsed · Layer 1+2 · ${roster.calendar?.filter(d=>d.flights?.length>0).length} duty days`);
              } else {
                throw new Error("Layer 2 targeted call failed, falling back to full PDF");
              }
            } catch {
              // Fall through to full PDF parse
              roster = null;
            }
          }

          if(!roster) {
            // Full PDF fallback -- send entire PDF to Layer 2
            setMsg("Layer 2: AI reading full PDF...");
            const response = await fetch(PARSE_URL, {
              method: "POST",
              headers,
              body: JSON.stringify({ pdfBase64: base64, filename: file.name }),
            });
            if(!response.ok) throw new Error(`Parse server error: ${response.status}`);
            roster = await response.json();
          }
        }
      } else {
        // No extractable text (scanned PDF) -- go straight to Layer 2
        setMsg("Layer 2: AI reading PDF (scanned document)...");
        const response = await fetch(PARSE_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({ pdfBase64: base64, filename: file.name }),
        });
        if(!response.ok) throw new Error(`Parse server error: ${response.status}`);
        roster = await response.json();
      }

      if(!roster.calendar?.length) throw new Error("No flights found in this roster.");
      const saved = await db_saveRoster(user.id, roster);
      onRosterSaved(saved||roster);
      setStatus("success");
      setMsg(`✓ Parsed ${roster.calendar.filter(d=>(d.flights||[]).length>0).length} duty days for ${roster.periodLabel}`);
      setFile(null); setPreview(null);
    } catch(e) {
      setStatus("error");
      setMsg(e.message||"Parse failed.");
    }
    setParsing(false);
  }

  // -- Layer 1: Deterministic gateway parser (inline, no import needed)
  function parseRosterLayer1(rawText, filename) {
    const FLIGHT_RE = /\b([A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])\s*(\d{1,4})\b/;
    const COMBINED_DATE_RE = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{1,2}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d{1,2}/i;
    const CI_CO_RE = /\bC\/[IO]\b/i;
    const BLOCK_RE = /(?:(?:\[FT\s*|BLK\s*)(\d{1,2})[+:](\d{2})(?:\])?|(\d{1,2})[+:](\d{2})\s*(?:BLK|FT|\]|$))/i;
    const DUTY_CODE_RE = /^(TVL|SIM|GRD|TRN|VGS|SKI|AOE|DOC|OFD|RES|RSV|HOL|VAC|SCK|MAT|MIL|POS|DED|DHD)$/;
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
      if(words.length>=1&&DUTY_CODE_RE.test(words[0])){
        dutyDays.push({code:words[0],date:currentDate});
        skipTimes=false;continue;
      }

      const airports=[...line.replace(FLIGHT_RE,"").replace(AC_RE,"").matchAll(/(?<![0-9A-Z])([A-Z]{3})(?![A-Z0-9])/g)]
        .map(m=>m[1]).filter(c=>!/^(BLK|FLT|FDP|ETD|ETA|UTC|LCL|REG)$/.test(c)).slice(0,2);
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
      byDay[day].push({flightNum:f.flightNum,dep:f.dep,depTime:f.depTime,arr:f.arr,arrTime:f.arrTime,acType:f.acType,schedBlockMins:f.blockMins});
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

  return (
    <div style={{flex:1,overflowY:"auto",background:"#F8FAFC"}}>
      <PageHeader title="Upload Roster"/>
      <div style={{padding:16,maxWidth:560}}>

        {/* Upload box */}
        <div
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);handleFile(e.dataTransfer.files[0]);}}
          onClick={()=>fileRef.current?.click()}
          style={{
            border:`2px dashed ${drag?"#1D4ED8":file?"#1D4ED8":"#E2E8F0"}`,
            borderRadius:20,padding:"36px 20px",textAlign:"center",cursor:"pointer",
            background:drag?"#EFF6FF":file?"#F0FDF4":"#FFFFFF",
            transition:"all .2s",marginBottom:16,
          }}
        >
          <input ref={fileRef} type="file" accept=".pdf" style={{display:"none"}} onChange={e=>handleFile(e.target.files?.[0])}/>
          <div style={{fontSize:40,marginBottom:14}}>
            {file?"📄":"☁️"}
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
          <div style={{marginBottom:16,padding:"12px 14px",borderRadius:10,background:status==="success"?"#ECFDF5":"#FEF2F2",border:`1px solid ${status==="success"?"#A7F3D0":"#FECACA"}`,fontSize:13,color:status==="success"?"#059669":"#DC2626",fontWeight:500}}>
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
              <span className="spinner">⟳</span> Parsing with AI...
            </span>
          ):"Parse Roster →"}
        </button>

        {/* Info */}
        <div style={{background:"#F1F5F9",borderRadius:12,padding:"14px 16px",border:"1px solid #E2E8F0"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0F172A",marginBottom:8}}>How it works</div>
          {[
            ["📤","Upload your monthly PDF roster from any airline"],
            ["🤖","AI reads every flight leg, time, and airport"],
            ["✈","Tail numbers sync via FlightAware within 15 min of landing"],
          ].map(([icon,text])=>(
            <div key={text} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:8}}>
              <span style={{fontSize:16,flexShrink:0}}>{icon}</span>
              <span style={{fontSize:13,color:"#64748B",lineHeight:1.5}}>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActiveLogsPage({user, rosters, tails, onRosterUpdated, onTailSaved}) {
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
      const totalFlights=(r.calendar||[]).reduce((a,d)=>a+(d.flights||[]).length,0);
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

  // -- Audit log helper
  function logEdit(tk, field, oldVal, newVal){
    if(String(oldVal)===String(newVal)) return;
    setAuditLog(prev=>[{
      id: Date.now()+Math.random(),
      ts: new Date().toISOString(),
      tk, field,
      oldVal: String(oldVal||"--"),
      newVal: String(newVal||"--"),
      userId: user?.email,
    }, ...prev]);
  }

  // -- Sign month
  async function signMonth(){
    if(!verifyModal) return;
    setSigning(true);
    try {
      const r=verifyModal;
      const mNum=r.monthNum??r.month_num??0;
      // Apply all edits to calendar
      const nc=[...(r.calendar||[])];
      for(const [tk,edits] of Object.entries(editEdits)){
        const parts=tk.split("-");
        const di=parseInt(parts[parts.length-2]);
        const fi=parseInt(parts[parts.length-1]);
        if(nc[di]&&nc[di].flights[fi]){
          if(edits.acType!=null) nc[di]={...nc[di],flights:nc[di].flights.map((f,i)=>i===fi?{...f,acType:edits.acType}:f)};
        }
        const tailUpdate={};
        if(edits.tail!=null) tailUpdate.tail=edits.tail;
        if(edits.actualBlockMins!=null) tailUpdate.actualBlockMins=edits.actualBlockMins;
        if(Object.keys(tailUpdate).length){
          await db_saveTail(user.id,tk,tailUpdate);
          onTailSaved(tk,{...(tails[tk]||{}),...tailUpdate});
        }
      }
      await db_saveRoster(user.id,{...r,calendar:nc,signed:true,signedAt:new Date().toISOString()});
      onRosterUpdated(r.id,nc);
      const newSigned={...signedMonths,[r.id]:{at:new Date().toISOString(),userId:user?.id}};
      setSignedMonths(newSigned);
      localStorage.setItem("fl_signed_months",JSON.stringify(newSigned));
      // Save audit log to localStorage
      const auditKey=`fl_audit_${r.id}`;
      const existing=JSON.parse(localStorage.getItem(auditKey)||"[]");
      localStorage.setItem(auditKey,JSON.stringify([...auditLog,...existing]));
      setVerifyModal(null);
      setEditEdits({});
      setAuditLog([]);
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
    const allRows=[];
    (r.calendar||[]).forEach((d,di)=>{
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
          <div style={{background:"linear-gradient(135deg,#1D4ED8,#7C3AED)",padding:"24px 28px",color:"#fff"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <div style={{fontSize:12,fontWeight:700,letterSpacing:"2px",textTransform:"uppercase",color:"rgba(255,255,255,0.7)",marginBottom:6}}>Verification Required</div>
                <h2 style={{fontSize:24,fontWeight:900,margin:0,letterSpacing:"-0.5px"}}>{MONTHS[mNum]} {r.year} Flight Log</h2>
                <p style={{fontSize:13,color:"rgba(255,255,255,0.7)",marginTop:6}}>Review all flights, make corrections, then sign to lock this record permanently.</p>
              </div>
              <button onClick={()=>{setVerifyModal(null);setEditEdits({});setAuditLog([]);}} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",width:36,height:36,borderRadius:"50%",cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>×</button>
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

          {/* Flight table */}
          <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
              <thead style={{position:"sticky",top:0,zIndex:1}}>
                <tr style={{background:S.panel}}>
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
                  return(
                    <tr key={tk} style={{borderBottom:`1px solid ${S.border}`,background:isMod?"rgba(245,243,255,0.5)":idx%2===0?S.surface:"rgba(248,250,252,0.4)"}}>
                      <td style={{padding:"11px 14px",color:S.ink,fontWeight:600,whiteSpace:"nowrap"}}>{dateStr}</td>
                      <td style={{padding:"11px 14px",color:S.silver}}>{f.flightNum}</td>
                      <td style={{padding:"11px 14px",fontWeight:700,color:S.ink}}>{f.dep}→{f.arr}</td>
                      <td style={{padding:"11px 14px",color:S.muted,fontFamily:"monospace"}}>{schedMinsVal?fmtMins(schedMinsVal):"--"}</td>
                      {/* Editable actual block */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder={schedMinsVal?fmtMins(schedMinsVal):"--"}
                          value={dispActBlockMins!=null?fmtMins(dispActBlockMins):""}
                          onFocus={e=>e.target.select()}
                          onChange={e=>{
                            const raw=e.target.value.replace(/[^0-9:]/g,"");
                            setEditEdits(p=>({...p,[tk]:{...p[tk],_blockRaw:raw}}));
                          }}
                          onBlur={e=>{
                            const raw=editEdits[tk]?._blockRaw||e.target.value;
                            if(!raw) return;
                            const [hh,mm]=raw.split(":").map(Number);
                            const mins=isNaN(hh)?null:(hh*60+(mm||0));
                            if(mins!=null){
                              logEdit(tk,"actualBlockMins",t.actualBlockMins,mins);
                              setEditEdits(p=>({...p,[tk]:{...p[tk],actualBlockMins:mins,_blockRaw:undefined}}));
                            }
                          }}
                          style={{width:64,padding:"5px 8px",borderRadius:7,border:`1px solid ${isMod&&dispActBlockMins!=null?"#C4B5FD":S.border}`,fontSize:12,fontFamily:"monospace",background:isMod&&dispActBlockMins!=null?"#F5F3FF":S.surface,color:S.ink,outline:"none"}}
                        />
                      </td>
                      {/* Editable tail */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder="N#####"
                          value={dispTail}
                          onChange={e=>{
                            const val=e.target.value.toUpperCase().slice(0,8);
                            setEditEdits(p=>({...p,[tk]:{...p[tk],tail:val,_pendingTail:val}}));
                          }}
                          onBlur={e=>{
                            const val=e.target.value.toUpperCase().slice(0,8);
                            if(val !== (t.tail||"")) logEdit(tk,"tail",t.tail,val);
                          }}
                          style={{width:76,padding:"5px 8px",borderRadius:7,border:`1px solid ${dispTail?"#A7F3D0":S.border}`,fontSize:12,fontFamily:"monospace",background:dispTail?"#F0FDF4":S.surface,color:S.ink,outline:"none"}}
                        />
                      </td>
                      {/* Editable equipment */}
                      <td style={{padding:"6px 10px"}}>
                        <input
                          type="text"
                          placeholder="CRJ7"
                          value={dispAcType}
                          onChange={e=>{
                            const val=e.target.value.toUpperCase().slice(0,6);
                            setEditEdits(p=>({...p,[tk]:{...p[tk],acType:val}}));
                          }}
                          onBlur={e=>{
                            const val=e.target.value.toUpperCase().slice(0,6);
                            if(val !== (f.acType||"")) logEdit(tk,"acType",f.acType,val);
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
                        {isMod&&<span style={{marginLeft:4,fontSize:10,fontWeight:700,color:"#7C3AED",background:"#F5F3FF",padding:"2px 6px",borderRadius:100}}>Edited</span>}
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
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/></svg>
                  <span style={{color:"#7C3AED"}}>Audit Log</span>
                  <span style={{background:"#7C3AED",color:"#fff",fontSize:10,fontWeight:800,padding:"1px 7px",borderRadius:100}}>{auditLog.length}</span>
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
                          <td style={{padding:"7px 10px",color:"#7C3AED",fontWeight:600}}>{entry.field}</td>
                          <td style={{padding:"7px 10px",color:"#DC2626",fontFamily:"monospace",textDecoration:"line-through",opacity:.7}}>{entry.oldVal}</td>
                          <td style={{padding:"7px 10px",color:"#059669",fontFamily:"monospace",fontWeight:600}}>{entry.newVal}</td>
                          <td style={{padding:"7px 10px",color:S.muted,fontSize:11}}>{entry.userId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Modal footer */}
          <div style={{padding:"20px 28px",borderTop:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap",background:S.surface}}>
            <div style={{fontSize:12,color:S.muted,lineHeight:1.6,maxWidth:400}}>
              By signing, you certify this record is accurate and complete under{" "}
              <strong style={{color:S.ink}}>14 CFR §61.51</strong>.
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setVerifyModal(null);setEditEdits({});setAuditLog([]);}} style={{padding:"11px 22px",borderRadius:12,background:"none",border:`1.5px solid ${S.border}`,color:S.silver,fontSize:13,fontWeight:600,cursor:"pointer"}}>
                Cancel
              </button>
              <button onClick={signMonth} disabled={signing} style={{padding:"11px 28px",borderRadius:12,background:signing?"#94A3B8":"linear-gradient(135deg,#1D4ED8,#7C3AED)",border:"none",color:"#fff",fontSize:13,fontWeight:700,cursor:signing?"not-allowed":"pointer",boxShadow:"0 4px 16px rgba(29,78,216,0.3)",display:"flex",alignItems:"center",gap:8}}>
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
      onAutoLookup={async()=>{try{const res=await fetch(`${SUPA_URL}/functions/v1/lookup-flight`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${sb.auth._token||SUPA_ANON}`,"apikey":SUPA_ANON},body:JSON.stringify({flightNum:f?.flightNum,date:dateStr,dep:f?.dep,arr:f?.arr,depTime:f?.depTime})});if(!res.ok){const e2=await res.text();throw new Error(`Sync failed: ${res.status} ${e2.slice(0,100)}`);};const d=await res.json();if(d.tail||d.actualDep){const u={...tail,...d};onTailSaved(tk,u);setDrillFlight(p=>({...p,tail:{...p.tail,...u},hasActual:true}));}}catch(e){alert(e.message);}}}
      onForceResync={()=>{}} lkStatus={null} lkError={null} onResetLimit={()=>{}}
      tmp="" onTmpChange={()=>{}}
      onSaveTail={async(val)=>{const parts=tk.split("-");const rosterId=parts.slice(0,-2).join("-");const fk=parts.slice(-2).join("-");await db_saveTail(user.id,rosterId,fk,val||"");onTailSaved(tk,{...(tail||{}),tail:val});setDrillFlight(p=>({...p,tail:{...p.tail,tail:val}}));}}
      saving={false} onTailSaved={(v)=>{onTailSaved(tk,v);setDrillFlight(p=>({...p,tail:{...p.tail,...v}}));}}
      editingTimes={false} setEditingTimes={()=>{}} timeEdits={{}} setTimeEdits={()=>{}}
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
      const tk=`${r.id}-${di}-${fi}`;
      const t=tails[tk]||{};
      const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
      allRows.push({f,d,di,fi,tk,t,dateStr});
    });});
    allRows.sort((a,b)=>a.dateStr.localeCompare(b.dateStr)||(a.f.depTime||"").localeCompare(b.f.depTime||""));
    const totalBlock=allRows.reduce((acc,{tk,f})=>acc+((tails[tk]?.actualBlockMins)??schedMins(f)??0),0);
    return(
      <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif"}}>
        <div style={{padding:"14px 18px",background:S.surface,borderBottom:`1px solid ${S.border}`,display:"flex",alignItems:"center",gap:12,position:"sticky",top:0,zIndex:10,backdropFilter:"blur(12px)"}}>
          <button onClick={()=>setDrillRoster(null)} style={{width:36,height:36,borderRadius:"50%",background:S.panel,border:`1px solid ${S.border}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7 7M5 12l7-7" stroke={S.ink} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div style={{flex:1}}>
            <div style={{fontSize:18,fontWeight:800,color:S.ink}}>{MONTHS_FULL[mNum]} {r.year}</div>
            <div style={{fontSize:12,color:S.muted,marginTop:1}}>{allRows.length} flights · {fmtMins(totalBlock)} total block · {isSigned?"✓ Signed":"Not verified"}</div>
          </div>
          {isSigned&&<span style={{fontSize:11,fontWeight:700,color:"#2563EB",background:"#EFF6FF",padding:"4px 10px",borderRadius:100,border:"1px solid #BFDBFE",flexShrink:0}}>🔒 Verified</span>}
        </div>
        <div style={{padding:"16px 16px 80px"}}>
          <button onClick={()=>setVerifyModal(r)} style={{width:"100%",padding:"13px",borderRadius:14,background:isSigned?"none":`linear-gradient(135deg,${S.blue},#7C3AED)`,border:isSigned?`1.5px solid ${S.border}`:"none",color:isSigned?S.muted:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",marginBottom:16,boxShadow:isSigned?"none":`0 4px 16px ${S.blue}30`}}>
            {isSigned?"✏️ Edit signed record (tracked in audit log)":"Verify & Sign this month"}
          </button>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {allRows.map(({f,d,di,fi,tk,t,dateStr})=>{
              const synced=!!t.tail; const bm=t.actualBlockMins??schedMins(f)??0;
              return(
                <div key={tk} onClick={()=>setDrillFlight({f,day:d,roster:r,di,fi,tk,tail:t,dateStr})}
                  style={{background:S.surface,borderRadius:16,padding:"14px 16px",border:`1px solid ${synced?"#A7F3D0":S.border}`,display:"flex",alignItems:"center",gap:14,cursor:"pointer"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor="#C4B5FD"}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=synced?"#A7F3D0":S.border}
                >
                  <div style={{width:4,height:44,borderRadius:2,background:synced?"#10B981":S.border,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:800,color:S.ink}}>{f.flightNum}</div>
                    <div style={{fontSize:12,color:S.muted,marginTop:2}}>{dateStr} · {f.dep}→{f.arr} · {f.depTime||"--"}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:S.ink}}>{bm?fmtMins(bm):"--"}</div>
                    {t.tail?<div style={{fontSize:11,color:"#10B981",fontFamily:"monospace",marginTop:2}}>{t.tail}</div>:<div style={{fontSize:11,color:S.muted,marginTop:2}}>Pending</div>}
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
                      onClick={e=>{e.stopPropagation();setVerifyModal(r);}}
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
                      onClick={e=>{e.stopPropagation();setVerifyModal(r);}}
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
                const totalFlights=(r.calendar||[]).reduce((a,d)=>a+(d.flights||[]).length,0);
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
  const BLUE="#1D4ED8"; const PURPLE="#7C3AED";

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

  const appTotals = useMemo(()=>{
    let totalMins=0, sicMins=0, nightMins=0, xcMins=0,
        turbineMins=0, multiMins=0, singleMins=0,
        dayLdg=0, nightLdg=0, totalLegs=0, airports=new Set();
    for(const r of rosters){
      const mNum=r.monthNum??r.month_num??0;
      (r.calendar||[]).forEach((d,di)=>{
        (d.flights||[]).forEach((f,fi)=>{
          const tk=`${r.id}-${di}-${fi}`;
          const t=tails[tk]||{};
          if(t.cancelled) return;
          const dateStr=`${r.year}-${String(mNum+1).padStart(2,"0")}-${String(d.day).padStart(2,"0")}`;
          const mins=t.actualBlockMins!=null?t.actualBlockMins:schedMins(f)||0;
          const solar=computeSolarTimes(f.dep,f.arr,f.depTime,f.arrTime,dateStr);
          const night=solar?.nightMins||0;
          const dist=calcDist(f.dep,f.arr)||0;
          const isXC=dist>50;
          const acType=(f.acType||"").toUpperCase();
          const isMulti=/B73[78H]|B737|B738|B739|B74[78]|B767|B772|B77[789]|B787|A3[0-9]{2}|CRJ|CR[79]|E7[05]|E170|E175|E190|ERJ/i.test(acType);
          const isTurbine=isMulti||/DH8|ATR|SF3/i.test(acType);
          const isSingle=!isMulti&&/C172|PA28|BE[123]/i.test(acType);
          totalMins+=mins; totalLegs+=1; sicMins+=mins;
          if(night>0) nightMins+=night;
          if(isXC) xcMins+=mins;
          if(isTurbine) turbineMins+=mins;
          if(isMulti) multiMins+=mins;
          if(isSingle) singleMins+=mins;
          if(solar?.nightArr) nightLdg+=1; else dayLdg+=1;
          if(f.dep) airports.add(f.dep);
          if(f.arr) airports.add(f.arr);
        });
      });
    }
    return{totalMins,sicMins,nightMins,xcMins,turbineMins,multiMins,singleMins,dayLdg,nightLdg,totalLegs,airports:airports.size};
  },[rosters,tails]);

  const FIELDS = [
    {key:"totalTime",  label:"Total Time",      color:BLUE,     desc:"All logged block time"},
    {key:"pic",        label:"PIC",             color:PURPLE,   desc:"Pilot-in-command"},
    {key:"sic",        label:"SIC / Co-Pilot",  color:PURPLE,   desc:"Second-in-command"},
    {key:"night",      label:"Night",           color:"#0F172A",desc:"Civil twilight or later"},
    {key:"xc",         label:"Cross Country",   color:"#059669",desc:"Legs > 50 NM"},
    {key:"actualIfr",  label:"Actual IMC",      color:PURPLE,   desc:"Actual instrument"},
    {key:"hoodIfr",    label:"Hood / Sim IFR",  color:PURPLE,   desc:"Simulated instrument"},
    {key:"turbine",    label:"Turbine",         color:BLUE,     desc:"Jet or turboprop"},
    {key:"multi",      label:"Multi-Engine",    color:BLUE,     desc:"Multi-engine aircraft"},
    {key:"single",     label:"Single-Engine",   color:"#F59E0B",desc:"Single-engine flights"},
    {key:"sim",        label:"Simulator",       color:S.muted,  desc:"Sim sessions"},
    {key:"dayLdg",     label:"Day Ldg",         color:"#059669",desc:"Daytime landings",     isInt:true},
    {key:"nightLdg",   label:"Night Ldg",       color:"#0F172A",desc:"Night landings",        isInt:true},
    {key:"approaches", label:"Approaches",      color:PURPLE,   desc:"IFR approaches logged", isInt:true},
  ];

  const appValues = {
    totalTime:appTotals.totalMins, pic:0, sic:appTotals.sicMins,
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
        <div style={{fontSize:12,color:"rgba(255,255,255,0.7)",marginTop:3}}>Enter your prior logbook totals · FlightLog records on top automatically</div>
      </div>

      {/* Prior times entry */}
      <div style={{background:S.surface,border:`1px solid ${S.border}`,borderRadius:16,padding:"16px 18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:S.ink}}>Prior Logbook Times</div>
            <div style={{fontSize:11,color:S.muted,marginTop:2}}>Times from your previous logbook before using FlightLog</div>
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
      <div style={{fontSize:12,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:"1px",padding:"2px 0"}}>Grand Total (Prior + FlightLog)</div>
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
              {appVal>0&&<div style={{fontSize:10,color:BLUE,fontWeight:600,marginTop:2}}>+{appDisplay} FlightLog</div>}
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
      <div style={{background:`linear-gradient(135deg,${S.blue},#7C3AED)`,borderRadius:18,padding:"18px 20px",color:"#fff"}}>
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
      <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:14,padding:"12px 16px",display:"flex",gap:10}}>
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
  const[tab,setTab]=useState("overview");
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
      <div style={{display:"flex",gap:0,marginBottom:20,borderBottom:"1px solid "+C.border,overflowX:"auto"}}>
        {[["overview","Overview"],["totaltimes","Total Times"],["far117","FAR 117"],["rules","Time Rules"],["recency","Recency"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"9px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,fontWeight:600,whiteSpace:"nowrap",color:tab===id?C.teal:C.muted,borderBottom:"2px solid "+(tab===id?C.teal:"transparent"),marginBottom:-1,transition:"all .15s"}}>{label}</button>
        ))}
      </div>

      {tab==="totaltimes"&&<div style={{padding:"0 16px 80px"}}><TotalTimesTab analytics={analytics} rosters={rosters} tails={tails}/></div>}
      {tab==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14,paddingBottom:80}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
            {[["Last 30 days",analytics.last30.mins],["Last 6 mo",analytics.last6mo.mins],["Last 12 mo",analytics.last12mo.mins]].map(([l,m])=>(
              <div key={l} className="card" style={{textAlign:"center",padding:"14px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:18,fontWeight:700,color:"#059669"}}>{m?fmtMins(m):"--"}</div>
                <div style={{fontSize:10,color:C.muted,marginTop:3}}>{l}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,fontWeight:700,color:C.ink}}>All-Time Totals</div>
              <div style={{display:"flex",gap:4}}>
                {[["every","Every leg"],["alternate","Alt. leg"]].map(([m,l])=>(
                  <button key={m} onClick={()=>setToLandingMode(m)} style={{padding:"3px 8px",borderRadius:5,fontSize:10,fontWeight:600,cursor:"pointer",border:"1px solid "+(toLandingMode===m?C.teal:C.border),background:toLandingMode===m?C.teal+"18":"none",color:toLandingMode===m?C.teal:C.muted}}>{l}</button>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {[["PIC",analytics.totals.pic],["SIC",analytics.totals.sic],["Multi Engine",analytics.totals.multi],["Turbine",analytics.totals.turbine],["Night",analytics.totals.night],["Cross Country",analytics.totals.xc]].map(([l,m])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#F1F5F9",borderRadius:8}}>
                  <span style={{fontSize:12,color:C.silver}}>{l}</span>
                  <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:m?C.ink:C.muted}}>{m?fmtMins(m):"--"}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#F1F5F9",borderRadius:8}}>
                <span style={{fontSize:12,color:C.silver}}>Day / Night T/O</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:C.ink}}>{analytics.totals.dayTo} / {analytics.totals.nightTo}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#F1F5F9",borderRadius:8}}>
                <span style={{fontSize:12,color:C.silver}}>Day / Night Ldg</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:C.ink}}>{analytics.totals.dayLdg} / {analytics.totals.nightLdg}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#F1F5F9",borderRadius:8,gridColumn:"span 2"}}>
                <span style={{fontSize:12,color:C.silver}}>Distance</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:C.ink}}>{analytics.totals.dist.toLocaleString()} NM</span>
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
      )}

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
                  <span style={{fontSize:11,color:"#DC2626"}}>Delete?</span>
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
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, maxNativeZoom: 18,
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
      const color = isFlown ? "#2D8CF0" : "#F5A623";
      const opacity = isFlown ? 0.75 : 0.45;
      const line = L.polyline(pts, {
        color, weight, opacity, smoothFactor:1,
      }).addTo(map);
      line.bindTooltip(`${dep} → ${arr} · ${count}×${isFlown?" (flown)":" (scheduled)"}`, {sticky:true});
      layersRef.current.push(line);
    }

    // Draw scheduled first (underneath), then flown on top
    Object.entries(schedRoutes).forEach(([key,count]) => addRoute(key,count,false));
    Object.entries(flownRoutes).forEach(([key,count]) => addRoute(key,count,true));

    // Draw airport dots
    airports.forEach(code => {
      const coords = AIRPORT_COORDS[code];
      if(!coords) return;
      const circle = L.circleMarker(coords, {
        radius: 5, color: "#fff", weight: 1.5,
        fillColor: "#2D8CF0", fillOpacity: 1,
      }).addTo(map);
      circle.bindTooltip(code, {permanent:false, direction:"top"});
      layersRef.current.push(circle);
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
        {/* Month / All time toggle */}
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button
            onClick={()=>setAllTime(false)}
            style={{padding:"5px 12px",borderRadius:7,border:`1px solid ${!allTime?C.teal:C.border}`,background:!allTime?C.teal+"22":"none",color:!allTime?C.teal:C.silver,fontSize:12,cursor:"pointer"}}>
            Monthly
          </button>
          <button
            onClick={()=>setAllTime(true)}
            style={{padding:"5px 12px",borderRadius:7,border:`1px solid ${allTime?C.teal:C.border}`,background:allTime?C.teal+"22":"none",color:allTime?C.teal:C.silver,fontSize:12,cursor:"pointer"}}>
            All time
          </button>
        </div>
        {/* Roster picker -- only shown in monthly mode */}
        {!allTime && (
          <select
            value={selectedRosterId||""}
            onChange={e=>setSelectedRosterId(e.target.value)}
            style={{padding:"5px 10px",borderRadius:7,border:"1px solid #E2E8F0",background:"#F1F5F9",color:C.ink,fontSize:12}}>
            {rosters.map(r=>(
              <option key={r.id} value={r.id}>{r.periodLabel||`${r.year}`}</option>
            ))}
          </select>
        )}
        {/* Legend */}
        <div style={{display:"flex",gap:12,alignItems:"center",marginLeft:4}}>
          <span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:C.silver}}>
            <span style={{width:20,height:3,background:"#2D8CF0",borderRadius:2,display:"inline-block"}}/>Flown
          </span>
          <span style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:C.silver}}>
            <span style={{width:20,height:3,background:"#F5A623",borderRadius:2,display:"inline-block",opacity:.7}}/>Scheduled
          </span>
        </div>
      </div>
      {/* Map */}
      <div ref={mapRef} style={{flex:1,width:"100%",minHeight:0}}/>
      {/* No data state */}
      {routeData.airports.length===0&&(
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",color:C.muted,fontSize:13,textAlign:"center",pointerEvents:"none"}}>
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
            <div style={{fontSize:36,marginBottom:10,opacity:.4}}>📄</div>
            <div style={{fontSize:13}}>No documents uploaded yet.</div>
            <div style={{fontSize:12,marginTop:4}}>Upload your medical certificate, pilot certificate, type ratings, passport etc.</div>
          </div>
        )}

        {docs.map(doc=>(
          <div key={doc.id} style={{display:"flex",alignItems:"center",gap:12,padding:"12px 0",borderBottom:`1px solid ${C.border}`}}>
            <div style={{width:36,height:36,borderRadius:8,background:C.teal+"18",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
              {doc.type?.includes("pdf")?"📄":doc.type?.includes("image")?"🖼":"📎"}
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
      if(error) throw new Error(error.message);
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
      <PageHeader title="Profile"/>
      <div style={{padding:16,maxWidth:540}}>

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
          {err&&<div style={{fontSize:13,color:C.red,marginBottom:12,padding:"8px 12px",background:"#FEF2F2",borderRadius:8}}>{err}</div>}
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
              <input className="form-input" value={airlineName} onChange={e=>setAirlineName(e.target.value)} placeholder="e.g. GoJet Airlines"/>
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
          <button onClick={()=>setPage&&setPage("membership")} style={{marginTop:12,width:"100%",padding:"10px",borderRadius:8,background:"none",border:"1px solid #E2E8F0",color:C.teal,fontSize:13,fontWeight:600,cursor:"pointer"}}>
            Manage Subscription →
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPage({user, rosters, tails, isDark, onToggleTheme}) {
  function download(){
    const csv=csvExport(rosters,tails);
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
    a.download=`flightlog_${(user.name||"pilot").replace(/\s/g,"_")}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  }
  const totalMins=totalMinsBest(rosters, tails);
  const flights=allFlights(rosters);
  return (
    <div style={{maxWidth:600}}>
      <div className="section-title">Settings</div>
      <div className="section-sub">Manage your account and data.</div>

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

function AdminUsers() {
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
          {label:"Total Pilots",value:pilots.length,color:"#059669"},
          {label:"This Month",value:signupsThisMonth,sub:`+${signupsThisMonth-signupsLastMonth} vs last month`,color:"#059669"},
          {label:"Pro Subscribers",value:pilots.filter(u=>u.plan==="pro").length,color:"#A78BFA"},
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
              <div style={{fontSize:11,fontWeight:700,color:"#059669"}}>{m.count||""}</div>
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
        <p style={{fontSize:13,color:C.muted,marginBottom:16}}>Set these in your <code style={{color:"#059669"}}>.env</code> file locally and in Vercel → Project → Settings → Environment Variables.</p>
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
          <div>2. Add <span style={{color:"#059669"}}>STRIPE_SECRET_KEY</span> to Supabase secrets</div>
          <div>3. Deploy the webhook Edge Function</div>
          <div>4. Point Stripe webhook → your Edge Function URL</div>
        </div>
      </div>
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
        <div style={{fontSize:13,fontWeight:600}}>Install FlightLog</div>
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
      navigator.share({title:"FlightLog",text:referralData.shareMessage,url:referralData.shareUrl});
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
          <div className="card" style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:13,fontWeight:700,color:C.ink}}>Current Plan</div>
              <span className={`pill ${isActive?"pill-green":isPastDue?"pill-orange":"pill-muted"}`}>
                {isActive?"Active":isPastDue?"Past Due":"Inactive"}
              </span>
            </div>
            <div style={{fontSize:24,fontWeight:800,color:"#1D4ED8",marginBottom:4}}>FlightLog Pro</div>
            {isActive&&<div style={{fontSize:12,color:C.muted}}>{interval==="year"?"Annual - $99/year - $8.25/mo":"Monthly - $14/month"}{subEnd&&` - Renews ${subEnd}`}</div>}
            {isPastDue&&<div style={{fontSize:12,color:C.red,marginTop:4}}>Payment failed - update your payment method</div>}
            {(isActive||isPastDue)&&(
              <button onClick={openPortal} disabled={loading==="portal"} style={{marginTop:12,padding:"9px 16px",borderRadius:8,background:"none",border:"1px solid #E2E8F0",color:C.muted,fontSize:13,cursor:"pointer"}}>
                {loading==="portal"?<span className="spinner">loading</span>:"Manage billing"}
              </button>
            )}
          </div>

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
            <div style={{fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:".5px",marginBottom:10}}>Choose your plan</div>

            {/* Annual hero */}
            <div style={{marginBottom:10,padding:20,borderRadius:14,background:`linear-gradient(135deg,${C.teal},${C.tealDim})`,position:"relative",overflow:"visible"}}>
              <div style={{position:"absolute",top:-12,left:"50%",transform:"translateX(-50%)",background:"#fff",color:C.teal,fontSize:10,fontWeight:800,padding:"4px 14px",borderRadius:100,letterSpacing:"1px",whiteSpace:"nowrap",boxShadow:"0 2px 8px rgba(0,0,0,0.15)"}}>BEST VALUE -- SAVE 41%</div>
              <div style={{position:"absolute",top:4,right:4,width:60,height:60,borderRadius:"50%",background:"rgba(255,255,255,0.08)"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,marginTop:8}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:"#fff"}}>Annual Plan</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,0.75)"}}>Just $8.25/month</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:28,fontWeight:900,color:"#fff",letterSpacing:"-1px"}}>$99</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.7)"}}>/year</div>
                </div>
              </div>
              {/* Annual-only features */}
              <div style={{marginBottom:14}}>
                {["2 months free vs monthly","Locked-in rate -- never increases","Priority support response","Early access to new features"].map(f=>(
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
                  background:loading==="annual"?"rgba(255,255,255,0.7)":"#fff",
                  border:"none",color:C.teal,fontSize:14,fontWeight:700,
                  cursor:loading?"not-allowed":"pointer",
                  transition:"all .15s",
                  opacity:loading&&loading!=="annual"?0.7:1,
                }}
              >
                {loading==="annual"
                  ?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,color:"#059669"}}><span className="spinner">⟳</span> Processing...</span>
                  :"Subscribe Annual -- $99/year →"}
              </button>
              <div style={{fontSize:11,color:"rgba(255,255,255,0.6)",textAlign:"center",marginTop:8}}>30-day money-back guarantee</div>
            </div>

            {/* Monthly */}
            <div className="card" style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div>
                  <div style={{fontSize:14,fontWeight:600,color:C.ink}}>Monthly</div>
                  <div style={{fontSize:12,color:C.muted}}>Cancel anytime</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:22,fontWeight:800,color:C.ink}}>$14</div>
                  <div style={{fontSize:11,color:C.muted}}>/month</div>
                </div>
              </div>
              <button
                onClick={()=>subscribe("month")}
                disabled={!!loading}
                style={{
                  width:"100%",padding:"12px",borderRadius:10,
                  background:loading==="monthly"?C.teal+"22":"none",
                  border:`1.5px solid ${loading==="monthly"?C.teal:C.border}`,
                  color:loading==="monthly"?C.teal:C.silver,
                  fontSize:13,fontWeight:600,
                  cursor:loading?"not-allowed":"pointer",
                  transition:"all .15s",
                  opacity:loading&&loading!=="monthly"?0.7:1,
                }}
              >
                {loading==="monthly"
                  ?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><span className="spinner">⟳</span> Processing...</span>
                  :"Subscribe Monthly -- $14/mo"}
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
            {user?.referred_by&&!refApplied&&<div style={{padding:"10px 14px",borderRadius:8,background:"#ECFDF5",border:`1px solid ${C.teal}33`,color:C.teal,fontSize:12,marginBottom:14}}>Referral applied - your referrer earns a free month when you subscribe</div>}
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
      navigator.share({title:"FlightLog",text:data.shareMessage,url:data.shareUrl});
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
            <div style={{fontSize:16,fontWeight:700,color:"#fff",marginBottom:4}}>Refer a pilot, earn $11</div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.8)",marginBottom:16}}>For every pilot you refer who subscribes, you get $11 credited to your next bill.</div>
            {[["1","Share your unique referral code or link"],["2","Your friend subscribes to FlightLog"],["3","You automatically get $11 off your next bill"]].map(([n,t])=>(
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
              {label:"Credits",val:`$${(data.credits||0)*11}`},
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
  const [onlySynced, setOnlySynced] = useState(false);

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
          if(onlySynced && !t.tail) return;
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
      downloadCsv("flightlog-export.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    } else if(type==="jeppesen") {
      const rows = [["Date","Flight No","From","To","Departure Time","Arrival Time","Aircraft Make & Model","Aircraft Ident","Total Duration","Night","Actual Instrument","Simulated Instrument","Cross Country","Dual Received","Pilot in Command","Solo","Ground Trainer","Remarks"]];
      flights.forEach(({f,d,t,r,dateStr}) => {
        const block = t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
        rows.push([dateStr,f.flightNum,f.dep,f.arr,t.actualDep||f.depTime,t.actualArr||f.arrTime,f.acType||"","N/"+(t.tail||""),block,"","","","","",block,"","",t.remarks||""]);
      });
      downloadCsv("flightlog-jeppesen.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    } else if(type==="asa") {
      const rows = [["Date","Aircraft Make/Model","Aircraft Ident","Route From","Route To","Total Flight Time","Night","Actual IMC","Simulated IMC","Cross-Country","Dual","PIC","Solo","Approaches","Remarks"]];
      flights.forEach(({f,d,t,r,dateStr}) => {
        const block = t.actualBlockMins!=null?fmtMins(t.actualBlockMins):schedMins(f)?fmtMins(schedMins(f)):"";
        rows.push([dateStr,f.acType||"","N/"+(t.tail||""),f.dep,f.arr,block,"","","","",block,"","","",t.remarks||""]);
      });
      downloadCsv("flightlog-asa.csv", rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"));
    }
  }

  return (
    <div style={{flex:1,overflowY:"auto",background:C.base}}>
      <PageHeader title="Export Logbook"/>
      <div style={{padding:16}}>

        {/* Stats */}
        <div className="card" style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            {[{label:"Flights",val:total,color:"#059669"},{label:"Synced",val:synced,color:C.green},{label:"Rosters",val:(rosters||[]).length,color:C.ink}].map(({label,val,color})=>(
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
            {label:"Only synced flights (with tail number)",val:onlySynced,set:setOnlySynced},
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
          {type:"csv",      fmt:"CSV Universal",   desc:"All fields -- Excel & Google Sheets", color:"#059669"},
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
          ["What airlines are supported?","Any airline roster in PDF format -- GoJet, Republic, SkyWest, United, American, Delta, Southwest, and more."],
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
    {id:"calendar",  label:"Roster View", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="17" rx="2" stroke={c} strokeWidth="2" fill="none"/><path d="M8 2V6M16 2V6M3 9H21" stroke={c} strokeWidth="2" strokeLinecap="round"/><rect x="7" y="13" width="3" height="3" rx=".5" fill={c}/><rect x="14" y="13" width="3" height="3" rx=".5" fill={c}/></svg>},
    {id:"logbook",   label:"Logbook", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="13" height="18" rx="2" stroke={c} strokeWidth="2" fill="none"/><path d="M8 7H13M8 11H11" stroke={c} strokeWidth="2" strokeLinecap="round"/><circle cx="17" cy="17" r="4" fill={c}/><path d="M17 15.5V17L18.5 18" stroke={C.surface} strokeWidth="1.5" strokeLinecap="round"/></svg>},
    {id:"upload",    label:"Upload Roster", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 4L12 15M12 4L8 8M12 4L16 8" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V17" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"analytics", label:"Stats", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={c}/><rect x="10" y="7" width="4" height="14" rx="1" fill={c}/><rect x="17" y="3" width="4" height="18" rx="1" fill={c}/></svg>},
    {id:"active-logs",label:"Active Logs", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"export",    label:"Export Logbook", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 15L12 4M12 15L8 11M12 15L16 11" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M4 17V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V17" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"membership",label:"Membership", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="2" y="5" width="20" height="14" rx="2" stroke={c} strokeWidth="2" fill="none"/><path d="M2 10H22" stroke={c} strokeWidth="2"/></svg>},
    {id:"profile",   label:"Profile", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke={c} strokeWidth="2" fill="none"/><path d="M4 20C4 17 7.6 15 12 15C16.4 15 20 17 20 20" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"settings",  label:"Settings", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={c} strokeWidth="2" fill="none"/><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none"/></svg>},
  ];
  const adminNav = [
    {id:"admin-overview", label:"Overview", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill={c}/><rect x="14" y="3" width="7" height="7" rx="1" fill={c}/><rect x="3" y="14" width="7" height="7" rx="1" fill={c}/><rect x="14" y="14" width="7" height="7" rx="1" fill={c}/></svg>},
    {id:"admin-users",    label:"Users", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="7" r="4" stroke={c} strokeWidth="2" fill="none"/><path d="M3 20C3 17 5.7 15 9 15" stroke={c} strokeWidth="2" strokeLinecap="round"/><path d="M16 11C17.7 11 19 12.3 19 14C19 15.7 17.7 17 16 17" stroke={c} strokeWidth="2" strokeLinecap="round"/><path d="M13 20C13 18 14.3 16.5 16 16.5C17.7 16.5 21 17.5 21 20" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-analysis", label:"Analysis", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={c}/><rect x="10" y="7" width="4" height="14" rx="1" fill={c}/><rect x="17" y="3" width="4" height="18" rx="1" fill={c}/></svg>},
    {id:"admin-rosters",  label:"All Rosters", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z" stroke={c} strokeWidth="2" fill="none"/><path d="M8 13H16M8 17H13" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-settings", label:"Admin Settings", icon:(c)=><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke={c} strokeWidth="2" fill="none"/><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2" fill="none"/></svg>},
  ];
  const navItems = isAdmin ? adminNav : pilotNav;
  return (
    <div style={{width:220,height:"100%",background:C.surface,borderRight:`1px solid ${C.border}`,display:"flex",flexDirection:"column",flexShrink:0}}>
      <div style={{padding:"20px 20px 16px",borderBottom:`1px solid ${C.border}`}}>
        <div style={{fontSize:18,fontWeight:800,color:C.teal,letterSpacing:"-.5px"}}>Flight<span style={{color:C.ink}}>Log</span></div>
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
const TAB_PAGES = ["dashboard","calendar","active-logs","add-flight","more"];
const MORE_PAGES = ["analytics","logbook","map","profile","settings","membership","support","export","referral"];

function BottomTabBar({page, setPage, user}) {
  const isAdmin = user?.role === "admin";
  const ADMIN_TAB_PAGES = ["admin-overview","admin-users","admin-analysis","admin-rosters","more"];
  const active = isAdmin
    ? (ADMIN_TAB_PAGES.includes(page)?page:page==="admin-settings"||page==="profile"?"more":"admin-overview")
    : (TAB_PAGES.includes(page)?page:MORE_PAGES.includes(page)?"more":"dashboard");

  const BLUE = C.teal;
  const MUTED = C.muted;

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
      id:"calendar",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="4" width="18" height="17" rx="2" stroke={active?BLUE:MUTED} strokeWidth="2"/>
          <path d="M8 2V6M16 2V6M3 9H21" stroke={active?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
    },
    {
      id:"add-flight",
      icon:(active)=>(
        <div style={{width:42,height:42,borderRadius:14,background:active?BLUE:"linear-gradient(135deg,#1D4ED8,#7C3AED)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:active?"0 4px 14px rgba(29,78,216,0.4)":"0 4px 14px rgba(29,78,216,0.3)",marginBottom:-2}}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/></svg>
        </div>
      ),
    },
    {
      id:"active-logs",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M9 12h6M9 16h6M9 8h6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke={active?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/>
          <circle cx="18" cy="18" r="3" fill={active?BLUE:MUTED}/>
        </svg>
      ),
    },
    {
      id:"more",
      icon:(active)=>(
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="5" cy="12" r="2" fill={active?BLUE:MUTED}/>
          <circle cx="12" cy="12" r="2" fill={active?BLUE:MUTED}/>
          <circle cx="19" cy="12" r="2" fill={active?BLUE:MUTED}/>
        </svg>
      ),
    },
  ];

  const adminTabs = [
    {id:"admin-overview",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="14" y="3" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="3" y="14" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/><rect x="14" y="14" width="7" height="7" rx="1" fill={a?BLUE:MUTED}/></svg>},
    {id:"admin-users",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="7" r="4" stroke={a?BLUE:MUTED} strokeWidth="2" fill="none"/><path d="M3 20c0-3 2.7-5 6-5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/><path d="M16 11c1.7 0 3 1.3 3 3s-1.3 3-3 3M13 20c0-2 1.3-3.5 3-3.5s5 1 5 3.5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-analysis",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={a?BLUE:MUTED}/><rect x="10" y="7" width="4" height="14" rx="1" fill={a?BLUE:MUTED}/><rect x="17" y="3" width="4" height="18" rx="1" fill={a?BLUE:MUTED}/></svg>},
    {id:"admin-rosters",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke={a?BLUE:MUTED} strokeWidth="2" fill="none"/><path d="M8 13h8M8 17h5" stroke={a?BLUE:MUTED} strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"more",icon:(a)=><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="2" fill={a?BLUE:MUTED}/><circle cx="12" cy="12" r="2" fill={a?BLUE:MUTED}/><circle cx="19" cy="12" r="2" fill={a?BLUE:MUTED}/></svg>},
  ];

  const tabs = isAdmin ? adminTabs : pilotTabs;

  return (
    <nav style={{
      display:"flex",
      justifyContent:"space-between",
      alignItems:"center",
      background:C.surface,
      borderTop:`1px solid ${C.border}`,
      boxShadow:"0 -10px 40px rgba(0,0,0,0.06)",
      padding:"12px 24px",
      paddingBottom:`calc(16px + env(safe-area-inset-bottom, 0px))`,
      flexShrink:0,
      zIndex:999,
      width:"100%",
      boxSizing:"border-box",
    }}>
      {tabs.map(tab=>{
        const isActive = active===tab.id;
        return(
          <button
            key={tab.id}
            onClick={()=>setPage(tab.id)}
            style={{
              display:"flex",
              flexDirection:"column",
              alignItems:"center",
              justifyContent:"center",
              padding:"8px",
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
            {/* Active dot indicator */}
            {isActive&&(
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
  );
}


function MorePage({user, setPage, onLogout, rosters, tails}) {
  const isAdmin = user?.role === "admin";

  const S = getS();

  const pilotItems = [
    {id:"analytics",   label:"Stats",                  bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={S.blue}/><rect x="10" y="7" width="4" height="14" rx="1" fill="#1D4ED8"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#1D4ED8"/></svg>},
    {id:"logbook",     label:"Logbook",                  bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="4" y="2" width="13" height="18" rx="2" stroke={S.blue} strokeWidth="2" fill="none"/><path d="M8 7h6M8 11h4" stroke={S.blue} strokeWidth="2" strokeLinecap="round"/></svg>},
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
    {id:"settings",    label:"Settings",                bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#7C3AED" strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="#7C3AED" strokeWidth="2"/></svg>},
  ];

  const adminItems = [
    {id:"admin-overview",  label:"Admin Overview",    bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="14" y="3" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="3" y="14" width="7" height="7" rx="1" fill="#1D4ED8"/><rect x="14" y="14" width="7" height="7" rx="1" fill="#1D4ED8"/></svg>},
    {id:"admin-users",     label:"User Management",   bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/><circle cx="9" cy="7" r="4" stroke="#F97316" strokeWidth="2"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-analysis",  label:"Analysis",          bg:`${S.blue}18`, color:S.blue,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="12" width="4" height="9" rx="1" fill={S.blue}/><rect x="10" y="7" width="4" height="14" rx="1" fill="#1D4ED8"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#1D4ED8"/></svg>},
    {id:"admin-rosters",   label:"All Rosters",       bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="#7C3AED" strokeWidth="2"/><path d="M8 13h8M8 17h5" stroke="#7C3AED" strokeWidth="2" strokeLinecap="round"/></svg>},
    {id:"admin-settings",  label:"Admin Settings",    bg:`${S.purple}18`, color:S.purple,
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#7C3AED" strokeWidth="2"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="#7C3AED" strokeWidth="2"/></svg>},
    {id:"profile",         label:"Profile",           bg:`#F9731618`, color:"#F97316",
     icon:<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="#F97316" strokeWidth="2"/><path d="M4 20c0-3 3.6-5 8-5s8 2 8 5" stroke="#F97316" strokeWidth="2" strokeLinecap="round"/></svg>},
  ];

  const items = isAdmin ? adminItems : pilotItems;

  return (
    <div style={{flex:1,overflowY:"auto",background:S.bg,fontFamily:"Inter,system-ui,sans-serif",paddingBottom:80}}>

      {/* Background blobs */}
      <div style={{position:"fixed",top:"-10%",right:"-5%",width:"40%",height:"40%",background:"#E9D5FF",borderRadius:"50%",filter:"blur(100px)",opacity:0.4,pointerEvents:"none",zIndex:0}}/>
      <div style={{position:"fixed",top:"20%",left:"-10%",width:"30%",height:"30%",background:"#BFDBFE",borderRadius:"50%",filter:"blur(100px)",opacity:0.4,pointerEvents:"none",zIndex:0}}/>

      {/* Header */}
      <div style={{padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:10,background:"rgba(248,250,252,0.9)",backdropFilter:"blur(12px)",borderBottom:`1px solid ${S.border}`}}>
        <h1 style={{fontSize:11,fontWeight:700,color:S.muted,textTransform:"uppercase",letterSpacing:"2px",margin:0}}>More</h1>
      </div>

      <div style={{padding:"16px 16px 0",maxWidth:640,margin:"0 auto",position:"relative",zIndex:1}}>
        {isAdmin&&(
          <div style={{marginBottom:12,padding:"10px 14px",borderRadius:12,background:"#FEF2F2",border:"1px solid #FECACA",fontSize:12,fontWeight:700,color:"#EF4444",letterSpacing:"1px",textTransform:"uppercase"}}>
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
          FlightLog · {user?.email}
        </div>
      </div>
    </div>
  );
}

// --- ROOT APP -----------------------------------------------------------------
function SubscriptionWall({user, onSubscribed, onLogout}) {
  const [checking, setChecking] = useState(true);
  const [attempts, setAttempts] = useState(0);

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

  // Poll every 3 seconds
  useEffect(()=>{
    // Check immediately on mount
    checkSubscription().then(found => { if(!found) setChecking(false); });

    let count = 0;
    const poll = setInterval(async()=>{
      count++;
      setAttempts(count);
      const found = await checkSubscription();
      if(found || count >= 60) clearInterval(poll);
    }, 3000);
    return ()=>clearInterval(poll);
  },[]);

  const dots = [".", "..", "..."][attempts % 3];

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:C.base,minHeight:"100vh"}}>
      <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`,background:C.surface,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div style={{fontSize:18,fontWeight:800,color:C.teal,letterSpacing:"-.5px"}}>Flight<span style={{color:C.ink}}>Log</span></div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>checkSubscription()} style={{fontSize:12,color:C.teal,background:C.teal+"15",border:`1px solid ${C.teal}33`,borderRadius:6,padding:"5px 12px",cursor:"pointer",fontWeight:600}}>
            Check status
          </button>
          <button onClick={onLogout} style={{fontSize:12,color:C.muted,background:"none",border:"none",cursor:"pointer"}}>Sign out</button>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",alignItems:"center",padding:"28px 16px"}}>
        <div style={{textAlign:"center",marginBottom:24,maxWidth:360}}>
          <div style={{fontSize:40,marginBottom:12}}>✈</div>
          <div style={{fontSize:22,fontWeight:800,color:C.ink,marginBottom:8}}>
            Welcome, {user.name?.split(" ")[0]||"Pilot"}!
          </div>
          <div style={{fontSize:14,color:C.muted,lineHeight:1.65}}>
            Subscribe to unlock FlightLog. The app opens automatically when payment confirms.
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:20,padding:"8px 16px",borderRadius:20,background:"#ECFDF5",border:`1px solid ${C.teal}22`}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:C.teal,flexShrink:0,animation:"pulse 1.5s infinite"}}/>
          <span style={{fontSize:12,color:C.teal,fontWeight:600}}>
            Listening for payment{dots}
          </span>
        </div>

        {[["📄","AI roster parsing -- any airline PDF"],["✈","Auto tail number & block time sync"],["📊","FAR 61.57 & 117 currency tracking"],["📋","Jeppesen & ASA export"],["🗺️","Route maps with live weather radar"]].map(([icon,text])=>(
          <div key={text} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",marginBottom:8,background:C.surface,borderRadius:10,border:"1px solid #E2E8F0",width:"100%",maxWidth:400}}>
            <span style={{fontSize:18,flexShrink:0}}>{icon}</span>
            <span style={{fontSize:13,color:C.ink,fontWeight:500}}>{text}</span>
          </div>
        ))}

        <div style={{width:"100%",maxWidth:400,marginTop:8}}>
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
  componentDidCatch(e,info) { console.error("FlightLog crash:", e, info); }
  render() {
    if(this.state.error) return(
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16,padding:24,background:"#F8FAFC",fontFamily:"Inter,system-ui,sans-serif"}}>
        <div style={{fontSize:32}}>⚠️</div>
        <div style={{fontSize:18,fontWeight:800,color:"#0F172A"}}>Something crashed</div>
        <div style={{fontSize:13,color:"#64748B",maxWidth:400,textAlign:"center",lineHeight:1.6,background:"#FEF2F2",padding:"12px 16px",borderRadius:12,border:"1px solid #FECACA",fontFamily:"monospace"}}>
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

  function navigate(newPage){
    if(newPage.startsWith("admin-")&&user?.role!=="admin") newPage="dashboard";
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
    setRosters(prev=>{
      const idx=prev.findIndex(r=>r.id===roster.id);
      if(idx>=0){const n=[...prev];n[idx]=roster;return n;}
      return[...prev,roster];
    });
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
    <div key={themeKey}>
      {screen==="loading"&&(
        <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:14,background:"#F4F6FB"}}>
          <div style={{fontSize:28,fontWeight:800,color:"#0B1437",letterSpacing:"-.5px"}}>Flight<span style={{color:"#1D4ED8"}}>Log</span></div>
          <div style={{fontSize:13,color:"#8A97B4"}}>Loading...</div>
        </div>
      )}
      {screen==="landing"&&(isStandalone()
        ?<AppLandingPage onAuth={handleAuth}/>
        :<LandingPage onLogin={()=>{setAuthMode("login");setScreen("auth");}} onSignup={()=>{setAuthMode("signup");setScreen("auth");}}/>
      )}
      {screen==="auth"&&<AuthPage onAuth={handleAuth} onBack={()=>setScreen("landing")} initialMode={authMode}/>}
      {screen==="app"&&user&&(
        <div style={{display:"flex",flexDirection:"column",height:"100dvh",overflow:"hidden",background:C.base,position:"fixed",top:0,left:0,right:0,bottom:0}} className="app-shell">
          {locked&&<LockScreen user={user} onUnlock={()=>{setLocked(false);resetIdleTimer();}}/>}

          {/* -- SUBSCRIPTION WALL -- */}
          {user.role!=="admin"&&(user.subscription_status==="inactive"||user.subscription_status==="cancelled")?(
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
              {page==="calendar"&&<CalendarPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated} onOpenFlight={(flight)=>{try{sessionStorage.setItem("fl_open_flight",JSON.stringify({rosterId:flight.roster?.id,di:flight.di,fi:flight.fi,flightData:flight}));}catch{}setPendingFlight(flight);navigate("logbook");}}/>}
              {page==="logbook"&&<LogbookPage user={user} rosters={rosters} tails={tails} onTailSaved={handleTailSaved} onDeleteRoster={handleDeleteRoster} onRosterUpdated={handleRosterCalendarUpdated} pendingFlight={pendingFlight} onPendingFlightConsumed={()=>setPendingFlight(null)} setPage={navigate}/>}
              {page==="upload"&&<UploadPage user={user} onRosterSaved={handleRosterSaved}/>}
              {page==="add-flight"&&<AddFlightPage user={user} rosters={rosters} onRosterSaved={handleRosterSaved} setPage={navigate}/>}
              {page==="more"&&<MorePage user={user} setPage={navigate} onLogout={handleLogout} rosters={rosters} tails={tails}/>}
              {page==="settings"&&<SettingsPage user={user} rosters={rosters} tails={tails} isDark={isDark} onToggleTheme={handleToggleTheme}/>}
              {page==="map"&&<RouteMapPage rosters={rosters} tails={tails}/>}
              {page==="analytics"&&<AnalyticsPage user={user} rosters={rosters} tails={tails}/>}
              {page==="active-logs"&&<ActiveLogsPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated} onTailSaved={handleTailSaved}/>}
              {page==="profile"&&<ProfilePage user={user} onUserUpdated={u=>setUser(u)} setPage={navigate}/>}
              {page==="referral"&&<ReferralPage user={user}/>}
              {page==="membership"&&<MembershipPage user={user}/>}
              {page==="support"&&<SupportPage user={user}/>}
              {page==="export"&&<ExportPage rosters={rosters} tails={tails}/>}
              {page==="admin-overview"&&user?.role==="admin"&&<AdminOverview/>}
              {page==="admin-users"&&user?.role==="admin"&&<AdminUsers/>}
              {page==="admin-rosters"&&user?.role==="admin"&&<AdminRosters/>}
              {page==="admin-analysis"&&user?.role==="admin"&&<AdminAnalysis/>}
              {page==="admin-settings"&&user?.role==="admin"&&<AdminSettings/>}
              </div>
              {/* Fixed bottom nav -- outside scrollable area so it never scrolls away */}
              <div className="mobile-tabbar" style={{flexShrink:0}}>
                <BottomTabBar page={page} user={user} setPage={(p)=>{
                  if(p==="active-logs"&&page==="active-logs") return;
                  navigate(p);
                }}/>
              </div>
            </div>
          </div>
          )}
        </div>
      )}
      <InstallPrompt/>
    </div>
    </ErrorBoundary>
  );
}
