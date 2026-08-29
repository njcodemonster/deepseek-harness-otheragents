/**
 * Credential-document helpers shared by the one-command Devin login script
 * and its tests. Kept in `src/` so the host typecheck aggregate — which
 * compiles package tests but not package `scripts/` — can resolve them.
 *
 * @module dsh-llm-devin/desktop-login
 */

/** One imported Devin Desktop credential. */
export interface DesktopCredential {
  /** The long-lived Windsurf API key. */
  apiKey: string
  /** Account API server URL, when the Desktop config names one. */
  apiServerUrl?: string
  /** Human-readable account name, when the Desktop config names one. */
  name?: string
}

/**
 * Parse the Devin Desktop credentials.toml for the Windsurf API key.
 * @param toml - raw contents of a `credentials.toml` document.
 * @returns the key plus optional server/name facts, or undefined when the document carries no Windsurf key.
 */
export function parseDesktopCredentials(toml: string): DesktopCredential | undefined {
  const apiKeyMatch = toml.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m)
  if (apiKeyMatch?.[1] === undefined) return undefined
  const serverMatch = toml.match(/^\s*api_server_url\s*=\s*"([^"]+)"/m)
  const nameMatch = toml.match(/^\s*name\s*=\s*"([^"]+)"/m)
  return {
    apiKey: apiKeyMatch[1],
    ...serverMatch?.[1] !== undefined ? { apiServerUrl: serverMatch[1] } : {},
    ...nameMatch?.[1] !== undefined ? { name: nameMatch[1] } : {},
  }
}

/**
 * Insert or replace one `NAME: value` line inside the `refs:` block of a
 * credentials document, preserving sibling entries.
 * @param document - raw YAML text of a credentials document.
 * @param name - the credential key to upsert (e.g. `DEVIN_API_KEY`).
 * @param value - the credential value; single quotes are doubled for YAML quoting.
 * @returns the updated document text.
 */
export function upsertRef(document: string, name: string, value: string): string {
  const lines = document.split('\n')
  const quoted = `'${value.replace(/'/g, "''")}'`
  const refsIndex = lines.findIndex(line => /^refs:\s*$/.test(line))
  if (refsIndex === -1) {
    // No refs block: append one (after version line if present).
    const insertAt = lines.findIndex(line => /^version:/.test(line)) + 1
    lines.splice(insertAt, 0, 'refs:', `  ${name}: ${quoted}`)
    return lines.join('\n')
  }
  const pattern = new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
  const hit = lines.findIndex((line, i) => i > refsIndex && pattern.test(line))
  if (hit !== -1) {
    lines[hit] = `  ${name}: ${quoted}`
    return lines.join('\n')
  }
  // Insert alphabetically inside the refs block (before its end or the next top-level key).
  let insertAt = lines.length
  for (let i = refsIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && line.length > 0 && !/^\s/.test(line)) {
      insertAt = i
      break
    }
  }
  lines.splice(insertAt, 0, `  ${name}: ${quoted}`)
  return lines.join('\n')
}
