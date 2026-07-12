// ============================================================
// server.js — سيرفر لعبة مافيا الأونلاين (Node.js + Socket.io)
// يحافظ على نفس منطق اللعبة الأصلي (script.js القديم) لكن بشكل
// مركزي على السيرفر بدل الذاكرة المحلية للمتصفح.
// ============================================================

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---------- ثوابت الأدوار (نفس القيم من script.js الأصلي) ----------
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

// نفس مدد المؤقتات الأصلية (بالثواني)
const TIMERS = { sleep: 10, doctor: 15, detective: 15, mafia: 15, day: 250, vote: 30 };

// ---------- تخزين الغرف في الذاكرة ----------
/**
 * rooms[roomId] = {
 *   hostSocketId, players: [{id, socketId, name, role, alive}],
 *   nextPlayerId, phase, readySet: Set<playerId>,
 *   savedId, killedId, votes: {playerId: targetId|'skip'}, timer
 * }
 */
const rooms = {};
// socket.id -> { roomId, playerId }
const socketIndex = {};

function generateRoomId() {
  let id;
  do {
    const first = Math.floor(Math.random() * 9) + 1;
    const rest = Math.floor(Math.random() * 100000).toString().padStart(5, "0");
    id = String(first) + rest;
  } while (rooms[id]);
  return id;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function alivePlayers(room) {
  return room.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive }));
}

function findPlayerBySocket(room, socketId) {
  return room.players.find(p => p.socketId === socketId);
}

function clearRoomTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function mafiaTeamSockets(room) {
  return room.players.filter(p => MAFIA_TEAM.includes(p.role)).map(p => p.socketId);
}

// ---------- تعيين الأدوار (نفس خوارزمية script.js الأصلي) ----------
function assignRoles(room) {
  const n = room.players.length;
  const roles = ["Detective", "Doctor", "Mafia"];
  if (n >= 9) roles.push("Thief");
  while (roles.length < n) roles.push("Citizen");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  room.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
}

// ---------- تدفّق اللعبة (Game Flow) ----------

function startReveal(room, roomId) {
  room.phase = "reveal";
  room.readySet = new Set();
  room.players.forEach(p => {
    io.to(p.socketId).emit("your-role", {
      roleKey: p.role,
      roleName: ROLE_NAMES[p.role],
      roleDesc: ROLE_DESC[p.role],
      myName: p.name
    });
  });
  io.to(roomId).emit("game-started");
}

