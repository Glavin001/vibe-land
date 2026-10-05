// Files the native app ships beside its bundle (scripts/native-mac.sh copies
// them into the bundle's directory). mystralnative resolves file:// against
// the running script.
//
// WebAssembly modules are instantiated synchronously there (initSync with
// these bytes): its V8 never resolves an async WebAssembly.instantiate.

export async function nativeFileBytes(name: string): Promise<ArrayBuffer> {
  const response = await fetch(`file://./${name}`);
  if (!response.ok) throw new Error(`native app file missing: ${name} (${response.status})`);
  return response.arrayBuffer();
}
