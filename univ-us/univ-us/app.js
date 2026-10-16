/* Univ-Us — 기수마다 은하, 활동 하나마다 별.
 * 화면 코드는 이 파일 하나뿐이에요. 데이터는 Supabase(config.js)에 있어요. */
(() => {
"use strict";

/* ============================== 작은 도구들 ============================== */
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const fmtDate = d => (d ? d.replaceAll("-", ".") : "");
const todaySeoul = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }));
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
const hueOf = gen => (218 + gen * 67) % 360;

function friendly(e) {
  const m = String((e && (e.message || e.error_description || e.code)) || e || "");
  if (/too_many_attempts/.test(m)) return "비밀번호를 너무 많이 틀렸어요. 10분 뒤에 다시 시도해 주세요.";
  if (/duplicate/.test(m)) return "다른 기수나 운영진이 이미 쓰는 비밀번호예요. 다른 비밀번호를 정해 주세요.";
  if (/too_short/.test(m)) return "비밀번호가 너무 짧아요. 기수 비밀번호는 6자, 운영진 비밀번호는 8자 이상이어야 해요.";
  if (/forbidden|row-level security|permission/i.test(m)) return "운영진만 할 수 있는 일이에요. 운영진 비밀번호로 다시 입장해 주세요.";
  if (/Anonymous sign-ins are disabled/i.test(m)) return "Supabase에서 익명 로그인이 꺼져 있어요. README의 설치 3단계를 확인해 주세요.";
  if (/23505|already exists|duplicate key/i.test(m)) return "이미 있는 기수예요.";
  if (/23503|foreign key/i.test(m)) return "별이 남아 있는 은하는 지울 수 없어요. 별을 먼저 지워 주세요.";
  if (/rate limit/i.test(m)) return "지금 같은 와이파이에서 입장하는 사람이 많아요. 몇 분 뒤에 다시 시도하거나 모바일 데이터로 입장해 주세요.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "인터넷 연결을 확인하고 다시 시도해 주세요.";
  if (/exceeded|too large|Payload/i.test(m)) return "사진이 너무 커요. 다른 사진으로 다시 시도해 주세요.";
  return "문제가 생겼어요. 잠시 후 다시 시도해 주세요." + (m ? ` (${m.slice(0, 80)})` : "");
}

/* ============================== 사진 줄이기 ============================== */
// 긴 변 1600px, WebP(지원 안 되면 JPEG)로 줄여서 한 장에 보통 150~300KB
async function compressImage(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("이미지를 읽지 못했어요")); i.src = URL.createObjectURL(file); });
  }
  const w0 = src.width, h0 = src.height;
  let max = 1600, q = 0.8, blob = null;
  for (let tries = 0; tries < 4; tries++) {
    const k = Math.min(1, max / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    blob = await new Promise(r => c.toBlob(r, "image/webp", q));
    if (!blob || blob.type !== "image/webp") blob = await new Promise(r => c.toBlob(r, "image/jpeg", q + 0.04));
    if (blob && blob.size < 450 * 1024) break;
    max = Math.round(max * 0.8); q -= 0.06;
  }
  return blob;
}

/* ============================== 데이터: Supabase ============================== */
function makeSupabaseApi(cfg) {
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "univus-auth" },
  });
  const must = ({ data, error }) => { if (error) throw error; return data; };
  const bucket = () => sb.storage.from("photos");

  async function myRole() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return "guest";
    const { data } = await sb.from("access").select("role").eq("uid", session.user.id).maybeSingle();
    return (data && data.role) || "guest";
  }
  async function removeFiles(paths) {
    if (!paths.length) return;
    const { error } = await bucket().remove(paths);
    if (error) throw error;
  }

  return {
    demo: false,
    myRole,
    async loadUniverse() {
      const [g, s] = await Promise.all([
        sb.from("galaxies").select("gen,name").order("gen"),
        sb.from("stars").select("id,gen,title,date,photo_count,created_at").order("created_at"),
      ]);
      return { galaxies: must(g), stars: must(s) };
    },
    async unlock(pw) {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { const { error } = await sb.auth.signInAnonymously(); if (error) throw error; }
      return must(await sb.rpc("unlock", { pw }));
    },
    async getDetail(starId) {
      const [n, p] = await Promise.all([
        sb.from("star_notes").select("body").eq("star_id", starId).maybeSingle(),
        sb.from("photos").select("id,path,ord").eq("star_id", starId).order("ord"),
      ]);
      const note = must(n), photos = must(p);
      if (photos.length) {
        const signed = must(await bucket().createSignedUrls(photos.map(x => x.path), 3600));
        const byPath = new Map(signed.map(x => [x.path, x.signedUrl]));
        photos.forEach(x => { x.url = byPath.get(x.path) || ""; });
      }
      return { body: note ? note.body : "", photos };
    },
    async saveStar({ id, gen, title, date, body, newFiles, removeIds, onProgress }) {
      const isNew = !id;
      id = id || uuid();
      if (isNew) {
        must(await sb.from("stars").insert({ id, gen, title, date }));
      } else {
        must(await sb.from("stars").update({ gen, title, date }).eq("id", id));
      }
      must(await sb.from("star_notes").upsert({ star_id: id, body }));
      if (removeIds && removeIds.length) {
        const rows = must(await sb.from("photos").select("id,path").in("id", removeIds));
        await removeFiles(rows.map(r => r.path));
        must(await sb.from("photos").delete().in("id", removeIds));
      }
      if (newFiles && newFiles.length) {
        const last = must(await sb.from("photos").select("ord").eq("star_id", id).order("ord", { ascending: false }).limit(1));
        let ord = last.length ? last[0].ord + 1 : 0;
        for (let i = 0; i < newFiles.length; i++) {
          onProgress && onProgress(i + 1, newFiles.length);
          const blob = await compressImage(newFiles[i]);
          const ext = blob.type === "image/webp" ? "webp" : "jpg";
          const path = `${gen}/${id}/${uuid()}.${ext}`;
          const { error } = await bucket().upload(path, blob, { contentType: blob.type, upsert: false });
          if (error) throw error;
          must(await sb.from("photos").insert({ star_id: id, path, ord: ord++ }));
        }
      }
      return id;
    },
    async deleteStar(id) {
      const rows = must(await sb.from("photos").select("path").eq("star_id", id));
      await removeFiles(rows.map(r => r.path));
      must(await sb.from("stars").delete().eq("id", id));
    },
    async startCohort(gen, name, pw) {
      must(await sb.rpc("set_password", { target: "gen:" + gen, pw }));
      must(await sb.from("galaxies").insert({ gen, name }));
    },
    async renameGalaxy(gen, name) { must(await sb.from("galaxies").update({ name }).eq("gen", gen)); },
    async deleteGalaxy(gen) { must(await sb.from("galaxies").delete().eq("gen", gen)); },
    async listPasswords() { return must(await sb.rpc("list_passwords")) || []; },
    async setPassword(target, pw) { must(await sb.rpc("set_password", { target, pw })); },
    async resetMembers() { must(await sb.rpc("reset_members")); },
    async signOut() { await sb.auth.signOut(); },
  };
}

