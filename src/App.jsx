// ═══════════════════════════════════════════════════════════════════════════════
// FlightLog — Main App  (React + Supabase)
//
// HOW TO USE:
//   1. npm install @supabase/supabase-js
//   2. Copy supabase.js into src/
//   3. Create .env with VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      VITE_ANTHROPIC_API_KEY (optional - handled server-side in prod)
//   4. Run schema.sql in Supabase SQL Editor
//   5. npm run dev
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ── Supabase client config ──────────────────────────────────────────────────
const SUPA_URL  = import.meta.env.VITE_SUPABASE_URL  || "";
const SUPA_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

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
        // .single() — unwraps the first item from an array response.
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
        // Execute the query — called implicitly when awaited
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
          return fetch(base, {method:"POST", headers, body:JSON.stringify(body)}).then(async r => {
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
// ── WEBAUTHN HELPERS ──────────────────────────────────────────────────────────
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

  // Verify on server — returns tempToken
  const result = await webauthnCall("auth-verify", { credential: encoded });
  if(!result.verified) throw new Error("Biometric verification failed");

  // Exchange temp token for session
  const session = await webauthnCall("exchange-token", { tempToken: result.tempToken });
  return session;
}


const origFetch = window.fetch.bind(window);
window._sbFetch = origFetch;

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
// Light, minimalist theme inspired by a printed paper flight logbook: warm
// off-white pages, deep ink-navy text, hairline stone rules, and a single
// restrained "barn red" accent (the color of classic aviation instrument
// markings) used sparingly for emphasis and calls to action.
// ── THEME SYSTEM ─────────────────────────────────────────────────────────────
// Dark mode (default) — LogTen-inspired deep navy aesthetic
const DARK = {
  base:    "#090E1A",
  surface: "#0F1623",
  panel:   "#161D2E",
  panelLt: "#1C2438",
  border:  "#2A3450",
  ink:     "#FFFFFF",
  silver:  "#A8B4CC",
  muted:   "#5A6680",
  teal:    "#2D8CF0",
  tealDim: "#1A6BC4",
  red:     "#E05A5A",
  redDim:  "#C04040",
  green:   "#34C97A",
  gold:    "#F5A623",
};

// Light mode — clean white/cream with same accent palette
const LIGHT = {
  base:    "#F7F8FA",
  surface: "#FFFFFF",
  panel:   "#F0F2F6",
  panelLt: "#E8EBF2",
  border:  "#DDE1EC",
  ink:     "#0D1226",
  silver:  "#4A5568",
  muted:   "#9AA3B8",
  teal:    "#2D8CF0",
  tealDim: "#1A6BC4",
  red:     "#D94040",
  redDim:  "#B83030",
  green:   "#1FA05A",
  gold:    "#D4870F",
};

// C is set at runtime based on user preference (default dark)
// It's mutable so the theme can be switched without reloading the whole page.
let C = { ...DARK };

function applyTheme(isDark) {
  const src = isDark ? DARK : LIGHT;
  Object.assign(C, src);
  C.orange    = C.teal;
  C.orangeDim = C.tealDim;
  C.white     = C.ink;
  // Re-inject the style tag so the new color values take effect
  const el = document.getElementById("fl-styles");
  if(el) el.textContent = buildStyles();
}

// Read preference from localStorage (default: dark)
function getThemePref() {
  try { return localStorage.getItem("fl_theme") !== "light"; }
  catch { return true; }
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

// ── STYLES ────────────────────────────────────────────────────────────────────
// buildStyles() is called to regenerate the CSS whenever the theme changes.
// The style tag with id="fl-styles" is injected into <head> by App on mount.
function buildStyles() { return `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

/* ─── RESET & BASE ─────────────────────────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:15px;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{background:${C.base};color:${C.ink};font-family:'Inter',system-ui,sans-serif;line-height:1.5;font-size:14px;overflow-x:hidden}
button{cursor:pointer;font-family:'Inter',system-ui,sans-serif;font-size:14px;-webkit-tap-highlight-color:transparent}
input,textarea,select{font-family:'Inter',system-ui,sans-serif;font-size:16px;color-scheme:light dark}
a{color:${C.teal};text-decoration:none}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
::placeholder{color:${C.muted}!important;opacity:1}

/* ─── LAYOUT ───────────────────────────────────────────────────────────────── */
.app-shell{display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;flex-shrink:0;background:${C.surface};border-right:1px solid ${C.border};display:flex;flex-direction:column;overflow-y:auto}
.app-content{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.app-topbar{height:52px;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 20px;gap:12px;flex-shrink:0;position:sticky;top:0;z-index:40}
.app-page-title{font-size:15px;font-weight:600;color:${C.ink};flex:1}
.app-body{flex:1;overflow-y:auto;padding:20px;background:${C.base}}

/* ─── SIDEBAR ──────────────────────────────────────────────────────────────── */
.sidebar-brand{padding:18px 16px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid ${C.border}}
.sidebar-logo{font-size:17px;font-weight:700;color:${C.ink};letter-spacing:-.3px}
.sidebar-logo span{color:${C.teal}}
.sidebar-nav{padding:8px 8px;flex:1}
.sidebar-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;font-size:13px;color:${C.silver};background:none;border:none;width:100%;text-align:left;transition:all .12s;font-weight:500}
.sidebar-item:hover{background:${C.panel};color:${C.ink}}
.sidebar-item.active{background:${C.teal};color:#fff;font-weight:600}
.sidebar-item-icon{font-size:15px;width:20px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:12px 8px;border-top:1px solid ${C.border}}

/* ─── HAMBURGER / DRAWER ───────────────────────────────────────────────────── */
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

/* ─── AVATAR ───────────────────────────────────────────────────────────────── */
.avatar{width:32px;height:32px;border-radius:50%;background:${C.teal};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;cursor:pointer;transition:opacity .15s}
.avatar:hover{opacity:.8}

/* ─── CARDS & SHARED ───────────────────────────────────────────────────────── */
.card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:18px}
.section-title{font-size:18px;font-weight:700;color:${C.ink};margin-bottom:4px}
.section-sub{font-size:13px;color:${C.muted};margin-bottom:16px}
.divider{height:1px;background:${C.border};margin:16px 0}

/* ─── BUTTONS ──────────────────────────────────────────────────────────────── */
.btn-teal,.btn-orange{background:${C.teal};color:#fff;border:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;transition:background .15s}
.btn-teal:hover,.btn-orange:hover{background:${C.tealDim}}
.btn-teal:disabled,.btn-orange:disabled{opacity:.55;cursor:not-allowed}
.btn-sm-ghost{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:5px 12px;font-size:12px;border-radius:7px;transition:all .15s}
.btn-sm-ghost:hover{border-color:${C.teal}66;color:${C.teal}}
.btn-danger{background:transparent;border:1px solid ${C.red}44;color:${C.red};padding:5px 12px;font-size:12px;border-radius:7px}
.btn-full{width:100%;padding:14px;border-radius:10px;font-size:15px;font-weight:600;background:${C.teal};color:#fff;border:none;transition:background .15s}
.btn-full:hover{background:${C.tealDim}}
.btn-full:disabled{opacity:.6;cursor:not-allowed}

/* ─── FORMS ─────────────────────────────────────────────────────────────────── */
.form-group{margin-bottom:14px}
.form-label{font-size:12px;font-weight:600;color:${C.silver};margin-bottom:5px;display:block;text-transform:uppercase;letter-spacing:.4px}
.form-input{width:100%;background:${C.panel};border:1.5px solid ${C.border};color:${C.ink};padding:10px 13px;border-radius:9px;font-size:15px;outline:none;transition:border-color .15s;-webkit-appearance:none}
.form-input:focus{border-color:${C.teal}}
.form-select{width:100%;background:${C.panel};border:1.5px solid ${C.border};color:${C.ink};padding:10px 13px;border-radius:9px;font-size:15px;outline:none;-webkit-appearance:none}

/* ─── PILLS / BADGES ───────────────────────────────────────────────────────── */
.pill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:100px;font-size:11px;font-weight:600}
.pill-green{background:${C.green}18;color:${C.green}}
.pill-orange,.pill-red{background:${C.red}18;color:${C.red}}
.pill-muted{background:${C.muted}22;color:${C.silver}}
.pill-teal{background:${C.teal}18;color:${C.teal}}
.admin-badge{background:${C.red}14;border:1px solid ${C.red}33;color:${C.red};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.8px;text-transform:uppercase}

/* ─── NOTIFICATIONS ─────────────────────────────────────────────────────────── */
.notice{background:${C.teal}0d;border:1px solid ${C.teal}33;border-radius:8px;padding:10px 14px;font-size:13px;color:${C.teal};margin-bottom:14px}
.warn{background:${C.gold}0d;border:1px solid ${C.gold}44;border-radius:8px;padding:10px 14px;font-size:13px;color:${C.gold};margin-bottom:14px}
.parse-status{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:13px;margin-top:10px}
.parse-status.loading{background:${C.teal}18;border:1px solid ${C.teal}33;color:${C.teal}}
.parse-status.success{background:${C.green}18;border:1px solid ${C.green}33;color:${C.green}}
.parse-status.error{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red}}

/* ─── ANIMATIONS ───────────────────────────────────────────────────────────── */
.spinner{display:inline-block;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{left:-40%}100%{left:120%}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes slideInLeft{from{transform:translateX(-100%)}to{transform:translateX(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ─── LOADING SCREEN ────────────────────────────────────────────────────────── */
.loading-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:${C.base}}
.loading-logo{font-size:26px;font-weight:700;color:${C.ink}}
.loading-logo span{color:${C.teal}}
.loading-sub{font-size:13px;color:${C.muted}}

/* ─── AUTH ──────────────────────────────────────────────────────────────────── */
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

/* ─── DASHBOARD ─────────────────────────────────────────────────────────────── */
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

/* ─── UPLOAD ─────────────────────────────────────────────────────────────────── */
.upload-zone{border:2px dashed ${C.border};border-radius:14px;padding:48px 24px;text-align:center;cursor:pointer;transition:all .2s;background:${C.surface};color:${C.silver}}
.upload-zone:hover,.upload-zone.drag{border-color:${C.teal};background:${C.teal}08;color:${C.teal}}
.upload-icon{font-size:44px;display:block;margin-bottom:12px;opacity:.6}
.upload-page{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;max-width:900px}
.upload-info-panel{display:flex;flex-direction:column;gap:14px}
.upload-info-row{display:flex;gap:12px;align-items:flex-start}
.upload-info-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.upload-info-title{font-size:13px;font-weight:600;color:${C.ink};margin-bottom:2px}
.upload-info-desc{font-size:12px;color:${C.muted};line-height:1.5}

/* ─── CALENDAR ───────────────────────────────────────────────────────────────── */
/* ─── CALENDAR ───────────────────────────────────────────────────────────────── */
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

/* 7-column grid — all cells same fixed height */
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

/* ─── LOGBOOK — DAY CARDS / SEGMENT TABS ────────────────────────────────────── */
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

/* ─── MAP ────────────────────────────────────────────────────────────────────── */
.leaflet-container{background:${C.base}}

/* ─── DATA TABLE (admin) ─────────────────────────────────────────────────────── */
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{background:${C.panel};color:${C.muted};font-size:10px;text-transform:uppercase;letter-spacing:.8px;padding:8px 12px;text-align:left;border-bottom:1px solid ${C.border}}
.data-table td{padding:10px 12px;border-bottom:1px solid ${C.border};vertical-align:middle}
.data-table tr:hover td{background:${C.panel}}

/* ─── EMPTY / MISC ───────────────────────────────────────────────────────────── */
.empty-state{text-align:center;padding:48px 24px;color:${C.muted};font-size:13px}
.empty-icon{font-size:40px;margin-bottom:10px;opacity:.35}
.tag{display:inline-flex;background:${C.panel};border:1px solid ${C.border};color:${C.silver};font-size:11px;padding:2px 8px;border-radius:5px}
.table-wrap{overflow-x:auto}

/* ─── LANDING PAGE ───────────────────────────────────────────────────────────── */
.lp-nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;gap:24px;padding:0 40px;height:64px;background:${C.base}f0;backdrop-filter:blur(12px);border-bottom:1px solid ${C.border}}
.lp-logo{font-size:20px;font-weight:700;color:${C.ink};letter-spacing:-.3px}
.lp-logo span{color:${C.teal}}
.lp-nav-links{display:flex;gap:28px;margin-left:auto}
.lp-nav-link{font-size:13px;color:${C.silver};background:none;border:none;transition:color .15s}
.lp-nav-link:hover{color:${C.ink}}
.lp-nav-actions{display:flex;align-items:center;gap:8px}
.lp-nav-login{background:none;border:none;color:${C.ink};font-size:13px;font-weight:500;padding:8px 12px}
.lp-nav-cta{background:${C.teal};color:#fff;border:none;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;transition:background .15s}
.lp-nav-cta:hover{background:${C.tealDim}}
.lp-hero{min-height:90vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 24px 64px;position:relative;overflow:hidden}
.lp-hero-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 60% 40% at 50% 0%,${C.teal}12 0%,transparent 60%)}
.lp-eyebrow{display:inline-flex;align-items:center;gap:8px;background:${C.surface};border:1px solid ${C.teal}44;color:${C.teal};font-size:11px;font-weight:700;letter-spacing:1.5px;padding:6px 14px;border-radius:100px;margin-bottom:28px;text-transform:uppercase}
.lp-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:${C.teal};animation:pulse 2s infinite}
.lp-headline{font-size:clamp(36px,6vw,72px);font-weight:800;line-height:1.05;letter-spacing:-1.5px;color:${C.ink};margin-bottom:20px}
.lp-headline em{color:${C.teal};font-style:normal}
.lp-sub{font-size:clamp(14px,1.4vw,17px);color:${C.silver};max-width:480px;margin:0 auto 36px;line-height:1.6}
.lp-hero-btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:48px}
.btn-primary{background:${C.teal};color:#fff;border:none;padding:13px 28px;border-radius:9px;font-size:14px;font-weight:600;transition:all .15s}
.btn-primary:hover{background:${C.tealDim};transform:translateY(-1px)}
.btn-ghost{background:transparent;color:${C.ink};border:1.5px solid ${C.border};padding:12px 28px;border-radius:9px;font-size:14px;font-weight:500;transition:all .15s}
.btn-ghost:hover{border-color:${C.teal};color:${C.teal}}
.ledger{width:100%;max-width:560px;margin:0 auto;position:relative}
.ledger-line{position:relative;height:1px;background:${C.border};margin-bottom:8px}
.ledger-ticks{display:flex;justify-content:space-between;position:absolute;top:-5px;left:0;right:0}
.ledger-tick{width:1px;height:10px;background:${C.border}}
.ledger-tick.major{height:14px;background:${C.silver}}
.ledger-fill{position:absolute;left:0;top:0;height:1px;width:38%;background:${C.teal}}
.ledger-marker{position:absolute;left:38%;top:-4px;width:8px;height:8px;border-radius:50%;background:${C.teal};transform:translateX(-50%)}
.ledger-caption{display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:10px;color:${C.muted};letter-spacing:.5px;margin-top:12px}
.lp-stats{display:flex;justify-content:center;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};flex-wrap:wrap}
.lp-stat{padding:24px 32px;border-right:1px solid ${C.border};text-align:center}
.lp-stat:last-child{border-right:none}
.lp-stat-num{font-size:32px;font-weight:800;color:${C.ink};letter-spacing:-1px}
.lp-stat-lbl{font-size:12px;color:${C.silver};margin-top:2px}
.lp-section{padding:80px 40px;max-width:1080px;margin:0 auto}
.lp-section-eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.teal};margin-bottom:10px}
.lp-section-title{font-size:clamp(26px,3vw,40px);font-weight:800;color:${C.ink};margin-bottom:14px;line-height:1.1;letter-spacing:-.5px}
.lp-section-sub{font-size:15px;color:${C.silver};max-width:480px;line-height:1.6}
.features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:40px}
.feature-card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:24px;transition:all .2s}
.feature-card:hover{border-color:${C.teal}55;transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.06)}
.feature-icon{width:40px;height:40px;border-radius:10px;background:${C.teal}14;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:14px}
.feature-title{font-size:15px;font-weight:700;color:${C.ink};margin-bottom:6px}
.feature-desc{font-size:13px;color:${C.silver};line-height:1.6}
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:40px}
.price-card{background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:28px;position:relative}
.price-card.featured{border-color:${C.teal};box-shadow:0 4px 20px ${C.teal}18}
.price-badge{position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:${C.teal};color:#fff;font-size:10px;font-weight:700;padding:3px 12px;border-radius:100px;letter-spacing:.8px;white-space:nowrap}
.price-plan{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.silver};margin-bottom:6px}
.price-amount{font-size:40px;font-weight:800;color:${C.ink};line-height:1;letter-spacing:-1px}
.price-period{font-size:13px;color:${C.muted};margin-left:3px}
.price-desc{font-size:13px;color:${C.silver};margin:10px 0 20px}
.price-features{list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:24px}
.price-features li{font-size:13px;color:${C.silver};display:flex;align-items:center;gap:8px}
.price-features li::before{content:"✓";color:${C.teal};font-weight:700;flex-shrink:0}
.price-cta{width:100%;padding:11px;border-radius:8px;font-size:13px;font-weight:600;border:none;transition:all .15s}
.price-cta-primary{background:${C.teal};color:#fff}
.price-cta-primary:hover{background:${C.tealDim}}
.price-cta-ghost{background:transparent;color:${C.ink};border:1.5px solid ${C.border}}
.price-cta-ghost:hover{border-color:${C.teal};color:${C.teal}}
.how-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));background:${C.surface};border-radius:12px;border:1px solid ${C.border};margin-top:40px}
.how-step{padding:24px 20px;border-right:1px solid ${C.border}}
.how-step:last-child{border-right:none}
.how-num{font-size:36px;font-weight:800;color:${C.teal}33;line-height:1;margin-bottom:10px}
.how-title{font-size:14px;font-weight:700;color:${C.ink};margin-bottom:5px}
.how-desc{font-size:12px;color:${C.silver};line-height:1.55}
.lp-footer{border-top:1px solid ${C.border};padding:32px 40px;display:flex;align-items:center;gap:20px;flex-wrap:wrap}
.lp-footer-copy{font-size:12px;color:${C.muted};margin-left:auto}

/* ─── MOBILE ─────────────────────────────────────────────────────────────────── */
@media(max-width:768px){
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
  .lp-section{padding:48px 14px}
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

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const fmtMins = m => !m||isNaN(m) ? "0:00" : `${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;

// Returns the index of the roster that best matches the current month.
// Falls back to 0 (most recently uploaded) if no current-month roster exists.
// ── AIRPORT COORDINATES & SOLAR/DISTANCE UTILITIES ───────────────────────────

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

// NOAA solar civil twilight calculation (96° zenith)
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
// due to timezone, not an genuinely 8+ hour regional hop) — treat as unknown
// rather than display a misleading double-digit-hour figure.
// Timezone-aware scheduled block time.
// Roster departure/arrival times are LOCAL at each airport. Using raw time
// subtraction fails for cross-timezone flights (e.g. ORD→LAX shows 2:30
// instead of 4:30 because LAX local arrival looks "earlier" than ORD dep).
// We estimate UTC offset from airport longitude (lon/15) and convert both
// times to UTC minutes before subtracting. Falls back to naive if coords unknown.
function schedMinsFromAirports(depTime, arrTime, depCode, arrCode) {
  if(!depTime||!arrTime) return null;
  const depCoords = AIRPORT_COORDS[depCode];
  const arrCoords = AIRPORT_COORDS[arrCode];
  if(depCoords && arrCoords) {
    const depOff = Math.round(depCoords[1]/15);
    const arrOff = Math.round(arrCoords[1]/15);
    const [dh,dm] = depTime.split(":").map(Number);
    const [ah,am] = arrTime.split(":").map(Number);
    const depUTC = (dh*60+dm) - depOff*60;
    const arrUTC = (ah*60+am) - arrOff*60;
    const diff = ((arrUTC - depUTC) + 1440) % 1440;
    if(diff >= 15 && diff <= 600) return diff;
  }
  const naive = flightMins(depTime, arrTime);
  return naive <= 480 ? naive : null;
}
const schedMins = (f) => {
  // Parser-extracted block time from roster is most accurate — use it when available
  if(f.schedBlockMins!=null) return f.schedBlockMins;
  return schedMinsFromAirports(f.depTime, f.arrTime, f.dep, f.arr);
};
const schedMinsIsEstimate = (f) => f.schedBlockMins==null;
const rosterMins = r => r?.calendar?.reduce((a,d)=>a+d.flights.reduce((b,f)=>b+(schedMins(f)??0),0),0)??0;

// "Best available" duration for a flight: prefer the actual (synced, post-flight)
// block time when we have it — it's the real figure. Fall back to scheduled time
// for flights that haven't happened yet (or haven't synced), since that's the
// best estimate available until the real data arrives.
const bestMins = (f, tailEntry) => tailEntry?.cancelled ? 0 : (tailEntry?.actualBlockMins!=null ? tailEntry.actualBlockMins : (schedMins(f)??0));
const bestMinsIsActual = (tailEntry) => tailEntry?.actualBlockMins!=null;

// Total minutes across all rosters using best-available duration per flight
// (actual where synced, scheduled otherwise) — this is what the Dashboard's
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

function csvExport(rosters, tails) {
  const rows=[["Date","Day","Flight","Dep","SchedDepTime","ActualDepTime","Arr","SchedArrTime","ActualArrTime","AircraftType","Tail#","SchedBlockTime","ActualBlockTime","Period"]];
  (rosters||[]).forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    const k=`${r.id}-${di}-${fi}`;
    const t=tails[k]||{};
    // Cancelled flights never actually operated — exclude them from the
    // exported logbook entirely, since they shouldn't count toward logged hours.
    if(t.cancelled) return;
    const actualBlock = t.actualBlockMins!=null ? fmtMins(t.actualBlockMins) : "";
    const schedMinsVal = schedMins(f);
    const schedBlock = schedMinsVal!=null ? fmtMins(schedMinsVal) : "";
    rows.push([d.day,d.dow,f.flightNum,f.dep,f.depTime,t.actualDep||"",f.arr,f.arrTime,t.actualArr||"",f.acType,t.tail||"",schedBlock,actualBlock,r.periodLabel]);
  })));
  return rows.map(r=>r.join(",")).join("\n");
}

