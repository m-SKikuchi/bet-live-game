/* 参加者画面 */
(() => {
    "use strict";

    const { api, escapeHtml, label, rankParticipants, ordinalRank } = window.GameUI;
    const socket = io();
    const $ = (id) => document.getElementById(id);

    let roomCode = "";
    let participantNumber = "";
    let participantName = "";
    let state = null;
    let selectedChoice = 0;
    let betSending = false;
    let previousState = null;
    let overlayTimer = null;
    let countdownTimer = null;
    let countdownAnimationEndsAt = 0;

    initialize();

    function initialize() {
        const roomFromUrl = new URLSearchParams(location.search).get("room");
        if (roomFromUrl) {
            roomCode = roomFromUrl.trim().toUpperCase();
            $("roomCode").value = roomCode;
            participantNumber = localStorage.getItem(`number:${roomCode}`) || "";
            participantName = localStorage.getItem(`name:${roomCode}`) || "";
            $("participantNumber").value = participantNumber;
            $("name").value = participantName;
        }

        bindSocketEvents();
        bindControls();
    }

    function bindControls() {
        $("joinBtn")?.addEventListener("click", joinRoom);
        $("showLoginBtn")?.addEventListener("click", showLogin);
        $("betBtn")?.addEventListener("click", placeBet);
        $("amountDown10")?.addEventListener("click", () => changeAmount(-10));
        $("amountDown5")?.addEventListener("click", () => changeAmount(-5));
        $("amountUp5")?.addEventListener("click", () => changeAmount(5));
        $("amountUp10")?.addEventListener("click", () => changeAmount(10));
    }

    function bindSocketEvents() {
        socket.on("connect", () => {
            $("connection").textContent = "● 接続済み";
            subscribeRoom();
        });

        socket.on("disconnect", () => {
            $("connection").textContent = "再接続中...";
        });

        socket.on("state", (newState) => {
            previousState = state;
            state = newState;
            playStateTransition(previousState, state);
            // サーバーから状態が届いても、ベット要求の応答前に
            // 送信ロックを解除しない（二重送信防止）。
            if (!$("game").classList.contains("hidden")) render();
        });

        socket.on("roomError", (result) => {
            const message = result?.error || "ルーム情報を取得できませんでした。";
            $("loginMessage").textContent = message;
            $("message").textContent = message;
        });
    }

    function subscribeRoom() {
        if (roomCode && socket.connected) {
            socket.emit("subscribe", { roomCode });
        }
    }

    async function joinRoom() {
        try {
            roomCode = $("roomCode").value.trim().toUpperCase();
            participantName = $("name").value.trim();
            const numberInput = $("participantNumber").value.trim();

            if (!roomCode) throw new Error("ルームIDを入力してください。");
            if (!participantName) throw new Error("名前を入力してください。");

            const result = await api(`/api/rooms/${encodeURIComponent(roomCode)}/join`, {
                method: "POST",
                body: JSON.stringify({
                    participantNumber: numberInput,
                    name: participantName
                })
            });

            participantNumber = String(result.participantNumber);
            state = result.state;

            localStorage.setItem(`number:${roomCode}`, participantNumber);
            localStorage.setItem(`name:${roomCode}`, participantName);
            $("participantNumber").value = participantNumber;

            const url = new URL(location.href);
            url.searchParams.set("room", roomCode);
            history.replaceState(null, "", url);

            $("login").classList.add("hidden");
            $("game").classList.remove("hidden");
            $("loginMessage").textContent = "";
            $("message").textContent = numberInput
                ? "再ログインしました。"
                : "新規ログインしました。";

            subscribeRoom();
            render();
        } catch (error) {
            $("loginMessage").textContent = error.message || "ログインに失敗しました。";
        }
    }

    function showLogin() {
        $("game").classList.add("hidden");
        $("login").classList.remove("hidden");
    }

    function render() {
        if (!state) return;

        const participant = (state.participants || []).find(
            item => String(item.number) === String(participantNumber)
        );

        $("status").textContent = label(state.status);
        $("balance").textContent = participant
            ? `${Number(participant.points || 0).toLocaleString()} pt`
            : "";
        $("assignedNumber").textContent = `あなたの参加者番号: ${participantNumber}`;
        $("meta").textContent = `${state.round}/${state.config?.rounds ?? "-"} ラウンド`;

        const waitingFinal = state.status === "FINAL_WAITING";
        const publishedFinal = state.status === "FINISHED";
        $("gameMainCard")?.classList.toggle("hidden", waitingFinal || publishedFinal);
        $("showLoginBtn")?.classList.toggle("hidden", waitingFinal || publishedFinal);
        $("finalWaiting")?.classList.toggle("hidden", !waitingFinal);
        $("finalResults")?.classList.toggle("hidden", !publishedFinal);
        if (waitingFinal) showFinalWaiting();
        if (publishedFinal) renderFinalResults();

        renderCarryoverNotice();
        renderQuestion();
        renderChoices();
        renderBetControls();
        renderMessage();
        renderBettingCountdown();
    }

    function renderQuestion() {
        const visible = state.status !== "LOBBY";
        $("question").textContent = visible
            ? (state.question || "")
            : "ゲーム開始までお待ちください。";

        $("questionChoices").innerHTML = visible
            ? (state.questionChoices || [])
                .map(choice => `<li>${escapeHtml(choice)}</li>`)
                .join("")
            : "";
    }

    function renderChoices() {
        const choices = state.questionChoices || [];
        const canSelect = ["BETTING", "BETTING_CLOSING"].includes(state.status);

        $("choicesBox").innerHTML = state.status === "LOBBY"
            ? ""
            : choices.map((choice, index) => `
                <button
                    type="button"
                    class="choice ${selectedChoice === index ? "selected" : ""}"
                    data-choice-index="${index}"
                    ${canSelect ? "" : "disabled"}
                >
                    <span class="choice-text">${index + 1}. ${escapeHtml(choice)}</span>
                    ${state.oddsVisible === false ? "" : `<strong class="choice-odds">${escapeHtml(state.odds?.[index] ?? "-")}x</strong>`}
                </button>
            `).join("") + (state.status === "QUESTION_READY"
                ? `<p class="phase-notice">問題確認中です。主催者の「ベット開始」をお待ちください。</p>`
                : "");

        $("choicesBox").querySelectorAll("[data-choice-index]").forEach(button => {
            button.addEventListener("click", () => {
                const index = Number(button.dataset.choiceIndex);
                if (!["BETTING", "BETTING_CLOSING"].includes(state?.status) || !Number.isInteger(index)) return;
                selectedChoice = index;
                renderChoices();
            });
        });
    }

    function isFinalRoundState() {
        if (!state) return false;
        if (state.isFinalRound !== undefined) return Boolean(state.isFinalRound);
        return state.round === state.config?.rounds;
    }

    function getEffectiveMaxBet() {
        if (!state || isFinalRoundState()) return null;
        const maxBet = Number(state.config?.maxBet);
        return Number.isSafeInteger(maxBet) && maxBet > 0 ? maxBet : null;
    }

    function getMaxAllowedAmount() {
        const participant = (state?.participants || []).find(
            item => String(item.number) === String(participantNumber)
        );
        const points = Math.max(0, Number(participant?.points || 0));
        const effectiveLimit = getEffectiveMaxBet();
        if (effectiveLimit !== null) {
            return Math.min(points, effectiveLimit);
        }
        return points;
    }

    function renderCarryoverNotice() {
        const banner = $("carryoverBanner");
        if (!banner) return;

        const isFinal = isFinalRoundState();
        const carryover = Number(state?.carryover || 0);

        // 最終問題かつキャリーオーバーが0点より多い場合のみユーザー通知
        if (isFinal && carryover > 0 && state.status !== "LOBBY") {
            banner.textContent = `🎁 キャリーオーバー放出！ 過去ラウンドでプールされた ${carryover.toLocaleString()} pt が最終問題の配当に上乗せされます！`;
            banner.classList.remove("hidden");
        } else {
            banner.textContent = "";
            banner.classList.add("hidden");
        }
    }

    function renderBetControls() {
        const canBet = ["BETTING", "BETTING_CLOSING"].includes(state.status) && !betSending;
        $("betBtn").disabled = !canBet;
        $("betBtn").textContent = betSending
            ? "送信中..."
            : (state.status === "QUESTION_READY" ? "ベット開始待ち" : "ベットする");

        const stepperDisabled = !["BETTING", "BETTING_CLOSING"].includes(state.status) || betSending;
        $("amount").disabled = stepperDisabled;
        if ($("amountDown10")) $("amountDown10").disabled = stepperDisabled;
        if ($("amountDown5")) $("amountDown5").disabled = stepperDisabled;
        if ($("amountUp5")) $("amountUp5").disabled = stepperDisabled;
        if ($("amountUp10")) $("amountUp10").disabled = stepperDisabled;

        const limitHelp = $("betLimitHelp");
        if (limitHelp) {
            const isFinal = isFinalRoundState();
            const effectiveLimit = getEffectiveMaxBet();
            const carryover = Number(state?.carryover || 0);

            if (isFinal) {
                if (carryover > 0) {
                    limitHelp.textContent = `（🔥最終問題：上限なし！ ＋キャリーオーバー ${carryover.toLocaleString()} pt 放出！）`;
                } else if (state.config?.maxBet) {
                    limitHelp.textContent = "（🔥最終問題：上限なし！）";
                } else {
                    limitHelp.textContent = "（🔥最終問題）";
                }
            } else if (effectiveLimit !== null) {
                limitHelp.textContent = `（上限: ${effectiveLimit.toLocaleString()} pt）`;
            } else {
                limitHelp.textContent = "";
            }
        }

        const maxAllowed = Math.max(1, getMaxAllowedAmount());
        $("amount").max = String(maxAllowed);
    }

    function renderMessage() {
        const result = state.lastResult;
        if (!["RESULT", "FINISHED"].includes(state.status) || !result) return;

        const myResult = result.participantChanges?.find(
            item => String(item.participantNumber) === String(participantNumber)
        );

        if (!myResult || Number(myResult.betAmount) === 0) {
            $("message").textContent = `今回はベットしていません。獲得ポイント：0 pt（${Number(myResult?.beforePoints || 0).toLocaleString()} pt → ${Number(myResult?.afterPoints ?? myResult?.points ?? 0).toLocaleString()} pt）`;
        } else if (myResult.isCorrect) {
            $("message").textContent =
                `正解！ +${Number(myResult.payout || 0).toLocaleString()} pt（${Number(myResult.beforePoints || 0).toLocaleString()} pt → ${Number(myResult.afterPoints ?? myResult.points ?? 0).toLocaleString()} pt）`;
        } else {
            $("message").textContent = `不正解。獲得ポイント：0 pt（${Number(myResult.beforePoints || 0).toLocaleString()} pt → ${Number(myResult.afterPoints ?? myResult.points ?? 0).toLocaleString()} pt）`;
        }
    }

    function playStateTransition(previous, current) {
        if (!previous || !current || previous.status === current.status && previous.round === current.round) return;
        if (current.status === "QUESTION_READY" && isFinalRoundStateFor(current) &&
            (previous.status === "LOBBY" || current.round !== previous.round)) {
            showFinalQuestionSpectacle(current);
        } else if (previous.status === "LOBBY" && current.status === "QUESTION_READY") {
            showSpectacle("DERBY START!", "忘年会ダービー、開幕！", "GAME ON");
        } else if (current.status === "QUESTION_READY" && current.round !== previous.round) {
            showSpectacle(`第${current.round}問！`, "次の問題です", "NEXT QUESTION");
        } else if (current.status === "BETTING" && previous.status === "QUESTION_READY") {
            showSpectacle("BET START!", "ベット受付スタート！", "PLACE YOUR BETS");
        } else if (current.status === "BETTING_CLOSING") {
            countdownAnimationEndsAt = Date.now() + 2300;
            showSpectacle("LAST BET!", "ベット締切まであと少し！", "FINAL COUNTDOWN");
        } else if (current.status === "BETTING_CLOSED") {
            showSpectacle("BET TIME OVER!", "ベット受付終了！", "NO MORE BETS");
        } else if (current.status === "RESULT") {
            showResultSpectacle(current);
        } else if (current.status === "FINAL_WAITING") {
            // 最終結果の公開までは専用待機画面を表示する
        } else if (current.status === "FINISHED") {
            // 最終ランキングは renderFinalResults() で表示
        }
    }

    function showResultSpectacle(current) {
        const result = current.lastResult || {};
        const answerText = result.answerChoice || current.questionChoices?.[result.answer] || "正解";
        showSpectacle("正解発表！", `正解は「${answerText}」！`, "THE ANSWER");
        const overlay = $("showOverlay");
        overlay?.classList.remove("show-overlay-active");
        overlay?.classList.add("show-overlay-result");
        const details = $("showOverlayDetails");
        if (!details) return;
        const mine = (result.participantChanges || []).find(item => String(item.participantNumber) === String(participantNumber));
        details.innerHTML = `` +
            (mine ? `<div class="result-personal-card"><span>獲得・払戻点数</span><strong>${Number(mine.payout || 0).toLocaleString()} pt</strong><span>今回のポイント増減</span><b>${Number(mine.change || 0) > 0 ? "+" : ""}${Number(mine.change || 0).toLocaleString()} pt</b><span>クイズ前 → クイズ後</span><b>${Number(mine.beforePoints || 0).toLocaleString()} pt → ${Number(mine.afterPoints ?? mine.points ?? 0).toLocaleString()} pt</b></div>` : `<div class="result-personal-card">今回の獲得点数：0 pt</div>`);
        details.classList.add("visible");
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => {
            $("showOverlay")?.classList.add("hidden");
            $("showOverlay")?.classList.remove("show-overlay-result");
            details.classList.remove("visible");
            details.innerHTML = "";
        }, 9000);
    }

    function isFinalRoundStateFor(current) {
        return Number(current?.round) === Number(current?.config?.rounds);
    }

    function showFinalQuestionSpectacle(current) {
        const carryover = Math.max(0, Number(current?.carryover || 0));
        const details = $("showOverlayDetails");
        showSpectacle("FINAL QUESTION", "いよいよ最終問題！最後の大勝負が始まる！", "THE GRAND FINALE");
        const overlay = $("showOverlay");
        if (!overlay) return;
        overlay.classList.add("show-overlay-final-question");
        if (details) {
            details.innerHTML = carryover > 0
                ? `<div class="final-question-carryover"><span>キャリーオーバー</span><strong>${carryover.toLocaleString()} pt</strong><b>この大金が最終問題の配当に上乗せ！</b></div>`
                : `<div class="final-question-no-carryover">ここまでの全ポイントを懸けた最終決戦！</div>`;
            details.classList.add("visible");
        }
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => {
            overlay.classList.add("hidden");
            overlay.classList.remove("show-overlay-final-question");
            details?.classList.remove("visible");
            if (details) details.innerHTML = "";
        }, 6500);
    }

