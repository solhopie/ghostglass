/**
 * Sanitization helpers for static HTML export.
 *
 * Trace data is untrusted input: it may contain closing script tags,
 * HTML/JS injection payloads, malformed Unicode, or hostile filenames.
 * Everything embedded in the exported HTML goes through these helpers.
 */

/** Replace lone UTF-16 surrogates with U+FFFD so JSON/HTML stay well-formed. */
export function sanitizeLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * Serialize a value for embedding inside <script type="application/json">.
 * Escapes "<" so a payload like </script><script>alert(1)</script> can only
 * ever be inert text, never markup. Also neutralizes U+2028/U+2029.
 */
export function escapeForScriptJson(value: unknown): string {
  const json = JSON.stringify(value);
  const clean = sanitizeLoneSurrogates(json);
  return clean.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Minimal HTML escaping for the handful of template-interpolated strings. */
export function escapeHtml(s: string): string {
  return sanitizeLoneSurrogates(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Make a filename safe: keep alphanumerics, dash, underscore, dot.
 * Run IDs are already strictly validated, but export filenames also embed
 * user-chosen output paths — never let those smuggle path separators.
 */
export function safeFileName(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? name;
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return clean.length > 0 ? clean : "ghostglass-export";
}

/** Escape a JS string that will be inlined into a <script> block. */
export function escapeJsString(s: string): string {
  return sanitizeLoneSurrogates(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/</g, "\\u003c")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
