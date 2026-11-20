import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  listPDFAnnotations,
  updateAnnotation,
} from '../services/annotations';

export function useReaderAnnotations({ sourcePath, artifactId, sourceRevision = '', pdfMode = false, ready, authenticated, onRequireAuth }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const contextGeneration = useRef(0);
  const loadSequence = useRef(0);
  const mutationVersion = useRef(0);
  const activeWrite = useRef(null);
  // Docling metadata can arrive after the PDF is interactive. In PDF mode it
  // must not invalidate an in-flight write tied to the PDF revision instead.
  const annotationIdentity = pdfMode ? sourceRevision : artifactId;

  useEffect(() => {
    contextGeneration.current += 1;
    activeWrite.current = null;
    setSaving(false);
    return () => {
      contextGeneration.current += 1;
      activeWrite.current = null;
    };
  }, [annotationIdentity, authenticated, pdfMode, ready, sourcePath]);

  const beginWrite = useCallback(() => {
    // React may not have committed the disabled state before a second click.
    if (activeWrite.current) return null;
    const token = { generation: contextGeneration.current };
    activeWrite.current = token;
    setSaving(true);
    setError('');
    return token;
  }, []);

  const finishWrite = useCallback((token) => {
    if (activeWrite.current !== token) return;
    activeWrite.current = null;
    setSaving(false);
  }, []);

  const load = useCallback(async function loadAnnotations(signal, preserveItems = false) {
    const generation = contextGeneration.current;
    const sequence = ++loadSequence.current;
    const version = mutationVersion.current;
    const current = () => generation === contextGeneration.current && sequence === loadSequence.current && !signal?.aborted;
    if (!ready || !sourcePath || !annotationIdentity || !authenticated) {
      setItems([]);
      setLoading(false);
      setError('');
      return;
    }
    if (!preserveItems) setItems([]);
    setLoading(true);
    setError('');
    // A list requested before a successful write can be stale by the time it
    // arrives. Reload after that write instead of erasing the local result.
    const refreshAfterMutation = () => {
      if (!current() || version === mutationVersion.current) return false;
      void loadAnnotations(signal, true);
      return true;
    };
    try {
      const payload = pdfMode
        ? await listPDFAnnotations(sourcePath, annotationIdentity, signal)
        : await listAnnotations(sourcePath, annotationIdentity, signal);
      if (current() && !refreshAfterMutation()) {
        setItems(Array.isArray(payload.items) ? payload.items : []);
        if (payload.warning) setError(payload.warning);
      }
    } catch (reason) {
      if (current() && !refreshAfterMutation() && reason.name !== 'AbortError') setError(reason.message || 'Annotations indisponibles.');
    } finally {
      if (current()) setLoading(false);
    }
  }, [annotationIdentity, authenticated, pdfMode, ready, sourcePath]);

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
    if (!ready || !annotationIdentity || !anchor) return null;
    const token = beginWrite();
    if (!token) return null;
    const { generation } = token;
    try {
      const payload = await createAnnotation({
        sourcePath,
        ...(pdfMode ? { sourceRevision: annotationIdentity } : { artifactId: annotationIdentity }),
        anchor,
        kind,
        color,
        body,
      });
      if (generation !== contextGeneration.current) return null;
      const item = payload.item;
      if (item?.id) {
        mutationVersion.current += 1;
        setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)]);
      }
      return item || null;
    } catch (reason) {
      if (generation !== contextGeneration.current) return null;
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non enregistrée.');
      return null;
    } finally {
      finishWrite(token);
    }
  }, [annotationIdentity, authenticated, beginWrite, finishWrite, onRequireAuth, pdfMode, ready, sourcePath]);

  const update = useCallback(async (id, patch) => {
    if (!authenticated) {
      onRequireAuth?.();
      return null;
    }
    const token = beginWrite();
    if (!token) return null;
    const { generation } = token;
    try {
      const payload = await updateAnnotation(id, patch);
      if (generation !== contextGeneration.current) return null;
      const item = payload.item;
      if (item?.id) {
        mutationVersion.current += 1;
        setItems((current) => current.map((entry) => {
          if (entry.id !== id) return entry;
          const stillNeedsReview = entry.status === 'needs-review' && (
            pdfMode ? (entry.legacy || entry.sourceRevision !== annotationIdentity) : entry.artifactId !== annotationIdentity
          );
          const status = stillNeedsReview ? 'needs-review' : item.status;
          return { ...entry, ...item, status };
        }));
      }
      return item || null;
    } catch (reason) {
      if (generation !== contextGeneration.current) return null;
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non modifiée.');
      return null;
    } finally {
      finishWrite(token);
    }
  }, [annotationIdentity, authenticated, beginWrite, finishWrite, onRequireAuth, pdfMode]);

  const remove = useCallback(async (id) => {
    if (!authenticated) {
      onRequireAuth?.();
      return false;
    }
    const token = beginWrite();
    if (!token) return false;
    const { generation } = token;
    try {
      await deleteAnnotation(id);
      if (generation !== contextGeneration.current) return false;
      mutationVersion.current += 1;
      setItems((current) => current.filter((entry) => entry.id !== id));
      return true;
    } catch (reason) {
      if (generation !== contextGeneration.current) return false;
      if (reason.status === 401) onRequireAuth?.();
      setError(reason.message || 'Annotation non supprimée.');
      return false;
    } finally {
      finishWrite(token);
    }
  }, [authenticated, beginWrite, finishWrite, onRequireAuth]);

  const reload = useCallback(() => load(undefined, true), [load]);

  return { items, loading, saving, error, create, update, remove, reload };
}
