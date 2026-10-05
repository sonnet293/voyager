// js/doubleEngine.js
// 더블배틀(2:2 팀전) 판정 엔진. Firestore/DOM에 의존하지 않는 순수 계산만 담당한다.
// GM 브라우저(gm/gm.js)가 더블배틀 방(battleroom4~6)의 요청을 이 파일로 판정한다.
// 모든 함수는 room 스냅샷을 받아 { ok: true, update } 또는 { ok: false, reason }을 돌려준다.
//
// 진영: p1·p2 = 팀 t1, p3·p4 = 팀 t2. 플레이어마다 자기 포켓몬 1마리를 필드에 내보낸다.
// 라운드: 필드에 있는 포켓몬 전부가 동시에 주사위(1d10 + spd)를 굴려 높은 순서대로 한 번씩 행동한다.
// 기술 판정 규칙은 싱글배틀(js/engine.js)과 같고, 대상 선택과 범위 기술만 더블 전용이다.
//   - aoeEnemy: 상대 두 마리 모두 공격 / aoe: 자신을 제외한 필드 전체(아군 포함) 공격
//   - 범위 기술(aoe/aoeEnemy)은 최종 데미지가 SPREAD_MULT(75%)로 줄어든다.
// 행동 중 포켓몬이 쓰러지면 그 주인은 이번 라운드 행동을 잃고, 교체가 끝나면 남은 순서대로 라운드를 이어간다.
import { MOVES } from "./moves.js";
import { pokemonTypes } from "./typeChart.js";
import {
  applyStatus,
  applyVolatile,
  applyEndOfTurnStatusDamage,
  checkActionPrevented,
  checkConfusionInterrupt,
  josa,
} from "./effecthandler.js";
import { setHazard, applyHazardsOnSwitchIn, defaultField } from "./field.js";
import {
  setWeather,
  weatherPowerMultiplier,
  preventsFreeze,
  sandstormDefenseBonus,
  tickWeather,
  applyWeatherDamage,
} from "./weather.js";
import {
  defaultRanks,
  isMoveLocked,
  isTaunted,
  isThroatChopped,
  pickCount,
  rollD10,
  clampRank,
  rankMultiplier,
  getEffectiveRank,
  getDefenderTypeMultiplier,
  hasStab,
  isAlwaysHit,
  rollAccuracy,
  healRatio,
  rollEvasion,
  rollCrit,
  buildRankChangeMessage,
  targetsOpponent,
  futureSightDamage,
  clearOnSwitchOut,
  RANK_FIELD_MAP,
  SOUND_MOVES,
  FURY_CUTTER_MAX_POWER,
  FURY_CUTTER_MAX_STACK,
  SCREEN_TURNS,
  SCREEN_DAMAGE_MULT,
  COUNTER_MULT,
  VENOM_SHOCK_MULT,
  CONDITIONAL_POWER_MULT,
  GUTS_STATUSES,
  AQUA_RING_HEAL_RATIO,
  THROAT_CHOP_TURNS,
  TRI_ATTACK_STATUSES,
  FUTURE_SIGHT_DELAY,
  WISH_HEAL_RATIO,
  TRAP_MIN_TURNS,
  TRAP_MAX_TURNS,
  TRAP_DAMAGE_RATIO,
  GUARD_REPEAT_CHANCE,
  TAUNT_TURNS,
} from "./engine.js";

export { pickCount, isMoveLocked };

// 범위 기술(aoe/aoeEnemy)의 최종 데미지 배율
export const SPREAD_MULT = 0.75;

export const DOUBLE_SIDES = ["p1", "p2", "p3", "p4"];
export const TEAMS = { t1: ["p1", "p2"], t2: ["p3", "p4"] };

export const teamOf = (key) => (key === "p1" || key === "p2" ? "t1" : "t2");
export const otherTeam = (team) => (team === "t1" ? "t2" : "t1");
export const allyOf = (key) => ({ p1: "p2", p2: "p1", p3: "p4", p4: "p3" })[key];
export const enemiesOf = (key) => TEAMS[otherTeam(teamOf(key))];
export const slotOf = (key) => `player${key.slice(1)}`; // "p3" -> "player3"

const PER_SIDE_RESET = (k) => ({
  [`${slotOf(k)}_ready`]: false,
  [`${k}_entry`]: null,
  [`${k}_active_idx`]: 0,
  [`${k}_pending_switch`]: false,
  [`${k}_out`]: false,
  [`${k}_ranks`]: null,
  [`${k}_wish`]: null,
  [`${k}_future_sight`]: null,
  [`${k}_roll`]: null,
  [`${k}_select_action`]: null,
  [`intro_ready_${k}`]: false,
});

export const DOUBLE_RESET_FIELDS = {
  game_started: false,
  game_started_at: null,
  ...Object.assign({}, ...DOUBLE_SIDES.map(PER_SIDE_RESET)),
  t1_field: null,
  t2_field: null,
  weather: null,
  battle_turn: null,
  turn_order: null,
  turn_pos: 0,
  round_skip: [],
  round_closed: false,
  round_no: 0,
  battle_log: [],
  battle_event_log: [],
  battle_winner: null,
  intro_done: false,
  select_phase: false,
};

const ok = (update) => ({ ok: true, update });
const fail = (reason) => ({ ok: false, reason });

export function displayName(key, room) {
  return room?.[`${slotOf(key)}_name`] ?? `Player${key.slice(1)}`;
}

// "A & B" — 팀 이름
export function teamName(team, room) {
  return TEAMS[team].map((k) => displayName(k, room)).join(" & ");
}

// uid -> "p1"~"p4" | "spectator" | null
export function sideOfUid(room, uid) {
  if (!room || !uid) return null;
  const side = DOUBLE_SIDES.find((k) => room[`${slotOf(k)}_uid`] === uid);
  if (side) return side;
  if ((room.spectators ?? []).includes(uid)) return "spectator";
  return null;
}

// 클라이언트가 대상을 골라야 하는 기술인지 (범위 기술/자기 자신·필드 대상 기술은 고르지 않음)
export function needsTarget(moveData) {
  if (!moveData || moveData.aoe || moveData.aoeEnemy) return false;
  if (moveData.futureSight || moveData.counter) return true;
  if (moveData.spikyShield || moveData.defend || moveData.lightScreen || moveData.aquaRing || moveData.wish) return false;
  return targetsOpponent(moveData);
}

// ---- 판정 컨텍스트: room 스냅샷을 복사해 두고 고친 뒤 한 번에 update로 내보낸다 ----
function makeCtx(room) {
  const c = {
    room,
    turn: room.round_no ?? 1,
    turnPos: room.turn_pos ?? 0,
    entries: {},
    activeIdx: {},
    ranks: {},
    pending: {},
    out: {},
    wish: {},
    futureSight: {},
    fields: { t1: room.t1_field ?? defaultField(), t2: room.t2_field ?? defaultField() },
    weather: room.weather ?? null,
    log: [...(room.battle_log ?? [])],
    events: [...(room.battle_event_log ?? [])],
    skip: new Set(room.round_skip ?? []),
    extra: {}, // 라운드 진행 관련 필드 (battle_turn, turn_order, round_no ...)
  };
  for (const k of DOUBLE_SIDES) {
    c.entries[k] = [...(room[`${k}_entry`] ?? [])];
    c.activeIdx[k] = room[`${k}_active_idx`] ?? 0;
    c.ranks[k] = room[`${k}_ranks`] ?? defaultRanks();
    c.pending[k] = !!room[`${k}_pending_switch`];
    c.out[k] = !!room[`${k}_out`];
    c.wish[k] = room[`${k}_wish`] ?? null;
    c.futureSight[k] = room[`${k}_future_sight`] ?? null;
  }
  return c;
}

