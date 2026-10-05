// Files the native app ships beside its bundle (scripts/native-mac.sh copies
// them in). mystralnative resolves file:// against the working directory:
// the bundle's directory in development, Contents/Resources in the .app.
//
// WebAssembly modules are instantiated synchronously there (initSync with
// these bytes): its V8 never resolves an async WebAssembly.instantiate.

export async function nativeFileBytes(name: string): Promise<ArrayBuffer> {
  const response = await fetch(`file://./${name}`);
  if (!response.ok) throw new Error(`native app file missing: ${name} (${response.status})`);
  return response.arrayBuffer();
}
