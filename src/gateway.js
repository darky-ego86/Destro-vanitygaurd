/**
 * gateway.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const WebSocket = require('ws');
const logger    = require('./logger');
const { USER_AGENT, sleep } = require('./tls');

class Gateway {
  constructor(token) {
    this.token         = token;
    this.ws            = null;
    this.sessionId     = '';
    this.sequence      = 0;
    this.resumeUrl     = '';
    this.heartbeatMs   = 41250;
    this._heartbeatInt = null;
    this._closed       = false;
    this.ready         = false;

    // Callback set by main
    this.onVanityChange = null;
  }

  // ── Connect ────────────────────────────────────────────────────────────────
  async connect() {
    const url = (this.resumeUrl || 'wss://gateway.discord.gg') + '/?v=10&encoding=json';
    this._closed = false;
    this.ready   = false;

    this.ws = new WebSocket(url, {
      handshakeTimeout: 10_000,
      headers: { 'User-Agent': USER_AGENT },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Gateway connect timeout')), 12_000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
        this._startRead();
      });

      this.ws.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ── Read loop ──────────────────────────────────────────────────────────────
  _startRead() {
    const VANITY_MARKER = '"vanity_url_code"';
    const AUDIT_MARKER  = 'GUILD_AUDIT_LOG_ENTRY_CREATE';

    this.ws.on('message', (raw) => {
      const str = raw.toString('utf8');

      // Fast path for vanity events
      if (str.includes(AUDIT_MARKER) && str.includes(VANITY_MARKER)) {
        if (this.onVanityChange) {
          setImmediate(() => this._fastFireVanity(str));
        }

        // Update sequence
        const sIdx = str.indexOf('"s":');
        if (sIdx > 0) {
          let numStr = '';
          for (let i = sIdx + 4; i < str.length; i++) {
            const c = str[i];
            if (c >= '0' && c <= '9') numStr += c;
            else if (numStr) break;
          }
          if (numStr) this.sequence = parseInt(numStr, 10);
        }
        return;
      }

      let event;
      try { event = JSON.parse(str); } catch (_) { return; }

      if (event.s > 0) this.sequence = event.s;

      switch (event.op) {
        case 10: // Hello
          this.heartbeatMs = event.d.heartbeat_interval;
          this._startHeartbeat();
          if (this.sessionId) this._sendResume();
          else                this._sendIdentify();
          break;

        case 11: break; // Heartbeat ACK

        case 0:  // Dispatch
          this._handleDispatch(event);
          break;

        case 7:  // Reconnect
          logger.warn('Gateway reconnect requested');
          this.ws.close();
          this._scheduleReconnect(0);
          break;

        case 9:  // Invalid session
          logger.warn('Gateway session invalidated');
          this.sessionId = '';
          this.sequence  = 0;
          this.ws.close();
          setTimeout(() => this._scheduleReconnect(0), (1 + Math.random() * 4) * 1000);
          break;
      }
    });

    this.ws.on('close',  () => { if (!this._closed) this._scheduleReconnect(0); });
    this.ws.on('error', (err) => {
      logger.error('Gateway error: %s', err.message);
      if (!this._closed) this._scheduleReconnect(0);
    });
  }

  // ── Fast vanity fire ───────────────────────────────────────────────────────
  _fastFireVanity(str) {
    let event;
    try { event = JSON.parse(str); } catch (_) { return; }
    const entry = parseAuditLogEntry(event.d);
    if (!entry) return;
    const { oldVanity, newVanity, found } = extractVanityChange(entry);
    if (found) this.onVanityChange(entry, oldVanity, newVanity).catch(() => {});
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────
  _handleDispatch(event) {
    switch (event.t) {
      case 'READY':
        this.sessionId = event.d.session_id;
        if (event.d.resume_gateway_url) this.resumeUrl = event.d.resume_gateway_url;
        this.ready = true;
        logger.success('Gateway READY');
        break;

      case 'RESUMED':
        this.ready = true;
        logger.success('Gateway RESUMED');
        break;

      case 'GUILD_AUDIT_LOG_ENTRY_CREATE':
        if (this.onVanityChange) {
          const entry = parseAuditLogEntry(event.d);
          if (entry) {
            const { oldVanity, newVanity, found } = extractVanityChange(entry);
            if (found) this.onVanityChange(entry, oldVanity, newVanity).catch(() => {});
          }
        }
        break;
    }
  }

  // ── Identify / Resume ──────────────────────────────────────────────────────
  _sendIdentify() {
    this._send({
      op: 2,
      d: {
        token:        this.token,
        capabilities: 30717,
        properties: {
          os:                  'Windows',
          browser:             'Chrome',
          device:              '',
          system_locale:       'en-US',
          browser_user_agent:  USER_AGENT,
          browser_version:     '139.0.0.0',
          os_version:          '10',
          referrer:            'https://discord.com/',
          referring_domain:    'discord.com',
          release_channel:     'stable',
          client_build_number: 429117,
          has_client_mods:     false,
        },
        compress: false,
        client_state: {
          guild_versions:              {},
          highest_last_message_id:     '0',
          read_state_version:          0,
          user_guild_settings_version: -1,
          user_settings_version:       -1,
          private_channels_version:    '0',
          api_code_version:            0,
        },
      },
    });
  }

  _sendResume() {
    this._send({
      op: 6,
      d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
    });
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  _startHeartbeat() {
    if (this._heartbeatInt) clearInterval(this._heartbeatInt);
    const jitter = Math.random() * this.heartbeatMs;
    setTimeout(() => {
      this._sendHeartbeat();
      this._heartbeatInt = setInterval(() => this._sendHeartbeat(), this.heartbeatMs);
    }, jitter);
  }

  _sendHeartbeat() {
    this._send({ op: 1, d: this.sequence });
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  setStreamingStatus(text) {
    this._send({
      op: 3,
      d: {
        since: null,
        activities: [{
          name:    text,
          type:    1,
          url:     'https://twitch.tv/darky',
          details: 'Protecting Vanity URLs',
          state:   'destro engine — by Darky',
          timestamps: { start: Date.now() },
        }],
        status: 'dnd',
        afk:    false,
      },
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Reconnect ──────────────────────────────────────────────────────────────
  async _scheduleReconnect(attempt) {
    if (this._closed) return;
    const delay = Math.min(Math.pow(2, attempt) * 1000, 30_000);
    logger.warn('Reconnecting in %dms (attempt %d)', delay, attempt + 1);
    await sleep(delay);

    if (this._heartbeatInt) { clearInterval(this._heartbeatInt); this._heartbeatInt = null; }

    try {
      await this.connect();
    } catch (err) {
      logger.error('Reconnect failed: %s', err.message);
      if (attempt < 9) this._scheduleReconnect(attempt + 1);
      else logger.error('Gateway reconnect failed after 10 attempts');
    }
  }

  // ── Ready wait ─────────────────────────────────────────────────────────────
  waitReady(timeoutMs = 10_000) {
    return new Promise((resolve) => {
      if (this.ready) return resolve(true);
      const deadline = Date.now() + timeoutMs;
      const check = setInterval(() => {
        if (this.ready) { clearInterval(check); resolve(true); }
        else if (Date.now() >= deadline) { clearInterval(check); resolve(false); }
      }, 50);
    });
  }

  // ── Close ──────────────────────────────────────────────────────────────────
  close() {
    this._closed = true;
    if (this._heartbeatInt) clearInterval(this._heartbeatInt);
    if (this.ws) this.ws.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseAuditLogEntry(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) { return null; }
}

function extractVanityChange(entry) {
  if (entry.action_type !== 1) return { found: false };
  for (const change of (entry.changes || [])) {
    if (change.key === 'vanity_url_code') {
      const oldVanity = change.old_value || '';
      const newVanity = change.new_value || '';
      if (oldVanity && oldVanity !== newVanity) {
        return {
          oldVanity,
          newVanity,
          found: true,
          userId:  entry.user_id,
          guildId: entry.guild_id,
        };
      }
    }
  }
  return { found: false };
}

// Re-map snake_case to camelCase for the main handler
function normalizeEntry(entry) {
  return {
    guildId:    entry.guild_id,
    userId:     entry.user_id,
    actionType: entry.action_type,
    changes:    entry.changes || [],
  };
}

// Override parseAuditLogEntry to normalise
const _orig = parseAuditLogEntry;
function parseAndNormalize(raw) {
  const e = _orig(raw);
  return e ? normalizeEntry(e) : null;
}

// Patch Gateway to use normalised entries
Gateway.prototype._fastFireVanity = function(str) {
  let event;
  try { event = JSON.parse(str); } catch (_) { return; }
  const raw = typeof event.d === 'string' ? JSON.parse(event.d) : event.d;
  if (!raw) return;
  const entry = normalizeEntry(raw);
  const result = extractVanityChange(raw); // use raw for action_type check
  if (result.found) this.onVanityChange(entry, result.oldVanity, result.newVanity).catch(() => {});
};

Gateway.prototype._handleDispatch = function(event) {
  switch (event.t) {
    case 'READY':
      this.sessionId = event.d.session_id;
      if (event.d.resume_gateway_url) this.resumeUrl = event.d.resume_gateway_url;
      this.ready = true;
      logger.success('Gateway READY');
      break;

    case 'RESUMED':
      this.ready = true;
      logger.success('Gateway RESUMED');
      break;

    case 'GUILD_AUDIT_LOG_ENTRY_CREATE':
      if (this.onVanityChange) {
        const raw   = event.d;
        const entry = normalizeEntry(raw);
        const res   = extractVanityChange(raw);
        if (res.found) this.onVanityChange(entry, res.oldVanity, res.newVanity).catch(() => {});
      }
      break;
  }
};

module.exports = { Gateway, parseAuditLogEntry: parseAndNormalize, extractVanityChange };
