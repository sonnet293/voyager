// intro.js

import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js"
import { doc, getDoc, updateDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js"
import { runSelection } from "./select.js"
import { createFx, spewLine, scramble } from "./introFx.js"

const BGM_LIST = [
  "../bgm/bgm1.mp3",
  "../bgm/bgm2.mp3",
  "../bgm/bgm3.mp3"
]

export let bgmAudio = null

// 저장된 BGM 음량 (새로고침해도 유지)
const VOLUME_KEY = "bgmVolume"
let bgmVolume = 0.7
try {
  const saved = parseFloat(localStorage.getItem(VOLUME_KEY))
  if (!isNaN(saved)) bgmVolume = Math.min(1, Math.max(0, saved))
} catch {}

export function fadeBgmOut(duration = 2000) {
  if (!bgmAudio) return
  const step = bgmAudio.volume / (duration / 50)
  const timer = setInterval(() => {
    if (bgmAudio.volume > step) {
      bgmAudio.volume = Math.max(0, bgmAudio.volume - step)
    } else {
      bgmAudio.volume = 0
      bgmAudio.pause()
      clearInterval(timer)
    }
  }, 50)
}

function playBgm() {
  if (bgmAudio) return
  const chosen = BGM_LIST[Math.floor(Math.random() * BGM_LIST.length)]
  bgmAudio = new Audio(chosen)
  bgmAudio.loop   = true
  bgmAudio.volume = bgmVolume
  bgmAudio.play().catch(() => {})
}

const overlay     = document.getElementById("intro-overlay")
const touchScreen = document.getElementById("touch-screen")
const readyStatus = document.getElementById("touch-ready-status")
const vsScreen    = document.getElementById("vs-screen")
const roomRef     = doc(db, "rooms", ROOM_ID)

// 노이즈/글리치 — 터치 대기 화면부터 잔잔하게 돌고, 인트로 중에 격해짐
const fx = createFx({
  canvas: document.getElementById("intro-noise"),
  screen: document.getElementById("intro-screen"),
  bars:   [...overlay.querySelectorAll(".ix-bars i")],
})
document.getElementById("ix-room").textContent = `ROOM ${ROOM_ID.replace("battleroom", "").padStart(2, "0")}`

const isSpectatorParam = new URLSearchParams(location.search).get("spectator") === "true"

let myUid          = null
let mySlot         = null
let touched        = false
let introDone      = false  // 내 인트로 5초가 끝났는지
let opponentReady  = false  // 상대방이 ready를 올렸는지 (한번 true되면 유지)
let battleStarting = false

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

onAuthStateChanged(auth, async (user) => {
  if (!user) return
  myUid = user.uid

  // 게임 시작 직후엔 먼저 포켓몬 선택 화면 (이미 끝났으면 바로 넘어감)
  await runSelection({ roomRef, myUid, spectator: isSpectatorParam })

  if (isSpectatorParam) {
    skipIntro()
    return
  }

  const snap = await getDoc(roomRef)
  const room = snap.data()
  mySlot = room?.player1_uid === myUid ? "p1" : "p2"

  // 인트로가 이미 끝난 상태 = 게임 도중 새로고침 → 인트로 스킵
  if (room?.intro_done) {
    skipIntro()
    return
  }

  bindTouch()
  listenReady()
})

function bindTouch() {
  const handler = () => {
    if (touched) return
    touched = true
    document.removeEventListener("click",      handler)
    document.removeEventListener("touchstart", handler)
    onTouched()
  }
  document.addEventListener("click",      handler)
  document.addEventListener("touchstart", handler)
}

async function onTouched() {
  // BGM — 터치 컨텍스트 안에서 바로 재생 (인트로 중에도 들리게)
  playBgm()
  fx.spike(600) // 방 정보를 불러오는 동안에도 바로 반응이 보이도록

  const snap = await getDoc(roomRef)
  const room = snap.data()

  // VS 인트로 재생
  playVsIntro(room)

  // Firestore에 내 ready 마킹
  const field = mySlot === "p1" ? "intro_ready_p1" : "intro_ready_p2"
  await updateDoc(roomRef, { [field]: true })
}

function listenReady() {
  onSnapshot(roomRef, (snap) => {
    const room = snap.data()
    if (!room) return

    const r1 = !!room.intro_ready_p1
    const r2 = !!room.intro_ready_p2

    // opponentReady는 한번 true되면 false로 안 돌아감
    // → intro_ready 필드가 나중에 초기화돼도 영향 없음
    if (r1 && r2) opponentReady = true

    if (touched && !opponentReady) readyStatus.innerText = "상대방을 기다리는 중..."

    // 내 인트로가 끝난 상태에서 상대방 ready 도착 → 배틀 시작
    if (opponentReady && introDone) startBattle()
  })
}

function flash() {
  const node = document.getElementById("vs-flash")
  node.classList.remove("show")
  void node.offsetWidth
  node.classList.add("show")
}

const INTRO_MS = 5600 // 터치부터 인트로가 끝날 때까지

async function playVsIntro(room) {
  const t0 = performance.now()
  const term  = document.getElementById("ix-term")
  const error = document.getElementById("ix-error")
  const dump  = document.getElementById("ix-dump")

  // 1) 터치 → 화면이 튀면서 로그가 쏟아짐
  flash()
  fx.spike(200)
  touchScreen.hidden = true
  term.hidden = false
  fx.to(0.7, 1400)
  const spewEnd = performance.now() + 1400
  while (performance.now() < spewEnd) {
    const n = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; i < n; i++) {
      const line = document.createElement("div")
      line.textContent = spewLine()
      term.append(line)
    }
    while (term.childElementCount > 80) term.firstChild.remove()
    if (Math.random() < 0.08) fx.spike(120)
    await wait(16 + Math.random() * 40)
  }

  // 2) 오류 화면 — 가장 격렬한 구간
  flash()
  fx.spike(300)
  term.hidden = true
  error.hidden = false
  fx.set(0.85)
  for (let p = 0; p < 100; p += 3 + Math.floor(Math.random() * 9)) {
    dump.textContent = p
    if (Math.random() < 0.2) fx.spike(150)
    await wait(40 + Math.random() * 40)
  }
  dump.textContent = 100
  await wait(250)

  // 3) VS
  flash()
  fx.spike(250)
  error.hidden = true
  vsScreen.hidden = false
  fx.to(0.2, 900)

  const vsLeft  = document.getElementById("vs-left")
  const vsRight = document.getElementById("vs-right")
  vsLeft.classList.add("show")
  scramble(document.getElementById("vs-name-left"), (room?.player1_name ?? "PLAYER1").toUpperCase(), 600)
  await wait(140)
  vsRight.classList.add("show")
  scramble(document.getElementById("vs-name-right"), (room?.player2_name ?? "PLAYER2").toUpperCase(), 600)
  await wait(260)
  document.getElementById("vs-label").classList.add("show")
  flash()
  fx.spike(260)

  // 남은 시간 동안 가끔씩 화면이 튐
  const end = t0 + INTRO_MS
  while (performance.now() < end) {
    await wait(Math.min(end - performance.now(), 400 + Math.random() * 900))
    if (Math.random() < 0.5) fx.spike(120 + Math.random() * 200)
  }
  introDone = true

  if (opponentReady) {
    // 상대방도 이미 ready → 바로 배틀
    startBattle()
  } else {
    // 상대방 아직 대기 중 → listenReady에서 처리
    overlay.classList.add("waiting")
    readyStatus.innerText = "상대방을 기다리는 중..."
    fx.to(0.1, 600)
  }
}

