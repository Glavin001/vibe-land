import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { OrbitControls, Sky, TransformControls } from '@react-three/drei';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { App } from '../App';
import { WorldTerrain } from '../scene/WorldTerrain';
import { DestructibleAuthoringPreview } from '../scene/DestructibleAuthoringPreview';
import {
  DEFAULT_WORLD_DOCUMENT,
  DEFAULT_TERRAIN_MATERIALS,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_MIN_HEIGHT,
  addTerrainTile,
  applyMaterialBrush,
  applyTerrainBrush,
  applyTerrainRampStencil,
  getTerrainMaterials,
  cloneWorldDocument,
  createEmptyWorldDocument,
  getAddableTerrainTiles,
  getTerrainRampEndpointHeights,
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
  type TerrainMaterial,
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
import {
  fetchCloudConfig,
  fetchPublishedWorld,
  publishWorld,
} from '../world/worldsCloud';
import { captureCanvasScreenshot } from '../world/canvasScreenshot';
import { recordPublishedWorld } from '../world/publishedHistory';
import {
  createEmptyWorldEditHistory,
  commitWorldEdit,
  generateCommitId,
  redoWorldEdit,
  undoWorldEdit,
  type CommitEntry,
  type WorldEditHistory,
} from './godModeHistory';
import {
  addDestructibleStructureToWorld,
  addDynamicEntityToWorld,
  addStaticCuboidToWorld,
  clonePlayWorldSnapshot,
  getSelectedDestructible,
  getSelectedDynamic,
  getSelectedStatic,
  removeSelectedTargetFromWorld,
  resolveSelectedTransformEntity,
  selectionExists,
  updateSelectedTargetHalfExtents,
  updateSelectedTargetPosition,
  updateSelectedTargetRadius,
  updateSelectedTargetRotation,
  updateSelectedTargetVehicleType,
  type SelectedTarget,
  type SelectedTransformEntity,
} from './godModeEditorDocument';
import { AiChatPanel, type AiChatPanelHandle } from './godmode/AiChatPanel';
import { CustomStencilPanel } from './godmode/CustomStencilPanel';
import { CustomStencilPreview } from './godmode/CustomStencilPreview';
import { useHumanEditTracker } from './godmode/useHumanEditTracker';
import type { SplineData } from '../ai/splineData';
import { applyCustomStencilToWorld, type CustomStencilDefinition } from '../ai/customStencil';
import { useCustomStencils } from '../ai/customStencilStore';
import type { WorldAccessors } from '../ai/worldToolHelpers';
import {
  getSharedVehicleDefinition,
  getSharedVehicleDefinitions,
  getSharedVehicleDefaultType,
} from '../wasm/sharedVehicleDefinitions';

type EditorMode = 'edit' | 'play';
type EditorTool = 'select' | 'terrain' | 'paint';
type TerrainToolMode = 'sculpt' | 'ramp' | 'add-tile' | 'delete-tile' | `custom:${string}`;
type TransformMode = 'translate' | 'rotate' | 'scale';

type PublishStatus =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'preview'; dataUrl: string; blob: Blob }
  | { kind: 'publishing'; dataUrl: string }
  | { kind: 'success'; id: string; shareUrl: string; clipboardOk: boolean }
  | { kind: 'error'; message: string };

export type GodModePageProps = {
  publishedId?: string;
};

