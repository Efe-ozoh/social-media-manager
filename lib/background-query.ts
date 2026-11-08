/**
 * Turns post text into an Unsplash search query — Phase 5c.
 *
 * Until the AI step exists, the Compose page derives the "Auto" background
 * query from the text itself: the first sentence, minus stopwords, keeping the
 * two or three most meaningful words. The owner can always edit the query, so
 * this only has to be a reasonable starting point, not a good search engine.
 *
 * Pure and dependency-free: the Compose page is a client component, so nothing
 * here may touch the environment or the network.
 */

/** Words too common to describe a picture. */
const STOPWORDS = new Set([
  // Articles, pronouns, prepositions and friends.
  "about", "above", "after", "again", "against", "almost", "along", "also",
  "although", "always", "among", "another", "any", "anyone", "anything",
  "around", "back", "because", "been", "before", "being", "below", "between",
  "both", "but", "came", "can", "cannot", "could", "did", "does", "doing",
  "done", "down", "during", "each", "even", "ever", "every", "few", "for",
  "from", "get", "gets", "getting", "give", "goes", "going", "gone", "had",
  "has", "have", "having", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "however", "into", "its", "itself", "just", "keep", "know",
  "last", "less", "let", "like", "made", "make", "makes", "many", "may",
  "might", "more", "most", "much", "must", "myself", "never", "next", "not",
  "now", "off", "often", "once", "one", "only", "other", "our", "ours",
  "ourselves", "out", "over", "own", "put", "quite", "rather", "really",
  "said", "same", "saw", "say", "says", "see", "seen", "she", "should",
  "since", "some", "something", "still", "such", "sure", "take", "than",
  "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "thing", "things", "think", "this", "those", "though",
  "three", "through", "thus", "time", "too", "took", "two", "under", "until",
  "upon", "use", "used", "uses", "using", "very", "want", "was", "way",
  "well", "went", "were", "what", "when", "where", "whether", "which",
  "while", "who", "whom", "whose", "why", "will", "with", "within",
  "without", "would", "yes", "yet", "you", "your", "yours", "yourself",
  // Words that say nothing about a picture, or nothing at all.
  "able", "across", "add", "added", "adding", "also", "area", "best", "better",
  "big", "case", "come", "comes", "day", "days", "different", "easy", "end",
  "first", "good", "great", "help", "helps", "here", "high", "important",
  "lot", "new", "need", "needs", "part", "people", "point", "right", "run",
  "running", "simple", "small", "start", "started", "today", "try", "trying",
  "work", "works", "world", "year", "years",
  // Code words: the first line of a code card is rarely a picture.
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "default", "def", "else", "enum", "export", "extends", "false", "finally",
  "for", "from", "func", "function", "if", "impl", "import", "interface",
  "let", "new", "null", "package", "private", "public", "return", "static",
  "struct", "super", "switch", "throw", "true", "try", "type", "undefined",
  "var", "void", "while", "with", "yield",
]);

/** Words shorter than this are almost never a useful search term. */
const MIN_WORD_LENGTH = 3;
/** How much of the post is considered "the first sentence". */
const MAX_SENTENCE_CHARS = 240;

/**
 * The first sentence of the text, or the first line, or the beginning of the
 * text if it has no sentence break. Code fences and markdown noise are removed
 * first, so a fenced block does not become one giant "word".
 */
export function firstSentence(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, " $1 ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[#>\-*\s]+/gm, "")
    // Collapse runs left by the removals, but keep newlines: they end the
    // "first sentence" when the text has no punctuation at all.
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  if (cleaned === "") return "";

  const match = /^[^.?!\n]*[.?!]?/.exec(cleaned);
  const sentence = (match?.[0] ?? cleaned).trim();
  return sentence.slice(0, MAX_SENTENCE_CHARS);
}

/**
 * Two or three meaningful keywords from the first sentence, space-separated.
 * Returns an empty string when the text has no usable words (only stopwords,
 * numbers or punctuation), so the UI can ask for a query instead of searching
 * for nothing.
 */
export function extractKeywords(text: string, limit = 3): string {
  const sentence = firstSentence(text).toLowerCase();
  if (sentence === "") return "";

  const words: string[] = [];
  for (const raw of sentence.split(/[^a-z0-9+#'-]+/)) {
    const word = raw.replace(/^['-]+|['-]+$/g, "");
    if (word.length < MIN_WORD_LENGTH) continue;
    if (!/[a-z]/.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    if (words.includes(word)) continue;
    words.push(word);
    if (words.length >= Math.max(1, limit)) break;
  }

  return words.join(" ");
}

/** True when a keyword string is long enough for /api/backgrounds/search. */
export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= 2;
}
