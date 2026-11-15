/* 共通処理: 参加者画面・主催者画面 */
(() => {
    "use strict";

    const STATUS_LABELS = {
        LOBBY: "ゲーム開始待ち",
        QUESTION_READY: "問題確認中・ベット開始待ち",
        BETTING: "ベット受付中",
        BETTING_CLOSING: "ベット締切カウントダウン中",
        BETTING_CLOSED: "ベット締切",
        ANSWER_SET: "正解設定済み",
        RESULT: "結果公開",
        FINAL_WAITING: "外部結果発表待ち",
        FINISHED: "最終結果公開・ゲーム終了"
    };

    async function api(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });

        let result;
        try {
            result = await response.json();
        } catch {
            throw new Error(`サーバーから不正な応答が返されました (${response.status})`);
        }

        if (!response.ok) {
            throw new Error(result?.error || "通信に失敗しました。");
        }
        return result;
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function label(status) {
        return STATUS_LABELS[status] || status || "状態不明";
    }

    function rankParticipants(participants, { joinedOnly = false } = {}) {
        return [...(Array.isArray(participants) ? participants : [])]
            .filter((participant) =>
                !joinedOnly || participant.joinedAt !== null
            )
            .sort((a, b) => Number(b.points || 0) - Number(a.points || 0));
    }

    function ordinalRank(sortedParticipants, index) {
        if (index < 0 || index >= sortedParticipants.length) return null;
        const points = Number(sortedParticipants[index].points || 0);
        const firstIndex = sortedParticipants.findIndex(
            participant => Number(participant.points || 0) === points
        );
        return firstIndex + 1;
    }

    window.GameUI = {
        api,
        escapeHtml,
        label,
        rankParticipants,
        ordinalRank
    };
})();
