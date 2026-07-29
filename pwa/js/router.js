// Router à hash : GitHub Pages ne réécrit pas les URL, les routes
// dynamiques deviennent #/equipe/{id}, #/match/{id}, etc.

import { pageAccueil } from './pages/accueil.js';
import { pageClassement } from './pages/classement.js';
import { pageEquipe } from './pages/equipe.js';
import { pageMatch } from './pages/match.js';
import { pageMesParis } from './pages/mes-paris.js';
import { pageProfil } from './pages/profil.js';
import { pageReglages } from './pages/reglages.js';
import { pageStats } from './pages/stats.js';

const ROUTES = [
  { motif: /^\/?$/, rendu: pageAccueil, onglet: 'paris' },
  { motif: /^\/accueil$/, rendu: pageAccueil, onglet: 'paris' },
  { motif: /^\/equipe\/([0-9a-f-]+)$/, rendu: pageEquipe, onglet: 'paris' },
  { motif: /^\/classement\/([0-9a-f-]+)$/, rendu: pageClassement, onglet: 'paris' },
  { motif: /^\/match\/([0-9a-f-]+)$/, rendu: pageMatch, onglet: 'paris' },
  { motif: /^\/mes-paris$/, rendu: pageMesParis, onglet: 'mes-paris' },
  { motif: /^\/stats$/, rendu: pageStats, onglet: 'stats' },
  { motif: /^\/profil$/, rendu: pageProfil, onglet: 'profil' },
  { motif: /^\/reglages$/, rendu: pageReglages, onglet: 'reglages' },
];

// Position de défilement mémorisée pour les listes longues : revenir
// d'une fiche de match doit ramener là où on lisait, pas tout en haut.
const LISTES = new Set(['paris', 'mes-paris', 'stats']);
const positions = new Map();
let cheminCourant = null;

// Vrai (et donc mémorisation suspendue) pendant qu'on repositionne la
// page : sans cela le défilement provoqué par la restauration écraserait
// la position qu'on cherche justement à retrouver.
let restaurationEnCours = false;
let jetonNavigation = 0;

function memoriserPosition() {
  if (cheminCourant && !restaurationEnCours) {
    positions.set(cheminCourant, window.scrollY);
  }
}

// La page se remplit en plusieurs temps : squelettes, puis données du
// réseau. Tant qu'elle est trop courte, la position visée est hors
// d'atteinte. On réessaie donc jusqu'à 4 secondes, ce qui couvre une
// réponse serveur lente, et on s'arrête net dès que l'utilisateur reprend
// la main ou qu'une autre navigation démarre.
const DUREE_MAX_RESTAURATION = 4000;

function restaurerPosition(cible, jeton) {
  if (!cible) { window.scrollTo(0, 0); return; }
  restaurationEnCours = true;
  const debut = performance.now();
  let abandonne = false;

  const rendreLaMain = () => { abandonne = true; };
  const options = { passive: true };
  window.addEventListener('wheel', rendreLaMain, options);
  window.addEventListener('touchstart', rendreLaMain, options);

  const terminer = () => {
    restaurationEnCours = false;
    window.removeEventListener('wheel', rendreLaMain, options);
    window.removeEventListener('touchstart', rendreLaMain, options);
  };

  const tenter = () => {
    if (abandonne || jeton !== jetonNavigation) { terminer(); return; }
    const hauteurUtile = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(cible, Math.max(hauteurUtile, 0)));
    const arrive = Math.abs(window.scrollY - cible) <= 4;
    if (arrive || performance.now() - debut > DUREE_MAX_RESTAURATION) {
      terminer();
      return;
    }
    setTimeout(tenter, 80);
  };
  tenter();
}

export async function naviguer() {
  const chemin = location.hash.replace(/^#/, '') || '/';
  const conteneur = document.getElementById('app');
  for (const route of ROUTES) {
    const m = chemin.match(route.motif);
    if (m) {
      memoriserPosition();
      const jeton = ++jetonNavigation;   // annule une restauration en cours
      document.querySelectorAll('#onglets a').forEach((a) => {
        a.classList.toggle('actif', a.dataset.route === route.onglet);
      });
      await route.rendu(conteneur, ...m.slice(1));
      if (jeton !== jetonNavigation) return;   // une autre navigation a pris le relais
      cheminCourant = chemin;
      restaurerPosition(LISTES.has(route.onglet) ? positions.get(chemin) : 0, jeton);
      return;
    }
  }
  conteneur.innerHTML = '<div class="vide"><span class="emoji">🤷</span>'
    + '<p>Page introuvable.</p></div>';
}

export function demarrerRouter() {
  window.addEventListener('hashchange', naviguer);
  // Le défilement courant est suivi en continu : au moment du changement
  // de page, la valeur est déjà connue.
  window.addEventListener('scroll', memoriserPosition, { passive: true });
  return naviguer();
}