// ── PDF → BASE64 ──────────────────────────────────────────────────────────────
// Instead of extracting text positionally (which scrambles complex roster
// grids/tables), we send the raw PDF bytes to Claude, which reads the
// document visually — far more reliable for dense calendar-style layouts.
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

// ── AI ROSTER PARSER (native PDF) ───────────────────────────────────────────
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

// ── AERODATA LOOKUP ───────────────────────────────────────────────────────────
// Goes through our Edge Function, which holds the shared FlightAware key
// server-side. No pilot needs to provide their own key anymore.
async function lookupFlight(flightNum, date, depTime) {
  if (!SUPA_URL || !SUPA_ANON) {
    throw new Error("Supabase is not configured.");
  }
  // Send the user's actual session token (not anon key) so the Edge
  // Function can identify which pilot is calling for rate limiting.
  const sessionToken = sb.auth._token || SUPA_ANON;
  const r = await fetch(`${SUPA_URL}/functions/v1/lookup-flight`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sessionToken}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify({ flightNum, date, depTime }),
  });
  const data = await r.json();
  if(r.status === 429) throw new Error(data.error || "Daily lookup limit reached.");
  if (!r.ok) throw new Error(data.error || `Lookup failed (${r.status})`);
  return data;
}

// ── SUPABASE DATA LAYER ───────────────────────────────────────────────────────
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
    // Fetch profile
    const {data:profile} = await sb.from("profiles").select("*").eq("id", data.user.id);
    return {...data.user, ...(Array.isArray(profile)?profile[0]:profile)};
  }
  // local fallback
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

async function db_signOut() {
  if(isConfigured()) await sb.auth.signOut();
  local.set("fl_session",null);
}

async function db_getSession() {
  if(isConfigured()) {
    const {data:{user}} = await sb.auth.getUser();
    if(!user) return null;
    const {data:profile} = await sb.from("profiles").select("*").eq("id", user.id);
    return {...user,...(Array.isArray(profile)?profile[0]:profile)};
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
    const {data:existing} = await sb.from("rosters")
      .select("id")
      .eq("user_id", userId)
      .eq("year", roster.year)
      .eq("month_num", roster.monthNum)
      .single();

    if(existing?.id) {
      const {error} = await sb.from("rosters")
        .update({period_label:roster.periodLabel, calendar:roster.calendar})
        .eq("id", existing.id);
      if(error) throw new Error(error.message||JSON.stringify(error)||"Failed to update roster");
      return {...roster, id:existing.id};
    }

    // Handle carry-over days. Two cases:
    // Case 1: Parser returns day > daysInMonth (e.g. day 29-31 in Feb = not real Feb days)
    // Case 2: Parser resets day counter — Mar 1 appears as day:1 AFTER day:28 in Feb roster.
    //         We detect this by finding days at the END of the calendar array that are
    //         numbered lower than the preceding days (i.e. the counter reset to 1).
    const daysInMonth = new Date(roster.year, roster.monthNum+1, 0).getDate();
    const cal = roster.calendar || [];

    // Find the split point where days reset (carry-forward starts)
    let carryStartIdx = cal.length; // default: no carry-forward
    for(let i = 1; i < cal.length; i++) {
      if(cal[i].day < cal[i-1].day && cal[i].day <= 5) {
        // Day number dropped significantly → this is a new month starting
        carryStartIdx = i;
        break;
      }
    }
    // Also handle days explicitly numbered > daysInMonth
    const carryForwardDays = [
      ...cal.slice(carryStartIdx),                              // reset-counter carry-forward
      ...cal.slice(0, carryStartIdx).filter(d => d.day > daysInMonth), // high-numbered carry-forward
    ];
    const thisDays = cal.slice(0, carryStartIdx).filter(d => d.day >= 1 && d.day <= daysInMonth);

    if(carryForwardDays.length > 0) {
      const nextMonth = roster.monthNum === 11 ? 0 : roster.monthNum + 1;
      const nextYear  = roster.monthNum === 11 ? roster.year + 1 : roster.year;
      const nextDaysInMonth = new Date(nextYear, nextMonth+1, 0).getDate();

      // Normalize day numbers: if they came from a reset counter they're already correct (1,2,3...)
      // If they came from high-numbered days, subtract daysInMonth to get the correct next-month day
      const normalizedCarry = carryForwardDays.map(d => ({
        ...d,
        day: d.day > daysInMonth ? d.day - daysInMonth : d.day,
      })).filter(d => d.day >= 1 && d.day <= nextDaysInMonth);

      const {data:nextRoster} = await sb.from("rosters").select("id,calendar")
        .eq("user_id",userId).eq("year",nextYear).eq("month_num",nextMonth).single();

      if(nextRoster?.id) {
        // Next month exists — merge carry-forward days without duplicating
        const existingDays = new Set((nextRoster.calendar||[]).map(d=>d.day));
        const newDays = normalizedCarry.filter(d => !existingDays.has(d.day));
        if(newDays.length > 0) {
          const merged = [...(nextRoster.calendar||[]), ...newDays].sort((a,b)=>a.day-b.day);
          await sb.from("rosters").update({calendar:merged}).eq("id",nextRoster.id);
        }
      } else {
        // Next month not uploaded yet — create a stub roster
        const nextMonthLabel = new Date(nextYear, nextMonth, 1).toLocaleString("default",{month:"short",year:"numeric"});
        await sb.from("rosters").insert({
          user_id: userId,
          period_label: nextMonthLabel,
          year: nextYear,
          month_num: nextMonth,
          calendar: normalizedCarry,
        });
      }
    }

    const {data,error} = await sb.from("rosters")
      .insert({user_id:userId, period_label:roster.periodLabel, year:roster.year, month_num:roster.monthNum, calendar:thisDays})
      .select()
      .single();
    if(error) throw new Error(error.message||"Failed to save roster");
    return {...roster, id:data?.id||roster.id};
  }
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

// Saves an updated calendar array back to an existing roster — used when a
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
        finalSynced: !!r.final_synced,
        cancelled: !!r.cancelled,
        updatedAt: r.updated_at || null,
      };
    });
    return map;
  }
  return local.get("fl_tails_"+userId)||{};
}

async function db_saveTail(userId, rosterId, flightKey, tail, actualDep="", actualArr="", actualBlockMins=null, lock=false) {
  if(isConfigured()) {
    const payload = {
      user_id:userId, roster_id:rosterId, flight_key:flightKey,
      tail_number:tail,
      actual_dep_time: actualDep || null,
      actual_arr_time: actualArr || null,
      actual_block_mins: actualBlockMins ?? null,
    };
    if(lock) payload.final_synced = true;
    // Must specify onConflict so Supabase knows to UPDATE not INSERT on duplicate
    const {error} = await sb.from("tail_logs").upsert(payload, {onConflict:"user_id,roster_id,flight_key"});
    if(error) throw new Error(error.message||"Failed to save tail data");
    return;
  }
  const map = local.get("fl_tails_"+userId)||{};
  map[`${rosterId}-${flightKey}`]={tail, actualDep, actualArr, actualBlockMins};
  local.set("fl_tails_"+userId, map);
}

async function db_adminUsers() {
  if(isConfigured()) {
    const {data} = await sb.from("profiles").select("*").order("joined", {ascending:false});
    return data||[];
  }
  return (local.get("fl_users")||[
    {id:"u1",email:"admin@flightlog.app",name:"Admin",role:"admin",plan:"admin",joined:"2026-01-01",active:true},
    {id:"u2",email:"pilot@example.com",name:"Mohammed Al Obaidi",role:"pilot",plan:"pro",joined:"2026-05-10",active:true},
  ]).map(u=>({...u}));
}

async function db_adminAllRosters() {
  if(isConfigured()) {
    const {data} = await sb.from("rosters").select("*").order("uploaded_at", {ascending:false});
    return data||[];
  }
  const users = await db_adminUsers();
  return users.flatMap(u=>(local.get("fl_rosters_"+u.id)||[]).map(r=>({...r,user_name:u.name,user_email:u.email})));
}

