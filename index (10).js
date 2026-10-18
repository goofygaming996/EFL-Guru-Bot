'use strict';

const express = require('express');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const W = 600;
const H = 800;
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB cap per remote image
const MAX_REDIRECTS = 3;
const USER_AGENT =
  'Mozilla/5.0 (compatible; FIFACardGenerator/1.0; +https://example.com/bot)';

// Order of the icons in the row at the bottom of the card (left to right).
// Options: 'nation', 'league', 'club'
const BOTTOM_ORDER = ['nation', 'club', 'league'];

// Small print at the bottom of the card
const BRAND = 'EFL';

// Optional: drop a .ttf/.otf in ./fonts and it is registered automatically.
try {
  const fontDir = path.join(__dirname, 'fonts');
  if (fs.existsSync(fontDir)) {
    for (const f of fs.readdirSync(fontDir)) {
      if (/\.(ttf|otf)$/i.test(f)) {
        GlobalFonts.registerFromPath(path.join(fontDir, f), 'CardFont');
      }
    }
  }
} catch (e) {
  console.warn('Font registration skipped:', e.message);
}
const FONT = 'CardFont, Arial, Helvetica, "DejaVu Sans", sans-serif';

// ---------------------------------------------------------------------------
// Safe networking helpers
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return (
      l === '::1' || l === '::' ||
      l.startsWith('fc') || l.startsWith('fd') ||
      l.startsWith('fe80') || l.startsWith('::ffff:')
    );
  }
  return true;
}

// Blocks requests to localhost / private networks (SSRF protection).
async function assertPublicUrl(urlStr) {
  const url = new URL(urlStr);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported protocol');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Private address blocked');
    return;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private host blocked');
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Private address blocked');
  }
}

