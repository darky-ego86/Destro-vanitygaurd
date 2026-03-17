/**
 * tls.js — Destro VanityGuard
 * Credits: Darky
 *
 * SessionPool: pool of HTTPS agents with connection keep-alive.
 * (Node.js does not expose uTLS; we use native https with keep-alive
 *  which is equivalent for most Discord API interactions.)
 */

'use strict';

const https  = require('https');
const http   = require('http');
const logger = require('./logger');

const BASE_URL  = 'https://discord.com/api/v10';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0';

// ─── Helper: raw HTTPS request ────────────────────────────────────────────────
function rawRequest(agent, method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const opts   = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers,
      agent,
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end',  () => {
        const buf = Buffer.concat(chunks);
        let text  = buf.toString('utf8');
        resolve({ status: res.statusCode, body: text, headers: res.headers });
      });
    });

    req.on('error', reject);

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── SessionPool ──────────────────────────────────────────────────────────────
class SessionPool {
  constructor(count = 10) {
    this._agents = [];
    for (let i = 0; i < count; i++) {
      this._agents.push(this._createAgent());
    }
    this._index = 0;
  }

  _createAgent() {
    return new https.Agent({
      keepAlive:           true,
      keepAliveMsecs:      60_000,
      maxSockets:          20,
      maxFreeSockets:      20,
      timeout:             5_000,
      scheduling:          'fifo',
    });
  }

  get(index) {
    return this._agents[index % this._agents.length];
  }

  next() {
    const agent = this._agents[this._index % this._agents.length];
    this._index++;
    return agent;
  }

  all() { return this._agents; }
  len() { return this._agents.length; }

  recreate() {
    for (let i = 0; i < this._agents.length; i++) {
      this._agents[i].destroy();
      this._agents[i] = this._createAgent();
    }
    this._index = 0;
  }

  async warmAll() {
    const promises = this._agents.map(agent =>
      rawRequest(agent, 'GET', 'https://discord.com/api/v10/gateway',
        { 'User-Agent': USER_AGENT }, null).catch(() => {})
    );
    await Promise.allSettled(promises);
    await sleep(500);
  }

  // Make raw request with a specific session index
  async request(method, endpoint, headers, body, sessionIdx = 0) {
    const url   = BASE_URL + endpoint;
    const agent = this.get(sessionIdx);
    return rawRequest(agent, method, url, headers, body);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { SessionPool, rawRequest, BASE_URL, USER_AGENT, sleep };
