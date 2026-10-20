// Base environment for stdio children. The server's resolved `env` is merged on top of it.
//
// A child does not inherit the whole parent environment: other tokens that happen to be exported in
// the shell (GITHUB_TOKEN, cloud keys…) must not reach every server. Only variables needed to find
// binaries, behave in the right locale and reach the network through a proxy are passed along.

const NAMES_POSIX = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR'];

const NAMES_WINDOWS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

/** Proxy and TLS settings, matched case-insensitively. */
const NETWORK_NAMES = new Set([
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'node_extra_ca_certs',
  'ssl_cert_file',
  'ssl_cert_dir',
  'requests_ca_bundle',
]);

/** Prefixes passed through: locale (`LC_*`) and XDG base directories. */
const PREFIXES = ['LC_', 'XDG_'];

export function baseEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const win = platform === 'win32';
  const exact = new Set((win ? NAMES_WINDOWS : NAMES_POSIX).map((n) => (win ? n.toLowerCase() : n)));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed =
      exact.has(win ? name.toLowerCase() : name) || NETWORK_NAMES.has(name.toLowerCase()) || PREFIXES.some((p) => name.startsWith(p));
    if (!allowed) continue;
    if (value.startsWith('()')) continue; // exported shell functions
    env[name] = value;
  }
  return env;
}
