/**
 * mfa.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const crypto  = require('crypto');
const dgram   = require('dgram');
const https   = require('https');
const logger  = require('./logger');
const { BASE_URL, USER_AGENT, rawRequest, sleep } = require('./tls');

class MFAHandler {
  constructor(secret, client) {
    const cleaned = secret.toUpperCase().replace(/[\s\-\n]/g, '');
    const padLen  = (8 - (cleaned.length % 8)) % 8;
    const padded  = cleaned + '='.repeat(padLen);

    this._secret      = padded;
    this._secretBytes = this._decodeBase32(padded);
    this._timeOffset  = 0;
    this._cache       = '';
    this._cacheTime   = 0;
    this._cacheTTL    = 280_000;
    this._client      = client;
  }

  // ── Base32 decoder ─────────────────────────────────────────────────────────
  _decodeBase32(str) {
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const output = [];
    for (const char of str.replace(/=/g, '')) {
      const idx = ALPHABET.indexOf(char);
      if (idx < 0) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(output);
  }

  hasSecret() { return this._secretBytes && this._secretBytes.length > 0; }

  // ── NTP time sync ──────────────────────────────────────────────────────────
  syncTime() {
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      const msg  = Buffer.alloc(48);
      msg[0] = 0x1b;

      sock.on('error', () => { sock.close(); resolve(); });

      const t1 = Date.now();

      sock.send(msg, 0, 48, 123, 'time.google.com', (err) => {
        if (err) { sock.close(); return resolve(); }

        const timer = setTimeout(() => { sock.close(); resolve(); }, 3000);

        sock.once('message', (response) => {
          clearTimeout(timer);
          sock.close();

          const t4 = Date.now();
          const secs = response.readUInt32BE(40);
          const NTP_EPOCH = (70 * 365 + 17) * 86400;
          const unixSecs  = secs - NTP_EPOCH;
          const serverMs  = unixSecs * 1000;
          const rtt       = t4 - t1;
          const offsetMs  = serverMs + rtt / 2 - t4;
          const offsetSec = offsetMs / 1000;

          if (Math.abs(offsetSec) > 5) {
            logger.warn('NTP offset too large (%.3fs), ignoring', offsetSec);
            this._timeOffset = 0;
          } else {
            this._timeOffset = offsetSec;
            logger.info('NTP time offset: %.3fs', this._timeOffset);
          }
          resolve();
        });
      });
    });
  }

  _getTime() {
    return Math.floor((Date.now() + this._timeOffset * 1000) / 1000);
  }

  // ── TOTP generation ────────────────────────────────────────────────────────
  _generateTOTP(offsetSecs = 0) {
    if (!this.hasSecret()) return '';
    const ts      = this._getTime() + offsetSecs;
    const counter = Math.floor(ts / 30);
    const buf     = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));

    const hmac     = crypto.createHmac('sha1', this._secretBytes);
    hmac.update(buf);
    const hash     = hmac.digest();
    const offset   = hash[hash.length - 1] & 0x0f;
    const truncated = hash.readUInt32BE(offset) & 0x7fffffff;
    return String(truncated % 1_000_000).padStart(6, '0');
  }

  getAllCodes() {
    const seen  = new Set();
    const codes = [];
    for (const offset of [0, -30, 30]) {
      const c = this._generateTOTP(offset);
      if (c && !seen.has(c)) { seen.add(c); codes.push(c); }
    }
    // Raw system clock code
    const raw = this._generateTOTP(0);
    if (raw && !seen.has(raw)) codes.push(raw);
    return codes;
  }

  getCachedToken() {
    if (this._cache && Date.now() - this._cacheTime < this._cacheTTL) return this._cache;
    return '';
  }

  setCachedToken(token) {
    this._cache     = token;
    this._cacheTime = Date.now();
  }

  clearCache() {
    this._cache     = '';
    this._cacheTime = 0;
  }

  // ── Pre-warm ───────────────────────────────────────────────────────────────
  async prewarm() {
    if (!this.hasSecret()) return;
    if (this.getCachedToken()) return;

    logger.info('Pre-warming MFA token...');
    const hdrs    = this._client.headers('', '');
    const agent   = this._client.pool.get(0);

    try {
      const res = await rawRequest(agent, 'POST', BASE_URL + '/users/@me/mfa/totp/enable',
        hdrs, JSON.stringify({}));
      if (res.status !== 401) return;

      const data = JSON.parse(res.body);
      if (data.code !== 60003) return;
      const ticket = data?.mfa?.ticket;
      if (!ticket) return;

      const codes = this.getAllCodes();
      for (const code of codes) {
        const fin = await rawRequest(agent, 'POST', BASE_URL + '/mfa/finish', hdrs,
          JSON.stringify({ ticket, mfa_type: 'totp', data: code }));
        if (fin.status === 200) {
          const fd = JSON.parse(fin.body);
          if (fd.token) { this.setCachedToken(fd.token); logger.success('MFA token pre-warmed'); return; }
        }
        if (fin.status === 429) {
          try {
            const rd = JSON.parse(fin.body);
            if (rd.retry_after) await sleep(rd.retry_after * 1000);
          } catch (_) {}
        }
      }
    } catch (err) {
      logger.warn('MFA pre-warm failed: %s', err.message);
    }
  }

  // ── Solve MFA ──────────────────────────────────────────────────────────────
  async solveMFA(ticket, guildId) {
    const remaining = 30 - (this._getTime() % 30);
    if (remaining <= 3) {
      logger.info('Waiting %ds for next TOTP window', remaining);
      await sleep((remaining + 1) * 1000);
    }

    const codes = this.getAllCodes();
    logger.info('Generated %d unique TOTP codes', codes.length);
    const hdrs  = this._client.headers(guildId, '');
    const agent = this._client.pool.get(0);

    for (let i = 0; i < codes.length; i++) {
      logger.info('Trying TOTP code %d/%d', i + 1, codes.length);
      try {
        const res = await rawRequest(agent, 'POST', BASE_URL + '/mfa/finish', hdrs,
          JSON.stringify({ ticket, mfa_type: 'totp', data: codes[i] }));

        if (res.status === 200) {
          const d = JSON.parse(res.body);
          if (d.token) {
            this.setCachedToken(d.token);
            logger.success('MFA verified with code %d/%d', i + 1, codes.length);
            return d.token;
          }
        }

        const errData = JSON.parse(res.body || '{}');
        if (errData.code === 60011) throw new Error('MFA_TICKET_EXPIRED');
        if (errData.code === 60008) logger.warn('Invalid TOTP code %d/%d, trying next', i + 1, codes.length);
        if (res.status === 429) {
          const ra = errData.retry_after || 5;
          logger.warn('MFA rate limited | Waiting %.1fs', ra);
          await sleep(ra * 1000);
        }
      } catch (err) {
        if (err.message === 'MFA_TICKET_EXPIRED') throw err;
      }
    }
    throw new Error('MFA_ALL_CODES_FAILED');
  }
}

module.exports = { MFAHandler };
