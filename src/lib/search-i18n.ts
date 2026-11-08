import glossary from "./search-glossary.json";

type GlossaryEntry = readonly [term: string, english: string];

const TERMS: GlossaryEntry[] = glossary.map(
  ([term, english]) => [term, english] as const,
);

function pushTerms(terms: string[], text: string) {
  for (const word of text.split(/\s+/)) {
    if (word && !terms.includes(word)) terms.push(word);
  }
}

/**
 * Mirrors `src-tauri/src/search_i18n.rs`: the browser preview has no core
 * process, so the demo backend translates non-English queries itself before
 * filtering its data. Returns `null` when nothing in the glossary matched.
 */
export function translateSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed || /^[\x00-\x7F]*$/.test(trimmed)) return null;

  const lowered = trimmed.toLowerCase();
  const terms: string[] = [];
  let latin = "";
  let matched = false;
  let index = 0;

  const flushLatin = () => {
    if (!latin) return;
    pushTerms(terms, latin);
    latin = "";
  };

  while (index < lowered.length) {
    let best: GlossaryEntry | null = null;
    for (const entry of TERMS) {
      if (!lowered.startsWith(entry[0], index)) continue;
      // Rust's `max_by_key` keeps the last equal-length match.
      if (!best || entry[0].length >= best[0].length) best = entry;
    }

    if (best) {
      flushLatin();
      pushTerms(terms, best[1]);
      matched = true;
      index += best[0].length;
      continue;
    }

    const ch = String.fromCodePoint(lowered.codePointAt(index)!);
    if (ch.length === 1 && ch.charCodeAt(0) < 128) {
      if (/\s/.test(ch)) flushLatin();
      else latin += ch;
    } else {
      flushLatin();
    }
    index += ch.length;
  }

  flushLatin();
  if (!matched || terms.length === 0) return null;
  return terms.join(" ");
}
