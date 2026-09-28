// Pure ranking: no browser APIs, page reads, network calls, or persisted queries.
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const accessed = tab => Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0;
const recentFirst = (a, b) => accessed(b) - accessed(a) || a.id - b.id;

// One insertion, deletion, substitution, or adjacent transposition.
function oneTypo(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function matchField(text, term) {
  const index = text.indexOf(term);
  if (index !== -1) return { fuzzy: false, cost: index === 0 ? 0 : 1 };
  if (term.length < 3) return null;
  // Match abbreviations within words, rather than widely separated URL letters.
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (oneTypo(term, word)) return { fuzzy: true, cost: 2 };
    let pos = 0;
    for (const char of word) if (char === term[pos]) pos++;
    if (pos === term.length && word.length <= term.length * 2) return { fuzzy: true, cost: 3 };
  }
  return null;
}

/** Returns ranked {tab, matchType} entries; only empty queries apply recentLimit. */
export function rankTabs(tabs, query, { currentTabId, recentLimit = 10 } = {}) {
  const text = normalize(query).trim().replace(/\s+/g, ' ');
  if (!text) {
    return [...tabs].sort((a, b) =>
      Number(a.id === currentTabId) - Number(b.id === currentTabId) || recentFirst(a, b)
    ).slice(0, recentLimit).map(tab => ({ tab, matchType: 'recent' }));
  }
  const terms = text.split(' ');
  const results = [];
  for (const tab of tabs) {
    const title = normalize(tab.title);
    const url = normalize(tab.url);
    const fields = new Set();
    let fuzzy = false;
    let cost = 0;
    let matched = true;
    for (const term of terms) {
      const t = matchField(title, term);
      const u = matchField(url, term);
      const useTitle = t && (!u || Number(t.fuzzy) < Number(u.fuzzy) ||
        (t.fuzzy === u.fuzzy && t.cost <= u.cost));
      const match = useTitle ? t : u;
      if (!match) { matched = false; break; }
      fields.add(useTitle ? 'title' : 'url');
      fuzzy ||= match.fuzzy;
      cost += match.cost;
    }
    if (!matched) continue;
    const tier = title === text || url === text ? 0 :
      title.includes(text) || url.includes(text) ? 1 : fuzzy ? 3 : 2;
    results.push({ tab, matchType: fields.size === 2 ? 'title+url' : [...fields][0], tier, cost });
  }
  // No currentTabId reference here: typed searches treat every tab identically.
  return results.sort((a, b) => a.tier - b.tier || a.cost - b.cost || recentFirst(a.tab, b.tab));
}
