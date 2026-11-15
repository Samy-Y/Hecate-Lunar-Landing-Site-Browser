import { useEffect, useState } from 'react';
import { runtime, type AppData } from '../../store/runtime';

/** Re-render when runtime data (patches, L0 levels) arrive. Returns [data, version]. */
export function useRuntimeData(): [AppData | null, number] {
  const [v, setV] = useState(0);
  useEffect(() => {
    const l = () => setV((x) => x + 1);
    runtime.dataListeners.add(l);
    return () => {
      runtime.dataListeners.delete(l);
    };
  }, []);
  return [runtime.data, v];
}