async function db_adminUpdateUser(userId, updates) {
  if(isConfigured()) { await sb.from("profiles").update(updates,"id=eq."+userId); return; }
  const users=local.get("fl_users")||[];
  const u=users.find(u=>u.id===userId); if(u) Object.assign(u,updates);
  local.set("fl_users",users);
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDING PAGE
// ─────────────────────────────────────────────────────────────────────────────
// Detect if running as installed PWA (standalone mode)
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// APP LANDING PAGE — shown only when running as installed PWA
// Clean, aviation-themed screen with Sign In / Sign Up / Biometric buttons.
// The website landing page (LandingPage below) is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// LOCK SCREEN — shown after 60 minutes of inactivity
// User is still authenticated (token valid), we just need to re-verify
// identity before showing data again. Biometrics first, password fallback.
// ─────────────────────────────────────────────────────────────────────────────
function LockScreen({user, onUnlock}) {
  const [bioLoading, setBioLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const bioAvailable = !!localStorage.getItem("fl_webauthn_registered");
  const savedUserId = localStorage.getItem("fl_webauthn_user_id");

  // Don't auto-trigger on mount — Safari on iOS requires a direct user
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
      setErr("Biometric failed — enter your password instead.");
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
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioLoading, setBioLoading] = useState(false);
  const [bioErr, setBioErr] = useState("");
  const [mode, setMode] = useState(null); // null | "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [airlineIata, setAirlineIata] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const registered = localStorage.getItem("fl_webauthn_registered") === "true";
  const savedUserId = localStorage.getItem("fl_webauthn_user_id");

  useEffect(()=>{ isWebAuthnAvailable().then(setBioAvailable); },[]);

  async function bioSignIn() {
    if(!savedUserId) return;
    setBioLoading(true); setBioErr("");
    try {
      await authenticateWithBiometric(savedUserId);
      const {data:profile} = await sb.from("profiles").select("*").eq("id", savedUserId).single();
      const u = {...(profile||{}), id:savedUserId};
      onAuth(u);
    } catch(e) {
      setBioErr(e.message||"Biometric sign-in failed.");
    } finally { setBioLoading(false); }
  }

  async function submit(e) {
    e?.preventDefault();
    if(!email||!password) { setErr("Email and password required."); return; }
    setErr(""); setLoading(true);
    try {
      if(mode==="login") {
        const {data,error} = await sb.auth.signInWithPassword({email,password});
        if(error||!data?.user) throw new Error(error?.message||"Sign in failed.");
        const {data:profile} = await sb.from("profiles").select("*").eq("id",data.user.id).single();
        onAuth({...data.user,...(profile||{})});
      } else {
        const {data,error} = await sb.auth.signUp({email,password,options:{data:{name,plan:"pro",airline_iata:airlineIata}}});
        if(error) throw new Error(error.message||"Sign up failed.");
        const {data:profile} = await sb.from("profiles").select("*").eq("id",data.user.id).single();
        onAuth({...data.user,...(profile||{})});
      }
    } catch(e) { setErr(e.message||"Authentication failed."); }
    finally { setLoading(false); }
  }

  const showBioButton = bioAvailable && registered && savedUserId;

  return (
    <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(160deg, #060B14 0%, #0D1829 50%, #091220 100%)",padding:"0 24px 48px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse 80% 50% at 50% 0%, #2D8CF015 0%, transparent 70%)"}}/>
      <div style={{paddingTop:56,textAlign:"center",position:"relative",width:"100%"}}>
        <div style={{fontSize:11,letterSpacing:"3px",color:"#2D8CF0",textTransform:"uppercase",fontWeight:600,marginBottom:16,fontFamily:"Inter,sans-serif"}}>Pilot Logbook</div>
        <div style={{fontSize:44,fontWeight:700,color:"#FFFFFF",fontFamily:"Fraunces,serif",letterSpacing:"-1px",lineHeight:1.1}}>Flight<span style={{color:"#2D8CF0"}}>Log</span></div>
        {!mode&&<div style={{fontSize:13,color:"#5A6680",marginTop:10,fontFamily:"Inter,sans-serif"}}>Your hours, automated.</div>}
      </div>
      <div style={{width:"100%",maxWidth:340,position:"relative",flex:1,display:"flex",flexDirection:"column",justifyContent:"center",paddingTop:24}}>
        {!mode&&(<>
          <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:32}}>
            {[["✈","AI reads your PDF roster"],["🔄","Tail numbers sync automatically"],["📊","Analytics & FAR 117 tracking"]].map(([icon,text])=>(
              <div key={text} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 18px",borderRadius:24,background:"rgba(45,140,240,0.07)",border:"1px solid rgba(45,140,240,0.15)"}}>
                <span style={{fontSize:16}}>{icon}</span>
                <span style={{fontSize:13,color:"#A8B4CC",fontFamily:"Inter,sans-serif"}}>{text}</span>
              </div>
            ))}
          </div>
          {showBioButton&&(<div style={{marginBottom:16}}>
            <button onClick={bioSignIn} disabled={bioLoading} style={{width:"100%",padding:"16px",borderRadius:14,background:"linear-gradient(135deg,#2D8CF022,#2D8CF010)",border:"1px solid #2D8CF044",color:"#2D8CF0",fontSize:15,fontWeight:600,fontFamily:"Inter,sans-serif",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              {bioLoading?<span className="spinner">⟳</span>:<>🔒 Sign in with biometrics</>}
            </button>
            {bioErr&&<div style={{fontSize:12,color:"#E05A5A",textAlign:"center",marginTop:8}}>{bioErr}</div>}
            <div style={{textAlign:"center",margin:"12px 0"}}><span style={{fontSize:12,color:"#2A3450"}}>─────  or  ─────</span></div>
          </div>)}
        </>)}
        {mode&&(<div style={{marginBottom:24}}>
          <div style={{fontSize:20,fontWeight:600,color:"#FFFFFF",fontFamily:"Fraunces,serif",marginBottom:20,textAlign:"center"}}>{mode==="login"?"Welcome back":"Create account"}</div>
          {err&&<div style={{fontSize:13,color:"#E05A5A",marginBottom:12,textAlign:"center"}}>{err}</div>}
          <form onSubmit={submit} autoComplete="on" style={{display:"flex",flexDirection:"column",gap:10}}>
            {mode==="signup"&&<input className="form-input" placeholder="Full name" value={name} onChange={e=>setName(e.target.value)} autoComplete="name" style={{background:"#0F1623",color:"#fff",borderColor:"#2A3450"}}/>}
            <input className="form-input" type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" name="email" style={{background:"#0F1623",color:"#fff",borderColor:"#2A3450"}}/>
            <input className="form-input" type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} name="password" style={{background:"#0F1623",color:"#fff",borderColor:"#2A3450"}}/>
            {mode==="signup"&&<input className="form-input" placeholder="Airline IATA (e.g. UA, AA, G7)" value={airlineIata} onChange={e=>setAirlineIata(e.target.value.toUpperCase().slice(0,3))} maxLength={3} style={{background:"#0F1623",color:"#fff",borderColor:"#2A3450"}}/>}
            <button type="submit" disabled={loading} style={{width:"100%",padding:"16px",borderRadius:14,background:"#2D8CF0",border:"none",color:"#FFFFFF",fontSize:16,fontWeight:600,fontFamily:"Inter,sans-serif",cursor:"pointer",marginTop:4,boxShadow:"0 4px 24px #2D8CF040"}}>
              {loading?<span className="spinner">⟳</span>:mode==="login"?"Sign in":"Create account"}
            </button>
          </form>
          <button onClick={()=>{setMode(null);setErr("");}} style={{width:"100%",marginTop:10,background:"none",border:"none",color:"#5A6680",fontSize:13,cursor:"pointer"}}>← Back</button>
        </div>)}
      </div>
      {!mode&&(<div style={{width:"100%",maxWidth:340,position:"relative"}}>
        <button onClick={()=>{setMode("login");setErr("");}} style={{width:"100%",padding:"17px",borderRadius:14,marginBottom:12,background:"#2D8CF0",border:"none",color:"#FFFFFF",fontSize:16,fontWeight:600,fontFamily:"Inter,sans-serif",cursor:"pointer",boxShadow:"0 4px 24px #2D8CF040"}}>Sign in</button>
        <button onClick={()=>{setMode("signup");setErr("");}} style={{width:"100%",padding:"17px",borderRadius:14,background:"transparent",border:"1px solid #2A3450",color:"#A8B4CC",fontSize:16,fontWeight:500,fontFamily:"Inter,sans-serif",cursor:"pointer"}}>Create account</button>
        <div style={{textAlign:"center",marginTop:20,fontSize:11,color:"#2A3450",letterSpacing:".3px"}}>Secure · Encrypted · HTTPS</div>
      </div>)}
    </div>
  );
}


function LandingPage({onLogin, onSignup}) {
  return (
    <div style={{background:C.base,minHeight:"100vh"}}>
      <nav className="lp-nav">
        <div className="lp-logo">Flight<span>Log</span></div>
        <div className="lp-nav-links">
          <button className="lp-nav-link" onClick={()=>document.getElementById("features")?.scrollIntoView({behavior:"smooth"})}>Features</button>
          <button className="lp-nav-link" onClick={()=>document.getElementById("how")?.scrollIntoView({behavior:"smooth"})}>How it works</button>
          <button className="lp-nav-link" onClick={()=>document.getElementById("pricing")?.scrollIntoView({behavior:"smooth"})}>Pricing</button>
        </div>
        <div className="lp-nav-actions">
          <button className="lp-nav-login" onClick={onLogin}>Log in</button>
          <button className="lp-nav-cta" onClick={onSignup}>Sign up</button>
        </div>
      </nav>

      <section className="lp-hero">
        <div className="lp-hero-bg"/>
        <div className="lp-eyebrow"><div className="lp-eyebrow-dot"/>AI-powered · Any airline · Any format</div>
        <h1 className="lp-headline">Your logbook,<br/><em>automated.</em></h1>
        <p className="lp-sub">Upload your monthly PDF roster. FlightLog uses AI to read it, then pulls real-time block times and tail numbers — keeping your hours always current.</p>
        <div className="lp-hero-btns">
          <button className="btn-primary" onClick={onSignup}>Start free →</button>
          <button className="btn-ghost" onClick={()=>document.getElementById("how")?.scrollIntoView({behavior:"smooth"})}>See how it works</button>
        </div>
        <div className="ledger">
          <div className="ledger-line">
            <div className="ledger-ticks">
              {Array.from({length:25}).map((_,i)=>(
                <div key={i} className={`ledger-tick ${i%6===0?"major":""}`}/>
              ))}
            </div>
            <div className="ledger-fill"/>
            <div className="ledger-marker"/>
          </div>
          <div className="ledger-caption"><span>0 HRS</span><span>LOGGED THIS MONTH</span><span>100 HRS</span></div>
        </div>
        <div style={{display:"flex",gap:48,marginTop:40,flexWrap:"wrap",justifyContent:"center"}}>
          {[["PDF upload","Drop your roster, done"],["AI reads it","Any airline format"],["Live data","Tail numbers auto-filled"]].map(([h,s])=>(
            <div key={h} style={{textAlign:"center"}}>
              <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:2}}>{h}</div>
              <div style={{fontSize:12,color:C.muted}}>{s}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="lp-stats">
        {[["12,000+","Pilots using FlightLog"],["98.7%","Parse accuracy"],["40+","Airlines supported"],["< 2s","Average sync time"]].map(([n,l])=>(
          <div className="lp-stat" key={l}><div className="lp-stat-num">{n}</div><div className="lp-stat-lbl">{l}</div></div>
        ))}
      </div>

      <section id="features"><div className="lp-section">
        <div className="lp-section-eyebrow">Features</div>
        <h2 className="lp-section-title">Built for how pilots actually work</h2>
        <p className="lp-section-sub">No manual entry. No spreadsheets. Upload a PDF and FlightLog does the rest.</p>
        <div className="features-grid">
          {[["🤖","AI Roster Parsing","Understands any airline roster format — crew IDs, flight numbers, layover airports, duty times. Upload once, read instantly."],
            ["🛫","Live Tail Numbers","Connects to FlightAware to auto-fill aircraft registrations and actual block times the moment a flight completes."],
            ["📊","Pilot Dashboard","Total hours, legs flown, airports visited, duty days. All current, always accurate."],
            ["📥","CSV Export","Download your complete logbook anytime. Import into Logbook Pro, ForeFlight, or keep it in Excel."],
            ["🔒","Private by Default","Your data stays yours. Each pilot only sees their own logbook."],
            ["👑","Admin Console","Chief pilots and ops managers get a full overview — all pilots, rosters, hours, and subscription status."],
          ].map(([i,t,d])=>(
            <div className="feature-card" key={t}>
              <div className="feature-icon">{i}</div>
              <div className="feature-title">{t}</div>
              <div className="feature-desc">{d}</div>
            </div>
          ))}
        </div>
      </div></section>

      <section id="how" style={{borderTop:`1px solid ${C.border}`}}><div className="lp-section">
        <div className="lp-section-eyebrow">How it works</div>
        <h2 className="lp-section-title">Three steps to a complete logbook</h2>
        <div className="how-grid">
          {[["Upload","Drop your monthly roster PDF — any airline, any format. AI extracts every flight leg automatically."],
            ["Verify","Review the extracted flights. One click auto-fetches tail numbers and block times from live aviation data."],
            ["Done","Logbook updated. Download as CSV, check your totals, and get back to flying."],
          ].map(([t,d],i)=>(
            <div className="how-step" key={t}>
              <div className="how-num">0{i+1}</div>
              <div className="how-title">{t}</div>
              <div className="how-desc">{d}</div>
            </div>
          ))}
        </div>
      </div></section>

      <section id="pricing" style={{borderTop:`1px solid ${C.border}`}}><div className="lp-section">
        <div className="lp-section-eyebrow">Pricing</div>
        <h2 className="lp-section-title">Simple, honest pricing</h2>
        <p className="lp-section-sub">Start free. Upgrade for live data and unlimited history.</p>
        <div className="pricing-grid">
          <div className="price-card">
            <div className="price-plan">Starter</div>
            <div><span className="price-amount">$0</span><span className="price-period">/mo</span></div>
            <div className="price-desc">For pilots just getting started.</div>
            <ul className="price-features"><li>1 roster/month</li><li>Manual tail entry</li><li>CSV export</li><li>30-day history</li></ul>
            <button className="price-cta price-cta-ghost" onClick={onSignup}>Get started free</button>
          </div>
          <div className="price-card featured">
            <div className="price-badge">MOST POPULAR</div>
            <div className="price-plan">Pro</div>
            <div><span className="price-amount">$9</span><span className="price-period">/mo</span></div>
            <div className="price-desc">Fully automated logbook.</div>
            <ul className="price-features"><li>Unlimited rosters</li><li>AI parsing</li><li>Live tail # &amp; block time lookup</li><li>Full history</li><li>CSV export</li></ul>
            <button className="price-cta price-cta-primary" onClick={onSignup}>Start Pro trial</button>
          </div>
          <div className="price-card">
            <div className="price-plan">Enterprise</div>
            <div><span className="price-amount">$29</span><span className="price-period">/mo</span></div>
            <div className="price-desc">For chief pilots and ops teams.</div>
            <ul className="price-features"><li>Everything in Pro</li><li>Admin console</li><li>Team roster management</li><li>API access</li><li>Priority support</li></ul>
            <button className="price-cta price-cta-ghost" onClick={onSignup}>Contact sales</button>
          </div>
        </div>
      </div></section>

      <footer className="lp-footer">
        <div style={{fontFamily:FD,fontSize:18,fontWeight:500,fontStyle:"italic",color:C.ink}}>Flight<span style={{color:C.red,fontStyle:"normal",fontWeight:700}}>Log</span></div>
        <div style={{display:"flex",gap:24}}>
          {["Privacy","Terms","Support"].map(l=><span key={l} style={{fontSize:13,color:C.muted,cursor:"pointer"}}>{l}</span>)}
        </div>
        <div className="lp-footer-copy">© 2026 FlightLog. All rights reserved.</div>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH PAGE
// ─────────────────────────────────────────────────────────────────────────────
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
        // Offer to save credentials for future biometric login
        if(savePassword && navigator.credentials && window.PasswordCredential) {
          try {
            const cred = new window.PasswordCredential({id:email, password, name:user.name||email});
            await navigator.credentials.store(cred);
          } catch {}
        }
        onAuth(user);
      } else {
        if(!name||!email||!password) throw new Error("All fields required.");
        const user = await db_signUp(email,password,name,plan,airlineIata,airlineName);
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

        {/* Biometric quick sign-in — shown when saved credentials exist */}
        {mode==="login" && savedCred && (
          <div style={{marginBottom:16,padding:"14px 16px",background:C.panel,borderRadius:10,border:`1px solid ${C.border}`}}>
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
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <button type="button"
              onClick={()=>setSavePassword(p=>!p)}
              style={{
                width:36,height:20,borderRadius:10,border:"none",cursor:"pointer",
                background:savePassword?C.teal:C.border,position:"relative",transition:"background .2s",flexShrink:0,
              }}>
              <span style={{position:"absolute",top:2,left:savePassword?18:2,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
            </button>
            <span style={{fontSize:12,color:C.muted}}>Save password for biometric sign-in</span>
          </div>
        )}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Plan</label>
            <select className="form-select" value={plan} onChange={e=>setPlan(e.target.value)}>
              <option value="starter">Starter — Free</option>
              <option value="pro">Pro — $9/mo</option>
            </select>
          </div>
        )}
        <button type="submit" className="btn-full" disabled={loading}>
          {loading ? <span className="spinner">⟳</span> : mode==="login"?"Log in":"Create account"}
        </button>
        </form>
        <button className="auth-back" onClick={onBack}>← Back to home</button>
        {!configured && mode==="login" && (
          <div style={{marginTop:16,padding:"10px 14px",background:C.panel,borderRadius:8,fontSize:12,color:C.muted}}>
            <div style={{marginBottom:4,color:C.silver,fontWeight:600}}>Demo accounts</div>
            <div>Admin: admin@flightlog.app / admin1234</div>
            <div>Pilot: pilot@example.com / pilot123</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// HAMBURGER DRAWER — replaces the bottom tab bar on mobile
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
function Dashboard({user,rosters,tails,setPage,onOpenFlight}) {
  const flights=allFlights(rosters);
  const totalMins=totalMinsBest(rosters, tails);
  const airports=new Set(flights.flatMap(f=>[f.dep,f.arr]));
  const tailLogged=Object.values(tails).filter(t=>t?.tail).length;
  const dutyDays=rosters.reduce((a,r)=>a+(r.calendar?.filter(d=>d.flights.length>0).length||0),0);
  const recent=[...flights].reverse().slice(0,5);
  let flownCount=0;
  rosters.forEach(r=>(r.calendar||[]).forEach((d,di)=>d.flights.forEach((f,fi)=>{
    if(tails[`${r.id}-${di}-${fi}`]?.actualBlockMins!=null) flownCount++;
  })));

  // Find next upcoming flight
  const [now, setNow] = useState(()=>new Date());
  useEffect(()=>{
    const interval = setInterval(()=>setNow(new Date()), 60000);
    return ()=>clearInterval(interval);
  },[]);

  const nextFlight = useMemo(()=>{
    let nearest = null;
    let nearestDt = null;
    for(const roster of rosters) {
      for(let di=0; di<(roster.calendar||[]).length; di++) {
        const day = roster.calendar[di];
        for(let fi=0; fi<(day.flights||[]).length; fi++) {
          const f = day.flights[fi];
          const tk = `${roster.id}-${di}-${fi}`;
          const tail = tails[tk]||{};
          if(tail.cancelled||tail.actualBlockMins!=null) continue;
          const [h,m] = (f.depTime||"00:00").split(":").map(Number);
          const flightDt = new Date(roster.year, (roster.monthNum||0), day.day, h, m);
          if(flightDt > now && (!nearestDt || flightDt < nearestDt)) {
            nearest = { f, day, roster, di, fi, flightDt };
            nearestDt = flightDt;
          }
        }
      }
    }
    return nearest;
  },[rosters, tails, now]);

  function countdown(dt) {
    const diffMs = dt - now;
    if(diffMs <= 0) return "Departing now";
    const totalMins = Math.floor(diffMs / 60000);
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if(hrs > 24) return `${Math.floor(hrs/24)}d ${hrs%24}h away`;
    if(hrs > 0) return `${hrs}h ${mins}m away`;
    return `${mins}m away`;
  }

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div className="section-title">Welcome back, {user.name?.split(" ")[0]} ✈</div>
        <div className="section-sub">{new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</div>
      </div>

      {/* Next flight card — click opens flight detail */}
      {nextFlight&&(
        <div onClick={()=>{
          const {f,day,roster:r,di,fi} = nextFlight;
          const tk=`${r.id}-${di}-${fi}`;
          const tail=tails[tk]||{};
          const dateStr=`${r.year}-${String((r.monthNum||0)+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
          const solar=computeNightTime(dateStr,f.dep,f.arr,tail.actualDep||f.depTime,tail.actualArr||f.arrTime);
          const dist=airportDistanceNM(f.dep,f.arr);
          const blockMins=tail.actualBlockMins??schedMins(f)??0;
          onOpenFlight({
            rosterId:r.id, year:r.year, monthNum:r.monthNum,
            selectedFlight:{di,fi,f,tail,tk,solar,dist,blockMins,day,
              hasActual:!!(tail.actualDep&&tail.actualArr),
              dep:tail.actualDep||f.depTime, arr:tail.actualArr||f.arrTime,
              isXC:(dist||0)>50},
          });
        }} style={{
          marginBottom:20,padding:"14px 18px",borderRadius:14,
          background:`linear-gradient(135deg,${C.teal}18,${C.teal}08)`,
          border:`1px solid ${C.teal}44`,cursor:"pointer",
          display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",
          transition:"border-color .15s",
        }}>
          <div style={{fontSize:24}}>✈</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:10,color:C.teal,fontWeight:700,letterSpacing:"1px",textTransform:"uppercase",marginBottom:3}}>Next Flight · tap to view</div>
            <div style={{fontSize:17,fontWeight:700,color:C.ink}}>
              {nextFlight.f.flightNum} · <b>{nextFlight.f.dep}</b> → <b>{nextFlight.f.arr}</b>
            </div>
            <div style={{fontSize:11,color:C.silver,marginTop:2}}>
              {nextFlight.day.dow} {String(nextFlight.day.day).padStart(2,"0")} · Dep {nextFlight.f.depTime} · {nextFlight.f.acType}
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0}}>
            <div style={{fontSize:18,fontWeight:700,color:C.teal}}>{countdown(nextFlight.flightDt)}</div>
            <div style={{fontSize:10,color:C.muted}}>{airportDistanceNM(nextFlight.f.dep,nextFlight.f.arr)||"—"} NM</div>
          </div>
        </div>
      )}
      <div className="dash-grid">
        {[
          {label:"Total flight time",val:fmtMins(totalMins),sub:flownCount===flights.length&&flights.length>0?"all flown (actual)":`${flownCount} flown · ${flights.length-flownCount} scheduled`},
          {label:"Total legs",val:flights.length,sub:"flight segments"},
          {label:"Airports",val:airports.size,sub:"unique airports"},
          {label:"Tail #s logged",val:tailLogged,sub:`of ${flights.length} flights`},
          {label:"Duty days",val:dutyDays,sub:"scheduled"},
        ].map(s=>(
          <div className="stat-card" key={s.label}>
            <div className="stat-card-label">{s.label}</div>
            <div className="stat-card-val">{s.val}</div>
            <div className="stat-card-sub">{s.sub}</div>
          </div>
        ))}
      </div>
      <div className="dash-2col">
        <div className="dash-panel">
          <div className="dash-panel-title">Recent flights</div>
          {recent.length===0
            ? <div style={{color:C.muted,fontSize:13}}>No flights yet. <button onClick={()=>setPage("upload")} style={{background:"none",border:"none",color:C.teal,cursor:"pointer",fontSize:13}}>Upload a roster →</button></div>
            : recent.map((f,i)=>{
              const t=tails[`${f.rosterId}-${f.date}-${i}`];
              return (
                <div className="recent-flight" key={i}>
                  <div className="rf-num">{f.flightNum}</div>
                  <div className="rf-route">{f.dep} → {f.arr}</div>
                  <div className="rf-time">{schedMins(f)!=null?fmtMins(schedMins(f)):"—"}</div>
                  {t?.tail&&<div className="rf-tail">{t.tail}</div>}
                </div>
              );
            })
          }
        </div>
        <div className="dash-panel">
          <div className="dash-panel-title">Quick actions</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <button className="btn-orange" style={{padding:"14px 16px",borderRadius:10,textAlign:"left"}} onClick={()=>setPage("upload")}>↑ Upload new roster</button>
            <button className="btn-teal" style={{padding:"14px 16px",borderRadius:10,textAlign:"left"}} onClick={()=>setPage("logbook")}>📋 Open logbook</button>
            <button className="btn-sm-ghost" style={{padding:"14px 16px",borderRadius:10,textAlign:"left",fontSize:14}} onClick={()=>setPage("calendar")}>📅 View calendar</button>
          </div>
          {rosters.length>0&&(
            <div style={{marginTop:16}}>
              <div style={{fontSize:12,color:C.muted,marginBottom:8}}>Loaded rosters</div>
              {rosters.map(r=>(
                <div key={r.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <span className="tag">{r.periodLabel}</span>
                  <span style={{fontSize:11,color:C.muted,marginLeft:"auto"}}>{r.calendar?.filter(d=>d.flights.length>0).length} duty days</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD PAGE
// ─────────────────────────────────────────────────────────────────────────────
function UploadPage({user, onRosterSaved}) {
  const [status,setStatus]=useState(null); // null | "loading" | "review" | "error"
  const [msg,setMsg]=useState("");
  const [drag,setDrag]=useState(false);
  const [fileName,setFileName]=useState("");
  const [corrections,setCorrections]=useState([]);
  const [verified,setVerified]=useState(false);
  const [reviewRoster,setReviewRoster]=useState(null);
  const [expandedReviewDays,setExpandedReviewDays]=useState({});
  const [savedFlag,setSavedFlag]=useState(false);
  const [loadingPhase,setLoadingPhase]=useState(0);
  const phaseTimerRef=useRef(null);
  const fileRef=useRef();

  // Cycle through loading phase messages while parsing
  const LOADING_PHASES=[
    "Reading your roster",
    "Preparing and analyzing",
    "Verifying data",
    "Almost there",
  ];

  function startPhaseTimer() {
    setLoadingPhase(0);
    // Advance through phases on a schedule that feels natural for ~25s parse
    // Phase 0 → 1 at 5s, 1 → 2 at 12s, 2 → 3 at 20s
    const timings=[5000,7000,8000];
    let phase=0;
    function advance() {
      phase++;
      setLoadingPhase(phase);
      if(phase < timings.length && timings[phase]) {
        phaseTimerRef.current=setTimeout(advance, timings[phase]);
      }
    }
    phaseTimerRef.current=setTimeout(advance, timings[0]);
  }

  function stopPhaseTimer() {
    if(phaseTimerRef.current) {
      clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current=null;
    }
  }

  async function handleFile(file) {
    if(!file) return;
    if(!file.name.toLowerCase().endsWith(".pdf")&&file.type!=="application/pdf") {
      setStatus("error"); setMsg("Please upload a PDF file."); return;
    }
    setFileName(file.name); setCorrections([]); setSavedFlag(false); setStatus("loading"); setMsg("");
    startPhaseTimer();
    try {
      const base64 = await fileToBase64(file);
      const roster = await aiParseRosterPdf(base64);
      if(!roster.calendar?.some(d=>d.flights.length>0||d.dutyCode)) throw new Error("No flights found. Is this a crew duty roster?");
      const correctionList = Array.isArray(roster._corrections) ? roster._corrections : [];
      const wasVerified = !!roster._verified;
      delete roster._corrections;
      delete roster._verified;
      setCorrections(correctionList);
      setVerified(wasVerified);
      setReviewRoster(roster);
      stopPhaseTimer();
      setStatus("review");
      setMsg("");
    } catch(e) {
      stopPhaseTimer();
      setStatus("error"); setMsg(e.message||"Parse failed.");
    }
  }

  function updateReviewFlight(di, fi, field, value) {
    setReviewRoster(prev => {
      const calendar = [...prev.calendar];
      const flights = [...calendar[di].flights];
      flights[fi] = { ...flights[fi], [field]: value };
      calendar[di] = { ...calendar[di], flights };
      return { ...prev, calendar };
    });
  }

  function updateReviewDutyCode(di, value) {
    setReviewRoster(prev => {
      const calendar = [...prev.calendar];
      calendar[di] = { ...calendar[di], dutyCode: value || null };
      return { ...prev, calendar };
    });
  }

  function removeReviewFlight(di, fi) {
    setReviewRoster(prev => {
      const calendar = [...prev.calendar];
      const flights = calendar[di].flights.filter((_, i) => i !== fi);
      calendar[di] = { ...calendar[di], flights, isOff: flights.length===0 };
      return { ...prev, calendar };
    });
  }

  function markDayOff(di) {
    if(!window.confirm("Mark this entire day as off and remove its flights?")) return;
    setReviewRoster(prev => {
      const calendar = [...prev.calendar];
      calendar[di] = { ...calendar[di], flights: [], isOff: true, dutyCode: null };
      return { ...prev, calendar };
    });
  }

  function discardReview() {
    setReviewRoster(null);
    setStatus(null);
    setMsg("");
    setCorrections([]);
  }

  async function confirmAndSave() {
    if(!reviewRoster) return;
    setStatus("loading"); setMsg("Saving your reviewed roster…");
    try {
      const saved = await db_saveRoster(user.id, reviewRoster);
      const dutyDays = reviewRoster.calendar.filter(d=>d.flights.length>0||d.dutyCode).length;
      setStatus("success");
      setSavedFlag(true);
      setMsg(`✓ Saved ${dutyDays} duty days for ${reviewRoster.periodLabel}`);
      onRosterSaved(saved);
      setReviewRoster(null);
    } catch(e) { setStatus("error"); setMsg(e.message||"Save failed."); }
  }

  const busy = status==="loading";
  const reviewing = status==="review" && reviewRoster;

  // ── Review screen ──────────────────────────────────────────────────────────
  if (reviewing) {
    const dutyDays = reviewRoster.calendar.filter(d=>d.flights.length>0||d.dutyCode);
    return (
      <div>
        <div className="section-title">Review before saving</div>
        <div className="section-sub">Check every flight against your roster PDF. Edit anything that looks wrong, then confirm to save.</div>

        {corrections.length>0 && (
          <div className="notice" style={{marginBottom:16}}>
            <div style={{fontWeight:600,marginBottom:6}}>🔍 AI verification already caught and fixed {corrections.length} issue{corrections.length!==1?"s":""}:</div>
            <ul style={{margin:0,paddingLeft:18,display:"flex",flexDirection:"column",gap:3}}>
              {corrections.map((c,i)=><li key={i} style={{fontSize:12}}>{c}</li>)}
            </ul>
          </div>
        )}
        {!verified && (
          <div className="warn" style={{marginBottom:16}}>⚠ Verification pass didn't complete for this upload — review carefully, this data hasn't been double-checked.</div>
        )}

        <div className="card" style={{marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:600,color:C.ink}}>Detected period</div>
            <div style={{fontSize:12,color:C.muted}}>{dutyDays.length} duty days · {dutyDays.reduce((a,d)=>a+d.flights.length,0)} flights</div>
          </div>
          {/* Editable month/year — pilot can correct if AI got it wrong */}
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <select
              value={reviewRoster.monthNum}
              onChange={e=>{
                const m=parseInt(e.target.value);
                const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                setReviewRoster(r=>({...r, monthNum:m, periodLabel:`${months[m]} ${r.year}`}));
              }}
              style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:C.panel,color:C.ink,fontSize:13,flex:1}}>
              {["January","February","March","April","May","June","July","August","September","October","November","December"].map((name,i)=>(
                <option key={i} value={i}>{name}</option>
              ))}
            </select>
            <input
              type="number"
              value={reviewRoster.year}
              onChange={e=>setReviewRoster(r=>({...r, year:parseInt(e.target.value)||r.year}))}
              style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${C.border}`,background:C.panel,color:C.ink,fontSize:13,width:80}}
            />
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:6}}>
            ⚠ Check this matches your roster period before confirming — correct it if needed.
          </div>
        </div>

        {reviewRoster.calendar.map((d, di) => (d.flights.length>0 || d.dutyCode) && (
          <div key={di} className="card" style={{marginBottom:10,padding:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={()=>setExpandedReviewDays(p=>({...p,[di]:!p[di]}))}>
              <div style={{fontFamily:FM,fontSize:13,color:C.red,fontWeight:600}}>{d.dow} {String(d.day).padStart(2,"0")}</div>
              <div style={{fontSize:12,color:C.silver,flex:1}}>
                {d.flights.length>0 ? d.flights.map(f=>`${f.dep}→${f.arr}`).join(" · ") : <span style={{color:C.gold,fontWeight:600}}>{d.dutyCode}</span>}
              </div>
              <button className="btn-sm-ghost" style={{fontSize:11}} onClick={(e)=>{e.stopPropagation();markDayOff(di);}}>Mark day off</button>
              <span style={{color:C.muted,fontSize:11}}>{expandedReviewDays[di]?"▲":"▼"}</span>
            </div>
            {expandedReviewDays[di] && (
            <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:12}}>
              {d.flights.length===0 && (
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:12,color:C.muted}}>Duty code:</span>
                  <input className="form-input" style={{width:100,padding:"6px 8px",fontSize:12,textTransform:"uppercase"}} value={d.dutyCode||""}
                    onChange={e=>updateReviewDutyCode(di,e.target.value.toUpperCase())} placeholder="e.g. TVL, SIM"/>
                </div>
              )}
              {d.flights.map((f, fi) => (
                <div key={fi} style={{background:C.panel,borderRadius:8,padding:10,display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                  <input className="form-input" style={{width:110,padding:"6px 8px",fontSize:12}} value={f.flightNum}
                    onChange={e=>updateReviewFlight(di,fi,"flightNum",e.target.value)}/>
                  <input className="form-input" style={{width:54,padding:"6px 8px",fontSize:12,textTransform:"uppercase"}} value={f.dep} maxLength={4}
                    onChange={e=>updateReviewFlight(di,fi,"dep",e.target.value.toUpperCase())}/>
                  <span style={{color:C.muted}}>→</span>
                  <input className="form-input" style={{width:54,padding:"6px 8px",fontSize:12,textTransform:"uppercase"}} value={f.arr} maxLength={4}
                    onChange={e=>updateReviewFlight(di,fi,"arr",e.target.value.toUpperCase())}/>
                  <input className="form-input" style={{width:70,padding:"6px 8px",fontSize:12,fontFamily:FM}} value={f.depTime} placeholder="HH:MM"
                    onChange={e=>updateReviewFlight(di,fi,"depTime",e.target.value)}/>
                  <span style={{color:C.muted}}>–</span>
                  <input className="form-input" style={{width:70,padding:"6px 8px",fontSize:12,fontFamily:FM}} value={f.arrTime} placeholder="HH:MM"
                    onChange={e=>updateReviewFlight(di,fi,"arrTime",e.target.value)}/>
                  <input className="form-input" style={{width:54,padding:"6px 8px",fontSize:12,textTransform:"uppercase"}} value={f.acType} maxLength={4}
                    onChange={e=>updateReviewFlight(di,fi,"acType",e.target.value.toUpperCase())}/>
                  <button className="btn-sm-ghost" style={{marginLeft:"auto",color:C.red,borderColor:C.red+"44",fontSize:11}} onClick={()=>removeReviewFlight(di,fi)}>🗑</button>
                </div>
              ))}
            </div>
            )}
          </div>
        ))}

        {status==="loading" && (
          <div className="parse-status loading" style={{marginBottom:16}}><span className="spinner">⟳</span>{msg}</div>
        )}

        <div style={{display:"flex",gap:10,position:"sticky",bottom:16,marginTop:20}}>
          <button className="btn-orange" style={{flex:1}} onClick={confirmAndSave} disabled={busy}>
            {busy ? <span className="spinner">⟳</span> : "✓ Confirm & save roster"}
          </button>
          <button className="btn-sm-ghost" onClick={discardReview} disabled={busy}>Discard</button>
        </div>
      </div>
    );
  }

  // ── Upload screen ──────────────────────────────────────────────────────────
  return (
    <div>
      <div className="section-title">Upload Roster</div>
      <div className="section-sub">Upload your PDF roster — AI reads any airline format, then lets you review before saving.</div>
      <div className="card" style={{marginBottom:16}}>
        <div
          className={`upload-zone ${drag?"drag":""}`}
          onDragOver={e=>{e.preventDefault();setDrag(true)}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);handleFile(e.dataTransfer.files[0])}}
          onClick={()=>!busy&&fileRef.current.click()}
        >
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          {busy ? (
            <div style={{width:"100%",padding:"32px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:20}}>
              {/* Phase label */}
              <div style={{fontSize:22,fontWeight:600,color:C.ink,letterSpacing:"-.3px",minHeight:32,textAlign:"center"}}>
                {LOADING_PHASES[Math.min(loadingPhase,LOADING_PHASES.length-1)]}
              </div>
              {/* Animated green dash track */}
              <div style={{width:"100%",maxWidth:340,height:4,background:C.border,borderRadius:4,overflow:"hidden",position:"relative"}}>
                <div style={{
                  position:"absolute",top:0,left:0,height:"100%",
                  background:`linear-gradient(90deg,#34C97A,#2D8CF0)`,
                  borderRadius:4,
                  // Width grows with phase — 20% → 45% → 70% → 92%
                  width:["20%","45%","70%","92%"][Math.min(loadingPhase,3)],
                  transition:"width 1.2s cubic-bezier(.4,0,.2,1)",
                }}/>
                {/* Shimmer sweep */}
                <div style={{
                  position:"absolute",top:0,left:0,height:"100%",width:"40%",
                  background:"linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent)",
                  animation:"shimmer 1.4s ease-in-out infinite",
                  borderRadius:4,
                }}/>
              </div>
              {/* Percentage */}
              <div style={{fontFamily:FM,fontSize:13,color:C.teal,letterSpacing:".5px"}}>
                {["20%","45%","70%","92%"][Math.min(loadingPhase,3)]}
              </div>
              {/* File name */}
              <div style={{fontSize:12,color:C.muted,marginTop:-8}}>{fileName}</div>
            </div>
          ) : savedFlag ? (
            <><span className="upload-icon" style={{color:C.teal}}>✓</span>
              <h3 style={{color:C.ink}}>Roster saved to your account</h3>
              <p style={{marginTop:6}}>{fileName}</p>
              <p style={{color:C.teal,marginTop:8,fontSize:13}}>Drop another PDF to add more</p></>
          ) : (
            <><span className="upload-icon" style={{opacity:.5}}>📄</span>
              <h3>Drop your PDF roster here</h3>
              <p style={{marginBottom:24}}>or click to browse</p>
              <div style={{background:C.ink,color:C.base,padding:"11px 28px",borderRadius:8,fontSize:14,fontWeight:500,display:"inline-block",pointerEvents:"none",letterSpacing:".2px"}}>
                Choose PDF file
              </div></>
          )}
        </div>
        {status&&status!=="loading"&&status!=="review"&&(
          <div className={`parse-status ${status}`}>{msg}</div>
        )}
      </div>
      <div className="upload-info-panel">
        <div className="upload-info-row">
          <div className="upload-info-icon">📝</div>
          <div>
            <div className="upload-info-title">Review before saving</div>
            <div className="upload-info-desc">Every flight is shown for your approval first. Edit anything that looks wrong, right next to the original data.</div>
          </div>
        </div>
        <div className="upload-info-row">
          <div className="upload-info-icon">⚡</div>
          <div>
            <div className="upload-info-title">Tail numbers sync automatically</div>
            <div className="upload-info-desc">Filled in shortly after each flight lands — no setup needed. Tap 🔍 on any flight for an instant lookup.</div>
          </div>
        </div>
        <div className="upload-info-row">
          <div className="upload-info-icon">🌐</div>
          <div>
            <div className="upload-info-title">Block time, handled correctly</div>
            <div className="upload-info-desc">Scheduled duration uses what's printed in your roster. Estimated figures are marked with *. Actual block time is always timezone-correct.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
function CalendarPage({user, rosters, tails, onRosterUpdated, onOpenFlight}) {
  const [selRoster,setSelRoster]=useState(()=>defaultRosterIndex(rosters));
  const [selDay,setSelDay]=useState(null);
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
  const [saving,setSaving]=useState(false);

  const roster=rosters[selRoster];

  if(!roster) return (
    <div><div className="section-title">Calendar</div>
      <div className="empty-state"><div className="empty-icon">📅</div>No rosters yet.</div></div>
  );

  const year=roster.year, monthNum=roster.monthNum;
  const firstOfMonth=new Date(year,monthNum,1);
  const startWeekday=firstOfMonth.getDay(); // 0=Sun
  const daysInMonth=new Date(year,monthNum+1,0).getDate();
  const monthName=new Date(year,monthNum,1).toLocaleString("default",{month:"long"});

  const today=new Date();
  const isCurrentMonth=today.getFullYear()===year && today.getMonth()===monthNum;

  // Build a lookup: day number -> {dayData, dayIndex}
  const dayMap={};
  (roster.calendar||[]).forEach((d,di)=>{ dayMap[d.day]={d,di}; });

  // Leading blank cells so day 1 lands in the correct weekday column
  const leadingBlanks=Array.from({length:startWeekday});
  const dayCells=Array.from({length:daysInMonth},(_,i)=>i+1);

  function dayStatus(d,di){
    if(!d || d.flights.length===0) return d?.dutyCode ? "duty" : "off";
    const allFlown=d.flights.every((_,fi)=>tails[`${roster.id}-${di}-${fi}`]?.actualBlockMins!=null);
    if(allFlown) return "flown";
    return "scheduled";
  }

  const selected = selDay!=null ? dayMap[selDay] : null;

  function resetForm() {
    setForm({flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
    setAdding(false);
  }

  async function saveNewFlight() {
    const fn=form.flightNum.trim(), dep=form.dep.trim().toUpperCase(), arr=form.arr.trim().toUpperCase();
    const depTime=form.depTime.trim(), arrTime=form.arrTime.trim();
    if(!fn||!dep||!arr||!depTime||!arrTime) { alert("Flight #, dep, arr, and both times are required."); return; }
    if(!/^\d{2}:\d{2}$/.test(depTime)||!/^\d{2}:\d{2}$/.test(arrTime)) { alert("Times must be in HH:MM format."); return; }

    setSaving(true);
    const newCalendar=[...roster.calendar];
    const newFlight={flightNum:fn,dep,arr,depTime,arrTime,acType:form.acType.trim().toUpperCase()||"—",schedBlockMins:null};

    if(selected){
      // Day already exists in the calendar — append to it
      const di=selected.di;
      newCalendar[di]={...newCalendar[di],isOff:false,flights:[...newCalendar[di].flights,newFlight]};
    } else {
      // Day not present yet — shouldn't normally happen since every day 1..N
      // is pre-populated by the parser, but handle defensively just in case.
      const dow=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(year,monthNum,selDay).getDay()];
      newCalendar.push({day:selDay,dow,isOff:false,flights:[newFlight]});
      newCalendar.sort((a,b)=>a.day-b.day);
    }

    try {
      await db_updateRosterCalendar(user.id, roster.id, newCalendar);
      onRosterUpdated(roster.id, newCalendar);
      resetForm();
    } catch(e) {
      alert(e.message||"Failed to save flight.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteFlight(fi) {
    if(!selected) return;
    if(!window.confirm("Remove this flight?")) return;
    const di=selected.di;
    const newCalendar=[...roster.calendar];
    const remainingFlights=newCalendar[di].flights.filter((_,i)=>i!==fi);
    newCalendar[di]={...newCalendar[di],flights:remainingFlights,isOff:remainingFlights.length===0};
    try {
      await db_updateRosterCalendar(user.id, roster.id, newCalendar);
      onRosterUpdated(roster.id, newCalendar);
    } catch(e) {
      alert(e.message||"Failed to remove flight.");
    }
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <div className="section-title" style={{marginBottom:0}}>Calendar</div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          {rosters.map((r,i)=>(
            <button key={r.id} className={`month-tab ${selRoster===i?"active":""}`} onClick={()=>{setSelRoster(i);setSelDay(null);resetForm();}}>
              {r.periodLabel}
            </button>
          ))}
        </div>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div className="cal-month-title">{monthName} {year}</div>
        <div className="cal-legend">
          <span className="cal-legend-item"><span className="cal-dot flown"/>Flown</span>
          <span className="cal-legend-item"><span className="cal-dot scheduled"/>Scheduled</span>
          <span className="cal-legend-item"><span className="cal-dot duty"/>Duty</span>
          <span className="cal-legend-item"><span className="cal-dot off"/>Off</span>
        </div>
      </div>

      <div className="cal-grid">
        {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(w=>(
          <div key={w} className="cal-weekday">{w}</div>
        ))}
        {leadingBlanks.map((_,i)=><div key={"b"+i} className="cal-cell cal-cell-blank"/>)}
        {dayCells.map(day=>{
          const entry=dayMap[day];
          const status=dayStatus(entry?.d, entry?.di);
          const isToday=isCurrentMonth && today.getDate()===day;
          const isSelected=selDay===day;
          const flights=entry?.d?.flights||[];
          return (
            <div
              key={day}
              className={`cal-cell ${status} ${isToday?"today":""} ${isSelected?"selected":""}`}
              onClick={()=>{setSelDay(isSelected?null:day);resetForm();}}
            >
              <div className="cal-cell-day">{day}</div>
              {status!=="off"&&status!=="blank"&&<div className="cal-cell-dot"/>}
              {flights.length>0 && (
                <div className="cal-cell-route">
                  {flights.length===1
                    ? `${flights[0].dep}–${flights[0].arr}`
                    : `${flights[0].dep}…${flights[flights.length-1].arr}`}
                </div>
              )}
              {flights.length===0 && entry?.d?.dutyCode && (
                <div className="cal-cell-route" style={{color:C.gold,fontWeight:600}}>{entry.d.dutyCode}</div>
              )}
              {flights.length>0 && <div className="cal-cell-legs">{flights.length} leg{flights.length!==1?"s":""}</div>}
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="cal-detail">
          <div className="cal-detail-header">
            <div className="cal-detail-title">{selected.d.dow} {monthName} {selDay}</div>
            <button className="cal-detail-close" onClick={()=>{setSelDay(null);resetForm();}}>✕</button>
          </div>
          {selected.d.flights.length===0 ? (
            selected.d.dutyCode
              ? <div className="cal-detail-off" style={{color:C.gold,fontWeight:600,fontStyle:"normal"}}>{selected.d.dutyCode} — non-flying duty day.</div>
              : <div className="cal-detail-off">Off day — no scheduled flights.</div>
          ) : (
            <div className="cal-detail-flights">
              {selected.d.flights.map((f,fi)=>{
                const tk=`${roster.id}-${selected.di}-${fi}`;
                const entry=tails[tk]||{};
                const isFlown=entry.actualBlockMins!=null;
                const mins=isFlown?entry.actualBlockMins:schedMins(f);
                return (
                  <div className="cal-detail-flight" key={fi} onClick={()=>{
                    if(onOpenFlight) {
                      const day2={day:selDay,dow:selected.d.dow,flights:selected.d.flights};
                      const tk=`${roster.id}-${selected.di}-${fi}`;
                      const tail2=tails[tk]||{};
                      const monthNum=roster.monthNum??roster.month_num??0;
                      const dateStr=`${roster.year}-${String(monthNum+1).padStart(2,"0")}-${String(selDay).padStart(2,"0")}`;
                      const solar=computeNightTime(dateStr,f.dep,f.arr,tail2.actualDep||f.depTime,tail2.actualArr||f.arrTime);
                      const dist=airportDistanceNM(f.dep,f.arr);
                      const blockMins=tail2.actualBlockMins??schedMins(f)??0;
                      const hasActual=!!(tail2.actualDep&&tail2.actualArr);
                      onOpenFlight({rosterId:roster.id,year:roster.year,monthNum,selectedFlight:{
                        di:selected.di,fi,f,tail:tail2,tk,solar,dist,blockMins,day:day2,hasActual,
                        dep:hasActual?tail2.actualDep:f.depTime,arr:hasActual?tail2.actualArr:f.arrTime,isXC:(dist||0)>50,
                      }});
                    }
                  }} style={{cursor:onOpenFlight?"pointer":"default"}}>
                    <div className="cal-detail-flight-num">{f.flightNum}</div>
                    <div className="cal-detail-flight-route">{f.dep} → {f.arr}</div>
                    <div className="cal-detail-flight-time">{isFlown?`${entry.actualDep}–${entry.actualArr}`:`${f.depTime}–${f.arrTime}`}</div>
                    <div className="cal-detail-flight-block" style={{color:isFlown?C.teal:C.muted}}>{mins!=null?fmtMins(mins):"—"}{isFlown||mins==null?"":"*"}</div>
                    {entry.tail && <div className="cal-detail-flight-tail">{entry.tail}</div>}
                    <button className="cal-detail-flight-del" onClick={()=>deleteFlight(fi)} title="Remove flight">✕</button>
                  </div>
                );
              })}
            </div>
          )}

          {!adding ? (
            <button className="btn-sm-ghost" style={{marginTop:14}} onClick={()=>setAdding(true)}>+ Add flight</button>
          ) : (
            <div className="cal-add-form">
              <div className="cal-add-row">
                <input className="form-input" placeholder="Flight # (e.g. G7 4488)" value={form.flightNum} onChange={e=>setForm(p=>({...p,flightNum:e.target.value}))}/>
                <input className="form-input cal-add-narrow" placeholder="Dep" value={form.dep} onChange={e=>setForm(p=>({...p,dep:e.target.value}))} maxLength={4}/>
                <input className="form-input cal-add-narrow" placeholder="Arr" value={form.arr} onChange={e=>setForm(p=>({...p,arr:e.target.value}))} maxLength={4}/>
              </div>
              <div className="cal-add-row">
                <input className="form-input cal-add-narrow" placeholder="Dep HH:MM" value={form.depTime} onChange={e=>setForm(p=>({...p,depTime:e.target.value}))}/>
                <input className="form-input cal-add-narrow" placeholder="Arr HH:MM" value={form.arrTime} onChange={e=>setForm(p=>({...p,arrTime:e.target.value}))}/>
                <input className="form-input cal-add-narrow" placeholder="Type" value={form.acType} onChange={e=>setForm(p=>({...p,acType:e.target.value}))} maxLength={4}/>
              </div>
              <div style={{display:"flex",gap:8,marginTop:4}}>
                <button className="btn-teal" style={{padding:"9px 18px",fontSize:13}} onClick={saveNewFlight} disabled={saving}>{saving?<span className="spinner">⟳</span>:"Save flight"}</button>
                <button className="btn-sm-ghost" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGBOOK
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// LOGBOOK PAGE — Wader-inspired horizontal table layout
// Each row = one flight segment. Columns match a paper pilot logbook.
// Horizontally scrollable on mobile. Click a row to expand edit controls.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// FLIGHT DETAIL PAGE
// Full-page view for a single flight segment, with AI briefing via Gemini +
// aviationweather.gov for live METAR/TAF data.
// ─────────────────────────────────────────────────────────────────────────────

const BRIEFING_URL = `${SUPA_URL}/functions/v1/flight-briefing`;

// Weather is now fetched server-side in the flight-briefing Edge Function.
async function fetchWeather(_icao) { return null; }
async function fetchTaf(_icao) { return null; }

async function getFlightBriefing(flightInfo) {
  // Weather is now fetched server-side — just pass flight info + coords
  const r = await fetch(BRIEFING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${sb.auth._token || SUPA_ANON}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify(flightInfo),
  });
  const data = await r.json();
  if(!r.ok) throw new Error(data.error || "Briefing failed");
  return data; // { briefing, weather: { depMetar, arrMetar, sigmets, pireps } }
}

// Inline SVG route map — no external dependencies needed
function FlightRouteMap({dep, arr}) {
  const c1 = AIRPORT_COORDS[dep];
  const c2 = AIRPORT_COORDS[arr];
  if(!c1 || !c2) return null;
  const W=340, H=140, PAD=28;
  const latPad = Math.max((Math.abs(c2[0]-c1[0]))*0.3, 2);
  const lonPad = Math.max((Math.abs(c2[1]-c1[1]))*0.3, 2);
  const minLat=Math.min(c1[0],c2[0])-latPad, maxLat=Math.max(c1[0],c2[0])+latPad;
  const minLon=Math.min(c1[1],c2[1])-lonPad, maxLon=Math.max(c1[1],c2[1])+lonPad;
  const latSpan=maxLat-minLat, lonSpan=maxLon-minLon;
  function proj(lat,lon){
    return [PAD+((lon-minLon)/lonSpan)*(W-PAD*2), (H-PAD)-((lat-minLat)/latSpan)*(H-PAD*2)];
  }
  const pts=[];
  for(let i=0;i<=40;i++){
    const t=i/40;
    const lat=c1[0]+(c2[0]-c1[0])*t;
    const lon=c1[1]+(c2[1]-c1[1])*t;
    const arc=Math.sin(t*Math.PI)*Math.max(latSpan,lonSpan)*0.1;
    pts.push(proj(lat+arc,lon));
  }
  const pathD=pts.map((p,i)=>`${i===0?"M":"L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const [x1,y1]=proj(c1[0],c1[1]);
  const [x2,y2]=proj(c2[0],c2[1]);
  const mid=pts[20], prev=pts[19];
  const angle=Math.atan2(mid[1]-prev[1],mid[0]-prev[0])*180/Math.PI;
  return (
    <div className="card" style={{marginBottom:14,padding:0,overflow:"hidden"}}>
      <div style={{padding:"10px 16px 4px",fontSize:11,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:".5px"}}>Route</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:"block",background:C.panel}}>
        {[0.25,0.5,0.75].map(t=>(
          <line key={t} x1={PAD} y1={PAD+t*(H-PAD*2)} x2={W-PAD} y2={PAD+t*(H-PAD*2)} stroke={C.border} strokeWidth="0.5" strokeDasharray="3,4"/>
        ))}
        <path d={pathD} fill="none" stroke={C.teal} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="6,3" opacity="0.8"/>
        <circle cx={x1} cy={y1} r="5" fill={C.teal}/>
        <circle cx={x2} cy={y2} r="5" fill={C.teal}/>
        <text x={x1} y={y1-10} textAnchor="middle" fontSize="11" fontWeight="700" fill={C.ink}>{dep}</text>
        <text x={x2} y={y2-10} textAnchor="middle" fontSize="11" fontWeight="700" fill={C.ink}>{arr}</text>
        <text x={mid[0]} y={mid[1]+4} textAnchor="middle" fontSize="13" fill={C.teal} transform={`rotate(${angle},${mid[0]},${mid[1]})`}>✈</text>
      </svg>
    </div>
  );
}

function FlightDetailPage({flight:f, tail, solar, dist, blockMins, day, roster, hasActual, dep, arr, isXC, onBack, onAutoLookup, lkStatus, tmp, onTmpChange, onSaveTail, saving, onTailSaved, editingTimes, setEditingTimes, timeEdits, setTimeEdits, di, fi, userId}) {
  const [briefing, setBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [weatherData, setWeatherData] = useState(null);
  const [savingTimes, setSavingTimes] = useState(false);

  const dateStr = `${roster.year}-${String((roster.monthNum||0)+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;

  // Scheduled block: use airport coordinates to calculate timezone-aware duration
  // Scheduled times from the roster are LOCAL times at each airport.
  // We compute an estimated duration using the UTC offset difference.
  const schedBlock = useMemo(()=>{
    if(!f.depTime||!f.arrTime) return schedMins(f)||null;
    const depCoords = AIRPORT_COORDS[f.dep];
    const arrCoords = AIRPORT_COORDS[f.arr];
    if(depCoords && arrCoords) {
      // Approximate UTC offsets from longitude
      const depOffset = Math.round(depCoords[1]/15);
      const arrOffset = Math.round(arrCoords[1]/15);
      const [dh,dm] = f.depTime.split(":").map(Number);
      const [ah,am] = f.arrTime.split(":").map(Number);
      // Convert both times to UTC minutes
      const depUTC = (dh*60+dm) - depOffset*60;
      const arrUTC = (ah*60+am) - arrOffset*60;
      const diff = ((arrUTC - depUTC) + 1440) % 1440;
      // Sanity check: must be between 15 mins and 10 hours
      if(diff >= 15 && diff <= 600) return diff;
    }
    return schedMins(f)||null;
  },[f]);

  useEffect(()=>{
    // Weather is fetched server-side when briefing is requested
  },[]);

  async function loadBriefing() {
    setBriefingLoading(true);
    try {
      const depCoords = AIRPORT_COORDS[f.dep];
      const arrCoords = AIRPORT_COORDS[f.arr];
      const result = await getFlightBriefing({
        flightNum:f.flightNum, dep:f.dep, arr:f.arr,
        depTime:f.depTime, arrTime:f.arrTime,
        acType:f.acType, dateStr, dist,
        depLat:depCoords?.[0], depLon:depCoords?.[1],
        arrLat:arrCoords?.[0], arrLon:arrCoords?.[1],
      });
      setBriefing(result.briefing);
      if(result.weather) setWeatherData(result.weather);
    } catch(e) { setBriefing(`Error: ${e.message}`); }
    finally { setBriefingLoading(false); }
  }

  async function saveTimesEdits() {
    setSavingTimes(true);
    const manualBlockMins = parseBlockHrToMins(timeEdits.blockHr);
    try {
      await db_saveTail(userId,roster.id,`${di}-${fi}`,tail.tail||"",timeEdits.actualDep||"",timeEdits.actualArr||"",manualBlockMins,true);
      onTailSaved({tail:tail.tail||"",actualDep:timeEdits.actualDep,actualArr:timeEdits.actualArr,actualBlockMins:manualBlockMins,finalSynced:true,cancelled:false,updatedAt:new Date().toISOString()});
      setEditingTimes(false);
    } catch(e){alert(e.message);}
    finally{setSavingTimes(false);}
  }

  function startEditing() {
    setTimeEdits({
      actualDep: hasActual?tail.actualDep:f.depTime,
      actualArr: hasActual?tail.actualArr:f.arrTime,
      blockHr: tail.actualBlockMins!=null?fmtMins(tail.actualBlockMins):schedBlock!=null?fmtMins(schedBlock):"",
    });
    setEditingTimes(true);
  }

  return (
    <div style={{maxWidth:600,paddingBottom:32}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <button onClick={onBack} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 12px",color:C.silver,fontSize:13,cursor:"pointer"}}>← Back</button>
        <div>
          <div style={{fontSize:20,fontWeight:700,color:C.ink}}>{f.flightNum}</div>
          <div style={{fontSize:13,color:C.muted}}>{day.dow} {String(day.day).padStart(2,"0")} · {roster.periodLabel}</div>
        </div>
      </div>

      {/* Route card */}
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div style={{textAlign:"center",flex:1}}>
            <div style={{fontSize:34,fontWeight:800,color:C.ink,letterSpacing:"-1px"}}>{f.dep}</div>
            <div style={{fontSize:12,color:hasActual?C.teal:C.muted,fontFamily:"monospace"}}>{dep||f.depTime}</div>
          </div>
          <div style={{textAlign:"center",padding:"0 12px"}}>
            <div style={{height:2,background:C.border,position:"relative",width:60,margin:"8px auto"}}>
              <div style={{position:"absolute",top:-9,left:"50%",transform:"translateX(-50%)",fontSize:16}}>✈</div>
            </div>
            <div style={{fontSize:10,color:C.muted}}>{dist?`${dist} NM`:"—"}</div>
            {isXC&&<div style={{fontSize:9,color:C.teal,fontWeight:700}}>XC</div>}
          </div>
          <div style={{textAlign:"center",flex:1}}>
            <div style={{fontSize:34,fontWeight:800,color:C.ink,letterSpacing:"-1px"}}>{f.arr}</div>
            <div style={{fontSize:12,color:hasActual?C.teal:C.muted,fontFamily:"monospace"}}>{arr||f.arrTime}</div>
          </div>
        </div>

        {/* Block time — single display, grey=scheduled, blue=actual */}
        <div style={{background:C.panel,borderRadius:9,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:2}}>
              {hasActual ? "Block Time" : "Block Time"}
            </div>
            <div style={{fontSize:22,fontWeight:700,color:hasActual?C.teal:C.silver,fontFamily:"monospace"}}>
              {blockMins ? fmtMins(blockMins) : "—"}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <span style={{
              display:"inline-block",padding:"3px 10px",borderRadius:6,fontSize:11,fontWeight:600,
              background:hasActual?C.teal+"18":C.border+"66",
              color:hasActual?C.teal:C.silver,
            }}>
              {hasActual ? "✓ Actual" : "Scheduled"}
            </span>
            {!hasActual && schedBlock && <div style={{fontSize:10,color:C.muted,marginTop:3}}>timezone-corrected</div>}
          </div>
        </div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          {[
            ["Aircraft",f.acType||"—"],
            ["Night",solar.nightMins>0?fmtMins(solar.nightMins):"Day"],
            ["Tail",tail.tail||"—"],
            ["T/O",solar.dayDep?"Day ☀":"Night ☽"],
            ["Landing",solar.dayArr?"Day ☀":"Night ☽"],
            ["Type",isXC?"Cross Country":"Local"],
          ].map(([l,v])=>(
            <div key={l} style={{background:C.panel,borderRadius:8,padding:"9px 10px",textAlign:"center"}}>
              <div style={{fontSize:9,color:C.muted,marginBottom:2,textTransform:"uppercase",letterSpacing:".5px"}}>{l}</div>
              <div style={{fontSize:12,fontWeight:600,color:C.ink}}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit Times */}
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:editingTimes?12:0}}>
          <div style={{fontSize:13,fontWeight:600,color:C.ink}}>Times</div>
          {!editingTimes&&(
            <button onClick={startEditing} style={{padding:"5px 12px",borderRadius:7,background:"none",border:`1px solid ${C.border}`,color:C.silver,fontSize:12,cursor:"pointer"}}>✏ Edit times</button>
          )}
        </div>
        {editingTimes&&(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
              <div>
                <div style={{fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>Dep time</div>
                <input type="time" value={timeEdits.actualDep||""} onChange={e=>setTimeEdits({...timeEdits,actualDep:e.target.value})} className="form-input" style={{padding:"6px 8px",fontSize:13}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>Arr time</div>
                <input type="time" value={timeEdits.actualArr||""} onChange={e=>setTimeEdits({...timeEdits,actualArr:e.target.value})} className="form-input" style={{padding:"6px 8px",fontSize:13}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".5px",marginBottom:4}}>Block (h:mm)</div>
                <input value={timeEdits.blockHr||""} onChange={e=>setTimeEdits({...timeEdits,blockHr:e.target.value})} placeholder="1:45" className="form-input" style={{padding:"6px 8px",fontSize:13}}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={saveTimesEdits} disabled={savingTimes} style={{padding:"8px 16px",borderRadius:8,background:C.teal,border:"none",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>
                {savingTimes?<span className="spinner">⟳</span>:"Save times"}
              </button>
              <button onClick={()=>setEditingTimes(false)} style={{padding:"8px 12px",borderRadius:8,background:"none",border:`1px solid ${C.border}`,color:C.muted,fontSize:13,cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Tail sync */}
      <div className="card" style={{marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:10}}>Tail Number</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={tmp!==undefined?tmp:(tail.tail||"")} onChange={e=>onTmpChange(e.target.value.toUpperCase())} placeholder="N-XXXXX" style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${C.border}`,background:C.surface,color:C.ink,fontSize:14,fontFamily:"monospace",flex:1,textTransform:"uppercase"}}/>
          <button onClick={onSaveTail} disabled={saving} style={{padding:"8px 16px",borderRadius:8,background:C.teal,border:"none",color:"#fff",fontSize:13,fontWeight:600,cursor:"pointer"}}>
            {saving?<span className="spinner">⟳</span>:"Save"}
          </button>
          <button onClick={onAutoLookup} disabled={lkStatus==="loading"||lkStatus==="ratelimit"} style={{padding:"8px 14px",borderRadius:8,background:C.teal+"11",border:`1px solid ${C.teal}44`,color:C.teal,fontSize:13,fontWeight:600,cursor:"pointer"}}>
            {lkStatus==="loading"?<span className="spinner">⟳</span>:lkStatus==="notfound"?"Not found":"🔍 Auto"}
          </button>
        </div>
        {tail.finalSynced&&<div style={{fontSize:11,color:C.green,marginTop:8}}>✓ Synced — actual times locked</div>}
      </div>

      {/* Weather — populated after briefing loads */}
      {weatherData&&(
        <div className="card" style={{marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:12}}>Weather Data</div>
          {[
            {label:`${f.dep} METAR`,val:weatherData.depMetar},
            {label:`${f.arr} METAR`,val:weatherData.arrMetar},
            {label:`${f.dep} TAF`,val:weatherData.depTaf},
            {label:`${f.arr} TAF`,val:weatherData.arrTaf},
            {label:"Enroute SIGMETs",val:weatherData.sigmets},
            {label:"Enroute PIREPs",val:weatherData.pireps},
          ].filter(x=>x.val&&x.val!=="Not available"&&x.val!=="None active"&&x.val!=="None reported").map(({label,val})=>(
            <div key={label} style={{marginBottom:10}}>
              <div style={{fontSize:10,color:C.muted,fontWeight:700,textTransform:"uppercase",letterSpacing:".5px",marginBottom:3}}>{label}</div>
              <div style={{fontSize:11,fontFamily:"monospace",color:C.silver,background:C.panel,padding:"7px 10px",borderRadius:6,wordBreak:"break-all",lineHeight:1.6}}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Route Map */}
      <FlightRouteMap dep={f.dep} arr={f.arr}/>

      {/* AI Briefing — only for upcoming flights (within 24 hours) */}
      {(()=>{
        const flightDt = new Date(roster.year,(roster.monthNum||0),day.day,...(f.depTime||"00:00").split(":").map(Number));
        const now = new Date();
        const hoursUntil = (flightDt - now) / 3600000;
        const isUpcoming = hoursUntil > -1 && hoursUntil < 24; // within next 24 hours or just departed
        if(!isUpcoming) return (
          <div className="card" style={{marginBottom:14}}>
            <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:6}}>AI Flight Briefing</div>
            <div style={{fontSize:12,color:C.muted}}>Briefings are available for flights within 24 hours of departure.</div>
          </div>
        );
        return (
          <div className="card" style={{marginBottom:14}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:C.ink}}>AI Flight Briefing</div>
                <div style={{fontSize:10,color:C.muted}}>Powered by Claude + aviationweather.gov</div>
              </div>
              {!briefing&&<button onClick={loadBriefing} disabled={briefingLoading} style={{padding:"6px 14px",borderRadius:8,background:C.teal,border:"none",color:"#fff",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                {briefingLoading?<span className="spinner">⟳</span>:"Get briefing"}
              </button>}
            </div>
            {briefingLoading&&<div style={{color:C.muted,fontSize:13}}>Fetching weather and generating briefing…</div>}
            {briefing&&<div style={{fontSize:13,color:C.silver,lineHeight:1.7,whiteSpace:"pre-wrap"}} dangerouslySetInnerHTML={{__html:briefing.replace(/\*\*(.*?)\*\*/g,'<strong style="color:'+C.ink+'">$1</strong>')}}/>}
            {!briefing&&!briefingLoading&&<div style={{fontSize:12,color:C.muted,fontStyle:"italic"}}>Tap "Get briefing" for a live weather analysis of your route.</div>}
          </div>
        );
      })()}
    </div>
  );
}

const LB_COLS = [
  {key:"date",      label:"Date",       w:90,  fixed:true},
  {key:"flight",    label:"Flight",     w:72},
  {key:"acType",    label:"A/C Type",   w:70},
  {key:"tail",      label:"Tail",       w:80},
  {key:"dep",       label:"From",       w:52},
  {key:"arr",       label:"To",         w:52},
  {key:"depTime",   label:"Dep",        w:52},
  {key:"arrTime",   label:"Arr",        w:52},
  {key:"block",     label:"Block",      w:58},
  {key:"dist",      label:"NM",         w:48},
  {key:"pic",       label:"PIC",        w:52},
  {key:"sic",       label:"SIC",        w:52},
  {key:"night",     label:"Night",      w:52},
  {key:"actInst",   label:"Act Inst",   w:62},
  {key:"simInst",   label:"Sim Inst",   w:62},
  {key:"xc",        label:"X-Country",  w:68},
  {key:"sim",       label:"Sim",        w:48},
  {key:"dayTo",     label:"Day T/O",    w:58},
  {key:"nightTo",   label:"Night T/O",  w:68},
  {key:"dayLdg",    label:"Day Ldg",    w:58},
  {key:"nightLdg",  label:"Night Ldg",  w:68},
];

// ─────────────────────────────────────────────────────────────────────────────
// LOGBOOK PAGE — Card/tab view per flight segment
// Days are grouped; each flight segment is a tappable card that opens the
// full FlightDetailPage. Departure and arrival are bold and prominent.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// LOGBOOK PAGE — Day-card / sticky-tab layout
// Each day with flights is a card. Inside each card, each flight segment is
// a tab/pill. Tapping a segment opens FlightDetailPage.
// ─────────────────────────────────────────────────────────────────────────────
function LogbookPage({user, rosters, tails, onTailSaved, onDeleteRoster, onRosterUpdated, pendingFlight, onPendingFlightConsumed}) {
  const [selRoster, setSelRoster] = useState(()=>defaultRosterIndex(rosters));
  const [selectedFlight, setSelectedFlight] = useState(null);
  const [saving, setSaving] = useState({});
  const [tmp, setTmp] = useState({});
  const [lkStatus, setLkStatus] = useState({});
  const [timeEdits, setTimeEdits] = useState({});
  const [editingTimes, setEditingTimes] = useState({});
  const [confirmDel, setConfirmDel] = useState(null);
  const [collapsedDays, setCollapsedDays] = useState({});

  useEffect(()=>{
    if(!pendingFlight) return;
    if(pendingFlight.selectedFlight) {
      const rIdx=rosters.findIndex(r=>r.id===pendingFlight.rosterId||(r.year===pendingFlight.year&&r.monthNum===pendingFlight.monthNum));
      if(rIdx>=0) setSelRoster(rIdx);
      setSelectedFlight(pendingFlight.selectedFlight);
    }
    onPendingFlightConsumed?.();
  },[pendingFlight]);

  const roster=rosters[selRoster];
  if(!roster) return (
    <div style={{textAlign:"center",padding:60,color:C.muted}}>
      No rosters uploaded yet.
    </div>
  );

  function tkey(di,fi){return roster.id+"-"+di+"-"+fi;}

  let totalBlock=0,totalDist=0,totalFlights=0;
  (roster.calendar||[]).forEach((day,di)=>{
    (day.flights||[]).forEach((f,fi)=>{
      const tk=tkey(di,fi);
      const tail=tails[tk]||{};
      if(tail.cancelled) return;
      totalBlock+=tail.actualBlockMins!=null?tail.actualBlockMins:(schedMins(f)||0);
      totalDist+=airportDistanceNM(f.dep,f.arr)||0;
      totalFlights++;
    });
  });

  async function saveTail(di,fi){
    const tk=tkey(di,fi);
    const val=(tmp[tk]||"").trim().toUpperCase();
    if(!val) return;
    setSaving(p=>({...p,[tk]:true}));
    try{
      await db_saveTail(user.id,roster.id,di+"-"+fi,val,"","",null,true);
      onTailSaved(tk,{tail:val,finalSynced:true,cancelled:false,updatedAt:new Date().toISOString()});
      setTmp(p=>{const n={...p};delete n[tk];return n;});
    }catch(e){alert(e.message);}
    finally{setSaving(p=>({...p,[tk]:false}));}
  }

  async function autoLookup(di,fi,f,dayNum){
    const tk=tkey(di,fi);
    const monthNum=roster.monthNum!=null?roster.monthNum:(roster.month_num||0);
    const dateStr=roster.year+"-"+String(monthNum+1).padStart(2,"0")+"-"+String(dayNum).padStart(2,"0");
    setLkStatus(p=>({...p,[tk]:"loading"}));
    try{
      const r=await lookupFlight(f.flightNum,dateStr,f.depTime);
      if(r&&r.tailNumber){
        await db_saveTail(user.id,roster.id,di+"-"+fi,r.tailNumber,r.actualDepTime||"",r.actualArrTime||"",r.actualBlockMins||null,false);
        onTailSaved(tk,{tail:r.tailNumber,actualDep:r.actualDepTime,actualArr:r.actualArrTime,actualBlockMins:r.actualBlockMins,finalSynced:false,cancelled:!!r.cancelled,updatedAt:new Date().toISOString()});
        setLkStatus(p=>({...p,[tk]:"ok"}));
      }else{setLkStatus(p=>({...p,[tk]:"notfound"}));}
    }catch(e){setLkStatus(p=>({...p,[tk]:e.message&&e.message.includes("limit")?"ratelimit":"error"}));}
  }

  function openFlight(di,fi,f,day){
    const tk=tkey(di,fi);
    const tail=tails[tk]||{};
    if(tail.cancelled) return;
    const monthNum=roster.monthNum!=null?roster.monthNum:(roster.month_num||0);
    const dateStr=roster.year+"-"+String(monthNum+1).padStart(2,"0")+"-"+String(day.day).padStart(2,"0");
    const solar=computeNightTime(dateStr,f.dep,f.arr,tail.actualDep||f.depTime,tail.actualArr||f.arrTime);
    const dist=airportDistanceNM(f.dep,f.arr);
    const blockMins=tail.actualBlockMins!=null?tail.actualBlockMins:(schedMins(f)||0);
    const hasActual=!!(tail.actualDep&&tail.actualArr);
    // Push a history entry so phone back button closes detail instead of leaving logbook
    window.history.pushState({page:"logbook",flightDetail:true},"","");
    setSelectedFlight({di,fi,f,tail,tk,solar,dist,blockMins,day,hasActual,
      dep:hasActual?tail.actualDep:f.depTime,arr:hasActual?tail.actualArr:f.arrTime,isXC:(dist||0)>50});
  }

  // Listen for back gesture while flight detail is open — close it instead of leaving
  useEffect(()=>{
    if(!selectedFlight) return;
    function onPop(e) {
      if(e.state?.flightDetail) return; // already handled
      setSelectedFlight(null);
      // Re-push logbook state so the page stays on logbook
      window.history.pushState({page:"logbook"},"","");
    }
    window.addEventListener("popstate", onPop);
    return ()=>window.removeEventListener("popstate", onPop);
  },[selectedFlight]);

  if(selectedFlight){
    const{di,fi,f,tk,solar,dist,blockMins,day}=selectedFlight;
    const freshTail=tails[tk]||{};
    const freshHasActual=!!(freshTail.actualDep&&freshTail.actualArr);
    return(
      <FlightDetailPage
        flight={f} tail={freshTail} solar={solar} dist={dist}
        blockMins={freshTail.actualBlockMins!=null?freshTail.actualBlockMins:(schedMins(f)||0)}
        day={day} roster={roster}
        hasActual={freshHasActual}
        dep={freshHasActual?freshTail.actualDep:f.depTime}
        arr={freshHasActual?freshTail.actualArr:f.arrTime}
        isXC={(dist||0)>50}
        onBack={()=>setSelectedFlight(null)}
        onAutoLookup={()=>autoLookup(di,fi,f,day.day)}
        lkStatus={lkStatus[tk]}
        tmp={tmp[tk]}
        onTmpChange={v=>setTmp(p=>({...p,[tk]:v}))}
        onSaveTail={()=>saveTail(di,fi)}
        saving={saving[tk]}
        onTailSaved={(td)=>onTailSaved(tk,td)}
        editingTimes={!!editingTimes[tk]}
        setEditingTimes={v=>setEditingTimes(p=>({...p,[tk]:v}))}
        timeEdits={timeEdits[tk]||{}}
        setTimeEdits={v=>setTimeEdits(p=>({...p,[tk]:v}))}
        di={di} fi={fi} userId={user.id}
      />
    );
  }

  const activeDays=(roster.calendar||[]).map((day,di)=>({day,di})).filter(function(x){return x.day.flights&&x.day.flights.length>0||x.day.dutyCode;});

  return(
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 56px)"}}>
      <div style={{background:C.surface,borderBottom:"1px solid "+C.border,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"10px 16px",overflowX:"auto"}}>
          {rosters.map(function(r,i){return(
            <button key={r.id} onClick={function(){setSelRoster(i);}} className={"month-tab"+(selRoster===i?" active":"")}>
              {r.periodLabel||r.year}
            </button>
          );})}
          <div style={{flex:1}}/>
          {confirmDel?(
            <>
              <span style={{fontSize:11,color:C.red}}>Delete?</span>
              <button onClick={function(){onDeleteRoster(roster.id);setConfirmDel(null);}} style={{fontSize:11,color:C.red,background:"none",border:"1px solid "+C.red,borderRadius:6,padding:"3px 10px",cursor:"pointer"}}>Yes</button>
              <button onClick={function(){setConfirmDel(null);}} style={{fontSize:11,color:C.muted,background:"none",border:"1px solid "+C.border,borderRadius:6,padding:"3px 10px",cursor:"pointer"}}>No</button>
            </>
          ):(
            <button onClick={function(){setConfirmDel("y");}} style={{fontSize:11,color:C.red,background:"none",border:"1px solid "+C.border+"55",borderRadius:6,padding:"3px 10px",cursor:"pointer",flexShrink:0}}>Delete</button>
          )}
        </div>
        <div style={{display:"flex",gap:20,padding:"4px 16px 10px",fontSize:12,color:C.muted}}>
          <span><b style={{color:C.ink}}>{totalFlights}</b> flights</span>
          <span><b style={{color:C.ink}}>{fmtMins(totalBlock)}</b> block</span>
          <span><b style={{color:C.ink}}>{totalDist.toLocaleString()}</b> NM</span>
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 16px"}}>
        {activeDays.length===0&&(
          <div style={{textAlign:"center",padding:48,color:C.muted,fontSize:13}}>No flights in this roster.</div>
        )}
        {activeDays.map(function({day,di}){
          const flights=day.flights||[];
          const isOpen=!!collapsedDays[di]; // default collapsed; toggled open on tap
          const flightCount=flights.filter(function(_,fi){return !tails[tkey(di,fi)]||!tails[tkey(di,fi)].cancelled;}).length;
          const flownCount=flights.filter(function(_,fi){const t=tails[tkey(di,fi)];return t&&t.actualBlockMins!=null;}).length;
          const dayBlock=flights.reduce(function(a,f,fi){const t=tails[tkey(di,fi)]||{};return a+(t.actualBlockMins!=null?t.actualBlockMins:(schedMins(f)||0));},0);
          const allFlown=flightCount>0&&flownCount===flightCount;
          const anyFlown=flownCount>0;

          return(
            <div key={di} className="lb-day-card">
              <div className="lb-day-header" onClick={function(){setCollapsedDays(function(p){const n={...p};n[di]=!isOpen;return n;});}}>
                <div className="lb-day-num" style={{background:allFlown?C.teal:anyFlown?C.teal+"30":C.panel}}>
                  <div className="lb-day-num-val" style={{color:allFlown?"#fff":C.ink}}>{String(day.day).padStart(2,"0")}</div>
                  <div className="lb-day-num-dow" style={{color:allFlown?"rgba(255,255,255,.7)":C.muted}}>{day.dow}</div>
                </div>
                <div className="lb-day-info">
                  {flightCount>0?(
                    <>
                      <div className="lb-day-route">
                        <b>{flights[0]&&flights[0].dep}</b>
                        {flights.map(function(f,fi){return <span key={fi}> &rarr; <b>{f.arr}</b></span>;})}
                      </div>
                      <div className="lb-day-meta">
                        {flights.map(function(f){return f.flightNum;}).join(" · ")}
                        {dayBlock?" · "+fmtMins(dayBlock):""}
                      </div>
                    </>
                  ):(
                    <div style={{fontSize:13,fontWeight:600,color:C.gold}}>{day.dutyCode||"Duty"}</div>
                  )}
                </div>
                <div className="lb-chevron" style={{transform:isOpen?"rotate(180deg)":"none"}}>&#9660;</div>
              </div>

              {isOpen&&flightCount>0&&(
                <div className="lb-segments">
                  {flights.map(function(f,fi){
                    const tk=tkey(di,fi);
                    const tail=tails[tk]||{};
                    if(tail.cancelled) return null;
                    const hasActual=!!(tail.actualDep&&tail.actualArr);
                    const blockMins=tail.actualBlockMins!=null?tail.actualBlockMins:(schedMins(f)||0);
                    const dist=airportDistanceNM(f.dep,f.arr);
                    const monthNum=roster.monthNum!=null?roster.monthNum:(roster.month_num||0);
                    const dateStr=roster.year+"-"+String(monthNum+1).padStart(2,"0")+"-"+String(day.day).padStart(2,"0");
                    const solar=computeNightTime(dateStr,f.dep,f.arr,tail.actualDep||f.depTime,tail.actualArr||f.arrTime);
                    return(
                      <div key={fi} className={"lb-seg"+(hasActual?" actual":"")} onClick={function(){openFlight(di,fi,f,day);}}>
                        <div className="lb-seg-num">{f.flightNum}</div>
                        <div className="lb-seg-route">
                          <div className="lb-seg-dep-arr">
                            <b>{f.dep}</b>
                            <span style={{color:C.muted,fontWeight:400,margin:"0 5px"}}>&rarr;</span>
                            <b>{f.arr}</b>
                            {(dist||0)>50&&<span style={{marginLeft:6,fontSize:9,color:C.teal,background:C.teal+"18",padding:"1px 5px",borderRadius:4,fontWeight:700}}>XC</span>}
                          </div>
                          <div className={"lb-seg-times"+(hasActual?" synced":"")}>
                            {hasActual
                              ?tail.actualDep+" → "+tail.actualArr+(blockMins?" · "+fmtMins(blockMins):"")
                              :f.depTime+" → "+f.arrTime+(blockMins?" · "+fmtMins(blockMins):"")}
                          </div>
                        </div>
                        <div className="lb-seg-right">
                          <div className="lb-seg-tail">
                            {tail.tail||"—"}
                            {tail.finalSynced&&<span style={{color:C.green,marginLeft:2}}>✓</span>}
                          </div>
                          {dist&&<div className="lb-seg-dist">{dist} NM</div>}
                          {(solar.nightDep||solar.nightArr)&&<div className="lb-seg-night">NIGHT</div>}
                        </div>
                        <div className="lb-seg-arrow">&rsaquo;</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// STATS PAGE
// ─────────────────────────────────────────────────────────────────────────────

function applyTimeRules(rules, dateStr) {
  const sorted=[...rules].sort((a,b)=>new Date(b.start_date)-new Date(a.start_date));
  for(const rule of sorted){if(dateStr>=rule.start_date&&(!rule.end_date||dateStr<=rule.end_date))return rule;}
  return null;
}

function computeAnalytics(rosters,tails,timeRules=[],_ft={},_ac={},toLandingMode="every"){
  const now=new Date();
  const d30=new Date(now);d30.setDate(d30.getDate()-30);
  const d6mo=new Date(now);d6mo.setMonth(d6mo.getMonth()-6);
  const d12mo=new Date(now);d12mo.setFullYear(d12mo.getFullYear()-1);
  const results={last30:{mins:0},last6mo:{mins:0},last12mo:{mins:0},byMonth:{},
    totals:{pic:0,sic:0,multi:0,single:0,turbine:0,night:0,actInst:0,simInst:0,sim:0,xc:0,dayTo:0,nightTo:0,dayLdg:0,nightLdg:0,dist:0}};
  for(const roster of rosters){
    let seg=0;
    const monthNum=roster.monthNum!=null?roster.monthNum:(roster.month_num||0);
    (roster.calendar||[]).forEach((day,di)=>{
      (day.flights||[]).forEach((f,fi)=>{
        const tk=roster.id+"-"+di+"-"+fi;
        const tail=tails[tk]||{};
        if(tail.cancelled){seg++;return;}
        const dateStr=roster.year+"-"+String(monthNum+1).padStart(2,"0")+"-"+String(day.day).padStart(2,"0");
        const flightDate=new Date(dateStr+"T12:00:00Z");
        const mins=tail.actualBlockMins!=null?tail.actualBlockMins:(schedMins(f)||0);
        if(!mins){seg++;return;}
        const solar=computeNightTime(dateStr,f.dep,f.arr,tail.actualDep||f.depTime,tail.actualArr||f.arrTime);
        const dist=airportDistanceNM(f.dep,f.arr)||0;
        const isXC=dist>50;
        const count=toLandingMode==="every"||seg%2===0;
        const dayTo=count&&solar.dayDep?1:0,nightTo=count&&solar.nightDep?1:0;
        const dayLdg=count&&solar.dayArr?1:0,nightLdg=count&&solar.nightArr?1:0;
        const mk=dateStr.slice(0,7);
        if(!results.byMonth[mk]) results.byMonth[mk]={flownMins:0,pic:0,sic:0,multi:0,single:0,turbine:0,night:0,actInst:0,xc:0,dist:0,dayTo:0,nightTo:0,dayLdg:0,nightLdg:0};
        const mo=results.byMonth[mk];
        mo.flownMins+=mins;mo.night+=solar.nightMins;mo.dist+=dist;mo.xc+=isXC?mins:0;
        mo.dayTo+=dayTo;mo.nightTo+=nightTo;mo.dayLdg+=dayLdg;mo.nightLdg+=nightLdg;
        if(flightDate>=d30)results.last30.mins+=mins;
        if(flightDate>=d6mo)results.last6mo.mins+=mins;
        if(flightDate>=d12mo)results.last12mo.mins+=mins;
        results.totals.night+=solar.nightMins;results.totals.dist+=dist;results.totals.xc+=isXC?mins:0;
        results.totals.dayTo+=dayTo;results.totals.nightTo+=nightTo;results.totals.dayLdg+=dayLdg;results.totals.nightLdg+=nightLdg;
        const rule=applyTimeRules(timeRules,dateStr);
        if(rule?.is_pic){mo.pic+=mins;results.totals.pic+=mins;}
        if(rule?.is_sic){mo.sic+=mins;results.totals.sic+=mins;}
        if(rule?.is_multi||!rule){mo.multi+=mins;results.totals.multi+=mins;}
        if(rule?.is_single){mo.single+=mins;results.totals.single+=mins;}
        if(rule?.is_turbine||!rule){mo.turbine+=mins;results.totals.turbine+=mins;}
        seg++;
      });
    });
  }
  return results;
}

const FDP_TABLE_B=[
  {s:0,e:359,m:9},{s:400,e:459,m:9},{s:500,e:559,m:10},{s:600,e:659,m:10},
  {s:700,e:759,m:11},{s:800,e:859,m:12},{s:900,e:959,m:12},{s:1000,e:1059,m:13},
  {s:1100,e:1159,m:13},{s:1200,e:1259,m:13},{s:1300,e:1359,m:12},{s:1400,e:1459,m:12},
  {s:1500,e:1559,m:12},{s:1600,e:1659,m:12},{s:1700,e:1759,m:12},{s:1800,e:1859,m:12},
  {s:1900,e:1959,m:11},{s:2000,e:2059,m:11},{s:2100,e:2159,m:10},{s:2200,e:2259,m:10},{s:2300,e:2359,m:9},
];
function getFdpMax(reportTime,crew){
  const[h,m]=(reportTime||"08:00").split(":").map(Number);
  const v=h*100+(m||0);let base=9;
  for(const r of FDP_TABLE_B){if(v>=r.s&&v<=r.e){base=r.m;break;}}
  return base+(crew==="3"?2:crew==="4"?3:0);
}

function FDPCalculator({analytics}){
  const[reportTime,setReportTime]=useState("08:00");
  const[crew,setCrew]=useState("2");
  const[actualFdp,setActualFdp]=useState("");
  const[restBefore,setRestBefore]=useState("");
  const maxFdp=getFdpMax(reportTime,crew);
  const aNum=actualFdp?parseFloat(actualFdp):null;
  const pct=aNum?Math.min(100,Math.round((aNum/maxFdp)*100)):0;
  const col=pct>=100?C.red:pct>=85?C.gold:C.teal;
  const restOk=restBefore?parseFloat(restBefore)>=10:null;
  return(
    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      <div className="card">
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:14}}>Accumulation Limits</div>
        {[{label:"Calendar month — 100 hr",limit:100*60,actual:(()=>{const mk=new Date().toISOString().slice(0,7);return analytics?.byMonth?.[mk]?.flownMins||0;})()},
          {label:"365 days — 1000 hr",limit:1000*60,actual:analytics?.last12mo?.mins||0}].map(row=>{
          const p=Math.min(100,Math.round((row.actual/row.limit)*100));
          const c=p>=90?C.red:p>=75?C.gold:C.teal;
          return(<div key={row.label} style={{marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:12,color:C.silver}}>{row.label}</span>
              <span style={{fontFamily:"monospace",fontSize:12,color:c,fontWeight:700}}>{fmtMins(row.actual)} / {fmtMins(row.limit)}</span>
            </div>
            <div style={{height:7,background:C.border,borderRadius:4,overflow:"hidden"}}>
              <div style={{height:"100%",width:p+"%",background:c,borderRadius:4}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
              <span style={{fontSize:10,color:c,fontWeight:600}}>{p}% used</span>
              <span style={{fontSize:10,color:C.muted}}>{fmtMins(row.limit-row.actual)} remaining</span>
            </div>
          </div>);
        })}
      </div>
      <div className="card">
        <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:14}}>FDP Calculator — Table B</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          <div><div className="form-label">Report time</div><input className="form-input" type="time" value={reportTime} onChange={e=>setReportTime(e.target.value)}/></div>
          <div><div className="form-label">Crew</div>
            <select className="form-select" value={crew} onChange={e=>setCrew(e.target.value)}>
              <option value="2">2-pilot</option><option value="3">3-pilot (+2hr)</option><option value="4">4-pilot (+3hr)</option>
            </select>
          </div>
          <div><div className="form-label">Actual FDP (hrs)</div><input className="form-input" type="number" step="0.1" placeholder="10.5" value={actualFdp} onChange={e=>setActualFdp(e.target.value)}/></div>
          <div><div className="form-label">Rest before (hrs)</div><input className="form-input" type="number" step="0.5" placeholder="11" value={restBefore} onChange={e=>setRestBefore(e.target.value)}/></div>
        </div>
        <div style={{padding:"14px 16px",background:C.panel,borderRadius:10,marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:aNum?10:0}}>
            <span style={{fontSize:13,color:C.silver}}>Max FDP — {crew}-pilot @ {reportTime}</span>
            <span style={{fontFamily:"monospace",fontSize:22,color:C.teal,fontWeight:700}}>{maxFdp}:00</span>
          </div>
          {aNum!=null&&<><div style={{height:7,background:C.border,borderRadius:4,overflow:"hidden",marginBottom:4}}><div style={{height:"100%",width:pct+"%",background:col,borderRadius:4}}/></div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:11,color:col,fontWeight:600}}>{pct}% used</span>
              <span style={{fontSize:11,color:pct>=100?C.red:C.muted}}>{pct>=100?"⚠ EXCEEDS LIMIT":fmtMins((maxFdp-aNum)*60)+" left"}</span>
            </div></>}
        </div>
        {restOk!=null&&<div style={{padding:"10px 14px",borderRadius:9,background:restOk?C.teal+"0d":C.red+"0d",border:"1px solid "+(restOk?C.teal+"44":C.red+"44"),fontSize:13,color:restOk?C.teal:C.red,fontWeight:600}}>
          {restOk?"✓ Rest compliant ("+restBefore+"hr ≥ 10hr min)":"⚠ Insufficient rest — "+restBefore+"hr < 10hr required"}
        </div>}
      </div>
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
      const{data,error}=await sb.from("time_rules").insert({user_id:user.id,...ruleForm}).select().single();
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
    <div>
      <div style={{display:"flex",gap:0,marginBottom:20,borderBottom:"1px solid "+C.border,overflowX:"auto"}}>
        {[["overview","Overview"],["far117","FAR 117"],["rules","Time Rules"],["recency","Recency"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"9px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,fontWeight:600,whiteSpace:"nowrap",color:tab===id?C.teal:C.muted,borderBottom:"2px solid "+(tab===id?C.teal:"transparent"),marginBottom:-1,transition:"all .15s"}}>{label}</button>
        ))}
      </div>

      {tab==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
            {[["Last 30 days",analytics.last30.mins],["Last 6 mo",analytics.last6mo.mins],["Last 12 mo",analytics.last12mo.mins]].map(([l,m])=>(
              <div key={l} className="card" style={{textAlign:"center",padding:"14px 10px"}}>
                <div style={{fontFamily:"monospace",fontSize:18,fontWeight:700,color:C.teal}}>{m?fmtMins(m):"—"}</div>
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
                <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.panel,borderRadius:8}}>
                  <span style={{fontSize:12,color:C.silver}}>{l}</span>
                  <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:m?C.ink:C.muted}}>{m?fmtMins(m):"—"}</span>
                </div>
              ))}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.panel,borderRadius:8}}>
                <span style={{fontSize:12,color:C.silver}}>Day / Night T/O</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:C.ink}}>{analytics.totals.dayTo} / {analytics.totals.nightTo}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.panel,borderRadius:8}}>
                <span style={{fontSize:12,color:C.silver}}>Day / Night Ldg</span>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:600,color:C.ink}}>{analytics.totals.dayLdg} / {analytics.totals.nightLdg}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.panel,borderRadius:8,gridColumn:"span 2"}}>
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
                    <div key={l} style={{textAlign:"center",padding:"6px 4px",background:C.panel,borderRadius:7}}>
                      <div style={{fontFamily:"monospace",fontSize:11,color:v?C.teal:C.muted,fontWeight:600}}>{v?fmtMins(v):"—"}</div>
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

      {tab==="far117"&&<FDPCalculator analytics={analytics}/>}

      {tab==="rules"&&(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:700,color:C.ink}}>Time Rules</div>
          <button className="btn-teal" style={{padding:"7px 14px",fontSize:12}} onClick={()=>setShowRuleForm(p=>!p)}>{showRuleForm?"Cancel":"+ Add rule"}</button>
        </div>
        {showRuleForm&&(
          <div className="card" style={{marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
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
              <div style={{fontSize:13,fontWeight:700,color:C.ink,marginBottom:4}}>FAR 61.57 — 90-Day Recency</div>
              <div style={{fontSize:11,color:C.muted,marginBottom:16}}>3 T/O + 3 landings in last 90 days required to carry passengers.</div>
              {[{label:"Day Currency",ok:dayOk,items:[["Day T/O",dayTo],["Day Ldg",dayLdg]]},
                {label:"Night Currency",ok:nightOk,items:[["Night T/O",nightTo],["Night Ldg",nightLdg]]}].map(({label,ok,items})=>(
                <div key={label} style={{marginBottom:12,padding:"14px",borderRadius:10,background:ok?C.teal+"0d":C.red+"0d",border:"1px solid "+(ok?C.teal+"44":C.red+"44")}}>
                  <div style={{fontSize:14,fontWeight:700,color:ok?C.teal:C.red,marginBottom:10}}>{ok?"✓":"✗"} {label} — {ok?"CURRENT":"NOT CURRENT"}</div>
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
  // coordinates — gives the map route arcs their characteristic curve.
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
        maxZoom: 18,
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
        {/* Roster picker — only shown in monthly mode */}
        {!allTime && (
          <select
            value={selectedRosterId||""}
            onChange={e=>setSelectedRosterId(e.target.value)}
            style={{padding:"5px 10px",borderRadius:7,border:`1px solid ${C.border}`,background:C.panel,color:C.ink,fontSize:12}}>
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

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE PAGE
// ─────────────────────────────────────────────────────────────────────────────
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
            <button onClick={()=>downloadDoc(doc)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:7,padding:"5px 10px",color:C.silver,fontSize:11,cursor:"pointer",flexShrink:0}}>
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

function ProfilePage({user, onUserUpdated}) {
  const [tab, setTab] = useState("info");
  const [name, setName] = useState(user.name||"");
  const [dob, setDob] = useState(user.dob||user.date_of_birth||"");
  const [airlineIata, setAirlineIata] = useState(user.airline_iata||user.airlineIata||"");
  const [airlineName, setAirlineName] = useState(user.airline_name||user.airlineName||"");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");
  const [photoUrl, setPhotoUrl] = useState(user.avatar_url||null);
  const fileRef = useRef();

  async function saveProfile() {
    setSaving(true); setErr(""); setSaved(false);
    try {
      const {error} = await sb.from("profiles").update({
        name, date_of_birth:dob||null,
        airline_iata:airlineIata||null, airline_name:airlineName||null,
      }).eq("id", user.id);
      if(error) throw new Error(error.message);
      onUserUpdated({...user, name, dob, airline_iata:airlineIata, airline_name:airlineName});
      setSaved(true);
      setTimeout(()=>setSaved(false), 2500);
    } catch(e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function handlePhoto(file) {
    if(!file) return;
    try {
      // Store as base64 in localStorage for now (no storage bucket configured)
      const reader = new FileReader();
      reader.onload = e => {
        const url = e.target.result;
        setPhotoUrl(url);
        try { localStorage.setItem("fl_avatar_"+user.id, url); } catch{}
      };
      reader.readAsDataURL(file);
    } catch(e) { setErr("Photo upload failed."); }
  }

  // Load saved photo
  useEffect(()=>{
    const saved = localStorage.getItem("fl_avatar_"+user.id);
    if(saved) setPhotoUrl(saved);
  },[]);

  return (
    <div style={{maxWidth:560}}>
      {/* Avatar */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24}}>
        <div onClick={()=>fileRef.current?.click()} style={{
          width:72,height:72,borderRadius:"50%",cursor:"pointer",
          background:photoUrl?"transparent":C.teal+"33",
          border:`2px solid ${C.border}`,
          display:"flex",alignItems:"center",justifyContent:"center",
          overflow:"hidden",flexShrink:0,
        }}>
          {photoUrl
            ? <img src={photoUrl} alt="Profile" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            : <span style={{fontSize:26,fontWeight:700,color:C.teal}}>{initials(user.name)}</span>
          }
        </div>
        <div>
          <div style={{fontSize:16,fontWeight:600,color:C.ink}}>{user.name||"Pilot"}</div>
          <div style={{fontSize:13,color:C.muted}}>{user.email}</div>
          <button onClick={()=>fileRef.current?.click()} style={{marginTop:4,fontSize:12,color:C.teal,background:"none",border:"none",cursor:"pointer",padding:0}}>
            Change photo
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handlePhoto(e.target.files?.[0])}/>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",gap:0,marginBottom:20,borderBottom:`1px solid ${C.border}`}}>
        {[["info","Profile"],["subscription","Subscription"],["billing","Billing"],["certs","Certificates"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{
            padding:"8px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,fontWeight:600,
            color:tab===id?C.teal:C.muted,
            borderBottom:`2px solid ${tab===id?C.teal:"transparent"}`,
            marginBottom:-1,transition:"all .15s",
          }}>{label}</button>
        ))}
      </div>

      {tab==="info"&&(
        <div className="card">
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>Personal Information</div>
          {err&&<div style={{fontSize:13,color:C.red,marginBottom:12}}>{err}</div>}
          {saved&&<div style={{fontSize:13,color:C.green,marginBottom:12}}>✓ Profile saved</div>}
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div>
              <div className="form-label">Full name</div>
              <input className="form-input" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name"/>
            </div>
            <div>
              <div className="form-label">Email</div>
              <input className="form-input" value={user.email} disabled style={{opacity:.6,cursor:"not-allowed"}}/>
            </div>
            <div>
              <div className="form-label">Date of birth</div>
              <input className="form-input" type="date" value={dob} onChange={e=>setDob(e.target.value)}/>
            </div>
            <div>
              <div className="form-label">Airline</div>
              <input className="form-input" value={airlineName} onChange={e=>setAirlineName(e.target.value)} placeholder="e.g. United Airlines"/>
            </div>
            <div>
              <div className="form-label">IATA code</div>
              <input className="form-input" value={airlineIata} onChange={e=>setAirlineIata(e.target.value.toUpperCase().slice(0,3))} placeholder="e.g. UA" maxLength={3} style={{width:100}}/>
            </div>
            <div>
              <div className="form-label">Plan</div>
              <div style={{fontSize:14,color:C.silver,padding:"11px 0"}}><span className="pill pill-orange">{user.plan||"Pro"}</span></div>
            </div>
            <div>
              <div className="form-label">Member since</div>
              <div style={{fontSize:14,color:C.silver,padding:"11px 0"}}>{user.joined||"—"}</div>
            </div>
          </div>
          <div style={{marginTop:20}}>
            <button className="btn-teal" style={{padding:"12px 24px",fontSize:14}} onClick={saveProfile} disabled={saving}>
              {saving?<span className="spinner">⟳</span>:"Save changes"}
            </button>
          </div>
        </div>
      )}

      {tab==="subscription"&&(
        <div className="card">
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>Subscription</div>
          <div style={{padding:"16px",background:C.panel,borderRadius:10,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:15,fontWeight:600,color:C.ink}}>{user.plan==="pro"?"Pro Plan":"Starter Plan"}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:2}}>
                  {user.plan==="pro"?"Full access · Auto-sync · Analytics":"Limited to 1 roster"}
                </div>
              </div>
              <span className="pill pill-orange">{user.plan||"Pro"}</span>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {user.plan!=="pro"&&(
              <button className="btn-teal" style={{padding:"12px",fontSize:14}}>
                Upgrade to Pro — $9/mo
              </button>
            )}
            {user.plan==="pro"&&(
              <button className="btn-sm-ghost" style={{fontSize:13}}>
                Downgrade to Starter
              </button>
            )}
          </div>
          <div style={{marginTop:16,fontSize:12,color:C.muted}}>
            Stripe billing integration coming soon. Contact support to manage your subscription.
          </div>
        </div>
      )}

      {tab==="billing"&&(
        <div className="card">
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>Billing History</div>
          <div style={{textAlign:"center",padding:"32px 0",color:C.muted,fontSize:13}}>
            <div style={{fontSize:32,marginBottom:12}}>🧾</div>
            Billing history will appear here once Stripe integration is complete.
            <div style={{marginTop:8,fontSize:12}}>Contact support@flightlog.app for billing questions.</div>
          </div>
        </div>
      )}

      {tab==="certs"&&(
        <CertificatesTab userId={user.id}/>
      )}
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
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{isDark?"Deep navy — easier on the eyes at night":"Clean white — better in bright light"}</div>
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
          {[["Name",user.name],["Email",user.email],["Airline",user.airlineName||user.airline_name||"—"],["IATA Code",user.airlineIata||user.airline_iata||"—"],["Plan",<span className="pill pill-orange">{user.plan}</span>],["Member since",user.joined]].map(([l,v])=>(
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
        <p style={{fontSize:13,color:C.muted}}>Tail numbers and block times are pulled automatically from live flight data shortly after each flight lands. No setup required — this runs in the background for every pilot.</p>
      </div>

      <div className="card">
        <div style={{fontSize:14,fontWeight:600,color:C.white,marginBottom:8}}>Export Logbook</div>
        <p style={{fontSize:13,color:C.muted,marginBottom:12}}>Download your complete logbook as CSV. Compatible with Excel, Google Sheets, ForeFlight, and Logbook Pro.</p>
        <button className="btn-orange" onClick={download} disabled={rosters.length===0}>↓ Download CSV ({flights.length} flights)</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PAGES
// ─────────────────────────────────────────────────────────────────────────────
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
      {!isConfigured()&&<div className="warn">⚠ Demo mode — connect Supabase to see real user data.</div>}
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
  useEffect(()=>{db_adminUsers().then(u=>{setUsers(u);setLoading(false);});},[]);

  async function toggleActive(id,current) {
    await db_adminUpdateUser(id,{active:!current});
    setUsers(prev=>prev.map(u=>u.id===id?{...u,active:!current}:u));
  }
  async function changePlan(id,plan) {
    await db_adminUpdateUser(id,{plan});
    setUsers(prev=>prev.map(u=>u.id===id?{...u,plan}:u));
  }

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div className="section-title" style={{marginBottom:0}}>Users</div>
        <span className="admin-badge">ADMIN</span>
        <div style={{marginLeft:"auto",fontSize:13,color:C.muted}}>{users.filter(u=>u.role!=="admin").length} pilots</div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Plan</th><th>Joined</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading&&<tr><td colSpan={6} style={{color:C.muted,textAlign:"center",padding:32}}><span className="spinner">⟳</span> Loading…</td></tr>}
              {users.map(u=>(
                <tr key={u.id}>
                  <td style={{fontWeight:500,color:C.white}}>{u.name}</td>
                  <td style={{color:C.silver,fontSize:12}}>{u.email}</td>
                  <td>
                    {u.role==="admin"
                      ? <span className="pill pill-red">Admin</span>
                      : <select style={{background:C.panel,border:`1px solid ${C.border}`,color:C.silver,padding:"4px 8px",borderRadius:6,fontSize:12}} value={u.plan||"starter"} onChange={e=>changePlan(u.id,e.target.value)}>
                          <option value="starter">Starter</option>
                          <option value="pro">Pro</option>
                          <option value="enterprise">Enterprise</option>
                        </select>}
                  </td>
                  <td style={{color:C.muted,fontSize:12}}>{u.joined?.slice?.(0,10)}</td>
                  <td><span className={`pill ${u.active!==false?"pill-green":"pill-muted"}`}>{u.active!==false?"Active":"Suspended"}</span></td>
                  <td>{u.role!=="admin"&&<button className="btn-danger" onClick={()=>toggleActive(u.id,u.active!==false)}>{u.active!==false?"Suspend":"Activate"}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AdminRosters() {
  const [rosters,setRosters]=useState([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{db_adminAllRosters().then(r=>{setRosters(r);setLoading(false);});},[]);
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
        <div className="section-title" style={{marginBottom:0}}>All Rosters</div>
        <span className="admin-badge">ADMIN</span>
        <div style={{marginLeft:"auto",fontSize:13,color:C.muted}}>{rosters.length} total</div>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Pilot</th><th>Period</th><th>Duty days</th><th>Flights</th><th>Uploaded</th></tr></thead>
            <tbody>
              {loading&&<tr><td colSpan={5} style={{color:C.muted,textAlign:"center",padding:32}}><span className="spinner">⟳</span> Loading…</td></tr>}
              {!loading&&rosters.length===0&&<tr><td colSpan={5} style={{color:C.muted,textAlign:"center",padding:32}}>No rosters yet.</td></tr>}
              {rosters.map((r,i)=>(
                <tr key={i}>
                  <td style={{fontWeight:500,color:C.white}}>{r.user_name||r.profiles?.name||"—"}</td>
                  <td><span className="tag">{r.periodLabel||r.period_label}</span></td>
                  <td style={{fontFamily:FM,color:C.orange}}>{r.calendar?.filter(d=>d.flights.length>0).length||0}</td>
                  <td style={{fontFamily:FM,color:C.silver}}>{r.calendar?.reduce((a,d)=>a+d.flights.length,0)||0}</td>
                  <td style={{color:C.muted,fontSize:12}}>{(r.uploadedAt||r.uploaded_at)?.slice(0,10)||"—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
        <p style={{fontSize:13,color:C.muted,marginBottom:16}}>Set these in your <code style={{color:C.teal}}>.env</code> file locally and in Vercel → Project → Settings → Environment Variables.</p>
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
        <p style={{fontSize:13,color:C.muted,marginBottom:16}}>Set via Supabase Dashboard → Edge Functions → Manage secrets. Shared across all pilots — never exposed to the browser.</p>
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
          <div>2. Add <span style={{color:C.teal}}>STRIPE_SECRET_KEY</span> to Supabase secrets</div>
          <div>3. Deploy the webhook Edge Function</div>
          <div>4. Point Stripe webhook → your Edge Function URL</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTALL PROMPT
// Listens for the browser's "beforeinstallprompt" event (fires on Android
// Chrome when the PWA criteria are met) and shows a small dismissible banner
// inviting the pilot to install the app to their home screen.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState("loading");
  const [authMode,setAuthMode]=useState("login");
  const [user,setUser]=useState(null);
  const [page,setPage]=useState("dashboard");
  const [rosters,setRosters]=useState([]);
  const [tails,setTails]=useState({});
  const [isDark,setIsDark]=useState(true);
  const [drawerOpen,setDrawerOpen]=useState(false);
  const [locked,setLocked]=useState(false);
  const [pendingFlight,setPendingFlight]=useState(null); // auto-open a flight on logbook mount
  const idleTimerRef = useRef(null);
  const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

  // Reset idle timer on any user activity
  function resetIdleTimer() {
    if(idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Only start timer when app is active and user is signed in
    if(screen === "app" && user) {
      idleTimerRef.current = setTimeout(()=>{
        setLocked(true);
      }, IDLE_TIMEOUT_MS);
    }
  }

  // Track activity events
  useEffect(()=>{
    if(screen !== "app" || !user) return;
    const events = ["mousedown","mousemove","keydown","touchstart","scroll","click"];
    events.forEach(e=>window.addEventListener(e, resetIdleTimer, {passive:true}));
    resetIdleTimer(); // start timer immediately
    return ()=>{
      events.forEach(e=>window.removeEventListener(e, resetIdleTimer));
      if(idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  },[screen, user]);

  // ── Navigation with back-button support ──────────────────────────────────
  // The app is a SPA — the browser's back button normally has no history to
  // return to and exits the app entirely. Fix: push a history entry on every
  // page change so the browser has real entries to pop, then listen for
  // popstate (back button) and restore the previous page from history state.
  function navigate(newPage) {
    if(newPage === page) return;
    try { sessionStorage.setItem("fl_page", newPage); } catch {}
    window.history.pushState({ page: newPage }, "", "");
    setPage(newPage);
  }

  useEffect(() => {
    function onPopState(e) {
      const prev = e.state?.page;
      if(prev) {
        setPage(prev);
        try { sessionStorage.setItem("fl_page", prev); } catch {}
      } else {
        window.history.pushState({ page: "dashboard" }, "", "");
        setPage("dashboard");
      }
    }
    // Restore page from sessionStorage on refresh
    let restoredPage = "dashboard";
    try { restoredPage = sessionStorage.getItem("fl_page") || "dashboard"; } catch {}
    window.history.replaceState({ page: restoredPage }, "", "");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Initialize theme on mount — read preference, apply, inject style tag
  useEffect(()=>{
    const dark = getThemePref();
    setIsDark(dark);
    applyTheme(dark);
    // Inject the style tag into <head> so it persists across re-renders
    let el = document.getElementById("fl-styles");
    if(!el) {
      el = document.createElement("style");
      el.id = "fl-styles";
      document.head.appendChild(el);
    }
    el.textContent = buildStyles();
  },[]);

  function handleToggleTheme() {
    const next = !isDark;
    setIsDark(next);
    setThemePref(next);
    applyTheme(next);
    // Force a re-render of all components that use C values inline
    // by updating a dummy state that causes the tree to re-render
    setThemeKey(k=>k+1);
  }

  // Dummy counter to force full re-render when theme changes, since C is
  // a mutable object (not React state) — components using inline C.xxx
  // styles won't automatically re-render when C mutates, so we need this.
  const [themeKey,setThemeKey]=useState(0);

  // Restore session on mount — try stored token first, then refresh token
  useEffect(()=>{
    (async()=>{
      try {
        const u=await db_getSession();
        if(u) {
          setUser(u);
          const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
          setRosters(rs); setTails(ts);
          let savedPage = "dashboard";
          try { savedPage = sessionStorage.getItem("fl_page") || savedPage; } catch {}
          const defaultPage = u.role==="admin" ? "admin-overview" : "dashboard";
          const isValidForRole = u.role==="admin"
            ? savedPage.startsWith("admin")
            : !savedPage.startsWith("admin");
          setPage(isValidForRole ? savedPage : defaultPage);
          setScreen("app");
        } else {
          // No stored session — try refresh token before showing landing
          const { data } = await sb.auth.refreshSession();
          if(data?.session) {
            // Refreshed successfully — reload session
            const refreshed = await db_getSession();
            if(refreshed) {
              setUser(refreshed);
              const [rs,ts]=await Promise.all([db_loadRosters(refreshed.id),db_loadTails(refreshed.id)]);
              setRosters(rs); setTails(ts);
              setPage(refreshed.role==="admin"?"admin-overview":"dashboard");
              setScreen("app");
              return;
            }
          }
          setScreen("landing");
        }
      } catch { setScreen("landing"); }
    })();
  },[]);

  async function handleAuth(u) {
    setUser(u);
    try {
      const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
      setRosters(rs); setTails(ts);
    } catch {}
    setPage(u.role==="admin"?"admin-overview":"dashboard");
    setScreen("app");

    // Offer biometric registration if running as PWA, biometrics available,
    // and not already registered on this device
    if(isStandalone() && !localStorage.getItem("fl_webauthn_registered")) {
      try {
        const available = await isWebAuthnAvailable();
        if(available && u.id && u.email) {
          // Small delay so the app screen renders first
          setTimeout(async()=>{
            try {
              const registered = await registerBiometric(u.id, u.email);
              if(registered) console.log("Biometric registered successfully");
            } catch(e) {
              // Non-fatal — biometric registration is optional
              console.warn("Biometric registration skipped:", e.message);
            }
          }, 1500);
        }
      } catch {}
    }
  }

  // Listen for successful biometric sign-in from AppLandingPage
  useEffect(()=>{
    function onBioAuth(e) { handleAuth(e.detail); }
    window.addEventListener("fl-bio-auth", onBioAuth);
    return ()=>window.removeEventListener("fl-bio-auth", onBioAuth);
  }, []);

  async function handleLogout() {
    await db_signOut();
    setUser(null); setRosters([]); setTails({});
    setScreen("landing");
  }

  function handleRosterSaved(roster) {
    setRosters(prev=>[roster,...prev.filter(r=>r.id!==roster.id)]);
    navigate("logbook");
  }

  async function handleDeleteRoster(rosterId) {
    const previous = rosters;
    setRosters(prev=>prev.filter(r=>r.id!==rosterId)); // optimistic
    try {
      await db_deleteRoster(user.id, rosterId);
    } catch(e) {
      setRosters(previous); // restore on failure
      alert(e.message||"Failed to delete roster. Please try again.");
    }
  }

  // Called after a pilot manually adds or removes a flight via the Calendar
  // page — updates the in-memory roster so the UI reflects the change
  // immediately without needing a full reload.
  function handleRosterCalendarUpdated(rosterId, newCalendar) {
    setRosters(prev=>prev.map(r=>r.id===rosterId?{...r,calendar:newCalendar}:r));
  }

  function handleTailSaved(tk, val) {
    setTails(prev=>({...prev,[tk]:val}));
  }

  const pageTitle = {
    dashboard:"Dashboard", calendar:"Roster View", upload:"Upload Roster", logbook:"Logbook",
    settings:"Settings", map:"Route Map", analytics:"Stats", profile:"Profile",
    "admin-overview":"Overview","admin-users":"User Management","admin-rosters":"All Rosters","admin-settings":"Settings"
  }[page]||page;

  return (
    <div key={themeKey}>
      {screen==="loading"&&(
        <div className="loading-screen">
          <div className="loading-logo">Flight<span>Log</span></div>
          <div className="loading-sub"><span className="spinner">⟳</span> Loading…</div>
        </div>
      )}
      {screen==="landing"&&(isStandalone()
        ? <AppLandingPage onAuth={handleAuth}/>
        : <LandingPage
            onLogin={()=>{setAuthMode("login");setScreen("auth");}}
            onSignup={()=>{setAuthMode("signup");setScreen("auth");}}
          />
      )}
      {screen==="auth"&&<AuthPage onAuth={handleAuth} onBack={()=>setScreen("landing")} initialMode={authMode}/>}
      {screen==="app"&&user&&(
        <div className="app-shell">
          {/* Lock screen — overlays everything when idle timeout fires */}
          {locked&&<LockScreen user={user} onUnlock={()=>{setLocked(false);resetIdleTimer();}}/>}
          <Sidebar user={user} page={page} setPage={navigate} onLogout={handleLogout}/>
          <div className="app-content">
            <div className="app-topbar">
              {/* Hamburger — only visible on mobile (sidebar is hidden there) */}
              <button className="hamburger-btn" onClick={()=>setDrawerOpen(true)} aria-label="Menu">☰</button>
              <div className="app-page-title">{pageTitle}</div>
              {user.role==="admin"&&<span className="admin-badge">ADMIN</span>}
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div className="avatar" style={{width:34,height:34,fontSize:13,cursor:"pointer"}} onClick={()=>navigate("profile")} title="View profile">{initials(user.name)}</div>
              </div>
            </div>
            <div className="app-body">
              {page==="dashboard"&&<Dashboard user={user} rosters={rosters} tails={tails} setPage={navigate} onOpenFlight={(flight)=>{setPendingFlight(flight);navigate("logbook");}}/>}
              {page==="calendar"&&<CalendarPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated} onOpenFlight={(flight)=>{setPendingFlight(flight);navigate("logbook");}}/>}
              {page==="upload"&&<UploadPage user={user} onRosterSaved={handleRosterSaved}/>}
              {page==="logbook"&&<LogbookPage user={user} rosters={rosters} tails={tails} onTailSaved={handleTailSaved} onDeleteRoster={handleDeleteRoster} onRosterUpdated={handleRosterCalendarUpdated} pendingFlight={pendingFlight} onPendingFlightConsumed={()=>setPendingFlight(null)}/>}
              {page==="settings"&&<SettingsPage user={user} rosters={rosters} tails={tails} isDark={isDark} onToggleTheme={handleToggleTheme}/>}
              {page==="map"&&<RouteMapPage rosters={rosters} tails={tails}/>}
              {page==="analytics"&&<AnalyticsPage user={user} rosters={rosters} tails={tails}/>}
              {page==="profile"&&<ProfilePage user={user} onUserUpdated={u=>setUser(u)}/>}
              {page==="admin-overview"&&<AdminOverview/>}
              {page==="admin-users"&&<AdminUsers/>}
              {page==="admin-rosters"&&<AdminRosters/>}
              {page==="admin-settings"&&<AdminSettings/>}
            </div>
          </div>
          <HamburgerDrawer
            user={user} page={page}
            setPage={navigate}
            onLogout={handleLogout}
            open={drawerOpen}
            onClose={()=>setDrawerOpen(false)}
          />
        </div>
      )}
      <InstallPrompt/>
    </div>
  );
}
