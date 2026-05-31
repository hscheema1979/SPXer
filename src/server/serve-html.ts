/**
 * serve-html — shared helper for sending HTML pages with base-path awareness.
 *
 * Replaces `res.sendFile(htmlPath)` everywhere we serve a viewer page.
 * When the request comes through nginx with `X-Forwarded-Prefix: /spxer`
 * (the public deploy at bitloom.cloud/spxer/), we:
 *   1. Inject `<meta name="base-path" content="/spxer">` so client JS can
 *      read it (same convention as the legacy serveWithBasePath in replay-routes).
 *   2. Rewrite absolute hrefs/srcs that begin with /static/, /api/, /replay/,
 *      /admin/ to be prefixed. This catches `<link>`, `<script>`, `<a>`,
 *      `<img>` etc. — anything the browser fetches at parse time, before
 *      the spxer-shell.js fetch shim is even loaded.
 *
 * In local dev (no X-Forwarded-Prefix header), no rewriting happens and
 * the file is served as-is.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Request, Response } from 'express';

/** mtime of /static/<file> as a numeric cache-buster, or 'x' if unreadable. */
function staticVersion(file: string): string {
  try {
    const p = path.resolve(__dirname, 'static', file);
    return String(Math.floor(fs.statSync(p).mtimeMs));
  } catch {
    return 'x';
  }
}
const SHELL_CSS_V = staticVersion('spxer-shell.css');
const SHELL_JS_V = staticVersion('spxer-shell.js');

/** Prefixes the spxer-served paths so relative-from-root references work
 *  when the app is mounted under a sub-path like /spxer/. Also appends a
 *  cache-buster (?v=<mtime>) to shell assets so browser caches don't pin
 *  stale shell.js / shell.css. */
function rewriteAbsolutePaths(html: string, prefix: string): string {
  // Match attribute values that start with / and one of the spxer mount points.
  // Limit to single-quoted, double-quoted, and bare-attribute values inside
  // common asset/link tags so we don't rewrite text content or JSON blobs.
  let out = html.replace(
    /(\s(?:href|src|action|data-src|data-href)\s*=\s*["'])(\/(?:static|api|replay|admin|chain|spx|contracts|agent|signal|underlying|ws)(?:\/[^"']*)?)/g,
    (_m, attr, p) => `${attr}${prefix}${p}`,
  );
  // Cache-bust the shell assets — works regardless of prefix.
  out = out
    .replace(/(spxer-shell\.css)(?!\?)/g, `$1?v=${SHELL_CSS_V}`)
    .replace(/(spxer-shell\.js)(?!\?)/g, `$1?v=${SHELL_JS_V}`);
  return out;
}

export function serveHtml(htmlPath: string, req: Request, res: Response): void {
  const prefix =
    (req.headers['x-forwarded-prefix'] as string | undefined) ||
    process.env.BASE_PATH ||
    '';

  if (!prefix) {
    res.sendFile(htmlPath);
    return;
  }

  fs.readFile(htmlPath, 'utf-8', (err, html) => {
    if (err) {
      res.status(500).send(`HTML read failed: ${(err as Error).message}`);
      return;
    }
    let out = html;
    // Add meta tag if not already present.
    if (!out.includes('name="base-path"')) {
      out = out.replace(
        '<head>',
        `<head>\n  <meta name="base-path" content="${prefix}">`,
      );
    }
    out = rewriteAbsolutePaths(out, prefix);
    res.type('html').send(out);
  });
}