async function fetchBuffer(urlStr, extraHeaders = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*,application/json;q=0.9,*/*;q=0.8',
          ...extraHeaders,
        },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error('Response too large');

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error('Response too large');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Too many redirects');
}

// BDFD's $url[encode;...] percent-encodes values, so the URL may arrive
// encoded (https%3A%2F%2F...). Decode defensively without ever throwing.
function normalizeUrl(raw) {
  if (!raw) return null;
  let u = String(raw).trim();
  for (let i = 0; i < 2; i++) {
    if (/^https?:\/\//i.test(u) && !/%3A%2F%2F/i.test(u)) break;
    try {
      const decoded = decodeURIComponent(u);
      if (decoded === u) break;
      u = decoded;
    } catch {
      break;
    }
  }
  return /^https?:\/\//i.test(u) ? u : null;
}

// Never throws: returns an Image or null.
async function safeLoadImage(rawUrl) {
  try {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    const buf = await fetchBuffer(url);
    return await loadImage(buf);
  } catch (err) {
    console.warn('[image] failed:', String(rawUrl).slice(0, 120), '-', err.message);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Roblox headshot via the official Thumbnails API. Never throws.
async function fetchRobloxHeadshot(userId) {
  try {
    if (!/^\d{1,20}$/.test(userId || '')) return null;
    const api =
      `https://thumbnails.roblox.com/v1/users/avatar-headshot` +
      `?userIds=${userId}&size=420x420&format=Png&isCircular=false`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const json = JSON.parse((await fetchBuffer(api)).toString('utf8'));
      const item = json && json.data && json.data[0];
      if (item && item.state === 'Completed' && item.imageUrl) {
        const img = await fetchBuffer(item.imageUrl);
        return await loadImage(img);
      }
      if (!item || item.state === 'Error' || item.state === 'Blocked') return null;
      await sleep(600); // "Pending" -> retry
    }
    return null;
  } catch (err) {
    console.warn('[roblox] failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Color helpers (custom card color)
// ---------------------------------------------------------------------------
const GOLD_RGB = [212, 175, 55];

const NAMED_COLORS = {
  gold: 'D4AF37', red: 'D32F2F', blue: '1E66F5', green: '2E9E4F',
  purple: '8E44AD', pink: 'FF69B4', orange: 'FF8C1A', yellow: 'FFD21F',
  black: '111111', white: 'F2F2F2', silver: 'B8BCC4', grey: '8A8F98',
  gray: '8A8F98', cyan: '00BCD4', teal: '14A098', brown: '8B5A2B',
  navy: '14285A', maroon: '7A1F2B', lime: '8BD42B', bronze: 'CD7F32',
};

// Accepts "ff0000", "#ff0000", "f00" or a color name. Returns [r,g,b] or null.
function parseColor(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.replace(/^#/, '').replace(/\s+/g, '');
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s].toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

// ---------------------------------------------------------------------------
// Nation flag: accepts a 2-letter country code ("in", "br", "gb-eng"),
// a common country name ("brazil"), or a direct image URL.
// ---------------------------------------------------------------------------
const NATION_NAMES = {
  england: 'gb-eng', scotland: 'gb-sct', wales: 'gb-wls', uk: 'gb',
  brazil: 'br', argentina: 'ar', france: 'fr', germany: 'de', spain: 'es',
  portugal: 'pt', italy: 'it', netherlands: 'nl', belgium: 'be', croatia: 'hr',
  india: 'in', usa: 'us', america: 'us', mexico: 'mx', canada: 'ca',
  japan: 'jp', korea: 'kr', morocco: 'ma', egypt: 'eg', nigeria: 'ng',
  senegal: 'sn', ghana: 'gh', uruguay: 'uy', colombia: 'co', poland: 'pl',
  turkey: 'tr', norway: 'no', sweden: 'se', denmark: 'dk', australia: 'au',
  srilanka: 'lk', pakistan: 'pk', bangladesh: 'bd', nepal: 'np',
};

function nationUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^https?:\/\//i.test(s) || /%3A%2F%2F/i.test(s)) return s;
  s = s.toLowerCase().replace(/\s+/g, '');
  if (NATION_NAMES[s]) s = NATION_NAMES[s];
  if (/^[a-z]{2}(-[a-z]{2,3})?$/.test(s)) return `https://flagcdn.com/w320/${s}.png`;
  return null;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const brightness = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function buildTheme(type, base) {
  if (type === 'tots') {
    return {
      special: true,
      bgTop: '#001335', bgBottom: '#000A1A',
      glow: 'rgba(0,229,255,0.22)', ray: 'rgba(0,229,255,0.07)',
      band: ['rgba(0,229,255,0.07)', 'rgba(0,0,0,0.3)'],
      outer: '#D4AF37', inner: '#00E5FF', extra: 'rgba(212,175,55,0.7)',
      accent: '#D4AF37',
      art: 'tots',
      tag: 'TEAM OF THE SEASON', tagFill: ['#B8921F', '#F5D060'], tagText: '#001335',
      text: '#F5D060',
      sub: '#00E5FF',
      line: 'rgba(0,229,255,0.7)',
      placeholder: '#00E5FF',
    };
  }
  if (type === 'totw') {
    return {
      special: true,
      bgTop: '#232323', bgBottom: '#040404',
      glow: 'rgba(242,210,122,0.20)', ray: 'rgba(242,210,122,0.07)',
      band: ['rgba(242,210,122,0.06)', 'rgba(0,0,0,0.35)'],
      outer: '#D4AF37', inner: 'rgba(255,255,255,0.75)', extra: 'rgba(212,175,55,0.6)',
      accent: '#D4AF37',
      art: 'totw',
      tag: 'TEAM OF THE WEEK', tagFill: ['#B8921F', '#F2D27A'], tagText: '#0B0B0B',
      text: '#F2D27A',
      sub: '#E8E8E8',
      line: 'rgba(242,210,122,0.65)',
      placeholder: '#F2D27A',
    };
  }
  if (type === 'icon') {
    return {
      special: true,
      art: 'icon',
      crest: true,
      glow: 'rgba(255,255,255,0.65)',
      text: '#1F1B10',
      sub: '#8C6A12',
      line: 'rgba(140,106,18,0.7)',
      placeholder: '#8C6A12',
    };
  }
  const light = brightness(base) > 0.6;
  return {
    special: false,
    top: mix(base, WHITE, 0.42),
    mid: base,
    bottom: mix(base, BLACK, 0.38),
    ray: 'rgba(255,255,255,0.13)',
    band: [rgb(mix(base, WHITE, 0.5), 0.45), rgb(mix(base, WHITE, 0.2), 0.2)],
    text: light ? rgb(mix(base, BLACK, 0.82)) : '#FFFFFF',
    sub: light ? rgb(mix(base, BLACK, 0.62)) : rgb(mix(base, WHITE, 0.78)),
    line: light ? rgb(mix(base, BLACK, 0.7), 0.55) : 'rgba(255,255,255,0.6)',
    border: rgb(mix(base, WHITE, 0.8)),
    placeholder: light ? rgb(mix(base, BLACK, 0.7)) : '#FFFFFF',
  };
}

// ---------------------------------------------------------------------------
// Card outline (modern FC-style): wide crown, flared shoulders,
// straight sides, bevelled bottom with a centre point.
// Designed in a 604-wide space and mapped onto the 600x800 canvas.
// ---------------------------------------------------------------------------
const SC = 1.2; // scale
const mp = (x, y) => [300 + (x - 302) * SC, 40 + (y - 65) * SC];

function shieldPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(...mp(302, 65));
  // left crown + shoulder flare
  ctx.bezierCurveTo(...mp(250, 65), ...mp(185, 72), ...mp(140, 92));
  ctx.bezierCurveTo(...mp(127, 98), ...mp(102, 122), ...mp(86, 126));
  // left side + bevelled bottom to centre point
  ctx.lineTo(...mp(86, 590));
  ctx.bezierCurveTo(...mp(86, 612), ...mp(104, 628), ...mp(140, 638));
  ctx.bezierCurveTo(...mp(200, 652), ...mp(262, 654), ...mp(302, 668));
  // right bottom + side
  ctx.bezierCurveTo(...mp(342, 654), ...mp(404, 652), ...mp(464, 638));
  ctx.bezierCurveTo(...mp(500, 628), ...mp(518, 612), ...mp(518, 590));
  ctx.lineTo(...mp(518, 126));
  // right shoulder flare + crown
  ctx.bezierCurveTo(...mp(502, 122), ...mp(477, 98), ...mp(464, 92));
  ctx.bezierCurveTo(...mp(419, 72), ...mp(354, 65), ...mp(302, 65));
  ctx.closePath();
}

function insetShield(ctx, scale) {
  ctx.translate(300, 400);
  ctx.scale(scale, scale);
  ctx.translate(-300, -400);
  shieldPath(ctx);
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawContain(ctx, img, x, y, w, h) {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function fitFont(ctx, text, maxWidth, startSize, weight = 'bold') {
  let size = startSize;
  ctx.font = `${weight} ${size}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && size > 14) {
    size -= 2;
    ctx.font = `${weight} ${size}px ${FONT}`;
  }
}

// Player image with a soft fade at the bottom so it blends into the card.
function drawAvatarFaded(ctx, img, x, y, size) {
  const off = createCanvas(size, size);
  const o = off.getContext('2d');
  const scale = Math.min(size / img.width, size / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  o.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
  o.globalCompositeOperation = 'destination-in';
  const g = o.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.82, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  o.fillStyle = g;
  o.fillRect(0, 0, size, size);
  ctx.drawImage(off, x, y);
}

function drawPlaceholderAvatar(ctx, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size * 0.38, size * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + size / 2, y + size * 0.86, size * 0.32, size * 0.26, 0, Math.PI, 0);
  ctx.fill();
  ctx.restore();
}

// Sunburst rays fanning out from a point (clipped to the card by the caller).
function drawRays(ctx, cx, cy, color) {
  const n = 44;
  const step = (Math.PI * 2) / n;
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const wFactor = 0.25 + 0.5 * (((i * 37) % 7) / 7); // deterministic variety
    const a0 = i * step;
    const a1 = a0 + step * wFactor;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 900, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
}

const BAND_Y = 500; // top of the lower info band

function drawStandardBackground(ctx, theme) {
  // Fill
  shieldPath(ctx);
  if (theme.special) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, theme.bgTop);
    g.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = g;
  } else {
    const g = ctx.createLinearGradient(0, 40, 0, 760);
    g.addColorStop(0, rgb(theme.top));
    g.addColorStop(0.45, rgb(theme.mid));
    g.addColorStop(1, rgb(theme.bottom));
    ctx.fillStyle = g;
  }
  ctx.fill();

  // Rays, glow, lower band - clipped to the card
  ctx.save();
  shieldPath(ctx);
  ctx.clip();

  const RX = 410;
  const RY = 330;
  drawRays(ctx, RX, RY, theme.ray);

  const glow = ctx.createRadialGradient(RX, RY, 10, RX, RY, 280);
  glow.addColorStop(0, theme.special ? theme.glow : 'rgba(255,255,255,0.35)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, BAND_Y);

  const band = ctx.createLinearGradient(0, BAND_Y, 0, H);
  band.addColorStop(0, theme.band[0]);
  band.addColorStop(1, theme.band[1]);
  ctx.fillStyle = band;
  ctx.fillRect(0, BAND_Y, W, H - BAND_Y);
  ctx.fillStyle = theme.special ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.3)';
  ctx.fillRect(0, BAND_Y, W, 1.5);

  if (theme.special) {
    // Gold accents on the shoulders
    ctx.fillStyle = theme.accent;
    for (const s of [1, -1]) {
      const cx = s === 1 ? 38 : 562;
      ctx.beginPath();
      ctx.moveTo(cx, 112);
      ctx.lineTo(cx + s * 34, 112);
      ctx.lineTo(cx, 138);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Frames
  ctx.save();
  shieldPath(ctx);
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.special ? theme.outer : theme.border;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  insetShield(ctx, 0.95);
  ctx.lineWidth = 2 / 0.95;
  ctx.strokeStyle = theme.special ? theme.inner : theme.line;
  ctx.stroke();
  ctx.restore();

  if (theme.special) {
    ctx.save();
    insetShield(ctx, 0.91);
    ctx.lineWidth = 1.5 / 0.91;
    ctx.strokeStyle = theme.extra;
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// TOTS / TOTW: crowned outline + custom artwork (gold / colored cards do not
// use any of this).
// ---------------------------------------------------------------------------
function crownPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(...mp(302, 60));
  // centre crown notch, right side
  ctx.bezierCurveTo(...mp(312, 60), ...mp(320, 66), ...mp(326, 74));
  ctx.bezierCurveTo(...mp(332, 66), ...mp(338, 64), ...mp(350, 64));
  // flat top, chamfered corner, straight side
  ctx.lineTo(...mp(466, 64));
  ctx.lineTo(...mp(518, 104));
  ctx.lineTo(...mp(518, 590));
  // bevelled bottom with centre point
  ctx.bezierCurveTo(...mp(518, 612), ...mp(500, 628), ...mp(464, 638));
  ctx.bezierCurveTo(...mp(404, 652), ...mp(342, 654), ...mp(302, 668));
  ctx.bezierCurveTo(...mp(262, 654), ...mp(200, 652), ...mp(140, 638));
  ctx.bezierCurveTo(...mp(104, 628), ...mp(86, 612), ...mp(86, 590));
  // left side, chamfer, flat top, centre crown notch, left side
  ctx.lineTo(...mp(86, 104));
  ctx.lineTo(...mp(138, 64));
  ctx.lineTo(...mp(254, 64));
  ctx.bezierCurveTo(...mp(266, 64), ...mp(272, 66), ...mp(278, 74));
  ctx.bezierCurveTo(...mp(284, 66), ...mp(292, 60), ...mp(302, 60));
  ctx.closePath();
}

function insetCrown(ctx, scale) {
  ctx.translate(300, 400);
  ctx.scale(scale, scale);
  ctx.translate(-300, -400);
  crownPath(ctx);
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function polygon(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// Pointed, curved "swoosh" blade between two points.
function blade(ctx, x0, y0, x1, y1, thick, lift) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2 - lift;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(mx, my - thick, x1, y1);
  ctx.quadraticCurveTo(mx, my + thick, x0, y0);
  ctx.closePath();
}

function goldGradient(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#6b4e12');
  g.addColorStop(0.45, '#F5D060');
  g.addColorStop(0.7, '#C9A030');
  g.addColorStop(1, '#7a5a14');
  return g;
}

function bolt(ctx, pts, color, glow, lw) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.shadowColor = glow;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
  ctx.restore();
}

function drawTotsArt(ctx) {
  const g = ctx.createLinearGradient(40, 40, 520, 760);
  g.addColorStop(0, '#0B2A78');
  g.addColorStop(0.5, '#061A52');
  g.addColorStop(1, '#020A22');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // blue shards
  const shards = [
    ['rgba(40,110,255,0.22)', [[60, 540], [300, 110], [390, 110], [170, 580]]],
    ['rgba(0,200,255,0.12)', [[300, 40], [570, 40], [570, 310], [430, 170]]],
    ['rgba(20,60,200,0.38)', [[40, 380], [270, 300], [340, 340], [40, 540]]],
    ['rgba(0,0,24,0.40)', [[40, 610], [570, 430], [570, 770], [40, 770]]],
  ];
  for (const [c, pts] of shards) {
    ctx.fillStyle = c;
    polygon(ctx, pts);
    ctx.fill();
  }

  // cyan speckles
  const rnd = seeded(7);
  ctx.fillStyle = 'rgba(0,229,255,0.65)';
  for (let i = 0; i < 70; i++) {
    const x = 60 + rnd() * 480;
    const y = 60 + rnd() * 340;
    const s = 1.5 + rnd() * 3;
    ctx.fillRect(x, y, s * 2.2, s * 0.8);
  }

  // gold swooshes
  ctx.fillStyle = goldGradient(ctx, 60, 470, 540, 250);
  blade(ctx, 50, 470, 560, 250, 22, 46);
  ctx.fill();
  ctx.fillStyle = goldGradient(ctx, 120, 540, 560, 330);
  blade(ctx, 100, 530, 570, 340, 15, 30);
  ctx.fill();
  ctx.fillStyle = goldGradient(ctx, 250, 400, 560, 160);
  blade(ctx, 240, 400, 570, 170, 10, 22);
  ctx.fill();

  // lightning
  bolt(ctx, [[552, 112], [522, 158], [536, 172], [500, 222], [514, 236], [470, 296]], '#EAFDFF', '#00E5FF', 2.5);
  bolt(ctx, [[556, 196], [520, 232], [530, 246], [494, 286]], '#CFF8FF', '#00E5FF', 1.8);
}

function drawTotwArt(ctx) {
  const g = ctx.createLinearGradient(40, 40, 520, 760);
  g.addColorStop(0, '#2A2A2A');
  g.addColorStop(0.5, '#0E0E0E');
  g.addColorStop(1, '#040404');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // dark facets
  const facets = [
    ['rgba(255,255,255,0.05)', [[40, 120], [330, 40], [330, 300], [40, 420]]],
    ['rgba(0,0,0,0.35)', [[330, 40], [570, 40], [570, 360], [330, 300]]],
    ['rgba(255,255,255,0.04)', [[40, 430], [330, 300], [570, 380], [570, 520], [40, 520]]],
    ['rgba(0,0,0,0.30)', [[40, 520], [570, 400], [570, 770], [40, 770]]],
  ];
  for (const [c, pts] of facets) {
    ctx.fillStyle = c;
    polygon(ctx, pts);
    ctx.fill();
  }

  // tall gold slab (upper right) + long diagonal bars
  ctx.fillStyle = goldGradient(ctx, 400, 80, 470, 280);
  polygon(ctx, [[392, 96], [436, 70], [472, 262], [428, 276]]);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  polygon(ctx, [[436, 70], [452, 76], [488, 252], [472, 262]]);
  ctx.fill();

  ctx.fillStyle = goldGradient(ctx, 60, 440, 540, 240);
  polygon(ctx, [[56, 436], [556, 226], [562, 262], [62, 474]]);
  ctx.fill();
  ctx.fillStyle = goldGradient(ctx, 120, 500, 560, 320);
  polygon(ctx, [[110, 500], [566, 306], [568, 322], [112, 518]]);
  ctx.fill();

  // gold dust
  const rnd = seeded(21);
  for (let i = 0; i < 70; i++) {
    const x = 250 + rnd() * 310;
    const y = 50 + rnd() * 260;
    const r = 0.8 + rnd() * 2.2;
    ctx.fillStyle = `rgba(245,208,96,${0.25 + rnd() * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // grey marble streaks near the bottom of the art
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 6;
  for (let i = 0; i < 6; i++) {
    const y = 440 + i * 16;
    ctx.beginPath();
    ctx.moveTo(40, y + 30);
    ctx.quadraticCurveTo(260, y - 30 + i * 6, 570, y + 20);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// ICON card: white marble, gold triangles, bevelled gold frame, crest.
// ---------------------------------------------------------------------------
function star(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const x = cx + rr * Math.cos(a);
    const y = cy + rr * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function drawCrest(ctx) {
  const cx = 300;
  const cy = 120;
  star(ctx, cx - 15, cy - 25, 4.5, '#B8921F');
  star(ctx, cx, cy - 30, 5.5, '#B8921F');
  star(ctx, cx + 15, cy - 25, 4.5, '#B8921F');

  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#F6EDD0';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = goldGradient(ctx, cx - 18, cy - 18, cx + 18, cy + 18);
  ctx.stroke();

  // football
  ctx.beginPath();
  ctx.arc(cx, cy, 10.5, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#5A4510';
  ctx.stroke();
  ctx.fillStyle = '#3A2E0A';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const x = cx + 4.8 * Math.cos(a);
    const y = cy + 4.8 * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

// Parallelogram bar parallel to the line a->b, offset `off` along its normal.
function diagBar(ctx, ax, ay, bx, by, off, thick) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const nx = dy / len;
  const ny = -dx / len;
  polygon(ctx, [
    [ax + nx * off, ay + ny * off],
    [bx + nx * off, by + ny * off],
    [bx + nx * (off + thick), by + ny * (off + thick)],
    [ax + nx * (off + thick), ay + ny * (off + thick)],
  ]);
}

function drawIconArt(ctx) {
  const g = ctx.createLinearGradient(0, 40, 0, 760);
  g.addColorStop(0, '#F7F7F5');
  g.addColorStop(0.5, '#E4E4E2');
  g.addColorStop(1, '#F2F2F0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // soft marble clouds
  const rnd = seeded(99);
  for (let i = 0; i < 9; i++) {
    const x = 60 + rnd() * 480;
    const y = 90 + rnd() * 600;
    const r = 60 + rnd() * 110;
    const rg = ctx.createRadialGradient(x, y, 2, x, y, r);
    rg.addColorStop(0, 'rgba(150,150,155,0.14)');
    rg.addColorStop(1, 'rgba(150,150,155,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // faint grey veins
  ctx.strokeStyle = 'rgba(120,120,130,0.14)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 10; i++) {
    const y0 = 80 + rnd() * 640;
    ctx.beginPath();
    ctx.moveTo(40, y0);
    ctx.bezierCurveTo(180, y0 - 80 + rnd() * 160, 380, y0 - 80 + rnd() * 160, 570, y0 - 60 + rnd() * 120);
    ctx.stroke();
  }

  // gold cracks (upper left)
  ctx.strokeStyle = 'rgba(201,160,48,0.75)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 16; i++) {
    let x = 70 + rnd() * 240;
    let y = 130 + rnd() * 300;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (rnd() - 0.4) * 46;
      y += (rnd() - 0.5) * 46;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // long diagonal bars (silver + gold)
  const P1 = [120, 484];
  const P2 = [548, 140];
  const P3 = [560, 484];
  const silver = ctx.createLinearGradient(0, 150, 0, 520);
  silver.addColorStop(0, '#9A9AA0');
  silver.addColorStop(0.5, '#FFFFFF');
  silver.addColorStop(1, '#B5B5BB');
  ctx.fillStyle = silver;
  diagBar(ctx, P1[0], P1[1], P2[0], P2[1], -78, 18);
  ctx.fill();
  ctx.fillStyle = goldGradient(ctx, 100, 500, 540, 160);
  diagBar(ctx, P1[0], P1[1], P2[0], P2[1], -44, 14);
  ctx.fill();

  // nested gold triangles
  const C = [(P1[0] + P2[0] + P3[0]) / 3, (P1[1] + P2[1] + P3[1]) / 3];
  const levels = [[1, 11], [0.8, 7], [0.6, 5]];
  for (const [s, lw] of levels) {
    const pts = [P1, P2, P3].map((p) => [C[0] + (p[0] - C[0]) * s, C[1] + (p[1] - C[1]) * s]);
    polygon(ctx, pts);
    if (s < 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fill();
    }
    ctx.lineJoin = 'miter';
    ctx.lineWidth = lw;
    ctx.strokeStyle = goldGradient(ctx, 100, 500, 560, 140);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
  }

  // gold gems near the apex
  ctx.fillStyle = goldGradient(ctx, 460, 320, 520, 370);
  polygon(ctx, [[470, 345], [492, 318], [514, 345], [492, 372]]);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  polygon(ctx, [[470, 345], [492, 318], [492, 345]]);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  polygon(ctx, [[492, 345], [514, 345], [492, 372]]);
  ctx.fill();
}

function drawIconFrames(ctx) {
  // thin gold line just outside
  ctx.save();
  insetCrown(ctx, 1.035);
  ctx.lineWidth = 3 / 1.035;
  ctx.strokeStyle = '#B8921F';
  ctx.stroke();
  ctx.restore();

  // bevelled gold frame: dark edge, gold body, bright highlight
  ctx.save();
  crownPath(ctx);
  ctx.lineWidth = 16;
  ctx.strokeStyle = '#6B4E12';
  ctx.stroke();
  ctx.lineWidth = 11;
  ctx.strokeStyle = goldGradient(ctx, 0, 40, 0, 760);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,248,210,0.85)';
  ctx.stroke();
  ctx.restore();

  // inner thin lines
  ctx.save();
  insetCrown(ctx, 0.945);
  ctx.lineWidth = 2 / 0.945;
  ctx.strokeStyle = '#C9A030';
  ctx.stroke();
  ctx.restore();
  ctx.save();
  insetCrown(ctx, 0.93);
  ctx.lineWidth = 1 / 0.93;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.stroke();
  ctx.restore();
}

function drawSpecialBackground(ctx, theme) {
  // Art, clipped to the crowned outline
  ctx.save();
  crownPath(ctx);
  ctx.clip();

  if (theme.art === 'tots') drawTotsArt(ctx);
  else if (theme.art === 'icon') drawIconArt(ctx);
  else drawTotwArt(ctx);

  // soft glow behind the player
  const glow = ctx.createRadialGradient(330, 300, 10, 330, 300, 250);
  glow.addColorStop(0, theme.glow);
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, BAND_Y);

  // darker band behind name + stats so text stays readable
  const band = ctx.createLinearGradient(0, BAND_Y, 0, H);
  if (theme.art === 'icon') {
    band.addColorStop(0, 'rgba(255,255,255,0.40)');
    band.addColorStop(1, 'rgba(205,195,165,0.35)');
  } else {
    band.addColorStop(0, 'rgba(0,4,16,0.35)');
    band.addColorStop(1, 'rgba(0,0,0,0.7)');
  }
  ctx.fillStyle = band;
  ctx.fillRect(0, BAND_Y, W, H - BAND_Y);
  ctx.fillStyle = 'rgba(245,208,96,0.35)';
  ctx.fillRect(0, BAND_Y, W, 1.5);
  ctx.restore();

  // Frames
  if (theme.art === 'icon') {
    drawIconFrames(ctx);
    return;
  }
  if (theme.art === 'tots') {
    // cyan neon frame just outside the card
    ctx.save();
    insetCrown(ctx, 1.045);
    ctx.lineWidth = 3 / 1.045;
    ctx.strokeStyle = '#00E5FF';
    ctx.shadowColor = '#00E5FF';
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();
  } else {
    // thin gold line just outside the card
    ctx.save();
    insetCrown(ctx, 1.035);
    ctx.lineWidth = 1.5 / 1.035;
    ctx.strokeStyle = 'rgba(212,175,55,0.85)';
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  crownPath(ctx);
  ctx.lineWidth = 6;
  ctx.strokeStyle = goldGradient(ctx, 0, 40, 0, 760);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  insetCrown(ctx, 0.95);
  ctx.lineWidth = 2 / 0.95;
  ctx.strokeStyle = theme.inner;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  insetCrown(ctx, 0.925);
  ctx.lineWidth = 1.5 / 0.925;
  ctx.strokeStyle = theme.extra;
  ctx.stroke();
  ctx.restore();
}

function drawBackground(ctx, theme) {
  if (theme.special) drawSpecialBackground(ctx, theme);
  else drawStandardBackground(ctx, theme);
}

function drawFlag(ctx, img, x, y, w, h, lineColor) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 5);
  ctx.clip();
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2,
    img.width * s, img.height * s);
  ctx.restore();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, x, y, w, h, 5);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Card renderer
// ---------------------------------------------------------------------------
async function renderCard(opts) {
  const { type, color, name, rating, position, stats, roblox, teamLogoUrl, leagueIconUrl, nation } = opts;
  const theme = buildTheme(type, color);

  // Fetch all remote images in parallel; each helper is crash-safe.
  const [avatar, teamLogo, leagueIcon, flag] = await Promise.all([
    fetchRobloxHeadshot(roblox),
    safeLoadImage(teamLogoUrl),
    safeLoadImage(leagueIconUrl),
    safeLoadImage(nationUrl(nation)),
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  drawBackground(ctx, theme);

  // Player image (centre-right, fading into the lower band)
  const AV = 370;
  const avX = 125;
  const avY = 146;
  if (avatar) {
    drawAvatarFaded(ctx, avatar, avX, avY, AV);
  } else {
    drawPlaceholderAvatar(ctx, avX, avY, AV, theme.placeholder);
  }

  // Event tag at the top (TOTS / TOTW only)
  if (theme.special && theme.tag) {
    const bx = 200, by = 86, bw = 200, bh = 24;
    const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    bg.addColorStop(0, theme.tagFill[0]);
    bg.addColorStop(0.5, theme.tagFill[1]);
    bg.addColorStop(1, theme.tagFill[0]);
    roundRectPath(ctx, bx, by, bw, bh, 7);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = theme.tagText;
    ctx.textAlign = 'center';
    ctx.font = `bold 13px ${FONT}`;
    try { ctx.letterSpacing = '1px'; } catch { /* unsupported, ignore */ }
    ctx.fillText(theme.tag, W / 2, by + 17);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
  }

  if (theme.crest) drawCrest(ctx);

  // Rating + position (top-left)
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  ctx.font = `bold 76px ${FONT}`;
  ctx.fillText(String(rating), 120, 198);
  fitFont(ctx, position, 84, 34);
  ctx.fillStyle = theme.special ? theme.sub : theme.text;
  ctx.fillText(position, 120, 238);

  // Player name
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  fitFont(ctx, name, 400, 44);
  ctx.fillText(name, W / 2, 556);

  // Stats in one row: label above value
  // Goalkeepers use different stat names in the same six slots:
  // pace=DIV, shooting=HAN, passing=KIC, dribbling=REF, defense=SPE, physical=POS
  const isGK = position === 'GK' || position === 'GKP';
  const labels = isGK
    ? ['DIV', 'HAN', 'KIC', 'REF', 'SPE', 'POS']
    : ['PAC', 'SHO', 'PAS', 'DRI', 'DEF', 'PHY'];
  const values = [stats.pace, stats.shooting, stats.passing,
    stats.dribbling, stats.defense, stats.physical];
  values.forEach((value, i) => {
    const x = 300 + (i - 2.5) * 76;
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.sub;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText(labels[i], x, 598);
    ctx.fillStyle = theme.text;
    ctx.font = `bold 38px ${FONT}`;
    ctx.fillText(String(value), x, 646);
  });

  // Icon row: nation flag, league, club (order set by BOTTOM_ORDER)
  const available = {
    nation: flag ? { img: flag, w: 58, h: 38, flag: true } : null,
    league: leagueIcon ? { img: leagueIcon, w: 46, h: 46 } : null,
    club: teamLogo ? { img: teamLogo, w: 46, h: 46 } : null,
  };
  const row = BOTTOM_ORDER.map((k) => available[k]).filter(Boolean);
  if (row.length) {
    const GAP = 24;
    const total = row.reduce((s, it) => s + it.w, 0) + GAP * (row.length - 1);
    let x = W / 2 - total / 2;
    const cy = 686;
    for (const it of row) {
      if (it.flag) drawFlag(ctx, it.img, x, cy - it.h / 2, it.w, it.h, theme.line);
      else drawContain(ctx, it.img, x, cy - it.h / 2, it.w, it.h);
      x += it.w + GAP;
    }
  }

  // Small brand print at the very bottom
  if (BRAND) {
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.sub;
    ctx.globalAlpha = 0.85;
    ctx.font = `bold 14px ${FONT}`;
    try { ctx.letterSpacing = '3px'; } catch { /* ignore */ }
    ctx.fillText(BRAND, W / 2, 723);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
    ctx.globalAlpha = 1;
  }

  return canvas.encode('png');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v, def = '', max = 40) => {
  const s = String(first(v) ?? '').trim();
  return (s || def).slice(0, max);
};
const num = (v, def, min = 1, max = 99) => {
  const n = parseInt(first(v), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/card', async (req, res) => {
  try {
    const q = req.query;
    const ct = str(q.cardtype, 'gold', 10).toLowerCase();
    const type = ct === 'tots' || ct === 'totw' || ct === 'icon' ? ct : 'gold';

    const png = await renderCard({
      type,
      color: parseColor(first(q.color)) || GOLD_RGB,
      roblox: str(q.roblox, '', 20),
      name: str(q.cardname, 'PLAYER', 24).toUpperCase(),
      rating: num(q.rating, 75),
      position: str(q.position, 'ST', 4).toUpperCase(),
      stats: {
        pace: num(q.pace, 70),
        shooting: num(q.shooting, 70),
        passing: num(q.passing, 70),
        dribbling: num(q.dribbling, 70),
        defense: num(q.defense, 40),
        physical: num(q.physical, 70),
      },
      teamLogoUrl: first(q.teamlogo),
      leagueIconUrl: first(q.leagueicon),
      nation: first(q.nation),
    });

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
    });
    res.send(png);
  } catch (err) {
    console.error('[card] render error:', err);
    res.status(500).json({ error: 'Failed to generate card' });
  }
});

