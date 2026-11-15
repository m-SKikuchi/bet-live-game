import express from "express";
import http from "http";
import { Server } from "socket.io";
import QRCode from "qrcode";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const QUESTIONS_FILE = path.join(__dirname, "questions.json");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const PARTICIPANTS_FILE = path.join(DATA_DIR, "participant-data.json");
const CSV_DIR = path.join(DATA_DIR, "csv");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CSV_DIR, { recursive: true });

function loadQuestions() {
    let data;

    try {
        data = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
    } catch (error) {
        throw new Error(`questions.json を読み込めません: ${error.message}`);
    }

    if (!Array.isArray(data.questions) || data.questions.length === 0) {
        throw new Error("questions.json に問題がありません");
    }

    for (const [index, question] of data.questions.entries()) {
        if (
            !question ||
            typeof question.question !== "string" ||
            !question.question.trim() ||
            !Array.isArray(question.choices) ||
            question.choices.length < 2 ||
            question.choices.some(choice =>
                typeof choice !== "string" || !choice.trim()
            )
        ) {
            throw new Error(
                `問題データの形式が不正です: ${question?.id ?? index + 1}`
            );
        }
    }

    return normalizeQuestions(data.questions);
}

function normalizeQuestions(items) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
        throw new Error("問題は1問以上100問以下にしてください");
    }
    return items.map((item, index) => {
        const question = String(item?.question ?? "").trim().slice(0, 300);
        const choices = Array.isArray(item?.choices)
            ? item.choices.map(choice => String(choice ?? "").trim().slice(0, 120))
            : [];
        if (!question) throw new Error(`問題${index + 1}の問題文を入力してください`);
        if (choices.length < 2 || choices.length > 10 || choices.some(choice => !choice)) {
            throw new Error(`問題${index + 1}の選択肢は2個以上10個以下にしてください`);
        }
        let betDurationSeconds = 10;
        if (item?.betDurationSeconds !== undefined && item?.betDurationSeconds !== null && item?.betDurationSeconds !== "") {
            betDurationSeconds = Number(item.betDurationSeconds);
            if (!Number.isInteger(betDurationSeconds) || betDurationSeconds < 1 || betDurationSeconds > 600) {
                throw new Error(`問題${index + 1}のベット締切時間は1～600秒の整数にしてください`);
            }
        }
        const oddsVisible = item?.oddsVisible === undefined ? true : Boolean(item.oddsVisible);
        return { id: index + 1, question, choices, betDurationSeconds, oddsVisible };
    });
}

const questionBank = loadQuestions();

function createId(bytes = 24) {
    return crypto.randomBytes(bytes).toString("base64url");
}

function createRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(
        { length: 6 },
        () => chars[crypto.randomInt(chars.length)]
    ).join("");
}

function createUniqueRoomCode() {
    let code;
    do {
        code = createRoomCode();
    } while (rooms[code]);
    return code;
}

function cleanName(value) {
    return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, 24);
}

function cleanDataName(value) {
    return String(value ?? "").trim().replace(/[<>]/g, "").slice(0, 40);
}

function normalizeRoomCode(value) {
    return String(value ?? "").trim().toUpperCase();
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error(`JSON読み込みエラー (${file}):`, error.message);
        }
        return fallback;
    }
}

