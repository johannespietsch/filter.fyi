// Reserved handle slugs for the future /@username community phase.
//
// User-chosen handles must NOT match anything in here, case-insensitive.
// This list is intentionally broader than the routes that exist today —
// it pre-reserves names we'll plausibly want as top-level routes later
// (explore, feed, search, get/connect/link, etc.) so we don't paint
// ourselves into a corner once real users start claiming handles.
//
// Nothing in the Worker references this yet — the /@username route doesn't
// exist. When signup-with-handle ships, validateHandle() should check
// against RESERVED_HANDLES.has(handle.toLowerCase()).
//
// See architecture_public_urls.md (auto-memory) for the surrounding
// decisions: handle namespace, multi-lens model, handle-change policy.

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Current top-level Worker routes / static pages.
  "api",
  "login",
  "logout",
  "me",
  "join",
  "get",

  // Planned namespaces (community phase).
  "r", "s", "p", "i", // candidate prefixes for shareable content URLs
  "explore",
  "feed",
  "search",
  "connect",
  "link",
  "settings",
  "u", // alt user prefix; reserved so we can never accidentally use it
  "profile",
  "profiles",

  // Public-facing pages we may add.
  "about",
  "help",
  "docs",
  "faq",
  "blog",
  "changelog",
  "press",
  "legal",
  "privacy",
  "terms",
  "contact",
  "pricing",
  "status",

  // Admin / safety.
  "admin",
  "support",
  "root",
  "system",
  "null",
  "undefined",
  "true",
  "false",

  // Auth + identity-adjacent.
  "auth",
  "oauth",
  "signin",
  "signup",
  "register",
  "verify",

  // Common impersonation risks (brand + staff lookalikes).
  "filter",
  "filterfyi",
  "filter-fyi",
  "official",
  "staff",
  "team",
  "moderator",
  "mod",
  "owner",
]);