// ---------------------------------------------------------------------------
// Card pool for /hourly: players.json sits next to index.js.
// ---------------------------------------------------------------------------
const CARD_TYPES = ['gold', 'tots', 'totw', 'icon'];
// Rarer card types come up less often (1 = normal).
const RARITY = { gold: 1, tots: 0.5, totw: 0.5, icon: 0.25 };

function loadPlayers() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'players.json'), 'utf8'));
    const seen = new Set();
    return raw.map((p, i) => {
      let id = Number(p.id) || i + 1;
      while (seen.has(id)) id += 1000; // keep ids unique
      seen.add(id);
      const cardtype = CARD_TYPES.includes(String(p.cardtype).toLowerCase())
        ? String(p.cardtype).toLowerCase() : 'gold';
      return { ...p, id, cardtype, rating: Number(p.rating) || 70 };
    });
  } catch (e) {
    console.warn('players.json not loaded:', e.message);
    return [];
  }
}
const PLAYERS = loadPlayers();

// Higher rating = rarer. Weight drops about 12% per rating point
// (a 92 shows up roughly 12x less often than a 70).
function weightOf(p) {
  const base = Math.max(0.05, Math.pow(1.12, 95 - p.rating));
  return base * (RARITY[p.cardtype] ?? 1);
}

