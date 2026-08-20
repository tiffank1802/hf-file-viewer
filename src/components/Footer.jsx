import { FiArrowUp, FiExternalLink, FiHeart } from 'react-icons/fi';
import { BUCKET_URL } from '../config';

export default function Footer() {
  return (
    <footer className="site-footer" id="about">
      <div className="footer-top">
        <div className="footer-brand-block">
          <img src="/assets/centrale-lyon-enise.webp" alt="Centrale Lyon ENISE" />
          <p>Une bibliothèque collaborative pensée pour retrouver l’essentiel, réviser plus sereinement et faire circuler le savoir.</p>
        </div>
        <div className="footer-partnership">
          <span>Un pont académique</span>
          <div>
            <img src="/assets/enspy.png" alt="ENSPY" />
            <i aria-hidden="true" />
            <img src="/assets/cameroon-flag.svg" alt="Cameroun" />
          </div>
          <p>ENSPY · Yaoundé &nbsp;—&nbsp; Centrale Lyon ENISE · Saint-Étienne</p>
        </div>
        <div className="footer-links">
          <span>Ressources</span>
          <a href={BUCKET_URL} target="_blank" rel="noreferrer">Dépôt Hugging Face <FiExternalLink aria-hidden="true" /></a>
          <a href="https://www.ec-lyon.fr/" target="_blank" rel="noreferrer">Centrale Lyon <FiExternalLink aria-hidden="true" /></a>
          <a href="https://polytechnique.cm/" target="_blank" rel="noreferrer">ENSPY <FiExternalLink aria-hidden="true" /></a>
        </div>
      </div>
      <div className="footer-bottom">
        <p>Projet étudiant indépendant et non officiel. Les marques et documents appartiennent à leurs ayants droit.</p>
        <span>Fait avec <FiHeart aria-label="soin" /> entre le Cameroun et la France.</span>
        <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          Haut de page <FiArrowUp aria-hidden="true" />
        </button>
      </div>
      <span className="footer-stripe" aria-hidden="true"><i /><i /><i /></span>
    </footer>
  );
}
