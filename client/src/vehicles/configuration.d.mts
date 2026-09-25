export type VehicleModel = 'buggy' | 'trophy' | 'rally' | 'monster' | 'derby' | 'sprint' | 'semi';
export interface VehicleConfiguration {
  version: 1;
  generatorVersion: 'dune-3';
  model: VehicleModel;
  dimensions: { wheelbase: number; track: number; tireRadius: number; cageHeight: number };
  finish: string;
}
export interface VehiclePreset { id: VehicleModel; name: string; code: string; kind: string; description: string; color: string; parameters: VehicleConfiguration['dimensions'] }
export const vehicles: VehiclePreset[];
export const dimensionKeys: (keyof VehicleConfiguration['dimensions'])[];
export const CONFIGURATION_VERSION: 1;
export const GENERATOR_VERSION: 'dune-3';
export function vehicleFields(id: string): [keyof VehicleConfiguration['dimensions'], string, number, number, number, string][];
export function defaultConfiguration(model?: VehicleModel): VehicleConfiguration;
export function normalizeConfiguration(value: unknown): VehicleConfiguration;
export function serializeConfiguration(value: unknown): string;
export function geometryKey(value: unknown): string;
export function modelParameters(value: unknown): Record<string, number | string>;
export function sourceToActorPoint(point: number[], originHeight?: number): number[];
export const sourceCornerForWheel: string[];
export function resolveVehicleGeometry(value: unknown): {
 configuration: VehicleConfiguration; parameters: Record<string, number | string>; originHeight: number;
 rig: any; wheelCenters: number[][]; suspensionTravel: number; neutralJounce: number;
 compression: number; extension: number; suspensionAttachmentY: number; wheelHalfWidth: number; maxSteerRadians: number;
};
