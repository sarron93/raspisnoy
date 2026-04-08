const { Deck, TOTAL_CARDS } = require('../shared/cardsDeck');

const KOZEL_CARD_POINTS = { 'A': 11, '10': 10, 'K': 4, 'Q': 3, 'J': 2, '9': 0, '8': 0, '7': 0, '6': 0 };

// Старшинство для перебивания в "Козле": 6 < 7 < 8 < 9 < В(=J) < Д(=Q) < К < 10 < Т(=A)
const KOZEL_RANK_ORDER = { '6': 0, '7': 1, '8': 2, '9': 3, 'J': 4, 'Q': 5, 'K': 6, '10': 7, 'A': 8 };

const KOZEL_PENALTY_TARGET = 12;

function getKozelPenalty(points, handLength) {
    // Твои правила:
    // 0 очков и пустая рука → +6
    // 0 очков но карты есть → +4
    // меньше 31 → +4
    // меньше 60 → +2
    // 60+ → 0
    if (points === 0 && handLength === 0) return 6;
    if (points === 0 && handLength > 0) return 4;
    if (points < 31) return 4;
    if (points < 60) return 2;
    return 0;
}

class KozelGame {
    constructor(roomId) {
        this.roomId = roomId;
        this.gameType = 'kozel';
        this.maxPlayers = 2;

        this.players = [];
        this.gameState = 'waiting';

        this.dealerIdx = 0;
        this.firstPlayerIdx = 0;
        this.currentPlayerIdx = 0;

        this.deck = null;
        this.trumpSuit = null;
        this.trumpCard = null;

        // Текущие карты на столе:
        // - tableAttack: массив атакующих карт
        // - tableDefense: массив отвечающих карт (в порядке защиты)
        this.tableAttack = [];
        this.tableDefense = [];

        // Считанная масть атаки для проверки "ходить по мастям".
        // Если атаковали 6♠, она заменяет любую карту, поэтому для отбоя
        // нужно знать, во что она "превращалась" атакующей мастью.
        this.kozelAttackSuit = null;

        // captured: какие карты взял игрок (для подсчета очков карты)
        this.captured = [[], []];

        this.roundPoints = [0, 0];
        this.penalties = [0, 0]; // накопленные штрафные очки
        this.eggsMultiplier = 1; // множитель "яиц" (60-60)
    }

    addPlayer(socketId, name) {
        if (this.players.length >= 2) return { success: false, error: 'В Козле только 2 игрока' };

        this.players.push({
            socketId,
            name,
            hand: [],
            score: 0,
            bid: 0,
            tricks: 0,
            hasBid: true,
            isConnected: true,
        });

        return { success: true, playerIdx: this.players.length - 1 };
    }

    startGame() {
        if (this.players.length !== 2) return { success: false, error: 'Для Козла нужно ровно 2 игрока' };

        this.penalties = [0, 0];
        this.eggsMultiplier = 1;
        this.dealerIdx = 0;
        this.firstPlayerIdx = 0;

        this.gameState = 'playing';
        this.startRound();
        return { success: true };
    }

    startRound() {
        this.deck = new Deck();

        this.tableAttack = [];
        this.tableDefense = [];
        this.kozelAttackSuit = null;
        this.captured = [[], []];
        this.roundPoints = [0, 0];

        this.players.forEach((p) => {
            p.hand = [];
            p.tricks = 0;
        });

        // В "Козле" козырь берём из колоды, но не вынимаем его:
        // чтобы 6♠ (джокер) точно участвовала в раздаче.
        const trumpIndex = Math.floor(Math.random() * this.deck.cards.length);
        this.trumpCard = this.deck.cards[trumpIndex] || null;
        this.trumpSuit = this.trumpCard ? this.trumpCard.suit : null;

        // Правило: если козырем становится пика — играется бескозырка (козырей нет)
        if (this.trumpSuit === '♠') this.trumpSuit = null;

        // Раздача: по 4 карты каждому
        for (let i = 0; i < 4; i++) {
            for (let p = 0; p < 2; p++) {
                const card = this.deck.deal();
                if (card) this.players[p].hand.push(card);
            }
        }

        this.currentPlayerIdx = this.firstPlayerIdx;
    }

