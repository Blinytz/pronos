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

function memoriserPosition() {
  if (cheminCourant) positions.set(cheminCourant, window.scrollY);
}

// Le contenu arrive parfois après le premier rendu (chargements en
// cascade) : on retente tant que la page n'est pas assez haute.
function restaurerPosition(cible) {
  if (!cible) { window.scrollTo(0, 0); return; }
  let essais = 0;
  const tenter = () => {
    const hauteurUtile = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.min(cible, Math.max(hauteurUtile, 0)));
    essais += 1;
    if (Math.abs(window.scrollY - cible) > 4 && essais < 12) {
      setTimeout(tenter, 60);
    }
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
      document.querySelectorAll('#onglets a').forEach((a) => {
        a.classList.toggle('actif', a.dataset.route === route.onglet);
      });
      await route.rendu(conteneur, ...m.slice(1));
      cheminCourant = chemin;
      restaurerPosition(LISTES.has(route.onglet) ? positions.get(chemin) : 0);
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
