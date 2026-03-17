/**
 * ██████╗ ███████╗███████╗████████╗██████╗  ██████╗
 * ██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗
 * ██║  ██║█████╗  ███████╗   ██║   ██████╔╝██║   ██║
 * ██║  ██║██╔══╝  ╚════██║   ██║   ██╔══██╗██║   ██║
 * ██████╔╝███████╗███████║   ██║   ██║  ██║╚██████╔╝
 * ╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝
 *
 *   「  D E S T R O   V A N I T Y G U A R D  」
 *   v2.0.0 — by Darky | destro engine
 */

'use strict';

const { loadConfig }     = require('./src/config');
const { DiscordClient }  = require('./src/discord');
const { Gateway }        = require('./src/gateway');
const { Restorer }       = require('./src/restore');
const { MFAHandler }     = require('./src/mfa');
const { SessionPool }    = require('./src/tls');
const logger             = require('./src/logger');
const path               = require('path');
const minimist           = require('minimist');

// ─── Brand Constants ─────────────────────────────────────────────────────────
const DESTRO_VERSION  = 'v2.0.0';
const DESTRO_AUTHOR   = 'Darky';
const DESTRO_BRAND    = 'destro';
const DESTRO_STATUS   = '.destro VanityGuard v2 - OS';
const DESTRO_PLATFORM = 'discord';

// ─── Globals ─────────────────────────────────────────────────────────────────
let globalClient   = null;
let globalRestorer = null;
let globalMfa      = null;
let globalCfg      = null;
let globalGw       = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ['config', 'token', 'mfa', 'log'],
    default: { config: '', token: '', mfa: '', log: '' },
  });

  logger.init(DESTRO_BRAND, argv.log || '');
  logger.banner();

  let cfg;
  try {
    cfg = await loadConfig(argv.config || '');
  } catch (err) {
    logger.error('Config error: %s', err.message);
    process.exit(1);
  }
  globalCfg = cfg;

  if (argv.token) cfg.userToken = argv.token;
  if (argv.mfa)   cfg.mfaSecret = argv.mfa;

  // Session pool
  logger.info('Creating session pool...');
  const pool = new SessionPool(10);
  logger.success('Session pool ready | %d sessions', pool.len());

  // Discord client
  const client = new DiscordClient(cfg.userToken, pool);
  globalClient = client;
  logger.info('Fetching cookies and build number...');
  try {
    await client.init();
  } catch (err) {
    logger.error('Init failed: %s', err.message);
    process.exit(1);
  }
  logger.success('Logged in as %s | Build %d', client.getUserDisplay(), client.buildNumber);

  // MFA
  if (cfg.mfaSecret && cfg.mfaSecret !== 'YOUR_MFA_SECRET_HERE') {
    globalMfa = new MFAHandler(cfg.mfaSecret, client);
    logger.info('Syncing NTP time...');
    await globalMfa.syncTime();
    await globalMfa.prewarm();
    logger.success('MFA enabled and ready');
  } else {
    logger.warn('MFA not configured');
  }

  const restorer = new Restorer(client, globalMfa, pool);
  globalRestorer = restorer;

  // Test sessions
  logger.info('Testing session pool...');
  let working = 0;
  const sessions = pool.all();
  for (let i = 0; i < sessions.length; i++) {
    try {
      const res = await client.request('GET', '/users/@me', null, '', '', i);
      if (res.status === 200) working++;
    } catch (_) {}
  }
  logger.success('Sessions tested | %d/%d working', working, pool.len());

  // Pre-warm TLS
  logger.info('Pre-warming TLS connections...');
  await pool.warmAll();
  logger.success('All connections pre-warmed');

  // Gateway
  const gw = new Gateway(cfg.userToken);
  globalGw = gw;
  gw.onVanityChange = onVanityChange;

  logger.info('Connecting to Discord Gateway...');
  try {
    await gw.connect();
  } catch (err) {
    logger.error('Gateway connect failed: %s', err.message);
    process.exit(1);
  }

  const ready = await gw.waitReady(10_000);
  if (ready) {
    gw.setStreamingStatus(DESTRO_STATUS);
    logger.success('Streaming status set | %s', DESTRO_STATUS);
  }

  logger.divider();
  logger.success('READY — Monitoring vanity URLs | %s %s by %s', DESTRO_BRAND, DESTRO_VERSION, DESTRO_AUTHOR);
  logger.divider();

  // ─── Keep-alive tickers ──────────────────────────────────────────────────
  setInterval(() => {
    client.request('GET', '/users/@me/settings', null, '', '', 0).catch(() => {});
  }, 20_000);

  setInterval(() => {
    if (globalMfa) globalMfa.prewarm().catch(() => {});
  }, 120_000);

  setInterval(() => {
    client.fetchCookies().catch(() => {});
  }, 90_000);

  setInterval(() => {
    pool.warmAll().catch(() => {});
    if (globalRestorer?.turbo) {
      globalRestorer.turbo.reconnectDead();
      globalRestorer.turbo.warmAll();
    }
  }, 15_000);

  setInterval(() => {
    gw.setStreamingStatus(DESTRO_STATUS);
  }, 300_000);

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  process.on('SIGINT',  () => shutdown(gw));
  process.on('SIGTERM', () => shutdown(gw));
}

function shutdown(gw) {
  logger.warn('Shutting down...');
  gw.close();
  process.exit(0);
}

// ─── Vanity change handler ────────────────────────────────────────────────────
async function onVanityChange(entry, oldVanity, newVanity) {
  if (entry.userId === globalClient.userId) return;

  if (globalCfg.guildIds && globalCfg.guildIds.length > 0) {
    if (!globalCfg.guildIds.includes(entry.guildId)) return;
  }

  logger.alert('VANITY CHANGED | /%s -> /%s | Guild %s | By %s',
    oldVanity, newVanity, entry.guildId, entry.userId);

  const start = Date.now();
  const { success, result } = await globalRestorer.restoreVanity(entry.guildId, oldVanity);
  const ms = Date.now() - start;

  if (success) {
    logger.success('[RESTORED] /%s | %s | %dms | %s', oldVanity, result, ms, DESTRO_BRAND);
  } else {
    logger.error('[FAILED] /%s | %s | %dms', oldVanity, result, ms);
  }

  const eventData = {
    guild_id:   entry.guildId,
    user_id:    entry.userId,
    old_vanity: oldVanity,
    new_vanity: newVanity,
    restored:   success,
    result,
    latency_ms: ms,
    engine:     DESTRO_BRAND,
    version:    DESTRO_VERSION,
    timestamp:  Math.floor(Date.now() / 1000),
  };
  logger.debug('Event: %s', JSON.stringify(eventData, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
