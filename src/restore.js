/**
 * restore.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const https   = require('https');
const logger  = require('./logger');
const { TurboPool } = require('./turbo');
const { BASE_URL, rawRequest, sleep } = require('./tls');

class Restorer {
  constructor(client, mfa, pool) {
    this.client = client;
    this.mfa    = mfa;
    this.pool   = pool;
    this.turbo  = new TurboPool(5, client.token, client.cookies, client._superProps);
    this._log   = new Map(); // guildId:vanity -> timestamp
    logger.info('Turbo pool ready | 5 raw TLS connections');
  }

  // ── Main restore entry ─────────────────────────────────────────────────────
  async restoreVanity(guildId, vanityCode) {
    const start = Date.now();

    let mfaToken = '';
    if (this.mfa) mfaToken = this.mfa.getCachedToken();

    // ── Turbo attempt ─────────────────────────────────────────────────────
    if (this.turbo) {
      try {
        const { ok, idx } = await this.turbo.turboRestore(guildId, vanityCode, mfaToken, this.mfa);
        if (ok) {
          const ms = Date.now() - start;
          this._log.set(`${guildId}:${vanityCode}`, Date.now());
          logger.success('[TURBO] /%s | S%d | %dms', vanityCode, idx, ms);
          return { success: true, result: 'TURBO_OK' };
        }
      } catch (_) {}
    }

    // ── Parallel session attempt ───────────────────────────────────────────
    const url      = `${BASE_URL}/guilds/${guildId}/vanity-url`;
    const payload  = JSON.stringify({ code: vanityCode });
    const headers  = this.client.fastHeaders(guildId, mfaToken);
    const sessions = this.pool.all();
    const fireN    = Math.min(3, sessions.length);
    const agents   = sessions.slice(0, fireN);

    let needMFA    = false;
    let mfaTicket  = '';

    const results = await Promise.allSettled(
      agents.map((agent, idx) =>
        rawRequest(agent, 'PATCH', url, headers, payload)
          .then(res => ({ idx, ...res }))
      )
    );

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { idx, status, body } = r.value;
      if (status === 200) {
        const ms = Date.now() - start;
        this._log.set(`${guildId}:${vanityCode}`, Date.now());
        logger.success('[OK] /%s | S%d | %dms', vanityCode, idx, ms);
        return { success: true, result: 'OK' };
      }
      if (status === 401 && body) {
        try {
          const d = JSON.parse(body);
          const ticket = d?.mfa?.ticket;
          if (ticket) { needMFA = true; mfaTicket = ticket; }
        } catch (_) {}
      }
    }

    // ── MFA solve ─────────────────────────────────────────────────────────
    if (needMFA && this.mfa?.hasSecret()) {
      if (!mfaTicket) {
        try {
          const { status, data } = await this.client.request(
            'PATCH', `/guilds/${guildId}/vanity-url`, { code: vanityCode }, guildId, '', 0
          );
          const ticket = data?.mfa?.ticket;
          if (ticket) mfaTicket = ticket;
        } catch (_) {}
      }

      if (mfaTicket) {
        try {
          const token = await this.mfa.solveMFA(mfaTicket, guildId);
          if (token) {
            const mfaHdrs   = this.client.fastHeaders(guildId, token);
            const mfaResults = await Promise.allSettled(
              agents.map((agent, idx) =>
                rawRequest(agent, 'PATCH', url, mfaHdrs, payload)
                  .then(res => ({ idx, ...res }))
              )
            );
            for (const r of mfaResults) {
              if (r.status === 'fulfilled' && r.value.status === 200) {
                const ms = Date.now() - start;
                this._log.set(`${guildId}:${vanityCode}`, Date.now());
                logger.success('[OK] /%s (MFA) | S%d | %dms', vanityCode, r.value.idx, ms);
                return { success: true, result: 'OK' };
              }
            }
          }
        } catch (err) {
          logger.error('MFA failed: %s', err.message);
        }
      }
    }

    // ── Retry loop ────────────────────────────────────────────────────────
    for (let retry = 0; retry < 5; retry++) {
      const idx    = retry % fireN;
      const mfaTk  = this.mfa ? this.mfa.getCachedToken() : '';
      const hdrs   = this.client.fastHeaders(guildId, mfaTk);
      const agent  = this.pool.get(idx);

      try {
        const res = await rawRequest(agent, 'PATCH', url, hdrs, payload);

        if (res.status === 200) {
          const ms = Date.now() - start;
          this._log.set(`${guildId}:${vanityCode}`, Date.now());
          logger.success('[OK] /%s | Retry %d | %dms', vanityCode, retry + 1, ms);
          return { success: true, result: 'OK' };
        }

        if (res.status === 401 && this.mfa) {
          try {
            const d    = JSON.parse(res.body);
            if (d.code === 60003 && d?.mfa?.ticket) {
              const tok = await this.mfa.solveMFA(d.mfa.ticket, guildId);
              if (tok) {
                const { status } = await this.client.request(
                  'PATCH', `/guilds/${guildId}/vanity-url`, { code: vanityCode }, guildId, tok, idx
                );
                if (status === 200) {
                  const ms = Date.now() - start;
                  this._log.set(`${guildId}:${vanityCode}`, Date.now());
                  logger.success('[OK] /%s (MFA retry) | %dms', vanityCode, ms);
                  return { success: true, result: 'OK' };
                }
              }
            }
          } catch (_) {}
        }

        if (res.status === 429) {
          try {
            const d = JSON.parse(res.body);
            await sleep((d.retry_after || 1) * 1000);
          } catch (_) { await sleep(1000); }
        }

        // Verify ownership
        if (await this._verifyOwnership(guildId, vanityCode)) {
          const ms = Date.now() - start;
          logger.success('[OK] /%s verified | %dms', vanityCode, ms);
          return { success: true, result: 'VERIFIED' };
        }
      } catch (_) {}
    }

    const ms = Date.now() - start;
    logger.error('[FAILED] /%s | %dms', vanityCode, ms);
    return { success: false, result: 'FAILED' };
  }

  // ── Verify ownership ───────────────────────────────────────────────────────
  async _verifyOwnership(guildId, vanityCode) {
    try {
      const { status, data } = await this.client.request(
        'GET', `/guilds/${guildId}/vanity-url`, null, guildId, '', 0
      );
      if (status !== 200 || !data?.code) return false;
      return data.code.toLowerCase() === vanityCode.toLowerCase();
    } catch (_) {
      return false;
    }
  }
}

module.exports = { Restorer };
