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
        // Execute the query — called implicitly when awaited
        then(resolve, reject) {
          const isGet = state.method === "GET";
          let url = isGet ? `${base}?select=${state.cols}` : base;
          // For GET: filters go in query string alongside select
          // For PATCH/DELETE: filters go in query string to target specific rows
          const sep = isGet ? "&" : "?";
          let first = true;
          state.filters.forEach(f => {
            url += (first && !isGet ? sep : "&") + f;
            first = false;
          });
          if(isGet && state.orderStr) url += `&order=${state.orderStr}`;
          const headers = h({});
          if(state.prefer) headers["Prefer"] = state.prefer;
          const fetchOpts = { method: state.method, headers };
          if(state.body) fetchOpts.body = JSON.stringify(state.body);
          return fetch(url, fetchOpts).then(async r => {
            const data = await r.json();
            return { data: r.ok ? data : null, error: r.ok ? null : data };
          }).then(resolve, reject);
        },
      };
      return builder;
    }

    return {
      select(cols="*") { return makeBuilder().select(cols); },
      insert(body) {
        const b = makeBuilder("POST", body, "return=representation");
        const origThen = b.then;
        b.then = (resolve, reject) => {
          const url = base;
          const headers = h({"Prefer":"return=representation"});
          return fetch(url, {method:"POST", headers, body:JSON.stringify(body)}).then(async r => {
            const data = await r.json();
            const d = Array.isArray(data)?data[0]:data;
            return { data: r.ok?d:null, error: r.ok?null:data };
          }).then(resolve, reject);
        };
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
      try { sessionStorage.setItem("fl_token", d.access_token); sessionStorage.setItem("fl_user", JSON.stringify(d.user)); } catch{}
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
      // Store token
      try { sessionStorage.setItem("fl_token", d.access_token); sessionStorage.setItem("fl_user", JSON.stringify(d.user)); } catch{}
      return { data:{ user:d.user }, error:null };
    },
    async signOut() {
      sb.auth._token = null; sb.auth._user = null;
      try { sessionStorage.removeItem("fl_token"); sessionStorage.removeItem("fl_user"); } catch{}
    },
    async getUser() {
      if (sb.auth._user && sb.auth._token) return { data:{ user:sb.auth._user } };
      try {
        const u = sessionStorage.getItem("fl_user");
        const t = sessionStorage.getItem("fl_token");
        if (u && t) { sb.auth._user = JSON.parse(u); sb.auth._token = t; return { data:{ user:sb.auth._user } }; }
      } catch{}
      return { data:{ user:null } };
    },
  },
};

// Override fetch headers with auth token when signed in
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
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${C.base};color:${C.ink};font-family:${FB};line-height:1.5}
button{cursor:pointer;font-family:${FB}}
input,textarea,select{font-family:${FB};color-scheme:dark}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-track{background:${C.base}}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:4px}
::placeholder{color:${C.muted}!important}

/* NAV */
.lp-nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;gap:24px;padding:0 48px;height:72px;background:${C.base}ee;backdrop-filter:blur(10px);border-bottom:1px solid ${C.border}}
.lp-logo{font-family:${FD};font-size:22px;font-weight:600;color:${C.ink};letter-spacing:.2px;font-style:italic}
.lp-logo span{color:${C.red};font-style:normal;font-weight:700}
.lp-nav-links{display:flex;gap:32px;margin-left:auto}
.lp-nav-link{font-size:14px;color:${C.silver};transition:color .15s;background:none;border:none}
.lp-nav-link:hover{color:${C.ink}}
.lp-nav-actions{display:flex;align-items:center;gap:10px}
.lp-nav-login{background:none;border:none;color:${C.ink};font-size:14px;font-weight:500;padding:9px 14px;transition:opacity .15s}
.lp-nav-login:hover{opacity:.65}
.lp-nav-cta{background:${C.ink};color:${C.base};border:none;padding:10px 20px;border-radius:7px;font-size:14px;font-weight:600;transition:background .15s}
.lp-nav-cta:hover{background:${C.red}}

/* HERO */
.lp-hero{min-height:92vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:140px 24px 72px;position:relative;overflow:hidden}
.lp-hero-bg{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 70% 50% at 50% -10%,${C.teal}0d 0%,transparent 65%)}
.lp-eyebrow{display:inline-flex;align-items:center;gap:8px;background:${C.surface};border:1px solid ${C.border};color:${C.teal};font-size:12px;font-weight:600;letter-spacing:1.5px;padding:7px 16px;border-radius:100px;margin-bottom:32px;text-transform:uppercase}
.lp-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:${C.teal};animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.lp-headline{font-family:${FD};font-size:clamp(44px,7vw,84px);font-weight:500;line-height:1.04;letter-spacing:-.5px;color:${C.ink};margin-bottom:26px}
.lp-headline em{color:${C.red};font-style:italic;font-weight:600}
.lp-sub{font-size:clamp(16px,1.6vw,19px);color:${C.silver};max-width:520px;margin:0 auto 44px;line-height:1.65}
.lp-hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:56px}
.btn-primary{background:${C.ink};color:${C.base};border:none;padding:14px 30px;border-radius:8px;font-size:15px;font-weight:600;transition:all .15s}
.btn-primary:hover{background:${C.red};transform:translateY(-1px)}
.btn-ghost{background:transparent;color:${C.ink};border:1px solid ${C.border};padding:14px 30px;border-radius:8px;font-size:15px;font-weight:500;transition:all .15s}
.btn-ghost:hover{border-color:${C.ink}}

/* Signature element: a logbook ruler — a hairline with tick marks like the
   time-scale on a printed flight log, with a single red marker indicating
   "logged so far". Quiet, literal, on-brand. No looping animation; this is
   a still, confident mark rather than a decorative loop. */
.ledger{width:100%;max-width:640px;margin:0 auto;position:relative}
.ledger-line{position:relative;height:1px;background:${C.border};margin-bottom:10px}
.ledger-ticks{display:flex;justify-content:space-between;position:absolute;top:-5px;left:0;right:0}
.ledger-tick{width:1px;height:10px;background:${C.border}}
.ledger-tick.major{height:14px;background:${C.silver}}
.ledger-fill{position:absolute;left:0;top:0;height:1px;width:38%;background:${C.red}}
.ledger-marker{position:absolute;left:38%;top:-4px;width:9px;height:9px;border-radius:50%;background:${C.red};transform:translateX(-50%)}
.ledger-caption{display:flex;justify-content:space-between;font-family:${FM};font-size:11px;color:${C.muted};letter-spacing:.5px;margin-top:14px}


.lp-stats{display:flex;justify-content:center;border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};flex-wrap:wrap}
.lp-stat{padding:28px 40px;border-right:1px solid ${C.border};text-align:center}
.lp-stat:last-child{border-right:none}
.lp-stat-num{font-family:${FD};font-size:38px;font-weight:600;color:${C.ink}}
.lp-stat-lbl{font-size:13px;color:${C.silver};margin-top:4px}

/* FEATURES */
.lp-section{padding:96px 48px;max-width:1100px;margin:0 auto}
.lp-section-eyebrow{font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${C.teal};margin-bottom:12px}
.lp-section-title{font-family:${FD};font-size:clamp(30px,3.6vw,46px);font-weight:500;color:${C.ink};margin-bottom:16px;line-height:1.15}
.lp-section-sub{font-size:16px;color:${C.silver};max-width:520px}
.features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;margin-top:48px}
.feature-card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:28px;transition:border-color .2s,transform .2s}
.feature-card:hover{border-color:${C.red}66;transform:translateY(-2px)}
.feature-icon{width:42px;height:42px;border-radius:10px;background:${C.panel};display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:16px}
.feature-title{font-size:16px;font-weight:600;color:${C.ink};margin-bottom:8px}
.feature-desc{font-size:14px;color:${C.silver};line-height:1.6}

/* PRICING */
.pricing-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:48px}
.price-card{background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:32px;position:relative}
.price-card.featured{border-color:${C.ink};box-shadow:0 4px 24px ${C.ink}0d}
.price-badge{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:${C.ink};color:${C.base};font-size:11px;font-weight:700;padding:4px 14px;border-radius:100px;letter-spacing:1px;white-space:nowrap}
.price-plan{font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:${C.silver};margin-bottom:8px}
.price-amount{font-family:${FD};font-size:46px;font-weight:600;color:${C.ink};line-height:1}
.price-period{font-size:14px;color:${C.muted};margin-left:4px}
.price-desc{font-size:13px;color:${C.silver};margin:12px 0 24px}
.price-features{list-style:none;display:flex;flex-direction:column;gap:10px;margin-bottom:28px}
.price-features li{font-size:13px;color:${C.silver};display:flex;align-items:center;gap:8px}
.price-features li::before{content:"✓";color:${C.teal};font-weight:700;flex-shrink:0}
.price-cta{width:100%;padding:12px;border-radius:8px;font-size:14px;font-weight:600;border:none;letter-spacing:.2px;transition:all .15s}
.price-cta-primary{background:${C.ink};color:${C.base}}
.price-cta-primary:hover{background:${C.red}}
.price-cta-ghost{background:transparent;color:${C.ink};border:1px solid ${C.border}}
.price-cta-ghost:hover{border-color:${C.ink}}

/* HOW */
.how-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));background:${C.surface};border-radius:14px;border:1px solid ${C.border};margin-top:48px}
.how-step{padding:32px 24px;border-right:1px solid ${C.border}}
.how-step:last-child{border-right:none}
.how-num{font-family:${FD};font-size:44px;font-weight:500;color:${C.border};line-height:1;margin-bottom:12px;font-style:italic}
.how-title{font-size:15px;font-weight:600;color:${C.ink};margin-bottom:6px}
.how-desc{font-size:13px;color:${C.silver};line-height:1.6}

