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

import { useState, useEffect, useRef, useCallback } from "react";

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
    return {
      async select(cols="*", filter="") {
        const r = await fetch(`${base}?select=${cols}${filter?"&"+filter:""}`, { headers: h({"Prefer":"return=representation"}) });
        return { data: await r.json(), error: r.ok ? null : "error" };
      },
      async insert(body) {
        const r = await fetch(base, { method:"POST", headers: h({"Prefer":"return=representation"}), body:JSON.stringify(body) });
        const data = await r.json(); return { data: Array.isArray(data)?data[0]:data, error: r.ok?null:data };
      },
      async upsert(body, opts={}) {
        const r = await fetch(base, { method:"POST", headers: h({"Prefer":`resolution=merge-duplicates,return=representation`}), body:JSON.stringify(body) });
        const data = await r.json(); return { data, error: r.ok?null:data };
      },
      async update(body, filter="") {
        const r = await fetch(`${base}${filter?"?"+filter:""}`, { method:"PATCH", headers: h({"Prefer":"return=representation"}), body:JSON.stringify(body) });
        return { data: await r.json(), error: r.ok?null:"error" };
      },
      async delete(filter="") {
        const r = await fetch(`${base}?${filter}`, { method:"DELETE", headers: h() });
        return { error: r.ok?null:"error" };
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
const C = {
  base:"#FAFAF8", surface:"#FFFFFF", panel:"#F4F2EC", panelLt:"#EEEBE2",
  border:"#E5E2D8", red:"#C9472B", redDim:"#A23A22",
  teal:"#0E7C7B", tealDim:"#0A5F5E", ink:"#1A2238", silver:"#4B4D45",
  muted:"#8B8D7F", green:"#1F8A4C", gold:"#9A6B0C",
};
C.orange = C.red;       // alias: existing code uses C.orange as the accent color
C.orangeDim = C.redDim; // alias: existing code uses C.orangeDim for hover states
C.white = C.ink;         // alias: existing code uses C.white as primary text color
const FD = "'Fraunces',serif";
const FB = "'Inter',sans-serif";
const FM = "'JetBrains Mono',monospace";

// ── STYLES ────────────────────────────────────────────────────────────────────
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:${C.base};color:${C.white};font-family:${FB};line-height:1.5}
button{cursor:pointer;font-family:${FB}}
input,textarea,select{font-family:${FB}}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:${C.base}}
::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}

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
.form-input{width:100%;background:${C.base};border:1px solid ${C.border};color:${C.ink};padding:11px 14px;border-radius:8px;font-size:14px;outline:none;transition:border-color .15s}
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
.sidebar-logo-text span{color:${C.red};font-style:normal;font-weight:700}
.sidebar-plan{font-size:10px;color:${C.muted};letter-spacing:1px;text-transform:uppercase;margin-top:2px}
.sidebar-nav{flex:1;padding:16px 12px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.sidebar-section{font-size:10px;color:${C.muted};letter-spacing:1.5px;text-transform:uppercase;padding:12px 8px 6px}
.sidebar-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;font-size:13px;color:${C.silver};background:none;border:none;width:100%;text-align:left;transition:all .15s}
.sidebar-item:hover{background:${C.panel};color:${C.ink}}
.sidebar-item.active{background:${C.red}14;color:${C.red}}
.sidebar-item-icon{font-size:15px;width:20px;text-align:center;flex-shrink:0}
.sidebar-footer{padding:16px 12px;border-top:1px solid ${C.border}}
.sidebar-user{display:flex;align-items:center;gap:10px}
.avatar{width:34px;height:34px;border-radius:50%;background:${C.red}14;border:1px solid ${C.red}33;display:flex;align-items:center;justify-content:center;font-family:${FD};font-size:14px;font-weight:600;color:${C.red};flex-shrink:0}
.sidebar-user-name{font-size:13px;font-weight:600;color:${C.ink}}
.sidebar-user-role{font-size:11px;color:${C.muted}}
.sidebar-logout{background:none;border:none;color:${C.muted};font-size:18px;margin-left:auto;padding:4px;transition:color .15s}
.sidebar-logout:hover{color:${C.red}}
.app-content{margin-left:224px;flex:1;min-height:100vh}
.app-topbar{height:56px;background:${C.surface};border-bottom:1px solid ${C.border};display:flex;align-items:center;padding:0 28px;gap:16px;position:sticky;top:0;z-index:40}
.app-page-title{font-family:${FD};font-size:19px;font-weight:500;color:${C.ink};flex:1}
.app-body{padding:28px}