// 一時ファイル経由で保存し、書き込み途中のJSON破損を避ける
function writeJson(file, value) {
    const temporaryFile = `${file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporaryFile, file);
}

let rooms = readJson(ROOMS_FILE, {});
let participantStore = readJson(PARTICIPANTS_FILE, {
    nextNumber: 1,
    dataSets: {}
});

function saveAll() {
    writeJson(ROOMS_FILE, rooms);
    writeJson(PARTICIPANTS_FILE, participantStore);
}

function migrateData() {
    participantStore.nextNumber = Math.max(
        1,
        Number(participantStore.nextNumber) || 1
    );
    participantStore.dataSets ||= {};

    for (const dataSet of Object.values(participantStore.dataSets)) {
        dataSet.members ||= {};
        dataSet.name ||= "名称未設定";
    }

    for (const room of Object.values(rooms)) {
        room.participants ||= {};
        room.bets ||= [];
        room.usedKeys ||= {};
        room.carryover = Number(room.carryover ?? room.jackpot) || 0;
        room.participantDataId ||= null;
        delete room.jackpot;

        room.bettingDeadlineAt = Number(room.bettingDeadlineAt) || null;
        room.bettingCountdownStartsAt = Number(room.bettingCountdownStartsAt) || null;
        if (room.status === "BETTING_CLOSING" && !room.bettingCountdownStartsAt && room.bettingDeadlineAt) {
            room.bettingCountdownStartsAt = Math.min(Date.now(), room.bettingDeadlineAt);
        }

        room.config ||= {};
        room.questions = Array.isArray(room.questions) && room.questions.length ? normalizeQuestions(room.questions) : structuredClone(questionBank);
        room.round = Math.min(
            room.questions.length,
            Math.max(1, Number(room.round) || 1)
        );
        room.config.rounds = room.questions.length;
        room.config.initialPoints = Math.max(
            1,
            Math.floor(Number(room.config.initialPoints) || 100)
        );
        room.config.choices = room.questions[room.round - 1]?.choices.length || 2;
        room.config.maxBet = Number.isSafeInteger(Number(room.config.maxBet)) && Number(room.config.maxBet) > 0
            ? Number(room.config.maxBet)
            : null;
    }

    saveAll();
}

migrateData();

function roomByHost(hostToken) {
    return Object.values(rooms).find(room => room.hostToken === hostToken);
}

function participantByNumber(room, number) {
    return Object.values(room.participants).find(
        participant => Number(participant.number) === Number(number)
    ) || null;
}

function dataSetSummaries() {
    return Object.values(participantStore.dataSets)
        .filter(dataSet => !dataSet.temporary)
        .map(dataSet => ({
            id: dataSet.id,
            name: dataSet.name,
            memberCount: Object.keys(dataSet.members).length
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function createDataSet(name, temporary = false) {
    const dataSet = {
        id: createId(10),
        name: name || "空の参加者データ",
        temporary,
        members: {},
        createdAt: Date.now()
    };
    participantStore.dataSets[dataSet.id] = dataSet;
    return dataSet;
}

function addMasterParticipant(dataSet, name) {
    const number = participantStore.nextNumber++;
    const member = { number, name, createdAt: Date.now() };
    dataSet.members[String(number)] = member;
    return member;
}

function importDataSetMembers(room, dataSet) {
    for (const member of Object.values(dataSet.members)) {
        room.participants[String(member.number)] = {
            number: member.number,
            name: member.name,
            points: room.config.initialPoints,
            joinedAt: null
        };
    }
}

function getRoundBetTotal(room) {
    return room.bets.reduce((total, bet) => total + bet.amount, 0);
}

function isFinalRound(room) {
    return room.round === room.config.rounds;
}

function getCurrentQuestion(room) {
    const question = room.questions[room.round - 1];
    if (!question) {
        throw new Error(`問題が見つかりません。ラウンド: ${room.round}`);
    }
    return question;
}

function calculatePool(room) {
    return getRoundBetTotal(room) + (isFinalRound(room) ? room.carryover : 0);
}

function calculateOdds(room) {
    const totals = Array(getCurrentQuestion(room).choices.length).fill(0);
    for (const bet of room.bets) totals[bet.choice] += bet.amount;

    const pool = calculatePool(room);
    return totals.map(total =>
        total === 0 ? null : Number((pool / total).toFixed(2))
    );
}

function createPublicRoomState(room) {
    const question = getCurrentQuestion(room);
    const odds = calculateOdds(room);
    return {
        code: room.code,
        participantDataName: room.participantDataName,
        config: room.config,
        status: room.status,
        bettingDeadlineAt: room.bettingDeadlineAt || null,
        bettingCountdownStartsAt: room.bettingCountdownStartsAt || null,
        questionBetDurationSeconds: question.betDurationSeconds || 10,
        round: room.round,
        isFinalRound: isFinalRound(room),
        carryover: room.carryover,
        question: question.question,
        questionChoices: question.choices,
        participants: Object.values(room.participants)
            .filter(participant => participant.joinedAt !== null)
            .map(participant => ({
                number: participant.number,
                name: participant.name,
                points: participant.points,
                joinedAt: participant.joinedAt
            })),
        // 参加者向け状態では、非公開設定のオッズ値自体を送信しない
        oddsVisible: question.oddsVisible !== false,
        odds: question.oddsVisible === false ? null : odds,
        answer: ["RESULT", "FINISHED"].includes(room.status) ? room.answer : null,
        lastResult: ["RESULT", "FINISHED"].includes(room.status)
            ? room.lastResult
            : null
    };
}

function createHostRoomState(room) {
    const state = createPublicRoomState(room);
    // 主催者には、参加者向けの表示設定にかかわらず常にオッズを送信する
    return { ...state, odds: calculateOdds(room) };
}

function emitRoomState(room) {
    io.to(room.code).emit("state", createPublicRoomState(room));
    io.to(`${room.code}:host`).emit("hostState", createHostRoomState(room));
}

function isAllowedTransition(from, to) {
    const transitions = {
        LOBBY: ["QUESTION_READY"],
        QUESTION_READY: ["BETTING"],
        BETTING: ["BETTING_CLOSING"],
        BETTING_CLOSING: ["BETTING_CLOSED"],
        BETTING_CLOSED: ["ANSWER_SET"],
        ANSWER_SET: ["RESULT"],
        RESULT: ["QUESTION_READY", "FINAL_WAITING"],
        FINAL_WAITING: ["FINISHED"],
        FINISHED: []
    };
    return (transitions[from] || []).includes(to);
}

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/participant-data", (_request, response) => {
    response.json({ dataSets: dataSetSummaries() });
});

app.get("/api/host/:token/questions", (request, response) => {
    const room = roomByHost(String(request.params.token || ""));
    if (!room) return response.status(401).json({ error: "主催者認証に失敗しました" });
    response.json({ questions: room.questions, editable: !["FINAL_WAITING", "FINISHED"].includes(room.status), lockedThrough: room.status === "LOBBY" ? 0 : room.round });
});

app.get("/api/host/:token/csv/round/:round", (request, response) => {
    const room = roomByHost(String(request.params.token || ""));
    if (!room) return response.status(401).json({ error: "主催者認証に失敗しました" });

    const round = Number(request.params.round) || room.round;
    const csvContent = generateRoundCsv(room, round);

    const fileName = encodeURIComponent(`room_${room.code}_round_${round}_ranking.csv`);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    response.send(csvContent);
});

app.post("/api/rooms", async (request, response) => {
    try {
        const selectedDataId = String(request.body.participantDataId || "");
        const newDataName = cleanDataName(request.body.newParticipantDataName);
        let dataSet;

        if (selectedDataId) {
            dataSet = participantStore.dataSets[selectedDataId];
            if (!dataSet || dataSet.temporary) {
                return response.status(400).json({
                    error: "選択した参加者データがありません"
                });
            }
        } else if (newDataName) {
            dataSet = createDataSet(newDataName);
        } else {
            dataSet = createDataSet("空の参加者データ", true);
        }

        const rawInitialPoints = Number(request.body.initialPoints ?? 100);

        if (!Number.isSafeInteger(rawInitialPoints) || rawInitialPoints < 1) {
            return response.status(400).json({
                error: "初期ポイントは1以上の整数にしてください"
            });
        }

        let maxBet = 20;
        if (request.body.maxBet !== undefined) {
            if (request.body.maxBet === null || String(request.body.maxBet).trim() === "") {
                maxBet = null;
            } else {
                const rawMaxBet = Number(request.body.maxBet);
                if (!Number.isSafeInteger(rawMaxBet) || rawMaxBet < 1) {
                    return response.status(400).json({
                        error: "ベット上限は1以上の整数または未指定（空欄）にしてください"
                    });
                }
                maxBet = rawMaxBet;
            }
        }

        const roomCode = createUniqueRoomCode();
        const room = {
            code: roomCode,
            hostToken: createId(),
            participantDataId: dataSet.id,
            participantDataName: dataSet.name,
            config: {
                initialPoints: rawInitialPoints,
                rounds: questionBank.length,
                choices: questionBank[0].choices.length,
                maxBet
            },
            questions: structuredClone(questionBank),
            status: "LOBBY",
            bettingDeadlineAt: null,
            bettingCountdownStartsAt: null,
            round: 1,
            carryover: 0,
            participants: {},
            bets: [],
            answer: null,
            lastResult: null,
            usedKeys: {}
        };

        importDataSetMembers(room, dataSet);
        rooms[roomCode] = room;
        saveAll();

        const baseUrl = process.env.PUBLIC_BASE_URL ||
            `${request.protocol}://${request.get("host")}`;
        const participationUrl = `${baseUrl}/?room=${encodeURIComponent(roomCode)}`;

        response.json({
            roomCode,
            hostToken: room.hostToken,
            participantDataName: room.participantDataName,
            url: participationUrl,
            qr: await QRCode.toDataURL(participationUrl)
        });
    } catch (error) {
        console.error("ルーム作成エラー:", error);
        response.status(500).json({ error: "ルームを作成できませんでした" });
    }
});

