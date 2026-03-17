/**
 * turbo.js — Destro VanityGuard
 * Credits: Darky
 *
 * TurboPool: raw keep-alive TCP+TLS connections for ultra-fast PATCH requests.
 */

'use strict';

const net    = require('net');
const tls    = require('tls');
const dns    = require('dns').promises;
const logger = require('./logger');
const { USER_AGENT, sleep } = require('./tls');

class TurboConn {
  constructor() {
    this.socket   = null;
    this.alive    = false;
    this.lastUsed = 0;
    this._buffer  = '';
    this._pending = null; // { resolve, reject }
  }

  async connect(addr) {
    return new Promise((resolve, reject) => {
      const [host, portStr] = addr.split(':');
      const port = parseInt(portStr, 10);

      const raw = net.createConnection({ host, port }, () => {
        raw.setNoDelay(true);
        raw.setKeepAlive(true, 30_000);

        const sock = tls.connect({
          socket:             raw,
          servername:         'discord.com',
          rejectUnauthorized: true,
        }, () => {
          this.socket   = sock;
          this.alive    = true;
          this.lastUsed = Date.now();
          this._buffer  = '';

          sock.on('data', (chunk) => {
            this._buffer += chunk.toString('binary');
            this._tryResolve();
          });

          sock.on('error', () => { this.alive = false; this._rejectPending(); });
          sock.on('close', () => { this.alive = false; this._rejectPending(); });

          resolve();
        });

        sock.on('error', (err) => {
          this.alive = false;
          reject(err);
        });
      });

      raw.on('error', (err) => { this.alive = false; reject(err); });
      raw.setTimeout(3_000, () => { raw.destroy(); reject(new Error('TCP connect timeout')); });
    });
  }

  _tryResolve() {
    if (!this._pending) return;
    // Check if we have a complete HTTP status line
    const nlIdx = this._buffer.indexOf('\r\n');
    if (nlIdx < 0) return;

    const statusLine = this._buffer.slice(0, nlIdx);
    const statusMatch = statusLine.match(/HTTP\/1\.[01] (\d+)/);
    if (!statusMatch) return;

    const status = parseInt(statusMatch[1], 10);
    const { resolve } = this._pending;
    this._pending = null;

    // Read rest asynchronously to keep connection alive
    const headerEnd = this._buffer.indexOf('\r\n\r\n');
    if (headerEnd > 0) {
      this._buffer = this._buffer.slice(headerEnd + 4);
    } else {
      this._buffer = '';
    }
    this.lastUsed = Date.now();
    resolve(status);
  }

  _rejectPending() {
    if (this._pending) {
      this._pending.reject(new Error('Connection lost'));
      this._pending = null;
    }
  }

  fireRaw(data) {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.socket) return resolve(0);

      this._pending = { resolve, reject };
      this._buffer  = '';

      const timeout = setTimeout(() => {
        this._pending = null;
        this.alive    = false;
        resolve(0);
      }, 2_000);

      const origResolve = this._pending.resolve;
      this._pending.resolve = (v) => { clearTimeout(timeout); origResolve(v); };
      this._pending.reject  = (e) => { clearTimeout(timeout); reject(e); };

      this.socket.write(data, (err) => {
        if (err) { this.alive = false; clearTimeout(timeout); resolve(0); }
      });
    });
  }
}

// ─── TurboPool ────────────────────────────────────────────────────────────────
class TurboPool {
  constructor(count, token, cookies, superProps) {
    this._conns     = [];
    this.token      = token;
    this.cookies    = cookies;
    this.superProps = superProps;
    this._count     = count;
    this._addr      = 'discord.com:443';
    this._init(count);
  }

  async _init(count) {
    try {
      const addrs = await dns.resolve4('discord.com');
      if (addrs.length > 0) this._addr = `${addrs[0]}:443`;
    } catch (_) {}

    for (let i = 0; i < count; i++) {
      const tc = new TurboConn();
      tc.connect(this._addr).catch(() => {});
      this._conns.push(tc);
    }
  }

  _buildRawPATCH(guildId, vanityCode, mfaToken) {
    const body = `{"code":"${vanityCode}"}`;
    const path = `/api/v10/guilds/${guildId}/vanity-url`;
    let req = '';
    req += `PATCH ${path} HTTP/1.1\r\n`;
    req += `Host: discord.com\r\n`;
    req += `Authorization: ${this.token}\r\n`;
    req += `Content-Type: application/json\r\n`;
    req += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
    req += `Accept: */*\r\n`;
    req += `Origin: https://discord.com\r\n`;
    req += `User-Agent: ${USER_AGENT}\r\n`;
    req += `X-Super-Properties: ${this.superProps}\r\n`;
    req += `Cookie: ${this.cookies}\r\n`;
    if (mfaToken) req += `X-Discord-Mfa-Authorization: ${mfaToken}\r\n`;
    req += `Connection: keep-alive\r\n`;
    req += `\r\n`;
    req += body;
    return Buffer.from(req, 'utf8');
  }

  _buildRawMFAFinish(ticket, code) {
    const body = `{"ticket":"${ticket}","mfa_type":"totp","data":"${code}"}`;
    let req = '';
    req += `POST /api/v10/mfa/finish HTTP/1.1\r\n`;
    req += `Host: discord.com\r\n`;
    req += `Authorization: ${this.token}\r\n`;
    req += `Content-Type: application/json\r\n`;
    req += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
    req += `User-Agent: ${USER_AGENT}\r\n`;
    req += `Origin: https://discord.com\r\n`;
    req += `X-Super-Properties: ${this.superProps}\r\n`;
    req += `Cookie: ${this.cookies}\r\n`;
    req += `Connection: keep-alive\r\n`;
    req += `\r\n`;
    req += body;
    return Buffer.from(req, 'utf8');
  }

  async turboRestore(guildId, vanityCode, mfaToken, mfaHandler) {
    const rawReq  = this._buildRawPATCH(guildId, vanityCode, mfaToken);
    const fireN   = Math.min(3, this._conns.length);

    const results = await Promise.allSettled(
      this._conns.slice(0, fireN).map((tc, idx) =>
        tc.fireRaw(rawReq).then(status => ({ idx, status }))
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.status === 200) {
        return { ok: true, idx: r.value.idx };
      }
    }

    // MFA fallback
    if (mfaHandler?.hasSecret()) {
      const codes = mfaHandler.getAllCodes();
      for (const code of codes) {
        const mfaRaw = this._buildRawMFAFinish(/* ticket extracted from prior resp */ '', code);
        // If no ticket available, skip
        break;
      }
    }

    return { ok: false, idx: -1 };
  }

  reconnectDead() {
    for (let i = 0; i < this._conns.length; i++) {
      const tc = this._conns[i];
      if (!tc.alive || Date.now() - tc.lastUsed > 45_000) {
        if (tc.socket) { try { tc.socket.destroy(); } catch (_) {} }
        const fresh = new TurboConn();
        fresh.connect(this._addr).catch(() => {});
        this._conns[i] = fresh;
      }
    }
  }

  async warmAll() {
    const rawGET = Buffer.from(
      `GET /api/v10/gateway HTTP/1.1\r\nHost: discord.com\r\nUser-Agent: ${USER_AGENT}\r\nConnection: keep-alive\r\n\r\n`,
      'utf8'
    );
    await Promise.allSettled(this._conns.map(tc => tc.fireRaw(rawGET)));
    await sleep(300);
  }

  updateCredentials(cookies, superProps) {
    this.cookies    = cookies;
    this.superProps = superProps;
  }
}

module.exports = { TurboPool };
