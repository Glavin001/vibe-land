import type { VehicleConfiguration } from './configuration.mjs';
export interface PreparationIssue { code: string; message: string; recovery: string; fields: {key: keyof VehicleConfiguration['dimensions']; label: string; value: number}[] }
export function preparationIssue(error: unknown, configuration: unknown): PreparationIssue;
export function validateVehicleAssembly(configuration: unknown, progress?: (phase: string, percent: number) => void): Promise<any>;
