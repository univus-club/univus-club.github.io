-- ============================================================
--  Univ-Us 데이터베이스 설정
--  Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고
--  맨 아래 "첫 운영진 비밀번호"만 바꾼 뒤 Run 을 누르세요. (한 번만 실행)
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------

-- 은하 = 기수
create table if not exists public.galaxies (
  gen        int primary key check (gen between 1 and 999),
  name       text not null default '' check (char_length(name) <= 30),
  created_at timestamptz not null default now()
);

-- 별 = 활동 하나. 제목·날짜는 외부인에게도 보임
create table if not exists public.stars (
  id          uuid primary key default gen_random_uuid(),
  gen         int  not null references public.galaxies(gen) on delete restrict,
  title       text not null check (char_length(title) between 1 and 60),
  date        date not null,
  photo_count int  not null default 0,
  created_at  timestamptz not null default now()
);

-- 일지 본문: 동아리원만
create table if not exists public.star_notes (
  star_id uuid primary key references public.stars(id) on delete cascade,
  body    text not null default '' check (char_length(body) <= 5000)
);

-- 사진: 동아리원만 (파일은 Storage 의 photos 버킷)
create table if not exists public.photos (
  id         uuid primary key default gen_random_uuid(),
  star_id    uuid not null references public.stars(id) on delete cascade,
  path       text not null unique,
  ord        int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists photos_star_idx on public.photos(star_id);

-- 입장한 브라우저(익명 로그인 세션)의 권한
create table if not exists public.access (
  uid        uuid primary key,
  role       text not null check (role in ('member', 'admin')),
  granted_at timestamptz not null default now()
);

-- 비밀번호 해시: 'admin' 또는 'gen:1', 'gen:2' ... 아무도 직접 읽을 수 없음
create table if not exists public.secrets (
  key        text primary key,
  hash       text not null,
  updated_at timestamptz not null default now()
);

-- 비밀번호 대입 공격 방지용 시도 기록
create table if not exists public.attempts (
  uid uuid not null,
  at  timestamptz not null default now()
);
create index if not exists attempts_uid_at_idx on public.attempts(uid, at);

-- ---------- 권한 확인 함수 ----------

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.access where uid = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.access where uid = auth.uid() and role = 'admin');
$$;

-- ---------- 행 단위 보안 (RLS) ----------

alter table public.galaxies   enable row level security;
alter table public.stars      enable row level security;
alter table public.star_notes enable row level security;
alter table public.photos     enable row level security;
alter table public.access     enable row level security;
alter table public.secrets    enable row level security;
alter table public.attempts   enable row level security;

-- secrets, attempts 는 정책이 없으므로 함수 밖에서는 읽기/쓰기 모두 불가
revoke all on public.secrets, public.attempts from anon, authenticated;

drop policy if exists "누구나 은하 보기" on public.galaxies;
create policy "누구나 은하 보기" on public.galaxies for select to anon, authenticated using (true);
drop policy if exists "운영진 은하 관리" on public.galaxies;
create policy "운영진 은하 관리" on public.galaxies for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "누구나 별 보기" on public.stars;
create policy "누구나 별 보기" on public.stars for select to anon, authenticated using (true);
drop policy if exists "운영진 별 관리" on public.stars;
create policy "운영진 별 관리" on public.stars for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "동아리원 일지 보기" on public.star_notes;
create policy "동아리원 일지 보기" on public.star_notes for select to authenticated using (public.is_member());
drop policy if exists "운영진 일지 관리" on public.star_notes;
create policy "운영진 일지 관리" on public.star_notes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "동아리원 사진 목록 보기" on public.photos;
create policy "동아리원 사진 목록 보기" on public.photos for select to authenticated using (public.is_member());
drop policy if exists "운영진 사진 관리" on public.photos;
create policy "운영진 사진 관리" on public.photos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "내 권한 보기" on public.access;
create policy "내 권한 보기" on public.access for select to authenticated using (uid = auth.uid());

-- 사진 개수를 stars 에 맞춰두기 (외부인 화면에서 별 밝기에 사용)
create or replace function public.sync_photo_count() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid uuid := coalesce(new.star_id, old.star_id);
begin
  update public.stars set photo_count = (select count(*) from public.photos where star_id = sid) where id = sid;
  return null;
