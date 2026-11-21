/**
 * Te'o bool — route shim for the existing `teom` Worker.
 *
 * The pre-existing `teom` Worker (a 1-bit model research prototype) is preserved
 * verbatim in ./original-teom.mjs. This module only intercepts two namespaces:
 *
 *   /hi/teombool        → the Te'o bool chat window (+ owner address gate)
 *   /hi/teombool/api/*  → share / owner / user-id API (KV backed)
 *   /s/:id              → short share link (address gated across IP changes)
 *
 * Plus the AGNi Development Assistant (added 2026-11):
 *
 *   /hi/agni, /hi/agni/lab → original pages + assistant panel injected
 *   /api/agni/assistant/*  → assistant API (chat, challenge, approve, assets)
 *
 * Everything else is delegated untouched to the original worker.
 */
import orig from './original-teom.mjs';
import APP_HTML from './generated/app-html.js';
import GATE_HTML from './generated/gate-html.js';
import {
  handleAssistantChallenge,
  handleAssistantChat,
  handleAssistantApprove,
  handleAssistantTools,
  handleAssistantIndex,
} from './agni/routes.mjs';
import { withAssistant, assistantAsset, ASSISTANT_API_BASE } from './agni/inject.mjs';

const APP_BASE = '/hi/teombool';
const API_BASE = '/hi/teombool/api';
const SHARE_TTL = 60 * 60 * 24 * 7; // 7 days
const OWNER_TTL = 60 * 60 * 24 * 365;
const GATE_COOKIE = 'tmb_gate';

const WORDS = ['NEON','LAMP','ORBIT','PULSE','ECHO','FLINT','HAZE','JADE','ONYX','RUNE','VAPOR','ZEN','EMBER','FROST','DELTA','NOVA'];
const FILE_WORDS = ['teom','bool','nimbus','quill','ember','drift','onyx','flux','vela','kite'];

