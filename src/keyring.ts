// The one place that imports the native keychain binding (`@napi-rs/keyring`), always on first use.
// The specifier must stay a literal: tsup keeps it external.

/**
 * Load the binding. A platform without a prebuilt binary, a missing optional dependency or an
 * unusable `.node` file all end up here; the callers only show the first line of the message, so it
 * says what is wrong without napi-rs' advice about reinstalling npm packages.
 */
export async function importKeyring<T>(load: () => Promise<unknown> = () => import('@napi-rs/keyring')): Promise<T> {
  try {
    return (await load()) as T;
  } catch (error) {
    const cause = error instanceof Error ? error.message.split('\n')[0] : undefined;
    const detail = cause && !/^Cannot find native binding\./.test(cause) ? ` (${cause})` : '';
    throw new Error(`the native keychain module is not available on ${process.platform}-${process.arch}${detail}`);
  }
}
