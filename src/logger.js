/**
 * logger.js — Destro VanityGuard
 * Credits: Darky
 */

'use strict';

const fs = require('fs');

// ─── ANSI Colors ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  purple: '\x1b[35m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

const LEVELS = {
  INFO:    { label: 'INFO ', color: C.cyan   },
  OK:      { label: 'OK   ', color: C.green  },
  WARN:    { label: 'WARN ', color: C.yellow },
  ERROR:   { label: 'ERROR', color: C.red    },
  DEBUG:   { label: 'DEBUG', color: C.purple },
  ALERT:   { label: 'ALERT', color: C.yellow + C.bold },
};

// ─── Banner art ───────────────────────────────────────────────────────────────
const BANNER_ART = [
  '██████╗ ███████╗███████╗████████╗██████╗  ██████╗ ',
  '██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗',
  '██║  ██║█████╗  ███████╗   ██║   ██████╔╝██║   ██║',
  '██║  ██║██╔══╝  ╚════██║   ██║   ██╔══██╗██║   ██║',
  '██████╔╝███████╗███████║   ██║   ██║  ██║╚██████╔╝',
  '╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ',
];

class Logger {
  constructor() {
    this.prefix  = 'destro';
    this.fd      = null;
    this.fileLog = false;
  }

  init(prefix = 'destro', logFile = '') {
    this.prefix = prefix;
    if (logFile) {
      try {
        this.fd = fs.openSync(logFile, 'a');
        this.fileLog = true;
      } catch (_) {}
    }
  }

  _ts() {
    return new Date().toTimeString().slice(0, 8);
  }

  _strip(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  _center(line, width) {
    const clean   = this._strip(line);
    const padding = Math.max(0, Math.floor((width - clean.length) / 2));
    return ' '.repeat(padding) + line;
  }

  _write(levelKey, msg) {
    const { label, color } = LEVELS[levelKey];
    const ts   = this._ts();
    const line = `${C.dim}${ts}${C.reset} ${C.bold}${color}${label}${C.reset} ${color}${msg}${C.reset}\n`;
    process.stdout.write(line);
    if (this.fileLog && this.fd !== null) {
      fs.writeSync(this.fd, `[${ts}] [${label.trim()}] ${msg}\n`);
    }
  }

  _fmt(format, ...args) {
    let i = 0;
    return String(format).replace(/%[sdif%]/g, (m) => {
      if (m === '%%') return '%';
      const val = args[i++];
      if (m === '%d' || m === '%i') return String(parseInt(val, 10));
      if (m === '%f') return String(parseFloat(val));
      return String(val ?? '');
    });
  }

  info(fmt, ...args)    { this._write('INFO',  this._fmt(fmt, ...args)); }
  success(fmt, ...args) { this._write('OK',    this._fmt(fmt, ...args)); }
  warn(fmt, ...args)    { this._write('WARN',  this._fmt(fmt, ...args)); }
  error(fmt, ...args)   { this._write('ERROR', this._fmt(fmt, ...args)); }
  debug(fmt, ...args)   { this._write('DEBUG', this._fmt(fmt, ...args)); }
  alert(fmt, ...args)   { this._write('ALERT', this._fmt(fmt, ...args)); }

  banner() {
    const width = 80;
    process.stdout.write('\n');
    for (const line of BANNER_ART) {
      const colored = `${C.bold}${C.purple}${line}${C.reset}`;
      process.stdout.write(this._center(colored, width) + '\n');
    }
    process.stdout.write('\n');
    process.stdout.write(
      this._center(`${C.bold}${C.cyan}「  D E S T R O   V A N I T Y G U A R D  」${C.reset}`, width) + '\n'
    );
    process.stdout.write('\n');
    process.stdout.write(
      this._center(`${C.dim}${C.white}v2.0.0 — by Darky | destro engine${C.reset}`, width) + '\n'
    );
    process.stdout.write('\n');

    if (this.fileLog && this.fd !== null) {
      for (const line of BANNER_ART) fs.writeSync(this.fd, line + '\n');
      fs.writeSync(this.fd, '\n「  D E S T R O   V A N I T Y G U A R D  」\n');
      fs.writeSync(this.fd, 'v2.0.0 — by Darky | destro engine\n\n');
    }
  }

  divider() {
    const bar    = '━'.repeat(55);
    const colored = `${C.bold}${C.purple}${bar}${C.reset}\n`;
    process.stdout.write(this._center(colored, 100) + '\n');
    if (this.fileLog && this.fd !== null) fs.writeSync(this.fd, bar + '\n');
  }

  section(title) {
    const padded  = `── ${title} ──`;
    const colored = `${C.bold}${C.purple}${padded}${C.reset}\n`;
    process.stdout.write(this._center(colored, 100));
    if (this.fileLog && this.fd !== null) fs.writeSync(this.fd, padded + '\n');
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

module.exports = new Logger();