/* ============================== 데이터: 예시 모드 ============================== */
// config.js 가 비어 있을 때만 쓰여요. 브라우저 안에서만 돌아가고 저장되지 않아요.
function makeDemoApi() {
  const day = (d) => d;
  const galaxies = [{ gen: 1, name: "첫 항해" }, { gen: 2, name: "두 번째 궤도" }];
  const sample = [
    [1, "발대식", "2025-03-08", "첫 만남. 다들 어색했지만 자기소개 빙고에서 웃음이 터졌다."],
    [1, "첫 정기 모임", "2025-03-22", "팀을 나누고 학기 목표를 정했다."],
    [1, "봄 MT", "2025-04-19", "가평. 새벽까지 보드게임."],
    [1, "중간 네트워킹 데이", "2025-05-10", "다른 학교 동아리원들과 처음으로 함께한 날."],
    [1, "여름 프로젝트 발표회", "2025-07-05", "세 팀이 결과물을 발표했다."],
    [1, "종강 파티", "2025-12-13", "1기의 마지막 공식 모임."],
    [2, "2기 발대식", "2026-03-07", "1기 선배들이 찾아와 축하해 줬다."],
    [2, "첫 정기 모임", "2026-03-21", "새 기수의 첫 회의."],
    [2, "봄 MT", "2026-04-18", "강릉 바다."],
    [2, "연합 해커톤", "2026-05-23", "밤샘 끝에 2등."],
  ];
  const stars = sample.map(([gen, title, date], i) => ({ id: "demo-" + i, gen, title, date: day(date), photo_count: 0, created_at: new Date(date).toISOString() }));
  const notes = new Map(sample.map(([, , , body], i) => ["demo-" + i, body]));
  const photos = new Map();
  const secrets = new Map([["admin", "admin1234"], ["gen:1", "111111"], ["gen:2", "222222"]]);
  const times = new Map([...secrets.keys()].map(k => [k, "2026-03-01T00:00:00Z"]));
  let role = "guest";
  const wait = (v) => new Promise(r => setTimeout(() => r(v), 120));
  const needAdmin = () => { if (role !== "admin") throw new Error("forbidden"); };
  return {
    demo: true,
    async myRole() { return role; },
    async loadUniverse() { return wait({ galaxies: galaxies.map(g => ({ ...g })), stars: stars.map(s => ({ ...s })) }); },
    async unlock(pw) {
      for (const [k, v] of secrets) if (v === pw) { role = k === "admin" ? "admin" : (role === "admin" ? "admin" : "member"); return wait(role); }
      return wait(null);
    },
    async getDetail(id) { return wait({ body: notes.get(id) || "", photos: (photos.get(id) || []).map(p => ({ ...p })) }); },
    async saveStar({ id, gen, title, date, body, newFiles, removeIds, onProgress }) {
      needAdmin();
      if (!id) { id = "demo-" + uuid(); stars.push({ id, gen, title, date, photo_count: 0, created_at: new Date().toISOString() }); }
      const s = stars.find(x => x.id === id); Object.assign(s, { gen, title, date });
      notes.set(id, body);
      let list = (photos.get(id) || []).filter(p => !(removeIds || []).includes(p.id));
      for (let i = 0; i < (newFiles || []).length; i++) {
        onProgress && onProgress(i + 1, newFiles.length);
        const b = await compressImage(newFiles[i]);
        list.push({ id: uuid(), url: URL.createObjectURL(b) });
      }
      photos.set(id, list); s.photo_count = list.length;
      return wait(id);
    },
    async deleteStar(id) { needAdmin(); const i = stars.findIndex(s => s.id === id); if (i >= 0) stars.splice(i, 1); return wait(); },
    async startCohort(gen, name, pw) {
      needAdmin();
      if (pw.length < 6) throw new Error("too_short");
      if ([...secrets].some(([k, v]) => v === pw && k !== "gen:" + gen)) throw new Error("duplicate");
      if (galaxies.some(g => g.gen === gen)) throw new Error("23505");
      secrets.set("gen:" + gen, pw); times.set("gen:" + gen, new Date().toISOString());
      galaxies.push({ gen, name }); galaxies.sort((a, b) => a.gen - b.gen);
      return wait();
    },
    async renameGalaxy(gen, name) { needAdmin(); galaxies.find(g => g.gen === gen).name = name; return wait(); },
    async deleteGalaxy(gen) { needAdmin(); if (stars.some(s => s.gen === gen)) throw new Error("23503"); galaxies.splice(galaxies.findIndex(g => g.gen === gen), 1); return wait(); },
    async listPasswords() { needAdmin(); return wait([...secrets.keys()].sort().map(key => ({ key, updated_at: times.get(key) }))); },
    async setPassword(target, pw) {
      needAdmin();
      if (pw.length < (target === "admin" ? 8 : 6)) throw new Error("too_short");
      if ([...secrets].some(([k, v]) => v === pw && k !== target)) throw new Error("duplicate");
      secrets.set(target, pw); times.set(target, new Date().toISOString()); return wait();
    },
    async resetMembers() { needAdmin(); return wait(); },
    async signOut() { role = "guest"; return wait(); },
  };
}

/* ============================== 상태와 모델 ============================== */
const S = {
  api: null, role: "guest",
  galaxies: [], stars: [], loaded: false, loadError: null,
  view: null, hover: null,
};
const isMember = () => S.role === "member" || S.role === "admin";
const isAdmin = () => S.role === "admin";

async function reload() {
  try {
    const { galaxies, stars } = await S.api.loadUniverse();
    S.loadError = null;
    build(galaxies, stars);
  } catch (e) {
    S.loadError = e;
  }
  S.loaded = true;
  renderChrome();
  if (S.view) refreshView();
}

