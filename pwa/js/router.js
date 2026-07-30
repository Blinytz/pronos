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

// Quel élément défile réellement ? Cela dépend du navigateur et de la
// mise en page : la fenêtre, l'élément racine, le corps du document, ou
// un conteneur interne. Plutôt que de le supposer, on l'apprend en
// observant les événements de défilement, et on lit ou écrit la position
// sur cet élément. Sans cela, la position mesurée reste à zéro et il n'y
// a jamais rien à mémoriser.
let elementDefilant = null;

function racineDefilante() {
  return elementDefilant || document.scrollingElement || document.documentElement;
}

function estRacineDeLaPage(el) {
  return !el || el === document || el === document.scrollingElement
    || el === document.documentElement || el === document.body;
}

function positionDefilement() {
  const el = racineDefilante();
  if (estRacineDeLaPage(el)) {
    return window.scrollY
      || document.scrollingElement?.scrollTop
      || document.documentElement?.scrollTop
      || document.body?.scrollTop
      || 0;
  }
  return el.scrollTop || 0;
}

function allerA(y) {
  const el = racineDefilante();
  if (!estRacineDeLaPage(el)) { el.scrollTop = y; return; }
  window.scrollTo(0, y);
  if (Math.abs(positionDefilement() - y) > 4) {
    if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    if (document.documentElement) document.documentElement.scrollTop = y;
    if (document.body) document.body.scrollTop = y;
  }
}

function hauteurDefilable() {
  const el = racineDefilante();
  if (!estRacineDeLaPage(el)) {
    return Math.max(el.scrollHeight - el.clientHeight, 0);
  }
  const hauteurTotale = Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0,
  );
  return Math.max(hauteurTotale - window.innerHeight, 0);
}

// Identifie la source d'un défilement. Les bandeaux horizontaux (dates,
// compétitions, mises) émettent aussi cet événement : on ne retient que
// ce qui peut défiler verticalement.
function noterSourceDefilement(cible) {
  if (estRacineDeLaPage(cible)) {
    elementDefilant = document.scrollingElement || document.documentElement;
    return;
  }
  if (cible instanceof Element && cible.scrollHeight > cible.clientHeight + 8) {
    elementDefilant = cible;
  }
}

function nomSource() {
  const el = racineDefilante();
  if (estRacineDeLaPage(el)) return 'page';
  return `${el.tagName.toLowerCase()}.${(el.className || '').split(' ')[0] || '?'}`;
}

// Gelée juste après un clic sur un lien interne : certains navigateurs
// mobiles remontent la page en traitant le fragment, ce qui écraserait
// par zéro la position de lecture qu'on vient de capturer.
let memorisationGelee = false;

function memoriserPosition() {
  if (cheminCourant && !restaurationEnCours && !memorisationGelee) {
    positions.set(cheminCourant, positionDefilement());
  }
}

function figerPositionAvantNavigation() {
  memoriserPosition();
  memorisationGelee = true;
  setTimeout(() => { memorisationGelee = false; }, 900);
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

// Diagnostic du défilement : activable depuis la page Réglages (l'app
// installée n'ouvre pas les liens avec paramètres, un interrupteur est
// donc plus fiable qu'une URL). Affiche la position visée et celle
// réellement obtenue, pour lever un doute sur un appareil qu'on ne peut
// pas inspecter directement.
function diagnosticActif() {
  try {
    return localStorage.getItem('pronos_diag_scroll') === '1'
      || location.search.includes('diag=scroll');
  } catch {
    return false;
  }
}

// Le message s'affiche même quand rien n'a été mémorisé : c'est
// justement le cas qu'il faut pouvoir observer.
function annoncerDiagnostic(cible, chemin) {
  if (!diagnosticActif()) return;
  const vise = cible ? Math.round(cible) : 'rien';
  // Affichage long : ce message doit pouvoir être lu et recopié.
  setTimeout(() => toast(
    `${chemin} · visé ${vise} · obtenu ${Math.round(positionDefilement())}`
    + ` · src ${nomSource()} · h ${hauteurDefilable()}`,
    '', 9000,
  ), 2200);
}

function restaurerPosition(cible, jeton, chemin) {
  annoncerDiagnostic(cible, chemin);
  if (!cible) { allerA(0); return; }
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
    const atteignable = Math.min(cible, hauteurDefilable());
    if (Math.abs(positionDefilement() - atteignable) > 4) allerA(atteignable);

    if (Math.abs(positionDefilement() - cible) <= 4) {
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
      if (diagnosticActif() && cheminCourant) {
        // On annonce la valeur retenue, pas la position instantanée : le
        // navigateur a pu remonter la page entre le clic et cet instant.
        const retenue = positions.get(cheminCourant);
        toast(`quitte ${cheminCourant} @${retenue === undefined ? 'rien' : Math.round(retenue)}`,
          '', 5000);
      }
      const jeton = ++jetonNavigation;   // annule une restauration en cours
      document.querySelectorAll('#onglets a').forEach((a) => {
        a.classList.toggle('actif', a.dataset.route === route.onglet);
      });
      await route.rendu(conteneur, ...m.slice(1));
      if (jeton !== jetonNavigation) return;   // une autre navigation a pris le relais
      cheminCourant = chemin;
      restaurerPosition(
        LISTES.has(route.onglet) ? positions.get(chemin) : 0, jeton, chemin,
      );
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
  // Écoute en capture sur le document : contrairement à une écoute sur la
  // fenêtre, elle reçoit aussi le défilement d'un conteneur interne, ce
  // qui permet d'identifier lequel porte la position de lecture.
  document.addEventListener('scroll', (evt) => {
    noterSourceDefilement(evt.target);
    memoriserPosition();
  }, { capture: true, passive: true });
  // La position est saisie au clic, avant que le navigateur ne traite le
  // fragment : c'est le dernier instant où elle est encore fiable.
  document.addEventListener('click', (evt) => {
    if (evt.target?.closest?.('a[href^="#"], [data-retour], #onglets a')) {
      figerPositionAvantNavigation();
    }
  }, { capture: true });
  // Le défilement courant est suivi en continu : au moment du changement
  // de page, la valeur est déjà connue.
  window.addEventListener('scroll', memoriserPosition, { passive: true });
  return naviguer();
}
