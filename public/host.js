/* 主催者画面 */
(() => {
    "use strict";

    const { api, escapeHtml, label, rankParticipants, ordinalRank } = window.GameUI;
    const socket = io();
    const $ = (id) => document.getElementById(id);

    let state = null;
    let roomCode = "";
    let hostToken = "";
    let participantUrl = "";
    let editableQuestions = [];
    let activeTabId = "tab-control";
    let previousState = null;
    let overlayTimer = null;
    let countdownTimer = null;
    let countdownAnimationEndsAt = 0;
    let lastEditorStateKey = "";
    let selectedAnswerIndex = null;

    const ACTIONS = {
        LOBBY: [["ダービー開始", "start"]],
        QUESTION_READY: [["ベット開始", "startBetting"]],
        BETTING: [["ベット締切", "closeBetting"]],
        BETTING_CLOSING: [],
        BETTING_CLOSED: [],
        ANSWER_SET: [["結果確定", "finalize"]],
        RESULT: [["次の問題", "next"], ["外部結果発表待ちへ", "finish"]],
        FINAL_WAITING: [["最終結果を参加者に公開", "publishFinalResults"]]
    };

    initialize();

    function initialize() {
        bindSocketEvents();
        bindControls();
        loadParticipantDataSets();
        restoreHostRoom();
    }

    function bindControls() {
        $("createRoomBtn")?.addEventListener("click", createRoom);
        $("copyParticipantUrlBtn")?.addEventListener("click", copyParticipantUrl);
        $("returnToCreateBtn")?.addEventListener("click", returnToCreate);
        $("addNextQuestionBtn")?.addEventListener("click", addNextQuestion);
        $("addQuestionBtn")?.addEventListener("click", addQuestion);
        $("saveQuestionsBtn")?.addEventListener("click", saveQuestions);
        $("downloadCsvBtn")?.addEventListener("click", downloadCurrentRoundCsv);
        $("questionEditor")?.addEventListener("click", handleEditorClick);

        document.querySelectorAll(".tab-btn").forEach(button => {
            button.addEventListener("click", () => switchTab(button.dataset.tab));
        });
    }

    function switchTab(tabId) {
        activeTabId = tabId;
        document.querySelectorAll(".tab-btn").forEach(button => {
            button.classList.toggle("active", button.dataset.tab === tabId);
        });
        document.querySelectorAll(".tab-content").forEach(content => {
            content.classList.toggle("hidden", content.id !== tabId);
        });
    }

    function bindSocketEvents() {
        socket.on("connect", () => {
            $("connection").textContent = "● 接続済み";
            subscribeRoom();
        });

        socket.on("disconnect", () => {
            $("connection").textContent = "再接続中...";
        });

        socket.on("hostState", (newState) => {
            previousState = state;
            state = newState;
            if (!previousState || previousState.round !== state.round || state.status === "QUESTION_READY") {
                selectedAnswerIndex = null;
            }
            if (Number.isInteger(state.answer)) selectedAnswerIndex = state.answer;
            playStateTransition(previousState, state);
            render();
        });

        socket.on("roomError", (result) => {
            $("hostMessage").textContent =
                result?.error || "ルーム情報を取得できませんでした。";
        });
    }

    async function loadParticipantDataSets() {
        try {
            const result = await api("/api/participant-data");
            $("participantDataId").innerHTML = [
                '<option value="">未選択（空のデータ）</option>',
                ...(result.dataSets || []).map(dataSet =>
                    `<option value="${escapeHtml(dataSet.id)}">${escapeHtml(dataSet.name)}（${Number(dataSet.memberCount || 0)}名）</option>`
                )
            ].join("");
        } catch (error) {
            $("createMessage").textContent = error.message;
        }
    }

    function restoreHostRoom() {
        roomCode = new URLSearchParams(location.search)
            .get("room")?.trim().toUpperCase() || "";
        if (!roomCode) return;

        hostToken = localStorage.getItem(`host:${roomCode}`) || "";
        if (!hostToken) return;

        participantUrl = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
        showHostScreen();
        loadQuestions();
    }

    function subscribeRoom() {
        if (roomCode && socket.connected) {
            socket.emit("subscribe", { roomCode, hostToken });
        }
    }

    async function createRoom() {
        try {
            const initialPoints = Number($("points").value);

            if (!Number.isSafeInteger(initialPoints) || initialPoints < 1) {
                throw new Error("初期ポイントは1以上の整数にしてください。");
            }

            const maxBetInput = $("maxBet")?.value.trim();
            let maxBet = null;
            if (maxBetInput) {
                maxBet = Number(maxBetInput);
                if (!Number.isSafeInteger(maxBet) || maxBet < 1) {
                    throw new Error("ベット上限は1以上の整数にしてください（未指定の場合は空欄）。");
                }
            }

            const result = await api("/api/rooms", {
                method: "POST",
                body: JSON.stringify({
                    initialPoints,
                    maxBet,
                    participantDataId: $("participantDataId").value,
                    newParticipantDataName: $("newParticipantDataName").value.trim()
                })
            });

            roomCode = result.roomCode;
            hostToken = result.hostToken;
            participantUrl = result.url;

            localStorage.setItem(`host:${roomCode}`, hostToken);

            const url = new URL(location.href);
            url.searchParams.set("room", roomCode);
            history.replaceState(null, "", url);

            $("qr").src = result.qr;
            $("dataName").textContent = `参加者データ: ${result.participantDataName || ""}`;
            $("createMessage").textContent = "";

            showHostScreen("tab-invite");
            subscribeRoom();
            await loadQuestions();
        } catch (error) {
            $("createMessage").textContent = error.message || "ルームを作成できませんでした。";
        }
    }

    function showHostScreen(defaultTab = "tab-control") {
        $("createScreen").classList.add("hidden");
        $("hostScreen").classList.remove("hidden");
        $("roomId").textContent = `ルームID: ${roomCode}`;
        $("participantUrl").textContent = participantUrl;

        if (participantUrl && !$("qr").src) {
            $("qr").alt = "参加用QRコード（再読み込み後は再作成が必要な場合があります）";
        }
        // 呼び出し元から指定されたタブを優先する（新規作成時は参加QRを表示）
        switchTab(defaultTab || activeTabId || "tab-control");
        subscribeRoom();
    }

    function returnToCreate() {
        state = null;
        lastEditorStateKey = "";
        roomCode = "";
        hostToken = "";
        participantUrl = "";

        history.replaceState(null, "", "/host.html");
        $("hostScreen").classList.add("hidden");
        $("createScreen").classList.remove("hidden");
        $("hostButtons").innerHTML = "";
        loadParticipantDataSets();
    }

    function render() {
        if (!state) return;

        $("status").textContent = label(state.status);
        $("roomId").textContent = `ルームID: ${state.code}`;
        $("dataName").textContent = `参加者データ: ${state.participantDataName || ""}`;
        const maxBetText = state.config?.maxBet
            ? ` | ベット上限: ${Number(state.config.maxBet).toLocaleString()} pt（最終問題は無制限）`
            : "";
        $("meta").textContent =
            `${state.round}/${state.config?.rounds ?? "-"} ラウンド | 参加者 ${(state.participants || []).length}名${maxBetText}`;

        const isFinal = state.round === state.config?.rounds;
        const carryover = Number(state.carryover || 0);
        const banner = $("carryoverBanner");
        if (banner) {
            if (isFinal && carryover > 0 && state.status !== "LOBBY") {
                banner.textContent = `🎁 最終問題キャリーオーバー放出！ 過去プールされた ${carryover.toLocaleString()} pt が配当に上乗せされます！`;
                banner.classList.remove("hidden");
            } else {
                banner.textContent = "";
                banner.classList.add("hidden");
            }
        }

        renderQuestion();
        renderOdds();
        renderRanking();
        renderResult();
        renderControls();
        const editorStateKey = `${state.status}:${state.round}`;
        if (editorStateKey !== lastEditorStateKey) {
            lastEditorStateKey = editorStateKey;
            renderQuestionEditorState();
        }
        renderBettingCountdown();
    }

    function renderQuestion() {
        const visible = state.status !== "LOBBY";
        $("question").textContent = visible
            ? (state.question || "")
            : "ゲーム開始前";

        $("questionChoices").innerHTML = visible
            ? (state.questionChoices || [])
                .map(choice => `<li>${escapeHtml(choice)}</li>`)
                .join("")
            : "";
    }

    function renderOdds() {
        const canSelectAnswer = state.status === "BETTING_CLOSED";
        const answerHelp = $("answerSelectHelp");
        if (answerHelp) {
            answerHelp.classList.toggle("hidden", !canSelectAnswer);
        }
        if (Number.isInteger(state.answer)) selectedAnswerIndex = state.answer;
        const choices = state.questionChoices || [];
        const oddsHeading = $("oddsHeading");
        if (oddsHeading) oddsHeading.textContent = "現在のオッズ（主催者専用）";
        $("oddsBox").innerHTML = state.status !== "LOBBY"
            ? (state.questionChoices || []).map((choice, index) => {
                const odds = state.odds?.[index];
                const choiceText = choices[index] || `選択肢 ${index + 1}`;
                const selected = selectedAnswerIndex === index;
                const content = `
                    <span class="odds-choice-number">選択肢 ${index + 1}</span>
                    <span class="odds-choice-text">${escapeHtml(choiceText)}</span>
                    <strong>${escapeHtml(odds ?? "-")}x</strong>
                    ${selected ? '<span class="odds-answer-mark">✓ 正解に設定済み</span>' : ""}
                `;
                return canSelectAnswer
                    ? `<button type="button" class="odds-card answer-select ${selected ? "answer-selected" : ""}" data-answer-index="${index}" aria-pressed="${selected}">${content}</button>`
                    : `<div class="odds-card ${selected ? "answer-selected" : ""}">${content}</div>`;
            }).join("")
            : "";

        if (canSelectAnswer && Number.isInteger(selectedAnswerIndex)) {
            const selectedChoice = choices[selectedAnswerIndex] || `選択肢 ${selectedAnswerIndex + 1}`;
            $("oddsBox").insertAdjacentHTML("beforeend", `
                <div class="answer-confirm-area">
                    <p>現在の正解候補：<strong>${escapeHtml(selectedChoice)}</strong></p>
                    <button type="button" class="answer-confirm-button" data-confirm-answer>
                        この選択肢で正解を確定
                    </button>
                </div>
            `);
        }

        $("oddsBox").querySelectorAll("[data-answer-index]").forEach(button => {
            button.addEventListener("click", () => {
                const index = Number(button.dataset.answerIndex);
                if (!Number.isInteger(index) || index < 0 || index >= choices.length) return;
                selectedAnswerIndex = index;
                renderOdds();
                $("hostMessage").textContent = `正解候補を「${choices[index] || "選択肢"}」に変更しました。確定ボタンを押すまでは変更できます。`;
            });
        });

        $("oddsBox").querySelector("[data-confirm-answer]")?.addEventListener("click", () => {
            if (!Number.isInteger(selectedAnswerIndex)) return;
            hostAction("setAnswer", selectedAnswerIndex);
        });
    }

    function renderRanking() {
        const participants = rankParticipants(state.participants);
        $("ranking").innerHTML = participants.map((participant, index) => {
            const rank = ordinalRank(participants, index);
            return `
            <li>
                <span class="rank-number">${rank}位</span>
                <span class="rank-name">No.${escapeHtml(participant.number)} ${escapeHtml(participant.name || "")}</span>
                <span class="rank-points">${Number(participant.points || 0).toLocaleString()} pt</span>
            </li>`;
        }).join("");

        const downloadBtn = $("downloadCsvBtn");
        if (downloadBtn) {
            const canDownload = ["RESULT", "FINAL_WAITING", "FINISHED"].includes(state.status);
            downloadBtn.classList.toggle("hidden", !canDownload);
            if (canDownload) {
                downloadBtn.textContent = `📥 第${state.round}問終了時の順位CSV`;
            }
        }
    }

    function downloadCurrentRoundCsv(customRound) {
        if (!hostToken || !state) return;
        const round = customRound || state.round;
        const url = `/api/host/${encodeURIComponent(hostToken)}/csv/round/${round}`;
        const link = document.createElement("a");
        link.href = url;
        link.download = `room_${state.code}_round_${round}_ranking.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    function renderResult() {
        $("result").textContent = state.lastResult
            ? JSON.stringify(state.lastResult, null, 2)
            : "";
    }

    function renderControls() {
        const controls = (ACTIONS[state.status] || [])
            .filter(([, action]) => {
                const isFinalRound = state.round >= state.config.rounds;
                if (action === "next") return !isFinalRound;
                if (action === "finish") return isFinalRound;
                return true;
            });

        $("hostButtons").innerHTML = controls.map(([text, action]) => `
            <button type="button" data-host-action="${escapeHtml(action)}">${escapeHtml(text)}</button>
        `).join("");

        $("hostButtons").querySelectorAll("[data-host-action]").forEach(button => {
            button.addEventListener("click", () => hostAction(button.dataset.hostAction));
        });
    }

    function hostAction(action, selectedAnswer) {
        let answer;
        let durationSeconds;

        if (action === "closeBetting") {
            durationSeconds = Number(state.questionBetDurationSeconds || 10);
        }

        if (action === "setAnswer") {
            answer = Number(selectedAnswer);
            const choices = state.questionChoices || [];
            if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
                $("hostMessage").textContent = "正解候補を選択してください。";
                return;
            }
        }

        socket.emit("host", { hostToken, action, answer, durationSeconds }, (response) => {
            $("hostMessage").textContent = response?.ok
                ? (action === "setAnswer" ? `正解を「${state.questionChoices?.[answer] || "選択肢"}」に設定しました。` : "操作を反映しました。")
                : (response?.error || "操作に失敗しました。");
            if (!response?.ok && action === "setAnswer") {
                renderOdds();
            }

            // 結果確定時に自動ダウンロード
            if (action === "finalize" && response?.ok) {
                setTimeout(() => {
                    downloadCurrentRoundCsv();
                }, 300);
            }
        });
    }

    function playStateTransition(previous, current) {
        if (!previous || !current || previous.status === current.status && previous.round === current.round) return;
        if (current.status === "QUESTION_READY" && Number(current.round) === Number(current.config?.rounds) &&
            (previous.status === "LOBBY" || current.round !== previous.round)) {
            showFinalQuestionSpectacle(current);
        } else if (previous.status === "LOBBY" && current.status === "QUESTION_READY") {
            showSpectacle("DERBY START!", "忘年会ダービー、開幕！", "GAME ON");
        } else if (current.status === "QUESTION_READY" && current.round !== previous.round) {
            showSpectacle(`第${current.round}問！`, "次の問題を確認してください", "NEXT QUESTION");
        } else if (current.status === "BETTING" && previous.status === "QUESTION_READY") {
            showSpectacle("BET START!", "ベット受付スタート！", "PLACE YOUR BETS");
        } else if (current.status === "BETTING_CLOSING") {
            countdownAnimationEndsAt = Date.now() + 2300;
            showSpectacle("LAST BET!", "ベット締切まであと少し！", "FINAL COUNTDOWN");
        } else if (current.status === "BETTING_CLOSED") {
            showSpectacle("BET TIME OVER!", "ベット受付終了！", "NO MORE BETS");
        } else if (current.status === "RESULT") {
            showResultSpectacle(current, true);
        } else if (current.status === "FINAL_WAITING") {
            showSpectacle("FINAL RESULT", "外部での結果発表が終わるまで、この画面でお待ちください。", "PLEASE WAIT");
        } else if (current.status === "FINISHED") {
            showSpectacle("RESULT RELEASED", "参加者画面に最終ランキングを公開しました。", "FINAL RANKING");
        }
    }

    function showResultSpectacle(current) {
        const result = current.lastResult || {};
        const answerText = result.answerChoice || current.questionChoices?.[result.answer] || "正解";
        showSpectacle("正解発表！", `正解は「${answerText}」！`, "THE ANSWER");
        const overlay = $("showOverlay");
        overlay?.classList.remove("show-overlay-active");
        overlay?.classList.add("show-overlay-result");

        // 主催者画面では正解のみを演出表示し、参加者ごとの点数変動は表示しない。
        const details = $("showOverlayDetails");
        if (details) {
            details.classList.remove("visible");
            details.innerHTML = "";
        }
        clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => {
            $("showOverlay")?.classList.add("hidden");
            $("showOverlay")?.classList.remove("show-overlay-result");
        }, 9000);
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

    async function loadQuestions() {
        if (!hostToken) return;
        try {
            const result = await api(`/api/host/${encodeURIComponent(hostToken)}/questions`);
            editableQuestions = (result.questions || []).map(item => ({ question: item.question || "", choices: [...(item.choices || [])], betDurationSeconds: Number(item.betDurationSeconds || 10), oddsVisible: item.oddsVisible !== false }));
            renderQuestionEditor();
        } catch (error) { $("questionMessage").textContent = error.message; }
    }
    function lockedQuestionCount() {
        if (!state || state.status === "LOBBY") return 0;
        if (state.status === "QUESTION_READY") return Math.max(0, Number(state.round) - 1);
        return Math.max(0, Number(state.round) || 0);
    }
    function renderQuestionEditorState() {
        const editable = state && !["FINAL_WAITING", "FINISHED"].includes(state.status);
        const locked = lockedQuestionCount();
        $("questionEditorHelp").textContent = !editable
            ? "ゲームが終了したため問題は編集できません。"
            : (state.status === "BETTING"
                ? `問題${state.round}はベット受付中のため問題文・選択肢は変更できませんが、締切カウントダウン開始前まで制限時間は変更できます。`
                : state.status === "BETTING_CLOSING" || ["BETTING_CLOSED", "ANSWER_SET", "RESULT"].includes(state.status)
                    ? `問題1〜${locked}は締切カウントダウン開始後のため編集できません。`
                    : (locked === 0
                        ? "全ての問題を編集できます。各問題のベット締切時間は初期値10秒です。"
                        : `問題1〜${locked}は進行済みのため編集できません。問題${locked + 1}以降を編集できます。`));

        if ($("addNextQuestionBtn")) {
            $("addNextQuestionBtn").textContent = locked === 0
                ? "先頭に問題を追加"
                : `問題${locked + 1}として追加`;
            $("addNextQuestionBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
        }
        if ($("addQuestionBtn")) {
            $("addQuestionBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
        }
        if ($("saveQuestionsBtn")) {
            $("saveQuestionsBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
        }

        if (!editableQuestions.length) loadQuestions();
        else {
            if ($("questionEditor").querySelector("[data-question-index]")) syncEditorValues();
            renderQuestionEditor();
        }
    }

    function renderQuestionEditor() {
        const locked = lockedQuestionCount();
        let html = "";

        editableQuestions.forEach((item, qi) => {
            const readOnly = qi < locked || (state?.status === "BETTING" && qi === Number(state.round) - 1);
            const durationReadOnly = qi < Math.max(0, Number(state?.round || 1) - 1) ||
                (qi === Number(state?.round || 1) - 1 && !["LOBBY", "QUESTION_READY", "BETTING"].includes(state?.status));

            // ロックされた問題の直後（これから出題される最初の位置）に割り込み追加ボタンを表示
            if (qi === locked && locked > 0) {
                html += `
                <div class="question-divider">
                    <button type="button" data-insert-question-at="${locked}" class="secondary">
                        ＋ ここに問題を追加（次の問題 ${locked + 1} として割り込み）
                    </button>
                </div>`;
            }

            html += `
            <section class="question-editor-item" data-question-index="${qi}">
                <h3>問題 ${qi + 1}${readOnly ? (state?.status === "BETTING" && qi === Number(state.round) - 1 ? "（問題内容ロック）" : "（編集ロック）") : ""}</h3>
                <label>問題文<textarea data-question-text maxlength="300" ${readOnly ? "disabled" : ""}>${escapeHtml(item.question)}</textarea></label>
                <label class="bet-duration-field">ベット締切カウントダウン時間（秒）
                    <input type="number" data-bet-duration min="1" max="600" step="1" value="${Number(item.betDurationSeconds || 10)}" ${durationReadOnly ? "disabled" : ""}>
                    <small>初期値：10秒（1～600秒）。主催者が締切操作をした後、この秒数をカウントします。</small>
                </label>
                <label class="odds-visibility-field">
                    <input type="checkbox" data-odds-visible ${item.oddsVisible !== false ? "checked" : ""} ${readOnly ? "disabled" : ""}>
                    オッズを参加者・主催者画面に表示する
                    <small>チェックを外すと、参加者画面では倍率を非表示にします。主催者画面では常に倍率を確認できます。ベット受付・配当計算は通常どおり行います。</small>
                </label>
                ${item.choices.map((choice, ci) => `
                    <div class="choice-edit-row">
                        <input data-choice-text maxlength="120" value="${escapeHtml(choice)}" aria-label="選択肢 ${ci + 1}" ${readOnly ? "disabled" : ""}>
                        ${readOnly ? "" : `<button type="button" data-remove-choice="${ci}" class="danger">削除</button>`}
                    </div>
                `).join("")}
                ${readOnly ? "" : `
                    <div class="question-editor-actions">
                        <button type="button" data-insert-before="${qi}" class="secondary">直前に問題を追加</button>
                        <button type="button" data-insert-after="${qi}" class="secondary">直後に問題を追加</button>
                        <button type="button" data-move-up="${qi}" class="secondary" ${qi === locked ? "disabled" : ""}>↑ 上へ移動</button>
                        <button type="button" data-move-down="${qi}" class="secondary" ${qi === editableQuestions.length - 1 ? "disabled" : ""}>↓ 下へ移動</button>
                        <button type="button" data-add-choice class="secondary">選択肢を追加</button>
                        <button type="button" data-remove-question class="danger">問題を削除</button>
                    </div>
                `}
            </section>`;
        });

        // 未出題の問題が1問もない場合（全問題がロックされている状態）で、まだ終了していないとき
        if (locked >= editableQuestions.length && !["FINAL_WAITING", "FINISHED"].includes(state?.status)) {
            html += `
            <div class="question-divider">
                <button type="button" data-insert-question-at="${locked}" class="secondary">
                    ＋ 次の問題（問題 ${locked + 1}）を追加
                </button>
            </div>`;
        }

        $("questionEditor").innerHTML = html;
        if ($("addQuestionBtn")) $("addQuestionBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
        if ($("addNextQuestionBtn")) $("addNextQuestionBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
        if ($("saveQuestionsBtn")) $("saveQuestionsBtn").disabled = ["FINAL_WAITING", "FINISHED"].includes(state?.status);
    }

    function syncEditorValues() {
        $("questionEditor").querySelectorAll("[data-question-index]").forEach(section => {
            const i = Number(section.dataset.questionIndex);
            editableQuestions[i] = {
                question: section.querySelector("[data-question-text]").value,
                choices: [...section.querySelectorAll("[data-choice-text]")].map(input => input.value),
                betDurationSeconds: section.querySelector("[data-bet-duration]")
                    ? (section.querySelector("[data-bet-duration]").value.trim() === "" ? 10 : Number(section.querySelector("[data-bet-duration]").value))
                    : Number(editableQuestions[i]?.betDurationSeconds || 10),
                oddsVisible: section.querySelector("[data-odds-visible]")
                    ? section.querySelector("[data-odds-visible]").checked
                    : editableQuestions[i]?.oddsVisible !== false
            };
        });
    }

    function insertQuestion(index) {
        syncEditorValues();
        if (editableQuestions.length >= 100) {
            $("questionMessage").textContent = "問題数は最大100問です。";
            return;
        }
        const locked = lockedQuestionCount();
        const safeIndex = Math.max(locked, Math.min(editableQuestions.length, Number(index)));
        editableQuestions.splice(safeIndex, 0, { question: "", choices: ["", ""], betDurationSeconds: 10, oddsVisible: true });
        $("questionMessage").textContent = `問題 ${safeIndex + 1} を追加しました（「問題を保存」を押すまで反映されません）。`;
        renderQuestionEditor();

        setTimeout(() => {
            const el = $("questionEditor").querySelector(`[data-question-index="${safeIndex}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            el?.querySelector("textarea")?.focus();
        }, 50);
    }

    function addQuestion() {
        insertQuestion(editableQuestions.length);
    }

    function addNextQuestion() {
        insertQuestion(lockedQuestionCount());
    }

    function handleEditorClick(event) {
        const target = event.target;
        if (!target) return;

        if (target.matches("[data-insert-question-at]")) {
            const at = Number(target.dataset.insertQuestionAt);
            insertQuestion(at);
            return;
        }

        const section = target.closest("[data-question-index]");
        if (!section) return;
        const qi = Number(section.dataset.questionIndex);
        syncEditorValues();
        const locked = lockedQuestionCount();
        if (qi < locked) return;

        if (target.matches("[data-insert-before]")) {
            insertQuestion(qi);
            return;
        }
        if (target.matches("[data-insert-after]")) {
            insertQuestion(qi + 1);
            return;
        }
        if (target.matches("[data-move-up]")) {
            if (qi > locked) {
                const [item] = editableQuestions.splice(qi, 1);
                editableQuestions.splice(qi - 1, 0, item);
                $("questionMessage").textContent = "";
                renderQuestionEditor();
            }
            return;
        }
        if (target.matches("[data-move-down]")) {
            if (qi < editableQuestions.length - 1) {
                const [item] = editableQuestions.splice(qi, 1);
                editableQuestions.splice(qi + 1, 0, item);
                $("questionMessage").textContent = "";
                renderQuestionEditor();
            }
            return;
        }
        if (target.matches("[data-add-choice]")) {
            if (editableQuestions[qi].choices.length >= 10) {
                $("questionMessage").textContent = "選択肢は最大10個です。";
                return;
            }
            editableQuestions[qi].choices.push("");
        } else if (target.matches("[data-remove-choice]")) {
            if (editableQuestions[qi].choices.length <= 2) {
                $("questionMessage").textContent = "選択肢は2個以上必要です。";
                return;
            }
            editableQuestions[qi].choices.splice(Number(target.dataset.removeChoice), 1);
        } else if (target.matches("[data-remove-question]")) {
            if (editableQuestions.length <= 1) {
                $("questionMessage").textContent = "問題は1問以上必要です。";
                return;
            }
            editableQuestions.splice(qi, 1);
        } else {
            return;
        }
        $("questionMessage").textContent = "";
        renderQuestionEditor();
    }

    function saveQuestions() {
        syncEditorValues();
        $("saveQuestionsBtn").disabled = true;
        socket.emit("host", { hostToken, action: "saveQuestions", questions: editableQuestions }, response => {
            $("saveQuestionsBtn").disabled = false;
            $("questionMessage").textContent = response?.ok
                ? `問題を保存しました（${editableQuestions.length}問）。`
                : (response?.error || "問題を保存できませんでした。");
            if (response?.ok) loadQuestions();
        });
    }

    async function copyParticipantUrl() {
        if (!participantUrl) {
            $("hostMessage").textContent = "参加URLがありません。";
            return;
        }

        try {
            await navigator.clipboard.writeText(participantUrl);
            $("hostMessage").textContent = "参加URLをコピーしました。";
        } catch {
            $("hostMessage").textContent = "URLを選択してコピーしてください。";
        }
    }
})();
