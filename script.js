// ============================================================
// script.js — واجهة اللعبة الأمامية (أونلاين عبر Firebase Realtime Database)
// وضع "البث المباشر": الهوست = شاشة عرض/مشاهد فقط (بدون دور)
//                       اللاعبون = كل واحد من جهازه الخاص، يستلم دوره سرًا
// كل التزامن (المراحل + المؤقت + الشات) يتم عبر Firebase فقط، بدون سيرفر.
// ============================================================

// ---------------------------------------------------------------
// ⚠️ إعدادات Firebase — استبدل القيم التالية بإعدادات مشروعك الحقيقية
// (Firebase Console → Project settings → Your apps → SDK setup and config)
// ---------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyApAkApoS5VUMeZBlD8Fq6vjkzh0nKzAHg",
  authDomain: "mafia-online-aba50.firebaseapp.com",
  databaseURL: "https://mafia-online-aba50-default-rtdb.firebaseio.com",
  projectId: "mafia-online-aba50",
  storageBucket: "mafia-online-aba50.firebasestorage.app",
  messagingSenderId: "843849003628",
  appId: "1:843849003628:web:60d19fe8f1c26f333c5e49"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ---------- الحالة المحلية لهذا الجهاز فقط ----------
const state = {
  roomId: null,
  isHost: false,
  myPlayerId: null,
  myName: null,
  myRoleKey: null,
  room: null,          // آخر نسخة كاملة من بيانات الغرفة القادمة من Firebase
  qrInstance: null,
  hostInterval: null,  // مؤقت الهوست (setInterval) الذي يدير الوقت والمراحل
  _nightTriggered: false, // حارس لمنع تكرار بدء الليل من شاشة كشف الأدوار
  tallyLock: false        // حارس لمنع تكرار إحصاء الأصوات
};

const ROLE_NAMES = {
  Detective: "محقق", Doctor: "طبيب", Mafia: "مافيا", Thief: "حرامي", Citizen: "مواطن"
};
const ROLE_DESC = {
  Detective: "حقق مع لاعب واحد كل ليلة لمعرفة إن كان من المافيا.",
  Doctor: "أنقذ لاعبًا واحدًا كل ليلة من هجوم المافيا.",
  Mafia: "اقتل لاعبًا واحدًا كل ليلة. نسّق مع الحرامي.",
  Thief: "منضم إلى المافيا. تآمر معهم ليلاً.",
  Citizen: "لا تملك قوى خاصة. صوّت بحكمة في النهار."
};
const MAFIA_TEAM = ["Mafia", "Thief"];
const ROLE_ICONS = {
  Detective: "🔍", Doctor: "🩺", Mafia: "🔪", Thief: "🥷", Citizen: "👤"
};

// ============================================================
// شريط الأزرار العلوي: شرح اللعبة + القائمة الجانبية للسجل
// ============================================================
function openOverlay(el, overlayCls){ el.classList.add(overlayCls || "show"); }
function closeOverlay(el, overlayCls){ el.classList.remove(overlayCls || "show"); }

document.getElementById("helpBtn").onclick = () => openOverlay(document.getElementById("helpOverlay"));
document.getElementById("helpClose").onclick = () => closeOverlay(document.getElementById("helpOverlay"));
document.getElementById("helpOverlay").addEventListener("click", (e) => {
  if(e.target.id === "helpOverlay") closeOverlay(document.getElementById("helpOverlay"));
});

function openSideLog(){
  document.getElementById("sideLog").classList.add("open");
  document.getElementById("sideLogOverlay").classList.add("show");
}
function closeSideLog(){
  document.getElementById("sideLog").classList.remove("open");
  document.getElementById("sideLogOverlay").classList.remove("show");
}
document.getElementById("logToggleBtn").onclick = openSideLog;
document.getElementById("sideLogClose").onclick = closeSideLog;
document.getElementById("sideLogOverlay").onclick = closeSideLog;

// كتابة حدث عام (علني وآمن، لا يكشف أدوارًا سرية) في سجل الغرفة — المضيف هو الكاتب الوحيد
function logEvent(text, cls){
  if(!state.roomId) return;
  db.ref(`rooms/${state.roomId}/log`).push({
    text, cls: cls || "phase", ts: firebase.database.ServerValue.TIMESTAMP
  });
}

function renderSideLog(data){
  const body = document.getElementById("sideLogBody");
  const entries = Object.values(data.log || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if(!entries.length){
    body.innerHTML = `<p class="hint">لا توجد أحداث بعد.</p>`;
    return;
  }
  body.innerHTML = entries.map(e => {
    let time = "";
    if(e.ts){ const d = new Date(e.ts); time = d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }); }
    return `<div class="log-entry log-${e.cls || "phase"}">${time ? `<span class="log-time">${time}</span>` : ""}${escapeHtml(e.text).replace(/\n/g, "<br>")}</div>`;
  }).join("");
}

// مدد المؤقتات بالثواني (يديرها جهاز الهوست فقط ويكتبها في Firebase)
const TIMERS = { sleep: 10, doctor: 15, detective: 15, mafia: 15, day: 250, vote: 30 };

