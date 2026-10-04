// js/room.js
export const ROOMS = [
    {
        id: "battleroom1",
        no: 1,
        name: "SIM-01",
        bg: null,
    },
    {
        id: "battleroom2",
        no: 2,
        name: "SIM-02",
        bg: null,
    },
    {
        id: "battleroom3",
        no: 3,
        name: "SIM-03",
        bg: null,
    },
];

export function roomInfo(roomId) {
    return ROOMS.find((r) => r.id === roomId);
}

export function roomBgStyle(info, imgBase) {
  return info?.bg ? `url("${imgBase}${info.bg}")` : "";
}

export function roomStatus(room) {
  if (!room) return { key: "closed", label: "OFFLINE" };
  if (room.battle_winner) return { key: "ended", label: "COMPLETE" };
  if (room.game_started) return { key: "playing", label: "SIMULATING" };
  return { key: "waiting", label: "STANDBY" };
}