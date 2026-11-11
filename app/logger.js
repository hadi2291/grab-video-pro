const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'engine.log');

// Ensure log file doesn't grow infinitely (rotate if > 5MB)
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  }
} catch (e) {}

function getTime() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function writeLog(level, tag, message, details = null) {
  const time = getTime();
  let line = `[${time}] [${level}] [${tag}] ${message}`;
  if (details !== null && details !== undefined) {
    if (typeof details === 'object') {
      try {
        line += '\n    ' + JSON.stringify(details);
      } catch (e) {
        line += '\n    ' + String(details);
      }
    } else {
      line += '\n    ' + String(details);
    }
  }

  // Colorize for CMD console
  const colors = {
    INFO: '\x1b[36m',  // Cyan
    OK: '\x1b[32m',    // Green
    WARN: '\x1b[33m',  // Yellow
    ERROR: '\x1b[31m', // Red
    DEBUG: '\x1b[90m', // Gray
    RESET: '\x1b[0m'
  };

  const color = colors[level] || colors.INFO;
  console.log(`${color}${line}${colors.RESET}`);

  // Also save plain text to engine.log
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {}
}

module.exports = {
  info: (tag, msg, details) => writeLog('INFO', tag, msg, details),
  ok: (tag, msg, details) => writeLog('OK', tag, msg, details),
  warn: (tag, msg, details) => writeLog('WARN', tag, msg, details),
  error: (tag, msg, details) => writeLog('ERROR', tag, msg, details),
  debug: (tag, msg, details) => writeLog('DEBUG', tag, msg, details)
};
