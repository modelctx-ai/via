#!/usr/bin/env node
// Render the Homebrew formula (packaging/homebrew/via.rb.in) for one release: the version and the
// SHA-256 of the npm tarball. No secrets and no dependencies, so the release workflow can run it
// with a bare Node.js, and so can a maintainer on a laptop.
//
//   node scripts/render-homebrew.mjs --version 0.3.1 --out via.rb
//
// The tarball is the one the registry serves for @modelctx-ai/via@<version> (the file Homebrew will
// download); its sha512 is checked against the registry's own `dist.integrity` before the SHA-256
// Homebrew wants is computed from it. Retries a few times because a just-published version can take
// a moment to appear.
//
//   --version <x.y.z>   the version to render (default: version in package.json)
//   --out <file>        write the formula there (default: print to stdout)
//   --template <file>   default packaging/homebrew/via.rb.in
//   --tarball <file>    use a local tarball instead of downloading (offline; no integrity check)
//   --sha256 <hex>      use this checksum, no tarball needed at all
//   --retries <n>       registry attempts, 10 s apart (default 12)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE = '@modelctx-ai/via';
export const REGISTRY = 'https://registry.npmjs.org';

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const tarballUrl = (version) => `${REGISTRY}/${PACKAGE}/-/via-${version}.tgz`;

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** `sha512-<base64>` as npm writes it in `dist.integrity`. */
export const sha512Integrity = (buffer) => `sha512-${createHash('sha512').update(buffer).digest('base64')}`;

/**
 * Fill the template. Placeholders are `@VERSION@` and `@SHA256@`; anything else left in `@…@`
 * form would end up in a formula Homebrew rejects, so it is an error here.
 */
export function renderFormula(template, { version, sha256 }) {
  if (!VERSION.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  if (!SHA256.test(sha256)) throw new Error(`not a lower-case hex SHA-256: ${JSON.stringify(sha256)}`);
  const text = template.replaceAll('@VERSION@', version).replaceAll('@SHA256@', sha256);
  const left = /@[A-Z0-9_]+@/.exec(text);
  if (left) throw new Error(`unfilled placeholder ${left[0]} in the template`);
  return text;
}

/** The registry's tarball for `version`, checked against `dist.integrity`. */
export async function fetchTarball(version, { fetchImpl = fetch, retries = 12, delayMs = 10_000, log = () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const meta = await fetchImpl(`${REGISTRY}/${PACKAGE.replace('/', '%2f')}/${version}`);
      if (!meta.ok) throw new Error(`registry returned ${meta.status} for ${PACKAGE}@${version}`);
      const { dist } = await meta.json();
      if (dist?.tarball !== tarballUrl(version)) {
        // The formula's url is built from the version; Homebrew must download the same file we hashed.
        throw new Error(`registry tarball ${dist?.tarball} differs from ${tarballUrl(version)}`);
      }
      const response = await fetchImpl(dist.tarball);
      if (!response.ok) throw new Error(`downloading the tarball returned ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (sha512Integrity(buffer) !== dist.integrity) throw new Error('the downloaded tarball does not match the registry integrity');
      return buffer;
    } catch (error) {
      lastError = error;
      log(`attempt ${attempt}/${retries}: ${error.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

function parseArgs(argv) {
  const options = { retries: 12 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--version') options.version = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--template') options.template = value();
    else if (arg === '--tarball') options.tarball = value();
    else if (arg === '--sha256') options.sha256 = value();
    else if (arg === '--retries') options.retries = Number(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(process.argv.slice(2));
  const version = options.version ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const template = readFileSync(resolve(options.template ?? resolve(root, 'packaging/homebrew/via.rb.in')), 'utf8');
  let sha256 = options.sha256;
  if (sha256 === undefined) {
    const tarball = options.tarball
      ? readFileSync(options.tarball)
      : await fetchTarball(version, { retries: options.retries, log: (line) => process.stderr.write(`${line}\n`) });
    sha256 = sha256Hex(tarball);
  }
  const formula = renderFormula(template, { version, sha256 });
  if (options.out) {
    mkdirSync(dirname(resolve(options.out)), { recursive: true });
    writeFileSync(options.out, formula);
    process.stderr.write(`wrote ${options.out} (via ${version}, sha256 ${sha256})\n`);
  } else {
    process.stdout.write(formula);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`render-homebrew: ${error.message}\n`);
    process.exitCode = 1;
  });
}
