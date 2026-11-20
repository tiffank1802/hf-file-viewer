import { useCallback, useEffect, useState } from 'react';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from '../services/annotations';

export function useReaderAnnotations({ sourcePath, artifactId, ready, authenticated, onRequireAuth }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (signal) => {
    if (!ready || !sourcePath || !artifactId || !authenticated) {
      setItems([]);
      setLoading(false);
      setError('');
      return;
    }
    setItems([]);
    setLoading(true);
    setError('');
    try {
      const payload = await listAnnotations(sourcePath, artifactId, signal);
      setItems(Array.isArray(payload.items) ? payload.items : []);
    } catch (reason) {
      if (reason.name !== 'AbortError') setError(reason.message || 'Annotations indisponibles.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [artifactId, authenticated, ready, sourcePath]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const create = useCallback(async ({ anchor, kind = 'highlight', color = 'yellow', body = '' }) => {
    if (!authenticated) {
      onRequireAuth?.();
      return null;
    }
    if (!ready || !artifactId || !anchor) return null;
    setSaving(true);
    setError('');
    try {
      const payload = await createAnnotation({
        sourcePath,
        artifactId,
        anchor,
        kind,
        color,
        body,
      });
      const item = payload.item;
      if (item?.id) setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
      return item || null;
    } catch (reason) {
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non enregistrée.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [artifactId, authenticated, onRequireAuth, ready, sourcePath]);

  const update = useCallback(async (id, patch) => {
    if (!authenticated) {
      onRequireAuth?.();
      return null;
    }
    setSaving(true);
    setError('');
    try {
      const payload = await updateAnnotation(id, patch);
      const item = payload.item;
      if (item?.id) setItems((current) => current.map((entry) => {
        if (entry.id !== id) return entry;
        const status = entry.status === 'needs-review' && entry.artifactId !== artifactId
          ? 'needs-review'
          : item.status;
        return { ...entry, ...item, status };
      }));
      return item || null;
    } catch (reason) {
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non modifiée.');
      return null;
    } finally {
      setSaving(false);
    }
  }, [artifactId, authenticated, onRequireAuth]);

  const remove = useCallback(async (id) => {
    if (!authenticated) {
      onRequireAuth?.();
      return false;
    }
    setSaving(true);
    setError('');
    try {
      await deleteAnnotation(id);
      setItems((current) => current.filter((entry) => entry.id !== id));
      return true;
    } catch (reason) {
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non supprimée.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [authenticated, onRequireAuth]);

  return { items, loading, saving, error, create, update, remove, reload: load };
}
