import { useEffect, useState } from 'react';
import { geometryKey, type VehicleConfiguration } from './configuration.mjs';
import type { PreparationIssue } from './validation.mjs';
export type ExplosionGroup = {visualIds: string[]; position: number[]};
type Result = {key: string; complete: boolean; phase?: string; issue?: PreparationIssue | null; explosionGroups?: ExplosionGroup[]};
const cache = new Map<string, Result>();
export function useVehicleValidation(configuration: VehicleConfiguration) {
  const key = geometryKey(configuration);
  const [result, setResult] = useState<Result>({key, complete: false});
  useEffect(() => {
    const cached = cache.get(key);
    if (cached) { setResult(cached); return; }
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      worker = new Worker(new URL('./validation.worker.ts', import.meta.url), {type: 'module'});
      worker.onmessage = ({data}: MessageEvent<Result>) => {
        if (data.key !== key) return;
        setResult(data);
        if (data.complete) {
          cache.set(key, data);
          if (cache.size > 24) cache.delete(cache.keys().next().value!);
          worker?.terminate();
        }
      };
      worker.onerror = () => {
        setResult({key, complete: true, issue: {code:'unavailable', message:'The local assembly check could not run. Reload the garage to retry.', recovery:'', fields:[]}});
        worker?.terminate();
      };
      worker.postMessage({key, configuration});
    }, 250);
    return () => { clearTimeout(timer); worker?.terminate(); };
    // Finish color does not affect physics and must not restart the audit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return result.key === key ? result : {key, complete:false};
}