function pickRandom(list = PLAYERS) {
  const total = list.reduce((s, p) => s + weightOf(p), 0);
  let roll = Math.random() * total;
  for (const p of list) {
    roll -= weightOf(p);
    if (roll <= 0) return p;
  }
  return list[list.length - 1];
}

function cardQuery(p) {
  const q = new URLSearchParams({
    roblox: String(p.roblox ?? ''),
    cardname: String(p.name ?? ''),
    rating: String(p.rating),
    position: String(p.position ?? ''),
    pace: String(p.pace ?? ''),
    shooting: String(p.shooting ?? ''),
    passing: String(p.passing ?? ''),
    dribbling: String(p.dribbling ?? ''),
    defense: String(p.defense ?? ''),
    physical: String(p.physical ?? ''),
    teamlogo: String(p.teamlogo ?? ''),
    leagueicon: String(p.leagueicon ?? ''),
    nation: String(p.nation ?? ''),
    cardtype: p.cardtype,
    color: String(p.color ?? ''),
  });
  return q.toString();
}

// BDFD calls this with $httpGet and reads the fields with $httpResult[...]
app.get('/random', (req, res) => {
  if (!PLAYERS.length) return res.status(503).json({ error: 'No players loaded' });
  const p = pickRandom();
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  const base = `${proto}://${req.get('host')}`;
  res.set('Cache-Control', 'no-store');
  res.json({
    id: p.id,
    name: p.name,
    rating: p.rating,
    position: p.position,
    cardtype: p.cardtype,
    image: `${base}/card?${cardQuery(p)}&file=.png`,
  });
});

