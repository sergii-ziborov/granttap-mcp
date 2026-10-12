type StartupRecovery<T> = {
  engineAvailable: () => Promise<boolean>;
  publishCatalog: () => Promise<unknown>;
  snapshots: () => Promise<T>;
  recover: (snapshots: T) => Promise<unknown>;
};

/** Coordinate the initial catalog and restoration of verified Engine bindings. */
export async function recoverCatalogBindings<T>(input: StartupRecovery<T>): Promise<void> {
  const [available] = await Promise.all([input.engineAvailable(), input.publishCatalog()]);
  if (available) await input.recover(await input.snapshots());
}