/* FOOTER */
.lp-footer{border-top:1px solid ${C.border};padding:40px 48px;display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.lp-footer-copy{font-size:13px;color:${C.muted};margin-left:auto}

/* AUTH */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:${C.base}}
.auth-card{background:${C.surface};border:1px solid ${C.border};border-radius:16px;padding:40px;width:100%;max-width:420px;box-shadow:0 8px 40px ${C.ink}08}
.auth-logo{font-family:${FD};font-size:26px;font-weight:500;color:${C.ink};text-align:center;margin-bottom:4px;font-style:italic}
.auth-logo span{color:${C.red};font-style:normal;font-weight:700}
.auth-tagline{font-size:13px;color:${C.silver};text-align:center;margin-bottom:32px}
.auth-tabs{display:flex;background:${C.panel};border-radius:8px;padding:4px;margin-bottom:28px}
.auth-tab{flex:1;padding:8px;text-align:center;font-size:13px;font-weight:500;color:${C.muted};border:none;background:transparent;border-radius:6px;transition:all .15s}
.auth-tab.active{background:${C.surface};color:${C.ink};box-shadow:0 1px 3px ${C.ink}14}
.form-group{margin-bottom:16px}
.form-label{display:block;font-size:12px;font-weight:600;color:${C.silver};letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px}
.form-input{width:100%;background:${C.panel};border:1px solid ${C.border};color:${C.ink};padding:11px 14px;border-radius:10px;font-size:14px;outline:none;transition:border-color .15s}
.form-input:focus{border-color:${C.teal}}
.form-input:focus{border-color:${C.teal}}
.form-input::placeholder{color:${C.muted}}
.form-select{width:100%;background:${C.base};border:1px solid ${C.border};color:${C.ink};padding:11px 14px;border-radius:8px;font-size:14px;outline:none}
.btn-full{width:100%;padding:13px;border-radius:8px;font-size:15px;font-weight:600;border:none;background:${C.ink};color:${C.base};letter-spacing:.2px;transition:background .15s;margin-top:8px}
.btn-full:hover{background:${C.red}}
.btn-full:disabled{opacity:.6;cursor:not-allowed}
.auth-error{background:${C.red}14;border:1px solid ${C.red}33;color:${C.redDim};font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:16px}
.auth-success{background:${C.green}14;border:1px solid ${C.green}33;color:${C.green};font-size:13px;padding:10px 14px;border-radius:8px;margin-bottom:16px}
.auth-back{background:none;border:none;color:${C.teal};font-size:13px;margin-top:20px;display:block;text-align:center}

/* APP SHELL */
.app-shell{display:flex;min-height:100vh}
.sidebar{width:224px;background:${C.surface};border-right:1px solid ${C.border};display:flex;flex-direction:column;position:fixed;top:0;left:0;bottom:0;z-index:50}
.sidebar-logo{padding:20px 20px 16px;border-bottom:1px solid ${C.border}}
.sidebar-logo-text{font-family:${FD};font-size:21px;font-weight:500;color:${C.ink};font-style:italic}
.sidebar-logo-text span{color:${C.teal};font-style:normal;font-weight:700}
.sidebar-plan{font-size:10px;color:${C.muted};letter-spacing:1px;text-transform:uppercase;margin-top:2px}
.sidebar-nav{flex:1;padding:16px 12px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.sidebar-section{font-size:10px;color:${C.muted};letter-spacing:1.5px;text-transform:uppercase;padding:12px 8px 6px}
.sidebar-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;font-size:13px;color:${C.silver};background:none;border:none;width:100%;text-align:left;transition:all .15s}
.sidebar-item:hover{background:${C.panel};color:${C.ink}}
.sidebar-item.active{background:${C.teal}22;color:${C.teal}}
.sidebar-item-icon{font-size:15px;width:20px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:16px 12px;border-top:1px solid ${C.border}}
.sidebar-user{display:flex;align-items:center;gap:10px}
.avatar{width:34px;height:34px;border-radius:50%;background:${C.teal}22;border:1px solid ${C.teal}44;display:flex;align-items:center;justify-content:center;font-family:${FD};font-size:14px;font-weight:600;color:${C.teal};flex-shrink:0}
.sidebar-user-name{font-size:13px;font-weight:600;color:${C.ink}}
.sidebar-user-role{font-size:11px;color:${C.muted}}
.sidebar-logout{background:none;border:none;color:${C.muted};font-size:18px;margin-left:auto;padding:4px;transition:color .15s}
.sidebar-logout:hover{color:${C.red}}
.app-content{margin-left:224px;flex:1;min-height:100vh}
.app-topbar{height:56px;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 28px;gap:16px;position:sticky;top:0;z-index:40;backdrop-filter:blur(12px)}
.app-page-title{font-family:${FD};font-size:19px;font-weight:500;color:${C.ink};flex:1}
.app-body{padding:28px}

/* HAMBURGER BUTTON — only visible on mobile, sidebar handles desktop nav */
.hamburger-btn{display:none}

/* DASHBOARD */
.dash-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(176px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:20px 22px}
.stat-card-label{font-size:11px;color:${C.muted};letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.stat-card-val{font-family:${FM};font-size:27px;color:${C.ink};font-weight:500}
.stat-card-sub{font-size:12px;color:${C.muted};margin-top:4px}
.dash-2col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dash-panel{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:22px}
.dash-panel-title{font-size:13px;font-weight:600;color:${C.silver};margin-bottom:16px}
.recent-flight{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid ${C.border}44}
.recent-flight:last-child{border-bottom:none}
.rf-num{font-family:${FM};font-size:12px;color:${C.orange};min-width:70px}
.rf-route{font-size:13px;font-weight:600;color:${C.white};flex:1}
.rf-time{font-family:${FM};font-size:12px;color:${C.muted}}
.rf-tail{font-size:11px;color:${C.teal};background:${C.teal}18;padding:2px 8px;border-radius:4px}

/* UPLOAD */
.upload-zone{background:${C.panel};border:1.5px dashed ${C.border};border-radius:14px;padding:56px 32px;text-align:center;cursor:pointer;transition:all .2s}
.upload-zone:hover,.upload-zone.drag{border-color:${C.ink}66;background:${C.surface}}
.upload-zone h3{font-size:17px;color:${C.ink};margin-bottom:6px;font-weight:500}
.upload-zone p{font-size:13px;color:${C.muted}}
.upload-icon{font-size:42px;margin-bottom:18px;display:block}
.upload-info-panel{background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:6px 24px}
.upload-info-row{display:flex;gap:18px;align-items:flex-start;padding:20px 0;border-bottom:1px solid ${C.border}}
.upload-info-row:last-child{border-bottom:none}
.upload-info-icon{font-size:19px;width:34px;height:34px;border-radius:9px;background:${C.panel};display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.upload-info-title{font-size:14px;font-weight:600;color:${C.ink};margin-bottom:4px;letter-spacing:-.1px}
.upload-info-desc{font-size:13px;color:${C.silver};line-height:1.6}

/* CALENDAR */
.cal-month-title{font-family:${FD};font-size:22px;font-weight:500;color:${C.ink};font-style:italic}
.cal-legend{display:flex;gap:16px}
.cal-legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:${C.silver}}
.cal-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.cal-dot.flown{background:${C.teal}}
.cal-dot.scheduled{background:${C.gold}}
.cal-dot.duty{background:${C.gold}77}
.cal-dot.off{background:${C.border};border:1px solid ${C.muted}}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.cal-weekday{font-size:11px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:${C.muted};text-align:center;padding-bottom:6px}
.cal-cell{background:${C.surface};border:1px solid ${C.border};border-radius:8px;min-height:78px;padding:8px;cursor:pointer;transition:all .15s;display:flex;flex-direction:column;gap:2px}
.cal-cell:hover{border-color:${C.ink}55}
.cal-cell-blank{background:transparent;border:none;cursor:default}
.cal-cell.today{border-color:${C.red};border-width:1.5px}
.cal-cell.selected{box-shadow:0 0 0 2px ${C.ink}}
.cal-cell.off{background:${C.panel}}
.cal-cell.scheduled{border-left:3px solid ${C.gold}}
.cal-cell.duty{border-left:3px solid ${C.gold}55;background:${C.gold}08}
.cal-cell.flown{border-left:3px solid ${C.teal}}
.cal-cell-day{font-family:${FM};font-size:12px;color:${C.ink};font-weight:500}
.cal-cell-route{font-size:11px;color:${C.silver};margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cal-cell-legs{font-size:10px;color:${C.muted};margin-top:auto}
.cal-detail{margin-top:20px;background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:20px}
.cal-detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.cal-detail-title{font-family:${FD};font-size:17px;font-weight:500;color:${C.ink};font-style:italic}
.cal-detail-close{background:none;border:none;color:${C.muted};font-size:16px;cursor:pointer;padding:4px}
.cal-detail-close:hover{color:${C.ink}}
.cal-detail-off{color:${C.muted};font-size:13px;font-style:italic}
.cal-detail-flights{display:flex;flex-direction:column;gap:8px}
.cal-detail-flight{display:grid;grid-template-columns:80px 100px 130px 60px 90px 28px;gap:10px;align-items:center;background:${C.panel};padding:10px 14px;border-radius:8px;font-size:13px}
.cal-detail-flight-num{font-family:${FM};color:${C.red};font-size:12px}
.cal-detail-flight-route{font-weight:600;color:${C.ink}}
.cal-detail-flight-time{font-family:${FM};font-size:11px;color:${C.muted}}
.cal-detail-flight-block{font-family:${FM};font-size:12px;font-weight:600}
.cal-detail-flight-tail{font-family:${FM};font-size:11px;color:${C.teal};background:${C.teal}14;padding:2px 8px;border-radius:4px;text-align:center}
.cal-detail-flight-del{background:none;border:none;color:${C.muted};font-size:13px;cursor:pointer;padding:4px;justify-self:end;transition:color .15s}
.cal-detail-flight-del:hover{color:${C.red}}
.cal-add-form{margin-top:14px;background:${C.panel};border:1px solid ${C.border};border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px}
.cal-add-row{display:flex;gap:8px;flex-wrap:wrap}
.cal-add-row .form-input{padding:8px 10px;font-size:13px}
.cal-add-narrow{max-width:110px}

/* LOGBOOK */
.month-tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.month-tab{background:${C.panel};border:1px solid ${C.border};color:${C.silver};padding:6px 16px;border-radius:100px;font-size:12px;font-weight:500;transition:all .15s}
.month-tab.active{background:${C.orange}22;border-color:${C.orange};color:${C.orange}}
.progress-bar-wrap{background:${C.panel};border-radius:100px;height:6px;margin-bottom:24px;overflow:hidden}
.progress-bar-fill{height:100%;background:linear-gradient(90deg,${C.teal},${C.orange});border-radius:100px;transition:width .4s}
.day-card{background:${C.surface};border:1px solid ${C.border};border-radius:14px;margin-bottom:8px;overflow:hidden;transition:border-color .15s}
.day-card.today-card{border-color:${C.teal}55}
.day-card.logged-card{border-color:${C.green}44}
.day-card-header{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;user-select:none}
.day-date{font-family:${FM};font-size:13px;color:${C.teal};min-width:72px}
.day-dot{width:8px;height:8px;border-radius:50%;border:1.5px solid ${C.muted};flex-shrink:0}
.day-dot.all{background:${C.green};border-color:${C.green}}
.day-dot.partial{background:${C.gold};border-color:${C.gold}}
.day-summary-text{flex:1;font-size:13px;color:${C.silver}}
.day-ft{font-family:${FM};font-size:12px;color:${C.muted}}
.day-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;border-top:1px solid ${C.border}44}
.col-heads-2row{display:grid;grid-template-columns:84px 48px 48px 120px 70px 60px;gap:6px;padding:0 4px}
.col-head{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:${C.muted}}
.flight-row-2line{background:${C.panel};border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;border:1px solid ${C.border}55}
.flight-row-top{display:grid;grid-template-columns:84px 48px 48px 120px 70px 60px;gap:6px;align-items:center}
.flight-row-bottom{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid ${C.border}33}
.fr-num{font-family:${FM};font-size:12px;color:${C.teal}}
.fr-apt{font-size:13px;font-weight:600;color:${C.ink}}
.fr-time{font-family:${FM};font-size:11px;color:${C.muted}}
.fr-ac{font-size:12px;color:${C.muted}}
.fr-time-edit{display:flex;align-items:center;gap:3px}
.fr-time-input{background:${C.surface};border:1px solid ${C.teal}55;color:${C.ink};padding:3px 5px;border-radius:6px;font-family:${FM};font-size:11px;width:48px;outline:none;text-align:center}
.fr-time-input:focus{border-color:${C.teal}}
.fr-input{background:${C.surface};border:1px solid ${C.border};color:${C.ink};padding:6px 10px;border-radius:8px;font-family:${FM};font-size:12px;width:120px;text-transform:uppercase;outline:none;transition:border-color .15s}
.fr-input:focus{border-color:${C.teal}}
.fr-input.saved{border-color:${C.green}55}
.fr-lookup{background:${C.teal}18;border:1px solid ${C.teal}44;color:${C.teal};padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;white-space:nowrap;transition:all .15s}
.fr-lookup:hover{background:${C.teal}30}
.fr-lookup:disabled{opacity:.5;cursor:not-allowed}
.fr-save{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;transition:all .15s;white-space:nowrap}
.fr-save:hover{border-color:${C.teal}66;color:${C.teal}}
.fr-save.ok{border-color:${C.green}66;color:${C.green}}

/* ADMIN */
.admin-badge{background:${C.red}14;border:1px solid ${C.red}33;color:${C.redDim};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:1px;text-transform:uppercase}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{background:${C.panel};color:${C.muted};font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:10px 14px;text-align:left;border-bottom:1px solid ${C.border};white-space:nowrap}
.data-table td{padding:11px 14px;border-bottom:1px solid ${C.border};vertical-align:middle}
.data-table tr:hover td{background:${C.panel}}
.pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:100px;font-size:11px;font-weight:600}
.pill-green{background:${C.green}14;color:${C.green}}
.pill-orange{background:${C.red}14;color:${C.redDim}}
.pill-muted{background:${C.muted}1f;color:${C.silver}}
.pill-red{background:${C.red}14;color:${C.redDim}}
.pill-teal{background:${C.teal}14;color:${C.tealDim}}