function commit(c) {
  const u = { ...c.extra };
  for (const k of DOUBLE_SIDES) {
    u[`${k}_entry`] = c.entries[k];
    u[`${k}_active_idx`] = c.activeIdx[k];
    u[`${k}_ranks`] = c.ranks[k];
    u[`${k}_pending_switch`] = c.pending[k];
    u[`${k}_out`] = c.out[k];
    u[`${k}_wish`] = c.wish[k];
    u[`${k}_future_sight`] = c.futureSight[k];
  }
  u.t1_field = c.fields.t1;
  u.t2_field = c.fields.t2;
  u.weather = c.weather;
  u.round_skip = [...c.skip];
  u.battle_log = c.log;
  u.battle_event_log = c.events;
  return ok(u);
}

const active = (c, k) => c.entries[k][c.activeIdx[k]];
const setActive = (c, k, p) => { c.entries[k][c.activeIdx[k]] = p; };
const pname = (p) => p?.name ?? "포켓몬";
// 필드에서 싸우고 있는지 (전멸하지 않았고 나와 있는 포켓몬이 살아 있음)
const inBattle = (c, k) => !c.out[k] && (active(c, k)?.hp ?? 0) > 0;
const hasAliveBench = (c, k) => c.entries[k].some((p, i) => i !== c.activeIdx[k] && p && p.hp > 0);
const anyPending = (c) => DOUBLE_SIDES.some((k) => c.pending[k]);

function pushHit(c, k, pokemon, hasAttacker, logIndex = c.log.length - 1, attacker = null) {
  const ev = { logIndex, type: "hit", side: k, hp: pokemon.hp, status: pokemon.status ?? null, hasAttacker };
  if (attacker) ev.attacker = attacker;
  c.events.push(ev);
}

function pushHeal(c, k, hp) {
  c.events.push({ logIndex: c.log.length - 1, type: "heal", side: k, hp });
}

// 교체 공통 처리(자발적/강제/유턴/울부짖기): 나가는 포켓몬 상태 정리 -> 내보내기 로그/연출 -> 장판 적용
function switchIn(c, k, targetIdx, recall) {
  const arr = c.entries[k];
  const prevIdx = c.activeIdx[k];
  const prev = arr[prevIdx];
  if (prev) arr[prevIdx] = clearOnSwitchOut(prev);
  c.activeIdx[k] = targetIdx;
  c.ranks[k] = defaultRanks(); // 교체하면 랭크 초기화

  const target = arr[targetIdx];
  const pName = displayName(k, c.room);
  const dn = pname(target);
  if (recall) c.log.push(`돌아와, ${pname(prev)}!`);
  c.log.push(`${pName}${josa(pName, "은는")} ${dn}${josa(dn, "을를")} 내보냈다!`);
  c.events.push({ logIndex: c.log.length - 1, type: "switch", side: k, idx: targetIdx });

  const hazard = applyHazardsOnSwitchIn(target, c.fields[teamOf(k)], c.turn);
  arr[targetIdx] = hazard.pokemon;
  hazard.messages.forEach((msg) => {
    c.log.push(msg);
    pushHit(c, k, hazard.pokemon, false);
  });
}

// 새로 쓰러진 포켓몬 처리. 남은 벤치가 있으면 교체 대기, 없으면 그 플레이어는 전멸(out).
// 쓰러진 쪽은 이번 라운드 남은 행동을 잃는다(skip). 한 팀의 두 플레이어가 모두 전멸하면 상대 팀 승리.
// first: 로그 순서를 정할 우선 확인 대상(공격 대상 -> 공격자). 반환: 승리 팀("t1"|"t2"|"draw") 또는 null
function checkFaints(c, first = [], actorKey = null) {
  const order = [...new Set([...first, ...DOUBLE_SIDES])];
  for (const k of order) {
    if (c.out[k] || c.pending[k]) continue;
    const pkmn = active(c, k);
    if (!pkmn || pkmn.hp > 0) continue;
    c.log.push(`${pname(pkmn)}${josa(pname(pkmn), "은는")} 쓰러졌다!`);
    c.skip.add(k);
    if (hasAliveBench(c, k)) {
      c.pending[k] = true;
    } else {
      c.out[k] = true;
      const n = displayName(k, c.room);
      c.log.push(`${n}의 포켓몬이 모두 쓰러졌다!`);
    }
  }
  const down = (team) => TEAMS[team].every((k) => c.out[k]);
  const t1Down = down("t1");
  const t2Down = down("t2");
  if (t1Down && t2Down) return actorKey ? teamOf(actorKey) : "draw";
  if (t1Down) return "t2";
  if (t2Down) return "t1";
  return null;
}

function setWinner(c, winner) {
  c.extra.battle_winner = winner;
  c.extra.battle_turn = null;
  for (const k of DOUBLE_SIDES) c.pending[k] = false;
  if (winner === "draw") c.log.push("승부가 나지 않았다!");
  else c.log.push(`${teamName(winner, c.room)} 승리!`);
}

// 다음 라운드: 필드에 있는 포켓몬 전부가 동시에 주사위를 굴려 (spd + 1d10) 높은 순서대로 행동 순서를 정한다.
function nextRound(c) {
  const sides = DOUBLE_SIDES.filter((k) => inBattle(c, k));
  const scored = sides.map((k) => {
    const roll = rollD10();
    return { k, roll, score: (active(c, k).spd ?? 0) + roll, tie: Math.random() };
  });
  scored.sort((a, b) => b.score - a.score || b.tie - a.tie);
  const order = scored.map((s) => s.k);

  for (const k of DOUBLE_SIDES) c.extra[`${k}_roll`] = scored.find((s) => s.k === k)?.roll ?? null;
  c.extra.turn_order = order;
  c.extra.turn_pos = 0;
  c.extra.battle_turn = order[0] ?? null;
  c.extra.round_no = c.turn + 1;
  c.extra.round_closed = false;
  c.skip = new Set();
  c.log.push(`${pname(active(c, order[0]))}의 선공!`);
}

// 이번 라운드 순서에서 다음으로 행동할 플레이어. 없으면 라운드 종료 처리.
function advance(c) {
  const order = c.room.turn_order ?? [];
  for (let i = c.turnPos + 1; i < order.length; i++) {
    const k = order[i];
    if (inBattle(c, k) && !c.skip.has(k)) {
      c.extra.battle_turn = k;
      c.extra.turn_pos = i;
      return;
    }
  }
  endRound(c);
}