function showSpectacle(title, subtitle, kicker) {
        const overlay = $("showOverlay");
        if (!overlay) return;
        $("showOverlayTitle").textContent = title;
        $("showOverlaySubtitle").textContent = subtitle;
        $("showOverlayKicker").textContent = kicker;
        const details = $("showOverlayDetails");
        if (details) { details.classList.remove("visible"); details.innerHTML = ""; }
        overlay.classList.remove("hidden", "show-overlay-active", "show-overlay-result", "show-overlay-final-question");
        void overlay.offsetWidth;
        overlay.classList.add("show-overlay-active");
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => overlay.classList.add("hidden"), 2300);
    }

    function showFinalWaiting() {
        const overlay = $("showOverlay");
        if (overlay) overlay.classList.add("hidden");
        if (overlayTimer) clearTimeout(overlayTimer);
    }

    function renderFinalResults() {
        const participants = rankParticipants(state.participants || []);
        const myIndex = participants.findIndex(item => String(item.number) === String(participantNumber));
        const myParticipant = myIndex >= 0 ? participants[myIndex] : null;
        const myRank = myIndex >= 0 ? ordinalRank(participants, myIndex) : null;
        $("myFinalStanding").innerHTML = myParticipant
            ? `<div class="my-final-rank">${myRank}位</div><div class="my-final-name">${escapeHtml(myParticipant.name || participantName || "あなた")}</div><div class="my-final-points">${Number(myParticipant.points || 0).toLocaleString()} <small>pt</small></div>`
            : `<p>あなたの最終結果を取得できませんでした。</p>`;
        $("finalRanking").innerHTML = participants.map((participant, index) => {
            const rank = ordinalRank(participants, index);
            const isMe = String(participant.number) === String(participantNumber);
            return `<li class="${isMe ? "is-me" : ""}"><span class="final-rank-number">${rank}位</span><span class="final-rank-name">${escapeHtml(participant.name || `No.${participant.number}`)}${isMe ? "（あなた）" : ""}</span><strong class="final-rank-points">${Number(participant.points || 0).toLocaleString()} pt</strong></li>`;
        }).join("");
    }

    function renderBettingCountdown() {
        const panel = $("bettingCountdown");
        if (!panel) return;
        if (state?.status !== "BETTING_CLOSING" || !state.bettingDeadlineAt) {
            countdownAnimationEndsAt = 0;
            panel.classList.add("hidden");
            if (countdownTimer) clearInterval(countdownTimer);
            countdownTimer = null;
            return;
        }
        const update = () => {
            const startsAt = Number(state?.bettingCountdownStartsAt || 0);
            if (Date.now() < Math.max(startsAt, countdownAnimationEndsAt)) {
                panel.classList.add("hidden");
                return;
            }
            panel.classList.remove("hidden");
            const remaining = Math.max(0, Math.ceil((Number(state?.bettingDeadlineAt) - Date.now()) / 1000));
            $("bettingCountdownValue").textContent = String(remaining);
            panel.classList.toggle("countdown-urgent", remaining <= 5);
        };
        update();
        if (!countdownTimer) countdownTimer = setInterval(update, 200);
    }

    function changeAmount(delta) {
        const max = Math.max(1, getMaxAllowedAmount());
        const current = Number($("amount").value) || 1;
        $("amount").value = String(Math.min(max, Math.max(1, current + delta)));
    }

    function generateIdempotencyKey() {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }
        return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}-${Math.random().toString(36).slice(2, 11)}`;
    }

    function placeBet() {
        if (!["BETTING", "BETTING_CLOSING"].includes(state?.status)) {
            $("message").textContent = "現在はベットできません。";
            return;
        }
        if (betSending) {
            $("message").textContent = "送信処理中です。お待ちください。";
            return;
        }

        const amount = Number($("amount").value);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            $("message").textContent = "ベット点数は1以上の整数で入力してください。";
            return;
        }

        const effectiveLimit = getEffectiveMaxBet();
        if (effectiveLimit !== null && amount > effectiveLimit) {
            $("message").textContent = `ベット上限は ${effectiveLimit.toLocaleString()} pt です（最終問題のみ制限なし）。`;
            return;
        }

        try {
            betSending = true;
            renderBetControls();
            $("message").textContent = "ベットを送信しています...";

            const idempotencyKey = generateIdempotencyKey();

            socket.emit("bet", {
                roomCode,
                participantNumber: Number(participantNumber),
                choice: selectedChoice,
                amount,
                idempotencyKey
            }, (response) => {
                betSending = false;
                $("message").textContent = response?.ok
                    ? "ベットを更新しました。"
                    : (response?.error || "ベットに失敗しました。");
                render();
            });
        } catch (error) {
            betSending = false;
            renderBetControls();
            $("message").textContent = error?.message || "ベット送信中にエラーが発生しました。";
        }
    }
})();