    canBeat(attackCard, defendCard) {
        // 6♠ (джокер) бьёт всё
        if (defendCard.isSixSpades) return true;

        // Если атаковали пиками — перебить можно ТОЛЬКО пиками
        if (attackCard.suit === '♠') {
            return defendCard.suit === '♠' &&
                KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
        }

        // Перебивание картой той же масти старшего достоинства
        if (defendCard.suit === attackCard.suit) {
            return KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
        }

        // Перебивание козырем
        if (this.trumpSuit && defendCard.suit === this.trumpSuit) {
            // Если атаковали козырем — нужно старше (по старшинству козырей)
            if (attackCard.suit === this.trumpSuit) {
                return KOZEL_RANK_ORDER[defendCard.rank] > KOZEL_RANK_ORDER[attackCard.rank];
            }
            // Если атаковали не козырем — любой козырь бьёт
            return true;
        }

        return false;
    }

    // cardIdx can be:
    // - number (single card)
    // - number[] (multi-card move)
    playCard(playerIdx, cardIdx, action = null) {
        if (this.gameState !== 'playing') return { success: false, error: 'Игра не активна' };
        if (playerIdx !== this.currentPlayerIdx) return { success: false, error: 'Сейчас не ваш ход!' };

        const player = this.players[playerIdx];
        if (!player) return { success: false, error: 'Игрок не найден' };

        const cardIdxs = Array.isArray(cardIdx) ? cardIdx : [cardIdx];
        if (cardIdxs.length === 0) return { success: false, error: 'Нужно выбрать карту' };
        if (cardIdxs.some((i) => i < 0 || i >= player.hand.length)) return { success: false, error: 'Неверные карты' };

        // Удаляем выбранные карты из руки (по убыванию индексов)
        const sortedIdxs = [...cardIdxs].sort((a, b) => b - a);
        const pickedCards = sortedIdxs.map((i) => player.hand.splice(i, 1)[0]);

        // --- АТАКА ---
        if (this.tableAttack.length === 0) {
            // Ход в Козле: не-Joker карты атаки должны быть одной масти.
            const nonJokerCards = pickedCards.filter((c) => !c.isSixSpades);
            const attackSuit = nonJokerCards.length > 0 ? nonJokerCards[0].suit : '♠';
            const allSameSuit = nonJokerCards.every((c) => c.suit === attackSuit);

            if (!allSameSuit) {
                // Возвращаем карты обратно
                sortedIdxs.forEach((i, idx) => {
                    player.hand.splice(i, 0, pickedCards[idx]);
                });
                return { success: false, error: 'В Козле ходить надо картами одной масти' };
            }

            this.kozelAttackSuit = attackSuit;
            this.tableAttack = pickedCards.map((card) => ({ playerIdx, card }));

            // Второй игрок отвечает
            this.currentPlayerIdx = (playerIdx + 1) % 2;
            return { success: true, gameState: this.getGameState() };
        }

        // --- ЗАЩИТА ---
        // В этой версии защитник делает ход одним сообщением:
        // выбирает ровно столько карт, сколько атаковали.
        if (this.tableDefense.length !== 0) {
            // Возвращаем карты обратно
            sortedIdxs.forEach((i, idx) => {
                player.hand.splice(i, 0, pickedCards[idx]);
            });
            return { success: false, error: 'Защита уже сделана' };
        }

        if (pickedCards.length !== this.tableAttack.length) {
            // Возвращаем карты обратно
            sortedIdxs.forEach((i, idx) => {
                player.hand.splice(i, 0, pickedCards[idx]);
            });
            return { success: false, error: 'Нужно отбить ровно столько карт, сколько атаковали' };
        }

        const attackerIdx = this.tableAttack[0]?.playerIdx ?? ((playerIdx + 1) % 2);
        const defenseCards = pickedCards;
        const actionNorm = action || 'discard';

        const beatPossible = actionNorm === 'beat' ? this.canBeatAll(this.tableAttack, defenseCards) : false;

        if (actionNorm === 'beat' && !beatPossible) {
            // Возвращаем карты обратно
            sortedIdxs.forEach((i, idx) => {
                player.hand.splice(i, 0, pickedCards[idx]);
            });
            return { success: false, error: 'Отбить выбранными картами нельзя' };
        }

        this.tableDefense = defenseCards.map((card) => ({ playerIdx, card }));

        const winnerIdx = beatPossible && actionNorm === 'beat' ? playerIdx : attackerIdx;
        const pile = [...this.tableAttack, ...this.tableDefense].map((x) => x.card);

        this.captured[winnerIdx].push(...pile);
        this.players[winnerIdx].tricks += 1;

        this.finishTrick(winnerIdx);
        return { success: true, gameState: this.getGameState(), trickEnded: true };
    }