function $(id){ return document.getElementById(id); }
function showScreen(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
}

function renderGrid(container, players, selectedId, onClick){
  container.innerHTML = "";
  players.forEach(p => {
    const d = document.createElement("div");
    d.className = "player-card" + (p.id === selectedId ? " selected" : "");
    const initial = (p.name || "؟").trim().charAt(0).toUpperCase();
    d.innerHTML = `<div class="avatar">${escapeHtml(initial)}</div><div class="p-name">${escapeHtml(p.name)}</div>`;
    d.onclick = () => onClick(p.id);
    container.appendChild(d);
  });
}

function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function aliveList(playersObj){
  return Object.entries(playersObj || {})
    .filter(([, p]) => p.alive !== false)
    .map(([id, p]) => ({ id, name: p.name, role: p.role }));
}

function computeWin(playersObj){
  const list = Object.values(playersObj || {});
  const mafiaAlive = list.filter(p => p.alive !== false && MAFIA_TEAM.includes(p.role)).length;
  const innocentAlive = list.filter(p => p.alive !== false && !MAFIA_TEAM.includes(p.role)).length;
  if(mafiaAlive === 0) return { title: "فاز الأبرياء!", desc: "تم القضاء على جميع أفراد المافيا والحرامي." };
  if(mafiaAlive >= innocentAlive) return { title: "فازت المافيا!", desc: "أصبح فريق المافيا مساويًا أو أكثر عددًا من الأبرياء." };
  return null;
}

// ============================================================
// شاشة "أنت مقصى" — ثابتة، تُنشأ ديناميكيًا وتستخدم نفس فئات CSS الحالية
// (screen / panel / section-title / hint) دون أي تعديل على style.css
// ============================================================
(function buildEliminatedOverlay(){
  const overlay = document.createElement("section");
  overlay.id = "eliminatedOverlay";
  overlay.className = "screen";
  overlay.innerHTML = `
    <h2 class="section-title">أنت مُقصى! <span>👁️</span></h2>
    <div class="panel">
      <p class="hint">لقد تم إقصاؤك من اللعبة. أنت الآن تُشاهد فقط حتى نهايتها،
      ولا يمكنك التصويت أو اختيار أهداف أو الكتابة في الشات.</p>
    </div>
  `;
  document.body.appendChild(overlay);
})();

// هل اللاعب الحالي مُقصى؟ (يُستخدم لمنع أي تفاعل احتياطيًا)
function isMeEliminated(){
  if(state.isHost || !state.myPlayerId || !state.room) return false;
  const me = (state.room.players || {})[state.myPlayerId];
  return !!(me && me.alive === false);
}

// ============================================================
// LOBBY — استضافة / انضمام
// ============================================================
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.tab + "Tab").classList.add("active");
  };
});

function generateRoomId(){
  const first = Math.floor(Math.random() * 9) + 1;
  const rest = Math.floor(Math.random() * 100000).toString().padStart(5, "0");
  return String(first) + rest;
}

async function createUniqueRoomId(){
  let roomId, exists = true;
  while(exists){
    roomId = generateRoomId();
    const snap = await db.ref(`rooms/${roomId}`).once("value");
    exists = snap.exists();
  }
  return roomId;
}

function updateQrCode(roomId){
  const link = `${location.origin}${location.pathname}?room=${roomId}`;
  $("qrLinkText").textContent = link;
  $("qrCodeBox").innerHTML = "";
  state.qrInstance = new QRCode($("qrCodeBox"), {
    text: link,
    width: 180,
    height: 180,
    colorDark: "#1a0418",
    colorLight: "#ffffff"
  });
}

function enterRoomPanel(roomId){
  $("lobbyTabs").classList.add("hidden");
  $("roomPanel").classList.remove("hidden");
  $("roomIdDisplay").textContent = roomId;
  updateQrCode(roomId);
  $("startGameBtn").classList.toggle("hidden", !state.isHost);
}

(function prefillFromUrl(){
  const params = new URLSearchParams(location.search);
  const room = (params.get("room") || "").replace(/[^0-9]/g, "").slice(0, 6);
  if(!room) return;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
  document.querySelector('.tab-btn[data-tab="join"]').classList.add("active");
  $("joinTab").classList.add("active");
  $("roomIdInput").value = room;
})();

// ---------- استضافة: الهوست = شاشة عرض/بث فقط، لا يدخل كلاعب ولا يأخذ دورًا ----------
$("genRoomBtn").onclick = async () => {
  const name = $("hostNameInput").value.trim();
  if(!name){ alert("الرجاء إدخال اسمك أولاً."); return; }

  $("genRoomBtn").disabled = true;
  try{
    const roomId = await createUniqueRoomId();

    await db.ref(`rooms/${roomId}`).set({
      hostName: name,
      phase: "lobby",
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      players: {}
    });

    state.roomId = roomId;
    state.isHost = true;
    state.myPlayerId = null;
    state.myName = name;

    enterRoomPanel(roomId);
    listenToRoom(roomId);
    startHostLoop();
    logEvent(`🏠 تم إنشاء الغرفة رقم ${roomId}.`, "phase");
  } catch(err){
    console.error(err);
    alert("تعذّر إنشاء الغرفة. تحقّق من إعدادات Firebase (firebaseConfig) وحاول مجددًا.");
  } finally {
    $("genRoomBtn").disabled = false;
  }
};

