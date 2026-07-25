-- ============================================================
-- Registre commun — RETOUR ARRIÈRE
-- La migration est ADDITIVE : elle n'altère aucune valeur comptable. Le retour
-- arrière par défaut se limite donc à retirer les objets ajoutés. Les colonnes
-- ajoutées peuvent être conservées sans risque (Pronos les ignore).
--
-- Principe : aucune suppression comptable. On ne supprime jamais de lignes de
-- eclats_ledger. Pour annuler l'effet d'une écriture applicative erronée, on
-- passe TOUJOURS par un mouvement compensatoire (eclats_refund), jamais par un
-- DELETE. La sauvegarde eclats_ledger_sauvegarde_20260725 reste disponible.
-- ============================================================

-- --- 1. Retrait des RPC et du trigger ajoutés (réversible, sans perte) ---
drop function if exists eclats_aggregates_by_app();
drop function if exists eclats_refund(text, text, uuid, text, text, jsonb);
drop function if exists eclats_spend(text, numeric, text, text, uuid, text, jsonb);
drop function if exists eclats_balance();

drop trigger if exists trg_eclats_fill_contract on eclats_ledger;
drop function if exists eclats_ledger_fill_contract();
drop function if exists eclats_kind_from_source(text);
drop function if exists eclats_app_from_source(text);

-- --- 2. Retrait des index et de la contrainte ajoutés ---
drop index if exists eclats_ledger_app_time_idx;
drop index if exists eclats_ledger_idem_uidx;
alter table eclats_ledger drop constraint if exists eclats_ledger_kind_chk;

-- --- 3. (OPTIONNEL) Retrait des colonnes ajoutées ---
-- À n'exécuter que pour revenir EXACTEMENT au schéma d'origine. Les données de
-- ces colonnes (déductions) seraient perdues, mais AUCUNE valeur comptable
-- (amount) n'est concernée. Décommenter en connaissance de cause :
-- alter table eclats_ledger
--   drop column if exists metadata,
--   drop column if exists occurred_at,
--   drop column if exists idempotency_key,
--   drop column if exists reference_type,
--   drop column if exists reason,
--   drop column if exists kind,
--   drop column if exists app_id;

-- --- 4. Correction compensatoire d'un mouvement applicatif erroné ---
-- Ne JAMAIS supprimer la ligne. Insérer une écriture opposée référencée :
-- select eclats_refund('cagnottes', 'cagnotte_versement',
--   '<reference_id uuid>'::uuid, 'Annulation manuelle',
--   'cagnottes:remboursement:manuel:<reference_id>');
