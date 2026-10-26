/**
 * Enforces the context-pack character budget by trimming the least useful
 * material first: style example, caller bodies, then large bodies/diffs.
 */
import type { ContextPack } from './context';

export const MAX_CONTEXT_CHARS = 30_000;

export function fitToLimit(pack: ContextPack): ContextPack {
  pack.characterCount = JSON.stringify(pack).length;
  if (pack.characterCount <= MAX_CONTEXT_CHARS) return pack;

  pack.truncated = true;

  for (const caller of pack.directCallers) {
    if (caller.body.length > 2_000) {
      caller.body = `${caller.body.slice(0, 2_000)}\n// ... truncated`;
    }
  }
  if (pack.styleExample && pack.styleExample.content.split('\n').length > 80) {
    pack.styleExample.content = `${pack.styleExample.content
      .split('\n')
      .slice(0, 80)
      .join('\n')}\n// ... truncated`;
  }

  if (JSON.stringify(pack).length > MAX_CONTEXT_CHARS) {
    for (const caller of pack.directCallers) caller.body = '';
    if (pack.styleExample) {
      pack.styleExample.content = `${pack.styleExample.content
        .split('\n')
        .slice(0, 30)
        .join('\n')}\n// ... truncated`;
    }
    if (pack.function.baseBody) pack.function.baseBody = pack.function.baseBody.slice(0, 4_000);
    pack.function.headBody = pack.function.headBody.slice(0, 4_000);
    pack.function.diff = pack.function.diff.slice(0, 6_000);
  }

  if (JSON.stringify(pack).length > MAX_CONTEXT_CHARS) {
    pack.styleExample = null;
    for (const config of [pack.jestConfig, pack.tsconfig]) {
      if (config) config.content = config.content.slice(0, 2_500);
    }
    pack.exports = pack.exports.map((symbol) => ({
      ...symbol,
      signature: symbol.signature.slice(0, 240)
    }));
    pack.helpers = pack.helpers.map((symbol) => ({
      ...symbol,
      signature: symbol.signature.slice(0, 240)
    }));
  }

  pack.characterCount = JSON.stringify(pack).length;
  if (pack.characterCount > MAX_CONTEXT_CHARS) {
    throw new Error(
      `Context pack is ${pack.characterCount} characters, above the ${MAX_CONTEXT_CHARS} cap`
    );
  }

  return pack;
}