    // Проверка: есть ли у игрока молотка (4 карты одной масти, 6♠ — джокер любой масти)
    hasHammer(playerIdx) {
        const hand = this.players[playerIdx]?.hand || [];
        if (hand.length < 4) return false;
        const jokerCount = hand.filter(c => c.isSixSpades).length;
        const nonJokers = hand.filter(c => !c.isSixSpades);
        for (const suit of ['♠', '♥', '♦', '♣']) {
            if (nonJokers.filter(c => c.suit === suit).length + jokerCount >= 4) return true;
        }
        return false;
    }

    // Проверка: есть ли у игрока москва (сумма очков ≥ 41, 6♠ считается как туз = 11)
    hasMoscow(playerIdx) {
        const hand = this.players[playerIdx]?.hand || [];
        if (hand.length < 4) return false;
        const total = hand.reduce((sum, c) => sum + (c.isSixSpades ? 11 : (KOZEL_CARD_POINTS[c.rank] || 0)), 0);
        return total >= 41;
    }

    // Играть комбинацию (молотка или москва) — можно вне очереди
    playCombo(playerIdx, comboType) {
        if (this.gameState !== 'playing') return { success: false, error: 'Игра не активна' };
        const player = this.players[playerIdx];
        if (!player) return { success: false, error: 'Игрок не найден' };

        const hasCombo = comboType === 'hammer' ? this.hasHammer(playerIdx) : this.hasMoscow(playerIdx);
        if (!hasCombo) {
            const name = comboType === 'hammer' ? 'молотки' : 'москвы';
            return { success: false, error: `У вас нет ${name}` };
        }

        const opponentIdx = (playerIdx + 1) % 2;

        // Если стол пустой и сейчас не мой ход — проверяем приоритет
        if (this.tableAttack.length === 0 && playerIdx !== this.currentPlayerIdx) {
            const opponentHasCombo = this.hasHammer(opponentIdx) || this.hasMoscow(opponentIdx);
            if (opponentHasCombo) {
                return { success: false, error: 'У соперника приоритет: его ход и у него тоже есть комбинация' };
            }
        }

        // Возвращаем все карты со стола владельцам
        this.tableAttack.forEach(({ playerIdx: pIdx, card }) => {
            this.players[pIdx].hand.push(card);
        });
        this.tableDefense.forEach(({ playerIdx: pIdx, card }) => {
            this.players[pIdx].hand.push(card);
        });
        this.tableAttack = [];
        this.tableDefense = [];

        // Все карты игрока идут на стол как атака
        const comboCards = [...player.hand];
        player.hand = [];

        // Определяем масть атаки (для логики джокера в защите)
        if (comboType === 'hammer') {
            const nonJokers = comboCards.filter(c => !c.isSixSpades);
            this.kozelAttackSuit = nonJokers.length > 0 ? nonJokers[0].suit : '♠';
        } else {
            this.kozelAttackSuit = null; // москва — смешанные масти
        }

        this.tableAttack = comboCards.map(card => ({ playerIdx, card }));
        this.currentPlayerIdx = opponentIdx;

        return { success: true, gameState: this.getGameState(), comboPlayed: comboType };
    }

    canBeatAll(attackEntries, defenseCards) {
        // Нормализуем карты атаки:
        // - если атаковали 6♠, считаем её подменой на старшую карту 'A' атакующей масти.
        const attackSuit = this.kozelAttackSuit || '♠';
        const attackCardsNorm = attackEntries.map(({ card }) => {
            if (card.isSixSpades) {
                return { suit: attackSuit, rank: 'A', isSixSpades: false };
            }
            return { suit: card.suit, rank: card.rank, isSixSpades: false };
        });

        if (attackCardsNorm.length !== defenseCards.length) return false;

        const n = attackCardsNorm.length;
        const used = Array(n).fill(false);

        // Бэктрекинг: ищем перестановку защитных карт, которая бьёт все атакующие.
        const dfs = (attackIdx) => {
            if (attackIdx >= n) return true;
            for (let defendIdx = 0; defendIdx < n; defendIdx++) {
                if (used[defendIdx]) continue;
                const defendCard = defenseCards[defendIdx];
                if (this.canBeat(attackCardsNorm[attackIdx], defendCard)) {
                    used[defendIdx] = true;
                    if (dfs(attackIdx + 1)) return true;
                    used[defendIdx] = false;
                }
            }
            return false;
        };

        return dfs(0);
    }

