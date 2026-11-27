/**
 * The access log (morgan): what one line may hold.
 *
 * A line has the path of a request and never its query string. OAuth codes
 * and state values travel in query parameters, and so do the one-time ticket
 * of GET /api/connectors/github/start and the code and state of
 * GET /api/connectors/github/callback: none of them may reach a log. The
 * Referer header can carry the same query string of the page before, so it
 * is logged without one too.
 */
const withoutQuery = (value) => String(value || '').split('?')[0].split('#')[0];

/** The request's path, without its query string. */
const pathOnly = (req) => withoutQuery(req.originalUrl || req.url);

/** The Referer header without a query string, or undefined (morgan prints "-"). */
const refererOnly = (req) => {
  const referer = req.headers && (req.headers.referer || req.headers.referrer);
  return typeof referer === 'string' && referer.length > 0 ? withoutQuery(referer) : undefined;
};

const DEBUG_FORMAT = ':method :path-only :status :response-time ms - :res[content-length]';
const COMBINED_FORMAT = ':remote-addr - :remote-user [:date[clf]] ":method :path-only HTTP/:http-version" :status :res[content-length] ":referrer-only" ":user-agent"';

/** The access-log middleware. `options` are morgan's (a test passes a stream). */
function accessLog(morgan, { debug = false, ...options } = {}) {
  morgan.token('path-only', pathOnly);
  morgan.token('referrer-only', refererOnly);
  return morgan(debug ? DEBUG_FORMAT : COMBINED_FORMAT, options);
}

module.exports = { accessLog, pathOnly, refererOnly };