app.post("/api/rooms/:code/join", (request, response) => {
    const room = rooms[normalizeRoomCode(request.params.code)];
    if (!room) {
        return response.status(404).json({ error: "ルームがありません" });
    }

    const name = cleanName(request.body.name);
    const numberText = String(request.body.participantNumber || "").trim();

    if (!name) {
        return response.status(400).json({ error: "名前を入力してください" });
    }

    const dataSet = participantStore.dataSets[room.participantDataId];
    if (!dataSet) {
        return response.status(500).json({ error: "参加者データがありません" });
    }

    let participant;
    let assignedNumber;

    if (numberText === "") {
        const member = addMasterParticipant(dataSet, name);
        assignedNumber = member.number;
        participant = {
            number: member.number,
            name: member.name,
            points: room.config.initialPoints,
            joinedAt: Date.now()
        };
        room.participants[String(member.number)] = participant;
    } else {
        const participantNumber = Number(numberText);
        if (!Number.isSafeInteger(participantNumber) || participantNumber <= 0) {
            return response.status(400).json({ error: "参加者番号が不正です" });
        }

        const member = dataSet.members[String(participantNumber)];
        if (!member) {
            return response.status(404).json({
                error: "この参加者データに番号が登録されていません"
            });
        }
        if (member.name !== name) {
            return response.status(401).json({
                error: "参加者番号と名前が一致しません"
            });
        }

        assignedNumber = participantNumber;
        participant = participantByNumber(room, participantNumber);

        if (!participant) {
            participant = {
                number: member.number,
                name: member.name,
                points: room.config.initialPoints,
                joinedAt: Date.now()
            };
            room.participants[String(member.number)] = participant;
        } else {
            participant.joinedAt ||= Date.now();
        }
    }

    saveAll();
    emitRoomState(room);
    response.json({
        participantNumber: assignedNumber,
        state: createPublicRoomState(room)
    });
});

