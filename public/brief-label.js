// Label for the collapsible "what we read" brief on the result page and the
// /me detail view.
//
// The stored brief is our condensed summary, not the source — a one-hour
// video yields an ~8k-word transcript but a ~2k-word brief. Counting only the
// brief made it look like we'd read a third of the video, so when the backend
// knows the source's word count (`source_words`, null for older items) we
// show both.

//
// Sources over the size limit are cut before briefing. The backend reports the
// original size as `source_total_words` (null unless something was dropped), and
// we say so — both in this label and in a visible notice (`truncationNotice`) —
// rather than let a partial read pass for a complete one.

const TRANSCRIBED = new Set(["youtube", "video", "audio"]);
const fmt = (n) => n.toLocaleString("en-US");
const isCount = (n) => Number.isInteger(n) && n > 0;

function isTruncated(sourceWords, totalWords) {
  return isCount(sourceWords) && isCount(totalWords) && totalWords > sourceWords;
}

export function briefLabel(brief, sourceWords, sourceType, totalWords) {
  const words = (String(brief || "").match(/\S+/g) || []).length;
  let label = `show our brief · ${fmt(words)} words`;
  if (isCount(sourceWords)) {
    const noun = TRANSCRIBED.has(sourceType) ? "transcript" : "source";
    label += isTruncated(sourceWords, totalWords)
      ? ` (from the first ${fmt(sourceWords)} of ${fmt(totalWords)} ${noun} words)`
      : ` (from ${fmt(sourceWords)} ${noun} words)`;
  }
  return label;
}

// Plain-text warning for a truncated source, or "" when nothing was dropped.
export function truncationNotice(sourceWords, totalWords, sourceType) {
  if (!isTruncated(sourceWords, totalWords)) return "";
  const noun = TRANSCRIBED.has(sourceType) ? "transcript" : "text";
  const pct = Math.max(1, Math.round((sourceWords / totalWords) * 100));
  return (
    `Partial read: this ${noun} is ${fmt(totalWords)} words, longer than we can ` +
    `take in at once, so the brief and verdict cover only the first ` +
    `${fmt(sourceWords)} (${pct}%).`
  );
}

if (typeof window !== "undefined") {
  window.briefLabel = briefLabel;
  window.truncationNotice = truncationNotice;
}
