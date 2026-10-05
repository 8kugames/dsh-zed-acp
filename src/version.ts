/**
 * The published package version, advertised as the ACP agent info version.
 * @module @8kugames/dsh-zed-acp/version
 */

import { createRequire } from 'node:module'

// The package's own manifest is the single source of the version so the
// advertised agent info cannot drift from what is published (`./package.json`
// is an export of this package; the relative path resolves from both `src/`
// and the bundled `dist/`).

/**
 * The package manifest's `version` field, read once at module load.
 */
export const ACP_AGENT_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version