function build(galaxyRows, starRows) {
  const byGen = new Map();
  for (const g of galaxyRows) byGen.set(g.gen, { gen: g.gen, name: g.name || "", stars: [] });
  for (const s of starRows) {
    if (!byGen.has(s.gen)) byGen.set(s.gen, { gen: s.gen, name: "", stars: [] });
    byGen.get(s.gen).stars.push(s);
  }
  const prev = new Map(S.galaxies.map(g => [g.gen, g]));
  const list = [...byGen.values()].sort((a, b) => a.gen - b.gen);
  list.forEach((g, n) => {
    g.stars.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.created_at || "").localeCompare(b.created_at || ""));
    g.stars.forEach((s, i) => { s.index = i; });
    const ang = n * 2.399963 + 0.6;            // 첫 은하는 가운데, 다음 기수부터 나선을 그리며 바깥으로
    const dist = n === 0 ? 0 : 560 * Math.sqrt(n);
    g.x = Math.cos(ang) * dist; g.y = Math.sin(ang) * dist;
    g.R = 95 + 24 * Math.sqrt(g.stars.length);
    g.hue = hueOf(g.gen);
    g.dust = prev.get(g.gen)?.dust || makeDust(g.gen);
  });
  S.galaxies = list;
  S.stars = list.flatMap(g => g.stars);
}

function makeDust(gen) {
  const r = rng(Math.floor(hash("galaxy" + gen) * 1e9));
  const pts = [];
  for (let k = 0; k < 520; k++) {
    const t = Math.pow(r(), 0.75);
    const g = (r() + r() + r() - 1.5) / 1.5;
    pts.push({ t, arm: k % 2, spread: g * (0.55 - t * 0.25), s: r() < 0.08 ? 1.8 : 0.9 + r() * 0.6, a: 0.25 + r() * 0.5, j: (r() - 0.5) * 0.08 });
  }
  return pts;
}
function starPos(g, s, rot) {
  const j = hash(s.id);
  const rr = 26 + 25 * Math.sqrt(s.index + 0.6) + (j - 0.5) * 14;
  const ang = (s.index % 2) * Math.PI + rr / 58 + (j - 0.5) * 0.5 + rot;
  return [g.x + Math.cos(ang) * rr, g.y + Math.sin(ang) * rr];
}

/* ============================== 우주 그리기 ============================== */
const cv = $("#sky"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1, bgStars = [];
const cam = { x: 0, y: 0, z: 0.6 }, target = { x: 0, y: 0, z: 0.6, on: false };
const t0 = performance.now();
const rotNow = () => (reduceMotion ? 0 : (performance.now() - t0) * 0.000012);

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  const r = rng(42);
  bgStars = Array.from({ length: Math.round(W * H / 2600) }, () => ({ x: r() * W, y: r() * H, s: r() < 0.1 ? 1.4 : 0.7, a: 0.2 + r() * 0.6, p: 0.02 + r() * 0.05, tw: r() * 6.28 }));
}
addEventListener("resize", resize); resize();
const toScreen = (x, y) => [(x - cam.x) * cam.z + W / 2, (y - cam.y) * cam.z + H / 2];
const toWorld = (sx, sy) => [(sx - W / 2) / cam.z + cam.x, (sy - H / 2) / cam.z + cam.y];