end $$;
drop trigger if exists photos_count on public.photos;
create trigger photos_count after insert or delete on public.photos
  for each row execute function public.sync_photo_count();

-- ---------- 입장 (비밀번호 확인) ----------
-- 기수 비밀번호 → 동아리원, 운영진 비밀번호 → 운영진. 예전 기수 비밀번호도 계속 유효.
create or replace function public.unlock(pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  me  uuid := auth.uid();
  hit text;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  delete from public.attempts where at < now() - interval '1 day';
  if (select count(*) from public.attempts where uid = me and at > now() - interval '10 minutes') >= 8 then
    raise exception 'too_many_attempts';
  end if;
  insert into public.attempts(uid) values (me);

  select key into hit from public.secrets
   where hash = crypt(coalesce(pw, ''), hash)
   order by (key = 'admin') desc limit 1;

  if hit is null then return null; end if;
  if hit = 'admin' then
    insert into public.access(uid, role) values (me, 'admin')
      on conflict (uid) do update set role = 'admin', granted_at = now();
    return 'admin';
  end if;
  insert into public.access(uid, role) values (me, 'member') on conflict (uid) do nothing;
  return coalesce((select role from public.access where uid = me), 'member');
end $$;

-- ---------- 운영진 전용 관리 함수 ----------

-- 비밀번호 목록 (해시는 보여주지 않음)
create or replace function public.list_passwords()
returns table(key text, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select s.key, s.updated_at from public.secrets s order by s.key;
end $$;

-- 비밀번호 설정/변경. target = 'admin' 또는 'gen:숫자'
create or replace function public.set_password(target text, pw text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if target <> 'admin' and target !~ '^gen:[1-9][0-9]{0,2}$' then raise exception 'bad_target'; end if;
  if char_length(coalesce(pw, '')) < (case when target = 'admin' then 8 else 6 end) then
    raise exception 'too_short';
  end if;
  if exists (select 1 from public.secrets where key <> target and hash = crypt(pw, hash)) then
    raise exception 'duplicate';
  end if;
  insert into public.secrets(key, hash) values (target, crypt(pw, gen_salt('bf')))
    on conflict (key) do update set hash = excluded.hash, updated_at = now();
  -- 운영진 비밀번호를 바꾸면 지금 이 기기를 뺀 모든 운영진 로그인이 풀림
  if target = 'admin' then
    delete from public.access where role = 'admin' and uid <> auth.uid();
  end if;
end $$;

create or replace function public.delete_password(target text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if target = 'admin' then raise exception 'cannot_delete_admin'; end if;
  delete from public.secrets where key = target;
end $$;

-- 비밀번호가 샜을 때: 모든 동아리원이 비밀번호를 다시 입력하게 함
create or replace function public.reset_members() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.access where role = 'member';
end $$;

revoke execute on function public.unlock(text), public.list_passwords(), public.set_password(text, text),
  public.delete_password(text), public.reset_members() from public, anon;
grant execute on function public.unlock(text), public.list_passwords(), public.set_password(text, text),
  public.delete_password(text), public.reset_members() to authenticated;

-- ---------- 사진 저장소 ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "동아리원 사진 보기" on storage.objects;
create policy "동아리원 사진 보기" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());
drop policy if exists "운영진 사진 올리기" on storage.objects;
create policy "운영진 사진 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_admin());
drop policy if exists "운영진 사진 지우기" on storage.objects;
create policy "운영진 사진 지우기" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_admin());

-- ---------- 첫 운영진 비밀번호 ----------
-- ▼ '여기에-운영진-비밀번호' 를 8자 이상의 비밀번호로 바꾼 뒤 실행하세요.
--   (나중에 사이트의 설정 화면에서 언제든 바꿀 수 있어요)
do $$
declare first_pw text := '여기에-운영진-비밀번호';
begin
  if first_pw = '여기에-운영진-비밀번호' or char_length(first_pw) < 8 then
    raise exception '맨 아래 첫 운영진 비밀번호를 8자 이상으로 바꾼 뒤 다시 실행하세요.';
  end if;
  insert into public.secrets(key, hash) values ('admin', extensions.crypt(first_pw, extensions.gen_salt('bf')))
    on conflict (key) do update set hash = excluded.hash, updated_at = now();
end $$;
