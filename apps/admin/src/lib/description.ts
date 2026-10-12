import sanitizeHtml from "sanitize-html";

/**
 * Job descriptions come from third-party boards and job feeds, so they are
 * untrusted HTML. Rendered raw, one posting with a script in it would run in
 * the owner's browser with owner powers (minting invite links, editing
 * criteria). This keeps formatting only: no scripts, styles, event handlers,
 * images or iframes, and links limited to http(s)/mailto.
 *
 * Greenhouse and We Work Remotely store the HTML entity-escaped
 * ("&lt;p&gt;..."), which used to show up as literal tags. Those are decoded
 * first; the sanitizer then runs on the result, so decoding cannot smuggle
 * anything past it.
 */
const ESCAPED_HTML = /&lt;\/?[a-z][a-z0-9]*[\s>&]/i;

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "u",
    "h1", "h2", "h3", "h4", "h5", "h6", "a", "div", "span",
    "code", "pre", "blockquote",
  ],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noreferrer noopener" }),
  },
};

/** Safe HTML for a job description. */
export function safeDescription(raw: string): string {
  const html = ESCAPED_HTML.test(raw) ? decodeBasicEntities(raw) : raw;
  return sanitizeHtml(html, OPTIONS);
}
