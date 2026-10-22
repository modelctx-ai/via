// via's Client ID Metadata Document (auth.md, "客户端标识"): the https URL that serves as via's `client_id` at
// authorization servers that advertise `client_id_metadata_document_supported`. The document itself lives in
// `pages/client-metadata.json` and is published to GitHub Pages by `.github/workflows/pages.yml`; a test keeps
// that file and these constants in step.
import { CALLBACK_PORTS, callbackUrl } from './redirect';

/** The hosted document; also the `client_id`. Changing it changes the identity of every installed via. */
export const CLIENT_METADATA_URL = 'https://modelctx-ai.github.io/via/client-metadata.json';

/** The redirect URIs the document must list: one per port of the callback range, IP literal only. */
export function documentedRedirectUris(): string[] {
  return CALLBACK_PORTS.map(callbackUrl);
}
