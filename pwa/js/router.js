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
import { toast } from './ui.js';

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
// d'atteinte : on réessaie jusqu'à 4 secondes.
const DUREE_MAX_RESTAURATION = 4000;
// Une fois la position atteinte, on la maintient un court instant : sur
// mobile, un chargement d'image ou la barre d'adresse escamotable peut
// encore déplacer la page juste après.
const DUREE_MAINTIEN = 1200;
// Sur mobile, un simple contact est fréquent pendant la transition (geste
// de retour par balayage, doigt encore posé). Seul un vrai défilement
// doit rendre la main, et pas dans les tout premiers instants.
const DELAI_AVANT_ABANDON = 300;

// Diagnostic activable en ouvrant l'app avec ?diag=scroll dans l'URL :
// affiche ce qui a été mémorisé puis réellement restauré. Sert à lever
// un doute sur un appareil qu'on ne peut pas inspecter directement.
const DIAGNOSTIC = typeof location !== 'undefined'
  && location.search.includes('diag=scroll');

function restaurerPosition(cible, jeton) {
  if (DIAGNOSTIC) {
    const vise = cible ? Math.round(cible) : 0;
    setTimeout(() => toast(`visé ${vise} · obtenu ${Math.round(window.scrollY)}`), 1600);
  }
  if (!cible) { window.scrollTo(0, 0); return; }
  restaurationEnCours = true;
  const debut = performance.now();
  let abandonne = false;
  let premiereArrivee = null;

  const rendreLaMain = () => {
    if (performance.now() - debut > DELAI_AVANT_ABANDON) abandonne = true;
  };
  const options = { passive: true };
  window.addEventListener('wheel', rendreLaMain, options);
  window.addEventListener('touchmove', rendreLaMain, options);

  const terminer = () => {
    restaurationEnCours = false;
    window.removeEventListener('wheel', rendreLaMain, options);
    window.removeEventListener('touchmove', rendreLaMain, options);
  };

  const tenter = () => {
    if (abandonne || jeton !== jetonNavigation) { terminer(); return; }
    const ecoule = performance.now() - debut;
    const hauteurUtile = document.documentElement.scrollHeight - window.innerHeight;
    const atteignable = Math.min(cible, Math.max(hauteurUtile, 0));
    if (Math.abs(window.scrollY - atteignable) > 4) window.scrollTo(0, atteignable);

    if (Math.abs(window.scrollY - cible) <= 4) {
      // Position tenue : on surveille encore un peu avant de lâcher.
      premiereArrivee = premiereArrivee ?? performance.now();
      if (performance.now() - premiereArrivee > DUREE_MAINTIEN) { terminer(); return; }
    } else if (ecoule > DUREE_MAX_RESTAURATION) {
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
  // Le navigateur restaure lui-même le défilement lors d'un retour
  // arrière, souvent en différé sur mobile, ce qui écrasait notre propre
  // repositionnement. On reprend la main dessus.
  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }
  window.addEventListener('hashchange', naviguer);
  // Le défilement courant est suivi en continu : au moment du changement
  // de page, la valeur est déjà connue.
  window.addEventListener('scroll', memoriserPosition, { passive: true });
  return naviguer();
}