app.get("/api/rooms/:code", (request, response) => {
    const room = rooms[normalizeRoomCode(request.params.code)];
    if (!room) {
        return response.status(404).json({ error: "ルームがありません" });
    }
    response.json(createPublicRoomState(room));
});

app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 120000,
        skipMiddlewares: false
    }
});

const bettingCloseTimers = new Map();

function clearBettingCloseTimer(roomCode) {
    const timer = bettingCloseTimers.get(roomCode);
    if (timer) clearTimeout(timer);
    bettingCloseTimers.delete(roomCode);
}

function finishBettingClose(room) {
    if (room.status !== "BETTING_CLOSING") return;
    clearBettingCloseTimer(room.code);
    room.status = "BETTING_CLOSED";
    room.bettingDeadlineAt = null;
    room.bettingCountdownStartsAt = null;
    saveAll();
    emitRoomState(room);
}

function scheduleBettingClose(room) {
    clearBettingCloseTimer(room.code);
    if (room.status !== "BETTING_CLOSING" || !room.bettingDeadlineAt) return;

    const remaining = room.bettingDeadlineAt - Date.now();
    if (remaining <= 0) {
        finishBettingClose(room);
        return;
    }

    const timer = setTimeout(() => finishBettingClose(room), remaining);
    bettingCloseTimers.set(room.code, timer);
}

