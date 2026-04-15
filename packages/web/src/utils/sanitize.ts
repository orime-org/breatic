/**
 * HTML sanitization for user-generated rich text.
 *
 * Uses DOMPurify to strip dangerous content (scripts, event handlers,
 * dangerous URLs) while preserving safe formatting tags.
 *
 * MUST be used before any rendering with innerHTML or insertHTML.
 */

import DOMPurify from 'dompurify';

const RICH_TEXT_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote',
    'a', 'img',
    'span', 'div',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'style'],
  ALLOWED_URI_REGEXP: /^(https?:\/\/|mailto:|tel:|\/)/i,
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'formaction'],
};

/**
 * Sanitize rich text HTML for safe rendering.
 *
 * Strips scripts, event handlers, javascript: URLs, and other
 * dangerous content while preserving safe formatting.
 */
export function sanitizeRichText(html: string): string {
  return DOMPurify.sanitize(html, RICH_TEXT_CONFIG);
}
