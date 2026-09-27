// Garage destruction debugging: what PhysX and the stress stage hold for the
// destructible car, polled from /vehicle-assets/session/:id/debug. The page
// overlay writes it, the scene layer draws it; both subscribe here so a 10 Hz
// poll never re-renders the game page.
import { useSyncExternalStore } from 'react';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
export interface DebugHull { part: number; ordinal: number; actor: number; rest: V3; restRotation: Q4; position: V3; rotation: Q4; filter: [number, number]; authoredWord1: number; terrainExcluded: boolean }
export interface DebugActor { actor: number; position: V3; rotation: Q4; centerOfMass: V3; mass: number; linearVelocity: V3; angularVelocity: V3; sleeping: boolean; kinematic: boolean; gravityDisabled: boolean; shapes: number }
export interface DebugBond { index: number; a: number; b: number; area: number; utilisation: number; compression: number; tension: number; shear: number; damage: number; remainingArea: number; broken: boolean }
export interface DestructionDebug {
  configured: boolean; steps: number; rejectedSteps: number; brokenBonds: number; serverTick: number;
  lastStatus: { error: number; converged: boolean; iterations: number } | null;
  vehicle: { wheelMask: number; driveMask: number; engineConnected: boolean };
  hulls: DebugHull[]; actors: DebugActor[]; bonds: DebugBond[]; events: { step: number; text: string }[];
}
/** The prepared assembly as the server loaded it (metadata.json). */
export interface AssemblyPart { id: string; name: string; position: V3; massProperties: { center: V3 }; shapes: { position: V3; vertices: V3[] }[] }
export interface Assembly { parts: AssemblyPart[]; bonds: { a: string; b: string; centroid: V3 }[] }

export interface DebugLayers { colliders: boolean; bonds: boolean; centers: boolean; hideVisuals: boolean }
interface State { layers: DebugLayers; data: DestructionDebug | null; assembly: Assembly | null; selectedPart: number | null }

let state: State = { layers: { colliders: false, bonds: false, centers: false, hideVisuals: false }, data: null, assembly: null, selectedPart: null };
const listeners = new Set<() => void>();
export function updateDebug(patch: Partial<State>) { state = { ...state, ...patch }; listeners.forEach(l => l()); }
export function debugState(): State { return state; }
export function useDebugState(): State {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);
}
export function anyDebugLayer(layers: DebugLayers) { return layers.colliders || layers.bonds || layers.centers || layers.hideVisuals; }

/** Carrier is green; fragments get well-separated hues. */
export function actorColor(actor: number): string {
  if (actor === 0) return '#38e070';
  if (actor === 0xffffffff) return '#ffffff';
  return `hsl(${(actor * 137.508 + 200) % 360} 90% 60%)`;
}