export function GodModePage({ publishedId }: GodModePageProps = {}) {
  const [mode, setMode] = useState<EditorMode>('edit');
  const [tool, setTool] = useState<EditorTool>('select');
  const [transformMode, setTransformMode] = useState<TransformMode>('translate');
  const [world, setWorld] = useState<WorldDocument>(() => getInitialGodModeWorld());
  const [history, setHistory] = useState<WorldDraftRevision[]>([]);
  const [editHistory, setEditHistory] = useState<WorldEditHistory>(() => createEmptyWorldEditHistory());
  const [storageReady, setStorageReady] = useState(false);
  const [selected, setSelected] = useState<SelectedTarget>(null);
  const [brushRadius, setBrushRadius] = useState(8);
  const [brushStrength, setBrushStrength] = useState(0.12);
  const [brushMode, setBrushMode] = useState<'raise' | 'lower'>('raise');
  const [terrainToolMode, setTerrainToolMode] = useState<TerrainToolMode>('sculpt');
  const [brushMinHeight, setBrushMinHeight] = useState(TERRAIN_MIN_HEIGHT);
  const [brushMaxHeight, setBrushMaxHeight] = useState(TERRAIN_MAX_HEIGHT);
  const [rampWidth, setRampWidth] = useState(8);
  const [rampLength, setRampLength] = useState(16);
  const [rampGradePct, setRampGradePct] = useState(25);
  const [rampYawDegrees, setRampYawDegrees] = useState(0);
  const [rampMode, setRampMode] = useState<'raise' | 'lower'>('raise');
  const [rampStrength, setRampStrength] = useState(0.2);
  const [rampTargetHeight, setRampTargetHeight] = useState(6);
  const [rampTargetEdge, setRampTargetEdge] = useState<'start' | 'end'>('end');
  const [rampTargetKind, setRampTargetKind] = useState<'min' | 'max'>('max');
  const [rampSideFalloff, setRampSideFalloff] = useState(2);
  const [rampStartFalloff, setRampStartFalloff] = useState(0);
  const [rampEndFalloff, setRampEndFalloff] = useState(0);
  const [paintMaterial, setPaintMaterial] = useState(0);
  const [paintRadius, setPaintRadius] = useState(8);
  const [paintStrength, setPaintStrength] = useState(0.5);
  const [commitMessageDraft, setCommitMessageDraft] = useState('');
  const customStencils = useCustomStencils();
  const [customStencilParams, setCustomStencilParams] = useState<Record<string, Record<string, unknown>>>({});
  const [playWorldSnapshot, setPlayWorldSnapshot] = useState<WorldDocument | null>(null);
  const [playSessionKey, setPlaySessionKey] = useState(0);
  const [lastImportName, setLastImportNameState] = useState(() => getLastImportName());
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [cloudPublicUrl, setCloudPublicUrl] = useState<string | null>(null);
  // Tracks the published world this session is derived from. When the user
  // opens a published world (via ?published=<id>) and then re-publishes,
  // this id is sent as `parentId` so the ancestry chain is preserved.
  // Cleared when the user imports a local file or resets to default.
  const [sourcePublishedId, setSourcePublishedId] = useState<string | null>(publishedId ?? null);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({ kind: 'idle' });
  const [cloudLoadStatus, setCloudLoadStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'loading'; id: string }
    | { kind: 'loaded'; id: string; name: string }
    | { kind: 'error'; id: string; message: string }
  >(publishedId ? { kind: 'loading', id: publishedId } : { kind: 'idle' });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const worldRef = useRef(world);
  const editHistoryRef = useRef(editHistory);
  const editTransactionRef = useRef<WorldDocument | null>(null);
  const isAiEditRef = useRef(false);
  const aiChatRef = useRef<AiChatPanelHandle>(null);
  const splinesRef = useRef<Map<string, SplineData>>(new Map());

  const activeCustomStencilId = typeof terrainToolMode === 'string' && terrainToolMode.startsWith('custom:')
    ? terrainToolMode.slice(7)
    : null;
  const activeCustomStencil = activeCustomStencilId
    ? customStencils.find((s) => s.id === activeCustomStencilId) ?? null
    : null;
  const activeCustomParams = activeCustomStencilId
    ? { ...activeCustomStencil?.defaultParams, ...customStencilParams[activeCustomStencilId] }
    : {};

  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  useEffect(() => {
    editHistoryRef.current = editHistory;
  }, [editHistory]);

  const replaceWorldState = useCallback((nextWorld: WorldDocument) => {
    worldRef.current = nextWorld;
    setWorld(nextWorld);
  }, []);

  const replaceEditHistoryState = useCallback((nextHistory: WorldEditHistory) => {
    editHistoryRef.current = nextHistory;
    setEditHistory(nextHistory);
  }, []);

  const applyPreviewWorldEdit = useCallback((updater: (current: WorldDocument) => WorldDocument) => {
    const current = worldRef.current;
    const next = updater(current);
    if (next === current) {
      return false;
    }
    replaceWorldState(next);
    return true;
  }, [replaceWorldState]);

  const applyCommittedWorldEdit = useCallback((
    updater: (current: WorldDocument) => WorldDocument,
    commitInfo?: { commitId?: string; commitMessage?: string; source?: CommitEntry['source'] },
  ) => {
    const current = worldRef.current;
    const next = updater(current);
    if (next === current) {
      return false;
    }
    const transition = commitWorldEdit(editHistoryRef.current, current, next, {
      commitId: commitInfo?.commitId ?? generateCommitId(),
      commitMessage: commitInfo?.commitMessage ?? 'Manual edit',
      source: commitInfo?.source ?? 'human',
    });
    if (!transition.changed) {
      return false;
    }
    replaceEditHistoryState(transition.history);
    replaceWorldState(next);
    return true;
  }, [replaceEditHistoryState, replaceWorldState]);

  const beginTrackedWorldEdit = useCallback(() => {
    if (!editTransactionRef.current) {
      editTransactionRef.current = cloneWorldDocument(worldRef.current);
    }
  }, []);

  const commitTrackedWorldEdit = useCallback(() => {
    const startWorld = editTransactionRef.current;
    editTransactionRef.current = null;
    if (!startWorld) {
      return false;
    }
    const transition = commitWorldEdit(editHistoryRef.current, startWorld, worldRef.current, {
      commitId: generateCommitId(),
      commitMessage: 'Manual edit',
      source: 'human',
    });
    if (!transition.changed) {
      return false;
    }
    replaceEditHistoryState(transition.history);
    return true;
  }, [replaceEditHistoryState]);

  const cancelTrackedWorldEdit = useCallback(() => {
    editTransactionRef.current = null;
  }, []);

  const aiAccessors = useMemo<WorldAccessors>(() => ({
    getWorld: () => worldRef.current,
    commitEdit: (updater, options) => {
      const wasAiEdit = isAiEditRef.current;
      if (options?.isAiEdit) {
        isAiEditRef.current = true;
      }
      try {
        return applyCommittedWorldEdit(updater);
      } finally {
        isAiEditRef.current = wasAiEdit;
      }
    },
    applyWithoutCommit: (updater) => {
      return applyPreviewWorldEdit(updater);
    },
    restoreWorld: (snapshot) => {
      replaceWorldState(snapshot);
    },
    commitAsAi: (snapshotBefore, commitId, commitMessage) => {
      const transition = commitWorldEdit(editHistoryRef.current, snapshotBefore, worldRef.current, {
        commitId,
        commitMessage,
        source: 'ai',
      });
      if (transition.changed) {
        replaceEditHistoryState(transition.history);
      }
    },
    rollbackToCommit: (targetCommitId) => {
      const history = editHistoryRef.current;
      const idx = history.undoStack.findIndex((entry) => entry.commitId === targetCommitId);
      if (idx === -1) {
        return { ok: false, message: `Commit ${targetCommitId} not found in history.` };
      }
      const targetWorld = cloneWorldDocument(history.undoStack[idx].world);
      const rollbackCommitId = generateCommitId();
      const transition = commitWorldEdit(editHistoryRef.current, worldRef.current, targetWorld, {
        commitId: rollbackCommitId,
        commitMessage: `Rollback to ${targetCommitId}`,
        source: 'rollback',
      });
      if (transition.changed) {
        replaceEditHistoryState(transition.history);
        replaceWorldState(targetWorld);
      }
      return { ok: true, message: `Rolled back to commit ${targetCommitId}`, commitId: rollbackCommitId };
    },
    getSplines: () => splinesRef.current,
    setSpline: (id, spline) => { splinesRef.current.set(id, spline); },
    deleteSpline: (id) => splinesRef.current.delete(id),
  }), [applyCommittedWorldEdit, applyPreviewWorldEdit, replaceEditHistoryState, replaceWorldState]);

  const handleHumanEdit = useCallback((summary: string) => {
    aiChatRef.current?.pushHumanEdit(summary);
  }, []);

  useHumanEditTracker({
    world,
    isAiEditRef,
    onHumanEdit: handleHumanEdit,
  });

  const handleUndo = useCallback(() => {
    cancelTrackedWorldEdit();
    const transition = undoWorldEdit(editHistoryRef.current, worldRef.current);
    if (!transition.changed) {
      return;
    }
    replaceEditHistoryState(transition.history);
    replaceWorldState(transition.world);
  }, [cancelTrackedWorldEdit, replaceEditHistoryState, replaceWorldState]);

  const handleRedo = useCallback(() => {
    cancelTrackedWorldEdit();
    const transition = redoWorldEdit(editHistoryRef.current, worldRef.current);
    if (!transition.changed) {
      return;
    }
    replaceEditHistoryState(transition.history);
    replaceWorldState(transition.world);
  }, [cancelTrackedWorldEdit, replaceEditHistoryState, replaceWorldState]);

  const handleHumanCommit = useCallback(() => {
    const msg = commitMessageDraft.trim();
    if (!msg) return;
    // Push a named commit entry onto the undo stack labeling the current state.
    // We use a self-referencing snapshot so the entry acts as a named bookmark.
    const entry: CommitEntry = {
      commitId: generateCommitId(),
      commitMessage: msg,
      world: cloneWorldDocument(worldRef.current),
      timestamp: Date.now(),
      source: 'human',
    };
    replaceEditHistoryState({
      undoStack: [entry, ...editHistoryRef.current.undoStack].slice(0, 64),
      redoStack: [],
    });
    setCommitMessageDraft('');
  }, [commitMessageDraft, replaceEditHistoryState]);

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
        replaceWorldState(cloneWorldDocument(draft));
      }
      setHistory(revisionHistory);
      replaceEditHistoryState(createEmptyWorldEditHistory());
      setStorageReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [replaceEditHistoryState, replaceWorldState]);

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

  useEffect(() => {
    if (!selected) {
      return;
    }
    if (!selectionExists(world, selected)) {
      setSelected(null);
    }
  }, [selected, world]);

  const selectedStatic = useMemo(() => getSelectedStatic(world, selected), [selected, world]);
  const selectedDynamic = useMemo(() => getSelectedDynamic(world, selected), [selected, world]);
  const selectedDestructible = useMemo(() => getSelectedDestructible(world, selected), [selected, world]);
  const selectedTransformEntity = useMemo<SelectedTransformEntity | null>(() => {
    return resolveSelectedTransformEntity(world, selected);
  }, [selected, world]);

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
      if (event.target instanceof HTMLElement && (
        event.target.tagName === 'INPUT'
        || event.target.tagName === 'TEXTAREA'
        || event.target.isContentEditable
      )) {
        return;
      }
      const isMac = navigator.platform.includes('Mac');
      const modPressed = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modPressed && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if (modPressed && key === 'y') {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (tool !== 'select') {
        return;
      }
      if (key === 'w') {
        setTransformMode('translate');
      }
      if (key === 'e' && selectedTransformEntity?.canRotate) {
        setTransformMode('rotate');
      }
      if (key === 'r' && selectedTransformEntity?.canResize) {
        setTransformMode('scale');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRedo, handleUndo, mode, selectedTransformEntity, tool]);

  const handleStartPlay = useCallback(() => {
    const snapshot = clonePlayWorldSnapshot(worldRef.current);
    setPlayWorldSnapshot(snapshot);
    setPlaySessionKey((current) => current + 1);
    setMode('play');
  }, []);

  const handleReturnToEdit = useCallback(() => {
    setMode('edit');
    setPlayWorldSnapshot(null);
  }, []);

  const handleResetPlayWorld = useCallback(() => {
    if (mode !== 'play') {
      return;
    }
    setPlayWorldSnapshot(cloneWorldDocument(worldRef.current));
    setPlaySessionKey((current) => current + 1);
  }, [mode]);

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
    applyCommittedWorldEdit(() => cloneWorldDocument(nextWorld));
    setSelected(null);
    setSourcePublishedId(null); // imported file breaks the ancestry chain
    setLastImportName(file.name);
    setLastImportNameState(file.name);
    setHistory(await pushRevisionHistory(nextWorld, `Imported ${file.name}`));
    event.target.value = '';
  }, [applyCommittedWorldEdit]);

  const captureCurrentScreenshot = useCallback(async () => {
    const canvas = editorCanvasRef.current;
    if (!canvas) {
      throw new Error('Builder canvas is not ready. Switch to Edit mode and try again.');
    }
    return captureCanvasScreenshot(canvas);
  }, []);

  const handleStartPublish = useCallback(async () => {
    if (!cloudEnabled || mode !== 'edit') {
      return;
    }
    setPublishStatus({ kind: 'capturing' });
    try {
      const shot = await captureCurrentScreenshot();
      setPublishStatus({ kind: 'preview', dataUrl: shot.dataUrl, blob: shot.blob });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to capture screenshot.';
      setPublishStatus({ kind: 'error', message });
    }
  }, [cloudEnabled, mode, captureCurrentScreenshot]);

  const handleRetakeScreenshot = useCallback(async () => {
    setPublishStatus({ kind: 'capturing' });
    try {
      const shot = await captureCurrentScreenshot();
      setPublishStatus({ kind: 'preview', dataUrl: shot.dataUrl, blob: shot.blob });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to capture screenshot.';
      setPublishStatus({ kind: 'error', message });
    }
  }, [captureCurrentScreenshot]);

  const handleCancelPublish = useCallback(() => {
    setPublishStatus({ kind: 'idle' });
  }, []);

  const handleConfirmPublish = useCallback(async () => {
    if (publishStatus.kind !== 'preview') {
      return;
    }
    const { dataUrl, blob } = publishStatus;
    setPublishStatus({ kind: 'publishing', dataUrl });
    try {
      // publishWorld reserves an id and streams the gzipped world + the
      // screenshot directly to the storage backend in parallel. For the R2
      // backend this means the bytes go straight to R2 via presigned URLs
      // and never touch our function.
      const result = await publishWorld({
        world: worldRef.current,
        screenshot: blob,
        parentId: sourcePublishedId,
      });
      // After a successful publish, the new id becomes the ancestry source
      // if the user continues editing and publishes again.
      setSourcePublishedId(result.id);
      // Remember this publication on the local device so the user can see a
      // private gallery of their own worlds even without an account system.
      recordPublishedWorld({
        id: result.id,
        name: worldRef.current.meta.name || 'Untitled World',
        publishedAt: result.createdAt,
      });
      const shareUrl = `${window.location.origin}/builder/world?published=${encodeURIComponent(result.id)}`;
      let clipboardOk = false;
      try {
        await navigator.clipboard?.writeText(shareUrl);
        clipboardOk = true;
      } catch {
        clipboardOk = false;
      }
      setPublishStatus({
        kind: 'success',
        id: result.id,
        shareUrl,
        clipboardOk,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown publish error.';
      setPublishStatus({ kind: 'error', message });
    }
  }, [publishStatus]);

  const handleOpenGallery = useCallback(() => {
    window.location.href = '/gallery';
  }, []);

  // Probe cloud config once on mount. We only care whether the deployment has
  // R2 configured — the response contains no secrets.
  useEffect(() => {
    let cancelled = false;
    fetchCloudConfig()
      .then((config) => {
        if (!cancelled) {
          setCloudEnabled(config.enabled);
          setCloudPublicUrl(config.publicUrl ?? null);
        }
      })
      .catch(() => {
        // Feature stays disabled on transient errors; the rest of the builder keeps working.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // If the builder was opened with `?published=<id>`, pull that world from R2
  // and load it in place of the local draft. We wait for storage to be ready
  // so we don't race with the initial IndexedDB restore.
  useEffect(() => {
    if (!publishedId || !storageReady) {
      return;
    }
    let cancelled = false;
    setCloudLoadStatus({ kind: 'loading', id: publishedId });
    fetchPublishedWorld(publishedId, cloudPublicUrl)
      .then((raw) => {
        if (cancelled) {
          return;
        }
        const nextWorld = parseWorldDocument(raw);
        applyCommittedWorldEdit(() => cloneWorldDocument(nextWorld));
        setSelected(null);
        setCloudLoadStatus({ kind: 'loaded', id: publishedId, name: nextWorld.meta.name });
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const message = err instanceof Error ? err.message : 'Failed to load published world.';
        setCloudLoadStatus({ kind: 'error', id: publishedId, message });
      });
    return () => {
      cancelled = true;
    };
  }, [publishedId, storageReady, applyCommittedWorldEdit, cloudPublicUrl]);

  const handleRestoreRevision = useCallback((revision: WorldDraftRevision) => {
    applyCommittedWorldEdit(() => cloneWorldDocument(revision.world));
    setSelected(null);
  }, [applyCommittedWorldEdit]);

  const handleResetToDefault = useCallback(() => {
    void clearDraftStorage();
    applyCommittedWorldEdit(() => cloneWorldDocument(DEFAULT_WORLD_DOCUMENT));
    setHistory([]);
    setSelected(null);
    setSourcePublishedId(null); // reset breaks the ancestry chain
    setLastImportName('');
    setLastImportNameState('');
  }, [applyCommittedWorldEdit]);

  const handleClearAll = useCallback(() => {
    void clearDraftStorage();
    applyCommittedWorldEdit(() => createEmptyWorldDocument());
    setHistory([]);
    setSelected(null);
    setSourcePublishedId(null); // reset breaks the ancestry chain
    setLastImportName('');
    setLastImportNameState('');
  }, [applyCommittedWorldEdit]);

  const addStaticCuboid = useCallback(() => {
    let nextSelected: SelectedTarget = null;
    const changed = applyCommittedWorldEdit((current) => {
      const result = addStaticCuboidToWorld(current);
      nextSelected = result.selected;
      return result.world;
    });
    if (changed && nextSelected) {
      setSelected(nextSelected);
    }
  }, [applyCommittedWorldEdit]);

  const addDynamicEntity = useCallback((kind: DynamicEntity['kind']) => {
    let nextSelected: SelectedTarget = null;
    const changed = applyCommittedWorldEdit((current) => {
      const result = addDynamicEntityToWorld(current, kind);
      nextSelected = result.selected;
      return result.world;
    });
    if (changed && nextSelected) {
      setSelected(nextSelected);
    }
  }, [applyCommittedWorldEdit]);

  const addDestructibleStructure = useCallback(() => {
    let nextSelected: SelectedTarget = null;
    const changed = applyCommittedWorldEdit((current) => {
      const result = addDestructibleStructureToWorld(current);
      nextSelected = result.selected;
      return result.world;
    });
    if (changed && nextSelected) {
      setSelected(nextSelected);
    }
  }, [applyCommittedWorldEdit]);

  const removeSelected = useCallback(() => {
    if (!selected) {
      return;
    }
    const changed = applyCommittedWorldEdit((current) => removeSelectedTargetFromWorld(current, selected));
    if (changed) {
      setSelected(null);
    }
  }, [applyCommittedWorldEdit, selected]);

  const updateSelectedPosition = useCallback((axis: 0 | 1 | 2, value: number) => {
    const basePosition = selectedTransformEntity?.position;
    if (!basePosition) {
      return;
    }
    applyCommittedWorldEdit((current) => updateSelectedTargetPosition(current, selected, withAxis(basePosition, axis, value)));
  }, [applyCommittedWorldEdit, selected, selectedTransformEntity]);

  const updateSelectedPositionVector = useCallback((nextPosition: Vec3) => {
    applyPreviewWorldEdit((current) => updateSelectedTargetPosition(current, selected, nextPosition));
  }, [applyPreviewWorldEdit, selected]);

  const updateSelectedHalfExtent = useCallback((axis: 0 | 1 | 2, value: number) => {
    const baseHalfExtents = selectedTransformEntity?.halfExtents;
    if (!baseHalfExtents) {
      return;
    }
    const nextValue = clampDimension(value * 2) / 2;
    applyCommittedWorldEdit((current) => updateSelectedTargetHalfExtents(
      current,
      selected,
      withAxis(baseHalfExtents, axis, nextValue),
    ));
  }, [applyCommittedWorldEdit, selected, selectedTransformEntity]);

  const updateSelectedHalfExtentsVector = useCallback((nextHalfExtents: Vec3) => {
    const clampedHalfExtents = nextHalfExtents.map((value) => clampDimension(value * 2) / 2) as Vec3;
    applyPreviewWorldEdit((current) => updateSelectedTargetHalfExtents(current, selected, clampedHalfExtents));
  }, [applyPreviewWorldEdit, selected]);

  const updateSelectedRadius = useCallback((value: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    const nextRadius = clampDimension(value);
    applyCommittedWorldEdit((current) => updateSelectedTargetRadius(current, selected, nextRadius));
  }, [applyCommittedWorldEdit, selected]);

  const updateSelectedRadiusPreview = useCallback((value: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    const nextRadius = clampDimension(value);
    applyPreviewWorldEdit((current) => updateSelectedTargetRadius(current, selected, nextRadius));
  }, [applyPreviewWorldEdit, selected]);

  const updateSelectedVehicleType = useCallback((value: number) => {
    if (selected?.kind !== 'dynamic') {
      return;
    }
    applyCommittedWorldEdit((current) => updateSelectedTargetVehicleType(current, selected, value));
  }, [applyCommittedWorldEdit, selected]);

  const updateSelectedYaw = useCallback((yawDegrees: number) => {
    const yawRadians = (yawDegrees * Math.PI) / 180;
    const nextRotation = quaternionFromYaw(yawRadians);
    applyCommittedWorldEdit((current) => updateSelectedTargetRotation(current, selected, nextRotation));
  }, [applyCommittedWorldEdit, selected]);

  const updateSelectedRotationQuaternion = useCallback((nextRotation: Quaternion) => {
    applyPreviewWorldEdit((current) => updateSelectedTargetRotation(current, selected, nextRotation));
  }, [applyPreviewWorldEdit, selected]);

  const canUndo = editHistory.undoStack.length > 0;
  const canRedo = editHistory.redoStack.length > 0;

  const terrainMaterials = useMemo(() => getTerrainMaterials(world), [world]);

  const editScene = useMemo(() => (
    <GodModeEditorScene
      world={world}
      tool={tool}
      terrainToolMode={terrainToolMode}
      selected={selected}
      transformMode={transformMode}
      selectedTransformEntity={selectedTransformEntity}
      brushRadius={tool === 'paint' ? paintRadius : brushRadius}
      brushStrength={tool === 'paint' ? paintStrength : brushStrength}
      brushMode={brushMode}
      paintMaterial={paintMaterial}
      terrainMaterials={terrainMaterials}
      rampWidth={rampWidth}
      rampLength={rampLength}
      rampGradePct={rampGradePct}
      rampYawDegrees={rampYawDegrees}
      rampMode={rampMode}
      rampStrength={rampStrength}
      rampTargetHeight={rampTargetHeight}
      rampTargetEdge={rampTargetEdge}
      rampTargetKind={rampTargetKind}
      rampSideFalloff={rampSideFalloff}
      rampStartFalloff={rampStartFalloff}
      rampEndFalloff={rampEndFalloff}
      onSelect={setSelected}
      onTerrainEditStart={beginTrackedWorldEdit}
      onTerrainEditEnd={commitTrackedWorldEdit}
      onTransformStart={beginTrackedWorldEdit}
      onTransformEnd={commitTrackedWorldEdit}
      onTransformPositionChange={updateSelectedPositionVector}
      onTransformRotationChange={updateSelectedRotationQuaternion}
      onTransformHalfExtentsChange={updateSelectedHalfExtentsVector}
      onTransformRadiusChange={updateSelectedRadiusPreview}
      onPaint={(x, z) => {
        applyPreviewWorldEdit((current) => applyTerrainBrush(current, x, z, brushRadius, brushStrength, brushMode, {
          minHeight: brushMinHeight,
          maxHeight: brushMaxHeight,
        }));
      }}
      onMaterialPaint={(x, z) => {
        applyPreviewWorldEdit((current) => applyMaterialBrush(current, x, z, paintRadius, paintStrength, paintMaterial));
      }}
      onDeleteTile={(tileX, tileZ) => {
        if (worldRef.current.terrain.tiles.length <= 1) {
          return;
        }
        applyCommittedWorldEdit((current) => removeTerrainTile(current, tileX, tileZ));
      }}
      onAddTile={(tileX, tileZ) => {
        applyCommittedWorldEdit((current) => addTerrainTile(current, tileX, tileZ));
      }}
      onApplyRamp={(x, z) => {
        applyPreviewWorldEdit((current) => applyTerrainRampStencil(current, {
          centerX: x,
          centerZ: z,
          width: rampWidth,
          length: rampLength,
          gradePct: rampGradePct,
          yawRad: (rampYawDegrees * Math.PI) / 180,
          mode: rampMode,
          strength: rampStrength,
          targetHeight: rampTargetHeight,
          targetEdge: rampTargetEdge,
          targetKind: rampTargetKind,
          sideFalloffM: rampSideFalloff,
          startFalloffM: rampStartFalloff,
          endFalloffM: rampEndFalloff,
        }));
      }}
      activeCustomStencil={activeCustomStencil}
      activeCustomParams={activeCustomParams}
      onApplyCustomStencil={(x, z) => {
        if (!activeCustomStencil) return;
        applyPreviewWorldEdit((current) =>
          applyCustomStencilToWorld(current, activeCustomStencil, activeCustomParams, x, z),
        );
      }}
      onCanvasReady={(canvas) => {
        editorCanvasRef.current = canvas;
      }}
    />
  ), [
    brushMaxHeight,
    brushMode,
    brushMinHeight,
    brushRadius,
    brushStrength,
    rampGradePct,
    rampLength,
    rampMode,
    rampSideFalloff,
    rampStartFalloff,
    rampEndFalloff,
    rampStrength,
    rampTargetHeight,
    rampTargetEdge,
    rampTargetKind,
    rampWidth,
    rampYawDegrees,
    activeCustomStencil,
    activeCustomParams,
    terrainToolMode,
    beginTrackedWorldEdit,
    commitTrackedWorldEdit,
    selected,
    selectedTransformEntity,
    tool,
    transformMode,
    applyCommittedWorldEdit,
    applyPreviewWorldEdit,
    updateSelectedHalfExtentsVector,
    updateSelectedPositionVector,
    updateSelectedRadiusPreview,
    updateSelectedRotationQuaternion,
    paintMaterial,
    paintRadius,
    paintStrength,
    terrainMaterials,
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
          <h1 style={titleStyle}>World Builder</h1>
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
            <button type="button" onClick={handleClearAll} style={dangerButtonStyle}>Clear All</button>
          </div>
          <div style={mutedTextStyle}>
            Autosaves are stored in IndexedDB for larger worlds. {lastImportName ? `Last import: ${lastImportName}` : 'No imported file yet.'}
          </div>
        </div>

        {(cloudEnabled || cloudLoadStatus.kind !== 'idle') && (
          <div style={sectionStyle}>
            <div style={sectionTitleStyle}>Cloud</div>
            <div style={buttonRowStyle}>
              {cloudEnabled && (
                <button
                  type="button"
                  onClick={() => void handleStartPublish()}
                  style={primaryButtonStyle}
                  disabled={
                    publishStatus.kind === 'capturing'
                    || publishStatus.kind === 'preview'
                    || publishStatus.kind === 'publishing'
                    || mode !== 'edit'
                  }
                >
                  {publishStatus.kind === 'capturing' ? 'Capturing…' : 'Publish to Cloud'}
                </button>
              )}
              <button type="button" onClick={handleOpenGallery} style={secondaryButtonStyle}>
                Browse Gallery
              </button>
            </div>
            {cloudLoadStatus.kind === 'loading' && (
              <div style={mutedTextStyle}>Loading published world {cloudLoadStatus.id}…</div>
            )}
            {cloudLoadStatus.kind === 'loaded' && (
              <div style={mutedTextStyle}>Loaded &ldquo;{cloudLoadStatus.name}&rdquo; from the gallery.</div>
            )}
            {cloudLoadStatus.kind === 'error' && (
              <div style={{ ...mutedTextStyle, color: '#ffb4a6' }}>
                Failed to load published world: {cloudLoadStatus.message}
              </div>
            )}
            {publishStatus.kind === 'idle' && cloudEnabled && (
              <div style={mutedTextStyle}>
                Publishing captures a screenshot and saves your world to the cloud. Published worlds appear in the gallery.
              </div>
            )}
            {publishStatus.kind === 'success' && (
              <div style={mutedTextStyle}>
                Published as <code>{publishStatus.id}</code>.{' '}
                {publishStatus.clipboardOk ? 'Share link copied to clipboard.' : 'Copy the share link below.'}
                <div style={{ marginTop: 4, wordBreak: 'break-all', color: '#9cd4ff' }}>{publishStatus.shareUrl}</div>
              </div>
            )}
            {publishStatus.kind === 'error' && (
              <div style={{ ...mutedTextStyle, color: '#ffb4a6' }}>
                Publish failed: {publishStatus.message}
              </div>
            )}
          </div>
        )}

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Undo / Redo</div>
          <div style={buttonRowStyle}>
            <button type="button" onClick={handleUndo} style={secondaryButtonStyle} disabled={!canUndo}>Undo</button>
            <button type="button" onClick={handleRedo} style={secondaryButtonStyle} disabled={!canRedo}>Redo</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              value={commitMessageDraft}
              onChange={(e) => setCommitMessageDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleHumanCommit(); }}
              placeholder="Commit message..."
              style={{ flex: 1, padding: '5px 8px', fontSize: 12, background: 'rgba(20, 34, 48, 0.96)', color: '#eef7ff', border: '1px solid rgba(167, 208, 237, 0.18)', borderRadius: 8, fontFamily: 'inherit' }}
            />
            <button type="button" onClick={handleHumanCommit} style={secondaryButtonStyle} disabled={!commitMessageDraft.trim()}>Commit</button>
          </div>
          {editHistory.undoStack.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
              {editHistory.undoStack.map((entry) => (
                <div key={entry.commitId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px', borderRadius: 6, background: 'rgba(0,0,0,0.18)' }}>
                  <code style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(134,214,245,0.7)', flexShrink: 0 }}>{entry.commitId}</code>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(238,247,255,0.82)' }}>{entry.commitMessage}</span>
                  <span style={{
                    fontSize: 9,
                    padding: '1px 5px',
                    borderRadius: 4,
                    flexShrink: 0,
                    background: entry.source === 'ai' ? 'rgba(116,212,255,0.2)' : entry.source === 'rollback' ? 'rgba(255,200,100,0.2)' : 'rgba(255,255,255,0.08)',
                    color: entry.source === 'ai' ? '#bae8ff' : entry.source === 'rollback' ? '#ffe0a0' : 'rgba(238,247,255,0.5)',
                  }}>{entry.source}</span>
                </div>
              ))}
            </div>
          )}
          <div style={mutedTextStyle}>
            Cmd/Ctrl+Z undo. Shift+Cmd/Ctrl+Z or Ctrl+Y redo.
          </div>
        </div>

        {mode === 'edit' && (
          <>
            <div style={sectionStyle}>
              <div style={sectionTitleStyle}>Tools</div>
              <div style={buttonRowStyle}>
                <button type="button" onClick={() => setTool('select')} style={tool === 'select' ? activeButtonStyle : secondaryButtonStyle}>Select</button>
                <button type="button" onClick={() => setTool('terrain')} style={tool === 'terrain' ? activeButtonStyle : secondaryButtonStyle}>Terrain</button>
                <button type="button" onClick={() => setTool('paint')} style={tool === 'paint' ? activeButtonStyle : secondaryButtonStyle}>Paint</button>
              </div>
              {tool === 'terrain' && (
                <div style={fieldStackStyle}>
                  <div style={buttonRowStyle}>
                    <button type="button" onClick={() => setTerrainToolMode('sculpt')} style={terrainToolMode === 'sculpt' ? activeButtonStyle : secondaryButtonStyle}>Sculpt</button>
                    <button type="button" onClick={() => setTerrainToolMode('ramp')} style={terrainToolMode === 'ramp' ? activeButtonStyle : secondaryButtonStyle}>Ramp</button>
                    <button type="button" onClick={() => setTerrainToolMode('add-tile')} style={terrainToolMode === 'add-tile' ? activeButtonStyle : secondaryButtonStyle}>Add Tile</button>
                    <button type="button" onClick={() => setTerrainToolMode('delete-tile')} style={terrainToolMode === 'delete-tile' ? activeButtonStyle : secondaryButtonStyle}>Delete Tile</button>
                    {customStencils.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setTerrainToolMode(`custom:${s.id}`);
                          if (!customStencilParams[s.id]) {
                            setCustomStencilParams((prev) => ({ ...prev, [s.id]: s.defaultParams ?? {} }));
                          }
                        }}
                        style={terrainToolMode === `custom:${s.id}` ? activeButtonStyle : secondaryButtonStyle}
                        title={s.description}
                      >
                        {s.name}
                      </button>
                    ))}
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
                  ) : terrainToolMode === 'ramp' ? (
                    <>
                      <label style={fieldLabelStyle}>
                        Strength
                        <input type="range" min="0.02" max="1" step="0.02" value={rampStrength} onChange={(event) => setRampStrength(Number(event.target.value))} />
                        <span>{rampStrength.toFixed(2)}</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Width
                        <input type="range" min="2" max="30" step="0.5" value={rampWidth} onChange={(event) => setRampWidth(Number(event.target.value))} />
                        <span>{rampWidth.toFixed(1)}m</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Length
                        <input type="range" min="4" max="40" step="0.5" value={rampLength} onChange={(event) => setRampLength(Number(event.target.value))} />
                        <span>{rampLength.toFixed(1)}m</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Grade
                        <input type="range" min="1" max="100" step="1" value={rampGradePct} onChange={(event) => setRampGradePct(Number(event.target.value))} />
                        <span>{rampGradePct.toFixed(0)}%</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Direction
                        <input
                          type="range"
                          min="0"
                          max="355"
                          step="5"
                          value={rampYawDegrees}
                          onChange={(event) => setRampYawDegrees(Number(event.target.value))}
                        />
                        <span>{`${rampYawDegrees.toFixed(0)}deg start -> end`}</span>
                      </label>
                      <div style={buttonRowStyle}>
                        <button type="button" onClick={() => setRampTargetEdge('start')} style={rampTargetEdge === 'start' ? activeButtonStyle : secondaryButtonStyle}>Target Start</button>
                        <button type="button" onClick={() => setRampTargetEdge('end')} style={rampTargetEdge === 'end' ? activeButtonStyle : secondaryButtonStyle}>Target End</button>
                      </div>
                      <div style={buttonRowStyle}>
                        <button type="button" onClick={() => setRampTargetKind('min')} style={rampTargetKind === 'min' ? activeButtonStyle : secondaryButtonStyle}>Target Min</button>
                        <button type="button" onClick={() => setRampTargetKind('max')} style={rampTargetKind === 'max' ? activeButtonStyle : secondaryButtonStyle}>Target Max</button>
                      </div>
                      <label style={fieldLabelStyle}>
                        Target Height
                        <input
                          type="number"
                          min={TERRAIN_MIN_HEIGHT}
                          max={TERRAIN_MAX_HEIGHT}
                          step="0.5"
                          value={rampTargetHeight}
                          onChange={(event) => setRampTargetHeight(clampBrushHeight(Number(event.target.value), TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT))}
                        />
                        <span>{rampTargetEdge === 'start' ? 'Start edge' : 'End edge'} uses this {rampTargetKind} height.</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Side Shoulder
                        <input type="range" min="0" max="20" step="0.5" value={rampSideFalloff} onChange={(event) => setRampSideFalloff(Number(event.target.value))} />
                        <span>{rampSideFalloff.toFixed(1)}m</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        Start Falloff
                        <input type="range" min="0" max="20" step="0.5" value={rampStartFalloff} onChange={(event) => setRampStartFalloff(Number(event.target.value))} />
                        <span>{rampStartFalloff.toFixed(1)}m</span>
                      </label>
                      <label style={fieldLabelStyle}>
                        End Falloff
                        <input type="range" min="0" max="20" step="0.5" value={rampEndFalloff} onChange={(event) => setRampEndFalloff(Number(event.target.value))} />
                        <span>{rampEndFalloff.toFixed(1)}m</span>
                      </label>
                      <div style={buttonRowStyle}>
                        <button type="button" onClick={() => setRampMode('raise')} style={rampMode === 'raise' ? activeButtonStyle : secondaryButtonStyle}>Raise Ramp</button>
                        <button type="button" onClick={() => setRampMode('lower')} style={rampMode === 'lower' ? activeButtonStyle : secondaryButtonStyle}>Cut Ramp</button>
                      </div>
                      <div style={mutedTextStyle}>
                        Hold and drag to morph terrain toward the target ramp. Repeated passes converge instead of stacking.
                      </div>
                      <div style={mutedTextStyle}>
                        {describeRampTool(rampLength, rampGradePct, rampTargetHeight, rampTargetEdge, rampTargetKind, rampMode)}
                      </div>
                    </>
                  ) : terrainToolMode === 'add-tile' ? (
                    <div style={mutedTextStyle}>
                      Exposed edges in the viewport show ghost tiles with floating add buttons. Click any ghost tile to extend the world in connected, sparse shapes.
                    </div>
                  ) : terrainToolMode === 'delete-tile' ? (
                    <div style={mutedTextStyle}>
                      Hover a terrain tile in the viewport and click the floating delete button to remove that exact tile. The last remaining tile is protected.
                    </div>
                  ) : activeCustomStencil ? (
                    <CustomStencilPanel
                      stencil={activeCustomStencil}
                      params={activeCustomParams}
                      onChange={(nextParams) => {
                        if (!activeCustomStencilId) return;
                        setCustomStencilParams((prev) => ({ ...prev, [activeCustomStencilId]: nextParams }));
                      }}
                    />
                  ) : null}
                </div>
              )}
              {tool === 'paint' && (
                <div style={fieldStackStyle}>
                  <div style={mutedTextStyle}>Material</div>
                  <div style={buttonRowStyle}>
                    {terrainMaterials.map((mat, index) => (
                      <button
                        key={mat.name}
                        type="button"
                        onClick={() => setPaintMaterial(index)}
                        style={{
                          ...baseButtonStyle,
                          background: paintMaterial === index ? mat.color : 'rgba(20, 34, 48, 0.96)',
                          color: paintMaterial === index ? '#000' : '#eef7ff',
                          borderColor: paintMaterial === index ? mat.color : 'rgba(167, 208, 237, 0.16)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <span style={{ width: 12, height: 12, borderRadius: 3, background: mat.color, display: 'inline-block', border: '1px solid rgba(255,255,255,0.2)' }} />
                        {mat.name}
                      </button>
                    ))}
                  </div>
                  <label style={fieldLabelStyle}>
                    Radius
                    <input type="range" min="2" max="20" step="0.5" value={paintRadius} onChange={(event) => setPaintRadius(Number(event.target.value))} />
                    <span>{paintRadius.toFixed(1)}m</span>
                  </label>
                  <label style={fieldLabelStyle}>
                    Strength
                    <input type="range" min="0.05" max="1.0" step="0.05" value={paintStrength} onChange={(event) => setPaintStrength(Number(event.target.value))} />
                    <span>{paintStrength.toFixed(2)}</span>
                  </label>
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
                <button type="button" onClick={addDestructibleStructure} style={secondaryButtonStyle}>Destructible</button>
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
                  vehicleType={selectedDynamic.kind === 'vehicle'
                    ? (selectedDynamic.vehicleType ?? getSharedVehicleDefaultType())
                    : undefined}
                  vehicleTypeOptions={selectedDynamic.kind === 'vehicle'
                    ? getSharedVehicleDefinitions().map((definition) => ({
                      value: definition.vehicleType,
                      label: definition.name,
                    }))
                    : undefined}
                  onVehicleTypeChange={selectedDynamic.kind === 'vehicle' ? updateSelectedVehicleType : undefined}
                  yawDegrees={(yawFromQuaternion(selectedDynamic.rotation) * 180) / Math.PI}
                  onYawChange={updateSelectedYaw}
                  onDelete={removeSelected}
                />
              )}
              {selectedDestructible && (
                <EditorFields
                  title={`destructible ${selectedDestructible.kind} ${selectedDestructible.id}`}
                  position={selectedDestructible.position}
                  onPositionChange={updateSelectedPosition}
                  yawDegrees={(yawFromQuaternion(selectedDestructible.rotation) * 180) / Math.PI}
                  onYawChange={updateSelectedYaw}
                  onDelete={removeSelected}
                >
                  {selectedDestructible.kind === 'structure' ? (
                    <div style={mutedTextStyle}>
                      {selectedDestructible.chunks.length} chunk{selectedDestructible.chunks.length === 1 ? '' : 's'}
                      {' · '}density {selectedDestructible.density ?? 2400} kg/m³
                      {' · '}solver scale {selectedDestructible.solverMaterialScale ?? 1}
                      <br />
                      Use the AI chat to add / remove / tune individual chunks.
                    </div>
                  ) : (
                    <div style={mutedTextStyle}>
                      Factory {selectedDestructible.kind} — immutable preset. Ask the AI to convert it to a
                      structure if you want to edit individual chunks.
                    </div>
                  )}
                </EditorFields>
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
        {mode === 'edit' && (
          <div style={undoRedoViewportOverlayStyle}>
            <span>{canUndo ? `${editHistory.undoStack.length} undo` : 'No undo history'}</span>
            <span>{canRedo ? `${editHistory.redoStack.length} redo` : 'No redo history'}</span>
          </div>
        )}
        {editScene}
        {(publishStatus.kind === 'preview' || publishStatus.kind === 'publishing' || publishStatus.kind === 'capturing') && (
          <PublishPreviewOverlay
            status={publishStatus}
            onConfirm={() => void handleConfirmPublish()}
            onRetake={() => void handleRetakeScreenshot()}
            onCancel={handleCancelPublish}
          />
        )}
      </main>

      <AiChatPanel ref={aiChatRef} accessors={aiAccessors} />
    </div>
  );
}

type PublishPreviewOverlayStatus =
  | { kind: 'capturing' }
  | { kind: 'preview'; dataUrl: string; blob: Blob }
  | { kind: 'publishing'; dataUrl: string };

function PublishPreviewOverlay({
  status,
  onConfirm,
  onRetake,
  onCancel,
}: {
  status: PublishPreviewOverlayStatus;
  onConfirm: () => void;
  onRetake: () => void;
  onCancel: () => void;
}) {
  const busy = status.kind === 'capturing' || status.kind === 'publishing';
  const dataUrl = status.kind === 'preview' || status.kind === 'publishing' ? status.dataUrl : null;
  const sizeBytes = status.kind === 'preview' ? status.blob.size : null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        right: 20,
        width: 360,
        padding: 18,
        borderRadius: 18,
        background: 'rgba(6, 12, 20, 0.94)',
        border: '1px solid rgba(110, 190, 255, 0.3)',
        boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
        color: '#edf6ff',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        zIndex: 40,
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#87d6ff' }}>
        Publish preview
      </div>
      <div
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          borderRadius: 10,
          overflow: 'hidden',
          background: '#04070d',
          border: '1px solid rgba(145, 198, 255, 0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt="Screenshot preview"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ fontSize: 13, color: 'rgba(237, 246, 255, 0.62)' }}>Capturing…</div>
        )}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(237, 246, 255, 0.78)' }}>
        Orient the view behind this panel and click Retake to capture a different angle. Hit Publish when you're happy with it.
        {sizeBytes != null && (
          <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(237, 246, 255, 0.55)' }}>
            Screenshot {(sizeBytes / 1024).toFixed(1)} KB
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || status.kind !== 'preview'}
          style={{
            flex: '1 1 120px',
            padding: '10px 14px',
            borderRadius: 999,
            border: 'none',
            background: 'linear-gradient(180deg, #4cd1ff 0%, #2f8bd6 100%)',
            color: '#04121f',
            fontWeight: 600,
            fontSize: 14,
            cursor: busy ? 'wait' : 'pointer',
            opacity: status.kind === 'preview' ? 1 : 0.7,
          }}
        >
          {status.kind === 'publishing' ? 'Publishing…' : 'Publish'}
        </button>
        <button
          type="button"
          onClick={onRetake}
          disabled={busy}
          style={{
            flex: '1 1 100px',
            padding: '10px 14px',
            borderRadius: 999,
            border: '1px solid rgba(145, 198, 255, 0.3)',
            background: 'transparent',
            color: '#cfe7ff',
            fontSize: 13,
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          Retake
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={status.kind === 'publishing'}
          style={{
            flex: '1 1 90px',
            padding: '10px 14px',
            borderRadius: 999,
            border: '1px solid rgba(255, 180, 166, 0.3)',
            background: 'transparent',
            color: '#ffb4a6',
            fontSize: 13,
            cursor: status.kind === 'publishing' ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
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
  rampWidth,
  rampLength,
  rampGradePct,
  rampYawDegrees,
  rampMode,
  rampStrength,
  rampTargetHeight,
  rampTargetEdge,
  rampTargetKind,
  rampSideFalloff,
  rampStartFalloff,
  rampEndFalloff,
  onSelect,
  onTerrainEditStart,
  onTerrainEditEnd,
  onTransformStart,
  onTransformEnd,
  onTransformPositionChange,
  onTransformRotationChange,
  onTransformHalfExtentsChange,
  onTransformRadiusChange,
  onPaint,
  onMaterialPaint,
  paintMaterial,
  terrainMaterials,
  onAddTile,
  onDeleteTile,
  onApplyRamp,
  activeCustomStencil,
  activeCustomParams,
  onApplyCustomStencil,
  onCanvasReady,
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
  paintMaterial: number;
  terrainMaterials: TerrainMaterial[];
  rampWidth: number;
  rampLength: number;
  rampGradePct: number;
  rampYawDegrees: number;
  rampMode: 'raise' | 'lower';
  rampStrength: number;
  rampTargetHeight: number;
  rampTargetEdge: 'start' | 'end';
  rampTargetKind: 'min' | 'max';
  rampSideFalloff: number;
  rampStartFalloff: number;
  rampEndFalloff: number;
  onSelect: (next: SelectedTarget) => void;
  onTerrainEditStart: () => void;
  onTerrainEditEnd: () => void;
  onTransformStart: () => void;
  onTransformEnd: () => void;
  onTransformPositionChange: (nextPosition: Vec3) => void;
  onTransformRotationChange: (nextRotation: Quaternion) => void;
  onTransformHalfExtentsChange: (nextHalfExtents: Vec3) => void;
  onTransformRadiusChange: (nextRadius: number) => void;
  onPaint: (x: number, z: number) => void;
  onMaterialPaint: (x: number, z: number) => void;
  onAddTile: (tileX: number, tileZ: number) => void;
  onDeleteTile: (tileX: number, tileZ: number) => void;
  onApplyRamp: (x: number, z: number) => void;
  activeCustomStencil: CustomStencilDefinition | null;
  activeCustomParams: Record<string, unknown>;
  onApplyCustomStencil: (x: number, z: number) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement | null) => void;
}) {
  const paintingRef = useRef(false);
  const brushCursorRef = useRef<THREE.Mesh>(null);
  const terrainPointerRef = useRef<Vec3 | null>(null);
  const objectRefs = useRef(new Map<string, THREE.Object3D>());
  const resizeOriginRef = useRef<{ halfExtents?: Vec3; radius?: number } | null>(null);
  const [hoveredTerrainTile, setHoveredTerrainTile] = useState<TerrainTileCoordinate | null>(null);
  const [terrainPointerPoint, setTerrainPointerPoint] = useState<Vec3 | null>(null);
  const [isRampApplying, setIsRampApplying] = useState(false);
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
    const nextPoint: Vec3 = [event.point.x, event.point.y, event.point.z];
    terrainPointerRef.current = nextPoint;
    if (brushCursorRef.current) {
      brushCursorRef.current.position.set(event.point.x, event.point.y + 0.06, event.point.z);
    }
    if (terrainToolMode === 'ramp' || terrainToolMode.startsWith('custom:')) {
      setTerrainPointerPoint(nextPoint);
    }
    if (terrainToolMode === 'delete-tile') {
      const tileX = event.object.userData?.terrainTileX;
      const tileZ = event.object.userData?.terrainTileZ;
      if (typeof tileX === 'number' && typeof tileZ === 'number') {
        setHoveredTerrainTile({ tileX, tileZ });
      }
    }
  }, [terrainToolMode]);

  const handleTerrainPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const nextPoint: Vec3 = [event.point.x, event.point.y, event.point.z];
    terrainPointerRef.current = nextPoint;
    const tileX = event.object.userData?.terrainTileX;
    const tileZ = event.object.userData?.terrainTileZ;
    if (tool === 'terrain' && terrainToolMode === 'sculpt') {
      onTerrainEditStart();
      paintingRef.current = true;
      onPaint(event.point.x, event.point.z);
      return;
    }
    if (tool === 'terrain' && terrainToolMode === 'ramp') {
      onTerrainEditStart();
      setIsRampApplying(true);
      setTerrainPointerPoint(nextPoint);
      onApplyRamp(event.point.x, event.point.z);
      return;
    }
    if (tool === 'terrain' && terrainToolMode.startsWith('custom:')) {
      onTerrainEditStart();
      setIsRampApplying(true);
      setTerrainPointerPoint(nextPoint);
      onApplyCustomStencil(event.point.x, event.point.z);
      return;
    }
    if (tool === 'terrain' && terrainToolMode === 'delete-tile' && typeof tileX === 'number' && typeof tileZ === 'number') {
      setHoveredTerrainTile({ tileX, tileZ });
      onDeleteTile(tileX, tileZ);
      setHoveredTerrainTile(null);
      return;
    }
    if (tool === 'paint') {
      onTerrainEditStart();
      paintingRef.current = true;
      onMaterialPaint(event.point.x, event.point.z);
      return;
    }
    onSelect(null);
  }, [onApplyCustomStencil, onApplyRamp, onDeleteTile, onMaterialPaint, onPaint, onSelect, onTerrainEditStart, terrainToolMode, tool]);

  const handleTerrainPointerUp = useCallback(() => {
    const wasEditing = paintingRef.current || isRampApplying;
    paintingRef.current = false;
    setIsRampApplying(false);
    if (wasEditing) {
      onTerrainEditEnd();
    }
  }, [isRampApplying, onTerrainEditEnd]);

  const handleTerrainPointerOut = useCallback(() => {
    if (terrainToolMode === 'delete-tile') {
      return;
    }
    const wasEditing = paintingRef.current || isRampApplying;
    setHoveredTerrainTile(null);
    setTerrainPointerPoint(null);
    terrainPointerRef.current = null;
    paintingRef.current = false;
    setIsRampApplying(false);
    if (wasEditing) {
      onTerrainEditEnd();
    }
  }, [isRampApplying, onTerrainEditEnd, terrainToolMode]);

  const registerSelectableObject = useCallback((key: string, object: THREE.Object3D | null) => {
    if (object) {
      objectRefs.current.set(key, object);
      return;
    }
    objectRefs.current.delete(key);
  }, []);

  const handleTransformMouseDown = useCallback(() => {
    onTransformStart();
    if (transformMode !== 'scale' || !selectedTransformEntity) {
      resizeOriginRef.current = null;
      return;
    }
    resizeOriginRef.current = {
      halfExtents: selectedTransformEntity.halfExtents ? [...selectedTransformEntity.halfExtents] as Vec3 : undefined,
      radius: selectedTransformEntity.radius,
    };
  }, [onTransformStart, selectedTransformEntity, transformMode]);

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
      onTransformEnd();
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
    onTransformEnd();
  }, [
    onTransformEnd,
    onTransformHalfExtentsChange,
    onTransformRadiusChange,
    selectedObject,
    selectedTransformEntity,
    transformMode,
  ]);

  useEffect(() => () => {
    paintingRef.current = false;
    onTerrainEditEnd();
  }, [onTerrainEditEnd]);

  useEffect(() => {
    if (tool !== 'terrain' && tool !== 'paint') {
      return;
    }
    const interval = window.setInterval(() => {
      const point = terrainPointerRef.current;
      if (!point) {
        return;
      }
      if (tool === 'paint' && paintingRef.current) {
        onMaterialPaint(point[0], point[2]);
        return;
      }
      if (terrainToolMode === 'sculpt' && paintingRef.current) {
        onPaint(point[0], point[2]);
        return;
      }
      if (terrainToolMode === 'ramp' && isRampApplying) {
        onApplyRamp(point[0], point[2]);
        return;
      }
      if (terrainToolMode.startsWith('custom:') && isRampApplying) {
        onApplyCustomStencil(point[0], point[2]);
      }
    }, 80);
    return () => window.clearInterval(interval);
  }, [isRampApplying, onApplyCustomStencil, onApplyRamp, onMaterialPaint, onPaint, terrainToolMode, tool]);

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
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      style={{ width: '100%', height: '100%' }}
      onPointerUp={handleTerrainPointerUp}
      onPointerMissed={() => {
        const wasEditing = paintingRef.current || isRampApplying;
        setHoveredTerrainTile(null);
        setTerrainPointerPoint(null);
        terrainPointerRef.current = null;
        paintingRef.current = false;
        setIsRampApplying(false);
        if (wasEditing) {
          onTerrainEditEnd();
        }
      }}
    >
      {onCanvasReady && <CanvasDomBinder onReady={onCanvasReady} />}
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
      {tool === 'terrain' && terrainToolMode === 'ramp' && terrainPointerPoint && (
        <RampStencilPreview
          world={world}
          centerX={terrainPointerPoint[0]}
          centerZ={terrainPointerPoint[2]}
          width={rampWidth}
          length={rampLength}
          gradePct={rampGradePct}
          yawRad={(rampYawDegrees * Math.PI) / 180}
          mode={rampMode}
          rampStrength={rampStrength}
          targetHeight={rampTargetHeight}
          targetEdge={rampTargetEdge}
          targetKind={rampTargetKind}
          sideFalloffM={rampSideFalloff}
          startFalloffM={rampStartFalloff}
          endFalloffM={rampEndFalloff}
        />
      )}
      {tool === 'terrain' && activeCustomStencil && terrainPointerPoint && (
        <CustomStencilPreview
          world={world}
          stencilDef={activeCustomStencil}
          params={activeCustomParams}
          centerX={terrainPointerPoint[0]}
          centerZ={terrainPointerPoint[2]}
        />
      )}
      <DestructibleAuthoringPreview
        world={world}
        selected={selected}
        onSelect={onSelect}
        registerSelectableObject={registerSelectableObject}
      />
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
              <boxGeometry args={scaleExtents(
                entity.halfExtents
                ?? (entity.kind === 'vehicle' ? previewVehicleHalfExtents(entity.vehicleType) : [0.5, 0.5, 0.5]),
              )} />
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
      {tool === 'paint' && (
        <mesh ref={brushCursorRef} rotation-x={-Math.PI / 2}>
          <ringGeometry args={[Math.max(brushRadius - 0.3, 0.1), brushRadius, 64]} />
          <meshBasicMaterial color={terrainMaterials[paintMaterial]?.color ?? '#ffffff'} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}
      <OrbitControls makeDefault enabled={tool === 'select'} maxDistance={180} target={[0, 0, 0]} />
    </Canvas>
  );
}