// サーバー再起動時も、保存済みの締切時刻からカウントダウンを復元する
for (const room of Object.values(rooms)) {
    if (room.status === "BETTING_CLOSING" && room.bettingDeadlineAt) {
        scheduleBettingClose(room);
    }
}

io.on("connection", socket => {
    socket.on("subscribe", payload => {
        const roomCode = normalizeRoomCode(payload?.roomCode);
        const room = rooms[roomCode];

        if (!room) {
            socket.emit("roomError", { error: "ルームがありません" });
            return;
        }

        socket.join(room.code);
        if (payload?.hostToken) {
            const hostRoom = roomByHost(payload.hostToken);
            if (hostRoom && hostRoom.code === room.code) {
                socket.join(`${room.code}:host`);
                socket.emit("hostState", createHostRoomState(room));
                return;
            }
        }
        socket.emit("state", createPublicRoomState(room));
    });

    socket.on("bet", (data = {}, acknowledge = () => {}) => {
        try {
            const room = rooms[normalizeRoomCode(data.roomCode)];
            if (!room) throw new Error("ルームがありません");
            if (!(["BETTING", "BETTING_CLOSING"].includes(room.status))) {
                throw new Error("現在はベットできません");
            }
            if (room.status === "BETTING_CLOSING" && Date.now() >= Number(room.bettingDeadlineAt || 0)) {
                finishBettingClose(room);
                throw new Error("ベット受付を締め切りました");
            }

            const participantNumber = Number(data.participantNumber);
            const participant = participantByNumber(room, participantNumber);
            if (!participant || participant.joinedAt === null) {
                throw new Error("参加者認証に失敗しました");
            }

            const idempotencyKey = String(data.idempotencyKey || "");
            if (!idempotencyKey || idempotencyKey.length > 128) {
                throw new Error("送信キーが不正です");
            }
            if (room.usedKeys[idempotencyKey]) {
                acknowledge({ ok: true, duplicate: true });
                return;
            }

            const amount = Number(data.amount);
            const choice = Number(data.choice);
            if (!Number.isSafeInteger(amount) || amount <= 0) {
                throw new Error("ベット額が不正です");
            }
            if (!Number.isInteger(choice) || choice < 0 || choice >= getCurrentQuestion(room).choices.length) {
                throw new Error("選択肢が不正です");
            }

            const previousBets = room.bets.filter(
                bet => bet.participantNumber === participantNumber
            );
            const previousAmount = previousBets.reduce(
                (total, bet) => total + bet.amount, 0
            );
            const availablePoints = participant.points + previousAmount;

            if (availablePoints < amount) throw new Error("残高不足です");

            if (!isFinalRound(room) && room.config.maxBet && amount > room.config.maxBet) {
                throw new Error(`ベット上限は ${room.config.maxBet.toLocaleString()} pt です（最終問題のみ制限なし）`);
            }

            participant.points = availablePoints - amount;
            room.bets = room.bets.filter(
                bet => bet.participantNumber !== participantNumber
            );
            room.bets.push({
                id: createId(10),
                participantNumber,
                choice,
                amount,
                at: Date.now()
            });

            room.usedKeys[idempotencyKey] = Date.now();
            saveAll();
            emitRoomState(room);
            acknowledge({ ok: true, replaced: previousBets.length > 0 });
        } catch (error) {
            acknowledge({ ok: false, error: error.message || "ベットに失敗しました" });
        }
    });

    socket.on("host", (data = {}, acknowledge = () => {}) => {
        try {
            const room = roomByHost(data.hostToken);
            if (!room) throw new Error("主催者認証に失敗しました");

            if (data.action === "saveQuestions") {
                if (["FINAL_WAITING", "FINISHED"].includes(room.status)) throw new Error("終了したゲームの問題は編集できません");
                const updatedQuestions = normalizeQuestions(data.questions);
                const currentIndex = room.round - 1;
                const currentEditable = room.status === "QUESTION_READY";
                const currentDurationEditable = ["QUESTION_READY", "BETTING"].includes(room.status);
                const priorLockedCount = room.status === "LOBBY" ? 0 : currentIndex;
                const minimumLength = room.status === "LOBBY" ? 1 : room.round;
                if (updatedQuestions.length < minimumLength) {
                    throw new Error("進行済み・進行中の問題は削除できません");
                }
                for (let index = 0; index < priorLockedCount; index++) {
                    if (JSON.stringify(updatedQuestions[index]) !== JSON.stringify(room.questions[index])) {
                        throw new Error(`問題${index + 1}は進行済みのため編集できません`);
                    }
                }
                if (currentDurationEditable) {
                    const before = room.questions[currentIndex];
                    const after = updatedQuestions[currentIndex];
                    if (!after) throw new Error("現在の問題は削除できません");
                    if (!currentEditable &&
                        (before.question !== after.question ||
                         JSON.stringify(before.choices) !== JSON.stringify(after.choices) ||
                         before.oddsVisible !== after.oddsVisible)) {
                        throw new Error("ベット受付開始後は、現在の問題文・選択肢・オッズ表示設定を変更できません。制限時間のみ変更できます。");
                    }
                } else if (room.status !== "LOBBY" &&
                    JSON.stringify(updatedQuestions[currentIndex]) !== JSON.stringify(room.questions[currentIndex])) {
                    throw new Error(`問題${currentIndex + 1}は締切カウントダウン開始後のため編集できません`);
                }
                room.questions = updatedQuestions;
                room.config.rounds = room.questions.length;
                room.config.choices = getCurrentQuestion(room).choices.length;
                saveAll();
                emitRoomState(room);
                acknowledge({ ok: true });
                return;
            }

            if (data.action === "closeBetting") {
                if (room.status !== "BETTING") {
                    throw new Error("現在はベット締切操作を実行できません");
                }
                const seconds = Number(getCurrentQuestion(room).betDurationSeconds || 10);
                if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
                    throw new Error("問題編集で締切までの時間を1～600秒に設定してください");
                }
                const animationDurationMs = 3000;
                room.status = "BETTING_CLOSING";
                room.bettingCountdownStartsAt = Date.now() + animationDurationMs;
                room.bettingDeadlineAt = room.bettingCountdownStartsAt + seconds * 1000;
                saveAll();
                emitRoomState(room);
                scheduleBettingClose(room);
                acknowledge({ ok: true, durationSeconds: seconds, bettingCountdownStartsAt: room.bettingCountdownStartsAt, bettingDeadlineAt: room.bettingDeadlineAt });
                return;
            }

            const actionMap = {
                start: "QUESTION_READY",
                startBetting: "BETTING",
                setAnswer: "ANSWER_SET",
                finalize: "RESULT",
                next: "QUESTION_READY",
                finish: "FINAL_WAITING",
                publishFinalResults: "FINISHED"
            };
            const nextStatus = actionMap[data.action];

            if (data.action === "finish" && !isFinalRound(room)) {
                throw new Error("最終問題の結果確定後に実行してください");
            }
            if (!nextStatus || !isAllowedTransition(room.status, nextStatus)) {
                throw new Error(`不正な状態遷移: ${room.status} -> ${nextStatus || data.action}`);
            }

            if (data.action === "setAnswer") {
                const answer = Number(data.answer);
                if (!Number.isInteger(answer) || answer < 0 || answer >= getCurrentQuestion(room).choices.length) {
                    throw new Error("正解が不正です");
                }
                room.answer = answer;
            }

            if (data.action === "finalize") settle(room);

            if (data.action === "next") {
                if (room.round >= room.config.rounds) throw new Error("最終ラウンドです");
                clearBettingCloseTimer(room.code);
                room.bettingDeadlineAt = null;
                room.round += 1;
                room.bets = [];
                room.answer = null;
                room.lastResult = null;
                room.usedKeys = {};
                room.config.choices = getCurrentQuestion(room).choices.length;
            }

            if (["start", "startBetting", "next"].includes(data.action)) {
                room.bettingDeadlineAt = null;
                room.bettingCountdownStartsAt = null;
            }
            room.status = nextStatus;
            saveAll();
            emitRoomState(room);
            acknowledge({ ok: true });
        } catch (error) {
            acknowledge({ ok: false, error: error.message || "操作に失敗しました" });
        }
    });
});

