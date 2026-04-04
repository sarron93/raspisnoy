const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingTimeout: 60000,  // ✅ Таймаут пинга 60 секунд
    pingInterval: 25000  // ✅ Интервал пинга 25 секунд
});

app.use(express.static('public'));

const rooms = {};
const roomTimers = {};  // ✅ Таймеры для авто-закрытия комнат
const ROOM_CLOSE_TIMEOUT = 60000; // ✅ 1 минута до закрытия

// ✅ СТАТИСТИКА СЕРВЕРА
const serverStats = {
    totalRoomsCreated: 0,
    activeRooms: 0,
    totalPlayersConnected: 0,
    playersInGames: 0
};

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const VALUES = { '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };


const GameMode = {
    CLASSIC: {
        name: '🎯 Классика',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    NO_TRUMP: {
        name: '🃏 Бескозырка',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    MISER: {
        name: '😈 Мизер',
        hasBidding: false,  // ❌ НЕТ ТОРГОВЛИ
        autoBid: 0
    },
    BLIND: {
        name: '👁️ Слепая',
        hasBidding: true  // ✅ ТОРГОВЛЯ ЕСТЬ
    },
    KHAPKI: {
        name: '🔥 Хапки',
        hasBidding: false,  // ❌ НЕТ ТОРГОВЛИ
        autoBid: null
    }
};

const MODE_KEYS = Object.keys(GameMode);

const TOTAL_CARDS = 36;

class Card {
    constructor(suit, rank, isSixSpades = false) {
        this.suit = suit;
        this.rank = rank;
        this.isSixSpades = isSixSpades;
        this.value = VALUES[rank] || 100;
        this.jokerPower = null;  // ✅ 'high' | 'low' | null
    }

    toJSON() {
        return {
            suit: this.suit,
            rank: this.rank,
            isSixSpades: this.isSixSpades,
            value: this.value,
            jokerPower: this.jokerPower  // ✅ Добавлено
        };
    }
}

class Deck {
    constructor() {
        this.cards = [];
        this.frequencies = [];

        this.createDeck();
    }

    createDeck() {
        this.cards = [];

        for (let suit of SUITS) {
            for (let rank of RANKS) {
                const isSixSpades = (suit === '♠' && rank === '6');
                const card = new Card(suit, rank, isSixSpades);
                this.cards.push(card);
            }
        }
        this.shuffle();
    }

    shuffle() {
        if (!Array.isArray(this.cards) || this.cards.length === 0) {
            console.error('❌ Invalid cards array');
            return;
        }

        console.log('🔀 Двойная тасовка...');

        // 🔁 Выполняем тасовку дважды
        for (let pass = 0; pass < 2; pass++) {
            for (let i = this.cards.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
            }
        }

        console.log('✅ Карты растасованы (2 прохода)');
    }

    /**
     * 🎴 Выдаёт карты игроку с записью в историю
     */
    deal() {
        return this.cards.pop();
    }
}

class OnlineGame {
    constructor(roomId, maxPlayers) {
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = [];
        this.gameState = 'waiting';
        this.cardsPerRound = 1;
        this.dealerIdx = 0;
        this.roundNumber = 0;
        this.modeRoundCount = 0;
        this.currentModeIdx = 0;
        this.trumpSuit = null;
        this.trumpCard = null;
        this.currentTrick = 0;
        this.currentPlayerIdx = 0;
        this.biddingOrder = [];
        this.trickLeaderIdx = 0;
        this.cardsPlayedThisTrick = [];
        this.leadSuit = null;
        this.deck = null;
        this.actualRounds = 0;
        // ✅ НОВЫЕ ПОЛЯ ДЛЯ ДЖОКЕРА
        this.jokerChoices = {};  // { playerIdx: 'high' | 'low' }
        this.testMode = false;
        this.jokerCondition = null;  // ✅ { suit: '♠', cardType: 'high' | 'low' }
        this.jokerPlayerIdx = null;// ✅ Кто сыграл джокера первым
        this.trickCompleted = false;

        // ✅ Настройки комнаты (выбираются в лобби)
        this.selectedModeKeys = [...MODE_KEYS];
        this.campaignModes = this.selectedModeKeys.map((k) => GameMode[k]).filter(Boolean);
    }

    // ✅ АВТОМАТИЧЕСКОЕ НАЗНАЧЕНИЕ ЗАЯВОК
    autoAssignBids() {
        const mode = this.getCurrentMode();

        this.players.forEach(p => {
            if (mode.autoBid === 0) {
                // 😈 МИЗЕР — все обязаны 0
                p.bid = 0;
            } else if (mode === GameMode.KHAPKI) {
                // 🔥 ХАПКИ — заявки не важны, ставим 0 для отображения
                p.bid = 0;
                console.log(`🔥 ${p.name}: Хапки — заявки не важны`);
            } else if (mode.autoBid === null) {
                // 🃏 БЕСКОЗЫРКА — случайная заявка
                p.bid = Math.floor(Math.random() * (this.cardsPerRound + 1));
            } else {
                p.bid = mode.autoBid;
            }
            p.hasBid = true;
            console.log(`📢 ${p.name}: авто-заявка ${p.bid}`);
        });

        // ✅ СРАЗУ ПЕРЕХОДИМ К РОЗЫГРЫШУ
        this.trickLeaderIdx = (this.dealerIdx + 1) % this.players.length;
        this.cardsPlayedThisTrick = [];
        this.leadSuit = null;
        this.currentTrick = 0;

        console.log('🎴 Переход к розыгрышу (без торговли)');
    }

    addPlayer(socketId, name) {
        if (this.players.length >= this.maxPlayers) {
            return { success: false, error: 'Комната заполнена' };
        }

        const player = {
            socketId,
            name,
            hand: [],
            score: 0,
            bid: -1,
            tricks: 0,
            hasBid: false,
            isConnected: true
        };

        this.players.push(player);
        return { success: true, playerIdx: this.players.length - 1 };
    }

    removePlayer(socketId) {
        const playerIdx = this.players.findIndex(p => p.socketId === socketId);
        if (playerIdx !== -1) {
            this.players[playerIdx].isConnected = false;
            if (this.players.every(p => !p.isConnected)) {
                return true;
            }
        }
        return false;
    }

    getCurrentMode() {
        return this.campaignModes[this.currentModeIdx];
    }

    getAvailableModes() {
        return MODE_KEYS.map((key) => ({ key, name: GameMode[key].name }));
    }

    setRoomModes(modeKeys) {
        const keys = Array.isArray(modeKeys) ? modeKeys.filter(Boolean) : [];
        const unique = [...new Set(keys)];
        const valid = unique.filter((k) => GameMode[k]);

        if (valid.length === 0) {
            return { success: false, error: 'Выберите хотя бы один режим' };
        }
        if (this.gameState !== 'waiting') {
            return { success: false, error: 'Нельзя менять режим после старта игры' };
        }
        this.selectedModeKeys = valid;
        this.campaignModes = valid.map((k) => GameMode[k]);
        return { success: true };
    }

    getMaxRounds() {
        const mode = this.getCurrentMode();

        // ✅ КЛАССИКА — динамический расчет раундов
        if (mode === GameMode.CLASSIC) {
            const playerCount = this.players.length;

            if (playerCount < 2) return 13; // fallback для 1 игрока

            if (playerCount < 3) return 11; // двое играют короткую

            const maxCards = Math.floor(TOTAL_CARDS / playerCount);

            // 📐 Формула: рост + плато + спад
            // рост: (maxCards - 1) раундов (от 1 до maxCards-1)
            // плато: playerCount раундов на maxCards
            // спад: (maxCards - 1) раундов (от maxCards-1 до 1)
            const totalRounds = 2 * (maxCards - 1) + playerCount;

            console.log(`🎯 Классика: ${playerCount} игроков, макс. карт: ${maxCards}, всего раундов: ${totalRounds}`);
            return totalRounds;
        }

        return this.players.length;
    }

    getCardsPerRound(roundNumber) {
        const mode = this.getCurrentMode();
        const playerCount = this.players.length;

        // ✅ КЛАССИКА — паттерн: рост → плато → спад
        if (mode === GameMode.CLASSIC) {
            if (playerCount < 2) return 1;

            if (playerCount < 3) {
                // ✅ КЛАССИКА — паттерн 1→2→3→4→5→6→5→4→3→2→1
                if (mode === GameMode.CLASSIC) {
                    if (roundNumber < 6) {
                        return roundNumber + 1;  // 1, 2, 3, 4, 5, 6
                    } else {
                        return 11 - roundNumber;  // 5, 4, 3, 2, 1
                    }
                }
            }

            const maxCards = Math.floor(TOTAL_CARDS / playerCount);
            const ascendingRounds = maxCards - 1;  // раунды 0..(maxCards-2): карты 1..(maxCards-1)
            const plateauRounds = playerCount;      // раунды на плато: карты = maxCards

            if (roundNumber < ascendingRounds) {
                // ✅ Фаза РОСТА: 1, 2, 3, ..., maxCards-1
                return roundNumber + 1;
            } else if (roundNumber < ascendingRounds + plateauRounds) {
                // ✅ Фаза ПЛАТО: maxCards, maxCards, ... (playerCount раз)
                return maxCards;
            } else {
                // ✅ Фаза СПАДА: maxCards-1, maxCards-2, ..., 1
                const descendingIndex = roundNumber - (ascendingRounds + plateauRounds);
                return maxCards - 1 - descendingIndex;
            }
        }

        // ✅ ОСТАЛЬНЫЕ РЕЖИМЫ — фиксированное количество карт
        return Math.floor(TOTAL_CARDS / playerCount);
    }

    startGame() {
        if (this.players.length < 2) {
            return { success: false, error: 'Нужно минимум 2 игрока' };
        }

        // ✅ РАСЧЁТ ФАКТИЧЕСКОГО КОЛИЧЕСТВА РАУНДОВ
        // ✅ ЯВНЫЙ СБРОС СЧЁТЧИКОВ ПРИ СТАРТЕ ИГРЫ
        this.currentModeIdx = 0;  // ✅ Начинаем с Классики
        this.modeRoundCount = 0;  // ✅ Первый раунд
        this.actualRounds = this.getMaxRounds();
        this.modeRoundCount = 0;

        this.gameState = 'playing';
        this.startRound();
        return { success: true };
    }

    startRound() {
        const mode = this.getCurrentMode();
        this.currentTrick = 0;
        this.leadSuit = null;
        this.cardsPlayedThisTrick = [];
        this.trickLeaderIdx = (this.dealerIdx + 1) % this.players.length;
        this.trickCompleted = false;  // ✅ Сброс флага в начале раунда

        this.deck = new Deck();

        // ✅ СБРОС РУК И СТАТУСОВ ПЕРЕД НОВОЙ РАЗДАЧЕЙ
        this.players.forEach(p => {
            p.hand = [];
            p.bid = -1;
            p.tricks = 0;
            p.hasBid = false;
        });

        this.cardsPerRound = this.getCardsPerRound(this.modeRoundCount);

        const totalCardsNeeded = this.cardsPerRound * this.players.length;
        if (totalCardsNeeded > TOTAL_CARDS) {
            console.error(`❌ Не хватает карт! Нужно ${totalCardsNeeded}, есть ${TOTAL_CARDS}`);
            this.cardsPerRound = Math.floor(TOTAL_CARDS / this.players.length);
        }

        const trumpIndex = Math.floor(Math.random() * TOTAL_CARDS);
        this.trumpCard = this.deck.cards[trumpIndex];

        for (let i = 0; i < this.cardsPerRound; i++) {
            this.players.forEach(p => {
                const card = this.deck.deal();
                if (card) {
                    p.hand.push(card);
                }
            });
        }

        // ✅ ВАЛИДАЦИЯ: проверяем что у всех правильное количество карт
        console.log('🔍 Валидация раздачи:');
        let totalCardsInHands = 0;
        this.players.forEach((p, idx) => {
            console.log(`  Игрок ${idx} (${p.name}): ${p.hand.length} карт`);
            totalCardsInHands += p.hand.length;
        });
        console.log(`  Всего карт в руках: ${totalCardsInHands}`);
        console.log(`  Карт в колоде: ${this.deck.cards.length}`);
        console.log(`  Сумма: ${totalCardsInHands + this.deck.cards.length} (должно быть 36)`);

        if (totalCardsInHands + this.deck.cards.length !== TOTAL_CARDS) {
            console.error('🚨 КРИТИЧЕСКАЯ ОШИБКА: потеря карт между раундами!');
        }

        this.ensureJokerInDeal();

        const modeName = mode.name;
        if (modeName !== '🃏 Бескозырка') {
            if (this.trumpCard && this.trumpCard.suit === '♠') {
                this.trumpSuit = null;
                this.trumpCard = null;
                console.log(`🚫 Козырь: нет (выпала пика)`);
            } else if (this.trumpCard) {
                this.trumpSuit = this.trumpCard.suit;
                console.log(`🂡 Козырь: ${this.trumpSuit} (карта: ${this.trumpCard.rank}${this.trumpCard.suit})`);
            }
        } else {
            this.trumpSuit = null;
            this.trumpCard = null;
            console.log(`🚫 Козырь: нет (режим ${modeName})`);
        }

        this.biddingOrder = [];
        for (let i = 0; i < this.players.length; i++) {
            this.biddingOrder.push((this.dealerIdx + 1 + i) % this.players.length);
        }
        this.currentPlayerIdx = 0;

        console.log(`🎴 === РАУНД ${this.modeRoundCount + 1} / ${this.actualRounds} ===`);
        console.log(`🎯 Режим: ${mode.name} (индекс: ${this.currentModeIdx})`);
        console.log(`🃏 Карт на игрока: ${this.cardsPerRound}`);

        if (mode.hasBidding) {
            this.gameState = 'bidding';
            console.log(`🎴 ${this.cardsPerRound} карт, козырь: ${this.trumpSuit || 'нет'} (ТОРГОВЛЯ)`);
        } else {
            this.autoAssignBids();
            this.gameState = 'playing';
            console.log(`🎴 ${this.cardsPerRound} карт, козырь: ${this.trumpSuit || 'нет'} (БЕЗ ТОРГОВЛИ)`);
        }

        return this.getGameState();
    }

    makeBid(playerIdx, bid) {
        const player = this.players[playerIdx];
        const mode = this.getCurrentMode();

        // ✅ ПРОВЕРКА: ЕСТЬ ЛИ ТОРГОВЛЯ В ЭТОМ РЕЖИМЕ
        if (!mode.hasBidding) {
            return { success: false, error: 'В этом режиме торговля отключена' };
        }

        if (!player || player.hasBid) {
            return { success: false, error: 'Невозможно сделать заявку' };
        }

        if (playerIdx === this.dealerIdx) {
            const totalBid = this.players
                .filter(p => p.hasBid)
                .reduce((sum, p) => sum + p.bid, 0);

            if (totalBid + bid === this.cardsPerRound) {
                return { success: false, error: 'Сумма не должна равняться количеству карт' };
            }
        }

        player.bid = bid;
        player.hasBid = true;

        if (this.players.every(p => p.hasBid)) {
            this.gameState = 'playing';
            this.trickLeaderIdx = (this.dealerIdx + 1) % this.players.length;
            this.cardsPlayedThisTrick = [];
            this.leadSuit = null;
            this.currentTrick = 0;
            console.log('🎴 Переход к розыгрышу: лидер=' + this.trickLeaderIdx + ', leadSuit=null');
            return { success: true, gameState: this.getGameState() };
        }

        this.currentPlayerIdx++;
        return { success: true, gameState: this.getGameState() };
    }

    playCard(playerIdx, cardIdx) {
        const player = this.players[playerIdx];

        // ✅ 🔥 ПЕРВАЯ ПРОВЕРКА: завершена ли взятка?
        if (this.trickCompleted) {
            console.warn(`⚠️ Игрок ${playerIdx} попытался ходить после завершения взятки`);
            return { success: false, error: 'Взятка уже завершена' };
        }

        // ✅ Вторая проверка: валидность игрока и карты
        if (!player || cardIdx < 0 || cardIdx >= player.hand.length) {
            return { success: false, error: 'Неверная карта' };
        }

        // ✅ Третья проверка: чей сейчас ход?
        const expectedPlayerIdx = this.getCurrentPlayerIdx();
        if (playerIdx !== expectedPlayerIdx) {
            console.error(`❌ Игрок ${playerIdx} попытался ходить вне очереди (ожидается ${expectedPlayerIdx})`);
            return { success: false, error: 'Сейчас не ваш ход!' };
        }

        // ✅ Проверка что у игрока ещё есть карты
        if (player.hand.length === 0) {
            return { success: false, error: 'У вас нет карт!' };
        }

        const validIndices = this.getValidCards(player);
        if (!validIndices.includes(cardIdx)) {
            return { success: false, error: 'Недопустимый ход! Следуйте масти или бейте козырем.' };
        }

        // ✅ ТОЛЬКО ТЕПЕРЬ удаляем карту из руки
        const card = player.hand.splice(cardIdx, 1)[0];
        console.log(`🃏 Карта ${card.rank}${card.suit} удалена из руки игрока ${playerIdx}`);

        // ✅ Для джокера — НЕ добавляем на стол сразу
        if (card.isSixSpades) {
            this.pendingJoker = {
                playerIdx: playerIdx,
                card: card,
                isFirstCard: this.cardsPlayedThisTrick.length === 0,
                needsCondition: this.cardsPlayedThisTrick.length === 0
            };

            io.to(this.roomId).emit('jokerPlayed', {
                playerIdx: playerIdx,
                playerName: player.name,
                card: card.toJSON(),
                trickNumber: this.currentTrick + 1,
                isFirstCard: this.cardsPlayedThisTrick.length === 0,
                needsCondition: this.cardsPlayedThisTrick.length === 0
            });

            this.players.forEach((p, idx) => {
                const socket = p.socketId;
                if (socket) {
                    const stateWithHand = this.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                }
            });

            return {
                success: true,
                gameState: this.getGameState(),
                waitingForJokerChoice: true
            };
        }

        // ✅ Для обычных карт — добавляем на стол
        if (this.cardsPlayedThisTrick.length === 0) {
            this.leadSuit = card.suit;
            console.log(`🎴 Первая карта взятки: ${card.rank}${card.suit}, масть хода: ${this.leadSuit}`);
        }

        this.cardsPlayedThisTrick.push({ playerIdx, card });
        console.log(`🃏 Игрок ${playerIdx} сыграл ${card.rank}${card.suit}, карт на столе: ${this.cardsPlayedThisTrick.length}`);

        if (this.cardsPlayedThisTrick.length >= this.players.length) {
            return this.completeTrick();
        }

        return { success: true, gameState: this.getGameState() };
    }

    // Добавьте в класс OnlineGame:
    getCurrentPlayerIdx() {
        if (this.gameState === 'bidding') {
            return this.biddingOrder[this.currentPlayerIdx];
        }

        if (this.gameState === 'playing') {
            return (this.trickLeaderIdx + this.cardsPlayedThisTrick.length) % this.players.length;
        }

        return 0;
    }

    // ✅ ЗАВЕРШЕНИЕ ВЗЯТКИ — ОПРЕДЕЛЕНИЕ ПОБЕДИТЕЛЯ
    completeTrick() {
        // ✅ Логирование перед завершением
        console.log('🎯 Завершение взятки:');
        this.players.forEach((p, idx) => {
            console.log(`  Игрок ${idx} (${p.name}): ${p.hand.length} карт в руке`);
        });
        console.log(`  Карт на столе: ${this.cardsPlayedThisTrick.length}`);

        if (this.trickCompleted) {
            console.warn('⚠️ Взятка уже завершена, игнорируем повторный вызов');
            return { success: false, error: 'Взятка уже завершена' };
        }
        this.trickCompleted = true;

        const winner = this.determineTrickWinner();

        this.players[winner].tricks++;
        this.trickLeaderIdx = winner;
        this.currentTrick++;

        console.log(`🏆 Взятку выиграл игрок ${winner} (${this.players[winner].name})`);

        const gameState = this.getGameState();
        io.to(this.roomId).emit('cardPlayed', gameState);

        if (this.currentTrick >= this.cardsPerRound) {
            console.log('🎯 Раунд завершен');
            io.to(this.roomId).emit('roundFinished', {
                roundNumber: this.modeRoundCount + 1,
                totalRounds: this.actualRounds,
                playersScores: this.players.map(p => ({ name: p.name, tricks: p.tricks, bid: p.bid }))
            });

            setTimeout(() => {
                this.trickCompleted = false;
                this.endRound();
            }, 5000);

            return { success: true, gameState: gameState, roundEnded: true };
        }

        setTimeout(() => {
            this.trickCompleted = false;
            this.cardsPlayedThisTrick = [];
            this.leadSuit = null;
            this.jokerCondition = null;
            this.jokerPlayerIdx = null;

            // ✅ Логирование после сброса
            console.log('🎴 Взятка сброшена, карты на столе очищены:');
            this.players.forEach((p, idx) => {
                console.log(`  Игрок ${idx} (${p.name}): ${p.hand.length} карт в руке`);
            });

            this.players.forEach((player, idx) => {
                const socket = player.socketId;
                if (socket) {
                    const stateWithHand = this.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                }
            });
        }, 3000);

        return { success: true, gameState: gameState, trickEnded: true };
    }

    getValidCards(player) {
        const hand = player.hand;
        const mode = this.getCurrentMode();

        // ✅ Первый ход — все карты валидны
        if (this.cardsPlayedThisTrick.length === 0) {
            return hand.map((_, i) => i);
        }

        // ✅ Если есть условие джокера — находим ОДНУ конкретную карту
        if (this.jokerCondition && this.jokerPlayerIdx !== this.players.indexOf(player)) {
            const { suit, cardType } = this.jokerCondition;

            // Находим все карты нужной масти (исключая джокеров)
            const suitCards = hand.map((card, i) => ({ card, index: i }))
                .filter(({ card }) => card.suit === suit && !card.isSixSpades);

            if (suitCards.length > 0) {
                let validIndex = -1;

                if (cardType === 'high') {
                    // ✅ Находим ОДНУ старшую карту (максимальное значение)
                    const maxCard = suitCards.reduce((max, current) =>
                        current.card.value > max.card.value ? current : max
                    );
                    validIndex = maxCard.index;
                    console.log(`🔍 Условие джокера: масть=${suit}, тип=high → валидна только карта ${maxCard.card.rank}${maxCard.card.suit} (индекс ${validIndex})`);
                } else if (cardType === 'low') {
                    // ✅ Находим ОДНУ младшую карту (минимальное значение)
                    const minCard = suitCards.reduce((min, current) =>
                        current.card.value < min.card.value ? current : min
                    );
                    validIndex = minCard.index;
                    console.log(`🔍 Условие джокера: масть=${suit}, тип=low → валидна только карта ${minCard.card.rank}${minCard.card.suit} (индекс ${validIndex})`);
                }

                // ✅ Возвращаем ОДНУ карту + джокеры (они всегда валидны)
                const jokerIndices = hand.map((_, i) => i).filter(i => hand[i].isSixSpades);
                return [validIndex, ...jokerIndices].filter(i => i !== -1);
            }

            // ✅ Если нет карт нужной масти — можно сбрасывать любые
            console.log(`⚠️ Нет карт масти ${suit} — разрешаем сброс любых карт`);
            return hand.map((_, i) => i);
        }

        // ✅ Обычная логика (без условия джокера)
        const leadSuit = this.leadSuit;

        const sameSuitIndices = hand.map((_, i) => i).filter(i => {
            const card = hand[i];
            return card.suit === leadSuit && !card.isSixSpades;
        });

        if (sameSuitIndices.length > 0) {
            const jokerIndices = hand.map((_, i) => i).filter(i => hand[i].isSixSpades);
            return [...sameSuitIndices, ...jokerIndices];
        }

        if (mode === GameMode.NO_TRUMP) {
            return hand.map((_, i) => i);
        }

        if (this.trumpSuit) {
            const trumpIndices = hand.map((_, i) => i).filter(i => {
                const card = hand[i];
                return card.suit === this.trumpSuit && !card.isSixSpades;
            });

            if (trumpIndices.length > 0) {
                const jokerIndices = hand.map((_, i) => i).filter(i => hand[i].isSixSpades);
                return [...trumpIndices, ...jokerIndices];
            }
        }

        return hand.map((_, i) => i);
    }



    // ✅ ГАРАНТИРУЕТ ЧТО ДЖОКЕР БУДЕТ В РАЗДАЧЕ (для тест-режима)
    ensureJokerInDeal() {
        if (!this.testMode) return;

        // ✅ Проверяем, есть ли джокер у кого-то из игроков
        let jokerDealt = false;
        let jokerHolder = null;

        for (let i = 0; i < this.players.length; i++) {
            const player = this.players[i];
            const jokerIndex = player.hand.findIndex(c => c.isSixSpades);

            if (jokerIndex !== -1) {
                jokerDealt = true;
                jokerHolder = i;
                break;
            }
        }

        // ✅ Если джокер уже в раздаче — ничего не делаем
        if (jokerDealt) {
            console.log(`🃏 Джокер уже в раздаче (у игрока ${jokerHolder})`);
            return;
        }

        // ✅ Если джокер ещё в колоде — меняем его с случайной картой
        const jokerInDeck = this.deck.cards.findIndex(c => c.isSixSpades);

        if (jokerInDeck !== -1) {
            // ✅ Выбираем случайного игрока и случайную карту у него
            const randomPlayerIdx = Math.floor(Math.random() * this.players.length);
            const randomPlayer = this.players[randomPlayerIdx];

            if (randomPlayer.hand.length > 0) {
                const cardToSwapIdx = Math.floor(Math.random() * randomPlayer.hand.length);
                const cardToSwap = randomPlayer.hand[cardToSwapIdx];

                // ✅ Меняем местами
                const joker = this.deck.cards.splice(jokerInDeck, 1)[0];
                randomPlayer.hand[cardToSwapIdx] = joker;
                this.deck.cards.push(cardToSwap);

                console.log(`🃏 Джокер добавлен в раздачу (игрок ${randomPlayerIdx}, замена: ${cardToSwap.rank}${cardToSwap.suit})`);
            }
        }
    }

    determineTrickWinner() {
        if (this.cardsPlayedThisTrick.length === 0) return this.trickLeaderIdx;

        const leadCard = this.cardsPlayedThisTrick[0].card;
        const leadSuit = this.leadSuit;

        let bestIdx = 0;
        let bestCard = leadCard;

        for (let i = 1; i < this.cardsPlayedThisTrick.length; i++) {
            const currentCard = this.cardsPlayedThisTrick[i].card;

            // ============================================
            // 1️⃣ ПРИОРИТЕТ 1: Джокеры
            // ============================================

            if (currentCard.isSixSpades) {
                const currentJokerPower = currentCard.jokerPower || 'high';

                if (currentJokerPower === 'high') {
                    if (!bestCard.isSixSpades || bestCard.jokerPower !== 'high') {
                        bestIdx = i;
                        bestCard = currentCard;
                    }
                }
                continue;
            }

            if (bestCard.isSixSpades && bestCard.jokerPower === 'high') {
                continue;
            }

            if (bestCard.isSixSpades && bestCard.jokerPower === 'low') {
                if (currentCard.suit === leadSuit || (this.trumpSuit && currentCard.suit === this.trumpSuit)) {
                    bestIdx = i;
                    bestCard = currentCard;
                }
                continue;
            }

            // ============================================
            // 2️⃣ ПРИОРИТЕТ 2: Условие джокера (high/low карты)
            // ============================================

            if (this.jokerCondition && this.jokerPlayerIdx !== null) {
                const { suit, cardType } = this.jokerCondition;

                // Обе карты должны соответствовать условию джокера
                const bestMatchesCondition =
                    bestCard.suit === suit &&
                    !bestCard.isSixSpades &&
                    (cardType === 'high' ? bestCard.value >= 10 : bestCard.value < 10);

                const currentMatchesCondition =
                    currentCard.suit === suit &&
                    !currentCard.isSixSpades &&
                    (cardType === 'high' ? currentCard.value >= 10 : currentCard.value < 10);

                if (currentMatchesCondition) {
                    if (!bestMatchesCondition) {
                        // Текущая соответствует, лучшая — нет → текущая выигрывает
                        bestIdx = i;
                        bestCard = currentCard;
                    } else if (cardType === 'high') {
                        // Обе соответствуют, ищем старшую
                        if (currentCard.value > bestCard.value) {
                            bestIdx = i;
                            bestCard = currentCard;
                        }
                    } else if (cardType === 'low') {
                        // Обе соответствуют, ищем младшую
                        if (currentCard.value < bestCard.value) {
                            bestIdx = i;
                            bestCard = currentCard;
                        }
                    }
                }
                // Если текущая не соответствует условию — она не может выиграть
                continue;
            }

            // ============================================
            // 3️⃣ ПРИОРИТЕТ 3: Обычная логика (если нет условия джокера)
            // ============================================

            if (leadSuit === '♠') {
                if (currentCard.suit !== '♠') continue;
                if (bestCard.suit !== '♠') {
                    bestIdx = i;
                    bestCard = currentCard;
                } else if (currentCard.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = currentCard;
                }
                continue;
            }

            if (this.trumpSuit && currentCard.suit === this.trumpSuit) {
                if (bestCard.suit !== this.trumpSuit) {
                    bestIdx = i;
                    bestCard = currentCard;
                } else if (currentCard.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = currentCard;
                }
                continue;
            }

            if (this.trumpSuit && bestCard.suit === this.trumpSuit) {
                continue;
            }

            if (currentCard.suit === leadSuit) {
                if (bestCard.suit === leadSuit && currentCard.value > bestCard.value) {
                    bestIdx = i;
                    bestCard = currentCard;
                } else if (bestCard.suit !== leadSuit && bestCard.suit !== this.trumpSuit) {
                    bestIdx = i;
                    bestCard = currentCard;
                }
            }
        }

        return this.cardsPlayedThisTrick[bestIdx].playerIdx;
    }



    endRound() {
        const mode = this.getCurrentMode();
        let multiplier = 1;

        // ✅ Проверка множителя (Слепая и Хапки)
        if ([GameMode.BLIND, GameMode.KHAPKI].includes(mode)) {
            multiplier = 2;
        }

        this.players.forEach(p => {
            let points = 0;

            // 🔥 ХАПКИ — каждая взятка = +20 очков (без сравнения с заявкой)
            if (mode === GameMode.KHAPKI) {
                points = p.tricks * 20;  // ✅ Просто 20 очков за каждую взятку
                console.log(`🔥 ${p.name}: Хапки — ${p.tricks} взяток × 20 = ${points}`);
            }else if (mode === GameMode.MISER) {
                if (p.tricks === 0) {
                    points = 20 * multiplier;
                    console.log(`🎯 ${p.name}: Мизер сыграл! +${points}`);
                } else {
                    points = -10 * p.tricks * multiplier;
                    console.log(`😞 ${p.name}: Мизер провален (${p.tricks} взяток) ${points}`);
                }
            } else {
                if (p.tricks === p.bid) {
                    points = 10 * p.bid * multiplier;
                    if (p.bid === 0) points = 5 * multiplier;
                } else if (p.tricks > p.bid) {
                    points = p.tricks * multiplier;
                } else {
                    points = -10 * (p.bid - p.tricks) * multiplier;
                }
            }

            p.score += points;
            console.log(`📊 ${p.name}: ${points >= 0 ? '+' : ''}${points} (Всего: ${p.score})`);
        });

        this.modeRoundCount++;

        if (this.modeRoundCount >= this.actualRounds) {
            if (this.currentModeIdx < this.campaignModes.length - 1) {
                this.currentModeIdx++;
                this.modeRoundCount = 0;
                this.actualRounds = this.getMaxRounds();

                console.log(`🎉 Смена режима: ${this.getCurrentMode().name} (${this.actualRounds} раундов)`);
            } else {
                this.gameState = 'finished';
                console.log('🏆 Кампания завершена!');
                io.to(this.roomId).emit('gameFinished', this.getGameState());
                return { success: true, gameState: this.getGameState(), finished: true };
            }
        }

        this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
        console.log(`🎴 Новый дилер: игрок ${this.dealerIdx}`);

        // ✅ ЗАПУСКАЕМ СЛЕДУЮЩИЙ РАУНД
        this.startRound();

        // ✅ ОТПРАВЛЯЕМ СОСТОЯНИЕ КАЖДОМУ ИГРОКУ С ЕГО РУКОЙ
        this.players.forEach((player, idx) => {
            const socket = this.players[idx].socketId;
            if (socket) {
                const stateWithHand = this.getGameStateWithHand(idx);
                io.to(socket).emit('gameState', stateWithHand);
            }
        });

        console.log('🎴 Состояние отправлено всем игрокам с руками');

        return { success: true, gameState: this.getGameState() };
    }


    getGameState() {
        return {
            roomId: this.roomId,
            gameState: this.gameState,
            selectedModeKeys: this.selectedModeKeys,
            availableModes: this.getAvailableModes(),
            players: this.players.map((p, idx) => ({
                name: p.name,
                score: p.score,
                bid: p.hasBid ? p.bid : null,
                tricks: p.tricks,
                hasBid: p.hasBid,  // ✅ ВАЖНО: для проверки в клиенте
                handLength: p.hasBid ? p.hand.length : 0,  // ✅ Скрываем количество карт до ставки
                isDealer: idx === this.dealerIdx
            })),
            currentPlayer: this.gameState === 'bidding' ? this.biddingOrder[this.currentPlayerIdx] : null,
            trickLeader: this.trickLeaderIdx,
            cardsPerRound: this.cardsPerRound,
            trumpSuit: this.trumpSuit,
            mode: this.getCurrentMode().name,
            roundNumber: this.modeRoundCount + 1,
            maxRounds: this.actualRounds,
            modeIdx: this.currentModeIdx + 1,
            totalModes: this.campaignModes.length,
            cardsOnTable: this.cardsPlayedThisTrick.map(({ playerIdx, card }) => ({
                playerIdx,
                card: card.toJSON()
            })),
            leadSuit: this.leadSuit,  // ✅ Будет null пока игрок не выберет
            currentTrick: this.currentTrick,
            testMode: this.testMode,
            jokerCondition: this.jokerCondition,  // ✅ Передаём клиенту
            jokerPlayerIdx: this.jokerPlayerIdx,  // ✅ Кто задал условие
        };
    }

    getGameStateWithHand(playerIdx) {
        const state = this.getGameState();
        const mode = this.getCurrentMode();
        const player = this.players[playerIdx];

        // ✅ В РЕЖИМЕ СЛЕПАЯ — скрываем карты пока игрок не сделал ставку
        if (mode.name === '👁️ Слепая' && !player.hasBid) {
            // ✅ Возвращаем пустую руку пока ставка не сделана
            state.hand = [];
            console.log(`👁️ Игрок ${playerIdx} (${player.name}): карты скрыты (нет ставки)`);
        } else {
            // ✅ Обычная выдача руки
            state.hand = this.getPlayerHand(playerIdx);
            console.log(`📤 Отправляем состояние игроку ${playerIdx}: ${state.hand.length} карт`);
        }

        return state;
    }

    getPlayerHand(playerIdx) {
        const player = this.players[playerIdx];
        if (!player) {
            console.log(`❌ Игрок ${playerIdx} не найден`);
            return [];
        }
        const hand = player.hand.map(card => card.toJSON());
        console.log(`🃏 Рука игрока ${playerIdx}:`, hand.map(c => c.rank + c.suit));
        return hand;
    }
}

io.on('connection', (socket) => {
    console.log('🔌 Игрок подключился:', socket.id);

    socket.on('createRoom', ({ playerName, maxPlayers = 4, testMode = false }) => {
        const roomId = uuidv4().substr(0, 6).toUpperCase();
        const room = new OnlineGame(roomId, maxPlayers);

        // ✅ Включаем тест-режим если запрошено
        room.testMode = testMode;

        const result = room.addPlayer(socket.id, playerName);
        if (result.success) {
            rooms[roomId] = room;

            // ✅ ОБНОВЛЯЕМ СТАТИСТИКУ
            serverStats.totalRoomsCreated++;
            serverStats.activeRooms = Object.keys(rooms).length;
            serverStats.totalPlayersConnected++;

            socket.join(roomId);
            socket.emit('roomCreated', {
                roomId,
                playerIdx: result.playerIdx,
                testMode: testMode,  // ✅ Сообщаем клиенту
                state: room.getGameState()
            });
            // ✅ ОТПРАВЛЯЕМ ОБНОВЛЁННУЮ СТАТИСТИКУ ВСЕМ
            io.emit('serverStats', serverStats);
            console.log(`🏠 Комната создана: ${roomId}${testMode ? ' (ТЕСТ-РЕЖИМ)' : ''}`);
        } else {
            socket.emit('error', result.error);
        }
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }

        const result = room.addPlayer(socket.id, playerName);
        if (result.success) {
            socket.join(roomId);
            socket.emit('roomJoined', { roomId, playerIdx: result.playerIdx, state: room.getGameState() });
            io.to(roomId).emit('playerJoined', room.getGameState());

            // ✅ ОБНОВЛЯЕМ СТАТИСТИКУ
            serverStats.totalPlayersConnected++;
            serverStats.playersInGames = Object.values(rooms).reduce((sum, room) => {
                return sum + room.players.filter(p => p.isConnected).length;
            }, 0);

            // ✅ ОТПРАВЛЯЕМ ОБНОВЛЁННУЮ СТАТИСТИКУ ВСЕМ
            io.emit('serverStats', serverStats);

            console.log(`👥 Игрок ${playerName} присоединился к ${roomId}`);
        } else {
            socket.emit('error', result.error);
        }
    });

    socket.on('setRoomModes', ({ roomId, modeKeys }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }

        const result = room.setRoomModes(modeKeys);
        if (!result.success) {
            socket.emit('error', result.error);
            return;
        }

        io.to(roomId).emit('roomUpdated', room.getGameState());
        console.log(`🎮 Комната ${roomId}: выбраны режимы ${room.selectedModeKeys.join(', ')}`);
    });

    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Комната не найдена');
            return;
        }

        const result = room.startGame();
        if (result.success) {
            io.to(roomId).emit('gameStarted', room.getGameState());
            console.log('🎮 Игра началась!');
        } else {
            socket.emit('error', result.error);
        }
    });

    socket.on('makeBid', ({ roomId, playerIdx, bid }) => {
        const room = rooms[roomId];
        if (!room) return;

        const result = room.makeBid(playerIdx, bid);
        if (result.success) {
            io.to(roomId).emit('bidMade', result.gameState);
            console.log(`📢 Игрок ${playerIdx} сделал заявку: ${bid}`);
        } else {
            socket.emit('error', result.error);
        }
    });

    socket.on('playCard', ({ roomId, playerIdx, cardIdx }) => {
        const room = rooms[roomId];
        if (!room) return;

        console.log(`🃏 Игрок ${playerIdx} пытается сыграть карту ${cardIdx}`);
        const result = room.playCard(playerIdx, cardIdx);

        if (result && result.success) {
            io.to(roomId).emit('cardPlayed', result.gameState);
            console.log(`✅ Карта сыграна успешно`);

            if (result.finished) {
                io.to(roomId).emit('gameFinished', result.gameState);
                console.log('🏆 Игра завершена, отправлено gameFinished');
            }
        } else if (result && result.error) {
            console.log(`❌ Ошибка: ${result.error}`);
            socket.emit('error', result.error);
        } else {
            console.log(`❌ Неожиданный результат:`, result);
            socket.emit('error', 'Внутренняя ошибка сервера');
        }
    });

    socket.on('getGameState', ({ roomId, playerIdx }) => {
        const room = rooms[roomId];
        if (!room) return;

        const state = room.getGameStateWithHand(playerIdx);
        socket.emit('gameState', state);
    });

    socket.on('jokerChoice', ({ roomId, playerIdx, choice, suit, cardType }) => {
        const room = rooms[roomId];
        if (!room || !room.pendingJoker) return;

        // ✅ Проверка что выбирает тот же игрок
        if (room.pendingJoker.playerIdx !== playerIdx) {
            console.error(`❌ Игрок ${playerIdx} пытается выбрать за ${room.pendingJoker.playerIdx}`);

            // ✅ ВОЗВРАЩАЕМ КАРТУ В РУКУ при ошибке
            const cardToReturn = room.pendingJoker.card;
            const originalPlayer = room.players[room.pendingJoker.playerIdx];
            originalPlayer.hand.push(cardToReturn);
            console.log(`🔄 Карта возвращена в руку игрока ${room.pendingJoker.playerIdx}`);

            return;
        }

        console.log(`🃏 Игрок ${playerIdx} выбрал: сила=${choice}, масть=${suit}, тип=${cardType}`);

        room.pendingJoker.card.jokerPower = choice;

        if (room.pendingJoker.isFirstCard) {
            room.leadSuit = suit;
            room.jokerCondition = { suit, cardType };
            room.jokerPlayerIdx = playerIdx;
        }

        // ✅ Добавляем джокера на стол
        room.cardsPlayedThisTrick.push({
            playerIdx: room.pendingJoker.playerIdx,
            card: room.pendingJoker.card
        });
        console.log(`🃏 Джокер добавлен на стол, всего карт: ${room.cardsPlayedThisTrick.length}`);

        room.jokerChoices[playerIdx] = choice;
        room.pendingJoker = null;

        // ✅ Проверка что взятка не завершена пока мы выбирали
        if (room.trickCompleted) {
            console.warn('⚠️ Взятка завершена во время выбора джокера, возвращаем карту');
            const originalPlayer = room.players[playerIdx];
            originalPlayer.hand.push(room.cardsPlayedThisTrick.pop().card);
            return;
        }

        if (room.cardsPlayedThisTrick.length >= room.players.length) {
            const result = room.completeTrick();
            if (result && result.success) {
                io.to(roomId).emit('cardPlayed', result.gameState);
            }
        } else {
            const nextPlayerIdx = room.getCurrentPlayerIdx();
            console.log(`⏳ Ход переходит к игроку ${nextPlayerIdx}`);

            room.players.forEach((player, idx) => {
                const socket = player.socketId;
                if (socket) {
                    const stateWithHand = room.getGameStateWithHand(idx);
                    io.to(socket).emit('gameState', stateWithHand);
                }
            });
        }
    });

    // ✅ ЗАПРОС СТАТИСТИКИ СЕРВЕРА
    socket.on('getServerStats', () => {
        socket.emit('serverStats', serverStats);
    });

    // ✅ ОТПРАВЛЯЕМ СТАТИСТИКУ ПРИ ПОДКЛЮЧЕНИИ
    socket.emit('serverStats', serverStats);

    socket.on('disconnect', (reason) => {
        console.log('🔌 Игрок отключился:', socket.id, 'Причина:', reason);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIdx = room.players.findIndex(p => p.socketId === socket.id);

            if (playerIdx !== -1) {
                const playerName = room.players[playerIdx].name;
                const isGameActive = room.gameState === 'playing' || room.gameState === 'bidding';
                const remainingPlayers = room.players.filter(p => p.isConnected).length - 1;

                // ✅ Помечаем игрока как отключённого (не удаляем сразу)
                room.players[playerIdx].isConnected = false;
                room.players[playerIdx].disconnectTime = Date.now();

                console.log(`📝 Игрок ${playerName} отключён. Осталось активных: ${remainingPlayers}`);

                // ✅ Если это был последний игрок — закрываем комнату сразу
                if (remainingPlayers <= 0) {
                    console.log(`🗑️ Комната ${roomId} закрыта (нет игроков)`);
                    io.to(roomId).emit('roomClosed', { reason: 'Все игроки покинули комнату' });
                    clearTimeout(roomTimers[roomId]);
                    delete roomTimers[roomId];
                    delete rooms[roomId];

                    // ✅ ОБНОВЛЯЕМ СТАТИСТИКУ
                    serverStats.activeRooms = Object.keys(rooms).length;
                    serverStats.totalPlayersConnected = Math.max(0, serverStats.totalPlayersConnected - 1);
                    serverStats.playersInGames = Object.values(rooms).reduce((sum, room) => {
                        return sum + room.players.filter(p => p.isConnected).length;
                    }, 0);

                    // ✅ ОТПРАВЛЯЕМ ОБНОВЛЁННУЮ СТАТИСТИКУ ВСЕМ
                    io.emit('serverStats', serverStats);

                    break;
                }

                // ✅ Если игра активна — запускаем таймер закрытия
                if (isGameActive) {
                    console.log(`⏱️ Запуск таймера закрытия комнаты ${roomId} (${ROOM_CLOSE_TIMEOUT/1000} сек)`);

                    // ✅ Очищаем предыдущий таймер если был
                    if (roomTimers[roomId]) {
                        clearTimeout(roomTimers[roomId]);
                    }

                    // ✅ Уведомляем остальных игроков
                    io.to(roomId).emit('playerDisconnected', {
                        playerName: playerName,
                        reason: 'Игрок отключился',
                        gameState: room.getGameState()
                    });

                    // ✅ Запускаем таймер закрытия
                    roomTimers[roomId] = setTimeout(() => {
                        console.log(`⏰ Таймаут комнаты ${roomId}. Закрытие...`);

                        // ✅ Проверяем вернулся ли игрок
                        const playerReturned = room.players[playerIdx].isConnected;

                        if (!playerReturned) {
                            // ✅ Уведомляем всех о закрытии
                            io.to(roomId).emit('gameAborted', {
                                reason: `Игрок "${playerName}" не подключился в течение 1 минуты`,
                                finalState: room.getGameState()
                            });

                            io.to(roomId).emit('roomClosed', {
                                reason: 'Комната закрыта по таймауту'
                            });

                            // ✅ Очищаем комнату
                            delete roomTimers[roomId];
                            delete rooms[roomId];

                            // ✅ ОБНОВЛЯЕМ СТАТИСТИКУ
                            serverStats.activeRooms = Object.keys(rooms).length;
                            serverStats.playersInGames = Object.values(rooms).reduce((sum, room) => {
                                return sum + room.players.filter(p => p.isConnected).length;
                            }, 0);

                            io.emit('serverStats', serverStats);

                            console.log(`🗑️ Комната ${roomId} удалена (таймаут)`);
                        } else {
                            console.log(`✅ Игрок ${playerName} вернулся до закрытия комнаты`);
                            delete roomTimers[roomId];
                        }
                    }, ROOM_CLOSE_TIMEOUT);

                    break;
                }

                // ✅ Если игра не активна (лобби) — удаляем игрока сразу
                room.players.splice(playerIdx, 1);

                // ✅ Если комната пустая — удаляем
                if (room.players.length === 0) {
                    clearTimeout(roomTimers[roomId]);
                    delete roomTimers[roomId];
                    delete rooms[roomId];

                    // ✅ ОБНОВЛЯЕМ СТАТИСТИКУ
                    serverStats.activeRooms = Object.keys(rooms).length;
                    serverStats.totalPlayersConnected = Math.max(0, serverStats.totalPlayersConnected - 1);

                    io.emit('serverStats', serverStats);

                    console.log(`🗑️ Комната ${roomId} удалена (пустая)`);
                } else {
                    io.to(roomId).emit('playerLeft', room.getGameState());
                    console.log(`👤 Игрок ${playerName} вышел из комнаты ${roomId} (лобби)`);
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎰 Сервер запущен на порту ${PORT}`);
    console.log(`🌐 Откройте http://localhost:${PORT} в браузере`);
});

