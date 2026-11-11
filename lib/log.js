'use strict';

const { redact, knownProcessSecrets } = require('./redact');

function createLogger(config) {
  const secrets = knownProcessSecrets(config);

  function write(level, message, meta) {
    const safeMessage = typeof message === 'string' ? redact(message, secrets) : message;
    const safeMeta = meta ? redact(meta, secrets) : undefined;
    const line = safeMeta
      ? `${new Date().toISOString()} ${level} ${safeMessage} ${JSON.stringify(safeMeta)}`
      : `${new Date().toISOString()} ${level} ${safeMessage}`;
    if (level === 'error') console.error(line);
    else console.log(line);
  }

  return {
    info: (message, meta) => write('info', message, meta),
    error: (message, meta) => write('error', message, meta),
    request(req, status, extra) {
      write('info', 'request', {
        method: req.method,
        path: (req.url || '').split('?')[0],
        status,
        ...(extra || {}),
      });
    },
  };
}

module.exports = { createLogger };
