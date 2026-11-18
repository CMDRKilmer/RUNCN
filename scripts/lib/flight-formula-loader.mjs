// Resolves source aliases for the actual formula modules; no model stubs.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const url = specifier.startsWith('@src/')
    ? new URL('../../src/' + specifier.slice(5), import.meta.url)
    : specifier.startsWith('.') && context.parentURL
      ? new URL(specifier, context.parentURL)
      : undefined;
  if (url && existsSync(fileURLToPath(url) + '.ts')) {
    return { url: url.href + '.ts', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
