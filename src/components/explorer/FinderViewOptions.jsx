import { useEffect, useRef } from 'react';
import { FiSliders } from 'react-icons/fi';
import { LIST_COLUMNS, SORT_LABELS } from '../../utils/explorer';
import { GROUP_LABELS } from '../../utils/explorerGroups';

const SIZES = { small: 'Petite', medium: 'Moyenne', large: 'Grande' };
const TEXT = { small: 'Petit', normal: 'Standard', large: 'Grand' };
const SPACING = { compact: 'Serré', normal: 'Standard', wide: 'Large' };
const WIDTHS = { compact: 'Étroite', normal: 'Standard', wide: 'Large' };
const POSITION = { below: 'Sous l’icône', right: 'À droite de l’icône' };
const BACKGROUND = { white: 'Blanc', blue: 'Bleu clair', gray: 'Gris clair' };
const DIRECTIONS = { asc: 'Croissant', desc: 'Décroissant' };

function Choice({ label, value, options, onChange }) {
  return <label className="finder-option-choice">{label}<select value={value} onChange={(event) => onChange(event.target.value)}>
    {Object.entries(options).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
  </select></label>;
}

function Toggle({ label, checked, onChange, disabled = false }) {
  return <label><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

export default function FinderViewOptions({ settings, views, library }) {
  const { preferences, setPreference, customFolder, setCustomFolder, useAsDefaults, resetDefaults } = settings;
  const root = useRef(null);
  const summary = useRef(null);
  useEffect(() => {
    const dismiss = (event) => {
      if (root.current?.open && !root.current.contains(event.target)) root.current.open = false;
    };
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || !root.current?.open || !root.current.contains(event.target)) return;
      event.preventDefault();
      root.current.open = false;
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const choice = (key, label, options) => <Choice {...{ label, options }} value={preferences[key]} onChange={(value) => setPreference(key, value)} />;
  const toggle = (key, label, disabled) => <Toggle {...{ label, disabled }} checked={preferences[key]} onChange={(checked) => setPreference(key, checked)} />;
  const list = preferences.view === 'list';
  const icons = preferences.view === 'grid';
  return (
    <details className="finder-view-options" ref={root}>
      <summary aria-label="Options de présentation" title="Options de présentation" ref={summary}><FiSliders aria-hidden="true" /></summary>
      <div className="finder-option-panel" role="group" aria-label="Options du Finder">
        <fieldset><legend>Présentation</legend>
          {choice('view', 'Mode d’affichage', views)}
          {choice('sort', 'Critère de tri', SORT_LABELS)}
          {choice('direction', 'Ordre du tri', DIRECTIONS)}
          {(icons || list) && choice('group', 'Regroupement', GROUP_LABELS)}
          {toggle('foldersFirst', 'Dossiers en premier')}
          {choice('textSize', 'Taille du texte', TEXT)}
          {toggle('showTags', 'Afficher les tags sur les éléments')}
          {toggle('showExtensions', 'Afficher les extensions de fichier')}
        </fieldset>
        <fieldset><legend>{views[preferences.view]}</legend>
          {preferences.view === 'columns' && choice('columnWidth', 'Largeur des colonnes', WIDTHS)}
          {preferences.view === 'gallery' && <>
            {toggle('showFilmstrip', 'Afficher la bande de vignettes')}
            {preferences.showFilmstrip && choice('galleryThumbSize', 'Taille des vignettes', SIZES)}
          </>}
          {(icons || list) && choice('iconSize', 'Taille des icônes', SIZES)}
          {icons && <>
            {choice('gridSpacing', 'Espacement de la grille', SPACING)}
            {choice('labelPosition', 'Position des noms', POSITION)}
            {choice('background', 'Arrière-plan', BACKGROUND)}
            {toggle('showItemInfo', 'Afficher les informations de l’élément')}
          </>}
          {(icons || list || (preferences.view === 'gallery' && preferences.showFilmstrip)) && toggle('showIconPreview', 'Afficher les vignettes d’image')}
          {list && LIST_COLUMNS.map((field) => <Toggle key={field} label={`Colonne : ${SORT_LABELS[field]}`} checked={preferences.listColumns.includes(field)} onChange={(checked) =>
            setPreference('listColumns', LIST_COLUMNS.filter((key) => key === field ? checked : preferences.listColumns.includes(key)))} />)}
        </fieldset>
        <fieldset><legend>Volets et barres</legend>
          {toggle('showPreview', 'Afficher la prévisualisation')}
          {toggle('showPreviewDetails', 'Afficher les détails de prévisualisation', !preferences.showPreview)}
          {toggle('showSidebar', 'Afficher la barre latérale')}
          {toggle('showTabs', 'Afficher la barre d’onglets', library.tabs.length > 1)}
          {toggle('showPath', 'Afficher le fil d’Ariane')}
          {toggle('showStatus', 'Afficher la barre d’état')}
        </fieldset>
        <fieldset><legend>Réglages du dossier</legend>
          <Toggle label="Utiliser cette présentation pour ce dossier" checked={customFolder} onChange={setCustomFolder} />
          <div className="finder-option-actions">
            {customFolder && <button type="button" onClick={useAsDefaults}>Utiliser par défaut</button>}
            <button type="button" onClick={resetDefaults}>Rétablir les réglages</button>
            <button type="button" disabled={!library.canAddTab} onClick={() => { root.current.open = false; library.addTab(); }}>Nouvel onglet</button>
          </div>
        </fieldset>
      </div>
    </details>
  );
}
