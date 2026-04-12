import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { OrbitControls, Sky } from '@react-three/drei';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { App } from '../App';
import { WorldTerrain } from '../scene/WorldTerrain';
import {
  applyTerrainBrush,
  cloneWorldDocument,
  getNextWorldEntityId,
  getMinimumDynamicEntityY,
  identityQuaternion,
  parseWorldDocument,
  quaternionFromYaw,
  sampleTerrainHeightAtWorldPosition,
  serializeWorldDocument,
  yawFromQuaternion,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type WorldDocument,
  type WorldDraftRevision,
} from '../world/worldDocument';
import {
  getInitialGodModeWorld,
  getLastImportName,
  loadRevisionHistory,
  markAutosaveBackup,
  pushRevisionHistory,
  saveCurrentDraft,
  setLastImportName,
  shouldCreateAutosaveBackup,
} from '../world/worldDraftStore';

type EditorMode = 'edit' | 'play';
type EditorTool = 'select' | 'terrain';
type SelectedTarget =
  | { kind: 'static'; id: number }
  | { kind: 'dynamic'; id: number }
  | null;

export function GodModePage() {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [tool, setTool] = useState<EditorTool>('select');
  const [world, setWorld] = useState<WorldDocument>(() => getInitialGodModeWorld());
  const [history, setHistory] = useState<WorldDraftRevision[]>(() => loadRevisionHistory());
  const [selected, setSelected] = useState<SelectedTarget>(null);
  const [brushRadius, setBrushRadius] = useState(8);
  const [brushStrength, setBrushStrength] = useState(0.12);
  const [brushMode, setBrushMode] = useState<'raise' | 'lower'>('raise');
  const [playWorldSnapshot, setPlayWorldSnapshot] = useState<WorldDocument | null>(null);
  const [lastImportName, setLastImportNameState] = useState(() => getLastImportName());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    initializedRef.current = true;
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      saveCurrentDraft(world);
      const nowMs = Date.now();
      if (shouldCreateAutosaveBackup(nowMs)) {
        setHistory(pushRevisionHistory(world, 'Autosave backup'));
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
  }, [world]);

  const selectedStatic = selected?.kind === 'static'
    ? world.staticProps.find((entity) => entity.id === selected.id) ?? null
    : null;
  const selectedDynamic = selected?.kind === 'dynamic'
    ? world.dynamicEntities.find((entity) => entity.id === selected.id) ?? null
    : null;

  const handleStartPlay = useCallback(() => {
    const snapshot = cloneWorldDocument(world);
    setPlayWorldSnapshot(snapshot);
    setMode('play');
  }, [world]);

  const handleReturnToEdit = useCallback(() => {
    setMode('edit');
    setPlayWorldSnapshot(null);
  }, []);

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
    setHistory(pushRevisionHistory(nextWorld, `Imported ${file.name}`));
    event.target.value = '';
  }, []);

  const handleRestoreRevision = useCallback((revision: WorldDraftRevision) => {
    setWorld(cloneWorldDocument(revision.world));
    setSelected(null);
  }, []);

  const addStaticCuboid = useCallback(() => {
    const nextId = getNextWorldEntityId(world);
    const baseY = sampleTerrainHeightAtWorldPosition(world, 0, 0) + 1;
    const nextStatic: StaticProp = {
      id: nextId,
      kind: 'cuboid',
      position: [0, baseY, 0],
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

  const updateSelectedHalfExtent = useCallback((axis: 0 | 1 | 2, value: number) => {
    setWorld((current) => {
      if (!selected) return current;
      if (selected.kind === 'static') {
        return {
          ...current,
          staticProps: current.staticProps.map((entity) => (
            entity.id === selected.id
              ? { ...entity, halfExtents: withAxis(entity.halfExtents, axis, value) }
              : entity
          )),
        };
      }
      return {
        ...current,
        dynamicEntities: current.dynamicEntities.map((entity) => (
          entity.id === selected.id && entity.halfExtents
            ? { ...entity, halfExtents: withAxis(entity.halfExtents, axis, value) }
            : entity
        )),
      };
    });
  }, [selected]);

  const updateSelectedRadius = useCallback((value: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    setWorld((current) => ({
      ...current,
      dynamicEntities: current.dynamicEntities.map((entity) => (
        entity.id === selected.id
          ? { ...entity, radius: value }
          : entity
      )),
    }));
  }, [selected]);

  const updateSelectedYaw = useCallback((yawDegrees: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    const yawRadians = (yawDegrees * Math.PI) / 180;
    setWorld((current) => ({
      ...current,
      dynamicEntities: current.dynamicEntities.map((entity) => (
        entity.id === selected.id
          ? { ...entity, rotation: quaternionFromYaw(yawRadians) }
          : entity
      )),
    }));
  }, [selected]);

  const editScene = useMemo(() => (
    <GodModeEditorScene
      world={world}
      tool={tool}
      selected={selected}
      brushRadius={brushRadius}
      brushStrength={brushStrength}
      brushMode={brushMode}
      onSelect={setSelected}
      onPaint={(x, z) => {
        setWorld((current) => applyTerrainBrush(current, x, z, brushRadius, brushStrength, brushMode));
      }}
    />
  ), [brushMode, brushRadius, brushStrength, selected, tool, world]);

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
          </div>
          <div style={mutedTextStyle}>
            Autosaves are stored in localStorage. {lastImportName ? `Last import: ${lastImportName}` : 'No imported file yet.'}
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
                  <div style={buttonRowStyle}>
                    <button type="button" onClick={() => setBrushMode('raise')} style={brushMode === 'raise' ? activeButtonStyle : secondaryButtonStyle}>Raise</button>
                    <button type="button" onClick={() => setBrushMode('lower')} style={brushMode === 'lower' ? activeButtonStyle : secondaryButtonStyle}>Lower</button>
                  </div>
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
              <div style={sectionTitleStyle}>Selection</div>
              {!selected && <div style={mutedTextStyle}>Select an authored object to edit transform and shape values.</div>}
              {selectedStatic && (
                <EditorFields
                  title={`Static ${selectedStatic.id}`}
                  position={selectedStatic.position}
                  onPositionChange={updateSelectedPosition}
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
        {mode === 'edit' && editScene}
        {mode === 'play' && playWorldSnapshot && (
          <GodModePlayViewport
            world={playWorldSnapshot}
            onExit={handleReturnToEdit}
          />
        )}
      </main>
    </div>
  );
}

function GodModeEditorScene({
  world,
  tool,
  selected,
  brushRadius,
  brushStrength,
  brushMode,
  onSelect,
  onPaint,
}: {
  world: WorldDocument;
  tool: EditorTool;
  selected: SelectedTarget;
  brushRadius: number;
  brushStrength: number;
  brushMode: 'raise' | 'lower';
  onSelect: (next: SelectedTarget) => void;
  onPaint: (x: number, z: number) => void;
}) {
  const paintingRef = useRef(false);
  const brushCursorRef = useRef<THREE.Mesh>(null);

  const handleTerrainPointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (brushCursorRef.current) {
      brushCursorRef.current.position.set(event.point.x, event.point.y + 0.06, event.point.z);
    }
    if (tool === 'terrain' && paintingRef.current) {
      onPaint(event.point.x, event.point.z);
    }
  }, [onPaint, tool]);

  const handleTerrainPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (tool === 'terrain') {
      paintingRef.current = true;
      onPaint(event.point.x, event.point.z);
      return;
    }
    onSelect(null);
  }, [onPaint, onSelect, tool]);

  const handleTerrainPointerUp = useCallback(() => {
    paintingRef.current = false;
  }, []);

  useEffect(() => () => {
    paintingRef.current = false;
  }, []);

  return (
    <Canvas
      shadows
      camera={{ fov: 55, near: 0.1, far: 600, position: [28, 28, 28] }}
      style={{ width: '100%', height: '100%' }}
      onPointerUp={handleTerrainPointerUp}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[32, 48, 12]} intensity={1.4} castShadow shadow-mapSize-width={2048} shadow-mapSize-height={2048} />
      <Sky sunPosition={[24, 12, 8]} />
      <WorldTerrain
        world={world}
        onPointerDown={handleTerrainPointerDown}
        onPointerMove={handleTerrainPointerMove}
        onPointerUp={handleTerrainPointerUp}
      />
      <group>
        {world.staticProps.map((entity) => (
          <mesh
            key={entity.id}
            position={entity.position}
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
      {tool === 'terrain' && (
        <mesh ref={brushCursorRef} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[Math.max(brushRadius - brushStrength * 0.5, 0.1), brushRadius, 64]} />
          <meshBasicMaterial color={brushMode === 'raise' ? 0x77ff9b : 0xffa875} transparent opacity={0.65} side={THREE.DoubleSide} />
        </mesh>
      )}
      <OrbitControls enabled={tool === 'select'} maxDistance={180} target={[0, 0, 0]} />
    </Canvas>
  );
}

function GodModePlayViewport({
  world,
  onExit,
}: {
  world: WorldDocument;
  onExit: () => void;
}) {
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={playTopBarStyle}>
        <span>Godmode Play uses the normal `/practice` runtime with the current authored world.</span>
        <button type="button" onClick={onExit} style={secondaryButtonStyle}>Back To Edit</button>
      </div>
      <App mode="practice" worldDocument={world} />
    </div>
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
          {label} / 2
          <input type="number" min="0.1" step="0.1" value={dimensions[axis]} onChange={(event) => onDimensionsChange(axis as 0 | 1 | 2, Number(event.target.value))} />
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

const playTopBarStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  right: 12,
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