function startNight(room, roomId) {
  clearRoomTimer(room);
  room.phase = "night";
  room.savedId = null;
  room.killedId = null;
  io.to(roomId).emit("night-phase", { step: "sleep", duration: TIMERS.sleep, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => startDoctorStep(room, roomId), TIMERS.sleep * 1000);
}

function startDoctorStep(room, roomId) {
  clearRoomTimer(room);
  io.to(roomId).emit("night-phase", { step: "doctor", duration: TIMERS.doctor, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => startDetectiveStep(room, roomId), TIMERS.doctor * 1000);
}

function startDetectiveStep(room, roomId) {
  clearRoomTimer(room);
  io.to(roomId).emit("night-phase", { step: "detective", duration: TIMERS.detective, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => startMafiaStep(room, roomId), TIMERS.detective * 1000);
}

function startMafiaStep(room, roomId) {
  clearRoomTimer(room);
  io.to(roomId).emit("night-phase", { step: "mafia", duration: TIMERS.mafia, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => resolveNight(room, roomId), TIMERS.mafia * 1000);
}

function resolveNight(room, roomId) {
  clearRoomTimer(room);
  let deathMsg;
  if (room.killedId === null || room.killedId === undefined) {
    deathMsg = "لم يتم استهداف أحد الليلة الماضية.";
  } else if (room.killedId === room.savedId) {
    deathMsg = "أنقذ الطبيب الهدف — لم يمت أحد!";
  } else {
    const victim = room.players.find(p => p.id === room.killedId);
    if (victim) {
      victim.alive = false;
      deathMsg = `قُتل ${victim.name} في الليل. كان دوره: ${ROLE_NAMES[victim.role]}.`;
    } else {
      deathMsg = "لم يتم استهداف أحد الليلة الماضية.";
    }
  }
  if (checkWin(room, roomId)) return;
  startDay(room, roomId, deathMsg);
}

function startDay(room, roomId, announcement) {
  clearRoomTimer(room);
  room.phase = "day";
  io.to(roomId).emit("day-phase", { announcement, duration: TIMERS.day, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => startVote(room, roomId), TIMERS.day * 1000);
}

function startVote(room, roomId) {
  clearRoomTimer(room);
  room.phase = "vote";
  room.votes = {};
  io.to(roomId).emit("vote-phase", { duration: TIMERS.vote, alivePlayers: alivePlayers(room) });
  room.timer = setTimeout(() => tallyVotes(room, roomId), TIMERS.vote * 1000);
}

function tallyVotes(room, roomId) {
  clearRoomTimer(room);
  const tally = {};
  room.players.filter(p => p.alive).forEach(p => {
    const v = room.votes[p.id];
    if (v !== undefined && v !== "skip") tally[v] = (tally[v] || 0) + 1;
  });
  let max = 0, leaders = [];
  Object.entries(tally).forEach(([id, count]) => {
    id = Number(id);
    if (count > max) { max = count; leaders = [id]; }
    else if (count === max) leaders.push(id);
  });
  let resultText = Object.entries(tally).map(([id, c]) => {
    const p = room.players.find(pl => pl.id == id);
    return `${p.name}: ${c} صوت`;
  }).join("\n") || "لم يتم الإدلاء بأي صوت.";

  if (leaders.length === 1 && max > 0) {
    const eliminated = room.players.find(p => p.id === leaders[0]);
    eliminated.alive = false;
    resultText += `\n\nتم إقصاء ${eliminated.name}. كان دوره: ${ROLE_NAMES[eliminated.role]}.`;
  } else {
    resultText += "\n\nانتهى التصويت بالتعادل أو بدون أصوات — لم يتم إقصاء أحد.";
  }

  io.to(roomId).emit("vote-result", { resultText, alivePlayers: alivePlayers(room) });

  if (checkWin(room, roomId)) return;
  room.timer = setTimeout(() => startNight(room, roomId), 3000);
}

function checkWin(room, roomId) {
  const mafiaAlive = room.players.filter(p => p.alive && MAFIA_TEAM.includes(p.role)).length;
  const innocentAlive = room.players.filter(p => p.alive && !MAFIA_TEAM.includes(p.role)).length;
  if (mafiaAlive === 0) {
    endGame(room, roomId, "فاز الأبرياء!", "تم القضاء على جميع أفراد المافيا والحرامي.");
    return true;
  }
  if (mafiaAlive >= innocentAlive) {
    endGame(room, roomId, "فازت المافيا!", "أصبح فريق المافيا مساويًا أو أكثر عددًا من الأبرياء.");
    return true;
  }
  return false;
}

function endGame(room, roomId, title, desc) {
  clearRoomTimer(room);
  room.phase = "gameover";
  io.to(roomId).emit("game-over", {
    title, desc,
    players: room.players.map(p => ({ name: p.name, role: ROLE_NAMES[p.role], alive: p.alive }))
  });
}

// ============================================================
// Socket.io — الأحداث
// ============================================================
io.on("connection", (socket) => {

  socket.on("create-room", (_data, cb) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      hostSocketId: socket.id,
      players: [],
      nextPlayerId: 0,
      phase: "lobby",
      readySet: new Set(),
      savedId: null, killedId: null, votes: {}, timer: null
    };
    socket.join(roomId);
    if (typeof cb === "function") cb({ ok: true, roomId });
  });

  socket.on("join-room", ({ roomId, name }, cb) => {
    const room = rooms[roomId];
    if (!room) { if (cb) cb({ error: "لم يتم إنشاء أي غرفة بعد." }); return; }
    if (room.phase !== "lobby") { if (cb) cb({ error: "اللعبة بدأت بالفعل في هذه الغرفة." }); return; }
    const cleanName = String(name || "").trim().slice(0, 16);
    if (!cleanName) { if (cb) cb({ error: "الاسم مطلوب." }); return; }

    const player = { id: room.nextPlayerId++, socketId: socket.id, name: cleanName, role: null, alive: true };
    room.players.push(player);
    socket.join(roomId);
    socketIndex[socket.id] = { roomId, playerId: player.id };

    if (typeof cb === "function") cb({ ok: true, roomId, playerId: player.id });
    io.to(roomId).emit("lobby-update", { players: publicPlayers(room), hostSocketId: room.hostSocketId });
  });

  socket.on("start-game", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.hostSocketId) return; // فقط المضيف يبدأ اللعبة
    if (room.players.length < 5) {
      socket.emit("error-message", "تحتاج إلى 5 لاعبين على الأقل لبدء اللعبة.");
      return;
    }
    assignRoles(room);
    startReveal(room, roomId);
  });

  socket.on("role-ready", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "reveal") return;
    const idx = socketIndex[socket.id];
    if (!idx) return;
    room.readySet.add(idx.playerId);
    if (room.readySet.size >= room.players.length) {
      startNight(room, roomId);
    }
  });

  socket.on("doctor-select", ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "night") return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || me.role !== "Doctor") return;
    room.savedId = targetId;
  });

  socket.on("detective-select", ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "night") return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || me.role !== "Detective") return;
    const target = room.players.find(p => p.id === targetId);
    if (!target) return;
    const isMafia = MAFIA_TEAM.includes(target.role);
    socket.emit("detective-result", { targetName: target.name, isMafia });
  });

  socket.on("mafia-select", ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "night") return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || !MAFIA_TEAM.includes(me.role)) return;
    room.killedId = targetId;
    mafiaTeamSockets(room).forEach(sid => io.to(sid).emit("mafia-select-update", { targetId }));
  });

  socket.on("mafia-chat", ({ roomId, msg }) => {
    const room = rooms[roomId];
    if (!room) return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || !MAFIA_TEAM.includes(me.role)) return;
    const clean = escapeHtml(String(msg || "").slice(0, 300));
    if (!clean) return;
    mafiaTeamSockets(room).forEach(sid => io.to(sid).emit("mafia-chat-message", { name: me.name, msg: clean }));
  });

  socket.on("day-chat", ({ roomId, msg }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "day") return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || !me.alive) return;
    const clean = escapeHtml(String(msg || "").slice(0, 300));
    if (!clean) return;
    io.to(roomId).emit("day-chat-message", { name: me.name, msg: clean });
  });

  socket.on("to-vote", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "day") return;
    startVote(room, roomId);
  });

  socket.on("cast-vote", ({ roomId, targetId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "vote") return;
    const me = findPlayerBySocket(room, socket.id);
    if (!me || !me.alive) return;
    room.votes[me.id] = targetId;
    io.to(roomId).emit("vote-update", { voterId: me.id, targetId });
  });

  socket.on("request-tally", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.phase !== "vote") return;
    tallyVotes(room, roomId);
  });

  socket.on("restart-room", ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    clearRoomTimer(room);
    delete rooms[roomId];
    io.to(roomId).emit("room-restarted");
  });

  socket.on("disconnect", () => {
    const idx = socketIndex[socket.id];
    if (!idx) return;
    const room = rooms[idx.roomId];
    delete socketIndex[socket.id];
    if (!room) return;
    if (room.phase === "lobby") {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      io.to(idx.roomId).emit("lobby-update", { players: publicPlayers(room), hostSocketId: room.hostSocketId });
    }
    // في مراحل اللعبة الأخرى: نُبقي اللاعب مسجّلاً بأدواره حتى لا تنكسر الفهارس،
    // لكن يمكن اعتباره غير متصل من ناحية العميل فقط.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Mafia server running on http://localhost:${PORT}`);
});