/* MOBILE NAV — fixed bottom tab bar, shown only on small screens (see media query) */
.mobile-nav{display:none}

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
.day-card{background:${C.surface};border:1px solid ${C.border};border-radius:10px;margin-bottom:8px;overflow:hidden}
.day-card.today-card{border-color:${C.orange}88}
.day-card.logged-card{border-color:${C.green}44}
.day-card-header{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;user-select:none}
.day-date{font-family:${FM};font-size:13px;color:${C.orange};min-width:72px}
.day-dot{width:8px;height:8px;border-radius:50%;border:1.5px solid ${C.muted};flex-shrink:0}
.day-dot.all{background:${C.green};border-color:${C.green}}
.day-dot.partial{background:${C.gold};border-color:${C.gold}}
.day-summary-text{flex:1;font-size:13px;color:${C.silver}}
.day-ft{font-family:${FM};font-size:12px;color:${C.muted}}
.day-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;border-top:1px solid ${C.border}44}
.col-heads-2row{display:grid;grid-template-columns:84px 48px 48px 120px 70px 60px;gap:6px;padding:0 4px}
.col-head{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:${C.muted}}
.flight-row-2line{background:${C.panel};border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:8px}
.flight-row-top{display:grid;grid-template-columns:84px 48px 48px 120px 70px 60px;gap:6px;align-items:center}
.flight-row-bottom{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid ${C.border}33}
.fr-num{font-family:${FM};font-size:12px;color:${C.orange}}
.fr-apt{font-size:13px;font-weight:600;color:${C.white}}
.fr-time{font-family:${FM};font-size:11px;color:${C.muted}}
.fr-ac{font-size:12px;color:${C.muted}}
.fr-time-edit{display:flex;align-items:center;gap:3px}
.fr-time-input{background:${C.surface};border:1px solid ${C.teal}55;color:${C.white};padding:3px 5px;border-radius:5px;font-family:${FM};font-size:11px;width:48px;outline:none;text-align:center}
.fr-time-input:focus{border-color:${C.teal}}
.fr-input{background:${C.surface};border:1px solid ${C.border};color:${C.white};padding:6px 10px;border-radius:6px;font-family:${FM};font-size:12px;width:120px;text-transform:uppercase;outline:none;transition:border-color .15s}
.fr-input:focus{border-color:${C.teal}}
.fr-input.saved{border-color:${C.green}44}
.fr-lookup{background:${C.teal}18;border:1px solid ${C.teal}44;color:${C.teal};padding:6px 10px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;transition:all .15s}
.fr-lookup:hover{background:${C.teal}30}
.fr-lookup:disabled{opacity:.5;cursor:not-allowed}
.fr-save{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:6px 10px;border-radius:6px;font-size:11px;font-weight:600;transition:all .15s;white-space:nowrap}
.fr-save:hover{border-color:${C.orange};color:${C.orange}}
.fr-save.ok{border-color:${C.green};color:${C.green}}

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
.card{background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:22px}
.btn-teal{background:${C.teal};color:#fff;border:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;transition:background .15s}
.btn-teal:hover{background:${C.tealDim}}
.btn-teal:disabled{opacity:.6;cursor:not-allowed}
.btn-orange{background:${C.ink};color:${C.base};border:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;transition:background .15s}
.btn-orange:hover{background:${C.red}}
.btn-orange:disabled{opacity:.6;cursor:not-allowed}
.btn-sm-ghost{background:transparent;border:1px solid ${C.border};color:${C.silver};padding:6px 14px;font-size:12px;border-radius:6px;transition:all .15s}
.btn-sm-ghost:hover{border-color:${C.silver};color:${C.ink}}
.btn-danger{background:${C.red}14;border:1px solid ${C.red}33;color:${C.redDim};padding:6px 14px;font-size:12px;border-radius:6px;transition:all .15s}
.btn-danger:hover{background:${C.red}28}
.notice{background:${C.teal}0d;border:1px solid ${C.teal}33;border-radius:8px;padding:12px 16px;font-size:13px;color:${C.tealDim};margin-bottom:16px}
.warn{background:${C.gold}0d;border:1px solid ${C.gold}40;border-radius:8px;padding:12px 16px;font-size:13px;color:${C.gold};margin-bottom:16px}
.parse-status{display:flex;align-items:center;gap:10px;padding:12px 16px;border-radius:8px;font-size:13px;margin-top:12px}
.parse-status.loading{background:${C.teal}18;border:1px solid ${C.teal}33;color:${C.teal}}
.parse-status.success{background:${C.green}18;border:1px solid ${C.green}33;color:${C.green}}
.parse-status.error{background:${C.red}18;border:1px solid ${C.red}33;color:${C.red}}
.spinner{display:inline-block;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
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
  .app-body{padding-bottom:88px}
  .mobile-nav{
    display:flex;position:fixed;left:0;right:0;bottom:0;z-index:60;
    background:${C.surface};border-top:1px solid ${C.border};
    padding:6px 4px calc(6px + env(safe-area-inset-bottom));
    box-shadow:0 -2px 16px rgba(0,0,0,.05);
  }
  .mobile-nav-item{
    flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
    background:none;border:none;padding:6px 2px;color:${C.muted};border-radius:8px;
  }
  .mobile-nav-item.active{color:${C.red}}
  .mobile-nav-icon{font-size:18px;line-height:1}
  .mobile-nav-label{font-size:10px;font-weight:500;letter-spacing:.1px}
  .dash-2col{grid-template-columns:1fr}
  .col-heads-2row,.flight-row-top{grid-template-columns:64px 38px 38px 1fr 50px 40px}
  .lp-nav{padding:0 16px}
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
`;

// ── UTILITIES ─────────────────────────────────────────────────────────────────
const fmtMins = m => !m||isNaN(m) ? "0:00" : `${Math.floor(m/60)}:${String(m%60).padStart(2,"0")}`;
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
const bestMins = (f, tailEntry) => tailEntry?.actualBlockMins!=null ? tailEntry.actualBlockMins : (schedMins(f)??0);
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
    const {data:profile} = await sb.from("profiles").select("*","id=eq."+data.user.id);
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
    const {data:profile} = await sb.from("profiles").select("*","id=eq."+user.id);
    return {...user,...(Array.isArray(profile)?profile[0]:profile)};
  }
  return local.get("fl_session");
}

async function db_loadRosters(userId) {
  if(isConfigured()) {
    const {data} = await sb.from("rosters").select("*","user_id=eq."+userId);
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
    const {data} = await sb.from("tail_logs").select("*","user_id=eq."+userId);
    const map={};
    (data||[]).forEach(r=>{
      map[`${r.roster_id}-${r.flight_key}`] = {
        tail: r.tail_number,
        actualDep: r.actual_dep_time || "",
        actualArr: r.actual_arr_time || "",
        actualBlockMins: r.actual_block_mins ?? null,
      };
    });
    return map;
  }
  return local.get("fl_tails_"+userId)||{};
}

async function db_saveTail(userId, rosterId, flightKey, tail, actualDep="", actualArr="", actualBlockMins=null) {
  if(isConfigured()) {
    await sb.from("tail_logs").upsert({
      user_id:userId, roster_id:rosterId, flight_key:flightKey,
      tail_number:tail,
      actual_dep_time: actualDep || null,
      actual_arr_time: actualArr || null,
      actual_block_mins: actualBlockMins ?? null,
    });
    return;
  }
  const map = local.get("fl_tails_"+userId)||{};
  map[`${rosterId}-${flightKey}`]={tail, actualDep, actualArr, actualBlockMins};
  local.set("fl_tails_"+userId, map);
}

async function db_adminUsers() {
  if(isConfigured()) {
    const {data} = await sb.from("profiles").select("*","order=joined.desc");
    return data||[];
  }
  return (local.get("fl_users")||[
    {id:"u1",email:"admin@flightlog.app",name:"Admin",role:"admin",plan:"admin",joined:"2026-01-01",active:true},
    {id:"u2",email:"pilot@example.com",name:"Mohammed Al Obaidi",role:"pilot",plan:"pro",joined:"2026-05-10",active:true},
  ]).map(u=>({...u}));
}

async function db_adminAllRosters() {
  if(isConfigured()) {
    const {data} = await sb.from("rosters").select("*","order=uploaded_at.desc");
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

  async function submit() {
    setErr(""); setLoading(true);
    try {
      if(mode==="login") {
        const user = await db_signIn(email,password);
        onAuth(user);
      } else {
        if(!name||!email||!password) throw new Error("All fields required.");
        const user = await db_signUp(email,password,name,plan);
        onAuth(user);
      }
    } catch(e) { setErr(e.message); } finally { setLoading(false); }
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
        {err && <div className="auth-error">{err}</div>}
        {mode==="signup" && (
          <div className="form-group">
            <label className="form-label">Full name</label>
            <input className="form-input" placeholder="Captain Jane Smith" value={name} onChange={e=>setName(e.target.value)}/>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" placeholder="you@airline.com" value={email} onChange={e=>setEmail(e.target.value)}/>
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
        </div>
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
// MOBILE NAV
// Fixed bottom tab bar shown only on small screens (<=768px), since the
// Sidebar is hidden at that breakpoint. Compact icon-only labels covering
// the same destinations as the desktop sidebar.
// ─────────────────────────────────────────────────────────────────────────────
function MobileNav({user,page,setPage}) {
  const isAdmin=user.role==="admin";
  const pilotNav=[
    {id:"dashboard",icon:"◈",label:"Home"},
    {id:"calendar",icon:"📅",label:"Calendar"},
    {id:"upload",icon:"↑",label:"Upload"},
    {id:"logbook",icon:"📋",label:"Logbook"},
    {id:"settings",icon:"⚙",label:"Settings"},
  ];
  const adminNav=[
    {id:"admin-overview",icon:"◈",label:"Overview"},
    {id:"admin-users",icon:"👥",label:"Users"},
    {id:"admin-rosters",icon:"📄",label:"Rosters"},
    {id:"admin-settings",icon:"⚙",label:"Settings"},
  ];
  const items = isAdmin ? adminNav : pilotNav;
  return (
    <nav className="mobile-nav">
      {items.map(item=>(
        <button key={item.id} className={`mobile-nav-item ${page===item.id?"active":""}`} onClick={()=>setPage(item.id)}>
          <span className="mobile-nav-icon">{item.icon}</span>
          <span className="mobile-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

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
  const [reviewRoster,setReviewRoster]=useState(null); // the parsed-but-not-yet-saved roster
  const [savedFlag,setSavedFlag]=useState(false);
  const fileRef=useRef();

  async function handleFile(file) {
    if(!file) return;
    if(!file.name.toLowerCase().endsWith(".pdf")&&file.type!=="application/pdf") {
      setStatus("error"); setMsg("Please upload a PDF file."); return;
    }
    setFileName(file.name); setCorrections([]); setSavedFlag(false); setStatus("loading"); setMsg("Reading roster with AI…");
    try {
      const base64 = await fileToBase64(file);
      setMsg("AI is reading and double-checking your roster…");
      const roster = await aiParseRosterPdf(base64);
      if(!roster.calendar?.some(d=>d.flights.length>0)) throw new Error("No flights found. Is this a crew duty roster?");
      const correctionList = Array.isArray(roster._corrections) ? roster._corrections : [];
      const wasVerified = !!roster._verified;
      delete roster._corrections;
      delete roster._verified;
      setCorrections(correctionList);
      setVerified(wasVerified);
      setReviewRoster(roster);
      setStatus("review");
      setMsg("");
    } catch(e) { setStatus("error"); setMsg(e.message||"Parse failed."); }
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
      calendar[di] = { ...calendar[di], flights: [], isOff: true };
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
      const dutyDays = reviewRoster.calendar.filter(d=>d.flights.length>0).length;
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
    const dutyDays = reviewRoster.calendar.filter(d=>d.flights.length>0);
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

        {reviewRoster.calendar.map((d, di) => d.flights.length>0 && (
          <div key={di} className="card" style={{marginBottom:10,padding:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div style={{fontFamily:FM,fontSize:13,color:C.red,fontWeight:600}}>{d.dow} {String(d.day).padStart(2,"0")}</div>
              <button className="btn-sm-ghost" style={{marginLeft:"auto",fontSize:11}} onClick={()=>markDayOff(di)}>Mark day off</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
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
            <><span className="upload-icon"><span className="spinner" style={{fontSize:40,color:C.teal,display:"inline-block"}}>⟳</span></span>
              <h3 style={{color:C.ink,fontWeight:500}}>{msg}</h3>
              <p style={{marginTop:6}}>{fileName}</p></>
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
    if(!d || d.flights.length===0) return "off";
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
            <div className="cal-detail-off">Off day — no scheduled flights.</div>
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
    const val=(tmp[tk]??"").trim().toUpperCase();
    const existing=tails[tk]||{};
    setSaving(p=>({...p,[tk]:true}));
    await db_saveTail(user.id, roster.id, k, val, existing.actualDep, existing.actualArr, existing.actualBlockMins);
    onTailSaved(tk, {tail:val, actualDep:existing.actualDep||"", actualArr:existing.actualArr||"", actualBlockMins:existing.actualBlockMins??null});
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
        onTailSaved(tk,{tail:res.tailNumber, actualDep:newDep, actualArr:newArr, actualBlockMins:newBlockMins});
      }
    } catch { setLkStatus(p=>({...p,[tk]:"error"})); }
  }

  function startEditTimes(di,fi) {
    const tk=tkey(di,fi);
    const entry=tails[tk]||{};
    // Only pre-fill with a server-computed value (timezone-correct). If we don't
    // have one, leave blank rather than guessing wrong via naive local-time subtraction.
    const currentBlock = entry.actualBlockMins!=null ? fmtMins(entry.actualBlockMins) : "";
    setTimeEdits(p=>({...p,[tk]:{actualDep:entry.actualDep||"",actualArr:entry.actualArr||"",blockHr:currentBlock}}));
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
    // Manually entered block hour takes precedence (timezone-correct since the
    // pilot enters the real duration directly, not derived from two clock times)
    const manualBlockMins = parseBlockHrToMins(edit.blockHr);
    setSaving(p=>({...p,[tk]:true}));
    await db_saveTail(user.id, roster.id, k, existing.tail||"", dep, arr, manualBlockMins);
    onTailSaved(tk, {tail:existing.tail||"", actualDep:dep, actualArr:arr, actualBlockMins:manualBlockMins});
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
        const ft=d.flights.reduce((a,f)=>a+(schedMins(f)??0),0);
        const isAdding=addingDay===di;
        return (
          <div key={di} className={`day-card ${isToday?"today-card":""} ${allSaved?"logged-card":""}`}>
            <div className="day-card-header" onClick={()=>setExp(p=>({...p,[di]:!expanded}))}>
              <div className="day-date">{d.dow} {String(d.day).padStart(2,"0")}</div>
              <div className={`day-dot ${dotCls}`}/>
              <div className="day-summary-text">
                {d.flights.length===0
                  ? <span style={{color:C.muted,fontStyle:"italic",fontSize:12}}>Off</span>
                  : d.flights.map(f=>`${f.dep}→${f.arr}`).join(" · ")}
              </div>
              {ft>0&&<div className="day-ft" title={d.flights.some(schedMinsIsEstimate)?"Estimated from local clock times — may be inaccurate across timezones":"From roster-stated block time"}>{fmtMins(ft)}{d.flights.some(schedMinsIsEstimate)&&<span style={{color:C.gold}}>*</span>}</div>}
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
                  return (
                    <div key={fi} className="flight-row-2line">
                      <div className="flight-row-top">
                        <div className="fr-num">{f.flightNum}</div>
                        <div className="fr-apt">{f.dep}</div>
                        <div className="fr-apt">{f.arr}</div>
                        {isEditing ? (
                          <div className="fr-time-edit">
                            <input className="fr-time-input" placeholder="HH:MM" value={editVals.actualDep}
                              onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,actualDep:e.target.value}}))}/>
                            <span style={{color:C.muted}}>–</span>
                            <input className="fr-time-input" placeholder="HH:MM" value={editVals.actualArr}
                              onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,actualArr:e.target.value}}))}/>
                          </div>
                        ) : hasActual ? (
                          // Once actual times are known, they replace the scheduled
                          // estimate in this slot — actual is what really happened,
                          // scheduled was only ever a plan.
                          <div className="fr-time" style={{color:C.teal}} title="Actual times (synced)">
                            {entry.actualDep}–{entry.actualArr}
                          </div>
                        ) : (
                          <div className="fr-time" title="Scheduled times (from roster)">
                            {f.depTime}–{f.arrTime}
                          </div>
                        )}
                        {isEditing ? (
                          <input className="fr-time-input" style={{width:56}} placeholder="1:30" value={editVals.blockHr}
                            onChange={e=>setTimeEdits(p=>({...p,[tk]:{...editVals,blockHr:e.target.value}}))}/>
                        ) : (
                          <div className="fr-time" style={{color:actualBlock?C.teal:C.muted,fontWeight:actualBlock?600:400}}>
                            {actualBlock || "—"}
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
                          {saving[tk]?<span className="spinner">⟳</span>:saved?"✓ Saved":"Save"}
                        </button>
                        {isEditing ? (
                          <>
                            <button className="fr-save ok" onClick={()=>saveTimes(di,fi)} disabled={saving[tk]}>
                              {saving[tk]?<span className="spinner">⟳</span>:"✓ Save times"}
                            </button>
                            <button className="fr-save" onClick={()=>cancelEditTimes(tk)}>Cancel</button>
                          </>
                        ) : (
                          <button className="fr-save" onClick={()=>startEditTimes(di,fi)}>✏️ Edit times</button>
                        )}
                        <button className="fr-save" onClick={()=>isEditingSched?cancelEditSched():startEditSched(di,fi,f)}>{isEditingSched?"Cancel":"✏️ Edit scheduled"}</button>
                        <button className="fr-save" style={{color:C.red,borderColor:C.red+"55"}} onClick={()=>deleteFlight(di,fi)}>🗑 Remove</button>
                      </div>
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
function SettingsPage({user, rosters, tails}) {
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

  // Restore session on mount
  useEffect(()=>{
    (async()=>{
      try {
        const u=await db_getSession();
        if(u) {
          setUser(u);
          const [rs,ts]=await Promise.all([db_loadRosters(u.id),db_loadTails(u.id)]);
          setRosters(rs); setTails(ts);
          setPage(u.role==="admin"?"admin-overview":"dashboard");
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
    setPage("logbook");
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
    dashboard:"Dashboard", calendar:"Calendar", upload:"Upload Roster", logbook:"Logbook", settings:"Settings",
    "admin-overview":"Overview","admin-users":"User Management","admin-rosters":"All Rosters","admin-settings":"Settings"
  }[page]||page;

  return (
    <>
      <style>{STYLES}</style>
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
          <Sidebar user={user} page={page} setPage={setPage} onLogout={handleLogout}/>
          <div className="app-content">
            <div className="app-topbar">
              <div className="app-page-title">{pageTitle}</div>
              {user.role==="admin"&&<span className="admin-badge">ADMIN</span>}
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:12,color:C.muted}}>{user.name}</span>
                <div className="avatar" style={{width:30,height:30,fontSize:13}}>{initials(user.name)}</div>
              </div>
            </div>
            <div className="app-body">
              {page==="dashboard"&&<Dashboard user={user} rosters={rosters} tails={tails} setPage={setPage}/>}
              {page==="calendar"&&<CalendarPage user={user} rosters={rosters} tails={tails} onRosterUpdated={handleRosterCalendarUpdated}/>}
              {page==="upload"&&<UploadPage user={user} onRosterSaved={handleRosterSaved}/>}
              {page==="logbook"&&<LogbookPage user={user} rosters={rosters} tails={tails} onTailSaved={handleTailSaved} onDeleteRoster={handleDeleteRoster} onRosterUpdated={handleRosterCalendarUpdated}/>}
              {page==="settings"&&<SettingsPage user={user} rosters={rosters} tails={tails}/>}
              {page==="admin-overview"&&<AdminOverview/>}
              {page==="admin-users"&&<AdminUsers/>}
              {page==="admin-rosters"&&<AdminRosters/>}
              {page==="admin-settings"&&<AdminSettings/>}
            </div>
          </div>
          <MobileNav user={user} page={page} setPage={setPage}/>
        </div>
      )}
      <InstallPrompt/>
    </>
  );
}