// Exposes the underlying R3F canvas (via useThree) to the outer component so
// we can grab pixel data for screenshots. Must live inside the <Canvas>.
function CanvasDomBinder({ onReady }: { onReady: (canvas: HTMLCanvasElement | null) => void }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const canvas = gl?.domElement ?? null;
    onReady(canvas);
    return () => {
      onReady(null);
    };
  }, [gl, onReady]);
  return null;
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

function RampStencilPreview({
  world,
  centerX,
  centerZ,
  width,
  length,
  gradePct,
  yawRad,
  mode,
  rampStrength,
  targetHeight,
  targetEdge,
  targetKind,
  sideFalloffM,
  startFalloffM,
  endFalloffM,
}: {
  world: WorldDocument;
  centerX: number;
  centerZ: number;
  width: number;
  length: number;
  gradePct: number;
  yawRad: number;
  mode: 'raise' | 'lower';
  rampStrength: number;
  targetHeight: number;
  targetEdge: 'start' | 'end';
  targetKind: 'min' | 'max';
  sideFalloffM: number;
  startFalloffM: number;
  endFalloffM: number;
}) {
  const { startHeight, endHeight, lowHeight, highHeight } = useMemo(() => getTerrainRampEndpointHeights({
    length,
    gradePct,
    targetHeight,
    targetEdge,
    targetKind,
  }), [gradePct, length, targetEdge, targetHeight, targetKind]);
  const coreGeometry = useMemo(() => {
    const nextGeometry = new THREE.BufferGeometry();
    const halfWidth = width * 0.5;
    const halfLength = length * 0.5;
    const positions = new Float32Array([
      -halfWidth, startHeight + 0.08, -halfLength,
      halfWidth, startHeight + 0.08, -halfLength,
      -halfWidth, endHeight + 0.08, halfLength,
      halfWidth, endHeight + 0.08, halfLength,
    ]);
    const indices = [0, 2, 1, 1, 2, 3];
    nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    nextGeometry.setIndex(indices);
    nextGeometry.computeVertexNormals();
    return nextGeometry;
  }, [endHeight, length, startHeight, width]);
  const volumeGeometry = useMemo(() => {
    const nextGeometry = new THREE.BufferGeometry();
    const halfWidth = width * 0.5;
    const halfLength = length * 0.5;
    const alongSegments = Math.max(6, Math.round(length));
    const acrossSegments = Math.max(3, Math.round(width / 2));
    const positions: number[] = [];
    const indices: number[] = [];

    const appendQuad = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
    ) => {
      const base = positions.length / 3;
      positions.push(...a, ...b, ...c, ...d);
      indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    };

    const toWorld = (localX: number, localZ: number): [number, number] => {
      const cos = Math.cos(yawRad);
      const sin = Math.sin(yawRad);
      return [
        centerX + localX * cos + localZ * sin,
        centerZ - localX * sin + localZ * cos,
      ];
    };
    const topYAt = (localZ: number): number => {
      const along01 = (localZ + halfLength) / Math.max(length, 0.001);
      return startHeight + (endHeight - startHeight) * along01 + 0.08;
    };
    const bottomYAt = (localX: number, localZ: number): number => {
      const [worldX, worldZ] = toWorld(localX, localZ);
      return sampleTerrainHeightAtWorldPosition(world, worldX, worldZ) + 0.02;
    };

    for (let step = 0; step < alongSegments; step += 1) {
      const z0 = -halfLength + (length * step) / alongSegments;
      const z1 = -halfLength + (length * (step + 1)) / alongSegments;
      appendQuad(
        [-halfWidth, bottomYAt(-halfWidth, z0), z0],
        [-halfWidth, topYAt(z0), z0],
        [-halfWidth, bottomYAt(-halfWidth, z1), z1],
        [-halfWidth, topYAt(z1), z1],
      );
      appendQuad(
        [halfWidth, topYAt(z0), z0],
        [halfWidth, bottomYAt(halfWidth, z0), z0],
        [halfWidth, topYAt(z1), z1],
        [halfWidth, bottomYAt(halfWidth, z1), z1],
      );
    }

    for (let step = 0; step < acrossSegments; step += 1) {
      const x0 = -halfWidth + (width * step) / acrossSegments;
      const x1 = -halfWidth + (width * (step + 1)) / acrossSegments;
      appendQuad(
        [x0, topYAt(-halfLength), -halfLength],
        [x0, bottomYAt(x0, -halfLength), -halfLength],
        [x1, topYAt(-halfLength), -halfLength],
        [x1, bottomYAt(x1, -halfLength), -halfLength],
      );
      appendQuad(
        [x0, bottomYAt(x0, halfLength), halfLength],
        [x0, topYAt(halfLength), halfLength],
        [x1, bottomYAt(x1, halfLength), halfLength],
        [x1, topYAt(halfLength), halfLength],
      );
    }

    nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    nextGeometry.setIndex(indices);
    nextGeometry.computeVertexNormals();
    return nextGeometry;
  }, [centerX, centerZ, endHeight, length, startHeight, width, world, yawRad]);
  const guideGeometry = useMemo(() => {
    const nextGeometry = new THREE.BufferGeometry();
    const halfWidth = width * 0.5;
    const halfLength = length * 0.5;
    const guidePoints: number[] = [];
    const sampleColumns = [-halfWidth, 0, halfWidth];
    const sampleRows = [-halfLength, 0, halfLength];
    const cos = Math.cos(yawRad);
    const sin = Math.sin(yawRad);
    const topYAt = (localZ: number): number => {
      const along01 = (localZ + halfLength) / Math.max(length, 0.001);
      return startHeight + (endHeight - startHeight) * along01 + 0.08;
    };

    for (const localX of sampleColumns) {
      for (const localZ of sampleRows) {
        const worldX = centerX + localX * cos + localZ * sin;
        const worldZ = centerZ - localX * sin + localZ * cos;
        const bottomY = sampleTerrainHeightAtWorldPosition(world, worldX, worldZ) + 0.02;
        guidePoints.push(localX, bottomY, localZ, localX, topYAt(localZ), localZ);
      }
    }

    nextGeometry.setAttribute('position', new THREE.Float32BufferAttribute(guidePoints, 3));
    return nextGeometry;
  }, [centerX, centerZ, endHeight, length, startHeight, width, world, yawRad]);
  const outerWidth = width + sideFalloffM * 2;
  const outerLength = length + startFalloffM + endFalloffM;
  const outerCenterOffsetZ = (endFalloffM - startFalloffM) * 0.5;

  useEffect(() => () => coreGeometry.dispose(), [coreGeometry]);
  useEffect(() => () => volumeGeometry.dispose(), [volumeGeometry]);
  useEffect(() => () => guideGeometry.dispose(), [guideGeometry]);

  return (
    <group position={[centerX, 0, centerZ]} rotation-y={yawRad}>
      <mesh
        position={[0, (mode === 'lower' ? Math.max(lowHeight, highHeight) : Math.min(lowHeight, highHeight)) + 0.02, outerCenterOffsetZ]}
        rotation-x={-Math.PI / 2}
        raycast={ignorePointerRaycast}
        renderOrder={1}
      >
        <planeGeometry args={[outerWidth, outerLength]} />
        {/* depthTest={false} in lower mode so the footprint indicator shows through terrain */}
        <meshBasicMaterial color={mode === 'raise' ? 0x4ca5ff : 0xffb25c} transparent opacity={0.08 + rampStrength * 0.1} side={THREE.DoubleSide} depthWrite={false} depthTest={mode === 'raise'} />
      </mesh>
      <mesh geometry={volumeGeometry} raycast={ignorePointerRaycast} renderOrder={2}>
        {/* depthTest={false} in lower mode so the volume walls are visible through terrain */}
        <meshBasicMaterial color={mode === 'raise' ? 0x3f8ee8 : 0xe2a145} transparent opacity={0.16 + rampStrength * 0.12} side={THREE.DoubleSide} depthWrite={false} depthTest={mode === 'raise'} />
      </mesh>
      <mesh geometry={coreGeometry} raycast={ignorePointerRaycast} renderOrder={2}>
        {/* depthTest={false} in lower mode so the ramp surface is visible through terrain */}
        <meshBasicMaterial color={mode === 'raise' ? 0x75c8ff : 0xffc977} transparent opacity={0.25 + rampStrength * 0.2} side={THREE.DoubleSide} depthWrite={false} depthTest={mode === 'raise'} />
      </mesh>
      <lineSegments geometry={guideGeometry} raycast={ignorePointerRaycast} renderOrder={4}>
        <lineBasicMaterial color={mode === 'raise' ? 0xe7f5ff : 0xfff0d2} transparent opacity={0.9} />
      </lineSegments>
      <lineSegments raycast={ignorePointerRaycast} renderOrder={3}>
        <edgesGeometry args={[coreGeometry]} />
        <lineBasicMaterial color={mode === 'raise' ? 0xc7ebff : 0xffe0a6} transparent opacity={0.95} />
      </lineSegments>
      <group position={[0, Math.max(lowHeight, highHeight) + 0.5, outerCenterOffsetZ]}>
        <mesh raycast={ignorePointerRaycast} position={[0, 0, outerLength * 0.18]}>
          <boxGeometry args={[0.14, 0.14, Math.max(length * 0.5, 2)]} />
          <meshBasicMaterial color={mode === 'raise' ? 0xd7f0ff : 0xffefc7} />
        </mesh>
        <mesh raycast={ignorePointerRaycast} position={[0, 0, outerLength * 0.48]}>
          <coneGeometry args={[0.35, 0.8, 12]} />
          <meshBasicMaterial color={mode === 'raise' ? 0xd7f0ff : 0xffefc7} />
        </mesh>
      </group>
    </group>
  );
}

