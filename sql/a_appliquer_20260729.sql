-- ============================================================
-- À APPLIQUER LE 29/07/2026 (une seule fois, dans l'éditeur SQL)
--
-- Regroupe securite_administration.sql et paliers_reglables.sql dans le
-- bon ordre : le compte propriétaire est déclaré AVANT que les réglages
-- ne soient réservés aux administrateurs. Exécuté dans une transaction,
-- donc soit tout passe, soit rien ne change.
--
-- Sans cette migration, la page Réglages échoue à l'enregistrement :
-- elle envoie des colonnes pp_* qui n'existent pas encore.
-- ============================================================

begin;

-- 1. Table des administrateurs et fonction de contrôle
create table if not exists app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table app_admins enable row level security;
revoke all on app_admins from anon, authenticated;

create or replace function is_app_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;
revoke all on function is_app_admin() from public, anon;
grant execute on function is_app_admin() to authenticated;

-- 2. Se déclarer AVANT de restreindre : sans cette étape, plus personne
-- ne pourrait modifier les réglages. Un seul compte existe ici.
insert into app_admins (user_id) select id from auth.users
on conflict (user_id) do nothing;

-- 3. Réserver les réglages et les paliers au propriétaire
drop policy if exists "settings_update_auth" on model_settings;
drop policy if exists "settings_update_admin" on model_settings;
create policy "settings_update_admin" on model_settings
  for update using (is_app_admin()) with check (is_app_admin());

drop policy if exists "paliers_update" on paliers;
drop policy if exists "paliers_update_admin" on paliers;
create policy "paliers_update_admin" on paliers
  for update using (is_app_admin()) with check (is_app_admin());
grant update on paliers to authenticated;

-- 4. La création directe d'un pari reste interdite : place_bet() est le
-- seul chemin atomique (cote serveur, débit du ledger, insertion).
drop policy if exists "bets_insert_own" on bets;
revoke insert on bets from authenticated;

-- 5. Barème des points de pronostiqueur, désormais réglable
alter table model_settings
  add column if not exists pp_par_pari numeric not null default 10,
  add column if not exists pp_bonne_issue numeric not null default 15,
  add column if not exists pp_bon_ecart numeric not null default 25,
  add column if not exists pp_score_exact numeric not null default 50;

create or replace function pronostiqueur_points()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(sum(
    s.pp_par_pari + case when b.status = 'won' then
      case when b.bonus_multiplier >= 2 then s.pp_score_exact
           when b.bonus_multiplier > 1 then s.pp_bon_ecart
           else s.pp_bonne_issue end
    else 0 end
  ), 0)::integer
  from bets b
  cross join model_settings s
  where b.user_id = auth.uid()
    and b.status in ('won', 'lost')
    and s.id = 'default';
$$;
revoke all on function pronostiqueur_points() from public, anon;
grant execute on function pronostiqueur_points() to authenticated;

commit;