    finishTrick(winnerIdx) {
        this.tableAttack = [];
        this.tableDefense = [];
        this.kozelAttackSuit = null;

        // Добор после взятки:
        //  - сначала добирает взявший, затем второй
        //  - каждый добирает до 4 карт (столько, сколько сыграл)
        [winnerIdx, (winnerIdx + 1) % 2].forEach((idx) => {
            while (this.players[idx].hand.length < 4 && this.deck.cards.length > 0) {
                const card = this.deck.deal();
                if (card) this.players[idx].hand.push(card);
            }
        });

        this.currentPlayerIdx = winnerIdx;
        this.firstPlayerIdx = winnerIdx;

        // Если рука пустая и в колоде нет карт — конец кона
        if (this.players.every((p) => p.hand.length === 0) && this.deck.cards.length === 0) {
            this.endRound();
        }
    }

    endRound() {
        // Подсчет очков карт по правилам козла
        this.roundPoints = this.captured.map((cards) =>
            cards.reduce((sum, c) => sum + (KOZEL_CARD_POINTS[c.rank] || 0), 0)
        );

        const sum = this.roundPoints[0] + this.roundPoints[1];

        // Правило штрафов по количеству очков в коне:
        // "кто первым набирает 12 штрафных очков"
        // Здесь сделаем "недобор до 120" по твоей логике из предыдущей версии:
        if (sum < 120) {
            const lost = 120 - sum;
            const loserIdx = this.roundPoints[0] >= this.roundPoints[1] ? 1 : 0;
            this.roundPoints[loserIdx] += lost;
        }

        const p0HandLen = this.players[0]?.hand?.length || 0;
        const p1HandLen = this.players[1]?.hand?.length || 0;

        const p0Penalty = getKozelPenalty(this.roundPoints[0], p0HandLen) * this.eggsMultiplier;
        const p1Penalty = getKozelPenalty(this.roundPoints[1], p1HandLen) * this.eggsMultiplier;

        this.penalties[0] += p0Penalty;
        this.penalties[1] += p1Penalty;

        if (this.players[0]) this.players[0].score = -this.penalties[0];
        if (this.players[1]) this.players[1].score = -this.penalties[1];

        // "Яйца" (60–60) → удвоение штрафа в следующей игре
        if (this.roundPoints[0] === 60 && this.roundPoints[1] === 60) {
            this.eggsMultiplier = 2;
        } else {
            this.eggsMultiplier = 1;
        }

        // Конец партии
        if (this.penalties[0] >= KOZEL_PENALTY_TARGET || this.penalties[1] >= KOZEL_PENALTY_TARGET) {
            this.gameState = 'finished';
            return;
        }

        // Следующий дилер — проигравший кон
        const loserIdx = this.roundPoints[0] >= this.roundPoints[1] ? 1 : 0;
        this.dealerIdx = loserIdx;
        this.firstPlayerIdx = this.currentPlayerIdx;

        this.startRound();
    }

    getGameState() {
        const p0Tricks = this.players[0]?.tricks || 0;
        const p1Tricks = this.players[1]?.tricks || 0;

        return {
            roomId: this.roomId,
            gameType: 'kozel',
            gameState: this.gameState,
            selectedModeKeys: [],
            availableModes: [],
            players: this.players.map((p, idx) => ({
                name: p.name,
                score: p.score,
                bid: null,
                tricks: p.tricks,
                hasBid: true,
                handLength: p.hand.length,
                isDealer: idx === this.dealerIdx,
                penalties: this.penalties[idx],
            })),
            currentPlayer: this.currentPlayerIdx,
            trickLeader: this.currentPlayerIdx,
            cardsPerRound: 4,
            trumpSuit: this.trumpSuit,
            mode: '🐐 Козел 1×1',
            roundNumber: 1,
            maxRounds: 1,
            modeIdx: 1,
            totalModes: 1,
            cardsOnTable: [...this.tableAttack, ...this.tableDefense].map(({ playerIdx, card }) => ({
                playerIdx,
                card: card.toJSON(),
            })),
            leadSuit: this.tableAttack[0]?.card?.suit || null,
            kozelAttackSuit: this.kozelAttackSuit,
            currentTrick: p0Tricks + p1Tricks,
            testMode: false,
            jokerCondition: null,
            jokerPlayerIdx: null,
            kozel: {
                penalties: this.penalties,
                roundPoints: this.roundPoints,
                eggsMultiplier: this.eggsMultiplier,
                deckCount: this.deck?.cards?.length || 0,
            },
            playerCombos: this.players.map((_, idx) => ({
                hammer: this.hasHammer(idx),
                moscow: this.hasMoscow(idx),
            })),
        };
    }

    getGameStateWithHand(playerIdx) {
        const state = this.getGameState();
        state.hand = this.players[playerIdx]?.hand?.map((c) => c.toJSON()) || [];
        return state;
    }
}

module.exports = KozelGame;

