// Vercel 서버 함수 (진열대 + 아카샤 합본)
//   /api/data?uid=123456789            → 진열대 정보 (Enka.Network)
//   /api/data?src=akasha&uid=123456789 → 아카샤 순위
// 이 파일은 반드시 api 폴더 안에 있어야 해요 (api/data.js).

const profileHandler = (function () {
  const module = { exports: {} };
// Vercel 서버 함수: /api/profile?uid=123456789
// Enka.Network 에서 진열대 정보를 받아와 사이트에서 쓰기 쉬운 모양으로 정리해 돌려줍니다.

const ENKA_URL = 'https://enka.network/api/uid/';
const STORE_BASES = [
  'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/',
  'https://cdn.jsdelivr.net/gh/EnkaNetwork/API-docs@master/store/'
];
const USER_AGENT = 'genshin-team-dps/1.0';
const STORE_TTL_MS = 6 * 60 * 60 * 1000; // 캐릭터 이름 데이터는 6시간마다 새로 받기

let storeCache = null;              // { chars, ko, en, at }
const profileCache = new Map();     // uid -> { body, exp }

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadStore() {
  if (storeCache && Date.now() - storeCache.at < STORE_TTL_MS) return storeCache;
  for (const base of STORE_BASES) {
    try {
      const [chars, loc] = await Promise.all([
        getJson(base + 'characters.json', 8000),
        getJson(base + 'loc.json', 12000)
      ]);
      storeCache = { chars, ko: loc.ko || {}, en: loc.en || {}, at: Date.now() };
      return storeCache;
    } catch (e) { /* 다음 주소로 시도 */ }
  }
  if (storeCache) return storeCache; // 오래된 캐시라도 사용
  return { chars: {}, ko: {}, en: {}, at: 0, failed: true };
}

const ELEMENT = { Fire: 'pyro', Water: 'hydro', Wind: 'anemo', Electric: 'electro', Grass: 'dendro', Ice: 'cryo', Rock: 'geo' };
const SLOT = { EQUIP_BRACER: 'flower', EQUIP_NECKLACE: 'plume', EQUIP_SHOES: 'sands', EQUIP_RING: 'goblet', EQUIP_DRESS: 'circlet' };
const SLOT_ORDER = ['flower', 'plume', 'sands', 'goblet', 'circlet'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeCharacter(a, store) {
  const key = a.skillDepotId ? `${a.avatarId}-${a.skillDepotId}` : null;
  const meta = (key && store.chars[key]) || store.chars[a.avatarId] || {};
  const hash = meta.NameTextMapHash;
  const nameKo = hash !== undefined ? store.ko[hash] : undefined;
  const nameEn = hash !== undefined ? store.en[hash] : undefined;
  const fp = a.fightPropMap || {};
  const pm = a.propMap || {};

  // 특성 레벨 (별자리로 +3 된 것까지 포함)
  const order = meta.SkillOrder || [];
  const proud = meta.ProudMap || {};
  const extra = a.proudSkillExtraLevelMap || {};
  const lv = (skillId) => {
    if (!skillId) return 1;
    const baseLv = num((a.skillLevelMap || {})[skillId]) || 1;
    const bonus = num(extra[proud[skillId]]);
    return baseLv + bonus;
  };
  const talents = { na: lv(order[0]), e: lv(order[1]), q: lv(order[2]) };

  let weapon = null;
  const artifacts = [];
  for (const it of a.equipList || []) {
    const f = it.flat || {};
    if (f.itemType === 'ITEM_WEAPON') {
      const stats = f.weaponStats || [];
      const baseStat = stats.find(s => s.appendPropId === 'FIGHT_PROP_BASE_ATTACK');
      const sub = stats.find(s => s.appendPropId !== 'FIGHT_PROP_BASE_ATTACK');
      const affix = (it.weapon && it.weapon.affixMap) ? Object.values(it.weapon.affixMap)[0] : 0;
      weapon = {
        id: it.itemId,
        name: store.ko[f.nameTextMapHash] || store.en[f.nameTextMapHash] || '무기',
        nameEn: store.en[f.nameTextMapHash] || '',
        level: num(it.weapon && it.weapon.level),
        refine: num(affix) + 1,
        rarity: num(f.rankLevel),
        icon: f.icon || '',
        baseAtk: baseStat ? num(baseStat.statValue) : 0,
        sub: sub ? { prop: sub.appendPropId, value: num(sub.statValue) } : null
      };
    } else if (f.itemType === 'ITEM_RELIQUARY') {
      const main = f.reliquaryMainstat || {};
      artifacts.push({
        slot: SLOT[f.equipType] || 'unknown',
        set: store.ko[f.setNameTextMapHash] || store.en[f.setNameTextMapHash] || '',
        setEn: store.en[f.setNameTextMapHash] || '',
        level: Math.max(0, num(it.reliquary && it.reliquary.level) - 1),
        rarity: num(f.rankLevel),
        icon: f.icon || '',
        main: { prop: main.mainPropId, value: num(main.statValue) },
        subs: (f.reliquarySubstats || []).map(s => ({ prop: s.appendPropId, value: num(s.statValue) }))
      });
    }
  }
  artifacts.sort((x, y) => SLOT_ORDER.indexOf(x.slot) - SLOT_ORDER.indexOf(y.slot));
  const sets = {};
  const setNames = {};
  for (const ar of artifacts) {
    const k = norm(ar.setEn || ar.set);
    if (!k) continue;
    sets[k] = (sets[k] || 0) + 1;
    setNames[k] = ar.set || ar.setEn;
  }

  const side = meta.SideIconName || '';
  return {
    id: a.avatarId,
    name: nameKo || nameEn || `캐릭터 ${a.avatarId}`,
    nameEn: nameEn || '',
    element: ELEMENT[meta.Element] || 'unknown',
    rarity: meta.QualityType === 'QUALITY_ORANGE' || meta.QualityType === 'QUALITY_ORANGE_SP' ? 5 : 4,
    icon: side ? side.replace('_Side_', '_') : '',
    sideIcon: side,
    level: num(pm['4001'] && pm['4001'].val) || 1,
    cons: (a.talentIdList || []).length,
    friendship: num(a.fetterInfo && a.fetterInfo.expLevel),
    talents,
    stats: {
      baseHp: num(fp['1']), hp: num(fp['2000']),
      baseAtk: num(fp['4']), atk: num(fp['2001']),
      baseDef: num(fp['7']), def: num(fp['2002']),
      cr: num(fp['20']), cd: num(fp['22']), er: num(fp['23']),
      heal: num(fp['26']), em: num(fp['28']),
      dmg: {
        physical: num(fp['30']), pyro: num(fp['40']), electro: num(fp['41']), hydro: num(fp['42']),
        dendro: num(fp['43']), anemo: num(fp['44']), geo: num(fp['45']), cryo: num(fp['46'])
      }
    },
    weapon,
    artifacts,
    sets,
    setNames
  };
}

const ENKA_ERRORS = {
  400: 'UID 형식이 잘못됐어요.',
  404: '해당 UID의 플레이어를 찾을 수 없어요.',
  424: '게임 점검 중이라 지금은 불러올 수 없어요.',
  429: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
  500: 'Enka 서버에 문제가 있어요. 잠시 후 다시 시도해 주세요.',
  503: 'Enka 서버에 문제가 있어요. 잠시 후 다시 시도해 주세요.'
};

module.exports = async function handler(req, res) {
  const uid = String((req.query && req.query.uid) || '').trim();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!/^\d{9,10}$/.test(uid)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'UID는 9~10자리 숫자예요.' }));
  }

  const cached = profileCache.get(uid);
  if (cached && cached.exp > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.end(cached.body);
  }

  let raw;
  try {
    const [enka] = await Promise.all([getJson(ENKA_URL + uid + '/', 10000), loadStore()]);
    raw = enka;
  } catch (e) {
    const status = e.status || 502;
    res.statusCode = status === 404 || status === 400 ? status : 502;
    const msg = ENKA_ERRORS[status] || (e.name === 'AbortError' ? 'Enka 서버 응답이 너무 느려요. 다시 시도해 주세요.' : '진열대 정보를 불러오지 못했어요.');
    return res.end(JSON.stringify({ error: msg, status }));
  }

  const store = await loadStore();
  const p = raw.playerInfo || {};
  const list = Array.isArray(raw.avatarInfoList) ? raw.avatarInfoList : [];
  const showList = Array.isArray(p.showAvatarInfoList) ? p.showAvatarInfoList : [];
  const nameOf = (id) => {
    const meta = store.chars[id] || {};
    const h = meta.NameTextMapHash;
    return (h !== undefined && (store.ko[h] || store.en[h])) || `캐릭터 ${id}`;
  };

  const body = {
    uid,
    ttl: num(raw.ttl) || 60,
    storeOk: !store.failed,
    player: {
      nickname: p.nickname || '여행자',
      level: num(p.level),
      worldLevel: num(p.worldLevel),
      signature: p.signature || '',
      achievements: num(p.finishAchievementNum),
      abyss: p.towerFloorIndex ? `${p.towerFloorIndex}-${p.towerLevelIndex}` : '',
      profileIcon: (() => {
        const pic = p.profilePicture || {};
        const meta = store.chars[pic.avatarId] || {};
        return meta.SideIconName ? meta.SideIconName.replace('_Side_', '_') : '';
      })()
    },
    detailsHidden: list.length === 0 && showList.length > 0,
    showcase: showList.map(s => ({ id: s.avatarId, level: num(s.level), name: nameOf(s.avatarId) })),
    characters: list.map(a => normalizeCharacter(a, store))
  };

  const text = JSON.stringify(body);
  profileCache.set(uid, { body: text, exp: Date.now() + body.ttl * 1000 });
  if (profileCache.size > 500) profileCache.delete(profileCache.keys().next().value);
  res.setHeader('Cache-Control', `public, max-age=${Math.min(body.ttl, 300)}`);
  res.end(text);
};

  return module.exports;
})();