const enc = new TextEncoder();

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const html = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function num4() { return String(Math.floor(1000 + Math.random() * 9000)); }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmac(secret, payload) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || '0.0.0.0';
}
function cookieValue(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/* ── owner (address) record ─────────────────────────────── */
async function getOwner(env) {
  return env.TMB_SHARES.get('owner', 'json');
}
async function ownerAllows(env, req, ip) {
  const owner = await getOwner(env);
  if (!owner || !owner.enabled) return { ok: true, owner: null };
  if (owner.ip === ip) return { ok: true, owner };
  const token = cookieValue(req, GATE_COOKIE);
  if (token && owner.secret) {
    const [body, sig] = token.split('.');
    if (body && sig) {
      const expect = await hmac(owner.secret, body);
      if (safeEqual(sig, expect)) {
        let claims = null;
        try { claims = JSON.parse(atob(body)); } catch { claims = null; }
        if (claims && claims.e > Date.now()) return { ok: true, owner };
      }
    }
  }
  return { ok: false, owner };
}

/* ── API ─────────────────────────────────────────────────── */
async function handleApi(req, env, url) {
  const ip = clientIp(req);
  const route = url.pathname.slice(API_BASE.length) || '/';

  if (env.TMB_RL) {
    const { success } = await env.TMB_RL.limit({ key: ip });
    if (!success) return json({ ok: false, error: 'rate_limited' }, 429);
  }

  /* --- claim a user id to this address --- */
  if (route === '/claim' && req.method === 'POST') {
    const body = await readJson(req);
    const userId = String(body.userId || '').trim();
    if (!/^TB-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userId)) return json({ ok: false, error: 'bad_user_id' }, 400);
    const prev = await env.TMB_SHARES.get('u:' + userId, 'json');
    await env.TMB_SHARES.put('u:' + userId, JSON.stringify({ ip, createdAt: prev?.createdAt || Date.now(), lastSeen: Date.now() }), { expirationTtl: OWNER_TTL });
    return json({ ok: true, userId, ip });
  }

  /* --- state: is the app locked for me? --- */
  if (route === '/state' && req.method === 'GET') {
    const owner = await getOwner(env);
    return json({
      ok: true,
      locked: !!(owner && owner.enabled),
      isOwner: !!(owner && owner.ip === ip),
      userId: url.searchParams.get('userId') || '',
    });
  }

  /* --- set / change / disable the owner address --- */
  if (route === '/owner' && req.method === 'POST') {
    const body = await readJson(req);
    const address = String(body.address || '').trim().toUpperCase();
    const owner = await getOwner(env);

    if (owner && owner.enabled) {
      const given = await sha256(address);
      if (!safeEqual(given, owner.addressHash)) return json({ ok: false, error: 'wrong_address' }, 403);
    }
    if (body.disable) {
      await env.TMB_SHARES.delete('owner');
      return json({ ok: true, enabled: false });
    }
    if (!/^[A-Z0-9]{2,16}-[0-9]{4}$/.test(address)) return json({ ok: false, error: 'bad_address' }, 400);

    const secret = owner?.secret || randHex(32);
    await env.TMB_SHARES.put('owner', JSON.stringify({
      enabled: true,
      ip,
      addressHash: await sha256(address),
      secret,
      createdAt: owner?.createdAt || Date.now(),
    }), { expirationTtl: OWNER_TTL });
    return json({ ok: true, enabled: true, address });
  }

  /* --- unlock with the owner address → set cookie --- */
  if (route === '/unlock' && req.method === 'POST') {
    const body = await readJson(req);
    const owner = await getOwner(env);
    if (!owner || !owner.enabled) return json({ ok: true });
    const given = await sha256(String(body.address || '').trim().toUpperCase());
    if (!safeEqual(given, owner.addressHash)) {
      await sleep(400);
      return json({ ok: false, error: 'wrong_address' }, 403);
    }
    const claims = btoa(JSON.stringify({ e: Date.now() + 30 * 864e5 }));
    const sig = await hmac(owner.secret, claims);
    return json({ ok: true }, 200, { 'set-cookie': `${GATE_COOKIE}=${claims}.${sig}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure` });
  }

  /* --- create a share --- */
  if (route === '/share' && req.method === 'POST') {
    const body = await readJson(req);
    const userId = String(body.userId || '').trim();
    const title = String(body.title || 'Te\'o bool').slice(0, 160);
    const text = String(body.text || '').slice(0, 4000);
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

    const id = `${pick(FILE_WORDS)}-${num4()}`;
    const addressCode = `${pick(WORDS)}-${num4()}`;
    const rec = {
      ownerId: userId,
      ip,
      addressHash: await sha256(addressCode),
      payload: { title, text, meta, createdAt: Date.now() },
      createdAt: Date.now(),
    };
    await env.TMB_SHARES.put('s:' + id, JSON.stringify(rec), { expirationTtl: SHARE_TTL });
    const origin = url.origin;
    return json({ ok: true, id, shortUrl: `${origin}/s/${id}`, addressCode, expiresIn: SHARE_TTL });
  }

  /* --- resolve a share --- */
  const m = route.match(/^\/share\/([A-Za-z0-9-]{3,40})$/);
  if (m && (req.method === 'GET' || req.method === 'POST')) {
    const id = m[1];
    const rec = await env.TMB_SHARES.get('s:' + id, 'json');
    if (!rec) return json({ ok: false, error: 'not_found' }, 404);
    const body = req.method === 'POST' ? await readJson(req) : {};
    const address = String(body.address ?? url.searchParams.get('address') ?? '').trim().toUpperCase();
    const sameIp = rec.ip === ip;
    if (sameIp) return json({ ok: true, id, payload: rec.payload, viaIp: true });
    if (address) {
      const given = await sha256(address);
      if (safeEqual(given, rec.addressHash)) return json({ ok: true, id, payload: rec.payload, viaAddress: true });
      await sleep(400);
      return json({ ok: false, error: 'wrong_address' }, 403);
    }
    return json({ ok: false, needAddress: true, id, title: rec.payload?.title || 'Te\'o bool' });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── share short link ───────────────────────────────────── */
async function handleShortLink(req, env, url) {
  const id = url.pathname.slice(3);
  const ip = clientIp(req);
  const rec = await env.TMB_SHARES.get('s:' + id, 'json');
  if (!rec) return html(GATE_HTML.replace('/*__STATE__*/', JSON.stringify({ mode: 'missing' })), 404);

  const sameIp = rec.ip === ip;
  const state = {
    mode: sameIp ? 'granted' : 'gate',
    id,
    title: rec.payload?.title || "Te'o bool",
    text: rec.payload?.text || '',
    meta: rec.payload?.meta || {},
    createdAt: rec.createdAt,
    shortUrl: url.origin + '/s/' + id,
  };
  const htmlOut = GATE_HTML.replace('/*__STATE__*/', JSON.stringify(state).replace(/</g, '\\u003c'));
  return html(htmlOut, sameIp ? 200 : 200, {
    'x-tmb-share': id,
  });
}

const AGNI_PAGES = new Set(['/hi/agni', '/hi/agni/', '/hi/agni/lab', '/hi/agni/lab/']);

async function handleAssistantApi(request, env, path) {
  const route = path.slice(ASSISTANT_API_BASE.length) || '/';
  if (route === '/' || route === '') return handleAssistantIndex(request);
  if (route === '/challenge' || route === '/challenge/') return handleAssistantChallenge(request, env);
  if (route === '/chat' || route === '/chat/') return handleAssistantChat(request, env);
  if (route === '/approve' || route === '/approve/') return handleAssistantApprove(request, env);
  if (route === '/tools' || route === '/tools/') return handleAssistantTools(request);
  if (route === '/client.js' || route === '/client.js/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    return assistantAsset('js');
  }
  if (route === '/client.css' || route === '/client.css/') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    return assistantAsset('css');
  }
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ── main router ────────────────────────────────────────────────────── */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path.startsWith(ASSISTANT_API_BASE)) {
        return await handleAssistantApi(request, env, path);
      }
      if (path.startsWith('/s/') && request.method === 'GET') {
        return await handleShortLink(request, env, url);
      }
      if (path.startsWith(API_BASE)) {
        return await handleApi(request, env, url);
      }
      if (path === APP_BASE || path === APP_BASE + '/') {
        const ip = clientIp(request);
        const gate = await ownerAllows(env, request, ip);
        if (!gate.ok) {
          const state = { mode: 'owner-gate', title: "Te'o bool" };
          return html(GATE_HTML.replace('/*__STATE__*/', JSON.stringify(state)), 403);
        }
        return html(APP_HTML, 200, { 'x-tmb-app': '1' });
      }
    } catch (err) {
      return json({ ok: false, error: 'server_error', detail: String(err && err.message || err) }, 500);
    }

    // AGNi pages: keep the original Worker's markup, add the assistant panel.
    if (AGNI_PAGES.has(path) && (request.method === 'GET' || request.method === 'HEAD')) {
      const upstream = await orig.fetch(request, env, ctx);
      return withAssistant(upstream);
    }

    return orig.fetch(request, env, ctx);
  },
};