// 행동 하나가 끝난 뒤: 쓰러짐/승패 -> 교체 대기면 멈춤 -> 아니면 다음 차례
function finish(c, first = [], actorKey = null) {
  const winner = checkFaints(c, first, actorKey);
  if (winner) setWinner(c, winner);
  else if (anyPending(c)) c.extra.battle_turn = null;
  else advance(c);
  return commit(c);
}

// 라운드 종료 처리 (싱글배틀 buildTurnAdvanceUpdate와 같은 순서). 필드의 포켓몬 모두에게 적용.
function endRound(c) {
  const live = (k) => inBattle(c, k);
  const turn = c.turn;

  // 미래예지: 예약된 라운드가 되면 그 플레이어 자리에 지금 나와 있는 포켓몬을 공격
  for (const k of DOUBLE_SIDES) {
    const fs = c.futureSight[k];
    if (!fs || turn < fs.hitTurn) continue;
    c.futureSight[k] = null;
    if (!live(k)) continue;
    const pkmn = active(c, k);
    const hit = futureSightDamage(fs, pkmn, c.weather?.type);
    const n = pname(pkmn);
    const updated = { ...pkmn, hp: Math.max(0, pkmn.hp - hit.dmg) };
    setActive(c, k, updated);
    c.log.push(`${n}${josa(n, "은는")} ${fs.name} 공격을 받았다!`);
    pushHit(c, k, updated, false);
    if (hit.typeMult === 0) c.log.push(`${n}에게는 효과가 없는 듯하다...`);
    else if (hit.typeMult > 1) c.log.push("효과가 굉장했다!");
    else if (hit.typeMult < 1) c.log.push("효과가 별로인 듯하다...");
  }

  // 희망사항
  for (const k of DOUBLE_SIDES) {
    const wish = c.wish[k];
    if (!wish || turn < wish.turn) continue;
    c.wish[k] = null;
    if (!live(k)) continue;
    const pkmn = active(c, k);
    c.log.push(`${wish.name}의 희망사항이 이루어졌다!`);
    const maxHp = pkmn.maxHp ?? pkmn.hp;
    const heal = Math.min(maxHp - pkmn.hp, Math.max(1, Math.round(maxHp * WISH_HEAL_RATIO)));
    const n = pname(pkmn);
    if (heal > 0) {
      setActive(c, k, { ...pkmn, hp: pkmn.hp + heal });
      c.log.push(`${n}의 체력이 회복되었다!`);
      pushHeal(c, k, pkmn.hp + heal);
    } else {
      c.log.push(`그러나 ${n}의 체력은 가득 차 있다!`);
    }
  }

  // 독/화상
  for (const k of DOUBLE_SIDES) {
    if (!live(k)) continue;
    const tick = applyEndOfTurnStatusDamage(active(c, k), turn);
    if (tick.damage > 0) {
      setActive(c, k, tick.pokemon);
      c.log.push(tick.message);
      pushHit(c, k, tick.pokemon, false);
    }
  }

  // 아쿠아링
  for (const k of DOUBLE_SIDES) {
    if (!live(k)) continue;
    const pkmn = active(c, k);
    if (!pkmn.aquaRing) continue;
    const maxHp = pkmn.maxHp ?? pkmn.hp;
    const heal = Math.min(maxHp - pkmn.hp, Math.max(1, Math.floor(maxHp * AQUA_RING_HEAL_RATIO)));
    if (heal <= 0) continue;
    setActive(c, k, { ...pkmn, hp: pkmn.hp + heal });
    const n = pname(pkmn);
    c.log.push(`${n}${josa(n, "은는")} 아쿠아링으로 체력을 회복했다!`);
    pushHeal(c, k, pkmn.hp + heal);
  }

  // 회오리불꽃류
  for (const k of DOUBLE_SIDES) {
    if (!live(k)) continue;
    const pkmn = active(c, k);
    if (!pkmn.trap) continue;
    const n = pname(pkmn);
    let updated = pkmn;
    if (turn <= pkmn.trap.expireTurn) {
      const damage = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * TRAP_DAMAGE_RATIO));
      updated = { ...updated, hp: Math.max(0, updated.hp - damage) };
      c.log.push(`${n}${josa(n, "은는")} ${pkmn.trap.name}의 데미지를 입었다!`);
      pushHit(c, k, updated, false);
    }
    if (turn >= pkmn.trap.expireTurn && updated.hp > 0) {
      updated = { ...updated, trap: null };
      c.log.push(`${n}${josa(n, "은는")} ${pkmn.trap.name}에서 벗어났다!`);
    }
    setActive(c, k, updated);
  }

  // 빛의장막/리플렉터, 도발, 지옥찌르기 만료
  for (const k of DOUBLE_SIDES) {
    if (!live(k)) continue;
    let pkmn = active(c, k);
    const n = pname(pkmn);
    if (pkmn.screen && turn >= pkmn.screen.expireTurn) {
      c.log.push(`${n}의 ${pkmn.screen.name}${josa(pkmn.screen.name, "이가")} 사라졌다!`);
      pkmn = { ...pkmn, screen: null };
    }
    if (pkmn.taunt && turn >= pkmn.taunt.expireTurn) {
      c.log.push(`${n}의 도발 효과가 풀렸다!`);
      pkmn = { ...pkmn, taunt: null };
    }
    if (pkmn.throatChop && turn >= pkmn.throatChop.expireTurn) {
      c.log.push(`${n}${josa(n, "은는")} 다시 소리 기술을 쓸 수 있게 되었다!`);
      pkmn = { ...pkmn, throatChop: null };
    }
    setActive(c, k, pkmn);
  }

  // 랭크 만료
  for (const k of DOUBLE_SIDES) {
    if (!live(k)) continue;
    const ranks = c.ranks[k];
    let newRanks = null;
    for (const stat of ["atk", "def", "evasion"]) {
      const data = ranks[stat];
      if (!data || data.value === 0 || turn < data.expireTurn) continue;
      newRanks = { ...(newRanks ?? ranks), [stat]: { value: 0, expireTurn: 0 } };
      const n = pname(active(c, k));
      const statLabel = stat === "evasion" ? "속도" : stat === "atk" ? "공격" : "방어";
      c.log.push(`${n}의 ${statLabel}${josa(statLabel, "이가")} 원래대로 돌아왔다!`);
    }
    if (newRanks) c.ranks[k] = newRanks;
  }

  // 날씨
  const weatherTick = tickWeather(c.weather, turn);
  if (weatherTick.active) {
    c.log.push(weatherTick.continueMessage);
    for (const k of DOUBLE_SIDES) {
      if (!live(k)) continue;
      const dmgResult = applyWeatherDamage(active(c, k), c.weather.type);
      if (dmgResult.damage > 0) {
        setActive(c, k, dmgResult.pokemon);
        c.log.push(dmgResult.message);
        pushHit(c, k, dmgResult.pokemon, false);
      }
    }
    if (weatherTick.expired) c.log.push(weatherTick.endMessage);
    c.weather = weatherTick.weather;
  }

  const winner = checkFaints(c);
  if (winner) {
    setWinner(c, winner);
    return;
  }
  if (anyPending(c)) {
    // 교체가 끝나면 이어갈 라운드가 없으므로 바로 다음 라운드 주사위
    c.extra.battle_turn = null;
    c.extra.round_closed = true;
    c.extra.turn_pos = (c.room.turn_order ?? []).length;
    return;
  }
  nextRound(c);
}

