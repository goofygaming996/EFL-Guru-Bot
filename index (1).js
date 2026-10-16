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

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const brightness = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

function buildTheme(type, base) {
  if (type === 'tots') {
    return {
      tots: true,
      text: '#F5D060',
      sub: '#00E5FF',
      line: 'rgba(0,229,255,0.7)',
      placeholder: '#00E5FF',
    };
  }
  const light = brightness(base) > 0.6;
  return {
    tots: false,
    top: mix(base, WHITE, 0.42),
    mid: base,
    bottom: mix(base, BLACK, 0.38),
    text: light ? rgb(mix(base, BLACK, 0.82)) : '#FFFFFF',
    sub: light ? rgb(mix(base, BLACK, 0.62)) : rgb(mix(base, WHITE, 0.78)),
    line: light ? rgb(mix(base, BLACK, 0.7), 0.55) : 'rgba(255,255,255,0.6)',
    border: rgb(mix(base, WHITE, 0.8)),
    placeholder: light ? rgb(mix(base, BLACK, 0.7)) : '#FFFFFF',
  };
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

// FIFA-style card outline: curved shoulders, straight sides, curved bottom point.
function shieldPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(300, 16);
  ctx.quadraticCurveTo(430, 16, 568, 64);
  ctx.lineTo(568, 560);
  ctx.bezierCurveTo(568, 680, 470, 740, 300, 786);
  ctx.bezierCurveTo(130, 740, 32, 680, 32, 560);
  ctx.lineTo(32, 64);
  ctx.quadraticCurveTo(170, 16, 300, 16);
  ctx.closePath();
}

function insetShield(ctx, scale) {
  ctx.translate(300, 400);
  ctx.scale(scale, scale);
  ctx.translate(-300, -400);
  shieldPath(ctx);
}

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
  g.addColorStop(0.8, 'rgba(0,0,0,1)');
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

