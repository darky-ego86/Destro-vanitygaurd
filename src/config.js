/**
 * config.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const fs   = require('fs');
const path = require('path');

async function loadConfig(cfgPath) {
  // Auto-discover config file
  if (!cfgPath) {
    const candidates = [
      'config.json',
      path.join('..', 'data', 'config.json'),
    ];
    try {
      const exe = path.dirname(process.execPath);
      candidates.push(path.join(exe, 'config.json'));
      candidates.push(path.join(exe, '..', 'data', 'config.json'));
    } catch (_) {}

    for (const c of candidates) {
      if (fs.existsSync(c)) { cfgPath = c; break; }
    }
    if (!cfgPath) cfgPath = 'config.json';
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read config: ${err.message}`);
  }

  const vg = raw?.vanity_guard;
  if (!vg) throw new Error('Missing vanity_guard block in config');

  const cfg = {
    userToken: (vg.user_token || '').trim(),
    mfaSecret: (vg.mfa_secret || '').trim().replace(/[\s\-\n]/g, ''),
    guildIds:  Array.isArray(vg.guild_ids) ? vg.guild_ids : [],
  };

  if (!cfg.userToken || cfg.userToken === 'YOUR_USER_TOKEN_HERE') {
    throw new Error('vanity_guard.user_token not configured');
  }

  return cfg;
}

module.exports = { loadConfig };