// ---- 게임 시작 / 포켓몬 선택 ----

// 네 명 모두 READY -> 게임 시작. 포켓몬 선택 단계(select_phase)부터 진행한다.
export function startGame(room) {
  if (room.game_started) return fail("시작 조건 아님");
  for (const k of DOUBLE_SIDES) {
    if (!room[`${slotOf(k)}_uid`]) return fail("플레이어 부족");
    if (!room[`${slotOf(k)}_ready`]) return fail("시작 조건 아님");
  }
  const update = {
    game_started: true,
    game_started_at: Date.now(),
    select_phase: true,
    intro_done: false,
    battle_winner: null,
  };
  for (const k of DOUBLE_SIDES) {
    update[`${k}_entry`] = null;
    update[`${k}_active_idx`] = 0;
    update[`${k}_select_action`] = null;
    update[`intro_ready_${k}`] = false; // 새 게임마다 인트로(네 명 터치 → VS 연출)를 처음부터
  }
  return ok(update);
}

// 더블배틀은 엔트리의 doubleMoves를 기술로 쓴다 (없으면 moves)
const doubleMovesOf = (mon) => (Array.isArray(mon?.doubleMoves) && mon.doubleMoves.length ? mon.doubleMoves : mon?.moves);

function validPicks(entry, picks) {
  if (!Array.isArray(picks) || picks.length !== pickCount(entry) || picks.length === 0) return false;
  if (new Set(picks).size !== picks.length) return false;
  return picks.every((i) => Number.isInteger(i) && i >= 0 && i < entry.length && entry[i]);
}

export function submitSelection(room, side, actionId, picks, entry) {
  if (!room.game_started || !room.select_phase) return fail("선택 단계가 아님");
  if (room[`${side}_select_action`]) return fail("이미 선택 완료");
  if (!validPicks(entry ?? [], picks)) return fail("잘못된 선택");
  const mons = picks.map((i) => entry[i]);
  const noHp = mons.find((p) => !Number.isFinite(p.hp) || p.hp <= 0);
  if (noHp) return fail(`${noHp.name ?? "포켓몬"}의 엔트리 데이터에 hp가 없음`);
  const noMoves = mons.find((p) => !doubleMovesOf(p)?.length);
  if (noMoves) return fail(`${noMoves.name ?? "포켓몬"}의 엔트리 데이터에 doubleMoves가 없음`);
  return ok({ [`${side}_select_action`]: actionId });
}

export function cancelSelection(room, side) {
  if (!room.game_started || !room.select_phase) return fail("선택 단계가 아님");
  if (!room[`${side}_select_action`]) return fail("선택 완료 상태가 아님");
  return ok({ [`${side}_select_action`]: null });
}

// 네 명의 선택이 끝나면 고른 순서대로 배틀 엔트리를 만든다 (첫 번째가 선봉).
// picksBySide: { p1: { entry, picks }, ... }
export function finishSelection(picksBySide) {
  const update = { select_phase: false };
  for (const k of DOUBLE_SIDES) {
    const { entry, picks } = picksBySide[k];
    update[`${k}_entry`] = picks.map((i) => {
      const { doubleMoves: _dm, ...mon } = entry[i];
      return { ...mon, moves: doubleMovesOf(entry[i]), maxHp: entry[i].hp };
    });
    update[`${k}_active_idx`] = 0;
  }
  return update;
}

// 인트로가 끝나면 player1이 요청: 첫 라운드 세팅 (네 마리 동시 주사위)
export function initRound(room) {
  if (!room.game_started || (room.round_no ?? 0) > 0 || room.battle_winner) return fail("이미 시작된 라운드");
  if (room.select_phase || DOUBLE_SIDES.some((k) => !room[`${k}_entry`]?.length)) return fail("포켓몬 선택이 끝나지 않음");

  const c = makeCtx(room);
  c.turn = 0;
  for (const k of DOUBLE_SIDES) {
    c.ranks[k] = defaultRanks();
    c.pending[k] = false;
    c.out[k] = false;
    c.wish[k] = null;
    c.futureSight[k] = null;
  }
  c.fields = { t1: defaultField(), t2: defaultField() };
  c.weather = null;
  c.events = [];
  const t1 = teamName("t1", room);
  const t2 = teamName("t2", room);
  c.log = [`${t1}${josa(t1, "과와")} ${t2}의 승부가 시작됐다!`];
  for (const k of DOUBLE_SIDES) {
    const n = displayName(k, room);
    const pn = pname(active(c, k));
    c.log.push(`${n}${josa(n, "은는")} ${pn}${josa(pn, "을를")} 내보냈다!`);
  }
  nextRound(c);
  return commit(c);
}

// ---- 기술 사용 ----

// 이번 기술이 맞을 대상 목록 (필드에 있는 포켓몬만). 범위 기술이 아니면 고른 상대 1마리,
// 고른 상대가 이미 쓰러졌으면 남은 상대에게.
function computeTargets(c, myKey, moveData, chosen) {
  const enemies = enemiesOf(myKey).filter((k) => inBattle(c, k));
  if (moveData.aoe) return [...enemies, allyOf(myKey)].filter((k) => inBattle(c, k));
  if (moveData.aoeEnemy) return enemies;
  if (!needsTarget(moveData)) return [];
  if (enemies.includes(chosen)) return [chosen];
  return enemies.slice(0, 1);
}

const effectivenessLine = (typeMult, dn, multi) => {
  if (typeMult === 0) return `${dn}에게는 효과가 없는 듯하다...`;
  if (typeMult > 1) return multi ? `${dn}에게 효과가 굉장했다!` : "효과가 굉장했다!";
  if (typeMult < 1) return multi ? `${dn}에게는 효과가 별로인 듯하다...` : "효과가 별로인 듯하다...";
  return null;
};

