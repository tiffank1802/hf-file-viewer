import { useEffect, useRef, useState } from 'react';
import { FiEdit3, FiX } from 'react-icons/fi';

const COLORS = [
  { id: 'yellow', label: 'Jaune' },
  { id: 'green', label: 'Vert' },
  { id: 'blue', label: 'Bleu' },
  { id: 'pink', label: 'Rose' },
];

export default function AnnotationComposer({ selection, saving, onSave, onClose }) {
  const [body, setBody] = useState('');
  const [color, setColor] = useState('yellow');
  const textareaRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    textareaRef.current?.focus();
    const dialog = dialogRef.current;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled])')];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);

  return (
    <div className="reader-note-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="reader-note-composer" role="dialog" aria-modal="true" aria-labelledby="reader-note-title">
        <header>
          <span><FiEdit3 aria-hidden="true" /><strong id="reader-note-title">Ajouter une note privée</strong></span>
          <button type="button" onClick={onClose} aria-label="Fermer"><FiX aria-hidden="true" /></button>
        </header>
        <blockquote>{selection?.anchor?.quote}</blockquote>
        <label>
          <span>Note</span>
          <textarea
            ref={textareaRef}
            value={body}
            rows={6}
            maxLength={4000}
            placeholder="Votre remarque, définition ou question…"
            onChange={(event) => setBody(event.target.value)}
          />
          <small>{Array.from(body).length} / 4 000</small>
        </label>
        <fieldset>
          <legend>Couleur du surlignage</legend>
          {COLORS.map((item) => (
            <label key={item.id} className={`reader-color color-${item.id}`} title={item.label}>
              <input type="radio" name="annotation-color" value={item.id} checked={color === item.id} onChange={() => setColor(item.id)} />
              <span>{item.label}</span>
            </label>
          ))}
        </fieldset>
        <footer>
          <button type="button" onClick={onClose}>Annuler</button>
          <button
            type="button"
            disabled={saving || !body.trim()}
            onClick={() => void onSave({ body: body.trim(), color })}
          >{saving ? 'Enregistrement…' : 'Enregistrer la note'}</button>
        </footer>
      </section>
    </div>
  );
}