function ignorePointerRaycast(): void {}

function describeRampTool(
  length: number,
  gradePct: number,
  targetHeight: number,
  targetEdge: 'start' | 'end',
  targetKind: 'min' | 'max',
  mode: 'raise' | 'lower',
): string {
  const { startHeight, endHeight } = getTerrainRampEndpointHeights({
    length,
    gradePct,
    targetHeight,
    targetEdge,
    targetKind,
  });
  const targetLabel = `${targetEdge} edge targets ${targetKind} ${targetHeight.toFixed(1)}m`;
  const resolvedLabel = `${targetEdge === 'start' ? 'end' : 'start'} edge resolves near ${(targetEdge === 'start' ? endHeight : startHeight).toFixed(1)}m`;
  const movementLabel = mode === 'raise'
    ? 'Raise only lifts terrain toward that profile.'
    : 'Cut only lowers terrain toward that profile.';
  return `${targetLabel}; ${resolvedLabel}. ${movementLabel}`;
}

function EditorFields({
  title,
  position,
  onPositionChange,
  dimensions,
  onDimensionsChange,
  radius,
  onRadiusChange,
  vehicleType,
  vehicleTypeOptions,
  onVehicleTypeChange,
  yawDegrees,
  onYawChange,
  onDelete,
  children,
}: {
  title: string;
  position: [number, number, number];
  onPositionChange: (axis: 0 | 1 | 2, value: number) => void;
  dimensions?: [number, number, number];
  onDimensionsChange?: (axis: 0 | 1 | 2, value: number) => void;
  radius?: number;
  onRadiusChange?: (value: number) => void;
  vehicleType?: number;
  vehicleTypeOptions?: Array<{ value: number; label: string }>;
  onVehicleTypeChange?: (value: number) => void;
  yawDegrees?: number;
  onYawChange?: (value: number) => void;
  onDelete: () => void;
  children?: React.ReactNode;
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
      {vehicleType != null && vehicleTypeOptions && onVehicleTypeChange && (
        <label style={fieldLabelStyle}>
          Vehicle Type
          <select value={vehicleType} onChange={(event) => onVehicleTypeChange(Number(event.target.value))}>
            {vehicleTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {yawDegrees != null && onYawChange && (
        <label style={fieldLabelStyle}>
          Yaw
          <input type="number" step="1" value={yawDegrees} onChange={(event) => onYawChange(Number(event.target.value))} />
        </label>
      )}
      {children}
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

function previewVehicleHalfExtents(vehicleType?: number): [number, number, number] {
  const halfExtents = getSharedVehicleDefinition(vehicleType).chassisHalfExtents;
  return [halfExtents.x, halfExtents.y, halfExtents.z];
}

function scaleExtents(extents: [number, number, number]): [number, number, number] {
  return [extents[0] * 2, extents[1] * 2, extents[2] * 2];
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'world';
}

const pageStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '340px minmax(0, 1fr) 380px',
  height: '100vh',
  background: 'linear-gradient(180deg, #0d1824 0%, #060a10 100%)',
  color: '#eef7ff',
  overflow: 'hidden',
};

const sidebarStyle: CSSProperties = {
  borderRight: '1px solid rgba(141, 186, 221, 0.14)',
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  minHeight: 0,
  overflowY: 'auto',
  background: 'rgba(3, 8, 14, 0.92)',
};

const viewportStyle: CSSProperties = {
  position: 'relative',
  minHeight: 0,
  height: '100vh',
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
  fontWeight: 700,
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

const undoRedoViewportOverlayStyle: CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
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
  pointerEvents: 'none',
};
