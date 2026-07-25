-- ============================================================
-- Registre commun des Éclats — migration additive et rejouable
-- 25/07/2026
--
-- Enrichit `eclats_ledger` (déjà utilisé par Pronos) au contrat v1 et ajoute
-- des RPC génériques idempotentes pour les applications consommatrices
-- (Cagnottes en pilote). Aucune ligne historique n'est supprimée ni modifiée
-- comptablement : les colonnes ajoutées sont renseignées par déduction pour
-- l'existant, et un trigger garde les nouvelles insertions Pronos compatibles.
--
-- Propriétés de sécurité :
--   * le solde reste calculé (sum(amount)), jamais stocké ;
--   * aucune suppression comptable ; une correction = mouvement compensatoire ;
--   * index unique d'idempotence (user_id, idempotency_key) ;
--   * fonctions atomiques (verrou par utilisateur) ;
--   * search_path fixé dans toutes les fonctions ;
--   * droits révoqués par défaut puis accordés à `authenticated` seulement ;
--   * RLS existante par utilisateur conservée ;
--   * aucune clé service_role requise côté navigateur.
--
-- REJOUABLE : chaque instruction est idempotente (IF NOT EXISTS / guards DO).
-- NE PAS EXÉCUTER sans sauvegarde préalable ni autorisation (voir
-- registre_commun_verification.sql et registre_commun_rollback.sql).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Colonnes du contrat v1 (additives, nullables)
-- ------------------------------------------------------------
alter table eclats_ledger
  add column if not exists app_id          text,
  add column if not exists kind            text,
  add column if not exists reason          text,
  add column if not exists reference_type  text,
  add column if not exists idempotency_key text,
  add column if not exists occurred_at     timestamptz,
  add column if not exists metadata        jsonb;