let hits = [];
function frame(now) {
  const t = now - t0;
  if (target.on) {
    const k = reduceMotion ? 1 : 0.1;
    cam.x += (target.x - cam.x) * k; cam.y += (target.y - cam.y) * k; cam.z += (target.z - cam.z) * k;
    if (Math.abs(target.z - cam.z) < 0.001 && Math.hypot(target.x - cam.x, target.y - cam.y) < 0.5) target.on = false;
  }
  const rot = rotNow();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  const bg = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
  bg.addColorStop(0, "#0e1130"); bg.addColorStop(1, "#06070f");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ffffff";
  for (const s of bgStars) {
    const x = ((s.x - cam.x * s.p) % W + W) % W, y = ((s.y - cam.y * s.p) % H + H) % H;
    ctx.globalAlpha = reduceMotion ? s.a : s.a * (0.7 + 0.3 * Math.sin(t * 0.001 + s.tw));
    ctx.fillRect(x, y, s.s, s.s);
  }
  ctx.globalAlpha = 1;

  ctx.globalCompositeOperation = "lighter";
  hits = [];
  const openId = S.view && S.view.type === "star" ? S.view.id : null;
  for (const g of S.galaxies) {
    const [cx, cy] = toScreen(g.x, g.y);
    const Rs = g.R * cam.z;
    if (cx + Rs * 1.3 < 0 || cx - Rs * 1.3 > W || cy + Rs * 1.3 < 0 || cy - Rs * 1.3 > H) continue;
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Rs * 0.55);
    cg.addColorStop(0, `hsla(${g.hue},90%,85%,.55)`);
    cg.addColorStop(0.35, `hsla(${g.hue},80%,60%,.18)`);
    cg.addColorStop(1, `hsla(${g.hue},80%,50%,0)`);
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, Rs * 0.55, 0, 6.2832); ctx.fill();
    const hz = g.hover ? 1.2 : 1;
    ctx.fillStyle = `hsl(${g.hue},70%,75%)`;
    for (const p of g.dust) {
      const r = p.t * g.R;
      const a = p.arm * Math.PI + r / 58 + p.spread + p.j + rot;
      const sz = Math.max(0.8, p.s * Math.min(1.6, cam.z * 1.2));
      ctx.globalAlpha = p.a * (1 - p.t * 0.55) * hz;
      ctx.fillRect(cx + Math.cos(a) * r * cam.z, cy + Math.sin(a) * r * cam.z, sz, sz);
    }
    ctx.globalAlpha = 1;
    for (const s of g.stars) {
      const [wx, wy] = starPos(g, s, rot);
      const [sx, sy] = toScreen(wx, wy);
      const hov = S.hover === s.id || openId === s.id;
      const glow = 2 + Math.min(1.4, (s.photo_count || 0) * 0.25); // 사진이 많을수록 밝게
      const base = glow * Math.max(0.8, Math.min(1.8, cam.z * 1.4)) * (hov ? 1.6 : 1);
      const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, base * 5);
      gl.addColorStop(0, "rgba(255,240,205,.95)");
      gl.addColorStop(0.25, `hsla(${g.hue},90%,78%,.5)`);
      gl.addColorStop(1, `hsla(${g.hue},90%,70%,0)`);
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(sx, sy, base * 5, 0, 6.2832); ctx.fill();
      if (cam.z > 0.55 || hov) {
        ctx.strokeStyle = "rgba(255,236,200,.55)"; ctx.lineWidth = 0.8;
        const sp = base * 4.2;
        ctx.beginPath(); ctx.moveTo(sx - sp, sy); ctx.lineTo(sx + sp, sy); ctx.moveTo(sx, sy - sp); ctx.lineTo(sx, sy + sp); ctx.stroke();
      }
      ctx.fillStyle = "#fff7e6"; ctx.beginPath(); ctx.arc(sx, sy, base * 0.7, 0, 6.2832); ctx.fill();
      hits.push({ x: sx, y: sy, s, g });
    }
  }
  ctx.globalCompositeOperation = "source-over";

  ctx.textAlign = "center";
  if (cam.z < 1.6) {
    for (const g of S.galaxies) {
      const [cx, cy] = toScreen(g.x, g.y);
      const Rs = g.R * cam.z;
      ctx.fillStyle = `hsla(${g.hue},60%,88%,.92)`;
      ctx.font = `${Math.round(Math.max(13, Math.min(20, 15 * cam.z + 8)))}px Orbit, "IBM Plex Sans KR", sans-serif`;
      ctx.fillText(`${g.gen}기${g.name ? " · " + g.name : ""}`, cx, cy + Rs + 22);
      ctx.font = `11px "IBM Plex Mono", monospace`;
      ctx.fillStyle = "rgba(170,176,220,.7)";
      ctx.fillText(`★ ${g.stars.length}`, cx, cy + Rs + 38);
    }
  }
  if (cam.z > 1.05) {
    ctx.font = `12px "IBM Plex Sans KR", sans-serif`;
    ctx.textAlign = "left";
    for (const h of hits) {
      if (h.x < -50 || h.x > W + 50 || h.y < -20 || h.y > H + 20) continue;
      ctx.fillStyle = S.hover === h.s.id ? "#fff3d6" : "rgba(220,222,245,.75)";
      const tt = h.s.title.length > 18 ? h.s.title.slice(0, 17) + "…" : h.s.title;
      ctx.fillText(tt, h.x + 10, h.y + 4);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function panelOffset() {
  if (!$("#panel").classList.contains("open")) return [0, 0];
  if (W <= 640) return [0, H * 0.84 / 2];
  return [Math.min(460, W) / 2, 0];
}
function flyTo(x, y, z) {
  z = Math.max(0.08, Math.min(5, z));
  const [ox, oy] = panelOffset();
  Object.assign(target, { x: x + ox / z, y: y + oy / z, z, on: true });
  if (reduceMotion) { cam.x = target.x; cam.y = target.y; cam.z = target.z; }
}
function fitAll() {
  if (!S.galaxies.length) { flyTo(0, 0, 1); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of S.galaxies) { x0 = Math.min(x0, g.x - g.R); y0 = Math.min(y0, g.y - g.R); x1 = Math.max(x1, g.x + g.R); y1 = Math.max(y1, g.y + g.R); }
  const z = Math.min((W - 80) / (x1 - x0 + 120), (H - 220) / (y1 - y0 + 160), 1.4);
  flyTo((x0 + x1) / 2, (y0 + y1) / 2, z);
}
const flyToGalaxy = g => flyTo(g.x, g.y, Math.min(W, H) * 0.36 / g.R);

// 마우스·터치 조작
const ptrs = new Map(); let drag = null, moved = false, pinch0 = null;
cv.addEventListener("pointerdown", e => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = false; target.on = false;
  if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: cam.z };
    pinch0.w = toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
  }
});
cv.addEventListener("pointermove", e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2 && pinch0) {
    const [a, b] = [...ptrs.values()];
    cam.z = Math.max(0.08, Math.min(5, pinch0.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch0.d));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    cam.x = pinch0.w[0] - (mx - W / 2) / cam.z; cam.y = pinch0.w[1] - (my - H / 2) / cam.z;
    moved = true; return;
  }
  if (drag && ptrs.size === 1) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) { moved = true; cv.classList.add("dragging"); }
    if (moved) { cam.x = drag.cx - dx / cam.z; cam.y = drag.cy - dy / cam.z; }
    return;
  }
  const h = hitTest(e.clientX, e.clientY);
  S.galaxies.forEach(g => { g.hover = !!(h && !h.s && h.g === g); });
  S.hover = h && h.s ? h.s.id : null;
  cv.classList.toggle("pointing", !!h);
});
function endPtr(e) {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch0 = null;
  if (ptrs.size === 0) {
    cv.classList.remove("dragging");
    if (!moved && drag) {
      const h = hitTest(e.clientX, e.clientY);
      if (h && h.s) openStar(h.s.id, true);
      else if (h) openGalaxy(h.g.gen, true);
    }
    drag = null;
  } else if (ptrs.size === 1) {
    const [p] = [...ptrs.values()]; drag = { x: p.x, y: p.y, cx: cam.x, cy: cam.y }; moved = true;
  }
}
cv.addEventListener("pointerup", endPtr);
cv.addEventListener("pointercancel", endPtr);
cv.addEventListener("wheel", e => {
  e.preventDefault(); target.on = false;
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  cam.z = Math.max(0.08, Math.min(5, cam.z * Math.exp(-e.deltaY * 0.0015)));
  cam.x = wx - (e.clientX - W / 2) / cam.z; cam.y = wy - (e.clientY - H / 2) / cam.z;
}, { passive: false });
function hitTest(sx, sy) {
  let best = null, bd = 16;
  for (const h of hits) { const d = Math.hypot(h.x - sx, h.y - sy); if (d < bd) { bd = d; best = h; } }
  if (best) return best;
  const [wx, wy] = toWorld(sx, sy);
  for (const g of S.galaxies) if (Math.hypot(wx - g.x, wy - g.y) < g.R * 0.9) return { g };
  return null;
}