// ---------- انضمام: رقم الغرفة + الاسم -> إضافة اللاعب في Firebase ----------
$("roomIdInput").addEventListener("input", () => {
  $("roomIdInput").value = $("roomIdInput").value.replace(/[^0-9]/g, "").slice(0, 6);
});

$("joinRoomBtn").onclick = async () => {
  const roomId = $("roomIdInput").value.trim();
  const name = $("nameInput").value.trim();

  if(roomId.length !== 6){ alert("رمز الغرفة يجب أن يتكوّن من 6 أرقام."); return; }
  if(!name){ alert("الرجاء إدخال اسمك."); return; }

  $("joinRoomBtn").disabled = true;
  try{
    const roomSnap = await db.ref(`rooms/${roomId}`).once("value");
    if(!roomSnap.exists()){ alert("لا توجد غرفة بهذا الرقم."); return; }

    const roomData = roomSnap.val();
    if(roomData.phase !== "lobby"){ alert("اللعبة بدأت بالفعل في هذه الغرفة."); return; }

    const playerId = db.ref(`rooms/${roomId}/players`).push().key;
    await db.ref(`rooms/${roomId}/players/${playerId}`).set({
      name,
      role: null,
      alive: true,
      ready: false,
      joinedAt: firebase.database.ServerValue.TIMESTAMP
    });

    state.roomId = roomId;
    state.isHost = false;
    state.myPlayerId = playerId;
    state.myName = name;

    enterRoomPanel(roomId);
    listenToRoom(roomId);
  } catch(err){
    console.error(err);
    alert("تعذّر الانضمام للغرفة.");
  } finally {
    $("joinRoomBtn").disabled = false;
  }
};

// ============================================================
// الاستماع الموحّد لغرفة اللعبة بالكامل — كل تغيير (مرحلة/لاعبين/مؤقت/شات)
// يصل فورًا لكل الأجهزة عبر onValue وتتحدث الشاشات تلقائيًا معًا.
// ============================================================
function listenToRoom(roomId){
  db.ref(`rooms/${roomId}`).on("value", (snap) => {
    const data = snap.val();
    if(!data) return;
    state.room = data;

    // تحديث الدور المحفوظ محليًا (لاستخدامه في صلاحيات الشات وغيره)
    if(!state.isHost && state.myPlayerId && data.players && data.players[state.myPlayerId]){
      state.myRoleKey = data.players[state.myPlayerId].role || state.myRoleKey;
    }

    render(data);
  });
}

function render(data){
  if(!data.phase) return;

  renderSideLog(data);
  updateSpectatorPanel(data);

  // قاعدة صارمة: اللاعب المُقصى تُقفل عنده كل الشاشات التفاعلية فورًا،
  // ويرى شاشة ثابتة "أنت مُقصى" بدل مراحل الليل/النهار/التصويت.
  if(!state.isHost && state.myPlayerId && data.phase !== "lobby" && data.phase !== "reveal" && data.phase !== "gameover"){
    const me = (data.players || {})[state.myPlayerId];
    if(me && me.alive === false){
      showScreen("eliminatedOverlay");
      return;
    }
  }

  switch(data.phase){
    case "lobby": renderLobbyPhase(data); break;
    case "reveal": renderRevealPhase(data); break;
    case "night": renderNightPhase(data); break;
    case "day": renderDayPhase(data); break;
    case "vote": renderVotePhase(data); break;
    case "gameover": renderGameOverPhase(data); break;
  }
}

// ============================================================
// لوحة المشاهدة (شاشة المضيف): بطاقة المشاركين + بطاقة المقصَين
// ============================================================
function updateSpectatorPanel(data){
  const panel = $("spectatorPanel");
  const showPanel = state.isHost && ["reveal", "night", "day", "vote"].includes(data.phase);
  panel.classList.toggle("hidden", !showPanel);
  if(!showPanel) return;

  const players = Object.values(data.players || {});
  const alive = players.filter(p => p.alive !== false);
  const dead = players.filter(p => p.alive === false);

  $("aliveCountBadge").textContent = alive.length;
  $("eliminatedCountBadge").textContent = dead.length;

  $("aliveSpectatorList").innerHTML = alive.length
    ? alive.map(p => `<div class="s-chip">🟢 ${escapeHtml(p.name)}</div>`).join("")
    : `<p class="hint">لا يوجد لاعبون أحياء.</p>`;

  $("eliminatedSpectatorList").innerHTML = dead.length
    ? dead.map(p => `<div class="s-chip">${escapeHtml(p.name)} — <b>${ROLE_NAMES[p.role] || "؟"}</b></div>`).join("")
    : `<p class="hint">لم يُقصَ أحد بعد.</p>`;
}

