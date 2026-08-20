import {
  FiArrowRight,
  FiBookOpen,
  FiCheck,
  FiCloud,
  FiFileText,
  FiFolder,
  FiHeadphones,
  FiSearch,
  FiShield,
} from 'react-icons/fi';
import { formatCount } from '../utils/files';

function indexStat(catalog, readyLabel) {
  if (!catalog || catalog.loading) return { value: '…', label: 'Indexation…' };
  if (!Number.isFinite(Number(catalog.totalFiles))) {
    return { value: '—', label: 'Nombre indisponible' };
  }
  return { value: formatCount(catalog.totalFiles), label: readyLabel };
}

export default function Hero({ onOpenSearch, navigate, catalog }) {
  const totalStat = indexStat(catalog, 'ressources indexées');
  return (
    <section className="hero-section" aria-labelledby="hero-title">
      <div className="hero-copy">
        <div className="hero-eyebrow">
          <span className="live-dot" aria-hidden="true" />
          Bibliothèque collaborative ENISE
        </div>
        <h1 id="hero-title">
          Vos cours.<br />
          <span>Un seul endroit.</span>
        </h1>
        <p className="hero-lead">
          Cours, TD, annales et ressources de génie mécanique, réunis dans un espace clair pour apprendre sans perdre de temps.
        </p>

        <button className="hero-search" type="button" onClick={onOpenSearch}>
          <span className="hero-search-icon"><FiSearch aria-hidden="true" /></span>
          <span className="hero-search-copy">
            <strong>Que voulez-vous réviser ?</strong>
            <small>Ex. thermique, calcul tensoriel, TOEIC…</small>
          </span>
          <span className="hero-search-action">Chercher <FiArrowRight aria-hidden="true" /></span>
        </button>

        <div className="hero-trust" aria-label="Infrastructure technique">
          <span><FiCloud aria-hidden="true" /> Stockage Hugging Face</span>
          <span><FiShield aria-hidden="true" /> Cache Cloudflare</span>
        </div>

        <dl className="hero-stats">
          <div>
            <dt>{totalStat.value}</dt>
            <dd>{totalStat.label}</dd>
          </div>
          <div>
            <dt>HF</dt>
            <dd>source des documents</dd>
          </div>
          <div>
            <dt>5</dt>
            <dd>espaces clés</dd>
          </div>
        </dl>
      </div>

      <div className="hero-showcase" aria-label="Aperçu de la bibliothèque">
        <div className="showcase-glow showcase-glow-green" />
        <div className="showcase-glow showcase-glow-yellow" />
        <div className="showcase-card glass-panel">
          <div className="showcase-topbar">
            <div className="showcase-brand">
              <span className="showcase-brand-icon"><FiBookOpen aria-hidden="true" /></span>
              <div>
                <strong>À portée de main</strong>
                <small>Ressources étudiantes</small>
              </div>
            </div>
            <span className="sync-pill"><span /> Synchronisé</span>
          </div>

          <button className="featured-document" type="button" onClick={() => navigate('GM/3A GM/S5/Calcul Tensoriel')}>
            <span className="featured-icon"><FiFileText aria-hidden="true" /></span>
            <span>
              <small>CALCUL TENSORIEL · PDF</small>
              <strong>Poly.pdf</strong>
              <em>787 Ko · Ajouté aujourd’hui</em>
            </span>
            <FiArrowRight aria-hidden="true" />
          </button>

          <div className="showcase-grid">
            <button type="button" onClick={() => navigate('GM/4A GM')}>
              <span className="mini-icon red"><FiFolder aria-hidden="true" /></span>
              <small>4e année GM</small>
              <strong>Parcours avancé</strong>
            </button>
            <button type="button" onClick={() => navigate('TOEIC')}>
              <span className="mini-icon yellow"><FiHeadphones aria-hidden="true" /></span>
              <small>Objectif TOEIC</small>
              <strong>Audio & tests</strong>
            </button>
          </div>

          <div className="showcase-note">
            <span className="note-check"><FiCheck aria-hidden="true" /></span>
            <p><strong>Prêt pour votre prochaine session.</strong><br />Le contenu populaire est servi depuis le cache le plus proche.</p>
          </div>
        </div>

        <div className="floating-tag floating-tag-top">
          <FiCloud aria-hidden="true" /> <span><strong>Edge cache</strong><small>moins d’appels API</small></span>
        </div>
        <div className="floating-tag floating-tag-bottom">
          <img src="/assets/cameroon-flag.svg" alt="" />
          <span><strong>De Yaoundé à Lyon</strong><small>le savoir circule</small></span>
        </div>
      </div>
    </section>
  );
}
