import { useEffect, useRef } from 'react';
import { summarizeWorldDiff } from '../../ai/worldDiffSummary';
import type { WorldDocument } from '../../world/worldDocument';

/**
 * Watches the world document for changes and emits a short text summary every
 * time the document changes due to a *human* edit (i.e. not an AI tool call).
 *
 * The caller passes a ref-like getter for the "is this an AI edit?" flag so the
 * tracker can ignore mutations that originated from the chat hook's own tool
 * execution path.
 */
export function useHumanEditTracker(options: {
  world: WorldDocument;
  isAiEditRef: React.MutableRefObject<boolean>;
  onHumanEdit: (summary: string) => void;
}): void {
  const { world, isAiEditRef, onHumanEdit } = options;
  const previousRef = useRef<WorldDocument | null>(null);
  const callbackRef = useRef(onHumanEdit);
  useEffect(() => {
    callbackRef.current = onHumanEdit;
  }, [onHumanEdit]);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = world;
    if (!previous) return;
    if (previous === world) return;
    if (isAiEditRef.current) return;
    const summary = summarizeWorldDiff(previous, world);
    if (summary) {
      callbackRef.current(summary);
    }
  }, [isAiEditRef, world]);
}