// ============================================================
// LOBBY (مرحلة الانتظار)
// ============================================================
function renderLobbyPhase(data){
  showScreen("lobby");
  const players = Object.entries(data.players || {}).map(([id, p]) => ({ id, name: p.name }));

  $("lobbyPlayerList").innerHTML = "";
  players.forEach(p => {
    const d = document.createElement("div");
    d.textContent = p.name;
    $("lobbyPlayerList").appendChild(d);
  });

  $("lobbyCount").textContent = state.isHost
    ? `${players.length} لاعبين — أنت المضيف (شاشة عرض للبث فقط، بدون دور)`
    : `${players.length} لاعبين`;

  $("startGameBtn").classList.toggle("hidden", !state.isHost);
}

// ---------- توزيع الأدوار (نفس الخوارزمية الأصلية) — على اللاعبين فقط دون الهوست ----------
function assignRoles(n){
  const roles = ["Detective", "Doctor", "Mafia"];
  if(n >= 9) roles.push("Thief");
  while(roles.length < n) roles.push("Citizen");
  for(let i = roles.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

$("startGameBtn").onclick = async () => {
  if(!state.isHost || !state.roomId) return;
  const data = state.room || {};
  const ids = Object.keys(data.players || {});

  if(ids.length < 5){ alert("تحتاج إلى 5 لاعبين على الأقل لبدء اللعبة."); return; }

  const roles = assignRoles(ids.length);
  const updates = {};
  ids.forEach((id, i) => {
    updates[`players/${id}/role`] = roles[i];
    updates[`players/${id}/alive`] = true;
    updates[`players/${id}/ready`] = false;
  });
  updates.phase = "reveal";
  updates.night = null;
  updates.day = null;
  updates.vote = null;
  updates.messages = null;
  updates.mafiaMessages = null;
  updates.gameover = null;

  state._nightTriggered = false;
  state.tallyLock = false;

  await db.ref(`rooms/${state.roomId}`).update(updates);
  logEvent(`🎲 بدأت اللعبة بعدد ${ids.length} لاعبين، وتم توزيع الأدوار سرًا.`, "phase");
};

// ============================================================
// ROLE REVEAL — كل لاعب يرى دوره سرًا على جهازه، الهوست يرى فقط نسبة الجاهزية
// ============================================================
function showMyRole(roleKey){
  $("roleName").textContent = ROLE_NAMES[roleKey] || "—";
  $("roleDesc").textContent = ROLE_DESC[roleKey] || "";
  $("roleCard").classList.remove("flipped");

  // بطاقة الدور المصغّرة الدائمة — تبقى ظاهرة دون الحاجة لقلب البطاقة
  $("roleMiniCard").classList.remove("hidden");
  $("roleMiniIcon").textContent = ROLE_ICONS[roleKey] || "🃏";
  $("roleMiniName").textContent = ROLE_NAMES[roleKey] || "—";
  $("roleMiniDesc").textContent = ROLE_DESC[roleKey] || "";
}

$("roleCard").onclick = () => $("roleCard").classList.toggle("flipped");

$("revealNextBtn").onclick = () => {
  if(state.isHost || !state.roomId || !state.myPlayerId) return;
  db.ref(`rooms/${state.roomId}/players/${state.myPlayerId}/ready`).set(true);
};

function renderRevealPhase(data){
  showScreen("reveal");
  const players = data.players || {};
  const total = Object.keys(players).length;
  const readyCount = Object.values(players).filter(p => p.ready === true).length;
  const pct = total > 0 ? Math.round((readyCount / total) * 100) : 0;

  if(state.isHost){
    $("revealWaitCard").classList.remove("hidden");
    $("playerRevealHint").classList.add("hidden");
    $("roleCard").classList.add("hidden");
    $("roleMiniCard").classList.add("hidden");
    $("revealNextBtn").classList.add("hidden");
    $("readyProgressBar").style.width = pct + "%";
    $("revealName").textContent = `${readyCount} من ${total} جاهزون`;
  } else {
    $("revealWaitCard").classList.add("hidden");
    $("playerRevealHint").classList.remove("hidden");
    $("roleCard").classList.remove("hidden");
    $("revealNextBtn").classList.remove("hidden");
    $("revealPlayerName").textContent = state.myName || "—";

    const me = players[state.myPlayerId];
    if(me && me.role){
      showMyRole(me.role);
    }
    if(me && me.ready){
      $("revealNextBtn").disabled = true;
      $("revealNextBtn").textContent = "بانتظار بقية اللاعبين...";
    } else {
      $("revealNextBtn").disabled = false;
      $("revealNextBtn").textContent = "أنا جاهز";
    }
  }

  // الهوست فقط ينقل اللعبة لليل عندما يصبح الجميع جاهزين (كاتب وحيد لتفادي التعارض)
  if(state.isHost && total > 0 && readyCount >= total && !state._nightTriggered){
    state._nightTriggered = true;
    logEvent("🌙 انتهى كشف الأدوار، والمدينة تستعد للنوم...", "phase");
    db.ref(`rooms/${state.roomId}`).update({
      phase: "night",
      night: { step: "sleep", timeLeft: TIMERS.sleep, savedId: null, killedId: null, detectiveId: null }
    });
  }
}

// ============================================================
// NIGHT PHASE — شاشة سرية مختلفة لكل دور + عداد يتحرك تلقائيًا للجميع
// ============================================================

// نصوص المرحلة: للهوست تحديثات حية بدون كشف الهويات، وللاعبين حسب دورهم
function nightLabelFor(step, myRole, night){
  if(state.isHost){
    switch(step){
      case "sleep": return "🌙 المدينة نائمة... يستعد الجميع للنوم";
      case "doctor": return night.savedId
        ? "🩺 الطبيب قام باختيار شخص لحمايته..."
        : "🩺 الطبيب يختار الآن من سينقذ...";
      case "detective": return night.detectiveId
        ? "🔍 المحقق قام بالتحقق من أحد المشتبه بهم..."
        : "🔍 المحقق يحقق الآن...";
      case "mafia": return night.killedId
        ? "🔪 عصابة المافيا حددت ضحيتها..."
        : "🔪 المافيا تختار ضحيتها الآن...";
      default: return "";
    }
  }
  switch(step){
    case "sleep": return "🌙 المدينة نائمة... يستعد الجميع للنوم";
    case "doctor": return myRole === "Doctor" ? "🩺 اختر من تريد إنقاذه الليلة" : "🩺 الطبيب يختار الآن من سينقذ...";
    case "detective": return myRole === "Detective" ? "🔍 اختر من تريد التحقيق معه" : "🔍 المحقق يحقق الآن...";
    case "mafia": return MAFIA_TEAM.includes(myRole) ? "🔪 تناقشوا مع فريقكم واختاروا الهدف" : "🔪 المافيا تختار ضحيتها الآن...";
    default: return "";
  }
}

function renderNightPhase(data){
  showScreen("night");
  const night = data.night || {};
  $("nightTimer").textContent = night.timeLeft ?? 0;

  const step = night.step || "sleep";
  const myRole = state.isHost ? null : ((data.players || {})[state.myPlayerId] || {}).role;

  $("nightStepLabel").textContent = nightLabelFor(step, myRole, night);

  $("doctorPanel").classList.toggle("hidden", !(step === "doctor" && myRole === "Doctor"));
  $("detectivePanel").classList.toggle("hidden", !(step === "detective" && myRole === "Detective"));
  $("mafiaPanel").classList.toggle("hidden", !(step === "mafia" && MAFIA_TEAM.includes(myRole)));

  const alivePlayers = aliveList(data.players);

  // ---------- الطبيب: اختيار واحد فقط ثم قفل فوري ----------
  if(step === "doctor" && myRole === "Doctor"){
    const doctorTitle = $("doctorPanel").querySelector("h3");
    if(night.savedId){
      const target = (data.players || {})[night.savedId];
      doctorTitle.textContent = target
        ? `تم اختيار "${target.name}" للحماية — بانتظار انتهاء الليل`
        : "تم اختيارك — بانتظار انتهاء الليل";
      $("doctorGrid").innerHTML = "";
    } else {
      doctorTitle.textContent = "الطبيب: اختر من تريد إنقاذه (اختيار واحد فقط)";
      renderGrid($("doctorGrid"), alivePlayers, null, (targetId) => {
        db.ref(`rooms/${state.roomId}/night/savedId`).set(targetId);
      });
    }
  }

  // ---------- المحقق: اختيار واحد فقط، تظهر النتيجة فورًا ثم يُقفل الاختيار ----------
  if(step === "detective" && myRole === "Detective"){
    if(night.detectiveId){
      $("detectiveGrid").innerHTML = "";
      const target = (data.players || {})[night.detectiveId];
      if(target){
        const isMafia = MAFIA_TEAM.includes(target.role);
        $("detectiveResult").textContent = `${target.name}: ${isMafia ? "من المافيا! 🔪" : "بريء ✅"}`;
      }
    } else {
      const targets = alivePlayers.filter(p => p.id !== state.myPlayerId);
      renderGrid($("detectiveGrid"), targets, null, (targetId) => {
        db.ref(`rooms/${state.roomId}/night/detectiveId`).set(targetId);
      });
      $("detectiveResult").textContent = "";
    }
  }

  // ---------- المافيا: يختارون هدفًا معًا، الشات الخاص يظهر فقط إن وُجد "حرامي" ----------
  if(step === "mafia" && MAFIA_TEAM.includes(myRole)){
    const targets = alivePlayers.filter(p => !MAFIA_TEAM.includes(p.role));
    renderGrid($("mafiaGrid"), targets, night.killedId, (targetId) => {
      db.ref(`rooms/${state.roomId}/night/killedId`).set(targetId);
    });

    const hasThief = Object.values(data.players || {}).some(p => p.role === "Thief");
    const chatInputWrap = $("mafiaChatInput").parentElement;
    if(hasThief){
      $("mafiaChatBox").classList.remove("hidden");
      chatInputWrap.classList.remove("hidden");
      renderChatBox($("mafiaChatBox"), data.mafiaMessages);
    } else {
      $("mafiaChatBox").classList.add("hidden");
      chatInputWrap.classList.add("hidden");
    }
  }
}

function sendMafiaChat(){
  if(!state.roomId || state.isHost || isMeEliminated() || !MAFIA_TEAM.includes(state.myRoleKey)) return;
  const val = $("mafiaChatInput").value.trim();
  if(!val) return;
  db.ref(`rooms/${state.roomId}/mafiaMessages`).push({
    name: escapeHtml(state.myName || ""),
    msg: escapeHtml(val),
    ts: firebase.database.ServerValue.TIMESTAMP
  });
  $("mafiaChatInput").value = "";
}
$("mafiaChatSend").onclick = sendMafiaChat;
$("mafiaChatInput").addEventListener("keydown", (e) => { if(e.key === "Enter") sendMafiaChat(); });

// ============================================================
// DAY PHASE — نقاش عام، وتُفتح نافذة الشات كاملة على شاشة الهوست للبث
// ============================================================
function renderDayPhase(data){
  showScreen("day");
  const day = data.day || {};
  $("dayTimer").textContent = day.timeLeft ?? 0;
  $("dayAnnouncement").textContent = day.announcement || "";
  renderChatBox($("dayChatBox"), data.messages);

  const me = !state.isHost ? (data.players || {})[state.myPlayerId] : null;
  const alive = me ? me.alive !== false : false;

  $("dayChatInput").classList.toggle("hidden", state.isHost || !alive);
  $("dayChatSend").classList.toggle("hidden", state.isHost || !alive);
  $("toVoteBtn").classList.toggle("hidden", !state.isHost);
}

function sendDayChat(){
  if(state.isHost || !state.roomId || !state.myPlayerId || isMeEliminated()) return;
  const val = $("dayChatInput").value.trim();
  if(!val) return;
  db.ref(`rooms/${state.roomId}/messages`).push({
    name: escapeHtml(state.myName || ""),
    msg: escapeHtml(val),
    ts: firebase.database.ServerValue.TIMESTAMP
  });
  $("dayChatInput").value = "";
}
$("dayChatSend").onclick = sendDayChat;
$("dayChatInput").addEventListener("keydown", (e) => { if(e.key === "Enter") sendDayChat(); });

function renderChatBox(container, messages){
  container.innerHTML = "";
  const arr = messages ? Object.values(messages) : [];
  arr.forEach(m => {
    const d = document.createElement("div");
    d.className = "msg";
    d.innerHTML = `<b>${m.name || ""}:</b> ${m.msg || ""}`;
    container.appendChild(d);
  });
  container.scrollTop = container.scrollHeight;
}

// الهوست يمكنه تخطي بقية وقت النهار والانتقال يدويًا للتصويت (تحكّم بث مباشر)
$("toVoteBtn").onclick = () => {
  if(!state.isHost || !state.roomId) return;
  state.tallyLock = false;
  logEvent("🔥 انتقل المضيف إلى مرحلة التصويت.", "phase");
  db.ref(`rooms/${state.roomId}`).update({ phase: "vote", vote: { timeLeft: TIMERS.vote, votes: {} } });
};

// ============================================================
// VOTE PHASE
// ============================================================
function renderVotePhase(data){
  showScreen("vote");
  const vote = data.vote || {};
  $("voteTimer").textContent = vote.timeLeft ?? 0;

  const votes = vote.votes || {};
  const alivePlayers = aliveList(data.players);

  if(state.isHost){
    $("voteGrid").innerHTML = "";
    $("skipVoteBtn").classList.add("hidden");
    $("tallyBtn").classList.remove("hidden");
    if(vote.resultText){
      $("voteTally").textContent = vote.resultText;
    } else {
      const counts = {};
      Object.values(votes).forEach(v => { if(v && v !== "skip") counts[v] = (counts[v] || 0) + 1; });
      const lines = Object.entries(counts).map(([id, c]) => {
        const p = (data.players || {})[id];
        return p ? `${p.name}: ${c} صوت` : "";
      }).filter(Boolean);
      $("voteTally").textContent = lines.length ? lines.join("\n") : "بانتظار الأصوات...";
    }
  } else {
    $("tallyBtn").classList.add("hidden");
    $("voteTally").textContent = vote.resultText || "";
    const me = (data.players || {})[state.myPlayerId];
    const alive = me ? me.alive !== false : false;
    $("skipVoteBtn").classList.toggle("hidden", !alive);
    if(alive){
      const targets = alivePlayers.filter(p => p.id !== state.myPlayerId);
      renderGrid($("voteGrid"), targets, votes[state.myPlayerId], (targetId) => {
        db.ref(`rooms/${state.roomId}/vote/votes/${state.myPlayerId}`).set(targetId);
      });
    } else {
      $("voteGrid").innerHTML = "";
    }
  }

  // إحصاء تلقائي مبكر إذا صوّت جميع الأحياء قبل انتهاء الوقت (الهوست فقط ينفّذه)
  if(state.isHost && data.vote && !data.vote.resultText && !state.tallyLock){
    const aliveIds = alivePlayers.map(p => p.id);
    const allVoted = aliveIds.length > 0 && aliveIds.every(id => votes[id] !== undefined);
    if(allVoted) tallyVotesHost(data);
  }
}

$("skipVoteBtn").onclick = () => {
  if(state.isHost || !state.roomId || !state.myPlayerId || isMeEliminated()) return;
  db.ref(`rooms/${state.roomId}/vote/votes/${state.myPlayerId}`).set("skip");
};

$("tallyBtn").onclick = () => {
  if(!state.isHost || !state.roomId) return;
  const data = state.room;
  if(data && data.vote && !data.vote.resultText) tallyVotesHost(data);
};

function tallyVotesHost(data){
  if(state.tallyLock) return;
  state.tallyLock = true;

  const roomRef = db.ref(`rooms/${state.roomId}`);
  const playersCopy = JSON.parse(JSON.stringify(data.players || {}));
  const votes = Object.assign({}, (data.vote && data.vote.votes) || {});

  // حرص على التصويت العشوائي: أي لاعب حي لم يصوّت قبل انتهاء الوقت
  // يُسجَّل له صوت عشوائي تلقائيًا حتى لا تتعطّل اللعبة بانتظاره
  const aliveIds = Object.entries(playersCopy).filter(([, p]) => p.alive !== false).map(([id]) => id);
  aliveIds.forEach(id => {
    if(votes[id] === undefined){
      const others = aliveIds.filter(x => x !== id);
      votes[id] = others.length ? others[Math.floor(Math.random() * others.length)] : "skip";
    }
  });

  const tally = {};
  Object.entries(playersCopy).forEach(([id, p]) => {
    if(p.alive === false) return;
    const v = votes[id];
    if(v && v !== "skip") tally[v] = (tally[v] || 0) + 1;
  });

  let max = 0, leaders = [];
  Object.entries(tally).forEach(([id, count]) => {
    if(count > max){ max = count; leaders = [id]; }
    else if(count === max) leaders.push(id);
  });

  const lines = Object.entries(tally).map(([id, c]) => `${playersCopy[id].name}: ${c} صوت`);
  let resultText = lines.length ? lines.join("\n") : "لم يتم الإدلاء بأي صوت.";

  if(leaders.length === 1 && max > 0){
    const eliminatedId = leaders[0];
    playersCopy[eliminatedId].alive = false;
    resultText += `\n\nتم إقصاء ${playersCopy[eliminatedId].name}. كان دوره: ${ROLE_NAMES[playersCopy[eliminatedId].role]}.`;
  } else {
    resultText += "\n\nانتهى التصويت بالتعادل أو بدون أصوات — لم يتم إقصاء أحد.";
  }

  const win = computeWin(playersCopy);
  logEvent(`🗳️ نتيجة التصويت:\n${resultText}`, "vote");

  roomRef.update({ players: playersCopy, "vote/resultText": resultText }).then(() => {
    setTimeout(() => {
      state.tallyLock = false;
      if(win){
        logEvent(`🏁 انتهت اللعبة — ${win.title} ${win.desc}`, "phase");
        roomRef.update({ phase: "gameover", gameover: { title: win.title, desc: win.desc }, vote: null });
      } else {
        roomRef.update({
          phase: "night",
          night: { step: "sleep", timeLeft: TIMERS.sleep, savedId: null, killedId: null, detectiveId: null },
          vote: null
        });
      }
    }, 3000);
  });
}

// ============================================================
// GAME OVER
// ============================================================
function renderGameOverPhase(data){
  showScreen("gameover");
  const go = data.gameover || {};
  $("gameOverTitle").textContent = go.title || "انتهت اللعبة";
  $("gameOverDesc").textContent = go.desc || "";

  $("finalRoles").innerHTML = "";
  Object.values(data.players || {}).forEach(p => {
    const d = document.createElement("div");
    d.textContent = `${p.name} — ${ROLE_NAMES[p.role] || "?"} (${p.alive === false ? "ميت" : "حي"})`;
    $("finalRoles").appendChild(d);
  });

  $("restartBtn").classList.toggle("hidden", !state.isHost);
}

$("restartBtn").onclick = () => {
  if(!state.isHost || !state.roomId) return;
  const data = state.room || {};
  const resetPlayers = {};
  Object.entries(data.players || {}).forEach(([id, p]) => {
    resetPlayers[id] = { name: p.name, role: null, alive: true, ready: false };
  });

  state._nightTriggered = false;
  state.tallyLock = false;

  db.ref(`rooms/${state.roomId}`).update({
    phase: "lobby",
    players: resetPlayers,
    night: null, day: null, vote: null, messages: null, mafiaMessages: null, gameover: null, log: null
  });
  logEvent("🔄 بدأت جولة جديدة من اللعبة.", "phase");
};

// ============================================================
// حلقة الهوست: تنقص المؤقت كل ثانية وتنقل المراحل تلقائيًا وتزامنها
// عبر Firebase — كل الأجهزة الأخرى تستمع فقط (onValue) ولا تكتب الوقت أبدًا.
// ============================================================
function hostTick(){
  if(!state.isHost || !state.roomId || !state.room) return;
  const data = state.room;
  const roomRef = db.ref(`rooms/${state.roomId}`);

  if(data.phase === "night" && data.night){
    const t = data.night.timeLeft ?? 0;
    if(t <= 0){
      advanceNightStep(data);
    } else {
      roomRef.child("night/timeLeft").set(t - 1);
    }
  } else if(data.phase === "day" && data.day){
    const t = data.day.timeLeft ?? 0;
    if(t <= 0){
      state.tallyLock = false;
      logEvent("🔥 انتهى وقت النقاش، بدأ التصويت.", "phase");
      roomRef.update({ phase: "vote", vote: { timeLeft: TIMERS.vote, votes: {} } });
    } else {
      roomRef.child("day/timeLeft").set(t - 1);
    }
  } else if(data.phase === "vote" && data.vote && !data.vote.resultText && !state.tallyLock){
    const t = data.vote.timeLeft ?? 0;
    if(t <= 0){
      tallyVotesHost(data);
    } else {
      roomRef.child("vote/timeLeft").set(t - 1);
    }
  }
}

function startHostLoop(){
  if(state.hostInterval) return;
  state.hostInterval = setInterval(hostTick, 1000);
}

function advanceNightStep(data){
  const step = (data.night || {}).step || "sleep";
  const roomRef = db.ref(`rooms/${state.roomId}`);
  if(step === "sleep"){
    roomRef.update({ "night/step": "doctor", "night/timeLeft": TIMERS.doctor });
  } else if(step === "doctor"){
    roomRef.update({ "night/step": "detective", "night/timeLeft": TIMERS.detective });
  } else if(step === "detective"){
    roomRef.update({ "night/step": "mafia", "night/timeLeft": TIMERS.mafia });
  } else if(step === "mafia"){
    resolveNightHost(data);
  }
}

function resolveNightHost(data){
  const roomRef = db.ref(`rooms/${state.roomId}`);
  const night = data.night || {};
  const killedId = night.killedId || null;
  const savedId = night.savedId || null;
  const playersCopy = JSON.parse(JSON.stringify(data.players || {}));

  let deathMsg;
  if(killedId && playersCopy[killedId]){
    if(killedId === savedId){
      deathMsg = "أنقذ الطبيب الهدف — نجا الجميع الليلة الماضية!";
    } else {
      playersCopy[killedId].alive = false;
      deathMsg = `تم القضاء على ${playersCopy[killedId].name} الليلة الماضية. كان دوره: ${ROLE_NAMES[playersCopy[killedId].role]}.`;
    }
  } else {
    deathMsg = "لم تختر المافيا هدفًا — نجا الجميع الليلة الماضية.";
  }

  const win = computeWin(playersCopy);
  if(win){
    logEvent(`☀ ${deathMsg}`, "death");
    roomRef.update({ players: playersCopy, night: null, phase: "gameover", gameover: { title: win.title, desc: win.desc } });
    logEvent(`🏁 انتهت اللعبة — ${win.title} ${win.desc}`, "phase");
  } else {
    logEvent(`☀ بدأ النهار: ${deathMsg}`, "death");
    roomRef.update({ players: playersCopy, night: null, phase: "day", day: { timeLeft: TIMERS.day, announcement: deathMsg }, messages: null });
  }
}

// ============================================================
// عناصر لم تعد مستخدمة في وضع "كل لاعب من جهازه" (كانت لتمرير جهاز واحد)
// ============================================================
$("daySpeaker").classList.add("hidden");
$("voterSelect").classList.add("hidden");

// ============================================================
// BACKGROUND CANVAS (drifting nebula dust) — كما هو دون أي تعديل
// ============================================================
(function initBgCanvas(){
  const canvas = $("bgCanvas");
  if(!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  let w, h, particles = [];
  const COLORS = ["#b026ff", "#ff2ea6", "#ff3b30", "#ff8c1a", "#ffcf6b"];

  function resize(){
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  function initParticles(){
    const count = Math.min(90, Math.floor((w * h) / 18000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.6 + 0.4,
      vy: Math.random() * 0.18 + 0.04,
      vx: (Math.random() - 0.5) * 0.06,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: Math.random() * 0.5 + 0.15
    }));
  }
  function tick(){
    ctx.clearRect(0, 0, w, h);
    particles.forEach(p => {
      p.y -= p.vy;
      p.x += p.vx;
      if(p.y < -5) p.y = h + 5;
      if(p.x < -5) p.x = w + 5;
      if(p.x > w + 5) p.x = -5;
      ctx.beginPath();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.color;
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }
  resize();
  initParticles();
  requestAnimationFrame(tick);
  window.addEventListener("resize", () => { resize(); initParticles(); });
})();
