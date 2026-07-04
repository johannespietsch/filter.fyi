// Hand-written types for share.mjs (plain JS so dev/share.test.mjs can import
// it directly — same pattern as public/md.js).
export interface SharePayload {
  url?: string;
  title?: string;
  source_type?: string;
  verdict?: string;
  analysis?: {
    main_idea?: string;
    why_it_matters?: string;
    grounded_in?: string;
    category?: string;
    time_required?: string;
    suggestions?: Array<{ title?: string; detail?: string; first_step?: string; effort?: string }>;
  };
  actions?: Array<{
    index?: number;
    title?: string;
    detail?: string;
    effort?: string;
    first_step?: string;
    brief?: string;
    brief_link?: string;
  }>;
}

export function renderSharePage(share: { slug: string; payload: SharePayload; createdAt?: string }): string;
export function renderShareNotFound(): string;
export function actionsOf(payload: SharePayload): NonNullable<SharePayload["actions"]>;
export function composeFallbackBrief(action: object, payload: SharePayload): string;
export function escapeHtml(s: unknown): string;
