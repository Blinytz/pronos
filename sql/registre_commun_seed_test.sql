-- ============================================================
-- Crédit de TEST du registre commun — +2500 Éclats au propriétaire
-- À exécuter APRÈS registre_commun.sql, dans l'éditeur SQL Supabase.
--
-- Idempotent : rejouable sans re-créditer (clé 'seed:credit-initial-2500').
-- Valeur de TEST, sans signification économique — à ajuster/annuler plus tard
-- par un mouvement compensatoire, jamais par un DELETE.
--
-- Attribue le crédit à CHAQUE utilisateur du projet (usage mono-compte : il n'y
-- en a qu'un). Le mouvement est étiqueté app_id='systeme', kind='reward'.
-- ============================================================

insert into eclats_ledger (
  user_id, amount, source, app_id, kind, reason,
  reference_type, idempotency_key, occurred_at
)
select
  u.id, 2500, 'systeme_reward', 'systeme', 'reward',
  'Crédit de test initial (2500 ✦)', 'seed', 'seed:credit-initial-2500', now()
from auth.users u
where not exists (
  select 1 from eclats_ledger l
  where l.user_id = u.id and l.idempotency_key = 'seed:credit-initial-2500'
);

-- Contrôle : solde par utilisateur après le crédit.
select user_id, coalesce(sum(amount), 0) as solde
from eclats_ledger
group by user_id
order by user_id;
