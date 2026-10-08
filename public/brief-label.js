// Label for the collapsible "what we read" brief on the result page and the
// /me detail view.
//
// The stored brief is our condensed summary, not the source — a one-hour
// video yields an ~8k-word transcript but a ~2k-word brief. Counting only the
// brief made it look like we'd read a third of the video, so when the backend
// knows the source's word count (`source_words`, null for older items) we
// show both.

const TRANSCRIBED = new Set(["youtube", "video", "audio"]);

export function briefLabel(brief, sourceWords, sourceType) {
  const words = (String(brief || "").match(/\S+/g) || []).length;
  let label = `show our brief · ${words.toLocaleString("en-US")} words`;
  if (Number.isInteger(sourceWords) && sourceWords > 0) {
    const noun = TRANSCRIBED.has(sourceType) ? "transcript" : "source";
    label += ` (from ${sourceWords.toLocaleString("en-US")} ${noun} words)`;
  }
  return label;
}

if (typeof window !== "undefined") {
  window.briefLabel = briefLabel;
}
