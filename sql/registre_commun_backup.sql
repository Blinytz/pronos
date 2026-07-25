-- ============================================================
-- Registre commun — SAUVEGARDE avant migration
-- À exécuter AVANT registre_commun.sql, dans l'éditeur SQL Supabase.
-- Crée une copie horodatée intégrale de eclats_ledger. Purement additif :
-- ne touche pas la table d'origine. Conserver le nom de la table de sauvegarde.
-- ============================================================

-- 1. Copie complète (structure + données) dans une table datée.
--    Adapter la date si besoin ; ne pas réutiliser un nom existant.
create table if not exists eclats_ledger_sauvegarde_20260725 as
  select * from eclats_ledger;

-- 2. Empreinte de contrôle à noter (à recomparer après migration).
--    Le total du solde et le nombre de lignes NE DOIVENT PAS changer.
select
  count(*)              as lignes,
  coalesce(sum(amount), 0) as solde_total,
  min(created_at)       as premiere,
  max(created_at)       as derniere
from eclats_ledger;

-- 3. Solde par utilisateur (à recomparer après migration : identique attendu).
select user_id, coalesce(sum(amount), 0) as solde
from eclats_ledger
group by user_id
order by user_id;