function createParticipantChanges(room, payoutByParticipant = new Map()) {
    const betTotals = new Map();
    for (const bet of room.bets) {
        betTotals.set(
            bet.participantNumber,
            (betTotals.get(bet.participantNumber) || 0) + bet.amount
        );
    }

    return Object.values(room.participants)
        .filter(participant => participant.joinedAt !== null)
        .map(participant => {
            const betAmount = betTotals.get(participant.number) || 0;
            const payout = payoutByParticipant.get(participant.number) || 0;
            return {
                participantNumber: participant.number,
                betAmount,
                payout,
                change: payout - betAmount,
                beforePoints: participant.points - payout + betAmount,
                afterPoints: participant.points,
                points: participant.points,
                isCorrect: room.bets.some(
                    bet => bet.participantNumber === participant.number &&
                        bet.choice === room.answer
                )
            };
        });
}

function generateRoundCsv(room, roundNumber = room.round) {
    const sorted = Object.values(room.participants)
        .filter(p => p.joinedAt !== null)
        .sort((a, b) => Number(b.points || 0) - Number(a.points || 0));

    const rows = [
        ["順位", "参加者番号", "参加者名", "保有ポイント", "問題番号"]
    ];

    let previousPoints = null;
    let currentRank = 0;

    sorted.forEach((p, index) => {
        const points = Number(p.points || 0);
        if (points !== previousPoints) {
            currentRank = index + 1;
        }
        previousPoints = points;

        const escapeCsv = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
        rows.push([
            currentRank,
            p.number,
            escapeCsv(p.name),
            points,
            roundNumber
        ]);
    });

    return "\uFEFF" + rows.map(r => r.join(",")).join("\r\n");
}

