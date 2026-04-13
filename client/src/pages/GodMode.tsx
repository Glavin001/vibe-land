import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { OrbitControls, Sky, TransformControls } from '@react-three/drei';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { App } from '../App';
import { WorldTerrain } from '../scene/WorldTerrain';
import {
  DEFAULT_WORLD_DOCUMENT,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_MIN_HEIGHT,
  addTerrainTile,
  applyTerrainBrush,
  cloneWorldDocument,
  getAddableTerrainTiles,
  getTerrainTileCenter,
  getTerrainTileKey,
  getNextWorldEntityId,
  getMinimumDynamicEntityY,
  identityQuaternion,
  parseWorldDocument,
  quaternionFromYaw,
  removeTerrainTile,
  sampleTerrainHeightAtWorldPosition,
  serializeWorldDocument,
  terrainTileSideLength,
  yawFromQuaternion,
  type TerrainTileCoordinate,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type Vec3,
  type WorldDocument,
  type WorldDraftRevision,
} from '../world/worldDocument';
import {
  clearDraftStorage,
  getInitialGodModeWorld,
  getLastImportName,
  loadCurrentDraft,
  loadRevisionHistory,
  markAutosaveBackup,
  pushRevisionHistory,
  saveCurrentDraft,
  setLastImportName,
  shouldCreateAutosaveBackup,
} from '../world/worldDraftStore';

type EditorMode = 'edit' | 'play';
type EditorTool = 'select' | 'terrain';
type TerrainToolMode = 'sculpt' | 'add-tile' | 'delete-tile';
type TransformMode = 'translate' | 'rotate' | 'scale';
type SelectedTarget =
  | { kind: 'static'; id: number }
  | { kind: 'dynamic'; id: number }
  | null;

type SelectedTransformEntity = {
  kind: 'static' | 'dynamic';
  id: number;
  position: Vec3;
  rotation: Quaternion;
  halfExtents?: Vec3;
  radius?: number;
  canRotate: boolean;
  canResize: boolean;
};