// 대상 하나에 대한 명중/데미지/부가효과 판정. 반환: { hit, missed, connected, dmg }
function hitOne(c, myKey, t, moveSlot, moveData, s) {
  let attacker = active(c, myKey);
  const attackerName = pname(attacker);
  let defender = active(c, t);
  const dn = pname(defender);
  const defGuard = defender.guard ?? null;
  const isDamaging = moveData.power > 0;

  // 방어/판별: 공격 기술을 막음 (방어 상태는 그 포켓몬의 다음 행동 때까지 유지)
  if (defGuard && !defGuard.spiky && isDamaging && !s.breaksProtection) {
    c.log.push(`${dn}${josa(dn, "은는")} 공격으로부터 몸을 지켰다!`);
    return { hit: false, missed: false, connected: false, dmg: 0 };
  }
  // 니들가드: 상대를 노리는 기술을 막고, 사용한 쪽이 최대 체력의 1/8 데미지
  if (defGuard?.spiky && targetsOpponent(moveData) && !s.breaksProtection) {
    c.log.push(`${dn}${josa(dn, "은는")} 몸을 지켰다!`);
    if (attacker.hp > 0) {
      const spikeDmg = Math.max(1, Math.floor((attacker.maxHp ?? attacker.hp) / 8));
      attacker = { ...attacker, hp: Math.max(0, attacker.hp - spikeDmg) };
      setActive(c, myKey, attacker);
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 가시에 찔려 데미지를 입었다!`);
      pushHit(c, myKey, attacker, false);
    }
    return { hit: false, missed: false, connected: false, dmg: 0 };
  }
  // 고스트다이브로 사라진 상대
  if (defender.ghostDive && targetsOpponent(moveData)) {
    c.log.push(`${dn}에게는 맞지 않았다!`);
    return { hit: false, missed: true, connected: false, dmg: 0 };
  }
  // 고스트다이브 강제 공격은 방어 상태를 없앰
  if (s.breaksProtection && defGuard) {
    defender = { ...defender, guard: null };
    setActive(c, t, defender);
    c.log.push(`${dn}의 ${defGuard.name}${josa(defGuard.name, "이가")} 사라졌다!`);
  }

  const weatherType = c.weather?.type;
  if (!rollAccuracy(moveData, weatherType)) {
    c.log.push(s.multi ? `${dn}에게는 빗나갔다!` : `그러나 ${attackerName}의 공격은 빗나갔다!`);
    return { hit: false, missed: true, connected: false, dmg: 0 };
  }
  if (!isAlwaysHit(moveData, weatherType) && rollEvasion(attacker, defender, c.ranks[t], c.turn)) {
    c.log.push(`${dn}에게는 맞지 않았다!`);
    return { hit: false, missed: true, connected: false, dmg: 0 };
  }

  const atkMult = rankMultiplier(getEffectiveRank(c.ranks[myKey], "atk", c.turn));
  const sandDefBonus = sandstormDefenseBonus(defender, weatherType);
  const defMult = rankMultiplier(clampRank(getEffectiveRank(c.ranks[t], "def", c.turn) + sandDefBonus));
  const typeMult = getDefenderTypeMultiplier(moveData.type, pokemonTypes(defender));
  const stab = hasStab(pokemonTypes(attacker), moveData.type) ? 1.3 : 1;
  const weatherMult = weatherPowerMultiplier(weatherType, moveData.type);
  const spreadMult = s.spread ? SPREAD_MULT : 1;

  let updated = { ...defender };
  const connected = typeMult > 0;
  let dmg = 0;

  if (moveData.breakBarrier && updated.screen && typeMult > 0) {
    const screenName = updated.screen.name;
    updated = { ...updated, screen: null };
    c.log.push(`${dn}의 ${screenName}${josa(screenName, "이가")} 깨졌다!`);
  }

  if (isDamaging) {
    let power = moveData.power;
    if (moveData.avalanche && attacker.lastHitRound === c.turn) power = 70;
    if (moveData.venomShock && defender.status === "독") power = Math.round(power * VENOM_SHOCK_MULT);
    if (moveData.stomping && attacker.missedRound === c.turn - 1) power = Math.round(power * CONDITIONAL_POWER_MULT);
    if (moveData.guts && GUTS_STATUSES.includes(attacker.status)) power = Math.round(power * CONDITIONAL_POWER_MULT);
    if (moveData.saltWater && defender.hp * 2 <= (defender.maxHp ?? defender.hp)) power = Math.round(power * CONDITIONAL_POWER_MULT);
    if (moveData.sickPower && defender.status) power = Math.round(power * CONDITIONAL_POWER_MULT);
    if (moveData.furyCutter) power = Math.min(FURY_CUTTER_MAX_POWER, moveData.power + 10 * (attacker.furyCutter ?? 0));

    const counterDmg = moveData.counter ? Math.round((attacker.lastDamageTaken ?? 0) * COUNTER_MULT) : null;
    const multiHit = moveData.multiHit;
    const hitCount = multiHit ? multiHit.min + Math.floor(Math.random() * (multiHit.max - multiHit.min + 1)) : 1;
    const screenMult = updated.screen ? SCREEN_DAMAGE_MULT : 1;
    let newHp = updated.hp;
    let hits = 0;
    while (hits < hitCount && newHp > 0) {
      let hitDmg;
      let isCrit = false;
      if (counterDmg !== null) {
        hitDmg = typeMult === 0 ? 0 : Math.round(counterDmg * spreadMult);
      } else if (multiHit?.fixedDamage) {
        hitDmg = typeMult === 0 ? 0 : Math.round(multiHit.fixedDamage * spreadMult);
      } else {
        const rawDamage =
          (power + attacker.atk * 4 + rollD10()) * atkMult * typeMult * stab * weatherMult -
          defender.def * 3 * defMult;
        isCrit = rollCrit(attacker);
        hitDmg = Math.max(0, Math.round(rawDamage * (isCrit ? 1.5 : 1) * screenMult * spreadMult));
      }
      newHp = Math.max(0, newHp - hitDmg);
      dmg += hitDmg;
      hits++;
      if (isCrit && hitDmg > 0) c.log.push(s.multi ? `${dn}의 급소에 맞았다!` : "급소에 맞았다!");
      if (typeMult === 0) break;
    }

    updated = { ...updated, hp: newHp, lastHitRound: c.turn, lastDamageTaken: dmg, lastHitBy: myKey };
    pushHit(c, t, { ...updated, status: defender.status ?? null }, true, s.moveLogIndex, myKey);

    const eff = effectivenessLine(typeMult, dn, s.multi);
    if (eff) c.log.push(eff);
    if (multiHit && typeMult > 0) c.log.push(`${hits}번 맞았다!`);
  }

  // 불꽃세례 등: 얼어 있는 상대를 맞히면 얼음이 녹음
  if (isDamaging && typeMult > 0 && moveData.effect?.thawEnemy && updated.hp > 0 && updated.status === "얼음") {
    updated = { ...updated, status: null, statusData: {} };
    c.log.push(`${dn}의 얼음이 녹았다!`);
    c.events.push({ logIndex: c.log.length - 1, type: "status", side: t, status: null });
  }

  // 상태이상 / 상태변화
  let effectBlocked = false;
  if (moveData.effect && (moveData.effect.status || moveData.effect.triAttack || moveData.effect.volatile)) {
    if (isDamaging) {
      effectBlocked = typeMult === 0 || updated.hp <= 0;
    } else if ((moveData.typeImmune && typeMult === 0) || (moveData.poisonPowder && pokemonTypes(updated).includes("풀"))) {
      effectBlocked = true;
      c.log.push(`${dn}에게는 효과가 없는 듯하다...`);
    }
  }
  if (moveData.effect && !effectBlocked && Math.random() < moveData.effect.chance) {
    const statusName = moveData.effect.triAttack
      ? TRI_ATTACK_STATUSES[Math.floor(Math.random() * TRI_ATTACK_STATUSES.length)]
      : moveData.effect.status;
    if (statusName) {
      if (!(statusName === "얼음" && preventsFreeze(weatherType))) {
        const statusResult = applyStatus(updated, statusName, c.turn);
        updated = statusResult.pokemon;
        if (statusResult.message && (statusResult.applied || !isDamaging)) c.log.push(statusResult.message);
        if (statusResult.applied) c.events.push({ logIndex: c.log.length - 1, type: "status", side: t, status: updated.status });
      }
    } else if (moveData.effect.volatile) {
      const volName = moveData.effect.volatile;
      if (updated.volatiles?.[volName]) {
        if (!isDamaging) c.log.push(`${dn}${josa(dn, "은는")} 이미 ${volName} 상태다!`);
      } else {
        updated = applyVolatile(updated, volName);
        c.log.push(`${dn}${josa(dn, "은는")} ${volName} 상태가 되었다!`);
      }
    }
  }

  if (moveData.throatChop && typeMult > 0 && updated.hp > 0) {
    updated = { ...updated, throatChop: { startTurn: c.turn + 1, expireTurn: c.turn + THROAT_CHOP_TURNS } };
    c.log.push(`${dn}${josa(dn, "은는")} 소리 기술을 쓸 수 없게 되었다!`);
  }

  if (moveData.trap && isDamaging && typeMult > 0 && updated.hp > 0 && !updated.trap) {
    const turns = TRAP_MIN_TURNS + Math.floor(Math.random() * (TRAP_MAX_TURNS - TRAP_MIN_TURNS + 1));
    updated = { ...updated, trap: { name: moveSlot.name, expireTurn: c.turn + turns - 1 } };
    c.log.push(`${dn}${josa(dn, "은는")} ${moveSlot.name}에 갇혔다!`);
  }

  if (moveData.taunt) {
    if (updated.taunt && c.turn <= updated.taunt.expireTurn) {
      c.log.push("그러나 실패했다!");
    } else {
      updated = { ...updated, taunt: { startTurn: c.turn + 1, expireTurn: c.turn + TAUNT_TURNS } };
      c.log.push(`${dn}${josa(dn, "은는")} 도발에 넘어갔다!`);
    }
  }

  setActive(c, t, updated);

  // 상대 랭크 변화 (대상마다 따로 확률 판정)
  if (moveData.rank && !(isDamaging && typeMult === 0) && Math.random() < (moveData.rank.chance ?? 1)) {
    applyRankChanges(c, moveData.rank, false, t, isDamaging);
  }

  // 힘흡수: 대상의 공격력 × 배수만큼 회복
  if (moveData.strengthSap) {
    const cur = active(c, myKey);
    const maxHp = cur.maxHp ?? cur.hp;
    const sapMult = typeof moveData.strengthSap === "number" ? moveData.strengthSap : 1;
    const heal = Math.min(maxHp - cur.hp, Math.max(0, Math.round((defender.atk ?? 0) * sapMult)));
    if (heal > 0) {
      setActive(c, myKey, { ...cur, hp: cur.hp + heal });
      c.log.push(`${dn}의 힘을 흡수했다!`);
      pushHeal(c, myKey, cur.hp + heal);
    } else {
      c.log.push(`그러나 ${attackerName}의 체력은 가득 차 있다!`);
    }
  }

  // 울부짖기류: 대상 플레이어의 벤치 포켓몬 중 랜덤 1마리와 강제 교체
  if (moveData.roar) {
    const benchIdxs = c.entries[t]
      .map((p, i) => (i !== c.activeIdx[t] && p && p.hp > 0 ? i : -1))
      .filter((i) => i >= 0);
    if (benchIdxs.length === 0 || updated.hp <= 0) {
      c.log.push("그러나 실패했다!");
    } else {
      const targetIdx = benchIdxs[Math.floor(Math.random() * benchIdxs.length)];
      c.log.push(`${dn}${josa(dn, "은는")} 강제로 돌아갔다!`);
      switchIn(c, t, targetIdx, false);
    }
  }

  return { hit: true, missed: false, connected, dmg };
}

// 랭크 변화 적용. self=true면 자신 쪽 필드(atk/def/spd), 아니면 대상 쪽 필드(targetAtk...)만.
function applyRankChanges(c, rank, self, targetKey, isDamaging) {
  for (const [field, { self: isSelf, stat }] of Object.entries(RANK_FIELD_MAP)) {
    if (isSelf !== self) continue;
    const value = rank[field];
    if (!value) continue;
    const pkmn = active(c, targetKey);
    if (!self && isDamaging && (pkmn?.hp ?? 0) <= 0) continue;
    const oldValue = getEffectiveRank(c.ranks[targetKey], stat, c.turn);
    const newValue = clampRank(oldValue + value);
    c.ranks[targetKey] = { ...c.ranks[targetKey], [stat]: { value: newValue, expireTurn: c.turn + rank.turns } };
    const statLabel = stat === "evasion" ? "속도" : stat === "atk" ? "공격" : "방어";
    c.log.push(buildRankChangeMessage(pname(pkmn), statLabel, oldValue, newValue, value > 0));
  }
}

const hasSelfRank = (rank) => !!rank && Object.entries(RANK_FIELD_MAP).some(([f, { self }]) => self && rank[f]);

// 일반 기술 판정 (대상 여럿이면 대상마다 hitOne). 반환: { targets, anyHit, anyConnected, allMissed }
function performMove(c, myKey, moveSlot, moveData, chosenTarget, breaksProtection) {
  const attackerName = pname(active(c, myKey));
  c.log.push(`${attackerName}의 ${moveSlot.name}!`);
  const moveLogIndex = c.log.length - 1;
  const targets = computeTargets(c, myKey, moveData, chosenTarget);
  const isDamaging = moveData.power > 0;
  const res = { targets, anyHit: false, anyConnected: false, allMissed: false };

  if (targets.length === 0) {
    if (needsTarget(moveData)) {
      c.log.push("그러나 실패했다!");
      return res;
    }
    // 자신/필드 대상 기술: 상대 회피 없이 명중률만 판정
    if (!rollAccuracy(moveData, c.weather?.type)) {
      c.log.push(`그러나 ${attackerName}의 공격은 빗나갔다!`);
      res.allMissed = true;
      return res;
    }
    res.anyHit = true;
    res.anyConnected = true;
  } else {
    const s = {
      multi: targets.length > 1,
      spread: !!(moveData.aoe || moveData.aoeEnemy),
      moveLogIndex,
      breaksProtection,
    };
    let totalDmg = 0;
    let missed = 0;
    for (const t of targets) {
      if (!inBattle(c, t)) continue; // 앞선 판정(울부짖기 등)으로 빠졌으면 건너뜀
      const r = hitOne(c, myKey, t, moveSlot, moveData, s);
      if (r.missed) missed++;
      if (r.hit) res.anyHit = true;
      if (r.connected) res.anyConnected = true;
      totalDmg += r.dmg;
    }
    res.allMissed = missed === targets.length;

    const cur = () => active(c, myKey);
    // 흡수기: 준 데미지 합계 x drain 만큼 회복
    if (moveData.effect?.drain && totalDmg > 0 && cur().hp > 0) {
      const a = cur();
      const maxHp = a.maxHp ?? a.hp;
      const heal = Math.min(maxHp - a.hp, Math.max(1, Math.round(totalDmg * moveData.effect.drain)));
      if (heal > 0) {
        setActive(c, myKey, { ...a, hp: a.hp + heal });
        c.log.push(targets.length === 1
          ? `${pname(active(c, targets[0]))}의 체력을 흡수했다!`
          : `${attackerName}${josa(attackerName, "은는")} 체력을 흡수했다!`);
        pushHeal(c, myKey, a.hp + heal);
      }
    }
    // 반동기: 준 데미지 합계 x recoil
    if (moveData.effect?.recoil && totalDmg > 0 && cur().hp > 0) {
      const a = cur();
      const recoilDmg = Math.max(1, Math.round(totalDmg * moveData.effect.recoil));
      const updated = { ...a, hp: Math.max(0, a.hp - recoilDmg) };
      setActive(c, myKey, updated);
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 반동으로 데미지를 입었다!`);
      pushHit(c, myKey, updated, false);
    }
    // 최대 HP 비례 반동기 (맞힌 대상이 있으면 한 번)
    if (moveData.effect?.recoilMaxHp && isDamaging && res.anyHit && cur().hp > 0) {
      const a = cur();
      const recoilDmg = Math.max(1, Math.round((a.maxHp ?? a.hp) * moveData.effect.recoilMaxHp));
      const updated = { ...a, hp: Math.max(0, a.hp - recoilDmg) };
      setActive(c, myKey, updated);
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 반동으로 데미지를 입었다!`);
      pushHit(c, myKey, updated, false);
    }
  }

  if (!res.anyHit) return res;

  // 장판: 상대 팀 진영에 한 번만 설치
  if (moveData.field) {
    const team = otherTeam(teamOf(myKey));
    const hazardResult = setHazard(c.fields[team], moveData.field);
    c.fields[team] = hazardResult.field;
    if (hazardResult.message && (hazardResult.applied || !isDamaging)) c.log.push(hazardResult.message);
  }

  // 날씨
  if (moveData.effect?.weather) {
    const weatherResult = setWeather(moveData.effect.weather, moveData.effect.weatherTurns ?? 5, c.turn);
    c.weather = weatherResult.weather;
    if (weatherResult.message) c.log.push(weatherResult.message);
  }

  // 자신 랭크 변화 (한 번만 판정)
  if (hasSelfRank(moveData.rank) && !(isDamaging && !res.anyConnected) && active(c, myKey).hp > 0 &&
      Math.random() < (moveData.rank.chance ?? 1)) {
    applyRankChanges(c, moveData.rank, true, myKey, isDamaging);
  }

  return res;
}

// targetKey: 고른 대상(p1~p4). uTurnIdx: 유턴류로 공격 후 교체해 들어갈 벤치 번호.
export function useMove(room, myKey, moveIdx, targetKey = null, uTurnIdx = null) {
  if (room.battle_winner) return fail("이미 끝난 배틀");
  if (room.battle_turn !== myKey) return fail("내 턴이 아님");

  const c = makeCtx(room);
  const attacker = active(c, myKey);
  if (!attacker || attacker.hp <= 0) return fail("포켓몬 없음");

  const diving = attacker.ghostDive ?? null;
  if (diving) moveIdx = diving.moveIdx;

  const moveSlot = attacker.moves?.[moveIdx];
  if (!moveSlot) return fail("기술 없음");
  if (!diving && (moveSlot.pp ?? 0) <= 0) return fail("PP 없음");

  const moveData = MOVES[moveSlot.name];
  if (!moveData) return fail(`moves.js에 "${moveSlot.name}" 기술이 정의되어 있지 않음`);

  if (!diving && isMoveLocked(attacker, moveSlot.name, c.turn)) {
    if (isThroatChopped(attacker, c.turn) && SOUND_MOVES.has(moveSlot.name)) {
      return fail(`지옥찌르기 효과로 ${moveSlot.name}은(는) 사용할 수 없음`);
    }
    return fail(isTaunted(attacker, c.turn)
      ? `도발 상태라 ${moveSlot.name}은(는) 사용할 수 없음`
      : `${moveSlot.name}은(는) 이번 라운드에 사용할 수 없음`);
  }

  const myBenchAlive = hasAliveBench(c, myKey);
  if (moveData.uTurn && myBenchAlive) {
    const t = c.entries[myKey][uTurnIdx];
    if (!Number.isInteger(uTurnIdx) || uTurnIdx === c.activeIdx[myKey] || !t || t.hp <= 0) return fail("유턴 교체 대상이 올바르지 않음");
  }

  // 고스트다이브: 사라질 때 고른 대상을 강제 공격 때 다시 노림
  if (diving && diving.target) targetKey = diving.target;
  // 카운터: 마지막으로 나를 때린 상대에게 되돌려줌
  if (moveData.counter && attacker.lastHitBy && enemiesOf(myKey).includes(attacker.lastHitBy) && inBattle(c, attacker.lastHitBy)) {
    targetKey = attacker.lastHitBy;
  }

  // PP 소모 + 방어류는 자신의 다음 행동이 오면 풀림
  const newMoves = [...attacker.moves];
  if (!diving) newMoves[moveIdx] = { ...moveSlot, pp: moveSlot.pp - 1 };
  let cur = { ...attacker, moves: newMoves, guard: null };
  setActive(c, myKey, cur);

  let guardSucceeded = false;
  let moveMissed = false;
  let furyCutterHit = false;
  let connected = false;
  let targets = [];

  const gate = checkActionPrevented(cur);
  cur = gate.pokemon;
  let blocked = !gate.canAct;
  if (gate.message) c.log.push(gate.message);
  if (gate.message && (gate.pokemon.status ?? null) !== (attacker.status ?? null)) {
    c.events.push({ logIndex: c.log.length - 1, type: "status", side: myKey, status: gate.pokemon.status ?? null });
  }
  if (gate.canAct && cur.volatiles?.["혼란"]) {
    const confusion = checkConfusionInterrupt(cur);
    cur = confusion.pokemon;
    if (confusion.message) c.log.push(confusion.message);
    if (confusion.confused) {
      blocked = true;
      pushHit(c, myKey, cur, false);
    }
  }

  const breaksProtection = !!(diving && moveData.ghostDive);
  if (diving) cur = { ...cur, ghostDive: null };
  setActive(c, myKey, cur);

  const attackerName = pname(cur);
  if (blocked) {
    // 행동 저지 (혼란 자해로 쓰러졌으면 finish에서 처리)
  } else if (moveData.ghostDive && !diving) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    c.log.push(`${attackerName}${josa(attackerName, "은는")} 어디론가 사라졌다!`);
    setActive(c, myKey, { ...cur, ghostDive: { moveIdx, target: targetKey ?? null } });
  } else if (moveData.spikyShield || moveData.defend) {
    // 방어류: 자신의 다음 행동 전까지 들어오는 기술을 막음. 직전 행동도 방어류 성공이었으면 성공률 감소
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    const chance = cur.guardStreak ? GUARD_REPEAT_CHANCE : 1;
    if (Math.random() < chance) {
      const spiky = !!moveData.spikyShield;
      setActive(c, myKey, { ...cur, guard: { name: moveSlot.name, spiky } });
      guardSucceeded = true;
      c.log.push(spiky
        ? `${attackerName}${josa(attackerName, "은는")} 가시로 몸을 지켰다!`
        : `${attackerName}${josa(attackerName, "은는")} 방어 태세에 들어갔다!`);
    } else {
      c.log.push("그러나 실패했다!");
    }
  } else if (moveData.lightScreen) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    if (cur.screen) {
      c.log.push("그러나 실패했다!");
    } else {
      setActive(c, myKey, { ...cur, screen: { name: moveSlot.name, appliedTurn: c.turn, expireTurn: c.turn + SCREEN_TURNS } });
      c.log.push(`${attackerName}${josa(attackerName, "은는")} ${moveSlot.name}${josa(moveSlot.name, "으로")} 받는 데미지가 줄어들었다!`);
    }
  } else if (moveData.aquaRing) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    if (cur.aquaRing) {
      c.log.push("그러나 실패했다!");
    } else {
      setActive(c, myKey, { ...cur, aquaRing: true });
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 물의 베일을 둘렀다!`);
    }
  } else if (moveData.futureSight) {
    // 미래예지: 고른 상대 플레이어 자리에 예약 (그때 그 자리에 나와 있는 포켓몬을 공격)
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    const t = computeTargets(c, myKey, moveData, targetKey)[0];
    if (!t || c.futureSight[t]) {
      c.log.push("그러나 실패했다!");
    } else {
      c.futureSight[t] = {
        name: moveSlot.name,
        hitTurn: c.turn + FUTURE_SIGHT_DELAY,
        power: moveData.power,
        type: moveData.type,
        atk: cur.atk,
        attackerTypes: pokemonTypes(cur),
      };
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 미래를 내다보았다!`);
    }
  } else if (moveData.wish) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    if (c.wish[myKey]) {
      c.log.push("그러나 실패했다!");
    } else {
      c.wish[myKey] = { name: attackerName, turn: c.turn + 1 };
      c.log.push(`${attackerName}${josa(attackerName, "은는")} 소원을 빌었다!`);
    }
  } else if (moveData.effect?.heal) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    const maxHp = cur.maxHp ?? cur.hp;
    const ratio = healRatio(moveData.effect.heal, c.weather?.type);
    const heal = Math.min(maxHp - cur.hp, Math.max(1, Math.round(maxHp * ratio)));
    if (heal > 0) {
      setActive(c, myKey, { ...cur, hp: cur.hp + heal });
      c.log.push(`${attackerName}의 체력이 회복되었다!`);
      pushHeal(c, myKey, cur.hp + heal);
    } else {
      c.log.push(`그러나 ${attackerName}의 체력은 가득 차 있다!`);
    }
  } else if (moveData.counter && !cur.lastDamageTaken) {
    c.log.push(`${attackerName}의 ${moveSlot.name}!`);
    c.log.push("그러나 실패했다!");
  } else {
    const res = performMove(c, myKey, moveSlot, moveData, targetKey, breaksProtection);
    targets = res.targets;
    connected = res.anyConnected;
    moveMissed = res.allMissed;
    furyCutterHit = !!moveData.furyCutter && res.anyHit && moveData.power > 0;
  }

  // 연속자르기 누적 / 방어류 연속 사용 기록
  {
    const a = active(c, myKey);
    const nextFury = furyCutterHit ? Math.min((a.furyCutter ?? 0) + 1, FURY_CUTTER_MAX_STACK) : 0;
    if ((a.furyCutter ?? 0) !== nextFury || !!a.guardStreak !== guardSucceeded) {
      setActive(c, myKey, { ...a, furyCutter: nextFury, guardStreak: guardSucceeded });
    }
  }
  if (moveMissed) setActive(c, myKey, { ...active(c, myKey), missedRound: c.turn });
  if (moveData.heavyHammer && !blocked) {
    setActive(c, myKey, { ...active(c, myKey), moveLock: { name: moveSlot.name, turn: c.turn + 1 } });
  }
  if (moveData.counter && !blocked && active(c, myKey).lastDamageTaken) {
    setActive(c, myKey, { ...active(c, myKey), lastDamageTaken: 0 });
  }

  // 유턴: 맞힌 대상이 있을 때만 곧바로 교체
  if (moveData.uTurn && connected && myBenchAlive && Number.isInteger(uTurnIdx) && active(c, myKey).hp > 0) {
    switchIn(c, myKey, uTurnIdx, true);
  }

  return finish(c, [...targets, myKey], myKey);
}

// 벤치 포켓몬 교체.
// - 교체 대기(쓰러져서 강제 교체) 중이면 행동 소모 없이 바로 교체. 모두 교체를 마치면 라운드를 이어감.
// - 평상시엔 내 차례(행동) 하나를 소모함.
export function switchPokemon(room, myKey, targetIdx) {
  if (room.battle_winner) return fail("이미 끝난 배틀");
  const pending = !!room[`${myKey}_pending_switch`];
  if (!pending && room.battle_turn !== myKey) return fail("내 턴이 아님");

  const c = makeCtx(room);
  const arr = c.entries[myKey];
  const target = arr[targetIdx];
  const cur = active(c, myKey);

  if (!target || target.hp <= 0) return fail("쓰러진 포켓몬");
  if (!pending && targetIdx === c.activeIdx[myKey]) return fail("이미 출전 중");
  if (!pending && cur?.ghostDive) return fail("고스트다이브 중에는 교체 불가");
  if (!pending && cur?.trap) return fail(`${cur.trap.name}에 갇혀 있어 교체 불가`);

  if (pending) c.pending[myKey] = false;
  switchIn(c, myKey, targetIdx, !pending);

  if (!pending) return finish(c, [myKey], myKey);

  // 강제 교체: 들어오자마자 장판으로 쓰러질 수도 있음
  const winner = checkFaints(c, [myKey]);
  if (winner) setWinner(c, winner);
  else if (anyPending(c)) c.extra.battle_turn = null;
  else if (room.round_closed) nextRound(c);
  else advance(c);
  return commit(c);
}

// 전투 종료 후 LEAVE: 내 슬롯을 비우고(관전자가 있으면 그 자리로 승격) 다음 게임을 위해 전투 필드를 초기화.
export function leaveBattle(room, uid) {
  if (!room.battle_winner) return fail("전투가 끝나지 않음");

  const update = { ...DOUBLE_RESET_FIELDS };
  const spectators = room.spectators ?? [];
  const spectatorNames = room.spectator_names ?? [];
  const side = sideOfUid(room, uid);

  if (side && side !== "spectator") {
    const slot = slotOf(side);
    if (spectators.length > 0) {
      const randIdx = Math.floor(Math.random() * spectators.length);
      update[`${slot}_uid`] = spectators[randIdx];
      update[`${slot}_name`] = spectatorNames[randIdx];
      update.spectators = spectators.filter((_, i) => i !== randIdx);
      update.spectator_names = spectatorNames.filter((_, i) => i !== randIdx);
    } else {
      update[`${slot}_uid`] = null;
      update[`${slot}_name`] = null;
    }
  } else if (side === "spectator") {
    const idx = spectators.indexOf(uid);
    update.spectators = spectators.filter((_, i) => i !== idx);
    update.spectator_names = spectatorNames.filter((_, i) => i !== idx);
  }

  return ok(update);
}