/* ============================== 화면 틀 ============================== */
function renderChrome() {
  // 오른쪽 위 버튼들
  const stats = el("div", { class: "stats" }, "은하 ", el("b", { text: String(S.galaxies.length) }), " · 별 ", el("b", { text: String(S.stars.length) }));
  const acts = [stats];
  if (isAdmin()) {
    acts.push(el("button", { class: "btn", type: "button", onclick: () => openStarForm(null, S.view && S.view.gen) }, "✦ 별 추가"));
    acts.push(el("button", { class: "btn ghost", type: "button", onclick: openSettings }, "운영"));
  } else if (isMember()) {
    acts.push(el("button", { class: "btn ghost", type: "button", onclick: openAccount }, el("span", { class: "badge member", text: "동아리원" })));
  } else {
    acts.push(el("button", { class: "btn ghost", type: "button", onclick: () => openUnlock() }, "입장하기"));
  }
  $("#actions").replaceChildren(...acts);

  // 아래 기수 버튼
  $("#dock").replaceChildren(
    ...(S.galaxies.length ? [el("button", { class: "chip", type: "button", onclick: () => { closePanel(); fitAll(); } }, "전체 우주")] : []),
    ...S.galaxies.map(g => el("button", {
      class: "chip", type: "button", "aria-current": S.view && S.view.gen === g.gen ? "true" : "false",
      onclick: () => openGalaxy(g.gen, true),
    }, el("i", { style: `background:hsl(${g.hue},80%,70%);box-shadow:0 0 8px hsl(${g.hue},80%,60%)` }), `${g.gen}기`, el("small", { text: String(g.stars.length) }))),
    S.galaxies.length ? el("span", { class: "hint", text: "드래그로 이동 · 스크롤로 확대" }) : null,
  );

  // 가운데 안내
  const note = $("#note");
  if (!S.loaded) return;
  if (S.loadError) {
    note.hidden = false;
    note.replaceChildren(el("h2", { text: "우주를 불러오지 못했어요" }), el("p", { text: friendly(S.loadError) }),
      el("button", { class: "btn ghost", type: "button", onclick: reload }, "다시 불러오기"));
  } else if (!S.galaxies.length) {
    note.hidden = false;
    note.replaceChildren(
      el("h2", { text: "아직 텅 빈 우주예요" }),
      el("p", { text: "기수마다 은하가 하나씩 생기고, 활동 하나가 별 하나가 돼요." }),
      isAdmin() ? el("button", { class: "btn", type: "button", onclick: openSettings }, "첫 기수 시작하기")
        : el("button", { class: "btn ghost", type: "button", onclick: () => openUnlock() }, "운영진 입장"),
    );
  } else note.hidden = true;
}

/* ============================== 옆 패널 ============================== */
const panel = $("#panel"), pbody = $("#pbody");
function openPanel() { panel.classList.add("open"); panel.setAttribute("aria-hidden", "false"); document.body.classList.add("panel-open"); }
function closePanel() { panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true"); document.body.classList.remove("panel-open"); S.view = null; renderChrome(); }
$("#closeBtn").addEventListener("click", closePanel);
$("#backBtn").addEventListener("click", () => S.view && S.view.back && S.view.back());
addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const lb = document.querySelector(".lightbox");
  if (lb) lb.remove(); else if (panel.classList.contains("open")) closePanel();
});
function show(view, crumb, ...content) {
  S.view = view;
  $("#crumb").textContent = crumb;
  $("#backBtn").hidden = !view.back;
  pbody.replaceChildren(...content.flat().filter(Boolean));
  pbody.scrollTop = 0;
  openPanel(); renderChrome();
}
function refreshView() {
  const v = S.view;
  if (!v) return;
  if (v.type === "galaxy") openGalaxy(v.gen, false);
  else if (v.type === "star") { if (S.stars.some(s => s.id === v.id)) openStar(v.id, false); else if (v.gen) openGalaxy(v.gen, false); else closePanel(); }
}
const head = (eyebrow, title) => el("div", {}, el("div", { class: "eyebrow", text: eyebrow }), el("h2", { text: title }));
const msg = () => el("p", { class: "msg", hidden: true });
const say = (m, text, ok) => { m.textContent = text; m.className = "msg " + (ok ? "ok" : "err"); m.hidden = false; };

/* ---------- 은하 ---------- */
function openGalaxy(gen, fly) {
  const g = S.galaxies.find(x => x.gen === gen);
  if (!g) return;
  const list = [...g.stars].reverse();
  const first = g.stars[0];
  const adminBox = isAdmin() ? galaxyAdmin(g) : null;
  show({ type: "galaxy", gen }, `Galaxy ${pad(gen)}`,
    head(`${g.gen}기 은하`, g.name || `${g.gen}기의 은하`),
    el("div", { class: "meta" }, el("span", { text: `별 ${g.stars.length}개` }), first ? el("span", { text: `첫 기록 ${fmtDate(first.date)}` }) : null),
    isAdmin() ? el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: () => openStarForm(null, g.gen) }, "✦ 이 은하에 별 추가")) : null,
    list.length
      ? el("div", { class: "loglist" }, list.map(s => el("button", { class: "logrow", type: "button", onclick: () => openStar(s.id, true) },
          el("span", { class: "d", text: fmtDate(s.date) }), el("span", { class: "t", text: s.title }),
          s.photo_count ? el("span", { class: "a", text: `사진 ${s.photo_count}장` }) : null)))
      : el("p", { class: "empty-line", text: "아직 이 은하에는 별이 없어요." }),
    !isMember() ? el("p", { class: "fine", text: "사진과 일지는 동아리원만 볼 수 있어요." }) : null,
    adminBox,
  );
  if (fly) flyToGalaxy(g);
}
function galaxyAdmin(g) {
  const name = el("input", { type: "text", id: "g-name", maxlength: "30", value: g.name, placeholder: "예: 첫 항해" });
  const m = msg();
  const save = el("button", { class: "btn ghost small", type: "button" }, "이름 저장");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try { await S.api.renameGalaxy(g.gen, name.value.trim()); await reload(); }
    catch (e) { say(m, friendly(e)); save.disabled = false; }
  });
  const delWrap = el("div", { class: "row" });
  const idle = () => delWrap.replaceChildren(el("button", { class: "btn danger small", type: "button", onclick: ask }, "은하 지우기"));
  const ask = () => delWrap.replaceChildren(
    el("span", { class: "confirm", text: `${g.gen}기 은하를 지울까요?` }),
    el("button", { class: "btn danger small", type: "button", onclick: async () => {
      try { await S.api.deleteGalaxy(g.gen); S.view = null; closePanel(); await reload(); fitAll(); }
      catch (e) { say(m, friendly(e)); idle(); }
    } }, "지우기"),
    el("button", { class: "btn ghost small", type: "button", onclick: idle }, "취소"));
  idle();
  return el("div", { class: "section" }, el("h3", { text: "은하 관리" }),
    el("label", {}, "은하 이름", name), el("div", { class: "row" }, save), g.stars.length ? null : delWrap, m);
}

