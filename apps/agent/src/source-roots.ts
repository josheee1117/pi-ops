import { isAbsolute } from 'node:path';

/** Read-only source root per service. Keys are the Incident's service string. */
export type SourceRoots = Readonly<Record<string, string>>;

/** Load PI_OPS_SOURCE_ROOTS, a JSON object mapping service name to an absolute directory. */
export function loadSourceRoots(env: NodeJS.ProcessEnv = process.env): SourceRoots {
  const raw = env['PI_OPS_SOURCE_ROOTS'];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PI_OPS_SOURCE_ROOTS must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PI_OPS_SOURCE_ROOTS must be a JSON object keyed by service name');
  }
  const roots: Record<string, string> = {};
  for (const [service, value] of Object.entries(parsed)) {
    if (!service.trim() || typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
      throw new Error(`PI_OPS_SOURCE_ROOTS entry for ${service || '<empty>'} must be an absolute path`);
    }
    roots[service] = value;
  }
  return roots;
}
