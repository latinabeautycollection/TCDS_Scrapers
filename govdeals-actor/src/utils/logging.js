/**
 * src/utils/logging.js
 *
 * Enterprise structured logging and run metrics for the acquisition pipeline.
 *
 * Features:
 * - component-scoped loggers
 * - shared run context
 * - safer structured serialization
 * - separated counters for warnings/errors
 * - extensible metrics model
 * - progress and summary helpers
 */

import { log as crawleeLog } from 'crawlee';

export const LOG_LEVELS = /** @type {const} */ ({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
});

const DEFAULT_STATS = () => ({
  startedAt: new Date().toISOString(),

  pagesVisited: 0,
  indexPagesVisited: 0,
  detailPagesVisited: 0,
  blockedPages: 0,
  unavailablePages: 0,

  itemsFound: 0,
  itemsSaved: 0,
  itemsSkipped: 0,

  webhookSent: 0,
  webhookFailed: 0,
  webhookPermanentFailures: 0,
  webhookReplaySuccess: 0,
  webhookReplayFailed: 0,

  warnings: 0,
  errors: 0,
  fatal: 0,
});

const _state = {
  stats: DEFAULT_STATS(),
  runContext: {
    actorRunId: null,
    actorBuildId: null,
    actorTaskId: null,
    inputFingerprint: null,
    pipeline: null,
    sourceName: null,
  },
};

function elapsedSecondsFrom(startedAt) {
  return Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
}

function normalizeErrorForLog(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 5).join('\n') ?? null,
    };
  }
  return err;
}

function safeSerialize(value, maxLength = 4000) {
  try {
    const seen = new WeakSet();

    const json = JSON.stringify(value, (key, val) => {
      if (val instanceof Error) return normalizeErrorForLog(val);
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });

    if (!json) return '';
    if (json.length <= maxLength) return json;
    return `${json.slice(0, maxLength - 3)}...`;
  } catch {
    return '[Unserializable log payload]';
  }
}

function buildPrefix(component) {
  return `[${String(component || 'unknown').toUpperCase()}]`;
}

function buildContextSuffix(data = {}, includeRunContext = true) {
  const merged = includeRunContext
    ? {
        ..._state.runContext,
        ...data,
      }
    : data;

  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  );

  if (Object.keys(cleaned).length === 0) return '';
  return ` — ${safeSerialize(cleaned)}`;
}

function logMessage(level, component, message, data = {}) {
  const prefix = buildPrefix(component);
  const finalMessage = `${prefix} ${message}${buildContextSuffix(data)}`;

  switch (level) {
    case LOG_LEVELS.DEBUG:
      crawleeLog.debug(finalMessage);
      break;
    case LOG_LEVELS.INFO:
      crawleeLog.info(finalMessage);
      break;
    case LOG_LEVELS.WARNING:
      crawleeLog.warning(finalMessage);
      break;
    case LOG_LEVELS.ERROR:
    case LOG_LEVELS.FATAL:
      crawleeLog.error(finalMessage);
      break;
    default:
      crawleeLog.info(finalMessage);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run context + stats lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export function initializeRunContext(context = {}) {
  _state.runContext = {
    ..._state.runContext,
    ...context,
  };
}

export function resetRunStats() {
  _state.stats = DEFAULT_STATS();
}

export function getRunStats() {
  return {
    ..._state.stats,
    elapsedSeconds: elapsedSecondsFrom(_state.stats.startedAt),
    runContext: { ..._state.runContext },
  };
}

export function incrementStat(key, amount = 1) {
  if (!(key in _state.stats)) return;
  _state.stats[key] += amount;
}

export function setStat(key, value) {
  if (!(key in _state.stats)) return;
  _state.stats[key] = value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a logger object bound to a component label.
 *
 * @param {string} component
 * @param {boolean} [debugEnabled=false]
 * @param {{ includeRunContext?: boolean }} [opts]
 */
export function createLogger(component, debugEnabled = false, opts = {}) {
  const includeRunContext = opts.includeRunContext !== false;
  const prefix = buildPrefix(component);

  return {
    debug(msg, data = {}) {
      if (!debugEnabled) return;
      logMessage(LOG_LEVELS.DEBUG, component, msg, includeRunContext ? data : {});
    },

    info(msg, data = {}) {
      logMessage(LOG_LEVELS.INFO, component, msg, includeRunContext ? data : {});
    },

    warning(msg, data = {}) {
      incrementStat('warnings');
      logMessage(LOG_LEVELS.WARNING, component, msg, includeRunContext ? data : {});
    },

    error(msg, data = {}) {
      incrementStat('errors');
      logMessage(LOG_LEVELS.ERROR, component, msg, includeRunContext ? data : {});
    },

    fatal(msg, data = {}) {
      incrementStat('fatal');
      logMessage(LOG_LEVELS.FATAL, component, msg, includeRunContext ? data : {});
    },

    exception(msg, err, data = {}) {
      incrementStat('errors');
      logMessage(LOG_LEVELS.ERROR, component, msg, {
        ...data,
        error: normalizeErrorForLog(err),
      });
    },

    metric(metricName, value, data = {}) {
      logMessage(LOG_LEVELS.INFO, component, `metric:${metricName}`, {
        value,
        ...data,
      });
    },

    progress(label = '', extra = {}) {
      const stats = getRunStats();
      crawleeLog.info(
        `${prefix} Progress${label ? ` — ${label}` : ''} — ` +
          `pages=${stats.pagesVisited} ` +
          `index=${stats.indexPagesVisited} ` +
          `detail=${stats.detailPagesVisited} ` +
          `found=${stats.itemsFound} ` +
          `saved=${stats.itemsSaved} ` +
          `skipped=${stats.itemsSkipped} ` +
          `warnings=${stats.warnings} ` +
          `errors=${stats.errors} ` +
          `elapsed=${stats.elapsedSeconds}s` +
          buildContextSuffix(extra, includeRunContext),
      );
    },

    summary(extra = {}) {
      const stats = getRunStats();
      crawleeLog.info(
        `${prefix} ===== RUN COMPLETE =====\n` +
          `  Actor run id     : ${stats.runContext.actorRunId ?? ''}\n` +
          `  Input fingerprint: ${stats.runContext.inputFingerprint ?? ''}\n` +
          `  Pages visited    : ${stats.pagesVisited}\n` +
          `  Index pages      : ${stats.indexPagesVisited}\n` +
          `  Detail pages     : ${stats.detailPagesVisited}\n` +
          `  Blocked pages    : ${stats.blockedPages}\n` +
          `  Unavailable pages: ${stats.unavailablePages}\n` +
          `  Items found      : ${stats.itemsFound}\n` +
          `  Items saved      : ${stats.itemsSaved}\n` +
          `  Items skipped    : ${stats.itemsSkipped}\n` +
          `  Webhook sent     : ${stats.webhookSent}\n` +
          `  Webhook failed   : ${stats.webhookFailed}\n` +
          `  Warnings         : ${stats.warnings}\n` +
          `  Errors           : ${stats.errors}\n` +
          `  Fatal            : ${stats.fatal}\n` +
          `  Elapsed          : ${stats.elapsedSeconds}s` +
          buildContextSuffix(extra, includeRunContext),
      );
    },
  };
}