/* ---------- 별 ---------- */
let detailToken = 0;
function openStar(id, fly) {
  const s = S.stars.find(x => x.id === id); if (!s) return;
  const g = S.galaxies.find(x => x.gen === s.gen);
  const content = el("div", { style: "display:flex;flex-direction:column;gap:18px" });
  if (isMember()) {
    content.append(el("p", { class: "fine", text: "불러오는 중…" }));
    const my = ++detailToken;
    S.api.getDetail(id).then(d => {
      if (my !== detailToken) return;
      const photos = d.photos.filter(p => p.url);
      content.replaceChildren(...[
        photos.length ? el("div", { class: "photos" + (photos.length === 1 ? " one" : "") },
          photos.map(p => el("button", { type: "button", "aria-label": "사진 크게 보기", onclick: () => lightbox(p.url) },
            el("img", { src: p.url, alt: `${s.title} 활동 사진`, loading: "lazy" })))) : null,
        d.body ? el("p", { class: "body-text", text: d.body }) : (photos.length ? null : el("p", { class: "empty-line", text: "아직 일지가 없어요." })),
      ].filter(Boolean));
    }).catch(e => { if (my === detailToken) content.replaceChildren(el("p", { class: "msg err", text: friendly(e) })); });
  } else {
    content.append(el("div", { class: "locked" },
      el("p", { text: "사진과 일지는 동아리원만 볼 수 있어요. 기수 비밀번호로 입장하면 모든 은하의 기록이 열려요." }),
      el("button", { class: "btn", type: "button", onclick: () => openUnlock(() => openStar(id, false)) }, "입장하기")));
  }
  let admin = null;
  if (isAdmin()) {
    const delWrap = el("div", { class: "row" });
    const idle = () => delWrap.replaceChildren(
      el("button", { class: "btn ghost small", type: "button", onclick: () => openStarForm(s, s.gen) }, "고치기"),
      el("button", { class: "btn danger small", type: "button", onclick: ask }, "지우기"));
    const ask = () => delWrap.replaceChildren(
      el("span", { class: "confirm", text: "이 별과 사진을 모두 지울까요? 되돌릴 수 없어요." }),
      el("button", { class: "btn danger small", type: "button", onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try { await S.api.deleteStar(id); S.view = { type: "galaxy", gen: s.gen }; await reload(); }
        catch (e) { delWrap.append(el("p", { class: "msg err", text: friendly(e) })); }
      } }, "지우기"),
      el("button", { class: "btn ghost small", type: "button", onclick: idle }, "취소"));
    idle();
    admin = el("div", { class: "section" }, delWrap);
  }
  show({ type: "star", id, gen: s.gen, back: () => openGalaxy(s.gen, true) }, `UV-${pad(s.gen)}-${pad(s.index + 1, 3)}`,
    head(`${s.gen}기 · ${s.index + 1}번째 별`, s.title),
    el("div", { class: "meta" }, el("span", { text: fmtDate(s.date) }), s.photo_count ? el("span", { text: `사진 ${s.photo_count}장` }) : null),
    content, admin);
  if (fly && g) {
    const [wx, wy] = starPos(g, s, rotNow());
    flyTo(wx, wy, Math.max(cam.z, Math.min(W, H) * 0.36 / g.R * 1.6));
  }
}
function lightbox(url) {
  const box = el("div", { class: "lightbox", role: "dialog", "aria-label": "사진", onclick: () => box.remove() }, el("img", { src: url, alt: "" }));
  document.body.append(box);
}

/* ---------- 입장 ---------- */
function openUnlock(after) {
  const pw = el("input", { type: "password", id: "u-pw", autocomplete: "current-password", placeholder: "기수 비밀번호 또는 운영진 비밀번호" });
  const m = msg();
  const go = el("button", { class: "btn", type: "submit" }, "입장");
  const form = el("form", {}, el("label", {}, "비밀번호", pw), m, el("div", { class: "row" }, go));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!pw.value) return say(m, "비밀번호를 입력해 주세요.");
    go.disabled = true; go.textContent = "확인 중…";
    try {
      const role = await S.api.unlock(pw.value);
      if (!role) { say(m, "비밀번호가 맞지 않아요. 단톡방 공지에서 우리 기수 비밀번호를 확인해 주세요."); go.disabled = false; go.textContent = "입장"; return; }
      S.role = role;
      renderChrome();
      if (after) after(); else { say(m, role === "admin" ? "운영진으로 입장했어요." : "입장했어요. 이제 모든 은하의 사진과 일지를 볼 수 있어요.", true); go.hidden = true; }
    } catch (err) { say(m, friendly(err)); go.disabled = false; go.textContent = "입장"; }
  });
  show({ type: "unlock" }, "Access", head("입장", "동아리원 입장"),
    el("p", { class: "empty-line", text: "우리 기수의 비밀번호를 입력하세요. 예전 기수 비밀번호도 계속 쓸 수 있어요. 한 번 입장하면 이 기기에서는 다시 묻지 않아요." }),
    form);
  setTimeout(() => pw.focus(), 50);
}
function openAccount() {
  show({ type: "account" }, "Access", head("입장 상태", "동아리원으로 입장해 있어요"),
    el("p", { class: "empty-line", text: "모든 은하의 사진과 일지를 볼 수 있어요. 운영진이라면 운영진 비밀번호로 다시 입장하세요." }),
    el("div", { class: "row" },
      el("button", { class: "btn ghost", type: "button", onclick: () => openUnlock() }, "운영진 입장"),
      el("button", { class: "btn ghost", type: "button", onclick: signOut }, "이 기기에서 나가기")));
}
async function signOut() {
  await S.api.signOut().catch(() => {});
  S.role = "guest"; closePanel(); renderChrome();
}

