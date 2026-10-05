// Every first-time shader build on the WebGPU path, recorded: three builds a
// node material (TSL -> WGSL, tens of milliseconds of JavaScript) and its GPU
// pipeline the first time an object with a new cache key is drawn, inside
// render(). One mid-play is a visible hitch, so the game builds what it can
// show behind its loading screen (scene/shaderWarmup.ts) and these records
// prove nothing is left over: anything built after `markPlaying()` is a
// "late" build, the thing to fix.
//
// Exposed to tests through the e2e bridge (shaderBuilds()).

type Renderer = {
  _nodes?: { getForRender: (renderObject: RenderObjectLike) => unknown; nodeBuilderCache?: Map<unknown, unknown> };
  _pipelines?: { getForRender: (renderObject: RenderObjectLike, promises?: unknown) => unknown; caches?: Map<unknown, unknown> };
};
type RenderObjectLike = {
  object?: { type?: string; name?: string; isInstancedMesh?: boolean; count?: number; geometry?: { type?: string }; parent?: { name?: string; type?: string } | null };
  material?: { type?: string; name?: string };
};

export interface ShaderBuild {
  kind: 'node' | 'pipeline';
  ms: number;
  late: boolean;
  object: string;
  material: string;
  atMs: number;
}

const builds: ShaderBuild[] = [];
let playing = false;

/** From now on any build is late (the loading screen is over). */
export function markShaderWarmupDone(): void {
  playing = true;
}

export function shaderBuilds(): { builds: ShaderBuild[]; late: ShaderBuild[]; playing: boolean } {
  return { builds, late: builds.filter((b) => b.late), playing };
}

const describe = (renderObject: RenderObjectLike) => ({
  object: `${renderObject.object?.type ?? '?'}${renderObject.object?.name ? ` "${renderObject.object.name}"` : ''}`
    + ` [${renderObject.object?.geometry?.type ?? '?'}${renderObject.object?.parent?.name ? ` in "${renderObject.object.parent.name}"` : ''}]`
    + `${renderObject.object?.isInstancedMesh || (renderObject.object?.count ?? 1) > 1 ? ' (instanced)' : ''}`,
  material: `${renderObject.material?.type ?? '?'}${renderObject.material?.name ? ` "${renderObject.material.name}"` : ''}`,
});

export function monitorShaderBuilds(renderer: Renderer): void {
  const nodes = renderer._nodes;
  const pipelines = renderer._pipelines;
  if (!nodes || !pipelines || (nodes as { __vibeMonitored?: true }).__vibeMonitored) return;
  (nodes as { __vibeMonitored?: true }).__vibeMonitored = true;
  const record = (kind: ShaderBuild['kind'], renderObject: RenderObjectLike, ms: number) => {
    builds.push({ kind, ms, late: playing, atMs: performance.now(), ...describe(renderObject) });
    if (playing && ms > 4) console.warn(`[shaders] late ${kind} build ${ms.toFixed(0)} ms: ${describe(renderObject).object} / ${describe(renderObject).material}`);
  };
  const getNodes = nodes.getForRender.bind(nodes);
  nodes.getForRender = (renderObject) => {
    const before = nodes.nodeBuilderCache?.size ?? 0;
    const started = performance.now();
    const result = getNodes(renderObject);
    if ((nodes.nodeBuilderCache?.size ?? 0) > before) record('node', renderObject, performance.now() - started);
    return result;
  };
  const getPipeline = pipelines.getForRender.bind(pipelines);
  pipelines.getForRender = (renderObject, promises) => {
    const before = pipelines.caches?.size ?? 0;
    const started = performance.now();
    const result = getPipeline(renderObject, promises);
    if ((pipelines.caches?.size ?? 0) > before) record('pipeline', renderObject, performance.now() - started);
    return result;
  };
}
