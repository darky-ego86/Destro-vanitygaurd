/**
 * discord.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const https      = require('https');
const logger     = require('./logger');
const { BASE_URL, USER_AGENT, rawRequest, sleep } = require('./tls');
const { v4: uuidv4 } = require('uuid');

class DiscordClient {
  constructor(token, pool) {
    this.token        = token;
    this.pool         = pool;
    this.buildNumber  = 429117;
    this.cookies      = '';
    this.fingerprint  = '';
    this._lastCookie  = 0;
    this._cookieTTL   = 120_000;
    this.userInfo     = null;
    this.userId       = '';
    this._superProps  = '';
    this._baseHeaders = {};
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  async init() {
    await this.fetchCookies();
    this._superProps = this._buildSuperProperties();
    const info = await this.fetchUserInfo();
    this.userInfo = info;
    this.userId   = info.id;
    this._rebuildBaseHeaders();
  }

  // ── Super-properties ───────────────────────────────────────────────────────
  _buildSuperProperties() {
    const props = {
      os:                          'Windows',
      browser:                     'Chrome',
      device:                      '',
      system_locale:               'en-US',
      browser_user_agent:          USER_AGENT,
      browser_version:             '139.0.0.0',
      os_version:                  '10',
      referrer:                    'https://discord.com/',
      referring_domain:            'discord.com',
      referrer_current:            '',
      referring_domain_current:    '',
      release_channel:             'stable',
      client_build_number:         this.buildNumber,
      native_build_number:         null,
      native_build_type:           null,
      client_event_source:         null,
      client_launch_id:            uuidv4(),
      client_heartbeat_session_id: uuidv4(),
      launch_signature:            uuidv4(),
      has_client_mods:             false,
      design_id:                   0,
    };
    return Buffer.from(JSON.stringify(props)).toString('base64');
  }

  // ── Base headers ───────────────────────────────────────────────────────────
  _rebuildBaseHeaders() {
    this._baseHeaders = {
      'authority':          'discord.com',
      'accept':             '*/*',
      'accept-language':    'en-US,en;q=0.9',
      'authorization':      this.token,
      'content-type':       'application/json',
      'cookie':             this.cookies,
      'origin':             'https://discord.com',
      'priority':           'u=1, i',
      'sec-ch-ua':          '"Microsoft Edge";v="139", "Chromium";v="139", "Not:A-Brand";v="24"',
      'sec-ch-ua-mobile':   '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest':     'empty',
      'sec-fetch-mode':     'cors',
      'sec-fetch-site':     'same-origin',
      'user-agent':         USER_AGENT,
      'x-debug-options':    'bugReporterEnabled',
      'x-discord-locale':   'en-US',
      'x-discord-timezone': 'Asia/Kolkata',
      'x-super-properties': this._superProps,
    };
    if (this.fingerprint) {
      this._baseHeaders['x-fingerprint'] = this.fingerprint;
    }
  }

  // ── Cookies ────────────────────────────────────────────────────────────────
  async fetchCookies() {
    const agent = this.pool.get(0);
    try {
      // Fetch build number from Discord page
      const pageRes = await rawRequest(agent, 'GET', 'https://discord.com/channels/@me',
        { 'User-Agent': USER_AGENT }, null);
      const m = pageRes.body.match(/"BUILD_NUMBER":"?(\d+)"?/);
      if (m) {
        this.buildNumber = parseInt(m[1], 10);
        this._superProps = this._buildSuperProperties();
      }

      // Fetch cookies from experiments endpoint
      const expRes = await rawRequest(agent, 'GET', 'https://discord.com/api/v9/experiments',
        { 'User-Agent': USER_AGENT }, null);

      const cookieHeader = expRes.headers['set-cookie'];
      const parts = [];
      if (cookieHeader) {
        const cookieArr = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
        for (const c of cookieArr) {
          const pair = c.split(';')[0];
          if (pair) parts.push(pair);
        }
      }
      parts.push('locale=en-US');
      this.cookies = parts.join('; ');

      try {
        const expData = JSON.parse(expRes.body);
        if (expData.fingerprint) this.fingerprint = expData.fingerprint;
      } catch (_) {}
    } catch (_) {
      this.cookies = '__dcfduid=62f9e16000a211ef8089eda5bffbf7f9; __sdcfduid=62f9e16100a211ef8089eda5bffbf7f9; locale=en-US';
    }
    this._lastCookie = Date.now();
    this._rebuildBaseHeaders();
  }

  async refreshCookies() {
    if (Date.now() - this._lastCookie > this._cookieTTL) {
      await this.fetchCookies();
    }
  }

  // ── Context properties ─────────────────────────────────────────────────────
  _contextProperties(guildId) {
    const props = {
      location:              'Guild Settings',
      location_guild_id:     guildId,
      location_channel_id:   null,
      location_channel_type: null,
    };
    return Buffer.from(JSON.stringify(props)).toString('base64');
  }

  // ── Headers ────────────────────────────────────────────────────────────────
  headers(guildId = '', mfaToken = '') {
    const h = { ...this._baseHeaders };
    if (guildId) {
      h['referer']               = `https://discord.com/channels/${guildId}`;
      h['x-context-properties']  = this._contextProperties(guildId);
    } else {
      h['referer'] = 'https://discord.com/channels/@me';
    }
    if (mfaToken) h['x-discord-mfa-authorization'] = mfaToken;
    return h;
  }

  fastHeaders(guildId = '', mfaToken = '') {
    return this.headers(guildId, mfaToken);
  }

  // ── Generic request ────────────────────────────────────────────────────────
  async request(method, endpoint, body, guildId = '', mfaToken = '', sessionIdx = 0) {
    const url     = BASE_URL + endpoint;
    const hdrs    = this.headers(guildId, mfaToken);
    const agent   = this.pool.get(sessionIdx);
    const bodyStr = body ? JSON.stringify(body) : null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await rawRequest(agent, method, url, hdrs, bodyStr);

        if (res.status === 429) {
          let retryAfter = 1;
          try {
            const d = JSON.parse(res.body);
            if (d.retry_after) retryAfter = parseFloat(d.retry_after);
          } catch (_) {}
          await sleep(retryAfter * 1000);
          continue;
        }

        let data = null;
        try { data = JSON.parse(res.body); } catch (_) {}
        return { status: res.status, data };
      } catch (err) {
        if (attempt < 2) {
          await sleep(500 * Math.pow(2, attempt));
          continue;
        }
        throw new Error('Max retries exceeded: ' + err.message);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── User info ──────────────────────────────────────────────────────────────
  async fetchUserInfo() {
    const { status, data } = await this.request('GET', '/users/@me', null, '', '', 0);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return data;
  }

  getUserDisplay() {
    if (!this.userInfo) return 'Unknown';
    return `${this.userInfo.username} (${this.userInfo.id})`;
  }
}

module.exports = { DiscordClient };