/* ---------- 별 추가/고치기 (운영진) ---------- */
function openStarForm(star, presetGen) {
  if (!isAdmin()) return openUnlock();
  if (!S.galaxies.length) return openSettings();
  const editing = !!star;
  const gen = editing ? star.gen : (presetGen || S.galaxies[S.galaxies.length - 1].gen);
  const sel = el("select", { id: "f-gen" }, S.galaxies.map(g => el("option", { value: String(g.gen), selected: g.gen === gen }, `${g.gen}기${g.name ? " · " + g.name : ""}`)));
  const date = el("input", { type: "date", id: "f-date", value: editing ? star.date : todaySeoul(), required: true });
  const title = el("input", { type: "text", id: "f-title", maxlength: "60", value: editing ? star.title : "", placeholder: "예: 봄 MT", required: true });
  const body = el("textarea", { id: "f-body", maxlength: "5000", placeholder: "무엇을 했고, 어떤 순간이 기억에 남았나요?" });
  const thumbs = el("div", { class: "thumbs" });
  const pending = [];          // 새로 올릴 사진
  let existing = [];           // 이미 있는 사진
  const removeIds = new Set();
  const MAX = 10;
  const drawThumbs = () => thumbs.replaceChildren(
    ...existing.map(p => el("div", { class: removeIds.has(p.id) ? "removed" : null }, el("img", { src: p.url, alt: "" }),
      el("button", { type: "button", "aria-label": removeIds.has(p.id) ? "되살리기" : "사진 빼기", onclick: () => { removeIds.has(p.id) ? removeIds.delete(p.id) : removeIds.add(p.id); drawThumbs(); } }, removeIds.has(p.id) ? "↺" : "✕"))),
    ...pending.map((p, i) => el("div", {}, el("img", { src: p.url, alt: "" }),
      el("button", { type: "button", "aria-label": "사진 빼기", onclick: () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); drawThumbs(); syncCheck(); } }, "✕"))));
  const fileIn = el("input", { type: "file", id: "f-photo", accept: "image/*", multiple: true });
  const check = el("input", { type: "checkbox", id: "f-ok" });
  const checkRow = el("label", { class: "check", hidden: true }, check, "올릴 사진에서 원하지 않는 사람의 얼굴, 연락처·학번 같은 개인정보를 확인했어요.");
  const syncCheck = () => { checkRow.hidden = pending.length === 0; };
  fileIn.addEventListener("change", () => {
    const room = MAX - (existing.length - removeIds.size) - pending.length;
    [...fileIn.files].filter(f => f.type.startsWith("image/")).slice(0, Math.max(0, room)).forEach(f => pending.push({ file: f, url: URL.createObjectURL(f) }));
    fileIn.value = ""; drawThumbs(); syncCheck();
  });
  const m = msg();
  const submit = el("button", { class: "btn", type: "submit" }, editing ? "저장" : "✦ 별 띄우기");
  const form = el("form", { novalidate: true },
    el("label", {}, "은하", sel),
    el("div", { class: "two" }, el("label", {}, "활동 날짜", date), el("label", {}, "제목", title)),
    el("label", {}, "일지", body),
    el("label", { class: "drop" }, fileIn, `사진 추가하기 (최대 ${MAX}장, 자동으로 줄여서 올라가요)`),
    thumbs, checkRow, m,
    el("div", { class: "row" }, submit));
  if (editing) {
    body.placeholder = "불러오는 중…";
    S.api.getDetail(star.id).then(d => { body.value = d.body || ""; body.placeholder = "무엇을 했고, 어떤 순간이 기억에 남았나요?"; existing = d.photos.filter(p => p.url); drawThumbs(); }).catch(e => say(m, friendly(e)));
  }
  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!title.value.trim()) return say(m, "제목을 적어 주세요.");
    if (!date.value) return say(m, "활동 날짜를 골라 주세요.");
    if (pending.length && !check.checked) return say(m, "사진 속 얼굴과 개인정보를 확인했다면 체크해 주세요.");
    submit.disabled = true; submit.textContent = "저장 중…";
    try {
      const id = await S.api.saveStar({
        id: editing ? star.id : null, gen: parseInt(sel.value, 10), title: title.value.trim(), date: date.value, body: body.value.trim(),
        newFiles: pending.map(p => p.file), removeIds: [...removeIds],
        onProgress: (i, n) => { submit.textContent = `사진 올리는 중… ${i}/${n}`; },
      });
      pending.forEach(p => URL.revokeObjectURL(p.url));
      S.view = { type: "star", id };
      await reload();
      openStar(id, true);
    } catch (err) { say(m, friendly(err)); submit.disabled = false; submit.textContent = editing ? "저장" : "✦ 별 띄우기"; }
  });
  show({ type: "form", gen, back: editing ? () => openStar(star.id, false) : null }, editing ? "Edit star" : "New star",
    head(editing ? "별 고치기" : "새 별", editing ? star.title : "오늘의 별을 띄워요"), form);
}