function saveRoundCsvFile(room) {
    try {
        const csvContent = generateRoundCsv(room, room.round);
        const fileName = `${room.code}_round${room.round}.csv`;
        const filePath = path.join(CSV_DIR, fileName);
        fs.writeFileSync(filePath, csvContent, "utf8");
        console.log(`CSV保存完了: ${filePath}`);
    } catch (err) {
        console.error("CSV保存エラー:", err.message);
    }
}

function settle(room) {
    const roundBetTotal = getRoundBetTotal(room);
    const winningBets = room.bets.filter(bet => bet.choice === room.answer);

    if (winningBets.length === 0) {
        room.carryover += roundBetTotal;
        room.lastResult = {
            answer: room.answer,
            answerChoice: getCurrentQuestion(room).choices[room.answer],
            winnerCount: 0,
            pool: 0,
            payouts: [],
            carriedOver: roundBetTotal,
            carryover: room.carryover,
            participantChanges: createParticipantChanges(room)
        };
        saveRoundCsvFile(room);
        return;
    }

    const appliedCarryover = isFinalRound(room) ? room.carryover : 0;
    const totalPayoutPool = roundBetTotal + appliedCarryover;
    const totalWinningAmount = winningBets.reduce((total, bet) => total + bet.amount, 0);
    const payoutByParticipant = new Map();
    let paidAmount = 0;

    winningBets.forEach((bet, index) => {
        const payout = index === winningBets.length - 1
            ? totalPayoutPool - paidAmount
            : Math.floor(totalPayoutPool * bet.amount / totalWinningAmount);
        paidAmount += payout;
        payoutByParticipant.set(
            bet.participantNumber,
            (payoutByParticipant.get(bet.participantNumber) || 0) + payout
        );
    });

    const payouts = [];
    for (const [participantNumber, amount] of payoutByParticipant) {
        const participant = participantByNumber(room, participantNumber);
        if (participant) participant.points += amount;
        payouts.push({ participantNumber, amount });
    }

    if (appliedCarryover > 0) room.carryover = 0;

    room.lastResult = {
        answer: room.answer,
        answerChoice: getCurrentQuestion(room).choices[room.answer],
        winnerCount: payoutByParticipant.size,
        pool: totalPayoutPool,
        appliedCarryover,
        payouts,
        carryover: room.carryover,
        participantChanges: createParticipantChanges(room, payoutByParticipant)
    };
    saveRoundCsvFile(room);
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`BET LIVE http://localhost:${PORT}`);
});