-- ------------------------------------------------------------
-- 2. Déduction de l'app et du type à partir de l'ancienne colonne `source`
--    (utilisée pour le backfill et par le trigger de compatibilité)
-- ------------------------------------------------------------
create or replace function eclats_app_from_source(p_source text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_source is null then 'inconnu'
    when p_source like 'paris_sportifs%' then 'pronos'
    when p_source like 'cagnottes%' then 'cagnottes'
    when position('_' in p_source) > 0 then split_part(p_source, '_', 1)
    else p_source
  end;
$$;

create or replace function eclats_kind_from_source(p_source text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_source
    when 'paris_sportifs_gain'          then 'gain'
    when 'paris_sportifs_palier'        then 'reward'
    when 'paris_sportifs_remboursement' then 'refund'
    when 'paris_sportifs_annulation'    then 'refund'
    when 'paris_sportifs_ajustement'    then 'adjustment'
    when 'paris_sportifs_reservation'   then 'spend'
    when 'paris_sportifs_mise'          then 'spend'
    else 'adjustment'
  end;
$$;

-- ------------------------------------------------------------
-- 3. Backfill des lignes historiques (idempotent : seulement si incomplet)
--    Chaque ancienne ligne reçoit une clé d'idempotence unique dérivée de son
--    id (uuid pk) : 'legacy:<id>'. Aucune valeur comptable (amount) n'est touchée.
-- ------------------------------------------------------------
update eclats_ledger
set app_id          = coalesce(app_id, eclats_app_from_source(source)),
    kind            = coalesce(kind, eclats_kind_from_source(source)),
    reason          = coalesce(reason, source),
    reference_type  = coalesce(reference_type, source),
    occurred_at     = coalesce(occurred_at, created_at),
    idempotency_key = coalesce(idempotency_key, 'legacy:' || id::text)
where app_id is null
   or kind is null
   or reason is null
   or reference_type is null
   or occurred_at is null
   or idempotency_key is null;

-- ------------------------------------------------------------
-- 4. Trigger de compatibilité : toute insertion qui ne fournit pas les
--    colonnes du contrat (ex. les RPC Pronos existantes qui n'écrivent que
--    user_id/amount/source/reference_id) est complétée automatiquement.
--    Les nouvelles insertions sans clé reçoivent une clé unique 'auto:<id>'
--    (l'idempotence réelle est portée par les RPC génériques ci-dessous).
-- ------------------------------------------------------------
create or replace function eclats_ledger_fill_contract()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.occurred_at     := coalesce(new.occurred_at, new.created_at, now());
  new.app_id          := coalesce(new.app_id, eclats_app_from_source(new.source));
  new.kind            := coalesce(new.kind, eclats_kind_from_source(new.source));
  new.reason          := coalesce(new.reason, new.source);
  new.reference_type  := coalesce(new.reference_type, new.source);
  new.idempotency_key := coalesce(new.idempotency_key, 'auto:' || new.id::text);
  return new;
end
$$;

drop trigger if exists trg_eclats_fill_contract on eclats_ledger;
create trigger trg_eclats_fill_contract
  before insert on eclats_ledger
  for each row execute function eclats_ledger_fill_contract();

-- ------------------------------------------------------------
-- 5. Contrainte de domaine sur `kind` (NOT VALID : n'échoue pas sur l'existant,
--    déjà rendu conforme par le backfill). Guard pour la rejouabilité.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'eclats_ledger_kind_chk'
  ) then
    alter table eclats_ledger
      add constraint eclats_ledger_kind_chk
      check (kind is null or kind in ('gain','spend','refund','reward','adjustment'))
      not valid;
  end if;
end
$$;

-- ------------------------------------------------------------
-- 6. Index unique d'idempotence + index de lecture pour Centrale
-- ------------------------------------------------------------
create unique index if not exists eclats_ledger_idem_uidx
  on eclats_ledger (user_id, idempotency_key);

create index if not exists eclats_ledger_app_time_idx
  on eclats_ledger (user_id, app_id, occurred_at desc);

-- ============================================================
-- 7. RPC génériques (atomiques, idempotentes, SECURITY DEFINER)
-- ============================================================

-- ---- Solde commun (somme du journal de l'utilisateur) ----
create or replace function eclats_balance()
returns numeric
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(sum(amount), 0)
  from eclats_ledger
  where user_id = auth.uid();
$$;

revoke all on function eclats_balance() from public, anon;
grant execute on function eclats_balance() to authenticated;

-- ---- Dépense (spend) plafonnée au solde disponible ----
-- Consomme des Éclats communs. La dépense demandée est plafonnée au solde
-- disponible (comme Pronos). Idempotente : rejouer la même clé ne re-débite pas.
create or replace function eclats_spend(
  p_app_id          text,
  p_amount          numeric,
  p_reason          text,
  p_reference_type  text,
  p_reference_id    uuid,
  p_idempotency_key text,
  p_metadata        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_existing  eclats_ledger%rowtype;
  v_balance   numeric;
  v_available numeric;
  v_spent     numeric;
  v_row       eclats_ledger%rowtype;
begin
  if v_user is null then raise exception 'Non authentifié'; end if;
  if p_app_id is null or p_app_id = '' then raise exception 'app_id requis'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Clé d''idempotence invalide';
  end if;

  -- Sérialise les opérations de portefeuille de cet utilisateur.
  perform pg_advisory_xact_lock(hashtext(v_user::text));

  -- Idempotence : même clé déjà enregistrée → renvoyer le mouvement, sans re-débit.
  select * into v_existing
  from eclats_ledger
  where user_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    select coalesce(sum(amount), 0) into v_balance
    from eclats_ledger where user_id = v_user;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'amount', -v_existing.amount,        -- consommé réel (positif)
      'requested', p_amount,
      'adjusted', (-v_existing.amount) < p_amount,
      'balance_after', v_balance,
      'idempotent_replay', true
    );
  end if;

  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger where user_id = v_user;
  v_available := greatest(v_balance, 0);
  v_spent := least(p_amount, v_available);
  if v_spent <= 0 then
    raise exception 'Solde insuffisant : aucun Éclat disponible';
  end if;

  insert into eclats_ledger (
    user_id, amount, source, reference_id,
    app_id, kind, reason, reference_type, idempotency_key, occurred_at, metadata
  ) values (
    v_user, -v_spent, p_app_id || '_spend', p_reference_id,
    p_app_id, 'spend', p_reason, p_reference_type, p_idempotency_key, now(), p_metadata
  )
  returning * into v_row;

  return jsonb_build_object(
    'movement_id', v_row.id,
    'amount', v_spent,
    'requested', p_amount,
    'adjusted', v_spent < p_amount,
    'balance_after', v_balance - v_spent,
    'idempotent_replay', false
  );
end
$$;

revoke all on function eclats_spend(text, numeric, text, text, uuid, text, jsonb)
  from public, anon;
grant execute on function eclats_spend(text, numeric, text, text, uuid, text, jsonb)
  to authenticated;

-- ---- Remboursement (refund) exactement-une-fois ----
-- Rembourse la dépense nette enregistrée pour une référence métier donnée.
-- Impossible de rembourser deux fois (double garde : clé d'idempotence unique
-- + contrôle du remboursement déjà émis pour la référence). Écriture
-- compensatoire : la dépense d'origine reste dans le journal.
create or replace function eclats_refund(
  p_app_id          text,
  p_reference_type  text,
  p_reference_id    uuid,
  p_reason          text,
  p_idempotency_key text,
  p_metadata        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user             uuid := auth.uid();
  v_existing         eclats_ledger%rowtype;
  v_spent            numeric;
  v_already_refunded numeric;
  v_refund           numeric;
  v_row              eclats_ledger%rowtype;
  v_balance          numeric;
begin
  if v_user is null then raise exception 'Non authentifié'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Clé d''idempotence invalide';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text));

  -- Idempotence directe : ce remboursement (cette clé) existe déjà.
  select * into v_existing
  from eclats_ledger
  where user_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    select coalesce(sum(amount), 0) into v_balance
    from eclats_ledger where user_id = v_user;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'amount', v_existing.amount,
      'balance_after', v_balance,
      'idempotent_replay', true
    );
  end if;

  -- Dépense nette réellement engagée pour cette référence.
  select coalesce(-sum(amount), 0) into v_spent
  from eclats_ledger
  where user_id = v_user and app_id = p_app_id
    and reference_type = p_reference_type and reference_id = p_reference_id
    and kind in ('spend', 'adjustment') and amount < 0;

  if v_spent <= 0 then
    raise exception 'Aucune dépense à rembourser pour cette référence';
  end if;

  -- Remboursements déjà émis pour cette référence.
  select coalesce(sum(amount), 0) into v_already_refunded
  from eclats_ledger
  where user_id = v_user and app_id = p_app_id
    and reference_type = p_reference_type and reference_id = p_reference_id
    and kind = 'refund';

  v_refund := v_spent - v_already_refunded;
  if v_refund <= 0 then
    raise exception 'Dépense déjà remboursée';
  end if;

  insert into eclats_ledger (
    user_id, amount, source, reference_id,
    app_id, kind, reason, reference_type, idempotency_key, occurred_at, metadata
  ) values (
    v_user, v_refund, p_app_id || '_refund', p_reference_id,
    p_app_id, 'refund', p_reason, p_reference_type, p_idempotency_key, now(), p_metadata
  )
  returning * into v_row;

  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger where user_id = v_user;
  return jsonb_build_object(
    'movement_id', v_row.id,
    'amount', v_refund,
    'balance_after', v_balance,
    'idempotent_replay', false
  );
end
$$;

revoke all on function eclats_refund(text, text, uuid, text, text, jsonb)
  from public, anon;
grant execute on function eclats_refund(text, text, uuid, text, text, jsonb)
  to authenticated;

-- ---- Récompense (reward) : crédit idempotent ----
-- Crédite des Éclats GAGNÉS dans une application (validation Discipline, gains
-- Pronos, écriture Rédac, quiz Mémo…). Idempotente par clé : rejouer la même clé
-- ne crédite jamais deux fois. Pour une récompense « une seule fois par jour »,
-- utiliser une clé datée, ex. 'discipline:habitude:<id>:2026-07-25'.
-- reference_id est facultatif (les identifiants métier non-uuid vont dans metadata).
create or replace function eclats_reward(
  p_app_id          text,
  p_amount          numeric,
  p_reason          text,
  p_reference_type  text,
  p_idempotency_key text,
  p_reference_id    uuid default null,
  p_metadata        jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_existing eclats_ledger%rowtype;
  v_row      eclats_ledger%rowtype;
  v_balance  numeric;
begin
  if v_user is null then raise exception 'Non authentifié'; end if;
  if p_app_id is null or p_app_id = '' then raise exception 'app_id requis'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'Clé d''idempotence invalide';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_user::text));

  -- Idempotence : même clé déjà enregistrée → renvoyer le mouvement, sans re-crédit.
  select * into v_existing
  from eclats_ledger
  where user_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    select coalesce(sum(amount), 0) into v_balance
    from eclats_ledger where user_id = v_user;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'amount', v_existing.amount,
      'balance_after', v_balance,
      'idempotent_replay', true
    );
  end if;

  insert into eclats_ledger (
    user_id, amount, source, reference_id,
    app_id, kind, reason, reference_type, idempotency_key, occurred_at, metadata
  ) values (
    v_user, p_amount, p_app_id || '_reward', p_reference_id,
    p_app_id, 'reward', p_reason, p_reference_type, p_idempotency_key, now(), p_metadata
  )
  returning * into v_row;

  select coalesce(sum(amount), 0) into v_balance
  from eclats_ledger where user_id = v_user;
  return jsonb_build_object(
    'movement_id', v_row.id,
    'amount', p_amount,
    'balance_after', v_balance,
    'idempotent_replay', false
  );
end
$$;

revoke all on function eclats_reward(text, numeric, text, text, text, uuid, jsonb)
  from public, anon;
grant execute on function eclats_reward(text, numeric, text, text, text, uuid, jsonb)
  to authenticated;

-- ---- Agrégats par application (lecture seule, pour Centrale) ----
create or replace function eclats_aggregates_by_app()
returns table (
  app_id     text,
  balance    numeric,
  movements  bigint,
  spent      numeric,
  gained     numeric,
  last_at    timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    l.app_id,
    coalesce(sum(l.amount), 0)                                  as balance,
    count(*)                                                    as movements,
    coalesce(-sum(l.amount) filter (where l.amount < 0), 0)     as spent,
    coalesce(sum(l.amount) filter (where l.amount > 0), 0)      as gained,
    max(l.occurred_at)                                          as last_at
  from eclats_ledger l
  where l.user_id = auth.uid()
  group by l.app_id;
$$;

revoke all on function eclats_aggregates_by_app() from public, anon;
grant execute on function eclats_aggregates_by_app() to authenticated;

commit;