/* ---------- 운영 설정 (운영진) ---------- */
async function openSettings() {
  if (!isAdmin()) return openUnlock();
  const nextGen = S.galaxies.length ? Math.max(...S.galaxies.map(g => g.gen)) + 1 : 1;

  // 1) 새 기수 시작
  const nGen = el("input", { type: "number", id: "s-gen", min: "1", max: "999", value: String(nextGen) });
  const nName = el("input", { type: "text", id: "s-gname", maxlength: "30", placeholder: "예: 세 번째 궤도 (선택)" });
  const nPw = el("input", { type: "text", id: "s-gpw", autocomplete: "off", placeholder: "6자 이상" });
  const nMsg = msg();
  const nBtn = el("button", { class: "btn", type: "submit" }, "은하 만들기");
  const newForm = el("form", {}, el("div", { class: "two" }, el("label", {}, "기수", nGen), el("label", {}, "은하 이름", nName)),
    el("label", {}, "이 기수의 비밀번호", nPw), nMsg, el("div", { class: "row" }, nBtn));
  newForm.addEventListener("submit", async e => {
    e.preventDefault();
    const gen = parseInt(nGen.value, 10);
    if (!(gen >= 1 && gen <= 999)) return say(nMsg, "기수는 1에서 999 사이 숫자로 적어 주세요.");
    if (nPw.value.length < 6) return say(nMsg, "비밀번호는 6자 이상이어야 해요.");
    nBtn.disabled = true;
    try {
      await S.api.startCohort(gen, nName.value.trim(), nPw.value);
      await reload();
      const g = S.galaxies.find(x => x.gen === gen); if (g) flyToGalaxy(g);
      openSettings();
    } catch (err) { say(nMsg, friendly(err)); nBtn.disabled = false; }
  });

  // 2) 기수 비밀번호 목록
  const pwList = el("div", { class: "pwlist" }, el("p", { class: "fine", text: "불러오는 중…" }));
  S.api.listPasswords().then(rows => {
    const set = new Map(rows.filter(r => r.key.startsWith("gen:")).map(r => [parseInt(r.key.slice(4), 10), r.updated_at]));
    const gens = [...new Set([...S.galaxies.map(g => g.gen), ...set.keys()])].sort((a, b) => a - b);
    pwList.replaceChildren(...(gens.length ? gens.map(gen => pwRow(gen, set.get(gen))) : [el("p", { class: "fine", text: "아직 기수가 없어요." })]));
  }).catch(e => pwList.replaceChildren(el("p", { class: "msg err", text: friendly(e) })));

  // 3) 운영진 비밀번호
  const a1 = el("input", { type: "password", id: "s-apw", autocomplete: "new-password", placeholder: "8자 이상" });
  const a2 = el("input", { type: "password", id: "s-apw2", autocomplete: "new-password", placeholder: "한 번 더" });
  const aMsg = msg();
  const aBtn = el("button", { class: "btn ghost", type: "submit" }, "운영진 비밀번호 바꾸기");
  const adminForm = el("form", {}, el("div", { class: "two" }, el("label", {}, "새 비밀번호", a1), el("label", {}, "확인", a2)), aMsg, el("div", { class: "row" }, aBtn));
  adminForm.addEventListener("submit", async e => {
    e.preventDefault();
    if (a1.value !== a2.value) return say(aMsg, "두 비밀번호가 달라요.");
    aBtn.disabled = true;
    try { await S.api.setPassword("admin", a1.value); a1.value = a2.value = ""; say(aMsg, "바꿨어요. 이 기기를 뺀 다른 운영진은 새 비밀번호로 다시 입장해야 해요.", true); }
    catch (err) { say(aMsg, friendly(err)); }
    aBtn.disabled = false;
  });

  // 4) 모두 다시 입장
  const rWrap = el("div", { class: "row" });
  const rIdle = () => rWrap.replaceChildren(el("button", { class: "btn danger small", type: "button", onclick: rAsk }, "모든 동아리원 다시 입장시키기"));
  const rAsk = () => rWrap.replaceChildren(
    el("span", { class: "confirm", text: "모든 기기의 동아리원 입장이 풀려요. 계속할까요?" }),
    el("button", { class: "btn danger small", type: "button", onclick: async () => {
      try { await S.api.resetMembers(); rWrap.replaceChildren(el("p", { class: "msg ok", text: "모두 다시 입장해야 해요. 샌 기수 비밀번호도 위에서 바꿔 주세요." })); }
      catch (err) { rWrap.replaceChildren(el("p", { class: "msg err", text: friendly(err) })); }
    } }, "다시 입장시키기"),
    el("button", { class: "btn ghost small", type: "button", onclick: rIdle }, "취소"));
  rIdle();

  // 5) 사진 용량 (대략)
  const photoTotal = S.stars.reduce((n, s) => n + (s.photo_count || 0), 0);
  const estMB = photoTotal * 0.25;
  const pct = Math.min(100, estMB / 1024 * 100);

  show({ type: "settings" }, "Mission control", head("운영", "운영진 설정"),
    el("div", { class: "section" }, el("h3", { text: "새 기수 시작하기" }),
      el("p", { text: "새 기수가 들어오면 은하를 만들고, 그 기수가 쓸 비밀번호를 정해서 단톡방에 공유하세요." }), newForm),
    el("div", { class: "section" }, el("h3", { text: "기수 비밀번호" }),
      el("p", { text: "모든 기수 비밀번호는 계속 유효해요. 활동이 끝난 기수도 자기 비밀번호로 언제든 들어올 수 있어요." }), pwList),
    el("div", { class: "section" }, el("h3", { text: "운영진 비밀번호" }),
      el("p", { text: "회장이 바뀌면 새 회장이 여기서 바꾸세요. 바꾸면 다른 기기의 운영진 입장은 모두 풀려요." }), adminForm),
    el("div", { class: "section" }, el("h3", { text: "비밀번호가 밖으로 샜을 때" }),
      el("p", { text: "해당 기수 비밀번호를 바꾼 뒤 아래 버튼을 누르면, 이미 입장한 사람도 모두 새로 입장해야 해요." }), rWrap),
    el("div", { class: "section" }, el("h3", { text: "사진 저장 공간" }),
      el("div", { class: "meta" }, el("span", { text: `사진 ${photoTotal}장` }), el("span", { text: `약 ${estMB < 10 ? estMB.toFixed(1) : Math.round(estMB)}MB / 1GB (무료 한도)` })),
      el("div", { class: "meter", role: "img", "aria-label": `무료 한도의 약 ${pct.toFixed(0)}% 사용` }, el("i", { style: `width:${Math.max(pct, 0.5)}%` })),
      el("p", { text: "사진 한 장을 약 250KB로 계산한 대략적인 값이에요. 정확한 값은 Supabase 대시보드에서 볼 수 있어요." })),
    el("div", { class: "section" }, el("div", { class: "row" },
      el("button", { class: "btn ghost", type: "button", onclick: signOut }, "이 기기에서 나가기"))),
  );
}
function pwRow(gen, updatedAt) {
  const box = el("div", { class: "pwrow" });
  const g = S.galaxies.find(x => x.gen === gen);
  const label = el("div", { class: "l" }, el("span", { text: `${gen}기${g && g.name ? " · " + g.name : ""}` }),
    el("small", { text: updatedAt ? `설정됨 · ${fmtDate(String(updatedAt).slice(0, 10))} 변경` : "비밀번호 없음 · 이 기수로는 입장할 수 없어요" }));
  const idle = () => box.replaceChildren(label, el("button", { class: "btn ghost small", type: "button", onclick: edit }, updatedAt ? "바꾸기" : "정하기"));
  const edit = () => {
    const inp = el("input", { type: "text", autocomplete: "off", placeholder: "새 비밀번호 (6자 이상)", "aria-label": `${gen}기 새 비밀번호` });
    const m = msg();
    const save = el("button", { class: "btn small", type: "button" }, "저장");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { await S.api.setPassword("gen:" + gen, inp.value); updatedAt = new Date().toISOString(); idle(); box.append(el("p", { class: "msg ok", text: "저장했어요. 단톡방에 새 비밀번호를 공유하세요.", style: "flex-basis:100%" })); }
      catch (e) { say(m, friendly(e)); save.disabled = false; }
    });
    box.replaceChildren(label, el("div", { class: "row", style: "flex-basis:100%" }, el("div", { style: "flex:1;min-width:160px" }, inp), save,
      el("button", { class: "btn ghost small", type: "button", onclick: idle }, "취소")), m);
    inp.focus();
  };
  idle();
  return box;
}

/* ============================== 시작 ============================== */
async function boot() {
  const cfg = window.UNIVUS_CONFIG || {};
  const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;
  if (configured && !window.supabase) {
    S.loaded = true; S.loadError = new Error("Supabase 라이브러리를 불러오지 못했어요 (network)");
    renderChrome(); return;
  }
  S.api = configured ? makeSupabaseApi(cfg) : makeDemoApi();
  if (S.api.demo) {
    const b = $("#demoBanner");
    b.hidden = false;
    b.append(el("b", { text: "예시 모드" }), " · 아래 기록은 예시이고 저장되지 않아요. 비밀번호 1기 ", el("code", { text: "111111" }),
      " · 운영진 ", el("code", { text: "admin1234" }), ". config.js에 Supabase 주소를 넣으면 실제 사이트가 돼요.");
  }
  try { S.role = await S.api.myRole(); } catch { S.role = "guest"; }
  await reload();
  fitAll();
  if (reduceMotion) { cam.x = target.x; cam.y = target.y; cam.z = target.z; }
}
renderChrome();
boot();
})();