const akashaHandler = (function () {
  const module = { exports: {} };
// Vercel 서버 함수: /api/akasha?uid=123456789
// 아카샤(akasha.cv)의 비공식 API에서 캐릭터별 순위를 받아 옵니다.
// 비공식이라 예고 없이 바뀔 수 있어요. 실패하면 화면에서는 "아카샤에서 보기" 링크만 보여 줍니다.
// 아카샤 서버에 부담을 주지 않도록 UID당 10분 동안 결과를 저장해 두고 재사용해요.

const AKASHA_API = 'https://akasha.cv/api/getCalculationsForUser/';
const USER_AGENT = 'genshin-team-dps/1.0';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // uid -> { body, exp }

function num(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalize(raw) {
  const list = Array.isArray(raw && raw.data) ? raw.data : Array.isArray(raw) ? raw : [];
  const chars = {};
  for (const entry of list) {
    const id = num(entry && entry.characterId);
    if (!id) continue;
    const calcs = entry.calculations && typeof entry.calculations === 'object' ? Object.values(entry.calculations) : [];
    const out = [];
    for (const c of calcs) {
      if (!c) continue;
      const ranking = num(c.ranking);
      const outOf = num(c.outOf);
      if (!ranking || !outOf) continue;
      out.push({
        name: String(c.name || c.short || '계산'),
        short: String(c.short || ''),
        variant: c.variant ? String(c.variant.displayName || c.variant.name || '') : '',
        weapon: c.weapon ? { name: String(c.weapon.name || ''), refinement: num(c.weapon.refinement) || 1 } : null,
        ranking,
        outOf,
        approx: typeof c.ranking === 'string' && c.ranking.includes('~'),
        topPercent: Math.min(100, (ranking / outOf) * 100)
      });
    }
    out.sort((a, b) => a.topPercent - b.topPercent);
    if (out.length) chars[id] = (chars[id] || []).concat(out).sort((a, b) => a.topPercent - b.topPercent);
  }
  return chars;
}

module.exports = async function handler(req, res) {
  const uid = String((req.query && req.query.uid) || '').trim();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!/^\d{9,10}$/.test(uid)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: 'UID는 9~10자리 숫자예요.' }));
  }
  const profileUrl = 'https://akasha.cv/profile/' + uid;

  const hit = cache.get(uid);
  if (hit && hit.exp > Date.now()) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.end(hit.body);
  }

  let body;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(AKASHA_API + uid, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    const chars = normalize(raw);
    body = JSON.stringify({ ok: true, profileUrl, chars, registered: Object.keys(chars).length > 0 });
  } catch (e) {
    // 실패해도 화면은 멀쩡히 돌아가도록 200 + ok:false 로 응답 (짧게만 저장)
    body = JSON.stringify({ ok: false, profileUrl, chars: {}, error: '아카샤 순위를 불러오지 못했어요.' });
    cache.set(uid, { body, exp: Date.now() + 60 * 1000 });
    return res.end(body);
  }

  cache.set(uid, { body, exp: Date.now() + CACHE_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(body);
};

module.exports.normalize = normalize;

  return module.exports;
})();

module.exports = async function handler(req, res) {
  const src = String((req.query && req.query.src) || '');
  if (src === 'akasha') return akashaHandler(req, res);
  return profileHandler(req, res);
};
