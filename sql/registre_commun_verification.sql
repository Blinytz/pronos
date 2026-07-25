-- ============================================================
-- Registre commun — VÉRIFICATION après migration (lecture seule)
-- À exécuter APRÈS registre_commun.sql. N'écrit rien. Chaque requête doit
-- renvoyer le résultat attendu indiqué en commentaire.
-- ============================================================

-- A. Le solde total et le nombre de lignes sont inchangés vs la sauvegarde.
--    Attendu : mêmes valeurs que l'empreinte de registre_commun_backup.sql.
select count(*) as lignes, coalesce(sum(amount), 0) as solde_total
from eclats_ledger;

-- B. Comparaison ligne à ligne avec la sauvegarde : aucun montant modifié,
--    aucune ligne perdue. Attendu : 0 ligne.
select 'montant divergent ou ligne manquante' as anomalie, s.id
from eclats_ledger_sauvegarde_20260725 s
left join eclats_ledger l on l.id = s.id
where l.id is null or l.amount <> s.amount;

-- C. Toutes les lignes sont désormais conformes au contrat v1. Attendu : 0.
select count(*) as lignes_non_conformes
from eclats_ledger
where app_id is null or kind is null or reason is null
   or reference_type is null or idempotency_key is null or occurred_at is null;

-- D. Le kind est toujours dans le domaine autorisé. Attendu : 0.
select count(*) as kind_hors_domaine
from eclats_ledger
where kind not in ('gain','spend','refund','reward','adjustment');

-- E. Unicité effective des clés d'idempotence par utilisateur. Attendu : 0.
select count(*) as doublons_idempotence
from (
  select user_id, idempotency_key, count(*) c
  from eclats_ledger
  group by user_id, idempotency_key
  having count(*) > 1
) d;

-- F. Objets attendus présents. Attendu : 1 trigger, 1 index unique, 4 fonctions.
select
  (select count(*) from pg_trigger where tgname = 'trg_eclats_fill_contract') as triggers,
  (select count(*) from pg_indexes where indexname = 'eclats_ledger_idem_uidx') as index_unique,
  (select count(*) from pg_proc
     where proname in ('eclats_balance','eclats_spend','eclats_refund','eclats_aggregates_by_app')) as fonctions;

-- G. Droits : anon ne peut pas exécuter les RPC d'écriture. Attendu : 0.
select count(*) as droits_anon_indus
from information_schema.role_routine_grants
where grantee = 'anon'
  and routine_name in ('eclats_spend','eclats_refund');

-- H. RLS toujours active sur le journal. Attendu : rowsecurity = true.
select relname, relrowsecurity as rls_active
from pg_class where relname = 'eclats_ledger';