/* SHARED */
.section-title{font-family:${FD};font-size:22px;font-weight:500;color:${C.ink};margin-bottom:4px}
.section-sub{font-size:13px;color:${C.muted};margin-bottom:20px}
.card{background:${C.surface};border:1px solid ${C.border};border-radius:14px;padding:22px}
.btn-teal{background:${C.teal};color:#fff;border:none;padding:11px 24px;border-radius:10px;font-size:14px;font-weight:600;transition:background .15s}
.btn-teal:hover{background:${C.tealDim}}
.btn-teal:disabled{opacity:.6;cursor:not-allowed}
.btn-orange{background:${C.teal};color:#fff;border:none;padding:11px 24px;border-radius:10px;font-size:14px;font-weight:600;transition:background .15s}
.btn-orange:hover{background:${C.tealDim}}
.btn-orange:disabled{opacity:.6;cursor:not-allowed}
.btn-sm-ghost{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:6px 14px;font-size:12px;border-radius:8px;transition:all .15s}
.btn-sm-ghost:hover{border-color:${C.teal}55;color:${C.ink}}
.btn-danger{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red};padding:6px 14px;font-size:12px;border-radius:8px;transition:all .15s}
.btn-danger:hover{background:${C.red}28}
.notice{background:${C.teal}0d;border:1px solid ${C.teal}33;border-radius:8px;padding:12px 16px;font-size:13px;color:${C.tealDim};margin-bottom:16px}
.warn{background:${C.gold}0d;border:1px solid ${C.gold}40;border-radius:8px;padding:12px 16px;font-size:13px;color:${C.gold};margin-bottom:16px}
.parse-status{display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:8px;font-size:13px;margin-top:12px}
.parse-status.loading{background:${C.teal}18;border:1px solid ${C.teal}33;color:${C.teal}}
.parse-status.success{background:${C.green}18;border:1px solid ${C.green}33;color:${C.green}}
.parse-status.error{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red}}
.spinner{display:inline-block;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{0%{left:-40%}100%{left:120%}}
.empty-state{text-align:center;padding:60px 24px;color:${C.muted};font-size:14px}
.empty-icon{font-size:48px;margin-bottom:12px;opacity:.4}
.tag{display:inline-flex;background:${C.panel};border:1px solid ${C.border};color:${C.silver};font-size:11px;padding:3px 10px;border-radius:6px}
.divider{height:1px;background:${C.border};margin:20px 0}
.table-wrap{overflow-x:auto}

/* LOADING SCREEN */
.loading-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;background:${C.base}}
.loading-logo{font-family:${FD};font-size:30px;font-weight:500;color:${C.ink};font-style:italic}
.loading-logo span{color:${C.red};font-style:normal;font-weight:700}
.loading-sub{font-size:13px;color:${C.muted}}