export function GodModePage() {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [tool, setTool] = useState<EditorTool>('select');
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [world, setWorld] = useState<WorldDocument>(() => getInitialGodModeWorld());
  const [history, setHistory] = useState<WorldDraftRevision[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [selected, setSelected] = useState<SelectedTarget>(null);
  const [brushRadius, setBrushRadius] = useState(8);
  const [brushStrength, setBrushStrength] = useState(0.12);
  const [brushMode, setBrushMode] = useState<'raise' | 'lower'>('raise');
  const [terrainToolMode, setTerrainToolMode] = useState<TerrainToolMode>('sculpt');
  const [brushMinHeight, setBrushMinHeight] = useState(TERRAIN_MIN_HEIGHT);
  const [brushMaxHeight, setBrushMaxHeight] = useState(TERRAIN_MAX_HEIGHT);
  const [playWorldSnapshot, setPlayWorldSnapshot] = useState<WorldDocument | null>(null);
  const [playSessionKey, setPlaySessionKey] = useState(0);
  const [lastImportName, setLastImportNameState] = useState(() => getLastImportName());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autosaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [draft, revisionHistory] = await Promise.all([
        loadCurrentDraft(),
        loadRevisionHistory(),
      ]);
      if (cancelled) {
        return;
      }
      if (draft) {
        setWorld(cloneWorldDocument(draft));
      }
      setHistory(revisionHistory);
      setStorageReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) {
      return;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft(world);
      const nowMs = Date.now();
      if (shouldCreateAutosaveBackup(nowMs)) {
        void pushRevisionHistory(world, 'Autosave backup').then((nextHistory) => {
          setHistory(nextHistory);
        });
        markAutosaveBackup(nowMs);
      }
      autosaveTimerRef.current = null;
    }, 600);

    return () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [storageReady, world]);

  const selectedStatic = selected?.kind === 'static'
    ? world.staticProps.find((entity) => entity.id === selected.id) ?? null
    : null;
  const selectedDynamic = selected?.kind === 'dynamic'
    ? world.dynamicEntities.find((entity) => entity.id === selected.id) ?? null
    : null;
  const selectedTransformEntity = useMemo<SelectedTransformEntity | null>(() => {
    if (selectedStatic) {
      return {
        kind: 'static',
        id: selectedStatic.id,
        position: selectedStatic.position,
        rotation: selectedStatic.rotation,
        halfExtents: selectedStatic.halfExtents,
        canRotate: true,
        canResize: true,
      };
    }
    if (selectedDynamic) {
      return {
        kind: 'dynamic',
        id: selectedDynamic.id,
        position: selectedDynamic.position,
        rotation: selectedDynamic.rotation,
        halfExtents: selectedDynamic.halfExtents,
        radius: selectedDynamic.radius,
        canRotate: selectedDynamic.kind !== 'ball',
        canResize: selectedDynamic.kind !== 'vehicle',
      };
    }
    return null;
  }, [selectedDynamic, selectedStatic]);

  useEffect(() => {
    if (tool !== 'select') {
      return;
    }
    if (transformMode === 'rotate' && !selectedTransformEntity?.canRotate) {
      setTransformMode('translate');
      return;
    }
    if (transformMode === 'scale' && !selectedTransformEntity?.canResize) {
      setTransformMode('translate');
    }
  }, [selectedTransformEntity, tool, transformMode]);

  useEffect(() => {
    if (mode !== 'edit') {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (tool !== 'select') {
        return;
      }
      if (event.target instanceof HTMLElement && (
        event.target.tagName === 'INPUT'
        || event.target.tagName === 'TEXTAREA'
        || event.target.isContentEditable
      )) {
        return;
      }
      if (event.key.toLowerCase() === 'w') {
        setTransformMode('translate');
      }
      if (event.key.toLowerCase() === 'e' && selectedTransformEntity?.canRotate) {
        setTransformMode('rotate');
      }
      if (event.key.toLowerCase() === 'r' && selectedTransformEntity?.canResize) {
        setTransformMode('scale');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, selectedTransformEntity, tool]);

  const handleStartPlay = useCallback(() => {
    const snapshot = cloneWorldDocument(world);
    setPlayWorldSnapshot(snapshot);
    setPlaySessionKey((current) => current + 1);
    setMode('play');
  }, [world]);

  const handleReturnToEdit = useCallback(() => {
    setMode('edit');
    setPlayWorldSnapshot(null);
  }, []);

  const handleResetPlayWorld = useCallback(() => {
    if (mode !== 'play') {
      return;
    }
    setPlayWorldSnapshot(cloneWorldDocument(world));
    setPlaySessionKey((current) => current + 1);
  }, [mode, world]);

  const handleExport = useCallback(() => {
    const blob = new Blob([serializeWorldDocument(world)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `${slugify(world.meta.name || 'world')}.world.json`;
    anchor.click();
    URL.revokeObjectURL(href);
  }, [world]);

  const handleImportButton = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    const nextWorld = parseWorldDocument(JSON.parse(text));
    setWorld(cloneWorldDocument(nextWorld));
    setSelected(null);
    setLastImportName(file.name);
    setLastImportNameState(file.name);
    setHistory(await pushRevisionHistory(nextWorld, `Imported ${file.name}`));
    event.target.value = '';
  }, []);

  const handleRestoreRevision = useCallback((revision: WorldDraftRevision) => {
    setWorld(cloneWorldDocument(revision.world));
    setSelected(null);
  }, []);

  const handleResetToDefault = useCallback(() => {
    void clearDraftStorage();
    setWorld(cloneWorldDocument(DEFAULT_WORLD_DOCUMENT));
    setHistory([]);
    setSelected(null);
    setLastImportName('');
    setLastImportNameState('');
  }, []);

  const addStaticCuboid = useCallback(() => {
    const nextId = getNextWorldEntityId(world);
    const baseY = sampleTerrainHeightAtWorldPosition(world, 0, 0) + 1;
    const nextStatic: StaticProp = {
      id: nextId,
      kind: 'cuboid',
      position: [0, baseY, 0],
      rotation: identityQuaternion(),
      halfExtents: [2, 1, 2],
      material: 'editor-static',
    };
    setWorld((current) => ({
      ...current,
      staticProps: [...current.staticProps, nextStatic],
    }));
    setSelected({ kind: 'static', id: nextId });
  }, [world]);

  const addDynamicEntity = useCallback((kind: DynamicEntity['kind']) => {
    const nextId = getNextWorldEntityId(world);
    const common = {
      id: nextId,
      kind,
      position: [0, 0, 0] as [number, number, number],
      rotation: identityQuaternion() as Quaternion,
    };
    const entity: DynamicEntity = kind === 'box'
      ? { ...common, halfExtents: [0.7, 0.7, 0.7] }
      : kind === 'ball'
        ? { ...common, radius: 0.6 }
        : { ...common, vehicleType: 0 };
    entity.position = [0, getMinimumDynamicEntityY(world, entity), 0];
    setWorld((current) => ({
      ...current,
      dynamicEntities: [...current.dynamicEntities, entity],
    }));
    setSelected({ kind: 'dynamic', id: nextId });
  }, [world]);

  const removeSelected = useCallback(() => {
    if (!selected) return;
    setWorld((current) => {
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.filter((entity) => entity.id !== selected.id),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.filter((entity) => entity.id !== selected.id),
      };
    });
    setSelected(null);
  }, [selected]);

  const updateSelectedPosition = useCallback((axis: 0 | 1 | 2, value: number) => {
    setWorld((current) => {
      if (!selected) return current;
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, position: withAxis(entity.position, axis, value) }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id
            ? { ...entity, position: withAxis(entity.position, axis, value) }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedPositionVector = useCallback((nextPosition: Vec3) => {
    setWorld((current) => {
      if (!selected) {
        return current;
      }
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, position: nextPosition }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id
            ? { ...entity, position: nextPosition }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedHalfExtent = useCallback((axis: 0 | 1 | 2, value: number) => {
    const nextValue = clampDimension(value * 2) / 2;
    setWorld((current) => {
      if (!selected) return current;
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, halfExtents: withAxis(entity.halfExtents, axis, nextValue) }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id && entity.halfExtents
            ? { ...entity, halfExtents: withAxis(entity.halfExtents, axis, nextValue) }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedHalfExtentsVector = useCallback((nextHalfExtents: Vec3) => {
    const clampedHalfExtents = nextHalfExtents.map((value) => clampDimension(value * 2) / 2) as Vec3;
    setWorld((current) => {
      if (!selected) {
        return current;
      }
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, halfExtents: clampedHalfExtents }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id && entity.halfExtents
            ? { ...entity, halfExtents: clampedHalfExtents }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedRadius = useCallback((value: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    const nextRadius = clampDimension(value);
    setWorld((current) => ({
      ...current,
      dynamicEntities: current.dynamicEntities.map((entity) => (
        entity.id === selected.id
          ? { ...entity, radius: nextRadius }
          : entity
      )),
    }));
  }, [selected]);

  const updateSelectedYaw = useCallback((yawDegrees: number) => {
    const yawRadians = (yawDegrees * Math.PI) / 180;
    const nextRotation = quaternionFromYaw(yawRadians);
    setWorld((current) => {
      if (!selected) {
        return current;
      }
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, rotation: nextRotation }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id
            ? { ...entity, rotation: nextRotation }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedRotationQuaternion = useCallback((nextRotation: Quaternion) => {
    setWorld((current) => {
      if (!selected) {
        return current;
      }
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, rotation: nextRotation }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id
            ? { ...entity, rotation: nextRotation }
            : entity
        )),
      };
    });
  }, [selected]);

  const editScene = useMemo(() => (
    <GodModeEditorScene
      world={world}
      tool={tool}
      terrainToolMode={terrainToolMode}
      selected={selected}
      transformMode={transformMode}
      selectedTransformEntity={selectedTransformEntity}
      brushRadius={brushRadius}
      brushStrength={brushStrength}
      brushMode={brushMode}
      onSelect={setSelected}
      onTransformPositionChange={updateSelectedPositionVector}
      onTransformRotationChange={updateSelectedRotationQuaternion}
      onTransformHalfExtentsChange={updateSelectedHalfExtentsVector}
      onTransformRadiusChange={updateSelectedRadius}
      onPaint={(x, z) => {
        setWorld((current) => applyTerrainBrush(current, x, z, brushRadius, brushStrength, brushMode, {
          minHeight: brushMinHeight,
          maxHeight: brushMaxHeight,
        }));
      }}
      onDeleteTile={(tileX, tileZ) => {
        setWorld((current) => removeTerrainTile(current, tileX, tileZ));
      }}
      onAddTile={(tileX, tileZ) => {
        setWorld((current) => addTerrainTile(current, tileX, tileZ));
      }}
    />
  ), [
    brushMaxHeight,
    brushMode,
    brushMinHeight,
    brushRadius,
    brushStrength,
    terrainToolMode,
    selected,
    selectedTransformEntity,
    tool,
    transformMode,
    updateSelectedHalfExtentsVector,
    updateSelectedPositionVector,
    updateSelectedRadius,
    updateSelectedRotationQuaternion,
    world,
  ]);

  if (mode === 'play' && playWorldSnapshot) {
    return (
      <App
        mode="practice"
        worldDocument={playWorldSnapshot}
        routeLabel="/godmode"
        autoConnect
        sessionKey={playSessionKey}
        overlay={(
          <div style={godModePlayOverlayStyle}>
            <span>Godmode Play uses the same local-practice runtime with the current authored world.</span>
            <button type="button" onClick={handleResetPlayWorld} style={secondaryButtonStyle}>Reset World</button>
            <button type="button" onClick={handleReturnToEdit} style={secondaryButtonStyle}>Back To Edit</button>
          </div>
        )}
      />
    );
  }

  return (
    <div style={pageStyle}>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => void handleImportFile(event)}
      />
      <aside style={sidebarStyle}>
        <div>
          <div style={eyebrowStyle}>vibe-land</div>
          <h1 style={titleStyle}>God Mode</h1>
          <p style={bodyStyle}>
            Edit the authored world document locally, autosave drafts in your browser, and launch a fresh single-player simulation from the current authored state.
          </p>
        </div>

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Mode</div>
          <div style={buttonRowStyle}>
            <button type="button" onClick={() => setMode('edit')} style={mode === 'edit' ? activeButtonStyle : secondaryButtonStyle}>Edit</button>
            <button type="button" onClick={handleStartPlay} style={mode === 'play' ? activeButtonStyle : secondaryButtonStyle}>Play</button>
          </div>
          <div style={mutedTextStyle}>
            Leaving Play always returns to the authored document. Runtime drift is discarded.
          </div>
        </div>

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Draft</div>
          <div style={buttonRowStyle}>
            <button type="button" onClick={handleExport} style={primaryButtonStyle}>Export JSON</button>
            <button type="button" onClick={handleImportButton} style={secondaryButtonStyle}>Import JSON</button>
            <button type="button" onClick={handleResetToDefault} style={secondaryButtonStyle}>Reset To Default</button>
          </div>
          <div style={mutedTextStyle}>
            Autosaves are stored in IndexedDB for larger worlds. {lastImportName ? `Last import: ${lastImportName}` : 'No imported file yet.'}
          </div>
        </div>

        {mode === 'edit' && (
          <>
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Tools</div>
              <div style={buttonRowStyle}>
                <button type="button" onClick={() => setTool('select')} style={tool === 'select' ? activeButtonStyle : secondaryButtonStyle}>Select</button>
                <button type="button" onClick={() => setTool('terrain')} style={tool === 'terrain' ? activeButtonStyle : secondaryButtonStyle}>Terrain</button>
              </div>
              {tool === 'terrain' && (
                <div style={fieldStackStyle}>
                  <div style={buttonRowStyle}>
                    <button type="button" onClick={() => setTerrainToolMode('sculpt')} style={terrainToolMode === 'sculpt' ? activeButtonStyle : secondaryButtonStyle}>Sculpt</button>
                    <button type="button" onClick={() => setTerrainToolMode('add-tile')} style={terrainToolMode === 'add-tile' ? activeButtonStyle : secondaryButtonStyle}>Add Tile</button>
                    <button type="button" onClick={() => setTerrainToolMode('delete-tile')} style={terrainToolMode === 'delete-tile' ? activeButtonStyle : secondaryButtonStyle}>Delete Tile</button>
                  </div>
                  {terrainToolMode === 'sculpt' ? (
                    <>
                      <label style={fieldLabelStyle}>
                        Radius
                        <input type="range" min="2" max="20" step="0.5" value={brushRadius} onChange={(event) => setBrushRadius(Number(event.target.value))} />
                        <span>{brushRadius.toFixed(1)}m</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Strength
                        <input type="range" min="0.02" max="0.35" step="0.01" value={brushStrength} onChange={(event) => setBrushStrength(Number(event.target.value))} />
                        <span>{brushStrength.toFixed(2)}</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Lower Plateau
                        <input
                          type="number"
                          min={TERRAIN_MIN_HEIGHT}
                          max={brushMaxHeight}
                          step="0.5"
                          value={brushMinHeight}
                          onChange={(event) => setBrushMinHeight(clampBrushHeight(Number(event.target.value), TERRAIN_MIN_HEIGHT, brushMaxHeight))}
                        />
                        <span>Terrain under this height stops lowering.</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Upper Plateau
                        <input
                          type="number"
                          min={brushMinHeight}
                          max={TERRAIN_MAX_HEIGHT}
                          step="0.5"
                          value={brushMaxHeight}
                          onChange={(event) => setBrushMaxHeight(clampBrushHeight(Number(event.target.value), brushMinHeight, TERRAIN_MAX_HEIGHT))}
                        />
                        <span>Terrain above this height stops raising.</span>
                      </label>
                      <div style={buttonRowStyle}>
                        <button type="button" onClick={() => setBrushMode('raise')} style={brushMode === 'raise' ? activeButtonStyle : secondaryButtonStyle}>Raise</button>
                        <button type="button" onClick={() => setBrushMode('lower')} style={brushMode === 'lower' ? activeButtonStyle : secondaryButtonStyle}>Lower</button>
                      </div>
                      <div style={mutedTextStyle}>
                        {brushMode === 'lower'
                          ? `Lowering plateaus at ${brushMinHeight.toFixed(1)}m.`
                          : `Raising plateaus at ${brushMaxHeight.toFixed(1)}m.`}
                      </div>
                    </>
                  ) : terrainToolMode === 'add-tile' ? (
                    <div style={mutedTextStyle}>
                      Exposed edges in the viewport show ghost tiles with floating add buttons. Click any ghost tile to extend the world in connected, sparse shapes.
                    </div>
                  ) : (
                    <div style={mutedTextStyle}>
                      Hover a terrain tile in the viewport and click the floating delete button to remove that exact tile. The last remaining tile is protected.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Add Objects</div>
              <div style={buttonGridStyle}>
                <button type="button" onClick={addStaticCuboid} style={secondaryButtonStyle}>Static Cuboid</button>
                <button type="button" onClick={() => addDynamicEntity('box')} style={secondaryButtonStyle}>Dynamic Box</button>
                <button type="button" onClick={() => addDynamicEntity('ball')} style={secondaryButtonStyle}>Ball</button>
                <button type="button" onClick={() => addDynamicEntity('vehicle')} style={secondaryButtonStyle}>Vehicle</button>
              </div>
            </div>

            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Terrain Grid</div>
              <div style={mutedTextStyle}>
                {world.terrain.tiles.length} tiles · {world.terrain.tileGridSize} x {world.terrain.tileGridSize} samples per tile
              </div>
              <div style={mutedTextStyle}>
                Terrain now grows from exposed edges directly in the 3D viewport, so you can build sparse connected layouts like corridors, U-shapes, or C-shapes without filling a full rectangle.
              </div>
            </div>

            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Selection</div>
              {!selected && <div style={mutedTextStyle}>Select an authored object to move, rotate, and resize it directly in the viewport.</div>}
              {selectedTransformEntity && (
                <>
                  <div style={buttonRowStyle}>
                    <button type="button" onClick={() => setTransformMode('translate')} style={transformMode === 'translate' ? activeButtonStyle : secondaryButtonStyle}>Move (W)</button>
                    <button
                      type="button"
                      onClick={() => setTransformMode('rotate')}
                      style={transformMode === 'rotate' ? activeButtonStyle : secondaryButtonStyle}
                      disabled={!selectedTransformEntity.canRotate}
                    >
                      Rotate (E)
                    </button>
                    <button
                      type="button"
                      onClick={() => setTransformMode('scale')}
                      style={transformMode === 'scale' ? activeButtonStyle : secondaryButtonStyle}
                      disabled={!selectedTransformEntity.canResize}
                    >
                      Resize (R)
                    </button>
                  </div>
                  <div style={mutedTextStyle}>
                    Drag the gizmo in the scene. Resize writes real shape dimensions into the world document instead of storing mesh scale.
                  </div>
                </>
              )}
              {selectedStatic && (
                <EditorFields
                  title={`Static ${selectedStatic.id}`}
                  position={selectedStatic.position}
                  onPositionChange={updateSelectedPosition}
                  yawDegrees={(yawFromQuaternion(selectedStatic.rotation) * 180) / Math.PI}
                  onYawChange={updateSelectedYaw}
                  dimensions={selectedStatic.halfExtents}
                  onDimensionsChange={updateSelectedHalfExtent}
                  onDelete={removeSelected}
                />
              )}
              {selectedDynamic && (
                <EditorFields
                  title={`${selectedDynamic.kind} ${selectedDynamic.id}`}
                  position={selectedDynamic.position}
                  onPositionChange={updateSelectedPosition}
                  dimensions={selectedDynamic.halfExtents}
                  onDimensionsChange={updateSelectedHalfExtent}
                  radius={selectedDynamic.radius}
                  onRadiusChange={updateSelectedRadius}
                  yawDegrees={(yawFromQuaternion(selectedDynamic.rotation) * 180) / Math.PI}
                  onYawChange={updateSelectedYaw}
                  onDelete={removeSelected}
                />
              )}
            </div>
          </>
        )}

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Recent Backups</div>
          <div style={historyListStyle}>
            {history.slice(0, 6).map((revision) => (
              <button
                key={revision.id}
                type="button"
                onClick={() => handleRestoreRevision(revision)}
                style={historyButtonStyle}
              >
                <span>{revision.summary}</span>
                <span style={mutedTextStyle}>{new Date(revision.savedAt).toLocaleString()}</span>
              </button>
            ))}
            {history.length === 0 && <div style={mutedTextStyle}>No backups yet.</div>}
          </div>
        </div>
      </aside>

      <main style={viewportStyle}>
        {mode === 'edit' && tool === 'select' && (
          <div style={editorViewportOverlayStyle}>
            <span>{selectedTransformEntity ? `Selected ${selectedTransformEntity.kind} ${selectedTransformEntity.id}` : 'Select an object'}</span>
            <span>W move</span>
            <span>E rotate</span>
            <span>R resize</span>
          </div>
        )}
        {editScene}
      </main>
    </div>
  );
}

function GodModeEditorScene({
  world,
  tool,
  terrainToolMode,
  selected,
  transformMode,
  selectedTransformEntity,
  brushRadius,
  brushStrength,
  brushMode,
  onSelect,
  onTransformPositionChange,
  onTransformRotationChange,
  onTransformHalfExtentsChange,
  onTransformRadiusChange,
  onPaint,
  onAddTile,
  onDeleteTile,
}: {
  world: WorldDocument;
  tool: EditorTool;
  terrainToolMode: TerrainToolMode;
  selected: SelectedTarget;
  transformMode: TransformMode;
  selectedTransformEntity: SelectedTransformEntity | null;
  brushRadius: number;
  brushStrength: number;
  brushMode: 'raise' | 'lower';
  onSelect: (next: SelectedTarget) => void;
  onTransformPositionChange: (nextPosition: Vec3) => void;
  onTransformRotationChange: (nextRotation: Quaternion) => void;
  onTransformHalfExtentsChange: (nextHalfExtents: Vec3) => void;
  onTransformRadiusChange: (nextRadius: number) => void;
  onPaint: (x: number, z: number) => void;
  onAddTile: (tileX: number, tileZ: number) => void;
  onDeleteTile: (tileX: number, tileZ: number) => void;
}) {
  const paintingRef = useRef(false);
  const brushCursorRef = useRef<THREE.Mesh>(null);
  const objectRefs = useRef(new Map<string, THREE.Object3D>());
  const resizeOriginRef = useRef<{ halfExtents?: Vec3; radius?: number } | null>(null);
  const [hoveredTerrainTile, setHoveredTerrainTile] = useState<TerrainTileCoordinate | null>(null);
  const addableTerrainTiles = useMemo(() => getAddableTerrainTiles(world), [world]);

  const selectedObjectKey = selected ? `${selected.kind}:${selected.id}` : null;
  const selectedObject = selectedObjectKey ? objectRefs.current.get(selectedObjectKey) ?? null : null;
  const canShowTransform =
    tool === 'select'
    && selectedObject != null
    && selectedTransformEntity != null
    && (transformMode !== 'rotate' || selectedTransformEntity.canRotate)
    && (transformMode !== 'scale' || selectedTransformEntity.canResize);

  const handleTerrainPointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (brushCursorRef.current) {
      brushCursorRef.current.position.set(event.point.x, event.point.y + 0.06, event.point.z);
    }
    const tileX = event.object.userData?.terrainTileX;
    const tileZ = event.object.userData?.terrainTileZ;
    if (typeof tileX === 'number' && typeof tileZ === 'number') {
      setHoveredTerrainTile({ tileX, tileZ });
    }
    if (tool === 'terrain' && terrainToolMode === 'sculpt' && paintingRef.current) {
      onPaint(event.point.x, event.point.z);
    }
  }, [onPaint, terrainToolMode, tool]);

  const handleTerrainPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const tileX = event.object.userData?.terrainTileX;
    const tileZ = event.object.userData?.terrainTileZ;
    if (tool === 'terrain' && terrainToolMode === 'sculpt') {
      paintingRef.current = true;
      onPaint(event.point.x, event.point.z);
      return;
    }
    if (tool === 'terrain' && terrainToolMode === 'delete-tile' && typeof tileX === 'number' && typeof tileZ === 'number') {
      setHoveredTerrainTile({ tileX, tileZ });
      onDeleteTile(tileX, tileZ);
      setHoveredTerrainTile(null);
      return;
    }
    onSelect(null);
  }, [onDeleteTile, onPaint, onSelect, terrainToolMode, tool]);

  const handleTerrainPointerUp = useCallback(() => {
    paintingRef.current = false;
  }, []);

  const handleTerrainPointerOut = useCallback(() => {
    if (terrainToolMode === 'delete-tile') {
      return;
    }
    setHoveredTerrainTile(null);
  }, [terrainToolMode]);

  const registerSelectableObject = useCallback((key: string, object: THREE.Object3D | null) => {
    if (object) {
      objectRefs.current.set(key, object);
      return;
    }
    objectRefs.current.delete(key);
  }, []);

  const handleTransformMouseDown = useCallback(() => {
    if (transformMode !== 'scale' || !selectedTransformEntity) {
      resizeOriginRef.current = null;
      return;
    }
    resizeOriginRef.current = {
      halfExtents: selectedTransformEntity.halfExtents ? [...selectedTransformEntity.halfExtents] as Vec3 : undefined,
      radius: selectedTransformEntity.radius,
    };
  }, [selectedTransformEntity, transformMode]);

  const handleTransformObjectChange = useCallback(() => {
    if (!selectedObject || !selectedTransformEntity) {
      return;
    }
    if (transformMode === 'translate') {
      onTransformPositionChange([
        selectedObject.position.x,
        selectedObject.position.y,
        selectedObject.position.z,
      ]);
      return;
    }
    if (transformMode === 'rotate' && selectedTransformEntity.canRotate) {
      const yaw = new THREE.Euler().setFromQuaternion(selectedObject.quaternion, 'YXZ').y;
      const nextRotation = quaternionFromYaw(yaw);
      selectedObject.quaternion.set(nextRotation[0], nextRotation[1], nextRotation[2], nextRotation[3]);
      onTransformRotationChange(nextRotation);
    }
  }, [onTransformPositionChange, onTransformRotationChange, selectedObject, selectedTransformEntity, transformMode]);

  const handleTransformMouseUp = useCallback(() => {
    if (!selectedObject || !selectedTransformEntity || transformMode !== 'scale') {
      resizeOriginRef.current = null;
      return;
    }
    if (selectedTransformEntity.halfExtents) {
      const baseHalfExtents = resizeOriginRef.current?.halfExtents ?? selectedTransformEntity.halfExtents;
      onTransformHalfExtentsChange([
        clampDimension(baseHalfExtents[0] * Math.abs(selectedObject.scale.x) * 2) / 2,
        clampDimension(baseHalfExtents[1] * Math.abs(selectedObject.scale.y) * 2) / 2,
        clampDimension(baseHalfExtents[2] * Math.abs(selectedObject.scale.z) * 2) / 2,
      ]);
    } else if (selectedTransformEntity.radius != null) {
      const baseRadius = resizeOriginRef.current?.radius ?? selectedTransformEntity.radius;
      const scale = Math.max(
        Math.abs(selectedObject.scale.x),
        Math.abs(selectedObject.scale.y),
        Math.abs(selectedObject.scale.z),
      );
      onTransformRadiusChange(clampDimension(baseRadius * scale));
    }
    selectedObject.scale.set(1, 1, 1);
    resizeOriginRef.current = null;
  }, [
    onTransformHalfExtentsChange,
    onTransformRadiusChange,
    selectedObject,
    selectedTransformEntity,
    transformMode,
  ]);

  useEffect(() => () => {
    paintingRef.current = false;
  }, []);

  const hoveredTerrainTileCenter = useMemo(() => {
    if (!hoveredTerrainTile) {
      return null;
    }
    const tile = getTerrainTileCenter(world, hoveredTerrainTile.tileX, hoveredTerrainTile.tileZ);
    return {
      key: getTerrainTileKey(hoveredTerrainTile.tileX, hoveredTerrainTile.tileZ),
      tileX: hoveredTerrainTile.tileX,
      tileZ: hoveredTerrainTile.tileZ,
      centerX: tile[0],
      centerZ: tile[1],
    };
  }, [hoveredTerrainTile, world]);

  const terrainTileSize = terrainTileSideLength(world);

  return (
    <Canvas
      shadows
      camera={{ fov: 55, near: 0.1, far: 600, position: [28, 28, 28] }}
      style={{ width: '100%', height: '100%' }}
      onPointerUp={handleTerrainPointerUp}
      onPointerMissed={() => setHoveredTerrainTile(null)}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[32, 48, 12]} intensity={1.4} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
      <Sky sunPosition={[24, 12, 8]} />
      <WorldTerrain
        world={world}
        onPointerDown={handleTerrainPointerDown}
        onPointerMove={handleTerrainPointerMove}
        onPointerUp={handleTerrainPointerUp}
        onPointerOut={handleTerrainPointerOut}
      />
      {tool === 'terrain' && terrainToolMode === 'add-tile' && addableTerrainTiles.map((tile) => {
        const [centerX, centerZ] = getTerrainTileCenter(world, tile.tileX, tile.tileZ);
        return (
          <group key={getTerrainTileKey(tile.tileX, tile.tileZ)}>
            <mesh
              position={[centerX, 0.03, centerZ]}
              rotation-x={-Math.PI / 2}
              onPointerDown={(event) => {
                event.stopPropagation();
                onAddTile(tile.tileX, tile.tileZ);
              }}
            >
              <planeGeometry args={[terrainTileSize, terrainTileSize]} />
              <meshBasicMaterial color={0x9af7bf} transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <FloatingTileActionButton
              kind="add"
              position={[centerX, 1.4, centerZ]}
              onClick={() => onAddTile(tile.tileX, tile.tileZ)}
            />
          </group>
        );
      })}
      {tool === 'terrain' && terrainToolMode === 'delete-tile' && hoveredTerrainTileCenter && (
        <group key={hoveredTerrainTileCenter.key}>
          <mesh position={[hoveredTerrainTileCenter.centerX, 0.05, hoveredTerrainTileCenter.centerZ]} rotation-x={-Math.PI / 2}>
            <planeGeometry args={[terrainTileSize, terrainTileSize]} />
            <meshBasicMaterial color={0xff7d6e} transparent opacity={0.2} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <FloatingTileActionButton
            kind="delete"
            position={[hoveredTerrainTileCenter.centerX, 1.4, hoveredTerrainTileCenter.centerZ]}
            disabled={world.terrain.tiles.length <= 1}
            onClick={() => {
              onDeleteTile(hoveredTerrainTileCenter.tileX, hoveredTerrainTileCenter.tileZ);
              setHoveredTerrainTile(null);
            }}
          />
        </group>
      )}
      <group>
        {world.staticProps.map((entity) => (
          <mesh
            key={entity.id}
            ref={(object) => registerSelectableObject(`static:${entity.id}`, object)}
            position={entity.position}
            quaternion={new THREE.Quaternion(...entity.rotation)}
            castShadow
            receiveShadow
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect({ kind: 'static', id: entity.id });
            }}
          >
            <boxGeometry args={scaleExtents(entity.halfExtents)} />
            <meshStandardMaterial color={selected?.kind === 'static' && selected.id === entity.id ? 0xbce784 : 0x7b6955} roughness={0.86} metalness={0.04} />
          </mesh>
        ))}
        {world.dynamicEntities.map((entity) => (
          <mesh
            key={entity.id}
            ref={(object) => registerSelectableObject(`dynamic:${entity.id}`, object)}
            position={entity.position}
            quaternion={new THREE.Quaternion(...entity.rotation)}
            castShadow
            receiveShadow
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect({ kind: 'dynamic', id: entity.id });
            }}
          >
            {entity.kind === 'ball' ? (
              <sphereGeometry args={[entity.radius ?? 0.5, 24, 24]} />
            ) : (
              <boxGeometry args={scaleExtents(entity.halfExtents ?? (entity.kind === 'vehicle' ? [1.4, 0.6, 2.4] : [0.5, 0.5, 0.5]))} />
            )}
            <meshStandardMaterial
              color={
                selected?.kind === 'dynamic' && selected.id === entity.id
                  ? 0xfff38a
                  : entity.kind === 'vehicle'
                    ? 0x4da6ff
                    : entity.kind === 'ball'
                      ? 0xff7d6e
                      : 0x9f8dff
              }
              roughness={0.48}
              metalness={entity.kind === 'vehicle' ? 0.35 : 0.08}
            />
          </mesh>
        ))}
      </group>
      {canShowTransform && (
        <TransformControls
          object={selectedObject ?? undefined}
          mode={transformMode}
          space={transformMode === 'translate' ? 'world' : 'local'}
          rotationSnap={transformMode === 'rotate' ? THREE.MathUtils.degToRad(5) : undefined}
          showX={transformMode !== 'rotate'}
          showY
          showZ={transformMode !== 'rotate'}
          onMouseDown={handleTransformMouseDown}
          onMouseUp={handleTransformMouseUp}
          onObjectChange={handleTransformObjectChange}
        />
      )}
      {tool === 'terrain' && terrainToolMode === 'sculpt' && (
        <mesh ref={brushCursorRef} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[Math.max(brushRadius - brushStrength * 0.5, 0.1), brushRadius, 64]} />
          <meshBasicMaterial color={brushMode === 'raise' ? 0x77ff9b : 0xffa875} transparent opacity={0.65} side={THREE.DoubleSide} />
        </mesh>
      )}
      <OrbitControls makeDefault enabled={tool === 'select'} maxDistance={180} target={[0, 0, 0]} />
    </Canvas>
  );
}

function FloatingTileActionButton({
  kind,
  position,
  onClick,
  disabled = false,
}: {
  kind: 'add' | 'delete';
  position: [number, number, number];
  onClick: () => void;
  disabled?: boolean;
}) {
  const color = disabled ? 0x7d7d7d : kind === 'add' ? 0x64d98f : 0xe76c5d;
  return (
    <group position={position}>
      <mesh
        onPointerDown={(event) => {
          event.stopPropagation();
          if (!disabled) {
            onClick();
          }
        }}
      >
        <cylinderGeometry args={[0.9, 0.9, 0.18, 32]} />
        <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} transparent opacity={disabled ? 0.45 : 0.9} />
      </mesh>
      <group position={[0, 0.15, 0]}>
        {kind === 'add' ? (
          <>
            <mesh>
              <boxGeometry args={[0.9, 0.14, 0.14]} />
              <meshStandardMaterial color={0xffffff} />
            </mesh>
            <mesh rotation-y={Math.PI / 2}>
              <boxGeometry args={[0.9, 0.14, 0.14]} />
              <meshStandardMaterial color={0xffffff} />
            </mesh>
          </>
        ) : (
          <>
            <mesh rotation-y={Math.PI / 4}>
              <boxGeometry args={[0.9, 0.14, 0.14]} />
              <meshStandardMaterial color={0xffffff} />
            </mesh>
            <mesh rotation-y={-Math.PI / 4}>
              <boxGeometry args={[0.9, 0.14, 0.14]} />
              <meshStandardMaterial color={0xffffff} />
            </mesh>
          </>
        )}
      </group>
    </group>
  );
}

function EditorFields({
  title,
  position,
  onPositionChange,
  dimensions,
  onDimensionsChange,
  radius,
  onRadiusChange,
  yawDegrees,
  onYawChange,
  onDelete,
}: {
  title: string;
  position: [number, number, number];
  onPositionChange: (axis: 0 | 1 | 2, value: number) => void;
  dimensions?: [number, number, number];
  onDimensionsChange?: (axis: 0 | 1 | 2, value: number) => void;
  radius?: number;
  onRadiusChange?: (value: number) => void;
  yawDegrees?: number;
  onYawChange?: (value: number) => void;
  onDelete: () => void;
}) {
  return (
    <div style={fieldStackStyle}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {(['X', 'Y', 'Z'] as const).map((label, axis) => (
        <label key={label} style={fieldLabelStyle}>
          Position {label}
          <input type="number" step="0.1" value={position[axis]} onChange={(event) => onPositionChange(axis as 0 | 1 | 2, Number(event.target.value))} />
        </label>
      ))}
      {dimensions && onDimensionsChange && (['Width', 'Height', 'Depth'] as const).map((label, axis) => (
        <label key={label} style={fieldLabelStyle}>
          {label}
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={dimensions[axis] * 2}
            onChange={(event) => onDimensionsChange(axis as 0 | 1 | 2, clampDimension(Number(event.target.value)) / 2)}
          />
        </label>
      ))}
      {radius != null && onRadiusChange && (
        <label style={fieldLabelStyle}>
          Radius
          <input type="number" min="0.1" step="0.1" value={radius} onChange={(event) => onRadiusChange(Number(event.target.value))} />
        </label>
      )}
      {yawDegrees != null && onYawChange && (
        <label style={fieldLabelStyle}>
          Yaw
          <input type="number" step="1" value={yawDegrees} onChange={(event) => onYawChange(Number(event.target.value))} />
        </label>
      )}
      <button type="button" onClick={onDelete} style={dangerButtonStyle}>Delete</button>
    </div>
  );
}

function withAxis(vector: [number, number, number], axis: 0 | 1 | 2, value: number): [number, number, number] {
  return vector.map((component, index) => (index === axis ? value : component)) as [number, number, number];
}

function clampDimension(value: number): number {
  return Math.max(0.1, Number.isFinite(value) ? value : 0.1);
}

function clampBrushHeight(value: number, min: number, max: number): number {
  const fallback = Number.isFinite(value) ? value : min;
  return Math.min(Math.max(fallback, min), max);
}

function scaleExtents(extents: [number, number, number]): [number, number, number] {
  return [extents[0] * 2, extents[1] * 2, extents[2] * 2];
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'world';
}

const pageStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '340px minmax(0, 1fr)',
  minHeight: '100%',
  background: 'linear-gradient(180deg, #0d1824 0%, #060a10 100%)',
  color: '#eef7ff',
};

const sidebarStyle: CSSProperties = {
  borderRight: '1px solid rgba(141, 186, 221, 0.14)',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  overflowY: 'auto',
  background: 'rgba(3, 8, 14, 0.92)',
};

const viewportStyle: CSSProperties = {
  position: 'relative',
  minHeight: '100vh',
};

const sectionStyle: CSSProperties = {
  border: '1px solid rgba(141, 186, 221, 0.14)',
  borderRadius: 16,
  padding: 16,
  background: 'rgba(14, 26, 38, 0.84)',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 13,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#86d6f5',
  marginBottom: 10,
};

const eyebrowStyle: CSSProperties = {
  fontSize: 12,
  letterSpacing: '0.24em',
  textTransform: 'uppercase',
  color: '#86d6f5',
};

const titleStyle: CSSProperties = {
  margin: '10px 0 8px',
  fontSize: 42,
  lineHeight: 1,
};

const bodyStyle: CSSProperties = {
  color: 'rgba(238, 247, 255, 0.72)',
  lineHeight: 1.55,
  margin: 0,
};

const mutedTextStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.6)',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const buttonGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

const fieldStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const fieldLabelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 13,
  color: 'rgba(238, 247, 255, 0.82)',
};

const baseButtonStyle: CSSProperties = {
  borderRadius: 10,
  padding: '10px 12px',
  border: '1px solid rgba(167, 208, 237, 0.16)',
  cursor: 'pointer',
  fontWeight: 600,
};

const primaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#9ed86f',
  color: '#10210d',
};

const secondaryButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: 'rgba(20, 34, 48, 0.96)',
  color: '#eef7ff',
};

const activeButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#74d4ff',
  color: '#102434',
};

const dangerButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  background: '#ff8573',
  color: '#38130e',
};

const historyListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const historyButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  textAlign: 'left',
};

const godModePlayOverlayStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  left: 8,
  right: 8,
  zIndex: 12,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  background: 'rgba(5, 9, 16, 0.64)',
  padding: '8px 12px',
  borderRadius: 12,
  color: '#eef7ff',
};

const editorViewportOverlayStyle: CSSProperties = {
  position: 'absolute',
  top: 16,
  left: 16,
  zIndex: 10,
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  alignItems: 'center',
  background: 'rgba(5, 9, 16, 0.68)',
  padding: '10px 12px',
  borderRadius: 12,
  color: '#eef7ff',
  fontSize: 13,
};
