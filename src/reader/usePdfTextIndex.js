import { useEffect, useState } from 'react';
import { indexPDFPages } from './pdfTextIndex';

const emptyIndex = () => ({ pages: new Map(), indexedPages: 0, totalPages: 0, complete: false, truncated: false, error: '' });

export function usePdfTextIndex(pdf, revision) {
  const [index, setIndex] = useState(emptyIndex);
  useEffect(() => {
    const controller = new AbortController();
    const pages = new Map();
    setIndex(emptyIndex());
    if (!pdf || !revision) return () => controller.abort();
    void indexPDFPages(pdf, {
      signal: controller.signal,
      onPage: ({ page, text, indexedPages, totalPages, truncated }) => {
        pages.set(page, text);
        if (!controller.signal.aborted) setIndex({ pages: new Map(pages), indexedPages, totalPages, truncated, complete: false, error: '' });
      },
    }).then((result) => {
      if (!controller.signal.aborted) setIndex({ ...result, error: '' });
    }).catch(() => {
      if (!controller.signal.aborted) setIndex((current) => ({ ...current, error: 'L’indexation est interrompue ; les pages déjà lues restent disponibles.' }));
    });
    return () => controller.abort();
  }, [pdf, revision]);
  return index;
}
