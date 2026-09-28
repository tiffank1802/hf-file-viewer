import { useEffect, useState } from 'react';
import { FiEdit3, FiLogIn, FiMapPin, FiTrash2 } from 'react-icons/fi';

export default function AnnotationPanel({
  items,
  authenticated,
  loading,
  saving,
  error,
  onRequireAuth,
  onOpen,
  onUpdate,
  onDelete,
}) {
  if (!authenticated) {
    return (
      <div className="reader-annotation-empty">
        <strong>Annotations privées</strong>
        <p>Connectez-vous pour conserver vos surlignages et vos notes entre deux visites.</p>
        <button type="button" onClick={onRequireAuth}><FiLogIn aria-hidden="true" /> Se connecter</button>
      </div>
    );
  }
  if (loading) return <p className="reader-annotation-message">Chargement des annotations…</p>;

  return (
    <div className="reader-annotation-list">
      {error && <p className="reader-annotation-error" role="alert">{error}</p>}
      {items.length === 0 && !error && (
        <div className="reader-annotation-empty compact">
          <strong>Aucune annotation</strong>
          <p>Sélectionnez un passage, puis choisissez Surligner ou Ajouter une note.</p>
        </div>
      )}
      {items.map((item) => (
        <AnnotationItem
          key={item.id}
          item={item}
          saving={saving}
          onOpen={onOpen}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function AnnotationItem({ item, saving, onOpen, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body || '');
  const [color, setColor] = useState(item.color || 'yellow');
  useEffect(() => setBody(item.body || ''), [item.body]);
  useEffect(() => setColor(item.color || 'yellow'), [item.color]);
  const review = item.status === 'needs-review';

  return (
    <article className={`reader-annotation-item color-${item.color || 'yellow'}${review ? ' needs-review' : ''}`}>
      <button type="button" className="reader-annotation-target" onClick={() => onOpen(item)}>
        <span><FiMapPin aria-hidden="true" /> {item.page ? `Page ${item.page}` : 'Passage structuré'}</span>
        <small>{review ? 'À vérifier après reconversion' : item.kind === 'note' ? 'Note privée' : 'Surlignage privé'}</small>
        <blockquote>{item.anchor?.quote || 'Passage ancré dans le document'}</blockquote>
      </button>
      {editing ? (
        <form
          className="reader-annotation-edit"
          onSubmit={async (event) => {
            event.preventDefault();
            const patch = item.kind === 'note' ? { body, color } : { color };
            const updated = await onUpdate(item.id, patch);
            if (updated) setEditing(false);
          }}
        >
          {item.kind === 'note' && (
            <textarea value={body} maxLength={4000} rows={4} onChange={(event) => setBody(event.target.value)} />
          )}
          <label>
            <span>Couleur</span>
            <select value={color} onChange={(event) => setColor(event.target.value)}>
              <option value="yellow">Jaune</option>
              <option value="green">Vert</option>
              <option value="blue">Bleu</option>
              <option value="pink">Rose</option>
            </select>
          </label>
          <div><button type="button" onClick={() => {
            setBody(item.body || '');
            setColor(item.color || 'yellow');
            setEditing(false);
          }}>Annuler</button><button type="submit" disabled={saving}>Enregistrer</button></div>
        </form>
      ) : item.body ? (
        <p className="reader-annotation-body">{item.body}</p>
      ) : null}
      <footer>
        {!review && (
          <button type="button" disabled={saving} onClick={() => {
            setBody(item.body || '');
            setColor(item.color || 'yellow');
            setEditing(true);
          }}><FiEdit3 aria-hidden="true" /> Modifier</button>
        )}
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (window.confirm('Supprimer cette annotation privée ?')) void onDelete(item.id);
          }}
        ><FiTrash2 aria-hidden="true" /> Supprimer</button>
      </footer>
    </article>
  );
}
