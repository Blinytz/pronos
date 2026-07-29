// Saisie de pronostic partagée par la page Paris et la page Match.
//
// Deux notions distinctes (comme sur MPP) :
//   - ENREGISTRER : dès que les deux cases sont remplies, le pronostic
//     est sauvegardé et sa mise est réservée immédiatement. Elle est
//     plafonnée au solde disponible.
//   - EFFACER : vider les deux cases supprime le pronostic et rembourse
//     intégralement sa réservation.
//   - VALIDER : au coup d'envoi, le serveur transforme la réservation en
//     pari ferme sans débiter une seconde fois.
//
// Confort de frappe : au football un score tient sur un chiffre dans la
// quasi-totalité des cas, le curseur saute donc à la seconde case après
// un chiffre (deux au rugby). Revenir sur une case déjà remplie permet
// d'y saisir un second chiffre.

import { enregistrerBrouillon, supprimerBrouillon } from './api.js';
import { echapper, eclats, toast } from './ui.js';

const DELAI_ENREGISTREMENT = 700;

// Montants proposés en un geste, partagés par la page Paris (mise par
// défaut) et la page Match (mise de ce pronostic précis).
export const MISES = [10, 25, 50, 100, 250, 500, 1000];

// Rangée de puces de mise. `actif` est la valeur actuellement retenue.
export function puceMises(actif, { etiquette = 'Mise' } = {}) {
  return `<div class="mises-rapides">
    ${etiquette ? `<span class="etiquette">${echapper(etiquette)}</span>` : ''}
    ${MISES.map((v) => `<button type="button" class="puce-mise ${
      Number(v) === Number(actif) ? 'actif' : ''}" data-mise="${v}">${v}</button>`).join('')}
  </div>`;
}

export function chiffresAttendus(sport) {
  return sport === 'rugby' ? 2 : 1;
}

// Deux cases de score, pré-remplies par le brouillon éventuel.
// data-mise porte la mise effective : celle du brouillon existant (qui
// est PRÉSERVÉE lors d'une modification de score) ou, à défaut, la mise
// par défaut passée en paramètre pour un nouveau pronostic.
export function casesScore(match, brouillon, { taille = '', mise = 100 } = {}) {
  const val = (v) => (v === undefined || v === null ? '' : v);
  const miseEffective = brouillon?.stake_eclats ?? mise;
  // .cases-saisie identifie SANS AMBIGUÏTÉ le bloc modifiable. La classe
  // .cases-score, elle, sert aussi aux scores figés (en-tête de match,
  // confrontations directes) : s'y fier ferait brancher la saisie sur le
  // mauvais bloc, ou pas du tout.
  return `
    <div class="cases-score cases-saisie ${brouillon ? 'enregistre' : ''}"
         data-match="${match.id}"
         data-sport="${echapper(match.league?.sport || 'football')}"
         data-mise="${echapper(miseEffective)}">
      <input class="case-score ${taille} ${val(brouillon?.predicted_home) !== '' ? 'rempli' : ''}"
             data-camp="home" type="number"
             min="0" max="199" inputmode="numeric"
             value="${val(brouillon?.predicted_home)}"
             aria-label="Score ${echapper(match.home?.name)}">
      <span class="deux-points">:</span>
      <input class="case-score ${taille} ${val(brouillon?.predicted_away) !== '' ? 'rempli' : ''}"
             data-camp="away" type="number"
             min="0" max="199" inputmode="numeric"
             value="${val(brouillon?.predicted_away)}"
             aria-label="Score ${echapper(match.away?.name)}">
    </div>`;
}

/**
 * Rend les cases fonctionnelles.
 * @param {Element} racine élément contenant .cases-score
 * @param {object} options
 *   - mise : montant à enregistrer avec le brouillon
 *   - surEtat(texte, classe) : retour visuel (facultatif)
 *   - surChangement(home, away) : appelé après enregistrement (facultatif)
 */
export function brancherCases(racine, { mise, surEtat, surChangement } = {}) {
  // Cible le bloc saisissable où qu'il soit dans la page (la page match
  // contient plusieurs blocs de score figés avant celui-ci).
  const bloc = racine.matches?.('.cases-saisie')
    ? racine : racine.querySelector('.cases-saisie');
  if (!bloc || !bloc.dataset.match) return;
  const champs = [...bloc.querySelectorAll('.case-score')];
  if (champs.length !== 2) return;

  const attendus = chiffresAttendus(bloc.dataset.sport);
  const dire = (texte, classe = 'faible') => {
    if (surEtat) surEtat(texte, classe);
  };
  let minuteur = null;

  const lire = () => champs.map((c) => c.value.trim());

  const enregistrer = async () => {
    clearTimeout(minuteur);
    const [h, a] = lire();
    try {
      if (h === '' && a === '') {
        const suppression = await supprimerBrouillon(bloc.dataset.match);
        const remboursement = Number(suppression?.refunded) || 0;
        bloc.dataset.mise = mise || 100;
        bloc.classList.remove('enregistre');
        dire(remboursement
          ? `Pronostic effacé · ${eclats(remboursement)} ✦ rendus`
          : 'Pronostic effacé', 'ok');
        window.dispatchEvent(new Event('eclats-changes'));
        if (surChangement) {
          surChangement(null, null, { deleted: true, refunded: remboursement });
        }
      } else if (h === '' || a === '') {
        dire('Complète les deux cases');
        return;
      } else {
        // Mise lue à chaud sur le bloc : préserve la mise du brouillon
        // existant, ou reflète un changement fait entre-temps.
        const stake = Number(bloc.dataset.mise) || mise || 100;
        const resultat = await enregistrerBrouillon(
          bloc.dataset.match, Number(h), Number(a), stake);
        const reservee = Number(resultat?.stake_eclats) || stake;
        bloc.dataset.mise = reservee;
        bloc.classList.add('enregistre');
        dire(resultat?.adjusted
          ? `Enregistré à ${eclats(reservee)} ✦ · solde disponible atteint`
          : `Enregistré · ${eclats(reservee)} ✦ réservés`, 'ok');
        window.dispatchEvent(new Event('eclats-changes'));
        if (surChangement) {
          surChangement(Number(h), Number(a), resultat || { stake_eclats: reservee });
        }
      }
    } catch (e) {
      dire(`Non enregistré : ${e.message}`, 'erreur');
      toast(e.message, 'echec');
    }
  };

  champs.forEach((champ, index) => {
    champ.addEventListener('focus', () => {
      champ.select();          // une nouvelle frappe remplace la valeur
      delete champ.dataset.saute;  // le saut ne se fait qu'une fois par visite
    });

    champ.addEventListener('input', () => {
      champ.classList.toggle('rempli', champ.value.trim() !== '');
      // Saut automatique vers la case suivante quand le nombre de
      // chiffres habituel est atteint (1 au foot, 2 au rugby)
      if (index === 0 && !champ.dataset.saute
          && champ.value.trim().length >= attendus) {
        champ.dataset.saute = '1';
        champs[1].focus();
      }
      const [h, a] = lire();
      if (h !== '' && a !== '') dire('Enregistrement…');
      clearTimeout(minuteur);
      minuteur = setTimeout(enregistrer, DELAI_ENREGISTREMENT);
    });

    champ.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') { evt.preventDefault(); champ.blur(); enregistrer(); }
      // Retour arrière sur une case vide : revenir à la précédente
      if (evt.key === 'Backspace' && champ.value === '' && index === 1) {
        champs[0].focus();
      }
    });

    champ.addEventListener('blur', () => {
      const [h, a] = lire();
      if (h !== '' && a !== '') { clearTimeout(minuteur); enregistrer(); }
    });
  });
}
