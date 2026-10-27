/**
 * Small formatting helpers. Repo-derived text never becomes a heading or an
 * unescaped inline token.
 */
export function fence(content: string, lang = ''): string {
  const runs = content.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const marker = '`'.repeat(longest + 1);
  return `${marker}${lang}\n${content.replace(/\n+$/, '')}\n${marker}`;
}

export function inline(value: string | undefined, fallback = 'not available'): string {
  if (!value) return fallback;
  return `\`${value.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}

export function cell(value: string | undefined | number | boolean): string {
  if (value === undefined || value === null) return '-';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function excerpt(text: string | undefined, lines = 10): string {
  if (!text) return 'No failure output recorded.';
  return text.split('\n').slice(0, lines).join('\n');
}

export function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 8) : 'unknown';
}

export function formatMs(ms?: number): string {
  if (ms === undefined) return 'n/a';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