// 화면이 최고조로 깨졌다가 TV처럼 꺼지면서 배틀 화면이 드러남
async function startBattle() {
  if (battleStarting) return
  battleStarting = true

  if (mySlot === "p1") updateDoc(roomRef, { intro_done: true }).catch(() => {})

  overlay.classList.remove("waiting")
  fx.set(1)
  fx.spike(650)
  await wait(650)

  flash()
  document.dispatchEvent(new Event("battle:introDone"))
  fx.stop()
  overlay.classList.add("ix-off")
  setTimeout(() => {
    overlay.classList.add("hidden")
  }, 650)
}

function initVolumeSlider() {
  const slider  = document.getElementById("bgm-volume")
  const label   = document.getElementById("bgm-volume-label")
  const muteBtn = document.getElementById("bgm-mute-btn")
  if (!slider) return

  let lastNonZero = bgmVolume > 0 ? bgmVolume : 0.7

  const apply = (v) => {
    bgmVolume = v
    if (v > 0) lastNonZero = v
    if (bgmAudio) bgmAudio.volume = v
    slider.value = v
    label.innerText = Math.round(v * 100) + "%"
    if (muteBtn) muteBtn.innerText = v === 0 ? "🔇" : v < 0.4 ? "🔉" : "🔊"
    try { localStorage.setItem(VOLUME_KEY, String(v)) } catch {}
  }

  slider.addEventListener("input", () => apply(parseFloat(slider.value)))
  muteBtn?.addEventListener("click", () => apply(bgmVolume === 0 ? lastNonZero : 0))
  apply(bgmVolume)
}

initVolumeSlider()

function skipIntro() {
  fx.stop()
  overlay.classList.add("hidden")
  document.dispatchEvent(new Event("battle:introDone"))

  // BGM 복원
  // 모바일은 터치 컨텍스트 안에서 Audio 생성 + play() 해야 함
  // → 토스트 버튼 onclick 안에서 처리
  const chosen = BGM_LIST[Math.floor(Math.random() * BGM_LIST.length)]

  // 데스크탑은 바로 시도
  const testAudio = new Audio(chosen)
  testAudio.loop   = true
  testAudio.volume = bgmVolume
  testAudio.play().then(() => {
    bgmAudio = testAudio  // 성공하면 그대로 사용
  }).catch(() => {
    // 실패하면 토스트 — onclick 안에서 새로 생성
    showBgmToast(chosen)
    setTimeout(() => {
      if (bgmAudio && bgmAudio.paused) showBgmToast(chosen)
    }, 500)
  })

  setTimeout(() => {
    if (!bgmAudio || bgmAudio.paused) showBgmToast(chosen)
  }, 500)
}

function showBgmToast(chosen) {
  if (document.getElementById("bgm-toast")) return

  if (!document.getElementById("bgm-toast-style")) {
    const s = document.createElement("style")
    s.id = "bgm-toast-style"
    s.textContent = `
      @keyframes fadeInUp {
        from { opacity:0; transform:translateX(-50%) translateY(10px) }
        to   { opacity:1; transform:translateX(-50%) translateY(0) }
      }
      #bgm-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8); color: #fff;
        padding: 12px 24px; border-radius: 999px;
        font-size: 14px; z-index: 9999;
        border: none; cursor: pointer;
        animation: fadeInUp 0.3s ease;
        white-space: nowrap;
      }
    `
    document.head.appendChild(s)
  }

  const btn = document.createElement("button")
  btn.id = "bgm-toast"
  btn.innerText = "🎵 탭하여 브금 재생"

  btn.onclick = () => {
    // 터치 컨텍스트 안에서 Audio 새로 생성 + play() → 모바일 정책 우회
    bgmAudio = new Audio(chosen)
    bgmAudio.loop   = true
    bgmAudio.volume = bgmVolume
    bgmAudio.play().catch(() => {})
    btn.remove()
  }

  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 10000)
}