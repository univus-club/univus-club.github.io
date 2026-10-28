-- ============================================================
--  Univ-Us 데이터베이스 설정
--  Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run.
--
--  처음 설치할 때: 맨 아래 "첫 운영진 비밀번호"를 임시 비밀번호로 바꾼 뒤 Run.
--  업데이트할 때: 아무것도 바꾸지 말고 그대로 Run. 기존 기록과 운영진 비밀번호는 그대로 남아요.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------

-- 은하 = 기수
create table if not exists public.galaxies (
  gen        int primary key check (gen between 1 and 999),
  name       text not null default '' check (char_length(name) <= 30),
  created_at timestamptz not null default now()
);

-- v3: 기수별 입장 코드 (입장 링크 #join=코드). 무작위 16자 = 80비트라 맞혀서 뚫는 건 불가능.
--     운영진만 함수로 읽을 수 있음. 은하를 지우면 같이 지워짐.
create table if not exists public.join_codes (
  gen        int primary key references public.galaxies(gen) on delete cascade,
  code       text not null unique check (code ~ '^[0-9A-Z]{16}$'),
  updated_at timestamptz not null default now()
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
-- v2: 누가 올렸는지 (입장한 브라우저 세션 id. 본인 글 고치기/지우기에 사용)
alter table public.stars add column if not exists created_by uuid default auth.uid();
create index if not exists stars_created_by_idx on public.stars(created_by, created_at);
-- v4: 별 꾸미기 (모양, 색). 정해진 값만 저장할 수 있음
alter table public.stars add column if not exists shape text not null default 'spark';
alter table public.stars add column if not exists color text not null default 'galaxy';
do $$ begin
  alter table public.stars add constraint stars_shape_ok
    check (shape in ('spark', 'star', 'planet', 'heart', 'moon', 'comet'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stars add constraint stars_color_ok
    check (color in ('galaxy', 'gold', 'rose', 'coral', 'mint', 'sky', 'violet', 'white'));
exception when duplicate_object then null; end $$;

-- 일지 본문: 동아리원만
create table if not exists public.star_notes (
  star_id uuid primary key references public.stars(id) on delete cascade,
  body    text not null default '' check (char_length(body) <= 5000)
);
-- v2: 글쓴이 이름 (선택, 동아리원만 보임)
alter table public.star_notes add column if not exists author_name text not null default '';
do $$ begin
  alter table public.star_notes add constraint star_notes_author_len check (char_length(author_name) <= 20);
exception when duplicate_object then null; end $$;

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
-- v2: 이 세션이 비밀번호를 입력한 기수들 (그 은하에 글을 쓸 수 있음)
alter table public.access add column if not exists gens int[] not null default '{}';

-- 운영진 비밀번호 해시 (key = 'admin'). 아무도 직접 읽을 수 없음
create table if not exists public.secrets (
  key        text primary key,
  hash       text not null,
  updated_at timestamptz not null default now()
);

-- 틀린 운영진 비밀번호 시도 기록 (kind = 'admin')
create table if not exists public.attempts (
  uid uuid not null,
  at  timestamptz not null default now()
);
alter table public.attempts add column if not exists kind text not null default 'admin';
create index if not exists attempts_uid_at_idx on public.attempts(uid, at);
create index if not exists attempts_kind_at_idx on public.attempts(kind, at);

-- ---------- 권한 확인 함수 ----------

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.access where uid = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.access where uid = auth.uid() and role = 'admin');
$$;

-- 이 은하(기수)에 글을 쓸 수 있는가: 운영진, 또는 그 기수 비밀번호로 입장한 사람
create or replace function public.can_post(g int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.access
                  where uid = auth.uid() and (role = 'admin' or g = any(gens)));
$$;

-- 내가 올린 별인가 (동아리원 입장이 살아 있을 때만)
create or replace function public.owns_star(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member()
     and exists (select 1 from public.stars where id = sid and created_by = auth.uid());
$$;

-- 사진 파일 경로(기수/별id/파일)가 내가 올린 별의 것인가
create or replace function public.owns_star_path(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare part text := split_part(object_name, '/', 2);
begin
  if part !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  return public.owns_star(part::uuid);
end $$;

-- ---------- 행 단위 보안 (RLS) ----------

alter table public.galaxies   enable row level security;
alter table public.stars      enable row level security;
alter table public.star_notes enable row level security;
alter table public.photos     enable row level security;
alter table public.access     enable row level security;
alter table public.secrets    enable row level security;
alter table public.attempts   enable row level security;
alter table public.join_codes enable row level security;

-- secrets, attempts, join_codes 는 정책이 없으므로 함수 밖에서는 읽기/쓰기 모두 불가
revoke all on public.secrets, public.attempts, public.join_codes from anon, authenticated;

-- 은하: 누구나 보기, 운영진만 관리
drop policy if exists "누구나 은하 보기" on public.galaxies;
create policy "누구나 은하 보기" on public.galaxies for select to anon, authenticated using (true);
drop policy if exists "운영진 은하 관리" on public.galaxies;
create policy "운영진 은하 관리" on public.galaxies for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 별: 누구나 보기, 운영진은 전부, 동아리원은 자기 기수에 쓰고 본인 것만 고치기/지우기
drop policy if exists "누구나 별 보기" on public.stars;
create policy "누구나 별 보기" on public.stars for select to anon, authenticated using (true);
drop policy if exists "운영진 별 관리" on public.stars;
create policy "운영진 별 관리" on public.stars for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "동아리원 별 쓰기" on public.stars;
create policy "동아리원 별 쓰기" on public.stars for insert to authenticated
  with check (created_by = auth.uid() and public.can_post(gen));
drop policy if exists "본인 별 고치기" on public.stars;
create policy "본인 별 고치기" on public.stars for update to authenticated
  using (created_by = auth.uid() and public.is_member())
  with check (created_by = auth.uid() and public.can_post(gen));
drop policy if exists "본인 별 지우기" on public.stars;
create policy "본인 별 지우기" on public.stars for delete to authenticated
  using (created_by = auth.uid() and public.is_member());

-- 일지
drop policy if exists "동아리원 일지 보기" on public.star_notes;
create policy "동아리원 일지 보기" on public.star_notes for select to authenticated using (public.is_member());
drop policy if exists "운영진 일지 관리" on public.star_notes;
create policy "운영진 일지 관리" on public.star_notes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "본인 일지 관리" on public.star_notes;
create policy "본인 일지 관리" on public.star_notes for all to authenticated
  using (public.owns_star(star_id)) with check (public.owns_star(star_id));

-- 사진 목록
drop policy if exists "동아리원 사진 목록 보기" on public.photos;
create policy "동아리원 사진 목록 보기" on public.photos for select to authenticated using (public.is_member());
drop policy if exists "운영진 사진 관리" on public.photos;
create policy "운영진 사진 관리" on public.photos for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "본인 사진 올리기" on public.photos;
create policy "본인 사진 올리기" on public.photos for insert to authenticated
  with check (public.owns_star(star_id));
drop policy if exists "본인 사진 지우기" on public.photos;
create policy "본인 사진 지우기" on public.photos for delete to authenticated
  using (public.owns_star(star_id));

drop policy if exists "내 권한 보기" on public.access;
create policy "내 권한 보기" on public.access for select to authenticated using (uid = auth.uid());

-- ---------- 자동 규칙 (트리거) ----------

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

-- 별 하나에 사진은 10장까지
create or replace function public.limit_photos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.photos where star_id = new.star_id) >= 10 then
    raise exception 'photo_limit';
  end if;
  return new;
end $$;
drop trigger if exists photos_limit on public.photos;
create trigger photos_limit before insert on public.photos
  for each row execute function public.limit_photos();

-- 동아리원은 하루에 별 10개까지 (도배 방지). 운영진은 제한 없음
create or replace function public.limit_stars() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and
     (select count(*) from public.stars
       where created_by = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception 'daily_limit';
  end if;
  return new;
end $$;
drop trigger if exists stars_limit on public.stars;
create trigger stars_limit before insert on public.stars
  for each row execute function public.limit_stars();

-- ---------- 입장 코드 만들기 ----------

-- 무작위 16자 (0-9, A-Z 중 헷갈리는 I L O U 제외 32글자 → 글자당 5비트, 총 80비트)
create or replace function public.make_code() returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b   bytea := gen_random_bytes(16);
  out text  := '';
begin
  for i in 0..15 loop
    out := out || substr(alphabet, (get_byte(b, i) & 31) + 1, 1);
  end loop;
  return out;
end $$;
revoke execute on function public.make_code() from public, anon, authenticated;

-- 사람이 입력한 값을 코드 형태로 정리 (대소문자, 하이픈, 공백, 헷갈리는 글자 I/L→1, O→0)
create or replace function public.normalize_code(v text) returns text
language sql immutable as $$
  select translate(upper(regexp_replace(coalesce(v, ''), '[^0-9A-Za-z]', '', 'g')), 'ILO', '110');
$$;

-- 입력값이 입장 코드 모양인가 (영문·숫자 16자, 하이픈/공백만 허용)
create or replace function public.looks_like_code(v text) returns boolean
language sql immutable as $$
  select coalesce(v, '') ~ '^[0-9A-Za-z -]+$' and public.normalize_code(v) ~ '^[0-9A-Z]{16}$';
$$;

-- 은하가 생기면 입장 코드도 자동으로 생김
create or replace function public.galaxy_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.join_codes(gen, code) values (new.gen, public.make_code()) on conflict (gen) do nothing;
  return null;
end $$;
drop trigger if exists galaxies_code on public.galaxies;
create trigger galaxies_code after insert on public.galaxies
  for each row execute function public.galaxy_code();

-- ---------- 입장 ----------
-- 입장 코드(링크) → 동아리원 + 그 기수 은하에 쓰기. 맞혀서 뚫을 수 없으니 전체 잠금 없음.
-- 운영진 비밀번호 → 사람이 외우는 값이라 사이트 전체에서 10분에 30번 틀리면 10분간 운영진 입장만 잠금.
--   (잠겨도 부원 입장·열람·글쓰기, 이미 입장한 운영진은 영향 없음)
-- 운영진 비밀번호를 같은 세션이 10분에 8번 틀리면 그 세션은 입장 시도 자체가 잠시 막힘.
-- 실패 기록은 잠금 상한(10분에 30개) 덕분에 무한히 쌓이지 않음.
create or replace function public.unlock(pw text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  me  uuid := auth.uid();
  g   int;
  ok  boolean;
begin
  if me is null then raise exception 'not_signed_in'; end if;
  delete from public.attempts where at < now() - interval '1 day';
  if (select count(*) from public.attempts where uid = me and at > now() - interval '10 minutes') >= 8 then
    raise exception 'too_many_attempts';
  end if;

  -- 1) 입장 코드
  if public.looks_like_code(pw) then
    select gen into g from public.join_codes where code = public.normalize_code(pw);
    -- 틀린 코드는 기록하지 않음: 맞힐 수 없으니 셀 필요가 없고,
    -- 기록하면 대량 요청으로 DB 용량을 채우는 공격이 가능해짐
    if g is null then return null; end if;
    insert into public.access(uid, role, gens) values (me, 'member', array[g])
      on conflict (uid) do update
        set gens = case when g = any(public.access.gens) then public.access.gens
                        else public.access.gens || g end;
    return (select role from public.access where uid = me);
  end if;

  -- 2) 운영진 비밀번호
  if (select count(*) from public.attempts where kind = 'admin' and at > now() - interval '10 minutes') >= 30 then
    raise exception 'admin_locked';
  end if;
  select exists (select 1 from public.secrets where key = 'admin' and hash = crypt(coalesce(pw, ''), hash)) into ok;
  if not ok then
    insert into public.attempts(uid, kind) values (me, 'admin');
    return null;
  end if;
  insert into public.access(uid, role) values (me, 'admin')
    on conflict (uid) do update set role = 'admin', granted_at = now();
  return 'admin';
end $$;

-- ---------- 운영진 전용 관리 함수 ----------

-- 기수별 입장 코드 목록
create or replace function public.list_join_codes()
returns table(gen int, code text, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query select j.gen, j.code, j.updated_at from public.join_codes j order by j.gen;
end $$;

-- 입장 코드 새로 만들기 (링크가 샜을 때). 예전 링크는 바로 무효
create or replace function public.rotate_join_code(g int) returns text
language plpgsql security definer set search_path = public as $$
declare c text := public.make_code();
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.galaxies where gen = g) then raise exception 'no_galaxy'; end if;
  insert into public.join_codes(gen, code) values (g, c)
    on conflict (gen) do update set code = excluded.code, updated_at = now();
  return c;
end $$;

-- 운영진 비밀번호 바꾸기 (12자 이상, 입장 코드처럼 생기면 안 됨)
drop function if exists public.set_password(text, text);
create or replace function public.set_admin_password(pw text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(coalesce(pw, '')) < 12 then raise exception 'too_short'; end if;
  if public.looks_like_code(pw) then raise exception 'code_like'; end if;
  insert into public.secrets(key, hash) values ('admin', crypt(pw, gen_salt('bf')))
    on conflict (key) do update set hash = excluded.hash, updated_at = now();
  -- 이 기기를 뺀 모든 운영진 로그인이 풀림
  delete from public.access where role = 'admin' and uid <> auth.uid();
end $$;

-- 링크가 샜을 때: 모든 동아리원이 다시 입장하게 함
create or replace function public.reset_members() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.access where role = 'member';
end $$;

-- 예전 버전 함수 정리
drop function if exists public.list_passwords();
drop function if exists public.delete_password(text);

revoke execute on function public.unlock(text), public.list_join_codes(), public.rotate_join_code(int),
  public.set_admin_password(text), public.reset_members() from public, anon;
grant execute on function public.unlock(text), public.list_join_codes(), public.rotate_join_code(int),
  public.set_admin_password(text), public.reset_members() to authenticated;

-- v3 이전: 기수 비밀번호는 없애고, 기존 은하마다 입장 코드를 만들어 둠
delete from public.secrets where key like 'gen:%';
insert into public.join_codes(gen, code)
  select g.gen, public.make_code() from public.galaxies g
   where not exists (select 1 from public.join_codes j where j.gen = g.gen);

-- ---------- 사진 저장소 ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 3145728, array['image/webp', 'image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "동아리원 사진 보기" on storage.objects;
create policy "동아리원 사진 보기" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());
drop policy if exists "운영진 사진 올리기" on storage.objects;
create policy "운영진 사진 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (public.is_admin() or public.owns_star_path(name)));
drop policy if exists "운영진 사진 지우기" on storage.objects;
create policy "운영진 사진 지우기" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (public.is_admin() or public.owns_star_path(name)));

-- ---------- 첫 운영진 비밀번호 (처음 설치할 때만) ----------
-- ▼ 처음 설치할 때만: 아래 따옴표 안을 8자 이상의 임시 비밀번호로 바꾼 뒤 실행하세요.
--   이미 운영진 비밀번호가 있으면(업데이트할 때) 이 부분은 저절로 건너뛰어요.
do $$
declare first_pw text := '여기에-운영진-비밀번호';
begin
  if exists (select 1 from public.secrets where key = 'admin') then
    raise notice '운영진 비밀번호가 이미 있어서 건너뛰어요.';
    return;
  end if;
  if first_pw = '여기에-' || '운영진-비밀번호' or char_length(first_pw) < 8 then
    raise exception '맨 아래 첫 운영진 비밀번호를 8자 이상으로 바꾼 뒤 다시 실행하세요.';
  end if;
  if public.looks_like_code(first_pw) then
    raise exception '운영진 비밀번호가 입장 코드(영문·숫자 16자)처럼 생겼어요. 다른 비밀번호로 바꿔 주세요.';
  end if;
  insert into public.secrets(key, hash) values ('admin', extensions.crypt(first_pw, extensions.gen_salt('bf')));
end $$;