function drawBackground(ctx, theme) {
  // Fill
  shieldPath(ctx);
  if (theme.tots) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#001335');
    g.addColorStop(1, '#000A1A');
    ctx.fillStyle = g;
  } else {
    const g = ctx.createLinearGradient(0, 16, 0, 786);
    g.addColorStop(0, rgb(theme.top));
    g.addColorStop(0.45, rgb(theme.mid));
    g.addColorStop(1, rgb(theme.bottom));
    ctx.fillStyle = g;
  }
  ctx.fill();

  // Sheen + glow, clipped to the card
  ctx.save();
  shieldPath(ctx);
  ctx.clip();

  const glow = ctx.createRadialGradient(365, 240, 10, 365, 240, 260);
  glow.addColorStop(0, theme.tots ? 'rgba(0,229,255,0.22)' : 'rgba(255,255,255,0.38)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = theme.tots ? 'rgba(0,229,255,0.06)' : 'rgba(255,255,255,0.09)';
  for (const [x0, w] of [[-40, 90], [120, 40], [230, 110]]) {
    ctx.beginPath();
    ctx.moveTo(x0 + 260, 0);
    ctx.lineTo(x0 + 260 + w, 0);
    ctx.lineTo(x0 + w - 200, H);
    ctx.lineTo(x0 - 200, H);
    ctx.closePath();
    ctx.fill();
  }

  if (theme.tots) {
    // Gold corner accents on the shoulders
    ctx.fillStyle = '#D4AF37';
    for (const s of [1, -1]) {
      const cx = s === 1 ? 32 : 568;
      ctx.beginPath();
      ctx.moveTo(cx, 60);
      ctx.lineTo(cx + s * 70, 60);
      ctx.lineTo(cx, 150);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Frames
  ctx.save();
  shieldPath(ctx);
  ctx.lineWidth = 6;
  ctx.strokeStyle = theme.tots ? '#D4AF37' : theme.border;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  insetShield(ctx, 0.94);
  ctx.lineWidth = 2 / 0.94;
  ctx.strokeStyle = theme.tots ? '#00E5FF' : theme.line;
  ctx.stroke();
  ctx.restore();

  if (theme.tots) {
    ctx.save();
    insetShield(ctx, 0.9);
    ctx.lineWidth = 1.5 / 0.9;
    ctx.strokeStyle = 'rgba(212,175,55,0.7)';
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Card renderer
// ---------------------------------------------------------------------------
async function renderCard(opts) {
  const { type, color, name, rating, position, stats, roblox, teamLogoUrl, leagueIconUrl } = opts;
  const theme = buildTheme(type, color);

  // Fetch all remote images in parallel; each helper is crash-safe.
  const [avatar, teamLogo, leagueIcon] = await Promise.all([
    fetchRobloxHeadshot(roblox),
    safeLoadImage(teamLogoUrl),
    safeLoadImage(leagueIconUrl),
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  drawBackground(ctx, theme);

  // Player image (right of the left column, behind the name)
  const AV = 360;
  const avX = 190;
  const avY = 96;
  if (avatar) {
    drawAvatarFaded(ctx, avatar, avX, avY, AV);
  } else {
    drawPlaceholderAvatar(ctx, avX, avY, AV, theme.placeholder);
  }

  // Left column: rating, position, divider, club logo, league icon
  const LX = 105;
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  ctx.font = `bold 80px ${FONT}`;
  ctx.fillText(String(rating), LX, 160);
  fitFont(ctx, position, 100, 34);
  ctx.fillStyle = theme.tots ? theme.sub : theme.text;
  ctx.fillText(position, LX, 202);

  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(LX - 30, 222);
  ctx.lineTo(LX + 30, 222);
  ctx.stroke();

  if (teamLogo) drawContain(ctx, teamLogo, LX - 42, 238, 84, 84);
  if (leagueIcon) drawContain(ctx, leagueIcon, LX - 42, 336, 84, 84);

  // Player name
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.text;
  fitFont(ctx, name, 430, 46);
  ctx.fillText(name, W / 2, 504);

  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(140, 522);
  ctx.lineTo(W - 140, 522);
  ctx.stroke();

  // Stats: two columns, three rows, like real cards
  const colA = [['PAC', stats.pace], ['SHO', stats.shooting], ['PAS', stats.passing]];
  const colB = [['DRI', stats.dribbling], ['DEF', stats.defense], ['PHY', stats.physical]];
  const rowY = [568, 612, 656];

  ctx.textAlign = 'left';
  const drawCol = (items, left) => {
    items.forEach(([label, value], i) => {
      ctx.fillStyle = theme.text;
      ctx.font = `bold 40px ${FONT}`;
      const vText = String(value);
      ctx.fillText(vText, left, rowY[i]);
      const vw = ctx.measureText(vText).width;
      ctx.fillStyle = theme.sub;
      ctx.font = `bold 24px ${FONT}`;
      ctx.fillText(label, left + vw + 12, rowY[i]);
    });
  };
  drawCol(colA, 150);
  drawCol(colB, 330);

  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 538);
  ctx.lineTo(W / 2, 664);
  ctx.stroke();

  // TOTS footer tag
  if (theme.tots) {
    const bx = 190, by = 676, bw = 220, bh = 30;
    const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    bg.addColorStop(0, '#B8921F');
    bg.addColorStop(0.5, '#F5D060');
    bg.addColorStop(1, '#B8921F');
    roundRectPath(ctx, bx, by, bw, bh, 8);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = '#001335';
    ctx.textAlign = 'center';
    ctx.font = `bold 15px ${FONT}`;
    try { ctx.letterSpacing = '1px'; } catch { /* unsupported, ignore */ }
    ctx.fillText('TEAM OF THE SEASON', W / 2, by + 21);
    try { ctx.letterSpacing = '0px'; } catch { /* ignore */ }
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
    const type = str(q.cardtype, 'gold', 10).toLowerCase() === 'tots' ? 'tots' : 'gold';

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

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Card server listening on :${PORT}`));
}

module.exports = app;
module.exports.parseColor = parseColor;
module.exports.renderCard = renderCard;