// For /inventory: BDFD sends the owned card ids (",1,5,") and gets a ready-to-post list.
app.get('/inventory', (req, res) => {
  const ids = String(first(req.query.ids) ?? '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const owned = [...new Set(ids)]
    .map((id) => PLAYERS.find((p) => p.id === id))
    .filter(Boolean)
    .sort((a, b) => b.rating - a.rating || String(a.name).localeCompare(String(b.name)));

  // Discord messages max out at 2000 characters, so cut the list at about 1500
  const lines = [];
  let len = 0;
  for (const p of owned) {
    const line = `**${p.name}** (ID ${p.id}) - ${p.rating} ${p.position} - ${p.cardtype.toUpperCase()}`;
    if (len + line.length + 1 > 1500) break;
    lines.push(line);
    len += line.length + 1;
  }
  const more = owned.length - lines.length;
  res.set('Cache-Control', 'no-store');
  res.json({
    count: owned.length,
    total: PLAYERS.length,
    text: owned.length
      ? lines.join('\n') + (more > 0 ? `\n...and ${more} more` : '')
      : 'No cards yet. Use /hourly to get your first one!',
  });
});

// For /club: BDFD sends the club ids (",1,5,") and gets the club list + total power.
app.get('/club', (req, res) => {
  const ids = String(first(req.query.ids) ?? '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const members = [...new Set(ids)]
    .map((id) => PLAYERS.find((p) => p.id === id))
    .filter(Boolean);
  const power = members.reduce((sum, p) => sum + p.rating, 0);
  const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
  res.set('Cache-Control', 'no-store');
  res.json({
    count: members.length,
    power,
    text: members.length
      ? members.map((p) => `**${p.name}** - ${cap(p.cardtype)} - ${p.position}\n\u26A1 ${p.rating} power`).join('\n')
      : 'Your club is empty. Use /clubadd to add a card!',
  });
});

// For the Sell button: info about one card by id.
app.get('/info', (req, res) => {
  const p = PLAYERS.find((x) => x.id === parseInt(first(req.query.id), 10));
  res.set('Cache-Control', 'no-store');
  if (!p) return res.status(404).json({ error: 'card not found' });
  res.json({ id: p.id, name: p.name, rating: p.rating, position: p.position, cardtype: p.cardtype });
});

// For /trade: info + card images for two cards at once (a = card being given, b = card being asked for).
app.get('/pair', (req, res) => {
  const a = PLAYERS.find((x) => x.id === parseInt(first(req.query.a), 10));
  const b = PLAYERS.find((x) => x.id === parseInt(first(req.query.b), 10));
  res.set('Cache-Control', 'no-store');
  if (!a || !b) return res.status(404).json({ error: 'card not found' });
  const proto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  const base = `${proto}://${req.get('host')}`;
  const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
  res.json({
    aname: a.name, arating: a.rating, apos: a.position, atype: cap(a.cardtype),
    aimage: `${base}/card?${cardQuery(a)}&file=.png`,
    bname: b.name, brating: b.rating, bpos: b.position, btype: cap(b.cardtype),
    bimage: `${base}/card?${cardQuery(b)}&file=.png`,
  });
});

// Quick check that your cards loaded: open /players in the browser
app.get('/players', (_req, res) => {
  res.json(PLAYERS.map((p) => ({ id: p.id, name: p.name, rating: p.rating, cardtype: p.cardtype })));
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Card server listening on :${PORT}`));
}

module.exports = app;
module.exports.parseColor = parseColor;
module.exports.renderCard = renderCard;