@media(max-width:768px){
  .sidebar{display:none}
  .app-content{margin-left:0}
  .app-body{padding-bottom:24px}
  .mobile-nav{display:none}
  /* Hamburger button in topbar */
  .hamburger-btn{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;border:none;background:none;color:${C.ink};font-size:20px;cursor:pointer;flex-shrink:0}
  /* Drawer overlay */
  .drawer-overlay{display:block;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:90;animation:fadeIn .15s ease}
  /* Drawer panel */
  .drawer-panel{position:fixed;top:0;left:0;bottom:0;width:76vw;max-width:300px;background:${C.surface};border-right:1px solid ${C.border};z-index:91;display:flex;flex-direction:column;padding:0;animation:slideInLeft .18s ease;overflow-y:auto}
  .drawer-header{padding:20px 20px 12px;border-bottom:1px solid ${C.border};display:flex;align-items:center;justify-content:space-between}
  .drawer-logo{font-size:20px;font-weight:700;color:${C.ink}}
  .drawer-logo span{color:${C.teal}}
  .drawer-close{background:none;border:none;color:${C.muted};font-size:20px;cursor:pointer;padding:4px}
  .drawer-nav{padding:12px 10px;flex:1}
  .drawer-item{display:flex;align-items:center;gap:12px;padding:11px 12px;border-radius:10px;border:none;background:none;color:${C.silver};font-size:14px;width:100%;text-align:left;cursor:pointer;transition:all .12s}
  .drawer-item:hover{background:${C.panel};color:${C.ink}}
  .drawer-item.active{background:${C.teal}22;color:${C.teal};font-weight:600}
  .drawer-item-icon{font-size:17px;width:24px;text-align:center;flex-shrink:0}
  .drawer-footer{padding:16px;border-top:1px solid ${C.border}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes slideInLeft{from{transform:translateX(-100%)}to{transform:translateX(0)}}
  .dash-2col{grid-template-columns:1fr}
  .col-heads-2row,.flight-row-top{grid-template-columns:64px 38px 38px 1fr 50px 40px}
  .lp-nav{padding:0 16px;gap:8px}
  .lp-nav-links{display:none}
  .lp-logo{font-size:19px}
  .lp-nav-login{padding:8px 10px;font-size:13px}
  .lp-nav-cta{padding:8px 14px;font-size:13px}
  .lp-section{padding:60px 16px}
  .cal-cell{min-height:58px;padding:5px}
  .cal-cell-route{font-size:9px}
  .cal-cell-legs{display:none}
  .cal-detail-flight{grid-template-columns:1fr 1fr auto;grid-template-areas:"num route del" "time block block" "tail tail tail";row-gap:4px}
  .cal-detail-flight-num{grid-area:num}
  .cal-detail-flight-route{grid-area:route;text-align:right}
  .cal-detail-flight-time{grid-area:time}
  .cal-detail-flight-block{grid-area:block;text-align:right}
  .cal-detail-flight-tail{grid-area:tail}
  .cal-detail-flight-del{grid-area:del}
}
`; } // end buildStyles

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const fmtMins = m => !m||isNaN(m) ? "0:00" : `${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;
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
const schedMins = (f) => {
  if (f.schedBlockMins!=null) return f.schedBlockMins;
  const naive = flightMins(f.depTime,f.arrTime);
  return naive <= 480 ? naive : null;
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
  const r = await fetch(`${SUPA_URL}/functions/v1/lookup-flight`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPA_ANON}`,
      "apikey": SUPA_ANON,
    },
    body: JSON.stringify({ flightNum, date, depTime }),
  });
  const data = await r.json();
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

async function db_signUp(email, password, name, plan) {
  if(isConfigured()) {
    const {data,error} = await sb.auth.signUp({email,password,options:{data:{name,plan}}});
    if(error) throw new Error(error.message||"Sign up failed");
    return data.user;
  }
  // local fallback
  const users = local.get("fl_users")||[];
  if(users.find(u=>u.email===email)) throw new Error("Email already registered.");
  const user = {id:"u"+Date.now(),email,name,plan,role:"pilot",joined:new Date().toISOString().slice(0,10),active:true};
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
    return (data||[]).map(r=>({id:r.id,periodLabel:r.period_label,year:r.year,monthNum:r.month_num,calendar:r.calendar,uploadedAt:r.uploaded_at}));
  }
  return local.get("fl_rosters_"+userId)||[];
}

async function db_saveRoster(userId, roster) {
  if(isConfigured()) {
    const {data,error} = await sb.from("rosters").insert({user_id:userId,period_label:roster.periodLabel,year:roster.year,month_num:roster.monthNum,calendar:roster.calendar});
    if(error) throw new Error("Failed to save roster");
    return {...roster, id:data?.id||roster.id};
  }
  const list = local.get("fl_rosters_"+userId)||[];
  list.unshift(roster);
  local.set("fl_rosters_"+userId, list);
  return roster;
}

async function db_deleteRoster(userId, rosterId) {
  if(isConfigured()) { await sb.from("rosters").delete("id=eq."+rosterId); return; }
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
    await sb.from("tail_logs").upsert(payload);
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
        const user = await db_signUp(email,password,name,plan);
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
        {configured && <div className="notice" style={{fontSize:12}}>✓ Connected to Supabase</div>}

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

        {err && <div className="auth-error">{err}</div>}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Full name</label>
            <input className="form-input" placeholder="Captain Jane Smith" value={name} onChange={e=>setName(e.target.value)}/>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" placeholder="you@airline.com" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username"/>
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} autoComplete={mode==="login"?"current-password":"new-password"}/>
        </div>
        {mode==="login" && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
            <button
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
        <button className="btn-full" onClick={submit} disabled={loading}>
          {loading ? <span className="spinner">⟳</span> : mode==="login"?"Log in":"Create account"}
        </button>
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
    {id:"dashboard",icon:"◈",label:"Dashboard"},
    {id:"calendar",icon:"📅",label:"Calendar"},
    {id:"upload",icon:"↑",label:"Upload Roster"},
    {id:"logbook",icon:"📋",label:"Logbook"},
    {id:"map",icon:"🗺",label:"Route Map"},
    {id:"analytics",icon:"📊",label:"Analytics"},
    {id:"settings",icon:"⚙",label:"Settings"},
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
    {id:"dashboard",  icon:"◈",  label:"Dashboard"},
    {id:"calendar",   icon:"📅", label:"Calendar"},
    {id:"upload",     icon:"↑",  label:"Upload Roster"},
    {id:"logbook",    icon:"📋", label:"Logbook"},
    {id:"map",        icon:"🗺", label:"Route Map"},
    {id:"analytics",  icon:"📊", label:"Analytics"},
    {id:"settings",   icon:"⚙",  label:"Settings"},
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
function Dashboard({user,rosters,tails,setPage}) {
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

  return (
    <div>
      <div style={{marginBottom:24}}>
        <div className="section-title">Welcome back, {user.name?.split(" ")[0]} ✈</div>
        <div className="section-sub">{new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</div>
      </div>
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
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <div style={{fontSize:14,fontWeight:600,color:C.ink}}>{reviewRoster.periodLabel}</div>
            <div style={{fontSize:12,color:C.muted}}>{dutyDays.length} duty days · {dutyDays.reduce((a,d)=>a+d.flights.length,0)} flights</div>
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
function CalendarPage({user, rosters, tails, onRosterUpdated}) {
  const [selRoster,setSelRoster]=useState(0);
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
                  <div className="cal-detail-flight" key={fi}>
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
function LogbookPage({user, rosters, tails, onTailSaved, onDeleteRoster, onRosterUpdated}) {
  const [sel,setSel]=useState(0);
  const [exp,setExp]=useState({});
  const [tmp,setTmp]=useState({});
  const [lkStatus,setLkStatus]=useState({});
  const [saving,setSaving]=useState({});
  const [editingTimes,setEditingTimes]=useState({}); // tk -> bool
  const [timeEdits,setTimeEdits]=useState({}); // tk -> {actualDep, actualArr}
  const [addingDay,setAddingDay]=useState(null); // di of the day currently showing the add-flight form
  const [addForm,setAddForm]=useState({flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
  const [savingFlight,setSavingFlight]=useState(false);
  const [editingSched,setEditingSched]=useState(null); // tk of the flight whose scheduled info is being corrected
  const [schedForm,setSchedForm]=useState({flightNum:"",dep:"",arr:"",depTime:"",arrTime:""});
  const [savingSched,setSavingSched]=useState(false);

  const roster=rosters[sel];
  if(!roster) return (
    <div><div className="section-title">Logbook</div>
      <div className="empty-state"><div className="empty-icon">📋</div>No rosters yet.</div></div>
  );

  const totalFlights=roster.calendar?.reduce((a,d)=>a+d.flights.length,0)||0;
  const logged=roster.calendar?.reduce((a,d,di)=>a+d.flights.filter((_,fi)=>tails[`${roster.id}-${di}-${fi}`]?.tail).length,0)||0;

  function fkey(di,fi){return `${di}-${fi}`;}
  function tkey(di,fi){return `${roster.id}-${di}-${fi}`;}

  async function saveTail(di,fi) {
    const k=fkey(di,fi), tk=tkey(di,fi);
    const existing=tails[tk]||{};
    // If the pilot hasn't actually typed anything into the field (tmp[tk] is
    // still undefined — e.g. they just tapped the Save/Edit button without
    // editing), fall back to whatever value is already saved rather than
    // submitting an empty string and wiping the tail number.
    const val=(tmp[tk] ?? existing.tail ?? "").trim().toUpperCase();
    if(!val) { alert("Enter a tail number before saving."); return; }
    setSaving(p=>({...p,[tk]:true}));
    // Manually saving a tail number is an explicit pilot confirmation —
    // lock it immediately so the automatic sync never overwrites it later.
    await db_saveTail(user.id, roster.id, k, val, existing.actualDep, existing.actualArr, existing.actualBlockMins, true);
    onTailSaved(tk, {tail:val, actualDep:existing.actualDep||"", actualArr:existing.actualArr||"", actualBlockMins:existing.actualBlockMins??null, finalSynced:true, cancelled:existing.cancelled||false, updatedAt:new Date().toISOString()});
    // Clear the local shadow value now that the server has the confirmed
    // value — otherwise tmp[tk] would permanently override entry.tail (the
    // real server truth) in the tv computation, even after future reloads
    // within the same session, masking any further legitimate changes.
    setTmp(p=>{ const n={...p}; delete n[tk]; return n; });
    setSaving(p=>({...p,[tk]:false}));
  }

  async function autoLookup(di,fi,f,day) {
    const tk=tkey(di,fi);
    setLkStatus(p=>({...p,[tk]:"loading"}));
    try {
      const date=`${roster.year}-${String(roster.monthNum+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const res=await lookupFlight(f.flightNum,date,f.depTime);
      setLkStatus(p=>({...p,[tk]:res.tailNumber?"done":"notfound"}));
      if(res.tailNumber) {
        setTmp(p=>({...p,[tk]:res.tailNumber}));
        const existing=tails[tk]||{};
        const newDep=res.actualDepTime||existing.actualDep||"";
        const newArr=res.actualArrTime||existing.actualArr||"";
        const newBlockMins=res.actualBlockMins ?? existing.actualBlockMins ?? null;
        await db_saveTail(user.id,roster.id,fkey(di,fi),res.tailNumber,newDep,newArr,newBlockMins);
        onTailSaved(tk,{tail:res.tailNumber, actualDep:newDep, actualArr:newArr, actualBlockMins:newBlockMins, finalSynced:existing.finalSynced||false, cancelled:existing.cancelled||false, updatedAt:new Date().toISOString()});
      }
    } catch { setLkStatus(p=>({...p,[tk]:"error"})); }
  }

  function startEditTimes(di, fi, f) {
    const tk=tkey(di,fi);
    const entry=tails[tk]||{};
    const hasActualTimes = !!(entry.actualDep && entry.actualArr);
    // Pre-fill with whatever is currently showing:
    // - If synced actual times exist → pre-fill those (editing actual)
    // - If not yet synced → pre-fill with scheduled times from roster (editing scheduled)
    // Either way the pilot sees the current values and can correct them.
    const dep  = hasActualTimes ? entry.actualDep  : (f?.depTime  || "");
    const arr  = hasActualTimes ? entry.actualArr  : (f?.arrTime  || "");
    const block = entry.actualBlockMins!=null
      ? fmtMins(entry.actualBlockMins)
      : (schedMins(f)!=null ? fmtMins(schedMins(f)) : "");
    setTimeEdits(p=>({...p,[tk]:{actualDep:dep, actualArr:arr, blockHr:block, editingActual:hasActualTimes}}));
    setEditingTimes(p=>({...p,[tk]:true}));
  }

  function cancelEditTimes(tk) {
    setEditingTimes(p=>({...p,[tk]:false}));
  }

  function parseBlockHrToMins(str) {
    // Accepts "1:30" or "1.5" style input, returns minutes or null
    const s=(str||"").trim();
    if(!s) return null;
    const colonMatch=s.match(/^(\d{1,2}):(\d{2})$/);
    if(colonMatch) return parseInt(colonMatch[1])*60+parseInt(colonMatch[2]);
    const num=parseFloat(s);
    if(!isNaN(num)) return Math.round(num*60);
    return null;
  }

  async function saveTimes(di,fi) {
    const k=fkey(di,fi), tk=tkey(di,fi);
    const edit=timeEdits[tk]||{};
    const existing=tails[tk]||{};
    const dep=(edit.actualDep||"").trim();
    const arr=(edit.actualArr||"").trim();
    const manualBlockMins = parseBlockHrToMins(edit.blockHr);
    setSaving(p=>({...p,[tk]:true}));

    if(edit.editingActual) {
      // Editing actual synced times — save to tail_logs as before
      await db_saveTail(user.id, roster.id, k, existing.tail||"", dep, arr, manualBlockMins, true);
      onTailSaved(tk, {tail:existing.tail||"", actualDep:dep, actualArr:arr, actualBlockMins:manualBlockMins, finalSynced:true, cancelled:existing.cancelled||false, updatedAt:new Date().toISOString()});
    } else {
      // Editing scheduled times — update the roster calendar directly
      // (same mechanism as the old "Edit scheduled" flow) so the roster's
      // printed times get corrected. Block mins also saved if provided.
      const newCalendar=[...roster.calendar];
      const newFlights=[...newCalendar[di].flights];
      newFlights[fi]={...newFlights[fi], depTime:dep||newFlights[fi].depTime, arrTime:arr||newFlights[fi].arrTime};
      if(manualBlockMins!=null) newFlights[fi]={...newFlights[fi], schedBlockMins:manualBlockMins};
      newCalendar[di]={...newCalendar[di],flights:newFlights};
      try {
        await db_updateRosterCalendar(user.id, roster.id, newCalendar);
        onRosterUpdated(roster.id, newCalendar);
      } catch(e) {
        alert(e.message||"Failed to save times.");
      }
    }

    setSaving(p=>({...p,[tk]:false}));
    setEditingTimes(p=>({...p,[tk]:false}));
  }

  function resetAddForm() {
    setAddForm({flightNum:"",dep:"",arr:"",depTime:"",arrTime:"",acType:""});
    setAddingDay(null);
  }

  async function saveNewFlight(di) {
    const fn=addForm.flightNum.trim(), dep=addForm.dep.trim().toUpperCase(), arr=addForm.arr.trim().toUpperCase();
    const depTime=addForm.depTime.trim(), arrTime=addForm.arrTime.trim();
    if(!fn||!dep||!arr||!depTime||!arrTime) { alert("Flight #, dep, arr, and both times are required."); return; }
    if(!/^\d{2}:\d{2}$/.test(depTime)||!/^\d{2}:\d{2}$/.test(arrTime)) { alert("Times must be in HH:MM format."); return; }

    setSavingFlight(true);
    const newCalendar=[...roster.calendar];
    const newFlight={flightNum:fn,dep,arr,depTime,arrTime,acType:addForm.acType.trim().toUpperCase()||"—",schedBlockMins:null};
    newCalendar[di]={...newCalendar[di],isOff:false,flights:[...newCalendar[di].flights,newFlight]};

    try {
      await db_updateRosterCalendar(user.id, roster.id, newCalendar);
      onRosterUpdated(roster.id, newCalendar);
      resetAddForm();
      setExp(p=>({...p,[di]:true}));
    } catch(e) {
      alert(e.message||"Failed to save flight.");
    } finally {
      setSavingFlight(false);
    }
  }

  async function deleteFlight(di,fi) {
    if(!window.confirm("Remove this flight?")) return;
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

  // Corrects a flight's SCHEDULED info (flight #, dep/arr, scheduled times) —
  // for fixing AI/roster parsing mistakes, distinct from "Edit times" which
  // only edits the ACTUAL (post-flight, synced) times.
  function startEditSched(di,fi,f) {
    const tk=tkey(di,fi);
    setSchedForm({flightNum:f.flightNum,dep:f.dep,arr:f.arr,depTime:f.depTime,arrTime:f.arrTime});
    setEditingSched(tk);
  }

  function cancelEditSched() {
    setEditingSched(null);
  }

  async function saveEditSched(di,fi) {
    const fn=schedForm.flightNum.trim(), dep=schedForm.dep.trim().toUpperCase(), arr=schedForm.arr.trim().toUpperCase();
    const depTime=schedForm.depTime.trim(), arrTime=schedForm.arrTime.trim();
    if(!fn||!dep||!arr||!depTime||!arrTime) { alert("All fields are required."); return; }
    if(!/^\d{2}:\d{2}$/.test(depTime)||!/^\d{2}:\d{2}$/.test(arrTime)) { alert("Times must be in HH:MM format."); return; }

    setSavingSched(true);
    const newCalendar=[...roster.calendar];
    const newFlights=[...newCalendar[di].flights];
    newFlights[fi]={...newFlights[fi],flightNum:fn,dep,arr,depTime,arrTime,schedBlockMins:null};
    newCalendar[di]={...newCalendar[di],flights:newFlights};

    try {
      await db_updateRosterCalendar(user.id, roster.id, newCalendar);
      onRosterUpdated(roster.id, newCalendar);
      setEditingSched(null);
    } catch(e) {
      alert(e.message||"Failed to save changes.");
    } finally {
      setSavingSched(false);
    }
  }

  const today=new Date().getDate();

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,flexWrap:"wrap"}}>
        <div className="section-title" style={{marginBottom:0}}>Logbook</div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap"}}>
          {rosters.map((r,i)=>(
            <button key={r.id} className={`month-tab ${sel===i?"active":""}`} onClick={()=>{setSel(i);setExp({});}}>
              {r.periodLabel}
            </button>
          ))}
        </div>
      </div>

      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
        <div style={{flex:1}}><div className="progress-bar-wrap"><div className="progress-bar-fill" style={{width:`${totalFlights?Math.round(100*logged/totalFlights):0}%`}}/></div></div>
        <span style={{fontSize:12,color:C.muted,whiteSpace:"nowrap"}}>{logged}/{totalFlights} logged</span>
        <button className="btn-danger" style={{fontSize:11,padding:"4px 10px"}} onClick={()=>{if(window.confirm("Delete this roster?")) onDeleteRoster(roster.id);}}>🗑 Delete</button>
      </div>

      {roster.calendar?.map((d,di)=>{
        const isToday=d.day===today&&roster.monthNum===new Date().getMonth()&&roster.year===new Date().getFullYear();
        const allSaved=d.flights.length>0&&d.flights.every((_,fi)=>tails[tkey(di,fi)]?.tail);
        const someSaved=d.flights.some((_,fi)=>tails[tkey(di,fi)]?.tail);
        const dotCls=allSaved?"all":someSaved?"partial":"";
        const expanded=exp[di]??(isToday&&d.flights.length>0);
        // Use actual block time when a flight has been synced, fall back to
        // scheduled time for flights that haven't flown yet. This means the
        // day total reflects real data as each leg lands and syncs, rather
        // than always showing the roster's scheduled estimate.
        const ft=d.flights.reduce((a,f,fi)=>a+(bestMins(f,tails[tkey(di,fi)])??0),0);
        const ftIsAllActual=d.flights.length>0&&d.flights.every((_,fi)=>bestMinsIsActual(tails[tkey(di,fi)]));
        const ftHasEstimate=d.flights.some((f,fi)=>!bestMinsIsActual(tails[tkey(di,fi)])&&schedMinsIsEstimate(f));
        const isAdding=addingDay===di;
        return (
          <div key={di} className={`day-card ${isToday?"today-card":""} ${allSaved?"logged-card":""}`}>
            <div className="day-card-header" onClick={()=>setExp(p=>({...p,[di]:!expanded}))}>
              <div className="day-date">{d.dow} {String(d.day).padStart(2,"0")}</div>
              <div className={`day-dot ${dotCls}`}/>
              <div className="day-summary-text">
                {d.flights.length===0
                  ? (d.dutyCode
                      ? <span style={{color:C.gold,fontWeight:600,fontSize:12,letterSpacing:".3px"}}>{d.dutyCode}</span>
                      : <span style={{color:C.muted,fontStyle:"italic",fontSize:12}}>Off</span>)
                  : d.flights.map(f=>`${f.dep}→${f.arr}`).join(" · ")}
              </div>
              {ft>0&&<div className="day-ft" style={ftIsAllActual?{color:C.teal}:undefined} title={ftIsAllActual?"Actual block time (synced)":ftHasEstimate?"Includes estimated times (no roster block time printed — may be inaccurate across timezones)":"Scheduled block time (from roster)"}>{fmtMins(ft)}{!ftIsAllActual&&ftHasEstimate&&<span style={{color:C.gold}}>*</span>}</div>}
              <span style={{color:C.muted,fontSize:11,marginLeft:6}}>{expanded?"▲":"▼"}</span>
            </div>
            {expanded&&(
              <div className="day-body">
                {d.flights.length>0 && (
                  <div className="col-heads-2row">
                    {["Flight","Dep","Arr","Times","Block Hr","Type"].map((h,i)=><div key={i} className="col-head">{h}</div>)}
                  </div>
                )}
                {d.flights.map((f,fi)=>{
                  const tk=tkey(di,fi);
                  const entry=tails[tk]||{};
                  const saved=!!entry.tail;
                  const tv=tmp[tk]??entry.tail??"";
                  const ls=lkStatus[tk];
                  const hasActual=entry.actualDep&&entry.actualArr;
                  // Only show a Block Hr figure when we have a server-computed,
                  // timezone-correct value (from UTC timestamps). Never fall back to
                  // naive local-time subtraction here — for cross-timezone flights it
                  // produces a wildly wrong number (e.g. wrapping to ~24hrs) rather than
                  // just being imprecise, which is worse than showing nothing.
                  const actualBlock = entry.actualBlockMins!=null ? fmtMins(entry.actualBlockMins) : null;
                  const isEditing=editingTimes[tk];
                  const editVals=timeEdits[tk]||{actualDep:"",actualArr:"",blockHr:""};
                  const isEditingSched=editingSched===tk;
                  const isCancelled=!!entry.cancelled;
                  return (
                    <div key={fi} className="flight-row-2line" style={isCancelled?{opacity:.65}:undefined}>
                      <div className="flight-row-top">
                        <div className="fr-num">{f.flightNum}</div>
                        <div className="fr-apt">{f.dep}</div>
                        <div className="fr-apt">{f.arr}</div>
                        {isCancelled ? (
                          <div className="fr-time" style={{color:C.red,fontWeight:600}}>✕ Cancelled</div>
                        ) : isEditing ? (
                          <div className="fr-time-edit">
                            <input className="fr-time-input" placeholder="HH:MM" value={editVals.actualDep}
                              onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,actualDep:e.target.value}}))}/>
                            <span style={{color:C.muted}}>–</span>
                            <input className="fr-time-input" placeholder="HH:MM" value={editVals.actualArr}
                              onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,actualArr:e.target.value}}))}/>
                          </div>
                        ) : hasActual ? (
                          <div className="fr-time" style={{color:C.teal}} title="Actual times (synced)">
                            {entry.actualDep}–{entry.actualArr}
                          </div>
                        ) : (
                          <div className="fr-time" title="Scheduled times (from roster)">
                            {f.depTime}–{f.arrTime}
                          </div>
                        )}
                        {isCancelled ? (
                          <div className="fr-time" style={{color:C.muted}}>—</div>
                        ) : isEditing ? (
                          <input className="fr-time-input" style={{width:56}} placeholder="1:30" value={editVals.blockHr}
                            onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,blockHr:e.target.value}}))}/>
                        ) : (
                          // Show actual block time in teal when synced, fall back
                          // to scheduled block time in muted style so pilots can
                          // see the expected duration before the flight syncs.
                          <div className="fr-time" style={{color:actualBlock?C.teal:C.muted,fontWeight:actualBlock?600:400}}
                            title={actualBlock?"Actual block time (synced)":"Scheduled block time (from roster)"}>
                            {actualBlock || (schedMins(f)!=null ? fmtMins(schedMins(f)) : "—")}
                          </div>
                        )}
                        <div className="fr-ac">{f.acType}</div>
                      </div>
                      <div className="flight-row-bottom">
                        <input className={`fr-input ${saved?"saved":""}`} placeholder="N-XXXXX" value={tv}
                          onChange={e=>setTmp(p=>({...p,[tk]:e.target.value}))}
                          onKeyDown={e=>e.key==="Enter"&&saveTail(di,fi)}/>
                        <button className="fr-lookup" onClick={()=>autoLookup(di,fi,f,d.day)} disabled={ls==="loading"}>
                          {ls==="loading"?<span className="spinner">⟳</span>:ls==="notfound"?"—":ls==="error"?"✗":"🔍 Auto"}
                        </button>
                        <button className={`fr-save ${saved?"ok":""}`} onClick={()=>saveTail(di,fi)} disabled={saving[tk]}>
                          {saving[tk]?<span className="spinner">⟳</span>:saved?(entry.finalSynced?"✏️ Edit":"✓ Saved"):"Save"}
                        </button>
                        {isEditing ? (
                          <>
                            <button className="fr-save ok" onClick={()=>saveTimes(di,fi)} disabled={saving[tk]}>
                              {saving[tk]?<span className="spinner">⟳</span>:"✓ Save times"}
                            </button>
                            <button className="fr-save" onClick={()=>cancelEditTimes(tk)}>Cancel</button>
                          </>
                        ) : (
                          <button className="fr-save" onClick={()=>startEditTimes(di,fi,f)}>✏️ Edit times</button>
                        )}
                        <button className="fr-save" style={{color:C.red,borderColor:C.red+"55"}} onClick={()=>deleteFlight(di,fi)}>🗑 Remove</button>
                      </div>
                      {entry.updatedAt && (
                        <div style={{fontSize:10,color:C.muted,marginTop:4,paddingLeft:2}}>
                          Last synced: {fmtSyncTime(entry.updatedAt)}{entry.finalSynced?" · locked from auto-sync, editable anytime":""}
                        </div>
                      )}
                      {isEditingSched && (
                        <div className="cal-add-form" style={{marginTop:0}}>
                          <div style={{fontSize:11,color:C.muted,marginBottom:2}}>Correct the roster's scheduled flight info (e.g. a misread time) — this does not affect any synced actual data.</div>
                          <div className="cal-add-row">
                            <input className="form-input" placeholder="Flight #" value={schedForm.flightNum} onChange={e=>setSchedForm(p=>({...p,flightNum:e.target.value}))}/>
                            <input className="form-input cal-add-narrow" placeholder="Dep" value={schedForm.dep} onChange={e=>setSchedForm(p=>({...p,dep:e.target.value}))} maxLength={4}/>
                            <input className="form-input cal-add-narrow" placeholder="Arr" value={schedForm.arr} onChange={e=>setSchedForm(p=>({...p,arr:e.target.value}))} maxLength={4}/>
                          </div>
                          <div className="cal-add-row">
                            <input className="form-input cal-add-narrow" placeholder="Dep HH:MM" value={schedForm.depTime} onChange={e=>setSchedForm(p=>({...p,depTime:e.target.value}))}/>
                            <input className="form-input cal-add-narrow" placeholder="Arr HH:MM" value={schedForm.arrTime} onChange={e=>setSchedForm(p=>({...p,arrTime:e.target.value}))}/>
                          </div>
                          <div style={{display:"flex",gap:8,marginTop:4}}>
                            <button className="btn-teal" style={{padding:"9px 18px",fontSize:13}} onClick={()=>saveEditSched(di,fi)} disabled={savingSched}>{savingSched?<span className="spinner">⟳</span>:"Save correction"}</button>
                            <button className="btn-sm-ghost" onClick={cancelEditSched}>Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {isAdding ? (
                  <div className="cal-add-form">
                    <div className="cal-add-row">
                      <input className="form-input" placeholder="Flight # (e.g. G7 4488)" value={addForm.flightNum} onChange={e=>setAddForm(p=>({...p,flightNum:e.target.value}))}/>
                      <input className="form-input cal-add-narrow" placeholder="Dep" value={addForm.dep} onChange={e=>setAddForm(p=>({...p,dep:e.target.value}))} maxLength={4}/>
                      <input className="form-input cal-add-narrow" placeholder="Arr" value={addForm.arr} onChange={e=>setAddForm(p=>({...p,arr:e.target.value}))} maxLength={4}/>
                    </div>
                    <div className="cal-add-row">
                      <input className="form-input cal-add-narrow" placeholder="Dep HH:MM" value={addForm.depTime} onChange={e=>setAddForm(p=>({...p,depTime:e.target.value}))}/>
                      <input className="form-input cal-add-narrow" placeholder="Arr HH:MM" value={addForm.arrTime} onChange={e=>setAddForm(p=>({...p,arrTime:e.target.value}))}/>
                      <input className="form-input cal-add-narrow" placeholder="Type" value={addForm.acType} onChange={e=>setAddForm(p=>({...p,acType:e.target.value}))} maxLength={4}/>
                    </div>
                    <div style={{display:"flex",gap:8,marginTop:4}}>
                      <button className="btn-teal" style={{padding:"9px 18px",fontSize:13}} onClick={()=>saveNewFlight(di)} disabled={savingFlight}>{savingFlight?<span className="spinner">⟳</span>:"Save flight"}</button>
                      <button className="btn-sm-ghost" onClick={resetAddForm}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn-sm-ghost" style={{alignSelf:"flex-start"}} onClick={()=>setAddingDay(di)}>+ Add flight</button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS PAGE
// ─────────────────────────────────────────────────────────────────────────────

// Database helpers for time rules and flight times
async function db_loadTimeRules(userId) {
  if(!isConfigured()) return [];
  const {data} = await sb.from("time_rules").select("*").eq("user_id", userId).order("start_date");
  return data||[];
}
async function db_saveTimeRule(userId, rule) {
  if(!isConfigured()) return;
  const {id, ...fields} = rule;
  const payload = {
    ...fields,
    user_id: userId,
    // Convert empty string to null — Postgres can't cast "" to date type
    end_date: fields.end_date || null,
  };
  if(id) {
    const {error} = await sb.from("time_rules").update(payload).eq("id", id);
    if(error) throw new Error(error.message);
  } else {
    const {error} = await sb.from("time_rules").insert(payload);
    if(error) throw new Error(error.message);
  }
}
async function db_deleteTimeRule(id) {
  if(!isConfigured()) return;
  await sb.from("time_rules").delete().eq("id", id);
}
async function db_loadFlightTimes(userId) {
  if(!isConfigured()) return {};
  const {data} = await sb.from("flight_times").select("*").eq("user_id", userId);
  const map={};
  (data||[]).forEach(r=>{
    map[`${r.roster_id}-${r.flight_key}`]=r;
  });
  return map;
}
async function db_saveFlightTime(userId, rosterId, flightKey, fields) {
  if(!isConfigured()) return;
  await sb.from("flight_times").upsert({user_id:userId, roster_id:rosterId, flight_key:flightKey, ...fields});
}

// Apply time rules to a flight based on its date
function applyTimeRules(rules, dateStr) {
  const sorted = [...rules].sort((a,b)=>new Date(b.start_date)-new Date(a.start_date));
  for(const rule of sorted) {
    if(dateStr >= rule.start_date && (!rule.end_date || dateStr <= rule.end_date)) {
      return rule;
    }
  }
  return null;
}

// Compute all analytics from rosters + tails + timeRules + flightTimes
function computeAnalytics(rosters, tails, timeRules, flightTimes) {
  const now = new Date();
  const results = {
    last30:{mins:0}, last6mo:{mins:0}, last12mo:{mins:0},
    byMonth:{}, // "YYYY-MM" → {flownMins, takeoffs, landings, pic, sic, multi, single, turbine, night, ifr}
    totals:{pic:0, sic:0, multi:0, single:0, turbine:0, night:0, ifr:0, takeoffs:0, landings:0},
    far117:{dutyPeriods:[]},
  };

  const d30 = new Date(now); d30.setDate(d30.getDate()-30);
  const d6mo = new Date(now); d6mo.setMonth(d6mo.getMonth()-6);
  const d12mo = new Date(now); d12mo.setFullYear(d12mo.getFullYear()-1);

  for(const roster of rosters) {
    (roster.calendar||[]).forEach((day, di) => {
      (day.flights||[]).forEach((f, fi) => {
        const tk = `${roster.id}-${di}-${fi}`;
        const tail = tails[tk];
        const ft = flightTimes[`${roster.id}-${di}-${fi}`];
        if(tail?.cancelled) return;

        const dateStr = `${roster.year}-${String((roster.monthNum ?? roster.month_num ?? 0)+1).padStart(2,"0")}-${String(day.day).padStart(2,"0")}`;
        const flightDate = new Date(dateStr + "T12:00:00Z"); // noon UTC avoids timezone boundary issues
        const actualMins = tail?.actualBlockMins ?? null;
        const schedMin = schedMins(f) ?? 0;
        // Use actual block time when synced, scheduled time as fallback —
        // same logic as bestMins() used throughout the logbook UI.
        const mins = actualMins ?? schedMin;
        if(!mins) return;

        const monthKey = dateStr.slice(0,7);
        if(!results.byMonth[monthKey]) results.byMonth[monthKey]={flownMins:0,takeoffs:0,landings:0,pic:0,sic:0,multi:0,single:0,turbine:0,night:0,ifr:0};
        const mo = results.byMonth[monthKey];
        mo.flownMins += mins;

        // Time period buckets — use best available time (actual or scheduled)
        // so upcoming scheduled flights count toward totals before they sync.
        if(flightDate >= d30)  results.last30.mins  += mins;
        if(flightDate >= d6mo) results.last6mo.mins += mins;
        if(flightDate >= d12mo) results.last12mo.mins += mins;

        // Takeoffs/landings
        const toffs = ft?.takeoffs ?? 1;
        const lands = ft?.landings ?? 1;
        mo.takeoffs += toffs;
        mo.landings += lands;
        results.totals.takeoffs += toffs;
        results.totals.landings += lands;

        // Night/IFR from manual entry
        const nightMins = ft?.night_mins ?? 0;
        const ifrMins   = ft?.ifr_mins ?? 0;
        mo.night += nightMins;
        mo.ifr   += ifrMins;
        results.totals.night += nightMins;
        results.totals.ifr   += ifrMins;

        // PIC/SIC/Multi/Single/Turbine from rules + overrides
        const rule = applyTimeRules(timeRules, dateStr);
        const isPic     = ft?.pic_override     ?? rule?.is_pic     ?? false;
        const isSic     = ft?.sic_override     ?? rule?.is_sic     ?? false;
        const isMulti   = ft?.multi_override   ?? rule?.is_multi   ?? false;
        const isSingle  = ft?.single_override  ?? rule?.is_single  ?? false;
        const isTurbine = ft?.turbine_override ?? rule?.is_turbine ?? false;

        if(isPic)     { mo.pic     += mins; results.totals.pic     += mins; }
        if(isSic)     { mo.sic     += mins; results.totals.sic     += mins; }
        if(isMulti)   { mo.multi   += mins; results.totals.multi   += mins; }
        if(isSingle)  { mo.single  += mins; results.totals.single  += mins; }
        if(isTurbine) { mo.turbine += mins; results.totals.turbine += mins; }
      });
    });
  }

  return results;
}

// FAR 117 Table B FDP limits by acclimation start time (unaugmented, 2-pilot)
const FDP_TABLE = [
  {start:"0000",end:"0359",maxFdp:9},
  {start:"0400",end:"0459",maxFdp:9},
  {start:"0500",end:"0559",maxFdp:10},
  {start:"0600",end:"0659",maxFdp:10},
  {start:"0700",end:"0759",maxFdp:11},
  {start:"0800",end:"0859",maxFdp:12},
  {start:"0900",end:"0959",maxFdp:12},
  {start:"1000",end:"1059",maxFdp:13},
  {start:"1100",end:"1159",maxFdp:13},
  {start:"1200",end:"1259",maxFdp:13},
  {start:"1300",end:"1359",maxFdp:12},
  {start:"1400",end:"1459",maxFdp:12},
  {start:"1500",end:"1559",maxFdp:12},
  {start:"1600",end:"1659",maxFdp:12},
  {start:"1700",end:"1759",maxFdp:12},
  {start:"1800",end:"1859",maxFdp:12},
  {start:"1900",end:"1959",maxFdp:11},
  {start:"2000",end:"2059",maxFdp:11},
  {start:"2100",end:"2159",maxFdp:10},
  {start:"2200",end:"2259",maxFdp:10},
  {start:"2300",end:"2359",maxFdp:9},
];

function getFdpLimit(reportTimeHHMM) {
  const [h,m] = reportTimeHHMM.split(":").map(Number);
  const hhmm = String(h).padStart(2,"0")+String(m||0).padStart(2,"0");
  for(const row of FDP_TABLE) {
    if(hhmm >= row.start && hhmm <= row.end) return row.maxFdp;
  }
  return 9;
}

function FDPCalculator() {
  const [reportTime, setReportTime] = useState("08:00");
  const [crew, setCrew] = useState("2"); // 2, 3, 4
  const [actualFdp, setActualFdp] = useState("");
  const [restBefore, setRestBefore] = useState("");

  const baseFdp = getFdpLimit(reportTime);
  const augBonus = crew==="3"?2:crew==="4"?3:0;
  const maxFdp = baseFdp + augBonus;
  const actualFdpMins = actualFdp ? parseFloat(actualFdp)*60 : null;
  const maxFdpMins = maxFdp*60;
  const fdpPct = actualFdpMins ? Math.min(100, Math.round((actualFdpMins/maxFdpMins)*100)) : 0;
  const fdpColor = fdpPct>=100?C.red:fdpPct>=90?C.gold:C.teal;
  const restMins = restBefore ? parseFloat(restBefore)*60 : null;
  const restOk = restMins ? restMins >= 10*60 : null;

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        <div>
          <div className="form-label">Report time (local)</div>
          <input className="form-input" type="time" value={reportTime} onChange={e=>setReportTime(e.target.value)}/>
        </div>
        <div>
          <div className="form-label">Crew complement</div>
          <select className="form-select" value={crew} onChange={e=>setCrew(e.target.value)}>
            <option value="2">2-pilot (standard)</option>
            <option value="3">3-pilot (+2hr augmented)</option>
            <option value="4">4-pilot (+3hr augmented)</option>
          </select>
        </div>
        <div>
          <div className="form-label">Actual FDP (hours, optional)</div>
          <input className="form-input" type="number" step="0.1" placeholder="e.g. 10.5" value={actualFdp} onChange={e=>setActualFdp(e.target.value)}/>
        </div>
        <div>
          <div className="form-label">Rest before duty (hours, optional)</div>
          <input className="form-input" type="number" step="0.1" placeholder="e.g. 11" value={restBefore} onChange={e=>setRestBefore(e.target.value)}/>
        </div>
      </div>

      {/* FDP limit result */}
      <div style={{padding:"14px 16px",background:C.panel,borderRadius:10,marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:actualFdpMins?8:0}}>
          <span style={{fontSize:13,color:C.silver}}>Max FDP at {reportTime}</span>
          <span style={{fontFamily:FM,fontSize:18,color:C.teal,fontWeight:700}}>{maxFdp}:00 hrs</span>
        </div>
        {actualFdpMins!=null&&(
          <>
            <div style={{height:7,background:C.border,borderRadius:4,overflow:"hidden",marginBottom:4}}>
              <div style={{height:"100%",width:fdpPct+"%",background:fdpColor,borderRadius:4,transition:"width .4s"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:11,color:fdpColor,fontWeight:600}}>{fdpPct}% of FDP used</span>
              <span style={{fontSize:11,color:fdpPct>=100?C.red:C.muted}}>
                {fdpPct>=100?"⚠ EXCEEDS LIMIT":fmtMins(maxFdpMins-actualFdpMins)+" remaining"}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Rest check */}
      {restMins!=null&&(
        <div style={{padding:"12px 16px",background:restOk?C.green+"15":C.red+"15",borderRadius:10,border:`1px solid ${restOk?C.green+"44":C.red+"44"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:13,color:C.silver}}>Minimum rest required</span>
            <span style={{fontFamily:FM,fontSize:13,color:restOk?C.green:C.red,fontWeight:600}}>10:00 hrs</span>
          </div>
          <div style={{fontSize:12,marginTop:4,color:restOk?C.green:C.red,fontWeight:600}}>
            {restOk?`✓ Rest compliant (${restBefore}hr provided)`:`⚠ Insufficient rest — ${restBefore}hr provided, 10hr required`}
          </div>
        </div>
      )}

      <div style={{marginTop:12,fontSize:11,color:C.muted,lineHeight:1.6}}>
        Source: FAR Part 117 Table B (unaugmented). Consult your airline's ops specs for exceptions, extensions, and augmented crew rules.
      </div>
    </div>
  );
}

function AnalyticsPage({user, rosters, tails}) {
  const [timeRules, setTimeRules] = useState([]);
  const [flightTimes, setFlightTimes] = useState({});
  const [tab, setTab] = useState("overview"); // "overview" | "far117" | "rules"
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({start_date:"",end_date:"",is_pic:false,is_sic:false,is_multi:false,is_single:false,is_turbine:false,label:""});
  const [savingRule, setSavingRule] = useState(false);

  useEffect(()=>{
    (async()=>{
      const [rules, ft] = await Promise.all([db_loadTimeRules(user.id), db_loadFlightTimes(user.id)]);
      setTimeRules(rules);
      setFlightTimes(ft);
    })();
  }, [user.id]);

  const analytics = useMemo(()=>computeAnalytics(rosters, tails, timeRules, flightTimes), [rosters, tails, timeRules, flightTimes]);

  async function saveRule() {
    if(!ruleForm.start_date) return;
    setSavingRule(true);
    try {
      await db_saveTimeRule(user.id, ruleForm);
      const rules = await db_loadTimeRules(user.id);
      setTimeRules(rules);
      setRuleForm({start_date:"",end_date:"",is_pic:false,is_sic:false,is_multi:false,is_single:false,is_turbine:false,label:""});
      setShowRuleForm(false);
    } catch(e) {
      alert(e.message||"Failed to save rule. Make sure the database migration has been run.");
    } finally {
      setSavingRule(false);
    }
  }

  async function deleteRule(id) {
    if(!window.confirm("Remove this time rule?")) return;
    await db_deleteTimeRule(id);
    setTimeRules(r=>r.filter(x=>x.id!==id));
  }

  const sortedMonths = Object.keys(analytics.byMonth).sort().reverse();

  // FAR 117 simplified limits
  const far117 = [
    {limit:"Flight Time (24 hrs)",    value:8,  unit:"hr"},
    {limit:"Flight Time (calendar mo)",value:100,unit:"hr"},
    {limit:"Flight Time (365 days)",   value:1000,unit:"hr"},
    {limit:"Flight Duty Period",       value:"9–14",unit:"hr (based on accl time)"},
    {limit:"Rest Before Duty",        value:10,  unit:"hr min"},
  ];

  const StatBar=({label,mins,max})=>{
    const pct=max?Math.min(100,Math.round((mins/max)*100)):0;
    return (
      <div style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
          <span style={{fontSize:12,color:C.silver}}>{label}</span>
          <span style={{fontFamily:FM,fontSize:12,color:C.teal}}>{fmtMins(mins)}</span>
        </div>
        <div style={{height:6,background:C.border,borderRadius:3,overflow:"hidden"}}>
          <div style={{height:"100%",width:pct+"%",background:`linear-gradient(90deg,${C.teal},${C.green})`,borderRadius:3,transition:"width .6s ease"}}/>
        </div>
      </div>
    );
  };

  return (
    <div style={{maxWidth:700}}>
      {/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:20,borderBottom:`1px solid ${C.border}`,paddingBottom:0}}>
        {[["overview","Overview"],["far117","FAR 117"],["rules","Time Rules"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{
            padding:"8px 16px",border:"none",background:"none",cursor:"pointer",fontSize:13,fontWeight:600,
            color:tab===id?C.teal:C.muted,
            borderBottom:`2px solid ${tab===id?C.teal:"transparent"}`,
            marginBottom:-1,transition:"all .15s",
          }}>{label}</button>
        ))}
      </div>

      {tab==="overview"&&(<>
        {/* Recent hours */}
        <div className="card" style={{marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>Hours Flown</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:4}}>
            {[["Last 30 days",analytics.last30.mins],["Last 6 months",analytics.last6mo.mins],["Last 12 months",analytics.last12mo.mins]].map(([label,mins])=>(
              <div key={label} style={{background:C.panel,borderRadius:10,padding:"14px 12px",textAlign:"center"}}>
                <div style={{fontFamily:FM,fontSize:22,fontWeight:600,color:C.teal}}>{fmtMins(mins)}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:4}}>{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Total time breakdown */}
        <div className="card" style={{marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>All-Time Totals</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[
              ["PIC",analytics.totals.pic],["SIC",analytics.totals.sic],
              ["Multi Engine",analytics.totals.multi],["Single Engine",analytics.totals.single],
              ["Turbine",analytics.totals.turbine],["Night",analytics.totals.night],
              ["IFR",analytics.totals.ifr],
            ].map(([label,mins])=>(
              <div key={label} style={{background:C.panel,borderRadius:8,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.silver}}>{label}</span>
                <span style={{fontFamily:FM,fontSize:13,color:mins?C.ink:C.muted}}>{mins?fmtMins(mins):"—"}</span>
              </div>
            ))}
            <div style={{background:C.panel,borderRadius:8,padding:"10px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",gridColumn:"span 2"}}>
              <span style={{fontSize:12,color:C.silver}}>Takeoffs / Landings</span>
              <span style={{fontFamily:FM,fontSize:13,color:C.ink}}>{analytics.totals.takeoffs} / {analytics.totals.landings}</span>
            </div>
          </div>
        </div>

        {/* Monthly breakdown */}
        <div className="card">
          <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:16}}>Monthly Breakdown</div>
          {sortedMonths.length===0&&<div style={{color:C.muted,fontSize:13}}>No flight data yet.</div>}
          {sortedMonths.map(mo=>{
            const d=analytics.byMonth[mo];
            const [yr,mn]=mo.split("-");
            const label=new Date(Number(yr),Number(mn)-1,1).toLocaleDateString(undefined,{month:"long",year:"numeric"});
            return (
              <div key={mo} style={{marginBottom:16,paddingBottom:16,borderBottom:`1px solid ${C.border}`}}>
                <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:8}}>{label}</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6,marginBottom:8}}>
                  {[["Block",d.flownMins],["PIC",d.pic],["SIC",d.sic],["Multi",d.multi],["Single",d.single],["Turbine",d.turbine],["Night",d.night],["IFR",d.ifr]].map(([l,v])=>(
                    <div key={l} style={{textAlign:"center"}}>
                      <div style={{fontFamily:FM,fontSize:12,color:v?C.teal:C.muted}}>{v?fmtMins(v):"—"}</div>
                      <div style={{fontSize:10,color:C.muted}}>{l}</div>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",gap:16}}>
                  <span style={{fontSize:11,color:C.silver}}>✈ {d.takeoffs} T/O</span>
                  <span style={{fontSize:11,color:C.silver}}>⬇ {d.landings} LDG</span>
                </div>
              </div>
            );
          })}
        </div>
      </>)}

      {tab==="far117"&&(
        <div>
          <div className="card" style={{marginBottom:16}}>
            <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:4}}>FAR Part 117 — Table B Limits vs. Your Logged Hours</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:16}}>Applies to Part 121 scheduled operations. Based on your actual synced block times.</div>

            {[
              {
                label:"Flight Time — 24 consecutive hours",
                limit:8*60,
                unit:"hr",
                // Approximate: find max single-day block time
                actual: (() => {
                  let max=0;
                  Object.values(analytics.byMonth).forEach(m=>{/* per-month only, best approximation */});
                  // Use a simple approach: find highest single-day from rosters
                  let dayMax=0;
                  rosters.forEach(r=>(r.calendar||[]).forEach((day,di)=>{
                    const dayMins = (day.flights||[]).reduce((a,f,fi)=>{
                      const tk=`${r.id}-${di}-${fi}`;
                      return a+(tails[tk]?.actualBlockMins??0);
                    },0);
                    if(dayMins>dayMax) dayMax=dayMins;
                  }));
                  return dayMax;
                })(),
                desc:"Max flight time in any 24-hour period",
              },
              {
                label:"Flight Time — Calendar month",
                limit:100*60,
                actual: (() => {
                  const mo = new Date().toISOString().slice(0,7);
                  return analytics.byMonth[mo]?.flownMins||0;
                })(),
                desc:"Max flight time in the current calendar month",
              },
              {
                label:"Flight Time — 365 days",
                limit:1000*60,
                actual: analytics.last12mo.mins,
                desc:"Max flight time in the last 12 months",
              },
            ].map(row=>{
              const pct = Math.min(100, Math.round((row.actual/row.limit)*100));
              const color = pct>=90?C.red:pct>=75?C.gold:C.teal;
              return (
                <div key={row.label} style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:4}}>
                    <div>
                      <div style={{fontSize:13,color:C.ink,fontWeight:500}}>{row.label}</div>
                      <div style={{fontSize:11,color:C.muted}}>{row.desc}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
                      <span style={{fontFamily:FM,fontSize:13,color}}>{fmtMins(row.actual)}</span>
                      <span style={{fontSize:11,color:C.muted}}> / {fmtMins(row.limit)}</span>
                    </div>
                  </div>
                  <div style={{height:8,background:C.border,borderRadius:4,overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:color,borderRadius:4,transition:"width .6s ease"}}/>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
                    <span style={{fontSize:10,color:color,fontWeight:600}}>{pct}% of limit used</span>
                    <span style={{fontSize:10,color:C.muted}}>{fmtMins(row.limit-row.actual)} remaining</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card">
            <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:12}}>Flight Duty Period — By Acclimation Start Time</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:12}}>Max FDP varies by local report time. Select your report time to see your limit.</div>
            <FDPCalculator/>
          </div>
        </div>
      )}

      {tab==="rules"&&(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:13,color:C.muted}}>Set time classification rules by date range. All flights within a range inherit the rule unless manually overridden.</div>
          <button className="btn-teal" style={{padding:"8px 14px",fontSize:13,whiteSpace:"nowrap"}} onClick={()=>setShowRuleForm(true)}>+ Add rule</button>
        </div>

        {showRuleForm&&(
          <div className="card" style={{marginBottom:16,border:`1px solid ${C.teal}55`}}>
            <div style={{fontSize:14,fontWeight:600,color:C.ink,marginBottom:14}}>New Time Rule</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div><div className="form-label">Start date *</div><input className="form-input" type="date" value={ruleForm.start_date} onChange={e=>setRuleForm(p=>({...p,start_date:e.target.value}))}/></div>
              <div><div className="form-label">End date (leave blank = open-ended)</div><input className="form-input" type="date" value={ruleForm.end_date} onChange={e=>setRuleForm(p=>({...p,end_date:e.target.value}))}/></div>
            </div>
            <div><div className="form-label">Label (optional, e.g. "GoJet FO")</div><input className="form-input" value={ruleForm.label} onChange={e=>setRuleForm(p=>({...p,label:e.target.value}))} placeholder="e.g. GoJet FO" style={{marginBottom:12}}/></div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
              {[["is_pic","PIC"],["is_sic","SIC"],["is_multi","Multi Engine"],["is_single","Single Engine"],["is_turbine","Turbine"]].map(([key,label])=>(
                <button key={key} onClick={()=>setRuleForm(p=>({...p,[key]:!p[key]}))} style={{
                  padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",
                  border:`1.5px solid ${ruleForm[key]?C.teal:C.border}`,
                  background:ruleForm[key]?C.teal+"22":"none",
                  color:ruleForm[key]?C.teal:C.silver,
                }}>
                  {ruleForm[key]?"✓ ":""}{label}
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn-teal" style={{padding:"9px 18px",fontSize:13}} onClick={saveRule} disabled={savingRule||!ruleForm.start_date}>
                {savingRule?<span className="spinner">⟳</span>:"Save rule"}
              </button>
              <button className="btn-sm-ghost" onClick={()=>setShowRuleForm(false)}>Cancel</button>
            </div>
          </div>
        )}

        {timeRules.length===0&&!showRuleForm&&(
          <div className="card" style={{textAlign:"center",color:C.muted,fontSize:13,padding:"32px 16px"}}>
            No time rules yet. Add a rule to automatically classify flights as PIC, SIC, Multi Engine, etc.
          </div>
        )}

        {timeRules.map(rule=>(
          <div key={rule.id} className="card" style={{marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:C.ink,marginBottom:4}}>
                {rule.label||"Rule"} · <span style={{fontFamily:FM,fontSize:12,color:C.silver}}>{rule.start_date}</span>
                {rule.end_date?<span style={{color:C.muted}}> → {rule.end_date}</span>:<span style={{color:C.muted}}> → open-ended</span>}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {[["is_pic","PIC"],["is_sic","SIC"],["is_multi","Multi"],["is_single","Single"],["is_turbine","Turbine"]].filter(([k])=>rule[k]).map(([,label])=>(
                  <span key={label} style={{padding:"2px 8px",borderRadius:5,background:C.teal+"22",color:C.teal,fontSize:11,fontWeight:600}}>{label}</span>
                ))}
              </div>
            </div>
            <button className="btn-sm-ghost" style={{color:C.red,borderColor:C.red+"44",flexShrink:0}} onClick={()=>deleteRule(rule.id)}>Remove</button>
          </div>
        ))}
      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE MAP PAGE
// Shows all airport-pair routes flown or scheduled for the selected month
// (or all time). Flown routes (actual synced data) show in teal; scheduled-
// only routes show in gold. Route thickness scales with frequency.
// Uses Leaflet.js + OpenStreetMap (free, no API key required).
// ─────────────────────────────────────────────────────────────────────────────

// Airport lat/lng lookup — covers GoJet/United Express network + common US hubs.
// Add more entries here as new airports appear in rosters.
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
    rosters.length > 0 ? rosters[0].id : null
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
          {[["Name",user.name],["Email",user.email],["Plan",<span className="pill pill-orange">{user.plan}</span>],["Member since",user.joined]].map(([l,v])=>(
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

  // Restore session on mount
  useEffect(()=>{
    (async()=>{
      try {
        const u=await db_getSession();
        if(u) {
          setUser(u);
          const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
          setRosters(rs); setTails(ts);
          // Restore the page the pilot was on before refresh, falling back
          // to the appropriate default for their role
          let savedPage = "dashboard";
          try { savedPage = sessionStorage.getItem("fl_page") || savedPage; } catch {}
          const defaultPage = u.role==="admin" ? "admin-overview" : "dashboard";
          // Only restore pilot pages for pilots, admin pages for admins
          const isValidForRole = u.role==="admin"
            ? savedPage.startsWith("admin")
            : !savedPage.startsWith("admin");
          setPage(isValidForRole ? savedPage : defaultPage);
          setScreen("app");
        } else { setScreen("landing"); }
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
  }

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
    await db_deleteRoster(user.id, rosterId);
    setRosters(prev=>prev.filter(r=>r.id!==rosterId));
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
    dashboard:"Dashboard", calendar:"Calendar", upload:"Upload Roster", logbook:"Logbook",
    settings:"Settings", map:"Route Map", analytics:"Analytics",
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
      {screen==="landing"&&<LandingPage onLogin={()=>{setAuthMode("login");setScreen("auth");}} onSignup={()=>{setAuthMode("signup");setScreen("auth");}}/>}
      {screen==="auth"&&<AuthPage onAuth={handleAuth} onBack={()=>setScreen("landing")} initialMode={authMode}/>}
      {screen==="app"&&user&&(
        <div className="app-shell">
          <Sidebar user={user} page={page} setPage={navigate} onLogout={handleLogout}/>
          <div className="app-content">
            <div className="app-topbar">
              {/* Hamburger — only visible on mobile (sidebar is hidden there) */}
              <button className="hamburger-btn" onClick={()=>setDrawerOpen(true)} aria-label="Menu">☰</button>
              <div className="app-page-title">{pageTitle}</div>
              {user.role==="admin"&&<span className="admin-badge">ADMIN</span>}
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:12,color:C.muted}}>{user.name}</span>
                <div className="avatar" style={{width:30,height:30,fontSize:13}}>{initials(user.name)}</div>
              </div>
            </div>
            <div className="app-body">
              {page==="dashboard"&&<Dashboard user={user} rosters={rosters} tails={tails} setPage={navigate}/>}
              {page==="calendar"&&<CalendarPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated}/>}
              {page==="upload"&&<UploadPage user={user} onRosterSaved={handleRosterSaved}/>}
              {page==="logbook"&&<LogbookPage user={user} rosters={rosters} tails={tails} onTailSaved={handleTailSaved} onDeleteRoster={handleDeleteRoster} onRosterUpdated={handleRosterCalendarUpdated}/>}
              {page==="settings"&&<SettingsPage user={user} rosters={rosters} tails={tails} isDark={isDark} onToggleTheme={handleToggleTheme}/>}
              {page==="map"&&<RouteMapPage rosters={rosters} tails={tails}/>}
              {page==="analytics"&&<AnalyticsPage user={user} rosters={rosters} tails={tails}/>}
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
