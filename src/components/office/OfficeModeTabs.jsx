/**
 * Sélecteur de mode d’aperçu pour les documents Office.
 *
 * `modes` : [{ id: 'local' | 'pdf' | 'microsoft', label, hint }].
 * Le style reprend les pastilles existantes de la modale d’aperçu.
 */
export default function OfficeModeTabs({ modes, active, onChange }) {
  if (!modes || modes.length < 2) return null;

  return (
    <div className="office-modes" role="tablist" aria-label="Mode d’aperçu du document">
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          role="tab"
          aria-selected={active === mode.id}
          className={active === mode.id ? 'is-active' : ''}
          title={mode.hint || mode.label}
          onClick={() => onChange(mode.id)}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}
